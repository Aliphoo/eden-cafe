import './page-telemetry.js';
import { autoEnhanceOtpInputs, clearOtpUiStatus, setOtpUiStatus } from './eden-otp-experience.js?v=otp-experience-20260624-1';
import { auth } from './firebase-config.js';
import {
    GoogleAuthProvider,
    onAuthStateChanged,
    RecaptchaVerifier,
    signInWithCustomToken,
    signInWithPhoneNumber,
    signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    checkRegisterPhone,
    completeRegister,
    displayThaiPhone,
    getMyProfile,
    normalizeThaiPhone,
    storeProfile
} from './member-auth-service.js';

const GOOGLE_SETUP_KEY = 'eden_google_password_setup';
const FIREBASE_OTP_RESEND_COOLDOWN_MS = 60 * 1000;

const state = {
    authMode: '',
    phoneNumber: '',
    phoneDisplay: '',
    googleEmail: '',
    googleName: '',
    confirmationResult: null,
    firebaseIdToken: '',
    recaptchaVerifier: null,
    registrationStarted: false,
    googleSetupStarted: false,
    otpRequestedAt: 0,
    otpSendPromise: null,
    otpSendKey: '',
    nextOtpAllowedAt: 0
};

const els = {
    status: document.getElementById('register-status'),
    googleButton: document.getElementById('register-google'),
    phoneForm: document.getElementById('phone-register-form'),
    otpForm: document.getElementById('otp-register-form'),
    profileForm: document.getElementById('profile-register-form'),
    complete: document.getElementById('register-complete'),
    phone: document.getElementById('register-phone'),
    phonePreview: document.getElementById('register-phone-preview'),
    confirmedPhone: document.getElementById('register-confirmed-phone'),
    identityNote: document.getElementById('register-identity-note'),
    passwordTitle: document.getElementById('register-password-title'),
    passwordKicker: document.getElementById('register-password-kicker'),
    otp: document.getElementById('register-otp'),
    resend: document.getElementById('register-resend'),
    firstName: document.getElementById('register-first-name'),
    lastName: document.getElementById('register-last-name'),
    password: document.getElementById('register-password'),
    passwordConfirm: document.getElementById('register-password-confirm')
};

autoEnhanceOtpInputs();

function cleanTelemetryText(value, maxLength = 160) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function phoneLast4(value = state.phoneNumber || state.phoneDisplay || '') {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.slice(-4);
}

function currentAttemptAgeMs() {
    return state.otpRequestedAt ? Math.max(0, Date.now() - state.otpRequestedAt) : 0;
}

function reportRegisterOtpStage(stage, details = {}) {
    try {
        window.EdenTelemetry?.report?.('register_otp', {
            stage,
            authMode: state.authMode || details.authMode || 'phone',
            phoneLast4: details.phoneLast4 || phoneLast4(),
            hasConfirmationResult: !!state.confirmationResult,
            attemptAgeMs: currentAttemptAgeMs(),
            firebaseProvider: cleanTelemetryText(details.firebaseProvider || '', 80),
            errorCode: cleanTelemetryText(details.errorCode || details.code || '', 80),
            message: cleanTelemetryText(details.message || '', 220),
            status: details.status || 0,
            recoverable: details.recoverable === true
        });
    } catch (_) {
    }
}

function createRegisterError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.userMessage = true;
    return error;
}

function otpCooldownSeconds() {
    return Math.max(0, Math.ceil((state.nextOtpAllowedAt - Date.now()) / 1000));
}

function createOtpAlreadySentError() {
    const seconds = otpCooldownSeconds();
    const error = createRegisterError(
        'eden/otp-already-sent',
        seconds
            ? `ส่ง OTP ไปแล้ว กรุณาใช้รหัสล่าสุด หรือรอ ${seconds} วินาทีก่อนส่งใหม่`
            : 'ส่ง OTP ไปแล้ว กรุณาใช้รหัสล่าสุดก่อนขอรหัสใหม่'
    );
    error.retryAfterSeconds = seconds;
    return error;
}

function registerOtpErrorMessage(error, fallback) {
    const code = String(error?.code || error?.responseBody?.code || '').toLowerCase();
    if (code === 'eden/otp-already-sent') {
        return error.message || 'ส่ง OTP ไปแล้ว กรุณาใช้รหัสล่าสุดก่อนขอรหัสใหม่';
    }
    if (code === 'auth/invalid-verification-code' || code === 'auth/missing-verification-code') {
        return 'รหัส OTP ไม่ถูกต้อง กรุณาตรวจ SMS ล่าสุดและกรอกใหม่อีกครั้ง';
    }
    if (code === 'auth/code-expired' || code === 'auth/session-expired' || code === 'eden/no-confirmation-result') {
        return 'รหัส OTP หมดอายุหรือ session หายไปแล้ว กรุณากดส่ง OTP ใหม่';
    }
    if (code === 'auth/too-many-requests' || code === 'auth/quota-exceeded') {
        return 'ระบบส่ง/ยืนยัน OTP ถี่เกินไป กรุณารอสักครู่แล้วกดส่ง OTP ใหม่';
    }
    if (code === 'auth/network-request-failed') {
        return 'เครือข่ายไม่เสถียรหรือถูกบล็อก กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่';
    }
    if (code === 'auth/captcha-check-failed' || code === 'auth/missing-app-credential') {
        return 'การยืนยันความปลอดภัยหมดอายุ กรุณากดส่ง OTP ใหม่';
    }
    if (code === 'auth/invalid-phone-number' || code === 'auth/missing-phone-number') {
        return 'เบอร์โทรศัพท์ไม่ถูกต้อง กรุณากลับไปกรอกเบอร์ใหม่';
    }
    if (code === 'auth/unauthorized-domain' || code === 'auth/app-not-authorized') {
        return 'โดเมนนี้ยังไม่ได้รับอนุญาตสำหรับ Firebase Phone Auth กรุณาติดต่อผู้ดูแลระบบ';
    }
    return error?.userMessage && error.message ? error.message : (error?.message || fallback);
}

function errorDetails(error) {
    return {
        errorCode: error?.code || error?.responseBody?.code || '',
        message: error?.message || '',
        status: error?.status || 0
    };
}

function setStatus(message, type = 'info') {
    if (!els.status) return;
    els.status.textContent = message || '';
    els.status.dataset.type = type;
    els.status.style.display = message ? 'block' : 'none';
}

function setBusy(form, isBusy, label) {
    const buttons = form ? Array.from(form.querySelectorAll('button')) : [];
    buttons.forEach(button => {
        if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
        button.disabled = isBusy;
        if (button.type === 'submit') button.textContent = isBusy ? label : button.dataset.defaultText;
    });
    form?.querySelectorAll('input').forEach(input => {
        input.disabled = isBusy;
    });
}

function setButtonBusy(button, isBusy, label) {
    if (!button) return;
    if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
    button.disabled = isBusy;
    button.textContent = isBusy ? label : button.dataset.defaultText;
}

function activateStep(step) {
    const steps = ['phone', 'otp', 'profile'];
    document.querySelectorAll('.register-form').forEach(form => form.classList.remove('active'));
    document.querySelectorAll('[data-step-dot]').forEach(dot => {
        dot.classList.toggle('active', steps.indexOf(dot.dataset.stepDot) <= steps.indexOf(step));
    });
    if (step === 'phone') els.phoneForm?.classList.add('active');
    if (step === 'otp') els.otpForm?.classList.add('active');
    if (step === 'profile') els.profileForm?.classList.add('active');
}

function resetRecaptcha() {
    try {
        state.recaptchaVerifier?.clear?.();
    } catch (_) {
        // Firebase can throw if the invisible verifier has not rendered yet.
    }
    state.recaptchaVerifier = null;
}

function getRecaptchaVerifier() {
    if (!auth) throw new Error('ไม่พบระบบยืนยันตัวตน กรุณาลองใหม่อีกครั้ง');
    if (state.recaptchaVerifier) return state.recaptchaVerifier;

    const containerId = 'register-recaptcha-container';
    if (!document.getElementById(containerId)) {
        throw new Error('ไม่พบพื้นที่ยืนยันความปลอดภัย กรุณารีเฟรชหน้าเว็บ');
    }

    state.recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
        size: 'invisible',
        callback: () => {},
        'expired-callback': () => resetRecaptcha()
    });
    return state.recaptchaVerifier;
}

async function sendOtp({ refreshRecaptcha = false } = {}) {
    const phoneNumber = normalizeThaiPhone(els.phone?.value);
    const sendKey = `register:${phoneNumber}`;
    if (state.otpSendPromise && state.otpSendKey === sendKey) return state.otpSendPromise;
    if (
        state.confirmationResult
        && state.phoneNumber === phoneNumber
        && Date.now() < state.nextOtpAllowedAt
    ) {
        throw createOtpAlreadySentError();
    }

    state.otpSendKey = sendKey;
    state.otpSendPromise = (async () => {
        const checkResult = await checkRegisterPhone(phoneNumber);
        if (refreshRecaptcha) resetRecaptcha();
        const verifier = getRecaptchaVerifier();
        const result = await signInWithPhoneNumber(auth, phoneNumber, verifier);

        state.registrationStarted = true;
        state.authMode = 'phone';
        state.phoneNumber = phoneNumber;
        state.phoneDisplay = displayThaiPhone(phoneNumber);
        state.confirmationResult = result;
        state.firebaseIdToken = '';
        state.googleEmail = '';
        state.googleName = '';
        state.otpRequestedAt = Date.now();
        state.nextOtpAllowedAt = state.otpRequestedAt + FIREBASE_OTP_RESEND_COOLDOWN_MS;
        sessionStorage.removeItem(GOOGLE_SETUP_KEY);

        if (els.phonePreview) els.phonePreview.textContent = state.phoneDisplay;
        setPasswordStepForPhone();
        return checkResult || {};
    })();

    try {
        return await state.otpSendPromise;
    } finally {
        state.otpSendPromise = null;
    }
}

function isGoogleUser(user) {
    return !!user && (user.providerData || []).some(provider => provider.providerId === 'google.com');
}

function setPasswordStepForPhone() {
    if (els.passwordKicker) els.passwordKicker.textContent = 'ขั้นตอนที่ 3';
    if (els.passwordTitle) els.passwordTitle.textContent = 'ตั้งชื่อและรหัสผ่าน';
    if (els.identityNote) {
        els.identityNote.innerHTML = `เบอร์ที่ยืนยันแล้ว: <strong id="register-confirmed-phone">${state.phoneDisplay || '-'}</strong>`;
        els.confirmedPhone = document.getElementById('register-confirmed-phone');
    } else if (els.confirmedPhone) {
        els.confirmedPhone.textContent = state.phoneDisplay || '-';
    }
}

function setPasswordStepForGoogle() {
    const label = state.googleEmail || 'บัญชี Google ของคุณ';
    if (els.passwordKicker) els.passwordKicker.textContent = 'Google verified';
    if (els.passwordTitle) els.passwordTitle.textContent = 'ตั้งชื่อและรหัสผ่านสำหรับ Email Login';
    if (els.identityNote) {
        els.identityNote.innerHTML = `อีเมล Google ที่ยืนยันแล้ว: <strong id="register-confirmed-phone">${label}</strong>`;
        els.confirmedPhone = document.getElementById('register-confirmed-phone');
    } else if (els.confirmedPhone) {
        els.confirmedPhone.textContent = label;
    }
}

async function beginGooglePasswordSetup(firebaseUser) {
    if (!firebaseUser || !isGoogleUser(firebaseUser)) {
        throw new Error('กรุณาเลือกบัญชี Google เพื่อสมัครสมาชิก');
    }

    state.registrationStarted = true;
    state.googleSetupStarted = true;
    state.authMode = 'google';
    state.phoneNumber = '';
    state.phoneDisplay = '';
    state.confirmationResult = null;
    state.googleEmail = firebaseUser.email || '';
    state.googleName = firebaseUser.displayName || '';
    state.firebaseIdToken = await firebaseUser.getIdToken(true);
    if (state.googleName && !els.firstName?.value && !els.lastName?.value) {
        const parts = state.googleName.trim().split(/\s+/);
        if (els.firstName) els.firstName.value = parts.shift() || '';
        if (els.lastName) els.lastName.value = parts.join(' ');
    }

    setPasswordStepForGoogle();
    activateStep('profile');
    setStatus('ยืนยัน Google สำเร็จ กรุณาตั้งรหัสผ่านเพื่อให้ครั้งต่อไปเข้าสู่ระบบด้วยอีเมลได้', 'success');
}

async function redirectIfGoogleAlreadyHasPassword() {
    try {
        const result = await getMyProfile();
        const profile = result.profile || {};
        const hasPasswordLogin = profile.password_login_enabled === true
            || profile.passwordLoginEnabled === true;

        if (!hasPasswordLogin) return false;

        if (result.customToken) {
            await signInWithCustomToken(auth, result.customToken);
        }
        storeProfile(profile);
        sessionStorage.removeItem(GOOGLE_SETUP_KEY);
        setStatus('บัญชีนี้ตั้งรหัสผ่านไว้แล้ว กำลังพาไปหน้าโปรไฟล์...', 'success');
        window.setTimeout(() => {
            window.location.href = '/profile';
        }, 250);
        return true;
    } catch (error) {
        if (error.status && error.status !== 404) {
            console.warn('Google profile lookup failed before password setup:', error);
        }
        return false;
    }
}

async function startGoogleRegistration() {
    if (!auth) throw new Error('ไม่พบระบบยืนยันตัวตน กรุณาลองใหม่อีกครั้ง');
    const googleProvider = new GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: 'select_account' });
    sessionStorage.setItem(GOOGLE_SETUP_KEY, '1');
    const credential = await signInWithPopup(auth, googleProvider);
    if (await redirectIfGoogleAlreadyHasPassword()) return;
    await beginGooglePasswordSetup(credential.user);
}

function validateOtp() {
    const otp = String(els.otp?.value || '').trim();
    if (!/^\d{6}$/.test(otp)) throw new Error('กรุณากรอก OTP 6 หลัก');
    return otp;
}

function validatePassword() {
    const password = String(els.password?.value || '');
    const confirmPassword = String(els.passwordConfirm?.value || '');
    if (password.length < 8) throw new Error('Password ต้องมีความยาวอย่างน้อย 8 ตัวอักษร');
    if (password !== confirmPassword) throw new Error('Password และ Confirm Password ไม่ตรงกัน');
    return { password, confirmPassword };
}

function validateProfileName() {
    const firstName = String(els.firstName?.value || '').trim();
    const lastName = String(els.lastName?.value || '').trim();
    if (!firstName || !lastName) throw new Error('กรุณากรอกชื่อและนามสกุล');
    return {
        firstName,
        lastName,
        displayName: [firstName, lastName].filter(Boolean).join(' ')
    };
}

els.googleButton?.addEventListener('click', async () => {
    setButtonBusy(els.googleButton, true, 'กำลังเปิด Google...');
    setStatus('กำลังเปิดหน้าต่าง Google เพื่อยืนยันตัวตน...', 'info');
    try {
        await startGoogleRegistration();
    } catch (error) {
        sessionStorage.removeItem(GOOGLE_SETUP_KEY);
        setStatus(error.message || 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', 'error');
    } finally {
        setButtonBusy(els.googleButton, false);
    }
});

els.phoneForm?.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(els.phoneForm, true, 'กำลังส่ง OTP...');
    setStatus('กำลังส่ง OTP ผ่าน Firebase Phone Auth...', 'info');
    reportRegisterOtpStage('send_start', {
        phoneLast4: phoneLast4(els.phone?.value)
    });
    try {
        const checkResult = await sendOtp();
        activateStep('otp');
        clearOtpUiStatus(els.otp);
        reportRegisterOtpStage('send_ok', {
            phoneLast4: phoneLast4(state.phoneNumber),
            recoverable: checkResult.recoverable === true
        });
        setStatus('ส่ง OTP สำเร็จ กรุณาตรวจสอบ SMS แล้วกรอกรหัส 6 หลัก', 'success');
    } catch (error) {
        if (error?.code !== 'eden/otp-already-sent') resetRecaptcha();
        reportRegisterOtpStage('send_fail', {
            phoneLast4: phoneLast4(els.phone?.value || state.phoneNumber),
            ...errorDetails(error)
        });
        setStatus(registerOtpErrorMessage(error, 'ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'), 'error');
    } finally {
        setBusy(els.phoneForm, false);
    }
});

els.otpForm?.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(els.otpForm, true, 'กำลังยืนยัน OTP...');
    setStatus('กำลังยืนยัน OTP กับ Firebase...', 'info');
    try {
        const otp = validateOtp();
        if (!state.confirmationResult) {
            throw createRegisterError('eden/no-confirmation-result', 'ไม่พบรายการ OTP กรุณาส่ง OTP ใหม่');
        }
        setOtpUiStatus(els.otp, 'loading');

        const credential = await state.confirmationResult.confirm(otp);
        const firebaseUser = credential.user;
        const firebaseProvider = (firebaseUser.providerData || [])
            .map(provider => provider.providerId)
            .filter(Boolean)
            .join(',');
        state.authMode = 'phone';
        state.firebaseIdToken = await firebaseUser.getIdToken(true);
        state.phoneNumber = normalizeThaiPhone(firebaseUser.phoneNumber || state.phoneNumber);
        state.phoneDisplay = displayThaiPhone(state.phoneNumber);
        setPasswordStepForPhone();

        activateStep('profile');
        setOtpUiStatus(els.otp, 'success');
        reportRegisterOtpStage('confirm_ok', {
            firebaseProvider: firebaseProvider || 'phone'
        });
        setStatus('ยืนยัน OTP สำเร็จ กรุณาตั้งรหัสผ่าน', 'success');
    } catch (error) {
        setOtpUiStatus(els.otp, 'error');
        reportRegisterOtpStage('confirm_fail', errorDetails(error));
        setStatus(registerOtpErrorMessage(error, 'OTP ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง'), 'error');
    } finally {
        setBusy(els.otpForm, false);
    }
});

els.resend?.addEventListener('click', async () => {
    if (!state.phoneNumber && els.phone?.value) {
        try {
            state.phoneNumber = normalizeThaiPhone(els.phone.value);
        } catch (_) {
            activateStep('phone');
            setStatus('กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้องก่อนส่ง OTP อีกครั้ง', 'error');
            return;
        }
    }

    setBusy(els.otpForm, true, 'กำลังส่ง OTP อีกครั้ง...');
    setStatus('กำลังส่ง OTP อีกครั้ง...', 'info');
    try {
        if (els.phone) els.phone.value = displayThaiPhone(state.phoneNumber);
        reportRegisterOtpStage('send_start', {
            phoneLast4: phoneLast4(state.phoneNumber)
        });
        const checkResult = await sendOtp({ refreshRecaptcha: true });
        activateStep('otp');
        clearOtpUiStatus(els.otp);
        reportRegisterOtpStage('send_ok', {
            phoneLast4: phoneLast4(state.phoneNumber),
            recoverable: checkResult.recoverable === true
        });
        setStatus('ส่ง OTP อีกครั้งสำเร็จ', 'success');
    } catch (error) {
        if (error?.code !== 'eden/otp-already-sent') resetRecaptcha();
        reportRegisterOtpStage('send_fail', errorDetails(error));
        setStatus(registerOtpErrorMessage(error, 'ส่ง OTP อีกครั้งไม่สำเร็จ'), 'error');
    } finally {
        setBusy(els.otpForm, false);
    }
});

els.profileForm?.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(els.profileForm, true, 'กำลังสมัครสมาชิก...');
    setStatus('กำลังสร้างบัญชีสมาชิก...', 'info');
    try {
        const profileName = validateProfileName();
        const { password, confirmPassword } = validatePassword();
        if (!state.firebaseIdToken) throw new Error('ยังไม่ได้ยืนยันบัญชี กรุณายืนยันเบอร์โทรศัพท์หรือ Google ก่อน');

        const payload = {
            firebaseIdToken: state.firebaseIdToken,
            ...profileName,
            password,
            confirmPassword
        };
        if (state.authMode === 'phone') payload.phoneNumber = state.phoneNumber;

        const result = await completeRegister(payload);
        if (result.customToken) {
            await signInWithCustomToken(auth, result.customToken);
        }
        if (result.profile) storeProfile(result.profile);
        sessionStorage.removeItem(GOOGLE_SETUP_KEY);
        if (state.authMode === 'phone') {
            reportRegisterOtpStage('complete_ok', {
                firebaseProvider: 'phone'
            });
        }

        els.profileForm?.classList.remove('active');
        if (els.complete) els.complete.hidden = false;
        setStatus('สมัครสมาชิกสำเร็จ กำลังพาไปหน้าโปรไฟล์', 'success');
        window.setTimeout(() => {
            window.location.href = '/profile';
        }, 900);
    } catch (error) {
        if (state.authMode === 'phone') reportRegisterOtpStage('complete_fail', errorDetails(error));
        setStatus(registerOtpErrorMessage(error, 'สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'), 'error');
    } finally {
        setBusy(els.profileForm, false);
    }
});

onAuthStateChanged(auth, async user => {
    const params = new URLSearchParams(window.location.search);
    const shouldSetupGoogle = params.get('google') === '1' || sessionStorage.getItem(GOOGLE_SETUP_KEY) === '1';
    if (user && shouldSetupGoogle && !state.googleSetupStarted) {
        try {
            if (isGoogleUser(user) && await redirectIfGoogleAlreadyHasPassword()) return;
            await beginGooglePasswordSetup(user);
        } catch (error) {
            sessionStorage.removeItem(GOOGLE_SETUP_KEY);
            setStatus(error.message || 'ไม่สามารถเตรียมบัญชี Google ได้ กรุณาลองใหม่อีกครั้ง', 'error');
        }
        return;
    }
    if (user && !state.registrationStarted) window.location.href = '/profile';
});
