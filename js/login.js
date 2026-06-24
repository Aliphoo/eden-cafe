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
    completePasswordReset,
    getMyProfile,
    loginMember,
    requestPasswordResetOtp,
    storeProfile
} from './member-auth-service.js?v=phone-reset-firebase-20260605';

const GOOGLE_SETUP_KEY = 'eden_google_password_setup';

const els = {
    form: document.getElementById('login-form'),
    google: document.getElementById('login-google'),
    identifier: document.getElementById('login-identifier'),
    password: document.getElementById('login-password'),
    status: document.getElementById('login-status'),
    submit: document.getElementById('login-submit'),
    forgotOpen: document.getElementById('forgot-password-open'),
    forgotPanel: document.getElementById('forgot-password-panel'),
    forgotClose: document.getElementById('forgot-password-close'),
    forgotRequestForm: document.getElementById('forgot-request-form'),
    forgotCompleteForm: document.getElementById('forgot-complete-form'),
    forgotIdentifierLabel: document.getElementById('forgot-identifier-label'),
    forgotIdentifier: document.getElementById('forgot-identifier'),
    forgotOtp: document.getElementById('forgot-otp'),
    forgotPassword: document.getElementById('forgot-password'),
    forgotPasswordConfirm: document.getElementById('forgot-password-confirm')
};

autoEnhanceOtpInputs();

let authResolved = false;
let loginInProgress = false;
const resetState = {
    channel: 'phone',
    identifier: '',
    verificationId: '',
    phoneNumber: '',
    phoneConfirmationResult: null,
    recaptchaVerifier: null,
    firebasePhoneAuth: false
};

function setStatus(message, type = 'info') {
    if (!els.status) return;
    els.status.textContent = message || '';
    els.status.dataset.type = type;
    els.status.style.display = message ? 'block' : 'none';
}

function setBusy(isBusy) {
    if (!els.submit) return;
    if (!els.submit.dataset.defaultText) els.submit.dataset.defaultText = els.submit.textContent;
    els.submit.disabled = isBusy;
    els.submit.textContent = isBusy ? 'กำลังเข้าสู่ระบบ...' : els.submit.dataset.defaultText;
    if (els.identifier) els.identifier.disabled = isBusy;
    if (els.password) els.password.disabled = isBusy;
}

function setGoogleBusy(isBusy) {
    if (!els.google) return;
    if (!els.google.dataset.defaultText) els.google.dataset.defaultText = els.google.textContent;
    els.google.disabled = isBusy;
    els.google.textContent = isBusy ? 'กำลังเปิด Google...' : els.google.dataset.defaultText;
}

function getForgotChannel() {
    return document.querySelector('input[name="forgot-channel"]:checked')?.value === 'email' ? 'email' : 'phone';
}

function updateForgotChannelUi() {
    const channel = getForgotChannel();
    resetState.channel = channel;
    resetState.phoneConfirmationResult = null;
    resetState.firebasePhoneAuth = false;
    resetRecaptcha();
    if (els.forgotIdentifierLabel) {
        els.forgotIdentifierLabel.textContent = channel === 'email' ? 'อีเมล' : 'เบอร์โทรศัพท์';
    }
    if (els.forgotIdentifier) {
        els.forgotIdentifier.value = '';
        els.forgotIdentifier.type = channel === 'email' ? 'email' : 'text';
        els.forgotIdentifier.placeholder = channel === 'email' ? 'name@example.com' : '08X-XXX-XXXX';
        els.forgotIdentifier.inputMode = channel === 'email' ? 'email' : 'tel';
        els.forgotIdentifier.autocomplete = channel === 'email' ? 'email' : 'tel';
    }
}

function resetRecaptcha() {
    try {
        resetState.recaptchaVerifier?.clear?.();
    } catch (_) {
        // Firebase can throw if the invisible verifier has not rendered yet.
    }
    resetState.recaptchaVerifier = null;
}

function getForgotRecaptchaVerifier() {
    if (!auth) throw new Error('ไม่พบระบบยืนยันตัวตน กรุณาลองใหม่อีกครั้ง');
    if (resetState.recaptchaVerifier) return resetState.recaptchaVerifier;
    const containerId = 'forgot-recaptcha-container';
    if (!document.getElementById(containerId)) {
        throw new Error('ไม่พบพื้นที่ยืนยันความปลอดภัย กรุณารีเฟรชหน้าเว็บ');
    }
    resetState.recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
        size: 'invisible',
        callback: () => {},
        'expired-callback': () => resetRecaptcha()
    });
    return resetState.recaptchaVerifier;
}

function setForgotBusy(form, isBusy, label) {
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

function openForgotPanel() {
    if (!els.forgotPanel) return;
    els.forgotPanel.hidden = false;
    els.forgotRequestForm.hidden = false;
    els.forgotCompleteForm.hidden = true;
    resetState.verificationId = '';
    resetState.identifier = '';
    updateForgotChannelUi();
    els.forgotIdentifier?.focus();
}

function closeForgotPanel() {
    if (!els.forgotPanel) return;
    els.forgotPanel.hidden = true;
    els.forgotRequestForm?.reset();
    els.forgotCompleteForm?.reset();
    els.forgotRequestForm.hidden = false;
    els.forgotCompleteForm.hidden = true;
    resetState.channel = 'phone';
    resetState.identifier = '';
    resetState.verificationId = '';
    resetState.phoneNumber = '';
    resetState.phoneConfirmationResult = null;
    resetState.firebasePhoneAuth = false;
    resetRecaptcha();
}

function redirectToProfile() {
    window.location.href = '/profile';
}

function redirectToGooglePasswordSetup() {
    sessionStorage.setItem(GOOGLE_SETUP_KEY, '1');
    window.location.href = '/register?google=1';
}

function showRegisteredMessage() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('registered') === '1') {
        setStatus('สมัครสมาชิกสำเร็จ กรุณาเข้าสู่ระบบ', 'success');
    }
}

onAuthStateChanged(auth, async user => {
    authResolved = true;
    const waitingForGoogleSetup = sessionStorage.getItem(GOOGLE_SETUP_KEY) === '1';
    if (!user || loginInProgress || waitingForGoogleSetup) return;

    try {
        const result = await getMyProfile();
        const hasPasswordLogin = result.profile?.password_login_enabled === true
            || result.profile?.passwordLoginEnabled === true;
        if (!hasPasswordLogin) {
            redirectToGooglePasswordSetup();
            return;
        }
        if (result.customToken) await signInWithCustomToken(auth, result.customToken);
        if (result.profile) storeProfile(result.profile);
        redirectToProfile();
    } catch (error) {
        const isGoogleUser = (user.providerData || []).some(provider => provider.providerId === 'google.com');
        if (isGoogleUser) redirectToGooglePasswordSetup();
    }
});

els.google?.addEventListener('click', async () => {
    if (!auth) {
        setStatus('ไม่พบระบบยืนยันตัวตน กรุณาลองใหม่อีกครั้ง', 'error');
        return;
    }

    loginInProgress = true;
    setGoogleBusy(true);
    setStatus('กำลังยืนยันบัญชี Google...', 'info');
    try {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        await signInWithPopup(auth, provider);

        try {
            const result = await getMyProfile();
            const hasPasswordLogin = result.profile?.password_login_enabled === true
                || result.profile?.passwordLoginEnabled === true;
            if (hasPasswordLogin) {
                if (result.customToken) {
                    await signInWithCustomToken(auth, result.customToken);
                }
                storeProfile(result.profile);
                setStatus('เข้าสู่ระบบด้วย Google สำเร็จ กำลังไปหน้าโปรไฟล์...', 'success');
                window.setTimeout(redirectToProfile, 250);
                return;
            }
        } catch (profileError) {
            if (profileError.status && profileError.status !== 404) {
                console.warn('Google profile lookup failed:', profileError);
            }
        }

        setStatus('ยืนยัน Google สำเร็จ กรุณาตั้งรหัสผ่านสำหรับ Email Login', 'success');
        window.setTimeout(redirectToGooglePasswordSetup, 350);
    } catch (error) {
        loginInProgress = false;
        sessionStorage.removeItem(GOOGLE_SETUP_KEY);
        setStatus(error.message || 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', 'error');
    } finally {
        if (!sessionStorage.getItem(GOOGLE_SETUP_KEY)) {
            setGoogleBusy(false);
        }
    }
});

els.forgotOpen?.addEventListener('click', () => {
    setStatus('', 'info');
    openForgotPanel();
});

els.forgotClose?.addEventListener('click', () => {
    closeForgotPanel();
});

document.querySelectorAll('input[name="forgot-channel"]').forEach(input => {
    input.addEventListener('change', updateForgotChannelUi);
});

els.forgotRequestForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const channel = getForgotChannel();
    const identifier = String(els.forgotIdentifier?.value || '').trim();
    if (!identifier) {
        setStatus(channel === 'email' ? 'กรุณากรอกอีเมล' : 'กรุณากรอกเบอร์โทรศัพท์', 'error');
        return;
    }

    setForgotBusy(els.forgotRequestForm, true, 'กำลังส่ง OTP...');
    setStatus('กำลังตรวจสอบบัญชีและส่ง OTP...', 'info');
    try {
        const result = await requestPasswordResetOtp({ channel, identifier });
        resetState.channel = channel;
        resetState.identifier = identifier;
        resetState.verificationId = result.verificationId || '';
        resetState.phoneNumber = result.phoneNumber || '';
        resetState.phoneConfirmationResult = null;
        resetState.firebasePhoneAuth = result.firebasePhoneAuth === true;

        if (resetState.firebasePhoneAuth) {
            if (!resetState.phoneNumber) throw new Error('ไม่พบเบอร์โทรศัพท์สำหรับส่ง OTP');
            resetState.phoneConfirmationResult = await signInWithPhoneNumber(
                auth,
                resetState.phoneNumber,
                getForgotRecaptchaVerifier()
            );
        } else if (!resetState.verificationId) {
            throw new Error('ไม่พบรายการ OTP กรุณาขอรหัสใหม่');
        }

        els.forgotRequestForm.hidden = true;
        els.forgotCompleteForm.hidden = false;
        els.forgotOtp?.focus();
        clearOtpUiStatus(els.forgotOtp);
        setStatus('ส่ง OTP สำเร็จ กรุณาตรวจสอบรหัสแล้วตั้งรหัสผ่านใหม่', 'success');
    } catch (error) {
        resetState.phoneConfirmationResult = null;
        resetState.firebasePhoneAuth = false;
        resetRecaptcha();
        setStatus(error.message || 'ไม่พบบัญชีสมาชิกนี้ กรุณาตรวจสอบข้อมูลอีกครั้ง', 'error');
    } finally {
        setForgotBusy(els.forgotRequestForm, false);
    }
});

els.forgotCompleteForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const otp = String(els.forgotOtp?.value || '').trim();
    const password = String(els.forgotPassword?.value || '');
    const confirmPassword = String(els.forgotPasswordConfirm?.value || '');
    if (!/^\d{6}$/.test(otp)) {
        setOtpUiStatus(els.forgotOtp, 'error');
        setStatus('กรุณากรอก OTP 6 หลัก', 'error');
        return;
    }
    if (password.length < 8) {
        setStatus('รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร', 'error');
        return;
    }
    if (password !== confirmPassword) {
        setStatus('Password และ Confirm Password ไม่ตรงกัน', 'error');
        return;
    }

    setForgotBusy(els.forgotCompleteForm, true, 'กำลังรีเซ็ต...');
    setStatus('กำลังรีเซ็ตรหัสผ่าน...', 'info');
    try {
        setOtpUiStatus(els.forgotOtp, 'loading');
        let firebaseIdToken = '';
        if (resetState.firebasePhoneAuth) {
            if (!resetState.phoneConfirmationResult) throw new Error('ไม่พบรายการ OTP กรุณาขอรหัสใหม่');
            const credential = await resetState.phoneConfirmationResult.confirm(otp);
            firebaseIdToken = await credential.user.getIdToken(true);
        }

        const result = await completePasswordReset({
            verificationId: resetState.verificationId,
            channel: resetState.channel,
            identifier: resetState.identifier,
            otp,
            password,
            confirmPassword,
            firebaseIdToken
        });
        const resetIdentifier = resetState.identifier;
        setOtpUiStatus(els.forgotOtp, 'success');
        closeForgotPanel();
        setStatus(result.message || 'รีเซ็ตรหัสผ่านสำเร็จ กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่', 'success');
        if (els.identifier) els.identifier.value = resetIdentifier || els.identifier.value;
        els.password?.focus();
    } catch (error) {
        setOtpUiStatus(els.forgotOtp, 'error');
        setStatus(error.message || 'OTP ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง', 'error');
    } finally {
        setForgotBusy(els.forgotCompleteForm, false);
    }
});

els.form?.addEventListener('submit', async event => {
    event.preventDefault();
    const identifier = String(els.identifier?.value || '').trim();
    const password = String(els.password?.value || '');
    if (!identifier || !password) {
        setStatus('กรุณากรอกเบอร์/อีเมล และรหัสผ่าน', 'error');
        return;
    }
    if (password.length < 8) {
        setStatus('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร', 'error');
        return;
    }

    loginInProgress = true;
    setBusy(true);
    setStatus('กำลังตรวจสอบบัญชี...', 'info');
    try {
        const result = await loginMember({ identifier, password });
        if (!result.customToken) throw new Error('ไม่สามารถสร้าง session เข้าสู่ระบบได้');
        await signInWithCustomToken(auth, result.customToken);
        if (result.profile) storeProfile(result.profile);
        setStatus('เข้าสู่ระบบสำเร็จ กำลังไปหน้าโปรไฟล์...', 'success');
        window.setTimeout(redirectToProfile, 250);
    } catch (error) {
        loginInProgress = false;
        setStatus(error.message || 'เบอร์/อีเมล หรือรหัสผ่านไม่ถูกต้อง', 'error');
    } finally {
        if (!loginInProgress || !authResolved) setBusy(false);
    }
});

showRegisteredMessage();
