import { auth, provider, db } from './firebase-config.js';
import { getMemberTier, getTierBenefits } from './membership.js';
import { signInWithPopup, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs, doc, setDoc, addDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot, getDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
    return /^https?:\/\//i.test(url) ? url : fallback;
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


const ADMIN_EMAILS = ['admin@edencafe.com', 'phoo1236@gmail.com', 'sonsawan.1231@gmail.com'];
const FUNCTIONS_BASE_URL = 'https://asia-southeast1-edencafe-d9095.cloudfunctions.net';
const ADMIN_COLLECTION = 'admin_users';
const ADMIN_PERMISSION_LABELS = {
    dashboard: 'ภาพรวมระบบ',
    members: 'จัดการสมาชิก',
    orders: 'ออเดอร์สินค้า',
    bookings: 'คิวจองโต๊ะ/ห้อง',
    tables: 'จัดการโต๊ะ/โซน',
    rooms: 'จัดการห้องรับรอง',
    products: 'เมนูและหมวดหมู่',
    shop: 'สินค้าออนไลน์',
    blogs: 'บทความ',
    faqs: 'FAQ'
};
const ADMIN_ROLE_LABELS = {
    owner: 'Owner',
    head_manager: 'Head Manager',
    manager: 'Manager'
};
const ADMIN_ROLE_DEFAULT_PERMISSIONS = {
    owner: Object.fromEntries(Object.keys(ADMIN_PERMISSION_LABELS).map(key => [key, true])),
    head_manager: Object.fromEntries(Object.keys(ADMIN_PERMISSION_LABELS).map(key => [key, true])),
    manager: {
        dashboard: true,
        members: false,
        orders: true,
        bookings: true,
        tables: false,
        rooms: false,
        products: false,
        shop: false,
        blogs: false,
        faqs: false
    }
};
const ADMIN_TAB_PERMISSIONS = {
    dashboard: 'dashboard',
    members: 'members',
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
    faqs: 'faqs'
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

    const role = ADMIN_ROLE_LABELS[data.role] ? data.role : 'manager';
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
let categoriesData = {};
let shopProductsData = {};
let shopCategoriesData = {};
let roomsData = {};
let tablesData = {};
let membersData = {};
let membersUnsubscribe = null;
let memberFiltersBound = false;

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
            await signInWithPopup(auth, provider);
        } catch (error) {
            console.error('Google login failed:', error);
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
    if (canAdmin('dashboard')) fetchStats();
    if (canAdmin('orders')) setupRealtimeOrders();
    if (canAdmin('bookings')) setupRealtimeBookings();
    if (canAdmin('products')) {
        setupRealtimeCategories();
        setupRealtimeProducts();
    }
    if (canAdmin('tables')) setupRealtimeTables();
    if (canAdmin('rooms')) setupRealtimeRooms();
    if (canAdmin('shop')) {
        setupRealtimeShopCategories();
        setupRealtimeShopProducts();
    }
    if (canAdmin('members')) setupRealtimeMembers();
    if (isOwnerAccess()) setupRealtimeAdminAccess();
    if (canAdmin('products') || canAdmin('shop')) migrateProducts();
}

function applyAdminAccessUI() {
    document.querySelectorAll('.sidebar-menu li').forEach(li => {
        const match = String(li.getAttribute('onclick') || '').match(/switchTab\('([^']+)'/);
        const tabId = match ? match[1] : '';
        const allowed = !tabId || window.canAccessAdminTab(tabId);
        li.style.display = allowed ? '' : 'none';
        li.classList.toggle('access-disabled', !allowed);
    });

    document.querySelectorAll('.content-section').forEach(section => {
        const allowed = window.canAccessAdminTab(section.id);
        section.dataset.accessAllowed = allowed ? 'true' : 'false';
    });

    const active = document.querySelector('.content-section.active');
    if (active && window.canAccessAdminTab(active.id)) return;

    const firstAllowedMenu = Array.from(document.querySelectorAll('.sidebar-menu li'))
        .find(li => li.style.display !== 'none');
    if (firstAllowedMenu) {
        const match = String(firstAllowedMenu.getAttribute('onclick') || '').match(/switchTab\('([^']+)'/);
        if (match) window.switchTab(match[1], firstAllowedMenu);
    }
}

// Fetch Stats for Dashboard
async function fetchStats() {
    try {
        const statsRef = doc(db, 'stats', 'pageViews');
        const snap = await getDoc(statsRef);
        if (snap.exists()) {
            const data = snap.data();
            document.getElementById('stat-views-daily').innerText = (data.dailyViews || 0).toLocaleString();
        }
        
        // Mock Chart Data for 7 days
        const ctx = document.getElementById('viewsChart').getContext('2d');
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [{
                    label: 'ยอดผู้เข้าชม (Views)',
                    data: [120, 150, 180, 142, 200, 250, snap.exists() ? snap.data().dailyViews : 142],
                    borderColor: '#4caf50',
                    backgroundColor: 'rgba(76, 175, 80, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true } }
            }
        });
    } catch (e) {
        console.error("Error fetching stats:", e);
    }
}

// Format Date Helper
function formatDate(timestamp) {
    if (!timestamp) return '-';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

// Real-time Orders Listener
function setupRealtimeOrders() {
    const q = query(collection(db, "orders"), orderBy("timestamp", "desc"));
    onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('orders-table-body');
        tbody.innerHTML = '';
        
        let todayOrders = 0;
        let todayRevenue = 0;
        const todayStr = new Date().toLocaleDateString('th-TH');

        if (snapshot.empty) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">ไม่มีข้อมูลออเดอร์</td></tr>';
            return;
        }

        snapshot.forEach((docSnap) => {
            const order = docSnap.data();
            const id = docSnap.id;
            const status = order.status || 'pending';
            const orderDateStr = order.timestamp ? (order.timestamp.toDate ? order.timestamp.toDate().toLocaleDateString('th-TH') : new Date(order.timestamp).toLocaleDateString('th-TH')) : '';
            
            if (orderDateStr === todayStr) {
                todayOrders++;
                todayRevenue += (order.totalAmount || 0);
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-family: monospace;">${escapeHTML(id.substring(0,8).toUpperCase())}</td>
                <td>${escapeHTML(order.customerName || 'Customer')}<br><small style="color:#888;">${escapeHTML(order.phone || '')}</small></td>
                <td style="font-weight: 500;">฿${safeNumber(order.totalAmount || order.total).toLocaleString()}</td>
                <td>${formatDate(order.timestamp)}</td>
                <td>${getStatusBadgeHTML(status, 'order')}</td>
                <td>
                    <select onchange="updateOrderStatus('${escapeJSString(id)}', this.value)" style="padding: 5px; border-radius: 5px; border: 1px solid #ddd;">
                        <option value="pending" ${status === 'pending' ? 'selected' : ''}>รอดำเนินการ</option>
                        <option value="processing" ${status === 'processing' ? 'selected' : ''}>กำลังทำ</option>
                        <option value="completed" ${status === 'completed' ? 'selected' : ''}>เสร็จสิ้น</option>
                        <option value="cancelled" ${status === 'cancelled' ? 'selected' : ''}>ยกเลิก</option>
                    </select>
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Update Dashboard Stats
        document.getElementById('stat-orders').innerText = todayOrders;
        document.getElementById('stat-revenue').innerText = '฿' + todayRevenue.toLocaleString();
    }, (error) => {
        console.error("Error listening to orders:", error);
        document.getElementById('orders-table-body').innerHTML = '<tr><td colspan="6" style="text-align:center; color:red;">ไม่มีสิทธิ์เข้าถึงข้อมูล หรือเกิดข้อผิดพลาด</td></tr>';
    });
}

// Real-time Bookings Listener
function setupRealtimeBookings() {
    const q = query(collection(db, "bookings"), orderBy("timestamp", "desc"));
    onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('bookings-table-body');
        const roomTbody = document.getElementById('room-bookings-table-body');
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
        document.getElementById('bookings-table-body').innerHTML = '<tr><td colspan="7" style="text-align:center; color:red;">ไม่มีสิทธิ์เข้าถึงข้อมูล หรือเกิดข้อผิดพลาด</td></tr>';
        document.getElementById('room-bookings-table-body').innerHTML = '<tr><td colspan="8" style="text-align:center; color:red;">ไม่มีสิทธิ์เข้าถึงข้อมูล หรือเกิดข้อผิดพลาด</td></tr>';
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

// Real-time Categories Listener
function setupRealtimeCategories() {
    const q = query(collection(db, "categories"));
    onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('categories-table-body');
        const select = document.getElementById('productCategory');
        tbody.innerHTML = '';
        select.innerHTML = '<option value="">-- เลือกหมวดหมู่ --</option>';
        categoriesData = {};
        
        if (snapshot.empty) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">ไม่มีข้อมูลหมวดหมู่</td></tr>';
            return;
        }

        snapshot.forEach((docSnap) => {
            const cat = docSnap.data();
            const id = docSnap.id;
            categoriesData[id] = cat;
            
            // Populate Table
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code>${escapeHTML(id)}</code></td>
                <td><strong>${escapeHTML(cat.name)}</strong></td>
                <td>
                    <button class="btn-action btn-edit" onclick="editCategory('${escapeJSString(id)}')"> แก้ไข</button>
                    <button class="btn-action btn-delete" onclick="deleteCategory('${escapeJSString(id)}')"> ลบ</button>
                </td>
            `;
            tbody.appendChild(tr);

            // Populate Select Dropdown
            const opt = document.createElement('option');
            opt.value = id;
            opt.innerText = cat.name;
            select.appendChild(opt);
        });
    }, (error) => {
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
    const q = query(collection(db, 'tables'));
    onSnapshot(q, renderTablesManager, (error) => {
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
    const q = query(collection(db, "rooms"), orderBy("price"));
    onSnapshot(q, (snapshot) => {
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
                <td><img loading="lazy" src="${safeImageURL(room.imageUrl, 'assets/default-room.jpg')}" alt="${escapeHTML(room.name)}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px;"></td>
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

// Real-time Products Listener
function setupRealtimeProducts() {
    const q = query(collection(db, "products"), orderBy("category"));
    onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('products-table-body');
        tbody.innerHTML = '';
        productsData = {};
        
        if (snapshot.empty) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">ไม่มีข้อมูลเมนูสินค้า</td></tr>';
            return;
        }

        snapshot.forEach((docSnap) => {
            const product = docSnap.data();
            const id = docSnap.id;
            productsData[id] = product; // Store locally for edit modal
            
            // Resolve Category Name
            let catName = product.category;
            if (categoriesData[product.category]) {
                catName = categoriesData[product.category].name;
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><img loading="lazy" src="${safeImageURL(product.imageUrl)}" alt="${escapeHTML(product.name)}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 5px;"></td>
                <td><strong>${escapeHTML(product.name)}</strong></td>
                <td>${escapeHTML(catName)}</td>
                <td>฿${escapeHTML(product.price)}</td>
                <td>${product.isSignature ? '<span style="color: green;"> แนะนำ</span>' : '-'}</td>
                <td>
                    <button class="btn-action btn-edit" onclick="editProduct('${escapeJSString(id)}')"> แก้ไข</button>
                    <button class="btn-action btn-delete" onclick="deleteProduct('${escapeJSString(id)}')"> ลบ</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }, (error) => {
        console.error("Error listening to products:", error);
    });
}

// Product Modal Logic
const productModal = document.getElementById('productModal');
const productForm = document.getElementById('productForm');

window.openProductModal = () => {
    productForm.reset();
    document.getElementById('productId').value = '';
    document.getElementById('productImageFile').value = '';
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
    document.getElementById('productSignature').checked = !!product.isSignature;
    
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

        const productData = {
            name: document.getElementById('productName').value,
            description: document.getElementById('productDesc').value,
            price: Number(document.getElementById('productPrice').value),
            imageUrl: finalImageUrl,
            category: document.getElementById('productCategory').value,
            isSignature: document.getElementById('productSignature').checked
        };
        
        if (id) {
            // Update existing
            await updateDoc(doc(db, "products", id), productData);
        } else {
            // Add new
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
        await updateDoc(doc(db, "orders", id), { status: newStatus });
    } catch (e) {
        alert("อัปเดตไม่สำเร็จ: " + e.message);
    }
}

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

window.fetchBlogsFromCloud = function() {
    const q = query(collection(db, "blogs"), orderBy("createdAt", "desc"));
    onSnapshot(q, (snapshot) => {
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
    const q = query(collection(db, "shop_categories"));
    onSnapshot(q, (snapshot) => {
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
    const q = query(collection(db, "shop_products"));
    onSnapshot(q, (snapshot) => {
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
                    <button class="btn-action btn-edit" onclick="editShopProduct('${escapeJSString(id)}')"> </button>
                    <button class="btn-action btn-delete" onclick="deleteShopProduct('${escapeJSString(id)}')"> </button>
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
        tbody.innerHTML = '<tr><td colspan="6"><div class="member-empty-state">ยังไม่มีผู้จัดการในระบบ กรอก UID จาก Firebase Auth หรือเลือกจากสมาชิกเพื่อเริ่มต้น</div></td></tr>';
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
        return `
            <tr>
                <td><strong>${escapeHTML(row.displayName || 'Manager')}</strong><br><small>${escapeHTML(row.email || '-')}<br>UID: ${escapeHTML(row.uid)}</small></td>
                <td>${adminRoleBadgeHTML(row.role)}</td>
                <td style="max-width:260px;">${escapeHTML(permissionText)}</td>
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
    const role = document.getElementById('access-role')?.value || 'manager';
    const status = document.getElementById('access-status')?.value || 'active';
    if (!uid || !email) {
        alert('กรุณากรอก Firebase UID และอีเมล');
        return;
    }
    if (uid.includes('@')) {
        alert('Firebase UID ต้องไม่ใช่อีเมลครับ ให้ใช้ User UID จาก Firebase Authentication หรือเลือกจาก dropdown สมาชิก');
        return;
    }


    const permissions = normalizePermissions(role, getSelectedAdminPermissions());
    const existing = adminAccessData[uid];
    const payload = {
        uid,
        email,
        displayName,
        role,
        status,
        permissions,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser?.uid || ''
    };
    if (!existing) {
        payload.createdAt = serverTimestamp();
        payload.createdBy = auth.currentUser?.uid || '';
    }
    try {
        await setDoc(doc(db, ADMIN_COLLECTION, uid), payload, { merge: true });
        adminAccessData[uid] = { ...payload, updatedAt: new Date().toISOString() };
        renderAdminAccessTable();
        alert('บันทึกสิทธิ์ผู้จัดการเรียบร้อยแล้ว\n\nถ้าผู้จัดการยังเข้าไม่ได้ ให้เช็กว่า UID ตรงกับ Firebase Authentication ของบัญชีนั้น');
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
    renderAdminPermissionInputs(adminRoleDefaults('manager'));
};

window.refreshAdminAccess = () => {
    renderAdminAccessTable();
    renderAdminUserOptions();
};

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
    }, (error) => {
        console.error('Error listening to admin access:', error);
        const tbody = document.getElementById('admin-access-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#c62828;">โหลดสิทธิ์ผู้จัดการไม่สำเร็จ: ${escapeHTML(error.message)}</td></tr>`;
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
        tbody.innerHTML = '<tr><td colspan="9"><div class="member-empty-state">No members match the selected filters.</div></td></tr>';
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
                <td>${formatDate(lastDate)}</td>
                <td><button class="btn-action btn-view" onclick="openMemberModal('${escapeJSString(uid)}')">Details</button></td>
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
    }, (error) => {
        console.error('Error listening to members:', error);
        const tbody = document.getElementById('members-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:#c62828;">Unable to load members: ${escapeHTML(error.message)}</td></tr>`;
    });
}

window.refreshMembers = () => renderMembersTable();

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

// ==========================================
// FAQ Management Logic
// ==========================================
let faqsData = {};

const faqModal = document.getElementById('faqModal');
const faqForm = document.getElementById('faqForm');

window.fetchFaqsFromCloud = function() {
    const q = query(collection(db, "faqs"), orderBy("order", "asc"));
    onSnapshot(q, (snapshot) => {
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
    }
});






