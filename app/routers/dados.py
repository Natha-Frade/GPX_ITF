from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from .. import models, schemas
from ..database import get_db
from ..auth import get_usuario_atual

router = APIRouter(tags=["Dados"])


# ── Marcações ─────────────────────────────────────────────────────────

@router.get("/marcacoes", response_model=List[schemas.MarcacaoOut])
def listar_marcacoes(
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    return db.query(models.Marcacao).filter_by(usuario_id=usuario.id).order_by(models.Marcacao.criado_em).all()


@router.post("/marcacoes", response_model=schemas.MarcacaoOut)
def criar_marcacao(
    dados: schemas.MarcacaoIn,
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    m = models.Marcacao(**dados.model_dump(), usuario_id=usuario.id)
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


@router.put("/marcacoes/{mid}", response_model=schemas.MarcacaoOut)
def atualizar_marcacao(
    mid: int,
    dados: schemas.MarcacaoIn,
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    m = db.query(models.Marcacao).filter_by(id=mid, usuario_id=usuario.id).first()
    if not m:
        raise HTTPException(404, "Marcação não encontrada")
    for k, v in dados.model_dump().items():
        setattr(m, k, v)
    db.commit()
    db.refresh(m)
    return m


@router.delete("/marcacoes/{mid}")
def deletar_marcacao(
    mid: int,
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    m = db.query(models.Marcacao).filter_by(id=mid, usuario_id=usuario.id).first()
    if not m:
        raise HTTPException(404, "Marcação não encontrada")
    db.delete(m)
    db.commit()
    return {"ok": True}


@router.delete("/marcacoes")
def limpar_marcacoes(
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    db.query(models.Marcacao).filter_by(usuario_id=usuario.id).delete()
    db.commit()
    return {"ok": True}


# ── Cortes ────────────────────────────────────────────────────────────

@router.get("/cortes", response_model=List[schemas.CorteOut])
def listar_cortes(
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    return db.query(models.Corte).filter_by(usuario_id=usuario.id).order_by(models.Corte.criado_em).all()


@router.post("/cortes", response_model=schemas.CorteOut)
def salvar_corte(
    dados: schemas.CorteIn,
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    c = models.Corte(**dados.model_dump(), usuario_id=usuario.id)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


@router.delete("/cortes/{cid}")
def deletar_corte(
    cid: int,
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    c = db.query(models.Corte).filter_by(id=cid, usuario_id=usuario.id).first()
    if not c:
        raise HTTPException(404, "Corte não encontrado")
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.delete("/cortes")
def limpar_cortes(
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    db.query(models.Corte).filter_by(usuario_id=usuario.id).delete()
    db.commit()
    return {"ok": True}


# ── Config ────────────────────────────────────────────────────────────

@router.get("/config", response_model=schemas.ConfigOut)
def get_config(
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    c = db.query(models.ConfigUsuario).filter_by(usuario_id=usuario.id).first()
    if not c:
        return schemas.ConfigOut()
    return c


@router.put("/config", response_model=schemas.ConfigOut)
def salvar_config(
    dados: schemas.ConfigIn,
    db: Session = Depends(get_db),
    usuario: models.Usuario = Depends(get_usuario_atual),
):
    c = db.query(models.ConfigUsuario).filter_by(usuario_id=usuario.id).first()
    if not c:
        c = models.ConfigUsuario(usuario_id=usuario.id)
        db.add(c)
    for k, v in dados.model_dump().items():
        setattr(c, k, v)
    db.commit()
    db.refresh(c)
    return c
