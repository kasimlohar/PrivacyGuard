# Contributing to PrivacyGuard

Thanks for contributing.

## Development setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build bundles:
   ```bash
   npm run build
   ```
3. Run tests:
   ```bash
   npm test
   ```
4. Load extension locally via `chrome://extensions` -> **Load unpacked**.

## Pull request guidelines

- Keep changes focused and minimal.
- Add/update tests when behavior changes.
- Ensure `npm run build` and `npm test` pass.
- Use clear commit messages and include context in PR description:
  - problem
  - approach
  - validation
- For UI behavior changes, include screenshots or short recordings.

## Coding standards

- Follow existing file/module boundaries (detection vs UI vs enforcement).
- Avoid broad refactors in the same PR as functional fixes.
- Preserve user-controlled safety behavior (Edit/Protect/Send Anyway).
