/**
 * PrivacyGuard — Field Scanner
 *
 * Attaches event listeners to input fields discovered by the content script.
 * Uses intent-based detection: only runs the pipeline after the user PAUSES
 * typing (600ms debounce), not on every keystroke. This prevents UI flicker,
 * banner flash, and false positives during active typing.
 *
 * UX Philosophy:
 *   - Typing  → SILENCE (no UI, no detection)
 *   - Pause   → Detect + show results calmly
 *   - Resume  → Fade out UI, wait for next pause
 *
 * Exposes functions via window.__PrivacyGuard namespace so contentScript.js
 * (loaded after this file) can call them. Content scripts share an isolated
 * world but cannot use ES module imports.
 *
 * @module fieldScanner
 */

(function () {
  'use strict';

  const __PG = (window.__PrivacyGuard = window.__PrivacyGuard || {});
  const TAG = '[PrivacyGuard]';

  // ─── Config ─────────────────────────────────────────────────
  /**
   * Intent detection delay — only run detection after the user has
   * STOPPED typing for this long. 600ms is the sweet spot:
   *   - Fast enough to feel responsive after a natural pause
   *   - Slow enough to avoid triggering mid-word/mid-number
   *   - Matches the ~500–800ms range recommended by UX research for
   *     "user has finished their thought" detection
   */
  const DEBOUNCE_MS = 600;

  /**
   * Paste events still use debounce so UI only appears after a calm pause.
   */
  const PASTE_DELAY_MS = 600;

  /** Ignore values shorter than this to avoid false positives. */
  const MIN_LENGTH = 3;

  /**
   * Delay before showing the "Analyzing..." loading banner (ms).
   * Only shown if the LLM call actually takes this long; prevents
   * the flash-of-loading when LLM responds quickly.
   */
  const LOADING_BANNER_DELAY_MS = 500;

  /**
   * Minimum text length before LLM fallback is invoked.
   * Short text is unlikely to contain nuanced PII that regex misses.
   */
  const LLM_MIN_LENGTH = 50;


  // ─── State ──────────────────────────────────────────────────
  /** Prevent duplicate listener attachment. */
  const attachedFields = new WeakSet();

  /** Per-field debounce timers — one timer per field. */
  const debounceTimers = new WeakMap();

  /** Stores original (unmasked) values so the user can restore them. */
  const originalValues = new WeakMap();

  /** Stores the last-scanned value per field to skip re-detection. */
  const lastValueMap = new WeakMap();

  /** Monotonic per-field run id used to ignore stale async responses. */
  const detectionRunIds = new WeakMap();
  const fieldStateMap = new WeakMap();
  const bypassMap = new WeakMap();

  const STATES = Object.freeze({
    IDLE: 'IDLE',
    DETECTED: 'DETECTED',
    REVIEW: 'REVIEW',
    ACTION: 'ACTION',
    CLEAN: 'CLEAN',
  });

  /**
   * Guard flag — set to true while we're programmatically changing a field
   * value. Prevents our own input listeners from re-triggering detection
   * on the masked text we just wrote.
   */
  let isProcessing = false;

  function nextRunId(field) {
    const next = (detectionRunIds.get(field) || 0) + 1;
    detectionRunIds.set(field, next);
    return next;
  }

  function isStaleRun(field, runId, expectedValue) {
    if ((detectionRunIds.get(field) || 0) !== runId) {
      return true;
    }
    if (typeof expectedValue === 'string' && getFieldValue(field) !== expectedValue) {
      return true;
    }
    return false;
  }

  function isFieldMasked(field) {
    return field?.dataset?.pgMasked === 'true';
  }

  function setFieldState(field, status, patch = {}) {
    const previous = fieldStateMap.get(field) || {};
    fieldStateMap.set(field, { ...previous, ...patch, status });
  }

  function getFieldState(field) {
    return fieldStateMap.get(field) || { status: STATES.IDLE };
  }

  function markFieldMasked(field, masked) {
    if (!field) return;
    if (masked) {
      field.dataset.pgMasked = 'true';
    } else {
      delete field.dataset.pgMasked;
      delete field.dataset.privacyguardMasked;
    }
  }

  function setFieldValue(field, nextValue, options = {}) {
    const { dispatchInput = true } = options;
    const value = typeof nextValue === 'string' ? nextValue : '';

    if (field.isContentEditable) {
      field.innerText = value;
      return;
    }

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (field.tagName === 'TEXTAREA' && nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(field, value);
    } else if (field.tagName === 'INPUT' && nativeInputValueSetter) {
      nativeInputValueSetter.call(field, value);
    } else {
      field.value = value;
    }

    if (dispatchInput) {
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ─── Value Extraction ───────────────────────────────────────

  /**
   * Get the current text value of any input-like element.
   *
   * @param {Element} field
   * @returns {string}
   */
  function getFieldValue(field) {
    if (field.isContentEditable) {
      return field.innerText || '';
    }
    return field.value || '';
  }

  /**
   * Determine the human-readable type of a field.
   *
   * @param {Element} field
   * @returns {string} — 'contenteditable' | 'textarea' | 'input'
   */
  function getFieldType(field) {
    if (field.isContentEditable) return 'contenteditable';
    return field.tagName.toLowerCase();
  }


  // ─── Cursor Helpers ─────────────────────────────────────────

  /**
   * Get the current cursor (caret) position in a field.
   * Returns -1 for contenteditable (selection API is complex; MVP skips it).
   *
   * @param {Element} field
   * @returns {number}
   */
  function getCursorPosition(field) {
    if (field.isContentEditable) return -1;
    try {
      return field.selectionStart ?? -1;
    } catch {
      return -1;
    }
  }

  /**
   * Set the cursor position in a field after masking.
   * Clamps to field length to avoid out-of-bounds.
   *
   * @param {Element} field
   * @param {number} pos — Desired cursor position.
   */
  function setCursorPosition(field, pos) {
    if (field.isContentEditable || pos < 0) return;
    try {
      const clamped = Math.min(pos, (field.value || '').length);
      field.setSelectionRange(clamped, clamped);
    } catch {
      // Some input types (date, number) don't support setSelectionRange
    }
  }


  // ─── In-Field Masking ───────────────────────────────────────

  /**
   * Apply a masked value directly into the field.
   *
   * Steps:
   *   1. Save original value in WeakMap (for potential restore).
   *   2. Save cursor position.
   *   3. Set the guard flag to prevent event-loop.
   *   4. Write masked value into the field.
   *   5. Mark element with data attribute.
   *   6. Restore cursor position.
   *   7. Clear guard flag.
   *
   * @param {Element} field       — The input element.
   * @param {string}  maskedValue — The masked text to display.
   * @param {string}  originalVal — The original unmasked text.
   */
  function applyMask(field, maskedValue, originalVal) {
    // Don't mask if values are identical (nothing to redact)
    if (maskedValue === originalVal || isFieldMasked(field)) return;

    // Store original so user can restore later
    originalValues.set(field, originalVal);

    // Save cursor before we mutate the value
    const cursorPos = getCursorPosition(field);

    // Set guard — our own event listeners will see this and skip
    isProcessing = true;

    try {
      // Always replace the full field value in one write.
      setFieldValue(field, maskedValue, { dispatchInput: !field.isContentEditable });
      markFieldMasked(field, true);
      field.dataset.pgProtected = 'true';

      // Update last-processed to the masked value so we don't
      // re-detect the mask itself on the next debounce cycle
      lastValueMap.set(field, maskedValue);

      // Restore cursor (approximate — length may have changed)
      if (cursorPos >= 0) {
        setCursorPosition(field, cursorPos);
      }
    } finally {
      // Always clear the guard, even if something throws
      isProcessing = false;
    }
  }

  /**
   * Restore a field's original (unmasked) value.
   * Called when the user clicks "Show original" in the UI.
   *
   * @param {Element} field
   * @returns {boolean} — true if restored, false if no original existed.
   */
  function restoreOriginal(field) {
    const original = originalValues.get(field);
    if (original == null) return false;

    isProcessing = true;
    try {
      setFieldValue(field, original, { dispatchInput: !field.isContentEditable });
      markFieldMasked(field, false);
      delete field.dataset.pgProtected;
      lastValueMap.set(field, original);
      setFieldState(field, STATES.IDLE, { detection: null });
    } finally {
      isProcessing = false;
    }

    return true;
  }


  // ─── Detection Pipeline ──────────────────────────────────────

  /**
   * Run the full detection pipeline on a text value.
   *
   * @param {string} value — The input text to analyze.
   * @returns {{ piiResults: Array, injectionResults: Array, maskedValue: string|null }}
   */
  function runDetection(value) {
    const scanForPII = __PG.scanForPII;
    const scanForInjection = __PG.scanForInjection;
    const maskAll = __PG.maskAll;

    // Run both engines
    const piiResults = scanForPII ? scanForPII(value) : [];
    const injectionResults = scanForInjection ? scanForInjection(value) : [];

    // Generate masked value if PII was found
    const maskedValue = piiResults.length > 0 && maskAll
      ? maskAll(value, piiResults)
      : null;

    return { piiResults, injectionResults, maskedValue };
  }


  // ─── Highlight via data attribute + CSS (React-proof) ──────
  // Inline style.outline gets stripped by React re-renders.
  // Instead, set a data attribute and inject a <style> with !important.
  // Includes smooth transitions for calm enter/exit.

  let _highlightStyleInjected = false;

  function ensureHighlightStyles() {
    if (_highlightStyleInjected) return;
    _highlightStyleInjected = true;
    const style = document.createElement('style');
    style.id = 'privacyguard-highlight-styles';
    style.textContent = `
      [data-privacyguard-alert] {
        transition: outline-color 150ms ease, outline-width 150ms ease, opacity 180ms ease !important;
      }
      [data-privacyguard-alert="injection"] {
        outline: 2px solid #ef4444 !important;
        outline-offset: 1px !important;
      }
      [data-privacyguard-alert="critical"] {
        outline: 2px solid #f97316 !important;
        outline-offset: 1px !important;
      }
      [data-privacyguard-alert="pii"] {
        outline: 2px solid #eab308 !important;
        outline-offset: 1px !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function applyHighlight(field, type) {
    ensureHighlightStyles();
    field.setAttribute('data-privacyguard-alert', type.toLowerCase());
  }

  function clearHighlight(field) {
    field.removeAttribute('data-privacyguard-alert');
  }


  // ─── Banner Helpers ────────────────────────────────────────

  function hideBannerGracefully(field) {
    if (__PG.hideBanner) __PG.hideBanner(field);
    clearHighlight(field);
  }

  /**
   * Show banner and record the display timestamp.
   *
   * @param {Element} field
   * @param {object} detection
   */
  function showBannerWithTiming(field, detection) {
    if (__PG.showBanner) __PG.showBanner(field, detection);
  }

  function signalInterceptorBypassOnce() {
    try {
      window.postMessage(
        {
          source: 'PRIVACYGUARD',
          type: 'PG_BYPASS_ONCE',
          ttlMs: 5000,
        },
        '*'
      );
    } catch {
      // No-op: bypass still works on content-side guard
    }
  }


  // ─── Event Handling ─────────────────────────────────────────

  /**
   * Core event handler — called after debounce window expires.
   * Only runs if the user has STOPPED typing for DEBOUNCE_MS.
   *
   * Intent-based detection flow:
   *   1. Guard checks (masking, enabled, allowlist)
   *   2. Value stability check (skip if unchanged)
   *   3. Regex detection
   *   4. LLM fallback (only for long text on AI domains, with delayed loading UI)
   *   5. Show results calmly (banner, highlight, modal)
   *
   * @param {Event}   event  — The original DOM event.
   * @param {Element} field  — The target input element.
   * @param {number}  runId  — Monotonic run id for stale async protection.
   */
  async function handleFieldEvent(event, field, runId) {
    // Guard: skip if we're the ones changing the value (prevents loops)
    if (isProcessing) return;
    if (isStaleRun(field, runId)) return;

    if (bypassMap.get(field)) {
      bypassMap.delete(field);
      setFieldState(field, STATES.ACTION, { bypass: true, detection: null });
      return;
    }

    // Guard: skip if extension is disabled
    if (__PG.isEnabled) {
      const enabled = await __PG.isEnabled();
      if (isStaleRun(field, runId)) return;
      if (!enabled) return;
    }

    // Guard: skip if this domain is allowlisted
    if (__PG.isAllowed) {
      try {
        const domain = location.hostname;
        const allowed = await __PG.isAllowed(domain);
        if (isStaleRun(field, runId)) return;
        if (allowed) return;
      } catch {
        // If storage fails, continue with detection
      }
    }

    const value = getFieldValue(field);

    // Skip empty or very short input (avoids false positives on single chars)
    if (!value || value.trim().length < MIN_LENGTH) {
      lastValueMap.delete(field);
      setFieldState(field, STATES.CLEAN, { detection: null });
      if (!isFieldMasked(field)) {
        originalValues.delete(field);
      }
      hideBannerGracefully(field);
      return;
    }

    // ── Value stability check ────────────────────────────────
    // Skip detection if the value hasn't changed since last run.
    // This prevents re-detection after masking, after focus/blur,
    // and after React re-renders that fire spurious input events.
    const lastValue = lastValueMap.get(field);
    if (lastValue === value) return;
    lastValueMap.set(field, value);

    // Run detection pipeline
    let { piiResults, injectionResults, maskedValue } = runDetection(value);

    // Early exit if nothing detected by regex → LLM Fallback
    if (piiResults.length === 0 && injectionResults.length === 0) {
      let llmFired = false;

      // Only invoke LLM for sufficiently long text to avoid
      // wasting API calls and showing "Analyzing..." flash on short input
      if (__PG.classifyWithLLM && value.length >= LLM_MIN_LENGTH) {
        const hostname = location.hostname;
        
        // Delayed loading banner — only show if LLM takes > 500ms.
        // Prevents the "Analyzing..." flash when LLM responds quickly.
        let loadingTimer = null;
        let loadingShown = false;
        if (__PG.showLoadingBanner) {
          loadingTimer = setTimeout(() => {
            if (!isStaleRun(field, runId, value) && !isProcessing) {
              __PG.showLoadingBanner(field);
              loadingShown = true;
            }
          }, LOADING_BANNER_DELAY_MS);
        }

        try {
          const llmResult = await __PG.classifyWithLLM(value, hostname);
          if (loadingTimer) clearTimeout(loadingTimer);

          if (isStaleRun(field, runId, value)) {
            if (loadingShown && __PG.hideBanner) {
              __PG.hideBanner(field, { immediate: true });
            }
            return;
          }

          if (loadingShown && __PG.hideBanner) {
            __PG.hideBanner(field, { immediate: true });
          }

          if (llmResult) {
            llmFired = true;
            const proxyResult = {
              ruleId: llmResult.ruleId || 'LLM-01',
              category: llmResult.category,
              severity: llmResult.severity || 'HIGH',
              matchText: value.slice(0, 50),
              description: llmResult.description || 'Flagged by AI analysis',
            };
            
            if (llmResult.category === 'INJECTION') {
              injectionResults = [proxyResult];
            } else {
              piiResults = [proxyResult];
            }
          }
        } catch {
          if (loadingTimer) clearTimeout(loadingTimer);
          if (loadingShown && __PG.hideBanner) {
            __PG.hideBanner(field, { immediate: true });
          }
        }
      }

      if (!llmFired) {
        setFieldState(field, STATES.CLEAN, { detection: null });
        if (!isFieldMasked(field)) {
          originalValues.delete(field);
        }
        hideBannerGracefully(field);
        return;
      }
    }

    // ── Log injection results FIRST (higher priority) ─────
    if (injectionResults.length > 0) {
      console.warn(`${TAG}[⚠ INJECTION DETECTED]`, {
        field: getFieldType(field),
        count: injectionResults.length,
        matches: injectionResults.map(r => ({
          rule: r.ruleId,
          severity: r.severity,
          text: r.matchText,
          description: r.description,
        })),
      });
    }

    // ── Log PII results ───────────────────────────────────
    if (piiResults.length > 0) {
      // Collect unique categories
      const categories = [...new Set(piiResults.map(r => r.category))];

      console.warn(`${TAG}[🔒 PII DETECTED]`, {
        field: getFieldType(field),
        categories,
        count: piiResults.length,
        matches: piiResults.map(r => ({
          rule: r.ruleId,
          category: r.category,
          severity: r.severity,
          text: r.matchText,
        })),
        masked: maskedValue,
      });
    }

    const hasPII = piiResults.length > 0;
    const hasInjection = injectionResults.length > 0;

    if (hasPII || hasInjection) {
      setFieldState(field, STATES.DETECTED, {
        detection: { value, piiResults, injectionResults, maskedValue },
      });
    } else {
      setFieldState(field, STATES.CLEAN, { detection: null });
      if (!isFieldMasked(field)) {
        originalValues.delete(field);
      }
    }

    // Preserve source text for explicit user actions (e.g., Protect/Send Anyway).
    if (hasPII) {
      originalValues.set(field, value);
    }

    // ── Persist detections to chrome.storage ────────────
    if (hasPII && __PG.addDetection) {
      const domain = location.hostname;
      for (const r of piiResults) {
        __PG.addDetection({
          domain,
          category: r.category,
          severity: r.severity,
          ruleId: r.ruleId,
          maskedValue: r.matchText
            ? r.matchText.slice(0, 30) + (r.matchText.length > 30 ? '…' : '')
            : '',
        }).catch(() => {}); // Fire and forget — don't block UI
      }
    }

    // Store last detection result on the namespace for UI modules to read
    __PG.lastDetection = {
      field,
      value,
      piiResults,
      injectionResults,
      maskedValue,
      timestamp: Date.now(),
    };

    // ── Show warning banner above the field (with timing) ─
    showBannerWithTiming(field, __PG.lastDetection);
    setFieldState(field, STATES.REVIEW, { detection: __PG.lastDetection });

    // ── Show blocking modal for injection or critical PII ─
    if (__PG.showModal) {
      __PG.showModal(field, __PG.lastDetection);
    }

    // ── Notify background worker to update badge ──────────
    try {
      if (injectionResults.length > 0) {
        chrome.runtime.sendMessage({
          type: 'PG_DETECTION',
          category: 'INJECTION',
          severity: 'INJECTION'
        });
      }
      
      for (const r of piiResults) {
        chrome.runtime.sendMessage({
          type: 'PG_DETECTION',
          category: r.category,
          severity: r.severity
        });
      }
    } catch (err) {
      // Ignore if extension context invalidated
    }

    // ── Apply Actionable Visual Highlight to Field ────────
    if (injectionResults.length > 0) {
      applyHighlight(field, 'INJECTION');
    } else if (piiResults.some(r => r.severity === 'CRITICAL')) {
      applyHighlight(field, 'CRITICAL');
    } else {
      applyHighlight(field, 'PII');
    }
  }


  // ─── Debounce ───────────────────────────────────────────────

  /**
   * Create a debounced handler bound to a specific field.
   * Each field gets its own independent debounce timer, so
   * typing in field A doesn't delay detection in field B.
   *
   * The debounce is the core UX mechanism: it ensures detection
   * only runs when the user PAUSES, never mid-keystroke.
   *
   * @param {Element} field
   * @param {number}  delay — Override debounce delay (for paste vs typing)
   * @returns {function(Event): void}
   */
  function createDebouncedHandler(field, delay = DEBOUNCE_MS) {
    return function (event) {
      if (isProcessing) return;

      const runId = nextRunId(field);
      const existingTimer = debounceTimers.get(field);
      if (existingTimer) clearTimeout(existingTimer);

      // Do not force-hide UI on each keystroke; keep review state stable
      // until the next settled detection pass.
      const state = getFieldState(field);
      if (state.status !== STATES.REVIEW) {
        setFieldState(field, STATES.IDLE, { detection: null });
      }

      const timer = setTimeout(() => {
        handleFieldEvent(event, field, runId);
      }, delay);

      debounceTimers.set(field, timer);
    };
  }


  // ─── Listener Attachment ────────────────────────────────────

  /**
   * Attach input and paste listeners to a single field.
   *
   * Event strategy (intentionally minimal):
   *
   *   - `input`:  Primary event for typing. Fires after value changes.
   *               Debounced to 600ms — detection only runs when user PAUSES.
   *
   *   - `paste`:  Debounced to 600ms — keeps behavior consistent so UI
   *               appears only after a stable pause.
   *
   *   - `keyup`:  REMOVED — too noisy, fires on every key release including
   *               Shift, Ctrl, arrows. The `input` event already covers all
   *               value-changing keystrokes. Removing this halves event noise
   *               and eliminates double-detection on every keystroke.
   *
   * @param {Element} field — The input element to instrument.
   */
  function attachFieldListeners(field) {
    // Guard: don't attach twice
    if (attachedFields.has(field)) return;
    attachedFields.add(field);

    const typingHandler = createDebouncedHandler(field, DEBOUNCE_MS);
    const pasteHandler = createDebouncedHandler(field, PASTE_DELAY_MS);

    // ── Primary: input event (typing + value changes) ─────
    field.addEventListener('input', typingHandler, { passive: true });

    // ── Paste: debounced with shorter delay ────────────────
    // Uses its own debounce timer (same field timer, so typing
    // during paste wait resets correctly).
    field.addEventListener('paste', pasteHandler, { passive: true });

    // User explicitly chose protection: apply mask to the current field.
    field.addEventListener('pg-protect', (event) => {
      const stateDetection = fieldStateMap.get(field)?.detection;
      const eventDetection = event?.detail?.detection;
      const detection = eventDetection || stateDetection || (__PG.lastDetection?.field === field ? __PG.lastDetection : null);
      if (!detection?.maskedValue) return;

      const sourceValue = detection.value || originalValues.get(field) || getFieldValue(field);
      applyMask(field, detection.maskedValue, sourceValue);
      setFieldState(field, STATES.ACTION, { protected: true, detection });
      if (__PG.hideBanner) __PG.hideBanner(field, { immediate: true });
    });

    // User accepted risk: keep original value and skip the next detection pass.
    field.addEventListener('pg-send-anyway', () => {
      if (isFieldMasked(field)) {
        restoreOriginal(field);
      }
      signalInterceptorBypassOnce();
      bypassMap.set(field, true);
      detectionRunIds.set(field, (detectionRunIds.get(field) || 0) + 1);
      setFieldState(field, STATES.ACTION, { bypass: true });
      lastValueMap.set(field, getFieldValue(field));
      if (__PG.hideBanner) __PG.hideBanner(field, { immediate: true });
      clearHighlight(field);
    });

    field.addEventListener('pg-remove-injection', () => {
      setFieldState(field, STATES.ACTION, { protected: false });
      clearHighlight(field);
    });

    // Edit action does not mutate the field value; it only closes UI.
    field.addEventListener('pg-edit', () => {
      setFieldState(field, STATES.ACTION, { bypass: false });
      if (__PG.hideBanner) __PG.hideBanner(field, { immediate: true });
      clearHighlight(field);
      field.focus();
      setFieldState(field, STATES.IDLE);
    });

    // NOTE: keyup listener intentionally removed.
    // It doubled event noise and caused detection to fire twice
    // per keystroke (once on input, once on keyup). The input event
    // reliably fires on all value-changing interactions, including
    // contenteditable elements in modern browsers.
  }

  /**
   * Remove all listeners from a field.
   * Used when the extension is disabled mid-session.
   *
   * NOTE: Since we use anonymous/bound handlers, we track a teardown
   * function per field for clean removal.
   *
   * @param {Element} field
   */
  function detachFieldListeners(field) {
    // Clear any pending debounce timer
    const timer = debounceTimers.get(field);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(field);
    }
    // Remove from tracking so it can be re-attached later
    attachedFields.delete(field);
    lastValueMap.delete(field);
    detectionRunIds.delete(field);
    fieldStateMap.delete(field);
    bypassMap.delete(field);
    // Note: to fully remove listeners, we'd need stored references.
    // For MVP, extension disable disconnects the observer, preventing
    // new processing. Existing listeners become no-ops.
  }


  // ─── Exports (via namespace) ────────────────────────────────
  __PG.attachFieldListeners = attachFieldListeners;
  __PG.detachFieldListeners = detachFieldListeners;
  __PG.getFieldValue = getFieldValue;
  __PG.getFieldType = getFieldType;
  __PG.runDetection = runDetection;
  __PG.applyMask = applyMask;
  __PG.restoreOriginal = restoreOriginal;
  __PG.setFieldValue = setFieldValue;
  __PG.bypassMap = bypassMap;
  __PG.fieldStateMap = fieldStateMap;
  __PG.getFieldState = getFieldState;
  __PG.originalValues = originalValues;

})();
