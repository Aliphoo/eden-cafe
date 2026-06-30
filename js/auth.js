import './page-telemetry.js';
import './promo-popup.js?v=promo-popup-targeting-1';
// Profile dashboard asset deploy marker: profile-assets-20260621-1
import { auth, db } from './firebase-config.js';
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, setDoc, getDoc, serverTimestamp, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FUNCTIONS_BASE_URL = 'https://asia-southeast1-edencafe-d9095.cloudfunctions.net';
const ADMIN_EMAILS = ['admin@edencafe.com', 'phoo1236@gmail.com', 'sonsawan.1231@gmail.com'];
const PHONE_AUTH_EMAIL_DOMAIN = 'phone.edencafe.co';
const RESET_AUTH_SUPPRESS_KEY = 'eden_password_reset_auth_suppressed_until';

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCurrentUser(timeoutMs = 6000) {
    const startedAt = Date.now();
    let user = auth?.currentUser || null;
    while (!user && Date.now() - startedAt < timeoutMs) {
        await wait(100);
        user = auth?.currentUser || null;
    }
    return user;
}

async function getAuthHeaders({ json = false, requireAuth = false } = {}) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    const user = requireAuth ? await waitForCurrentUser() : auth?.currentUser;
    if (user && typeof user.getIdToken === 'function') {
        headers.Authorization = 'Bearer ' + await user.getIdToken();
    } else if (requireAuth) {
        const error = new Error('Authentication is required');
        error.status = 401;
        throw error;
    }
    return headers;
}

async function edenApiRequest(path, { method = 'GET', query: queryParams = {}, body = null, authenticated = false } = {}) {
    const url = new URL(FUNCTIONS_BASE_URL + path);
    Object.entries(queryParams || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });

    const response = await fetch(url.toString(), {
        method,
        headers: await getAuthHeaders({ json: !!body, requireAuth: authenticated }),
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
        error.code = data.code || data.error || '';
        error.details = data.details || null;
        error.reason = data.details?.reason || data.reason || '';
        error.quote = data.details?.quote || data.quote || null;
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
    },
    getArcheryAvailability(params = {}) {
        return edenApiRequest('/getArcheryAvailability', { method: 'POST', body: params });
    },
    createArcheryHold(bookingData) {
        return edenApiRequest('/createArcheryHold', { method: 'POST', body: bookingData });
    },
    createBeamArcheryPayment(paymentData) {
        return edenApiRequest('/createBeamArcheryPayment', { method: 'POST', body: paymentData });
    },
    getArcheryPaymentStatus(params = {}) {
        return edenApiRequest('/getArcheryPaymentStatus', { method: 'POST', body: params });
    },
    quoteLoyaltyRedemption(params = {}) {
        return edenApiRequest('/quoteLoyaltyRedemption', { method: 'POST', body: params, authenticated: true });
    },
    reserveArcheryLoyaltyRedemption(params = {}) {
        return edenApiRequest('/reserveArcheryLoyaltyRedemption', { method: 'POST', body: params, authenticated: true });
    },
    validatePromotion(promoData) {
        return edenApiRequest('/validatePromotion', { method: 'POST', body: promoData, authenticated: true });
    },
    createShopOrderDraft(orderData) {
        return edenApiRequest('/createShopOrderDraft', { method: 'POST', body: orderData, authenticated: true });
    },
    createPaymentIntent(paymentData) {
        return edenApiRequest('/createPaymentIntent', { method: 'POST', body: paymentData, authenticated: true });
    },
    getPaymentStatus(params = {}) {
        return edenApiRequest('/getPaymentStatus', { method: 'POST', body: params, authenticated: true });
    },
    cancelPendingPayment(paymentData) {
        return edenApiRequest('/cancelPendingPayment', { method: 'POST', body: paymentData, authenticated: true });
    },
    getMyProfile() {
        return edenApiRequest('/getMyProfile', { method: 'POST', authenticated: true });
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

function isInternalPhoneEmail(email) {
    return String(email || '').toLowerCase().endsWith('@' + PHONE_AUTH_EMAIL_DOMAIN);
}

function isPasswordResetAuthSuppressed() {
    try {
        const until = Number(sessionStorage.getItem(RESET_AUTH_SUPPRESS_KEY) || 0);
        if (!until) return false;
        if (until < Date.now()) {
            sessionStorage.removeItem(RESET_AUTH_SUPPRESS_KEY);
            return false;
        }
        return true;
    } catch (_) {
        return false;
    }
}

function publicEmail(user, fallback = '') {
    return isInternalPhoneEmail(user?.email) ? fallback : (user?.email || fallback || '');
}

function phoneDisplay(phoneE164) {
    const phone = String(phoneE164 || '');
    return phone.startsWith('+66') ? '0' + phone.slice(3) : phone;
}

async function syncAuthUserProfile(user) {
    if (!user || !db) return;
    try {
        const displayName = user.displayName || (user.phoneNumber ? 'Eden Member ' + String(user.phoneNumber).slice(-4) : 'Eden Member');
        const payload = {
            uid: user.uid,
            displayName,
            photoURL: user.photoURL || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(displayName) + '&background=1A9345&color=fff',
            authProviderIds: (user.providerData || []).map(profile => profile.providerId).filter(Boolean),
            updatedAt: serverTimestamp()
        };
        const visibleEmail = publicEmail(user);
        if (visibleEmail) payload.email = visibleEmail;
        if (user.phoneNumber) payload.phone = user.phoneNumber;
        await setDoc(doc(db, 'users', user.uid), payload, { merge: true });
    } catch (error) {
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

async function maybeRedirectToPhoneOnboarding(user, access) {
    return;
    if (!user?.phoneNumber || !db || isBackOfficeAccess(access)) return;
    if (window.location.pathname.includes('/register')) return;
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        const profile = snap.exists() ? snap.data() : {};
        if (profile.profileCompleted === true) return;
        const current = window.location.pathname + window.location.search + window.location.hash;
        window.location.href = '/register?next=' + encodeURIComponent(current || '/profile');
    } catch (error) {
    }
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
        container.innerHTML = '<p style="text-align:center; width:100%; color:red;">ไม่สามารถโหลดเมนูได้ กรุณาลองใหม่</p>';
    }
}

async function loadFaqs() {
    const container = document.getElementById('faq-container');
    if (!container || !db) return;
    if (container.dataset.faqPage || container.dataset.faqManaged === 'true' || window.EdenFAQ) return;

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
        container.innerHTML = '<p style="text-align:center; width:100%; color:red;">ไม่สามารถโหลดข้อมูลได้ กรุณาลองใหม่</p>';
    }
}

function ensureLoginModal() {
    return;
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
                <button class="phone-login-btn" onclick="startPhoneLogin()">
                    ${isEnglishPage() ? 'Continue with phone number' : 'เข้าสู่ระบบด้วยเบอร์โทรศัพท์'}
                </button>
                <p class="phone-login-note">${isEnglishPage() ? 'OTP verification is required. First-time users must enter first name, last name, and set a password.' : 'ยืนยัน OTP ก่อนใช้งาน ครั้งแรกต้องกรอกชื่อจริง นามสกุล และตั้งรหัสผ่าน'}</p>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function openLoginModal() {
    const current = window.location.pathname + window.location.search + window.location.hash;
    const next = current && !current.includes('/login') ? '?next=' + encodeURIComponent(current) : '';
    window.location.href = '/login' + next;
}

function closeLoginModal() {
    const modal = document.getElementById('login-modal');
    if (modal) modal.style.display = 'none';
}

function startPhoneLogin() {
    window.location.href = '/register';
}

async function logout() {
    if (auth) {
        try {
            await signOut(auth);
        } catch (error) {
        }
    } else {
        localStorage.removeItem('eden_user');
    }

    checkLoginStatus();
    if (window.location.pathname.includes('profile')) window.location.href = '/login';
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
            const mobileLoginText = 'Login';
            container.innerHTML = `<a class="btn btn-outline auth-login-link" aria-label="${loginText}" href="/login"><span class="auth-login-text auth-login-text-desktop">${loginText}</span><span class="auth-login-text auth-login-text-mobile" aria-hidden="true">${mobileLoginText}</span></a>`;
            return;
        }

        const profileUrl = isEn ? '/profile-en' : '/profile';
        const profileText = isEn ? 'Profile' : 'ข้อมูลส่วนตัว / Profile';
        const logoutText = isEn ? 'Logout' : 'ออกจากระบบ / Logout';
        const isAdmin = user.isAdmin === true && ['owner', 'head_manager', 'manager'].includes(user.adminRole);
        const adminLabel = isEn ? 'Admin Dashboard' : 'จัดการหลังบ้าน (Admin)';
        const adminLink = isAdmin ? `<a href="/admin" target="_blank" style="color:var(--accent-color); font-weight:500;">${adminLabel}</a>` : '';

        container.innerHTML = `
            <div class="user-profile-menu">
                <img loading="lazy" src="${sanitizeURL(user.avatar)}" alt="Profile" class="user-avatar" onclick="toggleDropdown(this)">
                <div class="profile-dropdown">
                    <div style="padding:10px; border-bottom:1px solid #eee;">
                        <strong>${escapeHTML(user.name || 'Eden Member')}</strong><br>
                        <small style="color:#666;">${escapeHTML(user.phone || user.phoneNumber || user.email || '')}</small>
                    </div>
                    ${adminLink}
                    <a href="${profileUrl}">${profileText}</a>
                    <a class="profile-dropdown-logout" href="#" onclick="logout(); return false;">${logoutText}</a>
                </div>
            </div>
        `;
    });
}

function clearStoredAuthUser(reason = '') {
    localStorage.removeItem('eden_user');
    checkLoginStatus();
    window.dispatchEvent(new CustomEvent('eden:user-changed', { detail: { reason } }));
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

async function saveBookingToCloud(bookingData) {
    try {
        const result = await window.EdenApi.createBooking(bookingData);
        return result.id;
    } catch (error) {
        throw error;
    }
}

async function fetchTableAvailability({ date, time }) {
    if (!date || !time) return [];
    try {
        return await window.EdenApi.tableAvailability({ date, time });
    } catch (_) {
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
        return [];
    }
}

async function fetchTablesFromCloud() {
    if (!db) return [];

    try {
        const snap = await getDocs(query(collection(db, 'tables')));
        return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    } catch (error) {
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
            if (user && isPasswordResetAuthSuppressed()) {
                clearStoredAuthUser('password-reset');
                return;
            }

            if (user) {
                syncAuthUserProfile(user);
                const storedUser = getStoredUser() || {};
                const authName = user.displayName || storedUser.name || (user.phoneNumber ? 'Eden Member ' + String(user.phoneNumber).slice(-4) : 'Eden Member');
                const authAvatar = user.photoURL || storedUser.avatar || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(authName) + '&background=4caf50&color=fff';
                const baseStoredUser = {
                    ...storedUser,
                    uid: user.uid,
                    name: authName,
                    email: publicEmail(user, storedUser.email || ''),
                    avatar: authAvatar,
                    phone: phoneDisplay(user.phoneNumber) || storedUser.phone || '',
                    phoneNumber: user.phoneNumber || storedUser.phoneNumber || ''
                };
                getUserAdminAccess(user).then(access => {
                    if (isPasswordResetAuthSuppressed() || auth?.currentUser?.uid !== user.uid) return;
                    const isBackOffice = isBackOfficeAccess(access);
                    localStorage.setItem('eden_user', JSON.stringify({
                        ...baseStoredUser,
                        isAdmin: isBackOffice,
                        adminRole: access?.role || '',
                        canUsePos: canUsePosAccess(access),
                        canOrderMenu: access?.status === 'active' && access?.role === 'staff' && access?.permissions?.menuOrder === true
                    }));
                    checkLoginStatus();
                    maybeRedirectToPhoneOnboarding(user, access);
                });
                const bootstrapAccess = ADMIN_EMAILS.includes(String(user.email || '').toLowerCase())
                    ? { role: 'owner', status: 'active', permissions: { pos: true } }
                    : null;
                localStorage.setItem('eden_user', JSON.stringify({
                    ...baseStoredUser,
                    isAdmin: !!bootstrapAccess,
                    adminRole: bootstrapAccess?.role || '',
                    canUsePos: canUsePosAccess(bootstrapAccess)
                }));
            } else {
                clearStoredAuthUser('signed-out');
                return;
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
window.startPhoneLogin = startPhoneLogin;
window.logout = logout;
window.toggleDropdown = toggleDropdown;
window.clearEdenStoredUser = clearStoredAuthUser;
window.updateGlobalCartBadge = updateGlobalCartBadge;
window.saveBookingToCloud = saveBookingToCloud;
window.fetchRoomsFromCloud = fetchRoomsFromCloud;
window.fetchTablesFromCloud = fetchTablesFromCloud;
window.fetchTableAvailability = fetchTableAvailability;
window.fetchUserOrdersFromCloud = fetchUserOrdersFromCloud;
window.fetchUserBookingsFromCloud = fetchUserBookingsFromCloud;
