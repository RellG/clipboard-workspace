// Isolated browser regression: routes every request to synthetic fixtures; no server is started.
// Supply PLAYWRIGHT_MODULE_PATH and CHROMIUM_EXECUTABLE_PATH when browser tooling is external.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
let browser;
before(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
});
after(async () => { if (browser) await browser.close(); });

for (const size of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'laptop', width: 1024, height: 600 },
    { name: 'tablet', width: 768, height: 1024, touch: true },
    { name: 'phone', width: 390, height: 844, touch: true },
    { name: 'small phone', width: 375, height: 667, touch: true },
    { name: 'landscape phone', width: 844, height: 390, touch: true }
]) test('Notes scroll and preserve position on ' + size.name, { timeout: 30000 }, async () => {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.touch, hasTouch: !!size.touch });
    try {
        const page = await context.newPage(), writes = [], errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
        const tabs = Array.from({ length: 120 }, (_, i) => ({ id: 'note-' + i, name: 'Synthetic note ' + i, content: i === 0 ? Array.from({ length: 500 }, (_, line) => 'Long note line ' + line).join('\n') : 'Synthetic preview text for scrolling.', mode: 'text', _revision: 'synthetic-' + i, updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, 120 - i)).toISOString() }));
        await page.route('**/*', async route => {
            const req = route.request(), url = new URL(req.url());
            assert.equal(url.origin, 'http://clipboard.test', 'No request may leave the synthetic test origin');
            if (req.method() !== 'GET') { writes.push(req.method() + ' ' + url.pathname); return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Unexpected write in scroll test"}' }); }
            if (url.pathname === '/api/workspace') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tabs, items: [], trashRetentionDays: 30 }) });
            const files = { '/': ['index.html', 'text/html'], '/assets/workspace.css': [process.env.CLIPBOARD_CSS_PATH || 'assets/workspace.css', 'text/css'], '/assets/workspace-core.js': ['assets/workspace-core.js', 'text/javascript'], '/assets/workspace.js': ['assets/workspace.js', 'text/javascript'] };
            const file = files[url.pathname];
            if (!file) return route.fulfill({ status: 404, body: '' });
            return route.fulfill({ contentType: file[1], body: fs.readFileSync(path.resolve(root, file[0]), 'utf8') });
        });
        await page.goto('http://clipboard.test/');
        await page.waitForSelector('.entry-open');
        const list = page.locator('#entryList');
        const metrics = await list.evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight, bottom: el.getBoundingClientRect().bottom, viewport: innerHeight, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
        assert.ok(metrics.height > 0 && metrics.height < metrics.viewport, 'List must be bounded inside viewport: ' + JSON.stringify(metrics));
        assert.ok(metrics.content > metrics.height, 'Synthetic notes must overflow the list');
        assert.ok(metrics.bottom <= metrics.viewport + 1, 'List bottom must remain on screen');
        assert.ok(metrics.pageWidth <= metrics.viewportWidth + 1, 'No horizontal page overflow');
        const bounds = await list.boundingBox();
        if (size.touch) {
            const cdp = await context.newCDPSession(page), x = bounds.x + bounds.width / 2;
            const start = bounds.y + bounds.height - 40, end = bounds.y + 45;
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
            for (let step = 1; step <= 8; step++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * step / 8 }] });
                await page.waitForTimeout(20);
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            await page.mouse.wheel(0, 700);
        }
        await page.waitForFunction(() => document.getElementById('entryList').scrollTop > 20);
        // Bottom notes are reachable, then return to a middle position for the navigation check.
        const end = await list.evaluate(el => { el.scrollTop = el.scrollHeight; return { top: el.scrollTop, maximum: el.scrollHeight - el.clientHeight }; });
        assert.ok(Math.abs(end.top - end.maximum) <= 1, 'Must reach the end of the notes list');
        await list.evaluate(el => { el.scrollTop = 900; });
        await page.waitForTimeout(50);
        const before = await list.evaluate(el => el.scrollTop);
        const key = await list.evaluate(el => {
            const bounds = el.getBoundingClientRect();
            return [...el.querySelectorAll('.entry-open')].find(row => { const r = row.getBoundingClientRect(); return r.top > bounds.top + 20 && r.bottom < bounds.bottom - 10; }).dataset.open;
        });
        await page.locator('[data-open="' + key + '"]').click();
        // Background sync while mobile hides the list must not overwrite its remembered position.
        await page.evaluate(async () => { renderList(); await refresh(); });
        if (size.width <= 600) await page.locator('#backButton').click();
        assert.ok(Math.abs((await list.evaluate(el => el.scrollTop)) - before) <= 1, 'Returning to notes must preserve scroll position');
        // An unchanged refresh should preserve row identity and native touch momentum.
        assert.equal(await page.evaluate(() => { const row = document.querySelector('.entry-open'); renderList(); return row === document.querySelector('.entry-open'); }), true);
        await page.evaluate(() => openEntry('tabs:note-0'));
        const textarea = page.locator('#editorTextarea');
        const editorScroll = await textarea.evaluate(el => { el.scrollTop = 1000; return { top: el.scrollTop, height: el.clientHeight, content: el.scrollHeight }; });
        assert.ok(editorScroll.top > 0 && editorScroll.content > editorScroll.height, 'Long note content must scroll independently');
        await page.evaluate(() => action('preview'));
        const previewTop = await page.locator('#markdownPreviewPane').evaluate(el => { el.scrollTop = 1000; return el.scrollTop; });
        assert.ok(previewTop > 0, 'Long reading previews must scroll');
        await page.evaluate(() => action('minimize'));
        if (size.width <= 600) assert.equal(await list.isVisible(), true);
        if (size.width <= 600) {
            // Simulate the reduced layout viewport used when a mobile keyboard occupies space.
            await page.setViewportSize({ width: size.width, height: 360 });
            const reduced = await list.evaluate(el => ({ height: el.clientHeight, bottom: el.getBoundingClientRect().bottom, viewport: innerHeight }));
            assert.ok(reduced.height > 0 && reduced.bottom <= reduced.viewport + 1, 'Notes must remain scrollable in a reduced mobile viewport');
        }
        assert.deepEqual(writes, [], 'Scrolling, reading and minimizing never write or delete records');
        assert.deepEqual(errors, [], 'No browser runtime errors');
    } finally { await context.close(); }
});
