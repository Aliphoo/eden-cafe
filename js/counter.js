import { db } from './firebase-config.js';
import { doc, getDoc, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COUNTER_DOC = doc(db, 'stats', 'pageViews');
const EMPTY_COUNTER_LABEL = '...';

function getBangkokDateKey() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function normalizeStats(data = {}, today) {
    const totalViews = Math.max(0, Math.floor(Number(data.totalViews) || 0));
    const dailyViews = Math.max(0, Math.floor(Number(data.dailyViews) || 0));
    const lastUpdateDate = typeof data.lastUpdateDate === 'string' ? data.lastUpdateDate : today;
    return { totalViews, dailyViews, lastUpdateDate };
}

function formatCounterValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return EMPTY_COUNTER_LABEL;
    return Math.floor(number).toLocaleString('en-US');
}

function updateCounterUI(dailyEl, totalEl, stats) {
    if (!stats) {
        if (dailyEl) dailyEl.innerText = EMPTY_COUNTER_LABEL;
        if (totalEl) totalEl.innerText = EMPTY_COUNTER_LABEL;
        return;
    }
    if (dailyEl) dailyEl.innerText = formatCounterValue(stats.dailyViews);
    if (totalEl) totalEl.innerText = formatCounterValue(stats.totalViews);
}

async function readCounter(today) {
    const snapshot = await getDoc(COUNTER_DOC);
    if (!snapshot.exists()) return null;
    const stats = normalizeStats(snapshot.data(), today);
    if (stats.lastUpdateDate !== today) stats.dailyViews = 0;
    return stats;
}

async function trackVisit() {
    const dailyEl = document.getElementById('daily-views');
    const totalEl = document.getElementById('total-views');
    if (!dailyEl && !totalEl) return;

    const today = getBangkokDateKey();
    const visitKey = `eden_counter_visited_${today}`;
    const shouldCountVisit = sessionStorage.getItem(visitKey) !== 'true';

    updateCounterUI(dailyEl, totalEl, null);

    try {
        if (!shouldCountVisit) {
            updateCounterUI(dailyEl, totalEl, await readCounter(today));
            return;
        }

        const nextStats = await runTransaction(db, async transaction => {
            const snapshot = await transaction.get(COUNTER_DOC);
            if (!snapshot.exists()) {
                const firstStats = { totalViews: 1, dailyViews: 1, lastUpdateDate: today };
                transaction.set(COUNTER_DOC, firstStats);
                return firstStats;
            }

            const current = normalizeStats(snapshot.data(), today);
            const next = {
                totalViews: current.totalViews + 1,
                dailyViews: current.lastUpdateDate === today ? current.dailyViews + 1 : 1,
                lastUpdateDate: today
            };
            transaction.set(COUNTER_DOC, next);
            return next;
        });

        sessionStorage.setItem(visitKey, 'true');
        updateCounterUI(dailyEl, totalEl, nextStats);
    } catch (e) {
        try {
            updateCounterUI(dailyEl, totalEl, await readCounter(today));
        } catch (_) {
            updateCounterUI(dailyEl, totalEl, null);
        }
    }
}

document.addEventListener('DOMContentLoaded', trackVisit);
