import { auth, provider, db } from './firebase-config.js';
import { getMemberTier, getTierBenefits } from './membership.js';
import { BLOG_POSTS, SITE, getBlogUrl } from './blog-data.mjs';
import { signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs, doc, setDoc, addDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot, getDoc, serverTimestamp, writeBatch, runTransaction, limit } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const ADMIN_IMAGE_MAX_FILE_SIZE = 8 * 1024 * 1024;
const ADMIN_IMAGE_MAX_EDGE = 1800;

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

function safeAdminError(action = 'ดำเนินการไม่สำเร็จ') {
    return `${action} กรุณาตรวจสอบสิทธิ์หรือข้อมูลที่จำเป็น แล้วลองใหม่อีกครั้ง`;
}

function adminFunctionErrorMessage(result = {}) {
    const code = String(result.code || result.error || '').toUpperCase();
    const map = {
        NO_LANE_AVAILABLE: 'เวลานี้ช่องยิงเต็มแล้ว กรุณาเลือกเวลาอื่น',
        CONFLICT: 'เวลานี้ช่องยิงเต็มแล้ว กรุณาเลือกเวลาอื่น',
        PAYMENT_ALREADY_RECORDED: 'รายการนี้มีการชำระเงินแล้ว',
        STAFF_SESSION_REQUIRED: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่',
        AUTH_REQUIRED: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่',
        STAFF_PERMISSION_REQUIRED: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
        PERMISSION_DENIED: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
        'PERMISSION-DENIED': 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
        IDEMPOTENCY_KEY_REQUIRED: 'ระบบยังไม่พร้อมทำรายการ กรุณาลองใหม่อีกครั้ง',
        IDEMPOTENCY_PAYLOAD_MISMATCH: 'รายการนี้ถูกส่งซ้ำด้วยข้อมูลไม่ตรงกัน กรุณารีเฟรชแล้วลองใหม่',
        INVALID_DURATION: 'แพ็กเกจต้องเป็น 60 / 120 / 180 นาที',
        OUTSIDE_OPERATING_HOURS: 'เวลาจองต้องอยู่ในช่วง 10:00-20:00',
        MEMBER_NOT_FOUND: 'ไม่พบสมาชิก Eden ที่ระบุ',
        BOOKING_NOT_FOUND: 'ไม่พบรายการจองนี้',
        BOOKING_STATE_DOES_NOT_ALLOW_ACTION: 'สถานะรายการจองไม่รองรับคำสั่งนี้',
        REASON_REQUIRED: 'กรุณาระบุเหตุผล',
        PAYMENT_REQUIRED: 'ไม่พบข้อมูลการชำระเงินของรายการนี้'
    };
    return map[code] || result.message || result.error || 'Request failed';
}

function escapeJSString(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function compressToWebP(file, quality = 0.8) {
    return new Promise((resolve, reject) => {
        if (!file || !/^image\//i.test(file.type || '')) {
            reject(new Error('กรุณาเลือกไฟล์รูปภาพเท่านั้น'));
            return;
        }
        if (file.size > ADMIN_IMAGE_MAX_FILE_SIZE) {
            reject(new Error('รูปภาพใหญ่เกินไป กรุณาใช้ไฟล์ไม่เกิน 8MB'));
            return;
        }

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = event => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const scale = Math.min(1, ADMIN_IMAGE_MAX_EDGE / Math.max(img.width, img.height));
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('แปลงรูปภาพไม่สำเร็จ'));
                        return;
                    }
                    resolve(blob);
                }, 'image/webp', quality);
            };
            img.onerror = error => reject(error);
        };
        reader.onerror = error => reject(error);
    });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = error => reject(error);
        reader.readAsDataURL(blob);
    });
}

async function uploadAdminImage(blob, folder, fileName) {
    const token = await auth.currentUser?.getIdToken(true);
    if (!token) throw new Error('Please sign in as admin before uploading images');

    const response = await fetch(FUNCTIONS_BASE_URL + '/uploadSpaceshipImage', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            folder,
            fileName,
            mimeType: blob.type || 'image/webp',
            imageBase64: await blobToBase64(blob)
        })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) throw new Error(result.error || 'Spaceship image upload failed');
    return result.url;
}

async function callAdminFunction(functionName, payload = {}) {
    const token = await auth.currentUser?.getIdToken(true);
    if (!token) throw new Error('Please sign in as admin again before continuing');
    const requestId = payload.idempotency_key || payload.idempotencyKey || `admin-${functionName}-${Date.now()}`;

    const response = await fetch(FUNCTIONS_BASE_URL + '/' + functionName, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'X-Request-Id': requestId
        },
        body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(adminFunctionErrorMessage(result));
        error.code = result.code || result.error || '';
        error.status = response.status;
        error.details = result.details;
        throw error;
    }
    return result;
}


const ADMIN_EMAILS = ['admin@edencafe.com', 'phoo1236@gmail.com', 'sonsawan.1231@gmail.com'];
const FUNCTIONS_BASE_URL = 'https://asia-southeast1-edencafe-d9095.cloudfunctions.net';
const ADMIN_COLLECTION = 'admin_users';
const ADMIN_PERMISSION_LABELS = {
    dashboard: 'ภาพรวมระบบ',
    members: 'จัดการสมาชิก',
    pos: 'Eden POS APK',
    discounts: 'จัดการส่วนลด',
    loyalty: 'จัดการแต้มสมาชิก',
    orders: 'ออเดอร์สินค้า',
    bookings: 'คิวจองโต๊ะ/ห้อง',
    tables: 'จัดการโต๊ะ/โซน',
    rooms: 'จัดการห้องรับรอง',
    products: 'เมนูและหมวดหมู่',
    blogs: 'บทความ',
    faqs: 'FAQ',
    promptpay: '\u0e08\u0e31\u0e14\u0e01\u0e32\u0e23\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e40\u0e1e\u0e22\u0e4c',
    marketing: 'Marketing Tools',
    index: '\u0e08\u0e31\u0e14\u0e01\u0e32\u0e23 Index',
    footer: 'Footer'
};
const ADMIN_PERMISSION_HELP = {
    pos: 'อนุญาตให้ล็อกอิน Eden POS APK และซิงค์บิล/ใบเสร็จหน้าร้าน'
};
const ADMIN_ROLE_LABELS = {
    owner: 'Owner',
    head_manager: 'Head Manager',
    manager: 'Manager'
};
const STAFF_ROLE_LABELS = {
    staff: 'Staff'
};
const ADMIN_ROLE_DEFAULT_PERMISSIONS = {
    owner: Object.fromEntries(Object.keys(ADMIN_PERMISSION_LABELS).map(key => [key, true])),
    head_manager: Object.fromEntries(Object.keys(ADMIN_PERMISSION_LABELS).map(key => [key, true])),
    manager: {
        dashboard: true,
        members: false,
        pos: false,
        discounts: false,
        loyalty: false,
        orders: true,
        bookings: true,
        tables: false,
        rooms: false,
        products: false,
        blogs: false,
        faqs: false,
        promptpay: false,
        marketing: false,
        index: false,
        footer: false
    }
};
const ADMIN_TAB_PERMISSIONS = {
    dashboard: 'dashboard',
    pos: 'pos',
    'pos-apk-updates': 'pos',
    discounts: 'discounts',
    members: 'members',
    loyalty: 'loyalty',
    'admin-access': 'adminAccess',
    orders: 'orders',
    bookings: 'bookings',
    'room-bookings': 'bookings',
    archery: 'bookings',
    'all-bookings': 'bookings',
    tables: 'tables',
    rooms: 'rooms',
    products: 'products',
    categories: 'products',
    blogs: 'blogs',
    faqs: 'faqs',
    promptpay: 'promptpay',
    'index-settings': 'index',
    'marketing-settings': 'marketing',
    'footer-settings': 'footer'
};

function normalizeEmail(value) {
    return String(value ?? '').trim().toLowerCase();
}

function getAuthEmails(user) {
    const emails = new Set();
    const primaryEmail = normalizeEmail(user?.email);
    if (primaryEmail) emails.add(primaryEmail);
    (user?.providerData || []).forEach(profile => {
        const email = normalizeEmail(profile?.email);
        if (email) emails.add(email);
    });
    return Array.from(emails);
}

function isAdminUser(user) {
    return getAuthEmails(user).some(email => ADMIN_EMAILS.includes(email));
}

function adminRoleDefaults(role) {
    return { ...(ADMIN_ROLE_DEFAULT_PERMISSIONS[role] || ADMIN_ROLE_DEFAULT_PERMISSIONS.manager) };
}

let currentAdminAccess = null;
let adminAccessData = {};
let adminAccessUnsubscribe = null;
let adminAccessFormBound = false;
let discountsData = {};
let discountsUnsubscribe = null;
let discountFormBound = false;
let loyaltyConfig = {};
let loyaltyLedgerData = [];
let loyaltyConfigUnsubscribe = null;
let loyaltyLedgerUnsubscribe = null;
let loyaltyFormsBound = false;
let dashboardOrdersData = [];
let dashboardBookingsData = [];
let dashboardStatsData = {};
let dashboardPromptPaySettings = null;
let dashboardFilters = null;
let dashboardFiltersBound = false;
let dashboardSourceChart = null;
let dashboardPaymentChart = null;
let activeSalesReport = 'summary';
let salesReportNavBound = false;
let salesReportMonthOffset = 0;
let salesReportEmployeeFilter = 'all';
let salesReportTimeFilter = 'all';
const SALES_REPORT_LABELS = {
    summary: 'สรุปยอดขาย',
    product: 'ยอดขายตามสินค้า',
    category: 'ยอดขาย แยกตาม หมวดหมู่',
    staff: 'ยอดขาย แยกตาม พนักงาน',
    payment: 'ยอดขาย แยกตาม ประเภทการชำระเงิน',
    receipts: 'ใบเสร็จรับเงิน',
    options: 'ยอดขาย แยกตาม ตัวเลือกเพิ่มเติม',
    discounts: 'ส่วนลด',
    taxes: 'ภาษี'
};

function buildBootstrapOwnerAccess(user) {
    return {
        uid: user.uid,
        email: normalizeEmail(user.email),
        displayName: user.displayName || 'Owner',
        role: 'owner',
        status: 'active',
        permissions: adminRoleDefaults('owner'),
        branch_ids: ['BKK_MAIN'],
        primary_branch_id: 'BKK_MAIN',
        archery_role: 'OWNER',
        source: 'bootstrap'
    };
}

async function loadAdminAccess(user) {
    if (!user) return null;
    if (isAdminUser(user)) return buildBootstrapOwnerAccess(user);

    let snap;
    try {
        snap = await getDoc(doc(db, ADMIN_COLLECTION, user.uid));
    } catch (error) {
        console.error('Unable to read admin access document:', error);
        if (loginError) {
            loginError.innerText = 'Cannot verify admin permission: ' + error.message;
            loginError.style.display = 'block';
        }
        return null;
    }
    if (!snap.exists()) {
        console.warn('No admin access document for UID:', user.uid, 'email:', user.email);
        return null;
    }

    const data = snap.data();
    if (data.status !== 'active') return null;

    if (!ADMIN_ROLE_LABELS[data.role]) return null;
    const role = data.role;
    return {
        uid: user.uid,
        email: normalizeEmail(data.email || user.email),
        displayName: data.displayName || user.displayName || 'Manager',
        role,
        status: data.status,
        permissions: { ...adminRoleDefaults(role), ...(data.permissions || {}) },
        branch_ids: Array.isArray(data.branch_ids) ? data.branch_ids.map(String) : [],
        primary_branch_id: data.primary_branch_id || data.branch_id || '',
        archery_role: data.archery_role || data.archeryRole || data.role || '',
        staff_session_id: data.staff_session_id || data.staffSessionId || '',
        source: 'firestore'
    };
}

async function ensureBootstrapOwnerRecord(user) {
    if (!user || !isAdminUser(user)) return;
    try {
        await setDoc(doc(db, ADMIN_COLLECTION, user.uid), {
            uid: user.uid,
            email: normalizeEmail(user.email),
            displayName: user.displayName || user.email || 'Owner',
            role: 'owner',
            status: 'active',
            permissions: adminRoleDefaults('owner'),
            updatedAt: serverTimestamp(),
            updatedBy: user.uid
        }, { merge: true });
    } catch (error) {
        console.warn('Unable to ensure bootstrap owner admin record:', error);
    }
}

function isOwnerAccess(access = currentAdminAccess) {
    return !!access && access.status === 'active' && access.role === 'owner';
}

function canAdmin(permission) {
    if (!currentAdminAccess || currentAdminAccess.status !== 'active') return false;
    if (currentAdminAccess.role === 'owner') return true;
    if (permission === 'adminAccess') return false;
    if (currentAdminAccess.role === 'head_manager') return true;
    return currentAdminAccess.permissions?.[permission] === true;
}

window.canAccessAdminTab = (tabId) => {
    const permission = ADMIN_TAB_PERMISSIONS[tabId] || 'dashboard';
    return permission === 'adminAccess' ? isOwnerAccess() : canAdmin(permission);
};

// Global Data (for editing)
let productsData = {};
let productRows = [];
let productCurrentPage = 1;
let productPageSize = 10;
let productControlsBound = false;
let posApkReleasesData = {};
let posApkDevicesData = {};
let posApkEventsData = [];
let posApkReleasesUnsubscribe = null;
let posApkDevicesUnsubscribe = null;
let posApkEventsUnsubscribe = null;
let posApkFormBound = false;
const selectedProductIds = new Set();
const expandedProductIds = new Set();
let categoriesData = {};
let roomsData = {};
let tablesData = {};
let tableMapCurrentPage = 1;
let tableMapPageSize = 25;
let tableMapControlsBound = false;
let tableMapSelectedId = '';
let membersData = {};
let memberUsersData = {};
let memberSummariesData = {};
let memberOrdersMetrics = {};
let memberBookingsMetrics = {};
let membersUnsubscribe = null;
let memberSummariesUnsubscribe = null;
let memberOrdersMetricsUnsubscribe = null;
let memberBookingsMetricsUnsubscribe = null;
let ordersUnsubscribe = null;
let bookingsUnsubscribe = null;
let archeryBookingsUnsubscribe = null;
let archeryAuditUnsubscribe = null;
let archeryPaymentsUnsubscribe = null;
let archeryWebhookEventsUnsubscribe = null;
let archeryReconciliationUnsubscribe = null;
let archeryBookingsData = [];
let archeryAuditLogsData = [];
let archeryPaymentsData = [];
let archeryWebhookEventsData = [];
let archeryReconciliationData = [];
let archeryPageSettingsData = null;
const archeryActionLoading = new Set();
let archeryAdminControlsBound = false;
let archeryPageSettingsBound = false;
let allBookingsControlsBound = false;
let categoriesUnsubscribe = null;
let productsUnsubscribe = null;
let tablesUnsubscribe = null;
let roomsUnsubscribe = null;
let blogsUnsubscribe = null;
let faqsUnsubscribe = null;
let memberFiltersBound = false;
let memberAuthDiagnosticsBound = false;
let lastMemberAuthDiagnosis = null;
let lastMemberAuthMergeResult = null;
let salesSummaryChart = null;

const ADMIN_ACTIVE_TAB_STORAGE_KEY = 'edenAdminActiveTab';


const MENU_LOCATION_NAME = 'EDEN CAFE AND ETHNIC RESTAURANT.Co.,Ltd';
const MENU_PRICE_COLUMN = `Price [${MENU_LOCATION_NAME}]`;
const MENU_STOCK_COLUMN = `In stock [${MENU_LOCATION_NAME}]`;
const MENU_LOW_STOCK_COLUMN = `Low stock [${MENU_LOCATION_NAME}]`;
const MENU_AVAILABLE_COLUMN = `Available for sale [${MENU_LOCATION_NAME}]`;
const MENU_TAX_COLUMN = 'Tax - "eden cafe" (7%)';
const MENU_SHOW_POS_COLUMN = 'Show on POS';
const MENU_SHOW_WEBSITE_COLUMN = 'Show on Website';
const MENU_SHOW_SHOP_COLUMN = 'Show in Shop';
const MENU_SHOW_INDEX_COLUMN = 'Show on Index';
const MENU_VARIANTS_COLUMN = 'Variants JSON';

const MENU_TEMPLATE_ROW = {
    Handle: 'eden-iced-latte',
    SKU: 'MENU-COF-001',
    Name: 'Eden Iced Latte',
    Category: 'coffee',
    Description: 'Signature iced latte with Eden house blend.',
    'Sold by weight': 'No',
    'Option 1 name': 'Size',
    'Option 1 value': 'Regular',
    'Option 2 name': 'Sweetness',
    'Option 2 value': '50%',
    'Option 3 name': 'Milk',
    'Option 3 value': 'Fresh milk',
    Cost: 35,
    Barcode: '8850000000012',
    'SKU of included item': '',
    'Quantity of included item': 1,
    'Track stock': 'Yes',
    [MENU_AVAILABLE_COLUMN]: 'Yes',
    [MENU_PRICE_COLUMN]: 95,
    [MENU_STOCK_COLUMN]: 50,
    [MENU_LOW_STOCK_COLUMN]: 5,
    [MENU_TAX_COLUMN]: 'Yes',
    [MENU_SHOW_POS_COLUMN]: 'Yes',
    [MENU_SHOW_WEBSITE_COLUMN]: 'Yes',
    [MENU_SHOW_SHOP_COLUMN]: 'No',
    [MENU_SHOW_INDEX_COLUMN]: 'No',
    Color: '#4caf50',
    Shape: 'rounded',
    [MENU_VARIANTS_COLUMN]: '[{"name":"เย็น","price":95,"cost":35,"sku":"MENU-COF-001-COLD","availableForSale":true},{"name":"ร้อน","price":85,"cost":32,"sku":"MENU-COF-001-HOT","availableForSale":true},{"name":"ปั่น","price":110,"cost":42,"sku":"MENU-COF-001-FRAPPE","availableForSale":true}]'
};

function cleanMenuCell(value) {
    return String(value ?? '').trim();
}

function parseMenuNumber(value) {
    if (value === undefined || value === null || cleanMenuCell(value) === '') return undefined;
    const parsed = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMenuBoolean(value, fallback = false) {
    if (value === undefined || value === null || cleanMenuCell(value) === '') return fallback;
    const text = cleanMenuCell(value).toLowerCase();
    return ['true', '1', 'yes', 'y', 'available', 'sale', 'on', '\u0e40\u0e1b\u0e34\u0e14', '\u0e02\u0e32\u0e22', '\u0e43\u0e0a\u0e48'].includes(text);
}

function boolToMenuText(value) {
    return value === false ? 'No' : 'Yes';
}

function slugifyMenuHandle(value) {
    return cleanMenuCell(value)
        .toLowerCase()
        .replace(/[^a-z0-9\u0e00-\u0e7f]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

function menuOptionsFromRow(row) {
    const options = [];
    [1, 2, 3].forEach((index) => {
        const name = cleanMenuCell(row[`Option ${index} name`] ?? row[`option${index}Name`]);
        const value = cleanMenuCell(row[`Option ${index} value`] ?? row[`option${index}Value`]);
        if (name || value) options.push({ name, value });
    });
    return options;
}

function parseMenuJSON(value, fallback = null) {
    const text = cleanMenuCell(value);
    if (!text) return fallback;
    try {
        return JSON.parse(text);
    } catch (error) {
        console.warn('Invalid menu JSON:', error);
        return fallback;
    }
}

function variantIdFromName(name, index = 0) {
    return slugifyMenuHandle(name || `variant-${index + 1}`) || `variant-${index + 1}`;
}

function normalizeProductVariant(variant = {}, index = 0, baseProduct = {}) {
    const name = cleanMenuCell(variant.name ?? variant.variant ?? variant.value ?? variant.optionValue ?? variant.title ?? `ตัวแปร ${index + 1}`);
    const price = parseMenuNumber(variant.price ?? variant.salePrice ?? variant[MENU_PRICE_COLUMN]) ?? safeNumber(baseProduct.price, 0);
    const cost = parseMenuNumber(variant.cost ?? variant.Cost) ?? safeNumber(baseProduct.cost, 0);
    const stock = parseMenuNumber(variant.stock ?? variant.inStock ?? variant[MENU_STOCK_COLUMN]) ?? safeNumber(baseProduct.stock, 0);
    const lowStock = parseMenuNumber(variant.lowStock ?? variant[MENU_LOW_STOCK_COLUMN]) ?? safeNumber(baseProduct.lowStock, 0);
    return {
        id: cleanMenuCell(variant.id) || variantIdFromName(name, index),
        name,
        availableForSale: parseMenuBoolean(variant.availableForSale ?? variant.available ?? variant.enabled, true),
        price,
        cost,
        sku: cleanMenuCell(variant.sku ?? variant.SKU ?? variant.article),
        stock,
        lowStock
    };
}

function productVariantsFromRow(row, baseProduct = {}) {
    const variantsJson = parseMenuJSON(row[MENU_VARIANTS_COLUMN] ?? row.variants, null);
    if (Array.isArray(variantsJson)) {
        return variantsJson.map((variant, index) => normalizeProductVariant(variant, index, baseProduct)).filter(variant => variant.name);
    }

    const singleVariantName = cleanMenuCell(row['Variant name'] ?? row.variantName);
    if (singleVariantName) {
        return [normalizeProductVariant({
            name: singleVariantName,
            price: row['Variant price'] ?? row.variantPrice ?? row[MENU_PRICE_COLUMN],
            cost: row['Variant cost'] ?? row.variantCost ?? row.Cost,
            sku: row['Variant SKU'] ?? row.variantSku ?? row.SKU,
            stock: row['Variant stock'] ?? row.variantStock ?? row[MENU_STOCK_COLUMN],
            lowStock: row['Variant low stock'] ?? row.variantLowStock ?? row[MENU_LOW_STOCK_COLUMN],
            availableForSale: row['Variant available'] ?? row.variantAvailable ?? row[MENU_AVAILABLE_COLUMN]
        }, 0, baseProduct)];
    }

    const optionVariants = menuOptionsFromRow(row)
        .filter(option => option.value)
        .map((option, index) => normalizeProductVariant({
            id: variantIdFromName(option.value, index),
            name: option.value,
            price: baseProduct.price,
            cost: baseProduct.cost,
            sku: index === 0 ? baseProduct.sku : '',
            stock: baseProduct.stock,
            lowStock: baseProduct.lowStock,
            availableForSale: baseProduct.availableForSale
        }, index, baseProduct));
    return optionVariants;
}

function normalizeMenuCategory(value) {
    return slugifyMenuHandle(value || 'other') || 'other';
}

function normalizeMenuTemplateRow(row) {
    const name = cleanMenuCell(row.Name ?? row.name);
    const sku = cleanMenuCell(row.SKU ?? row.sku);
    const handle = slugifyMenuHandle(row.Handle ?? row.handle ?? name ?? sku);
    const price = parseMenuNumber(row[MENU_PRICE_COLUMN] ?? row.Price ?? row.price) ?? 0;
    const stock = parseMenuNumber(row[MENU_STOCK_COLUMN] ?? row.stock ?? row.inStock) ?? 0;
    const lowStock = parseMenuNumber(row[MENU_LOW_STOCK_COLUMN] ?? row.lowStock) ?? 0;
    const cost = parseMenuNumber(row.Cost ?? row.cost);
    const includedQty = parseMenuNumber(row['Quantity of included item'] ?? row.includedItemQuantity);
    const options = menuOptionsFromRow(row);

    const normalized = {
        id: handle || sku || slugifyMenuHandle(name),
        handle: handle || undefined,
        sku: sku || undefined,
        name: name || sku || handle || 'Eden Menu',
        category: normalizeMenuCategory(row.Category ?? row.category),
        description: cleanMenuCell(row.Description ?? row.description),
        soldByWeight: parseMenuBoolean(row['Sold by weight'] ?? row.soldByWeight),
        soldBy: cleanMenuCell(row['Sold by'] ?? row.soldBy) || (parseMenuBoolean(row['Sold by weight'] ?? row.soldByWeight) ? 'weight' : 'each'),
        option1Name: cleanMenuCell(row['Option 1 name'] ?? row.option1Name),
        option1Value: cleanMenuCell(row['Option 1 value'] ?? row.option1Value),
        option2Name: cleanMenuCell(row['Option 2 name'] ?? row.option2Name),
        option2Value: cleanMenuCell(row['Option 2 value'] ?? row.option2Value),
        option3Name: cleanMenuCell(row['Option 3 name'] ?? row.option3Name),
        option3Value: cleanMenuCell(row['Option 3 value'] ?? row.option3Value),
        options,
        barcode: cleanMenuCell(row.Barcode ?? row.barcode),
        includedItemSku: cleanMenuCell(row['SKU of included item'] ?? row.includedItemSku),
        trackStock: parseMenuBoolean(row['Track stock'] ?? row.trackStock),
        availableForSale: parseMenuBoolean(row[MENU_AVAILABLE_COLUMN] ?? row.availableForSale, true),
        showOnPos: parseMenuBoolean(row[MENU_SHOW_POS_COLUMN] ?? row.showOnPos, true),
        showOnWebsite: parseMenuBoolean(row[MENU_SHOW_WEBSITE_COLUMN] ?? row.showOnWebsite, true),
        showInShop: parseMenuBoolean(row[MENU_SHOW_SHOP_COLUMN] ?? row.showInShop, false),
        showOnIndex: parseMenuBoolean(row[MENU_SHOW_INDEX_COLUMN] ?? row.showOnIndex ?? row.isFeatured, false),
        price,
        stock,
        lowStock,
        taxName: 'eden cafe',
        taxRate: 7,
        taxEnabled: parseMenuBoolean(row[MENU_TAX_COLUMN] ?? row.taxEnabled, true),
        color: cleanMenuCell(row.Color ?? row.color) || '#4caf50',
        shape: cleanMenuCell(row.Shape ?? row.shape) || 'rounded'
    };

    const variants = productVariantsFromRow(row, normalized);
    if (variants.length) normalized.variants = variants;
    if (cost !== undefined) normalized.cost = cost;
    if (includedQty !== undefined) normalized.includedItemQuantity = includedQty;
    if (row.imageUrl || row.Image || row.image) normalized.imageUrl = cleanMenuCell(row.imageUrl ?? row.Image ?? row.image);
    if (row.isSignature !== undefined) normalized.isSignature = parseMenuBoolean(row.isSignature);
    normalized.isFeatured = normalized.showOnIndex;

    Object.keys(normalized).forEach((key) => {
        if (normalized[key] === undefined || normalized[key] === '') delete normalized[key];
        if (Array.isArray(normalized[key]) && !normalized[key].length) delete normalized[key];
    });
    return normalized;
}

function menuProductToTemplateRow(product = {}) {
    const option = (index, key) => {
        const optionItem = Array.isArray(product.options) ? product.options[index - 1] : null;
        return product[`option${index}${key}`] ?? optionItem?.[key.toLowerCase()] ?? '';
    };
    const variants = Array.isArray(product.variants) ? product.variants : [];

    return {
        Handle: product.handle || product.id || slugifyMenuHandle(product.name || product.sku || ''),
        SKU: product.sku || '',
        Name: product.name || '',
        Category: product.category || '',
        Description: product.description || '',
        'Sold by': product.soldBy || (product.soldByWeight ? 'weight' : 'each'),
        'Sold by weight': boolToMenuText(product.soldByWeight),
        'Option 1 name': option(1, 'Name'),
        'Option 1 value': option(1, 'Value'),
        'Option 2 name': option(2, 'Name'),
        'Option 2 value': option(2, 'Value'),
        'Option 3 name': option(3, 'Name'),
        'Option 3 value': option(3, 'Value'),
        Cost: product.cost ?? '',
        Barcode: product.barcode || '',
        'SKU of included item': product.includedItemSku || '',
        'Quantity of included item': product.includedItemQuantity ?? '',
        'Track stock': boolToMenuText(product.trackStock),
        [MENU_AVAILABLE_COLUMN]: boolToMenuText(product.availableForSale),
        [MENU_PRICE_COLUMN]: product.price ?? '',
        [MENU_STOCK_COLUMN]: product.stock ?? '',
        [MENU_LOW_STOCK_COLUMN]: product.lowStock ?? '',
        [MENU_TAX_COLUMN]: boolToMenuText(product.taxEnabled),
        [MENU_SHOW_POS_COLUMN]: boolToMenuText(product.showOnPos),
        [MENU_SHOW_WEBSITE_COLUMN]: boolToMenuText(product.showOnWebsite),
        [MENU_SHOW_SHOP_COLUMN]: boolToMenuText(product.showInShop),
        [MENU_SHOW_INDEX_COLUMN]: boolToMenuText(product.showOnIndex === true || product.isFeatured === true),
        Color: product.color || '',
        Shape: product.shape || '',
        [MENU_VARIANTS_COLUMN]: variants.length ? JSON.stringify(variants) : ''
    };
}

const XLSX_CATEGORY_CONFIG = {
    products: {
        label: '\u0e40\u0e21\u0e19\u0e39\u0e23\u0e49\u0e32\u0e19 (products)',
        collection: 'products',
        permission: 'products',
        numberFields: ['price', 'order', 'cost', 'stock', 'lowStock', 'includedItemQuantity', 'taxRate'],
        booleanFields: ['isSignature', 'isFeatured', 'soldByWeight', 'trackStock', 'availableForSale', 'taxEnabled', 'showOnPos', 'showOnWebsite', 'showInShop', 'showOnIndex'],
        arrayFields: [],
        template: MENU_TEMPLATE_ROW,
        importRow: normalizeMenuTemplateRow,
        exportRow: menuProductToTemplateRow
    },
    categories: {
        label: 'หมวดเมนูร้าน (categories)',
        collection: 'categories',
        permission: 'products',
        numberFields: ['order'],
        booleanFields: [],
        arrayFields: [],
        template: { id: 'coffee', name: 'กาแฟ', nameEn: 'Coffee', order: 1 }
    },
    rooms: {
        label: 'ห้องรับรอง (rooms)',
        collection: 'rooms',
        permission: 'rooms',
        numberFields: ['price', 'amount', 'order'],
        booleanFields: [],
        arrayFields: [],
        template: { id: 'meeting', name: 'Meeting Room', capacity: '3-6 ท่าน', price: 350, amount: 2, imageUrl: 'https://example.com/room.webp', order: 1 }
    },
    tables: {
        label: 'โต๊ะ/โซน (tables)',
        collection: 'tables',
        permission: 'tables',
        numberFields: ['x', 'y', 'w', 'h', 'seats', 'order'],
        booleanFields: [],
        arrayFields: ['tableIds'],
        template: { id: 'IN-01', type: 'table', code: 'IN-01', name: 'โต๊ะอินดอร์ 1', zone: 'Indoor', seats: 4, shape: 'rect', status: 'available', x: 15, y: 20, w: 20, h: 15, tableIds: 'IN-01|IN-02', order: 1 }
    },
    blogs: {
        label: 'บทความ (blogs)',
        collection: 'blogs',
        permission: 'blogs',
        numberFields: ['order'],
        booleanFields: [],
        arrayFields: [],
        template: { id: 'blog-001', title: 'หัวข้อบทความ', category: 'ความรู้เรื่องกาแฟ', status: 'draft', excerpt: 'สรุปสั้น', imageUrl: 'https://example.com/blog.webp', content: '<p>เนื้อหา</p>', order: 1 }
    },
    faqs: {
        label: 'คำถามที่พบบ่อย (faqs)',
        collection: 'faqs',
        permission: 'faqs',
        numberFields: ['order'],
        booleanFields: [],
        arrayFields: [],
        template: { id: 'faq-001', question: 'เปิดกี่โมง?', answer: 'เปิดทุกวัน 07:30-18:00', order: 1 }
    },
    users: {
        label: 'สมาชิก (users)',
        collection: 'users',
        permission: 'members',
        numberFields: ['points', 'totalSpent', 'visitCount', 'orderCount', 'bookingCount'],
        booleanFields: [],
        arrayFields: ['adminTags'],
        template: { id: 'uid_xxxxx', uid: 'uid_xxxxx', displayName: 'ลูกค้าตัวอย่าง', email: 'member@example.com', phone: '08x-xxx-xxxx', points: 120, totalSpent: 4500, visitCount: 8, adminTags: 'vip|coffee_lover', status: 'active' }
    }
};

function getXLSXCategoryConfig(categoryKey) {
    return XLSX_CATEGORY_CONFIG[categoryKey] || null;
}

function parseXLSXCellValue(value, key, cfg) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    if (cfg.booleanFields.includes(key)) return value === true || String(value).trim().toLowerCase() === 'true' || String(value).trim() === '1';
    if (cfg.numberFields.includes(key)) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (cfg.arrayFields.includes(key)) {
        if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
        return String(value).split('|').map(item => item.trim()).filter(Boolean);
    }
    return typeof value === 'string' ? value.trim() : value;
}

function normalizeRowForUpload(row, cfg) {
    const normalized = {};
    Object.keys(row || {}).forEach((key) => {
        const cleanKey = String(key || '').trim();
        if (!cleanKey) return;
        const value = parseXLSXCellValue(row[key], cleanKey, cfg);
        if (value === undefined) return;
        normalized[cleanKey] = value;
    });
    return normalized;
}

function xlsxFileName(prefix, categoryKey) {
    const date = new Date().toISOString().slice(0, 10);
    return `eden-${prefix}-${categoryKey}-${date}.xlsx`;
}

function worksheetFromData(rows) {
    const XLSX = window.XLSX;
    if (!XLSX) throw new Error('XLSX library is unavailable');
    return XLSX.utils.json_to_sheet(rows.length ? rows : [{}], { skipHeader: false });
}

async function downloadCategoryDataAsXLSX(categoryKey) {
    const cfg = getXLSXCategoryConfig(categoryKey);
    if (!cfg) throw new Error('กรุณาเลือกหมวดข้อมูล');
    if (!canAdmin(cfg.permission)) throw new Error('บัญชีนี้ไม่มีสิทธิ์ในหมวดนี้');

    const snapshot = await getDocs(query(collection(db, cfg.collection)));
    const rows = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    const exportRows = typeof cfg.exportRow === 'function' ? rows.map(row => cfg.exportRow(row)) : rows;
    const XLSX = window.XLSX;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheetFromData(exportRows), 'data');
    XLSX.writeFile(workbook, xlsxFileName('data', categoryKey));
}

function downloadCategoryTemplateAsXLSX(categoryKey) {
    const cfg = getXLSXCategoryConfig(categoryKey);
    if (!cfg) throw new Error('กรุณาเลือกหมวดข้อมูล');
    if (!canAdmin(cfg.permission)) throw new Error('บัญชีนี้ไม่มีสิทธิ์ในหมวดนี้');

    const XLSX = window.XLSX;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheetFromData([cfg.template]), 'template');
    XLSX.writeFile(workbook, xlsxFileName('template', categoryKey));
}

async function uploadCategoryDataFromXLSX(categoryKey, file) {
    const cfg = getXLSXCategoryConfig(categoryKey);
    if (!cfg) throw new Error('กรุณาเลือกหมวดข้อมูล');
    if (!canAdmin(cfg.permission)) throw new Error('บัญชีนี้ไม่มีสิทธิ์ในหมวดนี้');
    if (!file) throw new Error('กรุณาเลือกไฟล์ .xlsx ก่อนอัปโหลด');

    const XLSX = window.XLSX;
    if (!XLSX) throw new Error('XLSX library is unavailable');

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('ไม่พบชีตข้อมูลในไฟล์');
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    if (!rows.length) throw new Error('ไฟล์ไม่มีข้อมูล');

    let created = 0;
    let updated = 0;
    for (const row of rows) {
        const normalized = typeof cfg.importRow === 'function' ? cfg.importRow(row) : normalizeRowForUpload(row, cfg);
        const idValue = String(normalized.id || normalized.uid || '').trim();
        delete normalized.id;
        if (!Object.keys(normalized).length) continue;
        normalized.updatedAt = new Date().toISOString();

        if (idValue) {
            await setDoc(doc(db, cfg.collection, idValue), normalized, { merge: true });
            updated += 1;
        } else {
            normalized.createdAt = new Date().toISOString();
            await addDoc(collection(db, cfg.collection), normalized);
            created += 1;
        }
    }

    return { created, updated, total: created + updated };
}

function updateXLSXToolsState() {
    const select = document.getElementById('xlsx-category-select');
    const note = document.getElementById('xlsx-tools-note');
    if (!select || !note) return;
    const key = select.value;
    const cfg = getXLSXCategoryConfig(key);
    if (!cfg) {
        note.textContent = 'เลือกหมวดก่อน แล้วดาวน์โหลดเทมเพลตเพื่อกรอกข้อมูล จากนั้นค่อยอัปโหลดไฟล์กลับเข้าระบบ';
        return;
    }
    const allowed = canAdmin(cfg.permission);
    note.textContent = allowed
        ? `รองรับคอลเลกชัน ${cfg.collection} | อัปโหลดแบบ upsert (มี id = update, ไม่มี id = create)`
        : 'บัญชีนี้ไม่มีสิทธิ์ในหมวดที่เลือก';
}

function initXLSXTools() {
    const select = document.getElementById('xlsx-category-select');
    const fileInput = document.getElementById('xlsx-upload-input');
    const btnDownloadData = document.getElementById('btn-xlsx-download-data');
    const btnTemplate = document.getElementById('btn-xlsx-download-template');
    const btnUpload = document.getElementById('btn-xlsx-upload');
    if (!select || !fileInput || !btnDownloadData || !btnTemplate || !btnUpload) return;

    const options = Object.entries(XLSX_CATEGORY_CONFIG)
        .filter(([, cfg]) => canAdmin(cfg.permission))
        .map(([key, cfg]) => `<option value="${key}">${escapeHTML(cfg.label)}</option>`)
        .join('');
    select.innerHTML = `<option value="">-- เลือกหมวดข้อมูล --</option>${options}`;

    select.onchange = updateXLSXToolsState;
    btnDownloadData.onclick = async () => {
        try {
            btnDownloadData.disabled = true;
            await downloadCategoryDataAsXLSX(select.value);
        } catch (error) {
            alert(safeAdminError("ดาวน์โหลดข้อมูลไม่สำเร็จ"));
        } finally {
            btnDownloadData.disabled = false;
        }
    };
    btnTemplate.onclick = () => {
        try {
            downloadCategoryTemplateAsXLSX(select.value);
        } catch (error) {
            alert(safeAdminError("ดาวน์โหลดเทมเพลตไม่สำเร็จ"));
        }
    };
    btnUpload.onclick = async () => {
        try {
            btnUpload.disabled = true;
            btnUpload.textContent = 'กำลังอัปโหลด...';
            const result = await uploadCategoryDataFromXLSX(select.value, fileInput.files?.[0]);
            alert(`อัปโหลดสำเร็จ รวม ${result.total} รายการ (เพิ่ม ${result.created}, อัปเดต ${result.updated})`);
            fileInput.value = '';
        } catch (error) {
            alert(safeAdminError("อัปโหลดไม่สำเร็จ"));
        } finally {
            btnUpload.disabled = false;
            btnUpload.textContent = 'อัปโหลด XLSX';
        }
    };
    updateXLSXToolsState();
}

// DOM Elements
const loginScreen = document.getElementById('admin-login');
const btnLogin = document.getElementById('btn-admin-login');
const emailLoginForm = document.getElementById('email-login-form');
const btnLogout = document.getElementById('btn-admin-logout');
const adminName = document.getElementById('admin-name');
const adminAvatar = document.getElementById('admin-avatar');
const loginError = document.getElementById('login-error');

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    bindSalesReportNav();
    renderDashboardSalesReport();

    getRedirectResult(auth).catch((error) => {
        console.error('Google redirect login failed:', error);
        if (loginError) {
            loginError.innerText = 'Google login failed: ' + error.message;
            loginError.style.display = 'block';
        }
    });

    // Check Auth State
    onAuthStateChanged(auth, async (user) => {
        console.log("Auth State Changed in Admin:", user ? user.email : "No User");
        if (user) {
            const authEmails = getAuthEmails(user);
            currentAdminAccess = await loadAdminAccess(user);

            if (!currentAdminAccess) {
                // Not an admin
                console.warn("Unauthorized access attempt by:", authEmails);
                const shownEmail = authEmails.length ? authEmails.join(', ') : '(no email returned from Firebase Auth)';
                loginError.innerText = `This account is not allowed to access Admin.\nFirebase Auth email: ${shownEmail}`;
                loginError.style.display = 'block';
                loginScreen.style.display = 'flex'; // Show screen if they were unauthorized
                await signOut(auth);
                return;
            }

            // User is logged in and IS an admin
            await ensureBootstrapOwnerRecord(user);
            loginScreen.style.display = 'none';
            adminName.innerText = `${currentAdminAccess.displayName || user.displayName || 'Admin'} (${ADMIN_ROLE_LABELS[currentAdminAccess.role] || currentAdminAccess.role})`;
            adminAvatar.src = user.photoURL || 'Images/Logo.webp';
            applyAdminAccessUI();
            initializeAdminModules();
        } else {
            // User is logged out
            currentAdminAccess = null;
            loginScreen.style.display = 'flex';
        }
    });

    // Login with Email / Password
    emailLoginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('admin-email').value.trim();
        const password = document.getElementById('admin-password').value;
        const btn = document.getElementById('btn-email-login');
        btn.disabled = true;
        btn.innerText = 'กำลังเข้าสู่ระบบ...';
        loginError.style.display = 'none';
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (error) {
            console.error('Email login failed:', error);
            let msg = 'เข้าสู่ระบบไม่สำเร็จ';
            if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found') {
                msg = ' อีเมลหรือรหัสผ่านไม่ถูกต้อง';
            } else if (error.code === 'auth/too-many-requests') {
                msg = ' พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่';
            } else if (error.code === 'auth/network-request-failed') {
                msg = ' ไม่มีการเชื่อมต่ออินเทอร์เน็ต';
            } else {
                msg = ' ' + error.message;
            }
            loginError.innerText = msg;
            loginError.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.innerText = ' เข้าสู่ระบบ';
        }
    });

    // Login with Google
    btnLogin.addEventListener('click', async () => {
        loginError.style.display = 'none';
        try {
            if (hasLoyverseImportMode()) {
                await signInWithRedirect(auth, provider);
                return;
            }
            await signInWithPopup(auth, provider);
        } catch (error) {
            console.error('Google login failed:', error);
            if (error.code === 'auth/popup-blocked' || error.code === 'auth/popup-closed-by-user') {
                await signInWithRedirect(auth, provider);
                return;
            }
            loginError.innerText = ' การเข้าสู่ระบบด้วย Google ล้มเหลว: ' + error.message;
            loginError.style.display = 'block';
        }
    });

    // Logout Action
    btnLogout.addEventListener('click', async () => {
        await signOut(auth);
        window.location.reload();
    });
});

function initializeAdminModules() {
    if (canAdmin('dashboard')) {
        bindDashboardFilters();
        fetchStats();
        bindSalesReportNav();
        renderDashboardSalesReport();
        if (!categoriesUnsubscribe) setupRealtimeCategories();
    }
    if (canAdmin('orders') || canAdmin('pos')) setupRealtimeOrders();
    if (canAdmin('bookings')) {
        bindArcheryAdminControls();
        bindAllBookingsControls();
        setupRealtimeBookings();
        setupRealtimeArcheryAdminData();
    }
    if (canAdmin('products')) {
        setupRealtimeCategories();
        setupRealtimeProducts();
        initLoyverseImportTool();
    }
    if (canAdmin('tables')) setupRealtimeTables();
    if (canAdmin('rooms')) setupRealtimeRooms();
    if (canAdmin('members') || canAdmin('loyalty')) setupRealtimeMembers();
    if (canAdmin('discounts')) setupRealtimeDiscounts();
    if (canAdmin('loyalty')) setupRealtimeLoyalty();
    if (canAdmin('pos')) setupRealtimePosApkUpdates();
    if (canAdmin('promptpay') && typeof window.loadPromptPaySettings === 'function') window.loadPromptPaySettings();
    if (canAdmin('index') && typeof window.loadIndexSettings === 'function') window.loadIndexSettings();
    if (canAdmin('marketing') && typeof window.loadMarketingSettings === 'function') window.loadMarketingSettings();
    if (isOwnerAccess()) setupRealtimeAdminAccess();
    initXLSXTools();
    installAdminRefreshButtons();
    // Keep production data stable: run seed/migration manually from console only.
    // window.migrateProducts() remains available for first-time setup.
}

function adminTabIdFromMenuItem(li) {
    const match = String(li?.getAttribute('onclick') || '').match(/switchTab\('([^']+)'/);
    return match ? match[1] : '';
}

function adminMenuItemForTab(tabId) {
    return Array.from(document.querySelectorAll('.sidebar-menu li'))
        .find(li => adminTabIdFromMenuItem(li) === tabId && li.style.display !== 'none');
}

function decodeAdminTabId(value = '') {
    const raw = String(value || '').replace(/^#/, '');
    let decoded = raw;
    try {
        decoded = typeof window.decodeURIComponent === 'function' ? window.decodeURIComponent(raw) : raw;
    } catch (error) {
        decoded = raw;
    }
    return decoded.replace(/^tab=/, '');
}

function getPreferredAdminTabId() {
    if (hasLoyverseImportMode()) return 'dashboard';

    if (String(window.location.pathname || '').replace(/\/+$/, '') === '/admin/archery') return 'archery';

    const hash = decodeAdminTabId(window.location.hash || '');
    if (hash && document.getElementById(hash)) return hash;

    const fromQuery = decodeAdminTabId(new URLSearchParams(window.location.search).get('tab') || '');
    if (fromQuery && document.getElementById(fromQuery)) return fromQuery;

    try {
        const saved = localStorage.getItem(ADMIN_ACTIVE_TAB_STORAGE_KEY);
        if (saved && document.getElementById(saved)) return saved;
    } catch (error) {
        console.warn('Unable to read saved admin tab:', error);
    }
    return '';
}

function restoreAdminActiveTab() {
    const preferredTab = getPreferredAdminTabId();
    if (preferredTab && window.canAccessAdminTab(preferredTab)) {
        const preferredMenu = adminMenuItemForTab(preferredTab);
        if (preferredMenu) {
            window.switchTab(preferredTab, preferredMenu);
            return;
        }
    }

    const active = document.querySelector('.content-section.active');
    if (active && window.canAccessAdminTab(active.id)) {
        const activeMenu = adminMenuItemForTab(active.id);
        if (activeMenu) window.switchTab(active.id, activeMenu);
        return;
    }

    const firstAllowedMenu = Array.from(document.querySelectorAll('.sidebar-menu li'))
        .find(li => li.style.display !== 'none');
    if (firstAllowedMenu) {
        const tabId = adminTabIdFromMenuItem(firstAllowedMenu);
        if (tabId) window.switchTab(tabId, firstAllowedMenu);
    }
}

function installAdminRefreshButtons() {
    document.querySelectorAll('.content-section').forEach(section => {
        const toolbar = section.querySelector('.section-header > div:last-child, .section-header, .menu-pos-actions');
        if (!toolbar || toolbar.querySelector('.admin-refresh-btn')) return;
        const existingRefresh = Array.from(toolbar.querySelectorAll('button'))
            .some(button => /รีเฟรช|โหลดข้อมูลปัจจุบัน/.test(button.textContent || ''));
        if (existingRefresh) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-action btn-view admin-refresh-btn';
        button.textContent = '⟳ รีเฟรช';
        button.addEventListener('click', () => window.refreshAdminSection(section.id, button));
        toolbar.appendChild(button);
    });
}

window.refreshAdminSection = async (tabId, button = null) => {
    if (!tabId) return;
    const label = button?.textContent || '';
    if (button) {
        button.disabled = true;
        button.textContent = 'กำลังรีเฟรช...';
    }
    try {
        switch (tabId) {
            case 'dashboard':
                await fetchStats();
                renderDashboardSalesReport();
                break;
            case 'pos-apk-updates':
                setupRealtimePosApkUpdates();
                break;
            case 'members':
                setupRealtimeMembers();
                break;
            case 'admin-access':
                setupRealtimeAdminAccess();
                break;
            case 'discounts':
                setupRealtimeDiscounts();
                await refreshDiscountsOnce();
                break;
            case 'loyalty':
                setupRealtimeLoyalty();
                await refreshLoyaltyOnce();
                break;
            case 'orders':
                setupRealtimeOrders();
                break;
            case 'bookings':
            case 'room-bookings':
            case 'all-bookings':
                setupRealtimeBookings();
                break;
            case 'archery':
                setupRealtimeArcheryAdminData();
                break;
            case 'tables':
                setupRealtimeTables();
                break;
            case 'rooms':
                setupRealtimeRooms();
                break;
            case 'products':
                if (!categoriesUnsubscribe) setupRealtimeCategories();
                if (!productsUnsubscribe) setupRealtimeProducts();
                await refreshCategoriesOnce();
                await refreshProductsOnce();
                break;
            case 'categories':
                if (!categoriesUnsubscribe) setupRealtimeCategories();
                await refreshCategoriesOnce();
                break;
            case 'blogs':
                if (typeof window.fetchBlogsFromCloud === 'function') window.fetchBlogsFromCloud();
                break;
            case 'faqs':
                if (typeof window.fetchFaqsFromCloud === 'function') window.fetchFaqsFromCloud();
                break;
            case 'promptpay':
                if (typeof window.loadPromptPaySettings === 'function') await window.loadPromptPaySettings();
                break;
            case 'index-settings':
                if (typeof window.loadIndexSettings === 'function') await window.loadIndexSettings();
                break;
            case 'marketing-settings':
                if (typeof window.loadMarketingSettings === 'function') await window.loadMarketingSettings();
                break;
            case 'footer-settings':
                if (typeof window.loadFooterSettings === 'function') await window.loadFooterSettings();
                break;
            default:
                console.warn('No refresh handler for admin tab:', tabId);
        }
    } catch (error) {
        console.error('Unable to refresh admin section:', error);
        alert(safeAdminError("รีเฟรชข้อมูลไม่สำเร็จ"));
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = label || '⟳ รีเฟรช';
        }
    }
};

const DEFAULT_POS_DISCOUNTS = Object.freeze([
    { id: 'discount-1', label: 'ส่วนลด 1%', type: 'percent', value: 1, active: true, order: 10 },
    { id: 'discount-2', label: 'ส่วนลด 2%', type: 'percent', value: 2, active: true, order: 20 },
    { id: 'discount-5', label: 'ส่วนลด 5%', type: 'percent', value: 5, active: true, order: 30 },
    { id: 'discount-10', label: 'ส่วนลด 10%', type: 'percent', value: 10, active: true, order: 40 },
    { id: 'discount-15', label: 'ส่วนลด 15%', type: 'percent', value: 15, active: true, order: 50 },
    { id: 'discount-20', label: 'ส่วนลด 20%', type: 'percent', value: 20, active: true, order: 60 },
    { id: 'discount-30', label: 'ส่วนลด 30%', type: 'percent', value: 30, active: true, order: 70 },
    { id: 'fish-35', label: 'ส่วนลดปลา 35%', type: 'percent', value: 35, active: true, order: 80 },
    { id: 'project-5', label: 'โครงการผาฮี้ 5%', type: 'percent', value: 5, active: true, order: 90 },
    { id: 'staff-25', label: 'ส่วนลดพนักงาน 25%', type: 'percent', value: 25, active: true, order: 100 }
]);

function normalizeDiscountType(value) {
    return String(value || '').toLowerCase() === 'amount' ? 'amount' : 'percent';
}

function normalizeDiscountOption(id, data = {}) {
    const type = normalizeDiscountType(data.type);
    const rawValue = Math.max(0, safeNumber(data.value));
    return {
        id: String(id || data.id || '').trim(),
        label: String(data.label || '').trim(),
        type,
        value: type === 'percent' ? Math.min(rawValue, 100) : Math.min(rawValue, 100000),
        active: data.active !== false,
        order: safeNumber(data.order, 999),
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null
    };
}

function sortDiscountOptions(options = []) {
    return options.slice().sort((a, b) => {
        const orderDiff = safeNumber(a.order, 999) - safeNumber(b.order, 999);
        if (orderDiff) return orderDiff;
        return String(a.label || a.id).localeCompare(String(b.label || b.id), 'th');
    });
}

function discountValueText(discount = {}) {
    const value = safeNumber(discount.value);
    return discount.type === 'amount'
        ? `฿${value.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
        : `${value.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

function discountBadgeHTML(discount = {}) {
    const isAmount = normalizeDiscountType(discount.type) === 'amount';
    return `<span class="discount-badge ${isAmount ? 'amount' : ''}">${isAmount ? '฿' : '%'} ${escapeHTML(isAmount ? 'จำนวนเงิน' : 'เปอร์เซ็นต์')}</span>`;
}

async function refreshDiscountsOnce() {
    const snapshot = await getDocs(query(collection(db, 'pos_discounts')));
    discountsData = {};
    snapshot.forEach(docSnap => {
        discountsData[docSnap.id] = normalizeDiscountOption(docSnap.id, docSnap.data() || {});
    });
    renderDiscountsTable();
    renderDashboardSalesReport();
}

function setupRealtimeDiscounts() {
    setupDiscountForm();
    if (discountsUnsubscribe) discountsUnsubscribe();
    discountsUnsubscribe = onSnapshot(query(collection(db, 'pos_discounts')), snapshot => {
        discountsData = {};
        snapshot.forEach(docSnap => {
            discountsData[docSnap.id] = normalizeDiscountOption(docSnap.id, docSnap.data() || {});
        });
        renderDiscountsTable();
        renderDashboardSalesReport();
    }, error => {
        console.error('Error listening to POS discounts:', error);
        const body = document.getElementById('discount-table-body');
        if (body) body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#c62828;">โหลดส่วนลดไม่สำเร็จ: ${escapeHTML(error.message)}</td></tr>`;
    });
}

function setupDiscountForm() {
    if (discountFormBound) return;
    const form = document.getElementById('discount-form');
    if (!form) return;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!canAdmin('discounts')) {
            alert('บัญชีนี้ไม่มีสิทธิ์จัดการส่วนลด');
            return;
        }
        const idInput = document.getElementById('discount-id');
        const labelInput = document.getElementById('discount-label');
        const valueInput = document.getElementById('discount-value');
        const orderInput = document.getElementById('discount-order');
        const activeInput = document.getElementById('discount-active');
        const typeInput = document.querySelector('input[name="discount-type"]:checked');
        const id = String(idInput?.value || '').trim();
        const type = normalizeDiscountType(typeInput?.value);
        const label = String(labelInput?.value || '').trim();
        const value = safeNumber(valueInput?.value);
        if (!label) {
            alert('กรุณาระบุชื่อส่วนลด');
            labelInput?.focus();
            return;
        }
        if (value <= 0) {
            alert('กรุณาระบุมูลค่าส่วนลดมากกว่า 0');
            valueInput?.focus();
            return;
        }
        if (type === 'percent' && value > 100) {
            alert('ส่วนลดแบบเปอร์เซ็นต์ต้องไม่เกิน 100%');
            valueInput?.focus();
            return;
        }
        const payload = {
            label,
            type,
            value: type === 'percent' ? Math.min(value, 100) : Math.min(value, 100000),
            active: activeInput?.checked !== false,
            order: safeNumber(orderInput?.value, 999),
            updatedAt: serverTimestamp(),
            updatedBy: auth.currentUser?.uid || ''
        };
        try {
            if (id) {
                await updateDoc(doc(db, 'pos_discounts', id), payload);
            } else {
                const newId = label.toLowerCase().replace(/[^a-z0-9ก-๙]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || `discount-${Date.now()}`;
                await setDoc(doc(db, 'pos_discounts', newId), {
                    ...payload,
                    id: newId,
                    createdAt: serverTimestamp(),
                    createdBy: auth.currentUser?.uid || ''
                }, { merge: false });
            }
            resetDiscountForm();
        } catch (error) {
            console.error('Unable to save POS discount:', error);
            alert(safeAdminError("บันทึกส่วนลดไม่สำเร็จ"));
        }
    });
    discountFormBound = true;
}

function renderDiscountsTable() {
    const body = document.getElementById('discount-table-body');
    if (!body) return;
    const rows = sortDiscountOptions(Object.values(discountsData));
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6"><div class="discount-empty">ยังไม่มีส่วนลด กด “เติมชุดมาตรฐาน” หรือเพิ่มส่วนลดใหม่ได้เลย</div></td></tr>';
        return;
    }
    body.innerHTML = rows.map(discount => `
        <tr class="${discount.active ? '' : 'discount-row-muted'}">
            <td><strong>${escapeHTML(discount.label)}</strong><br><small style="color:#789;">${escapeHTML(discount.id)}</small></td>
            <td>${discountBadgeHTML(discount)}</td>
            <td><strong>${escapeHTML(discountValueText(discount))}</strong></td>
            <td>${safeNumber(discount.order, 999).toLocaleString('th-TH')}</td>
            <td>${discount.active ? '<span class="status-badge status-completed">Active</span>' : '<span class="status-badge status-cancelled">Paused</span>'}</td>
            <td><div class="discount-actions">
                <button class="btn-action btn-edit" type="button" onclick="editDiscount('${escapeJSString(discount.id)}')">แก้ไข</button>
                <button class="btn-action btn-delete" type="button" onclick="deleteDiscount('${escapeJSString(discount.id)}')">ลบ</button>
            </div></td>
        </tr>
    `).join('');
}

window.resetDiscountForm = function resetDiscountForm() {
    const form = document.getElementById('discount-form');
    if (form) form.reset();
    const idInput = document.getElementById('discount-id');
    const activeInput = document.getElementById('discount-active');
    const title = document.getElementById('discount-form-title');
    if (idInput) idInput.value = '';
    if (activeInput) activeInput.checked = true;
    if (title) title.textContent = 'เพิ่มส่วนลดใหม่';
};

window.editDiscount = function editDiscount(id) {
    const discount = discountsData[id];
    if (!discount) return;
    document.getElementById('discount-id').value = discount.id;
    document.getElementById('discount-label').value = discount.label;
    document.getElementById('discount-value').value = String(discount.value);
    document.getElementById('discount-order').value = String(discount.order);
    document.getElementById('discount-active').checked = discount.active;
    const type = normalizeDiscountType(discount.type);
    const radio = document.querySelector(`input[name="discount-type"][value="${type}"]`);
    if (radio) radio.checked = true;
    const title = document.getElementById('discount-form-title');
    if (title) title.textContent = 'แก้ไขส่วนลด';
    document.getElementById('discount-label')?.focus();
};

window.deleteDiscount = async function deleteDiscount(id) {
    const discount = discountsData[id];
    if (!discount) return;
    if (!confirm(`ลบส่วนลด "${discount.label}" ใช่ไหม?`)) return;
    try {
        await deleteDoc(doc(db, 'pos_discounts', id));
    } catch (error) {
        console.error('Unable to delete POS discount:', error);
        alert(safeAdminError("ลบส่วนลดไม่สำเร็จ"));
    }
};

window.seedDefaultDiscounts = async function seedDefaultDiscounts() {
    if (!canAdmin('discounts')) {
        alert('บัญชีนี้ไม่มีสิทธิ์จัดการส่วนลด');
        return;
    }
    try {
        const batch = writeBatch(db);
        DEFAULT_POS_DISCOUNTS.forEach(discount => {
            batch.set(doc(db, 'pos_discounts', discount.id), {
                ...discount,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                createdBy: auth.currentUser?.uid || '',
                updatedBy: auth.currentUser?.uid || ''
            }, { merge: true });
        });
        await batch.commit();
        alert('เติมชุดส่วนลดมาตรฐานเรียบร้อย');
    } catch (error) {
        console.error('Unable to seed POS discounts:', error);
        alert(safeAdminError("เติมชุดส่วนลดไม่สำเร็จ"));
    }
};

window.refreshDiscounts = () => window.refreshAdminSection('discounts');

const DEFAULT_LOYALTY_CONFIG = Object.freeze({
    enabled: true,
    spendPerPoint: 25,
    pointValue: 1,
    expiryMonths: 24,
    maxRedeemPercent: 30,
    minRedeemPoints: 20,
    earnAfterDiscount: true,
    earnOnRedeemedAmount: false,
    excludedCategories: ['เครื่องดื่มแอลกอฮอล์', 'ฝากเงิน', 'โปรแรง'],
    tierMultipliers: {
        Silver: 1,
        Gold: 1.25,
        Platinum: 1.5
    }
});

function normalizeLoyaltyConfig(raw = {}) {
    const tierMultipliers = raw.tierMultipliers || {};
    const excludedCategories = Array.isArray(raw.excludedCategories)
        ? raw.excludedCategories
        : String(raw.excludedCategoryText || '').split(',');
    return {
        ...DEFAULT_LOYALTY_CONFIG,
        ...raw,
        enabled: raw.enabled !== false,
        spendPerPoint: Math.max(1, Math.floor(safeNumber(raw.spendPerPoint, DEFAULT_LOYALTY_CONFIG.spendPerPoint))),
        pointValue: Math.max(0, safeNumber(raw.pointValue, DEFAULT_LOYALTY_CONFIG.pointValue)),
        expiryMonths: Math.max(0, Math.floor(safeNumber(raw.expiryMonths, DEFAULT_LOYALTY_CONFIG.expiryMonths))),
        maxRedeemPercent: Math.min(100, Math.max(0, safeNumber(raw.maxRedeemPercent, DEFAULT_LOYALTY_CONFIG.maxRedeemPercent))),
        minRedeemPoints: Math.max(0, Math.floor(safeNumber(raw.minRedeemPoints, DEFAULT_LOYALTY_CONFIG.minRedeemPoints))),
        earnAfterDiscount: raw.earnAfterDiscount !== false,
        earnOnRedeemedAmount: raw.earnOnRedeemedAmount === true,
        excludedCategories: excludedCategories.map(item => String(item || '').trim()).filter(Boolean),
        tierMultipliers: {
            Silver: Math.max(1, safeNumber(tierMultipliers.Silver, 1)),
            Gold: Math.max(1, safeNumber(tierMultipliers.Gold, DEFAULT_LOYALTY_CONFIG.tierMultipliers.Gold)),
            Platinum: Math.max(1, safeNumber(tierMultipliers.Platinum, DEFAULT_LOYALTY_CONFIG.tierMultipliers.Platinum))
        }
    };
}

function loyaltyCurrency(value) {
    return '฿' + safeNumber(value).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function setLoyaltyFormValues(config = loyaltyConfig) {
    const normalized = normalizeLoyaltyConfig(config);
    const setValue = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = String(value);
    };
    const setChecked = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!value;
    };
    setChecked('loyalty-enabled', normalized.enabled);
    setValue('loyalty-spend-per-point', normalized.spendPerPoint);
    setValue('loyalty-point-value', normalized.pointValue);
    setValue('loyalty-expiry-months', normalized.expiryMonths);
    setValue('loyalty-max-redeem-percent', normalized.maxRedeemPercent);
    setValue('loyalty-min-redeem-points', normalized.minRedeemPoints);
    setValue('loyalty-gold-multiplier', normalized.tierMultipliers.Gold);
    setValue('loyalty-platinum-multiplier', normalized.tierMultipliers.Platinum);
    setChecked('loyalty-earn-after-discount', normalized.earnAfterDiscount);
    setChecked('loyalty-earn-on-redeemed', normalized.earnOnRedeemedAmount);
    setValue('loyalty-excluded-categories', normalized.excludedCategories.join(', '));
}

function readLoyaltyFormPayload() {
    const categoriesText = String(document.getElementById('loyalty-excluded-categories')?.value || '');
    return normalizeLoyaltyConfig({
        enabled: document.getElementById('loyalty-enabled')?.checked !== false,
        spendPerPoint: safeNumber(document.getElementById('loyalty-spend-per-point')?.value, 25),
        pointValue: safeNumber(document.getElementById('loyalty-point-value')?.value, 1),
        expiryMonths: safeNumber(document.getElementById('loyalty-expiry-months')?.value, 24),
        maxRedeemPercent: safeNumber(document.getElementById('loyalty-max-redeem-percent')?.value, 30),
        minRedeemPoints: safeNumber(document.getElementById('loyalty-min-redeem-points')?.value, 20),
        earnAfterDiscount: document.getElementById('loyalty-earn-after-discount')?.checked !== false,
        earnOnRedeemedAmount: document.getElementById('loyalty-earn-on-redeemed')?.checked === true,
        excludedCategories: categoriesText.split(',').map(item => item.trim()).filter(Boolean),
        excludedCategoryText: categoriesText,
        tierMultipliers: {
            Silver: 1,
            Gold: safeNumber(document.getElementById('loyalty-gold-multiplier')?.value, 1.25),
            Platinum: safeNumber(document.getElementById('loyalty-platinum-multiplier')?.value, 1.5)
        },
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser?.uid || ''
    });
}

function setupRealtimeLoyalty() {
    bindLoyaltyForms();
    if (loyaltyConfigUnsubscribe) loyaltyConfigUnsubscribe();
    if (loyaltyLedgerUnsubscribe) loyaltyLedgerUnsubscribe();

    loyaltyConfigUnsubscribe = onSnapshot(doc(db, 'site_settings', 'loyalty'), snap => {
        loyaltyConfig = normalizeLoyaltyConfig(snap.exists() ? snap.data() : DEFAULT_LOYALTY_CONFIG);
        setLoyaltyFormValues(loyaltyConfig);
        renderLoyaltySummary();
    }, error => {
        console.error('Error listening to loyalty config:', error);
    });

    loyaltyLedgerUnsubscribe = onSnapshot(query(collection(db, 'point_ledger'), orderBy('createdAt', 'desc')), snapshot => {
        loyaltyLedgerData = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
        renderLoyaltyLedgerTable();
        renderLoyaltySummary();
    }, error => {
        console.error('Error listening to point ledger:', error);
        const body = document.getElementById('loyalty-ledger-body');
        if (body) body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#c62828;">โหลดประวัติแต้มไม่สำเร็จ: ${escapeHTML(error.message)}</td></tr>`;
    });

    renderLoyaltyMemberOptions();
    renderLoyaltySummary();
}

async function refreshLoyaltyOnce() {
    const configSnap = await getDoc(doc(db, 'site_settings', 'loyalty'));
    loyaltyConfig = normalizeLoyaltyConfig(configSnap.exists() ? configSnap.data() : DEFAULT_LOYALTY_CONFIG);
    const ledgerSnap = await getDocs(query(collection(db, 'point_ledger'), orderBy('createdAt', 'desc')));
    loyaltyLedgerData = ledgerSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    setLoyaltyFormValues(loyaltyConfig);
    renderLoyaltyMemberOptions();
    renderLoyaltyLedgerTable();
    renderLoyaltySummary();
}

function bindLoyaltyForms() {
    if (loyaltyFormsBound) return;
    const configForm = document.getElementById('loyalty-config-form');
    const adjustForm = document.getElementById('loyalty-adjust-form');

    configForm?.addEventListener('submit', async event => {
        event.preventDefault();
        if (!canAdmin('loyalty')) {
            alert('บัญชีนี้ไม่มีสิทธิ์จัดการแต้มสมาชิก');
            return;
        }
        try {
            await setDoc(doc(db, 'site_settings', 'loyalty'), readLoyaltyFormPayload(), { merge: true });
            alert('บันทึกกติกาแต้มเรียบร้อย');
        } catch (error) {
            console.error('Unable to save loyalty config:', error);
            alert(safeAdminError("บันทึกกติกาแต้มไม่สำเร็จ"));
        }
    });

    adjustForm?.addEventListener('submit', async event => {
        event.preventDefault();
        if (!canAdmin('loyalty')) {
            alert('บัญชีนี้ไม่มีสิทธิ์ปรับแต้มสมาชิก');
            return;
        }
        const userId = String(document.getElementById('loyalty-adjust-user')?.value || '').trim();
        const pointsDelta = Math.trunc(safeNumber(document.getElementById('loyalty-adjust-points')?.value, 0));
        const reason = String(document.getElementById('loyalty-adjust-reason')?.value || '').trim();
        if (!userId) {
            alert('กรุณาเลือกสมาชิก');
            return;
        }
        if (!pointsDelta) {
            alert('กรุณาระบุจำนวนแต้มที่ต้องการเพิ่มหรือลด');
            return;
        }
        if (!reason) {
            alert('กรุณาระบุเหตุผลในการปรับแต้ม');
            return;
        }
        try {
            await callAdminFunction('adjustMemberPoints', { userId, pointsDelta, reason });
            adjustForm.reset();
            alert('บันทึกการปรับแต้มเรียบร้อย');
        } catch (error) {
            console.error('Unable to adjust member points:', error);
            alert(safeAdminError("ปรับแต้มไม่สำเร็จ"));
        }
    });

    loyaltyFormsBound = true;
}

function renderLoyaltyMemberOptions() {
    const select = document.getElementById('loyalty-adjust-user');
    if (!select) return;
    const current = select.value;
    const rows = Object.entries(membersData || {})
        .map(([uid, member]) => ({ uid, member }))
        .sort((a, b) => memberDisplayName(a.member).localeCompare(memberDisplayName(b.member), 'th'));
    select.innerHTML = '<option value="">-- เลือกสมาชิก --</option>' + rows.map(({ uid, member }) => {
        const points = safeNumber(member.points);
        return `<option value="${escapeHTML(uid)}">${escapeHTML(memberDisplayName(member))} - ${escapeHTML(member.email || uid)} (${points.toLocaleString('th-TH')} แต้ม)</option>`;
    }).join('');
    if (current && rows.some(row => row.uid === current)) select.value = current;
}

function renderLoyaltySummary() {
    const config = normalizeLoyaltyConfig(loyaltyConfig);
    const members = Object.values(membersData || {});
    const totalPoints = members.reduce((sum, member) => sum + Math.max(0, Math.floor(safeNumber(member.points))), 0);
    const membersWithPoints = members.filter(member => safeNumber(member.points) > 0).length;
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setText('loyalty-stat-points', totalPoints.toLocaleString('th-TH'));
    setText('loyalty-stat-liability', loyaltyCurrency(totalPoints * config.pointValue));
    setText('loyalty-stat-members', membersWithPoints.toLocaleString('th-TH'));
    setText('loyalty-stat-ledger', loyaltyLedgerData.length.toLocaleString('th-TH'));
    renderDashboardSalesReport();
}

function renderLoyaltyLedgerTable() {
    const body = document.getElementById('loyalty-ledger-body');
    if (!body) return;
    const rows = loyaltyLedgerData.slice(0, 80);
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="7"><div class="loyalty-empty">ยังไม่มีประวัติแต้ม ระบบจะเริ่มบันทึกเมื่อมีการปรับแต้ม หรือเมื่อ POS/Checkout เชื่อมเข้ามา</div></td></tr>';
        return;
    }
    body.innerHTML = rows.map(row => {
        const delta = Math.trunc(safeNumber(row.pointsDelta));
        const member = row.userId && membersData[row.userId] ? membersData[row.userId] : null;
        const memberName = row.memberName || (member ? memberDisplayName(member) : row.userId || '-');
        const memberEmail = row.memberEmail || member?.email || '';
        const deltaClass = delta >= 0 ? 'loyalty-points-positive' : 'loyalty-points-negative';
        const deltaText = `${delta >= 0 ? '+' : ''}${delta.toLocaleString('th-TH')}`;
        return `
            <tr>
                <td>${escapeHTML(formatDate(row.createdAt))}</td>
                <td><strong>${escapeHTML(memberName)}</strong><small>${escapeHTML(memberEmail)}</small></td>
                <td>${escapeHTML(row.type || '-')}</td>
                <td class="${deltaClass}">${escapeHTML(deltaText)}</td>
                <td>${safeNumber(row.pointsAfter).toLocaleString('th-TH')}</td>
                <td>${escapeHTML(row.reason || row.orderId || '-')}<small>${escapeHTML(row.source || '')}</small></td>
                <td>${escapeHTML(row.createdByEmail || row.createdBy || '-')}</td>
            </tr>
        `;
    }).join('');
}

window.exportLoyaltyLiabilityCSV = function exportLoyaltyLiabilityCSV() {
    const config = normalizeLoyaltyConfig(loyaltyConfig);
    const header = ['uid', 'memberCode', 'name', 'email', 'tier', 'pointsBalance', 'pointValue', 'liabilityBaht', 'updatedAt'];
    const rows = Object.entries(membersData || {})
        .map(([uid, member]) => {
            const points = Math.max(0, Math.floor(safeNumber(member.points)));
            return [
                uid,
                member.memberCode || '',
                memberDisplayName(member),
                member.email || '',
                memberTier(member),
                points,
                config.pointValue,
                points * config.pointValue,
                member.updatedAt ? formatDate(member.updatedAt) : ''
            ];
        })
        .filter(row => safeNumber(row[5]) > 0);
    const csv = [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eden-loyalty-liability-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
};

window.refreshLoyalty = () => window.refreshAdminSection('loyalty');

function hasLoyverseImportMode() {
    return new URLSearchParams(window.location.search).has('menu-import');
}

function stripUndefinedDeep(value) {
    if (Array.isArray(value)) return value.map(stripUndefinedDeep);
    if (value && typeof value === 'object') {
        return Object.entries(value).reduce((acc, [key, item]) => {
            if (item !== undefined) acc[key] = stripUndefinedDeep(item);
            return acc;
        }, {});
    }
    return value;
}

async function commitFirestoreOperations(operations, onProgress) {
    let batch = writeBatch(db);
    let count = 0;
    let committed = 0;

    for (const operation of operations) {
        if (operation.type === 'delete') batch.delete(operation.ref);
        if (operation.type === 'set') batch.set(operation.ref, stripUndefinedDeep(operation.data), { merge: false });
        count += 1;

        if (count >= 450) {
            await batch.commit();
            committed += count;
            if (onProgress) onProgress(committed);
            batch = writeBatch(db);
            count = 0;
        }
    }

    if (count > 0) {
        await batch.commit();
        committed += count;
        if (onProgress) onProgress(committed);
    }
}

async function replaceMenuWithLoyversePayload(payload, statusEl) {
    const categories = Array.isArray(payload?.categories) ? payload.categories : [];
    const products = Array.isArray(payload?.products) ? payload.products : [];
    if (!categories.length || !products.length) {
        throw new Error('Import JSON must contain categories[] and products[].');
    }

    statusEl.textContent = 'Reading current menu...';
    const [oldProductSnap, oldCategorySnap] = await Promise.all([
        getDocs(collection(db, 'products')),
        getDocs(collection(db, 'categories'))
    ]);

    const operations = [];
    oldProductSnap.forEach(snapshot => operations.push({ type: 'delete', ref: doc(db, 'products', snapshot.id) }));
    oldCategorySnap.forEach(snapshot => operations.push({ type: 'delete', ref: doc(db, 'categories', snapshot.id) }));

    categories.forEach((category, index) => {
        const id = String(category.id || category.handle || `category-${index + 1}`).trim();
        if (!id || id.includes('/')) throw new Error(`Invalid category id at row ${index + 1}.`);
        operations.push({
            type: 'set',
            ref: doc(db, 'categories', id),
            data: { ...category, id, updatedAt: serverTimestamp() }
        });
    });

    products.forEach((product, index) => {
        const id = String(product.id || product.handle || `product-${index + 1}`).trim();
        if (!id || id.includes('/')) throw new Error(`Invalid product id at row ${index + 1}.`);
        operations.push({
            type: 'set',
            ref: doc(db, 'products', id),
            data: { ...product, id, handle: product.handle || id, updatedAt: serverTimestamp() }
        });
    });

    statusEl.textContent = `Importing ${products.length} products and ${categories.length} categories...`;
    await commitFirestoreOperations(operations, (done) => {
        statusEl.textContent = `Imported ${done}/${operations.length} operations...`;
    });

    statusEl.textContent = `Done. Replaced ${oldProductSnap.size} old products with ${products.length} Loyverse products.`;
}

function initLoyverseImportTool() {
    if (!hasLoyverseImportMode() || document.getElementById('loyverse-import-tool')) return;
    const dashboard = document.getElementById('dashboard');
    if (!dashboard) return;

    const panel = document.createElement('div');
    panel.id = 'loyverse-import-tool';
    panel.className = 'section-container';
    panel.style.maxWidth = '980px';
    panel.style.border = '2px solid #2f8f46';
    panel.innerHTML = `
        <div class="section-header">
            <h2>Loyverse Menu Import</h2>
        </div>
        <p style="margin-bottom:12px;color:#475569;">Paste the prepared Loyverse JSON below. This replaces all current menu products and menu categories.</p>
        <textarea id="loyverse-import-json" placeholder="Paste loyverse-products-import-ready JSON here" style="width:100%;min-height:220px;border:1px solid #cbd5e1;border-radius:10px;padding:12px;font-family:Consolas,monospace;font-size:13px;"></textarea>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px;">
            <button id="btn-loyverse-import" class="btn" type="button">Replace Menu From Loyverse JSON</button>
            <span id="loyverse-import-status" style="color:#475569;font-weight:600;">Ready</span>
        </div>
    `;
    dashboard.insertBefore(panel, dashboard.firstChild);

    const textarea = panel.querySelector('#loyverse-import-json');
    const button = panel.querySelector('#btn-loyverse-import');
    const status = panel.querySelector('#loyverse-import-status');

    button.addEventListener('click', async () => {
        status.textContent = 'Parsing JSON...';
        try {
            const payload = JSON.parse(textarea.value || '{}');
            const products = Array.isArray(payload.products) ? payload.products : [];
            const categories = Array.isArray(payload.categories) ? payload.categories : [];
            if (!confirm(`Replace current menu with ${products.length} products and ${categories.length} categories from Loyverse?`)) {
                status.textContent = 'Cancelled.';
                return;
            }
            button.disabled = true;
            await replaceMenuWithLoyversePayload(payload, status);
        } catch (error) {
            console.error('Loyverse import failed:', error);
            status.textContent = 'Import failed: ' + error.message;
        } finally {
            button.disabled = false;
        }
    });
}

function applyAdminAccessUI() {
    document.querySelectorAll('.sidebar-menu li').forEach(li => {
        const match = String(li.getAttribute('onclick') || '').match(/switchTab\('([^']+)'/);
        const tabId = match ? match[1] : '';
        const directPermission = li.dataset.permission || '';
        const allowed = directPermission ? canAdmin(directPermission) : (!tabId || window.canAccessAdminTab(tabId));
        li.style.display = allowed ? '' : 'none';
        li.classList.toggle('access-disabled', !allowed);
    });

    document.querySelectorAll('.content-section').forEach(section => {
        const allowed = window.canAccessAdminTab(section.id);
        section.dataset.accessAllowed = allowed ? 'true' : 'false';
    });

    restoreAdminActiveTab();
    updateXLSXToolsState();
}

// Fetch Stats for Dashboard
async function fetchStats() {
    try {
        const statsRef = doc(db, 'stats', 'pageViews');
        const [snap, promptPaySnap, discountsSnap] = await Promise.all([
            getDoc(statsRef),
            getDoc(doc(db, 'site_settings', 'promptpay')).catch(error => {
                console.warn('Unable to load PromptPay status for dashboard:', error);
                return null;
            }),
            getDocs(query(collection(db, 'pos_discounts'))).catch(error => {
                console.warn('Unable to load POS discounts for dashboard:', error);
                return null;
            })
        ]);
        const viewsEl = document.getElementById('stat-views-daily');
        if (snap.exists() && viewsEl) {
            const data = snap.data();
            dashboardStatsData = data || {};
            viewsEl.innerText = (data.dailyViews || 0).toLocaleString();
        } else {
            dashboardStatsData = {};
        }
        if (promptPaySnap?.exists()) {
            dashboardPromptPaySettings = normalizePromptPaySettings(promptPaySnap.data());
        } else if (promptPaySnap) {
            dashboardPromptPaySettings = defaultPromptPaySettings();
        }
        if (discountsSnap?.docs && !discountsUnsubscribe) {
            discountsData = {};
            discountsSnap.forEach(docSnap => {
                discountsData[docSnap.id] = normalizeDiscountOption(docSnap.id, docSnap.data() || {});
            });
        }
        renderDashboardSalesReport();
    } catch (e) {
        console.error("Error fetching stats:", e);
    }
}

function adminMoney(value) {
    const amount = safeNumber(value);
    const hasSatang = Math.abs(amount % 1) > 0.001;
    return '฿' + amount.toLocaleString('th-TH', {
        minimumFractionDigits: hasSatang ? 2 : 0,
        maximumFractionDigits: 2
    });
}

function localDateKey(date = new Date()) {
    const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const year = safeDate.getFullYear();
    const month = String(safeDate.getMonth() + 1).padStart(2, '0');
    const day = String(safeDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseLocalDateKey(key) {
    const match = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addLocalDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + Number(days || 0));
    return next;
}

function dashboardPresetRange(preset = 'today') {
    const today = new Date();
    const todayKey = localDateKey(today);
    if (preset === 'yesterday') {
        const yesterday = addLocalDays(today, -1);
        return { startKey: localDateKey(yesterday), endKey: localDateKey(yesterday) };
    }
    if (preset === 'week') {
        return { startKey: localDateKey(addLocalDays(today, -6)), endKey: todayKey };
    }
    if (preset === 'eleven_weeks') {
        return { startKey: localDateKey(addLocalDays(today, -76)), endKey: todayKey };
    }
    if (preset === 'month') {
        return { startKey: localDateKey(addLocalDays(today, -29)), endKey: todayKey };
    }
    return { startKey: todayKey, endKey: todayKey };
}

function defaultDashboardFilters() {
    const range = dashboardPresetRange('today');
    return {
        datePreset: 'today',
        startKey: range.startKey,
        endKey: range.endKey,
        timePreset: 'all',
        timeStart: '06:00',
        timeEnd: '18:00',
        source: 'all',
        employee: 'all'
    };
}

function ensureDashboardFilters() {
    if (!dashboardFilters) dashboardFilters = defaultDashboardFilters();
    if (!dashboardFilters.startKey || !dashboardFilters.endKey) {
        const range = dashboardPresetRange(dashboardFilters.datePreset || 'today');
        dashboardFilters.startKey = range.startKey;
        dashboardFilters.endKey = range.endKey;
    }
    if (dashboardFilters.startKey > dashboardFilters.endKey) {
        const startKey = dashboardFilters.endKey;
        dashboardFilters.endKey = dashboardFilters.startKey;
        dashboardFilters.startKey = startKey;
    }
    return dashboardFilters;
}

function dashboardDateRange() {
    const filters = ensureDashboardFilters();
    return {
        startKey: filters.startKey,
        endKey: filters.endKey,
        start: parseLocalDateKey(filters.startKey) || new Date(),
        end: parseLocalDateKey(filters.endKey) || new Date(),
        todayKey: localDateKey(new Date())
    };
}

function dashboardDatePresetLabel(value = ensureDashboardFilters().datePreset) {
    return {
        today: 'วันนี้',
        yesterday: 'เมื่อวาน',
        week: '1 สัปดาห์',
        eleven_weeks: '11 สัปดาห์',
        month: '1 เดือน',
        custom: 'กำหนดเอง'
    }[value] || 'วันนี้';
}

function dashboardTimeLabel(value = ensureDashboardFilters().timePreset) {
    const filters = ensureDashboardFilters();
    if (value === 'morning') return 'เช้า 06:00-12:00';
    if (value === 'afternoon') return 'บ่าย 12:00-18:00';
    if (value === 'evening') return 'เย็น 18:00-24:00';
    if (value === 'custom') return `${filters.timeStart || '00:00'}-${filters.timeEnd || '23:59'}`;
    return 'ทั้งวัน';
}

function dashboardSourceLabel(value = ensureDashboardFilters().source) {
    return { all: 'ทั้งหมด', pos: 'POS', online: 'Online', booking: 'Booking' }[value] || 'ทั้งหมด';
}

function timeTextToMinutes(value, fallback = null) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return fallback;
    const hour = Math.max(0, Math.min(24, Number(match[1])));
    const minute = Math.max(0, Math.min(59, Number(match[2])));
    return Math.min(24 * 60, (hour * 60) + minute);
}

function dashboardTimeWindow() {
    const filters = ensureDashboardFilters();
    if (filters.timePreset === 'morning') return { start: 6 * 60, end: 12 * 60 };
    if (filters.timePreset === 'afternoon') return { start: 12 * 60, end: 18 * 60 };
    if (filters.timePreset === 'evening') return { start: 18 * 60, end: 24 * 60 };
    if (filters.timePreset === 'custom') {
        return {
            start: timeTextToMinutes(filters.timeStart, 0),
            end: timeTextToMinutes(filters.timeEnd, 24 * 60)
        };
    }
    return null;
}

function isMinuteInDashboardWindow(minute) {
    const windowRange = dashboardTimeWindow();
    if (!windowRange) return true;
    if (!Number.isFinite(minute)) return true;
    if (windowRange.start <= windowRange.end) return minute >= windowRange.start && minute < windowRange.end;
    return minute >= windowRange.start || minute < windowRange.end;
}

function timestampToMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function dashboardMinutesFromMillis(value) {
    if (!value) return NaN;
    const date = new Date(value);
    return (date.getHours() * 60) + date.getMinutes();
}

function dashboardBookingDateKey(booking = {}) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(booking.date || ''))) return booking.date;
    const time = timestampToMillis(booking.timestamp || booking.createdAt);
    return time ? localDateKey(new Date(time)) : '';
}

function dashboardBookingTimeMinutes(booking = {}) {
    const textTime = booking.startTime || booking.arrivalTime || booking.time || '';
    const fromText = timeTextToMinutes(textTime, null);
    if (fromText !== null) return fromText;
    return dashboardMinutesFromMillis(timestampToMillis(booking.timestamp || booking.createdAt));
}

function dashboardSourceMatchesOrder(order = {}) {
    const source = String(order.source || order.orderType || '').toLowerCase();
    const orderType = String(order.orderType || '').toLowerCase();
    const filter = ensureDashboardFilters().source;
    if (filter === 'all') return true;
    if (filter === 'booking') return false;
    if (filter === 'pos') return source === 'pos' || orderType === 'pos';
    if (filter === 'online') return source === 'online' || orderType === 'online' || orderType === 'shop' || !source;
    return true;
}

function dashboardSourceMatchesBooking() {
    const filter = ensureDashboardFilters().source;
    return filter === 'all' || filter === 'booking';
}

function dashboardOrderSourceLabel(order = {}) {
    return String(order.source || order.orderType || '').toLowerCase() === 'pos' ? 'POS' : 'Online';
}

function dashboardBookingMatchesRange(booking = {}) {
    const key = dashboardBookingDateKey(booking);
    const range = dashboardDateRange();
    return !!key && key >= range.startKey && key <= range.endKey;
}

function dashboardBookingMatchesTime(booking = {}) {
    return isMinuteInDashboardWindow(dashboardBookingTimeMinutes(booking));
}

function dashboardBookingMatchesEmployee(booking = {}) {
    const employee = ensureDashboardFilters().employee;
    if (employee === 'all') return true;
    const key = normalizeEmail(booking.cashierEmail || booking.staffEmail || booking.assignedToEmail)
        || String(booking.cashierUid || booking.staffUid || booking.assignedTo || booking.staffName || '');
    return key && key === employee;
}

function dashboardFilteredBookings() {
    return dashboardBookingsData
        .filter(dashboardBookingMatchesRange)
        .filter(dashboardBookingMatchesTime)
        .filter(dashboardSourceMatchesBooking)
        .filter(dashboardBookingMatchesEmployee);
}

function dashboardOperationalOrders() {
    return dashboardOrdersData
        .filter(order => !order.isTestOrder && !order.softLaunch)
        .filter(isOrderInSalesReportRange)
        .filter(isOrderInSalesReportTime)
        .filter(isOrderForSalesReportEmployee)
        .filter(dashboardSourceMatchesOrder);
}

function isOpenBillOrder(order = {}) {
    const billStatus = String(order.billStatus || '').toLowerCase();
    const paymentStatus = String(order.paymentStatus || '').toLowerCase();
    const status = String(order.status || '').toLowerCase();
    return String(order.source || '').toLowerCase() === 'pos'
        && (billStatus === 'open' || order.isOpenBill === true)
        && paymentStatus !== 'paid'
        && paymentStatus !== 'refunded'
        && status !== 'cancelled';
}

function setDashboardText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function setDashboardHealthState(id, state = '') {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('ok', 'warn', 'risk');
    if (state) el.classList.add(state);
}

function dashboardFilterLabel() {
    const range = dashboardDateRange();
    return `${dashboardDatePresetLabel()} · ${range.startKey} ถึง ${range.endKey} · ${dashboardTimeLabel()} · ${dashboardSourceLabel()}`;
}

function syncDashboardFilterControls() {
    const filters = ensureDashboardFilters();
    document.querySelectorAll('[data-dashboard-date-preset]').forEach(button => {
        button.classList.toggle('active', button.dataset.dashboardDatePreset === filters.datePreset);
    });
    document.querySelectorAll('[data-dashboard-time-preset]').forEach(button => {
        button.classList.toggle('active', button.dataset.dashboardTimePreset === filters.timePreset);
    });
    document.querySelectorAll('[data-dashboard-source]').forEach(button => {
        button.classList.toggle('active', button.dataset.dashboardSource === filters.source);
    });

    const dateFields = document.getElementById('dashboard-custom-date-fields');
    const timeFields = document.getElementById('dashboard-custom-time-fields');
    dateFields?.classList.toggle('active', filters.datePreset === 'custom');
    timeFields?.classList.toggle('active', filters.timePreset === 'custom');

    const startDate = document.getElementById('dashboard-start-date');
    const endDate = document.getElementById('dashboard-end-date');
    const startTime = document.getElementById('dashboard-time-start');
    const endTime = document.getElementById('dashboard-time-end');
    const employee = document.getElementById('dashboard-employee-filter');
    if (startDate && startDate.value !== filters.startKey) startDate.value = filters.startKey;
    if (endDate && endDate.value !== filters.endKey) endDate.value = filters.endKey;
    if (startTime && startTime.value !== filters.timeStart) startTime.value = filters.timeStart;
    if (endTime && endTime.value !== filters.timeEnd) endTime.value = filters.timeEnd;
    if (employee && employee.value !== filters.employee) employee.value = filters.employee;

    salesReportTimeFilter = filters.timePreset;
    salesReportEmployeeFilter = filters.employee;
    setDashboardText('dashboard-filter-summary', dashboardFilterLabel());
    setDashboardText('dashboard-exec-note', dashboardFilterLabel());
}

function renderDashboardAfterFilterChange() {
    syncDashboardFilterControls();
    renderDashboardSalesReport();
}

function setDashboardDatePreset(preset = 'today') {
    const filters = ensureDashboardFilters();
    const safePreset = ['today', 'yesterday', 'week', 'eleven_weeks', 'month', 'custom'].includes(preset) ? preset : 'today';
    filters.datePreset = safePreset;
    if (safePreset !== 'custom') {
        const range = dashboardPresetRange(safePreset);
        filters.startKey = range.startKey;
        filters.endKey = range.endKey;
    }
    renderDashboardAfterFilterChange();
}

function setDashboardTimePreset(preset = 'all') {
    const filters = ensureDashboardFilters();
    filters.timePreset = ['all', 'morning', 'afternoon', 'evening', 'custom'].includes(preset) ? preset : 'all';
    renderDashboardAfterFilterChange();
}

function setDashboardSource(source = 'all') {
    const filters = ensureDashboardFilters();
    filters.source = ['all', 'pos', 'online', 'booking'].includes(source) ? source : 'all';
    renderDashboardAfterFilterChange();
}

function bindDashboardFilters() {
    ensureDashboardFilters();
    if (dashboardFiltersBound) {
        syncDashboardFilterControls();
        return;
    }
    document.getElementById('dashboard-date-presets')?.addEventListener('click', event => {
        const button = event.target.closest('[data-dashboard-date-preset]');
        if (button) setDashboardDatePreset(button.dataset.dashboardDatePreset);
    });
    document.getElementById('dashboard-time-presets')?.addEventListener('click', event => {
        const button = event.target.closest('[data-dashboard-time-preset]');
        if (button) setDashboardTimePreset(button.dataset.dashboardTimePreset);
    });
    document.getElementById('dashboard-source-presets')?.addEventListener('click', event => {
        const button = event.target.closest('[data-dashboard-source]');
        if (button) setDashboardSource(button.dataset.dashboardSource);
    });
    document.getElementById('dashboard-start-date')?.addEventListener('change', event => {
        const filters = ensureDashboardFilters();
        filters.datePreset = 'custom';
        filters.startKey = event.target.value || filters.startKey;
        if (filters.startKey > filters.endKey) filters.endKey = filters.startKey;
        renderDashboardAfterFilterChange();
    });
    document.getElementById('dashboard-end-date')?.addEventListener('change', event => {
        const filters = ensureDashboardFilters();
        filters.datePreset = 'custom';
        filters.endKey = event.target.value || filters.endKey;
        if (filters.startKey > filters.endKey) filters.startKey = filters.endKey;
        renderDashboardAfterFilterChange();
    });
    document.getElementById('dashboard-time-start')?.addEventListener('change', event => {
        const filters = ensureDashboardFilters();
        filters.timePreset = 'custom';
        filters.timeStart = event.target.value || filters.timeStart;
        renderDashboardAfterFilterChange();
    });
    document.getElementById('dashboard-time-end')?.addEventListener('change', event => {
        const filters = ensureDashboardFilters();
        filters.timePreset = 'custom';
        filters.timeEnd = event.target.value || filters.timeEnd;
        renderDashboardAfterFilterChange();
    });
    document.getElementById('dashboard-employee-filter')?.addEventListener('change', event => {
        ensureDashboardFilters().employee = event.target.value || 'all';
        renderDashboardAfterFilterChange();
    });
    dashboardFiltersBound = true;
    syncDashboardFilterControls();
}

function openDashboardTab(tabId) {
    const menu = adminMenuItemForTab(tabId);
    if (menu && typeof window.switchTab === 'function') window.switchTab(tabId, menu);
}
window.openDashboardTab = openDashboardTab;

function salesReportRange() {
    const range = dashboardDateRange();
    return {
        start: range.start,
        end: range.end,
        startKey: range.startKey,
        endKey: range.endKey,
        todayKey: range.todayKey
    };
}

function salesReportDateLabel(date = new Date()) {
    return date.toLocaleDateString('th-TH', {
        weekday: 'long',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function salesReportRangeLabel() {
    const range = salesReportRange();
    return `${range.start.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })} - ${range.end.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function dashboardReportDateLabel() {
    return 'ช่วงวันที่ ' + salesReportRangeLabel();
}

function isPaidOrderForReportDate(order = {}) {
    const status = String(order.status || '').toLowerCase();
    const paymentStatus = String(order.paymentStatus || '').toLowerCase();
    return paymentStatus === 'paid' || status === 'completed';
}

function orderReportDateValue(order = {}) {
    const paid = isPaidOrderForReportDate(order);
    const raw = paid
        ? (order.paidAt || order.closedAt || order.businessDate || order.timestamp || order.createdAt || order.date)
        : (order.openedAt || order.businessDate || order.createdAt || order.timestamp || order.date);
    return timestampToMillis(raw);
}

function orderReportDateKey(order = {}) {
    const paid = isPaidOrderForReportDate(order);
    if (paid) {
        const paidTime = timestampToMillis(order.paidAt || order.closedAt);
        if (paidTime) return localDateKey(new Date(paidTime));
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(order.businessDate || ''))) return order.businessDate;
    } else {
        const openedTime = timestampToMillis(order.openedAt || order.createdAt || order.timestamp || order.date);
        if (openedTime) return localDateKey(new Date(openedTime));
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(order.businessDate || ''))) return order.businessDate;
    }
    const time = orderReportDateValue(order);
    return time ? localDateKey(new Date(time)) : '';
}

function isOrderInSalesReportRange(order = {}) {
    const key = orderReportDateKey(order);
    const range = salesReportRange();
    return !!key && key >= range.startKey && key <= range.endKey;
}

function isOrderInSalesReportTime(order = {}) {
    const time = orderReportDateValue(order);
    return isMinuteInDashboardWindow(dashboardMinutesFromMillis(time));
}

function isOrderForSalesReportEmployee(order = {}) {
    if (salesReportEmployeeFilter === 'all') return true;
    const key = salesReportEmployeeKey(order);
    return key === salesReportEmployeeFilter;
}

function salesReportPaymentLabel(method, fallback = '') {
    const labels = {
        cash: 'เงินสด',
        transfer: 'โอนเงิน',
        qr: 'QR Payment',
        card: 'บัตร',
        other: 'อื่น ๆ'
    };
    return labels[String(method || '').toLowerCase()] || fallback || method || 'ไม่ระบุ';
}

function isSalesReportOrder(order = {}) {
    const status = String(order.status || '').toLowerCase();
    const paymentStatus = String(order.paymentStatus || (order.source === 'pos' ? 'paid' : '')).toLowerCase();
    const billStatus = String(order.billStatus || '').toLowerCase();
    if (order.isTestOrder || order.softLaunch || status === 'cancelled' || status === 'voided') return false;
    if (billStatus === 'open' || paymentStatus === 'pending') return false;
    return paymentStatus === 'paid' || status === 'completed';
}

function isRefundOrder(order = {}) {
    const status = String(order.status || '').toLowerCase();
    const paymentStatus = String(order.paymentStatus || '').toLowerCase();
    return !order.isTestOrder && (status === 'refunded' || paymentStatus === 'refunded');
}

function dashboardRevenueOrders() {
    return dashboardOrdersData
        .filter(isSalesReportOrder)
        .filter(isOrderInSalesReportRange)
        .filter(isOrderInSalesReportTime)
        .filter(isOrderForSalesReportEmployee)
        .filter(dashboardSourceMatchesOrder);
}

function dashboardRefundOrders() {
    return dashboardOrdersData
        .filter(isRefundOrder)
        .filter(isOrderInSalesReportRange)
        .filter(isOrderInSalesReportTime)
        .filter(isOrderForSalesReportEmployee)
        .filter(dashboardSourceMatchesOrder);
}

function orderReportTotal(order = {}) {
    return safeNumber(order.totalAmount ?? order.total ?? order.totals?.total);
}

function orderReportGross(order = {}) {
    return safeNumber(order.subtotal ?? order.totals?.subtotal, orderReportTotal(order) + safeNumber(order.discount ?? order.totals?.discount));
}

function orderReportDiscount(order = {}) {
    return safeNumber(order.discount ?? order.totals?.discount);
}

function orderReportTax(order = {}) {
    return safeNumber(order.taxIncluded ?? order.totals?.taxIncluded);
}

function orderReportItems(order = {}) {
    return Array.isArray(order.items) ? order.items.filter(Boolean) : [];
}

function itemReportAmount(item = {}) {
    const quantity = Math.max(0, safeNumber(item.quantity, 1));
    return safeNumber(item.lineTotal, safeNumber(item.price) * quantity);
}

function itemReportCost(item = {}) {
    const quantity = Math.max(0, safeNumber(item.quantity, 1));
    return safeNumber(item.cost) * quantity;
}

function orderReportCost(order = {}) {
    return orderReportItems(order).reduce((sum, item) => sum + itemReportCost(item), 0);
}

function salesReportEmployeeKey(order = {}) {
    return normalizeEmail(order.cashierEmail) || String(order.cashierUid || order.cashierName || 'unknown');
}

function salesReportEmployeeName(order = {}) {
    return order.cashierName || order.cashierEmail || 'ไม่ระบุพนักงาน';
}

function pushSalesReportGroup(groups, key, label, amount, quantity = 0) {
    const safeKey = String(key || label || 'unknown');
    const current = groups.get(safeKey) || { label: label || 'ไม่ระบุ', amount: 0, quantity: 0 };
    current.amount += safeNumber(amount);
    current.quantity += safeNumber(quantity);
    groups.set(safeKey, current);
}

function sortedSalesReportGroups(groups) {
    return Array.from(groups.values())
        .sort((a, b) => (b.amount - a.amount) || (b.quantity - a.quantity) || String(a.label).localeCompare(String(b.label), 'th'));
}

function reportSummaryTotals(orders = dashboardRevenueOrders()) {
    const refunds = dashboardRefundOrders().reduce((sum, order) => sum + orderReportTotal(order), 0);
    const gross = orders.reduce((sum, order) => sum + orderReportGross(order), 0);
    const discounts = orders.reduce((sum, order) => sum + orderReportDiscount(order), 0);
    const net = orders.reduce((sum, order) => sum + orderReportTotal(order), 0);
    const cost = orders.reduce((sum, order) => sum + orderReportCost(order), 0);
    const tax = orders.reduce((sum, order) => sum + orderReportTax(order), 0);
    const profit = net - cost;
    const margin = net > 0 ? (profit / net) * 100 : 0;
    return { refunds, gross, discounts, net, cost, tax, profit, margin, count: orders.length };
}

function buildDailySalesRows() {
    const range = salesReportRange();
    const revenueOrders = dashboardRevenueOrders();
    const refunds = dashboardRefundOrders();
    const byDate = new Map();

    for (let cursor = new Date(range.start); cursor <= range.end; cursor.setDate(cursor.getDate() + 1)) {
        const key = localDateKey(cursor);
        byDate.set(key, { key, date: new Date(cursor), gross: 0, refunds: 0, discounts: 0, net: 0, cost: 0, profit: 0, margin: 0, tax: 0 });
    }

    revenueOrders.forEach(order => {
        const key = orderReportDateKey(order);
        if (!byDate.has(key)) return;
        const row = byDate.get(key);
        row.gross += orderReportGross(order);
        row.discounts += orderReportDiscount(order);
        row.net += orderReportTotal(order);
        row.cost += orderReportCost(order);
        row.tax += orderReportTax(order);
    });

    refunds.forEach(order => {
        const key = orderReportDateKey(order);
        if (!byDate.has(key)) return;
        byDate.get(key).refunds += orderReportTotal(order);
    });

    byDate.forEach(row => {
        row.profit = row.net - row.cost;
        row.margin = row.net > 0 ? (row.profit / row.net) * 100 : 0;
    });

    return Array.from(byDate.values()).sort((a, b) => b.key.localeCompare(a.key));
}

function buildDashboardSalesReportRows(type, orders = dashboardRevenueOrders()) {
    const groups = new Map();

    if (type === 'summary') return buildDailySalesRows();

    if (type === 'receipts') {
        return orders
            .slice()
            .sort((a, b) => orderReportDateValue(b) - orderReportDateValue(a))
            .map(order => ({
                label: order.receiptNo || order.orderNumber || order.id || order.firestoreId || 'ใบเสร็จ',
                amount: orderReportTotal(order),
                meta: [salesReportOrderDateText(order), order.cashierName || order.customerName || ''].filter(Boolean).join(' · ')
            }));
    }

    if (type === 'discounts') {
        orders.forEach(order => {
            const discount = orderReportDiscount(order);
            if (!discount) return;
            const label = order.totals?.discountLabel || order.discountLabel || 'ส่วนลดหน้าร้าน';
            pushSalesReportGroup(groups, label, label, discount, 1);
        });
        return sortedSalesReportGroups(groups);
    }

    if (type === 'taxes') {
        orders.forEach(order => {
            const tax = orderReportTax(order);
            if (!tax) return;
            const label = order.receiptNo || order.orderNumber || order.id || 'ภาษีรวมในราคา';
            pushSalesReportGroup(groups, label, label, tax, 1);
        });
        return sortedSalesReportGroups(groups);
    }

    orders.forEach(order => {
        if (type === 'staff') {
            const label = salesReportEmployeeName(order);
            pushSalesReportGroup(groups, salesReportEmployeeKey(order), label, orderReportTotal(order), 1);
            return;
        }
        if (type === 'payment') {
            const label = order.paymentLabel || salesReportPaymentLabel(order.paymentMethod);
            pushSalesReportGroup(groups, label, label, orderReportTotal(order), 1);
            return;
        }

        orderReportItems(order).forEach(item => {
            const quantity = Math.max(0, safeNumber(item.quantity, 1));
            const amount = itemReportAmount(item);
            if (type === 'category') {
                const categoryId = item.category || item.categoryId || '';
                const label = item.categoryName || categoriesData[categoryId]?.name || categoryId || 'ไม่ระบุหมวดหมู่';
                pushSalesReportGroup(groups, categoryId || label, label, amount, quantity);
                return;
            }
            if (type === 'options') {
                const label = item.variantName || item.optionName || 'ไม่มีตัวเลือกเพิ่มเติม';
                pushSalesReportGroup(groups, label, label, amount, quantity);
                return;
            }
            const label = [item.name || item.productName || 'ไม่ระบุสินค้า', item.variantName].filter(Boolean).join(' - ');
            pushSalesReportGroup(groups, label, label, amount, quantity);
        });
    });

    return sortedSalesReportGroups(groups);
}

function updateSalesReportEmployeeOptions() {
    const select = document.getElementById('dashboard-employee-filter') || document.getElementById('sales-report-employee-filter');
    if (!select) return;
    const employees = new Map();
    dashboardOrdersData.forEach(order => {
        const key = salesReportEmployeeKey(order);
        if (!key || key === 'unknown') return;
        employees.set(key, salesReportEmployeeName(order));
    });
    const current = ensureDashboardFilters().employee || salesReportEmployeeFilter;
    select.innerHTML = '<option value="all">ทั้งหมด</option>'
        + Array.from(employees.entries())
            .sort((a, b) => a[1].localeCompare(b[1], 'th'))
            .map(([key, label]) => `<option value="${escapeHTML(key)}">${escapeHTML(label)}</option>`)
            .join('');
    select.value = employees.has(current) ? current : 'all';
    ensureDashboardFilters().employee = select.value;
    salesReportEmployeeFilter = select.value;
}

function updateSalesReportToolbar() {
    bindDashboardFilters();
    syncDashboardFilterControls();
    const rangeLabel = document.getElementById('sales-report-range-label');
    if (rangeLabel) rangeLabel.textContent = salesReportRangeLabel();
    const timeSelect = document.getElementById('sales-report-time-filter');
    if (timeSelect) timeSelect.value = salesReportTimeFilter;
    updateSalesReportEmployeeOptions();
}

function renderSalesReportKpis() {
    const totals = reportSummaryTotals();
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    setText('sales-kpi-refunds', adminMoney(totals.refunds));
    setText('sales-kpi-discounts', adminMoney(totals.discounts));
    setText('sales-kpi-net', adminMoney(totals.net));
    setText('sales-kpi-profit', adminMoney(totals.profit));
    setText('sales-kpi-refunds-note', totals.refunds ? 'มีรายการคืนเงินในช่วงนี้' : 'ไม่มีรายการคืนเงิน');
    setText('sales-kpi-discounts-note', `${totals.count.toLocaleString('th-TH')} ใบเสร็จในช่วงนี้`);
    setText('sales-kpi-net-note', dashboardReportDateLabel());
    setText('sales-kpi-profit-note', `ผลต่าง ${totals.margin.toLocaleString('th-TH', { maximumFractionDigits: 2 })}%`);

    const revenueEl = document.getElementById('stat-revenue');
    const ordersEl = document.getElementById('stat-orders');
    if (revenueEl) revenueEl.innerText = adminMoney(totals.net);
    if (ordersEl) ordersEl.innerText = totals.count.toLocaleString('th-TH');
}

function renderSalesSummaryChart() {
    const canvas = document.getElementById('salesSummaryChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const rows = buildDailySalesRows().slice().reverse();
    const labels = rows.map(row => row.date.toLocaleDateString('th-TH', { day: '2-digit', month: 'short' }));
    const values = rows.map(row => safeNumber(row.net));
    const chartType = activeSalesReport === 'summary' ? 'line' : 'bar';
    const datasetLabel = SALES_REPORT_LABELS[activeSalesReport] || SALES_REPORT_LABELS.summary;
    const reportRows = activeSalesReport === 'summary' ? [] : buildDashboardSalesReportRows(activeSalesReport).slice(0, 10);
    const finalLabels = activeSalesReport === 'summary' ? labels : (reportRows.length ? reportRows.map(row => row.label) : ['ยังไม่มีข้อมูล']);
    const finalValues = activeSalesReport === 'summary' ? values : (reportRows.length ? reportRows.map(row => safeNumber(row.amount)) : [0]);
    const needsRecreate = !salesSummaryChart || salesSummaryChart.config.type !== chartType;

    if (needsRecreate && salesSummaryChart) {
        salesSummaryChart.destroy();
        salesSummaryChart = null;
    }

    const chartData = {
        labels: finalLabels,
        datasets: [{
            label: datasetLabel,
            data: finalValues,
            borderColor: '#79bd3f',
            backgroundColor: chartType === 'line' ? 'rgba(121, 189, 63, 0.12)' : 'rgba(67, 173, 79, 0.72)',
            borderWidth: 2,
            pointRadius: chartType === 'line' ? 3.5 : 0,
            pointBackgroundColor: '#fff',
            pointBorderColor: '#79bd3f',
            pointBorderWidth: 2,
            fill: chartType === 'line',
            tension: 0.32,
            borderRadius: chartType === 'bar' ? 8 : 0,
            borderSkipped: false
        }]
    };

    if (salesSummaryChart) {
        salesSummaryChart.data = chartData;
        salesSummaryChart.update();
        return;
    }

    salesSummaryChart = new Chart(canvas.getContext('2d'), {
        type: chartType,
        data: chartData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: context => adminMoney(chartType === 'line' ? context.parsed.y : context.parsed.y || 0)
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(0,0,0,0.08)' },
                    ticks: { maxRotation: 45, minRotation: 45 }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(0,0,0,0.08)' },
                    ticks: { callback: value => adminMoney(value) }
                }
            }
        }
    });
}

function renderSalesSummaryTable() {
    const head = document.getElementById('sales-summary-table-head');
    const body = document.getElementById('sales-summary-table-body');
    if (!body) return;

    if (activeSalesReport !== 'summary') {
        const rows = buildDashboardSalesReportRows(activeSalesReport);
        const totalAmount = rows.reduce((sum, row) => sum + safeNumber(row.amount), 0);
        const totalQuantity = rows.reduce((sum, row) => sum + safeNumber(row.quantity), 0);
        if (head) {
            head.innerHTML = `
                <tr>
                    <th>รายการ</th>
                    <th>จำนวน</th>
                    <th>ยอดขาย</th>
                    <th>วันที่ / ช่วงเวลา</th>
                </tr>
            `;
        }
        const totalLabel = activeSalesReport === 'category' ? 'ยอดขายรวม' : 'รวมทั้งหมด';
        const totalRow = `
            <tr>
                <td class="sales-date-cell">${escapeHTML(totalLabel)}</td>
                <td>${totalQuantity ? totalQuantity.toLocaleString('th-TH') : rows.length.toLocaleString('th-TH')}</td>
                <td>${adminMoney(totalAmount)}</td>
                <td>${escapeHTML(dashboardReportDateLabel())}</td>
            </tr>
        `;
        if (!rows.length) {
            body.innerHTML = totalRow + `<tr><td colspan="4" class="sales-report-empty">ยังไม่มีข้อมูล ${escapeHTML(SALES_REPORT_LABELS[activeSalesReport] || 'รายงานนี้')}</td></tr>`;
            return;
        }
        body.innerHTML = totalRow + rows.slice(0, 40).map(row => `
            <tr>
                <td class="sales-date-cell">${escapeHTML(row.label)}</td>
                <td>${safeNumber(row.quantity).toLocaleString('th-TH')}</td>
                <td>${adminMoney(row.amount)}</td>
                <td>${escapeHTML(row.meta || dashboardReportDateLabel())}</td>
            </tr>
        `).join('');
        const pageTotal = document.getElementById('sales-table-page-total');
        if (pageTotal) pageTotal.textContent = `จาก ${Math.max(1, Math.ceil(rows.length / 10)).toLocaleString('th-TH')}`;
        return;
    }

    if (head) {
        head.innerHTML = `
            <tr>
                <th>วันที่</th>
                <th>ยอดขาย</th>
                <th>คืนเงิน</th>
                <th>ส่วนลด</th>
                <th>ยอดขายสุทธิ</th>
                <th>ต้นทุนของสินค้า</th>
                <th>กำไรรวม</th>
                <th>ผลต่าง</th>
                <th>ภาษี</th>
            </tr>
        `;
    }
    const rows = buildDailySalesRows();
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="9" class="sales-report-empty">ยังไม่มีข้อมูลยอดขาย</td></tr>';
        return;
    }
    body.innerHTML = rows.map(row => `
        <tr>
            <td class="sales-date-cell">${escapeHTML(salesReportDateLabel(row.date))}</td>
            <td>${adminMoney(row.gross)}</td>
            <td>${adminMoney(row.refunds)}</td>
            <td>${adminMoney(row.discounts)}</td>
            <td>${adminMoney(row.net)}</td>
            <td>${adminMoney(row.cost)}</td>
            <td>${adminMoney(row.profit)}</td>
            <td>${row.margin.toLocaleString('th-TH', { maximumFractionDigits: 2 })}%</td>
            <td>${adminMoney(row.tax)}</td>
        </tr>
    `).join('');
    const pageTotal = document.getElementById('sales-table-page-total');
    if (pageTotal) pageTotal.textContent = `จาก ${Math.max(1, Math.ceil(rows.length / 10)).toLocaleString('th-TH')}`;
}

function dashboardOrderGroupsBySource(orders = dashboardRevenueOrders()) {
    const groups = new Map([
        ['POS', { label: 'POS', amount: 0, quantity: 0 }],
        ['Online', { label: 'Online', amount: 0, quantity: 0 }]
    ]);
    orders.forEach(order => {
        const label = dashboardOrderSourceLabel(order);
        const current = groups.get(label) || { label, amount: 0, quantity: 0 };
        current.amount += orderReportTotal(order);
        current.quantity += 1;
        groups.set(label, current);
    });
    return Array.from(groups.values()).filter(row => row.amount || row.quantity);
}

function renderDashboardChart(chart, canvasId, labels = [], values = [], colors = []) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return chart;
    const hasData = values.some(value => safeNumber(value) > 0);
    const chartLabels = hasData ? labels : ['ไม่มีข้อมูล'];
    const chartValues = hasData ? values : [1];
    const chartColors = hasData ? colors : ['#dce5df'];
    const data = {
        labels: chartLabels,
        datasets: [{
            data: chartValues,
            backgroundColor: chartColors,
            borderColor: '#ffffff',
            borderWidth: 3,
            hoverOffset: 3
        }]
    };
    if (chart) {
        chart.data = data;
        chart.update();
        return chart;
    }
    return new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '64%',
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } },
                tooltip: {
                    callbacks: {
                        label: context => {
                            if (!hasData) return 'ไม่มีข้อมูล';
                            const label = context.label || '';
                            const value = safeNumber(context.parsed);
                            return `${label}: ${adminMoney(value)}`;
                        }
                    }
                }
            }
        }
    });
}

function renderDashboardDataList(containerId, rows = [], options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const limit = options.limit || 5;
    const valueFormat = options.valueFormat || (value => adminMoney(value));
    const emptyText = options.emptyText || 'ยังไม่มีข้อมูลในช่วงนี้';
    const shown = rows.slice(0, limit);
    const maxValue = Math.max(1, ...shown.map(row => safeNumber(row.amount ?? row.value ?? row.quantity)));
    if (!shown.length) {
        container.innerHTML = `<div class="dashboard-empty">${escapeHTML(emptyText)}</div>`;
        return;
    }
    container.innerHTML = shown.map(row => {
        const value = safeNumber(row.amount ?? row.value ?? row.quantity);
        const width = Math.max(4, Math.min(100, (value / maxValue) * 100));
        const meta = row.meta ? `<small>${escapeHTML(row.meta)}</small>` : '';
        return `
            <div class="dashboard-data-row">
                <div>
                    <span>${escapeHTML(row.label || '-')}</span>
                    ${meta}
                    <div class="dashboard-bar"><span style="width:${width.toFixed(2)}%;"></span></div>
                </div>
                <strong>${escapeHTML(valueFormat(value, row))}</strong>
            </div>
        `;
    }).join('');
}

function dashboardStatusCount(rows = [], status) {
    return rows.filter(row => String(row.status || '').toLowerCase() === status).length;
}

function dashboardMemberDateKey(member = {}) {
    const raw = member.createdAt || member.created_at || member.registeredAt || member.joinedAt || member.updatedAt;
    const time = timestampToMillis(raw);
    return time ? localDateKey(new Date(time)) : '';
}

function dashboardMemberInRange(member = {}) {
    const key = dashboardMemberDateKey(member);
    const range = dashboardDateRange();
    return !!key && key >= range.startKey && key <= range.endKey;
}

function dashboardActivityMemberIds(orders = dashboardRevenueOrders(), bookings = dashboardFilteredBookings()) {
    const ids = new Set();
    orders.forEach(order => {
        const uid = order.customerUid || order.uid || order.userId || order.memberUid;
        if (uid) ids.add(uid);
    });
    bookings.forEach(booking => {
        const uid = booking.member_id || booking.uid || booking.customerUid || booking.userId || booking.memberUid;
        if (uid) ids.add(uid);
    });
    return ids;
}

function dashboardScopedMembers(activeIds = dashboardActivityMemberIds()) {
    const entries = Object.entries(membersData || {});
    if (!activeIds.size) return [];
    return entries.filter(([uid]) => activeIds.has(uid)).map(([uid, member]) => ({ uid, member }));
}

function dashboardProductAlertRows() {
    const rows = [];
    Object.entries(productsData || {}).forEach(([id, product]) => {
        const baseLabel = product.name || product.nameEn || id;
        const lowStock = safeNumber(product.lowStock);
        const stock = safeNumber(product.stock);
        if (product.trackStock && stock <= Math.max(0, lowStock)) {
            rows.push({
                label: baseLabel,
                meta: `${categoryNameForProduct(product)} · stock ${stock.toLocaleString('th-TH')} / low ${lowStock.toLocaleString('th-TH')}`,
                quantity: stock,
                out: stock <= 0,
                low: stock > 0
            });
        }
        productVariantsForDisplay(product).forEach(variant => {
            const variantStock = safeNumber(variant.stock);
            const variantLow = safeNumber(variant.lowStock);
            if (variantLow > 0 && variantStock <= variantLow) {
                rows.push({
                    label: `${baseLabel} / ${variant.name || variant.id}`,
                    meta: `variant · stock ${variantStock.toLocaleString('th-TH')} / low ${variantLow.toLocaleString('th-TH')}`,
                    quantity: variantStock,
                    out: variantStock <= 0,
                    low: variantStock > 0
                });
            }
        });
    });
    return rows.sort((a, b) => safeNumber(a.quantity) - safeNumber(b.quantity));
}

function dashboardLowMarginRows() {
    return Object.entries(productsData || {})
        .map(([id, product]) => {
            const price = safeNumber(product.price);
            const cost = safeNumber(product.cost);
            if (!price || !cost) return null;
            const margin = ((price - cost) / price) * 100;
            if (margin >= 35) return null;
            return {
                label: product.name || product.nameEn || id,
                meta: `${categoryNameForProduct(product)} · margin ${margin.toLocaleString('th-TH', { maximumFractionDigits: 1 })}%`,
                value: margin
            };
        })
        .filter(Boolean)
        .sort((a, b) => safeNumber(a.value) - safeNumber(b.value));
}

function renderDashboardExecutive(totals, revenueOrders, operationalOrders) {
    const openBills = operationalOrders.filter(isOpenBillOrder);
    setDashboardText('dashboard-kpi-net-sales', adminMoney(totals.net));
    setDashboardText('dashboard-kpi-receipts', totals.count.toLocaleString('th-TH'));
    setDashboardText('dashboard-kpi-profit', adminMoney(totals.profit));
    setDashboardText('dashboard-kpi-discount', adminMoney(totals.discounts));
    setDashboardText('dashboard-kpi-refund-void', adminMoney(totals.refunds));
    setDashboardText('dashboard-kpi-open-bills', openBills.length.toLocaleString('th-TH'));
    setDashboardText('dashboard-kpi-net-sales-note', `${revenueOrders.filter(order => dashboardOrderSourceLabel(order) === 'POS').length.toLocaleString('th-TH')} POS · ${revenueOrders.filter(order => dashboardOrderSourceLabel(order) === 'Online').length.toLocaleString('th-TH')} Online`);
    setDashboardText('dashboard-kpi-receipts-note', `${dashboardSourceLabel()} · ${dashboardTimeLabel()}`);
    setDashboardText('dashboard-kpi-profit-note', `Margin ${totals.margin.toLocaleString('th-TH', { maximumFractionDigits: 2 })}%`);
    setDashboardText('dashboard-kpi-discount-note', `${totals.count.toLocaleString('th-TH')} บิลในช่วงนี้`);
    setDashboardText('dashboard-kpi-refund-void-note', `${dashboardRefundOrders().length.toLocaleString('th-TH')} รายการ`);
    setDashboardText('dashboard-kpi-open-bills-note', `ยอดค้าง ${adminMoney(openBills.reduce((sum, order) => sum + orderReportTotal(order), 0))}`);
}

function renderDashboardOperations(operationalOrders, bookings) {
    const onlinePending = operationalOrders.filter(order => {
        const source = dashboardOrderSourceLabel(order);
        const status = String(order.status || '').toLowerCase();
        const paymentStatus = String(order.paymentStatus || '').toLowerCase();
        return source === 'Online' && (status === 'pending' || status === 'processing' || paymentStatus === 'pending');
    });
    const openBills = operationalOrders.filter(isOpenBillOrder);
    const bookingPending = bookings.filter(booking => String(booking.status || 'pending').toLowerCase() === 'pending');
    const loyaltyIssues = operationalOrders.filter(order => {
        const status = posLoyaltySyncStatus(order);
        return status === 'pending' || status === 'failed' || status === 'syncing';
    });
    const stockAlerts = dashboardProductAlertRows();
    setDashboardText('dashboard-queue-online-pending', onlinePending.length.toLocaleString('th-TH'));
    setDashboardText('dashboard-queue-pos-open', openBills.length.toLocaleString('th-TH'));
    setDashboardText('dashboard-queue-booking-pending', bookingPending.length.toLocaleString('th-TH'));
    setDashboardText('dashboard-queue-loyalty-issues', loyaltyIssues.length.toLocaleString('th-TH'));
    setDashboardText('dashboard-queue-stock-alerts', stockAlerts.length.toLocaleString('th-TH'));
}

function renderDashboardSalesAnalytics(revenueOrders) {
    const sourceRows = dashboardOrderGroupsBySource(revenueOrders);
    dashboardSourceChart = renderDashboardChart(
        dashboardSourceChart,
        'dashboard-source-chart',
        sourceRows.map(row => row.label),
        sourceRows.map(row => row.amount),
        ['#2368a2', '#2f7d53']
    );

    const paymentRows = buildDashboardSalesReportRows('payment', revenueOrders).slice(0, 6);
    dashboardPaymentChart = renderDashboardChart(
        dashboardPaymentChart,
        'dashboard-payment-chart',
        paymentRows.map(row => row.label),
        paymentRows.map(row => row.amount),
        ['#17452f', '#2368a2', '#b7791f', '#8f5b2f', '#bf4342', '#6b7c86']
    );

    renderDashboardDataList('dashboard-top-products', buildDashboardSalesReportRows('product', revenueOrders), {
        emptyText: 'ยังไม่มีสินค้าขายในช่วงนี้'
    });
    renderDashboardDataList('dashboard-top-categories', buildDashboardSalesReportRows('category', revenueOrders), {
        emptyText: 'ยังไม่มีหมวดหมู่ขายในช่วงนี้'
    });
    renderDashboardDataList('dashboard-top-cashiers', buildDashboardSalesReportRows('staff', revenueOrders), {
        emptyText: 'ยังไม่มีข้อมูลแคชเชียร์ในช่วงนี้'
    });
}

function renderDashboardBookings(bookings) {
    const todayKey = localDateKey(new Date());
    const todayCount = bookings.filter(booking => dashboardBookingDateKey(booking) === todayKey).length;
    const pending = dashboardStatusCount(bookings, 'pending');
    const confirmed = dashboardStatusCount(bookings, 'confirmed');
    const archery = bookings.filter(isArcheryBooking).length;
    const nonArchery = bookings.filter(booking => !isArcheryBooking(booking));
    const room = nonArchery.filter(booking => String(booking.bookingType || '').toLowerCase() === 'room').length;
    const table = nonArchery.length - room;
    setDashboardText('dashboard-booking-today', todayCount.toLocaleString('th-TH'));
    setDashboardText('dashboard-booking-pending', pending.toLocaleString('th-TH'));
    setDashboardText('dashboard-booking-confirmed', confirmed.toLocaleString('th-TH'));
    setDashboardText('dashboard-booking-split', `${room.toLocaleString('th-TH')} / ${table.toLocaleString('th-TH')} / ${archery.toLocaleString('th-TH')}`);
    const statBookings = document.getElementById('stat-bookings');
    if (statBookings) statBookings.textContent = bookings.length.toLocaleString('th-TH');
}

function renderDashboardMembersAndLoyalty(revenueOrders, bookings) {
    const activeIds = dashboardActivityMemberIds(revenueOrders, bookings);
    const scopedMembers = dashboardScopedMembers(activeIds);
    const newMembers = Object.values(membersData || {}).filter(dashboardMemberInRange);
    const config = normalizeLoyaltyConfig(loyaltyConfig);
    const pointSource = scopedMembers.length
        ? scopedMembers.map(row => row.member)
        : (activeIds.size ? [] : Object.values(membersData || {}).filter(dashboardMemberInRange));
    const totalPoints = pointSource.reduce((sum, member) => sum + Math.max(0, Math.floor(safeNumber(member.points ?? member.pointsBalance ?? member._memberSummary?.pointsBalance))), 0);
    const loyaltyIssues = dashboardOperationalOrders().filter(order => {
        const status = posLoyaltySyncStatus(order);
        return status === 'pending' || status === 'failed' || status === 'syncing';
    }).length;
    setDashboardText('dashboard-member-new', newMembers.length.toLocaleString('th-TH'));
    setDashboardText('dashboard-member-active', activeIds.size.toLocaleString('th-TH'));
    setDashboardText('dashboard-loyalty-points', totalPoints.toLocaleString('th-TH'));
    setDashboardText('dashboard-loyalty-liability', adminMoney(totalPoints * config.pointValue));
    setDashboardText('dashboard-queue-loyalty-issues', loyaltyIssues.toLocaleString('th-TH'));
}

function renderDashboardInventory() {
    const alerts = dashboardProductAlertRows();
    const outRows = alerts.filter(row => row.out);
    const lowRows = alerts.filter(row => row.low);
    const marginRows = dashboardLowMarginRows();
    renderDashboardDataList('dashboard-stock-alert-list', lowRows, {
        emptyText: 'ไม่มีสินค้าใกล้หมด',
        valueFormat: value => value.toLocaleString('th-TH')
    });
    renderDashboardDataList('dashboard-out-stock-list', outRows, {
        emptyText: 'ไม่มีสินค้าหมด',
        valueFormat: value => value.toLocaleString('th-TH')
    });
    renderDashboardDataList('dashboard-margin-variant-list', marginRows, {
        emptyText: 'ยังไม่พบ margin ต่ำกว่า 35%',
        valueFormat: value => `${value.toLocaleString('th-TH', { maximumFractionDigits: 1 })}%`
    });
}

function renderDashboardSystemHealth(operationalOrders) {
    const dailyViews = safeNumber(dashboardStatsData.dailyViews);
    const totalViews = safeNumber(dashboardStatsData.totalViews);
    setDashboardText('dashboard-visitor-stat', `${dailyViews.toLocaleString('th-TH')} วันนี้`);
    setDashboardText('dashboard-visitor-note', `รวม ${totalViews.toLocaleString('th-TH')} views`);
    setDashboardHealthState('dashboard-health-visitors', dailyViews > 0 ? 'ok' : 'warn');

    const prompt = normalizePromptPaySettings(dashboardPromptPaySettings || promptPaySettingsState || defaultPromptPaySettings());
    const promptAccount = activePromptPayAccount(prompt);
    setDashboardText('dashboard-promptpay-status', prompt.enabled ? 'พร้อมใช้งาน' : 'ปิดใช้งาน');
    setDashboardText('dashboard-promptpay-note', prompt.enabled ? `${promptAccount.label} · ${promptAccount.promptPayId}` : 'ปิดจาก site_settings/promptpay');
    setDashboardHealthState('dashboard-health-promptpay', prompt.enabled ? 'ok' : 'warn');

    const discountRows = Object.values(discountsData || {});
    const activeDiscounts = discountRows.filter(discount => discount.active !== false).length;
    setDashboardText('dashboard-discount-status', `${activeDiscounts.toLocaleString('th-TH')} active`);
    setDashboardText('dashboard-discount-note', `${discountRows.length.toLocaleString('th-TH')} rules`);
    setDashboardHealthState('dashboard-health-discounts', activeDiscounts ? 'ok' : 'warn');

    const posOrders = operationalOrders.filter(order => String(order.source || '').toLowerCase() === 'pos');
    const openBills = posOrders.filter(isOpenBillOrder);
    setDashboardText('dashboard-apk-status', posOrders.length ? 'มีข้อมูล POS' : 'รอข้อมูล POS');
    setDashboardText('dashboard-apk-note', `${posOrders.length.toLocaleString('th-TH')} orders · ${openBills.length.toLocaleString('th-TH')} open bills`);
    setDashboardHealthState('dashboard-health-apk', posOrders.length ? 'ok' : 'warn');
}

function renderManagerDashboard() {
    bindDashboardFilters();
    const revenueOrders = dashboardRevenueOrders();
    const operationalOrders = dashboardOperationalOrders();
    const bookings = dashboardFilteredBookings();
    const totals = reportSummaryTotals(revenueOrders);
    renderDashboardExecutive(totals, revenueOrders, operationalOrders);
    renderDashboardOperations(operationalOrders, bookings);
    renderDashboardSalesAnalytics(revenueOrders);
    renderDashboardBookings(bookings);
    renderDashboardMembersAndLoyalty(revenueOrders, bookings);
    renderDashboardInventory();
    renderDashboardSystemHealth(operationalOrders);
}

function renderDashboardSalesReport() {
    updateSalesReportToolbar();
    renderManagerDashboard();
    renderSalesReportKpis();
    renderSalesSummaryChart();
    renderSalesSummaryTable();
}

function bindSalesReportNav() {
    if (salesReportNavBound) return;
    const nav = document.querySelector('.sales-report-nav');
    if (!nav) return;
    nav.addEventListener('click', event => {
        const button = event.target.closest('[data-sales-report]');
        if (!button) return;
        window.setSalesReportType(button.dataset.salesReport || 'summary', button);
    });
    salesReportNavBound = true;
}

window.setSalesReportType = (type = 'summary', button = null) => {
    activeSalesReport = SALES_REPORT_LABELS[type] ? type : 'summary';
    const nav = document.querySelector('.sales-report-nav');
    if (nav) {
        nav.querySelectorAll('[data-sales-report]').forEach(item => {
            item.classList.toggle('active', item === button || item.dataset.salesReport === activeSalesReport);
        });
    }
    renderDashboardSalesReport();
};

window.shiftSalesReportMonth = (delta = 0) => {
    salesReportMonthOffset += safeNumber(delta);
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + salesReportMonthOffset, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const filters = ensureDashboardFilters();
    filters.datePreset = 'custom';
    filters.startKey = localDateKey(first);
    filters.endKey = localDateKey(last);
    renderDashboardAfterFilterChange();
};

window.setSalesReportTimeFilter = (value = 'all') => {
    setDashboardTimePreset(value);
};

window.setSalesReportEmployeeFilter = (value = 'all') => {
    ensureDashboardFilters().employee = value || 'all';
    renderDashboardAfterFilterChange();
};

function salesReportSheetName(name) {
    return String(name || 'sales').replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'sales';
}

function salesReportExcelSheet(rows) {
    const worksheet = worksheetFromData(rows.length ? rows : [{ note: 'ยังไม่มีข้อมูลยอดขายในช่วงที่เลือก' }]);
    const keys = Object.keys(rows[0] || { note: '' });
    worksheet['!cols'] = keys.map((key) => {
        const maxLength = rows.reduce((max, row) => Math.max(max, String(row[key] ?? '').length), String(key).length);
        return { wch: Math.min(Math.max(maxLength + 3, 12), 42) };
    });
    return worksheet;
}

function salesReportOrderDateText(order = {}) {
    const value = isPaidOrderForReportDate(order)
        ? (order.paidAt || order.closedAt || order.businessDate || order.timestamp || order.createdAt || order.date)
        : (order.openedAt || order.businessDate || order.createdAt || order.timestamp || order.date);
    if (!value) return '';
    if (value?.toDate) return value.toDate().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

function salesReportReceiptNo(order = {}) {
    return order.receiptNo || order.orderNumber || order.id || order.firestoreId || '';
}

function currentSalesReportExportRows(type = activeSalesReport) {
    if (type === 'summary') {
        return buildDailySalesRows().map(row => ({
            'วันที่': salesReportDateLabel(row.date),
            'ยอดขาย': row.gross,
            'คืนเงิน': row.refunds,
            'ส่วนลด': row.discounts,
            'ยอดขายสุทธิ': row.net,
            'ต้นทุนของสินค้า': row.cost,
            'กำไรรวม': row.profit,
            'ผลต่าง (%)': Number(row.margin.toFixed(2)),
            'ภาษี': row.tax
        }));
    }
    return buildDashboardSalesReportRows(type).map(row => ({
        'รายงาน': SALES_REPORT_LABELS[type] || 'รายงานยอดขาย',
        'รายการ': row.label || '',
        'จำนวน': safeNumber(row.quantity),
        'ยอดขาย': safeNumber(row.amount),
        'วันที่ / ช่วงเวลา': row.meta || dashboardReportDateLabel()
    }));
}

function salesReportReceiptRows() {
    return dashboardRevenueOrders()
        .slice()
        .sort((a, b) => orderReportDateValue(b) - orderReportDateValue(a))
        .map(order => {
            const total = orderReportTotal(order);
            const cost = orderReportCost(order);
            return {
                'เลขที่ใบเสร็จ': salesReportReceiptNo(order),
                'วันที่': salesReportOrderDateText(order),
                'ลูกค้า': order.customerName || 'Walk-in Customer',
                'เบอร์โทร': order.phone || '',
                'พนักงาน': salesReportEmployeeName(order),
                'วิธีชำระเงิน': order.paymentLabel || salesReportPaymentLabel(order.paymentMethod),
                'สถานะ': order.status || '',
                'ยอดก่อนส่วนลด': orderReportGross(order),
                'ส่วนลด': orderReportDiscount(order),
                'ภาษี': orderReportTax(order),
                'ยอดสุทธิ': total,
                'ต้นทุน': cost,
                'กำไร': total - cost,
                'หมายเหตุ': order.note || '',
                'Firestore ID': order.firestoreId || order.id || ''
            };
        });
}

function salesReportItemRows() {
    const rows = [];
    dashboardRevenueOrders()
        .slice()
        .sort((a, b) => orderReportDateValue(b) - orderReportDateValue(a))
        .forEach(order => {
            orderReportItems(order).forEach(item => {
                const quantity = Math.max(0, safeNumber(item.quantity, 1));
                const lineTotal = itemReportAmount(item);
                const cost = itemReportCost(item);
                rows.push({
                    'เลขที่ใบเสร็จ': salesReportReceiptNo(order),
                    'วันที่': salesReportOrderDateText(order),
                    'สินค้า': item.name || item.productName || 'ไม่ระบุสินค้า',
                    'ตัวเลือก': item.variantName || item.optionName || '',
                    'SKU': item.sku || item.variantSku || '',
                    'หมวดหมู่': item.categoryName || categoriesData[item.category || item.categoryId || '']?.name || item.category || item.categoryId || '',
                    'จำนวน': quantity,
                    'ราคาต่อหน่วย': safeNumber(item.unitPrice ?? item.price ?? item.basePrice),
                    'ส่วนลดรายการ': safeNumber(item.lineDiscount ?? item.discount),
                    'ยอดรวม': lineTotal,
                    'ต้นทุนรวม': cost,
                    'กำไรรวม': lineTotal - cost,
                    'ลูกค้า': order.customerName || 'Walk-in Customer',
                    'พนักงาน': salesReportEmployeeName(order)
                });
            });
        });
    return rows;
}

function exportSalesWorkbook(type = activeSalesReport) {
    const XLSX = window.XLSX;
    if (!XLSX) throw new Error('ไม่พบไลบรารี Excel กรุณารีเฟรชหน้าแล้วลองอีกครั้ง');
    if (!canAdmin('orders')) throw new Error('บัญชีนี้ไม่มีสิทธิ์ดาวน์โหลดข้อมูลยอดขาย');

    const workbook = XLSX.utils.book_new();
    const activeLabel = SALES_REPORT_LABELS[type] || 'รายงานยอดขาย';
    const totals = reportSummaryTotals();
    const overviewRows = [{
        'รายงาน': activeLabel,
        'ช่วงวันที่': salesReportRangeLabel(),
        'ช่วงเวลา': salesReportTimeFilter === 'all' ? 'ตลอดทั้งวัน' : salesReportTimeFilter,
        'พนักงาน': salesReportEmployeeFilter === 'all' ? 'พนักงานทั้งหมด' : salesReportEmployeeFilter,
        'จำนวนใบเสร็จ': totals.count,
        'ยอดขาย': totals.gross,
        'คืนเงิน': totals.refunds,
        'ส่วนลด': totals.discounts,
        'ยอดขายสุทธิ': totals.net,
        'ต้นทุนของสินค้า': totals.cost,
        'กำไรรวม': totals.profit,
        'ผลต่าง (%)': Number(totals.margin.toFixed(2)),
        'ภาษี': totals.tax,
        'ส่งออกเมื่อ': new Date().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })
    }];

    XLSX.utils.book_append_sheet(workbook, salesReportExcelSheet(overviewRows), 'overview');
    XLSX.utils.book_append_sheet(workbook, salesReportExcelSheet(currentSalesReportExportRows(type)), salesReportSheetName(activeLabel));
    XLSX.utils.book_append_sheet(workbook, salesReportExcelSheet(buildDashboardSalesReportRows('category').map(row => ({
        'หมวดหมู่': row.label,
        'จำนวน': safeNumber(row.quantity),
        'ยอดขาย': safeNumber(row.amount),
        'ช่วงวันที่': dashboardReportDateLabel()
    }))), 'categories');
    XLSX.utils.book_append_sheet(workbook, salesReportExcelSheet(buildDashboardSalesReportRows('product').map(row => ({
        'สินค้า': row.label,
        'จำนวน': safeNumber(row.quantity),
        'ยอดขาย': safeNumber(row.amount),
        'ช่วงวันที่': dashboardReportDateLabel()
    }))), 'products');
    XLSX.utils.book_append_sheet(workbook, salesReportExcelSheet(salesReportReceiptRows()), 'receipts');
    XLSX.utils.book_append_sheet(workbook, salesReportExcelSheet(salesReportItemRows()), 'items');

    XLSX.writeFile(workbook, `eden-sales-${type}-${salesReportRange().startKey}-to-${salesReportRange().endKey}.xlsx`);
}

window.exportSalesReportXLSX = () => {
    const button = document.getElementById('sales-export-xlsx-btn');
    const originalText = button?.textContent || '';
    try {
        if (button) {
            button.disabled = true;
            button.textContent = 'กำลังสร้างไฟล์...';
        }
        exportSalesWorkbook(activeSalesReport);
    } catch (error) {
        console.error('Export sales XLSX failed:', error);
        alert(safeAdminError("ดาวน์โหลดข้อมูลยอดขายไม่สำเร็จ"));
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText || '⬇ ดาวน์โหลด Excel';
        }
    }
};

window.exportSalesSummaryCSV = window.exportSalesReportXLSX;

// Format Date Helper
function formatDate(timestamp) {
    if (!timestamp) return '-';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

function posLoyaltySyncStatus(order = {}) {
    return String(order.loyaltySyncStatus || '').trim().toLowerCase();
}

function posLoyaltyRetryActionHTML(order = {}, orderId = '') {
    if (String(order.source || '').toLowerCase() !== 'pos') return '';
    const status = posLoyaltySyncStatus(order) || 'not_synced';
    const error = String(order.loyaltyError || '').trim();
    const retryable = status === 'pending' || status === 'failed';
    const receiptNo = order.receiptNo || order.orderNumber || order.id || orderId;
    const color = status === 'synced'
        ? '#2e7d32'
        : status === 'failed'
            ? '#c62828'
            : status === 'skipped'
                ? '#6d6d6d'
                : '#8a5a00';
    const retryButton = retryable
        ? `<button class="btn-action btn-view" type="button" style="margin-left:6px;" onclick="retryPosLoyaltySale('${escapeJSString(orderId)}', '${escapeJSString(receiptNo)}', this)">Retry loyalty</button>`
        : '';
    const errorText = error ? `<br><small style="color:#c62828;">${escapeHTML(error)}</small>` : '';
    return `
        <div style="margin-top:6px;">
            <small style="color:${color};">Loyalty: ${escapeHTML(status)}</small>
            ${retryButton}
            <small id="pos-loyalty-retry-${escapeHTML(orderId)}" style="display:block; margin-top:4px;"></small>
            ${errorText}
        </div>
    `;
}

function setPosLoyaltyRetryMessage(orderId, message, color = '#2e7d32') {
    const statusEl = document.getElementById(`pos-loyalty-retry-${orderId}`);
    if (statusEl) {
        statusEl.textContent = message;
        statusEl.style.color = color;
    }
}

window.retryPosLoyaltySale = async (orderId, receiptNo = '', button = null) => {
    if (!canAdmin('pos')) {
        alert('POS admin permission is required');
        return;
    }
    const originalText = button?.textContent || 'Retry loyalty';
    try {
        if (button) {
            button.disabled = true;
            button.textContent = 'Retrying...';
        }
        setPosLoyaltyRetryMessage(orderId, 'Retrying loyalty sync...', '#607d8b');
        const result = await callAdminFunction('adminRetryPosLoyaltySale', { orderId });
        const status = result.status || 'synced';
        setPosLoyaltyRetryMessage(orderId, `Loyalty ${status}`, '#2e7d32');
        if (button) button.textContent = status === 'skipped' ? 'Skipped' : 'Synced';
        if (typeof setupRealtimeOrders === 'function') setupRealtimeOrders();
    } catch (error) {
        console.error('POS loyalty retry failed:', error);
        setPosLoyaltyRetryMessage(orderId, error.message || 'Retry failed', '#c62828');
        alert(safeAdminError(`POS loyalty retry failed${receiptNo ? ` (${receiptNo})` : ''}`));
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
};

// Real-time Orders Listener
function setupRealtimeOrders() {
    if (ordersUnsubscribe) {
        ordersUnsubscribe();
        ordersUnsubscribe = null;
    }
    const q = query(collection(db, "orders"), orderBy("timestamp", "desc"));
    ordersUnsubscribe = onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('orders-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        let todayOrders = 0;
        let todayRevenue = 0;
        const reportOrders = [];
        const todayStr = new Date().toLocaleDateString('th-TH');

        if (snapshot.empty) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">ไม่มีข้อมูลออเดอร์</td></tr>';
            dashboardOrdersData = [];
            renderDashboardSalesReport();
            document.getElementById('stat-orders').innerText = todayOrders;
            document.getElementById('stat-revenue').innerText = '฿' + todayRevenue.toLocaleString();
            return;
        }

        snapshot.forEach((docSnap) => {
            const order = docSnap.data();
            const id = docSnap.id;
            reportOrders.push({ ...order, firestoreId: id });
            const status = order.status || 'pending';
            const paymentStatus = order.paymentStatus || (order.source === 'pos' ? 'paid' : 'pending');
            const paymentLabel = order.paymentLabel || order.paymentMethod || '-';
            const isTestOrder = !!order.isTestOrder;
            const displayId = order.receiptNo || order.orderNumber || id.substring(0,8).toUpperCase();
            const sourceLabel = order.source === 'pos' ? (isTestOrder ? 'POS TEST' : 'POS') : 'Online';
            const canVoidPos = order.source === 'pos' && status !== 'cancelled';
            const orderDateStr = order.timestamp ? (order.timestamp.toDate ? order.timestamp.toDate().toLocaleDateString('th-TH') : new Date(order.timestamp).toLocaleDateString('th-TH')) : '';
            const isRevenueOrder = paymentStatus === 'paid' || status === 'completed';
            
            if (!isTestOrder && isRevenueOrder && status !== 'cancelled' && orderDateStr === todayStr) {
                todayOrders++;
                todayRevenue += (order.totalAmount || 0);
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-family: monospace;">${escapeHTML(displayId)}</td>
                <td>${escapeHTML(order.customerName || 'Customer')}<br><small style="color:#888;">${escapeHTML([order.phone || '', sourceLabel].filter(Boolean).join(' | '))}</small></td>
                <td style="font-weight: 500;">฿${safeNumber(order.totalAmount || order.total).toLocaleString()}</td>
                <td>${getPaymentStatusBadgeHTML(paymentStatus)}<br><small style="color:#888;">${escapeHTML(paymentLabel)}</small></td>
                <td>${formatDate(order.paidAt || order.closedAt || order.timestamp)}</td>
                <td>${getStatusBadgeHTML(status, 'order')}</td>
                <td>
                    <select onchange="updateOrderStatus('${escapeJSString(id)}', this.value)" style="padding: 5px; border-radius: 5px; border: 1px solid #ddd;">
                        <option value="pending" ${status === 'pending' ? 'selected' : ''}>รอดำเนินการ</option>
                        <option value="processing" ${status === 'processing' ? 'selected' : ''}>กำลังทำ</option>
                        <option value="completed" ${status === 'completed' ? 'selected' : ''}>เสร็จสิ้น</option>
                        <option value="cancelled" ${status === 'cancelled' ? 'selected' : ''}>ยกเลิก</option>
                    </select>
                    ${canVoidPos ? `<button class="btn-action btn-delete" type="button" style="margin-left:6px;" onclick="voidPosOrder('${escapeJSString(id)}')">Void</button>` : ''}
                    ${posLoyaltyRetryActionHTML(order, id)}
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Update Dashboard Stats
        dashboardOrdersData = reportOrders;
        renderDashboardSalesReport();
        document.getElementById('stat-orders').innerText = todayOrders;
        document.getElementById('stat-revenue').innerText = '฿' + todayRevenue.toLocaleString();
    }, (error) => {
        console.error("Error listening to orders:", error);
        const tbody = document.getElementById('orders-table-body');
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:red;">ไม่มีสิทธิ์เข้าถึงข้อมูล หรือเกิดข้อผิดพลาด</td></tr>';
    });
}

function adminTodayISO() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 10);
}

function adminMinutesFromTime(value = '') {
    const [hours, minutes] = String(value || '00:00').split(':').map(Number);
    return (Number(hours) || 0) * 60 + (Number(minutes) || 0);
}

function adminTimeFromMinutes(value) {
    const minutes = Math.max(0, Math.floor(Number(value) || 0));
    return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

function adminDisplayArcheryTime(value) {
    return String(value || '').replace(':', '.');
}

function adminFillArcheryTimeOptions() {
    const startSelect = document.getElementById('archery-admin-start');
    if (!startSelect) return;
    const selected = startSelect.value;
    const duration = Number(document.getElementById('archery-admin-package')?.value || 60) || 60;
    const lastStart = (20 * 60) - duration;
    startSelect.innerHTML = '';
    for (let minute = 10 * 60; minute <= lastStart; minute += 60) {
        const opt = document.createElement('option');
        opt.value = adminTimeFromMinutes(minute);
        opt.textContent = adminDisplayArcheryTime(adminTimeFromMinutes(minute));
        startSelect.appendChild(opt);
    }
    if (selected && Array.from(startSelect.options).some(opt => opt.value === selected)) startSelect.value = selected;
}

const ARCHERY_BRANCH_FALLBACK = 'BKK_MAIN';
const ARCHERY_PAID_STATUSES = new Set(['PAID_ONLINE', 'PAID_COUNTER', 'PAID', 'REFUNDED']);
const ARCHERY_PENDING_PAYMENT_STATUSES = new Set(['PENDING', 'UNPAID', 'PAID_PENDING_REVIEW', 'REVIEW_REQUIRED']);
const ARCHERY_CLOSED_STATUSES = new Set(['CANCELLED', 'COMPLETED', 'NO_SHOW', 'EXPIRED']);
const ARCHERY_AUDIT_ACTIONS = new Set([
    'createWalkInArcheryBooking',
    'adminCheckInBooking',
    'adminCompleteBooking',
    'adminMoveBookingLane',
    'adminExtendBooking',
    'requestCancelBooking',
    'approveCancelBooking',
    'adminMarkNoShow',
    'recordCounterPayment',
    'refundPayment',
    'overrideResourceLock'
]);
const ARCHERY_PAGE_SETTINGS_REF = () => doc(db, 'site_settings', 'archery');
const DEFAULT_ARCHERY_PAGE_SETTINGS = {
    heroImageUrl: '/Images/archery/archery-hero.png',
    packageLead: 'Open daily 10:00-20:00. Choose 60 / 120 / 180 minute packages.',
    packages: [
        {
            durationMinutes: 60,
            price: 350,
            title: '60 min',
            description: 'Short round for a quick trial or cafe visit.',
            conditions: ['Best for first-time guests', 'Includes lane time and basic equipment']
        },
        {
            durationMinutes: 120,
            price: 600,
            title: '120 min',
            description: 'Standard session for practice or visiting with friends.',
            conditions: ['Recommended for small groups', 'Includes lane time and basic equipment']
        },
        {
            durationMinutes: 180,
            price: 800,
            title: '180 min',
            description: 'Long session for group activities or workshops.',
            conditions: ['Suitable for longer practice', 'Includes lane time and basic equipment']
        }
    ]
};
const DEFAULT_ARCHERY_PRICING = {
    version: '2026-06-default',
    packages: [
        { durationMinutes: 60, price: 350, title: '60 min', active: true },
        { durationMinutes: 120, price: 600, title: '120 min', active: true },
        { durationMinutes: 180, price: 800, title: '180 min', active: true }
    ],
    abilityOptions: [
        { id: 'first_time_with_coach', label: 'First time, coach required', ratePerHour: 50, coachRequired: true, active: true },
        { id: 'experienced_with_coach', label: 'Experienced, coach requested', ratePerHour: 50, coachRequired: true, active: true },
        { id: 'experienced_no_coach', label: 'Experienced, no coach', ratePerHour: 0, coachRequired: false, active: true }
    ],
    equipmentOptions: [
        { id: 'rent_full_set', label: 'Rent full equipment set', ratePerHour: 100, active: true },
        { id: 'bring_own', label: 'Bring own equipment', ratePerHour: 0, active: true }
    ]
};

function normalizeArcheryPagePackage(item = {}, index = 0) {
    const duration = Number(item.durationMinutes || item.duration_minutes || item.duration || 0) || [60, 120, 180][index] || 60;
    const price = Number(item.price || item.amount || item.amountTotal || item.amount_total || 0) || 0;
    const conditions = Array.isArray(item.conditions)
        ? item.conditions.map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
        : String(item.conditionsText || item.conditions || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(0, 12);
    return {
        durationMinutes: duration,
        price,
        title: String(item.title || `${duration} min`).trim().slice(0, 80),
        description: String(item.description || '').trim().slice(0, 260),
        conditions
    };
}

function normalizeArcheryPageSettings(data = {}) {
    const fallback = DEFAULT_ARCHERY_PAGE_SETTINGS;
    const packages = Array.isArray(data.packages) && data.packages.length
        ? data.packages.map(normalizeArcheryPagePackage).filter(item => item.durationMinutes > 0)
        : fallback.packages.map(normalizeArcheryPagePackage);
    return {
        heroImageUrl: safeImageURL(data.heroImageUrl || data.hero_image_url || data.heroUrl || fallback.heroImageUrl, fallback.heroImageUrl),
        packageLead: String(data.packageLead || data.package_lead || fallback.packageLead).trim().slice(0, 300),
        packages
    };
}

function normalizeArcheryPricing(data = {}) {
    const source = data.pricing || data.bookingOptions || data.booking_options || {};
    const packagesSource = Array.isArray(source.packages) && source.packages.length ? source.packages : DEFAULT_ARCHERY_PRICING.packages;
    const abilitySource = Array.isArray(source.abilityOptions || source.ability_options) && (source.abilityOptions || source.ability_options).length
        ? (source.abilityOptions || source.ability_options)
        : DEFAULT_ARCHERY_PRICING.abilityOptions;
    const equipmentSource = Array.isArray(source.equipmentOptions || source.equipment_options) && (source.equipmentOptions || source.equipment_options).length
        ? (source.equipmentOptions || source.equipment_options)
        : DEFAULT_ARCHERY_PRICING.equipmentOptions;
    return {
        version: String(source.version || source.pricingVersion || source.pricing_version || DEFAULT_ARCHERY_PRICING.version).trim(),
        packages: packagesSource.map((item, index) => ({
            durationMinutes: Number(item.durationMinutes || item.duration_minutes || item.duration || DEFAULT_ARCHERY_PRICING.packages[index]?.durationMinutes || 60) || 60,
            price: Number(item.price || item.amount || item.amountTotal || item.amount_total || DEFAULT_ARCHERY_PRICING.packages[index]?.price || 0) || 0,
            title: String(item.title || DEFAULT_ARCHERY_PRICING.packages[index]?.title || '').trim().slice(0, 80),
            active: item.active !== false
        })),
        abilityOptions: abilitySource.map((item, index) => ({
            id: String(item.id || item.option_id || DEFAULT_ARCHERY_PRICING.abilityOptions[index]?.id || '').trim().slice(0, 80),
            label: String(item.label || DEFAULT_ARCHERY_PRICING.abilityOptions[index]?.label || '').trim().slice(0, 120),
            ratePerHour: Number(item.ratePerHour || item.rate_per_hour || item.rate || 0) || 0,
            coachRequired: item.coachRequired === true || item.coach_required === true,
            active: item.active !== false
        })).filter(item => item.id),
        equipmentOptions: equipmentSource.map((item, index) => ({
            id: String(item.id || item.option_id || DEFAULT_ARCHERY_PRICING.equipmentOptions[index]?.id || '').trim().slice(0, 80),
            label: String(item.label || DEFAULT_ARCHERY_PRICING.equipmentOptions[index]?.label || '').trim().slice(0, 120),
            ratePerHour: Number(item.ratePerHour || item.rate_per_hour || item.rate || 0) || 0,
            active: item.active !== false
        })).filter(item => item.id)
    };
}

function archeryPricingConfig() {
    return normalizeArcheryPricing(archeryPageSettingsData || {});
}

function activeArcheryItems(items = []) {
    return (Array.isArray(items) ? items : []).filter(item => item && item.active !== false);
}

function archeryMoney(value) {
    return Math.round(Number(value) || 0).toLocaleString('th-TH') + ' THB';
}

function archeryPageSettingsStatus(message, tone = '') {
    const status = document.getElementById('archery-page-settings-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = 'archery-status' + (tone ? ' ' + tone : '');
}

function renderArcheryPagePackageRows(packages = []) {
    const list = document.getElementById('archery-page-package-list');
    if (!list) return;
    const rows = packages.length ? packages : DEFAULT_ARCHERY_PAGE_SETTINGS.packages;
    list.innerHTML = rows.map((item, index) => {
        const normalized = normalizeArcheryPagePackage(item, index);
        return `
            <div class="archery-page-package-row" data-package-index="${index}">
                <label class="archery-field">
                    Minutes
                    <input type="number" min="15" step="15" data-page-package-field="durationMinutes" value="${escapeHTML(normalized.durationMinutes)}">
                </label>
                <label class="archery-field">
                    Price
                    <input type="number" min="0" step="1" data-page-package-field="price" value="${escapeHTML(normalized.price)}">
                </label>
                <label class="archery-field">
                    Title
                    <input type="text" maxlength="80" data-page-package-field="title" value="${escapeHTML(normalized.title)}">
                </label>
                <button class="remove-package" type="button" data-page-package-remove="${index}">Remove</button>
                <label class="archery-field full">
                    Description
                    <textarea maxlength="260" data-page-package-field="description">${escapeHTML(normalized.description)}</textarea>
                </label>
                <label class="archery-field full">
                    Conditions (one line each)
                    <textarea maxlength="800" data-page-package-field="conditions">${escapeHTML(normalized.conditions.join('\n'))}</textarea>
                </label>
            </div>
        `;
    }).join('');
}

function renderArcheryPricingPackageRows(packages = []) {
    const list = document.getElementById('archery-pricing-package-list');
    if (!list) return;
    const rows = packages.length ? packages : DEFAULT_ARCHERY_PRICING.packages;
    list.innerHTML = rows.map((item, index) => `
        <div class="archery-page-package-row" data-pricing-package-index="${index}">
            <label class="archery-field">
                Minutes
                <input type="number" min="15" step="15" data-pricing-package-field="durationMinutes" value="${escapeHTML(item.durationMinutes)}">
            </label>
            <label class="archery-field">
                Price
                <input type="number" min="0" step="1" data-pricing-package-field="price" value="${escapeHTML(item.price)}">
            </label>
            <label class="archery-field">
                Title
                <input type="text" maxlength="80" data-pricing-package-field="title" value="${escapeHTML(item.title || item.durationMinutes + ' min')}">
            </label>
            <label class="archery-field">
                Active
                <input type="checkbox" data-pricing-package-field="active" ${item.active !== false ? 'checked' : ''}>
            </label>
        </div>
    `).join('');
}

function renderArcheryPricingOptionRows(listId, kind, options = []) {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = options.map((item, index) => `
        <div class="archery-page-package-row" data-pricing-option-kind="${kind}" data-pricing-option-index="${index}">
            <label class="archery-field">
                ID
                <input type="text" maxlength="80" data-pricing-option-field="id" value="${escapeHTML(item.id)}">
            </label>
            <label class="archery-field">
                Label
                <input type="text" maxlength="120" data-pricing-option-field="label" value="${escapeHTML(item.label)}">
            </label>
            <label class="archery-field">
                Rate / hour
                <input type="number" min="0" step="1" data-pricing-option-field="ratePerHour" value="${escapeHTML(item.ratePerHour)}">
            </label>
            ${kind === 'ability' ? `
                <label class="archery-field">
                    Coach required
                    <input type="checkbox" data-pricing-option-field="coachRequired" ${item.coachRequired ? 'checked' : ''}>
                </label>
            ` : ''}
            <label class="archery-field">
                Active
                <input type="checkbox" data-pricing-option-field="active" ${item.active !== false ? 'checked' : ''}>
            </label>
        </div>
    `).join('');
}

function renderArcheryPricingEditor(pricing = DEFAULT_ARCHERY_PRICING) {
    const normalized = normalizeArcheryPricing({ pricing });
    renderArcheryPricingPackageRows(normalized.packages);
    renderArcheryPricingOptionRows('archery-pricing-ability-list', 'ability', normalized.abilityOptions);
    renderArcheryPricingOptionRows('archery-pricing-equipment-list', 'equipment', normalized.equipmentOptions);
}

function readArcheryPagePackageRows() {
    return Array.from(document.querySelectorAll('.archery-page-package-row')).map((row, index) => {
        const value = field => row.querySelector(`[data-page-package-field="${field}"]`)?.value || '';
        return normalizeArcheryPagePackage({
            durationMinutes: value('durationMinutes'),
            price: value('price'),
            title: value('title'),
            description: value('description'),
            conditionsText: value('conditions')
        }, index);
    }).filter(item => item.durationMinutes > 0);
}

function readArcheryPricingPackageRows() {
    return Array.from(document.querySelectorAll('[data-pricing-package-index]')).map((row, index) => ({
        durationMinutes: Number(row.querySelector('[data-pricing-package-field="durationMinutes"]')?.value || 0) || [60, 120, 180][index] || 60,
        price: Number(row.querySelector('[data-pricing-package-field="price"]')?.value || 0) || 0,
        title: String(row.querySelector('[data-pricing-package-field="title"]')?.value || '').trim().slice(0, 80),
        active: row.querySelector('[data-pricing-package-field="active"]')?.checked !== false
    })).filter(item => item.durationMinutes > 0);
}

function readArcheryPricingOptionRows(kind) {
    return Array.from(document.querySelectorAll(`[data-pricing-option-kind="${kind}"]`)).map(row => ({
        id: String(row.querySelector('[data-pricing-option-field="id"]')?.value || '').trim().slice(0, 80),
        label: String(row.querySelector('[data-pricing-option-field="label"]')?.value || '').trim().slice(0, 120),
        ratePerHour: Number(row.querySelector('[data-pricing-option-field="ratePerHour"]')?.value || 0) || 0,
        coachRequired: row.querySelector('[data-pricing-option-field="coachRequired"]')?.checked === true,
        active: row.querySelector('[data-pricing-option-field="active"]')?.checked !== false
    })).filter(item => item.id && item.label);
}

function readArcheryPricingEditor() {
    return normalizeArcheryPricing({
        pricing: {
            version: archeryPricingConfig().version || DEFAULT_ARCHERY_PRICING.version,
            packages: readArcheryPricingPackageRows(),
            abilityOptions: readArcheryPricingOptionRows('ability'),
            equipmentOptions: readArcheryPricingOptionRows('equipment')
        }
    });
}

function fillArcheryPageSettingsForm(settings = DEFAULT_ARCHERY_PAGE_SETTINGS) {
    const normalized = normalizeArcheryPageSettings(settings);
    const pricing = normalizeArcheryPricing(settings);
    const heroUrl = document.getElementById('archery-page-hero-url');
    const lead = document.getElementById('archery-page-package-lead');
    const preview = document.getElementById('archery-page-hero-preview');
    if (heroUrl) heroUrl.value = normalized.heroImageUrl;
    if (lead) lead.value = normalized.packageLead;
    if (preview) preview.src = normalized.heroImageUrl;
    renderArcheryPagePackageRows(normalized.packages);
    renderArcheryPricingEditor(pricing);
    renderAdminWalkinPricingOptions();
}

function bindArcheryPageSettingsControls() {
    if (archeryPageSettingsBound) return;
    archeryPageSettingsBound = true;
    document.getElementById('archery-page-hero-url')?.addEventListener('input', event => {
        const preview = document.getElementById('archery-page-hero-preview');
        if (preview) preview.src = safeImageURL(event.target.value, DEFAULT_ARCHERY_PAGE_SETTINGS.heroImageUrl);
    });
    document.getElementById('archery-page-add-package')?.addEventListener('click', () => {
        const packages = readArcheryPagePackageRows();
        packages.push(normalizeArcheryPagePackage({ durationMinutes: 60, price: 0, title: 'New package', conditions: [] }, packages.length));
        renderArcheryPagePackageRows(packages);
    });
    document.getElementById('archery-page-package-list')?.addEventListener('click', event => {
        const button = event.target.closest('[data-page-package-remove]');
        if (!button) return;
        const index = Number(button.dataset.pagePackageRemove);
        const packages = readArcheryPagePackageRows().filter((_, rowIndex) => rowIndex !== index);
        renderArcheryPagePackageRows(packages);
    });
    document.getElementById('archery-page-settings-form')?.addEventListener('submit', saveArcheryPageSettings);
}

async function loadArcheryPageSettings() {
    bindArcheryPageSettingsControls();
    if (!canAdmin('bookings')) return;
    archeryPageSettingsStatus('Loading page settings...');
    try {
        const snap = await getDoc(ARCHERY_PAGE_SETTINGS_REF());
        const raw = snap.exists() ? snap.data() : DEFAULT_ARCHERY_PAGE_SETTINGS;
        archeryPageSettingsData = {
            ...normalizeArcheryPageSettings(raw),
            pricing: normalizeArcheryPricing(raw)
        };
        fillArcheryPageSettingsForm(archeryPageSettingsData);
        archeryPageSettingsStatus(snap.exists() ? 'Page settings loaded.' : 'Using default page settings.', 'success');
    } catch (error) {
        console.error('Unable to load archery page settings:', error);
        archeryPageSettingsData = {
            ...normalizeArcheryPageSettings(DEFAULT_ARCHERY_PAGE_SETTINGS),
            pricing: normalizeArcheryPricing(DEFAULT_ARCHERY_PRICING)
        };
        fillArcheryPageSettingsForm(archeryPageSettingsData);
        archeryPageSettingsStatus(error.message || safeAdminError('Load archery page settings failed'), 'error');
    }
}

async function saveArcheryPageSettings(event) {
    event.preventDefault();
    if (!canAdmin('bookings')) {
        archeryPageSettingsStatus('This admin account cannot edit Archery page settings.', 'error');
        return;
    }
    const submit = event.submitter || event.target.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    archeryPageSettingsStatus('Saving Archery page settings...');
    try {
        const file = document.getElementById('archery-page-hero-file')?.files?.[0] || null;
        let heroImageUrl = document.getElementById('archery-page-hero-url')?.value.trim() || DEFAULT_ARCHERY_PAGE_SETTINGS.heroImageUrl;
        if (file) {
            archeryPageSettingsStatus('Uploading hero image...');
            const blob = await compressToWebP(file, 0.84);
            heroImageUrl = await uploadAdminImage(blob, 'archery', `archery-hero-${Date.now()}.webp`);
            const heroInput = document.getElementById('archery-page-hero-url');
            const preview = document.getElementById('archery-page-hero-preview');
            if (heroInput) heroInput.value = heroImageUrl;
            if (preview) preview.src = heroImageUrl;
        }
        const payload = normalizeArcheryPageSettings({
            heroImageUrl,
            packageLead: document.getElementById('archery-page-package-lead')?.value || '',
            packages: readArcheryPagePackageRows()
        });
        const pricing = readArcheryPricingEditor();
        await setDoc(ARCHERY_PAGE_SETTINGS_REF(), {
            ...payload,
            pricing,
            updatedAt: serverTimestamp(),
            updatedBy: auth.currentUser?.uid || '',
            updatedByEmail: auth.currentUser?.email || ''
        }, { merge: true });
        archeryPageSettingsData = { ...payload, pricing };
        renderAdminWalkinPricingOptions();
        const fileInput = document.getElementById('archery-page-hero-file');
        if (fileInput) fileInput.value = '';
        archeryPageSettingsStatus('Archery page settings saved.', 'success');
    } catch (error) {
        console.error('Unable to save archery page settings:', error);
        archeryPageSettingsStatus(error.message || safeAdminError('Save archery page settings failed'), 'error');
    } finally {
        if (submit) submit.disabled = false;
    }
}

function archeryBranchId() {
    const access = currentAdminAccess || {};
    if (access.primary_branch_id) return String(access.primary_branch_id);
    if (access.branch_id) return String(access.branch_id);
    if (Array.isArray(access.branch_ids) && access.branch_ids.length) return String(access.branch_ids[0]);
    return ARCHERY_BRANCH_FALLBACK;
}

function archeryAdminRole() {
    const access = currentAdminAccess || {};
    const raw = String(access.archery_role || access.archeryRole || access.role || '').trim();
    const upper = raw.toUpperCase();
    if (['OWNER', 'MANAGER', 'ARCHERY_STAFF', 'CASHIER', 'CUSTOMER'].includes(upper)) return upper;
    const legacy = raw.toLowerCase();
    if (legacy === 'owner') return 'OWNER';
    if (legacy === 'head_manager' || legacy === 'manager') return 'MANAGER';
    if (legacy === 'cashier') return 'CASHIER';
    if (legacy === 'staff') return 'ARCHERY_STAFF';
    return canAdmin('bookings') ? 'ARCHERY_STAFF' : 'CUSTOMER';
}

function archeryCan(action) {
    const role = archeryAdminRole();
    if (role === 'OWNER') return true;
    if (action === 'viewLaneBoard' || action === 'viewBookings' || action === 'viewPaymentStatus') {
        return ['MANAGER', 'ARCHERY_STAFF', 'CASHIER'].includes(role);
    }
    if (action === 'createWalkIn') return ['MANAGER', 'ARCHERY_STAFF'].includes(role);
    if (['checkIn', 'complete', 'moveLane', 'extendTime', 'markNoShow'].includes(action)) {
        return ['MANAGER', 'ARCHERY_STAFF'].includes(role);
    }
    if (action === 'requestCancel') return ['MANAGER', 'ARCHERY_STAFF', 'CASHIER'].includes(role);
    if (action === 'approveCancel' || action === 'refund' || action === 'viewAuditTrail') return role === 'MANAGER';
    if (action === 'recordCounterPayment') return ['MANAGER', 'CASHIER'].includes(role);
    return false;
}

function archerySetStatus(message, tone = '') {
    const status = document.getElementById('archery-admin-form-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = 'archery-status' + (tone ? ' ' + tone : '');
}

function archeryStaffSessionId() {
    const access = currentAdminAccess || {};
    const keys = ['eden_archery_staff_session_id', 'eden_staff_session_id'];
    for (const key of keys) {
        try {
            const value = sessionStorage.getItem(key) || localStorage.getItem(key);
            if (value) return value;
        } catch (error) {
            console.warn('Unable to read staff session storage:', error);
        }
    }
    return access.staff_session_id || access.staffSessionId || '';
}

function archeryIdempotencyKey(action, bookingId = '') {
    const random = Math.random().toString(36).slice(2, 10);
    return `admin-${action}-${bookingId || 'new'}-${Date.now()}-${random}`;
}

function archeryMutationPayload(action, bookingId = '', extra = {}) {
    const staffSessionId = archeryStaffSessionId();
    if (!staffSessionId) {
        const error = new Error('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่');
        error.code = 'STAFF_SESSION_REQUIRED';
        throw error;
    }
    return {
        branch_id: archeryBranchId(),
        staff_session_id: staffSessionId,
        idempotency_key: archeryIdempotencyKey(action, bookingId),
        ...(bookingId ? { booking_id: bookingId } : {}),
        ...extra
    };
}

function archeryResourceIdFromLaneNumber(value) {
    const lane = Number(value);
    if (!Number.isInteger(lane) || lane < 1 || lane > 10) return '';
    return `${archeryBranchId()}_ARCHERY_LANE_${String(lane).padStart(2, '0')}`;
}

function archeryResourceLabel(resourceId = '') {
    const lane = String(resourceId || '').match(/(\d{2})$/);
    return lane ? `Lane ${Number(lane[1])}` : (resourceId || '-');
}

function archeryPartySizeFromBooking(booking = {}) {
    const value = Number(booking.party_size || booking.partySize || booking.required_lane_count || booking.requiredLaneCount || 1);
    return Number.isInteger(value) && value >= 1 ? value : 1;
}

function archeryLaneNumbersFromBooking(booking = {}) {
    const directNumbers = Array.isArray(booking.assigned_lane_numbers)
        ? booking.assigned_lane_numbers
        : Array.isArray(booking.assignedLaneNumbers)
            ? booking.assignedLaneNumbers
            : [];
    const fromIds = (Array.isArray(booking.assigned_resource_ids)
        ? booking.assigned_resource_ids
        : Array.isArray(booking.assignedResourceIds)
            ? booking.assignedResourceIds
            : [])
        .concat([booking.assigned_resource_id, booking.resource_id, booking.lane_id, booking.laneId])
        .map(value => String(value || '').match(/(\d{2})$/)?.[1])
        .filter(Boolean)
        .map(Number);
    const numbers = directNumbers.concat(fromIds)
        .map(Number)
        .filter(number => Number.isInteger(number) && number >= 1 && number <= 10);
    return Array.from(new Set(numbers));
}

function archeryLanesLabel(booking = {}) {
    const lanes = archeryLaneNumbersFromBooking(booking);
    return lanes.length ? lanes.map(number => `Lane ${number}`).join(', ') : archeryResourceLabel(booking.assigned_resource_id || booking.resource_id);
}

function adminSelectedArcheryOption(name, options = []) {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    return activeArcheryItems(options).find(item => item.id === checked?.value) || activeArcheryItems(options)[0] || null;
}

function adminArcheryOptionLabel(option = {}) {
    const labels = {
        first_time_with_coach: 'First time + coach',
        experienced_with_coach: 'Experienced + coach',
        experienced_no_coach: 'Experienced, no coach',
        rent_full_set: 'Rent equipment',
        bring_own: 'Bring own equipment'
    };
    return labels[option.id || option.option_id] || option.label || '-';
}

function adminArcheryPricePreview() {
    const pricing = archeryPricingConfig();
    const duration = Number(document.getElementById('archery-admin-package')?.value || 60) || 60;
    const hours = duration / 60;
    const packageRow = activeArcheryItems(pricing.packages).find(item => item.durationMinutes === duration) || pricing.packages[0] || {};
    const ability = adminSelectedArcheryOption('archery-admin-ability', pricing.abilityOptions);
    const equipment = adminSelectedArcheryOption('archery-admin-equipment', pricing.equipmentOptions);
    const partySize = Math.max(1, Math.min(10, Math.floor(Number(document.getElementById('archery-admin-party-size')?.value || 1) || 1)));
    const packageAmount = Number(packageRow.price || 0) || 0;
    const coachAmount = Math.round(Number(ability?.ratePerHour || 0) * hours);
    const equipmentAmount = Math.round(Number(equipment?.ratePerHour || 0) * hours);
    const perPersonTotal = packageAmount + coachAmount + equipmentAmount;
    return {
        duration,
        partySize,
        requiredLaneCount: partySize,
        packageAmount,
        coachAmount,
        equipmentAmount,
        amountTotal: perPersonTotal * partySize,
        ability,
        equipment
    };
}

function renderAdminPricePreview() {
    const el = document.getElementById('archery-admin-price-preview');
    if (!el) return;
    const preview = adminArcheryPricePreview();
    const total = document.getElementById('archery-admin-price-total');
    if (total) total.textContent = archeryMoney(preview.amountTotal);
    el.innerHTML = [
        ['People', String(preview.partySize)],
        ['Lanes needed', String(preview.requiredLaneCount)],
        ['Package / person', archeryMoney(preview.packageAmount)],
        ['Coach / person', `${adminArcheryOptionLabel(preview.ability)} / ${archeryMoney(preview.coachAmount)}`],
        ['Equipment / person', `${adminArcheryOptionLabel(preview.equipment)} / ${archeryMoney(preview.equipmentAmount)}`]
    ].map(([label, value]) => `<li><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></li>`).join('');
}

function renderAdminOptionCards(containerId, inputName, options = [], formatter = () => '') {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = activeArcheryItems(options).map((option, index) => `
        <label class="archery-choice-card">
            <input type="radio" name="${escapeHTML(inputName)}" value="${escapeHTML(option.id)}" ${index === 0 ? 'checked' : ''} required>
            <strong>${escapeHTML(adminArcheryOptionLabel(option))}</strong>
            <small>${escapeHTML(formatter(option))}</small>
        </label>
    `).join('');
    el.querySelectorAll('input[type="radio"]').forEach(input => input.addEventListener('change', renderAdminPricePreview));
}

function renderAdminWalkinPricingOptions() {
    const pricing = archeryPricingConfig();
    const packageSelect = document.getElementById('archery-admin-package');
    if (packageSelect) {
        const selected = packageSelect.value;
        packageSelect.innerHTML = activeArcheryItems(pricing.packages).map(item => (
            `<option value="${escapeHTML(item.durationMinutes)}">${escapeHTML(item.title || item.durationMinutes + ' min')} - ${escapeHTML(archeryMoney(item.price))}</option>`
        )).join('');
        if (selected && Array.from(packageSelect.options).some(option => option.value === selected)) packageSelect.value = selected;
    }
    renderAdminOptionCards('archery-admin-ability-options', 'archery-admin-ability', pricing.abilityOptions, option => (
        `${option.coachRequired ? 'Coach included · ' : ''}${option.ratePerHour ? archeryMoney(option.ratePerHour) + ' / hour' : 'No extra charge'}`
    ));
    renderAdminOptionCards('archery-admin-equipment-options', 'archery-admin-equipment', pricing.equipmentOptions, option => (
        option.ratePerHour ? archeryMoney(option.ratePerHour) + ' / hour' : 'No extra charge'
    ));
    adminFillArcheryTimeOptions();
    renderAdminPricePreview();
}

function updateArcheryRoleVisibility() {
    const form = document.getElementById('archery-walkin-form');
    if (form) form.hidden = !archeryCan('createWalkIn');
    const auditPanel = document.getElementById('archery-audit-panel');
    if (auditPanel) auditPanel.hidden = !archeryCan('viewAuditTrail');
}

function bindArcheryAdminControls() {
    if (archeryAdminControlsBound) return;
    archeryAdminControlsBound = true;
    const date = adminTodayISO();
    ['archery-admin-date', 'archery-admin-board-date'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.value) el.value = date;
    });
    adminFillArcheryTimeOptions();
    renderAdminWalkinPricingOptions();
    document.getElementById('archery-admin-package')?.addEventListener('change', () => {
        adminFillArcheryTimeOptions();
        renderAdminPricePreview();
    });
    document.getElementById('archery-admin-party-size')?.addEventListener('change', renderAdminPricePreview);
    [
        'archery-admin-board-date',
        'archery-admin-board-status',
        'archery-admin-board-source',
        'archery-admin-board-payment',
        'archery-admin-board-lane',
        'archery-admin-board-package'
    ].forEach(id => document.getElementById(id)?.addEventListener('change', () => renderArcheryAdmin(archeryBookingsData)));
    document.getElementById('archery-admin-board-member')?.addEventListener('input', () => renderArcheryAdmin(archeryBookingsData));
    document.getElementById('archery-admin-member-search')?.addEventListener('change', applyArcheryMemberSearch);
    document.getElementById('archery-admin-today')?.addEventListener('click', () => {
        const boardDate = document.getElementById('archery-admin-board-date');
        if (boardDate) boardDate.value = adminTodayISO();
        renderArcheryAdmin(archeryBookingsData);
    });
    document.getElementById('archery-walkin-form')?.addEventListener('submit', createArcheryWalkInFromAdmin);
    renderArcheryMemberOptions();
    updateArcheryRoleVisibility();
}

function bindAllBookingsControls() {
    if (allBookingsControlsBound) return;
    allBookingsControlsBound = true;
    ['all-bookings-date-filter', 'all-bookings-service-filter', 'all-bookings-status-filter'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => renderAllBookings(dashboardBookingsData));
    });
}

function isArcheryBooking(booking = {}) {
    return String(booking.service_type || booking.serviceType || '').toUpperCase() === 'ARCHERY';
}

function archeryBookingDate(booking = {}) {
    return String(booking.booking_date || booking.date || '').slice(0, 10);
}

function archeryBookingStartTime(booking = {}) {
    return String(booking.start_time || booking.startTime || booking.time || '').slice(0, 5);
}

function archeryBookingEndTime(booking = {}) {
    const explicit = String(booking.end_time || booking.endTime || '').slice(0, 5);
    if (explicit) return explicit;
    const start = archeryBookingStartTime(booking);
    const duration = archeryPackageMinutes(booking);
    if (!start || !duration) return '';
    return adminTimeFromMinutes(adminMinutesFromTime(start) + duration);
}

function archeryBookingStatus(booking = {}) {
    if (booking.cancel_requested === true && String(booking.cancel_request_status || '').toUpperCase() === 'PENDING') {
        return 'CANCEL_REQUESTED';
    }
    return String(booking.booking_status || booking.status || '').toUpperCase() || 'PENDING';
}

function archeryPackageMinutes(booking = {}) {
    const duration = Number(booking.duration_minutes || booking.durationMinutes || booking.package_minutes || booking.packageMinutes || 0);
    if (duration) return duration;
    const packageMatch = String(booking.package_code || booking.packageCode || '').match(/(\d{2,3})/);
    if (packageMatch) return Number(packageMatch[1]);
    const start = archeryBookingStartTime(booking);
    const end = String(booking.end_time || booking.endTime || '').slice(0, 5);
    if (start && end) return Math.max(0, adminMinutesFromTime(end) - adminMinutesFromTime(start));
    return 0;
}

function archeryLaneNumberFromBooking(booking = {}) {
    const lanes = archeryLaneNumbersFromBooking(booking);
    if (lanes.length) return lanes[0];
    const direct = Number(booking.lane_number || 0);
    if (direct) return direct;
    const match = String(booking.assigned_resource_id || booking.resource_id || booking.lane_id || booking.laneId || '').match(/(\d{2})$/);
    return match ? Number(match[1]) : 0;
}

function archeryPaymentLabel(booking = {}) {
    const payment = String(booking.payment_status || booking.paymentStatus || '').toUpperCase();
    if (payment === 'PAID_ONLINE') return 'Paid Online';
    if (payment === 'PAID_COUNTER') return 'Paid Counter';
    if (payment === 'UNPAID') return 'Unpaid';
    if (payment === 'REFUNDED') return 'Refunded';
    if (payment === 'PAID') return 'Paid';
    return payment || 'Unpaid';
}

function archeryStatusLabel(booking = {}) {
    const status = archeryBookingStatus(booking);
    if (status === 'CANCEL_REQUESTED') return 'Cancel requested';
    if (status === 'CHECKED_IN') return 'Checked-in';
    if (status === 'COMPLETED') return 'Completed';
    if (status === 'CANCELLED') return 'Cancelled';
    if (status === 'NO_SHOW') return 'No Show';
    if (status === 'HELD') return 'Held';
    if (status === 'CONFIRMED') return 'Confirmed';
    if (status === 'EXPIRED') return 'Expired';
    return status || 'Pending';
}

function archeryBookingIsActive(booking = {}) {
    return !ARCHERY_CLOSED_STATUSES.has(archeryBookingStatus(booking));
}

function archeryBookingMatchesBoardFilters(booking = {}) {
    const statusFilter = document.getElementById('archery-admin-board-status')?.value || 'active';
    const sourceFilter = document.getElementById('archery-admin-board-source')?.value || 'all';
    const paymentFilter = document.getElementById('archery-admin-board-payment')?.value || 'all';
    const memberFilter = String(document.getElementById('archery-admin-board-member')?.value || '').trim().toLowerCase();
    const laneFilter = document.getElementById('archery-admin-board-lane')?.value || 'all';
    const packageFilter = document.getElementById('archery-admin-board-package')?.value || 'all';
    const payment = String(booking.payment_status || booking.paymentStatus || '').toUpperCase();
    const source = String(booking.source || '').toUpperCase();
    const status = archeryBookingStatus(booking);
    if (sourceFilter !== 'all' && source !== sourceFilter.toUpperCase()) return false;
    if (paymentFilter !== 'all' && payment !== paymentFilter) return false;
    if (laneFilter !== 'all' && !archeryLaneNumbersFromBooking(booking).includes(Number(laneFilter))) return false;
    if (packageFilter !== 'all' && archeryPackageMinutes(booking) !== Number(packageFilter)) return false;
    if (memberFilter) {
        const haystack = [
            booking.member_id,
            booking.memberId,
            booking.uid,
            booking.customerName,
            booking.customer_name,
            booking.name,
            booking.customerPhone,
            booking.customer_phone,
            booking.phone,
            booking.customerEmail,
            booking.customer_email,
            booking.email
        ].map(value => String(value || '').toLowerCase()).join(' ');
        if (!haystack.includes(memberFilter)) return false;
    }
    if (statusFilter === 'active') return archeryBookingIsActive(booking);
    if (statusFilter === 'paid') return payment === 'PAID_ONLINE' || payment === 'PAID_COUNTER' || payment === 'PAID';
    if (statusFilter === 'pending') return !(payment === 'PAID_ONLINE' || payment === 'PAID_COUNTER' || payment === 'PAID');
    if (statusFilter !== 'all') return status === statusFilter;
    return true;
}

function archeryBookingAtSlot(bookings, laneNumber, minute) {
    return bookings.find(booking => {
        if (!archeryLaneNumbersFromBooking(booking).includes(laneNumber)) return false;
        const start = adminMinutesFromTime(archeryBookingStartTime(booking));
        const end = adminMinutesFromTime(archeryBookingEndTime(booking));
        return start <= minute && minute < end;
    });
}

function archerySlotClass(booking = {}) {
    const status = archeryBookingStatus(booking);
    if (status === 'HELD') return 'held';
    if (status === 'CHECKED_IN') return 'checked-in';
    if (status === 'NO_SHOW') return 'no-show closed';
    if (status === 'CANCEL_REQUESTED') return 'cancel-requested';
    if (ARCHERY_CLOSED_STATUSES.has(status)) return 'closed';
    return 'busy';
}

function renderArcherySchedule(bookings = []) {
    const table = document.getElementById('archery-schedule-table');
    if (!table) return;
    const lanes = Array.from({ length: 10 }, (_, index) => index + 1);
    const rows = [];
    rows.push(`<thead><tr><th>Time</th>${lanes.map(lane => `<th>Lane ${lane}</th>`).join('')}</tr></thead>`);
    rows.push('<tbody>');
    for (let minute = 10 * 60; minute < 20 * 60; minute += 15) {
        rows.push(`<tr><th>${adminTimeFromMinutes(minute)}</th>`);
        lanes.forEach(lane => {
            const booking = archeryBookingAtSlot(bookings, lane, minute);
            if (!booking) {
                rows.push('<td><span class="archery-slot-chip">Available</span></td>');
                return;
            }
            rows.push(`
                <td>
                    <span class="archery-slot-chip ${archerySlotClass(booking)}">
                        <strong>${escapeHTML(booking.customerName || booking.customer_name || booking.name || booking.member_id || 'Member')}</strong>
                        <small>${escapeHTML(archeryPartySizeFromBooking(booking))} people / ${escapeHTML(archeryLanesLabel(booking))}</small>
                        <small>${escapeHTML(archeryPaymentLabel(booking))} / ${escapeHTML(archeryStatusLabel(booking))}</small>
                    </span>
                </td>
            `);
        });
        rows.push('</tr>');
    }
    rows.push('</tbody>');
    table.innerHTML = rows.join('');
}

function archeryBookingById(bookingId) {
    return (archeryBookingsData || []).find(booking => String(booking.id || booking.firestoreId || '') === String(bookingId)) || {};
}

function archeryActionButton(label, handler, bookingId, permission, options = {}) {
    if (!archeryCan(permission)) return '';
    const loadingKey = `${handler}:${bookingId}`;
    const disabled = archeryActionLoading.has(loadingKey) ? ' disabled' : '';
    const danger = options.danger ? ' class="danger"' : '';
    return `<button${danger} type="button"${disabled} onclick="${handler}('${escapeJSString(bookingId)}')">${escapeHTML(label)}</button>`;
}

function archeryActionButtons(booking = {}) {
    const id = String(booking.id || booking.firestoreId || '');
    const safeId = escapeJSString(id);
    const status = archeryBookingStatus(booking);
    const payment = String(booking.payment_status || booking.paymentStatus || '').toUpperCase();
    const closed = ARCHERY_CLOSED_STATUSES.has(status);
    const paid = ARCHERY_PAID_STATUSES.has(payment);
    const hasCancelRequest = booking.cancel_requested === true && String(booking.cancel_request_status || '').toUpperCase() === 'PENDING';
    const paymentId = booking.payment_id || booking.paymentId || '';
    const buttons = [];
    if (!closed && status === 'CONFIRMED' && archeryCan('checkIn')) buttons.push(`<button type="button" onclick="archeryAdminAction('adminCheckInBooking','${safeId}')">Check-in</button>`);
    if (!closed && ['CONFIRMED', 'CHECKED_IN'].includes(status) && archeryCan('extendTime')) buttons.push(archeryActionButton('Extend', 'archeryAdminExtend', id, 'extendTime'));
    if (!closed && ['CONFIRMED', 'CHECKED_IN'].includes(status) && archeryCan('moveLane')) buttons.push(archeryActionButton('Move', 'archeryAdminMove', id, 'moveLane'));
    if (!closed && !paid && archeryCan('recordCounterPayment')) buttons.push(archeryActionButton('Paid Counter', 'archeryAdminPayment', id, 'recordCounterPayment'));
    if (!closed && ['CONFIRMED', 'CHECKED_IN'].includes(status) && archeryCan('complete')) buttons.push(`<button type="button" onclick="archeryAdminAction('adminCompleteBooking','${safeId}')">Complete</button>`);
    if (!closed && status === 'CONFIRMED' && archeryCan('markNoShow')) buttons.push(`<button class="danger" type="button" onclick="archeryAdminAction('adminMarkNoShow','${safeId}')">No Show</button>`);
    if (!closed && !hasCancelRequest && archeryCan('requestCancel')) buttons.push(archeryActionButton('Request Cancel', 'archeryAdminCancel', id, 'requestCancel', { danger: true }));
    if (!closed && hasCancelRequest && archeryCan('approveCancel')) buttons.push(archeryActionButton('Approve Cancel', 'archeryApproveCancel', id, 'approveCancel', { danger: true }));
    if (paid && payment !== 'REFUNDED' && paymentId && archeryCan('refund')) buttons.push(archeryActionButton('Refund', 'archeryAdminRefund', id, 'refund', { danger: true }));
    return `<div class="archery-action-buttons">${buttons.join('') || '-'}</div>`;
}

function archeryOptionSummary(booking = {}) {
    return [
        booking.ability_label || booking.abilityLabel || '',
        booking.equipment_label || booking.equipmentLabel || ''
    ].filter(Boolean).join(' / ');
}

function archeryAmountLabel(booking = {}) {
    const amount = Number(booking.amount_total || booking.amountTotal || booking.total_price || booking.amount || 0) || 0;
    return amount ? archeryMoney(amount) : '-';
}

function renderArcheryAdmin(bookings = []) {
    bindArcheryAdminControls();
    updateArcheryRoleVisibility();
    const boardDateEl = document.getElementById('archery-admin-board-date');
    if (boardDateEl && !boardDateEl.value) boardDateEl.value = adminTodayISO();
    const boardDate = boardDateEl?.value || adminTodayISO();
    const archeryBookings = (bookings || [])
        .filter(isArcheryBooking)
        .filter(booking => archeryBookingDate(booking) === boardDate)
        .filter(archeryBookingMatchesBoardFilters)
        .sort((a, b) => archeryBookingStartTime(a).localeCompare(archeryBookingStartTime(b)));
    renderArcherySchedule(archeryBookings);
    renderArcheryPaymentPanel(archeryBookings);
    renderArcheryPaymentWatch(archeryBookings);
    renderArcheryWebhookEvents();
    renderArcheryReconciliationPanel();
    renderArcheryAuditTrail();

    const tbody = document.getElementById('archery-bookings-table-body');
    if (!tbody) return;
    if (!archeryBookings.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No archery bookings for this filter.</td></tr>';
        return;
    }
    tbody.innerHTML = archeryBookings.map(booking => `
        <tr>
            <td><strong>${escapeHTML(booking.id || booking.firestoreId || '-')}</strong><br><small>${escapeHTML(archeryBookingDate(booking))}</small></td>
            <td>${escapeHTML(booking.customerName || booking.customer_name || booking.name || 'Member')}<br><small>${escapeHTML(booking.member_id || booking.uid || '')}</small></td>
            <td>${escapeHTML(archeryPartySizeFromBooking(booking))} people / ${escapeHTML(archeryLanesLabel(booking))}<br><small>${escapeHTML(archeryBookingStartTime(booking) || '-')} - ${escapeHTML(archeryBookingEndTime(booking) || '-')}</small></td>
            <td>${escapeHTML(String(booking.source || 'ONLINE').replace('_', ' '))}</td>
            <td>${escapeHTML(archeryPaymentLabel(booking))}<br><small>${escapeHTML(archeryAmountLabel(booking))}${archeryOptionSummary(booking) ? ' / ' + escapeHTML(archeryOptionSummary(booking)) : ''}</small></td>
            <td>${escapeHTML(archeryStatusLabel(booking))}</td>
            <td>${archeryActionButtons(booking)}</td>
        </tr>
    `).join('');
}

function renderArcheryPaymentPanel(bookings = []) {
    const panel = document.getElementById('archery-payment-panel');
    if (!panel) return;
    if (!archeryCan('viewPaymentStatus')) {
        panel.innerHTML = '<p class="archery-status error">บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้</p>';
        return;
    }
    const rows = bookings
        .filter(booking => archeryBookingIsActive(booking))
        .sort((a, b) => archeryBookingStartTime(a).localeCompare(archeryBookingStartTime(b)))
        .slice(0, 12);
    if (!rows.length) {
        panel.innerHTML = '<p class="archery-status">No active payment items.</p>';
        return;
    }
    panel.innerHTML = `<div class="archery-panel-list">${rows.map(booking => {
        const id = String(booking.id || booking.firestoreId || '');
        const payment = String(booking.payment_status || booking.paymentStatus || '').toUpperCase();
        const paid = ARCHERY_PAID_STATUSES.has(payment);
        const canRecord = archeryCan('recordCounterPayment') && !paid;
        return `
            <div class="archery-panel-row">
                <div>
                    <strong>${escapeHTML(booking.customerName || booking.customer_name || booking.name || booking.member_id || 'Member')}</strong>
                    <small>${escapeHTML(archeryBookingStartTime(booking))} / ${escapeHTML(archeryPartySizeFromBooking(booking))} people / ${escapeHTML(archeryLanesLabel(booking))} / ${escapeHTML(archeryPaymentLabel(booking))} / ${escapeHTML(archeryAmountLabel(booking))} / ${escapeHTML(booking.id || booking.firestoreId || '')}</small>
                    ${archeryOptionSummary(booking) ? `<small>${escapeHTML(archeryOptionSummary(booking))}</small>` : ''}
                </div>
                <div class="archery-action-buttons">
                    ${canRecord ? archeryActionButton('Paid Counter', 'archeryAdminPayment', id, 'recordCounterPayment') : '<span>-</span>'}
                </div>
            </div>
        `;
    }).join('')}</div>`;
}

function archeryPaymentForBooking(bookingId = '') {
    const id = String(bookingId || '');
    return (archeryPaymentsData || [])
        .filter(payment => String(payment.booking_id || payment.bookingId || '') === id)
        .sort((a, b) => adminTimestampMillis(b.updated_at || b.updatedAt || b.created_at || b.createdAt) - adminTimestampMillis(a.updated_at || a.updatedAt || a.created_at || a.createdAt))[0] || null;
}

function archeryPaymentWatchAgeLabel(booking = {}, payment = null) {
    const startedAt = adminTimestampMillis(payment?.created_at || payment?.createdAt || booking.updated_at || booking.updatedAt || booking.created_at || booking.createdAt);
    if (!startedAt) return '-';
    const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
    return minutes < 1 ? 'just now' : `${minutes} min`;
}

function renderArcheryPaymentWatch(bookings = []) {
    const panel = document.getElementById('archery-payment-watch');
    if (!panel) return;
    if (!archeryCan('viewPaymentStatus')) {
        panel.innerHTML = '<p class="archery-status error">บัญชีนี้ไม่มีสิทธิ์ดูสถานะชำระเงิน</p>';
        return;
    }
    const rows = (bookings || [])
        .filter(booking => archeryBookingIsActive(booking))
        .map(booking => {
            const bookingId = String(booking.id || booking.firestoreId || booking.booking_id || '');
            const payment = archeryPaymentForBooking(bookingId);
            const paymentStatus = String(booking.payment_status || payment?.payment_status || payment?.status || 'UNPAID').toUpperCase();
            return { booking, bookingId, payment, paymentStatus };
        })
        .filter(row => ARCHERY_PENDING_PAYMENT_STATUSES.has(row.paymentStatus) || row.paymentStatus === '')
        .sort((a, b) => adminTimestampMillis(b.payment?.updated_at || b.booking.updated_at || b.booking.created_at) - adminTimestampMillis(a.payment?.updated_at || a.booking.updated_at || a.booking.created_at))
        .slice(0, 12);
    if (!rows.length) {
        panel.innerHTML = '<p class="archery-status success">No pending online payments.</p>';
        return;
    }
    panel.innerHTML = `<div class="archery-panel-list">${rows.map(row => {
        const booking = row.booking;
        const payment = row.payment || {};
        const link = payment.payment_link_url ? `<a href="${escapeHTML(payment.payment_link_url)}" target="_blank" rel="noopener noreferrer">Beam link</a>` : '';
        return `
            <div class="archery-panel-row">
                <div>
                    <strong>${escapeHTML(row.paymentStatus || 'PENDING')} / ${escapeHTML(row.bookingId)}</strong>
                    <small>${escapeHTML(booking.customerName || booking.customer_name || booking.name || booking.member_id || 'Member')} / ${escapeHTML(archeryBookingDate(booking))} ${escapeHTML(archeryBookingStartTime(booking))} / ${escapeHTML(archeryAmountLabel(booking))}</small>
                    <small>${escapeHTML(payment.provider || 'BEAM')} ${escapeHTML(payment.provider_ref || payment.beam_payment_link_id || '-')} / age ${escapeHTML(archeryPaymentWatchAgeLabel(booking, payment))}</small>
                    ${link ? `<small>${link}</small>` : ''}
                </div>
                <small>${escapeHTML(adminTimestampText(payment.updated_at || payment.updatedAt || payment.created_at || payment.createdAt || booking.updated_at || booking.created_at))}</small>
            </div>
        `;
    }).join('')}</div>`;
}

function renderArcheryWebhookEvents() {
    const panel = document.getElementById('archery-webhook-events');
    if (!panel) return;
    if (!['OWNER', 'MANAGER'].includes(archeryAdminRole())) {
        panel.innerHTML = '<p class="archery-status">Owner/Manager only.</p>';
        return;
    }
    const rows = (archeryWebhookEventsData || [])
        .slice()
        .sort((a, b) => adminTimestampMillis(b.updated_at || b.created_at) - adminTimestampMillis(a.updated_at || a.created_at))
        .slice(0, 12);
    if (!rows.length) {
        panel.innerHTML = '<p class="archery-status">No Beam webhook events loaded.</p>';
        return;
    }
    panel.innerHTML = `<div class="archery-panel-list">${rows.map(row => `
        <div class="archery-panel-row">
            <div>
                <strong>${escapeHTML(row.status || '-')} / ${escapeHTML(row.event_type || '-')}</strong>
                <small>${escapeHTML(row.booking_id || '-')} / ${escapeHTML(row.provider_ref || '-')}</small>
                ${row.reconciliation_id ? `<small>Reconciliation: ${escapeHTML(row.reconciliation_id)}</small>` : ''}
            </div>
            <small>${escapeHTML(adminTimestampText(row.updated_at || row.created_at))}</small>
        </div>
    `).join('')}</div>`;
}

function renderArcheryReconciliationPanel() {
    const panel = document.getElementById('archery-reconciliation-panel');
    if (!panel) return;
    if (!['OWNER', 'MANAGER'].includes(archeryAdminRole())) {
        panel.innerHTML = '<p class="archery-status">Owner/Manager only.</p>';
        return;
    }
    const rows = (archeryReconciliationData || [])
        .slice()
        .sort((a, b) => adminTimestampMillis(b.updated_at || b.created_at) - adminTimestampMillis(a.updated_at || a.created_at))
        .slice(0, 12);
    if (!rows.length) {
        panel.innerHTML = '<p class="archery-status success">No reconciliation items.</p>';
        return;
    }
    panel.innerHTML = `<div class="archery-panel-list">${rows.map(row => {
        const id = String(row.id || row.reconciliation_id || '');
        const open = String(row.status || '').toUpperCase() === 'OPEN';
        return `
            <div class="archery-panel-row">
                <div>
                    <strong>${escapeHTML(row.status || '-')} / ${escapeHTML(row.booking_id || '-')}</strong>
                    <small>${escapeHTML(row.reason || '-')} / ${escapeHTML(archeryMoney(row.amount || 0))} / ${escapeHTML(row.provider_ref || '-')}</small>
                    <small>${escapeHTML(adminTimestampText(row.updated_at || row.created_at))}</small>
                </div>
                <div class="archery-action-buttons">
                    ${open && archeryCan('refund') ? `<button type="button" onclick="archeryReviewReconciliation('${escapeJSString(id)}','MARK_REVIEWED')">Reviewed</button><button class="danger" type="button" onclick="archeryReviewReconciliation('${escapeJSString(id)}','MARK_REFUND_REQUIRED')">Refund required</button>` : '<span>-</span>'}
                </div>
            </div>
        `;
    }).join('')}</div>`;
}

function adminTimestampMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (value.seconds) return Number(value.seconds) * 1000;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function adminTimestampText(value) {
    const millis = adminTimestampMillis(value);
    if (!millis) return '-';
    return new Date(millis).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

function renderArcheryAuditTrail() {
    const panel = document.getElementById('archery-audit-panel');
    const trail = document.getElementById('archery-audit-trail');
    if (!panel || !trail) return;
    panel.hidden = !archeryCan('viewAuditTrail');
    if (panel.hidden) return;
    const rows = (archeryAuditLogsData || [])
        .filter(row => ARCHERY_AUDIT_ACTIONS.has(String(row.action || '')))
        .sort((a, b) => adminTimestampMillis(b.created_at || b.createdAt) - adminTimestampMillis(a.created_at || a.createdAt))
        .slice(0, 30);
    if (!rows.length) {
        trail.innerHTML = '<p class="archery-status">No audit records.</p>';
        return;
    }
    trail.innerHTML = `<div class="archery-panel-list">${rows.map(row => `
        <div class="archery-panel-row">
            <div>
                <strong>${escapeHTML(row.action || '-')}</strong>
                <small>${escapeHTML(row.actor_role || '-')} / ${escapeHTML(row.actor_id || '-')} / ${escapeHTML(row.target_id || '-')}</small>
                ${row.reason ? `<small>${escapeHTML(row.reason)}</small>` : ''}
            </div>
            <small>${escapeHTML(adminTimestampText(row.created_at || row.createdAt))}</small>
        </div>
    `).join('')}</div>`;
}

function archeryMemberOptionRows() {
    return Object.entries(membersData || {}).map(([uid, member]) => {
        const summary = memberSummariesData[uid] || {};
        return {
            uid,
            member,
            label: [
                memberDisplayName(member),
                member.email || summary.email || '',
                member.phone || summary.phone || '',
                uid
            ].filter(Boolean).join(' | ')
        };
    }).sort((a, b) => a.label.localeCompare(b.label, 'th'));
}

function renderArcheryMemberOptions() {
    const datalist = document.getElementById('archery-admin-member-options');
    if (!datalist) return;
    datalist.innerHTML = archeryMemberOptionRows().slice(0, 300)
        .map(row => `<option value="${escapeHTML(row.label)}"></option>`)
        .join('');
}

function applyArcheryMemberSearch() {
    const input = document.getElementById('archery-admin-member-search');
    if (!input) return;
    const search = String(input.value || '').trim().toLowerCase();
    if (!search) return;
    const row = archeryMemberOptionRows().find(item => {
        const member = item.member || {};
        return item.uid.toLowerCase() === search
            || item.label.toLowerCase() === search
            || item.label.toLowerCase().includes(search)
            || String(member.email || '').toLowerCase() === search
            || String(member.phone || '').toLowerCase() === search;
    });
    if (!row) return;
    const memberId = document.getElementById('archery-admin-member-id');
    const name = document.getElementById('archery-admin-customer-name');
    const phone = document.getElementById('archery-admin-customer-phone');
    if (memberId) memberId.value = row.uid;
    if (name && !name.value) name.value = memberDisplayName(row.member);
    if (phone && !phone.value) phone.value = row.member.phone || '';
}

function allBookingServiceLabel(booking = {}) {
    if (isArcheryBooking(booking)) return 'ARCHERY';
    const bookingType = String(booking.bookingType || '').toLowerCase();
    if (bookingType === 'room') return 'room';
    if (bookingType === 'table') return 'table';
    return String(booking.service_type || booking.serviceType || bookingType || 'booking');
}

function allBookingStatusKey(booking = {}) {
    const payment = String(booking.payment_status || booking.paymentStatus || '').toUpperCase();
    const status = String(isArcheryBooking(booking) ? archeryBookingStatus(booking) : (booking.status || '')).toLowerCase();
    if (payment === 'PAID_ONLINE' || payment === 'PAID_COUNTER' || payment === 'PAID' || payment === 'paid') return 'paid';
    if (status === 'checked_in') return 'checked_in';
    if (String(booking.status || '').toUpperCase() === 'CHECKED_IN') return 'checked_in';
    if (String(booking.status || '').toUpperCase() === 'NO_SHOW') return 'no_show';
    return status || 'pending';
}

function renderAllBookings(bookings = []) {
    bindAllBookingsControls();
    const tbody = document.getElementById('all-bookings-table-body');
    if (!tbody) return;
    const dateFilter = document.getElementById('all-bookings-date-filter')?.value || '';
    const serviceFilter = document.getElementById('all-bookings-service-filter')?.value || 'all';
    const statusFilter = document.getElementById('all-bookings-status-filter')?.value || 'all';
    const filtered = (bookings || [])
        .filter(booking => !dateFilter || (isArcheryBooking(booking) ? archeryBookingDate(booking) : booking.date) === dateFilter)
        .filter(booking => serviceFilter === 'all' || allBookingServiceLabel(booking).toUpperCase() === serviceFilter.toUpperCase())
        .filter(booking => statusFilter === 'all' || allBookingStatusKey(booking) === statusFilter)
        .slice()
        .sort((a, b) => {
            const left = `${isArcheryBooking(b) ? archeryBookingDate(b) : (b.date || '')} ${isArcheryBooking(b) ? archeryBookingStartTime(b) : (b.startTime || b.start_time || b.arrivalTime || '')}`;
            const right = `${isArcheryBooking(a) ? archeryBookingDate(a) : (a.date || '')} ${isArcheryBooking(a) ? archeryBookingStartTime(a) : (a.startTime || a.start_time || a.arrivalTime || '')}`;
            return left.localeCompare(right);
        });
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No bookings for this filter.</td></tr>';
        return;
    }
    tbody.innerHTML = filtered.map(booking => `
        <tr>
            <td><strong>${escapeHTML(booking.id || booking.firestoreId || '-')}</strong></td>
            <td>${escapeHTML(allBookingServiceLabel(booking))}</td>
            <td>${escapeHTML(booking.customerName || booking.customer_name || booking.name || 'Member')}<br><small>${escapeHTML(booking.member_id || booking.uid || booking.customerUid || '')}</small></td>
            <td>${escapeHTML(isArcheryBooking(booking) ? archeryBookingDate(booking) : (booking.date || '-'))}<br><small>${escapeHTML(isArcheryBooking(booking) ? archeryBookingStartTime(booking) : (booking.startTime || booking.start_time || booking.arrivalTime || '-'))} ${isArcheryBooking(booking) ? '- ' + escapeHTML(archeryBookingEndTime(booking)) : (booking.endTime || booking.end_time ? '- ' + escapeHTML(booking.endTime || booking.end_time) : '')}</small></td>
            <td>${escapeHTML(isArcheryBooking(booking) ? `${archeryPartySizeFromBooking(booking)} people / ${archeryLanesLabel(booking)}` : (booking.laneLabel || booking.tableNo || booking.tableZone || booking.roomType || '-'))}</td>
            <td>${escapeHTML(isArcheryBooking(booking) ? archeryPaymentLabel(booking) : (booking.paymentStatus || booking.payment_status || '-'))}</td>
            <td>${escapeHTML(isArcheryBooking(booking) ? archeryStatusLabel(booking) : (booking.status || '-'))}</td>
        </tr>
    `).join('');
}

async function createArcheryWalkInFromAdmin(event) {
    event.preventDefault();
    const submit = event.submitter || event.target.querySelector('button[type="submit"]');
    if (!archeryCan('createWalkIn')) {
        archerySetStatus('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้', 'error');
        return;
    }
    archerySetStatus('Creating walk-in booking...');
    if (submit) submit.disabled = true;
    try {
        const duration = Number(document.getElementById('archery-admin-package')?.value || 60) || 60;
        const preview = adminArcheryPricePreview();
        const result = await callAdminFunction('createWalkInArcheryBooking', archeryMutationPayload('createWalkInArcheryBooking', '', {
            member_id: document.getElementById('archery-admin-member-id')?.value.trim() || '',
            customer_name: document.getElementById('archery-admin-customer-name')?.value.trim() || '',
            customer_phone: document.getElementById('archery-admin-customer-phone')?.value.trim() || '',
            booking_date: document.getElementById('archery-admin-date')?.value || adminTodayISO(),
            start_time: document.getElementById('archery-admin-start')?.value || '10:00',
            duration_minutes: duration,
            package_code: `ARCHERY_${duration}`,
            party_size: preview.partySize,
            ability_option_id: preview.ability?.id || '',
            equipment_option_id: preview.equipment?.id || '',
            payment_status: 'UNPAID',
            note: document.getElementById('archery-admin-note')?.value.trim() || ''
        }));
        archerySetStatus('Created booking ' + (result.booking_id || '') + ' / ' + (result.assigned_lane_numbers?.length ? result.assigned_lane_numbers.map(number => `Lane ${number}`).join(', ') : archeryResourceLabel(result.assigned_resource_id)), 'success');
        event.target.reset();
        document.getElementById('archery-admin-date').value = adminTodayISO();
        adminFillArcheryTimeOptions();
        renderAdminWalkinPricingOptions();
        refreshArcheryAdmin();
    } catch (error) {
        archerySetStatus(error.message || safeAdminError('Create walk-in failed'), 'error');
    } finally {
        if (submit) submit.disabled = false;
    }
}

window.archeryAdminAction = async (functionName, bookingId) => {
    if (!bookingId) return;
    if (!confirm('Confirm action for booking ' + bookingId + '?')) return;
    const actionPermission = {
        adminCheckInBooking: 'checkIn',
        adminCompleteBooking: 'complete',
        adminMarkNoShow: 'markNoShow'
    }[functionName];
    if (actionPermission && !archeryCan(actionPermission)) {
        alert('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
        return;
    }
    const extra = {};
    if (functionName === 'adminMarkNoShow') {
        const reason = prompt('No-show reason');
        if (!reason) return;
        extra.reason = reason;
    }
    const loadingKey = `${functionName}:${bookingId}`;
    if (archeryActionLoading.has(loadingKey)) return;
    archeryActionLoading.add(loadingKey);
    renderArcheryAdmin(archeryBookingsData);
    try {
        await callAdminFunction(functionName, archeryMutationPayload(functionName, bookingId, extra));
        refreshArcheryAdmin();
    } catch (error) {
        alert(error.message || safeAdminError('Archery action failed'));
    } finally {
        archeryActionLoading.delete(loadingKey);
        renderArcheryAdmin(archeryBookingsData);
    }
};

window.archeryAdminExtend = async (bookingId) => {
    const newEndTime = prompt('New end time (HH:mm), e.g. 14:30');
    if (!newEndTime) return;
    if (!archeryCan('extendTime')) {
        alert('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
        return;
    }
    const loadingKey = `archeryAdminExtend:${bookingId}`;
    if (archeryActionLoading.has(loadingKey)) return;
    archeryActionLoading.add(loadingKey);
    renderArcheryAdmin(archeryBookingsData);
    try {
        await callAdminFunction('adminExtendBooking', archeryMutationPayload('adminExtendBooking', bookingId, { new_end_time: newEndTime }));
        refreshArcheryAdmin();
    } catch (error) {
        alert(error.message || safeAdminError('Extend failed'));
    } finally {
        archeryActionLoading.delete(loadingKey);
        renderArcheryAdmin(archeryBookingsData);
    }
};

window.archeryAdminMove = async (bookingId) => {
    const booking = archeryBookingById(bookingId);
    if (archeryPartySizeFromBooking(booking) > 1 || archeryLaneNumbersFromBooking(booking).length > 1) {
        alert('Move lane is not supported for bookings that use multiple lanes.');
        return;
    }
    const lane = prompt('New lane number 1-10');
    if (!lane) return;
    if (!archeryCan('moveLane')) {
        alert('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
        return;
    }
    const targetResourceId = archeryResourceIdFromLaneNumber(lane);
    if (!targetResourceId) {
        alert('Lane must be 1-10');
        return;
    }
    const loadingKey = `archeryAdminMove:${bookingId}`;
    if (archeryActionLoading.has(loadingKey)) return;
    archeryActionLoading.add(loadingKey);
    renderArcheryAdmin(archeryBookingsData);
    try {
        await callAdminFunction('adminMoveBookingLane', archeryMutationPayload('adminMoveBookingLane', bookingId, { target_resource_id: targetResourceId }));
        refreshArcheryAdmin();
    } catch (error) {
        alert(error.message || safeAdminError('Move lane failed'));
    } finally {
        archeryActionLoading.delete(loadingKey);
        renderArcheryAdmin(archeryBookingsData);
    }
};

window.archeryAdminCancel = async (bookingId) => {
    const reason = prompt('Cancel reason');
    if (!reason) return;
    if (!archeryCan('requestCancel')) {
        alert('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
        return;
    }
    const loadingKey = `archeryAdminCancel:${bookingId}`;
    if (archeryActionLoading.has(loadingKey)) return;
    archeryActionLoading.add(loadingKey);
    renderArcheryAdmin(archeryBookingsData);
    try {
        await callAdminFunction('requestCancelBooking', archeryMutationPayload('requestCancelBooking', bookingId, { reason }));
        refreshArcheryAdmin();
    } catch (error) {
        alert(error.message || safeAdminError('Cancel failed'));
    } finally {
        archeryActionLoading.delete(loadingKey);
        renderArcheryAdmin(archeryBookingsData);
    }
};

window.archeryAdminPayment = async (bookingId) => {
    const booking = archeryBookingById(bookingId);
    const payment = String(booking.payment_status || booking.paymentStatus || '').toUpperCase();
    if (ARCHERY_PAID_STATUSES.has(payment)) {
        alert('รายการนี้มีการชำระเงินแล้ว');
        return;
    }
    if (!archeryCan('recordCounterPayment')) {
        alert('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
        return;
    }
    const receiptRef = prompt('Payment reference / receipt id', 'counter-' + bookingId + '-' + Date.now());
    if (!receiptRef) return;
    const amountInput = prompt('Amount (THB)', String(booking.amount_total || booking.amount || 0));
    if (amountInput === null) return;
    const loadingKey = `archeryAdminPayment:${bookingId}`;
    if (archeryActionLoading.has(loadingKey)) return;
    archeryActionLoading.add(loadingKey);
    renderArcheryAdmin(archeryBookingsData);
    try {
        await callAdminFunction('recordCounterPayment', archeryMutationPayload('recordCounterPayment', bookingId, {
            idempotency_key: `counter-${bookingId}-${receiptRef}`,
            amount: Number(amountInput || 0) || 0,
            method: 'COUNTER'
        }));
        refreshArcheryAdmin();
    } catch (error) {
        alert(error.message || safeAdminError('Payment failed'));
    } finally {
        archeryActionLoading.delete(loadingKey);
        renderArcheryAdmin(archeryBookingsData);
    }
};

window.archeryApproveCancel = async (bookingId) => {
    const reason = prompt('Approve cancel reason');
    if (!reason) return;
    if (!archeryCan('approveCancel')) {
        alert('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
        return;
    }
    const loadingKey = `archeryApproveCancel:${bookingId}`;
    if (archeryActionLoading.has(loadingKey)) return;
    archeryActionLoading.add(loadingKey);
    renderArcheryAdmin(archeryBookingsData);
    try {
        await callAdminFunction('approveCancelBooking', archeryMutationPayload('approveCancelBooking', bookingId, { reason }));
        refreshArcheryAdmin();
    } catch (error) {
        alert(error.message || safeAdminError('Approve cancel failed'));
    } finally {
        archeryActionLoading.delete(loadingKey);
        renderArcheryAdmin(archeryBookingsData);
    }
};

window.archeryAdminRefund = async (bookingId) => {
    const booking = archeryBookingById(bookingId);
    const paymentId = booking.payment_id || booking.paymentId || '';
    if (!paymentId) {
        alert('ไม่พบข้อมูลการชำระเงินของรายการนี้');
        return;
    }
    const reason = prompt('Refund reason');
    if (!reason) return;
    if (!archeryCan('refund')) {
        alert('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
        return;
    }
    const amountInput = prompt('Refund amount (THB)', String(booking.amount_total || booking.amount || 0));
    if (amountInput === null) return;
    const loadingKey = `archeryAdminRefund:${bookingId}`;
    if (archeryActionLoading.has(loadingKey)) return;
    archeryActionLoading.add(loadingKey);
    renderArcheryAdmin(archeryBookingsData);
    try {
        await callAdminFunction('refundPayment', archeryMutationPayload('refundPayment', bookingId, {
            payment_id: paymentId,
            amount: Number(amountInput || 0) || 0,
            reason
        }));
        refreshArcheryAdmin();
    } catch (error) {
        alert(error.message || safeAdminError('Refund failed'));
    } finally {
        archeryActionLoading.delete(loadingKey);
        renderArcheryAdmin(archeryBookingsData);
    }
};

window.archeryReviewReconciliation = async (reconciliationId, action = 'MARK_REVIEWED') => {
    if (!['OWNER', 'MANAGER'].includes(archeryAdminRole())) {
        alert('Owner/Manager permission is required');
        return;
    }
    if (!reconciliationId) return;
    const confirmed = confirm(action === 'MARK_REFUND_REQUIRED'
        ? 'Mark this late payment as refund required?'
        : 'Mark this reconciliation item reviewed?');
    if (!confirmed) return;
    const loadingKey = `archeryReviewReconciliation:${reconciliationId}`;
    if (archeryActionLoading.has(loadingKey)) return;
    archeryActionLoading.add(loadingKey);
    renderArcheryReconciliationPanel();
    try {
        await callAdminFunction('reconcileBeamLatePayment', archeryMutationPayload('reconcileBeamLatePayment', '', {
            reconciliation_id: reconciliationId,
            action
        }));
        refreshArcheryAdmin();
    } catch (error) {
        alert(error.message || safeAdminError('Reconciliation update failed'));
    } finally {
        archeryActionLoading.delete(loadingKey);
        renderArcheryReconciliationPanel();
    }
};

function setupRealtimeArcheryBookings() {
    bindArcheryAdminControls();
    if (archeryBookingsUnsubscribe) {
        archeryBookingsUnsubscribe();
        archeryBookingsUnsubscribe = null;
    }
    if (!canAdmin('bookings')) return;
    const branchId = archeryBranchId();
    const q = query(
        collection(db, 'bookings'),
        where('branch_id', '==', branchId),
        where('service_type', '==', 'ARCHERY'),
        limit(500)
    );
    archeryBookingsUnsubscribe = onSnapshot(q, (snapshot) => {
        archeryBookingsData = [];
        snapshot.forEach(docSnap => {
            archeryBookingsData.push({ id: docSnap.id, firestoreId: docSnap.id, ...docSnap.data() });
        });
        renderArcheryAdmin(archeryBookingsData);
        renderAllBookings((dashboardBookingsData || []).filter(booking => !isArcheryBooking(booking)).concat(archeryBookingsData));
    }, (error) => {
        console.error('Error listening to archery bookings:', error);
        archeryBookingsData = [];
        renderArcheryAdmin([]);
        const tbody = document.getElementById('archery-bookings-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#c62828;">${escapeHTML(adminFunctionErrorMessage({ code: error.code, message: error.message }))}</td></tr>`;
    });
}

function setupRealtimeArcheryPayments() {
    if (archeryPaymentsUnsubscribe) {
        archeryPaymentsUnsubscribe();
        archeryPaymentsUnsubscribe = null;
    }
    if (!archeryCan('viewPaymentStatus')) {
        archeryPaymentsData = [];
        renderArcheryPaymentWatch(archeryBookingsData);
        return;
    }
    if (!['OWNER', 'MANAGER', 'CASHIER'].includes(archeryAdminRole())) {
        archeryPaymentsData = [];
        renderArcheryPaymentWatch(archeryBookingsData);
        return;
    }
    const q = query(
        collection(db, 'payments'),
        where('branch_id', '==', archeryBranchId()),
        limit(120)
    );
    archeryPaymentsUnsubscribe = onSnapshot(q, (snapshot) => {
        archeryPaymentsData = [];
        snapshot.forEach(docSnap => {
            const data = docSnap.data() || {};
            if (String(data.service_type || data.serviceType || '').toUpperCase() === 'ARCHERY') {
                archeryPaymentsData.push({ id: docSnap.id, ...data });
            }
        });
        renderArcheryPaymentWatch(archeryBookingsData);
    }, (error) => {
        console.error('Error listening to archery payments:', error);
        archeryPaymentsData = [];
        const panel = document.getElementById('archery-payment-watch');
        if (panel) panel.innerHTML = `<p class="archery-status error">${escapeHTML(adminFunctionErrorMessage({ code: error.code, message: error.message }))}</p>`;
    });
}

function setupRealtimeArcheryWebhookEvents() {
    if (archeryWebhookEventsUnsubscribe) {
        archeryWebhookEventsUnsubscribe();
        archeryWebhookEventsUnsubscribe = null;
    }
    if (!['OWNER', 'MANAGER'].includes(archeryAdminRole())) {
        archeryWebhookEventsData = [];
        renderArcheryWebhookEvents();
        return;
    }
    const q = query(
        collection(db, 'payment_webhook_events'),
        where('branch_id', '==', archeryBranchId()),
        limit(80)
    );
    archeryWebhookEventsUnsubscribe = onSnapshot(q, (snapshot) => {
        archeryWebhookEventsData = [];
        snapshot.forEach(docSnap => {
            archeryWebhookEventsData.push({ id: docSnap.id, ...docSnap.data() });
        });
        renderArcheryWebhookEvents();
    }, (error) => {
        console.error('Error listening to archery webhook events:', error);
        archeryWebhookEventsData = [];
        const panel = document.getElementById('archery-webhook-events');
        if (panel) panel.innerHTML = `<p class="archery-status error">${escapeHTML(adminFunctionErrorMessage({ code: error.code, message: error.message }))}</p>`;
    });
}

function setupRealtimeArcheryReconciliation() {
    if (archeryReconciliationUnsubscribe) {
        archeryReconciliationUnsubscribe();
        archeryReconciliationUnsubscribe = null;
    }
    if (!['OWNER', 'MANAGER'].includes(archeryAdminRole())) {
        archeryReconciliationData = [];
        renderArcheryReconciliationPanel();
        return;
    }
    const q = query(
        collection(db, 'payment_reconciliation_queue'),
        where('branch_id', '==', archeryBranchId()),
        limit(80)
    );
    archeryReconciliationUnsubscribe = onSnapshot(q, (snapshot) => {
        archeryReconciliationData = [];
        snapshot.forEach(docSnap => {
            archeryReconciliationData.push({ id: docSnap.id, ...docSnap.data() });
        });
        renderArcheryReconciliationPanel();
    }, (error) => {
        console.error('Error listening to archery reconciliation queue:', error);
        archeryReconciliationData = [];
        const panel = document.getElementById('archery-reconciliation-panel');
        if (panel) panel.innerHTML = `<p class="archery-status error">${escapeHTML(adminFunctionErrorMessage({ code: error.code, message: error.message }))}</p>`;
    });
}

function setupRealtimeArcheryAuditLogs() {
    if (archeryAuditUnsubscribe) {
        archeryAuditUnsubscribe();
        archeryAuditUnsubscribe = null;
    }
    if (!archeryCan('viewAuditTrail')) {
        archeryAuditLogsData = [];
        renderArcheryAuditTrail();
        return;
    }
    const q = query(
        collection(db, 'audit_logs'),
        where('branch_id', '==', archeryBranchId()),
        limit(120)
    );
    archeryAuditUnsubscribe = onSnapshot(q, (snapshot) => {
        archeryAuditLogsData = [];
        snapshot.forEach(docSnap => {
            archeryAuditLogsData.push({ id: docSnap.id, ...docSnap.data() });
        });
        renderArcheryAuditTrail();
    }, (error) => {
        console.error('Error listening to archery audit logs:', error);
        archeryAuditLogsData = [];
        renderArcheryAuditTrail();
    });
}

function setupRealtimeArcheryAdminData() {
    updateArcheryRoleVisibility();
    loadArcheryPageSettings();
    setupRealtimeArcheryBookings();
    setupRealtimeArcheryPayments();
    setupRealtimeArcheryWebhookEvents();
    setupRealtimeArcheryReconciliation();
    setupRealtimeArcheryAuditLogs();
}

window.refreshArcheryAdmin = () => {
    setupRealtimeArcheryAdminData();
};

// Real-time Bookings Listener
function setupRealtimeBookings() {
    if (bookingsUnsubscribe) {
        bookingsUnsubscribe();
        bookingsUnsubscribe = null;
    }
    const q = query(collection(db, "bookings"), orderBy("timestamp", "desc"));
    bookingsUnsubscribe = onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('bookings-table-body');
        const roomTbody = document.getElementById('room-bookings-table-body');
        if (!tbody || !roomTbody) return;
        tbody.innerHTML = '';
        roomTbody.innerHTML = '';

        let todayBookings = 0;
        let todayRoomBookings = 0;
        const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

        let hasTableBookings = false;
        let hasRoomBookings = false;
        const reportBookings = [];

        snapshot.forEach((docSnap) => {
            const booking = docSnap.data();
            const id = docSnap.id;
            reportBookings.push({ id, firestoreId: id, ...booking });
            if (isArcheryBooking(booking)) return;
            const status = booking.status || 'pending';
            const isRoom = booking.bookingType === 'room';
            const tableNo = booking.tableNo || '';
            
            if (booking.date === todayStr) {
                if (isRoom) todayRoomBookings++;
                else todayBookings++;
            }

            const tr = document.createElement('tr');
            
            if (!isRoom) {
                hasTableBookings = true;
                const zoneStr = booking.tableZone ? `<br><small class="text-muted">โซน/โต๊ะ: ${escapeHTML(booking.tableZone)}</small>` : '';
                tr.innerHTML = `
                    <td>${escapeHTML(booking.name || 'Customer')}${zoneStr}</td>
                    <td>${escapeHTML(booking.phone || '-')}</td>
                    <td>${escapeHTML(booking.guests || 1)} ท่าน</td>
                    <td>${escapeHTML(booking.date || '-')} เวลา ${escapeHTML(booking.startTime || booking.time || '-')}</td>
                    <td>
                        <input type="text" value="${escapeHTML(tableNo)}" placeholder="ระบุโต๊ะ" onchange="updateBookingTable('${escapeJSString(id)}', this.value)" style="padding: 5px; border-radius: 5px; border: 1px solid #ddd; width: 80px; text-align: center;">
                    </td>
                    <td>${getStatusBadgeHTML(status, 'booking')}</td>
                    <td>
                        <select onchange="updateBookingStatus('${escapeJSString(id)}', this.value)" style="padding: 5px; border-radius: 5px; border: 1px solid #ddd;">
                            <option value="pending" ${status === 'pending' ? 'selected' : ''}>รอคอนเฟิร์ม</option>
                            <option value="confirmed" ${status === 'confirmed' ? 'selected' : ''}>ยืนยันแล้ว</option>
                            <option value="completed" ${status === 'completed' ? 'selected' : ''}>ลูกค้าเข้าใช้บริการแล้ว</option>
                            <option value="cancelled" ${status === 'cancelled' ? 'selected' : ''}>ยกเลิก</option>
                        </select>
                    </td>
                `;
                tbody.appendChild(tr);
            } else {
                hasRoomBookings = true;
                let addOnsList = (booking.addons && booking.addons.length > 0) ? booking.addons.map(escapeHTML).join(', ') : '-';
                tr.innerHTML = `
                    <td>${escapeHTML(booking.name || 'Customer')}</td>
                    <td>${escapeHTML(booking.phone || '-')}</td>
                    <td>${escapeHTML(booking.guests || 1)} ท่าน</td>
                    <td>${escapeHTML(booking.date || '-')} เวลา ${escapeHTML(booking.startTime || '-')} - ${escapeHTML(booking.endTime || '-')}</td>
                    <td>${escapeHTML(booking.roomType ? booking.roomType : 'Not specified')}<br><small>Add-ons: ${addOnsList}</small></td>
                    <td>฿${escapeHTML(booking.price || '0')}</td>
                    <td>${getStatusBadgeHTML(status, 'booking')}</td>
                    <td>
                        <select onchange="updateBookingStatus('${escapeJSString(id)}', this.value)" style="padding: 5px; border-radius: 5px; border: 1px solid #ddd;">
                            <option value="pending" ${status === 'pending' ? 'selected' : ''}>รอคอนเฟิร์ม</option>
                            <option value="confirmed" ${status === 'confirmed' ? 'selected' : ''}>ยืนยันแล้ว</option>
                            <option value="completed" ${status === 'completed' ? 'selected' : ''}>ลูกค้าเข้าใช้บริการแล้ว</option>
                            <option value="cancelled" ${status === 'cancelled' ? 'selected' : ''}>ยกเลิก</option>
                        </select>
                    </td>
                `;
                roomTbody.appendChild(tr);
            }
        });

        if (!hasTableBookings) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">ไม่มีข้อมูลการจองโต๊ะ</td></tr>';
        }
        if (!hasRoomBookings) {
            roomTbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">ไม่มีข้อมูลการจองห้องรับรอง</td></tr>';
        }

        // Update Dashboard Stats (combine both or just show table bookings?)
        dashboardBookingsData = reportBookings;
        if (!archeryBookingsUnsubscribe) renderArcheryAdmin(reportBookings);
        renderAllBookings(reportBookings);
        renderDashboardSalesReport();
        document.getElementById('stat-bookings').innerText = todayBookings + todayRoomBookings;
    }, (error) => {
        console.error("Error listening to bookings:", error);
        const tbody = document.getElementById('bookings-table-body');
        const roomTbody = document.getElementById('room-bookings-table-body');
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:red;">ไม่มีสิทธิ์เข้าถึงข้อมูล หรือเกิดข้อผิดพลาด</td></tr>';
        if (roomTbody) roomTbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:red;">ไม่มีสิทธิ์เข้าถึงข้อมูล หรือเกิดข้อผิดพลาด</td></tr>';
    });
}

// Function to update Booking Table Number
async function updateBookingTable(bookingId, tableNo) {
    if (!confirm('ยืนยันการบันทึกหมายเลขโต๊ะ/ห้อง?')) return;
    try {
        const docRef = doc(db, "bookings", bookingId);
        await updateDoc(docRef, { tableNo: tableNo });
        alert('อัปเดตหมายเลขโต๊ะ/ห้องเรียบร้อย');
    } catch (error) {
        console.error("Error updating table number:", error);
        alert(safeAdminError("เกิดข้อผิดพลาด"));
    }
}
window.updateBookingTable = updateBookingTable;

// HTML Helper for Status Badges
function getPaymentStatusBadgeHTML(status = 'pending') {
    switch (String(status || 'pending').toLowerCase()) {
        case 'paid':
            return '<span class="status-badge status-completed">ชำระแล้ว</span>';
        case 'failed':
            return '<span class="status-badge status-cancelled">ชำระไม่สำเร็จ</span>';
        case 'refunded':
            return '<span class="status-badge status-cancelled">คืนเงินแล้ว</span>';
        case 'pending':
        default:
            return '<span class="status-badge status-pending">รอชำระ</span>';
    }
}

function getStatusBadgeHTML(status, type) {
    if (type === 'order') {
        switch(status) {
            case 'pending': return '<span class="status-badge status-pending">รอดำเนินการ</span>';
            case 'processing': return '<span class="status-badge status-processing">กำลังทำ</span>';
            case 'completed': return '<span class="status-badge status-completed">เสร็จสิ้น</span>';
            case 'cancelled': return '<span class="status-badge status-cancelled">ยกเลิก</span>';
            default: return '<span class="status-badge status-pending">รอดำเนินการ</span>';
        }
    } else {
        switch(status) {
            case 'pending': return '<span class="status-badge status-pending">รอคอนเฟิร์ม</span>';
            case 'confirmed': return '<span class="status-badge status-processing">ยืนยันแล้ว</span>';
            case 'completed': return '<span class="status-badge status-completed">เข้าใช้บริการแล้ว</span>';
            case 'cancelled': return '<span class="status-badge status-cancelled">ยกเลิก</span>';
            default: return '<span class="status-badge status-pending">รอคอนเฟิร์ม</span>';
        }
    }
}

function renderCategoriesSnapshot(snapshot) {
    const tbody = document.getElementById('categories-table-body');
    const select = document.getElementById('productCategory');
    if (tbody) tbody.innerHTML = '';
    if (select) select.innerHTML = '<option value="">-- เลือกหมวดหมู่ --</option>';
    categoriesData = {};

    if (snapshot.empty) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">ไม่มีข้อมูลหมวดหมู่</td></tr>';
        updateProductCategoryFilterOptions();
        renderProductsTable();
        renderDashboardSalesReport();
        return;
    }

    const sortedDocs = snapshot.docs.slice().sort((a, b) => {
        const aData = a.data();
        const bData = b.data();
        const aOrder = Number(aData.order || 999);
        const bOrder = Number(bData.order || 999);
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.id.localeCompare(b.id);
    });

    sortedDocs.forEach((docSnap) => {
        const cat = docSnap.data();
        const id = docSnap.id;
        categoriesData[id] = cat;
        const color = cat.color || '#ddd';
        const itemCount = cat.itemCount ? Number(cat.itemCount).toLocaleString() + ' items' : '';
        const orderText = cat.order ? 'Order ' + Number(cat.order).toLocaleString() : '';
        const metaText = [itemCount, orderText].filter(Boolean).join(' | ');

        if (tbody) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code>${escapeHTML(id)}</code></td>
                <td>
                    <div style="display:flex; align-items:center; gap:12px;">
                        <span style="display:inline-block; width:24px; height:24px; border-radius:50%; background:${escapeHTML(color)}; border:1px solid rgba(0,0,0,0.08); flex:0 0 auto;"></span>
                        <span>
                            <strong>${escapeHTML(cat.name)}</strong>
                            ${metaText ? `<br><small style="color:#777;">${escapeHTML(metaText)}</small>` : ''}
                        </span>
                    </div>
                </td>
                <td>
                    <button class="btn-action btn-edit" onclick="editCategory('${escapeJSString(id)}')"> แก้ไข</button>
                    <button class="btn-action btn-delete" onclick="deleteCategory('${escapeJSString(id)}')"> ลบ</button>
                </td>
            `;
            tbody.appendChild(tr);
        }

        if (select) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.innerText = cat.name;
            select.appendChild(opt);
        }
    });
    updateProductCategoryFilterOptions();
    renderProductsTable();
    renderDashboardSalesReport();
}

async function refreshCategoriesOnce() {
    const snapshot = await getDocs(query(collection(db, "categories")));
    renderCategoriesSnapshot(snapshot);
}

// Real-time Categories Listener
function setupRealtimeCategories() {
    if (categoriesUnsubscribe) {
        categoriesUnsubscribe();
        categoriesUnsubscribe = null;
    }
    const q = query(collection(db, "categories"));
    categoriesUnsubscribe = onSnapshot(q, renderCategoriesSnapshot, (error) => {
        console.error("Error listening to categories:", error);
    });
}

// Category Modal Logic
const categoryModal = document.getElementById('categoryModal');
const categoryForm = document.getElementById('categoryForm');

window.openCategoryModal = () => {
    categoryForm.reset();
    document.getElementById('categoryId').value = '';
    document.getElementById('catIdInput').disabled = false;
    document.getElementById('cat-modal-title').innerText = 'เพิ่มหมวดหมู่ใหม่';
    categoryModal.style.display = 'block';
};

window.closeCategoryModal = () => {
    categoryModal.style.display = 'none';
};

window.editCategory = (id) => {
    const cat = categoriesData[id];
    if (!cat) return;
    
    document.getElementById('categoryId').value = id;
    document.getElementById('catIdInput').value = id;
    document.getElementById('catIdInput').disabled = true; // Don't allow changing ID once created
    document.getElementById('catNameInput').value = cat.name || '';
    
    document.getElementById('cat-modal-title').innerText = 'แก้ไขหมวดหมู่';
    categoryModal.style.display = 'block';
};

window.deleteCategory = async (id) => {
    if (confirm("คุณแน่ใจหรือไม่ว่าต้องการลบหมวดหมู่นี้? (หากมีสินค้าในหมวดหมู่นี้อยู่ สินค้าเหล่านั้นจะไม่แสดงผลหมวดหมู่)")) {
        try {
            await deleteDoc(doc(db, "categories", id));
        } catch (e) {
            alert("ลบไม่สำเร็จ: " + e.message);
        }
    }
};

// Handle Category Form Submit
categoryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const hiddenId = document.getElementById('categoryId').value;
    const inputId = document.getElementById('catIdInput').value.trim().toLowerCase();
    const catName = document.getElementById('catNameInput').value.trim();
    
    if (!inputId) return alert("กรุณาระบุรหัสหมวดหมู่");
    
    try {
        const docRef = doc(db, "categories", inputId);
        await setDoc(docRef, { name: catName }, { merge: true });
        closeCategoryModal();
    } catch (error) {
        alert(safeAdminError("บันทึกไม่สำเร็จ"));
    }
});


// Manual Table Map Designer
const DEFAULT_TABLE_MAP_ITEMS = [
    { kind: 'zone', id: 'zone-indoor', name: 'Indoor', hint: 'Quiet AC seating', x: 5, y: 7, w: 37, h: 38 },
    { kind: 'zone', id: 'zone-outdoor', name: 'Outdoor', hint: 'Open-air cafe terrace', x: 48, y: 7, w: 47, h: 28 },
    { kind: 'zone', id: 'zone-garden', name: 'Garden', hint: 'Green wellness corner', x: 5, y: 52, w: 37, h: 39 },
    { kind: 'zone', id: 'zone-riverside', name: 'Riverside', hint: 'Relaxed scenic zone', x: 48, y: 43, w: 47, h: 22 },
    { kind: 'zone', id: 'zone-private', name: 'Private Zone', hint: 'Semi-private table area', x: 48, y: 71, w: 47, h: 20 },
    { kind: 'table', id: 'in-01', code: 'IN-01', name: 'IN-01', zone: 'Indoor', seats: 2, shape: 'round', x: 11, y: 20, status: 'available' },
    { kind: 'table', id: 'in-02', code: 'IN-02', name: 'IN-02', zone: 'Indoor', seats: 4, shape: 'rect', x: 24, y: 20, status: 'available' },
    { kind: 'table', id: 'in-03', code: 'IN-03', name: 'IN-03', zone: 'Indoor', seats: 4, shape: 'rect', x: 11, y: 34, status: 'booked' },
    { kind: 'table', id: 'in-04', code: 'IN-04', name: 'IN-04', zone: 'Indoor', seats: 6, shape: 'wide', x: 25, y: 34, status: 'available' },
    { kind: 'table', id: 'out-01', code: 'OUT-01', name: 'OUT-01', zone: 'Outdoor', seats: 2, shape: 'round', x: 55, y: 19, status: 'available' },
    { kind: 'table', id: 'out-02', code: 'OUT-02', name: 'OUT-02', zone: 'Outdoor', seats: 4, shape: 'rect', x: 69, y: 18, status: 'available' },
    { kind: 'table', id: 'out-03', code: 'OUT-03', name: 'OUT-03', zone: 'Outdoor', seats: 4, shape: 'rect', x: 83, y: 18, status: 'unavailable' },
    { kind: 'table', id: 'gd-01', code: 'GD-01', name: 'GD-01', zone: 'Garden', seats: 4, shape: 'rect', x: 11, y: 65, status: 'available' },
    { kind: 'table', id: 'gd-02', code: 'GD-02', name: 'GD-02', zone: 'Garden', seats: 4, shape: 'rect', x: 25, y: 65, status: 'available' },
    { kind: 'table', id: 'gd-03', code: 'GD-03', name: 'GD-03', zone: 'Garden', seats: 2, shape: 'round', x: 18, y: 80, status: 'available' },
    { kind: 'table', id: 'rs-01', code: 'RS-01', name: 'RS-01', zone: 'Riverside', seats: 4, shape: 'rect', x: 56, y: 53, status: 'available' },
    { kind: 'table', id: 'rs-02', code: 'RS-02', name: 'RS-02', zone: 'Riverside', seats: 4, shape: 'rect', x: 72, y: 53, status: 'booked' },
    { kind: 'table', id: 'rs-03', code: 'RS-03', name: 'RS-03', zone: 'Riverside', seats: 2, shape: 'round', x: 87, y: 53, status: 'available' },
    { kind: 'table', id: 'pv-01', code: 'PV-01', name: 'PV-01', zone: 'Private Zone', seats: 6, shape: 'wide', x: 57, y: 80, status: 'available' },
    { kind: 'table', id: 'pv-02', code: 'PV-02', name: 'PV-02', zone: 'Private Zone', seats: 6, shape: 'wide', x: 78, y: 80, status: 'available' }
];

function clampPercent(value, fallback = 0) {
    return Math.max(0, Math.min(100, safeNumber(value, fallback)));
}

function normalizeRotation(value, fallback = 0) {
    const number = safeNumber(value, fallback);
    return ((Math.round(number) % 360) + 360) % 360;
}

function normalizeMapItem(id, data = {}) {
    const kind = data.kind === 'zone' ? 'zone' : 'table';
    if (kind === 'zone') {
        return {
            id,
            kind,
            name: data.name || data.label || id,
            hint: data.hint || '',
            x: clampPercent(data.x, 5),
            y: clampPercent(data.y, 5),
            w: Math.max(5, Math.min(100, safeNumber(data.w, 30))),
            h: Math.max(5, Math.min(100, safeNumber(data.h, 25))),
            mapEnabled: data.mapEnabled !== false
        };
    }
    const code = data.code || id.toUpperCase();
    return {
        id,
        kind,
        code,
        name: data.name || code,
        zone: data.zone || data.tableZone || 'Indoor',
        seats: Math.max(1, safeNumber(data.seats || data.capacity, 4)),
        shape: ['round', 'rect', 'wide'].includes(data.shape) ? data.shape : 'rect',
        status: ['available', 'booked', 'unavailable'].includes(data.status) ? data.status : 'available',
        x: clampPercent(data.x, 10),
        y: clampPercent(data.y, 10),
        rotation: normalizeRotation(data.rotation, 0),
        mapEnabled: data.mapEnabled !== false && data.kind === 'table'
    };
}

function getMapItems() {
    return Object.entries(tablesData)
        .map(([id, data]) => normalizeMapItem(id, data))
        .filter(item => item.mapEnabled);
}

function updateZoneDatalist(items = getMapItems()) {
    const datalist = document.getElementById('table-zone-list');
    if (!datalist) return;
    const zones = [...new Set(items.filter(item => item.kind === 'zone').map(item => item.name))];
    datalist.innerHTML = zones.map(zone => '<option value="' + escapeHTML(zone) + '"></option>').join('');
}

function getSortedMapItems(items = getMapItems()) {
    return items.slice().sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'zone' ? -1 : 1;
        return (a.name || a.code || a.id).localeCompare(b.name || b.code || b.id, 'th');
    });
}

function updateTableZoneFilter(items = getMapItems()) {
    const filter = document.getElementById('table-zone-filter');
    if (!filter) return;
    const current = filter.value || 'all';
    const zones = [...new Set(items.map(item => item.kind === 'zone' ? item.name : item.zone).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'th'));
    filter.innerHTML = '<option value="all">ทุกโซน</option>' + zones.map(zone => '<option value="' + escapeHTML(zone) + '">' + escapeHTML(zone) + '</option>').join('');
    filter.value = current === 'all' || zones.includes(current) ? current : 'all';
}

function getFilteredMapItems(items = getSortedMapItems()) {
    const search = (document.getElementById('table-map-search')?.value || '').trim().toLowerCase();
    const kindFilter = document.getElementById('table-kind-filter')?.value || 'all';
    const zoneFilter = document.getElementById('table-zone-filter')?.value || 'all';
    const statusFilter = document.getElementById('table-status-filter')?.value || 'all';

    return items.filter(item => {
        if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
        if (zoneFilter !== 'all') {
            const itemZone = item.kind === 'zone' ? item.name : item.zone;
            if (itemZone !== zoneFilter) return false;
        }
        if (statusFilter !== 'all' && (item.kind !== 'table' || item.status !== statusFilter)) return false;
        if (!search) return true;
        const haystack = [
            item.id, item.kind, item.name, item.code, item.zone, item.status, item.hint, item.shape,
            item.seats, item.x, item.y, item.w, item.h, item.rotation
        ].filter(value => value !== undefined && value !== null).join(' ').toLowerCase();
        return haystack.includes(search);
    });
}

function bindTableMapControls() {
    if (tableMapControlsBound) return;
    tableMapControlsBound = true;

    const rerenderFromFirstPage = () => {
        tableMapCurrentPage = 1;
        renderTablesManagerView();
    };

    ['table-map-search', 'table-kind-filter', 'table-zone-filter', 'table-status-filter'].forEach(id => {
        const control = document.getElementById(id);
        if (!control) return;
        control.addEventListener(id === 'table-map-search' ? 'input' : 'change', rerenderFromFirstPage);
    });

    const pageSize = document.getElementById('table-page-size');
    pageSize?.addEventListener('change', () => {
        tableMapPageSize = pageSize.value;
        rerenderFromFirstPage();
    });

    document.getElementById('table-page-prev')?.addEventListener('click', () => {
        tableMapCurrentPage = Math.max(1, tableMapCurrentPage - 1);
        renderTablesManagerView();
    });

    document.getElementById('table-page-next')?.addEventListener('click', () => {
        tableMapCurrentPage += 1;
        renderTablesManagerView();
    });

    document.getElementById('table-page-input')?.addEventListener('change', (event) => {
        tableMapCurrentPage = Math.max(1, safeNumber(event.target.value, 1));
        renderTablesManagerView();
    });

    document.getElementById('table-filter-reset')?.addEventListener('click', () => {
        const search = document.getElementById('table-map-search');
        const kind = document.getElementById('table-kind-filter');
        const zone = document.getElementById('table-zone-filter');
        const status = document.getElementById('table-status-filter');
        const size = document.getElementById('table-page-size');
        if (search) search.value = '';
        if (kind) kind.value = 'all';
        if (zone) zone.value = 'all';
        if (status) status.value = 'all';
        if (size) size.value = '25';
        tableMapPageSize = 25;
        tableMapSelectedId = '';
        rerenderFromFirstPage();
    });

    document.querySelectorAll('[data-rotation-value]').forEach(button => {
        button.addEventListener('click', () => {
            const input = document.getElementById('tableRotation');
            if (input) input.value = normalizeRotation(button.dataset.rotationValue, 0);
        });
    });
}

function selectTableMapItem(id, options = {}) {
    tableMapSelectedId = id || '';
    renderTablesManagerView();
    if (options.openEditor && id) window.editTable(id);
}

function setMapDesignerSummary(message) {
    const summary = document.getElementById('admin-table-map-summary');
    if (summary) summary.textContent = message;
}

function getDragBoundsPercent(item, element, stage) {
    const stageRect = stage.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const widthPercent = item.kind === 'zone'
        ? safeNumber(item.w, 30)
        : (elementRect.width / stageRect.width) * 100;
    const heightPercent = item.kind === 'zone'
        ? safeNumber(item.h, 25)
        : (elementRect.height / stageRect.height) * 100;

    return {
        maxX: Math.max(0, 100 - widthPercent),
        maxY: Math.max(0, 100 - heightPercent)
    };
}

function attachMapDrag(element, item, stage) {
    element.title = 'ลากเพื่อย้ายตำแหน่ง แล้วปล่อยเมาส์เพื่อบันทึก';
    element.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();

        const stageRect = stage.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const offsetX = event.clientX - elementRect.left;
        const offsetY = event.clientY - elementRect.top;
        const bounds = getDragBoundsPercent(item, element, stage);
        const originalX = item.x;
        const originalY = item.y;
        let nextX = originalX;
        let nextY = originalY;
        let moved = false;

        element.classList.add('is-dragging');
        element.setPointerCapture?.(event.pointerId);
        setMapDesignerSummary('กำลังลาก ' + (item.kind === 'zone' ? 'โซน ' + item.name : 'โต๊ะ ' + item.code) + '...');

        const move = (moveEvent) => {
            moveEvent.preventDefault();
            const rawX = ((moveEvent.clientX - stageRect.left - offsetX) / stageRect.width) * 100;
            const rawY = ((moveEvent.clientY - stageRect.top - offsetY) / stageRect.height) * 100;
            nextX = Math.round(Math.max(0, Math.min(bounds.maxX, rawX)) * 10) / 10;
            nextY = Math.round(Math.max(0, Math.min(bounds.maxY, rawY)) * 10) / 10;
            moved = moved || Math.abs(nextX - originalX) > 0.05 || Math.abs(nextY - originalY) > 0.05;
            element.style.left = nextX + '%';
            element.style.top = nextY + '%';
            setMapDesignerSummary('ตำแหน่งใหม่: X ' + nextX + '% · Y ' + nextY + '% · ปล่อยเมาส์เพื่อบันทึก');
        };

        const end = async (endEvent) => {
            element.releasePointerCapture?.(endEvent.pointerId);
            element.classList.remove('is-dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', cancel);

            if (!moved) {
                selectTableMapItem(item.id, { openEditor: true });
                return;
            }

            try {
                setMapDesignerSummary('กำลังบันทึกตำแหน่ง X ' + nextX + '% · Y ' + nextY + '%...');
                await updateDoc(doc(db, 'tables', item.id), {
                    x: nextX,
                    y: nextY,
                    updatedAt: new Date().toISOString()
                });
                setMapDesignerSummary('บันทึกตำแหน่งแล้ว: X ' + nextX + '% · Y ' + nextY + '%');
            } catch (error) {
                console.error('Error updating map position:', error);
                alert(safeAdminError("บันทึกตำแหน่งไม่สำเร็จ"));
                renderTablesManagerView();
            }
        };

        const cancel = (cancelEvent) => {
            element.releasePointerCapture?.(cancelEvent.pointerId);
            element.classList.remove('is-dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', cancel);
            renderTablesManagerView();
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', cancel);
    });
}

function renderAdminTableMap(items = getMapItems()) {
    const preview = document.getElementById('admin-table-map-preview');
    const summary = document.getElementById('admin-table-map-summary');
    if (!preview) return;
    preview.innerHTML = '';
    const zones = items.filter(item => item.kind === 'zone');
    const tableItems = items.filter(item => item.kind === 'table');
    zones.forEach(zone => {
        const el = document.createElement('div');
        el.className = 'admin-map-zone' + (zone.id === tableMapSelectedId ? ' is-selected' : '');
        el.style.left = zone.x + '%';
        el.style.top = zone.y + '%';
        el.style.width = zone.w + '%';
        el.style.height = zone.h + '%';
        el.innerHTML = '<strong>' + escapeHTML(zone.name) + '</strong><small>' + escapeHTML(zone.hint || '') + '</small>';
        attachMapDrag(el, zone, preview);
        preview.appendChild(el);
    });
    tableItems.forEach(table => {
        const el = document.createElement('div');
        el.className = 'admin-map-table shape-' + table.shape + ' is-' + table.status + (table.id === tableMapSelectedId ? ' is-selected' : '');
        el.style.left = table.x + '%';
        el.style.top = table.y + '%';
        el.style.setProperty('--table-rotation', table.rotation + 'deg');
        el.innerHTML = '<span>' + escapeHTML(table.code) + '</span><small>' + escapeHTML(table.seats) + ' seats</small>';
        attachMapDrag(el, table, preview);
        preview.appendChild(el);
    });
    if (summary) summary.textContent = 'โซน ' + zones.length + ' รายการ · โต๊ะ ' + tableItems.length + ' ตัว · คลิก Preview เพื่อแก้ไขได้ทันที';
}

function renderTablesManagerView() {
    const tbody = document.getElementById('tables-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const allItems = getSortedMapItems();
    if (tableMapSelectedId && !allItems.some(item => item.id === tableMapSelectedId)) {
        tableMapSelectedId = '';
    }
    updateTableZoneFilter(allItems);
    updateZoneDatalist(allItems);
    renderAdminTableMap(allItems);

    if (allItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">ยังไม่มีแผนผังโต๊ะ กด “ใช้แผนผังเริ่มต้น” เพื่อเริ่มได้เลย</td></tr>';
        const summary = document.getElementById('table-list-summary');
        if (summary) summary.textContent = 'ยังไม่มีรายการ';
        const pageInput = document.getElementById('table-page-input');
        const pageTotal = document.getElementById('table-page-total');
        const prev = document.getElementById('table-page-prev');
        const next = document.getElementById('table-page-next');
        if (pageInput) pageInput.value = 1;
        if (pageTotal) pageTotal.textContent = 'จาก 1';
        if (prev) prev.disabled = true;
        if (next) next.disabled = true;
        return;
    }

    const filteredItems = getFilteredMapItems(allItems);
    const pageSizeControl = document.getElementById('table-page-size');
    const rawPageSize = pageSizeControl?.value || String(tableMapPageSize || 25);
    const showAll = rawPageSize === 'all';
    const pageSize = showAll ? Math.max(1, filteredItems.length) : Math.max(1, safeNumber(rawPageSize, 25));
    const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
    tableMapCurrentPage = Math.max(1, Math.min(totalPages, tableMapCurrentPage));
    const start = showAll ? 0 : (tableMapCurrentPage - 1) * pageSize;
    const pageItems = filteredItems.slice(start, start + pageSize);

    if (filteredItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">ไม่พบรายการที่ตรงกับตัวกรอง</td></tr>';
    }

    pageItems.forEach(item => {
        const tr = document.createElement('tr');
        const isZone = item.kind === 'zone';
        tr.className = 'map-admin-row' + (item.id === tableMapSelectedId ? ' is-selected' : '');
        tr.dataset.mapItemId = item.id;
        tr.innerHTML = '<td><span class="map-admin-pill ' + (isZone ? 'zone' : '') + '">' + (isZone ? 'โซน' : 'โต๊ะ') + '</span></td>'
            + '<td><strong>' + escapeHTML(isZone ? item.name : item.code) + '</strong><br><small class="text-muted">' + escapeHTML(item.id) + '</small></td>'
            + '<td>' + (isZone ? escapeHTML(item.hint || '-') : escapeHTML(item.zone) + '<br><small>' + escapeHTML(item.status) + '</small>') + '</td>'
            + '<td>X ' + escapeHTML(item.x) + '% · Y ' + escapeHTML(item.y) + '%</td>'
            + '<td>' + (isZone ? 'W ' + escapeHTML(item.w) + '% · H ' + escapeHTML(item.h) + '%' : escapeHTML(item.seats) + ' seats · ' + escapeHTML(item.shape)) + '</td>'
            + '<td>' + (isZone ? '-' : escapeHTML(item.rotation) + '°') + '</td>'
            + '<td><div class="map-admin-row-actions"><button class="btn-action btn-edit" onclick="editTable(\'' + escapeJSString(item.id) + '\')">แก้ไข</button>'
            + '<button class="btn-action btn-delete" onclick="deleteTable(\'' + escapeJSString(item.id) + '\')">ลบ</button></div></td>';
        tr.addEventListener('click', (event) => {
            if (event.target.closest('button')) return;
            selectTableMapItem(item.id);
        });
        tbody.appendChild(tr);
    });

    const summary = document.getElementById('table-list-summary');
    if (summary) {
        if (filteredItems.length === 0) {
            summary.textContent = 'ไม่พบรายการจากทั้งหมด ' + allItems.length.toLocaleString('th-TH') + ' รายการ';
        } else {
            const end = Math.min(start + pageItems.length, filteredItems.length);
            summary.textContent = 'แสดง ' + (start + 1).toLocaleString('th-TH') + '-' + end.toLocaleString('th-TH') + ' จาก ' + filteredItems.length.toLocaleString('th-TH') + ' รายการ (ทั้งหมด ' + allItems.length.toLocaleString('th-TH') + ')';
        }
    }

    const pageInput = document.getElementById('table-page-input');
    const pageTotal = document.getElementById('table-page-total');
    const prev = document.getElementById('table-page-prev');
    const next = document.getElementById('table-page-next');
    if (pageInput) {
        pageInput.value = tableMapCurrentPage;
        pageInput.max = totalPages;
        pageInput.disabled = showAll;
    }
    if (pageTotal) pageTotal.textContent = 'จาก ' + totalPages.toLocaleString('th-TH');
    if (prev) prev.disabled = showAll || tableMapCurrentPage <= 1;
    if (next) next.disabled = showAll || tableMapCurrentPage >= totalPages;
}

function renderTablesManager(snapshot) {
    tablesData = {};
    snapshot.forEach((docSnap) => { tablesData[docSnap.id] = docSnap.data(); });
    renderTablesManagerView();
}

function setupRealtimeTables() {
    bindTableMapControls();
    if (tablesUnsubscribe) {
        tablesUnsubscribe();
        tablesUnsubscribe = null;
    }
    const q = query(collection(db, 'tables'));
    tablesUnsubscribe = onSnapshot(q, renderTablesManager, (error) => {
        console.error('Error listening to table map:', error);
        const tbody = document.getElementById('tables-table-body');
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:red;">โหลดข้อมูลแผนผังไม่สำเร็จ</td></tr>';
    });
}

const tableModal = document.getElementById('tableModal');
const tableForm = document.getElementById('tableForm');

function setMapModalMode(kind) {
    const isZone = kind === 'zone';
    document.getElementById('mapItemKind').value = isZone ? 'zone' : 'table';
    document.querySelectorAll('.table-only-field').forEach(el => el.style.display = isZone ? 'none' : 'block');
    document.querySelectorAll('.zone-only-field').forEach(el => el.style.display = isZone ? 'block' : 'none');
    document.getElementById('table-modal-title').innerText = isZone ? 'เพิ่ม/แก้ไขโซน' : 'เพิ่ม/แก้ไขโต๊ะ';
}

function resetTableModal(kind = 'table') {
    tableForm.reset();
    document.getElementById('tableId').value = '';
    document.getElementById('tableCode').readOnly = false;
    document.getElementById('tableSeats').value = 4;
    document.getElementById('tableShape').value = 'rect';
    document.getElementById('tableStatus').value = 'available';
    document.getElementById('tableRotation').value = 0;
    document.getElementById('tableX').value = 10;
    document.getElementById('tableY').value = 10;
    document.getElementById('zoneW').value = 35;
    document.getElementById('zoneH').value = 30;
    setMapModalMode(kind);
}

window.openTableModal = () => {
    resetTableModal('table');
    document.getElementById('tableSubmitBtn').innerText = 'บันทึกโต๊ะ';
    tableModal.style.display = 'block';
};

window.openZoneModal = () => {
    resetTableModal('zone');
    document.getElementById('tableSubmitBtn').innerText = 'บันทึกโซน';
    tableModal.style.display = 'block';
};

window.closeTableModal = () => { tableModal.style.display = 'none'; };

window.editTable = (id) => {
    const raw = tablesData[id];
    if (!raw) return;
    const item = normalizeMapItem(id, raw);
    if (tableMapSelectedId !== id) {
        tableMapSelectedId = id;
        renderTablesManagerView();
    }
    resetTableModal(item.kind);
    document.getElementById('tableId').value = id;
    document.getElementById('tableCode').value = id;
    document.getElementById('tableCode').readOnly = true;
    document.getElementById('tableName').value = item.name || item.code || '';
    document.getElementById('tableX').value = item.x;
    document.getElementById('tableY').value = item.y;
    if (item.kind === 'zone') {
        document.getElementById('zoneHint').value = item.hint || '';
        document.getElementById('zoneW').value = item.w;
        document.getElementById('zoneH').value = item.h;
    } else {
        document.getElementById('tableZone').value = item.zone || '';
        document.getElementById('tableSeats').value = item.seats || 4;
        document.getElementById('tableShape').value = item.shape || 'rect';
        document.getElementById('tableStatus').value = item.status || 'available';
        document.getElementById('tableRotation').value = item.rotation || 0;
    }
    document.getElementById('tableSubmitBtn').innerText = item.kind === 'zone' ? 'บันทึกโซน' : 'บันทึกโต๊ะ';
    tableModal.style.display = 'block';
};

window.deleteTable = async (id) => {
    if (!confirm('ยืนยันการลบรายการนี้ออกจากแผนผัง?')) return;
    try {
        await deleteDoc(doc(db, 'tables', id));
        alert('ลบรายการเรียบร้อย');
    } catch (e) {
        alert('ลบไม่สำเร็จ: ' + e.message);
    }
};

window.seedDefaultTableMap = async () => {
    if (!confirm('ต้องการสร้าง/อัปเดตแผนผังเริ่มต้นหรือไม่? ข้อมูลรหัสเดิมที่ตรงกันจะถูกอัปเดต')) return;
    try {
        await Promise.all(DEFAULT_TABLE_MAP_ITEMS.map(item => {
            const id = item.id;
            const data = { ...item, code: item.kind === 'table' ? item.code : id, mapEnabled: true, updatedAt: new Date().toISOString() };
            return setDoc(doc(db, 'tables', id), data, { merge: true });
        }));
        alert('สร้างแผนผังเริ่มต้นเรียบร้อย');
    } catch (error) {
        alert(safeAdminError("สร้างแผนผังไม่สำเร็จ"));
    }
};

tableForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('tableSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerText = 'กำลังบันทึก...';
    const kind = document.getElementById('mapItemKind').value === 'zone' ? 'zone' : 'table';
    const code = document.getElementById('tableCode').value.trim().toLowerCase();
    const name = document.getElementById('tableName').value.trim();
    const isNew = !document.getElementById('tableId').value;
    try {
        if (!code || !name) throw new Error('กรุณากรอกรหัสและชื่อ');
        let itemData;
        if (kind === 'zone') {
            itemData = {
                kind: 'zone', name, label: name,
                hint: document.getElementById('zoneHint').value.trim(),
                x: clampPercent(document.getElementById('tableX').value, 5),
                y: clampPercent(document.getElementById('tableY').value, 5),
                w: Math.max(5, Math.min(100, safeNumber(document.getElementById('zoneW').value, 35))),
                h: Math.max(5, Math.min(100, safeNumber(document.getElementById('zoneH').value, 30))),
                mapEnabled: true, updatedAt: new Date().toISOString()
            };
        } else {
            const displayCode = document.getElementById('tableCode').value.trim().toUpperCase();
            itemData = {
                kind: 'table', code: displayCode, name: name || displayCode,
                zone: document.getElementById('tableZone').value.trim() || 'Indoor',
                seats: Math.max(1, safeNumber(document.getElementById('tableSeats').value, 4)),
                shape: document.getElementById('tableShape').value,
                status: document.getElementById('tableStatus').value,
                rotation: normalizeRotation(document.getElementById('tableRotation').value, 0),
                x: clampPercent(document.getElementById('tableX').value, 10),
                y: clampPercent(document.getElementById('tableY').value, 10),
                mapEnabled: true, updatedAt: new Date().toISOString()
            };
        }
        if (isNew) itemData.createdAt = new Date().toISOString();
        await setDoc(doc(db, 'tables', code), itemData, { merge: !isNew });
        alert('บันทึกแผนผังเรียบร้อย');
        closeTableModal();
    } catch (error) {
        console.error('Error saving table map item:', error);
        alert(safeAdminError("บันทึกไม่สำเร็จ"));
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = kind === 'zone' ? 'บันทึกโซน' : 'บันทึกโต๊ะ';
    }
});

// Real-time Rooms Listener
function setupRealtimeRooms() {
    if (roomsUnsubscribe) {
        roomsUnsubscribe();
        roomsUnsubscribe = null;
    }
    const q = query(collection(db, "rooms"), orderBy("price"));
    roomsUnsubscribe = onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('rooms-table-body');
        tbody.innerHTML = '';
        roomsData = {};
        
        if (snapshot.empty) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">ไม่มีข้อมูลห้องรับรอง</td></tr>';
            return;
        }

        snapshot.forEach((docSnap) => {
            const room = docSnap.data();
            const id = docSnap.id;
            roomsData[id] = room; // Store locally for edit modal
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><img loading="lazy" src="${safeImageURL(room.imageUrl, 'Images/Logo.webp')}" alt="${escapeHTML(room.name)}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px;"></td>
                <td><strong>${escapeHTML(room.name)}</strong><br><small class="text-muted">${escapeHTML(id)}</small></td>
                <td>${escapeHTML(room.capacity)} ท่าน</td>
                <td>฿${escapeHTML(room.price)}/ชม.</td>
                <td>${escapeHTML(room.amount)} ห้อง</td>
                <td>
                    <button class="btn-action btn-edit" onclick="editRoom('${escapeJSString(id)}')"> แก้ไข</button>
                    <button class="btn-action btn-delete" onclick="deleteRoom('${escapeJSString(id)}')"> ลบ</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }, (error) => {
        console.error("Error listening to rooms:", error);
    });
}

// Room Modal Logic
const roomModal = document.getElementById('roomModal');
const roomForm = document.getElementById('roomForm');

window.openRoomModal = () => {
    roomForm.reset();
    document.getElementById('roomId').value = '';
    document.getElementById('roomCode').readOnly = false;
    document.getElementById('roomImageUrl').value = '';
    document.getElementById('room-modal-title').innerText = 'เพิ่มห้องรับรอง';
    document.getElementById('roomSubmitBtn').innerText = 'บันทึกข้อมูลห้อง';
    roomModal.style.display = 'block';
};

window.closeRoomModal = () => {
    roomModal.style.display = 'none';
};

window.editRoom = (id) => {
    const room = roomsData[id];
    if (!room) return;
    
    document.getElementById('roomId').value = id;
    document.getElementById('roomCode').value = id;
    document.getElementById('roomCode').readOnly = true;
    document.getElementById('roomName').value = room.name || '';
    document.getElementById('roomCapacity').value = room.capacity || '';
    document.getElementById('roomPrice').value = room.price || 0;
    document.getElementById('roomAmount').value = room.amount || 1;
    document.getElementById('roomImageUrl').value = room.imageUrl || '';
    
    document.getElementById('room-modal-title').innerText = 'แก้ไขห้องรับรอง';
    document.getElementById('roomSubmitBtn').innerText = 'บันทึกการแก้ไข';
    roomModal.style.display = 'block';
};

window.deleteRoom = async (id) => {
    if (confirm("คุณแน่ใจหรือไม่ว่าต้องการลบห้องนี้? ข้อมูลการจองที่ผูกกับห้องนี้อาจได้รับผลกระทบ")) {
        try {
            await deleteDoc(doc(db, "rooms", id));
            alert('ลบห้องรับรองเรียบร้อย');
        } catch (e) {
            alert("ลบไม่สำเร็จ: " + e.message);
        }
    }
};

roomForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const submitBtn = document.getElementById('roomSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerText = 'กำลังบันทึก...';

    const code = document.getElementById('roomCode').value.trim().toLowerCase();
    const isNew = !document.getElementById('roomId').value;
    
    try {
        let finalImageUrl = document.getElementById('roomImageUrl').value;
        const fileInput = document.getElementById('roomImageFile');
        
        // Handle Image Upload
        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            submitBtn.innerText = 'กำลังอัปโหลดรูป...';
            
            // Convert and upload to Spaceship hosting
            submitBtn.innerText = 'กำลังแปลงรูปภาพ...';
            const webpBlob = await compressToWebP(file, 0.8);
            submitBtn.innerText = 'กำลังอัปโหลดรูปภาพ...';
            finalImageUrl = await uploadAdminImage(webpBlob, 'rooms', code + '_' + Date.now() + '.webp');
        }

        const roomData = {
            name: document.getElementById('roomName').value,
            capacity: document.getElementById('roomCapacity').value,
            price: Number(document.getElementById('roomPrice').value),
            amount: Number(document.getElementById('roomAmount').value),
            imageUrl: finalImageUrl,
            updatedAt: new Date().toISOString()
        };

        if (isNew) {
            roomData.createdAt = new Date().toISOString();
            await setDoc(doc(db, "rooms", code), roomData);
            alert('เพิ่มห้องรับรองเรียบร้อย');
        } else {
            await updateDoc(doc(db, "rooms", code), roomData);
            alert('บันทึกการแก้ไขเรียบร้อย');
        }

        closeRoomModal();
    } catch (error) {
        console.error("Error saving room:", error);
        alert(safeAdminError("เกิดข้อผิดพลาด"));
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = 'บันทึกข้อมูลห้อง';
    }
});

function categoryNameForProduct(product = {}) {
    const category = product.category || '';
    return categoriesData[category]?.name || category || '-';
}

function productSearchHaystack(row) {
    const product = row.product || {};
    return [
        row.id,
        product.name,
        product.nameEn,
        product.sku,
        product.handle,
        product.barcode,
        product.category,
        categoryNameForProduct(product),
        ...productVariantsForDisplay(product).flatMap(variant => [variant.name, variant.sku])
    ].filter(Boolean).join(' ').toLowerCase();
}

function productStockText(product = {}) {
    if (!product.trackStock) return { text: '-', className: 'menu-muted' };
    const stock = safeNumber(product.stock);
    const lowStock = safeNumber(product.lowStock);
    if (stock <= 0) return { text: '0', className: 'menu-stock-out' };
    if (lowStock > 0 && stock <= lowStock) return { text: stock.toLocaleString(), className: 'menu-stock-low' };
    return { text: stock.toLocaleString(), className: '' };
}

function productMatchesStockFilter(product = {}, filter) {
    const stock = safeNumber(product.stock);
    const lowStock = safeNumber(product.lowStock);
    if (filter === 'tracked') return !!product.trackStock;
    if (filter === 'untracked') return !product.trackStock;
    if (filter === 'out') return !!product.trackStock && stock <= 0;
    if (filter === 'low') return !!product.trackStock && lowStock > 0 && stock > 0 && stock <= lowStock;
    return true;
}

function productMargin(product = {}) {
    const price = safeNumber(product.price);
    const cost = safeNumber(product.cost);
    if (!price || !cost) return { text: '-', className: 'menu-muted' };
    const margin = ((price - cost) / price) * 100;
    return {
        text: margin.toFixed(2) + '%',
        className: margin >= 45 ? 'menu-margin-good' : 'menu-margin-warn'
    };
}

function productVariantsForDisplay(product = {}) {
    if (Array.isArray(product.variants) && product.variants.length) {
        return product.variants.map((variant, index) => normalizeProductVariant(variant, index, product));
    }
    const optionVariants = Array.isArray(product.options)
        ? product.options.filter(option => option?.value).map((option, index) => normalizeProductVariant({
            id: variantIdFromName(option.value, index),
            name: option.value,
            price: product.price,
            cost: product.cost,
            sku: index === 0 ? product.sku : '',
            stock: product.stock,
            lowStock: product.lowStock,
            availableForSale: product.availableForSale
        }, index, product))
        : [];
    return optionVariants;
}

function productVariantSummaryText(product = {}) {
    const variants = productVariantsForDisplay(product);
    return variants.length ? ` | ${variants.length} variants` : '';
}

function renderProductVariantDetailRow(id, product = {}) {
    const variants = productVariantsForDisplay(product);
    const soldByLabel = {
        each: 'แต่ละ / ชิ้น',
        weight: 'น้ำหนัก',
        volume: 'ปริมาณ'
    }[product.soldBy || (product.soldByWeight ? 'weight' : 'each')] || 'แต่ละ / ชิ้น';
    const visibility = [
        product.showOnWebsite !== false ? 'แสดงในเมนูเว็บ' : 'ซ่อนจากเมนูเว็บ',
        product.showInShop ? 'แสดงในร้านค้า' : 'ไม่แสดงในร้านค้า',
        product.showOnIndex || product.isFeatured ? 'สินค้าแนะนำหน้าแรก' : 'ไม่แสดงหน้าแรก',
        product.showOnPos !== false ? 'แสดงบน POS' : 'ซ่อนจาก POS',
        product.taxEnabled !== false ? 'ภาษี 7%' : 'ไม่คิดภาษี'
    ].join(' · ');
    const variantRows = variants.length ? variants.map((variant) => {
        const statusClass = variant.availableForSale === false ? 'menu-status-off' : 'menu-status-on';
        const statusText = variant.availableForSale === false ? 'ปิดขาย' : 'เปิดขาย';
        return `
            <tr>
                <td><span class="menu-status-pill ${statusClass}">${statusText}</span></td>
                <td><strong>${escapeHTML(variant.name)}</strong></td>
                <td>${productMoney(variant.price)}</td>
                <td>${productMoney(variant.cost)}</td>
                <td>${escapeHTML(variant.sku || '-')}</td>
                <td>${Number.isFinite(Number(variant.stock)) ? safeNumber(variant.stock).toLocaleString('th-TH') : '-'}</td>
                <td>${Number.isFinite(Number(variant.lowStock)) ? safeNumber(variant.lowStock).toLocaleString('th-TH') : '-'}</td>
            </tr>
        `;
    }).join('') : '<tr><td colspan="7" class="menu-muted">ยังไม่มีตัวแปรสินค้า กด Edit เพื่อเพิ่มตัวแปรแบบ เย็น/ร้อน/ปั่น ได้เลย</td></tr>';

    return `
        <tr class="menu-variant-detail-row" data-detail-for="${escapeHTML(id)}">
            <td colspan="8">
                <div class="menu-variant-panel">
                    <h4>รายละเอียดเพิ่มเติม: ${escapeHTML(soldByLabel)} · ${escapeHTML(visibility)}</h4>
                    <table class="menu-variant-mini-table">
                        <thead>
                            <tr>
                                <th>สถานะ</th>
                                <th>ตัวแปร</th>
                                <th>ราคาขาย</th>
                                <th>ต้นทุน</th>
                                <th>SKU</th>
                                <th>สต็อก</th>
                                <th>สต็อกต่ำ</th>
                            </tr>
                        </thead>
                        <tbody>${variantRows}</tbody>
                    </table>
                </div>
            </td>
        </tr>
    `;
}

function productCategoryOptions(currentCategory = '') {
    const knownIds = new Set(Object.keys(categoriesData));
    const options = [];
    if (currentCategory && !knownIds.has(currentCategory)) {
        options.push(`<option value="${escapeHTML(currentCategory)}">${escapeHTML(currentCategory)} (current)</option>`);
    }
    Object.entries(categoriesData)
        .sort(([, a], [, b]) => {
            const aOrder = Number(a.order || 999);
            const bOrder = Number(b.order || 999);
            if (aOrder !== bOrder) return aOrder - bOrder;
            return String(a.name || '').localeCompare(String(b.name || ''), 'th');
        })
        .forEach(([id, cat]) => {
            options.push(`<option value="${escapeHTML(id)}" ${id === currentCategory ? 'selected' : ''}>${escapeHTML(cat.name || id)}</option>`);
        });
    return options.join('');
}

function productMoney(value) {
    const amount = safeNumber(value);
    return amount ? '&#3647;' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
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

function filteredProductRows() {
    const category = document.getElementById('product-category-filter')?.value || 'all';
    const stockFilter = document.getElementById('product-stock-filter')?.value || 'all';
    const search = (document.getElementById('product-search-input')?.value || '').trim().toLowerCase();
    return productRows
        .filter(row => category === 'all' || row.product.category === category)
        .filter(row => productMatchesStockFilter(row.product, stockFilter))
        .filter(row => !search || productSearchHaystack(row).includes(search))
        .sort((a, b) => String(a.product.name || '').localeCompare(String(b.product.name || ''), 'th'));
}

function updateProductCategoryFilterOptions() {
    const filter = document.getElementById('product-category-filter');
    if (!filter) return;
    const currentValue = filter.value || 'all';
    const rowsByOrder = Object.entries(categoriesData)
        .sort(([, a], [, b]) => {
            const aOrder = Number(a.order || 999);
            const bOrder = Number(b.order || 999);
            if (aOrder !== bOrder) return aOrder - bOrder;
            return String(a.name || '').localeCompare(String(b.name || ''), 'th');
        });
    filter.innerHTML = '<option value="all">รายการทั้งหมด</option>' + rowsByOrder
        .map(([id, cat]) => `<option value="${escapeHTML(id)}">${escapeHTML(cat.name || id)}</option>`)
        .join('');
    filter.value = rowsByOrder.some(([id]) => id === currentValue) ? currentValue : 'all';
}

function updateProductSelectionUI(pageRows = []) {
    const countEl = document.getElementById('product-selected-count');
    const selectAll = document.getElementById('product-select-all');
    if (countEl) {
        countEl.textContent = selectedProductIds.size + ' selected';
        countEl.style.display = selectedProductIds.size ? 'inline-flex' : 'none';
    }
    if (selectAll) {
        const pageIds = pageRows.map(row => row.id);
        const selectedOnPage = pageIds.filter(id => selectedProductIds.has(id)).length;
        selectAll.checked = pageIds.length > 0 && selectedOnPage === pageIds.length;
        selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIds.length;
    }
}

function renderProductsTable() {
    const tbody = document.getElementById('products-table-body');
    if (!tbody) return;
    bindProductManagerControls();
    updateProductCategoryFilterOptions();

    const rows = filteredProductRows();
    const totalPages = Math.max(1, Math.ceil(rows.length / productPageSize));
    productCurrentPage = Math.max(1, Math.min(productCurrentPage, totalPages));
    const start = (productCurrentPage - 1) * productPageSize;
    const pageRows = rows.slice(start, start + productPageSize);

    if (!pageRows.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px;">No menu items match the selected filters.</td></tr>';
    } else {
        tbody.innerHTML = pageRows.map(({ id, product }) => {
            const catName = categoryNameForProduct(product);
            const stock = productStockText(product);
            const margin = productMargin(product);
            const available = product.availableForSale !== false;
            const itemName = product.name || product.nameTh || product.nameEn || id;
            const isExpanded = expandedProductIds.has(id);
            const hiddenNotes = [
                available ? '' : 'Hidden from sale',
                product.showOnWebsite === false ? 'Hidden from website' : '',
                product.showOnIndex || product.isFeatured ? 'Featured on Index' : '',
                product.showOnPos === false ? 'Hidden from POS' : ''
            ].filter(Boolean).join(' | ');
            const mainRow = `
                <tr>
                    <td class="menu-check-cell"><input type="checkbox" class="product-row-check" data-id="${escapeHTML(id)}" ${selectedProductIds.has(id) ? 'checked' : ''}></td>
                    <td>
                        <div class="menu-item-name">
                            <button class="menu-row-toggle" type="button" data-id="${escapeHTML(id)}" aria-label="Toggle variants">${isExpanded ? 'âŒƒ' : 'âŒ„'}</button>
                            <img loading="lazy" class="menu-item-thumb" src="${safeImageURL(product.imageUrl)}" alt="${escapeHTML(itemName)}">
                            <span class="menu-item-title">
                                <strong>${escapeHTML(itemName)}</strong>
                                <small>${escapeHTML(product.sku || product.handle || id)}${escapeHTML(productVariantSummaryText(product))}${hiddenNotes ? ' | ' + escapeHTML(hiddenNotes) : ''}</small>
                            </span>
                        </div>
                    </td>
                    <td>
                        <select class="menu-inline-category" data-id="${escapeHTML(id)}" aria-label="Change category for ${escapeHTML(itemName)}">
                            ${productCategoryOptions(product.category || '')}
                        </select>
                    </td>
                    <td>${productMoney(product.price)}</td>
                    <td>${productMoney(product.cost)}</td>
                    <td><span class="${margin.className}">${escapeHTML(margin.text)}</span></td>
                    <td><span class="${stock.className}">${escapeHTML(stock.text)}</span></td>
                    <td>
                        <button class="btn-action btn-edit" onclick="editProduct('${escapeJSString(id)}')">Edit</button>
                        <button class="btn-action btn-delete" onclick="deleteProduct('${escapeJSString(id)}')">Delete</button>
                    </td>
                </tr>
            `;
            return mainRow + (isExpanded ? renderProductVariantDetailRow(id, product) : '');
        }).join('');
    }

    const pageInput = document.getElementById('product-page-input');
    const totalEl = document.getElementById('product-page-total');
    const countEl = document.getElementById('product-filter-count');
    const prev = document.getElementById('product-page-prev');
    const next = document.getElementById('product-page-next');
    if (pageInput) pageInput.value = productCurrentPage;
    if (totalEl) totalEl.textContent = 'จาก ' + totalPages.toLocaleString('th-TH');
    if (countEl) countEl.textContent = rows.length.toLocaleString('th-TH') + ' รายการ';
    if (prev) prev.disabled = productCurrentPage <= 1;
    if (next) next.disabled = productCurrentPage >= totalPages;
    updateProductSelectionUI(pageRows);
}

function bindProductManagerControls() {
    if (productControlsBound) return;
    const categoryFilter = document.getElementById('product-category-filter');
    const stockFilter = document.getElementById('product-stock-filter');
    const searchInput = document.getElementById('product-search-input');
    const pageInput = document.getElementById('product-page-input');
    const pageSize = document.getElementById('product-page-size');
    const prev = document.getElementById('product-page-prev');
    const next = document.getElementById('product-page-next');
    const selectAll = document.getElementById('product-select-all');
    const tbody = document.getElementById('products-table-body');
    const upload = document.getElementById('product-xlsx-upload');

    [categoryFilter, stockFilter, searchInput].forEach(el => {
        if (!el) return;
        el.addEventListener('input', () => {
            productCurrentPage = 1;
            renderProductsTable();
        });
        el.addEventListener('change', () => {
            productCurrentPage = 1;
            renderProductsTable();
        });
    });
    if (pageInput) {
        pageInput.addEventListener('change', () => {
            productCurrentPage = Math.max(1, safeNumber(pageInput.value, 1));
            renderProductsTable();
        });
    }
    if (pageSize) {
        pageSize.addEventListener('change', () => {
            productPageSize = Math.max(1, safeNumber(pageSize.value, 10));
            productCurrentPage = 1;
            renderProductsTable();
        });
    }
    if (prev) prev.addEventListener('click', () => { productCurrentPage -= 1; renderProductsTable(); });
    if (next) next.addEventListener('click', () => { productCurrentPage += 1; renderProductsTable(); });
    if (selectAll) {
        selectAll.addEventListener('change', () => {
            const rows = filteredProductRows();
            const start = (productCurrentPage - 1) * productPageSize;
            rows.slice(start, start + productPageSize).forEach(row => {
                if (selectAll.checked) selectedProductIds.add(row.id);
                else selectedProductIds.delete(row.id);
            });
            renderProductsTable();
        });
    }
    if (tbody) {
        tbody.addEventListener('change', event => {
            const checkbox = event.target.closest('.product-row-check');
            if (checkbox) {
                if (checkbox.checked) selectedProductIds.add(checkbox.dataset.id);
                else selectedProductIds.delete(checkbox.dataset.id);
                updateProductSelectionUI(filteredProductRows().slice((productCurrentPage - 1) * productPageSize, productCurrentPage * productPageSize));
                return;
            }

            const categorySelect = event.target.closest('.menu-inline-category');
            if (categorySelect) {
                updateProductCategoryInline(categorySelect.dataset.id, categorySelect.value, categorySelect);
            }
        });
        tbody.addEventListener('click', event => {
            const toggle = event.target.closest('.menu-row-toggle');
            if (!toggle) return;
            const id = toggle.dataset.id;
            if (!id) return;
            if (expandedProductIds.has(id)) expandedProductIds.delete(id);
            else expandedProductIds.add(id);
            renderProductsTable();
        });
    }
    if (upload) {
        upload.addEventListener('change', async () => {
            if (!upload.files?.[0]) return;
            try {
                const result = await uploadCategoryDataFromXLSX('products', upload.files[0]);
                alert(`Upload complete: ${result.total} rows (created ${result.created}, updated ${result.updated})`);
            } catch (error) {
                alert(safeAdminError('Upload failed'));
            } finally {
                upload.value = '';
            }
        });
    }
    productControlsBound = true;
}

async function updateProductCategoryInline(productId, categoryId, selectEl) {
    if (!productId || !categoryId) return;
    const product = productsData[productId];
    const previousValue = product?.category || '';
    if (previousValue === categoryId) return;
    try {
        if (selectEl) {
            selectEl.disabled = true;
            selectEl.classList.add('is-saving');
        }
        await updateDoc(doc(db, "products", productId), {
            category: categoryId,
            updatedAt: new Date().toISOString()
        });
        if (productsData[productId]) productsData[productId].category = categoryId;
    } catch (error) {
        if (selectEl) selectEl.value = previousValue;
        alert(safeAdminError('Update category failed'));
    } finally {
        if (selectEl) {
            selectEl.disabled = false;
            selectEl.classList.remove('is-saving');
        }
    }
}

window.downloadProductDataXLSX = async () => {
    try {
        await downloadCategoryDataAsXLSX('products');
    } catch (error) {
        alert(safeAdminError('Export failed'));
    }
};

function renderProductsSnapshot(snapshot) {
    const tbody = document.getElementById('products-table-body');
    if (tbody) tbody.innerHTML = '';
    productsData = {};
    productRows = [];

    if (snapshot.empty) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">ไม่มีข้อมูลเมนูสินค้า</td></tr>';
        renderProductsTable();
        renderDashboardSalesReport();
        return;
    }

    snapshot.forEach((docSnap) => {
        const product = docSnap.data();
        const id = docSnap.id;
        productsData[id] = product;
        productRows.push({ id, product });
    });
    selectedProductIds.forEach(id => {
        if (!productsData[id]) selectedProductIds.delete(id);
    });
    renderProductsTable();
    renderDashboardSalesReport();
}

async function refreshProductsOnce() {
    const snapshot = await getDocs(query(collection(db, "products"), orderBy("category")));
    renderProductsSnapshot(snapshot);
}

// Real-time Products Listener
function setupRealtimeProducts() {
    if (productsUnsubscribe) {
        productsUnsubscribe();
        productsUnsubscribe = null;
    }
    const q = query(collection(db, "products"), orderBy("category"));
    productsUnsubscribe = onSnapshot(q, renderProductsSnapshot, (error) => {
        console.error("Error listening to products:", error);
        const tbody = document.getElementById('products-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="color:red; text-align:center;">Error: ${escapeHTML(error.message)}</td></tr>`;
    });
}

// Product Modal Logic
const productModal = document.getElementById('productModal');
const productForm = document.getElementById('productForm');

function setProductInputValue(id, value = '') {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
}

function getProductInputValue(id, fallback = '') {
    const el = document.getElementById(id);
    const value = el ? String(el.value ?? '').trim() : '';
    return value || fallback;
}

function setProductCheckboxValue(id, value = false) {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
}

function getProductCheckboxValue(id, fallback = false) {
    const el = document.getElementById(id);
    return el ? !!el.checked : fallback;
}

function getProductNumberValue(id, fallback = 0) {
    const value = Number(getProductInputValue(id));
    return Number.isFinite(value) ? value : fallback;
}

function collectProductOptionsFromForm() {
    const options = [];
    [1, 2, 3].forEach((index) => {
        const name = getProductInputValue('productOption' + index + 'Name');
        const value = getProductInputValue('productOption' + index + 'Value');
        if (name || value) options.push({ name, value });
    });
    return options;
}

function getProductSelectValue(id, fallback = '') {
    const el = document.getElementById(id);
    return el ? String(el.value || fallback) : fallback;
}

function getProductFormBaseValues() {
    return {
        price: getProductNumberValue('productPrice', 0),
        cost: getProductNumberValue('productCost', 0),
        sku: getProductInputValue('productSku'),
        stock: getProductNumberValue('productStock', 0),
        lowStock: getProductNumberValue('productLowStock', 0),
        availableForSale: getProductCheckboxValue('productAvailableForSale', true)
    };
}

function defaultProductVariants(base = getProductFormBaseValues()) {
    const skuRoot = cleanMenuCell(base.sku);
    return [
        { name: 'เย็น', suffix: 'COLD' },
        { name: 'ร้อน', suffix: 'HOT' },
        { name: 'ปั่น', suffix: 'FRAPPE' }
    ].map((item, index) => normalizeProductVariant({
        name: item.name,
        price: base.price,
        cost: base.cost,
        sku: skuRoot ? `${skuRoot}-${item.suffix}` : '',
        stock: base.stock,
        lowStock: base.lowStock,
        availableForSale: index < 2 ? base.availableForSale : false
    }, index, base));
}

function productVariantRowTemplate(variant = {}, index = 0) {
    const normalized = normalizeProductVariant(variant, index, getProductFormBaseValues());
    return `
        <tr>
            <td style="text-align:center;"><input type="checkbox" class="product-variant-available" ${normalized.availableForSale === false ? '' : 'checked'}></td>
            <td><input type="text" class="product-variant-name" value="${escapeHTML(normalized.name)}" placeholder="เย็น"></td>
            <td><input type="number" class="product-variant-price" min="0" step="0.01" value="${escapeHTML(normalized.price)}"></td>
            <td><input type="number" class="product-variant-cost" min="0" step="0.01" value="${escapeHTML(normalized.cost)}"></td>
            <td><input type="text" class="product-variant-sku" value="${escapeHTML(normalized.sku || '')}" placeholder="SKU"></td>
            <td><input type="number" class="product-variant-stock" min="0" step="1" value="${escapeHTML(normalized.stock)}"></td>
            <td><input type="number" class="product-variant-low-stock" min="0" step="1" value="${escapeHTML(normalized.lowStock)}"></td>
            <td><button type="button" class="variant-remove-btn" aria-label="Remove variant">ลบ</button></td>
        </tr>
    `;
}

function renderProductVariantRows(variants = []) {
    const tbody = document.getElementById('productVariantsBody');
    if (!tbody) return;
    const rows = Array.isArray(variants) && variants.length ? variants : defaultProductVariants();
    tbody.innerHTML = rows.map((variant, index) => productVariantRowTemplate(variant, index)).join('');
}

window.addProductVariantRow = (variant = {}) => {
    const tbody = document.getElementById('productVariantsBody');
    if (!tbody) return;
    const index = tbody.querySelectorAll('tr').length;
    const base = getProductFormBaseValues();
    const rowVariant = Object.keys(variant || {}).length ? variant : {
        name: '',
        price: base.price,
        cost: base.cost,
        sku: '',
        stock: base.stock,
        lowStock: base.lowStock,
        availableForSale: true
    };
    tbody.insertAdjacentHTML('beforeend', productVariantRowTemplate(rowVariant, index));
};

window.seedDefaultProductVariants = () => {
    renderProductVariantRows(defaultProductVariants());
};

function collectProductVariantsFromForm() {
    const tbody = document.getElementById('productVariantsBody');
    const base = getProductFormBaseValues();
    if (!tbody) return defaultProductVariants(base);
    const variants = Array.from(tbody.querySelectorAll('tr')).map((row, index) => {
        const name = row.querySelector('.product-variant-name')?.value?.trim() || '';
        const price = Number(row.querySelector('.product-variant-price')?.value);
        const cost = Number(row.querySelector('.product-variant-cost')?.value);
        const stock = Number(row.querySelector('.product-variant-stock')?.value);
        const lowStock = Number(row.querySelector('.product-variant-low-stock')?.value);
        return normalizeProductVariant({
            id: variantIdFromName(name, index),
            name,
            price: Number.isFinite(price) ? price : base.price,
            cost: Number.isFinite(cost) ? cost : base.cost,
            sku: row.querySelector('.product-variant-sku')?.value?.trim() || '',
            stock: Number.isFinite(stock) ? stock : base.stock,
            lowStock: Number.isFinite(lowStock) ? lowStock : base.lowStock,
            availableForSale: !!row.querySelector('.product-variant-available')?.checked
        }, index, base);
    }).filter(variant => variant.name);
    return variants.length ? variants : defaultProductVariants(base);
}

const productVariantsBody = document.getElementById('productVariantsBody');
if (productVariantsBody) {
    productVariantsBody.addEventListener('click', (event) => {
        const removeBtn = event.target.closest('.variant-remove-btn');
        if (!removeBtn) return;
        removeBtn.closest('tr')?.remove();
    });
}

window.openProductModal = () => {
    productForm.reset();
    document.getElementById('productId').value = '';
    document.getElementById('productImageFile').value = '';
    setProductInputValue('productStock', 0);
    setProductInputValue('productLowStock', 0);
    setProductInputValue('productIncludedItemQuantity', 1);
    setProductInputValue('productColor', '#4caf50');
    setProductInputValue('productShape', 'rounded');
    setProductInputValue('productSoldBy', 'each');
    setProductCheckboxValue('productAvailableForSale', true);
    setProductCheckboxValue('productTrackStock', false);
    setProductCheckboxValue('productTaxEnabled', true);
    setProductCheckboxValue('productShowOnWebsite', true);
    setProductCheckboxValue('productShowInShop', false);
    setProductCheckboxValue('productShowOnPos', true);
    setProductCheckboxValue('productSignature', false);
    setProductCheckboxValue('productShowOnIndex', false);
    renderProductVariantRows(defaultProductVariants());
    document.getElementById('modal-title').innerText = 'เพิ่มเมนูใหม่';
    productModal.style.display = 'block';
};

window.closeProductModal = () => {
    productModal.style.display = 'none';
};

window.editProduct = (id) => {
    const product = productsData[id];
    if (!product) return;
    
    document.getElementById('productId').value = id;
    document.getElementById('productName').value = product.name || '';
    document.getElementById('productDesc').value = product.description || '';
    document.getElementById('productPrice').value = product.price || 0;
    document.getElementById('productImage').value = product.imageUrl || '';
    document.getElementById('productImageFile').value = '';
    document.getElementById('productCategory').value = product.category || 'coffee';
    setProductInputValue('productHandle', product.handle || id);
    setProductInputValue('productSku', product.sku || '');
    setProductInputValue('productCost', product.cost ?? '');
    setProductInputValue('productStock', product.stock ?? 0);
    setProductInputValue('productLowStock', product.lowStock ?? 0);
    setProductInputValue('productOption1Name', product.option1Name || product.options?.[0]?.name || '');
    setProductInputValue('productOption1Value', product.option1Value || product.options?.[0]?.value || '');
    setProductInputValue('productOption2Name', product.option2Name || product.options?.[1]?.name || '');
    setProductInputValue('productOption2Value', product.option2Value || product.options?.[1]?.value || '');
    setProductInputValue('productOption3Name', product.option3Name || product.options?.[2]?.name || '');
    setProductInputValue('productOption3Value', product.option3Value || product.options?.[2]?.value || '');
    setProductInputValue('productBarcode', product.barcode || '');
    setProductInputValue('productIncludedItemSku', product.includedItemSku || '');
    setProductInputValue('productIncludedItemQuantity', product.includedItemQuantity ?? 1);
    setProductInputValue('productSoldBy', product.soldBy || (product.soldByWeight ? 'weight' : 'each'));
    setProductInputValue('productColor', product.color || '#4caf50');
    setProductInputValue('productShape', product.shape || 'rounded');
    setProductCheckboxValue('productAvailableForSale', product.availableForSale !== false);
    setProductCheckboxValue('productTrackStock', !!product.trackStock);
    setProductCheckboxValue('productTaxEnabled', product.taxEnabled !== false);
    setProductCheckboxValue('productShowOnWebsite', product.showOnWebsite !== false);
    setProductCheckboxValue('productShowInShop', !!product.showInShop);
    setProductCheckboxValue('productShowOnPos', product.showOnPos !== false);
    document.getElementById('productSignature').checked = !!product.isSignature;
    setProductCheckboxValue('productShowOnIndex', !!(product.showOnIndex || product.isFeatured));
    renderProductVariantRows(productVariantsForDisplay(product));
    
    document.getElementById('modal-title').innerText = 'แก้ไขเมนูสินค้า';
    productModal.style.display = 'block';
};

window.deleteProduct = async (id) => {
    if (confirm("คุณแน่ใจหรือไม่ว่าต้องการลบสินค้านี้?")) {
        try {
            await deleteDoc(doc(db, "products", id));
        } catch (e) {
            alert("ลบไม่สำเร็จ: " + e.message);
        }
    }
};

// Handle Product Form Submit
productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = document.getElementById('productId').value;
    const submitBtn = productForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerText;
    
    try {
        submitBtn.disabled = true;
        submitBtn.innerText = 'กำลังบันทึก...';
        
        let finalImageUrl = document.getElementById('productImage').value;
        const imageFile = document.getElementById('productImageFile').files[0];
        
        if (imageFile) {
            submitBtn.innerText = 'กำลังแปลงรูปภาพ...';
            const webpBlob = await compressToWebP(imageFile, 0.8);
            submitBtn.innerText = 'กำลังอัปโหลดรูปภาพ...';
            finalImageUrl = await uploadAdminImage(webpBlob, 'products', Date.now() + '_image.webp');
        }

        if (!finalImageUrl) {
            throw new Error("กรุณาอัปโหลดรูปภาพ หรือใส่ลิงก์รูปภาพ");
        }

        const optionList = collectProductOptionsFromForm();
        const variantList = collectProductVariantsFromForm();
        const productName = document.getElementById('productName').value;
        const productHandle = getProductInputValue('productHandle') || slugifyMenuHandle(productName);
        const soldBy = getProductSelectValue('productSoldBy', 'each');
        const productData = {
            handle: productHandle,
            sku: getProductInputValue('productSku'),
            name: productName,
            description: document.getElementById('productDesc').value,
            price: Number(document.getElementById('productPrice').value),
            cost: getProductNumberValue('productCost', 0),
            stock: getProductNumberValue('productStock', 0),
            lowStock: getProductNumberValue('productLowStock', 0),
            imageUrl: finalImageUrl,
            category: document.getElementById('productCategory').value,
            soldBy,
            soldByWeight: soldBy === 'weight',
            trackStock: getProductCheckboxValue('productTrackStock'),
            availableForSale: getProductCheckboxValue('productAvailableForSale', true),
            showOnWebsite: getProductCheckboxValue('productShowOnWebsite', true),
            showInShop: getProductCheckboxValue('productShowInShop', false),
            showOnPos: getProductCheckboxValue('productShowOnPos', true),
            showOnIndex: getProductCheckboxValue('productShowOnIndex', false),
            taxName: 'eden cafe',
            taxRate: 7,
            taxEnabled: getProductCheckboxValue('productTaxEnabled', true),
            color: getProductInputValue('productColor', '#4caf50'),
            shape: getProductSelectValue('productShape', 'rounded'),
            option1Name: getProductInputValue('productOption1Name'),
            option1Value: getProductInputValue('productOption1Value'),
            option2Name: getProductInputValue('productOption2Name'),
            option2Value: getProductInputValue('productOption2Value'),
            option3Name: getProductInputValue('productOption3Name'),
            option3Value: getProductInputValue('productOption3Value'),
            options: optionList,
            barcode: getProductInputValue('productBarcode'),
            includedItemSku: getProductInputValue('productIncludedItemSku'),
            includedItemQuantity: getProductNumberValue('productIncludedItemQuantity', 1),
            isSignature: document.getElementById('productSignature').checked,
            isFeatured: getProductCheckboxValue('productShowOnIndex', false),
            variants: variantList,
            updatedAt: new Date().toISOString()
        };
        
        if (id) {
            // Update existing
            await updateDoc(doc(db, "products", id), productData);
        } else if (productData.handle) {
            productData.createdAt = new Date().toISOString();
            await setDoc(doc(db, "products", productData.handle), productData, { merge: true });
        } else {
            // Add new
            productData.createdAt = new Date().toISOString();
            await addDoc(collection(db, "products"), productData);
        }
        closeProductModal();
        alert('บันทึกเมนูสำเร็จ!');
    } catch (error) {
        console.error('Error saving product:', error);
        alert(safeAdminError("บันทึกไม่สำเร็จ"));
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = originalText;
    }
});

// Close modal when clicking outside
window.onclick = function(event) {
    if (event.target == productModal) {
        closeProductModal();
    }
    if (event.target == categoryModal) {
        closeCategoryModal();
    }
}

// Global functions for inline HTML execution
window.updateOrderStatus = async (id, newStatus) => {
    try {
        if (newStatus === 'cancelled') {
            const orderSnap = await getDoc(doc(db, "orders", id));
            const order = orderSnap.exists() ? orderSnap.data() : null;
            if (order?.source === 'pos') {
                await window.voidPosOrder(id);
                return;
            }
        }
        await updateDoc(doc(db, "orders", id), { status: newStatus });
    } catch (e) {
        alert("อัปเดตไม่สำเร็จ: " + e.message);
    }
}

window.voidPosOrder = async (id) => {
    const reason = prompt('ระบุเหตุผลการ Void / ยกเลิกบิล POS');
    if (reason === null) return;
    try {
        await restorePosOrderStock(id, reason);
        alert('Void ออเดอร์ POS และคืนสต็อกเรียบร้อย');
    } catch (error) {
        console.error('Void POS order failed:', error);
        alert(safeAdminError("Void ออเดอร์ POS ไม่สำเร็จ"));
    }
};

// ==========================================
// Blog Management Logic
// ==========================================
let blogsData = {};
let quill;

document.addEventListener("DOMContentLoaded", () => {
    // Initialize Quill Rich Text Editor if not already initialized
    if (!quill && document.getElementById('blogContentEditor')) {
        quill = new Quill('#blogContentEditor', {
            theme: 'snow',
            modules: {
                toolbar: [
                    [{ 'header': [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    ['blockquote', 'code-block'],
                    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                    [{ 'color': [] }, { 'background': [] }],
                    ['link', 'image', 'video'],
                    ['clean']
                ]
            }
        });
    }
});

const blogModal = document.getElementById('blogModal');
const blogForm = document.getElementById('blogForm');

function renderSeedBlogBlocks(blocks = []) {
    return blocks.map(block => {
        if (block.type === 'h2') return `<h2>${escapeHTML(block.text)}</h2>`;
        if (block.type === 'h3') return `<h3>${escapeHTML(block.text)}</h3>`;
        if (block.type === 'ul') {
            const items = (block.items || []).map(item => `<li>${escapeHTML(item)}</li>`).join('');
            return `<ul>${items}</ul>`;
        }
        return `<p>${escapeHTML(block.text || '')}</p>`;
    }).join('\n');
}

function renderSeedLinkList(links = []) {
    if (!links.length) return '';
    const items = links
        .map(link => `<li><a href="${escapeHTML(link.href)}">${escapeHTML(link.label)}</a></li>`)
        .join('');
    return `<ul>${items}</ul>`;
}

function renderSeedBlogContent(post) {
    const summary = (post.summary || []).map(item => `<li>${escapeHTML(item)}</li>`).join('');
    const faqs = (post.faqs || [])
        .map(faq => `<h3>${escapeHTML(faq.question)}</h3>\n<p>${escapeHTML(faq.answer)}</p>`)
        .join('\n');
    const internalLinks = renderSeedLinkList(post.suggestedInternalLinks || []);
    const externalLinks = renderSeedLinkList(post.suggestedExternalLinks || []);
    const cta = post.cta
        ? `<p><a href="${escapeHTML(post.cta.href)}"><strong>${escapeHTML(post.cta.label)}</strong></a></p>`
        : '';

    return [
        `<p><strong>สรุปคำตอบ:</strong> ${escapeHTML(post.excerpt)}</p>`,
        summary ? `<h2>สรุปสั้น</h2>\n<ul>${summary}</ul>` : '',
        renderSeedBlogBlocks(post.blocks || []),
        faqs ? `<h2>คำถามที่พบบ่อย</h2>\n${faqs}` : '',
        internalLinks ? `<h2>ลิงก์ภายในที่เกี่ยวข้อง</h2>\n${internalLinks}` : '',
        externalLinks ? `<h2>แหล่งข้อมูลอ้างอิง</h2>\n${externalLinks}` : '',
        cta
    ].filter(Boolean).join('\n\n');
}

function getAbsoluteSeedImageUrl(post) {
    const src = post?.image?.src || SITE.defaultImage;
    if (/^https?:\/\//i.test(src)) return src;
    return `${SITE.origin}${src.startsWith('/') ? src : `/${src}`}`;
}

function buildSeoBlogSeedData(post, index) {
    const publishedAt = `${post.publishedDate}T09:00:00+07:00`;
    const updatedAt = `${post.updatedDate || post.publishedDate}T09:00:00+07:00`;

    return {
        title: post.title,
        slug: post.slug,
        category: post.category || 'Local Guide',
        status: 'published',
        excerpt: post.excerpt,
        content: renderSeedBlogContent(post),
        imageUrl: getAbsoluteSeedImageUrl(post),
        imageAlt: post.image?.alt || post.title,
        imageFileName: post.image?.fileName || `${post.slug}-cover.webp`,
        imagePrompt16x9: post.image?.prompt16x9 || '',
        imagePrompt1x1: post.image?.prompt1x1 || '',
        imageSizes: post.image?.sizes || ['16:9 blog cover', '1:1 social share'],
        seoTitle: post.seoTitle,
        metaDescription: post.metaDescription,
        focusKeyword: post.focusKeyword,
        secondaryKeywords: post.secondaryKeywords || [],
        author: SITE.author,
        readingTime: post.readingTime,
        publishedDate: post.publishedDate,
        updatedDate: post.updatedDate || post.publishedDate,
        publishedAt,
        createdAt: publishedAt,
        updatedAt,
        importedAt: new Date().toISOString(),
        displayOrder: index + 1,
        staticUrl: getBlogUrl(post),
        canonicalUrl: `${SITE.origin}${getBlogUrl(post)}`,
        openGraphImage: getAbsoluteSeedImageUrl(post),
        twitterCard: 'summary_large_image',
        faqs: post.faqs || [],
        summary: post.summary || [],
        suggestedInternalLinks: post.suggestedInternalLinks || [],
        suggestedExternalLinks: post.suggestedExternalLinks || [],
        cta: post.cta || null,
        relatedSlugs: post.relatedSlugs || [],
        schemaTypes: ['BlogPosting', 'FAQPage', 'CafeOrCoffeeShop'],
        localEntity: {
            name: SITE.name,
            address: SITE.address,
            telephone: SITE.telephone,
            openingHours: SITE.openingHours,
            mapUrl: SITE.mapUrl
        },
        seededFrom: 'js/blog-data.mjs',
        blogSystemVersion: 'seo-blog-v1'
    };
}

window.seedSeoBlogPosts = async () => {
    if (!auth.currentUser) {
        alert('กรุณาเข้าสู่ระบบ Admin ก่อนนำเข้าบทความ');
        return;
    }
    if (!isOwnerAccess()) {
        alert('ฟังก์ชันนำเข้าบทความ SEO ใช้ได้เฉพาะ Owner เท่านั้น');
        return;
    }

    const confirmed = confirm('นำเข้า/อัปเดตบทความ SEO ทั้ง 6 บทความลงในหน้า Admin ใช่ไหม? ระบบจะอัปเดตเอกสารที่มี slug เดิมใน collection blogs');
    if (!confirmed) return;

    const button = document.getElementById('seed-seo-blogs-btn');
    const originalText = button?.innerText || '';

    try {
        if (button) {
            button.disabled = true;
            button.innerText = 'กำลังนำเข้าบทความ...';
        }

        const batch = writeBatch(db);
        BLOG_POSTS.forEach((post, index) => {
            batch.set(doc(db, 'blogs', post.slug), buildSeoBlogSeedData(post, index), { merge: true });
        });
        await batch.commit();

        alert('นำเข้า/อัปเดตบทความ SEO 6 บทความเรียบร้อยแล้ว');
        if (typeof fetchBlogsFromCloud === 'function') fetchBlogsFromCloud();
    } catch (error) {
        console.error('Seed SEO blogs failed:', error);
        alert(safeAdminError("นำเข้าบทความไม่สำเร็จ"));
    } finally {
        if (button) {
            button.innerText = originalText;
            button.disabled = false;
        }
    }
};

window.fetchBlogsFromCloud = function() {
    if (blogsUnsubscribe) {
        blogsUnsubscribe();
        blogsUnsubscribe = null;
    }
    const q = query(collection(db, "blogs"), orderBy("createdAt", "desc"));
    blogsUnsubscribe = onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('blogs-table-body');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        blogsData = {};
        
        snapshot.forEach((docSnap) => {
            const blog = docSnap.data();
            const id = docSnap.id;
            blogsData[id] = blog;
            
            const dateStr = blog.createdAt ? new Date(blog.createdAt).toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' }) : 'ไม่ทราบวันที่';
            const statusBadge = blog.status === 'published' 
                ? '<span class="status-badge status-completed">เผยแพร่</span>' 
                : '<span class="status-badge status-pending">ฉบับร่าง</span>';
                
            const imgHtml = blog.imageUrl 
                ? `<img loading="lazy" src="${safeImageURL(blog.imageUrl)}" alt="Cover" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px;">` 
                : `<div style="width: 50px; height: 50px; background: #eee; border-radius: 5px; display:flex; align-items:center; justify-content:center; color:#999; font-size:12px;">No Image</div>`;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${imgHtml}</td>
                <td><strong>${escapeHTML(blog.title)}</strong></td>
                <td><span style="background:#e3f2fd; color:#2196f3; padding:2px 8px; border-radius:10px; font-size:0.8rem;">${escapeHTML(blog.category)}</span></td>
                <td>${statusBadge}</td>
                <td>${dateStr}</td>
                <td>
                    <button class="btn-action btn-edit" onclick="editBlog('${escapeJSString(id)}')">แก้ไข</button>
                    <button class="btn-action btn-delete" onclick="deleteBlog('${escapeJSString(id)}')">ลบ</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }, (error) => {
        console.error("Error fetching blogs:", error);
    });
}

window.openBlogModal = () => {
    blogForm.reset();
    document.getElementById('blogId').value = '';
    document.getElementById('blogImageUrl').value = '';
    if (quill) quill.root.innerHTML = '';
    document.getElementById('blogModalTitle').innerText = 'เพิ่มบทความใหม่';
    blogModal.style.display = 'block';
};

window.closeBlogModal = () => {
    blogModal.style.display = 'none';
};

window.editBlog = (id) => {
    const blog = blogsData[id];
    if (!blog) return;
    
    document.getElementById('blogId').value = id;
    document.getElementById('blogTitle').value = blog.title || '';
    document.getElementById('blogCategory').value = blog.category || 'ความรู้เรื่องกาแฟ';
    document.getElementById('blogStatus').value = blog.status || 'draft';
    document.getElementById('blogExcerpt').value = blog.excerpt || '';
    document.getElementById('blogImageUrl').value = blog.imageUrl || '';
    
    if (quill) {
        quill.root.innerHTML = blog.content || '';
    }
    
    document.getElementById('blogModalTitle').innerText = 'แก้ไขบทความ';
    blogModal.style.display = 'block';
};

window.deleteBlog = async (id) => {
    if (confirm("คุณแน่ใจหรือไม่ว่าต้องการลบบทความนี้?")) {
        try {
            await deleteDoc(doc(db, "blogs", id));
        } catch (e) {
            alert("ลบไม่สำเร็จ: " + e.message);
        }
    }
};

blogForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const submitBtn = document.getElementById('btn-submit-blog');
    const originalText = submitBtn.innerText;
    submitBtn.innerText = 'กำลังบันทึก...';
    submitBtn.disabled = true;

    try {
        const id = document.getElementById('blogId').value;
        const fileInput = document.getElementById('blogImageFile');
        let imageUrl = document.getElementById('blogImageUrl').value;
        
        // Handle image upload if a new file is selected
        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            submitBtn.innerText = 'กำลังแปลงรูปภาพ...';
            const webpBlob = await compressToWebP(file, 0.8);
            submitBtn.innerText = 'กำลังอัปโหลดรูปภาพ...';
            imageUrl = await uploadAdminImage(webpBlob, 'blogs', Date.now() + '.webp');
        }

        const blogData = {
            title: document.getElementById('blogTitle').value,
            category: document.getElementById('blogCategory').value,
            status: document.getElementById('blogStatus').value,
            excerpt: document.getElementById('blogExcerpt').value,
            content: quill ? quill.root.innerHTML : '',
            imageUrl: imageUrl,
            updatedAt: new Date().toISOString()
        };
        
        if (id) {
            await updateDoc(doc(db, "blogs", id), blogData);
        } else {
            blogData.createdAt = new Date().toISOString();
            await addDoc(collection(db, "blogs"), blogData);
        }
        closeBlogModal();
    } catch (error) {
        alert(safeAdminError("บันทึกไม่สำเร็จ"));
    } finally {
        submitBtn.innerText = originalText;
        submitBtn.disabled = false;
    }
});

// Update window.onclick to include blogModal
const originalOnClick = window.onclick;
window.onclick = function(event) {
    if (originalOnClick) originalOnClick(event);
    if (event.target == blogModal) {
        closeBlogModal();
    }
    if (typeof faqModal !== 'undefined' && event.target == faqModal) {
        closeFaqModal();
    }
    const memberModalEl = document.getElementById('memberModal');
    if (memberModalEl && event.target == memberModalEl) {
        closeMemberModal();
    }
};

// Start fetching blogs immediately if user is logged in
onAuthStateChanged(auth, (user) => {
    if (user) {
        if(typeof fetchBlogsFromCloud === 'function') fetchBlogsFromCloud();
    }
});;

window.updateBookingStatus = async (id, newStatus) => {
    try {
        await updateDoc(doc(db, "bookings", id), { status: newStatus });
    } catch (e) {
        alert("อัปเดตไม่สำเร็จ: " + e.message);
    }
};

window.fetchOrders = setupRealtimeOrders;
window.fetchBookings = setupRealtimeBookings;
window.fetchRoomBookings = setupRealtimeBookings;
window.migrateProducts = migrateProducts;

async function migrateProducts() {
    try {
        // Migrate Categories first
        const catQ = query(collection(db, "categories"));
        const catSnap = await getDocs(catQ);
        if (catSnap.empty) {
            console.log("Migrating initial categories...");
            await setDoc(doc(db, "categories", "coffee"), { name: "กาแฟ (Coffee)" });
            await setDoc(doc(db, "categories", "tea"), { name: "ชา (Tea)" });
            await setDoc(doc(db, "categories", "bakery"), { name: "เบเกอรี่ (Bakery)" });
            await setDoc(doc(db, "categories", "other"), { name: "อื่นๆ (Other)" });
        }

        // Migrate Products
        const q = query(collection(db, "products"));
        const snap = await getDocs(q);
        if (snap.empty) {
            console.log("Migrating initial products...");
            const initialProducts = [
                { name: "Drip Coffee (Thai Arabica)", description: "กาแฟดริป หอมละมุน ดึงรสชาติผลไม้และดอกไม้ตามธรรมชาติของกาแฟบนดอยไทย คั่วใหม่ทุกวัน", price: 80, imageUrl: "https://images.unsplash.com/photo-1497935586351-b67a49e012bf?auto=format&fit=crop&w=600&q=80", category: "coffee", isSignature: true },
                { name: "Eden Iced Latte", description: "ผสมผสานเอสเพรสโซ่เข้มข้นกับนมสด เพิ่มความหอมหวานด้วยน้ำตาลมะพร้าวออร์แกนิกแท้", price: 95, imageUrl: "https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=600&q=80", category: "coffee", isSignature: true },
                { name: "Homemade Butter Croissant", description: "ครัวซองต์เนยสด กรอบนอกนุ่มใน อบใหม่ทุกเช้า ทานคู่กับกาแฟแก้วโปรดได้อย่างลงตัว", price: 65, imageUrl: "https://images.unsplash.com/photo-1549996647-190b679b33d7?auto=format&fit=crop&w=600&q=80", category: "bakery", isSignature: true },
                { name: "Matcha Yuzu Sparkling", description: "มัทฉะเกรดพรีเมียมผสมผสานความเปรี้ยวอมหวานของส้มยูซุ เพิ่มความสดชื่นด้วยโซดา", price: 110, imageUrl: "https://images.unsplash.com/photo-1536935338788-846bb9981813?auto=format&fit=crop&w=600&q=80", category: "tea", isSignature: true }
            ];
            for (const p of initialProducts) { await addDoc(collection(db, "products"), p); }
        }
    } catch (e) { console.error("Migrate failed", e); }
}

const LEGACY_SHOP_CATEGORY_MAP = Object.freeze({
    'cat-1': 'coffee',
    'cat-2': 'tea',
    'cat-3': 'bakery',
    'cat-4': 'merch',
    coffee_bean: 'coffee',
    beans: 'coffee',
    coffee: 'coffee',
    tea: 'tea',
    bakery: 'bakery',
    merch: 'merch',
    merchandise: 'merch'
});

const LEGACY_SHOP_CATEGORY_DEFAULTS = Object.freeze({
    coffee: { name: 'กาแฟ', nameEn: 'Coffee', order: 10 },
    tea: { name: 'ชา', nameEn: 'Tea', order: 20 },
    bakery: { name: 'เบเกอรี่', nameEn: 'Bakery', order: 30 },
    merch: { name: 'ของพรีเมี่ยม', nameEn: 'Merchandise', order: 90 },
    other: { name: 'อื่นๆ', nameEn: 'Other', order: 999 }
});

function legacyShopTargetCategory(categoryId = '', shopCategoryMap = {}) {
    const cleanId = String(categoryId || '').trim();
    const mapped = LEGACY_SHOP_CATEGORY_MAP[cleanId.toLowerCase()];
    if (mapped) return mapped;

    const sourceCategory = shopCategoryMap[cleanId] || {};
    const fromName = slugifyMenuHandle(sourceCategory.name || sourceCategory.nameEn || cleanId);
    return fromName || 'other';
}

function legacyShopCategoryPayload(targetId, sourceCategory = {}) {
    const defaults = LEGACY_SHOP_CATEGORY_DEFAULTS[targetId] || {};
    return {
        name: sourceCategory.name || defaults.name || targetId,
        nameEn: sourceCategory.nameEn || defaults.nameEn || '',
        order: Number(sourceCategory.order || defaults.order || 999)
    };
}

function legacyShopProductTargetId(sourceId, product = {}) {
    const cleanSourceId = slugifyMenuHandle(sourceId);
    return `shop-${cleanSourceId || slugifyMenuHandle(product.handle || product.name) || Date.now()}`;
}

function legacyShopProductPayload(sourceId, product = {}, targetCategory = 'other') {
    const featured = parseMenuBoolean(product.showOnIndex ?? product.isFeatured, false);
    const availableForSale = parseMenuBoolean(product.availableForSale, true);
    const handle = slugifyMenuHandle(product.handle || product.name || sourceId);
    const stock = safeNumber(product.stock ?? product.inStock, 0);
    const payload = {
        handle: handle || legacyShopProductTargetId(sourceId, product),
        sku: product.sku || '',
        name: product.name || product.nameTh || product.nameEn || sourceId,
        description: product.description || product.descriptionTh || product.descriptionEn || '',
        price: safeNumber(product.price, 0),
        cost: safeNumber(product.cost, 0),
        stock,
        lowStock: safeNumber(product.lowStock, 0),
        imageUrl: product.imageUrl || product.image || 'Images/Logo.webp',
        category: targetCategory,
        soldBy: product.soldBy || 'each',
        soldByWeight: parseMenuBoolean(product.soldByWeight, false),
        trackStock: parseMenuBoolean(product.trackStock, true),
        availableForSale,
        showOnWebsite: parseMenuBoolean(product.showOnWebsite, false),
        showInShop: true,
        showOnPos: parseMenuBoolean(product.showOnPos, false),
        showOnIndex: featured,
        isFeatured: featured,
        taxName: product.taxName || 'eden cafe',
        taxRate: safeNumber(product.taxRate, 7),
        taxEnabled: parseMenuBoolean(product.taxEnabled, true),
        variants: Array.isArray(product.variants) ? product.variants : [],
        migratedFromCollection: 'shop_products',
        migratedFromId: sourceId,
        legacyShopCategory: product.category || product.categoryId || '',
        updatedAt: new Date().toISOString()
    };
    if (product.createdAt) payload.createdAt = product.createdAt;
    Object.keys(payload).forEach(key => {
        if (payload[key] === undefined) delete payload[key];
        if (Array.isArray(payload[key]) && !payload[key].length) delete payload[key];
    });
    return payload;
}

async function loadLegacyShopMigrationSnapshot() {
    const [shopCategoriesSnap, shopProductsSnap, categoriesSnap, productsSnap] = await Promise.all([
        getDocs(query(collection(db, 'shop_categories'))),
        getDocs(query(collection(db, 'shop_products'))),
        getDocs(query(collection(db, 'categories'))),
        getDocs(query(collection(db, 'products')))
    ]);
    const shopCategories = shopCategoriesSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const shopProducts = shopProductsSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const categories = categoriesSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const products = productsSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    return { shopCategories, shopProducts, categories, products };
}

function buildLegacyShopMigrationPlan(snapshot) {
    const shopCategoryMap = Object.fromEntries(snapshot.shopCategories.map(category => [category.id, category]));
    const existingCategoryIds = new Set(snapshot.categories.map(category => category.id));
    const categoriesByTarget = new Map();

    const products = snapshot.shopProducts.map(product => {
        const targetCategory = legacyShopTargetCategory(product.category || product.categoryId, shopCategoryMap);
        if (!existingCategoryIds.has(targetCategory) && !categoriesByTarget.has(targetCategory)) {
            categoriesByTarget.set(targetCategory, legacyShopCategoryPayload(targetCategory, shopCategoryMap[product.category || product.categoryId]));
        }
        const targetId = legacyShopProductTargetId(product.id, product);
        return {
            sourceId: product.id,
            targetId,
            targetCategory,
            payload: legacyShopProductPayload(product.id, product, targetCategory)
        };
    });

    return {
        categoriesToCreate: Array.from(categoriesByTarget, ([id, payload]) => ({ id, payload })),
        productsToUpsert: products
    };
}

window.auditLegacyShopCollections = async () => {
    const snapshot = await loadLegacyShopMigrationSnapshot();
    const plan = buildLegacyShopMigrationPlan(snapshot);
    const report = {
        legacyShopProducts: snapshot.shopProducts.length,
        legacyShopCategories: snapshot.shopCategories.length,
        productsTotal: snapshot.products.length,
        productsShowInShop: snapshot.products.filter(product => product.showInShop === true).length,
        productsShowOnIndex: snapshot.products.filter(product => product.showOnIndex === true || product.isFeatured === true).length,
        categoriesTotal: snapshot.categories.length,
        categoriesToCreate: plan.categoriesToCreate.map(item => item.id),
        productsToUpsert: plan.productsToUpsert.map(item => ({ sourceId: item.sourceId, targetId: item.targetId, category: item.targetCategory }))
    };
    console.log('Legacy shop audit:', report);
    return report;
};

window.migrateLegacyShopToProducts = async ({ dryRun = true } = {}) => {
    const snapshot = await loadLegacyShopMigrationSnapshot();
    const plan = buildLegacyShopMigrationPlan(snapshot);
    const result = {
        dryRun,
        categoriesToCreate: plan.categoriesToCreate,
        productsToUpsert: plan.productsToUpsert.map(item => ({ sourceId: item.sourceId, targetId: item.targetId, targetCategory: item.targetCategory }))
    };

    if (dryRun) {
        console.log('Legacy shop migration dry run:', result);
        return result;
    }
    if (!canAdmin('products')) {
        throw new Error('This account needs products permission to migrate legacy shop data.');
    }

    for (const category of plan.categoriesToCreate) {
        await setDoc(doc(db, 'categories', category.id), {
            ...category.payload,
            migratedFromCollection: 'shop_categories',
            updatedAt: new Date().toISOString()
        }, { merge: true });
    }
    for (const product of plan.productsToUpsert) {
        await setDoc(doc(db, 'products', product.targetId), {
            ...product.payload,
            migratedAt: serverTimestamp()
        }, { merge: true });
    }

    console.log('Legacy shop migration completed:', result);
    return result;
};

window.syncMembersFromAuth = async () => {
    if (!canAdmin('members')) {
        alert('บัญชีนี้ไม่มีสิทธิ์ซิงก์สมาชิก');
        return;
    }
    const confirmed = confirm('Sync all Firebase Authentication users into Firestore members now?');
    if (!confirmed) return;

    try {
        const token = await auth.currentUser?.getIdToken(true);
        if (!token) throw new Error('Please sign in as admin again before syncing members');

        const response = await fetch(FUNCTIONS_BASE_URL + '/syncAuthUsersToFirestore', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token }
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Member sync failed');

        alert('Member sync complete: total ' + result.synced + ' / created ' + result.created + ' / updated ' + result.updated);
        renderMembersTable();
    } catch (error) {
        console.error('Unable to sync auth users:', error);
        alert(safeAdminError('Member sync failed'));
    }
};

// ==========================================
// POS APK Protected Update Admin
// ==========================================
function apkStatusPill(status) {
    const safeStatus = ['active', 'draft', 'revoked'].includes(status) ? status : 'draft';
    return `<span class="apk-pill ${safeStatus}">${escapeHTML(safeStatus)}</span>`;
}

function formatApkBytes(value) {
    const bytes = safeNumber(value, 0);
    if (bytes <= 0) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeApkSha(value) {
    return String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase().slice(0, 64);
}

function posApkReleaseForm() {
    return document.getElementById('pos-apk-release-form');
}

function setPosApkFormStatus(message, type = '') {
    const el = document.getElementById('pos-apk-form-status');
    if (!el) return;
    el.textContent = message || '';
    el.className = `apk-admin-status ${type}`.trim();
}

function resetPosApkReleaseForm() {
    const form = posApkReleaseForm();
    if (!form) return;
    form.reset();
    document.getElementById('pos-apk-release-id').value = '';
    document.getElementById('pos-apk-app-id').value = 'com.personal.pos';
    document.getElementById('pos-apk-channel').value = 'test';
    document.getElementById('pos-apk-status').value = 'draft';
    document.getElementById('pos-apk-min-supported').value = '0';
    document.getElementById('pos-apk-force-update').checked = false;
    setPosApkFormStatus('');
}
window.resetPosApkReleaseForm = resetPosApkReleaseForm;

function posApkReleaseFromForm() {
    const appId = document.getElementById('pos-apk-app-id')?.value.trim() || 'com.personal.pos';
    const versionName = document.getElementById('pos-apk-version-name')?.value.trim() || '';
    const versionCode = safeNumber(document.getElementById('pos-apk-version-code')?.value, 0);
    const channel = document.getElementById('pos-apk-channel')?.value || 'test';
    const status = document.getElementById('pos-apk-status')?.value || 'draft';
    const sha256 = normalizeApkSha(document.getElementById('pos-apk-sha256')?.value || '');
    const size = safeNumber(document.getElementById('pos-apk-size')?.value, 0);
    const minSupportedVersionCode = safeNumber(document.getElementById('pos-apk-min-supported')?.value, 0);
    const functionAsset = document.getElementById('pos-apk-function-asset')?.value.trim() || '';
    const storagePath = document.getElementById('pos-apk-storage-path')?.value.trim() || '';
    const releaseNotes = document.getElementById('pos-apk-release-notes')?.value.trim() || '';
    const forceUpdate = document.getElementById('pos-apk-force-update')?.checked === true;

    if (appId !== 'com.personal.pos') throw new Error('App ID must be com.personal.pos');
    if (!versionName || versionName.length > 40) throw new Error('Version name is required');
    if (!versionCode || versionCode < 1) throw new Error('Version code must be greater than 0');
    if (!['test', 'pilot', 'production'].includes(channel)) throw new Error('Invalid channel');
    if (!['draft', 'active', 'revoked'].includes(status)) throw new Error('Invalid status');
    if (!/^[A-F0-9]{64}$/.test(sha256)) throw new Error('SHA256 must be 64 hex characters');

    return {
        appId,
        versionName,
        versionCode,
        channel,
        status,
        sha256,
        size,
        functionAsset,
        storagePath,
        releaseNotes,
        minSupportedVersionCode,
        forceUpdate,
        updatedBy: auth.currentUser?.uid || '',
        updatedAt: serverTimestamp()
    };
}

function bindPosApkReleaseForm() {
    const form = posApkReleaseForm();
    if (!form || posApkFormBound) return;
    posApkFormBound = true;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!canAdmin('pos')) {
            alert('POS admin permission is required');
            return;
        }

        try {
            setPosApkFormStatus('Saving release metadata...');
            const release = posApkReleaseFromForm();
            const existingId = document.getElementById('pos-apk-release-id')?.value || '';
            const releaseId = existingId || `${release.appId}_${release.channel}_v${release.versionCode}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
            const current = posApkReleasesData[releaseId] || null;
            await setDoc(doc(db, 'pos_apk_releases', releaseId), {
                ...release,
                createdBy: current?.createdBy || auth.currentUser?.uid || '',
                createdAt: current?.createdAt || serverTimestamp()
            }, { merge: true });
            setPosApkFormStatus('Release metadata saved', 'success');
            document.getElementById('pos-apk-release-id').value = releaseId;
        } catch (error) {
            console.error('Unable to save POS APK release:', error);
            setPosApkFormStatus(error.message || 'Save failed', 'error');
        }
    });
}

function renderPosApkReleaseTable() {
    const tbody = document.getElementById('pos-apk-release-table-body');
    if (!tbody) return;
    const rows = Object.entries(posApkReleasesData)
        .map(([id, release]) => ({ id, ...release }))
        .sort((a, b) => safeNumber(b.versionCode, 0) - safeNumber(a.versionCode, 0));
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7">No release metadata yet</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(row => `
        <tr>
            <td><strong>${escapeHTML(row.versionName || '-')} / ${escapeHTML(row.versionCode || '-')}</strong><br><small>${escapeHTML(row.id)}<br>${escapeHTML(row.functionAsset || row.storagePath || '-')}</small></td>
            <td>${escapeHTML(row.channel || '-')}</td>
            <td>${apkStatusPill(row.status || 'draft')}</td>
            <td><small>${escapeHTML(String(row.sha256 || '').slice(0, 18))}...</small></td>
            <td>${formatApkBytes(row.size)}</td>
            <td>${formatDate(row.updatedAt || row.createdAt)}</td>
            <td>
                <button class="btn-action btn-edit" onclick="editPosApkRelease('${escapeJSString(row.id)}')">Edit</button>
                <button class="btn-action btn-view" onclick="setPosApkReleaseStatus('${escapeJSString(row.id)}','active')">Active</button>
                <button class="btn-action btn-delete" onclick="setPosApkReleaseStatus('${escapeJSString(row.id)}','revoked')">Revoke</button>
            </td>
        </tr>
    `).join('');
}

function renderPosApkDevicesTable() {
    const tbody = document.getElementById('pos-apk-device-table-body');
    if (!tbody) return;
    const rows = Object.entries(posApkDevicesData)
        .map(([id, device]) => ({ id, ...device }))
        .sort((a, b) => String(b.updatedAt?.seconds || '').localeCompare(String(a.updatedAt?.seconds || '')));
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6">No device status reported yet</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(row => `
        <tr>
            <td><strong>${escapeHTML(row.id)}</strong><br><small>${escapeHTML(row.lastSeenEmail || '')}</small></td>
            <td>${escapeHTML(row.channel || '-')}</td>
            <td>${escapeHTML(row.currentVersionCode || '-')}</td>
            <td>${escapeHTML(row.targetVersionCode || '-')}</td>
            <td>${escapeHTML(row.lastUpdateEvent || '-')}</td>
            <td>${formatDate(row.updatedAt || row.lastUpdateEventAt || row.lastUpdateCheckAt)}</td>
        </tr>
    `).join('');
}

function renderPosApkEventsTable() {
    const tbody = document.getElementById('pos-apk-event-table-body');
    if (!tbody) return;
    const rows = posApkEventsData.slice(0, 30);
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="6">No update events yet</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(row => `
        <tr>
            <td>${formatDate(row.createdAt)}</td>
            <td>${escapeHTML(row.event || '-')}</td>
            <td>${escapeHTML(row.deviceId || '-')}</td>
            <td>${escapeHTML(row.releaseId || '-')}</td>
            <td>${escapeHTML(row.versionName || row.targetVersionCode || '-')}</td>
            <td>${escapeHTML(row.message || '-')}</td>
        </tr>
    `).join('');
}

function setupRealtimePosApkUpdates() {
    if (!canAdmin('pos')) return;
    bindPosApkReleaseForm();

    if (!posApkReleasesUnsubscribe) {
        posApkReleasesUnsubscribe = onSnapshot(
            query(collection(db, 'pos_apk_releases'), orderBy('versionCode', 'desc')),
            snapshot => {
                posApkReleasesData = {};
                snapshot.forEach(docSnap => {
                    posApkReleasesData[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
                });
                renderPosApkReleaseTable();
            },
            error => console.error('Unable to load POS APK releases:', error)
        );
    } else {
        renderPosApkReleaseTable();
    }

    if (!posApkDevicesUnsubscribe) {
        posApkDevicesUnsubscribe = onSnapshot(
            query(collection(db, 'pos_devices'), orderBy('updatedAt', 'desc')),
            snapshot => {
                posApkDevicesData = {};
                snapshot.forEach(docSnap => {
                    posApkDevicesData[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
                });
                renderPosApkDevicesTable();
            },
            error => console.error('Unable to load POS APK devices:', error)
        );
    } else {
        renderPosApkDevicesTable();
    }

    if (!posApkEventsUnsubscribe) {
        posApkEventsUnsubscribe = onSnapshot(
            query(collection(db, 'pos_update_events'), orderBy('createdAt', 'desc'), limit(50)),
            snapshot => {
                posApkEventsData = [];
                snapshot.forEach(docSnap => {
                    posApkEventsData.push({ id: docSnap.id, ...docSnap.data() });
                });
                renderPosApkEventsTable();
            },
            error => console.error('Unable to load POS APK events:', error)
        );
    } else {
        renderPosApkEventsTable();
    }
}
window.refreshPosApkUpdates = () => window.refreshAdminSection('pos-apk-updates');

window.editPosApkRelease = (releaseId) => {
    const release = posApkReleasesData[releaseId];
    if (!release) return;
    document.getElementById('pos-apk-release-id').value = releaseId;
    document.getElementById('pos-apk-app-id').value = release.appId || 'com.personal.pos';
    document.getElementById('pos-apk-version-name').value = release.versionName || '';
    document.getElementById('pos-apk-version-code').value = release.versionCode || '';
    document.getElementById('pos-apk-channel').value = release.channel || 'test';
    document.getElementById('pos-apk-status').value = release.status || 'draft';
    document.getElementById('pos-apk-sha256').value = release.sha256 || '';
    document.getElementById('pos-apk-size').value = release.size || '';
    document.getElementById('pos-apk-min-supported').value = release.minSupportedVersionCode || 0;
    document.getElementById('pos-apk-function-asset').value = release.functionAsset || '';
    document.getElementById('pos-apk-storage-path').value = release.storagePath || '';
    document.getElementById('pos-apk-force-update').checked = release.forceUpdate === true;
    document.getElementById('pos-apk-release-notes').value = release.releaseNotes || '';
    setPosApkFormStatus('Editing ' + releaseId);
};

window.setPosApkReleaseStatus = async (releaseId, status) => {
    if (!canAdmin('pos') || !['active', 'draft', 'revoked'].includes(status)) return;
    const release = posApkReleasesData[releaseId];
    if (!release) return;
    const confirmed = status === 'active'
        ? confirm('Mark this release active for channel ' + (release.channel || '-') + '?')
        : confirm('Change this release status to ' + status + '?');
    if (!confirmed) return;
    try {
        await updateDoc(doc(db, 'pos_apk_releases', releaseId), {
            status,
            updatedBy: auth.currentUser?.uid || '',
            updatedAt: serverTimestamp()
        });
    } catch (error) {
        console.error('Unable to update POS APK release status:', error);
        alert(safeAdminError('Update release status failed'));
    }
};

// ==========================================
// Admin Access / Manager Permission Logic
// ==========================================
function adminRoleBadgeHTML(role) {
    if (STAFF_ROLE_LABELS[role]) {
        return '<span class="access-role-badge access-role-staff">' + escapeHTML(STAFF_ROLE_LABELS[role]) + '</span>';
    }
    const safeRole = ADMIN_ROLE_LABELS[role] ? role : 'manager';
    return '<span class="access-role-badge access-role-' + safeRole + '">' + escapeHTML(ADMIN_ROLE_LABELS[safeRole]) + '</span>';
}

function normalizePermissions(role, permissions = {}) {
    if (role === 'owner' || role === 'head_manager') return adminRoleDefaults(role);
    return { ...adminRoleDefaults('manager'), ...permissions };
}

function renderAdminPermissionInputs(selected = adminRoleDefaults('manager'), disabled = false) {
    const container = document.getElementById('access-permissions');
    if (!container) return;
    container.innerHTML = Object.entries(ADMIN_PERMISSION_LABELS).map(([key, label]) => {
        const help = ADMIN_PERMISSION_HELP[key] || '';
        return `
        <label>
            <input type="checkbox" data-access-permission="${escapeHTML(key)}" ${selected[key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <span class="access-permission-copy">
                <strong>${escapeHTML(label)}</strong>
                ${help ? `<small>${escapeHTML(help)}</small>` : ''}
            </span>
        </label>
    `;
    }).join('');
}

function getSelectedAdminPermissions() {
    const permissions = {};
    document.querySelectorAll('[data-access-permission]').forEach(input => {
        permissions[input.dataset.accessPermission] = input.checked === true;
    });
    return permissions;
}

function setAdminAccessStats(rows) {
    const counts = { owner: 0, head_manager: 0, manager: 0 };
    rows.forEach(row => { counts[row.role] = (counts[row.role] || 0) + 1; });
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = String(value); };
    set('access-stat-total', rows.length);
    set('access-stat-owner', counts.owner || 0);
    set('access-stat-head', counts.head_manager || 0);
    set('access-stat-manager', counts.manager || 0);
}

function renderAdminAccessTable() {
    const tbody = document.getElementById('admin-access-table-body');
    if (!tbody) return;

    const rows = Object.entries(adminAccessData)
        .map(([uid, access]) => ({ uid, ...access }))
        .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : String(a.email).localeCompare(String(b.email))));
    setAdminAccessStats(rows);

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="member-empty-state">ยังไม่มีผู้จัดการในระบบ กรอกอีเมลและตั้งรหัสผ่าน หรือเลือกจากสมาชิกเพื่อเริ่มต้น</div></td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(row => {
        const permissionText = row.role === 'owner' || row.role === 'head_manager'
            ? 'ทุกสิทธิ์'
            : Object.entries(ADMIN_PERMISSION_LABELS)
                .filter(([key]) => row.permissions?.[key])
                .map(([, label]) => label)
                .join(', ') || '-';
        const canDelete = row.uid !== currentAdminAccess?.uid;
        const passwordLoginText = row.passwordLoginEnabled
            ? 'พร้อมใช้'
            : 'ยังไม่ตั้งรหัส';
        return `
            <tr>
                <td><strong>${escapeHTML(row.displayName || 'Manager')}</strong><br><small>${escapeHTML(row.email || '-')}<br>UID: ${escapeHTML(row.uid)}</small></td>
                <td>${adminRoleBadgeHTML(row.role)}</td>
                <td style="max-width:260px;">${escapeHTML(permissionText)}</td>
                <td><span class="access-auth-status ${row.passwordLoginEnabled ? '' : 'pending'}">${escapeHTML(passwordLoginText)}</span></td>
                <td><span class="access-status-${row.status === 'active' ? 'active' : 'paused'}">${escapeHTML(row.status || 'active')}</span></td>
                <td>${formatDate(row.updatedAt || row.createdAt)}</td>
                <td>
                    <button class="btn-action btn-edit" onclick="editAdminAccess('${escapeJSString(row.uid)}')">แก้ไข</button>
                    ${canDelete ? `<button class="btn-action btn-delete" onclick="deleteAdminAccess('${escapeJSString(row.uid)}')">ลบ</button>` : ''}
                </td>
            </tr>`;
    }).join('');
}

function renderAdminUserOptions() {
    const select = document.getElementById('access-user-select');
    if (!select) return;
    const currentValue = select.value;
    const rows = Object.entries(membersData)
        .map(([uid, member]) => ({ uid, member }))
        .sort((a, b) => memberDisplayName(a.member).localeCompare(memberDisplayName(b.member), 'th'));
    select.innerHTML = '<option value="">-- เลือกสมาชิก หรือกรอก UID เอง --</option>' + rows.map(({ uid, member }) =>
        `<option value="${escapeHTML(uid)}">${escapeHTML(memberDisplayName(member))} - ${escapeHTML(member.email || uid)}</option>`
    ).join('');
    if (currentValue && rows.some(row => row.uid === currentValue)) select.value = currentValue;
}

function bindAdminAccessForm() {
    if (adminAccessFormBound) return;
    adminAccessFormBound = true;
    renderAdminPermissionInputs();

    const roleEl = document.getElementById('access-role');
    if (roleEl) {
        roleEl.addEventListener('change', () => {
            const role = roleEl.value;
            renderAdminPermissionInputs(adminRoleDefaults(role), role === 'owner' || role === 'head_manager');
        });
    }

    const select = document.getElementById('access-user-select');
    if (select) {
        select.addEventListener('change', () => {
            const uid = select.value;
            if (!uid || !membersData[uid]) return;
            const member = membersData[uid];
            document.getElementById('access-uid').value = uid;
            document.getElementById('access-email').value = member.email || '';
            document.getElementById('access-display-name').value = memberDisplayName(member);
            const passwordEl = document.getElementById('access-password');
            const confirmEl = document.getElementById('access-password-confirm');
            if (passwordEl) passwordEl.value = '';
            if (confirmEl) confirmEl.value = '';
        });
    }

    const form = document.getElementById('admin-access-form');
    if (form) {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            await saveAdminAccessFromForm();
        });
    }
}

async function saveAdminAccessFromForm() {
    if (!isOwnerAccess()) {
        alert('เฉพาะ Owner เท่านั้นที่จัดการผู้จัดการได้');
        return;
    }

    const uid = document.getElementById('access-uid')?.value.trim();
    const email = normalizeEmail(document.getElementById('access-email')?.value);
    const displayName = document.getElementById('access-display-name')?.value.trim() || 'Manager';
    const password = document.getElementById('access-password')?.value || '';
    const passwordConfirm = document.getElementById('access-password-confirm')?.value || '';
    const role = document.getElementById('access-role')?.value || 'manager';
    const status = document.getElementById('access-status')?.value || 'active';
    if (!email) {
        alert('กรุณากรอกอีเมลผู้จัดการ');
        return;
    }
    if (uid && uid.includes('@')) {
        alert('Firebase UID ต้องไม่ใช่อีเมลครับ ให้ใช้ User UID จาก Firebase Authentication หรือเลือกจาก dropdown สมาชิก');
        return;
    }
    if (password || passwordConfirm) {
        if (password !== passwordConfirm) {
            alert('รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน');
            return;
        }
        if (password.length < 8) {
            alert('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
            return;
        }
    }


    const permissions = normalizePermissions(role, getSelectedAdminPermissions());
    const payload = {
        uid,
        email,
        displayName,
        role,
        status,
        permissions
    };
    if (password) payload.password = password;
    try {
        const result = await callAdminFunction('upsertAdminAccessUser', payload);
        const savedUid = result.uid || uid;
        adminAccessData[savedUid] = {
            ...(adminAccessData[savedUid] || {}),
            uid: savedUid,
            email,
            displayName,
            role,
            status,
            permissions,
            passwordLoginEnabled: result.passwordLoginEnabled !== false,
            updatedAt: new Date().toISOString()
        };
        renderAdminAccessTable();
        alert('บันทึกสิทธิ์ผู้จัดการเรียบร้อยแล้ว' + (result.passwordUpdated ? '\nตั้งรหัสผ่านสำหรับ Email Login แล้ว' : ''));
        resetAdminAccessForm();
    } catch (error) {
        console.error('Unable to save admin access:', error);
        alert(safeAdminError("บันทึกสิทธิ์ผู้จัดการไม่สำเร็จ"));
    }
}

window.editAdminAccess = (uid) => {
    const data = adminAccessData[uid];
    if (!data) return;
    document.getElementById('access-user-select').value = uid;
    document.getElementById('access-uid').value = uid;
    document.getElementById('access-email').value = data.email || '';
    document.getElementById('access-display-name').value = data.displayName || '';
    const passwordEl = document.getElementById('access-password');
    const confirmEl = document.getElementById('access-password-confirm');
    if (passwordEl) passwordEl.value = '';
    if (confirmEl) confirmEl.value = '';
    document.getElementById('access-role').value = data.role || 'manager';
    document.getElementById('access-status').value = data.status || 'active';
    renderAdminPermissionInputs(normalizePermissions(data.role, data.permissions), data.role === 'owner' || data.role === 'head_manager');
};

window.deleteAdminAccess = async (uid) => {
    if (!isOwnerAccess()) {
        alert('เฉพาะ Owner เท่านั้นที่ลบสิทธิ์ผู้จัดการได้');
        return;
    }
    if (uid === currentAdminAccess?.uid) {
        alert('ไม่สามารถลบสิทธิ์ของตัวเองจากหน้านี้ได้ เพื่อป้องกันการล็อกตัวเองออก');
        return;
    }
    if (!confirm('ลบสิทธิ์ผู้จัดการคนนี้ออกจากหลังบ้าน?')) return;
    await deleteDoc(doc(db, ADMIN_COLLECTION, uid));
};

window.resetAdminAccessForm = () => {
    const form = document.getElementById('admin-access-form');
    if (form) form.reset();
    const uidEl = document.getElementById('access-uid');
    const passwordEl = document.getElementById('access-password');
    const confirmEl = document.getElementById('access-password-confirm');
    if (uidEl) uidEl.value = '';
    if (passwordEl) passwordEl.value = '';
    if (confirmEl) confirmEl.value = '';
    renderAdminPermissionInputs(adminRoleDefaults('manager'));
};

window.refreshAdminAccess = () => window.refreshAdminSection('admin-access');

function setupRealtimeAdminAccess() {
    bindAdminAccessForm();
    renderAdminUserOptions();
    if (adminAccessUnsubscribe) adminAccessUnsubscribe();
    adminAccessUnsubscribe = onSnapshot(collection(db, ADMIN_COLLECTION), (snapshot) => {
        adminAccessData = {};
        snapshot.forEach(docSnap => {
            adminAccessData[docSnap.id] = { uid: docSnap.id, ...docSnap.data() };
        });
        renderAdminAccessTable();
        renderMembersTable();
    }, (error) => {
        console.error('Error listening to admin access:', error);
        const tbody = document.getElementById('admin-access-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#c62828;">โหลดสิทธิ์ผู้จัดการไม่สำเร็จ: ${escapeHTML(error.message)}</td></tr>`;
    });
}

// ==========================================
// Member Management Logic
// ==========================================
const MEMBER_STATUS_LABELS = {
    active: 'Active',
    vip: 'VIP',
    review: 'Needs review',
    suspended: 'Suspended'
};

const MEMBER_AUTH_RECOMMENDATIONS = {
    READY_FOR_EMAIL_PHONE_PASSWORD_LOGIN: {
        badge: 'พร้อม Login',
        tone: 'ok',
        title: 'ข้อมูลพร้อมสำหรับ Login ด้วยอีเมล/เบอร์ + รหัสผ่าน',
        detail: 'UID, index และ password_hash พร้อมใช้งานแล้ว หากยัง login ไม่ได้ให้ตรวจฝั่งหน้า Login หรือรหัสที่สมาชิกกรอก'
    },
    SAFE_PASSWORD_SETUP_REQUIRED: {
        badge: 'ต้องตั้งรหัส',
        tone: 'warn',
        title: 'ยังไม่มี password_hash',
        detail: 'เพื่อความปลอดภัย ระบบไม่สามารถกู้รหัสเดิมได้ ต้องให้สมาชิกตั้งรหัสใหม่ผ่านขั้นตอนยืนยันตัวตน'
    },
    REPAIR_PHONE_INDEX: {
        badge: 'ซ่อมได้',
        tone: 'warn',
        title: 'phone_number_index ขาดหรือไม่ตรง',
        detail: 'กดปุ่มซ่อม Index ได้ ระบบจะซ่อมเฉพาะ index ที่ชี้ UID เดิม ไม่แตะรหัสผ่าน'
    },
    UID_CONFLICT_REVIEW_REQUIRED: {
        badge: 'UID ชนกัน',
        tone: 'error',
        title: 'พบ UID มากกว่าหนึ่งชุด',
        detail: 'ต้องตรวจด้วยคนก่อนซ่อม เพื่อเลี่ยงการรวมบัญชีผิดคน'
    },
    MEMBER_NOT_FOUND: {
        badge: 'ไม่พบสมาชิก',
        tone: 'error',
        title: 'ไม่พบข้อมูลสมาชิกจากอีเมล/เบอร์/UID นี้',
        detail: 'ตรวจตัวสะกด เบอร์โทร หรือให้สมาชิกสมัคร/ยืนยันตัวตนใหม่'
    },
    REVIEW_REQUIRED: {
        badge: 'ต้องตรวจเพิ่ม',
        tone: 'warn',
        title: 'ระบบต้องให้แอดมินตรวจรายละเอียดเพิ่ม',
        detail: 'อ่านผลด้านล่างแล้วเลือกซ่อมเฉพาะกรณีที่ UID ชัดเจน'
    }
};

function memberText(value, fallback = '-') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function memberTimestampToDate(value) {
    if (!value) return null;
    if (value.toDate) return value.toDate();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function memberTimestampToMillis(value) {
    const date = memberTimestampToDate(value);
    return date ? date.getTime() : 0;
}

function memberDisplayName(member) {
    return memberText(member.displayName || member.name || member.customerName || (member.email || '').split('@')[0], 'Eden Member');
}

function canonicalMemberCode(uid) {
    const source = String(uid || '000000').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase().padStart(6, '0');
    return 'ED-' + source;
}

function memberCode(uid, member = {}) {
    if (uid || member.uid) return canonicalMemberCode(uid || member.uid);
    return member.memberCode || canonicalMemberCode('');
}

function memberAvatar(member) {
    const fallbackName = encodeURIComponent(memberDisplayName(member));
    return safeImageURL(member.photoURL || member.avatarUrl || member.avatar, 'https://ui-avatars.com/api/?name=' + fallbackName + '&background=4caf50&color=fff');
}

function memberTier(member) {
    return getMemberTier({
        points: safeNumber(member.points),
        totalSpent: safeNumber(member.totalSpent),
        visitCount: safeNumber(member.visitCount)
    });
}

function tierBadgeHTML(tier) {
    const klass = String(tier || 'Silver').toLowerCase();
    return '<span class="tier-badge ' + klass + '">' + escapeHTML(tier || 'Silver') + '</span>';
}

function memberStatus(member) {
    return member.status || 'active';
}

function statusBadgeHTML(status) {
    const safeStatus = MEMBER_STATUS_LABELS[status] ? status : 'active';
    const klass = safeStatus === 'active' ? '' : ' member-status-' + safeStatus;
    return '<span class="member-status-badge' + klass + '">' + escapeHTML(MEMBER_STATUS_LABELS[safeStatus]) + '</span>';
}

function memberStaffAccess(uid) {
    return adminAccessData[uid] || null;
}

function memberStaffAccessBadgeHTML(uid) {
    const access = memberStaffAccess(uid);
    if (!access) return '<span class="member-status-badge">ลูกค้า</span>';
    const statusText = access.status === 'active' ? 'Active' : 'Paused';
    const statusClass = access.status === 'active' ? 'access-status-active' : 'access-status-paused';
    return adminRoleBadgeHTML(access.role) + '<br><small class="' + statusClass + '">' + escapeHTML(statusText) + '</small>';
}

function getSelectedMemberStaffPermissions() {
    const permissions = {};
    document.querySelectorAll('[data-member-staff-permission]').forEach(input => {
        permissions[input.dataset.memberStaffPermission] = input.checked === true;
    });
    return permissions;
}

function memberStaffPermissionInputsHTML(selected = adminRoleDefaults('manager'), disabled = false) {
    return Object.entries(ADMIN_PERMISSION_LABELS).map(([key, label]) => {
        const help = ADMIN_PERMISSION_HELP[key] || '';
        return `
        <label>
            <input type="checkbox" data-member-staff-permission="${escapeHTML(key)}" ${selected[key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <span class="access-permission-copy">
                <strong>${escapeHTML(label)}</strong>
                ${help ? `<small>${escapeHTML(help)}</small>` : ''}
            </span>
        </label>
    `;
    }).join('');
}

function canManageMemberStaffAccess(uid, access = memberStaffAccess(uid)) {
    return isOwnerAccess()
        && uid !== currentAdminAccess?.uid
        && access?.role !== 'owner'
        && access?.role !== 'head_manager';
}

function staffMenuOrderPermissions() {
    return Object.fromEntries([
        ...Object.keys(ADMIN_PERMISSION_LABELS).map(key => [key, false]),
        ['menuOrder', true]
    ]);
}

function memberStaffAccessHTML(uid, member) {
    const access = memberStaffAccess(uid);
    const isSelf = uid === currentAdminAccess?.uid;
    const isOwnerRecord = access?.role === 'owner';
    const canManage = canManageMemberStaffAccess(uid, access);
    const status = access?.status || 'active';
    const currentSummary = access
        ? adminRoleBadgeHTML(access.role) + '<span class="access-status-' + (status === 'active' ? 'active' : 'paused') + '">' + escapeHTML(status) + '</span>'
        : '<span class="member-status-badge">ยังไม่ได้เป็นพนักงาน</span>';

    if (!isOwnerAccess()) {
        return `
            <div class="member-note-box member-staff-card">
                <div class="member-staff-head">
                    <div>
                        <h4>Employee permissions</h4>
                        <div class="member-staff-summary">${currentSummary}</div>
                    </div>
                </div>
                <div class="member-staff-hint">เฉพาะ Owner เท่านั้นที่กำหนดสิทธิ์พนักงานได้</div>
            </div>`;
    }

    if (isOwnerRecord || access?.role === 'head_manager' || isSelf) {
        return `
            <div class="member-note-box member-staff-card">
                <div class="member-staff-head">
                    <div>
                        <h4>Employee permissions</h4>
                        <div class="member-staff-summary">${currentSummary}</div>
                    </div>
                </div>
                <div class="member-staff-hint">${isSelf ? 'บัญชีนี้คือบัญชีที่คุณกำลังใช้งานอยู่ จึงไม่เปิดให้เปลี่ยนสิทธิ์จากหน้า Members' : 'บัญชี Owner/Head Manager ให้จัดการจากหน้า Admin Access เพื่อป้องกันการลดสิทธิ์ผิดบัญชี'}</div>
            </div>`;
    }

    return `
        <div class="member-note-box member-staff-card">
            <div class="member-staff-head">
                <div>
                    <h4>Employee permissions</h4>
                    <div class="member-staff-summary">${currentSummary}</div>
                    <div class="member-staff-hint">พนักงานจะปลดล็อกปุ่ม Add to cart บนหน้าเมนูเท่านั้น ไม่มีสิทธิ์เข้า Admin หรือ POS หลังบ้าน</div>
                </div>
            </div>
            <form id="member-staff-access-form" onsubmit="return saveMemberStaffAccess(event, '${escapeJSString(uid)}')">
                <div class="member-detail-grid">
                    <div class="member-detail-item"><small>Role</small><span>Staff / Menu order only</span></div>
                    <div class="form-group">
                        <label>Status</label>
                        <select id="member-staff-status">
                            <option value="active" ${status === 'active' ? 'selected' : ''}>Active</option>
                            <option value="paused" ${status === 'paused' ? 'selected' : ''}>Paused</option>
                        </select>
                    </div>
                </div>
                <div class="member-staff-actions">
                    <button type="submit" class="btn-submit" style="max-width:220px;">Save employee permissions</button>
                    ${access?.role === 'staff' ? `<button type="button" class="btn-action btn-delete" onclick="deleteMemberStaffAccess('${escapeJSString(uid)}')">Remove staff access</button>` : ''}
                    <span id="member-staff-save-status" style="color:#2e7d32;"></span>
                </div>
            </form>
        </div>`;
}

function memberAuthRecommendationInfo(key) {
    return MEMBER_AUTH_RECOMMENDATIONS[key] || MEMBER_AUTH_RECOMMENDATIONS.REVIEW_REQUIRED;
}

function memberAuthChipHTML(label, value, options = {}) {
    const { positiveLabel = 'พบ', negativeLabel = 'ไม่พบ', invert = false } = options;
    const exists = !!value;
    const good = invert ? !exists : exists;
    const tone = good ? 'ok' : 'warn';
    return `<span class="member-auth-chip ${tone}"><strong>${escapeHTML(label)}</strong> ${escapeHTML(exists ? positiveLabel : negativeLabel)}</span>`;
}

function memberAuthValue(value, fallback = '-') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function memberAuthSetupUrl(mode = 'phone') {
    const path = mode === 'google' ? '/register?google=1' : '/register';
    return new URL(path, window.location.origin).href;
}

function memberAuthSetStatus(message, tone = 'muted') {
    const status = document.getElementById('member-auth-check-status');
    if (!status) return;
    status.textContent = message;
    status.style.color = tone === 'error' ? '#b71c1c' : tone === 'ok' ? '#1b5e20' : '#62736a';
}

function memberAuthSetBadge(info = {}) {
    const badge = document.getElementById('member-auth-check-badge');
    if (!badge) return;
    badge.textContent = info.badge || 'รอการตรวจ';
    badge.className = `member-auth-chip ${info.tone || 'muted'}`;
}

function canRepairMemberAuthDiagnosis(result) {
    const recommendation = result?.recommendation || '';
    const canonicalUid = result?.found?.canonicalUid || result?.input?.requestedUid || '';
    if (!canonicalUid) return false;
    if (recommendation === 'MEMBER_NOT_FOUND' || recommendation === 'UID_CONFLICT_REVIEW_REQUIRED') return false;
    if (recommendation === 'REPAIR_PHONE_INDEX') return true;

    const selected = result?.selected || {};
    const hasEmailInput = !!result?.input?.email;
    const hasPhoneInput = !!result?.input?.phoneLast4;
    return selected.credentialExists === false
        || (hasEmailInput && (selected.emailLowerInUser === false || selected.emailLowerInCredential === false))
        || (hasPhoneInput && (
            selected.phoneInUser === false
            || selected.phoneInCredential === false
            || selected.phoneNumberIndexExists === false
            || selected.phoneNumberIndexMatchesUid === false
        ));
}

function canMergeMemberAuthDiagnosis(result) {
    const candidateUids = Array.isArray(result?.found?.candidateUids) ? result.found.candidateUids.filter(Boolean) : [];
    if (candidateUids.length < 2) return false;
    if (result?.recommendation === 'MEMBER_NOT_FOUND') return false;
    return result?.recommendation === 'UID_CONFLICT_REVIEW_REQUIRED'
        || (result?.found?.uidFromEmail && result?.found?.uidFromPhone && result.found.uidFromEmail !== result.found.uidFromPhone);
}

function memberAuthMergePrimaryUid(result, mode = 'auto') {
    const found = result?.found || {};
    const input = result?.input || {};
    const candidateUids = Array.isArray(found.candidateUids) ? found.candidateUids.filter(Boolean) : [];
    if (mode === 'email') return found.uidFromEmail || '';
    if (mode === 'phone') return found.uidFromPhone || '';
    if (mode === 'requested') return input.requestedUid || '';
    if (input.requestedUid && candidateUids.includes(input.requestedUid)) return input.requestedUid;
    return found.uidFromEmail || found.uidFromPhone || candidateUids[0] || '';
}

function memberAuthMergeActionsHTML(result) {
    if (!canMergeMemberAuthDiagnosis(result)) return '';
    const found = result?.found || {};
    const actions = [];
    if (found.uidFromEmail) {
        actions.push(`<button type="button" class="btn-action btn-delete" data-member-auth-merge="email" onclick="mergeMemberAuthDuplicates('email')">รวมไป UID จากอีเมล</button>`);
    }
    if (found.uidFromPhone && found.uidFromPhone !== found.uidFromEmail) {
        actions.push(`<button type="button" class="btn-action btn-view" data-member-auth-merge="phone" onclick="mergeMemberAuthDuplicates('phone')">รวมไป UID จากเบอร์</button>`);
    }
    actions.push(`<button type="button" class="btn-action btn-edit" data-member-auth-merge="requested" onclick="mergeMemberAuthDuplicates('requested')">รวมไป UID ที่กรอก</button>`);
    return `
        <div class="member-auth-warning-box">
            <strong>รวมสมาชิกซ้ำ</strong><br>
            เลือก UID หลักที่จะเก็บไว้ ระบบจะย้ายประวัติซื้อ/จอง, point ledger, member summary, credentials และ phone index ของ UID รองมารวมกับ UID หลัก
            <div class="member-auth-actions">${actions.join('')}</div>
        </div>
    `;
}

function memberAuthMergeResultHTML(result) {
    if (!result?.ok) return '';
    const counts = result.counts || {};
    const totals = result.totals || {};
    const mergedUids = Array.isArray(result.mergedUids) ? result.mergedUids : [];
    return `
        <div class="member-auth-safe-box">
            <strong>รวมสมาชิกเรียบร้อย</strong><br>
            UID หลัก: <span class="member-auth-code">${escapeHTML(result.primaryUid || '-')}</span><br>
            UID ที่รวมเข้า: <span class="member-auth-code">${escapeHTML(mergedUids.join(', ') || '-')}</span><br>
            ย้ายออเดอร์ ${safeNumber(counts.ordersUpdated)} รายการ, จอง ${safeNumber(counts.bookingsUpdated)} รายการ, ประวัติแต้ม ${safeNumber(counts.pointLedgerUpdated)} รายการ<br>
            คะแนนรวมตอนนี้ ${safeNumber(totals.pointsBalance).toLocaleString('th-TH')} แต้ม, ยอดซื้อรวม ${formatMemberCurrency(totals.totalSpent)}
        </div>
    `;
}

function renderMemberAuthDiagnosis(result) {
    const resultEl = document.getElementById('member-auth-check-result');
    const repairBtn = document.getElementById('member-auth-repair-btn');
    const mergeBtn = document.getElementById('member-auth-merge-btn');
    if (!resultEl) return;

    lastMemberAuthDiagnosis = result;
    const info = memberAuthRecommendationInfo(result?.recommendation);
    const found = result?.found || {};
    const selected = result?.selected || {};
    const repair = result?.repair || {};
    const canRepair = canRepairMemberAuthDiagnosis(result);
    const canMerge = canMergeMemberAuthDiagnosis(result);

    memberAuthSetBadge(info);
    memberAuthSetStatus(info.title, info.tone);
    if (repairBtn) repairBtn.disabled = !canRepair;
    if (mergeBtn) mergeBtn.disabled = !canMerge;

    const uidRows = [
        ['UID จากอีเมล', found.uidFromEmail],
        ['UID จากเบอร์', found.uidFromPhone],
        ['UID หลักที่ระบบเลือก', found.canonicalUid],
        ['UID ที่พบทั้งหมด', Array.isArray(found.candidateUids) && found.candidateUids.length ? found.candidateUids.join(', ') : '']
    ].map(([label, value]) => `
        <div class="member-detail-item">
            <small>${escapeHTML(label)}</small>
            <span class="member-auth-code">${escapeHTML(memberAuthValue(value))}</span>
        </div>
    `).join('');

    const statusChips = [
        memberAuthChipHTML('users doc', selected.userExists, { positiveLabel: 'มี', negativeLabel: 'ไม่มี' }),
        memberAuthChipHTML('user_credentials', selected.credentialExists, { positiveLabel: 'มี', negativeLabel: 'ไม่มี' }),
        memberAuthChipHTML('password_hash', selected.hasPasswordHash, { positiveLabel: 'มี', negativeLabel: 'ไม่มี' }),
        memberAuthChipHTML('email_lower ใน users', selected.emailLowerInUser, { positiveLabel: 'ตรง', negativeLabel: 'ขาด/ไม่ตรง' }),
        memberAuthChipHTML('email_lower ใน credentials', selected.emailLowerInCredential, { positiveLabel: 'ตรง', negativeLabel: 'ขาด/ไม่ตรง' }),
        memberAuthChipHTML('เบอร์ใน users', selected.phoneInUser, { positiveLabel: 'ตรง', negativeLabel: 'ขาด/ไม่ตรง' }),
        memberAuthChipHTML('เบอร์ใน credentials', selected.phoneInCredential, { positiveLabel: 'ตรง', negativeLabel: 'ขาด/ไม่ตรง' }),
        memberAuthChipHTML('phone_number_index', selected.phoneNumberIndexMatchesUid || selected.phoneNumberIndexExists, { positiveLabel: selected.phoneNumberIndexMatchesUid ? 'ตรง UID' : 'มีแต่ต้องตรวจ', negativeLabel: 'ไม่มี' }),
        memberAuthChipHTML('UID อีเมล/เบอร์', found.uidMatches || (!found.uidFromEmail || !found.uidFromPhone), { positiveLabel: found.uidMatches ? 'ตรงกัน' : 'มีฝั่งเดียว', negativeLabel: 'ไม่ตรงกัน' })
    ].join('');

    const repairMessage = repair.requested
        ? repair.performed
            ? `<div class="member-auth-safe-box"><strong>ซ่อม Index แล้ว</strong><br>credentials: ${safeNumber(repair.stats?.credentialLinksRepaired)} รายการ, phone index: ${safeNumber(repair.stats?.phoneIndexesRepaired)} รายการ, conflict: ${safeNumber(repair.stats?.phoneIndexConflicts)} รายการ</div>`
            : `<div class="member-auth-warning-box"><strong>ยังไม่ได้ซ่อม</strong><br>เหตุผล: ${escapeHTML(repair.skippedReason || 'ระบบไม่พบรายการที่ซ่อมได้อย่างปลอดภัย')}</div>`
        : '';

    const passwordSetupBox = selected.hasPasswordHash === false || result?.recommendation === 'SAFE_PASSWORD_SETUP_REQUIRED'
        ? `
            <div class="member-auth-warning-box">
                <strong>สมาชิกยังไม่มี password_hash</strong><br>
                ระบบไม่สามารถกู้รหัสผ่านเดิมได้ ให้เจ้าของบัญชีตั้งรหัสใหม่ผ่านการยืนยันตัวตนเท่านั้น
                <div class="member-auth-actions">
                    <button type="button" class="btn-action" onclick="openMemberPasswordSetup('phone')">เปิดหน้าตั้งรหัสด้วยเบอร์ OTP</button>
                    <button type="button" class="btn-action btn-view" onclick="openMemberPasswordSetup('google')">เปิดหน้าตั้งรหัสด้วย Google</button>
                    <button type="button" class="btn-action btn-edit" onclick="copyMemberPasswordSetupLink('phone')">คัดลอกลิงก์เบอร์ OTP</button>
                </div>
            </div>
        `
        : '';
    const mergeActionsBox = memberAuthMergeActionsHTML(result);
    const mergeResultBox = memberAuthMergeResultHTML(lastMemberAuthMergeResult);

    resultEl.hidden = false;
    resultEl.innerHTML = `
        <div class="member-auth-safe-box">
            <strong>${escapeHTML(info.title)}</strong><br>
            ${escapeHTML(info.detail)}
        </div>
        ${mergeResultBox}
        ${repairMessage}
        ${mergeActionsBox}
        ${passwordSetupBox}
        <div class="member-detail-grid" style="margin-top:12px;">${uidRows}</div>
        <div class="member-auth-status-grid">${statusChips}</div>
        <div class="member-auth-code">
            อีเมลที่ตรวจ: ${escapeHTML(result?.input?.email || '-')} |
            เบอร์ท้าย: ${escapeHTML(result?.input?.phoneLast4 || '-')} |
            UID ที่ระบุ: ${escapeHTML(result?.input?.requestedUid || '-')}
        </div>
    `;
}

async function mergeMemberAuthDuplicates(mode = 'auto') {
    const diagnosis = lastMemberAuthDiagnosis;
    if (!canMergeMemberAuthDiagnosis(diagnosis)) {
        alert('ต้องตรวจแล้วพบ UID ซ้ำก่อน จึงจะรวมสมาชิกได้');
        return;
    }

    const found = diagnosis.found || {};
    const candidateUids = Array.isArray(found.candidateUids) ? found.candidateUids.filter(Boolean) : [];
    const primaryUid = memberAuthMergePrimaryUid(diagnosis, mode);
    const duplicateUids = candidateUids.filter(uid => uid && uid !== primaryUid);
    if (!primaryUid || !duplicateUids.length) {
        alert('ไม่พบ UID หลักหรือ UID รองสำหรับรวม กรุณากรอก UID หลักแล้วลองใหม่');
        return;
    }
    if (!candidateUids.includes(primaryUid)) {
        alert('UID หลักต้องอยู่ในชุด UID ที่ระบบตรวจพบ');
        return;
    }

    const email = String(document.getElementById('member-auth-email')?.value || '').trim();
    const phoneNumber = String(document.getElementById('member-auth-phone')?.value || '').trim();
    const confirmed = confirm([
        'ยืนยันรวมสมาชิกซ้ำ?',
        '',
        `UID หลักที่จะเก็บไว้: ${primaryUid}`,
        `UID ที่จะรวมเข้า: ${duplicateUids.join(', ')}`,
        '',
        'ระบบจะย้ายประวัติซื้อ/จอง คะแนน และ point ledger ไป UID หลัก'
    ].join('\n'));
    if (!confirmed) return;

    const mergeBtn = document.getElementById('member-auth-merge-btn');
    const repairBtn = document.getElementById('member-auth-repair-btn');
    const submitBtn = document.querySelector('#member-auth-check-form button[type="submit"]');
    const actionButtons = document.querySelectorAll('[data-member-auth-merge]');
    try {
        if (mergeBtn) mergeBtn.disabled = true;
        if (repairBtn) repairBtn.disabled = true;
        if (submitBtn) submitBtn.disabled = true;
        actionButtons.forEach(button => { button.disabled = true; });
        memberAuthSetBadge({ badge: 'กำลังรวม', tone: 'warn' });
        memberAuthSetStatus('กำลังรวมสมาชิกและย้ายประวัติ...', 'warn');
        const result = await callAdminFunction('mergeDuplicateMemberAccounts', {
            email,
            phoneNumber,
            primaryUid,
            duplicateUids
        });
        lastMemberAuthMergeResult = result;
        memberAuthSetBadge({ badge: 'รวมแล้ว', tone: 'ok' });
        memberAuthSetStatus('รวมสมาชิกเรียบร้อย กำลังตรวจข้อมูลล่าสุด...', 'ok');
        await diagnoseMemberAuthLogin();
    } catch (error) {
        console.error('Member merge failed:', error);
        memberAuthSetBadge({ badge: 'รวมไม่สำเร็จ', tone: 'error' });
        memberAuthSetStatus(error.message || 'รวมสมาชิกไม่สำเร็จ', 'error');
        const resultEl = document.getElementById('member-auth-check-result');
        if (resultEl) {
            resultEl.hidden = false;
            resultEl.insertAdjacentHTML('afterbegin', `<div class="member-auth-warning-box"><strong>รวมสมาชิกไม่สำเร็จ</strong><br>${escapeHTML(error.message || safeAdminError('รวมสมาชิกไม่สำเร็จ'))}</div>`);
        }
    } finally {
        if (submitBtn) submitBtn.disabled = false;
        if (repairBtn) repairBtn.disabled = !canRepairMemberAuthDiagnosis(lastMemberAuthDiagnosis);
        if (mergeBtn) mergeBtn.disabled = !canMergeMemberAuthDiagnosis(lastMemberAuthDiagnosis);
        document.querySelectorAll('[data-member-auth-merge]').forEach(button => {
            button.disabled = !canMergeMemberAuthDiagnosis(lastMemberAuthDiagnosis);
        });
    }
}

async function diagnoseMemberAuthLogin(options = {}) {
    const repair = options.repair === true;
    const email = String(document.getElementById('member-auth-email')?.value || '').trim();
    const phoneNumber = String(document.getElementById('member-auth-phone')?.value || '').trim();
    const uid = String(document.getElementById('member-auth-uid')?.value || '').trim();
    const resultEl = document.getElementById('member-auth-check-result');
    const repairBtn = document.getElementById('member-auth-repair-btn');
    const mergeBtn = document.getElementById('member-auth-merge-btn');
    const submitBtn = document.querySelector('#member-auth-check-form button[type="submit"]');

    if (!email && !phoneNumber && !uid) {
        memberAuthSetBadge({ badge: 'กรอกข้อมูลก่อน', tone: 'warn' });
        memberAuthSetStatus('กรุณาใส่อีเมล เบอร์โทร หรือ UID อย่างน้อย 1 ช่อง', 'error');
        return;
    }

    try {
        if (submitBtn) submitBtn.disabled = true;
        if (repairBtn) repairBtn.disabled = true;
        if (mergeBtn) mergeBtn.disabled = true;
        if (resultEl && !repair) resultEl.hidden = true;
        memberAuthSetBadge({ badge: repair ? 'กำลังซ่อม' : 'กำลังตรวจ', tone: 'muted' });
        memberAuthSetStatus(repair ? 'กำลังซ่อม index อย่างปลอดภัย...' : 'กำลังตรวจข้อมูล login สมาชิก...');

        const result = await callAdminFunction('diagnoseMemberAuthLink', { email, phoneNumber, uid, repair });
        renderMemberAuthDiagnosis(result);
    } catch (error) {
        console.error('Member auth diagnosis failed:', error);
        memberAuthSetBadge({ badge: 'ตรวจไม่สำเร็จ', tone: 'error' });
        memberAuthSetStatus(error.message || 'ตรวจ Login สมาชิกไม่สำเร็จ', 'error');
        if (resultEl) {
            resultEl.hidden = false;
            resultEl.innerHTML = `<div class="member-auth-warning-box"><strong>ตรวจไม่สำเร็จ</strong><br>${escapeHTML(error.message || safeAdminError('ตรวจ Login สมาชิกไม่สำเร็จ'))}</div>`;
        }
    } finally {
        if (submitBtn) submitBtn.disabled = false;
        if (repairBtn) repairBtn.disabled = !canRepairMemberAuthDiagnosis(lastMemberAuthDiagnosis);
        if (mergeBtn) mergeBtn.disabled = !canMergeMemberAuthDiagnosis(lastMemberAuthDiagnosis);
    }
}

function bindMemberAuthDiagnostics() {
    if (memberAuthDiagnosticsBound) return;
    const form = document.getElementById('member-auth-check-form');
    const repairBtn = document.getElementById('member-auth-repair-btn');
    const mergeBtn = document.getElementById('member-auth-merge-btn');
    if (form) {
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            lastMemberAuthMergeResult = null;
            diagnoseMemberAuthLogin();
        });
    }
    if (repairBtn) {
        repairBtn.addEventListener('click', () => diagnoseMemberAuthLogin({ repair: true }));
    }
    if (mergeBtn) {
        mergeBtn.addEventListener('click', () => mergeMemberAuthDuplicates('auto'));
    }
    memberAuthDiagnosticsBound = true;
}

window.mergeMemberAuthDuplicates = mergeMemberAuthDuplicates;

window.openMemberPasswordSetup = (mode = 'phone') => {
    window.open(memberAuthSetupUrl(mode), '_blank', 'noopener');
};

window.copyMemberPasswordSetupLink = async (mode = 'phone') => {
    const url = memberAuthSetupUrl(mode);
    try {
        await navigator.clipboard.writeText(url);
        alert('คัดลอกลิงก์ตั้งรหัสแล้ว: ' + url);
    } catch (error) {
        alert('ลิงก์ตั้งรหัส: ' + url);
    }
};

function formatMemberCurrency(value) {
    return 'THB ' + safeNumber(value).toLocaleString('th-TH');
}

function bindMemberFilters() {
    if (memberFiltersBound) return;
    ['member-search', 'member-tier-filter', 'member-status-filter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', renderMembersTable);
        if (el) el.addEventListener('change', renderMembersTable);
    });
    memberFiltersBound = true;
}

function memberOrderUid(order = {}) {
    const customerUid = String(order.customerUid || '').trim();
    if (customerUid) return customerUid;
    const source = String(order.source || '').toLowerCase();
    if (source === 'pos') return String(order.userId || order.memberUid || '').trim();
    return String(order.uid || order.userId || order.memberUid || '').trim();
}

function memberBookingUid(booking = {}) {
    return String(booking.uid || booking.customerUid || booking.userId || booking.memberUid || '').trim();
}

function memberOrderTotal(order = {}) {
    return safeNumber(order.totalAmount ?? order.total ?? order.amount);
}

function isPaidLikeMemberOrder(order = {}) {
    const status = String(order.status || '').toLowerCase();
    const paymentStatus = String(order.paymentStatus || '').toLowerCase();
    if (status === 'cancelled' || paymentStatus === 'refunded' || paymentStatus === 'failed') return false;
    if (paymentStatus) return paymentStatus === 'paid';
    return status === 'paid' || status === 'completed';
}

function latestMemberMetricDate(current, candidate) {
    return memberTimestampToMillis(candidate) > memberTimestampToMillis(current) ? candidate : current;
}

function buildMemberOrderMetrics(snapshot) {
    const metrics = {};
    snapshot.forEach(docSnap => {
        const order = docSnap.data() || {};
        const uid = memberOrderUid(order);
        if (!uid || !isPaidLikeMemberOrder(order)) return;
        const current = metrics[uid] || { totalSpent: 0, orderCount: 0, updatedAt: null };
        current.totalSpent += memberOrderTotal(order);
        current.orderCount += 1;
        current.updatedAt = latestMemberMetricDate(current.updatedAt, order.timestamp || order.createdAt || order.updatedAt);
        metrics[uid] = current;
    });
    return metrics;
}

function buildMemberBookingMetrics(snapshot) {
    const metrics = {};
    snapshot.forEach(docSnap => {
        const booking = docSnap.data() || {};
        const uid = memberBookingUid(booking);
        if (!uid) return;
        const current = metrics[uid] || { bookingCount: 0, updatedAt: null };
        current.bookingCount += 1;
        current.updatedAt = latestMemberMetricDate(current.updatedAt, booking.timestamp || booking.createdAt || booking.updatedAt);
        metrics[uid] = current;
    });
    return metrics;
}

function memberMetricMax(...values) {
    return Math.max(...values.map(value => safeNumber(value)));
}

function enrichMemberMetrics(uid, member = {}) {
    const summary = memberSummariesData[uid] || {};
    const summaryPoints = summary.pointsBalance ?? summary.points;
    const summaryTotalSpent = summary.totalSpent;
    const summaryVisitCount = summary.visitCount;
    const summaryOrderCount = summary.orderCount;
    const summaryBookingCount = summary.bookingCount;
    return {
        ...member,
        points: summaryPoints != null ? Math.max(0, safeNumber(summaryPoints)) : Math.max(0, safeNumber(member.points)),
        totalSpent: summaryTotalSpent != null ? Math.max(0, safeNumber(summaryTotalSpent)) : Math.max(0, safeNumber(member.totalSpent)),
        visitCount: summaryVisitCount != null ? Math.max(0, safeNumber(summaryVisitCount)) : Math.max(0, safeNumber(member.visitCount)),
        orderCount: summaryOrderCount != null ? Math.max(0, safeNumber(summaryOrderCount)) : Math.max(0, safeNumber(member.orderCount)),
        bookingCount: summaryBookingCount != null ? Math.max(0, safeNumber(summaryBookingCount)) : Math.max(0, safeNumber(member.bookingCount)),
        _memberSummary: summary
    };
}

function rebuildMembersData() {
    membersData = Object.fromEntries(
        Object.entries(memberUsersData || {}).map(([uid, member]) => [uid, enrichMemberMetrics(uid, member)])
    );
    renderMembersTable();
    renderAdminUserOptions();
    renderLoyaltyMemberOptions();
    renderArcheryMemberOptions();
    renderLoyaltySummary();
    renderDashboardSalesReport();
}

function getMemberRows() {
    return Object.entries(membersData).map(([uid, member]) => ({ uid, member, tier: memberTier(member), status: memberStatus(member) }));
}

function filteredMemberRows() {
    const search = String(document.getElementById('member-search')?.value || '').trim().toLowerCase();
    const tier = document.getElementById('member-tier-filter')?.value || 'all';
    const status = document.getElementById('member-status-filter')?.value || 'all';

    return getMemberRows().filter(row => {
        const m = row.member;
        const haystack = [row.uid, memberDisplayName(m), m.email, m.phone, m.lineId, memberCode(row.uid, m), m.shippingAddress, m.adminNote]
            .map(value => String(value || '').toLowerCase()).join(' ');

        return (!search || haystack.includes(search))
            && (tier === 'all' || row.tier === tier)
            && (status === 'all' || row.status === status);
    }).sort((a, b) => memberTimestampToMillis(b.member.updatedAt || b.member.createdAt) - memberTimestampToMillis(a.member.updatedAt || a.member.createdAt));
}

function renderMemberSummary() {
    const rows = getMemberRows();
    const counts = { Silver: 0, Gold: 0, Platinum: 0 };
    const now = new Date();
    let newMonth = 0;

    rows.forEach(row => {
        counts[row.tier] = (counts[row.tier] || 0) + 1;
        const created = memberTimestampToDate(row.member.createdAt);
        if (created && created.getFullYear() === now.getFullYear() && created.getMonth() === now.getMonth()) newMonth++;
    });

    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value.toLocaleString('th-TH'); };
    setText('member-stat-total', rows.length);
    setText('member-stat-silver', counts.Silver || 0);
    setText('member-stat-gold', counts.Gold || 0);
    setText('member-stat-platinum', counts.Platinum || 0);
    setText('member-stat-new-month', newMonth);
}

function renderMembersTable() {
    const tbody = document.getElementById('members-table-body');
    if (!tbody) return;

    renderMemberSummary();
    const rows = filteredMemberRows();
    const countEl = document.getElementById('member-filter-count');
    if (countEl) countEl.textContent = rows.length.toLocaleString('th-TH') + ' records';

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="10"><div class="member-empty-state">No members match the selected filters.</div></td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(({ uid, member, tier, status }) => {
        const lastDate = member.updatedAt || member.lastLoginAt || member.createdAt;
        return `
            <tr>
                <td>
                    <div class="member-name-cell">
                        <img class="member-table-avatar" src="${memberAvatar(member)}" alt="${escapeHTML(memberDisplayName(member))}">
                        <div>
                            <strong>${escapeHTML(memberDisplayName(member))}</strong>
                            <small>${escapeHTML(member.email || '-')}<br>${escapeHTML(memberCode(uid, member))}</small>
                        </div>
                    </div>
                </td>
                <td>${escapeHTML(memberText(member.phone))}<br><small style="color:#778;">LINE: ${escapeHTML(memberText(member.lineId))}</small></td>
                <td>${tierBadgeHTML(tier)}</td>
                <td>${safeNumber(member.points).toLocaleString('th-TH')}</td>
                <td>${formatMemberCurrency(member.totalSpent)}</td>
                <td>${safeNumber(member.visitCount).toLocaleString('th-TH')}</td>
                <td>${statusBadgeHTML(status)}</td>
                <td>${memberStaffAccessBadgeHTML(uid)}</td>
                <td>${formatDate(lastDate)}</td>
                <td><button class="btn-action btn-view" onclick="openMemberModal('${escapeJSString(uid)}')">Details / สิทธิ์</button></td>
            </tr>`;
    }).join('');
}

function setupRealtimeMembers() {
    bindMemberFilters();
    bindMemberAuthDiagnostics();
    if (membersUnsubscribe) membersUnsubscribe();
    if (memberSummariesUnsubscribe) memberSummariesUnsubscribe();
    if (memberOrdersMetricsUnsubscribe) memberOrdersMetricsUnsubscribe();
    if (memberBookingsMetricsUnsubscribe) memberBookingsMetricsUnsubscribe();

    memberUsersData = {};
    memberSummariesData = {};
    memberOrdersMetrics = {};
    memberBookingsMetrics = {};
    memberOrdersMetricsUnsubscribe = null;
    memberBookingsMetricsUnsubscribe = null;

    const q = query(collection(db, 'users'));
    membersUnsubscribe = onSnapshot(q, (snapshot) => {
        memberUsersData = {};
        snapshot.forEach(docSnap => {
            memberUsersData[docSnap.id] = { uid: docSnap.id, ...docSnap.data() };
        });
        rebuildMembersData();
    }, (error) => {
        console.error('Error listening to members:', error);
        const tbody = document.getElementById('members-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:#c62828;">Unable to load members: ${escapeHTML(error.message)}</td></tr>`;
    });

    memberSummariesUnsubscribe = onSnapshot(collection(db, 'member_summaries'), (snapshot) => {
        memberSummariesData = {};
        snapshot.forEach(docSnap => {
            memberSummariesData[docSnap.id] = { uid: docSnap.id, ...docSnap.data() };
        });
        rebuildMembersData();
    }, (error) => {
        console.warn('Unable to load member summaries for member metrics:', error);
        memberSummariesData = {};
        rebuildMembersData();
    });

}

window.refreshMembers = () => window.refreshAdminSection('members');

function csvEscape(value) {
    const text = String(value ?? '');
    return '"' + text.replace(/"/g, '""') + '"';
}

window.exportMembersCSV = () => {
    const rows = filteredMemberRows();
    const header = ['uid', 'memberCode', 'name', 'email', 'phone', 'lineId', 'tier', 'points', 'totalSpent', 'visitCount', 'status', 'updatedAt'];
    const body = rows.map(({ uid, member, tier, status }) => [
        uid,
        memberCode(uid, member),
        memberDisplayName(member),
        member.email || '',
        member.phone || '',
        member.lineId || '',
        tier,
        safeNumber(member.points),
        safeNumber(member.totalSpent),
        safeNumber(member.visitCount),
        status,
        formatDate(member.updatedAt || member.createdAt)
    ].map(csvEscape).join(','));

    const csv = '\ufeff' + [header.map(csvEscape).join(','), ...body].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eden-members-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
};

async function loadMemberActivity(uid) {
    const [customerOrdersSnap, legacyOrdersSnap, uidBookingsSnap, customerBookingsSnap, memberBookingsSnap] = await Promise.all([
        getDocs(query(collection(db, 'orders'), where('customerUid', '==', uid))).catch(() => ({ docs: [], forEach: () => {} })),
        getDocs(query(collection(db, 'orders'), where('uid', '==', uid))).catch(() => ({ docs: [], forEach: () => {} })),
        getDocs(query(collection(db, 'bookings'), where('uid', '==', uid))).catch(() => ({ docs: [] })),
        getDocs(query(collection(db, 'bookings'), where('customerUid', '==', uid))).catch(() => ({ docs: [] })),
        getDocs(query(collection(db, 'bookings'), where('member_id', '==', uid))).catch(() => ({ docs: [] }))
    ]);

    const ordersById = new Map();
    [...customerOrdersSnap.docs, ...legacyOrdersSnap.docs].forEach(docSnap => {
        const order = { id: docSnap.id, ...docSnap.data() };
        const customerUid = String(order.customerUid || '').trim();
        const orderUid = String(order.uid || '').trim();
        const source = String(order.source || '').toLowerCase();
        if (order.isTestOrder === true) return;
        if (customerUid ? customerUid === uid : (orderUid === uid && source !== 'pos')) {
            ordersById.set(docSnap.id, order);
        }
    });
    const orders = Array.from(ordersById.values());
    const bookingsById = new Map();
    [...uidBookingsSnap.docs, ...customerBookingsSnap.docs, ...memberBookingsSnap.docs]
        .forEach(docSnap => bookingsById.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
    const bookings = Array.from(bookingsById.values());

    orders.sort((a, b) => memberTimestampToMillis(b.timestamp || b.createdAt) - memberTimestampToMillis(a.timestamp || a.createdAt));
    bookings.sort((a, b) => memberTimestampToMillis(b.timestamp || b.createdAt) - memberTimestampToMillis(a.timestamp || a.createdAt));
    return { orders, bookings };
}

function renderActivityItems(items, type) {
    if (!items.length) return '<div class="member-empty-state">No history yet</div>';
    return items.slice(0, 8).map(item => {
        const orderLabel = item.receiptNo || item.orderNumber || item.id.slice(0, 8).toUpperCase();
        const title = type === 'order'
            ? `Order ${escapeHTML(orderLabel)}`
            : `${escapeHTML(item.bookingType || 'booking')} - ${escapeHTML(item.date || '-')}`;
        const right = type === 'order'
            ? formatMemberCurrency(item.totalAmount || item.total)
            : escapeHTML(item.status || 'pending');
        const sub = type === 'order'
            ? `${formatDate(item.timestamp || item.createdAt)} - ${escapeHTML(item.status || 'pending')}`
            : `${escapeHTML(item.startTime || item.arrivalTime || '-')} - ${escapeHTML(item.phone || '-')}`;
        return `<div class="member-activity-item"><div><strong>${title}</strong><br><small>${sub}</small></div><strong>${right}</strong></div>`;
    }).join('');
}

function renderMemberDetail(uid, member, activity = { orders: [], bookings: [] }) {
    const tier = memberTier(member);
    const benefits = getTierBenefits(tier, 'th');
    return `
        <div class="member-detail-head">
            <img src="${memberAvatar(member)}" alt="${escapeHTML(memberDisplayName(member))}">
            <div>
                <h3>${escapeHTML(memberDisplayName(member))}</h3>
                <p>${escapeHTML(member.email || '-')} - ${escapeHTML(memberCode(uid, member))}</p>
                <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">${tierBadgeHTML(tier)} ${statusBadgeHTML(memberStatus(member))}</div>
            </div>
        </div>

        <div class="member-mini-grid">
            <div class="member-mini-card"><small>Points</small><strong>${safeNumber(member.points).toLocaleString('th-TH')}</strong></div>
            <div class="member-mini-card"><small>Total spent</small><strong>${formatMemberCurrency(member.totalSpent)}</strong></div>
            <div class="member-mini-card"><small>Visits</small><strong>${safeNumber(member.visitCount).toLocaleString('th-TH')}</strong></div>
        </div>

        <div class="member-detail-grid">
            <div class="member-detail-item"><small>Phone</small><span>${escapeHTML(memberText(member.phone))}</span></div>
            <div class="member-detail-item"><small>LINE ID</small><span>${escapeHTML(memberText(member.lineId))}</span></div>
            <div class="member-detail-item"><small>Birthday</small><span>${escapeHTML(memberText(member.birthDate))}</span></div>
            <div class="member-detail-item"><small>Shipping address</small><span>${escapeHTML(memberText(member.shippingAddress))}</span></div>
            <div class="member-detail-item"><small>Allergies</small><span>${escapeHTML(memberText(member.allergies))}</span></div>
            <div class="member-detail-item"><small>Health note</small><span>${escapeHTML(memberText(member.healthNote))}</span></div>
        </div>

        <div class="member-note-box">
            <form id="member-admin-form" onsubmit="return saveMemberAdminFields(event, '${escapeJSString(uid)}')">
                <div class="form-group">
                    <label>Member status</label>
                    <select id="member-admin-status">
                        ${Object.entries(MEMBER_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${memberStatus(member) === value ? 'selected' : ''}>${label}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Admin tags such as VIP, Corporate, Garden lover</label>
                    <input type="text" id="member-admin-tags" value="${escapeHTML(Array.isArray(member.adminTags) ? member.adminTags.join(', ') : (member.adminTags || ''))}">
                </div>
                <div class="form-group">
                    <label>Admin note</label>
                    <textarea id="member-admin-note" placeholder="Example: prefers Garden zone / dairy allergy / call before delivery">${escapeHTML(member.adminNote || '')}</textarea>
                </div>
                <button type="submit" class="btn-submit" style="max-width:220px;">Save admin info</button>
                <span id="member-admin-save-status" style="margin-left:12px; color:#2e7d32;"></span>
            </form>
        </div>

        ${memberStaffAccessHTML(uid, member)}

        <div class="member-detail-grid">
            <div class="member-detail-item">
                <small>Current benefits</small>
                <span>${benefits.map(item => `- ${escapeHTML(item)}`).join('<br>')}</span>
            </div>
            <div class="member-detail-item">
                <small>System info</small>
                <span>Created: ${formatDate(member.createdAt)}<br>Updated: ${formatDate(member.updatedAt)}<br>UID: ${escapeHTML(uid)}</span>
            </div>
        </div>

        <div class="member-detail-grid">
            <div class="member-detail-item">
                <small>Recent orders</small>
                <div class="member-activity-list">${renderActivityItems(activity.orders, 'order')}</div>
            </div>
            <div class="member-detail-item">
                <small>Recent bookings</small>
                <div class="member-activity-list">${renderActivityItems(activity.bookings, 'booking')}</div>
            </div>
        </div>`;
}

window.openMemberModal = async (uid) => {
    const member = membersData[uid];
    const modal = document.getElementById('memberModal');
    const content = document.getElementById('member-detail-content');
    if (!member || !modal || !content) return;

    content.innerHTML = '<div class="member-empty-state">Loading member details...</div>';
    modal.style.display = 'block';

    try {
        const activity = await loadMemberActivity(uid);
        content.innerHTML = renderMemberDetail(uid, member, activity);
    } catch (error) {
        console.error('Unable to load member activity:', error);
        content.innerHTML = renderMemberDetail(uid, member) + `<div class="member-empty-state" style="color:#c62828;">Unable to load order/booking history: ${escapeHTML(error.message)}</div>`;
    }
};

window.closeMemberModal = () => {
    const modal = document.getElementById('memberModal');
    if (modal) modal.style.display = 'none';
};

window.saveMemberAdminFields = async (event, uid) => {
    event.preventDefault();
    const statusEl = document.getElementById('member-admin-save-status');
    const tagsText = document.getElementById('member-admin-tags')?.value || '';
    const adminTags = tagsText.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 20);
    const payload = {
        status: document.getElementById('member-admin-status')?.value || 'active',
        adminTags,
        adminNote: document.getElementById('member-admin-note')?.value || '',
        updatedAt: serverTimestamp()
    };

    try {
        await updateDoc(doc(db, 'users', uid), payload);
        if (statusEl) {
            statusEl.textContent = 'Saved';
            statusEl.style.color = '#2e7d32';
        }
        memberUsersData[uid] = { ...(memberUsersData[uid] || membersData[uid] || {}), ...payload, updatedAt: new Date().toISOString() };
        rebuildMembersData();
    } catch (error) {
        console.error('Unable to save member admin fields:', error);
        if (statusEl) {
            statusEl.textContent = 'Save failed: ' + error.message;
            statusEl.style.color = '#c62828';
        } else {
            alert(safeAdminError('Save failed'));
        }
    }
    return false;
};

window.syncMemberStaffRolePermissions = (role) => {
    const container = document.getElementById('member-staff-permissions');
    if (!container) return;
    const safeRole = role === 'head_manager' ? 'head_manager' : 'manager';
    const disabled = safeRole === 'head_manager';
    container.innerHTML = memberStaffPermissionInputsHTML(adminRoleDefaults(safeRole), disabled);
};

window.saveMemberStaffAccess = async (event, uid) => {
    event.preventDefault();
    const statusEl = document.getElementById('member-staff-save-status');
    const member = membersData[uid];
    const access = memberStaffAccess(uid);

    if (!member) {
        alert('ไม่พบสมาชิกคนนี้ในระบบ');
        return false;
    }
    if (!canManageMemberStaffAccess(uid, access)) {
        alert('เฉพาะ Owner เท่านั้นที่กำหนดสิทธิ์พนักงานได้ และไม่สามารถแก้บัญชีตัวเองหรือบัญชี Owner จากหน้า Members');
        return false;
    }

    const email = normalizeEmail(member.email);
    if (!email) {
        alert('สมาชิกคนนี้ยังไม่มีอีเมล จึงยังเปิดสิทธิ์พนักงานไม่ได้');
        return false;
    }

    const role = 'staff';
    const status = document.getElementById('member-staff-status')?.value === 'paused' ? 'paused' : 'active';
    const permissions = staffMenuOrderPermissions();
    const payload = {
        uid,
        email,
        displayName: memberDisplayName(member),
        role,
        status,
        permissions
    };

    try {
        if (statusEl) {
            statusEl.textContent = 'Saving...';
            statusEl.style.color = '#607466';
        }
        const accessPayload = {
            uid,
            email,
            displayName: payload.displayName,
            role,
            status,
            permissions,
            createdAt: access?.createdAt || serverTimestamp(),
            createdBy: access?.createdBy || auth.currentUser?.uid || '',
            updatedAt: serverTimestamp(),
            updatedBy: auth.currentUser?.uid || ''
        };
        await setDoc(doc(db, ADMIN_COLLECTION, uid), accessPayload);
        adminAccessData[uid] = {
            ...accessPayload,
            updatedAt: new Date().toISOString()
        };
        renderMembersTable();
        renderAdminAccessTable();
        renderAdminUserOptions();
        if (statusEl) {
            statusEl.textContent = 'Saved';
            statusEl.style.color = '#2e7d32';
        }
    } catch (error) {
        console.error('Unable to save member staff access:', error);
        if (statusEl) {
            statusEl.textContent = 'Save failed: ' + error.message;
            statusEl.style.color = '#c62828';
        } else {
            alert(safeAdminError('Save failed'));
        }
    }
    return false;
};

window.deleteMemberStaffAccess = async (uid) => {
    const access = memberStaffAccess(uid);
    if (!access) return;
    if (!canManageMemberStaffAccess(uid, access)) {
        alert('ไม่สามารถลบสิทธิ์บัญชีนี้จากหน้า Members ได้');
        return;
    }
    if (!confirm('Remove staff access for this member?')) return;

    try {
        await deleteDoc(doc(db, ADMIN_COLLECTION, uid));
        delete adminAccessData[uid];
        renderMembersTable();
        renderAdminAccessTable();
        window.openMemberModal(uid);
    } catch (error) {
        console.error('Unable to remove member staff access:', error);
        alert(safeAdminError('Remove staff access failed'));
    }
};

// ==========================================
// FAQ Management Logic
// ==========================================
let faqsData = {};
const FAQ_PAGE_OPTIONS = Object.freeze([
    { key: 'home', label: 'Home / Index' },
    { key: 'menu', label: 'เมนู' },
    { key: 'shop', label: 'ร้านค้า' },
    { key: 'booking', label: 'ระบบจอง' },
    { key: 'faq', label: 'FAQ รวม' }
]);
const FAQ_STATUS_LABELS = Object.freeze({
    published: 'เผยแพร่',
    draft: 'ฉบับร่าง'
});
let faqFilters = {
    search: '',
    page: 'all',
    status: 'all'
};

function getFaqPageLabel(pageKey) {
    return FAQ_PAGE_OPTIONS.find(page => page.key === pageKey)?.label || pageKey || '-';
}


function normalizeFaqRecord(raw = {}, id = '') {
    const legacyPublished = raw.published !== false;
    const targetPages = Array.isArray(raw.targetPages) && raw.targetPages.length
        ? raw.targetPages.filter(page => FAQ_PAGE_OPTIONS.some(option => option.key === page))
        : ['home', 'faq'];
    const pinnedPages = raw.pinnedPages && typeof raw.pinnedPages === 'object' ? raw.pinnedPages : {};
    const pageOrder = raw.pageOrder && typeof raw.pageOrder === 'object' ? raw.pageOrder : {};
    const hasPopularField = Object.prototype.hasOwnProperty.call(raw, 'isPopular');

    return {
        id,
        question: String(raw.question || '').trim(),
        answer: String(raw.answer || '').trim(),
        category: String(raw.category || 'general').trim() || 'general',
        status: String(raw.status || (legacyPublished ? 'published' : 'draft')).trim() === 'draft' ? 'draft' : 'published',
        order: safeNumber(raw.order, 0),
        targetPages,
        pinnedPages,
        pageOrder,
        isPopular: hasPopularField ? Boolean(raw.isPopular) : targetPages.includes('faq'),
        popularOrder: safeNumber(raw.popularOrder, safeNumber(raw.order, 0)),
        createdAt: raw.createdAt || '',
        updatedAt: raw.updatedAt || ''
    };
}

function renderFaqControls() {

    const pageFilter = document.getElementById('faqPageFilter');
    if (pageFilter && !pageFilter.dataset.ready) {
        pageFilter.innerHTML = '<option value="all">ทุกหน้าเพจ</option>' + FAQ_PAGE_OPTIONS.map(page => `<option value="${page.key}">${escapeHTML(page.label)}</option>`).join('');
        pageFilter.dataset.ready = 'true';
    }

    const targetContainer = document.getElementById('faqTargetPages');
    if (targetContainer && !targetContainer.dataset.ready) {
        targetContainer.innerHTML = FAQ_PAGE_OPTIONS.map(page => `
            <label class="faq-check-card">
                <input type="checkbox" data-faq-page-target="${page.key}">
                <span>${escapeHTML(page.label)}</span>
            </label>
        `).join('');
        targetContainer.dataset.ready = 'true';
    }

    const pinnedContainer = document.getElementById('faqPinnedPages');
    if (pinnedContainer && !pinnedContainer.dataset.ready) {
        pinnedContainer.innerHTML = FAQ_PAGE_OPTIONS.map(page => `
            <label class="faq-check-card">
                <input type="checkbox" data-faq-pinned-page="${page.key}">
                <span>ตรึงที่ ${escapeHTML(page.label)}</span>
            </label>
        `).join('');
        pinnedContainer.dataset.ready = 'true';
    }

    const orderContainer = document.getElementById('faqPageOrders');
    if (orderContainer && !orderContainer.dataset.ready) {
        orderContainer.innerHTML = FAQ_PAGE_OPTIONS.map(page => `
            <label>
                ลำดับใน ${escapeHTML(page.label)}
                <input type="number" min="0" step="1" value="0" data-faq-page-order="${page.key}">
            </label>
        `).join('');
        orderContainer.dataset.ready = 'true';
    }
}

function getFaqFormData() {
    const targetPages = Array.from(document.querySelectorAll('[data-faq-page-target]:checked')).map(input => input.dataset.faqPageTarget);
    const pinnedPages = {};
    Array.from(document.querySelectorAll('[data-faq-pinned-page]')).forEach(input => {
        pinnedPages[input.dataset.faqPinnedPage] = input.checked;
    });
    const pageOrder = {};
    Array.from(document.querySelectorAll('[data-faq-page-order]')).forEach(input => {
        pageOrder[input.dataset.faqPageOrder] = safeNumber(input.value, 0);
    });

    return {
        question: document.getElementById('faqQuestion')?.value.trim() || '',
        answer: document.getElementById('faqAnswer')?.value.trim() || '',
        category: document.getElementById('faqCategory')?.value || 'general',
        status: document.getElementById('faqStatus')?.value || 'published',
        order: safeNumber(document.getElementById('faqOrder')?.value, 0),
        targetPages: targetPages.length ? targetPages : ['faq'],
        pinnedPages,
        pageOrder,
        isPopular: Boolean(document.getElementById('faqIsPopular')?.checked),
        popularOrder: safeNumber(document.getElementById('faqPopularOrder')?.value, 0),
        updatedAt: new Date().toISOString()
    };
}

function setFaqFormData(faq = null) {
    renderFaqControls();
    const normalized = faq ? normalizeFaqRecord(faq, faq.id || '') : null;
    document.getElementById('faqId').value = normalized?.id || '';
    document.getElementById('faqQuestion').value = normalized?.question || '';
    document.getElementById('faqAnswer').value = normalized?.answer || '';
    document.getElementById('faqCategory').value = normalized?.category || 'general';
    document.getElementById('faqStatus').value = normalized?.status || 'published';
    document.getElementById('faqOrder').value = normalized?.order ?? Object.keys(faqsData).length + 1;
    document.getElementById('faqPopularOrder').value = normalized?.popularOrder ?? Object.keys(faqsData).length + 1;
    document.getElementById('faqIsPopular').checked = normalized ? normalized.isPopular : true;

    Array.from(document.querySelectorAll('[data-faq-page-target]')).forEach(input => {
        input.checked = normalized ? normalized.targetPages.includes(input.dataset.faqPageTarget) : input.dataset.faqPageTarget === 'faq';
    });
    Array.from(document.querySelectorAll('[data-faq-pinned-page]')).forEach(input => {
        input.checked = normalized ? Boolean(normalized.pinnedPages?.[input.dataset.faqPinnedPage]) : false;
    });
    Array.from(document.querySelectorAll('[data-faq-page-order]')).forEach(input => {
        input.value = normalized ? safeNumber(normalized.pageOrder?.[input.dataset.faqPageOrder], 0) : 0;
    });
}

function renderFaqPageSummary() {
    const container = document.getElementById('faq-page-summary');
    if (!container) return;
    const faqs = Object.values(faqsData).map(faq => normalizeFaqRecord(faq, faq.id));
    container.innerHTML = FAQ_PAGE_OPTIONS.map(page => {
        const published = faqs.filter(faq => faq.status === 'published' && faq.targetPages.includes(page.key));
        const pinned = published.filter(faq => faq.pinnedPages?.[page.key]);
        return `
            <div class="faq-page-summary-card">
                <strong>${escapeHTML(page.label)}</strong>
                <span>${published.length} คำถามเผยแพร่</span>
                <span>${pinned.length} คำถามตรึง</span>
            </div>
        `;
    }).join('');
}

function getFilteredFaqs() {
    const search = faqFilters.search.toLowerCase().trim();
    return Object.values(faqsData)
        .map(faq => normalizeFaqRecord(faq, faq.id))
        .filter(faq => {
            if (faqFilters.status !== 'all' && faq.status !== faqFilters.status) return false;
            if (faqFilters.page !== 'all' && !faq.targetPages.includes(faqFilters.page)) return false;
            if (search) {
                const haystack = [faq.question, faq.answer, faq.targetPages.map(getFaqPageLabel).join(' ')].join(' ').toLowerCase();
                if (!haystack.includes(search)) return false;
            }
            return true;
        })
        .sort((a, b) => (a.order - b.order) || a.question.localeCompare(b.question, 'th'));
}

function renderFaqAdmin() {
    renderFaqControls();
    renderFaqPageSummary();
    const tbody = document.getElementById('faqs-table-body');
    if (!tbody) return;

    const faqs = getFilteredFaqs();
    if (!faqs.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#667; padding:24px;">ยังไม่มีคำถามตามเงื่อนไขที่เลือก</td></tr>';
        return;
    }

    tbody.innerHTML = faqs.map(faq => {
        const pageBadges = faq.targetPages.map(page => `<span class="faq-badge">${escapeHTML(getFaqPageLabel(page))}</span>`).join('');
        const pinnedBadges = FAQ_PAGE_OPTIONS
            .filter(page => faq.pinnedPages?.[page.key])
            .map(page => `<span class="faq-badge pinned">ตรึง ${escapeHTML(page.label)}</span>`)
            .join('');
        const popularBadge = faq.isPopular ? '<span class="faq-badge pinned">ยอดฮิต</span>' : '';
        const statusBadge = faq.status === 'published'
            ? '<span class="faq-badge">เผยแพร่</span>'
            : '<span class="faq-badge draft">ฉบับร่าง</span>';
        return `
            <tr>
                <td class="faq-question-cell">
                    <strong>${escapeHTML(faq.question)}</strong>
                    <div class="faq-answer-preview">${escapeHTML(faq.answer)}</div>
                </td>
                <td><div class="faq-badge-row">${pageBadges}${pinnedBadges}${popularBadge}</div></td>
                <td>${statusBadge}</td>
                <td>
                    <button class="btn-action btn-edit" type="button" onclick="editFaq('${escapeJSString(faq.id)}')">แก้ไข</button>
                    <button class="btn-action btn-delete" type="button" onclick="deleteFaq('${escapeJSString(faq.id)}')">ลบ</button>
                </td>
            </tr>
        `;
    }).join('');
}

window.fetchFaqsFromCloud = function() {
    renderFaqControls();
    if (faqsUnsubscribe) {
        faqsUnsubscribe();
        faqsUnsubscribe = null;
    }
    const q = query(collection(db, 'faqs'), orderBy('order', 'asc'));
    faqsUnsubscribe = onSnapshot(q, (snapshot) => {
        faqsData = {};
        snapshot.forEach((docSnap) => {
            const faq = normalizeFaqRecord(docSnap.data(), docSnap.id);
            faqsData[docSnap.id] = faq;
        });
        renderFaqAdmin();
    }, (error) => {
        console.error('Error fetching FAQs:', error);
        const tbody = document.getElementById('faqs-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="color:#b42318; text-align:center; padding:24px;">โหลด FAQ ไม่สำเร็จ: ${escapeHTML(error.message)}</td></tr>`;
    });
};

window.openFaqModal = () => window.resetFaqForm();
window.closeFaqModal = () => window.resetFaqForm();

window.resetFaqForm = () => {
    const form = document.getElementById('faqForm');
    form?.reset();
    setFaqFormData(null);
    form?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.editFaq = (id) => {
    const faq = faqsData[id];
    if (!faq) return;
    setFaqFormData({ ...faq, id });
    document.getElementById('faqForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.deleteFaq = async (id) => {
    const faq = faqsData[id];
    if (!faq) return;
    if (!confirm(`ต้องการลบคำถาม "${faq.question}" ใช่ไหม?`)) return;
    try {
        await deleteDoc(doc(db, 'faqs', id));
    } catch (error) {
        alert(safeAdminError("ลบ FAQ ไม่สำเร็จ"));
    }
};

const faqForm = document.getElementById('faqForm');
faqForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('faqId')?.value || '';
    const faqData = getFaqFormData();
    if (!faqData.question || !faqData.answer) {
        alert('กรุณากรอกคำถามและคำตอบ');
        return;
    }

    try {
        if (id) {
            await updateDoc(doc(db, 'faqs', id), faqData);
        } else {
            faqData.createdAt = new Date().toISOString();
            await addDoc(collection(db, 'faqs'), faqData);
        }
        window.resetFaqForm();
        alert('บันทึก FAQ สำเร็จ');
    } catch (error) {
        alert(safeAdminError("บันทึก FAQ ไม่สำเร็จ"));
    }
});

function bindFaqFilters() {
    renderFaqControls();
    const search = document.getElementById('faqSearch');
    const page = document.getElementById('faqPageFilter');
    const status = document.getElementById('faqStatusFilter');
    search?.addEventListener('input', () => { faqFilters.search = search.value; renderFaqAdmin(); });
    page?.addEventListener('change', () => { faqFilters.page = page.value; renderFaqAdmin(); });
    status?.addEventListener('change', () => { faqFilters.status = status.value; renderFaqAdmin(); });
}
bindFaqFilters();
setFaqFormData(null);

// Start fetching FAQs when logged in
onAuthStateChanged(auth, (user) => {
    if (user) {
        if (typeof fetchFaqsFromCloud === 'function') fetchFaqsFromCloud();
        if (typeof loadIndexSettings === 'function') loadIndexSettings();
        if (typeof loadFooterSettings === 'function') loadFooterSettings();
    }
});

// ==========================================
// PromptPay Settings Management Logic
// ==========================================

const PROMPTPAY_DEFAULT_ACCOUNT = Object.freeze({
    id: 'eden-main',
    label: 'Eden Cafe Main',
    promptPayId: '057556001655',
    merchantName: 'EDEN CAFE',
    city: 'CHIANG RAI',
    order: 1
});
const PROMPTPAY_SETTINGS_DEFAULTS = Object.freeze({
    enabled: true,
    activeAccountId: PROMPTPAY_DEFAULT_ACCOUNT.id,
    promptPayId: PROMPTPAY_DEFAULT_ACCOUNT.promptPayId,
    merchantName: PROMPTPAY_DEFAULT_ACCOUNT.merchantName,
    city: PROMPTPAY_DEFAULT_ACCOUNT.city,
    accounts: [PROMPTPAY_DEFAULT_ACCOUNT]
});
const promptPaySettingsForm = document.getElementById('promptpaySettingsForm');
let promptPaySettingsState = defaultPromptPaySettings();
let promptPayEditingAccountId = PROMPTPAY_DEFAULT_ACCOUNT.id;

function defaultPromptPayAccount() {
    return { ...PROMPTPAY_DEFAULT_ACCOUNT };
}

function defaultPromptPaySettings() {
    return {
        enabled: true,
        activeAccountId: PROMPTPAY_DEFAULT_ACCOUNT.id,
        promptPayId: PROMPTPAY_DEFAULT_ACCOUNT.promptPayId,
        merchantName: PROMPTPAY_DEFAULT_ACCOUNT.merchantName,
        city: PROMPTPAY_DEFAULT_ACCOUNT.city,
        accounts: [defaultPromptPayAccount()]
    };
}

function cleanPromptPayId(value) {
    return String(value ?? '').replace(/\D/g, '');
}

function isValidPromptPayId(value) {
    const id = cleanPromptPayId(value);
    return /^0\d{9}$/.test(id) || /^\d{13}$/.test(id) || /^\d{15}$/.test(id);
}

function promptPaySlug(value) {
    return String(value || 'promptpay')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 42) || 'promptpay';
}

function uniquePromptPayAccountId(seed, accounts = [], currentId = '') {
    const base = promptPaySlug(seed || 'promptpay');
    const used = new Set(accounts.map(account => account.id).filter(id => id && id !== currentId));
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
        candidate = base + '-' + suffix;
        suffix += 1;
    }
    return candidate;
}

function normalizePromptPayAccount(account = {}, index = 0) {
    const cleanedId = cleanPromptPayId(account.promptPayId || account.idValue || account.number || account.promptpay || PROMPTPAY_DEFAULT_ACCOUNT.promptPayId);
    const label = String(account.label || account.name || account.accountName || ('PromptPay ' + (index + 1))).trim().slice(0, 80) || ('PromptPay ' + (index + 1));
    return {
        id: String(account.id || account.key || '').trim(),
        label,
        promptPayId: isValidPromptPayId(cleanedId) ? cleanedId : PROMPTPAY_DEFAULT_ACCOUNT.promptPayId,
        merchantName: String(account.merchantName || PROMPTPAY_DEFAULT_ACCOUNT.merchantName).trim().slice(0, 25) || PROMPTPAY_DEFAULT_ACCOUNT.merchantName,
        city: String(account.city || PROMPTPAY_DEFAULT_ACCOUNT.city).trim().slice(0, 15) || PROMPTPAY_DEFAULT_ACCOUNT.city,
        order: Number.isFinite(Number(account.order)) ? Number(account.order) : index + 1
    };
}

function normalizePromptPaySettings(data = {}) {
    const legacyAccount = {
        id: data.accountId || data.activeAccountId || PROMPTPAY_DEFAULT_ACCOUNT.id,
        label: data.label || data.accountName || PROMPTPAY_DEFAULT_ACCOUNT.label,
        promptPayId: data.promptPayId,
        merchantName: data.merchantName,
        city: data.city,
        order: 1
    };
    const rawAccounts = Array.isArray(data.accounts) && data.accounts.length ? data.accounts : [legacyAccount];
    const used = [];
    const accounts = rawAccounts
        .map((account, index) => normalizePromptPayAccount(account, index))
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
        .map((account, index) => {
            const seededId = account.id || account.label || account.promptPayId || ('promptpay-' + (index + 1));
            const id = uniquePromptPayAccountId(seededId, used);
            const normalized = { ...account, id, order: index + 1 };
            used.push(normalized);
            return normalized;
        });

    if (!accounts.length) accounts.push(defaultPromptPayAccount());
    let activeAccountId = String(data.activeAccountId || data.selectedAccountId || data.accountId || '').trim();
    if (!accounts.some(account => account.id === activeAccountId)) activeAccountId = accounts[0].id;
    const activeAccount = accounts.find(account => account.id === activeAccountId) || accounts[0] || defaultPromptPayAccount();
    return {
        enabled: data.enabled !== false,
        activeAccountId,
        accounts,
        promptPayId: activeAccount.promptPayId,
        merchantName: activeAccount.merchantName,
        city: activeAccount.city
    };
}

function activePromptPayAccount(settings = promptPaySettingsState) {
    const normalized = normalizePromptPaySettings(settings);
    return normalized.accounts.find(account => account.id === normalized.activeAccountId) || normalized.accounts[0] || defaultPromptPayAccount();
}

function setPromptPayAdminStatus(message = '', state = '') {
    const status = document.getElementById('promptpay-settings-status');
    if (!status) return;
    status.textContent = message;
    status.className = ['promptpay-settings-status', state].filter(Boolean).join(' ');
}

function readPromptPayAccountForm({ validate = true } = {}) {
    const rawId = String(document.getElementById('promptpay-account-key')?.value || promptPayEditingAccountId || '').trim();
    const promptPayId = cleanPromptPayId(document.getElementById('promptpay-id')?.value || '');
    const label = String(document.getElementById('promptpay-account-label')?.value || '').trim();
    const merchantName = String(document.getElementById('promptpay-merchant-name')?.value || '').trim();
    const city = String(document.getElementById('promptpay-city')?.value || '').trim();

    if (validate && !isValidPromptPayId(promptPayId)) {
        throw new Error('PromptPay ID must be a 10-digit phone number, 13-digit citizen ID, or 15-digit e-Wallet ID.');
    }
    if (validate && (!merchantName || !city)) {
        throw new Error('Merchant name and city are required.');
    }

    return normalizePromptPayAccount({
        id: rawId,
        label: label || 'PromptPay',
        promptPayId: promptPayId || PROMPTPAY_DEFAULT_ACCOUNT.promptPayId,
        merchantName: merchantName || PROMPTPAY_DEFAULT_ACCOUNT.merchantName,
        city: city || PROMPTPAY_DEFAULT_ACCOUNT.city,
        order: promptPaySettingsState.accounts.findIndex(account => account.id === rawId) + 1 || promptPaySettingsState.accounts.length + 1
    });
}

function applyPromptPayAccountToForm(account = defaultPromptPayAccount()) {
    const normalized = normalizePromptPayAccount(account);
    promptPayEditingAccountId = normalized.id;
    const titleEl = document.getElementById('promptpay-editor-title');
    const keyEl = document.getElementById('promptpay-account-key');
    const labelEl = document.getElementById('promptpay-account-label');
    const idEl = document.getElementById('promptpay-id');
    const merchantEl = document.getElementById('promptpay-merchant-name');
    const cityEl = document.getElementById('promptpay-city');
    if (titleEl) titleEl.textContent = normalized.id ? 'Edit PromptPay Account' : 'Add PromptPay Account';
    if (keyEl) keyEl.value = normalized.id || '';
    if (labelEl) labelEl.value = normalized.label || '';
    if (idEl) idEl.value = normalized.promptPayId || '';
    if (merchantEl) merchantEl.value = normalized.merchantName || '';
    if (cityEl) cityEl.value = normalized.city || '';
    updatePromptPaySettingsPreview({ ...normalized, enabled: document.getElementById('promptpay-enabled')?.checked !== false });
}

function updatePromptPaySettingsPreview(settings = readPromptPayAccountForm({ validate: false })) {
    const normalized = normalizePromptPayAccount(settings);
    const previewId = document.getElementById('promptpay-preview-id');
    const previewMerchant = document.getElementById('promptpay-preview-merchant');
    const previewCity = document.getElementById('promptpay-preview-city');
    const previewEnabled = document.getElementById('promptpay-preview-enabled');
    if (previewId) previewId.textContent = cleanPromptPayId(settings.promptPayId) || normalized.promptPayId;
    if (previewMerchant) previewMerchant.textContent = settings.merchantName || normalized.merchantName;
    if (previewCity) previewCity.textContent = settings.city || normalized.city;
    if (previewEnabled) previewEnabled.textContent = settings.enabled === false ? 'Disabled' : 'Enabled';
}

function renderPromptPayAccountOptions() {
    const select = document.getElementById('promptpay-active-account');
    if (!select) return;
    select.innerHTML = promptPaySettingsState.accounts.map((account, index) => {
        const selected = account.id === promptPaySettingsState.activeAccountId ? ' selected' : '';
        const label = (index + 1) + '. ' + account.label + ' - ' + account.promptPayId;
        return '<option value="' + escapeHTML(account.id) + '"' + selected + '>' + escapeHTML(label) + '</option>';
    }).join('');
}

function renderPromptPayAccountList() {
    const container = document.getElementById('promptpay-account-list');
    if (!container) return;
    if (!promptPaySettingsState.accounts.length) {
        container.innerHTML = '<div class="promptpay-empty">No PromptPay accounts yet.</div>';
        return;
    }
    container.innerHTML = promptPaySettingsState.accounts.map((account, index) => {
        const active = account.id === promptPaySettingsState.activeAccountId;
        return '<article class="promptpay-account-item' + (active ? ' active' : '') + '">'
            + '<span class="promptpay-account-order">' + (index + 1) + '</span>'
            + '<div class="promptpay-account-title"><strong>' + escapeHTML(account.label) + (active ? ' - Active' : '') + '</strong><small>' + escapeHTML(account.promptPayId + ' - ' + account.merchantName + ' - ' + account.city) + '</small></div>'
            + '<div class="promptpay-account-actions">'
            + '<button type="button" class="promptpay-mini-btn" onclick="setActivePromptPayAccount(\'' + escapeJSString(account.id) + '\')">Use</button>'
            + '<button type="button" class="promptpay-mini-btn" onclick="editPromptPayAccount(\'' + escapeJSString(account.id) + '\')">Edit</button>'
            + '<button type="button" class="promptpay-mini-btn danger" onclick="deletePromptPayAccount(\'' + escapeJSString(account.id) + '\')">Delete</button>'
            + '</div></article>';
    }).join('');
}

function renderPromptPaySettingsUI() {
    promptPaySettingsState = normalizePromptPaySettings(promptPaySettingsState);
    const enabledEl = document.getElementById('promptpay-enabled');
    if (enabledEl) enabledEl.checked = promptPaySettingsState.enabled;
    renderPromptPayAccountOptions();
    renderPromptPayAccountList();
}

function applyPromptPaySettingsToForm(settings = defaultPromptPaySettings()) {
    promptPaySettingsState = normalizePromptPaySettings(settings);
    renderPromptPaySettingsUI();
    applyPromptPayAccountToForm(activePromptPayAccount(promptPaySettingsState));
}

function upsertPromptPayCurrentAccount() {
    const account = readPromptPayAccountForm({ validate: true });
    const currentId = account.id || '';
    const targetId = currentId || uniquePromptPayAccountId(account.label || account.promptPayId, promptPaySettingsState.accounts);
    const nextAccount = { ...account, id: targetId };
    const existingIndex = promptPaySettingsState.accounts.findIndex(item => item.id === targetId);
    if (existingIndex >= 0) promptPaySettingsState.accounts[existingIndex] = nextAccount;
    else promptPaySettingsState.accounts.push(nextAccount);
    promptPaySettingsState.accounts = promptPaySettingsState.accounts.map((item, index) => ({ ...item, order: index + 1 }));
    if (!promptPaySettingsState.activeAccountId || !promptPaySettingsState.accounts.some(item => item.id === promptPaySettingsState.activeAccountId)) {
        promptPaySettingsState.activeAccountId = targetId;
    }
    promptPayEditingAccountId = targetId;
    renderPromptPaySettingsUI();
    applyPromptPayAccountToForm(nextAccount);
    return nextAccount;
}

function buildPromptPaySettingsPayload() {
    upsertPromptPayCurrentAccount();
    const selectValue = document.getElementById('promptpay-active-account')?.value || promptPaySettingsState.activeAccountId;
    if (promptPaySettingsState.accounts.some(account => account.id === selectValue)) {
        promptPaySettingsState.activeAccountId = selectValue;
    }
    promptPaySettingsState.enabled = document.getElementById('promptpay-enabled')?.checked !== false;
    promptPaySettingsState = normalizePromptPaySettings(promptPaySettingsState);
    const activeAccount = activePromptPayAccount(promptPaySettingsState);
    return {
        enabled: promptPaySettingsState.enabled,
        activeAccountId: activeAccount.id,
        accounts: promptPaySettingsState.accounts.map((account, index) => ({ ...account, order: index + 1 })),
        promptPayId: activeAccount.promptPayId,
        merchantName: activeAccount.merchantName,
        city: activeAccount.city
    };
}

window.loadPromptPaySettings = async function() {
    if (!canAdmin('promptpay')) {
        setPromptPayAdminStatus('This account cannot manage PromptPay settings.', 'error');
        return null;
    }
    setPromptPayAdminStatus('Loading PromptPay settings...', 'warning');
    try {
        const snap = await getDoc(doc(db, 'site_settings', 'promptpay'));
        const settings = normalizePromptPaySettings(snap.exists() ? snap.data() : defaultPromptPaySettings());
        dashboardPromptPaySettings = settings;
        applyPromptPaySettingsToForm(settings);
        setPromptPayAdminStatus(snap.exists() ? 'PromptPay settings loaded.' : 'Using default PromptPay settings. Save once to publish them.', snap.exists() ? 'success' : 'warning');
        renderDashboardSalesReport();
        return settings;
    } catch (error) {
        console.error('Error loading PromptPay settings:', error);
        applyPromptPaySettingsToForm(defaultPromptPaySettings());
        setPromptPayAdminStatus('Unable to load PromptPay settings: ' + error.message, 'error');
        renderDashboardSalesReport();
        return null;
    }
};

window.addPromptPayAccount = function() {
    promptPayEditingAccountId = '';
    const newAccount = {
        id: '',
        label: 'PromptPay ' + (promptPaySettingsState.accounts.length + 1),
        promptPayId: '',
        merchantName: PROMPTPAY_DEFAULT_ACCOUNT.merchantName,
        city: PROMPTPAY_DEFAULT_ACCOUNT.city,
        order: promptPaySettingsState.accounts.length + 1
    };
    applyPromptPayAccountToForm(newAccount);
    setPromptPayAdminStatus('Fill in the new PromptPay account, then save it into the list.', 'warning');
};

window.editPromptPayAccount = function(accountId) {
    const account = promptPaySettingsState.accounts.find(item => item.id === accountId);
    if (!account) return;
    applyPromptPayAccountToForm(account);
    setPromptPayAdminStatus('Editing ' + account.label + '. Save all to publish changes.', 'warning');
};

window.setActivePromptPayAccount = function(accountId) {
    const account = promptPaySettingsState.accounts.find(item => item.id === accountId);
    if (!account) return;
    promptPaySettingsState.activeAccountId = account.id;
    renderPromptPaySettingsUI();
    applyPromptPayAccountToForm(account);
    setPromptPayAdminStatus(account.label + ' selected for POS. Click Save All to publish.', 'warning');
};

window.deletePromptPayAccount = function(accountId) {
    if (promptPaySettingsState.accounts.length <= 1) {
        setPromptPayAdminStatus('At least one PromptPay account is required.', 'error');
        return;
    }
    const account = promptPaySettingsState.accounts.find(item => item.id === accountId);
    if (!account) return;
    if (!confirm('Delete PromptPay account "' + account.label + '"?')) return;
    promptPaySettingsState.accounts = promptPaySettingsState.accounts.filter(item => item.id !== accountId);
    if (promptPaySettingsState.activeAccountId === accountId) {
        promptPaySettingsState.activeAccountId = promptPaySettingsState.accounts[0]?.id || '';
    }
    renderPromptPaySettingsUI();
    applyPromptPayAccountToForm(activePromptPayAccount(promptPaySettingsState));
    setPromptPayAdminStatus('Account removed from the list. Click Save All to publish.', 'warning');
};

window.savePromptPayCurrentAccount = function() {
    try {
        const account = upsertPromptPayCurrentAccount();
        setPromptPayAdminStatus(account.label + ' saved into the list. Click Save All to publish to POS.', 'success');
    } catch (error) {
        setPromptPayAdminStatus(error.message, 'error');
        document.getElementById('promptpay-id')?.focus();
    }
};

window.resetPromptPaySettingsForm = function() {
    applyPromptPaySettingsToForm(defaultPromptPaySettings());
    setPromptPayAdminStatus('Default PromptPay values restored in the form. Click Save All to publish.', 'warning');
};

promptPaySettingsForm?.addEventListener('input', () => {
    try {
        updatePromptPaySettingsPreview({ ...readPromptPayAccountForm({ validate: false }), enabled: document.getElementById('promptpay-enabled')?.checked !== false });
    } catch (error) {
        console.warn('Unable to preview PromptPay form:', error);
    }
});

promptPaySettingsForm?.addEventListener('change', (event) => {
    if (event.target?.id === 'promptpay-active-account') {
        window.setActivePromptPayAccount(event.target.value);
        return;
    }
    updatePromptPaySettingsPreview({ ...readPromptPayAccountForm({ validate: false }), enabled: document.getElementById('promptpay-enabled')?.checked !== false });
});

promptPaySettingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canAdmin('promptpay')) {
        setPromptPayAdminStatus('This account cannot manage PromptPay settings.', 'error');
        return;
    }

    const submitBtn = promptPaySettingsForm.querySelector('button[type="submit"]');
    const originalText = submitBtn?.textContent || '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
    }

    try {
        const payload = buildPromptPaySettingsPayload();
        await setDoc(doc(db, 'site_settings', 'promptpay'), {
            ...payload,
            updatedAt: serverTimestamp(),
            updatedBy: auth.currentUser?.uid || '',
            updatedByEmail: auth.currentUser?.email || ''
        }, { merge: true });
        dashboardPromptPaySettings = payload;
        applyPromptPaySettingsToForm(payload);
        setPromptPayAdminStatus('PromptPay settings saved. POS will use ' + activePromptPayAccount(payload).label + ' automatically.', 'success');
        renderDashboardSalesReport();
    } catch (error) {
        console.error('Error saving PromptPay settings:', error);
        setPromptPayAdminStatus('Unable to save PromptPay settings: ' + error.message, 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
});

applyPromptPaySettingsToForm(defaultPromptPaySettings());

// ==========================================
// Marketing Settings Management Logic
// ==========================================

const marketingSettingsForm = document.getElementById('marketingSettingsForm');

function marketingFieldValue(id) {
    return String(document.getElementById(id)?.value || '').trim();
}

function setMarketingFieldValue(id, value = '') {
    const input = document.getElementById(id);
    if (input) input.value = value || '';
}

function setMarketingCheckbox(id, value = false) {
    const input = document.getElementById(id);
    if (input) input.checked = value === true;
}

window.updateMarketingPreview = function() {
    const enabled = document.getElementById('marketing-enabled')?.checked === true;
    const googleTagManagerId = marketingFieldValue('marketing-gtm-id');
    const googleAnalyticsId = marketingFieldValue('marketing-ga-id');
    const googleAdsId = marketingFieldValue('marketing-ads-id');
    const metaPixelId = marketingFieldValue('marketing-meta-pixel-id');
    const tools = [
        googleTagManagerId ? 'GTM' : '',
        googleAnalyticsId ? 'GA4' : '',
        googleAdsId ? 'Google Ads' : '',
        metaPixelId ? 'Meta Pixel' : ''
    ].filter(Boolean);
    const status = document.getElementById('marketing-preview-status');
    const ids = document.getElementById('marketing-preview-ids');
    if (status) status.textContent = enabled ? 'Enabled after visitor consent' : 'Disabled';
    if (ids) ids.textContent = tools.length ? tools.join(' / ') : 'No marketing IDs configured';
};

window.loadMarketingSettings = async function() {
    try {
        const snap = await getDoc(doc(db, 'site_settings', 'marketing'));
        const data = snap.exists() ? snap.data() : {};
        setMarketingCheckbox('marketing-enabled', data.enabled === true);
        setMarketingFieldValue('marketing-gtm-id', data.googleTagManagerId);
        setMarketingFieldValue('marketing-ga-id', data.googleAnalyticsId);
        setMarketingFieldValue('marketing-ads-id', data.googleAdsId);
        setMarketingFieldValue('marketing-meta-pixel-id', data.metaPixelId);
        setMarketingCheckbox('marketing-debug', data.debug === true);
        updateMarketingPreview();
    } catch (error) {
        console.error('Error loading marketing settings:', error);
    }
};

marketingSettingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canAdmin('marketing')) {
        alert('This account cannot edit marketing settings.');
        return;
    }

    const submitBtn = marketingSettingsForm.querySelector('button[type="submit"]');
    const originalText = submitBtn?.textContent;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving...';
    }

    const marketingData = {
        enabled: document.getElementById('marketing-enabled')?.checked === true,
        googleTagManagerId: marketingFieldValue('marketing-gtm-id').toUpperCase(),
        googleAnalyticsId: marketingFieldValue('marketing-ga-id').toUpperCase(),
        googleAdsId: marketingFieldValue('marketing-ads-id').toUpperCase(),
        metaPixelId: marketingFieldValue('marketing-meta-pixel-id'),
        debug: document.getElementById('marketing-debug')?.checked === true,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser?.email || 'unknown'
    };

    try {
        await setDoc(doc(db, 'site_settings', 'marketing'), marketingData, { merge: true });
        alert('Marketing settings saved. Public pages will load the tools only after visitor consent.');
        updateMarketingPreview();
    } catch (error) {
        alert(safeAdminError('Unable to save marketing settings'));
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
});

// ==========================================
// Index Settings Management Logic
// ==========================================

const INDEX_SETTINGS_REF = () => doc(db, 'site_settings', 'index');
const DEFAULT_INDEX_SETTINGS = {
    heroImageUrl: '/Hero/Hero.webp',
    heroTitleTh: 'จากใจเรา สู่มือคุณ',
    heroSubtitleTh: 'ยินดีต้อนรับสู่ Eden Cafe - พื้นที่พักผ่อนที่เงียบสงบใจกลางเมือง สัมผัสประสบการณ์เมล็ดกาแฟที่ปลูกอย่างใส่ใจและคั่วอย่างพิถีพิถันจากเกษตรกรไทย',
    heroTitleEn: 'Discover the True Taste of Thai Specialty Coffee',
    heroSubtitleEn: 'Welcome to Eden Cafe - Your serene escape in the heart of Thailand. Experience locally-sourced, ethically-grown coffee beans roasted to perfection.',
    aboutTitleTh: 'เรื่องราวของเรา: จากยอดดอยสู่แก้วกาแฟของคุณ',
    aboutBodyTh: 'Eden Cafe เกิดขึ้นจากความหลงใหลในศิลปะการชงกาแฟและการสนับสนุนเกษตรกรไทย เราคัดสรรเมล็ดกาแฟจากแหล่งปลูกที่ดีที่สุดบนยอดดอยในประเทศไทย คั่วด้วยเทคนิคพิเศษเพื่อให้ได้รสชาติที่เป็นเอกลักษณ์ ไม่เหมือนใคร บรรยากาศร้านของเราออกแบบสไตล์มินิมอล อิงธรรมชาติ เพื่อให้คุณได้พักผ่อนอย่างแท้จริง',
    aboutTitleEn: 'Our Story: From Thai Mountains to Your Cup',
    aboutBodyEn: 'Eden Cafe was born out of a passion for the art of coffee brewing and supporting Thai farmers. We carefully select coffee beans from the best high-altitude farms in Thailand, roasted with special techniques to achieve a unique flavor. Our minimalist, nature-inspired design offers a true sanctuary for relaxation.'
};

const indexSettingsForm = document.getElementById('indexSettingsForm');

function normalizeIndexSettings(data = {}) {
    const pick = (key, max) => String(data[key] || DEFAULT_INDEX_SETTINGS[key] || '').trim().slice(0, max);
    return {
        heroImageUrl: safeImageURL(data.heroImageUrl || data.hero_image_url || DEFAULT_INDEX_SETTINGS.heroImageUrl, DEFAULT_INDEX_SETTINGS.heroImageUrl),
        heroTitleTh: pick('heroTitleTh', 120),
        heroSubtitleTh: pick('heroSubtitleTh', 320),
        heroTitleEn: pick('heroTitleEn', 120),
        heroSubtitleEn: pick('heroSubtitleEn', 320),
        aboutTitleTh: pick('aboutTitleTh', 140),
        aboutBodyTh: pick('aboutBodyTh', 900),
        aboutTitleEn: pick('aboutTitleEn', 140),
        aboutBodyEn: pick('aboutBodyEn', 900)
    };
}

function setIndexStatus(message = '', tone = '') {
    const status = document.getElementById('index-settings-status');
    if (!status) return;
    status.textContent = message;
    status.className = 'index-settings-status' + (tone ? ' ' + tone : '');
}

function indexField(id) {
    return document.getElementById(id);
}

function setIndexField(id, value) {
    const field = indexField(id);
    if (field) field.value = value || '';
}

function readIndexSettingsForm() {
    return normalizeIndexSettings({
        heroImageUrl: indexField('index-hero-image-url')?.value || '',
        heroTitleTh: indexField('index-hero-title-th')?.value || '',
        heroSubtitleTh: indexField('index-hero-subtitle-th')?.value || '',
        heroTitleEn: indexField('index-hero-title-en')?.value || '',
        heroSubtitleEn: indexField('index-hero-subtitle-en')?.value || '',
        aboutTitleTh: indexField('index-about-title-th')?.value || '',
        aboutBodyTh: indexField('index-about-body-th')?.value || '',
        aboutTitleEn: indexField('index-about-title-en')?.value || '',
        aboutBodyEn: indexField('index-about-body-en')?.value || ''
    });
}

function fillIndexSettingsForm(settings = DEFAULT_INDEX_SETTINGS) {
    const normalized = normalizeIndexSettings(settings);
    setIndexField('index-hero-image-url', normalized.heroImageUrl);
    setIndexField('index-hero-title-th', normalized.heroTitleTh);
    setIndexField('index-hero-subtitle-th', normalized.heroSubtitleTh);
    setIndexField('index-hero-title-en', normalized.heroTitleEn);
    setIndexField('index-hero-subtitle-en', normalized.heroSubtitleEn);
    setIndexField('index-about-title-th', normalized.aboutTitleTh);
    setIndexField('index-about-body-th', normalized.aboutBodyTh);
    setIndexField('index-about-title-en', normalized.aboutTitleEn);
    setIndexField('index-about-body-en', normalized.aboutBodyEn);
    window.updateIndexPreview();
}

window.updateIndexPreview = function() {
    const settings = readIndexSettingsForm();
    const previewHero = document.getElementById('index-preview-hero');
    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value || '';
    };
    if (previewHero) previewHero.style.setProperty('--index-preview-hero-image', `url("${settings.heroImageUrl}")`);
    setText('index-preview-hero-title', settings.heroTitleTh);
    setText('index-preview-hero-subtitle', settings.heroSubtitleTh);
    setText('index-preview-about-title', settings.aboutTitleTh);
    setText('index-preview-about-body', settings.aboutBodyTh);
};

window.loadIndexSettings = async function() {
    try {
        setIndexStatus('\u0e01\u0e33\u0e25\u0e31\u0e07\u0e42\u0e2b\u0e25\u0e14\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25...');
        const snap = await getDoc(INDEX_SETTINGS_REF());
        fillIndexSettingsForm(snap.exists() ? snap.data() : DEFAULT_INDEX_SETTINGS);
        setIndexStatus('\u0e42\u0e2b\u0e25\u0e14\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25 Index \u0e41\u0e25\u0e49\u0e27');
    } catch (error) {
        console.error('Error loading index settings:', error);
        fillIndexSettingsForm(DEFAULT_INDEX_SETTINGS);
        setIndexStatus('\u0e42\u0e2b\u0e25\u0e14 Index \u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08 \u0e41\u0e2a\u0e14\u0e07\u0e04\u0e48\u0e32 fallback \u0e41\u0e17\u0e19', 'error');
    }
};

indexField('index-hero-image-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
        setIndexStatus('\u0e01\u0e33\u0e25\u0e31\u0e07\u0e2d\u0e31\u0e1b\u0e42\u0e2b\u0e25\u0e14 Hero image...');
        const blob = await compressToWebP(file, 0.84);
        const safeName = (file.name || 'index-hero.webp').replace(/\.[^.]+$/, '') + '.webp';
        const url = await uploadAdminImage(blob, 'index', safeName);
        setIndexField('index-hero-image-url', url);
        window.updateIndexPreview();
        setIndexStatus('\u0e2d\u0e31\u0e1b\u0e42\u0e2b\u0e25\u0e14 Hero image \u0e41\u0e25\u0e49\u0e27');
    } catch (error) {
        console.error('Unable to upload index hero image:', error);
        setIndexStatus(error.message || '\u0e2d\u0e31\u0e1b\u0e42\u0e2b\u0e25\u0e14\u0e20\u0e32\u0e1e\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08', 'error');
    }
});

indexSettingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = indexSettingsForm.querySelector('button[type="submit"]');
    const originalText = submitBtn?.textContent;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '\u0e01\u0e33\u0e25\u0e31\u0e07\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01...';
    }

    try {
        const settings = readIndexSettingsForm();
        await setDoc(INDEX_SETTINGS_REF(), {
            ...settings,
            updatedAt: serverTimestamp(),
            updatedBy: auth.currentUser?.uid || '',
            updatedByEmail: auth.currentUser?.email || ''
        }, { merge: true });
        setIndexStatus('\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01 Index \u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08');
        alert('\u2705 \u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01 Index \u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08');
    } catch (error) {
        console.error('Unable to save index settings:', error);
        setIndexStatus(safeAdminError('\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01 Index \u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08'), 'error');
        alert(safeAdminError('\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01 Index \u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08'));
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
});

// ==========================================
// Footer Settings Management Logic
// ==========================================

const footerSettingsForm = document.getElementById('footerSettingsForm');

window.updateFooterPreview = function() {
    const brandName = document.getElementById('footer-brand-name')?.value || '';
    const tagline = document.getElementById('footer-tagline')?.value || '';
    const address = document.getElementById('footer-address')?.value || '';
    const email = document.getElementById('footer-email')?.value || '';
    const phone = document.getElementById('footer-phone')?.value || '';
    const instagram = document.getElementById('footer-instagram')?.value || '#';
    const facebook = document.getElementById('footer-facebook')?.value || '#';
    const line = document.getElementById('footer-line')?.value || '#';

    const fpBrand = document.getElementById('fp-brand');
    const fpTagline = document.getElementById('fp-tagline');
    const fpAddress = document.getElementById('fp-address');
    const fpEmail = document.getElementById('fp-email');
    const fpPhone = document.getElementById('fp-phone');
    const fpIg = document.getElementById('fp-ig');
    const fpFb = document.getElementById('fp-fb');
    const fpLine = document.getElementById('fp-line');

    if (fpBrand) fpBrand.textContent = brandName;
    if (fpTagline) fpTagline.textContent = tagline;
    if (fpAddress) fpAddress.textContent = address;
    if (fpEmail) fpEmail.textContent = '\u0e2d\u0e35\u0e40\u0e21\u0e25: ' + email;
    if (fpPhone) fpPhone.textContent = '\u0e42\u0e17\u0e23: ' + phone;
    if (fpIg) fpIg.href = instagram;
    if (fpFb) fpFb.href = facebook;
    if (fpLine) fpLine.href = line;
};

window.loadFooterSettings = async function() {
    try {
        const snap = await getDoc(doc(db, 'site_settings', 'footer'));
        if (snap.exists()) {
            const data = snap.data();
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el && val !== undefined && val !== null) el.value = val;
            };
            setVal('footer-brand-name', data.brandName);
            setVal('footer-tagline', data.tagline);
            setVal('footer-copyright', data.copyright);
            setVal('footer-address', data.address);
            setVal('footer-email', data.email);
            setVal('footer-phone', data.phone);
            setVal('footer-instagram', data.instagram);
            setVal('footer-facebook', data.facebook);
            setVal('footer-line', data.line);

            updateFooterPreview();
        }
    } catch (error) {
        console.error('Error loading footer settings:', error);
    }
};

footerSettingsForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = footerSettingsForm.querySelector('button[type="submit"]');
    const originalText = submitBtn?.textContent;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '\u23f3 \u0e01\u0e33\u0e25\u0e31\u0e07\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01...';
    }

    const footerData = {
        brandName: document.getElementById('footer-brand-name')?.value || '',
        tagline: document.getElementById('footer-tagline')?.value || '',
        copyright: document.getElementById('footer-copyright')?.value || '',
        address: document.getElementById('footer-address')?.value || '',
        email: document.getElementById('footer-email')?.value || '',
        phone: document.getElementById('footer-phone')?.value || '',
        instagram: document.getElementById('footer-instagram')?.value || '',
        facebook: document.getElementById('footer-facebook')?.value || '',
        line: document.getElementById('footer-line')?.value || '',
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser?.email || 'unknown'
    };

    try {
        await setDoc(doc(db, 'site_settings', 'footer'), footerData, { merge: true });
        alert('\u2705 \u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25 Footer \u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08');
    } catch (error) {
        alert(safeAdminError('บันทึกไม่สำเร็จ'));
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
});
