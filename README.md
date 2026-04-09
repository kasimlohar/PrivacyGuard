# PrivacyGuard

**Real-time browser protection against accidental data leaks and prompt injection attacks.**

PrivacyGuard is a Chrome Extension (Manifest V3) that monitors user-authored input, detects sensitive content (PII, credentials, payment data), and warns before risky submission. It combines deterministic regex detection with optional Gemini-assisted fallback analysis and a network enforcement layer for final protection.

## Demo

### What problem it solves
- Developers and users often paste secrets, personal data, or unsafe prompt text into web forms and AI tools.
- Most platforms accept this immediately, with no safety checkpoint.

### How it works
1. PrivacyGuard observes input fields in real time.
2. It runs fast local detection (regex + injection scanner).
3. It shows a warning banner/modal with actionable choices.
4. On submission/network send, it enforces protection (block injection, mask sensitive text when enabled).

## Features

- Real-time detection for PII, credentials, and payment data.
- Prompt-injection detection for adversarial instruction patterns.
- Stable warning banner UX with action buttons: **Edit**, **Protect**, **Send Anyway**.
- One-shot user override flow for controlled exceptions.
- Network-level enforcement for `fetch` and `XMLHttpRequest`.
- Optional LLM fallback classification (Gemini) for ambiguous long-form AI prompts.
- Popup controls for extension status, allowlist, and recent detections.
- Local-only storage for settings/logs via Chrome Storage API.

## Architecture Overview

PrivacyGuard is split into four layers:

1. **Detection layer** (`src/detection/`, `src/utils/masker.js`)  
   Regex scanners and masking logic (pure functions).
2. **UI layer** (`src/ui/`, `src/content/fieldScanner.js`)  
   Banner/modal rendering and user-action orchestration.
3. **Enforcement layer** (`src/content/interceptor.js`)  
   MAIN world interception of outbound request payloads.
4. **Background/LLM layer** (`src/background/`, `src/detection/llmClassifier.js`)  
   LLM routing, badge updates, and persisted settings/logs.

For full system details, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Screenshots

### Banner UI
![PrivacyGuard Banner UI](<screenshots/Screenshot 2026-04-09 212738.png>)

### Blocking Modal
![PrivacyGuard Blocking Modal](<screenshots/Screenshot 2026-04-09 212746.png>)

### Popup Dashboard
![PrivacyGuard Popup Dashboard](<screenshots/Screenshot 2026-04-09 212822.png>)

### Additional Flow View
![PrivacyGuard Additional Flow](<screenshots/Screenshot 2026-04-09 212901.png>)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/<your-org-or-user>/privacyguard.git
   cd privacyguard
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build extension bundles:
   ```bash
   npm run build
   ```
4. Load into Chrome:
   1. Open `chrome://extensions`
   2. Enable **Developer mode**
   3. Click **Load unpacked**
   4. Select this project folder

## Usage Guide

1. Type or paste into a supported input (`input`, `textarea`, `contenteditable`).
2. If sensitive content is detected, PrivacyGuard enters review mode:
   - **Edit Input**: fix content manually.
   - **Protect**: apply masking in-field.
   - **Send Anyway**: one-shot bypass for that send action.
3. At network send time:
   - Injection patterns are blocked.
   - PII can be auto-masked (when auto-protect is enabled).
   - Clean requests pass unchanged.

## Configuration

### Gemini API key (optional)
1. Open the PrivacyGuard popup.
2. In **AI Settings**, enter your Gemini API key.
3. Save key (stored locally as `pg_llm_api_key`).

### Enable/disable extension
- Use the popup toggle (`ON` / `OFF`).

### Allowlist domains
- Add trusted domains in popup allowlist.
- Allowlisted domains skip content-side detection flow.

## Tech Stack

- JavaScript (ES Modules + IIFE bundles)
- Chrome Extensions API (Manifest V3)
- Chrome Storage API
- Shadow DOM (UI isolation)
- Gemini API (optional LLM fallback)

## Project Structure

```text
privacyguard/
├── manifest.json
├── package.json
├── scripts/
│   └── build.js
├── dist/
│   ├── detection.bundle.js
│   └── interceptor.bundle.js
├── src/
│   ├── background/
│   │   ├── serviceWorker.js
│   │   └── llmApi.js
│   ├── content/
│   │   ├── contentScript.js
│   │   ├── fieldScanner.js
│   │   └── interceptor.js
│   ├── detection/
│   │   ├── regexEngine.js
│   │   ├── injectionScanner.js
│   │   └── llmClassifier.js
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   ├── ui/
│   │   ├── warningBanner.js
│   │   └── modalOverlay.js
│   └── utils/
│       ├── constants.js
│       ├── masker.js
│       └── storage.js
├── tests/
│   ├── runAllTests.mjs
│   ├── regexEngine.smoke.mjs
│   ├── masker.smoke.mjs
│   └── injectionScanner.smoke.mjs
└── docs/
    ├── prd.md
    └── ARCHITECTURE.md
```

## Future Improvements

- Better semantic detection with confidence calibration.
- Domain-aware policy tuning and lower false positives.
- Performance profiling on high-frequency chat UIs.
- Firefox WebExtension support.
- Team policies, audit exports, and enterprise controls.

## License

This project is licensed under the **MIT License**. See [LICENSE](LICENSE).
