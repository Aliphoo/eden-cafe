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

function sanitizeProfile(uid, data = {}) {
  const phoneNumber = cleanString(data.phone_number || data.phoneE164 || data.phone || '', 40);
  const phoneDisplay = cleanString(data.phone_display || data.phone || displayThaiPhone(phoneNumber), 40);
  const displayName = cleanString(data.display_name || data.displayName || data.name || '', 120);
  const avatarUrl = cleanString(data.avatar_url || data.photoURL || '', 500);
  const memberLevel = cleanString(data.member_level || data.tier || 'Silver', 40) || 'Silver';
  return {
    id: cleanString(data.id || data.uid || uid, 160),
    uid: cleanString(data.uid || uid, 160),
    phone_number: phoneNumber,
    phone_display: phoneDisplay,
    email: cleanString(data.email || '', 180) || null,
    display_name: displayName || null,
    avatar_url: avatarUrl || null,
    member_level: ['Silver', 'Gold', 'Platinum'].includes(memberLevel) ? memberLevel : 'Silver',
    points: Math.max(0, Math.floor(Number(data.points || 0))),
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
  requireSignedInUser,
}) {
  function jsonError(res, error, fallback = 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง') {
    const status = error.statusCode || 500;
    const message = error.publicMessage || (status >= 500 ? fallback : error.message || fallback);
    res.status(status).json({ error: message });
  }

  async function sendOtpSms(phoneNumber, code) {
    const config = getSmsConfig();
    const url = cleanString(config.url, 500);
    if (!url) {
      throw createPublicError('ยังไม่ได้ตั้งค่าผู้ให้บริการส่ง OTP', 503);
    }

    const sender = cleanString(config.sender || 'Eden Cafe', 80);
    const message = `รหัส OTP สำหรับสมัครสมาชิก Eden Cafe คือ ${code} รหัสนี้หมดอายุใน 5 นาที`;
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

  async function findUserByPhone(phoneNumber) {
    const indexSnap = await db.collection(PHONE_INDEX_COLLECTION).doc(phoneIndexKey(phoneNumber)).get();
    if (indexSnap.exists && indexSnap.data()?.uid) {
      const userSnap = await db.collection('users').doc(indexSnap.data().uid).get();
      if (userSnap.exists) return { uid: userSnap.id, data: userSnap.data() || {} };
    }

    const phoneDisplay = displayThaiPhone(phoneNumber);
    const queries = await Promise.all([
      db.collection('users').where('phone_number', '==', phoneNumber).limit(1).get(),
      db.collection('users').where('phoneE164', '==', phoneNumber).limit(1).get(),
      db.collection('users').where('phone', '==', phoneDisplay).limit(1).get(),
    ]);
    for (const snap of queries) {
      if (!snap.empty) {
        const doc = snap.docs[0];
        return { uid: doc.id, data: doc.data() || {} };
      }
    }
    return null;
  }

  async function findUserByEmail(email) {
    const lowerEmail = normalizeEmail(email);
    const queries = await Promise.all([
      db.collection('users').where('email_lower', '==', lowerEmail).limit(1).get(),
      db.collection('users').where('email', '==', lowerEmail).limit(1).get(),
    ]);
    for (const snap of queries) {
      if (!snap.empty) {
        const doc = snap.docs[0];
        return { uid: doc.id, data: doc.data() || {} };
      }
    }
    return null;
  }

  async function ensurePhoneIsAvailable(phoneNumber) {
    const existing = await findUserByPhone(phoneNumber);
    if (existing) throw createPublicError('เบอร์โทรศัพท์นี้สมัครสมาชิกแล้ว กรุณาเข้าสู่ระบบ', 409);

    try {
      await admin.auth().getUserByPhoneNumber(phoneNumber);
      throw createPublicError('เบอร์โทรศัพท์นี้สมัครสมาชิกแล้ว กรุณาเข้าสู่ระบบ', 409);
    } catch (error) {
      if (error.publicMessage) throw error;
      if (error.code !== 'auth/user-not-found') throw error;
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

  async function completeRegister(req, res) {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'completeRegister', 12, 15 * 60 * 1000);
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
          throw createPublicError('เบอร์โทรศัพท์นี้สมัครสมาชิกแล้ว กรุณาเข้าสู่ระบบ', 409);
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
          display_name: '',
          displayName: 'สมาชิก Eden',
          avatar_url: '',
          photoURL: '',
          member_level: 'Silver',
          tier: 'Silver',
          points: 0,
          memberCode: authMemberCode(uid),
          status: 'active',
          passwordLoginEnabled: true,
          profileCompleted: true,
          authProviderIds: ['custom_password'],
          registrationSource: 'phone_password_otp',
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
      let rateKey;
      if (identifier.includes('@')) {
        const email = normalizeEmail(identifier);
        rateKey = `loginEmail:${sha256(email).slice(0, 48)}`;
        checkRateLimitKey(rateKey, 10, 15 * 60 * 1000);
        lookup = await findUserByEmail(email);
      } else {
        const phoneNumber = normalizeThaiPhone(identifier);
        rateKey = `loginPhone:${phoneIndexKey(phoneNumber)}`;
        checkRateLimitKey(rateKey, 10, 15 * 60 * 1000);
        lookup = await findUserByPhone(phoneNumber);
      }

      if (!lookup) throw createPublicError('เบอร์/อีเมล หรือรหัสผ่านไม่ถูกต้อง', 401);
      const credentialSnap = await db.collection(CREDENTIAL_COLLECTION).doc(lookup.uid).get();
      const credential = credentialSnap.exists ? credentialSnap.data() || {} : {};
      if (!credential.password_hash) throw createPublicError('เบอร์/อีเมล หรือรหัสผ่านไม่ถูกต้อง', 401);

      const passwordOk = await verifyPassword(password, credential.password_hash, getPasswordPepper());
      if (!passwordOk) throw createPublicError('เบอร์/อีเมล หรือรหัสผ่านไม่ถูกต้อง', 401);

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
        profile: sanitizeProfile(lookup.uid, freshUserSnap.exists ? freshUserSnap.data() || {} : lookup.data),
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

    try {
      const decoded = await requireSignedInUser(req);
      const snap = await db.collection('users').doc(decoded.uid).get();
      if (!snap.exists) throw createPublicError('ไม่พบข้อมูลสมาชิก', 404);
      res.json({ ok: true, profile: sanitizeProfile(decoded.uid, snap.data() || {}) });
    } catch (error) {
      logger.warn('Member profile fetch failed', {
        message: error.message,
        status: error.statusCode || 500,
      });
      jsonError(res, error, 'ไม่สามารถโหลดข้อมูลโปรไฟล์ได้');
    }
  }

  return {
    requestRegisterOtp,
    verifyRegisterOtp,
    completeRegister,
    loginMember,
    getMyProfile,
  };
}

module.exports = {
  createMemberAuthHandlers,
};
