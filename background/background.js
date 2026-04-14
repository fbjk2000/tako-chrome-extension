// Tako Listener — background service worker
// Responsibilities:
//  1. Gate ingestion on (paired + enabled + kill-switch-OK).
//  2. Forward batches from the content script to Tako's webhook endpoint.
//  3. Per-org rate limit (local token bucket) so a runaway content script
//     can't blow up Tako's ingestion quota.
//  4. Poll the remote kill-switch URL once per hour.

import { getConfig, setConfig, incrementIngested } from '../shared/storage.js';

// ---- Remote kill switch ----------------------------------------------------

let killSwitch = { enabled: true, checked_at: 0 };
const KILL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h

async function refreshKillSwitch() {
  const { killSwitchUrl } = await getConfig();
  if (!killSwitchUrl) return;
  try {
    const res = await fetch(killSwitchUrl, { cache: 'no-store' });
    if (!res.ok) return; // Leave previous state; better than thrashing.
    const data = await res.json();
    killSwitch = {
      enabled: data.enabled !== false,     // Default to enabled if field absent.
      checked_at: Date.now(),
    };
  } catch (err) {
    console.warn('[tako] kill-switch fetch failed', err);
  }
}
chrome.alarms.create('tako-kill-switch', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tako-kill-switch') refreshKillSwitch();
});
refreshKillSwitch();

// ---- Rate limit: token bucket per service-worker lifetime ------------------

const BUCKET = {
  capacity: 120,        // 120 requests
  refillPerMinute: 60,  // ~1/s sustained
  tokens: 120,
  lastRefill: Date.now(),
};

function takeToken() {
  const now = Date.now();
  const elapsedMin = (now - BUCKET.lastRefill) / 60000;
  BUCKET.tokens = Math.min(BUCKET.capacity, BUCKET.tokens + elapsedMin * BUCKET.refillPerMinute);
  BUCKET.lastRefill = now;
  if (BUCKET.tokens < 1) return false;
  BUCKET.tokens -= 1;
  return true;
}

// ---- Ingestion gate --------------------------------------------------------

async function ingestionAllowed() {
  if (!killSwitch.enabled) return false;
  const cfg = await getConfig();
  return !!(cfg.extensionToken && cfg.enabled);
}

// ---- Webhook POST ----------------------------------------------------------

async function postIngest(payload) {
  if (!takeToken()) {
    console.warn('[tako] rate-limited locally, dropping batch');
    return { ok: false, reason: 'rate_limited' };
  }
  const { apiBase, extensionToken } = await getConfig();
  const body = { extension_token: extensionToken, ...payload };

  // We POST to the org-scoped webhook. The server resolves org_id from the
  // extension_token; the URL placeholder is accepted as `self` so the server
  // can distinguish extension traffic from Meta webhook traffic in logs.
  const url = new URL('/api/webhooks/chrome_extension/self', apiBase).toString();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[tako] ingest rejected', res.status, text.slice(0, 200));
      return { ok: false, reason: 'http_' + res.status };
    }
    const data = await res.json().catch(() => ({}));
    await incrementIngested(payload.posts?.length || 0);
    const cfg = await getConfig();
    // Notify popup if open (fire-and-forget).
    try {
      chrome.runtime.sendMessage({
        type: 'stats_updated',
        postsIngested: cfg.postsIngested,
        lastSentAt: cfg.lastSentAt,
      });
    } catch {}
    return { ok: true, inserted: data.inserted ?? payload.posts?.length ?? 0 };
  } catch (err) {
    console.warn('[tako] ingest network error', err);
    return { ok: false, reason: 'network' };
  }
}

// ---- Message handlers ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'should_ingest') {
      sendResponse({ ok: await ingestionAllowed() });
      return;
    }
    if (msg?.type === 'ingest_posts') {
      const allowed = await ingestionAllowed();
      if (!allowed) { sendResponse({ ok: false, reason: 'disabled' }); return; }
      const result = await postIngest(msg.payload);
      sendResponse(result);
      return;
    }
    if (msg?.type === 'pairing_complete') {
      // Refresh kill-switch on pairing so the new session starts clean.
      refreshKillSwitch();
      // Tell all FB tabs to re-check and start ingesting.
      broadcast({ type: 'ingestion_state', enabled: true });
      sendResponse({ ok: true });
      return;
    }
  })();
  return true; // keep the channel open for the async sendResponse above
});

// Propagate popup-toggled enable state to FB tabs so they flip immediately
// instead of on their next 2s poll.
chrome.storage.onChanged.addListener((changes) => {
  if ('enabled' in changes) {
    broadcast({ type: 'ingestion_state', enabled: !!changes.enabled.newValue });
  }
  if ('extensionToken' in changes && !changes.extensionToken.newValue) {
    broadcast({ type: 'ingestion_state', enabled: false });
  }
});

async function broadcast(message) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://www.facebook.com/*', 'https://m.facebook.com/*'] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch (err) {
    console.warn('[tako] broadcast failed', err);
  }
}

// First run: seed defaults.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Ensure defaults land in storage the first time.
    await setConfig({});
  }
});
