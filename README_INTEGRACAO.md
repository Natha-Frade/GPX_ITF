# Módulo Validação de Campo — GPX IMTRAFF

Identifica por **coordenada** qual dispositivo do KMZ cada GPX cobre, cruza com
a planilha de controle (fonte da verdade no SharePoint/Excel) e gera a
nomenclatura padrão automaticamente. O campo não nomeia nada.

## Estrutura
```
validacao/
  __init__.py
  engine.py     # núcleo (sem FastAPI — dá pra usar em script/CLI também)
  router.py     # rotas /validacao/*
static/
  validacao.html
teste_local.py  # valida o motor com dados reais antes do deploy
```

## Integração no GPX_ITF (main.py)
```python
from validacao.router import router as validacao_router
app.include_router(validacao_router)   # ANTES da rota catch-all!
```
Dependências: `openpyxl` (o resto é stdlib — sem numpy, sem lxml).
Copie as pastas `validacao/` e o arquivo `static/validacao.html` para o repositório.

## Uso
1. `/validacao` → aba **Referências**: envie o KMZ de dispositivos e a planilha
   de controle (baixada do SharePoint). Fica salvo em `VALIDACAO_DATA_DIR`
   (padrão `data_validacao/`).
2. **Lote do dia**: arraste os `.gpx` brutos ou o `.zip` do cartão.
   Se o zip/pasta tiver "interno"/"externo" no nome, o sistema separa e nomeia
   cada origem (`... INTERNO.gpx` / `... EXTERNO.gpx`).
3. **Relatório**: situação por dispositivo (COMPLETO ≥90% / PARCIAL ≥50% /
   INSUFICIENTE), avisos de pares simultâneos, duplicatas exatas e arquivos
   não identificados. Botão baixa o ZIP com tudo renomeado
   (`originais/` = partes; raiz = unidos) + `relatorio.json`.

## Regras que o motor aplica
- Dispositivo identificado pela trilha: maior % de pontos do dispositivo com
  GPX a ≤60 m (RAIO_COBERTURA_M).
- Corte: linha da planilha marcada como "Dispositivo" com km mais próximo
  (≤800 m). Linhas de trecho contínuo não competem.
- Nomenclatura: `V1 Corte N Dispositivo [Sentido] KKK+MMM [INTERNO|EXTERNO]`.
- Vários GPX no mesmo dispositivo e origem → partes renomeadas + arquivo unido.
- Duplicata exata (mesmos pontos) → ignorada no ZIP, listada no relatório.
- Cortes sem sentido na planilha saem como "sentido a definir" (preencher na
  planilha e reprocessar, se quiser o nome completo).

## Parâmetros (engine.py)
`RAIO_COBERTURA_M=60 · COBERTURA_COMPLETA=90 · COBERTURA_PARCIAL=50 ·
TOL_CORTE_M=800 · DIST_MAX_IDENTIFICACAO=150`

## Próximos passos naturais (fora deste escopo)
- Ler a planilha direto do Graph API (já existe router SharePoint no app) em
  vez de upload manual.
- Aplicar o mesmo mapa de renomeação aos MP4 (o `relatorio.json` já traz
  `mapa_renomeacao` original→novo).
- Comparação KMZ novo × planilha ("cortes órfãos") como botão.
