import os, hashlib
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from . import models, schemas
from .database import get_db

SECRET_KEY   = os.getenv("SECRET_KEY", "troque-esta-chave-no-railway")
ALGORITMO    = "HS256"
VALIDADE_DIAS = 30
MAX_USUARIOS  = 10   # limite de usuários cadastrados

router   = APIRouter(prefix="/auth", tags=["Auth"])
security = HTTPBearer(auto_error=False)


def hash_senha(senha: str) -> str:
    return bcrypt.hashpw(senha.encode(), bcrypt.gensalt()).decode()

def verificar_senha(senha: str, senha_hash: str) -> bool:
    try:
        return bcrypt.checkpw(senha.encode(), senha_hash.encode())
    except Exception:
        return False

def criar_token(usuario_id: int) -> str:
    payload = {
        "sub": str(usuario_id),
        "exp": datetime.now(timezone.utc) + timedelta(days=VALIDADE_DIAS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITMO)

def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def get_usuario_atual(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> models.Usuario:
    if not credentials:
        raise HTTPException(401, "Não autenticado")
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITMO])
        usuario_id = int(payload["sub"])
    except Exception:
        raise HTTPException(401, "Sessão inválida ou expirada")

    usuario = db.get(models.Usuario, usuario_id)
    if not usuario or not usuario.ativo:
        raise HTTPException(401, "Usuário não encontrado ou desativado")

    # Atualiza último acesso e ping da sessão
    now = datetime.now(timezone.utc)
    usuario.ultimo_acesso = now
    th = token_hash(credentials.credentials)
    sessao = db.query(models.Sessao).filter_by(token_hash=th, expirado=False).first()
    if sessao:
        sessao.ultimo_ping = now
    db.commit()

    return usuario


def require_admin(usuario: models.Usuario = Depends(get_usuario_atual)) -> models.Usuario:
    if not usuario.is_admin:
        raise HTTPException(403, "Acesso restrito a administradores")
    return usuario


# ── Endpoints de autenticação ─────────────────────────────────────────

@router.post("/login", response_model=schemas.TokenOut)
def login(dados: schemas.LoginIn, db: Session = Depends(get_db)):
    usuario = db.query(models.Usuario).filter(
        models.Usuario.nome.ilike(dados.nome.strip())
    ).first()
    if not usuario or not verificar_senha(dados.senha, usuario.senha_hash):
        raise HTTPException(401, "Nome ou senha incorretos")
    if not usuario.ativo:
        raise HTTPException(403, "Conta desativada")

    token = criar_token(usuario.id)
    th    = token_hash(token)

    # Registra sessão
    sessao = models.Sessao(usuario_id=usuario.id, token_hash=th)
    db.add(sessao)
    usuario.ultimo_acesso = datetime.now(timezone.utc)
    db.commit()

    return {"token": token, "nome": usuario.nome, "is_admin": usuario.is_admin}


@router.post("/logout")
def logout(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
):
    if credentials:
        th = token_hash(credentials.credentials)
        sessao = db.query(models.Sessao).filter_by(token_hash=th).first()
        if sessao:
            sessao.expirado = True
            db.commit()
    return {"ok": True}


@router.get("/me", response_model=schemas.UsuarioOut)
def me(usuario: models.Usuario = Depends(get_usuario_atual)):
    return usuario
