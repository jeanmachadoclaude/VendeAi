// google-oauth — fluxo "1 clique" de conexão da conta Google (Gmail + Agenda).
// POST (autenticado): devolve a URL de consentimento do Google { url }.
// GET  (callback do Google, sem JWT — deploy com --no-verify-jwt):
//      troca o code por refresh_token, descobre o e-mail e grava em integrations.
// Credenciais do app OAuth: secrets GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// (ou client_id/client_secret próprios da org no modo avançado).
// Redirect URI a cadastrar no Google Cloud Console:
//   https://<PROJECT>.supabase.co/functions/v1/google-oauth

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'

// Escopo MÍNIMO por function (auditado em docs/google-verificacao.md):
//   gmail.send      → email-send (só envia; não lê nem apaga)
//   gmail.readonly  → email-sync (lista a inbox e lê o snippet dos e-mails)
//   calendar.events → calendar-sync (lê/cria eventos; não mexe em ACL/config)
//   userinfo.email  → descobrir qual conta foi conectada (from_email)
// gmail.readonly continua sendo escopo "restrito" do Google (exige CASA na
// verificação); os demais são "sensíveis". Ver o guia para o plano de produção.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

function redirectUri(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-oauth`
}

function resolveClient(cfg?: Record<string, string>): { clientId: string; clientSecret: string } {
  const clientId = cfg?.client_id || Deno.env.get('GOOGLE_CLIENT_ID') || ''
  const clientSecret = cfg?.client_secret || Deno.env.get('GOOGLE_CLIENT_SECRET') || ''
  if (!clientId || !clientSecret) {
    throw json({
      error: 'Google indisponível: o app OAuth ainda não foi ativado. ' +
        'Administrador: configure os secrets GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no Supabase ' +
        '(ou use as configurações avançadas com um app próprio).',
      code: 'no_oauth_app',
    }, 424)
  }
  return { clientId, clientSecret }
}

// Página HTML mostrada no fim do callback (sucesso ou erro)
function htmlPage(ok: boolean, msg: string): Response {
  const body = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>VendeAI</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a1220;color:#f5efe0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:420px;text-align:center;padding:40px;background:#0c1626;border:1px solid rgba(74,127,212,.25);border-radius:18px}
h1{font-size:20px;margin:0 0 10px}p{font-size:14px;color:#9fb0c9;line-height:1.6}</style></head>
<body><div class="card"><h1>${ok ? '✅ Google conectado!' : '⚠️ Não foi possível conectar'}</h1>
<p>${msg}</p><p>Você já pode fechar esta janela.</p></div>
<script>try{window.opener&&window.opener.postMessage({source:'vendeai',google:${ok ? "'connected'" : "'error'"}},'*')}catch(e){}
setTimeout(()=>{try{window.close()}catch(e){}},4000)</script></body></html>`
  return new Response(body, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const db = admin()

  // ── GET: callback do Google ────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') || ''
    const gErr = url.searchParams.get('error')
    if (gErr) return htmlPage(false, `O Google recusou a autorização (${gErr}). Tente novamente pelo CRM.`)
    if (!code || !state.includes(':')) return htmlPage(false, 'Link de retorno inválido. Tente novamente pelo CRM.')

    const [orgId, nonce] = state.split(':')
    const { data: integ } = await db.from('integrations')
      .select('id, config').eq('org_id', orgId).eq('type', 'gmail').maybeSingle()
    const cfg = (integ?.config || {}) as Record<string, string>
    if (!integ || !cfg.oauth_state || cfg.oauth_state !== nonce) {
      return htmlPage(false, 'Sessão de conexão expirada. Abra o CRM e clique em "Conectar com Google" de novo.')
    }

    try {
      const { clientId, clientSecret } = resolveClient(cfg)
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri(), grant_type: 'authorization_code',
        }),
      })
      if (!tokenRes.ok) {
        console.error('Google token error:', await tokenRes.text())
        return htmlPage(false, 'O Google não aceitou o código de autorização. Tente novamente.')
      }
      const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string }
      if (!tokens.refresh_token) {
        return htmlPage(false, 'O Google não devolveu a permissão permanente. Remova o VendeAI em myaccount.google.com/permissions e conecte de novo.')
      }

      const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      const info = infoRes.ok ? await infoRes.json() as { email?: string } : {}

      const { oauth_state: _drop, ...rest } = cfg
      await db.from('integrations').update({
        config: {
          ...rest,
          refresh_token: tokens.refresh_token,
          from_email: info.email || rest.from_email || '',
          connected_at: new Date().toISOString(),
          // Reconexão bem-sucedida: limpa qualquer marca de "reconecte sua conta".
          google_status: 'connected',
          reconnect_flagged_at: null,
        },
        is_active: true,
      }).eq('id', integ.id)

      return htmlPage(true, `A conta <strong>${info.email || 'Google'}</strong> foi conectada. E-mails e agenda já podem sincronizar com o CRM.`)
    } catch (e) {
      if (e instanceof Response) {
        const detail = await e.clone().json().catch(() => null) as { error?: string } | null
        return htmlPage(false, detail?.error || 'Falha inesperada na conexão.')
      }
      console.error(e)
      await reportError(e, 'google-oauth')
      return htmlPage(false, 'Falha inesperada na conexão. Tente novamente.')
    }
  }

  // ── POST: gera a URL de consentimento ──────────────────────
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const { orgId } = await requireUser(req)

    const { data: integ } = await db.from('integrations')
      .select('id, config').eq('org_id', orgId).eq('type', 'gmail').maybeSingle()
    const cfg = (integ?.config || {}) as Record<string, string>
    const { clientId } = resolveClient(cfg)

    const nonce = crypto.randomUUID()
    if (integ) {
      await db.from('integrations').update({ config: { ...cfg, oauth_state: nonce } }).eq('id', integ.id)
    } else {
      await db.from('integrations').insert({
        org_id: orgId, type: 'gmail', config: { oauth_state: nonce }, is_active: false,
      })
    }

    const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    consent.searchParams.set('client_id', clientId)
    consent.searchParams.set('redirect_uri', redirectUri())
    consent.searchParams.set('response_type', 'code')
    consent.searchParams.set('access_type', 'offline')
    consent.searchParams.set('prompt', 'consent')
    consent.searchParams.set('scope', SCOPES)
    consent.searchParams.set('state', `${orgId}:${nonce}`)

    return json({ url: consent.toString() })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'google-oauth')
    return json({ error: String(e?.message || e) }, 500)
  }
})
