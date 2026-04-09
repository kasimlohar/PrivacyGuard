/**
 * PrivacyGuard — Warning Banner
 *
 * Displays a warning banner above input fields when sensitive data
 * or prompt injection is detected. Uses closed Shadow DOM for full
 * style isolation from the host page.
 *
 * Banner types:
 *   - PII (amber):     Shows detected category + masked preview + action buttons
 *   - Injection (red): Shows matched pattern + removal button
 *
 * Only one banner per field (updates if detection changes).
 * Exposes via window.__PrivacyGuard namespace.
 *
 * @module warningBanner
 */

(function () {
  'use strict';

  const __PG = (window.__PrivacyGuard = window.__PrivacyGuard || {});
  const TAG = '[PrivacyGuard]';

  // ─── State ──────────────────────────────────────────────────
  /** Maps field → { host, shadow, type } for one-banner-per-field. */
  const fieldBanners = new WeakMap();
  const boundShadows = new WeakSet();
  const bannerShownAt = new WeakMap();
  const pendingHideTimers = new WeakMap();
  const MIN_BANNER_DISPLAY_MS = 800;


  // ─── Styles ─────────────────────────────────────────────────

  /**
   * Returns the complete CSS for the shadow DOM.
   * Fully self-contained — no external dependencies.
   */
  function getBannerStyles() {
    return `
      :host {
        display: block;
        margin-bottom: 8px;
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        z-index: 999999;
        position: relative;
      }

      /* ─── Slide-down animation ─────────────────────────── */
      @keyframes pg-slide-down {
        from {
          opacity: 0;
          transform: translateY(-8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      /* ─── Banner container ─────────────────────────────── */
      .pg-banner {
        animation: pg-slide-down 250ms cubic-bezier(0.16, 1, 0.3, 1);
        border-radius: 8px;
        padding: 12px 16px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12),
                    0 1px 3px rgba(0, 0, 0, 0.08);
        /* Pre-wire transitions for smooth hide */
        transition: opacity 200ms ease, transform 200ms ease;
      }

      /* PII (amber) */
      .pg-banner--pii {
        background: #FEF3C7;
        border-left: 4px solid #F59E0B;
        color: #92400E;
      }

      /* Injection (red) */
      .pg-banner--injection {
        background: #FEE2E2;
        border-left: 4px solid #EF4444;
        color: #991B1B;
      }

      /* Analysis (blue) */
      .pg-banner--loading {
        background: #EFF6FF;
        border-left: 4px solid #3B82F6;
        color: #1E3A8A;
      }

      /* ─── Header ───────────────────────────────────────── */
      .pg-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 13px;
        margin-bottom: 4px;
      }

      .pg-icon {
        font-size: 16px;
        flex-shrink: 0;
      }

      .pg-title {
        flex: 1;
      }

      .pg-close {
        cursor: pointer;
        background: none;
        border: none;
        font-size: 16px;
        color: inherit;
        opacity: 0.6;
        padding: 0 4px;
        line-height: 1;
      }
      .pg-close:hover {
        opacity: 1;
      }

      /* ─── Details ──────────────────────────────────────── */
      .pg-details {
        font-size: 12px;
        opacity: 0.85;
        margin-bottom: 8px;
        word-break: break-word;
      }

      .pg-masked {
        font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
        background: rgba(0, 0, 0, 0.06);
        padding: 4px 8px;
        border-radius: 4px;
        display: inline-block;
        margin-top: 4px;
        font-size: 12px;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ─── Actions ──────────────────────────────────────── */
      .pg-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .pg-btn {
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        padding: 6px 14px;
        border-radius: 6px;
        border: none;
        transition: background 120ms ease, transform 80ms ease;
      }
      .pg-btn:hover {
        transform: translateY(-1px);
      }
      .pg-btn:active {
        transform: translateY(0);
      }

      /* Primary (amber) */
      .pg-btn--protect {
        background: #F59E0B;
        color: #fff;
      }
      .pg-btn--protect:hover {
        background: #D97706;
      }

      /* Ghost (amber) */
      .pg-btn--edit {
        background: transparent;
        color: #92400E;
        border: 1px solid #D97706;
      }
      .pg-btn--edit:hover {
        background: rgba(245, 158, 11, 0.1);
      }

      .pg-btn--send {
        background: transparent;
        color: #92400E;
        border: 1px solid #D97706;
      }
      .pg-btn--send:hover {
        background: rgba(245, 158, 11, 0.1);
      }

      /* Danger (red) */
      .pg-btn--remove {
        background: #EF4444;
        color: #fff;
      }
      .pg-btn--remove:hover {
        background: #DC2626;
      }

      /* Ghost danger (red) */
      .pg-btn--dismiss {
        background: transparent;
        color: #991B1B;
        border: 1px solid #EF4444;
      }
      .pg-btn--dismiss:hover {
        background: rgba(239, 68, 68, 0.1);
      }

      /* ─── Category badges ──────────────────────────────── */
      .pg-badge {
        display: inline-block;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 2px 6px;
        border-radius: 4px;
        margin-right: 4px;
      }
      .pg-badge--payment {
        background: #DBEAFE;
        color: #1E40AF;
      }
      .pg-badge--pii {
        background: #FDE68A;
        color: #92400E;
      }
      .pg-badge--credential {
        background: #FCE7F3;
        color: #9D174D;
      }
    `;
  }


  // ─── Banner Creation ────────────────────────────────────────

  /**
   * Render the inner HTML content for a PII detection banner.
   *
   * @param {object} detection — { piiResults, maskedValue, categories }
   * @returns {string} — HTML string
   */
  function renderPIIContent(detection) {
    const { piiResults, maskedValue } = detection;
    const categories = [...new Set(piiResults.map(r => r.category))];

    const badges = categories.map(cat => {
      const cls = cat === 'PAYMENT' ? 'payment' : cat === 'CREDENTIAL' ? 'credential' : 'pii';
      return `<span class="pg-badge pg-badge--${cls}">${cat}</span>`;
    }).join('');

    const preview = maskedValue
      ? (maskedValue.length > 60 ? maskedValue.slice(0, 60) + '…' : maskedValue)
      : '';

    return `
      <div class="pg-banner pg-banner--pii">
        <div class="pg-header">
          <span class="pg-icon">⚠️</span>
          <span class="pg-title">Sensitive info found: ${badges}</span>
          <button class="pg-close" data-action="close" aria-label="Close" title="Close">✕</button>
        </div>
        ${preview ? `
          <div class="pg-details">
            Masked: <span class="pg-masked">${escapeHTML(preview)}</span>
          </div>
        ` : ''}
        <div class="pg-actions">
          <button class="pg-btn pg-btn--edit" data-action="edit">Edit Input</button>
          <button class="pg-btn pg-btn--protect" data-action="protect">Protect</button>
          <button class="pg-btn pg-btn--send" data-action="send">Send Anyway</button>
        </div>
      </div>
    `;
  }

  /**
   * Render the inner HTML content for an injection detection banner.
   *
   * @param {object} detection — { injectionResults }
   * @returns {string} — HTML string
   */
  function renderInjectionContent(detection) {
    const { injectionResults } = detection;
    const topMatch = injectionResults[0];
    const phrase = topMatch?.matchText
      ? (topMatch.matchText.length > 50
          ? topMatch.matchText.slice(0, 50) + '…'
          : topMatch.matchText)
      : '';

    return `
      <div class="pg-banner pg-banner--injection">
        <div class="pg-header">
          <span class="pg-icon">🚨</span>
          <span class="pg-title">Prompt injection detected — submission blocked</span>
          <button class="pg-close" data-action="close" aria-label="Close" title="Close">✕</button>
        </div>
        ${phrase ? `
          <div class="pg-details">
            Pattern: <span class="pg-masked">${escapeHTML(phrase)}</span>
          </div>
        ` : ''}
        <div class="pg-actions">
          <button class="pg-btn pg-btn--remove" data-action="remove-injection">Remove Injection Text</button>
          <button class="pg-btn pg-btn--dismiss" data-action="close">Dismiss</button>
        </div>
      </div>
    `;
  }

  /**
   * Render the inner HTML content for the LLM loading banner.
   */
  function renderLoadingContent() {
    return `
      <div class="pg-banner pg-banner--loading">
        <div class="pg-header">
          <span class="pg-icon">⏳</span>
          <span class="pg-title">Analyzing content using AI...</span>
        </div>
      </div>
    `;
  }

  function buildDetectionSignature(detection, bannerType) {
    if (bannerType === 'loading') return 'loading';
    if (!detection) return 'none';

    if (bannerType === 'injection') {
      const items = (detection.injectionResults || [])
        .map((r) => `${r.ruleId || ''}:${r.matchText || ''}:${r.severity || ''}`)
        .join('|');
      return `inj:${items}`;
    }

    const pii = (detection.piiResults || [])
      .map((r) => `${r.ruleId || ''}:${r.matchText || ''}:${r.severity || ''}`)
      .join('|');
    return `pii:${pii}::${detection.maskedValue || ''}`;
  }


  // ─── Show / Hide ────────────────────────────────────────────

  function clearPendingHide(field) {
    const pending = pendingHideTimers.get(field);
    if (pending) {
      clearTimeout(pending);
      pendingHideTimers.delete(field);
    }
  }

  /**
   * Show or update a warning banner above a field.
   *
   * @param {Element} field      — The input element.
   * @param {object}  detection  — Detection result from runDetection().
   *   { piiResults, injectionResults, maskedValue, value }
   */
  function showBanner(field, detection, isLoading = false) {
    if (!field) return;
    if (!isLoading && !detection) return;

    const hasInjection = detection?.injectionResults?.length > 0;
    const hasPII = detection?.piiResults?.length > 0;
    if (!isLoading && !hasInjection && !hasPII) return;

    // Determine banner type
    const bannerType = isLoading ? 'loading' : (hasInjection ? 'injection' : 'pii');
    const signature = buildDetectionSignature(detection, bannerType);
    const shouldTrackDisplayWindow = bannerType !== 'loading';

    // Check for existing banner
    const existing = fieldBanners.get(field);
    if (existing) {
      const previousType = existing.type;

      // Avoid DOM trashing/flicker when the visible state is unchanged
      if (existing.type === bannerType && existing.signature === signature) {
        clearPendingHide(field);
        return;
      }
      if (existing.type !== bannerType) {
        existing.host.setAttribute('data-pg-banner', bannerType);
        existing.type = bannerType;
      }
      existing.detection = detection || null;
      existing.signature = signature;

      updateBannerContent(existing.shadow, detection, bannerType, field);

      clearPendingHide(field);
      if (shouldTrackDisplayWindow && previousType === 'loading') {
        bannerShownAt.set(field, Date.now());
      }
      if (!shouldTrackDisplayWindow) {
        bannerShownAt.delete(field);
      }
      return;
    }

    // Create new banner host element
    const host = document.createElement('div');
    host.className = 'privacyguard-banner-host';
    host.setAttribute('data-pg-banner', bannerType);

    // Create closed shadow DOM for full style isolation
    const shadow = host.attachShadow({ mode: 'closed' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = getBannerStyles();
    shadow.appendChild(style);

    // Inject content
    const content = document.createElement('div');
    if (isLoading) {
      content.innerHTML = renderLoadingContent();
    } else {
      content.innerHTML = hasInjection ? renderInjectionContent(detection) : renderPIIContent(detection);
    }
    shadow.appendChild(content);

    // Attach button event listeners
    if (!isLoading) {
      attachEvents(shadow, field, detection);
    }

    // Insert banner ABOVE the field using fixed positioning on document.body.
    // We cannot use insertAdjacentElement('beforebegin') because on SPA sites
    // like ChatGPT, the field's parent container has overflow:hidden / fixed 
    // height / flexbox layout that clips unknown siblings, and React's
    // reconciler may remove unrecognized DOM nodes entirely.
    try {
      const rect = field.getBoundingClientRect();
      host.style.cssText = `
        position: fixed;
        top: ${Math.max(0, rect.top - 4)}px;
        left: ${rect.left}px;
        width: ${Math.min(rect.width, 600)}px;
        z-index: 999999;
        transform: translateY(-100%);
        pointer-events: all;
      `;
      document.body.appendChild(host);
    } catch (err) {
      console.warn(`${TAG} Failed to show banner:`, err);
    }

    // Track this banner
    fieldBanners.set(field, {
      host,
      shadow,
      type: bannerType,
      detection: detection || null,
      signature,
    });
    clearPendingHide(field);
    if (shouldTrackDisplayWindow) {
      bannerShownAt.set(field, Date.now());
    } else {
      bannerShownAt.delete(field);
    }

    console.log(`${TAG} Banner shown: ${bannerType}`);
  }

  /**
   * Update the content of an existing banner's shadow DOM.
   *
   * @param {ShadowRoot} shadow
   * @param {object}     detection
   * @param {string}     bannerType
   */
  function updateBannerContent(shadow, detection, bannerType, field) {
    // Find the content container (second child after <style>)
    const contentDiv = shadow.querySelector('div');
    if (!contentDiv) return;

    if (bannerType === 'loading') {
      contentDiv.innerHTML = renderLoadingContent();
    } else {
      contentDiv.innerHTML = bannerType === 'injection'
        ? renderInjectionContent(detection)
        : renderPIIContent(detection);
    }

    // Re-attach events since innerHTML replaced the DOM
    if (field && bannerType !== 'loading') {
      attachEvents(shadow, field, detection);
    }
  }

  /**
   * Find the field associated with a shadow root.
   * NOTE: With fixed-position banners on document.body, DOM proximity
   * lookup no longer works. This function is kept as a stub — callers
   * should pass the field reference directly instead.
   * @deprecated Use direct field reference from fieldBanners WeakMap.
   */
  function findFieldForShadow(/* shadow */) {
    return null;
  }

  /**
   * Hide and remove a banner associated with a field.
   *
   * @param {Element} field
   */
  function hideBanner(field, options = {}) {
    if (!field) return;

    const existing = fieldBanners.get(field);
    if (!existing) return;

    const immediate = options.immediate === true || existing.type === 'loading';
    if (!immediate) {
      const shownAt = bannerShownAt.get(field) || 0;
      const elapsed = Date.now() - shownAt;
      const remaining = MIN_BANNER_DISPLAY_MS - elapsed;

      if (remaining > 0) {
        clearPendingHide(field);
        const timer = setTimeout(() => {
          hideBanner(field, { immediate: true });
        }, remaining);
        pendingHideTimers.set(field, timer);
        return;
      }
    }

    clearPendingHide(field);
    bannerShownAt.delete(field);

    // Animate out smoothly, then remove from DOM
    const banner = existing.shadow.querySelector('.pg-banner');
    if (banner) {
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(-6px)';

      setTimeout(() => {
        existing.host.remove();
      }, 220);
    } else {
      existing.host.remove();
    }

    fieldBanners.delete(field);
  }


  // ─── Event Handling ─────────────────────────────────────────

  /**
   * Attach click handlers to banner buttons.
   *
   * Actions:
   *   - "edit"             → Hide banner, focus field
   *   - "protect"          → Apply masking to field
   *   - "send"             → Dispatch pg-send-anyway, hide banner
   *   - "remove-injection" → Dispatch pg-remove-injection on field
   *   - "close"            → Hide banner
   *
   * @param {ShadowRoot} shadow
   * @param {Element}    field
   * @param {object}     detection
   */
  function attachEvents(shadow, field, detection) {
    if (boundShadows.has(shadow)) return;
    boundShadows.add(shadow);

    shadow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const currentDetection = fieldBanners.get(field)?.detection || detection;

      switch (action) {
        case 'edit':
          field.dispatchEvent(new CustomEvent('pg-edit', { bubbles: true }));
          hideBanner(field, { immediate: true });
          field.focus();
          break;

        case 'protect':
          field.dispatchEvent(new CustomEvent('pg-protect', {
            bubbles: true,
            detail: { detection: currentDetection },
          }));
          hideBanner(field, { immediate: true });
          break;

        case 'send':
          field.dispatchEvent(new CustomEvent('pg-send-anyway', {
            bubbles: true,
            detail: { detection: currentDetection },
          }));
          hideBanner(field, { immediate: true });
          break;

        case 'remove-injection':
          field.dispatchEvent(new CustomEvent('pg-remove-injection', {
            bubbles: true,
            detail: { detection: currentDetection },
          }));
          // Remove injection text from field
          removeInjectionFromField(field, currentDetection || { injectionResults: [] });
          hideBanner(field, { immediate: true });
          break;

        case 'close':
          hideBanner(field, { immediate: true });
          break;
      }
    });
  }

  /**
   * Remove detected injection patterns from a field's value.
   *
   * @param {Element} field
   * @param {object}  detection
   */
  function removeInjectionFromField(field, detection) {
    if (!detection.injectionResults?.length) return;

    let value = __PG.getFieldValue ? __PG.getFieldValue(field) : (field.value || field.innerText || '');

    // Remove each injection match from the text (in reverse to preserve indices)
    const sorted = [...detection.injectionResults].sort((a, b) => {
      if (typeof a.startIndex === 'number' && typeof b.startIndex === 'number') {
        return b.startIndex - a.startIndex;
      }
      return 0;
    });

    for (const match of sorted) {
      if (typeof match.startIndex === 'number' && typeof match.endIndex === 'number') {
        value = value.slice(0, match.startIndex) + value.slice(match.endIndex);
      } else if (match.matchText) {
        // Fallback for LLM results which don't have exact indices
        value = value.replace(match.matchText, '');
      }
    }

    const cleanedValue = value.trim();
    if (__PG.setFieldValue) {
      __PG.setFieldValue(field, cleanedValue);
    } else if (field.isContentEditable) {
      field.innerText = cleanedValue;
    } else {
      field.value = cleanedValue;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }

    field.focus();
  }


  // ─── Utilities ──────────────────────────────────────────────

  /**
   * Escape HTML special characters to prevent XSS in banner content.
   *
   * @param {string} str
   * @returns {string}
   */
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Check if a field currently has a visible banner.
   *
   * @param {Element} field
   * @returns {boolean}
   */
  function hasBanner(field) {
    return fieldBanners.has(field);
  }

  function getBannerType(field) {
    return fieldBanners.get(field)?.type || null;
  }


  function showLoadingBanner(field) {
    showBanner(field, null, true);
  }

  // ─── Exports ────────────────────────────────────────────────
  __PG.showBanner = showBanner;
  __PG.hideBanner = hideBanner;
  __PG.showLoadingBanner = showLoadingBanner;
  __PG.hasBanner = hasBanner;
  __PG.getBannerType = getBannerType;

})();
