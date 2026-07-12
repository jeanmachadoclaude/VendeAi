// wpp-webhook — recebe mensagens inbound da Evolution API
// URL configurada no Evolution API: https://[project].supabase.co/functions/v1/wpp-webhook?org=ORG_ID

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { timingSafeEqual, reportError } from '../_shared/base.ts'

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

  // Ignora mensagens enviadas por nós
  if (!key || key.fromMe === true) return new Response('OK', { status: 200 })

  const remoteJid = String(key.remoteJid ?? '')

  // Ignora grupos e broadcasts
  if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) {
    return new Response('OK', { status: 200 })
  }

  const phone      = remoteJid.split('@')[0]
  const externalId = String(key.id ?? '')
  const pushName   = String((data as Record<string, unknown>).pushName ?? '').trim() || null

  // Extrai texto da mensagem (suporta texto, imagem com legenda, áudio, etc.)
  const msg = data.message as Record<string, unknown> | null
  const body = (
    (msg?.conversation as string) ||
    ((msg?.extendedTextMessage as Record<string, unknown>)?.text as string) ||
    ((msg?.imageMessage    as Record<string, unknown>)?.caption as string) ||
    (msg?.audioMessage    ? '[áudio]'   : null) ||
    (msg?.videoMessage    ? '[vídeo]'   : null) ||
    (msg?.documentMessage ? '[arquivo]' : null) ||
    (msg?.stickerMessage  ? '[sticker]' : null) ||
    '[mídia]'
  ) as string

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
      last_message:    body,
      last_message_at: new Date().toISOString(),
      unread_count:    (existing.unread_count ?? 0) + 1,
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
        last_message:    body,
        last_message_at: new Date().toISOString(),
        unread_count:    1,
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

  // Insere a mensagem
  const { error: msgErr } = await admin.from('wpp_messages').insert({
    conversation_id: convId,
    direction:       'inbound',
    body,
    status:          'delivered',
    is_auto:         false,
    external_id:     externalId || null,
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
