# Clipboard simplification plan

Prepared 2026-11-02. Planning only; no application changes or deployment.

## Direction

Make Clipboard a quiet, self-hosted notes app: open it, find a note, write, and trust that it saved. Use the familiar library → note list → editor arrangement associated with Apple Notes, with separate Documents and Media destinations. Preserve fast cross-device clipboard capture and the useful homelab file-transfer tools.

Interpret “threads” as the existing notes and saved clips. There is no conversation/reply model in the current platform. Do not introduce chat, replies, or a second thread database to implement minimizing.

## Audit scope and limits

Reviewed the frontend layout, styling, state and workflows in `index.html`; item, tab, file, sync, persistence and recovery code in `server.js`; Docker/Nginx/startup configuration; README and project guidance; and the test runner and existing test coverage. Read only aggregate counts and field names from the live database, without copying private note contents into this plan.

The data snapshot inspected contains 127 items and 19 note tabs, including trashed records. This is already a real library, so the redesign must work with existing content rather than require a reset.

Browser inspection was attempted, but T3 could not open a tab because browser system libraries are missing. Findings below come from source inspection; visual layout, touch behavior and runtime defect reproduction remain implementation validation work. Tests were not run on this host, following `CLAUDE.md`'s instruction to run them on the development PC rather than the Pi.

## What causes the jumble

1. **Two meanings of saving.** Notes autosave to `/api/tabs/:id`, while the prominent Save button and Ctrl/Cmd+S call `publishCurrentNote()` and create a new `/api/items` record. Opening a clip in the editor creates another tab. Repeated saves and opens can accumulate copies.
2. **Two navigation systems for the same clips.** The sidebar and feed filter pills repeat All, Pinned, Code, Links, Media, Archive and Trash. Sidebar and feed search boxes share a query; file search has separate state.
3. **Notes are managed as browser tabs.** The horizontal strip gets crowded. Its close button calls Trash, so clearing the working area is confused with deleting a saved note.
4. **Files appear in several places.** The mixed clip feed, Media & Files filter, file-storage table and photo ribbon expose the same underlying records. The Media filter actually matches every `type: file` item, including documents.
5. **The editor presents too many tools at once.** Edit/Preview, Blocks, Mono, Copy, Clear, tab reorder arrows, Clips, title/icon/breadcrumb and line/word/character/encoding indicators compete with writing. Ordinary note creation first asks for a name.
6. **Storage leads with implementation details.** Lossless badges, SHA-256 columns, curl instructions, upload explanations, a large drop zone and a photo ribbon all precede or surround file browsing.
7. **Decorative and status noise.** Ambient glow/parallax runs a continuous animation loop. External Google Fonts add a network dependency. Sync toasts and numerous counts draw attention to routine operations.

Useful existing features should be reused: individual clip collapse, collapse-all, tab-strip collapse, feed-panel collapse and per-browser preferences already exist. Archive, recoverable Trash, Undo, SSE, atomic writes, recovery snapshots, lossless uploads and range-aware downloads are valuable infrastructure.

## Proposed experience

### Navigation

Primary library entries: **Notes**, **Documents**, **Media**. Put **Archive** and **Trash** in a collapsible secondary section and **Settings** at the bottom. Keep Pinned as a section within Notes; expose Code and Links as optional filters rather than permanent destinations. Do not restore the removed tags UI.

On desktop, show a narrow library, a compact item list, and one selected editor or preview. Both library and list can collapse for focused writing. On phones, use list → detail navigation with Back; retain the selected note and scroll position. Do not retain the Editor/Clips split as a second competing navigation model.

Use one search entry point. Search note titles/bodies, saved text/link/code clips and file names, with optional Notes/Documents/Media scope. Results open the existing record. Exclude Archive and Trash unless explicitly selected. File-content indexing and OCR are outside the first release.

### Notes and minimizing

- New Note immediately opens an untitled editor and focuses writing. Derive a suggested title from the first line; allow an explicit title override.
- Each list row shows title, one short preview and modified date. A chevron can hide its preview; collapsed groups show only their heading and count. Provide Collapse all / Expand all in the list menu.
- Minimize the active note by collapsing its editor to a slim title header or returning to the list on mobile. Restore by selecting its row. Keep a single compact active-note header rather than adding a tray of minimized windows.
- Minimize, close editor, collapse preview, archive and trash are distinct actions. Minimizing never changes note content or lifecycle flags and never calls a deletion endpoint. Store these view preferences per browser; use server state only for actual organization.
- Replace the horizontal tab strip with the note list. Existing tab IDs/content remain valid; this is initially a presentation change.
- Plain writing is the default. Keep a compact formatting/attach control and Copy. Put Markdown preview and code mode behind the note menu. Show line numbers and monospace when code mode is selected. Hide UTF-8, character/cursor counters, reorder arrows and Clear from the default editor.
- Autosave is the save action. Ctrl/Cmd+S flushes pending changes to the same record. Keep explicit snapshot creation under “Save a copy to history”; remove the ambiguous primary Save button.
- Preserve existing saved clips as legacy entries in the Notes list, with a small type indicator. Open their own record for editing rather than silently creating another tab. Offer Duplicate explicitly. Historical clip copies remain accessible through a filter; never infer duplicates and delete them.

### Documents and Media

- **Documents:** PDF, text/Markdown/code uploads, archives and other non-media attachments, in a simple list with name, size and date. Unknown formats remain downloadable.
- **Media:** images, video and audio; use thumbnails for images and suitable compact cards for audio/video. Retain original downloads, streaming/seeking and the existing fullscreen viewer.
- Use one file collection and one upload service. Classification creates views of the same ID, not extra copies. Use normalized MIME/type/extension rules consistently; allow unknown files to fall back to Documents.
- Put Download and Preview near the item. Move Copy link, Copy curl command, SHA-256, detailed metadata and archive/trash into the item menu or details drawer. Checksums remain computed in the backend.
- Replace the always-large upload panel with an Add files button and a drop target shown during dragging or when empty. Remove the photo ribbon from Documents.
- Files attached to a note also appear in the relevant library. Future attachment links reference file IDs without moving bytes. Uploads inside a note attach there; uploads in a library remain standalone. Define this context explicitly for paste/drop.
- Trashing a note must not implicitly delete a library file. Keep explicit file deletion and reference-aware cleanup. Existing unlinked uploads remain available unchanged.

## Reliability and security work that belongs in the plan

These are code-review findings or risks, not claims of reproduced production failures:

- `scheduleTabSave()` reads `activeTabId` and textarea contents after its 600 ms delay, while `loadTab()` immediately replaces the editor. Switching before the timer fires can discard the previous draft. Capture note ID/content at edit time, maintain per-note pending saves, and preserve/flush them before switching or minimizing.
- The save request does not check `res.ok` before showing Synced. Also, `saveDb()` catches disk-write errors without propagating failure to the API. Require successful persistence and HTTP acknowledgment before reporting Saved; keep the draft and show Retry on failure.
- Tab updates are unversioned. The SSE handler replaces note state while avoiding textarea replacement only while it has focus. Add conflict detection using an optional revision or equivalent check; preserve the losing draft and offer recovery. Start with save reliability, then introduce revision-aware writes compatibly with existing clients.
- Preview checkboxes are generated HTML without a handler that persists their state. Either implement editable checklists with source updates or render them as noninteractive until supported.
- Markdown preview constructs links with regex replacement and no explicit URL-scheme allowlist. Validate protocols and rendering rather than assuming escaping alone makes links safe. Review uploaded active content and sandbox previews as part of the same pass.
- The app has no authentication, enables broad CORS and is currently configured for HTTP. A tidy interface does not provide access control. For the secure workflow, protect the entire app, API, SSE stream and download paths behind one authenticated HTTPS boundary, with an agreed VPN/proxy access model. Avoid a cosmetic frontend-only PIN. Restrict origins and define CSRF/session behavior where cookie authentication is used.
- Remove external font requests; use system fonts or locally served assets. Keep drafts containing sensitive text out of general-purpose localStorage. Any offline draft persistence needs a deliberate retention and shared-device policy; full offline mode is deferred.
- There are duplicate declarations of `archiveCurrentGalleryPhoto()` and `removeCurrentGalleryPhoto()`. Remove the duplicates during extraction. Split the frontend into small local CSS/JS modules without adding a framework or build pipeline solely for this redesign.

## Implementation sequence

### Phase 0 — Baseline and preservation

Record current API contracts and screen states; obtain desktop/mobile screenshots when browser tooling works. Take a consistent backup and file hash manifest. Establish an isolated development copy with representative legacy items, tabs and uploads. Preserve IDs, timestamps, content, ordering, archive/trash semantics, existing downloads and API compatibility. Do not restart the live server for an audit: startup performs writes, reindexing and purge work.

### Phase 1 — Trustworthy notes and immediate decluttering

Fix pending-save ownership, response/error handling and persistence acknowledgment. Make Ctrl/Cmd+S flush; rename explicit clip snapshots. Create untitled notes without a naming dialog. Move advanced editor controls into a menu, remove ambient motion and external fonts, reduce routine success toasts, and retain a quiet Saved/Saving/Unable to save indicator separate from connection status. This can ship before the complete layout change.

Exit checks: type then switch/minimize immediately; edit title then switch; simulate HTTP and disk failures; confirm drafts survive and Saved is never shown for failure. Verify saving repeatedly updates one record unless Save a copy was requested.

### Phase 2 — Notes layout and minimizing

Introduce the library/list/editor shell, compact rows, collapsed sections and editor focus/minimize behavior. Replace the tab strip. Present legacy tabs and clips through a small UI adapter that routes updates to their existing endpoints. Consolidate search/navigation. Extend archive support to notes only through optional backward-compatible fields; currently archive applies to items, not tabs. Keep soft deletion explicit and separate from closing the editor.

Exit checks: keyboard and touch navigation; minimize and reopen without data/lifecycle changes; reload with preferences intact; find and edit an existing clip without making a copy; restore notes and files from Trash. Verify pinned notes and archive behavior across both legacy record types.

### Phase 3 — Separate attachment libraries

Implement Documents/Media filters over existing file records, one uploader and shared item actions. Keep file transfer commands in details. Introduce optional note-to-file links only if needed, with no automatic reassociation of old uploads. Reuse previews and downloads rather than creating another storage backend.

Exit checks: PDF appears under Documents; images/video/audio under Media; unknown formats remain downloadable; files appear once per applicable view; names and SHA-256 match; media seeking works; a note reference does not duplicate or delete a file.

### Phase 4 — Secure access, sync conflicts and final validation

The authenticated access boundary is a prerequisite for any broader exposure and can proceed earlier if remote access is required. Add conflict handling, safe preview/link validation and draft recovery. Complete frontend extraction and remove dead/duplicate code. Keep access settings in Settings, not in the writing flow.

Run the existing isolated suites on the development PC, including legacy-data and retention guards. Replace static frontend tests that require the old duplicated controls with behavior checks for the new workflows. Add targeted browser tests for rapid note switching, minimize versus Trash, save failures, conflicts, search scope and file routing. Validate narrow phones, tablet and desktop, keyboard focus, screen reader labels, zoom and reduced motion. Deploy only after the data-preservation checks pass, then verify health and unchanged legacy bytes/hashes against the predeployment snapshot, accounting for legitimate concurrent user edits.

## Release boundaries

Keep the current vanilla-JS/Express/SSE design and JSON storage for this work. Reconsider storage only if measured scale or concurrency requires it. Do not bundle AI features, collaboration/chat, a task system, nested notebook hierarchies, OCR, a plugin system, rich-text framework migration, full offline sync or automatic deduplication into the simplification.

Success means: the first screen makes writing and finding a note obvious; a note can be minimized without being trashed; documents and media have predictable homes; saving does not create unintended copies; expert tools remain available through details; existing data remains recoverable; and access and save status tell the truth.

## Session record

Clipboard was registered as a T3 project at `/home/reynoldshomelab/Clipboard`, with an idle planning chat bound to that root. The audit ran from this folder; the existing Home chat was not moved to another project. A pre-documentation backup is at `/home/reynoldshomelab/archive/backups/Clipboard_prechange_20261102_225950/` (database copy, uploads archive, hashes and manifest). No runtime files were edited and no tests, deployment or production restart were performed.

## Implementation update — 2026-11-02

The source now implements the Notes/list/editor shell, non-destructive minimizing and collapsed previews/groups, Documents/Media views, unified search, in-place legacy clip editing, untitled note creation, explicit snapshots, and per-record captured save queues. Advanced file transfer tools moved to file details. System fonts replace external font requests and the old animated background is removed.

The API now computes revision tokens without migrating existing records, rejects stale saves, acknowledges failed persistence with 503, and supports optional archive/pin flags for note tabs. Draft recovery stays explicit and in memory. Safe preview links and sandboxed file responses replace the old regex-only preview behavior. The user selected the existing local/homelab VPN access model; no login or new network exposure is introduced.

Implementation backup: `/home/reynoldshomelab/archive/backups/Clipboard_prechange_20261102_231123/`. It includes original runtime source, database, upload archive and hashes. The user authorized isolated Pi validation with temporary synthetic data and separate ports. Browser verification and deployment have not been performed.

Static validation completed: Node syntax checks for server/frontend/test files, HTML ID/reference checks, and `git diff --check`. The live database is byte-identical to the implementation backup and all original upload hashes match. The full isolated test run has now passed, as recorded below. Docker tooling is unavailable in the execution environment, and SSH to the documented host did not authenticate; no rebuild, live restart, commit or push was performed.

### Isolated validation result

With explicit user authorization, ran `env -u TEST_BASE_URL -u TEST_DATA_DIR npm test` on the Pi. All **75 tests passed**, with **0 failures**, across all eight tiers. The runner started its own temporary-data server on a random loopback port; seeded suites used their own temporary synthetic fixtures. No test requests were sent to the live app, and the live database/uploads were not accessed during validation. The runner exited with status 0 and shut down the temporary servers.

Coverage includes API contracts, malformed input, atomic persistence and SSE, independent save queues during rapid note switches and in-flight edits, failed saves and explicit conflict recovery, safe Markdown links, Documents/Media classification, original-quality downloads and Range requests, synthetic legacy-data preservation across restarts, archive/trash/retention, computed revision tokens, HTTP 503 on failed disk commits with memory rollback, origin checks and concurrent note creation.

Test log: `/tmp/clipboard-validation-20261102.log`. This result validates the automated API/core suite; it does not establish visual or touch correctness. Browser verification and live deployment remain pending. No live rebuild, restart, commit or push was performed during validation.

### Deployment — 2026-11-03

After the user authorized the restart and supplied SSH access through T3’s private credential prompt, rebuilt the image with `docker-compose build clipboard` and recreated the service with `docker-compose up -d --no-build clipboard`. Added `.dockerignore` so the build context excludes private database/uploads, dependencies and backups. The previous image was tagged for rollback.

Fresh predeployment backup: `/home/reynoldshomelab/archive/backups/Clipboard_predeploy_20261103_020436/`. It contains the database, upload archive, SHA-256 manifest and previous image ID.

The restarted app returned healthy with 127 items and 19 tabs. Its database was byte-identical to the predeployment copy; every predeployment upload hash verified. All three served frontend assets matched source. Read-only checks confirmed the workspace API is available, same-origin requests work and an untrusted browser origin receives 403. No production test records were created. Access remains on the existing local/VPN boundary at `http://192.168.4.129:8084`. Visual browser verification remains pending.

Deployment log: `/tmp/clipboard-deploy-20261103.log`. No commit or push was performed.

Docker subsequently confirmed `Container running, health healthy`. The temporary SSH credential file was removed after verification.

### Notes scrolling fix — 2026-11-03

The user approved the live design and reported that the notes list could not scroll on the web, requesting mobile support too. The original grid/flex layout allowed the notes column to exceed the viewport. Bound the application row to the viewport, set zero minimum heights through the flex chain, and make the list the vertical scroll container while keeping its controls visible. Note text and previews scroll independently.

Mobile list position is now captured before opening a note, preserved while the hidden list refreshes, and restored on Back/Minimize. Identical list renders retain existing DOM rows to avoid interrupting touch momentum. Section/filter changes intentionally reset list position.

Backup before changes: `/home/reynoldshomelab/archive/backups/Clipboard_prescroll_20261103_021322/`. Source changes affect only layout, list scroll state, tests and documentation; no stored record or API schema changes.

Validation: six isolated Chromium browser scenarios passed at 1440×900, 1024×600, 768×1024, 390×844, 375×667 and 844×390, including wheel/touch scrolling, the final note, independent editor/preview scrolling, list restoration after background refresh and no writes during navigation/minimizing. The same desktop regression failed against the pre-fix stylesheet, reproducing the reported issue. All eight existing frontend/core tests also passed. Logs: `/tmp/clipboard-scroll-validation.log`, `/tmp/clipboard-scroll-baseline.log`, `/tmp/clipboard-scroll-core.log`.

T3 preview could not start because its server runs as root with the Chrome sandbox enabled. After installing its missing browser dependencies, used a separate headless Chromium process and isolated synthetic request routing for validation. No live records were used in browser tests. Chromium touch emulation was checked; physical-device Safari remains untested. The deployed follow-up is recorded below.

The scrolling fix was rebuilt and deployed successfully on 2026-11-03. Fresh predeployment backup: `/home/reynoldshomelab/archive/backups/Clipboard_predeploy_20261103_021842/`. Docker reports `Container running, health healthy`; all three served frontend assets match source. The database is byte-identical to this predeployment snapshot and all upload hashes verify.

Additional read-only browser checks against the live app passed for desktop wheel scrolling and mobile touch scrolling with Back restoring the list position. All non-GET requests were blocked in those checks; no live records were created or edited. The live touch check waits for native swipe inertia to settle before measuring the return position. Reduced-height phone viewport checks also passed in the isolated fixtures.

Logs: `/tmp/clipboard-scroll-deploy-20261103.log`, `/tmp/clipboard-live-scroll-check.log`, `/tmp/clipboard-scroll-mobile-resize.log`. The temporary deployment credential was removed after verification. README and developer guidance now describe the live design, independent scrolling and browser regression workflow. No commit or push was performed.
