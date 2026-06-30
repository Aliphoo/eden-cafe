import { auth } from './firebase-config.js';

export const FUNCTIONS_BASE_URL = 'https://asia-southeast1-edencafe-d9095.cloudfunctions.net';
export const USER_KEY = 'eden_user';

function cleanString(value, maxLength = 300) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createTimeoutError(timeoutMs) {
    const error = new Error('Request timed out. Please try again.');
    error.status = 408;
    error.code = 'timeout';
    error.timeoutMs = timeoutMs;
    error.userMessage = true;
    return error;
}

function createAuthRequiredError() {
    const error = new Error('กรุณาเข้าสู่ระบบอีกครั้งเพื่อดำเนินการต่อ');
    error.status = 401;
    error.code = 'auth-required';
    error.userMessage = true;
    return error;
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

export function normalizeThaiPhone(value) {
    const raw = cleanString(value, 40);
    const compact = raw.replace(/[^\d+]/g, '');
    const digits = compact.replace(/\D/g, '');

    if (/^\+66[689]\d{8}$/.test(compact)) return compact;
    if (/^66[689]\d{8}$/.test(digits)) return '+' + digits;
    if (/^0[689]\d{8}$/.test(digits)) return '+66' + digits.slice(1);
    if (/^[689]\d{8}$/.test(digits)) return '+66' + digits;

    throw new Error('กรุณากรอกเบอร์โทรศัพท์ไทยให้ถูกต้อง เช่น 08X-XXX-XXXX');
}

export function displayThaiPhone(phoneNumber) {
    const phone = cleanString(phoneNumber, 40);
    return phone.startsWith('+66') ? '0' + phone.slice(3) : phone;
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

export function profileToStoredUser(profile = {}) {
    const displayName = profile.display_name || profile.displayName || 'สมาชิก Eden';
    const avatar = profile.avatar_url || 'Images/Logo.webp';
    const shippingAddressStructured = normalizeShippingAddressStructured(
        profile.shippingAddressStructured || profile.shipping_address_structured || {},
        profile.shippingAddress || profile.address || ''
    );
    const verifiedPhoneNumber = cleanString(profile.phone_number || profile.phoneE164 || '', 40);
    const phoneRemovedAt = profile.phoneRemovedAt || profile.phone_removed_at || '';
    const phoneVerified = profile.phoneVerified === true
        || profile.phone_verified === true
        || !!(profile.phoneVerifiedAt || profile.phone_verified_at);
    const checkoutPhone = cleanString(
        profile.checkoutPhone
        || profile.checkout_phone
        || profile.contactPhone
        || profile.contact_phone
        || (!verifiedPhoneNumber ? profile.phone : ''),
        40
    );
    const phoneRemoved = !!phoneRemovedAt && !verifiedPhoneNumber && !checkoutPhone;
    const phoneDisplay = cleanString(profile.phone_display || displayThaiPhone(verifiedPhoneNumber), 40);
    return {
        uid: profile.uid || profile.id || '',
        name: displayName,
        displayName,
        firstName: profile.firstName || profile.first_name || '',
        lastName: profile.lastName || profile.last_name || '',
        email: profile.email || '',
        avatar,
        phone: phoneRemoved ? '' : (phoneDisplay || checkoutPhone),
        phoneNumber: phoneRemoved ? '' : verifiedPhoneNumber,
        checkoutPhone,
        checkout_phone: checkoutPhone,
        contactPhone: checkoutPhone,
        contact_phone: checkoutPhone,
        phoneVerified,
        phoneVerifiedAt: profile.phoneVerifiedAt || profile.phone_verified_at || '',
        phoneRemovedAt,
        phone_removed_at: phoneRemovedAt,
        memberLevel: profile.member_level || 'Silver',
        points: Number(profile.points || 0),
        emailVerified: profile.emailVerified === true || profile.email_verified === true,
        emailVerifiedAt: profile.emailVerifiedAt || profile.email_verified_at || '',
        shippingAddress: profile.shippingAddress || '',
        address: profile.shippingAddress || '',
        shippingAddressStructured,
        addressLine: shippingAddressStructured.addressLine,
        subdistrict: shippingAddressStructured.subdistrict,
        district: shippingAddressStructured.district,
        province: shippingAddressStructured.province,
        zipcode: shippingAddressStructured.zipcode,
        birthDate: profile.birthDate || '',
        allergies: profile.allergies || '',
        healthNote: profile.healthNote || '',
        lineId: profile.lineId || '',
        passwordLoginEnabled: profile.password_login_enabled === true || profile.passwordLoginEnabled === true,
        authProviderIds: Array.isArray(profile.auth_provider_ids) ? profile.auth_provider_ids : [],
        isAdmin: false,
        adminRole: ''
    };
}

export function storeProfile(profile) {
    const storedUser = profileToStoredUser(profile);
    localStorage.setItem(USER_KEY, JSON.stringify(storedUser));
    window.dispatchEvent(new CustomEvent('eden:user-changed'));
    return storedUser;
}

async function authHeaders({ requireAuth = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const user = requireAuth ? await waitForCurrentUser() : auth?.currentUser;
    if (user && typeof user.getIdToken === 'function') {
        headers.Authorization = 'Bearer ' + await user.getIdToken();
    } else if (requireAuth) {
        throw createAuthRequiredError();
    }
    return headers;
}

async function edenAuthRequest(path, { method = 'POST', body = null, authenticated = false, timeoutMs = 15000 } = {}) {
    const headers = authenticated ? await authHeaders({ requireAuth: true }) : { 'Content-Type': 'application/json' };
    const controller = typeof AbortController === 'function' && timeoutMs > 0 ? new AbortController() : null;
    const timeoutId = controller
        ? window.setTimeout(() => controller.abort(createTimeoutError(timeoutMs)), timeoutMs)
        : null;
    let response;
    try {
        response = await fetch(FUNCTIONS_BASE_URL + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller?.signal
        });
    } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'timeout') {
            throw createTimeoutError(timeoutMs);
        }
        throw error;
    } finally {
        if (timeoutId) window.clearTimeout(timeoutId);
    }

    let data = {};
    try {
        data = await response.json();
    } catch (_) {
        data = {};
    }

    if (!response.ok) {
        const error = new Error(data.error || 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง');
        error.status = response.status;
        error.userMessage = true;
        error.responseBody = data;
        throw error;
    }

    return data;
}

// Legacy register OTP endpoints are kept for compatibility. The public
// register page uses Firebase Phone Auth as the phone-verification source.
export function requestRegisterOtp(phoneNumber) {
    return edenAuthRequest('/requestRegisterOtp', {
        body: { phoneNumber: normalizeThaiPhone(phoneNumber) }
    });
}

export function checkRegisterPhone(phoneNumber) {
    return edenAuthRequest('/checkRegisterPhone', {
        body: { phoneNumber: normalizeThaiPhone(phoneNumber) }
    });
}

export function verifyRegisterOtp({ verificationId, phoneNumber, otp }) {
    return edenAuthRequest('/verifyRegisterOtp', {
        body: { verificationId, phoneNumber: normalizeThaiPhone(phoneNumber), otp: cleanString(otp, 6) }
    });
}

export function completeRegister({ verificationId, registrationToken, phoneNumber, password, confirmPassword, firebaseIdToken, firstName, lastName, displayName }) {
    const body = {
        password,
        confirmPassword,
        firstName: cleanString(firstName, 80),
        lastName: cleanString(lastName, 80),
        displayName: cleanString(displayName || [firstName, lastName].filter(Boolean).join(' '), 120)
    };
    if (firebaseIdToken) body.firebaseIdToken = cleanString(firebaseIdToken, 4000);
    if (verificationId) body.verificationId = cleanString(verificationId, 160);
    if (registrationToken) body.registrationToken = cleanString(registrationToken, 1200);
    if (phoneNumber) body.phoneNumber = normalizeThaiPhone(phoneNumber);

    return edenAuthRequest('/completeRegister', {
        body
    });
}

export function loginMember({ identifier, password }) {
    return edenAuthRequest('/loginMember', {
        body: { identifier: cleanString(identifier, 180), password }
    });
}

export function requestPasswordResetOtp({ channel, identifier }) {
    const resetChannel = cleanString(channel, 20).toLowerCase();
    const resetIdentifier = resetChannel === 'phone'
        ? normalizeThaiPhone(identifier)
        : cleanString(identifier, 180).toLowerCase();
    return edenAuthRequest('/requestPasswordResetOtp', {
        body: { channel: resetChannel, identifier: resetIdentifier }
    });
}

export function verifyPasswordResetOtp({ verificationId, channel, identifier, otp }) {
    const resetChannel = cleanString(channel, 20).toLowerCase();
    const resetIdentifier = resetChannel === 'phone'
        ? normalizeThaiPhone(identifier)
        : cleanString(identifier, 180).toLowerCase();
    return edenAuthRequest('/verifyPasswordResetOtp', {
        body: {
            verificationId: cleanString(verificationId, 160),
            channel: resetChannel,
            identifier: resetIdentifier,
            otp: cleanString(otp, 6)
        }
    });
}

export function completePasswordReset({ verificationId, channel, identifier, password, confirmPassword, firebaseIdToken, idToken, resetToken }) {
    const resetChannel = cleanString(channel, 20).toLowerCase();
    const resetIdentifier = resetChannel === 'phone'
        ? normalizeThaiPhone(identifier)
        : cleanString(identifier, 180).toLowerCase();
    const verifiedFirebaseIdToken = cleanString(firebaseIdToken || idToken, 4000);
    const body = {
        channel: resetChannel,
        identifier: resetIdentifier,
        password,
        confirmPassword
    };
    if (verifiedFirebaseIdToken) body.firebaseIdToken = verifiedFirebaseIdToken;
    if (verificationId) body.verificationId = cleanString(verificationId, 160);
    if (resetToken) body.resetToken = cleanString(resetToken, 1200);
    return edenAuthRequest('/completePasswordReset', {
        body
    });
}

export function getMyProfile() {
    return edenAuthRequest('/getMyProfile', {
        method: 'GET',
        authenticated: true,
        timeoutMs: 8000
    });
}

export function updateMyProfile(profile = {}) {
    const shippingAddressStructured = normalizeShippingAddressStructured(
        profile.shippingAddressStructured || profile,
        profile.shippingAddress || profile.address || ''
    );
    return edenAuthRequest('/updateMyProfile', {
        authenticated: true,
        body: {
            firstName: cleanString(profile.firstName, 80),
            lastName: cleanString(profile.lastName, 80),
            displayName: cleanString(profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(' '), 120),
            shippingAddress: cleanString(profile.shippingAddress, 500),
            shippingAddressStructured,
            birthDate: cleanString(profile.birthDate, 20),
            allergies: cleanString(profile.allergies, 200),
            healthNote: cleanString(profile.healthNote, 500),
            lineId: cleanString(profile.lineId, 80)
        }
    });
}

export function requestPhoneChangeOtp(phoneNumber) {
    return edenAuthRequest('/requestPhoneChangeOtp', {
        authenticated: true,
        body: { phoneNumber: normalizeThaiPhone(phoneNumber) }
    });
}

export function checkPhoneChange(phoneNumber) {
    return edenAuthRequest('/checkPhoneChange', {
        authenticated: true,
        body: { phoneNumber: normalizeThaiPhone(phoneNumber) }
    });
}

export function verifyPhoneChangeOtp({ verificationId, phoneNumber, otp, firebaseIdToken, idToken }) {
    const body = {
        phoneNumber: normalizeThaiPhone(phoneNumber)
    };
    if (firebaseIdToken || idToken) body.firebaseIdToken = cleanString(firebaseIdToken || idToken, 5000);
    if (verificationId) body.verificationId = cleanString(verificationId, 160);
    if (otp) body.otp = cleanString(otp, 6);
    return edenAuthRequest('/verifyPhoneChangeOtp', {
        authenticated: true,
        body
    });
}

export function requestPhoneRemovalOtp(channel = 'phone') {
    const normalizedChannel = cleanString(channel, 20).toLowerCase() === 'email' ? 'email' : 'phone';
    return edenAuthRequest('/requestPhoneRemovalOtp', {
        authenticated: true,
        body: { channel: normalizedChannel }
    });
}

export function verifyPhoneRemovalOtp({ verificationId, otp, firebaseIdToken, idToken }) {
    const body = {};
    if (firebaseIdToken || idToken) body.firebaseIdToken = cleanString(firebaseIdToken || idToken, 5000);
    if (verificationId) body.verificationId = cleanString(verificationId, 160);
    if (otp) body.otp = cleanString(otp, 6);
    return edenAuthRequest('/verifyPhoneRemovalOtp', {
        authenticated: true,
        body
    });
}
