// ══════════════════════════════════════════════════════════════════
// VendeAI · Aparência (tema, emojis, fonte)
// Carregado no <head> para aplicar a preferência antes do primeiro paint.
// Persistência: localStorage (imediato, por dispositivo) +
// user_metadata do Supabase Auth (segue o usuário entre dispositivos).
// ══════════════════════════════════════════════════════════════════
(function () {
  var KEY = 'vendeai_theme';
  var DEFAULTS = { theme: 'padrao', emojis: 'on', font: 'padrao' };

  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      return {
        theme:  raw.theme  || DEFAULTS.theme,
        emojis: raw.emojis || DEFAULTS.emojis,
        font:   raw.font   || DEFAULTS.font
      };
    } catch (e) { return { theme: 'padrao', emojis: 'on', font: 'padrao' }; }
  }

  function apply(p) {
    var h = document.documentElement;
    if (p.theme && p.theme !== 'padrao') h.setAttribute('data-theme', p.theme);
    else h.removeAttribute('data-theme');
    if (p.emojis === 'off') h.setAttribute('data-emojis', 'off');
    else h.removeAttribute('data-emojis');
    if (p.font && p.font !== 'padrao') h.setAttribute('data-font', p.font);
    else h.removeAttribute('data-font');
    if (p.emojis === 'off' && document.body) { wrapEmojis(document.body); ensureObserver(); }
  }

  // ── Emojis renderizados por JS ──
  // O build já embrulha emojis do HTML estático em <span class="emj">.
  // Este passe cobre conteúdo dinâmico (KPIs, saudação, listas), só quando
  // emojis estão desligados. Exclui ✓ ✕ × e afins, que são ícones funcionais.
  var EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}☀-✒✖-➿⬀-⯿ℹ⃣️‍⤴⤵〰〽]+/gu;

  function wrapEmojis(root) {
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        EMOJI_RE.lastIndex = 0;
        if (!n.nodeValue || !EMOJI_RE.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        var tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'TITLE') return NodeFilter.FILTER_REJECT;
        if (p.closest('.emj') || p.closest('[contenteditable]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (tw.nextNode()) nodes.push(tw.currentNode);
    nodes.forEach(function (n) {
      EMOJI_RE.lastIndex = 0;
      var text = n.nodeValue, frag = document.createDocumentFragment(), last = 0, m;
      while ((m = EMOJI_RE.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var s = document.createElement('span');
        s.className = 'emj';
        s.textContent = m[0];
        frag.appendChild(s);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    });
  }

  var mo = null, moPending = false;
  function ensureObserver() {
    if (mo || !document.body) return;
    mo = new MutationObserver(function () {
      if (moPending) return;
      moPending = true;
      requestAnimationFrame(function () {
        moPending = false;
        if (document.documentElement.getAttribute('data-emojis') === 'off') wrapEmojis(document.body);
      });
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function sbClient() {
    try { return (typeof sb !== 'undefined') ? sb : null; } catch (e) { return null; }
  }
  function demo() {
    try { return localStorage.getItem('vendeai_demo') === '1'; } catch (e) { return false; }
  }

  // Aplica imediatamente o que está salvo neste dispositivo (sem flash)
  apply(read());

  window.VendeAITheme = {
    get: read,
    // set({theme|emojis|font}) — aplica na hora, salva local e sincroniza na conta
    set: function (partial) {
      var p = Object.assign(read(), partial || {});
      try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {}
      apply(p);
      var client = sbClient();
      if (client && !demo()) {
        try {
          client.auth.getSession().then(function (res) {
            if (res && res.data && res.data.session) {
              client.auth.updateUser({ data: { vendeai_theme: p } }).catch(function () {});
            }
          });
        } catch (e) {}
      }
    },
    // Puxa a preferência salva na conta (outro dispositivo) e aplica se diferir
    syncFromUser: function (user) {
      try {
        var remote = user && user.user_metadata && user.user_metadata.vendeai_theme;
        if (!remote) return;
        var merged = {
          theme:  remote.theme  || DEFAULTS.theme,
          emojis: remote.emojis || DEFAULTS.emojis,
          font:   remote.font   || DEFAULTS.font
        };
        localStorage.setItem(KEY, JSON.stringify(merged));
        apply(merged);
      } catch (e) {}
    }
  };

  // Ao carregar a página, sincroniza com a conta (cobre login em novo dispositivo)
  document.addEventListener('DOMContentLoaded', function () {
    if (read().emojis === 'off') { wrapEmojis(document.body); ensureObserver(); }
    var client = sbClient();
    if (!client || demo()) return;
    try {
      client.auth.getUser().then(function (res) {
        if (res && res.data && res.data.user) window.VendeAITheme.syncFromUser(res.data.user);
      }).catch(function () {});
    } catch (e) {}
  });
})();
