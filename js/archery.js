import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import qrcodeFactory from './qrcode-generator.esm.js';

const BRANCH_ID = 'BKK_MAIN';
const PACKAGE_PRICES = { 60: 350, 120: 600, 180: 800 };
const STORAGE_KEY = 'eden_archery_last_booking';
const HOLD_STORAGE_KEY = 'eden_archery_active_hold';
const HOLD_MINUTES = 10;
const VALID_DURATIONS = new Set([60, 120, 180]);

let currentUser = null;
let currentHold = null;
let latestAvailability = null;
let holdTimer = null;
let paymentPollTimer = null;
let busyAction = '';
let holdIdempotencyKey = '';
let beamPaymentIdempotencyKey = '';

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

function setStatus(id, message, type = '') {
    const el = $(id);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('error', type === 'error');
    el.classList.toggle('success', type === 'success');
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
    ['archery-check-btn', 'archery-hold-btn', 'archery-confirm-btn'].forEach(id => {
        const button = $(id);
        if (!button) return;
        const disabledByAction =
            (id === 'archery-check-btn' && action === 'availability')
            || (id === 'archery-hold-btn' && action === 'hold')
            || (id === 'archery-confirm-btn' && action === 'confirm');
        if (isLoading && disabledByAction) button.disabled = true;
    });
}

function restoreButtonStates() {
    const checkBtn = $('archery-check-btn');
    const holdBtn = $('archery-hold-btn');
    const confirmBtn = $('archery-confirm-btn');
    if (checkBtn) checkBtn.disabled = false;
    if (holdBtn) holdBtn.disabled = !currentUser || !latestAvailability?.available || !!currentHold;
    if (confirmBtn) {
        const paymentStatus = String(currentHold?.payment_status || '').toUpperCase();
        const bookingStatus = String(currentHold?.booking_status || currentHold?.status || '').toUpperCase();
        confirmBtn.textContent = paymentStatus === 'PENDING' ? 'เปิดหน้าชำระเงิน' : 'ชำระเงิน';
        confirmBtn.disabled = !currentHold
            || isHoldExpired(currentHold)
            || bookingStatus === 'CONFIRMED'
            || paymentStatus === 'PAID_ONLINE'
            || paymentStatus === 'PAID_COUNTER'
            || paymentStatus === 'REFUNDED';
    }
}

function idempotencyKey(action, keyParts = []) {
    const base = [
        action,
        currentUser?.uid || 'anonymous',
        selectedDate(),
        selectedStartTime(),
        packageMinutes(),
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

function fillTimeOptions() {
    const select = $('archery-start');
    if (!select) return;
    const selected = select.value;
    const duration = packageMinutes();
    const lastStart = (20 * 60) - duration;
    select.innerHTML = '';
    for (let minute = 10 * 60; minute <= lastStart; minute += 15) {
        const opt = document.createElement('option');
        opt.value = timeLabel(minute);
        opt.textContent = timeLabel(minute);
        select.appendChild(opt);
    }
    if (selected && Array.from(select.options).some(opt => opt.value === selected)) {
        select.value = selected;
    }
}

function selectionPayload() {
    const duration = packageMinutes();
    return {
        branch_id: BRANCH_ID,
        booking_date: selectedDate(),
        start_time: selectedStartTime(),
        duration_minutes: duration,
        package_code: packageCode(duration)
    };
}

function summaryRows(rows) {
    return rows.map(([label, value]) => `<li><span>${escapeHTML(label)}</span><strong>${escapeHTML(value || '-')}</strong></li>`).join('');
}

function renderDraftSummary() {
    const el = $('archery-hold-summary');
    if (!el || currentHold) return;
    const duration = packageMinutes();
    el.innerHTML = summaryRows([
        ['วันที่', selectedDate()],
        ['เวลา', selectedStartTime() + '-' + selectedEndTime()],
        ['แพ็กเกจ', duration + ' นาที'],
        ['ยอดรวม', money(PACKAGE_PRICES[duration])]
    ]);
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
            ${times.map(time => `<button type="button" data-start-time="${escapeHTML(time)}">${escapeHTML(time)}</button>`).join('')}
        </div>
    `;
    el.querySelectorAll('button[data-start-time]').forEach(button => {
        button.addEventListener('click', () => {
            const select = $('archery-start');
            if (select) select.value = button.getAttribute('data-start-time') || select.value;
            resetHoldState();
            refreshAvailability();
        });
    });
}

function renderAvailability(result) {
    const available = result?.available === true;
    const count = Number(result?.available_lane_count || 0);
    if (available) {
        const countText = count > 0 ? ` มีช่องว่าง ${count} ช่อง` : '';
        setStatus('archery-status', `เวลานี้ยังจองได้${countText}`, 'success');
    } else {
        setStatus('archery-status', userMessage({ code: result?.reason || 'NO_LANE_AVAILABLE' }), 'error');
    }
    renderSuggestions(result?.suggested_start_times || []);
    restoreButtonStates();
}

function sanitizeHoldResponse(hold = {}) {
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
        amount_total: hold.amount_total || PACKAGE_PRICES[hold.duration_minutes || packageMinutes()],
        expires_at: hold.expires_at || new Date(Date.now() + HOLD_MINUTES * 60 * 1000).toISOString(),
        payment_required: hold.payment_required !== false
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
        payment_id: result.payment?.payment_id || currentHold.payment_id || ''
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
    if (redirectOnConfirmed && bookingStatus === 'CONFIRMED' && paymentStatus === 'PAID_ONLINE') {
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

function renderHoldSummary(hold) {
    const el = $('archery-hold-summary');
    if (!el || !hold) return;
    const duration = normalizeDuration(hold.duration_minutes);
    el.innerHTML = summaryRows([
        ['Booking ID', hold.booking_id],
        ['วันที่', hold.booking_date],
        ['เวลา', hold.start_time + '-' + (hold.end_time || timeLabel(minutesFromTime(hold.start_time) + duration))],
        ['แพ็กเกจ', duration + ' นาที'],
        ['ยอดรวม', money(hold.amount_total || PACKAGE_PRICES[duration])],
        ['Payment', hold.payment_status || 'UNPAID']
    ]);
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
    if (busyAction) return;
    const api = await waitForApi();
    if (!api?.getArcheryAvailability) {
        setStatus('archery-status', 'ระบบจองยังไม่พร้อม กรุณารีเฟรชหน้า', 'error');
        return;
    }
    try {
        setLoading('availability', true);
        setStatus('archery-status', 'กำลังตรวจสอบเวลาว่าง...');
        latestAvailability = await api.getArcheryAvailability(selectionPayload());
        renderAvailability(latestAvailability);
        renderDraftSummary();
    } catch (error) {
        latestAvailability = null;
        renderSuggestions([]);
        setStatus('archery-status', userMessage(error), 'error');
    } finally {
        setLoading('availability', false);
        restoreButtonStates();
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
    if (!latestAvailability?.available) {
        await refreshAvailability();
        if (!latestAvailability?.available) {
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
        const duration = packageMinutes();
        holdIdempotencyKey = holdIdempotencyKey || idempotencyKey('createArcheryHold');
        const hold = await api.createArcheryHold({
            ...selectionPayload(),
            member_id: currentUser.uid,
            amount: PACKAGE_PRICES[duration],
            idempotency_key: holdIdempotencyKey
        });
        currentHold = sanitizeHoldResponse(hold);
        saveHold(currentHold);
        renderHoldSummary(currentHold);
        setStatus('archery-status', 'ล็อกเวลาจองชั่วคราวแล้ว กรุณายืนยันภายใน 10 นาที', 'success');
        setStatus('archery-confirm-status', 'กดชำระเงินเพื่อเปิด Beam');
    } catch (error) {
        currentHold = null;
        latestAvailability = null;
        localStorage.removeItem(HOLD_STORAGE_KEY);
        renderSuggestions([]);
        setStatus('archery-status', userMessage(error), 'error');
    } finally {
        setLoading('hold', false);
        restoreButtonStates();
    }
}

async function startBeamPayment() {
    if (busyAction || !currentHold?.booking_id) return;
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
    fillTimeOptions();
    ['archery-date', 'archery-start', 'archery-package'].forEach(id => {
        const el = $(id);
        if (!el) return;
        el.addEventListener('change', () => {
            if (id === 'archery-package') fillTimeOptions();
            latestAvailability = null;
            resetHoldState();
            renderDraftSummary();
        });
    });
    $('archery-check-btn')?.addEventListener('click', refreshAvailability);
    form.addEventListener('submit', createHold);
    $('archery-confirm-btn')?.addEventListener('click', startBeamPayment);
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
    const duration = bookingDuration(booking);
    const bookingId = booking.id || booking.booking_id || '';
    const bookingDate = booking.booking_date || booking.date || '';
    const startTime = booking.start_time || booking.startTime || '';
    const endTime = booking.end_time || booking.endTime || (startTime ? timeLabel(minutesFromTime(startTime) + duration) : '');
    if (summary) {
        summary.innerHTML = summaryRows([
            ['Booking ID', bookingId],
            ['วันที่', bookingDate],
            ['เวลา', [startTime, endTime].filter(Boolean).join('-')],
            ['แพ็กเกจ', duration + ' นาที'],
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
