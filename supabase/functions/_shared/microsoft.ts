// Helper Microsoft (FASE 6) - troca refresh_token por access_token e configura
// o acesso ao Microsoft Graph. Espelha o padrão de ../gmail.ts.
// Config esperada em integrations (type='microsoft').config:
//   { refresh_token, from_email }  (+ client_id/secret próprios no modo avançado)
import { admin, json } from './base.ts'

export interface MsConfig {
  client_id: string
  client_secret: string
  refresh_token: string
  from_email: string
}

// Escopos delegados do Graph (mesmos pedidos no consentimento).
export const MS_SCOPES = 'offline_access Mail.ReadWrite Mail.Send User.Read'

export async function getMicrosoftConfig(orgId: string): Promise<{ config: MsConfig; integrationId: string; lastSync: string | null }> {
  const { data } = await admin().from('integrations')
    .select('id, config, last_sync')
    .eq('org_id', orgId).eq('type', 'microsoft').maybeSingle()
  const cfg = (data?.config || {}) as Partial<MsConfig>

  const clientId = cfg.client_id || Deno.env.get('MS_CLIENT_ID') || ''
  const clientSecret = cfg.client_secret || Deno.env.get('MS_CLIENT_SECRET') || ''

  if (!clientId || !clientSecret || !cfg.refresh_token || !cfg.from_email) {
    throw json({ error: 'Microsoft não conectado. Vá em Configurações → Integrações → Microsoft e clique em "Conectar com Microsoft".', code: 'not_connected' }, 400)
  }
  return {
    config: { client_id: clientId, client_secret: clientSecret, refresh_token: cfg.refresh_token, from_email: cfg.from_email },
    integrationId: data!.id,
    lastSync: data!.last_sync,
  }
}

// Marca a integração Microsoft como "precisa reconectar" (refresh_token revogado).
async function markReconnectNeeded(integrationId: string): Promise<void> {
  try {
    const db = admin()
    const { data } = await db.from('integrations').select('config').eq('id', integrationId).maybeSingle()
    const cfg = (data?.config || {}) as Record<string, unknown>
    await db.from('integrations').update({
      config: { ...cfg, microsoft_status: 'reconnect_needed', reconnect_flagged_at: new Date().toISOString() },
      is_active: false,
    }).eq('id', integrationId)
  } catch (e) {
    console.warn('markReconnectNeeded (MS): falha ao sinalizar reconexão (ignorado):', e)
  }
}

// Troca o refresh_token por um access_token de curta duração (endpoint v2.0).
export async function microsoftAccessToken(cfg: MsConfig, integrationId?: string): Promise<string> {
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: 'refresh_token',
      scope: MS_SCOPES,
    }),
  })
  if (!res.ok) {
    const errText = await res.text()
    console.error('Microsoft token error:', errText)
    let invalidGrant = false
    try { invalidGrant = JSON.parse(errText).error === 'invalid_grant' } catch { /* corpo não-JSON */ }
    if (invalidGrant) {
      if (integrationId) await markReconnectNeeded(integrationId)
      throw json({
        error: 'Sua conexão com a Microsoft expirou. Reconecte a conta nas Configurações.',
        code: 'reconnect_needed',
      }, 401)
    }
    throw json({ error: 'Falha ao autenticar na Microsoft. Reconecte a conta.', code: 'ms_auth_failed' }, 502)
  }
  const data = await res.json()
  return data.access_token as string
}
