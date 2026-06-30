import './page-telemetry.js';
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import qrcodeFactory from './qrcode-generator.esm.js';
import { clearSkeleton, renderSkeleton } from './ui-skeleton.js';

const BRANCH_ID = 'BKK_MAIN';
const EMPTY_PRICING_CONFIG = {
    version: '',
    packages: [],
    abilityOptions: [],
    equipmentOptions: []
};
const OPTION_LABELS_TH = {
    first_time_with_coach: 'ครั้งแรก ต้องการโค้ช',
    experienced_with_coach: 'เคยยิงแล้ว ต้องการโค้ช',
    experienced_no_coach: 'เคยยิงแล้ว ไม่ต้องการโค้ช',
    rent_full_set: 'เช่าอุปกรณ์ครบเซ็ต',
    bring_own: 'นำอุปกรณ์มาเอง'
};
const STORAGE_KEY = 'eden_archery_last_booking';
const HOLD_STORAGE_KEY = 'eden_archery_active_hold';
const HOLD_MINUTES = 10;
const VALID_DURATIONS = new Set([60, 120, 180]);
const EXPERIENCE_FIRST_TIME = 'first_time';
const EXPERIENCE_EXPERIENCED = 'experienced';
const STAFF_REQUIRED = 'staff_required';
const STAFF_NOT_REQUIRED = 'staff_not_required';

let currentUser = null;
let currentHold = null;
let latestAvailability = null;
let holdTimer = null;
let paymentPollTimer = null;
let availabilityDebounceTimer = null;
let availabilityCheckQueued = false;
let busyAction = '';
let isCheckingAvailability = false;
let holdIdempotencyKey = '';
let beamPaymentIdempotencyKey = '';
let archeryPricingConfig = EMPTY_PRICING_CONFIG;
let pricingSettingsReady = false;
let pricingSettingsError = '';
let appliedArcheryPromo = null;
let archeryPromoValidationToken = 0;
let participantSelections = [];

const AUTO_AVAILABILITY_DELAY_MS = 350;

function $(id) {
    return document.getElementById(id);
}

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function todayISO() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 10);
}

function timeLabel(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function displayTime(value) {
    return String(value || '').replace(':', '.');
}

function displayTimeRange(start, end) {
    return [start, end].filter(Boolean).map(displayTime).join('-');
}

function minutesFromTime(time) {
    const [h, m] = String(time || '00:00').split(':').map(Number);
    return (h * 60) + (m || 0);
}

function normalizeDuration(value) {
    const duration = Number(value || 60) || 60;
    return VALID_DURATIONS.has(duration) ? duration : 60;
}

function packageMinutes() {
    return normalizeDuration($('archery-package')?.value);
}

function partySize() {
    const value = Number($('archery-party-size')?.value || 1);
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 1;
}

function selectedDate() {
    return $('archery-date')?.value || todayISO();
}

function selectedStartTime() {
    return $('archery-start')?.value || '10:00';
}

function selectedEndTime() {
    return timeLabel(minutesFromTime(selectedStartTime()) + packageMinutes());
}

function packageCode(duration = packageMinutes()) {
    return 'ARCHERY_' + duration;
}

function money(value) {
    return Math.round(Number(value) || 0).toLocaleString('th-TH') + ' THB';
}

function bookingText(th, en) {
    return location.pathname.includes('-en') ? en : th;
}

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return 0;
}

function activeItems(items = []) {
    return (Array.isArray(items) ? items : []).filter(item => item && item.active !== false);
}

function normalizePricingConfig(data = {}) {
    const source = data.pricing || data.bookingOptions || data.booking_options || data || {};
    const fallback = EMPTY_PRICING_CONFIG;
    const packages = Array.isArray(source.packages) && source.packages.length ? source.packages : fallback.packages;
    const abilityOptions = Array.isArray(source.abilityOptions || source.ability_options) && (source.abilityOptions || source.ability_options).length
        ? (source.abilityOptions || source.ability_options)
        : fallback.abilityOptions;
    const equipmentOptions = Array.isArray(source.equipmentOptions || source.equipment_options) && (source.equipmentOptions || source.equipment_options).length
        ? (source.equipmentOptions || source.equipment_options)
        : fallback.equipmentOptions;
    return {
        version: source.version || source.pricingVersion || source.pricing_version || fallback.version || '',
        packages: packages.map((item, index) => ({
            durationMinutes: Number(item.durationMinutes ?? item.duration_minutes ?? item.duration ?? fallback.packages[index]?.durationMinutes ?? 0) || 0,
            price: Number(item.price ?? item.amount ?? item.amountTotal ?? item.amount_total ?? fallback.packages[index]?.price ?? 0) || 0,
            title: String(item.title || '').trim(),
            active: item.active !== false
        })).filter(item => item.durationMinutes > 0),
        abilityOptions: abilityOptions.map((item, index) => {
            const fallbackOption = fallback.abilityOptions[index] || {};
            return {
                id: String(item.id || item.option_id || fallbackOption.id || '').trim(),
                label: String(item.label || fallbackOption.label || '').trim(),
                ratePerHour: Number(item.ratePerHour ?? item.rate_per_hour ?? item.rate ?? fallbackOption.ratePerHour ?? 0) || 0,
                coachRequired: item.coachRequired != null
                    ? item.coachRequired === true
                    : item.coach_required != null
                        ? item.coach_required === true
                        : fallbackOption.coachRequired === true,
                active: item.active !== false
            };
        }).filter(item => item.id),
        equipmentOptions: equipmentOptions.map((item, index) => ({
            id: String(item.id || item.option_id || fallback.equipmentOptions[index]?.id || '').trim(),
            label: String(item.label || fallback.equipmentOptions[index]?.label || '').trim(),
            ratePerHour: Number(item.ratePerHour ?? item.rate_per_hour ?? item.rate ?? fallback.equipmentOptions[index]?.ratePerHour ?? 0) || 0,
            active: item.active !== false
        })).filter(item => item.id)
    };
}

function packagePrice(duration = packageMinutes()) {
    const item = activeItems(archeryPricingConfig.packages).find(row => row.durationMinutes === normalizeDuration(duration));
    return Number(item?.price || 0) || 0;
}

function selectedOption(group) {
    const checked = document.querySelector(`input[name="${group}"]:checked`);
    const options = group === 'archery-ability' ? archeryPricingConfig.abilityOptions : archeryPricingConfig.equipmentOptions;
    return activeItems(options).find(item => item.id === checked?.value) || activeItems(options)[0] || null;
}

function abilityOptions() {
    return activeItems(archeryPricingConfig.abilityOptions);
}

function findAbilityOption(predicate, fallbackPredicate = () => true) {
    const options = abilityOptions();
    return options.find(predicate) || options.find(fallbackPredicate) || options[0] || null;
}

function firstTimeStaffOption() {
    return findAbilityOption(
        option => option.coachRequired && String(option.id || '').includes('first_time'),
        option => option.coachRequired
    );
}

function experiencedStaffOption() {
    return findAbilityOption(
        option => option.coachRequired && String(option.id || '').includes('experienced'),
        option => option.coachRequired
    );
}

function experiencedNoStaffOption() {
    return findAbilityOption(
        option => !option.coachRequired && String(option.id || '').includes('no_coach'),
        option => !option.coachRequired
    );
}

function hasRequiredPricingConfig(config = archeryPricingConfig) {
    const packages = activeItems(config.packages).filter(item => item.durationMinutes > 0 && Number.isFinite(Number(item.price)));
    const abilities = activeItems(config.abilityOptions);
    const equipment = activeItems(config.equipmentOptions);
    return Boolean(
        packages.length
        && equipment.length
        && abilities.some(option => option.coachRequired && String(option.id || '').includes('first_time'))
        && abilities.some(option => option.coachRequired && String(option.id || '').includes('experienced'))
        && abilities.some(option => !option.coachRequired && String(option.id || '').includes('no_coach'))
    );
}

function pricingUnavailableText() {
    return bookingText(
        'ไม่สามารถโหลดราคาจากหลังบ้านได้ กรุณารีเฟรชหน้า หรือติดต่อพนักงาน',
        'Unable to load admin pricing. Please refresh or contact staff.'
    );
}

function pricingStatusText() {
    return pricingSettingsError || bookingText(
        'กำลังโหลดราคาจากหลังบ้าน...',
        'Loading admin pricing...'
    );
}

function normalizeParticipantSelections() {
    const people = partySize();
    const next = [];
    for (let index = 0; index < people; index += 1) {
        const current = participantSelections[index] || {};
        const experience = current.experience === EXPERIENCE_EXPERIENCED ? EXPERIENCE_EXPERIENCED : EXPERIENCE_FIRST_TIME;
        let staffChoice = current.staffChoice === STAFF_NOT_REQUIRED ? STAFF_NOT_REQUIRED : STAFF_REQUIRED;
        if (experience === EXPERIENCE_FIRST_TIME || !experiencedNoStaffOption()) staffChoice = STAFF_REQUIRED;
        next.push({ participantIndex: index + 1, experience, staffChoice });
    }
    participantSelections = next;
    return next;
}

function resolveParticipantAbility(selection = {}) {
    if (selection.experience === EXPERIENCE_FIRST_TIME) return firstTimeStaffOption();
    if (selection.staffChoice === STAFF_NOT_REQUIRED) return experiencedNoStaffOption() || experiencedStaffOption();
    return experiencedStaffOption();
}

function participantPricingRows(hours) {
    return normalizeParticipantSelections().map(selection => {
        const ability = resolveParticipantAbility(selection);
        const coachAmount = Math.round(Number(ability?.ratePerHour || 0) * hours);
        return {
            participantIndex: selection.participantIndex,
            experience: selection.experience,
            staffChoice: ability?.coachRequired ? STAFF_REQUIRED : STAFF_NOT_REQUIRED,
            ability,
            abilityOptionId: ability?.id || '',
            abilityLabel: optionDisplayLabel(ability),
            coachRequired: ability?.coachRequired === true,
            coachRatePerHour: Number(ability?.ratePerHour || 0) || 0,
            coachAmount
        };
    });
}

function participantPayloadRows(participants = []) {
    return participants.map(item => ({
        participant_index: item.participantIndex,
        experience: item.experience,
        staff_choice: item.staffChoice,
        ability_option_id: item.abilityOptionId
    }));
}

function staffSummaryText(pricing = calculateDraftPricing()) {
    if (!pricing.staffCount) return '0 people / ' + money(0);
    const groups = new Map();
    pricing.participants
        .filter(item => item.coachRequired)
        .forEach(item => {
            const key = String(item.coachAmount);
            const current = groups.get(key) || { count: 0, amount: 0, unit: item.coachAmount };
            current.count += 1;
            current.amount += item.coachAmount;
            groups.set(key, current);
        });
    return Array.from(groups.values())
        .map(group => `${group.count} x ${money(group.unit)} = ${money(group.amount)}`)
        .join(', ');
}

function calculateDraftPricing() {
    const duration = packageMinutes();
    const hours = duration / 60;
    const equipment = selectedOption('archery-equipment');
    const packageAmount = packagePrice(duration);
    const equipmentAmount = Math.round(Number(equipment?.ratePerHour || 0) * hours);
    const people = partySize();
    const participants = participantPricingRows(hours);
    const coachTotal = participants.reduce((sum, item) => sum + item.coachAmount, 0);
    const staffCount = participants.filter(item => item.coachRequired).length;
    const distinctAbilityIds = [...new Set(participants.map(item => item.abilityOptionId).filter(Boolean))];
    const primaryAbility = distinctAbilityIds.length === 1 ? participants[0]?.ability : null;
    const perPersonTotal = packageAmount + equipmentAmount + (people ? Math.round(coachTotal / people) : 0);
    return {
        packageAmount,
        coachAmount: people ? Math.round(coachTotal / people) : 0,
        equipmentAmount,
        partySize: people,
        requiredLaneCount: people,
        packageTotal: packageAmount * people,
        coachTotal,
        equipmentTotal: equipmentAmount * people,
        perPersonTotal,
        amountTotal: (packageAmount * people) + coachTotal + (equipmentAmount * people),
        staffCount,
        participants,
        participantOptions: participantPayloadRows(participants),
        ability: primaryAbility || participants[0]?.ability || null,
        equipment
    };
}

function normalizePromoCode(value) {
    return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
}

function currentArcheryPromoInputCode() {
    return normalizePromoCode($('archery-promo-code-input')?.value);
}

function appliedArcheryPromoCode() {
    return normalizePromoCode(appliedArcheryPromo?.code || appliedArcheryPromo?.promoCode);
}

function currentArcheryPromoDiscount(pricing = calculateDraftPricing()) {
    const code = currentArcheryPromoInputCode();
    if (!appliedArcheryPromo || !appliedArcheryPromoCode() || appliedArcheryPromoCode() !== code) return 0;
    return roundMoney(Math.min(pricing.amountTotal, appliedArcheryPromo.discountAmount || 0));
}

function archeryPromoItems(pricing = calculateDraftPricing()) {
    const duration = packageMinutes();
    const bookingDate = selectedDate();
    return [
        {
            id: `${packageCode(duration)}_PACKAGE`,
            productId: 'ARCHERY_PACKAGE',
            archeryItem: 'ARCHERY_PACKAGE',
            itemType: 'ARCHERY_PACKAGE',
            item_type: 'ARCHERY_PACKAGE',
            label: 'Archery package',
            quantity: pricing.partySize,
            unitPrice: pricing.packageAmount,
            lineTotal: pricing.packageTotal,
            amount: pricing.packageTotal,
            bookingDate,
            booking_date: bookingDate,
            serviceDate: bookingDate,
            service_date: bookingDate
        },
        {
            id: `${packageCode(duration)}_COACH`,
            productId: 'ARCHERY_COACH',
            archeryItem: 'ARCHERY_COACH',
            itemType: 'ARCHERY_COACH',
            item_type: 'ARCHERY_COACH',
            label: 'Staff',
            quantity: pricing.staffCount,
            unitPrice: pricing.staffCount ? roundMoney(pricing.coachTotal / pricing.staffCount) : 0,
            lineTotal: pricing.coachTotal,
            amount: pricing.coachTotal,
            bookingDate,
            booking_date: bookingDate,
            serviceDate: bookingDate,
            service_date: bookingDate
        },
        {
            id: `${packageCode(duration)}_EQUIPMENT`,
            productId: 'ARCHERY_EQUIPMENT',
            archeryItem: 'ARCHERY_EQUIPMENT',
            itemType: 'ARCHERY_EQUIPMENT',
            item_type: 'ARCHERY_EQUIPMENT',
            label: 'Equipment',
            quantity: pricing.partySize,
            unitPrice: pricing.equipmentAmount,
            lineTotal: pricing.equipmentTotal,
            amount: pricing.equipmentTotal,
            bookingDate,
            booking_date: bookingDate,
            serviceDate: bookingDate,
            service_date: bookingDate
        }
    ].filter(item => item.amount > 0);
}

function promoPayloadFromResponse(result = {}) {
    return result.promotion || result.redemption || result;
}

function promoErrorMessage(error = {}) {
    const code = String(error.code || error.error || error.message || '').toUpperCase();
    if (code.includes('BOOKING_DATE') || code.includes('SERVICE_DATE')) return 'Promo code is available only for selected booking dates.';
    if (code.includes('NOT_STARTED')) return 'Promo code is not active yet.';
    if (code.includes('EXPIRED')) return 'Promo code has expired.';
    if (code.includes('MIN_SUBTOTAL')) return 'Booking total does not meet this promo minimum.';
    if (code.includes('NOT_APPLICABLE')) return 'Promo code does not apply to this archery selection.';
    if (code.includes('LIMIT')) return 'Promo code redemption limit has been reached.';
    if (code.includes('CHANNEL')) return 'Promo code is not available for archery bookings.';
    if (code.includes('PROMO')) return 'Promo code is invalid or unavailable.';
    return 'Could not validate promo code. Please try again.';
}

function setArcheryPromoMessage(message = '', type = '') {
    setStatus('archery-promo-message', message, type);
}

function clearArcheryPromo({ message = '', type = '' } = {}) {
    appliedArcheryPromo = null;
    setArcheryPromoMessage(message, type);
}

function clearArcheryPromoAfterSelectionChange() {
    if (!appliedArcheryPromo && !currentArcheryPromoInputCode()) return;
    archeryPromoValidationToken += 1;
    holdIdempotencyKey = '';
    clearArcheryPromo({
        message: currentArcheryPromoInputCode() ? 'Booking details changed. Apply the promo code again.' : '',
        type: currentArcheryPromoInputCode() ? 'loading' : ''
    });
}

async function applyArcheryPromoCode(event) {
    if (event) event.preventDefault();
    if (currentHold) {
        setArcheryPromoMessage('Promo code is locked after booking hold is created.', 'error');
        return false;
    }
    if (!pricingSettingsReady) {
        setArcheryPromoMessage(pricingStatusText(), 'error');
        return false;
    }
    const input = $('archery-promo-code-input');
    const button = $('archery-promo-apply-btn');
    const code = normalizePromoCode(input?.value);
    if (input) input.value = code;
    archeryPromoValidationToken += 1;
    const token = archeryPromoValidationToken;

    if (!code) {
        holdIdempotencyKey = '';
        clearArcheryPromo({ message: 'Enter a promo code.', type: 'error' });
        renderDraftSummary();
        return false;
    }
    if (!currentUser) {
        clearArcheryPromo({ message: 'Please sign in before applying a promo code.', type: 'error' });
        renderDraftSummary();
        return false;
    }

    const pricing = calculateDraftPricing();
    if (pricing.amountTotal <= 0) {
        clearArcheryPromo({ message: 'Booking total must be greater than zero.', type: 'error' });
        renderDraftSummary();
        return false;
    }

    clearArcheryPromo();
    setArcheryPromoMessage('Checking promo code...', 'loading');
    if (button) button.disabled = true;

    try {
        const api = await waitForApi();
        if (!api?.validatePromotion) throw new Error('Promo service is not ready');
        const result = await api.validatePromotion({
            branch_id: BRANCH_ID,
            promo_code: code,
            source_type: 'ARCHERY_BOOKING',
            channel: 'ARCHERY',
            booking_date: selectedDate(),
            bookingDate: selectedDate(),
            service_date: selectedDate(),
            serviceDate: selectedDate(),
            subtotal: pricing.amountTotal,
            items: archeryPromoItems(pricing)
        });
        if (token !== archeryPromoValidationToken) return false;
        const promo = promoPayloadFromResponse(result);
        const discountAmount = roundMoney(promo.discountAmount ?? promo.discount_amount);
        if (discountAmount <= 0) throw new Error('Promo discount is zero');
        appliedArcheryPromo = {
            code: normalizePromoCode(promo.code || code),
            promotionId: promo.promotionId || promo.promotion_id || '',
            promotionName: promo.promotionName || promo.promotion_name || '',
            discountAmount: roundMoney(Math.min(pricing.amountTotal, discountAmount)),
            lineAllocations: Array.isArray(promo.lineAllocations) ? promo.lineAllocations : []
        };
        holdIdempotencyKey = '';
        setArcheryPromoMessage('Promo code applied.', 'success');
        renderDraftSummary();
        return true;
    } catch (error) {
        if (token !== archeryPromoValidationToken) return false;
        console.warn('Archery promo validation failed:', error);
        holdIdempotencyKey = '';
        clearArcheryPromo({ message: promoErrorMessage(error), type: 'error' });
        renderDraftSummary();
        return false;
    } finally {
        if (button) button.disabled = !!currentHold;
    }
}

function optionDisplayLabel(option = {}) {
    return OPTION_LABELS_TH[option.id || option.option_id] || option.label || '-';
}

function setStatus(id, message, type = '') {
    const el = $(id);
    if (!el) return;
    if (id === 'archery-status' && type === 'loading' && message) {
        el.innerHTML = `
            <span class="archery-availability-loader" role="status" aria-live="polite">
                <span class="archery-availability-loader__top">
                    <span class="archery-availability-loader__pulse" aria-hidden="true"></span>
                    <span class="archery-availability-loader__label">${escapeHTML(message)}</span>
                    <span class="archery-availability-loader__badge">กำลังเช็ก</span>
                </span>
                <span class="archery-availability-loader__bar" aria-hidden="true">
                    <span></span>
                </span>
                <span class="archery-availability-loader__steps" aria-hidden="true">
                    <span>เวลาจอง</span>
                    <span>คิวล่าสุด</span>
                    <span>จัดเลน</span>
                </span>
            </span>
        `;
    } else {
        el.textContent = message || '';
    }
    el.classList.toggle('error', type === 'error');
    el.classList.toggle('success', type === 'success');
    el.classList.toggle('loading', type === 'loading');
}

function errorCode(error) {
    return String(error?.code || error?.error || error?.message || '').trim();
}

function userMessage(error) {
    const code = errorCode(error);
    const map = {
        NO_LANE_AVAILABLE: 'เวลานี้ช่องยิงเต็มแล้ว กรุณาเลือกเวลาอื่น',
        HOLD_EXPIRED: 'เวลาจองชั่วคราวหมดอายุ กรุณาเลือกเวลาใหม่',
        OUTSIDE_OPERATING_HOURS: 'เวลานี้อยู่นอกเวลาทำการ 10:00-20:00',
        INVALID_DURATION: 'กรุณาเลือกแพ็กเกจ 60, 120 หรือ 180 นาที',
        MEMBER_NOT_FOUND: 'ไม่พบข้อมูลสมาชิก กรุณาเข้าสู่ระบบใหม่',
        PAYMENT_ALREADY_RECORDED: 'รายการนี้มีการชำระเงินแล้ว',
        IDEMPOTENCY_PAYLOAD_MISMATCH: 'พบคำขอซ้ำที่ข้อมูลไม่ตรงกัน กรุณารีเฟรชหน้า',
        BOOKING_STATE_DOES_NOT_ALLOW_ACTION: 'สถานะรายการจองไม่สามารถทำรายการนี้ได้',
        AUTH_REQUIRED: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่',
        PERMISSION_DENIED: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
        STAFF_PERMISSION_REQUIRED: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
        LANE_SELECTION_NOT_ALLOWED: 'ระบบจะจัดช่องยิงให้อัตโนมัติ กรุณาตรวจสอบเวลาอีกครั้ง',
        INVALID_DATE_FORMAT: 'กรุณาเลือกวันที่ในรูปแบบ YYYY-MM-DD',
        INVALID_TIME_FORMAT: 'กรุณาเลือกเวลาให้ถูกต้อง',
        PAYMENT_REQUIRED: 'ยังไม่พบข้อมูลชำระเงิน กรุณาลองใหม่อีกครั้ง',
        IDEMPOTENCY_KEY_REQUIRED: 'ระบบยังไม่พร้อมทำรายการ กรุณาลองใหม่อีกครั้ง',
        PAYMENT_PROVIDER_NOT_CONFIGURED: 'ระบบชำระเงิน Sandbox ยังไม่พร้อม กรุณาแจ้งพนักงาน',
        PAYMENT_PROVIDER_DISABLED: 'ระบบชำระเงินยังไม่เปิดให้ใช้งาน',
        PAYMENT_ENV_NOT_SANDBOX: 'ระบบชำระเงิน Sandbox ยังไม่พร้อม กรุณาแจ้งพนักงาน',
        PRODUCTION_PAYMENT_DISABLED: 'ระบบชำระเงินจริงยังไม่เปิดใช้งาน',
        BEAM_PAYMENT_CREATE_FAILED: 'สร้างรายการชำระเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
        PAYMENT_AMOUNT_MISMATCH: 'ยอดชำระเงินไม่ตรงกับรายการจอง กรุณาติดต่อพนักงาน',
        PAYMENT_CURRENCY_MISMATCH: 'สกุลเงินไม่ถูกต้อง กรุณาติดต่อพนักงาน',
        PAYMENT_PENDING: 'รอการชำระเงินจาก Beam',
        WEBHOOK_SIGNATURE_INVALID: 'ตรวจสอบรายการชำระเงินไม่สำเร็จ กรุณาติดต่อพนักงาน'
    };
    if (map[code]) return map[code];
    if (error?.message && !/^[A-Z0-9_ -]+$/.test(error.message)) return error.message;
    return 'ไม่สามารถทำรายการได้ กรุณาลองใหม่อีกครั้ง';
}

function setLoading(action, isLoading) {
    busyAction = isLoading ? action : '';
    ['archery-hold-btn', 'archery-confirm-btn'].forEach(id => {
        const button = $(id);
        if (!button) return;
        const disabledByAction =
            (id === 'archery-hold-btn' && action === 'hold')
            || (id === 'archery-confirm-btn' && action === 'confirm');
        if (isLoading && disabledByAction) button.disabled = true;
    });
}

function setAvailabilityControlsChecking(isChecking) {
    isCheckingAvailability = isChecking;
    const holdBtn = $('archery-hold-btn');
    if (holdBtn) {
        holdBtn.classList.toggle('is-loading', isChecking);
        holdBtn.setAttribute('aria-busy', isChecking ? 'true' : 'false');
    }
}

function restoreButtonStates() {
    const holdBtn = $('archery-hold-btn');
    const confirmBtn = $('archery-confirm-btn');
    const promoInput = $('archery-promo-code-input');
    const promoButton = $('archery-promo-apply-btn');
    if (promoInput) promoInput.disabled = !pricingSettingsReady || !!currentHold;
    if (promoButton) promoButton.disabled = !pricingSettingsReady || !!currentHold;
    if (holdBtn) {
        holdBtn.disabled = !pricingSettingsReady || isCheckingAvailability || !currentUser || !latestAvailability?.available || !!currentHold;
        holdBtn.setAttribute('aria-disabled', holdBtn.disabled ? 'true' : 'false');
        holdBtn.title = !pricingSettingsReady
            ? pricingStatusText()
            : !currentUser
            ? 'กรุณาเข้าสู่ระบบสมาชิกก่อนยืนยันการจอง'
            : isCheckingAvailability
                ? 'ระบบกำลังตรวจสอบเลนว่าง'
                : !latestAvailability?.available
                    ? 'เลือกวันและเวลาให้ระบบตรวจเลนว่างก่อน'
                    : currentHold
                        ? 'ยืนยันการจองแล้ว'
                        : '';
    }
    if (confirmBtn) {
        const paymentStatus = String(currentHold?.payment_status || '').toUpperCase();
        const bookingStatus = String(currentHold?.booking_status || currentHold?.status || '').toUpperCase();
        const paymentRequired = currentHold?.payment_required !== false;
        confirmBtn.textContent = bookingStatus === 'CONFIRMED'
            ? 'ดูใบยืนยัน'
            : paymentStatus === 'PENDING'
                ? 'เปิดหน้าชำระเงิน'
                : paymentRequired
                    ? 'ชำระเงิน'
                    : 'ยืนยันการจอง';
        confirmBtn.disabled = !currentHold
            || isHoldExpired(currentHold)
            || bookingStatus === 'CONFIRMED'
            || paymentStatus === 'PAID_ONLINE'
            || paymentStatus === 'PAID_PROMO'
            || paymentStatus === 'PAID_FREE'
            || paymentStatus === 'PAID_COUNTER'
            || paymentStatus === 'REFUNDED';
        confirmBtn.setAttribute('aria-disabled', confirmBtn.disabled ? 'true' : 'false');
        confirmBtn.title = !currentHold ? 'กรุณากดยืนยันการจองก่อนชำระเงิน' : '';
    }
}

function idempotencyKey(action, keyParts = []) {
    const pricing = calculateDraftPricing();
    const base = [
        action,
        currentUser?.uid || 'anonymous',
        selectedDate(),
        selectedStartTime(),
        packageMinutes(),
        partySize(),
        pricing.participantOptions.map(item => item.ability_option_id || '').join(','),
        pricing.equipment?.id || '',
        appliedArcheryPromoCode(),
        ...keyParts
    ].join(':');
    const browserCrypto = globalThis.crypto;
    const random = browserCrypto?.randomUUID ? browserCrypto.randomUUID() : String(Date.now()) + ':' + Math.random().toString(16).slice(2);
    return base + ':' + random;
}

function waitForApi(timeoutMs = 5000) {
    if (
        window.EdenApi?.getArcheryAvailability
        && window.EdenApi?.createArcheryHold
        && window.EdenApi?.createBeamArcheryPayment
        && window.EdenApi?.getArcheryPaymentStatus
    ) {
        return Promise.resolve(window.EdenApi);
    }
    return new Promise(resolve => {
        const started = Date.now();
        const timer = window.setInterval(() => {
            const ready = window.EdenApi?.getArcheryAvailability
                && window.EdenApi?.createArcheryHold
                && window.EdenApi?.createBeamArcheryPayment
                && window.EdenApi?.getArcheryPaymentStatus;
            if (ready || Date.now() - started > timeoutMs) {
                window.clearInterval(timer);
                resolve(ready ? window.EdenApi : null);
            }
        }, 80);
    });
}

function shouldAutoCheckAvailability() {
    if (currentHold) return false;
    return Boolean(
        $('archery-booking-form')
        && selectedDate()
        && selectedStartTime()
        && packageMinutes()
        && partySize()
        && pricingSettingsReady
    );
}

function scheduleAvailabilityRefresh({ immediate = false } = {}) {
    if (availabilityDebounceTimer) {
        window.clearTimeout(availabilityDebounceTimer);
        availabilityDebounceTimer = null;
    }
    if (!shouldAutoCheckAvailability()) return;
    if (isCheckingAvailability || busyAction) {
        availabilityCheckQueued = true;
        return;
    }
    setStatus('archery-status', 'กำลังเตรียมตรวจสอบเลนว่าง...', 'loading');
    availabilityDebounceTimer = window.setTimeout(() => {
        availabilityDebounceTimer = null;
        refreshAvailability();
    }, immediate ? 0 : AUTO_AVAILABILITY_DELAY_MS);
}

function fillTimeOptions() {
    const select = $('archery-start');
    if (!select) return;
    const selected = select.value;
    const duration = packageMinutes();
    const lastStart = (20 * 60) - duration;
    select.innerHTML = '';
    for (let minute = 10 * 60; minute <= lastStart; minute += 60) {
        const opt = document.createElement('option');
        opt.value = timeLabel(minute);
        opt.textContent = displayTime(timeLabel(minute));
        select.appendChild(opt);
    }
    if (selected && Array.from(select.options).some(opt => opt.value === selected)) {
        select.value = selected;
    }
}

function selectionPayload() {
    const duration = packageMinutes();
    const pricing = calculateDraftPricing();
    return {
        branch_id: BRANCH_ID,
        booking_date: selectedDate(),
        start_time: selectedStartTime(),
        duration_minutes: duration,
        package_code: packageCode(duration),
        party_size: pricing.partySize,
        ability_option_id: pricing.ability?.id || '',
        participant_options: pricing.participantOptions,
        equipment_option_id: pricing.equipment?.id || ''
    };
}

function summaryRows(rows) {
    return rows.map(([label, value]) => `<li><span>${escapeHTML(label)}</span><strong>${escapeHTML(value || '-')}</strong></li>`).join('');
}

function renderDraftSummaryLegacy() {
    const el = $('archery-hold-summary');
    if (!el || currentHold) return;
    const duration = packageMinutes();
    el.innerHTML = summaryRows([
        ['วันที่', selectedDate()],
        ['เวลา', displayTimeRange(selectedStartTime(), selectedEndTime())],
        ['แพ็กเกจ', duration + ' นาที'],
        ['ยอดรวม', money(packagePrice(duration) * partySize())]
    ]);
}

function renderPricingUnavailableSummary() {
    const el = $('archery-hold-summary');
    if (!el || currentHold) return;
    el.innerHTML = summaryRows([
        ['Date', selectedDate() || '-'],
        ['Time', selectedStartTime() ? displayTimeRange(selectedStartTime(), selectedEndTime()) : '-'],
        ['Pricing', pricingStatusText()]
    ]);
}

function renderDraftSummary() {
    const el = $('archery-hold-summary');
    if (!el || currentHold) return;
    if (!pricingSettingsReady) {
        renderPricingUnavailableSummary();
        return;
    }
    const duration = packageMinutes();
    const pricing = calculateDraftPricing();
    const discount = currentArcheryPromoDiscount(pricing);
    const rows = [
        ['Date', selectedDate()],
        ['Time', displayTimeRange(selectedStartTime(), selectedEndTime())],
        ['Package', duration + ' min'],
        ['People', String(pricing.partySize)],
        ['Lanes needed', String(pricing.requiredLaneCount)],
        ['Package / person', money(pricing.packageAmount)],
        ['Staff', staffSummaryText(pricing)],
        ['Equipment / person', `${optionDisplayLabel(pricing.equipment)} / ${money(pricing.equipmentAmount)}`]
    ];
    if (discount > 0) {
        rows.push(
            ['Subtotal', money(pricing.amountTotal)],
            [`Promo ${appliedArcheryPromoCode()}`, '-' + money(discount)],
            ['Total', money(roundMoney(pricing.amountTotal - discount))]
        );
    } else {
        rows.push(['Total', money(pricing.amountTotal)]);
    }
    el.innerHTML = summaryRows(rows);
}

function renderSuggestions(times = []) {
    const el = $('archery-suggestions');
    if (!el) return;
    if (!Array.isArray(times) || !times.length) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `
        <p>เวลาที่แนะนำ</p>
        <div class="archery-suggestion-row">
            ${times.map(time => `<button type="button" data-start-time="${escapeHTML(time)}">${escapeHTML(displayTime(time))}</button>`).join('')}
        </div>
    `;
    el.querySelectorAll('button[data-start-time]').forEach(button => {
        button.addEventListener('click', () => {
            const select = $('archery-start');
            if (select) select.value = button.getAttribute('data-start-time') || select.value;
            resetAvailabilityState();
            resetHoldState();
            scheduleAvailabilityRefresh({ immediate: true });
        });
    });
}

function renderAvailability(result) {
    const available = result?.available === true;
    const required = Number(result?.required_lane_count || partySize()) || 1;
    const availableCount = Number(result?.available_lane_count || 0) || 0;
    if (available) {
        setStatus('archery-status', 'เวลานี้ยังว่าง สามารถยืนยันการจองได้', 'success');
    } else {
        setStatus('archery-status', 'เวลานี้ถูกจองแล้ว กรุณาเลือกเวลาอื่น', 'error');
    }
    setStatus(
        'archery-status',
        available
            ? `เวลานี้ว่างพอสำหรับ ${required} เลน (${availableCount} เลนว่าง)`
            : `เลนว่างไม่พอ ต้องใช้ ${required} เลน แต่มีว่าง ${availableCount} เลน`,
        available ? 'success' : 'error'
    );
    renderSuggestions(result?.suggested_start_times || []);
    restoreButtonStates();
}

function participantStaffOptionHTML(selection = {}) {
    const withStaff = selection.experience === EXPERIENCE_FIRST_TIME ? firstTimeStaffOption() : experiencedStaffOption();
    const noStaff = experiencedNoStaffOption();
    const staffSelected = selection.staffChoice !== STAFF_NOT_REQUIRED || !noStaff;
    const rows = [];
    if (withStaff) {
        rows.push(`
            <option value="${STAFF_REQUIRED}" ${staffSelected ? 'selected' : ''}>
                ${bookingText('ต้องการ Staff', 'Staff required')} - ${money(withStaff.ratePerHour)} / ${bookingText('ชม.', 'hr')}
            </option>
        `);
    }
    if (noStaff) {
        rows.push(`
            <option value="${STAFF_NOT_REQUIRED}" ${!staffSelected ? 'selected' : ''}>
                ${bookingText('ไม่ต้องการ Staff', 'No Staff')} - ${money(0)}
            </option>
        `);
    }
    return rows.join('');
}

function renderParticipantOptions() {
    const el = $('archery-participant-options');
    if (!el) return;
    clearSkeleton(el);
    const selections = normalizeParticipantSelections();
    el.innerHTML = selections.map(selection => `
        <div class="archery-participant-row" data-participant-index="${selection.participantIndex}">
            <strong>${bookingText('ผู้เล่น', 'Player')} ${selection.participantIndex}</strong>
            <label>
                <span>${bookingText('ระดับ', 'Level')}</span>
                <select data-participant-field="experience">
                    <option value="${EXPERIENCE_FIRST_TIME}" ${selection.experience === EXPERIENCE_FIRST_TIME ? 'selected' : ''}>${bookingText('มือใหม่', 'First-time')}</option>
                    <option value="${EXPERIENCE_EXPERIENCED}" ${selection.experience === EXPERIENCE_EXPERIENCED ? 'selected' : ''}>${bookingText('เคยยิงแล้ว', 'Experienced')}</option>
                </select>
            </label>
            <label>
                <span>Staff</span>
                <select data-participant-field="staff" ${selection.experience === EXPERIENCE_FIRST_TIME ? 'disabled' : ''}>
                    ${participantStaffOptionHTML(selection)}
                </select>
            </label>
            ${selection.experience === EXPERIENCE_FIRST_TIME ? `<small>${bookingText('มือใหม่ต้องมี Staff ดูแลเท่านั้น', 'First-time players must have Staff supervision')}</small>` : ''}
        </div>
    `).join('');

    el.querySelectorAll('select').forEach(select => {
        select.addEventListener('change', () => {
            const row = select.closest('[data-participant-index]');
            const index = Math.max(0, Number(row?.dataset.participantIndex || 1) - 1);
            const current = participantSelections[index] || { participantIndex: index + 1 };
            if (select.dataset.participantField === 'experience') {
                current.experience = select.value === EXPERIENCE_EXPERIENCED ? EXPERIENCE_EXPERIENCED : EXPERIENCE_FIRST_TIME;
                if (current.experience === EXPERIENCE_FIRST_TIME) current.staffChoice = STAFF_REQUIRED;
            } else if (select.dataset.participantField === 'staff') {
                current.staffChoice = select.value === STAFF_NOT_REQUIRED ? STAFF_NOT_REQUIRED : STAFF_REQUIRED;
            }
            participantSelections[index] = current;
            renderParticipantOptions();
            resetAvailabilityState();
            resetHoldState();
            renderDraftSummary();
            scheduleAvailabilityRefresh();
        });
    });
}

function renderOptionCards(containerId, inputName, options = [], formatter = () => '') {
    const el = $(containerId);
    if (!el) return;
    clearSkeleton(el);
    const active = activeItems(options);
    el.innerHTML = active.map((option, index) => `
        <label class="archery-choice-card">
            <input type="radio" name="${escapeHTML(inputName)}" value="${escapeHTML(option.id)}" ${index === 0 ? 'checked' : ''} required>
            <strong>${escapeHTML(optionDisplayLabel(option))}</strong>
            <small>${escapeHTML(formatter(option))}</small>
        </label>
    `).join('');
    el.querySelectorAll('input[type="radio"]').forEach(input => {
        input.addEventListener('change', () => {
            resetAvailabilityState();
            resetHoldState();
            renderDraftSummary();
            scheduleAvailabilityRefresh();
        });
    });
}

function renderChoiceGridSkeleton() {
    renderSkeleton($('archery-participant-options'), 'stats', { count: Math.max(1, partySize()) });
    renderSkeleton($('archery-equipment-options'), 'stats', { count: 3 });
}

function renderSummaryListSkeleton(id, rows = 6) {
    const el = $(id);
    if (!el) return;
    el.dataset.edenSkeleton = 'summary-list';
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = Array.from({ length: rows }, () => `
        <li class="archery-summary-row" aria-hidden="true">
            <span class="eden-skeleton-line short"></span>
            <span class="eden-skeleton-line medium"></span>
        </li>
    `).join('');
}

function clearSummaryListSkeleton(id) {
    const el = $(id);
    if (!el) return;
    delete el.dataset.edenSkeleton;
    el.removeAttribute('aria-busy');
}

function renderPricingUnavailable() {
    const packageSelect = $('archery-package');
    const participantList = $('archery-participant-options');
    const equipmentList = $('archery-equipment-options');
    const message = pricingStatusText();
    if (packageSelect) {
        packageSelect.innerHTML = `<option value="">${escapeHTML(bookingText('ไม่พร้อมใช้งาน', 'Unavailable'))}</option>`;
        packageSelect.disabled = true;
    }
    if (participantList) {
        clearSkeleton(participantList);
        participantList.innerHTML = `<p class="archery-pricing-warning">${escapeHTML(message)}</p>`;
    }
    if (equipmentList) {
        clearSkeleton(equipmentList);
        equipmentList.innerHTML = `<p class="archery-pricing-warning">${escapeHTML(message)}</p>`;
    }
    renderPricingUnavailableSummary();
    setStatus('archery-status', message, 'error');
    restoreButtonStates();
}

function renderPricingOptions() {
    if (!pricingSettingsReady) {
        renderPricingUnavailable();
        return;
    }
    const packageSelect = $('archery-package');
    if (packageSelect) {
        packageSelect.disabled = false;
        const selected = packageSelect.value;
        packageSelect.innerHTML = activeItems(archeryPricingConfig.packages).map(item => (
            `<option value="${escapeHTML(item.durationMinutes)}">${escapeHTML(item.title || item.durationMinutes + ' min')} - ${escapeHTML(money(item.price))}</option>`
        )).join('');
        if (selected && Array.from(packageSelect.options).some(option => option.value === selected)) packageSelect.value = selected;
    }
    renderParticipantOptions();
    renderOptionCards('archery-equipment-options', 'archery-equipment', archeryPricingConfig.equipmentOptions, option => (
        option.ratePerHour ? `${money(option.ratePerHour)} / ชม.` : 'ไม่มีค่าใช้จ่ายเพิ่ม'
    ));
    fillTimeOptions();
    renderDraftSummary();
}

async function loadPricingOptions() {
    renderChoiceGridSkeleton();
    pricingSettingsReady = false;
    pricingSettingsError = '';
    try {
        const snap = db ? await getDoc(doc(db, 'site_settings', 'archery')) : null;
        if (!snap?.exists()) throw new Error('ARCHERY_PRICING_CONFIG_MISSING');
        const nextConfig = normalizePricingConfig(snap.data());
        if (!hasRequiredPricingConfig(nextConfig)) throw new Error('ARCHERY_PRICING_CONFIG_INCOMPLETE');
        archeryPricingConfig = nextConfig;
        pricingSettingsReady = true;
    } catch (error) {
        console.warn('Unable to load archery pricing settings:', error);
        archeryPricingConfig = EMPTY_PRICING_CONFIG;
        pricingSettingsReady = false;
        pricingSettingsError = pricingUnavailableText();
    }
    renderPricingOptions();
}

function resetAvailabilityState() {
    if (availabilityDebounceTimer) {
        window.clearTimeout(availabilityDebounceTimer);
        availabilityDebounceTimer = null;
    }
    availabilityCheckQueued = false;
    latestAvailability = null;
    renderSuggestions([]);
    setStatus('archery-status', '');
    restoreButtonStates();
}

function sanitizeHoldResponse(hold = {}) {
    const pricing = calculateDraftPricing();
    const breakdown = hold.amount_breakdown || {};
    const amountTotal = firstFiniteNumber(hold.amount_total, hold.totalAmount, breakdown.total, pricing.amountTotal);
    const discount = firstFiniteNumber(hold.discount_total, hold.discount, breakdown.discount, 0);
    const subtotal = firstFiniteNumber(
        hold.total_before_discount,
        hold.subtotal_amount,
        hold.amount_before_discount,
        breakdown.subtotal,
        amountTotal + discount
    );
    const promoApplications = Array.isArray(hold.promoApplications)
        ? hold.promoApplications
        : Array.isArray(hold.promo_applications)
            ? hold.promo_applications
            : [];
    const promotionLineAllocations = Array.isArray(hold.promotionLineAllocations)
        ? hold.promotionLineAllocations
        : Array.isArray(hold.promotion_line_allocations)
            ? hold.promotion_line_allocations
            : [];
    const participantOptions = Array.isArray(hold.participant_options)
        ? hold.participant_options
        : Array.isArray(hold.participantOptions)
            ? hold.participantOptions
            : pricing.participantOptions;
    const staffCount = firstFiniteNumber(hold.staff_count, hold.staffCount, breakdown.staff_count, pricing.staffCount);
    return {
        booking_id: hold.booking_id || hold.id || '',
        branch_id: hold.branch_id || BRANCH_ID,
        service_type: 'ARCHERY',
        booking_date: hold.booking_date || selectedDate(),
        start_time: hold.start_time || selectedStartTime(),
        end_time: hold.end_time || selectedEndTime(),
        duration_minutes: hold.duration_minutes || packageMinutes(),
        package_code: hold.package_code || packageCode(hold.duration_minutes || packageMinutes()),
        booking_status: hold.booking_status || hold.status || 'HELD',
        payment_status: hold.payment_status || 'UNPAID',
        payment_id: hold.payment_id || hold.payment?.payment_id || '',
        payment_link_url: hold.payment_link_url || hold.payment?.payment_link_url || '',
        provider_ref: hold.provider_ref || hold.payment?.provider_ref || '',
        beam_payment_link_id: hold.beam_payment_link_id || hold.payment?.beam_payment_link_id || '',
        payment_environment: hold.payment_environment || hold.payment?.payment_environment || 'sandbox',
        amount_total: amountTotal,
        totalAmount: amountTotal,
        amount_before_discount: subtotal,
        total_before_discount: subtotal,
        subtotal_amount: subtotal,
        discount,
        discount_total: discount,
        promo_code: hold.promo_code || hold.promoCode || '',
        promoCode: hold.promoCode || hold.promo_code || '',
        promoApplications,
        promo_applications: promoApplications,
        promotionLineAllocations,
        promotion_line_allocations: promotionLineAllocations,
        party_size: hold.party_size || hold.partySize || pricing.partySize,
        required_lane_count: hold.required_lane_count || hold.requiredLaneCount || pricing.requiredLaneCount,
        assigned_resource_ids: Array.isArray(hold.assigned_resource_ids) ? hold.assigned_resource_ids : [],
        assigned_lane_numbers: Array.isArray(hold.assigned_lane_numbers) ? hold.assigned_lane_numbers : [],
        package_amount: firstFiniteNumber(hold.package_amount, breakdown.package, pricing.packageTotal),
        ability_option_id: hold.ability_option_id || pricing.ability?.id || '',
        ability_label: hold.ability_label || optionDisplayLabel(pricing.ability),
        participant_options: participantOptions,
        participantOptions,
        staff_count: staffCount,
        staffCount,
        coach_required: hold.coach_required === true || staffCount > 0,
        coach_rate_per_hour: firstFiniteNumber(hold.coach_rate_per_hour, pricing.ability?.ratePerHour, 0),
        coach_amount: firstFiniteNumber(hold.coach_amount, breakdown.coach, pricing.coachTotal),
        equipment_option_id: hold.equipment_option_id || pricing.equipment?.id || '',
        equipment_label: hold.equipment_label || optionDisplayLabel(pricing.equipment),
        equipment_rate_per_hour: firstFiniteNumber(hold.equipment_rate_per_hour, pricing.equipment?.ratePerHour, 0),
        equipment_amount: firstFiniteNumber(hold.equipment_amount, breakdown.equipment, pricing.equipmentTotal),
        amount_breakdown: {
            ...breakdown,
            package_per_person: firstFiniteNumber(breakdown.package_per_person, pricing.packageAmount),
            coach_per_person: firstFiniteNumber(breakdown.coach_per_person, pricing.coachAmount),
            equipment_per_person: firstFiniteNumber(breakdown.equipment_per_person, pricing.equipmentAmount),
            per_person_total: firstFiniteNumber(breakdown.per_person_total, pricing.perPersonTotal),
            party_size: firstFiniteNumber(breakdown.party_size, pricing.partySize),
            required_lane_count: firstFiniteNumber(breakdown.required_lane_count, pricing.requiredLaneCount),
            staff_count: staffCount,
            participant_options: participantOptions,
            package: firstFiniteNumber(breakdown.package, pricing.packageTotal),
            coach: firstFiniteNumber(breakdown.coach, pricing.coachTotal),
            equipment: firstFiniteNumber(breakdown.equipment, pricing.equipmentTotal),
            subtotal,
            discount,
            total: amountTotal
        },
        pricing_version: hold.pricing_version || archeryPricingConfig.version || '',
        expires_at: hold.expires_at || new Date(Date.now() + HOLD_MINUTES * 60 * 1000).toISOString(),
        payment_required: hold.payment_required !== false && amountTotal > 0
    };
}

function saveHold(hold) {
    localStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(hold));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hold));
}

function readStoredHold() {
    try {
        const hold = JSON.parse(localStorage.getItem(HOLD_STORAGE_KEY) || 'null');
        return hold && typeof hold === 'object' ? hold : null;
    } catch (_) {
        return null;
    }
}

function resetHoldState() {
    currentHold = null;
    holdIdempotencyKey = '';
    beamPaymentIdempotencyKey = '';
    clearArcheryPromoAfterSelectionChange();
    localStorage.removeItem(HOLD_STORAGE_KEY);
    window.clearInterval(holdTimer);
    holdTimer = null;
    stopPaymentPolling();
    setStatus('archery-confirm-status', '');
    const countdown = $('archery-countdown');
    if (countdown) countdown.textContent = '';
    renderDraftSummary();
    restoreButtonStates();
}

function holdExpiresAt(hold) {
    const parsed = new Date(hold?.expires_at || 0);
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function isHoldExpired(hold) {
    return !hold?.booking_id || holdExpiresAt(hold) <= Date.now();
}

function renderCountdown() {
    const countdown = $('archery-countdown');
    if (!countdown || !currentHold) return;
    if (String(currentHold.booking_status || currentHold.status || '').toUpperCase() === 'CONFIRMED') {
        countdown.textContent = '';
        window.clearInterval(holdTimer);
        holdTimer = null;
        return;
    }
    const remaining = Math.max(0, Math.floor((holdExpiresAt(currentHold) - Date.now()) / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    countdown.textContent = remaining
        ? `Hold จะหมดอายุใน ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : 'เวลาจองชั่วคราวหมดอายุ กรุณาเลือกเวลาใหม่';
    countdown.classList.toggle('error', remaining === 0);
    countdown.classList.toggle('success', remaining > 0);
    if (!remaining) {
        window.clearInterval(holdTimer);
        holdTimer = null;
        stopPaymentPolling();
        setStatus('archery-confirm-status', userMessage({ code: 'HOLD_EXPIRED' }), 'error');
        restoreButtonStates();
    }
}

function startCountdown() {
    window.clearInterval(holdTimer);
    renderCountdown();
    holdTimer = window.setInterval(renderCountdown, 1000);
}

function stopPaymentPolling() {
    if (paymentPollTimer) {
        window.clearInterval(paymentPollTimer);
        paymentPollTimer = null;
    }
}

function safeHttpUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
    } catch (_) {
        return '';
    }
}

function renderPaymentPending(paymentLinkUrl = '') {
    const el = $('archery-confirm-status');
    if (!el) return;
    const safeUrl = safeHttpUrl(paymentLinkUrl);
    el.classList.remove('error');
    el.classList.add('success');
    el.innerHTML = safeUrl
        ? `รอชำระเงินผ่าน Beam <a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">เปิดหน้าชำระเงิน</a>`
        : 'รอชำระเงินผ่าน Beam';
}

function mergePaymentStatus(result = {}) {
    if (!currentHold) return null;
    const payment = result.payment || {};
    currentHold = {
        ...currentHold,
        booking_status: result.booking_status || currentHold.booking_status,
        payment_status: result.payment_status || payment.payment_status || currentHold.payment_status,
        payment_id: payment.payment_id || currentHold.payment_id || '',
        payment_link_url: payment.payment_link_url || currentHold.payment_link_url || '',
        provider_ref: payment.provider_ref || currentHold.provider_ref || '',
        beam_payment_link_id: payment.beam_payment_link_id || currentHold.beam_payment_link_id || ''
    };
    saveHold(currentHold);
    renderHoldSummary(currentHold);
    return currentHold;
}

function finishConfirmedPayment(result = {}) {
    if (!currentHold) return;
    const next = {
        ...currentHold,
        booking_status: result.booking_status || 'CONFIRMED',
        payment_status: result.payment_status || 'PAID_ONLINE',
        payment_id: result.payment_id || result.payment?.payment_id || currentHold.payment_id || ''
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    localStorage.removeItem(HOLD_STORAGE_KEY);
    stopPaymentPolling();
    window.location.href = '/archery/booking/confirm?id=' + encodeURIComponent(next.booking_id);
}

async function refreshPaymentStatus({ redirectOnConfirmed = false } = {}) {
    if (!currentHold?.booking_id) return null;
    const api = await waitForApi();
    if (!api?.getArcheryPaymentStatus) return null;
    const result = await api.getArcheryPaymentStatus({
        branch_id: currentHold.branch_id || BRANCH_ID,
        booking_id: currentHold.booking_id
    });
    mergePaymentStatus(result);
    const paymentStatus = String(result.payment_status || currentHold.payment_status || '').toUpperCase();
    const bookingStatus = String(result.booking_status || currentHold.booking_status || '').toUpperCase();
    if (redirectOnConfirmed && bookingStatus === 'CONFIRMED' && (paymentStatus === 'PAID_ONLINE' || paymentStatus === 'PAID_PROMO' || paymentStatus === 'PAID_FREE')) {
        finishConfirmedPayment(result);
        return result;
    }
    if (paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED') {
        stopPaymentPolling();
        setStatus('archery-confirm-status', 'การชำระเงินไม่สำเร็จ กรุณาลองชำระเงินใหม่', 'error');
    } else if (paymentStatus === 'PENDING') {
        renderPaymentPending(currentHold.payment_link_url);
    }
    restoreButtonStates();
    return result;
}

function startPaymentPolling({ immediate = false } = {}) {
    stopPaymentPolling();
    if (immediate) {
        refreshPaymentStatus({ redirectOnConfirmed: true }).catch(error => {
            setStatus('archery-confirm-status', userMessage(error), 'error');
        });
    }
    paymentPollTimer = window.setInterval(() => {
        refreshPaymentStatus({ redirectOnConfirmed: true }).catch(error => {
            setStatus('archery-confirm-status', userMessage(error), 'error');
        });
    }, 5000);
}

function renderHoldSummaryLegacy(hold) {
    const el = $('archery-hold-summary');
    if (!el || !hold) return;
    const duration = normalizeDuration(hold.duration_minutes);
    el.innerHTML = summaryRows([
        ['Booking ID', hold.booking_id],
        ['วันที่', hold.booking_date],
        ['เวลา', displayTimeRange(hold.start_time, hold.end_time || timeLabel(minutesFromTime(hold.start_time) + duration))],
        ['แพ็กเกจ', duration + ' นาที'],
        ['ยอดรวม', money(hold.amount_total || packagePrice(duration))],
        ['Payment', hold.payment_status || 'UNPAID']
    ]);
    startCountdown();
}

function renderHoldSummary(hold) {
    const el = $('archery-hold-summary');
    if (!el || !hold) return;
    const duration = normalizeDuration(hold.duration_minutes);
    const breakdown = hold.amount_breakdown || {};
    const total = firstFiniteNumber(hold.amount_total, hold.totalAmount, breakdown.total, packagePrice(duration));
    const discount = firstFiniteNumber(hold.discount_total, hold.discount, breakdown.discount, 0);
    const subtotal = firstFiniteNumber(
        hold.total_before_discount,
        hold.subtotal_amount,
        hold.amount_before_discount,
        breakdown.subtotal,
        total + discount
    );
    const promoCode = normalizePromoCode(hold.promo_code || hold.promoCode);
    const staffCount = firstFiniteNumber(hold.staff_count, hold.staffCount, breakdown.staff_count, 0);
    const coachTotal = firstFiniteNumber(hold.coach_amount, breakdown.coach, 0);
    const laneNumbers = Array.isArray(hold.assigned_lane_numbers) && hold.assigned_lane_numbers.length
        ? hold.assigned_lane_numbers.map(number => `Lane ${number}`).join(', ')
        : (Array.isArray(hold.assigned_resource_ids) && hold.assigned_resource_ids.length
            ? hold.assigned_resource_ids.map(id => String(id || '').match(/(\d{2})$/)?.[1]).filter(Boolean).map(number => `Lane ${Number(number)}`).join(', ')
            : '');
    const rows = [
        ['Booking ID', hold.booking_id],
        ['Date', hold.booking_date],
        ['Time', displayTimeRange(hold.start_time, hold.end_time || timeLabel(minutesFromTime(hold.start_time) + duration))],
        ['Package', duration + ' min'],
        ['People', String(hold.party_size || 1)],
        ['Lanes needed', String(hold.required_lane_count || hold.party_size || 1)],
        ['Assigned lanes', laneNumbers || '-'],
        ['Package / person', money(breakdown.package_per_person || packagePrice(duration))],
        ['Staff', `${staffCount} people / ${money(coachTotal)}`],
        ['Equipment / person', `${optionDisplayLabel({ id: hold.equipment_option_id, label: hold.equipment_label })} / ${money(breakdown.equipment_per_person || 0)}`]
    ];
    if (discount > 0) {
        rows.push(
            ['Subtotal', money(subtotal)],
            [`Promo ${promoCode || ''}`.trim(), '-' + money(discount)],
            ['Total', money(total)]
        );
    } else {
        rows.push(['Total', money(total)]);
    }
    rows.push(['Payment', hold.payment_status || 'UNPAID']);
    el.innerHTML = summaryRows(rows);
    const promoInput = $('archery-promo-code-input');
    if (promoInput && promoCode) promoInput.value = promoCode;
    startCountdown();
}

async function fillMemberState(user) {
    const authState = $('archery-auth-state');
    const loginPanel = $('archery-login-panel');
    const loginLink = $('archery-login-link');
    if (!user) {
        if (authState) authState.textContent = 'กรุณาเข้าสู่ระบบด้วยสมาชิก Eden เดิมก่อนจอง';
        if (loginPanel) loginPanel.hidden = false;
        if (loginLink) loginLink.href = '/login?next=' + encodeURIComponent('/archery/booking');
        restoreButtonStates();
        return;
    }
    if (loginPanel) loginPanel.hidden = true;
    let label = user.email || user.phoneNumber || user.uid;
    try {
        const snap = db ? await getDoc(doc(db, 'users', user.uid)) : null;
        const profile = snap?.exists() ? snap.data() || {} : {};
        label = profile.displayName || profile.display_name || profile.email || profile.phone || label;
    } catch (_) {
    }
    if (authState) authState.textContent = 'จองด้วยสมาชิก Eden: ' + label;
    restoreButtonStates();
}

async function refreshAvailability(event) {
    if (event) event.preventDefault();
    if (!shouldAutoCheckAvailability()) {
        restoreButtonStates();
        return;
    }
    if (isCheckingAvailability || busyAction) {
        availabilityCheckQueued = true;
        return;
    }
    const api = await waitForApi();
    if (!api?.getArcheryAvailability) {
        setStatus('archery-status', 'ระบบยังไม่พร้อม กรุณาลองใหม่อีกครั้ง', 'error');
        return;
    }
    try {
        setLoading('availability', true);
        setAvailabilityControlsChecking(true);
        latestAvailability = null;
        restoreButtonStates();
        setStatus('archery-status', 'กำลังตรวจสอบเลนว่าง...', 'loading');
        latestAvailability = await api.getArcheryAvailability(selectionPayload());
        renderAvailability(latestAvailability);
        renderDraftSummary();
    } catch (error) {
        latestAvailability = null;
        renderSuggestions([]);
        setStatus('archery-status', 'ระบบยังไม่พร้อม กรุณาลองใหม่อีกครั้ง', 'error');
    } finally {
        setAvailabilityControlsChecking(false);
        setLoading('availability', false);
        restoreButtonStates();
        if (availabilityCheckQueued) {
            availabilityCheckQueued = false;
            scheduleAvailabilityRefresh({ immediate: true });
        }
    }
}

async function createHold(event) {
    event.preventDefault();
    if (busyAction) return;
    if (!currentUser) {
        setStatus('archery-status', 'กรุณาเข้าสู่ระบบสมาชิกก่อนจอง', 'error');
        window.location.href = '/login?next=' + encodeURIComponent('/archery/booking');
        return;
    }
    if (!pricingSettingsReady) {
        setStatus('archery-status', pricingStatusText(), 'error');
        restoreButtonStates();
        return;
    }
    if (!latestAvailability?.available) {
        scheduleAvailabilityRefresh({ immediate: true });
        setStatus('archery-status', 'กรุณารอให้ระบบตรวจสอบเลนว่างก่อนยืนยันการจอง', 'error');
        restoreButtonStates();
        return;
    }
    const promoCodeInput = currentArcheryPromoInputCode();
    if (promoCodeInput && appliedArcheryPromoCode() !== promoCodeInput) {
        const applied = await applyArcheryPromoCode();
        if (!applied) {
            restoreButtonStates();
            return;
        }
    }
    setLoading('hold', true);
    const api = await waitForApi();
    if (!api?.createArcheryHold) {
        setStatus('archery-status', 'ระบบจองยังไม่พร้อม กรุณารีเฟรชหน้า', 'error');
        setLoading('hold', false);
        restoreButtonStates();
        return;
    }
    try {
        setStatus('archery-status', 'กำลังล็อกเวลาจองชั่วคราว...');
        holdIdempotencyKey = holdIdempotencyKey || idempotencyKey('createArcheryHold');
        const promoCode = appliedArcheryPromoCode();
        const hold = await api.createArcheryHold({
            ...selectionPayload(),
            member_id: currentUser.uid,
            promo_code: promoCode,
            promoCode,
            idempotency_key: holdIdempotencyKey
        });
        currentHold = sanitizeHoldResponse(hold);
        saveHold(currentHold);
        renderHoldSummary(currentHold);
        if (String(currentHold.booking_status || currentHold.status || '').toUpperCase() === 'CONFIRMED') {
            setStatus('archery-status', 'จองฟรีสำเร็จแล้ว', 'success');
            finishConfirmedPayment({
                booking_status: currentHold.booking_status,
                payment_status: currentHold.payment_status || 'PAID_PROMO',
                payment_id: currentHold.payment_id || ''
            });
            return;
        }
        setStatus('archery-status', 'ล็อกเวลาจองชั่วคราวแล้ว กรุณายืนยันภายใน 10 นาที', 'success');
        setStatus('archery-confirm-status', 'กดชำระเงินเพื่อเปิด Beam');
    } catch (error) {
        currentHold = null;
        latestAvailability = null;
        localStorage.removeItem(HOLD_STORAGE_KEY);
        renderSuggestions([]);
        if (String(error?.code || error?.error || '').toUpperCase().match(/PROMO|ARCHERY_TOTAL_INVALID/)) {
            clearArcheryPromo({ message: promoErrorMessage(error), type: 'error' });
        }
        setStatus('archery-status', userMessage(error), 'error');
    } finally {
        setLoading('hold', false);
        restoreButtonStates();
    }
}

async function startBeamPayment() {
    if (busyAction) return;
    if (!currentHold?.booking_id) {
        setStatus('archery-confirm-status', 'กรุณากดยืนยันการจองก่อนชำระเงิน', 'error');
        restoreButtonStates();
        return;
    }
    if (String(currentHold.booking_status || currentHold.status || '').toUpperCase() === 'CONFIRMED') {
        finishConfirmedPayment({
            booking_status: currentHold.booking_status,
            payment_status: currentHold.payment_status || 'PAID_PROMO',
            payment_id: currentHold.payment_id || ''
        });
        return;
    }
    setLoading('confirm', true);
    if (isHoldExpired(currentHold)) {
        setStatus('archery-confirm-status', userMessage({ code: 'HOLD_EXPIRED' }), 'error');
        setLoading('confirm', false);
        restoreButtonStates();
        return;
    }
    const existingUrl = safeHttpUrl(currentHold.payment_link_url);
    if (String(currentHold.payment_status || '').toUpperCase() === 'PENDING' && existingUrl) {
        renderPaymentPending(existingUrl);
        window.open(existingUrl, '_blank', 'noopener,noreferrer');
        startPaymentPolling({ immediate: true });
        setLoading('confirm', false);
        restoreButtonStates();
        return;
    }
    const api = await waitForApi();
    if (!api?.createBeamArcheryPayment) {
        setStatus('archery-confirm-status', 'ระบบจองยังไม่พร้อม กรุณารีเฟรชหน้า', 'error');
        setLoading('confirm', false);
        restoreButtonStates();
        return;
    }
    try {
        setStatus('archery-confirm-status', 'กำลังสร้างรายการชำระเงิน Beam...');
        beamPaymentIdempotencyKey = beamPaymentIdempotencyKey || idempotencyKey('createBeamArcheryPayment', [currentHold.booking_id]);
        const result = await api.createBeamArcheryPayment({
            branch_id: currentHold.branch_id || BRANCH_ID,
            booking_id: currentHold.booking_id,
            idempotency_key: beamPaymentIdempotencyKey
        });
        currentHold = {
            ...currentHold,
            payment_status: result.payment_status || 'PENDING',
            payment_id: result.payment_id || currentHold.payment_id || '',
            payment_link_url: result.payment_link_url || currentHold.payment_link_url || '',
            provider_ref: result.provider_ref || currentHold.provider_ref || '',
            beam_payment_link_id: result.beam_payment_link_id || currentHold.beam_payment_link_id || '',
            payment_environment: result.payment_environment || 'sandbox'
        };
        saveHold(currentHold);
        renderHoldSummary(currentHold);
        const paymentUrl = safeHttpUrl(currentHold.payment_link_url);
        renderPaymentPending(paymentUrl);
        if (paymentUrl) window.open(paymentUrl, '_blank', 'noopener,noreferrer');
        startPaymentPolling({ immediate: true });
    } catch (error) {
        setStatus('archery-confirm-status', userMessage(error), 'error');
    } finally {
        setLoading('confirm', false);
        restoreButtonStates();
    }
}

function initBookingPage() {
    const form = $('archery-booking-form');
    if (!form) return;
    const dateInput = $('archery-date');
    if (dateInput) {
        dateInput.min = todayISO();
        dateInput.value = dateInput.value || todayISO();
    }
    loadPricingOptions().then(() => {
        if (!currentHold) scheduleAvailabilityRefresh({ immediate: true });
    });
    ['archery-date', 'archery-start', 'archery-package', 'archery-party-size'].forEach(id => {
        const el = $(id);
        if (!el) return;
        el.addEventListener('change', () => {
            if (id === 'archery-package') fillTimeOptions();
            if (id === 'archery-party-size') renderParticipantOptions();
            resetAvailabilityState();
            resetHoldState();
            renderDraftSummary();
            scheduleAvailabilityRefresh();
        });
    });
    form.addEventListener('submit', createHold);
    $('archery-confirm-btn')?.addEventListener('click', startBeamPayment);
    $('archery-promo-apply-btn')?.addEventListener('click', applyArcheryPromoCode);
    const promoInput = $('archery-promo-code-input');
    if (promoInput) {
        promoInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                applyArcheryPromoCode(event);
            }
        });
        promoInput.addEventListener('input', () => {
            if (appliedArcheryPromo && currentArcheryPromoInputCode() !== appliedArcheryPromoCode()) {
                archeryPromoValidationToken += 1;
                holdIdempotencyKey = '';
                appliedArcheryPromo = null;
                setArcheryPromoMessage('');
                renderDraftSummary();
            }
        });
    }
    const stored = readStoredHold();
    if (stored && !isHoldExpired(stored)) {
        currentHold = stored;
        renderHoldSummary(currentHold);
        if (String(currentHold.payment_status || '').toUpperCase() === 'PENDING') {
            renderPaymentPending(currentHold.payment_link_url);
            startPaymentPolling({ immediate: true });
        }
    } else {
        localStorage.removeItem(HOLD_STORAGE_KEY);
        renderDraftSummary();
    }
    restoreButtonStates();
    if (!currentHold) scheduleAvailabilityRefresh({ immediate: true });
}

function bookingStatusLabel(booking) {
    const status = String(booking.booking_status || booking.status || '').toUpperCase();
    const payment = String(booking.payment_status || booking.paymentStatus || '').toUpperCase();
    if (payment === 'PAID_ONLINE') return 'Paid Online';
    if (payment === 'PAID_COUNTER') return 'Paid Counter';
    if (payment === 'REFUNDED') return 'Refunded';
    if (status === 'CONFIRMED') return 'Confirmed';
    if (status === 'CHECKED_IN') return 'Checked-in';
    if (status === 'COMPLETED') return 'Completed';
    if (status === 'CANCELLED') return 'Cancelled';
    if (status === 'NO_SHOW') return 'No-show';
    if (status === 'HELD') return 'Held';
    return payment || status || 'Pending';
}

function bookingDuration(booking) {
    return normalizeDuration(booking.duration_minutes || booking.package_minutes || String(booking.package_code || '').replace(/\D/g, ''));
}

function renderConfirmPageBooking(booking) {
    const summary = $('archery-confirm-summary');
    clearSummaryListSkeleton('archery-confirm-summary');
    clearSkeleton($('archery-qr'));
    const duration = bookingDuration(booking);
    const bookingId = booking.id || booking.booking_id || '';
    const bookingDate = booking.booking_date || booking.date || '';
    const startTime = booking.start_time || booking.startTime || '';
    const endTime = booking.end_time || booking.endTime || (startTime ? timeLabel(minutesFromTime(startTime) + duration) : '');
    const party = Number(booking.party_size || booking.partySize || 1) || 1;
    const laneNumbers = Array.isArray(booking.assigned_lane_numbers) && booking.assigned_lane_numbers.length
        ? booking.assigned_lane_numbers.map(number => `Lane ${number}`).join(', ')
        : (Array.isArray(booking.assigned_resource_ids) && booking.assigned_resource_ids.length
            ? booking.assigned_resource_ids.map(id => String(id || '').match(/(\d{2})$/)?.[1]).filter(Boolean).map(number => `Lane ${Number(number)}`).join(', ')
            : '');
    if (summary) {
        summary.innerHTML = summaryRows([
            ['Booking ID', bookingId],
            ['วันที่', bookingDate],
            ['เวลา', displayTimeRange(startTime, endTime)],
            ['แพ็กเกจ', duration + ' นาที'],
            ['People', String(party)],
            ['Lanes', laneNumbers || '-'],
            ['Payment status', booking.payment_status || booking.paymentStatus || '-'],
            ['สถานะ', bookingStatusLabel(booking)]
        ]);
    }
    setStatus('archery-confirm-page-status', 'ยืนยันการจองสำเร็จ รายการนี้แสดงในโปรไฟล์สมาชิกแล้ว', 'success');
    const qrRoot = $('archery-qr');
    if (qrRoot && typeof qrcodeFactory === 'function') {
        const payload = JSON.stringify({
            type: 'EDEN_ARCHERY_BOOKING',
            booking_id: bookingId,
            booking_date: bookingDate,
            start_time: startTime,
            duration_minutes: duration,
            payment_status: booking.payment_status || booking.paymentStatus || ''
        });
        const qr = qrcodeFactory(0, 'M');
        qr.addData(payload);
        qr.make();
        qrRoot.innerHTML = `<img src="${qr.createDataURL(8, 1)}" alt="Archery booking QR">`;
        const payloadEl = $('archery-qr-payload');
        if (payloadEl) payloadEl.textContent = payload;
    }
}

async function initConfirmPage(user) {
    if (!$('archery-confirm-summary')) return;
    if (!user) {
        setStatus('archery-confirm-page-status', 'กรุณาเข้าสู่ระบบสมาชิกเพื่อดูรายการจอง', 'error');
        return;
    }
    const params = new URLSearchParams(window.location.search);
    const stored = (() => {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { return null; }
    })();
    const bookingId = params.get('id') || stored?.booking_id || stored?.id || '';
    if (!bookingId) {
        setStatus('archery-confirm-page-status', 'ไม่พบรหัสการจอง', 'error');
        return;
    }
    renderSummaryListSkeleton('archery-confirm-summary', 7);
    renderSkeleton($('archery-qr'), 'qr');
    try {
        const snap = await getDoc(doc(db, 'bookings', bookingId));
        if (!snap.exists()) throw new Error('BOOKING_NOT_FOUND');
        const booking = { id: snap.id, ...snap.data() };
        renderConfirmPageBooking(booking);
    } catch (error) {
        if (stored && (stored.booking_id || stored.id) === bookingId) {
            renderConfirmPageBooking({ id: bookingId, ...stored });
            return;
        }
        setStatus('archery-confirm-page-status', userMessage(error), 'error');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initBookingPage();
    onAuthStateChanged(auth, async user => {
        currentUser = user || null;
        await fillMemberState(currentUser);
        await initConfirmPage(currentUser);
    });
});
