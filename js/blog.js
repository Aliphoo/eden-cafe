import { db } from './firebase-config.js';
import { collection, doc, getDoc, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const FALLBACK_IMAGE = 'Images/Logo.webp';

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeImageURL(value, fallback = FALLBACK_IMAGE) {
    const url = String(value ?? '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (/^(Images|Hero|js)\//i.test(url)) return url;
    return fallback;
}

function safeLinkURL(value) {
    const url = String(value ?? '').trim();
    if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
    if (/^\//.test(url)) return url;
    return '#';
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatDate(value) {
    const millis = toMillis(value);
    if (!millis) return 'ไม่ทราบวันที่';
    return new Intl.DateTimeFormat('th-TH', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    }).format(new Date(millis));
}

function setMeta(selector, attr, value) {
    const node = document.querySelector(selector);
    if (node) node.setAttribute(attr, value);
}

function upsertBlogJsonLd(blog, title, excerpt) {
    let script = document.getElementById('blog-jsonld');
    if (!script) {
        script = document.createElement('script');
        script.type = 'application/ld+json';
        script.id = 'blog-jsonld';
        document.head.appendChild(script);
    }
    script.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: title,
        description: excerpt,
        image: safeImageURL(blog.imageUrl, 'https://www.edencafe.co/Images/Logo.webp'),
        datePublished: toMillis(blog.createdAt) ? new Date(toMillis(blog.createdAt)).toISOString() : undefined,
        dateModified: toMillis(blog.updatedAt || blog.createdAt) ? new Date(toMillis(blog.updatedAt || blog.createdAt)).toISOString() : undefined,
        author: {
            '@type': 'Organization',
            name: 'Eden Cafe'
        },
        publisher: {
            '@type': 'Organization',
            name: 'Eden Cafe',
            logo: {
                '@type': 'ImageObject',
                url: 'https://www.edencafe.co/Images/Logo.webp'
            }
        }
    });
}

function excerptFrom(blog) {
    const excerpt = String(blog.excerpt || '').trim();
    if (excerpt) return excerpt;
    const textOnly = String(blog.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return textOnly.slice(0, 150);
}

function sanitizeBlogContent(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const blocked = 'script,style,iframe,object,embed,form,input,button,meta,link';
    template.content.querySelectorAll(blocked).forEach(node => node.remove());
    template.content.querySelectorAll('*').forEach(node => {
        [...node.attributes].forEach(attr => {
            const name = attr.name.toLowerCase();
            const value = attr.value || '';
            if (name.startsWith('on') || name === 'style') node.removeAttribute(attr.name);
            if ((name === 'href' || name === 'src') && safeLinkURL(value) === '#') node.removeAttribute(attr.name);
            if (name === 'target') node.setAttribute('rel', 'noopener noreferrer');
        });
    });
    return template.innerHTML;
}

async function getPublishedBlogs() {
    const snapshot = await getDocs(collection(db, 'blogs'));
    return snapshot.docs
        .map(item => ({ id: item.id, ...item.data() }))
        .filter(blog => String(blog.status || '').toLowerCase() === 'published')
        .sort((a, b) => toMillis(b.createdAt || b.updatedAt) - toMillis(a.createdAt || a.updatedAt));
}

function renderBlogList(blogs) {
    const grid = document.querySelector('.blog-listing .grid');
    if (!grid) return;

    if (!blogs.length) {
        grid.innerHTML = `
            <div class="blog-card" style="grid-column: 1 / -1; text-align:center; padding: 40px;">
                <div class="blog-card-content">
                    <h3>ยังไม่มีบทความที่เผยแพร่</h3>
                    <p>บทความจาก Eden Cafe จะปรากฏที่นี่เมื่อเผยแพร่จากหลังบ้าน</p>
                </div>
            </div>
        `;
        return;
    }

    grid.classList.remove('blog-list-loading');
    grid.innerHTML = blogs.map(blog => `
        <article class="blog-card">
            <img loading="lazy" src="${safeImageURL(blog.imageUrl)}" alt="${escapeHTML(blog.title || 'Eden Cafe Blog')}" class="blog-card-img">
            <div class="blog-card-content">
                <span class="blog-meta">${escapeHTML(formatDate(blog.createdAt || blog.updatedAt))} • ${escapeHTML(blog.category || 'บทความ')}</span>
                <h3>${escapeHTML(blog.title || 'บทความ Eden Cafe')}</h3>
                <p>${escapeHTML(excerptFrom(blog))}</p>
                <a href="/blog-post?id=${encodeURIComponent(blog.id)}" class="btn">อ่านเพิ่มเติม</a>
            </div>
        </article>
    `).join('');
}

async function loadBlogList() {
    const grid = document.querySelector('.blog-listing .grid');
    if (!grid) return;
    try {
        renderBlogList(await getPublishedBlogs());
    } catch (error) {
        console.error('Blog list load failed:', error);
        grid.classList.remove('blog-list-loading');
        grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#c62828;">โหลดบทความไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>';
    }
}

async function loadBlogPost() {
    const main = document.querySelector('main.blog-post');
    if (!main) return;

    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
        main.classList.remove('blog-post-loading');
        main.innerHTML = '<div class="container"><h1>เลือกบทความที่ต้องการอ่าน</h1><p>กรุณากลับไปหน้า Blog แล้วเลือกบทความจากรายการล่าสุด</p><a href="/blog" class="btn">กลับไปหน้าบทความ</a></div>';
        return;
    }

    try {
        const snap = await getDoc(doc(db, 'blogs', id));
        if (!snap.exists()) {
            main.classList.remove('blog-post-loading');
            main.innerHTML = '<div class="container"><h1>ไม่พบบทความ</h1><p>บทความนี้อาจถูกลบหรือยังไม่ได้เผยแพร่</p><a href="/blog" class="btn">กลับไปหน้าบทความ</a></div>';
            return;
        }

        const blog = { id: snap.id, ...snap.data() };
        if (String(blog.status || '').toLowerCase() !== 'published') {
            main.classList.remove('blog-post-loading');
            main.innerHTML = '<div class="container"><h1>บทความยังไม่เผยแพร่</h1><p>กรุณากลับไปเลือกบทความอื่น</p><a href="/blog" class="btn">กลับไปหน้าบทความ</a></div>';
            return;
        }

        const title = blog.title || 'บทความ Eden Cafe';
        const excerpt = excerptFrom(blog);
        document.title = `${title} | Eden Cafe Blog`;
        setMeta('meta[name="description"]', 'content', excerpt);
        setMeta('meta[property="og:type"]', 'content', 'article');
        setMeta('meta[property="og:url"]', 'content', window.location.href);
        setMeta('meta[property="og:title"]', 'content', title);
        setMeta('meta[property="og:description"]', 'content', excerpt);
        setMeta('meta[property="og:image"]', 'content', safeImageURL(blog.imageUrl, 'https://www.edencafe.co/Images/Logo.webp'));
        upsertBlogJsonLd(blog, title, excerpt);

        main.classList.remove('blog-post-loading');
        main.innerHTML = `
            <div class="container">
                <div class="blog-header">
                    <span class="blog-meta">หมวดหมู่: ${escapeHTML(blog.category || 'บทความ')} | อัปเดตเมื่อ: ${escapeHTML(formatDate(blog.updatedAt || blog.createdAt))}</span>
                    <h1>${escapeHTML(title)}</h1>
                    ${excerpt ? `<p style="font-size: 1.2rem;">${escapeHTML(excerpt)}</p>` : ''}
                </div>
                <img loading="lazy" src="${safeImageURL(blog.imageUrl)}" alt="${escapeHTML(title)}" class="blog-post-img">
                <article class="blog-content">${sanitizeBlogContent(blog.content || `<p>${escapeHTML(excerpt)}</p>`)}</article>
                <div style="margin-top: 40px;">
                    <a href="/blog" class="btn">กลับไปหน้าบทความ</a>
                </div>
            </div>
        `;
    } catch (error) {
        console.error('Blog post load failed:', error);
        main.classList.remove('blog-post-loading');
        main.innerHTML = '<div class="container"><h1>โหลดบทความไม่สำเร็จ</h1><p>กรุณาลองใหม่อีกครั้ง</p><a href="/blog" class="btn">กลับไปหน้าบทความ</a></div>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadBlogList();
    loadBlogPost();
});
