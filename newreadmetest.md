<div align="center">

# ✨ tiddl-gui

**Download Tidal tracks, albums, and playlists at maximum quality — directly in your browser.**

<br>

[![Live App](https://img.shields.io/badge/🚀%20Live%20App-Open%20Now-4fd08c?style=for-the-badge)](https://19jvjeffery.github.io/tiddl-gui/web/index.html)
[![License](https://img.shields.io/badge/📄%20License-Apache%202.0-blue?style=for-the-badge)](LICENSE)
[![Stars](https://img.shields.io/github/stars/19JVJeffery/tiddl-gui?style=for-the-badge&color=yellow)](https://github.com/19JVJeffery/tiddl-gui/stargazers)

<br>

_No installation required — just open and go._

<br>

<img src="docs/screenshots/all-devices-black.png" alt="Mockups" width="80%" />

</div>

---

## ⚠️ Disclaimer

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

## 🚀 Features

- 🎧 Download **tracks, albums, playlists, and mixes**
- 💿 Supports **FLAC lossless + high-resolution audio**
- 🔐 Secure login via official Tidal authentication
- ⚡ Runs entirely in your browser (no backend)
- 📦 No install, no setup, no dependencies

---

## 🧭 How to Use

### 1. 🔐 Log In
- Go to **Account**
- Click **Login with Tidal**
- Authorise in the new tab
- Return — login completes automatically

**Notes:**
- Token stored locally (`localStorage`)
- Auto-refresh handled client-side
- No third-party servers involved

---

### 2. ⬇️ Download Content

Paste any supported input:

| Type | Example |
|------|--------|
| Full URL | `https://tidal.com/browse/track/103805726` |
| Track | `track/103805726` |
| Album | `album/103805723` |
| Playlist | `playlist/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| Mix | `mix/0123456789abcdef` |

Select quality → click **Download**

---

### 🎚️ Quality Options

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

### 3. 🔎 Search

- Open **Search**
- Enter artist / track / album / playlist
- Click results to:
  - ➕ Add to queue
  - 📂 Browse contents
  - ⬇️ Download individually or all

---

### 4. 📚 Library

Access your saved:
- Tracks
- Albums
- Playlists

_(Requires login)_

---

### 5. 🌐 CORS Proxy

Tidal blocks direct browser requests.

Default proxy:
- https://corsproxy.io (no setup needed)

To change:
- Open **Settings**
- Edit **Proxy prefix URL**

---

## 🛠️ Run Locally

### Requirements

- Git  
- Any static file server  

---

### ▶️ Start Server

#### Python (quickest)
```bash
git clone https://github.com/19JVJeffery/tiddl-gui.git
cd tiddl-gui
python3 -m http.server 8080 --directory web
