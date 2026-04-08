/**
 * PrivacyGuard — Regex Detection Engine
 *
 * Pure-function PII, payment, and credential regex battery.
 * Zero browser API dependencies — fully testable in Node.
 *
 * Performance target: < 10ms for typical input (< 5000 chars).
 *
 * @module regexEngine
 */

import { CATEGORY, SEVERITY, SEVERITY_WEIGHT } from '../utils/constants.js';

// ─── Detection Rules ────────────────────────────────────────────
// Each rule: { id, name, pattern (global), category, severity }
// Patterns sourced from PRD §8.1, hardened for space/dash variants.

const RULES = [

  // ── Payment ───────────────────────────────────────────────────
  {
    id: 'CC-01',
    name: 'Credit/Debit Card',
    // Visa (4xxx), Mastercard (51-55xx), Amex (34/37xx), Discover (6011/65xx)
    // Tolerates optional spaces or dashes between groups.
    // No Luhn check — structural match only (PRD: test cards are still flagged).
    pattern:
      /\b(?:4[0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}[\s-]?[0-9]{4}|5[1-5][0-9]{2}[\s-]?[0-9]{4}[\s-]?[0-9]{4}[\s-]?[0-9]{4}|3[47][0-9]{2}[\s-]?[0-9]{6}[\s-]?[0-9]{5}|6(?:011|5[0-9]{2})[\s-]?[0-9]{4}[\s-]?[0-9]{4}[\s-]?[0-9]{4})\b/g,
    category: CATEGORY.PAYMENT,
    severity: SEVERITY.HIGH,
  },

  // ── PII ───────────────────────────────────────────────────────
  {
    id: 'SSN-01',
    name: 'US Social Security Number',
    // Format: AAA-GG-SSSS with exclusions for invalid ranges
    // Area: not 000, 666, or 900-999 | Group: not 00 | Serial: not 0000
    pattern: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    category: CATEGORY.PII,
    severity: SEVERITY.HIGH,
  },
  {
    id: 'AADHAAR-01',
    name: 'Aadhaar Number (India)',
    // 12 digits starting with 2-9, optionally space-separated in groups of 4
    pattern: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g,
    category: CATEGORY.PII,
    severity: SEVERITY.HIGH,
  },
  {
    id: 'PAN-01',
    name: 'PAN Card (India)',
    // Format: AAAAA9999A (5 uppercase + 4 digits + 1 uppercase)
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    category: CATEGORY.PII,
    severity: SEVERITY.HIGH,
  },
  {
    id: 'EMAIL-01',
    name: 'Email Address',
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    category: CATEGORY.PII,
    severity: SEVERITY.MEDIUM,
  },
  {
    id: 'PHONE-01',
    name: 'Phone Number',
    // Branch 1: Indian mobile (+91 optional, starts 6-9, 10 digits)
    // Branch 2: US/intl (+1 optional, 3-3-4 with optional separators)
    pattern:
      /(?:\+91[\-\s]?)?[6-9]\d{9}\b|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    category: CATEGORY.PII,
    severity: SEVERITY.MEDIUM,
  },

  // ── Credentials ───────────────────────────────────────────────
  {
    id: 'APIKEY-01',
    name: 'API Key / Secret',
    // Common prefixes: sk-, pk_, rk_, ghp_, glpat-, AIza
    // Minimum 20 chars after prefix to avoid short false-positives
    pattern: /\b(?:sk-|pk_|rk_|ghp_|glpat-|AIza)[A-Za-z0-9\-_]{20,}\b/g,
    category: CATEGORY.CREDENTIAL,
    severity: SEVERITY.CRITICAL,
  },
  {
    id: 'PWD-01',
    name: 'Password in Context',
    // Keyword followed by = or : then a value ≥ 6 chars
    // match[0] = full context ("password=MySecret"), match[1] = value only
    pattern: /(?:password|passwd|pwd|pass)\s*[=:]\s*['"]?([^\s'"&]{6,})/gi,
    category: CATEGORY.CREDENTIAL,
    severity: SEVERITY.CRITICAL,
  },
  {
    id: 'DBCONN-01',
    name: 'Database Connection String',
    // mongodb://, postgres://, mysql://, redis:// with user:pass@host
    pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
    category: CATEGORY.CREDENTIAL,
    severity: SEVERITY.CRITICAL,
  },
  {
    id: 'BEARER-01',
    name: 'Bearer Token',
    // "Bearer " + 20 or more base64/URL-safe chars + optional padding
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+\/]{20,}=*/g,
    category: CATEGORY.CREDENTIAL,
    severity: SEVERITY.HIGH,
  },
];


// ─── Core Scan Function ─────────────────────────────────────────

/**
 * Scan text for PII, payment data, and credential patterns.
 *
 * @param {string} text — The input text to scan.
 * @returns {DetectionResult[]} — Matched detections sorted by startIndex.
 *
 * DetectionResult shape:
 *   { ruleId, category, severity, matchText, startIndex, endIndex }
 */
function scanForPII(text) {
  // Guard: invalid input → empty results (fail silent)
  if (!text || typeof text !== 'string' || text.length === 0) {
    return [];
  }

  const allMatches = [];

  for (const rule of RULES) {
    // CRITICAL: Global regexes are stateful — reset before each scan
    // Without this, consecutive calls skip matches.
    rule.pattern.lastIndex = 0;

    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      allMatches.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        matchText: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });

      // Safety valve: prevent infinite loop on zero-length matches
      if (match[0].length === 0) {
        rule.pattern.lastIndex++;
      }
    }
  }

  // De-duplicate overlapping matches — keep highest severity
  const resolved = resolveOverlaps(allMatches);

  // Final sort by position in text
  resolved.sort((a, b) => a.startIndex - b.startIndex);

  return resolved;
}


// ─── Overlap Resolution ─────────────────────────────────────────

/**
 * Resolve overlapping detection ranges.
 *
 * Strategy (greedy sweep):
 *   1. Sort by startIndex (ascending), then severity (descending).
 *   2. Walk forward: if current overlaps with last-kept, replace last-kept
 *      only if current has higher severity (or same severity + longer span).
 *   3. If no overlap, keep both.
 *
 * Time: O(n log n) sort + O(n) sweep.
 *
 * @param {DetectionResult[]} matches
 * @returns {DetectionResult[]}
 */
function resolveOverlaps(matches) {
  if (matches.length <= 1) return [...matches];

  // Sort: position first, then severity descending for tie-breaking
  const sorted = [...matches].sort((a, b) => {
    if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
    return (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0);
  });

  const kept = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = kept[kept.length - 1];
    const curr = sorted[i];

    // Two ranges overlap if curr starts before prev ends
    const overlaps = curr.startIndex < prev.endIndex;

    if (overlaps) {
      const prevWeight = SEVERITY_WEIGHT[prev.severity] || 0;
      const currWeight = SEVERITY_WEIGHT[curr.severity] || 0;
      const prevSpan = prev.endIndex - prev.startIndex;
      const currSpan = curr.endIndex - curr.startIndex;

      // Replace prev with curr if curr is strictly more important
      if (currWeight > prevWeight || (currWeight === prevWeight && currSpan > prevSpan)) {
        kept[kept.length - 1] = curr;
      }
      // Otherwise silently discard curr (prev wins)
    } else {
      kept.push(curr);
    }
  }

  return kept;
}


// ─── Exports ────────────────────────────────────────────────────
export { scanForPII, RULES };
