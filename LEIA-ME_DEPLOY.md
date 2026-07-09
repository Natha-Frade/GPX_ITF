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
