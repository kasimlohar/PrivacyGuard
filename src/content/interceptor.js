/**
 * PrivacyGuard — Network Interceptor
 *
 * Runs in the MAIN world and acts as the final enforcement layer.
 *
 * Enforcement policy:
 *   - Injection in extracted user text -> block
 *   - PII in extracted user text + autoProtect -> mask and forward
 *   - Otherwise -> allow unchanged
 *
 * Safety rules:
 *   - Detect only on extracted user input, not entire payload blobs.
 *   - Preserve request structure; mutate only targeted text leaves.
 *   - Prefer allow-over-block when payload cannot be parsed safely.
 */

(function PrivacyGuardInterceptor() {
  if (window.__PG_INTERCEPTOR_ACTIVE) return;
  window.__PG_INTERCEPTOR_ACTIVE = true;

  const TAG = '[PrivacyGuard]';
  const MSG_SOURCE = 'PRIVACYGUARD';
  const MSG_BYPASS_ONCE = 'PG_BYPASS_ONCE';
  const DEFAULT_BYPASS_TTL_MS = 5000;

  const bypassState = {
    remaining: 0,
    expiresAt: 0,
  };

  function grantBypassOnce(ttlMs) {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_BYPASS_TTL_MS;
    bypassState.remaining = 1;
    bypassState.expiresAt = Date.now() + ttl;
    console.log(`${TAG} Interceptor bypass armed`, { ttlMs: ttl });
  }

  function consumeBypassOnce() {
    if (bypassState.remaining <= 0) return false;
    if (Date.now() > bypassState.expiresAt) {
      bypassState.remaining = 0;
      return false;
    }
    bypassState.remaining -= 1;
    return true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MSG_SOURCE) return;
    if (data.type === MSG_BYPASS_ONCE) {
      grantBypassOnce(data.ttlMs);
    }
  });

  function isAutoProtectEnabled() {
    // Defaults to true if unset.
    return window.__PG_AUTO_PROTECT !== false;
  }

  function safeJsonParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, value: null };
    }
  }

  function tryStringifyJson(payload) {
    try {
      return { ok: true, text: JSON.stringify(payload) };
    } catch {
      return { ok: false, text: '' };
    }
  }

  function looksLikeJson(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trimStart();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
  }

  function scanText(text) {
    if (typeof text !== 'string' || text.length < 5) {
      return { hasInjection: false, hasPII: false, maskedText: text, changed: false };
    }

    const injectionResults = typeof scanForInjection === 'function'
      ? scanForInjection(text)
      : [];
    if (injectionResults.length > 0) {
      return { hasInjection: true, hasPII: false, maskedText: text, changed: false };
    }

    const piiResults = typeof scanForPII === 'function'
      ? scanForPII(text)
      : [];
    if (piiResults.length === 0) {
      return { hasInjection: false, hasPII: false, maskedText: text, changed: false };
    }

    if (!isAutoProtectEnabled() || typeof maskAll !== 'function') {
      return { hasInjection: false, hasPII: true, maskedText: text, changed: false };
    }

    const maskedText = maskAll(text, piiResults);
    return {
      hasInjection: false,
      hasPII: true,
      maskedText,
      changed: maskedText !== text,
    };
  }

  function createRefCollector() {
    const refs = [];
    const seen = new WeakMap();

    function pushRef(container, key) {
      if (!container || typeof container !== 'object') return;
      if (typeof container[key] !== 'string') return;

      let keys = seen.get(container);
      if (!keys) {
        keys = new Set();
        seen.set(container, keys);
      }
      if (keys.has(key)) return;

      keys.add(key);
      refs.push({ container, key });
    }

    function pushArrayStringRefs(arr) {
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length; i++) {
        if (typeof arr[i] === 'string') pushRef(arr, i);
      }
    }

    function pushPartRefs(parts) {
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (!part) continue;
        if (typeof part === 'string') continue;
        if (typeof part === 'object') {
          pushRef(part, 'text');
          pushRef(part, 'input_text');
        }
      }
      pushArrayStringRefs(parts);
    }

    function collectMessageRefs(message) {
      if (!message || typeof message !== 'object') return;

      pushRef(message, 'text');
      pushRef(message, 'prompt');
      pushRef(message, 'message');
      pushArrayStringRefs(message.parts);

      if (typeof message.content === 'string') pushRef(message, 'content');
      if (Array.isArray(message.content)) {
        pushArrayStringRefs(message.content);
        for (const item of message.content) {
          if (item && typeof item === 'object') {
            pushRef(item, 'text');
            pushRef(item, 'input_text');
          }
        }
      }

      if (message.content && typeof message.content === 'object') {
        pushRef(message.content, 'text');
        pushPartRefs(message.content.parts);
        if (Array.isArray(message.content.content)) {
          for (const item of message.content.content) {
            if (item && typeof item === 'object') {
              pushRef(item, 'text');
              pushRef(item, 'input_text');
            }
          }
        }
      }
    }

    function roleOf(message) {
      return (
        message?.role ||
        message?.author?.role ||
        message?.message?.author?.role ||
        ''
      ).toString().toLowerCase();
    }

    function collectFromPayload(payload) {
      if (!payload || typeof payload !== 'object') return refs;

      // Common top-level prompt-like fields.
      for (const key of ['prompt', 'input', 'text', 'query', 'question', 'message']) {
        if (typeof payload[key] === 'string') {
          pushRef(payload, key);
        }
      }

      // OpenAI/ChatGPT style: messages[]
      if (Array.isArray(payload.messages)) {
        for (const msg of payload.messages) {
          if (!msg || typeof msg !== 'object') continue;
          const role = roleOf(msg);
          if (!role || role === 'user') {
            collectMessageRefs(msg);
          }
        }
      }

      // OpenAI responses-style: input[]
      if (Array.isArray(payload.input)) {
        for (const item of payload.input) {
          if (typeof item === 'string') {
            continue;
          }
          if (!item || typeof item !== 'object') continue;
          const role = roleOf(item);
          if (!role || role === 'user') {
            collectMessageRefs(item);
          }
        }
      }

      // Gemini style: contents[].parts[].text
      if (Array.isArray(payload.contents)) {
        for (const entry of payload.contents) {
          if (!entry || typeof entry !== 'object') continue;
          const role = (entry.role || '').toString().toLowerCase();
          if (!role || role === 'user') {
            pushPartRefs(entry.parts);
            pushRef(entry, 'text');
          }
        }
      }

      if (payload.message && typeof payload.message === 'object') {
        const role = roleOf(payload.message);
        if (!role || role === 'user') {
          collectMessageRefs(payload.message);
        }
      }

      return refs;
    }

    return { collectFromPayload };
  }

  function analyzeStructuredJson(jsonPayload) {
    const collector = createRefCollector();
    const refs = collector.collectFromPayload(jsonPayload);

    if (refs.length === 0) {
      return { action: 'allow', body: jsonPayload, reason: 'no_extractable_user_text' };
    }

    let hasPII = false;
    let changed = false;

    for (const ref of refs) {
      const currentValue = ref.container[ref.key];
      const scan = scanText(currentValue);

      if (scan.hasInjection) {
        return { action: 'block', body: jsonPayload, reason: 'injection' };
      }

      if (scan.hasPII) {
        hasPII = true;
      }

      if (scan.changed) {
        ref.container[ref.key] = scan.maskedText;
        changed = true;
      }
    }

    if (changed) {
      return { action: 'sanitize', body: jsonPayload, reason: 'pii_masked' };
    }

    if (hasPII) {
      return {
        action: 'allow',
        body: jsonPayload,
        reason: isAutoProtectEnabled() ? 'pii_detected_no_mask_change' : 'pii_autoprotect_disabled',
      };
    }

    return { action: 'allow', body: jsonPayload, reason: 'clean' };
  }

  function analyzeStringBody(body) {
    if (typeof body !== 'string') {
      return { action: 'allow', body, reason: 'non_string' };
    }

    if (looksLikeJson(body)) {
      const parsed = safeJsonParse(body);
      if (!parsed.ok) {
        // Fail open for invalid JSON-like payloads to avoid false blocking.
        return { action: 'allow', body, reason: 'json_parse_failed' };
      }

      const result = analyzeStructuredJson(parsed.value);
      if (result.action === 'sanitize') {
        const serialized = tryStringifyJson(result.body);
        if (!serialized.ok) {
          return { action: 'allow', body, reason: 'json_stringify_failed' };
        }
        return { action: 'sanitize', body: serialized.text, reason: result.reason };
      }
      return { action: result.action, body, reason: result.reason };
    }

    const scan = scanText(body);
    if (scan.hasInjection) {
      return { action: 'block', body, reason: 'injection' };
    }
    if (scan.changed) {
      return { action: 'sanitize', body: scan.maskedText, reason: 'pii_masked' };
    }
    if (scan.hasPII) {
      return {
        action: 'allow',
        body,
        reason: isAutoProtectEnabled() ? 'pii_detected_no_mask_change' : 'pii_autoprotect_disabled',
      };
    }
    return { action: 'allow', body, reason: 'clean' };
  }

  function analyzeURLSearchParamsBody(body) {
    let changed = false;
    let hasPII = false;
    const next = new URLSearchParams();

    for (const [key, value] of body.entries()) {
      const scan = scanText(value);
      if (scan.hasInjection) {
        return { action: 'block', body, reason: 'injection' };
      }

      if (scan.hasPII) hasPII = true;
      const nextValue = scan.changed ? scan.maskedText : value;
      if (nextValue !== value) changed = true;
      next.append(key, nextValue);
    }

    if (changed) {
      return { action: 'sanitize', body: next, reason: 'pii_masked' };
    }

    if (hasPII) {
      return {
        action: 'allow',
        body,
        reason: isAutoProtectEnabled() ? 'pii_detected_no_mask_change' : 'pii_autoprotect_disabled',
      };
    }

    return { action: 'allow', body, reason: 'clean' };
  }

  function analyzeFormDataBody(body) {
    let changed = false;
    let hasPII = false;
    const next = new FormData();

    for (const [key, value] of body.entries()) {
      if (typeof value !== 'string') {
        next.append(key, value);
        continue;
      }

      const scan = scanText(value);
      if (scan.hasInjection) {
        return { action: 'block', body, reason: 'injection' };
      }

      if (scan.hasPII) hasPII = true;
      const nextValue = scan.changed ? scan.maskedText : value;
      if (nextValue !== value) changed = true;
      next.append(key, nextValue);
    }

    if (changed) {
      return { action: 'sanitize', body: next, reason: 'pii_masked' };
    }

    if (hasPII) {
      return {
        action: 'allow',
        body,
        reason: isAutoProtectEnabled() ? 'pii_detected_no_mask_change' : 'pii_autoprotect_disabled',
      };
    }

    return { action: 'allow', body, reason: 'clean' };
  }

  function evaluateBody(body) {
    if (!body) {
      return { action: 'allow', body, reason: 'empty_body' };
    }

    if (consumeBypassOnce()) {
      return { action: 'allow', body, reason: 'bypass_once' };
    }

    if (typeof body === 'string') {
      return analyzeStringBody(body);
    }

    if (body instanceof URLSearchParams) {
      return analyzeURLSearchParamsBody(body);
    }

    if (body instanceof FormData) {
      return analyzeFormDataBody(body);
    }

    // Unknown body types (Blob, ReadableStream, etc.): fail open to avoid
    // platform breakage from unsafe transformations.
    return { action: 'allow', body, reason: 'unsupported_body_type' };
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const init = args[1];
    if (!init || !Object.prototype.hasOwnProperty.call(init, 'body')) {
      return originalFetch.apply(this, args);
    }

    const decision = evaluateBody(init.body);
    if (decision.action === 'block') {
      console.warn(`${TAG} Blocked fetch request`, { reason: decision.reason });
      throw new TypeError('Blocked by PrivacyGuard');
    }

    if (decision.action === 'sanitize') {
      args[1] = { ...init, body: decision.body };
      console.warn(`${TAG} Sanitized fetch request body`, { reason: decision.reason });
    }

    return originalFetch.apply(this, args);
  };

  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    const decision = evaluateBody(body);

    if (decision.action === 'block') {
      console.warn(`${TAG} Blocked XHR request`, { reason: decision.reason });
      this.abort();
      if (typeof this.onerror === 'function') {
        this.onerror(new ProgressEvent('error'));
      }
      return;
    }

    if (decision.action === 'sanitize') {
      console.warn(`${TAG} Sanitized XHR request body`, { reason: decision.reason });
      return originalXhrSend.call(this, decision.body);
    }

    return originalXhrSend.apply(this, arguments);
  };

})();
