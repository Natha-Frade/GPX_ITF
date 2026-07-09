# Conversor GoPro → GPX (executável para a equipe)

Converte lotes de vídeos GoPro em arquivos `.gpx` (um por vídeo), rápido e em
paralelo, no formato idêntico ao do goprotelemetryextractor.com (1 ponto/seg).
Pensado para a **equipe de tratamento**: cada pessoa recebe **um único `.exe`**,
abre, aponta a pasta dos vídeos já baixados do SharePoint, e converte o lote.

---

## Para a EQUIPE (quem só usa)

1. Receba o arquivo **`ConversorGoProGPX.exe`**.
2. Dê dois cliques.
3. Clique em **Escolher...** e aponte a pasta dos vídeos.
4. (Opcional) marque *Incluir subpastas*, ajuste *Simultâneos*.
5. Clique em **CONVERTER TUDO**. Os `.gpx` saem numa subpasta `gpx`
   (ou ao lado de cada vídeo, se *Incluir subpastas* estiver marcado).

Não precisa instalar Python, nem exiftool, nem nada. O `.exe` já traz tudo.

---

## Para VOCÊ (gerar o `.exe` uma vez)

Você monta o executável uma vez e distribui para a equipe.

### O que precisa estar na mesma pasta
- `gopro_gpx_pro.py` (o programa)
- `build_exe.bat` (o gerador)
- `exiftool.exe` (baixe em https://exiftool.org, renomeie de
  `exiftool(-k).exe` para `exiftool.exe`)
- `exiftool_files\` (a pasta que vem junto no zip do exiftool)

> Importante: a partir da versão 13 o exiftool para Windows é o `exiftool.exe`
> **mais** a pasta `exiftool_files`. Os dois precisam estar aqui para o build
> embutir corretamente.

### Gerar
Dê dois cliques em **`build_exe.bat`** e aguarde alguns minutos.
Ao final, o executável estará em:

```
dist\ConversorGoProGPX.exe
```

Distribua **apenas esse arquivo**. Ele funciona sozinho em qualquer Windows,
sem dependências.

---

## Recursos

- **Paralelismo**: converte vários vídeos ao mesmo tempo (ajustável na tela).
  Um lote de 20–60 vídeos termina em uma fração do tempo da conversão em série.
- **exiftool embutido**: nada para instalar na máquina de quem usa.
- **Lembra a última pasta** usada (guardado em `%APPDATA%\GoProGPX`).
- **1 Hz ou 18 Hz**: 1 ponto/seg replica o site; 18 Hz mantém a densidade bruta.
- **Incluir subpastas** e **pular GPX já existentes** (reprocessa lotes sem retrabalho).
- **Cancelar** a qualquer momento, com resumo do lote ao final.

---

## Onde isso encaixa no fluxo

- **Campo** sobe os vídeos no SharePoint.
- **Equipe de tratamento** baixa os vídeos e usa este `.exe` para gerar os GPX.
- **GPX IMTRAFF (Railway)** é onde vocês tratam os GPX depois (editar, cortar, marcar).

A conversão vídeo→GPX roda local (aqui) porque é onde os vídeos estão e onde é
rápido; o app no Railway cuida do tratamento posterior.
