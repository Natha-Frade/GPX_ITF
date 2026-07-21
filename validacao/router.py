# -*- coding: utf-8 -*-
"""
Router FastAPI — Validação de Campo (GPX IMTRAFF)

Integração no main.py do GPX_ITF (ANTES de qualquer rota catch-all):

    from validacao.router import router as validacao_router
    app.include_router(validacao_router)

A página fica em /validacao (serve static/validacao.html).
Referências (KMZ + planilha) ficam salvas em VALIDACAO_DATA_DIR e
sobrevivem entre requisições; num redeploy do Railway é só reenviar.
"""
import io
import os
import json
import time
import zipfile

from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse

from . import engine

router = APIRouter(prefix="/validacao", tags=["validacao-campo"])

DATA_DIR = os.environ.get("VALIDACAO_DATA_DIR", "data_validacao")
os.makedirs(DATA_DIR, exist_ok=True)

_REF_KMZ = os.path.join(DATA_DIR, "dispositivos.json")
_REF_PLAN = os.path.join(DATA_DIR, "cortes.json")


def _carregar(caminho):
    if not os.path.exists(caminho):
        return None
    with open(caminho, encoding="utf-8") as f:
        return json.load(f)


# ------------------------------------------------------------------ página
@router.get("", response_class=HTMLResponse)
@router.get("/", response_class=HTMLResponse)
def pagina():
    caminho = os.path.join("static", "validacao.html")
    if not os.path.exists(caminho):
        raise HTTPException(404, "static/validacao.html não encontrado")
    with open(caminho, encoding="utf-8") as f:
        return f.read()


# ------------------------------------------------------------- referências
@router.post("/referencia/kmz")
async def subir_kmz(arquivo: UploadFile = File(...)):
    dados = await arquivo.read()
    try:
        dispositivos = engine.parse_kmz(dados)
    except Exception as e:
        raise HTTPException(400, f"KMZ inválido: {e}")
    if not dispositivos:
        raise HTTPException(400, "Nenhum dispositivo com Km encontrado no KMZ.")
    with open(_REF_KMZ, "w", encoding="utf-8") as f:
        json.dump({"arquivo": arquivo.filename, "dispositivos": dispositivos}, f)
    return {"ok": True, "arquivo": arquivo.filename,
            "dispositivos": len(dispositivos)}


@router.post("/referencia/planilha")
async def subir_planilha(arquivo: UploadFile = File(...)):
    dados = await arquivo.read()
    try:
        cortes = engine.parse_planilha(dados)
    except Exception as e:
        raise HTTPException(400, f"Planilha inválida: {e}")
    if not cortes:
        raise HTTPException(400, "Nenhuma linha 'Corte N' com Km encontrada.")
    with open(_REF_PLAN, "w", encoding="utf-8") as f:
        json.dump({"arquivo": arquivo.filename, "cortes": cortes}, f)
    return {"ok": True, "arquivo": arquivo.filename, "cortes": len(cortes)}


@router.get("/referencia/status")
def status_referencias():
    kmz = _carregar(_REF_KMZ)
    plan = _carregar(_REF_PLAN)
    return {
        "kmz": {"carregado": kmz is not None,
                "arquivo": kmz and kmz["arquivo"],
                "dispositivos": kmz and len(kmz["dispositivos"])},
        "planilha": {"carregado": plan is not None,
                     "arquivo": plan and plan["arquivo"],
                     "cortes": plan and len(plan["cortes"])},
    }


# ------------------------------------------------------------------- lote
@router.post("/lote")
async def processar_lote(arquivos: list[UploadFile] = File(...)):
    kmz = _carregar(_REF_KMZ)
    plan = _carregar(_REF_PLAN)
    if not kmz or not plan:
        raise HTTPException(409, "Carregue primeiro o KMZ e a planilha de "
                                 "controle na aba Referências.")
    entradas = []
    for up in arquivos:
        dados = await up.read()
        entradas.extend(engine.extrair_gpx_de_upload(up.filename, dados))
    if not entradas:
        raise HTTPException(400, "Nenhum .gpx encontrado no envio "
                                 "(aceito: .gpx ou .zip com .gpx dentro).")

    relatorio, zip_bytes = engine.processar_lote(
        entradas, kmz["dispositivos"], plan["cortes"])

    lote_id = time.strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(DATA_DIR, f"lote_{lote_id}.zip"), "wb") as f:
        f.write(zip_bytes)
    relatorio["lote_id"] = lote_id
    relatorio["download"] = f"/validacao/lote/{lote_id}/zip"
    with open(os.path.join(DATA_DIR, f"lote_{lote_id}.json"), "w",
              encoding="utf-8") as f:
        json.dump(relatorio, f, ensure_ascii=False)
    return JSONResponse(relatorio)


@router.get("/lote/{lote_id}/zip")
def baixar_lote(lote_id: str):
    caminho = os.path.join(DATA_DIR, f"lote_{lote_id}.zip")
    if not os.path.exists(caminho) or "/" in lote_id or ".." in lote_id:
        raise HTTPException(404, "Lote não encontrado.")
    return StreamingResponse(
        open(caminho, "rb"), media_type="application/zip",
        headers={"Content-Disposition":
                 f'attachment; filename="GPX_validados_{lote_id}.zip"'})
