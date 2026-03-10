/**
 * tiddl-web — main application controller
 *
 * Wires together auth, API, download modules and updates the DOM.
 */

// Delay (ms) before switching to the download tab after a successful login.
const LOGIN_SUCCESS_REDIRECT_DELAY_MS = 800;

import {
  getDeviceAuth,
  pollDeviceAuth,
  logout,
  isLoggedIn,
  loadAuth,
  saveAuth,
} from "./auth.js";
import { search, getTrack, getAlbum, getPlaylist, getArtist } from "./api.js";
import {
  parseTidalInput,
  downloadTrack,
  downloadAlbum,
  downloadPlaylist,
  downloadMix,
} from "./download.js";
import { getCorsProxy, setCorsProxy } from "./config.js";

// ─── Utility ────────────────────────────────────────────────────────────────

function $(id) {
  return document.getElementById(id);
}
function show(el) {
  if (el) el.classList.remove("hidden");
}
function hide(el) {
  if (el) el.classList.add("hidden");
}
function setHtml(el, html) {
  if (el) el.innerHTML = html;
}

function appendLog(msg, type = "info") {
  const log = $("download-log");
  if (!log) return;
  const line = document.createElement("div");
  line.className = `log-line log-${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function clearLog() {
  const log = $("download-log");
  if (log) log.innerHTML = "";
}

// ─── Nav ────────────────────────────────────────────────────────────────────

function activateTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `panel-${tabId}`);
  });
}

// ─── Auth UI ────────────────────────────────────────────────────────────────

function updateAuthBadge() {
  const badge = $("auth-badge");
  const logoutBtn = $("btn-logout");
  if (!badge) return;
  if (isLoggedIn()) {
    const auth = loadAuth();
    badge.textContent = auth?.username || "Logged in";
    badge.className = "auth-badge auth-badge--in";
    show(logoutBtn);
  } else {
    badge.textContent = "Not logged in";
    badge.className = "auth-badge auth-badge--out";
    hide(logoutBtn);
  }
}

let pollTimer = null;

async function startLogin() {
  const loginBtn = $("btn-login");
  const loginStatus = $("login-status");
  const loginLink = $("login-link");

  loginBtn.disabled = true;
  setHtml(loginStatus, '<span class="spinner"></span> Requesting device code…');

  try {
    const deviceAuth = await getDeviceAuth();
    const uri = `https://${deviceAuth.verificationUriComplete}`;

    setHtml(
      loginStatus,
      `<p>Open the link below and approve the request, then wait here.</p>
       <a href="${uri}" target="_blank" rel="noopener" class="login-link">${uri}</a>`
    );

    if (loginLink) loginLink.href = uri;

    const endAt = Date.now() + deviceAuth.expiresIn * 1000;

    const poll = async () => {
      if (Date.now() >= endAt) {
        setHtml(loginStatus, '<span class="error">Authentication expired. Try again.</span>');
        loginBtn.disabled = false;
        return;
      }
      try {
        const authResponse = await pollDeviceAuth(deviceAuth.deviceCode);
        saveAuth({
          token: authResponse.access_token,
          refresh_token: authResponse.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + authResponse.expires_in,
          user_id: String(authResponse.user_id),
          country_code: authResponse.user?.countryCode || "US",
          username: authResponse.user?.username || authResponse.user?.email || "User",
        });
        setHtml(loginStatus, '<span class="success">✓ Logged in successfully!</span>');
        loginBtn.disabled = false;
        updateAuthBadge();
        // switch to download tab
        setTimeout(() => activateTab("download"), LOGIN_SUCCESS_REDIRECT_DELAY_MS);
      } catch (err) {
        if (err?.status === 400 && err?.error === "authorization_pending") {
          const secsLeft = Math.max(0, Math.round((endAt - Date.now()) / 1000));
          const mins = Math.floor(secsLeft / 60);
          const secs = secsLeft % 60;
          const timeStr = `${mins}:${String(secs).padStart(2, "0")}`;
          setHtml(
            loginStatus,
            `<p>Waiting for approval… <span class="countdown">${timeStr}</span></p>
             <a href="${uri}" target="_blank" rel="noopener" class="login-link">${uri}</a>`
          );
          pollTimer = setTimeout(poll, deviceAuth.interval * 1000);
        } else if (err?.error === "expired_token") {
          setHtml(loginStatus, '<span class="error">Device code expired. Try again.</span>');
          loginBtn.disabled = false;
        } else {
          const msg = err?.error_description || err?.message || JSON.stringify(err);
          setHtml(loginStatus, `<span class="error">Error: ${msg}</span>`);
          loginBtn.disabled = false;
        }
      }
    };

    pollTimer = setTimeout(poll, deviceAuth.interval * 1000);
  } catch (err) {
    const msg = err?.message || JSON.stringify(err);
    setHtml(loginStatus, `<span class="error">Failed to start login: ${msg}</span>`);
    loginBtn.disabled = false;
  }
}

async function handleLogout() {
  if (pollTimer) clearTimeout(pollTimer);
  await logout();
  updateAuthBadge();
  setHtml($("login-status"), "");
  activateTab("auth");
  appendLog("Logged out.", "info");
}

// ─── Download UI ─────────────────────────────────────────────────────────────

function setProgress(done, total, message) {
  const bar = $("progress-bar");
  const label = $("progress-label");
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = message || `${pct}%`;
}

async function handleDownload() {
  if (!isLoggedIn()) {
    appendLog("You must be logged in to download.", "error");
    activateTab("auth");
    return;
  }

  const input = $("url-input")?.value?.trim();
  if (!input) {
    appendLog("Please enter a Tidal URL or track/album ID.", "warn");
    return;
  }

  const quality = $("quality-select")?.value || "HIGH";
  const resource = parseTidalInput(input);

  if (!resource) {
    appendLog(`Could not parse "${input}" as a Tidal resource.`, "error");
    return;
  }

  appendLog(`Starting download: ${resource.type}/${resource.id} @ ${quality}`, "info");

  const downloadBtn = $("btn-download");
  downloadBtn.disabled = true;
  setProgress(0, 1, "Starting…");

  const onProgress = (done, total, msg) => {
    setProgress(done, total, msg);
    if (msg) appendLog(msg, "info");
  };

  try {
    let results = [];

    switch (resource.type) {
      case "track":
        results = [await downloadTrack(resource.id, quality, onProgress)];
        break;
      case "album":
        results = await downloadAlbum(resource.id, quality, onProgress);
        break;
      case "playlist":
        results = await downloadPlaylist(resource.id, quality, onProgress);
        break;
      case "mix":
        results = await downloadMix(resource.id, quality, onProgress);
        break;
      default:
        appendLog(`Resource type "${resource.type}" is not yet supported for download.`, "warn");
    }

    for (const r of results) {
      if (r.success) appendLog(`✓ Saved: ${r.filename}`, "success");
      else appendLog(`✗ Failed: ${r.filename} — ${r.error}`, "error");
    }
    setProgress(results.length, results.length, "Done");
  } catch (err) {
    appendLog(`Download error: ${err.message}`, "error");
    setProgress(0, 1, "Error");
  } finally {
    downloadBtn.disabled = false;
  }
}

// ─── Search UI ────────────────────────────────────────────────────────────────

function renderSearchResults(data) {
  const container = $("search-results");
  if (!container) return;

  const tracks = data?.tracks?.items || [];
  const albums = data?.albums?.items || [];
  const artists = data?.artists?.items || [];

  if (!tracks.length && !albums.length && !artists.length) {
    container.innerHTML = '<p class="no-results">No results found.</p>';
    return;
  }

  let html = "";

  if (tracks.length) {
    html += `<h3 class="result-heading">Tracks</h3><div class="result-grid">`;
    for (const t of tracks.slice(0, 8)) {
      const cover = t.album?.cover
        ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, "/")}/320x320.jpg`
        : "";
      html += `
        <div class="result-card" data-type="track" data-id="${t.id}">
          ${cover ? `<img src="${cover}" alt="" class="result-cover" loading="lazy">` : '<div class="result-cover placeholder"></div>'}
          <div class="result-info">
            <span class="result-title">${escHtml(t.title)}</span>
            <span class="result-sub">${escHtml(t.artist?.name || "")}</span>
          </div>
        </div>`;
    }
    html += `</div>`;
  }

  if (albums.length) {
    html += `<h3 class="result-heading">Albums</h3><div class="result-grid">`;
    for (const a of albums.slice(0, 6)) {
      const cover = a.cover
        ? `https://resources.tidal.com/images/${a.cover.replace(/-/g, "/")}/320x320.jpg`
        : "";
      html += `
        <div class="result-card" data-type="album" data-id="${a.id}">
          ${cover ? `<img src="${cover}" alt="" class="result-cover" loading="lazy">` : '<div class="result-cover placeholder"></div>'}
          <div class="result-info">
            <span class="result-title">${escHtml(a.title)}</span>
            <span class="result-sub">${escHtml(a.artist?.name || "")}</span>
          </div>
        </div>`;
    }
    html += `</div>`;
  }

  if (artists.length) {
    html += `<h3 class="result-heading">Artists</h3><div class="result-grid">`;
    for (const ar of artists.slice(0, 6)) {
      const pic = ar.picture
        ? `https://resources.tidal.com/images/${ar.picture.replace(/-/g, "/")}/320x320.jpg`
        : "";
      html += `
        <div class="result-card" data-type="artist" data-id="${ar.id}">
          ${pic ? `<img src="${pic}" alt="" class="result-cover round" loading="lazy">` : '<div class="result-cover placeholder round"></div>'}
          <div class="result-info">
            <span class="result-title">${escHtml(ar.name)}</span>
            <span class="result-sub">Artist</span>
          </div>
        </div>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;

  // Click on result → prefill download tab
  container.querySelectorAll(".result-card").forEach((card) => {
    card.addEventListener("click", () => {
      const type = card.dataset.type;
      const id = card.dataset.id;
      const urlInput = $("url-input");
      if (urlInput) urlInput.value = `${type}/${id}`;
      activateTab("download");
      appendLog(`Selected: ${type}/${id}`, "info");
    });
  });
}

async function handleSearch() {
  if (!isLoggedIn()) {
    appendLog("You must be logged in to search.", "error");
    activateTab("auth");
    return;
  }

  const query = $("search-input")?.value?.trim();
  if (!query) return;

  const searchBtn = $("btn-search");
  searchBtn.disabled = true;
  const container = $("search-results");
  if (container) container.innerHTML = '<p class="searching">Searching…</p>';

  try {
    const data = await search(query, 10);
    renderSearchResults(data);
  } catch (err) {
    if (container)
      container.innerHTML = `<p class="error">Search failed: ${escHtml(err.message)}</p>`;
  } finally {
    searchBtn.disabled = false;
  }
}

// ─── Settings UI ─────────────────────────────────────────────────────────────

function loadSettings() {
  const proxyInput = $("proxy-input");
  if (proxyInput) proxyInput.value = getCorsProxy();
}

function saveSettings() {
  const proxyInput = $("proxy-input");
  if (proxyInput) setCorsProxy(proxyInput.value.trim());
  appendLog("Settings saved.", "success");
}

// ─── Escape HTML ─────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

export function init() {
  // Nav
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  // Auth
  $("btn-login")?.addEventListener("click", startLogin);
  $("btn-logout")?.addEventListener("click", handleLogout);

  // Download
  $("btn-download")?.addEventListener("click", handleDownload);
  $("url-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleDownload();
  });

  // Search
  $("btn-search")?.addEventListener("click", handleSearch);
  $("search-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSearch();
  });

  // Settings
  $("btn-save-settings")?.addEventListener("click", saveSettings);

  // Initial state
  updateAuthBadge();
  loadSettings();

  if (!isLoggedIn()) {
    activateTab("auth");
  } else {
    activateTab("download");
  }
}
