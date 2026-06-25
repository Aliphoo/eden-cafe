import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE_ORIGIN = 'https://edencafe.co';
const THIS_SCRIPT = 'scripts/audit-static-site.mjs';

const SOURCE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.ts', '.tsx', '.json', '.css']);
const EXCLUDED_DIRS = new Set([
    '.git',
    '.github',
    '.codex',
    '.codex-remote-attachments',
    '.agents',
    'node_modules',
    'backups',
    'reports',
    'canonical-html-fix-package',
    'og-jsonld-host-fix-package',
    'htaccess-www-to-apex-package',
    'firebase-default-hosting-minimal',
    'eden-pos-apk'
]);

const HIGH_RISK_PATTERNS = [
    { label: 'Bangkok cafe keyword', pattern: /คาเฟ่กรุงเทพ/i },
    { label: 'old city tagline', pattern: /เมืองใหญ่/i },
    { label: 'old English hero location', pattern: /heart of Thailand/i },
    { label: 'old Thai hero location', pattern: /ใจกลางเมือง/i },
    { label: 'address typo placeholder', pattern: /อำเมือง/i },
    { label: 'Bangkok street placeholder', pattern: /123\s+Sukhumvit/i },
    { label: 'Bangkok postal placeholder', pattern: /Bangkok\s*10110/i },
    { label: 'Bangkok latitude placeholder', pattern: /13\.7563/ },
    { label: 'Bangkok longitude placeholder', pattern: /100\.5018/ },
    { label: 'old opening time', pattern: /07:30/ },
    { label: 'footer review loading placeholder', pattern: /Updating\.\.\./i },
    { label: 'menu loading-only fallback', pattern: />\s*(?:กำลังโหลดเมนู|Loading menu)\.\.\.\s*</i },
    { label: 'booking room loading-only fallback', pattern: />\s*(?:กำลังโหลดข้อมูลห้อง|Loading rooms)\.\.\.\s*</i },
    { label: 'visitor stats loading placeholder', pattern: /Updating stats|กำลังอัปเดตสถิติ|&#3585;&#3635;&#3621;&#3633;&#3591;&#3629;&#3633;&#3611;/i },
    { label: 'fake official page placeholder', pattern: /your-official-page/i },
    { label: 'fake official id placeholder', pattern: /your-official-id/i },
    { label: 'example.com data placeholder', pattern: /example\.com/i },
    { label: 'fake member email placeholder', pattern: /member@example/i },
    { label: 'fake manager email placeholder', pattern: /manager@example/i },
    { label: 'bare Instagram URL placeholder', pattern: /https:\/\/instagram\.com\b/i },
    { label: 'bare Facebook URL placeholder', pattern: /https:\/\/facebook\.com\b/i },
    { label: 'bare LINE URL placeholder', pattern: /https:\/\/line\.me\b/i },
    { label: 'sample product fallback copy', pattern: /Showing sample|sample products|สินค้าตัวอย่าง/i },
    { label: 'sample menu fallback copy', pattern: /sample menu|เมนูตัวอย่าง/i },
    { label: 'fallback product/menu copy', pattern: /fallback products|fallback menu/i },
    { label: 'stock image placeholder', pattern: /https:\/\/images\.unsplash\.com/i }
];

const PUBLIC_ROUTES = [
    ['index.html', `${SITE_ORIGIN}/`],
    ['en.html', `${SITE_ORIGIN}/en`],
    ['menu.html', `${SITE_ORIGIN}/menu`],
    ['menu-en.html', `${SITE_ORIGIN}/menu-en`],
    ['shop.html', `${SITE_ORIGIN}/shop`],
    ['shop-en.html', `${SITE_ORIGIN}/shop-en`],
    ['booking.html', `${SITE_ORIGIN}/booking`],
    ['booking-en.html', `${SITE_ORIGIN}/booking-en`],
    ['faq.html', `${SITE_ORIGIN}/faq`],
    ['blog.html', `${SITE_ORIGIN}/blog`],
    ['blog/index.html', `${SITE_ORIGIN}/blog`],
    ['blog-en.html', `${SITE_ORIGIN}/blog-en`],
    ['archery.html', `${SITE_ORIGIN}/archery`],
    ['archery/index.html', `${SITE_ORIGIN}/archery`],
    ['archery-en.html', `${SITE_ORIGIN}/archery-en`]
];

const PRIVATE_ROUTES = [
    'checkout.html',
    'checkout-en.html',
    'profile.html',
    'profile-en.html',
    'login.html',
    'register.html',
    'admin.html',
    'pos.html',
    'pos-apk.html',
    'archery/booking.html',
    'archery/booking-en.html',
    'archery/booking/index.html',
    'archery/booking/confirm.html'
];

const FOOTER_ROUTES = [
    'index.html',
    'en.html',
    'menu.html',
    'menu-en.html',
    'shop.html',
    'shop-en.html',
    'booking.html',
    'booking-en.html',
    'checkout.html',
    'checkout-en.html',
    'faq.html',
    'profile.html',
    'profile-en.html',
    'blog.html',
    'blog/index.html',
    'blog-post.html',
    'blog-en.html',
    'blog/eden-cafe-chiang-rai-nature-cafe.html',
    'blog/eden-cafe-coffee-menu.html',
    'blog/chiang-rai-mountain-coffee.html',
    'blog/chiang-rai-wellness-cafe.html',
    'blog/eden-cafe-photo-spots.html',
    'blog/chiang-rai-one-day-trip-cafe-nature.html',
    'archery.html',
    'archery-en.html',
    'archery/index.html',
    'archery/booking.html',
    'archery/booking-en.html',
    'archery/booking/index.html',
    'archery/booking/confirm.html'
];

const CENTRAL_FOOTER_TAGLINE_PATTERNS = [
    /กาแฟพิเศษระดับพรีเมียม/,
    /Premium specialty coffee and a calm garden escape in Chiang Rai\./
];
const CENTRAL_FOOTER_CONTACT_PATTERNS = [
    /306 หมู่ 7 ตำบลนางแล อำเภอเมืองเชียงราย จังหวัดเชียงราย 57100/,
    /306 Moo 7, Nang Lae, Mueang Chiang Rai, Chiang Rai 57100/
];
const FOOTER_EMAIL_PATTERN = /edencafe\.2565@gmail\.com/i;
const FOOTER_PHONE_PATTERN = /098-?008-?0383/;
const LEGACY_BLOG_FOOTER_PATTERN = /คาเฟ่ธรรมชาติในตำบลนางแล[\s\S]{0,220}เน้นกาแฟคุณภาพ[\s\S]{0,220}คนที่มาเที่ยวเชียงราย/;
const COPYRIGHT_ONLY_FOOTER_PATTERN = /<footer\b[^>]*>\s*<div class=["']container["']>\s*<p class=["']copyright["'][\s\S]*?<\/p>\s*<\/div>\s*<\/footer>/i;
const ENGLISH_REVIEW_FALLBACK_ROUTES = new Set([
    'en.html',
    'menu-en.html',
    'shop-en.html',
    'booking-en.html',
    'checkout-en.html',
    'profile-en.html',
    'blog-en.html'
]);

const issues = [];
const stats = {
    filesScanned: 0,
    htmlFiles: 0,
    jsonLdScripts: 0
};

function normalizePath(value) {
    return value.replace(/\\/g, '/');
}

function repoPath(...parts) {
    return join(ROOT, ...parts);
}

function toRepoRelative(file) {
    return normalizePath(relative(ROOT, file));
}

function readRepoFile(relPath) {
    return readFileSync(repoPath(relPath), 'utf8');
}

function addIssue(file, message) {
    issues.push({ file: normalizePath(file), message });
}

function shouldSkipMatch(relPath, line, label) {
    if (relPath === THIS_SCRIPT) return true;
    if (relPath === 'js/business-settings.js') {
        return /BAD_TEXT_PATTERNS|your-official-page|your-official-id|คาเฟ่กรุงเทพ|เมืองใหญ่|heart of Thailand|อำเมือง/.test(line);
    }
    if (relPath === 'js/admin.js') {
        return /badCopy|normalizeLegacyBusinessAddress|Business Info contains old placeholder|Old 07:30|Bangkok placeholder coordinates|your-official-page|your-official-id|คาเฟ่กรุงเทพ|เมืองใหญ่|heart of Thailand|อำเมือง|13\.7563|100\.5018|07:30/.test(line);
    }
    if (relPath === 'scripts/migrate-business-settings.mjs') {
        return /banned|normalizeLegacyAddress|Refusing to migrate placeholder|your-official-page|your-official-id|อำเมือง|13\.7563|100\.5018|07:30/.test(line);
    }
    return false;
}

function walkFiles(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!EXCLUDED_DIRS.has(entry.name)) walkFiles(join(dir, entry.name), out);
            continue;
        }
        if (!entry.isFile()) continue;
        const file = join(dir, entry.name);
        if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(file);
    }
    return out;
}

function scanPlaceholders(files) {
    for (const file of files) {
        const relPath = toRepoRelative(file);
        const text = readFileSync(file, 'utf8');
        stats.filesScanned += 1;
        text.split(/\r?\n/).forEach((line, index) => {
            for (const { label, pattern } of HIGH_RISK_PATTERNS) {
                if (!pattern.test(line)) continue;
                pattern.lastIndex = 0;
                if (shouldSkipMatch(relPath, line, label)) continue;
                addIssue(`${relPath}:${index + 1}`, `${label}: ${line.trim().slice(0, 220)}`);
            }
        });
    }
}

function extractJsonLdScripts(html) {
    const scripts = [];
    const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = re.exec(html))) scripts.push(match[1].trim());
    return scripts;
}

function findLocalBusinessNodes(value, out = []) {
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value)) {
        value.forEach(item => findLocalBusinessNodes(item, out));
        return out;
    }
    if (value['@type'] === 'CafeOrCoffeeShop' || value['@type'] === 'LocalBusiness') out.push(value);
    for (const nested of Object.values(value)) findLocalBusinessNodes(nested, out);
    return out;
}

function openingSpecs(node) {
    const spec = node.openingHoursSpecification;
    if (!spec) return [];
    return Array.isArray(spec) ? spec : [spec];
}

function validateJsonLd(files) {
    for (const file of files.filter(file => file.endsWith('.html'))) {
        const relPath = toRepoRelative(file);
        const html = readFileSync(file, 'utf8');
        stats.htmlFiles += 1;
        for (const script of extractJsonLdScripts(html)) {
            stats.jsonLdScripts += 1;
            let parsed;
            try {
                parsed = JSON.parse(script);
            } catch (error) {
                addIssue(relPath, `Invalid JSON-LD: ${error.message}`);
                continue;
            }
            for (const business of findLocalBusinessNodes(parsed)) {
                const geo = business.geo || {};
                if (String(geo.latitude) === '13.7563' || String(geo.longitude) === '100.5018') {
                    addIssue(relPath, 'LocalBusiness schema still contains Bangkok placeholder coordinates.');
                }
                if (openingSpecs(business).some(item => item?.opens === '07:30')) {
                    addIssue(relPath, 'LocalBusiness schema still contains old 07:30 opening time.');
                }
                if (business.address && business.address.addressRegion && !/Chiang Rai|เชียงราย/i.test(String(business.address.addressRegion))) {
                    addIssue(relPath, `Unexpected LocalBusiness addressRegion: ${business.address.addressRegion}`);
                }
            }
        }
    }
}

function hasMeta(html, nameOrProperty, valuePattern) {
    const escaped = nameOrProperty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<meta\\s+(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
    const value = html.match(re)?.[1] || '';
    return valuePattern ? valuePattern.test(value) : Boolean(value);
}

function extractFooter(html) {
    return html.match(/<footer\b[\s\S]*?<\/footer>/i)?.[0] || '';
}

function hasAnyPattern(value, patterns) {
    return patterns.some(pattern => pattern.test(value));
}

function validateFooterContract(relPath, html) {
    const footer = extractFooter(html);
    if (!footer) {
        addIssue(relPath, 'Missing raw HTML footer.');
        return;
    }

    if (!/<footer\b[^>]*\bid=["']contact["']/i.test(footer)) {
        addIssue(relPath, 'Footer must expose id="contact" for shared footer behavior.');
    }
    if (!/\bfooter-grid\b/.test(footer)) {
        addIssue(relPath, 'Footer raw HTML must include .footer-grid so business settings can hydrate it.');
    }
    if (!hasAnyPattern(footer, CENTRAL_FOOTER_TAGLINE_PATTERNS)) {
        addIssue(relPath, 'Footer raw HTML is missing the central brand/tagline fallback.');
    }
    if (!hasAnyPattern(footer, CENTRAL_FOOTER_CONTACT_PATTERNS)) {
        addIssue(relPath, 'Footer raw HTML is missing the central address fallback.');
    }
    if (!FOOTER_EMAIL_PATTERN.test(footer)) {
        addIssue(relPath, 'Footer raw HTML is missing the central email fallback.');
    }
    if (!FOOTER_PHONE_PATTERN.test(footer)) {
        addIssue(relPath, 'Footer raw HTML is missing the central phone fallback.');
    }
    if (!/<p\b[^>]*class=["'][^"']*\bcopyright\b/i.test(footer)) {
        addIssue(relPath, 'Footer raw HTML is missing a copyright row.');
    }
    if (/^blog(?:\.html|-post\.html|\/)/.test(relPath) && LEGACY_BLOG_FOOTER_PATTERN.test(footer)) {
        addIssue(relPath, 'Blog footer still uses the old hardcoded nature-cafe footer copy.');
    }
    if (/^archery(?:\.html|-en\.html|\/)/.test(relPath) && COPYRIGHT_ONLY_FOOTER_PATTERN.test(footer)) {
        addIssue(relPath, 'Archery footer is still copyright-only instead of the shared footer contract.');
    }
}

function stripTags(value) {
    return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function validateGoogleReviewFallbackContract(files) {
    for (const file of files.filter(file => file.endsWith('.html'))) {
        const relPath = toRepoRelative(file);
        const html = readFileSync(file, 'utf8');
        const fallbackSpans = [...html.matchAll(/<span\b[^>]*\bid=["']google-rating-count["'][^>]*>([\s\S]*?)<\/span>/gi)];

        for (const match of fallbackSpans) {
            const fallbackText = stripTags(match[1]);
            if (/\b\d[\d,]*\b/.test(fallbackText)) {
                addIssue(relPath, `Google Reviews raw fallback must not hardcode a review count: ${fallbackText}`);
            }
            if (/Updating/i.test(fallbackText)) {
                addIssue(relPath, 'Google Reviews raw fallback must not use an updating placeholder.');
            }
            if (!/Google Maps/i.test(fallbackText)) {
                addIssue(relPath, `Google Reviews raw fallback must name Google Maps: ${fallbackText}`);
            }
            if (ENGLISH_REVIEW_FALLBACK_ROUTES.has(relPath) && !/Google Maps reviews/i.test(fallbackText)) {
                addIssue(relPath, `English Google Reviews raw fallback must be English text: ${fallbackText}`);
            }
        }
    }

    if (!existsSync(repoPath('js/reviews.js'))) {
        addIssue('js/reviews.js', 'Google Reviews runtime loader is missing.');
        return;
    }
    const reviewsJs = readRepoFile('js/reviews.js');
    if (!/documents\/google_reviews\?pageSize=1/.test(reviewsJs)) {
        addIssue('js/reviews.js', 'Google Reviews runtime must read the google_reviews cache collection.');
    }
    if (!/cache:\s*['"]no-store['"]/.test(reviewsJs)) {
        addIssue('js/reviews.js', 'Google Reviews runtime must bypass browser cache for the Firestore cache read.');
    }
    if (!/userRatingsTotal/.test(reviewsJs)) {
        addIssue('js/reviews.js', 'Google Reviews runtime must render userRatingsTotal from Firestore.');
    }
}

function validateRouteContracts() {
    for (const [relPath, canonical] of PUBLIC_ROUTES) {
        if (!existsSync(repoPath(relPath))) {
            addIssue(relPath, 'Required public route file is missing.');
            continue;
        }
        const html = readRepoFile(relPath);
        if (!html.includes(`<link rel="canonical" href="${canonical}">`)) {
            addIssue(relPath, `Canonical must be ${canonical}`);
        }
        if (hasMeta(html, 'robots', /noindex/i)) {
            addIssue(relPath, 'Public route must not be noindex.');
        }
        if (!hasMeta(html, 'og:title')) addIssue(relPath, 'Missing og:title.');
        if (!hasMeta(html, 'og:description')) addIssue(relPath, 'Missing og:description.');
    }

    for (const relPath of PRIVATE_ROUTES) {
        if (!existsSync(repoPath(relPath))) continue;
        const html = readRepoFile(relPath);
        if (!hasMeta(html, 'robots', /noindex/i)) addIssue(relPath, 'Private/transaction route must include noindex robots meta.');
    }

    for (const relPath of FOOTER_ROUTES) {
        if (!existsSync(repoPath(relPath))) {
            addIssue(relPath, 'Expected footer route file is missing.');
            continue;
        }
        const html = readRepoFile(relPath);
        if (!/footer-settings\.js\?v=business-1/.test(html)) {
            addIssue(relPath, 'Missing central footer settings loader.');
        }
        validateFooterContract(relPath, html);
    }
}

function validateEnglishHeroContract() {
    if (!existsSync(repoPath('en.html'))) {
        addIssue('en.html', 'English homepage is missing.');
        return;
    }
    const html = readRepoFile('en.html');
    const heroSubtitle = html.match(/data-index-setting=["']hero-subtitle["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
    if (!/Nang Lae/i.test(heroSubtitle) || !/Chiang Rai/i.test(heroSubtitle)) {
        addIssue('en.html', 'English hero subtitle must mention Nang Lae and Chiang Rai in raw HTML.');
    }
    if (existsSync(repoPath('js/index-settings.js'))) {
        const indexSettings = readRepoFile('js/index-settings.js');
        if (!/heroSubtitleEn:[\s\S]*Nang Lae[\s\S]*Chiang Rai/i.test(indexSettings)) {
            addIssue('js/index-settings.js', 'English hero fallback settings must mention Nang Lae and Chiang Rai.');
        }
    }
}

function validateBusinessSettingsWiring() {
    for (const relPath of ['js/business-settings.js', 'js/footer-settings.js', 'admin.html', 'js/admin.js', 'firestore.rules', 'scripts/migrate-business-settings.mjs']) {
        if (!existsSync(repoPath(relPath))) addIssue(relPath, 'Required business settings file is missing.');
    }
    if (existsSync(repoPath('js/business-settings.js')) && !/readSiteSettingsDoc\(['"]business['"]\)|doc\(db,\s*['"]site_settings['"],\s*['"]business['"]\)/.test(readRepoFile('js/business-settings.js'))) {
        addIssue('js/business-settings.js', 'Public business loader must read site_settings/business.');
    }
    if (existsSync(repoPath('firestore.rules')) && !readRepoFile('firestore.rules').includes("business'")) {
        addIssue('firestore.rules', 'Firestore rules must include site_settings/business access.');
    }
    if (existsSync(repoPath('admin.html')) && !readRepoFile('admin.html').includes('businessSettingsForm')) {
        addIssue('admin.html', 'Admin Business Info form is missing.');
    }
}

const files = walkFiles(ROOT);
scanPlaceholders(files);
validateJsonLd(files);
validateRouteContracts();
validateGoogleReviewFallbackContract(files);
validateBusinessSettingsWiring();
validateEnglishHeroContract();

if (issues.length) {
    console.error('Static site audit failed:');
    for (const issue of issues) {
        console.error(`- ${issue.file}: ${issue.message}`);
    }
    console.error(JSON.stringify({ ok: false, issueCount: issues.length, stats }, null, 2));
    process.exit(1);
}

console.log('Static site audit passed.');
console.log(JSON.stringify({ ok: true, stats }, null, 2));
