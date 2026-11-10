/* Shared, dependency-free behavior used by the browser and isolated regression tests. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.WorkspaceCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    function fileCategory(file) {
        const mime = String(file.mimetype || '').toLowerCase();
        if (/^(image|audio|video)\//.test(mime)) return 'media';
        if (mime && mime !== 'application/octet-stream') return 'documents';
        if (['image', 'audio', 'video'].includes(file.fileType)) return 'media';
        return /\.(png|jpe?g|gif|webp|avif|heic|svg|bmp|ico|mp4|mov|webm|mkv|mp3|wav|ogg|m4a|flac)$/i.test(file.originalName || file.name || file.filename || '') ? 'media' : 'documents';
    }
    function safeLink(url) {
        if (/^\/api\/files\/[^/?#]+\/download$/.test(url)) return url;
        try { const parsed = new URL(url); return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null; }
        catch (_) { return null; }
    }
    function markdown(raw) {
        // Parse blocks before inline formatting so code cannot become markup or active links.
        function inline(text) {
            const parts = String(text).split(/(`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>]+)/g);
            return parts.map(part => {
                if (/^`[^`]+`$/.test(part)) return '<code>' + escape(part.slice(1, -1)) + '</code>';
                const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
                const url = safeLink(match ? match[2] : part);
                if (url) return '<a href="' + escape(url) + '" target="_blank" rel="noopener noreferrer">' + escape(match ? match[1] : part) + '</a>';
                return escape(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
            }).join('');
        }
        const out = []; let code = null;
        for (const line of String(raw).split('\n')) {
            if (/^\s*```/.test(line)) {
                if (code !== null) { out.push('<pre><code>' + escape(code.join('\n')) + '</code></pre>'); code = null; }
                else code = [];
                continue;
            }
            if (code !== null) { code.push(line); continue; }
            const heading = line.match(/^(#{1,3})\s+(.*)$/);
            const check = line.match(/^\s*- \[([ xX])\] (.*)$/);
            if (heading) out.push('<h' + heading[1].length + '>' + inline(heading[2]) + '</h' + heading[1].length + '>');
            else if (check) out.push('<p class="checklist">' + (check[1] === ' ' ? '☐ ' : '☑ ') + inline(check[2]) + '</p>');
            else if (/^> /.test(line)) out.push('<blockquote>' + inline(line.slice(2)) + '</blockquote>');
            else if (/^- /.test(line)) out.push('<p class="bullet">• ' + inline(line.slice(2)) + '</p>');
            else if (/^---\s*$/.test(line)) out.push('<hr>');
            else out.push(line ? '<p>' + inline(line) + '</p>' : '<br>');
        }
        if (code !== null) out.push('<pre><code>' + escape(code.join('\n')) + '</code></pre>');
        return out.join('');
    }
    class SaveQueue {
        constructor(send, changed = () => {}, delay = 600) {
            this.send = send; this.changed = changed; this.delay = delay; this.entries = new Map();
        }
        edit(key, snapshot, revision) {
            let entry = this.entries.get(key);
            if (!entry) { entry = { revision, generation: 0, pending: null, running: null, error: null }; this.entries.set(key, entry); }
            if (!entry.pending && !entry.running && !entry.error) entry.revision = revision;
            entry.generation++;
            entry.pending = { ...snapshot }; // Capture record identity and values now, never from a later editor.
            clearTimeout(entry.timer);
            if (!entry.error) entry.timer = setTimeout(() => this.flush(key), this.delay);
            this.changed(key, entry);
        }
        async flush(key, retry = false) {
            const entry = this.entries.get(key);
            if (!entry) return true;
            clearTimeout(entry.timer);
            if (entry.running) { await entry.running; return this.flush(key, retry); }
            if (!entry.pending) return !entry.error;
            if (entry.error && (!retry || entry.error.status === 409)) return false;
            entry.error = null;
            const snapshot = entry.pending, generation = entry.generation;
            entry.running = Promise.resolve().then(() => this.send(key, snapshot, entry.revision)).then(result => {
                entry.revision = result.revision;
                if (entry.generation === generation) entry.pending = null;
                return true;
            }).catch(error => { entry.error = error; return false; });
            this.changed(key, entry);
            const ok = await entry.running;
            entry.running = null;
            this.changed(key, entry);
            if (ok && entry.pending) return this.flush(key);
            return ok;
        }
        async flushAll(retry = false) { return (await Promise.all([...this.entries.keys()].map(key => this.flush(key, retry)))).every(Boolean); }
        dirty(key) { const e = this.entries.get(key); return !!(e && (e.pending || e.running || e.error)); }
        anyDirty() { return [...this.entries.keys()].some(key => this.dirty(key)); }
        forget(key) { const e = this.entries.get(key); if (e) clearTimeout(e.timer); this.entries.delete(key); }
    }
    return { escape, fileCategory, safeLink, markdown, SaveQueue };
});
