// Helper Evolution API - resolve a configuração do WhatsApp de uma org.
// Ordem: (1) config própria da org em integrations (modo avançado),
//        (2) servidor central do VendeAI via secrets:
//            supabase secrets set EVOLUTION_URL=https://... EVOLUTION_API_KEY=...
//        Nesse modo cada org usa a instância "org_<8 primeiros chars do org_id>".
import { admin, json } from './base.ts'

export interface EvolutionCfg {
  apiUrl: string
  apiKey: string
  instanceName: string
  managed: boolean // true = servidor central do VendeAI
  integrationId: string | null
}

export async function getEvolution(orgId: string): Promise<EvolutionCfg> {
  const { data } = await admin().from('integrations')
    .select('id, config').eq('org_id', orgId).eq('type', 'whatsapp_evolution').maybeSingle()
  const cfg = data?.config as Record<string, string> | undefined

  // Modo avançado: org com servidor próprio
  if (cfg?.api_url && cfg?.api_key) {
    return {
      apiUrl: cfg.api_url.replace(/\/+$/, ''),
      apiKey: cfg.api_key,
      instanceName: cfg.instance_name || 'vendeai',
      managed: false,
      integrationId: data!.id,
    }
  }

  // Modo gerenciado: servidor central (secrets)
  const envUrl = Deno.env.get('EVOLUTION_URL')
  const envKey = Deno.env.get('EVOLUTION_API_KEY')
  if (envUrl && envKey) {
    return {
      apiUrl: envUrl.replace(/\/+$/, ''),
      apiKey: envKey,
      instanceName: cfg?.instance_name || `org_${orgId.replace(/-/g, '').slice(0, 12)}`,
      managed: true,
      integrationId: data?.id ?? null,
    }
  }

  throw json({
    error: 'WhatsApp indisponível: o servidor de mensagens ainda não foi ativado. ' +
      'Administrador: configure os secrets EVOLUTION_URL e EVOLUTION_API_KEY no Supabase ' +
      '(ou use as configurações avançadas com um servidor próprio).',
    code: 'no_server',
  }, 424)
}

export function evoHeaders(cfg: EvolutionCfg): Record<string, string> {
  return { 'Content-Type': 'application/json', apikey: cfg.apiKey }
}

// Estado da conexão: 'open' = conectado
export async function evoState(cfg: EvolutionCfg): Promise<string | null> {
  const res = await fetch(`${cfg.apiUrl}/instance/connectionState/${cfg.instanceName}`, {
    headers: evoHeaders(cfg),
  })
  if (!res.ok) return null // instância não existe ainda
  const data = await res.json() as Record<string, unknown>
  const inst = data.instance as Record<string, unknown> | undefined
  return String(inst?.state ?? data.state ?? 'close')
}

// Cria a instância (idempotente) já com webhook apontando para o CRM
export async function evoEnsureInstance(cfg: EvolutionCfg, webhookUrl: string): Promise<string | null> {
  // Tenta criar (se já existir, a Evolution retorna erro que ignoramos)
  const createRes = await fetch(`${cfg.apiUrl}/instance/create`, {
    method: 'POST',
    headers: evoHeaders(cfg),
    body: JSON.stringify({
      instanceName: cfg.instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  })
  let qr: string | null = null
  if (createRes.ok) {
    const created = await createRes.json() as Record<string, unknown>
    const qrObj = created.qrcode as Record<string, unknown> | undefined
    qr = (qrObj?.base64 as string) ?? null
  }

  // Configura o webhook (tenta o formato v2 e cai para o v1)
  const eventos = ['MESSAGES_UPSERT']
  const v2 = await fetch(`${cfg.apiUrl}/webhook/set/${cfg.instanceName}`, {
    method: 'POST', headers: evoHeaders(cfg),
    body: JSON.stringify({ webhook: { enabled: true, url: webhookUrl, events: eventos, byEvents: false } }),
  })
  if (!v2.ok) {
    await fetch(`${cfg.apiUrl}/webhook/set/${cfg.instanceName}`, {
      method: 'POST', headers: evoHeaders(cfg),
      body: JSON.stringify({ enabled: true, url: webhookUrl, events: eventos }),
    }).catch(() => {})
  }
  return qr
}

// Busca QR de pareamento de uma instância existente (v2 e v1)
export async function evoQr(cfg: EvolutionCfg): Promise<string | null> {
  const v2 = await fetch(`${cfg.apiUrl}/instance/connect/${cfg.instanceName}`, { headers: evoHeaders(cfg) })
  if (v2.ok) {
    const data = await v2.json() as Record<string, unknown>
    if (data.base64) return data.base64 as string
  }
  const v1 = await fetch(`${cfg.apiUrl}/instance/qrcode/${cfg.instanceName}?image=true`, { headers: evoHeaders(cfg) })
  if (v1.ok) {
    const data = await v1.json() as Record<string, unknown>
    if (data.base64) return data.base64 as string
  }
  return null
}
