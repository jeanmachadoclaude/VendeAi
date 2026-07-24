// microsoft-oauth - fluxo "1 clique" de conexão da conta Microsoft (Outlook).
// POST (autenticado): devolve a URL de consentimento da Microsoft { url }.
// GET  (callback, sem JWT - verify_jwt=false): troca o code por refresh_token,
//      descobre o e-mail (Graph /me) e grava em integrations (type='microsoft').
// Credenciais do app: secrets MS_CLIENT_ID / MS_CLIENT_SECRET (ou próprios da org).
// Redirect URI a cadastrar no Azure (App registrations → Authentication):
//   https://<PROJECT>.supabase.co/functions/v1/microsoft-oauth

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { MS_SCOPES } from '../_shared/microsoft.ts'

const AUTHORIZE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

function redirectUri(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/microsoft-oauth`
}

function resolveClient(cfg?: Record<string, string>): { clientId: string; clientSecret: string } {
  const clientId = cfg?.client_id || Deno.env.get('MS_CLIENT_ID') || ''
  const clientSecret = cfg?.client_secret || Deno.env.get('MS_CLIENT_SECRET') || ''
  if (!clientId || !clientSecret) {
    throw json({
      error: 'Microsoft indisponível: o app OAuth ainda não foi ativado. ' +
        'Administrador: registre um app no Azure e configure os secrets MS_CLIENT_ID e MS_CLIENT_SECRET no Supabase.',
      code: 'no_oauth_app',
    }, 424)
  }
  return { clientId, clientSecret }
}

function htmlPage(ok: boolean, msg: string): Response {
  const body = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>VendeAI</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a1220;color:#f5efe0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:420px;text-align:center;padding:40px;background:#0c1626;border:1px solid rgba(74,127,212,.25);border-radius:18px}
h1{font-size:20px;margin:0 0 10px}p{font-size:14px;color:#9fb0c9;line-height:1.6}</style></head>
<body><div class="card"><h1>${ok ? '✅ Microsoft conectado!' : '⚠️ Não foi possível conectar'}</h1>
<p>${msg}</p><p>Você já pode fechar esta janela.</p></div>
<script>try{window.opener&&window.opener.postMessage({source:'vendeai',microsoft:${ok ? "'connected'" : "'error'"}},'*')}catch(e){}
setTimeout(()=>{try{window.close()}catch(e){}},4000)</script></body></html>`
  return new Response(body, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const db = admin()

  // ── GET: callback da Microsoft ─────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') || ''
    const mErr = url.searchParams.get('error')
    if (mErr) return htmlPage(false, `A Microsoft recusou a autorização (${mErr}). Tente novamente pelo CRM.`)
    if (!code || !state.includes(':')) return htmlPage(false, 'Link de retorno inválido. Tente novamente pelo CRM.')

    const [orgId, nonce] = state.split(':')
    const { data: integ } = await db.from('integrations')
      .select('id, config').eq('org_id', orgId).eq('type', 'microsoft').maybeSingle()
    const cfg = (integ?.config || {}) as Record<string, string>
    if (!integ || !cfg.oauth_state || cfg.oauth_state !== nonce) {
      return htmlPage(false, 'Sessão de conexão expirada. Abra o CRM e clique em "Conectar com Microsoft" de novo.')
    }

    try {
      const { clientId, clientSecret } = resolveClient(cfg)
      const tokenRes = await fetch(TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri(), grant_type: 'authorization_code', scope: MS_SCOPES,
        }),
      })
      if (!tokenRes.ok) {
        console.error('Microsoft token error:', await tokenRes.text())
        return htmlPage(false, 'A Microsoft não aceitou o código de autorização. Tente novamente.')
      }
      const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string }
      if (!tokens.refresh_token) {
        return htmlPage(false, 'A Microsoft não devolveu a permissão permanente (offline_access). Tente conectar de novo.')
      }

      const infoRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      const info = infoRes.ok ? await infoRes.json() as { mail?: string; userPrincipalName?: string } : {}
      const email = info.mail || info.userPrincipalName || ''

      const { oauth_state: _drop, ...rest } = cfg
      await db.from('integrations').update({
        config: {
          ...rest,
          refresh_token: tokens.refresh_token,
          from_email: email || rest.from_email || '',
          connected_at: new Date().toISOString(),
          microsoft_status: 'connected',
          reconnect_flagged_at: null,
        },
        is_active: true,
      }).eq('id', integ.id)

      return htmlPage(true, `A conta <strong>${email || 'Microsoft'}</strong> foi conectada. E-mails já podem sincronizar com o CRM.`)
    } catch (e) {
      if (e instanceof Response) {
        const detail = await e.clone().json().catch(() => null) as { error?: string } | null
        return htmlPage(false, detail?.error || 'Falha inesperada na conexão.')
      }
      console.error(e)
      await reportError(e, 'microsoft-oauth')
      return htmlPage(false, 'Falha inesperada na conexão. Tente novamente.')
    }
  }

  // ── POST: gera a URL de consentimento ──────────────────────
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const { orgId } = await requireUser(req)

    const { data: integ } = await db.from('integrations')
      .select('id, config').eq('org_id', orgId).eq('type', 'microsoft').maybeSingle()
    const cfg = (integ?.config || {}) as Record<string, string>
    const { clientId } = resolveClient(cfg)

    const nonce = crypto.randomUUID()
    const { error: saveErr } = integ
      ? await db.from('integrations').update({ config: { ...cfg, oauth_state: nonce } }).eq('id', integ.id)
      : await db.from('integrations').insert({ org_id: orgId, type: 'microsoft', config: { oauth_state: nonce }, is_active: false })
    if (saveErr) return json({ error: 'Falha ao iniciar a conexão Microsoft: ' + saveErr.message }, 500)

    const consent = new URL(AUTHORIZE)
    consent.searchParams.set('client_id', clientId)
    consent.searchParams.set('redirect_uri', redirectUri())
    consent.searchParams.set('response_type', 'code')
    consent.searchParams.set('response_mode', 'query')
    consent.searchParams.set('prompt', 'select_account')
    consent.searchParams.set('scope', MS_SCOPES)
    consent.searchParams.set('state', `${orgId}:${nonce}`)

    return json({ url: consent.toString() })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'microsoft-oauth')
    return json({ error: String((e as { message?: string })?.message || e) }, 500)
  }
})
