// Abstração de provedor de e-mail (FASE 5)
// Uma interface comum para Gmail (hoje) e Microsoft/Graph (Fase 6). As Edge
// Functions email-sync/email-send/email-modify falam SÓ com esta interface via
// o roteador getMailProvider(orgId); toda a lógica específica de API fica na
// implementação de cada provedor. O modelo de dados (tabela emails) e as telas
// não mudam entre provedores.

export type MailFolder = 'inbox' | 'sent' | 'spam' | 'trash' | 'archive'
export type MailAction = 'trash' | 'untrash' | 'inbox' | 'archive' | 'spam' | 'read' | 'unread'

// Uma mensagem já normalizada para o modelo comum do CRM (colunas de `emails`).
export interface NormalizedMessage {
  messageId: string
  threadId: string
  fromEmail: string
  toEmail: string
  subject: string
  snippet: string
  body: string
  folder: MailFolder
  isRead: boolean
  labels: string[]
  direction: 'inbound' | 'outbound'
  sentAt: string // ISO
}

// Contrato que todo provedor de e-mail implementa.
export interface MailProvider {
  readonly type: 'gmail' | 'microsoft'
  readonly selfEmail: string     // e-mail da conta conectada (from_email)
  readonly integrationId: string // linha em `integrations`
  readonly lastSync: string | null

  // Lista os ids das mensagens desde `sinceMs` (null = janela padrão do provedor),
  // incluindo spam/lixo. `max` limita o lote.
  listMessageIds(sinceMs: number | null, max: number): Promise<Array<{ id: string; threadId: string }>>

  // Busca 1 mensagem já normalizada (corpo completo). null se não achou.
  getMessage(id: string): Promise<NormalizedMessage | null>

  // Move/marca no provedor. Devolve o patch a aplicar em `emails`
  // (ex.: { folder: 'trash' } ou { is_read: true }). Lança Response 403
  // (code 'scope_insufficient') quando falta permissão de escrita.
  modify(messageId: string, action: MailAction): Promise<Record<string, unknown>>

  // Envia um e-mail. Devolve os ids do provedor.
  send(msg: { to: string; subject: string; body: string }): Promise<{ messageId: string; threadId: string }>

  // Marca a integração como sincronizada agora (is_active + last_sync).
  markSynced(): Promise<void>
}
