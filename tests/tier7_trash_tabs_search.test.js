const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fetchApi, startSeededServer, sha } = require('./test_helpers');

// Like Tier 6, these always run against their own isolated, seeded servers.

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const DAY = 86400000;
const agoIso = (days) => new Date(Date.now() - days * DAY).toISOString();

function note(id, extra = {}) {
    const t = '2026-09-01T10:00:00.000Z';
    return { id, type: 'text', title: `note ${id}`, content: `content ${id}`, tags: [], pinned: false, tabId: 'scratchpad', timestamp: t, createdAt: t, updatedAt: t, ...extra };
}
function fileItem(id, filename, bytes, extra = {}) {
    const t = '2026-09-01T10:00:00.000Z';
    return {
        id, type: 'file', fileType: 'image', title: filename, name: filename, originalName: filename, filename,
        size: bytes.length, mimetype: 'image/png', sha256: sha(bytes), pinned: false, tags: ['image'],
        timestamp: t, createdAt: t, updatedAt: t, downloadUrl: `/api/files/${id}/download`, ...extra
    };
}
function tab(id, name, content, extra = {}) {
    return { id, name, icon: 'doc', content, mode: 'markdown', updatedAt: '2026-09-01T10:00:00.000Z', ...extra };
}

describe('Tier 7: Trash, auto-purge, tab ordering', () => {
    describe('Trash API (items)', () => {
        let server;
        let baseUrl;

        before(async () => {
            server = await startSeededServer({ version: 2, items: [], tabs: [] });
            baseUrl = server.baseUrl;
        });
        after(async () => { if (server) await server.stop(); });

        async function createNote(content) {
            const res = await fetchApi(baseUrl, '/api/items', json('POST', { content, type: 'text' }));
            return res.body.item;
        }
        async function uploadFile(bytes, name) {
            const form = new FormData();
            form.append('files', new Blob([bytes]), name);
            return (await (await fetch(`${baseUrl}/api/files/upload`, { method: 'POST', body: form })).json()).files[0];
        }

        it('PATCH trash sets trashed + trashedAt without touching updatedAt/content; restore returns the exact original item', async () => {
            const n = await createNote('trash me');
            const original = JSON.stringify(server.readDb().items.find(i => i.id === n.id));

            const r = await fetchApi(baseUrl, `/api/items/${n.id}/trash`, json('PATCH', { trashed: true }));
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.body.item.trashed, true);
            assert.ok(Date.parse(r.body.item.trashedAt) > 0);
            assert.strictEqual(r.body.item.updatedAt, n.updatedAt);
            assert.strictEqual(r.body.item.content, 'trash me');

            await fetchApi(baseUrl, `/api/items/${n.id}/trash`, json('PATCH', { trashed: false }));
            assert.strictEqual(JSON.stringify(server.readDb().items.find(i => i.id === n.id)), original);
        });

        it('?trashed=true|false filter; omitted returns everything (backward compatible); unknown id is 404', async () => {
            const live = await createNote('live one');
            const gone = await createNote('gone one');
            await fetchApi(baseUrl, `/api/items/${gone.id}/trash`, { method: 'PATCH' });

            const all = (await fetchApi(baseUrl, '/api/items')).body.map(i => i.id);
            const tr = (await fetchApi(baseUrl, '/api/items?trashed=true')).body.map(i => i.id);
            const nt = (await fetchApi(baseUrl, '/api/items?trashed=false')).body.map(i => i.id);
            assert.ok(all.includes(live.id) && all.includes(gone.id));
            assert.ok(tr.includes(gone.id) && !tr.includes(live.id));
            assert.ok(nt.includes(live.id) && !nt.includes(gone.id));
            assert.strictEqual((await fetchApi(baseUrl, '/api/items/nope/trash', { method: 'PATCH' })).status, 404);
        });

        it('Bulk trash validates input and reports only real changes', async () => {
            const a = await createNote('bulk a');
            for (const bad of [{}, { ids: [], trashed: true }, { ids: ['x'], trashed: 'yes' }, { ids: 'x', trashed: true }]) {
                assert.strictEqual((await fetchApi(baseUrl, '/api/items/trash', json('POST', bad))).status, 400);
            }
            const ok = await fetchApi(baseUrl, '/api/items/trash', json('POST', { ids: [a.id, 'ghost'], trashed: true }));
            assert.deepStrictEqual(ok.body.changed, [a.id]);
            const again = await fetchApi(baseUrl, '/api/items/trash', json('POST', { ids: [a.id], trashed: true }));
            assert.deepStrictEqual(again.body.changed, []);
        });

        it('A trashed file stays on disk and downloads bit-exact; restoring brings it back', async () => {
            const bytes = crypto.randomBytes(16 * 1024);
            const meta = await uploadFile(bytes, 'trash-keep.bin');
            await fetchApi(baseUrl, `/api/files/${meta.id}/trash`, json('PATCH', { trashed: true }));

            assert.ok(fs.existsSync(path.join(server.uploadsDir, meta.filename)), 'file must stay on disk while trashed');
            const listed = (await fetchApi(baseUrl, '/api/files?trashed=true')).body;
            assert.ok(listed.some(f => f.id === meta.id && f.trashed === true));
            const dl = Buffer.from(await (await fetch(`${baseUrl}/api/files/${meta.id}/download`)).arrayBuffer());
            assert.strictEqual(sha(dl), sha(bytes));

            await fetchApi(baseUrl, `/api/files/${meta.id}/trash`, json('PATCH', { trashed: false }));
            assert.ok((await fetchApi(baseUrl, '/api/files?trashed=false')).body.some(f => f.id === meta.id));
        });

        it('Archive and trash flags are independent: archive -> trash -> restore leaves the item archived', async () => {
            const n = await createNote('both flags');
            await fetchApi(baseUrl, `/api/items/${n.id}/archive`, json('PATCH', { archived: true }));
            await fetchApi(baseUrl, `/api/items/${n.id}/trash`, json('PATCH', { trashed: true }));
            await fetchApi(baseUrl, `/api/items/${n.id}/trash`, json('PATCH', { trashed: false }));
            const item = server.readDb().items.find(i => i.id === n.id);
            assert.strictEqual(item.archived, true);
            assert.ok(!('trashed' in item) && !('trashedAt' in item));
        });

        it('DELETE stays a permanent delete (removes file from disk) even for trashed items', async () => {
            const meta = await uploadFile(Buffer.from('bye'), 'bye.txt');
            await fetchApi(baseUrl, `/api/files/${meta.id}/trash`, { method: 'PATCH' });
            assert.strictEqual((await fetchApi(baseUrl, `/api/files/${meta.id}`, { method: 'DELETE' })).status, 200);
            assert.ok(!fs.existsSync(path.join(server.uploadsDir, meta.filename)));
        });

        it('POST /api/trash/empty requires confirm:true, then removes only trashed entries (and their files)', async () => {
            const keep = await createNote('keep me');
            const meta = await uploadFile(Buffer.from('trash file'), 'empty-me.txt');
            const tabRes = await fetchApi(baseUrl, '/api/tabs', json('POST', { name: 'Doomed', content: 'tab text' }));
            const keepTab = await fetchApi(baseUrl, '/api/tabs', json('POST', { name: 'Keeper', content: 'keep tab' }));
            await fetchApi(baseUrl, `/api/files/${meta.id}/trash`, { method: 'PATCH' });
            await fetchApi(baseUrl, `/api/tabs/${tabRes.body.tab.id}/trash`, { method: 'PATCH' });

            assert.strictEqual((await fetchApi(baseUrl, '/api/trash/empty', json('POST', {}))).status, 400);
            assert.strictEqual((await fetchApi(baseUrl, '/api/trash/empty', json('POST', { confirm: 'true' }))).status, 400);
            assert.ok(server.readDb().items.some(i => i.id === meta.id), 'nothing may be removed without confirm');

            const res = await fetchApi(baseUrl, '/api/trash/empty', json('POST', { confirm: true }));
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.items >= 1 && res.body.tabs === 1);

            const db = server.readDb();
            assert.ok(db.items.some(i => i.id === keep.id), 'untrashed item must survive');
            assert.ok(!db.items.some(i => i.id === meta.id));
            assert.ok(!fs.existsSync(path.join(server.uploadsDir, meta.filename)));
            assert.ok(db.tabs.some(t => t.id === keepTab.body.tab.id) && !db.tabs.some(t => t.id === tabRes.body.tab.id));
            assert.ok(fs.readdirSync(path.join(server.dataDir, 'snapshots')).some(f => /-purge\.json$/.test(f)), 'a purge snapshot must exist');
        });

        it('Health reports trash counts and retention', async () => {
            const n = await createNote('count me');
            await fetchApi(baseUrl, `/api/items/${n.id}/trash`, { method: 'PATCH' });
            const h = (await fetchApi(baseUrl, '/api/health')).body;
            assert.ok(h.trashedItems >= 1);
            assert.strictEqual(typeof h.trashedTabs, 'number');
            assert.strictEqual(h.trashRetentionDays, 30);
        });
    });

    describe('Tab trash and tab ordering', () => {
        let server;
        let baseUrl;
        const seedTabs = [
            tab('scratchpad', 'Main', 'main text\nline 2'),
            tab('notes', 'Quick Notes', 'quick'),
            tab('tab_a', 'Alpha', 'alpha content ' + 'x'.repeat(2000)),
            tab('tab_b', 'Beta', 'beta content'),
            tab('tab_c', 'Gamma', 'gamma content')
        ];

        before(async () => {
            server = await startSeededServer({ version: 2, items: [], tabs: JSON.parse(JSON.stringify(seedTabs)) });
            baseUrl = server.baseUrl;
        });
        after(async () => { if (server) await server.stop(); });

        const order = async () => (await fetchApi(baseUrl, '/api/tabs')).body.map(t => t.id);

        it('Default tabs cannot be trashed; unknown tab is 404', async () => {
            assert.strictEqual((await fetchApi(baseUrl, '/api/tabs/scratchpad/trash', { method: 'PATCH' })).status, 400);
            assert.strictEqual((await fetchApi(baseUrl, '/api/tabs/notes/trash', { method: 'PATCH' })).status, 400);
            assert.strictEqual((await fetchApi(baseUrl, '/api/tabs/ghost/trash', { method: 'PATCH' })).status, 404);
        });

        it('Trashing a tab keeps its text; restoring returns the exact original tab; ?trashed filters work', async () => {
            const before = JSON.stringify(server.readDb().tabs.find(t => t.id === 'tab_b'));
            const r = await fetchApi(baseUrl, '/api/tabs/tab_b/trash', json('PATCH', { trashed: true }));
            assert.strictEqual(r.body.tab.trashed, true);
            assert.strictEqual(r.body.tab.content, 'beta content');
            assert.deepStrictEqual((await fetchApi(baseUrl, '/api/tabs?trashed=true')).body.map(t => t.id), ['tab_b']);
            assert.ok(!(await fetchApi(baseUrl, '/api/tabs?trashed=false')).body.some(t => t.id === 'tab_b'));
            assert.ok((await fetchApi(baseUrl, '/api/tabs')).body.some(t => t.id === 'tab_b'), 'default list still returns everything');

            await fetchApi(baseUrl, '/api/tabs/tab_b/trash', json('PATCH', { trashed: false }));
            const after = JSON.stringify(server.readDb().tabs.find(t => t.id === 'tab_b'));
            assert.ok(after.includes('"content":"beta content"'));
            assert.strictEqual(after.replace(/"updatedAt":"[^"]*"/, ''), before.replace(/"updatedAt":"[^"]*"/, ''));
        });

        it('PUT /api/tabs/order reorders, persists to disk, and never changes tab contents', async () => {
            const contentsBefore = Object.fromEntries(server.readDb().tabs.map(t => [t.id, t.content]));
            const want = ['tab_c', 'scratchpad', 'tab_a', 'notes', 'tab_b'];
            const res = await fetchApi(baseUrl, '/api/tabs/order', json('PUT', { ids: want }));
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(await order(), want);
            assert.deepStrictEqual(server.readDb().tabs.map(t => t.id), want, 'order must be persisted');
            for (const t of server.readDb().tabs) assert.strictEqual(t.content, contentsBefore[t.id], `${t.id} content unchanged`);
        });

        it('Order request: unknown/duplicate ids ignored, unlisted tabs kept after listed ones, never creates a tab named "order"', async () => {
            await fetchApi(baseUrl, '/api/tabs/order', json('PUT', { ids: ['tab_b', 'ghost', 'tab_b', 'tab_a'] }));
            const ids = await order();
            assert.deepStrictEqual(ids.slice(0, 2), ['tab_b', 'tab_a']);
            assert.strictEqual(ids.length, 5, 'no tab may be added or dropped');
            assert.ok(!ids.includes('order') && !ids.includes('ghost'));
        });

        it('Order request validation', async () => {
            for (const bad of [{}, { ids: [] }, { ids: 'tab_a' }, { ids: [1, 2] }]) {
                assert.strictEqual((await fetchApi(baseUrl, '/api/tabs/order', json('PUT', bad))).status, 400, JSON.stringify(bad));
            }
            assert.strictEqual((await order()).length, 5);
        });

        it('Trashed tabs keep their place relative to reordering and are not lost', async () => {
            await fetchApi(baseUrl, '/api/tabs/tab_c/trash', json('PATCH', { trashed: true }));
            await fetchApi(baseUrl, '/api/tabs/order', json('PUT', { ids: ['notes', 'scratchpad', 'tab_a', 'tab_b'] }));
            const ids = await order();
            assert.strictEqual(ids.length, 5);
            assert.ok(ids.includes('tab_c'));
            assert.strictEqual(server.readDb().tabs.find(t => t.id === 'tab_c').content, 'gamma content');
        });
    });

    describe('Auto-purge (30-day retention) only removes expired, trashed entries', () => {
        const bytes = (n) => crypto.randomBytes(n);

        function buildSeed() {
            const files = {
                'expired.png': bytes(512), 'recent.png': bytes(512), 'nodate.png': bytes(512),
                'baddate.png': bytes(512), 'shared.png': bytes(512), 'archived-old.png': bytes(512), 'live.png': bytes(512)
            };
            const items = [
                note('legacy-1'),
                note('legacy-2', { pinned: true }),
                fileItem('f-live', 'live.png', files['live.png']),
                fileItem('f-archived', 'archived-old.png', files['archived-old.png'], { archived: true, archivedAt: agoIso(400) }),
                fileItem('f-expired', 'expired.png', files['expired.png'], { trashed: true, trashedAt: agoIso(40) }),
                fileItem('f-recent', 'recent.png', files['recent.png'], { trashed: true, trashedAt: agoIso(5) }),
                fileItem('f-nodate', 'nodate.png', files['nodate.png'], { trashed: true }),
                fileItem('f-baddate', 'baddate.png', files['baddate.png'], { trashed: true, trashedAt: 'not-a-date' }),
                // Two records pointing at one file: the expired one must not delete the file the live one needs
                fileItem('f-shared-old', 'shared.png', files['shared.png'], { trashed: true, trashedAt: agoIso(90) }),
                fileItem('f-shared-live', 'shared.png', files['shared.png']),
                note('n-expired', { trashed: true, trashedAt: agoIso(31) }),
                note('n-recent', { trashed: true, trashedAt: agoIso(29) })
            ];
            const tabs = [
                tab('scratchpad', 'Main', 'main'), tab('notes', 'Quick Notes', 'q'),
                tab('tab_old', 'Old tab', 'old text', { trashed: true, trashedAt: agoIso(45) }),
                tab('tab_new', 'New tab', 'new text', { trashed: true, trashedAt: agoIso(2) }),
                tab('tab_live', 'Live tab', 'live text')
            ];
            return { db: { version: 2, items, tabs }, files };
        }

        it('On boot: purges only trashed entries older than 30 days, keeps everything else, and snapshots first', async () => {
            const { db, files } = buildSeed();
            const original = JSON.stringify(db, null, 2);
            const server = await startSeededServer(db, files);
            try {
                const after = server.readDb();
                const ids = new Set(after.items.map(i => i.id));
                for (const gone of ['f-expired', 'f-shared-old', 'n-expired']) assert.ok(!ids.has(gone), `${gone} should be purged`);
                for (const kept of ['legacy-1', 'legacy-2', 'f-live', 'f-archived', 'f-recent', 'f-nodate', 'f-baddate', 'f-shared-live', 'n-recent']) {
                    assert.ok(ids.has(kept), `${kept} must be kept`);
                }
                const tabIds = after.tabs.map(t => t.id);
                assert.ok(!tabIds.includes('tab_old'));
                for (const kept of ['scratchpad', 'notes', 'tab_new', 'tab_live']) assert.ok(tabIds.includes(kept), `${kept} must be kept`);

                const exists = (n) => fs.existsSync(path.join(server.uploadsDir, n));
                assert.ok(!exists('expired.png'), 'expired file removed from disk');
                for (const n of ['recent.png', 'nodate.png', 'baddate.png', 'live.png', 'archived-old.png']) assert.ok(exists(n), `${n} must stay on disk`);
                assert.ok(exists('shared.png'), 'a file still referenced by a live item must not be deleted');

                // Untouched legacy entries are deep-equal to the seed
                for (const id of ['legacy-1', 'legacy-2', 'f-live', 'f-archived', 'f-recent', 'f-nodate', 'f-baddate', 'n-recent']) {
                    assert.deepStrictEqual(after.items.find(i => i.id === id), db.items.find(i => i.id === id), `${id} unchanged`);
                }
                for (const id of ['scratchpad', 'notes', 'tab_new', 'tab_live']) {
                    assert.deepStrictEqual(after.tabs.find(t => t.id === id), db.tabs.find(t => t.id === id), `${id} unchanged`);
                }

                const snapDir = path.join(server.dataDir, 'snapshots');
                const purgeSnap = fs.readdirSync(snapDir).find(f => /-purge\.json$/.test(f));
                assert.ok(purgeSnap, 'a purge snapshot must be taken before deleting');
                assert.strictEqual(fs.readFileSync(path.join(snapDir, purgeSnap), 'utf8'), original, 'snapshot holds the full pre-purge database');
            } finally {
                await server.stop();
            }
        });

        it('TRASH_RETENTION_DAYS=0 disables auto-purge entirely', async () => {
            const { db, files } = buildSeed();
            const server = await startSeededServer(db, files, { TRASH_RETENTION_DAYS: '0' });
            try {
                assert.deepStrictEqual(server.readDb().items.map(i => i.id), db.items.map(i => i.id));
                assert.ok(fs.existsSync(path.join(server.uploadsDir, 'expired.png')));
                assert.strictEqual((await fetchApi(server.baseUrl, '/api/health')).body.trashRetentionDays, 0);
            } finally {
                await server.stop();
            }
        });

        it('The hourly purge job also fires while the server is running (fast interval for the test)', async () => {
            const server = await startSeededServer({ version: 2, items: [note('keep-me')], tabs: [] }, {},
                { TRASH_RETENTION_DAYS: '0.00002', TRASH_PURGE_INTERVAL_MS: '300' }); // ~1.7s retention
            try {
                const fresh = (await fetchApi(server.baseUrl, '/api/items', json('POST', { content: 'short lived' }))).body.item;
                await fetchApi(server.baseUrl, `/api/items/${fresh.id}/trash`, { method: 'PATCH' });
                assert.ok(server.readDb().items.some(i => i.id === fresh.id), 'still present right after trashing');

                let gone = false;
                for (let i = 0; i < 40 && !gone; i++) {
                    await new Promise(r => setTimeout(r, 250));
                    gone = !server.readDb().items.some(i2 => i2.id === fresh.id);
                }
                assert.ok(gone, 'expired trashed item should be purged by the interval job');
                assert.ok(server.readDb().items.some(i => i.id === 'keep-me'), 'untrashed item must never be purged');
            } finally {
                await server.stop();
            }
        });
    });
});
