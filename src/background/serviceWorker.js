/**
 * PrivacyGuard — Background Service Worker
 *
 * Handles background tasks such as dynamic extension badge updates
 * based on real-time detections from the content script.
 * Keeps an in-memory counter per tab for performance.
 *
 * @module serviceWorker
 */

const TAG = '[PrivacyGuard BG]';

// ─── State ──────────────────────────────────────────────────
// In-memory store: tabId -> { count: number, highestSeverity: string }
const tabDetections = new Map();

// Severity colors
const COLORS = Object.freeze({
  INJECTION: '#ef4444', // Red
  CRITICAL: '#f97316',  // Orange
  HIGH: '#f97316',      // Orange (fallback)
  MEDIUM: '#eab308',    // Yellow
  LOW: '#eab308'        // Yellow (fallback)
});

// Severity rank for determining overriding color
const SEVERITY_RANK = {
  INJECTION: 4,
  CRITICAL: 3,
  HIGH: 2,
  MEDIUM: 1,
  LOW: 0
};

// ─── Badge Logic ──────────────────────────────────────────────

/**
 * Updates the extension badge for a specific tab.
 * @param {number} tabId
 */
function updateBadge(tabId) {
  const data = tabDetections.get(tabId);
  if (!data || data.count === 0) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  // Determine text
  let text = data.highestSeverity === 'INJECTION' && data.count === 0 ? '!' : data.count.toString();
  if (data.count > 9) text = '9+';

  // Determine color
  const color = COLORS[data.highestSeverity] || COLORS.LOW;

  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
}

// ─── Listeners ───────────────────────────────────────────────

// 1. Listen for detections from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PG_DETECTION' && sender.tab) {
    const tabId = sender.tab.id;
    let data = tabDetections.get(tabId) || { count: 0, highestSeverity: 'LOW' };

    // Update count (ignoring injection base counter if we want, but let's just count all)
    data.count += 1;

    // Determine severity
    let incomingSeverity = msg.severity || 'LOW';
    if (msg.category === 'INJECTION') {
      incomingSeverity = 'INJECTION';
    }

    // Determine if we need to promote the highest severity
    const currentRank = SEVERITY_RANK[data.highestSeverity] || 0;
    const incomingRank = SEVERITY_RANK[incomingSeverity] || 0;

    if (incomingRank > currentRank) {
      data.highestSeverity = incomingSeverity;
    }

    tabDetections.set(tabId, data);
    updateBadge(tabId);
  }
  // Let MV3 know we don't need async response
  return false; 
});

// 2. Clear badge on page reload/navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') { // Page is navigating/reloading
    tabDetections.delete(tabId);
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

// 3. Clean up memory when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabDetections.delete(tabId);
});

console.log(`${TAG} Service worker initialized.`);
