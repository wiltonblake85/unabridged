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
    out.push({ el, nodes, text: raw, heading: HEADING_TAGS.has(el.tagName) });
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
      ::highlight(${HIGHLIGHT_NAME}) { background-color: rgba(255, 214, 10, 0.45); color: inherit; }
      ::highlight(${HIGHLIGHT_WORD}) { background-color: rgba(255, 140, 0, 0.75); color: inherit; }
      .ra-current-block { outline: 3px solid rgba(255, 214, 10, 0.9) !important; outline-offset: 3px; background-color: rgba(255, 214, 10, 0.18) !important; }
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
              blocks: out.map((b) => ({ text: b.text, heading: b.heading }))
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
        sendResponse(r);
        return false;
      }
      case 'ra:clear':
        clearHighlight();
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
