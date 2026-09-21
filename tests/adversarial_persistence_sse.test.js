const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { startTestServer, fetchApi, connectSse, PROJECT_ROOT, SERVER_SCRIPT, getFreePort, waitForHealthy } = require('./test_helpers');

describe('Empirical Adversarial Challenge: Persistence & SSE Synchronization', () => {

    describe('1. Concurrency & Atomic Persistence Stress Tests', () => {
        let testServer;
        let baseUrl;
        let dataDir;

        before(async () => {
            testServer = await startTestServer();
            baseUrl = testServer.baseUrl;
            dataDir = path.join(testServer.tempDir, 'data');
        });

        after(async () => {
            if (testServer) await testServer.cleanup();
        });

        it('Massive Concurrency: 50 parallel workers inserting items rapidly results in 0 lost writes, valid db.json, and 0 orphaned temp files', async () => {
            const CONCURRENCY = 50;
            const startTime = Date.now();
            console.log(`   [Stress] Spawning ${CONCURRENCY} parallel worker requests...`);

            const promises = [];
            for (let i = 0; i < CONCURRENCY; i++) {
                promises.push((async (workerId) => {
                    const payload = {
                        content: `Stress Worker Payload #${workerId} - uuid:${Math.random().toString(36).slice(2)}`,
                        title: `Stress Worker #${workerId}`,
                        tags: ['stress', `worker-${workerId}`]
                    };
                    const res = await fetchApi(baseUrl, '/api/items', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    assert.strictEqual(res.status, 201, `Worker ${workerId} expected 201, got ${res.status}`);
                    assert.ok(res.body && res.body.success, `Worker ${workerId} expected success: true`);
                    assert.ok(res.body.item && res.body.item.id, `Worker ${workerId} expected item.id`);
                    return res.body.item.id;
                })(i));
            }

            const createdIds = await Promise.all(promises);
            const duration = Date.now() - startTime;
            console.log(`   [Stress] Completed ${CONCURRENCY} parallel writes in ${duration}ms (${(duration / CONCURRENCY).toFixed(1)}ms/write)`);
            assert.strictEqual(createdIds.length, CONCURRENCY, 'All worker writes must complete');

            // 1. Verify zero lost writes via API
            const getRes = await fetchApi(baseUrl, '/api/items');
            assert.strictEqual(getRes.status, 200, 'GET /api/items must return 200');
            const apiItems = getRes.body;
            assert.ok(Array.isArray(apiItems), 'GET /api/items must return array');
            const apiIds = new Set(apiItems.map(item => String(item.id)));

            const missingInApi = createdIds.filter(id => !apiIds.has(String(id)));
            assert.strictEqual(missingInApi.length, 0, `Lost writes detected in API: ${missingInApi.join(', ')}`);

            // 2. Verify filesystem integrity and valid JSON in db.json
            const dbFile = path.join(dataDir, 'db.json');
            assert.ok(fs.existsSync(dbFile), 'db.json must exist in data directory');

            const rawDb = fs.readFileSync(dbFile, 'utf8');
            let parsedDb;
            try {
                parsedDb = JSON.parse(rawDb);
            } catch (err) {
                assert.fail(`db.json is corrupted and failed JSON.parse: ${err.message}`);
            }

            assert.ok(Array.isArray(parsedDb.items), 'db.json items must be an array');
            const diskIds = new Set(parsedDb.items.map(item => String(item.id)));
            const missingOnDisk = createdIds.filter(id => !diskIds.has(String(id)));
            assert.strictEqual(missingOnDisk.length, 0, `Lost writes detected on disk db.json: ${missingOnDisk.join(', ')}`);

            // 3. Verify zero orphaned temp files in data directory
            const files = fs.readdirSync(dataDir);
            const orphanedTemp = files.filter(f => f.startsWith('.db.tmp') || f.endsWith('.tmp'));
            console.log(`   [Stress] Data directory files: ${files.join(', ')}`);
            assert.strictEqual(orphanedTemp.length, 0, `Leaked orphaned temp files found in data directory: ${orphanedTemp.join(', ')}`);
        });

        it('Concurrent mixed mutations: Parallel updates and deletes maintain state consistency and valid JSON', async () => {
            // Create 20 baseline items
            const created = [];
            for (let i = 0; i < 20; i++) {
                const res = await fetchApi(baseUrl, '/api/items', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: `Mutation Item #${i}` })
                });
                created.push(res.body.item.id);
            }

            // Concurrently update first 10 items and delete next 10 items
            const mutationOps = [];
            for (let i = 0; i < 10; i++) {
                mutationOps.push(fetchApi(baseUrl, `/api/items/${created[i]}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: `Updated Mutation Item #${i} ${Date.now()}` })
                }));
            }
            for (let i = 10; i < 20; i++) {
                mutationOps.push(fetchApi(baseUrl, `/api/items/${created[i]}`, {
                    method: 'DELETE'
                }));
            }

            const mutationResults = await Promise.all(mutationOps);
            for (let i = 0; i < 10; i++) {
                assert.strictEqual(mutationResults[i].status, 200, `Update #${i} failed with ${mutationResults[i].status}`);
            }
            for (let i = 10; i < 20; i++) {
                assert.strictEqual(mutationResults[i].status, 200, `Delete #${i} failed with ${mutationResults[i].status}`);
            }

            // Verify db.json is valid and deleted items are absent
            const dbFile = path.join(dataDir, 'db.json');
            const parsedDb = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
            const remainingDiskIds = new Set(parsedDb.items.map(item => String(item.id)));

            for (let i = 0; i < 10; i++) {
                assert.ok(remainingDiskIds.has(String(created[i])), `Updated item ${created[i]} must remain in db.json`);
            }
            for (let i = 10; i < 20; i++) {
                assert.ok(!remainingDiskIds.has(String(created[i])), `Deleted item ${created[i]} must NOT remain in db.json`);
            }
        });
    });

    describe('2. Abrupt Process Termination & Crash Recovery (SIGKILL & SIGTERM)', () => {
        it('SIGKILL during high-speed write bursts leaves db.json valid, intact, and recoverable on reboot', async () => {
            const port = await getFreePort();
            const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'clipboard-crash-test-'));
            const dataDir = path.join(tempDir, 'data');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.mkdirSync(path.join(tempDir, 'uploads'), { recursive: true });

            // Create initial valid db.json with 5 seeds
            const initialSeed = {
                version: 2,
                items: Array.from({ length: 5 }, (_, i) => ({
                    id: `seed-${i}`,
                    type: 'text',
                    title: `Seed Item ${i}`,
                    content: `Seed Content ${i}`,
                    timestamp: new Date().toISOString()
                })),
                tabs: []
            };
            fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(initialSeed, null, 2), 'utf8');

            const env = {
                ...process.env,
                PORT: String(port),
                NODE_PATH: path.join(PROJECT_ROOT, 'node_modules')
            };

            const serverProc = spawn(process.execPath, [SERVER_SCRIPT], {
                cwd: tempDir,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const baseUrl = `http://127.0.0.1:${port}`;
            await waitForHealthy(baseUrl, 6000);
            console.log(`   [Crash Test] Server running on ${baseUrl} (PID: ${serverProc.pid})`);

            // Flood with rapid background writes
            let active = true;
            let writeCount = 0;
            const floodPromises = [];

            for (let i = 0; i < 30; i++) {
                floodPromises.push((async (wId) => {
                    while (active) {
                        try {
                            await fetchApi(baseUrl, '/api/items', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ content: `Crash write ${wId} - ${writeCount++}` })
                            });
                        } catch {}
                    }
                })(i));
            }

            // Let writes bombard the server for 200ms
            await new Promise(r => setTimeout(r, 200));

            // ABRUPT TERMINATION: SIGKILL (-9)
            console.log(`   [Crash Test] Sending SIGKILL to PID ${serverProc.pid} mid-flight...`);
            serverProc.kill('SIGKILL');
            active = false;

            await new Promise((resolve) => {
                serverProc.once('exit', (code, signal) => {
                    console.log(`   [Crash Test] Server terminated by signal: ${signal}`);
                    resolve();
                });
            });

            // Inspect filesystem state immediately after SIGKILL
            const dbFile = path.join(dataDir, 'db.json');
            assert.ok(fs.existsSync(dbFile), 'db.json must exist after crash');

            const rawContent = fs.readFileSync(dbFile, 'utf8');
            assert.ok(rawContent.length > 0, 'db.json must not be a 0-byte truncated file');

            let parsed;
            try {
                parsed = JSON.parse(rawContent);
            } catch (err) {
                assert.fail(`db.json was corrupted by abrupt SIGKILL: ${err.message}`);
            }
            assert.ok(Array.isArray(parsed.items), 'db.json items must be an array after SIGKILL');
            assert.ok(parsed.items.length >= 5, `db.json must retain at least the 5 seed items, found ${parsed.items.length}`);
            console.log(`   [Crash Test] db.json is completely valid JSON with ${parsed.items.length} items.`);

            // REBOOT TEST: Start a new server instance on the exact same data directory
            console.log(`   [Crash Test] Rebooting server on the existing data directory...`);
            const rebootPort = await getFreePort();
            const rebootProc = spawn(process.execPath, [SERVER_SCRIPT], {
                cwd: tempDir,
                env: { ...env, PORT: String(rebootPort) },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const rebootBaseUrl = `http://127.0.0.1:${rebootPort}`;
            try {
                await waitForHealthy(rebootBaseUrl, 6000);
                console.log(`   [Crash Test] Reboot successful! Server is healthy on ${rebootBaseUrl}`);

                const healthRes = await fetchApi(rebootBaseUrl, '/api/health');
                assert.strictEqual(healthRes.status, 200);
                assert.strictEqual(healthRes.body.status, 'healthy');
                assert.strictEqual(healthRes.body.items, parsed.items.length);

                const getItemsRes = await fetchApi(rebootBaseUrl, '/api/items');
                assert.strictEqual(getItemsRes.status, 200);
                assert.strictEqual(getItemsRes.body.length, parsed.items.length);
            } finally {
                rebootProc.kill('SIGKILL');
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
            }
        });

        it('SIGTERM during write load flushes cleanly and gracefully shuts down with exit code 0', async () => {
            const port = await getFreePort();
            const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'clipboard-term-test-'));
            const dataDir = path.join(tempDir, 'data');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.mkdirSync(path.join(tempDir, 'uploads'), { recursive: true });

            const env = {
                ...process.env,
                PORT: String(port),
                NODE_PATH: path.join(PROJECT_ROOT, 'node_modules')
            };

            const serverProc = spawn(process.execPath, [SERVER_SCRIPT], {
                cwd: tempDir,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const baseUrl = `http://127.0.0.1:${port}`;
            await waitForHealthy(baseUrl, 6000);

            // Send write
            await fetchApi(baseUrl, '/api/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'SIGTERM flush test note' })
            });

            // Send SIGTERM
            const exitPromise = new Promise((resolve) => {
                serverProc.once('exit', (code, signal) => resolve({ code, signal }));
            });

            serverProc.kill('SIGTERM');
            const exitResult = await exitPromise;
            console.log(`   [Shutdown Test] Process exit result: code=${exitResult.code}, signal=${exitResult.signal}`);
            assert.strictEqual(exitResult.code, 0, 'Graceful shutdown should exit with code 0');

            // Verify db.json
            const dbFile = path.join(dataDir, 'db.json');
            const parsed = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
            assert.ok(parsed.items.some(i => i.content === 'SIGTERM flush test note'), 'db.json must contain flushed write');

            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        });
    });

    describe('3. SSE Real-time Synchronization Stress Tests', () => {
        let testServer;
        let baseUrl;

        before(async () => {
            testServer = await startTestServer();
            baseUrl = testServer.baseUrl;
        });

        after(async () => {
            if (testServer) await testServer.cleanup();
        });

        it('Multi-client SSE: 15 simultaneous clients receive item_created, item_updated, and item_deleted in exact sequence within 2s', async () => {
            const NUM_CLIENTS = 15;
            console.log(`   [SSE Stress] Connecting ${NUM_CLIENTS} simultaneous SSE clients to ${baseUrl}/api/events...`);

            const clients = [];
            const clientEvents = Array.from({ length: NUM_CLIENTS }, () => []);

            // Connect all clients and collect events
            for (let i = 0; i < NUM_CLIENTS; i++) {
                const client = connectSse(baseUrl, '/api/events');
                const clientIdx = i;

                client.on('connected', (data) => clientEvents[clientIdx].push({ type: 'connected', data, time: Date.now() }));
                client.on('item_created', (data) => clientEvents[clientIdx].push({ type: 'item_created', data, time: Date.now() }));
                client.on('item_updated', (data) => clientEvents[clientIdx].push({ type: 'item_updated', data, time: Date.now() }));
                client.on('item_deleted', (data) => clientEvents[clientIdx].push({ type: 'item_deleted', data, time: Date.now() }));

                clients.push(client);
            }

            try {
                // Wait for all 15 clients to receive connected event
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Timeout waiting for all clients to receive connected event')), 3000);
                    const checkInterval = setInterval(() => {
                        const allConnected = clientEvents.every(evts => evts.some(e => e.type === 'connected'));
                        if (allConnected) {
                            clearInterval(checkInterval);
                            clearTimeout(timeout);
                            resolve();
                        }
                    }, 50);
                });

                console.log(`   [SSE Stress] All ${NUM_CLIENTS} clients connected successfully.`);

                // Check server health reports 15 connected clients
                const healthRes = await fetchApi(baseUrl, '/api/health');
                assert.strictEqual(healthRes.body.connectedClients, NUM_CLIENTS, `Expected ${NUM_CLIENTS} connected clients on server`);

                // 1. TRIGGER ITEM CREATION
                const createTime = Date.now();
                const createRes = await fetchApi(baseUrl, '/api/items', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'SSE Sequence Multi-client Test Note', title: 'SSE Multi-Test' })
                });
                assert.strictEqual(createRes.status, 201);
                const createdItem = createRes.body.item;
                const itemId = createdItem.id;

                // 2. TRIGGER ITEM UPDATE
                const updateRes = await fetchApi(baseUrl, `/api/items/${itemId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'SSE Sequence Multi-client Test Note UPDATED' })
                });
                assert.strictEqual(updateRes.status, 200);

                // 3. TRIGGER ITEM DELETION
                const deleteRes = await fetchApi(baseUrl, `/api/items/${itemId}`, {
                    method: 'DELETE'
                });
                assert.strictEqual(deleteRes.status, 200);

                // Wait for all 15 clients to receive all 3 events
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        const statusSummary = clientEvents.map((evts, idx) => `Client ${idx}: [${evts.map(e => e.type).join(', ')}]`).join('; ');
                        reject(new Error(`Timeout waiting for all clients to receive all events within 2s. Status: ${statusSummary}`));
                    }, 2000);

                    const checkInterval = setInterval(() => {
                        const allReceived = clientEvents.every(evts => {
                            const types = evts.map(e => e.type);
                            return types.includes('item_created') && types.includes('item_updated') && types.includes('item_deleted');
                        });
                        if (allReceived) {
                            clearInterval(checkInterval);
                            clearTimeout(timeout);
                            resolve();
                        }
                    }, 30);
                });

                const totalLatency = Date.now() - createTime;
                console.log(`   [SSE Stress] All ${NUM_CLIENTS} clients received all 3 lifecycle events in ${totalLatency}ms (<2000ms SLA).`);

                // ASSERT ACCURACY AND SEQUENCE ON ALL CLIENTS
                for (let i = 0; i < NUM_CLIENTS; i++) {
                    const evts = clientEvents[i];
                    const createdEvt = evts.find(e => e.type === 'item_created');
                    const updatedEvt = evts.find(e => e.type === 'item_updated');
                    const deletedEvt = evts.find(e => e.type === 'item_deleted');

                    // Accuracy assertions
                    assert.strictEqual(String(createdEvt.data.id), String(itemId), `Client ${i} item_created ID mismatch`);
                    assert.strictEqual(createdEvt.data.content, 'SSE Sequence Multi-client Test Note');

                    assert.strictEqual(String(updatedEvt.data.id), String(itemId), `Client ${i} item_updated ID mismatch`);
                    assert.strictEqual(updatedEvt.data.content, 'SSE Sequence Multi-client Test Note UPDATED');

                    assert.strictEqual(String(deletedEvt.data.id), String(itemId), `Client ${i} item_deleted ID mismatch`);

                    // Sequence assertions
                    const createdIdx = evts.indexOf(createdEvt);
                    const updatedIdx = evts.indexOf(updatedEvt);
                    const deletedIdx = evts.indexOf(deletedEvt);

                    assert.ok(createdIdx < updatedIdx, `Client ${i}: item_created (${createdIdx}) must precede item_updated (${updatedIdx})`);
                    assert.ok(updatedIdx < deletedIdx, `Client ${i}: item_updated (${updatedIdx}) must precede item_deleted (${deletedIdx})`);
                }

            } finally {
                for (const client of clients) client.close();
                // Wait for sockets to drain so subsequent tests start with clean connectedClients count
                const drainStart = Date.now();
                while (Date.now() - drainStart < 2000) {
                    const h = await fetchApi(baseUrl, '/api/health');
                    if (h.body.connectedClients === 0) break;
                    await new Promise(r => setTimeout(r, 50));
                }
            }
        });

        it('Abrupt SSE disconnection: Server cleans up disconnected clients, handles broadcasts without error, and avoids memory leaks', async () => {
            // Check baseline health
            const baseHealth = await fetchApi(baseUrl, '/api/health');
            const initialClients = baseHealth.body.connectedClients;
            const initialMemory = baseHealth.body.memoryUsage.rss;
            console.log(`   [SSE Disconnect] Baseline connectedClients: ${initialClients}, Memory RSS: ${(initialMemory / 1024 / 1024).toFixed(2)} MB`);

            // Connect 10 ephemeral clients and wait for response headers on all of them
            const ephemeralReqs = [];
            const connectPromises = [];
            for (let i = 0; i < 10; i++) {
                connectPromises.push(new Promise((resolve) => {
                    const req = http.get(`${baseUrl}/api/events`, (res) => {
                        res.on('data', () => {});
                        resolve(req);
                    });
                    req.on('error', () => {}); // swallow expected abort errors
                    ephemeralReqs.push(req);
                }));
            }
            await Promise.all(connectPromises);

            // Verify server registered all 10 clients
            const midHealth = await fetchApi(baseUrl, '/api/health');
            assert.strictEqual(midHealth.body.connectedClients, initialClients + 10, 'Server must register 10 new clients');
            console.log(`   [SSE Disconnect] Registered 10 new clients (total: ${midHealth.body.connectedClients})`);

            // ABRUPTLY DESTROY ALL 10 TCP SOCKETS (simulates network drop / killed browser process)
            console.log(`   [SSE Disconnect] Abruptly destroying 10 client TCP sockets...`);
            for (const req of ephemeralReqs) {
                if (req.socket) {
                    req.socket.destroy();
                } else {
                    req.destroy();
                }
            }

            // Trigger broadcast while sockets are destroyed to verify NO unhandled error occurs on server
            const postRes = await fetchApi(baseUrl, '/api/items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Post-abrupt-disconnect broadcast test note' })
            });
            assert.strictEqual(postRes.status, 201, 'Server should broadcast without throwing unhandled socket write errors');

            // Wait for server req.on("close") / error handlers to clean up sseClients Set
            const cleanupStart = Date.now();
            let cleanedUp = false;
            while (Date.now() - cleanupStart < 3000) {
                const h = await fetchApi(baseUrl, '/api/health');
                if (h.body.connectedClients === initialClients) {
                    cleanedUp = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 50));
            }
            assert.ok(cleanedUp, `Server failed to clean up sseClients within 3000ms`);

            // Post-cleanup assertions
            const postHealth = await fetchApi(baseUrl, '/api/health');
            assert.strictEqual(postHealth.body.status, 'healthy', 'Server must remain healthy after abrupt disconnections');
            assert.strictEqual(postHealth.body.connectedClients, initialClients, 'connectedClients must return to baseline count');

            const postMemory = postHealth.body.memoryUsage.rss;
            const memoryDeltaMb = (postMemory - initialMemory) / 1024 / 1024;
            console.log(`   [SSE Disconnect] Final connectedClients: ${postHealth.body.connectedClients}, Memory RSS: ${(postMemory / 1024 / 1024).toFixed(2)} MB (Delta: ${memoryDeltaMb.toFixed(2)} MB)`);
            assert.ok(memoryDeltaMb < 50, `Memory growth exceeds acceptable threshold: ${memoryDeltaMb.toFixed(2)} MB`);

            // Cleanup test item
            await fetchApi(baseUrl, `/api/items/${postRes.body.item.id}`, { method: 'DELETE' });
        });
    });
});
