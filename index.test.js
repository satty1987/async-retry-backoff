'use strict';

const assert = require('assert');
const { retry, createRetry, retryify, computeDelay, RetryError, TimeoutError } = require('../src/index');

// ─── Tiny test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const makeCounter = (failTimes, resolveWith = 'ok') => {
  let calls = 0;
  return () => {
    calls++;
    if (calls <= failTimes) return Promise.reject(new Error(`fail #${calls}`));
    return Promise.resolve(resolveWith);
  };
};

const noJitter = { jitter: 0 };

// ─── Tests ──────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n▶  computeDelay');

  await test('returns base delay for attempt 0', () => {
    const d = computeDelay(0, { base: 100, factor: 2, maxDelay: 10_000, jitter: 0 });
    assert.strictEqual(d, 100);
  });

  await test('doubles on each attempt (no jitter)', () => {
    const d0 = computeDelay(0, { base: 100, factor: 2, maxDelay: 10_000, jitter: 0 });
    const d1 = computeDelay(1, { base: 100, factor: 2, maxDelay: 10_000, jitter: 0 });
    const d2 = computeDelay(2, { base: 100, factor: 2, maxDelay: 10_000, jitter: 0 });
    assert.strictEqual(d0, 100);
    assert.strictEqual(d1, 200);
    assert.strictEqual(d2, 400);
  });

  await test('respects maxDelay cap', () => {
    const d = computeDelay(10, { base: 100, factor: 2, maxDelay: 500, jitter: 0 });
    assert.strictEqual(d, 500);
  });

  await test('jitter keeps delay within expected range', () => {
    // attempt=2, base=100, factor=2 → exponential = 100 * 2^2 = 400
    // jitter=0.5 → spread = 400 * 0.5 = 200, range = [300, 500]
    for (let i = 0; i < 50; i++) {
      const d = computeDelay(2, { base: 100, factor: 2, maxDelay: 10_000, jitter: 0.5 });
      assert.ok(d >= 300 && d <= 500, `delay ${d} out of [300, 500] range`);
    }
  });

  console.log('\n▶  retry — success cases');

  await test('resolves immediately on first success', async () => {
    const fn = makeCounter(0, 'hello');
    const result = await retry(fn, { retries: 3, base: 1, ...noJitter });
    assert.strictEqual(result, 'hello');
  });

  await test('succeeds after partial failures', async () => {
    const fn = makeCounter(2, 'world');
    const result = await retry(fn, { retries: 3, base: 1, ...noJitter });
    assert.strictEqual(result, 'world');
  });

  await test('passes the resolved value through unchanged', async () => {
    const data = { id: 42, name: 'Alice' };
    const result = await retry(() => Promise.resolve(data), { retries: 1 });
    assert.deepStrictEqual(result, data);
  });

  console.log('\n▶  retry — failure cases');

  await test('throws RetryError after all attempts exhausted', async () => {
    const fn = makeCounter(99);
    await assert.rejects(
      () => retry(fn, { retries: 2, base: 1, ...noJitter }),
      RetryError
    );
  });

  await test('RetryError carries correct attempt count', async () => {
    const fn = makeCounter(99);
    try {
      await retry(fn, { retries: 2, base: 1, ...noJitter });
    } catch (err) {
      assert.ok(err instanceof RetryError);
      assert.strictEqual(err.attempts, 3); // 1 initial + 2 retries
    }
  });

  await test('RetryError contains all attempt results', async () => {
    const fn = makeCounter(99);
    try {
      await retry(fn, { retries: 2, base: 1, ...noJitter });
    } catch (err) {
      assert.ok(err instanceof RetryError);
      assert.strictEqual(err.results.length, 3);
    }
  });

  await test('RetryError.lastError is the last thrown error', async () => {
    const fn = makeCounter(99);
    try {
      await retry(fn, { retries: 1, base: 1, ...noJitter });
    } catch (err) {
      assert.ok(err.lastError instanceof Error);
      assert.match(err.lastError.message, /fail/);
    }
  });

  await test('throws immediately when retries = 0 and fn fails', async () => {
    const fn = makeCounter(99);
    await assert.rejects(
      () => retry(fn, { retries: 0, base: 1 }),
      RetryError
    );
  });

  console.log('\n▶  retry — shouldRetry');

  await test('shouldRetry returning false stops immediately', async () => {
    let calls = 0;
    const fn = () => { calls++; return Promise.reject(new Error('nope')); };
    await assert.rejects(
      () => retry(fn, { retries: 5, base: 1, shouldRetry: () => false }),
      RetryError
    );
    assert.strictEqual(calls, 1);
  });

  await test('shouldRetry receives error and attempt number', async () => {
    const seen = [];
    const fn = makeCounter(99);
    await assert.rejects(
      () => retry(fn, {
        retries: 2,
        base: 1,
        ...noJitter,
        shouldRetry: (err, attempt) => { seen.push({ err, attempt }); return true; },
      }),
      RetryError
    );
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0].attempt, 1);
    assert.strictEqual(seen[1].attempt, 2);
  });

  await test('shouldRetry can target specific error types', async () => {
    class NetworkError extends Error {}
    class AuthError extends Error {}
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls === 1) return Promise.reject(new NetworkError('network'));
      return Promise.reject(new AuthError('auth'));
    };
    await assert.rejects(
      () => retry(fn, {
        retries: 5,
        base: 1,
        shouldRetry: (err) => err instanceof NetworkError,
      }),
      RetryError
    );
    assert.strictEqual(calls, 2); // stopped after AuthError
  });

  console.log('\n▶  retry — onRetry');

  await test('onRetry is called once per retry', async () => {
    const log = [];
    const fn = makeCounter(2, 'done');
    await retry(fn, {
      retries: 3,
      base: 1,
      ...noJitter,
      onRetry: (err, attempt, delay) => log.push({ attempt, delay }),
    });
    assert.strictEqual(log.length, 2);
  });

  await test('onRetry receives correct attempt numbers', async () => {
    const log = [];
    const fn = makeCounter(99);
    await assert.rejects(
      () => retry(fn, {
        retries: 2,
        base: 1,
        ...noJitter,
        onRetry: (err, attempt) => log.push(attempt),
      }),
      RetryError
    );
    assert.deepStrictEqual(log, [1, 2]);
  });

  console.log('\n▶  retry — timeout');

  await test('per-attempt timeout rejects slow functions', async () => {
    const slow = () => new Promise((res) => setTimeout(res, 200));
    await assert.rejects(
      () => retry(slow, { retries: 0, timeout: 50 }),
      RetryError
    );
  });

  await test('TimeoutError is the lastError when timeout fires', async () => {
    const slow = () => new Promise((res) => setTimeout(res, 200));
    try {
      await retry(slow, { retries: 0, timeout: 50 });
    } catch (err) {
      assert.ok(err instanceof RetryError);
      assert.ok(err.lastError instanceof TimeoutError);
    }
  });

  await test('fast functions are not affected by generous timeout', async () => {
    const fn = () => Promise.resolve('fast');
    const result = await retry(fn, { retries: 1, timeout: 5_000 });
    assert.strictEqual(result, 'fast');
  });

  console.log('\n▶  retry — AbortSignal');

  await test('pre-aborted signal throws immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => retry(() => Promise.resolve('ok'), { signal: controller.signal }),
      (err) => err.name === 'AbortError'
    );
  });

  await test('aborting mid-flight stops further retries', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fn = () => {
      calls++;
      controller.abort();
      return Promise.reject(new Error('fail'));
    };
    await assert.rejects(
      () => retry(fn, { retries: 5, base: 1, signal: controller.signal }),
      (err) => err.name === 'AbortError' || err instanceof RetryError
    );
    assert.ok(calls <= 2, `Expected ≤2 calls, got ${calls}`);
  });

  console.log('\n▶  createRetry');

  await test('createRetry produces a working retry function', async () => {
    const robustRetry = createRetry({ retries: 3, base: 1, ...noJitter });
    const fn = makeCounter(2, 'created');
    const result = await robustRetry(fn);
    assert.strictEqual(result, 'created');
  });

  await test('overrides from call site win over createRetry defaults', async () => {
    const log = [];
    const robustRetry = createRetry({ retries: 5, base: 1 });
    const fn = makeCounter(99);
    await assert.rejects(
      () => robustRetry(fn, { retries: 1, base: 1, ...noJitter, onRetry: (e, a) => log.push(a) }),
      RetryError
    );
    assert.strictEqual(log.length, 1);
  });

  console.log('\n▶  retryify');

  await test('retryify wraps a function transparently', async () => {
    const greet = async (name) => `Hello, ${name}!`;
    const retried = retryify(greet, { retries: 2, base: 1 });
    const result = await retried('world');
    assert.strictEqual(result, 'Hello, world!');
  });

  await test('retryify forwards all arguments', async () => {
    const add = async (a, b, c) => a + b + c;
    const retriedAdd = retryify(add, { retries: 1, base: 1 });
    const result = await retriedAdd(1, 2, 3);
    assert.strictEqual(result, 6);
  });

  await test('retryify retries on failure', async () => {
    let calls = 0;
    const fn = async (x) => {
      calls++;
      if (calls < 3) throw new Error('not yet');
      return x * 2;
    };
    const retried = retryify(fn, { retries: 5, base: 1, ...noJitter });
    const result = await retried(21);
    assert.strictEqual(result, 42);
    assert.strictEqual(calls, 3);
  });

  await test('retryify preserves `this` context', async () => {
    const obj = {
      value: 99,
      async get() { return this.value; },
    };
    obj.get = retryify(obj.get, { retries: 1, base: 1 });
    const result = await obj.get();
    assert.strictEqual(result, 99);
  });

  console.log('\n▶  input validation');

  await test('throws TypeError when fn is not a function', async () => {
    await assert.rejects(() => retry('not a function'), TypeError);
  });

  await test('throws RangeError for negative retries', async () => {
    await assert.rejects(() => retry(() => Promise.resolve(), { retries: -1 }), RangeError);
  });

  await test('throws TypeError from retryify when fn is not a function', () => {
    assert.throws(() => retryify(42), TypeError);
  });

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Tests:  ${passed + failed}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log('─'.repeat(50) + '\n');

  if (failed > 0) process.exit(1);
})();
