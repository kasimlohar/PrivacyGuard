/**
 * PrivacyGuard — Popup UI Logic
 * Handles the display of recent detections, allowlist, and global toggle.
 */

import {
  isEnabled,
  setEnabled,
  getDetections,
  clearDetections,
  getAllowlist,
  addToAllowlist,
  removeFromAllowlist
} from '../utils/storage.js';

// DOM Elements
const els = {
  enableToggle: document.getElementById('enableToggle'),
  statusLabel: document.getElementById('statusLabel'),
  detectionsList: document.getElementById('detectionsList'),
  detectionCount: document.getElementById('detectionCount'),
  allowlistForm: document.getElementById('allowlistForm'),
  domainInput: document.getElementById('domainInput'),
  allowlistContainer: document.getElementById('allowlistContainer'),
  clearBtn: document.getElementById('clearBtn')
};

// ─── Initialization ──────────────────────────────────────────

async function init() {
  await renderToggle();
  await renderDetections();
  await renderAllowlist();
  bindEvents();
}

// ─── Renderers ───────────────────────────────────────────────

async function renderToggle() {
  const enabled = await isEnabled();
  els.enableToggle.checked = enabled;
  updateStatusLabel(enabled);
}

function updateStatusLabel(enabled) {
  els.statusLabel.textContent = enabled ? 'ON' : 'OFF';
  if (enabled) {
    els.statusLabel.classList.remove('off');
  } else {
    els.statusLabel.classList.add('off');
  }
}

async function renderDetections() {
  const detections = await getDetections(5); // max 5 items
  els.detectionCount.textContent = detections.length;

  if (detections.length === 0) {
    els.detectionsList.innerHTML = '<div class="empty-state">No recent activity.</div>';
    return;
  }

  els.detectionsList.innerHTML = detections.map(d => `
    <div class="detection-card">
      <div class="detection-card-header">
        <span class="detection-domain" title="${escapeHtml(d.domain)}">${escapeHtml(d.domain)}</span>
        <span class="detection-time">${timeAgo(d.timestamp)}</span>
      </div>
      <div class="detection-details">
        <span class="detection-category">${escapeHtml(d.category)}</span>
        <span class="detection-value">${escapeHtml(d.maskedValue || 'Prompt Injection')}</span>
      </div>
    </div>
  `).join('');
}

async function renderAllowlist() {
  const domains = await getAllowlist();

  if (domains.length === 0) {
    els.allowlistContainer.innerHTML = '<div class="empty-state">No domains allowed.</div>';
    return;
  }

  els.allowlistContainer.innerHTML = domains.map(domain => `
    <div class="allowlist-item">
      <span class="allowlist-item-domain">${escapeHtml(domain)}</span>
      <button class="btn-remove" data-domain="${escapeHtml(domain)}" title="Remove">✕</button>
    </div>
  `).join('');
}

// ─── Event Binding ───────────────────────────────────────────

function bindEvents() {
  // Toggle extension
  els.enableToggle.addEventListener('change', async (e) => {
    const isChecked = e.target.checked;
    await setEnabled(isChecked);
    updateStatusLabel(isChecked);
  });

  // Clear tracking history
  els.clearBtn.addEventListener('click', async () => {
    await clearDetections();
    await renderDetections();
  });

  // Add to allowlist
  els.allowlistForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const domain = els.domainInput.value.trim().toLowerCase();
    if (domain) {
      // Basic validation: just ensure it looks somewhat like a hostname (could use proper regex).
      await addToAllowlist(domain);
      els.domainInput.value = '';
      await renderAllowlist();
    }
  });

  // Remove from allowlist (Event Delegation)
  els.allowlistContainer.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-remove');
    if (btn) {
      const domain = btn.dataset.domain;
      await removeFromAllowlist(domain);
      await renderAllowlist();
    }
  });

  // Listen for storage changes in case content script makes a detection while popup is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['privacyguard_detections']) {
      renderDetections();
    }
  });
}

// ─── Utilities ───────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(timestamp) {
  const secondsPast = Math.floor((Date.now() - timestamp) / 1000);
  if (secondsPast < 60) return 'Just now';
  if (secondsPast < 3600) return `${Math.floor(secondsPast / 60)} min ago`;
  if (secondsPast <= 86400) return `${Math.floor(secondsPast / 3600)} h ago`;
  return `${Math.floor(secondsPast / 86400)} d ago`;
}

// ─── Boot ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
