import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// O editor é servido pelo backend FastAPI em /editor/ (static/editor).
// `npm run build` gera direto em ../static/editor — o Dockerfile também
// roda esse build num estágio node, então o deploy no Railway é automático.
export default defineConfig({
  plugins: [vue()],
  base: '/editor/',
  build: {
    outDir: '../static/editor',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    // no dev, as rotas /api/* vão pro backend local (uvicorn app.main:app)
    proxy: { '/api': 'http://localhost:8000' },
  },
})
