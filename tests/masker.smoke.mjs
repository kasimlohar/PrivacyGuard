/**
 * Smoke tests for masker.js
 * Run: node --experimental-vm-modules tests/masker.smoke.mjs
 */

import { maskValue, maskAll } from '../src/utils/masker.js';
import { scanForPII } from '../src/detection/regexEngine.js';

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

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (!ok) {
    assert(false, label, `expected "${expected}", got "${actual}"`);
  } else {
    assert(true, label);
  }
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(50 - name.length)}`);
}

// ─── Guard Clauses ──────────────────────────────────────────────

section('Guard clauses');
assertEq(maskValue(null, 'CC-01'), '', 'null input → empty string');
assertEq(maskValue(undefined, 'CC-01'), '', 'undefined input → empty string');
assertEq(maskValue('', 'CC-01'), '', 'empty input → empty string');
assertEq(maskValue('sensitive', 'UNKNOWN_RULE'), '*********', 'Unknown ruleId → full mask fallback');

// ─── CC-01: Credit Card ─────────────────────────────────────────

section('CC-01: Credit Card');
assertEq(
  maskValue('4111111111111111', 'CC-01'),
  '4111 **** **** 1111',
  'Visa no spaces'
);
assertEq(
  maskValue('4111 1111 1111 1111', 'CC-01'),
  '4111 **** **** 1111',
  'Visa with spaces'
);
assertEq(
  maskValue('4111-1111-1111-1111', 'CC-01'),
  '4111 **** **** 1111',
  'Visa with dashes'
);
assertEq(
  maskValue('5105105105105100', 'CC-01'),
  '5105 **** **** 5100',
  'Mastercard'
);
assertEq(
  maskValue('371449635398431', 'CC-01'),
  '3714 **** **** 8431',
  'Amex (15 digits → first4 + last4)'
);

// ─── SSN-01: Social Security Number ─────────────────────────────

section('SSN-01: SSN');
assertEq(
  maskValue('123-45-6789', 'SSN-01'),
  '***-**-6789',
  'Standard SSN'
);

// ─── AADHAAR-01: Aadhaar ────────────────────────────────────────

section('AADHAAR-01: Aadhaar');
assertEq(
  maskValue('2345 6789 0123', 'AADHAAR-01'),
  '**** **** 0123',
  'Aadhaar with spaces'
);
assertEq(
  maskValue('234567890123', 'AADHAAR-01'),
  '**** **** 0123',
  'Aadhaar without spaces'
);

// ─── PAN-01: PAN Card ───────────────────────────────────────────

section('PAN-01: PAN');
assertEq(
  maskValue('ABCDE1234F', 'PAN-01'),
  'ABCDE****F',
  'Standard PAN'
);

// ─── EMAIL-01: Email ────────────────────────────────────────────

section('EMAIL-01: Email');
assertEq(
  maskValue('arjun@company.com', 'EMAIL-01'),
  'a****@****.com',
  'Standard email'
);
assertEq(
  maskValue('x@y.io', 'EMAIL-01'),
  'x****@****.io',
  'Short email'
);
assertEq(
  maskValue('user.name+tag@sub.domain.co.uk', 'EMAIL-01'),
  'u****@****.uk',
  'Complex email — preserves last TLD segment'
);

// ─── PHONE-01: Phone ────────────────────────────────────────────

section('PHONE-01: Phone');
{
  const r1 = maskValue('+91 9876543210', 'PHONE-01');
  assert(r1.startsWith('+91 '), `Indian phone preserves +91 prefix (got "${r1}")`);
  assert(r1.endsWith('210'), `Indian phone shows last 3 digits (got "${r1}")`);
  assert(r1.includes('*'), 'Indian phone has masked digits');

  const r2 = maskValue('9876543210', 'PHONE-01');
  assert(r2.endsWith('210'), `Indian phone (no prefix) shows last 3 (got "${r2}")`);

  const r3 = maskValue('(555) 123-4567', 'PHONE-01');
  assert(r3.endsWith('567'), `US formatted phone shows last 3 (got "${r3}")`);
  assert(r3.includes('('), `US phone preserves parens (got "${r3}")`);
}

// ─── APIKEY-01: API Key ─────────────────────────────────────────

section('APIKEY-01: API Key');
{
  const r1 = maskValue('sk-proj-abc123XYZ789defGHI456jklMNO', 'APIKEY-01');
  assert(r1.startsWith('sk-'), `Preserves sk- prefix (got "${r1}")`);
  assert(r1.endsWith('lMNO'), `Shows last 4 chars (got "${r1}")`);
  assert(r1.includes('****'), 'Has masked middle');

  const r2 = maskValue('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZab', 'APIKEY-01');
  assert(r2.startsWith('ghp_'), `Preserves ghp_ prefix (got "${r2}")`);
}

// ─── PWD-01: Password ───────────────────────────────────────────

section('PWD-01: Password');
assertEq(
  maskValue('password=Secr3t@123', 'PWD-01'),
  'password=********',
  'password= format'
);
assertEq(
  maskValue('pwd: MyP@ssw0rd!', 'PWD-01'),
  'pwd: ********',
  'pwd: format'
);
assertEq(
  maskValue('passwd=Secret', 'PWD-01'),
  'passwd=********',
  'passwd= format'
);

// ─── DBCONN-01: Database Connection ─────────────────────────────

section('DBCONN-01: Connection String');
assertEq(
  maskValue('postgres://admin:Secr3t@prod-db:5432/app', 'DBCONN-01'),
  'postgres://admin:****@prod-db:5432/app',
  'Postgres connection'
);
assertEq(
  maskValue('mongodb://user:pass@cluster0.abc.net/mydb', 'DBCONN-01'),
  'mongodb://user:****@cluster0.abc.net/mydb',
  'MongoDB connection'
);
assertEq(
  maskValue('redis://default:secret@redis.host:6379', 'DBCONN-01'),
  'redis://default:****@redis.host:6379',
  'Redis connection'
);

// ─── BEARER-01: Bearer Token ────────────────────────────────────

section('BEARER-01: Bearer Token');
{
  const token = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw';
  const r1 = maskValue(token, 'BEARER-01');
  assert(r1.startsWith('Bearer ****'), `Starts with "Bearer ****" (got "${r1}")`);
  assert(r1.endsWith('Y3ODkw'), `Shows last 6 chars (got "${r1}")`);
}

// ─── maskAll: Full Text Masking ─────────────────────────────────

section('maskAll: Integration');
{
  const text1 = 'My card is 4111111111111111';
  const dets1 = scanForPII(text1);
  const masked1 = maskAll(text1, dets1);
  assertEq(masked1, 'My card is 4111 **** **** 1111', 'Single detection maskAll');
}
{
  const text2 = 'email arjun@company.com and card 4111111111111111';
  const dets2 = scanForPII(text2);
  const masked2 = maskAll(text2, dets2);
  assert(
    masked2.includes('a****@****.com') && masked2.includes('4111 **** **** 1111'),
    `Multi-detection maskAll (got "${masked2}")`
  );
  assert(masked2.includes(' and card '), 'Non-sensitive text preserved between detections');
}
{
  const text3 = 'db: postgres://admin:Secr3t@prod-db:5432/app end';
  const dets3 = scanForPII(text3);
  const masked3 = maskAll(text3, dets3);
  assertEq(
    masked3,
    'db: postgres://admin:****@prod-db:5432/app end',
    'DB conn string maskAll preserves surrounding text'
  );
}

section('maskAll: Edge cases');
{
  assertEq(maskAll('no sensitive data here', []), 'no sensitive data here', 'Empty detections → unchanged');
  assertEq(maskAll(null, []), '', 'null text → empty string');
  assertEq(maskAll('hello', null), 'hello', 'null detections → unchanged');
}

// ─── Performance ────────────────────────────────────────────────

section('Performance');
{
  const text = 'card 4111111111111111 email a@b.com ssn 123-45-6789 pass=Secret123 repeat '.repeat(10);
  const dets = scanForPII(text);
  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    maskAll(text, dets);
  }
  const elapsed = (performance.now() - start) / 1000;
  assert(elapsed < 5, `maskAll average < 5ms (got ${elapsed.toFixed(3)}ms with ${dets.length} detections)`);
}

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
