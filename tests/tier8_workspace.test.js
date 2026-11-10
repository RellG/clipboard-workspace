const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startSeededServer, fetchApi } = require('./test_helpers');
const json = (body, method = 'PUT') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const seed = { version: 2, items: [{ id: 'legacy', type: 'text', title: 'Legacy', content: 'original clip', updatedAt: '2026-10-01T00:00:00Z' }], tabs: [{ id: 'alpha', name: 'Alpha', content: 'original note', mode: 'text', updatedAt: '2026-10-01T00:00:00Z' }] };
describe('Tier 8: Workspace, conflict detection and persistence failures', () => {
    let server;
    before(async () => { server = await startSeededServer(structuredClone(seed), {}, { TRASH_RETENTION_DAYS: '0', CLIPBOARD_CONVERTER_URL: 'https://converter.example.test/' }); });
    after(async () => { if (server) await server.stop(); });
    const request = (endpoint, options) => fetchApi(server.baseUrl, endpoint, options);
    const workspace = async () => (await request('/api/workspace')).body;
    it('Exposes the configured converter address without changing stored records', async () => {
        const original = server.readDb();
        const response = await request('/api/config');
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { converterUrl: 'https://converter.example.test/' });
        assert.deepEqual(server.readDb(), original);
    });
    it('Provides computed revision tokens without migrating any legacy record', async () => {
        const dbBefore = fs.readFileSync(path.join(server.dataDir, 'db.json'), 'utf8');
        const response = await request('/api/workspace');
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.body.tabs[0]._revision, /^[0-9a-f]{64}$/);
        assert.equal(fs.readFileSync(path.join(server.dataDir, 'db.json'), 'utf8'), dbBefore);
        assert.deepEqual(server.readDb(), seed);
    });
    it('Saves the same tab, rejects stale drafts and permits an empty note', async () => {
        const tab = (await workspace()).tabs[0];
        const saved = await request('/api/tabs/alpha', json({ content: 'on device A', name: 'Alpha', baseRevision: tab._revision }));
        assert.equal(saved.status, 200); assert.notEqual(saved.body.revision, tab._revision);
        const conflict = await request('/api/tabs/alpha', json({ content: 'on device B', baseRevision: tab._revision }));
        assert.equal(conflict.status, 409); assert.equal(conflict.body.current.content, 'on device A');
        assert.equal(server.readDb().tabs.length, 1); assert.equal(server.readDb().tabs[0].content, 'on device A');
        const empty = await request('/api/tabs/alpha', json({ content: '', baseRevision: saved.body.revision }));
        assert.equal(empty.status, 200); assert.equal(server.readDb().tabs[0].content, '');
        assert.equal((await request('/api/tabs/deleted', json({ content: 'draft', baseRevision: tab._revision }))).status, 409);
        assert.ok(!server.readDb().tabs.some(t => t.id === 'deleted'));
    });
    it('Edits a legacy clip in place with the same conflict protection', async () => {
        const item = (await workspace()).items[0];
        const saved = await request('/api/items/legacy', json({ content: 'edited legacy', baseRevision: item._revision }));
        assert.equal(saved.status, 200);
        assert.equal((await request('/api/items/legacy', json({ content: 'stale', baseRevision: item._revision }))).status, 409);
        assert.equal(server.readDb().items.length, 1);
        assert.equal((await request('/api/items/legacy', json({ content: '', baseRevision: saved.body.revision }))).status, 200);
    });
    it('Archive/restore and pin/unpin of a legacy tab preserve its original shape', async () => {
        const original = server.readDb().tabs[0];
        assert.equal((await request('/api/tabs/alpha/archive', json({ archived: true }, 'PATCH'))).status, 200);
        assert.equal(server.readDb().tabs[0].archived, true);
        await request('/api/tabs/alpha/archive', json({ archived: false }, 'PATCH'));
        assert.deepEqual(server.readDb().tabs[0], original);
        await request('/api/tabs/alpha/pin', json({ pinned: true }, 'PATCH'));
        assert.equal(server.readDb().tabs[0].pinned, true);
        await request('/api/tabs/alpha/pin', json({ pinned: false }, 'PATCH'));
        assert.deepEqual(server.readDb().tabs[0], original);
    });
    it('Returns 503 on disk commit failure, rolls memory back, and allows a valid retry', async () => {
        const tab = (await workspace()).tabs[0], original = server.readDb();
        const dbFile = path.join(server.dataDir, 'db.json'), held = dbFile + '.held';
        // Only this test's synthetic database is manipulated. A directory forces atomic rename to fail even as root.
        fs.renameSync(dbFile, held); fs.mkdirSync(dbFile);
        try {
            const failed = await request('/api/tabs/alpha', json({ content: 'must not acknowledge', baseRevision: tab._revision }));
            assert.equal(failed.status, 503);
            assert.equal((await workspace()).tabs[0].content, original.tabs[0].content);
            assert.ok(!fs.readdirSync(server.dataDir).some(name => name.startsWith('.db.tmp-')));
        } finally { fs.rmdirSync(dbFile); fs.renameSync(held, dbFile); }
        assert.deepEqual(server.readDb(), original);
        assert.equal((await request('/api/tabs/alpha', json({ content: 'valid retry', baseRevision: tab._revision }))).status, 200);
        assert.equal(server.readDb().tabs[0].content, 'valid retry');
    });
    it('Rejects browser cross-origin writes but supports same-origin browsers and terminal clients', async () => {
        assert.equal((await request('/api/health', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
        assert.equal((await request('/api/health', { headers: { Origin: server.baseUrl } })).status, 200);
        assert.equal((await request('/api/health')).status, 200);
        assert.equal((await request('/api/tabs', { ...json({ name: 'bad origin' }, 'POST'), headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' } })).status, 403);
    });
    it('Creates unique note IDs for concurrent capture requests', async () => {
        const results = await Promise.all(Array.from({ length: 8 }, () => request('/api/tabs', json({ name: 'Untitled' }, 'POST'))));
        assert.ok(results.every(r => r.status === 201));
        assert.equal(new Set(results.map(r => r.body.tab.id)).size, 8);
    });
});
