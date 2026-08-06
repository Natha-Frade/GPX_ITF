from pydantic import BaseModel
from typing import Optional, List, Any
from datetime import datetime


# ── Auth ──────────────────────────────────────────────────────────────
class LoginIn(BaseModel):
    nome: str
    senha: str

class TokenOut(BaseModel):
    token: str
    nome: str
    is_admin: bool

class UsuarioOut(BaseModel):
    id: int
    nome: str
    is_admin: bool
    ativo: bool
    criado_em: datetime
    ultimo_acesso: Optional[datetime]
    class Config: from_attributes = True

class UsuarioCreate(BaseModel):
    nome: str
    senha: str
    is_admin: bool = False

class UsuarioUpdate(BaseModel):
    nome: Optional[str] = None
    senha: Optional[str] = None
    is_admin: Optional[bool] = None
    ativo: Optional[bool] = None

class SessaoOut(BaseModel):
    usuario_id: int
    nome: str
    ultimo_ping: datetime
    class Config: from_attributes = True


# ── Marcações ─────────────────────────────────────────────────────────
class MarcacaoIn(BaseModel):
    label: str
    lat: float
    lng: float
    color: str = "#73b753"
    category: str = "Geral"
    note: str = ""

class MarcacaoOut(MarcacaoIn):
    id: int
    criado_em: datetime
    class Config: from_attributes = True


# ── Cortes ────────────────────────────────────────────────────────────
class CorteIn(BaseModel):
    nome: str
    km_inicio: Optional[float] = None
    km_fim: Optional[float] = None
    distancia: Optional[float] = None
    n_pontos: Optional[int] = None
    gpx_nome: Optional[str] = None
    pontos: List[Any] = []

class CorteOut(CorteIn):
    id: int
    criado_em: datetime
    class Config: from_attributes = True


# ── Config ────────────────────────────────────────────────────────────
class ConfigIn(BaseModel):
    km_offset_int: int = 0
    km_offset_dec: int = 0
    km_direction: int = 1
    mapa_lat: Optional[float] = None
    mapa_lng: Optional[float] = None
    mapa_zoom: Optional[int] = None

class ConfigOut(ConfigIn):
    class Config: from_attributes = True
