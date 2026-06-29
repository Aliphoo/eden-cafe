const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const OTP_TTL_MS = 5 * 60 * 1000;
const REGISTRATION_TOKEN_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const PHONE_INDEX_COLLECTION = 'phone_number_index';
const OTP_COLLECTION = 'otp_verifications';
const CREDENTIAL_COLLECTION = 'user_credentials';

function createPublicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function cleanString(value, maxLength = 300) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', String(secret || '')).update(String(value || '')).digest('hex');
}

function constantTimeEqualHex(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'hex');
  const rightBuffer = Buffer.from(String(right || ''), 'hex');
  if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function phoneIndexKey(phoneNumber) {
  return sha256(phoneNumber).slice(0, 48);
}

function normalizeThaiPhone(value) {
  const raw = cleanString(value, 40);
  const compact = raw.replace(/[^\d+]/g, '');
  const digits = compact.replace(/\D/g, '');

  if (/^\+66[689]\d{8}$/.test(compact)) return compact;
  if (/^66[689]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0[689]\d{8}$/.test(digits)) return `+66${digits.slice(1)}`;
  if (/^[689]\d{8}$/.test(digits)) return `+66${digits}`;

  throw createPublicError('กรุณากรอกเบอร์โทรศัพท์ไทยให้ถูกต้อง เช่น 08X-XXX-XXXX');
}

function displayThaiPhone(phoneNumber) {
  const value = cleanString(phoneNumber, 40);
  return value.startsWith('+66') ? `0${value.slice(3)}` : value;
}

function normalizeEmail(value) {
  const email = cleanString(value, 180).toLowerCase();
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createPublicError('กรุณากรอกอีเมลให้ถูกต้อง');
  }
  return email;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw createPublicError('รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร');
  }
  return value;
}

function otpHash(phoneNumber, otpCode, otpPepper) {
  return hmacHex(otpPepper, `${phoneNumber}:${otpCode}`);
}

async function hashPassword(password, passwordPepper) {
  const salt = crypto.randomBytes(18);
  const key = await scrypt(`${password}\0${passwordPepper || ''}`, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    'v1',
    '16384',
    '8',
    '1',
    base64UrlEncode(salt),
    base64UrlEncode(key),
  ].join('$');
}

async function verifyPassword(password, storedHash, passwordPepper) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return false;
  const [, , n, r, p, saltText, keyText] = parts;
  const salt = base64UrlDecode(saltText);
  const expected = base64UrlDecode(keyText);
  if (!salt.length || !expected.length) return false;
  const actual = await scrypt(`${password}\0${passwordPepper || ''}`, salt, expected.length, {
    N: Number(n) || 16384,
    r: Number(r) || 8,
    p: Number(p) || 1,
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createRegistrationToken(payload, otpPepper) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = hmacHex(otpPepper, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyRegistrationToken(token, otpPepper) {
  const [encodedPayload, signature] = String(token || '').split('.');
  if (!encodedPayload || !signature) throw createPublicError('ข้อมูลยืนยัน OTP หมดอายุ กรุณาส่ง OTP ใหม่');
  const expected = hmacHex(otpPepper, encodedPayload);
  if (!constantTimeEqualHex(signature, expected)) {
    throw createPublicError('ข้อมูลยืนยัน OTP ไม่ถูกต้อง กรุณาส่ง OTP ใหม่');
  }
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  } catch (_) {
    throw createPublicError('ข้อมูลยืนยัน OTP ไม่ถูกต้อง กรุณาส่ง OTP ใหม่');
  }
  if (!payload || payload.v !== 1 || !payload.verificationId || !payload.phoneNumber || !payload.expiresAt) {
    throw createPublicError('ข้อมูลยืนยัน OTP ไม่ถูกต้อง กรุณาส่ง OTP ใหม่');
  }
  if (Number(payload.expiresAt) < Date.now()) {
    throw createPublicError('ข้อมูลยืนยัน OTP หมดอายุ กรุณาส่ง OTP ใหม่');
  }
  return payload;
}

function randomOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function timestampToIso(value) {
  if (!value) return '';
  const date = value.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function authMemberCode(uid) {
  const source = String(uid || '000000').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase().padStart(6, '0');
  return `ED-${source}`;
}

function normalizeDateString(value) {
  const dateText = cleanString(value, 20);
  if (!dateText) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    throw createPublicError('กรุณากรอกวันเกิดในรูปแบบ YYYY-MM-DD');
  }
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateText) {
    throw createPublicError('กรุณากรอกวันเกิดให้ถูกต้อง');
  }
  return dateText;
}

function normalizeProfileNameFields(body = {}, existing = {}, options = {}) {
  const fallbackName = cleanString(options.fallbackName || existing.display_name || existing.displayName || existing.name || 'สมาชิก Eden', 120);
  const firstName = cleanString(body.firstName || body.first_name || existing.firstName || existing.first_name || '', 80);
  const lastName = cleanString(body.lastName || body.last_name || existing.lastName || existing.last_name || '', 80);
  const requestedDisplayName = cleanString(body.displayName || body.display_name || body.name || '', 120);
  const displayName = cleanString(requestedDisplayName || [firstName, lastName].filter(Boolean).join(' ') || fallbackName, 120);

  if (options.requireFullName && (!firstName || !lastName)) {
    throw createPublicError('กรุณากรอกชื่อและนามสกุล');
  }
  if (options.requireDisplayName && !displayName) {
    throw createPublicError('กรุณากรอกชื่อสมาชิก');
  }

  return { firstName, lastName, displayName };
}

function normalizeShippingAddressStructured(value = {}, fallbackText = '') {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {
    addressLine: cleanString(source.addressLine || source.address_line || source.line1 || source.address || '', 250),
    subdistrict: cleanString(source.subdistrict || source.subdistrictName || source.subdistrict_name || '', 80),
    district: cleanString(source.district || source.districtName || source.district_name || '', 80),
    province: cleanString(source.province || source.provinceName || source.province_name || '', 80),
    zipcode: cleanString(source.zipcode || source.postalCode || source.postal_code || source.zip || '', 10),
  };
  if (!Object.values(normalized).some(Boolean) && fallbackText) {
    normalized.addressLine = cleanString(fallbackText, 250);
  }
  return normalized;
}

function formatShippingAddress(address = {}) {
  return [
    address.addressLine,
    address.subdistrict,
    address.district,
    address.province,
    address.zipcode,
  ].map(part => cleanString(part, 250)).filter(Boolean).join(', ');
}

function sanitizeProfile(uid, data = {}, credential = {}) {
  const credentialPhoneNumber = cleanString(credential.phone_number || '', 40);
  const phoneNumber = cleanString(data.phone_number || data.phoneE164 || credentialPhoneNumber || data.phone || '', 40);
  const displayName = cleanString(data.display_name || data.displayName || data.name || '', 120);
  const firstName = cleanString(data.firstName || data.first_name || '', 80);
  const lastName = cleanString(data.lastName || data.last_name || '', 80);
  const avatarUrl = cleanString(data.avatar_url || data.photoURL || '', 500);
  const memberLevel = cleanString(data.member_level || data.tier || 'Silver', 40) || 'Silver';
  const hasPasswordHash = !!cleanString(credential.password_hash || '', 2000);
  const emailVerifiedAt = data.emailVerifiedAt || data.email_verified_at || null;
  const phoneVerifiedAt = data.phoneVerifiedAt || data.phone_verified_at || null;
  const credentialMatchesPhone = !!credentialPhoneNumber && !!phoneNumber && credentialPhoneNumber === phoneNumber;
  const phoneVerified = data.phoneVerified === true || data.phone_verified === true || !!phoneVerifiedAt || credentialMatchesPhone;
  const phoneDisplay = cleanString(data.phone_display || (phoneVerified ? data.phone : '') || displayThaiPhone(phoneNumber), 40);
  const shippingAddressStructured = normalizeShippingAddressStructured(
    data.shippingAddressStructured || data.shipping_address_structured || {},
    data.shippingAddress || data.address || ''
  );
  const shippingAddress = cleanString(data.shippingAddress || data.address || formatShippingAddress(shippingAddressStructured), 500);
  return {
    id: cleanString(data.id || data.uid || uid, 160),
    uid: cleanString(data.uid || uid, 160),
    phone_number: phoneNumber,
    phone_display: phoneDisplay,
    phoneVerified,
    phoneVerifiedAt: timestampToIso(phoneVerifiedAt),
    email: cleanString(data.email || data.email_lower || '', 180) || null,
    emailVerified: data.emailVerified === true || data.email_verified === true,
    emailVerifiedAt: timestampToIso(emailVerifiedAt),
    display_name: displayName || null,
    displayName: displayName || null,
    firstName,
    lastName,
    avatar_url: avatarUrl || null,
    shippingAddress,
    shippingAddressStructured,
    shipping_address_structured: shippingAddressStructured,
    birthDate: cleanString(data.birthDate || '', 20),
    allergies: cleanString(data.allergies || '', 200),
    healthNote: cleanString(data.healthNote || '', 500),
    lineId: cleanString(data.lineId || '', 80),
    member_level: ['Silver', 'Gold', 'Platinum'].includes(memberLevel) ? memberLevel : 'Silver',
    points: Math.max(0, Math.floor(Number(data.points || 0))),
    password_login_enabled: hasPasswordHash || data.passwordLoginEnabled === true || data.password_login_enabled === true,
    auth_provider_ids: Array.isArray(data.authProviderIds) ? data.authProviderIds : [],
    created_at: timestampToIso(data.created_at || data.createdAt || data.authCreatedAt),
    updated_at: timestampToIso(data.updated_at || data.updatedAt),
    last_login_at: timestampToIso(data.last_login_at || data.lastLoginAt),
  };
}

function createMemberAuthHandlers({
  admin,
  db,
  logger,
  setCors,
  handleOptions,
  checkRateLimit,
  checkRateLimitKey,
  getOtpPepper,
  getPasswordPepper,
  getSmsConfig,
  sendOtpEmail,
  requireSignedInUser,
}) {
  function jsonError(res, error, fallback = 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง') {
    const status = error.statusCode || 500;
    const message = error.publicMessage || (status >= 500 ? fallback : error.message || fallback);
    res.status(status).json({ error: message });
  }

  async function sendOtpSms(phoneNumber, code, purpose = 'register') {
    const config = getSmsConfig();
    const url = cleanString(config.url, 500);
    if (!url) {
      throw createPublicError('ยังไม่ได้ตั้งค่าผู้ให้บริการส่ง OTP', 503);
    }

    const sender = cleanString(config.sender || 'Eden Cafe', 80);
    let message = purpose === 'password_reset'
      ? `รหัส OTP สำหรับรีเซ็ตรหัสผ่านสมาชิก Eden Cafe คือ ${code} รหัสนี้หมดอายุใน 5 นาที`
      : `รหัส OTP สำหรับสมัครสมาชิก Eden Cafe คือ ${code} รหัสนี้หมดอายุใน 5 นาที`;
    if (purpose === 'phone_change') {
      message = `รหัส OTP สำหรับยืนยันเบอร์โทรศัพท์สมาชิก Eden Cafe คือ ${code} รหัสนี้หมดอายุใน 5 นาที`;
    }
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = cleanString(config.apiKey, 500);
    if (apiKey) {
      headers.Authorization = /^(Basic|Bearer)\s+/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: phoneNumber, sender, message }),
    });

    if (!response.ok) {
      logger.warn('OTP SMS provider failed', {
        status: response.status,
        phoneHash: sha256(phoneNumber).slice(0, 12),
      });
      throw createPublicError('ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', 502);
    }
  }

  async function findUsersByPhone(phoneNumber) {
    const candidates = [];
    const seenUids = new Set();
    const addCandidate = (uid, data = {}) => {
      const safeUid = cleanString(uid, 160);
      if (!safeUid || seenUids.has(safeUid)) return;
      seenUids.add(safeUid);
      candidates.push({ uid: safeUid, data: data || {} });
    };

    const indexSnap = await db.collection(PHONE_INDEX_COLLECTION).doc(phoneIndexKey(phoneNumber)).get();
    if (indexSnap.exists && indexSnap.data()?.uid) {
      const userSnap = await db.collection('users').doc(indexSnap.data().uid).get();
      addCandidate(
        cleanString(indexSnap.data().uid, 160),
        userSnap.exists ? userSnap.data() || {} : {}
      );
    }

    const phoneDisplay = displayThaiPhone(phoneNumber);
    const queries = await Promise.all([
      db.collection('users').where('phone_number', '==', phoneNumber).limit(10).get(),
      db.collection('users').where('phoneE164', '==', phoneNumber).limit(10).get(),
      db.collection('users').where('phone', '==', phoneDisplay).limit(10).get(),
      db.collection('users').where('loginUsername', '==', phoneDisplay).limit(10).get(),
    ]);
    for (const snap of queries) {
      for (const doc of snap.docs) addCandidate(doc.id, doc.data() || {});
    }

    const credentialSnap = await db.collection(CREDENTIAL_COLLECTION)
      .where('phone_number', '==', phoneNumber)
      .limit(10)
      .get();
    for (const credentialDoc of credentialSnap.docs) {
      const userSnap = await db.collection('users').doc(credentialDoc.id).get();
      addCandidate(
        credentialDoc.id,
        userSnap.exists ? userSnap.data() || {} : {
          uid: credentialDoc.id,
          phone_number: phoneNumber,
          phone_display: displayThaiPhone(phoneNumber),
          phone: displayThaiPhone(phoneNumber),
        }
      );
    }
    return candidates;
  }

  async function findUserByPhone(phoneNumber) {
    return (await findUsersByPhone(phoneNumber))[0] || null;
  }

  async function hydrateMemberCandidates(candidates = []) {
    const hydrated = [];
    for (const candidate of candidates) {
      const uid = cleanString(candidate?.uid, 160);
      if (!uid) continue;
      const credential = await getCredential(uid);
      hydrated.push({
        uid,
        data: candidate.data || {},
        credential,
        hasPasswordHash: !!credential.password_hash,
        hasPasswordLogin: credential.password_hash
          || candidate.data?.passwordLoginEnabled === true
          || candidate.data?.password_login_enabled === true,
      });
    }
    return hydrated;
  }

  async function selectPreferredMemberForReset(candidates = []) {
    const hydrated = await hydrateMemberCandidates(candidates);
    if (!hydrated.length) return null;
    hydrated.sort((a, b) => {
      if (a.hasPasswordHash !== b.hasPasswordHash) return a.hasPasswordHash ? -1 : 1;
      if (a.hasPasswordLogin !== b.hasPasswordLogin) return a.hasPasswordLogin ? -1 : 1;
      return 0;
    });
    return hydrated[0];
  }

  async function findUserByEmail(email) {
    const lowerEmail = normalizeEmail(email);
    const credentialSnap = await db.collection(CREDENTIAL_COLLECTION)
      .where('email_lower', '==', lowerEmail)
      .limit(10)
      .get();

    const credentialDocs = credentialSnap.docs
      .map(doc => ({ id: doc.id, data: doc.data() || {} }))
      .filter(item => item.data.uid || item.id);
    const credentialWithPassword = credentialDocs.find(item => !!item.data.password_hash);
    const preferredCredential = credentialWithPassword || credentialDocs[0];
    if (preferredCredential) {
      const uid = cleanString(preferredCredential.data.uid || preferredCredential.id, 160);
      const userSnap = await db.collection('users').doc(uid).get();
      return {
        uid,
        data: userSnap.exists ? userSnap.data() || {} : {
          uid,
          email: lowerEmail,
          email_lower: lowerEmail,
        },
      };
    }

    const queries = await Promise.all([
      db.collection('users').where('email_lower', '==', lowerEmail).limit(10).get(),
      db.collection('users').where('email', '==', lowerEmail).limit(10).get(),
    ]);

    const userCandidates = [];
    const seenUids = new Set();
    for (const snap of queries) {
      for (const doc of snap.docs) {
        if (seenUids.has(doc.id)) continue;
        seenUids.add(doc.id);
        const data = doc.data() || {};
        const credential = await getCredential(doc.id);
        const hasPasswordHash = !!credential.password_hash;
        const hasPhone = !!(credential.phone_number || data.phone_number || data.phoneE164 || data.phone);
        userCandidates.push({ uid: doc.id, data, credential, hasPasswordHash, hasPhone });
      }
    }

    if (userCandidates.length) {
      userCandidates.sort((a, b) => {
        if (a.hasPasswordHash !== b.hasPasswordHash) return a.hasPasswordHash ? -1 : 1;
        if (a.hasPhone !== b.hasPhone) return a.hasPhone ? -1 : 1;
        return 0;
      });
      const preferred = userCandidates[0];
      return { uid: preferred.uid, data: preferred.data || {} };
    }

    return null;
  }

  async function getCredential(uid) {
    const snap = await db.collection(CREDENTIAL_COLLECTION).doc(cleanString(uid, 160)).get();
    return snap.exists ? snap.data() || {} : {};
  }

  async function loadMemberByUid(uid, depth = 0) {
    const safeUid = cleanString(uid, 160);
    if (!safeUid) return null;
    const snap = await db.collection('users').doc(safeUid).get();
    if (snap.exists) {
      const data = snap.data() || {};
      const mergedInto = cleanString(data.mergedInto || data.primaryUid || '', 160);
      if (mergedInto && mergedInto !== safeUid && depth < 3) return loadMemberByUid(mergedInto, depth + 1);
      return { uid: snap.id, data };
    }

    const redirectSnap = await db.collection('member_merge_redirects').doc(safeUid).get();
    const redirect = redirectSnap.exists ? redirectSnap.data() || {} : {};
    const primaryUid = cleanString(redirect.primaryUid || redirect.mergedInto || '', 160);
    if (primaryUid && primaryUid !== safeUid && depth < 3) return loadMemberByUid(primaryUid, depth + 1);
    return null;
  }

  async function findCanonicalMemberForGoogle(decoded = {}) {
    const email = googleEmailFromFirebaseToken(decoded);
    if (!email) return null;
    const byEmail = await findUserByEmail(email);
    return byEmail ? { ...byEmail, email } : null;
  }

  async function ensurePhoneIsAvailable(phoneNumber) {
    const existing = await findUserByPhone(phoneNumber);
    if (existing) throw createPublicError('เบอร์นี้มีในระบบแล้ว กรุณาเข้าสู่ระบบ', 409);

    try {
      await admin.auth().getUserByPhoneNumber(phoneNumber);
      throw createPublicError('เบอร์นี้มีในระบบแล้ว กรุณาเข้าสู่ระบบ', 409);
    } catch (error) {
      if (error.publicMessage) throw error;
      if (error.code !== 'auth/user-not-found') throw error;
    }
  }

  function phoneOwnedByAnotherAccountError() {
    return createPublicError('เบอร์นี้ผูกกับบัญชีสมาชิก Eden อื่นแล้ว กรุณาเข้าสู่ระบบด้วยบัญชีนั้น หรือให้แอดมินรวมบัญชีก่อน', 409);
  }

  function phoneNumberFromFirebaseToken(decoded = {}) {
    const identities = decoded.firebase?.identities || {};
    const candidates = [
      decoded.phone_number,
      Array.isArray(identities.phone) ? identities.phone[0] : '',
      Array.isArray(identities.phone_number) ? identities.phone_number[0] : '',
    ];

    for (const value of candidates) {
      if (!value) continue;
      try {
        return normalizeThaiPhone(value);
      } catch (_) {
        // Ignore malformed identity values and continue checking candidates.
      }
    }
    return '';
  }

  function firebaseProviderIds(decoded = {}) {
    const firebase = decoded.firebase || {};
    const identities = firebase.identities || {};
    const providers = new Set();
    if (firebase.sign_in_provider) providers.add(firebase.sign_in_provider);
    Object.keys(identities).forEach(providerId => providers.add(providerId));
    return Array.from(providers).filter(Boolean);
  }

  function googleEmailFromFirebaseToken(decoded = {}) {
    const providers = firebaseProviderIds(decoded);
    const identities = decoded.firebase?.identities || {};
    const identityEmail = Array.isArray(identities.email) ? identities.email[0] : '';
    const email = normalizeEmail(decoded.email || identityEmail || '');
    const isGoogleProvider = providers.includes('google.com') || decoded.firebase?.sign_in_provider === 'google.com';
    if (!isGoogleProvider) return '';
    if (!email) {
      throw createPublicError('บัญชี Google นี้ไม่มีอีเมล กรุณาเลือกบัญชี Google อื่น', 401);
    }
    if (decoded.email_verified !== true) {
      throw createPublicError('กรุณายืนยันอีเมล Google ก่อนสมัครสมาชิก Eden Cafe', 401);
    }
    return email;
  }

  async function ensurePhoneIsAvailableForUid(phoneNumber, allowedUid) {
    const existing = await findUserByPhone(phoneNumber);
    if (existing && existing.uid !== allowedUid) {
      throw phoneOwnedByAnotherAccountError();
    }

    try {
      const authUser = await admin.auth().getUserByPhoneNumber(phoneNumber);
      if (authUser.uid !== allowedUid) {
        throw phoneOwnedByAnotherAccountError();
      }
    } catch (error) {
      if (error.publicMessage) throw error;
      if (error.code !== 'auth/user-not-found') throw error;
    }
  }

  async function ensureEmailIsAvailableForUid(email, allowedUid) {
    const normalizedEmail = normalizeEmail(email);
    const existing = await findUserByEmail(normalizedEmail);
    if (existing && existing.uid !== allowedUid) {
      throw createPublicError('อีเมลนี้มีบัญชีสมาชิกแล้ว กรุณาเข้าสู่ระบบด้วยอีเมลหรือเลือกบัญชี Google เดิม', 409);
    }

    try {
      const authUser = await admin.auth().getUserByEmail(normalizedEmail);
      if (authUser.uid !== allowedUid) {
        throw createPublicError('อีเมลนี้ผูกกับบัญชี Firebase อื่นแล้ว กรุณาเลือกบัญชี Google เดิม', 409);
      }
    } catch (error) {
      if (error.publicMessage) throw error;
      if (error.code !== 'auth/user-not-found') throw error;
    }
  }

  async function completeFirebasePhoneRegister(req, res, firebaseIdToken) {
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(firebaseIdToken);
    } catch (error) {
      logger.warn('Firebase phone registration token verification failed', {
        message: error.message,
        code: error.code || '',
      });
      throw createPublicError('ไม่สามารถยืนยันบัญชี Firebase ได้ กรุณายืนยัน OTP อีกครั้ง', 401);
    }

    const uid = cleanString(decoded.uid, 160);
    if (!uid) throw createPublicError('ไม่สามารถยืนยันบัญชี Firebase ได้ กรุณาลองใหม่อีกครั้ง', 401);

    const phoneNumber = phoneNumberFromFirebaseToken(decoded);
    if (!phoneNumber) throw createPublicError('บัญชีนี้ยังไม่ได้ยืนยันเบอร์โทรศัพท์ กรุณายืนยัน OTP อีกครั้ง', 401);

    if (req.body?.phoneNumber || req.body?.phone) {
      const requestedPhone = normalizeThaiPhone(req.body.phoneNumber || req.body.phone);
      if (requestedPhone !== phoneNumber) {
        throw createPublicError('เบอร์โทรศัพท์ไม่ตรงกับข้อมูลที่ยืนยัน OTP กรุณาลองใหม่อีกครั้ง', 400);
      }
    }

    checkRateLimitKey(`completeFirebasePhoneRegister:${uid}`, 8, 15 * 60 * 1000);
    checkRateLimitKey(`completeFirebasePhoneRegisterPhone:${phoneIndexKey(phoneNumber)}`, 8, 15 * 60 * 1000);

    const password = validatePassword(req.body?.password);
    if (String(req.body?.confirmPassword || password) !== password) {
      throw createPublicError('Password และ Confirm Password ไม่ตรงกัน');
    }

    await ensurePhoneIsAvailableForUid(phoneNumber, uid);

    const authUser = await admin.auth().getUser(uid).catch(() => null);
    const passwordHash = await hashPassword(password, getPasswordPepper());
    const phoneDisplay = displayThaiPhone(phoneNumber);
    const phoneKey = phoneIndexKey(phoneNumber);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const userRef = db.collection('users').doc(uid);
    const credentialRef = db.collection(CREDENTIAL_COLLECTION).doc(uid);
    const phoneIndexRef = db.collection(PHONE_INDEX_COLLECTION).doc(phoneKey);

    let profileForResponse = null;
    await db.runTransaction(async tx => {
      const [userSnap, credentialSnap, phoneIndexSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(credentialRef),
        tx.get(phoneIndexRef),
      ]);

      const phoneIndex = phoneIndexSnap.exists ? phoneIndexSnap.data() || {} : {};
      if (phoneIndexSnap.exists && phoneIndex.uid && phoneIndex.uid !== uid) {
        throw createPublicError('เบอร์นี้มีในระบบแล้ว กรุณาเข้าสู่ระบบ', 409);
      }

      const credential = credentialSnap.exists ? credentialSnap.data() || {} : {};

      const existing = userSnap.exists ? userSnap.data() || {} : {};
      const existingProviders = Array.isArray(existing.authProviderIds) ? existing.authProviderIds : [];
      const authProviderIds = Array.from(new Set([...existingProviders, 'phone', 'custom_password']));
      const names = normalizeProfileNameFields(req.body || {}, existing, {
        fallbackName: authUser?.displayName || 'สมาชิก Eden',
        requireFullName: true,
      });
      const avatarUrl = cleanString(existing.avatar_url || existing.photoURL || authUser?.photoURL || '', 500);
      const email = normalizeEmail(existing.email || authUser?.email || '');
      const memberLevel = cleanString(existing.member_level || existing.tier || 'Silver', 40) || 'Silver';
      const points = Math.max(0, Math.floor(Number(existing.points || 0)));
      let existingPhoneNumber = '';
      try {
        existingPhoneNumber = normalizeThaiPhone(credential.phone_number || existing.phone_number || existing.phoneE164 || existing.phone || '');
      } catch (_) {
        existingPhoneNumber = '';
      }
      const existingPhoneKey = existingPhoneNumber ? phoneIndexKey(existingPhoneNumber) : '';

      const userPayload = {
        id: cleanString(existing.id || uid, 160),
        uid,
        phone_number: phoneNumber,
        phone_display: phoneDisplay,
        phone: phoneDisplay,
        phoneE164: phoneNumber,
        email,
        email_lower: email,
        firstName: names.firstName,
        lastName: names.lastName,
        display_name: names.displayName,
        displayName: names.displayName,
        name: names.displayName,
        avatar_url: avatarUrl,
        photoURL: avatarUrl,
        member_level: ['Silver', 'Gold', 'Platinum'].includes(memberLevel) ? memberLevel : 'Silver',
        tier: ['Silver', 'Gold', 'Platinum'].includes(memberLevel) ? memberLevel : 'Silver',
        points,
        memberCode: cleanString(existing.memberCode || authMemberCode(uid), 40),
        status: cleanString(existing.status || 'active', 40) || 'active',
        passwordLoginEnabled: true,
        password_login_enabled: true,
        profileCompleted: true,
        authProviderIds,
        registrationSource: cleanString(existing.registrationSource || 'firebase_phone_password', 80),
        phoneVerified: true,
        phoneVerifiedAt: existing.phoneVerifiedAt || now,
        phone_verified: true,
        phone_verified_at: existing.phone_verified_at || now,
        updated_at: now,
        updatedAt: now,
      };
      if (!userSnap.exists || !existing.created_at) userPayload.created_at = now;
      if (!userSnap.exists || !existing.createdAt) userPayload.createdAt = now;

      tx.set(userRef, userPayload, { merge: true });
      tx.set(credentialRef, {
        uid,
        phone_number: phoneNumber,
        phone_index_key: phoneKey,
        email_lower: email,
        password_hash: passwordHash,
        password_algorithm: 'scrypt',
        created_at: credential.created_at || now,
        updated_at: now,
      }, { merge: true });
      tx.set(phoneIndexRef, {
        uid,
        phone_number: phoneNumber,
        updated_at: now,
        created_at: phoneIndex.created_at || now,
      }, { merge: true });

      profileForResponse = { ...existing, ...userPayload };
    });

    res.status(201).json({
      ok: true,
      message: 'สมัครสมาชิกสำเร็จ',
      profile: sanitizeProfile(uid, profileForResponse || {}, { password_hash: passwordHash }),
    });
  }

  async function completeFirebaseGoogleRegister(req, res, decoded) {
    const googleUid = cleanString(decoded.uid, 160);
    if (!googleUid) throw createPublicError('ไม่สามารถยืนยันบัญชี Google ได้ กรุณาลองใหม่อีกครั้ง', 401);

    const email = googleEmailFromFirebaseToken(decoded);
    checkRateLimitKey(`completeFirebaseGoogleRegister:${googleUid}`, 8, 15 * 60 * 1000);
    checkRateLimitKey(`completeFirebaseGoogleRegisterEmail:${sha256(email).slice(0, 48)}`, 8, 15 * 60 * 1000);

    const password = validatePassword(req.body?.password);
    if (String(req.body?.confirmPassword || password) !== password) {
      throw createPublicError('Password และ Confirm Password ไม่ตรงกัน');
    }

    const canonicalMember = await findCanonicalMemberForGoogle(decoded);
    const memberUid = cleanString(canonicalMember?.uid || googleUid, 160);
    if (!canonicalMember) {
      await ensureEmailIsAvailableForUid(email, memberUid);
    }

    const authUser = await admin.auth().getUser(googleUid).catch(() => null);
    const passwordHash = await hashPassword(password, getPasswordPepper());
    const now = admin.firestore.FieldValue.serverTimestamp();
    const userRef = db.collection('users').doc(memberUid);
    const credentialRef = db.collection(CREDENTIAL_COLLECTION).doc(memberUid);

    let profileForResponse = null;
    await db.runTransaction(async tx => {
      const [userSnap, credentialSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(credentialRef),
      ]);

      const existing = userSnap.exists ? userSnap.data() || {} : {};
      const credential = credentialSnap.exists ? credentialSnap.data() || {} : {};
      const existingProviders = Array.isArray(existing.authProviderIds) ? existing.authProviderIds : [];
      const authProviderIds = Array.from(new Set([...existingProviders, ...firebaseProviderIds(decoded), 'google.com', 'custom_password']));
      const names = normalizeProfileNameFields(req.body || {}, existing, {
        fallbackName: authUser?.displayName || decoded.name || email.split('@')[0] || 'สมาชิก Eden',
        requireFullName: true,
      });
      const avatarUrl = cleanString(existing.avatar_url || existing.photoURL || authUser?.photoURL || decoded.picture || '', 500);
      const memberLevel = cleanString(existing.member_level || existing.tier || 'Silver', 40) || 'Silver';
      const points = Math.max(0, Math.floor(Number(existing.points || 0)));
      let existingPhoneNumber = '';
      try {
        existingPhoneNumber = normalizeThaiPhone(credential.phone_number || existing.phone_number || existing.phoneE164 || existing.phone || '');
      } catch (_) {
        existingPhoneNumber = '';
      }
      const existingPhoneKey = existingPhoneNumber ? phoneIndexKey(existingPhoneNumber) : '';

      const userPayload = {
        id: cleanString(existing.id || memberUid, 160),
        uid: memberUid,
        email,
        email_lower: email,
        firstName: names.firstName,
        lastName: names.lastName,
        display_name: names.displayName,
        displayName: names.displayName,
        name: names.displayName,
        avatar_url: avatarUrl,
        photoURL: avatarUrl,
        member_level: ['Silver', 'Gold', 'Platinum'].includes(memberLevel) ? memberLevel : 'Silver',
        tier: ['Silver', 'Gold', 'Platinum'].includes(memberLevel) ? memberLevel : 'Silver',
        points,
        memberCode: cleanString(existing.memberCode || authMemberCode(memberUid), 40),
        status: cleanString(existing.status || 'active', 40) || 'active',
        passwordLoginEnabled: true,
        password_login_enabled: true,
        profileCompleted: true,
        authProviderIds,
        registrationSource: cleanString(existing.registrationSource || 'google_password', 80),
        googleAuthUid: cleanString(existing.googleAuthUid || googleUid, 160),
        updated_at: now,
        updatedAt: now,
      };
      if (existing.phone_number) userPayload.phone_number = existing.phone_number;
      if (existing.phone_display) userPayload.phone_display = existing.phone_display;
      if (existing.phone) userPayload.phone = existing.phone;
      if (existing.phoneE164) userPayload.phoneE164 = existing.phoneE164;
      if (!userSnap.exists || !existing.created_at) userPayload.created_at = now;
      if (!userSnap.exists || !existing.createdAt) userPayload.createdAt = now;

      tx.set(userRef, userPayload, { merge: true });
      tx.set(credentialRef, {
        uid: memberUid,
        phone_number: existingPhoneNumber,
        phone_index_key: credential.phone_index_key || existingPhoneKey,
        email_lower: email,
        password_hash: passwordHash,
        password_algorithm: 'scrypt',
        created_at: credential.created_at || now,
        updated_at: now,
      }, { merge: true });

      profileForResponse = { ...existing, ...userPayload };
    });

    const customToken = await admin.auth().createCustomToken(memberUid, {
      edenMember: true,
      googleAuthUid: googleUid,
    });

    res.status(201).json({
      ok: true,
      message: 'สมัครสมาชิกด้วย Google สำเร็จ',
      customToken,
      profile: sanitizeProfile(memberUid, profileForResponse || {}, { password_hash: passwordHash }),
    });
  }

  async function checkRegisterPhone(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'checkRegisterPhone', 30, 15 * 60 * 1000);
      const phoneNumber = normalizeThaiPhone(req.body?.phoneNumber || req.body?.phone);
      checkRateLimitKey(`checkRegisterPhone:${phoneIndexKey(phoneNumber)}`, 20, 15 * 60 * 1000);
      await ensurePhoneIsAvailable(phoneNumber);
      res.json({
        ok: true,
        phoneNumber,
        phoneDisplay: displayThaiPhone(phoneNumber),
      });
    } catch (error) {
      logger.warn('Register phone precheck failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถตรวจสอบเบอร์โทรศัพท์ได้ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function requestRegisterOtp(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'requestRegisterOtp', 12, 15 * 60 * 1000);
      const phoneNumber = normalizeThaiPhone(req.body?.phoneNumber || req.body?.phone);
      checkRateLimitKey(`requestRegisterOtpPhone:${phoneIndexKey(phoneNumber)}`, 3, 10 * 60 * 1000);
      await ensurePhoneIsAvailable(phoneNumber);

      const code = randomOtpCode();
      const now = admin.firestore.Timestamp.now();
      const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + OTP_TTL_MS));
      const verificationRef = db.collection(OTP_COLLECTION).doc();
      await verificationRef.set({
        phone_number: phoneNumber,
        phone_display: displayThaiPhone(phoneNumber),
        otp_hash: otpHash(phoneNumber, code, getOtpPepper()),
        expires_at: expiresAt,
        verified_at: null,
        used_at: null,
        attempt_count: 0,
        max_attempts: OTP_MAX_ATTEMPTS,
        purpose: 'register',
        created_at: now,
      });

      try {
        await sendOtpSms(phoneNumber, code);
      } catch (error) {
        await verificationRef.delete().catch(() => {});
        throw error;
      }

      res.json({
        ok: true,
        verificationId: verificationRef.id,
        phoneNumber,
        phoneDisplay: displayThaiPhone(phoneNumber),
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      });
    } catch (error) {
      logger.warn('Register OTP request failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถส่ง OTP ได้ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function verifyRegisterOtp(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'verifyRegisterOtp', 30, 10 * 60 * 1000);
      const verificationId = cleanString(req.body?.verificationId, 160);
      if (!verificationId || verificationId.includes('/')) throw createPublicError('ไม่พบรายการ OTP กรุณาส่ง OTP ใหม่');
      const phoneNumber = normalizeThaiPhone(req.body?.phoneNumber || req.body?.phone);
      const code = cleanString(req.body?.otp || req.body?.code, 6);
      if (!/^\d{6}$/.test(code)) throw createPublicError('กรุณากรอก OTP 6 หลัก');

      const verificationRef = db.collection(OTP_COLLECTION).doc(verificationId);
      let publicFailure = null;
      let token = '';
      await db.runTransaction(async tx => {
        const snap = await tx.get(verificationRef);
        if (!snap.exists) {
          publicFailure = createPublicError('ไม่พบรายการ OTP หรือ OTP หมดอายุ กรุณาส่ง OTP ใหม่');
          return;
        }

        const record = snap.data() || {};
        const expiresAt = record.expires_at?.toDate ? record.expires_at.toDate().getTime() : 0;
        if (record.phone_number !== phoneNumber || record.used_at || !expiresAt || expiresAt < Date.now()) {
          publicFailure = createPublicError('OTP หมดอายุหรือไม่ตรงกับเบอร์นี้ กรุณาส่ง OTP ใหม่');
          return;
        }

        const attempts = Math.max(0, Number(record.attempt_count || 0));
        if (attempts >= OTP_MAX_ATTEMPTS) {
          publicFailure = createPublicError('กรอก OTP ผิดเกินจำนวนครั้งที่กำหนด กรุณาส่ง OTP ใหม่');
          return;
        }

        const expected = otpHash(phoneNumber, code, getOtpPepper());
        if (!constantTimeEqualHex(record.otp_hash, expected)) {
          tx.update(verificationRef, {
            attempt_count: admin.firestore.FieldValue.increment(1),
            last_attempt_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          publicFailure = createPublicError('OTP ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง');
          return;
        }

        const tokenExpiresAt = Date.now() + REGISTRATION_TOKEN_TTL_MS;
        token = createRegistrationToken({
          v: 1,
          verificationId,
          phoneNumber,
          expiresAt: tokenExpiresAt,
        }, getOtpPepper());
        tx.update(verificationRef, {
          verified_at: admin.firestore.FieldValue.serverTimestamp(),
          registration_expires_at: admin.firestore.Timestamp.fromDate(new Date(tokenExpiresAt)),
        });
      });

      if (publicFailure) throw publicFailure;
      res.json({
        ok: true,
        verificationId,
        registrationToken: token,
        expiresInSeconds: Math.floor(REGISTRATION_TOKEN_TTL_MS / 1000),
      });
    } catch (error) {
      logger.warn('Register OTP verification failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถยืนยัน OTP ได้ กรุณาลองใหม่อีกครั้ง');
    }
  }

  function normalizeResetIdentifier(channel, identifier) {
    const normalizedChannel = cleanString(channel, 20).toLowerCase();
    if (normalizedChannel === 'phone') {
      const phoneNumber = normalizeThaiPhone(identifier);
      return {
        channel: 'phone',
        identifierKey: phoneNumber,
        identifierDisplay: displayThaiPhone(phoneNumber),
        rateKey: phoneIndexKey(phoneNumber),
      };
    }
    if (normalizedChannel === 'email') {
      const email = normalizeEmail(identifier);
      if (!email) throw createPublicError('กรุณากรอกอีเมลให้ถูกต้อง');
      return {
        channel: 'email',
        identifierKey: email,
        identifierDisplay: email,
        rateKey: sha256(email).slice(0, 48),
      };
    }
    throw createPublicError('กรุณาเลือกช่องทางยืนยันตัวตน');
  }

  async function findMemberForPasswordReset(channel, identifierKey) {
    if (channel === 'phone') {
      const preferred = await selectPreferredMemberForReset(await findUsersByPhone(identifierKey));
      if (preferred) return preferred;

      try {
        const authUser = await admin.auth().getUserByPhoneNumber(identifierKey);
        const userSnap = await db.collection('users').doc(authUser.uid).get();
        const credential = await getCredential(authUser.uid);
        if (userSnap.exists || credential.phone_number || credential.password_hash || credential.email_lower) {
          return {
            uid: authUser.uid,
            data: userSnap.exists ? userSnap.data() || {} : {},
            credential,
          };
        }
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
      }
      return null;
    }

    const byEmail = await findUserByEmail(identifierKey);
    if (byEmail) return (await selectPreferredMemberForReset([byEmail])) || byEmail;

    try {
      const authUser = await admin.auth().getUserByEmail(identifierKey);
      const userSnap = await db.collection('users').doc(authUser.uid).get();
      const credential = await getCredential(authUser.uid);
      if (userSnap.exists || credential.email_lower || credential.password_hash || credential.phone_number) {
        return {
          uid: authUser.uid,
          data: userSnap.exists ? userSnap.data() || {} : {},
          credential,
        };
      }
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
    }
    return null;
  }

  async function firebaseAuthUserForPhone(phoneNumber) {
    try {
      return await admin.auth().getUserByPhoneNumber(phoneNumber);
    } catch (error) {
      if (error.code === 'auth/user-not-found') return null;
      throw error;
    }
  }

  async function applyPasswordResetToMember(uid, passwordHash) {
    const safeUid = cleanString(uid, 160);
    if (!safeUid) throw createPublicError('ไม่พบบัญชีสมาชิกนี้ กรุณาตรวจสอบข้อมูลอีกครั้ง', 404);

    const now = admin.firestore.FieldValue.serverTimestamp();
    const userRef = db.collection('users').doc(safeUid);
    const credentialRef = db.collection(CREDENTIAL_COLLECTION).doc(safeUid);
    let publicFailure = null;
    await db.runTransaction(async tx => {
      const [userSnap, credentialSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(credentialRef),
      ]);
      if (!userSnap.exists && !credentialSnap.exists) {
        publicFailure = createPublicError('ไม่พบบัญชีสมาชิกนี้ กรุณาตรวจสอบข้อมูลอีกครั้ง', 404);
        return;
      }

      const existing = userSnap.exists ? userSnap.data() || {} : {};
      const existingProviders = Array.isArray(existing.authProviderIds) ? existing.authProviderIds : [];
      const authProviderIds = Array.from(new Set([...existingProviders, 'custom_password']));
      tx.set(userRef, {
        passwordLoginEnabled: true,
        password_login_enabled: true,
        authProviderIds,
        updated_at: now,
        updatedAt: now,
      }, { merge: true });
      tx.set(credentialRef, {
        uid: safeUid,
        password_hash: passwordHash,
        password_algorithm: 'scrypt',
        password_reset_at: now,
        updated_at: now,
      }, { merge: true });
    });

    if (publicFailure) throw publicFailure;
  }

  async function sendPasswordResetOtp({ channel, identifierKey, code }) {
    if (channel === 'phone') {
      await sendOtpSms(identifierKey, code, 'password_reset');
      return;
    }

    if (typeof sendOtpEmail !== 'function') {
      throw createPublicError('ยังไม่ได้ตั้งค่าระบบส่ง OTP ทางอีเมล', 503);
    }
    await sendOtpEmail(identifierKey, code, { purpose: 'password_reset' });
  }

  async function requestPasswordResetOtp(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'requestPasswordResetOtp', 12, 15 * 60 * 1000);
      const reset = normalizeResetIdentifier(req.body?.channel, req.body?.identifier);
      checkRateLimitKey(`requestPasswordResetOtp:${reset.channel}:${reset.rateKey}`, 5, 10 * 60 * 1000);

      const member = await findMemberForPasswordReset(reset.channel, reset.identifierKey);
      if (!member?.uid) {
        throw createPublicError('ไม่พบบัญชีสมาชิกนี้ กรุณาตรวจสอบข้อมูลอีกครั้ง', 404);
      }

      if (reset.channel === 'phone' && await firebaseAuthUserForPhone(reset.identifierKey)) {
        res.json({
          ok: true,
          channel: reset.channel,
          identifierDisplay: reset.identifierDisplay,
          phoneNumber: reset.identifierKey,
          phoneDisplay: reset.identifierDisplay,
          firebasePhoneAuth: true,
          expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        });
        return;
      }

      const code = randomOtpCode();
      const now = admin.firestore.Timestamp.now();
      const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + OTP_TTL_MS));
      const verificationRef = db.collection(OTP_COLLECTION).doc();
      await verificationRef.set({
        uid: cleanString(member.uid, 160),
        purpose: 'password_reset',
        channel: reset.channel,
        identifier_key: reset.identifierKey,
        identifier_display: reset.identifierDisplay,
        otp_hash: otpHash(`${reset.channel}:${reset.identifierKey}`, code, getOtpPepper()),
        expires_at: expiresAt,
        verified_at: null,
        used_at: null,
        attempt_count: 0,
        max_attempts: OTP_MAX_ATTEMPTS,
        created_at: now,
      });

      try {
        await sendPasswordResetOtp({
          channel: reset.channel,
          identifierKey: reset.identifierKey,
          code,
        });
      } catch (error) {
        await verificationRef.delete().catch(() => {});
        throw error;
      }

      res.json({
        ok: true,
        verificationId: verificationRef.id,
        channel: reset.channel,
        identifierDisplay: reset.identifierDisplay,
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      });
    } catch (error) {
      logger.warn('Password reset OTP request failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถส่ง OTP รีเซ็ตรหัสผ่านได้ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function completePasswordReset(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'completePasswordReset', 30, 10 * 60 * 1000);
      const reset = normalizeResetIdentifier(req.body?.channel, req.body?.identifier);
      checkRateLimitKey(`completePasswordReset:${reset.channel}:${reset.rateKey}`, 10, 10 * 60 * 1000);
      const password = validatePassword(req.body?.password);
      if (String(req.body?.confirmPassword || '') !== password) {
        throw createPublicError('Password และ Confirm Password ไม่ตรงกัน');
      }

      const firebaseIdToken = cleanString(req.body?.firebaseIdToken || req.body?.idToken, 4000);
      const passwordHash = await hashPassword(password, getPasswordPepper());
      if (firebaseIdToken && reset.channel === 'phone') {
        let decoded;
        try {
          decoded = await admin.auth().verifyIdToken(firebaseIdToken);
        } catch (error) {
          logger.warn('Firebase phone reset token verification failed', {
            message: error.message,
            code: error.code || '',
          });
          throw createPublicError('ไม่สามารถยืนยัน OTP ได้ กรุณาขอรหัสใหม่', 401);
        }

        const tokenPhoneNumber = phoneNumberFromFirebaseToken(decoded);
        if (!tokenPhoneNumber || tokenPhoneNumber !== reset.identifierKey) {
          throw createPublicError('เบอร์โทรศัพท์ไม่ตรงกับข้อมูลที่ยืนยัน OTP กรุณาลองใหม่อีกครั้ง', 400);
        }

        const member = await findMemberForPasswordReset('phone', reset.identifierKey);
        if (!member?.uid) {
          throw createPublicError('ไม่พบบัญชีสมาชิกนี้ กรุณาตรวจสอบข้อมูลอีกครั้ง', 404);
        }

        await applyPasswordResetToMember(member.uid, passwordHash);
        res.json({
          ok: true,
          message: 'รีเซ็ตรหัสผ่านสำเร็จ กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่',
        });
        return;
      }

      const verificationId = cleanString(req.body?.verificationId, 160);
      if (!verificationId || verificationId.includes('/')) {
        throw createPublicError('ไม่พบรายการ OTP กรุณาขอรหัสใหม่');
      }
      const code = cleanString(req.body?.otp || req.body?.code, 6);
      if (!/^\d{6}$/.test(code)) throw createPublicError('กรุณากรอก OTP 6 หลัก');

      const verificationRef = db.collection(OTP_COLLECTION).doc(verificationId);
      let publicFailure = null;
      await db.runTransaction(async tx => {
        const snap = await tx.get(verificationRef);
        if (!snap.exists) {
          publicFailure = createPublicError('ไม่พบรายการ OTP กรุณาขอรหัสใหม่');
          return;
        }

        const record = snap.data() || {};
        const expiresAt = record.expires_at?.toDate ? record.expires_at.toDate().getTime() : 0;
        if (
          record.purpose !== 'password_reset'
          || record.channel !== reset.channel
          || record.identifier_key !== reset.identifierKey
          || record.used_at
        ) {
          publicFailure = createPublicError('ไม่พบรายการ OTP กรุณาขอรหัสใหม่');
          return;
        }
        if (!expiresAt || expiresAt < Date.now()) {
          publicFailure = createPublicError('OTP หมดอายุ กรุณาขอรหัสใหม่');
          return;
        }

        const attempts = Math.max(0, Number(record.attempt_count || 0));
        const maxAttempts = Math.max(1, Number(record.max_attempts || OTP_MAX_ATTEMPTS));
        if (attempts >= maxAttempts) {
          publicFailure = createPublicError('OTP ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง');
          return;
        }

        const expected = otpHash(`${reset.channel}:${reset.identifierKey}`, code, getOtpPepper());
        if (!constantTimeEqualHex(record.otp_hash, expected)) {
          tx.update(verificationRef, {
            attempt_count: admin.firestore.FieldValue.increment(1),
            last_attempt_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          publicFailure = createPublicError('OTP ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง');
          return;
        }

        const uid = cleanString(record.uid, 160);
        if (!uid) {
          publicFailure = createPublicError('ไม่พบบัญชีสมาชิกนี้ กรุณาตรวจสอบข้อมูลอีกครั้ง', 404);
          return;
        }

        const now = admin.firestore.FieldValue.serverTimestamp();
        const userRef = db.collection('users').doc(uid);
        const credentialRef = db.collection(CREDENTIAL_COLLECTION).doc(uid);
        const [userSnap, credentialSnap] = await Promise.all([
          tx.get(userRef),
          tx.get(credentialRef),
        ]);
        if (!userSnap.exists && !credentialSnap.exists) {
          publicFailure = createPublicError('ไม่พบบัญชีสมาชิกนี้ กรุณาตรวจสอบข้อมูลอีกครั้ง', 404);
          return;
        }

        const existing = userSnap.exists ? userSnap.data() || {} : {};
        const existingProviders = Array.isArray(existing.authProviderIds) ? existing.authProviderIds : [];
        const authProviderIds = Array.from(new Set([...existingProviders, 'custom_password']));
        tx.set(userRef, {
          passwordLoginEnabled: true,
          password_login_enabled: true,
          authProviderIds,
          updated_at: now,
          updatedAt: now,
        }, { merge: true });
        tx.set(credentialRef, {
          uid,
          password_hash: passwordHash,
          password_algorithm: 'scrypt',
          password_reset_at: now,
          updated_at: now,
        }, { merge: true });
        tx.update(verificationRef, {
          used_at: now,
          verified_at: now,
          reset_completed_at: now,
        });
      });

      if (publicFailure) throw publicFailure;
      res.json({
        ok: true,
        message: 'รีเซ็ตรหัสผ่านสำเร็จ กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่',
      });
    } catch (error) {
      logger.warn('Password reset completion failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถรีเซ็ตรหัสผ่านได้ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function updateMyProfile(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'updateMyProfile', 40, 15 * 60 * 1000);
      const decoded = await requireSignedInUser(req);
      const member = await loadMemberByUid(decoded.uid);
      if (!member?.uid) throw createPublicError('ไม่พบข้อมูลสมาชิก', 404);
      checkRateLimitKey(`updateMyProfile:${member.uid}`, 30, 10 * 60 * 1000);

      const existing = member.data || {};
      const names = normalizeProfileNameFields(req.body || {}, existing, {
        fallbackName: existing.display_name || existing.displayName || existing.name || 'สมาชิก Eden',
        requireDisplayName: true,
      });
      const now = admin.firestore.FieldValue.serverTimestamp();
      const shippingAddressStructured = normalizeShippingAddressStructured(
        req.body?.shippingAddressStructured || req.body?.shipping_address_structured || req.body || {},
        req.body?.shippingAddress || req.body?.address || ''
      );
      const shippingAddress = cleanString(
        req.body?.shippingAddress || req.body?.address || formatShippingAddress(shippingAddressStructured),
        500
      );
      const payload = {
        uid: member.uid,
        firstName: names.firstName,
        lastName: names.lastName,
        displayName: names.displayName,
        display_name: names.displayName,
        name: names.displayName,
        shippingAddress,
        shippingAddressStructured,
        shipping_address_structured: shippingAddressStructured,
        birthDate: normalizeDateString(req.body?.birthDate || ''),
        allergies: cleanString(req.body?.allergies || '', 200),
        healthNote: cleanString(req.body?.healthNote || '', 500),
        lineId: cleanString(req.body?.lineId || '', 80),
        updated_at: now,
        updatedAt: now,
      };

      await db.collection('users').doc(member.uid).set(payload, { merge: true });
      await admin.auth().updateUser(member.uid, { displayName: names.displayName }).catch(error => {
        if (error.code !== 'auth/user-not-found') {
          logger.warn('Unable to update Auth displayName for member profile', {
            uid: member.uid,
            code: error.code || '',
            message: error.message,
          });
        }
      });

      const [freshUserSnap, credential] = await Promise.all([
        db.collection('users').doc(member.uid).get(),
        getCredential(member.uid),
      ]);
      res.json({
        ok: true,
        profile: sanitizeProfile(member.uid, freshUserSnap.exists ? freshUserSnap.data() || {} : { ...existing, ...payload }, credential),
      });
    } catch (error) {
      logger.warn('Member profile update failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถบันทึกโปรไฟล์ได้ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function checkPhoneChange(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'checkPhoneChange', 30, 15 * 60 * 1000);
      const decoded = await requireSignedInUser(req);
      const member = await loadMemberByUid(decoded.uid);
      if (!member?.uid) throw createPublicError('ไม่พบข้อมูลสมาชิก', 404);

      const phoneNumber = normalizeThaiPhone(req.body?.phoneNumber || req.body?.phone);
      let currentPhoneNumber = '';
      try {
        const credential = await getCredential(member.uid);
        currentPhoneNumber = normalizeThaiPhone(credential.phone_number || member.data?.phone_number || member.data?.phoneE164 || '');
      } catch (_) {
        currentPhoneNumber = '';
      }

      if (currentPhoneNumber && currentPhoneNumber === phoneNumber) {
        res.json({
          ok: true,
          alreadyVerified: true,
          needsOtp: false,
          phoneNumber,
          phoneDisplay: displayThaiPhone(phoneNumber),
        });
        return;
      }

      checkRateLimitKey(`checkPhoneChange:${member.uid}`, 30, 15 * 60 * 1000);
      checkRateLimitKey(`checkPhoneChangePhone:${phoneIndexKey(phoneNumber)}`, 30, 15 * 60 * 1000);
      await ensurePhoneIsAvailableForUid(phoneNumber, member.uid);

      res.json({
        ok: true,
        available: true,
        needsOtp: true,
        phoneNumber,
        phoneDisplay: displayThaiPhone(phoneNumber),
      });
    } catch (error) {
      logger.warn('Phone change precheck failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถตรวจสอบเบอร์โทรศัพท์ได้ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function requestPhoneChangeOtp(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'requestPhoneChangeOtp', 10, 15 * 60 * 1000);
      const decoded = await requireSignedInUser(req);
      const member = await loadMemberByUid(decoded.uid);
      if (!member?.uid) throw createPublicError('ไม่พบข้อมูลสมาชิก', 404);

      const phoneNumber = normalizeThaiPhone(req.body?.phoneNumber || req.body?.phone);
      let currentPhoneNumber = '';
      try {
        const credential = await getCredential(member.uid);
        currentPhoneNumber = normalizeThaiPhone(credential.phone_number || member.data?.phone_number || member.data?.phoneE164 || member.data?.phone || '');
      } catch (_) {
        currentPhoneNumber = '';
      }
      if (currentPhoneNumber && currentPhoneNumber === phoneNumber) {
        res.json({
          ok: true,
          alreadyVerified: true,
          phoneNumber,
          phoneDisplay: displayThaiPhone(phoneNumber),
        });
        return;
      }

      checkRateLimitKey(`requestPhoneChangeOtp:${member.uid}`, 3, 10 * 60 * 1000);
      checkRateLimitKey(`requestPhoneChangeOtpPhone:${phoneIndexKey(phoneNumber)}`, 3, 10 * 60 * 1000);
      await ensurePhoneIsAvailableForUid(phoneNumber, member.uid);

      const code = randomOtpCode();
      const now = admin.firestore.Timestamp.now();
      const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + OTP_TTL_MS));
      const verificationRef = db.collection(OTP_COLLECTION).doc();
      await verificationRef.set({
        uid: member.uid,
        purpose: 'phone_change',
        channel: 'phone',
        identifier_key: phoneNumber,
        identifier_display: displayThaiPhone(phoneNumber),
        old_phone_number: currentPhoneNumber || null,
        otp_hash: otpHash(`phone_change:${member.uid}:${phoneNumber}`, code, getOtpPepper()),
        expires_at: expiresAt,
        verified_at: null,
        used_at: null,
        attempt_count: 0,
        max_attempts: OTP_MAX_ATTEMPTS,
        created_at: now,
      });

      try {
        await sendOtpSms(phoneNumber, code, 'phone_change');
      } catch (error) {
        await verificationRef.delete().catch(() => {});
        throw error;
      }

      res.json({
        ok: true,
        verificationId: verificationRef.id,
        phoneNumber,
        phoneDisplay: displayThaiPhone(phoneNumber),
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      });
    } catch (error) {
      logger.warn('Phone change OTP request failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถส่ง OTP ยืนยันเบอร์โทรศัพท์ได้ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function verifyPhoneChangeOtp(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'verifyPhoneChangeOtp', 30, 10 * 60 * 1000);
      const decoded = await requireSignedInUser(req);
      const member = await loadMemberByUid(decoded.uid);
      if (!member?.uid) throw createPublicError('ไม่พบข้อมูลสมาชิก', 404);

      const verificationId = cleanString(req.body?.verificationId, 160);
      if (!verificationId || verificationId.includes('/')) {
        throw createPublicError('ไม่พบรายการ OTP กรุณาขอรหัสใหม่');
      }
      const phoneNumber = normalizeThaiPhone(req.body?.phoneNumber || req.body?.phone);
      const code = cleanString(req.body?.otp || req.body?.code, 6);
      if (!/^\d{6}$/.test(code)) throw createPublicError('กรุณากรอก OTP 6 หลัก');

      checkRateLimitKey(`verifyPhoneChangeOtp:${member.uid}`, 12, 10 * 60 * 1000);
      await ensurePhoneIsAvailableForUid(phoneNumber, member.uid);

      const verificationRef = db.collection(OTP_COLLECTION).doc(verificationId);
      const phoneIndexRef = db.collection(PHONE_INDEX_COLLECTION).doc(phoneIndexKey(phoneNumber));
      const userRef = db.collection('users').doc(member.uid);
      const credentialRef = db.collection(CREDENTIAL_COLLECTION).doc(member.uid);
      let profileForResponse = null;
      let credentialForResponse = null;
      let publicFailure = null;

      await db.runTransaction(async tx => {
        const [verificationSnap, userSnap, credentialSnap, phoneIndexSnap] = await Promise.all([
          tx.get(verificationRef),
          tx.get(userRef),
          tx.get(credentialRef),
          tx.get(phoneIndexRef),
        ]);
        if (!verificationSnap.exists) {
          publicFailure = createPublicError('ไม่พบรายการ OTP กรุณาขอรหัสใหม่');
          return;
        }

        const record = verificationSnap.data() || {};
        const expiresAt = record.expires_at?.toDate ? record.expires_at.toDate().getTime() : 0;
        if (
          record.purpose !== 'phone_change'
          || record.channel !== 'phone'
          || record.uid !== member.uid
          || record.identifier_key !== phoneNumber
          || record.used_at
        ) {
          publicFailure = createPublicError('ไม่พบรายการ OTP กรุณาขอรหัสใหม่');
          return;
        }
        if (!expiresAt || expiresAt < Date.now()) {
          publicFailure = createPublicError('OTP หมดอายุ กรุณาขอรหัสใหม่');
          return;
        }

        const attempts = Math.max(0, Number(record.attempt_count || 0));
        const maxAttempts = Math.max(1, Number(record.max_attempts || OTP_MAX_ATTEMPTS));
        if (attempts >= maxAttempts) {
          publicFailure = createPublicError('OTP ไม่ถูกต้อง กรุณาขอรหัสใหม่');
          return;
        }

        const expected = otpHash(`phone_change:${member.uid}:${phoneNumber}`, code, getOtpPepper());
        if (!constantTimeEqualHex(record.otp_hash, expected)) {
          tx.update(verificationRef, {
            attempt_count: admin.firestore.FieldValue.increment(1),
            last_attempt_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          publicFailure = createPublicError('OTP ไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง');
          return;
        }

        const phoneIndex = phoneIndexSnap.exists ? phoneIndexSnap.data() || {} : {};
        if (phoneIndexSnap.exists && phoneIndex.uid && phoneIndex.uid !== member.uid) {
          publicFailure = phoneOwnedByAnotherAccountError();
          return;
        }

        const existing = userSnap.exists ? userSnap.data() || {} : member.data || {};
        const credential = credentialSnap.exists ? credentialSnap.data() || {} : {};
        let oldPhoneNumber = '';
        try {
          oldPhoneNumber = normalizeThaiPhone(credential.phone_number || existing.phone_number || existing.phoneE164 || existing.phone || '');
        } catch (_) {
          oldPhoneNumber = '';
        }
        const oldPhoneIndexRef = oldPhoneNumber && oldPhoneNumber !== phoneNumber
          ? db.collection(PHONE_INDEX_COLLECTION).doc(phoneIndexKey(oldPhoneNumber))
          : null;
        const oldPhoneIndexSnap = oldPhoneIndexRef ? await tx.get(oldPhoneIndexRef) : null;
        const oldPhoneIndex = oldPhoneIndexSnap?.exists ? oldPhoneIndexSnap.data() || {} : {};

        const now = admin.firestore.FieldValue.serverTimestamp();
        const phoneDisplay = displayThaiPhone(phoneNumber);
        const existingProviders = Array.isArray(existing.authProviderIds) ? existing.authProviderIds : [];
        const authProviderIds = Array.from(new Set([...existingProviders, 'phone']));
        const userPayload = {
          uid: member.uid,
          phone_number: phoneNumber,
          phone_display: phoneDisplay,
          phone: phoneDisplay,
          phoneE164: phoneNumber,
          loginUsername: phoneNumber,
          phoneVerified: true,
          phoneVerifiedAt: now,
          phone_verified: true,
          phone_verified_at: now,
          authProviderIds,
          updated_at: now,
          updatedAt: now,
        };
        tx.set(userRef, userPayload, { merge: true });
        tx.set(credentialRef, {
          uid: member.uid,
          phone_number: phoneNumber,
          phone_index_key: phoneIndexKey(phoneNumber),
          updated_at: now,
        }, { merge: true });
        tx.set(phoneIndexRef, {
          uid: member.uid,
          phone_number: phoneNumber,
          updated_at: now,
          created_at: phoneIndex.created_at || now,
        }, { merge: true });
        if (oldPhoneIndexRef && oldPhoneIndex.uid === member.uid) {
          tx.delete(oldPhoneIndexRef);
        }
        tx.update(verificationRef, {
          used_at: now,
          verified_at: now,
        });

        profileForResponse = { ...existing, ...userPayload };
        credentialForResponse = { ...credential, phone_number: phoneNumber, phone_index_key: phoneIndexKey(phoneNumber) };
      });

      if (publicFailure) throw publicFailure;

      await admin.auth().updateUser(member.uid, { phoneNumber }).catch(error => {
        if (error.code !== 'auth/user-not-found') {
          logger.warn('Phone verified in Firestore but Auth phone was not updated', {
            uid: member.uid,
            code: error.code || '',
            message: error.message,
          });
        }
      });

      res.json({
        ok: true,
        phoneNumber,
        phoneDisplay: displayThaiPhone(phoneNumber),
        profile: sanitizeProfile(member.uid, profileForResponse || {}, credentialForResponse || {}),
      });
    } catch (error) {
      logger.warn('Phone change OTP verification failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถยืนยันเบอร์โทรศัพท์ได้ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function completeRegister(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'completeRegister', 12, 15 * 60 * 1000);
      const firebaseIdToken = cleanString(req.body?.firebaseIdToken || req.body?.idToken, 4000);
      if (firebaseIdToken) {
        const decoded = await admin.auth().verifyIdToken(firebaseIdToken).catch(error => {
          logger.warn('Firebase registration token verification failed', {
            message: error.message,
            code: error.code || '',
          });
          throw createPublicError('ไม่สามารถยืนยันบัญชี Firebase ได้ กรุณาเข้าสู่ระบบอีกครั้ง', 401);
        });
        if (phoneNumberFromFirebaseToken(decoded)) {
          await completeFirebasePhoneRegister(req, res, firebaseIdToken);
          return;
        }
        if (googleEmailFromFirebaseToken(decoded)) {
          await completeFirebaseGoogleRegister(req, res, decoded);
          return;
        }
        throw createPublicError('กรุณาสมัครด้วยเบอร์โทรศัพท์หรือบัญชี Google ที่ยืนยันแล้ว', 401);
        return;
      }

      const verificationId = cleanString(req.body?.verificationId, 160);
      const phoneNumber = normalizeThaiPhone(req.body?.phoneNumber || req.body?.phone);
      const registrationToken = cleanString(req.body?.registrationToken, 1200);
      const tokenPayload = verifyRegistrationToken(registrationToken, getOtpPepper());
      if (tokenPayload.verificationId !== verificationId || tokenPayload.phoneNumber !== phoneNumber) {
        throw createPublicError('ข้อมูลยืนยัน OTP ไม่ตรงกัน กรุณาส่ง OTP ใหม่');
      }

      const password = validatePassword(req.body?.password);
      if (String(req.body?.confirmPassword || password) !== password) {
        throw createPublicError('Password และ Confirm Password ไม่ตรงกัน');
      }
      await ensurePhoneIsAvailable(phoneNumber);

      const uid = `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;
      const passwordHash = await hashPassword(password, getPasswordPepper());
      const names = normalizeProfileNameFields(req.body || {}, {}, {
        fallbackName: 'สมาชิก Eden',
        requireFullName: true,
      });
      const phoneDisplay = displayThaiPhone(phoneNumber);
      const phoneKey = phoneIndexKey(phoneNumber);
      const now = admin.firestore.FieldValue.serverTimestamp();
      const verificationRef = db.collection(OTP_COLLECTION).doc(verificationId);
      const userRef = db.collection('users').doc(uid);
      const credentialRef = db.collection(CREDENTIAL_COLLECTION).doc(uid);
      const phoneIndexRef = db.collection(PHONE_INDEX_COLLECTION).doc(phoneKey);

      await db.runTransaction(async tx => {
        const [verificationSnap, phoneIndexSnap] = await Promise.all([
          tx.get(verificationRef),
          tx.get(phoneIndexRef),
        ]);

        if (!verificationSnap.exists) throw createPublicError('ไม่พบรายการ OTP กรุณาส่ง OTP ใหม่');
        const record = verificationSnap.data() || {};
        if (record.phone_number !== phoneNumber || !record.verified_at || record.used_at) {
          throw createPublicError('OTP ยังไม่ผ่านการยืนยันหรือถูกใช้งานแล้ว กรุณาส่ง OTP ใหม่');
        }
        if (phoneIndexSnap.exists) {
          throw createPublicError('เบอร์นี้มีในระบบแล้ว กรุณาเข้าสู่ระบบ', 409);
        }

        tx.set(userRef, {
          id: uid,
          uid,
          phone_number: phoneNumber,
          phone_display: phoneDisplay,
          phone: phoneDisplay,
          phoneE164: phoneNumber,
          email: '',
          email_lower: '',
          firstName: names.firstName,
          lastName: names.lastName,
          display_name: names.displayName,
          displayName: names.displayName,
          name: names.displayName,
          avatar_url: '',
          photoURL: '',
          member_level: 'Silver',
          tier: 'Silver',
          points: 0,
          memberCode: authMemberCode(uid),
          status: 'active',
          passwordLoginEnabled: true,
          password_login_enabled: true,
          profileCompleted: true,
          authProviderIds: ['custom_password'],
          registrationSource: 'phone_password_otp',
          phoneVerified: true,
          phoneVerifiedAt: now,
          phone_verified: true,
          phone_verified_at: now,
          created_at: now,
          createdAt: now,
          updated_at: now,
          updatedAt: now,
          last_login_at: null,
          lastLoginAt: null,
        });

        tx.set(credentialRef, {
          uid,
          phone_number: phoneNumber,
          phone_index_key: phoneKey,
          email_lower: '',
          password_hash: passwordHash,
          password_algorithm: 'scrypt',
          created_at: now,
          updated_at: now,
        });

        tx.set(phoneIndexRef, {
          uid,
          phone_number: phoneNumber,
          created_at: now,
        });

        tx.update(verificationRef, {
          used_at: now,
          user_id: uid,
        });
      });

      res.status(201).json({
        ok: true,
        message: 'สมัครสมาชิกสำเร็จ กรุณาเข้าสู่ระบบ',
      });
    } catch (error) {
      logger.warn('Register completion failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function loginMember(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'loginMember', 25, 15 * 60 * 1000);
      const identifier = cleanString(req.body?.identifier || req.body?.login, 180);
      const password = validatePassword(req.body?.password);
      if (!identifier) throw createPublicError('กรุณากรอกเบอร์โทรศัพท์หรืออีเมล');

      let lookup;
      let loginCandidates = [];
      let rateKey;
      if (identifier.includes('@')) {
        const email = normalizeEmail(identifier);
        rateKey = `loginEmail:${sha256(email).slice(0, 48)}`;
        checkRateLimitKey(rateKey, 10, 15 * 60 * 1000);
        lookup = await findUserByEmail(email);
        if (lookup) loginCandidates = [lookup];
      } else {
        const phoneNumber = normalizeThaiPhone(identifier);
        rateKey = `loginPhone:${phoneIndexKey(phoneNumber)}`;
        checkRateLimitKey(rateKey, 10, 15 * 60 * 1000);
        loginCandidates = await findUsersByPhone(phoneNumber);
        lookup = loginCandidates[0] || null;
      }

      if (!loginCandidates.length) throw createPublicError('เบอร์/อีเมล หรือรหัสผ่านไม่ถูกต้อง', 401);

      let credential = {};
      let matchedLookup = null;
      for (const candidate of loginCandidates) {
        const candidateCredential = await getCredential(candidate.uid);
        if (!candidateCredential.password_hash) continue;
        const passwordOk = await verifyPassword(password, candidateCredential.password_hash, getPasswordPepper());
        if (passwordOk) {
          matchedLookup = candidate;
          credential = candidateCredential;
          break;
        }
      }
      if (!matchedLookup) throw createPublicError('เบอร์/อีเมล หรือรหัสผ่านไม่ถูกต้อง', 401);
      lookup = matchedLookup;

      const now = admin.firestore.FieldValue.serverTimestamp();
      await Promise.all([
        db.collection('users').doc(lookup.uid).set({
          last_login_at: now,
          lastLoginAt: now,
          updated_at: now,
          updatedAt: now,
        }, { merge: true }),
        db.collection(CREDENTIAL_COLLECTION).doc(lookup.uid).set({
          last_login_at: now,
          updated_at: now,
        }, { merge: true }),
      ]);

      const freshUserSnap = await db.collection('users').doc(lookup.uid).get();
      const customToken = await admin.auth().createCustomToken(lookup.uid, { edenMember: true });
      res.json({
        ok: true,
        customToken,
        profile: sanitizeProfile(lookup.uid, freshUserSnap.exists ? freshUserSnap.data() || {} : lookup.data, credential),
      });
    } catch (error) {
      logger.warn('Member login failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    }
  }

  async function getMyProfile(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const startedAt = Date.now();
    const timings = {};
    async function timedStep(name, action) {
      const stepStartedAt = Date.now();
      try {
        return await action();
      } finally {
        timings[name] = Date.now() - stepStartedAt;
      }
    }

    try {
      const decoded = await timedStep('verifyIdToken', () => requireSignedInUser(req));
      let member = await timedStep('loadMemberByUid', () => loadMemberByUid(decoded.uid));
      let customToken = '';

      const canonicalLookup = () => findCanonicalMemberForGoogle(decoded).catch(error => {
        if (error.publicMessage) throw error;
        logger.warn('Google canonical member lookup failed', {
          uidHash: sha256(decoded.uid).slice(0, 16),
          message: error.message,
        });
        return null;
      });
      const [initialCredential, canonicalMember] = await Promise.all([
        member ? timedStep('getCredential', () => getCredential(member.uid)) : Promise.resolve({}),
        timedStep('findCanonicalMemberForGoogle', canonicalLookup),
      ]);
      let credential = initialCredential || {};

      if (canonicalMember && canonicalMember.uid !== decoded.uid) {
        member = canonicalMember;
        credential = await timedStep('getCanonicalCredential', () => getCredential(member.uid));
        customToken = await timedStep('createCustomToken', () => admin.auth().createCustomToken(member.uid, {
          edenMember: true,
          googleAuthUid: decoded.uid,
        }));
      }

      if (!member) throw createPublicError('ไม่พบข้อมูลสมาชิก', 404);
      const totalMs = Date.now() - startedAt;
      res.set('X-Eden-Profile-Time-Ms', String(totalMs));
      if (totalMs >= 1000) {
        logger.info('Member profile fetch timing', {
          uidHash: sha256(member.uid || decoded.uid).slice(0, 16),
          totalMs,
          timings,
          canonical: Boolean(canonicalMember),
        });
      }
      res.json({
        ok: true,
        customToken,
        profile: sanitizeProfile(member.uid, member.data || {}, credential),
      });
    } catch (error) {
      logger.warn('Member profile fetch failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถโหลดข้อมูลโปรไฟล์ได้');
    }
  }

  return {
    checkRegisterPhone,
    requestRegisterOtp,
    verifyRegisterOtp,
    completeRegister,
    requestPasswordResetOtp,
    completePasswordReset,
    loginMember,
    getMyProfile,
    updateMyProfile,
    checkPhoneChange,
    requestPhoneChangeOtp,
    verifyPhoneChangeOtp,
  };
}

module.exports = {
  createMemberAuthHandlers,
};
