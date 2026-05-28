import { BLOG_POSTS, BLOG_POST_BY_SLUG, getBlogUrl } from './blog-data.mjs';

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
    if (candidate && BLOG_POST_BY_SLUG[candidate]) {
        window.location.replace(getBlogUrl(BLOG_POST_BY_SLUG[candidate]));
    }
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

function exposeBlogDataForDebugging() {
    window.EdenCafeBlog = Object.freeze({
        posts: BLOG_POSTS.map(post => ({
            slug: post.slug,
            title: post.title,
            url: getBlogUrl(post),
            category: post.category,
            focusKeyword: post.focusKeyword
        }))
    });
}

document.addEventListener('DOMContentLoaded', () => {
    if (location.pathname.includes('blog-en')) return;
    setupLegacyRedirect();
    setupTocHighlight();
    setupListingFilters();
    exposeBlogDataForDebugging();
});
