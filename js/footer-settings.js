import { db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const TEXT = {
    emailPrefix: '\u0e2d\u0e35\u0e40\u0e21\u0e25: ',
    phonePrefix: '\u0e42\u0e17\u0e23: '
};

function cleanText(value) {
    return String(value ?? '').trim();
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

    const footerColumns = footer.querySelectorAll('.footer-grid > div');
    const brandColumn = footerColumns[0];
    const contactColumn = footerColumns[1];

    setText(brandColumn?.querySelector('h4'), data.brandName);
    setText(brandColumn?.querySelector('p'), data.tagline);

    const contactLines = contactColumn ? contactColumn.querySelectorAll('p') : [];
    setText(contactLines[0], data.address);
    setText(contactLines[1], data.email, TEXT.emailPrefix);
    setText(contactLines[2], data.phone, TEXT.phonePrefix);

    setText(footer.querySelector('.copyright'), data.copyright);
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
