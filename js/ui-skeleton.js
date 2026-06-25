function resolveTarget(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    return target;
}

function skeletonLine(className = '') {
    return `<span class="eden-skeleton-line ${className}" aria-hidden="true"></span>`;
}

function cardSkeleton() {
    return `
        <article class="eden-skeleton-card" aria-hidden="true">
            <span class="eden-skeleton-media"></span>
            <span class="eden-skeleton-pill"></span>
            ${skeletonLine('wide')}
            ${skeletonLine('medium')}
            ${skeletonLine('short')}
            <span class="eden-skeleton-button"></span>
        </article>
    `;
}

function compactCardSkeleton() {
    return `
        <article class="eden-skeleton-card compact" aria-hidden="true">
            <span class="eden-skeleton-pill"></span>
            ${skeletonLine('wide')}
            ${skeletonLine('medium')}
            ${skeletonLine('short')}
        </article>
    `;
}

function tableSkeleton(rows = 5, cols = 4) {
    return Array.from({ length: rows }, () => `
        <tr class="eden-skeleton-row" aria-hidden="true">
            ${Array.from({ length: cols }, () => `<td>${skeletonLine('table-cell')}</td>`).join('')}
        </tr>
    `).join('');
}

function listSkeleton(rows = 4) {
    return `
        <div class="eden-skeleton-list" aria-hidden="true">
            ${Array.from({ length: rows }, () => `
                <div class="eden-skeleton-list-item">
                    <span class="eden-skeleton-avatar"></span>
                    <span>${skeletonLine('wide')}${skeletonLine('medium')}</span>
                </div>
            `).join('')}
        </div>
    `;
}

function formSkeleton(rows = 5) {
    return `
        <div class="eden-skeleton-form" aria-hidden="true">
            ${Array.from({ length: rows }, (_, index) => `
                <span>${skeletonLine(index % 2 ? 'medium' : 'short')}<span class="eden-skeleton-input"></span></span>
            `).join('')}
        </div>
    `;
}

function profileSkeleton() {
    return `
        <div class="eden-skeleton-profile" aria-hidden="true">
            <section class="eden-skeleton-panel">
                <span class="eden-skeleton-avatar large"></span>
                <span>${skeletonLine('wide')}${skeletonLine('medium')}${skeletonLine('short')}</span>
            </section>
            <section class="eden-skeleton-grid stats">${Array.from({ length: 3 }, compactCardSkeleton).join('')}</section>
            <section class="eden-skeleton-panel">${formSkeleton(4)}</section>
            <section class="eden-skeleton-grid cards">${Array.from({ length: 4 }, compactCardSkeleton).join('')}</section>
        </div>
    `;
}

function summarySkeleton(rows = 5) {
    return `
        <div class="eden-skeleton-summary" aria-hidden="true">
            ${Array.from({ length: rows }, () => `
                <span class="eden-skeleton-summary-row">${skeletonLine('short')}${skeletonLine('medium')}</span>
            `).join('')}
        </div>
    `;
}

function gridSkeleton(count = 6, compact = false) {
    return `
        <div class="eden-skeleton-grid cards" aria-hidden="true">
            ${Array.from({ length: count }, compact ? compactCardSkeleton : cardSkeleton).join('')}
        </div>
    `;
}

function skeletonHTML(type, options = {}) {
    const count = Number(options.count || options.rows || 0);
    switch (type) {
        case 'product-grid':
        case 'menu-grid':
            return `
                <div class="eden-skeleton-filter-row" aria-hidden="true">
                    ${Array.from({ length: 4 }, () => '<span class="eden-skeleton-filter"></span>').join('')}
                </div>
                ${gridSkeleton(options.count || 6)}
            `;
        case 'faq-grid':
            return `<div class="eden-skeleton-grid faq">${Array.from({ length: options.count || 3 }, compactCardSkeleton).join('')}</div>`;
        case 'table':
            return tableSkeleton(options.rows || 5, options.cols || 4);
        case 'profile':
            return profileSkeleton();
        case 'summary':
            return summarySkeleton(options.rows || 5);
        case 'form':
            return formSkeleton(options.rows || 5);
        case 'map':
            return `<div class="eden-skeleton-map" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>`;
        case 'review-strip':
            return `<div class="eden-skeleton-grid reviews">${Array.from({ length: options.count || 3 }, compactCardSkeleton).join('')}</div>`;
        case 'counter':
            return '<span class="eden-skeleton-counter" aria-hidden="true"></span>';
        case 'qr':
            return '<div class="eden-skeleton-qr" aria-hidden="true"></div>';
        case 'list':
            return listSkeleton(options.rows || 4);
        case 'stats':
            return `<div class="eden-skeleton-grid stats">${Array.from({ length: options.count || 4 }, compactCardSkeleton).join('')}</div>`;
        default:
            return gridSkeleton(count || 3, options.compact);
    }
}

export function renderSkeleton(target, type = 'cards', options = {}) {
    const el = resolveTarget(target);
    if (!el) return null;
    el.dataset.edenSkeleton = type;
    el.setAttribute('aria-busy', 'true');
    if (!el.hasAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
    el.innerHTML = skeletonHTML(type, options);
    return el;
}

export function clearSkeleton(target) {
    const el = resolveTarget(target);
    if (!el) return;
    if (el.dataset.edenSkeleton) delete el.dataset.edenSkeleton;
    el.removeAttribute('aria-busy');
}

export { skeletonHTML };
