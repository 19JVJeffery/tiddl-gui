/**
 * tiddl-web — download module
 *
 * Parses TIDAL stream manifests, fetches audio/video segments, and
 * triggers a browser file-save.  Mirrors tiddl/core/utils/parse.py and
 * tiddl/core/utils/download.py.
 */

import { proxied } from "./config.js";
import { getTrackStream, getVideoStream, getTrack, getAlbum, getAlbumItems, getPlaylist, getPlaylistItems, getMixItems, getArtistAlbums, getArtistSingles } from "./api.js";

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
 * Fetch a single segment URL, trying direct first and falling back to the
 * configured CORS proxy.
 *
 * CDN segment URLs (e.g. Amazon CloudFront / Akamai) carry their own
 * time-limited auth tokens and are often accessible directly from the browser.
 * Using a CORS proxy can cause 403s because some CDNs bind the token to the
 * originating IP, which changes when traffic is routed via a proxy server.
 * Direct fetch is therefore attempted first; the proxy is only used if the
 * direct request fails (e.g. due to a CORS restriction in the browser).
 */
async function fetchSegment(url) {
  // 1. Try direct (no proxy) — works for most CDN segments
  try {
    const res = await fetch(url);
    if (res.ok) return res;
    // Non-2xx from CDN — fall through to proxy attempt
  } catch {
    // Network / CORS error — fall through
  }

  // 2. Fall back to proxy
  const proxiedUrl = proxied(url);
  if (proxiedUrl === url) {
    // Proxy not configured; nothing more to try
    throw new Error(`Segment fetch failed (no proxy configured): ${url}`);
  }
  const res2 = await fetch(proxiedUrl);
  if (!res2.ok) {
    throw new Error(`Segment fetch failed: ${res2.status} ${url}`);
  }
  return res2;
}

/**
 * Fetch all segment URLs and concatenate them into a single Uint8Array.
 * Calls onProgress(downloaded, total) after each segment.
 */
async function fetchSegments(urls, onProgress) {
  const chunks = [];
  let downloaded = 0;
  const total = urls.length;

  for (const url of urls) {
    const res = await fetchSegment(url);
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

// ─── ZIP timestamp helpers ─────────────────────────────────────────────────

/**
 * Encode the current local date/time as MS-DOS date and time words.
 * ZIP local/central-directory headers use this format.
 *   Date word: bits 15-9 = year-1980, bits 8-5 = month (1-12), bits 4-0 = day
 *   Time word: bits 15-11 = hours, bits 10-5 = minutes, bits 4-0 = secs/2
 * Zeroing these fields produces "December 31 1979" on macOS — avoid that.
 */
function dosNow() {
  const d = new Date();
  const date =
    (((d.getFullYear() - 1980) & 0x7F) << 9) |
    (((d.getMonth() + 1)       & 0x0F) << 5) |
    ( d.getDate()              & 0x1F);
  const time =
    ((d.getHours()                  & 0x1F) << 11) |
    ((d.getMinutes()                & 0x3F) <<  5) |
    ((Math.floor(d.getSeconds() / 2) & 0x1F));
  return { date, time };
}



/**
 * Compute CRC-32 of a Uint8Array (ISO 3309 polynomial).
 * Used by buildZip for the ZIP local/central-directory headers.
 */
function crc32(buf) {
  if (!crc32._t) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    crc32._t = t;
  }
  const t = crc32._t;
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Build a ZIP file (STORE method — no compression) from an array of
 * { name: string, data: Uint8Array } entries.
 * Suitable for packaging already-compressed audio/video files.
 * Returns a Uint8Array of the full ZIP binary.
 */
function buildZip(files) {
  const enc = new TextEncoder();
  const localParts = [];     // Uint8Arrays making up the local file headers + data
  const centralEntries = []; // Uint8Arrays for the central directory headers
  let localOffset = 0;

  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const checksum = crc32(data);
    const size = data.byteLength;
    const { date: dosDate, time: dosTime } = dosNow();

    // ── Local file header (30 bytes + file name) ──
    const lhBuf = new ArrayBuffer(30 + nameBytes.length);
    const lh = new DataView(lhBuf);
    lh.setUint32( 0, 0x04034b50, true); // LFH signature
    lh.setUint16( 4, 20, true);          // version needed (2.0)
    lh.setUint16( 6, 0x0800, true);      // general-purpose flags: UTF-8 name
    lh.setUint16( 8, 0, true);           // compression method: STORE
    lh.setUint16(10, dosTime, true);     // last mod time
    lh.setUint16(12, dosDate, true);     // last mod date
    lh.setUint32(14, checksum, true);    // CRC-32
    lh.setUint32(18, size, true);        // compressed size
    lh.setUint32(22, size, true);        // uncompressed size
    lh.setUint16(26, nameBytes.length, true); // file name length
    lh.setUint16(28, 0, true);           // extra field length
    new Uint8Array(lhBuf).set(nameBytes, 30);

    localParts.push(new Uint8Array(lhBuf), data);

    // ── Central directory header (46 bytes + file name) ──
    const cdhBuf = new ArrayBuffer(46 + nameBytes.length);
    const cdh = new DataView(cdhBuf);
    cdh.setUint32( 0, 0x02014b50, true); // CDH signature
    cdh.setUint16( 4, 20, true);          // version made by
    cdh.setUint16( 6, 20, true);          // version needed
    cdh.setUint16( 8, 0x0800, true);      // general-purpose flags: UTF-8
    cdh.setUint16(10, 0, true);           // compression: STORE
    cdh.setUint16(12, dosTime, true);     // last mod time
    cdh.setUint16(14, dosDate, true);     // last mod date
    cdh.setUint32(16, checksum, true);    // CRC-32
    cdh.setUint32(20, size, true);        // compressed size
    cdh.setUint32(24, size, true);        // uncompressed size
    cdh.setUint16(28, nameBytes.length, true); // file name length
    cdh.setUint16(30, 0, true);           // extra field length
    cdh.setUint16(32, 0, true);           // file comment length
    cdh.setUint16(34, 0, true);           // disk number start
    cdh.setUint16(36, 0, true);           // internal attributes
    cdh.setUint32(38, 0, true);           // external attributes
    cdh.setUint32(42, localOffset, true); // offset of local header
    new Uint8Array(cdhBuf).set(nameBytes, 46);
    centralEntries.push(new Uint8Array(cdhBuf));

    localOffset += 30 + nameBytes.length + size;
  }

  // ── End of central directory record (22 bytes) ──
  const cdSize = centralEntries.reduce((a, b) => a + b.byteLength, 0);
  const eocdBuf = new ArrayBuffer(22);
  const eocd = new DataView(eocdBuf);
  eocd.setUint32( 0, 0x06054b50, true); // EOCD signature
  eocd.setUint16( 4, 0, true);           // disk number
  eocd.setUint16( 6, 0, true);           // central dir start disk
  eocd.setUint16( 8, files.length, true); // entries on this disk
  eocd.setUint16(10, files.length, true); // total entries
  eocd.setUint32(12, cdSize, true);      // size of central dir
  eocd.setUint32(16, localOffset, true); // offset of central dir
  eocd.setUint16(20, 0, true);           // comment length

  // Concatenate everything into a single Uint8Array
  const allParts = [...localParts, ...centralEntries, new Uint8Array(eocdBuf)];
  const totalBytes = allParts.reduce((a, b) => a + b.byteLength, 0);
  const zip = new Uint8Array(totalBytes);
  let pos = 0;
  for (const part of allParts) { zip.set(part, pos); pos += part.byteLength; }
  return zip;
}

// ─── Internal track data fetcher ─────────────────────────────────────────

/**
 * Fetch and decode a single track's audio data without triggering a browser
 * save.  Used internally by downloadTrack and the multi-track ZIP bundlers.
 *
 * @returns {{ data: Uint8Array, extension: string, title: string,
 *             artist: string, trackNumber: number }}
 */
async function fetchTrackData(trackId, quality, onProgress) {
  onProgress?.(0, 1, `Fetching track info for #${trackId}…`);
  const track = await getTrack(trackId);
  const title = sanitize(track.title || String(trackId));
  const artist = sanitize(track.artist?.name || "Unknown Artist");
  const trackNumber = track.trackNumber || 0;

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

  return { data, extension, title, artist, trackNumber };
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
    const { data, extension, title, artist } = await fetchTrackData(trackId, quality, onProgress);
    const filename = `${artist} - ${title}${extension}`;
    triggerDownload(data, filename, extToMime(extension));
    return { filename, success: true };
  } catch (err) {
    return { filename: String(trackId), success: false, error: err.message };
  }
}

/**
 * Download all tracks in an album as a single ZIP file.
 * ZIP folder structure: `{albumArtist} - {albumTitle}/{track#}. {artist} - {title}.ext`
 */
export async function downloadAlbum(albumId, quality = "HIGH", onProgress, onSubItemProgress) {
  try {
    onProgress?.(0, 1, `Fetching album info…`);
    const [albumMeta, itemsData] = await Promise.all([
      getAlbum(albumId),
      getAlbumItems(albumId, 100, 0),
    ]);

    const albumTitle  = sanitize(albumMeta.title || "Unknown Album");
    const albumArtist = sanitize(albumMeta.artist?.name || "Unknown Artist");
    const folder = `${albumArtist} - ${albumTitle}`;

    const items = (itemsData.items || []).filter((i) => i.type === "track");
    const zipFiles = [];
    const results = [];

    for (let i = 0; i < items.length; i++) {
      const track = items[i].item;
      onProgress?.(i, items.length, `Track ${i + 1}/${items.length}: ${track.title}`);
      onSubItemProgress?.(i, items.length, track.title, 0, 1, "active");
      try {
        const td = await fetchTrackData(track.id, quality, (d, t, msg) => {
          onProgress?.(i, items.length, msg);
          onSubItemProgress?.(i, items.length, track.title, d, t, "active");
        });
        const num = String(td.trackNumber || (i + 1)).padStart(2, "0");
        const fname = `${folder}/${num}. ${td.artist} - ${td.title}${td.extension}`;
        zipFiles.push({ name: fname, data: td.data });
        results.push({ filename: fname, success: true });
        onSubItemProgress?.(i, items.length, td.title || track.title, 1, 1, "done");
      } catch (err) {
        results.push({ filename: track.title || String(track.id), success: false, error: err.message });
        onSubItemProgress?.(i, items.length, track.title, 0, 1, "failed");
      }
    }

    if (zipFiles.length > 0) {
      onProgress?.(items.length, items.length, `Packaging ${zipFiles.length} track(s) as ZIP…`);
      const zip = buildZip(zipFiles);
      triggerDownload(zip, `${folder}.zip`, "application/zip");
    }

    return results;
  } catch (err) {
    return [{ filename: String(albumId), success: false, error: err.message }];
  }
}

/**
 * Download all tracks in a playlist as a single ZIP file.
 * ZIP folder structure: `{playlistTitle}/{track#}. {artist} - {title}.ext`
 */
export async function downloadPlaylist(playlistId, quality = "HIGH", onProgress, onSubItemProgress) {
  try {
    onProgress?.(0, 1, `Fetching playlist info…`);
    const [playlistMeta, itemsData] = await Promise.all([
      getPlaylist(playlistId),
      getPlaylistItems(playlistId, 100, 0),
    ]);

    const playlistTitle = sanitize(playlistMeta.title || "Playlist");
    const folder = playlistTitle;

    const items = (itemsData.items || []).filter((i) => i.type === "track");
    const zipFiles = [];
    const results = [];

    for (let i = 0; i < items.length; i++) {
      const track = items[i].item;
      onProgress?.(i, items.length, `Track ${i + 1}/${items.length}: ${track.title}`);
      onSubItemProgress?.(i, items.length, track.title, 0, 1, "active");
      try {
        const td = await fetchTrackData(track.id, quality, (d, t, msg) => {
          onProgress?.(i, items.length, msg);
          onSubItemProgress?.(i, items.length, track.title, d, t, "active");
        });
        const num = String(i + 1).padStart(2, "0");
        const fname = `${folder}/${num}. ${td.artist} - ${td.title}${td.extension}`;
        zipFiles.push({ name: fname, data: td.data });
        results.push({ filename: fname, success: true });
        onSubItemProgress?.(i, items.length, td.title || track.title, 1, 1, "done");
      } catch (err) {
        results.push({ filename: track.title || String(track.id), success: false, error: err.message });
        onSubItemProgress?.(i, items.length, track.title, 0, 1, "failed");
      }
    }

    if (zipFiles.length > 0) {
      onProgress?.(items.length, items.length, `Packaging ${zipFiles.length} track(s) as ZIP…`);
      const zip = buildZip(zipFiles);
      triggerDownload(zip, `${folder}.zip`, "application/zip");
    }

    return results;
  } catch (err) {
    return [{ filename: String(playlistId), success: false, error: err.message }];
  }
}

/**
 * Download all tracks in a mix as a single ZIP file.
 * ZIP folder structure: `Mix/{track#}. {artist} - {title}.ext`
 */
export async function downloadMix(mixId, quality = "HIGH", onProgress, onSubItemProgress) {
  try {
    onProgress?.(0, 1, `Fetching mix items…`);
    const itemsData = await getMixItems(mixId, 100, 0);

    const folder = sanitize(`Mix-${mixId}`);
    const items = (itemsData.items || []).filter((i) => i.type === "track");
    const zipFiles = [];
    const results = [];

    for (let i = 0; i < items.length; i++) {
      const track = items[i].item;
      onProgress?.(i, items.length, `Track ${i + 1}/${items.length}: ${track.title}`);
      onSubItemProgress?.(i, items.length, track.title, 0, 1, "active");
      try {
        const td = await fetchTrackData(track.id, quality, (d, t, msg) => {
          onProgress?.(i, items.length, msg);
          onSubItemProgress?.(i, items.length, track.title, d, t, "active");
        });
        const num = String(i + 1).padStart(2, "0");
        const fname = `${folder}/${num}. ${td.artist} - ${td.title}${td.extension}`;
        zipFiles.push({ name: fname, data: td.data });
        results.push({ filename: fname, success: true });
        onSubItemProgress?.(i, items.length, td.title || track.title, 1, 1, "done");
      } catch (err) {
        results.push({ filename: track.title || String(track.id), success: false, error: err.message });
        onSubItemProgress?.(i, items.length, track.title, 0, 1, "failed");
      }
    }

    if (zipFiles.length > 0) {
      onProgress?.(items.length, items.length, `Packaging ${zipFiles.length} track(s) as ZIP…`);
      const zip = buildZip(zipFiles);
      triggerDownload(zip, `${folder}.zip`, "application/zip");
    }

    return results;
  } catch (err) {
    return [{ filename: String(mixId), success: false, error: err.message }];
  }
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

/**
 * Download every album (plus singles/EPs) by an artist.
 * Each album is packaged as its own ZIP file, downloaded in sequence.
 * Returns an array of per-album result arrays.
 */
export async function downloadArtistAlbums(artistId, quality = "HIGH", onProgress, onSubItemProgress) {
  try {
    onProgress?.(0, 1, "Fetching artist discography…");
    const [albumsData, singlesData] = await Promise.all([
      getArtistAlbums(artistId, 50, 0).catch(() => ({ items: [] })),
      getArtistSingles(artistId, 50, 0).catch(() => ({ items: [] })),
    ]);

    const all = [
      ...(albumsData.items || []),
      ...(singlesData.items || []),
    ];

    if (all.length === 0) {
      return [{ filename: `artist-${artistId}`, success: false, error: "No albums found." }];
    }

    const allResults = [];
    for (let i = 0; i < all.length; i++) {
      const album = all[i];
      onProgress?.(i, all.length, `Album ${i + 1}/${all.length}: ${album.title}`);
      onSubItemProgress?.(i, all.length, album.title, 0, 1, "active");
      const res = await downloadAlbum(album.id, quality, (d, t, msg) =>
        onProgress?.(i, all.length, `Album ${i + 1}/${all.length}: ${msg || ""}`)
      );
      const allOk = Array.isArray(res) ? res.every((r) => r.success) : res?.success;
      onSubItemProgress?.(i, all.length, album.title, 1, 1, allOk ? "done" : "failed");
      allResults.push(...(Array.isArray(res) ? res : [res]));
    }
    return allResults;
  } catch (err) {
    return [{ filename: `artist-${artistId}`, success: false, error: `Failed to download artist ${artistId}: ${err.message}` }];
  }
}
