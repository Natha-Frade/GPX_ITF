# Dockerfile — GPX IMTRAFF (Railway).
#
# Multi-stage:
#   1) node   -> compila o editor de vídeo (editor-src) com o Vite; a saída
#                cai em static/editor.
#   2) python -> backend FastAPI + exiftool (GPS GoPro) + ffmpeg (corte
#                server-side dos vídeos do SharePoint, sem re-encode).
#
# O editor em si roda no NAVEGADOR (ffmpeg.wasm + WebCodecs). O ffmpeg do
# servidor é usado só quando o vídeo vem do SharePoint por streaming.

# -- Estagio 1: build do editor -----------------------------------------
FROM node:20-slim AS editor
WORKDIR /editor
COPY editor-src/package.json editor-src/package-lock.json* ./
RUN npm ci || npm install
COPY editor-src/ ./
# gera static/editor (vite.config.js aponta outDir para ../static/editor)
RUN mkdir -p /out && npm run build && cp -r ../static/editor /out/editor

# -- Estagio 2: aplicacao -----------------------------------------------
FROM python:3.12-slim

# exiftool (GPS GoPro) + ffmpeg/ffprobe (corte do SharePoint) + limpeza
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libimage-exiftool-perl ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Codigo do app
COPY . .

# Editor ja compilado (vem do estagio node)
COPY --from=editor /out/editor ./static/editor

# Railway injeta $PORT em runtime
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
