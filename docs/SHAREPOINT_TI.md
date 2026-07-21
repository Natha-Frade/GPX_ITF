# Configuração do SharePoint (para a TI)

O editor pode abrir e cortar vídeos direto do SharePoint **sem baixá-los no
navegador**. Para isso, o backend precisa falar com o Microsoft Graph usando
um aplicativo registrado no Azure AD (Entra ID). Enquanto isso não estiver
feito, a integração fica **desativada** (as rotas respondem 503 e a seção
"☁ SharePoint" não aparece no editor) — o resto do sistema funciona normal.

Isto é uma configuração **única**. Precisa de um administrador do Entra ID.

## Passo a passo

1. **Portal do Azure** → *Microsoft Entra ID* → *App registrations* → *New
   registration*.
   - Nome: `GPX IMTRAFF - Editor` (ou o que preferir).
   - Supported account types: *Single tenant*.
   - *Register*.

2. Na página do app, anote:
   - **Application (client) ID** → será `MS_CLIENT_ID`
   - **Directory (tenant) ID** → será `MS_TENANT_ID`

3. **Certificates & secrets** → *New client secret* → defina validade →
   copie o **Value** (aparece uma vez só) → será `MS_CLIENT_SECRET`.

4. **API permissions** → *Add a permission* → *Microsoft Graph* →
   **Application permissions** (não "Delegated") → adicione:
   - `Files.Read.All`
   - (se os vídeos estiverem em sites do SharePoint) `Sites.Read.All`

5. **Grant admin consent** (botão na mesma tela). Sem o consentimento do
   admin, o Graph recusa a autenticação.

## Configurar no Railway

No projeto do Railway → *Variables* → adicione:

```
MS_TENANT_ID     = <Directory (tenant) ID>
MS_CLIENT_ID     = <Application (client) ID>
MS_CLIENT_SECRET = <secret Value>
```

Salvar dispara um novo deploy. Para conferir, um usuário logado pode abrir:

```
GET /api/sharepoint/media/status   →   {"ok": true}
```

Se vier `{"ok": false, "motivo": "..."}`, o motivo indica o que falta
(credenciais ou ffmpeg).

## Segurança — o que este app faz e o que não faz

- Permissão **somente leitura** (`Files.Read.All`) — o app nunca escreve
  nem apaga nada no SharePoint.
- O vídeo **não trafega pelo servidor** ao tocar: o backend devolve um
  redirect para a URL temporária e pré-autenticada do próprio Graph, e o
  navegador faz o streaming direto da Microsoft.
- No **corte**, o servidor lê apenas os trechos pedidos (via Range HTTP) e
  descarta os arquivos temporários ao terminar.
- O `client secret` fica só nas variáveis do Railway, nunca no código nem
  no navegador.

## Observação de capacidade

A extração de **GPS** de um vídeo remoto (`/gpx/...`) hoje baixa o arquivo
para um diretório temporário do servidor antes de rodar o exiftool, porque
o fluxo de metadados da GoPro fica espalhado pelo arquivo. Para lotes
grandes, continue usando a conversão em lote da aba principal
(`/api/sharepoint/converter`) ou a pasta sincronizada por OneDrive. O
**streaming** e o **corte** não têm esse custo.
