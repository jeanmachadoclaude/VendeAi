// vendeai-advisor - o conselheiro pessoal do CRM
// Persona padrão: Jean Machado. Quando a org configurou um clone
// (settings.advisor_persona === 'clone' + settings.clone), o conselheiro
// fala como a pessoa clonada (ex.: o CEO da empresa contratante).
// Chamado pelo frontend (advisor.js em todas as páginas):
//   sb.functions.invoke('vendeai-advisor', { body: { messages, page } })
// messages: [{ role: 'user' | 'advisor', text }] (histórico do chat)
// page: nome amigável da tela em que o vendedor está agora

import {
  cors, json, requireUser, getKnowledge, askClaude, checkAiQuota, reportError,
  getOrgInfo, cloneFromSettings, clonePersonaStyle,
} from '../_shared/base.ts'

const MAX_MESSAGES = 30
const MAX_TEXT = 4000

const ADVISOR_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'A resposta do conselheiro, em primeira pessoa, pronta para exibir no chat.',
    },
  },
  required: ['reply'],
  additionalProperties: false,
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId, userName } = await requireUser(req)
    await checkAiQuota(orgId)

    const body = await req.json() as { messages?: Array<{ role?: string; text?: string }>; page?: string }
    const history = (body.messages || [])
      .filter(m => m && (m.role === 'user' || m.role === 'advisor') && typeof m.text === 'string' && m.text.trim())
      .slice(-MAX_MESSAGES)
      .map(m => ({ role: m.role as string, text: (m.text as string).slice(0, MAX_TEXT) }))

    if (!history.length || history[history.length - 1].role !== 'user') {
      return json({ error: 'Envie ao menos uma mensagem do vendedor.' }, 400)
    }

    const [knowledge, org] = await Promise.all([getKnowledge(orgId), getOrgInfo(orgId)])
    const clone = org.settings.advisor_persona === 'clone' ? cloneFromSettings(org.settings) : null
    const page = (body.page || '').slice(0, 120)

    const first = clone ? clone.name.split(' ')[0] : 'Jean'

    const personaIntro = clone
      ? `Você é ${clone.name}${clone.cargo ? `, ${clone.cargo}` : ''} da empresa ${org.name}. ` +
        `Você aparece dentro do CRM VendeAI como conselheiro pessoal do time comercial: o vendedor clica no seu avatar ` +
        `e conversa com você para ser aconselhado no momento da ação que está executando ` +
        `(revisando o pipeline, respondendo um lead, planejando o dia). Você conhece a empresa por dentro e fala como líder dela.\n\n` +
        `${clonePersonaStyle(clone)}\n\n`
      : `Você é Jean Machado, fundador da Outpace Growth e criador do CRM VendeAI e da metodologia comercial que ele aplica. ` +
        `Você aparece dentro do CRM como conselheiro pessoal do vendedor: ele clica na sua foto e conversa com você para ser aconselhado ` +
        `no momento da ação que está executando (revisando o pipeline, respondendo um lead, planejando o dia).\n\n`

    const styleLine = clone
      ? `Seu jeito de falar: primeira pessoa, como ${clone.name} de verdade, seguindo o estilo pessoal acima. ` +
        `Direto, prático e próximo, sem formalidade e sem teoria. `
      : `Seu jeito de falar: primeira pessoa, como o próprio Jean. Direto, prático e próximo, sem formalidade e sem teoria. `

    const prompt = [
      `Tela do CRM em que o vendedor está agora: ${page || 'não informada'}.`,
      userName ? `Nome do vendedor: ${userName}.` : '',
      '',
      'Conversa até agora (mais antiga para mais recente):',
      ...history.map(m => `${m.role === 'user' ? 'Vendedor' : first}: ${m.text}`),
      '',
      'Responda à última mensagem do vendedor.',
    ].filter(l => l !== null).join('\n')

    const result = await askClaude({
      system:
        personaIntro +
        `Sua base de conhecimento e metodologia comercial:\n\n${knowledge}\n\n` +
        styleLine +
        `Você não dá aula, você aconselha dentro da operação: diagnostica rápido, dá o próximo passo concreto e cobra execução. ` +
        `Frases curtas. Português do Brasil.\n\n` +
        `Regras:\n` +
        `- Responda como conselheiro, não como robô. Nada de listas enormes: no máximo 3 pontos quando precisar enumerar.\n` +
        `- Se faltar contexto para aconselhar bem, faça 1 pergunta de diagnóstico antes.\n` +
        `- Sempre termine conduzindo para uma ação concreta que o vendedor pode executar agora, de preferência na tela em que ele está.\n` +
        `- Use a metodologia e o playbook da base de conhecimento. Nunca invente preços, prazos ou dados que não estejam na conversa.\n` +
        `- Assunto fora de vendas, gestão comercial ou uso do CRM: redirecione com bom humor de volta ao trabalho.\n` +
        `- Nunca use travessão (—) nos textos. Prefira vírgula, dois-pontos ou ponto final. Sem emojis.\n` +
        `- Respostas curtas, até 120 palavras. Exceção: quando o vendedor pedir um roteiro, script ou texto pronto, aí você entrega completo.`,
      prompt,
      schema: ADVISOR_SCHEMA,
      maxTokens: 1500,
      track: { orgId, functionName: 'vendeai-advisor' },
    })

    return json(result)
  } catch (err) {
    if (err instanceof Response) return err
    console.error('vendeai-advisor:', err)
    await reportError(err, 'vendeai-advisor')
    return json({ error: 'Erro inesperado no conselheiro. Tente novamente.' }, 500)
  }
})
