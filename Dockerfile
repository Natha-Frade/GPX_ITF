# Dockerfile - GPX IMTRAFF no Railway com exiftool embutido.
# O Railway detecta este arquivo na raiz do repo e usa no build.
# O exiftool é um programa Perl multiplataforma: a versão .exe do
# Windows tem equivalente Linux (pacote libimage-exiftool-perl).

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
