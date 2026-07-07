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
    .select('full_name, role, org_id')
    .eq('id', session.user.id)
    .single();

  // Auto-provisiona: se o usuário não tem perfil ou está sem organização,
  // cria org + perfil admin na hora (senão as Edge Functions retornam
  // "Perfil sem organização" e o CRM fica sem dados).
  if (!profile?.org_id) {
    const created = await ensureProfile(session.user);
    if (created?.org_id) {
      profile = { full_name: created.full_name, role: created.role, org_id: created.org_id };
    }
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
// Preenche #badge-pipeline (negócios abertos) e #badge-wpp (msgs não lidas)
// em qualquer página que tenha esses elementos.
async function updateNavBadges() {
  try {
    const bp = document.getElementById('badge-pipeline');
    const bw = document.getElementById('badge-wpp') || document.getElementById('unread-total');
    if (!bp && !bw) return;
    const [deals, wpp] = await Promise.all([
      bp ? sb.from('deals').select('id', { count: 'exact', head: true }).eq('status', 'open') : Promise.resolve({ count: null }),
      bw ? sb.from('wpp_conversations').select('unread_count') : Promise.resolve({ data: null }),
    ]);
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
  const { data: existing } = await sb
    .from('profiles')
    .select('id, org_id')
    .eq('id', user.id)
    .single();

  if (existing?.org_id) return existing;

  const domain = user.email.split('@')[1]?.split('.')[0] || 'empresa';
  const slug   = domain.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + Date.now();
  const orgName = domain.charAt(0).toUpperCase() + domain.slice(1);

  const { data: org, error: orgErr } = await sb
    .from('organizations')
    .insert({ name: orgName, slug })
    .select('id')
    .single();

  if (orgErr) { console.error('Erro ao criar organização:', orgErr); return null; }

  const { data: profile } = await sb
    .from('profiles')
    .upsert({
      id:        user.id,
      org_id:    org.id,
      email:     user.email,
      full_name: user.email.split('@')[0],
      role:      'admin',
    })
    .select()
    .single();

  return profile;
}

// ── PIPELINE PADRÃO ──────────────────────────────────────────────────────────
// Garante que a org tem ao menos um pipeline com estágios.
// Chamado dentro de initAuth() — roda uma vez e nunca bloqueia a UI.
async function ensureDefaultPipeline(orgId, ownerId) {
  const { data: existing } = await sb
    .from('pipelines')
    .select('id')
    .eq('org_id', orgId)
    .limit(1);

  if (existing && existing.length > 0) return; // já existe

  const { data: pipeline, error } = await sb
    .from('pipelines')
    .insert({ org_id: orgId, name: 'Outbound', emoji: '🎯', position: 0, created_by: ownerId })
    .select('id')
    .single();

  if (error) { console.error('Erro ao criar pipeline padrão:', error); return; }

  const stages = [
    { name: 'Prospecção',  color: '#5e718a', position: 0, default_prob: 10  },
    { name: 'Qualificado', color: '#4a7fd4', position: 1, default_prob: 30  },
    { name: 'Proposta',    color: '#7ab3f0', position: 2, default_prob: 55  },
    { name: 'Negociação',  color: '#f39c12', position: 3, default_prob: 75  },
    { name: 'Ganho',       color: '#2ecc71', position: 4, default_prob: 100, is_won: true  },
    { name: 'Perdido',     color: '#e74c3c', position: 5, default_prob: 0,   is_lost: true },
  ];

  await sb.from('pipeline_stages').insert(
    stages.map(s => ({ ...s, pipeline_id: pipeline.id }))
  );
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
