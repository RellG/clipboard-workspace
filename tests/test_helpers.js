const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const net = require('net');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_SCRIPT = path.join(PROJECT_ROOT, 'server.js');

/**
 * Get a free random TCP port on localhost.
 */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

/**
 * Wait until an HTTP endpoint responds or timeout is reached.
 */
async function waitForHealthy(baseUrl, maxWaitMs = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
        try {
            const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) {
                return true;
            }
        } catch {
            // Server not ready yet
        }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Server at ${baseUrl} did not become healthy within ${maxWaitMs}ms`);
}

/**
 * Start an isolated instance of server.js in a dedicated temporary directory.
 * This guarantees zero interference with project or production db.json / uploads.
 */
async function startTestServer(port) {
    if (!port) {
        port = await getFreePort();
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-test-'));
    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
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

    let serverLogs = '';
    serverProc.stdout.on('data', d => { serverLogs += d.toString(); });
    serverProc.stderr.on('data', d => { serverLogs += d.toString(); });

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        await waitForHealthy(baseUrl, 6000);
    } catch (err) {
        serverProc.kill('SIGKILL');
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw new Error(`${err.message}\nServer Logs:\n${serverLogs}`);
    }

    const cleanup = async () => {
        return new Promise((resolve) => {
            if (!serverProc.killed) {
                serverProc.once('exit', () => {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch {}
                    resolve();
                });
                serverProc.kill('SIGTERM');
                setTimeout(() => {
                    if (!serverProc.killed) serverProc.kill('SIGKILL');
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch {}
                    resolve();
                }, 2000);
            } else {
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                } catch {}
                resolve();
            }
        });
    };

    return {
        baseUrl,
        port,
        pid: serverProc.pid,
        tempDir,
        serverProc,
        cleanup
    };
}

/**
 * Standard fetch helper with error and JSON handling.
 */
async function fetchApi(baseUrl, endpoint, options = {}) {
    const url = `${baseUrl}${endpoint}`;
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    let body;
    const rawText = await res.text();
    if (contentType.includes('application/json')) {
        try {
            body = JSON.parse(rawText);
        } catch {
            body = null;
        }
    } else {
        body = rawText;
    }
    return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        contentType,
        body,
        rawText
    };
}

/**
 * Connect to an SSE endpoint and collect events.
 */
function connectSse(baseUrl, endpoint = '/api/events') {
    const url = new URL(`${baseUrl}${endpoint}`);
    let req;
    let closed = false;
    const listeners = new Map();

    const client = {
        on(event, handler) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(handler);
            return client;
        },
        once(event) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error(`Timed out waiting for SSE event: ${event}`));
                }, 5000);

                const handler = (data) => {
                    clearTimeout(timer);
                    resolve(data);
                };
                if (!listeners.has(event)) listeners.set(event, []);
                listeners.get(event).push(handler);
            });
        },
        close() {
            if (!closed) {
                closed = true;
                if (req) req.destroy();
            }
        }
    };

    req = http.get(url, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
            buffer += chunk.toString();
            const messages = buffer.split('\n\n');
            buffer = messages.pop() || '';

            for (const msg of messages) {
                if (!msg.trim() || msg.startsWith(':')) continue;
                const lines = msg.split('\n');
                let eventType = 'message';
                let data = '';

                for (const line of lines) {
                    if (line.startsWith('event:')) {
                        eventType = line.replace('event:', '').trim();
                    } else if (line.startsWith('data:')) {
                        data = line.replace('data:', '').trim();
                    }
                }

                let parsedData = data;
                try {
                    parsedData = JSON.parse(data);
                } catch {}

                const handlers = listeners.get(eventType) || [];
                for (const h of handlers) {
                    try { h(parsedData); } catch (e) { console.error('SSE handler error:', e); }
                }
            }
        });
    });

    req.on('error', (err) => {
        if (!closed) {
            const handlers = listeners.get('error') || [];
            for (const h of handlers) h(err);
        }
    });

    return client;
}

module.exports = {
    PROJECT_ROOT,
    SERVER_SCRIPT,
    getFreePort,
    waitForHealthy,
    startTestServer,
    fetchApi,
    connectSse
};
