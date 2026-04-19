/**
 * tiddl-web — download module
 *
 * Parses TIDAL stream manifests, fetches audio/video segments, and
 * triggers a browser file-save.  Mirrors tiddl/core/utils/parse.py and
 * tiddl/core/utils/download.py.
 */

import { proxied, getMetadataEnable, getMetadataCover, getCoverSave, getCoverAllowed, getCoverSize, getMetadataLyrics, getLyricsTimestamps } from "./config.js";
import { getTrackStream, getVideoStream, getTrack, getAlbum, getAllAlbumItems, getPlaylist, getAllPlaylistItems, getAllMixItems, getArtistAlbums, getArtistSingles, getTrackLyrics } from "./api.js";

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

  const codecs = String(data.codecs || "").toLowerCase();
  const extension = codecs.includes("flac") ? ".flac" : ".m4a";

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

  const pick = (name) =>
    doc.getElementsByTagNameNS(NS, name)[0] || doc.getElementsByTagName(name)[0];

  const segTpl = pick("SegmentTemplate");
  const urlTemplate = segTpl?.getAttribute("media") || "";
  const initTemplate = segTpl?.getAttribute("initialization") || "";
  const startNumber = Math.max(parseInt(segTpl?.getAttribute("startNumber") || "1", 10) || 1, 0);

  const timeline = doc.getElementsByTagNameNS(NS, "S").length
    ? [...doc.getElementsByTagNameNS(NS, "S")]
    : [...doc.getElementsByTagName("S")];
  let segmentCount = 0;
  for (const el of timeline) {
    segmentCount += 1;
    const r = el.getAttribute("r");
    if (r) segmentCount += parseInt(r, 10);
  }
  if (!segmentCount) segmentCount = 1;

  const baseUrl = (pick("BaseURL")?.textContent || "").trim();
  const resolveDashUrl = (u) => {
    if (!u) return "";
    try {
      return new URL(u, baseUrl || window.location.href).toString();
    } catch {
      return u;
    }
  };
  const replaceNumber = (template, n) =>
    template.replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) =>
      String(n).padStart(pad ? parseInt(pad, 10) : 0, "0")
    );

  const urls = [];
  if (initTemplate) urls.push(resolveDashUrl(initTemplate));
  for (let i = 0; i < segmentCount; i++) {
    const segmentNumber = startNumber + i;
    urls.push(resolveDashUrl(replaceNumber(urlTemplate, segmentNumber)));
  }

  const representations = doc.getElementsByTagNameNS(NS, "Representation").length
    ? [...doc.getElementsByTagNameNS(NS, "Representation")]
    : [...doc.getElementsByTagName("Representation")];
  const adaptationSets = doc.getElementsByTagNameNS(NS, "AdaptationSet").length
    ? [...doc.getElementsByTagNameNS(NS, "AdaptationSet")]
    : [...doc.getElementsByTagName("AdaptationSet")];
  const hasFlacCodec = representations.some((r) =>
    String(r.getAttribute("codecs") || "").toLowerCase().includes("flac")
  ) || adaptationSets.some((a) =>
    String(a.getAttribute("mimeType") || "").toLowerCase().includes("flac")
  );

  return { urls, extension: hasFlacCodec ? ".flac" : ".m4a", encryptionType: "NONE" };
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
async function fetchSegment(url, strategy = "direct-then-proxy") {
  const proxiedUrl = proxied(url);
  const hasProxy = proxiedUrl !== url;
  let directStatus = null;
  let proxyStatus = null;

  async function tryDirect() {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      directStatus = res.status;
    } catch {
      // Network / CORS error.
    }
    return null;
  }

  async function tryProxy() {
    if (!hasProxy) return null;
    try {
      const res = await fetch(proxiedUrl);
      if (res.ok) return res;
      proxyStatus = res.status;
    } catch {
      // Network / CORS error.
    }
    return null;
  }

  const orders = {
    "direct-only": ["direct"],
    "proxy-only": ["proxy"],
    "direct-then-proxy": ["direct", "proxy"],
    "proxy-then-direct": ["proxy", "direct"],
  };
  const order = orders[strategy] || orders["direct-then-proxy"];

  for (const mode of order) {
    const res = mode === "direct" ? await tryDirect() : await tryProxy();
    if (res) return res;
  }

  const segmentError = (message) => {
    const err = new Error(message);
    err.segmentFetch = {
      strategy,
      hasProxy,
      directStatus,
      proxyStatus,
      url,
    };
    return err;
  };

  if (!hasProxy && order.includes("proxy")) {
    if (directStatus !== null) throw segmentError(`Segment fetch failed: ${directStatus} ${url}`);
    throw segmentError(`Segment fetch failed (no proxy configured): ${url}`);
  }
  if (proxyStatus !== null && directStatus !== null) {
    throw segmentError(`Segment fetch failed: ${proxyStatus} (direct=${directStatus}) ${url}`);
  }
  if (proxyStatus !== null) throw segmentError(`Segment fetch failed: ${proxyStatus} ${url}`);
  if (directStatus !== null) throw segmentError(`Segment fetch failed: ${directStatus} ${url}`);
  throw segmentError(`Segment fetch failed (network/cors): ${url}`);
}

/**
 * Fetch all segment URLs and concatenate them into a single Uint8Array.
 * Calls onProgress(downloaded, total) after each segment.
 */
async function fetchSegments(urls, onProgress, strategy = "direct-then-proxy") {
  const chunks = [];
  let downloaded = 0;
  const total = urls.length;

  for (const url of urls) {
    const res = await fetchSegment(url, strategy);
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
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
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

// ─── Cover art helpers ─────────────────────────────────────────────────────

/**
 * Fetch cover art JPEG bytes from the Tidal image CDN.
 * Tries a direct request first; falls back to the configured CORS proxy.
 * Returns null on any failure so callers can silently skip embedding.
 *
 * @param {string} coverHash  UUID-style hash from track.album.cover,
 *                            e.g. "12345678-1234-1234-1234-123456789012"
 * @param {number} size       Square image size in pixels (default 1280)
 * @returns {Promise<Uint8Array|null>}
 */
async function fetchCoverArt(coverHash, size = 1280) {
  if (!coverHash) return null;
  const url = `https://resources.tidal.com/images/${coverHash.replace(/-/g, "/")}/${size}x${size}.jpg`;
  try {
    let res = await fetch(url);
    if (!res.ok) {
      const proxiedUrl = proxied(url);
      if (proxiedUrl !== url) res = await fetch(proxiedUrl);
    }
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch { /* ignore — cover embedding is best-effort */ }
  return null;
}

/**
 * Inject a JPEG image as a METADATA_BLOCK_PICTURE into a FLAC file.
 * Appends the PICTURE block (type 6) as the new last metadata block,
 * replacing the "last" flag that was on the previous final block.
 *
 * @param {Uint8Array} flacData  Raw FLAC file bytes
 * @param {Uint8Array} jpegBytes JPEG image bytes
 * @returns {Uint8Array} New FLAC bytes with cover embedded (or original on error)
 */
function injectFlacCover(flacData, jpegBytes) {
  // Verify "fLaC" signature
  if (flacData[0] !== 0x66 || flacData[1] !== 0x4C ||
      flacData[2] !== 0x61 || flacData[3] !== 0x43) {
    return flacData;
  }

  const mimeBytes = new TextEncoder().encode("image/jpeg");
  const pictureDataSize =
    4 +                    // picture type
    4 + mimeBytes.length + // MIME type length + bytes
    4 +                    // description length (0)
    4 + 4 + 4 + 4 +        // width, height, depth, color count
    4 + jpegBytes.length;  // data length + data

  const pictureData = new Uint8Array(pictureDataSize);
  const pv = new DataView(pictureData.buffer);
  let off = 0;
  pv.setUint32(off, 3, false); off += 4;                    // type: front cover
  pv.setUint32(off, mimeBytes.length, false); off += 4;
  pictureData.set(mimeBytes, off); off += mimeBytes.length;
  pv.setUint32(off, 0, false); off += 4;                    // description length = 0
  pv.setUint32(off, 0, false); off += 4;                    // width  (unknown)
  pv.setUint32(off, 0, false); off += 4;                    // height (unknown)
  pv.setUint32(off, 24, false); off += 4;                   // color depth
  pv.setUint32(off, 0, false); off += 4;                    // indexed colors
  pv.setUint32(off, jpegBytes.length, false); off += 4;     // data length
  pictureData.set(jpegBytes, off);

  // Walk the metadata-block chain to locate any existing PICTURE block and
  // the overall last metadata block.
  let pos = 4;
  let lastBlockStart = 4;
  let pictureStart = -1;
  let pictureBlockTotal = 0;
  while (pos + 4 <= flacData.length) {
    lastBlockStart = pos;
    const header = flacData[pos];
    const blockType = header & 0x7F;
    const blockLen = (flacData[pos + 1] << 16) | (flacData[pos + 2] << 8) | flacData[pos + 3];
    if (blockType === 6 && pictureStart < 0) { // type 6 = PICTURE
      pictureStart = pos;
      pictureBlockTotal = 4 + blockLen;
    }
    pos += 4 + blockLen;
    if (header & 0x80) break; // isLast
  }
  const metadataEnd = pos; // start of audio data

  if (pictureStart >= 0) {
    // Replace existing PICTURE block in-place (size may change)
    const originalIsLast = (flacData[pictureStart] & 0x80) !== 0;
    const newTotal = 4 + pictureDataSize;
    const delta = newTotal - pictureBlockTotal;
    const result = new Uint8Array(flacData.length + delta);
    result.set(flacData.slice(0, pictureStart));
    result[pictureStart]     = (originalIsLast ? 0x80 : 0) | 6;
    result[pictureStart + 1] = (pictureDataSize >> 16) & 0xFF;
    result[pictureStart + 2] = (pictureDataSize >>  8) & 0xFF;
    result[pictureStart + 3] =  pictureDataSize        & 0xFF;
    result.set(pictureData, pictureStart + 4);
    result.set(flacData.slice(pictureStart + pictureBlockTotal), pictureStart + newTotal);
    return result;
  }

  // No existing PICTURE — append as the new last block before audio data
  const result = new Uint8Array(flacData.length + 4 + pictureDataSize);
  result.set(flacData.slice(0, metadataEnd));
  result[lastBlockStart] = flacData[lastBlockStart] & 0x7F; // clear "last" flag

  result[metadataEnd]     = 0x80 | 6;                           // last=1, type=PICTURE
  result[metadataEnd + 1] = (pictureDataSize >> 16) & 0xFF;
  result[metadataEnd + 2] = (pictureDataSize >>  8) & 0xFF;
  result[metadataEnd + 3] =  pictureDataSize        & 0xFF;
  result.set(pictureData, metadataEnd + 4);
  result.set(flacData.slice(metadataEnd), metadataEnd + 4 + pictureDataSize);

  return result;
}

// ── M4A / MPEG-4 helpers ────────────────────────────────────────────────────

function _readU32BE(data, off) {
  return (data[off] * 0x1000000) +
         ((data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]);
}

function _writeU32BE(data, off, v) {
  data[off]     = (v >>> 24) & 0xFF;
  data[off + 1] = (v >>> 16) & 0xFF;
  data[off + 2] = (v >>>  8) & 0xFF;
  data[off + 3] =  v         & 0xFF;
}

/**
 * Find the first MP4 box of the given 4-char type within [start, end).
 * Returns { start, size } or null.
 */
function _findBox(data, type, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    const size = _readU32BE(data, pos);
    if (size < 8 || pos + size > end) break;
    const t = String.fromCharCode(data[pos+4], data[pos+5], data[pos+6], data[pos+7]);
    if (t === type) return { start: pos, size };
    pos += size;
  }
  return null;
}

/**
 * Walk the MP4 box region data[start..end), recursing into known container
 * boxes, and add `delta` to every stco/co64 entry whose value is strictly
 * greater than `threshold`.
 *
 * This must be called after inserting bytes inside moov so that the absolute
 * chunk-offset tables (stco/co64) remain valid when mdat lies after the edit
 * point.  When mdat precedes moov the entries will all be below the threshold
 * and are left untouched.
 */
function _shiftChunkOffsets(data, start, end, threshold, delta) {
  if (delta === 0) return;
  let pos = start;
  while (pos + 8 <= end) {
    const size = _readU32BE(data, pos);
    if (size < 8 || pos + size > end) break;
    const t = String.fromCharCode(data[pos+4], data[pos+5], data[pos+6], data[pos+7]);
    if (t === "stco") {
      // FullBox: 8-byte header + 4-byte version/flags + 4-byte entry_count + N×4-byte offsets
      const count = _readU32BE(data, pos + 12);
      for (let i = 0; i < count; i++) {
        const o = pos + 16 + i * 4;
        const v = _readU32BE(data, o);
        if (v > threshold) _writeU32BE(data, o, v + delta);
      }
    } else if (t === "co64") {
      // FullBox: 8-byte header + 4-byte version/flags + 4-byte entry_count + N×8-byte offsets
      const count = _readU32BE(data, pos + 12);
      for (let i = 0; i < count; i++) {
        const o = pos + 16 + i * 8;
        const hi = _readU32BE(data, o);
        const lo = _readU32BE(data, o + 4);
        if (hi > 0 || (hi === 0 && lo > threshold)) {
          const newLo = (lo + delta) >>> 0;
          const carry = (lo + delta) > 0xFFFFFFFF ? 1 : 0;
          _writeU32BE(data, o, hi + carry);
          _writeU32BE(data, o + 4, newLo);
        }
      }
    } else if (t === "trak" || t === "mdia" || t === "minf" || t === "stbl") {
      _shiftChunkOffsets(data, pos + 8, pos + size, threshold, delta);
    }
    pos += size;
  }
}

/**
 * Inject a JPEG image as a 'covr' atom into an M4A (MPEG-4) file.
 *
 * Searches for the ilst container via multiple common paths:
 *   moov > udta > meta > ilst  (iTunes/QuickTime — standard BTS files)
 *   moov > meta > ilst         (no udta wrapper)
 *   moov > ilst                (bare ilst directly under moov)
 *
 * If no ilst is found (e.g. fMP4 / DASH streams that lack iTunes metadata),
 * a full udta > meta > hdlr > ilst structure is created from scratch.
 *
 * After inserting or replacing the covr atom all ancestor box sizes are
 * updated, and the stco/co64 chunk-offset tables are adjusted so that audio
 * data is still found at the correct position in the file.
 *
 * @param {Uint8Array} m4aData   Raw M4A file bytes
 * @param {Uint8Array} jpegBytes JPEG image bytes
 * @returns {Uint8Array} New M4A bytes with cover embedded (or original on error)
 */
function injectM4aCover(m4aData, jpegBytes) {
  // Build the covr atom:  covr [ data [ type=JPEG + locale=0 + jpegBytes ] ]
  const dataAtomSize = 8 + 4 + 4 + jpegBytes.length; // hdr + type + locale + data
  const covrAtomSize = 8 + dataAtomSize;
  const covrAtom = new Uint8Array(covrAtomSize);
  const cv = new DataView(covrAtom.buffer);
  let off = 0;
  cv.setUint32(off, covrAtomSize, false); off += 4;
  covrAtom.set([0x63, 0x6F, 0x76, 0x72], off); off += 4; // "covr"
  cv.setUint32(off, dataAtomSize, false); off += 4;
  covrAtom.set([0x64, 0x61, 0x74, 0x61], off); off += 4; // "data"
  cv.setUint32(off, 0x0000000D, false); off += 4;         // type indicator: JPEG
  cv.setUint32(off, 0, false); off += 4;                  // locale
  covrAtom.set(jpegBytes, off);

  const moov = _findBox(m4aData, "moov", 0, m4aData.length);
  if (!moov) return m4aData;

  // Try multiple possible ilst locations (highest-precedence first):
  //   Path 1: moov > udta > meta > ilst  (iTunes standard, BTS manifests)
  //   Path 2: moov > meta > ilst         (no udta wrapper)
  //   Path 3: moov > ilst                (bare ilst under moov)
  // ancestors = boxes whose sizes must grow by delta, listed inner→outer (moov last)
  let ilst = null;
  let ancestors = [];

  const udta = _findBox(m4aData, "udta", moov.start + 8, moov.start + moov.size);
  if (udta) {
    // 'meta' is a FullBox — children start 4 bytes after the regular 8-byte header
    const metaU = _findBox(m4aData, "meta", udta.start + 8, udta.start + udta.size);
    if (metaU) {
      const il = _findBox(m4aData, "ilst", metaU.start + 12, metaU.start + metaU.size);
      if (il) { ilst = il; ancestors = [metaU, udta, moov]; }
    }
  }
  if (!ilst) {
    const metaM = _findBox(m4aData, "meta", moov.start + 8, moov.start + moov.size);
    if (metaM) {
      const il = _findBox(m4aData, "ilst", metaM.start + 12, metaM.start + metaM.size);
      if (il) { ilst = il; ancestors = [metaM, moov]; }
    }
  }
  if (!ilst) {
    const il = _findBox(m4aData, "ilst", moov.start + 8, moov.start + moov.size);
    if (il) { ilst = il; ancestors = [moov]; }
  }

  if (ilst) {
    // Find any existing 'covr' to replace, or append a new one at the end of ilst
    const existingCovr = _findBox(m4aData, "covr", ilst.start + 8, ilst.start + ilst.size);

    let result, delta;
    if (existingCovr) {
      delta = covrAtom.length - existingCovr.size;
      result = new Uint8Array(m4aData.length + delta);
      result.set(m4aData.slice(0, existingCovr.start));
      result.set(covrAtom, existingCovr.start);
      result.set(m4aData.slice(existingCovr.start + existingCovr.size),
                 existingCovr.start + covrAtom.length);
    } else {
      delta = covrAtom.length;
      const insertPos = ilst.start + ilst.size;
      result = new Uint8Array(m4aData.length + delta);
      result.set(m4aData.slice(0, insertPos));
      result.set(covrAtom, insertPos);
      result.set(m4aData.slice(insertPos), insertPos + covrAtom.length);
    }

    // Update ilst size and all ancestor box sizes
    _writeU32BE(result, ilst.start, _readU32BE(result, ilst.start) + delta);
    for (const anc of ancestors) {
      _writeU32BE(result, anc.start, _readU32BE(result, anc.start) + delta);
    }

    // Fix absolute chunk offsets: inserting bytes inside moov shifts any mdat
    // that sits after the edit point.  Adjust every stco/co64 entry that
    // pointed beyond the first shifted byte.
    if (delta !== 0) {
      const threshold = existingCovr
        ? existingCovr.start + existingCovr.size  // first byte shifted (replacement)
        : ilst.start + ilst.size;                 // first byte shifted (insertion)
      _shiftChunkOffsets(result, moov.start + 8, moov.start + moov.size + delta,
                         threshold, delta);
    }

    return result;
  }

  // ── No ilst found ────────────────────────────────────────────────────────
  // Build udta > meta (FullBox) > hdlr > ilst > covr from scratch and append
  // it at the end of moov.  This handles fMP4 / DASH streams that carry no
  // iTunes metadata atoms.

  const ilstSize = 8 + covrAtomSize;
  const ilstAtom = new Uint8Array(ilstSize);
  new DataView(ilstAtom.buffer).setUint32(0, ilstSize, false);
  ilstAtom.set([0x69, 0x6C, 0x73, 0x74], 4); // "ilst"
  ilstAtom.set(covrAtom, 8);

  // hdlr FullBox: size + "hdlr" + version/flags(0) + pre_defined(0) +
  //              handler_type("mdir") + reserved[12] + name null-terminator
  const hdlrSize = 4 + 4 + 4 + 4 + 4 + 12 + 1; // 33 bytes
  const hdlrAtom = new Uint8Array(hdlrSize);
  new DataView(hdlrAtom.buffer).setUint32(0, hdlrSize, false);
  hdlrAtom.set([0x68, 0x64, 0x6C, 0x72], 4);  // "hdlr"
  hdlrAtom.set([0x6D, 0x64, 0x69, 0x72], 16); // handler_type = "mdir"

  // meta FullBox: size + "meta" + version/flags(0) + hdlr + ilst
  const metaSize = 12 + hdlrSize + ilstSize;
  const metaAtom = new Uint8Array(metaSize);
  new DataView(metaAtom.buffer).setUint32(0, metaSize, false);
  metaAtom.set([0x6D, 0x65, 0x74, 0x61], 4); // "meta"
  metaAtom.set(hdlrAtom, 12);
  metaAtom.set(ilstAtom, 12 + hdlrSize);

  // udta: size + "udta" + meta
  const udtaSize = 8 + metaSize;
  const udtaAtom = new Uint8Array(udtaSize);
  new DataView(udtaAtom.buffer).setUint32(0, udtaSize, false);
  udtaAtom.set([0x75, 0x64, 0x74, 0x61], 4); // "udta"
  udtaAtom.set(metaAtom, 8);

  // Append udta right after the current end of moov
  const insertPos = moov.start + moov.size;
  const result = new Uint8Array(m4aData.length + udtaSize);
  result.set(m4aData.slice(0, insertPos));
  result.set(udtaAtom, insertPos);
  result.set(m4aData.slice(insertPos), insertPos + udtaSize);

  // Grow moov to encompass the new udta
  _writeU32BE(result, moov.start, moov.size + udtaSize);

  // Fix chunk offsets for any mdat that follows moov
  _shiftChunkOffsets(result, moov.start + 8, moov.start + moov.size + udtaSize,
                     insertPos, udtaSize);

  return result;
}

/**
 * Embed cover art into audio data.
 * @param {Uint8Array} data      Raw audio bytes
 * @param {string}     extension ".flac" or ".m4a"
 * @param {Uint8Array} cover     JPEG cover bytes
 * @returns {Uint8Array}
 */
function embedCoverArt(data, extension, cover) {
  if (extension === ".flac") return injectFlacCover(data, cover);
  if (extension === ".m4a")  return injectM4aCover(data, cover);
  return data;
}

// ─── Metadata tag injection ────────────────────────────────────────────────

/**
 * Inject a VORBIS_COMMENT block into a FLAC file, replacing any existing one.
 * Appends as the new last metadata block when no VORBIS_COMMENT is present.
 *
 * @param {Uint8Array} flacData  Raw FLAC bytes
 * @param {Object}     tags      Plain-object of tag key→value strings
 * @returns {Uint8Array} New FLAC bytes with tags embedded (or original on error)
 */
function injectFlacTags(flacData, tags) {
  if (flacData[0] !== 0x66 || flacData[1] !== 0x4C ||
      flacData[2] !== 0x61 || flacData[3] !== 0x43) {
    return flacData;
  }

  const enc = new TextEncoder();
  const vendorBytes = enc.encode("tiddl-web");

  const comments = [];
  if (tags.title)       comments.push(`TITLE=${tags.title}`);
  if (tags.artist)      comments.push(`ARTIST=${tags.artist}`);
  if (tags.albumTitle)  comments.push(`ALBUM=${tags.albumTitle}`);
  if (tags.albumArtist) comments.push(`ALBUMARTIST=${tags.albumArtist}`);
  if (tags.trackNumber) comments.push(`TRACKNUMBER=${tags.trackNumber}`);
  if (tags.discNumber)  comments.push(`DISCNUMBER=${tags.discNumber}`);
  if (tags.year)        comments.push(`DATE=${tags.year}`);
  if (tags.isrc)        comments.push(`ISRC=${tags.isrc}`);
  if (tags.copyright)   comments.push(`COPYRIGHT=${tags.copyright}`);
  if (tags.lyrics)      comments.push(`LYRICS=${tags.lyrics}`);

  if (!comments.length) return flacData;

  const commentBytes = comments.map(c => enc.encode(c));

  let blockDataSize = 4 + vendorBytes.length + 4;
  for (const cb of commentBytes) blockDataSize += 4 + cb.length;

  const blockData = new Uint8Array(blockDataSize);
  const dv = new DataView(blockData.buffer);
  let off = 0;
  dv.setUint32(off, vendorBytes.length, true); off += 4;
  blockData.set(vendorBytes, off); off += vendorBytes.length;
  dv.setUint32(off, commentBytes.length, true); off += 4;
  for (const cb of commentBytes) {
    dv.setUint32(off, cb.length, true); off += 4;
    blockData.set(cb, off); off += cb.length;
  }

  // Walk existing metadata blocks looking for an existing VORBIS_COMMENT (type 4)
  let pos = 4;
  let vorbisStart = -1, vorbisBlockTotal = 0;
  let lastBlockStart = 4;

  while (pos + 4 <= flacData.length) {
    const header = flacData[pos];
    const blockType = header & 0x7F;
    const blockLen = (flacData[pos + 1] << 16) | (flacData[pos + 2] << 8) | flacData[pos + 3];
    if (blockType === 4) {
      vorbisStart = pos;
      vorbisBlockTotal = 4 + blockLen;
    }
    lastBlockStart = pos;
    pos += 4 + blockLen;
    if (header & 0x80) break;
  }
  const metadataEnd = pos;

  if (vorbisStart >= 0) {
    // Replace the existing VORBIS_COMMENT block
    const originalIsLast = (flacData[vorbisStart] & 0x80) !== 0;
    const newTotal = 4 + blockDataSize;
    const delta = newTotal - vorbisBlockTotal;
    const result = new Uint8Array(flacData.length + delta);
    result.set(flacData.slice(0, vorbisStart));
    result[vorbisStart] = (originalIsLast ? 0x80 : 0) | 4;
    result[vorbisStart + 1] = (blockDataSize >> 16) & 0xFF;
    result[vorbisStart + 2] = (blockDataSize >>  8) & 0xFF;
    result[vorbisStart + 3] =  blockDataSize        & 0xFF;
    result.set(blockData, vorbisStart + 4);
    result.set(flacData.slice(vorbisStart + vorbisBlockTotal), vorbisStart + newTotal);
    return result;
  }

  // Append a new VORBIS_COMMENT as the last metadata block, before audio data
  const newBlock = new Uint8Array(4 + blockDataSize);
  newBlock[0] = 0x80 | 4;                           // isLast=1, type=VORBIS_COMMENT
  newBlock[1] = (blockDataSize >> 16) & 0xFF;
  newBlock[2] = (blockDataSize >>  8) & 0xFF;
  newBlock[3] =  blockDataSize        & 0xFF;
  newBlock.set(blockData, 4);

  const result = new Uint8Array(flacData.length + newBlock.length);
  result.set(flacData.slice(0, metadataEnd));
  result[lastBlockStart] = flacData[lastBlockStart] & 0x7F; // clear isLast on previous last block
  result.set(newBlock, metadataEnd);
  result.set(flacData.slice(metadataEnd), metadataEnd + newBlock.length);
  return result;
}

/**
 * Inject iTunes text atoms into the ilst container of an M4A file.
 * Creates the full udta > meta > hdlr > ilst hierarchy when none is present,
 * mirroring the approach used by injectM4aCover for new files.
 *
 * @param {Uint8Array} m4aData  Raw M4A bytes
 * @param {Object}     tags     Plain-object of tag key→value strings
 * @returns {Uint8Array} New M4A bytes with tags embedded (or original on error)
 */
function injectM4aTags(m4aData, tags) {
  const enc = new TextEncoder();

  // Build an iTunes text atom: fourCC [ data [ type=1 + locale=0 + UTF-8 text ] ]
  function buildTextAtom(fourCC, text) {
    if (!text) return null;
    const textBytes = enc.encode(text);
    const dataSize = 8 + 4 + 4 + textBytes.length;
    const totalSize = 8 + dataSize;
    const atom = new Uint8Array(totalSize);
    const dv2 = new DataView(atom.buffer);
    let o = 0;
    dv2.setUint32(o, totalSize, false); o += 4;
    atom.set(fourCC, o); o += 4;
    dv2.setUint32(o, dataSize, false); o += 4;
    atom.set([0x64, 0x61, 0x74, 0x61], o); o += 4; // "data"
    dv2.setUint32(o, 0x00000001, false); o += 4;    // type = UTF-8
    dv2.setUint32(o, 0, false); o += 4;             // locale = 0
    atom.set(textBytes, o);
    return atom;
  }

  // Build an iTunes integer atom for track/disc number:
  // fourCC [ data [ type=0 (implicit) + locale=0 + 8 bytes:
  //   0x0000 | num (uint16 BE) | total (uint16 BE) | 0x0000 ] ]
  function buildIntAtom(fourCC, num, total = 0) {
    const dataSize = 8 + 4 + 4 + 8; // 24 bytes
    const totalSize = 8 + dataSize;  // 32 bytes
    const atom = new Uint8Array(totalSize);
    const dv2 = new DataView(atom.buffer);
    let o = 0;
    dv2.setUint32(o, totalSize, false); o += 4;
    atom.set(fourCC, o); o += 4;
    dv2.setUint32(o, dataSize, false); o += 4;
    atom.set([0x64, 0x61, 0x74, 0x61], o); o += 4; // "data"
    dv2.setUint32(o, 0x00000000, false); o += 4;    // type = implicit integer
    dv2.setUint32(o, 0, false); o += 4;             // locale = 0
    dv2.setUint16(o, 0, false); o += 2;             // padding
    dv2.setUint16(o, num, false); o += 2;           // track/disc number
    dv2.setUint16(o, total, false); o += 2;         // total (0 = unknown)
    dv2.setUint16(o, 0, false);                     // padding
    return atom;
  }

  const builtAtoms = [
    buildTextAtom([0xA9, 0x6E, 0x61, 0x6D], tags.title),       // ©nam
    buildTextAtom([0xA9, 0x41, 0x52, 0x54], tags.artist),       // ©ART
    buildTextAtom([0xA9, 0x61, 0x6C, 0x62], tags.albumTitle),   // ©alb
    buildTextAtom([0x61, 0x41, 0x52, 0x54], tags.albumArtist),  // aART
    buildTextAtom([0xA9, 0x64, 0x61, 0x79], tags.year),         // ©day
    buildTextAtom([0x63, 0x70, 0x72, 0x74], tags.copyright),    // cprt
    buildTextAtom([0xA9, 0x6C, 0x79, 0x72], tags.lyrics),       // ©lyr
    tags.trackNumber ? buildIntAtom([0x74, 0x72, 0x6B, 0x6E], tags.trackNumber) : null, // trkn
    tags.discNumber  ? buildIntAtom([0x64, 0x69, 0x73, 0x6B], tags.discNumber)  : null, // disk
  ].filter(Boolean);
  if (!builtAtoms.length) return m4aData;

  const totalAtomsSize = builtAtoms.reduce((s, a) => s + a.length, 0);
  const combinedAtoms = new Uint8Array(totalAtomsSize);
  let wPos = 0;
  for (const a of builtAtoms) { combinedAtoms.set(a, wPos); wPos += a.length; }

  const moov = _findBox(m4aData, "moov", 0, m4aData.length);
  if (!moov) return m4aData;

  // Locate ilst via the same three paths used by injectM4aCover
  let ilst = null;
  let ancestors = [];

  const udta = _findBox(m4aData, "udta", moov.start + 8, moov.start + moov.size);
  if (udta) {
    const metaU = _findBox(m4aData, "meta", udta.start + 8, udta.start + udta.size);
    if (metaU) {
      const il = _findBox(m4aData, "ilst", metaU.start + 12, metaU.start + metaU.size);
      if (il) { ilst = il; ancestors = [metaU, udta, moov]; }
    }
  }
  if (!ilst) {
    const metaM = _findBox(m4aData, "meta", moov.start + 8, moov.start + moov.size);
    if (metaM) {
      const il = _findBox(m4aData, "ilst", metaM.start + 12, metaM.start + metaM.size);
      if (il) { ilst = il; ancestors = [metaM, moov]; }
    }
  }
  if (!ilst) {
    const il = _findBox(m4aData, "ilst", moov.start + 8, moov.start + moov.size);
    if (il) { ilst = il; ancestors = [moov]; }
  }

  if (ilst) {
    // Append new tag atoms at the end of the existing ilst
    const insertPos = ilst.start + ilst.size;
    const delta = totalAtomsSize;
    const result = new Uint8Array(m4aData.length + delta);
    result.set(m4aData.slice(0, insertPos));
    result.set(combinedAtoms, insertPos);
    result.set(m4aData.slice(insertPos), insertPos + delta);

    _writeU32BE(result, ilst.start, _readU32BE(result, ilst.start) + delta);
    for (const anc of ancestors) {
      _writeU32BE(result, anc.start, _readU32BE(result, anc.start) + delta);
    }
    _shiftChunkOffsets(result, moov.start + 8, moov.start + moov.size + delta,
                       insertPos, delta);
    return result;
  }

  // No ilst found — build udta > meta (FullBox) > hdlr > ilst from scratch
  const ilstSize = 8 + totalAtomsSize;
  const ilstAtom = new Uint8Array(ilstSize);
  new DataView(ilstAtom.buffer).setUint32(0, ilstSize, false);
  ilstAtom.set([0x69, 0x6C, 0x73, 0x74], 4); // "ilst"
  ilstAtom.set(combinedAtoms, 8);

  const hdlrSize = 4 + 4 + 4 + 4 + 4 + 12 + 1;
  const hdlrAtom = new Uint8Array(hdlrSize);
  new DataView(hdlrAtom.buffer).setUint32(0, hdlrSize, false);
  hdlrAtom.set([0x68, 0x64, 0x6C, 0x72], 4);  // "hdlr"
  hdlrAtom.set([0x6D, 0x64, 0x69, 0x72], 16); // handler_type = "mdir"

  const metaSize = 12 + hdlrSize + ilstSize;
  const metaAtom = new Uint8Array(metaSize);
  new DataView(metaAtom.buffer).setUint32(0, metaSize, false);
  metaAtom.set([0x6D, 0x65, 0x74, 0x61], 4); // "meta"
  metaAtom.set(hdlrAtom, 12);
  metaAtom.set(ilstAtom, 12 + hdlrSize);

  const udtaSize = 8 + metaSize;
  const udtaAtom = new Uint8Array(udtaSize);
  new DataView(udtaAtom.buffer).setUint32(0, udtaSize, false);
  udtaAtom.set([0x75, 0x64, 0x74, 0x61], 4); // "udta"
  udtaAtom.set(metaAtom, 8);

  const insertPos = moov.start + moov.size;
  const result = new Uint8Array(m4aData.length + udtaSize);
  result.set(m4aData.slice(0, insertPos));
  result.set(udtaAtom, insertPos);
  result.set(m4aData.slice(insertPos), insertPos + udtaSize);

  _writeU32BE(result, moov.start, moov.size + udtaSize);
  _shiftChunkOffsets(result, moov.start + 8, moov.start + moov.size + udtaSize,
                     insertPos, udtaSize);
  return result;
}

/**
 * Embed track metadata tags into audio data.
 * @param {Uint8Array} data       Raw audio bytes
 * @param {string}     extension  ".flac" or ".m4a"
 * @param {Object}     tags       Plain-object of tag key→value
 * @returns {Uint8Array}
 */
function embedMetadata(data, extension, tags) {
  if (extension === ".flac") return injectFlacTags(data, tags);
  if (extension === ".m4a")  return injectM4aTags(data, tags);
  return data;
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

  // Assemble the ZIP as a Blob from its constituent parts.
  // Using Blob avoids allocating a single contiguous buffer equal to the total
  // ZIP size, which can fail with "Array buffer allocation failed" for large
  // collections (playlists, albums) where all track data would need to be
  // copied into one block.
  return new Blob([...localParts, ...centralEntries, new Uint8Array(eocdBuf)],
    { type: "application/zip" });
}

// ─── Internal track data fetcher ─────────────────────────────────────────

const QUALITY_FALLBACKS = {
  HI_RES_LOSSLESS: ["LOSSLESS", "HIGH", "LOW"],
  LOSSLESS: ["HIGH", "LOW"],
  HIGH: ["LOW"],
  LOW: [],
};

const PLAYBACK_NOT_READY_RETRIES = 3;
const PLAYBACK_NOT_READY_RETRY_BASE_DELAY_MS = 1200;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function qualityCandidates(requestedQuality) {
  const requested = requestedQuality || "HIGH";
  const fallbacks = QUALITY_FALLBACKS[requested] || [];
  return [requested, ...fallbacks.filter((q) => q !== requested)];
}

function isPlaybackAssetNotReadyError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return /asset is not ready for playback|asset not ready for playback/.test(msg);
}

function shouldTryQualityFallback(err) {
  const msg = String(err?.message || "").toLowerCase();
  if (!msg) return false;
  if (/not authenticated|unauthorized|token/.test(msg)) return false;
  return /\b(?:quality|audioquality|unsupported|subscription|plan)\b|not available\b/.test(msg)
    || isPlaybackAssetNotReadyError(err);
}

async function getTrackStreamWithFallback(trackId, requestedQuality, onProgress, options = {}) {
  const {
    allowProxyFallback = true,
    preferDirect = true,
  } = options;
  const candidates = qualityCandidates(requestedQuality);
  let lastErr = null;

  for (let i = 0; i < candidates.length; i++) {
    const q = candidates[i];
    for (let attempt = 0; attempt <= PLAYBACK_NOT_READY_RETRIES; attempt++) {
      try {
        if (i > 0 && attempt === 0) {
          onProgress?.(0, 1, `Requested quality unavailable, retrying with ${q}…`);
        }
        const streamRes = await getTrackStream(trackId, q, {
          allowProxyFallback,
          includeRequestMeta: true,
          preferDirect,
        });
        const streamInfo = streamRes?.data ?? streamRes;
        // `includeRequestMeta` is always requested above; default only as a guard
        // against unexpected response-shape changes.
        const requestMeta = (streamRes && typeof streamRes === "object" && streamRes.requestMeta)
          ? streamRes.requestMeta
          : { usedProxy: false };
        return { streamInfo, quality: q, requestMeta };
      } catch (err) {
        lastErr = err;
        if (isPlaybackAssetNotReadyError(err) && attempt < PLAYBACK_NOT_READY_RETRIES) {
          const retryDelayMs = PLAYBACK_NOT_READY_RETRY_BASE_DELAY_MS * (attempt + 1);
          onProgress?.(
            0,
            1,
            `Asset not ready yet; retrying stream request in ${(retryDelayMs / 1000).toFixed(1)}s (${attempt + 1}/${PLAYBACK_NOT_READY_RETRIES})…`
          );
          await wait(retryDelayMs);
          continue;
        }
        if (i === candidates.length - 1 || !shouldTryQualityFallback(err)) throw err;
        break;
      }
    }
  }

  throw lastErr || new Error("Unable to fetch track stream");
}

function isSegmentTokenExpiryError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return /segment fetch failed: (401|403|410)\b|direct=(401|403|410)\b/.test(msg);
}

function isLikelyProxySegmentTokenBindingError(err) {
  const info = err?.segmentFetch;
  if (info && info.hasProxy) {
    return info.proxyStatus === 403 && info.directStatus === null;
  }
  const msg = String(err?.message || "").toLowerCase();
  return /segment fetch failed: 403\b/.test(msg) && !/direct=/.test(msg);
}

function getSegmentStrategyFromRequestMeta(requestMeta) {
  return requestMeta.usedProxy ? "proxy-then-direct" : "direct-then-proxy";
}

/**
 * Fetch and decode a single track's audio data without triggering a browser
 * save.  Used internally by downloadTrack and the multi-track ZIP bundlers.
 *
 * @returns {{ data: Uint8Array, extension: string, title: string,
 *             artist: string, trackNumber: number, discNumber: number,
 *             albumTitle: string, albumArtist: string, year: string,
 *             isrc: string, copyright: string, coverHash: string|null,
 *             lyrics: string|null }}
 */
async function fetchTrackData(trackId, quality, onProgress) {
  onProgress?.(0, 1, `Fetching track info for #${trackId}…`);
  const track = await getTrack(trackId);
  const rawTitle = (track.version ? `${track.title} (${track.version})` : track.title) || String(trackId);
  const title = sanitize(rawTitle);
  const rawArtist = track.artist?.name || "Unknown Artist";
  const artist = sanitize(rawArtist);
  const trackNumber = track.trackNumber || 0;
  const discNumber = track.volumeNumber || 1;
  const albumTitle = track.album?.title || "";
  const albumArtist = track.album?.artist?.name || rawArtist;
  const year = (track.streamStartDate || track.album?.releaseDate || "").slice(0, 4);
  const isrc = track.isrc || "";
  const copyright = track.copyright || "";
  const coverHash = track.album?.cover || null;

  let lyrics = null;
  if (getMetadataLyrics()) {
    try {
      const lyricsData = await getTrackLyrics(trackId);
      if (getLyricsTimestamps()) {
        lyrics = lyricsData.subtitles || lyricsData.lyrics || null;
      } else {
        lyrics = lyricsData.lyrics
          || (lyricsData.subtitles && lyricsData.subtitles.replace(/\[\d+:\d+\.\d+\]\s?/g, "").trim())
          || null;
      }
    } catch {
      // Lyrics not available for this track — skip silently.
    }
  }

  onProgress?.(0, 1, `Getting stream for "${title}"…`);
  const initial = await getTrackStreamWithFallback(trackId, quality, onProgress);
  let streamQuality = initial.quality;
  let segmentStrategy = getSegmentStrategyFromRequestMeta(initial.requestMeta);
  let { urls, extension, encryptionType } = parseStreamManifest(initial.streamInfo);

  if (encryptionType && encryptionType !== "NONE") {
    throw new Error(
      `Stream is encrypted (${encryptionType}). Encrypted streams cannot be downloaded in the browser.`
    );
  }

  const downloadFromUrls = async (segmentUrls) => {
    onProgress?.(0, segmentUrls.length, `Downloading ${segmentUrls.length} segment(s)…`);
    return fetchSegments(
      segmentUrls,
      (done, total) => onProgress?.(done, total, `Downloading segment ${done}/${total}…`),
      segmentStrategy
    );
  };

  let data;
  try {
    data = await downloadFromUrls(urls);
  } catch (err) {
    if (!isSegmentTokenExpiryError(err)) throw err;

    // Single retry by design: an immediate re-fetch should provide fresh signed
    // segment URLs. Repeating beyond one retry risks long loops on persistent
    // permission/subscription/geoblocking failures and slows large queues.
    onProgress?.(0, 1, "Segment URL expired (401/403/410). Refreshing stream token and retrying once…");
    const refreshed = await getTrackStreamWithFallback(trackId, streamQuality, onProgress);
    streamQuality = refreshed.quality;
    segmentStrategy = getSegmentStrategyFromRequestMeta(refreshed.requestMeta);
    const reparsed = parseStreamManifest(refreshed.streamInfo);
    urls = reparsed.urls;
    extension = reparsed.extension;
    encryptionType = reparsed.encryptionType;
    if (encryptionType && encryptionType !== "NONE") {
      throw new Error(
        `Stream is encrypted (${encryptionType}). Encrypted streams cannot be downloaded in the browser.`
      );
    }
    try {
      data = await downloadFromUrls(urls);
    } catch (retryErr) {
      if (!isSegmentTokenExpiryError(retryErr)) throw retryErr;

      onProgress?.(0, 1, "Segment still failing after stream refresh. Retrying with direct-only playback request…");
      const directOnly = await getTrackStreamWithFallback(trackId, streamQuality, onProgress, {
        allowProxyFallback: false,
        preferDirect: true,
      });
      streamQuality = directOnly.quality;
      segmentStrategy = getSegmentStrategyFromRequestMeta(directOnly.requestMeta);
      const directParsed = parseStreamManifest(directOnly.streamInfo);
      urls = directParsed.urls;
      extension = directParsed.extension;
      encryptionType = directParsed.encryptionType;
      if (encryptionType && encryptionType !== "NONE") {
        throw new Error(
          `Stream is encrypted (${encryptionType}). Encrypted streams cannot be downloaded in the browser.`
        );
      }
      try {
        data = await downloadFromUrls(urls);
      } catch (directOnlyErr) {
        if (!isSegmentTokenExpiryError(directOnlyErr) || !isLikelyProxySegmentTokenBindingError(directOnlyErr)) {
          throw directOnlyErr;
        }

        onProgress?.(0, 1, "Direct segment fetch blocked; requesting proxy-bound stream token and retrying proxy-only…");
        const proxyOnly = await getTrackStreamWithFallback(trackId, streamQuality, onProgress, {
          allowProxyFallback: false,
          preferDirect: false,
        });
        streamQuality = proxyOnly.quality;
        segmentStrategy = "proxy-only";
        const proxyParsed = parseStreamManifest(proxyOnly.streamInfo);
        urls = proxyParsed.urls;
        extension = proxyParsed.extension;
        encryptionType = proxyParsed.encryptionType;
        if (encryptionType && encryptionType !== "NONE") {
          throw new Error(
            `Stream is encrypted (${encryptionType}). Encrypted streams cannot be downloaded in the browser.`
          );
        }
        data = await downloadFromUrls(urls);
      }
    }
  }

  return { data, extension, title, artist, rawTitle, rawArtist, trackNumber, discNumber, albumTitle, albumArtist, year, isrc, copyright, coverHash, lyrics };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Download a single track.
 * @param {string|number} trackId
 * @param {string} quality  LOW | HIGH | LOSSLESS | HI_RES_LOSSLESS
 * @param {Function} onProgress (downloaded, total, message) => void
 * @returns {Promise<{filename: string, success: boolean, error?: string}>}
 */
export async function downloadTrack(trackId, quality = "HIGH", onProgress, nameSuffix = "") {
  try {
    let { data, extension, title, artist, rawTitle, rawArtist, trackNumber, discNumber, albumTitle, albumArtist, year, isrc, copyright, coverHash, lyrics } = await fetchTrackData(trackId, quality, onProgress);

    if (getMetadataEnable()) {
      data = embedMetadata(data, extension, { title: rawTitle, artist: rawArtist, albumTitle, albumArtist, trackNumber, discNumber, year, isrc, copyright, lyrics });
    }

    const needCover = (getMetadataCover() || (getCoverSave() && getCoverAllowed().includes("track"))) && coverHash;
    if (needCover) {
      onProgress?.(0, 1, "Fetching cover art…");
      const cover = await fetchCoverArt(coverHash, getCoverSize());
      if (cover) {
        if (getMetadataCover()) data = embedCoverArt(data, extension, cover);
        if (getCoverSave() && getCoverAllowed().includes("track")) {
          triggerDownload(cover, "cover.jpg", "image/jpeg");
        }
      }
    }

    const filename = `${artist} - ${title}${nameSuffix}${extension}`;
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
export async function downloadAlbum(albumId, quality = "HIGH", onProgress, onSubItemProgress, nameSuffix = "") {
  try {
    onProgress?.(0, 1, `Fetching album info…`);
    const [albumMeta, allItems] = await Promise.all([
      getAlbum(albumId),
      getAllAlbumItems(albumId),
    ]);

    const rawAlbumTitle  = albumMeta.title || "Unknown Album";
    const rawAlbumArtist = albumMeta.artist?.name || "Unknown Artist";
    const albumTitle  = sanitize(rawAlbumTitle);
    const albumArtist = sanitize(rawAlbumArtist);
    const albumYear   = (albumMeta.releaseDate || "").slice(0, 4);
    const folder = `${albumArtist} - ${albumTitle}`;

    // Fetch album cover once for all tracks (best-effort)
    const needCover = (getMetadataCover() || (getCoverSave() && getCoverAllowed().includes("album"))) && albumMeta.cover;
    let albumCover = null;
    if (needCover) {
      onProgress?.(0, 1, "Fetching cover art…");
      albumCover = await fetchCoverArt(albumMeta.cover, getCoverSize());
    }

    const items = allItems.filter((i) => i.type === "track");
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
        let trackData = td.data;
        if (getMetadataEnable()) {
          trackData = embedMetadata(trackData, td.extension, {
            title: td.rawTitle, artist: td.rawArtist,
            albumTitle: td.albumTitle || rawAlbumTitle,
            albumArtist: td.albumArtist || rawAlbumArtist,
            trackNumber: td.trackNumber, discNumber: td.discNumber,
            year: td.year || albumYear, isrc: td.isrc, copyright: td.copyright,
            lyrics: td.lyrics,
          });
        }
        if (albumCover && getMetadataCover()) trackData = embedCoverArt(trackData, td.extension, albumCover);
        const num = String(td.trackNumber || (i + 1)).padStart(2, "0");
        const fname = `${folder}/${num}. ${td.artist} - ${td.title}${td.extension}`;
        zipFiles.push({ name: fname, data: trackData });
        results.push({ filename: fname, success: true });
        onSubItemProgress?.(i, items.length, td.title || track.title, 1, 1, "done");
      } catch (err) {
        results.push({ filename: track.title || String(track.id), success: false, error: err.message });
        onSubItemProgress?.(i, items.length, track.title, 0, 1, "failed");
      }
    }

    if (albumCover && getCoverSave() && getCoverAllowed().includes("album")) {
      zipFiles.push({ name: `${folder}/cover.jpg`, data: albumCover });
    }

    if (zipFiles.length > 0) {
      onProgress?.(items.length, items.length, `Packaging ${zipFiles.length} track(s) as ZIP…`);
      const zip = buildZip(zipFiles);
      triggerDownload(zip, `${folder}${nameSuffix}.zip`, "application/zip");
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
export async function downloadPlaylist(playlistId, quality = "HIGH", onProgress, onSubItemProgress, nameSuffix = "") {
  try {
    onProgress?.(0, 1, `Fetching playlist info…`);
    const [playlistMeta, allItems] = await Promise.all([
      getPlaylist(playlistId),
      getAllPlaylistItems(playlistId),
    ]);

    const playlistTitle = sanitize(playlistMeta.title || "Playlist");
    const folder = playlistTitle;

    // Fetch playlist cover once (best-effort) for cover-save feature.
    // Playlist cover images on Tidal max out at 1080px (per the settings UI label).
    let playlistCover = null;
    if (getCoverSave() && getCoverAllowed().includes("playlist") && playlistMeta.squareImage) {
      onProgress?.(0, 1, "Fetching playlist cover art…");
      playlistCover = await fetchCoverArt(playlistMeta.squareImage, Math.min(getCoverSize(), 1080));
    }

    const items = allItems.filter((i) => i.type === "track");
    const zipFiles = [];
    const results = [];
    // Cache cover art per hash to avoid redundant fetches across tracks
    const coverCache = new Map();

    for (let i = 0; i < items.length; i++) {
      const track = items[i].item;
      onProgress?.(i, items.length, `Track ${i + 1}/${items.length}: ${track.title}`);
      onSubItemProgress?.(i, items.length, track.title, 0, 1, "active");
      try {
        const td = await fetchTrackData(track.id, quality, (d, t, msg) => {
          onProgress?.(i, items.length, msg);
          onSubItemProgress?.(i, items.length, track.title, d, t, "active");
        });
        let trackData = td.data;
        if (getMetadataEnable()) {
          trackData = embedMetadata(trackData, td.extension, {
            title: td.rawTitle, artist: td.rawArtist,
            albumTitle: td.albumTitle, albumArtist: td.albumArtist,
            trackNumber: td.trackNumber, discNumber: td.discNumber,
            year: td.year, isrc: td.isrc, copyright: td.copyright,
            lyrics: td.lyrics,
          });
        }
        if (getMetadataCover() && td.coverHash) {
          if (!coverCache.has(td.coverHash)) {
            const fetched = await fetchCoverArt(td.coverHash, getCoverSize());
            if (fetched) coverCache.set(td.coverHash, fetched);
          }
          const cover = coverCache.get(td.coverHash);
          if (cover) trackData = embedCoverArt(trackData, td.extension, cover);
        }
        const num = String(i + 1).padStart(2, "0");
        const fname = `${folder}/${num}. ${td.artist} - ${td.title}${td.extension}`;
        zipFiles.push({ name: fname, data: trackData });
        results.push({ filename: fname, success: true });
        onSubItemProgress?.(i, items.length, td.title || track.title, 1, 1, "done");
      } catch (err) {
        results.push({ filename: track.title || String(track.id), success: false, error: err.message });
        onSubItemProgress?.(i, items.length, track.title, 0, 1, "failed");
      }
    }

    if (playlistCover && getCoverSave() && getCoverAllowed().includes("playlist")) {
      zipFiles.push({ name: `${folder}/cover.jpg`, data: playlistCover });
    }

    if (zipFiles.length > 0) {
      onProgress?.(items.length, items.length, `Packaging ${zipFiles.length} track(s) as ZIP…`);
      const zip = buildZip(zipFiles);
      triggerDownload(zip, `${folder}${nameSuffix}.zip`, "application/zip");
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
export async function downloadMix(mixId, quality = "HIGH", onProgress, onSubItemProgress, nameSuffix = "") {
  try {
    onProgress?.(0, 1, `Fetching mix items…`);
    const allItems = await getAllMixItems(mixId);

    const folder = sanitize(`Mix-${mixId}`);
    const items = allItems.filter((i) => i.type === "track");
    const zipFiles = [];
    const results = [];
    const coverCache = new Map();

    for (let i = 0; i < items.length; i++) {
      const track = items[i].item;
      onProgress?.(i, items.length, `Track ${i + 1}/${items.length}: ${track.title}`);
      onSubItemProgress?.(i, items.length, track.title, 0, 1, "active");
      try {
        const td = await fetchTrackData(track.id, quality, (d, t, msg) => {
          onProgress?.(i, items.length, msg);
          onSubItemProgress?.(i, items.length, track.title, d, t, "active");
        });
        let trackData = td.data;
        if (getMetadataEnable()) {
          trackData = embedMetadata(trackData, td.extension, {
            title: td.rawTitle, artist: td.rawArtist,
            albumTitle: td.albumTitle, albumArtist: td.albumArtist,
            trackNumber: td.trackNumber, discNumber: td.discNumber,
            year: td.year, isrc: td.isrc, copyright: td.copyright,
            lyrics: td.lyrics,
          });
        }
        if (getMetadataCover() && td.coverHash) {
          if (!coverCache.has(td.coverHash)) {
            const fetched = await fetchCoverArt(td.coverHash, getCoverSize());
            if (fetched) coverCache.set(td.coverHash, fetched);
          }
          const cover = coverCache.get(td.coverHash);
          if (cover) trackData = embedCoverArt(trackData, td.extension, cover);
        }
        const num = String(i + 1).padStart(2, "0");
        const fname = `${folder}/${num}. ${td.artist} - ${td.title}${td.extension}`;
        zipFiles.push({ name: fname, data: trackData });
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
      triggerDownload(zip, `${folder}${nameSuffix}.zip`, "application/zip");
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
export async function downloadArtistAlbums(artistId, quality = "HIGH", onProgress, onSubItemProgress, nameSuffix = "") {
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
        onProgress?.(i, all.length, `Album ${i + 1}/${all.length}: ${msg || ""}`),
        undefined,
        nameSuffix,
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
