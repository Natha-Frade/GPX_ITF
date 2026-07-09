# ══════════════════════════════════════════════════════════════════════
#  Dockerfile — GPX IMTRAFF no Railway COM exiftool embutido
#
#  O Railway detecta este arquivo automaticamente (nome "Dockerfile",
#  na raiz do repo) e passa a usá-lo no lugar do nixpacks.
#
#  O exiftool é um programa Perl multiplataforma — a versão .exe que
#  você usa no Windows tem equivalente Linux instalável via apt.
#  Depois deste deploy, as rotas /api/gopro/status, /converter-zip e
#  /converter-drive funcionam direto na nuvem.
# ══════════════════════════════════════════════════════════════════════

FROM python:3.12-slim

# exiftool (pacote Debian: libimage-exiftool-perl) + limpeza do cache apt
RUN apt-get update && \
    apt-get install -y --no-install-recommends libimage-exiftool-perl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependências Python primeiro (aproveita cache de camadas)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Código do app
COPY . .

# Railway injeta $PORT em runtime
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
