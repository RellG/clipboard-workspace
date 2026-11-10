const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SaveQueue, markdown, safeLink, fileCategory } = require('../assets/workspace-core');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'assets/workspace.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/workspace.css'), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

describe('Tier 4: Notes behavior and safe previews', () => {
    it('Captures independent note drafts before a rapid switch and flushes to their own IDs', async () => {
        const sent = [];
        const queue = new SaveQueue(async (key, body, revision) => { sent.push({ key, body, revision }); return { revision: key + '-saved' }; }, () => {}, 60000);
        const body = { content: 'Alpha draft', name: 'Alpha' };
        queue.edit('tabs:a', body, 'a-base'); body.content = 'Other editor text';
        queue.edit('tabs:b', { content: 'Beta draft', name: 'Beta' }, 'b-base');
        assert.equal(await queue.flushAll(), true);
        assert.deepEqual(sent.map(s => [s.key, s.body.content, s.revision]), [['tabs:a', 'Alpha draft', 'a-base'], ['tabs:b', 'Beta draft', 'b-base']]);
        assert.equal(queue.anyDirty(), false);
    });
    it('Serializes edits made while a save is in flight and uses the acknowledged revision', async () => {
        const first = deferred(), calls = [];
        const queue = new SaveQueue(async (key, body, revision) => { calls.push([body.content, revision]); if (calls.length === 1) await first.promise; return { revision: 'v' + calls.length }; }, () => {}, 60000);
        queue.edit('tabs:a', { content: 'one' }, 'v0');
        const flushing = queue.flush('tabs:a'); await Promise.resolve();
        queue.edit('tabs:a', { content: 'two' }, 'v0');
        first.resolve(); assert.equal(await flushing, true);
        assert.deepEqual(calls, [['one', 'v0'], ['two', 'v1']]);
        assert.equal(queue.dirty('tabs:a'), false);
    });
    it('Keeps failed drafts and retries without reporting saved', async () => {
        let fail = true;
        const queue = new SaveQueue(async () => { if (fail) throw new Error('Disk full'); return { revision: 'v1' }; }, () => {}, 60000);
        queue.edit('tabs:a', { content: 'recover me' }, 'v0');
        assert.equal(await queue.flush('tabs:a'), false);
        assert.equal(queue.dirty('tabs:a'), true);
        assert.equal(queue.entries.get('tabs:a').pending.content, 'recover me');
        fail = false; assert.equal(await queue.flush('tabs:a', true), true);
        assert.equal(queue.anyDirty(), false);
    });
    it('Never automatically overwrites a conflict, even when retry is requested', async () => {
        let calls = 0;
        const queue = new SaveQueue(async () => { calls++; throw Object.assign(new Error('Conflict'), { status: 409 }); }, () => {}, 60000);
        queue.edit('tabs:a', { content: 'mine' }, 'old');
        assert.equal(await queue.flush('tabs:a'), false);
        queue.edit('tabs:a', { content: 'mine, continued' }, 'old');
        assert.equal(await queue.flushAll(true), false);
        assert.equal(calls, 1); assert.equal(queue.entries.get('tabs:a').pending.content, 'mine, continued');
        queue.forget('tabs:a');
    });
    it('Uses a refreshed server revision when editing a previously saved note again', async () => {
        const versions = [];
        const queue = new SaveQueue(async (key, body, revision) => { versions.push(revision); return { revision: 'local-saved' }; }, () => {}, 60000);
        queue.edit('tabs:a', { content: 'one' }, 'v0'); await queue.flushAll();
        queue.edit('tabs:a', { content: 'two' }, 'remote-newer'); await queue.flushAll();
        assert.deepEqual(versions, ['v0', 'remote-newer']);
    });
    it('Treats uploaded documents separately from image, video and audio files', () => {
        assert.equal(fileCategory({ mimetype: 'application/pdf', name: 'manual.pdf' }), 'documents');
        assert.equal(fileCategory({ mimetype: 'text/plain', name: 'misleading.mp4' }), 'documents');
        for (const mimetype of ['image/png', 'video/mp4', 'audio/ogg']) assert.equal(fileCategory({ mimetype }), 'media');
        assert.equal(fileCategory({ mimetype: 'application/octet-stream', name: 'video.MOV' }), 'media');
        assert.equal(fileCategory({ name: 'backup.bin' }), 'documents');
    });
    it('Renders notes without active HTML, unsafe URL schemes or interactive unsaved checkboxes', () => {
        const output = markdown('<img src=x onerror=alert(1)>\n[click](javascript:alert)\n- [ ] task\n```html\n<script>alert(1)</script>\n```');
        assert.ok(!output.includes('<img')); assert.ok(!output.includes('<script>')); assert.ok(!output.includes('href="javascript:'));
        assert.ok(!output.includes('<input')); assert.ok(output.includes('☐ task'));
        assert.ok(output.includes('&lt;script&gt;'));
        for (const url of ['javascript:alert(1)', 'data:text/html,hi', '//evil.test/path', '/api/trash/empty']) assert.equal(safeLink(url), null);
        assert.equal(safeLink('/api/files/123/download'), '/api/files/123/download');
        assert.ok(markdown('[example](https://example.com)').includes('rel="noopener noreferrer"'));
    });
    it('Provides zoom, labeled local assets, mobile list navigation and a single search field', () => {
        assert.ok(!/maximum-scale=1|user-scalable=no/.test(html));
        assert.equal((html.match(/type="search"/g) || []).length, 1);
        assert.ok(!/https:\/\/fonts\./.test(html));
        for (const name of ['workspace.css', 'workspace-core.js', 'workspace.js']) assert.ok(fs.existsSync(path.join(root, 'assets', name)));
        assert.ok(css.includes('@media(max-width:600px)')); assert.ok(css.includes('.app.show-detail .detail'));
        assert.ok(app.includes("event.key.toLowerCase() === 's'"));
        assert.ok(app.includes('saves.flushAll(true)')); assert.ok(app.includes("document.execCommand('copy')"));
        assert.ok(!app.includes('requestAnimationFrame')); assert.ok(!app.includes("localStorage.setItem('content'"));
    });
});
