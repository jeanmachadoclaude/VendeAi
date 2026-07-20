// vendeai-treinamento - a academia de vendas do CRM (página treinamento.html)
// Modos:
//   Roleplay (a IA interpreta um CLIENTE e dá dicas de coach):
//     'objecoes'   - cliente interessado mas cheio de objeções
//     'perfis'     - cliente com perfil DISC (profile: dominante|influente|estavel|conforme)
//     'coldcall'   - ligação fria, cliente impaciente
//     'fechamento' - reta final da negociação, cliente aperta
//   Estudo (Jean sabatina o vendedor):
//     'metodologia' - metodologia Outpace (12 bancos da base de conhecimento)
//     'produtos'    - catálogo e detalhes de produto da org
//   Aconselhamento:
//     'ceo'  - clone configurado em organizations.settings.clone
//     'jean' - persona Jean Machado
//
// Chamada: sb.functions.invoke('vendeai-treinamento', { body: {
//   mode, profile?, evaluate?, messages: [{ role: 'user'|'ai', text }] } })
// Resposta normal: { reply, coach }  (coach: dica curta ou null)
// Com evaluate:true: { evaluation: { nota, resumo, pontos_fortes,
//   pontos_melhorar, proximo_treino } }

import {
  cors, json, requireUser, getKnowledge, askClaude, checkAiQuota, reportError,
  getOrgInfo, cloneFromSettings, clonePersonaStyle,
} from '../_shared/base.ts'

const MAX_MESSAGES = 40
const MAX_TEXT = 4000

const ROLEPLAY_MODES = ['objecoes', 'perfis', 'coldcall', 'fechamento']
const ALL_MODES = [...ROLEPLAY_MODES, 'metodologia', 'produtos', 'ceo', 'jean']
const DISC_PROFILES = ['dominante', 'influente', 'estavel', 'conforme']

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'A fala do personagem (cliente, Jean ou clone), pronta para exibir no chat.' },
    coach: {
      type: ['string', 'null'],
      description: 'Nos roleplays: UMA dica curta de coach sobre a última resposta do vendedor (o que foi bem ou o que melhorar), ou null quando não houver dica relevante. Nos demais modos: sempre null.',
    },
  },
  required: ['reply', 'coach'],
  additionalProperties: false,
}

const EVAL_SCHEMA = {
  type: 'object',
  properties: {
    evaluation: {
      type: 'object',
      properties: {
        nota: { type: 'number', description: 'Nota do desempenho do vendedor de 0 a 10, com até 1 casa decimal.' },
        resumo: { type: 'string', description: 'Resumo direto do desempenho em até 40 palavras, falando com o vendedor (você).' },
        pontos_fortes: { type: 'array', items: { type: 'string' }, description: '2 a 4 pontos fortes concretos, citando momentos da conversa.' },
        pontos_melhorar: { type: 'array', items: { type: 'string' }, description: '2 a 4 pontos a melhorar, cada um com a correção prática.' },
        proximo_treino: { type: 'string', description: 'Sugestão de próximo treino e por quê, em 1 frase.' },
      },
      required: ['nota', 'resumo', 'pontos_fortes', 'pontos_melhorar', 'proximo_treino'],
      additionalProperties: false,
    },
  },
  required: ['evaluation'],
  additionalProperties: false,
}

const DISC_PERSONAS: Record<string, string> = {
  dominante:
    'Perfil DISC do cliente: DOMINANTE. Direto, impaciente, competitivo, quer resultado e controle da conversa. ' +
    'Interrompe enrolação, faz perguntas secas ("quanto custa?", "qual o resultado?"), decide rápido quando enxerga ganho. ' +
    'Punição para o vendedor: se ele enrolar, teorizar ou demonstrar insegurança, o cliente corta e ameaça encerrar.',
  influente:
    'Perfil DISC do cliente: INFLUENTE. Falante, entusiasmado, caloroso, conta histórias, se dispersa do assunto com facilidade. ' +
    'Compra pela relação e pela emoção, adora novidade e reconhecimento, mas esquece detalhes e adia decisão. ' +
    'Punição para o vendedor: se ele não criar conexão ou não retomar o foco com leveza, a conversa vira bate-papo sem fechamento.',
  estavel:
    'Perfil DISC do cliente: ESTÁVEL. Calmo, gentil, avesso a risco e a mudança, decide devagar e evita conflito. ' +
    'Diz "vou pensar", "preciso falar com a equipe", teme se arrepender. Precisa de segurança, garantias e passo a passo. ' +
    'Punição para o vendedor: se ele pressionar ou acelerar demais, o cliente se fecha educadamente e some.',
  conforme:
    'Perfil DISC do cliente: CONFORME (analítico). Cético, técnico, quer dados, provas, comparativos e processo. ' +
    'Detesta exagero e promessa vaga; pergunta detalhes de implementação, contrato, métricas e casos reais. ' +
    'Punição para o vendedor: qualquer afirmação sem embasamento vira desconfiança e mais objeção.',
}

const ROLEPLAY_SCENARIO: Record<string, string> = {
  objecoes:
    'Cenário: o cliente JÁ demonstrou interesse no produto/serviço, mas é um gerador de objeções em série: ' +
    'preço ("está caro"), momento ("agora não"), concorrente ("a outra proposta é mais barata"), autoridade ("preciso falar com meu sócio") e adiamento ("me manda por e-mail, vou pensar"). ' +
    'Traga UMA objeção por vez, de forma natural. Se o vendedor contornar bem uma objeção (validar, explorar, responder com valor e puxar próximo passo), ceda um pouco e traga a próxima. Se ele contornar mal, insista na mesma.',
  perfis:
    'Cenário: reunião comercial em andamento com um cliente potencial interessado no produto/serviço da empresa. ' +
    'Interprete o perfil DISC indicado com intensidade alta e consistente do início ao fim.',
  coldcall:
    'Cenário: LIGAÇÃO FRIA. O cliente atendeu o telefone sem esperar a ligação, está ocupado e impaciente. ' +
    'Comece atendendo a ligação ("Alô?", "Quem fala?"). Dê no máximo 30 segundos de paciência inicial: se o vendedor não gerar curiosidade ou relevância rápido, ameace desligar ("me tira da lista", "não tenho interesse"). ' +
    'Se ele ganhar sua atenção com uma boa abertura (personalização, dor real, pedido pequeno), conceda mais tempo e evolua até aceitar (ou não) um próximo passo.',
  fechamento:
    'Cenário: RETA FINAL da negociação. O cliente já conhece a proposta, gostou, mas agora aperta: pede desconto agressivo, ' +
    'compara com concorrente, pede condições de pagamento, ameaça adiar a assinatura. Teste os limites do vendedor: ' +
    'se ele ceder desconto fácil demais, peça MAIS desconto (quem cede rápido apanha). Se ele defender valor e negociar contrapartidas, caminhe para o fechamento.',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId, userName } = await requireUser(req)
    await checkAiQuota(orgId)

    const body = await req.json() as {
      mode?: string; profile?: string; evaluate?: boolean
      messages?: Array<{ role?: string; text?: string }>
    }

    const mode = String(body.mode || '')
    if (!ALL_MODES.includes(mode)) return json({ error: 'Modo de treino inválido.' }, 400)
    const profile = mode === 'perfis' ? String(body.profile || '') : ''
    if (mode === 'perfis' && !DISC_PROFILES.includes(profile)) {
      return json({ error: 'Escolha um perfil DISC válido.' }, 400)
    }
    const evaluate = body.evaluate === true
    const isRoleplay = ROLEPLAY_MODES.includes(mode)

    const history = (body.messages || [])
      .filter(m => m && (m.role === 'user' || m.role === 'ai') && typeof m.text === 'string' && m.text.trim())
      .slice(-MAX_MESSAGES)
      .map(m => ({ role: m.role as string, text: (m.text as string).slice(0, MAX_TEXT) }))

    // Roleplay pode começar sem histórico (a IA abre a cena); os demais
    // modos e a avaliação precisam de conversa.
    if (!isRoleplay && !history.length) {
      return json({ error: 'Envie ao menos uma mensagem para começar.' }, 400)
    }
    if (evaluate && !history.some(m => m.role === 'user')) {
      return json({ error: 'Converse um pouco antes de pedir a avaliação.' }, 400)
    }

    const [knowledge, org] = await Promise.all([getKnowledge(orgId), getOrgInfo(orgId)])
    const clone = cloneFromSettings(org.settings)

    if (mode === 'ceo' && !clone) {
      return json({ error: 'O clone do CEO ainda não foi criado. Um administrador cria em Configurações, Base de Conhecimento da IA, Criar meu clone.' }, 400)
    }

    const seller = userName || 'o vendedor'
    const aiLabel = isRoleplay ? 'Cliente' : (mode === 'ceo' && clone ? clone.name.split(' ')[0] : 'Jean')

    // ── System prompt por modo ──────────────────────────────────
    let system = ''
    if (isRoleplay) {
      system =
        `Você é o simulador de treinamento do CRM VendeAI. Está conduzindo um ROLEPLAY de vendas com ${seller}, ` +
        `vendedor da empresa ${org.name}. Você interpreta um CLIENTE fictício brasileiro, comprador realista do que a empresa vende.\n\n` +
        `Contexto da empresa do vendedor (produtos, metodologia e playbook):\n\n${knowledge}\n\n` +
        ROLEPLAY_SCENARIO[mode] + '\n\n' +
        (profile ? DISC_PERSONAS[profile] + '\n\n' : '') +
        `Regras do roleplay:\n` +
        `- Invente um nome, empresa e contexto plausíveis para o cliente e mantenha-os consistentes.\n` +
        `- Se a conversa ainda não começou, abra a cena: na primeira linha, entre colchetes, descreva o cenário em 1 frase (ex.: [Você ligou para Marcos, diretor de operações de uma metalúrgica]) e em seguida a primeira fala do cliente.\n` +
        `- Fale SEMPRE em personagem, como numa conversa real: frases curtas, no máximo 80 palavras por resposta, sem listas.\n` +
        `- Seja desafiador na medida: não facilite, mas ceda progressivamente quando o vendedor usar boas técnicas (validar a objeção, explorar a dor, ancorar valor, pedir o próximo passo).\n` +
        `- Nunca saia do personagem no campo "reply". Se o vendedor pedir ajuda fora do personagem, responda a ajuda no campo "coach" e siga o personagem no "reply".\n` +
        `- No campo "coach": no máximo UMA dica curta (até 30 palavras) sobre a última resposta do vendedor, baseada na metodologia da base de conhecimento. Se a resposta foi boa ou não há nada relevante, use null. Não dê dica em toda mensagem.\n` +
        `- Nunca use travessão (—). Português do Brasil.`
    } else if (mode === 'metodologia' || mode === 'produtos') {
      const foco = mode === 'metodologia'
        ? `SABATINA DE METODOLOGIA: treine o vendedor nos conceitos da metodologia comercial da base de conhecimento (dor latente, ICP, Impact Test, PUV, One Minute Pitch, cadência, matriz de objeções, métricas, rituais). Siga a jornada dos 12 bancos ou o tema que o vendedor pedir.`
        : `SABATINA DE PRODUTO: treine o vendedor no catálogo e nos detalhes de produtos/serviços da ${org.name} que estão na base de conhecimento (o que é, para quem, preço, diferenciais, como apresentar). Simule também perguntas que um cliente faria sobre o produto.`
      system =
        `Você é Jean Machado, fundador da Outpace Growth, no modo TREINADOR dentro do CRM VendeAI, treinando ${seller}, vendedor da ${org.name}.\n\n` +
        `Base de conhecimento da empresa:\n\n${knowledge}\n\n` +
        foco + '\n\n' +
        `Método da sabatina:\n` +
        `- UMA pergunta por vez. Espere a resposta do vendedor.\n` +
        `- Quando ele responder: avalie em 1 frase (acertou, faltou, errou), corrija com o conteúdo certo da base e emende a próxima pergunta.\n` +
        `- Aumente a dificuldade gradualmente; cobre resposta como se fosse para um cliente de verdade.\n` +
        `- Se a base de conhecimento não cobrir o tema, diga isso e sugira preencher a Base de Conhecimento em Configurações.\n` +
        `- Seu jeito: primeira pessoa, direto, prático, provocador na medida, frases curtas, até 100 palavras por resposta. Sem emojis. Nunca use travessão (—). Português do Brasil.\n` +
        `- Campo "coach": sempre null neste modo.`
    } else {
      // Aconselhamento: 'jean' ou 'ceo' (clone)
      const personaIntro = mode === 'ceo' && clone
        ? `Você é ${clone.name}${clone.cargo ? `, ${clone.cargo}` : ''} da empresa ${org.name}, na sessão de Aconselhamento do CRM VendeAI, conversando com ${seller}, do seu time comercial. Você conhece a empresa por dentro e aconselha como líder dela: visão de negócio, prioridades, carreira e vendas.\n\n${clonePersonaStyle(clone)}\n\n`
        : `Você é Jean Machado, fundador da Outpace Growth e criador da metodologia comercial do CRM VendeAI, na sessão de Aconselhamento, conversando com ${seller}, vendedor da ${org.name}.\n\n`
      system =
        personaIntro +
        `Base de conhecimento da empresa:\n\n${knowledge}\n\n` +
        `Seu jeito de falar: primeira pessoa, direto, prático e próximo, sem formalidade e sem teoria. Frases curtas. Português do Brasil.\n\n` +
        `Regras:\n` +
        `- Aconselhe como numa conversa de mentoria: diagnostique rápido, dê o próximo passo concreto e cobre execução.\n` +
        `- Se faltar contexto, faça 1 pergunta de diagnóstico antes.\n` +
        `- Use a metodologia e o playbook da base. Nunca invente preços, prazos ou dados que não estejam na conversa.\n` +
        `- Assunto fora de trabalho, vendas ou carreira: redirecione com bom humor.\n` +
        `- Respostas até 120 palavras; roteiros e scripts pedidos podem ser completos.\n` +
        `- Sem emojis. Nunca use travessão (—).\n` +
        `- Campo "coach": sempre null neste modo.`
    }

    // ── Prompt (histórico) ──────────────────────────────────────
    const convo = history.length
      ? ['Conversa até agora (mais antiga para mais recente):',
         ...history.map(m => `${m.role === 'user' ? 'Vendedor' : aiLabel}: ${m.text}`)]
      : ['A conversa ainda não começou.']

    let prompt: string
    let schema: Record<string, unknown>
    if (evaluate) {
      schema = EVAL_SCHEMA
      prompt = [
        ...convo, '',
        `O treino terminou. Agora saia do personagem e avalie o desempenho do VENDEDOR (${seller}) nesta conversa de treino, ` +
        `como um coach de vendas usando a metodologia da base de conhecimento. Seja honesto: nota alta só para desempenho realmente bom. ` +
        `Fale diretamente com o vendedor (você). Nunca use travessão (—).`,
      ].join('\n')
    } else {
      schema = REPLY_SCHEMA
      prompt = [
        ...convo, '',
        history.length
          ? (history[history.length - 1].role === 'user'
              ? 'Responda à última mensagem do vendedor.'
              : 'Continue a conversa com a próxima fala do personagem.')
          : 'Abra a cena do roleplay com a primeira fala do cliente.',
      ].join('\n')
    }

    const result = await askClaude({
      system,
      prompt,
      schema,
      maxTokens: 1800,
      track: { orgId, functionName: 'vendeai-treinamento' },
    })

    return json(result)
  } catch (err) {
    if (err instanceof Response) return err
    console.error('vendeai-treinamento:', err)
    await reportError(err, 'vendeai-treinamento')
    return json({ error: 'Erro inesperado no treinamento. Tente novamente.' }, 500)
  }
})
