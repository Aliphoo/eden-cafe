import { auth } from './firebase-config.js';
import {
    GoogleAuthProvider,
    onAuthStateChanged,
    signInWithCustomToken,
    signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getMyProfile, loginMember, storeProfile } from './member-auth-service.js';

const GOOGLE_SETUP_KEY = 'eden_google_password_setup';

const els = {
    form: document.getElementById('login-form'),
    google: document.getElementById('login-google'),
    identifier: document.getElementById('login-identifier'),
    password: document.getElementById('login-password'),
    status: document.getElementById('login-status'),
    submit: document.getElementById('login-submit')
};

let authResolved = false;
let loginInProgress = false;

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

onAuthStateChanged(auth, user => {
    authResolved = true;
    const waitingForGoogleSetup = sessionStorage.getItem(GOOGLE_SETUP_KEY) === '1';
    if (user && !loginInProgress && !waitingForGoogleSetup) redirectToProfile();
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
