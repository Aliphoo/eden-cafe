import { db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const SETTINGS_REF = doc(db, 'site_settings', 'index');
const CACHE_KEY = 'eden_index_settings_cache_v1';
const PROMO_HIDE_TODAY_KEY = 'eden_promo_popup_hide_date_v1';
const PROMO_MAX_SLIDES = 8;

const FALLBACK_INDEX = {
    heroImageUrl: '/Hero/Hero.webp',
    heroTitleTh: 'จากใจเรา สู่มือคุณ',
    heroSubtitleTh: 'ยินดีต้อนรับสู่ Eden Cafe - พื้นที่พักผ่อนที่เงียบสงบใจกลางเมือง สัมผัสประสบการณ์เมล็ดกาแฟที่ปลูกอย่างใส่ใจและคั่วอย่างพิถีพิถันจากเกษตรกรไทย',
    heroTitleEn: 'Discover the True Taste of Thai Specialty Coffee',
    heroSubtitleEn: 'Welcome to Eden Cafe - Your serene escape in the heart of Thailand. Experience locally-sourced, ethically-grown coffee beans roasted to perfection.',
    aboutTitleTh: 'เรื่องราวของเรา: จากยอดดอยสู่แก้วกาแฟของคุณ',
    aboutBodyTh: 'Eden Cafe เกิดขึ้นจากความหลงใหลในศิลปะการชงกาแฟและการสนับสนุนเกษตรกรไทย เราคัดสรรเมล็ดกาแฟจากแหล่งปลูกที่ดีที่สุดบนยอดดอยในประเทศไทย คั่วด้วยเทคนิคพิเศษเพื่อให้ได้รสชาติที่เป็นเอกลักษณ์ ไม่เหมือนใคร บรรยากาศร้านของเราออกแบบสไตล์มินิมอล อิงธรรมชาติ เพื่อให้คุณได้พักผ่อนอย่างแท้จริง',
    aboutTitleEn: 'Our Story: From Thai Mountains to Your Cup',
    aboutBodyEn: 'Eden Cafe was born out of a passion for the art of coffee brewing and supporting Thai farmers. We carefully select coffee beans from the best high-altitude farms in Thailand, roasted with special techniques to achieve a unique flavor. Our minimalist, nature-inspired design offers a true sanctuary for relaxation.'
};

function cleanText(value, fallback, maxLength) {
    const text = String(value ?? '').trim();
    return (text || fallback).slice(0, maxLength);
}

function cleanOptionalText(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function safeImageURL(value, fallback = FALLBACK_INDEX.heroImageUrl) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/?(Images|Hero)\//i.test(url)) return url.startsWith('/') ? url : '/' + url;
    return fallback;
}

function safeOptionalLinkURL(value) {
    const url = String(value || '').trim();
    if (!url) return '';
    if (/^(https?:|mailto:|tel:)/i.test(url)) return url.slice(0, 500);
    if (/^\/(?!\/)/.test(url) || /^#/.test(url)) return url.slice(0, 500);
    return '';
}

function isEnglishPage() {
    return document.documentElement.lang?.toLowerCase().startsWith('en')
        || /(?:^|\/)en(?:\.html)?(?:$|[?#/])/.test(window.location.pathname)
        || /-en\.html$/.test(window.location.pathname);
}

function normalizePromoPopup(raw = {}) {
    const slides = Array.isArray(raw.slides)
        ? raw.slides.map((slide, index) => ({
            imageUrl: safeImageURL(slide.imageUrl || slide.image_url || '', ''),
            linkUrl: safeOptionalLinkURL(slide.linkUrl || slide.link_url || ''),
            altText: cleanOptionalText(slide.altText || slide.alt || '', 180),
            order: Number.isFinite(Number(slide.order)) ? Number(slide.order) : index + 1
        })).filter(slide => slide.imageUrl).sort((a, b) => a.order - b.order).slice(0, PROMO_MAX_SLIDES)
        : [];
    return {
        enabled: raw.enabled === true,
        title: cleanOptionalText(raw.title || raw.titleTh || raw.titleEn || 'Eden Cafe promotions', 90),
        slides
    };
}

function normalizeIndexSettings(data = {}) {
    return {
        heroImageUrl: safeImageURL(data.heroImageUrl || data.hero_image_url || FALLBACK_INDEX.heroImageUrl),
        heroTitleTh: cleanText(data.heroTitleTh, FALLBACK_INDEX.heroTitleTh, 120),
        heroSubtitleTh: cleanText(data.heroSubtitleTh, FALLBACK_INDEX.heroSubtitleTh, 320),
        heroTitleEn: cleanText(data.heroTitleEn, FALLBACK_INDEX.heroTitleEn, 120),
        heroSubtitleEn: cleanText(data.heroSubtitleEn, FALLBACK_INDEX.heroSubtitleEn, 320),
        aboutTitleTh: cleanText(data.aboutTitleTh, FALLBACK_INDEX.aboutTitleTh, 140),
        aboutBodyTh: cleanText(data.aboutBodyTh, FALLBACK_INDEX.aboutBodyTh, 900),
        aboutTitleEn: cleanText(data.aboutTitleEn, FALLBACK_INDEX.aboutTitleEn, 140),
        aboutBodyEn: cleanText(data.aboutBodyEn, FALLBACK_INDEX.aboutBodyEn, 900)
    };
}

function setText(selector, value) {
    const element = document.querySelector(selector);
    if (element && value) element.textContent = value;
}

function setHeroImage(imageUrl) {
    const hero = document.querySelector('#home.hero');
    if (!hero || !imageUrl) return;

    const apply = () => {
        hero.style.setProperty('--index-hero-image', `url("${imageUrl}")`);
        hero.classList.add('index-hero-ready');
    };

    const image = new Image();
    image.onload = apply;
    image.onerror = apply;
    image.src = imageUrl;
    if (image.complete) apply();
}

function applyIndexSettings(rawSettings = {}, source = '') {
    const settings = normalizeIndexSettings(rawSettings);
    const lang = isEnglishPage() ? 'En' : 'Th';

    setText('[data-index-setting="hero-title"]', settings[`heroTitle${lang}`]);
    setText('[data-index-setting="hero-subtitle"]', settings[`heroSubtitle${lang}`]);
    setText('[data-index-setting="about-title"]', settings[`aboutTitle${lang}`]);
    setText('[data-index-setting="about-body"]', settings[`aboutBody${lang}`]);
    setHeroImage(settings.heroImageUrl);
    document.documentElement.classList.add('index-settings-applied');
    if (source) document.documentElement.dataset.indexSettingsSource = source;
}

function readCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

function writeCache(settings) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(normalizeIndexSettings(settings)));
    } catch (_) {
        // Cache is a speed optimization only.
    }
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

function renderPromoPopup(rawPopup = {}) {
    const popup = normalizePromoPopup(rawPopup);
    destroyPromoPopup();
    if (!popup.enabled || !popup.slides.length || isPromoHiddenToday()) return;

    const isEn = isEnglishPage();
    let activeIndex = 0;
    const root = document.createElement('div');
    root.className = 'eden-promo-popup';
    root.innerHTML = `
        <div class="eden-promo-popup__scrim" data-promo-close></div>
        <section class="eden-promo-popup__dialog" role="dialog" aria-modal="true" aria-label="${isEn ? 'Promotions' : 'โปรโมชั่น'}">
            <div class="eden-promo-popup__stage">
                <button type="button" class="eden-promo-popup__nav eden-promo-popup__nav--prev" data-promo-prev aria-label="${isEn ? 'Previous promotion' : 'โปรโมชั่นก่อนหน้า'}">
                    ${promoIcon('<path d="m15 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')}
                </button>
                <div class="eden-promo-popup__media" data-promo-media></div>
                <button type="button" class="eden-promo-popup__nav eden-promo-popup__nav--next" data-promo-next aria-label="${isEn ? 'Next promotion' : 'โปรโมชั่นถัดไป'}">
                    ${promoIcon('<path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')}
                </button>
            </div>
            <div class="eden-promo-popup__dots" data-promo-dots></div>
            <footer class="eden-promo-popup__footer">
                <label class="eden-promo-popup__check">
                    <input type="checkbox" data-promo-hide-today>
                    <span>${isEn ? 'Do not show again today' : 'ไม่ต้องแสดงอีกวันนี้'}</span>
                </label>
                <button type="button" class="eden-promo-popup__close" data-promo-close aria-label="${isEn ? 'Close promotions' : 'ปิดโปรโมชั่น'}">
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
        img.alt = slide.altText || popup.title || (isEn ? 'Promotion' : 'โปรโมชั่น');
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
        dot.setAttribute('aria-label', `${isEn ? 'Show promotion' : 'ดูโปรโมชั่น'} ${index + 1}`);
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

async function loadIndexSettings() {
    const cached = readCache();
    if (cached) applyIndexSettings(cached, 'cache');

    try {
        const snap = await getDoc(SETTINGS_REF);
        if (!snap.exists()) {
            destroyPromoPopup();
            if (!cached) applyIndexSettings(FALLBACK_INDEX, 'fallback');
            return;
        }
        const rawSettings = snap.data();
        const settings = normalizeIndexSettings(rawSettings);
        writeCache(settings);
        applyIndexSettings(settings, 'firestore');
        renderPromoPopup(rawSettings.promoPopup || rawSettings.promo_popup || {});
    } catch (_) {
        if (!cached) applyIndexSettings(FALLBACK_INDEX, 'fallback');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadIndexSettings);
} else {
    loadIndexSettings();
}
