# GPX IMTRAFF

Plataforma web da IMTRAFF para vistoria rodoviária: converte vídeo GoPro em
GPX, edita vídeo com o GPS junto, marca e mede trechos no mapa e valida os
lotes de campo contra o KMZ e a planilha de controle.

Roda no navegador — o vídeo, que é a parte pesada, nunca precisa subir para
o servidor.

---

## O que dá para fazer

| Aba | Para quê |
|---|---|
| **CORTAR GPX** | Corta a trilha por km ou por seleção no mapa; cada corte vira um arquivo |
| **UNIR GPX** | Junta vários GPX (capítulos GoPro, por exemplo) numa trilha só |
| **MARCAÇÕES** | Pinos e **trechos contínuos** que seguem a linha da via, com km em formato estaca (ex.: `230+515 → 245+980`); exporta CSV/KML |
| **VÍDEO + GPX** | Vincula o vídeo à trilha, corta os dois em sincronia e exporta os pares |
| **GOPRO → GPX (LOTE)** | Converte pastas inteiras de MP4 em GPX |
| **🎞 EDITOR** | Editor multi-trilha estilo CapCut, com mapa e GPX sincronizados |
| **VALIDAÇÃO** | Confere o lote de campo contra o KMZ dos dispositivos e a planilha |

### GoPro → GPX: três caminhos

1. **Navegador** (recomendado) — selecione a pasta e converta. Os MP4 **não
   saem do computador**: o app lê o arquivo em pedaços de 2 MB e extrai só o
   GPS. Um lote de 50 GB converte sem tráfego de rede. Para arquivos do
   SharePoint, sincronize a biblioteca pelo OneDrive e aponte para a pasta
   sincronizada. Precisa de Chrome ou Edge para o seletor de pasta nativo.
2. **ZIP ou link do Drive** — o servidor converte com o exiftool. Bom para
   lotes pequenos; os vídeos precisam subir.
3. **Link de pasta do SharePoint** — o servidor lista e converte item a item
   pela Graph API. Depende da TI configurar o Azure AD
   (ver `docs/SHAREPOINT_TI.md`).

### Editor de vídeo

Roda 100% no navegador e escolhe sozinho o caminho mais rápido:

- **Stream copy** quando os trechos são só cortados e emendados — **sem
  re-encode**, qualidade idêntica à original, um vídeo de 11 GB sai em
  ~1–2 min. É o caso da maioria das edições de vistoria.
- **WebCodecs** (decode/encode por hardware, o mesmo que o CapCut Web usa)
  quando há composição de verdade: trilhas sobrepostas, codecs diferentes.

O modo escolhido aparece na tela antes de exportar.

**O GPX acompanha o corte automaticamente** — o GPS nunca fica fora de
sincronia com o vídeo exportado. No stream copy o corte alinha ao keyframe
anterior (~1 s de folga na GoPro), então cada trecho é medido depois de
cortado e os pontos são remapeados pela duração real.

Dá para editar vídeo do SharePoint por streaming, sem baixar o arquivo,
quando as credenciais estiverem configuradas.

### Validação de campo

Identifica **por coordenada** qual dispositivo do KMZ cada GPX cobre, cruza
com a planilha de controle (a fonte da verdade), calcula a cobertura de cada
corte e gera a nomenclatura padrão dos arquivos. Devolve o lote renomeado em
ZIP, mais a lista de não identificados e duplicatas.

---

## Desenvolvimento

```bash
# backend
pip install -r requirements.txt
uvicorn app.main:app --reload            # http://localhost:8000
```

```bash
# editor de vídeo (hot reload; /api/* faz proxy para o :8000)
cd editor-src
npm install
npm run dev                              # http://localhost:5173
```

Para testar o editor servido pelo backend, como em produção:

```bash
cd editor-src && npm run build           # gera static/editor
```

> Mexeu em `editor-src/`? Rode o `build` antes de commitar — ou deixe o
> Dockerfile fazer isso no deploy. Escolham um dos dois e mantenham a equipe
> alinhada.

O frontend das outras abas é JS puro em `static/js/`, sem build: edite e dê
F5. As bibliotecas ficam em `static/vendor/` (não em CDN) porque a rede
corporativa costuma bloquear unpkg e jsdelivr.

### Teste rápido do motor de validação

```bash
python teste_local.py <kmz> <planilha.xlsx> <lote.zip>
```

---

## Configuração

Variáveis de ambiente (todas opcionais em dev):

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Banco. Sem ela, usa SQLite local (`gpx_imtraff.db`) |
| `SECRET_KEY` | Assinatura do JWT — **troque em produção** |
| `ADMIN_NOME` / `ADMIN_SENHA` | Admin criado no primeiro boot |
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | SharePoint (Graph API) |
| `EXIFTOOL_PATH` | Caminho do exiftool, se não estiver no PATH |
| `VALIDACAO_DATA_DIR` | Onde ficam o KMZ e a planilha de referência |

Sem as credenciais da Microsoft, as rotas do SharePoint respondem 503 com
instruções e a seção some da interface — o resto do app funciona normalmente.

O Street View embutido precisa de uma API key do Google em
`static/js/config.js` (o passo a passo está comentado no próprio arquivo).
Sem key, os botões abrem o Google Maps em nova aba.

---

## Deploy (Railway)

Push na `main` → deploy automático. O `Dockerfile` é multi-stage: o estágio
Node compila o editor com o Vite, e o estágio Python sobe o backend com
exiftool e ffmpeg instalados. O `Procfile` fica ignorado enquanto houver
Dockerfile.

As referências da validação (KMZ e planilha) ficam em disco e se perdem num
redeploy — é só reenviar pela interface.

---

## Documentação técnica

- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — como as peças se encaixam e por que o editor ficou rápido
- [`docs/COLABORACAO.md`](docs/COLABORACAO.md) — rodar em dev, dividir módulos e fluxo Git
- [`docs/SHAREPOINT_TI.md`](docs/SHAREPOINT_TI.md) — passo a passo do Azure AD para a TI

O editor anterior continua acessível em `/editor-classico.html`.
