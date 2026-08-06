# GPX IMTRAFF — Documentação Técnica

Guia para entender o sistema inteiro: o que ele faz, como está construído
e por que cada decisão foi tomada. Quem terminar de ler deve conseguir
explicar o projeto e mexer nele com segurança.

---

## 1. O que é

Ferramenta web para o trabalho de inspeção rodoviária: a equipe filma
trechos de rodovia com câmeras GoPro no carro, e depois precisa provar
**o que foi filmado, onde e em qual quilômetro**.

O sistema cobre o ciclo todo:

| etapa | o que resolve |
|---|---|
| **Extrair** | tira o GPS de dentro dos vídeos GoPro e gera GPX |
| **Cortar** | recorta trechos do GPX (e do vídeo junto) |
| **Unir** | junta pedaços de GPX num traçado só |
| **Marcar** | registra pontos e trechos sobre o mapa, com o km |
| **Validar** | cruza os GPX com a planilha de filmagem e diz o que faltou |
| **Editar** | monta o vídeo final numa timeline |

O conceito que amarra tudo é **quilometragem em formato estaca**
(`213+970` = km 213 + 970 metros), que é a linguagem do setor rodoviário.

---

## 2. Arquitetura em uma tela

```
NAVEGADOR (onde acontece o trabalho pesado)
├── index.html — 6 abas + mapa Leaflet
│   └── 19 arquivos JS, escopo global, carregados em ordem
│       ├── gpmf.js      lê o GPS de dentro do MP4
│       ├── kmz.js       lê os marcos de km do Google Earth
│       ├── kmcalc.js    converte coordenada → km
│       ├── cut / merge / points / segments / video …
│       └── video-export.js  ffmpeg.wasm (corta vídeo no navegador)
├── /editor/ — app Vue compilado à parte (timeline multi-trilha)
└── /validacao.html — tela do módulo de validação

        │ HTTP (JWT no header)
        ▼
SERVIDOR FastAPI (leve: guarda dados e serve arquivos)
├── auth        login, sessão, admin
├── dados       marcações, cortes e config do usuário
├── kmz_lib     biblioteca de KMZ da equipe
├── script_lib  biblioteca de scripts da equipe
├── gopro       conversão no servidor (opcional)
├── sharepoint  integração corporativa
└── validacao/  motor de cruzamento GPX × planilha
        │
        ▼
PostgreSQL (Railway) ou SQLite (local)
```

### A decisão central: processar no navegador

Vídeo e GPS são processados **no cliente**, não no servidor. Isso foi
escolhido de propósito:

- **Vídeo GoPro é enorme.** Subir arquivos de vários GB para depois baixar
  o resultado seria inviável na rede da empresa.
- **Privacidade e custo.** O material nem sai da máquina; o servidor
  continua barato porque não processa mídia.

O preço disso é que o `ffmpeg.wasm` é bem mais lento que o ffmpeg nativo —
o que dita várias decisões da parte de vídeo (§6).

---

## 3. Autenticação

JWT + registro de sessão no banco.

1. `POST /api/auth/login` valida a senha (bcrypt) e devolve um token.
2. O token vai no header `Authorization: Bearer …` a cada chamada.
3. O servidor guarda o **SHA-256** do token na tabela `sessoes` — nunca o
   token em si. Assim é possível invalidar sessões sem armazenar segredo.
4. `get_usuario_atual` protege rotas de usuário; `require_admin` protege
   as de administrador.

> **Ponto de segurança:** a separação admin/usuário é feita **no
> servidor**, não escondendo botões. Nas bibliotecas, um usuário comum
> recebe `403` mesmo se forjar a requisição — foi testado.

Um admin padrão é criado no primeiro start (`ADMIN_NOME` / `ADMIN_SENHA`,
default `admin` / `imtraff2024` — **troque em produção**, junto com
`SECRET_KEY`).

**Banco:** `Usuario`, `Sessao`, `Marcacao`, `Corte`, `ConfigUsuario`.
As bibliotecas de KMZ e scripts **não** usam banco (§7).

---

## 4. Extração de GPS do vídeo (`gpmf.js`) — a parte mais técnica

A GoPro grava telemetria numa faixa de dados dentro do MP4, no formato
**GPMF**: blocos `KLV` (chave de 4 letras, tipo, tamanho, repetições).
As chaves que interessam: `GPS5` (câmeras até HERO10), `GPS9` (HERO11+),
`SCAL` (escala) e `GPSU` (horário).

Três problemas reais foram resolvidos aqui, e valem como estudo de caso:

### 4.1 Ler só a faixa de GPS, não o arquivo inteiro

A versão original **varria o MP4 byte a byte** procurando as chaves. Num
vídeo de 16 minutos (vários GB) isso levava ~40 minutos.

**Solução:** ler a estrutura de átomos do MP4 (`moov` → `trak` → `stbl`),
localizar o track de metadados (`gpmd`) e usar as tabelas `stsz`/`stco`/
`stsc` para saber o **offset exato** de cada amostra de GPS. Aí lê-se só
esses poucos MB.

Medido: num arquivo de 20 MB passou a ler **0,00%** do arquivo, em
milissegundos. Se o MP4 for atípico, cai automaticamente na varredura
antiga (`_extractGPMFScan`).

### 4.2 Cada sensor tem a sua escala

O código pegava "o primeiro `SCAL` do arquivo" — que normalmente é o do
**acelerômetro** — e aplicava no GPS. Resultado: coordenadas absurdas
(`-1068516` de longitude) e o mapa mostrando o mundo inteiro.

**Solução:** mapear todos os `SCAL` com sua posição e, para cada bloco de
GPS, usar o `SCAL` imediatamente anterior — o do próprio stream. Mais uma
trava (`_coordValida`) que descarta qualquer `|lat|>90` ou `|lon|>180`.

### 4.3 Alinhar o GPX ao vídeo

A GoPro descarta pontos sem sinal de satélite (início da gravação, túnel).
O app tomava o primeiro ponto **válido** como o segundo 0 do vídeo — então
o GPX saía mais curto **e deslocado** (10:49 num vídeo de 11:52).

**Solução:** como a faixa de GPS é gravada junto com a imagem, a amostra
N corresponde a N/total da duração. Cada ponto carrega essa fração
(`fracVideo`) e os horários do GPX são reconstruídos sobre a duração real
do vídeo. Onde não houve sinal fica um buraco — o que é honesto —, mas o
que existe fica no segundo certo.

---

## 5. Quilometragem (`kmz.js` + `kmcalc.js`)

O KMZ do Google Earth traz os marcos de km. A partir deles o sistema
converte qualquer coordenada em quilometragem.

**Leitura do marco (`parseKmValor`)** — aceita `118+740`, `km 118+740`,
`KM-118+740`, `118 + 740`, `118,740` e número puro. O cuidado aqui é que
`parseFloat("118+740")` devolve **118** (para no `+`) — foi exatamente
esse detalhe que fazia o km sair sempre redondo.

**Interpolação (`interpolateKmOnRoad`)** — acha o marco mais próximo e
interpola até o vizinho. O detalhe que quebrava:

> Os vizinhos eram pegos por **posição na lista** (`points[i-1]`,
> `points[i+1]`), o que assume lista ordenada e sem repetição. Nos KMZ
> reais vêm os marcos da **pista oposta** (mesmo km, lado a lado). O
> "vizinho" virava o gêmeo do mesmo km, a interpolação não andava e o
> valor travava em `218+000`.

Hoje os vizinhos são escolhidos **pelo km** (o imediatamente menor e o
imediatamente maior, ignorando os de mesmo km), e o clique é projetado no
segmento certo.

**Tolerância adaptativa:** um limite fixo de 500 m deixava o meio de um
trecho de 1 km sem km nenhum. Agora o limite acompanha o espaçamento real
dos marcos (75% da distância ao vizinho, mínimo 500 m) — ponto sobre a via
sempre recebe km, ponto fora dela continua sem.

---

## 6. Vídeo (`video.js` + `video-export.js`)

Corte e exportação rodam no navegador com **ffmpeg.wasm**.

### 6.1 Motor multi-thread

Usa o core multi-thread (`vendor/ffmpeg-mt`), que aproveita todos os
núcleos. Ele exige `SharedArrayBuffer`, que só existe com *cross-origin
isolation* — daí os headers `COOP`/`COEP` no `main.py`. Usamos
`COEP: credentialless` de propósito, porque `require-corp` quebraria os
tiles do mapa. Se o navegador não suportar, cai sozinho no single-thread.

### 6.2 Copiar x re-encodar (a decisão mais importante)

| modo | o que faz | quando |
|---|---|---|
| **copy** | corta sem recomprimir — segundos | padrão |
| **reencode** | converte para H.264 — muito lento | só sob pedido |

O contexto: as GoPro novas gravam em **HEVC/H.265**, que o Chrome não
reproduz e o Windows Media Player não abre. A tentação é converter
sempre — mas re-encodar um HEVC de 12 minutos no navegador **não termina**.
Foi o que travava o app por horas.

Hoje:

- **Exportar MP4** → copy por padrão; há um checkbox opcional
  *"Converter para H.264"* para quem precisa abrir no Windows Media Player.
- **Enviar ao editor** → **sempre copy**. O editor re-encoda por conta
  própria no export dele, então converter antes era trabalho dobrado.
- Há também a opção **"exportar sem áudio"** (`-an`).

Outros cuidados no comando: `-dn` e `-map_metadata -1` descartam as faixas
de dados (GPS/timecode) que fazem o WMP recusar o arquivo, e
`-movflags +faststart` põe o índice no início.

### 6.3 Duração quando o player não lê o vídeo

`videoDuration` vinha do evento `loadedmetadata` do `<video>`. Com HEVC no
Chrome esse evento **nunca dispara**, a duração ficava 0 e o vínculo do
GPX abortava com "Carregue um vídeo primeiro" — mesmo com o vídeo na tela.

**Solução:** `garantirDuracaoVideo()` lê a duração direto do arquivo pelo
ffmpeg, sem depender do decoder do navegador.

### 6.4 Ponte com o editor (`handoff.js`)

O editor é uma página separada. A passagem dos cortes usa **IndexedDB**:
a aba de vídeo grava os blobs e abre `/editor/?handoff=1`; o editor lê e
carrega na biblioteca dele.

Duas defesas foram necessárias:

- **Acumular, não substituir.** Havia um `clear()` que fazia cada envio
  apagar o anterior.
- **Auto-reparo + plano B.** O IndexedDB às vezes falha com
  *"Internal error opening backing store"*. O código apaga o banco
  corrompido e recria; se ainda assim não abrir (navegação anônima, dados
  bloqueados), **baixa os cortes** e orienta a arrastar para o editor.

---

## 7. Bibliotecas compartilhadas (KMZ e Scripts)

Duas funcionalidades com **a mesma arquitetura** — este é o padrão a
seguir para funcionalidades novas do tipo:

- índice em **JSON + arquivos em disco**, sem tabela nova (sem migração);
- **leitura** liberada a qualquer usuário logado;
- **escrita** só admin, barrada no backend com `require_admin`;
- **validação do conteúdo** antes de gravar (KMZ precisa ter `.kml`
  dentro; script precisa ser zip legível e não-vazio).

| | KMZ | Scripts |
|---|---|---|
| backend | `app/routers/kmz_lib.py` | `app/routers/script_lib.py` |
| frontend | `static/js/kmz-lib.js` | `static/js/script-lib.js` |
| onde | aba MARCAÇÕES | aba SCRIPTS |
| pasta | `KMZ_LIB_DIR` (`data_kmz/`) | `SCRIPT_LIB_DIR` (`data_scripts/`) |

> **Atenção no Railway:** o disco é **efêmero** — um redeploy apaga as duas
> bibliotecas. Para uso real, aponte essas variáveis para um volume.

---

## 8. Módulo de Validação (`validacao/`)

Responde, para cada corte da planilha: **foi filmado? quanto? por qual
câmera? o que faltou?** Detalhado em `docs/VALIDACAO_TECNICA.md`; o
essencial:

Ele **não compara km diretamente**, porque a numeração reinicia na divisa
e tem saltos. Monta um **eixo próprio em metros acumulados** (offset) ao
longo da rodovia e faz toda a conta ali; o km só volta na hora de exibir.

Um ponto que costuma surpreender: **100% de cobertura pode dar PARCIAL**.
Se o interno cobriu tudo e o externo metade, o corte não está fechado —
é o caso real de uma câmera falhar sem ninguém notar.

Limitação conhecida: só reconhece rodovias **BR** com três dígitos
(`^(BR)-?(\d{3})$`); estaduais são descartadas.

---

## 9. Entrega e operação

**Rodar local**
```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --reload    # http://127.0.0.1:8000
```

**Deploy:** Railway, via GitHub (`Natha-Frade/GPX_ITF`), com Dockerfile
que instala `exiftool` e `ffmpeg`. Postgres gerenciado.

**Variáveis:** `SECRET_KEY`, `ADMIN_NOME`, `ADMIN_SENHA`, `DATABASE_URL`,
`KMZ_LIB_DIR`, `SCRIPT_LIB_DIR`, `VALIDACAO_DATA_DIR`.

### Bibliotecas locais (`static/vendor/`) — não é desperdício

Leaflet, JSZip e os dois cores do ffmpeg são servidos pelo próprio app,
não por CDN. Motivo: **a rede corporativa bloqueia unpkg e cdnjs**. Sem
isso, o Leaflet não carrega, `map` nunca é criado e **todas as abas caem
juntas** — foi exatamente o que aconteceu. Os ~63 MB precisam ir para o
repositório.

### Desempenho (`main.py`)

- **gzip** nas respostas: `index.html` 55 KB → 11 KB; `points.js` 23 → 7 KB.
- **cache em dois níveis**: `/vendor` como `immutable` por 1 ano (versão
  fixa, evita rebaixar 32 MB toda visita); `/js` e `/css` com
  `must-revalidate` (você edita esses arquivos; volta `304` se nada mudou).

### A regra de ouro do dia a dia

Ao editar qualquer `.js` ou `.css`, **troque o número da versão** no
`index.html`:

```html
<script src="js/points.js?v=20250805c"></script>
```

e recarregue com **Ctrl+Shift+R**. Sem isso o navegador serve o arquivo
antigo do cache e parece que a alteração não teve efeito — já custou horas
de investigação em falso.

---

## 10. Onde mexer para cada tipo de mudança

| quero… | arquivo |
|---|---|
| mudar categorias/ícones das marcações | `static/js/points.js` (topo) |
| mexer no cálculo de km | `static/js/kmcalc.js` |
| mexer na leitura dos marcos do KMZ | `static/js/kmz.js` |
| mexer no corte/exportação de vídeo | `static/js/video-export.js` |
| mexer na extração de GPS | `static/js/gpmf.js` |
| criar uma biblioteca nova | copiar `kmz_lib.py` + `kmz-lib.js` |
| mexer nas regras de validação | `validacao/engine.py` (constantes no topo) |
| mexer no editor | `editor-src/` — **exige recompilar** (Vue/Vite) |

---

## 11. Armadilhas conhecidas (leia antes de depurar)

1. **"Minha alteração não pegou"** → cache. Troque o `?v=`.
2. **Tela toda quebrada, nenhuma aba funciona** → Leaflet não carregou.
   Confira `/vendor/leaflet/leaflet.js`.
3. **Vídeo não abre / preview preto** → é HEVC. Não é bug: o Chrome e o
   WMP não leem esse formato. Use a opção de converter, ou o VLC.
4. **Exportação eterna** → re-encode de HEVC longo no navegador. Desmarque
   a conversão, ou use o editor local com ffmpeg nativo.
5. **KM sempre redondo** → marcos de pista dupla; ver §5.
6. **Mapa no mundo inteiro, coordenadas absurdas** → escala errada do
   GPMF; ver §4.2.
7. **Biblioteca vazia depois do deploy** → disco efêmero do Railway.
8. **Git corrompendo** → repositório dentro de pasta do OneDrive. Mova
   para fora (ex.: `C:\dev\`).

---

## 12. Limitações assumidas

Coisas que **não** são bugs, e sim escolhas ou limites reais:

- Re-encode pesado no navegador é lento por natureza. Para 4K longo, o
  caminho rápido é o editor local com ffmpeg nativo.
- O Chrome não reproduz HEVC; a prévia pode ficar preta mesmo com o
  arquivo íntegro.
- A validação só cobre rodovias BR de três dígitos.
- A aba UNIR tem 4 slots; acima disso é preciso unir, baixar e repetir.
- O editor decide sozinho em qual trilha o clipe entra; mudar isso exige
  recompilar o `editor-src`.
- O JS do app é global (sem módulos ES), carregado em ordem no
  `index.html` — mudar a ordem quebra dependências.
