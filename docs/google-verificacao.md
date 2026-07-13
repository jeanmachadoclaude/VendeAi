# Google OAuth em produção — guia do Jean

Este guia é a parte **manual** do PROMPT 9. A parte de código (escopos mínimos +
aviso de reconexão) já está feita e commitada. Aqui está o que **você** precisa
fazer no Google Cloud Console e as decisões de estratégia.

> **Contexto do problema.** O app OAuth do VendeAI (projeto "My First Project",
> client id `369950101954-96h8jqlhsr322rqv8r6b2rhul9j6ga5u.apps.googleusercontent.com`)
> está em modo **Testing**. Nesse modo o Google **expira os refresh tokens em ~7 dias**
> e limita a **100 usuários de teste**. É por isso que a integração dos clientes
> "cai" toda semana e eles precisam reconectar. Sair do modo Testing resolve a
> expiração dos 7 dias.

---

## 1. Escopos — o que o VendeAI pede e por quê (auditado)

Reduzimos para o **mínimo necessário**. Cada escopo é usado por uma function específica:

| Escopo | Function que usa | O que faz | Classificação Google |
|---|---|---|---|
| `gmail.send` | `email-send` | **Só envia** e-mail pela conta do cliente. Não lê, não apaga. | Sensível |
| `gmail.readonly` | `email-sync` | Lista a caixa de entrada e lê o *snippet* (resumo) para vincular respostas de leads à timeline. | **Restrito** |
| `calendar.events` | `calendar-sync` | Lê e cria **eventos** na agenda primária. Não mexe em ACL, compartilhamento nem configurações. | Sensível |
| `userinfo.email` | `google-oauth` | Descobre qual conta foi conectada (preenche o `from_email`). | Não-sensível |

**O que mudou nesta entrega (escopos antigos → novos):**

- `gmail.modify` → `gmail.send` + `gmail.readonly`
  (o CRM nunca altera/apaga e-mails; separamos em enviar + ler, mais restrito e mais fácil de justificar).
- `calendar` (completo) → `calendar.events`
  (não precisamos de acesso às configurações da agenda, só aos eventos).

> ⚠️ **IMPORTANTE — usuários existentes precisam reconectar.**
> Como os escopos mudaram, o consentimento antigo não cobre os novos. Todos os
> clientes que já conectaram precisam clicar em **"Conectar com Google"** de novo
> em *Configurações → Integrações → Gmail* (e em *Agenda*). Avise-os. O novo aviso
> de reconexão na tela já ajuda a guiar isso.

**Por que isso importa para a verificação:** `gmail.readonly` é um escopo
**restrito** do Google. Basta **um** escopo restrito para o app cair na trilha de
verificação mais cara (avaliação de segurança CASA). Os outros três, sozinhos,
seriam só "sensíveis" (verificação simples). Guarde essa informação — ela decide
o caminho recomendado na seção 4.

---

## 2. Mudar de "Testing" para "In production"

Onde: **Google Cloud Console → APIs & Services → OAuth consent screen**.

Passo a passo:

1. Abra o **OAuth consent screen** do projeto "My First Project".
2. No topo, em **Publishing status: Testing**, clique em **PUBLISH APP** →
   confirme **Push to production**.
3. O status vira **In production**.

### O que acontece ao publicar

- ✅ **Os refresh tokens PARAM de expirar em 7 dias.** Esse é o ganho principal:
  a integração dos clientes deixa de cair toda semana.
- ✅ Acaba o limite de 100 usuários de teste.
- ⚠️ **Enquanto o app não for verificado**, todo usuário novo vê a tela
  **"O Google não verificou este app"** ao conectar. Ele consegue prosseguir em
  **"Avançado" → "Acessar VendeAI (não seguro)"**. Funciona, mas assusta cliente
  leigo. Há também um **teto de 100 novas concessões (grants) de escopos
  sensíveis/restritos** enquanto não verificado — ou seja, dá para operar com os
  primeiros ~100 clientes sem verificar, contando que você aceite a tela de aviso.

Resumo: **publicar já resolve os 7 dias hoje.** A verificação é o passo seguinte,
para tirar a tela de aviso e destravar volume.

---

## 3. Verificação da marca (brand verification)

Para remover a tela "app não verificado" o Google exige verificar o app. Requisitos:

### 3.1 Itens obrigatórios da tela de consentimento
- **Nome do app**: VendeAI (ou "VendeAI CRM").
- **Logo**: 120×120px, enviado no OAuth consent screen.
- **Domínio autorizado**: `otpvendeai.com.br` (precisa ser provado no
  **Google Search Console** — verificação de propriedade do domínio via DNS TXT na HostGator).
- **E-mail de suporte** e **e-mail do desenvolvedor**.
- **Link da Política de Privacidade** e **Termos de Uso**, hospedados **no mesmo
  domínio** do app.

### 3.2 ❗ Páginas que ainda NÃO existem — criar antes de submeter
Hoje **não há** páginas de privacidade/termos publicadas. Você precisa de:

- `https://otpvendeai.com.br/privacidade`
- `https://otpvendeai.com.br/termos`

A política de privacidade **precisa citar explicitamente**:
- que o VendeAI acessa Gmail e Google Agenda do usuário;
- **quais** dados são acessados (e-mails enviados/recebidos, eventos de agenda);
- **como** são usados (registrar a comunicação com leads no CRM) e que **não**
  são vendidos nem usados para treinar IA de terceiros;
- como o usuário revoga o acesso (myaccount.google.com/permissions).

> Se você quiser, no próximo prompt eu escrevo o conteúdo dessas duas páginas em
> PT-BR e já entrego o HTML no padrão do site Outpace (sem travessões, como você prefere).

### 3.3 O vídeo do fluxo
A verificação normalmente pede um **vídeo do YouTube** demonstrando: o app, a tela
de consentimento (mostrando os escopos), e o que o app faz com cada escopo.

---

## 4. O ponto crítico: `gmail.readonly` é escopo RESTRITO

Como usamos `gmail.readonly`, a verificação completa exige uma **avaliação de
segurança independente (CASA — Cloud Application Security Assessment)**:

- **CASA Tier 2** para escopos restritos de Gmail.
- **Custo**: tipicamente **US$ 1.000–4.500 por ano**, pago a um laboratório
  terceiro credenciado (ex.: Bishop Fox, Leviathan, TAC Security).
- **Prazo**: de **algumas semanas a alguns meses** (questionário + varredura +
  correções).
- **Recorrente**: precisa ser refeito **anualmente**.

Isso é pesado para o estágio atual (primeiros clientes). Existem **alternativas**:

### Plano A — Publicar sem verificar (aceitar a tela de aviso)
Publica em produção (seção 2) e **não** submete à verificação por enquanto.
- ✅ Resolve os 7 dias hoje, custo zero, imediato.
- ⚠️ Cliente vê a tela "app não verificado" (você o orienta a clicar em Avançado).
- ⚠️ Teto de ~100 usuários com escopos sensíveis/restritos.
- Ideal para **os primeiros clientes**, com você acompanhando cada onboarding.

### Plano B — Cada cliente usa o próprio app OAuth (sem verificação sua)
O código **já suporta** isso: o modo avançado do modal Gmail aceita `client_id` e
`client_secret` próprios da org (campos `gm-client-id` / `gm-client-secret`, usados
antes dos secrets centrais). Nesse caso **cada cliente** publica o próprio app no
**modo Testing/Interno da conta dele** — sem verificação, porque é o app da própria
empresa acessando os próprios dados. Para clientes **Google Workspace**, o admin
pode publicar como **Internal** (sem tela de aviso, sem limite de 7 dias, sem CASA).

Passo a passo que você entrega ao cliente (Workspace):
1. Acesse **console.cloud.google.com** com a conta admin da empresa.
2. Crie um projeto (ex.: "CRM VendeAI").
3. **APIs & Services → Enable APIs** → habilite **Gmail API** e **Google Calendar API**.
4. **OAuth consent screen** → tipo **Internal** → preencha nome e e-mails → salve.
5. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Em **Authorized redirect URIs**, cole:
     `https://<SEU-PROJECT-REF>.supabase.co/functions/v1/google-oauth`
6. Copie o **Client ID** e **Client Secret**.
7. No VendeAI: *Configurações → Integrações → Gmail → opções avançadas* → cole os
   dois campos, salve, e clique em **Conectar com Google**.

- ✅ Zero custo/verificação para você; sem tela de aviso (Internal); sem os 7 dias.
- ⚠️ Passo técnico chato para cliente sem TI. Melhor para clientes com Workspace/admin.

### Plano C — Verificação completa com CASA
Só quando houver **volume** (dezenas/centenas de clientes fora de Workspace) que
justifique o custo anual. Aí sim: brand verification + CASA Tier 2.

---

## 5. Recomendação (minha)

Para o estágio atual — **primeiros clientes médios, você acompanhando cada
onboarding** — o caminho é:

1. **Agora: Plano A.** Publique o app em produção hoje (seção 2). Isso mata o
   problema dos 7 dias imediatamente, sem custo e sem espera. A tela de "app não
   verificado" é contornável e, com você ao lado no onboarding, não trava ninguém.
2. **Em paralelo, sem pressa:** crie as páginas `/privacidade` e `/termos` em
   `otpvendeai.com.br` (peça que eu escreva) e verifique o domínio no Search
   Console. Isso é barato, você precisa delas de qualquer forma, e já deixa o app
   pronto para a verificação de marca quando quiser tirar a tela de aviso.
3. **Para clientes Google Workspace:** ofereça o **Plano B (Internal)**. É a
   melhor experiência (sem aviso, sem CASA) e muitos clientes médios industriais
   têm Workspace com admin.
4. **CASA (Plano C): adiar.** Só faz sentido quando o volume de clientes **fora**
   de Workspace passar de ~100 ou a tela de aviso começar a custar vendas. Reavaliar
   quando chegar lá — o custo anual não se justifica com poucos clientes.

Em uma frase: **publique agora (resolve os 7 dias), escreva privacidade/termos em
paralelo, use Internal para quem tem Workspace, e só pague CASA quando o volume pedir.**
