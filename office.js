// Unabridged - Microsoft Office (PowerPoint for the web) support.
// PowerPoint Online draws the deck inside a cross-origin editor frame, so the
// page's own DOM holds no slide text. Instead, like the Google Slides export,
// we download the .pptx the tab points at and read the slide XML directly.
// Pure logic plus fetch: no chrome APIs. Loaded as a classic content script
// (before content.js) and imported by the panel as a fallback, so everything
// hangs off globalThis.UnabridgedOffice.

(() => {
  if (globalThis.UnabridgedOffice) return;

  const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const SKIP_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr']);
  const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle']);

  // ---------- which tabs are PowerPoint, and where the file downloads from ----------
  function isSharePointHost(host) { return /(^|\.)sharepoint\.com$/i.test(host); }

  function officeInfo(href, docTitle) {
    let u;
    try { u = new URL(href); } catch (_) { return null; }
    if (!isSharePointHost(u.hostname)) return null;
    const file = u.searchParams.get('file') || '';
    const title = cleanTitle(docTitle || file);
    const candidates = [];
    // 1. Sharing links: https://tenant-my.sharepoint.com/:p:/g/personal/.../<token>?e=...
    if (/^\/:p:\//i.test(u.pathname) && !/\/_layouts\//i.test(u.pathname)) {
      const d = new URL(u.origin + u.pathname);
      const e = u.searchParams.get('e');
      if (e) d.searchParams.set('e', e);
      d.searchParams.set('download', '1');
      candidates.push(d.href);
    }
    // 2. The editor page: .../_layouts/15/Doc.aspx?sourcedoc={GUID}&file=Deck.pptx
    const src = u.searchParams.get('sourcedoc') || u.searchParams.get('sourceDoc');
    const layouts = u.pathname.toLowerCase().indexOf('/_layouts/');
    if (src && layouts >= 0) {
      const guid = src.replace(/[{}]/g, '');
      const site = u.pathname.slice(0, layouts).replace(/^\/:[a-z]:\/[a-z]/i, '');
      candidates.push(`${u.origin}${site}/_layouts/15/download.aspx?UniqueId=${encodeURIComponent(guid)}`);
    }
    // 3. A direct file URL: .../Shared Documents/Deck.pptx?web=1
    if (/\.pptx$/i.test(u.pathname)) {
      const d = new URL(u.origin + u.pathname);
      d.searchParams.set('download', '1');
      candidates.push(d.href);
    }
    if (!candidates.length) return null;
    if (file && !/\.pptx?$/i.test(file)) return null; // a Word or Excel file in the same editor
    const isPpt = /^\/:p:\//i.test(u.pathname) || /\.pptx?$/i.test(file) || /\.pptx$/i.test(u.pathname) || /\.pptx?\b/i.test(docTitle || '');
    if (!isPpt) return null;
    if (/\.ppt$/i.test(file)) return { kind: 'pptx', title, candidates: [], legacy: true };
    return { kind: 'pptx', title, candidates };
  }

  function cleanTitle(t) {
    return String(t || '')
      .replace(/\s*[-|]\s*(Microsoft )?PowerPoint( Online| for the web)?\s*$/i, '')
      .replace(/\.pptx?$/i, '')
      .replace(/_/g, ' ')
      .trim() || 'PowerPoint deck';
  }

  // ---------- download ----------
  async function download(info) {
    let lastErr = '';
    for (const url of info.candidates) {
      try {
        const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
        if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
        const buf = await res.arrayBuffer();
        const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
        if (b[0] === 0x50 && b[1] === 0x4b) return buf; // "PK": a zip, so a real .pptx
        lastErr = 'the server returned a web page instead of the file';
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
      }
    }
    throw new Error(`Could not download this deck to read it (${lastErr || 'no download link'}). If the owner blocked downloads, select the slide text and use Read the selection.`);
  }

  // ---------- minimal zip reader (stored + deflate) ----------
  async function unzip(buf, wanted) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This file is not a readable .pptx.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(buf, p + 46, nlen));
      entries.set(name, { method, csize, off });
      p += 46 + nlen + xlen + clen;
    }
    const out = new Map();
    for (const name of entries.keys()) {
      if (!wanted(name)) continue;
      const e = entries.get(name);
      const lnlen = dv.getUint16(e.off + 26, true);
      const lxlen = dv.getUint16(e.off + 28, true);
      const data = new Uint8Array(buf, e.off + 30 + lnlen + lxlen, e.csize);
      let bytes;
      if (e.method === 0) bytes = data;
      else if (e.method === 8) {
        const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        bytes = new Uint8Array(await new Response(ds).arrayBuffer());
      } else continue;
      out.set(name, dec.decode(bytes));
    }
    return out;
  }

  // ---------- slide XML to readable blocks ----------
  const kids = (el, ns, local) => Array.from(el.childNodes).filter((c) => c.nodeType === 1 && c.localName === local && (!ns || c.namespaceURI === ns));
  const kid = (el, ns, local) => kids(el, ns, local)[0] || null;
  function descendants(el, ns, local) {
    const out = [];
    const all = el.getElementsByTagNameNS(ns, local);
    for (let i = 0; i < all.length; i++) out.push(all[i]);
    return out;
  }

  function paragraphText(p) {
    let s = '';
    const walk = (n) => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType !== 1) continue;
        if (c.namespaceURI === NS_A && c.localName === 't') s += c.textContent;
        else if (c.namespaceURI === NS_A && c.localName === 'br') s += ' ';
        else walk(c);
      }
    };
    walk(p);
    return s.replace(/\s+/g, ' ').trim();
  }

  function placeholderType(shape) {
    const ph = descendants(shape, NS_P, 'ph')[0];
    if (!ph) return null;
    return ph.getAttribute('type') || 'body';
  }

  function offsetOf(shape) {
    const off = descendants(shape, NS_A, 'off')[0];
    if (!off) return null;
    return { x: Number(off.getAttribute('x')) || 0, y: Number(off.getAttribute('y')) || 0 };
  }

  // One slide: title first, then the other shapes top to bottom, left to right.
  function readSlide(doc) {
    const tree = descendants(doc, NS_P, 'spTree')[0];
    if (!tree) return { title: '', paras: [] };
    const shapes = [];
    Array.from(tree.childNodes).forEach((c, i) => {
      if (c.nodeType !== 1) return;
      if (!['sp', 'grpSp', 'graphicFrame'].includes(c.localName)) return;
      const ph = placeholderType(c);
      if (ph && SKIP_PLACEHOLDERS.has(ph)) return;
      const paras = descendants(c, NS_A, 'p').map(paragraphText).filter((t) => /[\p{L}\p{N}]/u.test(t));
      if (!paras.length) return;
      shapes.push({ i, paras, isTitle: !!ph && TITLE_PLACEHOLDERS.has(ph), off: offsetOf(c) });
    });
    const titles = shapes.filter((s) => s.isTitle);
    const rest = shapes.filter((s) => !s.isTitle);
    const ROW = 182880; // 0.2 inch: shapes this close vertically count as one row
    // Placeholders often inherit their position from the layout, so a slide
    // can mix shapes with and without offsets. Sort only when every shape has
    // one; otherwise the author's own order is the safer reading order.
    if (rest.every((s) => s.off)) rest.sort((a, b) => {
      if (Math.abs(a.off.y - b.off.y) > ROW) return a.off.y - b.off.y;
      if (a.off.x !== b.off.x) return a.off.x - b.off.x;
      return a.i - b.i;
    });
    const title = titles.map((s) => s.paras.join(' ')).join(' ').trim();
    const paras = [...titles, ...rest].flatMap((s) => s.paras);
    return { title, paras };
  }

  function resolveTarget(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/'); parts.pop();
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }

  async function parsePptx(buf, opts = {}) {
    const parseXml = opts.parseXml || ((s) => new DOMParser().parseFromString(s, 'application/xml'));
    const files = await unzip(buf, (n) => n === 'ppt/presentation.xml' || n === 'ppt/_rels/presentation.xml.rels' || /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const pres = files.get('ppt/presentation.xml');
    const rels = files.get('ppt/_rels/presentation.xml.rels');
    if (!pres || !rels) throw new Error('This file is not a readable .pptx.');
    const relMap = new Map();
    for (const r of descendants(parseXml(rels), '*', 'Relationship')) relMap.set(r.getAttribute('Id'), r.getAttribute('Target'));
    const presDoc = parseXml(pres);
    const order = descendants(presDoc, NS_P, 'sldId').map((s) => {
      const rid = s.getAttributeNS(NS_R, 'id') || s.getAttribute('r:id');
      const t = relMap.get(rid);
      return t ? resolveTarget('ppt/presentation.xml', t) : null;
    }).filter(Boolean);
    // Slide numbers match PowerPoint's own, so hidden slides keep their number
    // even though they are skipped, the way a slideshow skips them.
    const total = order.length;
    const blocks = [];
    let shown = 0;
    order.forEach((path, i) => {
      const xml = files.get(path);
      if (!xml) return;
      const doc = parseXml(xml);
      const root = doc.documentElement;
      if (root && root.getAttribute('show') === '0' && !opts.includeHidden) return;
      const s = readSlide(doc);
      const n = i + 1;
      shown += 1;
      blocks.push({ text: `Slide ${n} of ${total}`, silent: true, chapter: s.title ? `Slide ${n} · ${s.title}` : `Slide ${n}` });
      for (const t of s.paras) blocks.push({ text: t, heading: false });
    });
    return { slides: shown, total, blocks };
  }

  async function extract(info) {
    if (info.legacy) throw new Error('This is an old .ppt file. Unabridged reads .pptx decks; select the slide text and use Read the selection.');
    const buf = await download(info);
    const { slides, blocks } = await parsePptx(buf);
    if (!blocks.some((b) => !b.silent)) throw new Error('This deck has no readable text on its slides (it may be all images).');
    return { kind: 'pptx', title: info.title, canHighlight: false, pages: slides, blocks };
  }

  globalThis.UnabridgedOffice = { officeInfo, extract, parsePptx, cleanTitle };
})();
