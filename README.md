# Clipboard Workspace

A self-hosted clipboard and scratchpad that syncs across every device on your network. Copy something on your desktop, it's on your phone before you pick it up — no account, no cloud, no third party holding your data.

Built to replace the habit of emailing myself links and screenshots. It runs on a Raspberry Pi in my homelab and has been my daily driver since.

![Node](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## What it does

**Live sync across devices.** Server-Sent Events push every change to all connected clients instantly — add an item on one device and it appears on the others without a refresh. The SSE endpoint is kept alive through Nginx with buffering disabled and a 24-hour read timeout.

**Tabbed scratchpads.** Persistent notepads alongside the clipboard feed, each with a markdown or plain-text mode and live preview. Create, rename, and delete tabs; content autosaves.

**Files up to 100MB.** Drag and drop anywhere on the canvas. Images, video, audio, PDFs, and markdown get inline previews rather than a download link.

**Real media streaming.** The file endpoint implements HTTP Range requests, so video and audio scrub and seek properly instead of forcing a full download first.

**Organization.** Pin items to the top, auto-tagging by detected file type, and full-text search across the feed.

**Mobile-first.** Segmented navigation, touch-sized targets, and safe-area insets so it works correctly on a phone with a notch.

**Self-healing storage.** On boot the server scans the uploads directory and re-indexes any file missing from the database, detecting its type from the extension. Drop a file in over SCP and it shows up in the UI.

---

## Architecture

```
Browser ──┐
          │  :8084
          ▼
   ┌──────────────┐   /api/*   ┌──────────────┐
   │    Nginx     │ ─────────► │   Express    │
   │ static + gzip│   proxy    │   :3000      │
   └──────────────┘            └──────┬───────┘
                                      │
                          ┌───────────┴───────────┐
                          ▼                       ▼
                    data/db.json           uploads/
                  (atomic JSON store)    (user files)
```

Nginx serves the single-file frontend and reverse-proxies `/api/` to Express, with SSE passed through unbuffered. Both run in one container.

Persistence is a JSON document written atomically — serialize to a `.tmp` file, then `rename()` over the target, so an interrupted write can't corrupt the database. No external database to administer, which is the right trade for a single-user homelab tool.

---

## Running it

### Docker (recommended)

```bash
git clone https://github.com/RellG/clipboard-workspace.git
cd clipboard-workspace
docker compose up -d
```

Open `http://localhost:8084` (or the host's LAN IP from another device).

### Directly with Node

```bash
npm install
npm start          # or: npm run dev  — nodemon reload
```

Serves the API on port 3000 and `index.html` from the same origin.

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT`   | `3000`  | Express listen port |

Ports and the upload ceiling are set in `docker-compose.yml` (`8084:80`), `nginx.conf` (`client_max_body_size`), and the Multer limit in `server.js` — change all three together if you raise the cap.

Two host-mounted volumes hold state, and both are gitignored:

- `./data` — `db.json`, the item and tab store
- `./uploads` — uploaded files

---

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/events` | SSE stream of live item and tab changes |
| `GET` | `/api/items` | List items — supports search and filtering |
| `POST` | `/api/items` | Create a text or link item |
| `PUT` | `/api/items/:id` | Update an item |
| `PATCH` | `/api/items/:id/pin` | Toggle pinned state |
| `DELETE` | `/api/items/:id` | Delete an item and its file |
| `POST` | `/api/file` | Upload a file (multipart, 100MB max) |
| `GET` | `/api/file/:filename` | Serve a file — Range-aware; `?download=1` to force download |
| `GET` | `/api/tabs` | List scratchpad tabs |
| `POST` | `/api/tabs` | Create a tab |
| `PUT` | `/api/tabs/:id` | Update tab content or metadata |
| `DELETE` | `/api/tabs/:id` | Delete a tab |
| `GET` | `/api/health` | Health check |

---

## Security

**This ships with no authentication and is built for a trusted LAN.** Anyone who can reach the port can read and write everything in it.

Do not expose it directly to the internet. If you need access from outside, put it behind a VPN (I reach mine over WireGuard) or an authenticating reverse proxy. Binding it to a public interface as-is would publish your clipboard to the world.

On upload, the stored filename is generated server-side from a timestamp and a random suffix — the client's original name is kept only as a display label, never as a path. On the way back out, the requested filename is reduced with `path.basename()` before it is joined to the uploads directory, so a crafted request can't traverse out of it.

---

## Stack

Node.js · Express · Multer · Server-Sent Events · Nginx · Docker · vanilla JS frontend, no build step

## License

MIT
