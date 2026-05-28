import { db } from './firebase-config.js';
import { collection, getDocs, query } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FEATURED_LIMIT = 8;
const CATEGORY_FALLBACK = {
    coffee: { th: 'กาแฟ', en: 'Coffee' },
    tea: { th: 'ชา', en: 'Tea' },
    bakery: { th: 'เบเกอรี่', en: 'Bakery' },
    food: { th: 'อาหาร', en: 'Food' },
    drink: { th: 'เครื่องดื่ม', en: 'Drinks' },
    other: { th: 'เมนู', en: 'Menu' }
};

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
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/?(Images|Hero|uploads)\//i.test(url)) return url;
    return 'Images/Logo.webp';
}

function parseBool(value, fallback = false) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    return ['true', '1', 'yes', 'y', 'available', 'sale', 'on', 'เปิด', 'ขาย', 'ใช่'].includes(text);
}

function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeVariant(variant = {}, baseProduct = {}) {
    const trackStock = parseBool(baseProduct.trackStock, false);
    const stock = safeNumber(variant.stock ?? variant.inStock ?? baseProduct.stock, 0);
    return {
        price: safeNumber(variant.price, safeNumber(baseProduct.price, 0)),
        canSell: parseBool(variant.availableForSale ?? variant.available ?? variant.enabled, true) && (!trackStock || stock > 0)
    };
}

function hasSellableStock(product = {}) {
    const variants = Array.isArray(product.variants) ? product.variants.map(variant => normalizeVariant(variant, product)) : [];
    if (variants.length) return variants.some(variant => variant.canSell);

    const trackStock = parseBool(product.trackStock, false);
    const stock = safeNumber(product.stock ?? product.inStock, 0);
    return !trackStock || stock > 0;
}

function shouldShowFeatured(product = {}) {
    return parseBool(product.availableForSale, true)
        && parseBool(product.showOnWebsite, true)
        && parseBool(product.showOnIndex ?? product.isFeatured, false)
        && hasSellableStock(product);
}

function productPriceText(product = {}) {
    const variants = Array.isArray(product.variants)
        ? product.variants.map(variant => normalizeVariant(variant, product)).filter(variant => variant.canSell)
        : [];
    const prices = variants.length ? variants.map(variant => variant.price) : [safeNumber(product.price, 0)];
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const format = value => '฿' + safeNumber(value, 0).toLocaleString('th-TH');
    return min === max ? format(min) : `${format(min)}-${format(max)}`;
}

function categoryLabel(product = {}, categoryMap = {}) {
    const en = isEnglishPage();
    const categoryId = product.category || product.categoryId || 'other';
    const category = categoryMap[categoryId] || {};
    const fallback = CATEGORY_FALLBACK[categoryId] || CATEGORY_FALLBACK.other;
    return category.name || (en ? category.nameEn : category.nameTh) || product.categoryName || (en ? product.categoryNameEn : product.categoryNameTh) || (en ? fallback.en : fallback.th);
}

function productName(product = {}) {
    const en = isEnglishPage();
    return product.name || (en ? product.nameEn : product.nameTh) || product.sku || 'Eden Menu';
}

function productDescription(product = {}) {
    const en = isEnglishPage();
    return product.description || (en ? product.descriptionEn : product.descriptionTh) || (en ? 'Selected by Eden Cafe for today.' : 'คัดสรรโดย Eden Cafe สำหรับวันนี้');
}

function productTargetURL(product = {}) {
    const en = isEnglishPage();
    if (product.showInShop) return en ? '/shop-en' : '/shop';
    return en ? '/menu-en' : '/menu';
}

function renderFeaturedCard(product, categoryMap) {
    const name = productName(product);
    const en = isEnglishPage();
    const cta = product.showInShop ? (en ? 'Shop now' : 'ดูสินค้า') : (en ? 'View menu' : 'ดูเมนู');
    return `
        <div class="shop-card">
            <div class="shop-img-wrapper">
                <img loading="lazy" src="${safeImageURL(product.imageUrl || product.image)}" alt="${escapeHTML(name)}" class="shop-img">
            </div>
            <div class="shop-details">
                <span class="shop-category">${escapeHTML(categoryLabel(product, categoryMap))}</span>
                <h3>${escapeHTML(name)}</h3>
                <p>${escapeHTML(productDescription(product))}</p>
                <div class="shop-action" style="margin-top: 15px; border-top: 1px solid #eee; padding-top: 15px;">
                    <span class="shop-price" style="font-size: 1.3rem;">${productPriceText(product)}</span>
                    <a href="${productTargetURL(product)}" class="btn" style="text-decoration: none;">${cta}</a>
                </div>
            </div>
        </div>
    `;
}

function renderFeaturedEmpty(grid, error = false) {
    const en = isEnglishPage();
    const title = error
        ? (en ? 'Could not load featured products right now.' : 'ยังโหลดสินค้าแนะนำไม่ได้ในตอนนี้')
        : (en ? 'Featured products are being updated.' : 'กำลังอัปเดตสินค้าแนะนำ');
    const detail = error
        ? (en ? 'Please refresh again shortly.' : 'ลองรีเฟรชอีกครั้งในอีกสักครู่')
        : (en ? 'Please check back soon.' : 'กลับมาดูอีกครั้งเร็วๆ นี้');
    grid.classList.add('featured-products-empty');
    grid.innerHTML = `
        <div class="featured-empty-state">
            <strong>${escapeHTML(title)}</strong>
            <span>${escapeHTML(detail)}</span>
        </div>
    `;
}

async function fetchCategoryMap() {
    if (!db) return {};
    try {
        const snapshot = await getDocs(query(collection(db, 'categories')));
        return snapshot.docs.reduce((acc, docSnap) => {
            acc[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
            return acc;
        }, {});
    } catch (error) {
        console.warn('Unable to load featured product categories:', error);
        return {};
    }
}

async function loadFeaturedProducts() {
    const grid = document.querySelector('#recommended-shop .shop-grid');
    if (!grid) return;
    if (!db) {
        renderFeaturedEmpty(grid, true);
        return;
    }

    try {
        const [categoryMap, productSnapshot] = await Promise.all([
            fetchCategoryMap(),
            getDocs(query(collection(db, 'products')))
        ]);
        const products = productSnapshot.docs
            .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
            .filter(shouldShowFeatured)
            .sort((a, b) => {
                const featuredOrder = safeNumber(a.featuredOrder ?? a.indexOrder ?? a.order, 999999) - safeNumber(b.featuredOrder ?? b.indexOrder ?? b.order, 999999);
                if (featuredOrder !== 0) return featuredOrder;
                return String(productName(a)).localeCompare(String(productName(b)), isEnglishPage() ? 'en' : 'th');
            })
            .slice(0, FEATURED_LIMIT);

        if (!products.length) {
            renderFeaturedEmpty(grid, false);
            return;
        }
        grid.classList.remove('featured-products-loading', 'featured-products-empty');
        grid.innerHTML = products.map(product => renderFeaturedCard(product, categoryMap)).join('');
    } catch (error) {
        console.error('Failed to load featured products:', error);
        renderFeaturedEmpty(grid, true);
    }
}

document.addEventListener('DOMContentLoaded', loadFeaturedProducts);
