// video-export.js
// Corte e junção de video no navegador usando ffmpeg.wasm.
// - Corte com stream copy (-c copy): sem re-encode, sem perda, rápido.
//   O ponto de corte alinha ao keyframe anterior (~1s na GoPro).
// - O arquivo de entrada é montado (WORKERFS), não copiado: funciona
//   com videos de varios GB. Só o trecho de SAIDA precisa caber na
//   memoria (limite pratico ~1.5 GB por trecho).
// - Motor baixado sob demanda do CDN (~31 MB, fica em cache).

(function () {
  'use strict';

  // Fontes do motor, em ordem de tentativa:
  //  1) LOCAL — hospedado no próprio app (static/vendor/ffmpeg, ver
  //     Dockerfile) → funciona mesmo com a rede da empresa bloqueando CDN;
  //  2/3) CDNs públicos como fallback (uso local sem o vendor baixado).
  const CDNS = [
    {
      ffmpeg: '/vendor/ffmpeg/ffmpeg.js',
      util:   '/vendor/ffmpeg/util.js',
      core:   '/vendor/ffmpeg-mt',   // core MULTI-THREAD (bem mais rápido)
      worker: '/vendor/ffmpeg-mt/ffmpeg-core.worker.js',
      mt:     true,
      local:  true,
    },
    {
      ffmpeg: '/vendor/ffmpeg/ffmpeg.js',
      util:   '/vendor/ffmpeg/util.js',
      core:   '/vendor/ffmpeg',      // core single-thread (fallback)
      local:  true,
    },
    {
      ffmpeg: 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js',
      util:   'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js',
      core:   'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
    },
    {
      ffmpeg: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js',
      util:   'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js',
      core:   'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
    },
  ];

  let _loadPromise = null;
  let _ffmpeg = null;
  let _ffmpegMT = false;
  let _cancelado = false;

  // ── Carregamento sob demanda ─────────────────────────────────────────
  function _injectScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = () => rej(new Error('Falha ao baixar ' + src));
      document.head.appendChild(s);
    });
  }

  // Traduz qualquer coisa lancada (Error, ErrorEvent de Worker, string,
  // objeto solto) numa mensagem legivel. Falhas vindas do worker do ffmpeg
  // chegam como EVENTO, sem .message — era isso que virava "Erro: undefined".
  function _erroTexto(e) {
    if (!e) return 'erro desconhecido';
    if (typeof e === 'string') return e;
    if (e.message) return e.message;
    if (e.type) return 'falha no worker do ffmpeg (evento "' + e.type + '")';
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }
  window._ffErroTexto = _erroTexto;

  async function _ensureFFmpeg(onStatus) {
    if (_ffmpeg) return _ffmpeg;
    if (!_loadPromise) {
      _loadPromise = (async () => {
        onStatus && onStatus('Carregando motor de vídeo...');
        const tentativas = [];
        for (const cdn of CDNS) {
          try {
            // O core multi-thread só funciona com cross-origin isolation
            // (SharedArrayBuffer). Se não estiver disponível, pula p/ o
            // single-thread.
            if (cdn.mt && !self.crossOriginIsolated) {
              throw new Error('sem cross-origin isolation p/ multi-thread');
            }
            if (cdn.local) {
              // só tenta o vendor local se ele realmente existir no servidor
              const head = await fetch(cdn.core + '/ffmpeg-core.js', { method: 'HEAD' }).catch(() => null);
              if (!head || !head.ok) throw new Error('vendor local ausente');
            } else {
              onStatus && onStatus('Baixando motor de vídeo do CDN (primeira vez ~31 MB)...');
            }
            if (!window.FFmpegWASM) await _injectScript(cdn.ffmpeg);
            if (!window.FFmpegUtil) await _injectScript(cdn.util);
            const { FFmpeg } = window.FFmpegWASM;
            const { toBlobURL } = window.FFmpegUtil;
            const ff = new FFmpeg();
            const cfg = {
              coreURL: await toBlobURL(cdn.core + '/ffmpeg-core.js', 'text/javascript'),
              wasmURL: await toBlobURL(cdn.core + '/ffmpeg-core.wasm', 'application/wasm'),
            };
            if (cdn.mt && cdn.worker) {
              onStatus && onStatus('Carregando motor de vídeo (multi-thread, mais rápido)...');
              cfg.workerURL = await toBlobURL(cdn.worker, 'text/javascript');
            }
            await ff.load(cfg);
            _ffmpeg = ff;
            _ffmpegMT = !!cdn.mt;
            return ff;
          } catch (e) {
            const motivo = _erroTexto(e);
            console.error('[ffmpeg] falhou em ' + cdn.core + ':', e);
            tentativas.push(cdn.core + ': ' + motivo);
            onStatus && onStatus('Tentando outra configuração do motor...');
          }
        }
        throw new Error('Não consegui carregar o motor de vídeo.\n' + tentativas.join('\n'));
      })().catch(e => { _loadPromise = null; throw e; });
    }
    return _loadPromise;
  }

  // ── Monta os arquivos de entrada sem copiar para a memória ──────────
  async function _mount(ff, files) {
    try {
      await ff.createDir('/work');
      await ff.mount('WORKERFS', { files }, '/work');
      return { dir: '/work', mounted: true };
    } catch (e) {
      // Fallback: copia para o FS em memória (só seguro p/ arquivos menores)
      const total = files.reduce((s, f) => s + f.size, 0);
      if (total > 1.6 * 1024 * 1024 * 1024) {
        throw new Error('Vídeo grande demais para este navegador sem WORKERFS. ' +
          'Use Chrome/Edge atualizados.');
      }
      const { fetchFile } = window.FFmpegUtil;
      for (const f of files) await ff.writeFile('/' + f.name, await fetchFile(f));
      return { dir: '', mounted: false };
    }
  }

  async function _unmount(ff, m, files) {
    try {
      if (m.mounted) { await ff.unmount('/work'); await ff.deleteDir('/work'); }
      else for (const f of files) await ff.deleteFile('/' + f.name).catch(() => {});
    } catch (_) {}
  }

  function _baixarBlob(u8, nome) {
    _baixarBlobDireto(new Blob([u8.buffer], { type: 'video/mp4' }), nome);
  }

  function _baixarBlobDireto(blob, nome) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  const _fmtT = s => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(3);
    return `${h}:${String(m).padStart(2, '0')}:${sec.padStart(6, '0')}`;
  };

  // ── NÚCLEO: corta e devolve Blobs (usado pelo export e pelo handoff) ─
  // cuts: [{startSec, endSec}], file: File do vídeo carregado
  // modo: 'reencode' (padrão) -> H.264 universal, abre no Windows Media
  //        Player; mais lento (usado no DOWNLOAD do .mp4 final).
  //       'copy' -> corte rápido em stream-copy, SEM re-encode; usado no
  //        envio para o EDITOR, que reprocessa o vídeo internamente na
  //        hora de exportar (então não precisa do re-encode aqui — era o
  //        que travava "meia hora" ao mandar pro editor).
  // retorna [{ nome, blob }]
  async function videoCortarParaBlobs(file, cuts, onStatus, onProgress, modo, semAudio) {
    if (!file) throw new Error('Nenhum vídeo carregado.');
    if (!cuts || !cuts.length) throw new Error('Nenhum corte definido na timeline.');
    _cancelado = false;
    const rapido = modo === 'copy';
    // Quando 'semAudio' está ligado, trocamos o mapeamento de áudio por
    // -an: o corte sai MUDO (arquivo menor e sem ruído de gravação).
    const mapAudio = semAudio ? ['-an'] : ['-map', '0:a:0?'];

    const ff = await _ensureFFmpeg(onStatus);
    const progHandler = ({ progress }) => onProgress && onProgress(Math.min(1, progress));
    ff.on('progress', progHandler);

    const m = await _mount(ff, [file]);
    const inPath = (m.dir ? m.dir + '/' : '/') + file.name;
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const saida = [];

    try {
      for (let i = 0; i < cuts.length; i++) {
        if (_cancelado) break;
        const c = cuts[i];
        const dur = c.endSec - c.startSec;
        if (dur <= 0) continue;
        onStatus && onStatus(
          (rapido ? 'Preparando' : 'Cortando') + ` trecho ${i + 1}/${cuts.length} ` +
          `(${_fmtT(c.startSec)} → ${_fmtT(c.endSec)})...`);
        const out = `corte_${i + 1}.mp4`;

        const comum = [
          '-ss', _fmtT(c.startSec),
          '-i', inPath,
          '-t', _fmtT(dur),
          '-map', '0:v:0',
          ...mapAudio,
          '-dn',
          '-map_metadata', '-1',
          '-map_chapters', '-1',
        ];

        if (rapido) {
          // Corte RÁPIDO em stream-copy (segundos) para enviar ao EDITOR,
          // que re-encoda depois no export dele. Usa -ss como OUTPUT seek
          // (depois do -i) para o trecho começar no keyframe correto e o
          // preview do editor não ficar preto no frame 0.
          await ff.exec([
            '-i', inPath,
            '-ss', _fmtT(c.startSec),
            '-t', _fmtT(dur),
            '-map', '0:v:0',
            ...mapAudio,
            '-dn',
            '-map_metadata', '-1',
            '-map_chapters', '-1',
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart',
            out,
          ]);
        } else {
          // Corte com RE-ENCODE p/ H.264 + AAC (receita do editor local,
          // backend/app/engine.py -> trim), compatível com Windows Media
          // Player. Mais lento, mas gera um MP4 universal p/ download.
          await ff.exec([
            ...comum,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p',
            '-threads', _ffmpegMT ? '0' : '1',   // 0 = usa todos os núcleos (core-mt)
            ...(semAudio ? [] : ['-c:a', 'aac', '-ar', '48000']),
            '-vsync', 'cfr',
            '-movflags', '+faststart',
            out,
          ]);
        }
        const data = await ff.readFile(out);
        await ff.deleteFile(out).catch(() => {});
        saida.push({
          nome: `${baseName}_corte${i + 1}.mp4`,
          blob: new Blob([data.buffer], { type: 'video/mp4' }),
        });
      }
    } finally {
      ff.off('progress', progHandler);
      await _unmount(ff, m, [file]);
    }
    return saida;
  }

  // ── API pública: exportar cortes como MP4 (download) ─────────────────
  // 1 corte = baixa o .mp4 direto; vários = 1 único .zip (o navegador
  // bloqueia downloads múltiplos em sequência — era um dos motivos da
  // exportação "não funcionar").
  async function videoExportarCortesMP4(file, cuts, onStatus, onProgress, modo, semAudio) {
    const blobs = await videoCortarParaBlobs(file, cuts, onStatus, onProgress, modo, semAudio);
    if (!blobs.length) return 0;

    if (blobs.length === 1 || typeof JSZip === 'undefined') {
      for (const b of blobs) {
        _baixarBlobDireto(b.blob, b.nome);
        // pequeno respiro entre downloads quando não há JSZip
        if (blobs.length > 1) await new Promise(r => setTimeout(r, 900));
      }
      return blobs.length;
    }

    onStatus && onStatus('Empacotando ' + blobs.length + ' cortes num .zip...');
    const zip = new JSZip();
    blobs.forEach(b => zip.file(b.nome, b.blob));
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const base = file.name.replace(/\.[^.]+$/, '');
    _baixarBlobDireto(zipBlob, base + '_cortes.zip');
    return blobs.length;
  }

  // ── API pública: juntar vários vídeos em um só ───────────────────────
  // files: File[] na ordem desejada (ex.: capítulos GX01, GX02...)
  async function videoJuntarMP4(files, onStatus, onProgress) {
    if (!files || files.length < 2) throw new Error('Selecione 2 ou mais vídeos.');
    _cancelado = false;

    const ff = await _ensureFFmpeg(onStatus);
    const progHandler = ({ progress }) => onProgress && onProgress(Math.min(1, progress));
    ff.on('progress', progHandler);

    const m = await _mount(ff, files);
    const pref = m.dir ? m.dir + '/' : '/';
    // Lista para o concat demuxer (aspas simples + escape)
    const lista = files.map(f =>
      "file '" + (pref + f.name).replace(/'/g, "'\\''") + "'").join('\n');
    await ff.writeFile('lista.txt', lista);

    try {
      onStatus && onStatus(`Juntando ${files.length} vídeos (sem re-encode)...`);
      await ff.exec([
        '-f', 'concat', '-safe', '0',
        '-i', 'lista.txt',
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c', 'copy',
        '-movflags', '+faststart',
        'unido.mp4',
      ]);
      const data = await ff.readFile('unido.mp4');
      await ff.deleteFile('unido.mp4').catch(() => {});
      const nome = files[0].name.replace(/\.[^.]+$/, '') + `_unido_${files.length}partes.mp4`;
      _baixarBlob(data, nome);
    } finally {
      ff.off('progress', progHandler);
      await ff.deleteFile('lista.txt').catch(() => {});
      await _unmount(ff, m, files);
    }
    return true;
  }

  // ── Corte LONGO: grava direto no disco, sem acumular na memoria ─────
  //
  // Por que existe: ff.readFile() monta o arquivo inteiro na memoria do
  // wasm antes do download. O wasm e 32-bit (teto ~2 GB), entao um corte
  // de 15 min em 1080p (~3,4 GB) estoura com "Array buffer allocation
  // failed". Aumentar RAM do servidor nao muda nada: o limite e do
  // navegador.
  //
  // Aqui o trecho e cortado em blocos de BLOCO_SEG segundos. Cada bloco e
  // lido, escrito no disco via File System Access API e apagado da memoria
  // do wasm. O pico de memoria fica constante (~1 bloco), independente do
  // corte ter 15 min ou 2 h.
  //
  // A saida e MPEG-TS porque blocos .ts podem ser concatenados por simples
  // anexacao de bytes — e o que torna a gravacao incremental possivel.
  // Continua stream copy (-c copy): qualidade identica, sem re-encode.
  const BLOCO_SEG = 60;

  async function videoCortarStreaming(file, cuts, onStatus, onProgress) {
    if (!window.showSaveFilePicker) {
      throw new Error('Este navegador não permite gravar direto no disco. ' +
        'Use o Chrome ou o Edge para cortes longos.');
    }
    if (!cuts || !cuts.length) throw new Error('Nenhum corte definido.');
    _cancelado = false;

    const ff = await _ensureFFmpeg(onStatus);
    const m = await _mount(ff, [file]);
    const entrada = (m.dir ? m.dir + '/' : '/') + file.name;
    // Guardamos os handles p/ devolver os arquivos gravados sem relê-los
    // pra memoria: handle.getFile() entrega um File por referencia.
    const handles = [];

    try {
      for (let c = 0; c < cuts.length; c++) {
        const cut = cuts[c];
        const ini = Number(cut.startSec) || 0;
        const fim = Number(cut.endSec);
        const dur = fim - ini;
        if (!(dur > 0)) throw new Error('Corte ' + (c + 1) + ' tem duração inválida.');

        const base = file.name.replace(/\.[^.]+$/, '');
        const sugerido = base + '_corte' + (c + 1) + '.ts';

        onStatus && onStatus('Escolha onde salvar o corte ' + (c + 1) + '…');
        const handle = await window.showSaveFilePicker({
          suggestedName: sugerido,
          types: [{ description: 'Vídeo MPEG-TS', accept: { 'video/mp2t': ['.ts'] } }],
        });
        handles.push(handle);
        const stream = await handle.createWritable();

        try {
          const blocos = Math.ceil(dur / BLOCO_SEG);
          for (let b = 0; b < blocos; b++) {
            if (_cancelado) throw new Error('Cancelado pelo usuário.');

            const t0 = ini + b * BLOCO_SEG;
            const t = Math.min(BLOCO_SEG, fim - t0);
            const saida = 'bloco.ts';

            onStatus && onStatus(
              'Corte ' + (c + 1) + '/' + cuts.length +
              ' — bloco ' + (b + 1) + '/' + blocos + ' (sem re-encode)…'
            );

            // -ss antes do -i zera os timestamps de cada bloco. Sem
            // corrigir, todo bloco comeca em 00:00 e o arquivo final tem o
            // tempo reiniciando a cada minuto — o player nao consegue
            // calcular a duracao (aparece 00:00). O -output_ts_offset
            // reposiciona cada bloco no seu instante relativo dentro do
            // corte, deixando a linha do tempo continua.
            await ff.exec([
              '-ss', t0.toFixed(3),
              '-i', entrada,
              '-t', t.toFixed(3),
              '-map', '0:v:0',
              '-map', '0:a:0?',
              '-c', 'copy',
              '-output_ts_offset', (t0 - ini).toFixed(3),
              '-muxdelay', '0',
              '-muxpreload', '0',
              '-f', 'mpegts',
              '-y', saida,
            ]);

            const dados = await ff.readFile(saida);
            await stream.write(dados);
            // Libera imediatamente: e isso que mantem a memoria constante.
            await ff.deleteFile(saida).catch(() => {});

            onProgress && onProgress((c + (b + 1) / blocos) / cuts.length);
          }
        } finally {
          await stream.close();
        }
      }
      onStatus && onStatus(cuts.length + ' corte(s) gravados no disco.');
      const arquivos = [];
      for (const h of handles) { try { arquivos.push(await h.getFile()); } catch (_) {} }
      return arquivos;
    } finally {
      await _unmount(ff, m, [file]);
    }
  }

  // ── Unir varios videos gravando direto no disco ─────────────────────
  //
  // Mesma premissa do corte longo: videoJuntarMP4() monta o resultado
  // inteiro na memoria do wasm (ff.readFile) e estoura os ~2 GB. Dois
  // cortes de 10 min em 1080p somam ~6,8 GB — nao cabe de jeito nenhum.
  //
  // Aqui cada arquivo e percorrido em blocos de BLOCO_SEG segundos,
  // convertido para MPEG-TS com -c copy e anexado ao arquivo de saida. O
  // offset de tempo e acumulado entre os arquivos, entao a linha do tempo
  // final e continua e o player mostra a duracao somada corretamente.
  //
  // Requisito do stream copy: mesmo codec, resolucao e fps em todos.

  // Le a duracao sem carregar o video: so os metadados.
  function _duracaoDe(file) {
    return new Promise((ok, falhou) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        const d = v.duration;
        URL.revokeObjectURL(url);
        (isFinite(d) && d > 0) ? ok(d)
          : falhou(new Error('Não consegui ler a duração de ' + file.name));
      };
      v.onerror = () => {
        URL.revokeObjectURL(url);
        falhou(new Error('Não consegui ler os metadados de ' + file.name));
      };
      v.src = url;
    });
  }

  // Duracao via ffmpeg, lendo o log do "-i". Necessario para .ts: o
  // Chromium nao decodifica MPEG-TS num <video>, entao _duracaoDe falha
  // justamente nos arquivos que o proprio app gera.
  async function _infoViaFFmpeg(ff, file) {
    let texto = '';
    const captura = ({ message }) => { texto += message + '\n'; };
    ff.on('log', captura);
    const m = await _mount(ff, [file]);
    try {
      const entrada = (m.dir ? m.dir + '/' : '/') + file.name;
      // "-i" sozinho termina em erro ("At least one output file must be
      // specified"), mas o cabecalho com a Duration ja foi impresso.
      await ff.exec(['-i', entrada]).catch(() => {});
    } finally {
      ff.off('log', captura);
      await _unmount(ff, m, [file]);
    }
    const m2 = texto.match(
      /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)(?:\s*,\s*start:\s*(-?\d+(?:\.\d+)?))?/);
    if (!m2) throw new Error('Não consegui ler a duração de ' + file.name);
    return {
      dur:   (+m2[1]) * 3600 + (+m2[2]) * 60 + parseFloat(m2[3]),
      start: m2[4] !== undefined ? parseFloat(m2[4]) : 0,
    };
  }

  async function _duracaoViaFFmpeg(ff, file) {
    return (await _infoViaFFmpeg(ff, file)).dur;
  }

  // Concatenacao BINARIA de MPEG-TS.
  //
  // TS foi desenhado para transmissao continua: e uma sequencia de pacotes
  // de 188 bytes autocontidos, sem indice global. Juntar dois .ts e anexar
  // os bytes do segundo no fim do primeiro — o mesmo principio do Unir GPX.
  //
  // Nao passa pelo ffmpeg: sem remux, sem re-encode, sem risco de gerar
  // timestamps invalidos. Le e escreve em pedacos de 8 MB, entao a memoria
  // fica constante independente do tamanho.
  const PEDACO = 8 * 1024 * 1024;

  async function _concatBinario(files, stream, onStatus, onProgress) {
    const total = files.reduce((a, f) => a + f.size, 0);
    let escritos = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      for (let pos = 0; pos < f.size; pos += PEDACO) {
        if (_cancelado) throw new Error('Cancelado pelo usuário.');
        const fim = Math.min(pos + PEDACO, f.size);
        const buf = await f.slice(pos, fim).arrayBuffer();
        await stream.write(new Uint8Array(buf));
        escritos += fim - pos;
        onStatus && onStatus(
          'Unindo ' + (i + 1) + '/' + files.length + ' — ' +
          Math.round((escritos / total) * 100) + '%'
        );
        onProgress && onProgress(escritos / total);
      }
    }
    return total;
  }

  const _ehTS = (f) => /\.(ts|m2ts|mts)$/i.test(f.name);

  async function videoUnirStreaming(files, onStatus, onProgress) {
    if (!window.showSaveFilePicker) {
      throw new Error('Este navegador não permite gravar direto no disco. ' +
        'Use um navegador Chromium (Chrome, Edge, Opera GX, Brave).');
    }
    if (!files || files.length < 2) throw new Error('Selecione 2 ou mais vídeos.');
    _cancelado = false;

    // Estrategia: TUDO vira MPEG-TS e depois e anexado byte a byte.
    //
    //  - PRIMEIRO arquivo, se ja for .ts -> copia direta dos bytes
    //    (instantaneo). So o primeiro pode: ele e o unico cuja linha do
    //    tempo comeca no inicio do arquivo final, entao os timestamps que
    //    ele ja carrega servem como estao.
    //
    //  - TODOS OS DEMAIS (.mp4, .mov E TAMBEM .ts) -> remux para TS em
    //    blocos com -output_ts_offset, deslocando os timestamps para o
    //    ponto certo da linha do tempo final.
    //
    // BUG CORRIGIDO: antes, qualquer .ts era copiado byte a byte. Como os
    // bytes carregam os timestamps originais (que comecam em 00:00), um
    // .ts colocado depois de um .mp4 fazia o tempo VOLTAR para zero na
    // emenda. O arquivo saia com o tamanho somado, mas o player calcula a
    // duracao pelo ultimo timestamp menos o primeiro — e mostrava so a
    // duracao do ultimo trecho.
    const ff = await _ensureFFmpeg(onStatus);

    const base = files[0].name.replace(/\.[^.]+$/, '');
    onStatus && onStatus('Escolha onde salvar o vídeo unido…');
    const handle = await window.showSaveFilePicker({
      suggestedName: base + '_unido_' + files.length + 'partes.ts',
      types: [{ description: 'Vídeo MPEG-TS', accept: { 'video/mp2t': ['.ts'] } }],
    });
    const stream = await handle.createWritable();

    const totalBytes = files.reduce((a, f) => a + f.size, 0);
    let feitos = 0;
    // Deslocamento acumulado na linha do tempo FINAL. Sem isso cada
    // arquivo recomeca em 00:00 e o player para na emenda.
    let offset = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const rotulo = 'Vídeo ' + (i + 1) + '/' + files.length;

        if (_ehTS(file) && i === 0) {
          // Caminho rapido: e o primeiro arquivo e ja e TS — os timestamps
          // dele ja sao os da linha do tempo final, basta anexar os bytes.
          for (let pos = 0; pos < file.size; pos += PEDACO) {
            if (_cancelado) throw new Error('Cancelado pelo usuário.');
            const ate = Math.min(pos + PEDACO, file.size);
            const buf = await file.slice(pos, ate).arrayBuffer();
            await stream.write(new Uint8Array(buf));
            feitos += ate - pos;
            onStatus && onStatus(rotulo + ' — copiando (' +
              Math.round((feitos / totalBytes) * 100) + '%)');
            onProgress && onProgress(feitos / totalBytes);
          }
          // O proximo arquivo tem que comecar onde este termina. Se a
          // leitura falhar, NAO da pra continuar: sem offset correto o
          // resultado sai com a duracao errada (era o bug antigo, que
          // engolia a falha com "offset += 0").
          const inf = await _infoViaFFmpeg(ff, file);
          offset += inf.start + inf.dur;
          continue;
        }

        // MP4/MOV/TS: remux para TS em blocos, com os timestamps
        // deslocados para o ponto certo da linha do tempo final.
        let dur;
        if (_ehTS(file)) {
          // Chromium nao decodifica MPEG-TS num <video>: vai direto no ffmpeg.
          dur = await _duracaoViaFFmpeg(ff, file);
        } else {
          try { dur = await _duracaoDe(file); }
          catch (_) { dur = await _duracaoViaFFmpeg(ff, file); }
        }

        const m = await _mount(ff, [file]);
        const entrada = (m.dir ? m.dir + '/' : '/') + file.name;
        try {
          const blocos = Math.ceil(dur / BLOCO_SEG);
          for (let b = 0; b < blocos; b++) {
            if (_cancelado) throw new Error('Cancelado pelo usuário.');
            const t0 = b * BLOCO_SEG;
            const t = Math.min(BLOCO_SEG, dur - t0);
            const saida = 'bloco.ts';

            onStatus && onStatus(rotulo + ' — convertendo bloco ' +
              (b + 1) + '/' + blocos + ' (sem re-encode)…');

            await ff.exec([
              '-ss', t0.toFixed(3),
              '-i', entrada,
              '-t', t.toFixed(3),
              '-map', '0:v:0',
              '-map', '0:a:0?',
              '-c', 'copy',
              '-output_ts_offset', (offset + t0).toFixed(3),
              '-muxdelay', '0',
              '-muxpreload', '0',
              '-f', 'mpegts',
              '-y', saida,
            ]);

            const dados = await ff.readFile(saida);
            await stream.write(dados);
            await ff.deleteFile(saida).catch(() => {});
            onProgress && onProgress(Math.min(1, (feitos + (t / dur) * file.size) / totalBytes));
          }
        } finally {
          await _unmount(ff, m, [file]);
        }
        feitos += file.size;
        offset += dur;
      }

      onStatus && onStatus('Vídeo unido gravado no disco.');
      return files.length;
    } finally {
      await stream.close();
    }
  }

  function videoExportCancelar() { _cancelado = true; }

  window.videoExportarCortesMP4 = videoExportarCortesMP4;
  window.videoCortarParaBlobs   = videoCortarParaBlobs;
  window.videoJuntarMP4 = videoJuntarMP4;
  window.videoCortarStreaming = videoCortarStreaming;
  window.videoUnirStreaming   = videoUnirStreaming;
  window.videoExportCancelar = videoExportCancelar;
  // Internos expostos p/ o editor (editor-ffmpeg.js)
  window._ffmpegEnsure  = _ensureFFmpeg;
  window._ffmpegMount   = _mount;
  window._ffmpegUnmount = _unmount;
})();
