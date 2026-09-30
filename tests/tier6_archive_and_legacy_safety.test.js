const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getFreePort, waitForHealthy, fetchApi, PROJECT_ROOT, SERVER_SCRIPT } = require('./test_helpers');

/**
 * These tests ALWAYS run against their own isolated server (seeded temp dir), even when the runner is
 * pointed at another target, because they need a known starting database.
 */
async function startSeededServer(seedDb, seedFiles = {}) {
    const port = await getFreePort();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-tier6-'));
    const dataDir = path.join(tempDir, 'data');
    const uploadsDir = path.join(tempDir, 'uploads');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(seedDb, null, 2), 'utf8');
    for (const [name, bytes] of Object.entries(seedFiles)) {
        fs.writeFileSync(path.join(uploadsDir, name), bytes);
    }

    const proc = spawn(process.execPath, [SERVER_SCRIPT], {
        cwd: tempDir,
        env: { ...process.env, PORT: String(port), NODE_PATH: path.join(PROJECT_ROOT, 'node_modules') },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    proc.stdout.on('data', d => { logs += d; });
    proc.stderr.on('data', d => { logs += d; });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await waitForHealthy(baseUrl, 8000);
    } catch (err) {
        proc.kill('SIGKILL');
        throw new Error(`${err.message}\n${logs}`);
    }

    return {
        baseUrl, tempDir, dataDir, uploadsDir, proc,
        readDb: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')),
        async stop() {
            const p = this.proc; // read at call time: restarts swap the process
            await new Promise(resolve => {
                p.once('exit', resolve);
                p.kill('SIGTERM');
                setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 2500);
            });
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
    };
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Legacy-shaped data: mirrors the shape of a real long-lived db.json (no `archived` anywhere). */
function buildLegacySeed() {
    const png = crypto.randomBytes(2048);
    const mp3 = crypto.randomBytes(4096);
    const files = {
        '1752423367991-294012429.png': png,
        '1771708597820-26100709.mp3': mp3
    };
    const base = '2026-09-01T10:00:00.000Z';
    const db = {
        version: 2,
        items: [
            {
                id: '17907447944781210', type: 'code', title: 'Web Dev', content: 'const a = 1;\nconsole.log(a);',
                language: 'javascript', tags: [], pinned: true, tabId: 'scratchpad',
                timestamp: base, createdAt: base, updatedAt: base
            },
            {
                id: '17906461780901531', type: 'file', fileType: 'image', title: 'IMG_2893.png', name: 'IMG_2893.png',
                originalName: 'IMG_2893.png', filename: '1752423367991-294012429.png', size: png.length,
                mimetype: 'image/png', sha256: sha(png), pinned: false, tags: ['image'],
                timestamp: base, createdAt: base, updatedAt: base, downloadUrl: '/api/files/17906461780901531/download'
            },
            {
                id: 'file_1771708597820_abc123', type: 'file', fileType: 'audio', title: 'voice.mp3', name: 'voice.mp3',
                originalName: 'voice.mp3', filename: '1771708597820-26100709.mp3', size: mp3.length,
                mimetype: 'audio/mpeg', sha256: sha(mp3), pinned: false, tags: ['audio'],
                timestamp: base, createdAt: base, updatedAt: base, downloadUrl: '/api/files/file_1771708597820_abc123/download'
            },
            {
                id: '1790000000000111', type: 'link', title: 'https://example.com', content: 'https://example.com\nhttps://example.org',
                tags: ['link'], pinned: false, tabId: 'scratchpad', timestamp: base, createdAt: base, updatedAt: base
            },
            {
                id: '1790000000000222', type: 'text', title: 'Legacy note', content: 'Hello from the past\n'.repeat(30),
                tags: [], pinned: false, tabId: 'scratchpad', timestamp: base, createdAt: base, updatedAt: base
            }
        ],
        tabs: [
            { id: 'scratchpad', name: 'Main', icon: 'doc', content: 'My precious scratchpad\nline 2\n', mode: 'markdown', updatedAt: base },
            { id: 'notes', name: 'Quick Notes', icon: 'notes', content: 'notes here', mode: 'text', updatedAt: base },
            { id: 'tab_1789778011306', name: 'QR Code', icon: '📝', content: 'x'.repeat(5000), mode: 'markdown', language: 'javascript', updatedAt: base }
        ]
    };
    return { db, files };
}

describe('Tier 6: Archive feature & legacy-data safety', () => {
    describe('Archive API', () => {
        let server;
        let baseUrl;

        before(async () => {
            server = await startSeededServer({ version: 2, items: [], tabs: [] });
            baseUrl = server.baseUrl;
        });
        after(async () => { if (server) await server.stop(); });

        async function createNote(content) {
            const res = await fetchApi(baseUrl, '/api/items', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, type: 'text' })
            });
            assert.strictEqual(res.status, 201);
            return res.body.item;
        }

        it('PATCH /api/items/:id/archive sets archived + archivedAt without touching updatedAt or content', async () => {
            const note = await createNote('archive me');
            const res = await fetchApi(baseUrl, `/api/items/${note.id}/archive`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true })
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.item.archived, true);
            assert.ok(res.body.item.archivedAt, 'archivedAt must be set');
            assert.strictEqual(res.body.item.updatedAt, note.updatedAt, 'archiving must not bump updatedAt');
            assert.strictEqual(res.body.item.content, 'archive me');
        });

        it('GET /api/items: ?archived=true / ?archived=false filter; omitted returns everything (backward compatible)', async () => {
            const live = await createNote('stay live');
            const gone = await createNote('go to archive');
            await fetchApi(baseUrl, `/api/items/${gone.id}/archive`, { method: 'PATCH' });

            const all = (await fetchApi(baseUrl, '/api/items')).body.map(i => i.id);
            const arch = (await fetchApi(baseUrl, '/api/items?archived=true')).body.map(i => i.id);
            const active = (await fetchApi(baseUrl, '/api/items?archived=false')).body.map(i => i.id);

            assert.ok(all.includes(live.id) && all.includes(gone.id), 'default list includes archived items');
            assert.ok(arch.includes(gone.id) && !arch.includes(live.id));
            assert.ok(active.includes(live.id) && !active.includes(gone.id));
        });

        it('Restoring removes archive keys entirely (item returns to its exact original shape)', async () => {
            const note = await createNote('round trip');
            const before = JSON.stringify(server.readDb().items.find(i => i.id === note.id));
            await fetchApi(baseUrl, `/api/items/${note.id}/archive`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true })
            });
            const res = await fetchApi(baseUrl, `/api/items/${note.id}/archive`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: false })
            });
            assert.strictEqual(res.status, 200);
            const after = JSON.stringify(server.readDb().items.find(i => i.id === note.id));
            assert.strictEqual(after, before, 'restored item must be identical to the original');
        });

        it('PATCH archive with no body toggles; unknown id returns 404', async () => {
            const note = await createNote('toggle me');
            const r1 = await fetchApi(baseUrl, `/api/items/${note.id}/archive`, { method: 'PATCH' });
            assert.strictEqual(r1.body.item.archived, true);
            const r2 = await fetchApi(baseUrl, `/api/items/${note.id}/archive`, { method: 'PATCH' });
            assert.ok(!r2.body.item.archived);
            const r3 = await fetchApi(baseUrl, '/api/items/does-not-exist/archive', { method: 'PATCH' });
            assert.strictEqual(r3.status, 404);
        });

        it('POST /api/items/archive (bulk) validates input and reports only real changes', async () => {
            const a = await createNote('bulk a');
            const b = await createNote('bulk b');

            for (const bad of [{}, { ids: [], archived: true }, { ids: ['x'], archived: 'yes' }, { ids: 'x', archived: true }]) {
                const r = await fetchApi(baseUrl, '/api/items/archive', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad)
                });
                assert.strictEqual(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
            }

            const ok = await fetchApi(baseUrl, '/api/items/archive', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [a.id, b.id, 'ghost'], archived: true })
            });
            assert.strictEqual(ok.status, 200);
            assert.deepStrictEqual(ok.body.changed.sort(), [a.id, b.id].sort());

            const again = await fetchApi(baseUrl, '/api/items/archive', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [a.id, b.id], archived: true })
            });
            assert.deepStrictEqual(again.body.changed, [], 'already-archived items are not re-archived');
        });

        it('Archived files stay on disk, stay downloadable bit-exact, and are listed under ?archived=true', async () => {
            const bytes = crypto.randomBytes(32 * 1024);
            const form = new FormData();
            form.append('files', new Blob([bytes]), 'keep-me.bin');
            const up = await fetch(`${baseUrl}/api/files/upload`, { method: 'POST', body: form });
            const meta = (await up.json()).files[0];
            assert.strictEqual(meta.archived, false);

            const res = await fetchApi(baseUrl, `/api/files/${meta.id}/archive`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true })
            });
            assert.strictEqual(res.status, 200);

            const listed = (await fetchApi(baseUrl, '/api/files?archived=true')).body;
            assert.ok(listed.some(f => f.id === meta.id && f.archived === true));
            const hidden = (await fetchApi(baseUrl, '/api/files?archived=false')).body;
            assert.ok(!hidden.some(f => f.id === meta.id));

            assert.ok(fs.existsSync(path.join(server.uploadsDir, meta.filename)), 'file must remain on disk');
            const dl = await fetch(`${baseUrl}/api/files/${meta.id}/download`);
            const got = Buffer.from(await dl.arrayBuffer());
            assert.strictEqual(sha(got), sha(bytes), 'archived file must still download bit-exact');
        });

        it('Deleting an archived item still works and removes its file', async () => {
            const form = new FormData();
            form.append('files', new Blob([Buffer.from('bye')]), 'bye.txt');
            const meta = (await (await fetch(`${baseUrl}/api/files/upload`, { method: 'POST', body: form })).json()).files[0];
            await fetchApi(baseUrl, `/api/files/${meta.id}/archive`, { method: 'PATCH' });
            const del = await fetchApi(baseUrl, `/api/files/${meta.id}`, { method: 'DELETE' });
            assert.strictEqual(del.status, 200);
            assert.ok(!fs.existsSync(path.join(server.uploadsDir, meta.filename)));
        });

        it('Health reports archivedItems count', async () => {
            const res = await fetchApi(baseUrl, '/api/health');
            assert.strictEqual(typeof res.body.archivedItems, 'number');
            assert.ok(res.body.archivedItems >= 1);
        });
    });

    describe('Legacy data is never touched', () => {
        let server;
        let seed;
        let originalDbBytes;
        let originalUploadHashes;

        before(async () => {
            seed = buildLegacySeed();
            server = null;
            const probe = await startSeededServer(seed.db, seed.files);
            server = probe;
            originalDbBytes = JSON.stringify(seed.db, null, 2);
            originalUploadHashes = Object.fromEntries(Object.entries(seed.files).map(([n, b]) => [n, sha(b)]));
        });
        after(async () => { if (server) await server.stop(); });

        function legacyItemsOnDisk() {
            return server.readDb().items.filter(i => seed.db.items.some(s => s.id === i.id));
        }

        it('Booting against a legacy db.json leaves every legacy item and tab deep-equal to the original', () => {
            const onDisk = server.readDb();
            for (const original of seed.db.items) {
                const found = onDisk.items.find(i => i.id === original.id);
                assert.ok(found, `legacy item ${original.id} must still exist`);
                assert.deepStrictEqual(found, original, `legacy item ${original.id} must be unchanged`);
                assert.strictEqual('archived' in found, false, 'no archived key may be added to legacy items');
            }
            assert.deepStrictEqual(onDisk.tabs, seed.db.tabs, 'legacy tabs must be unchanged');
            assert.strictEqual(onDisk.items.length, seed.db.items.length, 'no items may be added or dropped on boot');
        });

        it('A boot snapshot preserves the exact pre-boot database', () => {
            const dir = path.join(server.dataDir, 'snapshots');
            assert.ok(fs.existsSync(dir), 'snapshots directory must exist');
            const boots = fs.readdirSync(dir).filter(f => /-boot\.json$/.test(f));
            assert.ok(boots.length >= 1, 'a boot snapshot must exist');
            const snap = fs.readFileSync(path.join(dir, boots[0]), 'utf8');
            assert.strictEqual(snap, originalDbBytes, 'snapshot must be byte-identical to the pre-boot db.json');
        });

        it('Normal activity on OTHER items (create / archive / restore / delete) never alters legacy items', async () => {
            const make = await fetchApi(server.baseUrl, '/api/items', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'new stuff' })
            });
            const newId = make.body.item.id;
            await fetchApi(server.baseUrl, `/api/items/${newId}/archive`, { method: 'PATCH' });
            await fetchApi(server.baseUrl, `/api/items/${newId}/archive`, { method: 'PATCH' });
            await fetchApi(server.baseUrl, `/api/items/${newId}`, { method: 'DELETE' });
            await fetchApi(server.baseUrl, '/api/tabs', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'temp' })
            });

            for (const original of seed.db.items) {
                const found = legacyItemsOnDisk().find(i => i.id === original.id);
                assert.deepStrictEqual(found, original, `legacy item ${original.id} must be unchanged`);
            }
            for (const t of seed.db.tabs) {
                assert.deepStrictEqual(server.readDb().tabs.find(x => x.id === t.id), t, `legacy tab ${t.id} unchanged`);
            }
        });

        it('Archiving then restoring a legacy item returns it to its exact original form', async () => {
            const target = seed.db.items[4];
            await fetchApi(server.baseUrl, `/api/items/${target.id}/archive`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true })
            });
            const mid = server.readDb().items.find(i => i.id === target.id);
            assert.strictEqual(mid.archived, true);
            assert.strictEqual(mid.content, target.content);

            await fetchApi(server.baseUrl, `/api/items/${target.id}/archive`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: false })
            });
            assert.deepStrictEqual(server.readDb().items.find(i => i.id === target.id), target);
        });

        it('Upload files on disk are byte-identical after boot and all activity (archive never moves or rewrites files)', async () => {
            const fileItems = seed.db.items.filter(i => i.filename);
            await fetchApi(server.baseUrl, '/api/items/archive', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: fileItems.map(i => i.id), archived: true })
            });
            for (const [name, hash] of Object.entries(originalUploadHashes)) {
                const p = path.join(server.uploadsDir, name);
                assert.ok(fs.existsSync(p), `${name} must still exist`);
                assert.strictEqual(sha(fs.readFileSync(p)), hash, `${name} must be unchanged`);
            }
            await fetchApi(server.baseUrl, '/api/items/archive', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: fileItems.map(i => i.id), archived: false })
            });
            for (const original of fileItems) {
                assert.deepStrictEqual(server.readDb().items.find(i => i.id === original.id), original);
            }
        });

        it('Restarting the server twice keeps legacy data identical and caps boot snapshots', async () => {
            const restart = async () => {
                const dataDir = server.dataDir; const uploadsDir = server.uploadsDir; const tempDir = server.tempDir;
                await new Promise(resolve => { server.proc.once('exit', resolve); server.proc.kill('SIGTERM'); });
                const port = await getFreePort();
                const proc = spawn(process.execPath, [SERVER_SCRIPT], {
                    cwd: tempDir,
                    env: { ...process.env, PORT: String(port), NODE_PATH: path.join(PROJECT_ROOT, 'node_modules') },
                    stdio: 'ignore'
                });
                await waitForHealthy(`http://127.0.0.1:${port}`, 8000);
                server = { ...server, proc, baseUrl: `http://127.0.0.1:${port}`, dataDir, uploadsDir, tempDir };
            };
            await restart();
            await restart();
            for (const original of seed.db.items) {
                assert.deepStrictEqual(legacyItemsOnDisk().find(i => i.id === original.id), original);
            }
            const boots = fs.readdirSync(path.join(server.dataDir, 'snapshots')).filter(f => /-boot\.json$/.test(f));
            assert.ok(boots.length >= 3 && boots.length <= 20, `expected 3..20 boot snapshots, got ${boots.length}`);
        });
    });
});
