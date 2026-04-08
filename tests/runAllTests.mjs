/**
 * PrivacyGuard — Unified Test Runner
 *
 * Runs all module test suites as child processes, captures and aggregates
 * results, and prints a clean summary.
 *
 * Usage:
 *   node --experimental-vm-modules tests/runAllTests.mjs
 *   npm test
 *
 * Exit code: 0 if all pass, 1 if any fail.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─── Config ─────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SUITES = [
  { name: 'regexEngine',       file: 'tests/regexEngine.smoke.mjs' },
  { name: 'masker',            file: 'tests/masker.smoke.mjs' },
  { name: 'injectionScanner',  file: 'tests/injectionScanner.smoke.mjs' },
];

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Parse "Results: X passed, Y failed, Z total" from test output.
 */
function parseResults(output) {
  const match = output.match(/Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed,\s*(\d+)\s*total/);
  if (match) {
    return { passed: parseInt(match[1]), failed: parseInt(match[2]), total: parseInt(match[3]) };
  }
  return null;
}

/**
 * Extract only the ✅ / ❌ lines and the section headers for compact output.
 */
function compactOutput(output) {
  return output
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith('✅') ||
        trimmed.startsWith('❌') ||
        trimmed.startsWith('──') ||
        trimmed.startsWith('═')
      );
    })
    .join('\n');
}

// ─── Runner ─────────────────────────────────────────────────────

const HR = '═'.repeat(60);
let totalPassed = 0;
let totalFailed = 0;
let totalTime = 0;
const suiteResults = [];

console.log(`\n${HR}`);
console.log(`  🛡️  PrivacyGuard — Test Suite`);
console.log(`${HR}\n`);

for (const suite of SUITES) {
  const start = performance.now();
  let output = '';
  let exitCode = 0;

  try {
    output = execSync(
      `node --experimental-vm-modules ${suite.file}`,
      { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (err) {
    // execSync throws on non-zero exit code; stdout is still captured
    output = err.stdout || '';
    exitCode = err.status || 1;
  }

  const elapsed = performance.now() - start;
  const results = parseResults(output);

  if (results) {
    totalPassed += results.passed;
    totalFailed += results.failed;
  }
  totalTime += elapsed;

  // Print suite header + compact results
  const status = results && results.failed === 0 ? '✅' : '❌';
  const counts = results
    ? `${results.passed} passed, ${results.failed} failed`
    : 'PARSE ERROR';

  console.log(`┌── ${suite.name} ${status}  (${elapsed.toFixed(0)}ms)`);
  console.log(`│   ${counts}`);

  // Show failed test details if any
  if (results && results.failed > 0) {
    const failedLines = output
      .split('\n')
      .filter(l => l.trim().startsWith('❌'))
      .map(l => `│   ${l.trim()}`)
      .join('\n');
    if (failedLines) {
      console.log(`│`);
      console.log(failedLines);
    }
  }

  console.log(`└${'─'.repeat(55)}`);

  suiteResults.push({ name: suite.name, ...results, elapsed, exitCode });
}

// ─── Summary ────────────────────────────────────────────────────

const allPassed = totalFailed === 0;
const icon = allPassed ? '✅' : '❌';

console.log(`\n${HR}`);
console.log(`  TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} tests`);
console.log(`  TIME:  ${totalTime.toFixed(0)}ms`);
console.log(`  ${allPassed ? 'All tests passed ✅' : `${totalFailed} test(s) FAILED ❌`}`);
console.log(`${HR}\n`);

// Per-suite breakdown table
console.log('  Suite               Passed  Failed  Time');
console.log('  ' + '─'.repeat(50));
for (const s of suiteResults) {
  const name = s.name.padEnd(20);
  const p = String(s.passed ?? '?').padStart(6);
  const f = String(s.failed ?? '?').padStart(6);
  const t = `${s.elapsed.toFixed(0)}ms`.padStart(7);
  console.log(`  ${name}${p}  ${f}  ${t}`);
}
console.log('  ' + '─'.repeat(50));
console.log(`  ${'TOTAL'.padEnd(20)}${String(totalPassed).padStart(6)}  ${String(totalFailed).padStart(6)}  ${`${totalTime.toFixed(0)}ms`.padStart(7)}`);
console.log('');

process.exit(allPassed ? 0 : 1);
