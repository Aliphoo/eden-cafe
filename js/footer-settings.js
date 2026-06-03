import { db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const TEXT = {
    emailPrefix: '\u0e2d\u0e35\u0e40\u0e21\u0e25: ',
    phonePrefix: '\u0e42\u0e17\u0e23: '
};

const CACHE_KEY = 'eden_footer_settings_cache_v1';
const DEFAULT_FOOTER_SETTINGS = {
    brandName: 'Eden Cafe.',
    tagline: '\u0e01\u0e32\u0e41\u0e1f\u0e1e\u0e34\u0e40\u0e28\u0e29\u0e23\u0e30\u0e14\u0e31\u0e1a\u0e1e\u0e23\u0e35\u0e40\u0e21\u0e35\u0e22\u0e21 \u0e17\u0e48\u0e32\u0e21\u0e01\u0e25\u0e32\u0e07\u0e2a\u0e27\u0e19\u0e18\u0e23\u0e23\u0e21\u0e0a\u0e32\u0e15\u0e34\u0e41\u0e25\u0e30\u0e1a\u0e23\u0e23\u0e22\u0e32\u0e01\u0e32\u0e28\u0e2a\u0e07\u0e1a \u0e1e\u0e37\u0e49\u0e19\u0e17\u0e35\u0e48\u0e1e\u0e31\u0e01\u0e1c\u0e48\u0e2d\u0e19\u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e01\u0e32\u0e23\u0e43\u0e0a\u0e49\u0e0a\u0e35\u0e27\u0e34\u0e15\u0e0a\u0e49\u0e32 \u0e46 \u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e2d\u0e32\u0e2b\u0e32\u0e23 \u0e40\u0e04\u0e23\u0e37\u0e48\u0e2d\u0e07\u0e14\u0e37\u0e48\u0e21 \u0e41\u0e25\u0e30\u0e1b\u0e23\u0e30\u0e2a\u0e1a\u0e01\u0e32\u0e23\u0e13\u0e4c Wellness \u0e40\u0e1e\u0e37\u0e48\u0e2d\u0e2a\u0e38\u0e02\u0e20\u0e32\u0e1e',
    address: '306 \u0e2b\u0e21\u0e39\u0e48 7 \u0e15\u0e33\u0e1a\u0e25\u0e19\u0e32\u0e07\u0e41\u0e25 \u0e2d\u0e33\u0e40\u0e21\u0e37\u0e2d\u0e07 \u0e08.\u0e40\u0e0a\u0e35\u0e22\u0e07\u0e23\u0e32\u0e22',
    email: 'edencafe.2565@gmail.com',
    phone: '0980080383',
    copyright: '\u00a9 2017 Eden Cafe Thailand. \u0e2a\u0e07\u0e27\u0e19\u0e25\u0e34\u0e02\u0e2a\u0e34\u0e17\u0e18\u0e34\u0e4c | Optimized for SEO, AEO & GEO',
    instagram: 'https://www.instagram.com/edencafe_2565?igsh=MTUzdHdnOWQxaG4zaw==',
    facebook: 'https://www.facebook.com/EdenCafeChaingrai',
    line: 'https://page.line.me/811ojjgi?openQrModal=true'
};

function cleanText(value) {
    return String(value ?? '').trim();
}

function normalizedFooterSettings(data = {}) {
    return {
        ...DEFAULT_FOOTER_SETTINGS,
        ...data
    };
}

function readCachedFooterSettings() {
    try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        return cached && typeof cached === 'object' ? normalizedFooterSettings(cached) : null;
    } catch (_) {
        return null;
    }
}

function cacheFooterSettings(data) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(normalizedFooterSettings(data)));
    } catch (_) {
        // Ignore storage failures; the static fallback still prevents placeholder flash.
    }
}

function safeURL(value) {
    const url = cleanText(value);
    if (!url) return '#';

    try {
        const parsed = new URL(url, window.location.origin);
        if (parsed.protocol !== 'https:') return '#';
        return parsed.href;
    } catch (_) {
        return '#';
    }
}

function setText(element, value, prefix = '') {
    if (!element) return;
    const text = cleanText(value);
    if (!text) return;
    element.textContent = prefix + text;
}

function setSocialLink(footer, label, value) {
    const link = footer.querySelector(`.social-icons-premium a[aria-label="${label}"]`);
    if (!link) return;

    const href = safeURL(value);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = href === '#' ? 'none' : '';
}

function applyFooterSettings(data) {
    const footer = document.querySelector('footer#contact, footer');
    if (!footer) return;

    const footerData = normalizedFooterSettings(data);

    const footerColumns = footer.querySelectorAll('.footer-grid > div');
    const brandColumn = footerColumns[0];
    const contactColumn = footerColumns[1];

    setText(brandColumn?.querySelector('h4'), footerData.brandName);
    setText(brandColumn?.querySelector('p'), footerData.tagline);

    const contactLines = contactColumn ? contactColumn.querySelectorAll('p') : [];
    setText(contactLines[0], footerData.address);
    setText(contactLines[1], footerData.email, TEXT.emailPrefix);
    setText(contactLines[2], footerData.phone, TEXT.phonePrefix);

    setText(footer.querySelector('.copyright'), footerData.copyright);
    setSocialLink(footer, 'Instagram', footerData.instagram);
    setSocialLink(footer, 'Facebook', footerData.facebook);
    setSocialLink(footer, 'LINE', footerData.line);
}

async function loadPublicFooterSettings() {
    applyFooterSettings(readCachedFooterSettings() || DEFAULT_FOOTER_SETTINGS);

    try {
        const snap = await getDoc(doc(db, 'site_settings', 'footer'));
        if (snap.exists()) {
            const data = normalizedFooterSettings(snap.data());
            cacheFooterSettings(data);
            applyFooterSettings(data);
        }
    } catch (error) {
        console.warn('Footer settings unavailable:', error);
    }
}

if (document.querySelector('footer#contact, footer')) {
    loadPublicFooterSettings();
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPublicFooterSettings);
} else {
    loadPublicFooterSettings();
}
