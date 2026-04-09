/**
 * PrivacyGuard — Content Script
 *
 * Runs on every webpage at document_start. Discovers all input-like
 * elements (input, textarea, contenteditable), watches for dynamically
 * added ones via MutationObserver, and wires up detection.
 *
 * Performance constraints:
 *   - MutationObserver debounced to 200ms to survive React/SPA re-renders
 *   - Processed nodes tracked via WeakSet (no duplicate work)
 *   - Only element additions tracked (attribute changes ignored)
 *
 * NOTE: Content scripts cannot use ES modules, so this is a plain IIFE.
 *       Detection engine modules will be inlined/bundled in a later step.
 */

(function PrivacyGuardContentScript() {
  'use strict';

  const TAG = '[PrivacyGuard]';

  // ─── State ──────────────────────────────────────────────────
  /** Tracks fields we've already processed to avoid duplicate work. */
  const processedFields = new WeakSet();

  /** MutationObserver instance (stored so we can disconnect on disable). */
  let observer = null;

  /** Debounce timer ID for batching observer callbacks. */
  let debounceTimer = null;

  /** Debounce interval (ms) — prevents avalanche on SPA re-renders. */
  const DEBOUNCE_MS = 200;

  /** CSS selector for all input-like elements we care about. */
  const INPUT_SELECTOR = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="image"]):not([type="range"]):not([type="color"])',
    'textarea',
    '[contenteditable]:not([contenteditable="false"])'
  ].join(', ');


  // ─── Field Discovery ───────────────────────────────────────

  /**
   * Find all input-like elements within a root node.
   *
   * @param {Element|Document} root — The DOM subtree to search.
   * @returns {Element[]} — Matching input elements.
   */
  function findInputFields(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];

    const fields = Array.from(root.querySelectorAll(INPUT_SELECTOR));

    // If root itself is an input-like element, include it
    if (root.matches && root.matches(INPUT_SELECTOR)) {
      fields.unshift(root);
    }

    return fields;
  }


  // ─── Field Processing ──────────────────────────────────────

  /**
   * Process a single input field:
   *   - Skip if already processed (WeakSet guard)
   *   - Mark as processed
   *   - Log discovery (will attach listeners in fieldScanner step)
   *
   * @param {Element} field — The input element to process.
   */
  function processField(field) {
    // De-duplicate: skip nodes we've already seen
    if (processedFields.has(field)) return;
    processedFields.add(field);

    // Determine field type for logging
    const tag = field.tagName.toLowerCase();
    const type = field.getAttribute('type') || '';
    const descriptor = field.isContentEditable
      ? '[contenteditable]'
      : type
        ? `<${tag} type="${type}">`
        : `<${tag}>`;

    // Attach input/paste/keyup listeners (from fieldScanner.js)
    if (window.__PrivacyGuard && window.__PrivacyGuard.attachFieldListeners) {
      window.__PrivacyGuard.attachFieldListeners(field);
    }
  }

  // ─── Initial Scan ──────────────────────────────────────────

  /**
   * Scan the entire document for existing input fields.
   * Called once after DOM is ready.
   */
  function scanExistingFields() {
    const fields = findInputFields(document);
    fields.forEach(processField);
  }


  // ─── MutationObserver ──────────────────────────────────────

  /**
   * Handle a batch of MutationRecords.
   *
   * Strategy:
   *   1. Collect all added nodes from the mutation batch.
   *   2. For each added element, search it for input fields.
   *   3. Process any newly found fields.
   *
   * This runs AFTER the debounce window, so rapid React re-renders
   * result in a single scan, not thousands.
   *
   * @param {MutationRecord[]} mutations
   */
  function handleMutations(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        // Skip text nodes, comments, etc. — only process elements
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Check if the added node itself is an input
        const fields = findInputFields(node);
        fields.forEach(processField);
      }
    }
  }

  /**
   * Debounced wrapper around handleMutations.
   *
   * Batches rapid-fire observer callbacks into a single processing pass
   * after 200ms of quiet. This is CRITICAL for SPA performance —
   * React can trigger 50+ mutations per render cycle.
   *
   * @param {MutationRecord[]} mutations
   */
  function debouncedMutationHandler(mutations) {
    // Accumulate mutations during the debounce window
    if (!debouncedMutationHandler._pending) {
      debouncedMutationHandler._pending = [];
    }
    debouncedMutationHandler._pending.push(...mutations);

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const batch = debouncedMutationHandler._pending;
      debouncedMutationHandler._pending = [];
      handleMutations(batch);
    }, DEBOUNCE_MS);
  }

  /**
   * Start observing the DOM for dynamically added input fields.
   * Only watches for child additions in the full subtree —
   * attribute changes and character data are ignored.
   */
  function observeDOM() {
    if (!document.body) {
      console.warn(`${TAG} document.body not available; observer deferred.`);
      return;
    }

    observer = new MutationObserver(debouncedMutationHandler);

    observer.observe(document.body, {
      childList: true,   // Watch for added/removed child nodes
      subtree: true,     // Watch the entire subtree, not just direct children
      attributes: false, // Ignore attribute changes (perf)
      characterData: false,
    });

  }

  /**
   * Stop the MutationObserver and clean up.
   * Called when the extension is disabled or the page unloads.
   */
  function disconnectObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(debounceTimer);
  }


  // ─── Initialization ────────────────────────────────────────

  /**
   * Main entry point.
   *
   * Because the content script runs at document_start, document.body
   * may not exist yet. We handle two cases:
   *   1. Body exists → scan + observe immediately.
   *   2. Body doesn't exist → wait for DOMContentLoaded.
   */
  function init() {
    if (document.body) {
      bootstrap();
    } else {
      // document_start fires before body exists; wait for it
      document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    }
  }

  /**
   * Bootstrap after body is available:
   *   1. Scan for existing fields.
   *   2. Start MutationObserver for future fields.
   */
  function bootstrap() {
    scanExistingFields();
    observeDOM();
  }


  // ─── Lifecycle ─────────────────────────────────────────────

  // Listen for extension disable message from background worker
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'PRIVACYGUARD_DISABLE') {
        disconnectObserver();
      }
      if (msg?.type === 'PRIVACYGUARD_ENABLE') {
        bootstrap();
      }
    });
  }

  // Clean up on page unload
  window.addEventListener('unload', disconnectObserver, { once: true });

  // ─── Network Interceptor Injection ─────────────────────────
  /**
   * Injects the interceptor script into the MAIN world to patch native
   * fetch and XHR before page scripts can cache references to them.
   */
  function injectInterceptor() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('dist/interceptor.bundle.js');
      // Clean up DOM after script executes
      script.onload = () => script.remove();
      const parent = document.head || document.documentElement;
      if (parent) {
        parent.appendChild(script);
      }
    } catch (e) {
      console.warn(`${TAG} Failed to inject interceptor`, e);
    }
  }

  // ─── Start ─────────────────────────────────────────────────
  injectInterceptor();
  init();

})();
