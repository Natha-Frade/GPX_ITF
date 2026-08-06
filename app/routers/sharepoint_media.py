"""
sharepoint_media.py — Suporte do EDITOR de vídeo ao SharePoint.

Diferente de sharepoint.py (que baixa a pasta inteira e converte em lote),
aqui o objetivo é editar SEM baixar o vídeo pro navegador:

  POST /api/sharepoint/media/listar
       { "link": "<link da pasta>" } -> lista os vídeos (driveId/itemId)

  GET  /api/sharepoint/media/stream/{drive_id}/{item_id}
       -> 307 para a downloadUrl pré-autenticada do Graph (suporta Range;
          o <video> do editor faz streaming sem passar bytes pelo servidor)

  GET  /api/sharepoint/media/gpx/{drive_id}/{item_id}
       -> extrai o GPS no servidor (exiftool) e devolve os pontos com t
          relativo ao início do vídeo, no formato do editor

  POST /api/sharepoint/media/cortar
       { "trechos": [{drive_id,item_id,inicio,fim}, ...] }
       -> corta cada trecho com ffmpeg -c copy (sem re-encode) direto da
          URL do Graph, concatena, mede as durações reais (ffprobe) e
          devolve o mp4 com o header X-Duracoes (JSON)

  GET  /api/sharepoint/media/status  -> { ok, motivo? }

Tudo depende das credenciais do Azure (MS_TENANT_ID/CLIENT_ID/SECRET). Sem
elas, todas as rotas respondem 503 com instruções — ver docs/SHAREPOINT_TI.md.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse, StreamingResponse, JSONResponse
from pydantic import BaseModel

from .. import models
from ..auth import get_usuario_atual
from .gopro import _exiftool_bin, _extrair_pontos, _ler_modelo
from .sharepoint import _token, _graph_get, _resolver_pasta, _listar_videos, GRAPH, _credenciais

router = APIRouter(prefix="/sharepoint/media", tags=["SharePoint-Editor"])

EXTENSOES = (".mp4", ".mov")


def _ffmpeg_bin():
    return shutil.which("ffmpeg")


def _ffprobe_bin():
    return shutil.which("ffprobe")


def _download_url(token, drive_id, item_id):
    """URL pré-autenticada (expira em ~1h) para stream/corte direto."""
    meta = _graph_get(token, f"{GRAPH}/drives/{drive_id}/items/{item_id}")
    url = meta.get("@microsoft.graph.downloadUrl")
    if not url:
        raise HTTPException(502, "Sem URL de download para este item do SharePoint.")
    return url, meta


# ── status ─────────────────────────────────────────────────────────────
@router.get("/status")
def status(usuario: models.Usuario = Depends(get_usuario_atual)):
    if not _credenciais():
        return {"ok": False, "motivo": "credenciais do Azure não configuradas"}
    if not _ffmpeg_bin():
        return {"ok": False, "motivo": "ffmpeg ausente no servidor"}
    return {"ok": True}


# ── listar pasta ───────────────────────────────────────────────────────
class LinkIn(BaseModel):
    link: str


@router.post("/listar")
def listar(dados: LinkIn, usuario: models.Usuario = Depends(get_usuario_atual)):
    token = _token()  # 503 se não configurado
    drive_id, folder_id, _ = _resolver_pasta(token, dados.link)
    videos = _listar_videos(token, drive_id, folder_id)
    return {
        "videos": [
            {
                "driveId": drive_id,
                "itemId": v["id"],
                "name": v["nome"],
                "path": v["rel"],
                "size": v["tamanho"],
            }
            for v in videos
        ]
    }


# ── stream (redirect para o Graph, sem passar bytes pelo servidor) ─────
@router.get("/stream/{drive_id}/{item_id}")
def stream(drive_id: str, item_id: str,
           usuario: models.Usuario = Depends(get_usuario_atual)):
    token = _token()
    url, _ = _download_url(token, drive_id, item_id)
    # 307 preserva o método e o Range do <video>; a downloadUrl do Graph
    # aceita Range, então o player faz seek/streaming direto da Microsoft
    return RedirectResponse(url, status_code=307)


# ── GPS server-side ────────────────────────────────────────────────────
@router.get("/gpx/{drive_id}/{item_id}")
def gpx(drive_id: str, item_id: str,
        usuario: models.Usuario = Depends(get_usuario_atual)):
    exif = _exiftool_bin()
    if not exif:
        raise HTTPException(503, "exiftool ausente no servidor.")
    token = _token()
    url, meta = _download_url(token, drive_id, item_id)

    # baixa só o suficiente pro exiftool ler o GPMF seria ideal, mas o
    # stream de metadados da GoPro fica espalhado — baixamos o arquivo pro
    # tmp e removemos em seguida. (Para lotes, prefira o /converter.)
    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=600) as resp:
            shutil.copyfileobj(resp, tmp)
        tmp.close()
        pontos = _extrair_pontos(exif, tmp.name)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    if not pontos:
        return {"points": [], "device": "GoPro"}

    # converte time absoluto -> t relativo (s desde o 1º ponto)
    t0 = _epoch(pontos[0]["time"])
    out = []
    for p in pontos:
        te = _epoch(p["time"])
        t = (te - t0) if (te is not None and t0 is not None) else None
        out.append({
            "t": t if t is not None else len(out) / 18.0,
            "lat": p["lat"], "lon": p["lon"], "ele": p["ele"] or 0,
        })
    return {"points": out, "device": _ler_modelo(exif, "")}


def _epoch(time_s):
    """'2026:03:21 17:52:14.200Z' / ISO -> segundos (float) ou None."""
    if not time_s:
        return None
    s = time_s.strip().replace("Z", "")
    m = re.search(r"(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)", s)
    if not m:
        return None
    import datetime
    y, mo, d, h, mi = (int(m.group(i)) for i in range(1, 6))
    sec = float(m.group(6))
    try:
        base = datetime.datetime(y, mo, d, h, mi, int(sec),
                                 int((sec % 1) * 1e6),
                                 tzinfo=datetime.timezone.utc)
        return base.timestamp()
    except ValueError:
        return None


# ── corte por stream copy (server-side, direto da URL do Graph) ────────
class Trecho(BaseModel):
    drive_id: str
    item_id: str
    inicio: float
    fim: float


class CortarIn(BaseModel):
    trechos: list[Trecho]


@router.post("/cortar")
def cortar(dados: CortarIn, usuario: models.Usuario = Depends(get_usuario_atual)):
    ff = _ffmpeg_bin()
    if not ff:
        raise HTTPException(503, "ffmpeg ausente no servidor (confira o Dockerfile).")
    if not dados.trechos:
        raise HTTPException(400, "Nenhum trecho informado.")
    token = _token()
    probe = _ffprobe_bin()

    workdir = tempfile.mkdtemp(prefix="edit_")
    pecas = []
    duracoes = []
    try:
        for i, tr in enumerate(dados.trechos):
            url, _ = _download_url(token, tr.drive_id, tr.item_id)
            saida = os.path.join(workdir, f"p{i}.mp4")
            # -ss antes do -i (busca rápida por keyframe) + -c copy: sem
            # re-encode. O ffmpeg lê a URL por HTTP com Range internamente.
            cmd = [
                ff, "-y", "-ss", f"{tr.inicio:.3f}", "-i", url,
                "-t", f"{tr.fim - tr.inicio:.3f}", "-c", "copy",
                "-avoid_negative_ts", "make_zero",
                "-movflags", "+faststart", saida,
            ]
            r = subprocess.run(cmd, capture_output=True, timeout=1800)
            if r.returncode != 0 or not os.path.exists(saida):
                raise HTTPException(502, f"Falha ao cortar o trecho {i + 1}: "
                                         f"{r.stderr.decode(errors='ignore')[-400:]}")
            duracoes.append(_medir(probe, saida) or (tr.fim - tr.inicio))
            pecas.append(saida)

        if len(pecas) == 1:
            final = pecas[0]
        else:
            lista = os.path.join(workdir, "lista.txt")
            with open(lista, "w") as fh:
                for p in pecas:
                    fh.write(f"file '{p}'\n")
            final = os.path.join(workdir, "final.mp4")
            r = subprocess.run(
                [ff, "-y", "-f", "concat", "-safe", "0", "-i", lista,
                 "-c", "copy", "-movflags", "+faststart", final],
                capture_output=True, timeout=1800)
            if r.returncode != 0:
                raise HTTPException(502, "Falha ao juntar os trechos: "
                                         f"{r.stderr.decode(errors='ignore')[-400:]}")

        with open(final, "rb") as fh:
            conteudo = fh.read()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    return StreamingResponse(
        iter([conteudo]),
        media_type="video/mp4",
        headers={
            "X-Duracoes": json.dumps([round(d, 3) for d in duracoes]),
            "Content-Disposition": 'attachment; filename="corte.mp4"',
            "Access-Control-Expose-Headers": "X-Duracoes",
        },
    )


def _medir(probe, path):
    if not probe:
        return None
    try:
        r = subprocess.run(
            [probe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, timeout=60)
        return float(r.stdout.decode().strip())
    except (ValueError, subprocess.SubprocessError):
        return None
