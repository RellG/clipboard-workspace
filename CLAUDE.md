# Clipboard Workspace (RellLab)

Self-hosted shared clipboard / scratchpad. Single-file vanilla-JS frontend (`index.html`, no build step), Express API (`server.js`), JSON file store, SSE live sync. Runs in Docker on the homelab Raspberry Pi. See `README.md` for features and the API table.

## Where it runs / how to access it

- **Host**: Raspberry Pi 4 (`raspberrypi`, aarch64, Node 18, Docker Compose v5), LAN IP `192.168.4.129`.
- **SSH** (key auth, non-interactive OK): `ssh reynoldshomelab@192.168.4.129` or, from the Windows PC, the alias `ssh rpi` (also `rellhomelab`), defined in `C:\Users\rellf\.ssh\config`.
- **Project dir**: `~/Clipboard` on the Pi (`/home/reynoldshomelab/Clipboard`), a git checkout of `git@github.com:RellG/clipboard-workspace.git`, branch `main`. The Pi has GitHub SSH auth and a git identity, so **commit and push from the Pi**.
- **App URL**: `http://192.168.4.129:8084` (container `relllab-clipboard`, nginx :80 -> host :8084, Express on :3000 inside).
- **Real data** (bind mounts, gitignored, owned by root because the container runs as root): `~/Clipboard/data/db.json` and `~/Clipboard/uploads/`.

## Non-negotiable: real data lives here

`data/` and `uploads/` are the user's actual history (items, tabs, photos, audio, video). Legacy items must never be altered, removed or corrupted.

1. **Back up before any change**: `ssh rpi` then copy `data/db.json`, tar `uploads/`, and record `sha256sum`s into `~/archive/backups/Clipboard_prechange_<timestamp>/`.
2. **Never run `npm test` (or any test) against the live server.** The suite creates and deletes items. `npm test` now always starts an isolated server in a temp dir; only `--target=`/`TEST_BASE_URL` points it elsewhere, and that prints a warning. (Before this was fixed it auto-attached to `localhost:8084`.) Do not run tests on the Pi at all; run them on the PC.
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
ssh rpi 'cd ~/Clipboard && tar cf - server.js index.html package.json package-lock.json README.md CLAUDE.md Dockerfile docker-compose.yml nginx.conf start.sh .gitignore tests' | tar xf -
npm install && npm test                # isolated temp-dir server, 70 tests

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
- `index.html` (~5k lines): all CSS/JS inline. State is `allItems`, `tabs`, `ftStoredFiles`. The feed and file table use **event delegation with `data-action` attributes and `escapeHtml`'d values**; do not reintroduce inline `onclick="fn('${name}')"` strings (filenames with quotes break out of them).
- Per-browser view prefs live in `localStorage` via `Prefs`: `clipboard_cards_mode`, `clipboard_card_overrides`, `clipboard_tabs_collapsed`, `clipboard_feed_collapsed`, `rell_theme`. Never store anything important there.
- The tab bar precedes `.workspace-split` in the DOM, so mobile hiding uses `body.view-clips` (toggled in `switchMobileView`), not a sibling selector.
- Tabs: `db.tabs` array order IS the tab order (`PUT /api/tabs/order` registers before `PUT /api/tabs/:id`, which upserts, so route order matters). The client renders `visibleTabs()` (non-trashed); the `tabs` array also holds trashed tabs so the Trash view and Undo work. Window-level drag handlers ignore non-file drags so reordering a tab does not trigger the upload overlay.
- Search: the feed search also scans tab names/contents client-side (`searchTabs()`, shown for the All and Notes filters, trashed tabs excluded) and `openTabAtMatch()` selects the first match.
- The `# tags` UI was removed on purpose; the `tags` array is still written and kept in the data and API for backward compatibility. Do not show or search it in the UI.
- Clicking a clip no longer loads it into the editor (that silently replaced the tab's text on the next keystroke). Use the "Open in a new editor tab" button.
- Upload limit is 100MB in three places: Multer in `server.js`, `client_max_body_size` in `nginx.conf`, and the docs. Change all together.
- No authentication: trusted LAN only. Do not expose to the internet without a VPN or authenticating proxy.
- Tests use Node's built-in runner (`node --test`). Tier 6 (`tests/tier6_archive_and_legacy_safety.test.js`) boots against a legacy-shaped seed and asserts items, tabs, and uploads are unchanged, and is the regression guard for the data-safety rules above.

## Ideas not yet done

Optional PIN/auth, per-clip expiry, touch drag-and-drop for tabs (the toolbar arrows cover touch today), and uploading large files in chunks.
