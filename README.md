# Clipboard Workspace

A self-hosted clipboard and scratchpad that syncs across every device on your network. Copy something on your desktop, it's on your phone before you pick it up — no account, no cloud, no third party holding your data.

Built to replace the habit of emailing myself links and screenshots. It runs on a Raspberry Pi in my homelab and has been my daily driver since.

![Node](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![Tests](https://img.shields.io/badge/Tests-34%2F34%20Passing-brightgreen)

---

## What it does

**Live sync across devices.** Server-Sent Events push every change to all connected clients instantly — add an item on one device and it appears on the others without a refresh. The SSE endpoint is kept alive through Nginx with buffering disabled and a 24-hour read timeout.

**Collapsible feed & expanded scratchpad.** The right-side "Saved Clips & History" panel can be collapsed at any time to give the notepad/scratchpad full 100% canvas width. Collapse or expand with:
- The collapse `>>` button in the feed panel header
- The "Clips" button in the editor toolbar
- The "Saved Clips" button in the top navbar (with live count badge)
- Keyboard shortcuts: `Alt+C` or `Ctrl+Shift+E`
- Collapse preference is persisted automatically across browser reloads via `localStorage`.

**Dedicated File Transfer & Lossless Storage.** A dedicated section for transferring and storing files intact across hosts. Files are stored as raw unaltered bytes with zero compression or quality loss, accompanied by computed SHA-256 cryptographic hashes, single-click browser downloads preserving original filenames, and copyable `curl` commands for terminal retrieval across remote machines.

**Tabbed scratchpads.** Persistent notepads alongside the clipboard feed, each with a markdown or plain-text mode and live preview. Create, rename, and delete tabs; content autosaves.

**Files up to 100MB.** Drag and drop anywhere on the canvas or directly in the File Transfer zone. Images, video, audio, PDFs, and markdown get inline previews rather than just a download link.

**Real media streaming.** The file endpoint implements HTTP Range requests, so video and audio scrub and seek properly instead of forcing a full download first.

**Organization.** Pin items to the top, auto-tagging by detected file type, and full-text search across the feed and file storage.

**Mobile-first.** Segmented navigation, touch-sized targets, and safe-area insets so it works correctly on a phone with a notch.

**Self-healing storage.** On boot the server scans the uploads directory, computes missing SHA-256 hashes, and re-indexes any file missing from the database. Drop a file in over SCP and it shows up in the UI.

---

## File Transfer & Cross-Host Retrieval

The dedicated **File Transfer & Storage** view allows you to move files between workstations, phones, laptops, and homelab servers without third-party cloud services or quality degradation:

- **Browser UI**: Navigate to **File Transfer & Storage** in the sidebar. Drag and drop any file to upload.
- **Copy Direct Link**: Each file card/row includes a button to copy the direct URL or terminal `curl` command.
- **Terminal Retrieval**: Fetch any stored file byte-for-byte on another host:

```bash
# Retrieve file with original filename preserved:
curl -OJ http://<rpi-ip>:8084/api/files/<file-id>/download

# Or retrieve by stored filename:
curl -OJ http://<rpi-ip>:8084/api/file/<filename>?download=1
```

Integrity is guaranteed via `X-SHA256` and `ETag` headers:

```bash
# Verify integrity on the receiving host:
sha256sum <downloaded-file>
```

---

## Architecture

```
Browser / CLI ──┐
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
                        (atomic JSON store)    (lossless files + SHA256)
```

Nginx serves the single-file frontend and reverse-proxies `/api/` to Express, with SSE passed through unbuffered. Both run in one container.

Persistence is a JSON document written atomically — serialize to a `.tmp` file, then `rename()` over the target, so an interrupted write can't corrupt the database.

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

### Running Tests

```bash
npm test
```

Executes the complete E2E test suite covering 34 test specifications across 5 tiers:
- **Tier 1**: Core API Contracts & Endpoints (8 tests)
- **Tier 2**: Boundary, Security & Error Conditions (12 tests)
- **Tier 3**: Concurrency, Persistence & SSE Synchronization (2 tests)
- **Tier 4**: Frontend HTML/DOM Inspection & Ergonomics (5 tests)
- **Tier 5**: Lossless File Transfer & Integrity Verification (7 tests)

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
| `GET` | `/api/files` | List stored files with metadata, sizes, and SHA-256 hashes |
| `POST` | `/api/files/upload` | Upload one or multiple files losslessly with SHA-256 generation |
| `GET` | `/api/files/:id` | Get file metadata and download link |
| `GET` | `/api/files/:id/download` | Download file with RFC 6266 attachment header, ETag, and Range support |
| `DELETE` | `/api/files/:id` | Delete file from disk and database |
| `POST` | `/api/file` | Legacy file upload endpoint |
| `GET` | `/api/file/:filename` | Serve a file — Range-aware; `?download=1` to force download |
| `GET` | `/api/tabs` | List scratchpad tabs |
| `POST` | `/api/tabs` | Create a tab |
| `PUT` | `/api/tabs/:id` | Update tab content or metadata |
| `DELETE` | `/api/tabs/:id` | Delete a tab |
| `GET` | `/api/health` | Health check |

---

## Security

**This ships with no authentication and is built for a trusted LAN.** Anyone who can reach the port can read and write everything in it.

Do not expose it directly to the internet. If you need access from outside, put it behind a VPN (e.g. WireGuard) or an authenticating reverse proxy.

On upload, stored files are protected against directory traversal and null bytes. Filenames are decoded safely and stored with disk isolation. Range requests and query parameters are strictly guarded against type-confusion and out-of-bound errors.

---

## Stack

Node.js · Express · Multer · Server-Sent Events · Nginx · Docker · vanilla JS frontend, no build step

## License

MIT
