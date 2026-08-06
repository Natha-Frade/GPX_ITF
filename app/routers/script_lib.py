# -*- coding: utf-8 -*-
"""
Biblioteca de scripts compartilhados.

Mesma arquitetura do kmz_lib: quem é ADMIN publica um .zip com título e
descrição; todo usuário logado vê a lista e baixa o que precisar.

Os arquivos ficam em SCRIPT_LIB_DIR (padrão: data_scripts/) junto de um
index.json com os metadados — sem tabela nova no banco, sem migração.

ATENÇÃO no Railway: o disco é efêmero, então um redeploy limpa a
biblioteca. Para manter, aponte SCRIPT_LIB_DIR para um volume.
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

router = APIRouter(prefix="/script-lib", tags=["Scripts compartilhados"])

DATA_DIR = os.environ.get("SCRIPT_LIB_DIR", "data_scripts")
os.makedirs(DATA_DIR, exist_ok=True)
_INDEX = os.path.join(DATA_DIR, "index.json")

TAM_MAX = 100 * 1024 * 1024      # 100 MB por script


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


def _validar_zip(nome, dados):
    """Confere extensão, tamanho e se é mesmo um zip legível."""
    if not (nome or '').lower().endswith('.zip'):
        raise HTTPException(400, "Envie o script zipado (.zip)")
    if not dados:
        raise HTTPException(400, "Arquivo vazio")
    if len(dados) > TAM_MAX:
        raise HTTPException(400, f"Arquivo maior que {TAM_MAX // 1024 // 1024} MB")
    try:
        z = zipfile.ZipFile(io.BytesIO(dados))
    except zipfile.BadZipFile:
        raise HTTPException(400, "ZIP inválido ou corrompido")
    if z.testzip() is not None:
        raise HTTPException(400, "ZIP com arquivo corrompido dentro")
    nomes = [n for n in z.namelist() if not n.endswith('/')]
    if not nomes:
        raise HTTPException(400, "ZIP vazio")
    return len(nomes)


# ── Leitura: qualquer usuário logado ─────────────────────────────────

@router.get("")
@router.get("/")
def listar(_: models.Usuario = Depends(get_usuario_atual)):
    """Lista os scripts disponíveis (só metadados)."""
    itens = sorted(_ler_index(), key=lambda i: i.get('titulo', '').lower())
    return {"itens": itens, "total": len(itens)}


@router.get("/{item_id}/arquivo")
def baixar(item_id: str, _: models.Usuario = Depends(get_usuario_atual)):
    """Baixa o .zip do script."""
    item = next((i for i in _ler_index() if i['id'] == item_id), None)
    if not item:
        raise HTTPException(404, "Script não encontrado")
    caminho = os.path.join(DATA_DIR, item['arquivo'])
    if not os.path.exists(caminho):
        raise HTTPException(404, "Arquivo ausente no servidor")
    # conta o download, para o admin saber o que a equipe usa
    itens = _ler_index()
    for i in itens:
        if i['id'] == item_id:
            i['downloads'] = i.get('downloads', 0) + 1
    _salvar_index(itens)
    return FileResponse(
        caminho, media_type='application/zip',
        filename=item.get('nome_original') or (item['titulo'] + '.zip'),
    )


# ── Escrita: só ADMIN ────────────────────────────────────────────────

@router.post("")
@router.post("/")
async def enviar(
    arquivo: UploadFile = File(...),
    titulo: str = Form(...),
    descricao: str = Form(''),
    usuario: models.Usuario = Depends(require_admin),
):
    """Publica um script zipado com título e descrição."""
    titulo = (titulo or '').strip()
    if not titulo:
        raise HTTPException(400, "Dê um título para o script")
    if len(titulo) > 120:
        raise HTTPException(400, "Título muito longo (máx. 120 caracteres)")

    dados = await arquivo.read()
    n_arquivos = _validar_zip(arquivo.filename, dados)

    item_id = uuid.uuid4().hex[:12]
    fisico = f"{item_id}.zip"
    with open(os.path.join(DATA_DIR, fisico), 'wb') as f:
        f.write(dados)

    itens = _ler_index()
    itens.append({
        'id': item_id,
        'titulo': titulo,
        'descricao': (descricao or '').strip()[:600],
        'arquivo': fisico,
        'nome_original': arquivo.filename,
        'tamanho': len(dados),
        'arquivos': n_arquivos,
        'downloads': 0,
        'enviado_por': usuario.nome,
        'enviado_em': time.strftime('%Y-%m-%d %H:%M:%S'),
    })
    _salvar_index(itens)
    return {"ok": True, "id": item_id, "titulo": titulo, "arquivos": n_arquivos}


@router.patch("/{item_id}")
def editar(item_id: str, dados: dict, _: models.Usuario = Depends(require_admin)):
    """Edita título ou descrição."""
    itens = _ler_index()
    item = next((i for i in itens if i['id'] == item_id), None)
    if not item:
        raise HTTPException(404, "Script não encontrado")
    if 'titulo' in dados:
        novo = (dados['titulo'] or '').strip()
        if not novo:
            raise HTTPException(400, "O título não pode ficar vazio")
        item['titulo'] = novo[:120]
    if 'descricao' in dados:
        item['descricao'] = (dados['descricao'] or '').strip()[:600]
    _salvar_index(itens)
    return {"ok": True, "item": item}


@router.delete("/{item_id}")
def remover(item_id: str, _: models.Usuario = Depends(require_admin)):
    """Tira o script da biblioteca."""
    itens = _ler_index()
    item = next((i for i in itens if i['id'] == item_id), None)
    if not item:
        raise HTTPException(404, "Script não encontrado")
    try:
        os.remove(os.path.join(DATA_DIR, item['arquivo']))
    except OSError:
        pass
    _salvar_index([i for i in itens if i['id'] != item_id])
    return {"ok": True}
