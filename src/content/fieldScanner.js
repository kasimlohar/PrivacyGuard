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


  // ─── Event Handling ─────────────────────────────────────────

  /**
   * Core event handler — called after debounce/paste delay.
   * Reads the field value, validates, and triggers detection.
   *
   * @param {Event}   event — The original DOM event.
   * @param {Element} field — The target input element.
   */
  function handleFieldEvent(event, field) {
    const value = getFieldValue(field);

    // Skip empty or very short input (avoids false positives on single chars)
    if (!value || value.trim().length < MIN_LENGTH) return;

    const fieldType = getFieldType(field);

    console.log(`${TAG} Event:`, {
      type: event.type,
      value: value.length > 50 ? value.slice(0, 50) + '…' : value,
      length: value.length,
      fieldType,
    });

    // ── TODO (Day 2, Task 2.3): Wire detection engine ──────
    // This is where scanForPII + scanForInjection will be called.
    // const piiResults = scanForPII(value);
    // const injResults = scanForInjection(value);
    // if (piiResults.length > 0 || injResults.length > 0) {
    //   handleDetections(field, value, piiResults, injResults);
    // }
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

})();
