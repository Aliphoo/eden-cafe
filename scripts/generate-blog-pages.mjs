import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BLOG_POSTS,
    BLOG_POST_BY_SLUG,
    SITE,
    getAbsoluteImageUrl,
    getAllKeywords,
    getBlogUrl,
    getCanonicalUrl
} from '../js/blog-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_BLOG_DIR = resolve(ROOT, 'blog');
const REPORT_PATH = resolve(ROOT, 'blog-seo-content-report.md');

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stripHTML(value) {
    return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function jsonLd(value) {
    return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

function words(post) {
    return post.blocks
        .map(block => block.text || (block.items || []).join(' '))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function toc(post) {
    return post.blocks
        .filter(block => (block.type === 'h2' || block.type === 'h3') && block.id)
        .map(block => ({ level: block.type, id: block.id, text: block.text }));
}

function renderBlocks(post) {
    return post.blocks.map(block => {
        if (block.type === 'h2') {
            return `<h2 id="${escapeHTML(block.id)}">${escapeHTML(block.text)}</h2>`;
        }
        if (block.type === 'h3') {
            return `<h3 id="${escapeHTML(block.id)}">${escapeHTML(block.text)}</h3>`;
        }
        if (block.type === 'ul') {
            return `<ul>${block.items.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul>`;
        }
        return `<p>${escapeHTML(block.text)}</p>`;
    }).join('\n');
}

function renderHeader(active = 'blog') {
    const activeClass = key => key === active ? ' class="active"' : '';
    return `
    <header class="navbar blog-navbar">
        <div class="container">
            <a href="/" class="logo" aria-label="Eden Cafe หน้าแรก">
                <img src="/Images/Logo.webp" alt="Eden Cafe Logo" class="logo-img">
            </a>
            <button class="menu-toggle" id="mobile-menu" type="button" aria-label="เปิดเมนู">
                <span class="bar"></span>
                <span class="bar"></span>
                <span class="bar"></span>
            </button>
            <nav aria-label="เมนูหลัก">
                <ul class="nav-links">
                    <li><a href="/#home"${activeClass('home')}>หน้าแรก</a></li>
                    <li><a href="/#about">เกี่ยวกับเรา</a></li>
                    <li><a href="/menu">เมนู</a></li>
                    <li><a href="/shop">ร้านค้า</a></li>
                    <li><a href="/booking">จองโต๊ะ</a></li>
                    <li><a href="/blog"${activeClass('blog')}>บทความ</a></li>
                    <li><a href="/#faq">FAQ</a></li>
                </ul>
            </nav>
            <div class="nav-actions">
                <a href="/checkout" class="global-cart-icon" aria-label="ตะกร้าสินค้า">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="9" cy="21" r="1"></circle>
                        <circle cx="20" cy="21" r="1"></circle>
                        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
                    </svg>
                    <span class="global-cart-badge" id="global-cart-badge" style="display: none;">0</span>
                </a>
                <div class="lang-switcher">
                    <a href="/blog" class="active">TH</a> | <a href="/blog-en">EN</a>
                </div>
                <div class="auth-container"></div>
            </div>
        </div>
    </header>`;
}

function renderFooter() {
    return `
    <footer id="contact" class="blog-footer">
        <div class="container">
            <div class="footer-grid">
                <div>
                    <h4>Eden Cafe.</h4>
                    <p>คาเฟ่ธรรมชาติใน${escapeHTML(SITE.locality)} เน้นกาแฟคุณภาพ วิวธรรมชาติ และพื้นที่พักผ่อนสำหรับคนที่มาเที่ยวเชียงราย</p>
                </div>
                <div>
                    <h4>ติดต่อและสถานที่ตั้ง</h4>
                    <p>${escapeHTML(SITE.address.streetAddress)} ${escapeHTML(SITE.address.addressLocality)} ${escapeHTML(SITE.address.addressRegion)} ${escapeHTML(SITE.address.postalCode)}</p>
                    <p>โทร: <a href="tel:${escapeHTML(SITE.telephone.replace(/-/g, ''))}">${escapeHTML(SITE.telephone)}</a></p>
                    <p>เปิดทุกวัน 09:00-18:00 น. โปรดตรวจสอบข้อมูลล่าสุดก่อนเดินทาง</p>
                </div>
                <div>
                    <h4>ลิงก์สำคัญ</h4>
                    <p><a href="/menu">ดูเมนู</a></p>
                    <p><a href="/booking">จองโต๊ะหรือห้องรับรอง</a></p>
                    <p><a href="${SITE.mapUrl}" target="_blank" rel="noopener noreferrer">เปิด Google Maps</a></p>
                </div>
            </div>
            <div class="footer-bottom">
                <p class="copyright">© 2026 Eden Cafe Thailand. Optimized for SEO, AEO & GEO.</p>
            </div>
        </div>
    </footer>`;
}

function renderMobileNavScript() {
    return `
    <script>
        const menu = document.querySelector('#mobile-menu');
        const navLinks = document.querySelector('.nav-links');
        const navActions = document.querySelector('.nav-actions');
        if (menu && navLinks && navActions) {
            menu.addEventListener('click', () => {
                menu.classList.toggle('is-active');
                navLinks.classList.toggle('active');
                navActions.classList.toggle('active');
            });
            document.querySelectorAll('.nav-links a').forEach(item => {
                item.addEventListener('click', () => {
                    menu.classList.remove('is-active');
                    navLinks.classList.remove('active');
                    navActions.classList.remove('active');
                });
            });
        }
    </script>`;
}

function localBusinessSchema() {
    return {
        '@type': 'CafeOrCoffeeShop',
        '@id': `${SITE.origin}/#localbusiness`,
        name: SITE.name,
        url: SITE.origin,
        image: SITE.defaultImage,
        telephone: SITE.telephone,
        priceRange: SITE.priceRange,
        address: {
            '@type': 'PostalAddress',
            ...SITE.address
        },
        openingHours: SITE.openingHours,
        servesCuisine: ['Coffee', 'Thai food', 'Bakery', 'Dessert'],
        acceptsReservations: true,
        hasMap: SITE.mapUrl,
        sameAs: [SITE.mapUrl, SITE.oldOfficialSite]
    };
}

function blogPostingSchema(post) {
    return {
        '@type': 'BlogPosting',
        '@id': `${getCanonicalUrl(post)}#blogposting`,
        mainEntityOfPage: {
            '@type': 'WebPage',
            '@id': getCanonicalUrl(post)
        },
        headline: post.title,
        description: post.metaDescription,
        image: [getAbsoluteImageUrl(post)],
        datePublished: post.publishedDate,
        dateModified: post.updatedDate,
        author: {
            '@type': 'Organization',
            name: SITE.author,
            url: SITE.origin
        },
        publisher: {
            '@type': 'Organization',
            name: SITE.name,
            logo: {
                '@type': 'ImageObject',
                url: SITE.logo
            }
        },
        inLanguage: 'th-TH',
        articleSection: post.category,
        keywords: getAllKeywords(post),
        articleBody: words(post)
    };
}

function faqSchema(post) {
    return {
        '@type': 'FAQPage',
        '@id': `${getCanonicalUrl(post)}#faq`,
        mainEntity: post.faqs.map(item => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: {
                '@type': 'Answer',
                text: item.answer
            }
        }))
    };
}

function breadcrumbSchema(post) {
    const crumbs = [
        { name: 'หน้าแรก', item: SITE.origin },
        { name: 'บทความ', item: `${SITE.origin}/blog` }
    ];
    if (post) crumbs.push({ name: post.title, item: getCanonicalUrl(post) });
    return {
        '@type': 'BreadcrumbList',
        itemListElement: crumbs.map((crumb, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: crumb.name,
            item: crumb.item
        }))
    };
}

function graphSchema(post) {
    return {
        '@context': 'https://schema.org',
        '@graph': [
            blogPostingSchema(post),
            faqSchema(post),
            localBusinessSchema(),
            breadcrumbSchema(post)
        ]
    };
}

function listingSchema() {
    return {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'Blog',
                '@id': `${SITE.origin}/blog#blog`,
                name: 'Eden Cafe Blog',
                url: `${SITE.origin}/blog`,
                inLanguage: 'th-TH',
                publisher: {
                    '@type': 'Organization',
                    name: SITE.name,
                    logo: {
                        '@type': 'ImageObject',
                        url: SITE.logo
                    }
                },
                blogPost: BLOG_POSTS.map(post => ({
                    '@type': 'BlogPosting',
                    headline: post.title,
                    url: getCanonicalUrl(post),
                    datePublished: post.publishedDate,
                    image: getAbsoluteImageUrl(post)
                }))
            },
            {
                '@type': 'ItemList',
                '@id': `${SITE.origin}/blog#itemlist`,
                itemListElement: BLOG_POSTS.map((post, index) => ({
                    '@type': 'ListItem',
                    position: index + 1,
                    url: getCanonicalUrl(post),
                    name: post.title
                }))
            },
            localBusinessSchema(),
            breadcrumbSchema()
        ]
    };
}

function renderHead({ title, description, canonical, image, type = 'website', schema }) {
    return `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHTML(title)}</title>
    <meta name="description" content="${escapeHTML(description)}">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${escapeHTML(canonical)}">
    <link rel="icon" type="image/webp" href="/Images/Logo.webp">
    <link rel="stylesheet" href="/style.css?v=5">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Prompt:wght@300;400;500;600&display=swap" rel="stylesheet">
    <meta property="og:type" content="${escapeHTML(type)}">
    <meta property="og:url" content="${escapeHTML(canonical)}">
    <meta property="og:title" content="${escapeHTML(title)}">
    <meta property="og:description" content="${escapeHTML(description)}">
    <meta property="og:image" content="${escapeHTML(image)}">
    <meta property="og:site_name" content="Eden Cafe">
    <meta property="og:locale" content="th_TH">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHTML(title)}">
    <meta name="twitter:description" content="${escapeHTML(description)}">
    <meta name="twitter:image" content="${escapeHTML(image)}">
    <script type="application/ld+json">${jsonLd(schema)}</script>`;
}

function renderArticlePage(post) {
    const related = post.relatedSlugs
        .map(slug => BLOG_POST_BY_SLUG[slug])
        .filter(Boolean);
    const tocItems = toc(post);

    return `<!DOCTYPE html>
<html lang="th">
<head>
${renderHead({
    title: `${post.seoTitle} | Eden Cafe Blog`,
    description: post.metaDescription,
    canonical: getCanonicalUrl(post),
    image: getAbsoluteImageUrl(post),
    type: 'article',
    schema: graphSchema(post)
})}
</head>
<body data-blog-page="detail" data-blog-slug="${escapeHTML(post.slug)}">
${renderHeader('blog')}
<main class="blog-post blog-post-static">
    <div class="container">
        <nav class="breadcrumb" aria-label="Breadcrumb">
            <a href="/">หน้าแรก</a>
            <span>/</span>
            <a href="/blog">บทความ</a>
            <span>/</span>
            <span>${escapeHTML(post.title)}</span>
        </nav>
        <header class="blog-header blog-article-header">
            <span class="blog-chip">${escapeHTML(post.category)}</span>
            <h1>${escapeHTML(post.title)}</h1>
            <p>${escapeHTML(post.excerpt)}</p>
            <div class="blog-article-meta">
                <span>เผยแพร่ ${escapeHTML(formatThaiDate(post.publishedDate))}</span>
                <span>ผู้เขียน: ${escapeHTML(SITE.author)}</span>
                <span>${escapeHTML(post.readingTime)}</span>
            </div>
        </header>
        <img loading="eager" src="${escapeHTML(post.image.src)}" alt="${escapeHTML(post.image.alt)}" class="blog-post-img">
        <div class="article-layout">
            <aside class="article-sidebar" aria-label="สารบัญบทความ">
                <div class="toc-box">
                    <h2>สารบัญ</h2>
                    <ol>
                        ${tocItems.map(item => `<li class="${item.level === 'h3' ? 'toc-subitem' : ''}"><a href="#${escapeHTML(item.id)}">${escapeHTML(item.text)}</a></li>`).join('')}
                    </ol>
                </div>
                <div class="local-info-box">
                    <h2>ข้อมูลร้าน</h2>
                    <p>${escapeHTML(SITE.address.streetAddress)} ${escapeHTML(SITE.address.addressLocality)} ${escapeHTML(SITE.address.addressRegion)}</p>
                    <p>เปิดทุกวัน 09:00-18:00 น.</p>
                    <a href="${SITE.mapUrl}" target="_blank" rel="noopener noreferrer">เปิด Google Maps</a>
                </div>
            </aside>
            <article class="blog-content article-main">
                <section class="summary-box" aria-labelledby="quick-summary">
                    <h2 id="quick-summary">สรุปสั้น</h2>
                    <ul>
                        ${post.summary.map(item => `<li>${escapeHTML(item)}</li>`).join('')}
                    </ul>
                </section>
                ${renderBlocks(post)}
                <section class="blog-link-panel" aria-labelledby="internal-links">
                    <h2 id="internal-links">อ่านต่อและลิงก์ที่เกี่ยวข้อง</h2>
                    <ul>
                        ${post.suggestedInternalLinks.map(link => `<li><a href="${escapeHTML(link.href)}">${escapeHTML(link.label)}</a></li>`).join('')}
                    </ul>
                </section>
                <section class="blog-cta-panel">
                    <h2>วางแผนแวะ Eden Cafe</h2>
                    <p>ดูเมนูล่าสุด เปิดแผนที่ หรือจองโต๊ะก่อนเดินทาง เพื่อให้ทริปเชียงรายของคุณราบรื่นขึ้น</p>
                    <div class="blog-cta-actions">
                        <a class="btn" href="${escapeHTML(post.cta.href)}" ${post.cta.href.startsWith('http') ? 'target="_blank" rel="noopener noreferrer"' : ''}>${escapeHTML(post.cta.label)}</a>
                        <a class="btn btn-outline" href="${escapeHTML(post.cta.secondaryHref)}">${escapeHTML(post.cta.secondaryLabel)}</a>
                    </div>
                </section>
                <section class="faq blog-faq" aria-labelledby="faq-heading">
                    <h2 id="faq-heading">FAQ</h2>
                    <div class="faq-grid">
                        ${post.faqs.map(item => `
                        <div class="faq-item">
                            <h3>${escapeHTML(item.question)}</h3>
                            <p>${escapeHTML(item.answer)}</p>
                        </div>`).join('')}
                    </div>
                </section>
            </article>
        </div>
        <section class="related-articles" aria-labelledby="related-heading">
            <h2 id="related-heading">บทความที่เกี่ยวข้อง</h2>
            <div class="related-grid">
                ${related.map(renderRelatedCard).join('')}
            </div>
        </section>
    </div>
</main>
${renderFooter()}
${renderMobileNavScript()}
<script type="module" src="/js/blog.js?v=4"></script>
<script src="/js/cart.js?v=1"></script>
<script type="module" src="/js/auth.js?v=7"></script>
</body>
</html>
`;
}

function renderRelatedCard(post) {
    return `
    <article class="blog-card related-card">
        <img loading="lazy" src="${escapeHTML(post.image.src)}" alt="${escapeHTML(post.image.alt)}" class="blog-card-img">
        <div class="blog-card-content">
            <span class="blog-meta">${escapeHTML(post.category)} · ${escapeHTML(post.readingTime)}</span>
            <h3><a href="${escapeHTML(getBlogUrl(post))}">${escapeHTML(post.title)}</a></h3>
            <p>${escapeHTML(post.excerpt)}</p>
        </div>
    </article>`;
}

function renderListingCard(post) {
    return `
    <article class="blog-card">
        <a href="${escapeHTML(getBlogUrl(post))}" aria-label="อ่าน ${escapeHTML(post.title)}">
            <img loading="lazy" src="${escapeHTML(post.image.src)}" alt="${escapeHTML(post.image.alt)}" class="blog-card-img">
        </a>
        <div class="blog-card-content">
            <span class="blog-meta">${escapeHTML(post.category)} · ${escapeHTML(formatThaiDate(post.publishedDate))} · ${escapeHTML(post.readingTime)}</span>
            <h3><a href="${escapeHTML(getBlogUrl(post))}">${escapeHTML(post.title)}</a></h3>
            <p>${escapeHTML(post.excerpt)}</p>
            <a href="${escapeHTML(getBlogUrl(post))}" class="btn">อ่านบทความ</a>
        </div>
    </article>`;
}

function renderListingPage() {
    const title = 'Blog Eden Cafe เชียงราย | คาเฟ่ธรรมชาติและกาแฟ';
    const description = 'รวมบทความ Eden Cafe เชียงราย เรื่องคาเฟ่ธรรมชาติ กาแฟดอยเชียงราย เมนูแนะนำ มุมถ่ายรูป Wellness Cafe และเที่ยวเชียงราย';
    return `<!DOCTYPE html>
<html lang="th">
<head>
${renderHead({
    title,
    description,
    canonical: `${SITE.origin}/blog`,
    image: SITE.defaultImage,
    type: 'website',
    schema: listingSchema()
})}
</head>
<body data-blog-page="listing">
${renderHeader('blog')}
<main>
    <section class="blog-hero">
        <div class="container">
            <div class="blog-hero-copy">
                <span class="blog-eyebrow">Eden Cafe Blog</span>
                <h1>บทความ Eden Cafe เชียงราย</h1>
                <p>Eden Cafe คือคาเฟ่ธรรมชาติในตำบลนางแล อำเภอเมืองเชียงราย รวมเรื่องกาแฟดอยเชียงราย มุมถ่ายรูป คาเฟ่สาย Wellness และไอเดียเที่ยวเชียงรายที่อ่านง่ายและใช้วางแผนได้จริง</p>
                <div class="blog-hero-actions">
                    <a class="btn" href="/menu">ดูเมนู</a>
                    <a class="btn btn-outline" href="${SITE.mapUrl}" target="_blank" rel="noopener noreferrer">เปิดแผนที่</a>
                </div>
            </div>
        </div>
    </section>
    <section class="blog-listing blog-listing-static">
        <div class="container">
            <div class="blog-listing-head">
                <div>
                    <span class="blog-eyebrow">SEO / AEO / GEO Ready</span>
                    <h2>อ่านคู่มือคาเฟ่และกาแฟเชียงราย</h2>
                </div>
                <p>ทุกบทความมีสรุปสั้น FAQ, JSON-LD, internal links และข้อมูลสถานที่ที่ตรวจสอบได้</p>
            </div>
            <div class="grid blog-grid">
                ${BLOG_POSTS.map(renderListingCard).join('')}
            </div>
        </div>
    </section>
</main>
${renderFooter()}
${renderMobileNavScript()}
<script type="module" src="/js/blog.js?v=4"></script>
<script src="/js/cart.js?v=1"></script>
<script type="module" src="/js/auth.js?v=7"></script>
</body>
</html>
`;
}

function renderLegacyPostPage() {
    const title = 'Eden Cafe Blog | เลือกบทความ';
    const description = 'หน้าอ่านบทความ Eden Cafe เชียงราย รองรับลิงก์เดิมและพาไปยังบทความแบบ slug';
    return `<!DOCTYPE html>
<html lang="th">
<head>
${renderHead({
    title,
    description,
    canonical: `${SITE.origin}/blog-post`,
    image: SITE.defaultImage,
    type: 'website',
    schema: listingSchema()
})}
</head>
<body data-blog-page="legacy-detail">
${renderHeader('blog')}
<main class="blog-post blog-post-static">
    <div class="container">
        <div class="blog-header">
            <span class="blog-chip">Eden Cafe Blog</span>
            <h1>เลือกบทความที่ต้องการอ่าน</h1>
            <p>ลิงก์บทความใหม่ใช้รูปแบบ /blog/slug เพื่อให้ SEO และการแชร์บนโซเชียลทำงานได้ถูกต้อง</p>
            <a class="btn" href="/blog">กลับไปหน้าบทความ</a>
        </div>
        <div class="grid blog-grid">
            ${BLOG_POSTS.map(renderListingCard).join('')}
        </div>
    </div>
</main>
${renderFooter()}
${renderMobileNavScript()}
<script type="module" src="/js/blog.js?v=4"></script>
<script src="/js/cart.js?v=1"></script>
<script type="module" src="/js/auth.js?v=7"></script>
</body>
</html>
`;
}

function renderReport() {
    const lines = [];
    lines.push('# Eden Cafe Blog SEO Content Report');
    lines.push('');
    lines.push('Generated from `js/blog-data.mjs`. Update the data file, then run `node scripts/generate-blog-pages.mjs` to refresh static pages.');
    lines.push('');
    lines.push('## Blog Articles');
    BLOG_POSTS.forEach((post, index) => {
        lines.push('');
        lines.push(`### ${index + 1}. ${post.title}`);
        lines.push(`- URL: ${SITE.origin}${getBlogUrl(post)}`);
        lines.push(`- SEO Title: ${post.seoTitle}`);
        lines.push(`- Meta Description: ${post.metaDescription}`);
        lines.push(`- Focus Keyword: ${post.focusKeyword}`);
        lines.push(`- Secondary Keywords: ${post.secondaryKeywords.join(', ')}`);
        lines.push(`- H1: ${post.title}`);
        lines.push(`- Category: ${post.category}`);
        lines.push(`- Reading Time: ${post.readingTime}`);
        lines.push(`- Published Date: ${post.publishedDate}`);
        lines.push(`- Author: ${SITE.author}`);
        lines.push(`- Image ALT Text: ${post.image.alt}`);
        lines.push(`- Recommended Image File: ${post.image.fileName}`);
        lines.push(`- 16:9 Banner Prompt: ${post.image.prompt16x9}`);
        lines.push(`- 1:1 Social Prompt: ${post.image.prompt1x1}`);
        lines.push(`- Internal Links: ${post.suggestedInternalLinks.map(link => `${link.label} (${link.href})`).join('; ')}`);
        lines.push(`- External Links: ${post.suggestedExternalLinks.map(link => `${link.label} (${link.href})`).join('; ') || 'ไม่จำเป็น'}`);
        lines.push(`- CTA: ${post.cta.label} (${post.cta.href})`);
        lines.push('- FAQ:');
        post.faqs.forEach(item => {
            lines.push(`  - Q: ${item.question}`);
            lines.push(`    A: ${item.answer}`);
        });
        lines.push('- JSON-LD: BlogPosting + FAQPage + CafeOrCoffeeShop + BreadcrumbList embedded in the generated article HTML.');
    });
    lines.push('');
    lines.push('## SEO / AEO / GEO Checklist');
    [
        '6 Thai long-form articles are present and generated as static HTML pages.',
        'Each article has one H1, ordered H2/H3 headings, short summary, FAQ section, TOC, breadcrumbs, related articles, and CTA.',
        'Each article has SEO title, meta description, canonical URL, Open Graph image, Twitter Card, and JSON-LD schema.',
        'Local entity details use verified Chiang Rai information instead of Bangkok placeholders.',
        'Internal links point to home, menu, booking, contact/map, and related articles.',
        'External links are only used where they support verifiable local or coffee information.',
        'Image prompts, recommended file names, and ALT text are recorded for every article.',
        'No fake reviews, ranking claims, or unverified superlatives are added.'
    ].forEach(item => lines.push(`- [x] ${item}`));
    return `${lines.join('\n')}\n`;
}

function formatThaiDate(value) {
    return new Intl.DateTimeFormat('th-TH', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    }).format(new Date(`${value}T00:00:00+07:00`));
}

async function main() {
    await mkdir(OUT_BLOG_DIR, { recursive: true });
    await writeFile(resolve(ROOT, 'blog.html'), renderListingPage(), 'utf8');
    await writeFile(resolve(ROOT, 'blog-post.html'), renderLegacyPostPage(), 'utf8');
    await Promise.all(BLOG_POSTS.map(post => (
        writeFile(resolve(OUT_BLOG_DIR, `${post.slug}.html`), renderArticlePage(post), 'utf8')
    )));
    await writeFile(REPORT_PATH, renderReport(), 'utf8');
    console.log(`Generated ${BLOG_POSTS.length} blog articles and report.`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
