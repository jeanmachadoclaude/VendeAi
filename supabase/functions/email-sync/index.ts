// email-sync - sincroniza a caixa de e-mail do Gmail com o CRM (FASE 4)
// Importa TODAS as pastas (Entrada/Enviados/Spam/Lixo/Arquivo), derivando a
// pasta pelos labels do Gmail, e mantém o corpo completo + estado de leitura.
//
// Duas formas de rodar:
//   - JWT do usuário (frontend): sincroniza só a org dele.
//   - x-worker-key (pg_cron): varre todas as orgs com Gmail conectado.

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import {
  getGmailConfig, gmailAccessToken, headerValue, bareEmail,
  extractBody, folderFromLabels, isUnread,
} from '../_shared/gmail.ts'

const MAX_PER_SYNC = 60 // e-mails processados por org por invocação (limita custo)

// Sincroniza uma org. Retorna { imported, updated } ou lança em erro fatal.
async function syncOrg(orgId: string): Promise<{ imported: number; updated: number }> {
  const { config, integrationId, lastSync } = await getGmailConfig(orgId)
  const token = await gmailAccessToken(config, integrationId)
  const db = admin()
  const self = config.from_email.toLowerCase()

  // Janela desde a última sync (mínimo 3 dias no primeiro run); inclui spam/lixo.
  const sinceMs = lastSync ? new Date(lastSync).getTime() : Date.now() - 3 * 86400000
  const after = Math.floor(Math.min(sinceMs, Date.now() - 3600000) / 1000)
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=after:${after}&includeSpamTrash=true&maxResults=${MAX_PER_SYNC}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!listRes.ok) throw json({ error: 'Falha ao listar e-mails do Gmail.' }, 502)
  const list = await listRes.json() as { messages?: Array<{ id: string; threadId: string }> }

  let imported = 0, updated = 0
  for (const m of list.messages || []) {
    // Se já existe, só atualiza pasta/leitura/labels (reflete mover/ler no Gmail)
    const { data: dup } = await db.from('emails').select('id, folder, is_read')
      .eq('org_id', orgId).eq('message_id', m.id).maybeSingle()

    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!msgRes.ok) continue
    const msg = await msgRes.json()
    const labels: string[] = msg.labelIds || []
    const folder = folderFromLabels(labels)
    const read = !isUnread(labels)

    if (dup) {
      if (dup.folder !== folder || dup.is_read !== read) {
        await db.from('emails').update({ folder, is_read: read, gmail_labels: labels })
          .eq('id', dup.id)
        updated++
      }
      continue
    }

    const headers = msg.payload?.headers || []
    const fromEmail = bareEmail(headerValue(headers, 'From'))
    const toEmail = bareEmail(headerValue(headers, 'To'))
    const outbound = labels.includes('SENT') || fromEmail === self
    const fullBody = extractBody(msg.payload) || msg.snippet || ''

    // Vincula a um contato do CRM pelo outro lado da conversa (best-effort).
    const other = outbound ? toEmail : fromEmail
    let contactId: string | null = null, dealId: string | null = null
    if (other) {
      const { data: contact } = await db.from('contacts')
        .select('id').eq('org_id', orgId).ilike('email', other).maybeSingle()
      contactId = contact?.id || null
      if (contactId) {
        const { data: deal } = await db.from('deals').select('id')
          .eq('org_id', orgId).eq('contact_id', contactId).eq('status', 'open')
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        dealId = deal?.id || null
      }
    }

    await db.from('emails').insert({
      org_id: orgId,
      contact_id: contactId,
      deal_id: dealId,
      direction: outbound ? 'outbound' : 'inbound',
      from_email: fromEmail || self,
      to_email: toEmail || self,
      subject: headerValue(headers, 'Subject'),
      snippet: msg.snippet || '',
      body: fullBody,
      message_id: m.id,
      thread_id: m.threadId,
      folder,
      is_read: read,
      gmail_labels: labels,
      status: outbound ? 'sent' : 'received',
      sent_at: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
    })

    // Atividade só para e-mail recebido de um contato na inbox (evita ruído
    // de mala-direta/spam que não tem relação com o CRM).
    if (!outbound && contactId && folder === 'inbox') {
      await db.from('activities').insert({
        org_id: orgId, contact_id: contactId, deal_id: dealId,
        type: 'email', title: `E-mail recebido: ${headerValue(headers, 'Subject') || '(sem assunto)'}`,
        body: (msg.snippet || '').slice(0, 300),
        meta: { message_id: m.id },
      })
    }
    imported++
  }

  await db.from('integrations').update({
    is_active: true, last_sync: new Date().toISOString(),
  }).eq('id', integrationId)

  return { imported, updated }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Auth: worker key (cron, todas as orgs) OU JWT de usuário (só a org dele).
  let orgFilter: string | null = null
  const workerKey = Deno.env.get('EMAIL_WORKER_KEY')
  const gotKey = req.headers.get('x-worker-key')
  if (!workerKey || gotKey !== workerKey) {
    try {
      const { orgId } = await requireUser(req)
      orgFilter = orgId
    } catch (e) {
      return e instanceof Response ? e : json({ error: 'Não autorizado' }, 401)
    }
  }

  try {
    // Cron: todas as orgs com Gmail conectado. Manual: só a org do usuário.
    let orgIds: string[]
    if (orgFilter) {
      orgIds = [orgFilter]
    } else {
      const { data: ints } = await admin().from('integrations')
        .select('org_id').eq('type', 'gmail').eq('is_active', true)
      orgIds = [...new Set((ints || []).map(i => i.org_id as string))]
    }

    let imported = 0, updated = 0, orgsOk = 0, orgsFail = 0
    for (const oid of orgIds) {
      try {
        const r = await syncOrg(oid)
        imported += r.imported; updated += r.updated; orgsOk++
      } catch (e) {
        orgsFail++
        // No modo manual (1 org), propaga o erro para a UI mostrar a mensagem.
        if (orgFilter) throw e
        console.error(`email-sync org ${oid}:`, e)
        await reportError(e, { functionName: 'email-sync', orgId: oid })
      }
    }

    return json({ ok: true, imported, updated, orgs: orgsOk, orgsFail })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'email-sync')
    return json({ error: String((e as { message?: string })?.message || e) }, 500)
  }
})
