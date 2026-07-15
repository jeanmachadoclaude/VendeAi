// backup-export - backup lógico redundante semanal ("cinto e suspensório").
//
// Contexto: este projeto já PERDEU um banco inteiro (pausa no free tier +
// restore que só trouxe o schema). Os backups físicos do Supabase (WAL-G,
// diários, retenção ~7 dias, SEM PITR) são a primeira linha; esta function é
// a segunda: exporta as tabelas de negócio como JSON gzipado para um bucket
// PRIVADO ('backups'), fora do alcance de um "drop" acidental do schema.
//
// Agendada por pg_cron (domingo 03:00 UTC) via header x-worker-key - mesmo
// padrão de autenticação do automations-run (secret AUTOMATIONS_WORKER_KEY).
// Também pode ser disparada sob demanda com o mesmo header.
//
// CUIDADOS DE SEGURANÇA:
//   • O bucket 'backups' é privado (sem policy pública): só service role lê.
//   • NENHUM segredo entra no dump: integrations.config é redigido e a chave
//     organizations.settings.export_pass_hash é removida.
//   • Memória controlada: cada tabela é paginada (range) e escrita direto no
//     stream de gzip - nunca materializamos o dump inteiro em memória.

import { admin, cors, json, timingSafeEqual, reportError } from '../_shared/base.ts'

const BUCKET = 'backups'
const PAGE = 1000              // linhas por página (paginação estável por id)
const RETENTION_DAYS = 60      // arquivos mais antigos que isto são apagados

// Ordem de dependência (útil na hora de reimportar respeitando FKs).
// redact: transforma a linha antes de serializar (remove segredos).
type TableSpec = { name: string; redact?: (row: Record<string, unknown>) => Record<string, unknown> }

const TABLES: TableSpec[] = [
  { name: 'organizations', redact: (r) => {
      // Remove o hash da senha de export; preserva o resto de settings.
      const s = { ...((r.settings as Record<string, unknown>) || {}) }
      delete s.export_pass_hash
      return { ...r, settings: s }
    } },
  { name: 'profiles' },
  { name: 'pipelines' },
  { name: 'pipeline_stages' },
  { name: 'products' },
  { name: 'tags' },
  { name: 'custom_field_defs' },
  { name: 'contacts' },
  { name: 'deals' },
  { name: 'activities' },
  { name: 'automations' },
  // config guarda tokens (Evolution, Gmail OAuth, Twilio…): redigido por completo.
  { name: 'integrations', redact: (r) => ({ ...r, config: r.config == null ? r.config : '[REDACTED]' }) },
  { name: 'calendar_events' },
  { name: 'wpp_conversations' },
  { name: 'wpp_messages' },
  { name: 'interacoes' },
  { name: 'analises' },
]

const db = admin()

// Serializa todas as tabelas para um único JSON gzipado, paginando cada
// tabela e escrevendo direto no stream de compressão (memória constante).
// Formato: { meta, data: { tabela: [linhas...] }, counts: { tabela: n } }.
async function buildBackup(): Promise<{ bytes: Uint8Array; counts: Record<string, number> }> {
  const counts: Record<string, number> = {}
  const enc = new TextEncoder()

  const gzip = new CompressionStream('gzip')
  const writer = gzip.writable.getWriter()
  const write = (s: string) => writer.write(enc.encode(s))

  // Consome a saída comprimida em paralelo à escrita.
  const outChunks: Uint8Array[] = []
  const reader = gzip.readable.getReader()
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) outChunks.push(value)
    }
  })()

  const meta = {
    version: 1,
    generated_at: new Date().toISOString(),
    project_ref: 'hniieydykjvjwggshvkf',
    tables: TABLES.map((t) => t.name),
    note: 'Backup lógico VendeAI. Segredos redigidos (integrations.config, organizations.settings.export_pass_hash).',
  }

  await write('{"meta":' + JSON.stringify(meta) + ',"data":{')

  let firstTable = true
  for (const t of TABLES) {
    if (!firstTable) await write(',')
    firstTable = false
    await write(JSON.stringify(t.name) + ':[')

    let offset = 0
    let n = 0
    let firstRow = true
    for (;;) {
      const { data, error } = await db
        .from(t.name)
        .select('*')
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) throw new Error(`${t.name}: ${error.message}`)
      if (!data || data.length === 0) break

      for (const row of data) {
        const clean = t.redact ? t.redact(row as Record<string, unknown>) : row
        await write((firstRow ? '' : ',') + JSON.stringify(clean))
        firstRow = false
        n++
      }
      offset += data.length
      if (data.length < PAGE) break
    }
    counts[t.name] = n
    await write(']')
  }

  await write('},"counts":' + JSON.stringify(counts) + '}')
  await writer.close()
  await drain

  // Concatena os pedaços comprimidos.
  const total = outChunks.reduce((a, c) => a + c.length, 0)
  const bytes = new Uint8Array(total)
  let off = 0
  for (const c of outChunks) { bytes.set(c, off); off += c.length }
  return { bytes, counts }
}

// Apaga backups com mais de RETENTION_DAYS dias (nome = AAAA-MM-DD.json.gz).
async function pruneOld(): Promise<string[]> {
  const { data, error } = await db.storage.from(BUCKET).list('', { limit: 1000 })
  if (error) throw new Error(`list: ${error.message}`)
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000
  const toDelete: string[] = []
  for (const f of data || []) {
    const m = f.name.match(/^(\d{4}-\d{2}-\d{2})\.json\.gz$/)
    if (!m) continue
    if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) toDelete.push(f.name)
  }
  if (toDelete.length) {
    const { error: delErr } = await db.storage.from(BUCKET).remove(toDelete)
    if (delErr) throw new Error(`remove: ${delErr.message}`)
  }
  return toDelete
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Autenticação: apenas worker key (cron ou disparo manual autorizado).
  const workerKey = Deno.env.get('AUTOMATIONS_WORKER_KEY')
  const gotKey = req.headers.get('x-worker-key') || ''
  if (!workerKey || !timingSafeEqual(gotKey, workerKey)) {
    return json({ error: 'Não autorizado' }, 401)
  }

  try {
    const { bytes, counts } = await buildBackup()
    const fileName = new Date().toISOString().slice(0, 10) + '.json.gz'

    const { error: upErr } = await db.storage
      .from(BUCKET)
      .upload(fileName, bytes, { contentType: 'application/gzip', upsert: true })
    if (upErr) throw new Error(`upload: ${upErr.message}`)

    const pruned = await pruneOld()
    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0)
    console.log(`backup-export: ${fileName} (${bytes.length} bytes, ${totalRows} linhas), ${pruned.length} antigos removidos`)

    return json({ ok: true, file: `${BUCKET}/${fileName}`, bytes: bytes.length, counts, pruned })
  } catch (e) {
    console.error(e)
    await reportError(e, 'backup-export')
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
