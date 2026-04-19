/**
 * tiddl-web — HTTP transport layer
 *
 * Provides:
 *  - timedFetch  : plain fetch wrapped with an AbortController timeout;
 *                  network / CORS errors are normalized to TiddlError(NETWORK).
 *  - robustFetch : timedFetch with automatic retry and exponential back-off.
 *  - TiddlError  : unified error class with a stable `kind` code.
 *  - ErrKind     : enum of all error categories used across the codebase.
 */

// ─── Timeout constants ────────────────────────────────────────────────────────

/** Default timeout for Tidal API JSON requests (ms). */
export const API_TIMEOUT_MS     = 30_000;
/** Timeout for individual audio/video segment downloads (ms). */
export const SEGMENT_TIMEOUT_MS = 90_000;
/** Timeout for OAuth2 / auth endpoint requests (ms). */
export const AUTH_TIMEOUT_MS    = 20_000;

// ─── Error taxonomy ───────────────────────────────────────────────────────────

/**
 * Stable error kind codes.  Every thrown error from this module — and from
 * higher-level modules that use it — carries one of these codes so the UI
 * can decide how to display / retry without string-matching on messages.
 */
export const ErrKind = Object.freeze({
  NETWORK:   "NETWORK",    // fetch / CORS / timeout
  AUTH:      "AUTH",       // 401 / 403 authentication failures
  API:       "API",        // upstream Tidal API error (non-auth)
  PROXY:     "PROXY",      // CORS proxy failure
  MANIFEST:  "MANIFEST",   // manifest parse failure
  SEGMENT:   "SEGMENT",    // audio/video segment fetch failure
  ENCRYPTED: "ENCRYPTED",  // DRM-encrypted stream
  PACKAGING: "PACKAGING",  // ZIP / file-save failure
  UNKNOWN:   "UNKNOWN",
});

/**
 * Unified application error.  All modules convert low-level fetch / parse
 * errors into TiddlError instances so callers have a single type to handle.
 *
 * @property {string}  kind         One of ErrKind
 * @property {boolean} isTiddlError Always true — lets callers do a fast
 *                                  `if (err.isTiddlError)` check without
 *                                  instanceof across module boundaries.
 */
export class TiddlError extends Error {
  /**
   * @param {string} message  Human-readable description.
   * @param {string} [kind]   One of ErrKind (default: UNKNOWN).
   * @param {object} [extra]  Extra properties mixed into `this`
   *                          (e.g. { url, status, isTimeout: true }).
   */
  constructor(message, kind = ErrKind.UNKNOWN, extra = {}) {
    super(message);
    this.name         = "TiddlError";
    this.kind         = kind;
    this.isTiddlError = true;
    Object.assign(this, extra);
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function _isNetworkLike(err) {
  if (err instanceof TypeError) return true; // native "Failed to fetch"
  const m = String(err?.message ?? "").toLowerCase();
  return /failed to fetch|network[\s_]?error|load failed|cors|cross[\s-]?origin/.test(m);
}

// ─── timedFetch ───────────────────────────────────────────────────────────────

/**
 * Fetch with an AbortController-backed timeout.
 *
 * - Network / CORS errors are re-thrown as TiddlError(NETWORK).
 * - Timeout expiry re-throws as TiddlError(NETWORK) with `isTimeout: true`.
 * - Non-OK responses are returned as-is — the caller decides how to handle them.
 *
 * @param {string}      url
 * @param {RequestInit} [init]
 * @param {number}      [timeoutMs=API_TIMEOUT_MS]
 * @returns {Promise<Response>}
 */
export async function timedFetch(url, init = {}, timeoutMs = API_TIMEOUT_MS) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    if (err.name === "AbortError" || ac.signal.aborted) {
      throw new TiddlError(
        `Request timed out after ${timeoutMs / 1000}s`,
        ErrKind.NETWORK,
        { url, isTimeout: true },
      );
    }
    if (_isNetworkLike(err)) {
      throw new TiddlError(
        err.message || "Network / CORS error",
        ErrKind.NETWORK,
        { url, cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── robustFetch ──────────────────────────────────────────────────────────────

/**
 * Fetch with automatic retry and exponential back-off.
 *
 * Behaviour:
 * - Retries on network errors (including timeout) and 429/5xx responses.
 * - Does NOT retry 4xx responses (caller handles auth errors etc.).
 * - Hard errors (TiddlError with kind AUTH or ENCRYPTED) skip retries.
 *
 * Non-OK responses are returned as-is — the caller inspects the status.
 *
 * @param {string}      url
 * @param {RequestInit} [init]
 * @param {object}      [opts]
 * @param {number}      [opts.timeoutMs=API_TIMEOUT_MS]
 * @param {number}      [opts.retries=2]       Extra attempts after first failure.
 * @param {number}      [opts.baseDelay=700]   ms for first back-off pause.
 * @returns {Promise<Response>}
 */
export async function robustFetch(url, init = {}, {
  timeoutMs = API_TIMEOUT_MS,
  retries   = 2,
  baseDelay = 700,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await timedFetch(url, init, timeoutMs);
      if (!res.ok && attempt < retries && (res.status === 429 || res.status >= 500)) {
        await _sleep(baseDelay * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      const isHardStop = err instanceof TiddlError
        && (err.kind === ErrKind.AUTH || err.kind === ErrKind.ENCRYPTED);
      if (!isHardStop && attempt < retries) {
        await _sleep(baseDelay * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
