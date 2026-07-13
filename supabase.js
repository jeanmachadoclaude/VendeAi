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
  } catch (e) {
    console.warn('updateNavBadges falhou:', e.message);
    if (window.Sentry && !isDemoMode()) Sentry.captureMessage('updateNavBadges falhou: ' + e.message, 'warning');
  }
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
// ── DIÁLOGOS PADRÃO DO CRM ───────────────────────────────────────────────────
// Substituem os confirm()/prompt() nativos do navegador por modais no design
// do CRM (centralizados, com blur). Retornam Promise:
//   await crmConfirm('Excluir?', { danger: true })       → true | false
//   await crmPrompt('Nome:', { value: 'x', password })   → string | null
function _crmDialogHost() {
  let host = document.getElementById('crm-dialog-overlay');
  if (host) return host;
  const style = document.createElement('style');
  style.textContent = `
    #crm-dialog-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);z-index:900;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s;padding:20px;}
    #crm-dialog-overlay.open{opacity:1;pointer-events:all;}
    .crm-dialog{background:#0c1626;border:1px solid rgba(74,127,212,0.35);border-radius:20px;width:100%;max-width:440px;padding:28px;transform:translateY(14px);transition:transform .2s;box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 10px 24px rgba(0,0,0,0.35),0 28px 80px 6px rgba(0,0,0,0.6);}
    #crm-dialog-overlay.open .crm-dialog{transform:translateY(0);}
    .crm-dialog-title{font-family:'Playfair Display',serif;font-size:19px;font-weight:800;color:var(--cream,#f5efe2);margin-bottom:10px;}
    .crm-dialog-msg{font-size:13px;color:var(--light,#c8d4e8);line-height:1.6;white-space:pre-line;margin-bottom:18px;}
    .crm-dialog-input{width:100%;padding:11px 14px;background:rgba(74,127,212,0.06);border:1px solid rgba(74,127,212,0.25);border-radius:9px;font-size:13px;color:var(--cream,#f5efe2);font-family:'Inter',sans-serif;outline:none;margin-bottom:18px;box-sizing:border-box;}
    .crm-dialog-input:focus{border-color:#7ab3f0;}
    .crm-dialog-actions{display:flex;justify-content:flex-end;gap:10px;}
    .crm-dialog-btn{padding:10px 20px;border-radius:9px;font-size:13px;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;transition:all .2s;border:1px solid rgba(74,127,212,0.3);background:none;color:var(--light,#c8d4e8);}
    .crm-dialog-btn:hover{border-color:#7ab3f0;}
    .crm-dialog-btn.ok{background:#4a7fd4;border-color:#4a7fd4;color:#fff;}
    .crm-dialog-btn.ok:hover{background:#5a8fe4;}
    .crm-dialog-btn.danger{background:#e74c3c;border-color:#e74c3c;color:#fff;}
    .crm-dialog-btn.danger:hover{background:#f75c4c;}`;
  document.head.appendChild(style);
  host = document.createElement('div');
  host.id = 'crm-dialog-overlay';
  document.body.appendChild(host);
  return host;
}

function crmDialog({ title, message, input = null, okLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false }) {
  return new Promise(resolve => {
    const host = _crmDialogHost();
    const escD = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    host.innerHTML = `
      <div class="crm-dialog">
        ${title ? `<div class="crm-dialog-title">${escD(title)}</div>` : ''}
        ${message ? `<div class="crm-dialog-msg">${escD(message)}</div>` : ''}
        ${input ? `<input class="crm-dialog-input" id="crm-dialog-input" type="${input.password ? 'password' : 'text'}" placeholder="${escD(input.placeholder || '')}" autocomplete="off" />` : ''}
        <div class="crm-dialog-actions">
          <button class="crm-dialog-btn" id="crm-dialog-cancel">${escD(cancelLabel)}</button>
          <button class="crm-dialog-btn ${danger ? 'danger' : 'ok'}" id="crm-dialog-ok">${escD(okLabel)}</button>
        </div>
      </div>`;
    const inputEl = host.querySelector('#crm-dialog-input');
    if (inputEl && input.value) inputEl.value = input.value;
    const done = val => {
      host.classList.remove('open');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => { host.innerHTML = ''; }, 200);
      resolve(val);
    };
    const ok = () => done(input ? inputEl.value : true);
    // captura para o Esc/Enter não vazarem p/ handlers da página (fechar painéis etc.)
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && (!input || document.activeElement === inputEl)) { e.stopPropagation(); e.preventDefault(); ok(); }
    };
    host.querySelector('#crm-dialog-ok').onclick = ok;
    host.querySelector('#crm-dialog-cancel').onclick = () => done(null);
    host.onclick = e => { if (e.target === host) done(null); };
    document.addEventListener('keydown', onKey, true);
    host.classList.add('open');
    setTimeout(() => (inputEl || host.querySelector('#crm-dialog-ok')).focus(), 60);
  });
}
async function crmConfirm(message, opts = {}) {
  return (await crmDialog({
    title: opts.title || 'Confirmar', message,
    okLabel: opts.okLabel || 'Confirmar', cancelLabel: opts.cancelLabel || 'Cancelar',
    danger: !!opts.danger,
  })) === true;
}
function crmPrompt(message, opts = {}) {
  return crmDialog({
    title: opts.title || '', message,
    input: { value: opts.value || '', placeholder: opts.placeholder || '', password: !!opts.password },
    okLabel: opts.okLabel || 'OK',
  });
}

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
    password = await crmPrompt(verbo + ' autorização de administrador. Digite a senha de autorização definida pelo admin:', { title: '🔒 Autorização necessária', password: true, okLabel: 'Autorizar' });
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
  if (error) {
    console.warn('logActivity falhou:', error.message);
    if (window.Sentry && !isDemoMode()) Sentry.captureMessage('logActivity falhou: ' + error.message, 'warning');
  }
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

// ── SELECTS CUSTOMIZADOS (sombra macOS) ──────────────────────────────────────
// Os <select> nativos abrem uma lista desenhada pelo SISTEMA — CSS box-shadow
// não pega nela. Este enhancer mantém o <select> nativo como fonte da verdade
// (value, onchange, leitura por outros scripts seguem iguais) e sobrepõe um
// menu próprio, estilizado e com a mesma sombra em camadas dos modais.
// Aplica-se sozinho a todos os selects de todas as páginas (menos [data-no-enhance]).
(function () {
  const escS = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let styleInjected = false, menuHost = null, activeSel = null;

  function injectStyle() {
    if (styleInjected) return; styleInjected = true;
    const st = document.createElement('style');
    st.textContent = `
      .crm-sel-wrap{position:relative;}
      .crm-sel-trigger{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;}
      .crm-sel-caret{font-size:9px;opacity:.6;flex-shrink:0;margin-left:2px;}
      .crm-sel-menu{position:fixed;background:#0c1626;border:1px solid var(--border,#26344a);border-radius:12px;padding:6px;z-index:1200;max-height:300px;overflow-y:auto;opacity:0;transform:translateY(-4px);pointer-events:none;transition:opacity .13s,transform .13s;box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 10px 24px rgba(0,0,0,0.35),0 28px 80px 6px rgba(0,0,0,0.6);}
      .crm-sel-menu.open{opacity:1;transform:translateY(0);pointer-events:all;}
      .crm-sel-opt{display:flex;align-items:center;gap:8px;width:100%;padding:8px 11px;border-radius:8px;background:none;border:none;color:var(--light,#c8d4e8);font-size:12.5px;font-family:'Inter',sans-serif;cursor:pointer;text-align:left;white-space:nowrap;transition:background .12s;}
      .crm-sel-opt:hover{background:rgba(74,127,212,0.12);}
      .crm-sel-opt.active{color:var(--blue-ll,#a9cbf5);background:rgba(74,127,212,0.14);}
      .crm-sel-opt[disabled]{opacity:.4;cursor:default;}
      .crm-sel-check{margin-left:auto;font-size:10px;color:var(--blue-l,#7ab3f0);}`;
    document.head.appendChild(st);
  }

  function host() {
    if (menuHost) return menuHost;
    menuHost = document.createElement('div');
    menuHost.className = 'crm-sel-menu';
    document.body.appendChild(menuHost);
    return menuHost;
  }

  function labelFor(sel) {
    const o = sel.options[sel.selectedIndex];
    return o ? o.textContent : '';
  }
  function syncLabel(sel) {
    const t = sel._crmTrigger; if (!t) return;
    t.querySelector('.crm-sel-label').textContent = labelFor(sel) || t.dataset.placeholder || '';
  }

  function closeMenu() {
    if (!activeSel) return;
    host().classList.remove('open');
    const s = activeSel; activeSel = null;
    s._crmTrigger?.setAttribute('aria-expanded', 'false');
  }

  function openMenu(sel) {
    if (activeSel === sel) { closeMenu(); return; }
    closeMenu();
    activeSel = sel;
    const h = host();
    h.innerHTML = [...sel.options].map((o, i) =>
      `<button type="button" class="crm-sel-opt ${i === sel.selectedIndex ? 'active' : ''}" data-i="${i}" ${o.disabled ? 'disabled' : ''}>${escS(o.textContent)}${i === sel.selectedIndex ? '<span class="crm-sel-check">✓</span>' : ''}</button>`
    ).join('');
    h.querySelectorAll('.crm-sel-opt').forEach(btn => {
      if (btn.disabled) return;
      btn.onclick = () => {
        const i = +btn.dataset.i;
        if (i !== sel.selectedIndex) {
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        syncLabel(sel);
        closeMenu();
      };
    });
    // posição fixa sob o gatilho (não clipa em toolbars com overflow)
    const r = sel._crmTrigger.getBoundingClientRect();
    h.style.minWidth = r.width + 'px';
    h.style.left = Math.min(r.left, window.innerWidth - 260) + 'px';
    h.style.visibility = 'hidden'; h.classList.add('open');
    const mh = h.offsetHeight;
    const below = window.innerHeight - r.bottom;
    h.style.top = (below < mh + 12 && r.top > mh + 12 ? r.top - mh - 6 : r.bottom + 6) + 'px';
    h.style.visibility = '';
    sel._crmTrigger.setAttribute('aria-expanded', 'true');
    const act = h.querySelector('.crm-sel-opt.active'); if (act) act.scrollIntoView({ block: 'nearest' });
  }

  function enhance(sel) {
    if (sel._crmEnhanced || sel.multiple || sel.hasAttribute('data-no-enhance')) return;
    sel._crmEnhanced = true;
    injectStyle();
    // Lê o box REAL do select (venha de classe ou de estilo inline) antes de escondê-lo,
    // pra o gatilho ficar visualmente idêntico ao original.
    const cs = getComputedStyle(sel);
    const fullWidth = sel.classList.contains('form-select') || sel.classList.contains('form-input') ||
      cs.width === '100%' || /(^|\s)100%/.test(sel.style.width) || sel.style.flex || parseFloat(cs.flexGrow) > 0;
    const wrap = document.createElement('span');
    wrap.className = 'crm-sel-wrap';
    wrap.style.display = fullWidth ? 'block' : 'inline-block';
    wrap.style.verticalAlign = 'middle';
    if (fullWidth) wrap.style.width = '100%';
    if (sel.style.flex) wrap.style.flex = sel.style.flex;
    const trigger = document.createElement('div');
    trigger.className = sel.className + ' crm-sel-trigger';
    trigger.tabIndex = sel.disabled ? -1 : 0;
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-expanded', 'false');
    // copia o visual do select nativo para o gatilho
    Object.assign(trigger.style, {
      padding: cs.padding,
      border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
      borderRadius: cs.borderRadius,
      background: cs.backgroundColor,
      color: cs.color,
      fontSize: cs.fontSize, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight,
      minWidth: fullWidth ? '' : cs.minWidth,
      width: fullWidth ? '100%' : '',
      boxSizing: cs.boxSizing,
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    });
    trigger.innerHTML = `<span class="crm-sel-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${fullWidth ? 'flex:1;min-width:0;' : ''}"></span><span class="crm-sel-caret">▼</span>`;
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    wrap.appendChild(trigger);
    // esconde o nativo mas mantém no DOM (fonte da verdade p/ value/onchange)
    sel.style.position = 'absolute'; sel.style.width = '1px'; sel.style.height = '1px';
    sel.style.opacity = '0'; sel.style.pointerEvents = 'none'; sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    sel._crmTrigger = trigger;
    trigger.dataset.placeholder = sel.options[0]?.textContent || '';
    syncLabel(sel);
    // Espelha o display do select no wrapper: selects escondidos por código
    // (ex.: filtro de produtos só aparece após escolher pipeline) continuam
    // escondidos, e reaparecem quando a página os reexibe.
    const baseDisp = fullWidth ? 'block' : 'inline-block';
    const applyVis = () => { wrap.style.display = sel.style.display === 'none' ? 'none' : baseDisp; };
    applyVis();
    new MutationObserver(applyVis).observe(sel, { attributes: true, attributeFilter: ['style'] });
    trigger.addEventListener('click', e => { e.stopPropagation(); if (!sel.disabled) openMenu(sel); });
    trigger.addEventListener('keydown', e => {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); openMenu(sel); }
      else if (e.key === 'Escape') closeMenu();
    });
    // mantém o rótulo em sincronia com mudanças programáticas / repopulação
    sel.addEventListener('change', () => syncLabel(sel));
    new MutationObserver(() => syncLabel(sel)).observe(sel, { childList: true });
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll('select:not([data-no-enhance])').forEach(enhance);
  }

  document.addEventListener('click', e => { if (activeSel && !e.target.closest('.crm-sel-menu')) closeMenu(); }, true);
  window.addEventListener('scroll', () => closeMenu(), true);
  window.addEventListener('resize', () => closeMenu());

  function boot() {
    enhanceAll(document);
    // pega selects criados dinamicamente depois (linhas de equipe, importador, etc.)
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'SELECT') enhance(n);
        else if (n.querySelectorAll) enhanceAll(n);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.crmEnhanceSelects = enhanceAll;
})();
