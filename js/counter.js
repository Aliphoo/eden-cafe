import { clearSkeleton, renderSkeleton } from './ui-skeleton.js';

const COUNTER_API_URL = 'https://asia-southeast1-edencafe-d9095.cloudfunctions.net/trackVisitorCounter';
const COUNTER_CLIENT_KEY = 'eden_counter_client_id';
const COUNTER_LOADING_LABEL = '0';
const COUNTER_ERROR_LABEL = '0';

function isDevMode() {
    const host = window.location.hostname;
    return host === 'localhost'
        || host === '127.0.0.1'
        || host === ''
        || window.location.search.includes('debugCounter=1');
}

function logCounterError(error) {
    if (isDevMode()) {
        console.error('[Eden visitor counter]', error);
    }
}

function getBangkokDateKey() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function storageGet(storage, key) {
    try {
        return storage.getItem(key);
    } catch (_) {
        return '';
    }
}

function storageSet(storage, key, value) {
    try {
        storage.setItem(key, value);
    } catch (_) {
        // Storage can be blocked in private mode; server-side throttling still protects the counter.
    }
}

function getOrCreateClientId() {
    const existing = storageGet(localStorage, COUNTER_CLIENT_KEY);
    if (existing) return existing;

    const generated = window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `eden-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    storageSet(localStorage, COUNTER_CLIENT_KEY, generated);
    return generated;
}

function formatCounterValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return COUNTER_ERROR_LABEL;
    return Math.floor(number).toLocaleString('en-US');
}

function setCounterText(dailyEl, totalEl, dailyText, totalText = dailyText) {
    clearSkeleton(dailyEl);
    clearSkeleton(totalEl);
    if (dailyEl) dailyEl.innerText = dailyText;
    if (totalEl) totalEl.innerText = totalText;
}

function setCounterSkeleton(dailyEl, totalEl) {
    if (dailyEl) renderSkeleton(dailyEl, 'counter');
    if (totalEl) renderSkeleton(totalEl, 'counter');
}

function updateCounterUI(dailyEl, totalEl, stats) {
    if (!stats || stats.ok !== true) {
        setCounterText(dailyEl, totalEl, COUNTER_ERROR_LABEL);
        return;
    }
    setCounterText(
        dailyEl,
        totalEl,
        formatCounterValue(stats.dailyViews),
        formatCounterValue(stats.totalViews)
    );
}

async function fetchCounterStats(shouldCountVisit) {
    const response = await fetch(COUNTER_API_URL, {
        method: shouldCountVisit ? 'POST' : 'GET',
        headers: shouldCountVisit ? { 'Content-Type': 'application/json' } : {},
        body: shouldCountVisit
            ? JSON.stringify({ count: true, visitorId: getOrCreateClientId() })
            : undefined,
        cache: 'no-store',
        credentials: 'omit'
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch (_) {
        payload = null;
    }

    if (!response.ok || !payload || payload.ok !== true) {
        const message = payload && payload.error ? payload.error : `Counter API failed (${response.status})`;
        throw new Error(message);
    }

    return payload;
}

async function trackVisit() {
    const dailyEl = document.getElementById('daily-views');
    const totalEl = document.getElementById('total-views');
    if (!dailyEl && !totalEl) return;

    const today = getBangkokDateKey();
    const localVisitKey = `eden_counter_counted_${today}`;
    const sessionVisitKey = `eden_counter_session_counted_${today}`;
    const hasLocalCount = storageGet(localStorage, localVisitKey) === 'true';
    const hasSessionCount = storageGet(sessionStorage, sessionVisitKey) === 'true';
    const shouldCountVisit = !hasLocalCount && !hasSessionCount;

    setCounterSkeleton(dailyEl, totalEl);

    try {
        const stats = await fetchCounterStats(shouldCountVisit);
        if (shouldCountVisit) {
            storageSet(localStorage, localVisitKey, 'true');
            storageSet(sessionStorage, sessionVisitKey, 'true');
        }
        updateCounterUI(dailyEl, totalEl, stats);
    } catch (error) {
        logCounterError(error);
        setCounterText(dailyEl, totalEl, COUNTER_ERROR_LABEL);
    }
}

document.addEventListener('DOMContentLoaded', trackVisit);
