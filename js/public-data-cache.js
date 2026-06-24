const CACHE_PREFIX = 'eden-public-cache:';
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function storageArea() {
    try {
        return window.sessionStorage || null;
    } catch (_) {
        return null;
    }
}

function fullKey(key) {
    return key.startsWith(CACHE_PREFIX) ? key : CACHE_PREFIX + key;
}

function readCache(key, ttlMs) {
    const storage = storageArea();
    if (!storage) return null;

    try {
        const raw = storage.getItem(fullKey(key));
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (!cached || typeof cached !== 'object') return null;
        if (Date.now() - Number(cached.savedAt || 0) > ttlMs) {
            storage.removeItem(fullKey(key));
            return null;
        }
        return cached.value ?? null;
    } catch (_) {
        return null;
    }
}

function writeCache(key, value) {
    const storage = storageArea();
    if (!storage) return;

    try {
        storage.setItem(fullKey(key), JSON.stringify({
            savedAt: Date.now(),
            value
        }));
    } catch (_) {
        // Cache is best-effort only. Public pages should still render if storage is full.
    }
}

export async function cachedPublicJSON(key, loader, options = {}) {
    const ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
    const cached = readCache(key, ttlMs);
    if (cached !== null) return cached;

    const value = await loader();
    writeCache(key, value);
    return value;
}

export function clearPublicCache(prefix = '') {
    const storage = storageArea();
    if (!storage) return;

    const targetPrefix = fullKey(prefix);
    try {
        Object.keys(storage)
            .filter(key => key.startsWith(targetPrefix))
            .forEach(key => storage.removeItem(key));
    } catch (_) {
        // Ignore storage cleanup failures.
    }
}

export function snapshotRows(snapshot) {
    return snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}
