import { db } from './firebase-config.js';
import { cachedPublicJSON } from './public-data-cache.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const HEADER_NAV_CACHE_KEY = 'header-nav-v1';
const HEADER_NAV_CACHE_TTL_MS = 5 * 60 * 1000;
const HEADER_NAV_ALLOWED_IDS = ['home', 'about', 'menu', 'shop', 'booking', 'archery', 'blog', 'faq'];
const HEADER_NAV_ALLOWED_CHILD_IDS = ['room', 'table'];
const DEFAULT_HEADER_NAV = {
    schemaVersion: 1,
    items: [
        { id: 'home', type: 'link', labelTh: 'หน้าแรก', labelEn: 'Home', hrefTh: '/#home', hrefEn: '/en#home', visible: true, order: 1 },
        { id: 'about', type: 'link', labelTh: 'เกี่ยวกับเรา', labelEn: 'About', hrefTh: '/#about', hrefEn: '/en#about', visible: true, order: 2 },
        { id: 'menu', type: 'link', labelTh: 'เมนู', labelEn: 'Menu', hrefTh: '/menu', hrefEn: '/menu-en', visible: true, order: 3 },
        { id: 'shop', type: 'link', labelTh: 'ร้านค้า', labelEn: 'Shop', hrefTh: '/shop', hrefEn: '/shop-en', visible: true, order: 4 },
        {
            id: 'booking',
            type: 'dropdown',
            labelTh: 'ระบบจอง',
            labelEn: 'Booking',
            hrefTh: '/booking',
            hrefEn: '/booking-en',
            visible: true,
            order: 5,
            children: [
                { id: 'room', labelTh: 'ห้องประชุม', labelEn: 'Meeting Room', hrefTh: '/booking?type=room', hrefEn: '/booking-en?type=room', visible: true, order: 1 },
                { id: 'table', labelTh: 'โต๊ะ', labelEn: 'Table', hrefTh: '/booking?type=table', hrefEn: '/booking-en?type=table', visible: true, order: 2 }
            ]
        },
        { id: 'archery', type: 'link', labelTh: 'ยิงธนู', labelEn: 'Archery', hrefTh: '/archery/', hrefEn: '/archery-en', visible: true, order: 6 },
        { id: 'blog', type: 'link', labelTh: 'บทความ (Blog)', labelEn: 'Blog', hrefTh: '/blog', hrefEn: '/blog-en', visible: true, order: 7 },
        { id: 'faq', type: 'link', labelTh: 'คำถามที่พบบ่อย', labelEn: 'FAQ', hrefTh: '/faq', hrefEn: '/en#faq', visible: true, order: 8 }
    ]
};
const DEFAULT_ITEMS_BY_ID = Object.fromEntries(DEFAULT_HEADER_NAV.items.map(item => [item.id, item]));
const DEFAULT_CHILDREN_BY_ID = Object.fromEntries((DEFAULT_ITEMS_BY_ID.booking.children || []).map(item => [item.id, item]));

function cleanText(value, fallback = '', maxLength = 80) {
    const text = String(value ?? '').trim().replace(/[<>]/g, '');
    return (text || fallback).slice(0, maxLength);
}

function safeInternalHref(value, fallback = '') {
    const href = String(value ?? '').trim();
    const safePattern = /^(\/(?!\/)[A-Za-z0-9._~%/?#&=+-]*|#[A-Za-z0-9_-]+)$/;
    if (!href || href.length > 180) return fallback;
    if (/[\s"'<>\\]/.test(href)) return fallback;
    if (/javascript:/i.test(href)) return fallback;
    return safePattern.test(href) ? href : fallback;
}

function normalizeChild(raw = {}, fallback = DEFAULT_CHILDREN_BY_ID.room, order = 1) {
    const id = HEADER_NAV_ALLOWED_CHILD_IDS.includes(raw.id) ? raw.id : fallback.id;
    const base = DEFAULT_CHILDREN_BY_ID[id] || fallback;
    return {
        id,
        labelTh: cleanText(raw.labelTh, base.labelTh, 64),
        labelEn: cleanText(raw.labelEn, base.labelEn, 64),
        hrefTh: safeInternalHref(raw.hrefTh, base.hrefTh),
        hrefEn: safeInternalHref(raw.hrefEn, base.hrefEn),
        visible: raw.visible !== false,
        order
    };
}

function normalizeChildren(children = []) {
    const rows = Array.isArray(children) ? children : [];
    const sorted = rows
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (Number(a.item?.order) || a.index + 1) - (Number(b.item?.order) || b.index + 1));
    const normalized = [];
    const used = new Set();

    sorted.forEach(({ item }) => {
        if (!HEADER_NAV_ALLOWED_CHILD_IDS.includes(item?.id) || used.has(item.id)) return;
        used.add(item.id);
        normalized.push(normalizeChild(item, DEFAULT_CHILDREN_BY_ID[item.id], normalized.length + 1));
    });
    HEADER_NAV_ALLOWED_CHILD_IDS.forEach(id => {
        if (!used.has(id)) normalized.push(normalizeChild(DEFAULT_CHILDREN_BY_ID[id], DEFAULT_CHILDREN_BY_ID[id], normalized.length + 1));
    });

    return normalized.map((item, index) => ({ ...item, order: index + 1 }));
}

function normalizeItem(raw = {}, fallback = DEFAULT_ITEMS_BY_ID.home, order = 1) {
    const id = HEADER_NAV_ALLOWED_IDS.includes(raw.id) ? raw.id : fallback.id;
    const base = DEFAULT_ITEMS_BY_ID[id] || fallback;
    const item = {
        id,
        type: id === 'booking' ? 'dropdown' : 'link',
        labelTh: cleanText(raw.labelTh, base.labelTh, 64),
        labelEn: cleanText(raw.labelEn, base.labelEn, 64),
        hrefTh: safeInternalHref(raw.hrefTh, base.hrefTh),
        hrefEn: safeInternalHref(raw.hrefEn, base.hrefEn),
        visible: raw.visible !== false,
        order
    };
    if (id === 'booking') item.children = normalizeChildren(raw.children || base.children);
    return item;
}

function normalizeHeaderNav(data = {}) {
    const rows = Array.isArray(data.items) ? data.items : DEFAULT_HEADER_NAV.items;
    const sorted = rows
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (Number(a.item?.order) || a.index + 1) - (Number(b.item?.order) || b.index + 1));
    const normalized = [];
    const used = new Set();

    sorted.forEach(({ item }) => {
        if (!HEADER_NAV_ALLOWED_IDS.includes(item?.id) || used.has(item.id)) return;
        used.add(item.id);
        normalized.push(normalizeItem(item, DEFAULT_ITEMS_BY_ID[item.id], normalized.length + 1));
    });
    HEADER_NAV_ALLOWED_IDS.forEach(id => {
        if (!used.has(id)) normalized.push(normalizeItem(DEFAULT_ITEMS_BY_ID[id], DEFAULT_ITEMS_BY_ID[id], normalized.length + 1));
    });

    return {
        schemaVersion: 1,
        items: normalized.map((item, index) => ({ ...item, order: index + 1 }))
    };
}

function isEnglishPage() {
    return document.documentElement.lang?.toLowerCase().startsWith('en')
        || /(?:^|\/)en(?:\.html)?(?:$|[?#/])/.test(window.location.pathname)
        || /-en(?:\.html)?$/.test(window.location.pathname);
}

function topLevelAnchor(li) {
    return Array.from(li.children).find(child => child.tagName === 'A') || li.querySelector('a');
}

function guessItemId(li) {
    const anchor = topLevelAnchor(li);
    const label = (anchor?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const href = anchor?.getAttribute('href') || '';
    if (li.classList.contains('nav-dropdown') || /booking|ระบบจอง/.test(label) || /\/booking/.test(href)) return 'booking';
    if (/#home$/.test(href) || label === 'home' || label === 'หน้าแรก') return 'home';
    if (/#about$/.test(href) || label === 'about' || label === 'เกี่ยวกับเรา') return 'about';
    if (/\/menu(?:-en)?(?:$|[?#/])/.test(href) || label === 'menu' || label === 'เมนู') return 'menu';
    if (/\/shop(?:-en)?(?:$|[?#/])/.test(href) || label === 'shop' || label === 'ร้านค้า') return 'shop';
    if (/\/archery/.test(href) || label === 'archery' || label === 'ยิงธนู') return 'archery';
    if (/\/blog/.test(href) || label === 'blog' || label === 'บทความ (blog)') return 'blog';
    if (/\/faq|#faq$/.test(href) || label === 'faq' || label === 'คำถามที่พบบ่อย') return 'faq';
    return '';
}

function guessChildId(li) {
    const anchor = li.querySelector('a');
    const label = (anchor?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const href = anchor?.getAttribute('href') || '';
    if (/type=room/.test(href) || /meeting room|ห้องประชุม/.test(label)) return 'room';
    if (/type=table/.test(href) || /table|โต๊ะ/.test(label)) return 'table';
    return '';
}

function ensureTopLevelItem(navList, item) {
    const existing = Array.from(navList.children).find(li => guessItemId(li) === item.id);
    if (existing) return existing;

    const li = document.createElement('li');
    if (item.id === 'booking') {
        li.className = 'nav-dropdown';
        const anchor = document.createElement('a');
        anchor.className = 'nav-dropdown-toggle';
        anchor.setAttribute('aria-haspopup', 'true');
        li.append(anchor);
        const menu = document.createElement('ul');
        menu.className = 'nav-dropdown-menu';
        li.append(menu);
    } else {
        li.append(document.createElement('a'));
    }
    return li;
}

function ensureChildItem(menu, child) {
    const existing = Array.from(menu.children).find(li => guessChildId(li) === child.id);
    if (existing) return existing;
    const li = document.createElement('li');
    li.append(document.createElement('a'));
    return li;
}

function updateAnchorText(anchor, label, withCaret = false) {
    if (!anchor) return;
    anchor.textContent = label;
    if (withCaret) {
        anchor.append(document.createTextNode(' '));
        const caret = document.createElement('span');
        caret.className = 'nav-dropdown-caret';
        caret.setAttribute('aria-hidden', 'true');
        anchor.append(caret);
    }
}

function activeNavId() {
    const path = (window.location.pathname || '/').replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    const hash = window.location.hash || '';
    if (hash === '#faq') return 'faq';
    if (hash === '#about') return 'about';
    if (hash === '#home') return 'home';
    if (path === '/' || path === '/en' || path === '/index') return 'home';
    if (path === '/menu' || path === '/menu-en') return 'menu';
    if (path === '/shop' || path === '/shop-en') return 'shop';
    if (path === '/booking' || path === '/booking-en') return 'booking';
    if (path === '/archery' || path === '/archery-en' || path.startsWith('/archery/')) return 'archery';
    if (path === '/blog' || path === '/blog-en' || path.startsWith('/blog/')) return 'blog';
    if (path === '/faq') return 'faq';
    return '';
}

function applyHeaderNav(config) {
    const navList = document.querySelector('.nav-links');
    if (!navList) return;

    const en = isEnglishPage();
    const labelKey = en ? 'labelEn' : 'labelTh';
    const hrefKey = en ? 'hrefEn' : 'hrefTh';
    const activeId = activeNavId();
    const knownNodes = new Set();
    const fragment = document.createDocumentFragment();

    config.items.forEach(item => {
        const li = ensureTopLevelItem(navList, item);
        knownNodes.add(li);
        li.dataset.headerNavId = item.id;
        li.hidden = item.visible === false;
        li.style.display = item.visible === false ? 'none' : '';

        const anchor = topLevelAnchor(li);
        if (anchor) {
            anchor.href = item[hrefKey];
            anchor.classList.toggle('active', item.id === activeId);
            if (item.id === 'booking') {
                li.classList.add('nav-dropdown');
                anchor.classList.add('nav-dropdown-toggle');
                anchor.setAttribute('aria-haspopup', 'true');
                updateAnchorText(anchor, item[labelKey], true);
            } else {
                updateAnchorText(anchor, item[labelKey], false);
            }
        }

        if (item.id === 'booking') {
            const menu = li.querySelector('.nav-dropdown-menu') || document.createElement('ul');
            menu.classList.add('nav-dropdown-menu');
            if (!menu.parentElement) li.append(menu);
            menu.setAttribute('aria-label', en ? 'Booking options' : 'ตัวเลือกระบบจอง');
            const childFragment = document.createDocumentFragment();
            const childKnown = new Set();
            (item.children || []).forEach(child => {
                const childLi = ensureChildItem(menu, child);
                childKnown.add(childLi);
                childLi.hidden = child.visible === false;
                childLi.style.display = child.visible === false ? 'none' : '';
                const childAnchor = childLi.querySelector('a') || document.createElement('a');
                if (!childAnchor.parentElement) childLi.append(childAnchor);
                childAnchor.href = child[hrefKey];
                childAnchor.textContent = child[labelKey];
                childFragment.append(childLi);
            });
            Array.from(menu.children).forEach(childLi => {
                if (!childKnown.has(childLi)) childFragment.append(childLi);
            });
            menu.append(childFragment);
        }

        fragment.append(li);
    });

    Array.from(navList.children).forEach(li => {
        if (!knownNodes.has(li)) fragment.append(li);
    });
    navList.append(fragment);
}

async function fetchHeaderNavConfig() {
    const snap = await getDoc(doc(db, 'site_settings', 'header_nav'));
    return snap.exists() ? snap.data() : DEFAULT_HEADER_NAV;
}

async function loadHeaderNav() {
    try {
        const config = await cachedPublicJSON(HEADER_NAV_CACHE_KEY, fetchHeaderNavConfig, { ttlMs: HEADER_NAV_CACHE_TTL_MS });
        applyHeaderNav(normalizeHeaderNav(config));
    } catch (error) {
        console.warn('Header nav config unavailable; using static fallback.', error);
        applyHeaderNav(normalizeHeaderNav(DEFAULT_HEADER_NAV));
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadHeaderNav, { once: true });
} else {
    loadHeaderNav();
}
