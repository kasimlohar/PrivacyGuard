/**
 * PrivacyGuard — Network Interceptor
 *
 * Runs in the MAIN world to monkey-patch `fetch` and `XMLHttpRequest`.
 * Pre-emptively scans request payloads (bodies) for PII or Injection
 * before the browser network stack dispatches the request.
 */

(function PrivacyGuardInterceptor() {
  if (window.__PG_INTERCEPTOR_ACTIVE) return;
  window.__PG_INTERCEPTOR_ACTIVE = true;

  const TAG = '[PrivacyGuard]';

  // Assumes scanForPII and scanForInjection are in scope 
  // (if bundled via build.js together with regex engine)

  /**
   * Run lightweight sync detection on request bodies.
   * @param {any} body 
   * @returns {string|false} 'PII', 'INJECTION', or false
   */
  function detectThreats(body) {
    if (!body) return false;

    let text = '';
    if (typeof body === 'string') {
      text = body;
    } else {
      try {
        // Attempt to extract text from FormData, URLSearchParams, or generic JSON
        text = JSON.stringify(body);
      } catch (e) {
        return false;
      }
    }

    if (text.length < 5) return false; // Too short to matter

    // If these functions aren't available for some reason, fail open
    if (typeof scanForInjection === 'function') {
      const initResults = scanForInjection(text);
      if (initResults && initResults.length > 0) return 'INJECTION';
    }

    if (typeof scanForPII === 'function') {
      const piiResults = scanForPII(text);
      if (piiResults && piiResults.length > 0) return 'PII';
    }

    return false;
  }

  // ─── hook fetch() ─────────────────────────────────────────────
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    // args[0] is URL, args[1] is options (contains body)
    if (args[1] && args[1].body) {
      const threat = detectThreats(args[1].body);
      if (threat) {
        console.warn(`${TAG} Blocked fetch request`, { type: 'fetch', reason: threat });
        // Hard abort the request natively
        throw new TypeError('Blocked by PrivacyGuard');
      }
    }
    return originalFetch.apply(this, args);
  };

  // ─── hook XMLHttpRequest.prototype.send ────────────────────────
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.send = function (body) {
    if (body) {
      const threat = detectThreats(body);
      if (threat) {
        console.warn(`${TAG} Blocked XHR request`, { type: 'xhr', reason: threat });
        // Abort the request instance directly before sending to the native stack
        this.abort();
        // Emulate an error so the frontend app logic handles it
        if (typeof this.onerror === 'function') {
          this.onerror(new ProgressEvent('error'));
        }
        return; // Prevent original sending
      }
    }
    return originalXhrSend.apply(this, arguments);
  };

})();
