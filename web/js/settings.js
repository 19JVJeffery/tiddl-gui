/**
 * tiddl-web — settings module
 *
 * Handles loading/saving all user preferences, theme switching, accent colour
 * management, and the drag-and-drop file-path template builder.
 */

import {
  getCorsProxy, setCorsProxy,
  getClientId, setClientId,
  getClientSecret, setClientSecret,
  getTheme, setTheme,
  getAccentColor, setAccentColor,
  getUiEffects, setUiEffects,
  getTrackQuality, setTrackQuality,
  getVideoQuality, setVideoQuality,
  getThreadsCount, setThreadsCount,
  getSkipExisting, setSkipExisting,
  getSinglesFilter, setSinglesFilter,
  getVideosFilter, setVideosFilter,
  getUpdateMtime, setUpdateMtime,
  getRewriteMetadata, setRewriteMetadata,
  getMetadataEnable, setMetadataEnable,
  getMetadataLyrics, setMetadataLyrics,
  getMetadataCover, setMetadataCover,
  getMetadataAlbumReview, setMetadataAlbumReview,
  getCoverSave, setCoverSave,
  getCoverSize, setCoverSize,
  getCoverAllowed, setCoverAllowed,
  getM3uSave, setM3uSave,
  getM3uAllowed, setM3uAllowed,
  getAdvancedMode, setAdvancedMode,
  QUALITY_LABELS, QUALITY_STANDARD,
  getTemplate, setTemplate,
  TEMPLATE_DEFAULTS,
} from "./config.js";

// ─── UI Effects ───────────────────────────────────────────────────────────────

/** Apply a UI effects level ("full" | "reduced" | "minimal" | "classic") to <html>. */
export function applyUiEffects(level) {
  const root = document.documentElement;
  const validLevels = ["full", "reduced", "minimal", "classic"];
  const safeLevel = validLevels.includes(level) ? level : "full";
  root.setAttribute("data-effects", safeLevel);
  document.querySelectorAll(".seg-btn[data-effects-val]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.effectsVal === safeLevel);
  });
}

// ─── Browser chrome: dynamic favicon + Safari/Chrome tab colour ──────────────

function _resolveEffectiveTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function _updateBrowserChrome() {
  const rawAccent = getAccentColor();
  const isDark    = _resolveEffectiveTheme() === "dark";
  // Body background colour used for the favicon tile (matches --color-bg)
  const faviconBg = isDark ? "#111120" : "#f2f2fa";

  // Sanitize: only allow valid 3- or 6-digit hex colours before interpolating into SVG
  const safeAccent    = /^#[0-9a-fA-F]{3,6}$/.test(rawAccent)  ? rawAccent  : "#4fd08c";
  const safeFaviconBg = /^#[0-9a-fA-F]{3,6}$/.test(faviconBg)  ? faviconBg  : "#111120";

  // SVG favicon: rounded square + bold "t" in accent colour
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${safeFaviconBg}"/><text x="16" y="24" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-weight="800" font-size="22" fill="${safeAccent}">t</text></svg>`;
  const faviconEl = document.getElementById("favicon-link");
  if (faviconEl) faviconEl.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;

  // Safari / Chrome toolbar colour — use the header's surface colour (--color-surface),
  // not the body background, so the toolbar matches the actual header element.
  // Read the computed CSS variable for the currently-active theme; fall back to
  // known defaults for the opposite scheme (can't read both at once via getComputedStyle).
  const computedSurface = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-surface").trim();
  const currentSurface = /^#[0-9a-fA-F]{3,6}$/.test(computedSurface)
    ? computedSurface
    : (isDark ? "#111120" : "#ffffff");
  const darkSurface  = isDark ? currentSurface : "#111120";
  const lightSurface = isDark ? "#ffffff" : currentSurface;

  // For the explicit dark/light themes, both tags get the same surface colour so
  // the toolbar is correct regardless of the OS colour-scheme preference.
  // For the "system" theme, each tag covers its own scheme so Safari auto-switches.
  const theme = getTheme(); // "dark" | "light" | "system"
  const darkContent  = theme === "light" ? lightSurface : darkSurface;
  const lightContent = theme === "dark"  ? darkSurface  : lightSurface;

  const darkMetaEl  = document.getElementById("theme-color-meta-dark");
  const lightMetaEl = document.getElementById("theme-color-meta-light");
  if (darkMetaEl)  darkMetaEl.setAttribute("content",  darkContent);
  if (lightMetaEl) lightMetaEl.setAttribute("content", lightContent);
}

/** Call once at startup to install the OS-theme change listener. */
export function initBrowserChrome() {
  applyUiEffects(getUiEffects());
  _updateBrowserChrome();
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!document.documentElement.getAttribute("data-theme")) _updateBrowserChrome();
  });
}

// ─── Accent colour helpers ─────────────────────────────────────────────────

/** Hex → { r, g, b } */
function hexToRgb(hex) {
  const m = hex.replace("#", "").match(/.{2}/g);
  return m ? { r: parseInt(m[0], 16), g: parseInt(m[1], 16), b: parseInt(m[2], 16) } : null;
}

/** Scale lightness: positive = lighter, negative = darker (rough approach). */
function adjustHex(hex, amount) {
  const { r, g, b } = hexToRgb(hex) || { r: 79, g: 208, b: 140 };
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const rr = clamp(r + amount).toString(16).padStart(2, "0");
  const gg = clamp(g + amount).toString(16).padStart(2, "0");
  const bb = clamp(b + amount).toString(16).padStart(2, "0");
  return `#${rr}${gg}${bb}`;
}

/** Apply the chosen accent colour to the CSS custom properties on <html>. */
export function applyAccentColor(hex) {
  const root = document.documentElement;
  root.style.setProperty("--color-accent",       hex);
  root.style.setProperty("--color-accent-dark",  adjustHex(hex, -30));
  root.style.setProperty("--color-accent-light", adjustHex(hex,  30));
  const { r, g, b } = hexToRgb(hex) || { r: 79, g: 208, b: 140 };
  root.style.setProperty("--color-accent-soft",  `rgba(${r},${g},${b},0.14)`);
  root.style.setProperty("--color-accent-glow",  `rgba(${r},${g},${b},0.25)`);
  root.style.setProperty("--color-success",      hex);
  _updateBrowserChrome();
}

// ─── Theme ────────────────────────────────────────────────────────────────────

/** Apply a theme value ("dark" | "light" | "system") to <html>. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
  // Sync the segmented control if it exists
  document.querySelectorAll(".seg-btn[data-theme-val]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeVal === theme);
  });
  _updateBrowserChrome();
}

// ─── Template token definitions ───────────────────────────────────────────────

const TOKENS = {
  default: [
    { label: "item.title",       val: "{item.title}" },
    { label: "item.artist",      val: "{item.artist}" },
    { label: "item.number",      val: "{item.number}" },
    { label: "item.id",          val: "{item.id}" },
    { label: "album.title",      val: "{album.title}" },
    { label: "album.artist",     val: "{album.artist}" },
    { label: "album.date",       val: "{album.date}" },
    { label: "/",                val: "/", sep: true },
    { label: " - ",              val: " - ", sep: true },
    { label: ". ",               val: ". ", sep: true },
  ],
  track: [
    { label: "item.title",       val: "{item.title}" },
    { label: "item.artist",      val: "{item.artist}" },
    { label: "item.number",      val: "{item.number:02d}" },
    { label: "item.volume",      val: "{item.volume}" },
    { label: "item.id",          val: "{item.id}" },
    { label: "item.isrc",        val: "{item.isrc}" },
    { label: "item.quality",     val: "{item.quality}" },
    { label: "album.title",      val: "{album.title}" },
    { label: "album.artist",     val: "{album.artist}" },
    { label: "album.date",       val: "{album.date}" },
    { label: "/",                val: "/", sep: true },
    { label: " - ",              val: " - ", sep: true },
    { label: ". ",               val: ". ", sep: true },
  ],
  album: [
    { label: "item.title",       val: "{item.title}" },
    { label: "item.artist",      val: "{item.artist}" },
    { label: "item.number",      val: "{item.number:02d}" },
    { label: "item.id",          val: "{item.id}" },
    { label: "album.title",      val: "{album.title}" },
    { label: "album.artist",     val: "{album.artist}" },
    { label: "album.date",       val: "{album.date}" },
    { label: "album.release",    val: "{album.release}" },
    { label: "/",                val: "/", sep: true },
    { label: " - ",              val: " - ", sep: true },
    { label: ". ",               val: ". ", sep: true },
  ],
  playlist: [
    { label: "item.title",       val: "{item.title}" },
    { label: "item.artist",      val: "{item.artist}" },
    { label: "item.id",          val: "{item.id}" },
    { label: "playlist.title",   val: "{playlist.title}" },
    { label: "playlist.index",   val: "{playlist.index}" },
    { label: "playlist.created", val: "{playlist.created}" },
    { label: "album.title",      val: "{album.title}" },
    { label: "album.artist",     val: "{album.artist}" },
    { label: "/",                val: "/", sep: true },
    { label: " - ",              val: " - ", sep: true },
    { label: ". ",               val: ". ", sep: true },
  ],
  mix: [
    { label: "item.title",       val: "{item.title}" },
    { label: "item.artist",      val: "{item.artist}" },
    { label: "item.id",          val: "{item.id}" },
    { label: "mix_id",           val: "{mix_id}" },
    { label: "/",                val: "/", sep: true },
    { label: " - ",              val: " - ", sep: true },
  ],
  video: [
    { label: "item.title",       val: "{item.title}" },
    { label: "item.artist",      val: "{item.artist}" },
    { label: "item.id",          val: "{item.id}" },
    { label: "item.quality",     val: "{item.quality}" },
    { label: "/",                val: "/", sep: true },
    { label: " - ",              val: " - ", sep: true },
  ],
};

// Preview example values for each token
const PREVIEW_VALUES = {
  "{item.title}":       "Harder Better Faster Stronger",
  "{item.artist}":      "Daft Punk",
  "{item.artists}":     "Daft Punk",
  "{item.number}":      "3",
  "{item.number:02d}":  "03",
  "{item.volume}":      "1",
  "{item.id}":          "12345678",
  "{item.isrc}":        "USQX91501234",
  "{item.quality}":     "LOSSLESS",
  "{album.title}":      "Discovery",
  "{album.artist}":     "Daft Punk",
  "{album.artists}":    "Daft Punk",
  "{album.date}":       "2001-03-13",
  "{album.release}":    "ALBUM",
  "{playlist.title}":   "My Favorites",
  "{playlist.index}":   "5",
  "{playlist.created}": "2024-01-15",
  "{mix_id}":           "0123456789abcdef",
};

function renderPreview(template) {
  if (!template) return "(using default template)";
  let result = template;
  for (const [token, val] of Object.entries(PREVIEW_VALUES)) {
    result = result.replaceAll(token, val);
  }
  return result + ".flac";
}

// ─── Template builder ─────────────────────────────────────────────────────────

/** Build the chip palette HTML for a given type. */
function buildPaletteHtml(type) {
  const tokens = TOKENS[type] || TOKENS.default;
  return tokens.map((t) => {
    const cls = t.sep ? "token-chip token-chip--sep" : "token-chip";
    return `<span class="${cls}" draggable="true" data-token="${escAttr(t.val)}" title="Click or drag to insert">${escHtml(t.label)}</span>`;
  }).join("");
}

function escHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}

/** Insert text at the cursor position of an <input> or <textarea>. */
function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end   = input.selectionEnd   ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  input.dispatchEvent(new Event("input"));
}

/** Initialise one template builder section. */
function initBuilder(section) {
  const type      = section.dataset.type;
  const palette   = section.querySelector(".template-palette");
  const dropZone  = section.querySelector(".template-drop-zone");
  const textInput = section.querySelector(".template-text-input");
  const preview   = section.querySelector(".template-preview-value");
  const resetBtn  = section.querySelector(".template-reset-btn");

  if (!palette || !dropZone || !textInput || !preview) return;

  // Populate palette
  palette.innerHTML = buildPaletteHtml(type);

  // Load saved template
  textInput.value = getTemplate(type);

  const updatePreview = () => {
    if (preview) preview.textContent = renderPreview(textInput.value);
  };
  updatePreview();

  // ── Palette chip click → insert at cursor ──
  palette.addEventListener("click", (e) => {
    const chip = e.target.closest(".token-chip");
    if (!chip) return;
    insertAtCursor(textInput, chip.dataset.token);
    updatePreview();
  });

  // ── Chip drag start ──
  palette.addEventListener("dragstart", (e) => {
    const chip = e.target.closest(".token-chip");
    if (!chip) return;
    e.dataTransfer.setData("text/plain", chip.dataset.token);
    e.dataTransfer.effectAllowed = "copy";
  });

  // ── Drop zone drag-over / drop ──
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const token = e.dataTransfer.getData("text/plain");
    if (token) {
      insertAtCursor(textInput, token);
      updatePreview();
    }
  });

  // ── Also allow dropping directly on the text input ──
  textInput.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  textInput.addEventListener("drop", (e) => {
    e.preventDefault();
    const token = e.dataTransfer.getData("text/plain");
    if (!token) return;
    // Calculate approximate insert position
    const inputRect = textInput.getBoundingClientRect();
    const relX = e.clientX - inputRect.left;
    const charW = (inputRect.width / (textInput.value.length || 1));
    const pos = Math.min(Math.round(relX / charW), textInput.value.length);
    textInput.setSelectionRange(pos, pos);
    insertAtCursor(textInput, token);
    updatePreview();
  });

  // ── Live preview ──
  textInput.addEventListener("input", updatePreview);

  // ── Reset button ──
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      textInput.value = TEMPLATE_DEFAULTS[type] || "";
      updatePreview();
    });
  }
}

/** Initialise all template builders on the page. */
export function initTemplateBuilders() {
  document.querySelectorAll(".template-builder[data-type]").forEach(initBuilder);

  // Template type tab switching
  document.querySelectorAll(".template-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".template-tab-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.tab === target)
      );
      document.querySelectorAll(".template-builder").forEach((s) =>
        s.classList.toggle("active", s.dataset.type === target)
      );
    });
  });
}

// ─── Load settings into the form ─────────────────────────────────────────────

function el(id) { return document.getElementById(id); }
function setVal(id, v)  { const e = el(id); if (e) e.value   = v; }
function setChk(id, v)  { const e = el(id); if (e) e.checked = v; }

/**
 * Rebuild the options of the Default Track Quality <select> in the settings panel.
 */
function rebuildSettingsTrackQualityDropdown() {
  const select = el("setting-track-quality");
  if (!select) return;
  const current = select.value || getTrackQuality();
  select.innerHTML = QUALITY_STANDARD.map((v) => {
    const label = QUALITY_LABELS[v] || v;
    return `<option value="${v}"${v === current ? " selected" : ""}>${label}</option>`;
  }).join("");
  // Update tooltip
  const tip = select.closest(".field-group")?.querySelector("[data-tip]");
  if (tip) {
    tip.dataset.tip = "Audio quality for downloaded tracks. Low=96 kbps M4A · High=320 kbps M4A · HiFi=16-bit FLAC · Max=up to 24-bit FLAC. Higher tiers require a HiFi or HiFi Plus Tidal subscription.";
  }
}

export function loadSettingsForm() {
  setVal("proxy-input",              getCorsProxy());
  // Show blank when the user has not overridden the built-in defaults
  setVal("client-id-input",          localStorage.getItem("tiddl_client_id")     || "");
  setVal("client-secret-input",      localStorage.getItem("tiddl_client_secret") || "");

  // Rebuild the track quality dropdown first (adds/removes experimental options)
  rebuildSettingsTrackQualityDropdown();
  setVal("setting-track-quality",    getTrackQuality());
  setVal("setting-video-quality",    getVideoQuality());
  setVal("setting-threads",          getThreadsCount());
  setVal("setting-singles-filter",   getSinglesFilter());
  setVal("setting-videos-filter",    getVideosFilter());
  setChk("setting-skip-existing",    getSkipExisting());
  setChk("setting-update-mtime",     getUpdateMtime());
  setChk("setting-rewrite-metadata", getRewriteMetadata());
  setChk("setting-advanced-mode",    getAdvancedMode());

  setChk("setting-meta-enable",       getMetadataEnable());
  setChk("setting-meta-lyrics",       getMetadataLyrics());
  setChk("setting-meta-cover",        getMetadataCover());
  setChk("setting-meta-album-review", getMetadataAlbumReview());

  setChk("setting-cover-save",       getCoverSave());
  setVal("setting-cover-size",       getCoverSize());
  const allowed = getCoverAllowed();
  ["track", "album", "playlist"].forEach((t) => {
    const cb = el(`setting-cover-allowed-${t}`);
    if (cb) cb.checked = allowed.includes(t);
  });

  setChk("setting-m3u-save",         getM3uSave());
  const m3uAllowed = getM3uAllowed();
  ["album", "mix", "playlist"].forEach((t) => {
    const cb = el(`setting-m3u-allowed-${t}`);
    if (cb) cb.checked = m3uAllowed.includes(t);
  });

  // Theme
  const theme = getTheme();
  document.querySelectorAll(".seg-btn[data-theme-val]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeVal === theme);
  });

  // UI Effects
  const effects = getUiEffects();
  document.querySelectorAll(".seg-btn[data-effects-val]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.effectsVal === effects);
  });

  // Accent colour
  const accent = getAccentColor();
  document.querySelectorAll(".swatch[data-color]").forEach((sw) => {
    sw.classList.toggle("active", sw.dataset.color.toLowerCase() === accent.toLowerCase());
  });
  const custom = el("accent-custom");
  if (custom) custom.value = accent;

  // Template inputs
  ["default", "track", "album", "playlist", "mix", "video"].forEach((type) => {
    const inp = document.querySelector(`.template-builder[data-type="${type}"] .template-text-input`);
    if (inp) {
      inp.value = getTemplate(type);
      const preview = document.querySelector(`.template-builder[data-type="${type}"] .template-preview-value`);
      if (preview) preview.textContent = renderPreview(inp.value);
    }
  });
}

// ─── Gather settings from the form and save ──────────────────────────────────

function getVal(id)  { const e = el(id); return e ? e.value.trim() : ""; }
function getChk(id)  { const e = el(id); return e ? e.checked : false; }

export function saveSettingsForm(appendLog) {
  setCorsProxy(getVal("proxy-input"));

  const cid = getVal("client-id-input");
  const csec = getVal("client-secret-input");
  if (cid)  localStorage.setItem("tiddl_client_id",     cid);
  else       localStorage.removeItem("tiddl_client_id");
  if (csec) localStorage.setItem("tiddl_client_secret", csec);
  else       localStorage.removeItem("tiddl_client_secret");

  setTrackQuality(getVal("setting-track-quality"));
  setVideoQuality(getVal("setting-video-quality"));
  setThreadsCount(parseInt(getVal("setting-threads") || "4", 10));
  setSinglesFilter(getVal("setting-singles-filter"));
  setVideosFilter(getVal("setting-videos-filter"));
  setSkipExisting(getChk("setting-skip-existing"));
  setUpdateMtime(getChk("setting-update-mtime"));
  setRewriteMetadata(getChk("setting-rewrite-metadata"));
  setAdvancedMode(getChk("setting-advanced-mode"));

  setMetadataEnable(getChk("setting-meta-enable"));
  setMetadataLyrics(getChk("setting-meta-lyrics"));
  setMetadataCover(getChk("setting-meta-cover"));
  setMetadataAlbumReview(getChk("setting-meta-album-review"));

  setCoverSave(getChk("setting-cover-save"));
  setCoverSize(parseInt(getVal("setting-cover-size") || "1280", 10));
  setCoverAllowed(["track","album","playlist"].filter((t) => getChk(`setting-cover-allowed-${t}`)));

  setM3uSave(getChk("setting-m3u-save"));
  setM3uAllowed(["album","mix","playlist"].filter((t) => getChk(`setting-m3u-allowed-${t}`)));

  // Save templates
  ["default", "track", "album", "playlist", "mix", "video"].forEach((type) => {
    const inp = document.querySelector(`.template-builder[data-type="${type}"] .template-text-input`);
    if (inp) setTemplate(type, inp.value.trim());
  });

  if (typeof appendLog === "function") appendLog("Settings saved.", "success");
}

// ─── UI Effects UI ────────────────────────────────────────────────────────────

export function initUiEffectsUI() {
  document.querySelectorAll(".seg-btn[data-effects-val]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.effectsVal;
      setUiEffects(val);
      applyUiEffects(val);
    });
  });
}

// ─── Accent colour UI ─────────────────────────────────────────────────────────

export function initAccentColorUI(appendLog) {
  document.querySelectorAll(".swatch[data-color]").forEach((sw) => {
    sw.addEventListener("click", () => {
      document.querySelectorAll(".swatch[data-color]").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      const hex = sw.dataset.color;
      applyAccentColor(hex);
      setAccentColor(hex);
      const custom = el("accent-custom");
      if (custom) custom.value = hex;
    });
  });

  const customInput = el("accent-custom");
  if (customInput) {
    customInput.addEventListener("input", () => {
      const hex = customInput.value;
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
        document.querySelectorAll(".swatch[data-color]").forEach((s) => s.classList.remove("active"));
        applyAccentColor(hex);
        setAccentColor(hex);
      }
    });
  }
}

// ─── Theme toggle ──────────────────────────────────────────────────────────────

/** Cycle through themes: dark → light → system → dark. Returns the new theme value. */
export function cycleTheme() {
  const current = getTheme();
  const next = current === "dark" ? "light" : current === "light" ? "system" : "dark";
  setTheme(next);
  applyTheme(next);
  document.querySelectorAll(".seg-btn[data-theme-val]").forEach((b) =>
    b.classList.toggle("active", b.dataset.themeVal === next)
  );
  return next;
}

export function initThemeUI() {
  // Segmented control inside Settings panel
  document.querySelectorAll(".seg-btn[data-theme-val]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.themeVal;
      setTheme(val);
      applyTheme(val);
      // Sync all other seg-btns (in case there are duplicates)
      document.querySelectorAll(".seg-btn[data-theme-val]").forEach((b) =>
        b.classList.toggle("active", b.dataset.themeVal === val)
      );
    });
  });
  // Note: the header quick-toggle (#theme-toggle) is wired in app.js so it can
  // also update the theme icon; do NOT add a second handler here.
}
