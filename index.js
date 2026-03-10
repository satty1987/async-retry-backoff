'use strict';

/**
 * Custom error class for retry exhaustion
 */
class RetryError extends Error {
  constructor(message, { attempts, lastError, results }) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
    this.results = results; // all attempt results/errors
  }
}

/**
 * Custom error class for timeout
 */
class TimeoutError extends Error {
  constructor(ms) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.ms = ms;
  }
}

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a promise with a timeout
 * @param {Promise} promise
 * @param {number} ms
 * @returns {Promise}
 */
const withTimeout = (promise, ms) => {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Compute the delay for a given attempt using exponential backoff with jitter.
 *
 * delay = min(base * (factor ^ attempt), maxDelay) ± jitter
 *
 * @param {number} attempt   - zero-indexed attempt number
 * @param {object} options
 * @param {number} options.base      - base delay in ms (default 100)
 * @param {number} options.factor    - exponential factor (default 2)
 * @param {number} options.maxDelay  - cap on delay in ms (default 30_000)
 * @param {number} options.jitter    - fraction of delay to randomise [0–1] (default 0.2)
 * @returns {number} delay in ms
 */
const computeDelay = (attempt, { base = 100, factor = 2, maxDelay = 30_000, jitter = 0.2 } = {}) => {
  const exponential = Math.min(base * Math.pow(factor, attempt), maxDelay);
  const spread = exponential * jitter;
  return Math.round(exponential - spread / 2 + Math.random() * spread);
};

/**
 * Retry an async function with exponential backoff.
 *
 * @template T
 * @param {() => Promise<T>} fn           - The async function to retry
 * @param {object}           [options]
 * @param {number}           [options.retries=3]          - Max number of retries (not including first attempt)
 * @param {number}           [options.base=100]           - Base delay in ms
 * @param {number}           [options.factor=2]           - Exponential backoff factor
 * @param {number}           [options.maxDelay=30000]     - Maximum delay between retries in ms
 * @param {number}           [options.jitter=0.2]         - Jitter fraction [0–1] to randomise delay
 * @param {number}           [options.timeout]            - Per-attempt timeout in ms (optional)
 * @param {number}           [options.totalTimeout]       - Absolute timeout across ALL attempts in ms (optional)
 * @param {Function}         [options.shouldRetry]        - (error, attempt) => boolean — custom retry predicate
 * @param {Function}         [options.onRetry]            - (error, attempt, delay) => void — called before each retry
 * @param {AbortSignal}      [options.signal]             - AbortSignal to cancel retries
 * @returns {Promise<T>}
 */
async function retry(fn, options = {}) {
  const {
    retries = 3,
    base = 100,
    factor = 2,
    maxDelay = 30_000,
    jitter = 0.2,
    timeout,
    totalTimeout,
    shouldRetry = () => true,
    onRetry = () => {},
    signal,
  } = options;

  if (typeof fn !== 'function') {
    throw new TypeError('retry: first argument must be a function');
  }
  if (retries < 0 || !Number.isInteger(retries)) {
    throw new RangeError('retry: `retries` must be a non-negative integer');
  }

  const startedAt = Date.now();
  const results = [];
  const maxAttempts = retries + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check abort signal
    if (signal?.aborted) {
      const abortError = new Error('Retry aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }

    // Check total timeout
    if (totalTimeout && Date.now() - startedAt >= totalTimeout) {
      throw new TimeoutError(totalTimeout);
    }

    try {
      const result = await withTimeout(fn(), timeout);
      return result;
    } catch (error) {
      results.push({ attempt: attempt + 1, error });

      const isLastAttempt = attempt === maxAttempts - 1;
      const isAbort = error?.name === 'AbortError' || signal?.aborted;

      if (isLastAttempt || isAbort || !shouldRetry(error, attempt + 1)) {
        throw new RetryError(
          `Failed after ${attempt + 1} attempt(s): ${error?.message ?? error}`,
          { attempts: attempt + 1, lastError: error, results }
        );
      }

      const delay = computeDelay(attempt, { base, factor, maxDelay, jitter });

      // Clamp delay to remaining totalTimeout budget
      const remainingBudget = totalTimeout ? totalTimeout - (Date.now() - startedAt) : Infinity;
      const clampedDelay = Math.min(delay, remainingBudget);

      onRetry(error, attempt + 1, clampedDelay);

      if (clampedDelay > 0) {
        await sleep(clampedDelay);
      }
    }
  }
}

/**
 * Create a pre-configured retry function with default options baked in.
 *
 * @param {object} defaults - Default options (same shape as `retry` options)
 * @returns {Function}      - (fn, overrides?) => Promise
 *
 * @example
 * const robustFetch = createRetry({ retries: 5, base: 200, factor: 3 });
 * await robustFetch(() => fetch('https://api.example.com/data'));
 */
function createRetry(defaults = {}) {
  return (fn, overrides = {}) => retry(fn, { ...defaults, ...overrides });
}

/**
 * Wrap an async function so that every call is automatically retried.
 *
 * @param {Function} fn       - The async function to wrap
 * @param {object}   options  - Retry options
 * @returns {Function}        - Wrapped function with identical signature
 *
 * @example
 * const fetchWithRetry = retryify(fetch, { retries: 3 });
 * const res = await fetchWithRetry('https://api.example.com');
 */
function retryify(fn, options = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('retryify: first argument must be a function');
  }
  return function retried(...args) {
    return retry(() => fn.apply(this, args), options);
  };
}

module.exports = {
  retry,
  createRetry,
  retryify,
  computeDelay,
  RetryError,
  TimeoutError,
};
