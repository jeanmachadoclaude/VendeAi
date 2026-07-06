// call-dial — click-to-call: liga primeiro para o vendedor, depois conecta o lead.
// A ligação é gravada e a gravação cai no call-webhook para transcrição.
// Config em integrations (type='voip').config:
//   { provider: 'twilio', account_sid, auth_token, from_number, agent_number }
// Frontend: sb.functions.invoke('call-dial', { body: { phone, contact_id?, deal_id? } })

import { admin, cors, json, requireUser } from '../_shared/base.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { user, orgId } = await requireUser(req)
    const { phone, contact_id, deal_id } = await req.json()
    if (!phone) return json({ error: 'phone obrigatório' }, 400)

    const db = admin()
    const { data: integ } = await db.from('integrations')
      .select('config').eq('org_id', orgId).eq('type', 'voip').maybeSingle()
    const cfg = integ?.config as Record<string, string> | undefined
    if (!cfg?.account_sid || !cfg?.auth_token || !cfg?.from_number || !cfg?.agent_number) {
      return json({ error: 'Telefonia não configurada. Conecte o VoIP em Configurações → Integrações.' }, 400)
    }

    // Cria o registro da ligação antes de discar
    const { data: call } = await db.from('calls').insert({
      org_id: orgId,
      contact_id: contact_id || null,
      deal_id: deal_id || null,
      owner_id: user.id,
      phone,
      direction: 'outbound',
      status: 'dialing',
      provider: cfg.provider || 'twilio',
    }).select('id').single()

    const leadNumber = phone.replace(/[^\d+]/g, '').startsWith('+')
      ? phone.replace(/[^\d+]/g, '')
      : '+55' + phone.replace(/\D/g, '')

    const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/call-webhook?org=${orgId}&call=${call!.id}`
    const twiml = `<Response><Dial record="record-from-answer-dual" recordingStatusCallback="${webhookUrl}" callerId="${cfg.from_number}">${leadNumber}</Dial></Response>`

    // Twilio: liga para o vendedor; quando ele atende, disca o lead (gravando)
    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.account_sid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(`${cfg.account_sid}:${cfg.auth_token}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: cfg.agent_number,
          From: cfg.from_number,
          Twiml: twiml,
        }),
      },
    )
    if (!twilioRes.ok) {
      const errText = await twilioRes.text()
      console.error('Twilio error:', errText)
      await db.from('calls').update({ status: 'failed' }).eq('id', call!.id)
      return json({ error: 'O provedor de telefonia recusou a ligação. Verifique as credenciais e os números.' }, 502)
    }
    const twilioData = await twilioRes.json() as { sid: string }

    await db.from('calls').update({
      provider_call_id: twilioData.sid, status: 'in_progress',
    }).eq('id', call!.id)

    await db.from('activities').insert({
      org_id: orgId, contact_id: contact_id || null, deal_id: deal_id || null,
      type: 'call', title: `Ligação iniciada para ${phone}`,
      owner_id: user.id, meta: { call_id: call!.id },
    })

    return json({ ok: true, call_id: call!.id })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    return json({ error: String(e?.message || e) }, 500)
  }
})
