# Tidal Downloader

Download tracks and videos from Tidal with max quality! `tiddl` is a CLI app written in Python, with a browser-based GUI hosted on GitHub Pages.

> [!WARNING]
> `This app is for personal use only and is not affiliated with Tidal. Users must ensure their use complies with Tidal's terms of service and local copyright laws. Downloaded tracks are for personal use and may not be shared or redistributed. The developer assumes no responsibility for misuse of this app.`

![PyPI - Downloads](https://img.shields.io/pypi/dm/tiddl?style=for-the-badge&color=%2332af64)
![PyPI - Version](https://img.shields.io/pypi/v/tiddl?style=for-the-badge)
[<img src="https://img.shields.io/badge/gitmoji-%20😜%20😍-FFDD67.svg?style=for-the-badge" />](https://gitmoji.dev)

# Web App (GUI)

The `web/` directory contains a zero-dependency browser app that mirrors every feature of the CLI. It is automatically deployed to **GitHub Pages** on every push to `main`.

## Live deployment

If GitHub Pages is enabled for this repository, the app is available at:

```
https://19jvjeffery.github.io/tiddl-gui/
```

## Enable GitHub Pages (first-time setup)

1. Go to your repository on GitHub → **Settings** → **Pages**
2. Under **Source**, select **GitHub Actions**
3. Push any change to `main` (or trigger the workflow manually under **Actions → Deploy to GitHub Pages → Run workflow**)

The workflow file is at `.github/workflows/pages.yml`. It deploys the `web/` folder as a static site with no build step required.

## How to use the web app

### 1 — Log in

Open the **Account** tab and click **Login with Tidal**.

A Tidal verification page will open in a new browser tab. Approve the request there, then return to the app — it polls automatically and logs you in. Your token is stored in `localStorage` and refreshed automatically; nothing is ever sent to a third-party server.

### 2 — Download a track, album, or playlist

Open the **Download** tab.

Paste any of the following into the input field:

| Input format | Example |
|---|---|
| Full Tidal URL | `https://tidal.com/browse/track/103805726` |
| Short resource ID | `track/103805726` |
| Album | `album/103805723` |
| Playlist UUID | `playlist/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| Mix ID | `mix/0123456789abcdef` |

Select a quality level and click **Download**. Progress is shown in the log panel below. Each track is saved directly to your browser's default downloads folder.

| Quality | Format | Details |
|:---:|:---:|:---:|
| Low | .m4a | 96 kbps |
| High | .m4a | 320 kbps |
| Lossless | .flac | 16-bit, 44.1 kHz |
| Max | .flac | Up to 24-bit, 192 kHz |

> [!NOTE]
> Availability of Lossless / Max quality depends on your Tidal subscription. Encrypted streams (DRM) cannot be saved in the browser — use the CLI for those.

### 3 — Search

Open the **Search** tab, type an artist or track name, and press **Search**. Click any result card to pre-fill the Download tab with that resource's ID.

### 4 — CORS proxy (Settings)

Tidal's API does not allow direct browser requests from external origins. All API calls are routed through a CORS proxy. The default is [corsproxy.io](https://corsproxy.io) and requires no configuration.

If you want to use a different proxy (or run your own), open **Settings** and update the **Proxy prefix URL** field, then click **Save settings**.

## Run locally

The web app is plain HTML + CSS + ES modules — no build step, no Node.js required.

```bash
# Clone the repo (if you haven't already)
git clone https://github.com/19JVJeffery/tiddl-gui.git
cd tiddl-gui

# Serve the web/ directory on port 8080
python3 -m http.server 8080 --directory web
```

Then open <http://localhost:8080> in your browser.

> [!TIP]
> Any static file server works. Alternatives: `npx serve web`, `npx http-server web`, or just open `web/index.html` directly in your browser (note: ES module imports require a server, not `file://`).

## Self-host / deploy elsewhere

Because the app is a static site (`web/index.html` + `web/css/` + `web/js/`), it can be deployed to any static hosting service:

| Provider | Command / steps |
|---|---|
| **GitHub Pages** | Already included — see workflow above |
| **Netlify** | Drag-and-drop the `web/` folder at app.netlify.com |
| **Vercel** | `vercel --cwd web` |
| **Cloudflare Pages** | Point root to `web/`, no build command needed |
| **Any web server** | Copy `web/` to your server's document root |

---

# CLI Installation

`tiddl` is available at [python package index](https://pypi.org/project/tiddl/) and you can install it with your favorite Python package manager.

> [!IMPORTANT]
> Also make sure you have installed  [`ffmpeg`](https://ffmpeg.org/download.html) - it is used to convert downloaded tracks to proper format.

## uv

We recommend using [uv](https://docs.astral.sh/uv/)

```bash
uv tool install tiddl
```

## pip

You can also use [pip](https://packaging.python.org/en/latest/tutorials/installing-packages/)

```bash
pip install tiddl
```

## docker

**coming soon**

# Usage

Run the app with `tiddl`

```bash
$ tiddl
 Usage: tiddl [OPTIONS] COMMAND [ARGS]...

 tiddl - download tidal tracks ♫

╭─ Options ───────────────────────────────────────────────────────────────────────────────────────────────────╮
│ --omit-cache            --no-omit-cache      [default: no-omit-cache]                                       │
│ --debug                 --no-debug           [default: no-debug]                                            │
│ --install-completion                         Install completion for the current shell.                      │
│ --show-completion                            Show completion for the current shell, to copy it or customize │
│                                              the installation.                                              │
│ --help                                       Show this message and exit.                                    │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ Commands ──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ auth       Manage Tidal authentication.                                                                     │
│ download   Download Tidal resources.                                                                        │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Authentication

Login to app with your Tidal account: run the command below and follow instructions.

```bash
tiddl auth login
```

## Downloading

You can download tracks / videos / albums / artists / playlists / mixes.

```bash
$ tiddl download url <url>
```

> [!TIP]
> You don't have to paste full urls, track/103805726, album/103805723 etc. will also work

Run `tiddl download` to see available download options.

### Error Handling

By default, tiddl stops when encountering unavailable items in collections such as playlists, albums, artists, or mixes (e.g., removed or region-locked tracks).

Use `--skip-errors` to automatically skip these items and continue downloading:

```bash
tiddl download url <url> --skip-errors
```

Skipped items are logged with track/album name and IDs for reference.

### Quality

| Quality | File extension |        Details        |
| :-----: | :------------: | :-------------------: |
|   LOW   |      .m4a      |        96 kbps        |
| NORMAL  |      .m4a      |       320 kbps        |
|  HIGH   |     .flac      |   16-bit, 44.1 kHz    |
|   MAX   |     .flac      | Up to 24-bit, 192 kHz |

### Output

You can format filenames of your downloaded resources and put them in different directories.

For example, setting output flag to `"{album.artist}/{album.title}/{item.number:02d}. {item.title}"`
will download tracks like following:

```
Music
└── Kanye West
    └── Graduation
        ├── 01. Good Morning.flac
        ├── 02. Champion.flac
        ├── 03. Stronger.flac
        ├── 04. I Wonder.flac
        ├── 05. Good Life.flac
        ├── 06. Can't Tell Me Nothing.flac
        ├── 07. Barry Bonds.flac
        ├── 08. Drunk and Hot Girls.flac
        ├── 09. Flashing Lights.flac
        ├── 10. Everything I Am.flac
        ├── 11. The Glory.flac
        ├── 12. Homecoming.flac
        ├── 13. Big Brother.flac
        └── 14. Good Night.flac
```

> [!NOTE]
> Learn more about [file templating](/docs/templating.md)

## Configuration files

Files of the app are created in your home directory. By default, the app is located at `~/.tiddl`.

You can (and should) create the `config.toml` file to configure the app how you want.

You can copy example config from docs [config.example.toml](/docs/config.example.toml)

## Environment variables

### Custom app path

You can set `TIDDL_PATH` environment variable to use custom path for `tiddl` app.

Example CLI usage:

```sh
TIDDL_PATH=~/custom/tiddl tiddl auth login
```

### Auth stopped working?

Set `TIDDL_AUTH` environment variable to use another credentials.

TIDDL_AUTH=<CLIENT_ID>;<CLIENT_SECRET>

# Development

Clone the repository

```bash
git clone https://github.com/oskvr37/tiddl
cd tiddl
```

You should create virtual environment and activate it

```bash
uv venv
source .venv/Scripts/activate
```

Install package with `--editable` flag

```bash
uv pip install -e .
```

# Resources

[Tidal API wiki (api endpoints)](https://github.com/Fokka-Engineering/TIDAL)

[Tidal-Media-Downloader (inspiration)](https://github.com/yaronzz/Tidal-Media-Downloader)
