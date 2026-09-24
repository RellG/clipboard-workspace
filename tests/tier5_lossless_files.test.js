const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startTestServer, fetchApi } = require('./test_helpers');

describe('Tier 5: Lossless File Transfer & Integrity Verification', () => {
    let baseUrl;
    let testServer;
    let uploadedFileItem = null;
    let testRandomBytes = null;
    let testRandomSha256 = null;

    before(async () => {
        if (process.env.TEST_BASE_URL) {
            baseUrl = process.env.TEST_BASE_URL;
        } else {
            testServer = await startTestServer();
            baseUrl = testServer.baseUrl;
        }

        // Generate 64 KB of high-entropy random binary bytes
        testRandomBytes = crypto.randomBytes(64 * 1024);
        testRandomSha256 = crypto.createHash('sha256').update(testRandomBytes).digest('hex');
    });

    after(async () => {
        if (uploadedFileItem && uploadedFileItem.id) {
            try {
                await fetch(`${baseUrl}/api/files/${uploadedFileItem.id}`, { method: 'DELETE' });
            } catch (_) {}
        }
        if (testServer) {
            await testServer.cleanup();
        }
    });

    it('GET /api/files returns HTTP 200 and an array of file metadata', async () => {
        const res = await fetchApi(baseUrl, '/api/files');
        assert.strictEqual(res.status, 200, `Expected HTTP 200, got ${res.status}`);
        assert.ok(Array.isArray(res.body), 'Expected JSON array of files');
    });

    it('POST /api/files/upload stores arbitrary binary file with exact SHA-256 calculation', async () => {
        const formData = new FormData();
        const testFilename = `lossless-binary-test-${Date.now()}.bin`;
        const blob = new Blob([testRandomBytes], { type: 'application/octet-stream' });
        formData.append('files', blob, testFilename);

        const res = await fetch(`${baseUrl}/api/files/upload`, {
            method: 'POST',
            body: formData
        });

        assert.strictEqual(res.status, 201, `Expected HTTP 201, got ${res.status}`);
        const data = await res.json();
        assert.strictEqual(data.success, true, 'Expected success: true');
        assert.ok(Array.isArray(data.files), 'Expected files array in response');
        assert.strictEqual(data.files.length, 1, 'Expected 1 uploaded file item');

        uploadedFileItem = data.files[0];
        assert.ok(uploadedFileItem.id, 'Expected generated file id');
        assert.strictEqual(uploadedFileItem.name, testFilename, 'Expected original filename preserved');
        assert.strictEqual(uploadedFileItem.size, testRandomBytes.length, 'Expected exact file size');
        assert.strictEqual(uploadedFileItem.sha256, testRandomSha256, 'Server SHA-256 must match client SHA-256');
    });

    it('GET /api/files/:id/download retrieves bit-exact bytes with matching SHA-256 and RFC 6266 headers', async () => {
        assert.ok(uploadedFileItem && uploadedFileItem.id, 'Prerequisite: file must be uploaded');

        const res = await fetch(`${baseUrl}/api/files/${uploadedFileItem.id}/download`);
        assert.strictEqual(res.status, 200, `Expected HTTP 200, got ${res.status}`);

        // Verify headers
        assert.strictEqual(res.headers.get('content-length'), String(testRandomBytes.length), 'Content-Length must match exact size');
        assert.strictEqual(res.headers.get('x-sha256'), testRandomSha256, 'X-SHA256 header must match hash');
        assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff', 'nosniff header must be present');
        assert.strictEqual(res.headers.get('cache-control'), 'private, no-transform', 'no-transform must be present');

        const disposition = res.headers.get('content-disposition');
        assert.ok(disposition, 'Content-Disposition header must be present');
        assert.ok(disposition.includes('attachment'), 'Content-Disposition must be attachment');
        assert.ok(disposition.includes(uploadedFileItem.name), 'Content-Disposition must contain original filename');

        // Verify bit-for-bit payload integrity
        const arrayBuf = await res.arrayBuffer();
        const downloadedBuffer = Buffer.from(arrayBuf);
        assert.strictEqual(downloadedBuffer.length, testRandomBytes.length, 'Downloaded buffer length must match original');

        const downloadedSha256 = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');
        assert.strictEqual(downloadedSha256, testRandomSha256, 'Downloaded SHA-256 must match original payload SHA-256');
        assert.ok(downloadedBuffer.equals(testRandomBytes), 'Downloaded buffer must be byte-for-byte identical to original buffer');
    });

    it('GET /api/files/:id/download supports HTTP Range requests with exact byte slices', async () => {
        assert.ok(uploadedFileItem && uploadedFileItem.id, 'Prerequisite: file must be uploaded');

        const start = 512;
        const end = 1023; // 512 bytes
        const expectedSlice = testRandomBytes.subarray(start, end + 1);

        const res = await fetch(`${baseUrl}/api/files/${uploadedFileItem.id}/download`, {
            headers: { 'Range': `bytes=${start}-${end}` }
        });

        assert.strictEqual(res.status, 206, `Expected HTTP 206 Partial Content, got ${res.status}`);
        assert.strictEqual(res.headers.get('content-range'), `bytes ${start}-${end}/${testRandomBytes.length}`);
        assert.strictEqual(res.headers.get('content-length'), String(expectedSlice.length));

        const arrayBuf = await res.arrayBuffer();
        const sliceBuffer = Buffer.from(arrayBuf);
        assert.ok(sliceBuffer.equals(expectedSlice), 'Returned slice must match exact bytes');
    });

    it('GET /api/files supports filtering by filename and SHA-256 hash', async () => {
        assert.ok(uploadedFileItem && uploadedFileItem.id, 'Prerequisite: file must be uploaded');

        // Search by hash prefix
        const hashPrefix = testRandomSha256.slice(0, 12);
        const resHash = await fetchApi(baseUrl, `/api/files?search=${hashPrefix}`);
        assert.strictEqual(resHash.status, 200);
        assert.ok(Array.isArray(resHash.body));
        const foundByHash = resHash.body.some(f => f.id === uploadedFileItem.id);
        assert.ok(foundByHash, 'File must be found when searching by SHA-256 prefix');

        // Search by name
        const resName = await fetchApi(baseUrl, `/api/files?search=${encodeURIComponent(uploadedFileItem.name)}`);
        assert.strictEqual(resName.status, 200);
        const foundByName = resName.body.some(f => f.id === uploadedFileItem.id);
        assert.ok(foundByName, 'File must be found when searching by filename');
    });

    it('DELETE /api/files/:id deletes file from disk and database', async () => {
        assert.ok(uploadedFileItem && uploadedFileItem.id, 'Prerequisite: file must be uploaded');

        const deleteRes = await fetch(`${baseUrl}/api/files/${uploadedFileItem.id}`, { method: 'DELETE' });
        assert.strictEqual(deleteRes.status, 200, `Expected HTTP 200, got ${deleteRes.status}`);
        const deleteData = await deleteRes.json();
        assert.strictEqual(deleteData.success, true);

        // Subsequent download should return 404
        const downloadRes = await fetch(`${baseUrl}/api/files/${uploadedFileItem.id}/download`);
        assert.strictEqual(downloadRes.status, 404, 'Download after deletion must return 404');

        uploadedFileItem = null;
    });

    it('Frontend DOM: index.html contains dedicated File Transfer view, drop zone, table, and actions', () => {
        const htmlPath = path.join(__dirname, '..', 'index.html');
        assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
        const html = fs.readFileSync(htmlPath, 'utf8');

        assert.ok(html.includes('id="fileTransferView"'), 'index.html must contain #fileTransferView');
        assert.ok(html.includes('id="navItemFileTransfer"'), 'index.html must contain #navItemFileTransfer in sidebar');
        assert.ok(html.includes('id="ftDropZone"'), 'index.html must contain #ftDropZone');
        assert.ok(html.includes('id="ftFilesTable"'), 'index.html must contain #ftFilesTable');
        assert.ok(html.includes('id="ftSearchInput"'), 'index.html must contain #ftSearchInput');
        assert.ok(html.includes('switchAppView'), 'index.html must implement switchAppView()');
        assert.ok(html.includes('downloadFtFile'), 'index.html must implement downloadFtFile()');
        assert.ok(html.includes('copyFtCurlCommand'), 'index.html must implement copyFtCurlCommand()');
        assert.ok(html.includes('copyFtDownloadUrl'), 'index.html must implement copyFtDownloadUrl()');
    });
});
