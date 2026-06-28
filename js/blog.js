import { BLOG_POSTS, BLOG_POST_BY_SLUG, SITE, getBlogUrl } from './blog-data.mjs';
import { cachedPublicJSON, snapshotRows } from './public-data-cache.js';

const BLOG_COLLECTION = 'blogs';
const FIRESTORE_MODULE_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
const CMS_LIST_LIMIT = 24;
const PUBLIC_CACHE_TTL_MS = 5 * 60 * 1000;
let cmsPostsPromise = null;
const cmsPostBySlugPromises = new Map();

function normalizeSlug(value) {
    return String(value || '')
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .pop();
}

function setupLegacyRedirect() {
    const params = new URLSearchParams(window.location.search);
    const candidate = normalizeSlug(params.get('slug') || params.get('id'));
    if (candidate && BLOG_POST_BY_SLUG[candidate] && !location.pathname.startsWith('/blog/')) {
        window.location.replace(getBlogUrl(BLOG_POST_BY_SLUG[candidate]));
    }
}

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function text(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    const cleaned = String(value).trim();
    return cleaned || fallback;
}

function arrayOfText(value) {
    if (Array.isArray(value)) return value.map(item => text(item)).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(item => text(item)).filter(Boolean);
    return [];
}

function dateFrom(value) {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoDate(value) {
    const date = dateFrom(value);
    return date ? date.toISOString() : '';
}

function formatThaiDate(value) {
    const date = dateFrom(value);
    if (!date) return '';
    return date.toLocaleDateString('th-TH', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

function absoluteUrl(value) {
    const raw = text(value);
    if (!raw) return SITE.defaultImage;
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${SITE.origin}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function blogUrl(post) {
    return `/blog/${encodeURIComponent(post.slug)}`;
}

function postSortTime(post) {
    return dateFrom(post.publishedAt || post.updatedAt || post.createdAt)?.getTime() || 0;
}

function readingTimeText(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return `${Math.max(1, Math.round(value))} นาที`;
    const raw = text(value);
    if (!raw) return '';
    if (/^\d+$/.test(raw)) return `${raw} นาที`;
    return raw;
}

function normalizeFaqs(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => ({
            question: text(item?.question),
            answer: text(item?.answer)
        }))
        .filter(item => item.question && item.answer);
}

function normalizeCmsPost(id, data = {}) {
    const title = text(data.title);
    const category = text(data.category_name || data.categoryName || data.category || data.category_id || data.categoryId || 'Blog');
    const publishedAt = data.published_at || data.publishedAt || data.publishedDate || data.created_at || data.createdAt || '';
    const updatedAt = data.updated_at || data.updatedAt || data.updatedDate || publishedAt;
    const content = text(data.content || data.body);
    const tags = arrayOfText(data.tags);

    return {
        id,
        source: 'firestore',
        slug: normalizeSlug(data.slug || id),
        title,
        seoTitle: text(data.seo_title || data.seoTitle || title),
        seoDescription: text(data.seo_description || data.seoDescription || data.excerpt || ''),
        excerpt: text(data.excerpt || data.seo_description || data.seoDescription || ''),
        content,
        category,
        categoryId: text(data.category_id || data.categoryId || category),
        tags,
        tagIds: Array.isArray(data.tag_ids) ? data.tag_ids.map(item => text(item)).filter(Boolean) : tags.map(normalizeSlug),
        coverImageUrl: text(data.cover_image_url || data.coverImageUrl || data.imageUrl || data.og_image_url || data.ogImage || SITE.defaultImage),
        coverImageAlt: text(data.cover_image_alt || data.coverAlt || data.imageAlt || title),
        publishedAt,
        updatedAt,
        createdAt: data.created_at || data.createdAt || '',
        readingTime: readingTimeText(data.reading_time || data.readingTime),
        isFeatured: data.is_featured === true || data.isFeatured === true,
        summary: arrayOfText(data.summary),
        faqs: normalizeFaqs(data.faqs),
        canonicalUrl: text(data.canonical_url || data.canonicalUrl),
        authorName: text(data.author_name || data.authorName || data.author || SITE.author),
        cta: data.cta || null
    };
}

function renderStaticBlocks(blocks = []) {
    return blocks.map(block => {
        if (block.type === 'h2' || block.type === 'h3') {
            const id = block.id ? ` id="${escapeHTML(block.id)}"` : '';
            return `<${block.type}${id}>${escapeHTML(block.text)}</${block.type}>`;
        }
        if (block.type === 'ul' && Array.isArray(block.items)) {
            return `<ul>${block.items.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul>`;
        }
        return `<p>${escapeHTML(block.text || '')}</p>`;
    }).join('');
}

function normalizeStaticPost(post) {
    if (!post) return null;
    return {
        id: post.slug,
        source: 'static',
        slug: post.slug,
        title: post.title,
        seoTitle: post.seoTitle || post.title,
        seoDescription: post.metaDescription || post.excerpt || '',
        excerpt: post.excerpt || post.metaDescription || '',
        content: renderStaticBlocks(post.blocks || []),
        category: post.category || 'Blog',
        categoryId: normalizeSlug(post.category || 'blog'),
        tags: [post.focusKeyword, ...(post.secondaryKeywords || [])].filter(Boolean),
        tagIds: [],
        coverImageUrl: post.image?.src || SITE.defaultImage,
        coverImageAlt: post.image?.alt || post.title,
        publishedAt: post.publishedDate,
        updatedAt: post.updatedDate || post.publishedDate,
        createdAt: post.publishedDate,
        readingTime: post.readingTime || '',
        isFeatured: false,
        summary: Array.isArray(post.summary) ? post.summary : [],
        faqs: Array.isArray(post.faqs) ? post.faqs : [],
        canonicalUrl: `${SITE.origin}${getBlogUrl(post)}`,
        authorName: SITE.author,
        cta: post.cta || null
    };
}

function getStaticPosts() {
    return BLOG_POSTS.map(normalizeStaticPost).filter(Boolean);
}

function normalizeCmsRows(rows = []) {
    return rows
        .map(row => {
            const { id, ...data } = row || {};
            return { raw: data, post: normalizeCmsPost(id, data) };
        })
        .filter(({ raw, post }) => String(raw.status || 'draft') === 'published' && post.slug && post.title)
        .map(({ post }) => post)
        .sort((a, b) => postSortTime(b) - postSortTime(a));
}

async function fetchPublishedCmsPosts() {
    if (!cmsPostsPromise) {
        cmsPostsPromise = (async () => {
            const [{ db }, firestore] = await Promise.all([
                import('./firebase-config.js'),
                import(FIRESTORE_MODULE_URL)
            ]);
            const rows = await cachedPublicJSON(`blog:published-list:${CMS_LIST_LIMIT}:v3`, async () => {
                let snapshot;
                try {
                    const q = firestore.query(
                        firestore.collection(db, BLOG_COLLECTION),
                        firestore.where('status', '==', 'published'),
                        firestore.orderBy('published_at', 'desc'),
                        firestore.limit(CMS_LIST_LIMIT)
                    );
                    snapshot = await firestore.getDocs(q);
                } catch (error) {
                    console.warn('Published blog ordered query failed, using limited fallback:', error);
                    const fallbackQuery = firestore.query(
                        firestore.collection(db, BLOG_COLLECTION),
                        firestore.where('status', '==', 'published'),
                        firestore.limit(CMS_LIST_LIMIT)
                    );
                    snapshot = await firestore.getDocs(fallbackQuery);
                }
                return snapshotRows(snapshot);
            }, { ttlMs: PUBLIC_CACHE_TTL_MS });
            return normalizeCmsRows(rows);
        })();
    }
    return cmsPostsPromise;
}

async function fetchPublishedCmsPostBySlug(slug) {
    const normalizedSlug = normalizeSlug(slug);
    if (!normalizedSlug) return null;
    if (!cmsPostBySlugPromises.has(normalizedSlug)) {
        cmsPostBySlugPromises.set(normalizedSlug, (async () => {
            const [{ db }, firestore] = await Promise.all([
                import('./firebase-config.js'),
                import(FIRESTORE_MODULE_URL)
            ]);
            const rows = await cachedPublicJSON(`blog:detail:${normalizedSlug}:v2`, async () => {
                const q = firestore.query(
                    firestore.collection(db, BLOG_COLLECTION),
                    firestore.where('slug', '==', normalizedSlug),
                    firestore.limit(1)
                );
                const snapshot = await firestore.getDocs(q);
                return snapshotRows(snapshot);
            }, { ttlMs: PUBLIC_CACHE_TTL_MS });
            return normalizeCmsRows(rows)[0] || null;
        })());
    }
    return cmsPostBySlugPromises.get(normalizedSlug);
}

function setupTocHighlight() {
    const links = [...document.querySelectorAll('.toc-box a[href^="#"]')];
    if (!links.length || !('IntersectionObserver' in window)) return;

    const byId = links.reduce((acc, link) => {
        const id = decodeURIComponent(link.getAttribute('href').slice(1));
        acc[id] = link;
        return acc;
    }, {});

    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            links.forEach(link => link.classList.remove('active'));
            byId[entry.target.id]?.classList.add('active');
        });
    }, {
        rootMargin: '-20% 0px -70% 0px',
        threshold: 0.01
    });

    Object.keys(byId).forEach(id => {
        const target = document.getElementById(id);
        if (target) observer.observe(target);
    });
}

function setupListingFilters() {
    const grid = document.querySelector('.blog-grid');
    const filters = [...document.querySelectorAll('[data-blog-category]')];
    if (!grid || !filters.length) return;

    filters.forEach(button => {
        button.addEventListener('click', () => {
            const category = button.dataset.blogCategory;
            filters.forEach(item => item.classList.toggle('active', item === button));
            document.querySelectorAll('.blog-card[data-category]').forEach(card => {
                card.hidden = category !== 'all' && card.dataset.category !== category;
            });
        });
    });
}

function exposeBlogDataForDebugging(posts = getStaticPosts(), source = 'static-fallback') {
    window.EdenCafeBlog = Object.freeze({
        source,
        posts: posts.map(post => ({
            slug: post.slug,
            title: post.title,
            url: blogUrl(post),
            category: post.category,
            publishedAt: isoDate(post.publishedAt)
        }))
    });
}

function clearBlogListingPendingState() {
    document.documentElement.classList.remove('blog-listing-pending');
}

function renderListingFilters(posts) {
    const categories = [...new Set(posts.map(post => post.category).filter(Boolean))];
    return `
            <div class="blog-filter-bar" aria-label="กรองบทความตามหมวดหมู่">
                <button type="button" class="active" data-blog-category="all">ทั้งหมด</button>
                ${categories.map(category => `<button type="button" data-blog-category="${escapeHTML(category)}">${escapeHTML(category)}</button>`).join('')}
            </div>`;
}

function renderListingCard(post, index = 0) {
    const dateText = formatThaiDate(post.publishedAt || post.createdAt);
    return `
    <article class="blog-card${index === 0 ? ' blog-card-featured' : ''}" data-category="${escapeHTML(post.category)}">
        <a href="${escapeHTML(blogUrl(post))}" aria-label="อ่าน ${escapeHTML(post.title)}">
            <img loading="lazy" src="${escapeHTML(post.coverImageUrl || SITE.defaultImage)}" alt="${escapeHTML(post.coverImageAlt || post.title)}" class="blog-card-img">
        </a>
        <div class="blog-card-content">
            <div class="blog-card-kicker">
                <span class="blog-category-pill">${escapeHTML(post.category)}</span>
                ${dateText ? `<span>${escapeHTML(dateText)}</span>` : ''}
            </div>
            <h3><a href="${escapeHTML(blogUrl(post))}">${escapeHTML(post.title)}</a></h3>
            <p>${escapeHTML(post.excerpt || post.seoDescription)}</p>
            <div class="blog-card-footer">
                <span>${escapeHTML(post.readingTime || 'อ่านบทความ')}</span>
                <a href="${escapeHTML(blogUrl(post))}" class="blog-read-link">อ่านต่อ</a>
            </div>
        </div>
    </article>`;
}

function renderCmsListing(posts) {
    const grid = document.querySelector('.blog-grid');
    if (!grid || !posts.length) {
        clearBlogListingPendingState();
        return;
    }

    const existingFilter = document.querySelector('.blog-filter-bar');
    if (existingFilter) {
        existingFilter.outerHTML = renderListingFilters(posts);
    } else {
        grid.insertAdjacentHTML('beforebegin', renderListingFilters(posts));
    }

    grid.innerHTML = posts.map(renderListingCard).join('');

    const count = document.querySelector('.blog-quick-grid strong');
    if (count) count.textContent = String(posts.length);
    const label = count?.nextElementSibling;
    if (label) label.textContent = 'บทความเผยแพร่';

    document.body.dataset.blogSource = 'firestore';
    exposeBlogDataForDebugging(posts, 'firestore');
    setupListingFilters();
    clearBlogListingPendingState();
}

function currentRouteSlug() {
    const params = new URLSearchParams(window.location.search);
    const querySlug = normalizeSlug(params.get('slug') || params.get('id'));
    if (querySlug) return querySlug;

    const pathname = window.location.pathname.replace(/\/+$/g, '');
    if (!pathname.startsWith('/blog/')) return '';
    return normalizeSlug(pathname);
}

function slugifyHeading(value) {
    return text(value)
        .toLowerCase()
        .replace(/[^\w\u0E00-\u0E7F]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'section';
}

function sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html || '';
    template.content.querySelectorAll('script, style, iframe, object, embed, form, input, button').forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
        [...node.attributes].forEach(attribute => {
            const name = attribute.name.toLowerCase();
            const value = attribute.value || '';
            if (name.startsWith('on')) node.removeAttribute(attribute.name);
            if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) node.removeAttribute(attribute.name);
        });
        if (node.tagName.toLowerCase() === 'a') {
            node.setAttribute('rel', 'noopener noreferrer');
        }
    });
    return template.innerHTML;
}

function prepareArticleContent(post) {
    const fallback = post.excerpt ? `<p>${escapeHTML(post.excerpt)}</p>` : '';
    const wrapper = document.createElement('article');
    wrapper.innerHTML = sanitizeHtml(post.content || fallback);

    const usedIds = new Set();
    const tocItems = [];
    wrapper.querySelectorAll('h2, h3').forEach((heading, index) => {
        const title = text(heading.textContent);
        let id = text(heading.id) || slugifyHeading(title);
        while (usedIds.has(id)) id = `${id}-${index + 1}`;
        usedIds.add(id);
        heading.id = id;
        if (title) tocItems.push({ id, title, level: heading.tagName.toLowerCase() });
    });

    return { html: wrapper.innerHTML, tocItems };
}

function defaultCta(post) {
    return {
        label: post.cta?.label || 'เปิดแผนที่ Eden Cafe',
        href: post.cta?.href || SITE.mapUrl,
        secondaryLabel: post.cta?.secondaryLabel || 'ดูเมนูทั้งหมด',
        secondaryHref: post.cta?.secondaryHref || '/menu'
    };
}

function relatedPosts(post, posts) {
    const sameTopic = posts
        .filter(item => item.slug !== post.slug)
        .filter(item => item.category === post.category || item.tagIds.some(tag => post.tagIds.includes(tag)) || item.tags.some(tag => post.tags.includes(tag)));
    const rest = posts.filter(item => item.slug !== post.slug && !sameTopic.some(match => match.slug === item.slug));
    return [...sameTopic, ...rest].slice(0, 3);
}

function summaryHTML(post) {
    if (!post.summary?.length) return '';
    return `
                <section class="summary-box" aria-labelledby="quick-summary">
                    <h2 id="quick-summary">สรุปสั้น</h2>
                    <ul>
                        ${post.summary.map(item => `<li>${escapeHTML(item)}</li>`).join('')}
                    </ul>
                </section>`;
}

function faqHTML(post) {
    if (!post.faqs?.length) return '';
    return `
                <section class="faq blog-faq" aria-labelledby="faq-heading">
                    <h2 id="faq-heading">FAQ</h2>
                    <div class="faq-grid">
                        ${post.faqs.map(item => `
                            <div class="faq-item">
                                <button type="button" class="faq-question">${escapeHTML(item.question)}</button>
                                <div class="faq-answer"><p>${escapeHTML(item.answer)}</p></div>
                            </div>`).join('')}
                    </div>
                </section>`;
}

function linkPanelHTML(post, related) {
    const links = [
        { label: 'กลับไปหน้าบทความ', href: '/blog' },
        { label: 'รู้จัก Eden Cafe', href: '/#about' },
        { label: 'ดูเมนู', href: '/menu' },
        { label: 'จองโต๊ะหรือห้องรับรอง', href: '/booking' },
        ...related.map(item => ({ label: item.title, href: blogUrl(item) }))
    ];
    return `
                <section class="blog-link-panel" aria-labelledby="internal-links">
                    <h2 id="internal-links">อ่านต่อและลิงก์ที่เกี่ยวข้อง</h2>
                    <ul>
                        ${links.map(link => `<li><a href="${escapeHTML(link.href)}">${escapeHTML(link.label)}</a></li>`).join('')}
                    </ul>
                </section>`;
}

function tocHTML(items) {
    if (!items.length) return '<p>บทความนี้ไม่มีสารบัญย่อย</p>';
    return `<ol>${items.map(item => `<li class="${item.level === 'h3' ? 'toc-subitem' : ''}"><a href="#${escapeHTML(item.id)}">${escapeHTML(item.title)}</a></li>`).join('')}</ol>`;
}

function clearBlogDetailPendingState() {
    document.documentElement.classList.remove('blog-detail-pending');
}

function renderCmsDetail(post, posts) {
    const main = document.querySelector('main');
    if (!main) return;

    const { html, tocItems } = prepareArticleContent(post);
    const cta = defaultCta(post);
    const related = relatedPosts(post, posts);
    const dateText = formatThaiDate(post.publishedAt || post.createdAt);
    const externalCta = /^https?:\/\//i.test(cta.href) ? ' target="_blank" rel="noopener noreferrer"' : '';

    clearBlogDetailPendingState();
    main.className = 'blog-post blog-post-static';
    main.innerHTML = `
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
            <p>${escapeHTML(post.excerpt || post.seoDescription)}</p>
            <div class="blog-article-meta">
                ${dateText ? `<span>เผยแพร่ ${escapeHTML(dateText)}</span>` : ''}
                <span>ผู้เขียน: ${escapeHTML(post.authorName || SITE.author)}</span>
                ${post.readingTime ? `<span>${escapeHTML(post.readingTime)}</span>` : ''}
            </div>
        </header>
        <img loading="eager" src="${escapeHTML(post.coverImageUrl || SITE.defaultImage)}" alt="${escapeHTML(post.coverImageAlt || post.title)}" class="blog-post-img">
        <div class="article-layout">
            <aside class="article-sidebar" aria-label="สารบัญบทความ">
                <div class="toc-box">
                    <h2>สารบัญ</h2>
                    ${tocHTML(tocItems)}
                </div>
                <div class="toc-box">
                    <h2>วางแผนแวะร้าน</h2>
                    <a href="${escapeHTML(SITE.mapUrl)}" target="_blank" rel="noopener noreferrer">เปิด Google Maps</a>
                </div>
            </aside>
            <article class="blog-content article-main">
                ${summaryHTML(post)}
                ${html}
                ${linkPanelHTML(post, related)}
                <section class="blog-cta-panel">
                    <h2>วางแผนแวะ Eden Cafe</h2>
                    <p>ดูเมนูล่าสุด เปิดแผนที่ หรือจองโต๊ะก่อนเดินทาง เพื่อให้ทริปเชียงรายของคุณราบรื่นขึ้น</p>
                    <div class="blog-cta-actions">
                        <a class="btn" href="${escapeHTML(cta.href)}"${externalCta}>${escapeHTML(cta.label)}</a>
                        <a class="btn btn-outline" href="${escapeHTML(cta.secondaryHref)}">${escapeHTML(cta.secondaryLabel)}</a>
                        <a class="btn btn-outline" href="/#about">รู้จัก Eden Cafe</a>
                    </div>
                </section>
                ${faqHTML(post)}
            </article>
        </div>
    </div>`;

    document.body.dataset.blogPage = post.source === 'firestore' ? 'cms-detail' : 'static-detail-fallback';
    document.body.dataset.blogSource = post.source === 'firestore' ? 'firestore' : 'static-fallback';
    updateHead(post);
    injectJsonLd(post);
    setupTocHighlight();
}

function renderMissingPost(slug, message = 'ไม่พบบทความที่เผยแพร่แล้วสำหรับ URL นี้') {
    const main = document.querySelector('main');
    if (!main) return;
    clearBlogDetailPendingState();
    main.className = 'blog-post blog-post-static';
    main.innerHTML = `
    <div class="container">
        <div class="blog-header">
            <span class="blog-chip">Eden Cafe Blog</span>
            <h1>${escapeHTML(message)}</h1>
            <p>${escapeHTML(slug ? `Slug: ${slug}` : 'โปรดลองกลับไปเลือกบทความจากหน้ารวมบทความ')}</p>
            <a class="btn" href="/blog">กลับไปหน้าบทความ</a>
        </div>
    </div>`;
}

function setMeta(selector, value) {
    const element = document.querySelector(selector);
    if (element) element.setAttribute('content', value);
}

function updateHead(post) {
    const title = `${post.seoTitle || post.title} | Eden Cafe`;
    const description = post.seoDescription || post.excerpt || post.title;
    const url = post.canonicalUrl || `${SITE.origin}${blogUrl(post)}`;
    const image = absoluteUrl(post.coverImageUrl);

    document.title = title;
    setMeta('meta[name="description"]', description);
    setMeta('meta[property="og:title"]', title);
    setMeta('meta[property="og:description"]', description);
    setMeta('meta[property="og:url"]', url);
    setMeta('meta[property="og:image"]', image);
    setMeta('meta[name="twitter:title"]', title);
    setMeta('meta[name="twitter:description"]', description);
    setMeta('meta[name="twitter:image"]', image);

    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.appendChild(canonical);
    }
    canonical.href = url;
}

function injectJsonLd(post) {
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => script.remove());
    const graph = [
        {
            '@type': 'BlogPosting',
            '@id': `${SITE.origin}${blogUrl(post)}#blogposting`,
            headline: post.title,
            description: post.seoDescription || post.excerpt,
            image: absoluteUrl(post.coverImageUrl),
            datePublished: isoDate(post.publishedAt || post.createdAt),
            dateModified: isoDate(post.updatedAt || post.publishedAt || post.createdAt),
            author: { '@type': 'Organization', name: post.authorName || SITE.author },
            publisher: {
                '@type': 'Organization',
                name: SITE.name,
                logo: { '@type': 'ImageObject', url: SITE.logo }
            },
            mainEntityOfPage: `${SITE.origin}${blogUrl(post)}`
        },
        {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'หน้าแรก', item: SITE.origin },
                { '@type': 'ListItem', position: 2, name: 'บทความ', item: `${SITE.origin}/blog` },
                { '@type': 'ListItem', position: 3, name: post.title, item: `${SITE.origin}${blogUrl(post)}` }
            ]
        }
    ];
    if (post.faqs?.length) {
        graph.push({
            '@type': 'FAQPage',
            mainEntity: post.faqs.map(item => ({
                '@type': 'Question',
                name: item.question,
                acceptedAnswer: { '@type': 'Answer', text: item.answer }
            }))
        });
    }

    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.dataset.dynamicBlogJsonld = 'true';
    script.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
    document.head.appendChild(script);
}

async function hydrateCmsListing() {
    try {
        const posts = await fetchPublishedCmsPosts();
        if (posts.length) {
            renderCmsListing(posts);
        } else {
            clearBlogListingPendingState();
        }
    } catch (error) {
        clearBlogListingPendingState();
        throw error;
    }
}

async function hydrateCmsDetail() {
    const slug = currentRouteSlug();
    if (!slug) return;

    const staticPost = normalizeStaticPost(BLOG_POST_BY_SLUG[slug]);
    let cmsPost = null;
    let relatedPool = [];
    try {
        [cmsPost, relatedPool] = await Promise.all([
            fetchPublishedCmsPostBySlug(slug),
            fetchPublishedCmsPosts().catch(() => [])
        ]);
    } catch (error) {
        if (staticPost) {
            renderCmsDetail(staticPost, getStaticPosts());
            return;
        }
        renderMissingPost(slug, `โหลดบทความจากระบบไม่สำเร็จ: ${error.message || error}`);
        return;
    }

    if (cmsPost) {
        const cmsPosts = [cmsPost, ...relatedPool.filter(post => post.slug !== cmsPost.slug)];
        renderCmsDetail(cmsPost, cmsPosts);
        exposeBlogDataForDebugging(cmsPosts, 'firestore');
        return;
    }
    if (staticPost) {
        renderCmsDetail(staticPost, getStaticPosts());
        return;
    }
    renderMissingPost(slug);
}

async function hydratePublicBlogFromCms() {
    const page = document.body?.dataset.blogPage;
    if (page === 'listing') {
        await hydrateCmsListing();
    } else if (page === 'legacy-detail') {
        await hydrateCmsDetail();
    }
}

function initBlogPage() {
    if (location.pathname.includes('blog-en')) return;
    setupLegacyRedirect();
    setupTocHighlight();
    setupListingFilters();
    exposeBlogDataForDebugging();
    hydratePublicBlogFromCms().catch(error => {
        console.warn('Public blog CMS hydration failed:', error);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBlogPage);
} else {
    initBlogPage();
}
