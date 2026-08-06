# ffmpeg embutido

Binários do ffmpeg para **Windows x64**, usados pelo conversor de vídeo
(`app/routers/conversor.py`). Estão aqui pelo mesmo motivo do
`exiftool.exe` na raiz do projeto: rodar a aplicação local sem exigir
que cada colaborador instale o ffmpeg na própria máquina.

## O que tem aqui

| Arquivo | Para quê |
|---|---|
| `ffmpeg.exe` | conversão |
| `ffprobe.exe` | leitura dos metadados (codec, duração, telemetria gpmd) |
| `av*.dll`, `sw*.dll` | bibliotecas compartilhadas pelos dois |
| `LICENSE.txt` | licença |

É um **build shared**, não static. Com static seriam dois executáveis de
145 MB cada (290 MB); aqui os dois `.exe` somam menos de 1 MB e
compartilham 160 MB de DLL — cerca de 130 MB a menos no total.

**As DLLs precisam ficar na mesma pasta dos `.exe`.** O Windows procura
a DLL primeiro no diretório do executável. Se você mover só o
`ffmpeg.exe`, ele não abre.

Origem: <https://github.com/BtbN/FFmpeg-Builds> —
`ffmpeg-master-latest-win64-gpl-shared.zip`, com `--enable-libx264`
(obrigatório: é o encoder H.264 que a receita do conversor usa).

## Como o código encontra isso

`_achar_bin()` em `conversor.py` procura nesta ordem:

1. variável de ambiente `FFMPEG_PATH` / `FFPROBE_PATH`
2. **esta pasta** (`bin/ffmpeg/`)
3. raiz do projeto
4. `PATH` do sistema

O embutido vem antes do `PATH` de propósito: a equipe usa a versão
testada, não a que por acaso está instalada em cada máquina.

O `.exe` só entra na busca quando `os.name == "nt"`. No Linux da VPS
esses arquivos são ignorados, mesmo estando presentes — senão o servidor
tentaria executar um binário PE do Windows.

## No Linux / na VPS

Não use esta pasta. Instale o ffmpeg do sistema:

```bash
apt install ffmpeg
```

O `Dockerfile` já faz isso. O `.dockerignore` exclui `bin/ffmpeg` para
não empurrar 160 MB de DLL de Windows para dentro de uma imagem Linux.

## Licença — leia antes de distribuir

Este é o build **GPL** (o LGPL não traz o `libx264`, e sem ele não há
codificação H.264). Consequência prática:

- uso interno na empresa: sem problema;
- se você **redistribuir** o binário para fora, a GPL exige oferecer o
  código-fonte correspondente. O fonte está em
  <https://github.com/BtbN/FFmpeg-Builds> e em <https://ffmpeg.org>.

## Atualizar

Baixe o zip mais recente de `BtbN/FFmpeg-Builds`
(`ffmpeg-master-latest-win64-gpl-shared.zip`), pegue o conteúdo de
`bin/` menos o `ffplay.exe`, e substitua os arquivos daqui.

Confira depois que o encoder continua presente:

```
bin\ffmpeg\ffmpeg.exe -hide_banner -encoders | findstr libx264
```

## Git

São ~160 MB de binário. Se o repositório começar a ficar pesado,
considere Git LFS ou mover esta pasta para um release/compartilhamento
interno e deixar só o `.gitignore` apontando para ela. Como o histórico
do projeto já teve problema de corrupção via OneDrive, vale pensar duas
vezes antes de versionar isso direto.
