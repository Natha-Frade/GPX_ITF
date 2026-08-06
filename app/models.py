from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, Float, ForeignKey, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .database import Base


class Usuario(Base):
    __tablename__ = "usuarios"
    id            = Column(Integer, primary_key=True)
    nome          = Column(String(50), unique=True, nullable=False)
    senha_hash    = Column(String(200), nullable=False)
    is_admin      = Column(Boolean, default=False)
    ativo         = Column(Boolean, default=True)
    criado_em     = Column(DateTime, server_default=func.now())
    ultimo_acesso = Column(DateTime, nullable=True)

    sessoes  = relationship("Sessao",  back_populates="usuario", cascade="all, delete")
    marcacoes = relationship("Marcacao", back_populates="usuario", cascade="all, delete")
    cortes   = relationship("Corte",   back_populates="usuario", cascade="all, delete")
    configs  = relationship("ConfigUsuario", back_populates="usuario", cascade="all, delete", uselist=False)


class Sessao(Base):
    """Rastreia tokens ativos para saber quem está online."""
    __tablename__ = "sessoes"
    id          = Column(Integer, primary_key=True)
    usuario_id  = Column(Integer, ForeignKey("usuarios.id"), nullable=False)
    token_hash  = Column(String(64), unique=True, nullable=False)  # SHA256 do JWT
    criado_em   = Column(DateTime, server_default=func.now())
    ultimo_ping = Column(DateTime, server_default=func.now())      # atualizado a cada request
    expirado    = Column(Boolean, default=False)

    usuario = relationship("Usuario", back_populates="sessoes")


class Marcacao(Base):
    """Pins/anotações do usuário no mapa."""
    __tablename__ = "marcacoes"
    id         = Column(Integer, primary_key=True)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False)
    label      = Column(String(200), nullable=False)
    lat        = Column(Float, nullable=False)
    lng        = Column(Float, nullable=False)
    color      = Column(String(20), default="#73b753")
    category   = Column(String(50), default="Geral")
    note       = Column(Text, default="")
    criado_em  = Column(DateTime, server_default=func.now())

    usuario = relationship("Usuario", back_populates="marcacoes")


class Corte(Base):
    """Cortes de GPX salvos pelo usuário."""
    __tablename__ = "cortes"
    id         = Column(Integer, primary_key=True)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False)
    nome       = Column(String(200), nullable=False)
    km_inicio  = Column(Float, nullable=True)
    km_fim     = Column(Float, nullable=True)
    distancia  = Column(Float, nullable=True)   # km
    n_pontos   = Column(Integer, nullable=True)
    gpx_nome   = Column(String(200), nullable=True)  # nome do arquivo original
    # Pontos do trecho como JSON [{lat, lng, ele, time}, ...]
    pontos     = Column(JSON, nullable=False, default=list)
    criado_em  = Column(DateTime, server_default=func.now())

    usuario = relationship("Usuario", back_populates="cortes")


class ConfigUsuario(Base):
    """Última configuração do usuário (KM offset, direção, etc.)."""
    __tablename__ = "config_usuario"
    id              = Column(Integer, primary_key=True)
    usuario_id      = Column(Integer, ForeignKey("usuarios.id"), unique=True, nullable=False)
    km_offset_int   = Column(Integer, default=0)
    km_offset_dec   = Column(Integer, default=0)
    km_direction    = Column(Integer, default=1)   # 1 = crescente, -1 = decrescente
    mapa_lat        = Column(Float, nullable=True)
    mapa_lng        = Column(Float, nullable=True)
    mapa_zoom       = Column(Integer, nullable=True)
    atualizado_em   = Column(DateTime, server_default=func.now(), onupdate=func.now())

    usuario = relationship("Usuario", back_populates="configs")
