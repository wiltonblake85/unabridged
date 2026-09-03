// Unabridged - background service worker.
// Owns: context menus, keyboard commands, opening the side panel, and the
// "pending request" handoff used when the panel is not open yet.

const MENU_FROM_HERE = 'ra-read-from-here';
const MENU_SELECTION = 'ra-read-selection';
const MENU_PAGE = 'ra-read-page';
const MENU_QUEUE_PAGE = 'ra-queue-page';
const MENU_QUEUE_LINK = 'ra-queue-link';
const MENU_READER = 'ra-open-reader';

chrome.runtime.onInstalled.addListener(() => {
  // The toolbar icon opens the popup (manifest action.default_popup); the popup opens the panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_FROM_HERE,
      title: 'Read aloud from here',
      contexts: ['page', 'frame', 'link', 'image', 'editable']
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: 'Read selection aloud',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: 'Read this whole page aloud',
      contexts: ['page', 'frame', 'link', 'image', 'editable', 'selection']
    });
    chrome.contextMenus.create({
      id: MENU_QUEUE_PAGE,
      title: 'Add this page to the Unabridged queue',
      contexts: ['page', 'frame', 'image', 'editable', 'selection']
    });
    chrome.contextMenus.create({
      id: MENU_QUEUE_LINK,
      title: 'Add link to the Unabridged queue',
      contexts: ['link']
    });
    chrome.contextMenus.create({
      id: MENU_READER,
      title: 'Open in the Unabridged reader',
      contexts: ['page', 'frame', 'selection', 'editable', 'image']
    });
  });
  updateBadge();
});

// ---------- reading queue ----------
async function queueAdd(url, title) {
  if (!url || /^(chrome|edge|about|chrome-extension|javascript):/i.test(url)) return false;
  const { queue = [] } = await chrome.storage.local.get('queue');
  if (queue.some((q) => q.url === url)) return false;
  queue.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, url, title: title || url, addedAt: Date.now() });
  await chrome.storage.local.set({ queue });
  return true;
}
async function updateBadge() {
  try {
    const { queue = [] } = await chrome.storage.local.get('queue');
    await chrome.action.setBadgeBackgroundColor({ color: '#c67139' });
    await chrome.action.setBadgeText({ text: queue.length ? String(queue.length) : '' });
  } catch (_) {}
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.queue) updateBadge(); });
chrome.runtime.onStartup.addListener(updateBadge);

// Store a request the panel should act on as soon as it is listening.
async function setPending(pending) {
  await chrome.storage.session.set({ pending: { ...pending, ts: Date.now() } });
}

// Try the live channel first (panel already open); always leave the pending
// record too, so a panel that is still loading picks it up.
async function dispatchToPanel(message) {
  const stamped = { ...message, ts: Date.now() };
  await chrome.storage.session.set({ pending: stamped });
  try {
    await chrome.runtime.sendMessage({ type: 'ra:panel', payload: stamped });
  } catch (_) {
    // No panel listening yet. The pending record covers it.
  }
}

async function openPanel(tab) {
  try {
    if (tab && tab.windowId !== undefined) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {
    // Not a user gesture in this context; the toolbar icon still opens it.
    try { await chrome.action.setBadgeText({ text: '▶' }); } catch (_) {}
    setTimeout(updateBadge, 8000);
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id === undefined) return;
  if (info.menuItemId === MENU_QUEUE_PAGE || info.menuItemId === MENU_QUEUE_LINK) return;
  if (info.menuItemId === MENU_READER) { await chrome.tabs.create({ url: chrome.runtime.getURL(`reader.html?tab=${tab.id}`), active: true }); return; }
  await openPanel(tab);
  if (info.menuItemId === MENU_FROM_HERE) {
    // Ask the content script which block was right-clicked. It replies through
    // runtime.sendMessage({type:'ra:startAt'}) so the panel can pick it up.
    let blockIndex = null;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'ra:resolveContextTarget' });
      if (res && typeof res.blockIndex === 'number') blockIndex = res.blockIndex;
    } catch (_) {}
    await dispatchToPanel({ action: 'readTab', tabId: tab.id, blockIndex });
  } else if (info.menuItemId === MENU_SELECTION) {
    await dispatchToPanel({ action: 'readSelection', tabId: tab.id, fallbackText: info.selectionText || '' });
  } else if (info.menuItemId === MENU_PAGE) {
    await dispatchToPanel({ action: 'readTab', tabId: tab.id, blockIndex: 0 });
  }
});

// Queue menu items do not need the panel open.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_QUEUE_PAGE && tab) await queueAdd(tab.url, tab.title);
  else if (info.menuItemId === MENU_QUEUE_LINK && info.linkUrl) await queueAdd(info.linkUrl, info.linkUrl.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80));
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = active;
  }
  if (!tab) return;
  if (command === 'play-pause') {
    // If the panel is open it toggles. If not, open it and start reading.
    let delivered = false;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ra:panel', payload: { action: 'togglePlay', tabId: tab.id } });
      delivered = !!(res && res.ok);
    } catch (_) {}
    if (!delivered) {
      await openPanel(tab);
      await setPending({ action: 'readTab', tabId: tab.id, blockIndex: null });
    }
  } else if (command === 'read-selection') {
    await openPanel(tab);
    await dispatchToPanel({ action: 'readSelection', tabId: tab.id, fallbackText: '' });
  } else if (command === 'prev-sentence' || command === 'next-sentence') {
    try {
      await chrome.runtime.sendMessage({ type: 'ra:panel', payload: { action: command === 'prev-sentence' ? 'prev' : 'next' } });
    } catch (_) {}
  }
});

// Messages from content scripts (Option+click on a paragraph).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ra:altClick' && sender.tab) {
    (async () => {
      await openPanel(sender.tab);
      await dispatchToPanel({ action: 'readTab', tabId: sender.tab.id, blockIndex: msg.blockIndex });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg && msg.type === 'ra:clearBadge') {
    updateBadge();
  }
  // The floating controller on the page talks to whichever surface owns playback.
  if (msg && msg.type === 'ra:ctl' && sender.tab) {
    (async () => {
      let delivered = false;
      try { const res = await chrome.runtime.sendMessage({ type: 'ra:panel', payload: { action: msg.action, tabId: sender.tab.id, ts: Date.now() } }); delivered = !!(res && res.ok); } catch (_) {}
      if (!delivered && msg.action === 'togglePlay') { await openPanel(sender.tab); await setPending({ action: 'readTab', tabId: sender.tab.id, blockIndex: null }); }
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});
