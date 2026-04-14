// Tako Listener — content script
// Scope: observe posts on Facebook Group / permalink pages the user is already
// viewing and forward {post_url, author, text, timestamp} to the background
// service worker. No writes, no clicks, no DM/message access.
//
// Selectors are deliberately fuzzy: we key on aria-labels and feed role
// attributes that change less often than class hashes. When they drift, the
// remote kill switch (checked by the background worker) disables ingestion
// until we ship a selectors bump.

(() => {
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log('[tako]', ...a); };

  // De-dupe window. Posts stay in the DOM as the user scrolls; we only emit
  // each permalink once per page visit.
  const seen = new Set();

  // Batch posts for 1 second before flushing, up to 20 at a time.
  const FLUSH_MS = 1000;
  const BATCH_MAX = 20;
  let queue = [];
  let flushTimer = null;

  // --- source context from URL --------------------------------------------

  function sourceContext() {
    const { href, pathname } = window.location;
    const groupMatch = pathname.match(/^\/groups\/([^/?#]+)/);
    if (groupMatch) {
      const titleEl = document.querySelector('h1');
      return {
        type: 'fb_group',
        url: `https://www.facebook.com/groups/${groupMatch[1]}`,
        name: titleEl ? titleEl.textContent.trim() : groupMatch[1],
      };
    }
    return {
      type: 'fb_page',
      url: href,
      name: document.title.replace(/\s*\|\s*Facebook.*$/i, '').trim(),
    };
  }

  // --- post extraction ------------------------------------------------------

  // Feed role attribute is stable across FB DOM refactors — it's what screen
  // readers use.
  function* candidateFeedContainers() {
    // Top-level feed(s)
    for (const el of document.querySelectorAll('[role="feed"]')) yield el;
  }

  // A single post = descendant with role="article".
  function extractPost(articleEl) {
    try {
      // Permalink: the first anchor whose href contains /posts/, /permalink/,
      // or /groups/.../posts/... is the post URL.
      const anchors = articleEl.querySelectorAll('a[href]');
      let permalink = null;
      for (const a of anchors) {
        const h = a.getAttribute('href') || '';
        if (/\/(posts|permalink|groups)\//.test(h) && /\/\d/.test(h)) {
          permalink = new URL(h, window.location.origin).toString().split('?')[0];
          break;
        }
      }
      if (!permalink) return null;

      // external_post_id: stable hash of permalink.
      const external_post_id = permalink.replace(/\/$/, '');

      // Author: the first anchor inside an h2/h3/h4 strong block.
      let authorName = '';
      let authorUrl = '';
      const authorNode = articleEl.querySelector('h2 a, h3 a, h4 a, strong a');
      if (authorNode) {
        authorName = authorNode.textContent.trim();
        authorUrl = new URL(authorNode.getAttribute('href'), window.location.origin).toString().split('?')[0];
      }

      // Post text. Facebook renders post bodies inside `[data-ad-preview="message"]`
      // or nested <div dir="auto"> elements. We concatenate all dir=auto spans
      // that aren't inside comment threads (marked role="article" themselves).
      const bodyRoot = articleEl.querySelector('[data-ad-preview="message"]')
        || articleEl.querySelector('[data-ad-rendering-role="story_message"]')
        || articleEl;
      const text = Array.from(bodyRoot.querySelectorAll('[dir="auto"]'))
        .filter((n) => !n.closest('[role="article"] [role="article"]'))
        .map((n) => n.innerText.trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, 5000);

      if (!text) return null;

      // Timestamp: FB renders a relative time string in an <a> with aria-label
      // holding the absolute timestamp. We fall back to `new Date()` if absent.
      let timestamp = null;
      const timeLink = articleEl.querySelector('a[aria-label][role="link"][href*="/posts/"], a[aria-label][href*="/permalink/"]');
      if (timeLink) {
        const label = timeLink.getAttribute('aria-label');
        const parsed = label ? new Date(label) : null;
        if (parsed && !isNaN(parsed.getTime())) timestamp = parsed.toISOString();
      }
      if (!timestamp) timestamp = new Date().toISOString();

      return {
        external_post_id,
        url: permalink,
        author: { name: authorName, profile_url: authorUrl },
        text,
        timestamp,
      };
    } catch (err) {
      log('extractPost failed', err);
      return null;
    }
  }

  // --- batching / flush -----------------------------------------------------

  function enqueue(post) {
    if (seen.has(post.external_post_id)) return;
    seen.add(post.external_post_id);
    queue.push(post);
    if (queue.length >= BATCH_MAX) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (queue.length === 0) return;
    const payload = {
      source: sourceContext(),
      observed_at: new Date().toISOString(),
      posts: queue.splice(0, queue.length),
    };
    chrome.runtime.sendMessage({ type: 'ingest_posts', payload }, (ack) => {
      if (chrome.runtime.lastError) {
        log('sendMessage error', chrome.runtime.lastError);
      } else {
        log('flush acked', ack);
      }
    });
  }

  // --- observation loop -----------------------------------------------------

  function scan(root = document) {
    for (const feed of candidateFeedContainers()) {
      for (const article of feed.querySelectorAll('[role="article"]')) {
        // Skip nested comment articles (they're children of another article).
        if (article.parentElement?.closest('[role="article"]')) continue;
        const post = extractPost(article);
        if (post) enqueue(post);
      }
    }
  }

  let observer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      // Cheap filter: only scan if feed nodes were added.
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            scan(n.parentNode || document);
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    log('observer started');
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; log('observer stopped'); }
  }

  // --- kill switch / enabled state ----------------------------------------

  async function isEnabled() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'should_ingest' }, (res) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(!!res?.ok);
      });
    });
  }

  // React to enable/disable flips from the popup.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ingestion_state') {
      if (msg.enabled) { scan(); startObserver(); }
      else { stopObserver(); queue = []; seen.clear(); }
    }
  });

  // Re-check on SPA navigation (FB uses pushState).
  let lastPath = window.location.pathname;
  setInterval(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      seen.clear();
      queue = [];
      isEnabled().then((ok) => { if (ok) scan(); });
    }
  }, 2000);

  // Flush buffered posts if the tab becomes hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  // Boot.
  isEnabled().then((ok) => {
    if (!ok) return;
    scan();
    startObserver();
  });
})();
