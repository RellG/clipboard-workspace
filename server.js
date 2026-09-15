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
const BACKUP_SEED_FILE = path.resolve('./current-items-backup.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

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
        const tmpPath = DB_FILE + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf8');
        fs.renameSync(tmpPath, DB_FILE);
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
    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            db = JSON.parse(raw);
            if (!Array.isArray(db.items)) db.items = [];
            if (!Array.isArray(db.tabs)) db.tabs = DEFAULT_STATE.tabs;
            console.log(`[DB] Loaded ${db.items.length} items and ${db.tabs.length} tabs from persistent storage.`);
            syncOrphanFiles();
            return;
        } catch (e) {
            console.error('[DB] Failed to parse db.json, falling back to seed/backup:', e);
        }
    }

    // Seed from current-items-backup.json if available
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
            client.write(message);
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

    res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', clients: sseClients.size + 1 })}\n\n`);
    sseClients.add(res);

    const pingInterval = setInterval(() => {
        try {
            res.write(': ping\n\n');
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
function createItemHandler(req, res) {
    const { content, title, type, language, tags, pinned, tabId } = req.body;
    if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Content cannot be empty' });
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
}

app.post('/api/items', createItemHandler);
app.post('/api/text', createItemHandler);

// 3. Update Existing Item
function updateItemHandler(req, res) {
    const id = String(req.params.id);
    const index = db.items.findIndex(i => String(i.id) === id);
    if (index === -1) {
        return res.status(404).json({ error: 'Item not found' });
    }

    const existing = db.items[index];
    const { content, title, type, language, tags, pinned } = req.body;

    if (content !== undefined) existing.content = content;
    if (title !== undefined) existing.title = title;
    if (type !== undefined) existing.type = type;
    if (language !== undefined) existing.language = language;
    if (tags !== undefined) existing.tags = tags;
    if (pinned !== undefined) existing.pinned = !!pinned;
    existing.updatedAt = new Date().toISOString();

    saveDb();
    broadcastEvent('item_updated', existing);
    res.json({ success: true, item: existing });
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
app.get('/api/file/:filename', (req, res) => {
    const filename = req.params.filename;
    const safeFilename = path.basename(filename);
    const filePath = path.join(UPLOADS_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const fileItem = db.items.find(i => i.filename === safeFilename);
    const originalName = fileItem ? fileItem.name : safeFilename;
    const mimetype = fileItem ? fileItem.mimetype : 'application/octet-stream';

    // HTTP Range requests for video/audio streaming
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunksize = (end - start) + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': mimetype
        });
        fileStream.pipe(res);
        return;
    }

    if (req.query.download === '1' || req.query.download === 'true') {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
    } else {
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(originalName)}"`);
    }

    res.setHeader('Content-Type', mimetype);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath).pipe(res);
});

// 7. Delete Item
function deleteItemHandler(req, res) {
    const id = String(req.params.id);
    const index = db.items.findIndex(i => String(i.id) === id || (i.filename && i.filename === id));

    if (index === -1) {
        return res.status(404).json({ error: 'Item not found' });
    }

    const item = db.items[index];
    if (item.filename) {
        const filePath = path.join(UPLOADS_DIR, item.filename);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) { console.warn('File unlink error:', e); }
        }
    }

    db.items.splice(index, 1);
    saveDb();

    broadcastEvent('item_deleted', { id: item.id });
    res.json({ success: true, id: item.id });
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
    if (id === 'scratchpad') {
        return res.status(400).json({ error: 'Cannot delete default scratchpad' });
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✨ RellLab Clipboard Engine v2 running on port ${PORT}`);
    console.log(`📁 Persistence active at ${DB_FILE}`);
    console.log(`📡 SSE Stream live at /api/events`);
});
