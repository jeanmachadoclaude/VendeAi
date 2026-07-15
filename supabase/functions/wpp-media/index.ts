// wpp-media - envio de mídia (foto/vídeo/documento/áudio) via Evolution API.
// Chamado pelo frontend com o JWT do usuário; a API key nunca sai do servidor.
// A mídia também é guardada no bucket privado wpp-media (mesmo padrão do
// webhook de recebimento), então ela renderiza no CRM via URL assinada.

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getEvolution, evoHeaders } from '../_shared/evolution.ts'

// ~16M chars base64 ≈ 12MB de arquivo (limite prático do payload da function;
// o bucket aceita até 25MB e o WhatsApp até 16MB para a maioria das mídias)
const MAX_B64 = 16_000_000

const PREVIEWS: Record<string, string> = {
  image: '📷 Foto', video: '🎬 Vídeo', audio: '🎤 Áudio', document: '📎 Arquivo',
}

const EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf',
}

async function handleMedia(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405, headers: cors })

  const { user, orgId } = await requireUser(req)

  let body: {
    conversation_id: string
    kind: 'media' | 'audio'          // audio = mensagem de voz (ptt)
    mediatype?: 'image' | 'video' | 'document'
    mimetype?: string
    file_name?: string
    caption?: string
    base64: string
  }
  try   { body = await req.json() }
  catch { return json({ error: 'JSON inválido' }, 400) }

  const { conversation_id, kind, caption } = body
  const b64 = (body.base64 || '').replace(/^data:[^;]+;base64,/, '')
  if (!conversation_id || !kind || !b64) return json({ error: 'Campos obrigatórios: conversation_id, kind, base64' }, 400)
  if (b64.length > MAX_B64) return json({ error: 'Arquivo grande demais (máx. ~12MB)' }, 413)

  const mediatype = kind === 'audio' ? 'audio' : (body.mediatype || 'document')
  if (!['image', 'video', 'document', 'audio'].includes(mediatype)) return json({ error: 'mediatype inválido' }, 400)
  const mimetype = (body.mimetype || 'application/octet-stream').split(';')[0].trim()
  const fileName = body.file_name || 'arquivo'

  // Conversa precisa pertencer à org do usuário
  const { data: conv } = await admin()
    .from('wpp_conversations')
    .select('phone')
    .eq('id', conversation_id)
    .eq('org_id', orgId)
    .single()
  if (!conv) return json({ error: 'Conversa não encontrada' }, 404)

  // ── Envio pela Evolution ──────────────────────────────────────
  let externalId: string | null = null
  let msgStatus = 'pending'
  let notice: string | null = null

  let evo = null
  try { evo = await getEvolution(orgId) }
  catch (_) { notice = 'WhatsApp ainda não ativado. Ative em Configurações → Integrações.' }

  if (evo) {
    try {
      // Áudio vira mensagem de voz (a Evolution converte p/ ogg/opus via ffmpeg);
      // o resto vai por sendMedia com o tipo certo.
      const endpoint = kind === 'audio'
        ? `${evo.apiUrl}/message/sendWhatsAppAudio/${evo.instanceName}`
        : `${evo.apiUrl}/message/sendMedia/${evo.instanceName}`
      const payload = kind === 'audio'
        ? { number: conv.phone, audio: b64 }
        : { number: conv.phone, mediatype, mimetype, media: b64, fileName, caption: caption || undefined }

      const evoRes = await fetch(endpoint, {
        method: 'POST', headers: evoHeaders(evo), body: JSON.stringify(payload),
      })
      if (evoRes.ok) {
        const evoData = await evoRes.json() as Record<string, unknown>
        const evoKey  = evoData.key as Record<string, unknown> | undefined
        externalId    = evoKey?.id ? String(evoKey.id) : null
        msgStatus     = 'sent'
      } else {
        console.error('Evolution sendMedia error:', evoRes.status, await evoRes.text().catch(() => ''))
        notice = (evoRes.status === 401 || evoRes.status === 403 || evoRes.status === 404)
          ? 'WhatsApp desconectado. Reconecte pelo QR em Configurações → Integrações.'
          : 'WhatsApp temporariamente indisponível. O arquivo foi salvo e você pode reenviar em instantes.'
      }
    } catch (e) {
      console.error('Fetch error ao chamar Evolution API:', e)
      notice = 'WhatsApp temporariamente indisponível. O arquivo foi salvo e você pode reenviar em instantes.'
    }
  }

  // ── Guarda a mídia no bucket privado (renderiza no CRM) ──────
  let mediaPath: string | null = null
  try {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const ext = EXT_MAP[mimetype] || mimetype.split('/')[1] || 'bin'
    mediaPath = `${orgId}/${conversation_id}/${externalId || crypto.randomUUID()}.${ext}`
    const { error: upErr } = await admin().storage.from('wpp-media')
      .upload(mediaPath, bytes, { contentType: mimetype, upsert: true })
    if (upErr) { console.error('Erro ao subir mídia:', upErr); mediaPath = null }
  } catch (e) { console.error('Erro ao decodificar/subir mídia:', e); mediaPath = null }

  const mediaName = mediatype === 'document' ? fileName : null
  const preview = caption || PREVIEWS[mediatype] || '[mídia]'

  // Corrida com o eco do webhook (fromMe entra pelo webhook): se a mensagem
  // já existe com este external_id, completa em vez de duplicar.
  if (externalId) {
    const { data: eco } = await admin().from('wpp_messages')
      .select('*').eq('external_id', externalId).maybeSingle()
    if (eco) {
      const patch: Record<string, unknown> = { sent_by: user.id }
      if (!eco.media_url && mediaPath) {
        patch.media_url = mediaPath; patch.media_type = mediatype
        patch.media_mime = mimetype; patch.media_name = mediaName
      }
      await admin().from('wpp_messages').update(patch).eq('id', eco.id)
      return json({ ...eco, ...patch, delivered: true, notice })
    }
  }

  const { data: msg, error: msgErr } = await admin()
    .from('wpp_messages')
    .insert({
      conversation_id,
      direction:   'outbound',
      body:        caption || '',
      status:      msgStatus,
      sent_by:     user.id,
      is_auto:     false,
      external_id: externalId,
      media_type:  mediaPath ? mediatype : null,
      media_url:   mediaPath,
      media_mime:  mimetype,
      media_name:  mediaName,
    })
    .select()
    .single()
  if (msgErr) { console.error('DB error:', msgErr); return json({ error: 'Erro ao salvar mensagem' }, 500) }

  await admin().from('wpp_conversations').update({
    last_message:    preview,
    last_message_at: new Date().toISOString(),
  }).eq('id', conversation_id)

  return json({ ...msg, delivered: msgStatus === 'sent', notice })
}

// Erro não tratado vai ao Sentry (sem o conteúdo da mídia) e responde 500 limpo.
Deno.serve((req: Request) =>
  handleMedia(req).catch(async (e) => {
    if (e instanceof Response) return e // controle de fluxo do requireUser/json
    console.error('wpp-media erro não tratado:', e)
    await reportError(e, 'wpp-media')
    return new Response('Internal error', { status: 500, headers: cors })
  })
)
