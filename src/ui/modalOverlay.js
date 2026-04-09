/**
 * PrivacyGuard — Modal Overlay
 *
 * Full-screen blocking modal for critical detections:
 *   - Prompt injection → always blocks (no "Send Anyway")
 *   - Critical-severity PII → blocks with override option
 *
 * Uses closed Shadow DOM for page-level style isolation.
 * Only one modal can exist at a time (singleton pattern).
 * Includes focus trap and keyboard (ESC) support.
 *
 * @module modalOverlay
 */

(function () {
  'use strict';

  const __PG = (window.__PrivacyGuard = window.__PrivacyGuard || {});

  // ─── Singleton State ────────────────────────────────────────
  /** @type {{ host: HTMLElement, shadow: ShadowRoot, field: Element, signature: string, _keyHandler: Function|null } | null} */
  let activeModal = null;


  // ─── Styles ─────────────────────────────────────────────────

  function getModalStyles() {
    return `
      *, *::before, *::after {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      /* ─── Backdrop ─────────────────────────────────────── */
      .pg-overlay {
        position: fixed;
        inset: 0;
        z-index: 9999999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        animation: pg-fade-in 280ms ease-out;
        transition: opacity 180ms ease;
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      }

      @keyframes pg-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      /* ─── Modal Card ───────────────────────────────────── */
      .pg-modal {
        background: #fff;
        border-radius: 16px;
        width: 90vw;
        max-width: 440px;
        padding: 32px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3),
                    0 8px 24px rgba(0, 0, 0, 0.15);
        animation: pg-scale-in 300ms cubic-bezier(0.16, 1, 0.3, 1);
        transition: opacity 180ms ease, transform 180ms ease;
        position: relative;
        color: #1e293b;
        line-height: 1.5;
      }

      @keyframes pg-scale-in {
        from {
          opacity: 0;
          transform: scale(0.92) translateY(12px);
        }
        to {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
      }

      /* ─── Header ───────────────────────────────────────── */
      .pg-modal-icon {
        font-size: 48px;
        text-align: center;
        margin-bottom: 12px;
      }

      .pg-modal-title {
        font-size: 20px;
        font-weight: 700;
        text-align: center;
        color: #0f172a;
        margin-bottom: 8px;
      }

      .pg-modal-subtitle {
        font-size: 14px;
        text-align: center;
        color: #64748b;
        margin-bottom: 20px;
      }

      /* ─── Detection List ───────────────────────────────── */
      .pg-detections {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 14px 16px;
        margin-bottom: 24px;
      }

      .pg-detections-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: #94a3b8;
        margin-bottom: 10px;
      }

      .pg-detection-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 8px 0;
        font-size: 13px;
      }
      .pg-detection-item + .pg-detection-item {
        border-top: 1px solid #e2e8f0;
      }

      .pg-detection-icon {
        flex-shrink: 0;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
      }

      .pg-detection-icon--injection {
        background: #FEE2E2;
        color: #DC2626;
      }
      .pg-detection-icon--pii {
        background: #FEF3C7;
        color: #D97706;
      }

      .pg-detection-text {
        flex: 1;
      }

      .pg-detection-label {
        font-weight: 600;
        color: #334155;
      }

      .pg-detection-value {
        font-family: 'Cascadia Code', 'Fira Code', monospace;
        font-size: 12px;
        color: #64748b;
        background: #f1f5f9;
        padding: 2px 6px;
        border-radius: 4px;
        margin-top: 2px;
        display: inline-block;
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .pg-severity {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 2px 6px;
        border-radius: 4px;
        flex-shrink: 0;
      }
      .pg-severity--critical {
        background: #FEE2E2;
        color: #DC2626;
      }
      .pg-severity--high {
        background: #FEF3C7;
        color: #D97706;
      }

      /* ─── Buttons ──────────────────────────────────────── */
      .pg-modal-actions {
        display: flex;
        gap: 10px;
        justify-content: center;
      }

      .pg-modal-btn {
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
        padding: 10px 24px;
        border-radius: 10px;
        border: none;
        transition: all 120ms ease;
        min-width: 120px;
      }
      .pg-modal-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
      }
      .pg-modal-btn:active {
        transform: translateY(0);
      }
      .pg-modal-btn:focus-visible {
        outline: 2px solid #3b82f6;
        outline-offset: 2px;
      }

      .pg-modal-btn--primary {
        background: #EF4444;
        color: #fff;
      }
      .pg-modal-btn--primary:hover {
        background: #DC2626;
      }

      .pg-modal-btn--secondary {
        background: #f1f5f9;
        color: #475569;
        border: 1px solid #cbd5e1;
      }
      .pg-modal-btn--secondary:hover {
        background: #e2e8f0;
      }

      /* ─── Footer note ──────────────────────────────────── */
      .pg-modal-footer {
        text-align: center;
        font-size: 11px;
        color: #94a3b8;
        margin-top: 16px;
      }

      .pg-shield-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-weight: 600;
        color: #64748b;
      }
    `;
  }


  // ─── Content Rendering ──────────────────────────────────────

  /**
   * Build the modal inner HTML.
   *
   * @param {object}  detection   — { piiResults, injectionResults, maskedValue }
   * @param {boolean} isInjection — true → injection mode (no Send Anyway)
   * @returns {string}
   */
  function renderModalContent(detection, isInjection) {
    const items = buildDetectionItems(detection, isInjection);

    const title = isInjection
      ? 'Prompt Injection Blocked'
      : 'Sensitive Data Detected';

    const subtitle = isInjection
      ? 'This input contains patterns commonly used to manipulate AI systems. Submission has been blocked to protect your security.'
      : 'This input contains sensitive information that could compromise your privacy if submitted.';

    const icon = isInjection ? '🛑' : '🔒';

    // Injection: only Fix Input (hard block)
    // PII: Fix Input + Send Anyway
    const actions = isInjection
      ? `<button class="pg-modal-btn pg-modal-btn--primary" data-action="fix" autofocus>Fix Input</button>`
      : `
          <button class="pg-modal-btn pg-modal-btn--primary" data-action="fix" autofocus>Fix Input</button>
          <button class="pg-modal-btn pg-modal-btn--secondary" data-action="send-anyway">Send Anyway</button>
        `;

    return `
      <div class="pg-overlay" data-action="backdrop">
        <div class="pg-modal" role="alertdialog" aria-modal="true" aria-label="${escapeAttr(title)}">

          <div class="pg-modal-icon">${icon}</div>
          <div class="pg-modal-title">${escapeHTML(title)}</div>
          <div class="pg-modal-subtitle">${escapeHTML(subtitle)}</div>

          <div class="pg-detections">
            <div class="pg-detections-title">Detected Issues</div>
            ${items}
          </div>

          <div class="pg-modal-actions">
            ${actions}
          </div>

          <div class="pg-modal-footer">
            <span class="pg-shield-badge">🛡️ Protected by PrivacyGuard</span>
          </div>

        </div>
      </div>
    `;
  }

  /**
   * Build HTML list items for detected issues (max 3).
   */
  function buildDetectionItems(detection, isInjection) {
    const items = [];

    // Injection matches
    if (detection.injectionResults?.length > 0) {
      for (const r of detection.injectionResults.slice(0, 2)) {
        items.push(`
          <div class="pg-detection-item">
            <div class="pg-detection-icon pg-detection-icon--injection">⚠</div>
            <div class="pg-detection-text">
              <div class="pg-detection-label">${escapeHTML(r.description || 'Prompt injection')}</div>
              <div class="pg-detection-value">${escapeHTML(truncate(r.matchText, 50))}</div>
            </div>
            <span class="pg-severity pg-severity--critical">${escapeHTML(r.severity)}</span>
          </div>
        `);
      }
    }

    // PII matches
    if (detection.piiResults?.length > 0 && items.length < 3) {
      const remaining = 3 - items.length;
      for (const r of detection.piiResults.slice(0, remaining)) {
        items.push(`
          <div class="pg-detection-item">
            <div class="pg-detection-icon pg-detection-icon--pii">🔒</div>
            <div class="pg-detection-text">
              <div class="pg-detection-label">${escapeHTML(r.category)} — ${escapeHTML(r.ruleId)}</div>
              <div class="pg-detection-value">${escapeHTML(truncate(r.matchText, 50))}</div>
            </div>
            <span class="pg-severity pg-severity--${r.severity === 'CRITICAL' ? 'critical' : 'high'}">${escapeHTML(r.severity)}</span>
          </div>
        `);
      }
    }

    return items.join('');
  }

  function buildDetectionSignature(field, detection) {
    const value = detection?.value || '';
    const pii = (detection?.piiResults || []).map((r) => `${r.ruleId}:${r.severity}:${r.matchText}`);
    const injection = (detection?.injectionResults || []).map((r) => `${r.ruleId}:${r.severity}:${r.matchText}`);
    return `${value}::${field?.tagName || ''}::${pii.join('|')}::${injection.join('|')}`;
  }


  // ─── Show / Hide ────────────────────────────────────────────

  /**
   * Show the blocking modal overlay.
   *
   * @param {Element} field     — The field that triggered the detection.
   * @param {object}  detection — Detection result from runDetection().
   */
  function showModal(field, detection) {
    if (!field || !detection) return;

    const hasInjection = detection.injectionResults?.length > 0;
    const hasCriticalPII = detection.piiResults?.some(r => r.severity === 'CRITICAL');

    // Only show for injection or critical PII
    if (!hasInjection && !hasCriticalPII) return;

    const signature = buildDetectionSignature(field, detection);
    if (activeModal && activeModal.field === field && activeModal.signature === signature) {
      return;
    }

    // Close existing modal first (singleton)
    if (activeModal) {
      hideModal();
    }

    const isInjection = hasInjection;

    // Create host element
    const host = document.createElement('div');
    host.className = 'privacyguard-modal-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:9999999;pointer-events:all;';

    // Create closed shadow DOM
    const shadow = host.attachShadow({ mode: 'closed' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = getModalStyles();
    shadow.appendChild(style);

    // Inject content
    const content = document.createElement('div');
    content.innerHTML = renderModalContent(detection, isInjection);
    shadow.appendChild(content);

    // Store active modal reference before event binding.
    activeModal = { host, shadow, field, signature, _keyHandler: null };

    // Attach event handlers
    attachEvents(shadow, field, detection, isInjection);

    // Add to page
    document.body.appendChild(host);

    // Prevent background scrolling
    document.body.style.overflow = 'hidden';

    // Focus the primary button
    requestAnimationFrame(() => {
      const primaryBtn = shadow.querySelector('[data-action="fix"]');
      if (primaryBtn) primaryBtn.focus();
    });

    // Set up focus trap
    trapFocus(shadow);

  }

  /**
   * Hide and destroy the active modal.
   */
  function hideModal() {
    if (!activeModal) return;

    const { host } = activeModal;

    // Animate out
    const overlay = activeModal.shadow.querySelector('.pg-overlay');
    if (overlay) {
      overlay.style.transition = 'opacity 180ms ease';
      overlay.style.opacity = '0';

      const modal = activeModal.shadow.querySelector('.pg-modal');
      if (modal) {
        modal.style.transition = 'transform 180ms ease, opacity 180ms ease';
        modal.style.transform = 'scale(0.95) translateY(8px)';
        modal.style.opacity = '0';
      }

      setTimeout(() => {
        host.remove();
      }, 190);
    } else {
      host.remove();
    }

    // Restore scrolling
    document.body.style.overflow = '';

    // Clean up keyboard listener
    if (activeModal._keyHandler) {
      document.removeEventListener('keydown', activeModal._keyHandler, true);
    }

    activeModal = null;
  }


  // ─── Event Handling ─────────────────────────────────────────

  /**
   * Attach click and keyboard handlers to the modal.
   */
  function attachEvents(shadow, field, detection, isInjection) {
    // Button clicks
    shadow.addEventListener('click', (e) => {
      const action = e.target.dataset?.action;
      if (!action) return;

      switch (action) {
        case 'fix':
          hideModal();
          // Restore original if PII was masked
          if (__PG.restoreOriginal) {
            __PG.restoreOriginal(field);
          }
          // Hide the banner too
          if (__PG.hideBanner) {
            __PG.hideBanner(field, { immediate: true });
          }
          field.focus();
          break;

        case 'send-anyway':
          field.dispatchEvent(new CustomEvent('pg-send-anyway', {
            bubbles: true,
            detail: { detection },
          }));
          hideModal();
          if (__PG.hideBanner) {
            __PG.hideBanner(field, { immediate: true });
          }
          break;

        case 'backdrop':
          // Only close on backdrop click for PII, not injection
          if (!isInjection && e.target === e.currentTarget) {
            hideModal();
          }
          break;
      }
    });

    // Keyboard: ESC to close (PII only, not injection)
    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        if (!isInjection) {
          e.preventDefault();
          e.stopPropagation();
          hideModal();
          field.focus();
        }
      }
    };
    document.addEventListener('keydown', keyHandler, true);

    // Store reference for cleanup
    if (activeModal) {
      activeModal._keyHandler = keyHandler;
    }
  }

  /**
   * Trap focus inside the modal.
   * Prevents Tab from escaping to the page behind.
   */
  function trapFocus(shadow) {
    shadow.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;

      const focusable = shadow.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        // Shift+Tab from first → wrap to last
        if (shadow.activeElement === first || !shadow.contains(e.target)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab from last → wrap to first
        if (shadow.activeElement === last || !shadow.contains(e.target)) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }


  // ─── Utilities ──────────────────────────────────────────────

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  /**
   * Check if the modal is currently visible.
   * @returns {boolean}
   */
  function isModalActive() {
    return activeModal !== null;
  }


  // ─── Exports ────────────────────────────────────────────────
  __PG.showModal = showModal;
  __PG.hideModal = hideModal;
  __PG.isModalActive = isModalActive;

})();
