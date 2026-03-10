# tiddl-gui

> Download Tidal tracks, albums, and playlists at maximum quality — straight from your browser or the command line.

> [!WARNING]
> This app is for personal use only and is not affiliated with Tidal. Users must ensure their use complies with Tidal's terms of service and local copyright laws. Downloaded tracks are for personal use and may not be shared or redistributed. The developer assumes no responsibility for misuse of this app.

# Web App

**Live app: <https://19jvjeffery.github.io/tiddl-gui/>**

No installation needed — open the link and go.

## How to use

### 1 — Log in

Open the **Account** tab and click **Login with Tidal**.

A Tidal authorisation page opens in a new tab. Approve it there, then return — the app polls automatically and logs you in. Your token is stored in `localStorage` and refreshed automatically; nothing is ever sent to a third-party server.

### 2 — Download

Open the **Download** tab and paste any of the following:

| Input format | Example |
|---|---|
| Full Tidal URL | `https://tidal.com/browse/track/103805726` |
| Track | `track/103805726` |
| Album | `album/103805723` |
| Playlist UUID | `playlist/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| Mix ID | `mix/0123456789abcdef` |

Select a quality level and click **Download**. Files are saved directly to your browser's downloads folder.

| Quality | Format | Details |
|:---:|:---:|:---:|
| Low | .m4a | 96 kbps |
| High | .m4a | 320 kbps |
| Lossless | .flac | 16-bit, 44.1 kHz |
| Max | .flac | Up to 24-bit, 192 kHz |

> [!NOTE]
> Lossless / Max quality requires an eligible Tidal subscription. Encrypted (DRM) streams cannot be saved in the browser — use the CLI for those.

### 3 — Search

Open the **Search** tab, type an artist or track name, and press **Search**. Click a result to pre-fill the Download tab.

### 4 — CORS proxy

Tidal's API blocks direct browser requests. All API calls are routed through a CORS proxy; the default is [corsproxy.io](https://corsproxy.io) and needs no setup.

To use a different proxy, open **Settings** and update the **Proxy prefix URL** field.

## Run locally

```bash
git clone https://github.com/19JVJeffery/tiddl-gui.git
cd tiddl-gui
python3 -m http.server 8080 --directory web
```

Open <http://localhost:8080>. Any static file server works (`npx serve web`, `npx http-server web`, etc.).

---

# CLI

## Installation

> [!IMPORTANT]
> Install [`ffmpeg`](https://ffmpeg.org/download.html) first — it is required to convert downloaded tracks.

```bash
# uv (recommended)
uv tool install tiddl

# pip
pip install tiddl

# Docker
docker pull ghcr.io/19jvjeffery/tiddl:latest
```

## Authentication

```bash
tiddl auth login
```

## Downloading

```bash
tiddl download url <url>
```

> [!TIP]
> Short forms like `track/103805726` or `album/103805723` work too.

Use `--skip-errors` to skip unavailable items in playlists/albums instead of stopping:

```bash
tiddl download url <url> --skip-errors
```

### Quality

| Quality | Format | Details |
|:---:|:---:|:---:|
| LOW | .m4a | 96 kbps |
| NORMAL | .m4a | 320 kbps |
| HIGH | .flac | 16-bit, 44.1 kHz |
| MAX | .flac | Up to 24-bit, 192 kHz |

### Output format

Use `--output` to control filenames and folder structure. Example:

```bash
tiddl download url <url> --output "{album.artist}/{album.title}/{item.number:02d}. {item.title}"
```

See [docs/templating.md](docs/templating.md) for all available placeholders.

## Configuration

App files are stored in `~/.tiddl` by default. Copy [docs/config.example.toml](docs/config.example.toml) to `~/.tiddl/config.toml` to customise defaults.

Set `TIDDL_PATH` to use a different location:

```bash
TIDDL_PATH=~/custom/tiddl tiddl auth login
```
