import './page-telemetry.js';
import { autoEnhanceOtpInputs, clearOtpUiStatus, setOtpUiStatus } from './eden-otp-experience.js?v=otp-experience-20260624-1';
import { auth } from './firebase-config.js';
import {
    GoogleAuthProvider,
    onAuthStateChanged,
    RecaptchaVerifier,
    signOut,
    signInWithCustomToken,
    signInWithPhoneNumber,
    signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    completePasswordReset,
    getMyProfile,
    loginMember,
    requestPasswordResetOtp,
    storeProfile,
    verifyPasswordResetOtp
} from './member-auth-service.js?v=password-reset-20260630-1';

const GOOGLE_SETUP_KEY = 'eden_google_password_setup';
const FIREBASE_OTP_RESEND_COOLDOWN_MS = 60 * 1000;

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
    forgotOtpStep: document.getElementById('forgot-otp-step'),
    forgotPasswordStep: document.getElementById('forgot-password-step'),
    forgotIdentifierLabel: document.getElementById('forgot-identifier-label'),
    forgotIdentifier: document.getElementById('forgot-identifier'),
    forgotOtp: document.getElementById('forgot-otp'),
    forgotPassword: document.getElementById('forgot-password'),
    forgotPasswordConfirm: document.getElementById('forgot-password-confirm')
};

autoEnhanceOtpInputs();

let authResolved = false;
let loginInProgress = false;
const RESET_AUTH_SUPPRESS_KEY = 'eden_password_reset_auth_suppressed_until';
const resetState = {
    step: 'request',
    active: false,
    channel: 'phone',
    identifier: '',
    verificationId: '',
    resetToken: '',
    firebaseIdToken: '',
    phoneNumber: '',
    phoneConfirmationResult: null,
    recaptchaVerifier: null,
    firebasePhoneAuth: false,
    otpRequestPromise: null,
    otpRequestKey: '',
    nextOtpAllowedAt: 0,
    verifyingOtp: false,
    completing: false
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

function isForgotResetActive() {
    return resetState.active || resetState.verifyingOtp || resetState.completing;
}

function setForgotAuthSuppression(isActive) {
    try {
        if (isActive) {
            sessionStorage.setItem(RESET_AUTH_SUPPRESS_KEY, String(Date.now() + 2 * 60 * 1000));
        } else {
            sessionStorage.removeItem(RESET_AUTH_SUPPRESS_KEY);
        }
    } catch (_) {
    }
}

function clearForgotMemberAuthUi() {
    try {
        localStorage.removeItem('eden_user');
    } catch (_) {
    }
    if (typeof window.clearEdenStoredUser === 'function') {
        window.clearEdenStoredUser('password-reset');
    } else {
        window.dispatchEvent(new CustomEvent('eden:user-changed', { detail: { reason: 'password-reset' } }));
    }
}

function syncForgotStepFields(isBusy = false) {
    const otpActive = resetState.step === 'otp';
    const passwordActive = resetState.step === 'password';
    if (els.forgotOtp) els.forgotOtp.disabled = isBusy || !otpActive;
    if (els.forgotPassword) els.forgotPassword.disabled = isBusy || !passwordActive;
    if (els.forgotPasswordConfirm) els.forgotPasswordConfirm.disabled = isBusy || !passwordActive;
}

function renderForgotResetStep(step) {
    resetState.step = step;
    const showRequest = step === 'request';
    if (els.forgotRequestForm) els.forgotRequestForm.hidden = !showRequest;
    if (els.forgotCompleteForm) els.forgotCompleteForm.hidden = showRequest;
    if (els.forgotOtpStep) els.forgotOtpStep.hidden = step !== 'otp';
    if (els.forgotPasswordStep) els.forgotPasswordStep.hidden = step !== 'password';
    syncForgotStepFields(false);
}

async function clearForgotPhoneAuthSession() {
    try {
        if (auth?.currentUser) await signOut(auth);
        clearForgotMemberAuthUi();
    } catch (error) {
        console.warn('Unable to clear phone reset Firebase session:', error);
    }
}

function getForgotChannel() {
    return document.querySelector('input[name="forgot-channel"]:checked')?.value === 'email' ? 'email' : 'phone';
}

function updateForgotChannelUi() {
    const channel = getForgotChannel();
    resetState.channel = channel;
    resetState.step = 'request';
    resetState.resetToken = '';
    resetState.firebaseIdToken = '';
    resetState.phoneConfirmationResult = null;
    resetState.firebasePhoneAuth = false;
    resetState.otpRequestPromise = null;
    resetState.otpRequestKey = '';
    resetState.nextOtpAllowedAt = 0;
    resetState.verifyingOtp = false;
    resetState.completing = false;
    resetRecaptcha();
    if (els.forgotIdentifierLabel) {
        els.forgotIdentifierLabel.textContent = channel === 'email' ? 'อีเมล' : 'เบอร์โทรศัพท์';
    }
    if (els.forgotIdentifier) {
        els.forgotIdentifier.value = '';
        els.forgotIdentifier.type = channel === 'email' ? 'email' : 'text';
        els.forgotIdentifier.placeholder = channel === 'email' ? 'อีเมลของคุณ' : '08X-XXX-XXXX';
        els.forgotIdentifier.inputMode = channel === 'email' ? 'email' : 'tel';
        els.forgotIdentifier.autocomplete = channel === 'email' ? 'email' : 'tel';
    }
    renderForgotResetStep('request');
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

function forgotOtpCooldownSeconds() {
    return Math.max(0, Math.ceil((resetState.nextOtpAllowedAt - Date.now()) / 1000));
}

function createForgotOtpAlreadySentError() {
    const seconds = forgotOtpCooldownSeconds();
    const error = new Error(seconds
        ? `ส่ง OTP ไปแล้ว กรุณาใช้รหัสล่าสุด หรือรอ ${seconds} วินาทีก่อนส่งใหม่`
        : 'ส่ง OTP ไปแล้ว กรุณาใช้รหัสล่าสุดก่อนขอรหัสใหม่');
    error.code = 'eden/otp-already-sent';
    error.userMessage = true;
    error.retryAfterSeconds = seconds;
    return error;
}

async function requestForgotOtpOnce(channel, identifier) {
    const requestKey = `${channel}:${String(identifier || '').trim()}`;
    if (resetState.otpRequestPromise && resetState.otpRequestKey === requestKey) {
        return resetState.otpRequestPromise;
    }
    if (
        resetState.otpRequestKey === requestKey
        && (resetState.phoneConfirmationResult || resetState.verificationId)
        && Date.now() < resetState.nextOtpAllowedAt
    ) {
        throw createForgotOtpAlreadySentError();
    }

    resetState.otpRequestKey = requestKey;
    resetState.otpRequestPromise = (async () => {
        const result = await requestPasswordResetOtp({ channel, identifier });
        resetState.channel = channel;
        resetState.identifier = identifier;
        resetState.verificationId = result.verificationId || '';
        resetState.resetToken = '';
        resetState.firebaseIdToken = '';
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

        resetState.nextOtpAllowedAt = Date.now() + FIREBASE_OTP_RESEND_COOLDOWN_MS;
        return result;
    })();

    try {
        return await resetState.otpRequestPromise;
    } finally {
        resetState.otpRequestPromise = null;
    }
}

function setForgotBusy(form, isBusy, label) {
    const buttons = form ? Array.from(form.querySelectorAll('button')) : [];
    buttons.forEach(button => {
        if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
        button.disabled = isBusy;
        if (button.type === 'submit') button.textContent = isBusy ? label : button.dataset.defaultText;
    });
    form?.querySelectorAll('input').forEach(input => {
        input.disabled = isBusy || (form === els.forgotCompleteForm && !!input.closest('[hidden]'));
    });
    if (form === els.forgotCompleteForm) syncForgotStepFields(isBusy);
}

function openForgotPanel() {
    if (!els.forgotPanel) return;
    els.forgotPanel.hidden = false;
    resetState.active = true;
    resetState.verificationId = '';
    resetState.identifier = '';
    resetState.resetToken = '';
    resetState.firebaseIdToken = '';
    updateForgotChannelUi();
    els.forgotIdentifier?.focus();
}

function closeForgotPanel() {
    if (!els.forgotPanel) return;
    els.forgotPanel.hidden = true;
    els.forgotRequestForm?.reset();
    els.forgotCompleteForm?.reset();
    resetState.active = false;
    renderForgotResetStep('request');
    resetState.channel = 'phone';
    resetState.identifier = '';
    resetState.verificationId = '';
    resetState.resetToken = '';
    resetState.firebaseIdToken = '';
    resetState.phoneNumber = '';
    resetState.phoneConfirmationResult = null;
    resetState.firebasePhoneAuth = false;
    resetState.otpRequestPromise = null;
    resetState.otpRequestKey = '';
    resetState.nextOtpAllowedAt = 0;
    resetState.verifyingOtp = false;
    resetState.completing = false;
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
    if (!user || loginInProgress || waitingForGoogleSetup || isForgotResetActive()) return;

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
        resetState.active = true;
        await requestForgotOtpOnce(channel, identifier);

        renderForgotResetStep('otp');
        els.forgotOtp?.focus();
        clearOtpUiStatus(els.forgotOtp);
        setStatus('ส่ง OTP สำเร็จ กรุณากรอกรหัสเพื่อยืนยันก่อนตั้งรหัสผ่านใหม่', 'success');
    } catch (error) {
        if (error?.code === 'eden/otp-already-sent') {
            renderForgotResetStep('otp');
            els.forgotOtp?.focus();
            setStatus(error.message, 'info');
        } else {
            resetState.phoneConfirmationResult = null;
            resetState.firebasePhoneAuth = false;
            resetRecaptcha();
            setStatus(error.message || 'ไม่พบบัญชีสมาชิกนี้ กรุณาตรวจสอบข้อมูลอีกครั้ง', 'error');
        }
    } finally {
        setForgotBusy(els.forgotRequestForm, false);
    }
});

els.forgotCompleteForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (resetState.step === 'otp') {
        const otp = String(els.forgotOtp?.value || '').trim();
        if (!/^\d{6}$/.test(otp)) {
            setOtpUiStatus(els.forgotOtp, 'error');
            setStatus('กรุณากรอก OTP 6 หลัก', 'error');
            return;
        }

        resetState.verifyingOtp = true;
        setForgotBusy(els.forgotCompleteForm, true, 'กำลังยืนยัน...');
        setStatus('กำลังยืนยัน OTP...', 'info');
        try {
            setOtpUiStatus(els.forgotOtp, 'loading');
            if (resetState.firebasePhoneAuth) {
                if (!resetState.phoneConfirmationResult) throw new Error('ไม่พบรายการ OTP กรุณาขอรหัสใหม่');
                setForgotAuthSuppression(true);
                const credential = await resetState.phoneConfirmationResult.confirm(otp);
                resetState.firebaseIdToken = await credential.user.getIdToken(true);
                await clearForgotPhoneAuthSession();
                setForgotAuthSuppression(false);
            } else {
                const result = await verifyPasswordResetOtp({
                    verificationId: resetState.verificationId,
                    channel: resetState.channel,
                    identifier: resetState.identifier,
                    otp
                });
                resetState.resetToken = result.resetToken || '';
                if (!resetState.resetToken) throw new Error('ไม่พบข้อมูลยืนยัน OTP กรุณาขอรหัสใหม่');
            }

            setOtpUiStatus(els.forgotOtp, 'success');
            renderForgotResetStep('password');
            els.forgotPassword?.focus();
            setStatus('ยืนยัน OTP สำเร็จ กรุณาตั้งรหัสผ่านใหม่', 'success');
        } catch (error) {
            if (resetState.firebasePhoneAuth) {
                await clearForgotPhoneAuthSession();
                setForgotAuthSuppression(false);
            }
            resetState.firebaseIdToken = '';
            resetState.resetToken = '';
            setOtpUiStatus(els.forgotOtp, 'error');
            setStatus(error.message || 'OTP ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง', 'error');
        } finally {
            resetState.verifyingOtp = false;
            setForgotBusy(els.forgotCompleteForm, false);
        }
        return;
    }

    const password = String(els.forgotPassword?.value || '');
    const confirmPassword = String(els.forgotPasswordConfirm?.value || '');
    if (password.length < 8) {
        setStatus('รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร', 'error');
        return;
    }
    if (password !== confirmPassword) {
        setStatus('Password และ Confirm Password ไม่ตรงกัน', 'error');
        return;
    }

    resetState.completing = true;
    setForgotBusy(els.forgotCompleteForm, true, 'กำลังเปลี่ยน...');
    setStatus('กำลังเปลี่ยนรหัสผ่าน...', 'info');
    try {
        if (resetState.firebasePhoneAuth && !resetState.firebaseIdToken) {
            throw new Error('กรุณายืนยัน OTP ก่อนตั้งรหัสผ่านใหม่');
        }
        if (!resetState.firebasePhoneAuth && !resetState.resetToken) {
            throw new Error('กรุณายืนยัน OTP ก่อนตั้งรหัสผ่านใหม่');
        }

        await completePasswordReset({
            verificationId: resetState.verificationId,
            channel: resetState.channel,
            identifier: resetState.identifier,
            password,
            confirmPassword,
            firebaseIdToken: resetState.firebaseIdToken,
            resetToken: resetState.resetToken
        });
        await clearForgotPhoneAuthSession();
        setForgotAuthSuppression(false);
        clearForgotMemberAuthUi();
        const resetIdentifier = resetState.identifier;
        closeForgotPanel();
        setStatus('รีเซ็ตรหัสผ่านของท่านแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่', 'success');
        if (els.identifier) els.identifier.value = resetIdentifier || els.identifier.value;
        els.password?.focus();
    } catch (error) {
        setStatus(error.message || 'ไม่สามารถเปลี่ยนรหัสผ่านได้ กรุณาลองใหม่อีกครั้ง', 'error');
    } finally {
        resetState.completing = false;
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
