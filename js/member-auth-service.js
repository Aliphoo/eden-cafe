import { auth } from './firebase-config.js';

export const FUNCTIONS_BASE_URL = 'https://asia-southeast1-edencafe-d9095.cloudfunctions.net';
export const USER_KEY = 'eden_user';

function cleanString(value, maxLength = 300) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

export function profileToStoredUser(profile = {}) {
    const displayName = profile.display_name || 'สมาชิก Eden';
    const avatar = profile.avatar_url || 'Images/Logo.webp';
    return {
        uid: profile.uid || profile.id || '',
        name: displayName,
        email: profile.email || '',
        avatar,
        phone: profile.phone_display || displayThaiPhone(profile.phone_number || ''),
        phoneNumber: profile.phone_number || '',
        memberLevel: profile.member_level || 'Silver',
        points: Number(profile.points || 0),
        emailVerified: profile.emailVerified === true || profile.email_verified === true,
        emailVerifiedAt: profile.emailVerifiedAt || profile.email_verified_at || '',
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

async function edenAuthRequest(path, { method = 'POST', body = null, authenticated = false } = {}) {
    const headers = authenticated ? await authHeaders({ requireAuth: true }) : { 'Content-Type': 'application/json' };
    const response = await fetch(FUNCTIONS_BASE_URL + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });

    let data = {};
    try {
        data = await response.json();
    } catch (_) {
        data = {};
    }

    if (!response.ok) {
        const error = new Error(data.error || 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง');
        error.status = response.status;
        throw error;
    }

    return data;
}

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

export function completeRegister({ verificationId, registrationToken, phoneNumber, password, confirmPassword, firebaseIdToken }) {
    const body = { password, confirmPassword };
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

export function completePasswordReset({ verificationId, channel, identifier, otp, password, confirmPassword, firebaseIdToken, idToken }) {
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
    if (otp) body.otp = cleanString(otp, 6);
    return edenAuthRequest('/completePasswordReset', {
        body
    });
}

export function getMyProfile() {
    return edenAuthRequest('/getMyProfile', {
        method: 'GET',
        authenticated: true
    });
}
