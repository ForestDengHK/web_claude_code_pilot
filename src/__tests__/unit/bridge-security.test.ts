import * as assert from 'node:assert';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from '../../lib/bridge/security/validators';
import { ChatRateLimiter } from '../../lib/bridge/security/rate-limiter';

// ---------- validators ----------

// validateWorkingDirectory
assert.ok(
  validateWorkingDirectory('/home/user/project') !== null,
  'absolute path should return normalized path',
);
assert.strictEqual(
  validateWorkingDirectory('./relative'),
  null,
  'relative path should return null',
);
assert.strictEqual(
  validateWorkingDirectory('/foo/../bar'),
  null,
  'path traversal should return null',
);
assert.strictEqual(
  validateWorkingDirectory('/foo\x00bar'),
  null,
  'null byte should return null',
);
assert.strictEqual(
  validateWorkingDirectory('/foo;rm -rf'),
  null,
  'shell metacharacters should return null',
);
assert.strictEqual(
  validateWorkingDirectory(''),
  null,
  'empty string should return null',
);

// validateSessionId
assert.strictEqual(
  validateSessionId('a'.repeat(32)),
  true,
  '32-char hex string should be valid',
);
assert.strictEqual(
  validateSessionId('abc-def-123'),
  false,
  'short string should be invalid',
);
assert.strictEqual(
  validateSessionId('a'.repeat(64)),
  true,
  '64-char hex string should be valid',
);

// isDangerousInput
{
  const result1 = isDangerousInput('; rm -rf /');
  assert.strictEqual(result1.dangerous, true, 'chained rm should be dangerous');
}
{
  const result2 = isDangerousInput('| bash');
  assert.strictEqual(result2.dangerous, true, 'pipe to bash should be dangerous');
}
{
  const result3 = isDangerousInput('hello world');
  assert.strictEqual(result3.dangerous, false, 'normal text should not be dangerous');
}

// sanitizeInput
{
  const result4 = sanitizeInput('hello\x00world');
  assert.ok(!result4.text.includes('\x00'), 'null byte should be stripped');
  assert.strictEqual(result4.text, 'helloworld');
}
{
  const longInput = 'a'.repeat(40_000);
  const result5 = sanitizeInput(longInput);
  assert.strictEqual(result5.truncated, true, 'should be truncated');
  assert.strictEqual(result5.text.length, 32_000, 'should truncate to MAX_INPUT_LENGTH');
}
{
  const result6 = sanitizeInput('hello\nworld');
  assert.ok(result6.text.includes('\n'), 'newlines should be preserved');
  assert.strictEqual(result6.text, 'hello\nworld');
}

// validateMode
assert.strictEqual(validateMode('plan'), true, 'plan should be valid');
assert.strictEqual(validateMode('code'), true, 'code should be valid');
assert.strictEqual(validateMode('ask'), true, 'ask should be valid');
assert.strictEqual(validateMode('invalid'), false, 'invalid should be invalid');

// ---------- rate limiter ----------

async function testRateLimiter() {
  const limiter = new ChatRateLimiter(3, 1000);

  // First 3 should be immediate
  const start = Date.now();
  await limiter.acquire('test');
  await limiter.acquire('test');
  await limiter.acquire('test');
  const afterThree = Date.now();
  assert.ok(afterThree - start < 100, `first 3 acquires should be fast, took ${afterThree - start}ms`);

  // 4th should be delayed
  const beforeFourth = Date.now();
  await limiter.acquire('test');
  const afterFourth = Date.now();
  const delay = afterFourth - beforeFourth;
  assert.ok(delay >= 500, `4th acquire should be delayed, took ${delay}ms`);

  console.log(`Rate limiter: 4th acquire delayed by ${delay}ms (expected ~1000ms)`);
}

async function main() {
  await testRateLimiter();
  console.log('All bridge-security tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
