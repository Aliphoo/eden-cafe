import { db } from './firebase-config.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const SITE_URL = 'https://www.edencafe.co';
const DEFAULT_IMAGE = '/Hero/Hero.webp';

function text(value = '') {
    return String(value ?? '').trim();
}

function escapeHTML(value = '') {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function slugify(value = '') {
    return text(value)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function plainText(html = '') {
    const div = document.createElement('div');
    div.innerHTML = html;
    return text(div.textContent || div.innerText || '');
}

function countWords(html = '') {
    const value = plainText(html);
    const thaiChars = ((value.match(/[\u0E00-\u0E7F]+/g) || []).join('')).length;
    const latinWords = (value.match(/[A-Za-z0-9]+/g) || []).length;
    return latinWords + Math.ceil(thaiChars / 5);
}

function readingTime(html = '') {
    return Math.max(1, Math.ceil(countWords(html) / 220));
}

function dateValue(value) {
    if (!value) return '';
    if (typeof value?.toDate === 'function') return value.toDate().toISOString();
    return String(value);
}

function formatDate(value) {
    const raw = dateValue(value);
    if (!raw) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function normalizePost(id, data = {}) {
    const title = text(data.title);
    const content = text(data.content || data.body);
    const slug = slugify(data.slug || id || title);
    const categoryName = text(data.category_name || data.categoryName || data.category || 'Blog');
    const tags = Array.isArray(data.tags) ? data.tags.map(text).filter(Boolean) : text(data.tags).split(',').map(text).filter(Boolean);
    return {
        id,
        title,
        slug,
        excerpt: text(data.excerpt || data.seo_description || plainText(content).slice(0, 180)),
        content,
        cover: text(data.cover_image_url || data.coverImageUrl || data.imageUrl || data.og_image_url || DEFAULT_IMAGE),
        coverAlt: text(data.cover_image_alt || data.coverAlt || title),
        coverCaption: text(data.cover_image_caption || data.coverCaption),
        status: text(data.status || 'draft').toLowerCase(),
        categoryId: text(data.category_id || data.categoryId || slugify(categoryName)),
        categoryName,
        tags,
        tagIds: Array.isArray(data.tag_ids) ? data.tag_ids.map(text) : tags.map(slugify),
        authorId: text(data.author_id || data.authorId || 'eden'),
        authorName: text(data.author_name || data.authorName || data.author || 'Eden Cafe'),
        authorBio: text(data.author_bio || data.authorBio),
        seoTitle: text(data.seo_title || data.seoTitle || title),
        seoDescription: text(data.seo_description || data.seoDescription || data.metaDescription || ''),
        canonicalUrl: text(data.canonical_url || data.canonicalUrl),
        ogTitle: text(data.og_title || data.ogTitle || data.seo_title || title),
        ogDescription: text(data.og_description || data.ogDescription || data.seo_description || data.excerpt || ''),
        ogImage: text(data.og_image_url || data.ogImageUrl || data.cover_image_url || data.imageUrl || DEFAULT_IMAGE),
        twitterTitle: text(data.twitter_title || data.twitterTitle || data.og_title || title),
        twitterDescription: text(data.twitter_description || data.twitterDescription || data.og_description || data.excerpt || ''),
        twitterImage: text(data.twitter_image_url || data.twitterImageUrl || data.og_image_url || data.imageUrl || DEFAULT_IMAGE),
        focusKeyword: text(data.focus_keyword || data.focusKeyword),
        schemaType: text(data.schema_type || data.schemaType || 'BlogPosting'),
        faqs: Array.isArray(data.faqs) ? data.faqs : [],
        brandContext: text(data.brand_context || data.brandContext),
        businessContext: text(data.business_context || data.businessContext),
        isFeatured: data.is_featured === true || data.isFeatured === true,
        publishedAt: dateValue(data.published_at || data.publishedAt || data.createdAt || data.created_at),
        updatedAt: dateValue(data.updated_at || data.updatedAt),
        readingTime: Number(data.reading_time || data.readingTime) || readingTime(content),
        wordCount: Number(data.word_count || data.wordCount) || countWords(content)
    };
}

async function loadCollection(name) {
    const snap = await getDocs(collection(db, name));
    return snap.docs.map((item) => ({ id: item.id, ...item.data() }));
}

async function loadBlogData() {
    const [postRows, categoryRows, tagRows] = await Promise.all([
        loadCollection('blogs'),
        loadCollection('blog_categories').catch(() => []),
        loadCollection('blog_tags').catch(() => [])
    ]);
    const posts = postRows.map((item) => normalizePost(item.id, item))
        .filter((post) => post.status === 'published')
        .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
    const categoryMap = new Map();
    categoryRows.forEach((item) => categoryMap.set(item.id, { id: item.id, name: text(item.name), slug: slugify(item.slug || item.id || item.name) }));
    posts.forEach((post) => {
        if (!categoryMap.has(post.categoryId)) categoryMap.set(post.categoryId, { id: post.categoryId, name: post.categoryName, slug: slugify(post.categoryId || post.categoryName) });
    });
    const tagMap = new Map();
    tagRows.forEach((item) => tagMap.set(item.id, { id: item.id, name: text(item.name), slug: slugify(item.slug || item.id || item.name) }));
    posts.forEach((post) => post.tags.forEach((name) => tagMap.set(slugify(name), { id: slugify(name), name, slug: slugify(name) })));
    return { posts, categories: [...categoryMap.values()].filter((item) => item.name), tags: [...tagMap.values()].filter((item) => item.name) };
}

function postUrl(post) {
    return `/blog/${encodeURIComponent(post.slug)}`;
}

function cardHTML(post) {
    return `
        <article class="blog-cms-card">
            <a href="${postUrl(post)}"><img src="${escapeHTML(post.cover)}" alt="${escapeHTML(post.coverAlt || post.title)}" loading="lazy"></a>
            <div class="blog-cms-card-body">
                <div class="blog-cms-meta"><span>${escapeHTML(post.categoryName)}</span><span>${formatDate(post.publishedAt)}</span></div>
                <h2><a href="${postUrl(post)}">${escapeHTML(post.title)}</a></h2>
                <p>${escapeHTML(post.excerpt)}</p>
                <div class="blog-cms-card-foot"><span>${post.readingTime} นาทีอ่าน</span><a href="${postUrl(post)}">อ่านต่อ</a></div>
            </div>
        </article>
    `;
}

function fillSelect(select, rows, label) {
    if (!select) return;
    select.innerHTML = `<option value="all">${label}</option>` + rows.map((row) => `<option value="${escapeHTML(row.id)}">${escapeHTML(row.name)}</option>`).join('');
}

function installPublicStyles() {
    if (document.getElementById('blog-cms-public-style')) return;
    const style = document.createElement('style');
    style.id = 'blog-cms-public-style';
    style.textContent = `
        .blog-cms-public{background:#f6f9f6;color:#17231d}
        .blog-cms-hero{padding:72px 0 34px;background:#fff;border-bottom:1px solid #e4ece6}
        .blog-cms-hero h1{max-width:840px;font-size:clamp(2rem,4vw,4rem);line-height:1.05;margin:10px 0 14px;color:#163522}
        .blog-cms-hero p{max-width:760px;color:#536159;line-height:1.8}
        .blog-cms-searchbar{display:grid;grid-template-columns:minmax(240px,1fr)220px 190px;gap:10px;margin-top:24px}
        .blog-cms-searchbar input,.blog-cms-searchbar select{min-height:46px;border:1px solid #dce7df;border-radius:8px;padding:0 13px;font:inherit;background:#fff}
        .blog-cms-listing{padding:32px 0 70px}
        .blog-cms-state{padding:18px;border:1px solid #dce7df;border-radius:10px;background:#fff;color:#536159;font-weight:700}
        .blog-cms-featured{margin-bottom:20px}
        .blog-cms-featured .blog-cms-card{display:grid;grid-template-columns:minmax(280px,1.05fr)minmax(280px,.95fr);align-items:stretch}
        .blog-cms-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
        .blog-cms-card{overflow:hidden;border:1px solid #dde8df;border-radius:10px;background:#fff;box-shadow:0 12px 28px rgba(24,70,41,.07)}
        .blog-cms-card img{width:100%;aspect-ratio:16/9;object-fit:cover;background:#eaf0eb}
        .blog-cms-card-body{padding:18px;display:grid;gap:11px}
        .blog-cms-card h2{font-size:1.16rem;line-height:1.35;margin:0}.blog-cms-card h2 a{color:#16291d;text-decoration:none}
        .blog-cms-card p{color:#536159;line-height:1.7;margin:0}.blog-cms-meta,.blog-cms-card-foot{display:flex;justify-content:space-between;gap:10px;color:#6d7a72;font-size:.86rem;font-weight:700}
        .blog-cms-meta span:first-child{color:#16633d;background:#e9f6ed;border-radius:999px;padding:4px 10px}
        .blog-cms-card-foot a{color:#16633d;font-weight:800}
        .blog-cms-detail{background:#fff}.blog-cms-detail-header{padding:52px 20px 24px}.blog-cms-detail-inner{max-width:1120px;margin:0 auto;display:grid;grid-template-columns:240px minmax(0,1fr);gap:34px;padding:28px 20px 70px}
        .blog-cms-article{max-width:760px}.blog-cms-article h1{font-size:clamp(2rem,4vw,3.8rem);line-height:1.08;margin:10px 0}.blog-cms-article .lede{font-size:1.08rem;color:#536159;line-height:1.8}
        .blog-cms-cover{max-width:1120px;margin:0 auto;padding:0 20px}.blog-cms-cover img{width:100%;max-height:560px;object-fit:cover;border-radius:14px}
        .blog-cms-prose{font-size:1.02rem;line-height:1.9;color:#25352d}.blog-cms-prose h2,.blog-cms-prose h3{color:#173522;margin-top:1.8em}.blog-cms-prose img{max-width:100%;border-radius:12px}.blog-cms-prose blockquote{border-left:4px solid #4caf50;padding-left:16px;color:#536159}
        .blog-cms-toc{position:sticky;top:18px;border:1px solid #dce7df;border-radius:10px;background:#fbfffb;padding:14px}.blog-cms-toc a{display:block;color:#375044;text-decoration:none;margin:8px 0;font-size:.92rem}
        .blog-cms-faq,.blog-cms-author,.blog-cms-cta{border:1px solid #dce7df;border-radius:10px;background:#fbfffb;padding:18px;margin-top:24px}
        .blog-cms-related-wrap{padding:0 20px 70px}
        @media(max-width:920px){.blog-cms-searchbar,.blog-cms-featured .blog-cms-card,.blog-cms-detail-inner{grid-template-columns:1fr}.blog-cms-grid{grid-template-columns:1fr 1fr}.blog-cms-toc{position:static}}
        @media(max-width:640px){.blog-cms-grid{grid-template-columns:1fr}.blog-cms-hero{padding-top:44px}}
    `;
    document.head.appendChild(style);
}

function updateMeta(post) {
    document.title = post.seoTitle || post.title;
    const metaDescription = document.querySelector('meta[name="description"]');
    if (metaDescription) metaDescription.setAttribute('content', post.seoDescription || post.excerpt);
    const canonical = document.querySelector('link[rel="canonical"]') || document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'canonical' }));
    canonical.setAttribute('href', post.canonicalUrl || `${SITE_URL}${postUrl(post)}`);
}

function jsonLdForPost(post) {
    const url = `${SITE_URL}${postUrl(post)}`;
    const graph = [
        {
            '@type': post.schemaType || 'BlogPosting',
            '@id': `${url}#article`,
            headline: post.seoTitle || post.title,
            description: post.seoDescription || post.excerpt,
            image: post.ogImage || post.cover,
            datePublished: post.publishedAt,
            dateModified: post.updatedAt || post.publishedAt,
            author: { '@type': 'Person', name: post.authorName || 'Eden Cafe' },
            mainEntityOfPage: url
        },
        {
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'หน้าแรก', item: SITE_URL },
                { '@type': 'ListItem', position: 2, name: 'บทความ', item: `${SITE_URL}/blog` },
                { '@type': 'ListItem', position: 3, name: post.title, item: url }
            ]
        }
    ];
    if (post.faqs.length) {
        graph.push({ '@type': 'FAQPage', mainEntity: post.faqs.map((faq) => ({ '@type': 'Question', name: text(faq.question), acceptedAnswer: { '@type': 'Answer', text: text(faq.answer) } })) });
    }
    if (post.businessContext) graph.push({ '@type': 'LocalBusiness', name: 'Eden Cafe', description: post.businessContext });
    return { '@context': 'https://schema.org', '@graph': graph };
}

function injectJsonLd(data) {
    document.querySelectorAll('script[data-blog-jsonld]').forEach((item) => item.remove());
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.dataset.blogJsonld = 'true';
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
}

function renderListing(data) {
    const status = document.getElementById('blog-status');
    const grid = document.getElementById('blog-grid');
    const featured = document.getElementById('blog-featured');
    const search = document.getElementById('blog-search-input');
    const category = document.getElementById('blog-category-filter');
    const tag = document.getElementById('blog-tag-filter');
    const params = new URLSearchParams(window.location.search);
    const authorFilter = slugify(params.get('author') || '');
    fillSelect(category, data.categories, 'ทุกหมวดหมู่');
    fillSelect(tag, data.tags, 'ทุก Tags');
    if (category && params.get('category')) category.value = params.get('category');
    if (tag && params.get('tag')) tag.value = params.get('tag');

    function draw() {
        const q = text(search?.value).toLowerCase();
        const categoryId = category?.value || 'all';
        const tagId = tag?.value || 'all';
        const rows = data.posts.filter((post) => {
            const haystack = `${post.title} ${post.excerpt} ${post.categoryName} ${post.tags.join(' ')}`.toLowerCase();
            return (!q || haystack.includes(q))
                && (categoryId === 'all' || post.categoryId === categoryId)
                && (tagId === 'all' || post.tagIds.includes(tagId) || post.tags.map(slugify).includes(tagId))
                && (!authorFilter || slugify(post.authorId) === authorFilter || slugify(post.authorName) === authorFilter);
        });
        if (status) status.style.display = rows.length ? 'none' : 'block';
        if (status) status.textContent = data.posts.length ? 'ไม่พบบทความตามเงื่อนไขนี้' : 'ยังไม่มีบทความ published ในระบบ';
        const featuredPost = rows.find((post) => post.isFeatured) || rows[0];
        if (featured) featured.innerHTML = featuredPost ? cardHTML(featuredPost) : '';
        if (grid) grid.innerHTML = rows.filter((post) => post.id !== featuredPost?.id).map(cardHTML).join('');
    }
    [search, category, tag].forEach((el) => el?.addEventListener('input', draw));
    [category, tag].forEach((el) => el?.addEventListener('change', draw));
    injectJsonLd({
        '@context': 'https://schema.org',
        '@type': 'Blog',
        name: 'Eden Cafe Blog',
        url: `${SITE_URL}/blog`,
        blogPost: data.posts.map((post) => ({ '@type': 'BlogPosting', headline: post.title, url: `${SITE_URL}${postUrl(post)}`, datePublished: post.publishedAt, image: post.cover }))
    });
    draw();
}

function currentSlug() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('slug') || params.get('id');
    if (fromQuery) return slugify(fromQuery);
    const parts = window.location.pathname.replace(/^\/+|\/+$/g, '').split('/');
    return slugify(parts[parts.length - 1] || '');
}

function renderDetail(data) {
    const slug = currentSlug();
    const status = document.getElementById('blog-detail-status');
    const container = document.getElementById('blog-detail');
    const relatedEl = document.getElementById('blog-related');
    const post = data.posts.find((item) => item.slug === slug || item.id === slug);
    if (!post) {
        if (status) status.textContent = 'ไม่พบบทความ หรือบทความยังไม่ได้ Published';
        return;
    }
    if (status) status.style.display = 'none';
    updateMeta(post);
    injectJsonLd(jsonLdForPost(post));
    const headings = [...post.content.matchAll(/<h([23])[^>]*>(.*?)<\/h[23]>/gi)].map((match, index) => ({ id: `section-${index + 1}`, text: plainText(match[2]) }));
    let headingIndex = 0;
    const content = post.content.replace(/<h([23])([^>]*)>(.*?)<\/h[23]>/gi, (full, level, attrs, inner) => {
        const heading = headings[headingIndex++] || { id: `section-${headingIndex}` };
        const cleanAttrs = String(attrs || '').replace(/\sid=(["']).*?\1/i, '');
        return `<h${level} id="${heading.id}"${cleanAttrs}>${inner}</h${level}>`;
    });
    container.innerHTML = `
        <header class="blog-cms-detail-header">
            <div class="container blog-cms-article">
                <a href="/blog" class="blog-read-link">← บทความทั้งหมด</a>
                <div class="blog-cms-meta"><span>${escapeHTML(post.categoryName)}</span><span>${formatDate(post.publishedAt)}</span></div>
                <h1>${escapeHTML(post.title)}</h1>
                <p class="lede">${escapeHTML(post.excerpt)}</p>
                <div class="blog-cms-card-foot"><span>${escapeHTML(post.authorName)}</span><span>${post.readingTime} นาทีอ่าน</span><span>${post.wordCount} words</span></div>
            </div>
        </header>
        <div class="blog-cms-cover"><img src="${escapeHTML(post.cover)}" alt="${escapeHTML(post.coverAlt || post.title)}">${post.coverCaption ? `<p>${escapeHTML(post.coverCaption)}</p>` : ''}</div>
        <div class="blog-cms-detail-inner">
            <aside class="blog-cms-toc">
                <strong>Table of Contents</strong>
                ${headings.length ? headings.map((heading) => `<a href="#${heading.id}">${escapeHTML(heading.text)}</a>`).join('') : '<p>บทความนี้ยังไม่มี H2/H3</p>'}
                <button class="btn btn-outline" type="button" id="blog-share-button">Share</button>
            </aside>
            <div class="blog-cms-article">
                <div class="blog-cms-prose">${content}</div>
                ${post.faqs.length ? `<section class="blog-cms-faq"><h2>FAQ</h2>${post.faqs.map((faq) => `<details><summary>${escapeHTML(faq.question)}</summary><p>${escapeHTML(faq.answer)}</p></details>`).join('')}</section>` : ''}
                <section class="blog-cms-cta"><h2>สนใจมา Eden Cafe?</h2><p>ดูเมนูหรือจองโต๊ะ/กิจกรรมได้จากหน้าเว็บไซต์ของเรา</p><p><a class="btn" href="/menu">ดูเมนู</a> <a class="btn btn-outline" href="/booking">จองบริการ</a></p></section>
                <section class="blog-cms-author"><h2>Author Box</h2><p><strong>${escapeHTML(post.authorName)}</strong></p><p>${escapeHTML(post.authorBio || 'ทีม Eden Cafe เขียนบทความนี้เพื่อแบ่งปันข้อมูลที่ช่วยให้ผู้อ่านวางแผนและตัดสินใจได้ง่ายขึ้น')}</p></section>
            </div>
        </div>
    `;
    document.getElementById('blog-share-button')?.addEventListener('click', async () => {
        const url = window.location.href;
        if (navigator.share) await navigator.share({ title: post.title, url });
        else {
            await navigator.clipboard.writeText(url);
            alert('คัดลอกลิงก์แล้ว');
        }
    });
    const related = data.posts.filter((item) => item.id !== post.id && (item.categoryId === post.categoryId || item.tagIds.some((tag) => post.tagIds.includes(tag)))).slice(0, 3);
    if (relatedEl) relatedEl.innerHTML = related.map(cardHTML).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
    installPublicStyles();
    const page = document.body.dataset.blogPage;
    try {
        const data = await loadBlogData();
        if (page === 'detail') renderDetail(data);
        else renderListing(data);
        window.EdenCafeBlog = Object.freeze({ posts: data.posts });
    } catch (error) {
        const target = page === 'detail' ? document.getElementById('blog-detail-status') : document.getElementById('blog-status');
        if (target) target.textContent = `โหลดบทความไม่สำเร็จ: ${error.message || error}`;
        console.error('Blog CMS public load failed:', error);
    }
});
