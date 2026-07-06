#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# VendeAI — Ativação da Fase 2 (Vende.IA + E-mail + Telefonia)
#
# Pré-requisito (uma única vez): supabase login
# Depois: bash ativar_vendeia.sh
# ═══════════════════════════════════════════════════════════════
set -e
cd "$(dirname "$0")"

PROJECT_REF="hniieydykjvjwggshvkf"

echo "── 1/3 Vinculando ao projeto Supabase (VendeAi)…"
supabase link --project-ref "$PROJECT_REF"

echo "── 2/3 Publicando as Edge Functions…"
for fn in vendeai-analyze wpp-suggest email-send email-sync call-dial wpp-send wpp-status; do
  supabase functions deploy "$fn"
done
# Webhooks recebem chamadas externas (Evolution/Twilio) — sem verificação de JWT
for fn in wpp-webhook call-webhook; do
  supabase functions deploy "$fn" --no-verify-jwt
done

echo "── 3/3 Falta só você fazer:"
echo ""
echo "  a) Rodar o SQL da fase 2 (tabelas emails/calls/ai_analyses):"
echo "     Supabase Dashboard → SQL Editor → cole o conteúdo de setup_fase2_vendeia.sql → Run"
echo ""
echo "  b) Configurar as chaves de IA (secrets):"
echo "     supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # console.anthropic.com (Vende.IA)"
echo "     supabase secrets set OPENAI_API_KEY=sk-...          # platform.openai.com (transcrição Whisper)"
echo ""
echo "  c) No CRM → Configurações → Integrações:"
echo "     🤖 Vende.IA  → colar a metodologia Outpace Growth"
echo "     💬 WhatsApp  → URL/key do servidor Evolution API + QR Code"
echo "     📧 Gmail     → credenciais OAuth (envio + leitura de respostas)"
echo "     📞 Telefonia → credenciais Twilio (discador + gravação)"
echo ""
echo "✅ Deploy das funções concluído!"
