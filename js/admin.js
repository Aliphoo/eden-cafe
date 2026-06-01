import { auth, provider, db } from './firebase-config.js';
import { getMemberTier, getTierBenefits } from './membership.js';
import { BLOG_POSTS, SITE, getBlogUrl } from './blog-data.mjs';
import { signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs, doc, setDoc, addDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot, getDoc, serverTimestamp, writeBatch, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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

    const response = await fetch(FUNCTIONS_BASE_URL + '/' + functionName, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Request failed');
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
    shop: 'สินค้าออนไลน์',
    blogs: 'บทความ',
    faqs: 'FAQ',
    promptpay: '\u0e08\u0e31\u0e14\u0e01\u0e32\u0e23\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e40\u0e1e\u0e22\u0e4c',
    marketing: 'Marketing Tools',
    footer: 'Footer'
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
        pos: true,
        discounts: false,
        loyalty: false,
        orders: true,
        bookings: true,
        tables: false,
        rooms: false,
        products: false,
        shop: false,
        blogs: false,
        faqs: false,
        promptpay: false,
        marketing: false,
        footer: false
    }
};
const ADMIN_TAB_PERMISSIONS = {
    dashboard: 'dashboard',
    pos: 'pos',
    discounts: 'discounts',
    members: 'members',
    loyalty: 'loyalty',
    'admin-access': 'adminAccess',
    orders: 'orders',
    bookings: 'bookings',
    'room-bookings': 'bookings',
    tables: 'tables',
    rooms: 'rooms',
    products: 'products',
    categories: 'products',
    'shop-products': 'shop',
    'shop-categories': 'shop',
    blogs: 'blogs',
    faqs: 'faqs',
    promptpay: 'promptpay',
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
let posSelectedCategory = 'all';
let posSearchTerm = '';
let posCart = [];
let posLastReceipt = null;
let posControlsBound = false;
let productCurrentPage = 1;
let productPageSize = 10;
let productControlsBound = false;
const selectedProductIds = new Set();
const expandedProductIds = new Set();
let categoriesData = {};
let shopProductsData = {};
let shopCategoriesData = {};
let roomsData = {};
let tablesData = {};
let membersData = {};
let membersUnsubscribe = null;
let ordersUnsubscribe = null;
let bookingsUnsubscribe = null;
let categoriesUnsubscribe = null;
let productsUnsubscribe = null;
let tablesUnsubscribe = null;
let roomsUnsubscribe = null;
let shopCategoriesUnsubscribe = null;
let shopProductsUnsubscribe = null;
let blogsUnsubscribe = null;
let faqsUnsubscribe = null;
let memberFiltersBound = false;
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
    shop_products: {
        label: 'สินค้าออนไลน์ (shop_products)',
        collection: 'shop_products',
        permission: 'shop',
        numberFields: ['price', 'stock', 'order'],
        booleanFields: ['isFeatured'],
        arrayFields: [],
        template: { id: 'eden-beans-01', name: 'Eden House Blend', description: 'Medium roast', category: 'coffee_bean', price: 490, stock: 20, imageUrl: 'https://example.com/beans.webp', isFeatured: true, order: 1 }
    },
    shop_categories: {
        label: 'หมวดสินค้าออนไลน์ (shop_categories)',
        collection: 'shop_categories',
        permission: 'shop',
        numberFields: ['order'],
        booleanFields: [],
        arrayFields: [],
        template: { id: 'coffee_bean', name: 'เมล็ดกาแฟ', parent: '', order: 1 }
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
            alert('ดาวน์โหลดข้อมูลไม่สำเร็จ: ' + error.message);
        } finally {
            btnDownloadData.disabled = false;
        }
    };
    btnTemplate.onclick = () => {
        try {
            downloadCategoryTemplateAsXLSX(select.value);
        } catch (error) {
            alert('ดาวน์โหลดเทมเพลตไม่สำเร็จ: ' + error.message);
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
            alert('อัปโหลดไม่สำเร็จ: ' + error.message);
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
        fetchStats();
        bindSalesReportNav();
        renderDashboardSalesReport();
        if (!categoriesUnsubscribe) setupRealtimeCategories();
    }
    if (canAdmin('orders') || canAdmin('pos')) setupRealtimeOrders();
    if (canAdmin('bookings')) setupRealtimeBookings();
    if (canAdmin('products')) {
        setupRealtimeCategories();
        setupRealtimeProducts();
        initLoyverseImportTool();
    }
    if (canAdmin('tables')) setupRealtimeTables();
    if (canAdmin('rooms')) setupRealtimeRooms();
    if (canAdmin('shop')) {
        setupRealtimeShopCategories();
        setupRealtimeShopProducts();
    }
    if (canAdmin('members') || canAdmin('loyalty')) setupRealtimeMembers();
    if (canAdmin('discounts')) setupRealtimeDiscounts();
    if (canAdmin('loyalty')) setupRealtimeLoyalty();
    if (canAdmin('promptpay') && typeof window.loadPromptPaySettings === 'function') window.loadPromptPaySettings();
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

function getPreferredAdminTabId() {
    if (hasLoyverseImportMode()) return 'dashboard';

    const hash = decodeURIComponent(String(window.location.hash || '').replace(/^#/, '')).replace(/^tab=/, '');
    if (hash && document.getElementById(hash)) return hash;

    const fromQuery = new URLSearchParams(window.location.search).get('tab');
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
                setupRealtimeBookings();
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
            case 'shop-products':
                setupRealtimeShopCategories();
                setupRealtimeShopProducts();
                break;
            case 'shop-categories':
                setupRealtimeShopCategories();
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
        alert('รีเฟรชข้อมูลไม่สำเร็จ: ' + error.message);
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
            alert('บันทึกส่วนลดไม่สำเร็จ: ' + error.message);
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
        alert('ลบส่วนลดไม่สำเร็จ: ' + error.message);
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
        alert('เติมชุดส่วนลดไม่สำเร็จ: ' + error.message);
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
            alert('บันทึกกติกาแต้มไม่สำเร็จ: ' + error.message);
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
            alert('ปรับแต้มไม่สำเร็จ: ' + error.message);
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
        const snap = await getDoc(statsRef);
        const viewsEl = document.getElementById('stat-views-daily');
        if (snap.exists() && viewsEl) {
            const data = snap.data();
            viewsEl.innerText = (data.dailyViews || 0).toLocaleString();
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

function salesReportRange() {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + salesReportMonthOffset, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const todayKey = localDateKey(now);
    const end = salesReportMonthOffset === 0 ? now : last;
    return {
        start: first,
        end,
        startKey: localDateKey(first),
        endKey: localDateKey(end),
        todayKey
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

function orderReportDateValue(order = {}) {
    const raw = order.timestamp || order.createdAt || order.date;
    if (raw?.toDate) return raw.toDate().getTime();
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function orderReportDateKey(order = {}) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(order.businessDate || ''))) return order.businessDate;
    const time = orderReportDateValue(order);
    return time ? localDateKey(new Date(time)) : '';
}

function isOrderInSalesReportRange(order = {}) {
    const key = orderReportDateKey(order);
    const range = salesReportRange();
    return !!key && key >= range.startKey && key <= range.endKey;
}

function isOrderInSalesReportTime(order = {}) {
    if (salesReportTimeFilter === 'all') return true;
    const time = orderReportDateValue(order);
    if (!time) return true;
    const hour = new Date(time).getHours();
    if (salesReportTimeFilter === 'morning') return hour >= 6 && hour < 12;
    if (salesReportTimeFilter === 'afternoon') return hour >= 12 && hour < 18;
    if (salesReportTimeFilter === 'evening') return hour >= 18 && hour < 24;
    return true;
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
        .filter(isOrderForSalesReportEmployee);
}

function dashboardRefundOrders() {
    return dashboardOrdersData
        .filter(isRefundOrder)
        .filter(isOrderInSalesReportRange)
        .filter(isOrderInSalesReportTime)
        .filter(isOrderForSalesReportEmployee);
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
                meta: [formatDate(order.timestamp || order.createdAt), order.cashierName || order.customerName || ''].filter(Boolean).join(' · ')
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
    const select = document.getElementById('sales-report-employee-filter');
    if (!select) return;
    const employees = new Map();
    dashboardOrdersData.forEach(order => {
        const key = salesReportEmployeeKey(order);
        if (!key || key === 'unknown') return;
        employees.set(key, salesReportEmployeeName(order));
    });
    const current = salesReportEmployeeFilter;
    select.innerHTML = '<option value="all">พนักงานทั้งหมด</option>'
        + Array.from(employees.entries())
            .sort((a, b) => a[1].localeCompare(b[1], 'th'))
            .map(([key, label]) => `<option value="${escapeHTML(key)}">${escapeHTML(label)}</option>`)
            .join('');
    select.value = employees.has(current) ? current : 'all';
    salesReportEmployeeFilter = select.value;
}

function updateSalesReportToolbar() {
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

function renderDashboardSalesReport() {
    updateSalesReportToolbar();
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
    renderDashboardSalesReport();
};

window.setSalesReportTimeFilter = (value = 'all') => {
    salesReportTimeFilter = ['all', 'morning', 'afternoon', 'evening'].includes(value) ? value : 'all';
    renderDashboardSalesReport();
};

window.setSalesReportEmployeeFilter = (value = 'all') => {
    salesReportEmployeeFilter = value || 'all';
    renderDashboardSalesReport();
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
    const value = order.timestamp || order.createdAt || order.date || order.businessDate;
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
        alert('ดาวน์โหลดข้อมูลยอดขายไม่สำเร็จ: ' + (error.message || error));
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
                <td>${formatDate(order.timestamp)}</td>
                <td>${getStatusBadgeHTML(status, 'order')}</td>
                <td>
                    <select onchange="updateOrderStatus('${escapeJSString(id)}', this.value)" style="padding: 5px; border-radius: 5px; border: 1px solid #ddd;">
                        <option value="pending" ${status === 'pending' ? 'selected' : ''}>รอดำเนินการ</option>
                        <option value="processing" ${status === 'processing' ? 'selected' : ''}>กำลังทำ</option>
                        <option value="completed" ${status === 'completed' ? 'selected' : ''}>เสร็จสิ้น</option>
                        <option value="cancelled" ${status === 'cancelled' ? 'selected' : ''}>ยกเลิก</option>
                    </select>
                    ${canVoidPos ? `<button class="btn-action btn-delete" type="button" style="margin-left:6px;" onclick="voidPosOrder('${escapeJSString(id)}')">Void</button>` : ''}
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

        snapshot.forEach((docSnap) => {
            const booking = docSnap.data();
            const id = docSnap.id;
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
        alert("เกิดข้อผิดพลาด: " + error.message);
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
        renderPosScreen();
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
    renderPosScreen();
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
        alert("บันทึกไม่สำเร็จ: " + error.message);
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
                renderAdminTableMap(getMapItems());
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
                alert('บันทึกตำแหน่งไม่สำเร็จ: ' + error.message);
                renderAdminTableMap(getMapItems());
            }
        };

        const cancel = (cancelEvent) => {
            element.releasePointerCapture?.(cancelEvent.pointerId);
            element.classList.remove('is-dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', cancel);
            renderAdminTableMap(getMapItems());
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
        el.className = 'admin-map-zone';
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
        el.className = 'admin-map-table shape-' + table.shape + ' is-' + table.status;
        el.style.left = table.x + '%';
        el.style.top = table.y + '%';
        el.innerHTML = '<span>' + escapeHTML(table.code) + '</span><small>' + escapeHTML(table.seats) + ' seats</small>';
        attachMapDrag(el, table, preview);
        preview.appendChild(el);
    });
    if (summary) summary.textContent = 'โซน ' + zones.length + ' รายการ · โต๊ะ ' + tableItems.length + ' ตัว · คลิกแก้ไขจากตารางด้านซ้าย';
}

function renderTablesManager(snapshot) {
    const tbody = document.getElementById('tables-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    tablesData = {};
    snapshot.forEach((docSnap) => { tablesData[docSnap.id] = docSnap.data(); });
    const items = getMapItems().sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'zone' ? -1 : 1;
        return (a.name || a.code || a.id).localeCompare(b.name || b.code || b.id);
    });
    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">ยังไม่มีแผนผังโต๊ะ กด “ใช้แผนผังเริ่มต้น” เพื่อเริ่มได้เลย</td></tr>';
        renderAdminTableMap([]);
        updateZoneDatalist([]);
        return;
    }
    items.forEach(item => {
        const tr = document.createElement('tr');
        const isZone = item.kind === 'zone';
        tr.innerHTML = '<td><span class="map-admin-pill ' + (isZone ? 'zone' : '') + '">' + (isZone ? 'โซน' : 'โต๊ะ') + '</span></td>'
            + '<td><strong>' + escapeHTML(isZone ? item.name : item.code) + '</strong><br><small class="text-muted">' + escapeHTML(item.id) + '</small></td>'
            + '<td>' + (isZone ? escapeHTML(item.hint || '-') : escapeHTML(item.zone) + '<br><small>' + escapeHTML(item.status) + '</small>') + '</td>'
            + '<td>X ' + escapeHTML(item.x) + '% · Y ' + escapeHTML(item.y) + '%</td>'
            + '<td>' + (isZone ? 'W ' + escapeHTML(item.w) + '% · H ' + escapeHTML(item.h) + '%' : escapeHTML(item.seats) + ' seats · ' + escapeHTML(item.shape)) + '</td>'
            + '<td><button class="btn-action btn-edit" onclick="editTable(\'' + escapeJSString(item.id) + '\')">แก้ไข</button> '
            + '<button class="btn-action btn-delete" onclick="deleteTable(\'' + escapeJSString(item.id) + '\')">ลบ</button></td>';
        tbody.appendChild(tr);
    });
    renderAdminTableMap(items);
    updateZoneDatalist(items);
}

function setupRealtimeTables() {
    if (tablesUnsubscribe) {
        tablesUnsubscribe();
        tablesUnsubscribe = null;
    }
    const q = query(collection(db, 'tables'));
    tablesUnsubscribe = onSnapshot(q, renderTablesManager, (error) => {
        console.error('Error listening to table map:', error);
        const tbody = document.getElementById('tables-table-body');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:red;">โหลดข้อมูลแผนผังไม่สำเร็จ</td></tr>';
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
        alert('สร้างแผนผังไม่สำเร็จ: ' + error.message);
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
        alert('บันทึกไม่สำเร็จ: ' + error.message);
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
        alert('เกิดข้อผิดพลาด: ' + error.message);
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
                            <button class="menu-row-toggle" type="button" data-id="${escapeHTML(id)}" aria-label="Toggle variants">${isExpanded ? '⌃' : '⌄'}</button>
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
                alert('Upload failed: ' + error.message);
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
        alert('Update category failed: ' + error.message);
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
        alert('Export failed: ' + error.message);
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
        renderPosScreen();
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
    renderPosScreen();
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
        alert("บันทึกไม่สำเร็จ: " + error.message);
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
    if (event.target == shopProductModal) {
        closeShopProductModal();
    }
    if (event.target == shopCategoryModal) {
        closeShopCategoryModal();
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
        alert('Void ออเดอร์ POS ไม่สำเร็จ: ' + error.message);
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
        alert('นำเข้าบทความไม่สำเร็จ: ' + error.message);
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
        alert("บันทึกไม่สำเร็จ: " + error.message);
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
            for (const p of initialProducts) { await addDoc(collection(db, "products"), p); }         // Migrate Shop Categories
        const shopCatQ = query(collection(db, "shop_categories"));
        const shopCatSnap = await getDocs(shopCatQ);
        if (shopCatSnap.empty) {
            console.log("Migrating initial shop categories...");
            await setDoc(doc(db, "shop_categories", "cat-1"), { name: "เมล็ดกาแฟและสารกาแฟ", parentId: null });
            await setDoc(doc(db, "shop_categories", "cat-2"), { name: "ชาและวัตถุดิบ", parentId: null });
            await setDoc(doc(db, "shop_categories", "cat-3"), { name: "เบเกอรี่", parentId: null });
            await setDoc(doc(db, "shop_categories", "cat-4"), { name: "ของพรีเมี่ยม", parentId: null });
        }

        // Migrate Shop Products
        const shopProdQ = query(collection(db, "shop_products"));
        const shopProdSnap = await getDocs(shopProdQ);
        if (shopProdSnap.empty) {
            console.log("Migrating initial shop products...");
            const initialShopProducts = [
                { name: "เมล็ดกาแฟคั่วอ่อน", description: "โทนผลไม้ ดอกไม้ สดชื่น เหมาะสำหรับดริปหรืออเมริกาโน่", price: 450, stock: 10, imageUrl: "https://images.unsplash.com/photo-1559525839-b184a4d698c7?auto=format&fit=crop&w=600&q=80", category: "cat-1", isFeatured: true },
                { name: "เมล็ดกาแฟ House Blend", description: "สูตรเบลนด์พิเศษเฉพาะของ Eden Cafe ชงเมนูไหนก็ลงตัว", price: 490, stock: 20, imageUrl: "https://images.unsplash.com/photo-1541167760496-1628856ab772?auto=format&fit=crop&w=600&q=80", category: "cat-1", isFeatured: true },
                { name: "ใบชาแห้งและผงมัทฉะแท้", description: "ชาไทย ชาเขียวเชียงใหม่ และผงมัทฉะแท้ 100% สำหรับชงดื่ม", price: 250, stock: 15, imageUrl: "https://images.unsplash.com/photo-1582793988951-9aed5509eb97?auto=format&fit=crop&w=600&q=80", category: "cat-2", isFeatured: false },
                { name: "ซอฟต์คุกกี้ (Soft Cookies)", description: "รสช็อกโกแลตชิป และมัทฉะไวท์ช็อก ทานคู่กับกาแฟอร่อยลงตัว", price: 85, stock: 30, imageUrl: "https://images.unsplash.com/photo-1499636136210-6f4ee915583e?auto=format&fit=crop&w=600&q=80", category: "cat-3", isFeatured: true },
                { name: "แก้วเก็บความเย็น (Tumbler)", description: "สกรีนโลโก้ร้าน Eden เก็บความเย็น 12 ชม. สไตล์มินิมอล", price: 890, stock: 5, imageUrl: "https://images.unsplash.com/photo-1517256064527-09c73fc73e38?auto=format&fit=crop&w=600&q=80", category: "cat-4", isFeatured: true }
            ];
            for (const p of initialShopProducts) {
                p.createdAt = new Date().toISOString();
                await addDoc(collection(db, "shop_products"), p);
            }
        }
        }
    } catch (e) { console.error("Migrate failed", e); }
}

// --- Shop Management Logic ---
function setupRealtimeShopCategories() {
    if (shopCategoriesUnsubscribe) {
        shopCategoriesUnsubscribe();
        shopCategoriesUnsubscribe = null;
    }
    const q = query(collection(db, "shop_categories"));
    shopCategoriesUnsubscribe = onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('shop-categories-table-body');
        const selectCat = document.getElementById('shopProductCategory');
        const selectParent = document.getElementById('shopCatParentInput');
        tbody.innerHTML = '';
        selectCat.innerHTML = '<option value="">--  --</option>';
        selectParent.innerHTML = '<option value="">--  --</option>';
        shopCategoriesData = {};
        
        if (snapshot.empty) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;"> Shop</td></tr>';
            return;
        }

        snapshot.forEach((docSnap) => {
            const cat = docSnap.data();
            const id = docSnap.id;
            shopCategoriesData[id] = cat;
            
            const createdAt = cat.createdAt ? formatDate(cat.createdAt) : '-';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${escapeHTML(cat.name)}</strong><br><small style="color:#888;">${escapeHTML(id)}</small></td>
                <td>${createdAt}</td>
                <td>
                    <button class="btn-action btn-edit" onclick="editShopCategory('${escapeJSString(id)}')">แก้ไข</button>
                    <button class="btn-action btn-delete" onclick="deleteShopCategory('${escapeJSString(id)}')">ลบ</button>
                </td>
            `;
            tbody.appendChild(tr);

            const opt = document.createElement('option');
            opt.value = id;
            opt.innerText = cat.name;
            selectCat.appendChild(opt);

            const optParent = document.createElement('option');
            optParent.value = id;
            optParent.innerText = cat.name;
            selectParent.appendChild(optParent);
        });
    }, (error) => {
        console.error("Error listening to shop categories:", error);
    });
}

function setupRealtimeShopProducts() {
    if (shopProductsUnsubscribe) {
        shopProductsUnsubscribe();
        shopProductsUnsubscribe = null;
    }
    const q = query(collection(db, "shop_products"));
    shopProductsUnsubscribe = onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('shop-products-table-body');
        tbody.innerHTML = '';
        shopProductsData = {};
        
        if (snapshot.empty) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;"> Shop</td></tr>';
            return;
        }

        snapshot.forEach((docSnap) => {
            const product = docSnap.data();
            const id = docSnap.id;
            shopProductsData[id] = product;
            
            let catName = product.category;
            if (shopCategoriesData[product.category]) {
                catName = shopCategoriesData[product.category].name;
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><img loading="lazy" src="${safeImageURL(product.imageUrl)}" alt="${escapeHTML(product.name)}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px;"></td>
                <td><strong>${escapeHTML(product.name)}</strong></td>
                <td>${escapeHTML(catName)}</td>
                <td>${escapeHTML(product.price)}</td>
                <td>${escapeHTML(product.stock || 0)}</td>
                <td>${product.isFeatured ? '<span style="color: green;"> </span>' : '-'}</td>
                <td>
                    <button class="btn-action btn-edit" onclick="editShopProduct('${escapeJSString(id)}')">แก้ไข</button>
                    <button class="btn-action btn-delete" onclick="deleteShopProduct('${escapeJSString(id)}')">ลบ</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }, (error) => {
        console.error("Error listening to shop products:", error);
    });
}

// Shop Category Modal Logic
const shopCategoryModal = document.getElementById('shopCategoryModal');
const shopCategoryForm = document.getElementById('shopCategoryForm');

window.openShopCategoryModal = () => {
    shopCategoryForm.reset();
    document.getElementById('shopCategoryId').value = '';
    document.getElementById('shopCatIdInput').disabled = false;
    document.getElementById('shop-cat-modal-title').innerText = 'เพิ่มหมวดหมู่ Shop';
    shopCategoryModal.style.display = 'block';
};

window.closeShopCategoryModal = () => {
    shopCategoryModal.style.display = 'none';
};

window.editShopCategory = (id) => {
    const cat = shopCategoriesData[id];
    if (!cat) return;
    
    document.getElementById('shopCategoryId').value = id;
    document.getElementById('shopCatIdInput').value = id;
    document.getElementById('shopCatIdInput').disabled = true;
    document.getElementById('shopCatNameInput').value = cat.name || '';
    document.getElementById('shopCatParentInput').value = cat.parentId || '';
    
    document.getElementById('shop-cat-modal-title').innerText = ' Shop';
    shopCategoryModal.style.display = 'block';
};

window.deleteShopCategory = async (id) => {
    if (confirm(" Shop ?")) {
        try {
            await deleteDoc(doc(db, "shop_categories", id));
        } catch (e) {
            alert("ลบไม่สำเร็จ: " + e.message);
        }
    }
};

shopCategoryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const hiddenId = document.getElementById('shopCategoryId').value;
    const inputId = document.getElementById('shopCatIdInput').value.trim().toLowerCase();
    const catName = document.getElementById('shopCatNameInput').value.trim();
    const parentId = document.getElementById('shopCatParentInput').value;
    
    if (!inputId) return alert("กรุณาระบุรหัสหมวดหมู่");
    if (!catName) return alert("กรุณาระบุชื่อหมวดหมู่");
    
    const submitBtn = shopCategoryForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.innerText = 'กำลังบันทึก...';
    
    try {
        const docRef = doc(db, "shop_categories", inputId);
        const data = { name: catName, parentId: parentId || null };
        if (!hiddenId) {
            data.createdAt = serverTimestamp();
        }
        await setDoc(docRef, data, { merge: true });
        closeShopCategoryModal();
        alert('บันทึกหมวดหมู่สำเร็จ!');
    } catch (error) {
        console.error('Error saving shop category:', error);
        alert("บันทึกไม่สำเร็จ: " + error.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = 'บันทึกหมวดหมู่';
    }
});

// Shop Product Modal Logic
const shopProductModal = document.getElementById('shopProductModal');
const shopProductForm = document.getElementById('shopProductForm');

window.openShopProductModal = () => {
    shopProductForm.reset();
    document.getElementById('shopProductId').value = '';
    document.getElementById('shopProductImageFile').value = '';
    document.getElementById('shop-modal-title').innerText = 'เพิ่มสินค้า Shop';
    shopProductModal.style.display = 'block';
};

window.closeShopProductModal = () => {
    shopProductModal.style.display = 'none';
};

window.editShopProduct = (id) => {
    const product = shopProductsData[id];
    if (!product) return;
    
    document.getElementById('shopProductId').value = id;
    document.getElementById('shopProductName').value = product.name || '';
    document.getElementById('shopProductDesc').value = product.description || '';
    document.getElementById('shopProductPrice').value = product.price || 0;
    document.getElementById('shopProductStock').value = product.stock || 0;
    document.getElementById('shopProductImage').value = product.imageUrl || '';
    document.getElementById('shopProductCategory').value = product.category || '';
    document.getElementById('shopProductFeatured').checked = !!product.isFeatured;
    
    document.getElementById('shop-modal-title').innerText = ' Shop';
    shopProductModal.style.display = 'block';
};

window.deleteShopProduct = async (id) => {
    if (confirm("?")) {
        try {
            await deleteDoc(doc(db, "shop_products", id));
        } catch (e) {
            alert("ลบไม่สำเร็จ: " + e.message);
        }
    }
};

shopProductForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = document.getElementById('shopProductId').value;
    const submitBtn = shopProductForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerText;
    
    try {
        submitBtn.disabled = true;
        submitBtn.innerText = 'กำลังบันทึก...';
        
        let finalImageUrl = document.getElementById('shopProductImage').value;
        const imageFile = document.getElementById('shopProductImageFile').files[0];
        
        if (imageFile) {
            submitBtn.innerText = 'กำลังแปลงรูปภาพ...';
            const webpBlob = await compressToWebP(imageFile, 0.8);
            submitBtn.innerText = 'กำลังอัปโหลดรูปภาพ...';
            finalImageUrl = await uploadAdminImage(webpBlob, 'shop_products', Date.now() + '_image.webp');
        }

        if (!finalImageUrl) {
            throw new Error("กรุณาอัปโหลดรูปภาพ หรือใส่ลิงก์รูปภาพ");
        }

        const productData = {
            name: document.getElementById('shopProductName').value,
            description: document.getElementById('shopProductDesc').value,
            price: Number(document.getElementById('shopProductPrice').value),
            stock: Number(document.getElementById('shopProductStock').value),
            imageUrl: finalImageUrl,
            category: document.getElementById('shopProductCategory').value,
            isFeatured: document.getElementById('shopProductFeatured').checked,
            createdAt: new Date().toISOString()
        };
        
        if (id) {
            delete productData.createdAt; // Prevent overwriting creation time
            await updateDoc(doc(db, "shop_products", id), productData);
        } else {
            await addDoc(collection(db, "shop_products"), productData);
        }
        closeShopProductModal();
        alert('บันทึกข้อมูลสำเร็จ!');
    } catch (error) {
        console.error('Error saving shop product:', error);
        alert("บันทึกไม่สำเร็จ: " + error.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = originalText;
    }
});


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
        alert('Member sync failed: ' + error.message);
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
    container.innerHTML = Object.entries(ADMIN_PERMISSION_LABELS).map(([key, label]) => `
        <label>
            <input type="checkbox" data-access-permission="${escapeHTML(key)}" ${selected[key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <span>${escapeHTML(label)}</span>
        </label>
    `).join('');
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
        alert('บันทึกสิทธิ์ผู้จัดการไม่สำเร็จ: ' + error.message);
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

function memberCode(uid, member = {}) {
    if (member.memberCode) return member.memberCode;
    const source = String(uid || member.uid || '000000').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase().padStart(6, '0');
    return 'ED-' + source;
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
    return Object.entries(ADMIN_PERMISSION_LABELS).map(([key, label]) => `
        <label>
            <input type="checkbox" data-member-staff-permission="${escapeHTML(key)}" ${selected[key] ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <span>${escapeHTML(label)}</span>
        </label>
    `).join('');
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
    if (membersUnsubscribe) membersUnsubscribe();
    const q = query(collection(db, 'users'));
    membersUnsubscribe = onSnapshot(q, (snapshot) => {
        membersData = {};
        snapshot.forEach(docSnap => {
            membersData[docSnap.id] = { uid: docSnap.id, ...docSnap.data() };
        });
        renderMembersTable();
        renderAdminUserOptions();
        renderLoyaltyMemberOptions();
        renderLoyaltySummary();
    }, (error) => {
        console.error('Error listening to members:', error);
        const tbody = document.getElementById('members-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:#c62828;">Unable to load members: ${escapeHTML(error.message)}</td></tr>`;
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
    const [ordersSnap, bookingsSnap] = await Promise.all([
        getDocs(query(collection(db, 'orders'), where('uid', '==', uid))),
        getDocs(query(collection(db, 'bookings'), where('uid', '==', uid)))
    ]);

    const orders = [];
    ordersSnap.forEach(docSnap => orders.push({ id: docSnap.id, ...docSnap.data() }));
    const bookings = [];
    bookingsSnap.forEach(docSnap => bookings.push({ id: docSnap.id, ...docSnap.data() }));

    orders.sort((a, b) => memberTimestampToMillis(b.timestamp || b.createdAt) - memberTimestampToMillis(a.timestamp || a.createdAt));
    bookings.sort((a, b) => memberTimestampToMillis(b.timestamp || b.createdAt) - memberTimestampToMillis(a.timestamp || a.createdAt));
    return { orders, bookings };
}

function renderActivityItems(items, type) {
    if (!items.length) return '<div class="member-empty-state">No history yet</div>';
    return items.slice(0, 8).map(item => {
        const title = type === 'order'
            ? `Order ${escapeHTML(item.id.slice(0, 8).toUpperCase())}`
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
        membersData[uid] = { ...membersData[uid], ...payload, updatedAt: new Date().toISOString() };
        renderMembersTable();
    } catch (error) {
        console.error('Unable to save member admin fields:', error);
        if (statusEl) {
            statusEl.textContent = 'Save failed: ' + error.message;
            statusEl.style.color = '#c62828';
        } else {
            alert('Save failed: ' + error.message);
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
            alert('Save failed: ' + error.message);
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
        alert('Remove staff access failed: ' + error.message);
    }
};

// ==========================================
// FAQ Management Logic
// ==========================================
let faqsData = {};

const faqModal = document.getElementById('faqModal');
const faqForm = document.getElementById('faqForm');

window.fetchFaqsFromCloud = function() {
    if (faqsUnsubscribe) {
        faqsUnsubscribe();
        faqsUnsubscribe = null;
    }
    const q = query(collection(db, "faqs"), orderBy("order", "asc"));
    faqsUnsubscribe = onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('faqs-table-body');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        faqsData = {};
        
        let index = 1;
        snapshot.forEach((docSnap) => {
            const faq = docSnap.data();
            const id = docSnap.id;
            faqsData[id] = faq;
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHTML(faq.order || index)}</td>
                <td><strong>${escapeHTML(faq.question)}</strong></td>
                <td><div style="max-height: 80px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;">${escapeHTML(faq.answer)}</div></td>
                <td>
                    <button class="btn-action btn-edit" onclick="editFaq('${escapeJSString(id)}')">แก้ไข</button>
                    <button class="btn-action btn-delete" onclick="deleteFaq('${escapeJSString(id)}')">ลบ</button>
                </td>
            `;
            tbody.appendChild(tr);
            index++;
        });
    }, (error) => {
        console.error("Error fetching FAQs:", error);
    });
}

window.openFaqModal = () => {
    faqForm.reset();
    document.getElementById('faqId').value = '';
    document.getElementById('faqOrder').value = Object.keys(faqsData).length + 1;
    document.getElementById('faqModalTitle').innerText = 'เพิ่มคำถามใหม่';
    faqModal.style.display = 'block';
};

window.closeFaqModal = () => {
    faqModal.style.display = 'none';
};

window.editFaq = (id) => {
    const faq = faqsData[id];
    if (!faq) return;
    
    document.getElementById('faqId').value = id;
    document.getElementById('faqQuestion').value = faq.question || '';
    document.getElementById('faqAnswer').value = faq.answer || '';
    document.getElementById('faqOrder').value = faq.order || 0;
    
    document.getElementById('faqModalTitle').innerText = 'แก้ไขคำถาม';
    faqModal.style.display = 'block';
};

window.deleteFaq = async (id) => {
    if (confirm("คุณแน่ใจหรือไม่ว่าต้องการลบคำถามนี้?")) {
        try {
            await deleteDoc(doc(db, "faqs", id));
        } catch (e) {
            alert("ลบไม่สำเร็จ: " + e.message);
        }
    }
};

faqForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = document.getElementById('faqId').value;
    const faqData = {
        question: document.getElementById('faqQuestion').value,
        answer: document.getElementById('faqAnswer').value,
        order: Number(document.getElementById('faqOrder').value),
        updatedAt: new Date().toISOString()
    };
    
    try {
        if (id) {
            await updateDoc(doc(db, "faqs", id), faqData);
        } else {
            faqData.createdAt = new Date().toISOString();
            await addDoc(collection(db, "faqs"), faqData);
        }
        closeFaqModal();
    } catch (error) {
        alert("บันทึกไม่สำเร็จ: " + error.message);
    }
});

// Start fetching FAQs when logged in
onAuthStateChanged(auth, (user) => {
    if (user) {
        if(typeof fetchFaqsFromCloud === 'function') fetchFaqsFromCloud();
        if(typeof loadFooterSettings === 'function') loadFooterSettings();
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
        applyPromptPaySettingsToForm(settings);
        setPromptPayAdminStatus(snap.exists() ? 'PromptPay settings loaded.' : 'Using default PromptPay settings. Save once to publish them.', snap.exists() ? 'success' : 'warning');
        return settings;
    } catch (error) {
        console.error('Error loading PromptPay settings:', error);
        applyPromptPaySettingsToForm(defaultPromptPaySettings());
        setPromptPayAdminStatus('Unable to load PromptPay settings: ' + error.message, 'error');
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
        applyPromptPaySettingsToForm(payload);
        setPromptPayAdminStatus('PromptPay settings saved. POS will use ' + activePromptPayAccount(payload).label + ' automatically.', 'success');
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
        alert('Unable to save marketing settings: ' + error.message);
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
        alert('\u274c \u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08: ' + error.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
});





