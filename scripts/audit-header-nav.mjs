import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'eden-pos-apk']);

const TH_LABELS = ['หน้าแรก', 'เกี่ยวกับเรา', 'เมนู', 'ร้านค้า', 'ระบบจอง', 'ยิงธนู', 'บทความ (Blog)', 'คำถามที่พบบ่อย'];
const EN_LABELS = ['Home', 'About', 'Menu', 'Shop', 'Booking', 'Archery', 'Blog', 'FAQ'];

const TH_HREFS = {
    'เมนู': '/menu',
    'ร้านค้า': '/shop',
    'ระบบจอง': '/booking',
    'ยิงธนู': '/archery/',
    'บทความ (Blog)': '/blog',
    'คำถามที่พบบ่อย': '/faq'
};

const EN_HREFS = {
    Menu: '/menu-en',
    Shop: '/shop-en',
    Booking: '/booking-en',
    Archery: '/archery-en',
    Blog: '/blog-en',
    FAQ: '/en#faq'
};

const ARCHERY_ROUTES = new Set([
    'archery.html',
    'archery-en.html',
    'archery/index.html',
    'archery/booking.html',
    'archery/booking/index.html',
    'archery/booking/confirm.html',
    'archery/booking-en.html'
]);

const BOOKING_ROUTES = new Set(['booking.html', 'booking-en.html']);

const issues = [];
const checked = [];

function addIssue(relPath, message) {
    issues.push(`${relPath}: ${message}`);
}

function walk(dir, files = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!EXCLUDED_DIRS.has(entry.name)) walk(fullPath, files);
        } else if (entry.isFile() && extname(entry.name) === '.html') {
            files.push(fullPath);
        }
    }
    return files;
}

function normalizeRel(fullPath) {
    return relative(ROOT, fullPath).replace(/\\/g, '/');
}

function textOnly(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function attrs(html) {
    const result = {};
    html.replace(/\s([a-zA-Z:-]+)="([^"]*)"/g, (_, key, value) => {
        result[key] = value;
        return '';
    });
    return result;
}

function extractElement(html, startIndex, tagName) {
    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tagPattern.lastIndex = startIndex;
    let depth = 0;
    let start = -1;
    for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
        const token = match[0];
        if (!token.startsWith('</')) {
            if (depth === 0) start = match.index;
            depth += 1;
        } else {
            depth -= 1;
            if (depth === 0) return html.slice(start, tagPattern.lastIndex);
        }
    }
    return '';
}

function topLevelLis(ulHtml) {
    const body = ulHtml.replace(/^<ul\b[^>]*>/i, '').replace(/<\/ul>\s*$/i, '');
    const liPattern = /<\/?li\b[^>]*>/gi;
    const result = [];
    let depth = 0;
    let start = -1;
    for (let match = liPattern.exec(body); match; match = liPattern.exec(body)) {
        const token = match[0];
        if (!token.startsWith('</')) {
            if (depth === 0) start = match.index;
            depth += 1;
        } else {
            depth -= 1;
            if (depth === 0 && start >= 0) result.push(body.slice(start, liPattern.lastIndex));
        }
    }
    return result;
}

function firstAnchor(liHtml) {
    const match = liHtml.match(/<a\b[^>]*>[\s\S]*?<\/a>/i);
    if (!match) return null;
    const openingTag = match[0].match(/^<a\b[^>]*>/i)?.[0] || '';
    const attr = attrs(openingTag);
    return {
        href: attr.href || '',
        className: attr.class || '',
        label: textOnly(match[0])
    };
}

function isEnglish(relPath, labels) {
    return labels.includes('Booking') || relPath === 'en.html' || relPath.endsWith('-en.html');
}

function validateNav(relPath, html) {
    const navStart = html.search(/<ul class="nav-links"/);
    if (navStart < 0) return;

    const navHtml = extractElement(html, navStart, 'ul');
    const items = topLevelLis(navHtml).map(firstAnchor).filter(Boolean);
    const labels = items.map(item => item.label);
    const english = isEnglish(relPath, labels);
    const expectedLabels = english ? EN_LABELS : TH_LABELS;
    const expectedHrefs = english ? EN_HREFS : TH_HREFS;

    checked.push(relPath);

    if (labels.join(' | ') !== expectedLabels.join(' | ')) {
        addIssue(relPath, `nav labels/order mismatch: ${labels.join(' | ')}`);
    }

    for (const [label, href] of Object.entries(expectedHrefs)) {
        const item = items.find(candidate => candidate.label === label);
        if (!item) {
            addIssue(relPath, `missing top-level ${label}`);
        } else if (item.href !== href) {
            addIssue(relPath, `${label} href should be ${href}, found ${item.href}`);
        }
    }

    const dropdownStart = navHtml.search(/<ul class="nav-dropdown-menu"/);
    const dropdownHtml = dropdownStart >= 0 ? extractElement(navHtml, dropdownStart, 'ul') : '';
    if (/archery/i.test(dropdownHtml)) {
        addIssue(relPath, 'Archery link is still inside booking dropdown');
    }

    const expectedDropdownHrefs = english
        ? ['/booking-en?type=room', '/booking-en?type=table']
        : ['/booking?type=room', '/booking?type=table'];
    for (const href of expectedDropdownHrefs) {
        if (!dropdownHtml.includes(`href="${href}"`)) addIssue(relPath, `booking dropdown missing ${href}`);
    }

    const archeryItem = items.find(item => item.label === (english ? 'Archery' : 'ยิงธนู'));
    const bookingItem = items.find(item => item.label === (english ? 'Booking' : 'ระบบจอง'));
    const archeryActive = /\bactive\b/.test(archeryItem?.className || '');
    const bookingActive = /\bactive\b/.test(bookingItem?.className || '');

    if (ARCHERY_ROUTES.has(relPath) && !archeryActive) {
        addIssue(relPath, 'Archery route should mark top-level Archery active');
    }
    if (ARCHERY_ROUTES.has(relPath) && bookingActive) {
        addIssue(relPath, 'Archery route should not mark Booking active');
    }
    if (BOOKING_ROUTES.has(relPath) && !bookingActive) {
        addIssue(relPath, 'Booking route should mark Booking active');
    }
}

for (const fullPath of walk(ROOT)) {
    const relPath = normalizeRel(fullPath);
    const html = readFileSync(fullPath, 'utf8');
    validateNav(relPath, html);
}

const generatorPath = join(ROOT, 'scripts', 'generate-blog-pages.mjs');
if (!existsSync(generatorPath)) {
    addIssue('scripts/generate-blog-pages.mjs', 'missing blog generator');
} else {
    const generator = readFileSync(generatorPath, 'utf8');
    if (!generator.includes('<li><a href="/archery/">ยิงธนู</a></li>')) {
        addIssue('scripts/generate-blog-pages.mjs', 'blog generator is missing top-level Archery nav item');
    }
    if (/<li><a href="\/archery\/booking">ยิงธนู<\/a><\/li>/.test(generator)) {
        addIssue('scripts/generate-blog-pages.mjs', 'blog generator still places Archery in booking dropdown');
    }
}

if (issues.length) {
    console.error(`Header nav audit failed with ${issues.length} issue(s):`);
    for (const issue of issues) console.error(`- ${issue}`);
    process.exit(1);
}

console.log(`Header nav audit passed for ${checked.length} HTML file(s).`);
