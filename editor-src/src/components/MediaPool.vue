<script setup>
// Biblioteca de vídeos — 100% no navegador.
// Os arquivos NÃO são enviados a lugar nenhum: o editor lê o File local
// por referência (metadados, GPS, thumbnail, player e export). A seção
// SharePoint (quando a TI ativar as credenciais) permite editar vídeos
// da nuvem por streaming, sem baixar.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useEdlStore } from '../stores/edl'
import { registerLocalFile, registerSharePointItem, getSource } from '../services/sources'
import { sharePointDisponivel, listarPasta } from '../services/sharepoint'

const store = useEdlStore()
const items = ref([]) // sources adicionadas (locais e remotas)
const status = ref('')
const error = ref('')
const busy = ref(false)
const fileInput = ref(null)

// SharePoint
const spOk = ref(false)
const spLink = ref('')
const spBusy = ref(false)
const spVideos = ref([])
const spOpen = ref(false)

async function addFiles(files) {
  const accepted = [...files].filter((f) => /\.(mp4|mov)$/i.test(f.name))
  if (!accepted.length) return
  busy.value = true
  error.value = ''
  try {
    for (const f of accepted) {
      const src = await registerLocalFile(f, (m) => (status.value = m))
      if (!items.value.find((i) => i.id === src.id)) items.value.push(src)
    }
    status.value = ''
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

function onPick(e) {
  addFiles(e.target.files)
  e.target.value = ''
}

function onWindowDragOver(e) {
  if ([...e.dataTransfer.types].includes('Files')) e.preventDefault()
}
function onWindowDrop(e) {
  if (![...e.dataTransfer.types].includes('Files')) return
  e.preventDefault()
  addFiles(e.dataTransfer.files)
}

onMounted(async () => {
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
  spOk.value = (await sharePointDisponivel()).ok
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
})

function addToTimeline(source) {
  store.addSource(source)
}

// arrastar da biblioteca pra uma pista (TimelinePane trata o drop pelo id)
function onDragStart(e, source) {
  e.dataTransfer.setData('application/x-tender-video', source.id)
  e.dataTransfer.effectAllowed = 'copy'
}

async function buscarPastaSp() {
  const link = spLink.value.trim()
  if (!link) return
  spBusy.value = true
  error.value = ''
  try {
    spVideos.value = await listarPasta(link)
    if (!spVideos.value.length) status.value = 'nenhum vídeo nessa pasta'
  } catch (e) {
    error.value = e.message
  } finally {
    spBusy.value = false
  }
}

async function addSpVideo(v) {
  spBusy.value = true
  error.value = ''
  try {
    const src = await registerSharePointItem(v, (m) => (status.value = m))
    if (!items.value.find((i) => i.id === src.id)) items.value.push(src)
    status.value = ''
  } catch (e) {
    error.value = e.message
  } finally {
    spBusy.value = false
  }
}

const mb = (bytes) => (bytes ? `${(bytes / 1048576).toFixed(0)} MB` : '')
const gpsBadge = (s) => (s.gpx.points.length ? `${s.gpx.points.length} pts GPS` : 'sem GPS')
</script>

<template>
  <section class="pane pool">
    <h2>Biblioteca</h2>
    <div class="actions">
      <button class="btn" :disabled="busy" @click="fileInput.click()">
        {{ busy ? 'lendo…' : '+ Adicionar vídeos' }}
      </button>
      <input
        ref="fileInput"
        type="file"
        class="hidden"
        accept=".mp4,.mov,video/mp4,video/quicktime"
        multiple
        @change="onPick"
      />
      <button v-if="spOk" class="btn" @click="spOpen = !spOpen">☁ SharePoint</button>
      <span class="muted drop-hint">ou arraste arquivos pra janela</span>
    </div>

    <div v-if="spOpen && spOk" class="sp-box">
      <div class="paste-row">
        <input
          v-model="spLink"
          type="text"
          placeholder="cole o link da pasta do SharePoint"
          @keyup.enter="buscarPastaSp"
        />
        <button class="btn" :disabled="spBusy || !spLink.trim()" @click="buscarPastaSp">
          {{ spBusy ? '…' : 'Listar' }}
        </button>
      </div>
      <ul v-if="spVideos.length" class="sp-list">
        <li v-for="v in spVideos" :key="v.itemId">
          <span class="name">{{ v.path || v.name }}</span>
          <span class="muted">{{ mb(v.size) }}</span>
          <button class="btn tiny" :disabled="spBusy" @click="addSpVideo(v)">＋</button>
        </li>
      </ul>
      <p class="muted note">
        vídeos do SharePoint tocam por streaming (sem baixar); o corte roda no servidor
      </p>
    </div>

    <p v-if="status" class="muted">{{ status }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="!items.length" class="muted">
      adicione vídeos — eles ficam no seu PC, nada é enviado
    </p>

    <ul class="lib">
      <li v-for="s in items" :key="s.id" draggable="true" @dragstart="onDragStart($event, s)">
        <img v-if="s.thumb" :src="s.thumb" alt="" />
        <div v-else class="thumb-ph"></div>
        <div class="info">
          <span class="name">{{ s.remote ? '☁ ' : '' }}{{ s.path }}</span>
          <span class="muted">
            {{ s.duration ? s.duration.toFixed(0) + 's' : '' }} · {{ gpsBadge(s) }}
          </span>
        </div>
        <button class="btn tiny" title="adicionar ao fim da Trilha 1" @click="addToTimeline(s)">
          ＋
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.drop-hint {
  font-size: 12px;
}

.hidden {
  display: none;
}

.error {
  color: var(--danger);
}

.sp-box {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 8px;
}

.paste-row {
  display: flex;
  gap: 6px;
}

.paste-row input {
  flex: 1;
  min-width: 0;
}

.sp-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  max-height: 140px;
  overflow-y: auto;
}

.sp-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  font-size: 13px;
}

.sp-list .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note {
  font-size: 11px;
  margin: 6px 0 0;
}

ul.lib {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
}

ul.lib li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: grab;
}

ul.lib img,
.thumb-ph {
  width: 64px;
  height: 36px;
  object-fit: cover;
  border-radius: 4px;
  background: #000;
  pointer-events: none;
  flex-shrink: 0;
}

.info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.info .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
</style>
