# async-retry-backoff

> Auto-retry async functions with exponential backoff, jitter, timeouts, and abort support.

[![Node.js](https://img.shields.io/badge/node-%3E%3D14-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- **Exponential backoff** — delay grows geometrically after each failure
- **Full-range jitter** — randomised spread prevents thundering-herd
- **Per-attempt & total timeouts** — never wait forever
- **Custom retry predicate** — stop retrying on specific error types
- **`onRetry` hook** — log, instrument, or alert on each retry
- **AbortSignal support** — cancel mid-flight from any controller
- **TypeScript definitions** included
- **Zero dependencies**

---

## Installation

```bash
npm install async-retry-backoff
```

---

## Quick Start

```js
const { retry } = require('async-retry-backoff');

const data = await retry(() => fetch('https://api.example.com/data'), {
  retries: 4,
  onRetry: (err, attempt, delay) =>
    console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms…`),
});
```

---

## API

### `retry(fn, options?)`

Calls `fn()` and retries on failure according to `options`.

| Option         | Type                                      | Default    | Description                                               |
|----------------|-------------------------------------------|------------|-----------------------------------------------------------|
| `retries`      | `number`                                  | `3`        | Max retries after the initial attempt                     |
| `base`         | `number`                                  | `100`      | Base delay in ms                                          |
| `factor`       | `number`                                  | `2`        | Exponential factor applied per retry                      |
| `maxDelay`     | `number`                                  | `30000`    | Hard cap on delay in ms                                   |
| `jitter`       | `number`                                  | `0.2`      | Fraction of delay to randomise `[0–1]`                    |
| `timeout`      | `number`                                  | —          | Per-attempt timeout in ms                                 |
| `totalTimeout` | `number`                                  | —          | Absolute timeout across all attempts in ms                |
| `shouldRetry`  | `(error, attempt) => boolean`             | `() => true` | Return `false` to stop retrying immediately             |
| `onRetry`      | `(error, attempt, delay) => void`         | `() => {}`  | Called before each retry sleep                           |
| `signal`       | `AbortSignal`                             | —          | Cancels the retry loop when aborted                       |

**Returns** a `Promise` that resolves with `fn`'s return value, or rejects with a `RetryError`.

---

### `createRetry(defaults)`

Returns a pre-configured `retry` function with baked-in defaults. Call-site options override the defaults.

```js
const { createRetry } = require('async-retry-backoff');

const robustRetry = createRetry({ retries: 5, base: 200, factor: 3 });

// Later:
await robustRetry(() => someOperation());
await robustRetry(() => anotherOperation(), { retries: 1 }); // override
```

---

### `retryify(fn, options?)`

Wraps an async function so that every call is automatically retried. Returns a new function with the same signature.

```js
const { retryify } = require('async-retry-backoff');

const fetchWithRetry = retryify(fetch, { retries: 3, base: 100 });

// Works just like fetch, but retries automatically:
const response = await fetchWithRetry('https://api.example.com');
```

---

### `computeDelay(attempt, options?)`

Computes the backoff delay for a given zero-indexed attempt. Useful for custom schedulers or testing.

```js
const { computeDelay } = require('async-retry-backoff');

computeDelay(0, { base: 100, factor: 2, maxDelay: 30_000, jitter: 0.2 }); // ~100ms
computeDelay(1, { base: 100, factor: 2, maxDelay: 30_000, jitter: 0.2 }); // ~200ms
computeDelay(2, { base: 100, factor: 2, maxDelay: 30_000, jitter: 0.2 }); // ~400ms
```

---

### Error classes

#### `RetryError`

Thrown when all attempts are exhausted (or `shouldRetry` returns `false`).

| Property    | Type              | Description                           |
|-------------|-------------------|---------------------------------------|
| `attempts`  | `number`          | Total number of attempts made         |
| `lastError` | `unknown`         | Error from the final attempt          |
| `results`   | `AttemptResult[]` | Array of `{ attempt, error }` objects |

#### `TimeoutError`

Thrown when a per-attempt or total timeout fires.

| Property | Type     | Description                      |
|----------|----------|----------------------------------|
| `ms`     | `number` | The timeout value that was exceeded |

---

## Recipes

### Only retry on network errors

```js
const { retry, RetryError } = require('async-retry-backoff');

await retry(() => fetch(url), {
  retries: 5,
  shouldRetry: (err) => err?.name === 'TypeError', // fetch network error
});
```

### Retry with per-attempt timeout

```js
await retry(() => callSlowService(), {
  retries: 3,
  timeout: 5_000,    // each attempt must complete within 5s
  base: 500,
});
```

### Cancel in-progress retries

```js
const controller = new AbortController();

// Cancel after 10 seconds
setTimeout(() => controller.abort(), 10_000);

await retry(() => pollForResult(), {
  retries: 20,
  base: 1_000,
  signal: controller.signal,
});
```

### Structured logging on every retry

```js
await retry(() => fetchOrders(), {
  retries: 4,
  onRetry: (err, attempt, delay) => {
    logger.warn({
      msg: 'Retrying failed operation',
      attempt,
      nextRetryInMs: delay,
      reason: err?.message,
    });
  },
});
```

### Wrap an entire service client

```js
const { retryify } = require('async-retry-backoff');

class ApiClient {
  async getUser(id)   { /* … */ }
  async createOrder() { /* … */ }
}

const client = new ApiClient();
client.getUser    = retryify(client.getUser.bind(client),    { retries: 3 });
client.createOrder = retryify(client.createOrder.bind(client), { retries: 2 });
```

---

## Delay schedule (default options)

| Attempt | Delay (no jitter) |
|---------|-------------------|
| 1st retry | 100 ms |
| 2nd retry | 200 ms |
| 3rd retry | 400 ms |
| 4th retry | 800 ms |
| 5th retry | 1 600 ms |
| … | … |
| n-th retry | min(100 × 2ⁿ, 30 000) ms |

With default `jitter: 0.2`, each delay is randomised by ±10 %.

---

## License

MIT
