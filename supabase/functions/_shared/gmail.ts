// Helper Gmail - troca refresh_token por access_token e chama a API
// Config esperada em integrations (type='gmail').config:
//   { client_id, client_secret, refresh_token, from_email }
import { admin, json } from './base.ts'

export interface GmailConfig {
  client_id: string
  client_secret: string
  refresh_token: string
  from_email: string
}

export async function getGmailConfig(orgId: string): Promise<{ config: GmailConfig; integrationId: string; lastSync: string | null }> {
  const { data } = await admin().from('integrations')
    .select('id, config, is_active, last_sync')
    .eq('org_id', orgId).eq('type', 'gmail').maybeSingle()
  const cfg = (data?.config || {}) as Partial<GmailConfig>

  // Credenciais do app OAuth: da org (modo avançado) ou centrais do VendeAI (secrets)
  const clientId = cfg.client_id || Deno.env.get('GOOGLE_CLIENT_ID') || ''
  const clientSecret = cfg.client_secret || Deno.env.get('GOOGLE_CLIENT_SECRET') || ''

  if (!clientId || !clientSecret || !cfg.refresh_token || !cfg.from_email) {
    throw json({ error: 'Google não conectado. Vá em Configurações → Integrações → Gmail e clique em "Conectar com Google".', code: 'not_connected' }, 400)
  }
  return {
    config: { client_id: clientId, client_secret: clientSecret, refresh_token: cfg.refresh_token, from_email: cfg.from_email },
    integrationId: data!.id,
    lastSync: data!.last_sync,
  }
}

// Marca a integração Google como "precisa reconectar" quando o refresh_token
// é revogado/expira (invalid_grant). No app OAuth em modo Testing do Google os
// refresh tokens morrem em ~7 dias; ao passar para produção isso deixa de
// acontecer. A UI (settings.html / calendar.html) lê config.google_status e
// mostra o aviso de reconexão em vez de um erro silencioso.
async function markReconnectNeeded(integrationId: string): Promise<void> {
  try {
    const db = admin()
    const { data } = await db.from('integrations').select('config').eq('id', integrationId).maybeSingle()
    const cfg = (data?.config || {}) as Record<string, unknown>
    await db.from('integrations').update({
      config: { ...cfg, google_status: 'reconnect_needed', reconnect_flagged_at: new Date().toISOString() },
      is_active: false,
    }).eq('id', integrationId)
  } catch (e) {
    console.warn('markReconnectNeeded: falha ao sinalizar reconexão (ignorado):', e)
  }
}

// Troca o refresh_token por um access_token de curta duração.
// Passe integrationId para que uma falha de token revogado (invalid_grant)
// sinalize a integração para reconexão e devolva o código 'reconnect_needed'
// (as UIs tratam esse código como "Reconecte sua conta Google").
export async function gmailAccessToken(cfg: GmailConfig, integrationId?: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const errText = await res.text()
    console.error('Gmail token error:', errText)
    let invalidGrant = false
    try { invalidGrant = JSON.parse(errText).error === 'invalid_grant' } catch { /* corpo não-JSON */ }
    if (invalidGrant) {
      if (integrationId) await markReconnectNeeded(integrationId)
      throw json({
        error: 'Sua conexão com o Google expirou. Reconecte sua conta Google nas Configurações.',
        code: 'reconnect_needed',
      }, 401)
    }
    throw json({ error: 'Falha ao autenticar no Gmail. Reconecte a conta.', code: 'gmail_auth_failed' }, 502)
  }
  const data = await res.json()
  return data.access_token as string
}

// Codifica uma mensagem RFC822 em base64url (formato exigido pelo Gmail)
export function encodeMime(from: string, to: string, subject: string, body: string): string {
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(String.fromCharCode(...new TextEncoder().encode(body))),
  ].join('\r\n')
  return btoa(String.fromCharCode(...new TextEncoder().encode(mime)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function headerValue(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''
}

// Extrai só o e-mail de "Nome <email@x.com>"
export function bareEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/)
  return (m ? m[1] : raw).trim().toLowerCase()
}
