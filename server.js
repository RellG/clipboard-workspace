const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

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
    try {
        if (!fs.existsSync(UPLOADS_DIR)) return;
        const files = fs.readdirSync(UPLOADS_DIR);
        const existingFilenames = new Set(db.items.filter(i => i.filename).map(i => i.filename));
        for (const file of files) {
            if (file === '.' || file === '..' || existingFilenames.has(file)) continue;
            const fullPath = path.join(UPLOADS_DIR, file);
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;

            const ext = path.extname(file).toLowerCase();
            let mimetype = 'application/octet-stream';
            let detectedType = 'file';
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
                mimetype = 'image/' + ext.replace('.', '');
                detectedType = 'image';
            } else if (['.mp4', '.webm', '.mov'].includes(ext)) {
                mimetype = 'video/' + ext.replace('.', '');
                detectedType = 'video';
            } else if (['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) {
                mimetype = 'audio/' + ext.replace('.', '');
                detectedType = 'audio';
            } else if (ext === '.pdf') {
                mimetype = 'application/pdf';
                detectedType = 'pdf';
            } else if (['.md', '.markdown'].includes(ext)) {
                mimetype = 'text/markdown';
                detectedType = 'markdown';
            } else if (['.js', '.ts', '.py', '.json', '.sh', '.html', '.css'].includes(ext)) {
                mimetype = 'text/plain';
                detectedType = 'code';
            }

            db.items.unshift({
                id: String(Date.now() + Math.random().toString().slice(2, 6)),
                type: 'file',
                fileType: detectedType,
                title: file,
                name: file,
                filename: file,
                size: stat.size,
                mimetype: mimetype,
                pinned: false,
                tags: [detectedType],
                timestamp: stat.mtime.toISOString(),
                updatedAt: stat.mtime.toISOString()
            });
        }
    } catch (e) {
        console.warn('[DB] syncOrphanFiles error:', e);
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
                        const ext = item.name ? path.extname(item.name).toLowerCase() : '';
                        let fileType = undefined;
                        if (isFile) {
                            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) fileType = 'image';
                            else if (['.mp4', '.webm', '.mov'].includes(ext)) fileType = 'video';
                            else if (['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) fileType = 'audio';
                            else if (ext === '.pdf') fileType = 'pdf';
                            else if (ext === '.md') fileType = 'markdown';
                            else fileType = 'file';
                        }

                        return {
                            id: String(item.id || Date.now() + Math.random().toString().slice(2, 6)),
                            type: isFile ? 'file' : (item.type || 'text'),
                            fileType: fileType,
                            title: item.title || item.name || (item.content ? item.content.slice(0, 50).split('\n')[0] : 'Untitled'),
                            content: item.content || '',
                            pinned: !!item.pinned,
                            tags: item.tags || (item.content && item.content.startsWith('http') ? ['link'] : (fileType ? [fileType] : [])),
                            timestamp: item.timestamp || new Date().toISOString(),
                            updatedAt: item.updatedAt || item.timestamp || new Date().toISOString(),
                            filename: item.filename,
                            name: item.name,
                            size: item.size,
                            mimetype: item.mimetype
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

// ============================================================================
// Multer File Storage
// ============================================================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname);
        cb(null, unique);
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100 MB
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
// REST API Endpoints
// ============================================================================

// 1. Get All Items
app.get('/api/items', (req, res) => {
    const { search, type, tag, pinned } = req.query;
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
    if (search && search.trim()) {
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

// 5. Upload File
app.post('/api/file', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    let detectedType = 'file';
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) detectedType = 'image';
    else if (['.mp4', '.webm', '.mov'].includes(ext)) detectedType = 'video';
    else if (['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) detectedType = 'audio';
    else if (ext === '.pdf') detectedType = 'pdf';
    else if (['.md', '.markdown'].includes(ext)) detectedType = 'markdown';
    else if (['.js', '.ts', '.py', '.json', '.sh', '.html', '.css'].includes(ext)) detectedType = 'code';

    const newFileItem = {
        id: String(Date.now() + Math.random().toString().slice(2, 6)),
        type: 'file',
        fileType: detectedType,
        title: req.file.originalname,
        name: req.file.originalname,
        filename: req.file.filename,
        size: req.file.size,
        mimetype: req.file.mimetype,
        pinned: false,
        tags: [detectedType],
        timestamp: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    db.items.unshift(newFileItem);
    saveDb();

    broadcastEvent('item_created', newFileItem);
    res.status(201).json({ success: true, item: newFileItem });
});

// 6. Serve / Download / Stream File
app.get('/api/file', (req, res) => {
    return res.status(400).json({ error: 'Invalid file path' });
});

app.get('/api/file/:filename', (req, res, next) => {
    try {
        const rawFilename = req.params.filename;
        if (!rawFilename || typeof rawFilename !== 'string') {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Reject directory traversal tokens, path separators, and null bytes
        if (rawFilename.includes('..') || rawFilename.includes('/') || rawFilename.includes('\\') || rawFilename.includes('\0')) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const safeFilename = path.basename(rawFilename);
        if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const resolvedUploadsDir = path.resolve(UPLOADS_DIR);
        const targetPath = path.resolve(resolvedUploadsDir, safeFilename);

        if (!targetPath.startsWith(resolvedUploadsDir + path.sep)) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (!fs.existsSync(targetPath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        let stat;
        try {
            stat = fs.statSync(targetPath);
        } catch (err) {
            return res.status(404).json({ error: 'File not found' });
        }

        if (!stat.isFile()) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const fileItem = db.items.find(i => i.filename === safeFilename);
        const originalName = fileItem ? fileItem.name : safeFilename;
        const mimetype = (fileItem && fileItem.mimetype) ? fileItem.mimetype : 'application/octet-stream';

        // Security headers: nosniff
        res.setHeader('X-Content-Type-Options', 'nosniff');

        // Serve .html and .svg as attachment to prevent stored XSS
        const ext = path.extname(safeFilename).toLowerCase();
        const isDangerousWebFile = ['.html', '.htm', '.svg'].includes(ext);

        const forceDownload = req.query.download === '1' || req.query.download === 'true' || isDangerousWebFile;
        const dispositionType = forceDownload ? 'attachment' : 'inline';
        res.setHeader('Content-Disposition', `${dispositionType}; filename="${encodeURIComponent(originalName)}"`);

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

            const parts = rangeSpec.split('-');
            if (parts.length !== 2) {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
            }

            let start;
            let end;

            if (parts[0] === '' && parts[1] !== '') {
                // Suffix byte range: e.g. bytes=-500
                const suffixLength = parseInt(parts[1], 10);
                if (isNaN(suffixLength) || suffixLength <= 0) {
                    res.setHeader('Content-Range', `bytes */${stat.size}`);
                    return res.status(416).json({ error: 'Range Not Satisfiable' });
                }
                start = Math.max(0, stat.size - suffixLength);
                end = stat.size - 1;
            } else if (parts[0] !== '' && parts[1] === '') {
                // Range from start: e.g. bytes=500-
                start = parseInt(parts[0], 10);
                end = stat.size - 1;
            } else if (parts[0] !== '' && parts[1] !== '') {
                // Explicit range: e.g. bytes=500-999
                start = parseInt(parts[0], 10);
                end = parseInt(parts[1], 10);
            } else {
                res.setHeader('Content-Range', `bytes */${stat.size}`);
                return res.status(416).json({ error: 'Range Not Satisfiable' });
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

// 7. Delete Item
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
        res.json({ success: true, id: item.id });
    } catch (err) {
        next(err);
    }
}

app.delete('/api/items/:id', deleteItemHandler);
app.delete('/api/text/:id', deleteItemHandler);
app.delete('/api/file/:id', deleteItemHandler);

// 8. Notepad Tabs Management
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

// 9. Health & System Metrics
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

// Global Express Error Middleware
app.use((err, req, res, next) => {
    console.error('[Global Error]:', err);
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'Malformed JSON payload' });
    }
    if (err instanceof multer.MulterError) {
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
