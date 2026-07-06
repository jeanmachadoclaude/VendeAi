// call-webhook — recebe a gravação da ligação, transcreve (Whisper) e salva.
// URL registrada no provedor: {SUPABASE_URL}/functions/v1/call-webhook?org=ORG_ID&call=CALL_ID
// Aceita callbacks do Twilio (form-encoded) e JSON genérico { recording_url, duration }.
// Deploy com: supabase functions deploy call-webhook --no-verify-jwt
// Requer o secret OPENAI_API_KEY (Whisper) — supabase secrets set OPENAI_API_KEY=sk-...

import { admin, json } from '../_shared/base.ts'

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const url = new URL(req.url)
  const orgId = url.searchParams.get('org')
  const callId = url.searchParams.get('call')
  if (!orgId) return new Response('Missing org', { status: 400 })

  // Payload: Twilio manda form-encoded; outros provedores podem mandar JSON
  let recordingUrl = ''
  let duration = 0
  let providerCallId = ''
  const ct = req.headers.get('content-type') || ''
  if (ct.includes('json')) {
    const body = await req.json().catch(() => ({}))
    recordingUrl = body.recording_url || body.RecordingUrl || ''
    duration = parseInt(body.duration || body.RecordingDuration || '0')
    providerCallId = body.call_id || body.CallSid || ''
  } else {
    const form = await req.formData().catch(() => null)
    recordingUrl = String(form?.get('RecordingUrl') || '')
    duration = parseInt(String(form?.get('RecordingDuration') || '0'))
    providerCallId = String(form?.get('CallSid') || '')
  }
  if (!recordingUrl) return new Response('OK (sem gravação)', { status: 200 })

  const db = admin()

  // Localiza a ligação: pelo id da URL ou pelo id do provedor
  let call: Record<string, unknown> | null = null
  if (callId) {
    const { data } = await db.from('calls').select('*').eq('id', callId).eq('org_id', orgId).maybeSingle()
    call = data
  }
  if (!call && providerCallId) {
    const { data } = await db.from('calls').select('*')
      .eq('org_id', orgId).eq('provider_call_id', providerCallId).maybeSingle()
    call = data
  }
  if (!call) return new Response('Call not found', { status: 200 })

  await db.from('calls').update({
    recording_url: recordingUrl, duration_secs: duration || call.duration_secs, status: 'transcribing',
  }).eq('id', call.id)

  try {
    // Baixa o áudio (Twilio exige basic auth das credenciais da org)
    const { data: integ } = await db.from('integrations')
      .select('config').eq('org_id', orgId).eq('type', 'voip').maybeSingle()
    const cfg = integ?.config as Record<string, string> | undefined
    const audioUrl = recordingUrl.includes('api.twilio.com') && !recordingUrl.endsWith('.mp3')
      ? recordingUrl + '.mp3' : recordingUrl
    const headers: Record<string, string> = {}
    if (cfg?.account_sid && audioUrl.includes('twilio.com')) {
      headers['Authorization'] = 'Basic ' + btoa(`${cfg.account_sid}:${cfg.auth_token}`)
    }
    const audioRes = await fetch(audioUrl, { headers })
    if (!audioRes.ok) throw new Error(`Falha ao baixar gravação (${audioRes.status})`)
    const audioBlob = await audioRes.blob()

    // Transcreve com Whisper
    const openaiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openaiKey) throw new Error('OPENAI_API_KEY não configurada (secrets)')
    const form = new FormData()
    form.append('file', audioBlob, 'call.mp3')
    form.append('model', 'whisper-1')
    form.append('language', 'pt')
    const sttRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    })
    if (!sttRes.ok) throw new Error(`Whisper falhou (${sttRes.status}): ${await sttRes.text()}`)
    const stt = await sttRes.json() as { text: string }

    await db.from('calls').update({
      transcript: stt.text, status: 'transcribed',
    }).eq('id', call.id)

    await db.from('activities').insert({
      org_id: orgId,
      contact_id: call.contact_id, deal_id: call.deal_id, owner_id: call.owner_id,
      type: 'call',
      title: `Ligação transcrita (${Math.round((duration || 0) / 60)}min)`,
      body: stt.text.slice(0, 400),
      meta: { call_id: call.id },
    })
  } catch (e) {
    console.error('Transcrição falhou:', e)
    await db.from('calls').update({ status: 'completed' }).eq('id', call.id)
  }

  return new Response('OK', { status: 200 })
})
