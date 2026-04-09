/**
 * PrivacyGuard — Network Interceptor
 *
 * Runs in the MAIN world and acts as the final enforcement layer:
 *   - Injection in outgoing body  -> block request
 *   - PII in outgoing body        -> mask at send-time when possible
 *   - Explicit user override      -> one-shot bypass for next send
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

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  function toBodyText(body) {
    if (!body) return '';

    if (typeof body === 'string') return body;

    if (body instanceof URLSearchParams) {
      return body.toString();
    }

    if (body instanceof FormData) {
      const parts = [];
      for (const value of body.values()) {
        if (typeof value === 'string') parts.push(value);
      }
      return parts.join('\n');
    }

    if (typeof body === 'object') {
      return safeStringify(body);
    }

    return '';
  }

  function maskStringIfNeeded(value) {
    if (typeof value !== 'string' || typeof scanForPII !== 'function') return value;
    const matches = scanForPII(value);
    if (!matches || matches.length === 0) return value;
    if (typeof maskAll === 'function') {
      return maskAll(value, matches);
    }
    return value;
  }

  function sanitizeBody(body) {
    if (!body) return { body, changed: false };

    if (typeof body === 'string') {
      const masked = maskStringIfNeeded(body);
      return { body: masked, changed: masked !== body };
    }

    if (body instanceof URLSearchParams) {
      let changed = false;
      const next = new URLSearchParams();
      for (const [key, value] of body.entries()) {
        const maskedValue = maskStringIfNeeded(value);
        if (maskedValue !== value) changed = true;
        next.append(key, maskedValue);
      }
      return { body: changed ? next : body, changed };
    }

    if (body instanceof FormData) {
      let changed = false;
      const next = new FormData();
      for (const [key, value] of body.entries()) {
        if (typeof value === 'string') {
          const maskedValue = maskStringIfNeeded(value);
          if (maskedValue !== value) changed = true;
          next.append(key, maskedValue);
        } else {
          next.append(key, value);
        }
      }
      return { body: changed ? next : body, changed };
    }

    return { body, changed: false };
  }

  function evaluateBody(body) {
    const text = toBodyText(body);
    if (!text || text.length < 5) {
      return { action: 'allow', body, reason: 'empty_or_short' };
    }

    const injectionResults = typeof scanForInjection === 'function' ? scanForInjection(text) : [];
    const piiResults = typeof scanForPII === 'function' ? scanForPII(text) : [];
    const hasInjection = injectionResults.length > 0;
    const hasPII = piiResults.length > 0;

    if (!hasInjection && !hasPII) {
      return { action: 'allow', body, reason: 'clean' };
    }

    if (consumeBypassOnce()) {
      return { action: 'allow', body, reason: 'bypass_once' };
    }

    if (hasInjection) {
      return { action: 'block', body, reason: 'injection' };
    }

    const { body: sanitizedBody, changed } = sanitizeBody(body);
    if (changed) {
      return { action: 'sanitize', body: sanitizedBody, reason: 'pii_masked' };
    }

    return { action: 'block', body, reason: 'pii_unmaskable' };
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
