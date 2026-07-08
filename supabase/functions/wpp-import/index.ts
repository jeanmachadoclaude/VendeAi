// wpp-import — importa o HISTÓRICO de conversas do WhatsApp a partir do
// servidor Evolution (que sincroniza as conversas antigas do aparelho).
//
// POST autenticado. Processa em lotes para caber no tempo da function:
//   body: { offset?: number, batch?: number, perChat?: number }
//   resposta: { totalChats, processed, nextOffset, done, chats, messages }
// O frontend chama em loop até done=true.
//
// Regras (iguais ao webhook): só conversas privadas (sem grupos/broadcast),
// dedupe por external_id, contato vinculado pelo telefone quando existir.
// Mensagens importadas NÃO somam em unread_count.

import { json, cors, admin, requireUser } from '../_shared/base.ts'
import { getEvolution, evoHeaders } from '../_shared/evolution.ts'

interface EvoChat {
  remoteJid?: string
  pushName?: string | null
  updatedAt?: string
}
interface EvoMsg {
  key?: { id?: string; fromMe?: boolean; remoteJid?: string }
  message?: Record<string, unknown> | null
  messageTimestamp?: number | string
}

function extractBody(msg: Record<string, unknown> | null | undefined): string {
  if (!msg) return '[mídia]'
  return (
    (msg.conversation as string) ||
    ((msg.extendedTextMessage as Record<string, unknown>)?.text as string) ||
    ((msg.imageMessage as Record<string, unknown>)?.caption as string) ||
    ((msg.videoMessage as Record<string, unknown>)?.caption as string) ||
    (msg.imageMessage    ? '[imagem]'  : null) ||
    (msg.audioMessage    ? '[áudio]'   : null) ||
    (msg.videoMessage    ? '[vídeo]'   : null) ||
    (msg.documentMessage ? '[arquivo]' : null) ||
    (msg.stickerMessage  ? '[sticker]' : null) ||
    (msg.contactMessage  ? '[contato]' : null) ||
    (msg.locationMessage ? '[localização]' : null) ||
    '[mídia]'
  ) as string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId } = await requireUser(req)
    const cfg = await getEvolution(orgId)
    const db = admin()

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const offset  = Math.max(0, Number(body.offset) || 0)
    const batch   = Math.min(50, Math.max(1, Number(body.batch) || 20))
    const perChat = Math.min(200, Math.max(1, Number(body.perChat) || 50))

    // 1. Lista de chats no servidor Evolution (histórico sincronizado do aparelho)
    const chatsRes = await fetch(`${cfg.apiUrl}/chat/findChats/${cfg.instanceName}`, {
      method: 'POST', headers: evoHeaders(cfg), body: JSON.stringify({}),
    })
    if (!chatsRes.ok) {
      return json({ error: 'Servidor Evolution não respondeu a lista de conversas (' + chatsRes.status + ')' }, 502)
    }
    const allChats = await chatsRes.json() as EvoChat[]
    const privChats = (Array.isArray(allChats) ? allChats : [])
      .filter(c => String(c.remoteJid || '').endsWith('@s.whatsapp.net'))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))

    const slice = privChats.slice(offset, offset + batch)
    let msgCount = 0
    let chatCount = 0

    for (const chat of slice) {
      const remoteJid = String(chat.remoteJid)
      const phone = remoteJid.split('@')[0]

      // 2. Mensagens do chat
      const msgsRes = await fetch(`${cfg.apiUrl}/chat/findMessages/${cfg.instanceName}`, {
        method: 'POST', headers: evoHeaders(cfg),
        body: JSON.stringify({ where: { key: { remoteJid } }, limit: perChat }),
      })
      if (!msgsRes.ok) continue
      const msgsData = await msgsRes.json() as Record<string, unknown>
      const records = ((msgsData.messages as Record<string, unknown>)?.records ??
        (Array.isArray(msgsData) ? msgsData : [])) as EvoMsg[]
      if (!records.length) continue

      // Ordena do mais antigo ao mais novo e corta nas N mais recentes
      // (a Evolution ignora o "limit" do body — devolve até 50 por página)
      const msgs = records
        .filter(m => m.key?.id)
        .sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0))
        .slice(-perChat)
      if (!msgs.length) continue

      const newest = msgs[msgs.length - 1]
      const newestBody = extractBody(newest.message)
      const newestAt = new Date(Number(newest.messageTimestamp || 0) * 1000).toISOString()

      // 3. Conversa: reaproveita a existente ou cria vinculando o contato
      const { data: existing } = await db.from('wpp_conversations')
        .select('id, last_message_at').eq('org_id', orgId).eq('phone', phone).maybeSingle()

      let convId: string
      if (existing) {
        convId = existing.id
        // Só atualiza o resumo se o histórico for mais novo que o que já está lá
        if (!existing.last_message_at || existing.last_message_at < newestAt) {
          await db.from('wpp_conversations')
            .update({ last_message: newestBody, last_message_at: newestAt })
            .eq('id', convId)
        }
      } else {
        const { data: contact } = await db.from('contacts')
          .select('id').eq('org_id', orgId)
          .or(`phone.eq.${phone},whatsapp.eq.${phone}`).maybeSingle()
        const { data: nc, error } = await db.from('wpp_conversations').insert({
          org_id: orgId,
          phone,
          contact_id: contact?.id ?? null,
          last_message: newestBody,
          last_message_at: newestAt,
          unread_count: 0,
          status: 'open',
        }).select('id').single()
        if (error || !nc) continue
        convId = nc.id
      }

      // 4. Dedupe em lote + insere as que faltam com a data original
      const ids = msgs.map(m => String(m.key!.id))
      const { data: dups } = await db.from('wpp_messages')
        .select('external_id').eq('conversation_id', convId).in('external_id', ids)
      const seen = new Set((dups || []).map(d => d.external_id))

      const rows = msgs
        .filter(m => !seen.has(String(m.key!.id)))
        .map(m => ({
          conversation_id: convId,
          direction: m.key?.fromMe ? 'outbound' : 'inbound',
          body: extractBody(m.message),
          status: m.key?.fromMe ? 'sent' : 'delivered',
          is_auto: false,
          external_id: String(m.key!.id),
          created_at: new Date(Number(m.messageTimestamp || 0) * 1000).toISOString(),
        }))

      if (rows.length) {
        const { error: insErr } = await db.from('wpp_messages').insert(rows)
        if (!insErr) msgCount += rows.length
      }
      chatCount++
    }

    const nextOffset = offset + slice.length
    return json({
      totalChats: privChats.length,
      processed: nextOffset,
      nextOffset,
      done: nextOffset >= privChats.length,
      chats: chatCount,
      messages: msgCount,
    })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    return json({ error: String((e as Error).message || e) }, 500)
  }
})
