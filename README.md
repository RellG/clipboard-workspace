# Clipboard

A small, self-hosted notes and file library for the homelab. Open a note, write, and let it save. Keep documents and media in their own places, with original-quality downloads and live sync across devices.

## Everyday use

- **Notes:** a vertical list with pinned notes, compact previews, and one editor. Existing scratchpads and saved clips remain separate records with their original IDs and contents. Selecting a clip edits that clip; it does not create another note.
- **Minimize:** use the minus button or `Alt+M` to tuck the editor away. Reopen the note from its row. Collapse individual previews, whole groups, or all previews from the list menu. These are browser preferences; they never move a record to Trash.
- **Save:** edits autosave after a short pause. `Ctrl/Cmd+S` flushes pending saves to the same records. The status says Saved only after the server acknowledges persistence. “Save a copy to history” in the note menu is an explicit snapshot operation.
- **Documents:** PDFs, text files, code uploads, archives and other attachments. **Media:** images, video and audio. The libraries are views of the same files, without moving or duplicating bytes.
- **Search:** one search box finds active notes, clips and filenames across the three libraries. Search within Archive or Trash stays within that section. Code, Links, Pinned and Saved clips are optional note filters. File contents and OCR are not indexed.
- **Attachments:** use Attach in a note, or paste/drop a file into the active editor. Files are stored once and linked in the note as Markdown download links. Library uploads are standalone. Trashing a note does not delete linked files.
- **File tools:** select a file to preview or download it. File details contains SHA-256 and copyable curl commands. Original filenames, bytes and media Range requests are preserved. The upload limit remains 100 MB per file.
- **File converter:** an optional sidebar shortcut opens a separately running converter in a new tab. Configure `CLIPBOARD_CONVERTER_URL` privately in `.env`; the shortcut is hidden when unset. The URL is opened by the browser, so a loopback address works only on the computer running that converter. Download a Clipboard file and select it in the converter; files are not transferred automatically.
- **Archive and Trash:** archive hides an entry without deleting it. Move to Trash is explicit and recoverable, with Undo. Permanent deletion and Empty Trash require confirmation. Trash auto-purges after 30 days by default, with a snapshot taken first; `TRASH_RETENTION_DAYS=0` disables auto-purge. The original protected scratchpad/notes records still cannot be trashed.
- **Writing tools:** plain writing is the default. The note menu has headings, checklist syntax, reading preview and code mode. Preview checklists are display-only; edit their Markdown source to change them.

On desktop, collapse the library or use Focus on editor from the list menu. On a phone, choose a note from the list and use Back to return. Settings contains theme and retention information. `Alt+N` creates a note. No external fonts or runtime frontend dependencies are loaded.

## Layout and scrolling

The live design uses a compact library, a vertical notes list, and one editor. Documents and Media have separate library destinations; advanced tools stay in the note menu or file details. Light/dark themes use local system fonts, with no decorative motion or external font requests.

The notes list scrolls independently while its heading, search and item count remain visible. Use the mouse wheel, trackpad, or a vertical swipe to reach every note. Long note text and reading previews have their own scroll areas. On phones, Back and Minimize return to the list at the same position, including when background sync refreshed it while the editor was open. Changing library sections or filters starts at the top of the new list. List position is an in-memory convenience, not saved note data.

## Drafts and conflicts

Each pending save captures its own record ID and contents. Switching notes or minimizing does not redirect an earlier save into the new editor. Saves for a record are serialized, including edits made while a request is in flight.

The new client sends a computed revision token with each update. If another device changes the record first, the API responds with 409 and the local draft stays available. The recovery panel offers **Save draft as new note**, **Download draft**, or **Use server version**. It never retries a conflicting write automatically. Failed network/disk writes remain pending and can be retried.

Unsaved drafts live in memory, not localStorage. Keep the page open until they are saved or downloaded; closing/reloading while drafts or uploads are pending triggers a browser warning. This is not a full offline notes app. Older API clients that omit revision tokens retain their existing update behavior.

## Access

Run Clipboard on a trusted private network or behind a VPN or authenticating proxy. There is **no built-in login** and this change adds no public route, port, or proxy. Anyone who can reach the service can access it. Choose and maintain an appropriate network boundary.

Browser API requests are same-origin by default; CLI clients without an Origin header still work. Additional browser origins require an explicit comma-separated `CLIPBOARD_ALLOWED_ORIGINS` setting. Nginx forwards the original host and port so same-origin checks work with custom port mappings. Markdown permits HTTP/HTTPS/mailto and application file-download links. Uploaded file responses are sandboxed, with nosniff headers.

## Architecture

Browser → Nginx → Express → `data/db.json` and `uploads/`.

- `index.html`: application shell with accessible controls and dialogs.
- `assets/workspace.css`: system fonts, light/dark themes, responsive list/detail layout.
- `assets/workspace-core.js`: shared save queue, file classification and safe preview formatting.
- `assets/workspace.js`: library, editor, uploads, SSE and lifecycle actions.
- `server.js`: existing API, lossless file storage, atomic JSON persistence and computed revision tokens.

There is no frontend build step or framework migration. Docker copies both the HTML and `assets/` into Nginx. Persistent data is bind-mounted and gitignored. The API does not serve the static frontend itself.

Atomic writes flush a temporary file and rename it over the database. A failed commit returns 503 and restores in-memory state to the last committed database. Permanent removal commits database changes before unlinking files; shared physical files are kept while another item still references them. Existing boot, hourly and pre-purge snapshots remain in `data/snapshots/`.

## Running and validating

```bash
npm install
npm start  # API only; use Nginx for the frontend
```

To serve the complete app, copy `.env.example` to `.env`, choose a host port and optional converter URL, then run `docker compose up -d --build` (or `docker-compose` on older installations). The example host port is a generic default, not an installation address. Rebuilding is necessary for HTML, CSS and JavaScript changes because they are copied into the image. Keep `.env` private; only `.env.example` belongs in Git.

```bash
npm test
```

The runner starts a temporary server with synthetic data and a random port. Never pass a live address through `--target` or `TEST_BASE_URL`: those options explicitly allow writes/deletes. Use temporary synthetic data and separate ports, without live requests or access to real data.

The suite covers API contracts, malformed requests, persistence/SSE, per-note save queues, safe previews, file routing, lossless transfer, unchanged legacy records, archive/trash/retention, computed revisions, conflicts and failed disk commits. Browser layout and touch interaction also need verification before deployment; passing API/core tests does not establish visual correctness.

The isolated browser regression is available separately:

```bash
PLAYWRIGHT_MODULE_PATH=/path/to/playwright \
CHROMIUM_EXECUTABLE_PATH=/path/to/chromium \
npm run test:scroll
```

Use an existing Playwright installation, or omit those environment variables when Playwright and its Chromium browser are already available through normal module resolution. The test intercepts every request and serves synthetic HTML/assets/API fixtures in memory; it starts no server and never contacts the live app. It checks wheel scrolling, touch swipes, reaching the final note, list position after Back/background refresh, and scrolling long text/reading previews at desktop, laptop, tablet, phone and landscape sizes. Chromium touch emulation does not replace physical-device Safari testing.

Before deployment, back up the live database and uploads and record hashes. After deployment, verify health and unchanged legacy content/file hashes, accounting for legitimate user edits. Do not start a second server in the project root; startup writes/reindexes data and may purge expired Trash. All test servers must use a separate working directory.

## API additions

Existing item, tab, file, archive, Trash, download and SSE endpoints remain available. New behavior:

| Endpoint | Purpose |
|---|---|
| `GET /api/workspace` | Read tabs and items with computed `_revision` tokens and retention settings; never persists the tokens. |
| `PUT /api/tabs/:id` | Accept optional `baseRevision`; reject stale drafts with 409; return `revision` on success. |
| `PUT /api/items/:id` | Same optional conflict check; allows an existing note to be cleared. Creation still requires nonempty text. |
| `PATCH /api/tabs/:id/archive` | Archive or restore a note tab using optional flags; restoring removes the flags. |
| `PATCH /api/tabs/:id/pin` | Pin/unpin a note tab without changing its content or timestamp. |

Computed revisions and new tab flags do not require a database migration. Existing records, IDs, tab order and lifecycle rules stay valid. File paths and terminal retrieval continue to work, for example:

```bash
curl -fLOJ 'https://clipboard.example.com/api/files/<file-id>/download'
```

## Configuration

| Variable | Purpose |
|---|---|
| `CLIPBOARD_HTTP_PORT` | Host port for Docker; defaults to the generic example in `.env.example`. |
| `CLIPBOARD_CONTAINER_NAME` | Optional container name for an installation. |
| `CLIPBOARD_CONVERTER_URL` | Optional HTTP/HTTPS converter URL exposed to the browser through `GET /api/config`. Blank hides the shortcut. URLs containing embedded credentials are rejected. |

Loopback addresses in internal health checks and synthetic tests are standard local process communication, not deployment addresses. Keep real hostnames, ports, account details, and backup locations out of public documentation.
