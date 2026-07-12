# Runbook — WhatsApp (Evolution API)

O WhatsApp de **todos** os clientes do VendeAI roda numa **única** instância da
Evolution API (v2.3.7) hospedada no **Railway** (plano Hobby, ~US$5/mês), com
**Redis** e **Postgres** no mesmo projeto. É um **ponto único de falha**: se
esse serviço cai, o WhatsApp para para todo mundo.

Este runbook explica como diagnosticar, reagir e o que o Jean precisa fazer
**manualmente** para reduzir o risco.

---

## Componentes

| Item | Onde |
|---|---|
| Evolution API | Railway — `https://evolution-api-production-870f.up.railway.app` |
| Redis + Postgres da Evolution | mesmo projeto Railway |
| Monitor de saúde | Edge Function `wpp-health` (Supabase), grava em `service_health` |
| Agendamento | job pg_cron `vendeai-wpp-health`, a cada 5 min |
| Proxy de envio | Edge Function `wpp-send` |
| Banner de degradação | `renderWppHealthBanner()` em `supabase.js` (whatsapp.html / settings.html) |

> ⚠️ A **apikey** da Evolution nunca deve aparecer no frontend nem em logs.
> Ela vive apenas nos secrets do Supabase (`EVOLUTION_URL`, `EVOLUTION_API_KEY`).

---

## Monitoramento (o que já existe)

A cada 5 minutos o pg_cron chama `wpp-health`, que pinga a Evolution
(`GET /` e `GET /instance/fetchInstances`), mede a latência e grava uma linha
em `service_health` (`status = ok | down`). Quando o status **muda** (ok→down
ou down→ok), o campo `detail` registra a transição.

Ver o estado atual (Management API / SQL Editor):

```sql
select status, latency_ms, detail, checked_at
from service_health
where service = 'evolution'
order by checked_at desc
limit 20;
```

Se a última linha estiver `down`, os usuários já veem o banner discreto
**"WhatsApp temporariamente indisponível"** ao abrir `whatsapp.html` e
`settings.html`. O envio de mensagens continua **salvando** o texto no banco
(fila) e mostra um aviso claro, sem erro técnico.

Rodar a checagem manualmente:

```bash
curl -s -X POST \
  https://hniieydykjvjwggshvkf.supabase.co/functions/v1/wpp-health \
  -H 'Content-Type: application/json' \
  -H 'x-worker-key: 32e848f2ad41a0c2728795e38caf834427a697ca2ab4022c' \
  -d '{"source":"manual"}'
```

Conferir o job do cron:

```sql
select jobname, schedule, active from cron.job where jobname = 'vendeai-wpp-health';
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'vendeai-wpp-health')
order by start_time desc limit 5;
```

---

## Ver logs no Railway

1. Acesse [railway.app](https://railway.app) e entre no projeto da Evolution.
2. Clique no serviço **Evolution API** → aba **Deployments** / **Logs**.
3. Filtre por erro (ex.: `ERROR`, `Baileys`, `connection`). Logs de conexão do
   WhatsApp e falhas de webhook aparecem aqui.
4. Para Redis/Postgres, abra os respectivos serviços no mesmo projeto e veja
   **Metrics** (CPU/RAM) e **Logs**.

---

## Reiniciar o serviço

> Só reinicie se necessário — **reiniciar derruba a conexão** de todos os
> clientes por alguns instantes; a reconexão costuma ser automática, mas a
> instância pode pedir novo QR se a sessão expirou.

No Railway: serviço **Evolution API** → menu **⋮** → **Restart** (ou faça um
**Redeploy** do último deployment). Aguarde ~1–2 min e rode o `wpp-health`
manual acima para confirmar que voltou a `ok`.

---

## Instância desconectada (sem que o serviço tenha caído)

Sintoma: `wpp-health` diz `ok` (servidor no ar), mas mensagens não saem e o
`fetchInstances` mostra a instância em estado `close`/`connecting`.

Correção (feita pelo próprio cliente, sem tocar no Railway):

1. No CRM, vá em **Configurações → Integrações → WhatsApp**.
2. Clique em **Conectar / Reconectar** e **leia o QR Code** com o app do
   WhatsApp do celular (Aparelhos conectados → Conectar aparelho).
3. Assim que parear, o status volta para **Conectado** e o envio normaliza.

Se o QR não aparecer, aguarde alguns segundos e tente de novo (a Evolution às
vezes leva um tempo para gerar um novo QR após expirar o anterior).

---

## Restaurar o Postgres do Railway

O Postgres da Evolution guarda sessões/estado das instâncias. Se ele corromper
ou for perdido:

1. **Se houver backup ativo** (ver ações manuais abaixo): Railway → serviço
   **Postgres** → **Backups** → escolha o ponto mais recente → **Restore**.
2. **Sem backup**: será preciso recriar as instâncias e **reparear todos os
   clientes por QR** (Configurações → Integrações). Por isso ativar backup é
   prioridade (item B abaixo).
3. Após restaurar, rode o `wpp-health` manual e confirme `ok`; depois valide um
   envio de teste numa conversa real.

---

## ✅ Checklist de AÇÕES MANUAIS para o Jean

Estas ações **não** dão para automatizar por código — dependem de acessar os
painéis do Railway / UptimeRobot. Faça na ordem:

- [ ] **A. Upgrade do Railway.** Sair do plano Hobby para um plano com mais
  CPU/RAM e **backups** (Railway → projeto → **Settings / Usage** → escolher
  plano superior). O Hobby não garante recursos nem retenção adequada para um
  serviço em produção que atende vários clientes.

- [ ] **B. Ativar backup do Postgres no Railway.** Railway → serviço
  **Postgres** → aba **Backups** → habilitar backups automáticos (diários) e
  confirmar a retenção. Testar uma restauração pelo menos uma vez.

- [ ] **C. Monitor externo gratuito (UptimeRobot).** Criar conta em
  [uptimerobot.com](https://uptimerobot.com) e configurar **dois** monitores
  HTTP(s), intervalo de 5 min, com alerta por e-mail/telefone:
  1. `https://evolution-api-production-870f.up.railway.app` (a Evolution)
  2. `https://otpvendeai.com.br` (o CRM em produção)

  O monitor externo é independente do Supabase/Railway: mesmo que o `wpp-health`
  não rode, o UptimeRobot avisa o Jean se algo cair.

---

## Referências

- Migration: `supabase/migrations/20260712190000_service_health.sql`
- Function: `supabase/functions/wpp-health/index.ts`
- Helper Evolution: `supabase/functions/_shared/evolution.ts`
- Banner: `renderWppHealthBanner()` em `supabase.js`
