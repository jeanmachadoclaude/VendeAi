// Helper Gmail — troca refresh_token por access_token e chama a API
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
  const cfg = data?.config as GmailConfig | undefined
  if (!cfg?.client_id || !cfg?.client_secret || !cfg?.refresh_token) {
    throw json({ error: 'Gmail não conectado. Configure em Configurações → Integrações.' }, 400)
  }
  return { config: cfg, integrationId: data!.id, lastSync: data!.last_sync }
}

export async function gmailAccessToken(cfg: GmailConfig): Promise<string> {
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
    console.error('Gmail token error:', await res.text())
    throw json({ error: 'Falha ao autenticar no Gmail. Reconecte a conta.' }, 502)
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
