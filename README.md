# Tako Listener — Chrome extension

Companion extension for [Tako CRM](https://tako.software) Listener campaigns. Observes Facebook Group and Page posts you're already viewing in your browser and forwards them to your Tako org as campaign signals.

## Principles

- **Read-only.** The extension never posts, comments, reacts, messages, joins groups, or sends friend requests. Every engagement action happens in your Facebook UI, by you.
- **No scraping of content you can't already see.** The content script runs only on pages you open. It does not open tabs, navigate, log in, or bypass any UI.
- **No DMs, no private profile data.** Content-script matchers are scoped to feed articles (`[role="feed"] [role="article"]`). Messages and profile-only content are never read.
- **Kill-switch first.** The background worker hits a remote JSON endpoint hourly; if disabled, no batches are sent — even when paired.

## Repo layout

```
manifest.json              Manifest V3
popup/                     Pairing + status UI
  popup.html
  popup.css
  popup.js
content/
  content.js               MutationObserver on FB feed, extracts posts
background/
  background.js            Service worker: gate, POST, rate limit, kill switch
shared/
  storage.js               chrome.storage.local wrappers with defaults
assets/                    Icons (16 / 48 / 128 png) — add your brand marks here
```

## Pairing flow

Implements Tako's device-code pairing (see `tako-core` spec §L5 and the API contract in `backend/listeners/pairing.py`):

1. In Tako, open **Settings → Integrations → Pair extension**. Tako shows a 4-letter user code.
2. In the extension popup, paste the user code and click **Pair**. The extension calls `POST /api/extension/pair/exchange`.
3. Return to Tako and click **Confirm pairing**. Tako displays the long-lived `extension_token`.
4. Paste the token into the extension's second step and click **Activate**.

After activation, the extension stores the token in `chrome.storage.local` and starts ingesting. You can pause or unpair anytime from the popup.

## Ingestion contract

Every batch POSTs to:

```
POST {apiBase}/api/webhooks/chrome_extension/self
Content-Type: application/json

{
  "extension_token": "ext_…",
  "source": { "type": "fb_group|fb_page", "url": "…", "name": "…" },
  "observed_at": "ISO-8601",
  "posts": [
    {
      "external_post_id": "https://facebook.com/groups/.../posts/…",
      "url": "same",
      "author": { "name": "…", "profile_url": "…" },
      "text": "…",
      "timestamp": "ISO-8601"
    }
  ]
}
```

Batches: up to 20 posts, flushed every 1 s or on `visibilitychange: hidden`.
Local rate limit: 60 req/min sustained, 120 burst (token bucket in the service worker).

## Kill switch

The background worker fetches `https://app.tako.software/extension/kill-switch.json` every hour. Expected shape:

```json
{ "enabled": true, "selectors_version": 1, "reason": "" }
```

Setting `enabled: false` stops all ingestion across installed extensions within one hour, without requiring a Chrome Web Store update. Use this when Facebook's DOM changes break `content.js` selectors.

## Install (developer mode)

1. `git clone` this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** → select the repo root.
4. Pin the extension and click it to pair.

## Selectors fragility (planned hardening)

The content script keys off `[role="feed"]` and `[role="article"]` — accessibility roles that Meta rarely changes. Permalink detection falls back across `/posts/`, `/permalink/`, and group-scoped `/groups/.../posts/` patterns. When selectors do drift:

1. Flip the remote kill switch.
2. Bump `manifest.json` version + `selectors_version` in the kill-switch payload.
3. Ship a patched `content/content.js`.

Future: move selectors to a remote-fetched JSON so a server-side bump re-enables parsing without a store re-review. Out of scope for v0.1.

## Store listing / privacy

- Privacy policy: [tako.software/privacy](https://tako.software/privacy) (Meta-data section is mandatory for app review).
- Data deletion: [tako.software/data-deletion](https://tako.software/data-deletion).
- This source tree is intended to be open-source-auditable. Keep `background.js` free of bundled/minified code so reviewers can verify the extension does what this README claims.

## License

TBD — keep source open-auditable either way (MIT or Apache-2.0 both fine).
