/**
 * tiddl-web — Tidal API client
 *
 * Thin wrapper around api.tidal.com/v1 — mirrors the Python TidalAPI class.
 */

import { API_URL, proxied } from "./config.js";
import { getValidToken, loadAuth, refreshToken } from "./auth.js";

/**
 * Safety guard for paginated endpoints.
 * Prevents infinite loops if an upstream API/proxy keeps repeating pages or offsets.
 * 2000 pages is far above real-world library sizes (100k+ items at 50/page)
 * while still guaranteeing termination under pathological responses.
 */
const MAX_PAGINATION_PAGES = 2000;

async function apiFetch(endpoint, params = {}) {
  const auth = loadAuth();
  const defaultParams = { countryCode: auth?.country_code || "US" };
  const merged = { ...defaultParams, ...params };

  const qs = new URLSearchParams(merged).toString();
  const url = `${API_URL}/${endpoint}?${qs}`;

  async function doRequest(token) {
    const res = await fetch(proxied(url), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      credentials: "omit",
    });
    let json = {};
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    return { res, json };
  }

  let token = await getValidToken();
  if (!token) throw new Error("Not authenticated");

  let { res, json } = await doRequest(token);
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    try {
      const refreshed = await refreshToken();
      token = refreshed?.token;
      if (token) {
        ({ res, json } = await doRequest(token));
      }
    } catch {
      // Keep original error handling below.
    }
  }

  if (!res.ok) {
    const msg = json?.userMessage || json?.error_description || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// ─── Resources ─────────────────────────────────────────────────────────────

export async function getTrack(id) {
  return apiFetch(`tracks/${id}`);
}

export async function getAlbum(id) {
  return apiFetch(`albums/${id}`);
}

export async function getAlbumItems(id, limit = 100, offset = 0) {
  return apiFetch(`albums/${id}/items`, { limit, offset });
}

export async function getArtist(id) {
  return apiFetch(`artists/${id}`);
}

export async function getArtistAlbums(id, limit = 50, offset = 0) {
  return apiFetch(`artists/${id}/albums`, { limit, offset, filter: "ALBUMS" });
}

export async function getArtistSingles(id, limit = 50, offset = 0) {
  return apiFetch(`artists/${id}/albums`, { limit, offset, filter: "EPSANDSINGLES" });
}

export async function getPlaylist(uuid) {
  return apiFetch(`playlists/${uuid}`);
}

export async function getPlaylistItems(uuid, limit = 100, offset = 0) {
  return apiFetch(`playlists/${uuid}/items`, { limit, offset });
}

export async function getMixItems(mixId, limit = 100, offset = 0) {
  return apiFetch(`mixes/${mixId}/items`, { limit, offset });
}

export async function getVideo(id) {
  return apiFetch(`videos/${id}`);
}

export async function search(query, limit = 20) {
  return apiFetch("search", { query, limit });
}

export async function getFavorites() {
  const auth = loadAuth();
  if (!auth?.user_id) throw new Error("No user id");
  return apiFetch(`users/${auth.user_id}/favorites/ids`);
}

export async function getUserFavoriteTracks(limit = 50, offset = 0) {
  const auth = loadAuth();
  if (!auth?.user_id) throw new Error("No user id");
  return apiFetch(`users/${auth.user_id}/favorites/tracks`, { limit, offset });
}

export async function getUserFavoriteAlbums(limit = 50, offset = 0) {
  const auth = loadAuth();
  if (!auth?.user_id) throw new Error("No user id");
  return apiFetch(`users/${auth.user_id}/favorites/albums`, { limit, offset });
}

export async function getUserFavoritePlaylists(limit = 50, offset = 0) {
  const auth = loadAuth();
  if (!auth?.user_id) throw new Error("No user id");
  return apiFetch(`users/${auth.user_id}/favorites/playlists`, { limit, offset });
}

export async function getUserPlaylists(limit = 50, offset = 0) {
  const auth = loadAuth();
  if (!auth?.user_id) throw new Error("No user id");
  return apiFetch(`users/${auth.user_id}/playlists`, { limit, offset });
}

// ─── Fetch-all helpers ─────────────────────────────────────────────────────

/**
 * Fetch every page of a paginated Tidal endpoint.
 * `fetchFn(limit, offset)` must return `{ items: [...], totalNumberOfItems: N }`.
 * Pages are fetched sequentially to avoid rate-limiting.
 */
async function fetchAllItems(fetchFn, pageSize = 50) {
  const first = await fetchFn(pageSize, 0);
  const firstItems = Array.isArray(first.items) ? first.items : [];
  const parsedTotal = Number(first.totalNumberOfItems);
  const hasKnownTotal = Number.isFinite(parsedTotal) && parsedTotal >= 0;
  const total = hasKnownTotal ? parsedTotal : null;
  let items = firstItems.slice();

  const pageSignature = (arr) => arr
    .map((it) => `${it?.type ?? ""}:${it?.item?.id ?? it?.id ?? ""}`)
    .join("|");
  let lastSignature = pageSignature(firstItems);

  const firstOffset = Number(first?.offset);
  const firstLimit = Number(first?.limit);
  let offset = Number.isFinite(firstOffset) && Number.isFinite(firstLimit) && firstLimit > 0
    ? firstOffset + firstLimit
    : items.length;

  let pagesFetched = 0;
  while ((!hasKnownTotal || items.length < total) && pagesFetched < MAX_PAGINATION_PAGES) {
    pagesFetched += 1;
    const page = await fetchFn(pageSize, offset);
    const pageItems = Array.isArray(page.items) ? page.items : [];
    if (!pageItems.length) break;

    const signature = pageSignature(pageItems);
    items = items.concat(pageItems);

    const pageOffset = Number(page?.offset);
    const pageLimit = Number(page?.limit);
    const reportedNextOffset = Number.isFinite(pageOffset) && Number.isFinite(pageLimit) && pageLimit > 0
      ? pageOffset + pageLimit
      : offset + pageItems.length;
    const nextOffset = Math.max(offset + pageItems.length, reportedNextOffset);

    // If the API returns the exact same page and does not advance offset,
    // stop to avoid an infinite loop.
    const repeatedPage = signature && signature === lastSignature;
    const stalledOffset = nextOffset <= offset;
    if (repeatedPage && stalledOffset) break;
    lastSignature = signature;
    offset = nextOffset;

    if (!hasKnownTotal && pageItems.length < pageSize) break;
  }

  return hasKnownTotal ? items.slice(0, total) : items;
}

export async function getAllUserFavoriteTracks() {
  return fetchAllItems((limit, offset) => getUserFavoriteTracks(limit, offset));
}

export async function getAllUserFavoriteAlbums() {
  return fetchAllItems((limit, offset) => getUserFavoriteAlbums(limit, offset));
}

export async function getAllUserFavoritePlaylists() {
  return fetchAllItems((limit, offset) => getUserFavoritePlaylists(limit, offset));
}

export async function getAllUserPlaylists() {
  return fetchAllItems((limit, offset) => getUserPlaylists(limit, offset));
}

export async function getAllAlbumItems(id) {
  return fetchAllItems((limit, offset) => getAlbumItems(id, limit, offset));
}

export async function getAllPlaylistItems(uuid) {
  return fetchAllItems((limit, offset) => getPlaylistItems(uuid, limit, offset));
}

export async function getAllMixItems(mixId) {
  return fetchAllItems((limit, offset) => getMixItems(mixId, limit, offset));
}

export async function getSession() {
  return apiFetch("sessions");
}

// ─── Streams ───────────────────────────────────────────────────────────────

export async function getTrackLyrics(trackId) {
  return apiFetch(`tracks/${trackId}/lyrics`);
}

export async function getTrackStream(trackId, quality = "HIGH") {
  return apiFetch(`tracks/${trackId}/playbackinfopostpaywall`, {
    audioquality: quality,
    playbackmode: "STREAM",
    assetpresentation: "FULL",
  });
}

export async function getVideoStream(videoId, quality = "HIGH") {
  return apiFetch(`videos/${videoId}/playbackinfopostpaywall`, {
    videoquality: quality,
    playbackmode: "STREAM",
    assetpresentation: "FULL",
  });
}
