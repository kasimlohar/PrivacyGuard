# PrivacyGuard Architecture

## 1. System overview

PrivacyGuard is a Chrome Extension (MV3) with a layered design:

1. **Content detection/UI layer** (content script world)
2. **Background layer** (service worker)
3. **MAIN world enforcement layer** (injected interceptor)

This separation keeps detection fast, UI predictable, and submission control robust.

## 2. Runtime components

### 2.1 Content scripts

- `src/content/contentScript.js`
  - Discovers relevant inputs (`input`, `textarea`, `contenteditable`)
  - Watches DOM mutations for dynamic/SPA fields
  - Injects MAIN world interceptor bundle
- `src/content/fieldScanner.js`
  - Handles debounced input events
  - Executes detection pipeline (regex/injection + optional LLM fallback)
  - Coordinates state transitions and UI actions

### 2.2 Detection modules

- `src/detection/regexEngine.js` — deterministic PII/credential/payment rules
- `src/detection/injectionScanner.js` — prompt-injection pattern detection
- `src/detection/llmClassifier.js` — fallback classification on supported AI domains
- `src/utils/masker.js` — per-rule masking and multi-match safe masking

### 2.3 UI modules

- `src/ui/warningBanner.js` — inline warning banner (Shadow DOM)
- `src/ui/modalOverlay.js` — blocking review modal (Shadow DOM)
- `src/popup/*` — extension popup for controls/configuration

### 2.4 Background service worker

- `src/background/serviceWorker.js`
  - Badge updates by severity
  - Message routing for LLM classification
  - Reads Gemini API key from local storage
- `src/background/llmApi.js`
  - Calls Gemini API with timeout and structured response parsing

### 2.5 MAIN world interceptor

- `src/content/interceptor.js`
  - Patches `fetch` and `XMLHttpRequest.send`
  - Extracts user-authored text from payloads
  - Applies enforcement policy:
    - injection -> block
    - PII + auto-protect -> mask and forward
    - otherwise -> allow

## 3. Data flow

## 3.1 Input-time detection flow

1. User types/pastes.
2. `fieldScanner` runs debounced scan.
3. Regex/injection scan executes locally.
4. Optional LLM fallback runs for eligible AI-domain text.
5. Detection results drive banner/modal actions.

## 3.2 Submission-time enforcement flow

1. App initiates network request.
2. MAIN interceptor inspects outgoing body.
3. Extracted user text is scanned.
4. Request is blocked, sanitized, or allowed according to policy.

## 3.3 Persistence flow

`chrome.storage.local` stores:
- extension enabled flag
- allowlist domains
- recent detection entries
- optional Gemini API key

## 4. State model (content-side)

Field-level lifecycle in `fieldScanner.js`:

`IDLE -> DETECTED -> REVIEW -> ACTION -> CLEAN`

- **IDLE**: no active risk state.
- **DETECTED**: new detection found on settled input.
- **REVIEW**: banner/modal visible, waiting for user intent.
- **ACTION**: user selected Protect/Edit/Send Anyway/Remove Injection.
- **CLEAN**: subsequent settled scan is safe.

## 5. Security and stability properties

- Detection is local-first; LLM fallback is bounded and optional.
- Network enforcement is fail-open on unknown body formats to avoid platform breakage.
- Structured payload mutation targets only extracted user text fields.
- One-shot bypass is explicit and short-lived for controlled overrides.
- Shadow DOM isolates extension UI from host CSS.

## 6. Build and test pipeline

- Build script: `scripts/build.js`
  - Bundles detection code for content script use
  - Bundles interceptor for MAIN world injection
- Test runner: `tests/runAllTests.mjs`
  - regex engine smoke tests
  - masking smoke tests
  - injection scanner smoke tests
