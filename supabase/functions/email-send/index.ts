// email-send - envia e-mail pelo provedor conectado da org e registra no CRM
// (abstração FASE 5: Gmail hoje, Microsoft na Fase 6)
// Frontend: sb.functions.invoke('email-send', { body: { to, subject, body, contact_id?, deal_id? } })

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getMailProvider } from '../_shared/mail/index.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { user, orgId } = await requireUser(req)
    const { to, subject, body, contact_id, deal_id } = await req.json()
    if (!to || !subject || !body) return json({ error: 'to, subject e body são obrigatórios' }, 400)

    const provider = await getMailProvider(orgId)
    const { messageId, threadId } = await provider.send({ to, subject, body })

    const db = admin()
    const { data: emailRow } = await db.from('emails').insert({
      org_id: orgId,
      contact_id: contact_id || null,
      deal_id: deal_id || null,
      owner_id: user.id,
      direction: 'outbound',
      from_email: provider.selfEmail,
      to_email: to,
      subject,
      body,
      snippet: body.slice(0, 180),
      message_id: messageId,
      thread_id: threadId,
      folder: 'sent',
      is_read: true,
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
    return json({ error: String((e as { message?: string })?.message || e) }, 500)
  }
})
