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
const loyaltyFormula = require('./loyaltyFormula');
const promotionsEngine = require('./promotions/engine');

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
const POS_APK_FILE_NAME = 'eden-pos-1.24-v25-release.apk';
const POS_APK_VERSION_NAME = '1.24';
const POS_APK_VERSION_CODE = '25';
const POS_APK_SHA256 = '2CF1E0B0B4E6213A0C55D31B5C01BBB8C6270954E0F69E817681611139372C7E';
const POS_APK_APP_ID = 'com.personal.pos';
const POS_APK_DEFAULT_RELEASE_ID = 'eden-pos-1.24-v25';
const POS_APK_DEFAULT_CHANNEL = 'test';
const POS_APK_RELEASES_COLLECTION = 'pos_apk_releases';
const POS_UPDATE_EVENTS_COLLECTION = 'pos_update_events';
const POS_DEVICES_COLLECTION = 'pos_devices';
const POS_RELEASE_CHANNELS = new Set(['test', 'pilot', 'production']);
const POS_RELEASE_STATUSES = new Set(['draft', 'active', 'revoked']);
const POS_UPDATE_EVENTS = new Set(['downloaded', 'install_started', 'installed', 'failed']);
const POS_APK_REMOTE_ALLOWED_HOST_SUFFIXES = [
  'edencafe.co',
  '.edencafe.co',
];
const ARCHERY_SERVICE_TYPE = 'ARCHERY';
const ARCHERY_RESOURCE_TYPE_ID = 'ARCHERY_LANE';
const ARCHERY_LANE_COUNT = 10;
const ARCHERY_SLOT_MINUTES = 15;
const ARCHERY_HOLD_MINUTES = 10;
const ARCHERY_OPEN_MINUTES = 10 * 60;
const ARCHERY_CLOSE_MINUTES = 20 * 60;
const ARCHERY_PACKAGE_PRICES = new Map([
  [60, 350],
  [120, 600],
  [180, 800],
]);
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
  'https://localhost',
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
  if (
    ALLOWED_ORIGINS.has(origin)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Request-Id,X-Eden-System-Key');
  res.set('Access-Control-Expose-Headers', 'Content-Disposition,Content-Length,X-Eden-Release-Id,X-Eden-Apk-Version-Name,X-Eden-Apk-Version-Code,X-Eden-Apk-Sha256,X-Eden-Apk-Origin');
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
  return checkRateLimitKey(key, maxRequests, windowMs, now);
}

function checkRateLimitKey(key, maxRequests, windowMs, now = Date.now()) {
  const bucket = RATE_LIMIT_BUCKETS.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    const nextBucket = { count: 1, expiresAt: now + windowMs };
    RATE_LIMIT_BUCKETS.set(key, nextBucket);
    return {
      retryAfterSeconds: Math.ceil(windowMs / 1000),
      refund() {
        const current = RATE_LIMIT_BUCKETS.get(key);
        if (current !== nextBucket) return;
        current.count = Math.max(0, current.count - 1);
        if (current.count === 0) RATE_LIMIT_BUCKETS.delete(key);
      },
    };
  }
  if (bucket.count >= maxRequests) {
    const error = new Error('Too many requests');
    error.statusCode = 429;
    error.publicMessage = 'ขอ OTP บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
    error.retryAfterSeconds = Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000));
    throw error;
  }
  bucket.count += 1;
  return {
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
    refund() {
      const current = RATE_LIMIT_BUCKETS.get(key);
      if (current !== bucket) return;
      current.count = Math.max(0, current.count - 1);
      if (current.count === 0) RATE_LIMIT_BUCKETS.delete(key);
    },
  };
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
const PAGE_PERFORMANCE_EVENTS_COLLECTION = 'page_performance_events';
const PAGE_TELEMETRY_TYPES = new Set([
  'page_watchdog_15s',
  'slow_ready',
  'js_error',
  'unhandled_rejection',
  'register_otp',
  'custom',
]);

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

function telemetryBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }
  return {};
}

function safeTelemetryType(value) {
  const type = cleanString(value || '', 80);
  return PAGE_TELEMETRY_TYPES.has(type) ? type : 'custom';
}

function safeTelemetryPath(value) {
  const raw = cleanString(value || '/', 240);
  const pathOnly = raw.split('?')[0].split('#')[0] || '/';
  return pathOnly.startsWith('/') ? pathOnly : '/' + pathOnly;
}

function safeTelemetrySignals(value = {}) {
  const signals = value && typeof value === 'object' ? value : {};
  const busyTargets = Array.isArray(signals.busyTargets)
    ? signals.busyTargets.map(item => cleanString(item, 160)).filter(Boolean).slice(0, 8)
    : [];
  const htmlClasses = Array.isArray(signals.htmlClasses)
    ? signals.htmlClasses.map(item => cleanString(item, 80)).filter(Boolean).slice(0, 8)
    : [];
  return {
    busyCount: Math.max(0, Math.min(200, Number(signals.busyCount) || 0)),
    busyTargets,
    htmlClasses,
    adminTab: cleanString(signals.adminTab || '', 80),
  };
}

function safeTelemetryDetails(value = {}) {
  const details = value && typeof value === 'object' ? value : {};
  return {
    label: cleanString(details.label || '', 120),
    message: cleanString(details.message || '', 220),
    source: cleanString(details.source || '', 180),
    line: Math.max(0, Math.min(1000000, Number(details.line) || 0)),
    column: Math.max(0, Math.min(1000000, Number(details.column) || 0)),
    watchdogMs: Math.max(0, Math.min(120000, Number(details.watchdogMs) || 0)),
    stage: cleanString(details.stage || '', 80),
    errorCode: cleanString(details.errorCode || details.code || '', 80),
    phoneLast4: cleanString(details.phoneLast4 || '', 12).replace(/\D/g, '').slice(-4),
    hasConfirmationResult: details.hasConfirmationResult === true,
    attemptAgeMs: Math.max(0, Math.min(30 * 60 * 1000, Number(details.attemptAgeMs) || 0)),
    firebaseProvider: cleanString(details.firebaseProvider || '', 100),
    authMode: cleanString(details.authMode || '', 40),
    status: Math.max(0, Math.min(999, Number(details.status) || 0)),
    recoverable: details.recoverable === true,
  };
}

function normalizeTelemetryPayload(body = {}, req) {
  const viewport = body.viewport && typeof body.viewport === 'object' ? body.viewport : {};
  return {
    type: safeTelemetryType(body.type),
    path: safeTelemetryPath(body.path),
    title: cleanString(body.title || '', 160),
    durationMs: Math.max(0, Math.min(10 * 60 * 1000, Number(body.durationMs) || 0)),
    readyState: cleanString(body.readyState || '', 40),
    visibilityState: cleanString(body.visibilityState || '', 40),
    viewport: {
      width: Math.max(0, Math.min(10000, Number(viewport.width) || 0)),
      height: Math.max(0, Math.min(10000, Number(viewport.height) || 0)),
    },
    signals: safeTelemetrySignals(body.signals),
    details: safeTelemetryDetails(body.details),
    origin: cleanString(req.get('origin') || '', 160),
    userAgentHash: sha256(req.get('user-agent') || '').slice(0, 32),
    ipHash: sha256(clientIp(req)).slice(0, 32),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    date: bangkokDateKey(),
  };
}

exports.reportPageTelemetry = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('X-Content-Type-Options', 'nosniff');

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'page-telemetry', 240, 15 * 60 * 1000);
      const payload = normalizeTelemetryPayload(telemetryBody(req), req);
      await db.collection(PAGE_PERFORMANCE_EVENTS_COLLECTION).add(payload);
      if (payload.type === 'page_watchdog_15s') {
        logger.warn('Page watchdog telemetry received', {
          path: payload.path,
          durationMs: payload.durationMs,
          busyCount: payload.signals.busyCount,
          adminTab: payload.signals.adminTab,
        });
      }
      if (payload.type === 'register_otp' && /fail$/i.test(payload.details.stage || '')) {
        logger.warn('Register OTP telemetry failure received', {
          path: payload.path,
          stage: payload.details.stage,
          errorCode: payload.details.errorCode,
          status: payload.details.status,
          phoneLast4: payload.details.phoneLast4,
          attemptAgeMs: payload.details.attemptAgeMs,
          hasConfirmationResult: payload.details.hasConfirmationResult,
        });
      }
      res.status(204).send('');
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Page telemetry report failed', { message: error.message, status });
      res.status(status).json({ error: 'Unable to record telemetry' });
    }
  }
);

function toSafeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function normalizePosChannel(value) {
  const channel = cleanString(value || POS_APK_DEFAULT_CHANNEL, 30).toLowerCase();
  return POS_RELEASE_CHANNELS.has(channel) ? channel : POS_APK_DEFAULT_CHANNEL;
}

function normalizePosReleaseStatus(value, fallback = 'draft') {
  const status = cleanString(value || fallback, 30).toLowerCase();
  return POS_RELEASE_STATUSES.has(status) ? status : fallback;
}

function normalizeSha256(value) {
  return cleanString(value || '', 80).replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function posRequestPayload(req) {
  if (req.method === 'GET') return req.query || {};
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function defaultPosApkRelease() {
  const filePath = path.join(__dirname, 'assets', POS_APK_FILE_NAME);
  const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  return {
    id: POS_APK_DEFAULT_RELEASE_ID,
    appId: POS_APK_APP_ID,
    versionName: POS_APK_VERSION_NAME,
    versionCode: toSafeInt(POS_APK_VERSION_CODE),
    channel: POS_APK_DEFAULT_CHANNEL,
    status: 'active',
    sha256: normalizeSha256(POS_APK_SHA256),
    size,
    functionAsset: POS_APK_FILE_NAME,
    storagePath: `functions/assets/${POS_APK_FILE_NAME}`,
    releaseNotes: 'Eden POS APK 1.24 / versionCode 25 with POS history sync and WebView-safe money formatting.',
    minSupportedVersionCode: 0,
    forceUpdate: false,
    createdBy: 'system',
  };
}

function currentPosApkAssetSize() {
  const filePath = path.join(__dirname, 'assets', POS_APK_FILE_NAME);
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

function normalizePosApkRelease(id, data = {}) {
  const versionCode = toSafeInt(data.versionCode);
  const appId = cleanString(data.appId || POS_APK_APP_ID, 120);
  const versionName = cleanString(data.versionName || '', 40);
  const sha256Value = normalizeSha256(data.sha256);

  const release = {
    id,
    appId,
    versionName,
    versionCode,
    channel: normalizePosChannel(data.channel),
    status: normalizePosReleaseStatus(data.status, 'draft'),
    sha256: sha256Value,
    size: toSafeInt(data.size),
    storagePath: cleanString(data.storagePath || '', 300),
    functionAsset: cleanString(data.functionAsset || data.assetReference || '', 180),
    releaseNotes: cleanString(data.releaseNotes || '', 4000),
    minSupportedVersionCode: toSafeInt(data.minSupportedVersionCode),
    forceUpdate: data.forceUpdate === true,
    createdBy: cleanString(data.createdBy || '', 160),
    createdAt: data.createdAt || null,
  };

  const assetRef = release.functionAsset || release.storagePath || '';
  const assetName = path.basename(assetRef);
  const isDefaultFunctionAsset = (
    release.functionAsset === POS_APK_FILE_NAME
    || release.storagePath === `functions/assets/${POS_APK_FILE_NAME}`
  );
  if (
    release.appId === POS_APK_APP_ID
    && release.channel === POS_APK_DEFAULT_CHANNEL
    && release.versionCode === toSafeInt(POS_APK_VERSION_CODE)
    && assetName === POS_APK_FILE_NAME
    && isDefaultFunctionAsset
  ) {
    return {
      ...release,
      sha256: normalizeSha256(POS_APK_SHA256),
      size: currentPosApkAssetSize(),
    };
  }

  return release;
}

function publicPosReleasePayload(release, currentVersionCode = 0) {
  const forceUpdate = release.forceUpdate || (
    release.minSupportedVersionCode > 0
    && currentVersionCode < release.minSupportedVersionCode
  );
  return {
    releaseId: release.id,
    appId: release.appId,
    versionName: release.versionName,
    versionCode: release.versionCode,
    channel: release.channel,
    sha256: release.sha256,
    size: release.size,
    releaseNotes: release.releaseNotes,
    minSupportedVersionCode: release.minSupportedVersionCode,
    forceUpdate,
  };
}

async function loadPosApkReleases(appId, channel) {
  const releases = [];
  const snap = await db.collection(POS_APK_RELEASES_COLLECTION)
    .where('appId', '==', appId)
    .get();

  snap.forEach(docSnap => {
    releases.push(normalizePosApkRelease(docSnap.id, docSnap.data() || {}));
  });

  if (appId === POS_APK_APP_ID && channel === POS_APK_DEFAULT_CHANNEL) {
    releases.push(defaultPosApkRelease());
  }

  const matching = releases.filter(release =>
    release.appId === appId
    && release.channel === channel
    && release.status === 'active'
    && release.versionCode > 0
    && release.versionName
    && release.sha256.length === 64
  );

  return matching.sort((a, b) => {
    const versionOrder = b.versionCode - a.versionCode;
    if (versionOrder) return versionOrder;
    const aIsFunctionAsset = a.functionAsset === POS_APK_FILE_NAME ? 1 : 0;
    const bIsFunctionAsset = b.functionAsset === POS_APK_FILE_NAME ? 1 : 0;
    return bIsFunctionAsset - aIsFunctionAsset;
  });
}

async function findPosApkRelease({ appId = POS_APK_APP_ID, channel = POS_APK_DEFAULT_CHANNEL, releaseId = '', versionCode = 0 }) {
  const safeAppId = cleanString(appId || POS_APK_APP_ID, 120);
  const safeChannel = normalizePosChannel(channel);
  const safeReleaseId = cleanString(releaseId || '', 160);
  const safeVersionCode = toSafeInt(versionCode);

  if (safeReleaseId) {
    const snap = await db.collection(POS_APK_RELEASES_COLLECTION).doc(safeReleaseId).get();
    if (snap.exists) return normalizePosApkRelease(snap.id, snap.data() || {});
    if (safeReleaseId === POS_APK_DEFAULT_RELEASE_ID) return defaultPosApkRelease();
  }

  const releases = await loadPosApkReleases(safeAppId, safeChannel);
  if (safeVersionCode > 0) {
    return releases.find(release => release.versionCode === safeVersionCode) || null;
  }
  return releases[0] || null;
}

function isAllowedPosApkRemoteUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch (_) {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (!/\.apk$/i.test(parsed.pathname)) return false;

  const hostname = parsed.hostname.toLowerCase();
  return POS_APK_REMOTE_ALLOWED_HOST_SUFFIXES.some(suffix => (
    suffix.startsWith('.')
      ? hostname.endsWith(suffix)
      : hostname === suffix || hostname.endsWith(`.${suffix}`)
  ));
}

function posReleaseRemoteUrl(release) {
  const ref = cleanString(release.storagePath || '', 500);
  if (!/^https:\/\//i.test(ref)) return '';
  if (!isAllowedPosApkRemoteUrl(ref)) {
    const error = new Error('POS APK remote URL is not an allowed Spaceship origin');
    error.statusCode = 400;
    throw error;
  }
  return ref;
}

function posApkRemoteFetchHeaders() {
  const headers = { Accept: 'application/vnd.android.package-archive' };
  const username = cleanString(process.env.POS_APK_ORIGIN_BASIC_USERNAME || '', 180);
  const password = cleanString(process.env.POS_APK_ORIGIN_BASIC_PASSWORD || '', 500);

  if (username && password) {
    const basicToken = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    headers.Authorization = `Basic ${basicToken}`;
  }

  return headers;
}

function posReleaseAssetPath(release) {
  const ref = release.functionAsset || release.storagePath || POS_APK_FILE_NAME;
  if (/^https:\/\//i.test(ref)) {
    const error = new Error('Remote POS APK assets must be streamed by URL');
    error.statusCode = 500;
    throw error;
  }
  if (/^gs:\/\//i.test(ref)) {
    const error = new Error('Cloud Storage APK streaming is not wired for this release');
    error.statusCode = 501;
    throw error;
  }

  const fileName = path.basename(ref);
  if (!fileName || !/\.apk$/i.test(fileName)) {
    const error = new Error('Invalid APK asset reference');
    error.statusCode = 400;
    throw error;
  }

  return path.join(__dirname, 'assets', fileName);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex').toUpperCase()))
      .on('error', reject);
  });
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

async function requirePosUpdateAccess(req, body = {}) {
  const decoded = await requireAdminAccess(req, 'pos');
  const deviceId = cleanString(body.deviceId || '', 160);
  const appId = cleanString(body.appId || POS_APK_APP_ID, 120);

  if (deviceId) {
    const deviceSnap = await db.collection(POS_DEVICES_COLLECTION).doc(deviceId).get();
    if (deviceSnap.exists) {
      const device = deviceSnap.data() || {};
      const status = cleanString(device.status || 'active', 40).toLowerCase();
      if (['revoked', 'disabled', 'blocked'].includes(status)) {
        const error = new Error('POS device is not allowed to update');
        error.statusCode = 403;
        throw error;
      }
      if (device.appId && device.appId !== appId) {
        const error = new Error('POS device appId mismatch');
        error.statusCode = 403;
        throw error;
      }
    }
  }

  return { decoded, deviceId, appId };
}

async function touchPosDevice(deviceId, patch = {}) {
  if (!deviceId) return;
  await db.collection(POS_DEVICES_COLLECTION).doc(deviceId).set({
    ...patch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function streamPosApkRelease(req, res, release, decoded) {
  if (!release || release.status !== 'active') {
    const error = new Error('POS APK release is not active');
    error.statusCode = 404;
    throw error;
  }

  const remoteUrl = posReleaseRemoteUrl(release);
  let fileName = POS_APK_FILE_NAME;
  let byteLength = 0;
  let actualSha256 = '';
  let apkBuffer = null;
  let localFilePath = '';

  if (remoteUrl) {
    const response = await fetch(remoteUrl, {
      headers: posApkRemoteFetchHeaders(),
    });
    if (!response.ok) {
      const error = new Error(`POS APK remote origin returned HTTP ${response.status}`);
      error.statusCode = response.status === 404 ? 404 : 502;
      throw error;
    }
    const arrayBuffer = await response.arrayBuffer();
    apkBuffer = Buffer.from(arrayBuffer);
    byteLength = apkBuffer.length;
    actualSha256 = sha256Buffer(apkBuffer);
    fileName = path.basename(new URL(remoteUrl).pathname) || POS_APK_FILE_NAME;
  } else {
    localFilePath = posReleaseAssetPath(release);
    if (!fs.existsSync(localFilePath)) {
      const error = new Error('POS APK file is not available');
      error.statusCode = 404;
      throw error;
    }
    byteLength = fs.statSync(localFilePath).size;
    actualSha256 = await sha256File(localFilePath);
    fileName = path.basename(localFilePath);
  }

  if (release.sha256 && release.sha256 !== actualSha256) {
    const error = new Error('POS APK SHA256 does not match release manifest');
    error.statusCode = 409;
    throw error;
  }
  if (release.size > 0 && release.size !== byteLength) {
    const error = new Error('POS APK size does not match release manifest');
    error.statusCode = 409;
    throw error;
  }

  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Content-Type', 'application/vnd.android.package-archive');
  res.set('Content-Disposition', `attachment; filename="${fileName}"`);
  res.set('Content-Length', String(byteLength));
  res.set('X-Eden-Release-Id', release.id);
  res.set('X-Eden-Apk-Version-Name', release.versionName);
  res.set('X-Eden-Apk-Version-Code', String(release.versionCode));
  res.set('X-Eden-Apk-Sha256', actualSha256);
  res.set('X-Eden-Apk-Origin', remoteUrl ? 'spaceship' : 'function-asset');
  res.set('X-Content-Type-Options', 'nosniff');

  logger.info('Protected POS APK release download started', {
    uid: decoded.uid || '',
    email: decoded.email || '',
    releaseId: release.id,
    versionCode: release.versionCode,
    bytes: byteLength,
    origin: remoteUrl ? 'spaceship' : 'function-asset',
  });

  if (apkBuffer) {
    res.end(apkBuffer);
    return;
  }

  fs.createReadStream(localFilePath)
    .on('error', error => {
      logger.error('Protected POS APK stream failed', { message: error.message, releaseId: release.id });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Unable to stream POS APK' });
        return;
      }
      res.end();
    })
    .pipe(res);
}

exports.checkPosApkUpdate = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 60, memory: '512MiB' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (!['GET', 'POST'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const body = posRequestPayload(req);
      const { decoded, deviceId, appId } = await requirePosUpdateAccess(req, body);
      checkRateLimitKey(`check-pos-apk-update:${decoded.uid || clientIp(req)}:${deviceId || 'no-device'}`, 60, 15 * 60 * 1000);

      const channel = normalizePosChannel(body.channel);
      const currentVersionCode = toSafeInt(body.currentVersionCode);
      const releases = await loadPosApkReleases(appId, channel);
      const latest = releases.find(release => release.versionCode > currentVersionCode) || null;

      await touchPosDevice(deviceId, {
        appId,
        channel,
        status: 'active',
        currentVersionCode,
        lastSeenUid: decoded.uid || '',
        lastSeenEmail: decoded.email || '',
        lastUpdateCheckAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (!latest) {
        res.status(200).json({
          updateAvailable: false,
          appId,
          channel,
          currentVersionCode,
        });
        return;
      }

      res.status(200).json({
        updateAvailable: true,
        currentVersionCode,
        ...publicPosReleasePayload(latest, currentVersionCode),
      });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('POS APK update check failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to check POS APK update');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.downloadPosApkRelease = onRequest(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (!['GET', 'POST'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const body = posRequestPayload(req);
      const { decoded, deviceId, appId } = await requirePosUpdateAccess(req, body);
      checkRateLimitKey(`download-pos-apk-release:${decoded.uid || clientIp(req)}:${deviceId || 'no-device'}`, 20, 60 * 60 * 1000);

      const release = await findPosApkRelease({
        appId,
        channel: body.channel,
        releaseId: body.releaseId,
        versionCode: body.versionCode,
      });
      if (!release || release.appId !== appId || release.status !== 'active') {
        const error = new Error('POS APK release is not available');
        error.statusCode = 404;
        throw error;
      }

      await touchPosDevice(deviceId, {
        appId,
        channel: release.channel,
        targetVersionCode: release.versionCode,
        lastDownloadStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await streamPosApkRelease(req, res, release, decoded);
    } catch (error) {
      const isTokenError = /Firebase ID token|verify ID token|Decoding Firebase|jwt/i.test(error.message || '');
      const status = error.statusCode || (isTokenError ? 401 : 500);
      logger.warn('Protected POS APK release download denied', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to download POS APK release');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.reportPosUpdateEvent = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 60, memory: '256MiB' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const body = posRequestPayload(req);
      const { decoded, deviceId, appId } = await requirePosUpdateAccess(req, body);
      checkRateLimitKey(`report-pos-update-event:${decoded.uid || clientIp(req)}:${deviceId || 'no-device'}`, 240, 60 * 60 * 1000);

      const event = cleanString(body.event || '', 40).toLowerCase();
      if (!POS_UPDATE_EVENTS.has(event)) {
        const error = new Error('Invalid POS update event');
        error.statusCode = 400;
        throw error;
      }

      const releaseId = cleanString(body.releaseId || '', 160);
      const targetVersionCode = toSafeInt(body.targetVersionCode || body.versionCode);
      const currentVersionCode = toSafeInt(body.currentVersionCode);
      const channel = normalizePosChannel(body.channel);
      const eventPayload = {
        appId,
        channel,
        deviceId,
        event,
        releaseId,
        currentVersionCode,
        targetVersionCode,
        versionName: cleanString(body.versionName || '', 40),
        sha256: normalizeSha256(body.sha256 || ''),
        size: toSafeInt(body.size),
        message: cleanString(body.message || body.errorMessage || '', 800),
        uid: decoded.uid || '',
        email: decoded.email || '',
        userAgentHash: sha256(req.get('user-agent') || '').slice(0, 32),
        ipHash: sha256(clientIp(req)).slice(0, 32),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const eventRef = await db.collection(POS_UPDATE_EVENTS_COLLECTION).add(eventPayload);
      await touchPosDevice(deviceId, {
        appId,
        channel,
        currentVersionCode: event === 'installed' && targetVersionCode > 0 ? targetVersionCode : currentVersionCode,
        targetVersionCode,
        lastUpdateEvent: event,
        lastUpdateEventId: eventRef.id,
        lastUpdateReleaseId: releaseId,
        lastUpdateEventAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(201).json({ ok: true, id: eventRef.id });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('POS update event report failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to report POS update event');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.downloadPosApk = onRequest(
  {
    region: 'asia-southeast1',
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const decoded = await requireAdminAccess(req, 'pos');
      const channel = normalizePosChannel(req.query.channel);
      const release = await findPosApkRelease({
        appId: POS_APK_APP_ID,
        channel,
        releaseId: req.query.releaseId,
        versionCode: req.query.versionCode,
      });
      if (!release || release.appId !== POS_APK_APP_ID || release.status !== 'active') {
        res.status(404).json({ error: 'POS APK release is not available' });
        return;
      }
      await streamPosApkRelease(req, res, release, decoded);
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
  if (ADMIN_EMAILS.has(email)) return decoded;

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
  const email = String(decoded.email || '').trim().toLowerCase();
  if (ADMIN_EMAILS.has(email)) return decoded;

  const accessSnap = await db.collection('admin_users').doc(decoded.uid).get();
  const access = accessSnap.exists ? accessSnap.data() || {} : {};
  if (access.status === 'active' && access.role === 'owner') return decoded;

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
  sendOtpEmail: async (email, code, options = {}) => {
    const from = safeSecretValue(SMTP_FROM, 180) || safeSecretValue(SMTP_USER, 180);
    const isPhoneRemoval = String(options?.purpose || '') === 'phone_removal';
    const phoneRemovalMail = isPhoneRemoval ? {
      subject: 'Eden Cafe phone removal OTP',
      text: `Your Eden Cafe OTP for removing your account phone number is ${code}. This code expires in 5 minutes.`,
      html: [
        '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#123526;">',
        '<h2 style="margin:0 0 12px;">Eden Cafe phone removal</h2>',
        '<p>Use this OTP to remove the phone number from your Eden Cafe member account.</p>',
        `<div style="font-size:32px;font-weight:700;letter-spacing:0.18em;background:#f2fbf3;border-radius:14px;padding:18px 22px;display:inline-block;">${code}</div>`,
        '<p>This code expires in 5 minutes. If you did not request this, please ignore this email and keep your account password secure.</p>',
        '</div>',
      ].join(''),
    } : null;
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
      ...(phoneRemovalMail || {}),
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
  { region: 'asia-southeast1', minInstances: 1, memory: '256MiB' },
  memberAuthHandlers.getMyProfile
);

exports.updateMyProfile = onRequest(
  { region: 'asia-southeast1' },
  memberAuthHandlers.updateMyProfile
);

function normalizeMyActivityLimit(value, fallback = 20, max = 50) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

function encodeMyActivityCursor(timestampMs = 0) {
  const value = Math.max(0, Math.floor(Number(timestampMs) || 0));
  if (!value) return '';
  return Buffer.from(JSON.stringify({ before: value }))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeMyActivityCursor(value = '') {
  const text = cleanString(value, 300);
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
    return Math.max(0, Math.floor(Number(payload.before || payload.timestamp || 0) || 0));
  } catch (_) {
    return 0;
  }
}

function serializeMyActivityValue(value) {
  if (!value) return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeMyActivityValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeMyActivityValue(item)])
    );
  }
  return value;
}

function serializeMyActivityDoc(docSnap) {
  const data = serializeMyActivityValue(docSnap.data() || {});
  return {
    id: data.id || docSnap.id,
    firestoreId: docSnap.id,
    ...data,
  };
}

function myActivityTimestamp(record = {}) {
  return timestampMillis(
    record.paidAt
    || record.closedAt
    || record.completedAt
    || record.timestamp
    || record.createdAt
    || record.updatedAt
    || record.booking_date
    || record.date
  );
}

async function queryMemberActivityCollection({ collectionName, uid, fields, orderField, beforeMs, limitCount }) {
  const querySize = Math.min(Math.max(limitCount * 2, limitCount + 3), 80);
  const seen = new Map();

  await Promise.all(fields.map(async fieldName => {
    let queryRef = db.collection(collectionName).where(fieldName, '==', uid);
    if (orderField && beforeMs > 0) {
      queryRef = queryRef.where(orderField, '<', admin.firestore.Timestamp.fromMillis(beforeMs));
    }
    if (orderField) queryRef = queryRef.orderBy(orderField, 'desc');
    queryRef = queryRef.limit(querySize);

    let snap = null;
    try {
      snap = await queryRef.get();
    } catch (error) {
      logger.warn('Member activity ordered query failed; falling back to limited equality query', {
        collectionName,
        fieldName,
        orderField,
        message: error.message,
      });
      snap = await db.collection(collectionName)
        .where(fieldName, '==', uid)
        .limit(querySize)
        .get();
    }

    snap.docs.forEach(docSnap => {
      if (!seen.has(docSnap.id)) seen.set(docSnap.id, serializeMyActivityDoc(docSnap));
    });
  }));

  return Array.from(seen.values())
    .filter(record => !beforeMs || myActivityTimestamp(record) < beforeMs)
    .sort((a, b) => myActivityTimestamp(b) - myActivityTimestamp(a));
}

async function getMyActivityPayload(uid, options = {}) {
  const limitCount = normalizeMyActivityLimit(options.limit, 20, 50);
  const ledgerLimit = normalizeMyActivityLimit(options.ledgerLimit, 8, 20);
  const beforeMs = decodeMyActivityCursor(options.cursor || '');

  const [orders, bookings, configSnap, summarySnap, ledgerRows] = await Promise.all([
    queryMemberActivityCollection({
      collectionName: 'orders',
      uid,
      fields: ['customerUid', 'uid'],
      orderField: 'timestamp',
      beforeMs,
      limitCount,
    }),
    queryMemberActivityCollection({
      collectionName: 'bookings',
      uid,
      fields: ['uid', 'customerUid', 'member_id'],
      orderField: 'timestamp',
      beforeMs,
      limitCount,
    }),
    db.collection('site_settings').doc('loyalty').get().catch(() => null),
    db.collection('member_summaries').doc(uid).get().catch(() => null),
    queryMemberActivityCollection({
      collectionName: 'point_ledger',
      uid,
      fields: ['userId'],
      orderField: 'createdAt',
      beforeMs: 0,
      limitCount: ledgerLimit,
    }),
  ]);

  const filteredOrders = orders
    .filter(order => {
      if (order.isTestOrder === true) return false;
      const customerUid = cleanString(order.customerUid || '', 160);
      const orderUid = cleanString(order.uid || '', 160);
      const source = cleanString(order.source || '', 30).toLowerCase();
      return customerUid ? customerUid === uid : (orderUid === uid && source !== 'pos');
    })
    .slice(0, limitCount);
  const filteredBookings = bookings.slice(0, limitCount);
  const activity = [
    ...filteredOrders.map(item => ({ kind: 'order', timestamp: myActivityTimestamp(item), item })),
    ...filteredBookings.map(item => ({ kind: 'booking', timestamp: myActivityTimestamp(item), item })),
  ].sort((a, b) => b.timestamp - a.timestamp);
  const pageItems = activity.slice(0, limitCount);
  const lastTimestamp = pageItems.length ? pageItems[pageItems.length - 1].timestamp : 0;

  return {
    ok: true,
    uid,
    limit: limitCount,
    cursor: cleanString(options.cursor || '', 300),
    nextCursor: activity.length > limitCount ? encodeMyActivityCursor(lastTimestamp) : '',
    orders: filteredOrders,
    bookings: filteredBookings,
    activity: pageItems.map(row => ({
      kind: row.kind,
      timestamp: row.timestamp,
      item: row.item,
    })),
    loyaltyConfig: configSnap?.exists ? serializeMyActivityValue(configSnap.data() || {}) : null,
    loyaltySummary: summarySnap?.exists ? serializeMyActivityValue(summarySnap.data() || {}) : null,
    loyaltyLedger: ledgerRows.slice(0, ledgerLimit),
  };
}

exports.getMyActivity = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const decoded = await requireSignedInUser(req);
      checkRateLimitKey(`get-my-activity:${decoded.uid}`, 180, 60 * 60 * 1000);
      const input = req.method === 'GET' ? (req.query || {}) : (req.body || {});
      const payload = await getMyActivityPayload(decoded.uid, input);
      res.status(200).json(payload);
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Member activity fetch failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to load member activity');
      res.status(status).json({ error: publicError.message });
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

exports.requestPhoneRemovalOtp = onRequest(
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
  memberAuthHandlers.requestPhoneRemovalOtp
);

exports.verifyPhoneRemovalOtp = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [AUTH_OTP_PEPPER],
  },
  memberAuthHandlers.verifyPhoneRemovalOtp
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
    'business',
    'index',
    'footer',
  ];
  const all = Object.fromEntries(allowed.map(key => [key, true]));
  if (role === 'owner' || role === 'head_manager') return all;
  return Object.fromEntries(allowed.map(key => [key, raw && raw[key] === true]));
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
    usersByLoginUsername,
    credentialsByPhone,
  ] = await Promise.all([
    db.collection('phone_number_index').doc(phoneKey).get(),
    db.collection('users').where('phone_number', '==', normalizedPhone).limit(10).get(),
    db.collection('users').where('phoneE164', '==', normalizedPhone).limit(10).get(),
    db.collection('users').where('phone', '==', phoneDisplay).limit(10).get(),
    db.collection('users').where('loginUsername', '==', phoneDisplay).limit(10).get(),
    db.collection('user_credentials').where('phone_number', '==', normalizedPhone).limit(10).get(),
  ]);

  return uniqueCleanStrings([
    phoneIndexSnap.exists ? phoneIndexSnap.data()?.uid : '',
    ...usersByPhoneNumber.docs.map(doc => doc.id),
    ...usersByPhoneE164.docs.map(doc => doc.id),
    ...usersByPhoneDisplay.docs.map(doc => doc.id),
    ...usersByLoginUsername.docs.map(doc => doc.id),
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

function memberMergeBalance(row = {}) {
  const summary = row.summary || {};
  const user = row.user || {};
  if (summary.pointsBalance !== undefined) return safeMergeInteger(summary.pointsBalance);
  return safeMergeInteger(user.points);
}

function memberMergeSnapshot(row = {}) {
  const user = row.user || {};
  const summary = row.summary || {};
  const credential = row.credential || {};
  return {
    uid: row.uid,
    userExists: row.userExists === true,
    credentialExists: row.credentialExists === true,
    summaryExists: row.summaryExists === true,
    email: memberEmailFromData(user) || normalizePublicEmail(credential.email_lower || ''),
    phoneLast4: (memberPhoneFromData(user) || normalizeThaiPhoneForMemberIndex(credential.phone_number || '') || '').slice(-4) || null,
    pointsBalance: memberMergeBalance(row),
    totalSpent: mergeAccountMetric(row, 'totalSpent'),
    visitCount: mergeAccountIntegerMetric(row, 'visitCount'),
    orderCount: mergeAccountIntegerMetric(row, 'orderCount'),
    bookingCount: mergeAccountIntegerMetric(row, 'bookingCount'),
    hasPasswordHash: credentialHasPassword(credential),
  };
}

async function loadMergeMemberRow(uid) {
  const safeUid = cleanString(uid, 160);
  const [userSnap, credentialSnap, summarySnap] = await Promise.all([
    db.collection('users').doc(safeUid).get(),
    db.collection('user_credentials').doc(safeUid).get(),
    db.collection('member_summaries').doc(safeUid).get(),
  ]);
  return {
    uid: safeUid,
    userExists: userSnap.exists,
    credentialExists: credentialSnap.exists,
    summaryExists: summarySnap.exists,
    user: userSnap.exists ? userSnap.data() || {} : {},
    credential: credentialSnap.exists ? credentialSnap.data() || {} : {},
    summary: summarySnap.exists ? summarySnap.data() || {} : {},
  };
}

function mergeMemberField(rows = [], fieldNames = [], maxLength = 180) {
  const values = [];
  for (const row of rows) {
    for (const fieldName of fieldNames) {
      values.push(row.user?.[fieldName], row.summary?.[fieldName], row.credential?.[fieldName]);
    }
  }
  return firstCleanString(values, maxLength);
}

function mergeMemberEmail(rows = [], requestedEmail = '') {
  return normalizePublicEmail(requestedEmail)
    || normalizePublicEmail(mergeMemberField(rows, ['email', 'email_lower', 'memberEmail'], 180));
}

function mergeMemberPhone(rows = [], requestedPhone = '') {
  const candidates = [requestedPhone];
  for (const row of rows) {
    candidates.push(
      row.user?.phone_number,
      row.user?.phoneE164,
      row.user?.phone,
      row.user?.loginUsername,
      row.credential?.phone_number
    );
  }
  for (const value of candidates) {
    const phone = normalizeThaiPhoneForMemberIndex(value);
    if (phone) return phone;
  }
  return '';
}

function buildMergedMemberPayload(primaryUid, rows = [], email = '', phoneNumber = '', auditId = '') {
  const primaryRow = rows.find(row => row.uid === primaryUid) || rows[0] || {};
  const primaryUser = primaryRow.user || {};
  const primarySummary = primaryRow.summary || {};
  const displayName = mergeMemberField(rows, ['displayName', 'display_name', 'name', 'customerName', 'memberName'], 120)
    || (email ? email.split('@')[0] : 'Eden Member');
  const avatarUrl = mergeMemberField(rows, ['photoURL', 'avatar_url', 'avatar'], 500);
  const mergedPoints = rows.reduce((sum, row) => sum + memberMergeBalance(row), 0);
  const totalSpent = rows.reduce((sum, row) => sum + Math.max(0, mergeAccountMetric(row, 'totalSpent')), 0);
  const visitCount = rows.reduce((sum, row) => sum + mergeAccountIntegerMetric(row, 'visitCount'), 0);
  const orderCount = rows.reduce((sum, row) => sum + mergeAccountIntegerMetric(row, 'orderCount'), 0);
  const bookingCount = rows.reduce((sum, row) => sum + mergeAccountIntegerMetric(row, 'bookingCount'), 0);
  const lifetimePoints = rows.reduce((sum, row) => sum + Math.max(0, mergeAccountMetric(row, 'lifetimePoints')), 0);
  const totalRedeemed = rows.reduce((sum, row) => sum + Math.max(0, mergeAccountMetric(row, 'totalRedeemed')), 0);
  const totalManualDeducted = rows.reduce((sum, row) => sum + Math.max(0, mergeAccountMetric(row, 'totalManualDeducted')), 0);
  const tier = memberTierFromMetrics(mergedPoints, totalSpent, visitCount);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const authProviderIds = uniqueArray(rows.flatMap(row => row.user?.authProviderIds || []), 80);
  const mergedFromUids = uniqueArray([
    ...(Array.isArray(primaryUser.mergedFromUids) ? primaryUser.mergedFromUids : []),
    ...rows.filter(row => row.uid !== primaryUid).map(row => row.uid),
  ]);
  const mergeAuditIds = uniqueArray([
    ...(Array.isArray(primaryUser.mergeAuditIds) ? primaryUser.mergeAuditIds : []),
    auditId,
  ], 180);
  const createdAt = earliestTimestamp(rows.flatMap(row => [
    row.user?.createdAt,
    row.user?.created_at,
    row.user?.authCreatedAt,
    row.credential?.created_at,
  ]));
  const lastLoginAt = latestTimestamp(rows.flatMap(row => [
    row.user?.lastLoginAt,
    row.user?.last_login_at,
    row.credential?.last_login_at,
  ]));
  const phoneDisplay = phoneNumber ? displayThaiPhone(phoneNumber) : '';

  const userPayload = {
    uid: primaryUid,
    id: cleanString(primaryUser.id || primaryUid, 160),
    displayName,
    display_name: displayName,
    name: displayName,
    email,
    email_lower: email,
    photoURL: avatarUrl,
    avatar_url: avatarUrl,
    memberCode: cleanString(primaryUser.memberCode || authMemberCode(primaryUid), 80),
    member_level: tier,
    tier,
    points: mergedPoints,
    totalSpent,
    visitCount,
    orderCount,
    bookingCount,
    status: cleanString(primaryUser.status || 'active', 40) || 'active',
    adminNote: mergeMemberField(rows, ['adminNote'], 500),
    adminTags: uniqueArray(rows.flatMap(row => row.user?.adminTags || []), 80).slice(0, 30),
    authProviderIds,
    mergedFromUids,
    mergeAuditIds,
    lastMergedAt: now,
    loyaltyUpdatedAt: now,
    updatedAt: now,
    updated_at: now,
  };

  if (phoneNumber) {
    userPayload.phone_number = phoneNumber;
    userPayload.phone_display = phoneDisplay;
    userPayload.phone = phoneDisplay;
    userPayload.phoneE164 = phoneNumber;
    userPayload.loginUsername = phoneDisplay;
  }
  if (createdAt) {
    userPayload.createdAt = createdAt;
    userPayload.created_at = createdAt;
  }
  if (lastLoginAt) {
    userPayload.lastLoginAt = lastLoginAt;
    userPayload.last_login_at = lastLoginAt;
  }
  [
    ['firstName', ['firstName'], 80],
    ['lastName', ['lastName'], 80],
    ['shippingAddress', ['shippingAddress'], 500],
    ['birthDate', ['birthDate'], 20],
    ['allergies', ['allergies'], 200],
    ['healthNote', ['healthNote'], 500],
    ['lineId', ['lineId'], 80],
    ['registrationSource', ['registrationSource'], 80],
    ['googleAuthUid', ['googleAuthUid'], 160],
    ['phoneAuthEmail', ['phoneAuthEmail'], 180],
  ].forEach(([target, fields, maxLength]) => {
    const value = mergeMemberField(rows, fields, maxLength);
    if (value) userPayload[target] = value;
  });
  if (rows.some(row => row.user?.passwordLoginEnabled === true || row.user?.password_login_enabled === true || credentialHasPassword(row.credential))) {
    userPayload.passwordLoginEnabled = true;
    userPayload.password_login_enabled = true;
  }

  Object.keys(userPayload).forEach(key => {
    if (userPayload[key] === '' || userPayload[key] === undefined || userPayload[key] === null) delete userPayload[key];
  });

  const summaryPayload = {
    userId: primaryUid,
    memberCode: userPayload.memberCode,
    memberName: displayName,
    memberEmail: email,
    pointsBalance: mergedPoints,
    tier,
    lifetimePoints,
    totalRedeemed,
    totalManualDeducted,
    totalSpent,
    visitCount,
    orderCount,
    bookingCount,
    mergedFromUids,
    lastMergeAuditId: auditId,
    lastLedgerId: mergeMemberField(rows, ['lastLedgerId'], 180) || cleanString(primarySummary.lastLedgerId || '', 180),
    updatedAt: now,
  };
  Object.keys(summaryPayload).forEach(key => {
    if (summaryPayload[key] === '' || summaryPayload[key] === undefined || summaryPayload[key] === null) delete summaryPayload[key];
  });

  return { userPayload, summaryPayload, mergedPoints, totalSpent, visitCount, orderCount, bookingCount, tier };
}

function buildMergedCredentialPayload(primaryUid, rows = [], email = '', phoneNumber = '') {
  const primaryRow = rows.find(row => row.uid === primaryUid) || rows[0] || {};
  const primaryCredential = primaryRow.credential || {};
  const credentialRows = [primaryRow, ...rows.filter(row => row.uid !== primaryUid)];
  const passwordSource = credentialRows.find(row => credentialHasPassword(row.credential))?.credential || {};
  const phoneKey = phoneNumber ? memberPhoneIndexKey(phoneNumber) : '';
  const payload = {
    uid: primaryUid,
    email_lower: email,
    phone_number: phoneNumber,
    phone_index_key: phoneKey,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (passwordSource.password_hash) {
    payload.password_hash = cleanString(passwordSource.password_hash, 2000);
    payload.password_algorithm = cleanString(passwordSource.password_algorithm || primaryCredential.password_algorithm || 'scrypt', 80);
    if (passwordSource.created_at || primaryCredential.created_at) payload.created_at = passwordSource.created_at || primaryCredential.created_at;
  } else if (primaryCredential.created_at) {
    payload.created_at = primaryCredential.created_at;
  }
  Object.keys(payload).forEach(key => {
    if (payload[key] === '' || payload[key] === undefined || payload[key] === null) delete payload[key];
  });
  return payload;
}

async function commitMergeOperations(operations = []) {
  let batch = db.batch();
  let count = 0;
  let committed = 0;
  for (const operation of operations) {
    if (operation.type === 'delete') {
      batch.delete(operation.ref);
    } else if (operation.type === 'update') {
      batch.update(operation.ref, operation.data);
    } else {
      batch.set(operation.ref, operation.data, operation.options || { merge: true });
    }
    count += 1;
    if (count >= 450) {
      await batch.commit();
      committed += count;
      batch = db.batch();
      count = 0;
    }
  }
  if (count) {
    await batch.commit();
    committed += count;
  }
  return committed;
}

async function findMergeDocsByFields(collectionName, fields = [], duplicateUids = []) {
  const docsByPath = new Map();
  for (const uid of duplicateUids) {
    for (const field of fields) {
      const snap = await db.collection(collectionName).where(field, '==', uid).get();
      snap.docs.forEach(docSnap => docsByPath.set(docSnap.ref.path, docSnap));
    }
  }
  return Array.from(docsByPath.values());
}

function updateOrderMemberUidPayload(order = {}, duplicateUids = [], primaryUid = '', now, auditId = '') {
  const duplicateSet = new Set(duplicateUids);
  const source = cleanString(order.source || '', 40).toLowerCase();
  const update = {};
  if (duplicateSet.has(cleanString(order.customerUid || '', 160))) update.customerUid = primaryUid;
  if (duplicateSet.has(cleanString(order.userId || '', 160))) update.userId = primaryUid;
  if (duplicateSet.has(cleanString(order.memberUid || '', 160))) update.memberUid = primaryUid;
  if (duplicateSet.has(cleanString(order.uid || '', 160)) && source !== 'pos') update.uid = primaryUid;
  if (order.loyalty && typeof order.loyalty === 'object' && duplicateSet.has(cleanString(order.loyalty.customerUid || '', 160))) {
    update['loyalty.customerUid'] = primaryUid;
  }
  if (Object.keys(update).length) {
    update.memberMergedAt = now;
    update.memberMergeAuditId = auditId;
    update.updatedAt = now;
  }
  return update;
}

function updateBookingMemberUidPayload(booking = {}, duplicateUids = [], primaryUid = '', now, auditId = '') {
  const duplicateSet = new Set(duplicateUids);
  const update = {};
  ['uid', 'customerUid', 'userId', 'memberUid'].forEach(field => {
    if (duplicateSet.has(cleanString(booking[field] || '', 160))) update[field] = primaryUid;
  });
  if (Object.keys(update).length) {
    update.memberMergedAt = now;
    update.memberMergeAuditId = auditId;
    update.updatedAt = now;
  }
  return update;
}

function updatePointLedgerMemberPayload(ledger = {}, primaryUid = '', memberPayload = {}, now, auditId = '') {
  return {
    userId: primaryUid,
    memberCode: cleanString(memberPayload.memberCode || '', 80),
    memberName: cleanString(memberPayload.displayName || memberPayload.display_name || 'Eden Member', 160),
    memberEmail: cleanString(memberPayload.email || '', 180),
    mergedAt: now,
    memberMergeAuditId: auditId,
    mergedFromUid: cleanString(ledger.userId || '', 160),
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

function firstCleanString(values = [], maxLength = 180) {
  for (const value of values) {
    const text = cleanString(value, maxLength);
    if (text) return text;
  }
  return '';
}

function uniqueArray(values = [], maxLength = 160) {
  return Array.from(new Set(
    values
      .flatMap(value => Array.isArray(value) ? value : [value])
      .map(value => cleanString(value, maxLength))
      .filter(Boolean)
  ));
}

function safeMergeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeMergeInteger(value, fallback = 0) {
  return Math.max(0, Math.floor(safeMergeNumber(value, fallback)));
}

function mergeAccountMetric(row = {}, summaryField, userField = summaryField) {
  const summary = row.summary || {};
  const user = row.user || {};
  if (summary[summaryField] !== undefined) return safeMergeNumber(summary[summaryField], 0);
  return safeMergeNumber(user[userField], 0);
}

function mergeAccountIntegerMetric(row = {}, summaryField, userField = summaryField) {
  return Math.max(0, Math.floor(mergeAccountMetric(row, summaryField, userField)));
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function earliestTimestamp(values = []) {
  return values
    .filter(Boolean)
    .sort((a, b) => timestampMillis(a) - timestampMillis(b))[0] || null;
}

function latestTimestamp(values = []) {
  return values
    .filter(Boolean)
    .sort((a, b) => timestampMillis(b) - timestampMillis(a))[0] || null;
}

function permissionFromImageFolder(folder) {
  const value = cleanString(folder, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (value === 'index' || value === 'index_popup') return 'index';
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

function archeryLaneId(number) {
  return `LANE_${String(number).padStart(2, '0')}`;
}

function archeryLaneIds() {
  return Array.from({ length: ARCHERY_LANE_COUNT }, (_, index) => archeryLaneId(index + 1));
}

function normalizeArcheryLaneId(value = '') {
  const raw = cleanString(value, 20).toUpperCase();
  const match = raw.match(/^LANE_?(\d{1,2})$/);
  if (!match) return '';
  const laneNumber = Number(match[1]);
  if (!Number.isInteger(laneNumber) || laneNumber < 1 || laneNumber > ARCHERY_LANE_COUNT) return '';
  return archeryLaneId(laneNumber);
}

function archeryLaneNumber(laneId = '') {
  const match = String(laneId || '').match(/(\d{2})$/);
  return match ? Number(match[1]) : 0;
}

function minutesFromTime(value = '') {
  if (!isTime(value)) return null;
  const [hours, minutes] = String(value).split(':').map(Number);
  return (hours * 60) + minutes;
}

function timeFromMinutes(value) {
  const minutes = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function archeryTimestamp(date, time) {
  return admin.firestore.Timestamp.fromDate(new Date(`${date}T${time}:00+07:00`));
}

function archeryDateFromTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeArcheryPackageMinutes(value) {
  const minutes = Math.floor(Number(value) || 0);
  if (!ARCHERY_PACKAGE_PRICES.has(minutes)) {
    const error = new Error('Invalid archery package');
    error.statusCode = 400;
    throw error;
  }
  return minutes;
}

function normalizeArcheryTimePayload(raw = {}) {
  const date = cleanString(raw.date, 20);
  const startTime = cleanString(raw.start_time || raw.startTime || raw.time, 10);
  const packageMinutes = normalizeArcheryPackageMinutes(
    raw.package_minutes || raw.packageMinutes || raw.duration_minutes || raw.durationMinutes || raw.minutes
  );
  if (!isISODate(date) || !isTime(startTime)) {
    const error = new Error('Invalid archery date or time');
    error.statusCode = 400;
    throw error;
  }
  const startMinutes = minutesFromTime(startTime);
  const endMinutes = startMinutes + packageMinutes;
  if (
    startMinutes < ARCHERY_OPEN_MINUTES
    || endMinutes > ARCHERY_CLOSE_MINUTES
    || startMinutes % ARCHERY_SLOT_MINUTES !== 0
  ) {
    const error = new Error('Archery booking is outside operating hours');
    error.statusCode = 400;
    throw error;
  }
  return {
    date,
    startTime,
    endTime: timeFromMinutes(endMinutes),
    startMinutes,
    endMinutes,
    packageMinutes,
    amount: ARCHERY_PACKAGE_PRICES.get(packageMinutes) || 0,
  };
}

function archerySlotId(laneId, date, slotMinutes) {
  return `${laneId}_${date.replace(/-/g, '')}_${timeFromMinutes(slotMinutes).replace(':', '')}`;
}

function archerySlots(laneId, date, startMinutes, endMinutes) {
  const slots = [];
  for (let minute = startMinutes; minute < endMinutes; minute += ARCHERY_SLOT_MINUTES) {
    slots.push({
      id: archerySlotId(laneId, date, minute),
      startTime: timeFromMinutes(minute),
      endTime: timeFromMinutes(minute + ARCHERY_SLOT_MINUTES),
      startMinutes: minute,
      endMinutes: minute + ARCHERY_SLOT_MINUTES,
    });
  }
  return slots;
}

function isActiveArcheryLock(lock = {}, now = new Date()) {
  const status = cleanString(lock.status, 30).toUpperCase();
  if (status === 'HELD') {
    const expiresAt = archeryDateFromTimestamp(lock.hold_expires_at || lock.holdExpiresAt || lock.expiresAt);
    return !expiresAt || expiresAt.getTime() > now.getTime();
  }
  return ['CONFIRMED', 'CHECKED_IN'].includes(status);
}

function archeryPublicStatus(booking = {}) {
  const status = cleanString(booking.status || 'PENDING', 40).toUpperCase();
  const paymentStatus = cleanString(booking.payment_status || booking.paymentStatus || 'PENDING', 40).toUpperCase();
  if (status === 'CHECKED_IN') return 'Checked-in';
  if (status === 'COMPLETED') return 'Completed';
  if (status === 'CANCELLED') return 'Cancelled';
  if (status === 'NO_SHOW') return 'No Show';
  if (paymentStatus === 'PAID_ONLINE') return 'Paid Online';
  if (paymentStatus === 'PAID_COUNTER') return 'Paid Counter';
  return 'Pending';
}

function archeryLockRefs(laneId, date, startMinutes, endMinutes) {
  return archerySlots(laneId, date, startMinutes, endMinutes)
    .map(slot => ({
      ...slot,
      ref: db.collection('resource_locks').doc(slot.id),
    }));
}

async function findAvailableArcheryLane(transaction, timing, preferredLaneId = '') {
  const now = new Date();
  const candidates = preferredLaneId ? [preferredLaneId] : archeryLaneIds();
  for (const laneId of candidates) {
    const slots = archeryLockRefs(laneId, timing.date, timing.startMinutes, timing.endMinutes);
    const snaps = await Promise.all(slots.map(slot => transaction.get(slot.ref)));
    const conflict = snaps.find(snap => snap.exists && isActiveArcheryLock(snap.data() || {}, now));
    if (!conflict) return { laneId, slots };
  }
  const error = new Error('Selected archery lane is not available');
  error.statusCode = 409;
  throw error;
}

function writeArcheryResourceSeeds(transaction) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  transaction.set(db.collection('resource_types').doc(ARCHERY_RESOURCE_TYPE_ID), {
    id: ARCHERY_RESOURCE_TYPE_ID,
    service_type: ARCHERY_SERVICE_TYPE,
    name: 'Archery Lane',
    slot_minutes: ARCHERY_SLOT_MINUTES,
    updatedAt: now,
  }, { merge: true });
  archeryLaneIds().forEach(laneId => {
    transaction.set(db.collection('resources').doc(laneId), {
      id: laneId,
      service_type: ARCHERY_SERVICE_TYPE,
      resource_type_id: ARCHERY_RESOURCE_TYPE_ID,
      name: `Lane ${archeryLaneNumber(laneId)}`,
      lane_number: archeryLaneNumber(laneId),
      status: 'ACTIVE',
      updatedAt: now,
    }, { merge: true });
  });
}

function normalizeArcheryCustomer(raw = {}, decoded = {}) {
  return {
    name: cleanString(raw.customerName || raw.name || decoded.name || decoded.email || 'Eden Member', 120),
    phone: cleanString(raw.customerPhone || raw.phone || decoded.phone_number || '', 40),
    email: cleanString(raw.customerEmail || raw.email || decoded.email || '', 180).toLowerCase(),
    note: cleanString(raw.note || raw.customerNote || '', 500),
  };
}

async function loadArcheryMemberForAdmin(transaction, memberUid) {
  const userRef = db.collection('users').doc(memberUid);
  const summaryRef = db.collection('member_summaries').doc(memberUid);
  const [userSnap, summarySnap] = await Promise.all([
    transaction.get(userRef),
    transaction.get(summaryRef),
  ]);
  if (!userSnap.exists && !summarySnap.exists) {
    const error = new Error('Member does not exist');
    error.statusCode = 404;
    throw error;
  }
  return {
    user: userSnap.exists ? userSnap.data() || {} : {},
    summary: summarySnap.exists ? summarySnap.data() || {} : {},
  };
}

function archeryBookingPayload({
  bookingId,
  memberUid,
  timing,
  laneId,
  source,
  status,
  paymentStatus = 'PENDING',
  paymentMethod = '',
  customer = {},
  createdBy = '',
  holdExpiresAt = null,
}) {
  const laneNumber = archeryLaneNumber(laneId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const payload = {
    id: bookingId,
    booking_id: bookingId,
    bookingType: 'archery',
    service_type: ARCHERY_SERVICE_TYPE,
    service_name: 'Eden Archery',
    source,
    uid: memberUid,
    member_id: memberUid,
    memberUid,
    userId: memberUid,
    customerUid: memberUid,
    name: customer.name || 'Eden Member',
    customerName: customer.name || 'Eden Member',
    phone: customer.phone || '',
    customerPhone: customer.phone || '',
    customerEmail: customer.email || '',
    date: timing.date,
    startTime: timing.startTime,
    endTime: timing.endTime,
    start_time: timing.startTime,
    end_time: timing.endTime,
    start_at: archeryTimestamp(timing.date, timing.startTime),
    end_at: archeryTimestamp(timing.date, timing.endTime),
    duration_minutes: timing.packageMinutes,
    package_minutes: timing.packageMinutes,
    package_label: `${timing.packageMinutes} minutes`,
    resource_type_id: ARCHERY_RESOURCE_TYPE_ID,
    resource_ids: [laneId],
    lane_id: laneId,
    laneId,
    lane_number: laneNumber,
    laneLabel: `Lane ${laneNumber}`,
    guests: 1,
    status,
    status_label: archeryPublicStatus({ status, payment_status: paymentStatus }),
    payment_status: paymentStatus,
    paymentStatus: paymentStatus === 'PAID_ONLINE' || paymentStatus === 'PAID_COUNTER' ? 'paid' : 'pending',
    payment_method: paymentMethod,
    paymentMethod: paymentMethod ? paymentMethod.toLowerCase() : '',
    paymentLabel: archeryPublicStatus({ status, payment_status: paymentStatus }),
    amount_total: timing.amount,
    totalAmount: timing.amount,
    currency: 'THB',
    note: customer.note || '',
    createdAt: now,
    updatedAt: now,
    timestamp: now,
  };
  if (createdBy) payload.createdBy = createdBy;
  if (holdExpiresAt) {
    payload.hold_expires_at = holdExpiresAt;
    payload.holdExpiresAt = holdExpiresAt;
  }
  return payload;
}

function archeryBookingItemPayload({ bookingId, memberUid, timing, laneId }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  return {
    id: `${bookingId}_ARCHERY`,
    booking_id: bookingId,
    service_type: ARCHERY_SERVICE_TYPE,
    member_id: memberUid,
    item_type: 'PACKAGE',
    package_minutes: timing.packageMinutes,
    package_label: `${timing.packageMinutes} minutes`,
    resource_id: laneId,
    quantity: 1,
    unit_price: timing.amount,
    amount: timing.amount,
    createdAt: now,
    updatedAt: now,
  };
}

function archeryLockPayload({ bookingId, memberUid, laneId, date, slot, status, holdExpiresAt = null }) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const payload = {
    id: slot.id,
    booking_id: bookingId,
    service_type: ARCHERY_SERVICE_TYPE,
    resource_type_id: ARCHERY_RESOURCE_TYPE_ID,
    resource_id: laneId,
    lane_id: laneId,
    member_id: memberUid,
    date,
    slot_start: slot.startTime,
    slot_end: slot.endTime,
    slot_start_at: archeryTimestamp(date, slot.startTime),
    slot_end_at: archeryTimestamp(date, slot.endTime),
    status,
    updatedAt: now,
  };
  if (holdExpiresAt) payload.hold_expires_at = holdExpiresAt;
  return payload;
}

function paymentDocId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 32)}`;
}

function updateArcheryBookingStatusPayload(status, extra = {}) {
  const paymentStatus = extra.payment_status || extra.paymentStatus || '';
  const payload = {
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  };
  payload.status_label = archeryPublicStatus({
    status,
    payment_status: paymentStatus || extra.previousPaymentStatus || 'PENDING',
  });
  return payload;
}

async function readArcheryBookingForAdmin(transaction, bookingId) {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const bookingSnap = await transaction.get(bookingRef);
  if (!bookingSnap.exists) {
    const error = new Error('Booking not found');
    error.statusCode = 404;
    throw error;
  }
  const booking = bookingSnap.data() || {};
  if (booking.service_type !== ARCHERY_SERVICE_TYPE) {
    const error = new Error('Booking is not an archery booking');
    error.statusCode = 400;
    throw error;
  }
  return { bookingRef, booking };
}

function archeryTimingFromBooking(booking = {}) {
  const date = cleanString(booking.date, 20);
  const startTime = cleanString(booking.start_time || booking.startTime, 10);
  const endTime = cleanString(booking.end_time || booking.endTime, 10);
  const startMinutes = minutesFromTime(startTime);
  const endMinutes = minutesFromTime(endTime);
  if (!isISODate(date) || startMinutes == null || endMinutes == null || endMinutes <= startMinutes) {
    const error = new Error('Booking time is invalid');
    error.statusCode = 400;
    throw error;
  }
  return {
    date,
    startTime,
    endTime,
    startMinutes,
    endMinutes,
    packageMinutes: endMinutes - startMinutes,
    amount: Number(booking.amount_total || booking.totalAmount || 0) || 0,
  };
}

function assertArcheryBookingActive(booking = {}) {
  const status = cleanString(booking.status, 40).toUpperCase();
  if (['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(status)) {
    const error = new Error('Booking is already closed');
    error.statusCode = 409;
    throw error;
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

exports.getArcheryAvailability = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (!['GET', 'POST'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'archeryAvailability', 240, 10 * 60 * 1000);
      const raw = req.method === 'GET' ? req.query : (req.body || {});
      const date = cleanString(raw.date, 20);
      if (!isISODate(date)) {
        res.status(400).json({ error: 'Invalid date' });
        return;
      }
      const packageMinutes = normalizeArcheryPackageMinutes(raw.package_minutes || raw.packageMinutes || raw.duration_minutes || raw.durationMinutes || 60);
      const requestedStart = cleanString(raw.start_time || raw.startTime || raw.time, 10);
      const starts = [];
      if (requestedStart) {
        const timing = normalizeArcheryTimePayload({ date, startTime: requestedStart, packageMinutes });
        starts.push(timing.startMinutes);
      } else {
        for (let minute = ARCHERY_OPEN_MINUTES; minute + packageMinutes <= ARCHERY_CLOSE_MINUTES; minute += ARCHERY_SLOT_MINUTES) {
          starts.push(minute);
        }
      }

      const locksSnap = await db.collection('resource_locks')
        .where('service_type', '==', ARCHERY_SERVICE_TYPE)
        .where('date', '==', date)
        .get();
      const now = new Date();
      const occupied = new Set();
      locksSnap.forEach(docSnap => {
        const data = docSnap.data() || {};
        if (isActiveArcheryLock(data, now)) occupied.add(data.id || docSnap.id);
      });

      const lanes = archeryLaneIds().map(laneId => ({
        id: laneId,
        lane_id: laneId,
        lane_number: archeryLaneNumber(laneId),
        name: `Lane ${archeryLaneNumber(laneId)}`,
      }));
      const slots = starts.map(startMinute => {
        const endMinute = startMinute + packageMinutes;
        const availableLaneIds = lanes
          .map(lane => lane.id)
          .filter(laneId => archerySlots(laneId, date, startMinute, endMinute)
            .every(slot => !occupied.has(slot.id)));
        return {
          date,
          startTime: timeFromMinutes(startMinute),
          endTime: timeFromMinutes(endMinute),
          package_minutes: packageMinutes,
          availableLaneIds,
          available_lanes: availableLaneIds.length,
        };
      });

      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        service_type: ARCHERY_SERVICE_TYPE,
        date,
        package_minutes: packageMinutes,
        slot_minutes: ARCHERY_SLOT_MINUTES,
        open_time: timeFromMinutes(ARCHERY_OPEN_MINUTES),
        close_time: timeFromMinutes(ARCHERY_CLOSE_MINUTES),
        lanes,
        slots,
      });
    } catch (error) {
      const status = error.statusCode || (/Invalid|outside/.test(error.message) ? 400 : 500);
      logger.warn('Archery availability failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to read archery availability');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.createBookingHold = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'createArcheryHold', 18, 10 * 60 * 1000);
      const decoded = await requireSignedInUser(req);
      const raw = req.body || {};
      const timing = normalizeArcheryTimePayload(raw);
      const requestedLane = cleanString(raw.lane_id || raw.laneId || '', 20);
      const preferredLaneId = requestedLane ? normalizeArcheryLaneId(requestedLane) : '';
      if (requestedLane && !preferredLaneId) {
        res.status(400).json({ error: 'Invalid lane' });
        return;
      }
      const memberUid = decoded.uid || '';
      const customer = normalizeArcheryCustomer(raw, decoded);
      let result = null;

      await db.runTransaction(async transaction => {
        const selected = await findAvailableArcheryLane(transaction, timing, preferredLaneId);
        const bookingRef = db.collection('bookings').doc();
        const holdExpiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + ARCHERY_HOLD_MINUTES * 60 * 1000));
        writeArcheryResourceSeeds(transaction);
        transaction.set(bookingRef, archeryBookingPayload({
          bookingId: bookingRef.id,
          memberUid,
          timing,
          laneId: selected.laneId,
          source: 'online',
          status: 'HELD',
          paymentStatus: 'PENDING',
          paymentMethod: 'ONLINE',
          customer,
          createdBy: memberUid,
          holdExpiresAt,
        }));
        transaction.set(db.collection('booking_items').doc(`${bookingRef.id}_ARCHERY`), archeryBookingItemPayload({
          bookingId: bookingRef.id,
          memberUid,
          timing,
          laneId: selected.laneId,
        }));
        selected.slots.forEach(slot => {
          transaction.set(slot.ref, archeryLockPayload({
            bookingId: bookingRef.id,
            memberUid,
            laneId: selected.laneId,
            date: timing.date,
            slot,
            status: 'HELD',
            holdExpiresAt,
          }));
        });
        result = {
          booking_id: bookingRef.id,
          lane_id: selected.laneId,
          lane_number: archeryLaneNumber(selected.laneId),
          hold_expires_at: holdExpiresAt.toDate().toISOString(),
        };
      });

      res.status(201).json({
        ok: true,
        ...result,
        service_type: ARCHERY_SERVICE_TYPE,
        date: timing.date,
        startTime: timing.startTime,
        endTime: timing.endTime,
        package_minutes: timing.packageMinutes,
        amount_total: timing.amount,
        payment_status: 'PENDING',
      });
    } catch (error) {
      const status = error.statusCode || (/Invalid|outside|Missing/.test(error.message) ? 400 : 500);
      logger.warn('Archery hold failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to hold archery lane');
      res.status(status).json({ error: status === 409 ? 'Selected lane/time is already held or booked.' : publicError.message });
    }
  }
);

exports.confirmArcheryBooking = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'confirmArcheryBooking', 18, 10 * 60 * 1000);
      const decoded = await requireSignedInUser(req);
      const raw = req.body || {};
      const bookingId = cleanString(raw.booking_id || raw.bookingId || raw.id, 80);
      if (!bookingId) {
        res.status(400).json({ error: 'Missing booking id' });
        return;
      }
      const providerRef = cleanString(raw.provider_ref || raw.providerRef || raw.payment_provider_ref || '', 160);
      let responsePayload = null;

      await db.runTransaction(async transaction => {
        const bookingRef = db.collection('bookings').doc(bookingId);
        const bookingSnap = await transaction.get(bookingRef);
        if (!bookingSnap.exists) {
          const error = new Error('Booking not found');
          error.statusCode = 404;
          throw error;
        }
        const booking = bookingSnap.data() || {};
        if (booking.service_type !== ARCHERY_SERVICE_TYPE) {
          const error = new Error('Booking is not an archery booking');
          error.statusCode = 400;
          throw error;
        }
        const memberUid = cleanString(booking.member_id || booking.uid || booking.customerUid, 160);
        if (memberUid !== decoded.uid) {
          const error = new Error('Booking belongs to another member');
          error.statusCode = 403;
          throw error;
        }
        const status = cleanString(booking.status, 40).toUpperCase();
        if (!['HELD', 'CONFIRMED'].includes(status)) {
          const error = new Error('Booking hold cannot be confirmed');
          error.statusCode = 409;
          throw error;
        }
        const holdExpiresAt = archeryDateFromTimestamp(booking.hold_expires_at || booking.holdExpiresAt);
        if (status === 'HELD' && holdExpiresAt && holdExpiresAt.getTime() <= Date.now()) {
          const error = new Error('Booking hold expired');
          error.statusCode = 409;
          throw error;
        }

        const timing = archeryTimingFromBooking(booking);
        const laneId = normalizeArcheryLaneId(booking.lane_id || booking.laneId);
        const lockSlots = archeryLockRefs(laneId, timing.date, timing.startMinutes, timing.endMinutes);
        const paymentRef = providerRef ? db.collection('payments').doc(paymentDocId('online', providerRef)) : null;
        const reads = [
          ...lockSlots.map(slot => transaction.get(slot.ref)),
          paymentRef ? transaction.get(paymentRef) : Promise.resolve(null),
        ];
        const readSnaps = await Promise.all(reads);
        const lockSnaps = readSnaps.slice(0, lockSlots.length);
        const paymentSnap = paymentRef ? readSnaps[readSnaps.length - 1] : null;

        lockSnaps.forEach(lockSnap => {
          const lock = lockSnap.exists ? lockSnap.data() || {} : {};
          if (!lockSnap.exists || lock.booking_id !== bookingId) {
            const error = new Error('Booking lock is no longer available');
            error.statusCode = 409;
            throw error;
          }
          if (lock.status === 'HELD' && !isActiveArcheryLock(lock, new Date())) {
            const error = new Error('Booking hold expired');
            error.statusCode = 409;
            throw error;
          }
        });

        let paymentStatus = cleanString(booking.payment_status || 'PENDING', 40).toUpperCase();
        let paymentMethod = cleanString(booking.payment_method || 'ONLINE', 40).toUpperCase();
        if (providerRef) {
          if (paymentSnap && paymentSnap.exists && (paymentSnap.data() || {}).booking_id !== bookingId) {
            const error = new Error('Payment reference has already been used');
            error.statusCode = 409;
            throw error;
          }
          paymentStatus = 'PAID_ONLINE';
          paymentMethod = 'ONLINE';
          transaction.set(paymentRef, {
            id: paymentRef.id,
            booking_id: bookingId,
            service_type: ARCHERY_SERVICE_TYPE,
            member_id: memberUid,
            method: 'ONLINE',
            status: 'PAID',
            amount: Number(booking.amount_total || booking.totalAmount || 0) || 0,
            currency: booking.currency || 'THB',
            provider_ref: providerRef,
            idempotency_key: providerRef,
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        lockSlots.forEach(slot => {
          transaction.update(slot.ref, {
            status: 'CONFIRMED',
            hold_expires_at: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        transaction.update(bookingRef, updateArcheryBookingStatusPayload('CONFIRMED', {
          payment_status: paymentStatus,
          paymentStatus: paymentStatus === 'PAID_ONLINE' ? 'paid' : 'pending',
          payment_method: paymentMethod,
          paymentMethod: paymentMethod.toLowerCase(),
          paymentLabel: archeryPublicStatus({ status: 'CONFIRMED', payment_status: paymentStatus }),
          confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
          previousPaymentStatus: paymentStatus,
        }));
        responsePayload = {
          booking_id: bookingId,
          status: 'CONFIRMED',
          payment_status: paymentStatus,
          payment_label: archeryPublicStatus({ status: 'CONFIRMED', payment_status: paymentStatus }),
        };
      });

      res.json({ ok: true, ...responsePayload });
    } catch (error) {
      const status = error.statusCode || (/Invalid|Missing/.test(error.message) ? 400 : 500);
      logger.warn('Archery confirm failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to confirm archery booking');
      res.status(status).json({ error: status === 409 ? 'This hold is no longer available.' : publicError.message });
    }
  }
);

exports.createWalkInBooking = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const decoded = await requireAdminAccess(req, 'archery');
      const raw = req.body || {};
      const timing = normalizeArcheryTimePayload(raw);
      const memberUid = cleanString(raw.member_id || raw.memberUid || raw.customerUid || raw.uid, 160);
      if (!memberUid) {
        res.status(400).json({ error: 'Missing Eden member id' });
        return;
      }
      const requestedLane = cleanString(raw.lane_id || raw.laneId || '', 20);
      const preferredLaneId = requestedLane ? normalizeArcheryLaneId(requestedLane) : '';
      if (requestedLane && !preferredLaneId) {
        res.status(400).json({ error: 'Invalid lane' });
        return;
      }
      let result = null;

      await db.runTransaction(async transaction => {
        const member = await loadArcheryMemberForAdmin(transaction, memberUid);
        const selected = await findAvailableArcheryLane(transaction, timing, preferredLaneId);
        const user = member.user || {};
        const summary = member.summary || {};
        const customer = normalizeArcheryCustomer({
          ...raw,
          customerName: raw.customerName || user.displayName || user.display_name || summary.displayName || summary.name,
          customerPhone: raw.customerPhone || user.phone || user.phone_display || summary.phone,
          customerEmail: raw.customerEmail || user.email || summary.email,
        }, {});
        const bookingRef = db.collection('bookings').doc();
        writeArcheryResourceSeeds(transaction);
        transaction.set(bookingRef, archeryBookingPayload({
          bookingId: bookingRef.id,
          memberUid,
          timing,
          laneId: selected.laneId,
          source: 'walk_in',
          status: 'CONFIRMED',
          paymentStatus: 'PENDING',
          paymentMethod: 'COUNTER',
          customer,
          createdBy: decoded.uid || '',
        }));
        transaction.set(db.collection('booking_items').doc(`${bookingRef.id}_ARCHERY`), archeryBookingItemPayload({
          bookingId: bookingRef.id,
          memberUid,
          timing,
          laneId: selected.laneId,
        }));
        selected.slots.forEach(slot => {
          transaction.set(slot.ref, archeryLockPayload({
            bookingId: bookingRef.id,
            memberUid,
            laneId: selected.laneId,
            date: timing.date,
            slot,
            status: 'CONFIRMED',
          }));
        });
        result = {
          booking_id: bookingRef.id,
          lane_id: selected.laneId,
          lane_number: archeryLaneNumber(selected.laneId),
        };
      });

      res.status(201).json({
        ok: true,
        ...result,
        service_type: ARCHERY_SERVICE_TYPE,
        date: timing.date,
        startTime: timing.startTime,
        endTime: timing.endTime,
        package_minutes: timing.packageMinutes,
        payment_status: 'PENDING',
      });
    } catch (error) {
      const status = error.statusCode || (/Invalid|Missing|outside/.test(error.message) ? 400 : 500);
      logger.warn('Archery walk-in failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to create walk-in booking');
      res.status(status).json({ error: status === 409 ? 'Selected lane/time is already held or booked.' : publicError.message });
    }
  }
);

exports.adminCheckInBooking = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const decoded = await requireAdminAccess(req, 'archery');
      const bookingId = cleanString(req.body?.booking_id || req.body?.bookingId || req.body?.id, 80);
      await db.runTransaction(async transaction => {
        const { bookingRef, booking } = await readArcheryBookingForAdmin(transaction, bookingId);
        assertArcheryBookingActive(booking);
        const timing = archeryTimingFromBooking(booking);
        const laneId = normalizeArcheryLaneId(booking.lane_id || booking.laneId);
        const slots = archeryLockRefs(laneId, timing.date, timing.startMinutes, timing.endMinutes);
        await Promise.all(slots.map(slot => transaction.get(slot.ref)));
        slots.forEach(slot => transaction.update(slot.ref, {
          status: 'CHECKED_IN',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }));
        transaction.update(bookingRef, updateArcheryBookingStatusPayload('CHECKED_IN', {
          checked_in_at: admin.firestore.FieldValue.serverTimestamp(),
          checkedInBy: decoded.uid || '',
          previousPaymentStatus: booking.payment_status || 'PENDING',
        }));
        transaction.set(db.collection('lane_sessions').doc(bookingId), {
          id: bookingId,
          booking_id: bookingId,
          service_type: ARCHERY_SERVICE_TYPE,
          member_id: booking.member_id || booking.uid || '',
          lane_id: laneId,
          date: timing.date,
          start_time: timing.startTime,
          planned_end_time: timing.endTime,
          status: 'CHECKED_IN',
          checked_in_at: admin.firestore.FieldValue.serverTimestamp(),
          checkedInBy: decoded.uid || '',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      res.json({ ok: true, booking_id: bookingId, status: 'CHECKED_IN' });
    } catch (error) {
      const status = error.statusCode || 500;
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to check in booking');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.adminExtendBooking = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const decoded = await requireAdminAccess(req, 'archery');
      const raw = req.body || {};
      const bookingId = cleanString(raw.booking_id || raw.bookingId || raw.id, 80);
      const requestedEnd = cleanString(raw.new_end_time || raw.newEndTime || '', 10);
      const extraMinutes = Math.max(0, Math.floor(Number(raw.extra_minutes || raw.extraMinutes || 0) || 0));
      let responsePayload = null;
      await db.runTransaction(async transaction => {
        const { bookingRef, booking } = await readArcheryBookingForAdmin(transaction, bookingId);
        assertArcheryBookingActive(booking);
        const timing = archeryTimingFromBooking(booking);
        const newEndMinutes = requestedEnd ? minutesFromTime(requestedEnd) : timing.endMinutes + extraMinutes;
        if (
          newEndMinutes == null
          || newEndMinutes <= timing.endMinutes
          || newEndMinutes > ARCHERY_CLOSE_MINUTES
          || newEndMinutes % ARCHERY_SLOT_MINUTES !== 0
        ) {
          const error = new Error('Invalid extension time');
          error.statusCode = 400;
          throw error;
        }
        const laneId = normalizeArcheryLaneId(booking.lane_id || booking.laneId);
        const extraSlots = archeryLockRefs(laneId, timing.date, timing.endMinutes, newEndMinutes);
        const extraSnaps = await Promise.all(extraSlots.map(slot => transaction.get(slot.ref)));
        extraSnaps.forEach(snap => {
          const lock = snap.exists ? snap.data() || {} : {};
          if (snap.exists && isActiveArcheryLock(lock, new Date()) && lock.booking_id !== bookingId) {
            const error = new Error('Extension conflicts with another booking');
            error.statusCode = 409;
            throw error;
          }
        });
        extraSlots.forEach(slot => transaction.set(slot.ref, archeryLockPayload({
          bookingId,
          memberUid: booking.member_id || booking.uid || '',
          laneId,
          date: timing.date,
          slot,
          status: 'CONFIRMED',
        })));
        const newEndTime = timeFromMinutes(newEndMinutes);
        transaction.update(bookingRef, {
          endTime: newEndTime,
          end_time: newEndTime,
          end_at: archeryTimestamp(timing.date, newEndTime),
          duration_minutes: newEndMinutes - timing.startMinutes,
          package_minutes: newEndMinutes - timing.startMinutes,
          extended_minutes: (Number(booking.extended_minutes || 0) || 0) + (newEndMinutes - timing.endMinutes),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: decoded.uid || '',
        });
        transaction.set(db.collection('booking_items').doc(`${bookingId}_ARCHERY`), {
          package_minutes: newEndMinutes - timing.startMinutes,
          package_label: `${newEndMinutes - timing.startMinutes} minutes`,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(db.collection('lane_sessions').doc(bookingId), {
          planned_end_time: newEndTime,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        responsePayload = { booking_id: bookingId, endTime: newEndTime };
      });
      res.json({ ok: true, ...responsePayload });
    } catch (error) {
      const status = error.statusCode || (/Invalid/.test(error.message) ? 400 : 500);
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to extend booking');
      res.status(status).json({ error: status === 409 ? 'Extension conflicts with another booking.' : publicError.message });
    }
  }
);

exports.adminMoveBookingLane = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const decoded = await requireAdminAccess(req, 'archery');
      const raw = req.body || {};
      const bookingId = cleanString(raw.booking_id || raw.bookingId || raw.id, 80);
      const newLaneId = normalizeArcheryLaneId(raw.new_lane_id || raw.newLaneId || raw.lane_id || raw.laneId);
      if (!newLaneId) {
        res.status(400).json({ error: 'Invalid lane' });
        return;
      }
      await db.runTransaction(async transaction => {
        const { bookingRef, booking } = await readArcheryBookingForAdmin(transaction, bookingId);
        assertArcheryBookingActive(booking);
        const timing = archeryTimingFromBooking(booking);
        const oldLaneId = normalizeArcheryLaneId(booking.lane_id || booking.laneId);
        if (oldLaneId === newLaneId) return;
        const oldSlots = archeryLockRefs(oldLaneId, timing.date, timing.startMinutes, timing.endMinutes);
        const newSlots = archeryLockRefs(newLaneId, timing.date, timing.startMinutes, timing.endMinutes);
        const snaps = await Promise.all([
          ...oldSlots.map(slot => transaction.get(slot.ref)),
          ...newSlots.map(slot => transaction.get(slot.ref)),
        ]);
        const newSnaps = snaps.slice(oldSlots.length);
        newSnaps.forEach(snap => {
          const lock = snap.exists ? snap.data() || {} : {};
          if (snap.exists && isActiveArcheryLock(lock, new Date()) && lock.booking_id !== bookingId) {
            const error = new Error('Target lane conflicts with another booking');
            error.statusCode = 409;
            throw error;
          }
        });
        oldSlots.forEach(slot => transaction.set(slot.ref, {
          status: 'RELEASED',
          releasedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }));
        newSlots.forEach(slot => transaction.set(slot.ref, archeryLockPayload({
          bookingId,
          memberUid: booking.member_id || booking.uid || '',
          laneId: newLaneId,
          date: timing.date,
          slot,
          status: cleanString(booking.status, 40).toUpperCase() === 'CHECKED_IN' ? 'CHECKED_IN' : 'CONFIRMED',
        })));
        transaction.update(bookingRef, {
          lane_id: newLaneId,
          laneId: newLaneId,
          lane_number: archeryLaneNumber(newLaneId),
          laneLabel: `Lane ${archeryLaneNumber(newLaneId)}`,
          resource_ids: [newLaneId],
          movedAt: admin.firestore.FieldValue.serverTimestamp(),
          movedBy: decoded.uid || '',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        transaction.set(db.collection('lane_sessions').doc(bookingId), {
          lane_id: newLaneId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      res.json({ ok: true, booking_id: bookingId, lane_id: newLaneId });
    } catch (error) {
      const status = error.statusCode || 500;
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to move booking lane');
      res.status(status).json({ error: status === 409 ? 'Target lane conflicts with another booking.' : publicError.message });
    }
  }
);

exports.adminCancelBooking = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const decoded = await requireAdminAccess(req, 'archery');
      const bookingId = cleanString(req.body?.booking_id || req.body?.bookingId || req.body?.id, 80);
      const reason = cleanString(req.body?.reason || '', 300);
      await db.runTransaction(async transaction => {
        const { bookingRef, booking } = await readArcheryBookingForAdmin(transaction, bookingId);
        const timing = archeryTimingFromBooking(booking);
        const laneId = normalizeArcheryLaneId(booking.lane_id || booking.laneId);
        const slots = archeryLockRefs(laneId, timing.date, timing.startMinutes, timing.endMinutes);
        await Promise.all(slots.map(slot => transaction.get(slot.ref)));
        slots.forEach(slot => transaction.set(slot.ref, {
          status: 'CANCELLED',
          releasedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }));
        transaction.update(bookingRef, updateArcheryBookingStatusPayload('CANCELLED', {
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancelledBy: decoded.uid || '',
          cancelReason: reason,
          previousPaymentStatus: booking.payment_status || 'PENDING',
        }));
        transaction.set(db.collection('lane_sessions').doc(bookingId), {
          status: 'CANCELLED',
          closedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      res.json({ ok: true, booking_id: bookingId, status: 'CANCELLED' });
    } catch (error) {
      const status = error.statusCode || 500;
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to cancel booking');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.adminCompleteBooking = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const decoded = await requireAdminAccess(req, 'archery');
      const bookingId = cleanString(req.body?.booking_id || req.body?.bookingId || req.body?.id, 80);
      await db.runTransaction(async transaction => {
        const { bookingRef, booking } = await readArcheryBookingForAdmin(transaction, bookingId);
        const timing = archeryTimingFromBooking(booking);
        const laneId = normalizeArcheryLaneId(booking.lane_id || booking.laneId);
        const slots = archeryLockRefs(laneId, timing.date, timing.startMinutes, timing.endMinutes);
        await Promise.all(slots.map(slot => transaction.get(slot.ref)));
        slots.forEach(slot => transaction.set(slot.ref, {
          status: 'COMPLETED',
          releasedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }));
        transaction.update(bookingRef, updateArcheryBookingStatusPayload('COMPLETED', {
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          completedBy: decoded.uid || '',
          previousPaymentStatus: booking.payment_status || 'PENDING',
        }));
        transaction.set(db.collection('lane_sessions').doc(bookingId), {
          status: 'COMPLETED',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          closedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      res.json({ ok: true, booking_id: bookingId, status: 'COMPLETED' });
    } catch (error) {
      const status = error.statusCode || 500;
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to complete booking');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.adminMarkNoShow = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const decoded = await requireAdminAccess(req, 'archery');
      const bookingId = cleanString(req.body?.booking_id || req.body?.bookingId || req.body?.id, 80);
      await db.runTransaction(async transaction => {
        const { bookingRef, booking } = await readArcheryBookingForAdmin(transaction, bookingId);
        const timing = archeryTimingFromBooking(booking);
        const laneId = normalizeArcheryLaneId(booking.lane_id || booking.laneId);
        const slots = archeryLockRefs(laneId, timing.date, timing.startMinutes, timing.endMinutes);
        await Promise.all(slots.map(slot => transaction.get(slot.ref)));
        slots.forEach(slot => transaction.set(slot.ref, {
          status: 'NO_SHOW',
          releasedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true }));
        transaction.update(bookingRef, updateArcheryBookingStatusPayload('NO_SHOW', {
          noShowAt: admin.firestore.FieldValue.serverTimestamp(),
          noShowBy: decoded.uid || '',
          previousPaymentStatus: booking.payment_status || 'PENDING',
        }));
        transaction.set(db.collection('lane_sessions').doc(bookingId), {
          status: 'NO_SHOW',
          closedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      res.json({ ok: true, booking_id: bookingId, status: 'NO_SHOW' });
    } catch (error) {
      const status = error.statusCode || 500;
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to mark no-show');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.recordCounterPayment = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const decoded = await requireAdminAccess(req, 'archery');
      const raw = req.body || {};
      const bookingId = cleanString(raw.booking_id || raw.bookingId || raw.id, 80);
      const idempotencyKey = cleanString(raw.idempotency_key || raw.idempotencyKey || `${bookingId}_counter`, 160);
      if (!bookingId || !idempotencyKey) {
        res.status(400).json({ error: 'Missing booking or idempotency key' });
        return;
      }
      let responsePayload = null;
      await db.runTransaction(async transaction => {
        const { bookingRef, booking } = await readArcheryBookingForAdmin(transaction, bookingId);
        const paymentRef = db.collection('payments').doc(paymentDocId('counter', `${bookingId}:${idempotencyKey}`));
        const paymentSnap = await transaction.get(paymentRef);
        if (paymentSnap.exists) {
          responsePayload = { booking_id: bookingId, payment_id: paymentRef.id, duplicate: true };
          return;
        }
        const currentPaymentStatus = cleanString(booking.payment_status || booking.paymentStatus || 'PENDING', 40).toUpperCase();
        if (currentPaymentStatus === 'PAID_ONLINE' || currentPaymentStatus === 'PAID_COUNTER') {
          const error = new Error('Booking has already been paid');
          error.statusCode = 409;
          throw error;
        }
        const amount = Number(raw.amount || booking.amount_total || booking.totalAmount || 0) || 0;
        transaction.set(paymentRef, {
          id: paymentRef.id,
          booking_id: bookingId,
          service_type: ARCHERY_SERVICE_TYPE,
          member_id: booking.member_id || booking.uid || '',
          method: 'COUNTER',
          status: 'PAID',
          amount,
          currency: booking.currency || 'THB',
          idempotency_key: idempotencyKey,
          cashier_uid: decoded.uid || '',
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        transaction.update(bookingRef, updateArcheryBookingStatusPayload(cleanString(booking.status || 'CONFIRMED', 40).toUpperCase(), {
          payment_status: 'PAID_COUNTER',
          paymentStatus: 'paid',
          payment_method: 'COUNTER',
          paymentMethod: 'cash',
          paymentLabel: 'Paid Counter',
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          paidBy: decoded.uid || '',
          previousPaymentStatus: 'PAID_COUNTER',
        }));
        responsePayload = { booking_id: bookingId, payment_id: paymentRef.id, duplicate: false };
      });
      res.json({ ok: true, ...responsePayload, payment_status: 'PAID_COUNTER' });
    } catch (error) {
      const status = error.statusCode || (/Missing/.test(error.message) ? 400 : 500);
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to record counter payment');
      res.status(status).json({ error: status === 409 ? 'This booking is already paid.' : publicError.message });
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
      });
    } catch (error) {
      const status = error.statusCode || (/required|valid|password|uid|email/i.test(error.message) ? 400 : 500);
      logger.warn('Admin access user upsert failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to save admin access user. Please check the required fields.');
      res.status(status).json({ error: publicError.message });
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
      const userSnap = await db.collection('users').doc(decoded.uid).get();
      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const existingEmail = normalizePublicEmail(userData.email || userData.email_lower || '');
      if (existingEmail === email && userData.emailVerified === true) {
        res.json({ ok: true, alreadyVerified: true, email });
        return;
      }

      const codeRef = db.collection('email_verification_codes').doc(decoded.uid);
      const existingCodeSnap = await codeRef.get();
      const existingCode = existingCodeSnap.exists ? existingCodeSnap.data() || {} : {};
      const existingExpiresAt = existingCode.expiresAt?.toDate ? existingCode.expiresAt.toDate().getTime() : 0;
      if (existingCode.email === email && existingExpiresAt > Date.now()) {
        const resendAfterSeconds = Math.max(1, Math.ceil((existingExpiresAt - Date.now()) / 1000));
        res.json({
          ok: true,
          reused: true,
          email,
          expiresInMinutes: Math.max(1, Math.ceil(resendAfterSeconds / 60)),
          resendAfterSeconds,
        });
        return;
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const now = admin.firestore.Timestamp.now();
      const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));
      await codeRef.set({
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

exports.mergeDuplicateMemberAccounts = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 120, memory: '512MiB' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      checkRateLimit(req, 'mergeDuplicateMemberAccounts', 20, 15 * 60 * 1000);
      const decoded = await requireAdminAccess(req, 'members');
      const body = req.body || {};
      const email = normalizePublicEmail(body.email || body.emailLower || '');
      const phoneNumber = normalizeThaiPhoneForMemberIndex(body.phoneNumber || body.phone || '');
      const primaryUid = cleanString(body.primaryUid || body.uid || body.userId || '', 160);
      const requestedDuplicateUids = uniqueCleanStrings(Array.isArray(body.duplicateUids) ? body.duplicateUids : [], 160);

      if (!primaryUid) throw publicClientError('Primary UID is required.', 400);
      if (!email && !phoneNumber && requestedDuplicateUids.length < 1) {
        throw publicClientError('Email, phone number, or duplicate UID is required.', 400);
      }

      const [emailUids, phoneUids] = await Promise.all([
        email ? findMemberUidsByEmail(email) : Promise.resolve([]),
        phoneNumber ? findMemberUidsByPhone(phoneNumber) : Promise.resolve([]),
      ]);
      const candidateUids = uniqueCleanStrings([
        primaryUid,
        ...requestedDuplicateUids,
        ...emailUids,
        ...phoneUids,
      ], 160);
      const duplicateUids = uniqueCleanStrings(candidateUids.filter(uid => uid !== primaryUid), 160);

      if (!candidateUids.includes(primaryUid)) throw publicClientError('Primary UID must be one of the matched member UIDs.', 400);
      if (duplicateUids.length < 1) throw publicClientError('No duplicate member UID was found to merge.', 400);
      if (candidateUids.length > 8) throw publicClientError('Too many candidate UIDs. Please merge a smaller set first.', 400);

      const rows = await Promise.all(candidateUids.map(loadMergeMemberRow));
      const primaryRow = rows.find(row => row.uid === primaryUid);
      if (!primaryRow?.userExists && !primaryRow?.credentialExists) {
        throw publicClientError('Primary member profile was not found.', 404);
      }
      const mergeableDuplicates = rows.filter(row => row.uid !== primaryUid && (row.userExists || row.credentialExists || row.summaryExists));
      if (!mergeableDuplicates.length) throw publicClientError('No existing duplicate member data was found.', 404);

      const auditRef = db.collection('member_merge_audits').doc();
      const auditId = auditRef.id;
      const now = admin.firestore.FieldValue.serverTimestamp();
      const mergedEmail = mergeMemberEmail(rows, email);
      const mergedPhone = mergeMemberPhone(rows, phoneNumber);
      const phoneIndexKey = mergedPhone ? memberPhoneIndexKey(mergedPhone) : '';
      const {
        userPayload,
        summaryPayload,
        mergedPoints,
        totalSpent,
        visitCount,
        orderCount,
        bookingCount,
        tier,
      } = buildMergedMemberPayload(primaryUid, rows, mergedEmail, mergedPhone, auditId);
      const credentialPayload = buildMergedCredentialPayload(primaryUid, rows, mergedEmail, mergedPhone);

      const [orderDocs, bookingDocs, ledgerDocs] = await Promise.all([
        findMergeDocsByFields('orders', ['customerUid', 'uid', 'userId', 'memberUid'], duplicateUids),
        findMergeDocsByFields('bookings', ['uid', 'customerUid', 'userId', 'memberUid'], duplicateUids),
        findMergeDocsByFields('point_ledger', ['userId'], duplicateUids),
      ]);

      const operations = [];
      operations.push({
        type: 'set',
        ref: auditRef,
        data: {
          primaryUid,
          duplicateUids,
          candidateUids,
          email: mergedEmail || null,
          phoneLast4: mergedPhone ? mergedPhone.slice(-4) : null,
          snapshots: rows.map(memberMergeSnapshot),
          counts: {
            ordersMatched: orderDocs.length,
            bookingsMatched: bookingDocs.length,
            pointLedgerMatched: ledgerDocs.length,
          },
          mergedTotals: {
            pointsBalance: mergedPoints,
            totalSpent,
            visitCount,
            orderCount,
            bookingCount,
            tier,
          },
          createdAt: now,
          createdBy: decoded.uid || '',
          createdByEmail: cleanString(decoded.email || '', 180),
          source: 'admin_member_auth_merge',
        },
        options: { merge: false },
      });
      operations.push({ type: 'set', ref: db.collection('users').doc(primaryUid), data: userPayload, options: { merge: true } });
      operations.push({ type: 'set', ref: db.collection('member_summaries').doc(primaryUid), data: summaryPayload, options: { merge: true } });
      operations.push({ type: 'set', ref: db.collection('user_credentials').doc(primaryUid), data: credentialPayload, options: { merge: true } });
      if (mergedPhone && phoneIndexKey) {
        operations.push({
          type: 'set',
          ref: db.collection('phone_number_index').doc(phoneIndexKey),
          data: {
            uid: primaryUid,
            phone_number: mergedPhone,
            updated_at: now,
            memberMergeAuditId: auditId,
          },
          options: { merge: true },
        });
      }

      let ordersUpdated = 0;
      orderDocs.forEach(docSnap => {
        const update = updateOrderMemberUidPayload(docSnap.data() || {}, duplicateUids, primaryUid, now, auditId);
        if (Object.keys(update).length) {
          ordersUpdated += 1;
          operations.push({ type: 'update', ref: docSnap.ref, data: update });
        }
      });
      let bookingsUpdated = 0;
      bookingDocs.forEach(docSnap => {
        const update = updateBookingMemberUidPayload(docSnap.data() || {}, duplicateUids, primaryUid, now, auditId);
        if (Object.keys(update).length) {
          bookingsUpdated += 1;
          operations.push({ type: 'update', ref: docSnap.ref, data: update });
        }
      });
      let pointLedgerUpdated = 0;
      ledgerDocs.forEach(docSnap => {
        pointLedgerUpdated += 1;
        operations.push({
          type: 'update',
          ref: docSnap.ref,
          data: updatePointLedgerMemberPayload(docSnap.data() || {}, primaryUid, userPayload, now, auditId),
        });
      });

      duplicateUids.forEach(uid => {
        operations.push({
          type: 'set',
          ref: db.collection('member_merge_redirects').doc(uid),
          data: {
            uid,
            primaryUid,
            mergedInto: primaryUid,
            auditId,
            email: mergedEmail || null,
            phoneLast4: mergedPhone ? mergedPhone.slice(-4) : null,
            mergedAt: now,
            mergedBy: decoded.uid || '',
            mergedByEmail: cleanString(decoded.email || '', 180),
          },
          options: { merge: false },
        });
        operations.push({ type: 'delete', ref: db.collection('users').doc(uid) });
        operations.push({ type: 'delete', ref: db.collection('member_summaries').doc(uid) });
        operations.push({ type: 'delete', ref: db.collection('user_credentials').doc(uid) });
      });

      const writesCommitted = await commitMergeOperations(operations);
      const repairStats = {};
      await repairMemberAuthLink(primaryUid, {
        ...userPayload,
        uid: primaryUid,
        email: mergedEmail,
        email_lower: mergedEmail,
        phone_number: mergedPhone,
        phoneE164: mergedPhone,
      }, repairStats);

      const after = await summarizeMemberAuthUid(primaryUid, mergedEmail, mergedPhone);
      logger.info('Duplicate member accounts merged', {
        auditId,
        primaryUid,
        duplicateUids,
        ordersUpdated,
        bookingsUpdated,
        pointLedgerUpdated,
        writesCommitted,
      });

      res.json({
        ok: true,
        auditId,
        primaryUid,
        mergedUids: duplicateUids,
        counts: {
          ordersUpdated,
          bookingsUpdated,
          pointLedgerUpdated,
          writesCommitted,
          credentialLinksRepaired: repairStats.credentialLinksRepaired || 0,
          phoneIndexesRepaired: repairStats.phoneIndexesRepaired || 0,
          phoneIndexConflicts: repairStats.phoneIndexConflicts || 0,
        },
        totals: {
          pointsBalance: mergedPoints,
          totalSpent,
          visitCount,
          orderCount,
          bookingCount,
          tier,
        },
        selected: after,
        recommendation: after?.hasPasswordHash ? 'READY_FOR_EMAIL_PHONE_PASSWORD_LOGIN' : 'SAFE_PASSWORD_SETUP_REQUIRED',
      });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Duplicate member merge failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to merge duplicate member accounts.');
      res.status(status).json({ error: error.publicMessage || publicError.message });
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
  return loyaltyFormula.normalizePosSaleItems(items);
}

function eligibleSubtotalForPosSale(items, excludedCategories) {
  return loyaltyFormula.eligibleSubtotalForPosSale(items, excludedCategories);
}

function expiryTimestamp(months) {
  if (!months) return null;
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return admin.firestore.Timestamp.fromDate(date);
}

async function resolvePosOrderRef(orderId, firestoreId, receiptNo) {
  const candidates = Array.from(new Set(
    [firestoreId, orderId]
      .map(value => cleanString(value || '', 180))
      .filter(Boolean)
  ));

  for (const candidate of candidates) {
    const ref = db.collection('orders').doc(candidate);
    const snap = await ref.get();
    if (snap.exists) {
      return { ref, source: 'document_id', requestedOrderId: candidate };
    }
  }

  const safeReceiptNo = cleanString(receiptNo || '', 120);
  if (safeReceiptNo) {
    for (const field of ['receiptNo', 'number']) {
      const snap = await db.collection('orders')
        .where(field, '==', safeReceiptNo)
        .limit(2)
        .get();
      if (snap.size > 1) {
        const error = new Error(`Multiple POS orders found for ${field} ${safeReceiptNo}`);
        error.statusCode = 409;
        throw error;
      }
      if (!snap.empty) {
        return { ref: snap.docs[0].ref, source: field, requestedOrderId: candidates[0] || '' };
      }
    }
  }

  return { ref: null, source: 'not_found', requestedOrderId: candidates[0] || '' };
}

async function markPosLoyaltyFailed(orderRef, error, idempotencyKey) {
  if (!orderRef) return false;
  const message = cleanString(error?.publicMessage || error?.message || 'POS loyalty sync failed', 500);
  try {
    await orderRef.update({
      loyaltySyncStatus: 'failed',
      loyaltyError: message,
      loyaltyIdempotencyKey: idempotencyKey || '',
      loyaltyFailedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (updateError) {
    logger.warn('POS loyalty failure status update failed', {
      orderPath: orderRef.path,
      message: updateError.message,
    });
    return false;
  }
}

const POS_LOYALTY_SKIP_REASONS = new Set([
  'no-customer',
  'unsynced-customer',
  'test-order',
  'soft-launch',
]);

function normalizePosLoyaltySkipReason(value) {
  const reason = cleanString(value || '', 80).toLowerCase().replace(/_/g, '-');
  return POS_LOYALTY_SKIP_REASONS.has(reason) ? reason : '';
}

function posLoyaltySkipReasonFor({ customerProfileSynced, customerUid, isTestOrder, softLaunch } = {}) {
  if (isTestOrder === true) return 'test-order';
  if (softLaunch === true) return 'soft-launch';
  if (!cleanString(customerUid || '', 180)) return 'no-customer';
  if (customerProfileSynced === false) return 'unsynced-customer';
  return '';
}

function posLoyaltySkippedPayload({ customerUid = '', idempotencyKey = '', reason = '' } = {}) {
  const skipReason = normalizePosLoyaltySkipReason(reason) || 'no-customer';
  return {
    customerUid: cleanString(customerUid || '', 180),
    earnedPoints: 0,
    redeemedPoints: 0,
    loyaltyDiscount: 0,
    idempotencyKey,
    skipped: true,
    reason: skipReason,
    syncedAt: new Date().toISOString(),
  };
}

function posLoyaltySkippedOrderPatch(payload, idempotencyKey) {
  return {
    loyalty: payload,
    earnedPoints: 0,
    redeemedPoints: 0,
    loyaltyDiscount: 0,
    loyaltySyncStatus: 'skipped',
    loyaltyError: payload.reason,
    loyaltySkipReason: payload.reason,
    loyaltyIdempotencyKey: idempotencyKey || payload.idempotencyKey || '',
    loyaltySkippedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function firstFiniteNumber(values, fallback = 0) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return fallback;
}

function sumPosItemsSubtotal(items) {
  return loyaltyFormula.sumPosItemsSubtotal(items);
}

function sumPosItemsLineDiscount(items) {
  return loyaltyFormula.sumPosItemsLineDiscount(items);
}

function finiteNumberOrNull(value) {
  return loyaltyFormula.finiteNumberOrNull(value);
}

function resolvePosOrderDiscount({ orderDiscount, normalDiscount, discount, subtotal, netAmount, items }) {
  return loyaltyFormula.resolvePosOrderDiscount({
    orderDiscount,
    normalDiscount,
    discount,
    subtotal,
    netAmount,
    items,
  });
}

function roundPosMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function cleanPosCode(value) {
  return promotionsEngine.normalizeCode(value || '');
}

function posPromotionActor(decoded = {}) {
  return {
    uid: cleanString(decoded.uid || '', 180),
    email: cleanString(decoded.email || '', 180),
    role: 'CASHIER',
  };
}

function posPromotionContext(decoded = {}, req) {
  return {
    actor: posPromotionActor(decoded),
    requestId: cleanString(req.get('x-request-id') || req.get('x-cloud-trace-context') || '', 180),
  };
}

function normalizePosPromotionItems(items = [], manualDiscount = 0) {
  const rawItems = Array.isArray(items) ? items : [];
  const lines = rawItems.map((item, index) => {
    const quantity = Math.max(0, Number(item.quantity ?? item.qty ?? 0) || 0);
    const unitPrice = Math.max(0, Number(item.unitPrice ?? item.price ?? item.basePrice ?? 0) || 0);
    const grossAmount = roundPosMoney(unitPrice * quantity);
    const lineDiscount = Math.min(
      Math.max(0, Number(item.lineDiscount ?? item.line_discount ?? 0) || 0),
      grossAmount
    );
    const amountBeforeManual = roundPosMoney(Math.max(0, grossAmount - lineDiscount));
    const categoryId = cleanString(
      item.categoryId || item.category_id || item.category || item.categoryName || item.category_name || '',
      160
    );
    const categoryIds = Array.from(new Set([
      ...(Array.isArray(item.categoryIds || item.category_ids)
        ? (item.categoryIds || item.category_ids)
        : []),
      categoryId,
    ].map(value => cleanString(value, 160).toLowerCase()).filter(Boolean)));
    return {
      index,
      productId: cleanString(item.productId || item.product_id || item.id || item.menuItemId || '', 160),
      variantId: cleanString(item.variantId || item.variant_id || item.variant || item.optionId || item.variantName || '', 160),
      sku: cleanString(item.sku || item.variantSku || '', 80),
      name: cleanString(item.name || item.productName || 'POS item', 180),
      categoryId,
      categoryIds,
      categoryName: cleanString(item.categoryName || item.category_name || item.category || categoryId, 180),
      quantity,
      unitPrice,
      grossAmount,
      lineDiscount,
      amountBeforeManual,
      taxEnabled: item.taxEnabled !== false,
    };
  }).filter(item => item.quantity > 0 && item.amountBeforeManual > 0);

  const baseSubtotal = roundPosMoney(lines.reduce((sum, item) => sum + item.amountBeforeManual, 0));
  const orderManualDiscount = Math.min(Math.max(0, Number(manualDiscount) || 0), baseSubtotal);
  let allocatedManualDiscount = 0;
  return lines.map((item, index) => {
    const isLast = index === lines.length - 1;
    const manualShare = isLast
      ? roundPosMoney(orderManualDiscount - allocatedManualDiscount)
      : roundPosMoney(orderManualDiscount * (item.amountBeforeManual / baseSubtotal));
    allocatedManualDiscount = roundPosMoney(allocatedManualDiscount + manualShare);
    const amount = roundPosMoney(Math.max(0, item.amountBeforeManual - manualShare));
    return {
      ...item,
      manualDiscountShare: manualShare,
      amount,
      lineTotal: amount,
      total: amount,
    };
  }).filter(item => item.amount > 0);
}

function posPromotionSubtotal(items = []) {
  return roundPosMoney(items.reduce((sum, item) => sum + Math.max(0, Number(item.amount || item.lineTotal || 0)), 0));
}

function posOrderFinancials(order = {}, promoDiscount = 0, body = {}) {
  const items = normalizePosSaleItems(order.items || []);
  const itemSubtotal = sumPosItemsSubtotal(items);
  const lineDiscount = sumPosItemsLineDiscount(items);
  const subtotal = Math.max(0, firstFiniteNumber([
    order.subtotal,
    order.subTotal,
    order.grossSubtotal,
    itemSubtotal,
  ], itemSubtotal));
  const subtotalAfterLineDiscount = roundPosMoney(Math.max(0, subtotal - lineDiscount));
  const existingPromoDiscount = Math.max(0, firstFiniteNumber([
    order.promoDiscount,
    order.promotionDiscount,
  ], 0));
  const manualFallback = Math.max(0, firstFiniteNumber([
    order.orderDiscount,
    order.normalDiscount,
    order.manualDiscount,
    body.manualDiscount,
    body.manual_discount,
    Math.max(0, firstFiniteNumber([order.discount, body.discount], 0) - lineDiscount - existingPromoDiscount),
  ], 0));
  const manualDiscount = Math.min(manualFallback, subtotalAfterLineDiscount);
  const promotionDiscount = Math.min(Math.max(0, Number(promoDiscount) || 0), Math.max(0, subtotalAfterLineDiscount - manualDiscount));
  const orderDiscount = roundPosMoney(manualDiscount + promotionDiscount);
  const totalDiscount = roundPosMoney(lineDiscount + orderDiscount);
  const totalBeforeLoyalty = roundPosMoney(Math.max(0, subtotalAfterLineDiscount - orderDiscount));
  const loyaltyDiscount = Math.min(
    Math.max(0, firstFiniteNumber([order.loyaltyDiscount, body.loyaltyDiscount], 0)),
    totalBeforeLoyalty
  );
  const totalAfterLoyalty = roundPosMoney(Math.max(0, totalBeforeLoyalty - loyaltyDiscount));
  return {
    subtotal,
    lineDiscount: roundPosMoney(lineDiscount),
    manualDiscount: roundPosMoney(manualDiscount),
    promoDiscount: roundPosMoney(promotionDiscount),
    orderDiscount,
    totalDiscount,
    totalBeforeLoyalty,
    loyaltyDiscount: roundPosMoney(loyaltyDiscount),
    totalAfterLoyalty,
  };
}

function publicPosPromotionError(error, fallback) {
  const status = error.statusCode || 500;
  const publicError = publicApiError({ ...error, statusCode: status }, fallback);
  return {
    status,
    body: {
      error: publicError.message,
      code: cleanString(error.code || error.errorCode || '', 80),
    },
  };
}

function buildTrustedPosLoyaltyPayload(orderRef, order = {}) {
  const receiptNo = cleanString(order.receiptNo || order.number || order.orderNumber || orderRef.id, 120);
  const items = normalizePosSaleItems(order.items || []);
  const itemSubtotal = sumPosItemsSubtotal(items);
  const subtotal = Math.max(0, firstFiniteNumber([
    order.subtotal,
    order.subTotal,
    order.grossSubtotal,
    order.totalBeforeDiscount,
    itemSubtotal,
  ], itemSubtotal));
  const preliminaryOrderDiscount = resolvePosOrderDiscount({
    orderDiscount: order.orderDiscount,
    normalDiscount: order.normalDiscount,
    discount: firstFiniteNumber([order.discountAmount, order.discount, order.manualDiscount], null),
    subtotal,
    items,
  });
  const netAmount = Math.max(0, firstFiniteNumber([
    order.totalBeforeLoyalty,
    order.netAmount,
    order.netTotal,
    order.totalAmount,
    order.total,
    Math.max(0, subtotal - sumPosItemsLineDiscount(items) - preliminaryOrderDiscount),
  ], 0));
  const orderDiscount = resolvePosOrderDiscount({
    orderDiscount: order.orderDiscount,
    normalDiscount: order.normalDiscount,
    discount: firstFiniteNumber([order.discountAmount, order.discount, order.manualDiscount], null),
    subtotal,
    netAmount,
    items,
  });
  const redeemedPoints = Math.max(0, Math.trunc(firstFiniteNumber([
    order.redeemedPoints,
    order.loyaltyRedeemedPoints,
    order.pointsRedeemed,
  ], 0)));
  const idempotencyKey = safeLedgerKey(
    order.loyaltyIdempotencyKey
    || order.idempotencyKey
    || receiptNo
    || orderRef.id
  );

  return {
    orderId: orderRef.id,
    firestoreId: orderRef.id,
    receiptNo,
    customerUid: cleanString(order.customerUid || '', 180),
    customerEmail: cleanString(order.customerEmail || '', 180),
    customerMemberCode: cleanString(order.customerMemberCode || '', 80),
    customerProfileSynced: order.customerProfileSynced === true,
    loyaltySkipReason: normalizePosLoyaltySkipReason(order.loyaltySkipReason || order.loyalty?.reason || ''),
    netAmount,
    subtotal,
    normalDiscount: orderDiscount,
    orderDiscount,
    loyaltyDiscount: Math.max(0, Number(order.loyaltyDiscount || 0)),
    redeemedPoints,
    isTestOrder: order.isTestOrder === true,
    softLaunch: order.softLaunch === true,
    items,
    idempotencyKey,
  };
}

exports.validatePosPromotion = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      await requireAdminAccess(req, 'pos');
      const body = req.body || {};
      const manualDiscount = Math.max(0, firstFiniteNumber([
        body.manualDiscount,
        body.manual_discount,
        body.orderDiscount,
        body.discount,
      ], 0));
      const items = normalizePosPromotionItems(body.items || [], manualDiscount);
      const subtotal = posPromotionSubtotal(items);
      if (subtotal <= 0) {
        const error = new Error('POS promotion subtotal must be greater than zero');
        error.statusCode = 400;
        throw error;
      }
      const promotion = await promotionsEngine.validatePromotion(db, {
        ...(body || {}),
        promo_code: body.promo_code || body.promoCode || body.code,
        source_type: 'POS_RECEIPT',
        channel: 'POS',
        customer_uid: body.customer_uid || body.customerUid || body.member_id || body.memberId || '',
        subtotal,
        items,
      });
      res.status(200).json({
        ok: true,
        promotion,
        totals: {
          subtotal,
          manualDiscount: roundPosMoney(manualDiscount),
          promoDiscount: roundPosMoney(promotion.discountAmount),
          totalAfterPromo: roundPosMoney(Math.max(0, subtotal - promotion.discountAmount)),
        },
      });
    } catch (error) {
      const result = publicPosPromotionError(error, 'Unable to validate POS promo code.');
      logger.warn('POS promo validation failed', { message: error.message, status: result.status });
      res.status(result.status).json(result.body);
    }
  }
);

exports.validatePosGiftVoucher = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      await requireAdminAccess(req, 'pos');
      const body = req.body || {};
      const amountDue = Math.max(0, firstFiniteNumber([
        body.amount_due,
        body.amountDue,
        body.amount,
        body.totalAfterPromo,
        body.totalAmount,
        body.total,
      ], 0));
      const voucher = await promotionsEngine.validateGiftVoucher(db, {
        ...(body || {}),
        voucher_code: body.voucher_code || body.voucherCode || body.code,
        amount_due: amountDue,
        require_full_coverage: body.require_full_coverage === true || body.requireFullCoverage === true,
      });
      res.status(200).json({ ok: true, voucher });
    } catch (error) {
      const result = publicPosPromotionError(error, 'Unable to validate POS gift voucher.');
      logger.warn('POS gift voucher validation failed', { message: error.message, status: result.status });
      res.status(result.status).json(result.body);
    }
  }
);

exports.applyPosSaleAdjustments = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    let orderRef = null;
    try {
      const decoded = await requireAdminAccess(req, 'pos');
      const body = req.body || {};
      const orderLookup = await resolvePosOrderRef(
        cleanString(body.orderId || body.order_id || '', 180),
        cleanString(body.firestoreId || body.firestore_id || '', 180),
        cleanString(body.receiptNo || body.receipt_no || '', 120)
      );
      orderRef = orderLookup.ref;
      if (!orderRef) {
        const error = new Error('Synced POS order was not found');
        error.statusCode = 404;
        throw error;
      }

      const promoCode = cleanPosCode(body.promo_code || body.promoCode || body.code);
      const voucherCode = cleanPosCode(body.voucher_code || body.voucherCode || body.giftVoucherCode);
      if (!promoCode && !voucherCode) {
        res.status(200).json({ ok: true, status: 'skipped', orderId: orderRef.id });
        return;
      }

      const context = posPromotionContext(decoded, req);
      const result = await db.runTransaction(async transaction => {
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists) {
          const error = new Error('Synced POS order was not found');
          error.statusCode = 404;
          throw error;
        }
        const order = orderSnap.data() || {};
        if (cleanString(order.source || '', 40) && cleanString(order.source || '', 40) !== 'pos') {
          const error = new Error('This function only applies to POS orders');
          error.statusCode = 400;
          throw error;
        }
        if (cleanString(order.paymentStatus || '', 40) !== 'paid') {
          const error = new Error('POS promo/voucher can only be applied to paid receipts');
          error.statusCode = 409;
          throw error;
        }

        const receiptNo = cleanString(order.receiptNo || order.number || body.receiptNo || body.receipt_no || orderRef.id, 120);
        const branchId = cleanString(body.branch_id || body.branchId || order.branch_id || order.branchId || 'pos', 80);
        const preliminaryFinancials = posOrderFinancials(order, 0, body);
        let promotion = null;
        let promoDiscount = Math.max(0, firstFiniteNumber([
          order.promoDiscount,
          order.promotionDiscount,
        ], 0));

        if (promoCode) {
          const promoItems = normalizePosPromotionItems(order.items || body.items || [], preliminaryFinancials.manualDiscount);
          const promoSubtotal = posPromotionSubtotal(promoItems);
          if (promoSubtotal <= 0) {
            const error = new Error('POS promotion subtotal must be greater than zero');
            error.statusCode = 400;
            throw error;
          }
          promotion = await promotionsEngine.redeemPromotionRedemptionInTransaction(transaction, db, {
            promo_code: promoCode,
            source_type: 'POS_RECEIPT',
            source_id: receiptNo,
            receipt_id: receiptNo,
            payment_id: orderRef.id,
            branch_id: branchId,
            customer_uid: order.customerUid || body.customerUid || body.customer_uid || '',
            cashier_uid: decoded.uid || '',
            subtotal: promoSubtotal,
            items: promoItems,
          }, context);
          promoDiscount = roundPosMoney(promotion.discountAmount);
        }

        const financials = posOrderFinancials(order, promoDiscount, body);
        let voucher = null;
        let voucherAmount = Math.max(0, firstFiniteNumber([
          order.giftVoucherAmount,
          order.voucherAmount,
        ], 0));
        if (voucherCode && !promoCode) {
          const requestedVoucherAmount = Math.min(
            Math.max(0, firstFiniteNumber([
              body.voucherAmount,
              body.giftVoucherAmount,
              body.amount,
              body.amountDue,
              body.amount_due,
              financials.totalAfterLoyalty,
            ], financials.totalAfterLoyalty)),
            financials.totalAfterLoyalty
          );
          if (requestedVoucherAmount > 0) {
            voucher = await promotionsEngine.redeemGiftVoucherInTransaction(transaction, db, {
              voucher_code: voucherCode,
              source_type: 'POS_RECEIPT',
              source_id: receiptNo,
              order_id: orderRef.id,
              receipt_no: receiptNo,
              amount: requestedVoucherAmount,
              idempotency_key: safeLedgerKey(body.idempotencyKey || body.idempotency_key || `${receiptNo}-voucher`),
              branch_id: branchId,
              actor_uid: decoded.uid || '',
            }, context);
            voucherAmount = roundPosMoney(voucher.amount);
          }
        }

        const amountDue = roundPosMoney(Math.max(0, financials.totalAfterLoyalty - voucherAmount));
        const paymentMethod = cleanString(order.paymentMethod || body.paymentMethod || '', 40);
        const nonVoucherPaidAmount = roundPosMoney(Math.max(0, firstFiniteNumber([
          body.nonVoucherPaidAmount,
          body.paidWithoutVoucher,
          order.nonVoucherPaidAmount,
          order.paidWithoutVoucher,
          order.cashPaidAmount,
          amountDue,
        ], amountDue)));
        const paidAmount = roundPosMoney(Math.max(financials.totalAfterLoyalty, nonVoucherPaidAmount + voucherAmount));
        const changeAmount = paymentMethod === 'cash'
          ? roundPosMoney(Math.max(0, nonVoucherPaidAmount - amountDue))
          : 0;
        const promotionApplications = promotion
          ? [{
            redemptionId: promotion.redemptionId,
            code: promotion.code,
            promotionId: promotion.promotionId,
            promotionName: promotion.promotionName,
            discountAmount: roundPosMoney(promotion.discountAmount),
            eligibleSubtotal: roundPosMoney(promotion.eligibleSubtotal),
            lineAllocations: Array.isArray(promotion.lineAllocations) ? promotion.lineAllocations : [],
          }]
          : (Array.isArray(order.promotionApplications) ? order.promotionApplications : []);
        const giftVoucherApplications = voucher
          ? [{
            voucherId: voucher.voucherId,
            ledgerId: voucher.ledgerId,
            code: voucherCode,
            amount: roundPosMoney(voucher.amount),
            balanceAfter: roundPosMoney(voucher.balanceAfter),
          }]
          : (Array.isArray(order.giftVoucherApplications) ? order.giftVoucherApplications : []);
        const paymentTenders = [
          ...(voucherAmount > 0 ? [{
            type: 'gift_voucher',
            code: voucherCode || cleanPosCode(order.giftVoucherCode || ''),
            amount: voucherAmount,
            ledgerId: voucher?.ledgerId || '',
          }] : []),
          ...(nonVoucherPaidAmount > 0 ? [{
            type: paymentMethod || 'cash',
            amount: nonVoucherPaidAmount,
          }] : []),
        ];
        const now = admin.firestore.FieldValue.serverTimestamp();
        const update = {
          manualDiscount: financials.manualDiscount,
          promoDiscount: financials.promoDiscount,
          promotionDiscount: financials.promoDiscount,
          normalDiscount: financials.orderDiscount,
          orderDiscount: financials.orderDiscount,
          discount: financials.totalDiscount,
          totalBeforeLoyalty: financials.totalBeforeLoyalty,
          loyaltyDiscount: financials.loyaltyDiscount,
          total: financials.totalAfterLoyalty,
          totalAmount: financials.totalAfterLoyalty,
          amountDue,
          balanceDue: amountDue,
          giftVoucherAmount: voucherAmount,
          voucherAmount,
          giftVoucherTenderedAmount: voucherAmount,
          paidWithoutVoucher: nonVoucherPaidAmount,
          nonVoucherPaidAmount,
          paidAmount,
          paid: paidAmount,
          changeAmount,
          change: changeAmount,
          paymentTenders,
          promotionApplications,
          promotion_applications: promotionApplications,
          promotionRedemptionIds: promotionApplications.map(item => item.redemptionId).filter(Boolean),
          giftVoucherApplications,
          gift_voucher_applications: giftVoucherApplications,
          giftVoucherLedgerIds: giftVoucherApplications.map(item => item.ledgerId).filter(Boolean),
          promoCode: promotion?.code || cleanPosCode(order.promoCode || ''),
          giftVoucherCode: voucherCode || cleanPosCode(order.giftVoucherCode || ''),
          posSaleAdjustments: {
            idempotencyKey: cleanString(body.idempotencyKey || body.idempotency_key || receiptNo, 180),
            promotionApplied: Boolean(promotion),
            giftVoucherApplied: Boolean(voucher),
            updatedBy: decoded.uid || '',
          },
          posSaleAdjustmentsStatus: 'synced',
          updatedAt: now,
          updatedBy: decoded.uid || '',
        };
        transaction.set(orderRef, update, { merge: true });
        return {
          orderId: orderRef.id,
          receiptNo,
          promotion,
          voucher,
          totals: {
            subtotal: financials.subtotal,
            lineDiscount: financials.lineDiscount,
            manualDiscount: financials.manualDiscount,
            promoDiscount: financials.promoDiscount,
            discount: financials.totalDiscount,
            totalBeforeLoyalty: financials.totalBeforeLoyalty,
            loyaltyDiscount: financials.loyaltyDiscount,
            totalAmount: financials.totalAfterLoyalty,
            voucherAmount,
            amountDue,
            paidAmount,
            nonVoucherPaidAmount,
            changeAmount,
          },
        };
      });

      let finalResult = result;
      if (voucherCode && promoCode) {
        const requestedVoucherAmount = Math.min(
          Math.max(0, firstFiniteNumber([
            body.voucherAmount,
            body.giftVoucherAmount,
            body.amount,
            body.amountDue,
            body.amount_due,
            result.totals?.totalAmount,
          ], result.totals?.totalAmount || 0)),
          result.totals?.totalAmount || 0
        );
        if (requestedVoucherAmount > 0) {
          const voucher = await promotionsEngine.redeemGiftVoucher(db, {
            voucher_code: voucherCode,
            source_type: 'POS_RECEIPT',
            source_id: result.receiptNo,
            order_id: orderRef.id,
            receipt_no: result.receiptNo,
            amount: requestedVoucherAmount,
            idempotency_key: safeLedgerKey(body.idempotencyKey || body.idempotency_key || `${result.receiptNo}-voucher`),
            branch_id: cleanString(body.branch_id || body.branchId || 'pos', 80),
            actor_uid: decoded.uid || '',
          }, context);
          const voucherAmount = roundPosMoney(voucher.amount);
          const amountDue = roundPosMoney(Math.max(0, (result.totals?.totalAmount || 0) - voucherAmount));
          const paymentMethod = cleanString(body.paymentMethod || 'cash', 40);
          const nonVoucherPaidAmount = roundPosMoney(Math.max(0, firstFiniteNumber([
            body.nonVoucherPaidAmount,
            body.paidWithoutVoucher,
            amountDue,
          ], amountDue)));
          const paidAmount = roundPosMoney(Math.max(result.totals?.totalAmount || 0, nonVoucherPaidAmount + voucherAmount));
          const changeAmount = paymentMethod === 'cash'
            ? roundPosMoney(Math.max(0, nonVoucherPaidAmount - amountDue))
            : 0;
          const giftVoucherApplications = [{
            voucherId: voucher.voucherId,
            ledgerId: voucher.ledgerId,
            code: voucherCode,
            amount: voucherAmount,
            balanceAfter: roundPosMoney(voucher.balanceAfter),
          }];
          const paymentTenders = [
            {
              type: 'gift_voucher',
              code: voucherCode,
              amount: voucherAmount,
              ledgerId: voucher.ledgerId || '',
            },
            ...(nonVoucherPaidAmount > 0 ? [{
              type: paymentMethod || 'cash',
              amount: nonVoucherPaidAmount,
            }] : []),
          ];
          await orderRef.set({
            amountDue,
            balanceDue: amountDue,
            giftVoucherAmount: voucherAmount,
            voucherAmount,
            giftVoucherTenderedAmount: voucherAmount,
            paidWithoutVoucher: nonVoucherPaidAmount,
            nonVoucherPaidAmount,
            paidAmount,
            paid: paidAmount,
            changeAmount,
            change: changeAmount,
            paymentTenders,
            giftVoucherCode: voucherCode,
            giftVoucherApplications,
            gift_voucher_applications: giftVoucherApplications,
            giftVoucherLedgerIds: [voucher.ledgerId].filter(Boolean),
            posSaleAdjustments: {
              idempotencyKey: cleanString(body.idempotencyKey || body.idempotency_key || result.receiptNo, 180),
              promotionApplied: Boolean(result.promotion),
              giftVoucherApplied: true,
              updatedBy: decoded.uid || '',
            },
            posSaleAdjustmentsStatus: 'synced',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: decoded.uid || '',
          }, { merge: true });
          finalResult = {
            ...result,
            voucher,
            totals: {
              ...(result.totals || {}),
              voucherAmount,
              amountDue,
              paidAmount,
              nonVoucherPaidAmount,
              changeAmount,
            },
          };
        }
      }

      logger.info('POS sale adjustments applied', {
        orderId: finalResult.orderId,
        receiptNo: finalResult.receiptNo,
        promoApplied: Boolean(finalResult.promotion),
        voucherApplied: Boolean(finalResult.voucher),
      });
      res.status(200).json({ ok: true, status: 'synced', ...finalResult });
    } catch (error) {
      const result = publicPosPromotionError(error, 'Unable to apply POS promo or gift voucher.');
      logger.warn('POS sale adjustment failed', {
        orderPath: orderRef?.path || '',
        message: error.message,
        status: result.status,
      });
      res.status(result.status).json(result.body);
    }
  }
);

function normalizePosMemberPhone(value) {
  const raw = cleanString(value || '', 40);
  const digits = raw.replace(/\D/g, '');
  let local = digits;
  if (local.startsWith('66') && local.length >= 11) local = '0' + local.slice(2);
  if (!local && raw.startsWith('+66')) local = '0' + raw.replace(/\D/g, '').slice(2);
  const e164 = normalizeThaiPhoneForMemberIndex(raw || local);
  return {
    raw,
    local,
    e164,
    display: local || raw || (e164 ? displayThaiPhone(e164) : ''),
  };
}

function posMemberPayloadFromBody(body = {}, existing = {}, decoded = {}, uid = '') {
  const phone = normalizePosMemberPhone(body.phone || existing.phone || existing.phone_display || existing.phone_number || '');
  const displayName = firstCleanString([
    body.displayName,
    body.name,
    existing.displayName,
    existing.name,
    phone.display ? `ลูกค้า ${phone.display}` : '',
  ], 120);
  const email = normalizePublicEmail(body.email || existing.email || '');
  const memberCode = firstCleanString([
    existing.memberCode,
    authMemberCode(uid),
  ], 40);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const payload = {
    displayName,
    name: displayName,
    display_name: displayName,
    email,
    email_lower: email,
    phone: phone.display,
    phoneNormalized: phone.local,
    phone_display: phone.display,
    lineId: cleanString(body.lineId || existing.lineId || '', 80),
    updatedAt: now,
    updated_at: now,
    updatedBy: decoded.uid || '',
    updatedByEmail: cleanString(decoded.email || '', 180),
    source: cleanString(existing.source || body.source || 'pos', 40),
    registrationSource: cleanString(existing.registrationSource || 'pos', 40),
  };

  if (phone.e164) {
    payload.phoneE164 = phone.e164;
    payload.phone_number = phone.e164;
    payload.loginUsername = phone.e164;
  }
  if (memberCode) payload.memberCode = memberCode;
  if (!existing.tier) payload.tier = 'Silver';
  if (!existing.status) payload.status = 'active';
  if (existing.points === undefined) payload.points = 0;
  if (existing.totalSpent === undefined) payload.totalSpent = 0;
  if (existing.visitCount === undefined) payload.visitCount = 0;

  return payload;
}

function publicPosMemberProfile(uid, data = {}) {
  const phone = normalizePosMemberPhone(data.phone || data.phone_display || data.phone_number || data.phoneE164 || '');
  return {
    uid,
    displayName: cleanString(data.displayName || data.name || data.display_name || data.email || 'Eden Member', 120),
    email: cleanString(data.email || '', 180),
    phone: phone.display,
    phoneNormalized: phone.local,
    lineId: cleanString(data.lineId || '', 80),
    tier: cleanString(data.tier || 'Silver', 30),
    memberCode: cleanString(data.memberCode || uid.slice(0, 12), 40),
    points: Number(data.points || 0),
    totalSpent: Number(data.totalSpent || 0),
    visitCount: Number(data.visitCount || 0),
    profileSynced: true,
    source: 'eden',
    updatedAt: new Date().toISOString(),
  };
}

function publicPosMemberSummary(uid, userData = {}, summaryData = {}) {
  const profile = publicPosMemberProfile(uid, userData);
  const points = summaryData.pointsBalance !== undefined
    ? Number(summaryData.pointsBalance || 0)
    : profile.points;
  return {
    ...profile,
    points,
    totalSpent: Number(summaryData.totalSpent ?? profile.totalSpent ?? 0),
    visitCount: Number(summaryData.visitCount ?? profile.visitCount ?? 0),
    tier: cleanString(summaryData.tier || profile.tier || 'Silver', 30),
  };
}

async function enrichPosMemberProfiles(memberDocs = []) {
  const summarySnaps = await Promise.all(
    memberDocs.map(memberDoc =>
      db.collection('member_summaries').doc(memberDoc.id).get().catch(() => null)
    )
  );

  return memberDocs.map((memberDoc, index) => {
    const userData = memberDoc.data() || {};
    const summarySnap = summarySnaps[index];
    const summaryData = summarySnap && summarySnap.exists ? summarySnap.data() || {} : {};
    return publicPosMemberSummary(memberDoc.id, userData, summaryData);
  });
}

function posMemberSearchScore(member = {}, query = '', digits = '') {
  if (!query && !digits) return 1;
  const haystack = [
    member.uid,
    member.displayName,
    member.email,
    member.phone,
    member.phoneNormalized,
    member.lineId,
    member.memberCode,
    member.tier,
  ].filter(Boolean).join(' ').toLowerCase();

  let score = haystack.includes(query) ? 80 : 0;
  if (digits && String(member.phoneNormalized || '').includes(digits)) score += 140;
  if (digits && String(member.phone || '').replace(/\D/g, '').includes(digits)) score += 120;
  if (query && String(member.memberCode || '').toLowerCase() === query) score += 180;
  if (query && String(member.email || '').toLowerCase() === query) score += 160;
  if (query && String(member.displayName || '').toLowerCase().includes(query)) score += 100;
  if ((member.points || 0) > 0) score += 12;
  if ((member.totalSpent || 0) > 0) score += 8;
  return score;
}

exports.searchPosMembers = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 60, memory: '256MiB' },
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
      const search = cleanString(body.search || body.query || '', 160).toLowerCase();
      const phone = normalizePosMemberPhone(body.phone || search);
      const digits = phone.local || String(search || '').replace(/\D/g, '');
      const limitCount = Math.min(Math.max(Number(body.limitCount || 250), 1), 500);
      checkRateLimitKey(`search-pos-members:${decoded.uid || clientIp(req)}`, 240, 60 * 60 * 1000);

      const queryPromises = [];
      const addQuery = (field, value, size = limitCount) => {
        const cleanValue = cleanString(value || '', 180);
        if (!cleanValue) return;
        queryPromises.push(db.collection('users').where(field, '==', cleanValue).limit(Math.min(size, limitCount)).get());
      };

      if (digits) {
        addQuery('phoneNormalized', digits);
        addQuery('phone', phone.display || digits);
      }
      if (phone.e164) {
        addQuery('phone_number', phone.e164);
        addQuery('phoneE164', phone.e164);
        addQuery('loginUsername', phone.e164);
      }
      if (search && search.includes('@')) {
        addQuery('email_lower', normalizePublicEmail(search));
        addQuery('email', normalizePublicEmail(search));
      }
      if (/^ed-/i.test(search)) {
        addQuery('memberCode', search.toUpperCase());
      }

      queryPromises.push(db.collection('users').limit(limitCount).get());

      const querySnaps = await Promise.all(queryPromises.map(promise => promise.catch(() => null)));
      const byId = new Map();
      querySnaps.forEach(snap => {
        if (!snap) return;
        snap.docs.forEach(memberDoc => {
          const data = memberDoc.data() || {};
          const status = String(data.status || 'active').toLowerCase();
          if (['deleted', 'disabled', 'blocked'].includes(status)) return;
          byId.set(memberDoc.id, memberDoc);
        });
      });

      const members = await enrichPosMemberProfiles(Array.from(byId.values()));
      const filtered = members
        .map(member => ({
          member,
          score: posMemberSearchScore(member, search, digits),
        }))
        .filter(row => !search && !digits ? true : row.score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          const codeA = a.member.memberCode || '';
          const codeB = b.member.memberCode || '';
          return codeA && codeB && codeA !== codeB
            ? codeA.localeCompare(codeB, 'th')
            : String(a.member.displayName || '').localeCompare(String(b.member.displayName || ''), 'th');
        })
        .slice(0, limitCount)
        .map(row => row.member);

      res.status(200).json({ ok: true, members: filtered });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('POS member search failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to search POS members');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.getPosMemberLoyaltySummary = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const decoded = await requireAdminAccess(req, 'pos');
      const uid = cleanString((req.body || {}).uid || (req.body || {}).customerUid || '', 180);
      if (!uid) {
        const error = new Error('Member UID is required');
        error.statusCode = 400;
        throw error;
      }
      checkRateLimitKey(`get-pos-member-summary:${decoded.uid || clientIp(req)}`, 240, 60 * 60 * 1000);

      const [memberSnap, summarySnap] = await Promise.all([
        db.collection('users').doc(uid).get(),
        db.collection('member_summaries').doc(uid).get(),
      ]);
      const member = memberSnap.exists ? memberSnap.data() || {} : {};
      const summary = summarySnap.exists ? summarySnap.data() || {} : {};
      const publicMember = publicPosMemberSummary(uid, member, summary);

      res.status(200).json({
        ok: true,
        summary: {
          customerUid: uid,
          pointsBalance: publicMember.points,
          tier: publicMember.tier,
          totalSpent: publicMember.totalSpent,
          visitCount: publicMember.visitCount,
        },
      });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('POS member loyalty summary failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to load POS member loyalty summary');
      res.status(status).json({ error: publicError.message });
    }
  }
);

async function resolvePosMemberUid(body = {}) {
  const requestedUid = cleanString(body.uid || '', 180);
  if (requestedUid) return requestedUid;

  const phone = normalizePosMemberPhone(body.phone || '');
  const email = normalizePublicEmail(body.email || '');
  const candidates = [];

  if (phone.local) {
    candidates.push(db.collection('users').where('phoneNormalized', '==', phone.local).limit(1).get());
    candidates.push(db.collection('users').where('phone', '==', phone.display).limit(1).get());
  }
  if (phone.e164) {
    candidates.push(db.collection('users').where('phone_number', '==', phone.e164).limit(1).get());
    candidates.push(db.collection('users').where('phoneE164', '==', phone.e164).limit(1).get());
  }
  if (email) {
    candidates.push(db.collection('users').where('email_lower', '==', email).limit(1).get());
  }

  const results = await Promise.all(candidates.map(queryPromise => queryPromise.catch(() => null)));
  for (const snap of results) {
    if (snap && !snap.empty) return snap.docs[0].id;
  }

  if (phone.local) return `pos-phone-${phone.local}`;
  if (email) return `pos-email-${sha256(email).slice(0, 16)}`;
  return `pos-member-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

exports.upsertPosMemberProfile = onRequest(
  { region: 'asia-southeast1', timeoutSeconds: 60, memory: '256MiB' },
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
      const uid = await resolvePosMemberUid(body);
      const phone = normalizePosMemberPhone(body.phone || '');
      const displayName = firstCleanString([body.displayName, body.name], 120);

      if (!uid) {
        const error = new Error('Member UID is required');
        error.statusCode = 400;
        throw error;
      }
      if (!displayName && !phone.local && !normalizePublicEmail(body.email || '')) {
        const error = new Error('Member name, phone, or email is required');
        error.statusCode = 400;
        throw error;
      }

      checkRateLimitKey(`upsert-pos-member:${decoded.uid || clientIp(req)}`, 120, 60 * 60 * 1000);

      const memberRef = db.collection('users').doc(uid);
      const memberSnap = await memberRef.get();
      const existing = memberSnap.exists ? memberSnap.data() || {} : {};
      const now = admin.firestore.FieldValue.serverTimestamp();
      const payload = posMemberPayloadFromBody(body, existing, decoded, uid);

      await memberRef.set({
        uid,
        ...payload,
        ...(memberSnap.exists ? {} : {
          createdAt: now,
          created_at: now,
          createdBy: decoded.uid || '',
          createdByEmail: cleanString(decoded.email || '', 180),
        }),
      }, { merge: true });

      const savedSnap = await memberRef.get();
      res.status(200).json({
        ok: true,
        member: publicPosMemberProfile(uid, savedSnap.data() || {}),
      });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('POS member profile upsert failed', { message: error.message, status });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to save POS member profile');
      res.status(status).json({ error: publicError.message });
    }
  }
);

function cloudFunctionUrl(functionName) {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'edencafe-d9095';
  return `https://asia-southeast1-${projectId}.cloudfunctions.net/${functionName}`;
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

    let orderRef = null;
    let idempotencyKey = '';
    let receiptNo = '';
    let orderId = '';

    try {
      const decoded = await requireAdminAccess(req, 'pos');
      const body = req.body || {};
      const requestedOrderId = cleanString(body.orderId || '', 180);
      const firestoreId = cleanString(body.firestoreId || '', 180);
      orderId = cleanString(requestedOrderId || firestoreId || '', 180);
      receiptNo = cleanString(body.receiptNo || orderId, 120);
      const customerUid = cleanString(body.customerUid || '', 180);
      idempotencyKey = safeLedgerKey(body.idempotencyKey || receiptNo || orderId);
      const netAmount = Math.max(0, Number(body.netAmount || 0));
      const subtotal = Math.max(0, Number(body.subtotal || 0));
      const requestedRedeemedPoints = Math.max(0, Math.trunc(Number(body.redeemedPoints || 0)));
      const items = normalizePosSaleItems(body.items || []);
      const orderDiscount = resolvePosOrderDiscount({
        orderDiscount: body.orderDiscount,
        normalDiscount: body.normalDiscount,
        discount: body.discount,
        subtotal,
        netAmount,
        items,
      });
      const requestSkipReason =
        normalizePosLoyaltySkipReason(body.loyaltySkipReason) ||
        posLoyaltySkipReasonFor({
          customerUid,
          customerProfileSynced: body.customerProfileSynced,
          isTestOrder: body.isTestOrder,
          softLaunch: body.softLaunch,
        });
      const orderLookup = await resolvePosOrderRef(requestedOrderId || orderId, firestoreId, receiptNo);
      orderRef = orderLookup.ref;

      logger.info('POS loyalty sale start', {
        requestedOrderId,
        firestoreId,
        resolvedOrderId: orderRef?.id || '',
        receiptNo,
        customerUid,
        idempotencyKey,
        orderLookupSource: orderLookup.source,
      });

      if (!orderId && !orderRef) {
        const error = new Error('Order ID is required');
        error.statusCode = 400;
        throw error;
      }
      if (!receiptNo) {
        const error = new Error('Receipt number is required');
        error.statusCode = 400;
        throw error;
      }
      if (!orderRef) {
        const error = new Error('Synced order was not found');
        error.statusCode = 404;
        throw error;
      }
      orderId = orderRef.id;

      if (requestSkipReason) {
        const resultPayload = posLoyaltySkippedPayload({
          customerUid,
          idempotencyKey,
          reason: requestSkipReason,
        });
        await orderRef.set(posLoyaltySkippedOrderPatch(resultPayload, idempotencyKey), { merge: true });
        logger.info('POS loyalty sale skipped before ledger apply', {
          orderId,
          receiptNo,
          customerUid,
          idempotencyKey,
          reason: requestSkipReason,
        });
        res.status(200).json({
          ok: true,
          status: 'skipped',
          loyalty: resultPayload,
        });
        return;
      }
      if (netAmount <= 0) {
        const error = new Error('Net amount must be greater than zero');
        error.statusCode = 400;
        throw error;
      }

      const userRef = db.collection('users').doc(customerUid);
      const summaryRef = db.collection('member_summaries').doc(customerUid);
      const loyaltyRef = db.collection('site_settings').doc('loyalty');
      const earnLedgerRef = db.collection('point_ledger').doc(`pos-earn-${idempotencyKey}`);
      const redeemLedgerRef = db.collection('point_ledger').doc(`pos-redeem-${idempotencyKey}`);
      let resultPayload = null;
      let resultStatus = 'synced';

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
        const order = orderSnap.data() || {};
        if (cleanString(order.customerUid || '', 180) && cleanString(order.customerUid || '', 180) !== customerUid) {
          const error = new Error('Customer UID does not match synced order');
          error.statusCode = 400;
          throw error;
        }
        const orderSkipReason = posLoyaltySkipReasonFor({
          customerUid,
          customerProfileSynced: order.customerProfileSynced,
          isTestOrder: order.isTestOrder === true || body.isTestOrder === true,
          softLaunch: order.softLaunch === true || body.softLaunch === true,
        });
        if (orderSkipReason) {
          resultPayload = posLoyaltySkippedPayload({
            customerUid,
            idempotencyKey,
            reason: orderSkipReason,
          });
          resultStatus = 'skipped';
          transaction.set(orderRef, posLoyaltySkippedOrderPatch(resultPayload, idempotencyKey), { merge: true });
          logger.info('POS loyalty sale skipped', {
            orderId,
            receiptNo,
            customerUid,
            idempotencyKey,
            reason: orderSkipReason,
          });
          return;
        }
        if (!userSnap.exists) {
          const error = new Error('Member profile was not found');
          error.statusCode = 404;
          throw error;
        }
        if (
          order.loyaltySyncStatus === 'synced' &&
          order.loyaltyIdempotencyKey === idempotencyKey &&
          order.loyalty
        ) {
          resultPayload = order.loyalty;
          resultStatus = 'already_applied';
          logger.info('POS loyalty sale already applied', {
            orderId,
            receiptNo,
            customerUid,
            idempotencyKey,
          });
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
          resultStatus = 'already_applied';
          transaction.set(orderRef, {
            loyalty: resultPayload,
            loyaltySyncStatus: 'synced',
            loyaltyError: '',
            loyaltyIdempotencyKey: idempotencyKey,
            loyaltySyncedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          logger.info('POS loyalty sale ledger already exists', {
            orderId,
            receiptNo,
            customerUid,
            idempotencyKey,
            earnLedgerExists: earnLedgerSnap.exists,
            redeemLedgerExists: redeemLedgerSnap.exists,
          });
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
        const saleCalc = loyaltyFormula.calculatePosLoyaltySale({
          config,
          member,
          summary: summarySnap.exists ? summary : {},
          items,
          subtotal,
          netAmount,
          orderDiscount,
          requestedRedeemedPoints,
        });
        const {
          earnedPoints,
          redeemedPoints,
          loyaltyDiscount,
          payableAmount,
          pointsBefore,
          pointsAfter,
          tier,
          eligibleAmount: eligibleSubtotal,
          earnBase,
          totalSpentAfter,
          visitCountAfter,
          summaryTotalSpent,
          summaryVisitCount,
          summaryLifetimeBase,
          summaryTotalRedeemed,
        } = saleCalc;
        const now = admin.firestore.FieldValue.serverTimestamp();
        const syncedAt = new Date().toISOString();
        const memberCode = cleanString(member.memberCode || '', 80);
        const memberName = cleanString(member.displayName || member.name || member.customerName || 'Eden Member', 160);
        const memberEmail = cleanString(member.email || '', 180);

        resultPayload = {
          customerUid,
          earnedPoints,
          redeemedPoints,
          loyaltyDiscount,
          pointsBefore,
          pointsAfter,
          tier,
          eligibleAmount: eligibleSubtotal,
          earnBase,
          idempotencyKey,
          ledgerIds: {
            earn: earnedPoints > 0 ? earnLedgerRef.id : '',
            redeem: redeemedPoints > 0 ? redeemLedgerRef.id : '',
          },
          syncedAt,
        };

        if (redeemedPoints > 0) {
          transaction.set(redeemLedgerRef, {
            userId: customerUid,
            memberCode,
            memberName,
            memberEmail,
            type: 'pos_redeem',
            pointsDelta: -redeemedPoints,
            pointsBefore,
            pointsAfter: pointsBefore - redeemedPoints,
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
            pointsBefore: pointsBefore - redeemedPoints,
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
          totalRedeemed: summaryTotalRedeemed + redeemedPoints,
          totalSpent: summaryTotalSpent + payableAmount,
          visitCount: summaryVisitCount + 1,
          lastLedgerId:
            earnedPoints > 0
              ? earnLedgerRef.id
              : redeemedPoints > 0
                ? redeemLedgerRef.id
                : cleanString(summary.lastLedgerId || '', 180),
          updatedAt: now,
        }, { merge: true });

        transaction.set(orderRef, {
          loyalty: resultPayload,
          earnedPoints,
          redeemedPoints,
          loyaltyDiscount,
          normalDiscount: orderDiscount,
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
      res.status(resultStatus === 'synced' ? 201 : 200).json({
        ok: true,
        status: resultStatus,
        loyalty: resultPayload,
      });
    } catch (error) {
      const status = error.statusCode || 500;
      const statusUpdated = await markPosLoyaltyFailed(orderRef, error, idempotencyKey);
      logger.warn('POS loyalty sale failed', {
        orderId,
        receiptNo,
        idempotencyKey,
        message: error.message,
        status,
        statusUpdated,
      });
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to apply loyalty sale.');
      res.status(status).json({ error: publicError.message });
    }
  }
);

exports.adminRetryPosLoyaltySale = onRequest(
  { region: 'asia-southeast1' },
  async (req, res) => {
    if (handleOptions(req, res)) return;
    setCors(req, res);

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    let orderRef = null;
    let idempotencyKey = '';
    let receiptNo = '';

    try {
      await requireAdminAccess(req, 'pos');
      const body = req.body || {};
      const requestedOrderId = cleanString(body.orderId || body.firestoreId || '', 180);
      receiptNo = cleanString(body.receiptNo || '', 120);

      if (!requestedOrderId && !receiptNo) {
        const error = new Error('Order ID or receipt number is required');
        error.statusCode = 400;
        throw error;
      }

      const orderLookup = await resolvePosOrderRef(requestedOrderId, requestedOrderId, receiptNo);
      orderRef = orderLookup.ref;
      if (!orderRef) {
        const error = new Error('POS order was not found');
        error.statusCode = 404;
        throw error;
      }

      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) {
        const error = new Error('POS order was not found');
        error.statusCode = 404;
        throw error;
      }

      const order = orderSnap.data() || {};
      receiptNo = cleanString(order.receiptNo || order.number || order.orderNumber || receiptNo || orderRef.id, 120);
      idempotencyKey = safeLedgerKey(order.loyaltyIdempotencyKey || order.idempotencyKey || receiptNo || orderRef.id);
      const source = cleanString(order.source || '', 40).toLowerCase();

      logger.info('Admin POS loyalty retry start', {
        requestedOrderId,
        resolvedOrderId: orderRef.id,
        receiptNo,
        idempotencyKey,
        lookupSource: orderLookup.source,
        source,
        loyaltySyncStatus: cleanString(order.loyaltySyncStatus || '', 40),
      });

      if (source !== 'pos') {
        const error = new Error('Only POS orders can be retried');
        error.statusCode = 400;
        throw error;
      }

      const retrySkipReason =
        normalizePosLoyaltySkipReason(order.loyaltySkipReason || order.loyalty?.reason || order.loyaltyError) ||
        posLoyaltySkipReasonFor({
          customerUid: order.customerUid,
          customerProfileSynced: order.customerProfileSynced,
          isTestOrder: order.isTestOrder === true,
          softLaunch: order.softLaunch === true,
        });

      if (retrySkipReason) {
        const resultPayload = posLoyaltySkippedPayload({
          customerUid: order.customerUid,
          idempotencyKey,
          reason: retrySkipReason,
        });
        await orderRef.set(posLoyaltySkippedOrderPatch(resultPayload, idempotencyKey), { merge: true });
        logger.info('Admin POS loyalty retry skipped non-retryable order', {
          orderId: orderRef.id,
          receiptNo,
          idempotencyKey,
          reason: retrySkipReason,
        });
        res.status(200).json({
          ok: true,
          status: 'skipped',
          orderId: orderRef.id,
          receiptNo,
          idempotencyKey,
          loyalty: resultPayload,
        });
        return;
      }

      const payload = buildTrustedPosLoyaltyPayload(orderRef, order);
      const header = req.get('authorization') || '';
      const response = await fetch(cloudFunctionUrl('applyPosLoyaltySale'), {
        method: 'POST',
        headers: {
          Authorization: header,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        logger.warn('Admin POS loyalty retry failed through applyPosLoyaltySale', {
          orderId: orderRef.id,
          receiptNo,
          idempotencyKey,
          status: response.status,
          message: result.error || '',
        });
        res.status(response.status).json({
          ok: false,
          error: result.error || 'POS loyalty retry failed',
          orderId: orderRef.id,
          receiptNo,
          idempotencyKey,
        });
        return;
      }

      logger.info('Admin POS loyalty retry completed', {
        orderId: orderRef.id,
        receiptNo,
        idempotencyKey,
        status: result.status || 'synced',
      });
      res.status(200).json({
        ok: true,
        status: result.status || 'synced',
        orderId: orderRef.id,
        receiptNo,
        idempotencyKey,
        loyalty: result.loyalty || null,
      });
    } catch (error) {
      const status = error.statusCode || 500;
      const publicError = publicApiError({ ...error, statusCode: status }, 'Unable to retry POS loyalty sale.');
      logger.warn('Admin POS loyalty retry request failed', {
        orderPath: orderRef?.path || '',
        receiptNo,
        idempotencyKey,
        message: error.message,
        status,
      });
      res.status(status).json({ error: publicError.message });
    }
  }
);

// Eden Archery Booking V1 backend implementation.
// These exports intentionally override older monolithic archery handlers above.
const archeryAvailabilityV1 = require('./archery/availability');
const archeryBookingHoldV1 = require('./archery/bookingHold');
const archeryConfirmV1 = require('./archery/confirmBooking');
const archeryWalkinV1 = require('./archery/walkin');
const archeryCancelV1 = require('./archery/cancel');
const archeryAdminActionsV1 = require('./archery/adminActions');
const archeryStaffSessionV1 = require('./archery/staffSession');
const archeryPaymentsV1 = require('./payments');
const archeryScheduledV1 = require('./scheduled');
const promotionsV1 = require('./promotions');

exports.getArcheryAvailability = archeryAvailabilityV1.getArcheryAvailability;
exports.createArcheryHold = archeryBookingHoldV1.createArcheryHold;
exports.createBookingHold = archeryBookingHoldV1.createArcheryHold;
exports.confirmArcheryBooking = archeryConfirmV1.confirmArcheryBooking;
exports.startArcheryStaffSession = archeryStaffSessionV1.startArcheryStaffSession;
exports.createWalkInArcheryBooking = archeryWalkinV1.createWalkInArcheryBooking;
exports.createWalkInBooking = archeryWalkinV1.createWalkInArcheryBooking;
exports.requestCancelBooking = archeryCancelV1.requestCancelBooking;
exports.approveCancelBooking = archeryCancelV1.approveCancelBooking;
exports.adminCancelBooking = archeryCancelV1.requestCancelBooking;
exports.adminCheckInBooking = archeryAdminActionsV1.adminCheckInBooking;
exports.adminCompleteBooking = archeryAdminActionsV1.adminCompleteBooking;
exports.adminMoveBookingLane = archeryAdminActionsV1.adminMoveBookingLane;
exports.adminExtendBooking = archeryAdminActionsV1.adminExtendBooking;
exports.adminMarkNoShow = archeryAdminActionsV1.adminMarkNoShow;
exports.recordCounterPayment = archeryPaymentsV1.recordCounterPayment;
exports.refundPayment = archeryPaymentsV1.refundPayment;
exports.createBeamArcheryPayment = archeryPaymentsV1.createBeamArcheryPayment;
exports.beamArcheryPaymentWebhook = archeryPaymentsV1.beamArcheryPaymentWebhook;
exports.getArcheryPaymentStatus = archeryPaymentsV1.getArcheryPaymentStatus;
exports.reconcileBeamLatePayment = archeryPaymentsV1.reconcileBeamLatePayment;
exports.createShopOrderDraft = archeryPaymentsV1.createShopOrderDraft;
exports.createPaymentIntent = archeryPaymentsV1.createPaymentIntent;
exports.getPaymentStatus = archeryPaymentsV1.getPaymentStatus;
exports.listPaymentsForSource = archeryPaymentsV1.listPaymentsForSource;
exports.cancelPendingPayment = archeryPaymentsV1.cancelPendingPayment;
exports.requestRefund = archeryPaymentsV1.requestRefund;
exports.approveRefund = archeryPaymentsV1.approveRefund;
exports.reconcileLatePayment = archeryPaymentsV1.reconcileLatePayment;
exports.issueWebReceipt = archeryPaymentsV1.issueWebReceipt;
exports.paymentWebhook = archeryPaymentsV1.paymentWebhook;
exports.expireOldHolds = archeryScheduledV1.expireOldHolds;
exports.adminUpsertPromotion = promotionsV1.adminUpsertPromotion;
exports.adminDeletePromotion = promotionsV1.adminDeletePromotion;
exports.adminBulkGeneratePromotionCodes = promotionsV1.adminBulkGeneratePromotionCodes;
exports.adminUpsertGiftVoucher = promotionsV1.adminUpsertGiftVoucher;
exports.adminVoidGiftVoucher = promotionsV1.adminVoidGiftVoucher;
exports.adminBulkGenerateGiftVouchers = promotionsV1.adminBulkGenerateGiftVouchers;
exports.validatePromotion = promotionsV1.validatePromotion;
exports.reservePromotionRedemption = promotionsV1.reservePromotionRedemption;
exports.commitPromotionRedemption = promotionsV1.commitPromotionRedemption;
exports.redeemPromotionRedemption = promotionsV1.redeemPromotionRedemption;
exports.releasePromotionRedemption = promotionsV1.releasePromotionRedemption;
exports.validateGiftVoucher = promotionsV1.validateGiftVoucher;
exports.redeemGiftVoucher = promotionsV1.redeemGiftVoucher;
exports.refundGiftVoucher = promotionsV1.refundGiftVoucher;
