import { auth, provider, db } from './firebase-config.js';
import qrcodeFactory from './qrcode-generator.esm.js';
import { signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs, doc, setDoc, addDoc, query, orderBy, onSnapshot, getDoc, serverTimestamp, runTransaction, where, limit, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
let openBillsUnsubscribe = null;
let posSelectedCategory = 'all';
let posSearchTerm = '';
let posCart = [];
let posLastReceipt = null;
let posSelectedCustomer = null;
let posOpenBills = [];
let posActiveBill = null;
let posControlsBound = false;
const POS_VIEW_KEY = 'edenPosActiveView';
const POS_PAYMENT_METHODS = {
    cash: { label: 'เงินสด', hint: 'รับเงินสดและคำนวณเงินทอน' },
    transfer: { label: 'โอนเงิน', hint: 'บันทึกเป็นการโอนเงิน' },
    qr: { label: 'QR Payment', hint: 'พร้อมต่อ PromptPay/Payment Gateway' },
    card: { label: 'บัตร', hint: 'บันทึกยอดชำระด้วยบัตร' },
    other: { label: 'อื่น ๆ', hint: 'ช่องทางชำระเงินอื่น' }
};
const POS_PROMPTPAY_ID = '057556001655';
const POS_PROMPTPAY_MERCHANT_NAME = 'EDEN CAFE';
const POS_PROMPTPAY_CITY = 'CHIANG RAI';
let posPromptPayRenderToken = 0;

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
    if (openBillsUnsubscribe) openBillsUnsubscribe();
    categoriesUnsubscribe = null;
    productsUnsubscribe = null;
    openBillsUnsubscribe = null;
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
function posTimestampMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function renderOpenBillsSnapshot(snapshot) {
    const docs = snapshot?.docs ? snapshot.docs : [];
    posOpenBills = docs
        .map(docSnap => ({ firestoreId: docSnap.id, ...(docSnap.data() || {}) }))
        .filter(order => order.source === 'pos' && order.billStatus === 'open' && order.paymentStatus !== 'paid')
        .sort((a, b) => posTimestampMillis(b.updatedAt || b.createdAt || b.timestamp) - posTimestampMillis(a.updatedAt || a.createdAt || a.timestamp));
    renderPosOpenBills();
}
async function refreshOpenBillsOnce() {
    const snapshot = await getDocs(query(collection(db, 'orders'), where('billStatus', '==', 'open'), limit(80)));
    renderOpenBillsSnapshot(snapshot);
}
function setupRealtimeOpenBills() {
    if (openBillsUnsubscribe) openBillsUnsubscribe();
    openBillsUnsubscribe = onSnapshot(query(collection(db, 'orders'), where('billStatus', '==', 'open'), limit(80)), renderOpenBillsSnapshot, error => {
        console.error('Error listening to POS open bills:', error);
        const container = document.getElementById('pos-open-bills-list');
        if (container) container.innerHTML = '<div class="pos-empty pos-error">โหลดบิลค้างชำระไม่สำเร็จ: ' + escapeHTML(error.message) + '</div>';
    });
}
function setPosAppReady(isReady) {
    document.body.classList.toggle('pos-ready', isReady);
    document.getElementById('pos-app')?.setAttribute('aria-hidden', isReady ? 'false' : 'true');
}
function normalizePosView(view) {
    return String(view || '').toLowerCase() === 'sales' ? 'sales' : 'overview';
}
function setPosView(view = 'overview', options = {}) {
    const activeView = normalizePosView(view);
    document.querySelectorAll('[data-pos-view]').forEach(section => {
        const isActive = section.dataset.posView === activeView;
        section.classList.toggle('active', isActive);
        section.hidden = !isActive;
    });
    document.querySelectorAll('[data-pos-target]').forEach(button => {
        const isActive = button.dataset.posTarget === activeView;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    document.body.dataset.posView = activeView;
    if (options.persist !== false) {
        try { sessionStorage.setItem(POS_VIEW_KEY, activeView); } catch (error) { console.warn('Unable to save POS view:', error); }
        const hash = activeView === 'sales' ? '#pos-sales' : '#pos-overview';
        if (window.location.hash !== hash) history.replaceState(null, '', hash);
    }
    if (activeView === 'sales') renderPosScreen();
}
function initialPosView() {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('view');
    if (requested) return normalizePosView(requested);
    if (window.location.hash === '#pos-sales') return 'sales';
    if (window.location.hash === '#pos-overview') return 'overview';
    try { return normalizePosView(sessionStorage.getItem(POS_VIEW_KEY)); } catch (error) { return 'overview'; }
}
function initPosViewSwitcher() {
    document.querySelectorAll('[data-pos-target]').forEach(button => {
        button.addEventListener('click', () => setPosView(button.dataset.posTarget || 'overview'));
    });
    document.querySelectorAll('[data-pos-open-view]').forEach(control => {
        control.addEventListener('click', () => setPosView(control.dataset.posOpenView || 'overview'));
    });
    setPosView(initialPosView(), { persist: false });
}
window.switchPosView = view => setPosView(view);
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
    initPosViewSwitcher();
    window.addEventListener('hashchange', () => {
        if (window.location.hash === '#pos-sales') setPosView('sales', { persist: false });
        if (window.location.hash === '#pos-overview') setPosView('overview', { persist: false });
    });

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
            setupRealtimeOpenBills();
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

function emvQrField(id, value) {
    const text = String(value ?? '');
    return String(id).padStart(2, '0') + String(text.length).padStart(2, '0') + text;
}

function promptPayProxyField(promptPayId = POS_PROMPTPAY_ID) {
    const id = String(promptPayId ?? '').replace(/\D/g, '');
    if (/^0\d{9}$/.test(id)) return emvQrField('01', '0066' + id.slice(1));
    if (/^\d{13}$/.test(id)) return emvQrField('02', id);
    if (/^\d{15}$/.test(id)) return emvQrField('03', id);
    return emvQrField('02', id);
}

function promptPayCrc16(payload) {
    let crc = 0xFFFF;
    for (let i = 0; i < payload.length; i += 1) {
        crc ^= payload.charCodeAt(i) << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildPromptPayPayload(amount) {
    const total = posRound(amount);
    const merchantInfo = emvQrField('00', 'A000000677010111') + promptPayProxyField(POS_PROMPTPAY_ID);
    let payload = ''
        + emvQrField('00', '01')
        + emvQrField('01', total > 0 ? '12' : '11')
        + emvQrField('29', merchantInfo)
        + emvQrField('53', '764');
    if (total > 0) payload += emvQrField('54', total.toFixed(2));
    payload += emvQrField('58', 'TH')
        + emvQrField('59', POS_PROMPTPAY_MERCHANT_NAME.slice(0, 25))
        + emvQrField('60', POS_PROMPTPAY_CITY.slice(0, 15))
        + '6304';
    return payload + promptPayCrc16(payload);
}

function setPromptPayStatus(message, state = '') {
    const status = document.getElementById('pos-promptpay-status');
    if (!status) return;
    status.textContent = message;
    status.className = ['pos-promptpay-status', state].filter(Boolean).join(' ');
}

async function createQrDataUrl(payload) {
    if (typeof qrcodeFactory === 'function') {
        const qr = qrcodeFactory(0, 'M');
        qr.addData(payload);
        qr.make();
        return qr.createDataURL(8, 1);
    }
    if (window.QRCode?.toDataURL) {
        return window.QRCode.toDataURL(payload, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 260,
            color: { dark: '#06351f', light: '#ffffff' }
        });
    }
    if (typeof window.qrcode === 'function') {
        const qr = window.qrcode(0, 'M');
        qr.addData(payload);
        qr.make();
        return qr.createDataURL(8, 1);
    }
    throw new Error('QR library is not available');
}

async function renderPosPromptPayQr(totals = posCartTotals()) {
    const panel = document.getElementById('pos-promptpay-panel');
    if (!panel) return;
    const isQrPayment = totals.paymentMethod === 'qr';
    panel.hidden = !isQrPayment;
    if (!isQrPayment) {
        posPromptPayRenderToken += 1;
        return;
    }

    const qrImg = document.getElementById('pos-promptpay-qr');
    const amountEl = document.getElementById('pos-promptpay-amount');
    const idEl = document.getElementById('pos-promptpay-id');
    const payloadEl = document.getElementById('pos-promptpay-payload');
    const amount = posRound(totals.total);

    if (idEl) idEl.textContent = POS_PROMPTPAY_ID;
    if (amountEl) amountEl.textContent = posMoney(amount);
    if (payloadEl) payloadEl.value = '';
    if (qrImg) qrImg.removeAttribute('src');

    if (!posCart.length || amount <= 0) {
        setPromptPayStatus('เลือกสินค้าเพื่อสร้าง QR ตามยอดชำระ', 'warning');
        return;
    }

    const payload = buildPromptPayPayload(amount);
    if (payloadEl) payloadEl.value = payload;

    const token = ++posPromptPayRenderToken;
    setPromptPayStatus('กำลังสร้าง QR พร้อมเพย์...', 'warning');
    try {
        const dataUrl = await createQrDataUrl(payload);
        if (token !== posPromptPayRenderToken) return;
        if (qrImg) qrImg.src = dataUrl;
        setPromptPayStatus('พร้อมสแกนชำระผ่าน PromptPay 057556001655', 'ready');
    } catch (error) {
        console.error('PromptPay QR generation failed:', error);
        setPromptPayStatus('สร้าง QR ไม่สำเร็จ: ' + error.message, 'error');
    }
}

function posLimitString(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function posNormalizePhone(value) {
    return String(value ?? '').replace(/[^\d+]/g, '').replace(/^\+66/, '0').replace(/[^\d]/g, '');
}

function posCustomerSearchText(customer = {}) {
    return [
        customer.uid,
        customer.displayName,
        customer.name,
        customer.email,
        customer.phone,
        customer.lineId,
        customer.memberCode
    ].filter(Boolean).join(' ').toLowerCase();
}

function posCleanCustomer(uid, data = {}) {
    const displayName = posLimitString(data.displayName || data.name || data.customerName || data.email || 'Eden Member', 120);
    const email = normalizeEmail(data.email);
    const phone = posLimitString(data.phone || data.mobile || data.tel || '', 40);
    return {
        uid,
        displayName,
        email,
        phone,
        phoneNormalized: posNormalizePhone(data.phoneNormalized || phone),
        photoURL: posLimitString(data.photoURL || data.avatarUrl || '', 500),
        memberCode: posLimitString(data.memberCode || '', 40),
        tier: posLimitString(data.tier || 'Silver', 30),
        points: safeNumber(data.points),
        totalSpent: safeNumber(data.totalSpent),
        visitCount: safeNumber(data.visitCount),
        lineId: posLimitString(data.lineId || '', 80),
        allergies: posLimitString(data.allergies || '', 200),
        healthNote: posLimitString(data.healthNote || '', 500)
    };
}

function posPaymentLabel(method) {
    return POS_PAYMENT_METHODS[method]?.label || method || '-';
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

function setPosCustomerStatus(message, state = '') {
    const el = document.getElementById('pos-customer-sync-status');
    if (!el) return;
    el.textContent = message;
    el.className = ['pos-sync-status', state].filter(Boolean).join(' ');
}

function renderPosCustomerCard() {
    const card = document.getElementById('pos-customer-card');
    if (!card) return;
    if (!posSelectedCustomer) {
        card.hidden = true;
        card.innerHTML = '';
        setPosCustomerStatus('ยังไม่ผูกสมาชิก: ระบบจะบันทึกเป็น Walk-in Customer');
        return;
    }
    const customer = posSelectedCustomer;
    card.hidden = false;
    card.innerHTML = `
        <div class="pos-customer-card-head">
            <div>
                <h4>${escapeHTML(customer.displayName || 'Eden Member')}</h4>
                <small>${escapeHTML(customer.email || customer.phone || customer.uid || '-')}</small>
            </div>
            <span class="pos-customer-badge">${escapeHTML(customer.tier || 'Silver')}</span>
        </div>
        <div class="pos-customer-card-meta">
            <span>รหัส: ${escapeHTML(customer.memberCode || customer.uid?.slice?.(0, 8) || '-')}</span>
            <span>แต้ม ${safeNumber(customer.points).toLocaleString('th-TH')}</span>
            <span>ใช้บริการ ${safeNumber(customer.visitCount).toLocaleString('th-TH')} ครั้ง</span>
            ${customer.lineId ? `<span>LINE: ${escapeHTML(customer.lineId)}</span>` : ''}
            ${customer.allergies ? `<span>แพ้: ${escapeHTML(customer.allergies)}</span>` : ''}
        </div>
        ${customer.healthNote ? `<small style="display:block;margin-top:10px;">หมายเหตุสุขภาพ: ${escapeHTML(customer.healthNote)}</small>` : ''}
        <button class="pos-customer-clear" type="button" onclick="clearPosCustomer()">ยกเลิกการผูกสมาชิก</button>
    `;
    setPosCustomerStatus('ซิงค์ข้อมูลสมาชิกแล้ว: ออเดอร์นี้จะผูกกับฐานข้อมูลลูกค้า', 'success');
}

async function queryPosCustomersByExact(searchTerm) {
    const raw = posLimitString(searchTerm, 180);
    const email = normalizeEmail(raw);
    const phone = posNormalizePhone(raw);
    const candidates = new Map();
    const queries = [];

    if (email && email.includes('@')) {
        queries.push(query(collection(db, 'users'), where('email', '==', email), limit(5)));
    }
    if (phone.length >= 6) {
        queries.push(query(collection(db, 'users'), where('phone', '==', raw), limit(5)));
        queries.push(query(collection(db, 'users'), where('phone', '==', phone), limit(5)));
        queries.push(query(collection(db, 'users'), where('phoneNormalized', '==', phone), limit(5)));
    }

    for (const customerQuery of queries) {
        try {
            const snap = await getDocs(customerQuery);
            snap.forEach(docSnap => candidates.set(docSnap.id, posCleanCustomer(docSnap.id, docSnap.data() || {})));
        } catch (error) {
            console.warn('Exact customer query failed:', error);
        }
    }
    return Array.from(candidates.values());
}

async function findPosCustomers(searchTerm) {
    const raw = posLimitString(searchTerm, 180);
    const term = raw.toLowerCase();
    const phone = posNormalizePhone(raw);
    if (!raw && !phone) return [];

    const exactMatches = await queryPosCustomersByExact(raw);
    if (exactMatches.length) return exactMatches;

    const snap = await getDocs(query(collection(db, 'users'), limit(120)));
    const matches = [];
    snap.forEach(docSnap => {
        const customer = posCleanCustomer(docSnap.id, docSnap.data() || {});
        const text = posCustomerSearchText(customer);
        const normalizedPhone = posNormalizePhone(customer.phoneNormalized || customer.phone);
        const phoneMatches = phone.length >= 4 && normalizedPhone.includes(phone);
        if (text.includes(term) || phoneMatches) matches.push(customer);
    });
    return matches.slice(0, 8);
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

function currentPosOrderItems() {
    return posCart.map(item => ({
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
}

function currentPosCustomerPayload() {
    return {
        customerName: posLimitString(document.getElementById('pos-customer-name')?.value, 120) || 'Walk-in Customer',
        phone: posLimitString(document.getElementById('pos-customer-phone')?.value, 40),
        customerUid: posLimitString(posSelectedCustomer?.uid, 120),
        customerEmail: posLimitString(posSelectedCustomer?.email, 180),
        customerLineId: posLimitString(posSelectedCustomer?.lineId, 80),
        customerTier: posLimitString(posSelectedCustomer?.tier, 30),
        customerMemberCode: posLimitString(posSelectedCustomer?.memberCode, 40),
        customerProfileSynced: !!posSelectedCustomer?.uid
    };
}

function buildPosCartItemFromOrderItem(item = {}, index = 0) {
    const productId = posLimitString(item.productId || item.id || ('open-bill-item-' + index), 120);
    const variantId = posVariantKey(item.variantId || item.variantName || 'base');
    return {
        key: `${productId}::${variantId}`,
        productId,
        variantId,
        name: item.name || productId,
        variantName: item.variantName || '',
        sku: item.sku || '',
        category: item.category || '',
        categoryName: categoryNameForProduct(productsData[productId] || { category: item.category }) || item.category || '',
        imageUrl: productsData[productId]?.imageUrl || '',
        price: safeNumber(item.price),
        cost: safeNumber(item.cost),
        taxEnabled: item.taxEnabled !== false,
        quantity: Math.max(1, safeNumber(item.quantity, 1))
    };
}

function setPosActiveBill(order = null) {
    posActiveBill = order ? { ...order } : null;
    renderPosActiveBill();
}

function renderPosActiveBill() {
    const container = document.getElementById('pos-active-bill');
    const openBtn = document.getElementById('pos-open-bill-btn');
    const checkoutBtn = document.getElementById('pos-checkout-btn');
    if (!container) return;
    if (!posActiveBill) {
        container.hidden = true;
        container.innerHTML = '';
        if (openBtn) openBtn.textContent = 'เปิดบิล / บันทึกค้างชำระ';
        if (checkoutBtn) checkoutBtn.textContent = 'ชำระเงินทันทีและออกใบเสร็จ';
        return;
    }
    container.hidden = false;
    container.innerHTML = `
        กำลังแก้บิลค้างชำระ ${escapeHTML(posActiveBill.receiptNo || posActiveBill.id || posActiveBill.firestoreId)}
        <small>${escapeHTML(posActiveBill.customerName || 'Walk-in Customer')} · กด "เปิดบิล" เพื่ออัปเดต หรือ "ชำระเงินทันที" เพื่อปิดยอด</small>
    `;
    if (openBtn) openBtn.textContent = 'อัปเดตบิลค้างชำระ';
    if (checkoutBtn) checkoutBtn.textContent = 'ชำระเงินปิดบิลและออกใบเสร็จ';
}

function renderPosOpenBills() {
    const container = document.getElementById('pos-open-bills-list');
    if (!container) return;
    if (!posOpenBills.length) {
        container.innerHTML = '<div class="pos-empty">ยังไม่มีบิลค้างชำระ</div>';
        return;
    }
    container.innerHTML = posOpenBills.map(order => {
        const active = posActiveBill?.firestoreId === order.firestoreId;
        const itemCount = Array.isArray(order.items) ? order.items.reduce((sum, item) => sum + safeNumber(item.quantity, 1), 0) : 0;
        const updated = posTimestampMillis(order.updatedAt || order.createdAt || order.timestamp);
        const updatedText = updated ? new Date(updated).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : order.date || '-';
        return `
            <article class="pos-open-bill-card ${active ? 'active' : ''}">
                <div class="pos-open-bill-top">
                    <strong>${escapeHTML(order.receiptNo || order.id || order.firestoreId)}</strong>
                    <strong>${posMoney(order.totalAmount ?? order.total)}</strong>
                </div>
                <small>${escapeHTML(order.customerName || 'Walk-in Customer')} · ${itemCount.toLocaleString('th-TH')} รายการ · ${escapeHTML(updatedText)}</small>
                <div class="pos-open-bill-actions">
                    <button class="pos-open-bill-load" type="button" onclick="loadPosOpenBill('${escapeJSString(order.firestoreId)}')">เรียกบิล</button>
                    <button class="pos-open-bill-pay" type="button" onclick="loadPosOpenBill('${escapeJSString(order.firestoreId)}', true)">เรียกมาชำระ</button>
                </div>
            </article>
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

function renderPosPaymentUI(totals = posCartTotals()) {
    const method = totals.paymentMethod || 'cash';
    document.querySelectorAll('.pos-payment-card').forEach(card => {
        const active = card.dataset.posPayment === method;
        card.classList.toggle('active', active);
        card.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const paidInput = document.getElementById('pos-paid-amount');
    const exactBtn = document.getElementById('pos-cash-exact-btn');
    if (paidInput) {
        paidInput.placeholder = method === 'cash' ? 'รับเงินมา' : 'บันทึกเต็มจำนวนอัตโนมัติ';
        paidInput.disabled = !posCart.length || method !== 'cash';
    }
    if (exactBtn) {
        exactBtn.style.display = method === 'cash' ? '' : 'none';
        exactBtn.disabled = !posCart.length;
    }
    renderPosPromptPayQr(totals);
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
    renderPosPaymentUI(totals);
    summary.innerHTML = `
        <div class="pos-summary-row"><span>ยอดก่อนส่วนลด</span><strong>${posMoney(totals.subtotal)}</strong></div>
        <div class="pos-summary-row"><span>ส่วนลด</span><strong>-${posMoney(totals.discount)}</strong></div>
        <div class="pos-summary-row"><span>VAT 7% รวมในราคา</span><strong>${posMoney(totals.taxIncluded)}</strong></div>
        <div class="pos-summary-row"><span>วิธีชำระเงิน</span><strong>${escapeHTML(posPaymentLabel(totals.paymentMethod))}</strong></div>
        <div class="pos-summary-row"><span>เงินทอน</span><strong>${posMoney(totals.changeAmount)}</strong></div>
        <div class="pos-summary-row total"><span>ยอดสุทธิ</span><strong>${posMoney(totals.total)}</strong></div>
    `;
    renderPosActiveBill();
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
    document.querySelectorAll('.pos-payment-card').forEach(card => {
        card.addEventListener('click', () => {
            const method = card.dataset.posPayment || 'cash';
            const select = document.getElementById('pos-payment-method');
            if (select) {
                select.value = method;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            renderPosCart();
        });
    });
    document.getElementById('pos-cash-exact-btn')?.addEventListener('click', () => {
        const paidInput = document.getElementById('pos-paid-amount');
        const totals = posCartTotals();
        if (paidInput) paidInput.value = totals.total ? String(totals.total) : '';
        renderPosCart();
    });
    document.getElementById('pos-customer-search')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            window.syncPosCustomer();
        }
    });
    ['pos-customer-name', 'pos-customer-phone'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => {
            if (!posSelectedCustomer) return;
            const name = document.getElementById('pos-customer-name')?.value || '';
            const phone = document.getElementById('pos-customer-phone')?.value || '';
            const sameName = !name || name === posSelectedCustomer.displayName;
            const samePhone = !phone || posNormalizePhone(phone) === posNormalizePhone(posSelectedCustomer.phone);
            if (!sameName || !samePhone) setPosCustomerStatus('มีการแก้ชื่อ/เบอร์หลังซิงค์ ระบบยังผูกสมาชิกเดิมไว้', 'warning');
        });
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

window.syncPosCustomer = async () => {
    const searchInput = document.getElementById('pos-customer-search');
    const nameInput = document.getElementById('pos-customer-name');
    const phoneInput = document.getElementById('pos-customer-phone');
    const button = document.getElementById('pos-customer-sync-btn');
    const searchTerm = posLimitString(searchInput?.value || phoneInput?.value || nameInput?.value, 180);
    if (!searchTerm) {
        setPosCustomerStatus('กรอกเบอร์ อีเมล หรือชื่อก่อนซิงค์ลูกค้า', 'warning');
        return;
    }
    const originalText = button?.textContent || '';
    try {
        if (button) {
            button.disabled = true;
            button.textContent = 'กำลังซิงค์...';
        }
        setPosCustomerStatus('กำลังค้นหาลูกค้าจากฐานข้อมูล...', 'warning');
        const matches = await findPosCustomers(searchTerm);
        if (!matches.length) {
            posSelectedCustomer = null;
            renderPosCustomerCard();
            setPosCustomerStatus('ไม่พบสมาชิกในฐานข้อมูล ระบบจะบันทึกเป็น Walk-in Customer', 'warning');
            return;
        }
        posSelectedCustomer = matches[0];
        if (searchInput) searchInput.value = posSelectedCustomer.email || posSelectedCustomer.phone || posSelectedCustomer.displayName || '';
        if (nameInput) nameInput.value = posSelectedCustomer.displayName || '';
        if (phoneInput) phoneInput.value = posSelectedCustomer.phone || '';
        renderPosCustomerCard();
    } catch (error) {
        console.error('Customer sync failed:', error);
        setPosCustomerStatus('ซิงค์ลูกค้าไม่สำเร็จ: ' + error.message, 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText || 'ซิงค์ลูกค้า';
        }
    }
};

window.clearPosCustomer = () => {
    posSelectedCustomer = null;
    const searchInput = document.getElementById('pos-customer-search');
    if (searchInput) searchInput.value = '';
    renderPosCustomerCard();
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
    setPosActiveBill(null);
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

function buildPosOrderFields(user, options = {}) {
    const totals = posCartTotals();
    const orderItems = currentPosOrderItems();
    const now = new Date();
    const receiptNo = options.receiptNo || generatePosReceiptNo();
    const paymentStatus = options.paymentStatus || 'paid';
    const pendingPayment = paymentStatus === 'pending';
    const paidAmount = pendingPayment
        ? 0
        : (totals.paymentMethod === 'cash' ? posRound(totals.paidAmount || totals.total) : totals.total);
    const changeAmount = pendingPayment
        ? 0
        : (totals.paymentMethod === 'cash' ? posRound(Math.max(paidAmount - totals.total, 0)) : 0);
    const isTestOrder = !!document.getElementById('pos-soft-launch-mode')?.checked;
    const customerPayload = currentPosCustomerPayload();

    return {
        totals,
        orderItems,
        isTestOrder,
        receiptNo,
        fields: {
            id: receiptNo,
            receiptNo,
            date: options.date || now.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }),
            source: 'pos',
            orderType: 'pos',
            status: options.status || 'completed',
            paymentStatus,
            paymentMethod: totals.paymentMethod,
            paymentLabel: posPaymentLabel(totals.paymentMethod),
            uid: user.uid,
            ...customerPayload,
            address: 'หน้าร้าน Eden Cafe',
            note: posLimitString(document.getElementById('pos-note')?.value, 500),
            items: orderItems,
            subtotal: totals.subtotal,
            discount: totals.discount,
            taxIncluded: totals.taxIncluded,
            total: totals.total,
            totalAmount: totals.total,
            paidAmount,
            changeAmount,
            cashierUid: user.uid,
            cashierName: posLimitString(user.displayName || user.email || 'Admin', 120),
            cashierEmail: posLimitString(user.email || '', 180),
            isTestOrder,
            softLaunch: isTestOrder,
            billStatus: options.billStatus || (pendingPayment ? 'open' : 'paid'),
            isOpenBill: options.isOpenBill ?? pendingPayment,
            orderMode: options.orderMode || (pendingPayment ? 'open_bill' : 'pay_now')
        }
    };
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

async function closePosOpenBillWithStock(orderId, orderData, items, isTestOrder) {
    const orderRef = doc(db, 'orders', orderId);
    if (isTestOrder) {
        const finalOrder = {
            ...orderData,
            stockAdjusted: false,
            stockAdjustments: [],
            stockMode: 'test-no-stock'
        };
        await updateDoc(orderRef, finalOrder);
        return { docRef: orderRef, orderData: finalOrder };
    }

    const committedOrder = await runTransaction(db, async (transaction) => {
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists()) throw new Error('ไม่พบบิลค้างชำระนี้');
        const currentOrder = orderSnap.data() || {};
        if (currentOrder.source !== 'pos') throw new Error('บิลนี้ไม่ใช่บิล POS');
        if (currentOrder.billStatus !== 'open' || currentOrder.paymentStatus === 'paid') {
            throw new Error('บิลนี้ถูกปิดยอดไปแล้ว');
        }

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
        transaction.update(orderRef, finalOrder);
        return finalOrder;
    });

    return { docRef: orderRef, orderData: committedOrder };
}

function applyPosOpenBillToForm(order = {}) {
    const nameInput = document.getElementById('pos-customer-name');
    const phoneInput = document.getElementById('pos-customer-phone');
    const searchInput = document.getElementById('pos-customer-search');
    const noteInput = document.getElementById('pos-note');
    const discountInput = document.getElementById('pos-discount');
    const paidInput = document.getElementById('pos-paid-amount');
    const paymentSelect = document.getElementById('pos-payment-method');

    if (nameInput) nameInput.value = order.customerName || '';
    if (phoneInput) phoneInput.value = order.phone || '';
    if (searchInput) searchInput.value = order.customerEmail || order.phone || order.customerName || '';
    if (noteInput) noteInput.value = order.note || '';
    if (discountInput) discountInput.value = order.discount ? String(order.discount) : '';
    if (paidInput) paidInput.value = '';
    if (paymentSelect && order.paymentMethod) paymentSelect.value = order.paymentMethod;

    posSelectedCustomer = order.customerProfileSynced || order.customerUid
        ? posCleanCustomer(order.customerUid || order.customerEmail || 'customer', {
            displayName: order.customerName,
            email: order.customerEmail,
            phone: order.phone,
            lineId: order.customerLineId,
            tier: order.customerTier,
            memberCode: order.customerMemberCode
        })
        : null;
    renderPosCustomerCard();
}

window.refreshPosOpenBills = async () => {
    const list = document.getElementById('pos-open-bills-list');
    if (list) list.innerHTML = '<div class="pos-empty">กำลังรีเฟรชบิลค้างชำระ...</div>';
    try {
        if (!openBillsUnsubscribe) setupRealtimeOpenBills();
        await refreshOpenBillsOnce();
    } catch (error) {
        console.error('Refresh open bills failed:', error);
        if (list) list.innerHTML = '<div class="pos-empty pos-error">รีเฟรชบิลไม่สำเร็จ: ' + escapeHTML(error.message) + '</div>';
    }
};

window.loadPosOpenBill = async (orderId, focusPayment = false) => {
    try {
        const orderSnap = await getDoc(doc(db, 'orders', orderId));
        if (!orderSnap.exists()) throw new Error('ไม่พบบิลนี้แล้ว');
        const order = { firestoreId: orderSnap.id, ...(orderSnap.data() || {}) };
        if (order.source !== 'pos' || order.billStatus !== 'open' || order.paymentStatus === 'paid') {
            throw new Error('บิลนี้ไม่อยู่ในสถานะค้างชำระ');
        }
        posCart = Array.isArray(order.items) ? order.items.map(buildPosCartItemFromOrderItem) : [];
        applyPosOpenBillToForm(order);
        setPosActiveBill(order);
        setPosView('sales');
        renderPosCart();
        renderPosOpenBills();
        if (focusPayment) {
            document.getElementById('pos-paid-amount')?.focus();
            alert('โหลดบิลแล้ว เลือกช่องทางชำระเงินและกด "ชำระเงินทันที" เพื่อปิดยอด');
        }
    } catch (error) {
        console.error('Load POS open bill failed:', error);
        alert('เรียกบิลค้างชำระไม่สำเร็จ: ' + error.message);
    }
};

window.savePosOpenBill = async () => {
    if (!posCart.length) {
        alert('กรุณาเพิ่มสินค้าในตะกร้าก่อนเปิดบิล');
        return;
    }
    const user = auth.currentUser;
    if (!user) {
        alert('กรุณาเข้าสู่ระบบแอดมินก่อนเปิดบิล');
        return;
    }
    const openBtn = document.getElementById('pos-open-bill-btn');
    const originalText = openBtn?.textContent || '';
    try {
        if (openBtn) {
            openBtn.disabled = true;
            openBtn.textContent = 'กำลังบันทึกบิล...';
        }
        const receiptNo = posActiveBill?.receiptNo || posActiveBill?.id || generatePosReceiptNo();
        const { fields } = buildPosOrderFields(user, {
            receiptNo,
            status: 'pending',
            paymentStatus: 'pending',
            billStatus: 'open',
            isOpenBill: true,
            orderMode: 'open_bill'
        });
        const billData = {
            ...fields,
            paidAmount: 0,
            changeAmount: 0,
            stockAdjusted: false,
            stockAdjustments: [],
            stockMode: 'open-bill-no-stock',
            updatedAt: serverTimestamp(),
            updatedBy: user.uid
        };

        if (posActiveBill?.firestoreId) {
            billData.uid = posActiveBill.uid || user.uid;
            await updateDoc(doc(db, 'orders', posActiveBill.firestoreId), billData);
            setPosActiveBill({ ...posActiveBill, ...billData, updatedAt: new Date() });
            alert('อัปเดตบิลค้างชำระแล้ว สามารถเรียกกลับมาแก้หรือปิดยอดได้');
        } else {
            const docRef = await addDoc(collection(db, 'orders'), {
                ...billData,
                uid: user.uid,
                timestamp: serverTimestamp(),
                createdAt: serverTimestamp(),
                openedAt: serverTimestamp()
            });
            setPosActiveBill({ firestoreId: docRef.id, ...billData, uid: user.uid, createdAt: new Date(), openedAt: new Date(), updatedAt: new Date() });
            alert('เปิดบิลค้างชำระแล้ว ลูกค้าสั่งเพิ่มได้เรื่อย ๆ');
        }
        renderPosCart();
        renderPosOpenBills();
        await refreshOpenBillsOnce().catch(error => console.warn('Unable to refresh open bills after save:', error));
    } catch (error) {
        console.error('Save POS open bill failed:', error);
        alert('บันทึกบิลค้างชำระไม่สำเร็จ: ' + error.message);
    } finally {
        if (openBtn) {
            openBtn.disabled = false;
            openBtn.textContent = originalText || 'เปิดบิล / บันทึกค้างชำระ';
        }
        renderPosActiveBill();
    }
};

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
        <div style="display:flex; justify-content:space-between;"><span>Payment</span><strong>${escapeHTML(order.paymentLabel || posPaymentLabel(order.paymentMethod) || '-')}</strong></div>
        <div style="display:flex; justify-content:space-between;"><span>Paid</span><strong>${posMoney(order.paidAmount)}</strong></div>
        <div style="display:flex; justify-content:space-between;"><span>Change</span><strong>${posMoney(order.changeAmount)}</strong></div>
        <div style="border-top:1px dashed #9aa; margin:10px 0;"></div>
        <div style="text-align:center;">ขอบคุณที่อุดหนุน Eden Cafe</div>
    `;
}

window.checkoutPosOrder = async () => {
    if (!posCart.length) {
        alert('กรุณาเพิ่มสินค้าในตะกร้าก่อนทำรายการ POS');
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
            checkoutBtn.textContent = posActiveBill ? 'กำลังปิดบิล...' : 'กำลังบันทึกออเดอร์...';
        }
        const totals = posCartTotals();
        if (totals.paymentMethod === 'cash' && totals.paidAmount > 0 && totals.paidAmount < totals.total) {
            throw new Error('จำนวนเงินที่รับมาต่ำกว่ายอดสุทธิ');
        }
        const receiptNo = posActiveBill?.receiptNo || posActiveBill?.id || generatePosReceiptNo();
        const { orderItems, isTestOrder, fields } = buildPosOrderFields(user, {
            receiptNo,
            status: 'completed',
            paymentStatus: 'paid',
            billStatus: 'paid',
            isOpenBill: false,
            orderMode: posActiveBill ? 'open_bill' : 'pay_now'
        });
        const orderData = {
            ...fields,
            closedAt: serverTimestamp(),
            closedBy: user.uid,
            closedByName: posLimitString(user.displayName || user.email || 'Admin', 120),
            updatedAt: serverTimestamp(),
            updatedBy: user.uid
        };
        if (!posActiveBill) {
            orderData.timestamp = serverTimestamp();
            orderData.createdAt = serverTimestamp();
        } else {
            orderData.uid = posActiveBill.uid || user.uid;
        }

        const wasOpenBill = !!posActiveBill?.firestoreId;
        const result = wasOpenBill
            ? await closePosOpenBillWithStock(posActiveBill.firestoreId, orderData, orderItems, isTestOrder)
            : await commitPosOrderWithStock(orderData, orderItems, isTestOrder);

        posLastReceipt = { ...result.orderData, firestoreId: result.docRef.id, timestamp: new Date(), createdAt: new Date() };
        const receipt = document.getElementById('pos-receipt');
        const printBtn = document.getElementById('pos-print-btn');
        if (receipt) {
            receipt.innerHTML = buildPosReceiptHTML(posLastReceipt);
            receipt.style.display = 'block';
        }
        if (printBtn) printBtn.style.display = 'block';
        posCart = [];
        setPosActiveBill(null);
        persistPosCart();
        renderPosCart();
        renderPosOpenBills();
        await refreshOpenBillsOnce().catch(error => console.warn('Unable to refresh open bills after checkout:', error));
        alert(wasOpenBill ? 'ปิดบิลและออกใบเสร็จสำเร็จ' : (isTestOrder ? 'บันทึกออเดอร์ทดสอบ POS สำเร็จ' : 'บันทึกออเดอร์ POS สำเร็จ'));
    } catch (error) {
        console.error('POS checkout failed:', error);
        alert('ทำรายการ POS ไม่สำเร็จ: ' + error.message);
    } finally {
        if (checkoutBtn) {
            checkoutBtn.disabled = false;
            checkoutBtn.textContent = originalText || 'ชำระเงินทันทีและออกใบเสร็จ';
        }
        renderPosActiveBill();
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
