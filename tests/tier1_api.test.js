const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { startTestServer, fetchApi } = require('./test_helpers');

describe('Tier 1: Feature Coverage (Core API Contracts & Endpoints)', () => {
    let baseUrl;
    let testServer;

    before(async () => {
        if (process.env.TEST_BASE_URL) {
            baseUrl = process.env.TEST_BASE_URL;
        } else {
            testServer = await startTestServer();
            baseUrl = testServer.baseUrl;
        }
    });

    after(async () => {
        if (testServer) {
            await testServer.cleanup();
        }
    });

    it('GET /api/health returns HTTP 200, status == healthy, and valid counts', async () => {
        const res = await fetchApi(baseUrl, '/api/health');
        assert.strictEqual(res.status, 200, `Expected HTTP 200, got ${res.status}`);
        assert.ok(res.body && typeof res.body === 'object', 'Expected JSON object body');
        assert.strictEqual(res.body.status, 'healthy', `Expected status == 'healthy', got ${res.body.status}`);
        assert.strictEqual(typeof res.body.items, 'number', 'Expected items to be a number');
        assert.strictEqual(typeof res.body.tabs, 'number', 'Expected tabs to be a number');
        assert.strictEqual(typeof res.body.connectedClients, 'number', 'Expected connectedClients to be a number');
        assert.strictEqual(typeof res.body.uptime, 'number', 'Expected uptime to be a number');
    });

    it('GET /api/items returns HTTP 200 and a JSON array', async () => {
        const res = await fetchApi(baseUrl, '/api/items');
        assert.strictEqual(res.status, 200, `Expected HTTP 200, got ${res.status}`);
        assert.ok(Array.isArray(res.body), 'Expected body to be a JSON array');
    });

    let createdItemId;
    it('POST /api/items creates item on valid text content and returns 201 with required fields', async () => {
        const payload = {
            content: 'E2E Test Note ' + Date.now(),
            title: 'E2E Title',
            type: 'text'
        };
        const res = await fetchApi(baseUrl, '/api/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(res.status, 201, `Expected HTTP 201, got ${res.status}`);
        assert.ok(res.body && res.body.item, 'Expected response to contain item object');
        const item = res.body.item;
        assert.ok(item.id, 'Expected item to have an id');
        assert.strictEqual(item.content, payload.content, 'Content must match');
        assert.strictEqual(item.title, payload.title, 'Title must match');
        assert.strictEqual(item.type, 'text', 'Type must be text');
        assert.ok(item.timestamp, 'Expected item to have timestamp');

        createdItemId = item.id;

        // Verify item appears in GET /api/items
        const getRes = await fetchApi(baseUrl, '/api/items');
        const found = getRes.body.find(i => String(i.id) === String(createdItemId));
        assert.ok(found, `Newly created item ${createdItemId} should appear in items list`);
    });

    it('PUT /api/items/:id updates existing item and returns HTTP 200', async () => {
        assert.ok(createdItemId, 'Prerequisite: createdItemId must exist');
        const updatePayload = {
            content: 'Updated content ' + Date.now(),
            title: 'Updated Title'
        };

        const res = await fetchApi(baseUrl, `/api/items/${createdItemId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatePayload)
        });

        assert.strictEqual(res.status, 200, `Expected HTTP 200, got ${res.status}`);
        assert.ok(res.body && res.body.item, 'Expected response to contain updated item');
        assert.strictEqual(res.body.item.content, updatePayload.content, 'Content must be updated');
        assert.strictEqual(res.body.item.title, updatePayload.title, 'Title must be updated');
    });

    it('PATCH /api/items/:id/pin toggles pinned status and returns HTTP 200', async () => {
        assert.ok(createdItemId, 'Prerequisite: createdItemId must exist');

        // Toggle to true
        const pinRes = await fetchApi(baseUrl, `/api/items/${createdItemId}/pin`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: true })
        });
        assert.strictEqual(pinRes.status, 200, `Expected HTTP 200, got ${pinRes.status}`);
        assert.strictEqual(pinRes.body.item.pinned, true, 'Pinned should be true');

        // Toggle to false
        const unpinRes = await fetchApi(baseUrl, `/api/items/${createdItemId}/pin`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: false })
        });
        assert.strictEqual(unpinRes.status, 200, `Expected HTTP 200, got ${unpinRes.status}`);
        assert.strictEqual(unpinRes.body.item.pinned, false, 'Pinned should be false');
    });

    it('DELETE /api/items/:id deletes item and returns HTTP 200', async () => {
        assert.ok(createdItemId, 'Prerequisite: createdItemId must exist');

        const delRes = await fetchApi(baseUrl, `/api/items/${createdItemId}`, {
            method: 'DELETE'
        });
        assert.strictEqual(delRes.status, 200, `Expected HTTP 200, got ${delRes.status}`);
        assert.strictEqual(delRes.body.success, true, 'Expected success: true');

        // Verify item is no longer in GET /api/items
        const getRes = await fetchApi(baseUrl, '/api/items');
        const found = getRes.body.find(i => String(i.id) === String(createdItemId));
        assert.strictEqual(found, undefined, 'Deleted item should not appear in items list');

        // Deleting non-existent item returns 404
        const delAgain = await fetchApi(baseUrl, `/api/items/${createdItemId}`, {
            method: 'DELETE'
        });
        assert.strictEqual(delAgain.status, 404, 'Deleting non-existent item should return 404');
    });

    let createdTabId;
    it('Tabs CRUD: GET /api/tabs, POST /api/tabs, PUT /api/tabs/:id, DELETE /api/tabs/:id', async () => {
        // 1. GET /api/tabs
        const getTabs = await fetchApi(baseUrl, '/api/tabs');
        assert.strictEqual(getTabs.status, 200, 'GET /api/tabs should return 200');
        assert.ok(Array.isArray(getTabs.body), 'Tabs should be an array');
        const hasScratchpad = getTabs.body.some(t => t.id === 'scratchpad');
        assert.ok(hasScratchpad, 'Default scratchpad tab must exist');

        // 2. POST /api/tabs
        const newTabPayload = {
            name: 'E2E Tab ' + Date.now(),
            content: '# E2E Content',
            mode: 'markdown'
        };
        const postTab = await fetchApi(baseUrl, '/api/tabs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newTabPayload)
        });
        assert.strictEqual(postTab.status, 201, 'POST /api/tabs should return 201');
        assert.ok(postTab.body && postTab.body.tab, 'Response should contain created tab');
        assert.ok(postTab.body.tab.id, 'Created tab must have an id');
        assert.strictEqual(postTab.body.tab.name, newTabPayload.name);
        createdTabId = postTab.body.tab.id;

        // 3. PUT /api/tabs/:id
        const updateTabPayload = {
            name: 'Updated E2E Tab',
            content: 'Updated tab content'
        };
        const putTab = await fetchApi(baseUrl, `/api/tabs/${createdTabId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateTabPayload)
        });
        assert.strictEqual(putTab.status, 200, 'PUT /api/tabs/:id should return 200');
        assert.strictEqual(putTab.body.tab.name, updateTabPayload.name);
        assert.strictEqual(putTab.body.tab.content, updateTabPayload.content);

        // 4. DELETE /api/tabs/:id
        const deleteTab = await fetchApi(baseUrl, `/api/tabs/${createdTabId}`, {
            method: 'DELETE'
        });
        assert.strictEqual(deleteTab.status, 200, 'DELETE /api/tabs/:id should return 200');

        // Verify deleted from tabs list
        const afterDeleteTabs = await fetchApi(baseUrl, '/api/tabs');
        const tabFound = afterDeleteTabs.body.find(t => t.id === createdTabId);
        assert.strictEqual(tabFound, undefined, 'Deleted tab should not exist in tabs list');
    });

    it('POST /api/file and GET /api/file/:filename uploads and serves files accurately', async () => {
        const fileContent = 'Hello RellLab E2E Test Suite File Upload ' + Date.now();
        const originalFilename = 'e2e-test-file.txt';

        const formData = new FormData();
        const blob = new Blob([fileContent], { type: 'text/plain' });
        formData.append('file', blob, originalFilename);

        // Upload
        const uploadRes = await fetch(`${baseUrl}/api/file`, {
            method: 'POST',
            body: formData
        });
        assert.strictEqual(uploadRes.status, 201, `Upload should return 201, got ${uploadRes.status}`);
        const uploadBody = await uploadRes.json();
        assert.ok(uploadBody.success, 'Upload response success should be true');
        assert.ok(uploadBody.item, 'Upload response must include item');
        const uploadedFilename = uploadBody.item.filename;
        assert.ok(uploadedFilename, 'Uploaded item must have generated filename');

        // Retrieve file
        const getFileRes = await fetch(`${baseUrl}/api/file/${uploadedFilename}`);
        assert.strictEqual(getFileRes.status, 200, `GET /api/file/:filename should return 200, got ${getFileRes.status}`);
        const retrievedContent = await getFileRes.text();
        assert.strictEqual(retrievedContent, fileContent, 'Retrieved file content must match uploaded content');

        // Check Content-Disposition and Content-Length headers
        const disposition = getFileRes.headers.get('content-disposition');
        assert.ok(disposition, 'Content-Disposition header should be present');
        assert.ok(disposition.includes(encodeURIComponent(originalFilename)) || disposition.includes(originalFilename), 'Content-Disposition should reference filename');

        // Cleanup: delete the item
        await fetchApi(baseUrl, `/api/items/${uploadBody.item.id}`, { method: 'DELETE' });
    });
});
