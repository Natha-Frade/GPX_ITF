# GoPro → GPX na web — o que mudou e como publicar

## Arquivos deste pacote

| Arquivo | Ação no GitHub | O que faz |
|---|---|---|
| `Dockerfile` | **CRIAR** na raiz do repo | Instala o exiftool (versão Linux) dentro do container do Railway |
| `static/js/batch-browser.js` | **CRIAR** | Novo modo de conversão 100% no navegador (sem upload) |
| `static/js/batch.js` | **SUBSTITUIR** | Registra o novo modo "Navegador" |
| `static/index.html` | **SUBSTITUIR** | Botão + painel do modo "Navegador"; carrega gpmf.js e batch-browser.js |
| `app/routers/sharepoint.py` | **CRIAR** | Rota opcional: link de pasta do SharePoint direto no servidor (Graph API) |
| `app/main.py` | **SUBSTITUIR** | Registra o roteador do SharePoint |

## Como publicar (GitHub web editor → Railway)

1. Suba os 6 arquivos nos caminhos indicados acima no repo `GPX_ITF`.
2. Commit → o Railway detecta o `Dockerfile` na raiz automaticamente e
   passa a usá-lo no build (pode apagar o `Procfile` ou deixar; com
   Dockerfile presente ele é ignorado).
3. Após o deploy, teste `GET /api/gopro/status` logado — deve mostrar
   `disponivel: true` com a versão do exiftool.

## Os 3 caminhos que agora existem

### 1. Modo "Navegador" ⚡ (recomendado para o dia a dia)
- Aba GoPro → botão **Navegador** → Selecionar pasta → CONVERTER TUDO.
- Os MP4 **nunca saem do computador**: o gpmf.js lê em chunks de 2 MB
  e extrai só o GPS. Um lote de 50 GB converte sem tráfego de rede.
- **SharePoint**: sincronize a biblioteca pelo OneDrive (botão
  "Sincronizar" no SharePoint) e selecione a pasta sincronizada.
  O OneDrive baixa sob demanda os arquivos que o navegador pedir.
- Requer Chrome ou Edge para o seletor de pasta nativo (nos demais
  navegadores cai num seletor alternativo).

### 2. exiftool na nuvem (Dockerfile)
- Com o deploy, os modos "Arrastar ZIP" e "Link do Drive" que já
  existiam passam a funcionar no Railway.
- Limitação real: os vídeos precisam SUBIR para o servidor. Bom para
  lotes pequenos; para 20+ GB use o modo Navegador.
- O modo "Pasta local" continua fazendo sentido só quando o servidor
  roda na sua máquina (uso local, como hoje).

### 3. Link de pasta do SharePoint no servidor (opcional)
- Rota nova: `POST /api/sharepoint/converter {"link": "...", "um_hz": true}`.
- A Graph API da Microsoft NÃO baixa pasta como zip — o servidor lista
  e baixa vídeo por vídeo, converte e devolve o zip dos GPX.
- **Depende da TI**: registrar um app no Azure AD (Entra ID) com
  permissão de aplicativo `Files.Read.All` + consentimento do admin,
  e configurar no Railway: `MS_TENANT_ID`, `MS_CLIENT_ID`,
  `MS_CLIENT_SECRET`. Sem isso a rota responde 503 explicando.
- `GET /api/sharepoint/status` diz se está configurado.

## Observações técnicas

- O `exiftool.exe` do Windows não roda no Railway (Linux) — por isso o
  Dockerfile instala o pacote `libimage-exiftool-perl` (mesmo programa,
  versão Linux). Seu `EXIFTOOL_PATH`/detecção via PATH já o encontra.
- O modo Navegador aplica a mesma decimação 1 ponto/seg quando a caixa
  "1 ponto/seg" está marcada, para manter os GPX equivalentes aos do
  exiftool.
- O gpmf.js atual lê o stream **GPS5** (HERO11 testada por você). Se a
  equipe adotar HERO13 (que gravam só **GPS9**), me avise que a gente
  adiciona o parser GPS9 no mesmo arquivo.

---

# ATUALIZAÇÃO 2 — Vídeo, Street View e mapa

## Novos arquivos / substituições (além dos anteriores)

| Arquivo | Ação | O que faz |
|---|---|---|
| `static/js/video-export.js` | **CRIAR** | Corte e junção de MP4 no navegador (ffmpeg.wasm, sem re-encode) |
| `static/js/video.js` | **SUBSTITUIR** | Exportar cortes em MP4, juntar vídeos, sincronia GPX↔vídeo, correção do bug de offset |
| `static/js/cut.js` | **SUBSTITUIR** | Corte no GPX espelha automaticamente na timeline do vídeo |
| `static/js/streetview.js` | **SUBSTITUIR** | Modo "percurso": anda pela trilha dentro do Street View (estilo Earth) |
| `static/js/map.js` | **SUBSTITUIR** | Escala métrica, satélite híbrido com nomes de rodovias, tela cheia, clique-direito → Street View |
| `static/index.html` | **SUBSTITUIR** | Botões e seções novas (já inclui as mudanças da aba GoPro) |

## O que ficou possível

**Vídeo — cortar e baixar de verdade.** Na aba Vídeo, defina os cortes na
timeline e use "🎬 Exportar VÍDEOS dos Cortes (MP4)". O corte roda no seu
navegador com ffmpeg em WebAssembly, usando stream copy: sem re-encode,
sem perda de qualidade, rápido. Limitações honestas: o ponto de corte
alinha ao keyframe anterior (~1s de folga na GoPro) e cada trecho
exportado precisa caber na memória do navegador (~1.5 GB por trecho —
o vídeo de ENTRADA pode ter qualquer tamanho, ele é montado, não copiado).
Na primeira utilização baixa o motor (~31 MB, fica em cache).

**Sincronia bidirecional GPX ↔ vídeo (por tempo).**
- GPX → vídeo: com um vídeo vinculado, todo corte salvo na aba CORTAR GPX
  aparece automaticamente na timeline do vídeo (mesma janela de tempo).
- Vídeo → GPX: já existia ("Exportar GPXs dos Cortes") e foi CORRIGIDA:
  o filtro de pontos não considerava o offset de sincronização.
- "Exportar GPX + MP4 de tudo" baixa os pares de uma vez.

**Juntar vídeos.** Seção nova na aba Vídeo: selecione os capítulos
(GX010001 + GX020001...) e ele une em um MP4 só, sem re-encode. A ordem
segue o nome dos arquivos.

**Street View "modo Earth".** Botão 🚗 no mapa (ou clique DIREITO sobre a
trilha): abre o Street View no ponto mais próximo, orientado no sentido
do tráfego, com controles ◀ ▶ para andar ~25 m por passo e ⏯ Tour
automático. Requer a API key no js/config.js (instruções lá). Custo:
cada panorama conta na cota do Google (~US$ 14/1000 após o crédito
gratuito de US$ 200/mês) — o tour é limitado a 1 pano/1,5 s por isso.

**Mapa.** Escala métrica no canto; satélite agora é HÍBRIDO (nomes de
rodovias e cidades por cima da imagem — as BR-xxx aparecem); botão ⛶ de
tela cheia; Ctrl+clique copia a coordenada do cursor.

---

# ATUALIZAÇÃO 3 — Editor de Vídeo funcionando

## Diagnóstico
A aba "🎞 EDITOR" apontava para `editor.html`, que NÃO EXISTIA no repo —
por isso dava erro. O JavaScript do editor (`editor-page.js`, 844 linhas,
estilo CapCut) já estava pronto; faltava a página.

## Arquivos desta atualização

| Arquivo | Ação | O que faz |
|---|---|---|
| `static/editor.html` | **CRIAR** | A página do editor (biblioteca, player, timeline, painéis) |
| `static/js/editor-ffmpeg.js` | **CRIAR** | Exportação real: segmentos sem re-encode + timeline inteira → 1 MP4 |
| `static/js/editor-page.js` | **SUBSTITUIR** | Correção de bug no tratamento de erro do GPS |
| `static/js/video-export.js` | **SUBSTITUIR** | Fallback de CDN (unpkg → jsdelivr) p/ redes corporativas |
| `static/index.html` | **SUBSTITUIR** | Seção "Juntar Vídeos" removida da aba Vídeo (foi para o Editor) |

## O Editor (estilo CapCut)
- **Biblioteca**: arraste vários MP4/MOV; miniaturas automáticas.
- **Player**: atalhos Espaço (play), C (corta), ←→ (frame), Ctrl←→ (1s),
  Shift←→ (10s), J/L (−/+10s), Home/End.
- **Timeline**: adicione clipes com "+", arraste as BORDAS para aparar,
  zoom de 4 a 200 px/s, régua clicável, playhead.
- **Cortes**: "✂ Cortar aqui" marca divisões no clipe ativo; o painel
  SEGMENTOS lista os trechos com pré-view (▶) e download (↓) —
  agora cortados com ffmpeg SEM re-encode (antes era MediaRecorder,
  que regravava em tempo real com perda).
- **🎞 Timeline inteira → 1 MP4**: apara cada clipe conforme os handles
  e concatena tudo na ordem — é o "juntar vídeos", só que melhor,
  porque você escolhe ordem e aparas. Requer clipes do mesmo formato
  (capítulos GoPro: perfeito).
- **GPS → GPX**: continua no editor (gpmf.js), por clipe ou em lote.

## Sobre "Juntar Vídeos" não ter funcionado
Causa mais provável: a rede bloqueando o CDN unpkg.com (o motor ffmpeg
não baixava). O loader agora tenta unpkg e depois cdn.jsdelivr.net e,
se ambos falharem, mostra mensagem clara em vez de falhar em silêncio.
Se ainda falhar, abra o console (F12) e verifique o erro de rede.

## Street View embutido — é possível?
SIM, e o app já suporta: o modal com o panorama real do Google (pegman,
360°, modo percurso 🚗) funciona assim que você colar uma API key do
Google Cloud no `static/js/config.js` (instruções passo a passo estão
comentadas no próprio arquivo — leva ~10 min, cartão necessário, mas o
crédito gratuito de US$ 200/mês cobre o uso interno). SEM key, é
tecnicamente impossível embutir o Street View do Google (os termos de
uso proíbem iframe/scraping) — por isso o fallback atual abre em nova
aba. Alternativa 100% gratuita: Mapillary (imagens de rua colaborativas,
com SDK embutível) — cobertura em rodovias federais é irregular, mas
existe. Se quiser, é uma integração futura.
