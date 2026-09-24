const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const { Transform } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const UPLOADS_DIR = path.resolve('./uploads');
const DATA_DIR = path.resolve('./data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DB_BAK_FILE = path.join(DATA_DIR, 'db.json.bak');
const BACKUP_SEED_FILE = path.resolve('./current-items-backup.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================================
// File Type, Sanitization, Path Resolution & Header Helpers
// ============================================================================

/**
 * Detect fileType category and ensure appropriate MIME type.
 */
function detectFileType(filename, mimetype) {
    const ext = path.extname(filename || '').toLowerCase();
    let detectedType = 'file';
    let detectedMime = mimetype || 'application/octet-stream';

    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
        detectedType = 'image';
        if (!mimetype || mimetype === 'application/octet-stream') {
            detectedMime = ext === '.svg' ? 'image/svg+xml' : 'image/' + ext.replace('.', '');
        }
    } else if (['.mp4', '.webm', '.mov'].includes(ext)) {
        detectedType = 'video';
        if (!mimetype || mimetype === 'application/octet-stream') {
            detectedMime = 'video/' + ext.replace('.', '');
        }
    } else if (['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) {
        detectedType = 'audio';
        if (!mimetype || mimetype === 'application/octet-stream') {
            detectedMime = 'audio/' + ext.replace('.', '');
        }
    } else if (ext === '.pdf') {
        detectedType = 'pdf';
        detectedMime = 'application/pdf';
    } else if (['.md', '.markdown'].includes(ext)) {
        detectedType = 'markdown';
        detectedMime = 'text/markdown';
    } else if (['.js', '.ts', '.py', '.json', '.sh', '.html', '.css'].includes(ext)) {
        detectedType = 'code';
        if (ext === '.json') detectedMime = 'application/json';
        else if (ext === '.html') detectedMime = 'text/html';
        else if (ext === '.css') detectedMime = 'text/css';
        else detectedMime = 'text/plain';
    }

    return { fileType: detectedType, mimetype: detectedMime };
}

/**
 * Validates and sanitizes a raw filename or identifier string.
 * Returns the clean, safe basename, or null if traversal/malformed tokens exist.
 */
function sanitizeUploadFilename(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') {
        return null;
    }

    let decoded = rawInput;
    try {
        decoded = decodeURIComponent(rawInput);
    } catch (_) {
        return null;
    }

    const inputsToCheck = [rawInput, decoded];
    for (const input of inputsToCheck) {
        const lower = input.toLowerCase();
        if (
            lower.includes('..') ||
            lower.includes('/') ||
            lower.includes('\\') ||
            lower.includes('\0') ||
            lower.includes('%2e') ||
            lower.includes('%2f') ||
            lower.includes('%5c') ||
            lower.includes('%00')
        ) {
            return null;
        }
    }

    const safeName = path.basename(decoded).trim();
    if (!safeName || safeName === '.' || safeName === '..') {
        return null;
    }

    return safeName;
}

/**
 * Resolves an upload filename to an absolute path within UPLOADS_DIR.
 * Enforces boundary checks and symlink resolution.
 */
function resolveUploadPath(filename, mustExist = true) {
    const safeName = sanitizeUploadFilename(filename);
    if (!safeName) return null;

    const resolvedUploadsDir = path.resolve(UPLOADS_DIR);
    const targetPath = path.resolve(resolvedUploadsDir, safeName);

    if (!targetPath.startsWith(resolvedUploadsDir + path.sep)) {
        return null;
    }

    if (!mustExist) {
        return { targetPath, safeName };
    }

    try {
        if (!fs.existsSync(targetPath)) return null;
        const stat = fs.statSync(targetPath);
        if (!stat.isFile()) return null;

        const realTarget = fs.realpathSync(targetPath);
        const realUploads = fs.realpathSync(resolvedUploadsDir);
        if (!realTarget.startsWith(realUploads + path.sep)) {
            return null;
        }

        return { targetPath: realTarget, stat, safeName };
    } catch (_) {
        return null;
    }
}

/**
 * Safely decodes multipart original filenames that may have been parsed as ISO-8859-1 (Latin-1)
 * by Multer/Busboy instead of UTF-8. Includes guards against 8-bit truncation of already-decoded
 * Cyrillic/Arabic strings, pure ASCII fast-path, and fallback if U+FFFD is generated.
 */
function decodeOriginalFilename(rawName) {
    if (!rawName || typeof rawName !== 'string') return rawName;

    // 1. If it contains characters > 255, it is already decoded Unicode
    if (/[^\x00-\xFF]/.test(rawName)) {
        return rawName;
    }

    // 2. Pure ASCII fast-path
    if (!/[^\x00-\x7F]/.test(rawName)) {
        return rawName;
    }

    // 3. Recover UTF-8 from Latin-1 bytes
    try {
        const decoded = Buffer.from(rawName, 'latin1').toString('utf8');
        if (decoded.includes('\uFFFD') && !rawName.includes('\uFFFD')) {
            return rawName;
        }
        return decoded;
    } catch (_) {
        return rawName;
    }
}

/**
 * Formats a Content-Disposition header conforming strictly to RFC 6266 and RFC 5987.
 * Syntax: <type>; filename="<ascii_fallback>"; filename*=UTF-8''<percent_encoded>
 */
function formatContentDisposition(originalName, isAttachment = true) {
    const dispositionType = isAttachment ? 'attachment' : 'inline';
    const decodedName = decodeOriginalFilename(originalName || 'file');
    const cleanName = decodedName.replace(/[\r\n\0]/g, '').trim();

    let asciiFallback = cleanName
        .replace(/["\\]/g, '')
        .replace(/[^\x20-\x7E]/g, '_');

    if (!asciiFallback.trim()) {
        asciiFallback = 'download';
    }

    const utf8Encoded = encodeURIComponent(cleanName)
        .replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

    return `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Compute SHA-256 synchronously with bounded 64KB constant memory.
 */
function computeFileSha256Sync(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024); // Exactly 64KB allocated once
    try {
        let bytesRead;
        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

// ============================================================================
// Custom Single-Pass Streaming Multer Engine with Concurrent SHA-256 Hashing
// ============================================================================

function createLosslessStreamStorage({ destination }) {
    if (!fs.existsSync(destination)) {
        fs.mkdirSync(destination, { recursive: true });
    }

    return {
        _handleFile(req, file, cb) {
            file.originalname = decodeOriginalFilename(file.originalname);
            const rawExt = path.extname(file.originalname || '');
            const cleanExt = rawExt.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 20);
            const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${cleanExt}`;
            const targetPath = path.join(destination, filename);

            const outStream = fs.createWriteStream(targetPath);
            const hash = crypto.createHash('sha256');
            let bytesWritten = 0;
            let finished = false;

            const cleanup = (done) => {
                const doUnlink = () => {
                    try {
                        if (fs.existsSync(targetPath)) {
                            fs.unlinkSync(targetPath);
                        }
                    } catch (_) {}
                    if (done) done();
                };

                if (outStream.destroyed || outStream.closed) {
                    doUnlink();
                } else {
                    outStream.once('close', doUnlink);
                    outStream.destroy();
                }
            };

            const hashTransform = new Transform({
                transform(chunk, encoding, callback) {
                    hash.update(chunk);
                    bytesWritten += chunk.length;
                    callback(null, chunk);
                }
            });

            const onAbort = () => {
                if (!finished) {
                    finished = true;
                    file.stream.unpipe(hashTransform);
                    hashTransform.unpipe(outStream);
                    cleanup(() => {
                        cb(new Error('Upload aborted'));
                    });
                }
            };

            req.once('aborted', onAbort);

            file.stream.on('limit', () => {
                if (!finished) {
                    finished = true;
                    req.removeListener('aborted', onAbort);
                    file.stream.unpipe(hashTransform);
                    hashTransform.unpipe(outStream);
                    cleanup(() => {
                        cb(new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname));
                    });
                }
            });

            file.stream.on('error', (err) => {
                if (!finished) {
                    finished = true;
                    req.removeListener('aborted', onAbort);
                    hashTransform.unpipe(outStream);
                    cleanup(() => {
                        cb(err);
                    });
                }
            });

            hashTransform.on('error', (err) => {
                if (!finished) {
                    finished = true;
                    req.removeListener('aborted', onAbort);
                    cleanup(() => {
                        cb(err);
                    });
                }
            });

            outStream.on('error', (err) => {
                if (!finished) {
                    finished = true;
                    req.removeListener('aborted', onAbort);
                    cleanup(() => {
                        cb(err);
                    });
                }
            });

            outStream.on('finish', () => {
                if (!finished) {
                    finished = true;
                    req.removeListener('aborted', onAbort);
                    if (file.truncated) {
                        return cleanup(() => {
                            cb(new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname));
                        });
                    }
                    cb(null, {
                        destination,
                        filename,
                        path: targetPath,
                        size: bytesWritten,
                        sha256: hash.digest('hex')
                    });
                }
            });

            file.stream.pipe(hashTransform).pipe(outStream);
        },

        _removeFile(req, file, cb) {
            const filePath = file.path || (file.filename ? path.join(destination, file.filename) : null);
            if (filePath) {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                } catch (_) {}
            }
            cb(null);
        }
    };
}

const upload = multer({
    storage: createLosslessStreamStorage({ destination: UPLOADS_DIR }),
    limits: {
        fileSize: 100 * 1024 * 1024, // 100 MB per file limit
        files: 20                    // Max 20 files per batch
    }
});

// Middleware for multi-file upload endpoints (accepting 'files', 'file', or any multipart field)
const uploadAnyFiles = (req, res, next) => {
    upload.any()(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File exceeds 100MB limit' });
            }
            if (err instanceof multer.MulterError) {
                return res.status(400).json({ error: `Upload error: ${err.message}` });
            }
            return res.status(400).json({ error: err.message || 'Upload failed' });
        }
        next();
    });
};

// ============================================================================
// Database & Persistence Layer
// ============================================================================
const DEFAULT_STATE = {
    version: 2,
    items: [],
    tabs: [
        { 
            id: 'scratchpad', 
            name: 'Scratchpad', 
            icon: 'doc', 
            content: '# Welcome to Clipboard\n\n- Press **Cmd/Ctrl + S** to quickly save\n- Type `/` to open the slash command menu\n- Drag and drop files anywhere on the canvas\n', 
            mode: 'markdown', 
            updatedAt: new Date().toISOString() 
        },
        { 
            id: 'notes', 
            name: 'Quick Notes', 
            icon: 'notes', 
            content: 'Meeting notes, links, and quick terminal snippets.\n', 
            mode: 'text', 
            updatedAt: new Date().toISOString() 
        }
    ]
};

let db = { ...DEFAULT_STATE };

function saveDb() {
    try {
        const tempFile = path.join(DATA_DIR, `.db.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8');

        // Flush file to disk before renaming
        const fd = fs.openSync(tempFile, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);

        // Maintain rolling backup of existing db.json before replacing
        if (fs.existsSync(DB_FILE)) {
            try {
                // Ensure existing DB_FILE is valid before backing up
                JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
                fs.copyFileSync(DB_FILE, DB_BAK_FILE);
            } catch (_) {
                // Ignore if existing DB_FILE was corrupt
            }
        }

        fs.renameSync(tempFile, DB_FILE);

        // Keep rolling backup updated
        try {
            fs.copyFileSync(DB_FILE, DB_BAK_FILE);
        } catch (_) {}
    } catch (err) {
        console.error('[DB] Error saving db.json:', err);
    }
}

function syncOrphanFiles() {
    let modified = false;
    try {
        if (!fs.existsSync(UPLOADS_DIR)) return;
        const files = fs.readdirSync(UPLOADS_DIR);
        const existingFilenames = new Set(db.items.filter(i => i.filename).map(i => i.filename));

        // 1. Detect untracked files on disk
        for (const file of files) {
            if (file === '.' || file === '..' || file.startsWith('.') || existingFilenames.has(file)) continue;
            const resolved = resolveUploadPath(file, true);
            if (!resolved) continue;

            const { targetPath, stat } = resolved;
            const { fileType, mimetype } = detectFileType(file);
            let sha256 = null;
            try {
                sha256 = computeFileSha256Sync(targetPath);
            } catch (err) {
                console.warn(`[DB] Failed to compute sha256 for orphan ${file}:`, err.message);
            }

            const now = stat.mtime.toISOString();
            const id = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const cleanOriginalName = decodeOriginalFilename(file);
            db.items.unshift({
                id,
                type: 'file',
                fileType,
                title: cleanOriginalName,
                name: cleanOriginalName,
                originalName: cleanOriginalName,
                filename: file,
                size: stat.size,
                mimetype,
                sha256,
                pinned: false,
                tags: [fileType],
                timestamp: now,
                createdAt: now,
                updatedAt: now,
                downloadUrl: `/api/files/${id}/download`
            });
            modified = true;
        }

        // 2. Backfill missing sha256, downloadUrl, and createdAt for existing items
        for (const item of db.items) {
            if (item.filename) {
                const resolved = resolveUploadPath(item.filename, true);
                if (resolved) {
                    if (!item.sha256) {
                        try {
                            item.sha256 = computeFileSha256Sync(resolved.targetPath);
                            modified = true;
                        } catch (err) {
                            console.warn(`[DB] Failed to backfill sha256 for ${item.filename}:`, err.message);
                        }
                    }
                    if (!item.downloadUrl) {
                        item.downloadUrl = `/api/files/${encodeURIComponent(String(item.id))}/download`;
                        modified = true;
                    }
                    if (!item.createdAt) {
                        item.createdAt = item.timestamp || item.updatedAt || new Date().toISOString();
                        modified = true;
                    }
                    if (!item.originalName) {
                        item.originalName = decodeOriginalFilename(item.name || item.title || item.filename);
                        modified = true;
                    } else {
                        const decoded = decodeOriginalFilename(item.originalName);
                        if (decoded !== item.originalName) {
                            item.originalName = decoded;
                            modified = true;
                        }
                    }
                    if (!item.name) {
                        item.name = item.originalName || decodeOriginalFilename(item.title || item.filename);
                        modified = true;
                    } else {
                        const decoded = decodeOriginalFilename(item.name);
                        if (decoded !== item.name) {
                            item.name = decoded;
                            modified = true;
                        }
                    }
                    if (item.title && (item.type === 'file' || !!item.filename)) {
                        const decoded = decodeOriginalFilename(item.title);
                        if (decoded !== item.title) {
                            item.title = decoded;
                            modified = true;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[DB] syncOrphanFiles error:', e);
    }

    if (modified) {
        console.log('[DB] Orphan sync & SHA-256 backfill updated items. Saving db.json...');
        saveDb();
    }
}

function loadDb() {
    let loaded = false;

    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            db = parsed;
            if (!Array.isArray(db.items)) db.items = [];
            if (!Array.isArray(db.tabs)) db.tabs = DEFAULT_STATE.tabs;
            console.log(`[DB] Loaded ${db.items.length} items and ${db.tabs.length} tabs from persistent storage.`);
            loaded = true;
        } catch (e) {
            console.error('[DB] Failed to parse db.json, quarantining corrupted file:', e);
            const corruptFile = path.join(DATA_DIR, `db.json.corrupt.${Date.now()}`);
            try {
                fs.copyFileSync(DB_FILE, corruptFile);
                console.warn(`[DB] Corrupted db.json quarantined to ${corruptFile}`);
            } catch (copyErr) {
                console.error('[DB] Failed to quarantine corrupted db.json:', copyErr);
            }
        }
    }

    // Attempt to load db.json.bak if available
    if (!loaded && fs.existsSync(DB_BAK_FILE)) {
        try {
            console.log('[DB] Attempting to load db.json.bak...');
            const rawBak = fs.readFileSync(DB_BAK_FILE, 'utf8');
            const parsedBak = JSON.parse(rawBak);
            db = parsedBak;
            if (!Array.isArray(db.items)) db.items = [];
            if (!Array.isArray(db.tabs)) db.tabs = DEFAULT_STATE.tabs;
            console.log(`[DB] Successfully restored ${db.items.length} items and ${db.tabs.length} tabs from db.json.bak!`);
            loaded = true;
        } catch (bakErr) {
            console.error('[DB] Failed to parse db.json.bak:', bakErr);
        }
    }

    // Only fall back to seed backup if neither exists or could be loaded
    if (!loaded) {
        console.warn('[DB] CRITICAL WARNING: Neither db.json nor db.json.bak could be loaded! Falling back to seed backup without deleting corrupt files.');
        if (fs.existsSync(BACKUP_SEED_FILE)) {
            try {
                const backupRaw = fs.readFileSync(BACKUP_SEED_FILE, 'utf8');
                const seededItems = JSON.parse(backupRaw);
                if (Array.isArray(seededItems)) {
                    db.items = seededItems.map(item => {
                        const isFile = item.type === 'file' || !!item.filename;
                        const { fileType, mimetype } = detectFileType(item.name || item.filename, item.mimetype);

                        const id = String(item.id || `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
                        return {
                            id,
                            type: isFile ? 'file' : (item.type || 'text'),
                            fileType: isFile ? fileType : undefined,
                            title: item.title || item.name || (item.content ? item.content.slice(0, 50).split('\n')[0] : 'Untitled'),
                            content: item.content || '',
                            pinned: !!item.pinned,
                            tags: item.tags || (item.content && item.content.startsWith('http') ? ['link'] : (fileType ? [fileType] : [])),
                            timestamp: item.timestamp || new Date().toISOString(),
                            createdAt: item.createdAt || item.timestamp || new Date().toISOString(),
                            updatedAt: item.updatedAt || item.timestamp || new Date().toISOString(),
                            filename: item.filename,
                            name: item.name,
                            originalName: item.originalName || item.name,
                            size: item.size,
                            mimetype: item.mimetype || mimetype,
                            sha256: item.sha256 || null,
                            downloadUrl: isFile ? `/api/files/${id}/download` : undefined
                        };
                    });
                    console.log(`[DB] Successfully seeded ${db.items.length} items from previous live backup!`);
                }
            } catch (err) {
                console.warn('[DB] Could not seed from backup:', err.message);
            }
        }
    }

    syncOrphanFiles();
    saveDb();
}

loadDb();

// ============================================================================
// Server-Sent Events (SSE) Real-Time Synchronization
// ============================================================================
const sseClients = new Set();

function broadcastEvent(eventType, payload) {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        try {
            if (client.writable && !client.destroyed) {
                client.write(message);
            } else {
                sseClients.delete(client);
            }
        } catch (err) {
            sseClients.delete(client);
        }
    }
}

app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.on('error', (err) => {
        console.warn('[SSE] Client connection error:', err.message);
        sseClients.delete(res);
    });

    if (res.writable && !res.destroyed) {
        res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', clients: sseClients.size + 1 })}\n\n`);
    }
    sseClients.add(res);

    const pingInterval = setInterval(() => {
        try {
            if (res.writable && !res.destroyed) {
                res.write(': ping\n\n');
            } else {
                clearInterval(pingInterval);
                sseClients.delete(res);
            }
        } catch (e) {
            clearInterval(pingInterval);
            sseClients.delete(res);
        }
    }, 20000);

    req.on('close', () => {
        clearInterval(pingInterval);
        sseClients.delete(res);
    });
});

function detectContentType(content, explicitType) {
    if (explicitType && explicitType !== 'auto') return explicitType;
    if (!content) return 'text';
    const trimmed = content.trim();
    if (/^https?:\/\/[^\s]+$/i.test(trimmed) || trimmed.startsWith('http://') || trimmed.startsWith('https://')) return 'link';
    if (trimmed.startsWith('```') || trimmed.includes('function ') || trimmed.includes('const ') || trimmed.includes('import ') || trimmed.startsWith('#!/') || /^[A-Za-z0-9_-]{32,}$/.test(trimmed)) return 'code';
    if (trimmed.startsWith('#') || trimmed.includes('##') || trimmed.includes('- [ ]') || trimmed.includes('* ')) return 'markdown';
    return 'text';
}

// ============================================================================
// REST API Endpoints: Items & Tabs
// ============================================================================

// 1. Get All Items
app.get('/api/items', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const type = typeof req.query.type === 'string' ? req.query.type.trim() : '';
    const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';
    const pinned = typeof req.query.pinned === 'string' ? req.query.pinned.trim() : '';
    let list = [...db.items];

    if (pinned === 'true') {
        list = list.filter(i => i.pinned);
    }
    if (type && type !== 'all') {
        list = list.filter(i => i.type === type || (i.fileType && i.fileType === type));
    }
    if (tag) {
        list = list.filter(i => Array.isArray(i.tags) && i.tags.includes(tag));
    }
    if (search) {
        const q = search.toLowerCase();
        list = list.filter(i => 
            (i.title && i.title.toLowerCase().includes(q)) ||
            (i.content && i.content.toLowerCase().includes(q)) ||
            (i.name && i.name.toLowerCase().includes(q)) ||
            (i.tags && i.tags.some(t => t.toLowerCase().includes(q)))
        );
    }

    // Sort: Pinned first, then newest updatedAt
    list.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.updatedAt || b.timestamp) - new Date(a.updatedAt || a.timestamp);
    });

    res.json(list);
});

// 2. Create Text / Code / Markdown / Link item
function createItemHandler(req, res, next) {
    try {
        const { content, title, type, language, tags, pinned, tabId } = req.body || {};
        if (typeof content !== 'string' || content.trim().length === 0) {
            return res.status(400).json({ error: 'Content must be a non-empty string' });
        }

        const detectedType = detectContentType(content, type);
        let itemTitle = title;
        if (!itemTitle) {
            const firstLine = content.trim().split('\n')[0].replace(/^[#\s*\->]+/, '').trim();
            itemTitle = firstLine.slice(0, 60) || 'Untitled Note';
        }

        const newItem = {
            id: String(Date.now() + Math.random().toString().slice(2, 6)),
            type: detectedType,
            title: itemTitle,
            content: content,
            language: language || (detectedType === 'code' ? 'javascript' : undefined),
            tags: Array.isArray(tags) ? tags : (detectedType === 'link' ? ['link'] : []),
            pinned: !!pinned,
            tabId: tabId || 'scratchpad',
            timestamp: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        db.items.unshift(newItem);
        saveDb();

        broadcastEvent('item_created', newItem);
        res.status(201).json({ success: true, item: newItem });
    } catch (err) {
        next(err);
    }
}

app.post('/api/items', createItemHandler);
app.post('/api/text', createItemHandler);

// 3. Update Existing Item
function updateItemHandler(req, res, next) {
    try {
        const id = String(req.params.id);
        const index = db.items.findIndex(i => String(i.id) === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const existing = db.items[index];
        const { content, title, type, language, tags, pinned } = req.body || {};

        if (content !== undefined) {
            if (typeof content !== 'string' || content.trim().length === 0) {
                return res.status(400).json({ error: 'Content must be a non-empty string' });
            }
            existing.content = content;
        }
        if (title !== undefined) existing.title = title;
        if (type !== undefined) existing.type = type;
        if (language !== undefined) existing.language = language;
        if (tags !== undefined) existing.tags = tags;
        if (pinned !== undefined) existing.pinned = !!pinned;
        existing.updatedAt = new Date().toISOString();

        saveDb();
        broadcastEvent('item_updated', existing);
        res.json({ success: true, item: existing });
    } catch (err) {
        next(err);
    }
}

app.put('/api/items/:id', updateItemHandler);
app.put('/api/text/:id', updateItemHandler);

// 4. Pin/Unpin Item
app.patch('/api/items/:id/pin', (req, res) => {
    const id = String(req.params.id);
    const item = db.items.find(i => String(i.id) === id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    item.pinned = req.body.pinned !== undefined ? !!req.body.pinned : !item.pinned;
    item.updatedAt = new Date().toISOString();
    saveDb();

    broadcastEvent('item_updated', item);
    res.json({ success: true, item });
});

// 5. Delete Item Handler (for /api/items/:id, /api/text/:id, /api/file/:id)
function deleteItemHandler(req, res, next) {
    try {
        const id = String(req.params.id);
        const index = db.items.findIndex(i => String(i.id) === id || (i.filename && i.filename === id));

        if (index === -1) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const item = db.items[index];
        if (item.filename) {
            const safeFilename = path.basename(item.filename);
            const resolvedUploadsDir = path.resolve(UPLOADS_DIR);
            const filePath = path.resolve(resolvedUploadsDir, safeFilename);
            if (filePath.startsWith(resolvedUploadsDir + path.sep)) {
                if (fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch (e) { console.warn('File unlink error:', e); }
                }
            }
        }

        db.items.splice(index, 1);
        saveDb();

        broadcastEvent('item_deleted', { id: item.id });
        if (item.type === 'file' || item.filename) {
            broadcastEvent('file_deleted', { id: item.id, filename: item.filename });
        }
        res.json({ success: true, id: item.id });
    } catch (err) {
        next(err);
    }
}

app.delete('/api/items/:id', deleteItemHandler);
app.delete('/api/text/:id', deleteItemHandler);
app.delete('/api/file/:id', deleteItemHandler);

// ============================================================================
// Dedicated Lossless File Storage & Retrieval REST API
// ============================================================================

/**
 * Helper to format standard file metadata response object.
 */
function formatFileMetadata(item) {
    const id = String(item.id);
    const rawName = item.name || item.originalName || item.title || item.filename;
    const name = decodeOriginalFilename(rawName);
    return {
        id,
        name,
        filename: item.filename,
        size: item.size !== undefined ? item.size : 0,
        mimetype: item.mimetype || 'application/octet-stream',
        fileType: item.fileType || 'file',
        sha256: item.sha256 || null,
        createdAt: item.createdAt || item.timestamp,
        downloadUrl: item.downloadUrl || `/api/files/${encodeURIComponent(id)}/download`
    };
}

/**
 * 1. GET /api/files
 * Returns stored files with metadata, supporting search and sort.
 */
app.get('/api/files', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const sort = typeof req.query.sort === 'string' ? req.query.sort.trim() : '';
    let list = db.items.filter(i => i.type === 'file' || !!i.filename);

    if (search) {
        const q = search.toLowerCase();
        list = list.filter(i =>
            (i.name && i.name.toLowerCase().includes(q)) ||
            (i.title && i.title.toLowerCase().includes(q)) ||
            (i.filename && i.filename.toLowerCase().includes(q)) ||
            (i.sha256 && i.sha256.toLowerCase().includes(q)) ||
            (i.mimetype && i.mimetype.toLowerCase().includes(q)) ||
            (i.tags && Array.isArray(i.tags) && i.tags.some(t => t.toLowerCase().includes(q)))
        );
    }

    if (sort === 'size_desc') {
        list.sort((a, b) => (b.size || 0) - (a.size || 0));
    } else if (sort === 'size_asc') {
        list.sort((a, b) => (a.size || 0) - (b.size || 0));
    } else if (sort === 'name_asc') {
        list.sort((a, b) => (a.name || a.title || '').localeCompare(b.name || b.title || ''));
    } else if (sort === 'date_asc') {
        list.sort((a, b) => new Date(a.createdAt || a.timestamp || 0) - new Date(b.createdAt || b.timestamp || 0));
    } else {
        // default: newest date first
        list.sort((a, b) => new Date(b.createdAt || b.timestamp || 0) - new Date(a.createdAt || a.timestamp || 0));
    }

    res.json(list.map(formatFileMetadata));
});

/**
 * 2. POST /api/files/upload
 * Handles single and multi-file uploads (accepting 'files', 'file', or any multipart field).
 * Returns HTTP 201 with array of created file metadata. Enforces 100MB limit.
 */
app.post('/api/files/upload', uploadAnyFiles, (req, res, next) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const createdItems = [];
        const now = new Date().toISOString();

        for (const file of req.files) {
            const originalName = decodeOriginalFilename(file.originalname);
            const { fileType, mimetype } = detectFileType(originalName, file.mimetype);
            const id = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const newItem = {
                id,
                type: 'file',
                fileType,
                title: originalName,
                name: originalName,
                originalName: originalName,
                filename: file.filename,
                size: file.size,
                mimetype,
                sha256: file.sha256,
                pinned: false,
                tags: [fileType],
                timestamp: now,
                createdAt: now,
                updatedAt: now,
                downloadUrl: `/api/files/${id}/download`
            };

            db.items.unshift(newItem);
            createdItems.push(newItem);
            broadcastEvent('item_created', newItem);
        }

        saveDb();
        broadcastEvent('files_uploaded', { files: createdItems });

        res.status(201).json({
            success: true,
            files: createdItems.map(formatFileMetadata)
        });
    } catch (err) {
        next(err);
    }
});

/**
 * 3. GET /api/files/:id
 * Returns single file metadata by item ID.
 */
app.get('/api/files/:id', (req, res) => {
    const rawId = req.params.id;
    const safeId = sanitizeUploadFilename(rawId);
    if (!safeId) {
        return res.status(400).json({ error: 'Invalid file ID' });
    }

    const item = db.items.find(i => (String(i.id) === safeId || i.filename === safeId) && (i.type === 'file' || !!i.filename));
    if (!item) {
        return res.status(404).json({ error: 'File not found' });
    }

    res.json(formatFileMetadata(item));
});

/**
 * 4. GET /api/files/:id/download
 * Streams file byte-for-byte by item ID (or disk filename fallback).
 * Sets RFC 6266 & 5987 Content-Disposition, Content-Length, Content-Type, X-SHA256,
 * ETag, Accept-Ranges, Cache-Control, and X-Content-Type-Options.
 * Supports HTTP 206 Range requests.
 */
app.get('/api/files/:id/download', (req, res, next) => {
    try {
        const rawId = req.params.id;
        const safeId = sanitizeUploadFilename(rawId);
        if (!safeId) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        let fileItem = db.items.find(i => (String(i.id) === safeId || i.filename === safeId) && (i.type === 'file' || !!i.filename));
        let diskFilename = fileItem ? fileItem.filename : safeId;

        const resolved = resolveUploadPath(diskFilename, true);
        if (!resolved) {
            return res.status(404).json({ error: fileItem ? 'File not found on disk' : 'File not found' });
        }

        const { targetPath, stat } = resolved;
        const rawOriginalName = fileItem ? (fileItem.originalName || fileItem.name || fileItem.title || diskFilename) : diskFilename;
        const originalName = decodeOriginalFilename(rawOriginalName);
        const mimetype = (fileItem && fileItem.mimetype) ? fileItem.mimetype : 'application/octet-stream';

        let sha256 = (fileItem && fileItem.sha256) ? fileItem.sha256 : '';
        if (!sha256) {
            try {
                sha256 = computeFileSha256Sync(targetPath);
                if (fileItem) {
                    fileItem.sha256 = sha256;
                    saveDb();
                }
            } catch (_) {}
        }

        // Set standard security, caching, and range headers
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-transform');
        res.setHeader('Accept-Ranges', 'bytes');
        if (sha256) {
            res.setHeader('X-SHA256', sha256);
            res.setHeader('ETag', `"${sha256}"`);
        }

        const ext = path.extname(originalName).toLowerCase();
        const isDangerous = ['.html', '.htm', '.svg'].includes(ext);
        const isInline = typeof req.query.inline === 'string' && req.query.inline.trim() === '1';
        const isAttachment = !isInline || isDangerous;
        res.setHeader('Content-Disposition', formatContentDisposition(originalName, isAttachment));

        // HTTP 206 Range handling
        const range = req.headers.range;
        if (range) {
            if (!range.startsWith('bytes=')) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
            }

            const rangeSpec = range.replace(/^bytes=/, '').trim();
            if (rangeSpec.includes(',')) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
            }

            const match = rangeSpec.match(/^(\d*)-(\d*)$/);
            if (!match || (match[1] === '' && match[2] === '')) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
            }

            let start;
            let end;

            if (match[1] === '') {
                // Suffix range: bytes=-N
                const suffixLength = parseInt(match[2], 10);
                if (isNaN(suffixLength) || suffixLength <= 0) {
                    res.setHeader('Content-Range', `bytes */${stat.size}`);
                    return res.status(416).json({ error: 'Range Not Satisfiable' });
                }
                start = Math.max(0, stat.size - suffixLength);
                end = stat.size - 1;
            } else if (match[2] === '') {
                // Prefix range: bytes=N-
                start = parseInt(match[1], 10);
                end = stat.size - 1;
            } else {
                // Closed range: bytes=N-M
                start = parseInt(match[1], 10);
                end = parseInt(match[2], 10);
            }

            if (isNaN(start) || isNaN(end) || start < 0 || start >= stat.size || start > end) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
            }
            if (end >= stat.size) end = stat.size - 1;

            const chunkSize = (end - start) + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': mimetype
            });

            const stream = fs.createReadStream(targetPath, { start, end });
            stream.on('error', (err) => {
                console.error('[Stream Error]:', err);
                if (!res.headersSent) res.status(500).json({ error: 'Error reading file stream' });
                else res.destroy(err);
            });
            stream.pipe(res);
            return;
        }

        // Full file streaming (HTTP 200)
        res.setHeader('Content-Type', mimetype);
        res.setHeader('Content-Length', stat.size);

        const stream = fs.createReadStream(targetPath);
        stream.on('error', (err) => {
            console.error('[Stream Error]:', err);
            if (!res.headersSent) res.status(500).json({ error: 'Error reading file stream' });
            else res.destroy(err);
        });
        stream.pipe(res);
    } catch (err) {
        next(err);
    }
});

/**
 * 5. DELETE /api/files/:id
 * Removes physical file from uploads/ and item from data/db.json.
 * Broadcasts file_deleted and item_deleted SSE events.
 * Returns HTTP 200 { success: true, id, deleted } or 404.
 */
app.delete('/api/files/:id', (req, res, next) => {
    try {
        const rawId = req.params.id;
        const safeId = sanitizeUploadFilename(rawId);
        if (!safeId) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const index = db.items.findIndex(i => (String(i.id) === safeId || i.filename === safeId) && (i.type === 'file' || !!i.filename));
        if (index === -1) {
            return res.status(404).json({ error: 'File not found' });
        }

        const item = db.items[index];
        if (item.filename) {
            const resolved = resolveUploadPath(item.filename, false);
            if (resolved && fs.existsSync(resolved.targetPath)) {
                try {
                    fs.unlinkSync(resolved.targetPath);
                } catch (e) {
                    console.warn('[DB] File unlink error:', e.message);
                }
            }
        }

        db.items.splice(index, 1);
        saveDb();

        broadcastEvent('file_deleted', { id: item.id, filename: item.filename });
        broadcastEvent('item_deleted', { id: item.id });

        res.json({ success: true, id: item.id, deleted: item.id });
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// Backward Compatibility Endpoints for Legacy /api/file and /api/file/:filename
// ============================================================================

// Legacy POST /api/file
app.post('/api/file', upload.single('file'), (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const originalName = decodeOriginalFilename(req.file.originalname);
        const { fileType, mimetype } = detectFileType(originalName, req.file.mimetype);
        const now = new Date().toISOString();
        const id = String(Date.now() + Math.random().toString().slice(2, 6));

        const newFileItem = {
            id,
            type: 'file',
            fileType,
            title: originalName,
            name: originalName,
            originalName: originalName,
            filename: req.file.filename,
            size: req.file.size,
            mimetype,
            sha256: req.file.sha256,
            pinned: false,
            tags: [fileType],
            timestamp: now,
            createdAt: now,
            updatedAt: now,
            downloadUrl: `/api/files/${id}/download`
        };

        db.items.unshift(newFileItem);
        saveDb();

        broadcastEvent('item_created', newFileItem);
        broadcastEvent('files_uploaded', { files: [newFileItem] });
        res.status(201).json({ success: true, item: newFileItem });
    } catch (err) {
        next(err);
    }
});

// Legacy GET /api/file
app.get('/api/file', (req, res) => {
    return res.status(400).json({ error: 'Invalid file path' });
});

// Legacy GET /api/file/:filename
app.get('/api/file/:filename', (req, res, next) => {
    try {
        const rawFilename = req.params.filename;
        const safeFilename = sanitizeUploadFilename(rawFilename);
        if (!safeFilename) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const resolved = resolveUploadPath(safeFilename, true);
        if (!resolved) {
            return res.status(404).json({ error: 'File not found' });
        }

        const { targetPath, stat } = resolved;
        const fileItem = db.items.find(i => i.filename === safeFilename || String(i.id) === safeFilename);
        const rawOriginalName = fileItem ? (fileItem.originalName || fileItem.name || safeFilename) : safeFilename;
        const originalName = decodeOriginalFilename(rawOriginalName);
        const mimetype = (fileItem && fileItem.mimetype) ? fileItem.mimetype : 'application/octet-stream';
        let sha256 = (fileItem && fileItem.sha256) ? fileItem.sha256 : '';
        if (!sha256) {
            try {
                sha256 = computeFileSha256Sync(targetPath);
                if (fileItem) {
                    fileItem.sha256 = sha256;
                    saveDb();
                }
            } catch (_) {}
        }

        // Security headers: nosniff
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-transform');
        res.setHeader('Accept-Ranges', 'bytes');
        if (sha256) {
            res.setHeader('X-SHA256', sha256);
            res.setHeader('ETag', `"${sha256}"`);
        }

        // Serve .html and .svg as attachment to prevent stored XSS
        const ext = path.extname(safeFilename).toLowerCase();
        const isDangerousWebFile = ['.html', '.htm', '.svg'].includes(ext);
        const downloadParam = typeof req.query.download === 'string' ? req.query.download.trim() : '';
        const forceDownload = downloadParam === '1' || downloadParam === 'true' || isDangerousWebFile;
        const dispositionType = forceDownload ? 'attachment' : 'inline';

        res.setHeader('Content-Disposition', formatContentDisposition(originalName, dispositionType === 'attachment'));

        // HTTP Range requests for video/audio streaming
        const range = req.headers.range;
        if (range) {
            if (!range.startsWith('bytes=')) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
            }

            const rangeSpec = range.replace(/^bytes=/, '').trim();
            if (rangeSpec.includes(',')) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
            }

            const match = rangeSpec.match(/^(\d*)-(\d*)$/);
            if (!match || (match[1] === '' && match[2] === '')) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
            }

            let start;
            let end;

            if (match[1] === '') {
                const suffixLength = parseInt(match[2], 10);
                if (isNaN(suffixLength) || suffixLength <= 0) {
                    res.setHeader('Content-Range', `bytes */${stat.size}`);
                    return res.status(416).json({ error: 'Range Not Satisfiable' });
                }
                start = Math.max(0, stat.size - suffixLength);
                end = stat.size - 1;
            } else if (match[2] === '') {
                start = parseInt(match[1], 10);
                end = stat.size - 1;
            } else {
                start = parseInt(match[1], 10);
                end = parseInt(match[2], 10);
            }

            if (isNaN(start) || isNaN(end) || start < 0 || start >= stat.size || start > end) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
            }

            if (end >= stat.size) {
                end = stat.size - 1;
            }

            const chunksize = (end - start) + 1;
            const fileStream = fs.createReadStream(targetPath, { start, end });

            fileStream.on('error', (streamErr) => {
                console.error('[FileStream Error]:', streamErr);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error reading file stream' });
                }
            });

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': mimetype
            });
            fileStream.pipe(res);
            return;
        }

        res.setHeader('Content-Type', mimetype);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Accept-Ranges', 'bytes');

        const fileStream = fs.createReadStream(targetPath);
        fileStream.on('error', (streamErr) => {
            console.error('[FileStream Error]:', streamErr);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });
        fileStream.pipe(res);
    } catch (err) {
        next(err);
    }
});

// ============================================================================
// Notepad Tabs Management
// ============================================================================
app.get('/api/tabs', (req, res) => {
    res.json(db.tabs || []);
});

app.put('/api/tabs/:id', (req, res) => {
    const id = req.params.id;
    let tab = db.tabs.find(t => t.id === id);
    if (!tab) {
        tab = { id, name: req.body.name || 'New Tab', icon: '📝', content: '', mode: 'markdown', updatedAt: new Date().toISOString() };
        db.tabs.push(tab);
    }

    if (req.body.content !== undefined) tab.content = req.body.content;
    if (req.body.name !== undefined) tab.name = req.body.name;
    if (req.body.icon !== undefined) tab.icon = req.body.icon;
    if (req.body.mode !== undefined) tab.mode = req.body.mode;
    if (req.body.language !== undefined) tab.language = req.body.language;
    tab.updatedAt = new Date().toISOString();

    saveDb();
    broadcastEvent('tab_updated', tab);
    res.json({ success: true, tab });
});

app.post('/api/tabs', (req, res) => {
    const newTab = {
        id: 'tab_' + Date.now(),
        name: req.body.name || 'Untitled Tab',
        icon: req.body.icon || '📝',
        content: req.body.content || '',
        mode: req.body.mode || 'markdown',
        language: req.body.language || 'javascript',
        updatedAt: new Date().toISOString()
    };
    db.tabs.push(newTab);
    saveDb();
    broadcastEvent('tab_created', newTab);
    res.status(201).json({ success: true, tab: newTab });
});

app.delete('/api/tabs/:id', (req, res) => {
    const id = req.params.id;
    if (id === 'scratchpad' || id === 'notes') {
        return res.status(400).json({ error: `Cannot delete default tab: ${id}` });
    }
    const idx = db.tabs.findIndex(t => t.id === id);
    if (idx !== -1) {
        db.tabs.splice(idx, 1);
        saveDb();
        broadcastEvent('tab_deleted', { id });
    }
    res.json({ success: true });
});

// ============================================================================
// Health & System Metrics
// ============================================================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        items: db.items.length,
        tabs: db.tabs.length,
        connectedClients: sseClients.size,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
    });
});

// ============================================================================
// Global Error Middleware & Process Lifecycle
// ============================================================================
app.use((err, req, res, next) => {
    console.error('[Global Error]:', err);
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'Malformed JSON payload' });
    }
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File exceeds 100MB limit' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    const statusCode = err.status || err.statusCode || 500;
    res.status(statusCode).json({ error: err.message || 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✨ RellLab Clipboard Engine v2 running on port ${PORT}`);
    console.log(`📁 Persistence active at ${DB_FILE}`);
    console.log(`📡 SSE Stream live at /api/events`);
});

// Process Resilience
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught Exception:', err);
    try {
        saveDb();
    } catch (e) {
        console.error('[Process] Failed to save DB on uncaughtException:', e);
    }
    process.exit(1);
});

function gracefulShutdown(signal) {
    console.log(`[Process] Received ${signal}. Flushing database and shutting down gracefully...`);
    try {
        saveDb();
    } catch (e) {
        console.error('[Process] Error saving DB on shutdown:', e);
    }
    if (server) {
        server.close(() => {
            console.log('[Process] HTTP server closed.');
            process.exit(0);
        });
        setTimeout(() => {
            console.warn('[Process] Forcing shutdown after timeout.');
            process.exit(0);
        }, 5000).unref();
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
