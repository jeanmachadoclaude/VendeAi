// email-sync - sincroniza a caixa de e-mail com o CRM (FASE 4 + abstração FASE 5)
// Importa TODAS as pastas (Entrada/Enviados/Spam/Lixo/Arquivo) via o provedor
// configurado da org (Gmail hoje, Microsoft na Fase 6). A lógica de banco
// (dedupe, vínculo com contato, atividade) é agnóstica; só a camada de API muda.
//
// Duas formas de rodar:
//   - JWT do usuário (frontend): sincroniza só a org dele.
//   - x-worker-key (pg_cron): varre todas as orgs com e-mail conectado.

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getMailProvider, orgsWithMail } from '../_shared/mail/index.ts'

const MAX_PER_SYNC = 60 // e-mails processados por org por invocação (limita custo)

// Sincroniza uma org. Retorna { imported, updated } ou lança em erro fatal.
async function syncOrg(orgId: string): Promise<{ imported: number; updated: number }> {
  const provider = await getMailProvider(orgId)
  const db = admin()

  const sinceMs = provider.lastSync ? new Date(provider.lastSync).getTime() : null
  const ids = await provider.listMessageIds(sinceMs, MAX_PER_SYNC)

  let imported = 0, updated = 0
  for (const { id } of ids) {
    // Se já existe, só atualiza pasta/leitura/labels (reflete mover/ler no provedor)
    const { data: dup } = await db.from('emails').select('id, folder, is_read')
      .eq('org_id', orgId).eq('message_id', id).maybeSingle()

    const msg = await provider.getMessage(id)
    if (!msg) continue

    if (dup) {
      if (dup.folder !== msg.folder || dup.is_read !== msg.isRead) {
        await db.from('emails').update({ folder: msg.folder, is_read: msg.isRead, gmail_labels: msg.labels })
          .eq('id', dup.id)
        updated++
      }
      continue
    }

    // Vincula a um contato do CRM pelo outro lado da conversa (best-effort).
    const other = msg.direction === 'outbound' ? msg.toEmail : msg.fromEmail
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
      direction: msg.direction,
      from_email: msg.fromEmail,
      to_email: msg.toEmail,
      subject: msg.subject,
      snippet: msg.snippet,
      body: msg.body,
      message_id: msg.messageId,
      thread_id: msg.threadId,
      folder: msg.folder,
      is_read: msg.isRead,
      gmail_labels: msg.labels,
      status: msg.direction === 'outbound' ? 'sent' : 'received',
      sent_at: msg.sentAt,
    })

    // Atividade só para e-mail recebido de um contato na inbox (evita ruído
    // de mala-direta/spam que não tem relação com o CRM).
    if (msg.direction === 'inbound' && contactId && msg.folder === 'inbox') {
      await db.from('activities').insert({
        org_id: orgId, contact_id: contactId, deal_id: dealId,
        type: 'email', title: `E-mail recebido: ${msg.subject || '(sem assunto)'}`,
        body: (msg.snippet || '').slice(0, 300),
        meta: { message_id: msg.messageId },
      })
    }
    imported++
  }

  await provider.markSynced()
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
    const orgIds = orgFilter ? [orgFilter] : await orgsWithMail()

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
