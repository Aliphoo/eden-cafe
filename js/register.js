import { auth } from './firebase-config.js';
import {
    onAuthStateChanged,
    RecaptchaVerifier,
    signInWithPhoneNumber
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    completeRegister,
    displayThaiPhone,
    normalizeThaiPhone
} from './member-auth-service.js';

const state = {
    phoneNumber: '',
    phoneDisplay: '',
    confirmationResult: null,
    firebaseIdToken: '',
    recaptchaVerifier: null,
    registrationStarted: false
};

const els = {
    status: document.getElementById('register-status'),
    phoneForm: document.getElementById('phone-register-form'),
    otpForm: document.getElementById('otp-register-form'),
    profileForm: document.getElementById('profile-register-form'),
    complete: document.getElementById('register-complete'),
    phone: document.getElementById('register-phone'),
    phonePreview: document.getElementById('register-phone-preview'),
    confirmedPhone: document.getElementById('register-confirmed-phone'),
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
    state.phoneNumber = phoneNumber;
    state.phoneDisplay = displayThaiPhone(phoneNumber);
    state.confirmationResult = result;
    state.firebaseIdToken = '';

    if (els.phonePreview) els.phonePreview.textContent = state.phoneDisplay;
    if (els.confirmedPhone) els.confirmedPhone.textContent = state.phoneDisplay;
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
        state.firebaseIdToken = await firebaseUser.getIdToken(true);
        state.phoneNumber = normalizeThaiPhone(firebaseUser.phoneNumber || state.phoneNumber);
        state.phoneDisplay = displayThaiPhone(state.phoneNumber);
        if (els.confirmedPhone) els.confirmedPhone.textContent = state.phoneDisplay;

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
        if (!state.firebaseIdToken) throw new Error('ยังไม่ได้ยืนยัน OTP กรุณายืนยันเบอร์โทรศัพท์ก่อน');

        await completeRegister({
            firebaseIdToken: state.firebaseIdToken,
            phoneNumber: state.phoneNumber,
            password,
            confirmPassword
        });

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

onAuthStateChanged(auth, user => {
    if (user && !state.registrationStarted) window.location.href = '/profile';
});
