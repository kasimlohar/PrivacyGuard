/**
 * PrivacyGuard — LLM API Interactor
 *
 * Handles HTTP communication with the Google Gemini API.
 * Uses a strict 2-second timeout and fails open (returns NONE).
 * Expects a structured JSON response to map back into the detection pipeline.
 *
 * @module llmApi
 */

const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const TIMEOUT_MS = 2000;

/**
 * Builds the strict LLM prompt.
 * @param {string} maskedText 
 */
function buildPrompt(maskedText) {
  return `Classify if the following text contains sensitive data.
Categories: PII, CREDENTIAL, PAYMENT, INJECTION, NONE.
Respond ONLY in JSON:
{"category":"...","confidence":0.0,"reason":"..."}

Text:
${maskedText}`;
}

/**
 * Calls Gemini 2.5 Flash to classify the text.
 * 
 * @param {string} maskedText - The text (pre-masked) to classify 
 * @param {string} apiKey - The Gemini API key from storage
 * @returns {Promise<{category: string, confidence: number, reason: string}>}
 */
export async function callLLM(maskedText, apiKey) {
  if (!apiKey) {
    return { category: 'NONE', confidence: 0, reason: 'missing_api_key' };
  }

  const payload = {
    contents: [
      {
        parts: [
          {
            text: buildPrompt(maskedText)
          }
        ]
      }
    ]
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { category: 'NONE', confidence: 0, reason: `http_error_${response.status}` };
    }

    const data = await response.json();
    
    // Extract text from Gemini response structure
    const candidate = data.candidates?.[0];
    const textResp = candidate?.content?.parts?.[0]?.text || '';
    
    // Clean up potential markdown formatting (e.g. ```json\n...\n```)
    const cleanedText = textResp.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    // Parse JSON safely
    let parsed;
    try {
      parsed = JSON.parse(cleanedText);
    } catch (parseError) {
      return { category: 'NONE', confidence: 0, reason: 'parse_error' };
    }

    // Validate schema
    const categories = ['PII', 'CREDENTIAL', 'PAYMENT', 'INJECTION', 'NONE'];
    const category = categories.includes(parsed.category) ? parsed.category : 'NONE';
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : 'unknown';

    return { category, confidence, reason };

  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      return { category: 'NONE', confidence: 0, reason: 'timeout' };
    }
    return { category: 'NONE', confidence: 0, reason: 'network_error' };
  }
}
