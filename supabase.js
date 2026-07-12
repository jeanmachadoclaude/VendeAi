// ── CONFIG ─── Substitua pelas credenciais do seu projeto Supabase ──────────
// Supabase → Settings → API → Project URL e anon/public key
const SUPABASE_URL = 'https://hniieydykjvjwggshvkf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ijDu67Qgizur9hnDsHNqTA_XS5SE6O4';
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── DEMO MODE ────────────────────────────────────────────────────────────────
const DEMO_ORG_ID  = '00000000-0000-0000-0000-000000000001';
const DEMO_USER_ID = '00000000-0000-0000-0000-000000000002';
function isDemoMode() { return localStorage.getItem('vendeai_demo') === '1'; }
function enterDemo()  { localStorage.setItem('vendeai_demo', '1'); window.location.href = 'dashboard.html'; }
function exitDemo()   { localStorage.removeItem('vendeai_demo'); window.location.href = 'index.html'; }

// ── AUTH GUARD ───────────────────────────────────────────────────────────────
// Chame initAuth() no início do script de cada página protegida.
// Redireciona para login se não há sessão ativa.
// Preenche nome, iniciais e saudação automaticamente.
async function initAuth() {
  // Demo mode — sem Supabase, dados fictícios
  if (isDemoMode()) {
    const name     = 'Usuário Demo';
    const initials = 'UD';
    const avatarEl  = document.getElementById('avatar-initials') || document.getElementById('user-avatar');
    const nameEl    = document.getElementById('user-name-display') || document.getElementById('user-name');
    const greetEl   = document.getElementById('greeting-text');
    const logoutBtn = document.getElementById('btn-logout');
    if (avatarEl) avatarEl.textContent = initials;
    if (nameEl)   nameEl.textContent   = name;
    if (greetEl) {
      const h = new Date().getHours();
      const greet = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
      greetEl.innerHTML = `${greet}, <em>Demo</em> 👋`;
    }
    if (logoutBtn) logoutBtn.addEventListener('click', exitDemo);
    return {
      session: { access_token: 'demo', user: { id: DEMO_USER_ID, email: 'demo@vendeai.com' } },
      profile: { org_id: DEMO_ORG_ID, full_name: name, role: 'admin' },
      name, initials,
    };
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.replace('index.html');
    return null;
  }

  let { data: profile } = await sb
    .from('profiles')
    .select('full_name, role, org_id, is_active')
    .eq('id', session.user.id)
    .single();

  // Auto-provisiona: se o usuário não tem perfil ou está sem organização,
  // aceita um convite pendente (entra na org que convidou) ou, no self-service,
  // cria org + perfil admin na hora (senão as Edge Functions retornam
  // "Perfil sem organização" e o CRM fica sem dados).
  if (!profile?.org_id) {
    const created = await ensureProfile(session.user);
    // Havia um convite explícito, mas ele é inválido (expirado/revogado/e-mail
    // errado): não criamos org própria — devolvemos o usuário ao login com o
    // aviso, onde ele pode optar por criar conta sem convite.
    if (created?.inviteError) {
      await sb.auth.signOut();
      window.location.replace('index.html?invite_error=' + encodeURIComponent(created.inviteError));
      return null;
    }
    if (created?.org_id) {
      profile = { full_name: created.full_name, role: created.role,
                  org_id: created.org_id, is_active: created.is_active };
    }
  }

  // Membro desativado: encerra a sessão e volta ao login com aviso. O JWT segue
  // válido para REST direto até expirar (limitação conhecida) — a Edge Function
  // member-admin faz signOut global no ato da desativação para mitigar.
  if (profile && profile.is_active === false) {
    await sb.auth.signOut();
    window.location.replace('index.html?disabled=1');
    return null;
  }

  const name     = profile?.full_name || session.user.email.split('@')[0];
  const first    = name.split(' ')[0];
  const initials = name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();

  const avatarEl  = document.getElementById('avatar-initials') || document.getElementById('user-avatar');
  const nameEl    = document.getElementById('user-name-display') || document.getElementById('user-name');
  const greetEl   = document.getElementById('greeting-text');
  const logoutBtn = document.getElementById('btn-logout');

  if (avatarEl) avatarEl.textContent = initials;
  if (nameEl)   nameEl.textContent   = name;

  if (greetEl) {
    const h     = new Date().getHours();
    const greet = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    greetEl.innerHTML = `${greet}, <em>${first}</em> 👋`;
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await sb.auth.signOut();
      window.location.href = 'index.html';
    });
  }

  // Garante pipeline padrão em background — não bloqueia a página
  if (profile?.org_id) {
    ensureDefaultPipeline(profile.org_id, session.user.id);
  }

  // Badges da sidebar com contagens reais (não bloqueia a página)
  updateNavBadges();

  return { session, profile, name, initials };
}

// ── BADGES DA SIDEBAR ────────────────────────────────────────────────────────
// Preenche #badge-pipeline (negócios abertos), #badge-wpp (msgs não lidas) e
// #badge-activities (atividades atrasadas do usuário logado)
// em qualquer página que tenha esses elementos.
async function updateNavBadges() {
  try {
    const bp = document.getElementById('badge-pipeline');
    const bw = document.getElementById('badge-wpp') || document.getElementById('unread-total');
    const ba = document.getElementById('badge-activities');
    if (!bp && !bw && !ba) return;
    const { data: { session } } = ba ? await sb.auth.getSession() : { data: { session: null } };
    const [deals, wpp, overdue] = await Promise.all([
      bp ? sb.from('deals').select('id', { count: 'exact', head: true }).eq('status', 'open') : Promise.resolve({ count: null }),
      bw ? sb.from('wpp_conversations').select('unread_count') : Promise.resolve({ data: null }),
      ba && session ? sb.from('activities').select('id', { count: 'exact', head: true })
        .eq('owner_id', session.user.id).eq('is_done', false)
        .not('scheduled_at', 'is', null).lt('scheduled_at', new Date().toISOString())
        : Promise.resolve({ count: null }),
    ]);
    if (ba) {
      const n = overdue.count ?? 0;
      ba.textContent = n;
      ba.style.display = n ? '' : 'none';
    }
    if (bp) {
      const n = deals.count ?? 0;
      bp.textContent = n;
      bp.style.display = n ? '' : 'none';
    }
    if (bw) {
      const unread = (wpp.data || []).reduce((s, c) => s + (c.unread_count || 0), 0);
      bw.textContent = unread;
      bw.style.display = unread ? '' : 'none';
    }
  } catch (e) { console.warn('updateNavBadges falhou:', e.message); }
}

// ── BOOTSTRAP PRIMEIRO LOGIN ─────────────────────────────────────────────────
// Cria org + profile automaticamente para novos usuários.
// Chamado logo após sb.auth.signInWithPassword ou signUp com confirmação.
async function ensureProfile(user) {
  const cols = 'id, org_id, full_name, role, is_active';
  const { data: existing } = await sb
    .from('profiles').select(cols).eq('id', user.id).single();

  if (existing?.org_id) return existing;

  // 1) Convite explícito (usuário clicou no link ?invite=TOKEN — o token ficou
  //    guardado no localStorage até o e-mail ser confirmado e ele voltar).
  const pendingToken = localStorage.getItem('vendeai_invite');
  if (pendingToken) {
    const { data: res } = await sb.rpc('accept_invite', { p_token: pendingToken });
    localStorage.removeItem('vendeai_invite');
    if (res?.ok) {
      const { data: p } = await sb.from('profiles').select(cols).eq('id', user.id).single();
      return p || { id: user.id, org_id: res.org_id, role: res.role, is_active: true };
    }
    // Convite inválido: NÃO cria org própria (evita vendedor perdido numa org
    // vazia). Sinaliza o erro para a UI oferecer "criar conta sem convite".
    return { inviteError: res?.reason || 'Convite inválido ou expirado.' };
  }

  // 2) Sem link, mas há convite pendente para o e-mail do usuário (cadastrou-se
  //    direto, sem clicar no link). Aceita automaticamente.
  const { data: pend } = await sb.rpc('find_pending_invite_for_me');
  if (pend?.ok && pend.token) {
    const { data: res } = await sb.rpc('accept_invite', { p_token: pend.token });
    if (res?.ok) {
      const { data: p } = await sb.from('profiles').select(cols).eq('id', user.id).single();
      return p || { id: user.id, org_id: res.org_id, role: res.role, is_active: true };
    }
  }

  // 3) Self-service: nenhum convite → cria org própria (perfil admin).
  return bootstrapSelfOrg(user);
}

// Cria org + perfil admin para um usuário sem convite (fluxo self-service).
// Também é o "criar conta sem convite" oferecido quando um convite é inválido.
async function bootstrapSelfOrg(user) {
  localStorage.removeItem('vendeai_invite');
  const domain = user.email.split('@')[1]?.split('.')[0] || 'empresa';
  const slug   = domain.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + Date.now();
  const orgName = domain.charAt(0).toUpperCase() + domain.slice(1);

  // RPC atômica (security definer): cria org + perfil admin de uma vez,
  // sem esbarrar na RLS durante o INSERT..RETURNING.
  const { data: orgId, error } = await sb.rpc('bootstrap_org_profile', {
    p_org_name:  orgName,
    p_slug:      slug,
    p_full_name: user.email.split('@')[0],
    p_email:     user.email,
  });

  if (error) { console.error('Erro no bootstrap de org/perfil:', error); return null; }

  const { data: profile } = await sb
    .from('profiles').select('id, org_id, full_name, role, is_active').eq('id', user.id).single();

  return profile || { id: user.id, org_id: orgId, full_name: user.email.split('@')[0], role: 'admin', is_active: true };
}

// ── PIPELINE PADRÃO ──────────────────────────────────────────────────────────
// Garante que a org tem ao menos um pipeline com estágios.
// Chamado dentro de initAuth() — roda uma vez e nunca bloqueia a UI.
// Garante o pipeline Outbound padrão no 1º login. Desde a RLS por papel
// (migration 20260712210000), o INSERT direto em pipelines/pipeline_stages é
// restrito a admin/manager — então o onboarding roda via RPC security definer
// ensure_default_pipeline (idempotente; só age na própria org e se não houver
// nenhum pipeline). O 2º parâmetro (ownerId) é mantido por compatibilidade
// com os chamadores; o dono do pipeline é o auth.uid() dentro da RPC.
async function ensureDefaultPipeline(orgId, ownerId) {
  const { error } = await sb.rpc('ensure_default_pipeline', { p_org: orgId });
  if (error) console.error('Erro ao garantir pipeline padrão:', error);
}

// ── LOG DE ATIVIDADE ─────────────────────────────────────────────────────────
// Insere um registro em activities. Nunca lança exceção — falha silenciosa
// para não bloquear a ação principal.
//
// Uso:
//   await logActivity({ orgId, type: 'note', title: 'Contato criado',
//                        contactId, ownerId });
//
// type válidos: 'note' | 'call' | 'email' | 'whatsapp' | 'meeting' |
//               'task' | 'stage_change' | 'deal_won' | 'deal_lost' | 'auto'
// ── AUTORIZAÇÃO DE EXPORTAÇÃO/IMPORTAÇÃO ─────────────────────────────────────
// Chame antes de qualquer extração de dados (Excel, importações).
// Admin passa direto; os demais perfis precisam da senha de autorização
// definida pelo admin (Configurações → Auditoria). A validação e o registro
// na trilha de auditoria acontecem no banco (RPC authorize_export) — toda
// tentativa, autorizada ou negada, fica gravada.
async function guardExport(resource, role, action = 'export') {
  if (isDemoMode()) return true;
  let password = null;
  if (role !== 'admin') {
    const verbo = action === 'import' ? 'Importações exigem' : 'Exportações exigem';
    password = prompt('🔒 ' + verbo + ' autorização de administrador.\nDigite a senha de autorização definida pelo admin:');
    if (password === null) return false; // cancelou
  }
  const { data, error } = await sb.rpc('authorize_export', {
    p_action: action, p_resource: resource, p_password: password,
  });
  if (error) { alert('Não foi possível validar a autorização: ' + error.message); return false; }
  if (!data?.ok) { alert('⛔ ' + (data?.reason || 'Ação não autorizada.')); return false; }
  return true;
}

async function logActivity({ orgId, type, title, body, contactId, dealId, ownerId, meta }) {
  const { error } = await sb.from('activities').insert({
    org_id:     orgId,
    type,
    title:      title || null,
    body:       body  || null,
    contact_id: contactId || null,
    deal_id:    dealId    || null,
    owner_id:   ownerId   || null,
    meta:       meta      || {},
  });
  if (error) console.warn('logActivity falhou:', error.message);
}

// ── Degradação suave: banner de saúde do WhatsApp (Evolution) ──────────────
// A Evolution é ponto único de falha. A Edge Function wpp-health grava o status
// em service_health a cada 5 min. Aqui só lemos a última linha e, se estiver
// "down", mostramos um aviso discreto. Checagem única no carregamento — sem
// polling. Best-effort: qualquer erro é silencioso (não atrapalha a página).
async function renderWppHealthBanner() {
  if (isDemoMode()) return;
  try {
    const { data } = await sb
      .from('service_health')
      .select('status, checked_at')
      .eq('service', 'evolution')
      .order('checked_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data || data.status !== 'down') return;
    if (document.getElementById('wpp-health-banner')) return;

    const when = data.checked_at
      ? new Date(data.checked_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : '';
    const bar = document.createElement('div');
    bar.id = 'wpp-health-banner';
    bar.setAttribute('role', 'status');
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2000;display:flex;align-items:center;' +
      'justify-content:center;gap:8px;padding:9px 16px;background:rgba(243,156,18,0.16);' +
      'border-bottom:1px solid rgba(243,156,18,0.45);color:#f39c12;' +
      "font-family:'Inter',sans-serif;font-size:13px;font-weight:600;backdrop-filter:blur(6px);";
    bar.innerHTML =
      '⚠️ WhatsApp temporariamente indisponível' +
      (when ? ` <span style="opacity:.7;font-weight:500;">(última verificação ${when})</span>` : '') +
      '<button aria-label="Fechar" onclick="this.parentNode.remove()" ' +
      'style="margin-left:6px;background:none;border:none;color:inherit;cursor:pointer;' +
      'font-size:16px;line-height:1;opacity:.7;">×</button>';
    document.body.appendChild(bar);
  } catch (_) { /* banner é best-effort */ }
}
