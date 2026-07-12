// email-sync — puxa e-mails recebidos do Gmail e vincula aos contatos do CRM
// Frontend: sb.functions.invoke('email-sync')  (também pode rodar via cron)

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getGmailConfig, gmailAccessToken, headerValue, bareEmail } from '../_shared/gmail.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId } = await requireUser(req)
    const { config, integrationId, lastSync } = await getGmailConfig(orgId)
    const token = await gmailAccessToken(config)
    const db = admin()

    // Busca mensagens da caixa de entrada desde a última sync (janela mínima: 3 dias)
    const sinceMs = lastSync ? new Date(lastSync).getTime() : Date.now() - 3 * 86400000
    const after = Math.floor(Math.min(sinceMs, Date.now() - 3600000) / 1000)
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox after:${after}&maxResults=25`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!listRes.ok) return json({ error: 'Falha ao listar e-mails do Gmail.' }, 502)
    const list = await listRes.json() as { messages?: Array<{ id: string; threadId: string }> }

    let imported = 0
    for (const m of list.messages || []) {
      // Dedupe
      const { data: dup } = await db.from('emails').select('id')
        .eq('org_id', orgId).eq('message_id', m.id).maybeSingle()
      if (dup) continue

      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!msgRes.ok) continue
      const msg = await msgRes.json()
      const headers = msg.payload?.headers || []
      const fromEmail = bareEmail(headerValue(headers, 'From'))
      if (!fromEmail || fromEmail === config.from_email.toLowerCase()) continue

      // Só importa se o remetente for um contato do CRM
      const { data: contact } = await db.from('contacts')
        .select('id').eq('org_id', orgId).ilike('email', fromEmail).maybeSingle()
      if (!contact) continue

      // Vincula ao negócio aberto mais recente do contato, se houver
      const { data: deal } = await db.from('deals').select('id')
        .eq('org_id', orgId).eq('contact_id', contact.id).eq('status', 'open')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()

      await db.from('emails').insert({
        org_id: orgId,
        contact_id: contact.id,
        deal_id: deal?.id || null,
        direction: 'inbound',
        from_email: fromEmail,
        to_email: config.from_email,
        subject: headerValue(headers, 'Subject'),
        snippet: msg.snippet || '',
        body: msg.snippet || '',
        message_id: m.id,
        thread_id: m.threadId,
        status: 'received',
        sent_at: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
      })

      await db.from('activities').insert({
        org_id: orgId, contact_id: contact.id, deal_id: deal?.id || null,
        type: 'email', title: `E-mail recebido: ${headerValue(headers, 'Subject') || '(sem assunto)'}`,
        body: (msg.snippet || '').slice(0, 300),
        meta: { message_id: m.id },
      })
      imported++
    }

    await db.from('integrations').update({
      is_active: true, last_sync: new Date().toISOString(),
    }).eq('id', integrationId)

    return json({ ok: true, imported })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'email-sync')
    return json({ error: String(e?.message || e) }, 500)
  }
})
