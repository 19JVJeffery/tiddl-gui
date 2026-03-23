<div align="center">

<!-- Animated UI Banner (SVG-based, GitHub-safe) -->
<img src="https://svg-banners.vercel.app/api?type=origin&text1=tiddl-gui%20Interface&width=900&height=300&fontSize=42&theme=dark&fontColor=%23814793" width="90%" />

<br><br>

<!-- Fake animated panels -->
<img src="https://readme-typing-svg.demolab.com?font=Inter&size=20&duration=2000&pause=500&color=814793&center=true&vCenter=true&width=700&lines=Login+with+Tidal...;Browse+tracks%2C+albums%2C+playlists...;Download+in+FLAC+%2F+Hi-Res...;All+in+your+browser..." />

<br><br>

<!-- UI preview illusion -->
<table>
<tr>
<td align="center">
<img src="docs/screenshots/all-devices-black.png" width="300"/>
<br><sub><b style="color:#814793;">Multi-device UI</b></sub>
</td>

<td align="center">
<img src="docs/screenshots/download-tab.png" width="300"/>
<br><sub><b style="color:#814793;">Download Panel</b></sub>
</td>

<td align="center">
<img src="docs/screenshots/search-tab.png" width="300"/>
<br><sub><b style="color:#814793;">Search Experience</b></sub>
</td>
</tr>
</table>

</div>

<div align="center">

<!-- Gradient Title (GitHub-safe SVG trick) -->
<img src="https://readme-typing-svg.demolab.com?font=Inter&size=38&duration=1&pause=999999&color=814793&center=true&vCenter=true&width=500&lines=tiddl-gui" />

<br>

**Download Tidal tracks, albums, and playlists at maximum quality — directly in your browser.**

<br><br>

<!-- Glass-style badges -->
<a href="https://19jvjeffery.github.io/tiddl-gui/web/index.html">
  <img src="https://img.shields.io/badge/Live_App-Open-814793?style=for-the-badge&logo=vercel&logoColor=white&labelColor=2a1f2f" />
</a>
<a href="LICENSE">
  <img src="https://img.shields.io/badge/License-Apache_2.0-814793?style=for-the-badge&labelColor=2a1f2f" />
</a>
<a href="https://github.com/19JVJeffery/tiddl-gui/stargazers">
  <img src="https://img.shields.io/github/stars/19JVJeffery/tiddl-gui?style=for-the-badge&color=814793&labelColor=2a1f2f" />
</a>

<br><br>

<i style="color:#888;">No installation required — just open and go.</i>

<br><br>

<!-- Dark / Light adaptive image -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/all-devices-black.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/all-devices-white.png">
  <img src="docs/screenshots/all-devices-black.png" width="85%">
</picture>

</div>

---

## 🎬 Demo

<div align="center">

<img src="docs/demo.gif" width="90%" />

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

## <span style="color:#814793;">🚀 Features</span>

- 🎧 Download **tracks, albums, playlists, and mixes**
- 💿 **FLAC + Hi-Res audio support**
- 🔐 Secure Tidal authentication
- ⚡ Fully browser-based (no backend)
- 📦 Zero install, zero setup

---

## <span style="color:#814793;">🧭 How to Use</span>

### 🔐 Login
- Open **Account**
- Click **Login with Tidal**
- Authorise → return → auto-login

<span style="color:#888;">Token stored locally & auto-refreshed.</span>

---

### ⬇️ Download

Paste:
track/103805726
album/103805723
playlist/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
mix/0123456789abcdef


Select quality → **Download**

---

### 🎚️ Quality

| Quality | Format | Details |
|:--|:--|:--|
| Low | `.m4a` | 96 kbps |
| High | `.m4a` | 320 kbps |
| Lossless | `.flac` | 16-bit / 44.1 kHz |
| Max | `.flac` | Up to 24-bit / 192 kHz |

> [!NOTE]  
> Higher tiers require a Tidal subscription.  
> DRM-protected streams cannot be downloaded.

---

### 🔎 Search
Search anything → click to download or expand.

---

### 📚 Library
Access saved content (login required)

---

### 🌐 Proxy

Default:https://corsproxy.io


Change in:
**Settings → Proxy URL**

---

## <span style="color:#814793;">🛠️ Run Locally</span>

```bash
git clone https://github.com/19JVJeffery/tiddl-gui.git
cd tiddl-gui
python3 -m http.server 8080 --directory web
npx serve web -l 8080

Open → http://localhost:8080

