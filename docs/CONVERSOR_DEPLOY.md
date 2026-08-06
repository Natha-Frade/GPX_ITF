# Conversor de vídeo — deploy em VPS (Locaweb / Hostinger)

Documento do módulo `app/routers/conversor.py` + `static/conversor.html`.
Nada aqui é opcional se o site vai ficar exposto na internet.

---

## 1. O que o módulo faz

Recebe vídeo da GoPro (4K HEVC), converte com ffmpeg nativo para H.264
com `-pix_fmt yuv420p` e devolve um MP4 que abre no Windows Media Player
e no Chrome sem codec pago.

Fluxo de envio, em duas requisições por arquivo:

```
POST /api/conversor/reservar?nome=&tamanho=&perfil=&telemetria=
      -> valida cota, disco, extensão e tamanho. Devolve o id do job.
PUT  /api/conversor/enviar/{id}
      -> corpo cru (application/octet-stream) com os bytes do vídeo.
```

A separação existe por um motivo prático: se a recusa acontecesse no meio
do POST do vídeo, o servidor responderia e fecharia a conexão com o
navegador ainda enviando — e o XHR mostra "conexão perdida" em vez do
motivo. Com 13 GB, a pessoa descobriria o problema 40 minutos depois.

---

## 2. ANTES DE SUBIR — três coisas que quebram o deploy

### 2.1 `requirements.txt` não existe neste projeto

O `Dockerfile` faz `COPY requirements.txt .` e o build morre ali.
Crie o arquivo na raiz:

```
fastapi
uvicorn[standard]
sqlalchemy
psycopg2-binary
bcrypt
PyJWT
pydantic
python-multipart
openpyxl
```

### 2.2 `SECRET_KEY` tem fallback público

Em `app/auth.py`:

```python
SECRET_KEY = os.getenv("SECRET_KEY", "troque-esta-chave-no-railway")
```

Se a variável não for definida na VPS, **qualquer pessoa que leia este
repositório forja um JWT de admin**. Aí toda a proteção do conversor
(autenticação, dono do job, cota) vira decoração. Gere e exporte:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Vale considerar mudar o fallback para `raise` em vez de string fixa.

### 2.3 `gpx_imtraff.db` está versionado

O SQLite com os hashes bcrypt dos usuários reais veio dentro do zip.
Ele já está no `.gitignore` e no `.dockerignore`, mas **o arquivo que
está no disco continua lá**. Em produção use Postgres (`DATABASE_URL`)
e apague o `.db` do servidor.

---

## 2.5 Rodando LOCAL no Windows

Não precisa instalar nada: o `bin/ffmpeg/` do projeto já traz
`ffmpeg.exe`, `ffprobe.exe` e as DLLs. O `_achar_bin()` procura ali antes
de olhar o `PATH` do sistema.

```
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Abra `http://127.0.0.1:8000/conversor.html`, faça login e teste. Se a
faixa de status disser "Servidor sem ffmpeg", a mensagem agora informa a
pasta exata onde ele é procurado — confira se as DLLs estão junto dos
`.exe` (o Windows carrega DLL do diretório do executável; mover só o
`ffmpeg.exe` quebra).

Detalhe de plataforma que o código trata: `os.killpg` não existe no
Windows, então o cancelamento usa `taskkill /F /T`. E os processos sobem
com `CREATE_NO_WINDOW` para não abrir um console preto a cada conversão.

Ver `bin/ffmpeg/README.md` para origem, licença e como atualizar.

---

## 3. Requisitos da máquina

| Item | Mínimo | Comentário |
|---|---|---|
| ffmpeg + ffprobe | obrigatório | Windows: já vem em `bin/ffmpeg/`. Linux/VPS: `apt install ffmpeg` — o `bin/ffmpeg/` é ignorado fora do Windows. Sem eles `/status` devolve `ok:false` e diz onde procurar. |
| vCPU | 2 | 720p sai a ~1,7x o tempo real com 16 threads. Com 2 vCPU conte com 4–6x o tempo real. |
| RAM | 2 GB | O upload é em stream: a RAM não sobe com o tamanho do arquivo. |
| Disco | ver §4 | É a restrição real, não a CPU. |

---

## 4. Disco — é aqui que a VPS morre

Durante a conversão **o original e o convertido coexistem**. Um vídeo de
13 GB ocupa 13 GB + ~1,6 GB até o ffmpeg terminar. O original é apagado
assim que a saída existe.

Regra de bolso: `pico = maior_arquivo × 2 × conversões_simultâneas`.

Monte `data_conversor/` numa partição separada, ou pelo menos aponte
`CONVERSOR_DIR` para um volume que não seja o `/` do sistema. Uma VPS com
o disco raiz cheio **para de responder inteira** — não só o conversor.

O módulo já se defende: recusa a reserva se o espaço livre cairia abaixo
de `CONVERSOR_DISCO_RESERVA_GB`, e mata o upload no meio se o cliente
mentiu no tamanho declarado.

---

## 5. Variáveis de ambiente

```bash
# obrigatórias
SECRET_KEY=<token longo e aleatório>
DATABASE_URL=postgresql://...
ADMIN_SENHA=<senha forte>      # só usada no primeiro boot, no seed

# conversor — os padrões são conservadores, ajuste ao tamanho da VPS
CONVERSOR_DIR=/var/lib/gpxitf/conversor
CONVERSOR_WORKERS=1            # conversões simultâneas
CONVERSOR_THREADS=2            # threads do ffmpeg POR job
CONVERSOR_TTL_HORAS=12         # depois disso o arquivo é apagado
CONVERSOR_MAX_GB=20            # teto por arquivo
CONVERSOR_MAX_JOBS_USUARIO=4   # jobs ativos por pessoa
CONVERSOR_DISCO_RESERVA_GB=5   # espaço livre intocável
CONVERSOR_TIMEOUT_HORAS=4      # ffmpeg travado morre aqui
```

`CONVERSOR_WORKERS × CONVERSOR_THREADS` não deve passar do número de
vCPU, senão a aplicação inteira engasga enquanto converte.

---

## 6. systemd

```ini
# /etc/systemd/system/gpxitf.service
[Unit]
Description=GPX IMTRAFF
After=network.target

[Service]
User=gpxitf
Group=gpxitf
WorkingDirectory=/opt/gpxitf
EnvironmentFile=/etc/gpxitf.env
ExecStart=/opt/gpxitf/.venv/bin/uvicorn app.main:app \
          --host 127.0.0.1 --port 8000 --workers 1
Restart=always
RestartSec=5

# Endurecimento — vale muito num módulo que executa processo externo
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/gpxitf
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
MemoryMax=2G

[Install]
WantedBy=multi-user.target
```

`/etc/gpxitf.env` com `chmod 600` e dono `root` — é onde fica a
`SECRET_KEY`.

### `--workers 1` não é sugestão

A fila do conversor vive **na memória do processo**. Com dois workers,
cada processo tem a própria fila: o job criado num não aparece no outro,
o download dá 404 metade das vezes e a cota por usuário não fecha.

Para converter mais em paralelo, **aumente `CONVERSOR_WORKERS`** (que são
threads dentro do mesmo processo), nunca o `--workers` do uvicorn.

---

## 7. nginx — quatro linhas sem as quais nada funciona

```nginx
server {
    listen 443 ssl http2;
    server_name gpx.suaempresa.com.br;

    # ... certificados ...

    # 1) SEM ISTO O UPLOAD MORRE EM 1 MB (padrão do nginx)
    client_max_body_size 0;

    # 2) SEM ISTO O NGINX GUARDA OS 13 GB EM DISCO ANTES DE REPASSAR
    #    — dobra o consumo de disco e a espera do usuário
    proxy_request_buffering off;

    # 3) Conversão longa: o proxy não pode desistir no meio
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 4) Download do MP4 sai direto, sem o nginx bufferizar 1,6 GB
        proxy_buffering off;
    }

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;
}
```

O `client_max_body_size 0` desliga o limite do nginx e deixa o teto por
conta do `CONVERSOR_MAX_GB` — que é o lugar certo, porque lá a mensagem
de erro chega legível ao navegador em vez de um 413 cru do nginx.

Se usar Apache (comum na Locaweb), o equivalente é `LimitRequestBody 0`
e `ProxyTimeout 3600`.

---

## 8. Firewall

O uvicorn escuta em `127.0.0.1`. Só as portas 80/443 ficam abertas:

```bash
ufw default deny incoming
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
```

Nunca exponha `0.0.0.0:8000` direto — o `/api/docs` do FastAPI fica
público e lista toda a API.

---

## 9. O que a reescrita protege (e o que não protege)

**Protege:**

| Ataque | Defesa |
|---|---|
| Uso anônimo do ffmpeg da sua VPS | JWT obrigatório em todas as rotas |
| Ler/apagar job de outro usuário | dono por job; id de 32 hex; 404 em vez de 403 |
| Encher o disco | teto por arquivo, reserva de espaço, cota por usuário |
| Path traversal no nome | `_nome_seguro()` corta `/` e `\`, lista branca de caracteres |
| Injeção de header no download | mesmo saneamento mata `\r\n` |
| Gravar `.php`/`.sh` no disco | lista branca de extensão |
| "MP4" que é playlist `concat`/`hls` lendo `/etc/passwd` ou batendo em IP interno (SSRF) | `-protocol_whitelist file` no ffprobe **e** no ffmpeg + lista branca de contêiner |
| ffmpeg travado comendo CPU | timeout + `killpg` SIGTERM→SIGKILL |
| Arquivo esquecido no disco para sempre | faxina a cada 15 min, TTL, reserva abandonada expira em 30 min |
| XSS pelo nome do arquivo na fila do admin | escape no `esc()` do frontend |

**Não protege — pense nisso:**

- **Conta comprometida.** Se alguém rouba o token de um usuário legítimo,
  ele consegue usar o conversor dentro da cota daquele usuário. Mitigação
  real: senha forte, `VALIDADE_DIAS` menor que 30 em `auth.py`, e revogar
  sessão pelo painel admin.
- **CPU.** Mesmo com cota, N usuários legítimos convertendo ao mesmo
  tempo enfileiram. Isso é fila, não ataque — mas o site fica lento.
  `CONVERSOR_THREADS` limita o estrago.
- **Rate limit de requisição.** Não há. Se virar problema, um
  `limit_req_zone` no nginx em `/api/` resolve.
- **Antivírus.** O arquivo enviado nunca é executado, mas também nunca é
  escaneado. Se a política da empresa exigir, chame o ClamAV antes de
  enfileirar.

---

## 10. Checklist antes de abrir para a equipe

```
[ ] requirements.txt criado
[ ] SECRET_KEY definida na VPS (não o fallback do código)
[ ] ADMIN_SENHA trocada; usuário admin do seed com senha nova
[ ] gpx_imtraff.db apagado do servidor; DATABASE_URL apontando p/ Postgres
[ ] ffmpeg do SISTEMA instalado na VPS (apt install ffmpeg) — o
    bin/ffmpeg/ do repo é só Windows e não roda no Linux
    ->  /api/conversor/status devolve ok:true e mostra "ffmpeg_em"
[ ] CONVERSOR_DIR em volume separado, com espaço folgado
[ ] client_max_body_size 0 e proxy_request_buffering off no nginx
[ ] uvicorn com --workers 1
[ ] uvicorn ouvindo só em 127.0.0.1; ufw ligado
[ ] HTTPS válido (o token vai no header Authorization — sem TLS, vaza)
[ ] teste real: subir um GX*.MP4 4K HEVC, converter em 720p, baixar,
    abrir no Windows Media Player
```

---

## 11. Teste rápido pós-deploy

```bash
# 1) deve dar 401 (rota protegida)
curl -s -o /dev/null -w '%{http_code}\n' https://SEU_DOMINIO/api/conversor/status

# 2) login
TK=$(curl -s https://SEU_DOMINIO/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"nome":"admin","senha":"SUA_SENHA"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

# 3) status
curl -s https://SEU_DOMINIO/api/conversor/status -H "Authorization: Bearer $TK"

# 4) deve dar 415 (extensão barrada)
curl -s -X POST "https://SEU_DOMINIO/api/conversor/reservar?nome=x.php&tamanho=10" \
     -H "Authorization: Bearer $TK"
```

Se o item 1 devolver 200 em vez de 401, **pare o deploy**: o conversor
está aberto.
