import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, getDoc, getDocs, query, setDoc, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMemberTier, getNextTierProgress, getTierBenefits, getTierTheme, getTierRules } from './membership.js';

(() => {
    const USER_KEY = 'eden_user';
    const ORDER_HISTORY_KEY = 'eden_order_history';
    const CART_KEY = 'eden_cart';
    let cloudOrders = null;
    let cloudBookings = null;
    let cloudHistoryUid = '';
    let cloudHistoryLoading = false;
    let cloudProfile = null;
    let cloudProfileUid = '';
    let cloudProfileLoading = false;
    let cloudProfileSaving = false;
    let loyaltyConfig = null;
    let loyaltyLedger = [];
    let loyaltySummary = null;
    let loyaltyUid = '';
    let loyaltyLoading = false;
    let currentAuthUser = null;
    let selectedPreviewTier = '';

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
            memberId: 'Member ID',
            points: 'Reward Points',
            totalSpent: 'Total Spent',
            visits: 'Visits',
            cartItems: 'Cart Items',
            pointValue: 'Point Value',
            pointsTab: 'Points',
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
            googleInfo: 'Google Account',
            editableInfo: 'Additional customer information',
            name: 'Name',
            email: 'Email',
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
            memberId: 'รหัสสมาชิก',
            points: 'คะแนนสะสม',
            totalSpent: 'ยอดใช้จ่ายสะสม',
            visits: 'จำนวนครั้งที่ใช้บริการ',
            cartItems: 'สินค้าในตะกร้า',
            pointValue: 'มูลค่าแต้ม',
            pointsTab: 'แต้ม',
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
            googleInfo: 'บัญชี Google',
            editableInfo: 'ข้อมูลเพิ่มเติมสำหรับบริการลูกค้า',
            name: 'ชื่อ',
            email: 'อีเมล',
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
                uid: currentAuthUser.uid,
                name: currentAuthUser.displayName || stored?.name || 'Eden Member',
                email: currentAuthUser.email || stored?.email || '',
                avatar: currentAuthUser.photoURL || stored?.avatar || 'https://ui-avatars.com/api/?name=Eden+Member&background=4caf50&color=fff'
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
            console.warn('Unable to load profile history from cloud:', error);
        } finally {
            cloudHistoryLoading = false;
        }
    }

    async function refreshCloudProfile(user) {
        if (!db || !user?.uid || cloudProfileLoading || cloudProfileUid === user.uid) return;
        cloudProfileLoading = true;
        try {
            const snap = await getDoc(doc(db, 'users', user.uid));
            cloudProfile = snap.exists() ? snap.data() : {};
            cloudProfileUid = user.uid;
            renderProfile();
        } catch (error) {
            console.warn('Unable to load member profile:', error);
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
            console.warn('Unable to load loyalty information:', error);
        } finally {
            loyaltyLoading = false;
        }
    }

    function cartCount() {
        const cart = readJSON(CART_KEY, []);
        return Array.isArray(cart) ? cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) : 0;
    }

    function memberId(user) {
        const source = String(user?.uid || '000000').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase().padStart(6, '0');
        return 'ED-' + source;
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
            if (order.isTestOrder === true) return false;
            if (status === 'cancelled' || paymentStatus === 'refunded' || paymentStatus === 'failed') return false;
            if (paymentStatus) return paymentStatus === 'paid';
            return status === 'paid' || status === 'completed';
        });
        const orderSpent = paidLikeOrders.reduce((sum, order) => sum + orderTotal(order), 0);
        const orderCount = paidLikeOrders.length;
        const bookingCount = bookings.length;
        const computedVisitCount = orderCount + bookingCount;
        const config = getLoyaltyConfig();
        const canonicalMemberCode = memberId(user);
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
        const savedTotalSpent = Number(profileValue('totalSpent', 0)) || 0;
        const savedVisitCount = Number(profileValue('visitCount', 0)) || 0;
        const savedOrderCount = Number(profileValue('orderCount', 0)) || 0;
        const savedBookingCount = Number(profileValue('bookingCount', 0)) || 0;

        return {
            id: user.uid,
            name: profileValue('displayName', user.name || ''),
            email: profileValue('email', user.email || ''),
            avatarUrl: profileValue('photoURL', user.avatar || ''),
            memberCode: canonicalMemberCode,
            points,
            totalSpent: summaryTotalSpent != null ? Math.max(0, Number(summaryTotalSpent) || 0) : Math.max(savedTotalSpent, orderSpent),
            visitCount: summaryVisitCount != null ? Math.max(0, Number(summaryVisitCount) || 0) : Math.max(savedVisitCount, computedVisitCount),
            orderCount: summaryOrderCount != null ? Math.max(0, Number(summaryOrderCount) || 0) : Math.max(savedOrderCount, orderCount),
            bookingCount: summaryBookingCount != null ? Math.max(0, Number(summaryBookingCount) || 0) : Math.max(savedBookingCount, bookingCount),
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

    function renderMemberCard(user, labels, membershipUser, avatar, displayName, email) {
        const tier = getMemberTier(membershipUser);
        const theme = getTierTheme(tier);
        const progress = getNextTierProgress(membershipUser);
        const progressLabel = progress.completed ? labels.highestTier : `${labels.progressTo} ${progress.nextTier}`;
        const percent = progress.completed ? 100 : progress.percent;
        const config = getLoyaltyConfig();
        const pointCashValue = Math.floor((Number(membershipUser.points) || 0) * config.pointValue);
        const memberCode = membershipUser.memberCode || memberId(user);

        return `
            <section class="member-card profile-hero ${theme.className}" id="profile-overview">
                <div class="profile-hero-identity">
                    <img src="${escapeHTML(avatar)}" alt="Profile" class="profile-hero-avatar">
                    <div class="profile-hero-copy">
                        <span class="profile-kicker">${escapeHTML(labels.profileInfo)}</span>
                        <h1>${escapeHTML(displayName || membershipUser.name || labels.member)}</h1>
                        <p>${escapeHTML(email || labels.notProvided)}</p>
                        <div class="profile-identity-meta">
                            <span class="member-tier-badge ${theme.badgeClass}">${escapeHTML(tier)}</span>
                            <span class="member-id">${escapeHTML(labels.memberId)}: ${escapeHTML(memberCode)}</span>
                        </div>
                    </div>
                </div>
                <div class="profile-summary-grid">
                    <div class="profile-summary-tile">
                        <span>${escapeHTML(labels.points)}</span>
                        <strong>${formatNumber(membershipUser.points)}</strong>
                    </div>
                    <div class="profile-summary-tile">
                        <span>${escapeHTML(labels.pointValue)}</span>
                        <strong>฿${formatBaht(pointCashValue)}</strong>
                    </div>
                    <div class="profile-summary-tile">
                        <span>${escapeHTML(labels.totalSpent)}</span>
                        <strong>฿${formatBaht(membershipUser.totalSpent)}</strong>
                    </div>
                    <div class="profile-summary-tile">
                        <span>${escapeHTML(labels.visits)}</span>
                        <strong>${formatNumber(membershipUser.visitCount)}</strong>
                    </div>
                </div>
                <div class="member-progress-container">
                    <div class="member-progress-text"><span>${escapeHTML(progressLabel)}</span><span>${percent}%</span></div>
                    <div class="member-progress-bar"><div class="member-progress-fill" style="width:${percent}%"></div></div>
                    <p class="member-progress-goal">${escapeHTML(progressMessage(progress, labels))}</p>
                </div>
            </section>
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
                    <strong class="${delta < 0 ? 'is-negative' : 'is-positive'}">${escapeHTML(prefix + formatNumber(delta))}</strong>
                    <em>${escapeHTML(reason)}</em>
                </div>
            `;
        }).join('');

        return `
            <section class="membership-panel profile-section" id="profile-loyalty-wallet">
                <div class="profile-section-head">
                    <div>
                        <span class="profile-section-kicker">${escapeHTML(labels.pointsTab)}</span>
                        <h2>${escapeHTML(labels.loyaltyWallet)}</h2>
                    </div>
                    <strong class="profile-wallet-value">${escapeHTML(walletValue)}</strong>
                </div>
                <div class="benefit-grid profile-rule-grid">
                    <div class="benefit-pill">${escapeHTML(earnRule)}</div>
                    <div class="benefit-pill">${escapeHTML(redeemRule)}</div>
                    <div class="benefit-pill">${escapeHTML(expiryRule)}</div>
                </div>
                <h3 class="profile-subsection-title">${escapeHTML(labels.loyaltyHistory)}</h3>
                ${loyaltyLoading ? `<p class="membership-rule-lead">${escapeHTML(labels.loyaltyLoading)}</p>` : ''}
                <div class="membership-rule-list">
                    ${historyRows || `<p class="membership-rule-lead">${escapeHTML(labels.noLoyaltyHistory)}</p>`}
                </div>
            </section>
        `;
    }

    function renderBenefits(tier, labels) {
        const benefits = getTierBenefits(tier, isEnglishPage() ? 'en' : 'th');
        return `
            <section class="membership-panel profile-section">
                <h2>${escapeHTML(labels.benefits)}</h2>
                <div class="benefit-grid">
                    ${benefits.map(item => `<div class="benefit-pill">${escapeHTML(item)}</div>`).join('')}
                </div>
            </section>
        `;
    }

    function renderTierPreview(actualTier, labels) {
        const tiers = ['Silver', 'Gold', 'Platinum'];
        const previewTier = selectedPreviewTier || (actualTier === 'Platinum' ? 'Platinum' : 'Gold');
        const previewBenefits = getTierBenefits(previewTier, isEnglishPage() ? 'en' : 'th');
        const previewTheme = getTierTheme(previewTier);
        const isPreviewLocked = tierRank(previewTier) > tierRank(actualTier);

        return `
            <section class="membership-panel profile-section tier-preview-panel">
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
            </section>
        `;
    }

    function renderNextTierRequirements(membershipUser, labels) {
        const progress = getNextTierProgress(membershipUser);
        const rules = getTierRules();
        if (progress.completed || !progress.nextTier) {
            return `
                <section class="membership-panel profile-section">
                    <h2>${escapeHTML(labels.nextLevel)}</h2>
                    <p class="membership-max-note">${escapeHTML(labels.highestTier)}</p>
                </section>
            `;
        }

        const nextRules = rules[progress.nextTier.toUpperCase()];
        const rows = [
            { label: labels.metricPoints, current: formatNumber(membershipUser.points), rule: labels.pointRule.replace('{value}', formatNumber(nextRules.minPoints)) },
            { label: labels.metricSpent, current: '฿' + formatBaht(membershipUser.totalSpent), rule: labels.spentRule.replace('{value}', formatBaht(nextRules.minTotalSpent)) },
            { label: labels.metricVisits, current: formatNumber(membershipUser.visitCount), rule: labels.visitRule.replace('{value}', formatNumber(nextRules.minVisitCount)) }
        ];

        return `
            <section class="membership-panel profile-section">
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
            </section>
        `;
    }

    function renderSignedOut(container, labels) {
        container.innerHTML = `
            <div class="profile-container profile-signed-out">
                <img src="Images/Logo.webp" alt="Eden Cafe" class="profile-signed-out-logo">
                <h1>${escapeHTML(labels.profile)}</h1>
                <p>${escapeHTML(labels.signInPrompt)}</p>
                <button class="btn btn-outline" onclick="openLoginModal()">${escapeHTML(labels.signIn)}</button>
            </div>
        `;
    }

    function renderOrderList(orders, labels) {
        if (!orders.length) return `<p class="profile-empty-state">${escapeHTML(labels.noOrders)}</p>`;
        return orders.map(order => {
            const items = Array.isArray(order.items) ? order.items : [];
            const status = order.status === 'paid' ? labels.paid : labels.pending;
            return `
                <div class="order-card">
                    <div class="order-card-header">
                        <strong>${escapeHTML(labels.orderId)} ${escapeHTML(order.id || '-')}</strong>
                        <span class="profile-status-pill">${escapeHTML(status)}</span>
                    </div>
                    <p class="profile-list-meta">${formatDate(order.date || order.timestamp)}</p>
                    <p class="profile-list-items">${escapeHTML(labels.items)}: ${items.map(item => escapeHTML(item.name || '')).join(', ') || '-'}</p>
                    <strong class="profile-list-total">${escapeHTML(labels.total)}: ${money(order.totalAmount || order.total || 0)}</strong>
                </div>
            `;
        }).join('');
    }

    function renderBookingList(bookings, labels) {
        if (!bookings.length) return `<p class="profile-empty-state">${escapeHTML(labels.noBookings)}</p>`;
        return bookings.map(booking => `
            <div class="order-card">
                <div class="order-card-header">
                    <strong>${escapeHTML(booking.id || booking.date || '-')}</strong>
                    <span class="profile-status-pill">${escapeHTML(booking.status || 'confirmed')}</span>
                </div>
                <p class="profile-list-meta">${escapeHTML([booking.date, booking.time || booking.arrivalTime || booking.startTime, booking.tableIds || booking.table || booking.zone || booking.tableZone].filter(Boolean).join(' | '))}</p>
            </div>
        `).join('');
    }

    function renderProfileForm(user, labels) {
        const phone = profileValue('phone', user.phone || '');
        const shippingAddress = profileValue('shippingAddress', user.shippingAddress || user.address || '');
        const birthDate = profileValue('birthDate', '');
        const allergies = profileValue('allergies', '');
        const healthNote = profileValue('healthNote', '');
        const lineId = profileValue('lineId', '');
        const displayName = profileValue('displayName', user.name || labels.member);
        const email = profileValue('email', user.email || '');
        const avatar = profileValue('photoURL', user.avatar || user.photoURL || 'Images/Logo.webp');
        const loadingText = cloudProfileLoading ? `<p class="profile-save-message">${escapeHTML(labels.loadingProfile)}</p>` : '';

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

    function setupProfileNavigation(container) {
        const navItems = Array.from(container.querySelectorAll('.profile-nav-item[href^="#profile"]'));
        const activate = hash => {
            navItems.forEach(item => item.classList.toggle('active', item.getAttribute('href') === hash));
        };
        navItems.forEach(item => {
            item.addEventListener('click', () => activate(item.getAttribute('href')));
        });
        if (!('IntersectionObserver' in window)) return;
        const sections = navItems
            .map(item => document.querySelector(item.getAttribute('href')))
            .filter(Boolean);
        if (!sections.length) return;
        const observer = new IntersectionObserver(entries => {
            const activeEntry = entries
                .filter(entry => entry.isIntersecting)
                .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
            if (activeEntry?.target?.id) activate(`#${activeEntry.target.id}`);
        }, { rootMargin: '-30% 0px -58% 0px', threshold: [0.1, 0.35, 0.6] });
        sections.forEach(section => observer.observe(section));
    }

    function renderSignedIn(container, user, labels) {
        const hasFirebaseUser = !!currentAuthUser?.uid;
        const orders = hasFirebaseUser ? (Array.isArray(cloudOrders) ? cloudOrders : []) : (cloudOrders || readOrders());
        const bookings = hasFirebaseUser ? (Array.isArray(cloudBookings) ? cloudBookings : []) : (cloudBookings || readBookings());
        const membershipUser = buildMembershipUser(user, orders, bookings);
        const tier = getMemberTier(membershipUser);
        const avatar = profileValue('photoURL', user.avatar || user.photoURL || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(user.name || labels.member) + '&background=4caf50&color=fff');
        const displayName = profileValue('displayName', user.name || labels.member);
        const email = profileValue('email', user.email || '');

        container.innerHTML = `
            <div class="profile-layout">
                <nav class="profile-sidebar" aria-label="Profile sections">
                    <a class="profile-nav-item active" href="#profile-overview">${escapeHTML(labels.overview)}</a>
                    <a class="profile-nav-item" href="#profile-loyalty-wallet">${escapeHTML(labels.pointsTab)}</a>
                    <a class="profile-nav-item" href="#profile-orders">${escapeHTML(labels.orders)}</a>
                    <a class="profile-nav-item" href="#profile-account">${escapeHTML(labels.account)}</a>
                    <button type="button" class="profile-nav-item profile-nav-item--logout" onclick="logout()">${escapeHTML(labels.logout)}</button>
                </nav>
                <section class="profile-main">
                    ${renderMemberCard(user, labels, membershipUser, avatar, displayName, email)}
                    <div class="profile-action-row">
                        <a class="btn" href="${isEnglishPage() ? '/shop-en' : '/shop'}">${escapeHTML(labels.shopNow)}</a>
                        <a class="btn btn-outline" href="${isEnglishPage() ? '/booking-en' : '/booking'}">${escapeHTML(labels.bookTable)}</a>
                        <button type="button" class="btn btn-quiet" onclick="logout()">${escapeHTML(labels.logout)}</button>
                    </div>
                    ${renderLoyaltyWallet(membershipUser, labels)}
                    ${renderTierPreview(tier, labels)}
                    ${renderBenefits(tier, labels)}
                    ${renderNextTierRequirements(membershipUser, labels)}

                    <section class="order-history profile-section" id="profile-orders">
                        <h2>${escapeHTML(labels.recentOrders)}</h2>
                        ${renderOrderList(orders, labels)}
                    </section>

                    <section class="order-history profile-section" id="profile-bookings">
                        <h2>${escapeHTML(labels.bookings)}</h2>
                        ${renderBookingList(bookings, labels)}
                    </section>

                    <section class="order-history profile-section" id="profile-account">
                        <h2>${escapeHTML(labels.editableInfo)}</h2>
                        ${renderProfileForm(user, labels)}
                    </section>
                </section>
            </div>
        `;
        setupProfileNavigation(container);
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
        const payload = {
            uid: user.uid,
            displayName: cleanString(user.name || currentAuthUser?.displayName || labels.member, 120),
            email: cleanString(user.email || currentAuthUser?.email || '', 180),
            photoURL: cleanString(user.avatar || currentAuthUser?.photoURL || '', 500),
            memberCode: memberId(user),
            phone: cleanString(formData.get('phone'), 40),
            shippingAddress: cleanString(formData.get('shippingAddress'), 500),
            birthDate: cleanString(formData.get('birthDate'), 20),
            allergies: cleanString(formData.get('allergies'), 200),
            healthNote: cleanString(formData.get('healthNote'), 500),
            lineId: cleanString(formData.get('lineId'), 80),
            updatedAt: serverTimestamp()
        };

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
                shippingAddress: payload.shippingAddress,
                address: payload.shippingAddress,
                lineId: payload.lineId
            };
            localStorage.setItem(USER_KEY, JSON.stringify(mergedUser));
            showSaveMessage(labels.saved);
        } catch (error) {
            console.error('Profile save failed:', error);
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
        if (!user || !user.uid) renderSignedOut(container, labels);
        else renderSignedIn(container, user, labels);
    }

    window.renderProfile = renderProfile;
    window.saveMemberProfile = saveMemberProfile;
    window.resetMemberProfileForm = resetMemberProfileForm;
    window.previewMemberTier = previewMemberTier;

    document.addEventListener('DOMContentLoaded', () => {
        renderProfile();
        if (auth) {
            onAuthStateChanged(auth, user => {
                currentAuthUser = user;
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
