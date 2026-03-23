<div align="center">

# ✨ <span style="color:#814793;">tiddl-gui</span>

**<span style="color:#814793;">Download Tidal tracks, albums, and playlists at maximum quality — directly in your browser.</span>**

<br>

[![Live App](https://img.shields.io/badge/🚀%20Live%20App-Open%20Now-814793?style=for-the-badge&logoColor=white)](https://19jvjeffery.github.io/tiddl-gui/web/index.html)
[![License](https://img.shields.io/badge/📄%20License-Apache%202.0-814793?style=for-the-badge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/19JVJeffery/tiddl-gui?style=for-the-badge&color=814793)](https://github.com/19JVJeffery/tiddl-gui/stargazers)

<br>

<span style="color:#999;">No installation required — just open and go.</span>

<br>

<img src="docs/screenshots/all-devices-black.png" alt="Mockups" width="80%" />

</div>

---

## ⚠️ <span style="color:#814793;">Disclaimer</span>

> [!WARNING]  
> This project is **not affiliated with Tidal**.  
>  
> You are responsible for ensuring your usage complies with:
> - Tidal's Terms of Service  
> - Local copyright laws  
>  
> Downloads are strictly for **personal use only**.  
> Redistribution is not permitted.  
>  
> The developer assumes **no liability for misuse**.

---

## 🚀 <span style="color:#814793;">Features</span>

- 🎧 Download **tracks, albums, playlists, and mixes**
- 💿 Supports **FLAC lossless + high-resolution audio**
- 🔐 Secure login via official Tidal authentication
- ⚡ Runs entirely in your browser (no backend)
- 📦 No install, no setup, no dependencies

---

## 🧭 <span style="color:#814793;">How to Use</span>

### 1. 🔐 <span style="color:#814793;">Log In</span>
- Go to **Account**
- Click **Login with Tidal**
- Authorise in the new tab
- Return — login completes automatically

<span style="color:#999;">Token stored locally (`localStorage`) and refreshed automatically.</span>

---

### 2. ⬇️ <span style="color:#814793;">Download Content</span>

Paste any supported input:

| Type | Example |
|------|--------|
| Full URL | `https://tidal.com/browse/track/103805726` |
| Track | `track/103805726` |
| Album | `album/103805723` |
| Playlist | `playlist/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| Mix | `mix/0123456789abcdef` |

<span style="color:#814793;"><strong>Select quality → Click Download</strong></span>

---

### 🎚️ <span style="color:#814793;">Quality Options</span>

| Quality | Format | Details |
|:--|:--|:--|
| Low | `.m4a` | 96 kbps |
| High | `.m4a` | 320 kbps |
| Lossless | `.flac` | 16-bit / 44.1 kHz |
| Max | `.flac` | Up to 24-bit / 192 kHz |

> [!NOTE]  
> Lossless / Max require an eligible Tidal subscription.  
> DRM-protected streams cannot be downloaded.

---

### 3. 🔎 <span style="color:#814793;">Search</span>

- Enter artist / track / album / playlist
- Click results to:
  - ➕ Add to queue  
  - 📂 Browse contents  
  - ⬇️ Download individually or all  

---

### 4. 📚 <span style="color:#814793;">Library</span>

Browse your saved:
- Tracks  
- Albums  
- Playlists  

---

### 5. 🌐 <span style="color:#814793;">CORS Proxy</span>

Default:
