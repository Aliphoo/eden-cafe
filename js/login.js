import { auth } from './firebase-config.js';
import { onAuthStateChanged, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { loginMember, storeProfile } from './member-auth-service.js';

const els = {
    form: document.getElementById('login-form'),
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

function redirectToProfile() {
    window.location.href = '/profile';
}

function showRegisteredMessage() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('registered') === '1') {
        setStatus('สมัครสมาชิกสำเร็จ กรุณาเข้าสู่ระบบ', 'success');
    }
}

onAuthStateChanged(auth, user => {
    authResolved = true;
    if (user && !loginInProgress) redirectToProfile();
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
