/**
 * tiddl-web — configuration
 *
 * Credentials mirror the ones embedded in the Python CLI (already public in
 * the open-source repository).  They are stored the same way — as a single
 * base-64 string that decodes to "clientId;clientSecret".
 */

const _raw = atob(
  "ZlgySnhkbW50WldLMGl4VDsxTm45QWZEQWp4cmdKRkpiS05XTGVBeUtHVkdtSU51WFBQTEhWWEF2eEFnPQ=="
);
const [DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET] = _raw.split(";");

export const AUTH_URL = "https://auth.tidal.com/v1/oauth2";
export const API_URL = "https://api.tidal.com/v1";

export function getClientId() {
  return localStorage.getItem("tiddl_client_id") || DEFAULT_CLIENT_ID;
}
export function getClientSecret() {
  return localStorage.getItem("tiddl_client_secret") || DEFAULT_CLIENT_SECRET;
}

/** CORS proxy prefix — every request to Tidal is sent through this URL. */
export function getCorsProxy() {
  return localStorage.getItem("tiddl_cors_proxy") ?? "https://corsproxy.io/?url=";
}
export function setCorsProxy(v) {
  localStorage.setItem("tiddl_cors_proxy", v);
}

/** Wrap a target URL with the configured CORS proxy. */
export function proxied(url) {
  const proxy = getCorsProxy().trim();
  if (!proxy) return url;
  return proxy + encodeURIComponent(url);
}
