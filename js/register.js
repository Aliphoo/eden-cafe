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
    completeRegister,
    displayThaiPhone,
    getMyProfile,
    normalizeThaiPhone,
    storeProfile
} from './member-auth-service.js';

const GOOGLE_SETUP_KEY = 'eden_google_password_setup';

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
    googleSetupStarted: false
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
    password: document.getElementById('register-password'),
    passwordConfirm: document.getElementById('register-password-confirm')
};

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

async function sendOtp() {
    const phoneNumber = normalizeThaiPhone(els.phone?.value);
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
    sessionStorage.removeItem(GOOGLE_SETUP_KEY);

    if (els.phonePreview) els.phonePreview.textContent = state.phoneDisplay;
    setPasswordStepForPhone();
}

function isGoogleUser(user) {
    return !!user && (user.providerData || []).some(provider => provider.providerId === 'google.com');
}

function setPasswordStepForPhone() {
    if (els.passwordKicker) els.passwordKicker.textContent = 'ขั้นตอนที่ 3';
    if (els.passwordTitle) els.passwordTitle.textContent = 'ตั้งรหัสผ่าน';
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
    if (els.passwordTitle) els.passwordTitle.textContent = 'ตั้งรหัสผ่านสำหรับ Email Login';
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
    try {
        await sendOtp();
        activateStep('otp');
        setStatus('ส่ง OTP สำเร็จ กรุณาตรวจสอบ SMS แล้วกรอกรหัส 6 หลัก', 'success');
    } catch (error) {
        resetRecaptcha();
        setStatus(error.message || 'ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', 'error');
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
        if (!state.confirmationResult) throw new Error('ไม่พบรายการ OTP กรุณาส่ง OTP ใหม่');

        const credential = await state.confirmationResult.confirm(otp);
        const firebaseUser = credential.user;
        state.authMode = 'phone';
        state.firebaseIdToken = await firebaseUser.getIdToken(true);
        state.phoneNumber = normalizeThaiPhone(firebaseUser.phoneNumber || state.phoneNumber);
        state.phoneDisplay = displayThaiPhone(state.phoneNumber);
        setPasswordStepForPhone();

        activateStep('profile');
        setStatus('ยืนยัน OTP สำเร็จ กรุณาตั้งรหัสผ่าน', 'success');
    } catch (error) {
        setStatus(error.message || 'OTP ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง', 'error');
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
        resetRecaptcha();
        await sendOtp();
        activateStep('otp');
        setStatus('ส่ง OTP อีกครั้งสำเร็จ', 'success');
    } catch (error) {
        resetRecaptcha();
        setStatus(error.message || 'ส่ง OTP อีกครั้งไม่สำเร็จ', 'error');
    } finally {
        setBusy(els.otpForm, false);
    }
});

els.profileForm?.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(els.profileForm, true, 'กำลังสมัครสมาชิก...');
    setStatus('กำลังสร้างบัญชีสมาชิก...', 'info');
    try {
        const { password, confirmPassword } = validatePassword();
        if (!state.firebaseIdToken) throw new Error('ยังไม่ได้ยืนยันบัญชี กรุณายืนยันเบอร์โทรศัพท์หรือ Google ก่อน');

        const payload = {
            firebaseIdToken: state.firebaseIdToken,
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

        els.profileForm?.classList.remove('active');
        if (els.complete) els.complete.hidden = false;
        setStatus('สมัครสมาชิกสำเร็จ กำลังพาไปหน้าโปรไฟล์', 'success');
        window.setTimeout(() => {
            window.location.href = '/profile';
        }, 900);
    } catch (error) {
        setStatus(error.message || 'สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', 'error');
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
