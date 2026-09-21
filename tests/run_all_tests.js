#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');
const { startTestServer } = require('./test_helpers');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

const TIERS = [
    { tier: 1, name: 'Core API Contracts & Endpoints', file: 'tier1_api.test.js' },
    { tier: 2, name: 'Boundary, Security & Error Conditions', file: 'tier2_security.test.js' },
    { tier: 3, name: 'Concurrency, Persistence & SSE Synchronization', file: 'tier3_persistence_sse.test.js' },
    { tier: 4, name: 'Frontend HTML/DOM Inspection & Ergonomics', file: 'tier4_frontend.test.js' }
];

async function isServerHealthy(url) {
    try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200) });
        if (res.ok) {
            const data = await res.json();
            return data && data.status === 'healthy';
        }
    } catch {}
    return false;
}

async function runTestFile(testFile, env) {
    return new Promise((resolve) => {
        const fullPath = path.join(__dirname, testFile);
        const child = spawn(process.execPath, ['--test', fullPath], {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        child.on('close', (code) => {
            resolve({
                code,
                stdout,
                stderr
            });
        });
    });
}

function parseTapOutput(output) {
    // Only parse the main execution section before "✖ failing tests:"
    const mainSection = output.split(/✖ failing tests:/)[0];
    const results = [];

    for (const line of mainSection.split('\n')) {
        const passMatch = line.match(/^\s*✔\s*(.*?)\s*\(([0-9.]+ms)\)/);
        if (passMatch) {
            const name = passMatch[1].trim();
            // Skip test suite headers
            if (!name.startsWith('Tier ')) {
                results.push({
                    name,
                    passed: true,
                    duration: passMatch[2],
                    error: null
                });
            }
            continue;
        }

        const failMatch = line.match(/^\s*✖\s*(.*?)\s*\(([0-9.]+ms)\)/);
        if (failMatch) {
            const name = failMatch[1].trim();
            // Skip test suite headers
            if (!name.startsWith('Tier ')) {
                results.push({
                    name,
                    passed: false,
                    duration: failMatch[2],
                    error: null
                });
            }
            continue;
        }
    }

    return results;
}

async function main() {
    const args = process.argv.slice(2);
    let targetUrl = process.env.TEST_BASE_URL || null;
    let selectedTier = null;

    for (const arg of args) {
        if (arg.startsWith('--target=')) {
            targetUrl = arg.replace('--target=', '').trim();
        } else if (arg.startsWith('--tier=')) {
            selectedTier = parseInt(arg.replace('--tier=', '').trim(), 10);
        } else if (arg.startsWith('http://') || arg.startsWith('https://')) {
            targetUrl = arg.trim();
        }
    }

    console.log(`${BOLD}${CYAN}======================================================${RESET}`);
    console.log(`${BOLD}${CYAN}   RellLab Shared Clipboard — E2E Test Suite Runner   ${RESET}`);
    console.log(`${BOLD}${CYAN}======================================================${RESET}\n`);

    let ephemeralServer = null;
    let testDataDir = process.env.TEST_DATA_DIR || null;

    if (!targetUrl) {
        // Auto-detect running local server
        if (await isServerHealthy('http://localhost:8084')) {
            targetUrl = 'http://localhost:8084';
            console.log(`[Auto-detect] Detected healthy server at ${GREEN}${targetUrl}${RESET}`);
        } else if (await isServerHealthy('http://localhost:3000')) {
            targetUrl = 'http://localhost:3000';
            console.log(`[Auto-detect] Detected healthy server at ${GREEN}${targetUrl}${RESET}`);
        } else {
            console.log(`[Auto-detect] No active local server found. Starting isolated test server instance...`);
            ephemeralServer = await startTestServer();
            targetUrl = ephemeralServer.baseUrl;
            testDataDir = ephemeralServer.tempDir;
            console.log(`[Test Server] Running isolated server on ${GREEN}${targetUrl}${RESET} (PID: ${ephemeralServer.pid})`);
        }
    } else {
        console.log(`[Target] Testing against explicit target: ${GREEN}${targetUrl}${RESET}`);
    }

    const tiersToRun = selectedTier 
        ? TIERS.filter(t => t.tier === selectedTier)
        : TIERS;

    const summary = {
        total: 0,
        passed: 0,
        failed: 0,
        tierStats: {}
    };

    try {
        for (const tierConfig of tiersToRun) {
            console.log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
            console.log(`${BOLD} Tier ${tierConfig.tier}: ${tierConfig.name}${RESET}`);
            console.log(`${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);

            const env = { TEST_BASE_URL: targetUrl };
            if (testDataDir) env.TEST_DATA_DIR = testDataDir;

            const runResult = await runTestFile(tierConfig.file, env);
            const testResults = parseTapOutput(runResult.stdout);

            let tierPassed = 0;
            let tierFailed = 0;

            for (const t of testResults) {
                summary.total++;
                if (t.passed) {
                    summary.passed++;
                    tierPassed++;
                    console.log(`  ${GREEN}✔ [PASS]${RESET} ${t.name} ${GRAY}(${t.duration})${RESET}`);
                } else {
                    summary.failed++;
                    tierFailed++;
                    console.log(`  ${RED}✖ [FAIL]${RESET} ${t.name} ${GRAY}(${t.duration})${RESET}`);
                }
            }

            // In case node:test failed with syntax or before hook failure without matching tests
            if (testResults.length === 0 && runResult.code !== 0) {
                summary.total++;
                summary.failed++;
                tierFailed++;
                console.log(`  ${RED}✖ [FAIL]${RESET} Suite execution error: ${runResult.stderr || runResult.stdout}`);
            }

            summary.tierStats[tierConfig.tier] = {
                name: tierConfig.name,
                total: tierPassed + tierFailed,
                passed: tierPassed,
                failed: tierFailed
            };
        }
    } finally {
        if (ephemeralServer) {
            await ephemeralServer.cleanup();
            console.log(`\n${GRAY}[Test Server] Isolated test server shut down cleanly.${RESET}`);
        }
    }

    console.log(`\n${BOLD}======================================================${RESET}`);
    console.log(`${BOLD}                   SUMMARY REPORT                    ${RESET}`);
    console.log(`${BOLD}======================================================${RESET}`);
    
    for (const [tierNum, stat] of Object.entries(summary.tierStats)) {
        const color = stat.failed === 0 ? GREEN : RED;
        console.log(` Tier ${tierNum}: ${stat.name.padEnd(46)} ${color}${stat.passed}/${stat.total} PASS${RESET}`);
    }

    console.log(`${BOLD}------------------------------------------------------${RESET}`);
    console.log(` Total Tests : ${summary.total}`);
    console.log(` Passed      : ${GREEN}${summary.passed}${RESET}`);
    console.log(` Failed      : ${summary.failed > 0 ? RED : GREEN}${summary.failed}${RESET}`);
    console.log(`${BOLD}======================================================${RESET}\n`);

    if (summary.failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

main().catch((err) => {
    console.error(`Runner fatal error:`, err);
    process.exit(1);
});
