"""
conversor.py — CONVERSOR de vídeo no SERVIDOR (ffmpeg nativo).

O que faz
---------
A GoPro grava em 4K HEVC (H.265) a ~45 Mbps. Isso dá dois problemas:

  1) O Windows Media Player e o Chrome não abrem HEVC sem codec pago — o
     colaborador baixa o vídeo e não consegue nem assistir.
  2) Converter no navegador (ffmpeg.wasm) é inviável para 35 min / 13 GB.

Aqui a conversão roda no servidor, com ffmpeg nativo. Medição de campo
(GX011784-004.MP4, 4K HEVC 44,8 Mbps, 35min14s, 16 threads):

    4K HEVC -> 4K H.264   .....  0,41x do tempo real
    4K HEVC -> 720p H.264 .....  1,73x do tempo real   <-- receita padrão

O `-pix_fmt yuv420p` NÃO é decorativo: a GoPro entrega `yuvj420p` (faixa
de cor "pc", obsoleta) e é exatamente isso que faz o player do Windows
recusar arquivos íntegros.

ENDURECIMENTO PARA VPS PÚBLICA (Locaweb / Hostinger)
----------------------------------------------------
Este módulo aceita upload de arquivos grandes e executa um processo
externo. Numa VPS exposta à internet isso é uma superfície de ataque
séria. As defesas implementadas:

  1) AUTENTICAÇÃO OBRIGATÓRIA em todas as rotas (JWT do próprio app).
     Sem token, 401. Não existe rota anônima aqui.
  2) DONO DO JOB. Cada job grava o id do usuário. Usuário comum só vê,
     baixa, cancela e apaga os próprios jobs. Admin vê todos.
  3) NOME DE ARQUIVO SANEADO. Corta caminho em "/" e em "\\", remove
     caracteres de controle, aceita só [A-Za-z0-9._-] e espaço, limita
     tamanho. Impede path traversal e injeção de cabeçalho HTTP no
     Content-Disposition do download.
  4) EXTENSÃO EM LISTA BRANCA. Nada de gravar ".php", ".py", ".sh".
  5) UPLOAD EM STREAM COM TETO. O corpo da requisição é lido em pedaços
     e escrito direto no disco — a RAM não sobe com o tamanho do arquivo
     e não existe cópia temporária dupla (que o multipart do Starlette
     provocaria). Passou do teto, aborta e apaga o parcial.
  6) COTA DE DISCO. Antes e durante o upload verifica espaço livre e
     recusa se ficaria abaixo da reserva. Uma VPS com o disco cheio para
     de responder inteira, não só o conversor.
  7) COTA POR USUÁRIO. Máximo de jobs ativos por pessoa, para uma conta
     comprometida não conseguir encher a fila sozinha.
  8) FORMATO EM LISTA BRANCA + PROTOCOLO RESTRITO. O ataque clássico
     contra ffmpeg é enviar um "vídeo" que na verdade é uma playlist
     (concat/hls/sdp) apontando para /etc/passwd ou para uma URL interna
     (SSRF). Aqui: `-protocol_whitelist file` no ffprobe e no ffmpeg, e
     o formato detectado precisa estar na lista de contêineres aceitos —
     senão o arquivo é recusado antes de qualquer conversão.
  9) TIMEOUT E MORTE DO GRUPO DE PROCESSOS. ffprobe e ffmpeg rodam em
     sessão própria; ao cancelar ou estourar o tempo, o grupo inteiro
     leva SIGTERM e depois SIGKILL. Não sobra processo órfão comendo CPU.
 10) TETO DE CPU. `-threads` limitado por variável de ambiente, para a
     conversão não derrubar o resto da aplicação numa VPS de 2 vCPU.
 11) FAXINA AUTOMÁTICA. Thread de fundo apaga jobs vencidos e pastas
     órfãs de tempos em tempos, não só na subida do processo.
 12) MENSAGEM DE ERRO SEM CAMINHO INTERNO. A saída do ffmpeg é filtrada
     antes de ir para o navegador.

Variáveis de ambiente
---------------------
  CONVERSOR_DIR                pasta de trabalho     (padrão: <raiz>/data_conversor)
  CONVERSOR_WORKERS            conversões simultâneas          (padrão: 1)
  CONVERSOR_THREADS            threads do ffmpeg por job       (padrão: 2)
  CONVERSOR_TTL_HORAS          validade dos arquivos           (padrão: 12)
  CONVERSOR_MAX_GB             tamanho máximo por vídeo        (padrão: 20)
  CONVERSOR_MAX_JOBS_USUARIO   jobs ativos por usuário         (padrão: 4)
  CONVERSOR_DISCO_RESERVA_GB   espaço livre intocável          (padrão: 5)
  CONVERSOR_TIMEOUT_HORAS      tempo máximo de um ffmpeg       (padrão: 4)

Rotas (todas exigem Bearer token)
---------------------------------
  GET    /api/conversor/status
  POST   /api/conversor/enviar          (corpo = bytes do vídeo, 1 por vez)
  GET    /api/conversor/fila
  GET    /api/conversor/job/{id}
  GET    /api/conversor/job/{id}/baixar
  POST   /api/conversor/job/{id}/cancelar
  DELETE /api/conversor/job/{id}

IMPORTANTE — 1 PROCESSO SÓ
--------------------------
A fila vive na memória do processo. Suba com UM worker de uvicorn
(`uvicorn app.main:app --workers 1`). Com vários workers cada processo
teria a própria fila e o job criado em um não apareceria no outro.
Para escalar, aumente CONVERSOR_WORKERS (threads internas), não o número
de processos.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import unicodedata
import uuid
from queue import Queue

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models
from ..auth import get_usuario_atual

router = APIRouter(prefix="/conversor", tags=["Conversor"])


# ══════════════════════════════════════════════════════════════════════
#  Configuração
# ══════════════════════════════════════════════════════════════════════
def _env_int(nome, padrao, minimo=0):
    try:
        v = int(os.getenv(nome, str(padrao)))
    except (TypeError, ValueError):
        return padrao
    return max(minimo, v)


_RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE_DIR       = os.path.abspath(os.getenv("CONVERSOR_DIR", os.path.join(_RAIZ, "data_conversor")))
WORKERS        = _env_int("CONVERSOR_WORKERS", 1, 1)
FFMPEG_THREADS = _env_int("CONVERSOR_THREADS", 2, 0)
TTL_HORAS      = _env_int("CONVERSOR_TTL_HORAS", 12, 1)
MAX_GB         = _env_int("CONVERSOR_MAX_GB", 20, 1)
MAX_JOBS_USER  = _env_int("CONVERSOR_MAX_JOBS_USUARIO", 4, 1)
RESERVA_GB     = _env_int("CONVERSOR_DISCO_RESERVA_GB", 5, 0)
TIMEOUT_SEG    = _env_int("CONVERSOR_TIMEOUT_HORAS", 4, 1) * 3600

MAX_BYTES     = MAX_GB * 1024**3
RESERVA_BYTES = RESERVA_GB * 1024**3
CHUNK         = 4 * 1024 * 1024      # 4 MB por leitura do socket
FAXINA_SEG    = 15 * 60              # roda a faxina a cada 15 min
MAX_JOBS_MEM  = 500                  # teto de jobs guardados na memória
RESERVA_TTL   = 30 * 60              # reserva sem upload morre em 30 min

# Estados que ocupam vaga na cota do usuário e recursos do servidor.
ESTADOS_ATIVOS = ("reservado", "recebendo", "fila", "analisando", "convertendo")
ESTADOS_FINAIS = ("concluido", "erro", "cancelado")

# Extensões que aceitamos gravar no disco.
EXT_OK = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".mts", ".m2ts", ".ts", ".webm", ".lrv"}

# Contêineres que o ffprobe pode reportar. Qualquer coisa fora daqui
# (concat, hls, image2, sdp, rtsp, mjpeg...) é recusada: é por esses
# demuxers que se faz o ffmpeg ler arquivo local ou abrir conexão.
# Mapeia o `format_name` do ffprobe -> demuxer que forçamos com `-f`.
FORMATOS_OK = {
    "mov,mp4,m4a,3gp,3g2,mj2": "mov",
    "matroska,webm":           "matroska",
    "avi":                     "avi",
    "mpegts":                  "mpegts",
    "mpeg":                    "mpeg",
    "flv":                     "flv",
}

# Perfis. O de 720p é o medido/validado; os outros seguem a mesma
# receita, mudando altura e teto de bitrate.
PERFIS = {
    "480p":  {"altura":  480, "maxrate": "3M",  "bufsize": "6M",  "rotulo": "480p — leve"},
    "720p":  {"altura":  720, "maxrate": "6M",  "bufsize": "12M", "rotulo": "720p — padrão"},
    "1080p": {"altura": 1080, "maxrate": "12M", "bufsize": "24M", "rotulo": "1080p — detalhe"},
    "4k":    {"altura":    0, "maxrate": "30M", "bufsize": "60M", "rotulo": "4K — só troca o codec"},
}

_JOBS = {}
_LOCK = threading.Lock()
_FILA = Queue()
_workers_iniciados = False

_RE_ID = re.compile(r"^[0-9a-f]{32}$")


# ══════════════════════════════════════════════════════════════════════
#  Utilidades de segurança
# ══════════════════════════════════════════════════════════════════════
def _nome_seguro(bruto: str, padrao: str = "video.mp4") -> str:
    """
    Devolve um nome de arquivo seguro para gravar em disco e para colocar
    num cabeçalho HTTP.

    - corta caminho tanto em "/" quanto em "\\" (upload vindo do Windows)
    - remove acentos e qualquer caractere fora de [A-Za-z0-9._- ]
    - mata "..", nomes vazios e nomes que começam com ponto
    - limita a 120 caracteres
    """
    bruto = (bruto or "").strip()
    bruto = bruto.replace("\\", "/").split("/")[-1]
    bruto = unicodedata.normalize("NFKD", bruto).encode("ascii", "ignore").decode()
    bruto = re.sub(r"[^A-Za-z0-9._\- ]+", "_", bruto)
    bruto = re.sub(r"\.{2,}", ".", bruto).strip(" .")
    bruto = re.sub(r"\s{2,}", " ", bruto)
    if not bruto:
        bruto = padrao
    return bruto[:120]


def _extensao_ok(nome: str) -> str:
    ext = os.path.splitext(nome)[1].lower()
    if ext not in EXT_OK:
        raise HTTPException(
            415,
            "Extensão não aceita. Envie um dos formatos: "
            + ", ".join(sorted(EXT_OK)),
        )
    return ext


def _valida_id(job_id: str) -> str:
    """Só deixa passar um hex de 32. Impede que o id vire caminho."""
    if not _RE_ID.match(job_id or ""):
        raise HTTPException(404, "Job não encontrado.")
    return job_id


def _limpar_texto(texto: str) -> str:
    """Tira caminhos internos do log do ffmpeg antes de mandar ao navegador."""
    if not texto:
        return texto
    texto = texto.replace(BASE_DIR, "<pasta do servidor>")
    texto = texto.replace(_RAIZ, "<app>")
    return re.sub(r"(/[\w.\-]+){3,}", "<caminho>", texto)


def _livre_bytes() -> int:
    try:
        return shutil.disk_usage(BASE_DIR).free
    except OSError:
        return 0


# ══════════════════════════════════════════════════════════════════════
#  Estado dos jobs
# ══════════════════════════════════════════════════════════════════════
def _job_dir(job_id):
    return os.path.join(BASE_DIR, job_id)


def _publico(job, admin=False):
    """Cópia do job sem os campos internos (processo, caminhos absolutos)."""
    d = {k: v for k, v in job.items() if not k.startswith("_")}
    if not admin:
        d.pop("usuario_id", None)
        d.pop("dono", None)
    return d


def _set(job_id, **campos):
    persistir = campos.pop("_persistir", True)
    so_se_ativo = campos.pop("_so_se_ativo", False)
    gravar = False
    with _LOCK:
        j = _JOBS.get(job_id)
        if j and not (so_se_ativo and j["estado"] in ESTADOS_FINAIS):
            j.update(campos)
            # Só grava em disco nas trocas de estado. Gravar a cada tick de
            # progresso seria uma escrita por segundo, por job, à toa.
            gravar = persistir and "estado" in campos
    if gravar:
        _gravar_meta(job_id)


def _gravar_meta(job_id):
    """
    Salva o estado do job em disco. Serve para, depois de um restart do
    uvicorn, a faxina saber a idade e o dono de cada pasta — e para não
    ficar arquivo órfão sem rastro.
    """
    with _LOCK:
        j = _JOBS.get(job_id)
        if not j:
            return
        dados = {k: v for k, v in j.items() if not k.startswith("_")}
    try:
        caminho = os.path.join(_job_dir(job_id), "meta.json")
        tmp = caminho + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False)
        os.replace(tmp, caminho)
    except OSError:
        pass


def _buscar(job_id, usuario):
    """Pega o job e confere o dono. Admin passa por cima."""
    _valida_id(job_id)
    with _LOCK:
        j = _JOBS.get(job_id)
    # 404 (e não 403) de propósito quando o job é de outro: quem não é
    # dono não deve nem descobrir que o id existe.
    if not j or (not usuario.is_admin and j.get("usuario_id") != usuario.id):
        raise HTTPException(404, "Job não encontrado.")
    return j


# ══════════════════════════════════════════════════════════════════════
#  ffmpeg / ffprobe
# ══════════════════════════════════════════════════════════════════════
# ── Compatibilidade Windows ────────────────────────────────────────────
#  O conversor roda tanto no Linux da VPS quanto localmente no Windows.
#  As duas plataformas divergem justamente em criar e matar processo:
#
#   - `start_new_session` só existe no POSIX; no Windows o equivalente
#     é a flag CREATE_NEW_PROCESS_GROUP.
#   - `os.killpg` / `os.getpgid` NÃO EXISTEM no Windows. Chamar direto
#     levanta AttributeError e o cancelamento quebra.
#   - Sem CREATE_NO_WINDOW o Windows abre um console preto a cada
#     ffmpeg disparado.
_WIN = os.name == "nt"
_CREATE_NO_WINDOW = 0x08000000
_CREATE_NEW_PROCESS_GROUP = 0x00000200


def _flags_processo():
    """kwargs de Popen/run para isolar o processo em cada plataforma."""
    if _WIN:
        return {"creationflags": _CREATE_NO_WINDOW | _CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


# Pasta do ffmpeg embutido no projeto (mesma ideia do exiftool.exe que
# já vive na raiz). Sem isso, rodar local no Windows exigiria instalar o
# ffmpeg na máquina de cada colaborador.
FFMPEG_DIR = os.path.join(_RAIZ, "bin", "ffmpeg")

# Não faz sentido perguntar ao sistema operacional a mesma coisa a cada
# request; o caminho não muda enquanto o processo vive.
_CACHE_BIN = {}


def _achar_bin(nome):
    """
    Procura o binário em, nesta ordem:
      1) variável de ambiente (FFMPEG_PATH / FFPROBE_PATH);
      2) bin/ffmpeg/ dentro do projeto  <- o que vem embutido no zip;
      3) raiz do projeto;
      4) PATH do sistema.

    O embutido vem ANTES do PATH de propósito: assim a versão que a
    equipe usa é a que foi testada, e não a que por acaso está instalada
    na máquina de cada um.
    """
    if nome in _CACHE_BIN:
        return _CACHE_BIN[nome]

    achado = None
    env = os.getenv(nome.upper() + "_PATH")
    if env and os.path.isfile(env):
        achado = env

    if not achado:
        # ATENÇÃO: o ".exe" só entra na busca no Windows. No Linux da VPS
        # o arquivo bin/ffmpeg/ffmpeg.exe existe (vem no zip) e o
        # os.path.isfile() diria True — o servidor tentaria executar um
        # binário PE do Windows e falharia de um jeito difícil de
        # diagnosticar.
        nomes = (nome + ".exe", nome) if _WIN else (nome,)
        for pasta in (FFMPEG_DIR, _RAIZ):
            for arq in nomes:
                cand = os.path.join(pasta, arq)
                if os.path.isfile(cand) and os.access(cand, os.X_OK if not _WIN else os.F_OK):
                    achado = cand
                    break
            if achado:
                break

    if not achado:
        achado = shutil.which(nome)

    _CACHE_BIN[nome] = achado
    return achado


def _ffmpeg_bin():
    return _achar_bin("ffmpeg")


def _ffprobe_bin():
    return _achar_bin("ffprobe")




def _matar(proc):
    """
    Mata o processo e os filhos dele. ffmpeg costuma deixar filho
    pendurado, e um ffmpeg órfão fica comendo CPU até o fim dos tempos.

    Windows e Linux fazem isso de formas completamente diferentes — daí
    os dois caminhos.
    """
    if not proc or proc.poll() is not None:
        return

    if _WIN:
        # taskkill /T derruba a árvore inteira de processos.
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True, timeout=15,
                creationflags=_CREATE_NO_WINDOW,
            )
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            proc.wait(timeout=8)
        except Exception:
            pass
        return

    # POSIX: SIGTERM no grupo, depois SIGKILL em quem insistir.
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (OSError, ProcessLookupError, AttributeError):
        try:
            proc.terminate()
        except OSError:
            pass
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (OSError, ProcessLookupError, AttributeError):
            try:
                proc.kill()
            except OSError:
                pass


def _sondar(caminho):
    """
    ffprobe -> dados do vídeo. `-protocol_whitelist file` impede que um
    arquivo malicioso faça o ffprobe abrir http/rtsp (SSRF) ou concatenar
    arquivos locais. Devolve {} se não conseguir ler.
    """
    fp = _ffprobe_bin()
    if not fp:
        return {}
    try:
        out = subprocess.run(
            [fp, "-v", "error",
             "-protocol_whitelist", "file",
             "-print_format", "json",
             "-show_format", "-show_streams", caminho],
            capture_output=True, text=True, timeout=120,
            **_flags_processo(),
        )
        dados = json.loads(out.stdout or "{}")
    except Exception:
        return {}

    fmt = dados.get("format", {}) or {}
    video = next((s for s in dados.get("streams", [])
                  if s.get("codec_type") == "video"), {})
    # A telemetria da GoPro é um stream de dados com handler "GoPro MET"
    tem_gpmd = any(
        s.get("codec_tag_string") == "gpmd" or
        (s.get("tags", {}) or {}).get("handler_name", "").strip() == "GoPro MET"
        for s in dados.get("streams", [])
    )
    try:
        duracao = float(fmt.get("duration") or 0)
    except (TypeError, ValueError):
        duracao = 0.0
    return {
        "formato": (fmt.get("format_name") or "").strip(),
        "codec": video.get("codec_name") or "?",
        "largura": video.get("width") or 0,
        "altura": video.get("height") or 0,
        "duracao": duracao,
        "bitrate": int(fmt.get("bit_rate") or 0),
        "tamanho": int(fmt.get("size") or 0),
        "pix_fmt": video.get("pix_fmt") or "",
        "tem_gpmd": tem_gpmd,
    }


def _comando(entrada, saida, perfil, telemetria, demuxer):
    """Monta a linha do ffmpeg. Receita validada em material real."""
    p = PERFIS[perfil]
    cmd = [_ffmpeg_bin(), "-nostdin", "-y"]

    # ── Trava de entrada ─────────────────────────────────────────────
    #  `-protocol_whitelist file`: o ffmpeg só pode abrir arquivo local.
    #  `-f <demuxer>`: o contêiner já foi identificado e aprovado pelo
    #  ffprobe; forçar aqui evita que o ffmpeg redetecte e caia num
    #  demuxer diferente (concat, hls) por causa de bytes plantados.
    cmd += ["-protocol_whitelist", "file", "-f", demuxer, "-i", entrada]

    # Cadeia de filtros. O `out_range=tv` + `format=yuv420p` converte a
    # faixa de cor da GoPro (yuvj420p, 0-255) para a faixa de TV (16-235).
    # Sem isso o vídeo sai com preto esmagado e branco estourado.
    escala = f"scale=-2:{p['altura']}" if p["altura"] else "scale"
    cmd += ["-vf", f"{escala}:out_range=tv,format=yuv420p"]

    cmd += [
        "-pix_fmt", "yuv420p",      # <- sem isto o player do Windows recusa
        # Marcação de cor completa: só com os quatro campos o arquivo sai
        # com color_range=tv de verdade. Com o campo vazio, cada player
        # adivinha — e alguns adivinham errado.
        "-color_range", "tv",
        "-colorspace", "bt709",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-maxrate", p["maxrate"],
        "-bufsize", p["bufsize"],
        "-c:a", "aac", "-ar", "48000",
        "-movflags", "+faststart",
        "-map", "0:v:0",
        "-map", "0:a:0?",
    ]

    # Teto de CPU: numa VPS de 2 vCPU deixar o ffmpeg pegar tudo faz a
    # aplicação inteira parar de responder enquanto converte.
    if FFMPEG_THREADS:
        cmd += ["-threads", str(FFMPEG_THREADS)]

    if telemetria:
        # Tenta levar junto a faixa gpmd (GPS da GoPro). Nem todo MP4
        # aceita; se falhar, o worker repete sem esta parte.
        cmd += ["-map", "0:d?", "-c:d", "copy", "-copy_unknown"]
    else:
        cmd += ["-dn"]

    cmd += ["-progress", "pipe:1", "-nostats", saida]
    return cmd


def _rodar(job_id, entrada, saida, perfil, telemetria, duracao, demuxer):
    """Executa o ffmpeg lendo o progresso. Devolve (ok, ultimas_linhas)."""
    cmd = _comando(entrada, saida, perfil, telemetria, demuxer)
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1,
        **_flags_processo(),
    )
    _set(job_id, _proc=proc, _persistir=False)

    # stderr num buffer circular: reporta erro sem guardar MBs de log
    erro_linhas = []

    def _drenar_erro():
        for linha in proc.stderr:
            erro_linhas.append(linha.rstrip())
            if len(erro_linhas) > 40:
                erro_linhas.pop(0)

    t = threading.Thread(target=_drenar_erro, daemon=True)
    t.start()

    # Cão de guarda: se o ffmpeg travar (arquivo corrompido costuma
    # fazer isso), ninguém fica com a CPU presa para sempre.
    estourou = {"sim": False}

    def _guarda():
        if proc.poll() is None:
            estourou["sim"] = True
            _matar(proc)

    cao = threading.Timer(TIMEOUT_SEG, _guarda)
    cao.daemon = True
    cao.start()

    inicio = time.time()
    try:
        for linha in proc.stdout:
            linha = linha.strip()
            if linha.startswith("out_time_ms="):
                try:
                    us = int(linha.split("=", 1)[1])
                except ValueError:
                    continue
                seg = us / 1_000_000
                pct = min(99, (seg / duracao * 100)) if duracao else 0
                decorrido = time.time() - inicio
                vel = (seg / decorrido) if decorrido > 0.5 else 0
                restante = ((duracao - seg) / vel) if vel > 0.05 else None
                _set(job_id,
                     progresso=round(pct, 1),
                     velocidade=round(vel, 2),
                     restante_seg=int(restante) if restante else None,
                     _persistir=False, _so_se_ativo=True)
            elif linha == "progress=end":
                _set(job_id, progresso=99.0, etapa="finalizando (faststart)",
                     _persistir=False, _so_se_ativo=True)
    finally:
        cao.cancel()

    proc.wait()
    t.join(timeout=2)
    _set(job_id, _proc=None, _persistir=False)

    if estourou["sim"]:
        erro_linhas.append(
            f"Tempo máximo de conversão ({TIMEOUT_SEG // 3600}h) estourado."
        )
        return False, erro_linhas
    return proc.returncode == 0, erro_linhas


# ══════════════════════════════════════════════════════════════════════
#  Fila
# ══════════════════════════════════════════════════════════════════════
def _worker():
    while True:
        job_id = _FILA.get()
        try:
            _processar(job_id)
        except Exception as e:  # nunca deixa o worker morrer
            _set(job_id, estado="erro", erro=f"Falha inesperada: {type(e).__name__}")
        finally:
            _FILA.task_done()


def _processar(job_id):
    with _LOCK:
        job = _JOBS.get(job_id)
    if not job or job.get("estado") == "cancelado":
        return

    entrada = job["_entrada"]
    saida = job["_saida"]

    _set(job_id, estado="analisando", etapa="lendo o arquivo", iniciado_em=time.time())
    info = _sondar(entrada)

    if not info.get("duracao"):
        _set(job_id, estado="erro",
             erro="Não consegui ler o vídeo (ffprobe). Arquivo corrompido ou "
                  "formato não suportado.")
        _apagar_entrada(entrada)
        return

    # ── Trava de formato ─────────────────────────────────────────────
    #  Aqui é onde o "MP4" que na verdade é uma playlist apontando para
    #  /etc/passwd (ou para um endereço interno da VPS) é barrado.
    demuxer = FORMATOS_OK.get(info.get("formato", ""))
    if not demuxer:
        _set(job_id, estado="erro",
             erro="Contêiner não aceito (%s). Envie MP4, MOV, MKV, AVI ou TS."
                  % (info.get("formato") or "desconhecido"))
        _apagar_entrada(entrada)
        return

    _set(job_id, origem={k: v for k, v in info.items() if k != "formato"})

    telemetria = bool(job.get("telemetria")) and info.get("tem_gpmd")
    _set(job_id, estado="convertendo", etapa="convertendo", progresso=0.0)

    ok, erro_linhas = _rodar(job_id, entrada, saida, job["perfil"],
                             telemetria, info["duracao"], demuxer)

    with _LOCK:
        cancelado = _JOBS.get(job_id, {}).get("estado") == "cancelado"
    if cancelado:
        return

    # Se a cópia da telemetria derrubou a conversão, repete sem ela.
    if not ok and telemetria:
        _set(job_id, etapa="repetindo sem a telemetria", progresso=0.0)
        ok, erro_linhas = _rodar(job_id, entrada, saida, job["perfil"],
                                 False, info["duracao"], demuxer)
        if ok:
            _set(job_id, aviso="A faixa de telemetria (gpmd) não pôde ser "
                               "copiada; o vídeo foi convertido sem ela.")

    if not ok or not os.path.isfile(saida) or os.path.getsize(saida) == 0:
        _set(job_id, estado="erro",
             erro=_limpar_texto("O ffmpeg falhou. Últimas linhas:\n"
                                + "\n".join(erro_linhas[-12:])))
        _apagar_entrada(entrada)
        return

    destino = _sondar(saida)
    destino.pop("formato", None)
    _set(job_id,
         estado="concluido",
         etapa="pronto",
         progresso=100.0,
         restante_seg=0,
         destino=destino,
         tamanho_saida=os.path.getsize(saida),
         terminado_em=time.time())

    # Libera o original assim que a saída existe — economiza disco.
    _apagar_entrada(entrada)


def _apagar_entrada(caminho):
    try:
        os.remove(caminho)
    except OSError:
        pass


# ══════════════════════════════════════════════════════════════════════
#  Faxina
# ══════════════════════════════════════════════════════════════════════
def _limpar_antigos():
    """
    Apaga pastas de jobs vencidas. Roda na subida e de tempos em tempos.
    Pega também pasta órfã (job que sumiu da memória depois de restart) —
    sem isso o disco da VPS enche de arquivo que ninguém mais consegue
    baixar nem apagar pela interface.
    """
    agora = time.time()
    limite = agora - TTL_HORAS * 3600

    # Reserva que nunca recebeu o arquivo (aba fechada no meio, conexão
    # caiu antes do PUT) segura vaga na cota do usuário para sempre.
    # Aqui elas morrem.
    velhas = []
    with _LOCK:
        for j in list(_JOBS.values()):
            if (j["estado"] in ("reservado", "recebendo")
                    and agora - j.get("criado_em", agora) > RESERVA_TTL):
                velhas.append(_JOBS.pop(j["id"])["id"])
    for jid in velhas:
        shutil.rmtree(_job_dir(jid), ignore_errors=True)

    if not os.path.isdir(BASE_DIR):
        return
    for nome in os.listdir(BASE_DIR):
        if not _RE_ID.match(nome):
            continue
        caminho = os.path.join(BASE_DIR, nome)
        try:
            if not os.path.isdir(caminho):
                continue
            if os.path.getmtime(caminho) >= limite:
                continue
        except OSError:
            continue
        with _LOCK:
            j = _JOBS.pop(nome, None)
        if j:
            _matar(j.get("_proc"))
        shutil.rmtree(caminho, ignore_errors=True)

    # Teto de memória: joga fora os registros mais velhos já finalizados.
    with _LOCK:
        if len(_JOBS) > MAX_JOBS_MEM:
            finalizados = sorted(
                (j for j in _JOBS.values() if j["estado"] in ESTADOS_FINAIS),
                key=lambda j: j.get("criado_em", 0),
            )
            for j in finalizados[: len(_JOBS) - MAX_JOBS_MEM]:
                _JOBS.pop(j["id"], None)


def _faxineiro():
    while True:
        time.sleep(FAXINA_SEG)
        try:
            _limpar_antigos()
        except Exception:
            pass


def _iniciar_workers():
    global _workers_iniciados
    if _workers_iniciados:
        return
    _workers_iniciados = True
    os.makedirs(BASE_DIR, exist_ok=True)
    # A pasta guarda vídeo de trabalho; ninguém além do dono do processo
    # precisa ler. Em VPS compartilhada isso importa.
    try:
        os.chmod(BASE_DIR, 0o700)
    except OSError:
        pass
    _limpar_antigos()
    for _ in range(WORKERS):
        threading.Thread(target=_worker, daemon=True).start()
    threading.Thread(target=_faxineiro, daemon=True).start()


_iniciar_workers()


# ══════════════════════════════════════════════════════════════════════
#  Rotas
# ══════════════════════════════════════════════════════════════════════
@router.get("/status")
def status(usuario: models.Usuario = Depends(get_usuario_atual)):
    with _LOCK:
        meus = [j for j in _JOBS.values()
                if usuario.is_admin or j.get("usuario_id") == usuario.id]
        na_fila = sum(1 for j in _JOBS.values() if j["estado"] == "fila")
        rodando = sum(1 for j in _JOBS.values()
                      if j["estado"] in ("analisando", "convertendo"))
        meus_ativos = sum(1 for j in meus if j["estado"] in ESTADOS_ATIVOS)
    tem_ffmpeg = bool(_ffmpeg_bin() and _ffprobe_bin())
    motivo = None
    if not tem_ffmpeg:
        faltando = [n for n in ("ffmpeg", "ffprobe") if not _achar_bin(n)]
        motivo = (f"{' e '.join(faltando)} não encontrado(s). "
                  f"Coloque os executáveis em {FFMPEG_DIR} "
                  f"(ou instale no PATH do sistema).")
    return {
        "ok": tem_ffmpeg,
        "motivo": motivo,
        "ffmpeg_em": _ffmpeg_bin(),
        "workers": WORKERS,
        "na_fila": na_fila,
        "rodando": rodando,
        "meus_ativos": meus_ativos,
        "max_jobs_usuario": MAX_JOBS_USER,
        "perfis": [{"id": k, "rotulo": v["rotulo"]} for k, v in PERFIS.items()],
        "ttl_horas": TTL_HORAS,
        "max_gb": MAX_GB,
        "extensoes": sorted(EXT_OK),
        "disco_livre_gb": round(_livre_bytes() / 1024**3, 1),
    }


@router.post("/reservar")
def reservar(
    nome: str = Query(..., min_length=1, max_length=255,
                      description="Nome original do arquivo"),
    tamanho: int = Query(..., ge=1, description="Tamanho em bytes"),
    perfil: str = Query("720p"),
    telemetria: bool = Query(False),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    """
    PASSO 1 do envio: valida ANTES de qualquer byte subir.

    Por que existe uma etapa separada: se a recusa (cota estourada, disco
    cheio, arquivo grande demais) acontecesse no meio do POST do vídeo, o
    servidor responderia e fecharia a conexão com o cliente ainda enviando
    — e o navegador mostra "conexão interrompida" em vez do motivo real.
    Pior: com 13 GB, a pessoa descobriria o problema no fim do upload.
    Aqui a checagem sai numa requisição vazia, com a mensagem certa, em
    milissegundos.
    """
    if not _ffmpeg_bin() or not _ffprobe_bin():
        raise HTTPException(503, "ffmpeg não está instalado no servidor.")
    if perfil not in PERFIS:
        raise HTTPException(400, f"Perfil inválido. Use: {', '.join(PERFIS)}")
    if tamanho > MAX_BYTES:
        raise HTTPException(413, f"Arquivo acima do limite de {MAX_GB} GB.")

    base = _nome_seguro(nome)
    ext = _extensao_ok(base)

    # ── Cota por usuário ─────────────────────────────────────────────
    #  "reservado" conta junto: senão daria para segurar N reservas e
    #  furar o limite sem nunca enviar arquivo nenhum.
    with _LOCK:
        ativos = sum(1 for j in _JOBS.values()
                     if j.get("usuario_id") == usuario.id
                     and j["estado"] in ESTADOS_ATIVOS)
    if ativos >= MAX_JOBS_USER:
        raise HTTPException(
            429,
            f"Você já tem {ativos} conversões em andamento (limite "
            f"{MAX_JOBS_USER}). Espere terminar ou remova alguma.",
        )

    # ── Cota de disco ────────────────────────────────────────────────
    #  x2 porque o original e o convertido convivem no disco até o fim
    #  da conversão.
    if _livre_bytes() - tamanho * 2 < RESERVA_BYTES:
        raise HTTPException(507, "Sem espaço em disco no servidor no momento.")

    job_id = uuid.uuid4().hex
    pasta = _job_dir(job_id)
    os.makedirs(pasta, exist_ok=True)
    try:
        os.chmod(pasta, 0o700)
    except OSError:
        pass

    nome_saida = _nome_seguro(os.path.splitext(base)[0] + f"_{perfil}.mp4")
    job = {
        "id": job_id,
        "usuario_id": usuario.id,
        "dono": usuario.nome,
        "nome": base,
        "nome_saida": nome_saida,
        "perfil": perfil,
        "telemetria": bool(telemetria),
        "estado": "reservado",
        "etapa": "aguardando o envio",
        "progresso": 0.0,
        "velocidade": 0.0,
        "restante_seg": None,
        "tamanho_entrada": 0,
        "tamanho_saida": None,
        "origem": None,
        "destino": None,
        "erro": None,
        "aviso": None,
        "criado_em": time.time(),
        "iniciado_em": None,
        "terminado_em": None,
        "_entrada": os.path.join(pasta, "entrada" + ext),
        "_saida": os.path.join(pasta, nome_saida),
        "_proc": None,
    }
    with _LOCK:
        _JOBS[job_id] = job
    _gravar_meta(job_id)
    return {"job": _publico(job, usuario.is_admin)}


@router.put("/enviar/{job_id}")
async def enviar(
    job_id: str,
    request: Request,
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    """
    PASSO 2: recebe os bytes do vídeo no corpo cru (application/octet-stream).

    Por que não multipart: o parser multipart do Starlette guarda o arquivo
    inteiro num temporário antes de entregar, e aí a gente copiaria de novo
    para a pasta do job — 13 GB viram 26 GB de escrita e o dobro de disco
    ocupado no pico. Lendo o stream direto, a RAM fica constante e o arquivo
    é gravado uma única vez, já no lugar definitivo.
    """
    j = _buscar(job_id, usuario)
    if j["estado"] != "reservado":
        raise HTTPException(409, "Esta reserva já foi usada.")

    entrada = j["_entrada"]
    pasta = _job_dir(job_id)
    _set(job_id, estado="recebendo", etapa="recebendo o arquivo")

    tamanho = 0
    proximo_check = 256 * 1024 * 1024   # confere o disco a cada 256 MB
    try:
        with open(entrada, "wb") as f:
            async for pedaco in request.stream():
                if not pedaco:
                    continue
                tamanho += len(pedaco)
                if tamanho > MAX_BYTES:
                    raise HTTPException(413, f"Arquivo acima do limite de {MAX_GB} GB.")
                f.write(pedaco)
                # Se o cliente mentiu no tamanho declarado na reserva, o
                # upload morre aqui, antes de encher o disco da VPS.
                if tamanho >= proximo_check:
                    proximo_check += 256 * 1024 * 1024
                    if _livre_bytes() < RESERVA_BYTES:
                        raise HTTPException(507, "Sem espaço em disco no servidor.")
    except HTTPException:
        with _LOCK:
            _JOBS.pop(job_id, None)
        shutil.rmtree(pasta, ignore_errors=True)
        raise
    except Exception:
        with _LOCK:
            _JOBS.pop(job_id, None)
        shutil.rmtree(pasta, ignore_errors=True)
        raise HTTPException(400, "Envio interrompido.")

    if tamanho == 0:
        with _LOCK:
            _JOBS.pop(job_id, None)
        shutil.rmtree(pasta, ignore_errors=True)
        raise HTTPException(400, "Arquivo vazio.")

    _set(job_id, estado="fila", etapa="aguardando na fila", tamanho_entrada=tamanho)
    _FILA.put(job_id)
    with _LOCK:
        return {"job": _publico(_JOBS[job_id], usuario.is_admin)}


@router.get("/fila")
def fila(usuario: models.Usuario = Depends(get_usuario_atual)):
    with _LOCK:
        itens = [_publico(j, usuario.is_admin) for j in _JOBS.values()
                 if usuario.is_admin or j.get("usuario_id") == usuario.id]
    itens.sort(key=lambda j: j["criado_em"], reverse=True)
    return {"jobs": itens}


@router.get("/job/{job_id}")
def job(job_id: str, usuario: models.Usuario = Depends(get_usuario_atual)):
    return _publico(_buscar(job_id, usuario), usuario.is_admin)


@router.get("/job/{job_id}/baixar")
def baixar(job_id: str, usuario: models.Usuario = Depends(get_usuario_atual)):
    j = _buscar(job_id, usuario)
    if j["estado"] != "concluido":
        raise HTTPException(409, "A conversão ainda não terminou.")

    # Confere que o caminho continua dentro da pasta do job. Cinto e
    # suspensório: o nome já foi saneado na entrada, mas arquivo servido
    # ao usuário merece a checagem redundante.
    caminho = os.path.abspath(j["_saida"])
    if not caminho.startswith(os.path.abspath(_job_dir(j["id"])) + os.sep):
        raise HTTPException(404, "Job não encontrado.")
    if not os.path.isfile(caminho):
        raise HTTPException(410, "O arquivo já foi removido do servidor.")

    return FileResponse(
        caminho,
        media_type="video/mp4",
        filename=j["nome_saida"],          # já saneado -> sem CRLF no header
        headers={
            "X-Content-Type-Options": "nosniff",
            # Impede o GZipMiddleware de tentar comprimir 1,6 GB de MP4
            # (que já é comprimido) e queimar CPU da VPS à toa.
            "Content-Encoding": "identity",
            "Cache-Control": "private, no-store",
        },
    )


@router.post("/job/{job_id}/cancelar")
def cancelar(job_id: str, usuario: models.Usuario = Depends(get_usuario_atual)):
    j = _buscar(job_id, usuario)
    with _LOCK:
        if j["estado"] in ESTADOS_FINAIS:
            return _publico(j, usuario.is_admin)
        j["estado"] = "cancelado"
        j["etapa"] = "cancelado pelo usuário"
        proc = j.get("_proc")
    _matar(proc)
    _apagar_entrada(j["_entrada"])
    _gravar_meta(job_id)
    with _LOCK:
        return _publico(_JOBS[job_id], usuario.is_admin)


@router.delete("/job/{job_id}")
def remover(job_id: str, usuario: models.Usuario = Depends(get_usuario_atual)):
    j = _buscar(job_id, usuario)
    with _LOCK:
        _JOBS.pop(job_id, None)
    _matar(j.get("_proc"))
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)
    return {"removido": job_id}
