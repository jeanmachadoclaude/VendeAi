// email-modify - move/arquiva/marca e-mails no provedor e reflete no CRM
// (abstração FASE 5: Gmail hoje, Microsoft na Fase 6)
// Frontend: sb.functions.invoke('email-modify', { body: { email_id, action } })
// action: 'trash' | 'untrash' | 'inbox' | 'archive' | 'spam' | 'read' | 'unread'
//
// No Gmail exige o escopo gmail.modify; sem ele o provedor devolve 403 com
// code 'scope_insufficient' (a UI pede reconexão).

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getMailProvider } from '../_shared/mail/index.ts'
import type { MailAction } from '../_shared/mail/types.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId } = await requireUser(req)
    const { email_id, action } = await req.json() as { email_id: string; action: MailAction }
    if (!email_id || !action) return json({ error: 'email_id e action são obrigatórios' }, 400)

    const db = admin()
    const { data: email } = await db.from('emails')
      .select('id, message_id').eq('id', email_id).eq('org_id', orgId).maybeSingle()
    if (!email) return json({ error: 'E-mail não encontrado' }, 404)
    if (!email.message_id) return json({ error: 'E-mail sem referência no provedor (não sincronizado).' }, 400)

    const provider = await getMailProvider(orgId)
    const patch = await provider.modify(email.message_id, action) // lança Response 403 se faltar escopo

    await db.from('emails').update(patch).eq('id', email.id)
    return json({ ok: true, ...patch })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'email-modify')
    return json({ error: String((e as { message?: string })?.message || e) }, 500)
  }
})
