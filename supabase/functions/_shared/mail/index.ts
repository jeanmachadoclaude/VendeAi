// Roteador de provedor de e-mail (FASE 5).
// getMailProvider(orgId) lê a integração da org e devolve a implementação certa.
// Hoje só Gmail; Microsoft/Graph entra na Fase 6 (basta um `else if` aqui).

import { admin, json } from '../base.ts'
import { createGmailProvider } from './gmail.ts'
import type { MailProvider } from './types.ts'

export type { MailProvider, MailAction, MailFolder, NormalizedMessage } from './types.ts'

export async function getMailProvider(orgId: string): Promise<MailProvider> {
  const { data } = await admin().from('integrations')
    .select('type')
    .eq('org_id', orgId)
    .in('type', ['gmail', 'microsoft'])
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  // Sem integração ativa: cai no Gmail, cujo getGmailConfig lança o
  // erro amigável 'not_connected' (mantém o comportamento anterior).
  const type = data?.type || 'gmail'

  if (type === 'gmail') return await createGmailProvider(orgId)
  // if (type === 'microsoft') return await createMicrosoftProvider(orgId) // Fase 6

  throw json({ error: `Provedor de e-mail não suportado: ${type}` }, 400)
}

// Lista as orgs com e-mail conectado (usado pelo cron do email-sync).
export async function orgsWithMail(): Promise<string[]> {
  const { data } = await admin().from('integrations')
    .select('org_id')
    .in('type', ['gmail', 'microsoft'])
    .eq('is_active', true)
  return [...new Set((data || []).map(i => i.org_id as string))]
}
