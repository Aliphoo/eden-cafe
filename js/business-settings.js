import { db } from './firebase-config.js';
import { cachedPublicJSON } from './public-data-cache.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const BUSINESS_CACHE_KEY = 'business-settings-v1';
const BUSINESS_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_BUSINESS_SETTINGS = {
    brandName: 'Eden Cafe.',
    brandNameEn: 'Eden Cafe.',
    tagline: 'กาแฟพิเศษระดับพรีเมียม ท่ามกลางสวนธรรมชาติและบรรยากาศสงบ พื้นที่พักผ่อนสำหรับการใช้ชีวิตช้า ๆ พร้อมอาหาร เครื่องดื่ม และประสบการณ์ Wellness เพื่อสุขภาพ',
    taglineEn: 'Premium specialty coffee and a calm garden escape in Chiang Rai.',
    description: 'Eden Cafe เป็นคาเฟ่ธรรมชาติและร้านกาแฟพิเศษในตำบลนางแล อำเภอเมืองเชียงราย จังหวัดเชียงราย',
    descriptionEn: 'Eden Cafe is a nature cafe and specialty coffee destination in Nang Lae, Mueang Chiang Rai, Chiang Rai, Thailand.',
    address: '306 หมู่ 7 ตำบลนางแล อำเภอเมืองเชียงราย จังหวัดเชียงราย 57100',
    addressEn: '306 Moo 7, Nang Lae, Mueang Chiang Rai, Chiang Rai 57100',
    streetAddress: '306 Moo 7, Nang Lae',
    addressLocality: 'Mueang Chiang Rai',
    addressRegion: 'Chiang Rai',
    postalCode: '57100',
    addressCountry: 'TH',
    latitude: null,
    longitude: null,
    phone: '0980080383',
    phoneDisplay: '098-008-0383',
    email: 'edencafe.2565@gmail.com',
    websiteUrl: 'https://edencafe.co/',
    googleMapsUrl: 'https://maps.app.goo.gl/BYJNa4mXjVNaLDPy5',
    opens: '09:00',
    closes: '18:00',
    openingHoursText: 'เปิดทุกวัน 09:00-18:00 น.',
    openingHoursTextEn: 'Open daily 09:00-18:00',
    instagram: 'https://www.instagram.com/edencafe_2565?igsh=MTUzdHdnOWQxaG4zaw==',
    facebook: 'https://www.facebook.com/EdenCafeChaingrai',
    line: 'https://page.line.me/811ojjgi?openQrModal=true',
    sameAs: [
        'https://www.instagram.com/edencafe_2565?igsh=MTUzdHdnOWQxaG4zaw==',
        'https://www.facebook.com/EdenCafeChaingrai',
        'https://page.line.me/811ojjgi?openQrModal=true',
        'https://maps.app.goo.gl/BYJNa4mXjVNaLDPy5'
    ],
    copyright: '© 2017 Eden Cafe Thailand. สงวนลิขสิทธิ์ | Optimized for SEO, AEO & GEO',
    copyrightEn: '© 2017 Eden Cafe Thailand. All rights reserved | Optimized for SEO, AEO & GEO',
    source: 'public-default'
};

const BAD_TEXT_PATTERNS = [
    /คาเฟ่กรุงเทพ/i,
    /เมืองใหญ่/i,
    /heart of Thailand/i,
    /123\s+Sukhumvit/i,
    /Bangkok\s*10110/i,
    /your-official-page/i,
    /your-official-id/i,
    /อำเมือง/i,
    /\u00e0\u00b8|\u00ef\u00bf\u00bd|\?{4,}/
];

function cleanText(value) {
    return String(value ?? '').trim();
}

function cleanBusinessText(value, fallback = '', maxLength = 500, options = {}) {
    const text = cleanText(value);
    const allowThai = options.allowThai !== false;
    const unsafe = !text
        || BAD_TEXT_PATTERNS.some(pattern => pattern.test(text))
        || (!allowThai && /[\u0e00-\u0e7f]/.test(text));
    return (unsafe ? fallback : text).slice(0, maxLength);
}

function safeURL(value, fallback = '') {
    const url = cleanText(value);
    if (!url) return fallback;
    try {
        const parsed = new URL(url, window.location.origin);
        if (!['https:', 'mailto:', 'tel:'].includes(parsed.protocol)) return fallback;
        return parsed.href;
    } catch (_) {
        return fallback;
    }
}

function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function phoneDisplay(value, fallback = DEFAULT_BUSINESS_SETTINGS.phoneDisplay) {
    const text = cleanText(value);
    if (/^\d{10}$/.test(text)) return text.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    return text || fallback;
}

function isEnglishPage() {
    return document.documentElement.lang?.toLowerCase().startsWith('en')
        || /(?:^|\/)en(?:\.html)?(?:$|[?#/])/.test(window.location.pathname)
        || /-en\.html$/.test(window.location.pathname);
}

function normalizeSameAs(data = {}) {
    const rows = [
        ...(Array.isArray(data.sameAs) ? data.sameAs : [data.sameAs]),
        ...(Array.isArray(data.same_as) ? data.same_as : [data.same_as]),
        data.instagram,
        data.facebook,
        data.line,
        data.googleMapsUrl
    ];
    return Array.from(new Set(rows.map(item => safeURL(item)).filter(Boolean))).slice(0, 12);
}

function normalizeBusinessSettings(data = {}) {
    const fallback = DEFAULT_BUSINESS_SETTINGS;
    const address = cleanBusinessText(data.address || data.addressTh, fallback.address, 500);
    const addressEn = cleanBusinessText(data.addressEn, fallback.addressEn, 500, { allowThai: false });
    const instagram = safeURL(data.instagram || data.socials?.instagram, fallback.instagram);
    const facebook = safeURL(data.facebook || data.socials?.facebook, fallback.facebook);
    const line = safeURL(data.line || data.socials?.line, fallback.line);
    const googleMapsUrl = safeURL(data.googleMapsUrl || data.google_maps_url, fallback.googleMapsUrl);
    const phone = cleanBusinessText(data.phone, fallback.phone, 40, { allowThai: false });

    return {
        brandName: cleanBusinessText(data.brandName || data.name, fallback.brandName, 120),
        brandNameEn: cleanBusinessText(data.brandNameEn || data.nameEn || data.brandName, fallback.brandNameEn, 120, { allowThai: false }),
        tagline: cleanBusinessText(data.tagline || data.taglineTh, fallback.tagline, 320),
        taglineEn: cleanBusinessText(data.taglineEn, fallback.taglineEn, 320, { allowThai: false }),
        description: cleanBusinessText(data.description || data.descriptionTh, fallback.description, 900),
        descriptionEn: cleanBusinessText(data.descriptionEn, fallback.descriptionEn, 900, { allowThai: false }),
        address,
        addressEn,
        streetAddress: cleanBusinessText(data.streetAddress || data.addressStructured?.streetAddress, fallback.streetAddress, 180, { allowThai: false }),
        addressLocality: cleanBusinessText(data.addressLocality || data.addressStructured?.addressLocality, fallback.addressLocality, 120, { allowThai: false }),
        addressRegion: cleanBusinessText(data.addressRegion || data.addressStructured?.addressRegion, fallback.addressRegion, 120, { allowThai: false }),
        postalCode: cleanBusinessText(data.postalCode || data.addressStructured?.postalCode, fallback.postalCode, 20, { allowThai: false }),
        addressCountry: cleanBusinessText(data.addressCountry || data.addressStructured?.addressCountry, fallback.addressCountry, 2, { allowThai: false }).toUpperCase(),
        latitude: numberOrNull(data.latitude ?? data.geo?.latitude),
        longitude: numberOrNull(data.longitude ?? data.geo?.longitude),
        phone,
        phoneDisplay: phoneDisplay(data.phoneDisplay || data.phone, fallback.phoneDisplay),
        email: cleanBusinessText(data.email, fallback.email, 180, { allowThai: false }),
        websiteUrl: safeURL(data.websiteUrl || data.url, fallback.websiteUrl),
        googleMapsUrl,
        opens: cleanBusinessText(data.opens || data.openingHours?.opens, fallback.opens, 5, { allowThai: false }),
        closes: cleanBusinessText(data.closes || data.openingHours?.closes, fallback.closes, 5, { allowThai: false }),
        openingHoursText: cleanBusinessText(data.openingHoursText || data.openingHoursTextTh, fallback.openingHoursText, 160),
        openingHoursTextEn: cleanBusinessText(data.openingHoursTextEn, fallback.openingHoursTextEn, 160, { allowThai: false }),
        instagram,
        facebook,
        line,
        sameAs: normalizeSameAs({ ...data, instagram, facebook, line, googleMapsUrl }),
        copyright: cleanBusinessText(data.copyright || data.copyrightTh, fallback.copyright, 220),
        copyrightEn: cleanBusinessText(data.copyrightEn, fallback.copyrightEn, 220, { allowThai: false }),
        source: cleanBusinessText(data.source, fallback.source, 80, { allowThai: false })
    };
}

async function readSiteSettingsDoc(docId) {
    const snap = await getDoc(doc(db, 'site_settings', docId));
    return snap.exists() ? snap.data() : null;
}

function legacyBusinessFromFooter(footer = {}, index = {}) {
    return normalizeBusinessSettings({
        ...DEFAULT_BUSINESS_SETTINGS,
        brandName: footer.brandName,
        brandNameEn: footer.brandNameEn || footer.brandName,
        tagline: footer.tagline,
        taglineEn: footer.taglineEn,
        description: index.aboutBodyTh || footer.tagline,
        descriptionEn: index.aboutBodyEn || footer.taglineEn,
        address: footer.address,
        addressEn: footer.addressEn,
        phone: footer.phone,
        phoneDisplay: footer.phoneDisplay || footer.phone,
        email: footer.email,
        instagram: footer.instagram,
        facebook: footer.facebook,
        line: footer.line,
        copyright: footer.copyright,
        copyrightEn: footer.copyrightEn,
        source: 'legacy-site_settings-footer'
    });
}

async function fetchPublicBusinessSettings() {
    const business = await readSiteSettingsDoc('business');
    if (business) return normalizeBusinessSettings({ ...business, source: business.source || 'site_settings/business' });

    const [footer, index] = await Promise.all([
        readSiteSettingsDoc('footer').catch(() => null),
        readSiteSettingsDoc('index').catch(() => null)
    ]);
    if (footer || index) return legacyBusinessFromFooter(footer || {}, index || {});
    return normalizeBusinessSettings(DEFAULT_BUSINESS_SETTINGS);
}

export function defaultBusinessSettings() {
    return normalizeBusinessSettings(DEFAULT_BUSINESS_SETTINGS);
}

export async function loadPublicBusinessSettings(options = {}) {
    try {
        if (options.force) return await fetchPublicBusinessSettings();
        return await cachedPublicJSON(BUSINESS_CACHE_KEY, fetchPublicBusinessSettings, { ttlMs: BUSINESS_CACHE_TTL_MS });
    } catch (_) {
        return defaultBusinessSettings();
    }
}

function localizedBusiness(business = defaultBusinessSettings()) {
    const en = isEnglishPage();
    return {
        brandName: en ? business.brandNameEn : business.brandName,
        tagline: en ? business.taglineEn : business.tagline,
        address: en ? business.addressEn : business.address,
        emailLabel: en ? 'Email' : 'อีเมล',
        phoneLabel: en ? 'Tel' : 'โทร',
        hours: en ? business.openingHoursTextEn : business.openingHoursText,
        contactHeading: en ? 'Contact & Location' : 'ติดต่อและสถานที่ตั้ง',
        copyright: en ? business.copyrightEn : business.copyright
    };
}

function setText(element, value) {
    if (!element || !cleanText(value)) return;
    element.textContent = value;
}

function setLink(element, href) {
    if (!element) return;
    const url = safeURL(href);
    if (!url) {
        element.style.display = 'none';
        return;
    }
    element.href = url;
    element.target = '_blank';
    element.rel = 'noopener noreferrer';
    element.style.display = '';
}

function setSocialLink(footer, label, href) {
    setLink(footer.querySelector(`.social-icons-premium a[aria-label="${label}"]`), href);
}

function updateContactColumn(contactColumn, business, copy) {
    if (!contactColumn) return;
    const heading = contactColumn.querySelector('h4') || document.createElement('h4');
    if (!heading.parentNode) contactColumn.prepend(heading);
    heading.textContent = copy.contactHeading;

    const rows = Array.from(contactColumn.querySelectorAll('p'));
    while (rows.length < 4) {
        const row = document.createElement('p');
        contactColumn.appendChild(row);
        rows.push(row);
    }
    rows[0].textContent = copy.address;
    rows[1].textContent = `${copy.emailLabel}: ${business.email}`;
    rows[2].textContent = `${copy.phoneLabel}: ${business.phoneDisplay || business.phone}`;
    rows[3].textContent = copy.hours;
}

function updateMapsLinks(footer, business) {
    footer.querySelectorAll('a[href*="maps.app.goo.gl"], a[href*="google.com/maps"]').forEach(link => {
        setLink(link, business.googleMapsUrl);
    });
}

export function applyBusinessFooterSettings(settings = defaultBusinessSettings()) {
    const business = normalizeBusinessSettings(settings);
    const copy = localizedBusiness(business);
    const footer = document.querySelector('footer#contact, footer');
    if (!footer) return;

    const footerColumns = footer.querySelectorAll('.footer-grid > div');
    const brandColumn = footerColumns[0];
    const contactColumn = footerColumns[1];

    setText(brandColumn?.querySelector('h4'), copy.brandName);
    setText(brandColumn?.querySelector('p'), copy.tagline);
    updateContactColumn(contactColumn, business, copy);
    setText(footer.querySelector('.copyright'), copy.copyright);

    setSocialLink(footer, 'Instagram', business.instagram);
    setSocialLink(footer, 'Facebook', business.facebook);
    setSocialLink(footer, 'LINE', business.line);
    updateMapsLinks(footer, business);

    footer.dataset.businessSettingsSource = business.source || 'unknown';
}
