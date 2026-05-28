import { auth, provider, db } from './firebase-config.js';
import { signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs, doc, setDoc, addDoc, query, orderBy, onSnapshot, getDoc, serverTimestamp, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const ADMIN_EMAILS = ['admin@edencafe.com', 'phoo1236@gmail.com', 'sonsawan.1231@gmail.com'];
const ADMIN_COLLECTION = 'admin_users';
const ADMIN_PERMISSION_LABELS = {
    dashboard: 'ภาพรวมระบบ', members: 'จัดการสมาชิก', pos: 'POS หน้าร้าน', orders: 'ออเดอร์สินค้า',
    bookings: 'คิวจองโต๊ะ/ห้อง', tables: 'จัดการโต๊ะ/โซน', rooms: 'จัดการห้องรับรอง',
    products: 'เมนูและหมวดหมู่', shop: 'สินค้าออนไลน์', blogs: 'บทความ', faqs: 'FAQ', footer: 'Footer'
};
const ADMIN_ROLE_LABELS = { owner: 'Owner', head_manager: 'Head Manager', manager: 'Manager' };
const ADMIN_ROLE_DEFAULT_PERMISSIONS = {
    owner: Object.fromEntries(Object.keys(ADMIN_PERMISSION_LABELS).map(key => [key, true])),
    head_manager: Object.fromEntries(Object.keys(ADMIN_PERMISSION_LABELS).map(key => [key, true])),
    manager: { dashboard: true, members: false, pos: true, orders: true, bookings: true, tables: false, rooms: false, products: false, shop: false, blogs: false, faqs: false, footer: false }
};

let currentAdminAccess = null;
let productsData = {};
let productRows = [];
let categoriesData = {};
let categoriesUnsubscribe = null;
let productsUnsubscribe = null;
let posSelectedCategory = 'all';
let posSearchTerm = '';
let posCart = [];
let posLastReceipt = null;
let posControlsBound = false;

function escapeHTML(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeImageURL(value, fallback = 'Images/Logo.webp') {
    const url = String(value ?? '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/?(Images|Hero)\//i.test(url)) return url;
    return fallback;
}
function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}
function escapeJSString(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function cleanMenuCell(value) { return String(value ?? '').trim(); }
function parseMenuNumber(value) {
    const text = cleanMenuCell(value).replace(/,/g, '');
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
}
function parseMenuBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value).trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 'เปิด', 'ใช่'].includes(text)) return true;
    if (['false', 'no', 'n', '0', 'off', 'ปิด', 'ไม่'].includes(text)) return false;
    return fallback;
}
function slugifyMenuHandle(value) {
    return String(value ?? '').trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ก-๙]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function variantIdFromName(name, index = 0) { return slugifyMenuHandle(name || 'variant-' + (index + 1)) || 'variant-' + (index + 1); }
function normalizeProductVariant(variant = {}, index = 0, baseProduct = {}) {
    const name = cleanMenuCell(variant.name ?? variant.variant ?? variant.value ?? variant.optionValue ?? variant.title ?? ('ตัวเลือก ' + (index + 1)));
    return {
        id: cleanMenuCell(variant.id) || variantIdFromName(name, index),
        name,
        availableForSale: parseMenuBoolean(variant.availableForSale ?? variant.available ?? variant.enabled, true),
        price: parseMenuNumber(variant.price ?? variant.salePrice) ?? safeNumber(baseProduct.price, 0),
        cost: parseMenuNumber(variant.cost ?? variant.Cost) ?? safeNumber(baseProduct.cost, 0),
        sku: cleanMenuCell(variant.sku ?? variant.SKU ?? variant.article),
        stock: parseMenuNumber(variant.stock ?? variant.inStock) ?? safeNumber(baseProduct.stock, 0),
        lowStock: parseMenuNumber(variant.lowStock) ?? safeNumber(baseProduct.lowStock, 0)
    };
}
function productVariantsForDisplay(product = {}) {
    if (Array.isArray(product.variants) && product.variants.length) return product.variants.map((variant, index) => normalizeProductVariant(variant, index, product));
    return Array.isArray(product.options)
        ? product.options.filter(option => option?.value).map((option, index) => normalizeProductVariant({ id: variantIdFromName(option.value, index), name: option.value, price: product.price, cost: product.cost, sku: index === 0 ? product.sku : '', stock: product.stock, lowStock: product.lowStock, availableForSale: product.availableForSale }, index, product))
        : [];
}
function categoryNameForProduct(product = {}) {
    const category = product.category || '';
    return categoriesData[category]?.name || category || '-';
}
function productSearchHaystack(row) {
    const product = row.product || {};
    return [row.id, product.name, product.nameEn, product.sku, product.handle, product.barcode, product.category, categoryNameForProduct(product), ...productVariantsForDisplay(product).flatMap(variant => [variant.name, variant.sku])].filter(Boolean).join(' ').toLowerCase();
}
function normalizeEmail(value) { return String(value ?? '').trim().toLowerCase(); }
function getAuthEmails(user) {
    const emails = new Set();
    const primaryEmail = normalizeEmail(user?.email);
    if (primaryEmail) emails.add(primaryEmail);
    (user?.providerData || []).forEach(profile => { const email = normalizeEmail(profile?.email); if (email) emails.add(email); });
    return Array.from(emails);
}
function isAdminUser(user) { return getAuthEmails(user).some(email => ADMIN_EMAILS.includes(email)); }
function adminRoleDefaults(role) { return { ...(ADMIN_ROLE_DEFAULT_PERMISSIONS[role] || ADMIN_ROLE_DEFAULT_PERMISSIONS.manager) }; }
function buildBootstrapOwnerAccess(user) {
    return { uid: user.uid, email: normalizeEmail(user.email), displayName: user.displayName || 'Owner', role: 'owner', status: 'active', permissions: adminRoleDefaults('owner'), source: 'bootstrap' };
}
async function loadAdminAccess(user) {
    if (!user) return null;
    if (isAdminUser(user)) return buildBootstrapOwnerAccess(user);
    const snap = await getDoc(doc(db, ADMIN_COLLECTION, user.uid));
    if (!snap.exists()) return null;
    const data = snap.data() || {};
    if (data.status !== 'active') return null;
    const role = ADMIN_ROLE_LABELS[data.role] ? data.role : 'manager';
    return { uid: user.uid, email: normalizeEmail(data.email || user.email), displayName: data.displayName || user.displayName || 'Manager', role, status: data.status, permissions: { ...adminRoleDefaults(role), ...(data.permissions || {}) }, source: 'firestore' };
}
async function ensureBootstrapOwnerRecord(user) {
    if (!user || !isAdminUser(user)) return;
    try {
        await setDoc(doc(db, ADMIN_COLLECTION, user.uid), { uid: user.uid, email: normalizeEmail(user.email), displayName: user.displayName || user.email || 'Owner', role: 'owner', status: 'active', permissions: adminRoleDefaults('owner'), updatedAt: serverTimestamp(), updatedBy: user.uid }, { merge: true });
    } catch (error) {
        console.warn('Unable to ensure bootstrap owner admin record:', error);
    }
}
function canAdmin(permission) {
    if (!currentAdminAccess || currentAdminAccess.status !== 'active') return false;
    if (currentAdminAccess.role === 'owner' || currentAdminAccess.role === 'head_manager') return true;
    return currentAdminAccess.permissions?.[permission] === true;
}
function cleanupRealtimeListeners() {
    if (categoriesUnsubscribe) categoriesUnsubscribe();
    if (productsUnsubscribe) productsUnsubscribe();
    categoriesUnsubscribe = null;
    productsUnsubscribe = null;
}
function renderCategoriesSnapshot(snapshot) {
    categoriesData = {};
    const docs = snapshot?.docs ? snapshot.docs.slice() : [];
    docs.sort((a, b) => {
        const aData = a.data() || {};
        const bData = b.data() || {};
        const aOrder = Number(aData.order || 999);
        const bOrder = Number(bData.order || 999);
        if (aOrder !== bOrder) return aOrder - bOrder;
        return String(aData.name || a.id).localeCompare(String(bData.name || b.id), 'th');
    });
    docs.forEach(docSnap => { categoriesData[docSnap.id] = docSnap.data() || {}; });
    renderPosScreen();
}
async function refreshCategoriesOnce() {
    const snapshot = await getDocs(query(collection(db, 'categories')));
    renderCategoriesSnapshot(snapshot);
}
function setupRealtimeCategories() {
    if (categoriesUnsubscribe) categoriesUnsubscribe();
    categoriesUnsubscribe = onSnapshot(query(collection(db, 'categories')), renderCategoriesSnapshot, error => {
        console.error('Error listening to categories:', error);
        const grid = document.getElementById('pos-product-grid');
        if (grid) grid.innerHTML = '<div class="pos-empty pos-error">โหลดหมวดหมู่ไม่สำเร็จ: ' + escapeHTML(error.message) + '</div>';
    });
}
function renderProductsSnapshot(snapshot) {
    productsData = {};
    productRows = [];
    if (!snapshot.empty) {
        snapshot.forEach(docSnap => {
            const product = docSnap.data() || {};
            productsData[docSnap.id] = product;
            productRows.push({ id: docSnap.id, product });
        });
    }
    renderPosScreen();
}
async function refreshProductsOnce() {
    const snapshot = await getDocs(query(collection(db, 'products'), orderBy('category')));
    renderProductsSnapshot(snapshot);
}
function setupRealtimeProducts() {
    if (productsUnsubscribe) productsUnsubscribe();
    productsUnsubscribe = onSnapshot(query(collection(db, 'products'), orderBy('category')), renderProductsSnapshot, error => {
        console.error('Error listening to products:', error);
        const grid = document.getElementById('pos-product-grid');
        if (grid) grid.innerHTML = '<div class="pos-empty pos-error">โหลดสินค้า POS ไม่สำเร็จ: ' + escapeHTML(error.message) + '</div>';
    });
}
function setPosAppReady(isReady) {
    document.body.classList.toggle('pos-ready', isReady);
    document.getElementById('pos-app')?.setAttribute('aria-hidden', isReady ? 'false' : 'true');
}
function showLoginError(message) {
    const loginError = document.getElementById('login-error');
    if (!loginError) return;
    loginError.textContent = message;
    loginError.style.display = 'block';
}
function clearLoginError() {
    const loginError = document.getElementById('login-error');
    if (loginError) loginError.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
    const loginScreen = document.getElementById('admin-login');
    const emailLoginForm = document.getElementById('email-login-form');
    const btnLogin = document.getElementById('btn-admin-login');
    const btnLogout = document.getElementById('btn-admin-logout');
    const adminName = document.getElementById('admin-name');
    const adminAvatar = document.getElementById('admin-avatar');

    getRedirectResult(auth).catch(error => {
        console.error('Google redirect login failed:', error);
        showLoginError('Google login failed: ' + error.message);
    });

    onAuthStateChanged(auth, async user => {
        if (!user) {
            currentAdminAccess = null;
            cleanupRealtimeListeners();
            setPosAppReady(false);
            if (loginScreen) loginScreen.style.display = 'flex';
            return;
        }
        try {
            currentAdminAccess = await loadAdminAccess(user);
            if (!currentAdminAccess || !canAdmin('pos')) {
                const shownEmail = getAuthEmails(user).join(', ') || user.email || '(no email returned from Firebase Auth)';
                showLoginError('บัญชีนี้ไม่มีสิทธิ์เข้าใช้งาน POS หน้าร้าน: ' + shownEmail);
                if (loginScreen) loginScreen.style.display = 'flex';
                setPosAppReady(false);
                await signOut(auth);
                return;
            }
            await ensureBootstrapOwnerRecord(user);
            if (loginScreen) loginScreen.style.display = 'none';
            if (adminName) adminName.textContent = (currentAdminAccess.displayName || user.displayName || 'Admin') + ' (' + (ADMIN_ROLE_LABELS[currentAdminAccess.role] || currentAdminAccess.role) + ')';
            if (adminAvatar) adminAvatar.src = user.photoURL || 'Images/Logo.webp';
            clearLoginError();
            setPosAppReady(true);
            setupRealtimeCategories();
            setupRealtimeProducts();
            initPosModule();
        } catch (error) {
            console.error('Unable to initialize POS:', error);
            showLoginError('ไม่สามารถตรวจสอบสิทธิ์ POS ได้: ' + error.message);
            if (loginScreen) loginScreen.style.display = 'flex';
            setPosAppReady(false);
        }
    });

    emailLoginForm?.addEventListener('submit', async event => {
        event.preventDefault();
        const email = document.getElementById('admin-email')?.value.trim() || '';
        const password = document.getElementById('admin-password')?.value || '';
        const button = document.getElementById('btn-email-login');
        const originalText = button?.textContent || '';
        if (button) { button.disabled = true; button.textContent = 'กำลังเข้าสู่ระบบ...'; }
        clearLoginError();
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (error) {
            console.error('Email login failed:', error);
            let message = 'เข้าสู่ระบบไม่สำเร็จ';
            if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(error.code)) message = 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
            else if (error.code === 'auth/too-many-requests') message = 'พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่';
            else if (error.code === 'auth/network-request-failed') message = 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต';
            else message = error.message;
            showLoginError(message);
        } finally {
            if (button) { button.disabled = false; button.textContent = originalText || 'เข้าสู่ระบบ'; }
        }
    });

    btnLogin?.addEventListener('click', async () => {
        clearLoginError();
        try {
            await signInWithPopup(auth, provider);
        } catch (error) {
            console.error('Google login failed:', error);
            if (error.code === 'auth/popup-blocked' || error.code === 'auth/popup-closed-by-user') {
                await signInWithRedirect(auth, provider);
                return;
            }
            showLoginError('เข้าสู่ระบบด้วย Google ไม่สำเร็จ: ' + error.message);
        }
    });

    btnLogout?.addEventListener('click', async () => {
        cleanupRealtimeListeners();
        await signOut(auth);
        window.location.reload();
    });
});

function posMoney(value) {
    return '฿' + safeNumber(value).toLocaleString('th-TH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function posRound(value) {
    return Math.round(safeNumber(value) * 100) / 100;
}

function posLimitString(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function posVariantKey(value) {
    return String(value ?? '').trim() || 'base';
}

function posStorageKey() {
    return 'edenAdminPosCartV1';
}

function restorePosCart() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(posStorageKey()) || '[]');
        posCart = Array.isArray(saved) ? saved.filter(item => item && item.key) : [];
    } catch (error) {
        console.warn('Unable to restore POS cart:', error);
        posCart = [];
    }
}

function persistPosCart() {
    try {
        sessionStorage.setItem(posStorageKey(), JSON.stringify(posCart));
    } catch (error) {
        console.warn('Unable to persist POS cart:', error);
    }
}

function posSellableVariants(product = {}) {
    const variants = productVariantsForDisplay(product).filter(variant => {
        if (variant.availableForSale === false) return false;
        return !product.trackStock || safeNumber(variant.stock) > 0;
    });
    if (variants.length) return variants;
    if (product.trackStock && safeNumber(product.stock) <= 0) return [];
    return [{
        id: 'base',
        name: '',
        price: safeNumber(product.price),
        cost: safeNumber(product.cost),
        sku: product.sku || '',
        stock: safeNumber(product.stock),
        lowStock: safeNumber(product.lowStock),
        availableForSale: product.availableForSale !== false
    }];
}

function posProductRows() {
    return productRows
        .filter(row => row?.product)
        .filter(row => row.product.availableForSale !== false)
        .filter(row => row.product.showOnPos !== false)
        .filter(row => posSellableVariants(row.product).some(variant => variant.availableForSale !== false))
        .sort((a, b) => String(a.product.name || '').localeCompare(String(b.product.name || ''), 'th'));
}

function filteredPosProductRows() {
    const search = posSearchTerm.trim().toLowerCase();
    return posProductRows()
        .filter(row => posSelectedCategory === 'all' || row.product.category === posSelectedCategory)
        .filter(row => !search || productSearchHaystack(row).includes(search));
}

function renderPosCategories(rows = posProductRows()) {
    const container = document.getElementById('pos-category-list');
    if (!container) return;
    const categories = new Map();
    rows.forEach(row => {
        const categoryId = row.product.category || 'other';
        categories.set(categoryId, categoriesData[categoryId]?.name || categoryId || 'ไม่ระบุ');
    });
    if (posSelectedCategory !== 'all' && !categories.has(posSelectedCategory)) {
        posSelectedCategory = 'all';
    }
    const sortedCategories = Array.from(categories.entries()).sort(([aId, aName], [bId, bName]) => {
        const aOrder = Number(categoriesData[aId]?.order || 999);
        const bOrder = Number(categoriesData[bId]?.order || 999);
        if (aOrder !== bOrder) return aOrder - bOrder;
        return String(aName).localeCompare(String(bName), 'th');
    });
    container.innerHTML = [
        `<button class="pos-category-btn ${posSelectedCategory === 'all' ? 'active' : ''}" type="button" onclick="setPosCategory('all')">ทั้งหมด</button>`,
        ...sortedCategories.map(([id, name]) => `
            <button class="pos-category-btn ${posSelectedCategory === id ? 'active' : ''}" type="button" onclick="setPosCategory('${escapeJSString(id)}')">${escapeHTML(name)}</button>
        `)
    ].join('');
}

function renderPosProducts() {
    const grid = document.getElementById('pos-product-grid');
    const count = document.getElementById('pos-product-count');
    if (!grid) return;
    const allRows = posProductRows();
    const rows = filteredPosProductRows();
    if (count) count.textContent = allRows.length.toLocaleString('th-TH');
    renderPosCategories(allRows);

    if (!rows.length) {
        grid.innerHTML = '<div class="pos-empty">ไม่พบสินค้า POS ตามเงื่อนไขที่เลือก</div>';
        return;
    }

    grid.innerHTML = rows.map(({ id, product }) => {
        const variants = posSellableVariants(product);
        const variantSelect = variants.length > 1 ? `
            <select class="pos-card-variant" aria-label="เลือกตัวเลือกสินค้า" onchange="updatePosCardPrice(this)">
                ${variants.map(variant => `
                    <option value="${escapeHTML(variant.id || variant.name || 'base')}" data-price="${escapeHTML(variant.price)}">${escapeHTML(variant.name || 'ปกติ')} - ${posMoney(variant.price)}</option>
                `).join('')}
            </select>
        ` : '';
        const firstVariant = variants[0] || {};
        const stockText = product.trackStock ? `คงเหลือ ${safeNumber(firstVariant.stock ?? product.stock).toLocaleString('th-TH')}` : categoryNameForProduct(product);
        return `
            <div class="pos-product-card" data-product-id="${escapeHTML(id)}">
                <img src="${escapeHTML(safeImageURL(product.imageUrl))}" alt="${escapeHTML(product.name || id)}" loading="lazy">
                <div class="pos-product-name">${escapeHTML(product.name || id)}</div>
                <div class="pos-product-meta">${escapeHTML(stockText || '-')}</div>
                ${variantSelect}
                <button class="pos-add-btn" type="button" data-default-label="เพิ่ม" onclick="addPosProductFromCard('${escapeJSString(id)}', this.closest('.pos-product-card'))">
                    เพิ่ม ${posMoney(firstVariant.price ?? product.price)}
                </button>
            </div>
        `;
    }).join('');
}

function posCartTotals() {
    const subtotal = posRound(posCart.reduce((sum, item) => sum + (safeNumber(item.price) * safeNumber(item.quantity, 1)), 0));
    const discountInput = document.getElementById('pos-discount');
    const paidInput = document.getElementById('pos-paid-amount');
    const paymentMethod = document.getElementById('pos-payment-method')?.value || 'cash';
    const discount = Math.min(Math.max(safeNumber(discountInput?.value), 0), subtotal);
    const total = posRound(Math.max(subtotal - discount, 0));
    const taxableSubtotal = posCart
        .filter(item => item.taxEnabled !== false)
        .reduce((sum, item) => sum + (safeNumber(item.price) * safeNumber(item.quantity, 1)), 0);
    const taxableAfterDiscount = subtotal > 0 ? Math.max(taxableSubtotal - (discount * (taxableSubtotal / subtotal)), 0) : 0;
    const taxIncluded = posRound(taxableAfterDiscount * 7 / 107);
    const paidAmount = safeNumber(paidInput?.value);
    const changeAmount = paymentMethod === 'cash' ? posRound(Math.max(paidAmount - total, 0)) : 0;
    return { subtotal, discount, total, taxableSubtotal, taxIncluded, paymentMethod, paidAmount, changeAmount };
}

function renderPosCart() {
    const container = document.getElementById('pos-cart-items');
    const summary = document.getElementById('pos-summary');
    if (!container || !summary) return;

    if (!posCart.length) {
        container.innerHTML = '<div class="pos-empty">ยังไม่มีสินค้าในตะกร้า</div>';
    } else {
        container.innerHTML = posCart.map(item => `
            <div class="pos-cart-row">
                <div>
                    <div class="pos-cart-title">${escapeHTML(item.name)}${item.variantName ? ` / ${escapeHTML(item.variantName)}` : ''}</div>
                    <div class="pos-cart-sub">${escapeHTML(item.sku || item.categoryName || '-')} · ${posMoney(item.price)} x ${safeNumber(item.quantity, 1).toLocaleString('th-TH')}</div>
                    <button class="pos-remove-btn" type="button" onclick="removePosCartItem('${escapeJSString(item.key)}')">ลบ</button>
                </div>
                <div class="pos-qty">
                    <button type="button" onclick="changePosCartQty('${escapeJSString(item.key)}', -1)">-</button>
                    <strong>${safeNumber(item.quantity, 1).toLocaleString('th-TH')}</strong>
                    <button type="button" onclick="changePosCartQty('${escapeJSString(item.key)}', 1)">+</button>
                </div>
            </div>
        `).join('');
    }

    const totals = posCartTotals();
    summary.innerHTML = `
        <div class="pos-summary-row"><span>ยอดก่อนส่วนลด</span><strong>${posMoney(totals.subtotal)}</strong></div>
        <div class="pos-summary-row"><span>ส่วนลด</span><strong>-${posMoney(totals.discount)}</strong></div>
        <div class="pos-summary-row"><span>VAT 7% รวมในราคา</span><strong>${posMoney(totals.taxIncluded)}</strong></div>
        <div class="pos-summary-row"><span>เงินทอน</span><strong>${posMoney(totals.changeAmount)}</strong></div>
        <div class="pos-summary-row total"><span>ยอดสุทธิ</span><strong>${posMoney(totals.total)}</strong></div>
    `;
    persistPosCart();
}

function renderPosScreen() {
    if (!document.getElementById('pos-product-grid')) return;
    renderPosProducts();
    renderPosCart();
}

function initPosModule() {
    if (posControlsBound) {
        renderPosScreen();
        return;
    }
    restorePosCart();
    document.getElementById('pos-search-input')?.addEventListener('input', (event) => {
        posSearchTerm = event.target.value || '';
        renderPosProducts();
    });
    ['pos-discount', 'pos-paid-amount', 'pos-payment-method'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', renderPosCart);
        document.getElementById(id)?.addEventListener('change', renderPosCart);
    });
    posControlsBound = true;
    renderPosScreen();
}

window.setPosCategory = (categoryId = 'all') => {
    posSelectedCategory = categoryId || 'all';
    renderPosProducts();
};

window.refreshPosProducts = async () => {
    if (!categoriesUnsubscribe) setupRealtimeCategories();
    if (!productsUnsubscribe) setupRealtimeProducts();
    await refreshCategoriesOnce();
    await refreshProductsOnce();
    renderPosScreen();
};

window.addPosProductFromCard = (productId, cardEl = null) => {
    const product = productsData[productId];
    if (!product) return;
    const variants = posSellableVariants(product);
    const selectedVariantId = cardEl?.querySelector('.pos-card-variant')?.value || variants[0]?.id || variants[0]?.name || 'base';
    const variant = variants.find(item => String(item.id || item.name || 'base') === String(selectedVariantId)) || variants[0] || {};
    const variantId = variant.id || variant.name || 'base';
    const key = `${productId}::${variantId}`;
    const existing = posCart.find(item => item.key === key);
    if (existing) {
        existing.quantity = safeNumber(existing.quantity, 1) + 1;
    } else {
        posCart.push({
            key,
            productId,
            variantId,
            name: product.name || productId,
            variantName: variant.name || '',
            sku: variant.sku || product.sku || '',
            category: product.category || '',
            categoryName: categoryNameForProduct(product),
            imageUrl: product.imageUrl || '',
            price: safeNumber(variant.price, safeNumber(product.price)),
            cost: safeNumber(variant.cost, safeNumber(product.cost)),
            taxEnabled: product.taxEnabled !== false,
            quantity: 1
        });
    }
    renderPosCart();
};

window.updatePosCardPrice = (selectEl) => {
    const card = selectEl?.closest?.('.pos-product-card');
    const button = card?.querySelector?.('.pos-add-btn');
    const price = selectEl?.selectedOptions?.[0]?.dataset?.price;
    if (button && price !== undefined) button.textContent = `เพิ่ม ${posMoney(price)}`;
};

window.changePosCartQty = (key, delta) => {
    posCart = posCart.map(item => {
        if (item.key !== key) return item;
        return { ...item, quantity: Math.max(1, safeNumber(item.quantity, 1) + delta) };
    });
    renderPosCart();
};

window.removePosCartItem = (key) => {
    posCart = posCart.filter(item => item.key !== key);
    renderPosCart();
};

window.clearPosCart = () => {
    if (posCart.length && !confirm('ล้างตะกร้า POS นี้หรือไม่?')) return;
    posCart = [];
    posLastReceipt = null;
    const receipt = document.getElementById('pos-receipt');
    const printBtn = document.getElementById('pos-print-btn');
    if (receipt) {
        receipt.style.display = 'none';
        receipt.innerHTML = '';
    }
    if (printBtn) printBtn.style.display = 'none';
    renderPosCart();
};

function generatePosReceiptNo() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `POS-${datePart}-${timePart}`;
}

function groupedPosItemsForStock(items = []) {
    const grouped = new Map();
    items.forEach(item => {
        const productId = String(item.productId || '').trim();
        if (!productId) return;
        const variantId = posVariantKey(item.variantId);
        const key = `${productId}::${variantId}`;
        const quantity = Math.max(0, safeNumber(item.quantity, 1));
        if (!quantity) return;
        const current = grouped.get(key) || {
            productId,
            variantId,
            sku: item.sku || '',
            name: item.name || productId,
            variantName: item.variantName || '',
            quantity: 0
        };
        current.quantity += quantity;
        grouped.set(key, current);
    });
    return Array.from(grouped.values());
}

function findStockVariantIndex(variants = [], entry = {}) {
    const variantId = posVariantKey(entry.variantId);
    const sku = String(entry.sku || '').trim();
    const variantName = String(entry.variantName || '').trim();
    let index = variants.findIndex(variant => posVariantKey(variant.id) === variantId);
    if (index >= 0) return index;
    if (sku) {
        index = variants.findIndex(variant => String(variant.sku || '').trim() === sku);
        if (index >= 0) return index;
    }
    if (variantName) {
        index = variants.findIndex(variant => String(variant.name || '').trim() === variantName);
        if (index >= 0) return index;
    }
    return -1;
}

function nextTrackedStockValue(current, delta, label) {
    const beforeStock = safeNumber(current);
    const afterStock = posRound(beforeStock + delta);
    if (afterStock < 0) {
        throw new Error(`${label} สต็อกไม่พอ เหลือ ${beforeStock.toLocaleString('th-TH')}`);
    }
    return { beforeStock, afterStock };
}

function buildStockUpdateForProduct(productId, product = {}, entries = [], direction = -1) {
    if (!product.trackStock) return { update: null, adjustments: [] };

    const variants = Array.isArray(product.variants)
        ? product.variants.map(variant => ({ ...variant }))
        : [];
    const adjustments = [];
    let productStock = safeNumber(product.stock);

    if (variants.length) {
        entries.forEach(entry => {
            const variantIndex = findStockVariantIndex(variants, entry);
            if (variantIndex < 0) {
                throw new Error(`ไม่พบตัวเลือกสินค้า ${entry.name || productId} สำหรับตัดสต็อก`);
            }
            const variant = variants[variantIndex];
            const quantityDelta = direction * Math.max(0, safeNumber(entry.quantity, 1));
            const stock = nextTrackedStockValue(variant.stock ?? product.stock, quantityDelta, `${entry.name}${entry.variantName ? ' / ' + entry.variantName : ''}`);
            variant.stock = stock.afterStock;
            variants[variantIndex] = variant;
            adjustments.push({
                productId,
                variantId: posVariantKey(variant.id || entry.variantId),
                sku: variant.sku || entry.sku || '',
                name: entry.name || product.name || productId,
                variantName: variant.name || entry.variantName || '',
                quantity: Math.max(0, safeNumber(entry.quantity, 1)),
                beforeStock: stock.beforeStock,
                afterStock: stock.afterStock
            });
        });
        productStock = variants.reduce((sum, variant) => sum + Math.max(0, safeNumber(variant.stock)), 0);
    } else {
        const totalQuantity = entries.reduce((sum, entry) => sum + Math.max(0, safeNumber(entry.quantity, 1)), 0);
        const stock = nextTrackedStockValue(product.stock, direction * totalQuantity, product.name || productId);
        productStock = stock.afterStock;
        adjustments.push({
            productId,
            variantId: 'base',
            sku: product.sku || entries[0]?.sku || '',
            name: product.name || entries[0]?.name || productId,
            variantName: '',
            quantity: totalQuantity,
            beforeStock: stock.beforeStock,
            afterStock: stock.afterStock
        });
    }

    const update = {
        stock: productStock,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser?.uid || '',
        stockUpdatedAt: serverTimestamp(),
        stockUpdatedBy: auth.currentUser?.uid || ''
    };
    if (variants.length) update.variants = variants;
    return { update, adjustments };
}

async function commitPosOrderWithStock(orderData, items, isTestOrder) {
    if (isTestOrder) {
        const docRef = await addDoc(collection(db, 'orders'), {
            ...orderData,
            stockAdjusted: false,
            stockAdjustments: [],
            stockMode: 'test-no-stock'
        });
        return { docRef, orderData: { ...orderData, stockAdjusted: false, stockAdjustments: [], stockMode: 'test-no-stock' } };
    }

    const orderRef = doc(collection(db, 'orders'));
    const committedOrder = await runTransaction(db, async (transaction) => {
        const stockEntries = groupedPosItemsForStock(items);
        const byProduct = new Map();
        stockEntries.forEach(entry => {
            const list = byProduct.get(entry.productId) || [];
            list.push(entry);
            byProduct.set(entry.productId, list);
        });

        const productSnapshots = new Map();
        for (const productId of byProduct.keys()) {
            const productRef = doc(db, 'products', productId);
            const productSnap = await transaction.get(productRef);
            if (!productSnap.exists()) {
                throw new Error(`ไม่พบสินค้า ${productId} ในระบบ`);
            }
            productSnapshots.set(productId, { ref: productRef, data: productSnap.data() || {} });
        }

        const stockAdjustments = [];
        productSnapshots.forEach(({ ref, data }, productId) => {
            const result = buildStockUpdateForProduct(productId, data, byProduct.get(productId) || [], -1);
            if (result.update) {
                transaction.update(ref, result.update);
                stockAdjustments.push(...result.adjustments);
            }
        });

        const finalOrder = {
            ...orderData,
            stockAdjusted: stockAdjustments.length > 0,
            stockAdjustments,
            stockMode: stockAdjustments.length ? 'auto' : 'not-tracked'
        };
        transaction.set(orderRef, finalOrder);
        return finalOrder;
    });

    return { docRef: orderRef, orderData: committedOrder };
}

async function restorePosOrderStock(orderId, reason = '') {
    const user = auth.currentUser;
    if (!user) throw new Error('กรุณาเข้าสู่ระบบแอดมินก่อน Void ออเดอร์');

    await runTransaction(db, async (transaction) => {
        const orderRef = doc(db, 'orders', orderId);
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists()) throw new Error('ไม่พบออเดอร์นี้');
        const order = orderSnap.data() || {};
        if (order.source !== 'pos') throw new Error('Void แบบคืนสต็อกใช้กับออเดอร์ POS เท่านั้น');
        if (order.status === 'cancelled' && order.voidedStockRestored) {
            throw new Error('ออเดอร์นี้ถูก Void และคืนสต็อกแล้ว');
        }

        const stockEntries = order.stockAdjusted && !order.isTestOrder
            ? groupedPosItemsForStock(order.items || [])
            : [];
        const byProduct = new Map();
        stockEntries.forEach(entry => {
            const list = byProduct.get(entry.productId) || [];
            list.push(entry);
            byProduct.set(entry.productId, list);
        });

        const productSnapshots = new Map();
        for (const productId of byProduct.keys()) {
            const productRef = doc(db, 'products', productId);
            const productSnap = await transaction.get(productRef);
            if (!productSnap.exists()) {
                throw new Error(`ไม่พบสินค้า ${productId} สำหรับคืนสต็อก`);
            }
            productSnapshots.set(productId, { ref: productRef, data: productSnap.data() || {} });
        }

        const restoredAdjustments = [];
        productSnapshots.forEach(({ ref, data }, productId) => {
            const result = buildStockUpdateForProduct(productId, data, byProduct.get(productId) || [], 1);
            if (result.update) {
                transaction.update(ref, result.update);
                restoredAdjustments.push(...result.adjustments);
            }
        });

        transaction.update(orderRef, {
            status: 'cancelled',
            paymentStatus: 'refunded',
            voidReason: posLimitString(reason, 300) || 'Void POS order',
            voidedAt: serverTimestamp(),
            voidedBy: user.uid,
            voidedByName: posLimitString(user.displayName || user.email || 'Admin', 120),
            voidedByEmail: posLimitString(user.email || '', 180),
            voidedStockRestored: restoredAdjustments.length > 0,
            stockRestoreAdjustments: restoredAdjustments,
            updatedAt: serverTimestamp()
        });
    });
}

function buildPosReceiptHTML(order = {}) {
    const items = Array.isArray(order.items) ? order.items : [];
    return `
        <div style="text-align:center; font-weight:900; font-size:1rem;">Eden Cafe</div>
        <div style="text-align:center;">ใบเสร็จรับเงิน${order.isTestOrder ? ' (TEST)' : ''}</div>
        <div style="border-top:1px dashed #9aa; margin:10px 0;"></div>
        <div>เลขที่: ${escapeHTML(order.receiptNo || '-')}</div>
        <div>เวลา: ${escapeHTML(order.date || '-')}</div>
        <div>แคชเชียร์: ${escapeHTML(order.cashierName || '-')}</div>
        <div style="border-top:1px dashed #9aa; margin:10px 0;"></div>
        ${items.map(item => `
            <div style="display:flex; justify-content:space-between; gap:10px;">
                <span>${escapeHTML(item.name)}${item.variantName ? ` / ${escapeHTML(item.variantName)}` : ''} x${safeNumber(item.quantity, 1)}</span>
                <strong>${posMoney(item.lineTotal)}</strong>
            </div>
        `).join('')}
        <div style="border-top:1px dashed #9aa; margin:10px 0;"></div>
        <div style="display:flex; justify-content:space-between;"><span>Subtotal</span><strong>${posMoney(order.subtotal)}</strong></div>
        <div style="display:flex; justify-content:space-between;"><span>Discount</span><strong>-${posMoney(order.discount)}</strong></div>
        <div style="display:flex; justify-content:space-between;"><span>VAT included</span><strong>${posMoney(order.taxIncluded)}</strong></div>
        <div style="display:flex; justify-content:space-between; font-size:1.05rem;"><span>Total</span><strong>${posMoney(order.totalAmount)}</strong></div>
        <div style="display:flex; justify-content:space-between;"><span>Payment</span><strong>${escapeHTML(order.paymentMethod || '-')}</strong></div>
        <div style="display:flex; justify-content:space-between;"><span>Paid</span><strong>${posMoney(order.paidAmount)}</strong></div>
        <div style="display:flex; justify-content:space-between;"><span>Change</span><strong>${posMoney(order.changeAmount)}</strong></div>
        <div style="border-top:1px dashed #9aa; margin:10px 0;"></div>
        <div style="text-align:center;">ขอบคุณที่อุดหนุน Eden Cafe</div>
    `;
}

window.checkoutPosOrder = async () => {
    if (!posCart.length) {
        alert('กรุณาเพิ่มสินค้าในตะกร้าก่อนบันทึกออเดอร์');
        return;
    }
    const user = auth.currentUser;
    if (!user) {
        alert('กรุณาเข้าสู่ระบบแอดมินก่อนทำรายการ POS');
        return;
    }
    const checkoutBtn = document.getElementById('pos-checkout-btn');
    const originalText = checkoutBtn?.textContent || '';
    try {
        if (checkoutBtn) {
            checkoutBtn.disabled = true;
            checkoutBtn.textContent = 'กำลังบันทึกออเดอร์...';
        }
        const totals = posCartTotals();
        if (totals.paymentMethod === 'cash' && totals.paidAmount > 0 && totals.paidAmount < totals.total) {
            throw new Error('จำนวนเงินที่รับมาต่ำกว่ายอดสุทธิ');
        }
        const isTestOrder = !!document.getElementById('pos-soft-launch-mode')?.checked;
        const receiptNo = generatePosReceiptNo();
        const now = new Date();
        const orderItems = posCart.map(item => ({
            productId: item.productId,
            variantId: item.variantId,
            name: item.name,
            variantName: item.variantName || '',
            sku: item.sku || '',
            category: item.category || '',
            price: posRound(item.price),
            cost: posRound(item.cost),
            quantity: safeNumber(item.quantity, 1),
            lineTotal: posRound(safeNumber(item.price) * safeNumber(item.quantity, 1)),
            taxEnabled: item.taxEnabled !== false
        }));
        const orderData = {
            id: receiptNo,
            receiptNo,
            date: now.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }),
            source: 'pos',
            orderType: 'pos',
            status: 'completed',
            paymentStatus: 'paid',
            paymentMethod: totals.paymentMethod,
            uid: user.uid,
            customerName: posLimitString(document.getElementById('pos-customer-name')?.value, 120) || 'Walk-in Customer',
            phone: posLimitString(document.getElementById('pos-customer-phone')?.value, 40),
            address: 'หน้าร้าน Eden Cafe',
            note: posLimitString(document.getElementById('pos-note')?.value, 500),
            items: orderItems,
            subtotal: totals.subtotal,
            discount: totals.discount,
            taxIncluded: totals.taxIncluded,
            total: totals.total,
            totalAmount: totals.total,
            paidAmount: totals.paidAmount || totals.total,
            changeAmount: totals.changeAmount,
            cashierUid: user.uid,
            cashierName: posLimitString(user.displayName || user.email || 'Admin', 120),
            cashierEmail: posLimitString(user.email || '', 180),
            isTestOrder,
            softLaunch: isTestOrder,
            timestamp: serverTimestamp(),
            createdAt: serverTimestamp()
        };
        const result = await commitPosOrderWithStock(orderData, orderItems, isTestOrder);
        posLastReceipt = { ...result.orderData, firestoreId: result.docRef.id, timestamp: new Date(), createdAt: new Date() };
        const receipt = document.getElementById('pos-receipt');
        const printBtn = document.getElementById('pos-print-btn');
        if (receipt) {
            receipt.innerHTML = buildPosReceiptHTML(posLastReceipt);
            receipt.style.display = 'block';
        }
        if (printBtn) printBtn.style.display = 'block';
        posCart = [];
        persistPosCart();
        renderPosCart();
        alert(isTestOrder ? 'บันทึกออเดอร์ทดสอบ POS สำเร็จ' : 'บันทึกออเดอร์ POS สำเร็จ');
    } catch (error) {
        console.error('POS checkout failed:', error);
        alert('บันทึกออเดอร์ POS ไม่สำเร็จ: ' + error.message);
    } finally {
        if (checkoutBtn) {
            checkoutBtn.disabled = false;
            checkoutBtn.textContent = originalText || 'บันทึกออเดอร์และออกใบเสร็จ';
        }
    }
};

window.printPosReceipt = () => {
    if (!posLastReceipt) {
        alert('ยังไม่มีใบเสร็จล่าสุดให้พิมพ์');
        return;
    }
    const printWindow = window.open('', '_blank', 'width=420,height=720');
    if (!printWindow) {
        alert('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาต Pop-up');
        return;
    }
    printWindow.document.write(`
        <!doctype html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>${escapeHTML(posLastReceipt.receiptNo || 'POS Receipt')}</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 18px; color: #111; }
                @media print { body { margin: 0; } }
            </style>
        </head>
        <body>${buildPosReceiptHTML(posLastReceipt)}</body>
        </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
};

document.documentElement.dataset.posModule = 'ready';
