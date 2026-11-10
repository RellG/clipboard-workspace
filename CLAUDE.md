# Clipboard Workspace (RellLab)

Self-hosted shared clipboard / scratchpad. Vanilla-JS frontend (`index.html` + `assets/`, no build step), Express API (`server.js`), JSON file store, SSE live sync. Runs in Docker on the homelab Raspberry Pi. See `README.md` for the current UI and API additions. The simplification supersedes older UI notes below.

## Where it runs / how to access it

- **Host**: Raspberry Pi 4 (`raspberrypi`, aarch64, Node 18, Docker Compose v5), LAN IP `192.168.4.129`.
- **SSH** (key auth, non-interactive OK): `ssh reynoldshomelab@192.168.4.129` or, from the Windows PC, the alias `ssh rpi` (also `rellhomelab`), defined in `C:\Users\rellf\.ssh\config`.
- **Project dir**: `~/Clipboard` on the Pi (`/home/reynoldshomelab/Clipboard`), a git checkout of `git@github.com:RellG/clipboard-workspace.git`, branch `main`. The Pi has GitHub SSH auth and a git identity, so **commit and push from the Pi**.
- **App URL**: `http://192.168.4.129:8084` (container `relllab-clipboard`, nginx :80 -> host :8084, Express on :3000 inside).
- **Real data** (bind mounts, gitignored, owned by root because the container runs as root): `~/Clipboard/data/db.json` and `~/Clipboard/uploads/`.

## Non-negotiable: real data lives here

`data/` and `uploads/` are the user's actual history (items, tabs, photos, audio, video). Legacy items must never be altered, removed or corrupted.

1. **Back up before any change**: `ssh rpi` then copy `data/db.json`, tar `uploads/`, and record `sha256sum`s into `~/archive/backups/Clipboard_prechange_<timestamp>/`.
2. **Never run `npm test` (or any test) against the live server.** The suite creates and deletes items. `npm test` now always starts an isolated server in a temp dir; only `--target=`/`TEST_BASE_URL` points it elsewhere, and that prints a warning. (Before this was fixed it auto-attached to `localhost:8084`.) Default workflow is to run tests on the PC. On 2026-11-02 the user explicitly authorized isolated tests on this Pi using temporary synthetic data and separate ports, with no requests to the live app and no access to its database/uploads. This authorization permits that isolated validation without asking again; it never permits a live test target.
3. **Test server changes on a copy first**: copy `db.json` + `uploads/` to a `mktemp -d`, run `PORT=3199 NODE_PATH=~/Clipboard/node_modules node ~/Clipboard/server.js` from that dir, and `cmp` the db against the backup. Stop it by PID (see below).
4. New fields must be optional and default-off so old items are valid as-is. Archive is the model: `archived: true` + `archivedAt`, and restoring **deletes** both keys so an item returns to its exact original shape. Archiving never touches `updatedAt` or files on disk.
5. "Delete" in the UI is **Trash**, not removal: `trashed: true` + `trashedAt` on items and tabs (restore deletes both keys; files stay on disk; `updatedAt` untouched). `DELETE /api/items/:id` and `DELETE /api/tabs/:id` remain permanent and are only called from the Trash view ("Delete forever", confirm dialog) and by API users. `POST /api/trash/empty` needs `{confirm:true}`.
   - **Auto-purge** runs after server start and hourly: it removes only entries with `trashed === true` AND a valid `trashedAt` older than `TRASH_RETENTION_DAYS` (default 30; `0` disables). Missing or unparsable `trashedAt` is never purged. A `-purge.json` snapshot of the full db is written first, and a file is only unlinked if no remaining item references it. Do not loosen this without updating Tier 7.
   - Archive and Trash flags are independent (archive -> trash -> restore stays archived).
6. Safety net: `data/snapshots/` holds `db-<iso>-boot.json` (every server start; keep 20) and `-auto.json` (hourly; keep 30), `-purge.json` (before any purge or Empty trash; keep 10). `db.json.bak` only mirrors the last save, so it is **not** a history.
7. After a deploy, verify: `curl localhost:8084/api/health` (item/tab counts), `cmp data/db.json <backup>/db.json`, and `sha256sum -c <backup>/uploads.sha256` from inside `uploads/`.

## Develop / test / deploy workflow

The PC has Node, so develop locally and only use the Pi for git + Docker:

```bash
# pull the source down (PC, Git Bash)
ssh rpi 'cd ~/Clipboard && tar cf - server.js index.html assets package.json package-lock.json README.md CLAUDE.md Dockerfile docker-compose.yml nginx.conf start.sh .gitignore tests' | tar xf -
npm install && npm test                # isolated temp-dir server

# push changes back, then on the Pi
tar cf - <changed files> | ssh rpi 'cd ~/Clipboard && tar xf -'
ssh rpi 'cd ~/Clipboard && git add -A && git commit -m "..." && git push origin main'
ssh rpi 'cd ~/Clipboard && docker-compose up -d --build'   # index.html is baked into the image, so UI changes need a rebuild
# Use the hyphenated docker-compose (v1.29). The `docker compose` plugin (v5) is too new for the Pi's Docker 20.10 daemon
# and fails with "client version 1.52 is too new". Verify afterwards (see the checklist above).
```

- Commit/PR attribution lines follow the harness instructions; push straight to `main` only when the user has asked for it.
- For UI checks without touching real data: run the real `server.js` on another port with synthetic data, and serve `index.html` through a small static+proxy (the Node server does **not** serve `index.html`; nginx does in the container). Use string ids (`BigInt`/strings), not JS numbers above 2^53.
- Kill processes over ssh **by PID** (`ss -ltnp | grep :3199`). `pkill -f <pattern>` matches the ssh shell's own command line and kills the session.

## Architecture notes / gotchas

- `server.js` (~1.6k lines): lossless streaming uploads with SHA-256, Range-aware downloads, atomic `db.json` writes (tmp + fsync + rename), SSE broadcast, orphan-file re-index and SHA backfill on boot, `snapshotDb()` before any boot write.
- `index.html` is now the app shell; `assets/workspace.css`, `assets/workspace-core.js`, and `assets/workspace.js` implement the Notes/Documents/Media UI. Docker must copy `assets/` into Nginx. Keep content escaped and delegated actions keyed by IDs; never interpolate private titles/filenames into inline JavaScript.
- The new SaveQueue captures per-record drafts at edit time and serializes writes. Never read the active editor later to save an older note. Ctrl/Cmd+S flushes; snapshot creation is explicit. Minimize is a view preference, completely separate from Trash.
- `/api/workspace` provides computed `_revision` tokens without modifying stored records. The new client supplies `baseRevision` on updates; 409 keeps the draft for explicit recovery. Legacy API clients may omit it. Save failures must return 503, never Saved; `saveDb()` rolls memory back and throws.
- Per-browser view preferences use the `clipboard_v3_` prefix. Store only view state, selected IDs and theme; never store drafts or private content in localStorage. Unsent drafts are in memory with unload protection.
- Tabs remain the existing `db.tabs` records. The sidebar list replaces the old horizontal strip, but IDs, contents and array ordering remain valid. Optional archive/pin endpoints operate on tabs without a migration.
- Documents and Media are classifications over existing file records. Note attachments are Markdown links to file IDs; do not automatically reassociate old uploads, duplicate file bytes, or delete a file when a note is trashed.
- Scrolling layout: keep the application grid row bounded with `minmax(0, 1fr)` and `min-height: 0` through `.collection`, `.detail`, and the list/editor flex chain. `.entry-list` owns vertical scrolling; headers/footer must not shrink into its space. Keep both `100vh` fallback and `100dvh` sizing for phones.
- Never read a hidden list's `scrollTop` as its saved position: mobile uses `display: none` for the list while a note is open. `rememberListScroll()` only captures visible lists; Back/Minimize restore it. Unchanged `renderList()` output must keep DOM rows intact so sync does not interrupt touch momentum.
- `npm run test:scroll` runs isolated Playwright fixtures at six desktop/mobile sizes. Configure `PLAYWRIGHT_MODULE_PATH` and `CHROMIUM_EXECUTABLE_PATH` for an external installation. It starts no server, intercepts all requests and must never contact the real app. It is separate from the eight-tier API/core suite.
- The removed tags UI stays removed. The `tags` array remains in legacy data/API for compatibility.
- Preserve same-origin checks and the original Host port in the Nginx proxy (`$http_host`). CLI calls without Origin remain supported. Access stays local/VPN by user request; do not add a login or change exposure.
- Upload limit is 100MB in three places: Multer in `server.js`, `client_max_body_size` in `nginx.conf`, and the docs. Change all together.
- No authentication: trusted LAN only. Do not expose to the internet without a VPN or authenticating proxy.
- Tests use Node's built-in runner (`node --test`). Tier 6 (`tests/tier6_archive_and_legacy_safety.test.js`) boots against a legacy-shaped seed and asserts items, tabs, and uploads are unchanged, and is the regression guard for the data-safety rules above.

## Ideas not yet done

Optional per-clip expiry and uploading large files in chunks. Access remains local/VPN by user request; the current UI uses a note list rather than reorderable tabs.
