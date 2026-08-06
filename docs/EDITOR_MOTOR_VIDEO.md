# Editor — conserto do carregamento do motor de vídeo

## O sintoma

```
não consegui baixar o motor de vídeo (rede bloqueou os CDNs): undefined
```

## O diagnóstico

A mensagem mentia em duas frentes.

**1. Não era CDN.** O texto veio do `editor-src`, onde a lista de origens
tem três entradas (`/vendor/ffmpeg`, unpkg, jsdelivr). Mas o bundle que
roda em produção foi editado à mão depois do build e tinha **uma origem
só**, local:

```js
ig = ["/vendor/ffmpeg-esm"]
```

Nenhuma requisição saía para a internet. A rede da empresa não tinha
nada a ver com a falha.

**2. O `undefined` era o erro sendo engolido.** O worker do ffmpeg.wasm
responde erro assim:

```js
self.postMessage({ type: ERROR, data: c.toString() })   // <- uma STRING
```

E o carregador lia `s.message` desse retorno. String não tem `.message`,
então saía `undefined` — e o motivo real morria ali. Qualquer falha, de
qualquer natureza, produzia exatamente essa mesma tela inútil.

**3. A causa provável.** O worker é criado com `{ type: "module" }`.
Dentro de um *module worker* a função `importScripts` **não existe**.
O código original tratava isso com um único fallback:

```js
try { importScripts(t) }
catch { self.createFFmpegCore = (await import(t)).default; ... }
```

Ou seja: só funcionava se o core tivesse `export default`. O
`/vendor/ffmpeg-esm/ffmpeg-core.js` tem — os outros dois cores
vendorizados (`/vendor/ffmpeg` e `/vendor/ffmpeg-mt`) são **UMD**, sem
`export default`. Sem alternativa e sem fallback, qualquer tropeço no
core ESM derrubava tudo.

## O que foi mudado

Três arquivos novos, em versão `v3`. **Os `v2` continuam no lugar,
intactos.**

### `static/editor/assets/worker-BAOIWoxAv3.js`

Nova função `carregaCore(url)` com três caminhos, em ordem:

1. `importScripts` — worker clássico, core UMD;
2. `import(url)` — module worker, core ESM (`export default`);
3. **novo:** module worker, core UMD — busca o texto com `fetch`,
   acrescenta `export default createFFmpegCore;`, embrulha num `Blob` e
   importa como módulo.

O caminho 3 é o que faltava e é o que torna `/vendor/ffmpeg` e
`/vendor/ffmpeg-mt` utilizáveis como reserva.

O handler de erro passou a mandar `c.stack` quando existe, em vez de só
`c.toString()`.

### `static/editor/assets/index-IiQcigx_v3.js`

- aponta para o `worker-BAOIWoxAv3.js`;
- três origens em vez de uma:
  `["/vendor/ffmpeg-esm", "/vendor/ffmpeg-mt", "/vendor/ffmpeg"]`
  — as três locais, nenhuma na internet;
- guarda o erro de **cada** origem e mostra todos na tela, além de
  `console.error` com o objeto de erro inteiro.

### `static/editor/index.html`

Passou a carregar `index-IiQcigx_v3.js` e `index-BvvRnNwev3.css`.

## Como voltar atrás

Uma linha. Em `static/editor/index.html`, troque `v3` por `v2` nas duas
tags. Os arquivos antigos não foram apagados.

## O que NÃO foi mexido

- `editor-src/` — nada. O bundle em produção está à frente do fonte
  (foi editado à mão depois do build), então **um `npm run build` hoje
  desfaz este conserto**. Se for rebuildar, aplique a mesma lógica em
  `editor-src/src/services/export/ffmpeg.js` antes.
- `static/vendor/` — nenhum byte alterado. Os três cores continuam os
  mesmos.

## Se ainda falhar

Agora a tela mostra o erro de verdade, uma linha por origem tentada, e o
Console do navegador (F12) tem o objeto completo. Com essa saída dá para
apontar a causa exata em vez de adivinhar.
