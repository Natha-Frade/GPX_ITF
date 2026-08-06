# -*- coding: utf-8 -*-
"""
Biblioteca de KMZ compartilhados.

Quem é ADMIN sobe um KMZ e dá o nome que quiser ("BR-116 Norte — Marcos").
Todo mundo que entra no sistema vê essa lista na aba MARCAÇÕES e carrega
o que precisar, sem ter o arquivo na máquina.

Os arquivos ficam em KMZ_LIB_DIR (padrão: data_kmz/) junto de um
index.json com os metadados. Mesmo esquema do módulo de validação —
sem tabela nova no banco, o que evita migração.

ATENÇÃO no Railway: o disco é efêmero, então um redeploy limpa a
biblioteca. Para manter, aponte KMZ_LIB_DIR para um volume persistente.
"""
import io
import os
import json
import time
import uuid
import zipfile

from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse

from .. import models
from ..auth import require_admin, get_usuario_atual

router = APIRouter(prefix="/kmz-lib", tags=["KMZ compartilhados"])

DATA_DIR = os.environ.get("KMZ_LIB_DIR", "data_kmz")
os.makedirs(DATA_DIR, exist_ok=True)
_INDEX = os.path.join(DATA_DIR, "index.json")

EXT_OK = ('.kmz', '.kml')
TAM_MAX = 60 * 1024 * 1024      # 60 MB por arquivo


def _ler_index():
    if not os.path.exists(_INDEX):
        return []
    try:
        with open(_INDEX, encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def _salvar_index(itens):
    with open(_INDEX, 'w', encoding='utf-8') as f:
        json.dump(itens, f, ensure_ascii=False, indent=2)


def _validar_arquivo(nome, dados):
    """Confere extensão, tamanho e se o conteúdo é mesmo KMZ/KML."""
    low = (nome or '').lower()
    if not low.endswith(EXT_OK):
        raise HTTPException(400, "Envie um arquivo .kmz ou .kml")
    if len(dados) > TAM_MAX:
        raise HTTPException(400, f"Arquivo maior que {TAM_MAX // 1024 // 1024} MB")
    if not dados:
        raise HTTPException(400, "Arquivo vazio")

    if low.endswith('.kmz'):
        # KMZ é um zip que precisa ter um .kml dentro
        try:
            z = zipfile.ZipFile(io.BytesIO(dados))
        except zipfile.BadZipFile:
            raise HTTPException(400, "KMZ inválido (não é um arquivo zip)")
        if not any(n.lower().endswith('.kml') for n in z.namelist()):
            raise HTTPException(400, "KMZ sem nenhum .kml dentro")
    else:
        cabeca = dados[:2048].lower()
        if b'<kml' not in cabeca:
            raise HTTPException(400, "KML inválido")


# ── Leitura: qualquer usuário logado ─────────────────────────────────

@router.get("")
@router.get("/")
def listar(_: models.Usuario = Depends(get_usuario_atual)):
    """Lista os KMZ disponíveis (sem o conteúdo, só os metadados)."""
    itens = sorted(_ler_index(), key=lambda i: i.get('nome', '').lower())
    return {"itens": itens, "total": len(itens)}


@router.get("/{item_id}/arquivo")
def baixar(item_id: str, _: models.Usuario = Depends(get_usuario_atual)):
    """Devolve o arquivo para o navegador carregar no mapa."""
    item = next((i for i in _ler_index() if i['id'] == item_id), None)
    if not item:
        raise HTTPException(404, "KMZ não encontrado")
    caminho = os.path.join(DATA_DIR, item['arquivo'])
    if not os.path.exists(caminho):
        raise HTTPException(404, "Arquivo ausente no servidor")
    return FileResponse(
        caminho,
        media_type='application/vnd.google-earth.kmz',
        filename=item.get('nome_original') or item['arquivo'],
    )


# ── Escrita: só ADMIN ────────────────────────────────────────────────

@router.post("")
@router.post("/")
async def enviar(
    arquivo: UploadFile = File(...),
    nome: str = Form(...),
    descricao: str = Form(''),
    usuario: models.Usuario = Depends(require_admin),
):
    """Sobe um KMZ com o nome que o admin escolher."""
    nome = (nome or '').strip()
    if not nome:
        raise HTTPException(400, "Dê um nome para o KMZ")
    if len(nome) > 120:
        raise HTTPException(400, "Nome muito longo (máx. 120 caracteres)")

    dados = await arquivo.read()
    _validar_arquivo(arquivo.filename, dados)

    item_id = uuid.uuid4().hex[:12]
    ext = '.kmz' if arquivo.filename.lower().endswith('.kmz') else '.kml'
    fisico = f"{item_id}{ext}"
    with open(os.path.join(DATA_DIR, fisico), 'wb') as f:
        f.write(dados)

    itens = _ler_index()
    itens.append({
        'id': item_id,
        'nome': nome,
        'descricao': (descricao or '').strip()[:300],
        'arquivo': fisico,
        'nome_original': arquivo.filename,
        'tamanho': len(dados),
        'enviado_por': usuario.nome,
        'enviado_em': time.strftime('%Y-%m-%d %H:%M:%S'),
    })
    _salvar_index(itens)
    return {"ok": True, "id": item_id, "nome": nome}


@router.patch("/{item_id}")
def renomear(
    item_id: str,
    dados: dict,
    _: models.Usuario = Depends(require_admin),
):
    """Renomeia ou muda a descrição."""
    itens = _ler_index()
    item = next((i for i in itens if i['id'] == item_id), None)
    if not item:
        raise HTTPException(404, "KMZ não encontrado")
    if 'nome' in dados:
        novo = (dados['nome'] or '').strip()
        if not novo:
            raise HTTPException(400, "Nome não pode ficar vazio")
        item['nome'] = novo[:120]
    if 'descricao' in dados:
        item['descricao'] = (dados['descricao'] or '').strip()[:300]
    _salvar_index(itens)
    return {"ok": True, "item": item}


@router.delete("/{item_id}")
def remover(item_id: str, _: models.Usuario = Depends(require_admin)):
    """Tira o KMZ da biblioteca (apaga o arquivo também)."""
    itens = _ler_index()
    item = next((i for i in itens if i['id'] == item_id), None)
    if not item:
        raise HTTPException(404, "KMZ não encontrado")
    try:
        os.remove(os.path.join(DATA_DIR, item['arquivo']))
    except OSError:
        pass                      # arquivo já sumiu: segue e limpa o índice
    _salvar_index([i for i in itens if i['id'] != item_id])
    return {"ok": True}
