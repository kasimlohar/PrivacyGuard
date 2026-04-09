/**
 * PrivacyGuard — Masking Engine
 *
 * Transforms detected sensitive values into safe, human-readable masked forms.
 * Pure JavaScript — no browser API dependencies.
 *
 * Each masking strategy preserves enough structure for the user to recognise
 * WHAT was detected, while redacting the sensitive payload.
 *
 * @module masker
 */

// ─── Per-Rule Masking Strategies ────────────────────────────────

/**
 * Credit/Debit Card → "4111 **** **** 1111"
 * Strip non-digits, show first 4 + last 4, mask middle.
 */
function maskCreditCard(text) {
  const digits = text.replace(/\D/g, '');
  if (digits.length < 8) return '*'.repeat(text.length); // fallback for very short
  const first4 = digits.slice(0, 4);
  const last4 = digits.slice(-4);
  return `${first4} **** **** ${last4}`;
}

/**
 * US SSN → "***-**-6789"
 * Mask area + group, show serial (last 4).
 */
function maskSSN(text) {
  const digits = text.replace(/\D/g, '');
  if (digits.length < 4) return '***-**-****';
  return `***-**-${digits.slice(-4)}`;
}

/**
 * Aadhaar → "**** **** 0123"
 * Mask first 8 digits, show last 4.
 */
function maskAadhaar(text) {
  const digits = text.replace(/\D/g, '');
  if (digits.length < 4) return '**** **** ****';
  return `**** **** ${digits.slice(-4)}`;
}

/**
 * PAN Card → "ABCDE****F"
 * Show first 5 chars + last 1 char, mask middle 4 digits.
 */
function maskPAN(text) {
  if (text.length < 6) return '*'.repeat(text.length);
  return `${text.slice(0, 5)}****${text.slice(-1)}`;
}

/**
 * Email → "a****@****.com"
 * Show first char of local part, mask rest.
 * Mask domain name, preserve TLD.
 */
function maskEmail(text) {
  const atIdx = text.indexOf('@');
  if (atIdx < 0) return '****@****'; // malformed fallback

  const local = text.slice(0, atIdx);
  const domain = text.slice(atIdx + 1);

  // Extract TLD (last dot-separated segment)
  const lastDot = domain.lastIndexOf('.');
  const tld = lastDot >= 0 ? domain.slice(lastDot + 1) : domain;

  const maskedLocal = local.length > 0 ? local[0] + '****' : '****';
  return `${maskedLocal}@****.${tld}`;
}

/**
 * Phone → "+91 ***** **210"
 * Preserve country code prefix (+XX) and non-digit formatting chars.
 * Mask all digits except the last 3.
 */
function maskPhone(text) {
  // Extract optional country code prefix: +91, +1, etc.
  const prefixMatch = text.match(/^(\+\d{1,3}[\s\-]?)/);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const rest = text.slice(prefix.length);

  // Count total digits in the remaining portion
  const digits = rest.replace(/\D/g, '');
  const visibleCount = Math.min(3, digits.length);
  const maskCount = digits.length - visibleCount;

  // Walk through rest: mask digits left-to-right, preserve non-digits in place
  let digitIndex = 0;
  let masked = '';
  for (const ch of rest) {
    if (/\d/.test(ch)) {
      masked += digitIndex < maskCount ? '*' : ch;
      digitIndex++;
    } else {
      masked += ch; // preserve spaces, dashes, parens
    }
  }

  return prefix + masked;
}

/**
 * API Key → "sk-****lMNO"
 * Preserve known prefix (sk-, ghp_, etc.), mask middle, show last 4 chars.
 */
function maskAPIKey(text) {
  const prefixMatch = text.match(/^(sk-|pk_|rk_|ghp_|glpat-|AIza)/i);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const last4 = text.length > 4 ? text.slice(-4) : '';
  return `${prefix}****${last4}`;
}

/**
 * Password in Context → "password=********"
 * Preserve the keyword + separator, fully mask the value.
 */
function maskPassword(text) {
  // Match: keyword + optional whitespace + separator + optional quote
  const separatorMatch = text.match(
    /^((?:password|passwd|pwd|pass)\s*[=:]\s*['"]?)/i
  );
  if (separatorMatch) {
    return separatorMatch[0] + '********';
  }
  return '********';
}

/**
 * DB Connection String → "postgres://admin:****@prod-db:5432/app"
 * Only mask the password segment between user: and @host.
 */
function maskDBConn(text) {
  // protocol://user:PASSWORD@rest  →  protocol://user:****@rest
  return text.replace(/:\/\/([^:\s]+):([^@\s]+)@/, '://$1:****@');
}

/**
 * Bearer Token → "Bearer ****abc123"
 * Show "Bearer " prefix + last 6 chars, mask the rest.
 */
function maskBearer(text) {
  // Strip the "Bearer " prefix and get the token body
  const tokenMatch = text.match(/^(Bearer\s+)(.+)$/);
  if (!tokenMatch) return 'Bearer ****';

  const prefix = tokenMatch[1]; // "Bearer "
  const token = tokenMatch[2];
  const last6 = token.length > 6 ? token.slice(-6) : token;
  return `${prefix}****${last6}`;
}


// ─── Strategy Router ────────────────────────────────────────────

/** Map from ruleId → masking function */
const MASK_STRATEGY = {
  'CC-01': maskCreditCard,
  'SSN-01': maskSSN,
  'AADHAAR-01': maskAadhaar,
  'PAN-01': maskPAN,
  'EMAIL-01': maskEmail,
  'PHONE-01': maskPhone,
  'APIKEY-01': maskAPIKey,
  'PWD-01': maskPassword,
  'DBCONN-01': maskDBConn,
  'BEARER-01': maskBearer,
};


// ─── Public API ─────────────────────────────────────────────────

/**
 * Mask a single matched value using the rule-specific strategy.
 *
 * @param {string} matchedText — The raw text that was matched by the regex.
 * @param {string} ruleId      — The rule ID from the detection result (e.g. 'CC-01').
 * @returns {string} — The masked representation.
 */
function maskValue(matchedText, ruleId) {
  if (!matchedText || typeof matchedText !== 'string') return '';

  const strategy = MASK_STRATEGY[ruleId];
  if (strategy) {
    return strategy(matchedText);
  }

  // Fallback: mask entire value if no strategy found
  return '*'.repeat(matchedText.length);
}

/**
 * Apply masking to ALL detections within a full text string.
 *
 * Replaces each detected segment with its masked equivalent.
 * Processes detections RIGHT → LEFT to preserve character indices.
 *
 * @param {string}            text       — The original full text.
 * @param {DetectionResult[]} detections — Results from scanForPII().
 * @returns {string} — The fully masked text.
 */
function maskAll(text, detections) {
  if (!text || typeof text !== 'string') return text ?? '';
  if (!detections || detections.length === 0) return text;

  // Normalize + validate detections before replacement.
  // We only accept concrete, in-range numeric spans.
  const normalized = detections
    .map((det) => {
      const start = Number.isInteger(det?.startIndex) ? det.startIndex : -1;
      const end = Number.isInteger(det?.endIndex) ? det.endIndex : -1;
      if (start < 0 || end <= start || start >= text.length) return null;
      return {
        ...det,
        startIndex: start,
        endIndex: Math.min(end, text.length),
      };
    })
    .filter(Boolean);

  if (normalized.length === 0) return text;

  // Process from right to left so index positions remain valid.
  // Tie-break with longer spans first for deterministic overlap handling.
  const sorted = normalized.sort((a, b) => {
    if (a.startIndex !== b.startIndex) return b.startIndex - a.startIndex;
    return b.endIndex - a.endIndex;
  });

  let result = text;
  let rightBoundary = Number.POSITIVE_INFINITY;

  for (const det of sorted) {
    // Overlap guard: skip ranges that intersect a segment we already replaced.
    // This prevents corrupted output when upstream provides overlapping matches.
    if (det.endIndex > rightBoundary) {
      continue;
    }

    const masked = maskValue(det.matchText, det.ruleId);
    result = result.slice(0, det.startIndex) + masked + result.slice(det.endIndex);
    rightBoundary = det.startIndex;
  }

  return result;
}


// ─── Exports ────────────────────────────────────────────────────
export { maskValue, maskAll };
