// wpp-suggest — sugestões de resposta em tempo real para o WhatsApp
// Chamado pelo frontend: sb.functions.invoke('wpp-suggest', { body: { conversation_id } })

import { admin, cors, json, requireUser, getMethodology, askClaude, checkAiQuota, reportError } from '../_shared/base.ts'

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      description: 'De 1 a 3 respostas prontas para enviar, da mais recomendada para a menos.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'A mensagem pronta, no tom certo para WhatsApp (curta, natural, sem formalidade excessiva).' },
          rationale: { type: 'string', description: 'Por que esta resposta, em uma frase.' },
        },
        required: ['text', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId } = await requireUser(req)
    await checkAiQuota(orgId)
    const { conversation_id } = await req.json() as { conversation_id: string }
    if (!conversation_id) return json({ error: 'conversation_id obrigatório' }, 400)

    const db = admin()

    const { data: conv } = await db.from('wpp_conversations')
      .select('id, phone, contact_id, contacts(first_name, last_name, company, job_title)')
      .eq('id', conversation_id).eq('org_id', orgId).single()
    if (!conv) return json({ error: 'Conversa não encontrada' }, 404)

    const [{ data: msgs }, dealRes, methodology] = await Promise.all([
      db.from('wpp_messages').select('direction, body, created_at')
        .eq('conversation_id', conversation_id)
        .order('created_at', { ascending: false }).limit(30),
      conv.contact_id
        ? admin().from('deals').select('title, value, status, probability, pipeline_stages(name)')
            .eq('org_id', orgId).eq('contact_id', conv.contact_id).eq('status', 'open')
            .order('created_at', { ascending: false }).limit(1).maybeSingle()
        : Promise.resolve({ data: null }),
      getMethodology(orgId),
    ])

    const history = (msgs || []).reverse()
    if (!history.length) return json({ error: 'Conversa sem mensagens ainda.' }, 400)

    const contact = conv.contacts as Record<string, string> | null
    const deal = dealRes.data as Record<string, unknown> | null

    const context = [
      contact ? `Lead: ${contact.first_name || ''} ${contact.last_name || ''} · ${contact.job_title || ''} · ${contact.company || ''}` : `Lead: ${conv.phone}`,
      deal ? `Negócio aberto: ${deal.title} · R$ ${deal.value} · etapa ${(deal.pipeline_stages as Record<string, string>)?.name || '—'} · probabilidade ${deal.probability}%` : 'Sem negócio aberto no pipeline ainda.',
      '',
      'Conversa (mais antiga → mais recente):',
      ...history.map(m => `${m.direction === 'outbound' ? 'Vendedor' : 'Lead'}: ${m.body}`),
    ].join('\n')

    const result = await askClaude({
      system: `Você é o Vende.IA, copiloto de vendas no WhatsApp do CRM VendeAI. ` +
        `Sua tarefa: sugerir a próxima mensagem que o vendedor deve enviar, ` +
        `seguindo esta metodologia comercial:\n\n${methodology}\n\n` +
        `Regras: responda no idioma da conversa; tom natural de WhatsApp brasileiro (frases curtas, no máximo 1 emoji); ` +
        `sempre conduza para o próximo passo; se o lead fez pergunta, responda-a antes de avançar; ` +
        `nunca invente preços, prazos ou fatos que não estejam na conversa.`,
      prompt: context,
      schema: SUGGEST_SCHEMA,
      maxTokens: 2048,
      track: { orgId, functionName: 'wpp-suggest' },
    })

    // Guarda a sugestão para histórico/telemetria (não bloqueia a resposta)
    db.from('ai_analyses').insert({
      org_id: orgId,
      contact_id: conv.contact_id,
      deal_id: null,
      kind: 'wpp_suggestion',
      content: result,
      model: Deno.env.get('VENDEAI_MODEL') || 'claude-opus-4-8',
    }).then(() => {})

    return json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'wpp-suggest')
    return json({ error: String(e?.message || e) }, 500)
  }
})
