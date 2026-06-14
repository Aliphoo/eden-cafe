import { db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const SETTINGS_REF = doc(db, 'site_settings', 'index');
const CACHE_KEY = 'eden_index_settings_cache_v1';

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

function safeImageURL(value, fallback = FALLBACK_INDEX.heroImageUrl) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/?(Images|Hero)\//i.test(url)) return url.startsWith('/') ? url : '/' + url;
    return fallback;
}

function isEnglishPage() {
    return document.documentElement.lang?.toLowerCase().startsWith('en')
        || /(?:^|\/)en(?:\.html)?(?:$|[?#/])/.test(window.location.pathname)
        || /-en\.html$/.test(window.location.pathname);
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

async function loadIndexSettings() {
    const cached = readCache();
    if (cached) applyIndexSettings(cached, 'cache');

    try {
        const snap = await getDoc(SETTINGS_REF);
        if (!snap.exists()) {
            if (!cached) applyIndexSettings(FALLBACK_INDEX, 'fallback');
            return;
        }
        const settings = normalizeIndexSettings(snap.data());
        writeCache(settings);
        applyIndexSettings(settings, 'firestore');
    } catch (_) {
        if (!cached) applyIndexSettings(FALLBACK_INDEX, 'fallback');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadIndexSettings);
} else {
    loadIndexSettings();
}
