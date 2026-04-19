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

// ─── Credentials ─────────────────────────────────────────────────────────────

export function getClientId() {
  return localStorage.getItem("tiddl_client_id") || DEFAULT_CLIENT_ID;
}
export function getClientSecret() {
  return localStorage.getItem("tiddl_client_secret") || DEFAULT_CLIENT_SECRET;
}
export function setClientId(v) {
  if (v) localStorage.setItem("tiddl_client_id", v);
  else localStorage.removeItem("tiddl_client_id");
}
export function setClientSecret(v) {
  if (v) localStorage.setItem("tiddl_client_secret", v);
  else localStorage.removeItem("tiddl_client_secret");
}

// ─── CORS proxy ───────────────────────────────────────────────────────────────

/** CORS proxy prefix — every request to Tidal is sent through this URL. */
const DEFAULT_CORS_PROXY = "https://corsproxy.io/?url=";

function isCorsproxyHost(proxy) {
  try {
    const host = new URL(proxy).hostname.toLowerCase();
    return host === "corsproxy.io" || host.endsWith(".corsproxy.io");
  } catch {
    return false;
  }
}

function normalizeCorsProxy(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return DEFAULT_CORS_PROXY;

  if (isCorsproxyHost(raw)) {
    // Accept common forms and normalize to a working prefix.
    try {
      const parsed = new URL(raw);
      const params = new URLSearchParams(parsed.search);
      params.delete("url");
      const query = params.toString();
      const prefix = `${parsed.origin}${parsed.pathname}`;
      return query
        ? `${prefix}?${query}&url=`
        : `${prefix}?url=`;
    } catch {
      return DEFAULT_CORS_PROXY;
    }
  }

  return raw;
}

export function getCorsProxy() {
  const saved = localStorage.getItem("tiddl_cors_proxy");
  return normalizeCorsProxy(saved);
}
export function setCorsProxy(v) {
  const raw = String(v ?? "").trim();
  if (!raw) {
    localStorage.removeItem("tiddl_cors_proxy");
    return;
  }
  localStorage.setItem("tiddl_cors_proxy", normalizeCorsProxy(raw));
}

/** Wrap a target URL with the configured CORS proxy. */
export function proxied(url) {
  const proxy = getCorsProxy();
  // corsproxy.io expects the URL to be encoded as a query param
  if (isCorsproxyHost(proxy)) {
    return proxy + encodeURIComponent(url);
  }
  // fallback: just append raw
  return proxy + url;
}

// ─── Appearance ───────────────────────────────────────────────────────────────

/** "dark" | "light" | "system" */
export function getTheme() {
  return localStorage.getItem("tiddl_theme") || "system";
}
export function setTheme(v) {
  localStorage.setItem("tiddl_theme", v);
}

/** Hex accent colour, e.g. "#4fd08c" */
export function getAccentColor() {
  return localStorage.getItem("tiddl_accent") || "#4fd08c";
}
export function setAccentColor(v) {
  localStorage.setItem("tiddl_accent", v);
}

/** "full" | "reduced" | "minimal" | "classic" */
export function getUiEffects() {
  return localStorage.getItem("tiddl_ui_effects") || "full";
}
export function setUiEffects(v) {
  localStorage.setItem("tiddl_ui_effects", v);
}

// ─── Download settings ────────────────────────────────────────────────────────

function getSetting(key, def) {
  const v = localStorage.getItem(key);
  return v === null ? def : v;
}
function setSetting(key, v) {
  localStorage.setItem(key, String(v));
}

export function getTrackQuality()        { return getSetting("tiddl_track_quality", "HIGH"); }
export function setTrackQuality(v)       { setSetting("tiddl_track_quality", v); }

export function getVideoQuality()        { return getSetting("tiddl_video_quality", "fhd"); }
export function setVideoQuality(v)       { setSetting("tiddl_video_quality", v); }

export function getThreadsCount()        { return parseInt(getSetting("tiddl_threads", "4"), 10); }
export function setThreadsCount(v)       { setSetting("tiddl_threads", v); }

export function getSkipExisting()        { return getSetting("tiddl_skip_existing", "true") === "true"; }
export function setSkipExisting(v)       { setSetting("tiddl_skip_existing", v ? "true" : "false"); }

export function getSinglesFilter()       { return getSetting("tiddl_singles_filter", "none"); }
export function setSinglesFilter(v)      { setSetting("tiddl_singles_filter", v); }

export function getVideosFilter()        { return getSetting("tiddl_videos_filter", "none"); }
export function setVideosFilter(v)       { setSetting("tiddl_videos_filter", v); }

export function getUpdateMtime()         { return getSetting("tiddl_update_mtime", "false") === "true"; }
export function setUpdateMtime(v)        { setSetting("tiddl_update_mtime", v ? "true" : "false"); }

export function getRewriteMetadata()     { return getSetting("tiddl_rewrite_metadata", "false") === "true"; }
export function setRewriteMetadata(v)    { setSetting("tiddl_rewrite_metadata", v ? "true" : "false"); }

// ─── Metadata settings ────────────────────────────────────────────────────────

export function getMetadataEnable()      { return getSetting("tiddl_meta_enable", "true") === "true"; }
export function setMetadataEnable(v)     { setSetting("tiddl_meta_enable", v ? "true" : "false"); }

export function getMetadataLyrics()      { return getSetting("tiddl_meta_lyrics", "false") === "true"; }
export function setMetadataLyrics(v)     { setSetting("tiddl_meta_lyrics", v ? "true" : "false"); }

export function getLyricsTimestamps()    { return getSetting("tiddl_lyrics_timestamps", "true") === "true"; }
export function setLyricsTimestamps(v)   { setSetting("tiddl_lyrics_timestamps", v ? "true" : "false"); }

export function getMetadataCover()       { return getSetting("tiddl_meta_cover", "false") === "true"; }
export function setMetadataCover(v)      { setSetting("tiddl_meta_cover", v ? "true" : "false"); }

export function getMetadataAlbumReview() { return getSetting("tiddl_meta_album_review", "false") === "true"; }
export function setMetadataAlbumReview(v){ setSetting("tiddl_meta_album_review", v ? "true" : "false"); }

// ─── Cover art settings ───────────────────────────────────────────────────────

export function getCoverSave()           { return getSetting("tiddl_cover_save", "false") === "true"; }
export function setCoverSave(v)          { setSetting("tiddl_cover_save", v ? "true" : "false"); }

export function getCoverSize()           { return parseInt(getSetting("tiddl_cover_size", "1280"), 10); }
export function setCoverSize(v)          { setSetting("tiddl_cover_size", v); }

export function getCoverAllowed()        { return JSON.parse(getSetting("tiddl_cover_allowed", "[]")); }
export function setCoverAllowed(v)       { setSetting("tiddl_cover_allowed", JSON.stringify(v)); }

// ─── M3U settings ─────────────────────────────────────────────────────────────

export function getM3uSave()             { return getSetting("tiddl_m3u_save", "false") === "true"; }
export function setM3uSave(v)            { setSetting("tiddl_m3u_save", v ? "true" : "false"); }

export function getM3uAllowed()          { return JSON.parse(getSetting("tiddl_m3u_allowed", '["album","mix","playlist"]')); }
export function setM3uAllowed(v)         { setSetting("tiddl_m3u_allowed", JSON.stringify(v)); }

// ─── Advanced mode ────────────────────────────────────────────────────────────

export function getAdvancedMode()        { return getSetting("tiddl_advanced_mode", "false") === "true"; }
export function setAdvancedMode(v)       { setSetting("tiddl_advanced_mode", v ? "true" : "false"); }

// ─── Experimental: all-qualities mode ────────────────────────────────────────

/** When enabled, every queue item is downloaded in all four quality tiers. */
export function getAllQualitiesMode()   { return getSetting("tiddl_all_qualities", "false") === "true"; }
export function setAllQualitiesMode(v) { setSetting("tiddl_all_qualities", v ? "true" : "false"); }

// ─── Preferred format ─────────────────────────────────────────────────────────

/**
 * "m4a" — use the quality tier as-is (LOW/HIGH produce AAC/M4A).
 * "flac" — automatically upgrade LOW/HIGH quality to LOSSLESS so downloads
 *           are always in FLAC format.
 */
export function getPreferredFormat()   { return getSetting("tiddl_preferred_format", "m4a"); }
export function setPreferredFormat(v)  { setSetting("tiddl_preferred_format", v); }

/** Labels for all quality tiers. */
export const QUALITY_LABELS = {
  LOW: "Low", HIGH: "High", LOSSLESS: "HiFi", HI_RES_LOSSLESS: "Max",
};

/** Detailed option text for quality tier selects. */
export const QUALITY_DESCRIPTIONS = {
  LOW:            "Low — 96 kbps · M4A",
  HIGH:           "High — 320 kbps · M4A",
  LOSSLESS:       "HiFi — FLAC 16-bit",
  HI_RES_LOSSLESS: "Max — FLAC 24-bit",
};

/** Available quality tiers, highest first. */
export const QUALITY_STANDARD = ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];

// ─── Search history ───────────────────────────────────────────────────────────

const SEARCH_HISTORY_KEY  = "tiddl_search_history";
const SEARCH_HISTORY_MAX  = 12;

export function loadSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]"); }
  catch { return []; }
}
export function saveToSearchHistory(q) {
  if (!q?.trim()) return;
  const h = loadSearchHistory().filter(x => x !== q.trim());
  h.unshift(q.trim());
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(h.slice(0, SEARCH_HISTORY_MAX)));
}
export function clearSearchHistory() {
  localStorage.removeItem(SEARCH_HISTORY_KEY);
}

// ─── File path templates ──────────────────────────────────────────────────────

const TEMPLATE_DEFAULTS = {
  default:  "{album.artist}/{album.title}/{item.title}",
  track:    "",
  video:    "videos/{item.title}",
  album:    "artists/{album.artist}/{album.title}/{item.title}",
  playlist: "{playlist.title}/{playlist.index}. {item.artist} - {item.title}",
  mix:      "mixes/{mix_id}/{item.artist} - {item.title}",
};

export function getTemplate(type) {
  const v = localStorage.getItem(`tiddl_tpl_${type}`);
  return v !== null ? v : (TEMPLATE_DEFAULTS[type] ?? "");
}
export function setTemplate(type, v) {
  localStorage.setItem(`tiddl_tpl_${type}`, v);
}
export { TEMPLATE_DEFAULTS };
