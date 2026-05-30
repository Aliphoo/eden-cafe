import { auth, provider, db } from './firebase-config.js';
import { signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, addDoc, doc, setDoc, getDoc, serverTimestamp, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FUNCTIONS_BASE_URL = 'https://asia-southeast1-edencafe-d9095.cloudfunctions.net';
const ADMIN_EMAILS = ['admin@edencafe.com', 'phoo1236@gmail.com', 'sonsawan.1231@gmail.com'];

async function getAuthHeaders({ json = false } = {}) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    const user = auth?.currentUser;
    if (user && typeof user.getIdToken === 'function') {
        headers.Authorization = 'Bearer ' + await user.getIdToken();
    }
    return headers;
}

async function edenApiRequest(path, { method = 'GET', query: queryParams = {}, body = null } = {}) {
    const url = new URL(FUNCTIONS_BASE_URL + path);
    Object.entries(queryParams || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });

    const response = await fetch(url.toString(), {
        method,
        headers: await getAuthHeaders({ json: !!body }),
        body: body ? JSON.stringify(body) : undefined
    });

    let data = {};
    try {
        data = await response.json();
    } catch (_) {
        data = {};
    }

    if (!response.ok) {
        const error = new Error(data.error || 'Eden API request failed');
        error.status = response.status;
        error.conflictIds = Array.isArray(data.conflictIds) ? data.conflictIds : [];
        throw error;
    }

    return data;
}

window.EdenApi = {
    ...(window.EdenApi || {}),
    createBooking(bookingData) {
        return edenApiRequest('/createBooking', { method: 'POST', body: bookingData });
    },
    tableAvailability({ date, time }) {
        return edenApiRequest('/getTableAvailability', { query: { date, time } });
    }
};

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeURL(value) {
    const url = String(value ?? '').trim();
    return /^https?:\/\//i.test(url) || url.startsWith('Images/') || url.startsWith('Hero/') ? url : '';
}

function escapeJSString(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

function isEnglishPage() {
    return window.location.pathname.includes('-en') || window.location.pathname.endsWith('/en') || window.location.pathname.endsWith('/en');
}

async function syncAuthUserProfile(user) {
    if (!user || !db) return;
    try {
        await setDoc(doc(db, 'users', user.uid), {
            uid: user.uid,
            displayName: user.displayName || 'Eden Member',
            email: user.email || '',
            photoURL: user.photoURL || '',
            updatedAt: serverTimestamp()
        }, { merge: true });
    } catch (error) {
        console.warn('Unable to sync member profile:', error);
    }
}

async function getUserAdminAccess(user) {
    if (!user || !db) return null;
    const email = String(user.email || '').toLowerCase();
    if (ADMIN_EMAILS.includes(email)) return { role: 'owner', status: 'active', permissions: { pos: true } };

    try {
        const snap = await getDoc(doc(db, 'admin_users', user.uid));
        if (!snap.exists()) return null;
        const access = snap.data();
        return access.status === 'active' ? access : null;
    } catch (error) {
        console.warn('Unable to read admin access:', error);
        return null;
    }
}

function adminAccessAllowsPermission(access, permission) {
    if (!access || access.status !== 'active') return false;
    if (access.role === 'owner' || access.role === 'head_manager') return true;
    if (access.role !== 'manager') return false;
    return access.permissions?.[permission] === true;
}

function isBackOfficeAccess(access) {
    return !!access
        && access.status === 'active'
        && ['owner', 'head_manager', 'manager'].includes(access.role);
}

function canUsePosAccess(access) {
    return isBackOfficeAccess(access) && adminAccessAllowsPermission(access, 'pos');
}

async function loadProducts() {
    const container = document.getElementById('product-container');
    if (!container || !db) return;

    try {
        const q = query(collection(db, 'products'), where('isSignature', '==', true));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = '<p style="text-align:center; width:100%;">ไม่มีเมนูแนะนำในขณะนี้</p>';
            return;
        }

        container.innerHTML = '';
        snap.forEach(docSnap => {
            const product = docSnap.data();
            const price = Number(product.price) || 0;
            const name = product.name || 'Eden Menu';
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `
                <img loading="lazy" src="${sanitizeURL(product.imageUrl)}" alt="${escapeHTML(name)}" class="card-img">
                <h3>${escapeHTML(name)}</h3>
                <p>${escapeHTML(product.description)}</p>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px;">
                    <span style="font-weight:600; color:var(--primary-color);">฿${price}</span>
                    <button class="btn" style="padding:5px 15px; font-size:0.9rem;" onclick="addToCart('${escapeJSString(name)}', ${price})">สั่งซื้อ</button>
                </div>
            `;
            container.appendChild(card);
        });
    } catch (error) {
        console.error('Failed to load products:', error);
        container.innerHTML = '<p style="text-align:center; width:100%; color:red;">ไม่สามารถโหลดเมนูได้ กรุณาลองใหม่</p>';
    }
}

async function loadFaqs() {
    const container = document.getElementById('faq-container');
    if (!container || !db) return;

    try {
        const q = query(collection(db, 'faqs'), orderBy('order', 'asc'));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = '<p style="text-align:center; width:100%;">ไม่มีคำถามที่พบบ่อยในขณะนี้</p>';
            return;
        }

        container.innerHTML = '';
        snap.forEach(docSnap => {
            const faq = docSnap.data();
            const item = document.createElement('div');
            item.className = 'faq-item';
            item.innerHTML = `
                <h3>${escapeHTML(faq.question)}</h3>
                <p>${escapeHTML(faq.answer)}</p>
            `;
            container.appendChild(item);
        });
    } catch (error) {
        console.error('Failed to load FAQs:', error);
        container.innerHTML = '<p style="text-align:center; width:100%; color:red;">ไม่สามารถโหลดข้อมูลได้ กรุณาลองใหม่</p>';
    }
}

function ensureLoginModal() {
    if (document.getElementById('login-modal')) return;

    const modalHTML = `
        <div id="login-modal" class="login-modal">
            <div class="login-modal-content">
                <span class="login-close" onclick="closeLoginModal()">&times;</span>
                <div style="text-align:center; margin-bottom:20px;">
                    <img src="Images/Logo.webp" alt="Eden Cafe Logo" style="height:60px;">
                    <h2 style="margin-top:15px;">${isEnglishPage() ? 'Sign In' : 'เข้าสู่ระบบ / Sign In'}</h2>
                    <p style="color:#666; font-size:0.9rem;">${isEnglishPage() ? 'Please sign in to continue.' : 'กรุณาเข้าสู่ระบบเพื่อดำเนินการต่อ'}</p>
                </div>
                <button class="google-login-btn" onclick="mockGoogleLogin()">
                    <svg width="18" height="18" viewBox="0 0 24 24" style="margin-right:10px;">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    Sign in with Google
                </button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function openLoginModal() {
    ensureLoginModal();
    const modal = document.getElementById('login-modal');
    if (modal) modal.style.display = 'flex';
}

function closeLoginModal() {
    const modal = document.getElementById('login-modal');
    if (modal) modal.style.display = 'none';
}

async function mockGoogleLogin() {
    if (auth && provider) {
        try {
            await signInWithPopup(auth, provider);
            closeLoginModal();
            if (window.location.pathname.includes('checkout') || window.location.pathname.includes('profile')) location.reload();
        } catch (error) {
            console.error('Login error:', error);
            alert('Error: ' + error.message);
        }
        return;
    }

    const mockUser = {
        uid: 'user_' + Math.random().toString(36).slice(2, 11),
        name: 'Eden Member',
        email: 'member@example.com',
        avatar: 'https://ui-avatars.com/api/?name=Eden+Member&background=4caf50&color=fff',
        phone: '080-123-4567',
        address: '123 Sukhumvit Road, Bangkok 10110'
    };
    localStorage.setItem('eden_user', JSON.stringify(mockUser));
    closeLoginModal();
    checkLoginStatus();
    if (window.location.pathname.includes('checkout') || window.location.pathname.includes('profile')) location.reload();
}

async function logout() {
    if (auth) {
        try {
            await signOut(auth);
        } catch (error) {
            console.error('Logout error:', error);
        }
    } else {
        localStorage.removeItem('eden_user');
    }

    checkLoginStatus();
    if (window.location.pathname.includes('profile')) window.location.href = '/';
    else if (window.location.pathname.includes('checkout')) location.reload();
}

function getStoredUser() {
    try {
        return JSON.parse(localStorage.getItem('eden_user') || 'null');
    } catch {
        localStorage.removeItem('eden_user');
        return null;
    }
}

function checkLoginStatus() {
    if (typeof window.renderProfile === 'function') window.renderProfile();

    const user = getStoredUser();
    const authContainers = document.querySelectorAll('.auth-container');
    const isEn = isEnglishPage();

    authContainers.forEach(container => {
        if (!user) {
            const loginText = isEn ? 'Sign In' : 'เข้าสู่ระบบ';
            container.innerHTML = `<button class="btn btn-outline" style="padding:5px 15px; font-size:0.9rem;" onclick="openLoginModal()">${loginText}</button>`;
            return;
        }

        const profileUrl = isEn ? '/profile-en' : '/profile';
        const profileText = isEn ? 'Profile' : 'ข้อมูลส่วนตัว / Profile';
        const logoutText = isEn ? 'Logout' : 'ออกจากระบบ / Logout';
        const isAdmin = user.isAdmin === true && ['owner', 'head_manager', 'manager'].includes(user.adminRole);
        const canUsePos = isAdmin && user.canUsePos === true;
        const adminLabel = isEn ? 'Admin Dashboard' : 'จัดการหลังบ้าน (Admin)';
        const posLabel = isEn ? 'Counter POS' : 'POS หน้าร้าน';
        const adminLink = isAdmin ? `<a href="/admin" target="_blank" style="color:var(--accent-color); font-weight:500;">${adminLabel}</a>` : '';
        const posLink = canUsePos ? `<a href="/pos?view=sales" target="_blank" class="profile-pos-link">${posLabel}</a>` : '';

        container.innerHTML = `
            <div class="user-profile-menu">
                <img loading="lazy" src="${sanitizeURL(user.avatar)}" alt="Profile" class="user-avatar" onclick="toggleDropdown(this)">
                <div class="profile-dropdown">
                    <div style="padding:10px; border-bottom:1px solid #eee;">
                        <strong>${escapeHTML(user.name || 'Eden Member')}</strong><br>
                        <small style="color:#666;">${escapeHTML(user.email || '')}</small>
                    </div>
                    ${adminLink}
                    ${posLink}
                    <a href="${profileUrl}">${profileText}</a>
                    <a href="#" onclick="logout(); return false;">${logoutText}</a>
                </div>
            </div>
        `;
    });
}

function toggleDropdown(imgElement) {
    const menu = imgElement?.nextElementSibling;
    if (menu) menu.classList.toggle('show');
}

function updateGlobalCartBadge() {
    let cart = [];
    try {
        cart = JSON.parse(localStorage.getItem('eden_cart') || '[]');
    } catch {
        cart = [];
    }

    const badge = document.getElementById('global-cart-badge');
    if (!badge) return;

    const totalItems = cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    badge.style.display = totalItems > 0 ? 'flex' : 'none';
    badge.textContent = String(totalItems);
}

async function saveOrderToCloud(orderData) {
    if (!db) {
        console.warn('DB not initialized. Mock order success.');
        return 'mock_order_id';
    }

    try {
        const docRef = await addDoc(collection(db, 'orders'), {
            ...orderData,
            timestamp: serverTimestamp()
        });
        console.log('Order saved with ID:', docRef.id);
        return docRef.id;
    } catch (error) {
        console.error('Error adding order:', error);
        throw error;
    }
}

async function saveBookingToCloud(bookingData) {
    try {
        const result = await window.EdenApi.createBooking(bookingData);
        console.log('Booking saved with ID:', result.id);
        return result.id;
    } catch (error) {
        console.error('Error adding booking:', error);
        throw error;
    }
}

async function fetchTableAvailability({ date, time }) {
    if (!date || !time) return [];
    try {
        return await window.EdenApi.tableAvailability({ date, time });
    } catch (error) {
        console.warn('Table availability unavailable:', error);
        return [];
    }
}

function sortByTimestampDesc(items) {
    return items.sort((a, b) => {
        const at = a.timestamp?.toDate ? a.timestamp.toDate().getTime() : new Date(a.date || a.createdAt || 0).getTime();
        const bt = b.timestamp?.toDate ? b.timestamp.toDate().getTime() : new Date(b.date || b.createdAt || 0).getTime();
        return (bt || 0) - (at || 0);
    });
}

async function fetchUserOrdersFromCloud(uid) {
    if (!db || !uid) return [];
    const snap = await getDocs(query(collection(db, 'orders'), where('uid', '==', uid)));
    return sortByTimestampDesc(snap.docs.map(docSnap => ({ id: docSnap.data().id || docSnap.id, ...docSnap.data() }))).slice(0, 10);
}

async function fetchUserBookingsFromCloud(uid) {
    if (!db || !uid) return [];
    const snap = await getDocs(query(collection(db, 'bookings'), where('uid', '==', uid)));
    return sortByTimestampDesc(snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))).slice(0, 10);
}

async function fetchRoomsFromCloud() {
    if (!db) return [];

    try {
        const snap = await getDocs(query(collection(db, 'rooms')));
        return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    } catch (error) {
        console.error('Error fetching rooms:', error);
        return [];
    }
}

async function fetchTablesFromCloud() {
    if (!db) return [];

    try {
        const snap = await getDocs(query(collection(db, 'tables')));
        return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    } catch (error) {
        console.error('Error fetching tables:', error);
        return [];
    }
}

document.addEventListener('DOMContentLoaded', () => {
    ensureLoginModal();
    loadProducts();
    loadFaqs();
    updateGlobalCartBadge();

    if (auth) {
        onAuthStateChanged(auth, user => {
            if (user) {
                syncAuthUserProfile(user);
                getUserAdminAccess(user).then(access => {
                    const storedUser = getStoredUser() || {};
                    const isBackOffice = isBackOfficeAccess(access);
                    localStorage.setItem('eden_user', JSON.stringify({
                        ...storedUser,
                        isAdmin: isBackOffice,
                        adminRole: access?.role || '',
                        canUsePos: canUsePosAccess(access),
                        canOrderMenu: access?.status === 'active' && access?.role === 'staff' && access?.permissions?.menuOrder === true
                    }));
                    checkLoginStatus();
                });
                const bootstrapAccess = ADMIN_EMAILS.includes(String(user.email || '').toLowerCase())
                    ? { role: 'owner', status: 'active', permissions: { pos: true } }
                    : null;
                localStorage.setItem('eden_user', JSON.stringify({
                    uid: user.uid,
                    name: user.displayName || 'Eden Member',
                    email: user.email,
                    avatar: user.photoURL || 'https://ui-avatars.com/api/?name=Eden+Member&background=4caf50&color=fff',
                    isAdmin: !!bootstrapAccess,
                    adminRole: bootstrapAccess?.role || '',
                    canUsePos: canUsePosAccess(bootstrapAccess)
                }));
            } else {
                localStorage.removeItem('eden_user');
            }
            checkLoginStatus();
            window.dispatchEvent(new CustomEvent('eden:user-changed'));
        });
    } else {
        checkLoginStatus();
    }
});

window.addEventListener('click', event => {
    if (!event.target.matches('.user-avatar')) {
        document.querySelectorAll('.profile-dropdown').forEach(dropdown => dropdown.classList.remove('show'));
    }
    const modal = document.getElementById('login-modal');
    if (event.target === modal) closeLoginModal();
});

window.openLoginModal = openLoginModal;
window.closeLoginModal = closeLoginModal;
window.mockGoogleLogin = mockGoogleLogin;
window.logout = logout;
window.toggleDropdown = toggleDropdown;
window.updateGlobalCartBadge = updateGlobalCartBadge;
window.saveOrderToCloud = saveOrderToCloud;
window.saveBookingToCloud = saveBookingToCloud;
window.fetchRoomsFromCloud = fetchRoomsFromCloud;
window.fetchTablesFromCloud = fetchTablesFromCloud;
window.fetchTableAvailability = fetchTableAvailability;
window.fetchUserOrdersFromCloud = fetchUserOrdersFromCloud;
window.fetchUserBookingsFromCloud = fetchUserBookingsFromCloud;
