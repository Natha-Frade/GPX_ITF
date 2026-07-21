# -*- coding: utf-8 -*-
"""
Validação de Campo — GPX IMTRAFF
Motor de validação: identifica por COORDENADA qual dispositivo do KMZ cada GPX
cobre, cruza com a planilha de controle (fonte da verdade) e gera a
nomenclatura padrão automaticamente.

Sem dependências além de openpyxl (planilha). Todo o resto é stdlib.
"""
import io
import re
import math
import json
import hashlib
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime

R_TERRA = 6371000.0
KML_NS = '{http://www.opengis.net/kml/2.2}'

# ---------------------------------------------------------------- parâmetros
RAIO_COBERTURA_M = 60      # ponto do dispositivo "coberto" se GPX passa a <= 60 m
DIST_MAX_IDENTIFICACAO = 150   # dist mínima máxima p/ considerar que o GPX está no dispositivo
TOL_CORTE_M = 800          # tolerância p/ casar km do dispositivo com km da planilha
COBERTURA_COMPLETA = 90    # % (união dos arquivos do corte)
COBERTURA_PARCIAL = 50     # %


# ---------------------------------------------------------------- geometria
def _dist_m(lat1, lon1, lat2, lon2):
    """Distância equiretangular (suficiente p/ escalas < ~50 km)."""
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return math.sqrt(x * x + y * y) * R_TERRA


def _bbox(pontos, folga_m=300):
    """Bounding box com folga, para descartar dispositivos longe rapidamente."""
    lats = [p[0] for p in pontos]
    lons = [p[1] for p in pontos]
    dlat = folga_m / 111320.0
    dlon = folga_m / (111320.0 * max(0.2, math.cos(math.radians(sum(lats) / len(lats)))))
    return (min(lats) - dlat, max(lats) + dlat, min(lons) - dlon, max(lons) + dlon)


# ---------------------------------------------------------------- KMZ / KML
def parse_km(texto):
    """'Dispositivo Km 178 + 270' -> 178270 ; 'Km 070' -> 70000 ; None se não achar."""
    m = re.search(r'[Kk]m\s*(\d+)\s*\+?\s*(\d*)', texto)
    if not m:
        return None
    return int(m.group(1)) * 1000 + (int(m.group(2)) if m.group(2) else 0)


def fmt_km(metros):
    return f"{metros // 1000:03d}+{metros % 1000:03d}"


def parse_kmz(dados: bytes):
    """
    Lê um KMZ/KML de dispositivos. Cada Folder de 1º nível dentro do Folder
    principal vira um dispositivo, com todos os pontos de todas as geometrias.
    Retorna lista de dicts: {name, km_m, is_praca, points[[lat,lon],...]}
    """
    if dados[:2] == b'PK':
        with zipfile.ZipFile(io.BytesIO(dados)) as z:
            kml_name = next(n for n in z.namelist() if n.lower().endswith('.kml'))
            texto = z.read(kml_name)
    else:
        texto = dados
    root = ET.fromstring(texto)

    def coords_de(el):
        pts = []
        for c in el.iter(f'{KML_NS}coordinates'):
            for tok in (c.text or '').split():
                parte = tok.split(',')
                if len(parte) >= 2:
                    pts.append([float(parte[1]), float(parte[0])])  # lat, lon
        return pts

    # Folder principal = primeiro Folder com sub-Folders; senão, Document.
    candidatos = [f for f in root.iter(f'{KML_NS}Folder')
                  if f.find(f'{KML_NS}Folder') is not None]
    principal = candidatos[0] if candidatos else root

    dispositivos = []
    for pasta in principal.findall(f'{KML_NS}Folder'):
        nome_el = pasta.find(f'{KML_NS}name')
        nome = (nome_el.text or '').strip() if nome_el is not None else ''
        km = parse_km(nome)
        pts = coords_de(pasta)
        if km is None or not pts:
            continue
        dispositivos.append({
            'name': nome,
            'km_m': km,
            'is_praca': 'ped' in nome.lower(),
            'points': pts,
        })
    dispositivos.sort(key=lambda d: d['km_m'])
    for d in dispositivos:
        d['bbox'] = _bbox(d['points'])
    return dispositivos


# ---------------------------------------------------------------- GPX
_PAT_TRKPT = re.compile(r'lat="(-?\d+\.?\d*)"\s+lon="(-?\d+\.?\d*)"')
_PAT_TIME = re.compile(r'<time>([^<]+)</time>')


def parse_gpx(dados: bytes):
    """Retorna {points, primeiro_ts, hash} — hash serve p/ detectar duplicata exata."""
    texto = dados.decode('utf-8', errors='ignore')
    pontos = [(float(a), float(b)) for a, b in _PAT_TRKPT.findall(texto)]
    tempos = _PAT_TIME.findall(texto)
    primeiro_ts = None
    for t in tempos:
        try:
            primeiro_ts = datetime.fromisoformat(t.replace('Z', '+00:00'))
            break
        except ValueError:
            continue
    assinatura = hashlib.md5(
        ';'.join(f'{la:.6f},{lo:.6f}' for la, lo in pontos).encode()
    ).hexdigest()
    return {'points': pontos, 'primeiro_ts': primeiro_ts, 'hash': assinatura,
            'raw': dados}


# ---------------------------------------------------------------- planilha
def parse_planilha(dados: bytes):
    """
    Lê a planilha de controle (fonte da verdade, ex.: Controle_BR_153.xlsx).
    Procura em TODAS as abas linhas cujo 1º valor case com 'Corte N' e extrai:
    corte, sentido e km inicial. Colunas detectadas por conteúdo, não por posição
    fixa: sentido = célula contendo Norte/Sul; km = célula no formato NNN+NNN.
    """
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(dados), data_only=True)
    pat_corte = re.compile(r'^Corte\s+\d+$', re.I)
    pat_kmcel = re.compile(r'^\d{1,3}\+\d{3}$')
    cortes = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=20):
            valores = [c.value for c in row]
            primeiro = next((v for v in valores if v is not None), None)
            if not (isinstance(primeiro, str) and pat_corte.match(primeiro.strip())):
                continue
            sentido, km_str, eh_dispositivo = '', None, False
            for v in valores:
                if not isinstance(v, str):
                    continue
                v2 = v.strip()
                if v2 in ('Norte', 'Sul', 'Norte/Sul') and not sentido:
                    sentido = v2
                elif pat_kmcel.match(v2) and km_str is None:
                    km_str = v2
                elif v2.lower() == 'dispositivo':
                    eh_dispositivo = True
            if km_str is None:
                continue
            cortes.append({
                'corte': primeiro.strip(),
                'sentido': sentido,
                'km_str': km_str,
                'km_m': parse_km_planilha(km_str),
                'dispositivo': eh_dispositivo,
                'aba': ws.title,
            })
    # remove duplicados exatos (mesmo corte + km) mantendo o primeiro
    vistos, unicos = set(), []
    for c in cortes:
        chave = (c['corte'], c['km_m'])
        if chave not in vistos:
            vistos.add(chave)
            unicos.append(c)
    return unicos


def parse_km_planilha(s):
    m = re.match(r'(\d+)\+(\d+)', s.strip())
    return int(m.group(1)) * 1000 + int(m.group(2)) if m else None


# ---------------------------------------------------------------- matching
def identificar_dispositivo(pontos_gpx, dispositivos):
    """
    Para uma trilha, retorna (dispositivo, cobertura_pct, dist_min_m) do melhor
    candidato — maior cobertura dos pontos do dispositivo; empate: menor dist.
    """
    if not pontos_gpx:
        return None, 0.0, None
    la_min = min(p[0] for p in pontos_gpx); la_max = max(p[0] for p in pontos_gpx)
    lo_min = min(p[1] for p in pontos_gpx); lo_max = max(p[1] for p in pontos_gpx)
    melhor = (None, 0.0, float('inf'))
    for d in dispositivos:
        b = d['bbox']
        if la_max < b[0] or la_min > b[1] or lo_max < b[2] or lo_min > b[3]:
            continue  # trilha nem chega perto
        cobertos, dist_min = 0, float('inf')
        for dla, dlo in d['points']:
            menor = min(_dist_m(dla, dlo, gla, glo) for gla, glo in pontos_gpx)
            if menor <= RAIO_COBERTURA_M:
                cobertos += 1
            if menor < dist_min:
                dist_min = menor
        cob = cobertos / len(d['points']) * 100
        if cob > melhor[1] or (cob == melhor[1] and dist_min < melhor[2]):
            melhor = (d, cob, dist_min)
    d, cob, dist = melhor
    if d is None or dist > DIST_MAX_IDENTIFICACAO * 40:  # nada minimamente perto
        # segunda passada sem bbox p/ achar o mais próximo (só p/ reportar)
        for dd in dispositivos:
            for dla, dlo in dd['points'][:8]:
                menor = min(_dist_m(dla, dlo, gla, glo) for gla, glo in pontos_gpx[::5] or pontos_gpx)
                if menor < dist:
                    dist, d, cob = menor, dd, 0.0
    return d, round(cob, 1), (round(dist, 1) if dist != float('inf') else None)


def cobertura_uniao(listas_de_pontos, dispositivo):
    todos = [p for pts in listas_de_pontos for p in pts]
    if not todos:
        return 0.0
    cobertos = 0
    for dla, dlo in dispositivo['points']:
        if min(_dist_m(dla, dlo, gla, glo) for gla, glo in todos) <= RAIO_COBERTURA_M:
            cobertos += 1
    return round(cobertos / len(dispositivo['points']) * 100, 1)


def corte_do_dispositivo(dispositivo, cortes):
    """Corte da planilha cujo km casa com o dispositivo (mais próximo, <= TOL).
    Linhas de trecho contínuo (sem 'Dispositivo' na linha) só entram se não
    houver nenhuma linha de dispositivo candidata."""
    so_disp = [c for c in cortes if c.get('dispositivo')]
    if so_disp:
        cortes = so_disp
    melhor, melhor_d = None, TOL_CORTE_M + 1
    for c in cortes:
        if c['km_m'] is None:
            continue
        dd = abs(c['km_m'] - dispositivo['km_m'])
        if dd < melhor_d:
            melhor, melhor_d = c, dd
    return (melhor, melhor_d) if melhor else (None, None)


def nomenclatura(corte, dispositivo):
    partes = ['V1', corte['corte'], 'Dispositivo']
    if corte['sentido']:
        partes.append(corte['sentido'].replace('/', ''))  # NorteSul p/ nome de arquivo
    partes.append(fmt_km(dispositivo['km_m']))
    return ' '.join(partes)


# ---------------------------------------------------------------- lote
def mesclar_gpx(itens):
    """Une vários GPX num só (trkpts em sequência, ordenados por 1º timestamp)."""
    itens = sorted(itens, key=lambda i: i['gpx']['primeiro_ts'] or datetime.min)
    segmentos = []
    for it in itens:
        texto = it['gpx']['raw'].decode('utf-8', errors='ignore')
        m = re.search(r'<trkseg>(.*?)</trkseg>', texto, re.S)
        segmentos.append(m.group(1) if m else '')
    corpo = '</trkseg><trkseg>'.join(segmentos)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="GPX IMTRAFF - Validacao de Campo" '
        'xmlns="http://www.topografix.com/GPX/1/1">\n'
        '<trk><name>{nome}</name><trkseg>' + corpo + '</trkseg></trk>\n</gpx>\n'
    )


def processar_lote(arquivos, dispositivos, cortes):
    """
    arquivos: lista de (nome_original, bytes[, origem]) — só .gpx.
    Retorna (relatorio_dict, zip_bytes_renomeado).
    """
    # 1) parse + duplicatas exatas
    itens, vistos = [], {}
    for arq in arquivos:
        nome, dados = arq[0], arq[1]
        origem = arq[2] if len(arq) > 2 else None
        g = parse_gpx(dados)
        dup_de = vistos.get(g['hash'])
        if dup_de is None:
            vistos[g['hash']] = nome
        itens.append({'nome': nome, 'gpx': g, 'duplicata_de': dup_de,
                      'origem': origem})

    # 2) identificação por coordenada
    for it in itens:
        if it['duplicata_de']:
            it.update(dispositivo=None, cobertura=None, dist_min=None)
            continue
        d, cob, dist = identificar_dispositivo(it['gpx']['points'], dispositivos)
        identificado = d is not None and dist is not None and (
            cob > 0 or dist <= DIST_MAX_IDENTIFICACAO)
        it['dispositivo'] = d if identificado else None
        it['mais_proximo'] = d
        it['cobertura'] = cob
        it['dist_min'] = dist

    # 3) agrupar por dispositivo e montar relatório + zip
    grupos = {}
    for it in itens:
        if it.get('dispositivo'):
            grupos.setdefault(it['dispositivo']['name'], []).append(it)

    saida = io.BytesIO()
    zf = zipfile.ZipFile(saida, 'w', zipfile.ZIP_DEFLATED)
    rel = {'gerado_em': datetime.now().isoformat(timespec='seconds'),
           'grupos': [], 'nao_identificados': [], 'duplicatas': [],
           'mapa_renomeacao': {}}

    disp_por_nome = {d['name']: d for d in dispositivos}
    for nome_disp, membros in sorted(grupos.items(),
                                     key=lambda kv: disp_por_nome[kv[0]]['km_m']):
        d = disp_por_nome[nome_disp]
        corte, dist_corte = corte_do_dispositivo(d, cortes)
        uniao = cobertura_uniao([m['gpx']['points'] for m in membros], d)
        if corte:
            base = nomenclatura(corte, d)
            status_corte = f"{corte['corte']} ({corte['sentido'] or 'sentido a definir'})"
        else:
            base = f"SEM CORTE NA PLANILHA - Dispositivo {fmt_km(d['km_m'])}"
            status_corte = 'NÃO está na planilha — verificar'
        situacao = ('COMPLETO' if uniao >= COBERTURA_COMPLETA else
                    'PARCIAL' if uniao >= COBERTURA_PARCIAL else 'INSUFICIENTE')

        membros_ord = sorted(membros,
                             key=lambda m: m['gpx']['primeiro_ts'] or datetime.min)

        # pares simultâneos (início <= 120 s de diferença) = provável
        # gravação interno+externo rodando junto
        avisos, pares = [], 0
        for i in range(len(membros_ord) - 1):
            t1 = membros_ord[i]['gpx']['primeiro_ts']
            t2 = membros_ord[i + 1]['gpx']['primeiro_ts']
            if t1 and t2 and abs((t2 - t1).total_seconds()) <= 120:
                pares += 1
        origens = {m['origem'] for m in membros_ord}
        if pares and origens == {None}:
            avisos.append(f'{pares} par(es) simultâneo(s) detectado(s) — '
                          'provável interno+externo; separe as pastas de '
                          'origem para o sistema nomear cada um.')

        nomes_novos = []
        # separa por origem quando conhecida; senão, um grupo único
        subgrupos = {}
        for m in membros_ord:
            subgrupos.setdefault(m['origem'], []).append(m)
        for origem, subm in subgrupos.items():
            suf = f' {origem}' if origem else ''
            if len(subm) == 1:
                novo = f'{base}{suf}.gpx'
                zf.writestr(novo, subm[0]['gpx']['raw'])
                rel['mapa_renomeacao'][subm[0]['nome']] = novo
                nomes_novos.append(novo)
            else:
                for i, m in enumerate(subm, 1):
                    novo = f'originais/{base}{suf} parte {i}.gpx'
                    zf.writestr(novo, m['gpx']['raw'])
                    rel['mapa_renomeacao'][m['nome']] = novo
                    nomes_novos.append(novo)
                unido = mesclar_gpx(subm).replace('{nome}', base + suf)
                zf.writestr(f'{base}{suf}.gpx', unido)
                nomes_novos.append(f'{base}{suf}.gpx (unido)')

        rel['grupos'].append({
            'dispositivo': d['name'], 'km': fmt_km(d['km_m']),
            'corte': status_corte, 'situacao': situacao,
            'cobertura_uniao_pct': uniao,
            'arquivos_originais': [m['nome'] for m in membros_ord],
            'arquivos_gerados': nomes_novos,
            'origens': sorted(o or 'desconhecida' for o in origens),
            'avisos': avisos,
            'dist_km_planilha_m': dist_corte,
        })

    for it in itens:
        if it['duplicata_de']:
            rel['duplicatas'].append({'arquivo': it['nome'],
                                      'igual_a': it['duplicata_de']})
        elif not it.get('dispositivo'):
            mp = it.get('mais_proximo')
            rel['nao_identificados'].append({
                'arquivo': it['nome'],
                'mais_proximo': mp['name'] if mp else None,
                'dist_min_m': it.get('dist_min'),
            })
            zf.writestr(f"nao_identificados/{it['nome'].split('/')[-1]}",
                        it['gpx']['raw'])

    zf.writestr('relatorio.json',
                json.dumps(rel, ensure_ascii=False, indent=1))
    zf.close()
    return rel, saida.getvalue()


def _origem(caminho):
    c = caminho.lower()
    if 'intern' in c:
        return 'INTERNO'
    if 'extern' in c:
        return 'EXTERNO'
    return None


def extrair_gpx_de_upload(nome, dados):
    """Aceita .gpx direto ou .zip com vários; retorna lista (nome, bytes, origem).
    Origem (INTERNO/EXTERNO) vem do caminho da pasta/arquivo, quando houver."""
    if nome.lower().endswith('.zip') or dados[:2] == b'PK':
        out = []
        with zipfile.ZipFile(io.BytesIO(dados)) as z:
            for n in z.namelist():
                if n.lower().endswith('.gpx') and not n.startswith('__MACOSX'):
                    out.append((n, z.read(n), _origem(nome + '/' + n)))
        return out
    if nome.lower().endswith('.gpx'):
        return [(nome, dados, _origem(nome))]
    return []
