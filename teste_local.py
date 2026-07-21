"""Teste do motor com dados reais. Uso:
   python teste_local.py <kmz> <planilha.xlsx> <lote1.zip|.gpx> [...]"""
import sys, json
from validacao import engine

kmz = engine.parse_kmz(open(sys.argv[1], 'rb').read())
cortes = engine.parse_planilha(open(sys.argv[2], 'rb').read())
print(f'{len(kmz)} dispositivos | {len(cortes)} cortes')
lote = []
for caminho in sys.argv[3:]:
    lote += engine.extrair_gpx_de_upload(caminho, open(caminho, 'rb').read())
rel, zip_bytes = engine.processar_lote(lote, kmz, cortes)
for g in rel['grupos']:
    print(f"{g['situacao']:12s} {g['cobertura_uniao_pct']:5.1f}%  "
          f"{g['dispositivo']:30s} -> {g['corte']}")
print(f"não identificados: {len(rel['nao_identificados'])} | "
      f"duplicatas: {len(rel['duplicatas'])}")
open('lote_validado.zip', 'wb').write(zip_bytes)
print('gerado: lote_validado.zip')
