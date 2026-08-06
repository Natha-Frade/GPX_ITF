# Módulo de Validação — Documentação Técnica

Como o GPX IMTRAFF decide se um trecho de rodovia foi realmente filmado.

- **Arquivos:** `validacao/engine.py` (motor, ~35 KB), `validacao/router.py` (API), `static/validacao.html` (tela)
- **Dependências:** só `openpyxl`. Todo o resto é biblioteca padrão do Python.

---

## 1. O problema que ele resolve

O trabalho de campo produz dois lados que precisam bater:

- **O que era pra ser filmado** — a planilha de filmagem, que lista cortes com km inicial e km final.
- **O que foi filmado de verdade** — os arquivos GPX extraídos das GoPro, que só contêm coordenadas e horários.

Ninguém quer conferir isso a olho. O módulo cruza os dois lados automaticamente e responde, para cada corte: **foi coberto? quanto? por qual câmera? e onde ficaram os buracos?**

### Por que não dá pra comparar km direto

A ideia ingênua seria "o GPX diz km 215, o corte vai de 215 a 240, então bate". Não funciona, por três motivos:

1. **O GPX não sabe o km.** Ele só tem latitude e longitude. Alguém precisa traduzir coordenada em quilometragem.
2. **A numeração de km não é uma régua confiável.** Ela reinicia na divisa entre estados, tem saltos, e há trechos numerados como "1 km" que não medem 1.000 metros de verdade.
3. **Duas pistas, um km.** Ida e volta têm a mesma numeração em posições geográficas diferentes.

A solução do módulo é usar um **eixo linear próprio**, explicado a seguir.

---

## 2. A ideia central: o eixo de offset

O motor não trabalha com km. Ele monta uma régua interna medida em **metros acumulados** ao longo da rodovia, e chama isso de **offset**.

```
marcos do KMZ:   km 215      km 216      km 217      km 218
offset (metros):    0          1002        1998        3050
```

O offset é a distância real percorrida entre os marcos, medida geograficamente. Ele é sempre crescente e sempre contínuo — não tem saltos nem reinícios.

Todo o cálculo acontece nesse eixo. O km só volta a aparecer na hora de mostrar o resultado na tela.

> Isso está dito no cabeçalho do próprio `engine.py`: *"O eixo linear da rota é a distância acumulada entre os marcos, não a diferença de numeração — a numeração tem saltos e trechos que não medem 1 km de verdade."*

**Conversões entre os dois mundos:**

| função | faz |
|---|---|
| `projetar(rota, lat, lon)` | coordenada → offset (+ distância até a rodovia) |
| `km_do_offset(rota, off)` | offset → km, para exibir |
| `offsets_do_km(rota, km)` | km → offset(s); pode devolver vários (ver §4.2) |

---

## 3. As três entradas

### 3.1 KMZ — os marcos quilométricos (`parse_kmz`)

O KMZ do Google Earth traz os marcos de km. É a régua do sistema: **sem ele, nada funciona**.

O parser aceita `.kmz` (zip) ou `.kml` puro, e o agrupamento funciona assim:

- **Rodovia** — vem do **nome da pasta (`Folder`)**, que precisa conter o padrão `BR-999`, `BR 999` ou `BR999` (ex.: `Marcos_km_BR116`). Pasta sem esse padrão no nome é **inteiramente ignorada**. É o erro mais comum de configuração.
- **Km do marco** — vem do **início do nome do Placemark**, que precisa começar com o número inteiro do km. A regex é `^\s*(\d{1,4})\s*(.*)$`.
- **Pista oposta** — o que sobra depois do número marca o marco como pista alternativa (`alt=True`). Ou seja, `224` é o marco principal e `224 Norte` é o da pista oposta.

> **Atenção a uma limitação real:** aqui o km é lido como **inteiro**, não como estaca. Um marco chamado `215+000` é lido como km **215**; o `+000` cai no campo `alt` e ainda faz o marco ser tratado como pista oposta. Marcos do tipo `215+500` teriam o mesmo problema. Este parser foi escrito para KMZ de marcos inteiros (um marco por quilômetro), que é o formato usado no projeto — e isso é suficiente, porque a precisão fina vem do offset em metros (§2), não da numeração.
>
> Isso é **independente** do parser de estaca do lado do navegador (`static/js/kmz.js`), que entende `km 118+740` e é usado nas Marcações. São dois caminhos separados: este é o do backend de validação.

A normalização (`_normalizar_rodovia`) aceita variações como `BR-116`, `BR116` e `br 116`, unificando-as numa forma só.

> **Limitação:** a regex é `^(BR)-?(\d{3})$` — **só rodovias federais BR com três dígitos**. `SP-070`, `MG-050` ou qualquer estadual retorna `None` e a linha/pasta é descartada silenciosamente, tanto no KMZ quanto na planilha. Se o projeto passar a incluir rodovias estaduais, é essa regex (e a busca `BR[-\s]?\d{3}` no nome da pasta, em `parse_kmz`) que precisa ser ampliada.

### 3.2 Planilha de filmagem — os cortes esperados (`parse_planilha`)

Lê **apenas quatro colunas**, por posição fixa:

| coluna | conteúdo | exemplo |
|---|---|---|
| **B** | trecho / rodovia | `BR-116` |
| **C** | pista / faixa | `Norte` |
| **D** | km inicial | `215+000` |
| **E** | km final | `240+023` |

A coluna A, quando existe, vira o rótulo da linha. Linhas sem rodovia válida em B ou sem km em D/E são **puladas em silêncio** — é o que permite jogar a planilha inteira, com cabeçalhos e linhas de título, sem pré-limpeza.

O `parse_km_planilha` aceita tanto estaca (`215+000`) quanto número decimal (`215,0`).

### 3.3 GPX — o que foi filmado (`extrair_gpx_de_upload`)

Aceita `.gpx` solto ou `.zip` (com recursão, ou seja, zip dentro de zip). De cada arquivo interessam as coordenadas e os horários.

Dois detalhes práticos:

- **Câmera** — o módulo procura "intern" ou "extern" no nome do arquivo ou da pasta e classifica como `INTERNO` / `EXTERNO`. Se não achar, marca `N/D`.
- **Nome do vídeo** — `nome_video()` reduz `GX011550-002_1_GPS5.gpx` para `GX011550`, para agrupar os pedaços de um mesmo vídeo.

---

## 4. Montagem da rota (a parte mais delicada)

### 4.1 Encadear marcos numa linha contínua (`montar_rota`)

Um monte de pontos soltos não é uma rodovia. É preciso descobrir a ordem deles. O algoritmo tem duas fases:

**Fase 1 — cadeias por continuidade.** Percorre os marcos em ordem de km e vai encaixando cada um na cadeia cujo último ponto está geograficamente mais perto. Duas travas evitam encaixe errado:

- salto de mais de 3 na numeração interrompe a cadeia;
- a folga de distância aceita é `4000 m × (salto de km)` — marcos consecutivos ficam a ~1 km, e a tolerância cresce proporcionalmente ao pulo.

**Fase 2 — costurar as cadeias.** Como a numeração reinicia na divisa, sobram várias cadeias. Elas são unidas pelas **pontas mais próximas**, testando as quatro combinações possíveis (cada cadeia pode entrar na ordem normal ou invertida). Cadeia cuja ponta mais próxima esteja a mais de 5 km é descartada — não faz parte daquela rodovia.

No fim, calcula o offset acumulado de cada marco.

### 4.2 Por que o mesmo km aparece duas vezes

Com a numeração reiniciando na divisa, "km 100" pode existir em dois lugares da rota. Por isso `offsets_do_km` devolve uma **lista**, e `localizar_corte` escolhe o par certo assim:

```python
return min(((a, b) for a in ini for b in fim), key=lambda p: abs(p[1] - p[0]))
```

Ou seja: entre todas as combinações de início e fim, fica com **o menor trecho contíguo**. Um corte é um pedaço curto de estrada, não uma volta pelo país inteiro.

### 4.3 Variantes — a pista oposta (`montar_variantes`)

Pistas separadas (ida e volta) têm a **mesma numeração** em posições geográficas diferentes. É para isso que serve o campo `alt` dos marcos (§3.1): marcos como `224 Norte` descrevem a pista oposta.

O mecanismo é elegante: a variante **compartilha o eixo de offsets da rota principal** e só troca a geometria (lat/lon) onde as pistas se separam. Como a numeração é a mesma, o offset continua válido — muda apenas onde o ponto está no mapa.

A trava `JUNCAO_MAX = 3000 m` impede um erro sutil: como o mesmo número de km aparece em séries diferentes da rodovia (por causa dos reinícios), o marco da pista oposta só é aceito se estiver **fisicamente ao lado** do marco principal. Sem isso, a geometria de uma série seria clonada em cima de outra.

Na hora de projetar, `projetar_trilha` testa **todas** as variantes e fica com a de menor desvio — é assim que uma filmagem na pista sul não é penalizada por os marcos estarem na pista norte.

---

## 5. Projeção: de coordenada para offset

### 5.1 Projetar um ponto (`projetar`)

Acha o marco mais próximo, testa os dois segmentos vizinhos e projeta o ponto perpendicularmente sobre o segmento (projeção escalar clássica, com `t` limitado a `[0,1]` para não sair do segmento). Devolve o offset e a distância até a rodovia.

Essa distância é a métrica de qualidade: `DIST_MAX_ROTA = 120 m`. Além disso, o ponto não é considerado "na rodovia".

### 5.2 Escolher a rodovia certa (`projetar_trilha`)

Com vários KMZ carregados, o módulo projeta a trilha em **todas** as rodovias e calcula um score:

```
score = pontos com desvio < 120 m / total de pontos
```

Vence a rodovia de maior score. Abaixo de `0.2`, o GPX é rejeitado com o motivo *"trilha não bate com nenhuma rodovia do KMZ"* — é assim que um GPX de outro projeto não contamina o relatório.

### 5.3 Transformar pontos em intervalos percorridos (`_intervalos`)

Este é o ponto mais sutil do módulo. Uma sequência de offsets não é automaticamente um trecho percorrido: o GPS oscila, salta e, onde as pistas se separam, a projeção pula de uma para outra.

A regra usada é **física, baseada em tempo**:

```python
limite = max(SALTO_MIN, min(V_MAX * dt, SALTO_MAX))
if abs(b - a) <= limite:
    segs.append((min(a, b), max(a, b)))
```

Traduzindo: entre dois pontos consecutivos, aceita-se no máximo a distância que o carro **conseguiria percorrer naquele tempo** a 216 km/h (`V_MAX = 60 m/s`). Um piso de 1.500 m absorve a oscilação entre pistas; um teto de 20 km evita que uma pausa longa na gravação vire cobertura fantasma.

O resultado passa por `_uniao`, que funde intervalos sobrepostos.

---

## 6. Cruzamento e decisão do status (`validar_lote`)

### Etapa 1 — cada GPX vira um intervalo

Para cada arquivo: faz o parse, projeta, e guarda rodovia, intervalos cobertos, km inicial/final, horários e o **desvio mediano** (indicador de qualidade do GPS). GPX que falha em qualquer etapa vai para a lista `ignorados`, **com o motivo** — nunca some em silêncio.

### Etapa 2 — cada corte recebe seus vídeos

Para cada corte da planilha, localiza o trecho `[a, b]` na rota e mede quanto cada vídeo cobre dele com `_medir`. Vídeo que cobre menos de 200 m é descartado como ruído.

A cobertura é calculada **por câmera** e **no total**:

```python
cobertura_cam[cam] = _medir(intervalos_da_camera, a, b) / extensao
cobertura          = _medir(todos_os_intervalos,  a, b) / extensao
```

### Etapa 3 — o status

| status | condição |
|---|---|
| **FECHADO** | cobertura ≥ 99% **e** nenhuma câmera (INTERNO/EXTERNO) abaixo de 99% |
| **PARCIAL** | entre 5% e 99%, ou uma das câmeras incompleta |
| **NÃO FILMADO** | cobertura < 5% |
| **SEM REFERÊNCIA** | rodovia ausente no KMZ, km fora dos marcos, ou km inicial igual ao final |

O detalhe que merece atenção: **cobertura total de 100% não garante FECHADO**. Se o interno cobriu tudo e o externo só metade, o corte é PARCIAL. A checagem `faltando_cam` existe justamente para isso — é o caso real de campo em que uma câmera falhou sem ninguém perceber.

Saídas reais do motor, para um corte de 205+000 a 210+000:

| cenário | status | cobertura | observação gerada |
|---|---|---|---|
| interno + externo cobrindo tudo | `FECHADO` | 100% | `100% coberto: 205+000 → 210+000` |
| só o interno enviado | `PARCIAL` | **100%** | `100.0% coberto: 205+000 → 210+000. sem vídeo externo` |
| interno 100%, externo na metade | `PARCIAL` | **100%** | `100.0% coberto: ... externo cobre 50.0%, falta 207+500 → 210+000` |
| interno cobrindo metade | `PARCIAL` | 50% | `50.0% coberto: 212+000 → 216+000. faltam 4.003 km: 216+000 → 220+000` |
| nenhum vídeo no trecho | `NÃO FILMADO` | 0% | `Nenhum vídeo cobre este corte — faltam os 3.002 km: ...` |

Note as duas linhas do meio: cobertura 100% e ainda assim PARCIAL. É intencional e é um dos pontos mais valiosos do módulo.

**SEM REFERÊNCIA não é um erro do campo.** É o sistema dizendo que não consegue opinar: ou o KMZ não cobre aquela rodovia, ou os km da planilha estão fora do alcance dos marcos.

### Etapa 4 — a observação em texto

Em vez de só um percentual, a observação diz **onde**:

```
87.3% coberto: km 215+000 → 232+400. faltam 7.623 km: km 232+400 → 240+023.
externo cobre 61.2%, falta km 228+100 → 240+023
```

Quem gera isso é `_faixas_km`, que converte as faixas de offset de volta para km. Ele respeita o sentido do corte: se o km é decrescente, o texto sai decrescente também. Mostra até 6 faixas e resume o resto como "+N trecho(s)".

Buracos menores que `BURACO_MIN = 200 m` são ignorados — são ruído de GPS, não pendência real de campo.

---

## 7. O relatório

`validar_lote` devolve um dicionário com seis blocos:

| bloco | conteúdo |
|---|---|
| `resumo` | contagens: fechados, parciais, não filmados, sem referência, GPX lidos/ignorados/sobrando |
| `linhas` | uma linha por corte da planilha, com status, cobertura e observação |
| `detalhes` | um registro por par corte×vídeo: km cobertos, percentual, dia, hora inicial e final |
| `pendencias` | os buracos, prontos para virar ordem de re-filmagem |
| `sobrando` | GPX válidos que não caíram em nenhum corte da planilha |
| `ignorados` | arquivos rejeitados, **com o motivo** |

`sobrando` e `ignorados` existem para fechar a conta: todo arquivo enviado aparece em algum lugar. Isso evita a pior falha possível num relatório de conferência — um vídeo sumir sem ninguém notar.

O `exportar_xlsx` gera a planilha com as abas correspondentes e pinta os status (verde = fechado, amarelo = parcial, vermelho = não filmado, cinza = sem referência).

---

## 8. A API (`router.py`)

| método | rota | função |
|---|---|---|
| GET | `/validacao` | serve a tela |
| POST | `/validacao/referencia/kmz` | carrega os marcos |
| POST | `/validacao/referencia/planilha` | carrega os cortes |
| GET | `/validacao/referencia/status` | o que já está carregado |
| GET | `/validacao/consulta-km?ini=&fim=&trecho=` | quais vídeos cobrem um km/intervalo |
| GET | `/validacao/trechos` | lista as rodovias disponíveis |
| POST | `/validacao/consulta-gpx` | manda um GPX, recebe km estimado + vídeos |
| POST | `/validacao/lote` | validação completa; devolve `lote_id` |
| GET | `/validacao/lote/{id}/xlsx` | baixa o relatório |

As referências (KMZ e planilha) ficam persistidas em disco, no diretório definido pela variável de ambiente `VALIDACAO_DATA_DIR` (padrão: `data_validacao/`), como `marcos.json` e `cortes.json`. São carregadas uma vez e reaproveitadas entre requisições.

> **No Railway:** o sistema de arquivos é efêmero, então **um redeploy apaga as referências** — é só reenviar o KMZ e a planilha pela tela. Se quiser que sobrevivam, aponte `VALIDACAO_DATA_DIR` para um volume persistente.

Os relatórios de lote são gravados como `lote_<timestamp>.json` e `.xlsx` no mesmo diretório, e o `lote_id` devolvido pelo `POST /validacao/lote` é o que permite baixar o XLSX depois.

---

## 9. Parâmetros ajustáveis

Todos no topo do `engine.py`:

| constante | valor | significado | quando mexer |
|---|---|---|---|
| `DIST_MAX_ROTA` | 120 m | distância máxima do ponto à rodovia | aumentar em pista dupla muito larga |
| `V_MAX` | 60 m/s | velocidade máxima plausível | dificilmente |
| `SALTO_MIN` | 1500 m | costura oscilação entre pistas | aumentar se as pistas forem muito separadas |
| `SALTO_MAX` | 20000 m | teto por intervalo de tempo | reduzir para ser mais rigoroso com pausas |
| `TOL_FECHADO` | 0.99 | mínimo para FECHADO | baixar para 0.95 se 99% for rígido demais |
| `TOL_PARCIAL` | 0.05 | abaixo disso é NÃO FILMADO | — |
| `BURACO_MIN` | 200 m | buraco menor é ruído | subir se aparecer pendência falsa demais |
| `JUNCAO_MAX` | 3000 m | alcance do marco da pista oposta | — |
| `FAIXAS_NA_OBS` | 6 | faixas de km por observação | subir se quiser observação mais detalhada |

---

## 10. Diagnóstico de problemas

**"O KMZ não tem marcos de km suficientes para montar a rota"**
O parser não achou marcos com km numérico. Verifique se os Placemark têm o km no nome (`215+000`, `km 215`) ou num `SimpleData`, e se o nome da pasta contém a rodovia.

**Muitos cortes como SEM REFERÊNCIA**
O KMZ não cobre a faixa de km da planilha, ou a rodovia da coluna B está escrita de forma que não bate com a pasta do KMZ. Confira em `/validacao/referencia/status` quais rodovias foram reconhecidas.

**GPX ignorado com "trilha não bate com nenhuma rodovia"**
Score abaixo de 0.2 — menos de 20% dos pontos ficaram a menos de 120 m da rodovia. Ou o GPX é de outro trecho, ou o GPS estava ruim. O campo `desvio_mediano` em `detalhes` ajuda a distinguir os dois casos.

**Cortes PARCIAL com percentual estranhamente baixo**
Costuma ser pista separada: a trilha foi projetada na pista oposta. Verifique se o KMZ tem os marcos das duas pistas; se tiver, as variantes resolvem.

**Cobertura 100% mas status PARCIAL**
É intencional. Uma das câmeras (INTERNO/EXTERNO) está abaixo de 99%. A observação diz qual e quanto falta.

---

## 11. Resumo do fluxo

```
KMZ ─────────► parse_kmz ──► montar_rota ──► ROTA (eixo em metros)
                                                  │
Planilha ────► parse_planilha ──► cortes ──► localizar_corte ──► [a, b]
                                                  │
GPX ─────────► parse_gpx ──► projetar_trilha ──► intervalos
                                                  │
                                                  ▼
                                    _medir / _buracos / _cobertos
                                                  │
                                                  ▼
                              status + observação + pendências
                                                  │
                                                  ▼
                                    relatório JSON  →  XLSX
```

---

## 12. Nota sobre esta documentação

Escrita a partir da leitura do código em `validacao/engine.py` e `validacao/router.py`, com os comportamentos **verificados executando o motor**:

- as rotas da API foram conferidas no `openapi.json` do servidor rodando;
- `fmt_km`, `parse_km_planilha` e `_normalizar_rodovia` foram testados com valores reais (foi assim que apareceu a limitação de só aceitar `BR-`);
- os quatro status foram reproduzidos num lote sintético (KMZ com 31 marcos + planilha com 3 cortes + GPX gerados), incluindo o caso de 100% de cobertura com câmera faltando;
- a limitação do `parse_kmz` com marcos em estaca foi confirmada lendo a regex `^\s*(\d{1,4})\s*(.*)$`.
