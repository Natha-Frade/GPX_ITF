# Trabalho em dupla — módulos e Git

O código é modular de propósito: dá pra duas pessoas mexerem em partes
diferentes sem pisar uma na outra. Abaixo, uma divisão sugerida e o fluxo
de Git.

## Rodar em desenvolvimento

**Backend** (uma vez, na raiz):
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload            # http://localhost:8000
```

**Editor** (hot reload, noutra aba do terminal):
```bash
cd editor-src
npm install
npm run dev                              # http://localhost:5173
```
No modo `dev`, o Vite faz proxy de `/api/*` para o backend em `:8000`. Você
edita o Vue e a página recarrega sozinha. Para testar o editor **servido
pelo backend** (como em produção), rode `npm run build` e abra
`http://localhost:8000/editor/`.

## Divisão de módulos (baixo acoplamento)

Cada bloco conversa com os outros por uma interface pequena:

- **Pessoa A — motor de exportação** (`editor-src/src/services/export/`)
  Trabalha em `plan.js`, `ffmpeg.js`, `webcodecs.js`, `gpx.js`. Contrato:
  `runExport(edl, opts, cb)` devolve `{videoBlob, gpxText, points, mode,
  duration}`. Não precisa tocar em componentes.

- **Pessoa B — interface e timeline** (`editor-src/src/components/` +
  `stores/edl.js`)
  Player, mapa, timeline, biblioteca, painel de export. Consome o motor só
  pela função `runExport` e por `analyze`.

- **SharePoint / backend** (`app/routers/sharepoint_media.py`) é
  independente: quem mexe nele não precisa buildar o editor.

Regra prática: **mudou algo em `editor-src/`? rode `npm run build` antes de
commitar** (ou deixe o Dockerfile fazer no deploy — veja abaixo).

## O que versionar

O `.gitignore` já ignora:
- `editor-src/node_modules/` (reinstala com `npm install`)
- `static/editor/` (é **gerado** pelo build — no Railway, o Dockerfile
  builda; localmente, rode `npm run build`)
- `*.db` (banco local de dev)

> Se preferir **não** depender do build no deploy, remova `static/editor/`
> do `.gitignore` e commite a pasta buildada. Aí o Railway nem precisa do
> estágio node. Escolha um dos dois caminhos e mantenha a equipe alinhada.

## Fluxo Git recomendado

O repositório é `Natha-Frade/GPX_ITF`. Como já vimos que o OneDrive
atrapalha a sincronia, **clone fora do OneDrive** (ex.: `C:\dev\GPX_ITF`) e
sincronize entre as duas máquinas por push/pull, não pela pasta.

```bash
# uma branch por frente de trabalho
git checkout -b editor/export-webcodecs      # pessoa A
git checkout -b editor/timeline-ui           # pessoa B

# commits pequenos e frequentes
git add -A && git commit -m "export: mede duração real no corte copy"
git push -u origin editor/export-webcodecs

# abrir Pull Request no GitHub, revisar, e dar merge na main
```

Dicas para evitar conflito:
- Mantenha as branches curtas (menos de um dia de trabalho, se der).
- `git pull --rebase origin main` antes de abrir o PR.
- Conflitos quase sempre serão em `stores/edl.js` (estado compartilhado) —
  combinem quem mexe nele por vez.

## Deploy (Railway)

O Railway detecta o `Dockerfile` e faz o resto. O build multi-stage:
1. `node:20` compila o editor (`npm run build` → `static/editor`);
2. `python:3.12` instala o backend, o **exiftool** e o **ffmpeg**.

Push na `main` → deploy automático. As variáveis do SharePoint
(`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`) são configuradas no
painel do Railway — veja `docs/SHAREPOINT_TI.md`.
