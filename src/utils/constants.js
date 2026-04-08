/**
 * PrivacyGuard — Shared Constants
 * Enums, severity levels, AI domain list, and category definitions.
 */

// ─── Detection Categories ───────────────────────────────────────
export const CATEGORY = Object.freeze({
  PAYMENT: 'PAYMENT',
  PII: 'PII',
  CREDENTIAL: 'CREDENTIAL',
  INJECTION: 'INJECTION',
  NONE: 'NONE',
});

// ─── Severity Levels ────────────────────────────────────────────
export const SEVERITY = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});

// ─── Severity Weight (for sorting / de-duplication) ─────────────
export const SEVERITY_WEIGHT = Object.freeze({
  [SEVERITY.CRITICAL]: 4,
  [SEVERITY.HIGH]: 3,
  [SEVERITY.MEDIUM]: 2,
  [SEVERITY.LOW]: 1,
});

// ─── AI Domains (LLM fallback fires only on these) ─────────────
export const AI_DOMAINS = Object.freeze([
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
  'perplexity.ai',
]);

// ─── PostMessage Event Types (content ↔ interceptor bridge) ────
export const MSG = Object.freeze({
  BLOCK: 'PRIVACYGUARD_BLOCK',
  ALLOW: 'PRIVACYGUARD_ALLOW',
  LLM_CLASSIFY: 'PRIVACYGUARD_LLM_CLASSIFY',
  TOGGLE: 'PRIVACYGUARD_TOGGLE',
  GET_STATUS: 'PRIVACYGUARD_GET_STATUS',
  LOG_DETECTION: 'PRIVACYGUARD_LOG_DETECTION',
});

// ─── Storage Keys ───────────────────────────────────────────────
export const STORAGE_KEYS = Object.freeze({
  ENABLED: 'privacyguard_enabled',
  ALLOWLIST: 'privacyguard_allowlist',
  DETECTIONS: 'privacyguard_detections',
  API_KEY: 'privacyguard_api_key',
});

// ─── Detection Limits ───────────────────────────────────────────
export const LIMITS = Object.freeze({
  MAX_DETECTIONS_LOG: 50,
  LOG_RETENTION_DAYS: 7,
  LLM_TIMEOUT_MS: 2000,
  LLM_MIN_TEXT_LENGTH: 50,
  LLM_CONFIDENCE_THRESHOLD: 0.75,
  DEBOUNCE_MS: 200,
  MAX_LLM_INPUT_CHARS: 2000,
});
