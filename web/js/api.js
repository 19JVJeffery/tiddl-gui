/**
 * tiddl-web — Tidal API client
 *
 * Thin wrapper around api.tidal.com/v1 — mirrors the Python TidalAPI class.
 */

import { API_URL, proxied } from "./config.js";
import { getValidToken, loadAuth } from "./auth.js";

async function apiFetch(endpoint, params = {}) {
  const token = await getValidToken();
  if (!token) throw new Error("Not authenticated");

  const auth = loadAuth();
  const defaultParams = { countryCode: auth?.country_code || "US" };
  const merged = { ...defaultParams, ...params };

  const qs = new URLSearchParams(merged).toString();
  const url = `${API_URL}/${endpoint}?${qs}`;

  const res = await fetch(proxied(url), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const json = await res.json();
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
  const total = first.totalNumberOfItems ?? (first.items?.length ?? 0);
  let items = first.items ?? [];

  let offset = items.length;
  while (offset < total) {
    const page = await fetchFn(pageSize, offset);
    const pageItems = page.items ?? [];
    if (!pageItems.length) break;
    items = items.concat(pageItems);
    offset += pageItems.length;
  }

  return items;
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

export async function getSession() {
  return apiFetch("sessions");
}

// ─── Streams ───────────────────────────────────────────────────────────────

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
