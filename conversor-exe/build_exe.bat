@echo off
REM ============================================================================
REM  build_exe.bat  —  Gera o executável único do Conversor GoPro -> GPX
REM  com o exiftool EMBUTIDO. A pessoa final só recebe o .exe e usa.
REM ============================================================================
REM
REM  PRE-REQUISITOS (apenas na SUA máquina, para gerar o .exe uma vez):
REM    1) Python instalado.
REM    2) Nesta MESMA pasta devem estar:
REM         - gopro_gpx_pro.py
REM         - exiftool.exe            (o executável do exiftool)
REM         - exiftool_files\         (a pasta que acompanha o exiftool.exe)
REM         - build_exe.bat           (este arquivo)
REM
REM  COMO USAR:
REM    Dê dois cliques neste arquivo (ou rode no terminal).
REM    Ao final, o executável estará em:   dist\ConversorGoProGPX.exe
REM ============================================================================

echo.
echo === Instalando PyInstaller (se necessario) ===
python -m pip install --upgrade pyinstaller

echo.
echo === Verificando arquivos necessarios ===
if not exist exiftool.exe (
  echo [ERRO] exiftool.exe nao encontrado nesta pasta.
  echo Baixe em https://exiftool.org, renomeie para exiftool.exe e coloque aqui.
  pause
  exit /b 1
)
if not exist exiftool_files (
  echo [ERRO] pasta exiftool_files nao encontrada nesta pasta.
  echo Ela vem junto do exiftool.exe no zip oficial. Copie-a para ca.
  pause
  exit /b 1
)

echo.
echo === Gerando o executavel (isso leva alguns minutos) ===
REM  --onefile         : um unico .exe
REM  --noconsole       : sem janela preta de terminal (so a interface)
REM  --add-data ...    : embute exiftool.exe e exiftool_files DENTRO do exe
REM  --name ...        : nome do executavel final
python -m PyInstaller --onefile --noconsole ^
  --name ConversorGoProGPX ^
  --add-data "exiftool.exe;." ^
  --add-data "exiftool_files;exiftool_files" ^
  gopro_gpx_pro.py

echo.
if exist dist\ConversorGoProGPX.exe (
  echo ============================================================
  echo  PRONTO!  O executavel esta em:  dist\ConversorGoProGPX.exe
  echo  Esse arquivo unico ja tem o exiftool embutido.
  echo  Distribua APENAS esse .exe para a equipe.
  echo ============================================================
) else (
  echo [ERRO] Algo deu errado. Veja as mensagens acima.
)
echo.
pause
