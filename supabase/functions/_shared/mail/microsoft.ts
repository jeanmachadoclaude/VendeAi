// Provedor Microsoft (FASE 6) — implementa MailProvider usando o Microsoft Graph.
// Mesma interface do Gmail; toda diferença de API fica aqui.

import { admin, json } from '../base.ts'
import { getMicrosoftConfig, microsoftAccessToken } from '../microsoft.ts'
import { htmlToText } from '../gmail.ts'
import type { MailProvider, MailFolder, NormalizedMessage } from './types.ts'

const GRAPH = 'https://graph.microsoft.com/v1.0/me'

// Pastas conhecidas do Graph → pastas do CRM.
const WELL_KNOWN: Record<string, MailFolder> = {
  inbox: 'inbox', sentitems: 'sent', junkemail: 'spam', deleteditems: 'trash', archive: 'archive',
}
// Ação de mover → pasta de destino do Graph (well-known name).
const MOVE_DEST: Record<string, string> = {
  trash: 'deleteditems', untrash: 'inbox', inbox: 'inbox', archive: 'archive', spam: 'junkemail',
}
// Ação de mover → pasta resultante no CRM.
const MOVE_FOLDER: Record<string, MailFolder> = {
  trash: 'trash', untrash: 'inbox', inbox: 'inbox', archive: 'archive', spam: 'spam',
}

const MSG_SELECT = 'id,conversationId,subject,bodyPreview,body,from,toRecipients,receivedDateTime,sentDateTime,isRead,parentFolderId,categories'

export async function createMicrosoftProvider(orgId: string): Promise<MailProvider> {
  const { config, integrationId, lastSync } = await getMicrosoftConfig(orgId)
  const token = await microsoftAccessToken(config, integrationId)
  const self = config.from_email.toLowerCase()
  const H = { Authorization: `Bearer ${token}` }

  // Mapa folderId → pasta do CRM (resolve as pastas conhecidas uma vez).
  const folderIdToName: Record<string, MailFolder> = {}
  await Promise.all(Object.entries(WELL_KNOWN).map(async ([wk, name]) => {
    const r = await fetch(`${GRAPH}/mailFolders/${wk}?$select=id`, { headers: H })
    if (r.ok) { const f = await r.json(); if (f?.id) folderIdToName[f.id] = name }
  }))
  const folderOfParent = (parentId?: string): MailFolder => (parentId && folderIdToName[parentId]) || 'archive'

  // deno-lint-ignore no-explicit-any
  const normalize = (m: any): NormalizedMessage => {
    const from = m.from?.emailAddress?.address?.toLowerCase() || self
    const to = m.toRecipients?.[0]?.emailAddress?.address?.toLowerCase() || self
    const folder = folderOfParent(m.parentFolderId)
    const outbound = folder === 'sent' || from === self
    const isHtml = (m.body?.contentType || '').toLowerCase() === 'html'
    const raw = m.body?.content || m.bodyPreview || ''
    const body = (isHtml ? htmlToText(raw) : raw).slice(0, 50000)
    return {
      messageId: m.id,
      threadId: m.conversationId || m.id,
      fromEmail: from,
      toEmail: to,
      subject: m.subject || '',
      snippet: m.bodyPreview || '',
      body,
      folder,
      isRead: m.isRead !== false,
      labels: Array.isArray(m.categories) ? m.categories : [],
      direction: outbound ? 'outbound' : 'inbound',
      sentAt: m.receivedDateTime || m.sentDateTime || new Date().toISOString(),
    }
  }

  return {
    type: 'microsoft',
    selfEmail: self,
    integrationId,
    lastSync,

    async listMessageIds(sinceMs, max) {
      const since = new Date(sinceMs ?? (Date.now() - 3 * 86400000)).toISOString()
      const url = `${GRAPH}/messages?$select=id,conversationId&$top=${max}` +
        `&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${since}`
      const r = await fetch(url, { headers: H })
      if (!r.ok) throw json({ error: 'Falha ao listar e-mails da Microsoft.' }, 502)
      const d = await r.json() as { value?: Array<{ id: string; conversationId?: string }> }
      return (d.value || []).map(m => ({ id: m.id, threadId: m.conversationId || m.id }))
    },

    async getMessage(id): Promise<NormalizedMessage | null> {
      const r = await fetch(`${GRAPH}/messages/${id}?$select=${MSG_SELECT}`, { headers: H })
      if (!r.ok) return null
      return normalize(await r.json())
    },

    async modify(messageId, action) {
      // Ler/não-ler: PATCH isRead (não muda o id).
      if (action === 'read' || action === 'unread') {
        const r = await fetch(`${GRAPH}/messages/${messageId}`, {
          method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ isRead: action === 'read' }),
        })
        if (!r.ok) throw scopeOr(r.status, 'alterar')
        return { is_read: action === 'read' }
      }
      // Mover: POST /move devolve a mensagem com um NOVO id (o Graph muda o id
      // ao mover), então atualizamos message_id no CRM junto com a pasta.
      const dest = MOVE_DEST[action]
      if (!dest) throw json({ error: 'Ação inválida' }, 400)
      const r = await fetch(`${GRAPH}/messages/${messageId}/move`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationId: dest }),
      })
      if (!r.ok) throw scopeOr(r.status, 'mover')
      const moved = await r.json() as { id?: string }
      return { folder: MOVE_FOLDER[action], message_id: moved.id || messageId }
    },

    async send({ to, subject, body }) {
      const r = await fetch(`${GRAPH}/sendMail`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'Text', content: body },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          saveToSentItems: true,
        }),
      })
      if (!r.ok) {
        console.error('Microsoft send error:', await r.text())
        throw json({ error: 'Falha ao enviar o e-mail pela Microsoft.' }, 502)
      }
      // sendMail (202) não devolve id; a próxima sync importa o enviado de SentItems.
      return { messageId: '', threadId: '' }
    },

    async markSynced() {
      await admin().from('integrations')
        .update({ is_active: true, last_sync: new Date().toISOString() })
        .eq('id', integrationId)
    },
  }
}

// 403 do Graph → pede reconexão; outros → erro genérico.
function scopeOr(status: number, verbo: string): Response {
  if (status === 403) {
    return json({
      error: `Sua conta Microsoft não tem permissão para ${verbo} e-mails. Reconecte em Configurações → Integrações.`,
      code: 'scope_insufficient',
    }, 403)
  }
  return json({ error: `Falha ao ${verbo} o e-mail na Microsoft.` }, 502)
}
