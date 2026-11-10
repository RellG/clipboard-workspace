# Clipboard contributor guidance

Self-hosted notes and file library with a vanilla JavaScript frontend, Express API, JSON storage, and SSE sync. See `README.md` for setup. No frontend build step is required.

## Private installation configuration

Never commit personal names, email addresses, local network addresses, SSH aliases, machine usernames, absolute workstation paths, backup locations, or production port mappings. Use placeholders in documentation. Keep deployment settings in an ignored `.env` file, starting from `.env.example`. Do not copy private configuration into commits, issues, screenshots, or logs.

The converter shortcut reads `CLIPBOARD_CONVERTER_URL` through `/api/config`. Its address must be reachable by the browser; loopback refers to the browser's computer. An empty setting hides the shortcut. Do not hardcode an installation URL in HTML or JavaScript.

## Data safety

- `data/`, `uploads/`, backups, and seed exports contain private user content and must stay ignored.
- Back up the database, uploads, and file hashes outside the repository before changes to a real installation.
- Never run mutation tests against production. `npm test` starts an isolated temporary server with synthetic data. Do not supply a live `TEST_BASE_URL` or `--target`.
- Start test servers only in separate temporary working directories. Starting `server.js` in the project directory may reindex files, write the database, or purge expired Trash.
- Keep legacy record IDs, content, array ordering, and file bytes unchanged. New optional fields must not require a migration. Restore operations remove lifecycle flags rather than rewriting content or timestamps.
- Deletion from the main interface means recoverable Trash. Permanent deletion requires explicit confirmation in the Trash view.
- Auto-purge removes only records explicitly trashed with a valid timestamp older than retention. Snapshot first and keep shared file bytes while another record references them.
- After deployment, check health, compare the database to the backup, and verify upload hashes. Account for legitimate concurrent edits without exposing their contents.

## Development and deployment

```bash
npm ci
npm test
# Optional isolated browser regression; requires Playwright and Chromium.
npm run test:scroll
```

Docker serves the frontend through Nginx and proxies the API to Node. Rebuild the image after HTML, CSS, or JavaScript changes:

```bash
cp .env.example .env  # First setup only; do not overwrite an existing .env.
# Edit .env privately for this installation.
docker compose up -d --build
```

Use the Compose command compatible with the deployment host; some older installations require `docker-compose`. Do not record a particular host's versions, access commands, or network details here. Preserve data mounts and network boundaries. Push directly to the default branch only when authorized by the user. Stop test processes by PID rather than broad process-name matches.

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
