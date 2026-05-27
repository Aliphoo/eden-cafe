import { db } from './firebase-config.js';
import { collection, getDocs, query } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FALLBACK_MENU = [
    { id: 'm-coffee-1', category: 'coffee', categoryNameTh: '\u0e01\u0e32\u0e41\u0e1f', categoryNameEn: 'Coffee', nameTh: 'Drip Coffee Thai Arabica', nameEn: 'Drip Coffee Thai Arabica', descriptionTh: '\u0e01\u0e32\u0e41\u0e1f\u0e14\u0e23\u0e34\u0e1b\u0e40\u0e21\u0e25\u0e47\u0e14\u0e44\u0e17\u0e22\u0e2d\u0e32\u0e23\u0e32\u0e1a\u0e34\u0e01\u0e49\u0e32', descriptionEn: 'Thai Arabica pour-over with gentle floral and fruity notes.', price: 80, imageUrl: 'https://images.unsplash.com/photo-1497935586351-b67a49e012bf?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-coffee-2', category: 'coffee', categoryNameTh: '\u0e01\u0e32\u0e41\u0e1f', categoryNameEn: 'Coffee', nameTh: 'Eden Iced Latte', nameEn: 'Eden Iced Latte', descriptionTh: '\u0e40\u0e2d\u0e2a\u0e40\u0e1e\u0e23\u0e2a\u0e42\u0e0b\u0e48\u0e40\u0e02\u0e49\u0e21\u0e02\u0e49\u0e19 \u0e19\u0e21\u0e2a\u0e14 \u0e41\u0e25\u0e30\u0e19\u0e49\u0e33\u0e15\u0e32\u0e25\u0e21\u0e30\u0e1e\u0e23\u0e49\u0e32\u0e27', descriptionEn: 'Rich espresso, fresh milk, and a soft coconut sugar finish.', price: 95, imageUrl: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-tea-1', category: 'tea', categoryNameTh: '\u0e0a\u0e32\u0e41\u0e25\u0e30\u0e21\u0e31\u0e17\u0e09\u0e30', categoryNameEn: 'Tea & Matcha', nameTh: 'Matcha Yuzu Sparkling', nameEn: 'Matcha Yuzu Sparkling', descriptionTh: '\u0e21\u0e31\u0e17\u0e09\u0e30\u0e1e\u0e23\u0e35\u0e40\u0e21\u0e35\u0e22\u0e21 \u0e22\u0e39\u0e0b\u0e38 \u0e41\u0e25\u0e30\u0e42\u0e0b\u0e14\u0e32', descriptionEn: 'Premium matcha with yuzu and sparkling soda.', price: 110, imageUrl: 'https://images.unsplash.com/photo-1536935338788-846bb9981813?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-bakery-1', category: 'bakery', categoryNameTh: '\u0e40\u0e1a\u0e40\u0e01\u0e2d\u0e23\u0e35\u0e48', categoryNameEn: 'Bakery', nameTh: 'Homemade Butter Croissant', nameEn: 'Homemade Butter Croissant', descriptionTh: '\u0e04\u0e23\u0e31\u0e27\u0e0b\u0e2d\u0e07\u0e15\u0e4c\u0e40\u0e19\u0e22\u0e2a\u0e14 \u0e2d\u0e1a\u0e43\u0e2b\u0e21\u0e48\u0e17\u0e38\u0e01\u0e40\u0e0a\u0e49\u0e32', descriptionEn: 'Freshly baked butter croissant, crisp outside and soft inside.', price: 65, imageUrl: 'https://images.unsplash.com/photo-1549996647-190b679b33d7?auto=format&fit=crop&w=600&q=80' }
];

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

function normalizeMenuItem(item) {
    const en = isEnglishPage();
    const category = item.category || 'other';
    const categoryLabel = CATEGORY_LABELS[category] || CATEGORY_LABELS.other;
    const trackStock = parseMenuBool(item.trackStock, false);
    const stock = Number(item.stock ?? item.inStock ?? 0);
    const availableForSale = parseMenuBool(item.availableForSale, true);

    return {
        id: item.id || item.handle || item.sku || item.slug || item.name || String(Date.now()),
        handle: item.handle || item.id || '',
        sku: item.sku || '',
        category,
        categoryName: item.categoryName || (en ? item.categoryNameEn : item.categoryNameTh) || (en ? categoryLabel.en : categoryLabel.th),
        name: item.name || (en ? item.nameEn : item.nameTh) || 'Eden Menu',
        description: item.description || (en ? item.descriptionEn : item.descriptionTh) || '',
        price: Number(item.price) || 0,
        imageUrl: item.imageUrl || item.image || 'Images/Logo.webp',
        soldByWeight: parseMenuBool(item.soldByWeight, false),
        options: normalizeMenuOptions(item),
        trackStock,
        stock: Number.isFinite(stock) ? stock : 0,
        lowStock: Number(item.lowStock ?? 0) || 0,
        availableForSale,
        canSell: availableForSale && (!trackStock || stock > 0),
        taxEnabled: parseMenuBool(item.taxEnabled, true)
    };
}

function fallbackMenu() {
    return FALLBACK_MENU.map(normalizeMenuItem);
}

async function fetchMenuFromCloud() {
    if (!db) return [];
    const snap = await getDocs(query(collection(db, 'products')));
    return snap.docs
        .map(docSnap => normalizeMenuItem({ id: docSnap.id, ...docSnap.data() }))
        .filter(item => item.availableForSale);
}

function renderMenu(container, items, note = '') {
    const en = isEnglishPage();
    const fallbackMode = Boolean(note);
    const grouped = items.reduce((acc, item) => {
        if (!acc[item.category]) acc[item.category] = item.categoryName;
        return acc;
    }, {});

    const cardsHTML = items.map(item => {
        const disabled = fallbackMode || !item.canSell;
        const optionText = item.options.length ? item.options.map(option => (option.name + (option.name && option.value ? ': ' : '') + option.value)).join(' / ') : '';
        const stockText = item.trackStock ? (en ? 'Stock: ' + item.stock : '\u0e40\u0e2b\u0e25\u0e37\u0e2d ' + item.stock) : '';
        const buttonText = fallbackMode
            ? (en ? 'Unavailable' : '\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e02\u0e32\u0e22')
            : (!item.canSell ? (en ? 'Sold out' : '\u0e2b\u0e21\u0e14') : (en ? 'Add to Cart' : '\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e25\u0e07\u0e15\u0e30\u0e01\u0e23\u0e49\u0e32'));

        return '<div class="shop-card menu-card" data-category="cat-' + escapeHTML(item.category) + '">'
            + '<div class="shop-img-wrapper"><img loading="lazy" src="' + safeImageURL(item.imageUrl) + '" alt="' + escapeHTML(item.name) + '" class="shop-img"></div>'
            + '<div class="shop-details">'
            + '<span class="shop-category">' + escapeHTML(item.categoryName) + '</span>'
            + '<h3>' + escapeHTML(item.name) + '</h3>'
            + '<p>' + escapeHTML(item.description) + '</p>'
            + (optionText ? '<p style="font-size:0.85rem; color:#607466; margin-top:8px;">' + escapeHTML(optionText) + '</p>' : '')
            + (stockText ? '<p style="font-size:0.85rem; color:' + (item.canSell ? '#0f7a3d' : '#b91c1c') + '; margin-top:6px;">' + escapeHTML(stockText) + '</p>' : '')
            + '<div class="shop-action">'
            + '<span class="shop-price">&#3647;' + item.price.toLocaleString('en-US') + '</span>'
            + '<button class="btn btn-add-cart" ' + (disabled ? 'disabled style="background:#ccc;"' : '') + ' data-id="' + escapeHTML(item.id) + '" data-name="' + escapeHTML(item.name) + '" data-price="' + item.price + '">' + buttonText + '</button>'
            + '</div></div></div>';
    }).join('');

    container.innerHTML = (note ? '<div class="shop-data-note" style="background:#fff8e1; border:1px solid #f1d58a; color:#6b4f00; padding:12px 16px; border-radius:12px; margin-bottom:18px;">' + escapeHTML(note) + '</div>' : '')
        + '<div class="category-filters menu-category-filters">'
        + '<button class="filter-btn active" data-filter="all">' + (en ? 'All' : '\u0e17\u0e31\u0e49\u0e07\u0e2b\u0e21\u0e14') + '</button>'
        + Object.entries(grouped).map(([categoryId, label]) => '<button class="filter-btn" data-filter="cat-' + escapeHTML(categoryId) + '">' + escapeHTML(label) + '</button>').join('')
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
}

document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('menu-products');
    if (!container) return;

    const en = isEnglishPage();
    container.innerHTML = '<div style="text-align:center; padding:40px;">' + (en ? 'Loading menu...' : '\u0e01\u0e33\u0e25\u0e31\u0e07\u0e42\u0e2b\u0e25\u0e14\u0e40\u0e21\u0e19\u0e39...') + '</div>';

    try {
        const items = await fetchMenuFromCloud();
        if (items.length) renderMenu(container, items);
        else renderMenu(container, fallbackMenu(), en ? 'Showing sample menu while the live menu is empty.' : '\u0e41\u0e2a\u0e14\u0e07\u0e40\u0e21\u0e19\u0e39\u0e15\u0e31\u0e27\u0e2d\u0e22\u0e48\u0e32\u0e07\u0e23\u0e30\u0e2b\u0e27\u0e48\u0e32\u0e07\u0e23\u0e2d\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e08\u0e32\u0e01\u0e2b\u0e25\u0e31\u0e07\u0e1a\u0e49\u0e32\u0e19');
    } catch (error) {
        console.error('Error loading menu:', error);
        renderMenu(container, fallbackMenu(), en ? 'Could not load live menu. Showing fallback menu.' : '\u0e44\u0e21\u0e48\u0e2a\u0e32\u0e21\u0e32\u0e23\u0e16\u0e42\u0e2b\u0e25\u0e14\u0e40\u0e21\u0e19\u0e39\u0e08\u0e32\u0e01\u0e2b\u0e25\u0e31\u0e07\u0e1a\u0e49\u0e32\u0e19\u0e44\u0e14\u0e49');
    }
});
