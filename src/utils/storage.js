/**
 * PrivacyGuard — Storage Abstraction Layer
 *
 * Promise-based wrapper around chrome.storage.local for:
 *   - Detection log (FIFO, max 50 entries)
 *   - Domain allowlist (exact match)
 *   - Extension enabled/disabled toggle
 *
 * MV3's chrome.storage.local natively returns Promises.
 * All functions are safe against empty/missing storage.
 *
 * @module storage
 */

import { STORAGE_KEYS } from './constants.js';

// ─── Constants ──────────────────────────────────────────────────
const MAX_DETECTIONS = 50;


// ─── Low-Level Helpers ──────────────────────────────────────────

/**
 * Read a value from chrome.storage.local.
 * Returns `defaultValue` if the key doesn't exist or storage is unavailable.
 *
 * @param {string} key
 * @param {*}      defaultValue
 * @returns {Promise<*>}
 */
async function getFromStorage(key, defaultValue = null) {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] !== undefined ? result[key] : defaultValue;
  } catch (err) {
    console.warn('[PrivacyGuard] Storage read error:', err);
    return defaultValue;
  }
}

/**
 * Write a value to chrome.storage.local.
 *
 * @param {string} key
 * @param {*}      value
 * @returns {Promise<void>}
 */
async function setToStorage(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (err) {
    console.warn('[PrivacyGuard] Storage write error:', err);
  }
}


// ─── Extension Toggle ───────────────────────────────────────────

/**
 * Set the extension enabled/disabled state.
 *
 * @param {boolean} state — true = enabled, false = disabled.
 * @returns {Promise<void>}
 */
async function setEnabled(state) {
  await setToStorage(STORAGE_KEYS.ENABLED, !!state);
}

/**
 * Check if the extension is enabled.
 * Defaults to `true` if not previously set.
 *
 * @returns {Promise<boolean>}
 */
async function isEnabled() {
  return await getFromStorage(STORAGE_KEYS.ENABLED, true);
}


// ─── Domain Allowlist ───────────────────────────────────────────

/**
 * Get the full allowlist array.
 *
 * @returns {Promise<string[]>}
 */
async function getAllowlist() {
  return await getFromStorage(STORAGE_KEYS.ALLOWLIST, []);
}

/**
 * Add a domain to the allowlist.
 * Normalizes to lowercase. Prevents duplicates.
 *
 * @param {string} domain — e.g. "chatgpt.com"
 * @returns {Promise<void>}
 */
async function addToAllowlist(domain) {
  if (!domain || typeof domain !== 'string') return;

  const normalized = domain.toLowerCase().trim();
  const list = await getAllowlist();

  // Prevent duplicates
  if (list.includes(normalized)) return;

  list.push(normalized);
  await setToStorage(STORAGE_KEYS.ALLOWLIST, list);
}

/**
 * Remove a domain from the allowlist.
 *
 * @param {string} domain
 * @returns {Promise<void>}
 */
async function removeFromAllowlist(domain) {
  if (!domain || typeof domain !== 'string') return;

  const normalized = domain.toLowerCase().trim();
  const list = await getAllowlist();
  const filtered = list.filter(d => d !== normalized);

  await setToStorage(STORAGE_KEYS.ALLOWLIST, filtered);
}

/**
 * Check if a domain is in the allowlist (exact match).
 *
 * @param {string} domain
 * @returns {Promise<boolean>}
 */
async function isAllowed(domain) {
  if (!domain || typeof domain !== 'string') return false;

  const normalized = domain.toLowerCase().trim();
  const list = await getAllowlist();

  return list.includes(normalized);
}


// ─── Detection Log ──────────────────────────────────────────────

/**
 * Add a detection entry to the log.
 *
 * Entry shape:
 *   {
 *     id: string,         — Unique ID (generated if missing)
 *     domain: string,     — The domain where PII was detected
 *     category: string,   — PAYMENT | PII | CREDENTIAL
 *     severity: string,   — LOW | MEDIUM | HIGH | CRITICAL
 *     ruleId: string,     — The rule that fired (e.g. "CC-01")
 *     maskedValue: string, — The masked representation
 *     timestamp: number   — Unix timestamp (generated if missing)
 *   }
 *
 * Enforces FIFO: oldest entries are removed when limit (50) is exceeded.
 *
 * @param {object} entry
 * @returns {Promise<void>}
 */
async function addDetection(entry) {
  if (!entry || typeof entry !== 'object') return;

  // Ensure required fields have defaults
  const record = {
    id: entry.id || generateId(),
    domain: entry.domain || 'unknown',
    category: entry.category || 'UNKNOWN',
    severity: entry.severity || 'MEDIUM',
    ruleId: entry.ruleId || '',
    maskedValue: entry.maskedValue || '',
    timestamp: entry.timestamp || Date.now(),
  };

  const log = await getFromStorage(STORAGE_KEYS.DETECTIONS, []);

  // Add new entry at the front (newest first)
  log.unshift(record);

  // Trim to max size (FIFO — drop oldest from the end)
  if (log.length > MAX_DETECTIONS) {
    log.length = MAX_DETECTIONS;
  }

  await setToStorage(STORAGE_KEYS.DETECTIONS, log);
}

/**
 * Retrieve recent detection entries.
 *
 * @param {number} limit — Max number of entries to return (default 10).
 * @returns {Promise<object[]>} — Newest first.
 */
async function getDetections(limit = 10) {
  const log = await getFromStorage(STORAGE_KEYS.DETECTIONS, []);
  return log.slice(0, Math.max(0, limit));
}

/**
 * Clear all detection history.
 *
 * @returns {Promise<void>}
 */
async function clearDetections() {
  await setToStorage(STORAGE_KEYS.DETECTIONS, []);
}

/**
 * Get the total count of stored detections.
 *
 * @returns {Promise<number>}
 */
async function getDetectionCount() {
  const log = await getFromStorage(STORAGE_KEYS.DETECTIONS, []);
  return log.length;
}


// ─── Utilities ──────────────────────────────────────────────────

/**
 * Generate a short unique ID for detection entries.
 * Uses timestamp + random suffix for collision avoidance.
 *
 * @returns {string}
 */
function generateId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}


// ─── Exports ────────────────────────────────────────────────────
export {
  // Toggle
  setEnabled,
  isEnabled,

  // Allowlist
  addToAllowlist,
  removeFromAllowlist,
  isAllowed,
  getAllowlist,

  // Detection log
  addDetection,
  getDetections,
  clearDetections,
  getDetectionCount,

  // Low-level (for advanced use)
  getFromStorage,
  setToStorage,
};
