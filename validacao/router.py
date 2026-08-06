# -*- coding: utf-8 -*-
"""
Router FastAPI — Validação de Campo (GPX IMTRAFF)

Integração no main.py do GPX_ITF (ANTES de qualquer rota catch-all):

    from validacao.router import router as validacao_router
    app.include_router(validacao_router)

A página fica em /validacao (serve static/validacao.html).
Referências (KMZ dos marcos quilométricos + planilha de filmagem) ficam
salvas em VALIDACAO_DATA_DIR e sobrevivem entre requisições; num redeploy
do Railway é só reenviar.
"""
import io
import os
import json
import time

from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse

from . import engine

router = APIRouter(prefix="/validacao", tags=["validacao-campo"])

DATA_DIR = os.environ.get("VALIDACAO_DATA_DIR", "data_validacao")
os.makedirs(DATA_DIR, exist_ok=True)

_REF_KMZ = os.path.join(DATA_DIR, "marcos.json")
_REF_PLAN = os.path.join(DATA_DIR, "cortes.json")

XLSX_MIME = ("application/vnd.openxmlformats-officedocument"
             ".spreadsheetml.sheet")


def _carregar(caminho):
    if not os.path.exists(caminho):
        return None
    with open(caminho, encoding="utf-8") as f:
        return json.load(f)


def _lote_valido(lote_id):
    return bool(lote_id) and not set("/\\") & set(lote_id) and ".." not in lote_id


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
        rodovias = engine.parse_kmz(dados)
    except Exception as e:
        raise HTTPException(400, f"KMZ inválido: {e}")
    if not rodovias:
        raise HTTPException(400, "Nenhum marco quilométrico encontrado. As "
                                 "pastas do KMZ precisam ter a rodovia no "
                                 "nome (ex.: 'Marcos_km_BR116').")
    rotas = engine.montar_rotas(rodovias)
    if not rotas:
        raise HTTPException(400, "Os marcos do KMZ não formam uma rota "
                                 "contínua — confira se a pasta traz os "
                                 "marcos de km da rodovia.")
    with open(_REF_KMZ, "w", encoding="utf-8") as f:
        json.dump({"arquivo": arquivo.filename, "rodovias": rodovias}, f)
    return {
        "ok": True, "arquivo": arquivo.filename,
        "rodovias": {r: {"marcos": len(rotas[r][0]),
                         "extensao_km": round(rotas[r][0][-1]["off"] / 1000, 1)}
                     for r in rotas},
        "marcos": sum(len(v) for v in rodovias.values()),
    }


@router.post("/referencia/planilha")
async def subir_planilha(arquivo: UploadFile = File(...)):
    dados = await arquivo.read()
    try:
        cortes = engine.parse_planilha(dados)
    except Exception as e:
        raise HTTPException(400, f"Planilha inválida: {e}")
    if not cortes:
        raise HTTPException(400, "Nenhum corte encontrado. Esperado: coluna B "
                                 "com a rodovia (BR-116), C com a pista, D e E "
                                 "com os km (215+000).")
    with open(_REF_PLAN, "w", encoding="utf-8") as f:
        json.dump({"arquivo": arquivo.filename, "cortes": cortes}, f)
    return {"ok": True, "arquivo": arquivo.filename, "cortes": len(cortes),
            "rodovias": sorted({c["rodovia"] for c in cortes})}


@router.get("/referencia/status")
def status_referencias():
    kmz = _carregar(_REF_KMZ)
    plan = _carregar(_REF_PLAN)
    return {
        "kmz": {"carregado": kmz is not None,
                "arquivo": kmz and kmz["arquivo"],
                "rodovias": kmz and sorted(kmz["rodovias"]),
                "marcos": kmz and sum(len(v) for v in kmz["rodovias"].values())},
        "planilha": {"carregado": plan is not None,
                     "arquivo": plan and plan["arquivo"],
                     "cortes": plan and len(plan["cortes"])},
    }


# -------------------------------------------------------- consulta por km
@router.get("/consulta-km")
def consulta_km(ini: str, fim: str | None = None, trecho: str | None = None):
    """Cortes da planilha ligados a um km ou intervalo. Formato: '340+000'."""
    plan = _carregar(_REF_PLAN)
    if not plan:
        raise HTTPException(409, "Carregue a planilha de filmagem primeiro.")

    def parse(s):
        s = (s or "").strip().replace(" ", "")
        if not s:
            return None
        km = engine.parse_km_planilha(s)
        if km is None:
            raise HTTPException(400, f"Km inválido: '{s}'. Use 340+000.")
        return km

    km_ini = parse(ini)
    if km_ini is None:
        raise HTTPException(400, "Informe o km inicial.")
    km_fim = parse(fim) if fim else None

    achados = engine.cortes_por_km(plan["cortes"], km_ini, km_fim,
                                   rodovia=trecho)
    return {
        "consulta": {"ini": engine.fmt_km(km_ini),
                     "fim": engine.fmt_km(km_fim) if km_fim is not None else None,
                     "trecho": trecho},
        "trechos_disponiveis": sorted({c["rodovia"] for c in plan["cortes"]}),
        "total": len(achados),
        "videos": [{"video": c["nome"], "trecho": c["rodovia"],
                    "pista": c.get("pista", ""),
                    "km_ini": c["km_ini_str"], "km_fim": c["km_fim_str"],
                    "aba": c.get("aba")} for c in achados],
    }


@router.get("/trechos")
def listar_trechos():
    """Rodovias presentes na planilha carregada — p/ o filtro da UI."""
    plan = _carregar(_REF_PLAN)
    if not plan:
        return {"trechos": []}
    return {"trechos": sorted({c["rodovia"] for c in plan["cortes"]})}


# ------------------------------------------------------- consulta por GPX
@router.post("/consulta-gpx")
async def consulta_gpx(arquivos: list[UploadFile] = File(...)):
    """Estima o km de cada GPX pelos marcos e devolve os cortes que cobrem."""
    kmz = _carregar(_REF_KMZ)
    plan = _carregar(_REF_PLAN)
    if not plan:
        raise HTTPException(409, "Carregue a planilha de filmagem primeiro.")
    if not kmz:
        raise HTTPException(409, "Carregue o KMZ dos marcos quilométricos "
                                 "primeiro — é ele que dá o km das trilhas.")

    entradas = []
    for up in arquivos:
        entradas += engine.extrair_gpx_de_upload(up.filename, await up.read())
    if not entradas:
        raise HTTPException(400, "Nenhum .gpx no envio.")

    resultados = []
    for ent in entradas:
        try:
            g = engine.parse_gpx(ent["dados"])
        except Exception as e:
            resultados.append({"arquivo": ent["arquivo"],
                               "erro": f"GPX inválido: {e}"})
            continue
        rod, ini, fim = engine.estimar_km_gpx(g["points"], kmz["rodovias"])
        if ini is None:
            resultados.append({"arquivo": ent["arquivo"],
                               "erro": "a trilha não bate com nenhuma rodovia "
                                       "do KMZ"})
            continue
        achados = engine.cortes_por_km(plan["cortes"], ini, fim, rodovia=rod)
        resultados.append({
            "arquivo": ent["arquivo"], "camera": ent["camera"],
            "trecho": rod, "pontos": len(g["points"]),
            "km_ini": engine.fmt_km(min(ini, fim)),
            "km_fim": engine.fmt_km(max(ini, fim)),
            "videos": [{"video": c["nome"], "trecho": c["rodovia"],
                        "pista": c.get("pista", ""),
                        "km_ini": c["km_ini_str"], "km_fim": c["km_fim_str"]}
                       for c in achados],
        })
    return {"resultados": resultados}


# ------------------------------------------------------------------- lote
@router.post("/lote")
async def processar_lote(arquivos: list[UploadFile] = File(...)):
    kmz = _carregar(_REF_KMZ)
    plan = _carregar(_REF_PLAN)
    if not kmz or not plan:
        raise HTTPException(409, "Carregue primeiro o KMZ dos marcos e a "
                                 "planilha de filmagem na aba Referências.")
    entradas = []
    for up in arquivos:
        entradas += engine.extrair_gpx_de_upload(up.filename, await up.read())
    if not entradas:
        raise HTTPException(400, "Nenhum .gpx encontrado no envio "
                                 "(aceito: .gpx ou .zip com .gpx dentro).")

    try:
        relatorio = engine.validar_lote(entradas, kmz["rodovias"],
                                        plan["cortes"])
    except ValueError as e:
        raise HTTPException(400, str(e))

    xlsx = engine.exportar_xlsx(relatorio, kmz["arquivo"], plan["arquivo"])

    lote_id = time.strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(DATA_DIR, f"lote_{lote_id}.xlsx"), "wb") as f:
        f.write(xlsx)
    relatorio["lote_id"] = lote_id
    relatorio["download"] = f"/validacao/lote/{lote_id}/xlsx"
    with open(os.path.join(DATA_DIR, f"lote_{lote_id}.json"), "w",
              encoding="utf-8") as f:
        json.dump(relatorio, f, ensure_ascii=False)
    return JSONResponse(relatorio)


@router.get("/lote/{lote_id}/xlsx")
def baixar_lote(lote_id: str):
    if not _lote_valido(lote_id):
        raise HTTPException(404, "Lote não encontrado.")
    caminho = os.path.join(DATA_DIR, f"lote_{lote_id}.xlsx")
    if not os.path.exists(caminho):
        raise HTTPException(404, "Lote não encontrado.")
    with open(caminho, "rb") as f:
        dados = f.read()
    return StreamingResponse(
        io.BytesIO(dados), media_type=XLSX_MIME,
        headers={"Content-Disposition":
                 f'attachment; filename="Validacao_{lote_id}.xlsx"'})
