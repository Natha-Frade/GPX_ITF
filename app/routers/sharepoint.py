"""
sharepoint.py — Conversão GoPro → GPX a partir de um LINK DE PASTA do SharePoint.

⚠ PRÉ-REQUISITO (uma vez só, feito pela TI da empresa):
  Registrar um aplicativo no Azure AD (Entra ID) com permissão de
  APLICATIVO "Files.Read.All" (ou "Sites.Read.All") + consentimento do
  administrador, e configurar no Railway as variáveis:

    MS_TENANT_ID     -> ID do tenant (Directory ID)
    MS_CLIENT_ID     -> ID do aplicativo registrado
    MS_CLIENT_SECRET -> segredo do cliente

  Sem isso, a rota responde 503 com instruções. A Graph API NÃO permite
  baixar uma pasta inteira como zip — este código lista os vídeos da
  pasta (recursivo) e baixa um por um para o disco temporário do
  servidor antes de rodar o exiftool.

Rota:
  POST /api/sharepoint/converter  { "link": "<link da pasta>", "um_hz": true }
  -> devolve um .zip com os .gpx (mesmas subpastas da biblioteca)

Observação de capacidade: vídeos GoPro têm GB de tamanho; o servidor
precisa baixar tudo do SharePoint antes de converter. Para lotes muito
grandes, prefira o modo "Navegador" do site (pasta sincronizada via
OneDrive, sem tráfego de vídeo).
"""

import base64
import io
import json
import os
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
import zipfile

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import models
from ..auth import get_usuario_atual
from .gopro import (_exiftool_bin, _extrair_pontos, _ler_modelo,
                    _decimar_1hz, _montar_gpx)

router = APIRouter(prefix="/sharepoint", tags=["SharePoint"])

GRAPH = "https://graph.microsoft.com/v1.0"
EXTENSOES = (".mp4", ".mov")


# ── Autenticação (client credentials) ─────────────────────────────────
def _credenciais():
    t = os.getenv("MS_TENANT_ID")
    c = os.getenv("MS_CLIENT_ID")
    s = os.getenv("MS_CLIENT_SECRET")
    if not (t and c and s):
        return None
    return t, c, s


def _token():
    cred = _credenciais()
    if not cred:
        raise HTTPException(503, (
            "Integração com SharePoint não configurada. A TI precisa registrar "
            "um app no Azure AD (permissão de aplicativo Files.Read.All com "
            "consentimento do admin) e definir MS_TENANT_ID, MS_CLIENT_ID e "
            "MS_CLIENT_SECRET nas variáveis do Railway. Enquanto isso, use o "
            "modo 'Navegador' do site com a pasta sincronizada pelo OneDrive."
        ))
    tenant, client, secret = cred
    url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
    body = urllib.parse.urlencode({
        "client_id": client,
        "client_secret": secret,
        "scope": "https://graph.microsoft.com/.default",
        "grant_type": "client_credentials",
    }).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        return data["access_token"]
    except Exception as e:
        raise HTTPException(502, f"Falha ao autenticar no Microsoft Graph: {e}")


def _graph_get(token, url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


# ── Resolve o link compartilhado -> driveItem da pasta ─────────────────
def _encode_share(link):
    """Codificação de sharing URL do Graph: 'u!' + base64url sem padding."""
    b = base64.urlsafe_b64encode(link.encode()).decode().rstrip("=")
    return "u!" + b


def _resolver_pasta(token, link):
    share = _encode_share(link)
    try:
        item = _graph_get(token, f"{GRAPH}/shares/{share}/driveItem")
    except Exception as e:
        raise HTTPException(400, (
            "Não consegui resolver o link no Graph. Confira se é um link de "
            f"compartilhamento válido do SharePoint/OneDrive. Detalhe: {e}"
        ))
    if "folder" not in item:
        raise HTTPException(400, "O link aponta para um arquivo, não uma pasta.")
    drive_id = item["parentReference"]["driveId"]
    return drive_id, item["id"], item.get("name", "pasta")


# ── Lista vídeos recursivamente ────────────────────────────────────────
def _listar_videos(token, drive_id, item_id, prefixo=""):
    achados = []
    url = f"{GRAPH}/drives/{drive_id}/items/{item_id}/children?$top=200"
    while url:
        data = _graph_get(token, url)
        for it in data.get("value", []):
            nome = it.get("name", "")
            rel = f"{prefixo}/{nome}" if prefixo else nome
            if "folder" in it:
                achados += _listar_videos(token, drive_id, it["id"], rel)
            elif nome.lower().endswith(EXTENSOES):
                achados.append({
                    "id": it["id"],
                    "rel": rel,
                    "nome": nome,
                    "download": it.get("@microsoft.graph.downloadUrl"),
                    "tamanho": it.get("size", 0),
                })
        url = data.get("@odata.nextLink")
    return achados


def _baixar(token, drive_id, video, destino):
    url = video.get("download")
    if not url:
        # downloadUrl pode expirar; busca de novo
        meta = _graph_get(token, f"{GRAPH}/drives/{drive_id}/items/{video['id']}")
        url = meta.get("@microsoft.graph.downloadUrl")
    if not url:
        raise HTTPException(502, f"Sem URL de download para {video['rel']}")
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=600) as resp, open(destino, "wb") as fh:
        shutil.copyfileobj(resp, fh)


# ── Rota principal ─────────────────────────────────────────────────────
class SharePointIn(BaseModel):
    link: str
    um_hz: bool = True


@router.get("/status")
def status(usuario: models.Usuario = Depends(get_usuario_atual)):
    return {
        "configurado": bool(_credenciais()),
        "exiftool": bool(_exiftool_bin()),
    }


@router.post("/converter")
def converter(dados: SharePointIn,
              usuario: models.Usuario = Depends(get_usuario_atual)):
    exif = _exiftool_bin()
    if not exif:
        raise HTTPException(503, "exiftool não encontrado no servidor "
                                 "(confira o Dockerfile do deploy).")
    token = _token()
    drive_id, folder_id, nome_pasta = _resolver_pasta(token, dados.link)
    videos = _listar_videos(token, drive_id, folder_id)
    if not videos:
        raise HTTPException(404, "Nenhum vídeo (.mp4/.mov) na pasta do SharePoint.")

    buf = io.BytesIO()
    ok = vazios = 0
    usados = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for v in videos:
            tmp_dir = tempfile.mkdtemp(prefix="sp_video_")
            try:
                local = os.path.join(tmp_dir, v["nome"])
                _baixar(token, drive_id, v, local)

                pontos = _extrair_pontos(exif, local)
                if not pontos:
                    vazios += 1
                    continue
                if dados.um_hz:
                    pontos = _decimar_1hz(pontos)
                modelo = _ler_modelo(exif, local)
                gpx = _montar_gpx(pontos, v["nome"], modelo)

                zpath = re.sub(r"\.(mp4|mov)$", ".gpx", v["rel"], flags=re.I)
                if zpath in usados:
                    usados[zpath] += 1
                    zpath = re.sub(r"\.gpx$", f"_{usados[zpath]}.gpx", zpath)
                else:
                    usados[zpath] = 1
                zf.writestr(zpath, gpx)
                ok += 1
            finally:
                # Apaga o vídeo imediatamente: disco do Railway é limitado
                shutil.rmtree(tmp_dir, ignore_errors=True)

    if ok == 0:
        raise HTTPException(422, "Nenhum vídeo da pasta continha dados de GPS.")

    buf.seek(0)
    headers = {
        "Content-Disposition": f'attachment; filename="gpx_{nome_pasta}.zip"',
        "X-Convertidos": str(ok),
        "X-Sem-GPS": str(vazios),
    }
    return StreamingResponse(buf, media_type="application/zip", headers=headers)
