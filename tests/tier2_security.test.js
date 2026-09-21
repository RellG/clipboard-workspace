const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { startTestServer, fetchApi } = require('./test_helpers');

describe('Tier 2: Boundary, Security & Error Conditions', () => {
    let baseUrl;
    let testServer;
    let testFileItem;

    before(async () => {
        if (process.env.TEST_BASE_URL) {
            baseUrl = process.env.TEST_BASE_URL;
        } else {
            testServer = await startTestServer();
            baseUrl = testServer.baseUrl;
        }

        // Upload a dummy file for range header tests
        const formData = new FormData();
        const blob = new Blob(['Sample range test file content for security boundary testing.'], { type: 'text/plain' });
        formData.append('file', blob, 'security-test.txt');
        const upRes = await fetch(`${baseUrl}/api/file`, { method: 'POST', body: formData });
        if (upRes.ok) {
            const body = await upRes.json();
            testFileItem = body.item;
        }
    });

    after(async () => {
        if (testFileItem && testFileItem.id) {
            try {
                await fetchApi(baseUrl, `/api/items/${testFileItem.id}`, { method: 'DELETE' });
            } catch {}
        }
        if (testServer) {
            await testServer.cleanup();
        }
    });

    it('Path Traversal: GET /api/file/.. returns HTTP 400 or 404, never 200, does not crash server', async () => {
        const res = await fetchApi(baseUrl, '/api/file/..');
        assert.ok([400, 404].includes(res.status), `Expected HTTP 400 or 404 for '..', got ${res.status}`);
        assert.notStrictEqual(res.status, 200, 'Must never return 200 on traversal path');

        // Confirm server is still healthy
        const health = await fetchApi(baseUrl, '/api/health');
        assert.strictEqual(health.status, 200, 'Server must remain alive and responsive');
    });

    it('Path Traversal: GET /api/file/. returns HTTP 400 or 404', async () => {
        const res = await fetchApi(baseUrl, '/api/file/.');
        assert.ok([400, 404].includes(res.status), `Expected HTTP 400 or 404 for '.', got ${res.status}`);
        assert.notStrictEqual(res.status, 200, 'Must never return 200 on traversal path');
    });

    it('Path Traversal: GET /api/file/%2e%2e returns HTTP 400 or 404', async () => {
        const res = await fetchApi(baseUrl, '/api/file/%2e%2e');
        assert.ok([400, 404].includes(res.status), `Expected HTTP 400 or 404 for '%2e%2e', got ${res.status}`);
        assert.notStrictEqual(res.status, 200, 'Must never return 200 on traversal path');
    });

    it('Path Traversal: GET /api/file/../../etc/passwd returns HTTP 400 or 404', async () => {
        const res = await fetchApi(baseUrl, '/api/file/../../etc/passwd');
        assert.ok([400, 404].includes(res.status), `Expected HTTP 400 or 404 for traversal path, got ${res.status}`);
        assert.notStrictEqual(res.status, 200, 'Must never return 200 on traversal path');

        // Verify passwd contents are not leaked
        assert.ok(!res.rawText.includes('root:x:0:0:'), 'Traversed system file contents must not be exposed');
    });

    it('Input Validation: POST /api/items with malformed JSON returns HTTP 400 JSON', async () => {
        const res = await fetch(`${baseUrl}/api/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"content":'
        });

        assert.strictEqual(res.status, 400, `Expected HTTP 400 on malformed JSON, got ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        assert.ok(contentType.includes('application/json'), `Expected JSON response for 400 error, got '${contentType}'`);
    });

    it('Input Validation: POST /api/items with { "content": 123 } (type confusion) returns HTTP 400 JSON', async () => {
        const res = await fetch(`${baseUrl}/api/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 123 })
        });

        assert.strictEqual(res.status, 400, `Expected HTTP 400 on non-string content type confusion, got ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        assert.ok(contentType.includes('application/json'), `Expected JSON response for 400 error, got '${contentType}'`);
    });

    it('Input Validation: POST /api/items with empty string or whitespace only returns HTTP 400 JSON', async () => {
        // Empty string
        const resEmpty = await fetchApi(baseUrl, '/api/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '' })
        });
        assert.strictEqual(resEmpty.status, 400, `Expected HTTP 400 on empty content, got ${resEmpty.status}`);
        assert.ok(resEmpty.contentType.includes('application/json'), 'Expected JSON error response');

        // Whitespace only
        const resWhitespace = await fetchApi(baseUrl, '/api/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '   \n\t  ' })
        });
        assert.strictEqual(resWhitespace.status, 400, `Expected HTTP 400 on whitespace content, got ${resWhitespace.status}`);
        assert.ok(resWhitespace.contentType.includes('application/json'), 'Expected JSON error response');
    });

    it('Input Validation: Deletion of scratchpad tab returns HTTP 400', async () => {
        const res = await fetchApi(baseUrl, '/api/tabs/scratchpad', {
            method: 'DELETE'
        });
        assert.strictEqual(res.status, 400, `Expected HTTP 400 when attempting to delete scratchpad tab, got ${res.status}`);
        assert.ok(res.contentType.includes('application/json'), 'Expected JSON error response');
    });

    it('Range header boundary: Invalid range (bytes=9999999-) returns HTTP 416 or rejects safely without 500', async () => {
        assert.ok(testFileItem && testFileItem.filename, 'Prerequisite: test file item must be uploaded');

        const res = await fetch(`${baseUrl}/api/file/${testFileItem.filename}`, {
            headers: { 'Range': 'bytes=9999999-' }
        });

        // HTTP 416 Range Not Satisfiable is the RFC 7233 compliant response; 400 is also an acceptable rejection.
        // It must NOT crash or return 500 Internal Server Error.
        assert.notStrictEqual(res.status, 500, `Must not return 500 on invalid Range request (got ${res.status})`);
        assert.ok([416, 400].includes(res.status), `Expected HTTP 416 or 400 on unsatisfiable range, got ${res.status}`);
    });
});
