// call-dial - click-to-call: liga primeiro para o vendedor, depois conecta o lead.
// A ligação é gravada e a gravação cai no call-webhook para transcrição.
// Credenciais: conta própria da org em integrations (type='voip').config
//   { provider, account_sid, auth_token, from_number, agent_number }
// OU conta central do VendeAI via secrets:
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER
// O telefone do vendedor vem de agent_number (modo avançado) ou profiles.phone do usuário logado.
// Frontend: sb.functions.invoke('call-dial', { body: { phone, contact_id?, deal_id? } })

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'

// Normaliza para E.164 (assume Brasil quando não vier o +código do país)
const e164 = (n: string) =>
  n.replace(/[^\d+]/g, '').startsWith('+') ? n.replace(/[^\d+]/g, '') : '+55' + n.replace(/\D/g, '')

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
    const own = integ?.config as Record<string, string> | undefined

    // Conta própria da org (modo avançado) ou conta central do VendeAI (secrets)
    let cfg: { provider: string; account_sid: string; auth_token: string; from_number: string; agent_number: string }
    if (own?.account_sid && own?.auth_token && own?.from_number) {
      cfg = {
        provider: own.provider || 'twilio',
        account_sid: own.account_sid, auth_token: own.auth_token,
        from_number: own.from_number, agent_number: own.agent_number || '',
      }
    } else {
      const sid = Deno.env.get('TWILIO_ACCOUNT_SID') || ''
      const token = Deno.env.get('TWILIO_AUTH_TOKEN') || ''
      const from = Deno.env.get('TWILIO_FROM_NUMBER') || ''
      if (!sid || !token || !from) {
        return json({
          error: 'Telefonia indisponível: o discador ainda não foi ativado. ' +
            'Administrador: configure os secrets TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN e TWILIO_FROM_NUMBER no Supabase ' +
            '(ou use as configurações avançadas com uma conta própria).',
          code: 'no_provider',
        }, 424)
      }
      cfg = { provider: 'twilio', account_sid: sid, auth_token: token, from_number: from, agent_number: '' }
    }

    // Telefone do vendedor: agent_number da config ou profiles.phone do usuário logado
    if (!cfg.agent_number) {
      const { data: prof } = await db.from('profiles').select('phone').eq('id', user.id).single()
      cfg.agent_number = prof?.phone ? e164(prof.phone) : ''
    }
    if (!cfg.agent_number) {
      return json({
        error: 'Cadastre seu telefone primeiro: Configurações → Integrações → Telefonia → "Salvar meu telefone".',
        code: 'no_agent_phone',
      }, 400)
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

    const leadNumber = e164(phone)

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
    await reportError(e, 'call-dial')
    return json({ error: String(e?.message || e) }, 500)
  }
})
