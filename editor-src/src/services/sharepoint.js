// sharepoint.js — cliente das rotas /api/sharepoint/media/* do backend.
// Só funciona quando a TI configurar as credenciais do Azure (o backend
// responde 503 com instruções enquanto isso — docs/SHAREPOINT_TI.md).

import { authHeader } from './sources'

export async function sharePointDisponivel() {
  try {
    const res = await fetch('/api/sharepoint/media/status', { headers: authHeader() })
    if (!res.ok) return { ok: false }
    return await res.json() // { ok: true/false, motivo? }
  } catch {
    return { ok: false }
  }
}

// link de pasta do SharePoint → lista de vídeos [{driveId,itemId,name,size,path}]
export async function listarPasta(link) {
  const res = await fetch('/api/sharepoint/media/listar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ link }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.detail ?? `erro ${res.status}`)
  }
  return (await res.json()).videos
}
