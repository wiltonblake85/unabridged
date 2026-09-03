// Unabridged - content script.
// Runs on every page. Extracts readable text as an ordered list of blocks,
// exports Google Docs / Slides as text, highlights the sentence being read
// without touching the page's DOM text, and lets the reader start from a
// right-click or Option+click.

(() => {
  if (window.__readAloudLoaded) return;
  window.__readAloudLoaded = true;

  const EXCLUDED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
    'IFRAME', 'OBJECT', 'EMBED', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'SELECT',
    'OPTION', 'TEXTAREA', 'INPUT', 'BUTTON', 'MATH', 'MAP', 'DIALOG'
  ]);
  const EXCLUDED_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary', 'menu', 'menubar',
    'toolbar', 'tablist', 'search', 'dialog', 'alertdialog', 'tooltip', 'button'
  ]);
  const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  // ---------- state ----------
  let blocks = [];          // [{ el, nodes:[{node,start,end}], text, heading }]
  let generation = 0;
  let lastContextTarget = null;
  let styleInjected = false;
  const HIGHLIGHT_NAME = 'ra-sentence';
  const HIGHLIGHT_WORD = 'ra-word';

  // ---------- helpers ----------
  const isElement = (n) => n && n.nodeType === Node.ELEMENT_NODE;

  function isHidden(el) {
    if (el.hidden) return true;
    const ah = el.getAttribute('aria-hidden');
    if (ah === 'true') return true;
    if (typeof el.checkVisibility === 'function') {
      return !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    }
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  function isExcluded(el) {
    const tag = el.tagName;
    if (tag === 'HEADER' || tag === 'FOOTER') {
      // A site header/footer is chrome. An article's own header (title, byline) is content.
      const parent = el.parentElement;
      if (parent && parent.closest('article, main, [role="main"]')) return isHidden(el);
      return true;
    }
    if (EXCLUDED_TAGS.has(tag)) return true;
    const role = el.getAttribute('role');
    if (role && EXCLUDED_ROLES.has(role)) return true;
    if (el.hasAttribute('data-ra-ignore')) return true;
    if (el.classList && (el.classList.contains('sr-only') || el.classList.contains('visually-hidden'))) return true;
    return isHidden(el);
  }

  const INLINE_DISPLAYS = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table', 'contents', 'ruby', 'ruby-base', 'ruby-text']);
  const displayCache = new WeakMap();
  function isBlockish(el) {
    let d = displayCache.get(el);
    if (d === undefined) {
      d = getComputedStyle(el).display;
      displayCache.set(el, d);
    }
    if (d === 'none') return false;
    if (el.tagName === 'BR') return true; // treat a line break as a block boundary
    return !INLINE_DISPLAYS.has(d);
  }

  const containsBlockCache = new WeakMap();
  function containsBlock(el) {
    let v = containsBlockCache.get(el);
    if (v !== undefined) return v;
    v = false;
    for (const c of el.children) {
      if (isExcluded(c)) continue;
      if (isBlockish(c) || containsBlock(c)) { v = true; break; }
    }
    containsBlockCache.set(el, v);
    return v;
  }

  function collectInlineText(el, run) {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) { run.push(n); continue; }
      if (!isElement(n) || isExcluded(n)) continue;
      collectInlineText(n, run);
    }
  }

  function closestBlockEl(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body && !isBlockish(el)) el = el.parentElement;
    return el || document.body;
  }

  function looksLikeChrome(text, nodes) {
    // Skip menu-ish fragments: very short runs made only of link/button text.
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length >= 5) return false;
    const allLinks = nodes.every((n) => n.parentElement && n.parentElement.closest('a, button, [role="button"], [role="link"], label'));
    return allLinks;
  }

  function emitRun(run, out) {
    if (!run.length) return;
    let raw = '';
    const nodes = [];
    for (const n of run) {
      const v = n.nodeValue || '';
      nodes.push({ node: n, start: raw.length, end: raw.length + v.length });
      raw += v;
    }
    if (!/[\p{L}\p{N}]/u.test(raw)) return;
    const el = closestBlockEl(run[0]);
    if (!HEADING_TAGS.has(el.tagName) && looksLikeChrome(raw, run)) return;
    const heading = HEADING_TAGS.has(el.tagName);
    out.push({ el, nodes, text: raw, heading, level: heading ? Number(el.tagName[1]) : 0 });
  }

  function walk(el, out) {
    let run = [];
    const flush = () => { if (run.length) { emitRun(run, out); run = []; } };
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { run.push(node); continue; }
      if (!isElement(node)) continue;
      if (isExcluded(node)) continue;
      if (isBlockish(node) || containsBlock(node)) {
        flush();
        if (node.tagName !== 'BR') walk(node, out);
      } else {
        collectInlineText(node, run);
      }
    }
    flush();
  }

  function pickRoot() {
    // Prefer the semantic main content region when one exists and is big enough.
    const candidates = [
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.querySelector('article')
    ].filter(Boolean);
    for (const c of candidates) {
      const len = (c.innerText || '').trim().length;
      const bodyLen = (document.body.innerText || '').trim().length;
      if (len > 400 && len > bodyLen * 0.3) return c;
    }
    return document.body;
  }

  function buildBlocks() {
    const out = [];
    const root = pickRoot();
    walk(root, out);
    blocks = out;
    generation += 1;
    return out;
  }

  // ---------- Google Docs / Slides ----------
  function googleExportInfo() {
    if (location.hostname !== 'docs.google.com') return null;
    let m = location.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([^/]+)/);
    if (m) return { kind: 'gdoc', url: `/document/d/${m[1]}/export?format=txt` };
    m = location.pathname.match(/^\/presentation\/(?:u\/\d+\/)?d\/([^/]+)/);
    if (m) return { kind: 'gslides', url: `/presentation/d/${m[1]}/export/txt` };
    return null;
  }

  async function extractGoogle(info) {
    const res = await fetch(info.url, { credentials: 'include' });
    if (!res.ok) {
      throw new Error(`Google export failed (HTTP ${res.status}). Make sure you are signed in and have at least view access to this file.`);
    }
    let text = await res.text();
    text = text.replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return {
      kind: info.kind,
      title: document.title.replace(/ - Google (Docs|Slides)$/, ''),
      canHighlight: false,
      blocks: lines.map((t) => ({ text: t, heading: false }))
    };
  }

  // ---------- highlighting ----------
  function ensureStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const st = document.createElement('style');
    st.id = 'ra-highlight-style';
    st.textContent = `
      ::highlight(${HIGHLIGHT_NAME}) { background-color: #ffe1d0; color: inherit; }
      ::highlight(${HIGHLIGHT_WORD}) { background-color: #c67139; color: #fff6ef; }
      .ra-current-block { background-color: rgba(198, 113, 57, 0.10) !important; border-radius: 6px; box-shadow: 0 0 0 4px rgba(198, 113, 57, 0.10); }
      .ra-pick-mode, .ra-pick-mode * { cursor: crosshair !important; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  let outlinedEl = null;
  function clearHighlight() {
    try { if (window.CSS && CSS.highlights) { CSS.highlights.delete(HIGHLIGHT_NAME); CSS.highlights.delete(HIGHLIGHT_WORD); } } catch (_) {}
    if (outlinedEl) { outlinedEl.classList.remove('ra-current-block'); outlinedEl = null; }
  }

  function rangeFor(block, start, end) {
    const findNode = (off, isEnd) => {
      for (const n of block.nodes) {
        if (isEnd ? (off > n.start && off <= n.end) : (off >= n.start && off < n.end)) return n;
      }
      return null;
    };
    const a = findNode(start, false);
    const b = findNode(end, true);
    if (!a || !b || !a.node.isConnected || !b.node.isConnected) return null;
    const r = document.createRange();
    r.setStart(a.node, Math.min(start - a.start, a.node.length));
    r.setEnd(b.node, Math.min(end - b.start, b.node.length));
    return r;
  }

  function highlight(gen, blockIndex, start, end, word) {
    if (gen !== generation) return { ok: false, stale: true };
    const block = blocks[blockIndex];
    if (!block) return { ok: false, stale: true };
    ensureStyle();
    let range = null;
    try { range = rangeFor(block, start, end); } catch (_) { range = null; }
    if (range && window.CSS && CSS.highlights && typeof Highlight !== 'undefined') {
      if (outlinedEl) { outlinedEl.classList.remove('ra-current-block'); outlinedEl = null; }
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
      if (word && typeof word.start === 'number') {
        try {
          const wr = rangeFor(block, word.start, word.end);
          if (wr) CSS.highlights.set(HIGHLIGHT_WORD, new Highlight(wr));
        } catch (_) {}
      } else {
        CSS.highlights.delete(HIGHLIGHT_WORD);
      }
      scrollTo(range.getBoundingClientRect(), block.el);
      return { ok: true };
    }
    // Fallback: outline the block element.
    if (block.el && block.el.isConnected) {
      if (outlinedEl && outlinedEl !== block.el) outlinedEl.classList.remove('ra-current-block');
      block.el.classList.add('ra-current-block');
      outlinedEl = block.el;
      scrollTo(block.el.getBoundingClientRect(), block.el);
      return { ok: true, fallback: true };
    }
    return { ok: false, stale: true };
  }

  function scrollTo(rect, el) {
    if (document.visibilityState !== 'visible') return;
    const vh = window.innerHeight;
    const margin = 80;
    if (rect.top < margin || rect.bottom > vh - margin) {
      const target = rect.top + window.scrollY - vh * 0.4;
      try { window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' }); } catch (_) {
        if (el) el.scrollIntoView({ block: 'center' });
      }
    }
  }


  // ---------- floating controller ----------
  // A fixed pill at the bottom of the page: minutes left, a progress track,
  // prev / play / next. Lives in a shadow root so the page's CSS cannot reach
  // it. Draggable, and collapsible to a tab at the right edge.
  let ctlHost = null;
  let ctl = null;
  let ctlStatus = { show: false, playing: false, waiting: false, left: '', fraction: 0 };
  let ctlCollapsed = false;
  let ctlPos = null; // { left, bottom } in px, or null for centered

  function ensureController() {
    if (ctlHost) return ctl;
    ctlHost = document.createElement('div');
    ctlHost.id = 'ra-controller';
    ctlHost.setAttribute('data-ra-ignore', '');
    ctlHost.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:50%;bottom:26px;transform:translateX(-50%);';
    const root = ctlHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
        .pill { display:flex; align-items:center; gap:12px; padding:9px 10px 9px 18px; border-radius:999px; background:#643312; color:#fff2eb; box-shadow:0 12px 32px rgba(46,43,37,.22); cursor:grab; user-select:none; touch-action:none; }
        .pill.dragging { cursor:grabbing; }
        .left { font-size:12.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
        .track { width:140px; height:6px; border-radius:999px; background:rgba(255,242,235,.24); overflow:hidden; display:block; }
        .track i { display:block; height:100%; width:0; background:#f6a06b; border-radius:999px; transition:width .25s linear; }
        button { all:unset; box-sizing:border-box; display:grid; place-items:center; border-radius:999px; cursor:pointer; color:#fff2eb; }
        button:focus-visible { outline:2px solid #ffc6a5; outline-offset:2px; }
        .s { width:34px; height:34px; background:rgba(255,242,235,.16); }
        .s:hover { background:rgba(255,242,235,.30); }
        .p { width:42px; height:42px; background:#fff2eb; color:#643312; }
        .p:hover { background:#fff; }
        .x { width:26px; height:26px; margin-left:-2px; color:#ffc6a5; }
        .x:hover { background:rgba(255,242,235,.16); }
        svg { display:block; }
        .p svg { display:none; }
        .p[data-state="playing"] .pause { display:block; }
        .p[data-state="paused"] .play, .p[data-state="stopped"] .play { display:block; }
        .p[data-state="waiting"] .wait { display:block; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .track i { transition:none; } .p[data-state="waiting"] .wait { animation:none; } }
        .tab { display:none; width:44px; height:44px; border-radius:999px 0 0 999px; background:#643312; color:#fff2eb; box-shadow:0 12px 32px rgba(46,43,37,.22); }
        :host(.collapsed) .pill { display:none; }
        :host(.collapsed) .tab { display:grid; }
      </style>
      <div class="pill" part="pill">
        <span class="left" id="left"></span>
        <span class="track"><i id="fill"></i></span>
        <button class="s" id="prev" aria-label="Back one sentence"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/></svg></button>
        <button class="p" id="play" data-state="stopped" aria-label="Play or pause">
          <svg class="play" width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          <svg class="pause" width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>
          <svg class="wait" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        </button>
        <button class="s" id="next" aria-label="Forward one sentence"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/></svg></button>
        <button class="x" id="collapse" aria-label="Tuck the controller away"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></button>
      </div>
      <button class="tab" id="tab" aria-label="Show the Unabridged controller"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg></button>`;
    ctl = {
      root, left: root.getElementById('left'), fill: root.getElementById('fill'), play: root.getElementById('play'),
      pill: root.querySelector('.pill'), tab: root.getElementById('tab')
    };
    root.getElementById('prev').addEventListener('click', (e) => { e.stopPropagation(); ctlSend('prev'); });
    root.getElementById('next').addEventListener('click', (e) => { e.stopPropagation(); ctlSend('next'); });
    ctl.play.addEventListener('click', (e) => { e.stopPropagation(); ctlSend('togglePlay'); });
    root.getElementById('collapse').addEventListener('click', (e) => { e.stopPropagation(); setCollapsed(true); });
    ctl.tab.addEventListener('click', () => setCollapsed(false));
    // Drag to reposition (pointer events on the pill body, not its buttons).
    let drag = null;
    ctl.pill.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = ctlHost.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      ctl.pill.setPointerCapture(e.pointerId);
      ctl.pill.classList.add('dragging');
    });
    ctl.pill.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.moved = true;
      const r = ctlHost.getBoundingClientRect();
      const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, e.clientX - drag.dx));
      const top = Math.min(window.innerHeight - r.height - 8, Math.max(8, e.clientY - drag.dy));
      ctlPos = { left, bottom: window.innerHeight - top - r.height };
      applyPos();
    });
    const endDrag = () => { if (!drag) return; drag = null; ctl.pill.classList.remove('dragging'); try { sessionStorage.setItem('ra-ctl-pos', JSON.stringify(ctlPos)); } catch (_) {} };
    ctl.pill.addEventListener('pointerup', endDrag);
    ctl.pill.addEventListener('pointercancel', endDrag);
    try { ctlPos = JSON.parse(sessionStorage.getItem('ra-ctl-pos') || 'null'); ctlCollapsed = sessionStorage.getItem('ra-ctl-collapsed') === '1'; } catch (_) {}
    applyPos();
    ctlHost.classList.toggle('collapsed', ctlCollapsed);
    (document.body || document.documentElement).appendChild(ctlHost);
    return ctl;
  }
  function applyPos() {
    if (!ctlHost) return;
    if (ctlCollapsed) { ctlHost.style.left = 'auto'; ctlHost.style.right = '0'; ctlHost.style.bottom = '26px'; ctlHost.style.transform = 'none'; return; }
    if (ctlPos && typeof ctlPos.left === 'number') { ctlHost.style.left = `${ctlPos.left}px`; ctlHost.style.right = 'auto'; ctlHost.style.bottom = `${Math.max(8, ctlPos.bottom)}px`; ctlHost.style.transform = 'none'; }
    else { ctlHost.style.left = '50%'; ctlHost.style.right = 'auto'; ctlHost.style.bottom = '26px'; ctlHost.style.transform = 'translateX(-50%)'; }
  }
  function setCollapsed(on) {
    ctlCollapsed = on;
    try { sessionStorage.setItem('ra-ctl-collapsed', on ? '1' : '0'); } catch (_) {}
    if (ctlHost) ctlHost.classList.toggle('collapsed', on);
    applyPos();
  }
  function ctlSend(action) { chrome.runtime.sendMessage({ type: 'ra:ctl', action }).catch(() => {}); }
  function updateController(status) {
    if (!status) return;
    ctlStatus = status;
    if (!status.show) { hideController(); return; }
    const c = ensureController();
    ctlHost.style.display = '';
    c.left.textContent = status.left ? `${status.left} left` : '';
    c.fill.style.width = `${Math.round((status.fraction || 0) * 100)}%`;
    const st = status.waiting ? 'waiting' : status.playing ? 'playing' : 'paused';
    c.play.dataset.state = st;
    c.play.setAttribute('aria-label', st === 'playing' ? 'Pause' : 'Play');
  }
  function hideController() { if (ctlHost) ctlHost.style.display = 'none'; }

  // ---------- start-from-here resolution ----------
  function blockIndexForPoint(x, y, targetEl) {
    if (!blocks.length) buildBlocks();
    let node = null;
    try {
      const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
      if (pos) node = pos.offsetNode;
      else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); node = r && r.startContainer; }
    } catch (_) {}
    if (node) {
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].nodes.some((n) => n.node === node)) return i;
      }
    }
    return blockIndexForElement(targetEl);
  }

  function blockIndexForElement(el) {
    if (!el) return null;
    if (!blocks.length) buildBlocks();
    // Nearest block whose element is, or contains, the target, else the next block after it.
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.el === el || (b.el && b.el.contains(el))) return i;
    }
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.el && (el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING)) return i;
    }
    return null;
  }

  let contextPoint = { x: 0, y: 0 };
  document.addEventListener('contextmenu', (e) => {
    lastContextTarget = e.target;
    contextPoint = { x: e.clientX, y: e.clientY };
  }, true);

  let pickMode = false;
  document.addEventListener('click', (e) => {
    if (!(e.altKey || pickMode)) return;
    if (e.button !== 0) return;
    buildBlocks();
    const idx = blockIndexForPoint(e.clientX, e.clientY, e.target);
    if (idx === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (pickMode) setPickMode(false);
    chrome.runtime.sendMessage({ type: 'ra:altClick', blockIndex: idx }).catch(() => {});
  }, true);

  function setPickMode(on) {
    pickMode = on;
    ensureStyle();
    document.documentElement.classList.toggle('ra-pick-mode', on);
  }

  // ---------- messaging ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    switch (msg.type) {
      case 'ra:ping':
        sendResponse({ ok: true });
        return false;
      case 'ra:extract': {
        (async () => {
          try {
            const g = googleExportInfo();
            if (g) {
              generation += 1; blocks = [];
              try {
                const doc = await extractGoogle(g);
                sendResponse({ ok: true, gen: generation, ...doc });
              } catch (e) {
                // Let the panel retry the export from the extension origin.
                sendResponse({
                  ok: false,
                  error: e && e.message ? e.message : String(e),
                  googleExport: { kind: g.kind, url: location.origin + g.url, title: document.title.replace(/ - Google (Docs|Slides)$/, '') }
                });
              }
              return;
            }
            const out = buildBlocks();
            sendResponse({
              ok: true,
              gen: generation,
              kind: 'page',
              title: document.title,
              canHighlight: true,
              blocks: out.map((b) => ({ text: b.text, heading: b.heading, level: b.level || 0 }))
            });
          } catch (e) {
            sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
          }
        })();
        return true;
      }
      case 'ra:getSelection': {
        const sel = window.getSelection();
        sendResponse({ ok: true, text: sel ? sel.toString() : '' });
        return false;
      }
      case 'ra:highlight': {
        const r = highlight(msg.gen, msg.blockIndex, msg.start, msg.end, msg.word);
        if (msg.status) updateController(msg.status);
        sendResponse(r);
        return false;
      }
      case 'ra:status':
        updateController(msg.status);
        sendResponse({ ok: true });
        return false;
      case 'ra:controller':
        if (msg.on === false) hideController();
        sendResponse({ ok: true });
        return false;
      case 'ra:clear':
        clearHighlight();
        hideController();
        sendResponse({ ok: true });
        return false;
      case 'ra:resolveContextTarget': {
        buildBlocks();
        const idx = blockIndexForPoint(contextPoint.x, contextPoint.y, lastContextTarget);
        sendResponse({ blockIndex: idx });
        return false;
      }
      case 'ra:pickMode':
        setPickMode(!!msg.on);
        sendResponse({ ok: true });
        return false;
      case 'ra:isGoogle':
        sendResponse({ google: !!googleExportInfo() });
        return false;
      default:
        return false;
    }
  });
})();
