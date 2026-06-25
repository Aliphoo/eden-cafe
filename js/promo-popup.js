import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const PROMO_SETTINGS_REF = doc(db, 'site_settings', 'promo_popup');
const LEGACY_INDEX_REF = doc(db, 'site_settings', 'index');
const PROMO_HIDE_TODAY_KEY = 'eden_promo_popup_hide_date_v2';
const PROMO_MAX_SLIDES = 8;
const AUTH_SURFACES = new Set(['admin', 'auth']);

let authStatePromise = null;
let promoLoadRun = 0;

function cleanText(value, fallback = '', maxLength = 500) {
    const text = String(value ?? '').trim();
    return (text || fallback).slice(0, maxLength);
}

function safeImageURL(value) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/?(Images|Hero)\//i.test(url)) return url.startsWith('/') ? url : '/' + url;
    return '';
}

function safeOptionalLinkURL(value) {
    const url = String(value || '').trim();
    if (!url) return '';
    if (/^(https?:|mailto:|tel:)/i.test(url)) return url.slice(0, 500);
    if (/^\/(?!\/)/.test(url) || /^#/.test(url)) return url.slice(0, 500);
    return '';
}

function normalizeDisplayLocation(raw = {}) {
    const value = cleanText(raw.displayLocation || raw.display_location || raw.location || '', '', 40);
    if (['home', 'profile', 'home_profile', 'all_public'].includes(value)) return value;

    const list = Array.isArray(raw.displayLocations || raw.display_locations || raw.displayTargets || raw.display_targets)
        ? raw.displayLocations || raw.display_locations || raw.displayTargets || raw.display_targets
        : [];
    const locations = list.map(item => String(item || '').trim()).filter(Boolean);
    if (locations.includes('all_public')) return 'all_public';
    if (locations.includes('home') && locations.includes('profile')) return 'home_profile';
    if (locations.includes('profile')) return 'profile';
    return 'home';
}

function normalizeAudience(raw = {}) {
    const value = cleanText(raw.audience || raw.targetAudience || raw.target_audience || '', 'everyone', 40);
    return ['everyone', 'members', 'guests'].includes(value) ? value : 'everyone';
}

function normalizePromoPopup(raw = {}) {
    const slides = Array.isArray(raw.slides)
        ? raw.slides.map((slide, index) => ({
            imageUrl: safeImageURL(slide.imageUrl || slide.image_url || ''),
            linkUrl: safeOptionalLinkURL(slide.linkUrl || slide.link_url || ''),
            altText: cleanText(slide.altText || slide.alt || '', '', 180),
            active: slide.active !== false,
            order: Number.isFinite(Number(slide.order)) ? Number(slide.order) : index + 1
        }))
            .filter(slide => slide.active && slide.imageUrl)
            .sort((a, b) => a.order - b.order)
            .slice(0, PROMO_MAX_SLIDES)
        : [];

    return {
        enabled: raw.enabled === true,
        title: cleanText(raw.title || raw.titleTh || raw.titleEn, 'Eden Cafe promotions', 90),
        displayLocation: normalizeDisplayLocation(raw),
        audience: normalizeAudience(raw),
        slides
    };
}

function isEnglishPage() {
    return document.documentElement.lang?.toLowerCase().startsWith('en')
        || /(?:^|\/)en(?:\.html)?(?:$|[?#/])/.test(window.location.pathname)
        || /-en(?:\.html)?$/.test(window.location.pathname);
}

function currentSurface() {
    const path = String(window.location.pathname || '/').replace(/\/+$/, '').toLowerCase() || '/';
    if (path === '/' || path === '/index.html' || path === '/en' || path === '/en.html') return 'home';
    if (path === '/profile' || path === '/profile.html' || path === '/profile-en' || path === '/profile-en.html') return 'profile';
    if (path === '/admin' || path.startsWith('/admin/')) return 'admin';
    if (path === '/login' || path === '/login.html' || path === '/register' || path === '/register.html') return 'auth';
    return 'public';
}

function matchesDisplayLocation(displayLocation, surface) {
    if (displayLocation === 'home') return surface === 'home';
    if (displayLocation === 'profile') return surface === 'profile';
    if (displayLocation === 'home_profile') return surface === 'home' || surface === 'profile';
    if (displayLocation === 'all_public') return !AUTH_SURFACES.has(surface);
    return surface === 'home';
}

function authState() {
    if (authStatePromise) return authStatePromise;
    authStatePromise = new Promise(resolve => {
        if (!auth) {
            resolve(null);
            return;
        }
        let settled = false;
        const timer = window.setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(auth.currentUser || null);
            }
        }, 1800);
        const unsubscribe = onAuthStateChanged(auth, user => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            unsubscribe();
            resolve(user || null);
        }, () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            resolve(null);
        });
    });
    return authStatePromise;
}

function localDateStamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isPromoHiddenToday() {
    try {
        return localStorage.getItem(PROMO_HIDE_TODAY_KEY) === localDateStamp();
    } catch (_) {
        return false;
    }
}

function hidePromoForToday() {
    try {
        localStorage.setItem(PROMO_HIDE_TODAY_KEY, localDateStamp());
    } catch (_) {
        // Visitor storage can be unavailable in private contexts.
    }
}

function destroyPromoPopup() {
    document.querySelector('.eden-promo-popup')?.remove();
    document.body?.classList.remove('eden-promo-popup-open');
}

function promoIcon(path) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
}

function shouldOpenLinkInNewTab(url) {
    try {
        const parsed = new URL(url, window.location.href);
        return parsed.origin !== window.location.origin && /^https?:$/i.test(parsed.protocol);
    } catch (_) {
        return false;
    }
}

async function shouldRenderPromo(popup) {
    if (!popup.enabled || !popup.slides.length || isPromoHiddenToday()) return false;
    const surface = currentSurface();
    if (!matchesDisplayLocation(popup.displayLocation, surface)) return false;

    if (popup.audience === 'everyone') {
        return surface !== 'profile' || !!await authState();
    }

    const user = await authState();
    if (popup.audience === 'members') return !!user;
    if (popup.audience === 'guests') return !user && surface !== 'profile';
    return true;
}

function renderPromoPopup(popup) {
    destroyPromoPopup();

    const isEn = isEnglishPage();
    const hideTodayLabel = isEn ? 'Do not show again today' : '\u0e44\u0e21\u0e48\u0e15\u0e49\u0e2d\u0e07\u0e41\u0e2a\u0e14\u0e07\u0e2d\u0e35\u0e01\u0e27\u0e31\u0e19\u0e19\u0e35\u0e49';
    let activeIndex = 0;
    const root = document.createElement('div');
    root.className = 'eden-promo-popup';
    root.innerHTML = `
        <div class="eden-promo-popup__scrim" data-promo-close></div>
        <section class="eden-promo-popup__dialog" role="dialog" aria-modal="true" aria-label="${isEn ? 'Promotions' : '\u0e42\u0e1b\u0e23\u0e42\u0e21\u0e0a\u0e31\u0e48\u0e19'}">
            <div class="eden-promo-popup__stage">
                <button type="button" class="eden-promo-popup__nav eden-promo-popup__nav--prev" data-promo-prev aria-label="${isEn ? 'Previous promotion' : '\u0e42\u0e1b\u0e23\u0e42\u0e21\u0e0a\u0e31\u0e48\u0e19\u0e01\u0e48\u0e2d\u0e19\u0e2b\u0e19\u0e49\u0e32'}">
                    ${promoIcon('<path d="m15 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')}
                </button>
                <div class="eden-promo-popup__media" data-promo-media></div>
                <button type="button" class="eden-promo-popup__nav eden-promo-popup__nav--next" data-promo-next aria-label="${isEn ? 'Next promotion' : '\u0e42\u0e1b\u0e23\u0e42\u0e21\u0e0a\u0e31\u0e48\u0e19\u0e16\u0e31\u0e14\u0e44\u0e1b'}">
                    ${promoIcon('<path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')}
                </button>
            </div>
            <div class="eden-promo-popup__dots" data-promo-dots></div>
            <footer class="eden-promo-popup__footer">
                <label class="eden-promo-popup__check">
                    <input type="checkbox" data-promo-hide-today>
                    <span>${hideTodayLabel}</span>
                </label>
                <button type="button" class="eden-promo-popup__close" data-promo-close aria-label="${isEn ? 'Close promotions' : '\u0e1b\u0e34\u0e14\u0e42\u0e1b\u0e23\u0e42\u0e21\u0e0a\u0e31\u0e48\u0e19'}">
                    ${promoIcon('<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>')}
                </button>
            </footer>
        </section>
    `;

    const media = root.querySelector('[data-promo-media]');
    const dots = root.querySelector('[data-promo-dots]');
    const hideToday = root.querySelector('[data-promo-hide-today]');

    function rememberIfRequested() {
        if (hideToday?.checked) hidePromoForToday();
    }

    function closePopup() {
        rememberIfRequested();
        destroyPromoPopup();
        document.removeEventListener('keydown', handleKeydown);
    }

    function renderSlide(index) {
        activeIndex = (index + popup.slides.length) % popup.slides.length;
        const slide = popup.slides[activeIndex];
        const img = document.createElement('img');
        img.src = slide.imageUrl;
        img.alt = slide.altText || popup.title || (isEn ? 'Promotion' : '\u0e42\u0e1b\u0e23\u0e42\u0e21\u0e0a\u0e31\u0e48\u0e19');
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';

        media.replaceChildren();
        if (slide.linkUrl) {
            const link = document.createElement('a');
            link.href = slide.linkUrl;
            link.className = 'eden-promo-popup__link';
            if (shouldOpenLinkInNewTab(slide.linkUrl)) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            link.addEventListener('click', rememberIfRequested);
            link.appendChild(img);
            media.appendChild(link);
        } else {
            media.appendChild(img);
        }

        dots.querySelectorAll('button').forEach((button, dotIndex) => {
            button.classList.toggle('is-active', dotIndex === activeIndex);
            button.setAttribute('aria-current', dotIndex === activeIndex ? 'true' : 'false');
        });
    }

    function handleKeydown(event) {
        if (event.key === 'Escape') closePopup();
        if (event.key === 'ArrowLeft' && popup.slides.length > 1) renderSlide(activeIndex - 1);
        if (event.key === 'ArrowRight' && popup.slides.length > 1) renderSlide(activeIndex + 1);
    }

    dots.replaceChildren(...popup.slides.map((_, index) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.setAttribute('aria-label', `${isEn ? 'Show promotion' : '\u0e14\u0e39\u0e42\u0e1b\u0e23\u0e42\u0e21\u0e0a\u0e31\u0e48\u0e19'} ${index + 1}`);
        dot.addEventListener('click', () => renderSlide(index));
        return dot;
    }));

    root.querySelectorAll('[data-promo-close]').forEach(button => button.addEventListener('click', closePopup));
    root.querySelector('[data-promo-prev]')?.addEventListener('click', () => renderSlide(activeIndex - 1));
    root.querySelector('[data-promo-next]')?.addEventListener('click', () => renderSlide(activeIndex + 1));
    root.classList.toggle('is-single-slide', popup.slides.length <= 1);

    document.body.appendChild(root);
    document.body.classList.add('eden-promo-popup-open');
    document.addEventListener('keydown', handleKeydown);
    renderSlide(0);
}

async function loadPromoSettings() {
    try {
        const snap = await getDoc(PROMO_SETTINGS_REF);
        if (snap.exists()) return normalizePromoPopup(snap.data());
    } catch (error) {
        console.warn('Unable to load promo popup settings:', error);
    }

    try {
        const legacySnap = await getDoc(LEGACY_INDEX_REF);
        const legacyPopup = legacySnap.exists() ? legacySnap.data()?.promoPopup || legacySnap.data()?.promo_popup : null;
        if (legacyPopup) return normalizePromoPopup({ ...legacyPopup, displayLocation: 'home', audience: 'everyone' });
    } catch (error) {
        console.warn('Unable to load legacy promo popup settings:', error);
    }

    return normalizePromoPopup({});
}

async function loadPromoPopup() {
    const runId = ++promoLoadRun;
    const popup = await loadPromoSettings();
    if (runId !== promoLoadRun) return;
    if (!await shouldRenderPromo(popup)) {
        destroyPromoPopup();
        return;
    }
    renderPromoPopup(popup);
}

function bootPromoPopup() {
    if (currentSurface() === 'admin') return;
    loadPromoPopup();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootPromoPopup);
} else {
    bootPromoPopup();
}

window.addEventListener('eden:user-changed', () => {
    authStatePromise = null;
    loadPromoPopup();
});

window.EdenPromoPopup = {
    destroy: destroyPromoPopup,
    refresh: loadPromoPopup
};
