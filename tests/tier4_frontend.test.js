const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./test_helpers');

describe('Tier 4: Frontend HTML/DOM Inspection & Ergonomics', () => {
    const indexPath = path.join(PROJECT_ROOT, 'index.html');
    assert.ok(fs.existsSync(indexPath), `index.html must exist at ${indexPath}`);
    const html = fs.readFileSync(indexPath, 'utf8');

    it('Viewport meta tag must not disable zoom (maximum-scale=1.0 and user-scalable=no must be eliminated)', () => {
        const viewportMatch = html.match(/<meta[^>]*name=["']viewport["'][^>]*>/i);
        assert.ok(viewportMatch, 'index.html must contain a viewport meta tag');
        const viewportTag = viewportMatch[0];

        const hasMaxScale = /maximum-scale\s*=\s*1(\.0)?/i.test(viewportTag);
        const hasUserScalableNo = /user-scalable\s*=\s*(no|0)/i.test(viewportTag);

        assert.strictEqual(
            hasMaxScale,
            false,
            `Viewport meta tag disables zoom with maximum-scale=1.0: "${viewportTag}". WCAG accessibility requires user zoom.`
        );
        assert.strictEqual(
            hasUserScalableNo,
            false,
            `Viewport meta tag disables zoom with user-scalable=no: "${viewportTag}". WCAG accessibility requires user zoom.`
        );
    });

    it('Fallback clipboard implementation exists and handles clipboard API unavailability', () => {
        // 1. execCommand copy fallback must be defined
        const hasExecCommand = html.includes("execCommand('copy')") || html.includes('execCommand("copy")');
        assert.strictEqual(
            hasExecCommand,
            true,
            "Expected fallback clipboard function using document.execCommand('copy') when navigator.clipboard is unavailable"
        );

        // 2. Must be wired to catch block or conditional check
        const hasFallbackInvocation = /fallbackCopy|\.catch\([^)]*copy/i.test(html);
        assert.strictEqual(
            hasFallbackInvocation,
            true,
            'Expected clipboard action to invoke fallbackCopy on failure or rejection'
        );

        // 3. copyText checks isSecureContext or navigator.clipboard before calling writeText
        const checksSecureOrClipboard = /isSecureContext.*navigator\.clipboard|navigator\.clipboard.*isSecureContext/s.test(html);
        assert.strictEqual(
            checksSecureOrClipboard,
            true,
            'Expected copyText to check isSecureContext or navigator.clipboard before calling writeText'
        );
    });

    it('SSE reconnect state handling and reconnecting visual indicator must be implemented', () => {
        // Check for EventSource error handler and reconnect indicator
        const hasSseOnError = /sseSource\.onerror|\.addEventListener\(\s*['"]error['"]/i.test(html);
        const hasReconnectUi = /reconnect|connection-status|badge-reconnecting|is-reconnecting/i.test(html);

        assert.strictEqual(
            hasSseOnError,
            true,
            'Expected EventSource onerror or error event listener to detect SSE stream disconnections'
        );
        assert.strictEqual(
            hasReconnectUi,
            true,
            'Expected reconnect state handling with a visible reconnecting indicator in frontend UI'
        );
    });

    it('CSS mobile styles at 375px: prevents overflow and hides tabs header bar in clips mode', () => {
        // 1. Mobile media query for <= 768px, <= 600px, or 375px phone viewports
        const hasMobileMediaQuery = /@media[^{]*(max-width:\s*(375|400|480|600|768)px)/i.test(html);
        assert.strictEqual(
            hasMobileMediaQuery,
            true,
            'Expected CSS media queries catering to mobile screen widths (375px to 768px)'
        );

        // 2. Body or app layout prevents horizontal scroll / overflow
        const hasOverflowProtection = /overflow(-x)?:\s*hidden/i.test(html);
        assert.strictEqual(
            hasOverflowProtection,
            true,
            'Expected overflow protection to prevent horizontal blowout on mobile viewports'
        );

        // 3. Tabs header bar must be specifically hidden when clips mode is active
        const hidesTabsInClipsMode = 
            /(view-clips[^{}]*(\.tabs-header-bar|#tabsHeaderBar)|(\.tabs-header-bar|#tabsHeaderBar)[^{}]*view-clips)[^{}]*\{[^}]*display:\s*none/i.test(html) ||
            /view-clips\s*~[^{}]*(\.tabs-header-bar|#tabsHeaderBar)[^{}]*\{[^}]*display:\s*none/i.test(html) ||
            /body\.view-clips\s*(\.tabs-header-bar|#tabsHeaderBar)[^{}]*\{[^}]*display:\s*none/i.test(html) ||
            /\.app-layout\.view-clips\s*(\.tabs-header-bar|#tabsHeaderBar)[^{}]*\{[^}]*display:\s*none/i.test(html);

        assert.strictEqual(
            hidesTabsInClipsMode,
            true,
            'Expected CSS rule hiding .tabs-header-bar / #tabsHeaderBar when in clips mode (.view-clips) on mobile'
        );
    });
});
