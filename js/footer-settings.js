import { db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const FALLBACK_FOOTER = {
    th: {
        brandName: 'Eden Cafe.',
        tagline: '\u0e01\u0e32\u0e41\u0e1f\u0e1e\u0e34\u0e40\u0e28\u0e29\u0e23\u0e30\u0e14\u0e31\u0e1a\u0e1e\u0e23\u0e35\u0e40\u0e21\u0e35\u0e22\u0e21 \u0e17\u0e48\u0e32\u0e21\u0e01\u0e25\u0e32\u0e07\u0e18\u0e23\u0e23\u0e21\u0e0a\u0e32\u0e15\u0e34\u0e02\u0e2d\u0e07\u0e40\u0e0a\u0e35\u0e22\u0e07\u0e23\u0e32\u0e22',
        address: '306 \u0e2b\u0e21\u0e39\u0e48 7 \u0e15\u0e33\u0e1a\u0e25\u0e19\u0e32\u0e07\u0e41\u0e25 \u0e2d\u0e33\u0e40\u0e20\u0e2d\u0e40\u0e21\u0e37\u0e2d\u0e07\u0e40\u0e0a\u0e35\u0e22\u0e07\u0e23\u0e32\u0e22 \u0e08\u0e31\u0e07\u0e2b\u0e27\u0e31\u0e14\u0e40\u0e0a\u0e35\u0e22\u0e07\u0e23\u0e32\u0e22 57100',
        emailPrefix: '\u0e2d\u0e35\u0e40\u0e21\u0e25: ',
        phonePrefix: '\u0e42\u0e17\u0e23: ',
        copyright: '\u00a9 2026 Eden Cafe Thailand. \u0e2a\u0e07\u0e27\u0e19\u0e25\u0e34\u0e02\u0e2a\u0e34\u0e17\u0e18\u0e34\u0e4c | Optimized for AEO & GEO'
    },
    en: {
        brandName: 'Eden Cafe.',
        tagline: 'Premium specialty coffee and a calm garden escape in Chiang Rai.',
        address: '306 Moo 7, Nang Lae, Mueang Chiang Rai, Chiang Rai 57100',
        emailPrefix: 'Email: ',
        phonePrefix: 'Tel: ',
        copyright: '\u00a9 2026 Eden Cafe Thailand. All rights reserved | Optimized for AEO & GEO'
    },
    email: 'edencafe.2565@gmail.com',
    phone: '098-008-0383'
};

const PLACEHOLDER_PATTERNS = [
    /123\s*(?:\u0e16\u0e19\u0e19)?\s*\u0e2a\u0e38\u0e02\u0e38\u0e21\u0e27\u0e34\u0e17/i,
    /123\s+Sukhumvit/i,
    /\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e\u0e21\u0e2b\u0e32\u0e19\u0e04\u0e23\s*10110/i,
    /Bangkok\s*10110/i,
    /hello@edencafe\.co(?!\.)/i,
    /\+66-?2-?000-?0000/i,
    /0{2,}-0{2,}-0{3,}/,
    /\u00e0\u00b8|\u00ef\u00bf\u00bd|\?{4,}/
];

function cleanText(value) {
    return String(value ?? '').trim();
}

function isEnglishPage() {
    return document.documentElement.lang?.toLowerCase().startsWith('en') || /-en\.html$|\/en(?:$|[?#/])/.test(window.location.pathname);
}

function isUnsafeFooterText(value) {
    const text = cleanText(value);
    return !text || PLACEHOLDER_PATTERNS.some(pattern => pattern.test(text));
}

function hasThaiText(value) {
    return /[\u0e00-\u0e7f]/.test(cleanText(value));
}

function pickFooterValue(data, keys, fallback, options = {}) {
    const { allowThai = true } = options;
    for (const key of keys) {
        const value = cleanText(data?.[key]);
        if (!value || isUnsafeFooterText(value)) continue;
        if (!allowThai && hasThaiText(value)) continue;
        return value;
    }
    return fallback;
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
    if (!footer || !data) return;

    const lang = isEnglishPage() ? 'en' : 'th';
    const fallback = FALLBACK_FOOTER[lang];
    const footerData = {
        brandName: pickFooterValue(data, lang === 'en' ? ['brandNameEn', 'brandName'] : ['brandName'], fallback.brandName),
        tagline: pickFooterValue(data, lang === 'en' ? ['taglineEn'] : ['tagline'], fallback.tagline, { allowThai: lang !== 'en' }),
        address: pickFooterValue(data, lang === 'en' ? ['addressEn'] : ['address'], fallback.address, { allowThai: lang !== 'en' }),
        email: pickFooterValue(data, ['email'], FALLBACK_FOOTER.email, { allowThai: false }),
        phone: pickFooterValue(data, ['phone'], FALLBACK_FOOTER.phone, { allowThai: false }),
        copyright: pickFooterValue(data, lang === 'en' ? ['copyrightEn'] : ['copyright'], fallback.copyright, { allowThai: lang !== 'en' })
    };

    const footerColumns = footer.querySelectorAll('.footer-grid > div');
    const brandColumn = footerColumns[0];
    const contactColumn = footerColumns[1];

    setText(brandColumn?.querySelector('h4'), footerData.brandName);
    setText(brandColumn?.querySelector('p'), footerData.tagline);

    const contactLines = contactColumn ? contactColumn.querySelectorAll('p') : [];
    setText(contactLines[0], footerData.address);
    setText(contactLines[1], footerData.email, fallback.emailPrefix);
    setText(contactLines[2], footerData.phone, fallback.phonePrefix);

    setText(footer.querySelector('.copyright'), footerData.copyright);
    setSocialLink(footer, 'Instagram', data.instagram);
    setSocialLink(footer, 'Facebook', data.facebook);
    setSocialLink(footer, 'LINE', data.line);
}

async function loadPublicFooterSettings() {
    try {
        const snap = await getDoc(doc(db, 'site_settings', 'footer'));
        if (snap.exists()) applyFooterSettings(snap.data());
    } catch (_) {
        // Keep the static footer fallback without exposing service errors to users.
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPublicFooterSettings);
} else {
    loadPublicFooterSettings();
}
