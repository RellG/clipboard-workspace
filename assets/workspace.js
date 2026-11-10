/* Clipboard: one library, one selected record, autosave with captured per-record drafts. */
'use strict';
const { escape: esc, fileCategory, markdown, SaveQueue } = WorkspaceCore;
const $ = id => document.getElementById(id);
const prefs = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem('clipboard_v3_' + key)) ?? fallback; } catch (_) { return fallback; } },
    set(key, value) { try { localStorage.setItem('clipboard_v3_' + key, JSON.stringify(value)); } catch (_) {} }
};
const state = {
    tabs: [], items: [], view: 'notes', selected: null, query: '', filter: 'all', preview: false,
    compact: prefs.get('compact', false), collapsed: prefs.get('collapsed', {}), groups: prefs.get('groups', {}),
    minimized: prefs.get('minimized', {}), uploading: false, loaded: false, mutation: 0, retention: 30
};
let refreshTimer, refreshSerial = 0, toastTimer, undoAction, uploadContext = null;
let listScroll = 0, listMarkup = null;
function rememberListScroll() {
    if ($('entryList').getClientRects().length) listScroll = $('entryList').scrollTop;
}
function restoreListScroll() {
    if ($('entryList').getClientRects().length) $('entryList').scrollTop = listScroll;
}
function resetListScroll() { listScroll = 0; $('entryList').scrollTop = 0; }
const keyOf = (kind, id) => kind + ':' + String(id);
function entries() {
    return [...state.tabs.map(record => ({ kind: 'tabs', record, key: keyOf('tabs', record.id) })),
        ...state.items.map(record => ({ kind: 'items', record, key: keyOf('items', record.id) }))];
}
const find = key => entries().find(entry => entry.key === key);
const selected = () => find(state.selected);
const isFile = entry => !!entry && !!entry.record.filename;
const titleOf = entry => entry.kind === 'tabs' ? entry.record.name || 'Untitled' : entry.record.title || entry.record.originalName || entry.record.name || 'Untitled';
const dateOf = record => record.updatedAt || record.createdAt || record.timestamp;
const bytes = size => { const n = Number(size) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; };
function date(value) { const d = new Date(value); return Number.isFinite(+d) ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''; }
function downloadUrl(record) { return '/api/files/' + encodeURIComponent(String(record.id)) + '/download'; }
function mediaUrl(record) { return '/api/file/' + encodeURIComponent(record.filename); }
async function api(path, body, method = 'GET') {
    const res = await fetch('/api' + path, { method, cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) { const error = new Error(result.error || 'Request failed (' + res.status + ')'); error.status = res.status; error.current = result.current; throw error; }
    return result;
}
function replaceRecord(kind, record) {
    const list = state[kind], i = list.findIndex(x => String(x.id) === String(record.id));
    if (i === -1) list.push(record); else list[i] = record;
}
const saves = new SaveQueue(async (key, snapshot, revision) => {
    const entry = find(key);
    if (!entry) throw new Error('This note is no longer available. Download your draft before leaving.');
    const result = await api('/' + entry.kind + '/' + encodeURIComponent(String(entry.record.id)), { ...snapshot, baseRevision: revision }, 'PUT');
    const serverRecord = result.tab || result.item;
    // Later keystrokes must survive the acknowledgment of an earlier request.
    const pending = saves.entries.get(key)?.pending;
    replaceRecord(entry.kind, { ...serverRecord, ...(pending !== snapshot ? pending : {}), _revision: result.revision });
    state.mutation++;
    return { revision: result.revision };
}, key => {
    updateSaveStatus();
    renderList();
    if (!saves.dirty(key)) scheduleRefresh();
});
async function refresh() {
    const serial = ++refreshSerial, mutation = state.mutation;
    try {
        const data = await api('/workspace');
        if (serial !== refreshSerial) return;
        if (mutation !== state.mutation) { scheduleRefresh(); return; }
        const old = new Map(entries().map(e => [e.key, e.record]));
        const editing = document.activeElement === $('editorTextarea') || document.activeElement === $('docTitle');
        for (const kind of ['tabs', 'items']) {
            state[kind] = data[kind].map(record => {
                const key = keyOf(kind, record.id);
                // Keep the editor's original revision while it has focus. A remote version must
                // never silently become the base token for text the user has not seen.
                return saves.dirty(key) || (editing && key === state.selected) ? old.get(key) || record : record;
            });
            // Keep drafts even when another client permanently removes the underlying record.
            for (const [key, record] of old) if (key.startsWith(kind + ':') && saves.dirty(key) && !state[kind].some(r => String(r.id) === String(record.id))) state[kind].push(record);
        }
        state.retention = data.trashRetentionDays;
        state.loaded = true;
        $('retentionText').textContent = state.retention > 0 ? `Trash keeps deleted entries for ${state.retention} days.` : 'Trash auto-removal is disabled.';
        renderList();
        if (!state.selected && !matchMedia('(max-width:600px)').matches) {
            const stored = prefs.get('selected', null), candidate = visibleEntries().find(e => e.key === stored) || visibleEntries()[0];
            if (candidate) openEntry(candidate.key, false);
        } else {
            const entry = selected();
            if (!entry || (!saves.dirty(entry.key) && !isVisibleInView(entry))) clearSelection();
            else if (!saves.dirty(entry.key) && !editing && old.get(entry.key)?._revision !== entry.record._revision) renderDetail();
        }
    } catch (error) {
        if (!state.loaded) $('entryList').innerHTML = '<p class="list-empty">Could not load your library. <button class="text-button" data-action="refresh">Try again</button></p>';
        $('connectionStatus').textContent = 'Unable to reach server';
        $('connectionStatus').classList.add('offline');
    }
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 180); }
function isVisibleInView(entry) {
    const r = entry.record;
    if (state.view === 'trash') return r.trashed === true;
    if (r.trashed) return false;
    if (state.view === 'archive') return r.archived === true;
    if (r.archived) return false;
    // Searching in a primary library searches all active libraries, grouped by type.
    if (state.query) return true;
    if (state.view === 'notes') return !isFile(entry);
    return isFile(entry) && fileCategory(r) === state.view;
}
function visibleEntries() {
    const q = state.query.toLocaleLowerCase();
    return entries().filter(isVisibleInView).filter(entry => {
        const r = entry.record;
        if (q && ![titleOf(entry), r.content, r.name, r.originalName].some(value => String(value || '').toLocaleLowerCase().includes(q))) return false;
        if (!q && state.view === 'notes') {
            if (state.filter === 'pinned' && !r.pinned) return false;
            if (state.filter === 'clips' && entry.kind !== 'items') return false;
            if (state.filter === 'code' && r.type !== 'code' && r.mode !== 'code') return false;
            if (state.filter === 'link' && r.type !== 'link' && !/^https?:\/\//.test(r.content || '')) return false;
            if (state.filter === 'text' && (r.type === 'code' || r.type === 'link' || r.mode === 'code')) return false;
        }
        return true;
    }).sort((a, b) => Number(!!b.record.pinned) - Number(!!a.record.pinned) || (Date.parse(dateOf(b.record)) || 0) - (Date.parse(dateOf(a.record)) || 0));
}
function groupOf(entry) {
    if (state.query || state.view === 'archive' || state.view === 'trash') return isFile(entry) ? (fileCategory(entry.record) === 'media' ? 'Media' : 'Documents') : 'Notes';
    return state.view === 'notes' ? (entry.record.pinned ? 'Pinned' : 'Notes') : (state.view === 'media' ? 'Media' : 'Documents');
}
function compact(entry) { return Object.hasOwn(state.collapsed, entry.key) ? state.collapsed[entry.key] : state.compact; }
function renderList() {
    if (!state.loaded) return;
    const list = visibleEntries(), groups = new Map();
    list.forEach(entry => { const group = groupOf(entry); if (!groups.has(group)) groups.set(group, []); groups.get(group).push(entry); });
    const parts = [];
    if (state.view === 'trash') parts.push('<div class="trash-tools">' + esc(state.retention > 0 ? `Removed automatically after ${state.retention} days.` : 'Kept until you empty Trash.') + '<button class="text-button danger" data-action="empty-trash">Empty Trash…</button></div>');
    if (!list.length) parts.push('<div class="list-empty">' + (state.query ? 'No matches. Try another search.' : state.view === 'notes' ? 'Your notes live here. Start with a thought, a link, or a useful command.' : state.view === 'trash' ? 'Trash is empty.' : state.view === 'archive' ? 'Archived notes and files appear here.' : 'Add files to keep them handy on your devices.') + (['notes', 'documents', 'media'].includes(state.view) && !state.query ? '<div class="empty-add"><button class="text-button" data-action="new">' + (state.view === 'notes' ? 'New note' : 'Add files') + '</button></div>' : '') + '</div>');
    for (const [group, rows] of groups) {
        const groupKey = state.view + ':' + group, closed = !!state.groups[groupKey];
        parts.push('<button class="group-toggle" data-action="group" data-group="' + esc(groupKey) + '" aria-expanded="' + !closed + '">' + (closed ? '› ' : '⌄ ') + esc(group) + ' <span>' + rows.length + '</span></button>');
        if (closed) continue;
        for (const entry of rows) {
            const r = entry.record, file = isFile(entry), small = compact(entry);
            const type = file ? bytes(r.size) : entry.kind === 'items' ? 'Saved clip' : r.mode === 'code' ? 'Code' : '';
            const preview = file ? (r.originalName || r.name || r.filename) : (r.content || '').replace(/\s+/g, ' ').slice(0, 160) || 'No additional text';
            const thumbnail = file && fileCategory(r) === 'media' && (r.fileType === 'image' || /^image\//.test(r.mimetype || '')) && !small ? '<img class="media-thumb" loading="lazy" src="' + esc(mediaUrl(r)) + '" alt="">' : '';
            parts.push('<div class="entry' + (entry.key === state.selected ? ' selected' : '') + (small ? ' compact' : '') + '"><button class="entry-open" data-open="' + esc(entry.key) + '"' + (entry.key === state.selected ? ' aria-current="true"' : '') + '>' + thumbnail + '<span class="entry-title">' + esc(titleOf(entry)) + (saves.dirty(entry.key) ? ' ·' : '') + '</span><span class="entry-meta">' + esc([date(dateOf(r)), type, state.minimized[entry.key] ? 'Minimized' : ''].filter(Boolean).join(' · ')) + '</span><span class="entry-preview">' + esc(preview) + '</span></button><button class="row-collapse" data-action="collapse-row" data-key="' + esc(entry.key) + '" aria-label="' + (small ? 'Expand' : 'Collapse') + ' preview: ' + esc(titleOf(entry)) + '" aria-expanded="' + !small + '">' + (small ? '›' : '⌄') + '</button></div>');
        }
    }
    // Preserve scroll while SSE and save status refresh compact rows.
    rememberListScroll();
    const markup = parts.join('');
    // Leave unchanged rows in place so background sync does not interrupt touch momentum.
    if (listMarkup === markup) return;
    listMarkup = markup;
    const focused = $('entryList').contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    $('entryList').innerHTML = markup;
    restoreListScroll();
    if (focused) {
        const target = [...$('entryList').querySelectorAll('button')].find(el => focused.open ? el.dataset.open === focused.open : focused.group ? el.dataset.group === focused.group : focused.key ? el.dataset.key === focused.key : el.dataset.action === focused.action);
        target?.focus({ preventScroll: true });
    }
    $('collectionCount').textContent = list.length + (list.length === 1 ? ' item' : ' items');
}
function setView(view) {
    if (!['notes', 'documents', 'media', 'archive', 'trash'].includes(view)) return;
    saves.flushAll();
    state.view = view;
    resetListScroll();
    state.query = ''; $('searchInput').value = ''; state.filter = 'all'; $('listFilter').value = 'all';
    const name = view[0].toUpperCase() + view.slice(1);
    $('collectionTitle').textContent = name;
    $('backButton').querySelector('span').textContent = name;
    document.title = 'Clipboard — ' + name;
    $('collection').setAttribute('aria-label', name + ' list');
    $('listFilter').hidden = view !== 'notes';
    $('scopeHint').hidden = true;
    $('newButton').hidden = ['archive', 'trash'].includes(view);
    $('newButton').setAttribute('aria-label', view === 'notes' ? 'New note' : 'Add files');
    $('newButton').title = view === 'notes' ? 'New note' : 'Add files';
    document.querySelectorAll('[data-view]').forEach(el => { el.classList.toggle('selected', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); });
    $('app').classList.remove('library-open', 'show-detail');
    clearSelection(); renderList();
}
function clearSelection() {
    state.selected = null; state.preview = false;
    $('emptyDetail').hidden = false; $('noteEditor').hidden = true; $('noteActions').hidden = true; $('fileDetail').hidden = true;
    $('app').classList.remove('minimized', 'show-detail');
    restoreListScroll();
}
function openEntry(key, reveal = true) {
    const entry = find(key); if (!entry) return;
    if (state.selected && state.selected !== key) saves.flush(state.selected);
    if (!isVisibleInView(entry)) setView(entry.record.trashed ? 'trash' : entry.record.archived ? 'archive' : isFile(entry) ? fileCategory(entry.record) : 'notes');
    state.selected = key; prefs.set('selected', key); state.preview = false;
    rememberListScroll();
    if (reveal) { delete state.minimized[key]; prefs.set('minimized', state.minimized); $('app').classList.add('show-detail'); }
    renderDetail(); renderList();
}
function renderDetail() {
    const entry = selected(); if (!entry) return clearSelection();
    $('emptyDetail').hidden = true;
    $('noteEditor').hidden = isFile(entry); $('noteActions').hidden = isFile(entry); $('fileDetail').hidden = !isFile(entry);
    $('app').classList.toggle('minimized', !isFile(entry) && !!state.minimized[entry.key]);
    if (isFile(entry)) return renderFile(entry);
    const r = entry.record, readOnly = !!r.trashed;
    $('docTitle').value = titleOf(entry); $('editorTextarea').value = r.content || '';
    $('docTitle').readOnly = readOnly; $('editorTextarea').readOnly = readOnly;
    $('noteEditor').classList.toggle('code', r.mode === 'code' || r.type === 'code');
    $('editorTextarea').spellcheck = !(r.mode === 'code' || r.type === 'code');
    $('pinButton').textContent = r.pinned ? 'Unpin note' : 'Pin note';
    $('archiveButton').textContent = r.archived ? 'Restore from archive' : 'Archive';
    $('archiveButton').hidden = readOnly;
    $('purgeButton').hidden = !readOnly;
    $('trashButton').textContent = readOnly ? 'Restore from Trash' : 'Move to Trash';
    $('trashButton').hidden = entry.kind === 'tabs' && ['scratchpad', 'notes'].includes(String(r.id));
    for (const action of ['attach', 'heading', 'checklist', 'mode', 'pin']) document.querySelectorAll('[data-action="' + action + '"]').forEach(el => { el.disabled = readOnly; });
    $('editorTextarea').hidden = state.preview;
    $('markdownPreviewPane').hidden = !state.preview;
    if (state.preview) $('markdownPreviewPane').innerHTML = markdown(r.content || '');
    renderAttachments(entry); updateSaveStatus();
}
function renderAttachments(entry) {
    const ids = new Set([...String(entry.record.content || '').matchAll(/\/api\/files\/([^/\s)]+)\/download/g)].map(m => { try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; } }));
    const files = state.items.filter(r => r.filename && ids.has(String(r.id)));
    $('attachments').innerHTML = files.map(r => '<button class="attachment" data-open="' + esc(keyOf('items', r.id)) + '">▱ ' + esc(r.originalName || r.name || r.title || r.filename) + (r.trashed ? ' · In Trash' : '') + '</button>').join('');
}
function updateSaveStatus() {
    const entry = selected(); if (!entry || isFile(entry)) return;
    const pending = saves.entries.get(entry.key), error = pending?.error;
    $('autosaveText').textContent = error ? (error.status === 409 ? 'Conflicting changes — draft kept' : 'Unable to save — draft kept') : saves.dirty(entry.key) ? 'Saving…' : entry.record.trashed ? 'In Trash' : 'Saved';
    $('retryButton').hidden = !error || error.status === 409;
    $('saveAlert').hidden = !error;
    if (error) $('saveAlertText').textContent = error.message + ' Keep this page open until your draft is saved or downloaded.';
}
function editNote() {
    const entry = selected(); if (!entry || isFile(entry) || entry.record.trashed) return;
    const r = entry.record;
    const content = $('editorTextarea').value;
    let name = $('docTitle').value.trim();
    if (!name || name === 'Untitled') name = content.trim().split('\n')[0].replace(/^[#>*\s-]+/, '').slice(0, 80) || 'Untitled';
    const snapshot = entry.kind === 'tabs' ? { name, content, mode: r.mode || 'text' } : { title: name, content, type: r.type || 'text' };
    Object.assign(r, snapshot);
    saves.edit(entry.key, snapshot, r._revision);
}
async function newNote(content = '', name = 'Untitled', focus = true) {
    const result = await api('/tabs', { name, content, mode: 'text' }, 'POST');
    state.mutation++;
    // Refresh establishes the computed revision; don't permit edits without it.
    const data = await api('/workspace');
    const record = data.tabs.find(r => r.id === result.tab.id);
    replaceRecord('tabs', record);
    setView('notes'); openEntry(keyOf('tabs', record.id));
    if (focus) $('editorTextarea').focus();
    return record;
}
async function copy(text) {
    try { if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); toast('Copied'); return; } } catch (_) {}
    const node = document.createElement('textarea'); node.value = text; node.style.cssText = 'position:fixed;left:-9999px'; document.body.append(node); node.select();
    let ok; try { ok = document.execCommand('copy'); } finally { node.remove(); }
    if (!ok) throw new Error('Copy is unavailable in this browser. Select the text and copy it manually.');
    $('editorTextarea').focus(); toast('Copied');
}
function toast(message, undo) {
    clearTimeout(toastTimer); $('toastText').textContent = message; $('toast').hidden = false;
    undoAction = undo; $('undoButton').hidden = !undo;
    toastTimer = setTimeout(() => { $('toast').hidden = true; undoAction = null; }, undo ? 10000 : 5000);
}
function confirmAction(title, message, accept = 'Continue') {
    const dialog = $('confirmDialog');
    if (dialog.open) return Promise.resolve(false);
    $('confirmTitle').textContent = title; $('confirmMessage').textContent = message; $('confirmAccept').textContent = accept;
    return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); });
}
async function lifecycle(entry, action, value) {
    if (!entry) return;
    if (!(await saves.flush(entry.key, true))) throw new Error('Save or recover this draft before changing its status.');
    const result = await api('/' + entry.kind + '/' + encodeURIComponent(String(entry.record.id)) + '/' + action, { [action === 'trash' ? 'trashed' : action === 'archive' ? 'archived' : 'pinned']: value }, 'PATCH');
    state.mutation++; saves.forget(entry.key);
    const record = result.tab || result.item;
    replaceRecord(entry.kind, record);
    await refresh();
    toast(action === 'pin' ? (value ? 'Pinned' : 'Unpinned') : action === 'trash' ? (value ? 'Moved to Trash' : 'Restored') : (value ? 'Archived' : 'Restored from archive'), () => lifecycle(find(entry.key) || entry, action, !value));
}
function fileType(r) {
    const name = r.originalName || r.name || r.filename || '';
    const mime = String(r.mimetype || '').toLowerCase();
    if (/^image\//.test(mime)) return 'image';
    if (/^video\//.test(mime)) return 'video';
    if (/^audio\//.test(mime)) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    if (/^text\//.test(mime)) return 'text';
    if (mime && mime !== 'application/octet-stream') return 'file';
    if (['image', 'audio', 'video'].includes(r.fileType)) return r.fileType;
    if (/\.(png|jpe?g|gif|webp|avif|heic|svg|bmp|ico)$/i.test(name)) return 'image';
    if (/\.(mp4|mov|webm|mkv)$/i.test(name)) return 'video';
    if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(name)) return 'audio';
    if (/\.pdf$/i.test(name)) return 'pdf';
    if (/\.(txt|md|json|ya?ml|sh|conf|log|js|css|py)$/i.test(name)) return 'text';
    return 'file';
}
function renderFile(entry) {
    const r = entry.record, type = fileType(r), src = esc(mediaUrl(r));
    let preview = '';
    if (type === 'image') preview = '<img class="file-preview" src="' + src + '" alt="' + esc(titleOf(entry)) + '">';
    else if (type === 'video') preview = '<video class="file-preview" controls preload="metadata" src="' + src + '"></video>';
    else if (type === 'audio') preview = '<audio controls preload="metadata" src="' + src + '"></audio>';
    else if (type === 'pdf') preview = '<iframe sandbox class="file-preview" src="' + src + '" title="PDF preview"></iframe>';
    else if (type === 'text') preview = '<pre id="textFilePreview">Loading preview…</pre>';
    else preview = '<p class="file-meta">Download this file to open it on your device.</p>';
    $('fileDetail').innerHTML = '<h2>' + esc(titleOf(entry)) + '</h2><p class="file-meta">' + esc([bytes(r.size), date(dateOf(r)), r.mimetype, r.trashed ? 'In Trash' : r.archived ? 'Archived' : ''].filter(Boolean).join(' · ')) + '</p><div class="file-actions"><a class="primary-button" href="' + esc(downloadUrl(r)) + '" download>Download original</a>' + (type === 'image' ? '<button class="text-button" data-action="fullscreen">Fullscreen</button>' : '') + '<button class="text-button" data-action="file-link">Copy link</button></div>' + preview + '<details class="file-details"><summary>File details & transfer tools</summary><code>' + esc(r.sha256 ? 'SHA-256: ' + r.sha256 : 'Checksum not available') + '</code><button class="text-button" data-action="checksum"' + (r.sha256 ? '' : ' disabled') + '>Copy checksum</button><button class="text-button" data-action="curl">Copy curl command</button><p>Original bytes are kept without compression.</p></details><div class="file-actions">' + (!r.trashed ? '<button class="text-button" data-action="archive">' + (r.archived ? 'Restore from archive' : 'Archive') + '</button>' : '') + '<button class="text-button' + (!r.trashed ? ' danger' : '') + '" data-action="trash">' + (r.trashed ? 'Restore from Trash' : 'Move to Trash') + '</button>' + (r.trashed ? '<button class="text-button danger" data-action="purge">Delete forever…</button>' : '') + '</div>';
    if (type === 'text') {
        if (r.size > 1024 * 1024) { $('textFilePreview').textContent = 'This file is too large to preview. Download the original to read it.'; return; }
        fetch(mediaUrl(r), { cache: 'no-store' }).then(res => { if (!res.ok) throw new Error('Preview unavailable'); return res.text(); }).then(text => { if (state.selected === entry.key && $('textFilePreview')) $('textFilePreview').textContent = text; }).catch(() => { if (state.selected === entry.key && $('textFilePreview')) $('textFilePreview').textContent = 'Preview unavailable. You can still download the original.'; });
    }
}
function pickFiles(context = null) { uploadContext = context; $('filePicker').click(); }
async function uploadFiles(files, context) {
    if (!files.length || state.uploading) return;
    state.uploading = true;
    const target = context && find(context), attached = [];
    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file.size > 100 * 1024 * 1024) { toast(file.name + ' exceeds the 100 MB limit'); continue; }
            toast(`Adding ${file.name} (${i + 1}/${files.length})…`);
            const data = new FormData(); data.append('files', file);
            const res = await fetch('/api/files/upload', { method: 'POST', body: data });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || 'Upload failed');
            attached.push(...result.files);
        }
        await refresh();
        if (target && !target.record.trashed && attached.length) {
            const current = find(context);
            if (!current || current.record.trashed) throw new Error('Files were saved to the library. The original note is no longer available for attachments.');
            const links = attached.map(file => '[' + String(file.name || file.filename).replace(/[\[\]\n\r]/g, '') + '](' + downloadUrl(file) + ')').join('\n');
            const content = String(current.record.content || '') + '\n\n' + links;
            const snapshot = current.kind === 'tabs' ? { name: current.record.name, content, mode: current.record.mode || 'text' } : { title: current.record.title, content, type: current.record.type };
            Object.assign(current.record, snapshot); saves.edit(context, snapshot, current.record._revision);
            if (state.selected === context) { $('editorTextarea').value = content; renderAttachments(current); }
            await saves.flush(context);
        }
        toast(attached.length + (attached.length === 1 ? ' file added' : ' files added'));
    } finally { state.uploading = false; $('filePicker').value = ''; }
}
async function action(name, button) {
    const entry = selected();
    if (name === 'new') return state.view === 'documents' || state.view === 'media' ? pickFiles() : newNote();
    if (name === 'refresh') return refresh();
    if (name === 'library') { if (matchMedia('(max-width:800px)').matches) $('app').classList.toggle('library-open'); else { $('app').classList.toggle('library-hidden'); prefs.set('libraryHidden', $('app').classList.contains('library-hidden')); } return; }
    if (name === 'focus') { $('app').classList.toggle('focused'); return; }
    if (name === 'back') { if (entry) saves.flush(entry.key); $('app').classList.remove('show-detail'); restoreListScroll(); $('entryList').focus({ preventScroll: true }); return; }
    if (name === 'settings') { $('settingsDialog').showModal(); return; }
    if (name === 'retry') { await saves.flushAll(true); return; }
    if (name === 'collapse-row') { const item = find(button.dataset.key); state.collapsed[item.key] = !compact(item); prefs.set('collapsed', state.collapsed); renderList(); return; }
    if (name === 'collapse-all' || name === 'expand-all') { state.compact = name === 'collapse-all'; state.collapsed = {}; prefs.set('compact', state.compact); prefs.set('collapsed', {}); renderList(); return; }
    if (name === 'group') { const key = button.dataset.group; state.groups[key] = !state.groups[key]; prefs.set('groups', state.groups); renderList(); return; }
    if (name === 'empty-trash') {
        if (saves.anyDirty()) throw new Error('Save or recover pending drafts before emptying Trash.');
        if (await confirmAction('Empty Trash?', 'All notes and files in Trash will be permanently removed. This cannot be undone.', 'Empty Trash')) { await api('/trash/empty', { confirm: true }, 'POST'); state.mutation++; await refresh(); toast('Trash emptied'); } return;
    }
    if (!entry) return;
    if (name === 'copy') return copy(entry.record.content || '');
    if (name === 'minimize') { saves.flush(entry.key); state.minimized[entry.key] = true; prefs.set('minimized', state.minimized); $('app').classList.add('minimized'); if (matchMedia('(max-width:600px)').matches) { $('app').classList.remove('show-detail'); restoreListScroll(); } renderList(); return; }
    if (name === 'restore-editor') { delete state.minimized[entry.key]; prefs.set('minimized', state.minimized); $('app').classList.remove('minimized'); $('editorTextarea').focus(); return; }
    if (name === 'preview') { state.preview = !state.preview; renderDetail(); return; }
    if (name === 'mode') { entry.record.mode = entry.record.mode === 'code' || entry.record.type === 'code' ? 'text' : 'code'; if (entry.kind === 'items') entry.record.type = entry.record.mode; editNote(); renderDetail(); return; }
    if (name === 'heading' || name === 'checklist') { state.preview = false; $('editorTextarea').hidden = false; $('markdownPreviewPane').hidden = true; const ta = $('editorTextarea'); ta.setRangeText(name === 'heading' ? '# ' : '- [ ] ', ta.selectionStart, ta.selectionEnd, 'end'); editNote(); ta.focus(); return; }
    if (name === 'pin') return lifecycle(entry, 'pin', !entry.record.pinned);
    if (name === 'archive') return lifecycle(entry, 'archive', !entry.record.archived);
    if (name === 'trash') {
        if (entry.record.trashed || await confirmAction('Move to Trash?', 'This entry can be restored from Trash. Minimizing keeps it in your library without deleting it.', 'Move to Trash')) return lifecycle(entry, 'trash', !entry.record.trashed);
        return;
    }
    if (name === 'purge') {
        if (!entry.record.trashed) return;
        if (await confirmAction('Delete forever?', 'This entry will be permanently deleted. This cannot be undone.', 'Delete forever')) { await api('/' + entry.kind + '/' + encodeURIComponent(String(entry.record.id)), undefined, 'DELETE'); state.mutation++; await refresh(); toast('Deleted forever'); } return;
    }
    if (name === 'snapshot') { if (!entry.record.content?.trim()) throw new Error('Write something before saving a copy.'); await api('/items', { content: entry.record.content, title: titleOf(entry), tabId: entry.record.id }, 'POST'); state.mutation++; await refresh(); toast('Copy saved to history'); return; }
    if (name === 'duplicate') return newNote(entry.record.content || '', titleOf(entry) + ' copy');
    if (name === 'recover') {
        const key = entry.key, content = entry.record.content || '', title = titleOf(entry) + ' (recovered)';
        await newNote(content, title); saves.forget(key); await refresh(); toast('Draft saved as a separate note'); return;
    }
    if (name === 'reload-note') {
        if (await confirmAction('Use the server version?', 'This discards your unsaved local changes. Save or download the draft first if you need it.', 'Use server version')) { saves.forget(entry.key); await refresh(); renderDetail(); } return;
    }
    if (name === 'export-draft') { const blob = new Blob([entry.record.content || ''], { type: 'text/plain;charset=utf-8' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = titleOf(entry).replace(/[\\/:*?"<>|]/g, '-') + '.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return; }
    if (name === 'attach') return pickFiles(entry.key);
    if (name === 'file-link') return copy(location.origin + downloadUrl(entry.record));
    if (name === 'curl') return copy('curl -fLOJ ' + "'" + location.origin + downloadUrl(entry.record).replace(/'/g, "'\\''") + "'");
    if (name === 'checksum') return copy(entry.record.sha256 || '');
    if (name === 'fullscreen') { const image = $('fileDetail').querySelector('img'); if (image?.requestFullscreen) return image.requestFullscreen(); window.open(mediaUrl(entry.record), '_blank', 'noopener,noreferrer'); return; }
}
function run(promise) { Promise.resolve(promise).catch(error => toast(error.message || 'Something went wrong. Please retry.')); }
document.addEventListener('click', event => {
    const target = event.target.closest('[data-action], [data-open], [data-view]');
    if (target) {
        if (target.dataset.view) setView(target.dataset.view);
        else if (target.dataset.open) openEntry(target.dataset.open);
        else run(action(target.dataset.action, target));
        document.querySelectorAll('.menu[open]').forEach(menu => { menu.open = false; });
    } else document.querySelectorAll('.menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
    if ($('app').classList.contains('library-open') && !event.target.closest('#library, [data-action="library"]')) $('app').classList.remove('library-open');
});
$('entryList').addEventListener('scroll', rememberListScroll, { passive: true });
window.addEventListener('resize', restoreListScroll);
$('editorTextarea').addEventListener('input', editNote);
$('docTitle').addEventListener('input', editNote);
$('editorTextarea').addEventListener('blur', () => { const entry = selected(); if (entry) $('docTitle').value = titleOf(entry); scheduleRefresh(); });
$('docTitle').addEventListener('blur', () => { const entry = selected(); if (entry) $('docTitle').value = titleOf(entry); });
$('searchInput').addEventListener('input', event => {
    resetListScroll();
    state.query = event.target.value.trim();
    $('scopeHint').hidden = !state.query;
    $('scopeHint').textContent = ['archive', 'trash'].includes(state.view) ? 'Searching ' + state.view : 'Searching Notes, Documents & Media';
    renderList();
});
$('listFilter').addEventListener('change', event => { resetListScroll(); state.filter = event.target.value; renderList(); });
$('filePicker').addEventListener('change', event => run(uploadFiles([...event.target.files], uploadContext)));
$('undoButton').addEventListener('click', () => { const undo = undoAction; $('toast').hidden = true; undoAction = null; if (undo) run(undo()); });
$('themeSelect').value = prefs.get('theme', 'system');
function theme(value) { document.documentElement.dataset.theme = value; prefs.set('theme', value); }
theme($('themeSelect').value);
$('themeSelect').addEventListener('change', event => theme(event.target.value));
$('app').classList.toggle('library-hidden', prefs.get('libraryHidden', false));
window.addEventListener('beforeunload', event => { if (saves.anyDirty() || state.uploading) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden) saves.flushAll(); else scheduleRefresh(); });
window.addEventListener('online', () => { scheduleRefresh(); saves.flushAll(true); });
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { document.querySelectorAll('.menu[open]').forEach(el => { el.open = false; }); $('app').classList.remove('library-open'); }
    if ($('settingsDialog').open || $('confirmDialog').open) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); run(saves.flushAll(true)); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); $('app').classList.remove('focused', 'show-detail'); restoreListScroll(); $('searchInput').focus(); }
    if (event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); run(newNote()); }
    if (event.altKey && event.key.toLowerCase() === 'm') { event.preventDefault(); run(action('minimize')); }
    if (event.target === $('editorTextarea') && event.key === 'Tab' && selected()?.record.mode === 'code') { event.preventDefault(); const ta = $('editorTextarea'); ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end'); editNote(); }
});
function dragFiles(event) { return [...(event.dataTransfer?.types || [])].includes('Files'); }
let dragDepth = 0;
window.addEventListener('dragenter', event => { if (dragFiles(event)) { event.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; $('dropContext').textContent = selected() && !isFile(selected()) && !selected().record.trashed && $('app').classList.contains('show-detail') ? 'to this note and your library' : 'to your library'; } });
window.addEventListener('dragover', event => { if (dragFiles(event)) event.preventDefault(); });
window.addEventListener('dragleave', event => { if (dragFiles(event) && --dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('drop', event => { if (!dragFiles(event)) return; event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true; const entry = selected(); run(uploadFiles([...event.dataTransfer.files], entry && !isFile(entry) && !entry.record.trashed && $('app').classList.contains('show-detail') ? entry.key : null)); });
window.addEventListener('paste', event => {
    if ($('confirmDialog').open || $('settingsDialog').open || !event.clipboardData?.files.length || event.clipboardData.getData('text/plain')) return;
    event.preventDefault(); const entry = selected(); run(uploadFiles([...event.clipboardData.files], entry && !isFile(entry) && !entry.record.trashed && event.target === $('editorTextarea') ? entry.key : null));
});
const events = new EventSource('/api/events');
events.onopen = () => { $('connectionStatus').textContent = 'Connected'; $('connectionStatus').classList.remove('offline'); scheduleRefresh(); };
events.onerror = () => { $('connectionStatus').textContent = 'Reconnecting…'; $('connectionStatus').classList.add('offline'); };
for (const name of ['item_created', 'item_updated', 'item_deleted', 'tab_created', 'tab_updated', 'tab_deleted', 'tabs_reordered', 'files_uploaded', 'file_deleted']) events.addEventListener(name, scheduleRefresh);
refresh();
