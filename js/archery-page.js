import { db } from './firebase-config.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { clearSkeleton, renderSkeleton } from './ui-skeleton.js';

const SETTINGS_REF = doc(db, 'site_settings', 'archery');
const HERO_FALLBACK = 'https://www.edencafe.co/Images/uploads/archery/2026-06/1782188813037-archery-hero-1782188809834.webp';
const HERO_CACHE_KEY = 'eden_archery_hero_url';

function safeImageURL(value, fallback = HERO_FALLBACK) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/?(Images|Hero)\//i.test(url)) return url.startsWith('/') ? url : '/' + url;
    return fallback;
}

function money(value) {
    const amount = Number(value || 0) || 0;
    return amount.toLocaleString('th-TH') + ' THB';
}

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizePackage(item = {}, index = 0) {
    const duration = Number(item.durationMinutes || item.duration_minutes || item.duration || 0) || [60, 120, 180][index] || 60;
    const conditions = Array.isArray(item.conditions)
        ? item.conditions.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    return {
        durationMinutes: duration,
        price: Number(item.price || 0) || 0,
        title: String(item.title || `${duration} min`).trim(),
        description: String(item.description || '').trim(),
        conditions
    };
}

function hasPublicPackageContent(item = {}) {
    const defaultTitle = `${item.durationMinutes || 60} min`;
    return Number(item.price || 0) > 0
        || String(item.description || '').trim()
        || (Array.isArray(item.conditions) && item.conditions.length > 0)
        || String(item.title || '').trim() !== defaultTitle;
}

function revealHeroImage(heroImg) {
    if (!heroImg) return;
    const reveal = () => heroImg.classList.add('is-ready');
    if (heroImg.complete) reveal();
    else heroImg.addEventListener('load', reveal, { once: true });
}

function primeHeroFromCache() {
    const heroImg = document.querySelector('.archery-hero img');
    if (!heroImg) return;
    try {
        const cached = safeImageURL(localStorage.getItem(HERO_CACHE_KEY) || '', '');
        if (cached) heroImg.src = cached;
    } catch (error) {
        console.warn('Unable to read Archery hero cache:', error);
    }
    revealHeroImage(heroImg);
}

function renderHero(settings = {}) {
    const imageUrl = safeImageURL(settings.heroImageUrl || settings.hero_image_url || settings.heroUrl);
    const heroImg = document.querySelector('.archery-hero img');
    if (heroImg) {
        if (heroImg.getAttribute('src') === imageUrl) {
            revealHeroImage(heroImg);
        } else {
            heroImg.classList.remove('is-ready');
            const nextImage = new Image();
            nextImage.onload = () => {
                heroImg.src = imageUrl;
                try {
                    localStorage.setItem(HERO_CACHE_KEY, imageUrl);
                } catch (error) {
                    console.warn('Unable to cache Archery hero:', error);
                }
                revealHeroImage(heroImg);
            };
            nextImage.onerror = () => {
                heroImg.src = HERO_FALLBACK;
                revealHeroImage(heroImg);
            };
            nextImage.src = imageUrl;
        }
    }

    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) {
        ogImage.setAttribute('content', /^https?:\/\//i.test(imageUrl) ? imageUrl : 'https://edencafe.co' + imageUrl);
    }
}

function renderPackages(settings = {}) {
    const grids = document.querySelectorAll('.archery-band .archery-grid');
    const packageGrid = grids[0];
    if (!packageGrid) return;
    clearSkeleton(packageGrid);

    const isEnglish = String(document.documentElement.lang || '').toLowerCase().startsWith('en');
    const sourcePackages = isEnglish && Array.isArray(settings.packagesEn)
        ? settings.packagesEn
        : (!isEnglish && Array.isArray(settings.packages) ? settings.packages : []);
    const lead = String(isEnglish ? (settings.packageLeadEn || '') : (settings.packageLead || settings.package_lead || '')).trim();
    const leadEl = document.querySelector('.archery-band .archery-section-lead');
    if (lead && leadEl) leadEl.textContent = lead;

    const packages = sourcePackages.map(normalizePackage).filter(item => item.durationMinutes > 0 && hasPublicPackageContent(item));
    if (!packages.length) return;

    packageGrid.classList.add('archery-dynamic-list');
    packageGrid.innerHTML = packages.map(item => `
        <article class="archery-card">
            <strong>${escapeHTML(item.title || `${item.durationMinutes} min`)}</strong>
            ${item.description ? `<p>${escapeHTML(item.description)}</p>` : ''}
            <p><strong>${escapeHTML(money(item.price))}</strong></p>
            ${item.conditions.length ? `<ul>${item.conditions.map(condition => `<li>${escapeHTML(condition)}</li>`).join('')}</ul>` : ''}
        </article>
    `).join('');
}

async function loadArcheryPageSettings() {
    const packageGrid = document.querySelector('.archery-band .archery-grid');
    if (packageGrid) renderSkeleton(packageGrid, 'stats', { count: 3 });
    try {
        const snap = await getDoc(SETTINGS_REF);
        if (!snap.exists()) {
            clearSkeleton(packageGrid);
            renderHero({});
            return;
        }
        const settings = snap.data() || {};
        renderHero(settings);
        renderPackages(settings);
    } catch (error) {
        console.warn('Unable to load Archery page settings:', error);
        clearSkeleton(packageGrid);
        renderHero({});
    }
}

primeHeroFromCache();
loadArcheryPageSettings();
