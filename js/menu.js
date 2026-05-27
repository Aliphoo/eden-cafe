import { db } from './firebase-config.js';
import { collection, getDocs, query } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FALLBACK_MENU = [
    { id: 'm-coffee-1', category: 'coffee', categoryNameTh: 'กาแฟ', categoryNameEn: 'Coffee', nameTh: 'Drip Coffee Thai Arabica', nameEn: 'Drip Coffee Thai Arabica', descriptionTh: 'กาแฟดริปเมล็ดไทยอาราบิก้า หอมละมุน มีโทนผลไม้และดอกไม้', descriptionEn: 'Thai Arabica pour-over with gentle floral and fruity notes.', price: 80, imageUrl: 'https://images.unsplash.com/photo-1497935586351-b67a49e012bf?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-coffee-2', category: 'coffee', categoryNameTh: 'กาแฟ', categoryNameEn: 'Coffee', nameTh: 'Eden Iced Latte', nameEn: 'Eden Iced Latte', descriptionTh: 'เอสเพรสโซ่เข้มข้น นมสด และความหวานหอมจากน้ำตาลมะพร้าว', descriptionEn: 'Rich espresso, fresh milk, and a soft coconut sugar finish.', price: 95, imageUrl: 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-coffee-3', category: 'coffee', categoryNameTh: 'กาแฟ', categoryNameEn: 'Coffee', nameTh: 'Dirty Coffee', nameEn: 'Dirty Coffee', descriptionTh: 'นมเย็นเนียนนุ่ม ราดช็อตกาแฟร้อน หอมเข้มแบบคาเฟ่พรีเมียม', descriptionEn: 'Chilled milk layered with hot espresso for a velvety contrast.', price: 110, imageUrl: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-tea-1', category: 'tea', categoryNameTh: 'ชาและมัทฉะ', categoryNameEn: 'Tea & Matcha', nameTh: 'Matcha Yuzu Sparkling', nameEn: 'Matcha Yuzu Sparkling', descriptionTh: 'มัทฉะพรีเมียม ยูซุ และโซดา สดชื่นหอมละมุน', descriptionEn: 'Premium matcha with yuzu and sparkling soda.', price: 110, imageUrl: 'https://images.unsplash.com/photo-1536935338788-846bb9981813?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-tea-2', category: 'tea', categoryNameTh: 'ชาและมัทฉะ', categoryNameEn: 'Tea & Matcha', nameTh: 'Thai Tea Cream Cloud', nameEn: 'Thai Tea Cream Cloud', descriptionTh: 'ชาไทยหอมเข้ม ท็อปครีมนุ่มละมุน', descriptionEn: 'Bold Thai tea topped with a soft cream cloud.', price: 95, imageUrl: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-bakery-1', category: 'bakery', categoryNameTh: 'เบเกอรี่', categoryNameEn: 'Bakery', nameTh: 'Homemade Butter Croissant', nameEn: 'Homemade Butter Croissant', descriptionTh: 'ครัวซองต์เนยสด กรอบนอกนุ่มใน อบใหม่ทุกเช้า', descriptionEn: 'Freshly baked butter croissant, crisp outside and soft inside.', price: 65, imageUrl: 'https://images.unsplash.com/photo-1549996647-190b679b33d7?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-bakery-2', category: 'bakery', categoryNameTh: 'เบเกอรี่', categoryNameEn: 'Bakery', nameTh: 'Soft Cookie', nameEn: 'Soft Cookie', descriptionTh: 'คุกกี้เนื้อนุ่ม หอมเนย เหมาะกับกาแฟทุกแก้ว', descriptionEn: 'Soft butter cookie, a lovely match with coffee.', price: 85, imageUrl: 'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?auto=format&fit=crop&w=600&q=80' },
    { id: 'm-brunch-1', category: 'brunch', categoryNameTh: 'บรันช์', categoryNameEn: 'Brunch', nameTh: 'Garden Avocado Toast', nameEn: 'Garden Avocado Toast', descriptionTh: 'ขนมปังซาวโดว์ อะโวคาโด และผักสวนสดสไตล์ wellness cafe', descriptionEn: 'Sourdough, avocado, and fresh garden greens.', price: 160, imageUrl: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?auto=format&fit=crop&w=600&q=80' }
];

const CATEGORY_LABELS = {
    coffee: { th: 'กาแฟ', en: 'Coffee' },
    tea: { th: 'ชาและมัทฉะ', en: 'Tea & Matcha' },
    bakery: { th: 'เบเกอรี่', en: 'Bakery' },
    brunch: { th: 'บรันช์', en: 'Brunch' },
    food: { th: 'อาหาร', en: 'Food' },
    drink: { th: 'เครื่องดื่ม', en: 'Drinks' },
    signature: { th: 'เมนูแนะนำ', en: 'Signature' },
    other: { th: 'เมนู', en: 'Menu' }
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

function normalizeMenuItem(item) {
    const en = isEnglishPage();
    const category = item.category || 'other';
    const categoryLabel = CATEGORY_LABELS[category] || CATEGORY_LABELS.other;
    return {
        id: item.id || item.slug || item.name || String(Date.now()),
        category,
        categoryName: item.categoryName || (en ? item.categoryNameEn : item.categoryNameTh) || (en ? categoryLabel.en : categoryLabel.th),
        name: item.name || (en ? item.nameEn : item.nameTh) || 'Eden Menu',
        description: item.description || (en ? item.descriptionEn : item.descriptionTh) || '',
        price: Number(item.price) || 0,
        imageUrl: item.imageUrl || item.image || 'Images/Logo.webp'
    };
}

function fallbackMenu() {
    return FALLBACK_MENU.map(normalizeMenuItem);
}

async function fetchMenuFromCloud() {
    if (!db) return [];
    const snap = await getDocs(query(collection(db, 'products')));
    return snap.docs.map(docSnap => normalizeMenuItem({ id: docSnap.id, ...docSnap.data() }));
}

function renderMenu(container, items, note = '') {
    const en = isEnglishPage();
    const fallbackMode = Boolean(note);
    const grouped = items.reduce((acc, item) => {
        if (!acc[item.category]) acc[item.category] = item.categoryName;
        return acc;
    }, {});

    container.innerHTML = `
        ${note ? `<div class="shop-data-note" style="background:#fff8e1; border:1px solid #f1d58a; color:#6b4f00; padding:12px 16px; border-radius:12px; margin-bottom:18px;">${escapeHTML(note)}</div>` : ''}
        <div class="category-filters menu-category-filters">
            <button class="filter-btn active" data-filter="all">${en ? 'All' : 'ทั้งหมด'}</button>
            ${Object.entries(grouped).map(([categoryId, label]) => `<button class="filter-btn" data-filter="cat-${escapeHTML(categoryId)}">${escapeHTML(label)}</button>`).join('')}
        </div>
        <div class="shop-grid shop-grid-online menu-grid-online">
            ${items.map(item => `
                <div class="shop-card menu-card" data-category="cat-${escapeHTML(item.category)}">
                    <div class="shop-img-wrapper"><img loading="lazy" src="${safeImageURL(item.imageUrl)}" alt="${escapeHTML(item.name)}" class="shop-img"></div>
                    <div class="shop-details">
                        <span class="shop-category">${escapeHTML(item.categoryName)}</span>
                        <h3>${escapeHTML(item.name)}</h3>
                        <p>${escapeHTML(item.description)}</p>
                        <div class="shop-action">
                            <span class="shop-price">฿${item.price.toLocaleString('en-US')}</span>
                            <button class="btn btn-add-cart" ${fallbackMode ? 'disabled style="background:#ccc;"' : ''} data-id="${escapeHTML(item.id)}" data-name="${escapeHTML(item.name)}" data-price="${item.price}">${fallbackMode ? (en ? 'Unavailable' : 'ยังไม่พร้อมขาย') : (en ? 'Add to Cart' : 'เพิ่มลงตะกร้า')}</button>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;

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
    container.innerHTML = `<div style="text-align:center; padding:40px;">${en ? 'Loading menu...' : 'กำลังโหลดเมนู...'}</div>`;

    try {
        const items = await fetchMenuFromCloud();
        if (items.length) renderMenu(container, items);
        else renderMenu(container, fallbackMenu(), en ? 'Showing sample menu while the live menu is empty.' : 'แสดงเมนูตัวอย่างระหว่างรอข้อมูลจากหลังบ้าน');
    } catch (error) {
        console.error('Error loading menu:', error);
        renderMenu(container, fallbackMenu(), en ? 'Could not load live menu. Showing fallback menu.' : 'ไม่สามารถโหลดเมนูจากหลังบ้านได้ จึงแสดงเมนูสำรองไว้ก่อน');
    }
});
