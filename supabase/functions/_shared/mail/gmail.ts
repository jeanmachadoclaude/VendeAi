// Provedor Gmail (FASE 5) — implementa MailProvider usando a API do Gmail.
// Encapsula toda a lógica que antes vivia inline em email-sync/send/modify.
// Reaproveita os helpers de baixo nível em ../gmail.ts.

import { admin, json } from '../base.ts'
import {
  getGmailConfig, gmailAccessToken, encodeMime, headerValue, bareEmail,
  extractBody, folderFromLabels, isUnread,
} from '../gmail.ts'
import type { MailProvider, MailAction, NormalizedMessage } from './types.ts'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

// Ação → endpoint do Gmail + patch a aplicar em `emails`.
const GMAIL_ACTIONS: Record<MailAction, {
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

export async function createGmailProvider(orgId: string): Promise<MailProvider> {
  const { config, integrationId, lastSync } = await getGmailConfig(orgId)
  const token = await gmailAccessToken(config, integrationId)
  const self = config.from_email.toLowerCase()
  const authH = { Authorization: `Bearer ${token}` }

  return {
    type: 'gmail',
    selfEmail: self,
    integrationId,
    lastSync,

    async listMessageIds(sinceMs, max) {
      const since = sinceMs ?? (Date.now() - 3 * 86400000)
      // Nunca depois de 1h atrás (dá folga para e-mails em trânsito).
      const after = Math.floor(Math.min(since, Date.now() - 3600000) / 1000)
      const res = await fetch(
        `${API}/messages?q=after:${after}&includeSpamTrash=true&maxResults=${max}`,
        { headers: authH },
      )
      if (!res.ok) throw json({ error: 'Falha ao listar e-mails do Gmail.' }, 502)
      const data = await res.json() as { messages?: Array<{ id: string; threadId: string }> }
      return (data.messages || []).map(m => ({ id: m.id, threadId: m.threadId }))
    },

    async getMessage(id): Promise<NormalizedMessage | null> {
      const res = await fetch(`${API}/messages/${id}?format=full`, { headers: authH })
      if (!res.ok) return null
      const msg = await res.json()
      const labels: string[] = msg.labelIds || []
      const headers = msg.payload?.headers || []
      const fromEmail = bareEmail(headerValue(headers, 'From'))
      const toEmail = bareEmail(headerValue(headers, 'To'))
      const outbound = labels.includes('SENT') || fromEmail === self
      return {
        messageId: id,
        threadId: msg.threadId,
        fromEmail: fromEmail || self,
        toEmail: toEmail || self,
        subject: headerValue(headers, 'Subject'),
        snippet: msg.snippet || '',
        body: extractBody(msg.payload) || msg.snippet || '',
        folder: folderFromLabels(labels) as NormalizedMessage['folder'],
        isRead: !isUnread(labels),
        labels,
        direction: outbound ? 'outbound' : 'inbound',
        sentAt: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
      }
    },

    async modify(messageId, action) {
      const spec = GMAIL_ACTIONS[action]
      if (!spec) throw json({ error: 'Ação inválida' }, 400)
      const res = await fetch(`${API}/messages/${spec.path(messageId)}`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: spec.body ? JSON.stringify(spec.body) : undefined,
      })
      if (!res.ok) {
        const txt = await res.text()
        console.error('Gmail modify error:', res.status, txt)
        if (res.status === 403) {
          throw json({
            error: 'Sua conexão com o Google não tem permissão para mover e-mails. ' +
              'Reconecte a conta em Configurações → Integrações para conceder o acesso (gmail.modify).',
            code: 'scope_insufficient',
          }, 403)
        }
        throw json({ error: 'Falha ao atualizar o e-mail no Gmail.' }, 502)
      }
      return spec.patch
    },

    async send({ to, subject, body }) {
      const res = await fetch(`${API}/messages/send`, {
        method: 'POST',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: encodeMime(self, to, subject, body) }),
      })
      if (!res.ok) {
        console.error('Gmail send error:', await res.text())
        throw json({ error: 'Falha ao enviar o e-mail pelo Gmail.' }, 502)
      }
      const sent = await res.json() as { id: string; threadId: string }
      return { messageId: sent.id, threadId: sent.threadId }
    },

    async markSynced() {
      await admin().from('integrations')
        .update({ is_active: true, last_sync: new Date().toISOString() })
        .eq('id', integrationId)
    },
  }
}
