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

import { json, cors, admin, requireUser, reportError } from '../_shared/base.ts'
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
    const { user, orgId, role } = await requireUser(req)
    const db = admin()

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const offset  = Math.max(0, Number(body.offset) || 0)
    const batch   = Math.min(50, Math.max(1, Number(body.batch) || 20))
    const perChat = Math.min(200, Math.max(1, Number(body.perChat) || 50))

    // Importar dados exige admin — ou a senha de autorização definida pelo
    // admin (hash bcrypt em organizations.settings.export_pass_hash).
    // Validação no servidor: não dá para burlar chamando a function direto.
    if (role !== 'admin') {
      const { data: passOk } = await db.rpc('verify_export_password', {
        p_org: orgId, p_password: String(body.auth_password || ''),
      })
      if (!passOk) {
        await db.from('audit_logs').insert({
          org_id: orgId, user_id: user.id, user_email: user.email,
          action: 'import_negado', entity: 'whatsapp_historico',
          details: { motivo: 'senha de autorização ausente ou incorreta' },
        })
        return json({ error: 'Apenas administradores podem importar dados — ou informe a senha de autorização definida pelo admin.' }, 403)
      }
    }
    // Registra a importação uma vez (a function roda em lotes)
    if (offset === 0) {
      await db.from('audit_logs').insert({
        org_id: orgId, user_id: user.id, user_email: user.email,
        action: 'import', entity: 'whatsapp_historico', details: { autorizado: true },
      })
    }

    const cfg = await getEvolution(orgId)

    // 1. Lista de chats no servidor Evolution (histórico sincronizado do aparelho)
    const chatsRes = await fetch(`${cfg.apiUrl}/chat/findChats/${cfg.instanceName}`, {
      method: 'POST', headers: evoHeaders(cfg), body: JSON.stringify({}),
    })
    if (!chatsRes.ok) {
      return json({ error: 'Servidor Evolution não respondeu a lista de conversas (' + chatsRes.status + ')' }, 502)
    }
    const allChats = await chatsRes.json() as EvoChat[]
    // Privadas = @s.whatsapp.net (formato clássico) OU @lid (identidade oculta,
    // formato novo do WhatsApp — o telefone real é resolvido por mensagem via
    // key.remoteJidAlt). O mesmo contato pode ter os dois chats; o dedupe por
    // external_id e o find-or-create por telefone juntam tudo numa conversa só.
    const privChats = (Array.isArray(allChats) ? allChats : [])
      .filter(c => {
        const j = String(c.remoteJid || '')
        return j.endsWith('@s.whatsapp.net') || j.endsWith('@lid')
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))

    // 1b. Nomes: findChats devolve pushName nulo na Evolution 2.3.7 —
    // os nomes vivem em findContacts. Monta o mapa jid → nome uma vez.
    const nomes = new Map<string, string>()
    try {
      const ctRes = await fetch(`${cfg.apiUrl}/chat/findContacts/${cfg.instanceName}`, {
        method: 'POST', headers: evoHeaders(cfg), body: JSON.stringify({}),
      })
      if (ctRes.ok) {
        const cts = await ctRes.json() as Array<{ remoteJid?: string; pushName?: string | null }>
        for (const ct of (Array.isArray(cts) ? cts : [])) {
          const jid = String(ct.remoteJid || '')
          const nm = String(ct.pushName || '').trim()
          if (jid.endsWith('@s.whatsapp.net') && nm) nomes.set(jid, nm)
        }
      }
    } catch (_) { /* sem nomes, segue sem eles */ }

    const slice = privChats.slice(offset, offset + batch)
    let msgCount = 0
    let chatCount = 0

    for (const chat of slice) {
      const remoteJid = String(chat.remoteJid)
      let phone = remoteJid.split('@')[0]
      const pushName = nomes.get(remoteJid) || String(chat.pushName || '').trim() || null

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

      // Chat @lid: o telefone real vem em key.remoteJidAlt das mensagens.
      // Sem ele não há como casar com contato/conversa — pula o chat.
      if (remoteJid.endsWith('@lid')) {
        const alt = msgs
          .map(m => String((m.key as Record<string, unknown> | undefined)?.remoteJidAlt ?? ''))
          .find(j => j.endsWith('@s.whatsapp.net'))
        if (!alt) continue
        phone = alt.split('@')[0]
      }

      const newest = msgs[msgs.length - 1]
      const newestBody = extractBody(newest.message)
      const newestAt = new Date(Number(newest.messageTimestamp || 0) * 1000).toISOString()

      // 3. Conversa: reaproveita a existente ou cria vinculando o contato.
      // Matching por telefone via RPC (ignora formatação: "(11) 9..." × "5511...").
      const { data: matchedId } = await db.rpc('wpp_match_contact', { p_org: orgId, p_phone: phone })

      const { data: existing } = await db.from('wpp_conversations')
        .select('id, last_message_at, display_name, contact_id')
        .eq('org_id', orgId).eq('phone', phone).maybeSingle()

      let convId: string
      if (existing) {
        convId = existing.id
        const patch: Record<string, unknown> = {}
        // Só atualiza o resumo se o histórico for mais novo que o que já está lá
        if (!existing.last_message_at || existing.last_message_at < newestAt) {
          patch.last_message = newestBody
          patch.last_message_at = newestAt
        }
        if (pushName && !existing.display_name) patch.display_name = pushName
        if (!existing.contact_id && matchedId) patch.contact_id = matchedId
        if (Object.keys(patch).length) {
          await db.from('wpp_conversations').update(patch).eq('id', convId)
        }
      } else {
        const { data: nc, error } = await db.from('wpp_conversations').insert({
          org_id: orgId,
          phone,
          contact_id: matchedId ?? null,
          display_name: pushName,
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
    await reportError(e, 'wpp-import')
    return json({ error: String((e as Error).message || e) }, 500)
  }
})
