// Unabridged, toolbar popup. Glanceable status and transport without opening
// the side panel. The panel (or reader) owns playback; this only asks and asks.

const $ = (id) => document.getElementById(id);
const els = { ringFill: $('ringFill'), btnPlay: $('btnPlay'), npTitle: $('npTitle'), npMin: $('npMin'), strip: $('strip'), btnPrev: $('btnPrev'), btnNext: $('btnNext'), btnMain: $('btnMain') };
const RING_C = 163.4;
let loaded = false;
let lastChapters = '';

function render(s) {
  loaded = !!(s && s.ok && s.loaded);
  if (!loaded) {
    els.ringFill.style.strokeDashoffset = String(RING_C);
    els.btnPlay.dataset.state = 'stopped';
    els.btnPlay.setAttribute('aria-label', 'Read this page');
    els.npTitle.textContent = 'Nothing playing';
    els.npMin.textContent = 'Open a page, doc, or PDF and press play';
    els.strip.innerHTML = '';
    els.btnMain.textContent = 'Read this page';
    els.btnPrev.disabled = true; els.btnNext.disabled = true;
    return;
  }
  els.btnPrev.disabled = false; els.btnNext.disabled = false;
  els.ringFill.style.strokeDashoffset = (RING_C * (1 - s.fraction)).toFixed(1);
  els.btnPlay.dataset.state = s.state;
  els.btnPlay.setAttribute('aria-label', s.state === 'playing' ? 'Pause' : 'Play');
  els.btnPlay.setAttribute('aria-pressed', String(s.state === 'playing'));
  els.npTitle.textContent = s.title;
  els.npTitle.title = s.title;
  els.npMin.textContent = `${s.left} left · ${s.rate}`;
  els.btnMain.textContent = 'Open the panel';
  const sig = s.chapters.map((c) => c.flex).join(',');
  if (sig !== lastChapters) {
    lastChapters = sig;
    els.strip.innerHTML = '';
    for (const c of s.chapters) {
      const d = document.createElement('div');
      d.className = 'seg-ch';
      d.style.flex = String(c.flex);
      const inner = document.createElement('div'); inner.className = 'inner'; d.appendChild(inner);
      els.strip.appendChild(d);
    }
  }
  s.chapters.forEach((c, i) => {
    const d = els.strip.children[i]; if (!d) return;
    d.className = `seg-ch ${c.state}`;
    d.querySelector('.inner').style.width = `${c.fill}%`;
  });
}

async function ask() {
  try { render(await chrome.runtime.sendMessage({ type: 'ra:status?' })); } catch (_) { render(null); }
}
async function send(action) {
  try { await chrome.runtime.sendMessage({ type: 'ra:panel', payload: { action, ts: Date.now() } }); } catch (_) {}
  setTimeout(ask, 120);
}
async function openPanel() {
  const w = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: w.id });
}
async function readThisPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openPanel();
  const pending = { action: 'readTab', tabId: tab ? tab.id : null, blockIndex: null, ts: Date.now() };
  await chrome.storage.session.set({ pending });
  try { await chrome.runtime.sendMessage({ type: 'ra:panel', payload: pending }); } catch (_) {}
  window.close();
}

els.btnPlay.addEventListener('click', () => { if (loaded) send('togglePlay'); else readThisPage(); });
els.btnPrev.addEventListener('click', () => send('prev'));
els.btnNext.addEventListener('click', () => send('next'));
els.btnMain.addEventListener('click', async () => { if (loaded) { await openPanel(); window.close(); } else readThisPage(); });

ask();
setInterval(ask, 800);
