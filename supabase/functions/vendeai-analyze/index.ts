// vendeai-analyze — motor do Vende.IA
// Junta todo o histórico do lead (WhatsApp, e-mails, ligações transcritas,
// atividades) e gera análise com a metodologia Outpace Growth via Claude.
// Chamado pelo frontend: sb.functions.invoke('vendeai-analyze', { body: { deal_id } })

import { admin, cors, json, requireUser, getMethodology, askClaude } from '../_shared/base.ts'

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Resumo executivo do estado do negócio em 2-3 frases, em português.' },
    sentiment: {
      type: 'object',
      properties: {
        label: { type: 'string', enum: ['Positivo', 'Neutro', 'Negativo'] },
        score: { type: 'integer', description: 'Temperatura do lead de 0 a 100.' },
      },
      required: ['label', 'score'],
      additionalProperties: false,
    },
    next_steps: {
      type: 'array',
      description: 'Até 3 próximos passos concretos, priorizados.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['title', 'detail'],
        additionalProperties: false,
      },
    },
    objections: {
      type: 'array',
      description: 'Objeções ou riscos detectados nas conversas, com resposta sugerida.',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'A objeção/risco, citando a fala do lead quando houver.' },
          response: { type: 'string', description: 'Como contornar, seguindo a metodologia.' },
        },
        required: ['quote', 'response'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'sentiment', 'next_steps', 'objections'],
  additionalProperties: false,
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { user, orgId } = await requireUser(req)
    const { deal_id } = await req.json() as { deal_id: string }
    if (!deal_id) return json({ error: 'deal_id obrigatório' }, 400)

    const db = admin()

    // Negócio + contato (valida org)
    const { data: deal } = await db.from('deals')
      .select('*, contacts(id, first_name, last_name, email, phone, whatsapp, company, job_title, notes)')
      .eq('id', deal_id).eq('org_id', orgId).single()
    if (!deal) return json({ error: 'Negócio não encontrado' }, 404)
    const contact = deal.contacts

    // Histórico em paralelo
    const [wppConv, emails, calls, activities, stage] = await Promise.all([
      contact?.id
        ? db.from('wpp_conversations').select('id').eq('org_id', orgId).eq('contact_id', contact.id).maybeSingle()
        : Promise.resolve({ data: null }),
      db.from('emails').select('direction, from_email, to_email, subject, snippet, body, sent_at')
        .eq('org_id', orgId).or(`deal_id.eq.${deal_id}${contact?.id ? `,contact_id.eq.${contact.id}` : ''}`)
        .order('sent_at', { ascending: false }).limit(15),
      db.from('calls').select('transcript, duration_secs, started_at, sentiment_label')
        .eq('org_id', orgId).eq('deal_id', deal_id).not('transcript', 'is', null)
        .order('started_at', { ascending: false }).limit(3),
      db.from('activities').select('type, title, body, created_at')
        .eq('org_id', orgId).eq('deal_id', deal_id)
        .order('created_at', { ascending: false }).limit(25),
      db.from('pipeline_stages').select('name').eq('id', deal.stage_id).maybeSingle(),
    ])

    let wppMessages: Array<Record<string, unknown>> = []
    if (wppConv.data?.id) {
      const { data } = await db.from('wpp_messages')
        .select('direction, body, created_at')
        .eq('conversation_id', wppConv.data.id)
        .order('created_at', { ascending: false }).limit(40)
      wppMessages = (data || []).reverse()
    }

    const methodology = await getMethodology(orgId)

    // Monta o dossiê do lead
    const fmtDate = (d: string) => new Date(d).toLocaleString('pt-BR')
    const parts: string[] = []
    parts.push(`## Negócio\nTítulo: ${deal.title}\nValor: R$ ${deal.value ?? 0}\nEtapa atual: ${stage.data?.name || '—'}\nStatus: ${deal.status}\nProbabilidade: ${deal.probability ?? 0}%${deal.notes ? `\nNotas: ${deal.notes}` : ''}`)
    if (contact) {
      parts.push(`## Contato\n${contact.first_name || ''} ${contact.last_name || ''} · ${contact.job_title || ''} · ${contact.company || ''}${contact.notes ? `\nObservações: ${contact.notes}` : ''}`)
    }
    if (wppMessages.length) {
      parts.push('## Conversa de WhatsApp (mais antiga → mais recente)\n' + wppMessages
        .map(m => `${m.direction === 'outbound' ? 'Vendedor' : 'Lead'}: ${m.body}`).join('\n'))
    }
    if (emails.data?.length) {
      parts.push('## E-mails\n' + emails.data.map(e =>
        `[${fmtDate(e.sent_at)}] ${e.direction === 'outbound' ? 'Enviado' : 'Recebido'} — ${e.subject || '(sem assunto)'}\n${(e.body || e.snippet || '').slice(0, 800)}`
      ).join('\n---\n'))
    }
    if (calls.data?.length) {
      parts.push('## Transcrições de ligações\n' + calls.data.map(c =>
        `[${fmtDate(c.started_at)} · ${Math.round((c.duration_secs || 0) / 60)}min]\n${(c.transcript || '').slice(0, 4000)}`
      ).join('\n---\n'))
    }
    if (activities.data?.length) {
      parts.push('## Atividades registradas no CRM\n' + activities.data.map(a =>
        `[${fmtDate(a.created_at)}] ${a.type}: ${a.title || ''} ${a.body || ''}`.trim()
      ).join('\n'))
    }

    const analysis = await askClaude({
      system: `Você é o Vende.IA, assistente comercial do CRM VendeAI da Outpace Growth. ` +
        `Analise o dossiê do lead e produza uma análise acionável em português brasileiro, ` +
        `seguindo rigorosamente esta metodologia de vendas:\n\n${methodology}\n\n` +
        `Seja específico: cite falas reais do lead nas objeções, proponha passos com prazo/canal. ` +
        `Se houver pouco histórico, diga isso no resumo e sugira como gerar mais sinal.`,
      prompt: parts.join('\n\n'),
      schema: ANALYSIS_SCHEMA,
    })

    // Persiste a análise
    const { data: saved } = await db.from('ai_analyses').insert({
      org_id: orgId,
      deal_id,
      contact_id: contact?.id || null,
      kind: 'deal_analysis',
      content: analysis,
      model: Deno.env.get('VENDEAI_MODEL') || 'claude-opus-4-8',
      created_by: user.id,
    }).select('id, created_at').single()

    // Grava a temperatura na ligação mais recente sem sentimento (se houver)
    const sent = analysis.sentiment as { label: string; score: number } | undefined
    if (sent && calls.data?.length) {
      await db.from('calls').update({ sentiment_label: sent.label, sentiment_score: sent.score })
        .eq('org_id', orgId).eq('deal_id', deal_id).is('sentiment_label', null)
    }

    await db.from('activities').insert({
      org_id: orgId, deal_id, contact_id: contact?.id || null,
      type: 'auto', title: 'Vende.IA analisou o negócio',
      body: (analysis.summary as string || '').slice(0, 500),
      owner_id: user.id, meta: { analysis_id: saved?.id },
    })

    return json({ ok: true, analysis, analysis_id: saved?.id, created_at: saved?.created_at })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    return json({ error: String(e?.message || e) }, 500)
  }
})
