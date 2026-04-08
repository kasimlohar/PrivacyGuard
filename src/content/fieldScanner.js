/**
 * PrivacyGuard — Field Scanner
 *
 * Attaches event listeners (input, paste, keyup) to input fields discovered
 * by the content script. Events are debounced per-field to prevent excessive
 * firing during typing, while paste events get fast-tracked for quick detection.
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
  const DEBOUNCE_MS = 200;   // Debounce for typing (input + keyup)
  const PASTE_DELAY_MS = 10; // Small delay after paste for value to settle
  const MIN_LENGTH = 3;      // Ignore values shorter than this

  // ─── State ──────────────────────────────────────────────────
  /** Prevent duplicate listener attachment. */
  const attachedFields = new WeakSet();

  /** Per-field debounce timers — one timer per field. */
  const debounceTimers = new WeakMap();

  /** Stores original (unmasked) values so the user can restore them. */
  const originalValues = new WeakMap();

  /**
   * Guard flag — set to true while we're programmatically changing a field
   * value. Prevents our own input listeners from re-triggering detection
   * on the masked text we just wrote.
   */
  let isMasking = false;


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
    if (maskedValue === originalVal) return;

    // Store original so user can restore later
    originalValues.set(field, originalVal);

    // Save cursor before we mutate the value
    const cursorPos = getCursorPosition(field);

    // Set guard — our own event listeners will see this and skip
    isMasking = true;

    try {
      if (field.isContentEditable) {
        field.innerText = maskedValue;
      } else {
        field.value = maskedValue;
      }

      // Mark element so CSS/UI can target it
      field.dataset.privacyguardMasked = 'true';

      // Restore cursor (approximate — length may have changed)
      if (cursorPos >= 0) {
        setCursorPosition(field, cursorPos);
      }
    } finally {
      // Always clear the guard, even if something throws
      isMasking = false;
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

    isMasking = true;
    try {
      if (field.isContentEditable) {
        field.innerText = original;
      } else {
        field.value = original;
      }
      delete field.dataset.privacyguardMasked;
      originalValues.delete(field);
    } finally {
      isMasking = false;
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


  // ─── Event Handling ─────────────────────────────────────────

  /**
   * Core event handler — called after debounce/paste delay.
   * Reads the field value, validates, runs detection, and logs results.
   *
   * @param {Event}   event — The original DOM event.
   * @param {Element} field — The target input element.
   */
  async function handleFieldEvent(event, field) {
    // Guard: skip if we're the ones changing the value (prevents loops)
    if (isMasking) return;

    // Guard: skip if extension is disabled
    if (__PG.isEnabled) {
      const enabled = await __PG.isEnabled();
      if (!enabled) return;
    }

    // Guard: skip if this domain is allowlisted
    if (__PG.isAllowed) {
      try {
        const domain = location.hostname;
        const allowed = await __PG.isAllowed(domain);
        if (allowed) return;
      } catch {
        // If storage fails, continue with detection
      }
    }

    const value = getFieldValue(field);

    // Skip empty or very short input (avoids false positives on single chars)
    if (!value || value.trim().length < MIN_LENGTH) return;

    // Run detection pipeline
    const { piiResults, injectionResults, maskedValue } = runDetection(value);

    // Early exit if nothing detected
    if (piiResults.length === 0 && injectionResults.length === 0) return;

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

    // ── Apply in-field masking (PII only, NOT injection) ───
    if (piiResults.length > 0 && maskedValue) {
      applyMask(field, maskedValue, value);

      // ── Persist detections to chrome.storage ────────────
      if (__PG.addDetection) {
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

    // ── Show warning banner above the field ───────────────
    if (__PG.showBanner) {
      __PG.showBanner(field, __PG.lastDetection);
    }

    // ── Show blocking modal for injection or critical PII ─
    if (__PG.showModal) {
      __PG.showModal(field, __PG.lastDetection);
    }
  }


  // ─── Debounce ───────────────────────────────────────────────

  /**
   * Create a debounced handler bound to a specific field.
   * Each field gets its own independent debounce timer, so
   * typing in field A doesn't delay detection in field B.
   *
   * @param {Element} field
   * @returns {function(Event): void}
   */
  function createDebouncedHandler(field) {
    return function (event) {
      const existingTimer = debounceTimers.get(field);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        handleFieldEvent(event, field);
      }, DEBOUNCE_MS);

      debounceTimers.set(field, timer);
    };
  }


  // ─── Listener Attachment ────────────────────────────────────

  /**
   * Attach input/paste/keyup listeners to a single field.
   *
   * - `input`: Primary event for typing. Fires after value changes.
   *            Debounced to avoid avalanche during fast typing.
   *
   * - `paste`: Fires BEFORE the pasted content appears in the field.
   *            We use a short setTimeout to read the updated value,
   *            then process IMMEDIATELY (no debounce) because paste
   *            is a deliberate action that may be followed by instant submit.
   *
   * - `keyup`: Fallback for edge cases where `input` doesn't fire
   *            reliably (some contenteditable implementations).
   *            Debounced alongside input.
   *
   * @param {Element} field — The input element to instrument.
   */
  function attachFieldListeners(field) {
    // Guard: don't attach twice
    if (attachedFields.has(field)) return;
    attachedFields.add(field);

    const debouncedHandler = createDebouncedHandler(field);

    // ── Primary: input event (typing + value changes) ─────
    field.addEventListener('input', debouncedHandler, { passive: true });

    // ── Paste: fast-track with minimal delay ──────────────
    // Paste fires before value updates → wait a tick, then
    // process immediately (skip debounce for responsiveness).
    field.addEventListener('paste', (event) => {
      setTimeout(() => {
        handleFieldEvent(event, field);
      }, PASTE_DELAY_MS);
    }, { passive: true });

    // ── Fallback: keyup for contenteditable edge cases ────
    field.addEventListener('keyup', debouncedHandler, { passive: true });
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
  __PG.originalValues = originalValues;

})();
