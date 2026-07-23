// email-modify - move/arquiva/marca e-mails no Gmail e reflete no CRM (FASE 4)
// Frontend: sb.functions.invoke('email-modify', { body: { email_id, action } })
// action: 'trash' | 'untrash' | 'archive' | 'spam' | 'read' | 'unread'
//
// EXIGE o escopo gmail.modify no OAuth. Com o escopo antigo (gmail.readonly)
// o Gmail responde 403 e a função devolve um erro amigável pedindo reconexão.

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getGmailConfig, gmailAccessToken } from '../_shared/gmail.ts'

type Action = 'trash' | 'untrash' | 'inbox' | 'archive' | 'spam' | 'read' | 'unread'

// Cada ação: endpoint do Gmail + como fica a pasta/leitura no CRM.
const ACTIONS: Record<Action, {
  path: (id: string) => string
  body?: Record<string, unknown>
  patch: Record<string, unknown>
}> = {
  trash:   { path: id => `${id}/trash`,   patch: { folder: 'trash' } },
  untrash: { path: id => `${id}/untrash`, patch: { folder: 'inbox' } },
  inbox:   { path: id => `${id}/modify`, body: { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] }, patch: { folder: 'inbox' } },
  archive: { path: id => `${id}/modify`, body: { removeLabelIds: ['INBOX'] }, patch: { folder: 'archive' } },
  spam:    { path: id => `${id}/modify`, body: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }, patch: { folder: 'spam' } },
  read:    { path: id => `${id}/modify`, body: { removeLabelIds: ['UNREAD'] }, patch: { is_read: true } },
  unread:  { path: id => `${id}/modify`, body: { addLabelIds: ['UNREAD'] }, patch: { is_read: false } },
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId } = await requireUser(req)
    const { email_id, action } = await req.json() as { email_id: string; action: Action }
    if (!email_id || !action) return json({ error: 'email_id e action são obrigatórios' }, 400)
    const spec = ACTIONS[action]
    if (!spec) return json({ error: 'Ação inválida' }, 400)

    const db = admin()
    const { data: email } = await db.from('emails')
      .select('id, message_id').eq('id', email_id).eq('org_id', orgId).maybeSingle()
    if (!email) return json({ error: 'E-mail não encontrado' }, 404)
    if (!email.message_id) return json({ error: 'E-mail sem referência no Gmail (não sincronizado).' }, 400)

    const { config, integrationId } = await getGmailConfig(orgId)
    const token = await gmailAccessToken(config, integrationId)

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${spec.path(email.message_id)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: spec.body ? JSON.stringify(spec.body) : undefined,
      },
    )
    if (!res.ok) {
      const txt = await res.text()
      console.error('Gmail modify error:', res.status, txt)
      if (res.status === 403) {
        return json({
          error: 'Sua conexão com o Google não tem permissão para mover e-mails. ' +
            'Reconecte a conta em Configurações → Integrações para conceder o acesso (gmail.modify).',
          code: 'scope_insufficient',
        }, 403)
      }
      return json({ error: 'Falha ao atualizar o e-mail no Gmail.' }, 502)
    }

    await db.from('emails').update(spec.patch).eq('id', email.id)
    return json({ ok: true, ...spec.patch })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'email-modify')
    return json({ error: String((e as { message?: string })?.message || e) }, 500)
  }
})
