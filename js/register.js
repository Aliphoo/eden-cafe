import { auth, db } from './firebase-config.js';
import {
    EmailAuthProvider,
    RecaptchaVerifier,
    linkWithCredential,
    signInWithPhoneNumber,
    onAuthStateChanged,
    updatePassword,
    updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const USER_KEY = 'eden_user';
const PHONE_AUTH_EMAIL_DOMAIN = 'phone.edencafe.co';
const CAN_LOG_CLIENT_ERRORS = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);

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
    username: document.getElementById('register-username'),
    firstName: document.getElementById('register-first-name'),
    lastName: document.getElementById('register-last-name'),
    password: document.getElementById('register-password'),
    passwordConfirm: document.getElementById('register-password-confirm'),
    lineId: document.getElementById('register-line'),
    birthDate: document.getElementById('register-birthdate'),
    allergies: document.getElementById('register-allergies'),
    address: document.getElementById('register-address'),
    healthNote: document.getElementById('register-health')
};

function logClientError(label, error) {
    if (CAN_LOG_CLIENT_ERRORS) console.warn(label, error);
}

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

function phoneAuthEmail(phoneE164) {
    const digits = String(phoneE164 || '').replace(/\D/g, '');
    if (!digits) return '';
    return 'p' + digits + '@' + PHONE_AUTH_EMAIL_DOMAIN;
}

function isInternalPhoneEmail(email) {
    return String(email || '').toLowerCase().endsWith('@' + PHONE_AUTH_EMAIL_DOMAIN);
}

function publicEmail(user, fallback = '') {
    return isInternalPhoneEmail(user?.email) ? fallback : (user?.email || fallback || '');
}

function passwordProviderLinked(user) {
    return getProviderIds(user).includes('password');
}

async function ensurePhonePassword(user, password) {
    const cleanPassword = String(password || '');
    if (!user?.uid) throw new Error('ไม่พบบัญชีผู้ใช้สำหรับตั้งรหัสผ่าน');
    if (cleanPassword.length < 8 || cleanPassword.length > 128) {
        throw new Error('รหัสผ่านต้องมีความยาว 8-128 ตัวอักษร');
    }

    const aliasEmail = phoneAuthEmail(user.phoneNumber || state.phoneE164);
    if (!aliasEmail) throw new Error('ไม่พบเบอร์โทรสำหรับสร้าง USERNAME');

    if (passwordProviderLinked(user)) {
        await updatePassword(user, cleanPassword);
        return { user, aliasEmail, passwordLinked: true };
    }

    try {
        const credential = EmailAuthProvider.credential(aliasEmail, cleanPassword);
        const result = await linkWithCredential(user, credential);
        return { user: result.user, aliasEmail, passwordLinked: true };
    } catch (error) {
        if (error?.code === 'auth/provider-already-linked') {
            await updatePassword(user, cleanPassword);
            return { user, aliasEmail, passwordLinked: true };
        }
        throw error;
    }
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
    const displayName = data.displayName || user.displayName || '';
    const parts = String(displayName || '').trim().split(/\s+/);
    if (els.username) els.username.value = data.loginUsername || data.phone || displayThaiPhone(user.phoneNumber || '') || '';
    if (els.firstName) els.firstName.value = data.firstName || parts[0] || '';
    if (els.lastName) els.lastName.value = data.lastName || parts.slice(1).join(' ') || '';
    if (els.lineId) els.lineId.value = data.lineId || '';
    if (els.birthDate) els.birthDate.value = data.birthDate || '';
    if (els.allergies) els.allergies.value = data.allergies || '';
    if (els.address) els.address.value = data.shippingAddress || '';
    if (els.healthNote) els.healthNote.value = data.healthNote || '';
}

async function upsertUserProfile(user, extras = {}) {
    if (!db || !user?.uid) throw new Error('ไม่พบฐานข้อมูลหรือบัญชีผู้ใช้');

    const displayName = cleanString(extras.displayName || user.displayName || 'Eden Member', 120);
    const phoneE164 = cleanString(extras.phoneE164 || user.phoneNumber || '', 40);
    const userRef = doc(db, 'users', user.uid);
    const existingSnap = await getDoc(userRef);
    const visibleEmail = cleanString(extras.email || publicEmail(user), 180);
    const payload = {
        uid: user.uid,
        displayName,
        photoURL: cleanString(user.photoURL || avatarForName(displayName), 500),
        phone: cleanString(extras.phone || displayThaiPhone(user.phoneNumber || '') || '', 40),
        phoneE164,
        authProviderIds: getProviderIds(user),
        registrationSource: cleanString(extras.source || 'phone_register', 40),
        marketingConsent: !!extras.marketingConsent,
        privacyConsent: extras.privacyConsent !== false,
        phoneVerifiedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };
    if (visibleEmail || !existingSnap.exists()) payload.email = visibleEmail;

    if ('firstName' in extras) payload.firstName = cleanString(extras.firstName, 80);
    if ('lastName' in extras) payload.lastName = cleanString(extras.lastName, 80);
    if ('loginUsername' in extras || phoneE164) payload.loginUsername = cleanString(extras.loginUsername || extras.phone || displayThaiPhone(phoneE164), 40);
    if ('phoneAuthEmail' in extras || phoneE164) payload.phoneAuthEmail = cleanString(extras.phoneAuthEmail || phoneAuthEmail(phoneE164), 180);
    if ('passwordLoginEnabled' in extras) payload.passwordLoginEnabled = extras.passwordLoginEnabled === true;
    if ('profileCompleted' in extras) payload.profileCompleted = extras.profileCompleted === true;

    await setDoc(userRef, payload, { merge: true });

    const existingEmail = existingSnap.exists() ? publicEmail({ email: cleanString(existingSnap.data().email, 180) }) : '';
    const storedEmail = payload.email || existingEmail;
    const storedUser = {
        uid: user.uid,
        name: payload.displayName,
        email: storedEmail,
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

    const firstName = cleanString(els.firstName?.value, 80);
    const lastName = cleanString(els.lastName?.value, 80);
    const password = String(els.password?.value || '');
    const passwordConfirm = String(els.passwordConfirm?.value || '');
    if (!firstName || !lastName) throw new Error('กรุณากรอกชื่อจริงและนามสกุล');
    if (password !== passwordConfirm) throw new Error('รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน');
    if (password.length < 8 || password.length > 128) throw new Error('รหัสผ่านต้องมีความยาว 8-128 ตัวอักษร');

    const displayName = `${firstName} ${lastName}`.trim();
    const passwordResult = await ensurePhonePassword(user, password);
    state.authUser = passwordResult.user || user;

    await updateProfile(state.authUser, {
        displayName,
        photoURL: state.authUser.photoURL || avatarForName(displayName)
    });

    await upsertUserProfile(state.authUser, {
        displayName,
        firstName,
        lastName,
        phone: state.phoneDisplay || displayThaiPhone(state.authUser.phoneNumber || ''),
        phoneE164: state.authUser.phoneNumber || state.phoneE164,
        loginUsername: state.phoneDisplay || displayThaiPhone(state.authUser.phoneNumber || ''),
        phoneAuthEmail: passwordResult.aliasEmail,
        passwordLoginEnabled: true,
        profileCompleted: true,
        lineId: cleanString(els.lineId?.value, 80),
        birthDate: cleanString(els.birthDate?.value, 20),
        allergies: cleanString(els.allergies?.value, 200),
        shippingAddress: cleanString(els.address?.value, 500),
        healthNote: cleanString(els.healthNote?.value, 500),
        marketingConsent: state.marketingConsent,
        privacyConsent: true,
        source: 'phone_register'
    });

    await setDoc(doc(db, 'users', state.authUser.uid), {
        firstName,
        lastName,
        loginUsername: state.phoneDisplay || displayThaiPhone(state.authUser.phoneNumber || ''),
        phoneAuthEmail: passwordResult.aliasEmail,
        passwordLoginEnabled: true,
        profileCompleted: true,
        onboardingCompletedAt: serverTimestamp(),
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
    window.setTimeout(() => {
        const next = new URLSearchParams(location.search).get('next') || '/profile';
        window.location.href = next.startsWith('/') ? next : '/profile';
    }, 900);
}

function describeFirebaseAuthError(error) {
    const code = error?.code || '';
    if (code === 'auth/invalid-phone-number') return 'รูปแบบเบอร์โทรไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';
    if (code === 'auth/captcha-check-failed') return 'ตรวจสอบ reCAPTCHA ไม่ผ่าน กรุณาลองใหม่';
    if (code === 'auth/too-many-requests') return 'ส่งรหัสบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่';
    if (code === 'auth/quota-exceeded') return 'โควตา SMS ของ Firebase เต็ม กรุณาตรวจสอบใน Firebase Console';
    if (code === 'auth/operation-not-allowed') return 'ยังไม่ได้เปิด Phone provider ใน Firebase Authentication';
    if (code === 'auth/unauthorized-domain') return 'โดเมนนี้ยังไม่ได้อยู่ใน Authorized domains ของ Firebase';
    if (code === 'auth/email-already-in-use' || code === 'auth/credential-already-in-use') return 'เบอร์โทรนี้มี USERNAME อยู่แล้ว กรุณาเข้าสู่ระบบด้วย OTP หรือแจ้งร้านเพื่อตรวจสอบ';
    if (code === 'auth/requires-recent-login') return 'กรุณายืนยัน OTP ใหม่อีกครั้งก่อนตั้งรหัสผ่าน';
    if (code === 'auth/weak-password') return 'รหัสผ่านง่ายเกินไป กรุณาตั้งรหัสผ่านใหม่อย่างน้อย 8 ตัวอักษร';
    if (code === 'permission-denied') return 'สิทธิ์ Firestore ยังไม่อนุญาตให้บันทึกโปรไฟล์สมาชิก';
    return 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';
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
            logClientError('Phone OTP failed:', error);
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
            const profileSnap = db && state.authUser?.uid ? await getDoc(doc(db, 'users', state.authUser.uid)) : null;
            const profile = profileSnap?.exists() ? profileSnap.data() : {};
            if (profile.profileCompleted === true) {
                setStatus('ยืนยันเบอร์สำเร็จ กำลังพาไปหน้าถัดไป...', 'success');
                const next = new URLSearchParams(location.search).get('next') || '/profile';
                window.setTimeout(() => { window.location.href = next.startsWith('/') ? next : '/profile'; }, 500);
                return;
            }
            activateStep('profile');
            setStatus('ยืนยันเบอร์สำเร็จ กรุณากรอกชื่อจริง นามสกุล และตั้งรหัสผ่าน', 'success');
        } catch (error) {
            logClientError('OTP confirm failed:', error);
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
            logClientError('Profile registration save failed:', error);
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
            logClientError('OTP resend failed:', error);
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
            if (els.username) els.username.value = state.phoneDisplay;
            activateStep('profile');
            setStatus('พบเบอร์ที่ยืนยันแล้ว กรุณาตั้งค่าบัญชีให้ครบเพื่อเริ่มใช้งาน', 'success');
        }).catch(error => {
            logClientError('Unable to hydrate phone profile:', error);
        });
    }
});

bindEvents();
