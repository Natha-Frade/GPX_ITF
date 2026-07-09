"""
gopro.py — Conversão em lote GoPro → GPX usando exiftool LOCAL.

Filosofia (Opção B): o servidor roda na MESMA máquina onde estão os vídeos.
Em vez de fazer upload (lento), o front envia o CAMINHO da pasta local, e o
exiftool lê os arquivos direto do disco — rápido, igual à GUI desktop.

Rotas:
  GET  /api/gopro/status              -> diz se o exiftool está disponível
  POST /api/gopro/listar             -> lista os vídeos de uma pasta (com/sem subpastas)
  POST /api/gopro/converter          -> converte e devolve um .zip com os .gpx

Observação de deploy: no Railway (nuvem) NÃO há acesso ao disco do usuário,
então estas rotas são destinadas ao uso LOCAL. Se EXIFTOOL não existir ou a
pasta não for acessível, as rotas retornam erro explicativo.
"""

import io
import os
import re
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
import xml.sax.saxutils as sax

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import models
from ..auth import get_usuario_atual

router = APIRouter(prefix="/gopro", tags=["GoPro"])

EXTENSOES = (".mp4", ".mov")
CREATOR = "GPX IMTRAFF — exiftool"

# Fonte oficial do exiftool (repositório do autor no GitHub).
# Usada na auto-instalação quando o exiftool não é encontrado.
# Fontes do exiftool para auto-instalação (Windows). O repo oficial
# exiftool/exiftool NÃO publica releases no GitHub, então usamos mirrors
# confiáveis que distribuem o zip win64 com hash verificável.
EXIFTOOL_GH_APIS = [
    "https://api.github.com/repos/ShareX/ExifTool/releases/latest",
    "https://api.github.com/repos/sylikc/exiftool-windows/releases/latest",
]


# ── Localiza o exiftool ───────────────────────────────────────────────
def _exiftool_bin():
    """
    Procura o exiftool em, nesta ordem:
      1) variável de ambiente EXIFTOOL_PATH;
      2) 'exiftool' / 'exiftool.exe' no PATH;
      3) exiftool.exe na raiz do projeto (onde roda o servidor).
    Retorna o caminho/comando ou None se não achar.
    """
    env = os.getenv("EXIFTOOL_PATH")
    if env and os.path.isfile(env):
        return env
    for nome in ("exiftool", "exiftool.exe"):
        achado = shutil.which(nome)
        if achado:
            return achado
    raiz = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    for cand in (os.path.join(raiz, "exiftool.exe"), os.path.join(raiz, "exiftool")):
        if os.path.isfile(cand):
            return cand
    return None


_NOWIN = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW


def _run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, creationflags=_NOWIN)


# ── Extração / GPX (mesma lógica validada da GUI) ─────────────────────
def _normalizar_tempo(s):
    if not s:
        return None
    m = re.match(r"^(\d{4}):(\d{2}):(\d{2})\s+(.*)$", s.strip())
    if not m:
        return None
    ano, mes, dia, resto = m.groups()
    resto = resto.strip()
    if not resto.endswith("Z") and "+" not in resto:
        resto += "Z"
    return f"{ano}-{mes}-{dia}T{resto}"


def _segundo_de(t):
    if not t:
        return None
    return re.sub(r"(\d{2}:\d{2}:\d{2})(\.\d+)?", r"\1", t)


def _decimar_1hz(pontos):
    saida, ultimo = [], None
    for p in pontos:
        seg = _segundo_de(p["time"])
        if seg is None:
            saida.append(p); continue
        if seg != ultimo:
            q = dict(p); q["time"] = seg
            saida.append(q); ultimo = seg
    return saida


def _extrair_pontos(exif, video_path):
    fmt = "$GPSLatitude|$GPSLongitude|$GPSAltitude|$GPSDateTime"
    cmd = [exif, "-ee", "-n", "-p", fmt, "-api", "largefilesupport=1", video_path]
    r = _run(cmd)
    pontos = []
    for linha in r.stdout.splitlines():
        if not linha.strip():
            continue
        partes = linha.split("|")
        if len(partes) < 2:
            continue
        try:
            lat = float(partes[0].strip()); lon = float(partes[1].strip())
        except ValueError:
            continue
        if lat == 0.0 and lon == 0.0:
            continue
        ele = None
        if len(partes) > 2 and partes[2].strip():
            try:
                ele = float(re.sub(r"[^\d.\-]", "", partes[2].strip()))
            except ValueError:
                ele = None
        time_s = partes[3].strip() if len(partes) > 3 else ""
        pontos.append({"lat": lat, "lon": lon, "ele": ele,
                       "time": _normalizar_tempo(time_s)})
    return pontos


def _ler_modelo(exif, video_path):
    r = _run([exif, "-s3", "-Model", video_path])
    return r.stdout.strip() or "GoPro"


def _fmt(v):
    return repr(float(v))


def _montar_gpx(pontos, nome_mp4, modelo):
    esc = sax.escape
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<gpx xmlns="http://www.topografix.com/GPX/1/1"',
         '    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
         '    version="1.1"',
         f'    creator="{esc(CREATOR)}">',
         "    <trk>",
         f"        <name>{esc(nome_mp4)}</name>",
         f"        <src>{esc(modelo)}</src>",
         "        <trkseg>"]
    for p in pontos:
        L.append(f'            <trkpt lat="{_fmt(p["lat"])}" lon="{_fmt(p["lon"])}">')
        if p["ele"] is not None:
            L.append(f"                <ele>{_fmt(p['ele'])}</ele>")
        if p["time"]:
            L.append(f"                <time>{esc(p['time'])}</time>")
        L.append("            </trkpt>")
    L += ["        </trkseg>", "    </trk>", "</gpx>"]
    return "\n".join(L) + "\n"


def _listar_videos(pasta, recursivo):
    achados = []
    if recursivo:
        for raiz, _d, arqs in os.walk(pasta):
            for f in arqs:
                if f.lower().endswith(EXTENSOES):
                    achados.append(os.path.join(raiz, f))
    else:
        for f in os.listdir(pasta):
            full = os.path.join(pasta, f)
            if f.lower().endswith(EXTENSOES) and os.path.isfile(full):
                achados.append(full)
    return sorted(achados)


# ── Auto-instalação do exiftool ───────────────────────────────────────
def _dir_instalacao():
    """Pasta onde o exiftool será instalado (raiz do projeto)."""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _achar_asset():
    """
    Consulta as fontes conhecidas e devolve (url, nome) do zip win64 do
    exiftool, ou (None, motivo). Aceita nomes 'exiftool-XX_64.zip' e
    'exiftool-XX-win64.zip'.
    """
    import json
    padrao = re.compile(r"exiftool-.*(_64|-win64)\.zip$", re.I)
    ultimo_erro = "nenhuma fonte respondeu"
    for api in EXIFTOOL_GH_APIS:
        try:
            req = urllib.request.Request(api, headers={"User-Agent": "GPX-IMTRAFF"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            for a in data.get("assets", []):
                nome = a.get("name", "")
                if padrao.match(nome):
                    return a["browser_download_url"], nome
        except Exception as e:
            ultimo_erro = str(e)
            continue
    return None, ultimo_erro


def _instalar_exiftool_windows():
    """
    Baixa o exiftool (mirror confiável no GitHub) e instala na raiz do projeto.
    Retorna (ok: bool, msg: str). Só cobre Windows (alvo do uso local).
    """
    if os.name != "nt":
        return False, ("Auto-instalação implementada apenas para Windows. "
                       "No Linux/Mac instale via gerenciador de pacotes "
                       "(ex.: apt install libimage-exiftool-perl).")
    try:
        url, nome = _achar_asset()
        if not url:
            return False, (f"Não achei o instalador do exiftool nas fontes "
                           f"conhecidas ({nome}). Baixe manualmente em exiftool.org.")

        destino = _dir_instalacao()
        tmp_zip = os.path.join(tempfile.gettempdir(), nome)

        # Baixa o zip
        req2 = urllib.request.Request(url, headers={"User-Agent": "GPX-IMTRAFF"})
        with urllib.request.urlopen(req2, timeout=180) as resp, open(tmp_zip, "wb") as fh:
            shutil.copyfileobj(resp, fh)

        # Extrai para pasta temporária
        tmp_ext = tempfile.mkdtemp(prefix="exiftool_")
        with zipfile.ZipFile(tmp_zip) as zf:
            zf.extractall(tmp_ext)

        # A distribuição traz o .exe (às vezes 'exiftool(-k).exe') + 'exiftool_files'.
        origem_exe = None
        origem_files = None
        for raiz, dirs, arqs in os.walk(tmp_ext):
            for f in arqs:
                if f.lower().startswith("exiftool") and f.lower().endswith(".exe"):
                    origem_exe = os.path.join(raiz, f)
            for d in dirs:
                if d.lower() == "exiftool_files":
                    origem_files = os.path.join(raiz, d)

        if not origem_exe:
            return False, "Instalador baixado, mas não achei o executável dentro do zip."

        shutil.copy2(origem_exe, os.path.join(destino, "exiftool.exe"))
        if origem_files:
            dst_files = os.path.join(destino, "exiftool_files")
            if os.path.isdir(dst_files):
                shutil.rmtree(dst_files, ignore_errors=True)
            shutil.copytree(origem_files, dst_files)

        # Limpeza
        shutil.rmtree(tmp_ext, ignore_errors=True)
        try:
            os.remove(tmp_zip)
        except OSError:
            pass

        # Confirma
        exif = _exiftool_bin()
        if exif:
            r = _run([exif, "-ver"])
            ver = r.stdout.strip()
            if ver:
                return True, ver
        return False, "Instalado, mas não consegui executar o exiftool."
    except Exception as e:
        return False, f"Falha ao instalar: {e}"


def _converter_pasta_para_zip(exif, pasta, recursivo, um_hz):
    """
    Núcleo reutilizável: converte todos os vídeos de 'pasta' e devolve
    (buffer_zip, ok, vazios). Usado pelas rotas /converter e /converter-zip.
    """
    videos = _listar_videos(pasta, recursivo)
    if not videos:
        return None, 0, 0

    buf = io.BytesIO()
    usados = {}
    ok = vazios = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for v in videos:
            pontos = _extrair_pontos(exif, v)
            if not pontos:
                vazios += 1
                continue
            if um_hz:
                pontos = _decimar_1hz(pontos)
            modelo = _ler_modelo(exif, v)
            nome = os.path.basename(v)
            gpx = _montar_gpx(pontos, nome, modelo)

            rel = os.path.relpath(v, pasta)
            zpath = re.sub(r"\.(mp4|mov)$", ".gpx", rel, flags=re.I)
            if zpath in usados:
                usados[zpath] += 1
                zpath = re.sub(r"\.gpx$", f"_{usados[zpath]}.gpx", zpath)
            else:
                usados[zpath] = 1
            zf.writestr(zpath, gpx)
            ok += 1

    buf.seek(0)
    return buf, ok, vazios


# ── Schemas ───────────────────────────────────────────────────────────
class PastaIn(BaseModel):
    pasta: str
    recursivo: bool = False


class ConverterIn(BaseModel):
    pasta: str
    recursivo: bool = False
    um_hz: bool = True


# ── Rotas ─────────────────────────────────────────────────────────────
@router.get("/status")
def status(usuario: models.Usuario = Depends(get_usuario_atual)):
    exif = _exiftool_bin()
    ver = None
    if exif:
        r = _run([exif, "-ver"])
        ver = r.stdout.strip() or None
    return {"disponivel": bool(exif and ver), "versao": ver, "caminho": exif}


@router.post("/listar")
def listar(dados: PastaIn, usuario: models.Usuario = Depends(get_usuario_atual)):
    if not os.path.isdir(dados.pasta):
        raise HTTPException(400, f"Pasta não encontrada ou inacessível: {dados.pasta}")
    videos = _listar_videos(dados.pasta, dados.recursivo)
    itens = []
    for v in videos:
        try:
            tam = os.path.getsize(v)
        except OSError:
            tam = 0
        itens.append({
            "caminho": v,
            "nome": os.path.basename(v),
            "rel": os.path.relpath(v, dados.pasta),
            "tamanho_mb": round(tam / (1024 * 1024), 1),
        })
    return {"total": len(itens), "videos": itens}


@router.post("/instalar")
def instalar(usuario: models.Usuario = Depends(get_usuario_atual)):
    """Baixa e instala o exiftool automaticamente (Windows, uso local)."""
    if _exiftool_bin():
        r = _run([_exiftool_bin(), "-ver"])
        return {"ok": True, "versao": r.stdout.strip(), "ja_tinha": True}
    ok, msg = _instalar_exiftool_windows()
    if not ok:
        raise HTTPException(503, msg)
    return {"ok": True, "versao": msg, "ja_tinha": False}


@router.post("/converter")
def converter(dados: ConverterIn, usuario: models.Usuario = Depends(get_usuario_atual)):
    exif = _exiftool_bin()
    if not exif:
        raise HTTPException(
            503,
            "exiftool não encontrado no servidor. Instale-o e/ou defina EXIFTOOL_PATH. "
            "Esta função exige rodar o servidor localmente, na máquina que tem os vídeos."
        )
    if not os.path.isdir(dados.pasta):
        raise HTTPException(400, f"Pasta não encontrada ou inacessível: {dados.pasta}")

    buf, ok, vazios = _converter_pasta_para_zip(
        exif, dados.pasta, dados.recursivo, dados.um_hz)
    if buf is None:
        raise HTTPException(404, "Nenhum vídeo (.mp4/.mov) encontrado na pasta.")
    if ok == 0:
        raise HTTPException(422, "Nenhum vídeo continha dados de GPS.")

    headers = {
        "Content-Disposition": 'attachment; filename="gpx_gopro.zip"',
        "X-Convertidos": str(ok),
        "X-Sem-GPS": str(vazios),
    }
    return StreamingResponse(buf, media_type="application/zip", headers=headers)


# ── Conversão a partir de ZIP enviado (arrastar) ──────────────────────
@router.post("/converter-zip")
async def converter_zip(
    arquivo: UploadFile = File(...),
    um_hz: bool = Form(True),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    """
    Recebe um .zip contendo os vídeos, extrai numa pasta temporária do
    servidor, roda o exiftool e devolve o .zip com os .gpx.
    Ideal para quando os vídeos não estão numa pasta local (ex.: baixados
    do Drive e reenviados aqui).
    """
    exif = _exiftool_bin()
    if not exif:
        raise HTTPException(503, "exiftool não encontrado no servidor.")

    if not arquivo.filename.lower().endswith(".zip"):
        raise HTTPException(400, "Envie um arquivo .zip.")

    tmp_dir = tempfile.mkdtemp(prefix="gopro_zip_")
    try:
        # Salva o upload
        zip_path = os.path.join(tmp_dir, "entrada.zip")
        with open(zip_path, "wb") as fh:
            shutil.copyfileobj(arquivo.file, fh)

        # Extrai
        extraidos = os.path.join(tmp_dir, "videos")
        os.makedirs(extraidos, exist_ok=True)
        try:
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(extraidos)
        except zipfile.BadZipFile:
            raise HTTPException(400, "Arquivo .zip inválido ou corrompido.")

        # Converte (sempre recursivo — o zip pode ter subpastas)
        buf, ok, vazios = _converter_pasta_para_zip(exif, extraidos, True, um_hz)
        if buf is None:
            raise HTTPException(404, "Nenhum vídeo (.mp4/.mov) dentro do .zip.")
        if ok == 0:
            raise HTTPException(422, "Nenhum vídeo do .zip continha dados de GPS.")

        # Lê o buffer para memória antes de apagar o tmp
        dados = buf.getvalue()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    headers = {
        "Content-Disposition": 'attachment; filename="gpx_gopro.zip"',
        "X-Convertidos": str(ok),
        "X-Sem-GPS": str(vazios),
    }
    return StreamingResponse(io.BytesIO(dados), media_type="application/zip", headers=headers)


# ── Conversão a partir de link do Google Drive ────────────────────────
class DriveIn(BaseModel):
    link: str
    um_hz: bool = True


def _url_download_direto(link):
    """
    Converte um link de compartilhamento em URL de download direto.
    Suporta Google Drive e SharePoint/OneDrive. Retorna (url, tipo) ou (None, None).
    O link precisa ser PÚBLICO ('qualquer pessoa com o link'); links corporativos
    que exigem login não funcionam pelo servidor.
    """
    # Google Drive: /file/d/<ID>/ ou ?id=<ID>
    m = re.search(r"/file/d/([A-Za-z0-9_-]+)", link) or re.search(r"[?&]id=([A-Za-z0-9_-]+)", link)
    if m and "google" in link:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}", "drive"

    # SharePoint / OneDrive: acrescenta download=1 (funciona em links "Anyone with the link")
    if "sharepoint.com" in link or "1drv.ms" in link or "onedrive" in link.lower():
        sep = "&" if "?" in link else "?"
        return f"{link}{sep}download=1", "sharepoint"

    # Google como fallback genérico
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}", "drive"

    return None, None


@router.post("/converter-drive")
def converter_drive(dados: DriveIn, usuario: models.Usuario = Depends(get_usuario_atual)):
    """
    Baixa um ARQUIVO ZIP público do Google Drive (link de arquivo único),
    extrai e converte. Não funciona para links de PASTA do Drive (limitação
    do Google) nem para arquivos que disparam a tela de aviso de vírus.
    """
    exif = _exiftool_bin()
    if not exif:
        raise HTTPException(503, "exiftool não encontrado no servidor.")

    url, tipo = _url_download_direto(dados.link)
    if not url:
        raise HTTPException(
            400,
            "Link não reconhecido. Use um link público (.zip) do Google Drive ou "
            "SharePoint/OneDrive. Links de pasta ou que exigem login não funcionam."
        )
    tmp_dir = tempfile.mkdtemp(prefix="gopro_drive_")
    try:
        zip_path = os.path.join(tmp_dir, "drive.zip")
        req = urllib.request.Request(url, headers={"User-Agent": "GPX-IMTRAFF"})
        with urllib.request.urlopen(req, timeout=120) as resp, open(zip_path, "wb") as fh:
            shutil.copyfileobj(resp, fh)

        # Se o Drive devolveu HTML (tela de aviso), não é zip
        if not zipfile.is_zipfile(zip_path):
            raise HTTPException(
                422,
                "O Drive não entregou um .zip direto (provável tela de confirmação "
                "para arquivo grande). Baixe manualmente e use a opção de arrastar o .zip."
            )

        extraidos = os.path.join(tmp_dir, "videos")
        os.makedirs(extraidos, exist_ok=True)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(extraidos)

        buf, ok, vazios = _converter_pasta_para_zip(exif, extraidos, True, dados.um_hz)
        if buf is None:
            raise HTTPException(404, "Nenhum vídeo no .zip do Drive.")
        if ok == 0:
            raise HTTPException(422, "Nenhum vídeo do Drive continha GPS.")
        conteudo = buf.getvalue()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    headers = {
        "Content-Disposition": 'attachment; filename="gpx_gopro.zip"',
        "X-Convertidos": str(ok),
        "X-Sem-GPS": str(vazios),
    }
    return StreamingResponse(io.BytesIO(conteudo), media_type="application/zip", headers=headers)
