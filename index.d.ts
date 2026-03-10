export interface RetryOptions {
  /**
   * Maximum number of retries after the initial attempt.
   * @default 3
   */
  retries?: number;

  /**
   * Base delay in milliseconds before the first retry.
   * @default 100
   */
  base?: number;

  /**
   * Multiplicative factor applied to the delay after each retry.
   * @default 2
   */
  factor?: number;

  /**
   * Maximum delay cap in milliseconds between retries.
   * @default 30000
   */
  maxDelay?: number;

  /**
   * Fraction of the computed delay to randomise (adds jitter).
   * Value between 0 and 1. Set to 0 to disable jitter.
   * @default 0.2
   */
  jitter?: number;

  /**
   * Per-attempt timeout in milliseconds.
   * If exceeded, the attempt is rejected with a `TimeoutError`.
   */
  timeout?: number;

  /**
   * Absolute timeout in milliseconds across ALL attempts combined.
   * If exceeded, a `TimeoutError` is thrown immediately.
   */
  totalTimeout?: number;

  /**
   * Custom predicate called before each retry.
   * Return `false` to stop retrying immediately.
   *
   * @param error   - The error thrown by the last attempt
   * @param attempt - 1-based attempt number that just failed
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;

  /**
   * Callback invoked before sleeping prior to each retry.
   *
   * @param error   - The error thrown by the last attempt
   * @param attempt - 1-based attempt number that just failed
   * @param delay   - The delay in ms that will be applied before the next attempt
   */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;

  /**
   * An `AbortSignal` that, when aborted, stops the retry loop immediately.
   */
  signal?: AbortSignal;
}

export interface AttemptResult {
  attempt: number;
  error: unknown;
}

/**
 * Thrown when all retry attempts are exhausted.
 */
export declare class RetryError extends Error {
  name: 'RetryError';
  /** Total number of attempts made */
  attempts: number;
  /** The error thrown by the last attempt */
  lastError: unknown;
  /** All attempt results (each with attempt number and error) */
  results: AttemptResult[];
}

/**
 * Thrown when a per-attempt or total timeout is exceeded.
 */
export declare class TimeoutError extends Error {
  name: 'TimeoutError';
  /** The timeout value in milliseconds that was exceeded */
  ms: number;
}

/**
 * Compute the exponential-backoff delay for a given attempt index.
 *
 * @param attempt - Zero-indexed attempt number
 * @param options - Delay configuration
 * @returns Delay in milliseconds
 */
export declare function computeDelay(
  attempt: number,
  options?: Pick<RetryOptions, 'base' | 'factor' | 'maxDelay' | 'jitter'>
): number;

/**
 * Retry an async function with exponential backoff.
 *
 * @param fn      - Async function to execute (called on each attempt)
 * @param options - Retry configuration
 * @returns The resolved value of `fn` on success
 * @throws {RetryError}   when all attempts fail
 * @throws {TimeoutError} when a timeout is exceeded
 *
 * @example
 * const data = await retry(() => fetch('https://api.example.com/data'), {
 *   retries: 5,
 *   base: 200,
 *   onRetry: (err, attempt, delay) =>
 *     console.log(`Attempt ${attempt} failed. Retrying in ${delay}ms…`),
 * });
 */
export declare function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;

/**
 * Create a pre-configured retry function with baked-in default options.
 *
 * @param defaults - Default retry options applied to every call
 * @returns A `retry`-like function that accepts `(fn, overrides?)`
 *
 * @example
 * const robustRetry = createRetry({ retries: 5, base: 500, factor: 3 });
 * await robustRetry(() => someAsyncOperation());
 */
export declare function createRetry(
  defaults?: RetryOptions
): <T>(fn: () => Promise<T>, overrides?: RetryOptions) => Promise<T>;

/**
 * Wrap an async function so that every invocation is automatically retried.
 *
 * @param fn      - Async function to wrap
 * @param options - Retry options applied on every call
 * @returns A new function with the same signature as `fn`
 *
 * @example
 * const fetchWithRetry = retryify(fetch, { retries: 3, base: 100 });
 * const response = await fetchWithRetry('https://api.example.com');
 */
export declare function retryify<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options?: RetryOptions
): T;
