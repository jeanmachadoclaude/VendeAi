// ══════════════════════════════════════════════════════════════════
// VendeAI · Conselheiro (persona Jean Machado)
// Botão flutuante no canto inferior direito com a foto do Jean.
// Abre um popup de chat com fundo embaçado, no mesmo padrão visual
// dos modais do CRM (borda, sombra em camadas, radius 20px).
// Backend: Edge Function 'vendeai-advisor' (persona + base de
// conhecimento da organização). Modo demo responde localmente.
// Requer: supabase.js (global sb, isDemoMode) já carregado na página.
// ══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var STORE_KEY = 'vendeai_advisor_chat';
  var MAX_HISTORY = 30;
  var PHOTO = 'images/jean-conselheiro.jpg';

  // Persona do conselheiro. Padrão: Jean. Quando a org configurou um clone
  // (organizations.settings.advisor_persona === 'clone' + settings.clone),
  // o widget troca nome, subtítulo e avatar (iniciais) para o clone - e o
  // backend (vendeai-advisor) responde com a mesma persona.
  var PERSONA = {
    kind: 'jean',
    name: 'Jean Machado',
    first: 'Jean',
    sub: 'Seu conselheiro · Metodologia Outpace',
    initials: 'JM'
  };

  function nameInitials(name) {
    return String(name || '').split(' ').slice(0, 2).map(function (n) { return (n[0] || ''); }).join('').toUpperCase();
  }

  // Nome amigável da tela atual, enviado como contexto para a IA
  var PAGES = {
    'dashboard.html':          'Dashboard (visão geral de vendas)',
    'contacts.html':           'Contatos',
    'deals.html':              'Negócios',
    'pipeline.html':           'Pipeline (funil de vendas)',
    'activities.html':         'Atividades',
    'calendar.html':           'Calendário',
    'automations.html':        'Automações',
    'automation-builder.html': 'Construtor de automações',
    'whatsapp.html':           'WhatsApp',
    'settings.html':           'Configurações'
  };

  function pageName() {
    var file = (location.pathname.split('/').pop() || 'dashboard.html').toLowerCase();
    return PAGES[file] || document.title.replace(/^VendeAI\s*·\s*/, '') || 'CRM';
  }

  var CHIPS = [
    'Como quebrar a objeção "está caro"?',
    'Me ajuda a montar um follow-up',
    'Como destravar um negócio parado?'
  ];

  // ── Estilos ──────────────────────────────────────────────────
  var CSS = [
    '.jm-fab{position:fixed;right:24px;bottom:24px;z-index:160;width:60px;height:60px;border-radius:50%;padding:0;border:2px solid rgba(var(--blue-l-rgb,74,127,212),0.55);background:var(--card,rgba(10,18,36,0.88));cursor:pointer;overflow:visible;box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 6px 16px rgba(0,0,0,0.4),0 16px 48px rgba(0,0,0,0.5);transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease;-webkit-tap-highlight-color:transparent;}',
    '.jm-fab:hover{transform:translateY(-2px) scale(1.05);border-color:var(--blue-l,#4a7fd4);box-shadow:0 0 0 1px rgba(255,255,255,0.08),0 10px 24px rgba(0,0,0,0.45),0 20px 60px rgba(var(--blue-l-rgb,74,127,212),0.35);}',
    '.jm-fab:focus-visible{outline:2px solid var(--blue-l,#4a7fd4);outline-offset:3px;}',
    '.jm-fab img{width:100%;height:100%;border-radius:50%;object-fit:cover;object-position:center;display:block;}',
    '.jm-fab::before{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid rgba(var(--blue-l-rgb,74,127,212),0.45);animation:jm-pulse 2.6s ease-out infinite;pointer-events:none;}',
    '@keyframes jm-pulse{0%{transform:scale(1);opacity:.7}70%{transform:scale(1.35);opacity:0}100%{transform:scale(1.35);opacity:0}}',
    '.jm-fab-dot{position:absolute;right:2px;bottom:4px;width:13px;height:13px;border-radius:50%;background:var(--success,#2ecc71);border:2.5px solid var(--bg,#080c14);}',
    '.jm-fab-tip{position:fixed;right:96px;bottom:38px;z-index:160;background:rgba(var(--card-rgb,10,18,36),0.98);border:1px solid rgba(var(--blue-l-rgb,74,127,212),0.35);color:var(--cream,#EDE8DB);font-family:var(--font-body,Inter,sans-serif);font-size:12.5px;font-weight:600;letter-spacing:.2px;padding:7px 12px;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,0.45);opacity:0;transform:translateX(6px);pointer-events:none;transition:opacity .18s ease,transform .18s ease;white-space:nowrap;}',
    '.jm-fab:hover~.jm-fab-tip{opacity:1;transform:translateX(0);}',

    /* Fundo da página: desfoque suave. O card em si é sólido e nítido. */
    '.jm-overlay{position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.35);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:flex;align-items:flex-end;justify-content:flex-end;padding:24px;opacity:0;pointer-events:none;transition:opacity .25s ease;}',
    '.jm-overlay.open{opacity:1;pointer-events:all;}',

    '.jm-card{display:flex;flex-direction:column;width:min(440px,100%);height:min(660px,calc(100vh - 48px));background:var(--bg-elev,#0c1626);border:1px solid var(--border,rgba(74,127,212,0.2));border-radius:20px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 10px 24px rgba(0,0,0,0.35),0 28px 80px 6px rgba(0,0,0,0.6);transform:translateY(20px) scale(.98);transition:transform .25s ease;font-family:var(--font-body,Inter,sans-serif);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;}',
    '.jm-overlay.open .jm-card{transform:translateY(0) scale(1);}',

    '.jm-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border2,rgba(74,127,212,0.08));background:rgba(var(--blue-l-rgb,74,127,212),0.05);flex-shrink:0;}',
    '.jm-head-photo{position:relative;flex-shrink:0;}',
    '.jm-head-photo img{width:44px;height:44px;border-radius:50%;object-fit:cover;object-position:center;display:block;border:2px solid rgba(var(--blue-l-rgb,74,127,212),0.5);}',
    '.jm-head-photo::after{content:"";position:absolute;right:0;bottom:1px;width:11px;height:11px;border-radius:50%;background:var(--success,#2ecc71);border:2px solid var(--bg-elev,#0c1626);}',
    '.jm-head-id{flex:1;min-width:0;}',
    '.jm-head-name{font-size:15px;font-weight:700;letter-spacing:-.2px;color:var(--cream,#EDE8DB);line-height:1.25;}',
    '.jm-head-sub{font-size:11.5px;color:var(--muted,#5e718a);margin-top:2px;letter-spacing:.2px;}',
    '.jm-head-btn{width:32px;height:32px;border-radius:9px;border:1px solid transparent;background:none;color:var(--muted,#5e718a);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:color .15s ease,background .15s ease,border-color .15s ease;flex-shrink:0;}',
    '.jm-head-btn:hover{color:var(--cream,#EDE8DB);background:rgba(var(--blue-l-rgb,74,127,212),0.1);border-color:var(--border2,rgba(74,127,212,0.08));}',
    '.jm-head-btn:focus-visible{outline:2px solid var(--blue-l,#4a7fd4);outline-offset:2px;}',
    '.jm-head-btn svg{width:16px;height:16px;}',

    '.jm-msgs{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;overscroll-behavior:contain;}',
    '.jm-msgs::-webkit-scrollbar{width:8px;}',
    '.jm-msgs::-webkit-scrollbar-thumb{background:rgba(var(--blue-l-rgb,74,127,212),0.25);border-radius:8px;}',

    '.jm-row{display:flex;gap:10px;align-items:flex-end;max-width:88%;}',
    '.jm-row.user{align-self:flex-end;flex-direction:row-reverse;}',
    '.jm-row.advisor{align-self:flex-start;}',
    '.jm-ava{width:28px;height:28px;border-radius:50%;object-fit:cover;object-position:center;flex-shrink:0;border:1.5px solid rgba(var(--blue-l-rgb,74,127,212),0.4);}',
    '.jm-bubble{padding:11px 15px;font-size:14px;line-height:1.6;letter-spacing:.1px;color:var(--cream,#EDE8DB);word-wrap:break-word;overflow-wrap:break-word;white-space:pre-wrap;}',
    '.jm-row.advisor .jm-bubble{background:rgba(var(--blue-l-rgb,74,127,212),0.09);border:1px solid var(--border2,rgba(74,127,212,0.08));border-radius:16px 16px 16px 5px;}',
    '.jm-row.user .jm-bubble{background:var(--gradient,linear-gradient(135deg,#1e3a6e 0%,#4a7fd4 55%,#1e3a6e 100%));color:#fff;border-radius:16px 16px 5px 16px;box-shadow:0 4px 14px rgba(var(--blue-l-rgb,74,127,212),0.25);}',
    '.jm-row.error .jm-bubble{background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.3);color:var(--light,#a0b8d4);}',

    '.jm-typing{display:inline-flex;gap:5px;padding:14px 16px;}',
    '.jm-typing span{width:7px;height:7px;border-radius:50%;background:var(--blue-l,#4a7fd4);opacity:.4;animation:jm-blink 1.2s infinite;}',
    '.jm-typing span:nth-child(2){animation-delay:.2s}.jm-typing span:nth-child(3){animation-delay:.4s}',
    '@keyframes jm-blink{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}',

    '.jm-chips{display:flex;flex-wrap:wrap;gap:8px;padding:0 20px 12px;flex-shrink:0;}',
    '.jm-chip{border:1px solid var(--border,rgba(74,127,212,0.2));background:rgba(var(--blue-l-rgb,74,127,212),0.06);color:var(--light,#a0b8d4);font-family:inherit;font-size:12.5px;font-weight:500;padding:8px 13px;border-radius:100px;cursor:pointer;transition:border-color .15s ease,background .15s ease,color .15s ease;}',
    '.jm-chip:hover{border-color:var(--blue-l,#4a7fd4);background:rgba(var(--blue-l-rgb,74,127,212),0.14);color:var(--cream,#EDE8DB);}',

    '.jm-inputbar{display:flex;align-items:flex-end;gap:10px;padding:14px 16px;border-top:1px solid var(--border2,rgba(74,127,212,0.08));background:rgba(var(--bg-rgb,8,12,20),0.5);flex-shrink:0;}',
    '.jm-input{flex:1;resize:none;border:1px solid var(--border,rgba(74,127,212,0.2));background:rgba(var(--card-rgb,10,18,36),0.7);color:var(--cream,#EDE8DB);font-family:inherit;font-size:14px;line-height:1.5;padding:11px 14px;border-radius:12px;max-height:120px;transition:border-color .15s ease,box-shadow .15s ease;}',
    '.jm-input::placeholder{color:var(--muted,#5e718a);}',
    '.jm-input:focus{outline:none;border-color:var(--blue-l,#4a7fd4);box-shadow:0 0 0 3px rgba(var(--blue-l-rgb,74,127,212),0.15);}',
    '.jm-send{width:42px;height:42px;border-radius:12px;border:none;background:var(--gradient,linear-gradient(135deg,#1e3a6e 0%,#4a7fd4 55%,#1e3a6e 100%));color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .15s ease,box-shadow .15s ease,opacity .15s ease;box-shadow:0 4px 14px rgba(var(--blue-l-rgb,74,127,212),0.35);}',
    '.jm-send:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 20px rgba(var(--blue-l-rgb,74,127,212),0.45);}',
    '.jm-send:disabled{opacity:.45;cursor:default;box-shadow:none;}',
    '.jm-send:focus-visible{outline:2px solid var(--blue-l,#4a7fd4);outline-offset:2px;}',
    '.jm-send svg{width:18px;height:18px;}',

    /* Avatar por iniciais (persona clone, sem foto) */
    '.jm-ini{display:flex;align-items:center;justify-content:center;background:var(--gradient,linear-gradient(135deg,#1e3a6e 0%,#4a7fd4 55%,#1e3a6e 100%));color:#fff;font-weight:800;font-family:var(--font-body,Inter,sans-serif);flex-shrink:0;}',
    '.jm-fab-ini{width:100%;height:100%;border-radius:50%;font-size:19px;letter-spacing:.5px;}',
    '.jm-head-ini{width:44px;height:44px;border-radius:50%;font-size:15px;border:2px solid rgba(var(--blue-l-rgb,74,127,212),0.5);}',
    '.jm-ava.jm-ini{font-size:10px;}',

    'html[data-theme="claro"] .jm-row.user .jm-bubble{color:#fff;}',
    'html[data-theme="claro"] .jm-overlay{background:rgba(22,35,58,0.45);}',

    /* No WhatsApp o rodapé é a caixa de escrever mensagem: sobe o botão */
    'body.jm-page-whatsapp .jm-fab{bottom:92px;}',
    'body.jm-page-whatsapp .jm-fab-tip{bottom:106px;}',

    '@media (max-width:768px){',
    '.jm-fab{right:16px;bottom:76px;width:54px;height:54px;}',
    '.jm-fab-tip{display:none;}',
    '.jm-overlay{padding:0;align-items:stretch;justify-content:stretch;}',
    '.jm-card{width:100%;height:100%;border-radius:0;border:none;}',
    '}',
    '@media (prefers-reduced-motion:reduce){',
    '.jm-fab::before{animation:none;}',
    '.jm-overlay,.jm-card,.jm-fab{transition:none;}',
    '}'
  ].join('\n');

  // ── Ícones (Lucide, inline) ──────────────────────────────────
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  var ICON_RESET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

  // ── Estado ───────────────────────────────────────────────────
  var messages = [];   // { role: 'user' | 'advisor', text }
  var busy = false;
  var els = {};

  function loadHistory() {
    try {
      var raw = JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]');
      if (Array.isArray(raw)) messages = raw.filter(function (m) {
        return m && (m.role === 'user' || m.role === 'advisor') && typeof m.text === 'string';
      }).slice(-MAX_HISTORY);
    } catch (e) { messages = []; }
  }
  function saveHistory() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-MAX_HISTORY))); } catch (e) {}
  }

  function greeting() {
    return 'Opa, aqui é o ' + PERSONA.first + '. Vi que você está na tela de ' + pageName() + '. ' +
      'Me conta o que está na sua frente agora: uma negociação travada, uma objeção, um follow-up que você não sabe como puxar. Vamos resolver juntos.';
  }

  // ── Render ───────────────────────────────────────────────────
  // Avatar do conselheiro: foto do Jean ou iniciais do clone.
  function advAvatar() {
    if (PERSONA.kind === 'clone') {
      var d = document.createElement('div');
      d.className = 'jm-ava jm-ini';
      d.textContent = PERSONA.initials;
      return d;
    }
    var img = document.createElement('img');
    img.className = 'jm-ava';
    img.src = PHOTO;
    img.alt = '';
    return img;
  }

  function bubbleRow(role, text, isError) {
    var row = document.createElement('div');
    row.className = 'jm-row ' + (role === 'user' ? 'user' : 'advisor') + (isError ? ' error' : '');
    if (role !== 'user') row.appendChild(advAvatar());
    var b = document.createElement('div');
    b.className = 'jm-bubble';
    b.textContent = text;
    row.appendChild(b);
    return row;
  }

  function renderAll() {
    els.msgs.innerHTML = '';
    els.msgs.appendChild(bubbleRow('advisor', greeting()));
    messages.forEach(function (m) { els.msgs.appendChild(bubbleRow(m.role, m.text)); });
    els.chips.style.display = messages.length ? 'none' : 'flex';
    scrollBottom();
  }

  function scrollBottom() {
    requestAnimationFrame(function () { els.msgs.scrollTop = els.msgs.scrollHeight; });
  }

  function showTyping() {
    var row = document.createElement('div');
    row.className = 'jm-row advisor';
    row.id = 'jm-typing-row';
    var ava = advAvatar();
    var t = document.createElement('div');
    t.className = 'jm-bubble jm-typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    row.appendChild(ava); row.appendChild(t);
    els.msgs.appendChild(row);
    scrollBottom();
  }
  function hideTyping() {
    var r = document.getElementById('jm-typing-row');
    if (r) r.remove();
  }

  // ── Backend ──────────────────────────────────────────────────
  function demoMode() {
    try { return typeof isDemoMode === 'function' ? isDemoMode() : localStorage.getItem('vendeai_demo') === '1'; }
    catch (e) { return false; }
  }

  async function askAdvisor() {
    if (demoMode()) {
      await new Promise(function (r) { setTimeout(r, 900); });
      return 'No modo demonstração eu ainda não posso aconselhar de verdade. ' +
        'Na conta completa eu leio a sua metodologia, o seu playbook e o contexto da tela para te guiar em cada negociação. Crie sua conta e me chama de novo.';
    }
    if (typeof sb === 'undefined') throw new Error('Supabase não carregado nesta página.');
    var res = await sb.functions.invoke('vendeai-advisor', {
      body: { messages: messages.slice(-MAX_HISTORY), page: pageName() }
    });
    if (res.error) {
      var msg = 'Não consegui responder agora. Tenta de novo em instantes.';
      try {
        var body = await res.error.context.json();
        if (body && body.error) msg = body.error;
      } catch (e) {}
      throw new Error(msg);
    }
    if (!res.data || !res.data.reply) throw new Error('Resposta vazia do conselheiro.');
    return res.data.reply;
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    busy = true;
    els.send.disabled = true;
    els.input.value = '';
    autosize();
    els.chips.style.display = 'none';

    messages.push({ role: 'user', text: text });
    saveHistory();
    els.msgs.appendChild(bubbleRow('user', text));
    scrollBottom();
    showTyping();

    try {
      var reply = await askAdvisor();
      hideTyping();
      messages.push({ role: 'advisor', text: reply });
      saveHistory();
      els.msgs.appendChild(bubbleRow('advisor', reply));
    } catch (err) {
      hideTyping();
      els.msgs.appendChild(bubbleRow('advisor', (err && err.message) || 'Não consegui responder agora. Tenta de novo em instantes.', true));
    }
    scrollBottom();
    busy = false;
    els.send.disabled = false;
    els.input.focus();
  }

  // ── Abrir / fechar ───────────────────────────────────────────
  function open() {
    els.overlay.classList.add('open');
    els.overlay.removeAttribute('aria-hidden');
    renderAll();
    setTimeout(function () { els.input.focus(); }, 260);
  }
  function close() {
    els.overlay.classList.remove('open');
    els.overlay.setAttribute('aria-hidden', 'true');
    els.fab.focus();
  }

  function reset() {
    messages = [];
    saveHistory();
    renderAll();
    els.input.focus();
  }

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 120) + 'px';
  }

  // ── Montagem ─────────────────────────────────────────────────
  function build() {
    var file = (location.pathname.split('/').pop() || '').toLowerCase();
    if (file === 'whatsapp.html') document.body.classList.add('jm-page-whatsapp');

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var fab = document.createElement('button');
    fab.className = 'jm-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Falar com o conselheiro Jean Machado');
    fab.innerHTML = '<img src="' + PHOTO + '" alt="Jean Machado" /><span class="jm-fab-dot"></span>';

    var tip = document.createElement('div');
    tip.className = 'jm-fab-tip';
    tip.textContent = 'Fale com seu conselheiro';

    var overlay = document.createElement('div');
    overlay.className = 'jm-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<section class="jm-card" role="dialog" aria-modal="true" aria-label="Conselheiro Jean Machado">' +
        '<header class="jm-head">' +
          '<div class="jm-head-photo"><img src="' + PHOTO + '" alt="Jean Machado" /></div>' +
          '<div class="jm-head-id">' +
            '<div class="jm-head-name">Jean Machado</div>' +
            '<div class="jm-head-sub">Seu conselheiro · Metodologia Outpace</div>' +
          '</div>' +
          '<button class="jm-head-btn" type="button" data-jm="reset" title="Nova conversa" aria-label="Nova conversa">' + ICON_RESET + '</button>' +
          '<button class="jm-head-btn" type="button" data-jm="close" title="Fechar" aria-label="Fechar">' + ICON_CLOSE + '</button>' +
        '</header>' +
        '<div class="jm-msgs" aria-live="polite"></div>' +
        '<div class="jm-chips"></div>' +
        '<form class="jm-inputbar">' +
          '<textarea class="jm-input" rows="1" placeholder="Me conta o que você precisa..." aria-label="Sua mensagem"></textarea>' +
          '<button class="jm-send" type="submit" aria-label="Enviar">' + ICON_SEND + '</button>' +
        '</form>' +
      '</section>';

    document.body.appendChild(fab);
    document.body.appendChild(tip);
    document.body.appendChild(overlay);

    els = {
      fab: fab,
      overlay: overlay,
      msgs: overlay.querySelector('.jm-msgs'),
      chips: overlay.querySelector('.jm-chips'),
      input: overlay.querySelector('.jm-input'),
      send: overlay.querySelector('.jm-send'),
      form: overlay.querySelector('.jm-inputbar')
    };

    CHIPS.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'jm-chip';
      b.type = 'button';
      b.textContent = c;
      b.addEventListener('click', function () { send(c); });
      els.chips.appendChild(b);
    });

    fab.addEventListener('click', open);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('[data-jm="close"]').addEventListener('click', close);
    overlay.querySelector('[data-jm="reset"]').addEventListener('click', reset);
    els.form.addEventListener('submit', function (e) { e.preventDefault(); send(els.input.value); });
    els.input.addEventListener('input', autosize);
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(els.input.value); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('open')) close();
    });

    loadHistory();
    loadPersona();
  }

  // ── Persona (clone da org) ───────────────────────────────────
  // Lê organizations.settings (RLS devolve só a org do usuário logado).
  // Se advisor_persona === 'clone' e há um clone com nome, troca a
  // identidade visual do widget. Best-effort: qualquer erro mantém o Jean.
  function applyPersona() {
    if (!els.fab) return;
    var first = PERSONA.name.split(' ')[0];
    els.fab.setAttribute('aria-label', 'Falar com o conselheiro ' + PERSONA.name);
    if (PERSONA.kind === 'clone') {
      els.fab.innerHTML = '';
      var ini = document.createElement('span');
      ini.className = 'jm-ini jm-fab-ini';
      ini.textContent = PERSONA.initials;
      var dot = document.createElement('span');
      dot.className = 'jm-fab-dot';
      els.fab.appendChild(ini);
      els.fab.appendChild(dot);
      var hp = els.overlay.querySelector('.jm-head-photo');
      hp.innerHTML = '';
      var hIni = document.createElement('div');
      hIni.className = 'jm-ini jm-head-ini';
      hIni.textContent = PERSONA.initials;
      hp.appendChild(hIni);
    }
    els.overlay.querySelector('.jm-card').setAttribute('aria-label', 'Conselheiro ' + PERSONA.name);
    els.overlay.querySelector('.jm-head-name').textContent = PERSONA.name;
    els.overlay.querySelector('.jm-head-sub').textContent = PERSONA.sub;
    // Se o chat já está aberto com a saudação antiga, rerenderiza
    if (els.overlay.classList.contains('open')) renderAll();
  }

  function loadPersona() {
    if (demoMode() || typeof sb === 'undefined') return;
    try {
      sb.from('organizations').select('settings').limit(1).maybeSingle().then(function (r) {
        var s = (r && r.data && r.data.settings) || {};
        var c = s.clone;
        if (s.advisor_persona === 'clone' && c && String(c.name || '').trim()) {
          var name = String(c.name).trim();
          PERSONA = {
            kind: 'clone',
            name: name,
            first: name.split(' ')[0],
            sub: (c.cargo ? String(c.cargo) : 'Seu conselheiro') + ' · Conselheiro do time',
            initials: nameInitials(name)
          };
          applyPersona();
        }
      }).catch(function () {});
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
