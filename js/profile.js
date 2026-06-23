import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMemberTier, getNextTierProgress, getTierBenefits, getTierTheme, getTierRules } from './membership.js';
import {
    getMyProfile,
    profileToStoredUser,
    requestPhoneChangeOtp,
    updateMyProfile,
    verifyPhoneChangeOtp
} from './member-auth-service.js';
import { clearSkeleton, renderSkeleton } from './ui-skeleton.js';

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
    let cloudProfileError = '';
    let profileEditing = false;
    let emailVerificationBusy = false;
    let emailVerificationCooldownUntil = 0;
    let emailVerificationState = {
        email: ''
    };
    let phoneVerificationBusy = false;
    let phoneVerificationCooldownUntil = 0;
    let phoneVerificationState = {
        verificationId: '',
        phoneNumber: '',
        phoneDisplay: ''
    };
    let loyaltyConfig = null;
    let loyaltyLedger = [];
    let loyaltySummary = null;
    let loyaltyUid = '';
    let loyaltyLoading = false;
    let currentAuthUser = null;
    let authStateResolved = false;
    let selectedPreviewTier = '';
    let activeProfileTab = 'points';
    let activeHistoryFilter = 'all';
    let historyExpanded = false;
    const PROFILE_TABS = ['points', 'history', 'account'];
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

    function normalizeShippingAddressStructured(value = {}, fallbackText = '') {
        const source = value && typeof value === 'object' ? value : {};
        const normalized = {
            addressLine: cleanString(source.addressLine || source.address_line || source.line1 || source.address || '', 250),
            subdistrict: cleanString(source.subdistrict || source.subdistrictName || source.subdistrict_name || '', 80),
            district: cleanString(source.district || source.districtName || source.district_name || '', 80),
            province: cleanString(source.province || source.provinceName || source.province_name || '', 80),
            zipcode: cleanString(source.zipcode || source.postalCode || source.postal_code || source.zip || '', 10)
        };
        if (!Object.values(normalized).some(Boolean) && fallbackText) {
            normalized.addressLine = cleanString(fallbackText, 250);
        }
        return normalized;
    }

    function formatShippingAddress(address = {}) {
        return [
            address.addressLine,
            address.subdistrict,
            address.district,
            address.province,
            address.zipcode
        ].map(part => cleanString(part, 250)).filter(Boolean).join(', ');
    }

    function profileShippingAddress(user = {}) {
        const fallbackText = profileValue('shippingAddress', user.shippingAddress || user.address || '');
        const structured = profileValue(
            'shippingAddressStructured',
            profileValue('shipping_address_structured', user.shippingAddressStructured || user.shipping_address_structured || user)
        );
        return normalizeShippingAddressStructured(structured, fallbackText);
    }

    function cooldownSeconds(until) {
        return Math.max(0, Math.ceil((Number(until || 0) - Date.now()) / 1000));
    }

    function cooldownMinutes(until) {
        return Math.max(1, Math.ceil(cooldownSeconds(until) / 60));
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
            refreshLoyalty: 'Refresh points',
            refreshingLoyalty: 'Refreshing...',
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
            firstName: 'First name',
            lastName: 'Last name',
            email: 'Email',
            emailVerification: 'Email verification',
            emailVerified: 'Verified',
            emailUnverified: 'Not verified',
            emailOptional: 'We will send a 6-digit code to this email. After verification, you can use this email with your existing password.',
            emailVerifiedLocked: 'Email verified. No extra action is needed.',
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
            phoneVerification: 'Phone verification',
            phoneVerified: 'Phone verified',
            phoneUnverified: 'Verify by OTP before changing this number.',
            sendPhoneCode: 'Send OTP',
            phoneCode: 'Phone OTP',
            phoneCodePlaceholder: '123456',
            verifyPhoneCode: 'Verify phone',
            sendingPhoneCode: 'Sending OTP...',
            verifyingPhoneCode: 'Verifying phone...',
            phoneCodeSent: 'OTP sent. Please enter the 6-digit code.',
            phoneCodeVerified: 'Phone number verified successfully.',
            phoneCodeFailed: 'Unable to verify phone right now.',
            verificationCooldown: 'Please wait 5 minutes before requesting another code.',
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

    function historyTimestampMillis(item = {}) {
        const value = item.paidAt || item.closedAt || item.completedAt || item.timestamp || item.createdAt || item.updatedAt || item.date;
        if (value?.toDate) return value.toDate().getTime();
        const parsed = new Date(value || 0).getTime();
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function sortHistoryDesc(items) {
        return items.sort((a, b) => historyTimestampMillis(b) - historyTimestampMillis(a));
    }

    function mapCloudOrder(docSnap) {
        const data = docSnap.data() || {};
        return {
            firestoreId: docSnap.id,
            id: data.id || data.receiptNo || data.orderNumber || docSnap.id,
            ...data
        };
    }

    async function fetchProfileOrdersFromCloud(uid) {
        if (!db || !uid) return [];
        const [customerSnap, legacySnap] = await Promise.all([
            getDocs(query(collection(db, 'orders'), where('customerUid', '==', uid))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'orders'), where('uid', '==', uid))).catch(() => ({ docs: [] }))
        ]);
        const ordersByDocId = new Map();
        [...customerSnap.docs, ...legacySnap.docs].forEach(docSnap => {
            const data = docSnap.data() || {};
            const customerUid = String(data.customerUid || '').trim();
            const orderUid = String(data.uid || '').trim();
            const source = String(data.source || '').toLowerCase();
            if (data.isTestOrder === true) return;
            if (customerUid ? customerUid !== uid : (orderUid !== uid || source === 'pos')) return;
            ordersByDocId.set(docSnap.id, mapCloudOrder(docSnap));
        });
        return sortHistoryDesc(Array.from(ordersByDocId.values())).slice(0, 20);
    }

    async function fetchProfileBookingsFromCloud(uid) {
        if (!db || !uid) return [];
        const [uidSnap, customerSnap, memberSnap] = await Promise.all([
            getDocs(query(collection(db, 'bookings'), where('uid', '==', uid))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'bookings'), where('customerUid', '==', uid))).catch(() => ({ docs: [] })),
            getDocs(query(collection(db, 'bookings'), where('member_id', '==', uid))).catch(() => ({ docs: [] }))
        ]);
        const bookingsByDocId = new Map();
        [...uidSnap.docs, ...customerSnap.docs, ...memberSnap.docs].forEach(docSnap => {
            bookingsByDocId.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
        });
        return sortHistoryDesc(Array.from(bookingsByDocId.values())).slice(0, 20);
    }

    async function refreshCloudHistory(user) {
        if (!user?.uid || cloudHistoryLoading || cloudHistoryUid === user.uid) return;
        const fetchOrders = typeof window.fetchUserOrdersFromCloud === 'function'
            ? window.fetchUserOrdersFromCloud
            : fetchProfileOrdersFromCloud;
        const fetchBookings = typeof window.fetchUserBookingsFromCloud === 'function'
            ? window.fetchUserBookingsFromCloud
            : fetchProfileBookingsFromCloud;
        cloudHistoryLoading = true;
        try {
            const [orders, bookings] = await Promise.all([
                fetchOrders(user.uid),
                fetchBookings(user.uid)
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
            cloudProfileError = '';
            cloudProfile = {
                ...profile,
                displayName: profile.display_name || profile.displayName || 'สมาชิก Eden',
                firstName: profile.firstName || '',
                lastName: profile.lastName || '',
                photoURL: profile.avatar_url || '/Images/Logo.webp',
                phone: profile.phone_display || '',
                phoneE164: profile.phone_number || '',
                phoneVerified: profile.phoneVerified === true || profile.phone_verified === true,
                phoneVerifiedAt: profile.phoneVerifiedAt || profile.phone_verified_at || '',
                shippingAddress: profile.shippingAddress || '',
                shippingAddressStructured: normalizeShippingAddressStructured(
                    profile.shippingAddressStructured || profile.shipping_address_structured || {},
                    profile.shippingAddress || ''
                ),
                birthDate: profile.birthDate || '',
                allergies: profile.allergies || '',
                healthNote: profile.healthNote || '',
                lineId: profile.lineId || '',
                tier: profile.member_level || 'Silver',
                member_level: profile.member_level || 'Silver',
                points: Number(profile.points || 0),
                createdAt: profile.created_at || '',
                updatedAt: profile.updated_at || '',
                lastLoginAt: profile.last_login_at || ''
            };
            localStorage.setItem(USER_KEY, JSON.stringify(profileToStoredUser(profile)));
            cloudProfileUid = user.uid;
        } catch (error) {
            logClientError('Unable to load member profile:', error);
            cloudProfileError = profileLoadFailedMessage();
            cloudProfile = {
                ...(cloudProfile || {}),
                ...buildProfileFallback(user)
            };
            cloudProfileUid = user.uid;
        } finally {
            cloudProfileLoading = false;
            if (cloudProfileUid === user.uid) renderProfile();
        }
    }

    async function refreshLoyaltyData(user, options = {}) {
        const force = options.force === true;
        if (!db || !user?.uid || loyaltyLoading || (!force && loyaltyUid === user.uid)) return;
        loyaltyLoading = true;
        if (force) renderProfile();
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

    async function refreshProfileLoyalty() {
        const user = readUser();
        if (!user?.uid) return;
        loyaltyUid = '';
        await refreshLoyaltyData(user, { force: true });
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

    function profileLoadFailedMessage() {
        return isEnglishPage()
            ? 'Unable to load saved profile. Showing your current session details.'
            : 'โหลดข้อมูลโปรไฟล์ไม่สำเร็จ กำลังแสดงข้อมูลจากเซสชันปัจจุบัน';
    }

    function buildProfileFallback(user = {}) {
        const displayName = user.name || currentAuthUser?.displayName || 'Eden Member';
        return {
            uid: user.uid || currentAuthUser?.uid || '',
            displayName,
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            email: user.email || '',
            photoURL: user.avatar || user.photoURL || currentAuthUser?.photoURL || '/Images/Logo.webp',
            phone: user.phone || '',
            phoneE164: user.phoneNumber || '',
            phoneVerified: user.phoneVerified === true,
            phoneVerifiedAt: user.phoneVerifiedAt || '',
            shippingAddress: user.shippingAddress || user.address || '',
            shippingAddressStructured: normalizeShippingAddressStructured(
                user.shippingAddressStructured || user.shipping_address_structured || user,
                user.shippingAddress || user.address || ''
            ),
            birthDate: user.birthDate || '',
            allergies: user.allergies || '',
            healthNote: user.healthNote || '',
            lineId: user.lineId || '',
            tier: user.memberLevel || user.member_level || 'Silver',
            member_level: user.memberLevel || user.member_level || 'Silver',
            points: Number(user.points || 0),
            password_login_enabled: true,
            passwordLoginEnabled: true
        };
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
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                    <h2 style="margin:0;">${escapeHTML(labels.loyaltyWallet)}</h2>
                    <button class="btn btn-outline" type="button" onclick="refreshProfileLoyalty()" ${loyaltyLoading ? 'disabled' : ''}>${escapeHTML(loyaltyLoading ? (labels.refreshingLoyalty || 'Refreshing...') : (labels.refreshLoyalty || 'Refresh points'))}</button>
                </div>
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
                <img src="/Images/Logo.webp" alt="Eden Cafe" style="width:84px;height:84px;border-radius:50%;object-fit:cover;margin-bottom:18px;">
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
            const orderStatus = String(order.billStatus || order.status || order.order_status || '').toLowerCase();
            const status = paymentStatus === 'paid' || paymentStatus === 'paid_online' || orderStatus === 'paid' || orderStatus === 'completed'
                ? labels.paid
                : labels.pending;
            const displayId = order.receiptNo || order.orderNumber || order.id || order.firestoreId || '-';
            const orderDate = order.paidAt || order.closedAt || order.completedAt || order.timestamp || order.createdAt || order.date || order.updatedAt;
            const total = order.totalAmount ?? order.payableTotal ?? order.totalBeforeLoyalty ?? order.total ?? order.netTotal ?? 0;
            return `
                <div class="order-card">
                    <div class="order-card-header">
                        <strong>${escapeHTML(labels.orderId)} ${escapeHTML(displayId)}</strong>
                        <span style="color:var(--primary-color);font-weight:600;">${escapeHTML(status)}</span>
                    </div>
                    <p style="margin:0 0 8px;color:#666;">${formatDate(orderDate)}</p>
                    <p style="margin:0 0 8px;">${escapeHTML(labels.items)}: ${items.map(item => escapeHTML(item.name || '')).join(', ') || '-'}</p>
                    <strong>${escapeHTML(labels.total)}: ${money(total)}</strong>
                </div>
            `;
        }).join('');
    }

    function bookingServiceLabel(booking) {
        const serviceType = String(booking.service_type || booking.serviceType || '').toUpperCase();
        if (serviceType === 'ARCHERY') return 'Eden Archery';
        const bookingType = String(booking.bookingType || '').toLowerCase();
        if (bookingType === 'room') return isEnglishPage() ? 'Private room' : 'ห้องรับรอง';
        if (bookingType === 'table') return isEnglishPage() ? 'Table booking' : 'จองโต๊ะ';
        return isEnglishPage() ? 'Booking' : 'การจอง';
    }

    function bookingStatusLabel(booking) {
        const serviceType = String(booking.service_type || booking.serviceType || '').toUpperCase();
        if (serviceType === 'ARCHERY') {
            const status = String(booking.booking_status || booking.status || '').toUpperCase();
            const payment = String(booking.payment_status || booking.paymentStatus || '').toUpperCase();
            if (payment === 'REFUNDED') return 'Refunded';
            if (status === 'CONFIRMED') return 'Confirmed';
            if (status === 'CHECKED_IN') return 'Checked-in';
            if (status === 'COMPLETED') return 'Completed';
            if (status === 'CANCELLED') return 'Cancelled';
            if (status === 'NO_SHOW') return 'No Show';
            if (payment === 'PAID_ONLINE') return 'Paid Online';
            if (payment === 'PAID_COUNTER') return 'Paid Counter';
            if (status === 'HELD') return 'Held';
            return 'Pending';
        }
        return booking.status || 'confirmed';
    }

    function bookingDetailLine(booking) {
        const serviceType = String(booking.service_type || booking.serviceType || '').toUpperCase();
        if (serviceType === 'ARCHERY') {
            const duration = booking.duration_minutes || booking.package_minutes || String(booking.package_code || '').replace(/\D/g, '');
            return [
                booking.booking_date || booking.date,
                [booking.startTime || booking.start_time, booking.endTime || booking.end_time].filter(Boolean).join('-'),
                duration ? duration + ' min' : '',
                booking.paymentLabel || booking.payment_status || ''
            ].filter(Boolean).join(' | ');
        }
        return [booking.date, booking.time || booking.arrivalTime || booking.startTime, booking.tableIds || booking.table || booking.zone || booking.tableZone].filter(Boolean).join(' | ');
    }

    function isArcheryBooking(booking) {
        return String(booking.service_type || booking.serviceType || '').toUpperCase() === 'ARCHERY';
    }

    function archeryBookingMillis(booking) {
        const date = booking.booking_date || booking.date || '';
        const time = booking.start_time || booking.startTime || '00:00';
        const parsed = new Date(`${date}T${time}:00+07:00`).getTime();
        return Number.isFinite(parsed) ? parsed : itemTimestampMillis(booking);
    }

    function archeryBookingGroups(bookings) {
        const archeryBookings = bookings.filter(isArcheryBooking);
        const now = Date.now();
        const closedStatuses = new Set(['COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED']);
        const upcoming = archeryBookings
            .filter(booking => !closedStatuses.has(String(booking.booking_status || booking.status || '').toUpperCase()))
            .filter(booking => archeryBookingMillis(booking) >= now)
            .sort((a, b) => archeryBookingMillis(a) - archeryBookingMillis(b));
        const history = archeryBookings
            .filter(booking => !upcoming.some(item => item.id === booking.id))
            .sort((a, b) => archeryBookingMillis(b) - archeryBookingMillis(a));
        return { upcoming, history };
    }

    function renderArcheryBookingCard(booking) {
        const detail = bookingDetailLine(booking);
        return `
            <div class="order-card">
                <div class="order-card-header">
                    <strong>Eden Archery #${escapeHTML(booking.id || booking.booking_id || '-')}</strong>
                    <span style="color:var(--primary-color);font-weight:600;">${escapeHTML(bookingStatusLabel(booking))}</span>
                </div>
                <p style="margin:0;color:#666;">${escapeHTML(detail)}</p>
            </div>
        `;
    }

    function renderArcheryBookingSections(bookings) {
        const { upcoming, history } = archeryBookingGroups(bookings);
        return `
            <div class="order-history" id="profile-archery-bookings">
                <h2>Upcoming Archery Booking</h2>
                ${upcoming.length ? upcoming.map(renderArcheryBookingCard).join('') : '<p style="color:#777;">ยังไม่มีรายการยิงธนูที่กำลังจะมาถึง</p>'}
                <h2 style="margin-top:28px;">Archery Booking History</h2>
                ${history.length ? history.map(renderArcheryBookingCard).join('') : '<p style="color:#777;">ยังไม่มีประวัติการจองยิงธนู</p>'}
            </div>
        `;
    }

    function renderBookingList(bookings, labels) {
        if (!bookings.length) return `<p style="color:#777;">${escapeHTML(labels.noBookings)}</p>`;
        return bookings.map(booking => `
            <div class="order-card">
                <div class="order-card-header">
                    <strong>${escapeHTML(bookingServiceLabel(booking))} #${escapeHTML(booking.id || booking.date || '-')}</strong>
                    <span style="color:var(--primary-color);font-weight:600;">${escapeHTML(bookingStatusLabel(booking))}</span>
                </div>
                <p style="margin:0;color:#666;">${escapeHTML(bookingDetailLine(booking))}</p>
            </div>
        `).join('');
    }

    function profileTabLabel(tab, labels) {
        return {
            points: labels.pointsTab,
            history: labels.history,
            account: labels.account
        }[tab] || labels.pointsTab;
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
                    </div>
                    <div class="profile-mini-card" aria-label="${escapeHTML(labels.memberCard)}">
                        <div>
                            <strong>${escapeHTML(displayName || labels.member)}</strong>
                            <span>${escapeHTML(membershipUser.memberCode || memberId(user))}</span>
                            <span>UID: ${escapeHTML(user.uid || membershipUser.id || '-')}</span>
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

    function renderPointsTab(labels, membershipUser, tier) {
        return `
            <section class="profile-tab-panel" id="profile-tab-points" role="tabpanel" tabindex="-1">
                ${renderLoyaltyWallet(membershipUser, labels)}
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
        return renderPointsTab(labels, membershipUser, tier);
    }

    function renderMemberIdentity(user, labels) {
        const en = isEnglishPage();
        const displayName = profileValue('displayName', profileValue('display_name', user.name || labels.member)) || labels.member;
        const phone = profileValue('phone', profileValue('phone_display', user.phone || user.phoneNumber || ''));
        const email = profileValue('email', user.email || '');
        const avatar = profileValue('photoURL', profileValue('avatar_url', user.avatar || '/Images/Logo.webp')) || '/Images/Logo.webp';
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
        const storedPhone = profileValue('phone', user.phone || '');
        const phone = phoneVerificationState.phoneDisplay || storedPhone;
        const firstName = profileValue('firstName', user.firstName || '');
        const lastName = profileValue('lastName', user.lastName || '');
        const shippingAddress = profileShippingAddress(user);
        const birthDate = profileValue('birthDate', '');
        const allergies = profileValue('allergies', '');
        const healthNote = profileValue('healthNote', '');
        const lineId = profileValue('lineId', '');
        const displayName = profileValue('displayName', [firstName, lastName].filter(Boolean).join(' ') || user.name || labels.member);
        const storedEmail = profileValue('email', publicEmail(user.email || ''));
        const email = emailVerificationState.email || storedEmail;
        const avatar = profileValue('photoURL', user.avatar || user.photoURL || '/Images/Logo.webp');
        const loadingText = cloudProfileLoading ? `<p class="profile-save-message">${escapeHTML(labels.loadingProfile)}</p>` : '';
        const isEditing = profileEditing === true;
        const formStateClass = isEditing ? 'is-editing' : 'is-readonly';
        const readOnlyAttr = isEditing ? '' : 'readonly aria-readonly="true"';
        const editProfileLabel = labels.editProfile || (isEnglishPage() ? 'Edit profile' : '\u0e41\u0e01\u0e49\u0e44\u0e02\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25');
        const editToVerifyLabel = labels.editToVerify || (isEnglishPage() ? 'Edit profile to change or verify this information.' : '\u0e01\u0e14\u0e41\u0e01\u0e49\u0e44\u0e02\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e40\u0e1e\u0e37\u0e48\u0e2d\u0e40\u0e1b\u0e25\u0e35\u0e48\u0e22\u0e19\u0e2b\u0e23\u0e37\u0e2d\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19');
        const emailVerified = !emailVerificationState.email && !!email && cloudProfile?.emailVerified === true && cleanString(cloudProfile?.email, 180).toLowerCase() === cleanString(email, 180).toLowerCase();
        const emailStatusClass = emailVerified ? 'is-verified' : 'is-unverified';
        const emailStatusText = emailVerified ? labels.emailVerified : labels.emailUnverified;
        const phoneVerified = !!storedPhone && !phoneVerificationState.verificationId && (cloudProfile?.phoneVerified === true || !!cloudProfile?.phoneVerifiedAt || !!cloudProfile?.phoneE164);
        const phoneStatusClass = phoneVerified ? 'is-verified' : 'is-unverified';
        const phoneStatusText = phoneVerified ? (labels.phoneVerified || 'ยืนยันเบอร์โทรแล้ว') : (labels.phoneUnverified || 'ต้องยืนยัน OTP ก่อนเปลี่ยนเบอร์');
        const pendingPhoneChange = !!phoneVerificationState.verificationId;
        const pendingEmailVerification = !!emailVerificationState.email;
        const emailActionsHidden = !email || (emailVerified && !pendingEmailVerification);
        const phoneActionsHidden = !phone || (phoneVerified && !pendingPhoneChange);
        const emailCooldown = cooldownSeconds(emailVerificationCooldownUntil);
        const phoneCooldown = cooldownSeconds(phoneVerificationCooldownUntil);
        const emailActionLabel = emailCooldown
            ? `${labels.sendEmailCode || 'ส่งโค้ด'} (${cooldownMinutes(emailVerificationCooldownUntil)}m)`
            : (emailVerificationBusy ? labels.sendingEmailCode : labels.sendEmailCode);
        const phoneActionLabel = phoneCooldown
            ? `${labels.sendPhoneCode || 'ส่ง OTP'} (${cooldownMinutes(phoneVerificationCooldownUntil)}m)`
            : (phoneVerificationBusy ? (labels.sendingPhoneCode || 'กำลังส่ง OTP...') : (labels.sendPhoneCode || 'ส่ง OTP'));
        const emailActions = !isEditing
            ? `<p class="profile-privacy-note">${escapeHTML(emailVerified ? (labels.emailVerifiedLocked || 'ยืนยันอีเมลแล้ว ไม่ต้องกดยืนยันซ้ำ') : editToVerifyLabel)}</p>`
            : `<div class="profile-email-actions" id="email-verification-actions" ${emailActionsHidden ? 'hidden' : ''}>
                <button class="btn btn-outline" id="email-verification-request" type="button" onclick="sendMemberEmailVerificationCode()" ${!email || emailVerificationBusy || emailCooldown || (emailVerified && !pendingEmailVerification) ? 'disabled' : ''}>${escapeHTML(emailActionLabel)}</button>
                ${pendingEmailVerification ? `
                    <input name="emailCode" type="text" inputmode="numeric" maxlength="6" placeholder="${escapeHTML(labels.emailCodePlaceholder)}" aria-label="${escapeHTML(labels.emailCode)}">
                    <button class="btn" type="button" onclick="verifyMemberEmailCode()" ${emailVerificationBusy ? 'disabled' : ''}>${escapeHTML(emailVerificationBusy ? labels.verifyingEmailCode : labels.verifyEmailCode)}</button>
                ` : ''}
            </div>`;
        const phoneActions = !isEditing
            ? `<p class="profile-privacy-note">${escapeHTML(phoneVerified ? (labels.phoneVerifiedLocked || 'ยืนยันเบอร์โทรแล้ว ไม่ต้องกดยืนยันซ้ำ') : editToVerifyLabel)}</p>`
            : `<div class="profile-email-actions" id="phone-verification-actions" ${phoneActionsHidden ? 'hidden' : ''}>
                <button class="btn btn-outline" id="phone-change-request" type="button" onclick="sendMemberPhoneVerificationCode()" ${!phone || phoneVerificationBusy || phoneCooldown || (phoneVerified && !pendingPhoneChange) ? 'disabled' : ''}>${escapeHTML(phoneActionLabel)}</button>
                ${pendingPhoneChange ? `
                    <input name="phoneCode" type="text" inputmode="numeric" maxlength="6" placeholder="${escapeHTML(labels.phoneCodePlaceholder || '123456')}" aria-label="${escapeHTML(labels.phoneCode || 'OTP เบอร์โทร')}">
                    <button class="btn" type="button" onclick="verifyMemberPhoneCode()" ${phoneVerificationBusy ? 'disabled' : ''}>${escapeHTML(phoneVerificationBusy ? (labels.verifyingPhoneCode || 'กำลังยืนยันเบอร์...') : (labels.verifyPhoneCode || 'ยืนยันเบอร์'))}</button>
                ` : ''}
            </div>`;

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
                <form class="profile-edit-form ${formStateClass}" id="member-profile-form" onsubmit="return saveMemberProfile(event)">
                    <div class="profile-form-grid">
                        <label>
                            <span>${escapeHTML(labels.firstName || 'ชื่อ')}</span>
                            <input name="firstName" type="text" autocomplete="given-name" maxlength="80" value="${escapeHTML(firstName)}" placeholder="${escapeHTML(labels.firstName || 'ชื่อ')}" ${readOnlyAttr}>
                        </label>
                        <label>
                            <span>${escapeHTML(labels.lastName || 'นามสกุล')}</span>
                            <input name="lastName" type="text" autocomplete="family-name" maxlength="80" value="${escapeHTML(lastName)}" placeholder="${escapeHTML(labels.lastName || 'นามสกุล')}" ${readOnlyAttr}>
                        </label>
                        <label>
                            <span>${escapeHTML(labels.email)}</span>
                            <input name="email" type="email" autocomplete="email" maxlength="180" value="${escapeHTML(email)}" placeholder="name@example.com" oninput="syncEmailVerificationAction()" ${readOnlyAttr}>
                        </label>
                        <div class="profile-email-verify profile-form-full ${emailStatusClass}">
                            <div>
                                <strong>${escapeHTML(labels.emailVerification)}</strong>
                                <span>${escapeHTML(emailStatusText)}</span>
                                <small>${escapeHTML(labels.emailOptional)}</small>
                            </div>
                            ${emailActions}
                        </div>
                        <label>
                            <span>${escapeHTML(labels.phone)}</span>
                            <input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" value="${escapeHTML(phone)}" data-current-phone="${escapeHTML(storedPhone)}" oninput="syncPhoneVerificationAction()" placeholder="${escapeHTML(labels.phonePlaceholder)}" ${readOnlyAttr}>
                        </label>
                        <div class="profile-email-verify profile-form-full ${phoneStatusClass}">
                            <div>
                                <strong>${escapeHTML(labels.phoneVerification || 'ยืนยันเบอร์โทร')}</strong>
                                <span>${escapeHTML(phoneStatusText)}</span>
                                <small>${escapeHTML(labels.phoneUnverified || 'หากเปลี่ยนเบอร์ ต้องยืนยัน OTP ก่อนบันทึกเบอร์ใหม่')}</small>
                            </div>
                            ${phoneActions}
                        </div>
                        <label>
                            <span>${escapeHTML(labels.lineId)}</span>
                            <input name="lineId" type="text" autocomplete="off" maxlength="80" value="${escapeHTML(lineId)}" placeholder="${escapeHTML(labels.linePlaceholder)}" ${readOnlyAttr}>
                        </label>
                        <label>
                            <span>${escapeHTML(labels.birthDate)}</span>
                            <input name="birthDate" type="date" value="${escapeHTML(birthDate)}" aria-label="${escapeHTML(labels.birthPlaceholder)}" ${readOnlyAttr}>
                        </label>
                        <label>
                            <span>${escapeHTML(labels.allergies)}</span>
                            <input name="allergies" type="text" maxlength="200" value="${escapeHTML(allergies)}" placeholder="${escapeHTML(labels.allergiesPlaceholder)}" ${readOnlyAttr}>
                        </label>
                        <label class="profile-form-full">
                            <span>${escapeHTML(labels.addressLine || labels.shippingAddress)}</span>
                            <textarea id="profile-address-line" name="addressLine" autocomplete="street-address" maxlength="250" rows="2" placeholder="${escapeHTML(labels.addressPlaceholder)}" ${readOnlyAttr}>${escapeHTML(shippingAddress.addressLine)}</textarea>
                        </label>
                        <label>
                            <span>${escapeHTML(labels.subdistrict || 'Subdistrict / ตำบล/แขวง')}</span>
                            <input id="profile-subdistrict" name="subdistrict" type="text" autocomplete="off" maxlength="80" value="${escapeHTML(shippingAddress.subdistrict)}" ${readOnlyAttr}>
                        </label>
                        <label>
                            <span>${escapeHTML(labels.district || 'District / อำเภอ/เขต')}</span>
                            <input id="profile-district" name="district" type="text" autocomplete="off" maxlength="80" value="${escapeHTML(shippingAddress.district)}" ${readOnlyAttr}>
                        </label>
                        <label>
                            <span>${escapeHTML(labels.province || 'Province / จังหวัด')}</span>
                            <input id="profile-province" name="province" type="text" autocomplete="off" maxlength="80" value="${escapeHTML(shippingAddress.province)}" ${readOnlyAttr}>
                        </label>
                        <label>
                            <span>${escapeHTML(labels.zipcode || 'Zipcode / รหัสไปรษณีย์')}</span>
                            <input id="profile-zipcode" name="zipcode" type="text" inputmode="numeric" autocomplete="postal-code" maxlength="10" value="${escapeHTML(shippingAddress.zipcode)}" ${readOnlyAttr}>
                        </label>
                        <label class="profile-form-full">
                            <span>${escapeHTML(labels.healthNote)}</span>
                            <textarea name="healthNote" maxlength="500" rows="3" placeholder="${escapeHTML(labels.healthPlaceholder)}" ${readOnlyAttr}>${escapeHTML(healthNote)}</textarea>
                        </label>
                    </div>
                    <p class="profile-privacy-note">${escapeHTML(labels.privacyNote)}</p>
                    <div class="profile-form-actions">
                        ${isEditing ? `
                            <button class="btn" type="submit" ${cloudProfileSaving ? 'disabled' : ''}>${escapeHTML(cloudProfileSaving ? labels.saving : labels.save)}</button>
                            <button class="btn btn-outline" type="button" onclick="resetMemberProfileForm()">${escapeHTML(labels.reset)}</button>
                        ` : `
                            <button class="btn" type="button" onclick="setProfileEditing(true)">${escapeHTML(editProfileLabel)}</button>
                        `}
                    </div>
                    <p class="profile-save-message" id="profile-save-message" aria-live="polite"></p>
                </form>
            </div>
        `;
    }

    function initProfileAddressAutocomplete() {
        const initAddress = window.EdenAddressAutocomplete?.init || window.initAddressAutocomplete;
        if (typeof initAddress !== 'function') return;
        initAddress({
            subdistrict: '#profile-subdistrict',
            district: '#profile-district',
            province: '#profile-province',
            zipcode: '#profile-zipcode'
        });
    }

    function renderSignedIn(container, user, labels) {
        const orders = cloudOrders || readOrders();
        const bookings = cloudBookings || readBookings();
        const nonArcheryBookings = bookings.filter(booking => !isArcheryBooking(booking));
        const membershipUser = buildMembershipUser(user, orders, bookings);
        const tier = getMemberTier(membershipUser);
        const avatar = profileValue('photoURL', user.avatar || user.photoURL || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(user.name || labels.member) + '&background=4caf50&color=fff');
        const displayName = profileValue('displayName', user.name || labels.member);
        const email = profileValue('email', user.email || '');
        const historyItems = buildHistoryItems(orders, bookings, labels);
        const profileLoadNotice = cloudProfileError
            ? `<p class="profile-save-message" role="status">${escapeHTML(cloudProfileError)}</p>`
            : '';
        if (!PROFILE_TABS.includes(activeProfileTab)) activeProfileTab = 'points';
        if (!HISTORY_FILTERS.includes(activeHistoryFilter)) activeHistoryFilter = 'all';

        container.innerHTML = `
            <div class="profile-layout profile-dashboard">
                ${renderProfileSummary(user, labels, membershipUser, tier, avatar, displayName, email)}
                <section class="profile-main profile-dashboard-main">
                    ${profileLoadNotice}
                    ${renderActiveProfilePanel(user, labels, membershipUser, tier, historyItems)}
                </section>
            </div>
        `;
        if (profileEditing) initProfileAddressAutocomplete();
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

    function setProfileEditing(isEditing) {
        profileEditing = isEditing === true;
        if (!profileEditing) {
            emailVerificationState = { email: '' };
            phoneVerificationState = { verificationId: '', phoneNumber: '', phoneDisplay: '' };
        }
        renderProfile();
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

    function getProfileFormPhone(requireChanged = false) {
        const form = document.getElementById('member-profile-form');
        const input = form?.querySelector('input[name="phone"]');
        const phone = cleanString(input?.value, 40);
        const currentPhone = cleanString(input?.dataset.currentPhone || cloudProfile?.phone || '', 40);
        if (!phone) {
            const error = new Error(isEnglishPage() ? 'Please enter a phone number first.' : 'กรุณากรอกเบอร์โทรศัพท์ก่อน');
            error.userMessage = true;
            throw error;
        }
        if (requireChanged && phone === currentPhone) {
            const error = new Error(isEnglishPage() ? 'This phone number is already verified.' : 'เบอร์นี้ยืนยันแล้ว ไม่ต้องกดยืนยันซ้ำ');
            error.userMessage = true;
            throw error;
        }
        return phone;
    }

    function syncEmailVerificationAction() {
        const form = document.getElementById('member-profile-form');
        const input = form?.querySelector('input[name="email"]');
        const actions = document.getElementById('email-verification-actions');
        const button = document.getElementById('email-verification-request');
        if (!input || !actions || !button) return;
        const email = cleanString(input.value, 180).toLowerCase();
        const currentEmail = cleanString(cloudProfile?.email || '', 180).toLowerCase();
        const changed = email !== currentEmail;
        const verified = !!email && !!currentEmail && email === currentEmail && cloudProfile?.emailVerified === true;
        const pending = !!emailVerificationState.email;
        const shouldShow = profileEditing && !!email && (!verified || changed || pending);
        actions.hidden = !shouldShow;
        button.disabled = !shouldShow || (!changed && verified && !pending) || emailVerificationBusy || cooldownSeconds(emailVerificationCooldownUntil) > 0;
    }

    function syncPhoneVerificationAction() {
        const form = document.getElementById('member-profile-form');
        const input = form?.querySelector('input[name="phone"]');
        const actions = document.getElementById('phone-verification-actions');
        const button = document.getElementById('phone-change-request');
        if (!input || !actions || !button) return;
        const changed = cleanString(input.value, 40) !== cleanString(input.dataset.currentPhone || '', 40);
        const phone = cleanString(input.value, 40);
        const verified = !!input.dataset.currentPhone && (cloudProfile?.phoneVerified === true || !!cloudProfile?.phoneVerifiedAt || !!cloudProfile?.phoneE164);
        const pending = !!phoneVerificationState.verificationId;
        const shouldShow = profileEditing && !!phone && (!verified || changed || pending);
        actions.hidden = !shouldShow;
        button.disabled = !shouldShow || (!changed && verified && !pending) || phoneVerificationBusy || cooldownSeconds(phoneVerificationCooldownUntil) > 0;
    }

    async function sendMemberEmailVerificationCode() {
        const labels = getLabels();
        if (!profileEditing) return false;
        if (emailVerificationBusy) return false;
        if (cooldownSeconds(emailVerificationCooldownUntil) > 0) {
            showSaveMessage(labels.verificationCooldown || 'กรุณารอ 5 นาทีก่อนขอรหัสใหม่', true);
            return false;
        }
        emailVerificationBusy = true;
        showSaveMessage(labels.sendingEmailCode);
        let finalMessage = labels.emailCodeSent;
        let finalError = false;
        try {
            const email = getProfileFormEmail();
            const result = await profileApiRequest('/sendEmailVerificationCode', { email });
            if (result.alreadyVerified) {
                emailVerificationState = { email: '' };
                finalMessage = labels.emailVerifiedLocked || labels.emailCodeVerified;
            } else {
                emailVerificationState = { email };
                emailVerificationCooldownUntil = Date.now() + (5 * 60 * 1000);
                window.setTimeout(renderProfile, 5 * 60 * 1000);
            }
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
            emailVerificationState = { email: '' };
            emailVerificationCooldownUntil = 0;
            const user = readUser() || {};
            localStorage.setItem(USER_KEY, JSON.stringify(profileToStoredUser({ ...cloudProfile, uid: user.uid || cloudProfile?.uid || '', email })));
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

    async function sendMemberPhoneVerificationCode() {
        const labels = getLabels();
        if (!profileEditing) return false;
        if (phoneVerificationBusy) return false;
        if (cooldownSeconds(phoneVerificationCooldownUntil) > 0) {
            showSaveMessage(labels.verificationCooldown || 'กรุณารอ 5 นาทีก่อนขอรหัสใหม่', true);
            return false;
        }
        phoneVerificationBusy = true;
        showSaveMessage(labels.sendingPhoneCode || 'กำลังส่ง OTP...');
        let finalMessage = labels.phoneCodeSent || 'ส่ง OTP แล้ว กรุณากรอกรหัส 6 หลัก';
        let finalError = false;
        try {
            const phone = getProfileFormPhone(true);
            const result = await requestPhoneChangeOtp(phone);
            if (result.alreadyVerified) {
                phoneVerificationState = { verificationId: '', phoneNumber: '', phoneDisplay: '' };
                finalMessage = labels.phoneVerified || 'ยืนยันเบอร์โทรแล้ว';
            } else {
                phoneVerificationState = {
                    verificationId: result.verificationId || '',
                    phoneNumber: result.phoneNumber || phone,
                    phoneDisplay: result.phoneDisplay || phone
                };
                phoneVerificationCooldownUntil = Date.now() + (5 * 60 * 1000);
                window.setTimeout(renderProfile, 5 * 60 * 1000);
            }
        } catch (error) {
            logClientError('Phone verification send failed:', error);
            finalMessage = error?.userMessage ? error.message : (labels.phoneCodeFailed || labels.saveFailed);
            finalError = true;
        } finally {
            phoneVerificationBusy = false;
            renderProfile();
            requestAnimationFrame(() => showSaveMessage(finalMessage, finalError));
        }
        return false;
    }

    async function verifyMemberPhoneCode() {
        const labels = getLabels();
        if (phoneVerificationBusy) return false;
        const form = document.getElementById('member-profile-form');
        const code = cleanString(form?.querySelector('input[name="phoneCode"]')?.value, 6);
        if (!phoneVerificationState.verificationId) {
            showSaveMessage(isEnglishPage() ? 'Please request a phone OTP first.' : 'กรุณาขอ OTP ก่อน', true);
            return false;
        }
        if (!/^\d{6}$/.test(code)) {
            showSaveMessage(isEnglishPage() ? 'Please enter the 6-digit code.' : 'กรุณากรอกรหัส 6 หลัก', true);
            return false;
        }

        phoneVerificationBusy = true;
        showSaveMessage(labels.verifyingPhoneCode || 'กำลังยืนยันเบอร์...');
        let finalMessage = labels.phoneCodeVerified || 'ยืนยันเบอร์โทรเรียบร้อยแล้ว';
        let finalError = false;
        try {
            const result = await verifyPhoneChangeOtp({
                verificationId: phoneVerificationState.verificationId,
                phoneNumber: phoneVerificationState.phoneNumber,
                otp: code
            });
            const profile = result.profile || {};
            cloudProfile = {
                ...(cloudProfile || {}),
                ...profile,
                displayName: profile.display_name || profile.displayName || cloudProfile?.displayName || '',
                phone: profile.phone_display || result.phoneDisplay || phoneVerificationState.phoneDisplay,
                phoneE164: profile.phone_number || result.phoneNumber || phoneVerificationState.phoneNumber,
                phoneVerified: true,
                phoneVerifiedAt: profile.phoneVerifiedAt || new Date().toISOString()
            };
            localStorage.setItem(USER_KEY, JSON.stringify(profileToStoredUser(cloudProfile)));
            phoneVerificationState = { verificationId: '', phoneNumber: '', phoneDisplay: '' };
            phoneVerificationCooldownUntil = 0;
        } catch (error) {
            logClientError('Phone verification failed:', error);
            finalMessage = error?.userMessage ? error.message : (labels.phoneCodeFailed || labels.saveFailed);
            finalError = true;
        } finally {
            phoneVerificationBusy = false;
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
        if (!user?.uid) {
            showSaveMessage(labels.saveFailed, true);
            return false;
        }
        const formData = new FormData(form);
        const email = cleanString(formData.get('email'), 180).toLowerCase();
        const previousEmail = cleanString(cloudProfile?.email, 180).toLowerCase();
        const emailNeedsVerification = !!email && email !== previousEmail;
        const requestedPhone = cleanString(formData.get('phone'), 40);
        const currentPhone = cleanString(cloudProfile?.phone || user.phone || '', 40);
        if (emailNeedsVerification) {
            showSaveMessage(labels.emailOptional || (isEnglishPage() ? 'Please verify this email before saving.' : '\u0e01\u0e23\u0e38\u0e13\u0e32\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19\u0e2d\u0e35\u0e40\u0e21\u0e25\u0e01\u0e48\u0e2d\u0e19\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01'), true);
            return false;
        }
        if (requestedPhone && currentPhone && requestedPhone !== currentPhone) {
            showSaveMessage(labels.phoneUnverified || 'หากเปลี่ยนเบอร์ ต้องยืนยัน OTP ก่อนบันทึกเบอร์ใหม่', true);
            return false;
        }
        const firstName = cleanString(formData.get('firstName'), 80);
        const lastName = cleanString(formData.get('lastName'), 80);
        if (!firstName || !lastName) {
            showSaveMessage(isEnglishPage() ? 'Please enter first and last name.' : 'กรุณากรอกชื่อและนามสกุล', true);
            return false;
        }
        const shippingAddressStructured = normalizeShippingAddressStructured({
            addressLine: formData.get('addressLine'),
            subdistrict: formData.get('subdistrict'),
            district: formData.get('district'),
            province: formData.get('province'),
            zipcode: formData.get('zipcode')
        });
        const payload = {
            firstName,
            lastName,
            displayName: [firstName, lastName].filter(Boolean).join(' '),
            shippingAddress: cleanString(formatShippingAddress(shippingAddressStructured), 500),
            shippingAddressStructured,
            birthDate: cleanString(formData.get('birthDate'), 20),
            allergies: cleanString(formData.get('allergies'), 200),
            healthNote: cleanString(formData.get('healthNote'), 500),
            lineId: cleanString(formData.get('lineId'), 80)
        };
        cloudProfileSaving = true;
        setProfileSavingState(form, true, labels);
        showSaveMessage(labels.saving);
        try {
            const result = await updateMyProfile(payload);
            const profile = result.profile || {};
            cloudProfile = {
                ...(cloudProfile || {}),
                ...profile,
                displayName: profile.display_name || profile.displayName || payload.displayName,
                firstName: profile.firstName || payload.firstName,
                lastName: profile.lastName || payload.lastName,
                phone: profile.phone_display || cloudProfile?.phone || user.phone || '',
                phoneE164: profile.phone_number || cloudProfile?.phoneE164 || '',
                shippingAddress: profile.shippingAddress || payload.shippingAddress,
                shippingAddressStructured: normalizeShippingAddressStructured(
                    profile.shippingAddressStructured || profile.shipping_address_structured || payload.shippingAddressStructured,
                    profile.shippingAddress || payload.shippingAddress
                )
            };
            cloudProfileUid = user.uid;
            cloudProfileError = '';
            localStorage.setItem(USER_KEY, JSON.stringify(profileToStoredUser(cloudProfile)));
            const savedMessage = emailNeedsVerification
                ? `${labels.saved} ${labels.emailOptional || ''}`.trim()
                : labels.saved;
            cloudProfileSaving = false;
            profileEditing = false;
            renderProfile();
            requestAnimationFrame(() => showSaveMessage(savedMessage));
        } catch (error) {
            logClientError('Profile save failed:', error);
            const message = error?.userMessage ? error.message : labels.saveFailed;
            showSaveMessage(message, true);
        } finally {
            cloudProfileSaving = false;
            setProfileSavingState(form, false, labels);
        }
        return false;
    }

    function resetMemberProfileForm() {
        setProfileEditing(false);
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
            renderSkeleton(container, 'profile');
            return;
        }
        if (user.passwordLoginEnabled === false || user.password_login_enabled === false) {
            redirectToPasswordSetup();
            return;
        }
        if (authStateResolved && currentAuthUser && !cloudProfile && cloudProfileUid !== user.uid) {
            renderSkeleton(container, 'profile');
            refreshCloudProfile(user);
            return;
        }
        clearSkeleton(container);
        renderSignedIn(container, user, labels);
    }

    window.renderProfile = renderProfile;
    window.setProfileEditing = setProfileEditing;
    window.saveMemberProfile = saveMemberProfile;
    window.resetMemberProfileForm = resetMemberProfileForm;
    window.previewMemberTier = previewMemberTier;
    window.refreshProfileLoyalty = refreshProfileLoyalty;
    window.setProfileTab = setProfileTab;
    window.setProfileHistoryFilter = setProfileHistoryFilter;
    window.toggleProfileHistoryExpanded = toggleProfileHistoryExpanded;
    window.sendMemberEmailVerificationCode = sendMemberEmailVerificationCode;
    window.verifyMemberEmailCode = verifyMemberEmailCode;
    window.sendMemberPhoneVerificationCode = sendMemberPhoneVerificationCode;
    window.verifyMemberPhoneCode = verifyMemberPhoneCode;
    window.syncPhoneVerificationAction = syncPhoneVerificationAction;

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
                cloudProfileError = '';
                profileEditing = false;
                emailVerificationState = { email: '' };
                emailVerificationCooldownUntil = 0;
                phoneVerificationState = { verificationId: '', phoneNumber: '', phoneDisplay: '' };
                phoneVerificationCooldownUntil = 0;
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
        cloudProfileError = '';
        profileEditing = false;
        emailVerificationState = { email: '' };
        emailVerificationCooldownUntil = 0;
        phoneVerificationState = { verificationId: '', phoneNumber: '', phoneDisplay: '' };
        phoneVerificationCooldownUntil = 0;
        loyaltyConfig = null;
        loyaltyLedger = [];
        loyaltySummary = null;
        loyaltyUid = '';
        renderProfile();
    });
})();
