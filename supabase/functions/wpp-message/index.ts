// wpp-message — edita ou apaga uma mensagem ENVIADA no WhatsApp
// via Evolution API, respeitando as janelas do próprio WhatsApp:
//   editar: até 15 minutos após o envio
//   apagar (para todos): até 48 horas após o envio
// Frontend: sb.functions.invoke('wpp-message', { body: { action, message_id, new_text? } })
// A linha em wpp_messages é preservada (edited_at/deleted_at marcam o que houve).

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getEvolution, evoHeaders } from '../_shared/evolution.ts'

const JANELA_EDITAR_MIN = 15
const JANELA_APAGAR_H = 48

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId } = await requireUser(req)
    const { action, message_id, new_text } = await req.json() as {
      action: 'edit' | 'delete'; message_id: string; new_text?: string
    }
    if (!message_id || !['edit', 'delete'].includes(action)) {
      return json({ error: 'action (edit|delete) e message_id são obrigatórios' }, 400)
    }
    if (action === 'edit' && !String(new_text || '').trim()) {
      return json({ error: 'new_text é obrigatório para editar' }, 400)
    }

    const db = admin()

    // Mensagem + conversa (valida a org via conversa-mãe)
    const { data: msg } = await db.from('wpp_messages')
      .select('id, direction, body, status, external_id, created_at, edited_at, deleted_at, conversation_id, wpp_conversations(org_id, phone)')
      .eq('id', message_id).maybeSingle()
    const conv = msg?.wpp_conversations as { org_id?: string; phone?: string } | null
    if (!msg || conv?.org_id !== orgId) return json({ error: 'Mensagem não encontrada' }, 404)

    if (msg.direction !== 'outbound') return json({ error: 'Só é possível editar/apagar mensagens enviadas por você' }, 400)
    if (msg.deleted_at) return json({ error: 'Esta mensagem já foi apagada' }, 400)
    if (!msg.external_id) return json({ error: 'Mensagem sem vínculo com o WhatsApp (não foi enviada pelo servidor) — não dá para alterá-la no aparelho do contato' }, 400)

    const idadeMs = Date.now() - new Date(msg.created_at).getTime()
    if (action === 'edit' && idadeMs > JANELA_EDITAR_MIN * 60_000) {
      return json({ error: `O WhatsApp só permite editar mensagens até ${JANELA_EDITAR_MIN} minutos após o envio` }, 400)
    }
    if (action === 'delete' && idadeMs > JANELA_APAGAR_H * 3_600_000) {
      return json({ error: `O WhatsApp só permite apagar para todos até ${JANELA_APAGAR_H}h após o envio` }, 400)
    }

    const evo = await getEvolution(orgId)
    const remoteJid = `${conv!.phone}@s.whatsapp.net`

    if (action === 'delete') {
      const res = await fetch(`${evo.apiUrl}/chat/deleteMessageForEveryone/${evo.instanceName}`, {
        method: 'DELETE', headers: evoHeaders(evo),
        body: JSON.stringify({ id: msg.external_id, remoteJid, fromMe: true }),
      })
      if (!res.ok) {
        console.error('Evolution delete error:', res.status, await res.text())
        return json({ error: `O WhatsApp recusou apagar a mensagem (${res.status}). Ela pode ser antiga demais.` }, 502)
      }
      await db.from('wpp_messages').update({
        deleted_at: new Date().toISOString(),
        body: '🚫 Mensagem apagada',
      }).eq('id', msg.id)
      // Atualiza a prévia da conversa se esta era a última mensagem
      await db.from('wpp_conversations')
        .update({ last_message: '🚫 Mensagem apagada' })
        .eq('id', msg.conversation_id).eq('last_message', msg.body)
      return json({ ok: true, action: 'delete' })
    }

    // edit
    const texto = String(new_text).trim()
    const res = await fetch(`${evo.apiUrl}/chat/updateMessage/${evo.instanceName}`, {
      method: 'POST', headers: evoHeaders(evo),
      body: JSON.stringify({
        number: conv!.phone,
        key: { remoteJid, fromMe: true, id: msg.external_id },
        text: texto,
      }),
    })
    if (!res.ok) {
      console.error('Evolution edit error:', res.status, await res.text())
      return json({ error: `O WhatsApp recusou a edição (${res.status}). A janela de 15 minutos pode ter passado.` }, 502)
    }
    await db.from('wpp_messages').update({
      body: texto,
      edited_at: new Date().toISOString(),
    }).eq('id', msg.id)
    await db.from('wpp_conversations')
      .update({ last_message: texto })
      .eq('id', msg.conversation_id).eq('last_message', msg.body)
    return json({ ok: true, action: 'edit', body: texto })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'wpp-message')
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
