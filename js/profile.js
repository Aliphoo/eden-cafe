import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, getDoc, getDocs, query, setDoc, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMemberTier, getNextTierProgress, getTierBenefits, getTierTheme, getTierRules } from './membership.js';
import { getMyProfile, profileToStoredUser } from './member-auth-service.js';

(() => {
    const USER_KEY = 'eden_user';
    const ORDER_HISTORY_KEY = 'eden_order_history';
    const CART_KEY = 'eden_cart';
    const GOOGLE_SETUP_KEY = 'eden_google_password_setup';
    const FUNCTIONS_BASE_URL = 'https://asia-southeast1-edencafe-d9095.cloudfunctions.net';
    const PHONE_AUTH_EMAIL_DOMAIN = 'phone.edencafe.co';
    let cloudOrders = null;
    let cloudBookings = null;
    let cloudHistoryUid = '';
    let cloudHistoryLoading = false;
    let cloudProfile = null;
    let cloudProfileUid = '';
    let cloudProfileLoading = false;
    let cloudProfileSaving = false;
    let emailVerificationBusy = false;
    let loyaltyConfig = null;
    let loyaltyLedger = [];
    let loyaltySummary = null;
    let loyaltyUid = '';
    let loyaltyLoading = false;
    let currentAuthUser = null;
    let authStateResolved = false;
    let selectedPreviewTier = '';
    let activeProfileTab = 'overview';
    let activeHistoryFilter = 'all';
    let historyExpanded = false;
    const PROFILE_TABS = ['overview', 'points', 'history', 'account'];
    const HISTORY_FILTERS = ['all', 'orders', 'bookings', 'archery'];
    const CAN_LOG_CLIENT_ERRORS = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);

    const DEFAULT_LOYALTY_CONFIG = {
        enabled: true,
        spendPerPoint: 25,
        pointValue: 1,
        expiryMonths: 24,
        maxRedeemPercent: 30,
        minRedeemPoints: 20,
        earnAfterDiscount: true,
        earnOnRedeemedAmount: false,
        excludedCategories: ['เครื่องดื่มแอลกอฮอล์', 'ฝากเงิน', 'โปรแรง'],
        tierMultipliers: { Silver: 1, Gold: 1.25, Platinum: 1.5 }
    };

    function isEnglishPage() {
        return location.pathname.includes('-en');
    }

    function logClientError(label, error) {
        if (CAN_LOG_CLIENT_ERRORS) console.warn(label, error);
    }

    function escapeHTML(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function readJSON(key, fallback) {
        try {
            const value = JSON.parse(localStorage.getItem(key) || 'null');
            return value ?? fallback;
        } catch (_) {
            return fallback;
        }
    }

    function cleanString(value, maxLength = 300) {
        return String(value ?? '').trim().slice(0, maxLength);
    }

    function isInternalPhoneEmail(email) {
        return String(email || '').toLowerCase().endsWith('@' + PHONE_AUTH_EMAIL_DOMAIN);
    }

    function publicEmail(email, fallback = '') {
        return isInternalPhoneEmail(email) ? fallback : (email || fallback || '');
    }

    function hasPasswordLogin(user = {}) {
        return user.passwordLoginEnabled === true || user.password_login_enabled === true;
    }

    function redirectToPasswordSetup() {
        sessionStorage.setItem(GOOGLE_SETUP_KEY, '1');
        window.location.href = '/register?google=1';
    }

    function money(value) {
        return '฿' + (Number(value) || 0).toLocaleString('en-US');
    }

    function numberValue(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function normalizeLoyaltyConfig(raw = {}) {
        const tierMultipliers = raw.tierMultipliers || {};
        const excludedCategories = Array.isArray(raw.excludedCategories)
            ? raw.excludedCategories
            : String(raw.excludedCategories || '')
                .split(',')
                .map(item => item.trim())
                .filter(Boolean);
        return {
            ...DEFAULT_LOYALTY_CONFIG,
            ...raw,
            enabled: raw.enabled !== false,
            spendPerPoint: Math.max(1, numberValue(raw.spendPerPoint, DEFAULT_LOYALTY_CONFIG.spendPerPoint)),
            pointValue: Math.max(0, numberValue(raw.pointValue, DEFAULT_LOYALTY_CONFIG.pointValue)),
            expiryMonths: Math.max(0, Math.round(numberValue(raw.expiryMonths, DEFAULT_LOYALTY_CONFIG.expiryMonths))),
            maxRedeemPercent: Math.min(100, Math.max(0, numberValue(raw.maxRedeemPercent, DEFAULT_LOYALTY_CONFIG.maxRedeemPercent))),
            minRedeemPoints: Math.max(0, Math.round(numberValue(raw.minRedeemPoints, DEFAULT_LOYALTY_CONFIG.minRedeemPoints))),
            earnAfterDiscount: raw.earnAfterDiscount !== false,
            earnOnRedeemedAmount: raw.earnOnRedeemedAmount === true,
            excludedCategories,
            tierMultipliers: {
                Silver: numberValue(tierMultipliers.Silver, DEFAULT_LOYALTY_CONFIG.tierMultipliers.Silver),
                Gold: numberValue(tierMultipliers.Gold, DEFAULT_LOYALTY_CONFIG.tierMultipliers.Gold),
                Platinum: numberValue(tierMultipliers.Platinum, DEFAULT_LOYALTY_CONFIG.tierMultipliers.Platinum)
            }
        };
    }

    function getLoyaltyConfig() {
        return normalizeLoyaltyConfig(loyaltyConfig || DEFAULT_LOYALTY_CONFIG);
    }

    function formatDate(value) {
        if (!value) return '-';
        const date = value?.toDate ? value.toDate() : new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString(isEnglishPage() ? 'en-US' : 'th-TH', {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    function getLabels() {
        const en = isEnglishPage();
        return en ? {
            signInPrompt: 'Please sign in to view your profile',
            signIn: 'Sign In',
            member: 'Eden Member',
            profile: 'Profile',
            overview: 'Overview',
            orders: 'Orders',
            bookings: 'Bookings',
            account: 'Account',
            pointsTab: 'Points',
            history: 'History',
            dashboardTitle: 'Member Dashboard',
            dashboardLead: 'Manage your Eden profile, points, rewards, and recent activity in one place.',
            memberSummary: 'Member summary',
            quickActions: 'Quick actions',
            greetingPrefix: 'Hey',
            youHave: 'You have',
            edenPoints: 'Eden Points',
            viewPoints: 'View Points',
            memberCard: 'Member card',
            tierProgress: 'Tier progress',
            howItWorks: 'How it works',
            howItWorksEarn: 'Earn points from eligible Eden Cafe orders and bookings.',
            howItWorksRedeem: 'Use points and member benefits with Eden promotions.',
            howItWorksTier: 'Grow your tier from Silver to Gold and Platinum as you spend, collect points, or visit.',
            bookArchery: 'Book Archery',
            historyAll: 'All',
            historyOrders: 'Orders',
            historyBookings: 'Table / Room',
            historyArchery: 'Archery',
            recentActivity: 'Recent activity',
            noHistory: 'No activity yet.',
            showAll: 'View all',
            showLess: 'Show less',
            activityStatus: 'Status',
            tableBooking: 'Table booking',
            roomBooking: 'Room booking',
            archeryBooking: 'Archery booking',
            generalBooking: 'Booking',
            memberId: 'Member ID',
            points: 'Reward Points',
            totalSpent: 'Total Spent',
            visits: 'Visits',
            cartItems: 'Cart Items',
            pointValue: 'Point Value',
            loyaltyWallet: 'Eden Points Wallet',
            loyaltyRule: 'Earning & redemption rules',
            loyaltyHistory: 'Recent point history',
            loyaltyLoading: 'Loading loyalty information...',
            noLoyaltyHistory: 'No point movement yet.',
            pointsAsCash: '{points} points = THB {value} credit',
            earnRule: 'Earn 1 point for every THB {spend}. Gold x{gold}, Platinum x{platinum}.',
            redeemRule: 'Redeem from {min} points, up to {percent}% of each bill.',
            expiryRule: 'Points expire in {months} months.',
            noExpiryRule: 'Points do not expire.',
            membership: 'Membership Level',
            benefits: 'Your Benefits',
            tierPreview: 'Preview membership tiers',
            tierPreviewLead: 'Tap each tier to preview rewards and what is still locked.',
            currentTier: 'Current tier',
            unlockedTier: 'Unlocked',
            lockedTier: 'Locked',
            previewingTier: 'Previewing',
            unlockBy: 'Unlock by reaching any one condition:',
            previewBenefits: 'Preview benefits',
            nextLevel: 'Next Tier Requirements',
            highestTier: 'You are already at the highest tier.',
            progressTo: 'Progress to',
            remainingPoints: 'More {value} points to reach {tier}',
            remainingSpend: 'Spend THB {value} more to reach {tier}',
            remainingVisits: 'Visit {value} more times to reach {tier}',
            metricPoints: 'Points',
            metricSpent: 'Spending',
            metricVisits: 'Visits',
            nextRulesPrefix: 'Reach any one condition to upgrade:',
            pointRule: '{value}+ points',
            spentRule: 'THB {value}+ total spending',
            visitRule: '{value}+ visits',
            recentOrders: 'Recent Orders',
            noOrders: 'No order history yet.',
            noBookings: 'No booking history yet.',
            pending: 'Pending Payment',
            paid: 'Paid',
            profileInfo: 'Profile Information',
            googleInfo: 'Member Account',
            editableInfo: 'Additional customer information',
            name: 'Name',
            email: 'Email',
            emailVerification: 'Email verification',
            emailVerified: 'Verified',
            emailUnverified: 'Not verified',
            emailOptional: 'We will send a 6-digit code to this email. After verification, you can use this email with your existing password.',
            emailCode: 'Verification code',
            emailCodePlaceholder: '123456',
            sendEmailCode: 'Send code',
            verifyEmailCode: 'Verify code',
            sendingEmailCode: 'Sending code...',
            verifyingEmailCode: 'Verifying...',
            emailCodeSent: 'Verification code sent. Please check your email.',
            emailCodeVerified: 'Email verified successfully.',
            emailCodeFailed: 'Unable to verify email right now.',
            phone: 'Phone number',
            shippingAddress: 'Shipping address',
            birthDate: 'Birthday',
            allergies: 'Food allergies',
            healthNote: 'Health note',
            lineId: 'LINE ID',
            phonePlaceholder: '08X-XXX-XXXX',
            addressPlaceholder: 'House number, street, district, province, postcode',
            birthPlaceholder: 'Select birthday',
            allergiesPlaceholder: 'Example: peanuts, milk, shrimp, gluten',
            healthPlaceholder: 'Share only what you want the cafe to know',
            linePlaceholder: 'Your LINE ID',
            privacyNote: 'Food allergy and health notes are used only to support service and food preparation safety.',
            save: 'Save profile',
            reset: 'Reset',
            saving: 'Saving...',
            saved: 'Profile saved successfully.',
            saveFailed: 'Unable to save profile. Please try again.',
            loadingProfile: 'Loading saved profile...',
            notProvided: 'Not provided',
            shopNow: 'Shop Now',
            bookTable: 'Book a Table',
            logout: 'Logout',
            orderId: 'Order',
            total: 'Total',
            items: 'Items'
        } : {
            signInPrompt: 'กรุณาเข้าสู่ระบบเพื่อดูข้อมูลโปรไฟล์ของคุณ',
            signIn: 'เข้าสู่ระบบ / Sign In',
            member: 'สมาชิก Eden',
            profile: 'ข้อมูลส่วนตัว',
            overview: 'ภาพรวม',
            orders: 'คำสั่งซื้อ',
            bookings: 'การจอง',
            account: 'บัญชีของฉัน',
            pointsTab: 'แต้ม',
            history: 'ประวัติ',
            dashboardTitle: 'แดชบอร์ดสมาชิก',
            dashboardLead: 'จัดการข้อมูลสมาชิก แต้ม สิทธิประโยชน์ และประวัติการใช้งานของคุณในที่เดียว',
            memberSummary: 'สรุปสมาชิก',
            quickActions: 'เมนูลัด',
            greetingPrefix: 'สวัสดี',
            youHave: 'คุณมี',
            edenPoints: 'Eden Points',
            viewPoints: 'ดูแต้ม',
            memberCard: 'บัตรสมาชิก',
            tierProgress: 'ความคืบหน้าระดับสมาชิก',
            howItWorks: 'วิธีใช้งาน',
            howItWorksEarn: 'สะสมแต้มจากคำสั่งซื้อและการจองที่เข้าร่วมของ Eden Cafe',
            howItWorksRedeem: 'ใช้แต้มและสิทธิ์สมาชิกกับโปรโมชันของ Eden',
            howItWorksTier: 'ขยับระดับจาก Silver ไป Gold และ Platinum เมื่อยอดใช้จ่าย แต้ม หรือจำนวนครั้งเข้าเงื่อนไข',
            bookArchery: 'จองยิงธนู',
            historyAll: 'ทั้งหมด',
            historyOrders: 'คำสั่งซื้อ',
            historyBookings: 'โต๊ะ / ห้อง',
            historyArchery: 'ยิงธนู',
            recentActivity: 'กิจกรรมล่าสุด',
            noHistory: 'ยังไม่มีประวัติการใช้งาน',
            showAll: 'ดูทั้งหมด',
            showLess: 'ย่อรายการ',
            activityStatus: 'สถานะ',
            tableBooking: 'จองโต๊ะ',
            roomBooking: 'จองห้อง',
            archeryBooking: 'จองยิงธนู',
            generalBooking: 'การจอง',
            memberId: 'รหัสสมาชิก',
            points: 'คะแนนสะสม',
            totalSpent: 'ยอดใช้จ่ายสะสม',
            visits: 'จำนวนครั้งที่ใช้บริการ',
            cartItems: 'สินค้าในตะกร้า',
            pointValue: 'มูลค่าแต้ม',
            loyaltyWallet: 'กระเป๋าแต้ม Eden',
            loyaltyRule: 'กติกาสะสมและใช้แต้ม',
            loyaltyHistory: 'ประวัติแต้มล่าสุด',
            loyaltyLoading: 'กำลังโหลดข้อมูลแต้ม...',
            noLoyaltyHistory: 'ยังไม่มีรายการแต้ม',
            pointsAsCash: '{points} คะแนน = เครดิต {value} บาท',
            earnRule: 'ซื้อครบ {spend} บาท ได้ 1 คะแนน Gold x{gold}, Platinum x{platinum}',
            redeemRule: 'ใช้แต้มขั้นต่ำ {min} คะแนน และใช้ได้ไม่เกิน {percent}% ต่อบิล',
            expiryRule: 'แต้มหมดอายุใน {months} เดือน',
            noExpiryRule: 'แต้มไม่มีวันหมดอายุ',
            membership: 'ระดับสมาชิก',
            benefits: 'สิทธิประโยชน์ของคุณ',
            tierPreview: 'พรีวิวระดับสมาชิก',
            tierPreviewLead: 'กดดูแต่ละระดับเพื่อดูสิทธิประโยชน์และเป้าหมายที่ยังล็อกอยู่',
            currentTier: 'ระดับปัจจุบัน',
            unlockedTier: 'ปลดล็อกแล้ว',
            lockedTier: 'ยังล็อกอยู่',
            previewingTier: 'กำลังพรีวิว',
            unlockBy: 'ปลดล็อกด้วยเงื่อนไขใดเงื่อนไขหนึ่ง:',
            previewBenefits: 'สิทธิประโยชน์ตัวอย่าง',
            nextLevel: 'เงื่อนไขอัประดับถัดไป',
            highestTier: 'คุณอยู่ระดับสูงสุดแล้ว',
            progressTo: 'ความคืบหน้าไป',
            remainingPoints: 'อีก {value} คะแนน จะอัปเป็น {tier}',
            remainingSpend: 'อีก {value} บาท จะอัปเป็น {tier}',
            remainingVisits: 'อีก {value} ครั้ง จะอัปเป็น {tier}',
            metricPoints: 'คะแนน',
            metricSpent: 'ยอดใช้จ่าย',
            metricVisits: 'จำนวนครั้ง',
            nextRulesPrefix: 'ทำให้ถึงเงื่อนไขใดเงื่อนไขหนึ่งเพื่ออัประดับ:',
            pointRule: '{value}+ คะแนน',
            spentRule: 'ยอดใช้จ่าย ฿{value}+',
            visitRule: '{value}+ ครั้ง',
            recentOrders: 'ประวัติคำสั่งซื้อล่าสุด',
            noOrders: 'ยังไม่มีประวัติคำสั่งซื้อ',
            noBookings: 'ยังไม่มีประวัติการจอง',
            pending: 'รอชำระเงิน',
            paid: 'ชำระเงินแล้ว',
            profileInfo: 'ข้อมูลสมาชิก',
            googleInfo: 'บัญชีสมาชิก',
            editableInfo: 'ข้อมูลเพิ่มเติมสำหรับบริการลูกค้า',
            name: 'ชื่อ',
            email: 'อีเมล',
            emailVerification: 'ยืนยันอีเมล',
            emailVerified: 'ยืนยันแล้ว',
            emailUnverified: 'ยังไม่ยืนยัน',
            emailOptional: 'ระบบจะส่งรหัส 6 หลักไปที่อีเมลนี้ หลังยืนยันแล้ว คุณสามารถเข้าสู่ระบบด้วยอีเมลและรหัสผ่านเดิมได้',
            emailCode: 'รหัสยืนยันอีเมล',
            emailCodePlaceholder: '123456',
            sendEmailCode: 'ส่งโค้ด',
            verifyEmailCode: 'ยืนยันโค้ด',
            sendingEmailCode: 'กำลังส่งโค้ด...',
            verifyingEmailCode: 'กำลังยืนยัน...',
            emailCodeSent: 'ส่งโค้ดยืนยันแล้ว กรุณาตรวจสอบอีเมล',
            emailCodeVerified: 'ยืนยันอีเมลเรียบร้อยแล้ว',
            emailCodeFailed: 'ยังไม่สามารถยืนยันอีเมลได้ในขณะนี้',
            phone: 'เบอร์โทร',
            shippingAddress: 'ที่อยู่จัดส่ง',
            birthDate: 'วันเกิด',
            allergies: 'แพ้อาหาร',
            healthNote: 'หมายเหตุสุขภาพ',
            lineId: 'LINE ID',
            phonePlaceholder: '08X-XXX-XXXX',
            addressPlaceholder: 'บ้านเลขที่ ถนน เขต/อำเภอ จังหวัด รหัสไปรษณีย์',
            birthPlaceholder: 'เลือกวันเกิด',
            allergiesPlaceholder: 'เช่น ถั่ว นม กุ้ง กลูเตน',
            healthPlaceholder: 'กรอกเท่าที่ต้องการแจ้งร้าน',
            linePlaceholder: 'LINE ID ของคุณ',
            privacyNote: 'ข้อมูลแพ้อาหารและหมายเหตุสุขภาพใช้เพื่อบริการและความปลอดภัยในการจัดเตรียมอาหารเท่านั้น',
            save: 'บันทึกข้อมูล',
            reset: 'ยกเลิกการแก้ไข',
            saving: 'กำลังบันทึก...',
            saved: 'บันทึกโปรไฟล์เรียบร้อยแล้ว',
            saveFailed: 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
            loadingProfile: 'กำลังโหลดข้อมูลที่บันทึกไว้...',
            notProvided: 'ยังไม่ได้ระบุ',
            shopNow: 'เลือกซื้อสินค้า',
            bookTable: 'จองโต๊ะ',
            logout: 'ออกจากระบบ',
            orderId: 'ออเดอร์',
            total: 'ยอดรวม',
            items: 'รายการ'
        };
    }

    function readUser() {
        const stored = readJSON(USER_KEY, null);
        if (currentAuthUser) {
            return {
                ...(stored && typeof stored === 'object' ? stored : {}),
                uid: currentAuthUser.uid,
                name: stored?.name || currentAuthUser.displayName || 'Eden Member',
                email: publicEmail(currentAuthUser.email, stored?.email || ''),
                avatar: stored?.avatar || currentAuthUser.photoURL || 'https://ui-avatars.com/api/?name=Eden+Member&background=4caf50&color=fff'
            };
        }
        return stored && typeof stored === 'object' ? stored : null;
    }

    function readOrders() {
        const history = readJSON(ORDER_HISTORY_KEY, []);
        const pending = readJSON('eden_pending_order', null);
        const orders = Array.isArray(history) ? [...history] : [];
        if (pending && !orders.some(order => order.id === pending.id)) orders.unshift(pending);
        return orders.slice(0, 10);
    }

    function readBookings() {
        const history = readJSON('eden_booking_history', []);
        return Array.isArray(history) ? history.slice(0, 10) : [];
    }

    async function refreshCloudHistory(user) {
        if (!user?.uid || cloudHistoryLoading || cloudHistoryUid === user.uid) return;
        if (typeof window.fetchUserOrdersFromCloud !== 'function' || typeof window.fetchUserBookingsFromCloud !== 'function') return;
        cloudHistoryLoading = true;
        try {
            const [orders, bookings] = await Promise.all([
                window.fetchUserOrdersFromCloud(user.uid),
                window.fetchUserBookingsFromCloud(user.uid)
            ]);
            cloudOrders = Array.isArray(orders) ? orders : [];
            cloudBookings = Array.isArray(bookings) ? bookings : [];
            cloudHistoryUid = user.uid;
            renderProfile();
        } catch (error) {
            logClientError('Unable to load profile history from cloud:', error);
        } finally {
            cloudHistoryLoading = false;
        }
    }

    async function refreshCloudProfile(user) {
        if (!user?.uid || cloudProfileLoading || cloudProfileUid === user.uid) return;
        cloudProfileLoading = true;
        try {
            const result = await getMyProfile();
            const profile = result.profile || {};
            if (result.customToken && profile.uid && auth?.currentUser?.uid !== profile.uid) {
                await signInWithCustomToken(auth, result.customToken);
                return;
            }
            if (!hasPasswordLogin(profile)) {
                localStorage.setItem(USER_KEY, JSON.stringify(profileToStoredUser(profile)));
                cloudProfileUid = user.uid;
                redirectToPasswordSetup();
                return;
            }
            cloudProfile = {
                ...profile,
                displayName: profile.display_name || 'สมาชิก Eden',
                photoURL: profile.avatar_url || 'Images/Logo.webp',
                phone: profile.phone_display || '',
                phoneE164: profile.phone_number || '',
                tier: profile.member_level || 'Silver',
                member_level: profile.member_level || 'Silver',
                points: Number(profile.points || 0),
                createdAt: profile.created_at || '',
                updatedAt: profile.updated_at || '',
                lastLoginAt: profile.last_login_at || ''
            };
            localStorage.setItem(USER_KEY, JSON.stringify(profileToStoredUser(profile)));
            cloudProfileUid = user.uid;
            renderProfile();
        } catch (error) {
            logClientError('Unable to load member profile:', error);
        } finally {
            cloudProfileLoading = false;
        }
    }

    async function refreshLoyaltyData(user) {
        if (!db || !user?.uid || loyaltyLoading || loyaltyUid === user.uid) return;
        loyaltyLoading = true;
        try {
            const [configSnap, summarySnap, ledgerSnap] = await Promise.all([
                getDoc(doc(db, 'site_settings', 'loyalty')),
                getDoc(doc(db, 'member_summaries', user.uid)),
                getDocs(query(collection(db, 'point_ledger'), where('userId', '==', user.uid)))
            ]);
            loyaltyConfig = configSnap.exists() ? normalizeLoyaltyConfig(configSnap.data()) : normalizeLoyaltyConfig();
            loyaltySummary = summarySnap.exists() ? summarySnap.data() : null;
            loyaltyLedger = ledgerSnap.docs
                .map(item => ({ id: item.id, ...item.data() }))
                .sort((a, b) => {
                    const left = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
                    const right = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
                    return right - left;
                })
                .slice(0, 8);
            loyaltyUid = user.uid;
            renderProfile();
        } catch (error) {
            logClientError('Unable to load loyalty information:', error);
        } finally {
            loyaltyLoading = false;
        }
    }

    function cartCount() {
        const cart = readJSON(CART_KEY, []);
        return Array.isArray(cart) ? cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) : 0;
    }

    function memberId(user) {
        const source = String(user.uid || user.email || 'eden');
        let hash = 0;
        for (let i = 0; i < source.length; i += 1) hash = ((hash << 5) - hash) + source.charCodeAt(i);
        return 'ED-' + Math.abs(hash).toString().slice(0, 6).padStart(6, '0');
    }

    function profileValue(key, fallback = '') {
        return cloudProfile && cloudProfile[key] != null ? cloudProfile[key] : fallback;
    }

    function formatNumber(value) {
        return Math.round(Number(value) || 0).toLocaleString(isEnglishPage() ? 'en-US' : 'th-TH');
    }

    function formatBaht(value) {
        return Math.round(Number(value) || 0).toLocaleString(isEnglishPage() ? 'en-US' : 'th-TH');
    }

    function orderTotal(order) {
        return Number(order.totalAmount ?? order.total ?? order.amount ?? 0) || 0;
    }

    function buildMembershipUser(user, orders, bookings) {
        const paidLikeOrders = orders.filter(order => {
            const status = String(order.status || '').toLowerCase();
            const paymentStatus = String(order.paymentStatus || '').toLowerCase();
            if (status === 'cancelled' || paymentStatus === 'refunded' || paymentStatus === 'failed') return false;
            if (paymentStatus) return paymentStatus === 'paid';
            return status === 'paid' || status === 'completed';
        });
        const orderSpent = paidLikeOrders.reduce((sum, order) => sum + orderTotal(order), 0);
        const orderCount = paidLikeOrders.length;
        const bookingCount = bookings.length;
        const computedVisitCount = orderCount + bookingCount;
        const config = getLoyaltyConfig();
        const computedPoints = config.enabled ? Math.floor(orderSpent / config.spendPerPoint) : 0;
        const summaryPoints = loyaltySummary?.pointsBalance;
        const summaryTotalSpent = loyaltySummary?.totalSpent;
        const summaryVisitCount = loyaltySummary?.visitCount;
        const summaryOrderCount = loyaltySummary?.orderCount;
        const summaryBookingCount = loyaltySummary?.bookingCount;
        const savedPoints = profileValue('points', null);
        const points = summaryPoints != null
            ? Math.max(0, Number(summaryPoints) || 0)
            : savedPoints != null
                ? Math.max(0, Number(savedPoints) || 0)
                : computedPoints;

        return {
            id: user.uid,
            name: profileValue('displayName', user.name || ''),
            email: profileValue('email', user.email || ''),
            avatarUrl: profileValue('photoURL', user.avatar || ''),
            memberCode: profileValue('memberCode', memberId(user)),
            points,
            totalSpent: Math.max(Number(profileValue('totalSpent', 0)) || 0, Number(summaryTotalSpent) || 0, orderSpent),
            visitCount: Math.max(Number(profileValue('visitCount', 0)) || 0, Number(summaryVisitCount) || 0, computedVisitCount),
            orderCount: Math.max(Number(profileValue('orderCount', 0)) || 0, Number(summaryOrderCount) || 0, orderCount),
            bookingCount: Math.max(Number(profileValue('bookingCount', 0)) || 0, Number(summaryBookingCount) || 0, bookingCount),
            cartItemCount: cartCount(),
            createdAt: profileValue('createdAt', ''),
            updatedAt: profileValue('updatedAt', '')
        };
    }

    function tierRank(tier) {
        return ['Silver', 'Gold', 'Platinum'].indexOf(tier);
    }

    function tierStatusLabel(tier, actualTier, labels) {
        if (tier === actualTier) return labels.currentTier;
        return tierRank(tier) <= tierRank(actualTier) ? labels.unlockedTier : labels.lockedTier;
    }

    function tierUnlockRules(tier, labels) {
        const rules = getTierRules();
        const rule = rules[tier.toUpperCase()];
        if (!rule || tier === 'Silver') return '';
        return `
            <div class="tier-preview-rules">
                <p>${escapeHTML(labels.unlockBy)}</p>
                <span>${escapeHTML(labels.pointRule.replace('{value}', formatNumber(rule.minPoints)))}</span>
                <span>${escapeHTML(labels.spentRule.replace('{value}', formatBaht(rule.minTotalSpent)))}</span>
                <span>${escapeHTML(labels.visitRule.replace('{value}', formatNumber(rule.minVisitCount)))}</span>
            </div>
        `;
    }

    function progressMessage(progress, labels) {
        if (progress.completed) return labels.highestTier;
        const value = progress.unit === 'baht' ? formatBaht(progress.remaining) : formatNumber(progress.remaining);
        const template = progress.metric === 'totalSpent'
            ? labels.remainingSpend
            : progress.metric === 'visitCount'
                ? labels.remainingVisits
                : labels.remainingPoints;
        return template.replace('{value}', value).replace('{tier}', progress.nextTier);
    }

    function renderMemberCard(user, labels, membershipUser) {
        const tier = getMemberTier(membershipUser);
        const theme = getTierTheme(tier);
        const progress = getNextTierProgress(membershipUser);
        const progressLabel = progress.completed ? labels.highestTier : `${labels.progressTo} ${progress.nextTier}`;
        const percent = progress.completed ? 100 : progress.percent;

        return `
            <div class="member-card ${theme.className}" id="profile-overview">
                <div class="member-card-header">
                    <div>
                        <div class="member-tier-badge ${theme.badgeClass}">${escapeHTML(tier)}</div>
                        <p class="member-name">${escapeHTML(membershipUser.name || labels.member)}</p>
                    </div>
                    <div class="member-id">${escapeHTML(labels.memberId)}: ${escapeHTML(membershipUser.memberCode || memberId(user))}</div>
                </div>
                <div class="member-progress-container">
                    <div class="member-progress-text"><span>${escapeHTML(progressLabel)}</span><span>${percent}%</span></div>
                    <div class="member-progress-bar"><div class="member-progress-fill" style="width:${percent}%"></div></div>
                    <p class="member-progress-goal">${escapeHTML(progressMessage(progress, labels))}</p>
                </div>
            </div>
        `;
    }

    function renderLoyaltyWallet(membershipUser, labels) {
        const config = getLoyaltyConfig();
        const pointCashValue = Math.floor((Number(membershipUser.points) || 0) * config.pointValue);
        const earnRule = labels.earnRule
            .replace('{spend}', formatBaht(config.spendPerPoint))
            .replace('{gold}', config.tierMultipliers.Gold)
            .replace('{platinum}', config.tierMultipliers.Platinum);
        const redeemRule = labels.redeemRule
            .replace('{min}', formatNumber(config.minRedeemPoints))
            .replace('{percent}', formatNumber(config.maxRedeemPercent));
        const expiryRule = config.expiryMonths
            ? labels.expiryRule.replace('{months}', formatNumber(config.expiryMonths))
            : labels.noExpiryRule;
        const walletValue = labels.pointsAsCash
            .replace('{points}', formatNumber(membershipUser.points))
            .replace('{value}', formatBaht(pointCashValue));
        const historyRows = loyaltyLedger.map(row => {
            const delta = Number(row.pointsDelta) || 0;
            const prefix = delta > 0 ? '+' : '';
            const reason = row.reason || row.type || '-';
            return `
                <div class="membership-rule-row">
                    <span>${escapeHTML(formatDate(row.createdAt))}</span>
                    <strong style="color:${delta < 0 ? '#b42318' : 'var(--primary-color)'};">${escapeHTML(prefix + formatNumber(delta))}</strong>
                    <em>${escapeHTML(reason)}</em>
                </div>
            `;
        }).join('');

        return `
            <div class="membership-panel" id="profile-loyalty-wallet">
                <h2>${escapeHTML(labels.loyaltyWallet)}</h2>
                <div class="stats-grid">
                    <div class="stat-box"><div class="stat-value">${formatNumber(membershipUser.points)}</div><div class="stat-label">${escapeHTML(labels.points)}</div></div>
                    <div class="stat-box"><div class="stat-value">฿${formatBaht(pointCashValue)}</div><div class="stat-label">${escapeHTML(labels.pointValue)}</div></div>
                </div>
                <p class="membership-rule-lead">${escapeHTML(walletValue)}</p>
                <div class="benefit-grid">
                    <div class="benefit-pill">${escapeHTML(earnRule)}</div>
                    <div class="benefit-pill">${escapeHTML(redeemRule)}</div>
                    <div class="benefit-pill">${escapeHTML(expiryRule)}</div>
                </div>
                <h3 style="margin:24px 0 10px;">${escapeHTML(labels.loyaltyHistory)}</h3>
                ${loyaltyLoading ? `<p class="membership-rule-lead">${escapeHTML(labels.loyaltyLoading)}</p>` : ''}
                <div class="membership-rule-list">
                    ${historyRows || `<p class="membership-rule-lead">${escapeHTML(labels.noLoyaltyHistory)}</p>`}
                </div>
            </div>
        `;
    }

    function renderBenefitGrid(tier) {
        const benefits = getTierBenefits(tier, isEnglishPage() ? 'en' : 'th');
        return `
            <div class="benefit-grid">
                ${benefits.map(item => `<div class="benefit-pill">${escapeHTML(item)}</div>`).join('')}
            </div>
        `;
    }

    function renderBenefits(tier, labels) {
        return `
            <div class="membership-panel">
                <h2>${escapeHTML(labels.benefits)}</h2>
                ${renderBenefitGrid(tier)}
            </div>
        `;
    }

    function renderTierPreview(actualTier, labels) {
        const tiers = ['Silver', 'Gold', 'Platinum'];
        const previewTier = selectedPreviewTier || (actualTier === 'Platinum' ? 'Platinum' : 'Gold');
        const previewBenefits = getTierBenefits(previewTier, isEnglishPage() ? 'en' : 'th');
        const previewTheme = getTierTheme(previewTier);
        const isPreviewLocked = tierRank(previewTier) > tierRank(actualTier);

        return `
            <div class="membership-panel tier-preview-panel">
                <div class="tier-preview-heading">
                    <div>
                        <h2>${escapeHTML(labels.tierPreview)}</h2>
                        <p>${escapeHTML(labels.tierPreviewLead)}</p>
                    </div>
                    <span class="tier-preview-selected">${escapeHTML(labels.previewingTier)} ${escapeHTML(previewTier)}</span>
                </div>
                <div class="tier-preview-grid">
                    ${tiers.map(tier => {
                        const theme = getTierTheme(tier);
                        const locked = tierRank(tier) > tierRank(actualTier);
                        const active = tier === previewTier;
                        return `
                            <button type="button" class="tier-preview-card ${theme.className} ${active ? 'is-active' : ''} ${locked ? 'is-locked' : 'is-unlocked'}" onclick="previewMemberTier('${tier}')">
                                <span class="tier-preview-lock">${locked ? '🔒' : '✓'}</span>
                                <strong>${escapeHTML(tier)}</strong>
                                <small>${escapeHTML(tierStatusLabel(tier, actualTier, labels))}</small>
                            </button>
                        `;
                    }).join('')}
                </div>
                <div class="tier-preview-detail ${previewTheme.className}">
                    <div class="tier-preview-detail-head">
                        <div>
                            <span class="member-tier-badge ${previewTheme.badgeClass}">${escapeHTML(previewTier)}</span>
                            <h3>${escapeHTML(labels.previewBenefits)}</h3>
                        </div>
                        <span class="tier-preview-lock-large">${isPreviewLocked ? '🔒' : '✓'}</span>
                    </div>
                    <div class="benefit-grid">
                        ${previewBenefits.map(item => `<div class="benefit-pill">${escapeHTML(item)}</div>`).join('')}
                    </div>
                    ${isPreviewLocked ? tierUnlockRules(previewTier, labels) : ''}
                </div>
            </div>
        `;
    }

    function renderNextTierRequirements(membershipUser, labels) {
        const progress = getNextTierProgress(membershipUser);
        const rules = getTierRules();
        if (progress.completed || !progress.nextTier) {
            return `
                <div class="membership-panel">
                    <h2>${escapeHTML(labels.nextLevel)}</h2>
                    <p class="membership-max-note">${escapeHTML(labels.highestTier)}</p>
                </div>
            `;
        }

        const nextRules = rules[progress.nextTier.toUpperCase()];
        const rows = [
            { label: labels.metricPoints, current: formatNumber(membershipUser.points), rule: labels.pointRule.replace('{value}', formatNumber(nextRules.minPoints)) },
            { label: labels.metricSpent, current: '฿' + formatBaht(membershipUser.totalSpent), rule: labels.spentRule.replace('{value}', formatBaht(nextRules.minTotalSpent)) },
            { label: labels.metricVisits, current: formatNumber(membershipUser.visitCount), rule: labels.visitRule.replace('{value}', formatNumber(nextRules.minVisitCount)) }
        ];

        return `
            <div class="membership-panel">
                <h2>${escapeHTML(labels.nextLevel)}</h2>
                <p class="membership-rule-lead">${escapeHTML(labels.nextRulesPrefix)}</p>
                <div class="membership-rule-list">
                    ${rows.map(row => `
                        <div class="membership-rule-row">
                            <span>${escapeHTML(row.label)}</span>
                            <strong>${escapeHTML(row.current)}</strong>
                            <em>${escapeHTML(row.rule)}</em>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    function renderSignedOut(container, labels) {
        container.innerHTML = `
            <div class="profile-container" style="text-align:center;">
                <img src="Images/Logo.webp" alt="Eden Cafe" style="width:84px;height:84px;border-radius:50%;object-fit:cover;margin-bottom:18px;">
                <h1 style="margin-bottom:10px;">${escapeHTML(labels.profile)}</h1>
                <p style="color:#666;">${escapeHTML(labels.signInPrompt)}</p>
                <a class="btn btn-outline" href="/login" style="margin-top:15px;">${escapeHTML(labels.signIn)}</a>
            </div>
        `;
    }

    function renderOrderList(orders, labels) {
        if (!orders.length) return `<p style="color:#777;">${escapeHTML(labels.noOrders)}</p>`;
        return orders.map(order => {
            const items = Array.isArray(order.items) ? order.items : [];
            const paymentStatus = String(order.paymentStatus || order.payment_status || '').toLowerCase();
            const orderStatus = String(order.status || order.order_status || '').toLowerCase();
            const status = paymentStatus === 'paid' || paymentStatus === 'paid_online' || orderStatus === 'paid' || orderStatus === 'completed'
                ? labels.paid
                : labels.pending;
            return `
                <div class="order-card">
                    <div class="order-card-header">
                        <strong>${escapeHTML(labels.orderId)} ${escapeHTML(order.id || '-')}</strong>
                        <span style="color:var(--primary-color);font-weight:600;">${escapeHTML(status)}</span>
                    </div>
                    <p style="margin:0 0 8px;color:#666;">${formatDate(order.date || order.timestamp)}</p>
                    <p style="margin:0 0 8px;">${escapeHTML(labels.items)}: ${items.map(item => escapeHTML(item.name || '')).join(', ') || '-'}</p>
                    <strong>${escapeHTML(labels.total)}: ${money(order.totalAmount || order.total || 0)}</strong>
                </div>
            `;
        }).join('');
    }

    function renderBookingList(bookings, labels) {
        if (!bookings.length) return `<p style="color:#777;">${escapeHTML(labels.noBookings)}</p>`;
        return bookings.map(booking => `
            <div class="order-card">
                <div class="order-card-header">
                    <strong>${escapeHTML(booking.id || booking.date || '-')}</strong>
                    <span style="color:var(--primary-color);font-weight:600;">${escapeHTML(booking.status || 'confirmed')}</span>
                </div>
                <p style="margin:0;color:#666;">${escapeHTML([booking.date, booking.time || booking.arrivalTime || booking.startTime, booking.tableIds || booking.table || booking.zone || booking.tableZone].filter(Boolean).join(' | '))}</p>
            </div>
        `).join('');
    }

    function profileTabLabel(tab, labels) {
        return {
            overview: labels.overview,
            points: labels.pointsTab,
            history: labels.history,
            account: labels.account
        }[tab] || labels.overview;
    }

    function renderProfileTabs(labels) {
        return `
            <div class="profile-tabs" role="tablist" aria-label="${escapeHTML(labels.dashboardTitle)}">
                ${PROFILE_TABS.map(tab => `
                    <button
                        class="profile-tab ${activeProfileTab === tab ? 'active' : ''}"
                        type="button"
                        role="tab"
                        data-profile-tab="${escapeHTML(tab)}"
                        aria-selected="${activeProfileTab === tab ? 'true' : 'false'}"
                        aria-controls="profile-tab-${escapeHTML(tab)}"
                        onclick="setProfileTab('${escapeHTML(tab)}')">
                        ${escapeHTML(profileTabLabel(tab, labels))}
                    </button>
                `).join('')}
            </div>
        `;
    }

    function setProfileTab(tab) {
        if (!PROFILE_TABS.includes(tab)) return false;
        activeProfileTab = tab;
        renderProfile();
        requestAnimationFrame(() => {
            document.getElementById(`profile-tab-${tab}`)?.focus?.({ preventScroll: true });
        });
        return false;
    }

    function setProfileHistoryFilter(filter) {
        if (!HISTORY_FILTERS.includes(filter)) return false;
        activeHistoryFilter = filter;
        activeProfileTab = 'history';
        historyExpanded = false;
        renderProfile();
        return false;
    }

    function toggleProfileHistoryExpanded() {
        historyExpanded = !historyExpanded;
        activeProfileTab = 'history';
        renderProfile();
        return false;
    }

    function tierPointTarget(tier) {
        const rules = getTierRules();
        return Number(rules[tier.toUpperCase()]?.minPoints || 0) || 0;
    }

    function renderTierJourney(membershipUser, labels) {
        const currentTier = getMemberTier(membershipUser);
        const tiers = ['Silver', 'Gold', 'Platinum'];
        const maxPoints = Math.max(1, tierPointTarget('Platinum'));
        const pointsForRail = Math.max(Number(membershipUser.points) || 0, tierPointTarget(currentTier));
        const progressPercent = Math.max(0, Math.min(100, Math.round(pointsForRail / maxPoints * 100)));
        const progressScale = (progressPercent / 100).toFixed(2);
        return `
            <section class="membership-panel profile-tier-journey" aria-label="${escapeHTML(labels.tierProgress)}">
                <div class="profile-tier-heading">
                    <div>
                        <span class="profile-kicker">${escapeHTML(labels.tierProgress)}</span>
                        <h2>${escapeHTML(currentTier)}</h2>
                    </div>
                    <strong>${formatNumber(membershipUser.points)} ${escapeHTML(labels.points)}</strong>
                </div>
                <div class="profile-tier-track" style="--profile-tier-progress:${progressScale}">
                    <span class="profile-tier-track-fill" aria-hidden="true"></span>
                    ${tiers.map(tier => {
                        const unlocked = tierRank(tier) <= tierRank(currentTier);
                        const active = tier === currentTier;
                        return `
                            <div class="profile-tier-step ${unlocked ? 'is-unlocked' : 'is-locked'} ${active ? 'is-active' : ''}">
                                <span class="profile-tier-diamond" aria-hidden="true"></span>
                                <strong>${escapeHTML(tier)}</strong>
                                <small>${formatNumber(tierPointTarget(tier))} ${escapeHTML(labels.points)}</small>
                            </div>
                        `;
                    }).join('')}
                </div>
                <p class="membership-rule-lead">${escapeHTML(progressMessage(getNextTierProgress(membershipUser), labels))}</p>
            </section>
        `;
    }

    function renderHowItWorks(labels) {
        const steps = [labels.howItWorksEarn, labels.howItWorksRedeem, labels.howItWorksTier];
        return `
            <section class="membership-panel profile-how-panel" aria-label="${escapeHTML(labels.howItWorks)}">
                <h2>${escapeHTML(labels.howItWorks)}</h2>
                <div class="profile-how-list">
                    ${steps.map((step, index) => `
                        <div class="profile-how-step">
                            <span>${index + 1}</span>
                            <p>${escapeHTML(step)}</p>
                        </div>
                    `).join('')}
                </div>
            </section>
        `;
    }

    function renderProfileSummary(user, labels, membershipUser, tier, avatar, displayName, email) {
        const theme = getTierTheme(tier);
        return `
            <aside class="profile-sidebar profile-dashboard-sidebar" aria-label="${escapeHTML(labels.memberSummary)}">
                <section class="profile-summary-card profile-summary-card-premium">
                    <div class="profile-summary-top">
                        <span class="profile-tier-chip ${theme.badgeClass}">${escapeHTML(tier)} ${escapeHTML(labels.member)}</span>
                        <h2>${escapeHTML(labels.greetingPrefix)} ${escapeHTML(displayName || labels.member)}</h2>
                        <p>${escapeHTML(labels.youHave)}</p>
                        <strong class="profile-summary-points">${formatNumber(membershipUser.points)}</strong>
                        <small>${escapeHTML(labels.edenPoints)}</small>
                        <button class="profile-claim-button" type="button" onclick="setProfileTab('points')">${escapeHTML(labels.viewPoints)}</button>
                    </div>
                    <div class="profile-mini-card" aria-label="${escapeHTML(labels.memberCard)}">
                        <div>
                            <strong>${escapeHTML(displayName || labels.member)}</strong>
                            <span>${escapeHTML(membershipUser.memberCode || memberId(user))}</span>
                        </div>
                        <span class="profile-mini-tier">${escapeHTML(tier)}</span>
                        <b>${formatNumber(membershipUser.points)} ${escapeHTML(labels.points)}</b>
                    </div>
                </section>

                ${renderTierJourney(membershipUser, labels)}

                <div class="profile-quick-actions" aria-label="${escapeHTML(labels.quickActions)}">
                    <a class="profile-action-card" href="${isEnglishPage() ? '/shop-en' : '/shop'}"><span aria-hidden="true"></span>${escapeHTML(labels.shopNow)}</a>
                    <a class="profile-action-card" href="${isEnglishPage() ? '/booking-en' : '/booking'}"><span aria-hidden="true"></span>${escapeHTML(labels.bookTable)}</a>
                    <a class="profile-action-card" href="/archery/"><span aria-hidden="true"></span>${escapeHTML(labels.bookArchery)}</a>
                </div>

                ${renderProfileTabs(labels)}
            </aside>
        `;
    }

    function renderDashboardMetrics(membershipUser, labels) {
        const metrics = [
            { value: formatNumber(membershipUser.points), label: labels.points },
            { value: '฿' + formatBaht(membershipUser.totalSpent), label: labels.totalSpent },
            { value: formatNumber(membershipUser.visitCount), label: labels.visits },
            { value: formatNumber(membershipUser.cartItemCount), label: labels.cartItems }
        ];
        return `
            <div class="stats-grid profile-metric-grid" aria-label="${escapeHTML(labels.overview)}">
                ${metrics.map(metric => `
                    <div class="stat-box profile-metric-card">
                        <div class="stat-value">${escapeHTML(metric.value)}</div>
                        <div class="stat-label">${escapeHTML(metric.label)}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    function timestampMillis(value) {
        if (!value) return 0;
        if (value.toMillis) return value.toMillis();
        if (value.toDate) return value.toDate().getTime();
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 0 : date.getTime();
    }

    function isArcheryBooking(booking = {}) {
        const type = String(booking.service_type || booking.serviceType || booking.bookingType || booking.type || '').toLowerCase();
        return type.includes('archery')
            || Array.isArray(booking.assigned_lane_numbers)
            || Array.isArray(booking.assigned_resource_ids)
            || booking.required_lane_count != null
            || booking.duration_minutes != null
            || booking.package_amount != null;
    }

    function bookingKindLabel(booking, labels) {
        if (isArcheryBooking(booking)) return labels.archeryBooking;
        const bookingType = String(booking.bookingType || booking.booking_type || '').toLowerCase();
        if (bookingType === 'table') return labels.tableBooking;
        if (bookingType === 'room') return labels.roomBooking;
        return labels.generalBooking;
    }

    function bookingTimeText(booking) {
        const date = booking.booking_date || booking.date || '';
        const start = booking.start_time || booking.startTime || booking.arrivalTime || '';
        const end = booking.end_time || booking.endTime || '';
        const range = [start, end].filter(Boolean).join(' - ');
        return [date, range].filter(Boolean).join(' | ') || '-';
    }

    function bookingDetailText(booking) {
        const laneNumbers = Array.isArray(booking.assigned_lane_numbers)
            ? booking.assigned_lane_numbers.map(number => `Lane ${number}`).join(', ')
            : '';
        const laneIds = !laneNumbers && Array.isArray(booking.assigned_resource_ids)
            ? booking.assigned_resource_ids.join(', ')
            : '';
        return [
            laneNumbers || laneIds,
            booking.tableZone || booking.tableNo || booking.roomType || booking.zone || booking.table,
            booking.party_size ? `${booking.party_size} people` : '',
            booking.guests ? `${booking.guests} people` : '',
            booking.duration_minutes ? `${booking.duration_minutes} min` : ''
        ].filter(Boolean).join(' / ');
    }

    function buildHistoryItems(orders, bookings, labels) {
        const orderItems = orders.map(order => {
            const items = Array.isArray(order.items) ? order.items.map(item => item.name || '').filter(Boolean).join(', ') : '';
            const paymentStatus = String(order.paymentStatus || order.payment_status || '').toLowerCase();
            const orderStatus = String(order.status || order.order_status || '').toLowerCase();
            const status = paymentStatus === 'paid' || paymentStatus === 'paid_online' || orderStatus === 'paid' || orderStatus === 'completed'
                ? labels.paid
                : labels.pending;
            return {
                category: 'orders',
                title: `${labels.orderId} ${order.id || '-'}`,
                typeLabel: labels.orders,
                status,
                meta: formatDate(order.date || order.timestamp || order.createdAt),
                detail: items || '-',
                amount: money(order.totalAmount || order.total || 0),
                timestamp: timestampMillis(order.timestamp || order.createdAt || order.date)
            };
        });
        const bookingItems = bookings.map(booking => {
            const archery = isArcheryBooking(booking);
            return {
                category: archery ? 'archery' : 'bookings',
                title: bookingKindLabel(booking, labels),
                typeLabel: archery ? labels.historyArchery : labels.historyBookings,
                status: booking.status || booking.paymentStatus || booking.payment_status || 'confirmed',
                meta: bookingTimeText(booking),
                detail: bookingDetailText(booking) || booking.id || '-',
                amount: booking.total ? money(booking.total) : booking.price || '',
                timestamp: timestampMillis(booking.timestamp || booking.createdAt || booking.booking_date || booking.date)
            };
        });
        return [...orderItems, ...bookingItems].sort((a, b) => b.timestamp - a.timestamp);
    }

    function filteredHistoryItems(items) {
        if (activeHistoryFilter === 'all') return items;
        return items.filter(item => item.category === activeHistoryFilter);
    }

    function renderHistoryFilters(labels) {
        const filterLabels = {
            all: labels.historyAll,
            orders: labels.historyOrders,
            bookings: labels.historyBookings,
            archery: labels.historyArchery
        };
        return `
            <div class="profile-history-filters" role="toolbar" aria-label="${escapeHTML(labels.history)}">
                ${HISTORY_FILTERS.map(filter => `
                    <button
                        class="profile-history-filter ${activeHistoryFilter === filter ? 'active' : ''}"
                        type="button"
                        data-history-filter="${escapeHTML(filter)}"
                        onclick="setProfileHistoryFilter('${escapeHTML(filter)}')">
                        ${escapeHTML(filterLabels[filter])}
                    </button>
                `).join('')}
            </div>
        `;
    }

    function renderHistoryTimeline(items, labels) {
        if (!items.length) {
            return `<div class="profile-empty-state">${escapeHTML(labels.noHistory)}</div>`;
        }
        return `
            <div class="profile-timeline">
                ${items.map(item => `
                    <article class="profile-timeline-item profile-timeline-item--${escapeHTML(item.category)}">
                        <span class="profile-timeline-dot" aria-hidden="true"></span>
                        <div class="profile-timeline-main">
                            <div class="profile-timeline-top">
                                <span>${escapeHTML(item.typeLabel)}</span>
                                <strong>${escapeHTML(item.status)}</strong>
                            </div>
                            <h3>${escapeHTML(item.title)}</h3>
                            <p>${escapeHTML(item.meta)}</p>
                            <small>${escapeHTML(item.detail)}</small>
                            ${item.amount ? `<b>${escapeHTML(item.amount)}</b>` : ''}
                        </div>
                    </article>
                `).join('')}
            </div>
        `;
    }

    function renderOverviewTab(user, labels, membershipUser, tier, historyItems) {
        return `
            <section class="profile-tab-panel" id="profile-tab-overview" role="tabpanel" tabindex="-1">
                <div class="profile-dashboard-head">
                    <span class="profile-kicker">${escapeHTML(labels.dashboardTitle)}</span>
                    <h1>${escapeHTML(labels.overview)}</h1>
                    <p>${escapeHTML(labels.dashboardLead)}</p>
                </div>
                ${renderDashboardMetrics(membershipUser, labels)}
                <div class="profile-overview-grid">
                    ${renderNextTierRequirements(membershipUser, labels)}
                    <details class="membership-panel profile-accordion">
                        <summary>${escapeHTML(labels.benefits)}</summary>
                        ${renderBenefitGrid(tier)}
                    </details>
                </div>
                ${renderHowItWorks(labels)}
                <section class="membership-panel profile-history-preview">
                    <div class="profile-panel-heading">
                        <h2>${escapeHTML(labels.recentActivity)}</h2>
                        <button type="button" class="profile-link-button" onclick="setProfileTab('history')">${escapeHTML(labels.showAll)}</button>
                    </div>
                    ${renderHistoryTimeline(historyItems.slice(0, 3), labels)}
                </section>
            </section>
        `;
    }

    function renderPointsTab(labels, membershipUser, tier) {
        return `
            <section class="profile-tab-panel" id="profile-tab-points" role="tabpanel" tabindex="-1">
                ${renderLoyaltyWallet(membershipUser, labels)}
                ${renderTierPreview(tier, labels)}
                ${renderBenefits(tier, labels)}
                ${renderNextTierRequirements(membershipUser, labels)}
            </section>
        `;
    }

    function renderHistoryTab(labels, historyItems) {
        const visibleItems = filteredHistoryItems(historyItems);
        const limitedItems = historyExpanded ? visibleItems : visibleItems.slice(0, 5);
        const hasMore = visibleItems.length > 5;
        return `
            <section class="profile-tab-panel" id="profile-tab-history" role="tabpanel" tabindex="-1">
                <div class="profile-panel-heading">
                    <div>
                        <span class="profile-kicker">${escapeHTML(labels.history)}</span>
                        <h2>${escapeHTML(labels.recentActivity)}</h2>
                    </div>
                </div>
                ${renderHistoryFilters(labels)}
                ${renderHistoryTimeline(limitedItems, labels)}
                ${hasMore ? `
                    <button class="btn btn-outline profile-history-more" type="button" onclick="toggleProfileHistoryExpanded()">
                        ${escapeHTML(historyExpanded ? labels.showLess : labels.showAll)}
                    </button>
                ` : ''}
            </section>
        `;
    }

    function renderAccountTab(user, labels) {
        return `
            <section class="profile-tab-panel" id="profile-tab-account" role="tabpanel" tabindex="-1">
                <div class="profile-panel-heading">
                    <div>
                        <span class="profile-kicker">${escapeHTML(labels.account)}</span>
                        <h2>${escapeHTML(labels.editableInfo)}</h2>
                    </div>
                </div>
                ${renderProfileForm(user, labels)}
            </section>
        `;
    }

    function renderActiveProfilePanel(user, labels, membershipUser, tier, historyItems) {
        if (activeProfileTab === 'points') return renderPointsTab(labels, membershipUser, tier);
        if (activeProfileTab === 'history') return renderHistoryTab(labels, historyItems);
        if (activeProfileTab === 'account') return renderAccountTab(user, labels);
        return renderOverviewTab(user, labels, membershipUser, tier, historyItems);
    }

    function renderMemberIdentity(user, labels) {
        const en = isEnglishPage();
        const displayName = profileValue('displayName', profileValue('display_name', user.name || labels.member)) || labels.member;
        const phone = profileValue('phone', profileValue('phone_display', user.phone || user.phoneNumber || ''));
        const email = profileValue('email', user.email || '');
        const avatar = profileValue('photoURL', profileValue('avatar_url', user.avatar || 'Images/Logo.webp')) || 'Images/Logo.webp';
        const memberLevel = profileValue('member_level', profileValue('tier', 'Silver')) || 'Silver';
        const points = Number(profileValue('points', user.points || 0)) || 0;
        const createdAt = profileValue('created_at', profileValue('createdAt', ''));
        const rows = [
            { label: en ? 'Phone number' : 'เบอร์โทรศัพท์', value: phone || '-' },
            { label: en ? 'Email' : 'อีเมล', value: email || (en ? 'No email added yet' : 'ยังไม่ได้เพิ่มอีเมล') },
            { label: en ? 'Display name' : 'ชื่อผู้ใช้', value: displayName || (en ? 'Eden Member' : 'สมาชิก Eden') },
            { label: en ? 'Member level' : 'ระดับสมาชิก', value: memberLevel },
            { label: en ? 'Reward points' : 'คะแนนสะสม', value: formatNumber(points) },
            { label: en ? 'Member since' : 'วันที่สมัครสมาชิก', value: formatDate(createdAt) }
        ];

        return `
            <section class="profile-identity-card" aria-label="${escapeHTML(en ? 'Member profile' : 'ข้อมูลสมาชิก')}">
                <img src="${escapeHTML(avatar)}" alt="Profile" class="profile-identity-avatar">
                <div class="profile-identity-main">
                    <p class="profile-kicker">${escapeHTML(en ? 'Eden member' : 'สมาชิก Eden')}</p>
                    <h2>${escapeHTML(displayName || (en ? 'Eden Member' : 'สมาชิก Eden'))}</h2>
                    <div class="profile-identity-grid">
                        ${rows.map(row => `
                            <div>
                                <span>${escapeHTML(row.label)}</span>
                                <strong>${escapeHTML(row.value)}</strong>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </section>
        `;
    }

    function renderProfileForm(user, labels) {
        const phone = profileValue('phone', user.phone || '');
        const shippingAddress = profileValue('shippingAddress', user.shippingAddress || user.address || '');
        const birthDate = profileValue('birthDate', '');
        const allergies = profileValue('allergies', '');
        const healthNote = profileValue('healthNote', '');
        const lineId = profileValue('lineId', '');
        const displayName = profileValue('displayName', user.name || labels.member);
        const email = profileValue('email', publicEmail(user.email || ''));
        const avatar = profileValue('photoURL', user.avatar || user.photoURL || 'Images/Logo.webp');
        const loadingText = cloudProfileLoading ? `<p class="profile-save-message">${escapeHTML(labels.loadingProfile)}</p>` : '';
        const emailVerified = !!email && cloudProfile?.emailVerified === true && cleanString(cloudProfile?.email, 180).toLowerCase() === cleanString(email, 180).toLowerCase();
        const emailStatusClass = emailVerified ? 'is-verified' : 'is-unverified';
        const emailStatusText = emailVerified ? labels.emailVerified : labels.emailUnverified;

        return `
            <div class="profile-account-card">
                <div class="profile-account-top">
                    <img src="${escapeHTML(avatar)}" alt="Profile" class="profile-account-avatar">
                    <div>
                        <span class="profile-kicker">${escapeHTML(labels.googleInfo)}</span>
                        <h3>${escapeHTML(displayName || labels.member)}</h3>
                        <p>${escapeHTML(email || labels.notProvided)}</p>
                    </div>
                </div>
                ${loadingText}
                <form class="profile-edit-form" id="member-profile-form" onsubmit="return saveMemberProfile(event)">
                    <div class="profile-form-grid">
                        <label>
                            <span>${escapeHTML(labels.email)}</span>
                            <input name="email" type="email" autocomplete="email" maxlength="180" value="${escapeHTML(email)}" placeholder="name@example.com">
                        </label>
                        <div class="profile-email-verify profile-form-full ${emailStatusClass}">
                            <div>
                                <strong>${escapeHTML(labels.emailVerification)}</strong>
                                <span>${escapeHTML(emailStatusText)}</span>
                                <small>${escapeHTML(labels.emailOptional)}</small>
                            </div>
                            <div class="profile-email-actions">
                                <button class="btn btn-outline" type="button" onclick="sendMemberEmailVerificationCode()" ${emailVerificationBusy ? 'disabled' : ''}>${escapeHTML(emailVerificationBusy ? labels.sendingEmailCode : labels.sendEmailCode)}</button>
                                <input name="emailCode" type="text" inputmode="numeric" maxlength="6" placeholder="${escapeHTML(labels.emailCodePlaceholder)}" aria-label="${escapeHTML(labels.emailCode)}">
                                <button class="btn" type="button" onclick="verifyMemberEmailCode()" ${emailVerificationBusy ? 'disabled' : ''}>${escapeHTML(emailVerificationBusy ? labels.verifyingEmailCode : labels.verifyEmailCode)}</button>
                            </div>
                        </div>
                        <label>
                            <span>${escapeHTML(labels.phone)}</span>
                            <input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" value="${escapeHTML(phone)}" placeholder="${escapeHTML(labels.phonePlaceholder)}">
                        </label>
                        <label>
                            <span>${escapeHTML(labels.lineId)}</span>
                            <input name="lineId" type="text" autocomplete="off" maxlength="80" value="${escapeHTML(lineId)}" placeholder="${escapeHTML(labels.linePlaceholder)}">
                        </label>
                        <label>
                            <span>${escapeHTML(labels.birthDate)}</span>
                            <input name="birthDate" type="date" value="${escapeHTML(birthDate)}" aria-label="${escapeHTML(labels.birthPlaceholder)}">
                        </label>
                        <label>
                            <span>${escapeHTML(labels.allergies)}</span>
                            <input name="allergies" type="text" maxlength="200" value="${escapeHTML(allergies)}" placeholder="${escapeHTML(labels.allergiesPlaceholder)}">
                        </label>
                        <label class="profile-form-full">
                            <span>${escapeHTML(labels.shippingAddress)}</span>
                            <textarea name="shippingAddress" maxlength="500" rows="3" placeholder="${escapeHTML(labels.addressPlaceholder)}">${escapeHTML(shippingAddress)}</textarea>
                        </label>
                        <label class="profile-form-full">
                            <span>${escapeHTML(labels.healthNote)}</span>
                            <textarea name="healthNote" maxlength="500" rows="3" placeholder="${escapeHTML(labels.healthPlaceholder)}">${escapeHTML(healthNote)}</textarea>
                        </label>
                    </div>
                    <p class="profile-privacy-note">${escapeHTML(labels.privacyNote)}</p>
                    <div class="profile-form-actions">
                        <button class="btn" type="submit" ${cloudProfileSaving ? 'disabled' : ''}>${escapeHTML(cloudProfileSaving ? labels.saving : labels.save)}</button>
                        <button class="btn btn-outline" type="button" onclick="resetMemberProfileForm()">${escapeHTML(labels.reset)}</button>
                    </div>
                    <p class="profile-save-message" id="profile-save-message" aria-live="polite"></p>
                </form>
            </div>
        `;
    }

    function renderSignedIn(container, user, labels) {
        const orders = cloudOrders || readOrders();
        const bookings = cloudBookings || readBookings();
        const membershipUser = buildMembershipUser(user, orders, bookings);
        const tier = getMemberTier(membershipUser);
        const avatar = profileValue('photoURL', user.avatar || user.photoURL || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(user.name || labels.member) + '&background=4caf50&color=fff');
        const displayName = profileValue('displayName', user.name || labels.member);
        const email = profileValue('email', user.email || '');
        const historyItems = buildHistoryItems(orders, bookings, labels);
        if (!PROFILE_TABS.includes(activeProfileTab)) activeProfileTab = 'overview';
        if (!HISTORY_FILTERS.includes(activeHistoryFilter)) activeHistoryFilter = 'all';

        container.innerHTML = `
            <div class="profile-layout profile-dashboard">
                ${renderProfileSummary(user, labels, membershipUser, tier, avatar, displayName, email)}
                <section class="profile-main profile-dashboard-main">
                    ${renderActiveProfilePanel(user, labels, membershipUser, tier, historyItems)}
                </section>
            </div>
        `;
        refreshLoyaltyData(user);
        refreshCloudProfile(user);
        refreshCloudHistory(user);
    }

    function showSaveMessage(message, isError = false) {
        const el = document.getElementById('profile-save-message');
        if (!el) return;
        el.textContent = message;
        el.style.color = isError ? '#b42318' : 'var(--primary-color)';
    }

    function setProfileSavingState(form, isSaving, labels) {
        const submitBtn = form?.querySelector('button[type="submit"]');
        if (!submitBtn) return;
        submitBtn.disabled = isSaving;
        submitBtn.textContent = isSaving ? labels.saving : labels.save;
    }

    async function profileApiRequest(path, body) {
        if (!auth?.currentUser) throw new Error('Sign in required');
        const response = await fetch(FUNCTIONS_BASE_URL + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + await auth.currentUser.getIdToken()
            },
            body: JSON.stringify(body || {})
        });
        let data = {};
        try {
            data = await response.json();
        } catch (_) {
            data = {};
        }
        if (!response.ok) {
            const error = new Error(data.error || 'Request failed');
            error.userMessage = true;
            error.status = response.status;
            throw error;
        }
        return data;
    }

    function getProfileFormEmail() {
        const form = document.getElementById('member-profile-form');
        const email = cleanString(form?.querySelector('input[name="email"]')?.value, 180).toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            const error = new Error(isEnglishPage() ? 'Please enter a valid email first.' : 'กรุณากรอกอีเมลให้ถูกต้องก่อน');
            error.userMessage = true;
            throw error;
        }
        return email;
    }

    async function sendMemberEmailVerificationCode() {
        const labels = getLabels();
        if (emailVerificationBusy) return false;
        emailVerificationBusy = true;
        showSaveMessage(labels.sendingEmailCode);
        let finalMessage = labels.emailCodeSent;
        let finalError = false;
        try {
            const email = getProfileFormEmail();
            await profileApiRequest('/sendEmailVerificationCode', { email });
        } catch (error) {
            logClientError('Email verification send failed:', error);
            finalMessage = error?.userMessage ? error.message : labels.emailCodeFailed;
            finalError = true;
        } finally {
            emailVerificationBusy = false;
            renderProfile();
            requestAnimationFrame(() => showSaveMessage(finalMessage, finalError));
        }
        return false;
    }

    async function verifyMemberEmailCode() {
        const labels = getLabels();
        if (emailVerificationBusy) return false;
        const form = document.getElementById('member-profile-form');
        const code = cleanString(form?.querySelector('input[name="emailCode"]')?.value, 6);
        if (!/^\d{6}$/.test(code)) {
            showSaveMessage(isEnglishPage() ? 'Please enter the 6-digit code.' : 'กรุณากรอกรหัส 6 หลัก', true);
            return false;
        }

        emailVerificationBusy = true;
        showSaveMessage(labels.verifyingEmailCode);
        let finalMessage = labels.emailCodeVerified;
        let finalError = false;
        try {
            const email = getProfileFormEmail();
            const result = await profileApiRequest('/verifyEmailCode', { email, code });
            cloudProfile = { ...(cloudProfile || {}), email, emailVerified: true, emailVerifiedAt: result.emailVerifiedAt || new Date().toISOString() };
            const user = readUser() || {};
            localStorage.setItem(USER_KEY, JSON.stringify({
                ...user,
                email,
                emailVerified: true,
                emailVerifiedAt: result.emailVerifiedAt || new Date().toISOString()
            }));
        } catch (error) {
            logClientError('Email verification failed:', error);
            finalMessage = error?.userMessage ? error.message : labels.emailCodeFailed;
            finalError = true;
        } finally {
            emailVerificationBusy = false;
            renderProfile();
            requestAnimationFrame(() => showSaveMessage(finalMessage, finalError));
        }
        return false;
    }

    async function saveMemberProfile(event) {
        event.preventDefault();
        const labels = getLabels();
        const user = readUser();
        const form = event.currentTarget;
        if (cloudProfileSaving) return false;
        if (!db || !user?.uid) {
            showSaveMessage(labels.saveFailed, true);
            return false;
        }
        const formData = new FormData(form);
        const email = cleanString(formData.get('email'), 180).toLowerCase();
        const previousEmail = cleanString(cloudProfile?.email, 180).toLowerCase();
        const payload = {
            uid: user.uid,
            displayName: cleanString(user.name || currentAuthUser?.displayName || labels.member, 120),
            email,
            photoURL: cleanString(user.avatar || currentAuthUser?.photoURL || '', 500),
            phone: cleanString(formData.get('phone'), 40),
            shippingAddress: cleanString(formData.get('shippingAddress'), 500),
            birthDate: cleanString(formData.get('birthDate'), 20),
            allergies: cleanString(formData.get('allergies'), 200),
            healthNote: cleanString(formData.get('healthNote'), 500),
            lineId: cleanString(formData.get('lineId'), 80),
            updatedAt: serverTimestamp()
        };
        if (email !== previousEmail) {
            payload.emailVerified = false;
            payload.emailVerifiedAt = null;
        }

        cloudProfileSaving = true;
        setProfileSavingState(form, true, labels);
        showSaveMessage(labels.saving);
        try {
            await setDoc(doc(db, 'users', user.uid), payload, { merge: true });
            cloudProfile = { ...(cloudProfile || {}), ...payload };
            cloudProfileUid = user.uid;
            const mergedUser = {
                ...user,
                phone: payload.phone,
                email: payload.email,
                shippingAddress: payload.shippingAddress,
                address: payload.shippingAddress,
                lineId: payload.lineId
            };
            localStorage.setItem(USER_KEY, JSON.stringify(mergedUser));
            showSaveMessage(labels.saved);
        } catch (error) {
            logClientError('Profile save failed:', error);
            const message = error?.code === 'permission-denied'
                ? (isEnglishPage() ? 'Unable to save profile because profile permissions are not ready. Please try again after refresh.' : 'บันทึกไม่สำเร็จ: สิทธิ์โปรไฟล์ยังไม่พร้อม กรุณารีเฟรชแล้วลองใหม่อีกครั้ง')
                : labels.saveFailed;
            showSaveMessage(message, true);
        } finally {
            cloudProfileSaving = false;
            setProfileSavingState(form, false, labels);
        }
        return false;
    }

    function resetMemberProfileForm() {
        renderProfile();
    }

    function previewMemberTier(tier) {
        if (!['Silver', 'Gold', 'Platinum'].includes(tier)) return;
        selectedPreviewTier = tier;
        renderProfile();
        requestAnimationFrame(() => {
            document.querySelector('.tier-preview-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    }

    function renderProfile() {
        const container = document.getElementById('profile-content');
        if (!container) return;
        const labels = getLabels();
        const user = readUser();
        if (!user || !user.uid) {
            if (authStateResolved) {
                window.location.href = '/login';
                return;
            }
            renderSignedOut(container, labels);
            return;
        }
        if (user.passwordLoginEnabled === false || user.password_login_enabled === false) {
            redirectToPasswordSetup();
            return;
        }
        if (authStateResolved && currentAuthUser && !cloudProfile && cloudProfileUid !== user.uid) {
            container.innerHTML = `<div class="profile-loading"><p>${escapeHTML(labels.loadingProfile)}</p></div>`;
            refreshCloudProfile(user);
            return;
        }
        renderSignedIn(container, user, labels);
    }

    window.renderProfile = renderProfile;
    window.saveMemberProfile = saveMemberProfile;
    window.resetMemberProfileForm = resetMemberProfileForm;
    window.previewMemberTier = previewMemberTier;
    window.setProfileTab = setProfileTab;
    window.setProfileHistoryFilter = setProfileHistoryFilter;
    window.toggleProfileHistoryExpanded = toggleProfileHistoryExpanded;
    window.sendMemberEmailVerificationCode = sendMemberEmailVerificationCode;
    window.verifyMemberEmailCode = verifyMemberEmailCode;

    document.addEventListener('DOMContentLoaded', () => {
        renderProfile();
        if (auth) {
            onAuthStateChanged(auth, user => {
                authStateResolved = true;
                currentAuthUser = user;
                if (!user) {
                    localStorage.removeItem(USER_KEY);
                    window.location.href = '/login';
                    return;
                }
                cloudOrders = null;
                cloudBookings = null;
                cloudHistoryUid = '';
                cloudProfile = null;
                cloudProfileUid = '';
                loyaltyConfig = null;
                loyaltyLedger = [];
                loyaltySummary = null;
                loyaltyUid = '';
                renderProfile();
            });
        }
    });

    window.addEventListener('storage', renderProfile);
    window.addEventListener('eden:user-changed', () => {
        cloudOrders = null;
        cloudBookings = null;
        cloudHistoryUid = '';
        cloudProfile = null;
        cloudProfileUid = '';
        loyaltyConfig = null;
        loyaltyLedger = [];
        loyaltySummary = null;
        loyaltyUid = '';
        renderProfile();
    });
})();
