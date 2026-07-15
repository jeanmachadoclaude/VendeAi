// wpp-webhook — recebe mensagens inbound da Evolution API
// URL configurada no Evolution API: https://[project].supabase.co/functions/v1/wpp-webhook?org=ORG_ID

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { timingSafeEqual, reportError } from '../_shared/base.ts'
import { getEvolution, evoHeaders } from '../_shared/evolution.ts'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

async function handleWebhook(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const url   = new URL(req.url)
  const orgId = url.searchParams.get('org')
  if (!orgId) return new Response('Missing org parameter', { status: 400 })

  // Autenticação: só a Evolution que nós configuramos conhece o token secreto
  // desta org (integrations.config.webhook_token). Sem ele — ou errado — não
  // processa nada. Isso impede que alguém que descubra o UUID da org injete
  // mensagens falsas no CRM.
  const token = url.searchParams.get('token')
  const { data: integ } = await admin
    .from('integrations')
    .select('config')
    .eq('org_id', orgId)
    .eq('type', 'whatsapp_evolution')
    .maybeSingle()
  const expectedToken = (integ?.config as Record<string, unknown> | null)?.webhook_token as string | undefined
  if (!expectedToken || !token || !timingSafeEqual(token, expectedToken)) {
    return new Response('Unauthorized', { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = await req.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  // Só processa eventos de nova mensagem
  if (payload.event !== 'messages.upsert') {
    return new Response('OK', { status: 200 })
  }

  const data = payload.data as Record<string, unknown>
  const key  = data?.key as Record<string, unknown>

  if (!key) return new Response('OK', { status: 200 })

  // fromMe = mensagem enviada pelo CELULAR do usuário (entra como outbound)
  // ou o ECO do que o CRM/automação acabou de enviar — nesse caso o
  // external_id já está gravado e o dedupe abaixo descarta.
  const fromMe = key.fromMe === true

  const remoteJid = String(key.remoteJid ?? '')

  // Ignora grupos e broadcasts
  if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) {
    return new Response('OK', { status: 200 })
  }

  // LID (identidade oculta do WhatsApp, formato novo): remoteJid vem como
  // "123456789@lid" e o telefone REAL vem em key.remoteJidAlt
  // ("5548...@s.whatsapp.net"). Sem tratar isso, cada mensagem criaria uma
  // conversa nova com "telefone" inválido em vez de casar com a existente.
  const remoteJidAlt = String((key as Record<string, unknown>).remoteJidAlt ?? '')
  const phoneJid = remoteJid.endsWith('@lid') && remoteJidAlt.includes('@s.whatsapp.net')
    ? remoteJidAlt : remoteJid
  const phone      = phoneJid.split('@')[0]
  const externalId = String(key.id ?? '')
  // Em fromMe o pushName é o NOSSO nome (remetente), não o do contato —
  // nunca usar para batizar a conversa.
  const pushName   = fromMe ? null : (String((data as Record<string, unknown>).pushName ?? '').trim() || null)

  // Extrai texto e detecta mídia (áudio/figurinha/GIF/imagem/vídeo/documento)
  const msg = data.message as Record<string, unknown> | null
  const img = msg?.imageMessage    as Record<string, unknown> | undefined
  const vid = msg?.videoMessage    as Record<string, unknown> | undefined
  const doc = msg?.documentMessage as Record<string, unknown> | undefined

  let mediaType: string | null = null
  if      (msg?.audioMessage)   mediaType = 'audio'
  else if (msg?.stickerMessage) mediaType = 'sticker'
  else if (vid)                 mediaType = vid.gifPlayback === true ? 'gif' : 'video'
  else if (img)                 mediaType = 'image'
  else if (doc)                 mediaType = 'document'

  const caption = String((img?.caption ?? vid?.caption ?? doc?.caption ?? '') || '').trim()
  const text = (msg?.conversation as string) ||
    ((msg?.extendedTextMessage as Record<string, unknown>)?.text as string) || ''

  // body = texto/legenda (pode ficar vazio quando é só mídia);
  // preview = o que aparece na lista de conversas
  const placeholders: Record<string, string> = {
    audio: '🎤 Áudio', sticker: '💟 Figurinha', gif: '🎞️ GIF',
    video: '🎬 Vídeo', image: '📷 Foto',
    document: '📎 ' + String(doc?.fileName ?? 'Arquivo'),
  }
  const body    = text || caption
  const preview = body || (mediaType ? placeholders[mediaType] : '[mídia]')

  // Deduplica por external_id
  if (externalId) {
    const { data: dup } = await admin
      .from('wpp_messages')
      .select('id')
      .eq('external_id', externalId)
      .maybeSingle()
    if (dup) return new Response('OK', { status: 200 })
  }

  // Busca ou cria conversa
  const { data: existing } = await admin
    .from('wpp_conversations')
    .select('id, unread_count, display_name, contact_id')
    .eq('org_id', orgId)
    .eq('phone', phone)
    .maybeSingle()

  let convId: string

  if (existing) {
    convId = existing.id
    await admin.from('wpp_conversations').update({
      last_message:    preview,
      last_message_at: new Date().toISOString(),
      // fromMe não conta como "não lida" — foi o próprio usuário que enviou
      unread_count:    fromMe ? (existing.unread_count ?? 0) : (existing.unread_count ?? 0) + 1,
      status:          'open',
      // pushName atualiza o nome exibido quando ainda não temos um
      ...(pushName && !existing.display_name ? { display_name: pushName } : {}),
    }).eq('id', convId)
  } else {
    // Vincula a um contato pelo telefone, ignorando formatação
    // ("(11) 99999-8888" no CRM × "5511999998888" no WhatsApp)
    const { data: matchedId } = await admin
      .rpc('wpp_match_contact', { p_org: orgId, p_phone: phone })

    const { data: newConv, error } = await admin
      .from('wpp_conversations')
      .insert({
        org_id:          orgId,
        phone,
        contact_id:      matchedId ?? null,
        display_name:    pushName,
        last_message:    preview,
        last_message_at: new Date().toISOString(),
        unread_count:    fromMe ? 0 : 1,
        status:          'open',
      })
      .select('id')
      .single()

    if (error || !newConv) {
      console.error('Erro ao criar conversa:', error)
      return new Response('Internal error', { status: 500 })
    }
    convId = newConv.id
  }

  // Baixa a mídia da Evolution e guarda no bucket privado wpp-media.
  // Falha aqui NUNCA derruba o webhook: a mensagem entra só com o texto/
  // placeholder (comportamento antigo) e o usuário vê a prévia na conversa.
  let mediaPath: string | null = null
  let mediaMime: string | null = null
  let mediaName: string | null = null
  if (mediaType && externalId) {
    try {
      const evo = await getEvolution(orgId)
      const mr = await fetch(`${evo.apiUrl}/chat/getBase64FromMediaMessage/${evo.instanceName}`, {
        method:  'POST',
        headers: evoHeaders(evo),
        body:    JSON.stringify({ message: { key: { id: externalId } }, convertToMp4: false }),
      })
      if (mr.ok) {
        const md  = await mr.json() as Record<string, unknown>
        const b64 = md.base64 as string | undefined
        // ~34M chars base64 ≈ 25MB (limite do bucket)
        if (b64 && b64.length <= 34_000_000) {
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
          mediaMime = String(md.mimetype ?? '') || 'application/octet-stream'
          mediaName = mediaType === 'document' ? String(doc?.fileName ?? md.fileName ?? 'arquivo') : null
          const extMap: Record<string, string> = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
            'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
            'video/mp4': 'mp4', 'application/pdf': 'pdf',
          }
          const baseMime = mediaMime.split(';')[0].trim()
          const ext = extMap[baseMime] || baseMime.split('/')[1] || 'bin'
          const path = `${orgId}/${convId}/${externalId}.${ext}`
          const { error: upErr } = await admin.storage.from('wpp-media')
            .upload(path, bytes, { contentType: baseMime, upsert: true })
          if (upErr) console.error('Erro ao subir mídia:', upErr)
          else mediaPath = path
        } else {
          console.warn('Mídia ignorada (acima de 25MB ou sem base64):', externalId)
        }
      } else {
        console.error('getBase64FromMediaMessage falhou:', mr.status, await mr.text().catch(() => ''))
      }
    } catch (e) {
      console.error('Erro ao baixar mídia:', e)
    }
  }

  // Insere a mensagem
  const { error: msgErr } = await admin.from('wpp_messages').insert({
    conversation_id: convId,
    direction:       fromMe ? 'outbound' : 'inbound',
    body:            body || (mediaPath ? '' : preview),
    status:          fromMe ? 'sent' : 'delivered',
    is_auto:         false,
    external_id:     externalId || null,
    media_type:      mediaPath ? mediaType : null,
    media_url:       mediaPath, // caminho no bucket wpp-media (não é URL pública)
    media_mime:      mediaMime,
    media_name:      mediaName,
  })

  if (msgErr) console.error('Erro ao inserir mensagem:', msgErr)

  return new Response('OK', { status: 200 })
}

// try/catch de último nível: qualquer erro não tratado é reportado ao Sentry
// (sem o corpo da mensagem) e responde 500 limpo — nunca derruba o webhook.
Deno.serve((req: Request) =>
  handleWebhook(req).catch(async (e) => {
    console.error('wpp-webhook erro não tratado:', e)
    await reportError(e, 'wpp-webhook')
    return new Response('Internal error', { status: 500 })
  })
)
