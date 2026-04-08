/**
 * PrivacyGuard — LLM Classifier (Content-side)
 *
 * Implements the hybrid detection fallback system.
 * Sends ambiguous, sufficiently long text to the background LLM worker
 * ONLY IF it's on an AI domain and regex missed it.
 * Ensures text is pre-masked and truncated before leaving the DOM world.
 *
 * @module llmClassifier
 */

import { AI_DOMAINS } from '../utils/constants.js';
import { scanForPII } from './regexEngine.js';
import { scanForInjection } from './injectionScanner.js';

const TIMEOUT_MS = 2000;
const MIN_LENGTH = 50;
const MAX_LENGTH = 2000;
const CONFIDENCE_THRESHOLD = 0.75;

/**
 * Pre-masks text by replacing all regex PII matches with [REDACTED].
 * @param {string} text
 * @returns {string}
 */
function preMaskText(text) {
  let masked = text;
  const piiResults = scanForPII(text);

  if (piiResults.length === 0) return masked;

  // Process from end to start to avoid index shifting
  const sorted = [...piiResults].sort((a, b) => b.startIndex - a.startIndex);

  for (const r of sorted) {
    masked =
      masked.slice(0, r.startIndex) +
      '[REDACTED]' +
      masked.slice(r.endIndex);
  }

  return masked;
}

/**
 * Determines if a piece of text requires an LLM classification,
 * pre-masks it, enforces timeout, and sends to the background.
 *
 * @param {string} text - The raw text from the input field
 * @param {string} domain - Current location.hostname
 * @returns {Promise<object|null>} - Returns matched category data or null
 */
export async function classifyWithLLM(text, domain) {
  if (!text || typeof text !== 'string') return null;

  // 1. Decision Logic Constraints
  if (text.length < MIN_LENGTH) return null;

  const isAiDomain = AI_DOMAINS.some(aiDomain => domain.includes(aiDomain));
  if (!isAiDomain) return null;

  const injectionResults = scanForInjection(text);
  if (injectionResults.length > 0) return null;

  const piiResults = scanForPII(text);
  if (piiResults.length > 0) return null;

  // 2. Pre-masking & Truncation (Safety)
  // Even if piiResults was 0, it is best practice to run safety masking 
  // in case logic changes above to permit partial detection overlaps.
  let safeText = preMaskText(text);

  if (safeText.length > MAX_LENGTH) {
    safeText = safeText.slice(0, MAX_LENGTH);
  }

  // 3. Delegate to Background via Messaging with Timeout
  const fetchPromise = new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'PG_LLM_CLASSIFY',
          text: safeText
        },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve(null);
          } else {
            resolve(response);
          }
        }
      );
    } catch (err) {
      resolve(null); // Context invalidated
    }
  });

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve(null), TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([fetchPromise, timeoutPromise]);

    // 4. Response handling
    if (!result || !result.category || result.category === 'NONE') {
      return null;
    }

    if (result.confidence >= CONFIDENCE_THRESHOLD) {
      return {
        ruleId: 'LLM-01',
        category: result.category,
        severity: result.category === 'INJECTION' ? 'INJECTION' : 'HIGH', // default mapped severity
        matchText: text, // Cannot map back exact substring, flag entire field (or pre-mask copy)
        description: result.reason || 'Flagged by AI analysis',
        confidence: result.confidence
      };
    }
  } catch (error) {
    console.error('[PrivacyGuard] LLM Classifier error:', error);
  }

  return null;
}
