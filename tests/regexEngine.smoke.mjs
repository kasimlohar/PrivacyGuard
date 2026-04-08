/**
 * Quick smoke test for regexEngine.js
 * Run: node --experimental-vm-modules tests/regexEngine.smoke.mjs
 */

import { scanForPII, RULES } from '../src/detection/regexEngine.js';

// ─── Test Helpers ───────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(50 - name.length)}`);
}

// ─── Tests ──────────────────────────────────────────────────────

section('Module exports');
assert(typeof scanForPII === 'function', 'scanForPII is a function');
assert(Array.isArray(RULES), 'RULES is an array');
assert(RULES.length === 10, `RULES has 10 entries (got ${RULES.length})`);

section('Guard clauses');
assert(scanForPII(null).length === 0, 'null input → []');
assert(scanForPII(undefined).length === 0, 'undefined input → []');
assert(scanForPII('').length === 0, 'empty string → []');
assert(scanForPII(123).length === 0, 'non-string input → []');
assert(scanForPII('hello world').length === 0, 'benign text → []');

section('CC-01: Credit Card');
{
  const r1 = scanForPII('My card is 4111111111111111');
  assert(r1.length === 1, 'Detects Visa without spaces');
  assert(r1[0]?.ruleId === 'CC-01', 'Rule ID is CC-01');
  assert(r1[0]?.category === 'PAYMENT', 'Category is PAYMENT');
  assert(r1[0]?.matchText === '4111111111111111', `Match text correct (got "${r1[0]?.matchText}")`);

  const r2 = scanForPII('card: 4111 1111 1111 1111 thanks');
  assert(r2.length === 1, 'Detects Visa WITH spaces');
  assert(r2[0]?.matchText === '4111 1111 1111 1111', `Match w/ spaces (got "${r2[0]?.matchText}")`);

  const r3 = scanForPII('mc: 5105105105105100');
  assert(r3.length === 1, 'Detects Mastercard');

  const r4 = scanForPII('amex: 371449635398431');
  assert(r4.length === 1, 'Detects Amex');

  const r5 = scanForPII('disc: 6011111111111117');
  assert(r5.length === 1, 'Detects Discover');

  const r6 = scanForPII('4111-1111-1111-1111');
  assert(r6.length === 1, 'Detects CC with dashes');
}

section('SSN-01: Social Security Number');
{
  const r1 = scanForPII('ssn: 123-45-6789');
  assert(r1.length === 1, 'Detects valid SSN');
  assert(r1[0]?.ruleId === 'SSN-01', 'Rule ID is SSN-01');
  assert(r1[0]?.matchText === '123-45-6789', `Match text correct`);

  const r2 = scanForPII('invalid: 000-45-6789');
  assert(r2.length === 0, 'Rejects SSN starting with 000');

  const r3 = scanForPII('invalid: 666-45-6789');
  assert(r3.length === 0, 'Rejects SSN starting with 666');

  const r4 = scanForPII('invalid: 900-45-6789');
  assert(r4.length === 0, 'Rejects SSN starting with 900-999');

  const r5 = scanForPII('invalid: 123-00-6789');
  assert(r5.length === 0, 'Rejects SSN with group 00');

  const r6 = scanForPII('invalid: 123-45-0000');
  assert(r6.length === 0, 'Rejects SSN with serial 0000');
}

section('AADHAAR-01: Aadhaar Number');
{
  const r1 = scanForPII('aadhaar: 2345 6789 0123');
  assert(r1.length === 1, 'Detects Aadhaar with spaces');
  assert(r1[0]?.matchText === '2345 6789 0123', 'Match text correct');

  const r2 = scanForPII('aadhaar: 234567890123');
  assert(r2.length === 1, 'Detects Aadhaar without spaces');

  const r3 = scanForPII('not aadhaar: 0345 6789 0123');
  assert(r3.length === 0, 'Rejects Aadhaar starting with 0');

  const r4 = scanForPII('not aadhaar: 1345 6789 0123');
  assert(r4.length === 0, 'Rejects Aadhaar starting with 1');
}

section('PAN-01: PAN Card');
{
  const r1 = scanForPII('pan: ABCDE1234F');
  assert(r1.length === 1, 'Detects valid PAN');
  assert(r1[0]?.matchText === 'ABCDE1234F', 'Match text correct');

  const r2 = scanForPII('not pan: abcde1234f');
  assert(r2.length === 0, 'Rejects lowercase PAN');
}

section('EMAIL-01: Email Address');
{
  const r1 = scanForPII('email: arjun@company.com');
  assert(r1.length === 1, 'Detects email');
  assert(r1[0]?.matchText === 'arjun@company.com', 'Match text correct');
  assert(r1[0]?.severity === 'MEDIUM', 'Severity is MEDIUM');

  const r2 = scanForPII('contact: user.name+tag@sub.domain.co.uk');
  assert(r2.length === 1, 'Detects complex email');
}

section('PHONE-01: Phone Number');
{
  const r1 = scanForPII('call: +91 9876543210');
  assert(r1.length === 1, 'Detects Indian phone with +91');

  const r2 = scanForPII('call: 9876543210');
  assert(r2.length === 1, 'Detects Indian phone without +91');

  const r3 = scanForPII('call: (555) 123-4567');
  assert(r3.length === 1, 'Detects US phone formatted');

  const r4 = scanForPII('call: 555.123.4567');
  assert(r4.length === 1, 'Detects US phone with dots');
}

section('APIKEY-01: API Key');
{
  const r1 = scanForPII('key: sk-proj-abc123XYZ789defGHI456jklMNO');
  assert(r1.length === 1, 'Detects sk- prefixed key');
  assert(r1[0]?.severity === 'CRITICAL', 'Severity is CRITICAL');

  const r2 = scanForPII('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234');
  assert(r2.length === 1, 'Detects ghp_ prefixed key');

  const r3 = scanForPII('short: sk-abc');
  assert(r3.length === 0, 'Rejects short API key (< 20 chars after prefix)');
}

section('PWD-01: Password in Context');
{
  const r1 = scanForPII('password=Secr3t@123');
  assert(r1.length === 1, 'Detects password= pattern');
  assert(r1[0]?.severity === 'CRITICAL', 'Severity is CRITICAL');

  const r2 = scanForPII('config: pwd: MyP@ssw0rd!');
  assert(r2.length === 1, 'Detects pwd: pattern');

  const r3 = scanForPII('pass=ab');
  assert(r3.length === 0, 'Rejects password value < 6 chars');
}

section('DBCONN-01: Database Connection String');
{
  const r1 = scanForPII('db: postgres://admin:Secr3t@prod-db:5432/app');
  assert(r1.length === 1, 'Detects postgres connection string');
  assert(r1[0]?.category === 'CREDENTIAL', 'Category is CREDENTIAL');

  const r2 = scanForPII('mongo: mongodb://user:pass@cluster0.abc.net/mydb');
  assert(r2.length === 1, 'Detects mongodb connection string');

  const r3 = scanForPII('cache: redis://default:secret@redis.host:6379');
  assert(r3.length === 1, 'Detects redis connection string');
}

section('BEARER-01: Bearer Token');
{
  const r1 = scanForPII('auth: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw');
  assert(r1.length === 1, 'Detects Bearer token (JWT)');
  assert(r1[0]?.category === 'CREDENTIAL', 'Category is CREDENTIAL');

  const r2 = scanForPII('auth: Bearer short');
  assert(r2.length === 0, 'Rejects short Bearer token (< 20 chars)');
}

section('Multiple Matches');
{
  const text = 'email: arjun@company.com and card 4111111111111111 and password=MySecret123';
  const r = scanForPII(text);
  assert(r.length === 3, `Detects 3 items (got ${r.length})`);
  assert(r[0]?.ruleId === 'EMAIL-01', 'First match is email');
  assert(r[1]?.ruleId === 'CC-01', 'Second match is CC');
  assert(r[2]?.ruleId === 'PWD-01', 'Third match is password');
  // Verify sorted by startIndex
  assert(r[0].startIndex < r[1].startIndex && r[1].startIndex < r[2].startIndex,
    'Results sorted by startIndex');
}

section('Overlap Resolution');
{
  // A 12-digit number starting with 6-9 could match both Aadhaar and phone.
  // Aadhaar is HIGH, Phone is MEDIUM → Aadhaar should win.
  const text = 'id: 9876 5432 1098';
  const r = scanForPII(text);
  const hasAadhaar = r.some(m => m.ruleId === 'AADHAAR-01');
  assert(hasAadhaar, 'Aadhaar (HIGH) wins over Phone (MEDIUM) on overlap');
}

section('Performance');
{
  // Generate a large but realistic input (5000 chars)
  const bigText = 'x'.repeat(4900) + ' 4111111111111111 ' + 'y'.repeat(80);
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    scanForPII(bigText);
  }
  const elapsed = (performance.now() - start) / 100;
  assert(elapsed < 10, `Average scan time < 10ms (got ${elapsed.toFixed(2)}ms)`);
}

// ─── Summary ────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
