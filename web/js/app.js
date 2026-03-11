/**
 * tiddl-web — main application controller
 */

const LOGIN_SUCCESS_REDIRECT_DELAY_MS = 800;

import {
  getDeviceAuth, pollDeviceAuth, logout,
  isLoggedIn, loadAuth, saveAuth,
} from "./auth.js";
import {
  search,
  getTrack,
  getArtistAlbums, getArtistSingles,
  getAlbum,
  getPlaylist,
  getUserFavoriteTracks, getUserFavoriteAlbums,
  getUserFavoritePlaylists, getUserPlaylists,
  getAllUserFavoriteTracks, getAllUserFavoriteAlbums,
  getAllUserFavoritePlaylists, getAllUserPlaylists,
  getAllAlbumItems, getAllPlaylistItems,
} from "./api.js";
import {
  parseTidalInput, downloadTrack, downloadAlbum,
  downloadPlaylist, downloadMix, downloadArtistAlbums,
} from "./download.js";
import {
  getTheme, getAccentColor, getTrackQuality, setTrackQuality, getAdvancedMode,
  loadSearchHistory, saveToSearchHistory, clearSearchHistory,
} from "./config.js";
import {
  applyTheme, applyAccentColor, cycleTheme,
  initThemeUI, initAccentColorUI,
  initTemplateBuilders, loadSettingsForm, saveSettingsForm,
  initBrowserChrome,
} from "./settings.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const QUALITY_LABELS = {
  LOW: "Low", HIGH: "High", LOSSLESS: "HiFi", HI_RES_LOSSLESS: "Max",
};

/**
 * File extensions that are binary formats where reading as UTF-8 text is
 * unreliable and Tidal URL extraction will likely fail.
 *  - .doc / .docx / .odt: ZIP-compressed XML — content is not readable as text
 *  - .pdf: binary object-stream format — text may be partially readable but not guaranteed
 */
const BINARY_OFFICE_EXTS = new Set(["doc", "docx", "odt", "pdf"]);

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

function coverUrl(hash, size = 320) {
  return hash
    ? `https://resources.tidal.com/images/${hash.replace(/-/g, "/")}/${size}x${size}.jpg`
    : "";
}

/**
 * Extract candidate Tidal resource tokens from arbitrary file text.
 *
 * Strategy:
 *  1. Strip RTF control sequences so URLs inside .rtf are exposed as plain text.
 *  2. Find all full Tidal HTTPS URLs via regex — handles JSON values, HTML href
 *     attributes, YAML strings, XML content, Markdown links, etc.
 *  3. Find short resource IDs (e.g. "track/103805726") anywhere in the text.
 *  4. If neither regex found anything (truly plain-text files that may use bare
 *     numbers or non-URL forms), fall back to per-line parsing — but only accept
 *     lines that already look like a URL, a short ID, or a bare numeric track ID
 *     to avoid flooding the activity log with warnings for every non-URL line.
 *
 * @param {string} rawText  UTF-8 decoded file content
 * @param {string} ext      Lowercase file extension without the dot
 * @returns {string[]}      Deduplicated list of candidate token strings
 */
function extractTidalTokens(rawText, ext) {
  let text = rawText;

  // RTF: strip backslash control words, hex escapes, and braces to expose plain text
  if (ext === "rtf") {
    text = text
      .replace(/\\[a-z*]+-?\d*\s?/gi, " ")  // control words like \rtf1, \fonttbl (allow any whitespace separator)
      .replace(/\\'[0-9a-f]{2}/gi, "")       // hex character escapes like \'e9
      .replace(/[{}\\]/g, " ");              // braces and remaining backslashes
  }

  const tokens = new Set();

  // ── 1. Full Tidal HTTPS URLs ────────────────────────────────────────────────
  // Matches https://tidal.com/..., https://listen.tidal.com/..., etc.
  // Exclude braces so JSON object boundaries don't get consumed into the URL.
  const tidalUrlRe = /https?:\/\/(?:[a-z0-9-]+\.)*tidal\.com\/[^\s"'<>&,;)\]\\{}]+/gi;
  for (const m of text.matchAll(tidalUrlRe)) {
    const url = m[0].replace(/[.,;)>\]'"\\}]+$/, "").trim();
    if (url) tokens.add(url);
  }

  // ── 2. Short resource IDs ───────────────────────────────────────────────────
  // Matches track/123, album/abc-uuid, playlist/uuid, mix/id, video/id, artist/id.
  // Upper bound of 80 chars covers the longest expected Tidal IDs (playlist UUIDs
  // are 36 chars; using 80 gives headroom without matching unrelated path segments).
  const shortIdRe = /\b(track|album|playlist|mix|video|artist)\/([a-zA-Z0-9_-]{2,80})\b/gi;
  for (const m of text.matchAll(shortIdRe)) {
    tokens.add(`${m[1].toLowerCase()}/${m[2]}`);
  }

  // ── 3. Line-by-line fallback (plain .txt / .csv / etc.) ─────────────────────
  // Only runs when neither regex found anything, and only accepts lines that
  // look like a Tidal URL, a short resource ID, or a bare numeric track ID.
  // Lines longer than 500 characters are skipped — legitimate Tidal URLs and
  // resource IDs are always shorter; very long lines indicate non-URL content.
  if (tokens.size === 0) {
    for (const raw of text.split(/[\n\r,\t;|]+/)) {
      const line = raw.trim().replace(/^["'`([\]{}<>]+|["'`)\]}>.,;\\]+$/g, "").trim();
      if (!line || line.length > 500) continue;
      if (
        line.startsWith("http")                                           ||
        /^(track|album|playlist|mix|video|artist)\//i.test(line)        ||
        /^\d{4,12}$/.test(line)   // bare numeric track ID
      ) {
        tokens.add(line);
      }
    }
  }

  return [...tokens];
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

// ─── Download status panel tabs ───────────────────────────────────────────────

function switchDlTab(tab) {
  const progressView = $("dl-progress-view");
  const logView      = $("dl-log-view");
  const progressBtn  = $("dl-tab-progress-btn");
  const logBtn       = $("dl-tab-log-btn");
  const clearLogBtn  = $("btn-clear-log");
  if (tab === "log") {
    progressView?.classList.add("hidden");
    logView?.classList.remove("hidden");
    progressBtn?.classList.remove("active");
    logBtn?.classList.add("active");
    clearLogBtn?.classList.remove("hidden");
    logBtn?.setAttribute("aria-selected", "true");
    progressBtn?.setAttribute("aria-selected", "false");
  } else {
    logView?.classList.add("hidden");
    progressView?.classList.remove("hidden");
    logBtn?.classList.remove("active");
    progressBtn?.classList.add("active");
    clearLogBtn?.classList.add("hidden");
    progressBtn?.setAttribute("aria-selected", "true");
    logBtn?.setAttribute("aria-selected", "false");
  }
}

// ─── Per-item progress list ───────────────────────────────────────────────────

function buildProgressList(items) {
  const list = $("dl-item-progress-list");
  if (!list) return;
  list.innerHTML = items.map((item, idx) => {
    const thumbHtml = item.cover
      ? `<img src="${escHtml(item.cover)}" alt="" class="dl-item-thumb${item.coverRound ? " round" : ""}" loading="lazy" />`
      : `<div class="dl-item-thumb${item.coverRound ? " round" : ""}"></div>`;
    const isMulti = ["album", "playlist", "mix", "artist"].includes(item.type);
    const expandBtn = isMulti
      ? `<button class="dl-item-expand-btn" data-expand-idx="${idx}" aria-label="Toggle download progress details" aria-expanded="false" title="Expand to see individual track progress">
           <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
         </button>`
      : "";
    return `<div class="dl-item-row dl-item-row--pending" id="dl-item-row-${idx}">
      ${thumbHtml}
      <div class="dl-item-details">
        <div class="dl-item-title">${escHtml(item.title)}</div>
        <div class="dl-item-msg" id="dl-item-msg-${idx}">Waiting\u2026</div>
        <div class="dl-item-bar-track"><div class="dl-item-bar-fill" id="dl-item-bar-${idx}" style="width:0%"></div></div>
      </div>
      ${expandBtn}
      <span class="dl-item-icon" id="dl-item-icon-${idx}"></span>
    </div>
    <div class="dl-item-sub-list hidden" id="dl-item-sub-${idx}"></div>`;
  }).join("");

  // Use event delegation on the list container to avoid per-button listeners
  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".dl-item-expand-btn");
    if (!btn) return;
    const idx = btn.dataset.expandIdx;
    const subList = $(`dl-item-sub-${idx}`);
    if (!subList) return;
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!expanded));
    btn.classList.toggle("expanded", !expanded);
    subList.classList.toggle("hidden", expanded);
  });
}

// ─── Per-item sub-progress rows ───────────────────────────────────────────────

function upsertSubItemRow(rowIdx, subIdx, title, done, total, status) {
  const subList = $(`dl-item-sub-${rowIdx}`);
  if (!subList) return;

  let subRow = $(`dl-sub-item-${rowIdx}-${subIdx}`);
  if (!subRow) {
    subRow = document.createElement("div");
    subRow.id = `dl-sub-item-${rowIdx}-${subIdx}`;
    subRow.className = "dl-sub-item dl-sub-item--active";
    subRow.innerHTML = `
      <div class="dl-sub-item-details">
        <div class="dl-sub-item-title" id="dl-sub-item-title-${rowIdx}-${subIdx}">${escHtml(title)}</div>
        <div class="dl-sub-item-bar-track">
          <div class="dl-sub-item-bar-fill" id="dl-sub-item-bar-${rowIdx}-${subIdx}" style="width:0%"></div>
        </div>
      </div>
      <span class="dl-sub-item-icon" id="dl-sub-item-icon-${rowIdx}-${subIdx}"></span>
    `;
    subList.appendChild(subRow);
  }

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const barEl   = $(`dl-sub-item-bar-${rowIdx}-${subIdx}`);
  const iconEl  = $(`dl-sub-item-icon-${rowIdx}-${subIdx}`);
  const titleEl = $(`dl-sub-item-title-${rowIdx}-${subIdx}`);

  if (barEl)   barEl.style.width = `${pct}%`;
  if (titleEl) titleEl.textContent = title;
  subRow.className = `dl-sub-item dl-sub-item--${status}`;
  if (iconEl) {
    iconEl.textContent = status === "done" ? "\u2713" : status === "failed" ? "\u2717" : "";
  }
}

// ─── Nav ─────────────────────────────────────────────────────────────────────

let _detailOriginTab = "search";

function activateTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.tab === tabId)
  );
  document.querySelectorAll(".tab-panel").forEach((panel) =>
    panel.classList.toggle("hidden", panel.id !== `panel-${tabId}`)
  );
}

function openDetailPanel(fromTab) {
  _detailOriginTab = fromTab || "search";
  // Show detail panel without changing sidebar active state
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("hidden", p.id !== "panel-detail")
  );
  // Keep origin tab highlighted
  document.querySelectorAll(".tab-btn").forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.tab === _detailOriginTab)
  );
  const lbl = $("btn-detail-back-label");
  if (lbl) {
    const names = { search: "Search results", library: "Library" };
    lbl.textContent = names[_detailOriginTab] || "Back";
  }
}

function backFromDetail() {
  activateTab(_detailOriginTab);
}

// ─── Auth UI ─────────────────────────────────────────────────────────────────

function updateAuthBadge() {
  const badge = $("auth-badge");
  const logoutBtn = $("btn-logout");
  const loggedInView = $("auth-logged-in");
  const loginView = $("auth-login-view");
  if (!badge) return;
  if (isLoggedIn()) {
    const auth = loadAuth();
    const username = auth?.username || "Logged in";
    badge.textContent = username;
    badge.className = "auth-badge auth-badge--in";
    show(logoutBtn);
    // Show logged-in view on Account tab
    if (loggedInView) {
      show(loggedInView);
      const nameEl = $("auth-account-username");
      if (nameEl) nameEl.textContent = username;
    }
    if (loginView) hide(loginView);
  } else {
    badge.textContent = "Not logged in";
    badge.className = "auth-badge auth-badge--out";
    hide(logoutBtn);
    if (loggedInView) hide(loggedInView);
    if (loginView) show(loginView);
  }
}

let pollTimer = null;

async function startLogin() {
  const loginBtn = $("btn-login");
  const loginStatus = $("login-status");
  loginBtn.disabled = true;
  setHtml(loginStatus, '<span class="spinner"></span> Requesting device code\u2026');

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
        setHtml(loginStatus, '<span class="success">\u2713 Logged in successfully!</span>');
        loginBtn.disabled = false;
        updateAuthBadge();
        sessionStorage.setItem("tiddl_session_welcome", "1");
        setTimeout(() => {
          activateTab("library");
          loadLibraryIfNeeded();
        }, LOGIN_SUCCESS_REDIRECT_DELAY_MS);
      } catch (err) {
        if (err?.status === 400 && err?.error === "authorization_pending") {
          const secsLeft = Math.max(0, Math.round((endAt - Date.now()) / 1000));
          const mins = Math.floor(secsLeft / 60);
          const secs = secsLeft % 60;
          setHtml(loginStatus,
            `<p>Waiting for approval\u2026 <span class="countdown">${mins}:${String(secs).padStart(2, "0")}</span></p>
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

// ─── Quality ─────────────────────────────────────────────────────────────────

function getSelectedQuality() {
  return $("quality-select")?.value || "HIGH";
}

function syncQualityPicker() {
  const select = $("quality-select");
  if (!select) return;
  select.value = getTrackQuality();
}

function initQualityPicker() {
  const select = $("quality-select");
  if (!select) return;

  select.value = getTrackQuality();

  select.addEventListener("change", () => {
    const q = select.value;
    setTrackQuality(q);
    const advanced = getAdvancedMode();
    if (advanced && downloadQueue.length > 0) {
      if (confirm(`Apply "${QUALITY_LABELS[q]}" quality to all ${downloadQueue.length} item(s) in queue?`)) {
        downloadQueue.forEach((item) => { item.quality = q; });
        renderQueue();
      }
    } else {
      // Normal mode: quality is read dynamically from the select for all items
      renderQueue();
    }
  });
}

// ─── Download queue ───────────────────────────────────────────────────────────

const downloadQueue = [];

function renderQueue() {
  const queueEl = $("download-queue");
  const section = $("download-queue-section");
  const countEl = $("queue-count");
  if (!queueEl) return;

  if (downloadQueue.length === 0) {
    hide(section);
    queueEl.innerHTML = "";
    updateSearchQueueBanner();
    return;
  }

  show(section);
  if (countEl) countEl.textContent = String(downloadQueue.length);

  const advanced = getAdvancedMode();

  queueEl.innerHTML = downloadQueue.map((item, idx) => {
    const thumbHtml = item.cover
      ? `<img src="${escHtml(item.cover)}" alt="" class="queue-item-thumb${item.coverRound ? " round" : ""}" loading="lazy" />`
      : `<div class="queue-item-thumb${item.coverRound ? " round" : ""}"></div>`;

    const q = item.quality || getSelectedQuality();
    const qualityHtml = advanced
      ? `<select class="queue-item-quality-sel" data-idx="${idx}" data-quality="${escHtml(q)}" aria-label="Quality for this item">
           ${["LOW","HIGH","LOSSLESS","HI_RES_LOSSLESS"].map(v =>
             `<option value="${v}"${v === q ? " selected" : ""}>${escHtml(QUALITY_LABELS[v])}</option>`
           ).join("")}
         </select>`
      : `<span class="quality-pill-sm" data-quality="${escHtml(q)}">${escHtml(QUALITY_LABELS[q] || q)}</span>`;

    return `<div class="queue-item" data-idx="${idx}">
      ${thumbHtml}
      <div class="queue-item-info">
        <div class="queue-item-title">${escHtml(item.title)}</div>
        <div class="queue-item-sub">${escHtml(item.sub)}</div>
      </div>
      <span class="queue-item-badge" data-type="${escHtml(item.type)}">${escHtml(item.type)}</span>
      ${qualityHtml}
      <span class="queue-item-status" id="queue-status-${idx}"></span>
      <button class="queue-remove-btn" data-idx="${idx}" title="Remove" aria-label="Remove">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
  }).join("");

  queueEl.querySelectorAll(".queue-remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromQueue(parseInt(btn.dataset.idx, 10));
    });
  });

  if (advanced) {
    queueEl.querySelectorAll(".queue-item-quality-sel").forEach((sel) => {
      sel.addEventListener("change", () => {
        const idx = parseInt(sel.dataset.idx, 10);
        if (downloadQueue[idx]) {
          downloadQueue[idx].quality = sel.value;
          sel.dataset.quality = sel.value;
        }
      });
    });
  }

  updateSearchQueueBanner();
}

function addToQueue(item) {
  const exists = downloadQueue.some(
    (q) => q.type === item.type && String(q.id) === String(item.id)
  );
  if (exists) return false;
  // In advanced mode, set quality on the item so it can be overridden per-item.
  // In normal mode, leave quality unset so the global selector always applies.
  if (getAdvancedMode()) {
    item.quality = item.quality || getSelectedQuality();
  } else {
    item.quality = undefined;
  }
  downloadQueue.push(item);
  renderQueue();
  return true;
}

function removeFromQueue(idx) {
  const item = downloadQueue[idx];
  downloadQueue.splice(idx, 1);
  renderQueue();

  if (item) {
    // Remove URL pill if it came from URL input
    if (item.fromUrl) {
      document.querySelectorAll(`.url-pill[data-type="${item.type}"][data-id="${item.id}"]`)
        .forEach((p) => p.remove());
    }
    // Deselect search result cards
    document.querySelectorAll(`.result-card[data-type="${item.type}"][data-id="${item.id}"]`)
      .forEach((c) => { c.classList.remove("selected"); c.setAttribute("aria-pressed", "false"); });
    // Deselect detail track items
    document.querySelectorAll(`.detail-track-item[data-id="${item.id}"]`)
      .forEach((c) => c.classList.remove("selected"));
    // Deselect library track items
    document.querySelectorAll(`.library-track-item[data-id="${item.id}"]`)
      .forEach((c) => c.classList.remove("selected"));
  }
}

function clearQueue() {
  downloadQueue.length = 0;
  document.querySelectorAll(".result-card.selected").forEach((c) => {
    c.classList.remove("selected"); c.setAttribute("aria-pressed", "false");
  });
  document.querySelectorAll(".url-pill").forEach((p) => p.remove());
  document.querySelectorAll(".detail-track-item.selected,.library-track-item.selected")
    .forEach((c) => c.classList.remove("selected"));
  renderQueue();
}

// ─── Search queue banner ──────────────────────────────────────────────────────

function updateSearchQueueBanner() {
  const banner = $("search-queue-banner");
  const txt    = $("search-queue-banner-text");
  if (!banner) return;
  const n = downloadQueue.length;
  if (n > 0) {
    if (txt) txt.textContent = `${n} item${n === 1 ? "" : "s"} in queue`;
    show(banner);
  } else {
    hide(banner);
  }
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function setProgress(done, total, message) {
  const bar   = $("progress-bar");
  const label = $("progress-label");
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  if (bar)   bar.style.width = `${pct}%`;
  if (label) label.textContent = message || `${pct}%`;
}

// ─── Download ─────────────────────────────────────────────────────────────────

async function handleDownload() {
  if (!isLoggedIn()) {
    appendLog("You must be logged in to download.", "error");
    activateTab("auth");
    return;
  }

  // Flush any half-typed pill input
  const pilInput = $("url-pill-input");
  if (pilInput?.value?.trim()) {
    addUrlPill(pilInput.value.trim());
    pilInput.value = "";
  }

  const items = [...downloadQueue];
  if (items.length === 0) {
    appendLog("Add URLs or select items from Search to build your download queue.", "warn");
    return;
  }

  const globalQuality = getSelectedQuality();
  const advanced      = getAdvancedMode();
  const downloadBtn   = $("btn-download");
  downloadBtn.disabled = true;
  clearLog();
  switchDlTab("progress");
  buildProgressList(items);
  setProgress(0, items.length, "Starting\u2026");

  let totalDone = 0, totalOk = 0, totalFail = 0;

  for (let qi = 0; qi < items.length; qi++) {
    const item         = items[qi];
    const quality      = advanced ? (item.quality || globalQuality) : globalQuality;
    const qStatusEl    = $(`queue-status-${qi}`);
    const queueItemEl  = $("download-queue")?.querySelector(`.queue-item[data-idx="${qi}"]`);
    const itemRowEl    = $(`dl-item-row-${qi}`);
    const itemMsgEl    = $(`dl-item-msg-${qi}`);
    const itemBarEl    = $(`dl-item-bar-${qi}`);
    const itemIconEl   = $(`dl-item-icon-${qi}`);

    if (queueItemEl) queueItemEl.classList.add("q-downloading");
    if (itemRowEl) {
      itemRowEl.classList.remove("dl-item-row--pending");
      itemRowEl.classList.add("dl-item-row--active");
    }

    appendLog(`Downloading ${item.type}/${item.id} @ ${QUALITY_LABELS[quality] || quality}`, "info");
    if (qStatusEl)  qStatusEl.textContent  = "\u23f3";
    if (itemIconEl) itemIconEl.textContent = "\u23f3";

    const onProgress = (done, total, msg) => {
      setProgress(qi, items.length, msg || `Item ${qi + 1}/${items.length}`);
      if (msg) appendLog(msg, "info");
      if (itemBarEl && total > 0) itemBarEl.style.width = `${Math.round((done / total) * 100)}%`;
      if (itemMsgEl && msg) itemMsgEl.textContent = msg;
    };

    const isMulti = ["album", "playlist", "mix", "artist"].includes(item.type);
    const onSubItemProgress = isMulti
      ? (subIdx, subTotal, title, done, total, status) => {
          upsertSubItemRow(qi, subIdx, title, done, total, status);
        }
      : undefined;

    try {
      let results = [];
      switch (item.type) {
        case "track":    results = [await downloadTrack(item.id, quality, onProgress)]; break;
        case "album":    results = await downloadAlbum(item.id, quality, onProgress, onSubItemProgress); break;
        case "playlist": results = await downloadPlaylist(item.id, quality, onProgress, onSubItemProgress); break;
        case "mix":      results = await downloadMix(item.id, quality, onProgress, onSubItemProgress); break;
        case "artist":   results = await downloadArtistAlbums(item.id, quality, onProgress, onSubItemProgress); break;
        default:
          appendLog(`Resource type "${item.type}" not yet supported in the browser.`, "warn");
          results = [{ filename: String(item.id), success: false, error: "unsupported type" }];
      }
      for (const r of results) {
        if (r.success) { appendLog(`\u2713 Saved: ${r.filename}`, "success"); totalOk++; }
        else           { appendLog(`\u2717 Failed: ${r.filename} \u2014 ${r.error}`, "error"); totalFail++; }
      }
      const allOk = results.every((r) => r.success);
      if (qStatusEl)  qStatusEl.textContent  = allOk ? "\u2713" : "\u2717";
      if (itemIconEl) itemIconEl.textContent = allOk ? "\u2713" : "\u2717";
      if (itemBarEl)  itemBarEl.style.width  = "100%";
      if (itemMsgEl)  itemMsgEl.textContent  = allOk ? "Done" : `Failed \u2014 ${results.filter(r => !r.success).map(r => r.error).join(", ")}`;
      if (itemRowEl) {
        itemRowEl.classList.remove("dl-item-row--active");
        itemRowEl.classList.add(allOk ? "dl-item-row--done" : "dl-item-row--failed");
      }
      if (queueItemEl) {
        queueItemEl.classList.remove("q-downloading");
        queueItemEl.classList.add(allOk ? "q-done" : "q-failed");
      }
      // Auto-remove successful items from queue after a brief delay.
      // Uses indexOf to find the item by reference; if it was already
      // removed by the user in the meantime indexOf returns -1 and we
      // skip the removal safely.
      if (allOk) {
        const itemRef = item;
        setTimeout(() => {
          const idx = downloadQueue.indexOf(itemRef);
          if (idx !== -1) removeFromQueue(idx);
        }, 1500);
      }
    } catch (err) {
      appendLog(`Error (${item.type}/${item.id}): ${err.message}`, "error");
      if (qStatusEl)  qStatusEl.textContent  = "\u2717";
      if (itemIconEl) itemIconEl.textContent = "\u2717";
      if (itemBarEl)  itemBarEl.style.width  = "100%";
      if (itemMsgEl)  itemMsgEl.textContent  = `Error: ${err.message}`;
      if (itemRowEl) { itemRowEl.classList.remove("dl-item-row--active"); itemRowEl.classList.add("dl-item-row--failed"); }
      if (queueItemEl) { queueItemEl.classList.remove("q-downloading"); queueItemEl.classList.add("q-failed"); }
      totalFail++;
    }
    totalDone++;
    setProgress(totalDone, items.length, `${totalDone}/${items.length} done`);
  }

  setProgress(items.length, items.length,
    totalFail === 0 ? "Done \u2713" : `Done \u2014 ${totalOk} ok, ${totalFail} failed`);
  downloadBtn.disabled = false;
}

// ─── URL pill input ───────────────────────────────────────────────────────────

function addUrlPill(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return false;

  const resource = parseTidalInput(trimmed);
  const isValid  = !!resource;
  const label    = resource ? `${resource.type}/${resource.id}` : trimmed;

  if (isValid) {
    const added = addToQueue({
      type: resource.type, id: resource.id,
      title: label, sub: trimmed !== label ? trimmed : "",
      cover: "", coverRound: false, fromUrl: true,
    });
    if (!added) return false; // duplicate
    enrichQueueItemFromUrl(resource.type, resource.id);
  }

  const pillBox = $("url-pill-box");
  const input   = $("url-pill-input");
  const pill    = document.createElement("span");
  pill.className = `url-pill${isValid ? "" : " invalid"}`;
  pill.dataset.type = resource?.type || "";
  pill.dataset.id   = resource?.id   || "";
  pill.setAttribute("role", "listitem");
  pill.innerHTML = `<span class="url-pill-label" title="${escHtml(trimmed)}">${escHtml(label)}</span>
    <button class="url-pill-remove" aria-label="Remove ${escHtml(label)}">
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;

  pill.querySelector(".url-pill-remove").addEventListener("click", () => {
    if (isValid && resource) {
      const idx = downloadQueue.findIndex(
        (q) => q.type === resource.type && String(q.id) === String(resource.id)
      );
      if (idx !== -1) removeFromQueue(idx);
    }
    pill.remove();
  });

  pillBox.insertBefore(pill, input);

  if (!isValid) {
    appendLog(`Could not parse "${trimmed}" as a Tidal URL.`, "warn");
  }
  return isValid;
}

/**
 * After adding a URL-based queue item, asynchronously fetch its real metadata
 * (title, artist, cover) from the API and update the queue display.
 */
async function enrichQueueItemFromUrl(type, id) {
  if (!isLoggedIn()) return;
  try {
    let title = "", sub = "", cover = "";
    if (type === "track") {
      const data = await getTrack(id);
      title = data.title || "";
      sub   = data.artist?.name || "";
      cover = coverUrl(data.album?.cover);
    } else if (type === "album") {
      const data = await getAlbum(id);
      title = data.title || "";
      sub   = data.artist?.name || "";
      cover = coverUrl(data.cover);
    } else if (type === "playlist") {
      const data = await getPlaylist(id);
      title = data.title || "";
      sub   = data.creator?.name || "Tidal";
      cover = coverUrl(data.image || data.squareImage);
    } else {
      return; // artist / mix / video — no enrichment needed here
    }
    if (!title) return;
    const item = downloadQueue.find(
      (q) => q.type === type && String(q.id) === String(id) && q.fromUrl
    );
    if (item) {
      item.title = title;
      item.sub   = sub;
      item.cover = cover;
      renderQueue();
    }
  } catch {
    // Silently fail — the URL/ID placeholder remains visible
  }
}

function initUrlPillInput() {
  const input   = $("url-pill-input");
  const pillBox = $("url-pill-box");
  if (!input || !pillBox) return;

  pillBox.addEventListener("click", (e) => {
    if (!e.target.closest(".url-pill")) input.focus();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = input.value.trim();
      if (val) { addUrlPill(val); input.value = ""; }
    } else if (e.key === "Backspace" && !input.value) {
      const pills = pillBox.querySelectorAll(".url-pill");
      if (pills.length) {
        const last = pills[pills.length - 1];
        const type = last.dataset.type;
        const id   = last.dataset.id;
        if (type && id) {
          const idx = downloadQueue.findIndex(
            (q) => q.type === type && String(q.id) === String(id)
          );
          if (idx !== -1) removeFromQueue(idx);
        }
        last.remove();
      }
    }
  });

  input.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text");
    if (!text) return;
    const lines = text.split(/[\n\r,]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      e.preventDefault();
      lines.forEach((line) => addUrlPill(line));
      input.value = "";
    }
  });

  // File import
  const fileInput  = $("url-file-input");
  const importBtn  = $("btn-import-file");
  importBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const reader = new FileReader();
    reader.onerror = () => {
      appendLog(`Could not read "${escHtml(file.name)}".`, "error");
      fileInput.value = "";
    };
    reader.onload = (ev) => {
      const text = ev.target.result || "";
      const tokens = extractTidalTokens(text, ext);
      let added = 0;
      tokens.forEach((token) => { if (addUrlPill(token)) added++; });
      if (added > 0) {
        appendLog(`Imported ${added} URL(s) from "${escHtml(file.name)}".`, "info");
      } else if (BINARY_OFFICE_EXTS.has(ext)) {
        appendLog(
          `No Tidal URLs found in "${escHtml(file.name)}". ` +
          `.${ext} is a binary format — text extraction may be unreliable. ` +
          `Try saving the file as plain text (.txt) first and import again.`,
          "warn"
        );
      } else {
        appendLog(`No Tidal URLs found in "${escHtml(file.name)}".`, "warn");
      }
      fileInput.value = "";
    };
    reader.readAsText(file, "utf-8");
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────

let lastSearchData = null;
let activeTypeFilter = "all";
const INITIAL_LIMIT = 8;

function updateSearchClearBtn() {
  const input = $("search-input");
  const btn   = $("btn-clear-search");
  if (!btn || !input) return;
  btn.classList.toggle("hidden", !input.value);
}

function showSearchHistory() {
  const history = loadSearchHistory();
  const histEl  = $("search-history");
  const listEl  = $("search-history-list");
  if (!histEl || !listEl) return;
  if (!history.length) { hide(histEl); return; }

  listEl.innerHTML = history.map((q) =>
    `<button class="search-history-item" data-query="${escHtml(q)}">
       <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
       ${escHtml(q)}
     </button>`
  ).join("");

  listEl.querySelectorAll(".search-history-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $("search-input");
      if (input) input.value = btn.dataset.query;
      updateSearchClearBtn();
      hide(histEl);
      handleSearch();
    });
  });
  show(histEl);
}

function buildResultCard(resourceType, id, title, sub, cover, round) {
  const inQueue = downloadQueue.some(
    (q) => q.type === resourceType && String(q.id) === String(id)
  );
  const isTrack = resourceType === "track";

  const imgHtml = cover
    ? `<img src="${escHtml(cover)}" alt="" class="result-cover${round ? " round" : ""}" loading="lazy" />`
    : `<div class="result-cover placeholder${round ? " round" : ""}"></div>`;

  const overlayHtml = isTrack
    ? `<div class="result-card-overlay">
         <span class="result-card-check">
           <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
         </span>
       </div>`
    : `<div class="result-card-overlay">
         <span class="result-card-nav-icon">
           <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M5 12h14m-7-7 7 7-7 7"/></svg>
         </span>
         <button class="card-queue-btn${inQueue ? " in-queue" : ""}" data-quick-add="true" title="Add to queue" aria-label="Add to queue">
           ${inQueue
             ? `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`
             : `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
           }
         </button>
       </div>`;

  return `<div class="result-card${inQueue ? " selected" : ""}${isTrack ? "" : " result-card--nav"}"
       data-type="${escHtml(resourceType)}" data-id="${escHtml(String(id))}"
       data-title="${escHtml(title)}" data-sub="${escHtml(sub)}"
       data-cover="${escHtml(cover)}" data-round="${round}"
       tabindex="0" role="button" aria-pressed="${inQueue}">
    <div class="result-card-img-wrap">${imgHtml}${overlayHtml}</div>
    <div class="result-info">
      <span class="result-title">${escHtml(title)}</span>
      <span class="result-sub">${escHtml(sub)}</span>
    </div>
  </div>`;
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
    html += buildResultCard(resourceType, id, title, sub, cover, round);
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

/**
 * Build a horizontally-scrollable single-row section for a set of items.
 * Used in "From your library" suggestions and artist detail panels.
 * @param {Array}  items       - Array of Tidal resource objects
 * @param {string} type        - "tracks" | "albums" | "artists" | "playlists"
 * @param {string} heading     - Display heading text
 * @param {string} viewAllKey  - Unique key written to data-viewall on the button
 */
function buildResultRowSection(items, type, heading, viewAllKey) {
  if (!items.length) return "";
  let cardsHtml = "";
  for (const item of items) {
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
    cardsHtml += buildResultCard(resourceType, id, title, sub, cover, round);
  }
  return `<div class="result-row-section">
    <div class="result-row-header">
      <h3 class="result-heading">${escHtml(heading)}</h3>
      <button class="btn-view-all" data-viewall="${escHtml(viewAllKey)}">View all</button>
    </div>
    <div class="result-row">${cardsHtml}</div>
  </div>`;
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
  const showType = (t) => filter === "all" || filter === t;
  if (showType("tracks"))    html += buildResultGrid(tracks,    "tracks",    INITIAL_LIMIT, tracks.length);
  if (showType("albums"))    html += buildResultGrid(albums,    "albums",    INITIAL_LIMIT, albums.length);
  if (showType("artists"))   html += buildResultGrid(artists,   "artists",   INITIAL_LIMIT, artists.length);
  if (showType("playlists")) html += buildResultGrid(playlists, "playlists", INITIAL_LIMIT, playlists.length);

  container.innerHTML = html || '<p class="no-results">No results for this category.</p>';
  attachResultHandlers(container);
}

function attachResultHandlers(container) {
  container.querySelectorAll(".result-card").forEach((card) => {
    const isTrack = card.dataset.type === "track";
    if (isTrack) {
      card.addEventListener("click", () => toggleResultInQueue(card));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleResultInQueue(card); }
      });
    } else {
      // Main card click -> detail
      card.addEventListener("click", (e) => {
        if (e.target.closest(".card-queue-btn")) return;
        navigateToDetail(card.dataset.type, card.dataset.id,
          card.dataset.title, card.dataset.sub, card.dataset.cover, "search");
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          navigateToDetail(card.dataset.type, card.dataset.id,
            card.dataset.title, card.dataset.sub, card.dataset.cover, "search");
        }
      });
      // Quick-add button
      const qaBtn = card.querySelector(".card-queue-btn");
      if (qaBtn) {
        qaBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleResultInQueue(card);
        });
      }
    }
  });

  container.querySelectorAll(".btn-view-more").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type     = btn.dataset.type;
      const shown    = parseInt(btn.dataset.shown, 10);
      const items    = lastSearchData?.[type]?.items || [];
      const newShown = shown + INITIAL_LIMIT;
      const sectionEl = container.querySelector(`.result-section[data-section="${type}"]`);
      if (sectionEl) {
        const tmp = document.createElement("div");
        tmp.innerHTML = buildResultGrid(items, type, newShown, items.length);
        sectionEl.replaceWith(tmp.firstElementChild);
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
    removeFromQueue(existing);
  } else {
    addToQueue({ type, id, title, sub, cover, coverRound: round });
    card.classList.add("selected");
    card.setAttribute("aria-pressed", "true");
    // Update quick-add button
    const qaBtn = card.querySelector(".card-queue-btn");
    if (qaBtn) {
      qaBtn.classList.add("in-queue");
      qaBtn.innerHTML = `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
    }
    appendLog(`Added to queue: ${type}/${id} \u2014 "${title}"`, "info");
    if (type === "track") activateTab("download");
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

  saveToSearchHistory(query);
  hide($("search-history"));

  const searchBtn  = $("btn-search");
  searchBtn.disabled = true;
  const container = $("search-results");
  if (container) container.innerHTML = '<p class="searching"><span class="spinner"></span> Searching\u2026</p>';

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

async function showSearchSuggestions() {
  if (!isLoggedIn()) return;
  const container = $("search-results");
  if (!container || container.children.length) return; // already has content

  container.innerHTML = '<p class="searching"><span class="spinner"></span> Loading your library\u2026</p>';
  try {
    const [tracksData, albumsData] = await Promise.all([
      getUserFavoriteTracks(8, 0).catch(() => ({ items: [] })),
      getUserFavoriteAlbums(8, 0).catch(() => ({ items: [] })),
    ]);
    const tracks    = (tracksData.items  || []).map((i) => i.item || i);
    const albums    = (albumsData.items  || []).map((i) => i.item || i);
    if (!tracks.length && !albums.length) {
      container.innerHTML = '<p class="no-results">Search for tracks, albums, artists or playlists above.</p>';
      return;
    }
    let html = '<h3 class="result-heading" style="margin-top:0">From your library</h3>';
    if (tracks.length) html += buildResultRowSection(tracks, "tracks", "Tracks", "lib-tracks");
    if (albums.length) html += buildResultRowSection(albums, "albums", "Albums", "lib-albums");
    container.innerHTML = html;
    attachResultHandlers(container);
    // "View all" navigates to the Library tab with the matching section
    const goToLibrarySection = (section) => {
      _librarySection = section;
      document.querySelectorAll("#library-section-pills .type-pill").forEach((p) =>
        p.classList.toggle("active", p.dataset.section === section)
      );
      activateTab("library");
      loadLibraryIfNeeded();
    };
    container.querySelector('[data-viewall="lib-tracks"]')?.addEventListener("click", () => goToLibrarySection("tracks"));
    container.querySelector('[data-viewall="lib-albums"]')?.addEventListener("click", () => goToLibrarySection("albums"));
  } catch {
    container.innerHTML = '<p class="no-results">Search for tracks, albums, artists or playlists above.</p>';
  }
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

async function navigateToDetail(type, id, title, sub, cover, fromTab) {
  openDetailPanel(fromTab);

  const header = $("detail-header");
  const body   = $("detail-body");
  const round  = type === "artist";
  const inQueue = downloadQueue.some((q) => q.type === type && String(q.id) === String(id));

  const typeLabel  = { album: "Album", artist: "Artist", playlist: "Playlist", mix: "Mix" }[type] || type;
  const largerCover = cover.replace(/320x320/, "640x640");

  header.innerHTML = `
    <div class="detail-cover-wrap">
      ${largerCover
        ? `<img src="${escHtml(largerCover)}" alt="" class="detail-cover${round ? " round" : ""}" loading="lazy"/>`
        : `<div class="detail-cover placeholder${round ? " round" : ""}"></div>`}
    </div>
    <div class="detail-header-info">
      <span class="detail-type-badge">${escHtml(typeLabel)}</span>
      <h2 class="detail-title">${escHtml(title)}</h2>
      <p class="detail-sub" id="detail-sub">${escHtml(sub)}</p>
      <div class="detail-actions">
        <button class="btn-primary" id="btn-detail-dl-queue">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" style="margin-right:4px;vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add ${escHtml(typeLabel)} to Queue
        </button>
      </div>
    </div>`;

  header.querySelector("#btn-detail-dl-queue")?.addEventListener("click", () => {
    const added = addToQueue({ type, id, title, sub, cover, coverRound: round });
    if (added) {
      appendLog(`Added ${type}/${id} to queue.`, "info");
      activateTab("download");
    } else {
      appendLog(`${type}/${id} is already in the queue.`, "info");
    }
  });

  body.innerHTML = '<p class="searching"><span class="spinner"></span> Loading\u2026</p>';

  try {
    if (type === "artist") {
      await renderArtistDetail(id, title, body);
    } else if (type === "album") {
      await renderAlbumDetail(id, body);
    } else if (type === "playlist") {
      await renderPlaylistDetail(id, body);
    }
  } catch (err) {
    body.innerHTML = `<p class="error">Failed to load: ${escHtml(err.message)}</p>`;
  }
}

async function renderArtistDetail(artistId, artistName, body) {
  const [albumsData, singlesData] = await Promise.all([
    getArtistAlbums(artistId, 20, 0).catch(() => ({ items: [] })),
    getArtistSingles(artistId, 20, 0).catch(() => ({ items: [] })),
  ]);
  const albums  = albumsData.items  || [];
  const singles = singlesData.items || [];

  function makeAlbumCards(items) {
    return items.map((album) => {
      const c = coverUrl(album.cover);
      return buildResultCard("album", album.id, album.title, album.releaseDate?.slice(0,4) || "", c, false);
    }).join("");
  }

  function buildArtistSection(items, heading, sectionKey) {
    if (!items.length) return "";
    const cardsHtml = makeAlbumCards(items);
    return `<div class="artist-release-section" data-section="${escHtml(sectionKey)}">
      <div class="result-row-header">
        <p class="detail-section-heading" style="margin:0">${escHtml(heading)}</p>
        <button class="btn-view-all" data-viewall="${escHtml(sectionKey)}">View all (${items.length})</button>
      </div>
      <div class="result-row">${cardsHtml}</div>
      <div class="detail-album-grid hidden">${cardsHtml}</div>
    </div>`;
  }

  let html = "";
  if (albums.length)  html += buildArtistSection(albums,  "Albums",        "albums");
  if (singles.length) html += buildArtistSection(singles, "Singles & EPs",  "singles");
  if (!html)          html  = `<p class="no-results">No releases found for this artist.</p>`;

  body.innerHTML = html;

  // "View all" swaps the horizontal row for the full grid
  body.querySelectorAll(".artist-release-section .btn-view-all").forEach((btn) => {
    btn.addEventListener("click", () => {
      const section = btn.closest(".artist-release-section");
      if (!section) return;
      section.querySelector(".result-row")?.classList.add("hidden");
      section.querySelector(".detail-album-grid")?.classList.remove("hidden");
      btn.remove();
    });
  });

  attachResultHandlers(body);
}

async function renderAlbumDetail(albumId, body) {
  const [albumMeta, allItems] = await Promise.all([
    getAlbum(albumId),
    getAllAlbumItems(albumId),
  ]);
  const tracks = (allItems || []).filter((i) => i.type === "track").map((i) => i.item);

  // Make the artist name in the header a link to the artist's detail page
  const artistId   = albumMeta.artist?.id;
  const artistName = albumMeta.artist?.name || "";
  const artistCover = coverUrl(albumMeta.artist?.picture);
  const subEl = $("detail-sub");
  if (subEl && artistId) {
    subEl.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "detail-artist-link";
    btn.textContent = artistName;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigateToDetail("artist", artistId, artistName, "", artistCover, _detailOriginTab);
    });
    subEl.appendChild(btn);
  }

  body.innerHTML = `<div class="detail-tracklist">${tracks.map((t, i) => {
    const inQ = downloadQueue.some((q) => q.type === "track" && String(q.id) === String(t.id));
    const coverArt = coverUrl(albumMeta.cover);
    return `<div class="detail-track-item${inQ ? " selected" : ""}" data-id="${t.id}"
        data-title="${escHtml(t.title)}" data-artist="${escHtml(t.artist?.name || "")}"
        data-cover="${escHtml(coverArt)}" tabindex="0" role="button">
      <span class="detail-track-num">${i + 1}</span>
      <div class="detail-track-info">
        <span class="detail-track-title">${escHtml(t.title)}</span>
        <span class="detail-track-artist">${escHtml(t.artist?.name || "")}</span>
      </div>
      <button class="detail-track-add" title="Add to queue">
        ${inQ ? "\u2713 Added" : "+ Add"}
      </button>
    </div>`;
  }).join("")}</div>`;

  body.querySelectorAll(".detail-track-item").forEach((row) => {
    const onClick = () => {
      const trackId = row.dataset.id;
      const existing = downloadQueue.findIndex((q) => q.type === "track" && String(q.id) === String(trackId));
      const btn      = row.querySelector(".detail-track-add");
      if (existing !== -1) {
        removeFromQueue(existing);
        row.classList.remove("selected");
        if (btn) btn.textContent = "+ Add";
      } else {
        const coverArt = coverUrl(albumMeta.cover);
        addToQueue({ type: "track", id: trackId, title: row.dataset.title,
          sub: row.dataset.artist, cover: coverArt, coverRound: false });
        row.classList.add("selected");
        if (btn) btn.textContent = "\u2713 Added";
        appendLog(`Added track/${trackId} to queue.`, "info");
      }
    };
    row.addEventListener("click", onClick);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } });
  });
}

async function renderPlaylistDetail(playlistId, body) {
  const [plMeta, allItems] = await Promise.all([
    getPlaylist(playlistId),
    getAllPlaylistItems(playlistId),
  ]);
  const tracks = (allItems || []).filter((i) => i.type === "track").map((i) => i.item);

  body.innerHTML = `<div class="detail-tracklist">${tracks.map((t, i) => {
    const inQ = downloadQueue.some((q) => q.type === "track" && String(q.id) === String(t.id));
    const coverArt = coverUrl(t.album?.cover);
    return `<div class="detail-track-item${inQ ? " selected" : ""}" data-id="${t.id}"
        data-title="${escHtml(t.title)}" data-artist="${escHtml(t.artist?.name || "")}"
        data-cover="${escHtml(coverArt)}" tabindex="0" role="button">
      <span class="detail-track-num">${i + 1}</span>
      <div class="detail-track-info">
        <span class="detail-track-title">${escHtml(t.title)}</span>
        <span class="detail-track-artist">${escHtml(t.artist?.name || "")}</span>
      </div>
      <button class="detail-track-add" title="Add to queue">${inQ ? "\u2713 Added" : "+ Add"}</button>
    </div>`;
  }).join("")}</div>`;

  body.querySelectorAll(".detail-track-item").forEach((row) => {
    const onClick = () => {
      const trackId = row.dataset.id;
      const existing = downloadQueue.findIndex((q) => q.type === "track" && String(q.id) === String(trackId));
      const btn      = row.querySelector(".detail-track-add");
      if (existing !== -1) {
        removeFromQueue(existing);
        row.classList.remove("selected");
        if (btn) btn.textContent = "+ Add";
      } else {
        addToQueue({ type: "track", id: trackId, title: row.dataset.title,
          sub: row.dataset.artist, cover: row.dataset.cover, coverRound: false });
        row.classList.add("selected");
        if (btn) btn.textContent = "\u2713 Added";
        appendLog(`Added track/${trackId} to queue.`, "info");
      }
    };
    row.addEventListener("click", onClick);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } });
  });
}

// ─── Library panel ───────────────────────────────────────────────────────────

let _librarySection  = "tracks";
let _libraryLoaded   = { tracks: false, albums: false, playlists: false };
let _libraryData     = { tracks: [], albums: [], playlists: [] };
let _libraryFilter   = "";
let _librarySort     = "dateAdded";
let _librarySortDir  = "desc";

async function loadLibraryIfNeeded() {
  if (!isLoggedIn()) {
    $("library-content").innerHTML = '<p class="no-results">Sign in to see your library.</p>';
    return;
  }

  // Show welcome message if just logged in
  if (sessionStorage.getItem("tiddl_session_welcome")) {
    sessionStorage.removeItem("tiddl_session_welcome");
    const auth = loadAuth();
    const welcome = $("library-welcome");
    const name    = $("library-welcome-name");
    if (welcome) {
      if (name) name.textContent = `Welcome, ${auth?.username || "friend"}!`;
      show(welcome);
      setTimeout(() => hide(welcome), 5000);
    }
  }

  if (!_libraryLoaded[_librarySection]) {
    renderLibraryContent(null);
    try {
      if (_librarySection === "tracks") {
        const items = await getAllUserFavoriteTracks();
        _libraryData.tracks = items.map((i) => ({ ...(i.item || i), _dateAdded: i.dateAdded || "" }));
      } else if (_librarySection === "albums") {
        const items = await getAllUserFavoriteAlbums();
        _libraryData.albums = items.map((i) => ({ ...(i.item || i), _dateAdded: i.dateAdded || "" }));
      } else if (_librarySection === "playlists") {
        const [favItems, ownItems] = await Promise.all([
          getAllUserFavoritePlaylists().catch(() => []),
          getAllUserPlaylists().catch(() => []),
        ]);
        const favMapped = favItems.map((i) => ({ ...(i.item || i), _dateAdded: i.dateAdded || "" }));
        const ownMapped = ownItems.map((i) => ({ ...(i.item || i), _dateAdded: i.dateAdded || "" }));
        // Deduplicate by uuid
        const seen = new Set();
        _libraryData.playlists = [...ownMapped, ...favMapped].filter((p) => {
          const key = p.uuid || p.id;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
      }
      _libraryLoaded[_librarySection] = true;
      renderLibraryContent(_libraryData[_librarySection]);
    } catch (err) {
      const content = $("library-content");
      if (content) content.innerHTML = `<p class="error">Failed to load library: ${escHtml(err.message)}</p>`;
    }
  } else {
    renderLibraryContent(_libraryData[_librarySection]);
  }
}

function renderLibraryContent(items) {
  const content = $("library-content");
  if (!content) return;

  if (items === null) {
    content.innerHTML = '<p class="searching"><span class="spinner"></span> Loading\u2026</p>';
    return;
  }
  if (!items.length) {
    content.innerHTML = '<p class="no-results">Nothing here yet.</p>';
    return;
  }

  // Apply sort
  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    if (_librarySort === "title") {
      cmp = (a.title || a.name || "").localeCompare(b.title || b.name || "");
    } else if (_librarySort === "artist") {
      cmp = (a.artist?.name || a.creator?.name || "").localeCompare(b.artist?.name || b.creator?.name || "");
    } else {
      // dateAdded — compare a to b (asc = oldest first, desc = newest first)
      cmp = (a._dateAdded || "").localeCompare(b._dateAdded || "");
    }
    return _librarySortDir === "asc" ? cmp : -cmp;
  });

  // Apply filter
  const filterTerm = _libraryFilter.toLowerCase().trim();
  const filtered = filterTerm
    ? sorted.filter((item) => {
        const title = (item.title || item.name || "").toLowerCase();
        const artist = (item.artist?.name || item.creator?.name || "").toLowerCase();
        return title.includes(filterTerm) || artist.includes(filterTerm);
      })
    : sorted;

  if (!filtered.length) {
    content.innerHTML = `<p class="no-results">No results for &ldquo;${escHtml(_libraryFilter)}&rdquo;.</p>`;
    return;
  }

  if (_librarySection === "tracks") {
    content.innerHTML = `<div class="library-track-list">
      <div class="library-track-header" aria-hidden="true">
        <div class="library-track-thumb"></div>
        <div class="library-track-info library-track-header-labels">
          <span>Title / Artist</span>
        </div>
        ${_librarySort === "dateAdded" ? '<span class="library-track-date library-track-date-header">Added</span>' : ""}
        <span class="library-track-add-placeholder"></span>
      </div>
      ${filtered.map((t) => {
      const inQ = downloadQueue.some((q) => q.type === "track" && String(q.id) === String(t.id));
      const cover = coverUrl(t.album?.cover, 80);
      const dateLabel = _librarySort === "dateAdded" && t._dateAdded
        ? (t._dateAdded.length >= 10 ? t._dateAdded.slice(0, 10) : t._dateAdded)
        : "";
      return `<div class="library-track-item${inQ ? " selected" : ""}" data-id="${t.id}"
          data-title="${escHtml(t.title)}" data-artist="${escHtml(t.artist?.name || "")}"
          data-cover="${escHtml(coverUrl(t.album?.cover))}" tabindex="0" role="button">
        ${cover ? `<img src="${escHtml(cover)}" class="library-track-thumb" alt="" loading="lazy"/>` : `<div class="library-track-thumb"></div>`}
        <div class="library-track-info">
          <span class="library-track-title">${escHtml(t.title)}</span>
          <span class="library-track-artist">${escHtml(t.artist?.name || "")}</span>
        </div>
        ${dateLabel ? `<span class="library-track-date">${escHtml(dateLabel)}</span>` : ""}
        <button class="library-track-add" title="Add to queue">${inQ ? "\u2713 Added" : "+ Add"}</button>
      </div>`;
    }).join("")}</div>`;

    content.querySelectorAll(".library-track-item").forEach((row) => {
      const onClick = () => {
        const trackId = row.dataset.id;
        const existing = downloadQueue.findIndex((q) => q.type === "track" && String(q.id) === String(trackId));
        const btn      = row.querySelector(".library-track-add");
        if (existing !== -1) {
          removeFromQueue(existing);
          row.classList.remove("selected");
          if (btn) btn.textContent = "+ Add";
        } else {
          addToQueue({ type: "track", id: trackId, title: row.dataset.title,
            sub: row.dataset.artist, cover: row.dataset.cover, coverRound: false });
          row.classList.add("selected");
          if (btn) btn.textContent = "\u2713 Added";
          appendLog(`Added track/${trackId} to queue.`, "info");
        }
      };
      row.addEventListener("click", onClick);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } });
    });

  } else {
    // Albums / playlists: card grid
    const type = _librarySection === "albums" ? "album" : "playlist";
    let html = `<div class="result-grid">`;
    for (const item of filtered) {
      const id    = type === "album" ? item.id : (item.uuid || item.id);
      const title = item.title || item.name || "";
      const sub   = type === "album" ? (item.artist?.name || "") : (item.creator?.name || "Tidal");
      const cover = coverUrl(type === "album" ? item.cover : (item.image || item.squareImage));
      html += buildResultCard(type, id, title, sub, cover, false);
    }
    html += `</div>`;
    content.innerHTML = html;
    attachLibraryCardHandlers(content);
  }
}

function attachLibraryCardHandlers(container) {
  container.querySelectorAll(".result-card").forEach((card) => {
    const isTrack = card.dataset.type === "track";
    if (isTrack) {
      card.addEventListener("click", () => toggleResultInQueue(card));
    } else {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".card-queue-btn")) return;
        navigateToDetail(card.dataset.type, card.dataset.id,
          card.dataset.title, card.dataset.sub, card.dataset.cover, "library");
      });
      const qaBtn = card.querySelector(".card-queue-btn");
      if (qaBtn) qaBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleResultInQueue(card); });
    }
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function handleSaveSettings() {
  saveSettingsForm(appendLog);
  // Re-render queue in case advanced mode changed
  renderQueue();
  // Sync quality picker with saved setting (without re-attaching event listeners)
  syncQualityPicker();
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

// ─── Tooltips ─────────────────────────────────────────────────────────────────

function initTooltips() {
  const box = document.createElement("div");
  box.className = "tip-box";
  box.setAttribute("role", "tooltip");
  document.body.appendChild(box);

  function positionAndShow(el) {
    box.textContent = el.dataset.tip;
    // Measure while hidden (visibility:hidden keeps layout but hides paint)
    box.style.visibility = "hidden";
    box.classList.add("visible");
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    box.classList.remove("visible");
    box.style.visibility = "";

    const r   = el.getBoundingClientRect();
    const gap = 8;
    // Prefer above the element; flip below if not enough room
    let top = r.top - bh - gap;
    if (top < gap) top = r.bottom + gap;
    const left = Math.max(gap, Math.min(r.left, window.innerWidth - bw - gap));
    box.style.top  = `${top}px`;
    box.style.left = `${left}px`;
    box.classList.add("visible");
  }

  function hide() { box.classList.remove("visible"); }

  // Mouse: show on hover of any [data-tip] element
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el) positionAndShow(el);
  });
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget?.closest("[data-tip]")) hide();
  });

  // Keyboard: show on focus, hide on blur/Escape
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el) positionAndShow(el);
  });
  document.addEventListener("focusout", (e) => {
    if (!e.relatedTarget?.closest("[data-tip]")) hide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });

  // Prevent `.tip` spans inside <label> elements from toggling their checkbox.
  // The capture phase intercepts the click before it bubbles to the label.
  document.addEventListener("click", (e) => {
    if (e.target.closest(".tip")) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

export function init() {
  initTooltips();

  // Apply stored appearance
  const theme = getTheme();
  applyTheme(theme);
  applyAccentColor(getAccentColor());
  updateThemeIcon();
  initBrowserChrome();

  // Nav tabs
  document.querySelectorAll(".tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      activateTab(tab);
      if (tab === "library") loadLibraryIfNeeded();
      if (tab === "search" && !lastSearchData && isLoggedIn()) showSearchSuggestions();
    })
  );

  // Detail back button
  $("btn-detail-back")?.addEventListener("click", backFromDetail);

  // Auth
  $("btn-login")?.addEventListener("click", startLogin);
  $("btn-logout")?.addEventListener("click", handleLogout);

  // Download status panel tab switching
  $("dl-tab-progress-btn")?.addEventListener("click", () => switchDlTab("progress"));
  $("dl-tab-log-btn")?.addEventListener("click", () => switchDlTab("log"));
  $("btn-clear-log")?.addEventListener("click", clearLog);

  // Download
  $("btn-download")?.addEventListener("click", handleDownload);
  $("btn-clear-queue")?.addEventListener("click", clearQueue);

  // URL pill input + file import
  initUrlPillInput();

  // Quality picker
  initQualityPicker();

  // Search
  $("btn-search")?.addEventListener("click", handleSearch);
  const searchInput = $("search-input");
  searchInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") handleSearch(); });
  searchInput?.addEventListener("input", () => {
    updateSearchClearBtn();
    const container = $("search-results");
    if (!searchInput.value && container && lastSearchData) {
      lastSearchData = null;
      container.innerHTML = "";
      if (isLoggedIn()) showSearchSuggestions();
    }
  });
  searchInput?.addEventListener("focus", () => showSearchHistory());
  searchInput?.addEventListener("blur", () => setTimeout(() => hide($("search-history")), 150));

  $("btn-clear-search")?.addEventListener("click", () => {
    if (searchInput) searchInput.value = "";
    updateSearchClearBtn();
    const container = $("search-results");
    if (container) container.innerHTML = "";
    lastSearchData = null;
    hide($("search-history"));
    if (isLoggedIn()) showSearchSuggestions();
  });
  $("btn-clear-history")?.addEventListener("click", () => {
    clearSearchHistory();
    hide($("search-history"));
  });
  $("btn-go-downloads")?.addEventListener("click", () => activateTab("download"));

  // Search type pills — also trigger search if query is present but no results yet
  document.querySelectorAll(".type-pill").forEach((pill) => {
    if (!pill.closest("#search-type-pills")) return;
    pill.addEventListener("click", () => {
      activeTypeFilter = pill.dataset.type;
      document.querySelectorAll("#search-type-pills .type-pill").forEach((p) =>
        p.classList.toggle("active", p.dataset.type === activeTypeFilter)
      );
      if (lastSearchData) {
        renderSearchResults(lastSearchData, activeTypeFilter);
      } else if ($("search-input")?.value?.trim()) {
        handleSearch();
      }
    });
  });

  // Library section pills
  document.querySelectorAll("#library-section-pills .type-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      _librarySection = pill.dataset.section;
      _libraryFilter = "";
      const filterInput = $("library-filter-input");
      if (filterInput) { filterInput.value = ""; }
      hide($("btn-clear-library-filter"));
      document.querySelectorAll("#library-section-pills .type-pill").forEach((p) =>
        p.classList.toggle("active", p.dataset.section === _librarySection)
      );
      loadLibraryIfNeeded();
    });
  });

  // Library sort select
  $("library-sort-select")?.addEventListener("change", (e) => {
    const [field, dir] = e.target.value.split("-");
    _librarySort = field;
    _librarySortDir = dir || "asc";
    if (_libraryLoaded[_librarySection]) {
      renderLibraryContent(_libraryData[_librarySection]);
    }
  });

  // Library filter input
  const libraryFilterInput = $("library-filter-input");
  const btnClearLibFilter  = $("btn-clear-library-filter");
  libraryFilterInput?.addEventListener("input", () => {
    _libraryFilter = libraryFilterInput.value;
    btnClearLibFilter?.classList.toggle("hidden", !libraryFilterInput.value);
    if (_libraryLoaded[_librarySection]) {
      renderLibraryContent(_libraryData[_librarySection]);
    }
  });
  btnClearLibFilter?.addEventListener("click", () => {
    libraryFilterInput.value = "";
    _libraryFilter = "";
    hide(btnClearLibFilter);
    if (_libraryLoaded[_librarySection]) {
      renderLibraryContent(_libraryData[_librarySection]);
    }
  });

  // Account page logged-in buttons
  $("btn-go-library-from-auth")?.addEventListener("click", () => {
    activateTab("library");
    loadLibraryIfNeeded();
  });
  $("btn-go-download-from-auth")?.addEventListener("click", () => activateTab("download"));
  $("btn-logout-account")?.addEventListener("click", handleLogout);

  // Help page side nav
  document.querySelectorAll(".help-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sectionId = btn.dataset.section;
      document.querySelectorAll(".help-nav-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.section === sectionId)
      );
      document.querySelectorAll(".help-section").forEach((s) =>
        s.classList.toggle("active", s.id === `help-${sectionId}`)
      );
    });
  });

  // Settings
  $("btn-save-settings")?.addEventListener("click", handleSaveSettings);

  // Theme toggle
  $("theme-toggle")?.addEventListener("click", () => { cycleTheme(); updateThemeIcon(); });

  initThemeUI();
  initAccentColorUI(appendLog);
  initTemplateBuilders();

  // Initial state
  updateAuthBadge();
  loadSettingsForm();

  if (!isLoggedIn()) {
    activateTab("auth");
  } else {
    activateTab("download");
    // Preload search suggestions in background
    showSearchSuggestions();
  }
}
