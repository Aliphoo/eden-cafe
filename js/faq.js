import { db } from './firebase-config.js';
import { clearSkeleton, renderSkeleton } from './ui-skeleton.js';
import { cachedPublicJSON, clearPublicCache, snapshotRows } from './public-data-cache.js';
import { collection, getDocs, limit, orderBy, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PAGE_LIMIT = 3;
const HUB_PREVIEW_LIMIT = 12;
const FAQ_PAGE_QUERY_LIMIT = 80;
const FAQ_HUB_QUERY_LIMIT = 80;
const PUBLIC_CACHE_TTL_MS = 5 * 60 * 1000;

const PAGE_LABELS = {
    home: 'หน้าแรก',
    menu: 'เมนู',
    shop: 'ร้านค้า',
    booking: 'ระบบจอง',
    faq: 'คำถามทั้งหมด'
};

const FALLBACK_FAQS = [
    {
        id: 'fallback-home-location',
        question: 'Eden Cafe อยู่ที่ไหน?',
        answer: 'Eden Cafe ตั้งอยู่ที่ 306 หมู่ 7 ตำบลนางแล อำเภอเมืองเชียงราย จังหวัดเชียงราย 57100',
        category: 'home',
        targetPages: ['home', 'faq'],
        pinnedPages: { home: true },
        isPopular: true,
        order: 1,
        popularOrder: 1
    },
    {
        id: 'fallback-home-contact',
        question: 'ติดต่อ Eden Cafe ได้ทางไหน?',
        answer: 'ติดต่อร้านได้ทางอีเมล edencafe.2565@gmail.com หรือโทร 098-008-0383',
        category: 'home',
        targetPages: ['home', 'faq'],
        isPopular: true,
        order: 2,
        popularOrder: 2
    },
    {
        id: 'fallback-booking-table',
        question: 'จองโต๊ะต้องทำอย่างไร?',
        answer: 'ไปที่หน้าระบบจอง เลือกวัน เวลา จำนวนคน และเลือกโต๊ะหรือโซนที่ต้องการ จากนั้นกรอกข้อมูลติดต่อเพื่อยืนยันการจอง',
        category: 'booking',
        targetPages: ['booking', 'faq'],
        pinnedPages: { booking: true },
        isPopular: true,
        order: 3,
        popularOrder: 3
    },
    {
        id: 'fallback-booking-change',
        question: 'ถ้าต้องการแก้ไขหรือยกเลิกการจองต้องทำอย่างไร?',
        answer: 'กรุณาติดต่อร้านโดยตรงพร้อมชื่อ เบอร์โทร วันที่ และเวลาที่จอง เพื่อให้ทีมงานตรวจสอบและช่วยแก้ไขให้',
        category: 'booking',
        targetPages: ['booking', 'faq'],
        isPopular: true,
        order: 4,
        popularOrder: 4
    },
    {
        id: 'fallback-menu-options',
        question: 'เมนูมีตัวเลือก เช่น หวาน ร้อน เย็น หรือเปลี่ยนนมไหม?',
        answer: 'บางเมนูมีตัวเลือกเพิ่มเติมตามที่ร้านเปิดไว้ เช่น ระดับความหวาน อุณหภูมิ ชนิดนม หรือ modifier อื่นๆ',
        category: 'menu',
        targetPages: ['menu', 'faq'],
        pinnedPages: { menu: true },
        isPopular: true,
        order: 5,
        popularOrder: 5
    },
    {
        id: 'fallback-menu-allergy',
        question: 'ถ้ามีแพ้อาหารควรแจ้งอย่างไร?',
        answer: 'กรุณาระบุข้อมูลแพ้อาหารหรือหมายเหตุสุขภาพตอนจองหรือสั่งซื้อ เพื่อให้ทีมงานใช้ประกอบการให้บริการอย่างปลอดภัย',
        category: 'menu',
        targetPages: ['menu', 'booking', 'faq'],
        isPopular: true,
        order: 6,
        popularOrder: 6
    },
    {
        id: 'fallback-shop-order',
        question: 'สั่งสินค้าออนไลน์ได้อย่างไร?',
        answer: 'ไปที่หน้าร้านค้า เลือกสินค้าที่ต้องการ เพิ่มลงตะกร้า และดำเนินการชำระเงินในหน้า Checkout',
        category: 'shop',
        targetPages: ['shop', 'faq'],
        pinnedPages: { shop: true },
        isPopular: true,
        order: 7,
        popularOrder: 7
    },
    {
        id: 'fallback-shop-delivery',
        question: 'รับสินค้าหน้าร้านหรือจัดส่งได้ไหม?',
        answer: 'ตัวเลือกการรับสินค้าขึ้นอยู่กับรายการสินค้าและเงื่อนไขร้าน โปรดตรวจสอบในหน้า Checkout ก่อนยืนยันคำสั่งซื้อ',
        category: 'delivery',
        targetPages: ['shop', 'faq'],
        isPopular: true,
        order: 8,
        popularOrder: 8
    },
    {
        id: 'fallback-payment',
        question: 'รองรับช่องทางชำระเงินอะไรบ้าง?',
        answer: 'ระบบรองรับช่องทางที่ร้านเปิดใช้งานในช่วงนั้น เช่น โอนเงิน QR Payment หรือช่องทางอื่นตามที่แสดงในหน้า Checkout',
        category: 'payment',
        targetPages: ['shop', 'booking', 'faq'],
        isPopular: true,
        order: 9,
        popularOrder: 9
    },
    {
        id: 'fallback-member',
        question: 'สมาชิก Eden Cafe ใช้ทำอะไรได้บ้าง?',
        answer: 'สมาชิกสามารถดูข้อมูลโปรไฟล์ ประวัติคำสั่งซื้อ ประวัติการจอง คะแนนสะสม และระดับสมาชิกตามเงื่อนไขที่ร้านกำหนด',
        category: 'membership',
        targetPages: ['home', 'faq'],
        isPopular: true,
        order: 10,
        popularOrder: 10
    },
    {
        id: 'fallback-points',
        question: 'คะแนนสะสมคำนวณอย่างไร?',
        answer: 'คะแนนสะสมและสิทธิประโยชน์จะคำนวณตามกติกาสมาชิกที่ร้านเปิดใช้งาน และอาจเปลี่ยนได้ตามเงื่อนไขของ Eden Cafe',
        category: 'membership',
        targetPages: ['faq'],
        isPopular: true,
        order: 11,
        popularOrder: 11
    },
    {
        id: 'fallback-faq-updates',
        question: 'ข้อมูล FAQ อัปเดตจากที่ไหน?',
        answer: 'คำถามที่พบบ่อยถูกจัดการจากหลังบ้าน Eden Admin และหน้านี้มีข้อมูลสำรองพื้นฐานในกรณีระบบออนไลน์โหลดไม่ได้',
        category: 'general',
        targetPages: ['faq'],
        isPopular: true,
        order: 12,
        popularOrder: 12
    }
];

const faqCache = new Map();

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

function normalizeFaqRows(rows = []) {
    return rows
        .map(row => normalizeFaq(row, row.id))
        .filter(faq => faq.status === 'published' && faq.question && faq.answer);
}

async function fetchFaqRows(cacheKey, buildQuery) {
    return cachedPublicJSON(cacheKey, async () => {
        const snap = await getDocs(buildQuery());
        return snapshotRows(snap);
    }, { ttlMs: PUBLIC_CACHE_TTL_MS });
}

function mergeRows(rowsList) {
    const byId = new Map();
    rowsList.flat().forEach(row => {
        if (row?.id) byId.set(row.id, row);
    });
    return [...byId.values()];
}

async function fetchFaqs(pageKey = 'faq', options = {}) {
    const normalizedPage = PAGE_LABELS[pageKey] ? pageKey : 'faq';
    const cacheKey = `${normalizedPage}:${options.hub ? 'hub' : 'page'}:v2`;
    if (faqCache.has(cacheKey)) return faqCache.get(cacheKey);
    if (!db) {
        const fallback = fallbackFaqs();
        faqCache.set(cacheKey, fallback);
        return fallback;
    }

    try {
        const rows = options.hub
            ? mergeRows([
                await fetchFaqRows(`faqs:target:faq:${FAQ_HUB_QUERY_LIMIT}:v2`, () => query(
                    collection(db, 'faqs'),
                    where('targetPages', 'array-contains', 'faq'),
                    limit(FAQ_HUB_QUERY_LIMIT)
                )),
                await fetchFaqRows(`faqs:popular:${FAQ_HUB_QUERY_LIMIT}:v2`, () => query(
                    collection(db, 'faqs'),
                    where('isPopular', '==', true),
                    limit(FAQ_HUB_QUERY_LIMIT)
                ))
            ])
            : await fetchFaqRows(`faqs:target:${normalizedPage}:${FAQ_PAGE_QUERY_LIMIT}:v2`, () => query(
                collection(db, 'faqs'),
                where('targetPages', 'array-contains', normalizedPage),
                limit(normalizedPage === 'faq' ? FAQ_HUB_QUERY_LIMIT : FAQ_PAGE_QUERY_LIMIT)
            ));

        let faqs = normalizeFaqRows(rows);
        if (!faqs.length) {
            const fallbackRows = await fetchFaqRows(`faqs:fallback:${FAQ_HUB_QUERY_LIMIT}:v1`, () => query(
                collection(db, 'faqs'),
                orderBy('order', 'asc'),
                limit(FAQ_HUB_QUERY_LIMIT)
            ));
            faqs = normalizeFaqRows(fallbackRows);
        }
        if (!faqs.length) faqs = fallbackFaqs();
        faqCache.set(cacheKey, faqs);
    } catch (_) {
        faqCache.set(cacheKey, fallbackFaqs());
    }
    return faqCache.get(cacheKey);
}

function fallbackFaqs() {
    return FALLBACK_FAQS
        .map((faq, index) => normalizeFaq({ ...faq, status: 'published', order: faq.order || index + 1 }, faq.id))
        .filter(faq => faq.question && faq.answer);
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
    const open = options.open ? ' open' : '';
    return `
        <article class="faq-card" data-faq-id="${escapeHTML(faq.id)}">
            <details${open}>
                <summary>
                    <span>${escapeHTML(faq.question)}</span>
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
    renderSkeleton(container, 'faq-grid', { count: pageKey === 'faq' ? 6 : 3 });

    try {
        const faqs = getPageFaqs(await fetchFaqs(pageKey), pageKey);
        clearSkeleton(container);
        if (!faqs.length) {
            container.innerHTML = `<p class="faq-empty">ยังไม่มีคำถามสำหรับ${escapeHTML(PAGE_LABELS[pageKey] || 'หน้านี้')}</p>`;
            return;
        }
        container.innerHTML = faqs.map((faq, index) => renderFaqCard(faq, { open: index === 0 })).join('');
        addMoreLink(container, pageKey);
        renderPageSchema(pageKey, faqs);
    } catch (_) {
        const faqs = getPageFaqs(fallbackFaqs(), pageKey);
        clearSkeleton(container);
        if (faqs.length) {
            container.innerHTML = faqs.map((faq, index) => renderFaqCard(faq, { open: index === 0 })).join('');
            addMoreLink(container, pageKey);
            renderPageSchema(pageKey, faqs);
            return;
        }
        container.innerHTML = '<p class="faq-empty error">ยังไม่สามารถโหลดคำถามได้ในขณะนี้</p>';
    }
}

function renderHubList(container, faqs, expanded = false, searchTerm = '') {
    const search = searchTerm.trim().toLowerCase();
    const filtered = faqs
        .filter(faq => {
            if (!search) return true;
            return `${faq.question} ${faq.answer}`.toLowerCase().includes(search);
        })
        .sort((a, b) => {
            const popularDiff = Number(b.isPopular) - Number(a.isPopular);
            if (popularDiff) return popularDiff;
            return safeNumber(a.popularOrder, a.order) - safeNumber(b.popularOrder, b.order);
        });
    const visible = expanded ? filtered : filtered.slice(0, HUB_PREVIEW_LIMIT);
    const body = visible.length
        ? `<div class="faq-hub-grid">${visible.map((faq, index) => renderFaqCard(faq, { open: index === 0 })).join('')}</div>`
        : '<p class="faq-empty">ไม่พบคำถามตามเงื่อนไขที่ค้นหา</p>';

    const resultTarget = container.querySelector('[data-faq-hub-results]');
    const loadMore = container.querySelector('[data-faq-load-more]');
    if (resultTarget) resultTarget.innerHTML = body;
    if (loadMore) loadMore.hidden = expanded || filtered.length <= HUB_PREVIEW_LIMIT;
    renderPageSchema('hub', visible.slice(0, HUB_PREVIEW_LIMIT));
}

async function renderFaqHub(container) {
    container.dataset.faqManaged = 'true';
    renderSkeleton(container, 'faq-grid', { count: 6 });

    try {
        const faqs = (await fetchFaqs('faq', { hub: true }))
            .filter(faq => faq.targetPages.includes('faq') || faq.isPopular)
            .sort((a, b) => safeNumber(a.popularOrder, a.order) - safeNumber(b.popularOrder, b.order));
        clearSkeleton(container);
        container.innerHTML = `
            <div class="faq-hub-toolbar">
                <input type="search" data-faq-hub-search placeholder="ค้นหาคำถาม เช่น จองโต๊ะ, ชำระเงิน, สมาชิก">
            </div>
            <div data-faq-hub-results></div>
            <div class="faq-more-link">
                <button type="button" class="btn faq-more-btn" data-faq-load-more>ดูคำถามเพิ่มเติม</button>
            </div>
        `;

        let expanded = false;
        const search = container.querySelector('[data-faq-hub-search]');
        const loadMore = container.querySelector('[data-faq-load-more]');
        const refresh = () => renderHubList(container, faqs, expanded, search?.value || '');

        search?.addEventListener('input', refresh);
        loadMore?.addEventListener('click', () => {
            expanded = true;
            refresh();
        });
        refresh();
    } catch (_) {
        const faqs = fallbackFaqs()
            .filter(faq => faq.targetPages.includes('faq') || faq.isPopular)
            .sort((a, b) => safeNumber(a.popularOrder, a.order) - safeNumber(b.popularOrder, b.order));
        clearSkeleton(container);
        container.innerHTML = '<div data-faq-hub-results></div>';
        renderHubList(container, faqs, false, '');
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
        faqCache.clear();
        clearPublicCache('faqs:');
        return initFaq();
    }
};

document.addEventListener('DOMContentLoaded', initFaq);
