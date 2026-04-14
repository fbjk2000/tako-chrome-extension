import { getConfig, setConfig, clearPairing } from '../shared/storage.js';

const $ = (sel) => document.querySelector(sel);

// -------- Views --------

const VIEWS = ['view-pair', 'view-waiting', 'view-active'];
function show(view) {
  for (const v of VIEWS) $('#' + v).hidden = (v !== view);
}

function setStatus(kind, text) {
  const pill = $('#status-pill');
  pill.className = 'pill pill-' + kind;
  pill.textContent = text;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}
function clearError(el) {
  el.textContent = '';
  el.hidden = true;
}

// -------- API --------

async function callTako(apiBase, path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(new URL(path, apiBase).toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail;
    try { detail = (await res.json()).detail; } catch { detail = `${res.status} ${res.statusText}`; }
    throw new Error(detail || 'Request failed');
  }
  return res.json();
}

// -------- Init --------

async function init() {
  const cfg = await getConfig();
  $('#version').textContent = chrome.runtime.getManifest().version;
  $('#api-base-input').value = cfg.apiBase;
  $('#enabled-toggle').checked = !!cfg.enabled;
  $('#posts-count').textContent = cfg.postsIngested ?? 0;
  $('#last-sent').textContent = cfg.lastSentAt
    ? `last sent ${new Date(cfg.lastSentAt).toLocaleTimeString()}`
    : 'never';
  $('#org-hint').textContent = cfg.orgHint || '—';

  if (cfg.extensionToken) {
    setStatus(cfg.enabled ? 'ok' : 'warn', cfg.enabled ? 'paired' : 'paused');
    show('view-active');
  } else {
    setStatus('muted', 'not paired');
    show('view-pair');
  }
}

// -------- Pair view --------

$('#pair-btn').addEventListener('click', async () => {
  clearError($('#pair-error'));
  const userCode = $('#user-code-input').value.trim().toUpperCase().replace(/\s+/g, '-');
  const apiBase = $('#api-base-input').value.trim() || 'https://app.tako.software';
  if (!userCode) {
    showError($('#pair-error'), 'Enter the user code from Tako.');
    return;
  }
  $('#pair-btn').disabled = true;
  try {
    const result = await callTako(apiBase, '/api/extension/pair/exchange', {
      method: 'POST',
      body: { user_code: userCode },
    });
    await setConfig({ apiBase, orgHint: result.org_hint || null });
    $('#org-hint').textContent = result.org_hint || '—';
    show('view-waiting');
  } catch (err) {
    showError($('#pair-error'), err.message || 'Failed to exchange code');
  } finally {
    $('#pair-btn').disabled = false;
  }
});

// -------- Waiting view --------

$('#activate-btn').addEventListener('click', async () => {
  clearError($('#waiting-error'));
  const token = $('#token-input').value.trim();
  if (!token) {
    showError($('#waiting-error'), 'Paste the extension token shown in Tako after Confirm.');
    return;
  }
  await setConfig({ extensionToken: token, enabled: true });
  setStatus('ok', 'paired');
  show('view-active');
  $('#posts-count').textContent = '0';
  chrome.runtime.sendMessage({ type: 'pairing_complete' });
});

$('#cancel-pair-btn').addEventListener('click', () => {
  $('#user-code-input').value = '';
  $('#token-input').value = '';
  show('view-pair');
});

// -------- Active view --------

$('#enabled-toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await setConfig({ enabled });
  setStatus(enabled ? 'ok' : 'warn', enabled ? 'paired' : 'paused');
});

$('#unpair-btn').addEventListener('click', async () => {
  if (!confirm('Unpair this extension? It will stop sending posts to Tako.')) return;
  await clearPairing();
  await setConfig({ postsIngested: 0, lastSentAt: null });
  setStatus('muted', 'not paired');
  show('view-pair');
});

// -------- Live counter updates from service worker --------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'stats_updated') {
    $('#posts-count').textContent = msg.postsIngested ?? 0;
    $('#last-sent').textContent = msg.lastSentAt
      ? `last sent ${new Date(msg.lastSentAt).toLocaleTimeString()}`
      : 'never';
  }
});

init().catch((err) => {
  console.error('Tako popup init failed', err);
  setStatus('err', 'error');
});
