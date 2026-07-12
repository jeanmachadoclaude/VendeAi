// email-send — envia e-mail pelo Gmail conectado da org e registra no CRM
// Frontend: sb.functions.invoke('email-send', { body: { to, subject, body, contact_id?, deal_id? } })

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getGmailConfig, gmailAccessToken, encodeMime } from '../_shared/gmail.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { user, orgId } = await requireUser(req)
    const { to, subject, body, contact_id, deal_id } = await req.json()
    if (!to || !subject || !body) return json({ error: 'to, subject e body são obrigatórios' }, 400)

    const { config } = await getGmailConfig(orgId)
    const token = await gmailAccessToken(config)

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodeMime(config.from_email, to, subject, body) }),
    })
    if (!res.ok) {
      console.error('Gmail send error:', await res.text())
      return json({ error: 'Falha ao enviar o e-mail pelo Gmail.' }, 502)
    }
    const sent = await res.json() as { id: string; threadId: string }

    const db = admin()
    const { data: emailRow } = await db.from('emails').insert({
      org_id: orgId,
      contact_id: contact_id || null,
      deal_id: deal_id || null,
      owner_id: user.id,
      direction: 'outbound',
      from_email: config.from_email,
      to_email: to,
      subject,
      body,
      snippet: body.slice(0, 180),
      message_id: sent.id,
      thread_id: sent.threadId,
      status: 'sent',
    }).select('id').single()

    await db.from('activities').insert({
      org_id: orgId, contact_id: contact_id || null, deal_id: deal_id || null,
      type: 'email', title: `E-mail enviado: ${subject}`,
      body: body.slice(0, 300), owner_id: user.id,
      meta: { email_id: emailRow?.id },
    })

    return json({ ok: true, email_id: emailRow?.id })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'email-send')
    return json({ error: String(e?.message || e) }, 500)
  }
})
