// Thin async wrappers around chrome.storage.local.
// Kept deliberately small — no dependencies, no bundler.

const DEFAULTS = {
  apiBase: 'https://app.tako.software',
  extensionToken: null,
  orgHint: null,
  enabled: true,
  // In-memory counters reset per service-worker lifetime, but we mirror
  // to storage so the popup sees a stable value.
  postsIngested: 0,
  lastSentAt: null,
  // Emergency kill switch URL (JSON: {"enabled": true, "selectors_version": N}).
  // If a content-script extraction run is unsafe (FB DOM changed), a remote
  // flip disables the extension without requiring a store update.
  killSwitchUrl: 'https://app.tako.software/extension/kill-switch.json',
};

export async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function setConfig(patch) {
  await chrome.storage.local.set(patch);
}

export async function isPaired() {
  const { extensionToken } = await getConfig();
  return !!extensionToken;
}

export async function clearPairing() {
  await chrome.storage.local.remove(['extensionToken', 'orgHint']);
}

export async function incrementIngested(n = 1) {
  const { postsIngested } = await getConfig();
  await setConfig({
    postsIngested: (postsIngested || 0) + n,
    lastSentAt: new Date().toISOString(),
  });
}

export { DEFAULTS };
