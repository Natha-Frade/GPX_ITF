# Arquitetura — GPX IMTRAFF + Editor de Vídeo

Este repositório junta dois projetos que antes eram separados:

- **App web GPX IMTRAFF** (Railway) — FastAPI + frontend estático (JS
  vanilla), login JWT, conversão GoPro→GPX, integração SharePoint.
- **Editor de vídeo multi-trilha** (antes `main_Local`, um projeto Vue que
  rodava com backend local + ffmpeg no PC) — agora **roda 100% no
  navegador** e vive dentro do app, na aba **🎞 EDITOR**.

## Mapa do repositório

```
GPX_ITF/
├── app/                      # backend FastAPI (inalterado + 1 router novo)
│   ├── main.py               # monta /editor e registra o router novo
│   └── routers/
│       ├── sharepoint.py         # (existente) conversão em lote
│       └── sharepoint_media.py   # (NOVO) streaming/GPS/corte p/ o editor
├── static/                   # frontend do app
│   ├── index.html            # aba EDITOR aponta para /editor/
│   ├── editor-classico.html  # editor antigo (ffmpeg.wasm) — mantido
│   └── editor/               # BUILD do editor novo (gerado pelo Vite)
├── editor-src/               # CÓDIGO-FONTE do editor (Vue) — dev aqui
│   ├── src/
│   │   ├── components/        # PlayerPane, MapPane, TimelinePane, MediaPool, ExportPane
│   │   ├── stores/edl.js      # estado da edição (EDL v2) + undo/redo
│   │   └── services/          # o "motor" (veja abaixo)
│   └── vite.config.js         # base '/editor/', build -> ../static/editor
├── Dockerfile                # multi-stage: node (build) + python (+ffmpeg)
└── docs/
```

## Por que o editor ficou rápido

O gargalo do editor antigo era **re-encode na CPU** (libx264). O CapCut é
rápido porque usa a **GPU** (NVENC). Como tudo tem que rodar no navegador
(sem agente local), o editor usa duas técnicas:

1. **Stream copy** (`ffmpeg.wasm -c copy`) — quando os trechos só são
   cortados e emendados, sem sobreposição e com o mesmo codec, **não há
   re-encode**. Um vídeo de 11 GB sai em ~1–2 min, com qualidade idêntica
   à original. É o caminho da maioria das edições de vistoria.

2. **WebCodecs** (decode/encode por **hardware**, o mesmo que o CapCut Web
   usa) — quando há composição de verdade (trilhas sobrepostas, espaços a
   manter, codecs diferentes). A GPU do PC faz o trabalho pesado.

O motor escolhe o caminho sozinho (`services/export/plan.js`) e mostra qual
vai usar antes de exportar.

## O motor de exportação (`editor-src/src/services/`)

| arquivo | papel |
|---|---|
| `probe.js` | lê metadados do MP4 (codec, fps, moov) **sem carregar o arquivo** — só o box `moov` (uns MB, mesmo num vídeo de 11 GB) |
| `gpmf.js` | extrai o GPS da GoPro (GPS5/GPS9) lendo o arquivo em pedaços de 2 MB |
| `sources.js` | registro de fontes: `File` local (objectURL) ou item do SharePoint (streaming). Guarda GPS e thumbnail |
| `thumbs.js` | miniatura via `<canvas>` |
| `export/plan.js` | **decide o modo**: `copy` / `webcodecs` / `remote` |
| `export/ffmpeg.js` | corte `-c copy`, mix de áudio e mux final (ffmpeg.wasm) |
| `export/webcodecs.js` | composição multi-trilha na GPU (decode→canvas→encode) |
| `export/gpx.js` | remapeia os pontos GPS pro tempo do vídeo exportado |
| `export/index.js` | orquestra tudo e devolve `{videoBlob, gpxText, points}` |

## Como o GPS nunca quebra

Regra de ouro: **o GPX segue o que o vídeo mostra**.

- No `copy`, o corte por stream copy alinha ao keyframe (o trecho real fica
  um fio maior que o pedido). Por isso cada pedaço é **medido depois de
  cortado** e os pontos são remapeados pela duração real, ancorados no
  ponto de saída.
- No `webcodecs`, o corte é frame-exato; o GPS de cada instante vem do
  segmento de **z mais alto** (o que aparece por cima), igual à regra de
  composição do editor.

## Fluxo do SharePoint (sem baixar o vídeo)

```
navegador                     backend (FastAPI)              Microsoft Graph
   │  POST /listar ─────────────►  resolve link, lista ──────►  /shares, /children
   │  <video src=/stream/…> ────►  307 redirect ────────────►  downloadUrl (Range)
   │  (streaming direto da Microsoft, sem passar bytes pelo servidor)
   │  POST /cortar ─────────────►  ffmpeg -c copy da URL ────►  baixa só os trechos
   │  ◄─── mp4 + X-Duracoes ─────
```

Enquanto a TI não configurar as credenciais do Azure, todas as rotas do
SharePoint respondem **503 com instruções** e a seção some da interface.
