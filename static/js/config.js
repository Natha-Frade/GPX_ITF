// ══════════════════════════════════════════════════════════════════════
//  config.js — Configuração do projeto
//
//  Coloque aqui sua API key do Google Cloud para habilitar o Street View
//  embutido (painel real, com pegman e navegação 360°, dentro do app).
//
//  COMO OBTER A KEY:
//  1. console.cloud.google.com → crie/selecione um projeto
//  2. Ative as APIs: "Maps JavaScript API"
//  3. Ative o faturamento do projeto (Google dá USD 200/mês de crédito
//     gratuito recorrente — uso interno dificilmente passa disso)
//  4. Em "Credenciais", crie uma API key
//  5. RESTRINJA a key por domínio (HTTP referrer) — ex: seu-dominio.com/*
//     Isso impede que outra pessoa copie a key do código-fonte e use.
//
//  Sem key configurada, o app continua funcionando normalmente — os
//  botões de Street View abrem o Google Maps em nova aba (sem custo,
//  sem key, sempre funciona). Com a key, eles abrem o painel embutido.
// ══════════════════════════════════════════════════════════════════════

const GOOGLE_MAPS_API_KEY = 'SUA_API_KEY_AQUI';

// Não precisa editar abaixo desta linha.
const STREETVIEW_EMBEDDED_ENABLED =
  typeof GOOGLE_MAPS_API_KEY === 'string' &&
  GOOGLE_MAPS_API_KEY.trim() !== '' &&
  GOOGLE_MAPS_API_KEY !== 'SUA_API_KEY_AQUI';
