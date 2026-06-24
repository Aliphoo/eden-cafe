const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const ftp = require('basic-ftp');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { createMemberAuthHandlers } = require('./services/memberAuth');

admin.initializeApp();

const db = admin.firestore();
const SPACESHIP_FTP_SERVER = defineSecret('SPACESHIP_FTP_SERVER');
const SPACESHIP_FTP_USERNAME = defineSecret('SPACESHIP_FTP_USERNAME');
const SPACESHIP_FTP_PASSWORD = defineSecret('SPACESHIP_FTP_PASSWORD');
const GOOGLE_MAPS_SERVER_KEY = defineSecret('GOOGLE_MAPS_SERVER_KEY');
const AUTH_OTP_PEPPER = defineSecret('AUTH_OTP_PEPPER');
const AUTH_PASSWORD_PEPPER = defineSecret('AUTH_PASSWORD_PEPPER');
const OTP_SMS_API_URL = defineSecret('OTP_SMS_API_URL');
const OTP_SMS_API_KEY = defineSecret('OTP_SMS_API_KEY');
const OTP_SMS_SENDER = defineSecret('OTP_SMS_SENDER');
const SMTP_HOST = defineSecret('SMTP_HOST');
const SMTP_PORT = defineSecret('SMTP_PORT');
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const SMTP_FROM = defineSecret('SMTP_FROM');

const PLACE_ID = 'ChIJVTN6cGwB1zAR66OQ_OBKRkM';
const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const PHONE_AUTH_EMAIL_DOMAIN = 'phone.edencafe.co';
const REVIEW_LIMIT = 5;
const ADMIN_EMAILS = new Set([
  'admin@edencafe.com',
  'phoo1236@gmail.com',
  'sonsawan.1231@gmail.com',
]);
const ADMIN_PERMISSION_FALLBACKS = {
  archery: ['bookings'],
};
const ADMIN_ARCHERY_BRANCH_DEFAULT = 'BKK_MAIN';
const ADMIN_ARCHERY_ROLE_VALUES = new Set(['OWNER', 'MANAGER', 'ARCHERY_STAFF', 'CASHIER']);
const IMAGE_REMOTE_ROOT = 'Images/uploads';
const IMAGE_PUBLIC_BASE_URL = 'https://www.edencafe.co/Images/uploads';
const SPACESHIP_FTP_FALLBACK_HOSTS = [
  'ftp.edencafe.co',
  'edencafe.co',
  '209.74.68.30',
];

const ALLOWED_ORIGINS = new Set([
  'https://edencafe-d9095.web.app',
  'https://edencafe-d9095.firebaseapp.com',
  'https://edencafe.co',
  'https://www.edencafe.co',
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'http://127.0.0.1',
  'http://localhost:5000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:4175',
  'http://localhost:4183',
  'http://localhost:8080',
  'http://localhost:8787',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
  'http://127.0.0.1:5176',
  'http://127.0.0.1:4175',
  'http://127.0.0.1:4183',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8787',
]);

function setCors(req, res) {
  const origin = req.get('origin') || '';
  if (ALLOWED_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Request-Id,X-Eden-System-Key');
  res.set('Access-Control-Max-Age', '3600');
}

function handleOptions(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

const RATE_LIMIT_BUCKETS = new Map();

function clientIp(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || String(req.ip || req.get('x-real-ip') || 'unknown');
}

function checkRateLimit(req, bucketName, maxRequests, windowMs) {
  const now = Date.now();
  const key = `${bucketName}:${clientIp(req)}`;
  checkRateLimitKey(key, maxRequests, windowMs, now);
}

function checkRateLimitKey(key, maxRequests, windowMs, now = Date.now()) {
  const bucket = RATE_LIMIT_BUCKETS.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    RATE_LIMIT_BUCKETS.set(key, { count: 1, expiresAt: now + windowMs });
    return;
  }
  if (bucket.count >= maxRequests) {
    const error = new Error('Too many requests');
    error.statusCode = 429;
    error.publicMessage = 'ขอ OTP บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
    throw error;
  }
  bucket.count += 1;
}

function publicApiError(error, fallback = 'Unable to process request') {
  const status = error.statusCode || 500;
  if (status === 401) return { status, message: 'Please sign in and try again.' };
  if (status === 403) return { status, message: 'You do not have permission to perform this action.' };
  if (status === 409) return { status, message: 'The selected resource is no longer available.' };
  if (status === 429) return { status, message: error.publicMessage || 'ขอ OTP บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง' };
  if (status >= 500) return { status, message: fallback };
  return { status, message: fallback };
}

const VISITOR_COUNTER_DOC = db.collection('stats').doc('pageViews');
const VISITOR_COUNTER_SESSION_COLLECTION = 'visitor_counter_sessions';
const VISITOR_COUNTER_IP_BUCKET_COLLECTION = 'visitor_counter_ip_buckets';
const VISITOR_COUNTER_IP_DAILY_LIMIT = 80;
const VISITOR_COUNTER_LOADING_MESSAGE = '\u0e01\u0e33\u0e25\u0e31\u0e07\u0e2d\u0e31\u0e1b\u0e40\u0e14\u0e15\u0e2a\u0e16\u0e34\u0e15\u0e34';

function bangkokDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeCounterStats(data = {}, today = bangkokDateKey()) {
  const totalViews = Math.max(0, Math.floor(Number(data.totalViews) || 0));
  const lastUpdateDate = typeof data.lastUpdateDate === 'string' ? data.lastUpdateDate : today;
  const dailyViews = lastUpdateDate === today
    ? Math.max(0, Math.floor(Number(data.dailyViews) || 0))
    : 0;
  return { totalViews, dailyViews, lastUpdateDate: lastUpdateDate === today ? today : lastUpdateDate };
}

function counterPayload(stats, counted = false) {
  return {
    ok: true,
    counted,
    dailyViews: stats.dailyViews,
    totalViews: stats.totalViews,
    lastUpdateDate: stats.lastUpdateDate,
    timezone: 'Asia/Bangkok',
    fallbackText: VISITOR_COUNTER_LOADING_MESSAGE,
  };
}

exports.trackVisitorCounter = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('X-Content-Type-Options', 'nosniff');

    if (!['GET', 'POST'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'visitor-counter', 120, 15 * 60 * 1000);

      const today = bangkokDateKey();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const wantsCount = req.method === 'POST' && body.count !== false;
      let result = null;

      await db.runTransaction(async transaction => {
        const statsSnap = await transaction.get(VISITOR_COUNTER_DOC);
        const currentStats = statsSnap.exists
          ? normalizeCounterStats(statsSnap.data(), today)
          : { totalViews: 0, dailyViews: 0, lastUpdateDate: today };

        if (!wantsCount) {
          result = counterPayload(currentStats, false);
          return;
        }

        const ip = clientIp(req);
        const userAgent = cleanString(req.get('user-agent') || 'unknown', 300);
        const visitorId = cleanString(body.visitorId || '', 160);
        const ipHash = sha256(ip).slice(0, 32);
        const visitorHash = sha256(`${today}:${visitorId || 'anonymous'}:${ipHash}:${userAgent}`).slice(0, 48);
        const sessionRef = db.collection(VISITOR_COUNTER_SESSION_COLLECTION).doc(`${today}_${visitorHash}`);
        const ipBucketRef = db.collection(VISITOR_COUNTER_IP_BUCKET_COLLECTION).doc(`${today}_${ipHash}`);
        const [sessionSnap, ipBucketSnap] = await Promise.all([
          transaction.get(sessionRef),
          transaction.get(ipBucketRef),
        ]);

        if (sessionSnap.exists) {
          result = counterPayload(currentStats, false);
          return;
        }

        const ipBucketCount = ipBucketSnap.exists ? Math.max(0, Number(ipBucketSnap.data().count) || 0) : 0;
        if (ipBucketCount >= VISITOR_COUNTER_IP_DAILY_LIMIT) {
          logger.warn('Visitor counter IP bucket limit reached', { ipHash, today });
          result = counterPayload(currentStats, false);
          return;
        }

        const nextStats = {
          totalViews: currentStats.totalViews + 1,
          dailyViews: currentStats.lastUpdateDate === today ? currentStats.dailyViews + 1 : 1,
          lastUpdateDate: today,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        transaction.set(VISITOR_COUNTER_DOC, nextStats, { merge: true });
        transaction.set(sessionRef, {
          date: today,
          visitorHash,
          ipHash,
          userAgentHash: sha256(userAgent).slice(0, 32),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        transaction.set(ipBucketRef, {
          date: today,
          ipHash,
          count: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        result = counterPayload(nextStats, true);
      });

      res.status(200).json(result || counterPayload({ totalViews: 0, dailyViews: 0, lastUpdateDate: today }, false));
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Visitor counter failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, VISITOR_COUNTER_LOADING_MESSAGE);
      res.status(status).json({ error: publicError.message, fallbackText: VISITOR_COUNTER_LOADING_MESSAGE });
    }
  }
);

exports.downloadPosApk = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 120, memory: '512MiB' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const decoded = await requireAdminAccess(req, 'pos');
      const fileName = 'EdenCafePOS-release.apk';
      const filePath = path.join(__dirname, 'assets', fileName);

      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'POS APK file is not available' });
        return;
      }

      const stat = fs.statSync(filePath);
      res.set('Cache-Control', 'no-store, max-age=0');
      res.set('Content-Type', 'application/vnd.android.package-archive');
      res.set('Content-Disposition', `attachment; filename="${fileName}"`);
      res.set('Content-Length', String(stat.size));
      res.set('X-Content-Type-Options', 'nosniff');

      logger.info('Protected POS APK download started', {
        uid: decoded.uid || '',
        email: decoded.email || '',
        bytes: stat.size,
      });

      fs.createReadStream(filePath)
        .on('error', error => {
          logger.error('Protected POS APK stream failed', { message: error.message });
          if (!res.headersSent) {
            res.status(500).json({ error: 'Unable to stream POS APK' });
            return;
          }
          res.end();
        })
        .pipe(res);
    } catch (error) {
      const isTokenError = /Firebase ID token|verify ID token|Decoding Firebase|jwt/i.test(error.message || '');
      const status = error.statusCode || (isTokenError ? 401 : 500);
      logger.warn('Protected POS APK download denied', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to download POS APK');
      res.status(status).json({ error: publicError.message });
    }
  }
);

async function requireAdminUid(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('Missing Authorization token');
    error.statusCode = 401;
    throw error;
  }

  const decoded = await admin.auth().verifyIdToken(match[1]);
  const email = String(decoded.email || '').trim().toLowerCase();
  if (!ADMIN_EMAILS.has(email)) {
    const error = new Error('Admin permission required');
    error.statusCode = 403;
    throw error;
  }
  return decoded.uid || '';
}

function hasOwnerClaim(decoded = {}) {
  return decoded.is_owner === true || String(decoded.role || '').toUpperCase() === 'OWNER';
}

async function hasOwnerUserProfile(uid = '') {
  if (!uid) return false;
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return false;
  const profile = snap.data() || {};
  return profile.is_owner === true || String(profile.role || '').toUpperCase() === 'OWNER';
}

async function requireAdminAccess(req, permission = '') {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('Missing Authorization token');
    error.statusCode = 401;
    throw error;
  }

  const decoded = await admin.auth().verifyIdToken(match[1]);
  const email = String(decoded.email || '').trim().toLowerCase();
  if (hasOwnerClaim(decoded)) return decoded;
  if (ADMIN_EMAILS.has(email)) return decoded;
  if (await hasOwnerUserProfile(decoded.uid)) return decoded;

  const accessSnap = await db.collection('admin_users').doc(decoded.uid).get();
  if (!accessSnap.exists) {
    const error = new Error('Admin permission required');
    error.statusCode = 403;
    throw error;
  }

  const access = accessSnap.data() || {};
  if (access.status !== 'active') {
    const error = new Error('Admin access is not active');
    error.statusCode = 403;
    throw error;
  }

  if (!['owner', 'head_manager', 'manager'].includes(access.role)) {
    const error = new Error('Admin permission required');
    error.statusCode = 403;
    throw error;
  }
  if (access.role === 'owner' || access.role === 'head_manager') return decoded;
  if (hasAdminAccessPermission(access, permission)) return decoded;

  const error = new Error('Admin permission required');
  error.statusCode = 403;
  throw error;
}

function hasAdminAccessPermission(access = {}, permission = '') {
  if (!permission) return true;
  if (access.permissions && access.permissions[permission] === true) return true;
  if (Object.prototype.hasOwnProperty.call(access.permissions || {}, permission)) return false;
  return (ADMIN_PERMISSION_FALLBACKS[permission] || []).some(fallback => access.permissions?.[fallback] === true);
}

async function requireOwnerAccess(req) {
  const decoded = await requireAdminAccess(req);
  if (hasOwnerClaim(decoded)) return decoded;
  const email = String(decoded.email || '').trim().toLowerCase();
  if (ADMIN_EMAILS.has(email)) return decoded;
  if (await hasOwnerUserProfile(decoded.uid)) return decoded;

  const accessSnap = await db.collection('admin_users').doc(decoded.uid).get();
  const access = accessSnap.exists ? accessSnap.data() || {} : {};
  if (access.status === 'active' && (access.role === 'owner' || access.permissions?.adminAccess === true)) return decoded;

  const error = new Error('Owner permission required');
  error.statusCode = 403;
  throw error;
}

async function requireSignedInUser(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('Missing Authorization token');
    error.statusCode = 401;
    throw error;
  }
  return admin.auth().verifyIdToken(match[1]);
}

const memberAuthHandlers = createMemberAuthHandlers({
  admin,
  db,
  logger,
  setCors,
  handleOptions,
  checkRateLimit,
  checkRateLimitKey,
  requireSignedInUser,
  getOtpPepper: () => AUTH_OTP_PEPPER.value() || process.env.AUTH_OTP_PEPPER || '',
  getPasswordPepper: () => AUTH_PASSWORD_PEPPER.value() || process.env.AUTH_PASSWORD_PEPPER || '',
  getSmsConfig: () => ({
    url: OTP_SMS_API_URL.value() || process.env.OTP_SMS_API_URL || '',
    apiKey: OTP_SMS_API_KEY.value() || process.env.OTP_SMS_API_KEY || '',
    sender: OTP_SMS_SENDER.value() || process.env.OTP_SMS_SENDER || 'Eden Cafe',
  }),
  sendOtpEmail: async (email, code) => {
    const from = safeSecretValue(SMTP_FROM, 180) || safeSecretValue(SMTP_USER, 180);
    await createMailTransporter().sendMail({
      from,
      to: email,
      subject: 'Eden Cafe password reset OTP',
      text: `รหัส OTP สำหรับรีเซ็ตรหัสผ่านสมาชิก Eden Cafe คือ ${code} รหัสนี้หมดอายุใน 5 นาที`,
      html: [
        '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#123526;">',
        '<h2 style="margin:0 0 12px;">Eden Cafe password reset</h2>',
        '<p>ใช้รหัส OTP นี้เพื่อรีเซ็ตรหัสผ่านสมาชิก Eden Cafe</p>',
        `<div style="font-size:32px;font-weight:700;letter-spacing:0.18em;background:#f2fbf3;border-radius:14px;padding:18px 22px;display:inline-block;">${code}</div>`,
        '<p>รหัสนี้หมดอายุใน 5 นาที หากคุณไม่ได้ขอรีเซ็ตรหัสผ่าน สามารถละเว้นอีเมลนี้ได้</p>',
        '</div>',
      ].join(''),
    });
  },
});

exports.checkRegisterPhone = onRequest(
  { region: 'asia-southeast1' },
  memberAuthHandlers.checkRegisterPhone
);

exports.requestRegisterOtp = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_OTP_PEPPER, OTP_SMS_API_URL, OTP_SMS_API_KEY, OTP_SMS_SENDER],
  },
  memberAuthHandlers.requestRegisterOtp
);

exports.verifyRegisterOtp = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_OTP_PEPPER],
  },
  memberAuthHandlers.verifyRegisterOtp
);

exports.completeRegister = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_OTP_PEPPER, AUTH_PASSWORD_PEPPER],
  },
  memberAuthHandlers.completeRegister
);

exports.requestPasswordResetOtp = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [
      AUTH_OTP_PEPPER,
      OTP_SMS_API_URL,
      OTP_SMS_API_KEY,
      OTP_SMS_SENDER,
      SMTP_HOST,
      SMTP_PORT,
      SMTP_USER,
      SMTP_PASS,
      SMTP_FROM,
    ],
  },
  memberAuthHandlers.requestPasswordResetOtp
);

exports.completePasswordReset = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_OTP_PEPPER, AUTH_PASSWORD_PEPPER],
  },
  memberAuthHandlers.completePasswordReset
);

exports.loginMember = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_PASSWORD_PEPPER],
  },
  memberAuthHandlers.loginMember
);

exports.getMyProfile = onRequest(
  { region: 'asia-southeast1' },
  memberAuthHandlers.getMyProfile
);

exports.updateMyProfile = onRequest(
  { region: 'asia-southeast1' },
  memberAuthHandlers.updateMyProfile
);

function activityLimit(value, fallback = 30, max = 80) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, parsed));
}

function activityDateMillis(value, endOfDay = false) {
  const raw = cleanString(value || '', 40);
  if (!raw) return 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
    const millis = new Date(`${raw}T${time}+07:00`).getTime();
    return Number.isFinite(millis) ? millis : 0;
  }
  const millis = new Date(raw).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

function activityCursorMillis(value) {
  const raw = cleanString(value || '', 240);
  if (!raw) return 0;
  const direct = Number(raw);
  if (Number.isFinite(direct) && direct > 0) return direct;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const millis = Number(decoded?.before || decoded?.timestamp || 0);
    return Number.isFinite(millis) && millis > 0 ? millis : 0;
  } catch (_) {
    return 0;
  }
}

function activityCursorFromMillis(millis) {
  const value = Number(millis);
  if (!Number.isFinite(value) || value <= 0) return '';
  return Buffer.from(JSON.stringify({ before: value }), 'utf8').toString('base64url');
}

function activityValueToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object' && Number.isFinite(Number(value._seconds))) {
    return (Number(value._seconds) * 1000) + Math.floor(Number(value._nanoseconds || 0) / 1000000);
  }
  return 0;
}

function activityTimestampMillis(data = {}) {
  const direct = [
    data.paidAt,
    data.closedAt,
    data.completedAt,
    data.timestamp,
    data.createdAt,
    data.created_at,
    data.updatedAt,
    data.updated_at,
    data.date,
  ];
  for (const value of direct) {
    const millis = activityValueToMillis(value);
    if (millis) return millis;
  }
  const bookingDate = cleanString(data.booking_date || data.bookingDate || '', 20);
  if (bookingDate) {
    const start = cleanString(data.start_time || data.startTime || '00:00', 10) || '00:00';
    const parsed = new Date(`${bookingDate}T${start}:00+07:00`).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function activityIso(value) {
  const millis = activityValueToMillis(value);
  return millis ? new Date(millis).toISOString() : '';
}

function serializeActivityValue(value) {
  if (value == null) return value;
  if (typeof value.toDate === 'function' || typeof value.toMillis === 'function') return activityIso(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeActivityValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeActivityValue(item)])
    );
  }
  return value;
}

function activityAmount(data = {}) {
  return Number(
    data.payableTotal ??
    data.totalAmount ??
    data.total ??
    data.netTotal ??
    data.amount_total ??
    data.amountTotal ??
    data.amount ??
    data.price ??
    0
  ) || 0;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function activityStatus(data = {}) {
  return cleanString(
    data.paymentLabel ||
    data.payment_status ||
    data.paymentStatus ||
    data.booking_status ||
    data.bookingStatus ||
    data.status ||
    data.order_status ||
    data.billStatus ||
    '',
    80
  );
}

function receiptSourceTypeCollection(sourceType = '') {
  const normalized = normalizeReceiptStatus(sourceType);
  if (['pos_order', 'web_order', 'order', 'orders', 'shop_order'].includes(normalized)) return 'orders';
  if (['booking', 'bookings', 'archery', 'archery_booking'].includes(normalized)) return 'bookings';
  return '';
}

function receiptOwnerMatches(data = {}, uid = '', collectionName = '') {
  const expectedUid = cleanString(uid, 180);
  if (!expectedUid) return false;
  if (collectionName === 'orders') {
    const customerUid = cleanString(data.customerUid || '', 180);
    if (customerUid) return customerUid === expectedUid;
    if (activityOrderSource(data) === 'pos') return false;
    return [
      data.uid,
      data.userId,
      data.memberUid,
      data.member_id,
      data.memberId,
    ].some(value => cleanString(value || '', 180) === expectedUid);
  }
  if (collectionName === 'bookings') {
    return [
      data.uid,
      data.customerUid,
      data.member_id,
      data.memberId,
      data.memberUid,
      data.userId,
    ].some(value => cleanString(value || '', 180) === expectedUid);
  }
  return false;
}

function parseReceiptRequest(rawOptions = {}) {
  const actionId = cleanString(rawOptions.actionId || rawOptions.receiptActionId || '', 260);
  let sourceType = cleanString(rawOptions.sourceType || rawOptions.type || '', 80);
  let sourceId = cleanString(rawOptions.sourceId || rawOptions.id || rawOptions.firestoreId || '', 180);
  if ((!sourceType || !sourceId) && actionId.includes(':')) {
    const [parsedType, ...rest] = actionId.split(':');
    sourceType = sourceType || cleanString(parsedType || '', 80);
    sourceId = sourceId || cleanString(rest.join(':') || '', 180);
  }
  return {
    actionId,
    sourceType,
    sourceId,
    receiptNo: cleanString(rawOptions.receiptNo || '', 120),
    receiptId: cleanString(rawOptions.receiptId || '', 180),
  };
}

async function getOwnedReceiptSource(uid, rawOptions = {}) {
  const request = parseReceiptRequest(rawOptions);
  const collectionName = receiptSourceTypeCollection(request.sourceType);
  if (!collectionName || !request.sourceId) {
    const error = new Error('Missing receipt source');
    error.statusCode = 400;
    throw error;
  }
  const collectionRef = db.collection(collectionName);
  const candidateIds = Array.from(new Set([request.sourceId, request.receiptId].filter(Boolean)));
  for (const id of candidateIds) {
    try {
      const snap = await collectionRef.doc(id).get();
      if (snap.exists) {
        const data = { firestoreId: snap.id, ...serializeActivityValue(snap.data() || {}) };
        if (receiptOwnerMatches(data, uid, collectionName)) return { data, collectionName, request };
      }
    } catch (error) {
      logger.warn('Receipt direct lookup failed', {
        collectionName,
        code: error.code || '',
        message: error.message,
      });
    }
  }

  const lookupValue = request.sourceId || request.receiptNo || request.receiptId;
  const fields = collectionName === 'orders'
    ? ['receiptNo', 'orderNumber', 'id', 'payment_id', 'paymentId', 'source_id']
    : ['booking_id', 'bookingId', 'id', 'payment_id', 'paymentId', 'source_id'];
  for (const field of fields) {
    try {
      const snap = await collectionRef.where(field, '==', lookupValue).limit(5).get();
      for (const docSnap of snap.docs) {
        const data = { firestoreId: docSnap.id, ...serializeActivityValue(docSnap.data() || {}) };
        if (receiptOwnerMatches(data, uid, collectionName)) return { data, collectionName, request };
      }
    } catch (error) {
      logger.warn('Receipt field lookup failed', {
        collectionName,
        field,
        code: error.code || '',
        message: error.message,
      });
    }
  }

  const error = new Error('Receipt not found');
  error.statusCode = 404;
  throw error;
}

function receiptItemName(item = {}) {
  return cleanString(
    item.name ||
    item.productName ||
    item.title ||
    item.label ||
    item.menuName ||
    'Eden Cafe item',
    160
  );
}

function sanitizeReceiptItems(data = {}, fallbackName = 'Eden Cafe order') {
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems.slice(0, 80).map(item => {
    const quantity = Math.max(0, firstNumber(item.quantity, item.qty, item.count, 1) || 1);
    const unitPrice = firstNumber(item.unitPrice, item.price, item.amount, item.total, 0);
    const lineTotal = firstNumber(item.lineTotal, item.total, item.subtotal, item.amountTotal, unitPrice * quantity);
    return {
      name: receiptItemName(item),
      variantName: cleanString(item.variantName || item.variant || item.optionName || '', 120),
      quantity,
      unitPrice,
      lineTotal,
    };
  }).filter(item => item.name);
  if (items.length) return items;
  return [{
    name: cleanString(fallbackName || 'Eden Cafe order', 160),
    variantName: '',
    quantity: 1,
    unitPrice: activityAmount(data),
    lineTotal: activityAmount(data),
  }];
}

function receiptFallbackItemName(data = {}, collectionName = '') {
  if (collectionName === 'bookings') {
    if (isActivityArcheryBooking(data)) return 'Eden Archery booking';
    return 'Eden Cafe booking';
  }
  return activityItemsText(data.items) || 'Eden Cafe order';
}

function buildCustomerReceiptPayload(uid, sourceData = {}, collectionName = '', request = {}) {
  const source = collectionName === 'orders'
    ? activityOrderSource(sourceData)
    : (isActivityArcheryBooking(sourceData) ? 'archery' : 'booking');
  const sourceType = collectionName === 'orders'
    ? (source === 'pos' ? 'pos_order' : 'web_order')
    : (source === 'archery' ? 'archery_booking' : 'booking');
  const displayId = cleanString(
    sourceData.receiptNo ||
    sourceData.receipt_no ||
    sourceData.orderNumber ||
    sourceData.booking_id ||
    sourceData.bookingId ||
    sourceData.id ||
    sourceData.firestoreId ||
    request.sourceId ||
    '-',
    120
  );
  const eligibility = activityReceiptMetadata(sourceData, {
    category: collectionName === 'orders' ? (source === 'pos' ? 'pos' : 'orders') : (source === 'archery' ? 'archery' : 'bookings'),
    type: sourceType,
    source,
    sourceType,
    sourceId: sourceData.firestoreId || sourceData.id || displayId,
    displayId,
  });
  if (!eligibility.available) {
    const error = new Error('Receipt is not available for this activity');
    error.statusCode = 409;
    throw error;
  }

  const items = sanitizeReceiptItems(sourceData, receiptFallbackItemName(sourceData, collectionName));
  const itemsTotal = items.reduce((sum, item) => sum + (Number(item.lineTotal) || 0), 0);
  const subtotal = firstNumber(sourceData.subtotal, sourceData.subTotal, sourceData.itemsSubtotal, sourceData.grossTotal, itemsTotal);
  const discount = firstNumber(sourceData.discount, sourceData.discountAmount, sourceData.totalDiscount, 0);
  const taxIncluded = firstNumber(sourceData.taxIncluded, sourceData.vatIncluded, sourceData.taxAmount, sourceData.vatAmount, 0);
  const totalAmount = activityAmount(sourceData) || Math.max(0, subtotal - discount);
  const paidAmount = firstNumber(sourceData.paidAmount, sourceData.amountPaid, sourceData.receivedAmount, totalAmount);
  const changeAmount = firstNumber(sourceData.changeAmount, sourceData.change, 0);
  const issuedAt = activityIso(
    sourceData.paidAt ||
    sourceData.closedAt ||
    sourceData.completedAt ||
    sourceData.timestamp ||
    sourceData.createdAt ||
    sourceData.created_at ||
    sourceData.date
  );
  const receiptNo = cleanString(
    eligibility.receipt?.receiptNo ||
    sourceData.receiptNo ||
    sourceData.receipt_no ||
    sourceData.orderNumber ||
    sourceData.booking_id ||
    displayId,
    120
  );

  return {
    ok: true,
    uid,
    receipt: {
      receiptNo,
      receiptId: cleanString(eligibility.receipt?.receiptId || sourceData.receiptId || sourceData.receipt_id || '', 180),
      source,
      sourceType,
      sourceId: cleanString(sourceData.firestoreId || sourceData.id || request.sourceId || '', 180),
      status: activityStatus(sourceData),
      issuedAt,
      customerName: cleanString(sourceData.customerName || sourceData.name || sourceData.displayName || '', 160),
      cashierName: cleanString(sourceData.cashierName || sourceData.staffName || '', 120),
      paymentMethod: cleanString(sourceData.paymentMethod || sourceData.payment_method || '', 80),
      paymentLabel: cleanString(sourceData.paymentLabel || sourceData.payment_method_label || sourceData.paymentMethodLabel || '', 120),
      currency: cleanString(sourceData.currency || 'THB', 12) || 'THB',
      subtotal,
      discount,
      taxIncluded,
      totalAmount,
      paidAmount,
      changeAmount,
      items,
    },
  };
}

const RECEIPT_PAID_STATUSES = new Set([
  'paid',
  'paid_online',
  'paid_counter',
  'completed',
  'complete',
  'success',
  'succeeded',
  'settled',
  'captured',
  'ชำระเงินแล้ว',
  'จ่ายแล้ว',
]);

const RECEIPT_BLOCKED_STATUSES = new Set([
  'pending',
  'unpaid',
  'pending_payment',
  'paid_pending_review',
  'review_required',
  'cancelled',
  'canceled',
  'failed',
  'payment_failed',
  'expired',
  'void',
  'voided',
  'refunded',
  'รอชำระเงิน',
  'ยังไม่ชำระเงิน',
  'ยกเลิก',
  'ยกเลิกแล้ว',
  'ล้มเหลว',
  'ชำระไม่สำเร็จ',
]);

function normalizeReceiptStatus(value) {
  return cleanString(value || '', 80).toLowerCase().replace(/[\s-]+/g, '_');
}

function activityPaymentStatusCandidates(data = {}) {
  return [
    data.payment_status,
    data.paymentStatus,
    data.billStatus,
    data.paymentLabel,
  ].map(normalizeReceiptStatus).filter(Boolean);
}

function activityGeneralStatusCandidates(data = {}) {
  return [
    data.status,
    data.order_status,
    data.booking_status,
    data.bookingStatus,
  ].map(normalizeReceiptStatus).filter(Boolean);
}

function activityReceiptMetadata(data = {}, options = {}) {
  const paymentStatuses = activityPaymentStatusCandidates(data);
  const generalStatuses = activityGeneralStatusCandidates(data);
  const statuses = [...paymentStatuses, ...generalStatuses];
  const hasBlockedStatus = statuses.some(status => RECEIPT_BLOCKED_STATUSES.has(status));
  const hasPaidStatus = paymentStatuses.some(status => RECEIPT_PAID_STATUSES.has(status))
    || ((options.category === 'orders' || options.source === 'pos') && generalStatuses.some(status => RECEIPT_PAID_STATUSES.has(status)));
  const receiptNo = cleanString(data.receiptNo || data.posReceiptNo || data.receipt_no || '', 120);
  const receiptId = cleanString(data.receiptId || data.receipt_id || '', 180);
  const available = !hasBlockedStatus && (hasPaidStatus || !!receiptId || (!!receiptNo && options.source === 'pos'));
  if (!available) {
    return { available: false, receipt: null, actions: [] };
  }
  const sourceType = cleanString(options.sourceType || options.type || options.category || '', 80);
  const sourceId = cleanString(options.sourceId || data.firestoreId || data.id || options.displayId || '', 180);
  const actionId = cleanString(`${sourceType || 'activity'}:${sourceId || receiptId || receiptNo}`, 260);
  const receipt = {
    available: true,
    source: cleanString(options.source || data.source || '', 40),
    sourceType,
    sourceId,
    receiptNo,
    receiptId,
    orderId: cleanString(data.orderNumber || data.orderId || data.id || options.displayId || '', 180),
    bookingId: cleanString(data.booking_id || data.bookingId || data.id || options.displayId || '', 180),
    status: activityStatus(data),
    amount: activityAmount(data),
    actionId,
  };
  return {
    available: true,
    receipt,
    actions: [{
      type: 'download_receipt',
      enabled: true,
      actionId,
      source: receipt.source,
      sourceType: receipt.sourceType,
      sourceId: receipt.sourceId,
      receiptNo: receipt.receiptNo,
      receiptId: receipt.receiptId,
    }],
  };
}

function isActivityArcheryBooking(data = {}) {
  const serviceType = cleanString(data.service_type || data.serviceType || '', 40).toUpperCase();
  const bookingType = cleanString(data.bookingType || data.booking_type || data.type || '', 80).toLowerCase();
  return serviceType === 'ARCHERY'
    || bookingType.includes('archery')
    || Array.isArray(data.assigned_lane_numbers)
    || Array.isArray(data.assigned_resource_ids)
    || data.required_lane_count != null
    || data.requiredLaneCount != null;
}

function activityOrderSource(data = {}) {
  const source = cleanString(data.source || data.orderSource || data.channel || '', 40).toLowerCase();
  if (source === 'pos' || source === 'web' || source === 'online') return source;
  if (data.receiptNo || data.posReceiptNo || data.posTerminalId) return 'pos';
  return 'web';
}

function activityItemsText(items = []) {
  if (!Array.isArray(items)) return '';
  return items
    .map(item => cleanString(item?.name || item?.productName || item?.title || '', 100))
    .filter(Boolean)
    .slice(0, 4)
    .join(', ');
}

function activityBookingDetail(data = {}) {
  const laneNumbers = Array.isArray(data.assigned_lane_numbers)
    ? data.assigned_lane_numbers.map(number => `Lane ${number}`).join(', ')
    : '';
  const laneIds = !laneNumbers && Array.isArray(data.assigned_resource_ids)
    ? data.assigned_resource_ids.map(item => cleanString(item, 80)).filter(Boolean).join(', ')
    : '';
  return [
    data.booking_date || data.bookingDate || data.date,
    [data.start_time || data.startTime, data.end_time || data.endTime].filter(Boolean).join('-'),
    laneNumbers || laneIds,
    data.tableZone || data.tableNo || data.roomType || data.zone || data.table,
    data.party_size ? `${data.party_size} people` : '',
    data.guests ? `${data.guests} people` : '',
    data.duration_minutes ? `${data.duration_minutes} min` : '',
  ].map(item => cleanString(item || '', 120)).filter(Boolean).join(' | ');
}

function normalizeActivityTypes(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return raw.map(item => cleanString(item, 40).toLowerCase()).filter(Boolean);
}

function activityMatchesTypes(activity, types = []) {
  if (!types.length || types.includes('all')) return true;
  return types.some(type => {
    if (type === 'pos') return activity.source === 'pos' || activity.category === 'pos';
    if (type === 'orders') return activity.category === 'orders';
    if (type === 'bookings') return activity.category === 'bookings';
    if (type === 'archery') return activity.category === 'archery';
    if (type === 'points') return activity.category === 'points';
    return activity.category === type || activity.source === type || activity.type === type;
  });
}

async function queryActivityCollection(options = {}) {
  const {
    collectionName,
    uid,
    fields = [],
    orderFields = [],
    limitCount = 30,
  } = options;
  const docs = new Map();
  const collectionRef = db.collection(collectionName);
  const queryLimit = Math.min(500, Math.max(limitCount * 8, 80));
  for (const field of Array.from(new Set(fields.filter(Boolean)))) {
    let loadedOrdered = false;
    for (const orderField of Array.from(new Set(orderFields.filter(Boolean)))) {
      try {
        const snap = await collectionRef
          .where(field, '==', uid)
          .orderBy(orderField, 'desc')
          .limit(queryLimit)
          .get();
        snap.forEach(docSnap => docs.set(docSnap.id, {
          firestoreId: docSnap.id,
          ...serializeActivityValue(docSnap.data() || {}),
        }));
        loadedOrdered = true;
        break;
      } catch (error) {
        logger.warn('Activity ordered query fallback', {
          collectionName,
          field,
          orderField,
          code: error.code || '',
          message: error.message,
        });
      }
    }
    if (loadedOrdered) continue;
    try {
      const snap = await collectionRef
        .where(field, '==', uid)
        .limit(queryLimit)
        .get();
      snap.forEach(docSnap => docs.set(docSnap.id, {
        firestoreId: docSnap.id,
        ...serializeActivityValue(docSnap.data() || {}),
      }));
    } catch (error) {
      logger.warn('Activity query failed', {
        collectionName,
        field,
        code: error.code || '',
        message: error.message,
      });
    }
  }
  return Array.from(docs.values());
}

function orderActivity(order = {}, uid = '') {
  const customerUid = cleanString(order.customerUid || '', 180);
  const legacyUid = cleanString(order.uid || order.userId || order.memberUid || '', 180);
  const source = activityOrderSource(order);
  if (order.isTestOrder === true) return null;
  if (customerUid && customerUid !== uid) return null;
  if (!customerUid && legacyUid !== uid) return null;
  if (!customerUid && source === 'pos') return null;
  const displayId = cleanString(order.receiptNo || order.orderNumber || order.id || order.firestoreId || '-', 120);
  const amount = activityAmount(order);
  const occurredMs = activityTimestampMillis(order);
  const category = source === 'pos' ? 'pos' : 'orders';
  const type = source === 'pos' ? 'pos_order' : 'web_order';
  const receipt = activityReceiptMetadata(order, {
    category,
    type,
    source,
    sourceType: type,
    sourceId: order.firestoreId || order.id || displayId,
    displayId,
  });
  return {
    id: `order:${order.firestoreId || displayId}`,
    category,
    type,
    source,
    title: source === 'pos' ? `POS receipt #${displayId}` : `Order #${displayId}`,
    status: activityStatus(order) || 'pending',
    detail: activityItemsText(order.items) || cleanString(order.note || order.description || '', 180) || '-',
    amount,
    occurredAt: occurredMs ? new Date(occurredMs).toISOString() : '',
    timestamp: occurredMs,
    refs: {
      orderId: displayId,
      firestoreId: cleanString(order.firestoreId || '', 180),
      receiptNo: cleanString(order.receiptNo || '', 120),
    },
    receiptAvailable: receipt.available,
    receipt: receipt.receipt,
    actions: receipt.actions,
  };
}

function bookingActivity(booking = {}) {
  const archery = isActivityArcheryBooking(booking);
  const displayId = cleanString(booking.booking_id || booking.id || booking.firestoreId || '-', 120);
  const occurredMs = activityTimestampMillis(booking);
  const category = archery ? 'archery' : 'bookings';
  const type = archery ? 'archery_booking' : 'booking';
  const source = archery ? 'archery' : 'booking';
  const receipt = activityReceiptMetadata(booking, {
    category,
    type,
    source,
    sourceType: type,
    sourceId: booking.firestoreId || booking.id || booking.booking_id || displayId,
    displayId,
  });
  return {
    id: `booking:${booking.firestoreId || displayId}`,
    category,
    type,
    source,
    title: archery ? `Eden Archery #${displayId}` : `Booking #${displayId}`,
    status: activityStatus(booking) || 'confirmed',
    detail: activityBookingDetail(booking) || '-',
    amount: activityAmount(booking),
    occurredAt: occurredMs ? new Date(occurredMs).toISOString() : '',
    timestamp: occurredMs,
    refs: {
      bookingId: displayId,
      firestoreId: cleanString(booking.firestoreId || '', 180),
    },
    receiptAvailable: receipt.available,
    receipt: receipt.receipt,
    actions: receipt.actions,
  };
}

function ledgerActivity(ledger = {}) {
  const pointsDelta = Math.trunc(Number(ledger.pointsDelta || ledger.delta || 0));
  const type = cleanString(ledger.type || '', 80).toLowerCase();
  const source = cleanString(ledger.source || (type.startsWith('pos_') ? 'pos' : 'loyalty'), 40).toLowerCase();
  const displayId = cleanString(ledger.receiptNo || ledger.orderId || ledger.firestoreId || '', 120);
  const occurredMs = activityTimestampMillis(ledger);
  const title = pointsDelta < 0
    ? `Redeemed ${Math.abs(pointsDelta)} points`
    : `Earned ${pointsDelta} points`;
  return {
    id: `ledger:${ledger.firestoreId || displayId || occurredMs}`,
    category: 'points',
    type: type || 'points',
    source,
    title,
    status: 'synced',
    detail: displayId ? `Reference #${displayId}` : cleanString(ledger.reason || ledger.note || '', 180) || '-',
    amount: Number(ledger.amount || 0) || 0,
    pointsDelta,
    pointsBefore: Number(ledger.pointsBefore || 0) || 0,
    pointsAfter: Number(ledger.pointsAfter || 0) || 0,
    occurredAt: occurredMs ? new Date(occurredMs).toISOString() : '',
    timestamp: occurredMs,
    refs: {
      ledgerId: cleanString(ledger.firestoreId || '', 180),
      orderId: cleanString(ledger.orderId || '', 180),
      receiptNo: cleanString(ledger.receiptNo || '', 120),
    },
  };
}

function activityOrderSummary(order = {}) {
  const amount = activityAmount(order);
  const occurredMs = activityTimestampMillis(order);
  const source = activityOrderSource(order);
  const displayId = cleanString(order.receiptNo || order.orderNumber || order.id || order.firestoreId || '-', 120);
  const type = source === 'pos' ? 'pos_order' : 'web_order';
  const receipt = activityReceiptMetadata(order, {
    category: source === 'pos' ? 'pos' : 'orders',
    type,
    source,
    sourceType: type,
    sourceId: order.firestoreId || order.id || displayId,
    displayId,
  });
  return {
    firestoreId: cleanString(order.firestoreId || '', 180),
    id: displayId,
    receiptNo: cleanString(order.receiptNo || '', 120),
    orderNumber: cleanString(order.orderNumber || '', 120),
    source,
    status: cleanString(order.status || order.order_status || order.billStatus || '', 80),
    paymentStatus: cleanString(order.paymentStatus || order.payment_status || '', 80),
    receiptAvailable: receipt.available,
    receipt: receipt.receipt,
    actions: receipt.actions,
    totalAmount: amount,
    total: amount,
    date: occurredMs ? new Date(occurredMs).toISOString() : '',
    timestamp: occurredMs ? new Date(occurredMs).toISOString() : '',
    items: Array.isArray(order.items)
      ? order.items.slice(0, 20).map(item => ({
        name: cleanString(item?.name || item?.productName || item?.title || '', 120),
        quantity: Number(item?.quantity || item?.qty || 0) || 0,
        price: Number(item?.price || item?.unitPrice || item?.total || 0) || 0,
      }))
      : [],
  };
}

function activityBookingSummary(booking = {}) {
  const occurredMs = activityTimestampMillis(booking);
  const archery = isActivityArcheryBooking(booking);
  const type = archery ? 'archery_booking' : 'booking';
  const source = archery ? 'archery' : 'booking';
  const displayId = cleanString(booking.booking_id || booking.id || booking.firestoreId || '-', 120);
  const receipt = activityReceiptMetadata(booking, {
    category: archery ? 'archery' : 'bookings',
    type,
    source,
    sourceType: type,
    sourceId: booking.firestoreId || booking.id || booking.booking_id || displayId,
    displayId,
  });
  return {
    firestoreId: cleanString(booking.firestoreId || '', 180),
    id: displayId,
    service_type: cleanString(booking.service_type || booking.serviceType || '', 40),
    bookingType: cleanString(booking.bookingType || booking.booking_type || '', 40),
    status: cleanString(booking.status || booking.booking_status || '', 80),
    paymentStatus: cleanString(booking.paymentStatus || booking.payment_status || '', 80),
    receiptAvailable: receipt.available,
    receipt: receipt.receipt,
    actions: receipt.actions,
    booking_date: cleanString(booking.booking_date || booking.bookingDate || booking.date || '', 20),
    start_time: cleanString(booking.start_time || booking.startTime || '', 10),
    end_time: cleanString(booking.end_time || booking.endTime || '', 10),
    total: activityAmount(booking),
    timestamp: occurredMs ? new Date(occurredMs).toISOString() : '',
    assigned_lane_numbers: Array.isArray(booking.assigned_lane_numbers) ? booking.assigned_lane_numbers.slice(0, 10) : [],
    required_lane_count: Number(booking.required_lane_count || booking.requiredLaneCount || 0) || 0,
    party_size: Number(booking.party_size || booking.partySize || booking.guests || 0) || 0,
    tableNo: cleanString(booking.tableNo || '', 80),
    tableZone: cleanString(booking.tableZone || '', 120),
    roomType: cleanString(booking.roomType || '', 120),
  };
}

async function getMyActivityPayload(uid, rawOptions = {}) {
  const limitCount = activityLimit(rawOptions.limit, 30, 80);
  const fromMs = activityDateMillis(rawOptions.from || rawOptions.dateFrom || rawOptions.startDate, false);
  const toMs = activityDateMillis(rawOptions.to || rawOptions.dateTo || rawOptions.endDate, true);
  const cursorMs = activityCursorMillis(rawOptions.cursor || rawOptions.before || '');
  const types = normalizeActivityTypes(rawOptions.types || rawOptions.type || rawOptions.category || '');
  const [orders, bookings, ledgers, loyaltySnap, summarySnap] = await Promise.all([
    queryActivityCollection({
      collectionName: 'orders',
      uid,
      fields: ['customerUid', 'uid', 'userId', 'memberUid'],
      orderFields: ['timestamp', 'createdAt', 'paidAt', 'closedAt'],
      limitCount,
    }),
    queryActivityCollection({
      collectionName: 'bookings',
      uid,
      fields: ['uid', 'customerUid', 'member_id', 'memberUid', 'userId'],
      orderFields: ['timestamp', 'createdAt', 'created_at', 'updatedAt', 'booking_date'],
      limitCount,
    }),
    queryActivityCollection({
      collectionName: 'point_ledger',
      uid,
      fields: ['userId'],
      orderFields: ['createdAt', 'created_at', 'timestamp'],
      limitCount,
    }),
    db.collection('site_settings').doc('loyalty').get().catch(() => null),
    db.collection('member_summaries').doc(uid).get().catch(() => null),
  ]);
  const activities = []
    .concat(orders.map(order => orderActivity(order, uid)))
    .concat(bookings.map(bookingActivity))
    .concat(ledgers.map(ledgerActivity))
    .filter(Boolean)
    .filter(activity => {
      const timestamp = Number(activity.timestamp || 0);
      if (!timestamp) return false;
      if (fromMs && timestamp < fromMs) return false;
      if (toMs && timestamp > toMs) return false;
      if (cursorMs && timestamp >= cursorMs) return false;
      return activityMatchesTypes(activity, types);
    })
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const pageItems = activities.slice(0, limitCount);
  const nextCursor = activities.length > limitCount
    ? activityCursorFromMillis(pageItems[pageItems.length - 1]?.timestamp)
    : '';
  return {
    ok: true,
    uid,
    limit: limitCount,
    cursor: rawOptions.cursor || '',
    nextCursor,
    generatedAt: new Date().toISOString(),
    activity: pageItems,
    orders: orders
      .map(order => orderActivity(order, uid) ? activityOrderSummary(order) : null)
      .filter(Boolean)
      .sort((a, b) => activityValueToMillis(b.timestamp) - activityValueToMillis(a.timestamp))
      .slice(0, 30),
    bookings: bookings
      .map(activityBookingSummary)
      .sort((a, b) => activityValueToMillis(b.timestamp) - activityValueToMillis(a.timestamp))
      .slice(0, 30),
    loyaltyLedger: ledgers
      .map(ledger => ({
        id: cleanString(ledger.firestoreId || '', 180),
        type: cleanString(ledger.type || '', 80),
        source: cleanString(ledger.source || '', 40),
        pointsDelta: Math.trunc(Number(ledger.pointsDelta || 0)),
        pointsBefore: Number(ledger.pointsBefore || 0) || 0,
        pointsAfter: Number(ledger.pointsAfter || 0) || 0,
        amount: Number(ledger.amount || 0) || 0,
        receiptNo: cleanString(ledger.receiptNo || '', 120),
        orderId: cleanString(ledger.orderId || '', 180),
        createdAt: activityIso(ledger.createdAt || ledger.created_at || ledger.timestamp),
      }))
      .sort((a, b) => activityValueToMillis(b.createdAt) - activityValueToMillis(a.createdAt))
      .slice(0, 30),
    loyaltyConfig: loyaltySnap?.exists ? serializeActivityValue(loyaltySnap.data() || {}) : null,
    loyaltySummary: summarySnap?.exists ? serializeActivityValue(summarySnap.data() || {}) : null,
  };
}

exports.getMyActivity = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('X-Content-Type-Options', 'nosniff');

    if (!['GET', 'POST'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const decoded = await requireSignedInUser(req);
      try {
        checkRateLimitKey(`get-my-activity:${decoded.uid}`, 240, 15 * 60 * 1000);
      } catch (rateLimitError) {
        rateLimitError.publicMessage = 'Too many activity requests. Please wait a moment and try again.';
        throw rateLimitError;
      }
      const rawOptions = req.method === 'GET' ? (req.query || {}) : (req.body || {});
      const payload = await getMyActivityPayload(decoded.uid, rawOptions);
      res.status(200).json(payload);
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Member activity fetch failed', {
        status,
        code: error.code || '',
        message: error.message,
      });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to load member activity right now.');
      res.status(status).json({ ok: false, error: publicError.message });
    }
  }
);

exports.getMyReceipt = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('X-Content-Type-Options', 'nosniff');

    if (!['GET', 'POST'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const decoded = await requireSignedInUser(req);
      try {
        checkRateLimitKey(`get-my-receipt:${decoded.uid}`, 120, 15 * 60 * 1000);
      } catch (rateLimitError) {
        rateLimitError.publicMessage = 'Too many receipt requests. Please wait a moment and try again.';
        throw rateLimitError;
      }
      const rawOptions = req.method === 'GET' ? (req.query || {}) : (req.body || {});
      const { data, collectionName, request } = await getOwnedReceiptSource(decoded.uid, rawOptions);
      const payload = buildCustomerReceiptPayload(decoded.uid, data, collectionName, request);
      res.status(200).json(payload);
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Member receipt fetch failed', {
        status,
        code: error.code || '',
        message: error.message,
      });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to load receipt right now.');
      res.status(status).json({ ok: false, error: publicError.message });
    }
  }
);

exports.checkPhoneChange = onRequest(
  { region: 'asia-southeast1' },
  memberAuthHandlers.checkPhoneChange
);

exports.requestPhoneChangeOtp = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_OTP_PEPPER, OTP_SMS_API_URL, OTP_SMS_API_KEY, OTP_SMS_SENDER],
  },
  memberAuthHandlers.requestPhoneChangeOtp
);

exports.verifyPhoneChangeOtp = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_OTP_PEPPER],
  },
  memberAuthHandlers.verifyPhoneChangeOtp
);

function normalizeAdminRole(role) {
  return ['owner', 'head_manager', 'manager'].includes(role) ? role : 'manager';
}

function normalizeAdminStatus(status) {
  return status === 'paused' ? 'paused' : 'active';
}

function normalizeAdminPermissions(role, raw = {}) {
  const allowed = [
    'dashboard',
    'members',
    'pos',
    'discounts',
    'loyalty',
    'orders',
    'bookings',
    'archery',
    'tables',
    'rooms',
    'products',
    'blogs',
    'faqs',
    'promptpay',
    'marketing',
    'index',
    'footer',
  ];
  const all = Object.fromEntries(allowed.map(key => [key, true]));
  if (role === 'owner' || role === 'head_manager') return all;
  return Object.fromEntries(allowed.map(key => [key, raw && raw[key] === true]));
}

function hasAdminArcheryPermission(role, permissions = {}) {
  return role === 'owner' || role === 'head_manager' || permissions?.archery === true;
}

function normalizeBranchIds(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const seen = new Set();
  const branchIds = [];
  rawValues.forEach(item => {
    const branchId = cleanString(item, 40);
    if (!branchId || seen.has(branchId)) return;
    seen.add(branchId);
    branchIds.push(branchId);
  });
  return branchIds.slice(0, 20);
}

function normalizeAdminArcheryRole(role, value) {
  if (role === 'owner') return 'OWNER';
  const archeryRole = cleanString(value || '', 40).toUpperCase();
  if (ADMIN_ARCHERY_ROLE_VALUES.has(archeryRole) && archeryRole !== 'OWNER') return archeryRole;
  return 'MANAGER';
}

function normalizeAdminArcheryAccess(role, permissions, body = {}, existing = {}) {
  if (!hasAdminArcheryPermission(role, permissions)) return {};

  const requestedPrimary = cleanString(
    body.primary_branch_id
      || body.primaryBranchId
      || body.branch_id
      || body.branchId
      || body.archeryBranchId
      || '',
    40
  );
  const existingPrimary = cleanString(existing.primary_branch_id || existing.branch_id || '', 40);
  const requestedBranchIds = normalizeBranchIds(
    body.branch_ids
      || body.branchIds
      || body.archery_branch_ids
      || body.archeryBranchIds
      || []
  );
  const existingBranchIds = normalizeBranchIds(existing.branch_ids || []);
  const primaryBranchId = requestedPrimary
    || requestedBranchIds[0]
    || existingPrimary
    || existingBranchIds[0]
    || ADMIN_ARCHERY_BRANCH_DEFAULT;
  const branchIds = normalizeBranchIds([primaryBranchId, ...requestedBranchIds, ...existingBranchIds]);
  return {
    primary_branch_id: primaryBranchId,
    branch_ids: branchIds.length ? branchIds : [ADMIN_ARCHERY_BRANCH_DEFAULT],
    archery_role: normalizeAdminArcheryRole(role, body.archery_role || body.archeryRole || existing.archery_role || existing.archeryRole),
  };
}

function hasPasswordProvider(userRecord) {
  return Array.isArray(userRecord?.providerData)
    && userRecord.providerData.some(provider => provider.providerId === 'password');
}

function authMemberCode(uid) {
  const source = String(uid || '000000').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase().padStart(6, '0');
  return 'ED-' + source;
}

function timestampFromAuthDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? admin.firestore.Timestamp.fromDate(date) : null;
}

function isInternalPhoneEmail(email) {
  return String(email || '').toLowerCase().endsWith('@' + PHONE_AUTH_EMAIL_DOMAIN);
}

function displayThaiPhone(phoneE164) {
  const phone = String(phoneE164 || '');
  return phone.startsWith('+66') ? '0' + phone.slice(3) : phone;
}

function normalizeThaiPhoneForMemberIndex(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\+66[689]\d{8}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (/^66[689]\d{8}$/.test(digits)) return '+' + digits;
  if (/^0[689]\d{8}$/.test(digits)) return '+66' + digits.slice(1);
  if (/^[689]\d{8}$/.test(digits)) return '+66' + digits;
  return '';
}

function memberPhoneIndexKey(phoneNumber) {
  return sha256(phoneNumber).slice(0, 48);
}

function memberEmailFromData(data = {}) {
  return normalizePublicEmail(data.email || data.email_lower || '');
}

function memberPhoneFromData(data = {}) {
  return normalizeThaiPhoneForMemberIndex(
    data.phone_number
    || data.phoneE164
    || data.phone
    || data.loginUsername
    || ''
  );
}

async function repairMemberAuthLink(uid, data = {}, stats = {}) {
  const safeUid = cleanString(uid, 160);
  if (!safeUid) return;

  const now = admin.firestore.FieldValue.serverTimestamp();
  const email = memberEmailFromData(data);
  const phoneNumber = memberPhoneFromData(data);
  const credentialPayload = {
    uid: safeUid,
    updated_at: now,
  };
  const userPayload = {
    uid: safeUid,
    updatedAt: now,
  };

  if (email) {
    credentialPayload.email_lower = email;
    userPayload.email = email;
    userPayload.email_lower = email;
  }

  if (phoneNumber) {
    const phoneKey = memberPhoneIndexKey(phoneNumber);
    credentialPayload.phone_number = phoneNumber;
    credentialPayload.phone_index_key = phoneKey;
    userPayload.phoneE164 = phoneNumber;
    userPayload.phone = displayThaiPhone(phoneNumber);
    userPayload.loginUsername = displayThaiPhone(phoneNumber);

    const phoneIndexRef = db.collection('phone_number_index').doc(phoneKey);
    const phoneIndexSnap = await phoneIndexRef.get();
    const existingUid = cleanString(phoneIndexSnap.data()?.uid || '', 160);
    if (existingUid && existingUid !== safeUid) {
      stats.phoneIndexConflicts = (stats.phoneIndexConflicts || 0) + 1;
      logger.warn('Skipped phone index repair due to UID conflict', {
        uid: safeUid,
        existingUid,
        phoneKey,
      });
    } else {
      await phoneIndexRef.set({
        uid: safeUid,
        phone_number: phoneNumber,
        updated_at: now,
      }, { merge: true });
      stats.phoneIndexesRepaired = (stats.phoneIndexesRepaired || 0) + 1;
    }
  }

  if (email || phoneNumber) {
    await Promise.all([
      db.collection('user_credentials').doc(safeUid).set(credentialPayload, { merge: true }),
      db.collection('users').doc(safeUid).set(userPayload, { merge: true }),
    ]);
    stats.credentialLinksRepaired = (stats.credentialLinksRepaired || 0) + 1;
  }

  const credentialSnap = await db.collection('user_credentials').doc(safeUid).get();
  if (!credentialSnap.exists || !credentialSnap.data()?.password_hash) {
    if (!stats.membersWithoutPasswordHashUids) stats.membersWithoutPasswordHashUids = new Set();
    stats.membersWithoutPasswordHashUids.add(safeUid);
    stats.membersWithoutPasswordHash = stats.membersWithoutPasswordHashUids.size;
  }
}

function uniqueCleanStrings(values = [], maxLength = 160) {
  return Array.from(new Set(
    values.map(value => cleanString(value, maxLength)).filter(Boolean)
  ));
}

function credentialHasPassword(credential = {}) {
  return !!cleanString(credential.password_hash || '', 2000);
}

async function getCredentialDoc(uid) {
  const safeUid = cleanString(uid, 160);
  if (!safeUid) return { exists: false, data: {} };
  const snap = await db.collection('user_credentials').doc(safeUid).get();
  return { exists: snap.exists, data: snap.exists ? snap.data() || {} : {} };
}

async function getUserDoc(uid) {
  const safeUid = cleanString(uid, 160);
  if (!safeUid) return { exists: false, data: {} };
  const snap = await db.collection('users').doc(safeUid).get();
  return { exists: snap.exists, data: snap.exists ? snap.data() || {} : {} };
}

async function findMemberUidsByEmail(email) {
  const normalizedEmail = normalizePublicEmail(email);
  if (!normalizedEmail) return [];

  const [usersByEmailLower, usersByEmail, credentialsByEmail] = await Promise.all([
    db.collection('users').where('email_lower', '==', normalizedEmail).limit(10).get(),
    db.collection('users').where('email', '==', normalizedEmail).limit(10).get(),
    db.collection('user_credentials').where('email_lower', '==', normalizedEmail).limit(10).get(),
  ]);

  return uniqueCleanStrings([
    ...usersByEmailLower.docs.map(doc => doc.id),
    ...usersByEmail.docs.map(doc => doc.id),
    ...credentialsByEmail.docs.map(doc => cleanString(doc.data()?.uid || doc.id, 160)),
  ]);
}

async function findMemberUidsByPhone(phoneNumber) {
  const normalizedPhone = normalizeThaiPhoneForMemberIndex(phoneNumber);
  if (!normalizedPhone) return [];

  const phoneKey = memberPhoneIndexKey(normalizedPhone);
  const phoneDisplay = displayThaiPhone(normalizedPhone);
  const [
    phoneIndexSnap,
    usersByPhoneNumber,
    usersByPhoneE164,
    usersByPhoneDisplay,
    credentialsByPhone,
  ] = await Promise.all([
    db.collection('phone_number_index').doc(phoneKey).get(),
    db.collection('users').where('phone_number', '==', normalizedPhone).limit(10).get(),
    db.collection('users').where('phoneE164', '==', normalizedPhone).limit(10).get(),
    db.collection('users').where('phone', '==', phoneDisplay).limit(10).get(),
    db.collection('user_credentials').where('phone_number', '==', normalizedPhone).limit(10).get(),
  ]);

  return uniqueCleanStrings([
    phoneIndexSnap.exists ? phoneIndexSnap.data()?.uid : '',
    ...usersByPhoneNumber.docs.map(doc => doc.id),
    ...usersByPhoneE164.docs.map(doc => doc.id),
    ...usersByPhoneDisplay.docs.map(doc => doc.id),
    ...credentialsByPhone.docs.map(doc => cleanString(doc.data()?.uid || doc.id, 160)),
  ]);
}

async function summarizeMemberAuthUid(uid, email = '', phoneNumber = '') {
  const safeUid = cleanString(uid, 160);
  if (!safeUid) return null;

  const normalizedEmail = normalizePublicEmail(email);
  const normalizedPhone = normalizeThaiPhoneForMemberIndex(phoneNumber);
  const phoneKey = normalizedPhone ? memberPhoneIndexKey(normalizedPhone) : '';
  const [userDoc, credentialDoc, phoneIndexSnap] = await Promise.all([
    getUserDoc(safeUid),
    getCredentialDoc(safeUid),
    phoneKey ? db.collection('phone_number_index').doc(phoneKey).get() : Promise.resolve(null),
  ]);
  const user = userDoc.data || {};
  const credential = credentialDoc.data || {};
  const userEmail = memberEmailFromData(user);
  const credentialEmail = normalizePublicEmail(credential.email_lower || '');
  const userPhone = memberPhoneFromData(user);
  const credentialPhone = normalizeThaiPhoneForMemberIndex(credential.phone_number || '');
  const phoneIndex = phoneIndexSnap?.exists ? phoneIndexSnap.data() || {} : {};

  return {
    uid: safeUid,
    userExists: userDoc.exists,
    credentialExists: credentialDoc.exists,
    hasPasswordHash: credentialHasPassword(credential),
    passwordLoginEnabled: credentialHasPassword(credential) || user.passwordLoginEnabled === true || user.password_login_enabled === true,
    emailLowerInUser: normalizedEmail ? userEmail === normalizedEmail : !!userEmail,
    emailLowerInCredential: normalizedEmail ? credentialEmail === normalizedEmail : !!credentialEmail,
    phoneInUser: normalizedPhone ? userPhone === normalizedPhone : !!userPhone,
    phoneInCredential: normalizedPhone ? credentialPhone === normalizedPhone : !!credentialPhone,
    phoneNumberIndexExists: !!phoneIndexSnap?.exists,
    phoneNumberIndexUid: cleanString(phoneIndex.uid || '', 160) || null,
    phoneNumberIndexMatchesUid: !!phoneKey && phoneIndexSnap?.exists && cleanString(phoneIndex.uid || '', 160) === safeUid,
    authProviders: Array.isArray(user.authProviderIds) ? user.authProviderIds : [],
    status: cleanString(user.status || '', 40) || null,
    emailVerified: user.emailVerified === true || user.email_verified === true,
    masked: {
      email: userEmail || credentialEmail || normalizedEmail || null,
      phoneLast4: (userPhone || credentialPhone || normalizedPhone || '').slice(-4) || null,
    },
  };
}

function authUserToMemberDoc(userRecord) {
  const providerIds = Array.isArray(userRecord.providerData)
    ? userRecord.providerData.map(provider => provider.providerId).filter(Boolean)
    : [];
  const authCreatedAt = timestampFromAuthDate(userRecord.metadata?.creationTime);
  const lastLoginAt = timestampFromAuthDate(userRecord.metadata?.lastSignInTime);
  const publicAuthEmail = isInternalPhoneEmail(userRecord.email) ? '' : cleanString(userRecord.email || '', 180);
  const phoneNumber = cleanString(userRecord.phoneNumber || '', 40);
  const phoneDisplay = cleanString(displayThaiPhone(phoneNumber), 40);
  const phoneAuthEmail = isInternalPhoneEmail(userRecord.email) ? cleanString(userRecord.email || '', 180) : '';
  const displayName = cleanString(userRecord.displayName || publicAuthEmail || (phoneNumber ? 'Eden Member ' + phoneNumber.slice(-4) : 'Eden Member'), 120);

  const data = {
    uid: userRecord.uid,
    displayName,
    email: publicAuthEmail,
    phoneE164: phoneNumber,
    phone: phoneDisplay,
    loginUsername: phoneDisplay,
    phoneAuthEmail,
    photoURL: cleanString(userRecord.photoURL || '', 500),
    memberCode: authMemberCode(userRecord.uid),
    authProviderIds: providerIds,
    authDisabled: !!userRecord.disabled,
    emailVerified: !!publicAuthEmail && !!userRecord.emailVerified,
    authCreatedAt,
    lastLoginAt,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  Object.keys(data).forEach(key => {
    if (data[key] === null || data[key] === undefined || data[key] === '') delete data[key];
  });
  return data;
}

function memberTierFromMetrics(points = 0, totalSpent = 0, visitCount = 0) {
  const p = Number(points) || 0;
  const spent = Number(totalSpent) || 0;
  const visits = Number(visitCount) || 0;
  if (p >= 5000 || spent >= 50000 || visits >= 50) return 'Platinum';
  if (p >= 1200 || spent >= 15000 || visits >= 15) return 'Gold';
  return 'Silver';
}

function cleanString(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function permissionFromImageFolder(folder) {
  const value = cleanString(folder, 40).toLowerCase();
  if (value === 'shop_products') return 'products';
  if (value === 'blogs') return 'blogs';
  if (value === 'rooms') return 'rooms';
  if (value === 'archery') return 'archery';
  return 'products';
}

function normalizeImagePayload(raw) {
  const folder = cleanString(raw.folder || 'uploads', 40).replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const fileName = cleanString(raw.fileName || `eden-${Date.now()}.webp`, 120).replace(/[^\w.-]/g, '_');
  const mimeType = cleanString(raw.mimeType || 'image/webp', 60);
  const imageBase64 = String(raw.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');

  if (!/^image\/(webp|jpeg|png|gif)$/i.test(mimeType)) throw new Error('Unsupported image type');
  if (!imageBase64) throw new Error('Missing image data');
  if (imageBase64.length > 14 * 1024 * 1024) throw new Error('Image is too large. Maximum size is 10 MB');
  if (!/^[A-Za-z0-9+/=]+$/.test(imageBase64)) throw new Error('Invalid image data');

  const buffer = Buffer.from(imageBase64, 'base64');
  if (!buffer.length) throw new Error('Invalid image data');
  if (buffer.length > 10 * 1024 * 1024) throw new Error('Image is too large. Maximum size is 10 MB');

  return { folder, fileName, mimeType, buffer };
}

function publicImagePath(folder, fileName) {
  const yearMonth = new Date().toISOString().slice(0, 7);
  const uniqueName = `${Date.now()}-${fileName}`.replace(/-+/g, '-');
  return `${folder}/${yearMonth}/${uniqueName}`.replace(/\/+/g, '/');
}

async function uploadToSpaceshipHosting({ folder, fileName, buffer }) {
  const server = SPACESHIP_FTP_SERVER.value();
  const username = SPACESHIP_FTP_USERNAME.value();
  const password = SPACESHIP_FTP_PASSWORD.value();
  if (!server || !username || !password) throw new Error('Spaceship FTP secrets are not configured');

  const relativePath = publicImagePath(folder, fileName);
  const remotePath = `${IMAGE_REMOTE_ROOT}/${relativePath}`.replace(/\/+/g, '/');
  const remoteParts = remotePath.split('/');
  const remoteFileName = remoteParts.pop();
  const remoteDir = remoteParts.join('/');
  const hosts = [...new Set([server, ...SPACESHIP_FTP_FALLBACK_HOSTS].filter(Boolean))];
  let client;
  let lastAccessError;

  try {
    for (const host of hosts) {
      client = new ftp.Client(30000);
      try {
        await client.access({
          host,
          user: username,
          password,
          secure: true,
          secureOptions: { rejectUnauthorized: false },
        });
        lastAccessError = null;
        break;
      } catch (error) {
        lastAccessError = error;
        logger.warn('Spaceship FTP host failed, trying fallback if available', {
          host,
          message: error.message,
        });
        client.close();
        client = null;
      }
    }
    if (lastAccessError) throw lastAccessError;
    await client.ensureDir(remoteDir);
    await client.uploadFrom(Readable.from([buffer]), remoteFileName);
  } finally {
    if (client) client.close();
  }

  return {
    path: remotePath,
    url: `${IMAGE_PUBLIC_BASE_URL}/${relativePath}`.replace(/([^:]\/)\/+/g, '$1'),
  };
}

function isISODate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function isTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function availabilityDocId(date, time) {
  return `${date}_${time}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

async function uidFromAuthHeader(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('Missing Authorization token');
    error.statusCode = 401;
    throw error;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    return decoded.uid || '';
  } catch (error) {
    logger.warn('Booking auth token rejected', { message: error.message });
    const authError = new Error('Invalid Authorization token');
    authError.statusCode = 401;
    throw authError;
  }
}

function normalizeBookingPayload(raw, verifiedUid = '') {
  const bookingType = cleanString(raw.bookingType, 20);
  const date = cleanString(raw.date, 20);
  const guests = Number(raw.guests) || 0;
  const note = cleanString(raw.note, 300);
  const booking = {
    bookingType,
    name: cleanString(raw.name, 120),
    phone: cleanString(raw.phone, 40),
    guests,
    date,
    note,
    status: 'pending',
  };

  if (!verifiedUid) throw new Error('Missing Authorization token');
  booking.uid = verifiedUid;

  if (!['table', 'room'].includes(bookingType)) throw new Error('Invalid booking type');
  if (!booking.name || !booking.phone || !isISODate(date)) throw new Error('Missing booking fields');
  if (guests < 1 || guests > 99) throw new Error('Invalid guest count');

  if (bookingType === 'table') {
    const time = cleanString(raw.arrivalTime || raw.startTime, 10);
    const tableIds = Array.isArray(raw.tableIds)
      ? raw.tableIds.map(id => cleanString(id, 80)).filter(Boolean)
      : [];
    if (!isTime(time)) throw new Error('Invalid arrival time');
    if (guests > 12) throw new Error('Large parties must contact the cafe directly');
    if (tableIds.length < 1 || tableIds.length > 3) throw new Error('Invalid table selection');
    booking.arrivalTime = time;
    booking.startTime = time;
    booking.endTime = '';
    booking.tableIds = tableIds;
    booking.tableNo = cleanString(raw.tableNo, 80);
    booking.tableZone = cleanString(raw.tableZone, 120);
  } else {
    const startTime = cleanString(raw.startTime, 10);
    const endTime = cleanString(raw.endTime, 10);
    if (!isTime(startTime) || !isTime(endTime) || startTime >= endTime) throw new Error('Invalid room time');
    booking.startTime = startTime;
    booking.endTime = endTime;
    booking.roomType = cleanString(raw.roomType, 120);
    booking.price = cleanString(raw.price, 40);
    booking.addons = Array.isArray(raw.addons) ? raw.addons.map(item => cleanString(item, 80)).slice(0, 20) : [];
  }

  return booking;
}

function normalizeReview(review) {
  return {
    authorName: String(review.author_name || 'Google user'),
    profilePhotoUrl: String(review.profile_photo_url || ''),
    rating: Number(review.rating) || 0,
    relativeTimeDescription: String(review.relative_time_description || ''),
    text: String(review.text || ''),
    time: Number(review.time) || 0,
  };
}

async function fetchGoogleReviews() {
  const apiKey = GOOGLE_MAPS_SERVER_KEY.value() || process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_SERVER_KEY is not configured');
  }

  const url = new URL(PLACE_DETAILS_URL);
  url.searchParams.set('place_id', PLACE_ID);
  url.searchParams.set('fields', 'rating,user_ratings_total,reviews,url');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('language', 'th');
  url.searchParams.set('reviews_sort', 'newest');

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.status !== 'OK') {
    throw new Error(`Google Places request failed: HTTP ${response.status}, status ${data.status || 'unknown'}, ${data.error_message || 'no error message'}`);
  }

  const result = data.result || {};
  const reviews = Array.isArray(result.reviews) ? result.reviews.map(normalizeReview) : [];

  return {
    placeId: PLACE_ID,
    rating: Number(result.rating) || 0,
    userRatingsTotal: Number(result.user_ratings_total) || 0,
    googleMapsUrl: String(result.url || ''),
    reviews,
    source: 'google_places_details',
    sort: 'newest',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function reviewKey(review) {
  return [
    String(review.authorName || '').trim().toLowerCase(),
    Number(review.time) || 0,
    String(review.text || '').trim().slice(0, 80),
  ].join('|');
}

function selectFiveStarReviews(latestReviews, previousReviews) {
  const combined = [...latestReviews, ...previousReviews]
    .filter(review => Number(review.rating) === 5);
  const seen = new Set();

  return combined
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0))
    .filter(review => {
      const key = reviewKey(review);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, REVIEW_LIMIT);
}

exports.refreshGoogleReviewsDaily = onSchedule(
  {
    schedule: '0 0 * * *',
    timeZone: 'Asia/Bangkok',
    region: 'asia-southeast1',
    retryCount: 3,
    secrets: [GOOGLE_MAPS_SERVER_KEY],
  },
  async () => {
    try {
      const cache = await fetchGoogleReviews();
      const cacheRef = db.collection('google_reviews').doc('cache');
      const previousSnap = await cacheRef.get();
      const previousData = previousSnap.exists ? previousSnap.data() : {};
      const previousReviews = Array.isArray(previousData.reviews) ? previousData.reviews : [];
      const selectedReviews = selectFiveStarReviews(cache.reviews, previousReviews);

      if (selectedReviews.length === 0 && previousReviews.length > 0) {
        selectedReviews.push(...previousReviews.slice(0, REVIEW_LIMIT));
      }

      const nextCache = {
        ...cache,
        reviews: selectedReviews,
        reviewFilter: '5_star_only',
        reviewLimit: REVIEW_LIMIT,
        latestFetchedReviewCount: cache.reviews.length,
        latestFetchedFiveStarCount: cache.reviews.filter(review => Number(review.rating) === 5).length,
      };

      await cacheRef.set(nextCache, { merge: true });
      logger.info('Google review cache refreshed', {
        rating: nextCache.rating,
        userRatingsTotal: nextCache.userRatingsTotal,
        reviewCount: nextCache.reviews.length,
        latestFetchedReviewCount: nextCache.latestFetchedReviewCount,
        latestFetchedFiveStarCount: nextCache.latestFetchedFiveStarCount,
        reviewFilter: nextCache.reviewFilter,
        sort: nextCache.sort,
      });
    } catch (error) {
      logger.error('Google review cache refresh skipped or failed', { message: error.message });
    }
  }
);

exports.getTableAvailability = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    try {
      checkRateLimit(req, 'tableAvailability', 120, 10 * 60 * 1000);
      const date = cleanString(req.query.date, 20);
      const time = cleanString(req.query.time, 10);
      if (!isISODate(date) || !isTime(time)) {
        res.status(400).json({ error: 'Invalid date or time' });
        return;
      }

      const availabilityRef = db.collection('table_availability').doc(availabilityDocId(date, time));
      const snap = await availabilityRef.get();
      const tableIds = snap.exists && Array.isArray(snap.data().tableIds) ? snap.data().tableIds : [];

      res.set('Cache-Control', 'no-store');
      res.json({ date, time, tableIds });
    } catch (error) {
      logger.error('Unable to read table availability', { message: error.message });
      const publicError = publicApiError(error, 'Unable to read table availability');
      res.status(publicError.status).json({ error: publicError.message });
    }
  }
);

exports.createBooking = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'createBooking', 12, 10 * 60 * 1000);
      const verifiedUid = await uidFromAuthHeader(req);
      const booking = normalizeBookingPayload(req.body || {}, verifiedUid);
      const bookingRef = db.collection('bookings').doc();

      if (booking.bookingType !== 'table') {
        await bookingRef.set({
          ...booking,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.status(201).json({ id: bookingRef.id });
        return;
      }

      const availabilityRef = db.collection('table_availability').doc(availabilityDocId(booking.date, booking.arrivalTime));
      await db.runTransaction(async transaction => {
        const availabilitySnap = await transaction.get(availabilityRef);
        const bookedIds = availabilitySnap.exists && Array.isArray(availabilitySnap.data().tableIds)
          ? availabilitySnap.data().tableIds
          : [];
        const conflictIds = booking.tableIds.filter(id => bookedIds.includes(id));
        if (conflictIds.length) {
          const conflictError = new Error('Selected table is already booked');
          conflictError.statusCode = 409;
          conflictError.conflictIds = conflictIds;
          throw conflictError;
        }

        transaction.set(bookingRef, {
          ...booking,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        transaction.set(availabilityRef, {
          date: booking.date,
          time: booking.arrivalTime,
          tableIds: admin.firestore.FieldValue.arrayUnion(...booking.tableIds),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });

      res.status(201).json({ id: bookingRef.id });
    } catch (error) {
      const status = error.statusCode || (/Invalid|Missing|Large/.test(error.message) ? 400 : 500);
      logger.warn('Booking create failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Booking create failed. Please check the details and try again.');
      res.status(status).json({
        error: status === 409 ? 'Selected table is already booked.' : publicError.message,
        conflictIds: status === 409 ? (error.conflictIds || []) : [],
      });
    }
  }
);

exports.uploadSpaceshipImage = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [
      SPACESHIP_FTP_SERVER,
      SPACESHIP_FTP_USERNAME,
      SPACESHIP_FTP_PASSWORD,
    ],
    timeoutSeconds: 60,
    memory: '512MiB',
  },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      await requireAdminAccess(req, permissionFromImageFolder(req.body?.folder));
      const payload = normalizeImagePayload(req.body || {});
      const uploaded = await uploadToSpaceshipHosting(payload);
      logger.info('Image uploaded to Spaceship hosting', {
        path: uploaded.path,
        folder: payload.folder,
        byteLength: payload.buffer.length,
      });
      res.status(201).json({
        ok: true,
        provider: 'spaceship_hosting',
        path: uploaded.path,
        url: uploaded.url,
      });
    } catch (error) {
      const status = error.statusCode || (/Missing|Invalid|Unsupported|large|configured/i.test(error.message) ? 400 : 500);
      logger.warn('Spaceship image upload failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to upload image. Please check the file and try again.');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.upsertAdminAccessUser = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const owner = await requireOwnerAccess(req);
      const body = req.body || {};
      const requestedUid = cleanString(body.uid || '', 128);
      const email = cleanString(body.email || '', 180).toLowerCase();
      const displayName = cleanString(body.displayName || email || 'Eden Manager', 120);
      const password = String(body.password || '');
      const role = normalizeAdminRole(body.role);
      const status = normalizeAdminStatus(body.status);
      const permissions = normalizeAdminPermissions(role, body.permissions || {});

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const error = new Error('Valid manager email is required');
        error.statusCode = 400;
        throw error;
      }
      if (requestedUid && requestedUid.includes('@')) {
        const error = new Error('Firebase UID must not be an email address');
        error.statusCode = 400;
        throw error;
      }
      if (password && (password.length < 8 || password.length > 128)) {
        const error = new Error('Password must be 8-128 characters');
        error.statusCode = 400;
        throw error;
      }

      let userRecord = null;
      let createdAuthUser = false;
      let passwordUpdated = false;

      if (requestedUid) {
        try {
          userRecord = await admin.auth().getUser(requestedUid);
        } catch (error) {
          if (error.code !== 'auth/user-not-found') throw error;
        }
      }

      let emailUserRecord = null;
      try {
        emailUserRecord = await admin.auth().getUserByEmail(email);
      } catch (error) {
        if (error.code !== 'auth/user-not-found') throw error;
      }

      if (userRecord && emailUserRecord && emailUserRecord.uid !== userRecord.uid) {
        const error = new Error('This email already belongs to another Firebase Auth user');
        error.statusCode = 409;
        throw error;
      }
      if (!userRecord && emailUserRecord) userRecord = emailUserRecord;

      if (!userRecord) {
        if (!password) {
          const error = new Error('Password is required for a new manager account');
          error.statusCode = 400;
          throw error;
        }
        userRecord = await admin.auth().createUser({
          uid: requestedUid || undefined,
          email,
          password,
          displayName,
          emailVerified: false,
          disabled: false,
        });
        createdAuthUser = true;
        passwordUpdated = true;
      } else {
        const updatePayload = { email, displayName, disabled: false };
        if (password) {
          updatePayload.password = password;
          passwordUpdated = true;
        }
        userRecord = await admin.auth().updateUser(userRecord.uid, updatePayload);
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const accessRef = db.collection('admin_users').doc(userRecord.uid);
      const accessSnap = await accessRef.get();
      const existingAccess = accessSnap.exists ? accessSnap.data() || {} : {};
      const accessPayload = {
        uid: userRecord.uid,
        email,
        displayName,
        role,
        status,
        permissions,
        passwordLoginEnabled: passwordUpdated || hasPasswordProvider(userRecord),
        authManagedAt: now,
        authManagedBy: owner.uid || '',
        updatedAt: now,
        updatedBy: owner.uid || '',
        ...normalizeAdminArcheryAccess(role, permissions, body, existingAccess),
      };
      if (passwordUpdated) accessPayload.passwordUpdatedAt = now;
      if (!accessSnap.exists) {
        accessPayload.createdAt = now;
        accessPayload.createdBy = owner.uid || '';
      }
      await accessRef.set(accessPayload, { merge: true });

      const userRef = db.collection('users').doc(userRecord.uid);
      const userSnap = await userRef.get();
      const memberPayload = authUserToMemberDoc(userRecord);
      memberPayload.displayName = displayName;
      memberPayload.email = email;
      memberPayload.status = 'active';
      memberPayload.updatedAt = now;
      if (!userSnap.exists) memberPayload.createdAt = now;
      await userRef.set(memberPayload, { merge: true });

      logger.info('Admin access user upserted', {
        uid: userRecord.uid,
        email,
        role,
        createdAuthUser,
        passwordUpdated,
        ownerUid: owner.uid,
      });
      res.json({
        ok: true,
        uid: userRecord.uid,
        email,
        createdAuthUser,
        passwordUpdated,
        passwordLoginEnabled: accessPayload.passwordLoginEnabled,
        primary_branch_id: accessPayload.primary_branch_id || '',
        branch_ids: Array.isArray(accessPayload.branch_ids) ? accessPayload.branch_ids : [],
        archery_role: accessPayload.archery_role || '',
      });
    } catch (error) {
      const status = error.statusCode || (/required|valid|password|uid|email/i.test(error.message) ? 400 : 500);
      logger.warn('Admin access user upsert failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to save admin access user. Please check the required fields.');
      res.status(status).json({
        error: error.message || publicError.message,
        code: String(error.message || 'ADMIN_ACCESS_SAVE_FAILED').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
        status,
      });
    }
  }
);

function normalizePublicEmail(value) {
  const email = cleanString(value || '', 180).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function publicClientError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function safeSecretValue(secret, maxLength = 500) {
  try {
    return cleanString(secret.value() || '', maxLength);
  } catch (_) {
    return '';
  }
}

function emailVerificationPepper() {
  return safeSecretValue(AUTH_OTP_PEPPER, 500);
}

function emailVerificationHash(uid, email, code) {
  return crypto
    .createHmac('sha256', emailVerificationPepper())
    .update(`${uid}:${email}:${code}`)
    .digest('hex');
}

function constantTimeHexEqual(left, right) {
  const leftValue = String(left || '');
  const rightValue = String(right || '');
  if (!/^[a-f0-9]{64}$/i.test(leftValue) || !/^[a-f0-9]{64}$/i.test(rightValue)) return false;
  return crypto.timingSafeEqual(Buffer.from(leftValue, 'hex'), Buffer.from(rightValue, 'hex'));
}

function createMailTransporter() {
  const host = safeSecretValue(SMTP_HOST, 180);
  const port = Number(safeSecretValue(SMTP_PORT, 8) || 587);
  const user = safeSecretValue(SMTP_USER, 180);
  const pass = safeSecretValue(SMTP_PASS, 500);
  if (!host || !user || !pass) {
    const error = new Error('Email sender is not configured');
    error.statusCode = 503;
    throw error;
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function assertEmailAvailableForUid(email, uid) {
  const checks = await Promise.all([
    db.collection('users').where('email_lower', '==', email).limit(3).get(),
    db.collection('users').where('email', '==', email).limit(3).get(),
    db.collection('user_credentials').where('email_lower', '==', email).limit(3).get(),
  ]);

  for (const snap of checks) {
    for (const doc of snap.docs) {
      if (doc.id !== uid) {
        throw publicClientError('This email is already used by another member.', 409);
      }
    }
  }

  try {
    const authUser = await admin.auth().getUserByEmail(email);
    if (authUser.uid !== uid) {
      logger.warn('Email belongs to another Firebase Auth identity', {
        requestedUid: uid,
        authUid: authUser.uid,
        email,
      });
      throw publicClientError('This email is already linked to another Firebase account.', 409);
    }
  } catch (error) {
    if (error.publicMessage) throw error;
    if (error.code !== 'auth/user-not-found') throw error;
  }
}

exports.checkEmailVerification = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'checkEmailVerification', 30, 15 * 60 * 1000);
      const decoded = await requireSignedInUser(req);
      checkRateLimitKey(`checkEmailVerificationUid:${decoded.uid}`, 30, 15 * 60 * 1000);
      const email = normalizePublicEmail(req.body?.email);
      if (!email) {
        throw publicClientError('Please enter a valid email address.', 400);
      }

      await assertEmailAvailableForUid(email, decoded.uid);
      const userSnap = await db.collection('users').doc(decoded.uid).get();
      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const existingEmail = normalizePublicEmail(userData.email || userData.email_lower || '');
      if (existingEmail === email && userData.emailVerified === true) {
        res.json({
          ok: true,
          alreadyVerified: true,
          needsOtp: false,
          email,
        });
        return;
      }

      res.json({
        ok: true,
        available: true,
        needsOtp: true,
        email,
      });
    } catch (error) {
      const status = error.statusCode || (/email|required/i.test(error.message) ? 400 : 500);
      logger.warn('Email verification precheck failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, error.publicMessage || 'Unable to check email.');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.sendEmailVerificationCode = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_OTP_PEPPER, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM],
  },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'sendEmailVerificationCode', 8, 10 * 60 * 1000);
      const decoded = await requireSignedInUser(req);
      checkRateLimitKey(`sendEmailVerificationCodeUid:${decoded.uid}`, 5, 10 * 60 * 1000);
      const email = normalizePublicEmail(req.body?.email);
      if (!email) {
        throw publicClientError('Please enter a valid email address.', 400);
      }
      await assertEmailAvailableForUid(email, decoded.uid);

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const now = admin.firestore.Timestamp.now();
      const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));
      await db.collection('email_verification_codes').doc(decoded.uid).set({
        uid: decoded.uid,
        email,
        codeHash: emailVerificationHash(decoded.uid, email, code),
        attempts: 0,
        createdAt: now,
        expiresAt,
      });

      const from = safeSecretValue(SMTP_FROM, 180) || safeSecretValue(SMTP_USER, 180);
      await createMailTransporter().sendMail({
        from,
        to: email,
        subject: 'Eden Cafe email verification code',
        text: `Your Eden Cafe verification code is ${code}. This code expires in 10 minutes.`,
        html: [
          '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#123526;">',
          '<h2 style="margin:0 0 12px;">Eden Cafe email verification</h2>',
          '<p>Please use this 6-digit code to verify your email address.</p>',
          `<div style="font-size:32px;font-weight:700;letter-spacing:0.18em;background:#f2fbf3;border-radius:14px;padding:18px 22px;display:inline-block;">${code}</div>`,
          '<p>This code expires in 10 minutes. If you did not request this, you can ignore this email.</p>',
          '</div>',
        ].join(''),
      });

      logger.info('Email verification code sent', { uid: decoded.uid, email });
      res.json({ ok: true, expiresInMinutes: 10 });
    } catch (error) {
      const status = error.statusCode || (/email|required|configured/i.test(error.message) ? 400 : 500);
      logger.warn('Email verification send failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, error.publicMessage || 'Unable to send verification code.');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.verifyEmailCode = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_OTP_PEPPER],
  },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'verifyEmailCode', 30, 10 * 60 * 1000);
      const decoded = await requireSignedInUser(req);
      checkRateLimitKey(`verifyEmailCodeUid:${decoded.uid}`, 12, 10 * 60 * 1000);
      const email = normalizePublicEmail(req.body?.email);
      const code = cleanString(req.body?.code || '', 6);
      if (!email || !/^\d{6}$/.test(code)) {
        throw publicClientError('Please enter a valid email and 6-digit code.', 400);
      }
      await assertEmailAvailableForUid(email, decoded.uid);

      const codeRef = db.collection('email_verification_codes').doc(decoded.uid);
      const codeSnap = await codeRef.get();
      if (!codeSnap.exists) {
        throw publicClientError('Verification code was not found or expired.', 400);
      }

      const record = codeSnap.data() || {};
      const expiresAt = record.expiresAt?.toDate ? record.expiresAt.toDate().getTime() : 0;
      if (record.email !== email || !expiresAt || expiresAt < Date.now()) {
        await codeRef.delete().catch(() => {});
        throw publicClientError('Verification code was not found or expired.', 400);
      }

      const expectedHash = emailVerificationHash(decoded.uid, email, code);
      if (Number(record.attempts || 0) >= 5 || !constantTimeHexEqual(record.codeHash, expectedHash)) {
        await codeRef.set({ attempts: admin.firestore.FieldValue.increment(1) }, { merge: true });
        throw publicClientError('Verification code is incorrect.', 400);
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      const userRef = db.collection('users').doc(decoded.uid);
      const credentialRef = db.collection('user_credentials').doc(decoded.uid);
      await db.runTransaction(async tx => {
        const credentialSnap = await tx.get(credentialRef);
        const credential = credentialSnap.exists ? credentialSnap.data() || {} : {};
        const userPayload = {
          uid: decoded.uid,
          email,
          email_lower: email,
          emailVerified: true,
          emailVerifiedAt: now,
          updatedAt: now,
        };
        if (credential.password_hash) userPayload.passwordLoginEnabled = true;
        tx.set(userRef, userPayload, { merge: true });
        tx.set(credentialRef, {
          uid: decoded.uid,
          email_lower: email,
          updated_at: now,
        }, { merge: true });
        tx.delete(codeRef);
      });

      try {
        await admin.auth().updateUser(decoded.uid, { email, emailVerified: true });
      } catch (authError) {
        if (authError.code !== 'auth/user-not-found' && authError.code !== 'auth/email-already-exists') throw authError;
        logger.warn('Email verified in Firestore but Auth email was not updated', {
          uid: decoded.uid,
          code: authError.code,
        });
      }

      logger.info('Email verified by code', { uid: decoded.uid, email });
      res.json({ ok: true, email, emailVerifiedAt: new Date().toISOString() });
    } catch (error) {
      const status = error.statusCode || (/email|code|expired|incorrect|required/i.test(error.message) ? 400 : 500);
      logger.warn('Email verification failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, error.publicMessage || 'Unable to verify email code.');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.syncAuthUsersToFirestore = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      await requireAdminAccess(req, 'members');
      let nextPageToken;
      let synced = 0;
      let created = 0;
      let updated = 0;
      const repairStats = {
        credentialLinksRepaired: 0,
        phoneIndexesRepaired: 0,
        phoneIndexConflicts: 0,
        membersWithoutPasswordHash: 0,
        legacyMembersScanned: 0,
      };

      do {
        const result = await admin.auth().listUsers(1000, nextPageToken);
        for (const userRecord of result.users) {
          const userRef = db.collection('users').doc(userRecord.uid);
          const snap = await userRef.get();
          const memberDoc = authUserToMemberDoc(userRecord);
          if (!snap.exists) {
            memberDoc.createdAt = memberDoc.authCreatedAt || admin.firestore.FieldValue.serverTimestamp();
            memberDoc.status = 'active';
            created++;
          } else {
            updated++;
          }
          await userRef.set(memberDoc, { merge: true });
          await repairMemberAuthLink(userRecord.uid, memberDoc, repairStats);
          synced++;
        }
        nextPageToken = result.pageToken;
      } while (nextPageToken);

      const legacyUsersSnap = await db.collection('users').get();
      for (const userDoc of legacyUsersSnap.docs) {
        repairStats.legacyMembersScanned++;
        await repairMemberAuthLink(userDoc.id, userDoc.data() || {}, repairStats);
      }
      const repairReport = {
        credentialLinksRepaired: repairStats.credentialLinksRepaired,
        phoneIndexesRepaired: repairStats.phoneIndexesRepaired,
        phoneIndexConflicts: repairStats.phoneIndexConflicts,
        membersWithoutPasswordHash: repairStats.membersWithoutPasswordHash || 0,
        legacyMembersScanned: repairStats.legacyMembersScanned,
      };

      logger.info('Auth users synced and member auth links repaired', {
        synced,
        created,
        updated,
        repair: repairReport,
      });
      res.json({ ok: true, synced, created, updated, repair: repairReport });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Auth user sync failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to sync members.');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.diagnoseMemberAuthLink = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'diagnoseMemberAuthLink', 60, 15 * 60 * 1000);
      await requireAdminAccess(req, 'members');

      const body = req.body || {};
      const email = normalizePublicEmail(body.email || body.emailLower || '');
      const phoneNumber = normalizeThaiPhoneForMemberIndex(body.phoneNumber || body.phone || '');
      const requestedUid = cleanString(body.uid || body.userId || '', 160);
      const shouldRepair = body.repair === true;

      if (!email && !phoneNumber && !requestedUid) {
        throw publicClientError('Email, phone number, or UID is required.', 400);
      }

      const [emailUids, phoneUids] = await Promise.all([
        email ? findMemberUidsByEmail(email) : Promise.resolve([]),
        phoneNumber ? findMemberUidsByPhone(phoneNumber) : Promise.resolve([]),
      ]);

      const allCandidateUids = uniqueCleanStrings([
        requestedUid,
        ...emailUids,
        ...phoneUids,
      ]);
      const emailPrimaryUid = emailUids[0] || null;
      const phonePrimaryUid = phoneUids[0] || null;
      const uidMatches = !!(emailPrimaryUid && phonePrimaryUid && emailPrimaryUid === phonePrimaryUid);
      const hasUidConflict = allCandidateUids.length > 1
        && !(requestedUid && allCandidateUids.every(uid => uid === requestedUid));
      const canonicalUid = requestedUid || (uidMatches ? emailPrimaryUid : '') || (allCandidateUids.length === 1 ? allCandidateUids[0] : '');

      const before = await Promise.all(allCandidateUids.map(uid => summarizeMemberAuthUid(uid, email, phoneNumber)));
      const repair = {
        requested: shouldRepair,
        performed: false,
        skippedReason: '',
        stats: {},
      };

      if (shouldRepair) {
        if (!canonicalUid) {
          repair.skippedReason = 'NO_CANONICAL_UID';
        } else if (hasUidConflict && !requestedUid) {
          repair.skippedReason = 'UID_CONFLICT_REQUIRES_EXPLICIT_UID';
        } else if (requestedUid && allCandidateUids.some(uid => uid !== requestedUid)) {
          repair.skippedReason = 'REQUESTED_UID_CONFLICTS_WITH_EXISTING_INDEX';
        } else {
          const userDoc = await getUserDoc(canonicalUid);
          const repairStats = {};
          await repairMemberAuthLink(canonicalUid, {
            ...(userDoc.data || {}),
            uid: canonicalUid,
            email: email || memberEmailFromData(userDoc.data || {}),
            email_lower: email || memberEmailFromData(userDoc.data || {}),
            phone_number: phoneNumber || memberPhoneFromData(userDoc.data || {}),
            phoneE164: phoneNumber || memberPhoneFromData(userDoc.data || {}),
          }, repairStats);
          repair.performed = true;
          repair.stats = {
            credentialLinksRepaired: repairStats.credentialLinksRepaired || 0,
            phoneIndexesRepaired: repairStats.phoneIndexesRepaired || 0,
            phoneIndexConflicts: repairStats.phoneIndexConflicts || 0,
            membersWithoutPasswordHash: repairStats.membersWithoutPasswordHash || 0,
          };
        }
      }

      const afterUids = uniqueCleanStrings([
        ...allCandidateUids,
        canonicalUid,
        ...(email ? await findMemberUidsByEmail(email) : []),
        ...(phoneNumber ? await findMemberUidsByPhone(phoneNumber) : []),
      ]);
      const after = await Promise.all(afterUids.map(uid => summarizeMemberAuthUid(uid, email, phoneNumber)));
      const selected = canonicalUid
        ? after.find(item => item?.uid === canonicalUid) || await summarizeMemberAuthUid(canonicalUid, email, phoneNumber)
        : null;
      let recommendation = 'REVIEW_REQUIRED';
      if (hasUidConflict && !requestedUid) recommendation = 'UID_CONFLICT_REVIEW_REQUIRED';
      else if (!canonicalUid) recommendation = 'MEMBER_NOT_FOUND';
      else if (!selected?.hasPasswordHash) recommendation = 'SAFE_PASSWORD_SETUP_REQUIRED';
      else if (email && phoneNumber && !uidMatches && !requestedUid) recommendation = 'UID_CONFLICT_REVIEW_REQUIRED';
      else if (selected?.phoneNumberIndexExists === false && phoneNumber) recommendation = 'REPAIR_PHONE_INDEX';
      else recommendation = 'READY_FOR_EMAIL_PHONE_PASSWORD_LOGIN';

      res.json({
        ok: true,
        input: {
          email: email || null,
          phoneLast4: phoneNumber ? phoneNumber.slice(-4) : null,
          requestedUid: requestedUid || null,
        },
        found: {
          uidFromEmail: emailPrimaryUid,
          uidFromPhone: phonePrimaryUid,
          uidMatches,
          candidateUids: allCandidateUids,
          canonicalUid: canonicalUid || null,
        },
        selected,
        before,
        after,
        repair,
        recommendation,
      });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Member auth link diagnosis failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to diagnose member auth link.');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.adjustMemberPoints = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const decoded = await requireAdminAccess(req, 'loyalty');
      const body = req.body || {};
      const userId = cleanString(body.userId, 160);
      const requestedDelta = Math.trunc(Number(body.pointsDelta || body.delta || 0));
      const reason = cleanString(body.reason, 240);

      if (!userId) {
        const error = new Error('Member UID is required');
        error.statusCode = 400;
        throw error;
      }
      if (!requestedDelta) {
        const error = new Error('Point adjustment must not be zero');
        error.statusCode = 400;
        throw error;
      }
      if (Math.abs(requestedDelta) > 100000) {
        const error = new Error('Point adjustment is too large');
        error.statusCode = 400;
        throw error;
      }
      if (!reason) {
        const error = new Error('Adjustment reason is required');
        error.statusCode = 400;
        throw error;
      }

      const userRef = db.collection('users').doc(userId);
      const summaryRef = db.collection('member_summaries').doc(userId);
      const ledgerRef = db.collection('point_ledger').doc();
      let resultPayload = null;

      await db.runTransaction(async transaction => {
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists) {
          const error = new Error('Member profile was not found');
          error.statusCode = 404;
          throw error;
        }

        const member = userSnap.data() || {};
        const before = Math.max(0, Math.floor(Number(member.points || 0)));
        const after = Math.max(0, before + requestedDelta);
        const actualDelta = after - before;
        if (!actualDelta) {
          const error = new Error('Point adjustment has no effect because the member balance is already zero');
          error.statusCode = 400;
          throw error;
        }

        const totalSpent = Number(member.totalSpent || 0);
        const visitCount = Number(member.visitCount || 0);
        const tier = memberTierFromMetrics(after, totalSpent, visitCount);
        const now = admin.firestore.FieldValue.serverTimestamp();
        const actorEmail = cleanString(decoded.email || '', 180);

        transaction.set(ledgerRef, {
          userId,
          memberCode: cleanString(member.memberCode || '', 80),
          memberName: cleanString(member.displayName || member.name || member.customerName || 'Eden Member', 160),
          memberEmail: cleanString(member.email || '', 180),
          type: 'manual_adjustment',
          pointsDelta: actualDelta,
          requestedDelta,
          pointsBefore: before,
          pointsAfter: after,
          reason,
          source: 'admin',
          createdAt: now,
          createdBy: decoded.uid || '',
          createdByEmail: actorEmail,
        });

        transaction.set(userRef, {
          points: after,
          tier,
          loyaltyUpdatedAt: now,
          pointsAdjustedAt: now,
          updatedAt: now,
        }, { merge: true });

        const summaryPayload = {
          userId,
          memberCode: cleanString(member.memberCode || '', 80),
          memberName: cleanString(member.displayName || member.name || member.customerName || 'Eden Member', 160),
          memberEmail: cleanString(member.email || '', 180),
          pointsBalance: after,
          tier,
          lastLedgerId: ledgerRef.id,
          updatedAt: now,
        };
        if (actualDelta > 0) {
          summaryPayload.lifetimePoints = admin.firestore.FieldValue.increment(actualDelta);
        } else {
          summaryPayload.totalManualDeducted = admin.firestore.FieldValue.increment(Math.abs(actualDelta));
        }
        transaction.set(summaryRef, summaryPayload, { merge: true });

        resultPayload = { ledgerId: ledgerRef.id, userId, pointsBefore: before, pointsAfter: after, pointsDelta: actualDelta, tier };
      });

      logger.info('Member points adjusted', resultPayload);
      res.status(201).json({ ok: true, ...resultPayload });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Member point adjustment failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to update loyalty points.');
      res.status(status).json({ error: publicError.message });
    }
  }
);

function normalizeLoyaltySettings(raw = {}) {
  const numberOr = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const defaultTierMultipliers = { Silver: 1, Gold: 1.25, Platinum: 1.5 };
  const tierMultipliers = raw.tierMultipliers && typeof raw.tierMultipliers === 'object'
    ? {
      ...defaultTierMultipliers,
      ...Object.fromEntries(Object.entries(raw.tierMultipliers)
        .map(([tier, value]) => [tier, Math.max(0, numberOr(value, 1))])
        .filter(([, value]) => value > 0)),
    }
    : defaultTierMultipliers;

  return {
    enabled: raw.enabled !== false,
    spendPerPoint: Math.max(0, numberOr(raw.spendPerPoint, 25)),
    pointValue: Math.max(0, numberOr(raw.pointValue, 1)),
    expiryMonths: Math.max(0, Math.trunc(numberOr(raw.expiryMonths, 24))),
    maxRedeemPercent: Math.min(100, Math.max(0, numberOr(raw.maxRedeemPercent, 30))),
    minRedeemPoints: Math.max(0, Math.trunc(numberOr(raw.minRedeemPoints, 20))),
    earnAfterDiscount: raw.earnAfterDiscount !== false,
    earnOnRedeemedAmount: raw.earnOnRedeemedAmount === true,
    excludedCategories: Array.isArray(raw.excludedCategories)
      ? raw.excludedCategories.map(value => cleanString(value, 120).toLowerCase()).filter(Boolean)
      : ['เครื่องดื่มแอลกอฮอล์', 'ฝากเงิน', 'โปรแรง'],
    tierMultipliers,
  };
}

function safeLedgerKey(value) {
  return cleanString(value || Date.now(), 140)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || String(Date.now());
}

function normalizePosSaleItems(items) {
  return Array.isArray(items)
    ? items.map(item => ({
      productId: cleanString(item.productId || '', 120),
      variantId: cleanString(item.variantId || 'base', 80),
      sku: cleanString(item.sku || '', 80),
      name: cleanString(item.name || 'POS item', 180),
      variantName: cleanString(item.variantName || '', 120),
      category: cleanString(item.category || '', 160),
      quantity: Math.max(0, Number(item.quantity || 0)),
      unitPrice: Math.max(0, Number(item.unitPrice || 0)),
      lineDiscount: Math.max(0, Number(item.lineDiscount || 0)),
      taxEnabled: item.taxEnabled !== false,
    })).filter(item => item.quantity > 0)
    : [];
}

function eligibleSubtotalForPosSale(items, excludedCategories) {
  const excluded = new Set(excludedCategories);
  return items.reduce((sum, item) => {
    const category = cleanString(item.category, 160).toLowerCase();
    if (category && excluded.has(category)) return sum;
    return sum + Math.max(0, item.unitPrice * item.quantity - item.lineDiscount);
  }, 0);
}

function expiryTimestamp(months) {
  if (!months) return null;
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return admin.firestore.Timestamp.fromDate(date);
}

exports.applyPosLoyaltySale = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const decoded = await requireAdminAccess(req, 'pos');
      const body = req.body || {};
      const orderId = cleanString(body.orderId || body.firestoreId || '', 180);
      const receiptNo = cleanString(body.receiptNo || orderId, 120);
      const customerUid = cleanString(body.customerUid || '', 180);
      const idempotencyKey = safeLedgerKey(body.idempotencyKey || receiptNo || orderId);
      const netAmount = Math.max(0, Number(body.netAmount || 0));
      const normalDiscount = Math.max(0, Number(body.normalDiscount || 0));
      const subtotal = Math.max(0, Number(body.subtotal || 0));
      const requestedRedeemedPoints = Math.max(0, Math.trunc(Number(body.redeemedPoints || 0)));
      const items = normalizePosSaleItems(body.items || []);

      if (!orderId) {
        const error = new Error('Order ID is required');
        error.statusCode = 400;
        throw error;
      }
      if (!receiptNo) {
        const error = new Error('Receipt number is required');
        error.statusCode = 400;
        throw error;
      }
      if (!customerUid) {
        const error = new Error('Customer UID is required');
        error.statusCode = 400;
        throw error;
      }
      if (netAmount <= 0) {
        const error = new Error('Net amount must be greater than zero');
        error.statusCode = 400;
        throw error;
      }

      const orderRef = db.collection('orders').doc(orderId);
      const userRef = db.collection('users').doc(customerUid);
      const summaryRef = db.collection('member_summaries').doc(customerUid);
      const loyaltyRef = db.collection('site_settings').doc('loyalty');
      const earnLedgerRef = db.collection('point_ledger').doc(`pos-earn-${idempotencyKey}`);
      const redeemLedgerRef = db.collection('point_ledger').doc(`pos-redeem-${idempotencyKey}`);
      let resultPayload = null;

      await db.runTransaction(async transaction => {
        const [
          orderSnap,
          userSnap,
          summarySnap,
          loyaltySnap,
          earnLedgerSnap,
          redeemLedgerSnap,
        ] = await Promise.all([
          transaction.get(orderRef),
          transaction.get(userRef),
          transaction.get(summaryRef),
          transaction.get(loyaltyRef),
          transaction.get(earnLedgerRef),
          transaction.get(redeemLedgerRef),
        ]);

        if (!orderSnap.exists) {
          const error = new Error('Synced order was not found');
          error.statusCode = 404;
          throw error;
        }
        if (!userSnap.exists) {
          const error = new Error('Member profile was not found');
          error.statusCode = 404;
          throw error;
        }

        const order = orderSnap.data() || {};
        if (
          order.loyaltySyncStatus === 'synced' &&
          order.loyaltyIdempotencyKey === idempotencyKey &&
          order.loyalty
        ) {
          resultPayload = order.loyalty;
          return;
        }
        if (earnLedgerSnap.exists || redeemLedgerSnap.exists) {
          resultPayload = order.loyalty || {
            customerUid,
            earnedPoints: Number(earnLedgerSnap.data()?.pointsDelta || 0),
            redeemedPoints: Math.abs(Number(redeemLedgerSnap.data()?.pointsDelta || 0)),
            loyaltyDiscount: Number(order.loyaltyDiscount || 0),
            idempotencyKey,
            ledgerIds: {
              earn: earnLedgerSnap.exists ? earnLedgerRef.id : '',
              redeem: redeemLedgerSnap.exists ? redeemLedgerRef.id : '',
            },
            syncedAt: new Date().toISOString(),
          };
          transaction.set(orderRef, {
            loyalty: resultPayload,
            loyaltySyncStatus: 'synced',
            loyaltyError: '',
            loyaltyIdempotencyKey: idempotencyKey,
            loyaltySyncedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          return;
        }

        const config = normalizeLoyaltySettings(
          loyaltySnap.exists ? loyaltySnap.data() || {} : {}
        );
        if (!config.enabled) {
          const error = new Error('Loyalty is disabled');
          error.statusCode = 400;
          throw error;
        }

        const member = userSnap.data() || {};
        const summary = summarySnap.exists ? summarySnap.data() || {} : {};
        const memberTotalSpent = Math.max(0, Number(member.totalSpent || 0));
        const memberVisitCount = Math.max(0, Math.floor(Number(member.visitCount || 0)));
        const summaryTotalSpent = Math.max(0, Number(summary.totalSpent ?? memberTotalSpent));
        const summaryVisitCount = Math.max(0, Math.floor(Number(summary.visitCount ?? memberVisitCount)));
        const summaryLifetimePoints = Math.max(0, Number(summary.lifetimePoints || 0));
        const summaryTotalRedeemed = Math.max(0, Number(summary.totalRedeemed || 0));
        const memberPoints = Math.max(0, Math.floor(Number(member.points || 0)));
        const estimatedLegacyPoints = config.spendPerPoint > 0
          ? Math.floor(memberTotalSpent / config.spendPerPoint)
          : 0;
        const pointsBefore = summarySnap.exists && summary.pointsBalance !== undefined
          ? Math.max(0, Math.floor(Number(summary.pointsBalance || 0)))
          : Math.max(memberPoints, estimatedLegacyPoints);
        const summaryLifetimeBase = Math.max(summaryLifetimePoints, pointsBefore);

        if (requestedRedeemedPoints > pointsBefore) {
          const error = new Error('Redeemed points exceed member balance');
          error.statusCode = 400;
          throw error;
        }
        if (
          requestedRedeemedPoints > 0 &&
          config.minRedeemPoints > 0 &&
          requestedRedeemedPoints < config.minRedeemPoints
        ) {
          const error = new Error(`Minimum redeem points is ${config.minRedeemPoints}`);
          error.statusCode = 400;
          throw error;
        }

        const requestedDiscount = requestedRedeemedPoints * config.pointValue;
        const maxRedeemDiscount = (netAmount * config.maxRedeemPercent) / 100;
        if (requestedDiscount > maxRedeemDiscount + 0.0001) {
          const error = new Error('Redeemed points exceed max redeem percent');
          error.statusCode = 400;
          throw error;
        }
        if (requestedDiscount > netAmount + 0.0001) {
          const error = new Error('Redeemed points exceed sale amount');
          error.statusCode = 400;
          throw error;
        }

        const loyaltyDiscount = Math.min(netAmount, requestedDiscount);
        const payableAmount = Math.max(0, netAmount - loyaltyDiscount);
        const eligibleSubtotal = eligibleSubtotalForPosSale(items, config.excludedCategories);
        const subtotalBase = subtotal > 0
          ? subtotal
          : items.reduce((sum, item) => sum + Math.max(0, item.unitPrice * item.quantity), 0);
        const eligibleRatio = subtotalBase > 0 ? Math.min(1, eligibleSubtotal / subtotalBase) : 0;
        const normalDiscountShare = config.earnAfterDiscount
          ? normalDiscount * eligibleRatio
          : 0;
        const redeemedDiscountShare = config.earnOnRedeemedAmount
          ? 0
          : loyaltyDiscount * eligibleRatio;
        const earnBase = Math.max(0, eligibleSubtotal - normalDiscountShare - redeemedDiscountShare);
        const currentTier = cleanString(member.tier || summary.tier || 'Silver', 40);
        const multiplier = Number(config.tierMultipliers[currentTier] || 1);
        const earnedPoints = config.spendPerPoint > 0
          ? Math.floor((earnBase / config.spendPerPoint) * multiplier)
          : 0;
        const pointsAfter = Math.max(0, pointsBefore - requestedRedeemedPoints + earnedPoints);
        const totalSpentAfter = memberTotalSpent + payableAmount;
        const visitCountAfter = memberVisitCount + 1;
        const tier = memberTierFromMetrics(pointsAfter, totalSpentAfter, visitCountAfter);
        const now = admin.firestore.FieldValue.serverTimestamp();
        const syncedAt = new Date().toISOString();
        const memberCode = cleanString(member.memberCode || '', 80);
        const memberName = cleanString(member.displayName || member.name || member.customerName || 'Eden Member', 160);
        const memberEmail = cleanString(member.email || '', 180);

        resultPayload = {
          customerUid,
          earnedPoints,
          redeemedPoints: requestedRedeemedPoints,
          loyaltyDiscount,
          pointsBefore,
          pointsAfter,
          tier,
          eligibleAmount: eligibleSubtotal,
          earnBase,
          idempotencyKey,
          ledgerIds: {
            earn: earnedPoints > 0 ? earnLedgerRef.id : '',
            redeem: requestedRedeemedPoints > 0 ? redeemLedgerRef.id : '',
          },
          syncedAt,
        };

        if (requestedRedeemedPoints > 0) {
          transaction.set(redeemLedgerRef, {
            userId: customerUid,
            memberCode,
            memberName,
            memberEmail,
            type: 'pos_redeem',
            pointsDelta: -requestedRedeemedPoints,
            pointsBefore,
            pointsAfter: pointsBefore - requestedRedeemedPoints,
            amount: loyaltyDiscount,
            receiptNo,
            orderId,
            idempotencyKey,
            source: 'pos',
            createdAt: now,
            createdBy: decoded.uid || '',
            createdByEmail: cleanString(decoded.email || '', 180),
          });
        }
        if (earnedPoints > 0) {
          const earnPayload = {
            userId: customerUid,
            memberCode,
            memberName,
            memberEmail,
            type: 'pos_earn',
            pointsDelta: earnedPoints,
            pointsBefore: pointsBefore - requestedRedeemedPoints,
            pointsAfter,
            amount: earnBase,
            receiptNo,
            orderId,
            idempotencyKey,
            source: 'pos',
            createdAt: now,
            createdBy: decoded.uid || '',
            createdByEmail: cleanString(decoded.email || '', 180),
          };
          const expiresAt = expiryTimestamp(config.expiryMonths);
          if (expiresAt) earnPayload.expiresAt = expiresAt;
          transaction.set(earnLedgerRef, earnPayload);
        }

        transaction.set(userRef, {
          points: pointsAfter,
          totalSpent: totalSpentAfter,
          visitCount: visitCountAfter,
          tier,
          loyaltyUpdatedAt: now,
          updatedAt: now,
        }, { merge: true });

        transaction.set(summaryRef, {
          userId: customerUid,
          memberCode,
          memberName,
          memberEmail,
          pointsBalance: pointsAfter,
          tier,
          lifetimePoints: summaryLifetimeBase + earnedPoints,
          totalRedeemed: summaryTotalRedeemed + requestedRedeemedPoints,
          totalSpent: summaryTotalSpent + payableAmount,
          visitCount: summaryVisitCount + 1,
          lastLedgerId:
            earnedPoints > 0
              ? earnLedgerRef.id
              : requestedRedeemedPoints > 0
                ? redeemLedgerRef.id
                : cleanString(summary.lastLedgerId || '', 180),
          updatedAt: now,
        }, { merge: true });

        transaction.set(orderRef, {
          loyalty: resultPayload,
          earnedPoints,
          redeemedPoints: requestedRedeemedPoints,
          loyaltyDiscount,
          totalBeforeLoyalty: netAmount,
          totalAmount: payableAmount,
          total: payableAmount,
          loyaltySyncStatus: 'synced',
          loyaltyError: '',
          loyaltyIdempotencyKey: idempotencyKey,
          loyaltySyncedAt: now,
          updatedAt: now,
        }, { merge: true });
      });

      logger.info('POS loyalty sale applied', {
        orderId,
        receiptNo,
        customerUid,
        idempotencyKey,
        earnedPoints: resultPayload?.earnedPoints,
        redeemedPoints: resultPayload?.redeemedPoints,
      });
      res.status(201).json({ ok: true, loyalty: resultPayload });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('POS loyalty sale failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to apply loyalty sale.');
      res.status(status).json({ error: publicError.message });
    }
  }
);
