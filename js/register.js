import { auth, db } from './firebase-config.js';
import {
    RecaptchaVerifier,
    signInWithPhoneNumber,
    onAuthStateChanged,
    updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const USER_KEY = 'eden_user';

const state = {
    confirmationResult: null,
    recaptchaVerifier: null,
    recaptchaRendered: false,
    phoneE164: '',
    phoneDisplay: '',
    privacyConsent: false,
    marketingConsent: false,
    authUser: null
};

const els = {
    status: document.getElementById('register-status'),
    phoneForm: document.getElementById('phone-register-form'),
    otpForm: document.getElementById('otp-register-form'),
    profileForm: document.getElementById('profile-register-form'),
    complete: document.getElementById('register-complete'),
    phone: document.getElementById('register-phone'),
    privacy: document.getElementById('register-privacy'),
    marketing: document.getElementById('register-marketing'),
    phonePreview: document.getElementById('register-phone-preview'),
    otp: document.getElementById('register-otp'),
    resend: document.getElementById('register-resend'),
    name: document.getElementById('register-name'),
    lineId: document.getElementById('register-line'),
    birthDate: document.getElementById('register-birthdate'),
    allergies: document.getElementById('register-allergies'),
    address: document.getElementById('register-address'),
    healthNote: document.getElementById('register-health')
};

function setStatus(message, type = 'info') {
    if (!els.status) return;
    els.status.textContent = message || '';
    els.status.dataset.type = type;
    els.status.style.display = message ? 'block' : 'none';
}

function setBusy(form, isBusy, label) {
    const button = form?.querySelector('button[type="submit"]');
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

function cleanString(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeThaiPhone(value) {
    const raw = String(value ?? '').trim();
    const compact = raw.replace(/[^\d+]/g, '');
    const digits = compact.replace(/\D/g, '');

    if (/^\+66\d{8,9}$/.test(compact)) return compact;
    if (/^66\d{8,9}$/.test(digits)) return '+' + digits;
    if (/^0\d{8,9}$/.test(digits)) return '+66' + digits.slice(1);
    if (/^[689]\d{8}$/.test(digits)) return '+66' + digits;

    throw new Error('กรุณากรอกเบอร์โทรไทยให้ถูกต้อง เช่น 08X-XXX-XXXX');
}

function displayThaiPhone(phoneE164) {
    if (phoneE164.startsWith('+66')) return '0' + phoneE164.slice(3);
    return phoneE164;
}

function buildMemberCode(uid) {
    const source = String(uid || '000000').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase().padStart(6, '0');
    return 'ED-' + source;
}

function avatarForName(name) {
    return 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name || 'Eden Member') + '&background=1A9345&color=fff';
}

function getProviderIds(user) {
    return (user?.providerData || []).map(provider => provider.providerId).filter(Boolean);
}

async function ensureRecaptcha() {
    if (!auth) throw new Error('Firebase Auth ยังไม่พร้อมใช้งาน');
    if (state.recaptchaVerifier) return state.recaptchaVerifier;

    const container = document.getElementById('register-recaptcha');
    if (!container) throw new Error('ไม่พบพื้นที่ยืนยัน reCAPTCHA');

    state.recaptchaVerifier = new RecaptchaVerifier(auth, 'register-recaptcha', {
        size: 'normal',
        callback: () => setStatus('ยืนยัน reCAPTCHA แล้ว กดส่ง OTP ได้เลย', 'success'),
        'expired-callback': () => setStatus('reCAPTCHA หมดอายุ กรุณายืนยันใหม่อีกครั้ง', 'warning')
    });

    if (!state.recaptchaRendered) {
        await state.recaptchaVerifier.render();
        state.recaptchaRendered = true;
    }

    return state.recaptchaVerifier;
}

async function sendOtp() {
    state.phoneE164 = normalizeThaiPhone(els.phone?.value);
    state.phoneDisplay = displayThaiPhone(state.phoneE164);
    state.privacyConsent = !!els.privacy?.checked;
    state.marketingConsent = !!els.marketing?.checked;

    if (!state.privacyConsent) {
        throw new Error('กรุณายอมรับการใช้ข้อมูลเพื่อสมัครสมาชิกก่อนส่ง OTP');
    }

    const verifier = await ensureRecaptcha();
    state.confirmationResult = await signInWithPhoneNumber(auth, state.phoneE164, verifier);
    if (els.phonePreview) els.phonePreview.textContent = state.phoneDisplay;
}

async function verifyOtp() {
    const code = cleanString(els.otp?.value, 6);
    if (!/^\d{6}$/.test(code)) throw new Error('กรุณากรอกรหัส OTP 6 หลัก');
    if (!state.confirmationResult) throw new Error('ยังไม่มีรายการ OTP กรุณาส่งรหัสใหม่อีกครั้ง');

    const result = await state.confirmationResult.confirm(code);
    state.authUser = result.user;
    const fallbackName = 'Eden Member ' + (state.phoneDisplay || state.phoneE164).slice(-4);

    if (!state.authUser.displayName) {
        await updateProfile(state.authUser, { displayName: fallbackName });
    }

    await upsertUserProfile(state.authUser, {
        displayName: state.authUser.displayName || fallbackName,
        phone: state.phoneDisplay || state.authUser.phoneNumber || '',
        phoneE164: state.authUser.phoneNumber || state.phoneE164,
        marketingConsent: state.marketingConsent,
        privacyConsent: state.privacyConsent,
        source: 'phone_register'
    });

    await hydrateProfileForm(state.authUser);
}

async function hydrateProfileForm(user) {
    if (!user || !db) return;
    const snap = await getDoc(doc(db, 'users', user.uid));
    const data = snap.exists() ? snap.data() : {};
    const displayName = data.displayName || user.displayName || ('Eden Member ' + String(user.phoneNumber || '').slice(-4));
    if (els.name) els.name.value = displayName;
    if (els.lineId) els.lineId.value = data.lineId || '';
    if (els.birthDate) els.birthDate.value = data.birthDate || '';
    if (els.allergies) els.allergies.value = data.allergies || '';
    if (els.address) els.address.value = data.shippingAddress || '';
    if (els.healthNote) els.healthNote.value = data.healthNote || '';
}

async function upsertUserProfile(user, extras = {}) {
    if (!db || !user?.uid) throw new Error('ไม่พบฐานข้อมูลหรือบัญชีผู้ใช้');

    const displayName = cleanString(extras.displayName || user.displayName || 'Eden Member', 120);
    const payload = {
        uid: user.uid,
        displayName,
        email: cleanString(user.email || extras.email || '', 180),
        photoURL: cleanString(user.photoURL || avatarForName(displayName), 500),
        memberCode: buildMemberCode(user.uid),
        phone: cleanString(extras.phone || displayThaiPhone(user.phoneNumber || '') || '', 40),
        phoneE164: cleanString(extras.phoneE164 || user.phoneNumber || '', 40),
        authProviderIds: getProviderIds(user),
        registrationSource: cleanString(extras.source || 'phone_register', 40),
        marketingConsent: !!extras.marketingConsent,
        privacyConsent: extras.privacyConsent !== false,
        phoneVerifiedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };

    await setDoc(doc(db, 'users', user.uid), payload, { merge: true });

    const storedUser = {
        uid: user.uid,
        name: payload.displayName,
        email: payload.email,
        avatar: payload.photoURL,
        phone: payload.phone,
        phoneNumber: payload.phoneE164,
        isAdmin: false,
        adminRole: ''
    };
    localStorage.setItem(USER_KEY, JSON.stringify(storedUser));
    window.dispatchEvent(new CustomEvent('eden:user-changed'));
}

async function saveProfile(event) {
    event.preventDefault();
    const user = auth.currentUser || state.authUser;
    if (!user) throw new Error('กรุณายืนยัน OTP ก่อนบันทึกข้อมูลสมาชิก');

    const displayName = cleanString(els.name?.value, 120);
    if (!displayName) throw new Error('กรุณากรอกชื่อสมาชิก');

    await updateProfile(user, {
        displayName,
        photoURL: user.photoURL || avatarForName(displayName)
    });

    await upsertUserProfile(user, {
        displayName,
        phone: state.phoneDisplay || displayThaiPhone(user.phoneNumber || ''),
        phoneE164: user.phoneNumber || state.phoneE164,
        lineId: cleanString(els.lineId?.value, 80),
        birthDate: cleanString(els.birthDate?.value, 20),
        allergies: cleanString(els.allergies?.value, 200),
        shippingAddress: cleanString(els.address?.value, 500),
        healthNote: cleanString(els.healthNote?.value, 500),
        marketingConsent: state.marketingConsent,
        privacyConsent: true,
        source: 'phone_register'
    });

    await setDoc(doc(db, 'users', user.uid), {
        lineId: cleanString(els.lineId?.value, 80),
        birthDate: cleanString(els.birthDate?.value, 20),
        allergies: cleanString(els.allergies?.value, 200),
        shippingAddress: cleanString(els.address?.value, 500),
        healthNote: cleanString(els.healthNote?.value, 500),
        updatedAt: serverTimestamp()
    }, { merge: true });

    els.profileForm?.classList.remove('active');
    if (els.complete) els.complete.hidden = false;
    setStatus('บันทึกข้อมูลสมาชิกสำเร็จ', 'success');
}

function describeFirebaseAuthError(error) {
    const code = error?.code || '';
    if (code === 'auth/invalid-phone-number') return 'รูปแบบเบอร์โทรไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';
    if (code === 'auth/captcha-check-failed') return 'ตรวจสอบ reCAPTCHA ไม่ผ่าน กรุณาลองใหม่';
    if (code === 'auth/too-many-requests') return 'ส่งรหัสบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
    if (code === 'auth/quota-exceeded') return 'โควตา SMS ของ Firebase เต็ม กรุณาตรวจสอบใน Firebase Console';
    if (code === 'auth/operation-not-allowed') return 'ยังไม่ได้เปิด Phone provider ใน Firebase Authentication';
    if (code === 'auth/unauthorized-domain') return 'โดเมนนี้ยังไม่ได้อยู่ใน Authorized domains ของ Firebase';
    if (code === 'permission-denied') return 'สิทธิ์ Firestore ยังไม่อนุญาตให้บันทึกโปรไฟล์สมาชิก';
    return error?.message || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';
}

function bindEvents() {
    els.phoneForm?.addEventListener('submit', async event => {
        event.preventDefault();
        setBusy(els.phoneForm, true, 'กำลังส่ง OTP...');
        setStatus('กำลังเตรียมระบบ OTP...', 'info');
        try {
            await sendOtp();
            activateStep('otp');
            setStatus('ส่ง OTP สำเร็จ กรุณาตรวจ SMS แล้วกรอกรหัส 6 หลัก', 'success');
        } catch (error) {
            console.warn('Phone OTP failed:', error);
            setStatus(describeFirebaseAuthError(error), 'error');
            try {
                state.recaptchaVerifier?.clear();
            } catch (_) {
                // Ignore cleanup errors from Firebase reCAPTCHA.
            }
            state.recaptchaVerifier = null;
            state.recaptchaRendered = false;
        } finally {
            setBusy(els.phoneForm, false);
        }
    });

    els.otpForm?.addEventListener('submit', async event => {
        event.preventDefault();
        setBusy(els.otpForm, true, 'กำลังยืนยัน...');
        setStatus('กำลังยืนยัน OTP...', 'info');
        try {
            await verifyOtp();
            activateStep('profile');
            setStatus('ยืนยันเบอร์สำเร็จ กรอกข้อมูลสมาชิกต่อได้เลย', 'success');
        } catch (error) {
            console.warn('OTP confirm failed:', error);
            setStatus(describeFirebaseAuthError(error), 'error');
        } finally {
            setBusy(els.otpForm, false);
        }
    });

    els.profileForm?.addEventListener('submit', async event => {
        setBusy(els.profileForm, true, 'กำลังบันทึก...');
        setStatus('กำลังบันทึกข้อมูลสมาชิก...', 'info');
        try {
            await saveProfile(event);
        } catch (error) {
            event.preventDefault();
            console.warn('Profile registration save failed:', error);
            setStatus(describeFirebaseAuthError(error), 'error');
        } finally {
            setBusy(els.profileForm, false);
        }
    });

    els.resend?.addEventListener('click', async () => {
        setBusy(els.otpForm, true, 'กำลังส่งใหม่...');
        setStatus('กำลังส่ง OTP ใหม่...', 'info');
        try {
            activateStep('phone');
            await sendOtp();
            activateStep('otp');
            setStatus('ส่ง OTP ใหม่สำเร็จ', 'success');
        } catch (error) {
            console.warn('OTP resend failed:', error);
            setStatus(describeFirebaseAuthError(error), 'error');
        } finally {
            setBusy(els.otpForm, false);
        }
    });
}

onAuthStateChanged(auth, user => {
    if (!user || state.authUser) return;
    if (user.phoneNumber) {
        state.authUser = user;
        state.phoneE164 = user.phoneNumber;
        state.phoneDisplay = displayThaiPhone(user.phoneNumber);
        hydrateProfileForm(user).then(() => {
            activateStep('profile');
            setStatus('พบเบอร์ที่ยืนยันแล้ว สามารถตรวจสอบและบันทึกโปรไฟล์ได้เลย', 'success');
        }).catch(error => {
            console.warn('Unable to hydrate phone profile:', error);
        });
    }
});

bindEvents();
