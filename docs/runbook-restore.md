# Runbook — Restauração e Disaster Recovery (VendeAI)

> **Por que este documento existe:** este projeto já perdeu um banco inteiro
> (pausa no free tier + restore que só trouxe o schema). Backup deixou de ser
> teoria. Hoje temos **duas** camadas independentes — leia qual usar antes de
> mexer em qualquer coisa em pânico.

## Panorama das camadas de backup

| Camada | O que é | Frequência | Retenção | Cobre |
|---|---|---|---|---|
| **1. Físico (Supabase/WAL-G)** | Backup nativo do plano Pro | Diário (~07:10 UTC) | ~7 dias | Banco inteiro (schema + dados + auth) |
| **2. Lógico (backup-export)** | JSON gzipado no bucket privado `backups` | Semanal (domingo 03:00 UTC) | 60 dias | Só tabelas de negócio (sem segredos) |
| **PITR** | Point-in-time recovery | **DESATIVADO** | — | — (ver ações manuais) |
| **Evolution (Railway)** | Postgres do WhatsApp, fora do Supabase | Ação manual do Jean | — | Sessões/mensagens WhatsApp |

Estado conferido em 12/jul/2026 via Management API: `pitr_enabled=false`,
`walg_enabled=true`, backups físicos diários COMPLETED, retenção ~7 dias.

---

## Cenário A — Restore nativo do Supabase (primeira opção, quase sempre)

Use quando: corrupção, exclusão em massa, migration ruim, ou qualquer perda de
dados nos **últimos ~7 dias**. Traz o banco INTEIRO de volta (inclusive
`auth.users`, o que o backup lógico **não** faz).

1. Acesse o **Supabase Dashboard** → projeto **VendeAi**
   (`hniieydykjvjwggshvkf`).
2. Menu lateral: **Database → Backups**
   (URL direta: `https://supabase.com/dashboard/project/hniieydykjvjwggshvkf/database/backups`).
3. Escolha o backup diário desejado (lista mostra data/hora UTC) e clique em
   **Restore**. Confirme. O projeto fica indisponível por alguns minutos
   enquanto restaura.
4. Se o PITR estivesse ativo, a aba **Point in Time** permitiria escolher um
   instante exato (não só o snapshot diário). **Hoje está desativado** — só há
   os snapshots diários. Ativar PITR é ação manual (ver fim do documento).
5. Após o restore, siga o **Checklist pós-restore** no fim deste arquivo.

> ⚠️ Restore é **destrutivo**: substitui o estado atual do banco. Se há dados
> novos desde o backup, eles se perdem. Em dúvida, exporte o estado atual antes
> (rode a function `backup-export` manualmente — ver Cenário B, passo "disparo
> manual").

---

## Cenário B — Reimportar o JSON do Storage (último caso / restauração parcial)

Use quando: o restore nativo não é suficiente (dado mais antigo que 7 dias,
snapshot físico corrompido) **ou** você só precisa recuperar **algumas
linhas/tabelas** sem reverter o banco todo.

Limitações: o dump lógico **não** contém `auth.users`, senhas, nem os segredos
redigidos (`integrations.config`, `organizations.settings.export_pass_hash`).
Depois de reimportar, reconfigure integrações e senha de export manualmente.

### B.1 — Baixar o backup

O bucket `backups` é **privado**: só a `service_role` key lê. Nunca há link
público.

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...            # Management API token
REF=hniieydykjvjwggshvkf

# 1) Pegar a service_role key
SRK=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$REF/api-keys?reveal=true" \
  | python3 -c "import sys,json;print(next(k['api_key'] for k in json.load(sys.stdin) if k['name']=='service_role'))")

# 2) Listar os backups disponíveis (opcional)
curl -s -H "Authorization: Bearer $SRK" -H "apikey: $SRK" \
  "https://$REF.supabase.co/storage/v1/object/list/backups" \
  -H "Content-Type: application/json" -d '{"prefix":""}'

# 3) Baixar o arquivo do dia desejado
curl -s -H "Authorization: Bearer $SRK" -H "apikey: $SRK" \
  "https://$REF.supabase.co/storage/v1/object/backups/AAAA-MM-DD.json.gz" \
  -o backup.json.gz
gunzip backup.json.gz          # => backup.json
```

Estrutura do JSON:
```json
{ "meta": { "version": 1, "generated_at": "...", "tables": [...] },
  "data": { "organizations": [...], "contacts": [...], ... },
  "counts": { "organizations": 1, "contacts": 3, ... } }
```

### B.2 — Reimportar em um schema temporário (NUNCA direto em produção)

Valide num schema isolado antes de tocar em `public`. `jsonb_populate_recordset`
usa o tipo da tabela real, então os tipos batem automaticamente.

```sql
create schema restore_test;
create table restore_test.contacts (like public.contacts including all);

-- cole o array data.contacts do JSON no lugar de :json
insert into restore_test.contacts
  select * from jsonb_populate_recordset(null::public.contacts, :'json'::jsonb);

select count(*) from restore_test.contacts;   -- confira contra counts.contacts
```

### B.3 — Promover para produção (só depois de conferir)

Escolha por tabela, na ordem de dependência (organizations → profiles →
pipelines → pipeline_stages → products → tags → custom_field_defs → contacts →
deals → activities → automations → integrations → calendar_events →
wpp_conversations → wpp_messages → interacoes → analises):

```sql
-- exemplo: recuperar contatos sem duplicar (upsert por id)
insert into public.contacts
  select * from jsonb_populate_recordset(null::public.contacts, :'json'::jsonb)
on conflict (id) do update set
  first_name = excluded.first_name, last_name = excluded.last_name,
  email = excluded.email, updated_at = excluded.updated_at;   -- ajuste as colunas
```

> `integrations.config` volta como `"[REDACTED]"` — **reconfigure os tokens à
> mão** (Evolution/WhatsApp, Gmail OAuth, Twilio) em Configurações → Integrações.

### Disparo manual do backup (gerar um dump agora)

```bash
curl -s -X POST "https://hniieydykjvjwggshvkf.supabase.co/functions/v1/backup-export" \
  -H "Content-Type: application/json" \
  -H "x-worker-key: <AUTOMATIONS_WORKER_KEY>" \
  -d '{"source":"manual"}'
```

---

## Cenário C — Postgres do Railway (Evolution / WhatsApp)

O WhatsApp de **todos os clientes** roda numa Evolution API com Postgres
**próprio no Railway**, separado do Supabase. Perder ele = perder sessões e
histórico de WhatsApp no lado da Evolution (o CRM guarda uma cópia das
conversas em `wpp_conversations`/`wpp_messages`, que **entram** no backup
lógico).

**Backup (fazer periodicamente — ação manual do Jean):**
1. Railway → projeto da Evolution → serviço **Postgres** → aba **Data** /
   **Connect** para pegar a `DATABASE_URL`.
2. `pg_dump "$DATABASE_URL" -Fc -f evolution-AAAA-MM-DD.dump`
3. Guardar o `.dump` fora do Railway (Drive/S3).

**Restore:**
1. Provisione um novo Postgres (ou limpe o atual).
2. `pg_restore --clean --if-exists -d "$DATABASE_URL" evolution-AAAA-MM-DD.dump`
3. Reaponte a `DATABASE_URL` da Evolution API para o banco restaurado e
   reinicie o serviço. As instâncias podem precisar reconectar (QR Code).

**Recomendado:** ativar os backups nativos do Postgres no Railway (ver ações
manuais).

---

## Checklist pós-restore (rodar SEMPRE, qualquer cenário)

- [ ] **Secrets das Edge Functions** intactos: `supabase secrets list`
      (ANTHROPIC_API_KEY, AUTOMATIONS_WORKER_KEY, OPENAI_API_KEY, etc.).
      Secrets **não** são apagados por um restore de banco, mas confirme.
- [ ] **Integrações** reconfiguradas se veio do JSON: WhatsApp (Evolution
      URL/key), Gmail OAuth, Twilio — `integrations.config` volta redigido.
- [ ] **Senha de export** (`organizations.settings.export_pass_hash`) redefinida
      se veio do JSON (não está no dump).
- [ ] **Cron jobs** ativos: `select jobname, schedule, active from cron.job;`
      — devem existir `vendeai-automations-worker`,
      `vendeai-backup-export`, `wpp-health` e afins.
- [ ] **Webhooks** apontando certo: Evolution (wpp-webhook) e Twilio
      (call-webhook) com as URLs das functions.
- [ ] **Bucket `backups`** ainda **privado** (`select public from storage.buckets
      where id='backups';` → `false`).
- [ ] **Google OAuth / calendar-sync**: tokens em `integrations.config` — se
      redigidos, reconectar em Configurações.
- [ ] **Smoke test**: login no CRM, abrir um deal, enviar 1 WhatsApp de teste,
      rodar uma análise de IA.
- [ ] **Rodar `backup-export` manualmente** para ter um dump limpo do estado
      pós-restore.

---

## Ações manuais pendentes do Jean

1. **Ativar PITR no Supabase** (Database → Backups → Point in Time). Custo
   adicional mensal — vale quando houver clientes pagantes. Sem PITR, o pior
   caso de perda é de até ~24h (último snapshot diário).
2. **Ativar backups do Postgres no Railway** (Evolution/WhatsApp) e/ou agendar
   `pg_dump` periódico guardado fora do Railway.
3. **Testar um restore de verdade a cada trimestre** (baixar o último JSON,
   reimportar 2 tabelas num schema temporário, conferir contagens, dropar) —
   backup não testado não é backup.
