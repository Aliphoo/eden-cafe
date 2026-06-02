import { db } from './firebase-config.js';
import { collection, getDocs, orderBy, query } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PAGE_LIMIT = 3;
const HUB_PREVIEW_LIMIT = 12;

const PAGE_LABELS = {
    home: 'หน้าแรก',
    menu: 'เมนู',
    shop: 'ร้านค้า',
    booking: 'ระบบจอง',
    faq: 'คำถามทั้งหมด'
};

const CATEGORY_LABELS = {
    general: 'ทั่วไป',
    home: 'หน้า Home',
    menu: 'เมนู',
    shop: 'ร้านค้า',
    booking: 'ระบบจอง',
    payment: 'การชำระเงิน',
    membership: 'สมาชิก',
    delivery: 'จัดส่ง / รับหน้าร้าน',
    parking: 'ที่จอดรถ / การเดินทาง',
    wellness: 'Wellness'
};

let faqCache = null;

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeFaq(raw = {}, id = '') {
    const legacyPublished = raw.published !== false;
    const targetPages = Array.isArray(raw.targetPages) && raw.targetPages.length
        ? raw.targetPages
        : ['home', 'faq'];
    const pinnedPages = raw.pinnedPages && typeof raw.pinnedPages === 'object' ? raw.pinnedPages : {};
    const pageOrder = raw.pageOrder && typeof raw.pageOrder === 'object' ? raw.pageOrder : {};
    const hasPopularField = Object.prototype.hasOwnProperty.call(raw, 'isPopular');

    return {
        id,
        question: String(raw.question || '').trim(),
        answer: String(raw.answer || '').trim(),
        category: String(raw.category || 'general').trim() || 'general',
        status: String(raw.status || (legacyPublished ? 'published' : 'draft')) === 'draft' ? 'draft' : 'published',
        order: safeNumber(raw.order, 0),
        targetPages,
        pinnedPages,
        pageOrder,
        isPopular: hasPopularField ? Boolean(raw.isPopular) : targetPages.includes('faq'),
        popularOrder: safeNumber(raw.popularOrder, safeNumber(raw.order, 0))
    };
}

async function fetchFaqs() {
    if (faqCache) return faqCache;
    if (!db) return [];

    const snap = await getDocs(query(collection(db, 'faqs'), orderBy('order', 'asc')));
    faqCache = snap.docs
        .map(docSnap => normalizeFaq(docSnap.data(), docSnap.id))
        .filter(faq => faq.status === 'published' && faq.question && faq.answer);
    return faqCache;
}

function getPageFaqs(faqs, pageKey, limit = PAGE_LIMIT) {
    return faqs
        .filter(faq => faq.targetPages.includes(pageKey))
        .sort((a, b) => {
            const pinnedDiff = Number(Boolean(b.pinnedPages?.[pageKey])) - Number(Boolean(a.pinnedPages?.[pageKey]));
            if (pinnedDiff) return pinnedDiff;
            const pageOrderDiff = safeNumber(a.pageOrder?.[pageKey], a.order) - safeNumber(b.pageOrder?.[pageKey], b.order);
            if (pageOrderDiff) return pageOrderDiff;
            return a.order - b.order;
        })
        .slice(0, limit);
}

function renderFaqCard(faq, options = {}) {
    const category = CATEGORY_LABELS[faq.category] || faq.category || 'ทั่วไป';
    const open = options.open ? ' open' : '';
    return `
        <article class="faq-card" data-faq-id="${escapeHTML(faq.id)}">
            <details${open}>
                <summary>
                    <span>${escapeHTML(faq.question)}</span>
                    <small>${escapeHTML(category)}</small>
                </summary>
                <p>${escapeHTML(faq.answer)}</p>
            </details>
        </article>
    `;
}

function addMoreLink(container, pageKey) {
    const wrapper = container.closest('section') || container.parentElement;
    if (!wrapper || wrapper.querySelector('[data-faq-more-link]')) return;
    const link = document.createElement('div');
    link.className = 'faq-more-link';
    link.dataset.faqMoreLink = pageKey;
    link.innerHTML = '<a class="btn faq-more-btn" href="/faq">ดูคำถามเพิ่มเติม</a>';
    wrapper.appendChild(link);
}

function renderPageSchema(pageKey, faqs) {
    if (!faqs.length) return;
    const scriptId = `eden-faq-schema-${pageKey}`;
    const oldScript = document.getElementById(scriptId);
    if (oldScript) oldScript.remove();
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = scriptId;
    script.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqs.map(faq => ({
            '@type': 'Question',
            name: faq.question,
            acceptedAnswer: {
                '@type': 'Answer',
                text: faq.answer
            }
        }))
    });
    document.head.appendChild(script);
}

async function renderPageFaqs(container) {
    const pageKey = container.dataset.faqPage || 'home';
    container.dataset.faqManaged = 'true';
    container.innerHTML = '<p class="faq-loading">กำลังโหลดคำถามที่พบบ่อย...</p>';

    try {
        const faqs = getPageFaqs(await fetchFaqs(), pageKey);
        if (!faqs.length) {
            container.innerHTML = `<p class="faq-empty">ยังไม่มีคำถามสำหรับ${escapeHTML(PAGE_LABELS[pageKey] || 'หน้านี้')}</p>`;
            return;
        }
        container.innerHTML = faqs.map((faq, index) => renderFaqCard(faq, { open: index === 0 })).join('');
        addMoreLink(container, pageKey);
        renderPageSchema(pageKey, faqs);
    } catch (error) {
        console.error('Failed to render page FAQs:', error);
        container.innerHTML = '<p class="faq-empty error">โหลดคำถามไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>';
    }
}

function groupByCategory(faqs) {
    return faqs.reduce((groups, faq) => {
        const category = faq.category || 'general';
        if (!groups[category]) groups[category] = [];
        groups[category].push(faq);
        return groups;
    }, {});
}

function renderHubList(container, faqs, expanded = false, categoryFilter = 'all', searchTerm = '') {
    const search = searchTerm.trim().toLowerCase();
    const filtered = faqs
        .filter(faq => categoryFilter === 'all' || faq.category === categoryFilter)
        .filter(faq => {
            if (!search) return true;
            return `${faq.question} ${faq.answer} ${CATEGORY_LABELS[faq.category] || faq.category}`.toLowerCase().includes(search);
        })
        .sort((a, b) => {
            const popularDiff = Number(b.isPopular) - Number(a.isPopular);
            if (popularDiff) return popularDiff;
            return safeNumber(a.popularOrder, a.order) - safeNumber(b.popularOrder, b.order);
        });
    const visible = expanded ? filtered : filtered.slice(0, HUB_PREVIEW_LIMIT);
    const groups = groupByCategory(visible);
    const body = Object.entries(groups).map(([category, items]) => `
        <section class="faq-hub-category">
            <h2>${escapeHTML(CATEGORY_LABELS[category] || category)}</h2>
            <div class="faq-hub-grid">
                ${items.map((faq, index) => renderFaqCard(faq, { open: index === 0 })).join('')}
            </div>
        </section>
    `).join('');

    const resultTarget = container.querySelector('[data-faq-hub-results]');
    const loadMore = container.querySelector('[data-faq-load-more]');
    const resultCount = container.querySelector('[data-faq-result-count]');
    const activeFilter = container.querySelector('[data-faq-active-filter]');
    if (resultTarget) {
        resultTarget.innerHTML = body || `
            <div class="faq-empty-state">
                <strong>ไม่พบคำถามที่ค้นหา</strong>
                <span>ลองเปลี่ยนคำค้นหา หรือเลือกหมวดหมู่เป็น “ทุกหมวดหมู่” อีกครั้ง</span>
            </div>
        `;
    }
    if (loadMore) {
        loadMore.hidden = expanded || filtered.length <= HUB_PREVIEW_LIMIT;
    }
    if (resultCount) {
        resultCount.textContent = `${filtered.length} คำถาม`;
    }
    if (activeFilter) {
        const categoryLabel = categoryFilter === 'all' ? 'ทุกหมวดหมู่' : (CATEGORY_LABELS[categoryFilter] || categoryFilter);
        activeFilter.textContent = search ? `ค้นหา: ${searchTerm.trim()} • ${categoryLabel}` : categoryLabel;
    }
    renderPageSchema('hub', visible.slice(0, HUB_PREVIEW_LIMIT));
}

function renderFaqHubShell(container) {
    const categories = ['all', ...Object.keys(CATEGORY_LABELS)];
    container.innerHTML = `
        <div class="faq-hub-search-card">
            <div class="faq-hub-search-copy">
                <span class="faq-hub-search-label">FAQ Concierge</span>
                <h2>ค้นหาคำตอบ</h2>
                <p>พิมพ์คำถามหรือเลือกหมวดหมู่ ระบบจะดึงคำตอบจากหลังบ้านของ Eden Cafe ให้โดยตรง</p>
            </div>
            <div class="faq-hub-toolbar" role="search">
                <label class="faq-search-field">
                    <span class="faq-field-icon" aria-hidden="true">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                            <path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Z" stroke="currentColor" stroke-width="2"/>
                            <path d="m16.2 16.2 4.3 4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </span>
                    <input type="search" data-faq-hub-search aria-label="ค้นหาคำถาม" placeholder="ค้นหาคำถาม เช่น จองโต๊ะ, ชำระเงิน, สมาชิก">
                </label>
                <label class="faq-filter-field">
                    <span>หมวดหมู่</span>
                    <select data-faq-hub-category aria-label="เลือกหมวดหมู่คำถาม">
                        ${categories.map(category => `<option value="${escapeHTML(category)}">${escapeHTML(category === 'all' ? 'ทุกหมวดหมู่' : (CATEGORY_LABELS[category] || category))}</option>`).join('')}
                    </select>
                </label>
            </div>
            <div class="faq-hub-meta">
                <span data-faq-result-count>กำลังโหลดคำถาม</span>
                <span data-faq-active-filter>ทุกหมวดหมู่</span>
            </div>
        </div>
        <div class="faq-hub-results" data-faq-hub-results>
            <p class="faq-loading faq-loading-card">กำลังโหลดศูนย์รวมคำถาม...</p>
        </div>
        <div class="faq-more-link">
            <button type="button" class="btn faq-more-btn" data-faq-load-more hidden>ดูคำถามเพิ่มเติม</button>
        </div>
    `;
}

async function renderFaqHub(container) {
    container.dataset.faqManaged = 'true';
    renderFaqHubShell(container);

    try {
        const faqs = (await fetchFaqs())
            .filter(faq => faq.targetPages.includes('faq') || faq.isPopular)
            .sort((a, b) => safeNumber(a.popularOrder, a.order) - safeNumber(b.popularOrder, b.order));
        const categories = ['all', ...Array.from(new Set(faqs.map(faq => faq.category || 'general')))];
        container.innerHTML = `
            <div class="faq-hub-search-card">
                <div class="faq-hub-search-copy">
                    <span class="faq-hub-search-label">FAQ Concierge</span>
                    <h2>ค้นหาคำตอบ</h2>
                    <p>พิมพ์คำถามหรือเลือกหมวดหมู่ ระบบจะดึงคำตอบจากหลังบ้านของ Eden Cafe ให้โดยตรง</p>
                </div>
                <div class="faq-hub-toolbar" role="search">
                    <label class="faq-search-field">
                        <span class="faq-field-icon" aria-hidden="true">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                                <path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Z" stroke="currentColor" stroke-width="2"/>
                                <path d="m16.2 16.2 4.3 4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            </svg>
                        </span>
                        <input type="search" data-faq-hub-search aria-label="ค้นหาคำถาม" placeholder="ค้นหาคำถาม เช่น จองโต๊ะ, ชำระเงิน, สมาชิก">
                    </label>
                    <label class="faq-filter-field">
                        <span>หมวดหมู่</span>
                        <select data-faq-hub-category aria-label="เลือกหมวดหมู่คำถาม">
                            ${categories.map(category => `<option value="${escapeHTML(category)}">${escapeHTML(category === 'all' ? 'ทุกหมวดหมู่' : (CATEGORY_LABELS[category] || category))}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <div class="faq-hub-meta">
                    <span data-faq-result-count>0 คำถาม</span>
                    <span data-faq-active-filter>ทุกหมวดหมู่</span>
                </div>
            </div>
            <div class="faq-hub-results" data-faq-hub-results></div>
            <div class="faq-more-link">
                <button type="button" class="btn faq-more-btn" data-faq-load-more>ดูคำถามเพิ่มเติม</button>
            </div>
        `;

        let expanded = false;
        const search = container.querySelector('[data-faq-hub-search]');
        const category = container.querySelector('[data-faq-hub-category]');
        const loadMore = container.querySelector('[data-faq-load-more]');
        const refresh = () => renderHubList(container, faqs, expanded, category?.value || 'all', search?.value || '');

        search?.addEventListener('input', refresh);
        category?.addEventListener('change', refresh);
        loadMore?.addEventListener('click', () => {
            expanded = true;
            refresh();
        });
        refresh();
    } catch (error) {
        console.error('Failed to render FAQ hub:', error);
        container.innerHTML = '<p class="faq-empty error">โหลดคำถามไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>';
    }
}

async function initFaq() {
    const pageContainers = Array.from(document.querySelectorAll('[data-faq-page]'));
    const hubContainers = Array.from(document.querySelectorAll('[data-faq-hub]'));
    await Promise.all([
        ...pageContainers.map(renderPageFaqs),
        ...hubContainers.map(renderFaqHub)
    ]);
}

window.EdenFAQ = {
    refresh: () => {
        faqCache = null;
        return initFaq();
    }
};

document.addEventListener('DOMContentLoaded', initFaq);
