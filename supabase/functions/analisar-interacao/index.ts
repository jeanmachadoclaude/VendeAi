// analisar-interacao — Inteligência Ativa do VendeAI
// Analisa uma interação (call/e-mail/mensagem) contra o framework
// A.C.O.R.D.O. e gera até 3 tarefas sugeridas com justificativa.
// Frontend: sb.functions.invoke('analisar-interacao', { body: { interacao_id } })
// Modelo: VENDEAI_ANALISE_MODEL (default claude-sonnet-5 — análise
// estruturada de alto volume; o Vende.IA geral segue no Opus).

import { admin, cors, json, requireUser, askClaude, checkAiQuota, reportError, getKnowledge } from '../_shared/base.ts'

const MODELO = Deno.env.get('VENDEAI_ANALISE_MODEL') || 'claude-sonnet-5'
const MAX_CONTEUDO = 60_000 // ~caracteres de transcrição enviados à IA

const SYSTEM = `Você é um analista comercial sênior especializado em vendas B2B consultivas.
Analise a interação comercial fornecida usando o framework A.C.O.R.D.O.:

A - Acesso: estamos falando com o decisor? Ele foi identificado/envolvido?
C - Clareza da Dor: a dor do cliente foi explicitada e quantificada?
O - Orçamento: a verba foi validada? Há budget definido?
R - ROI: o retorno foi demonstrado e conectado à dor?
D - Decisão: o processo e o prazo de decisão estão mapeados?
O - Próximo Passo: há próximo passo concreto agendado com data?

Dê uma nota de 0 a 10 para cada dimensão considerando TODO o contexto do
negócio, e identifique a letra_travada: a dimensão mais crítica que impede
o avanço do negócio agora.

Regras para as tarefas sugeridas (máximo 3, ordenadas da mais para a menos prioritária):
1. Todo compromisso assumido na interação ("te mando a proposta até sexta")
   vira tarefa com o prazo citado.
2. A letra travada gera uma tarefa concreta para destravá-la (ex.: Orçamento
   não validado → ligação para validar verba com quem decide).
3. Se não houver próximo passo agendado, gere SEMPRE uma tarefa de follow-up
   com prazo máximo de 3 dias úteis.
4. Título curto e acionável ("Ligar para validar orçamento com o Danilo").
5. A justificativa cita o trecho ou fato da interação que motivou a tarefa —
   é o que faz o vendedor confiar na sugestão em vez de ignorá-la.
6. prazo_dias conta a partir da data da interação.

Escreva tudo em português brasileiro.`

const SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: {
        acesso: { type: 'integer' },
        clareza_dor: { type: 'integer' },
        orcamento: { type: 'integer' },
        roi: { type: 'integer' },
        decisao: { type: 'integer' },
        proximo_passo: { type: 'integer' },
      },
      required: ['acesso', 'clareza_dor', 'orcamento', 'roi', 'decisao', 'proximo_passo'],
      additionalProperties: false,
    },
    letra_travada: {
      type: 'string',
      enum: ['acesso', 'clareza_dor', 'orcamento', 'roi', 'decisao', 'proximo_passo'],
      description: 'A dimensão mais crítica que trava o avanço do negócio.',
    },
    resumo: { type: 'string', description: 'Resumo da interação em 3-5 linhas.' },
    compromissos: {
      type: 'array',
      description: 'O que ficou combinado na interação.',
      items: {
        type: 'object',
        properties: {
          quem: { type: 'string' },
          o_que: { type: 'string' },
          quando: { type: 'string' },
        },
        required: ['quem', 'o_que', 'quando'],
        additionalProperties: false,
      },
    },
    oportunidades_perdidas: {
      type: 'array',
      description: 'O que o vendedor deixou de fazer ou perguntar.',
      items: { type: 'string' },
    },
    sinais_risco: {
      type: 'array',
      description: 'Objeções, esfriamento, concorrente citado.',
      items: { type: 'string' },
    },
    tarefas_sugeridas: {
      type: 'array',
      description: 'Máximo 3 tarefas, da mais para a menos prioritária.',
      items: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['ligacao', 'email', 'orcamento', 'proposta', 'reuniao', 'whatsapp'] },
          titulo: { type: 'string', description: 'Curto e acionável.' },
          justificativa: { type: 'string', description: 'Trecho ou fato da interação que motivou a tarefa.' },
          prazo_dias: { type: 'integer', description: '1 a 7, contando da data da interação.' },
          prioridade: { type: 'string', enum: ['alta', 'media', 'baixa'] },
        },
        required: ['tipo', 'titulo', 'justificativa', 'prazo_dias', 'prioridade'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores', 'letra_travada', 'resumo', 'compromissos', 'oportunidades_perdidas', 'sinais_risco', 'tarefas_sugeridas'],
  additionalProperties: false,
}

const TIPO_LABEL: Record<string, string> = { call: 'Ligação (transcrição)', email: 'E-mail', mensagem: 'Mensagem (WhatsApp)' }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId } = await requireUser(req)
    await checkAiQuota(orgId)
    const { interacao_id } = await req.json() as { interacao_id: string }
    if (!interacao_id) return json({ error: 'interacao_id obrigatório' }, 400)

    const db = admin()
    const { data: inter } = await db.from('interacoes').select('*')
      .eq('id', interacao_id).eq('org_id', orgId).maybeSingle()
    if (!inter) return json({ error: 'Interação não encontrada' }, 404)

    // Contexto do negócio para ancorar a análise
    const { data: deal } = await db.from('deals')
      .select('id, title, value, expected_close, status, stage_id, contact_id, contacts(first_name, last_name, job_title, company)')
      .eq('id', inter.deal_id).maybeSingle()
    let etapa = ''
    if (deal?.stage_id) {
      const { data: st } = await db.from('pipeline_stages').select('name').eq('id', deal.stage_id).maybeSingle()
      etapa = st?.name || ''
    }
    const c = (deal?.contacts || {}) as Record<string, string>
    const dataInt = new Date(inter.data_interacao)

    const prompt = `CONTEXTO DO NEGÓCIO:
- Negócio: ${deal?.title || '—'} | Valor: R$ ${Number(deal?.value || 0).toLocaleString('pt-BR')} | Etapa atual: ${etapa || '—'}
- Contato: ${[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}${c.job_title ? ` (${c.job_title})` : ''}${c.company ? ` — ${c.company}` : ''}
- Data prevista de fechamento: ${deal?.expected_close || 'não definida'}

INTERAÇÃO A ANALISAR:
- Tipo: ${TIPO_LABEL[inter.tipo] || inter.tipo}
- Data da interação (referência para prazos): ${dataInt.toLocaleDateString('pt-BR')}

CONTEÚDO:
${String(inter.conteudo).slice(0, MAX_CONTEUDO)}`

    // Mescla o framework A.C.O.R.D.O. com a Base de Conhecimento da org
    // (linguagem, produtos, metodologia e os 12 bancos do playbook).
    const kb = await getKnowledge(orgId)
    const out = await askClaude({ system: `${SYSTEM}\n\n${kb}`, prompt, schema: SCHEMA, maxTokens: 8192, model: MODELO, track: { orgId, functionName: 'analisar-interacao' } })

    // Pós-processamento: máx 3 tarefas, prazo_data absoluto, status inicial
    const tarefas = ((out.tarefas_sugeridas as Array<Record<string, unknown>>) || [])
      .slice(0, 3)
      .map(t => {
        const dias = Math.min(7, Math.max(1, Number(t.prazo_dias) || 3))
        const prazo = new Date(dataInt.getTime() + dias * 86_400_000)
        return { ...t, prazo_dias: dias, prazo_data: prazo.toISOString(), status: 'sugerida' }
      })

    const { data: analise, error: insErr } = await db.from('analises').insert({
      org_id: orgId,
      interacao_id: inter.id,
      deal_id: inter.deal_id,
      scores: out.scores,
      letra_travada: out.letra_travada,
      resumo: out.resumo,
      compromissos: out.compromissos,
      oportunidades_perdidas: out.oportunidades_perdidas,
      sinais_risco: out.sinais_risco,
      tarefas_sugeridas: tarefas,
      modelo: MODELO,
    }).select().single()
    if (insErr) throw new Error(insErr.message)

    await db.from('interacoes').update({ analisada: true, analise_id: analise.id }).eq('id', inter.id)

    await db.from('activities').insert({
      org_id: orgId, deal_id: inter.deal_id, contact_id: inter.contact_id || deal?.contact_id || null,
      type: 'auto', title: `🤖 Análise A.C.O.R.D.O.: travado em ${String(out.letra_travada).replace('_', ' ')} — ${tarefas.length} tarefa(s) sugerida(s)`,
      body: String(out.resumo).slice(0, 300),
      meta: { analise_id: analise.id, origem: 'ia' },
    })

    return json({ ok: true, analise })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'analisar-interacao')
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
