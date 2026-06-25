import { auth, db } from './firebase-config.js';
import { clearSkeleton, renderSkeleton } from './ui-skeleton.js';
import { cachedPublicJSON, snapshotRows } from './public-data-cache.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, getDoc, getDocs, limit, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const ADMIN_EMAILS = ['admin@edencafe.com', 'phoo1236@gmail.com', 'sonsawan.1231@gmail.com'];
const ADMIN_ORDER_ROLES = ['owner', 'head_manager', 'manager'];
const MENU_ORDER_ACCESS_EVENT = 'eden:menu-order-access-changed';
const PUBLIC_CACHE_TTL_MS = 5 * 60 * 1000;
const MENU_CATEGORY_LIMIT = 160;
const MENU_PRODUCT_LIMIT = 300;
let menuOrderAccess = { ready: false, allowed: false, reason: 'checking' };
let lastMenuRender = { container: null, items: [], note: '', categories: [] };

const FALLBACK_MENU = [];

const CATEGORY_LABELS = {
    coffee: { th: '\u0e01\u0e32\u0e41\u0e1f', en: 'Coffee' },
    tea: { th: '\u0e0a\u0e32\u0e41\u0e25\u0e30\u0e21\u0e31\u0e17\u0e09\u0e30', en: 'Tea & Matcha' },
    bakery: { th: '\u0e40\u0e1a\u0e40\u0e01\u0e2d\u0e23\u0e35\u0e48', en: 'Bakery' },
    brunch: { th: '\u0e1a\u0e23\u0e31\u0e19\u0e0a\u0e4c', en: 'Brunch' },
    food: { th: '\u0e2d\u0e32\u0e2b\u0e32\u0e23', en: 'Food' },
    drink: { th: '\u0e40\u0e04\u0e23\u0e37\u0e48\u0e2d\u0e07\u0e14\u0e37\u0e48\u0e21', en: 'Drinks' },
    signature: { th: '\u0e40\u0e21\u0e19\u0e39\u0e41\u0e19\u0e30\u0e19\u0e33', en: 'Signature' },
    other: { th: '\u0e40\u0e21\u0e19\u0e39', en: 'Menu' }
};

function isEnglishPage() {
    return location.pathname.includes('-en');
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

function parseMenuBool(value, fallback = false) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const text = String(value).trim().toLowerCase();
    return ['true', '1', 'yes', 'y', 'available', 'sale', 'on', '\u0e40\u0e1b\u0e34\u0e14', '\u0e02\u0e32\u0e22', '\u0e43\u0e0a\u0e48'].includes(text);
}

function normalizeEmail(value) {
    return String(value ?? '').trim().toLowerCase();
}

function adminAccessCanOrder(access = {}) {
    if (!access || access.status !== 'active') return false;
    if (access.role === 'staff') return access.permissions?.menuOrder === true;
    if (ADMIN_ORDER_ROLES.includes(access.role)) {
        if (access.role === 'owner' || access.role === 'head_manager') return true;
        return access.permissions?.pos === true || access.permissions?.orders === true;
    }
    return access.permissions?.pos === true || access.permissions?.orders === true;
}

function setMenuOrderAccess(nextAccess = {}) {
    const normalized = {
        ready: nextAccess.ready === true,
        allowed: nextAccess.allowed === true,
        reason: nextAccess.reason || 'guest',
        role: nextAccess.role || ''
    };
    const changed = normalized.ready !== menuOrderAccess.ready
        || normalized.allowed !== menuOrderAccess.allowed
        || normalized.reason !== menuOrderAccess.reason
        || normalized.role !== menuOrderAccess.role;
    menuOrderAccess = normalized;
    window.EdenMenuOrderAccess = { ...menuOrderAccess };
    if (changed) window.dispatchEvent(new CustomEvent(MENU_ORDER_ACCESS_EVENT, { detail: window.EdenMenuOrderAccess }));
    if (changed && lastMenuRender.container) {
        renderMenu(lastMenuRender.container, lastMenuRender.items, lastMenuRender.note, lastMenuRender.categories);
    }
}

async function resolveMenuOrderAccess(user) {
    if (!user) {
        setMenuOrderAccess({ ready: true, allowed: false, reason: 'guest' });
        return;
    }

    const email = normalizeEmail(user.email);
    if (ADMIN_EMAILS.includes(email)) {
        setMenuOrderAccess({ ready: true, allowed: true, reason: 'authorized', role: 'staff' });
        return;
    }

    if (!db) {
        setMenuOrderAccess({ ready: true, allowed: false, reason: 'no-db' });
        return;
    }

    try {
        const accessSnap = await getDoc(doc(db, 'admin_users', user.uid));
        const access = accessSnap.exists() ? accessSnap.data() : null;
        const allowed = adminAccessCanOrder(access);
        setMenuOrderAccess({
            ready: true,
            allowed,
            reason: allowed ? 'authorized' : 'member-only',
            role: access?.role || ''
        });
    } catch (error) {
        console.warn('Unable to verify menu ordering access:', error);
        setMenuOrderAccess({ ready: true, allowed: false, reason: 'permission-error' });
    }
}

function initMenuOrderAccessWatcher() {
    window.EdenMenuOrderAccess = { ...menuOrderAccess };

    if (auth) {
        onAuthStateChanged(auth, user => {
            setMenuOrderAccess({ ready: false, allowed: false, reason: 'checking' });
            resolveMenuOrderAccess(user);
        });
    } else {
        setMenuOrderAccess({ ready: true, allowed: false, reason: 'no-auth' });
    }

    window.addEventListener('eden:user-changed', () => {
        if (auth?.currentUser) resolveMenuOrderAccess(auth.currentUser);
        else setMenuOrderAccess({ ready: true, allowed: false, reason: 'guest' });
    });
}

function menuAccessNoticeHTML(en) {
    if (!menuOrderAccess.ready) {
        return '<div class="menu-order-access-note is-checking">'
            + '<strong>' + (en ? 'Checking order permission' : '\u0e01\u0e33\u0e25\u0e31\u0e07\u0e15\u0e23\u0e27\u0e08\u0e2a\u0e2d\u0e1a\u0e2a\u0e34\u0e17\u0e18\u0e34\u0e4c\u0e01\u0e32\u0e23\u0e2a\u0e31\u0e48\u0e07') + '</strong>'
            + '<span>' + (en ? 'Menu browsing is open to everyone. Add to cart will unlock for authorized store staff only.' : '\u0e14\u0e39\u0e40\u0e21\u0e19\u0e39\u0e44\u0e14\u0e49\u0e17\u0e38\u0e01\u0e04\u0e19 \u0e41\u0e15\u0e48\u0e1b\u0e38\u0e48\u0e21\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e25\u0e07\u0e15\u0e30\u0e01\u0e23\u0e49\u0e32\u0e08\u0e30\u0e40\u0e1b\u0e34\u0e14\u0e40\u0e09\u0e1e\u0e32\u0e30\u0e1e\u0e19\u0e31\u0e01\u0e07\u0e32\u0e19\u0e17\u0e35\u0e48\u0e44\u0e14\u0e49\u0e23\u0e31\u0e1a\u0e2a\u0e34\u0e17\u0e18\u0e34\u0e4c') + '</span>'
            + '</div>';
    }

    if (menuOrderAccess.allowed) {
        return '<div class="menu-order-access-note is-allowed">'
            + '<strong>' + (en ? 'Staff order mode enabled' : '\u0e42\u0e2b\u0e21\u0e14\u0e2a\u0e31\u0e48\u0e07\u0e40\u0e21\u0e19\u0e39\u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e1e\u0e19\u0e31\u0e01\u0e07\u0e32\u0e19\u0e40\u0e1b\u0e34\u0e14\u0e43\u0e0a\u0e49\u0e07\u0e32\u0e19') + '</strong>'
            + '<span>' + (en ? 'This account can add menu items to cart for in-store ordering.' : '\u0e1a\u0e31\u0e0d\u0e0a\u0e35\u0e19\u0e35\u0e49\u0e21\u0e35\u0e2a\u0e34\u0e17\u0e18\u0e34\u0e4c\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e40\u0e21\u0e19\u0e39\u0e25\u0e07\u0e15\u0e30\u0e01\u0e23\u0e49\u0e32\u0e40\u0e1e\u0e37\u0e48\u0e2d\u0e2a\u0e31\u0e48\u0e07\u0e43\u0e19\u0e23\u0e49\u0e32\u0e19') + '</span>'
            + '</div>';
    }

    return '<div class="menu-order-access-note is-locked">'
        + '<strong>' + (en ? 'Browse-only menu' : '\u0e40\u0e21\u0e19\u0e39\u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e14\u0e39\u0e23\u0e32\u0e22\u0e01\u0e32\u0e23') + '</strong>'
        + '<span>' + (en ? 'Add to cart is reserved for authorized store staff ordering inside Eden Cafe.' : '\u0e1b\u0e38\u0e48\u0e21\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e25\u0e07\u0e15\u0e30\u0e01\u0e23\u0e49\u0e32\u0e2a\u0e07\u0e27\u0e19\u0e2a\u0e34\u0e17\u0e18\u0e34\u0e4c\u0e40\u0e09\u0e1e\u0e32\u0e30\u0e1e\u0e19\u0e31\u0e01\u0e07\u0e32\u0e19/\u0e1c\u0e39\u0e49\u0e44\u0e14\u0e49\u0e23\u0e31\u0e1a\u0e2a\u0e34\u0e17\u0e18\u0e34\u0e4c\u0e2a\u0e31\u0e48\u0e07\u0e20\u0e32\u0e22\u0e43\u0e19\u0e23\u0e49\u0e32\u0e19 Eden Cafe') + '</span>'
        + '</div>';
}

function normalizeMenuOptions(item) {
    if (Array.isArray(item.options)) {
        return item.options
            .map(option => ({ name: String(option?.name ?? '').trim(), value: String(option?.value ?? '').trim() }))
            .filter(option => option.name || option.value);
    }
    return [1, 2, 3]
        .map(index => ({
            name: String(item['option' + index + 'Name'] ?? '').trim(),
            value: String(item['option' + index + 'Value'] ?? '').trim()
        }))
        .filter(option => option.name || option.value);
}

function normalizeMenuVariant(variant, index, item, basePrice) {
    const rawName = String(variant?.name ?? variant?.id ?? variant?.option ?? '').trim();
    const price = Number(variant?.price ?? basePrice ?? 0);
    const stock = Number(variant?.stock ?? variant?.inStock ?? 0);
    const trackStock = parseMenuBool(variant?.trackStock, false);
    const availableForSale = parseMenuBool(variant?.availableForSale, true);
    const id = String(variant?.id ?? variant?.sku ?? rawName ?? index).trim() || String(index);
    const name = rawName || (isEnglishPage() ? 'Option ' + (index + 1) : '\u0e15\u0e31\u0e27\u0e40\u0e25\u0e37\u0e2d\u0e01 ' + (index + 1));

    return {
        id,
        name,
        price: Number.isFinite(price) ? price : 0,
        sku: String(variant?.sku ?? '').trim(),
        barcode: String(variant?.barcode ?? '').trim(),
        stock: Number.isFinite(stock) ? stock : 0,
        lowStock: Number(variant?.lowStock ?? 0) || 0,
        availableForSale,
        canSell: availableForSale && (!trackStock || stock > 0)
    };
}

function normalizeMenuVariants(item, basePrice) {
    if (!Array.isArray(item.variants)) return [];
    return item.variants
        .map((variant, index) => normalizeMenuVariant(variant, index, item, basePrice))
        .filter(variant => variant.name || variant.sku || variant.id);
}

function normalizeMenuItem(item) {
    const en = isEnglishPage();
    const category = item.category || 'other';
    const categoryLabel = CATEGORY_LABELS[category] || CATEGORY_LABELS.other;
    const categoryMeta = item.categoryMeta || {};
    const trackStock = parseMenuBool(item.trackStock, false);
    const stock = Number(item.stock ?? item.inStock ?? 0);
    const availableForSale = parseMenuBool(item.availableForSale, true);
    const showOnWebsite = parseMenuBool(item.showOnWebsite, true);
    const categoryOrder = Number(categoryMeta.order ?? item.categoryOrder ?? 999);
    const order = Number(item.order ?? 999999);
    const price = Number(item.price) || 0;
    const variants = normalizeMenuVariants(item, price);
    const hasSellableVariant = variants.some(variant => variant.canSell);
    const canSell = availableForSale && showOnWebsite && (variants.length ? hasSellableVariant : (!trackStock || stock > 0));

    return {
        id: item.id || item.handle || item.sku || item.slug || item.name || String(Date.now()),
        handle: item.handle || item.id || '',
        sku: item.sku || '',
        category,
        categoryName: categoryMeta.name || item.categoryName || (en ? item.categoryNameEn : item.categoryNameTh) || (en ? categoryLabel.en : categoryLabel.th),
        name: item.name || (en ? item.nameEn : item.nameTh) || 'Eden Menu',
        description: item.description || (en ? item.descriptionEn : item.descriptionTh) || '',
        price,
        order: Number.isFinite(order) ? order : 999999,
        categoryOrder: Number.isFinite(categoryOrder) ? categoryOrder : 999,
        imageUrl: item.imageUrl || item.image || 'Images/Logo.webp',
        soldByWeight: parseMenuBool(item.soldByWeight, false),
        options: normalizeMenuOptions(item),
        variants,
        trackStock,
        stock: Number.isFinite(stock) ? stock : 0,
        lowStock: Number(item.lowStock ?? 0) || 0,
        availableForSale,
        showOnWebsite,
        canSell,
        taxEnabled: parseMenuBool(item.taxEnabled, true)
    };
}

function fallbackMenu() {
    return FALLBACK_MENU.map(normalizeMenuItem);
}

function normalizeMenuCategory(id, data = {}) {
    const en = isEnglishPage();
    const fallback = CATEGORY_LABELS[id] || CATEGORY_LABELS.other;
    const displayName = data.name || (en ? data.nameEn : data.nameTh) || (en ? fallback.en : fallback.th);
    const order = Number(data.order ?? 999);
    return {
        id,
        name: displayName,
        order: Number.isFinite(order) ? order : 999
    };
}

function sortMenuItems(items) {
    return [...items].sort((a, b) => {
        const categoryOrder = (a.categoryOrder ?? 999) - (b.categoryOrder ?? 999);
        if (categoryOrder !== 0) return categoryOrder;
        const itemOrder = (a.order ?? 999999) - (b.order ?? 999999);
        if (itemOrder !== 0) return itemOrder;
        return String(a.name || '').localeCompare(String(b.name || ''), 'th');
    });
}

function buildCategoryFilters(items, categories = []) {
    const usedCategoryIds = new Set(items.map(item => item.category));
    const fromCategories = categories
        .filter(category => usedCategoryIds.has(category.id))
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const knownIds = new Set(fromCategories.map(category => category.id));
    const fromItems = items.reduce((acc, item) => {
        if (!knownIds.has(item.category) && !acc.some(category => category.id === item.category)) {
            acc.push({ id: item.category, name: item.categoryName, order: item.categoryOrder ?? 999 });
        }
        return acc;
    }, []).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    return [...fromCategories, ...fromItems];
}

function getDefaultVariant(item) {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    if (!variants.length) return null;
    return variants.find(variant => variant.canSell) || variants[0];
}

function getVariantCartId(item, variant) {
    return variant ? String(item.id) + '::' + String(variant.id) : String(item.id);
}

function getVariantCartName(item, variant) {
    return variant ? item.name + ' - ' + variant.name : item.name;
}

function formatMenuPrice(value) {
    const price = Number(value) || 0;
    return '\u0e3f' + price.toLocaleString('en-US');
}

function variantControlId(item) {
    return 'menu-variant-' + String(item.id || item.name || 'item').replace(/[^a-z0-9_-]+/gi, '-');
}

function renderVariantSelector(item, disabled, en) {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    if (variants.length <= 1) return '';
    const selectedVariant = getDefaultVariant(item);
    const label = en ? 'Option' : '\u0e15\u0e31\u0e27\u0e40\u0e25\u0e37\u0e2d\u0e01';
    const soldOut = en ? 'Sold out' : '\u0e2b\u0e21\u0e14';
    const selectId = variantControlId(item);

    const optionsHTML = variants.map((variant, index) => {
        const isSelected = selectedVariant && variant.id === selectedVariant.id;
        const optionText = variant.name + ' - ' + formatMenuPrice(variant.price) + (!variant.canSell ? ' (' + soldOut + ')' : '');
        return '<option value="' + index + '"'
            + (isSelected ? ' selected' : '')
            + (!variant.canSell ? ' disabled' : '')
            + ' data-variant-id="' + escapeHTML(variant.id) + '"'
            + ' data-variant-name="' + escapeHTML(variant.name) + '"'
            + ' data-price="' + variant.price + '"'
            + ' data-sku="' + escapeHTML(variant.sku) + '"'
            + ' data-available="' + (variant.canSell ? 'true' : 'false') + '">'
            + escapeHTML(optionText)
            + '</option>';
    }).join('');

    return '<div class="menu-variant-field">'
        + '<label class="menu-variant-label" for="' + escapeHTML(selectId) + '">' + label + '</label>'
        + '<select class="menu-variant-select" id="' + escapeHTML(selectId) + '"'
        + (disabled ? ' disabled' : '')
        + ' data-base-id="' + escapeHTML(item.id) + '"'
        + ' data-base-name="' + escapeHTML(item.name) + '">'
        + optionsHTML
        + '</select>'
        + '</div>';
}

function syncVariantSelection(select, en) {
    const selectedOption = select.selectedOptions?.[0];
    const card = select.closest('.menu-card');
    const button = card?.querySelector('.btn-add-cart');
    const priceEl = card?.querySelector('.menu-item-price');
    if (!selectedOption || !button) return;

    const stockLocked = button.dataset.menuStockLocked === 'true';
    const accessLocked = button.dataset.menuAccessLocked === 'true';
    const lockLabel = button.dataset.menuLockLabel || (en ? 'Staff only' : '\u0e40\u0e09\u0e1e\u0e32\u0e30\u0e1e\u0e19\u0e31\u0e01\u0e07\u0e32\u0e19');
    const unavailableLabel = button.dataset.menuUnavailableLabel || (en ? 'Sold out' : '\u0e2b\u0e21\u0e14');
    const available = selectedOption.dataset.available !== 'false' && !selectedOption.disabled;
    const price = Number(selectedOption.dataset.price) || 0;
    const baseId = select.dataset.baseId || button.dataset.baseId || button.dataset.id || '';
    const baseName = select.dataset.baseName || button.dataset.baseName || button.dataset.name || '';
    const variantId = selectedOption.dataset.variantId || selectedOption.value;
    const variantName = selectedOption.dataset.variantName || selectedOption.textContent || '';

    if (priceEl) priceEl.textContent = formatMenuPrice(price);
    button.dataset.id = baseId + '::' + variantId;
    button.dataset.name = baseName + ' - ' + variantName;
    button.dataset.price = String(price);
    button.dataset.variantName = variantName;
    button.dataset.sku = selectedOption.dataset.sku || '';

    if (stockLocked || !available) {
        button.disabled = true;
        button.style.background = '#ccc';
        button.textContent = unavailableLabel;
    } else if (accessLocked) {
        button.disabled = true;
        button.style.background = '';
        button.textContent = lockLabel;
    } else {
        button.disabled = false;
        button.style.background = '';
        button.textContent = en ? 'Add to Cart' : '\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e25\u0e07\u0e15\u0e30\u0e01\u0e23\u0e49\u0e32';
    }
}

async function fetchMenuCategories() {
    if (!db) return [];
    const rows = await cachedPublicJSON('menu-categories:v1', async () => {
        const snapshot = await getDocs(query(collection(db, 'categories'), limit(MENU_CATEGORY_LIMIT)));
        return snapshotRows(snapshot);
    }, { ttlMs: PUBLIC_CACHE_TTL_MS });

    return rows
        .map(row => normalizeMenuCategory(row.id, row))
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

async function fetchWebsiteMenuRows() {
    const rows = await cachedPublicJSON('menu-products:website:v2', async () => {
        const snapshot = await getDocs(query(
            collection(db, 'products'),
            where('showOnWebsite', '==', true),
            limit(MENU_PRODUCT_LIMIT)
        ));
        return snapshotRows(snapshot);
    }, { ttlMs: PUBLIC_CACHE_TTL_MS });

    if (rows.length) return rows;

    return cachedPublicJSON('menu-products:fallback-limited:v1', async () => {
        const snapshot = await getDocs(query(collection(db, 'products'), limit(MENU_PRODUCT_LIMIT)));
        return snapshotRows(snapshot);
    }, { ttlMs: PUBLIC_CACHE_TTL_MS });
}

async function fetchMenuFromCloud() {
    if (!db) return [];
    const [categories, productRows] = await Promise.all([
        fetchMenuCategories(),
        fetchWebsiteMenuRows()
    ]);
    const categoryMeta = categories.reduce((acc, category) => {
        acc[category.id] = category;
        return acc;
    }, {});
    const items = productRows
        .map(row => normalizeMenuItem({ ...row, categoryMeta: categoryMeta[row.category] }))
        .filter(item => item.availableForSale && item.showOnWebsite);
    return { items: sortMenuItems(items), categories };
}

function renderMenu(container, items, note = '', categories = []) {
    const en = isEnglishPage();
    const fallbackMode = Boolean(note);
    const categoryFilters = buildCategoryFilters(items, categories);
    lastMenuRender = { container, items, note, categories };
    clearSkeleton(container);
    if (!items.length) {
        container.innerHTML = (note ? '<div class="shop-data-note" style="background:#fff8e1; border:1px solid #f1d58a; color:#6b4f00; padding:12px 16px; border-radius:12px; margin-bottom:18px;">' + escapeHTML(note) + '</div>' : '')
            + '<div class="shop-empty-state" style="background:#fff; border:1px solid #e5eee8; border-radius:12px; padding:28px; text-align:center; color:#536159;">'
            + (en ? 'The live menu is being prepared. Please check back soon or contact Eden Cafe directly.' : 'กำลังเตรียมเมนูออนไลน์ กรุณากลับมาใหม่อีกครั้งหรือติดต่อ Eden Cafe โดยตรง')
            + '</div>';
        return;
    }

    const cardsHTML = items.map(item => {
        const stockDisabled = fallbackMode || !item.canSell;
        const accessLocked = !stockDisabled && (!menuOrderAccess.ready || !menuOrderAccess.allowed);
        const disabled = stockDisabled || accessLocked;
        const defaultVariant = getDefaultVariant(item);
        const displayPrice = defaultVariant ? defaultVariant.price : item.price;
        const cartId = getVariantCartId(item, defaultVariant);
        const cartName = getVariantCartName(item, defaultVariant);
        const variantSelector = renderVariantSelector(item, stockDisabled, en);
        const optionText = !item.variants.length && item.options.length ? item.options.map(option => (option.name + (option.name && option.value ? ': ' : '') + option.value)).join(' / ') : '';
        const stockText = item.trackStock ? (en ? 'Stock: ' + item.stock : '\u0e40\u0e2b\u0e25\u0e37\u0e2d ' + item.stock) : '';
        const accessLockLabel = !menuOrderAccess.ready
            ? (en ? 'Checking...' : '\u0e01\u0e33\u0e25\u0e31\u0e07\u0e15\u0e23\u0e27\u0e08\u0e2a\u0e2d\u0e1a')
            : (en ? 'Staff only' : '\u0e40\u0e09\u0e1e\u0e32\u0e30\u0e1e\u0e19\u0e31\u0e01\u0e07\u0e32\u0e19');
        const unavailableLabel = fallbackMode
            ? (en ? 'Unavailable' : '\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e02\u0e32\u0e22')
            : (en ? 'Sold out' : '\u0e2b\u0e21\u0e14');
        const buttonText = fallbackMode
            ? (en ? 'Unavailable' : '\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e02\u0e32\u0e22')
            : (!item.canSell ? (en ? 'Sold out' : '\u0e2b\u0e21\u0e14') : (accessLocked ? accessLockLabel : (en ? 'Add to Cart' : '\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e25\u0e07\u0e15\u0e30\u0e01\u0e23\u0e49\u0e32')));

        return '<div class="shop-card menu-card" data-category="cat-' + escapeHTML(item.category) + '">'
            + '<div class="shop-img-wrapper"><img loading="lazy" src="' + safeImageURL(item.imageUrl) + '" alt="' + escapeHTML(item.name) + '" class="shop-img"></div>'
            + '<div class="shop-details">'
            + '<span class="shop-category">' + escapeHTML(item.categoryName) + '</span>'
            + '<h3>' + escapeHTML(item.name) + '</h3>'
            + '<p>' + escapeHTML(item.description) + '</p>'
            + (optionText ? '<p style="font-size:0.85rem; color:#607466; margin-top:8px;">' + escapeHTML(optionText) + '</p>' : '')
            + variantSelector
            + (stockText ? '<p style="font-size:0.85rem; color:' + (item.canSell ? '#0f7a3d' : '#b91c1c') + '; margin-top:6px;">' + escapeHTML(stockText) + '</p>' : '')
            + '<div class="shop-action">'
            + '<span class="shop-price menu-item-price">' + formatMenuPrice(displayPrice) + '</span>'
            + '<button class="btn btn-add-cart' + (accessLocked ? ' menu-order-locked' : '') + '" '
            + (disabled ? 'disabled' + (stockDisabled ? ' style="background:#ccc;"' : '') : '')
            + ' data-menu-requires-access="true"'
            + ' data-menu-stock-locked="' + (stockDisabled ? 'true' : 'false') + '"'
            + ' data-menu-access-locked="' + (accessLocked ? 'true' : 'false') + '"'
            + ' data-menu-lock-label="' + escapeHTML(accessLockLabel) + '"'
            + ' data-menu-unavailable-label="' + escapeHTML(unavailableLabel) + '"'
            + ' data-menu-locked="' + (disabled ? 'true' : 'false') + '"'
            + ' data-base-id="' + escapeHTML(item.id) + '" data-base-name="' + escapeHTML(item.name) + '" data-id="' + escapeHTML(cartId) + '" data-name="' + escapeHTML(cartName) + '" data-price="' + displayPrice + '">' + buttonText + '</button>'
            + '</div></div></div>';
    }).join('');

    container.innerHTML = (note ? '<div class="shop-data-note" style="background:#fff8e1; border:1px solid #f1d58a; color:#6b4f00; padding:12px 16px; border-radius:12px; margin-bottom:18px;">' + escapeHTML(note) + '</div>' : '')
        + menuAccessNoticeHTML(en)
        + '<div class="category-filters menu-category-filters">'
        + '<button class="filter-btn active" data-filter="all">' + (en ? 'All' : '\u0e17\u0e31\u0e49\u0e07\u0e2b\u0e21\u0e14') + '</button>'
        + categoryFilters.map(category => '<button class="filter-btn" data-filter="cat-' + escapeHTML(category.id) + '">' + escapeHTML(category.name) + '</button>').join('')
        + '</div><div class="shop-grid shop-grid-online menu-grid-online">' + cardsHTML + '</div>';

    const buttons = container.querySelectorAll('.filter-btn');
    const cards = container.querySelectorAll('.menu-card');
    buttons.forEach(button => {
        button.addEventListener('click', () => {
            buttons.forEach(item => item.classList.remove('active'));
            button.classList.add('active');
            const filter = button.dataset.filter;
            cards.forEach(card => {
                card.style.display = filter === 'all' || card.dataset.category === filter ? 'flex' : 'none';
            });
        });
    });

    container.querySelectorAll('.menu-variant-select').forEach(select => {
        syncVariantSelection(select, en);
        select.addEventListener('change', () => syncVariantSelection(select, en));
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('menu-products');
    if (!container) return;

    initMenuOrderAccessWatcher();

    const en = isEnglishPage();
    renderSkeleton(container, 'menu-grid', { count: 8 });

    try {
        const result = await fetchMenuFromCloud();
        const items = Array.isArray(result) ? result : result.items;
        const categories = Array.isArray(result?.categories) ? result.categories : [];
        if (items.length) renderMenu(container, items, '', categories);
        else renderMenu(container, fallbackMenu(), en ? 'Live menu is empty right now.' : 'ยังไม่มีเมนูออนไลน์ที่พร้อมแสดงในขณะนี้');
    } catch (error) {
        console.error('Error loading menu:', error);
        renderMenu(container, fallbackMenu(), en ? 'Could not load the live menu right now.' : 'ไม่สามารถโหลดเมนูจากหลังบ้านได้ในขณะนี้');
    }
});
