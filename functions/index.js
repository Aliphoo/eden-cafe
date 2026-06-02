const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const ftp = require('basic-ftp');
const { Readable } = require('stream');

admin.initializeApp();

const db = admin.firestore();
const SPACESHIP_FTP_SERVER = defineSecret('SPACESHIP_FTP_SERVER');
const SPACESHIP_FTP_USERNAME = defineSecret('SPACESHIP_FTP_USERNAME');
const SPACESHIP_FTP_PASSWORD = defineSecret('SPACESHIP_FTP_PASSWORD');
const GOOGLE_MAPS_SERVER_KEY = defineSecret('GOOGLE_MAPS_SERVER_KEY');

const PLACE_ID = 'ChIJVTN6cGwB1zAR66OQ_OBKRkM';
const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const REVIEW_LIMIT = 5;
const ADMIN_EMAILS = new Set([
  'admin@edencafe.com',
  'phoo1236@gmail.com',
  'sonsawan.1231@gmail.com',
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
  if (ALLOWED_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
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
  if (permission && access.permissions && access.permissions[permission] === true) return decoded;

  const error = new Error('Admin permission required');
  error.statusCode = 403;
  throw error;
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
    'tables',
    'rooms',
    'products',
    'shop',
    'blogs',
    'faqs',
    'promptpay',
    'marketing',
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

function authUserToMemberDoc(userRecord) {
  const providerIds = Array.isArray(userRecord.providerData)
    ? userRecord.providerData.map(provider => provider.providerId).filter(Boolean)
    : [];
  const authCreatedAt = timestampFromAuthDate(userRecord.metadata?.creationTime);
  const lastLoginAt = timestampFromAuthDate(userRecord.metadata?.lastSignInTime);

  const data = {
    uid: userRecord.uid,
    displayName: cleanString(userRecord.displayName || userRecord.email || 'Eden Member', 120),
    email: cleanString(userRecord.email || '', 180),
    photoURL: cleanString(userRecord.photoURL || '', 500),
    memberCode: authMemberCode(userRecord.uid),
    authProviderIds: providerIds,
    authDisabled: !!userRecord.disabled,
    emailVerified: !!userRecord.emailVerified,
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
  if (value === 'shop_products') return 'shop';
  if (value === 'blogs') return 'blogs';
  if (value === 'rooms') return 'rooms';
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
  if (!match) return '';
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    return decoded.uid || '';
  } catch (error) {
    logger.warn('Ignoring invalid booking auth token', { message: error.message });
    return '';
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

  if (verifiedUid) booking.uid = verifiedUid;
  if (raw.uid && verifiedUid) booking.uid = verifiedUid;

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
      res.status(500).json({ error: 'Unable to read table availability' });
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
      res.status(status).json({
        error: error.message || 'Booking create failed',
        conflictIds: error.conflictIds || [],
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
      res.status(status).json({ error: error.message || 'Spaceship image upload failed' });
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
      res.status(status).json({ error: error.message || 'Admin access user upsert failed' });
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
          synced++;
        }
        nextPageToken = result.pageToken;
      } while (nextPageToken);

      logger.info('Auth users synced to Firestore users', { synced, created, updated });
      res.json({ ok: true, synced, created, updated });
    } catch (error) {
      const status = error.statusCode || 500;
      logger.warn('Auth user sync failed', { message: error.message, status });
      res.status(status).json({ error: error.message || 'Auth user sync failed' });
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
      res.status(status).json({ error: error.message || 'Member point adjustment failed' });
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
      res.status(status).json({ error: error.message || 'POS loyalty sale failed' });
    }
  }
);
