# E-mail no VendeAI — Runbook do deploy (Fases 1–4) e caminho para 100%

> Gerado em 2026-07-23. Cobre o que foi ao ar, o que você precisa fazer manualmente
> agora, como verificar, e os prompts prontos para colar numa sessão do Claude Code
> para fechar o "webmail de verdade" (anexos, HTML, histórico completo, etc.).

---

## 1. O que JÁ está no ar (deploy feito em 2026-07-23)

| Item | Como subiu | Status |
|---|---|---|
| Migrations `email_caixa_completa` + `email_sync_cron` | `supabase db push` (após reparar histórico de migrations) | ✅ aplicadas na produção |
| Secret `EMAIL_WORKER_KEY` | `supabase secrets set` | ✅ configurado |
| Functions `email-sync`, `email-modify`, `google-oauth` | `supabase functions deploy` + CI | ✅ deployadas (compilaram) |
| Frontend (email.html, aba no card, item de menu) | `git push origin main` → Cloudflare Pages | ✅ pushed (build automático) |
| Cron de sync a cada 15 min | migration `20260723001000` (pg_cron) | ✅ agendado (`vendeai-email-sync`) |

**Smoke test:** `email-sync` em modo worker respondeu `{"ok":true,"orgs":0}` — a função roda, mas **nenhuma conta Gmail está conectada** ainda (por isso 0 e-mails). `email-modify` sem login devolve 401 (protegida).

### Nota importante sobre o histórico de migrations
O histórico remoto do Supabase estava **defasado**: 16 migrations de 07–14/jul (RLS, deal_files, etc.) estavam aplicadas no banco mas **não registradas** na tabela de histórico. Foram marcadas como `applied` via `supabase migration repair` (só bookkeeping, não rodou SQL). Deploys futuros de migration agora estão limpos. Se algo parecer estranho, `supabase migration list --linked` mostra o estado real.

---

## 2. O que VOCÊ precisa fazer manualmente AGORA

### 2.1 Conectar / reconectar o Gmail (obrigatório)
Nada aparece na caixa enquanto não houver Gmail conectado (`orgs:0` no smoke test).
1. Entre no CRM → **Configurações → Integrações → Gmail → Conectar com Google**.
2. Autorize com a conta comercial (ex.: vendas@outpacegrowth.com.br).
3. Isso concede o escopo **`gmail.modify`** (novo). Contas que já estavam conectadas **precisam reconectar** — o token antigo só tinha `readonly` e **não move e-mails**.

### 2.2 Verificação do app no Google (atenção)
`gmail.modify` é escopo **"restrito"** do Google. Para a SUA conta (dona do projeto OAuth) funciona com o aviso de "app não verificado". Para outros usuários / uso em produção ampla, o Google pode exigir **verificação CASA**. Se aparecer bloqueio, adicione a conta como **usuário de teste** no OAuth consent screen do Google Cloud, ou toque o processo de verificação. Ver `docs/google-verificacao.md`.

### 2.3 Primeira sincronização
Depois de conectar: **Configurações → Integrações → Gmail → 🔄 Sincronizar agora** (ou espere até 15 min pelo cron). A primeira sync só puxa **os últimos 3 dias** e **até 60 e-mails por rodada** (ver §4, Prompt C para histórico completo).

---

## 3. Checklist de verificação pós-deploy

- [ ] **Frontend no ar:** abra `email.html` na produção (Cloudflare). Menu lateral mostra "✉️ E-mail". Página abre com pastas Entrada/Enviados/Spam/Lixo/Arquivo.
- [ ] **Gmail conectado:** Configurações mostra a conta e "Sincronizar agora" retorna "✅ ... e-mail(s) importados".
- [ ] **Leitura:** após sync, a Entrada lista e-mails reais; abrir mostra o corpo completo; Enviados/Spam/Lixo populam conforme o Gmail.
- [ ] **Ação (precisa de §2.1 reconectado):** abra um e-mail → **🗑️ Lixo** → ele some da Entrada e aparece em Lixo, e some do Gmail também (vai pra lixeira). Se der "sem permissão para mover", falta reconectar (escopo).
- [ ] **Sync automático:** confira a tabela `cron.job` (`select * from cron.job where jobname='vendeai-email-sync'`) — deve existir, a cada 15 min.
- [ ] **Aba no card:** no Pipeline, abra um negócio cujo contato trocou e-mail → aba "✉️ E-mail" mostra a thread.

**Diagnóstico rápido de function:**
```bash
# Rodar o sync manualmente para todas as orgs (worker):
curl -s -X POST 'https://hniieydykjvjwggshvkf.supabase.co/functions/v1/email-sync' \
  -H 'Content-Type: application/json' \
  -H 'x-worker-key: 477002b1c88e55db0ab91585076d30a287e79525cd1b550c' \
  -d '{"source":"manual"}'
# Esperado depois de conectar Gmail: {"ok":true,"imported":N,"updated":M,"orgs":1}
```
Logs: Supabase Dashboard → Functions → email-sync → Logs.

---

## 4. Prompts para chegar a 100% (cole UM por vez numa sessão do Claude Code no repo do CRM)

> Cada prompt é autossuficiente. Rode um, revise/teste, depois o próximo.
> Para automatizar a fila, veja §5 (/loop).

### Prompt A — Anexos (o maior pendente)
```
No CRM VendeAI (~/CRM VENDEAI), implemente anexos de e-mail de ponta a ponta.
Contexto: o email-sync usa format=full e o helper extractBody em
supabase/functions/_shared/gmail.ts. A tabela emails (migration
setup_fase2_vendeia.sql) guarda os e-mails.
1. Migration nova: tabela email_attachments (id, org_id, email_id fk, filename,
   mime_type, size_bytes, gmail_attachment_id, storage_path nullable) + índice
   por email_id + RLS por org (siga o padrão de deal_files em
   migrations/20260713000000_deal_files.sql, inclusive a policy de storage).
2. Em gmail.ts, adicione extractAttachments(payload) que percorre as partes MIME
   e retorna [{filename, mimeType, size, attachmentId}] (partes com filename e
   body.attachmentId).
3. Em email-sync, ao importar um e-mail novo, grave as linhas em
   email_attachments (sem baixar o binário ainda — só metadados).
4. Function nova email-attachment (verify_jwt=true, entrada no config.toml):
   body {attachment_id} → busca o email_attachments + o email, baixa via Gmail
   API (users.messages.attachments.get, base64url) e retorna o arquivo
   (Content-Disposition), OU faz lazy-upload pro bucket 'deal-files' e devolve
   signed URL. Reuse getGmailConfig/gmailAccessToken de gmail.ts.
5. Frontend email.html: no leitor, liste os anexos (nome + tamanho + ícone) com
   download chamando a function. Faça o mesmo na aba de e-mail do pipeline.html.
Teste no modo demo com anexos fake e valide a lógica pura (extractAttachments)
com node. Não faça deploy — deixe acumulado.
```

### Prompt B — Render de HTML seguro no leitor
```
No CRM VendeAI, hoje o corpo do e-mail é convertido para texto puro (htmlToText
em supabase/functions/_shared/gmail.ts), perdendo formatação e imagens.
1. Migration: add coluna body_html text em emails.
2. Em gmail.ts, além de extractBody (texto), extraia o HTML cru (parte text/html)
   e no email-sync grave em body_html.
3. No leitor (email.html #read-body e a aba do pipeline.html), quando houver
   body_html, renderize HTML SANITIZADO. Inclua um sanitizador (DOMPurify inline,
   sem CDN externo — o _headers bloqueia; embuta o script) e permita só tags
   seguras, bloqueando script/iframe/on*=. Imagens remotas: carregue com
   referrerpolicy=no-referrer e um toggle "exibir imagens". Fallback para o texto
   quando não houver HTML.
Teste XSS (corpo com <script> e onerror) e confirme que não executa. Sem deploy.
```

### Prompt C — Histórico completo (paginação e backfill)
```
No CRM VendeAI, o email-sync (supabase/functions/email-sync/index.ts) só puxa 60
e-mails por rodada e, na 1a vez, só 3 dias (janela after:). Quero backfill do
histórico.
1. Aceite um body opcional {backfill:true, pageToken?} que ignora a janela
   (q sem after:), pagina com pageToken (nextPageToken do Gmail) e processa
   lotes maiores, respeitando um teto por invocação para não estourar o tempo
   da function (ex.: 150) e devolvendo o pageToken para continuar.
2. Guarde o progresso do backfill em integrations.config (ex.:
   backfill_page_token, backfill_done) para retomar.
3. Botão em settings.html "Importar histórico completo" que chama em loop até
   backfill_done. Mostre progresso.
Cuidhe do custo/limite da Gmail API. Teste incremental. Sem deploy.
```

### Prompt D — Tempo real (caixa atualiza sem reload)
```
No CRM VendeAI, a página email.html é um retrato estático. Ative tempo real.
1. Migration: adicione a tabela emails à publication supabase_realtime
   (siga migrations/20260714000000_realtime_whatsapp.sql).
2. Em email.html, após loadEmails, faça sb.channel(...).on('postgres_changes',
   {event:'*', schema:'public', table:'emails', filter org}) para inserir/mover
   e-mails na hora (reuse EMAILS/renderList/finishLoad). Trate INSERT (novo),
   UPDATE (folder/is_read mudou).
Teste inserindo uma linha em emails pelo SQL e vendo aparecer. Sem deploy.
```

### Prompt E — Agrupar a caixa por conversa (threading)
```
No CRM VendeAI, a página email.html lista e-mails soltos. Agrupe por conversa
(thread_id do Gmail), como o Gmail faz, dentro de cada pasta. Reuse a lógica de
agrupamento por thread que já existe na aba de e-mail do card do lead em
pipeline.html (função loadPanelEmails). O item da lista deve mostrar o assunto,
o número de mensagens e o último remetente; abrir mostra a thread inteira no
leitor. Mantenha as pastas e as ações. Teste no demo. Sem deploy.
```

### Prompt F — Ações em lote + excluir definitivamente
```
No CRM VendeAI email.html, adicione seleção múltipla (checkbox por item + barra
de ações no topo: Arquivar/Spam/Lixo/Marcar lido em lote) chamando email-modify
por item (ou crie um email-modify-bulk). Na pasta Lixo, adicione "Excluir
definitivamente": ATENÇÃO exige o escopo full mail (https://mail.google.com/) —
avalie se vale trocar o escopo ou apenas remover a linha do CRM sem apagar no
Gmail. Confirmação obrigatória em qualquer exclusão. Teste no demo. Sem deploy.
```

### Prompt G — Reprocessar e-mails antigos (corpo curto → completo)
```
No CRM VendeAI, e-mails sincronizados ANTES da Fase 1 têm só o snippet no campo
body, e o backfill de folder chutou tudo como inbox/sent pela direção. Crie um
modo de reprocessamento no email-sync (ou uma function email-reprocess) que, para
e-mails com message_id, rebusca format=full no Gmail e atualiza body, folder,
is_read e gmail_labels corretos. Faça em lotes idempotentes. Sem deploy.
```

---

## 5. Automatizando a fila com /loop (opcional)

Numa sessão do Claude Code no repo do CRM, você pode encadear os prompts:

- Rodar um de cada vez é o mais seguro (revisa e testa entre eles).
- Se quiser autônomo, use o skill **/loop** descrevendo a fila, ex.:
  `/loop implemente, um por vez, os Prompts A→G do docs/email-fase4-runbook.md; teste cada um no modo demo antes de seguir; NÃO faça deploy; pare e me avise se algo exigir decisão minha.`
- O /loop se auto-pausa entre iterações; você acompanha e interrompe quando quiser.

**Regra de ouro do projeto:** trabalhar direto na branch de produção, mas **deploy só com sua autorização explícita**. Nada de push/`supabase ... deploy`/`db push` sem você mandar.

---

## 6. Referência rápida de deploy (quando for subir os próximos)

```bash
cd ~/"CRM VENDEAI"
# 1. migrations (agora que o histórico está reparado, é direto):
supabase db push --linked
# 2. secrets (se houver novos):
supabase secrets set NOME=valor --project-ref hniieydykjvjwggshvkf
# 3. functions:
supabase functions deploy <nome...> --project-ref hniieydykjvjwggshvkf --use-api
# 4. frontend (Cloudflare Pages via push na main):
git add -A && git commit -m "..." && git push origin HEAD:main
```
Lembrete de cache: JS/CSS (theme.css, theme.js, supabase.js, advisor.js) NÃO têm
no-cache no `_headers` — suba o `?v=` ao editá-los. HTML tem no-cache (ok direto).
