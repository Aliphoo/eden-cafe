#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const value = inlineValue ?? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
    args.set(rawKey, value);
}

const baseUrl = String(args.get('base-url') || args.get('base') || 'http://127.0.0.1:4173').replace(/\/$/, '');
const storageState = args.get('storage-state');
const timeoutMs = Number(args.get('timeout-ms') || 25000);
const url = `${baseUrl}/admin#orders`;

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch (error) {
    console.error('Missing dependency: playwright. Install it in the test environment before running this smoke test.');
    console.error('Example: npm i -D playwright && npx playwright install chromium');
    process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext(storageState ? { storageState } : {});
const page = await context.newPage();
const consoleProblems = [];

page.on('console', message => {
    if (message.type() === 'error') consoleProblems.push(message.text());
});
page.on('pageerror', error => {
    consoleProblems.push(error?.stack || error?.message || String(error));
});

try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('#orders', { timeout: timeoutMs });

    const deadline = Date.now() + timeoutMs;
    let state = null;
    while (Date.now() < deadline) {
        state = await page.evaluate(() => {
            const text = document.body?.innerText || '';
            const status = document.getElementById('orders-load-status')?.textContent?.trim() || '';
            return {
                status,
                loadedText: (text.match(/Loaded \d+ orders/) || [null])[0],
                loadingVisible: text.includes('Loading orders'),
                errorVisible: text.includes('Orders failed') || text.includes('could not render'),
                skeletonCount: document.querySelectorAll('.skeleton, [class*="skeleton"], .shimmer, [class*="shimmer"]').length,
                orderRows: document.querySelectorAll('#orders-table-body tr').length,
                loginVisible: text.includes('Sign in with Google')
            };
        });
        if (state.errorVisible || state.loadedText || !state.loginVisible) break;
        await delay(250);
    }

    if (consoleProblems.length) {
        throw new Error(`Console/page errors found:\n${consoleProblems.join('\n')}`);
    }
    if (!state) throw new Error('Unable to read Orders state.');
    if (state.loginVisible && !storageState) {
        throw new Error('Admin login is required. Re-run with --storage-state pointing to an authenticated Playwright storage state file.');
    }
    if (state.errorVisible) throw new Error(`Orders rendered an error state: ${state.status}`);
    if (state.loadedText && (state.loadingVisible || state.skeletonCount > 0)) {
        throw new Error(`Orders loaded but UI is still loading. status="${state.status}" skeletonCount=${state.skeletonCount}`);
    }

    console.log(JSON.stringify({ ok: true, url, state }, null, 2));
} finally {
    await browser.close();
}
