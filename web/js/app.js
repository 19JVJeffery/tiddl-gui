/**
 * tiddl-web — main application controller
 *
 * Wires together auth, API, download, and settings modules and updates the DOM.
 */

const LOGIN_SUCCESS_REDIRECT_DELAY_MS = 800;

import {
  getDeviceAuth, pollDeviceAuth, logout,
  isLoggedIn, loadAuth, saveAuth,
} from "./auth.js";
import { search } from "./api.js";
import {
  parseTidalInput, downloadTrack, downloadAlbum,
  downloadPlaylist, downloadMix,
} from "./download.js";
import { getTheme, getAccentColor, getTrackQuality } from "./config.js";
import {
  applyTheme, applyAccentColor, cycleTheme,
  initThemeUI, initAccentColorUI,
  initTemplateBuilders, loadSettingsForm, saveSettingsForm,
} from "./settings.js";

// ─── Utility ─────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }
function show(el) { if (el) el.classList.remove("hidden"); }
function hide(el) { if (el) el.classList.add("hidden"); }
function setHtml(el, html) { if (el) el.innerHTML = html; }

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Log ─────────────────────────────────────────────────────────────────────

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

// ─── Nav ─────────────────────────────────────────────────────────────────────

function activateTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.tab === tabId)
  );
  document.querySelectorAll(".tab-panel").forEach((panel) =>
    panel.classList.toggle("hidden", panel.id !== `panel-${tabId}`)
  );
}

// ─── Auth UI ─────────────────────────────────────────────────────────────────

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
  loginBtn.disabled = true;
  setHtml(loginStatus, '<span class="spinner"></span> Requesting device code…');

  try {
    const deviceAuth = await getDeviceAuth();
    const uri = `https://${deviceAuth.verificationUriComplete}`;
    setHtml(loginStatus,
      `<p>Open the link below and approve the request, then wait here.</p>
       <a href="${escHtml(uri)}" target="_blank" rel="noopener" class="login-link">${escHtml(uri)}</a>`
    );

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
        setTimeout(() => activateTab("download"), LOGIN_SUCCESS_REDIRECT_DELAY_MS);
      } catch (err) {
        if (err?.status === 400 && err?.error === "authorization_pending") {
          const secsLeft = Math.max(0, Math.round((endAt - Date.now()) / 1000));
          const mins = Math.floor(secsLeft / 60);
          const secs = secsLeft % 60;
          setHtml(loginStatus,
            `<p>Waiting for approval… <span class="countdown">${mins}:${String(secs).padStart(2, "0")}</span></p>
             <a href="${escHtml(uri)}" target="_blank" rel="noopener" class="login-link">${escHtml(uri)}</a>`
          );
          pollTimer = setTimeout(poll, deviceAuth.interval * 1000);
        } else if (err?.error === "expired_token") {
          setHtml(loginStatus, '<span class="error">Device code expired. Try again.</span>');
          loginBtn.disabled = false;
        } else {
          const msg = err?.error_description || err?.message || JSON.stringify(err);
          setHtml(loginStatus, `<span class="error">Error: ${escHtml(msg)}</span>`);
          loginBtn.disabled = false;
        }
      }
    };

    pollTimer = setTimeout(poll, deviceAuth.interval * 1000);
  } catch (err) {
    const msg = err?.message || JSON.stringify(err);
    setHtml(loginStatus, `<span class="error">Failed to start login: ${escHtml(msg)}</span>`);
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

// ─── Download queue ────────────────────────────────────────────────────────

/**
 * Each item: { type, id, title, sub, cover, coverRound }
 */
const downloadQueue = [];

function renderQueue() {
  const queueEl = $("download-queue");
  const section = $("download-queue-section");
  const countEl = $("queue-count");
  if (!queueEl) return;

  if (downloadQueue.length === 0) {
    hide(section);
    queueEl.innerHTML = "";
    return;
  }

  show(section);
  if (countEl) countEl.textContent = String(downloadQueue.length);

  queueEl.innerHTML = downloadQueue.map((item, idx) => {
    const thumbHtml = item.cover
      ? `<img src="${escHtml(item.cover)}" alt="" class="queue-item-thumb${item.coverRound ? " round" : ""}" loading="lazy" />`
      : `<div class="queue-item-thumb${item.coverRound ? " round" : ""}"></div>`;
    return `
      <div class="queue-item" data-idx="${idx}">
        ${thumbHtml}
        <div class="queue-item-info">
          <div class="queue-item-title">${escHtml(item.title)}</div>
          <div class="queue-item-sub">${escHtml(item.sub)}</div>
        </div>
        <span class="queue-item-badge" data-type="${escHtml(item.type)}">${escHtml(item.type)}</span>
        <span class="queue-item-status" id="queue-status-${idx}"></span>
        <button class="queue-remove-btn" data-idx="${idx}" title="Remove" aria-label="Remove">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>`;
  }).join("");

  queueEl.querySelectorAll(".queue-remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      removeFromQueue(idx);
    });
  });
}

function addToQueue(item) {
  // Avoid duplicate IDs (same type+id)
  const exists = downloadQueue.some((q) => q.type === item.type && String(q.id) === String(item.id));
  if (exists) return false;
  downloadQueue.push(item);
  renderQueue();
  return true;
}

function removeFromQueue(idx) {
  const item = downloadQueue[idx];
  downloadQueue.splice(idx, 1);
  renderQueue();
  // Deselect the corresponding result card
  if (item) {
    document.querySelectorAll(`.result-card[data-type="${item.type}"][data-id="${item.id}"]`)
      .forEach((c) => c.classList.remove("selected"));
  }
  // Also remove the URL input if it matches
  const urlInput = $("url-input");
  if (urlInput && downloadQueue.length === 0) urlInput.value = "";
}

function clearQueue() {
  downloadQueue.length = 0;
  document.querySelectorAll(".result-card.selected").forEach((c) => c.classList.remove("selected"));
  renderQueue();
  const urlInput = $("url-input");
  if (urlInput) urlInput.value = "";
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function setProgress(done, total, message) {
  const bar = $("progress-bar");
  const label = $("progress-label");
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = message || `${pct}%`;
}

// ─── Download UI ──────────────────────────────────────────────────────────────

async function handleDownload() {
  if (!isLoggedIn()) {
    appendLog("You must be logged in to download.", "error");
    activateTab("auth");
    return;
  }

  const quality = $("quality-select")?.value || "HIGH";
  const downloadBtn = $("btn-download");

  // Collect items to download: queue takes priority, fallback to URL input
  let items = [...downloadQueue];
  if (items.length === 0) {
    const raw = $("url-input")?.value?.trim();
    if (!raw) {
      appendLog("Please enter a Tidal URL or resource ID, or select items from Search.", "warn");
      return;
    }
    const resource = parseTidalInput(raw);
    if (!resource) {
      appendLog(`Could not parse "${raw}" as a Tidal resource.`, "error");
      return;
    }
    items = [{ type: resource.type, id: resource.id, title: raw, sub: "" }];
  }

  downloadBtn.disabled = true;
  clearLog();
  setProgress(0, items.length, "Starting…");

  let totalDone = 0;
  let totalOk = 0, totalFail = 0;

  for (let qi = 0; qi < items.length; qi++) {
    const item = items[qi];
    const qStatusEl = $(`queue-status-${qi}`);

    appendLog(`Downloading ${item.type}/${item.id} @ ${quality}`, "info");
    if (qStatusEl) qStatusEl.textContent = "⏳";

    const onProgress = (done, total, msg) => {
      setProgress(qi, items.length, msg || `Item ${qi + 1}/${items.length}`);
      if (msg) appendLog(msg, "info");
    };

    try {
      let results = [];
      switch (item.type) {
        case "track":
          results = [await downloadTrack(item.id, quality, onProgress)];
          break;
        case "album":
          results = await downloadAlbum(item.id, quality, onProgress);
          break;
        case "playlist":
          results = await downloadPlaylist(item.id, quality, onProgress);
          break;
        case "mix":
          results = await downloadMix(item.id, quality, onProgress);
          break;
        default:
          appendLog(`Resource type "${item.type}" not yet supported.`, "warn");
          results = [{ filename: String(item.id), success: false, error: "unsupported type" }];
      }

      for (const r of results) {
        if (r.success) { appendLog(`✓ Saved: ${r.filename}`, "success"); totalOk++; }
        else           { appendLog(`✗ Failed: ${r.filename} — ${r.error}`, "error"); totalFail++; }
      }
      if (qStatusEl) qStatusEl.textContent = results.every((r) => r.success) ? "✓" : "✗";
    } catch (err) {
      appendLog(`Error (${item.type}/${item.id}): ${err.message}`, "error");
      if (qStatusEl) qStatusEl.textContent = "✗";
      totalFail++;
    }

    totalDone++;
    setProgress(totalDone, items.length, `${totalDone}/${items.length} done`);
  }

  setProgress(items.length, items.length,
    totalFail === 0 ? "Done ✓" : `Done — ${totalOk} ok, ${totalFail} failed`);
  downloadBtn.disabled = false;
}

// ─── Search ───────────────────────────────────────────────────────────────────

let lastSearchData = null;
let activeTypeFilter = "all";

/** Number of results shown per category before the user clicks "View more". */
const INITIAL_LIMIT = 8;

function coverUrl(hash, size = 320) {
  return hash
    ? `https://resources.tidal.com/images/${hash.replace(/-/g, "/") }/${size}x${size}.jpg`
    : "";
}

function buildResultGrid(items, type, shownCount, totalCount) {
  if (!items.length) return "";

  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  let html = `<div class="result-section" data-section="${type}">
    <h3 class="result-heading">${typeLabel}</h3>
    <div class="result-grid">`;

  for (const item of items.slice(0, shownCount)) {
    let id, title, sub, cover, round = false;

    if (type === "tracks") {
      id = item.id; title = item.title; sub = item.artist?.name || "";
      cover = coverUrl(item.album?.cover);
    } else if (type === "albums") {
      id = item.id; title = item.title; sub = item.artist?.name || "";
      cover = coverUrl(item.cover);
    } else if (type === "artists") {
      id = item.id; title = item.name; sub = "Artist";
      cover = coverUrl(item.picture); round = true;
    } else if (type === "playlists") {
      id = item.uuid; title = item.title; sub = item.creator?.name || "Tidal";
      cover = coverUrl(item.image || item.squareImage);
    }

    const resourceType = type === "tracks" ? "track"
      : type === "albums" ? "album"
      : type === "artists" ? "artist"
      : "playlist";

    const inQueue = downloadQueue.some(
      (q) => q.type === resourceType && String(q.id) === String(id)
    );

    const imgHtml = cover
      ? `<img src="${escHtml(cover)}" alt="" class="result-cover${round ? " round" : ""}" loading="lazy" />`
      : `<div class="result-cover placeholder${round ? " round" : ""}"></div>`;

    html += `
      <div class="result-card${inQueue ? " selected" : ""}" data-type="${escHtml(resourceType)}" data-id="${escHtml(String(id))}"
           data-title="${escHtml(title)}" data-sub="${escHtml(sub)}" data-cover="${escHtml(cover)}" data-round="${round}"
           tabindex="0" role="button" aria-pressed="${inQueue}">
        ${imgHtml}
        <div class="result-info">
          <span class="result-title">${escHtml(title)}</span>
          <span class="result-sub">${escHtml(sub)}</span>
        </div>
      </div>`;
  }

  html += `</div>`;

  if (totalCount > shownCount) {
    html += `<div class="view-more-wrap">
      <button class="btn-view-more" data-type="${type}" data-shown="${shownCount}">
        View more (${totalCount - shownCount} more)
      </button>
    </div>`;
  }

  html += `</div>`;
  return html;
}

function renderSearchResults(data, filter = "all") {
  const container = $("search-results");
  if (!container) return;

  const tracks    = data?.tracks?.items    || [];
  const albums    = data?.albums?.items    || [];
  const artists   = data?.artists?.items   || [];
  const playlists = data?.playlists?.items || [];

  if (!tracks.length && !albums.length && !artists.length && !playlists.length) {
    container.innerHTML = '<p class="no-results">No results found.</p>';
    return;
  }

  let html = "";

  const show = (type) => filter === "all" || filter === type;

  if (show("tracks"))    html += buildResultGrid(tracks,    "tracks",    INITIAL_LIMIT, tracks.length);
  if (show("albums"))    html += buildResultGrid(albums,    "albums",    INITIAL_LIMIT, albums.length);
  if (show("artists"))   html += buildResultGrid(artists,   "artists",   INITIAL_LIMIT, artists.length);
  if (show("playlists")) html += buildResultGrid(playlists, "playlists", INITIAL_LIMIT, playlists.length);

  container.innerHTML = html || '<p class="no-results">No results for this category.</p>';
  attachResultHandlers(container);
}

function attachResultHandlers(container) {
  // Click on result card: toggle add/remove from queue
  container.querySelectorAll(".result-card").forEach((card) => {
    card.addEventListener("click", () => toggleResultInQueue(card));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleResultInQueue(card); }
    });
  });

  // View more button
  container.querySelectorAll(".btn-view-more").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type    = btn.dataset.type;
      const shown   = parseInt(btn.dataset.shown, 10);
      const items   = lastSearchData?.[type]?.items || [];
      const newShown = shown + INITIAL_LIMIT;

      // Re-render just this section
      const sectionEl = container.querySelector(`.result-section[data-section="${type}"]`);
      if (sectionEl) {
        const tmp = document.createElement("div");
        tmp.innerHTML = buildResultGrid(items, type, newShown, items.length);
        const newSection = tmp.firstElementChild;
        sectionEl.replaceWith(newSection);
        attachResultHandlers(container);
      }
    });
  });
}

function toggleResultInQueue(card) {
  const type  = card.dataset.type;
  const id    = card.dataset.id;
  const title = card.dataset.title;
  const sub   = card.dataset.sub;
  const cover = card.dataset.cover;
  const round = card.dataset.round === "true";

  const existing = downloadQueue.findIndex(
    (q) => q.type === type && String(q.id) === String(id)
  );

  if (existing !== -1) {
    // Remove from queue
    removeFromQueue(existing);
    card.classList.remove("selected");
    card.setAttribute("aria-pressed", "false");
    appendLog(`Removed from queue: ${type}/${id}`, "info");
  } else {
    // Add to queue and switch to download tab
    addToQueue({ type, id, title, sub, cover, coverRound: round });
    card.classList.add("selected");
    card.setAttribute("aria-pressed", "true");
    appendLog(`Added to queue: ${type}/${id} — "${title}"`, "info");

    // Prefill URL input with the last-added item (single selection convenience)
    const urlInput = $("url-input");
    if (urlInput && downloadQueue.length === 1) urlInput.value = `${type}/${id}`;

    activateTab("download");
  }
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
  if (container) container.innerHTML = '<p class="searching"><span class="spinner"></span> Searching…</p>';

  try {
    const data = await search(query, 20);
    lastSearchData = data;
    renderSearchResults(data, activeTypeFilter);
  } catch (err) {
    if (container)
      container.innerHTML = `<p class="error">Search failed: ${escHtml(err.message)}</p>`;
  } finally {
    searchBtn.disabled = false;
  }
}

// ─── Settings UI ──────────────────────────────────────────────────────────────

function handleSaveSettings() {
  saveSettingsForm(appendLog);
  const msg = $("settings-save-msg");
  if (msg) {
    msg.classList.add("visible");
    setTimeout(() => msg.classList.remove("visible"), 2500);
  }
}

// ─── Theme icon ───────────────────────────────────────────────────────────────

const THEME_ICONS = {
  dark:   `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  light:  `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
  system: `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
};

function updateThemeIcon() {
  const icon = $("theme-icon");
  if (!icon) return;
  const t = document.documentElement.getAttribute("data-theme") || "system";
  icon.outerHTML = (THEME_ICONS[t] || THEME_ICONS.system).replace("svg ", `svg id="theme-icon" `);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

export function init() {
  // ── Apply stored appearance preferences immediately ──
  const theme = getTheme();
  applyTheme(theme);
  applyAccentColor(getAccentColor());
  updateThemeIcon();

  // ── Nav tabs ──
  document.querySelectorAll(".tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => activateTab(btn.dataset.tab))
  );

  // ── Auth ──
  $("btn-login")?.addEventListener("click", startLogin);
  $("btn-logout")?.addEventListener("click", handleLogout);

  // ── Download ──
  $("btn-download")?.addEventListener("click", handleDownload);
  $("url-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleDownload();
  });
  $("btn-clear-queue")?.addEventListener("click", clearQueue);

  // ── Search ──
  $("btn-search")?.addEventListener("click", handleSearch);
  $("search-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSearch();
  });

  // Type filter pills
  document.querySelectorAll(".type-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      activeTypeFilter = pill.dataset.type;
      document.querySelectorAll(".type-pill").forEach((p) =>
        p.classList.toggle("active", p.dataset.type === activeTypeFilter)
      );
      if (lastSearchData) renderSearchResults(lastSearchData, activeTypeFilter);
    });
  });

  // ── Settings ──
  $("btn-save-settings")?.addEventListener("click", handleSaveSettings);

  // Theme toggle in header (cycles dark → light → system)
  $("theme-toggle")?.addEventListener("click", () => {
    cycleTheme();
    updateThemeIcon();
  });

  initThemeUI();
  initAccentColorUI(appendLog);
  initTemplateBuilders();

  // ── Quality sync: default select value from settings ──
  const qs = $("quality-select");
  if (qs) qs.value = getTrackQuality();

  // ── Initial state ──
  updateAuthBadge();
  loadSettingsForm();

  if (!isLoggedIn()) {
    activateTab("auth");
  } else {
    activateTab("download");
  }
}
