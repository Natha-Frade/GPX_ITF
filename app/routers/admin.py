from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..auth import require_admin, hash_senha, MAX_USUARIOS

router = APIRouter(prefix="/admin", tags=["Admin"])

ONLINE_THRESHOLD = timedelta(minutes=5)  # considerado online se ping < 5 min atrás


# ── Usuários ──────────────────────────────────────────────────────────

@router.get("/usuarios", response_model=list[schemas.UsuarioOut])
def listar_usuarios(
    db: Session = Depends(get_db),
    _: models.Usuario = Depends(require_admin),
):
    return db.query(models.Usuario).order_by(models.Usuario.id).all()


@router.post("/usuarios", response_model=schemas.UsuarioOut)
def criar_usuario(
    dados: schemas.UsuarioCreate,
    db: Session = Depends(get_db),
    _: models.Usuario = Depends(require_admin),
):
    if db.query(models.Usuario).count() >= MAX_USUARIOS:
        raise HTTPException(400, f"Limite de {MAX_USUARIOS} usuários atingido")
    nome = dados.nome.strip()
    if db.query(models.Usuario).filter(models.Usuario.nome.ilike(nome)).first():
        raise HTTPException(400, "Já existe um usuário com esse nome")
    if len(dados.senha) < 4:
        raise HTTPException(400, "Senha precisa ter ao menos 4 caracteres")
    u = models.Usuario(nome=nome, senha_hash=hash_senha(dados.senha), is_admin=dados.is_admin)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@router.patch("/usuarios/{uid}", response_model=schemas.UsuarioOut)
def editar_usuario(
    uid: int,
    dados: schemas.UsuarioUpdate,
    db: Session = Depends(get_db),
    admin: models.Usuario = Depends(require_admin),
):
    u = db.get(models.Usuario, uid)
    if not u:
        raise HTTPException(404, "Usuário não encontrado")
    if dados.nome is not None:
        nome = dados.nome.strip()
        conflito = db.query(models.Usuario).filter(
            models.Usuario.nome.ilike(nome), models.Usuario.id != uid
        ).first()
        if conflito:
            raise HTTPException(400, "Nome já em uso")
        u.nome = nome
    if dados.senha is not None:
        if len(dados.senha) < 4:
            raise HTTPException(400, "Senha precisa ter ao menos 4 caracteres")
        u.senha_hash = hash_senha(dados.senha)
    if dados.is_admin is not None:
        # Não pode remover o próprio admin
        if u.id == admin.id and not dados.is_admin:
            raise HTTPException(400, "Você não pode remover seu próprio acesso admin")
        u.is_admin = dados.is_admin
    if dados.ativo is not None:
        if u.id == admin.id and not dados.ativo:
            raise HTTPException(400, "Você não pode desativar sua própria conta")
        u.ativo = dados.ativo
        if not dados.ativo:
            # Expira todas as sessões do usuário
            db.query(models.Sessao).filter_by(usuario_id=uid, expirado=False).update({"expirado": True})
    db.commit()
    db.refresh(u)
    return u


@router.delete("/usuarios/{uid}")
def deletar_usuario(
    uid: int,
    db: Session = Depends(get_db),
    admin: models.Usuario = Depends(require_admin),
):
    u = db.get(models.Usuario, uid)
    if not u:
        raise HTTPException(404, "Usuário não encontrado")
    if u.id == admin.id:
        raise HTTPException(400, "Você não pode deletar sua própria conta")
    db.delete(u)
    db.commit()
    return {"ok": True}


# ── Sessões / Online ──────────────────────────────────────────────────

@router.get("/online")
def usuarios_online(
    db: Session = Depends(get_db),
    _: models.Usuario = Depends(require_admin),
):
    limite = datetime.now(timezone.utc) - ONLINE_THRESHOLD
    sessoes = (
        db.query(models.Sessao)
        .filter(models.Sessao.expirado == False, models.Sessao.ultimo_ping >= limite)
        .all()
    )
    # Deduplica por usuário, mantendo o ping mais recente
    por_usuario: dict[int, dict] = {}
    for s in sessoes:
        uid = s.usuario_id
        if uid not in por_usuario or s.ultimo_ping > por_usuario[uid]["ultimo_ping"]:
            por_usuario[uid] = {
                "usuario_id": uid,
                "nome": s.usuario.nome,
                "ultimo_ping": s.ultimo_ping,
            }
    return list(por_usuario.values())


@router.delete("/sessoes/{uid}")
def encerrar_sessoes(
    uid: int,
    db: Session = Depends(get_db),
    _: models.Usuario = Depends(require_admin),
):
    """Expira todas as sessões de um usuário (força logout remoto)."""
    db.query(models.Sessao).filter_by(usuario_id=uid, expirado=False).update({"expirado": True})
    db.commit()
    return {"ok": True}


# ── Estatísticas gerais ───────────────────────────────────────────────

@router.get("/stats")
def stats(
    db: Session = Depends(get_db),
    _: models.Usuario = Depends(require_admin),
):
    limite = datetime.now(timezone.utc) - ONLINE_THRESHOLD
    online_ids = {
        s.usuario_id for s in db.query(models.Sessao).filter(
            models.Sessao.expirado == False, models.Sessao.ultimo_ping >= limite
        ).all()
    }
    return {
        "total_usuarios":  db.query(models.Usuario).count(),
        "usuarios_online": len(online_ids),
        "total_marcacoes": db.query(models.Marcacao).count(),
        "total_cortes":    db.query(models.Corte).count(),
    }
