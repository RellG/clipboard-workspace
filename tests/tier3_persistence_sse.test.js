const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startTestServer, fetchApi, connectSse, PROJECT_ROOT } = require('./test_helpers');

describe('Tier 3: Concurrency, Persistence & SSE Synchronization', () => {
    let baseUrl;
    let testServer;
    let targetDataDir;

    before(async () => {
        if (process.env.TEST_BASE_URL) {
            baseUrl = process.env.TEST_BASE_URL;
            if (process.env.TEST_DATA_DIR) {
                targetDataDir = path.join(process.env.TEST_DATA_DIR, 'data');
            } else {
                const isLocal = baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost');
                targetDataDir = isLocal ? path.join(PROJECT_ROOT, 'data') : null;
            }
        } else {
            testServer = await startTestServer();
            baseUrl = testServer.baseUrl;
            targetDataDir = path.join(testServer.tempDir, 'data');
        }
    });

    after(async () => {
        if (testServer) {
            await testServer.cleanup();
        }
    });

    it('Atomic persistence: Rapid parallel creation maintains valid database JSON and leaks no temp files', async () => {
        const BATCH_SIZE = 20;
        const promises = [];

        for (let i = 0; i < BATCH_SIZE; i++) {
            promises.push((async (idx) => {
                const res = await fetchApi(baseUrl, '/api/items', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: `Concurrent Load Test Item #${idx} - ${Date.now()}`,
                        title: `Load Test Item #${idx}`
                    })
                });
                assert.strictEqual(res.status, 201, `Item #${idx} should return 201`);
                assert.ok(res.body && res.body.item, `Item #${idx} response must contain item object`);
                return res.body.item.id;
            })(i));
        }

        const results = await Promise.all(promises);
        try {
            assert.strictEqual(results.length, BATCH_SIZE, `All ${BATCH_SIZE} items should be created`);

            // Verify all items are queryable via API
            const getRes = await fetchApi(baseUrl, '/api/items');
            assert.strictEqual(getRes.status, 200, 'GET /api/items should return 200');
            const apiItemIds = new Set(getRes.body.map(i => String(i.id)));
            for (const id of results) {
                assert.ok(apiItemIds.has(String(id)), `Item ${id} must be present in API item list`);
            }

            // Direct filesystem persistence verification when data directory is available
            if (targetDataDir && fs.existsSync(targetDataDir)) {
                const dbFile = path.join(targetDataDir, 'db.json');
                if (fs.existsSync(dbFile)) {
                    const raw = fs.readFileSync(dbFile, 'utf8');
                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    } catch (err) {
                        assert.fail(`db.json is corrupted and failed JSON.parse: ${err.message}`);
                    }

                    assert.ok(Array.isArray(parsed.items), 'db.json items must be an array');
                    const fileItemIds = new Set(parsed.items.map(i => String(i.id)));
                    for (const id of results) {
                        assert.ok(fileItemIds.has(String(id)), `Item ${id} must be persisted to db.json`);
                    }

                    // Check for leaked temp files in data directory
                    const dataFiles = fs.readdirSync(targetDataDir);
                    const tempFiles = dataFiles.filter(f => f.endsWith('.tmp') || f.includes('.tmp.'));
                    assert.strictEqual(tempFiles.length, 0, `No temporary files should be leaked in data directory, found: ${tempFiles.join(', ')}`);
                }
            }
        } finally {
            // Cleanup created items to avoid polluting shared environments
            for (const id of results) {
                try {
                    await fetchApi(baseUrl, `/api/items/${id}`, { method: 'DELETE' });
                } catch {}
            }
        }
    });

    it('SSE stream: Connects to /api/events, receives initial connected event, and syncs item_created within 2s', async () => {
        const sseClient = connectSse(baseUrl, '/api/events');

        try {
            // 1. Assert initial connected event
            const connectedData = await Promise.race([
                sseClient.once('connected'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for initial connected event')), 2500))
            ]);
            assert.ok(connectedData, 'Expected connected event payload');
            assert.strictEqual(connectedData.status, 'connected', `Expected status 'connected', got '${connectedData.status}'`);

            // 2. Setup listener for item_created before triggering creation
            const itemCreatedPromise = Promise.race([
                sseClient.once('item_created'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for item_created event within 2s')), 2000))
            ]);

            // 3. Trigger item creation
            const testPayload = {
                content: 'SSE Realtime Verification Note ' + Date.now(),
                title: 'SSE Broadcast Test'
            };
            const createRes = await fetchApi(baseUrl, '/api/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testPayload)
            });
            assert.strictEqual(createRes.status, 201, 'Item creation should return 201');
            const createdItem = createRes.body.item;

            // 4. Await event
            const receivedEventItem = await itemCreatedPromise;
            assert.ok(receivedEventItem, 'Received item_created event payload');
            assert.strictEqual(String(receivedEventItem.id), String(createdItem.id), 'SSE broadcast item ID must match created item ID');
            assert.strictEqual(receivedEventItem.content, createdItem.content, 'SSE broadcast item content must match');

            // Cleanup
            await fetchApi(baseUrl, `/api/items/${createdItem.id}`, { method: 'DELETE' });
        } finally {
            sseClient.close();
        }
    });
});
