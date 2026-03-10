/**
 * tiddl-web — download module
 *
 * Parses TIDAL stream manifests, fetches audio/video segments, and
 * triggers a browser file-save.  Mirrors tiddl/core/utils/parse.py and
 * tiddl/core/utils/download.py.
 */

import { proxied } from "./config.js";
import { getTrackStream, getVideoStream, getTrack, getAlbumItems, getPlaylistItems, getMixItems } from "./api.js";

/** Delay (ms) before revoking an object URL after triggering a download. */
const BLOB_URL_REVOKE_DELAY_MS = 1000;

// ─── Manifest parsing ──────────────────────────────────────────────────────

/**
 * Parse a `application/vnd.tidal.bts` (BTS JSON) manifest.
 * Returns { urls: string[], extension: string }.
 */
function parseBtsManifest(manifest) {
  const decoded = atob(manifest);
  const data = JSON.parse(decoded);

  let extension = ".m4a";
  if (data.codecs === "flac") extension = ".flac";

  return { urls: data.urls, extension, encryptionType: data.encryptionType };
}

/**
 * Parse a `application/dash+xml` (MPEG-DASH) manifest.
 * Returns { urls: string[], extension: string }.
 */
function parseDashManifest(manifest) {
  const decoded = atob(manifest);
  const parser = new DOMParser();
  const doc = parser.parseFromString(decoded, "application/xml");

  const NS = "urn:mpeg:dash:schema:mpd:2011";

  const repr = doc.getElementsByTagNameNS(NS, "Representation")[0];
  const codecs = repr?.getAttribute("codecs") || "";

  const segTpl = doc.getElementsByTagNameNS(NS, "SegmentTemplate")[0];
  const urlTemplate = segTpl?.getAttribute("media") || "";

  const timeline = doc.getElementsByTagNameNS(NS, "S");
  let total = 0;
  for (const el of timeline) {
    total += 1;
    const r = el.getAttribute("r");
    if (r) total += parseInt(r, 10);
  }

  const urls = [];
  // Segments are $Number$-indexed starting at 0 through `total` inclusive,
  // matching the Python parse_manifest_XML: range(0, total + 1).
  for (let i = 0; i <= total; i++) {
    urls.push(urlTemplate.replace("$Number$", String(i)));
  }

  const extension = codecs.includes("flac") ? ".flac" : ".m4a";
  return { urls, extension, encryptionType: "NONE" };
}

function parseStreamManifest(streamInfo) {
  const { manifest, manifestMimeType } = streamInfo;
  switch (manifestMimeType) {
    case "application/vnd.tidal.bts":
      return parseBtsManifest(manifest);
    case "application/dash+xml":
      return parseDashManifest(manifest);
    default:
      throw new Error(`Unsupported manifest type: ${manifestMimeType}`);
  }
}

// ─── Segment fetching ──────────────────────────────────────────────────────

/**
 * Fetch all segment URLs and concatenate them into a single Uint8Array.
 * Calls onProgress(downloaded, total) after each segment.
 */
async function fetchSegments(urls, onProgress) {
  const chunks = [];
  let downloaded = 0;
  const total = urls.length;

  for (const url of urls) {
    const res = await fetch(proxied(url));
    if (!res.ok) throw new Error(`Segment fetch failed: ${res.status} ${url}`);
    const buf = await res.arrayBuffer();
    chunks.push(new Uint8Array(buf));
    downloaded++;
    if (onProgress) onProgress(downloaded, total);
  }

  // Concatenate
  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

// ─── Browser save helper ───────────────────────────────────────────────────

function triggerDownload(data, filename, mimeType) {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, BLOB_URL_REVOKE_DELAY_MS);
}

// ─── MIME type helper ──────────────────────────────────────────────────────

function extToMime(ext) {
  switch (ext) {
    case ".flac": return "audio/flac";
    case ".m4a": return "audio/mp4";
    case ".mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}

// ─── Sanitize filename ────────────────────────────────────────────────────

/** Maximum filename length to stay within common filesystem limits. */
const MAX_FILENAME_LENGTH = 200;

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, MAX_FILENAME_LENGTH);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Download a single track.
 * @param {string|number} trackId
 * @param {string} quality  LOW | HIGH | LOSSLESS | HI_RES_LOSSLESS
 * @param {Function} onProgress (downloaded, total, message) => void
 * @returns {Promise<{filename: string, success: boolean, error?: string}>}
 */
export async function downloadTrack(trackId, quality = "HIGH", onProgress) {
  try {
    onProgress?.(0, 1, `Fetching track info for #${trackId}…`);
    const track = await getTrack(trackId);
    const title = sanitize(track.title || String(trackId));
    const artist = sanitize(track.artist?.name || "Unknown Artist");

    onProgress?.(0, 1, `Getting stream for "${title}"…`);
    const streamInfo = await getTrackStream(trackId, quality);
    const { urls, extension, encryptionType } = parseStreamManifest(streamInfo);

    if (encryptionType && encryptionType !== "NONE") {
      throw new Error(
        `Stream is encrypted (${encryptionType}). Encrypted streams cannot be downloaded in the browser.`
      );
    }

    onProgress?.(0, urls.length, `Downloading ${urls.length} segment(s)…`);
    const data = await fetchSegments(urls, (done, total) =>
      onProgress?.(done, total, `Downloading segment ${done}/${total}…`)
    );

    const filename = `${artist} - ${title}${extension}`;
    triggerDownload(data, filename, extToMime(extension));

    return { filename, success: true };
  } catch (err) {
    return { filename: String(trackId), success: false, error: err.message };
  }
}

/**
 * Download all tracks in an album.
 */
export async function downloadAlbum(albumId, quality = "HIGH", onProgress) {
  onProgress?.(0, 1, `Fetching album items…`);
  const itemsData = await getAlbumItems(albumId, 100, 0);
  const items = (itemsData.items || []).filter((i) => i.type === "track");
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const track = items[i].item;
    onProgress?.(i, items.length, `Track ${i + 1}/${items.length}: ${track.title}`);
    const r = await downloadTrack(track.id, quality, (d, t, msg) =>
      onProgress?.(i, items.length, msg)
    );
    results.push(r);
  }
  return results;
}

/**
 * Download all tracks in a playlist.
 */
export async function downloadPlaylist(playlistId, quality = "HIGH", onProgress) {
  onProgress?.(0, 1, `Fetching playlist items…`);
  const itemsData = await getPlaylistItems(playlistId, 100, 0);
  const items = (itemsData.items || []).filter((i) => i.type === "track");
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const track = items[i].item;
    onProgress?.(i, items.length, `Track ${i + 1}/${items.length}: ${track.title}`);
    const r = await downloadTrack(track.id, quality, (d, t, msg) =>
      onProgress?.(i, items.length, msg)
    );
    results.push(r);
  }
  return results;
}

/**
 * Download all tracks in a mix.
 */
export async function downloadMix(mixId, quality = "HIGH", onProgress) {
  onProgress?.(0, 1, `Fetching mix items…`);
  const itemsData = await getMixItems(mixId, 100, 0);
  const items = (itemsData.items || []).filter((i) => i.type === "track");
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const track = items[i].item;
    onProgress?.(i, items.length, `Track ${i + 1}/${items.length}: ${track.title}`);
    const r = await downloadTrack(track.id, quality, (d, t, msg) =>
      onProgress?.(i, items.length, msg)
    );
    results.push(r);
  }
  return results;
}

// ─── URL / ID parser (mirrors tiddl/cli/utils/resource.py) ────────────────

const RESOURCE_TYPES = ["track", "video", "album", "artist", "playlist", "mix"];

export function parseTidalInput(input) {
  input = input.trim();

  // Full URL: https://tidal.com/browse/track/12345  or  https://listen.tidal.com/album/123/track/456
  try {
    const u = new URL(input);
    const parts = u.pathname.replace(/^\/browse\//, "/").split("/").filter(Boolean);
    // Look for a known resource type in the path segments
    for (let i = 0; i < parts.length - 1; i++) {
      const type = parts[i].toLowerCase();
      if (RESOURCE_TYPES.includes(type)) {
        return { type, id: parts[i + 1] };
      }
    }
  } catch {
    /* not a URL */
  }

  // Short form: track/12345  or  album/abc-uuid
  const slashMatch = input.match(/^(track|video|album|artist|playlist|mix)\/([^\s/]+)$/i);
  if (slashMatch) {
    return { type: slashMatch[1].toLowerCase(), id: slashMatch[2] };
  }

  // Bare numeric ID — assume track
  if (/^\d+$/.test(input)) {
    return { type: "track", id: input };
  }

  return null;
}
