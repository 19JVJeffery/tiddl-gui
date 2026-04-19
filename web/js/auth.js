/**
 * tiddl-web — authentication module
 *
 * Implements the TIDAL device-code OAuth2 flow, token storage in
 * localStorage, and token refresh.
 */

import { AUTH_URL, API_URL, getClientId, getClientSecret, proxied } from "./config.js";

const STORAGE_KEY = "tiddl_auth";

// ─── Storage helpers ───────────────────────────────────────────────────────

export function loadAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveAuth(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

export function isLoggedIn() {
  const auth = loadAuth();
  return !!(auth && auth.token);
}

export function isTokenExpired(earlyExpireSecs = 60) {
  const auth = loadAuth();
  if (!auth || !auth.expires_at) return true;
  return Date.now() / 1000 >= auth.expires_at - earlyExpireSecs;
}

// ─── Custom error ─────────────────────────────────────────────────────────

/**
 * Wraps a Tidal auth HTTP error so callers get a proper Error with a stack
 * trace while still being able to inspect `.status` and `.error` (OAuth error
 * code such as "authorization_pending").
 */
class TidalAuthError extends Error {
  constructor(status, json) {
    super(json.error_description || json.error || `HTTP ${status}`);
    this.name = "TidalAuthError";
    this.status = status;
    // Copy all fields from the JSON response (e.g. error, error_description)
    Object.assign(this, json);
  }
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function postForm(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(proxied(url), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    credentials: "omit",
  });
  const json = await res.json();
  if (!res.ok) throw new TidalAuthError(res.status, json);
  return json;
}

async function postFormWithBasicAuth(url, params, clientId, clientSecret) {
  const body = new URLSearchParams(params);
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(proxied(url), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: body.toString(),
    credentials: "omit",
  });
  const json = await res.json();
  if (!res.ok) throw new TidalAuthError(res.status, json);
  return json;
}

// ─── Device-code flow ─────────────────────────────────────────────────────

/**
 * Step 1 — request a device code.
 * Returns { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }
 */
export async function getDeviceAuth() {
  return postForm(`${AUTH_URL}/device_authorization`, {
    client_id: getClientId(),
    scope: "r_usr+w_usr+w_sub",
  });
}

/**
 * Step 2 — exchange device code for tokens.
 * Throws with .error === "authorization_pending" while user hasn't confirmed.
 */
export async function pollDeviceAuth(deviceCode) {
  return postFormWithBasicAuth(
    `${AUTH_URL}/token`,
    {
      client_id: getClientId(),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      scope: "r_usr+w_usr+w_sub",
    },
    getClientId(),
    getClientSecret()
  );
}

// ─── Token refresh ─────────────────────────────────────────────────────────

export async function refreshToken() {
  const auth = loadAuth();
  if (!auth?.refresh_token) throw new Error("No refresh token stored");

  const json = await postFormWithBasicAuth(
    `${AUTH_URL}/token`,
    {
      client_id: getClientId(),
      refresh_token: auth.refresh_token,
      grant_type: "refresh_token",
      scope: "r_usr+w_usr+w_sub",
    },
    getClientId(),
    getClientSecret()
  );

  const updated = {
    ...auth,
    token: json.access_token,
    expires_at: Math.floor(Date.now() / 1000) + json.expires_in,
  };
  saveAuth(updated);
  return updated;
}

// ─── Logout ────────────────────────────────────────────────────────────────

export async function logout() {
  const auth = loadAuth();
  if (auth?.token) {
    try {
      await fetch(proxied(`${API_URL}/logout`), {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
      });
    } catch {
      /* best-effort */
    }
  }
  clearAuth();
}

// ─── Token accessor (auto-refresh) ─────────────────────────────────────────

export async function getValidToken() {
  if (!isLoggedIn()) return null;
  if (isTokenExpired()) {
    const updated = await refreshToken();
    return updated.token;
  }
  return loadAuth().token;
}

// Expose a global function to force token refresh (for download error recovery)
if (typeof window !== 'undefined') {
  window.tiddlForceTokenRefresh = async () => {
    try {
      await refreshToken();
      console.info('[tiddl] Token refreshed via tiddlForceTokenRefresh');
    } catch (err) {
      console.error('[tiddl] Token refresh failed:', err);
    }
  };
}
