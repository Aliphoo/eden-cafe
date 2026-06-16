import { db } from './firebase-config.js';
import { collection, getDocs, onSnapshot, query } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FALLBACK_PRODUCTS = [
    { id: 'p1_light', category: 'coffee', categoryNameTh: 'เมล็ดกาแฟ', categoryNameEn: 'Coffee Beans', nameTh: 'Light Roast Beans', nameEn: 'Light Roast Beans', descriptionTh: 'โทนผลไม้สดชื่น เหมาะกับดริปและอเมริกาโน่', descriptionEn: 'Bright fruity notes for pour-over and americano.', price: 450, imageUrl: 'https://images.unsplash.com/photo-1559525839-b184a4d698c7?auto=format&fit=crop&w=600&q=80', stock: 12 },
    { id: 'p1_medium', category: 'coffee', categoryNameTh: 'เมล็ดกาแฟ', categoryNameEn: 'Coffee Beans', nameTh: 'Medium Roast Beans', nameEn: 'Medium Roast Beans', descriptionTh: 'บาลานซ์ดี หอมหวาน ดื่มง่ายทุกวัน', descriptionEn: 'Balanced, sweet, and easy to drink every day.', price: 450, imageUrl: 'https://images.unsplash.com/photo-1587734195503-904fca47e0e9?auto=format&fit=crop&w=600&q=80', stock: 10 },
    { id: 'p1_house', category: 'coffee', categoryNameTh: 'เมล็ดกาแฟ', categoryNameEn: 'Coffee Beans', nameTh: 'Eden House Blend', nameEn: 'Eden House Blend', descriptionTh: 'เบลนด์ประจำร้าน หอมช็อกโกแลตและคาราเมล', descriptionEn: 'Our signature blend with chocolate and caramel notes.', price: 490, imageUrl: 'https://images.unsplash.com/photo-1541167760496-1628856ab772?auto=format&fit=crop&w=600&q=80', stock: 15 },
    { id: 'p2_matcha', category: 'tea', categoryNameTh: 'ชาและมัทฉะ', categoryNameEn: 'Tea & Matcha', nameTh: 'Premium Matcha Powder', nameEn: 'Premium Matcha Powder', descriptionTh: 'มัทฉะเกรดพรีเมียมสำหรับชงลาเต้', descriptionEn: 'Premium matcha powder for cafe-style latte.', price: 250, imageUrl: 'https://images.unsplash.com/photo-1582793988951-9aed5509eb97?auto=format&fit=crop&w=600&q=80', stock: 9 },
    { id: 'p3_cookie', category: 'bakery', categoryNameTh: 'เบเกอรี่', categoryNameEn: 'Bakery', nameTh: 'Soft Cookies', nameEn: 'Soft Cookies', descriptionTh: 'คุกกี้เนื้อนุ่ม หอมเนย อบสดใหม่', descriptionEn: 'Soft butter cookies, freshly baked.', price: 85, imageUrl: 'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?auto=format&fit=crop&w=600&q=80', stock: 18 },
    { id: 'p3_croissant', category: 'bakery', categoryNameTh: 'เบเกอรี่', categoryNameEn: 'Bakery', nameTh: 'French Butter Croissant', nameEn: 'French Butter Croissant', descriptionTh: 'ครัวซองต์เนยฝรั่งเศส กรอบนอกนุ่มใน', descriptionEn: 'French butter croissant, crisp outside and soft inside.', price: 120, imageUrl: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=600&q=80', stock: 8 },
    { id: 'p4_tumbler', category: 'merch', categoryNameTh: 'ของที่ระลึก', categoryNameEn: 'Merchandise', nameTh: 'Eden Insulated Tumbler', nameEn: 'Eden Insulated Tumbler', descriptionTh: 'แก้วเก็บอุณหภูมิสำหรับกาแฟแก้วโปรด', descriptionEn: 'Insulated tumbler for your favorite coffee.', price: 890, imageUrl: 'https://images.unsplash.com/photo-1517256064527-09c73fc73e38?auto=format&fit=crop&w=600&q=80', stock: 6 },
    { id: 'p4_bag', category: 'merch', categoryNameTh: 'ของที่ระลึก', categoryNameEn: 'Merchandise', nameTh: 'Canvas Tote Bag', nameEn: 'Canvas Tote Bag', descriptionTh: 'กระเป๋าผ้าแคนวาส Eden Cafe ใช้ซ้ำได้', descriptionEn: 'Reusable Eden Cafe canvas tote bag.', price: 290, imageUrl: 'https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=600&q=80', stock: 11 }
];

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
    const basePrice = Number(product.price) || 0;
    const variantPrice = Number(activeVariant?.price);
    const displayPrice = Number.isFinite(variantPrice) && variantPrice > 0 ? variantPrice : basePrice;
    const trackStock = parseShopBoolean(product.trackStock, source === 'shop');
    const stock = Number(product.stock);
    return {
        id: source === 'menu' ? `menu-${rawId}` : rawId,
        source,
        category: categoryId,
        categoryName: getShopCategoryName(product, category, categoryId),
        name: product.name || (en ? product.nameEn : product.nameTh) || 'Eden Product',
        description: product.description || (en ? product.descriptionEn : product.descriptionTh) || '',
        price: displayPrice,
        imageUrl: product.imageUrl || product.image || 'Images/Logo.webp',
        stock: trackStock ? (Number.isFinite(stock) ? stock : 0) : (Number.isFinite(stock) && stock > 0 ? stock : 99),
        availableForSale: parseShopBoolean(product.availableForSale, true),
        showInShop: parseShopBoolean(product.showInShop, source === 'shop'),
        variants
    };
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

function renderProducts(container, products, note = '') {
    const en = isEnglishPage();
    const fallbackMode = Boolean(note);
    const grouped = products.reduce((acc, product) => {
        if (!acc[product.category]) acc[product.category] = { title: product.categoryName, items: [] };
        acc[product.category].items.push(product);
        return acc;
    }, {});

    const categoryTitle = product => grouped[product.category]?.title || (en ? 'Products' : 'สินค้า');
    const productCards = products.map(product => {
        const soldOut = product.stock <= 0 || fallbackMode;
        const title = categoryTitle(product);
        return `
            <div class="shop-card" data-category="cat-${escapeHTML(product.category)}">
                <div class="shop-img-wrapper"><img loading="lazy" src="${safeImageURL(product.imageUrl)}" alt="${escapeHTML(product.name)}" class="shop-img"></div>
                <div class="shop-details">
                    <span class="shop-category">${escapeHTML(title)}</span>
                    <h3>${escapeHTML(product.name)}</h3>
                    <p>${escapeHTML(product.description)}</p>
                    <p class="shop-stock" style="color:${soldOut ? '#b91c1c' : '#0f7a3d'};">${soldOut ? (en ? 'Sold out' : 'สินค้าหมด') : (en ? `In stock: ${product.stock}` : `เหลือ ${product.stock} ชิ้น`)}</p>
                    <div class="shop-action">
                        <span class="shop-price">฿${product.price.toLocaleString('en-US')}</span>
                        <button class="btn btn-add-cart" ${soldOut ? 'disabled style="background:#ccc;"' : ''} data-id="${escapeHTML(product.id)}" data-name="${escapeHTML(product.name)}" data-price="${product.price}">
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

    const [menuCatSnap, menuProdSnap] = await Promise.all([
        getDocs(query(collection(db, 'categories'))),
        getDocs(query(collection(db, 'products')))
    ]);
    const menuCategoryMap = {};
    menuCatSnap.forEach(docSnap => { menuCategoryMap[docSnap.id] = docSnap.data(); });

    return menuProdSnap.docs
        .map(docSnap => normalizeProduct({ id: docSnap.id, source: 'menu', ...docSnap.data() }, menuCategoryMap))
        .filter(product => product.availableForSale !== false && product.showInShop);
}

function normalizeShopSnapshot(menuCatSnap, menuProdSnap) {
    const menuCategoryMap = {};
    menuCatSnap.forEach(docSnap => { menuCategoryMap[docSnap.id] = docSnap.data(); });

    return menuProdSnap.docs
        .map(docSnap => normalizeProduct({ id: docSnap.id, source: 'menu', ...docSnap.data() }, menuCategoryMap))
        .filter(product => product.availableForSale !== false && product.showInShop);
}

function subscribeProductsFromCloud(onResult, onError) {
    if (!db) return () => {};
    let latestMenuCat = null;
    let latestMenuProd = null;
    const emit = () => {
        if (!latestMenuCat || !latestMenuProd) return;
        onResult(normalizeShopSnapshot(latestMenuCat, latestMenuProd));
    };
    const stops = [
        onSnapshot(query(collection(db, 'categories')), snap => { latestMenuCat = snap; emit(); }, onError),
        onSnapshot(query(collection(db, 'products')), snap => { latestMenuProd = snap; emit(); }, onError)
    ];
    return () => stops.forEach(stop => stop());
}

document.addEventListener('DOMContentLoaded', async () => {
    setupTabs();

    const onlineShopContainer = document.getElementById('online-shop');
    if (!onlineShopContainer) return;

    const en = isEnglishPage();
    onlineShopContainer.innerHTML = `<div style="text-align:center; padding:40px;">${en ? 'Loading products...' : 'กำลังโหลดสินค้า...'}</div>`;

    try {
        subscribeProductsFromCloud((products) => {
            if (products.length) {
                renderProducts(onlineShopContainer, products);
            } else {
                renderProducts(onlineShopContainer, fallbackProducts(), en ? 'Showing sample products while the online catalog is empty.' : 'แสดงสินค้าตัวอย่างระหว่างรอข้อมูลจากหลังบ้าน');
            }
        }, (error) => {
            console.error('Error listening to shop products:', error);
            renderProducts(onlineShopContainer, fallbackProducts(), en ? 'Could not load live catalog. Showing fallback products.' : 'ไม่สามารถโหลดสินค้าจากหลังบ้านได้ จึงแสดงสินค้าสำรองไว้ก่อน');
        });
    } catch (error) {
        console.error('Error loading shop products:', error);
        renderProducts(onlineShopContainer, fallbackProducts(), en ? 'Could not load live catalog. Showing fallback products.' : 'ไม่สามารถโหลดสินค้าจากหลังบ้านได้ จึงแสดงสินค้าสำรองไว้ก่อน');
    }
});
