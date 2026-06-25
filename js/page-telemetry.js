const TELEMETRY_ENDPOINT = 'https://asia-southeast1-edencafe-d9095.cloudfunctions.net/reportPageTelemetry';
const WATCHDOG_MS = 15000;
const SLOW_READY_MS = 8000;
const MAX_FIELD = 220;

const startedAt = performance.now();
let watchdogSent = false;
let slowReadySent = false;

function cleanText(value, max = MAX_FIELD) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function pagePath() {
    return window.location.pathname || '/';
}

function currentAdminTab() {
    return document.querySelector('.content-section.active')?.id || '';
}

function pendingSignals() {
    const busy = Array.from(document.querySelectorAll('[aria-busy="true"], [data-eden-skeleton]'));
    const htmlClasses = Array.from(document.documentElement.classList)
        .filter(name => /pending|loading|skeleton/i.test(name))
        .slice(0, 8);

    return {
        busyCount: busy.length,
        busyTargets: busy.slice(0, 8).map(el => cleanText([
            el.id ? `#${el.id}` : '',
            el.dataset.edenSkeleton ? `[${el.dataset.edenSkeleton}]` : '',
            el.className ? `.${String(el.className).split(/\s+/).filter(Boolean).slice(0, 3).join('.')}` : ''
        ].filter(Boolean).join(''))),
        htmlClasses,
        adminTab: currentAdminTab()
    };
}

function basePayload(type, details = {}) {
    return {
        type,
        path: pagePath(),
        title: cleanText(document.title, 120),
        durationMs: Math.round(performance.now() - startedAt),
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        viewport: {
            width: Math.round(window.innerWidth || 0),
            height: Math.round(window.innerHeight || 0)
        },
        signals: pendingSignals(),
        details
    };
}

function sendTelemetry(type, details = {}) {
    const payload = basePayload(type, details);
    const body = JSON.stringify(payload);

    try {
        if (navigator.sendBeacon) {
            const blob = new Blob([body], { type: 'application/json' });
            if (navigator.sendBeacon(TELEMETRY_ENDPOINT, blob)) return;
        }
    } catch (_) {
    }

    try {
        fetch(TELEMETRY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
            credentials: 'omit'
        }).catch(() => {});
    } catch (_) {
    }
}

function maybeReportSlowReady(label = 'load') {
    if (slowReadySent) return;
    const durationMs = performance.now() - startedAt;
    if (durationMs < SLOW_READY_MS) return;
    slowReadySent = true;
    sendTelemetry('slow_ready', { label: cleanText(label, 80) });
}

function maybeReportHang() {
    if (watchdogSent) return;
    const signals = pendingSignals();
    const hasPendingSignals = signals.busyCount > 0 || signals.htmlClasses.length > 0;
    if (document.readyState === 'complete' && !hasPendingSignals) return;
    watchdogSent = true;
    sendTelemetry('page_watchdog_15s', { watchdogMs: WATCHDOG_MS });
}

window.EdenTelemetry = {
    ...(window.EdenTelemetry || {}),
    markReady(label = 'manual') {
        maybeReportSlowReady(label);
    },
    report(type, details = {}) {
        sendTelemetry(cleanText(type, 80) || 'custom', details);
    },
    pendingSignals
};

window.addEventListener('load', () => {
    window.setTimeout(() => maybeReportSlowReady('window-load'), 0);
}, { once: true });

window.addEventListener('error', event => {
    sendTelemetry('js_error', {
        message: cleanText(event.message, 180),
        source: cleanText(event.filename, 180),
        line: event.lineno || 0,
        column: event.colno || 0
    });
});

window.addEventListener('unhandledrejection', event => {
    const reason = event.reason || {};
    sendTelemetry('unhandled_rejection', {
        message: cleanText(reason.message || reason, 180)
    });
});

window.setTimeout(maybeReportHang, WATCHDOG_MS);
