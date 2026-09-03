// Unabridged - text preparation: sentence splitting and spoken-form cleanup.
// Pure functions, no DOM, no chrome APIs. Shared by the panel and tests.

// ---------- sentence splitting ----------
const ABBR = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'e.g', 'i.e', 'cf', 'al',
  'inc', 'ltd', 'co', 'corp', 'llc', 'no', 'nos', 'fig', 'figs', 'approx', 'dept', 'est', 'ave',
  'blvd', 'rd', 'u.s', 'u.k', 'a.m', 'p.m', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'sept', 'oct', 'nov', 'dec', 'gen', 'col', 'lt', 'sgt', 'capt', 'rev', 'hon', 'ph.d', 'm.d', 'b.a',
  'm.a', 'vol', 'ch', 'pp', 'p', 'ed', 'eds', 'op', 'ca', 'min', 'max', 'sec', 'misc', 'govt'
]);
const MAX_UNIT = 300;

function isAbbrevBefore(text, dotIndex) {
  let k = dotIndex - 1;
  while (k >= 0 && !/\s/.test(text[k])) k--;
  let token = text.slice(k + 1, dotIndex).toLowerCase().replace(/^[("'“‘\[]+/, '');
  if (!token) return false;
  if (ABBR.has(token)) return true;
  if (/^[a-z]$/.test(token)) return true;            // initials: J. K. Rowling
  if (/^[a-z]\.[a-z]$/.test(token)) return true;      // U.S
  return false;
}

// Returns [{start, end}] offsets into `text` (raw offsets preserved).
export function splitSentences(text) {
  const out = [];
  const n = text.length;
  const push = (s, e) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ start: s, end: e });
  };
  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let j = i + 1;
      while (j < n && /[.!?…"'”’)\]]/.test(text[j])) j++;
      if (j >= n) { push(start, n); start = n; break; }
      if (/\s/.test(text[j])) {
        if (ch === '.' && isAbbrevBefore(text, i)) { i = j; continue; }
        let k = j;
        while (k < n && /\s/.test(text[k])) k++;
        if (k < n && /\p{Ll}/u.test(text[k])) { i = j; continue; }
        push(start, j);
        start = k; i = k; continue;
      }
      i = j; continue;
    }
    i++;
  }
  if (start < n) push(start, n);
  return out.flatMap((s) => splitLong(text, s.start, s.end));
}

function splitLong(text, start, end) {
  if (end - start <= MAX_UNIT) return [{ start, end }];
  const parts = [];
  let s = start;
  while (end - s > MAX_UNIT) {
    const window = text.slice(s, s + MAX_UNIT);
    let cut = -1;
    // Prefer the last clause boundary after the first 100 chars.
    const m = [...window.matchAll(/[,;:—–]\s/g)].map((x) => x.index + 1).filter((x) => x > 100);
    if (m.length) cut = m[m.length - 1];
    if (cut < 0) {
      const sp = window.lastIndexOf(' ');
      cut = sp > 60 ? sp : MAX_UNIT;
    }
    parts.push({ start: s, end: s + cut });
    s = s + cut;
    while (s < end && /\s/.test(text[s])) s++;
  }
  if (s < end) parts.push({ start: s, end });
  return parts;
}

// Build the spoken form of a raw slice plus a map spoken-index -> raw offset.
export function prepareSpoken(raw, rules) {
  const map = [];
  let text = '';
  let lastSpace = true;
  const urlRe = /(https?:\/\/|www\.)[^\s)>\]"']+/gi;
  let idx = 0;
  const segments = [];
  let m;
  while ((m = urlRe.exec(raw)) !== null) {
    if (m.index > idx) segments.push({ kind: 'text', start: idx, end: m.index });
    segments.push({ kind: 'url', start: m.index, end: m.index + m[0].length });
    idx = m.index + m[0].length;
  }
  if (idx < raw.length) segments.push({ kind: 'text', start: idx, end: raw.length });
  for (const seg of segments) {
    if (seg.kind === 'url') {
      if (!lastSpace) { text += ' '; map.push(seg.start); }
      for (const c of 'link') { text += c; map.push(seg.start); }
      lastSpace = false;
      continue;
    }
    for (let i = seg.start; i < seg.end; i++) {
      const c = raw[i];
      if (/\s/.test(c)) {
        if (!lastSpace) { text += ' '; map.push(i); lastSpace = true; }
        continue;
      }
      text += c; map.push(i); lastSpace = false;
    }
  }
  // Drop citation brackets like [12] and stray markdown emphasis characters.
  const cleaned = [];
  const cmap = [];
  const cite = /\[\d{1,3}\]/g;
  const skip = new Set();
  let cm;
  while ((cm = cite.exec(text)) !== null) for (let k = cm.index; k < cm.index + cm[0].length; k++) skip.add(k);
  for (let k = 0; k < text.length; k++) {
    if (skip.has(k)) continue;
    if (text[k] === '*' || text[k] === '_' || text[k] === '#') continue;
    cleaned.push(text[k]); cmap.push(map[k]);
  }
  // Tidy gaps left by removals: "details ." -> "details.", double spaces -> one.
  const out = []; const omap = [];
  for (let k = 0; k < cleaned.length; k++) {
    const c = cleaned[k];
    if (c === ' ') {
      const next = cleaned[k + 1];
      if (next === undefined || next === ' ' || /[.,;:!?)\]]/.test(next)) continue;
      if (!out.length) continue;
    }
    out.push(c); omap.push(cmap[k]);
  }
  if (rules && rules.length) return applyRules(out.join(''), omap, rules);
  return { text: out.join(''), map: omap };
}

// Pronunciation rules: [{from, to}] applied on whole words, case-insensitive.
// Replacement characters map back to the start of the original span so the
// page highlight still lands on the right word.
export function applyRules(text, map, rules) {
  let t = text, m = map;
  for (const r of rules) {
    const from = String(r.from || '').trim();
    const to = String(r.to || '').trim();
    if (!from || !to) continue;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc})(?![\\p{L}\\p{N}])`, 'giu');
    let out = '', omap = [], last = 0, hit;
    while ((hit = re.exec(t)) !== null) {
      const start = hit.index + hit[1].length;
      const end = start + hit[2].length;
      out += t.slice(last, start); omap.push(...m.slice(last, start));
      for (const c of to) { out += c; omap.push(m[start]); }
      last = end;
      re.lastIndex = end;
    }
    if (last === 0) continue;
    out += t.slice(last); omap.push(...m.slice(last));
    t = out; m = omap;
  }
  return { text: t, map: m };
}

