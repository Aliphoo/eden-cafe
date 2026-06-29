import { db } from './firebase-config.js';
import { clearSkeleton, renderSkeleton } from './ui-skeleton.js';
import { cachedPublicJSON, snapshotRows } from './public-data-cache.js';
import { collection, getDocs, limit, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PUBLIC_CACHE_TTL_MS = 5 * 60 * 1000;
const SHOP_CATEGORY_LIMIT = 160;
const SHOP_PRODUCT_LIMIT = 180;

const FALLBACK_PRODUCTS = [];
const shopProductMap = new Map();
let activeProductDetail = null;
let lastProductDetailTrigger = null;

function isEnglishPage() {
    return location.pathname.includes('-en') || location.pathname.endsWith('/en');
}

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeImageURL(value) {
    const url = String(value ?? '').trim();
    return /^https?:\/\//i.test(url) || url.startsWith('Images/') || url.startsWith('Hero/') ? url : 'Images/Logo.webp';
}

function parseShopBoolean(value, fallback = false) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    return ['true', '1', 'yes', 'y', 'available', 'sale', 'on', '\u0e40\u0e1b\u0e34\u0e14', '\u0e02\u0e32\u0e22', '\u0e43\u0e0a\u0e48'].includes(text);
}

function t(th, en) {
    return isEnglishPage() ? en : th;
}

function cleanShopText(value) {
    return String(value ?? '').trim();
}

function parseShopNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function formatShopPrice(value) {
    return '\u0e3f' + (Number(value) || 0).toLocaleString('en-US');
}

function normalizeProductOptions(product = {}) {
    if (Array.isArray(product.options)) {
        return product.options
            .map(option => ({
                name: cleanShopText(option?.name),
                value: cleanShopText(option?.value)
            }))
            .filter(option => option.name || option.value);
    }

    return [1, 2, 3]
        .map(index => ({
            name: cleanShopText(product['option' + index + 'Name']),
            value: cleanShopText(product['option' + index + 'Value'])
        }))
        .filter(option => option.name || option.value);
}

function normalizeProductVariant(variant = {}, index = 0, product = {}) {
    const name = cleanShopText(variant.name ?? variant.title ?? variant.value ?? variant.optionValue ?? variant.id)
        || t('\u0e15\u0e31\u0e27\u0e40\u0e25\u0e37\u0e2d\u0e01 ' + (index + 1), 'Option ' + (index + 1));
    const id = cleanShopText(variant.id ?? variant.sku ?? name) || String(index);
    const price = parseShopNumber(variant.price ?? variant.salePrice, product.price);
    const stockValue = Number(variant.stock ?? variant.inStock ?? product.stock);
    const stock = Number.isFinite(stockValue) ? stockValue : null;
    const trackStock = parseShopBoolean(variant.trackStock, product.trackStock);
    const availableForSale = parseShopBoolean(variant.availableForSale ?? variant.available ?? variant.enabled, true);

    return {
        id,
        name,
        sku: cleanShopText(variant.sku),
        price,
        stock,
        trackStock,
        availableForSale,
        canSell: availableForSale && (!trackStock || (stock !== null && stock > 0))
    };
}

function getDefaultProductVariant(product = {}) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    if (!variants.length) return null;
    return variants.find(variant => variant.canSell) || variants[0];
}

function canAddProduct(product = {}, variant = getDefaultProductVariant(product)) {
    if (product.availableForSale === false) return false;
    if (variant) return variant.canSell;
    return !product.trackStock || product.stock > 0;
}

function getProductCartId(product = {}, variant = getDefaultProductVariant(product)) {
    return variant ? String(product.id) + '::' + String(variant.id) : String(product.id);
}

function getProductCartName(product = {}, variant = getDefaultProductVariant(product)) {
    return variant ? product.name + ' - ' + variant.name : product.name;
}

function productStockText(product = {}, variant = getDefaultProductVariant(product)) {
    const tracked = variant ? variant.trackStock : product.trackStock;
    const stock = variant && variant.stock !== null ? variant.stock : product.stock;
    if (!tracked) return t('\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e08\u0e31\u0e14\u0e2a\u0e48\u0e07', 'Available');
    if (stock <= 0) return t('\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32\u0e2b\u0e21\u0e14', 'Sold out');
    return isEnglishPage() ? `In stock: ${stock}` : `\u0e40\u0e2b\u0e25\u0e37\u0e2d ${stock} \u0e0a\u0e34\u0e49\u0e19`;
}

function getShopCategoryName(product, category, categoryId) {
    const en = isEnglishPage();
    const rawName = product.categoryName || category.name || (en ? product.categoryNameEn : product.categoryNameTh) || '';
    const normalizedName = String(rawName).trim().toLowerCase();
    if (categoryId === 'other' || normalizedName === 'general' || normalizedName === '\u0e17\u0e31\u0e48\u0e27\u0e44\u0e1b') {
        return 'Online Shopping';
    }
    return rawName || (en ? 'Products' : '\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32');
}

function normalizeProduct(product, categoryMap = {}) {
    const source = product.source || 'menu';
    const rawId = product.id || product.slug || product.name || crypto.randomUUID?.() || String(Date.now());
    const categoryId = product.category || product.categoryId || 'other';
    const category = categoryMap[categoryId] || {};
    const en = isEnglishPage();
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const activeVariant = variants.find(variant => parseShopBoolean(variant.availableForSale, true)) || variants[0] || null;
    const trackStock = parseShopBoolean(product.trackStock, source === 'shop');
    const stock = Number(product.stock);
    const normalized = {
        id: source === 'menu' ? `menu-${rawId}` : rawId,
        source,
        category: categoryId,
        categoryName: getShopCategoryName(product, category, categoryId),
        name: product.name || (en ? product.nameEn : product.nameTh) || 'Eden Product',
        description: product.description || (en ? product.descriptionEn : product.descriptionTh) || '',
        price: Number(activeVariant?.price ?? product.price) || 0,
        imageUrl: product.imageUrl || product.image || 'Images/Logo.webp',
        stock: trackStock ? (Number.isFinite(stock) ? stock : 0) : (Number.isFinite(stock) && stock > 0 ? stock : 99),
        trackStock,
        options: normalizeProductOptions(product),
        sku: cleanShopText(product.sku),
        availableForSale: parseShopBoolean(product.availableForSale, true),
        showInShop: parseShopBoolean(product.showInShop, source === 'shop'),
        variants: []
    };
    normalized.variants = variants
        .map((variant, index) => normalizeProductVariant(variant, index, normalized))
        .filter(variant => variant.name || variant.sku || variant.id);
    const defaultVariant = getDefaultProductVariant(normalized);
    if (defaultVariant) {
        normalized.price = defaultVariant.price;
        if (defaultVariant.trackStock && defaultVariant.stock !== null) normalized.stock = defaultVariant.stock;
    }
    return normalized;
}

function fallbackProducts() {
    const en = isEnglishPage();
    return FALLBACK_PRODUCTS.map(product => normalizeProduct({
        ...product,
        categoryName: en ? product.categoryNameEn : product.categoryNameTh,
        name: en ? product.nameEn : product.nameTh,
        description: en ? product.descriptionEn : product.descriptionTh
    }));
}

function ensureProductDetailModal() {
    let modal = document.getElementById('shop-product-detail-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'shop-product-detail-modal';
    modal.className = 'shop-product-detail-modal';
    modal.hidden = true;
    modal.innerHTML = `
        <div class="shop-product-detail-modal__scrim" data-shop-detail-close></div>
        <article class="shop-product-detail-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="shop-product-detail-title">
            <button type="button" class="shop-product-detail-modal__close" data-shop-detail-close aria-label="${escapeHTML(t('\u0e1b\u0e34\u0e14\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32', 'Close product details'))}">&times;</button>
            <div class="shop-product-detail-modal__media">
                <img id="shop-product-detail-image" src="Images/Logo.webp" alt="">
            </div>
            <div class="shop-product-detail-modal__body">
                <span class="shop-product-detail-modal__category" id="shop-product-detail-category"></span>
                <h2 id="shop-product-detail-title"></h2>
                <p class="shop-product-detail-modal__price" id="shop-product-detail-price"></p>
                <p class="shop-product-detail-modal__description" id="shop-product-detail-description"></p>
                <div class="shop-product-detail-modal__options" id="shop-product-detail-options" hidden></div>
                <label class="shop-product-detail-modal__variant" id="shop-product-detail-variant-wrap" hidden>
                    <span>${escapeHTML(t('\u0e15\u0e31\u0e27\u0e40\u0e25\u0e37\u0e2d\u0e01', 'Option'))}</span>
                    <select id="shop-product-detail-variant"></select>
                </label>
                <p class="shop-product-detail-modal__stock" id="shop-product-detail-stock"></p>
                <button type="button" class="btn btn-add-cart shop-product-detail-modal__add shop-detail-add-btn" id="shop-product-detail-add"></button>
            </div>
        </article>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', event => {
        if (event.target.closest('[data-shop-detail-close]')) closeProductDetailModal();
    });
    modal.querySelector('#shop-product-detail-variant')?.addEventListener('change', syncProductDetailVariant);
    modal.querySelector('#shop-product-detail-add')?.addEventListener('click', () => {
        setTimeout(closeProductDetailModal, 0);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !modal.hidden) closeProductDetailModal();
    });
    return modal;
}

function selectedProductDetailVariant() {
    const select = document.getElementById('shop-product-detail-variant');
    if (!activeProductDetail || !select || select.hidden) return getDefaultProductVariant(activeProductDetail);
    const index = Number(select.value);
    return activeProductDetail.variants[index] || getDefaultProductVariant(activeProductDetail);
}

function renderProductOptions(product = {}) {
    const container = document.getElementById('shop-product-detail-options');
    if (!container) return;
    if (!product.options?.length) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }
    container.innerHTML = product.options.map(option => {
        const label = option.name ? `<strong>${escapeHTML(option.name)}</strong>` : '';
        const value = option.value ? `<span>${escapeHTML(option.value)}</span>` : '';
        return `<div>${label}${value}</div>`;
    }).join('');
    container.hidden = false;
}

function syncProductDetailVariant() {
    if (!activeProductDetail) return;
    const variant = selectedProductDetailVariant();
    const addButton = document.getElementById('shop-product-detail-add');
    const priceEl = document.getElementById('shop-product-detail-price');
    const stockEl = document.getElementById('shop-product-detail-stock');
    const canAdd = canAddProduct(activeProductDetail, variant);
    const price = variant ? variant.price : activeProductDetail.price;

    if (priceEl) priceEl.textContent = formatShopPrice(price);
    if (stockEl) {
        stockEl.textContent = productStockText(activeProductDetail, variant);
        stockEl.classList.toggle('is-sold-out', !canAdd);
    }
    if (addButton) {
        addButton.dataset.id = getProductCartId(activeProductDetail, variant);
        addButton.dataset.name = getProductCartName(activeProductDetail, variant);
        addButton.dataset.price = String(price);
        addButton.dataset.productId = activeProductDetail.id;
        addButton.dataset.variantId = variant ? variant.id : '';
        addButton.dataset.categoryId = activeProductDetail.category || '';
        addButton.dataset.categoryName = activeProductDetail.categoryName || '';
        addButton.disabled = !canAdd;
        addButton.textContent = canAdd
            ? t('\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e25\u0e07\u0e15\u0e30\u0e01\u0e23\u0e49\u0e32', 'Add to Cart')
            : t('\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32\u0e2b\u0e21\u0e14', 'Sold out');
    }
}

function openProductDetail(productId, trigger = null) {
    const product = shopProductMap.get(productId);
    if (!product) return;

    const modal = ensureProductDetailModal();
    activeProductDetail = product;
    lastProductDetailTrigger = trigger || document.activeElement;

    const image = modal.querySelector('#shop-product-detail-image');
    const category = modal.querySelector('#shop-product-detail-category');
    const title = modal.querySelector('#shop-product-detail-title');
    const description = modal.querySelector('#shop-product-detail-description');
    const variantWrap = modal.querySelector('#shop-product-detail-variant-wrap');
    const variantSelect = modal.querySelector('#shop-product-detail-variant');

    if (image) {
        image.src = safeImageURL(product.imageUrl);
        image.alt = product.name;
    }
    if (category) category.textContent = product.categoryName;
    if (title) title.textContent = product.name;
    if (description) {
        description.textContent = product.description || t('\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e21\u0e35\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e40\u0e15\u0e34\u0e21', 'No additional details yet.');
    }
    renderProductOptions(product);

    if (variantWrap && variantSelect) {
        if (product.variants.length > 1) {
            const defaultVariant = getDefaultProductVariant(product);
            variantSelect.innerHTML = product.variants.map((variant, index) => {
                const soldOut = !variant.canSell ? ' (' + t('\u0e2b\u0e21\u0e14', 'Sold out') + ')' : '';
                return `<option value="${index}" ${variant === defaultVariant ? 'selected' : ''} ${!variant.canSell ? 'disabled' : ''}>${escapeHTML(variant.name)} - ${escapeHTML(formatShopPrice(variant.price) + soldOut)}</option>`;
            }).join('');
            variantWrap.hidden = false;
            variantSelect.hidden = false;
        } else {
            variantSelect.innerHTML = '';
            variantWrap.hidden = true;
            variantSelect.hidden = true;
        }
    }

    syncProductDetailVariant();
    modal.hidden = false;
    modal.classList.add('is-open');
    document.body.classList.add('shop-product-detail-open');
    modal.querySelector('.shop-product-detail-modal__close')?.focus();
}

function closeProductDetailModal() {
    const modal = document.getElementById('shop-product-detail-modal');
    if (!modal || modal.hidden) return;
    modal.classList.remove('is-open');
    modal.hidden = true;
    document.body.classList.remove('shop-product-detail-open');
    activeProductDetail = null;
    if (lastProductDetailTrigger?.focus) lastProductDetailTrigger.focus();
    lastProductDetailTrigger = null;
}

function renderProducts(container, products, note = '') {
    const en = isEnglishPage();
    const fallbackMode = Boolean(note);
    clearSkeleton(container);
    if (!products.length) {
        container.innerHTML = `
            ${note ? `<div class="shop-data-note" style="background:#fff8e1; border:1px solid #f1d58a; color:#6b4f00; padding:12px 16px; border-radius:12px; margin-bottom:18px;">${escapeHTML(note)}</div>` : ''}
            <div class="shop-empty-state" style="background:#fff; border:1px solid #e5eee8; border-radius:12px; padding:28px; text-align:center; color:#536159;">
                ${en ? 'Online products are being prepared. Please check back soon or contact Eden Cafe directly.' : 'กำลังเตรียมสินค้าออนไลน์ กรุณากลับมาใหม่อีกครั้งหรือติดต่อ Eden Cafe โดยตรง'}
            </div>
        `;
        return;
    }
    shopProductMap.clear();
    const grouped = products.reduce((acc, product) => {
        shopProductMap.set(product.id, product);
        if (!acc[product.category]) acc[product.category] = { title: product.categoryName, items: [] };
        acc[product.category].items.push(product);
        return acc;
    }, {});

    const categoryTitle = product => grouped[product.category]?.title || (en ? 'Products' : 'สินค้า');
    const productCards = products.map(product => {
        const defaultVariant = getDefaultProductVariant(product);
        const soldOut = fallbackMode || !canAddProduct(product, defaultVariant);
        const title = categoryTitle(product);
        const displayPrice = defaultVariant ? defaultVariant.price : product.price;
        const cartId = getProductCartId(product, defaultVariant);
        const cartName = getProductCartName(product, defaultVariant);
        return `
            <div class="shop-card" data-category="cat-${escapeHTML(product.category)}">
                <button type="button" class="shop-img-wrapper shop-product-detail-trigger" data-product-id="${escapeHTML(product.id)}" aria-label="${escapeHTML((en ? 'View details for ' : '\u0e14\u0e39\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14 ') + product.name)}"><img loading="lazy" src="${safeImageURL(product.imageUrl)}" alt="${escapeHTML(product.name)}" class="shop-img"></button>
                <div class="shop-details">
                    <span class="shop-category">${escapeHTML(title)}</span>
                    <h3>${escapeHTML(product.name)}</h3>
                    <p>${escapeHTML(product.description)}</p>
                    <p class="shop-stock" style="color:${soldOut ? '#b91c1c' : '#0f7a3d'};">${soldOut ? (en ? 'Sold out' : 'สินค้าหมด') : (en ? `In stock: ${product.stock}` : `เหลือ ${product.stock} ชิ้น`)}</p>
                    <div class="shop-action">
                        <span class="shop-price">${formatShopPrice(displayPrice)}</span>
                        <button class="btn btn-add-cart" ${soldOut ? 'disabled style="background:#ccc;"' : ''} data-id="${escapeHTML(cartId)}" data-name="${escapeHTML(cartName)}" data-price="${displayPrice}" data-product-id="${escapeHTML(product.id)}" data-variant-id="${escapeHTML(defaultVariant?.id || '')}" data-category-id="${escapeHTML(product.category || '')}" data-category-name="${escapeHTML(product.categoryName || '')}">
                            ${fallbackMode ? (en ? 'Unavailable' : 'ยังไม่พร้อมขาย') : (soldOut ? (en ? 'Sold out' : 'สินค้าหมด') : (en ? 'Add to Cart' : 'เพิ่มลงตะกร้า'))}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        ${note ? `<div class="shop-data-note" style="background:#fff8e1; border:1px solid #f1d58a; color:#6b4f00; padding:12px 16px; border-radius:12px; margin-bottom:18px;">${escapeHTML(note)}</div>` : ''}
        <div class="category-filters">
            <button class="filter-btn active" data-filter="all">${en ? 'All' : 'ทั้งหมด'}</button>
            ${Object.entries(grouped).map(([categoryId, group]) => `<button class="filter-btn" data-filter="cat-${escapeHTML(categoryId)}">${escapeHTML(group.title)}</button>`).join('')}
        </div>
        <div class="shop-grid shop-grid-online">
            ${productCards}
        </div>
    `;
    setupFilters(container);
    container.querySelectorAll('.shop-product-detail-trigger').forEach(trigger => {
        trigger.addEventListener('click', () => openProductDetail(trigger.dataset.productId, trigger));
    });
}

function setupFilters(scope = document) {
    const filterBtns = scope.querySelectorAll('.filter-btn');
    const productCards = scope.querySelectorAll('.shop-grid-online .shop-card');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(item => item.classList.remove('active'));
            btn.classList.add('active');
            const filter = btn.dataset.filter;
            productCards.forEach(card => {
                card.style.display = filter === 'all' || card.dataset.category === filter ? 'flex' : 'none';
            });
        });
    });
}

function setupTabs() {
    const tabs = document.querySelectorAll('.shop-tab-btn');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(item => item.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.shop-section').forEach(section => {
                section.style.display = section.id === tab.dataset.target ? 'block' : 'none';
            });
        });
    });
}

async function fetchProductsFromCloud() {
    if (!db) return [];

    const [categoryRows, productRows] = await Promise.all([
        cachedPublicJSON('shop-categories:v1', async () => {
            const snapshot = await getDocs(query(collection(db, 'categories'), limit(SHOP_CATEGORY_LIMIT)));
            return snapshotRows(snapshot);
        }, { ttlMs: PUBLIC_CACHE_TTL_MS }),
        cachedPublicJSON('shop-products:visible:v2', async () => {
            const snapshot = await getDocs(query(
                collection(db, 'products'),
                where('showInShop', '==', true),
                limit(SHOP_PRODUCT_LIMIT)
            ));
            return snapshotRows(snapshot);
        }, { ttlMs: PUBLIC_CACHE_TTL_MS })
    ]);
    const menuCategoryMap = {};
    categoryRows.forEach(row => { menuCategoryMap[row.id] = row; });

    return productRows
        .map(row => normalizeProduct({ ...row, source: 'menu' }, menuCategoryMap))
        .filter(product => product.availableForSale !== false && product.showInShop);
}

document.addEventListener('DOMContentLoaded', async () => {
    setupTabs();

    const onlineShopContainer = document.getElementById('online-shop');
    if (!onlineShopContainer) return;

    const en = isEnglishPage();
    renderSkeleton(onlineShopContainer, 'product-grid', { count: 8 });

    try {
        const products = await fetchProductsFromCloud();
        if (products.length) {
            renderProducts(onlineShopContainer, products);
        } else {
            renderProducts(onlineShopContainer, fallbackProducts(), en ? 'Online catalog is empty right now.' : 'ยังไม่มีสินค้าออนไลน์ที่พร้อมแสดงในขณะนี้');
        }
    } catch (error) {
        console.error('Error loading shop products:', error);
        renderProducts(onlineShopContainer, fallbackProducts(), en ? 'Could not load the live catalog right now.' : 'ไม่สามารถโหลดสินค้าจากหลังบ้านได้ในขณะนี้');
    }
});
