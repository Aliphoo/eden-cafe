const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');
const {
  REGION,
  httpFunction,
  requireMember,
  requireRoles,
  requireStaffSession,
  sendError,
} = require('../security/authz');
const { runIdempotentTransaction, sha256 } = require('../shared/idempotency');
const { writeAuditLog } = require('../shared/audit');
const { FieldValue } = require('../shared/firestore');
const {
  SERVICE_TYPE,
  apiError,
  cleanString,
  normalizeBranchId,
  timestampToDate,
} = require('../shared/time');
const {
  queryLocksForBooking,
} = require('../shared/locks');
const {
  readArcheryLoyaltyState,
  writeArcheryLoyaltyState,
} = require('../archery/loyalty');
const {
  commitArcheryPromotionApplications,
  releaseArcheryPromotionApplications,
  archeryPromotionStatusUpdate,
} = require('../archery/promotions');
const {
  commitArcheryLoyaltyForBooking,
  releaseArcheryLoyaltyForBooking,
} = require('../archery/loyaltyRedemption');

const BEAM_API_KEY_SANDBOX = defineSecret('BEAM_API_KEY_SANDBOX');
const BEAM_WEBHOOK_SECRET_SANDBOX = defineSecret('BEAM_WEBHOOK_SECRET_SANDBOX');
const BEAM_MERCHANT_ID_SANDBOX = defineSecret('BEAM_MERCHANT_ID_SANDBOX');
const BEAM_API_KEY_PRODUCTION = defineSecret('BEAM_API_KEY_PRODUCTION');
const BEAM_WEBHOOK_SECRET_PRODUCTION = defineSecret('BEAM_WEBHOOK_SECRET_PRODUCTION');
const BEAM_MERCHANT_ID_PRODUCTION = defineSecret('BEAM_MERCHANT_ID_PRODUCTION');
const ARCHERY_PAYMENT_LIVE = defineSecret('ARCHERY_PAYMENT_LIVE');
const ARCHERY_PAYMENT_PROVIDER = defineSecret('ARCHERY_PAYMENT_PROVIDER');
const PAYMENT_ENV = defineSecret('PAYMENT_ENV');

const BEAM_RUNTIME_SECRETS = [
  BEAM_API_KEY_SANDBOX,
  BEAM_WEBHOOK_SECRET_SANDBOX,
  BEAM_MERCHANT_ID_SANDBOX,
  BEAM_API_KEY_PRODUCTION,
  BEAM_WEBHOOK_SECRET_PRODUCTION,
  BEAM_MERCHANT_ID_PRODUCTION,
  ARCHERY_PAYMENT_LIVE,
  ARCHERY_PAYMENT_PROVIDER,
  PAYMENT_ENV,
];

const ALLOWED_WEBHOOK_EVENTS = new Set([
  'payment_link.paid',
  'charge.succeeded',
  'charge.failed',
  'card_authorization.failed',
  'card_authorization.canceled',
]);
const SUCCESS_EVENTS = new Set(['payment_link.paid', 'charge.succeeded']);
const FAILED_EVENTS = new Set(['charge.failed', 'card_authorization.failed']);
const CANCELLED_EVENTS = new Set(['card_authorization.canceled']);

function envValue(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : String(value);
}

function secretValue(secret, name) {
  if (process.env[name]) return process.env[name];
  try {
    return secret.value();
  } catch (_) {
    return '';
  }
}

function runtimeValue(secret, name, fallback = '') {
  const value = secretValue(secret, name);
  return value == null || value === '' ? fallback : String(value);
}

function boolValue(value, fallback = false) {
  const normalized = String(value == null || value === '' ? (fallback ? 'true' : 'false') : value).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function paymentEnvironment() {
  return cleanString(runtimeValue(PAYMENT_ENV, 'PAYMENT_ENV', 'sandbox'), 40).toLowerCase() || 'sandbox';
}

function isPaymentLive() {
  return boolValue(runtimeValue(ARCHERY_PAYMENT_LIVE, 'ARCHERY_PAYMENT_LIVE', 'false'));
}

function assertBeamProvider() {
  const provider = cleanString(runtimeValue(ARCHERY_PAYMENT_PROVIDER, 'ARCHERY_PAYMENT_PROVIDER', 'BEAM'), 40).toUpperCase();
  if (provider !== 'BEAM') throw apiError('PAYMENT_PROVIDER_DISABLED', 400, 'Archery payment provider is not Beam');
  const env = paymentEnvironment();
  if (!['sandbox', 'production'].includes(env)) {
    throw apiError('PAYMENT_ENV_INVALID', 500, 'Beam payment environment is invalid');
  }
  const live = isPaymentLive();
  if (live && env !== 'production') {
    throw apiError('PAYMENT_ENV_LIVE_MISMATCH', 500, 'Live payments require PAYMENT_ENV=production');
  }
  if (!live && env === 'production') {
    throw apiError('PAYMENT_ENV_LIVE_MISMATCH', 500, 'Production payment environment requires ARCHERY_PAYMENT_LIVE=true');
  }
}

function beamConfig() {
  assertBeamProvider();
  const environment = paymentEnvironment();
  const production = environment === 'production';
  const merchantId = production
    ? secretValue(BEAM_MERCHANT_ID_PRODUCTION, 'BEAM_MERCHANT_ID_PRODUCTION')
    : secretValue(BEAM_MERCHANT_ID_SANDBOX, 'BEAM_MERCHANT_ID_SANDBOX');
  const apiKey = production
    ? secretValue(BEAM_API_KEY_PRODUCTION, 'BEAM_API_KEY_PRODUCTION')
    : secretValue(BEAM_API_KEY_SANDBOX, 'BEAM_API_KEY_SANDBOX');
  const webhookSecret = production
    ? secretValue(BEAM_WEBHOOK_SECRET_PRODUCTION, 'BEAM_WEBHOOK_SECRET_PRODUCTION')
    : secretValue(BEAM_WEBHOOK_SECRET_SANDBOX, 'BEAM_WEBHOOK_SECRET_SANDBOX');
  const apiBaseUrl = (
    production
      ? envValue('BEAM_API_BASE_URL_PRODUCTION', 'https://api.beamcheckout.com')
      : envValue('BEAM_API_BASE_URL_SANDBOX', 'https://playground.api.beamcheckout.com')
  ).replace(/\/+$/, '');
  if (!merchantId || !apiKey) {
    throw apiError('PAYMENT_PROVIDER_NOT_CONFIGURED', 500, `Beam ${environment} merchant ID/API key are not configured`);
  }
  return { merchantId, apiKey, webhookSecret, apiBaseUrl, environment, production };
}

function webhookConfig() {
  assertBeamProvider();
  const environment = paymentEnvironment();
  const production = environment === 'production';
  const merchantId = production
    ? secretValue(BEAM_MERCHANT_ID_PRODUCTION, 'BEAM_MERCHANT_ID_PRODUCTION')
    : secretValue(BEAM_MERCHANT_ID_SANDBOX, 'BEAM_MERCHANT_ID_SANDBOX');
  const webhookSecret = production
    ? secretValue(BEAM_WEBHOOK_SECRET_PRODUCTION, 'BEAM_WEBHOOK_SECRET_PRODUCTION')
    : secretValue(BEAM_WEBHOOK_SECRET_SANDBOX, 'BEAM_WEBHOOK_SECRET_SANDBOX');
  if (!merchantId || !webhookSecret) {
    throw apiError('PAYMENT_PROVIDER_NOT_CONFIGURED', 500, `Beam ${environment} merchant ID/webhook secret are not configured`);
  }
  return { merchantId, webhookSecret, environment, production };
}

function basicAuth(merchantId, apiKey) {
  return `Basic ${Buffer.from(`${merchantId}:${apiKey}`).toString('base64')}`;
}

function maskedValue(value) {
  const text = String(value || '');
  if (text.length <= 8) return text ? '****' : '';
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function beamAmount(amount) {
  return Math.max(0, Math.round((Number(amount) || 0) * 100));
}

function amountFromBooking(booking = {}) {
  return Number(booking.amount_total || booking.total_price || booking.amount || 0) || 0;
}

function publicBookingStatus(booking = {}) {
  return cleanString(booking.booking_status || booking.status, 40).toUpperCase();
}

function referenceIdForBooking(bookingId) {
  return `ARCHERY:${bookingId}`;
}

function bookingIdFromReference(referenceId = '') {
  const ref = cleanString(referenceId, 220);
  if (ref.startsWith('ARCHERY:')) return ref.slice('ARCHERY:'.length);
  return ref;
}

function paymentDocId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 40)}`;
}

function rawRequestBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  return Buffer.from(JSON.stringify(req.body || {}));
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyBeamSignature(req, webhookSecret) {
  const signature = cleanString(req.get('x-beam-signature') || req.get('X-Beam-Signature'), 500);
  if (!signature) throw apiError('WEBHOOK_SIGNATURE_REQUIRED', 401, 'Beam signature is required');
  const body = rawRequestBody(req);
  const rawExpected = crypto.createHmac('sha256', String(webhookSecret)).update(body).digest('base64');
  let base64Expected = '';
  try {
    base64Expected = crypto.createHmac('sha256', Buffer.from(String(webhookSecret), 'base64')).update(body).digest('base64');
  } catch (_) {
    base64Expected = '';
  }
  if (!timingSafeEqual(signature, rawExpected) && !timingSafeEqual(signature, base64Expected)) {
    throw apiError('WEBHOOK_SIGNATURE_INVALID', 401, 'Beam signature is invalid');
  }
  return signature;
}

function beamEvent(req) {
  return cleanString(req.get('x-beam-event') || req.get('X-Beam-Event'), 80);
}

function webhookIdentity(eventType, payload = {}) {
  if (payload.chargeId) return cleanString(payload.chargeId, 180);
  if (payload.paymentLinkId) return cleanString(payload.paymentLinkId, 180);
  if (payload.cardAuthorizationId) return cleanString(payload.cardAuthorizationId, 180);
  return paymentDocId('beam_event', `${eventType}:${JSON.stringify(payload)}`);
}

function webhookProviderRef(payload = {}) {
  return cleanString(payload.chargeId || payload.paymentLinkId || payload.cardAuthorizationId || payload.transactionId || payload.sourceId, 180);
}

function webhookReferenceId(payload = {}) {
  return cleanString(payload.referenceId || payload.order?.referenceId || payload.internalNote, 220);
}

function webhookCurrency(payload = {}) {
  return cleanString(payload.currency || payload.order?.currency, 10).toUpperCase();
}

function webhookAmount(payload = {}) {
  const raw = payload.amount ?? payload.order?.netAmount ?? payload.grossAmount;
  return Math.round(Number(raw) || 0);
}

function paymentMethodType(payload = {}) {
  const method = cleanString(payload.paymentMethod?.paymentMethodType, 80);
  if (method) return method;
  return payload.linkSettings?.qrPromptPay ? 'QR_PROMPT_PAY' : '';
}

function isTerminalPaidStatus(payload = {}) {
  const status = cleanString(payload.status || payload.latestChargeStatus, 60).toUpperCase();
  return status === 'PAID' || status === 'SUCCEEDED';
}

function sanitizePaymentForClient(payment = {}) {
  return {
    payment_id: payment.payment_id || '',
    booking_id: payment.booking_id || '',
    payment_status: payment.payment_status || payment.status || '',
    provider: payment.provider || 'BEAM',
    payment_environment: payment.payment_environment || 'sandbox',
    provider_ref: payment.provider_ref || '',
    beam_payment_link_id: payment.beam_payment_link_id || '',
    payment_link_url: payment.payment_link_url || '',
    amount: payment.amount || 0,
    currency: payment.currency || 'THB',
  };
}

function firstClean(maxLength, ...values) {
  for (const value of values) {
    const text = cleanString(value, maxLength);
    if (text) return text;
  }
  return '';
}

function contactPhone(...values) {
  const phone = firstClean(40, ...values);
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? phone : '';
}

function bookingContact(booking = {}) {
  return {
    customer_name: firstClean(120, booking.customer_name, booking.customerName, booking.name),
    customer_phone: contactPhone(booking.customer_phone, booking.customerPhone, booking.phone),
    customer_email: firstClean(180, booking.customer_email, booking.customerEmail, booking.email).toLowerCase(),
  };
}

function memberContact(member = {}) {
  const user = member.user || {};
  const summary = member.summary || {};
  return {
    customer_name: firstClean(
      120,
      user.displayName,
      user.display_name,
      user.name,
      summary.displayName,
      summary.display_name,
      summary.name,
      summary.memberName
    ),
    customer_phone: contactPhone(
      user.checkoutPhone,
      user.checkout_phone,
      user.contactPhone,
      user.contact_phone,
      user.phone,
      user.phone_display,
      user.phone_number,
      user.phoneNumber,
      user.phoneE164,
      summary.phone,
      summary.phone_display
    ),
    customer_email: firstClean(180, user.email, summary.email, summary.memberEmail).toLowerCase(),
  };
}

async function readMemberContact(transaction, db, memberId) {
  const safeMemberId = cleanString(memberId, 160);
  if (!safeMemberId) return {};
  const [userSnap, summarySnap] = await Promise.all([
    transaction.get(db.collection('users').doc(safeMemberId)),
    transaction.get(db.collection('member_summaries').doc(safeMemberId)),
  ]);
  return memberContact({
    user: userSnap.exists ? userSnap.data() || {} : {},
    summary: summarySnap.exists ? summarySnap.data() || {} : {},
  });
}

async function enrichBookingContact(transaction, db, booking = {}) {
  const sourceContact = bookingContact(booking);
  if (sourceContact.customer_phone && sourceContact.customer_name && sourceContact.customer_email) {
    return { ...booking, ...sourceContact };
  }
  const memberId = cleanString(booking.member_id || booking.uid || booking.customerUid, 160);
  const fallback = await readMemberContact(transaction, db, memberId);
  return {
    ...booking,
    customer_name: sourceContact.customer_name || fallback.customer_name || '',
    customer_phone: sourceContact.customer_phone || fallback.customer_phone || '',
    customer_email: sourceContact.customer_email || fallback.customer_email || '',
  };
}

async function readBookingForMember(transaction, db, branchId, bookingId, actor, staffSessionId = '') {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const bookingSnap = await transaction.get(bookingRef);
  if (!bookingSnap.exists) throw apiError('BOOKING_NOT_FOUND', 404, 'Booking was not found');
  const booking = bookingSnap.data() || {};
  if (booking.branch_id !== branchId || booking.service_type !== SERVICE_TYPE) {
    throw apiError('BOOKING_NOT_FOUND', 404, 'Archery booking was not found');
  }
  const memberId = cleanString(booking.member_id || booking.uid || booking.customerUid, 160);
  const sessionId = cleanString(staffSessionId, 180);
  if (sessionId) {
    await requireStaffSession(transaction, db, actor, branchId, sessionId);
  } else {
    requireMember(actor, memberId);
  }
  return { bookingRef, booking };
}

async function findBookingPayment(transaction, db, branchId, bookingId) {
  const snap = await transaction.get(
    db.collection('payments')
      .where('branch_id', '==', branchId)
      .where('booking_id', '==', bookingId)
      .where('provider', '==', 'BEAM')
      .limit(1)
  );
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { ref: docSnap.ref, data: docSnap.data() || {} };
}

async function createBeamPaymentLink(config, booking, bookingId, idempotencyKey) {
  const amount = amountFromBooking(booking);
  const amountMinor = beamAmount(amount);
  const contact = bookingContact(booking);
  const expiresAt = timestampToDate(booking.expires_at || booking.hold_expires_at || booking.holdExpiresAt)
    || new Date(Date.now() + (10 * 60 * 1000));
  const returnUrl = config.production
    ? envValue('BEAM_ARCHERY_RETURN_URL_PRODUCTION', 'https://edencafe.co/archery/booking/confirm')
    : envValue('BEAM_ARCHERY_RETURN_URL_SANDBOX', 'http://localhost:5000/archery/booking/confirm');
  const linkSettings = config.production ? {
    card: { isEnabled: false },
    cardInstallments: { isEnabled: false },
    eWallets: { isEnabled: false },
    mobileBanking: { isEnabled: false },
    qrPromptPay: { isEnabled: true },
    buyNowPayLater: { isEnabled: false },
  } : {
    card: { isEnabled: true },
    cardInstallments: {
      isEnabled: true,
      installments3m: { isEnabled: true },
      installments4m: { isEnabled: true },
      installments6m: { isEnabled: true },
      installments10m: { isEnabled: true },
    },
    eWallets: { isEnabled: true },
    mobileBanking: { isEnabled: true },
    qrPromptPay: { isEnabled: true },
    buyNowPayLater: { isEnabled: false },
  };
  const body = {
    collectDeliveryAddress: false,
    collectPhoneNumber: !contact.customer_phone,
    expiresAt: expiresAt.toISOString(),
    linkSettings,
    order: {
      currency: 'THB',
      description: `Eden Archery ${bookingId}`,
      internalNote: bookingId,
      netAmount: amountMinor,
      referenceId: referenceIdForBooking(bookingId),
      orderItems: [{
        itemName: cleanString(booking.package_code || 'Eden Archery', 80),
        productId: cleanString(booking.package_code || 'ARCHERY', 80),
        sku: cleanString(booking.package_code || 'ARCHERY', 80),
        quantity: 1,
        price: amountMinor,
        description: `${booking.duration_minutes || 0} minutes`,
      }],
    },
    redirectUrl: `${returnUrl}?id=${encodeURIComponent(bookingId)}`,
    feeType: 'TRANSACTION_FEE',
  };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: basicAuth(config.merchantId, config.apiKey),
    'x-beam-idempotency-key': idempotencyKey,
  };
  const partnerId = envValue('BEAM_PARTNER_ID_SANDBOX', '');
  if (partnerId) headers['X-Beam-Partner-ID'] = partnerId;

  const response = await fetch(`${config.apiBaseUrl}/api/v1/payment-links`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let result = {};
  try {
    result = await response.json();
  } catch (_) {
    result = {};
  }
  if (!response.ok) {
    logger.warn('Beam payment link create failed', {
      status: response.status,
      payment_environment: config.environment,
      endpoint_host: new URL(config.apiBaseUrl).host,
      merchant_id: maskedValue(config.merchantId),
      beam_error: result.error?.errorCode || result.error || result.message || '',
    });
    throw apiError('BEAM_PAYMENT_CREATE_FAILED', response.status || 502, `Unable to create Beam ${config.environment} payment link`, {
      status: response.status,
      beam_error: result.error || result.message || '',
    });
  }
  return {
    raw: result,
    amountMinor,
    collectPhoneNumber: body.collectPhoneNumber,
    customerName: contact.customer_name,
    customerPhone: contact.customer_phone,
    customerEmail: contact.customer_email,
    paymentLinkId: cleanString(result.id || result.paymentLinkId || result.payment_link_id, 180),
    paymentLinkUrl: cleanString(result.url || result.paymentLinkUrl || result.payment_link_url, 500),
  };
}

const createBeamArcheryPayment = httpFunction(async ({ db, data, actor, requestId }) => {
  const config = beamConfig();
  const branchId = normalizeBranchId(data.branch_id);
  const bookingId = cleanString(data.booking_id || data.bookingId, 180);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');
  if (!idempotencyKey) throw apiError('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotency_key is required');

  const bookingSnapshot = await db.runTransaction(async transaction => {
    const { booking: rawBooking } = await readBookingForMember(transaction, db, branchId, bookingId, actor, staffSessionId);
    const booking = await enrichBookingContact(transaction, db, rawBooking);
    const status = publicBookingStatus(booking);
    if (status !== 'HELD') throw apiError('BOOKING_STATE_DOES_NOT_ALLOW_ACTION', 409, 'Only HELD bookings can be paid online');
    const expiresAt = timestampToDate(booking.expires_at || booking.hold_expires_at || booking.holdExpiresAt);
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw apiError('HOLD_EXPIRED', 409, 'Booking hold has expired');
    const existing = await findBookingPayment(transaction, db, branchId, bookingId);
    if (existing?.data?.payment_link_url) {
      return { booking, existing: existing.data };
    }
    return { booking, existing: null };
  });

  if (bookingSnapshot.existing) {
    logger.info('Beam archery payment link reused', {
      branch_id: branchId,
      booking_id: bookingId,
      payment_id: bookingSnapshot.existing.payment_id || '',
      provider_ref: bookingSnapshot.existing.provider_ref || '',
      payment_status: bookingSnapshot.existing.payment_status || bookingSnapshot.existing.status || '',
      payment_environment: config.environment,
      request_id: requestId || '',
    });
    return {
      replayed: true,
      ...sanitizePaymentForClient(bookingSnapshot.existing),
    };
  }

  const beam = await createBeamPaymentLink(config, bookingSnapshot.booking, bookingId, idempotencyKey);
  const amount = amountFromBooking(bookingSnapshot.booking);
  const paymentId = paymentDocId('beam', `${branchId}:${bookingId}:${beam.paymentLinkId || idempotencyKey}`);

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'createBeamArcheryPayment',
    idempotencyKey,
    actorId: actor.uid,
    payload: {
      booking_id: bookingId,
      amount,
      beam_payment_link_id: beam.paymentLinkId,
      collect_phone_number: beam.collectPhoneNumber,
    },
  }, async transaction => {
    const { bookingRef, booking: rawBooking } = await readBookingForMember(transaction, db, branchId, bookingId, actor, staffSessionId);
    const booking = await enrichBookingContact(transaction, db, rawBooking);
    const status = publicBookingStatus(booking);
    if (status !== 'HELD') throw apiError('BOOKING_STATE_DOES_NOT_ALLOW_ACTION', 409, 'Only HELD bookings can be paid online');
    const expiresAt = timestampToDate(booking.expires_at || booking.hold_expires_at || booking.holdExpiresAt);
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw apiError('HOLD_EXPIRED', 409, 'Booking hold has expired');
    const existing = await findBookingPayment(transaction, db, branchId, bookingId);
    if (existing?.data?.payment_link_url) return sanitizePaymentForClient(existing.data);

    const now = FieldValue.serverTimestamp();
    const paymentRef = db.collection('payments').doc(paymentId);
    const paymentPayload = {
      payment_id: paymentId,
      branch_id: branchId,
      booking_id: bookingId,
      member_id: booking.member_id,
      service_type: SERVICE_TYPE,
      amount,
      amount_minor: beam.amountMinor,
      currency: 'THB',
      provider: 'BEAM',
      payment_environment: config.environment,
      payment_method: 'BEAM_CHECKOUT',
      payment_status: 'PENDING',
      status: 'PENDING',
      provider_ref: beam.paymentLinkId,
      beam_payment_link_id: beam.paymentLinkId,
      payment_link_url: beam.paymentLinkUrl,
      customer_name: beam.customerName || booking.customer_name || '',
      customer_phone: beam.customerPhone || booking.customer_phone || '',
      customer_email: beam.customerEmail || booking.customer_email || '',
      collect_phone_number: beam.collectPhoneNumber,
      idempotency_key: idempotencyKey,
      raw_provider_response: beam.raw,
      created_at: now,
      updated_at: now,
    };
    transaction.set(paymentRef, paymentPayload, { merge: true });
    const bookingUpdate = {
      payment_id: paymentId,
      payment_status: 'PENDING',
      payment_provider: 'BEAM',
      payment_method: 'QR_PAYMENT',
      payment_link_url: beam.paymentLinkUrl,
      provider_ref: beam.paymentLinkId,
      beam_payment_link_id: beam.paymentLinkId,
      updated_at: now,
    };
    if (paymentPayload.customer_name) {
      bookingUpdate.customer_name = paymentPayload.customer_name;
      bookingUpdate.name = booking.name || paymentPayload.customer_name;
    }
    if (paymentPayload.customer_phone) {
      bookingUpdate.customer_phone = paymentPayload.customer_phone;
      bookingUpdate.phone = paymentPayload.customer_phone;
    }
    if (paymentPayload.customer_email) {
      bookingUpdate.customer_email = paymentPayload.customer_email;
    }
    transaction.update(bookingRef, bookingUpdate);
    writeAuditLog(transaction, db, {
      branchId,
      actor,
      actorType: 'CUSTOMER',
      action: 'createBeamArcheryPayment',
      targetCollection: 'payments',
      targetId: paymentId,
      before: booking,
      after: { booking_id: bookingId, payment_status: 'PENDING' },
      requestId,
    });
    return sanitizePaymentForClient(paymentPayload);
  });

  logger.info('Beam archery payment link created', {
    branch_id: branchId,
    booking_id: bookingId,
    payment_id: result.response?.payment_id || '',
    provider_ref: result.response?.provider_ref || beam.paymentLinkId || '',
    beam_payment_link_id: result.response?.beam_payment_link_id || beam.paymentLinkId || '',
    amount,
    amount_minor: beam.amountMinor,
    payment_environment: config.environment,
    replayed: result.replayed === true,
    request_id: requestId || '',
  });

  return {
    replayed: result.replayed,
    ...result.response,
  };
}, {
  name: 'createBeamArcheryPayment',
  methods: ['POST'],
  secrets: BEAM_RUNTIME_SECRETS,
});

const getArcheryPaymentStatus = httpFunction(async ({ db, data, actor }) => {
  const branchId = normalizeBranchId(data.branch_id);
  const bookingId = cleanString(data.booking_id || data.bookingId, 180);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');

  const result = await db.runTransaction(async transaction => {
    const { booking } = await readBookingForMember(transaction, db, branchId, bookingId, actor, staffSessionId);
    const payment = await findBookingPayment(transaction, db, branchId, bookingId);
    return {
      booking_id: bookingId,
      booking_status: booking.booking_status || booking.status || '',
      payment_status: booking.payment_status || payment?.data?.payment_status || 'UNPAID',
      payment: payment ? sanitizePaymentForClient(payment.data) : null,
    };
  });
  return result;
}, {
  name: 'getArcheryPaymentStatus',
  methods: ['POST'],
});

function setCors(req, res) {
  const origin = req.get('origin') || '';
  if (
    ['https://edencafe.co', 'https://www.edencafe.co', 'https://edencafe-d9095.web.app', 'https://edencafe-d9095.firebaseapp.com'].includes(origin)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,X-Beam-Signature,X-Beam-Event');
}

async function markPaymentTerminal(transaction, db, options = {}) {
  const now = FieldValue.serverTimestamp();
  transaction.set(options.paymentRef, {
    payment_id: options.paymentRef.id,
    branch_id: options.branchId,
    booking_id: options.bookingId,
    member_id: options.memberId,
    service_type: SERVICE_TYPE,
    amount: options.amount,
    amount_minor: options.amountMinor,
    currency: 'THB',
    provider: 'BEAM',
    payment_environment: paymentEnvironment(),
    payment_method: options.paymentMethod || 'BEAM_CHECKOUT',
    payment_status: options.paymentStatus,
    status: options.status,
    provider_ref: options.providerRef,
    beam_transaction_id: options.transactionId || options.providerRef,
    beam_payment_link_id: options.paymentLinkId || '',
    idempotency_key: options.idempotencyKey,
    raw_webhook_payload: options.payload,
    paid_at: options.paymentStatus === 'PAID_ONLINE' ? now : null,
    updated_at: now,
    created_at: options.existingPayment?.created_at || now,
  }, { merge: true });
}

async function writeReconciliation(transaction, db, options = {}) {
  const ref = db.collection('payment_reconciliation_queue').doc(paymentDocId('beam_late', `${options.providerRef}:${options.bookingId}`));
  transaction.set(ref, {
    reconciliation_id: ref.id,
    branch_id: options.branchId,
    booking_id: options.bookingId,
    member_id: options.memberId,
    payment_id: options.paymentRef?.id || '',
    provider: 'BEAM',
    payment_environment: paymentEnvironment(),
    provider_ref: options.providerRef,
    amount: options.amount,
    amount_minor: options.amountMinor,
    currency: 'THB',
    reason: options.reason,
    status: 'OPEN',
    raw_webhook_payload: options.payload,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });
  return ref;
}

async function processSuccessfulWebhook(transaction, db, context) {
  const {
    branchId,
    eventType,
    payload,
    bookingRef,
    booking,
    paymentRef,
    providerRef,
    amountMinor,
    paymentLinkId,
    webhookEventRef,
    webhookEventBase,
  } = context;
  const bookingId = bookingRef.id;
  const memberId = cleanString(booking.member_id || booking.uid || booking.customerUid, 160);
  const amount = amountFromBooking(booking);
  const expectedAmountMinor = Math.round(Number(context.existingPayment?.amount_minor || beamAmount(amount)) || 0);
  if (amountMinor !== expectedAmountMinor) {
    throw apiError('PAYMENT_AMOUNT_MISMATCH', 409, 'Beam amount does not match booking amount', { expected: expectedAmountMinor, actual: amountMinor });
  }
  if (webhookCurrency(payload) !== 'THB') {
    throw apiError('PAYMENT_CURRENCY_MISMATCH', 409, 'Beam currency does not match THB');
  }
  const bookingStatus = publicBookingStatus(booking);
  const expiresAt = timestampToDate(booking.expires_at || booking.hold_expires_at || booking.holdExpiresAt);
  const late = bookingStatus !== 'HELD' || (expiresAt && expiresAt.getTime() <= Date.now());
  const idempotencyKey = `beam_webhook_${sha256(`${eventType}:${providerRef}`).slice(0, 48)}`;

  const bookingPaymentStatus = cleanString(booking.payment_status, 60).toUpperCase();
  const existingPaymentStatus = cleanString(context.existingPayment?.payment_status || context.existingPayment?.status, 60).toUpperCase();
  if (
    bookingStatus === 'CONFIRMED'
    && context.existingPayment
    && (bookingPaymentStatus === 'PAID_ONLINE' || existingPaymentStatus === 'PAID_ONLINE')
  ) {
    transaction.set(paymentRef, {
      raw_webhook_payload: payload,
      last_webhook_provider_ref: providerRef,
      last_webhook_event_type: eventType,
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(webhookEventRef, {
      ...webhookEventBase,
      status: 'DUPLICATE_SUCCESS',
      payment_id: paymentRef.id,
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: 'DUPLICATE_SUCCESS', branch_id: branchId, booking_id: bookingId, payment_id: paymentRef.id };
  }

  if (late) {
    await markPaymentTerminal(transaction, db, {
      paymentRef,
      branchId,
      bookingId,
      memberId,
      amount,
      amountMinor,
      paymentStatus: 'PAID_PENDING_REVIEW',
      status: 'REVIEW_REQUIRED',
      providerRef,
      paymentLinkId,
      transactionId: providerRef,
      idempotencyKey,
      payload,
      existingPayment: context.existingPayment,
    });
    const queueRef = await writeReconciliation(transaction, db, {
      branchId,
      bookingId,
      memberId,
      paymentRef,
      providerRef,
      amount,
      amountMinor,
      reason: expiresAt && expiresAt.getTime() <= Date.now() ? 'HOLD_EXPIRED' : `BOOKING_STATUS_${bookingStatus}`,
      payload,
    });
    transaction.set(webhookEventRef, {
      ...webhookEventBase,
      status: 'RECONCILIATION_REQUIRED',
      reconciliation_id: queueRef.id,
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: 'RECONCILIATION_REQUIRED', branch_id: branchId, booking_id: bookingId, payment_id: paymentRef.id, reconciliation_id: queueRef.id };
  }

  const locksSnap = await queryLocksForBooking(transaction, db, branchId, bookingId);
  const loyaltyState = await readArcheryLoyaltyState(transaction, db, {
    bookingId,
    booking: {
      ...booking,
      booking_id: bookingId,
      payment_id: paymentRef.id,
      payment_status: 'PAID_ONLINE',
      booking_status: 'CONFIRMED',
      status: 'CONFIRMED',
    },
  });
  await commitArcheryPromotionApplications(transaction, db, {
    branchId,
    bookingId,
    booking,
    paymentId: paymentRef.id,
    actor: { uid: 'BEAM_WEBHOOK', role: 'SYSTEM', system: true },
  });
  const loyaltyResult = writeArcheryLoyaltyState(transaction, loyaltyState, {
    paymentId: paymentRef.id,
    paymentStatus: 'PAID_ONLINE',
    bookingStatus: 'CONFIRMED',
    actorId: 'BEAM_WEBHOOK',
  });

  locksSnap.forEach(docSnap => {
    transaction.set(docSnap.ref, {
      lock_status: 'CONFIRMED',
      status: 'CONFIRMED',
      expires_at: null,
      hold_expires_at: null,
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  await markPaymentTerminal(transaction, db, {
    paymentRef,
    branchId,
    bookingId,
    memberId,
    amount,
    amountMinor,
    paymentStatus: 'PAID_ONLINE',
    status: 'PAID',
    providerRef,
    paymentLinkId,
    transactionId: providerRef,
    idempotencyKey,
    payload,
    paymentMethod: paymentMethodType(payload) || 'BEAM_CHECKOUT',
    existingPayment: context.existingPayment,
  });
  const now = FieldValue.serverTimestamp();
  transaction.update(bookingRef, {
    booking_status: 'CONFIRMED',
    status: 'CONFIRMED',
    payment_status: 'PAID_ONLINE',
    payment_id: paymentRef.id,
    provider_ref: providerRef,
    confirmed_at: now,
    updated_at: now,
    ...archeryPromotionStatusUpdate(booking, 'redeemed', { paymentId: paymentRef.id }),
  });
  writeAuditLog(transaction, db, {
    branchId,
    actor: { uid: 'BEAM_WEBHOOK', role: 'SYSTEM', system: true },
    actorType: 'SYSTEM',
    action: 'beamArcheryPaymentWebhook',
    targetCollection: 'bookings',
    targetId: bookingId,
    before: booking,
    after: { booking_id: bookingId, booking_status: 'CONFIRMED', payment_status: 'PAID_ONLINE' },
  });
  transaction.set(webhookEventRef, {
    ...webhookEventBase,
    status: 'PROCESSED',
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });
  return {
    status: 'PROCESSED',
    branch_id: branchId,
    booking_id: bookingId,
    payment_id: paymentRef.id,
    loyalty: loyaltyResult,
  };
}

const beamArcheryPaymentWebhook = onRequest({
  region: REGION,
  secrets: BEAM_RUNTIME_SECRETS,
}, async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED' });
    return;
  }
  const db = admin.firestore();
  try {
    const config = webhookConfig();
    const signature = verifyBeamSignature(req, config.webhookSecret);
    const eventType = beamEvent(req);
    if (!ALLOWED_WEBHOOK_EVENTS.has(eventType)) throw apiError('WEBHOOK_EVENT_NOT_SUPPORTED', 400, 'Beam event is not supported');
    const payload = req.body || {};
    if (cleanString(payload.merchantId, 180) !== config.merchantId) {
      throw apiError('WEBHOOK_MERCHANT_MISMATCH', 403, `Beam merchant does not match ${config.environment} merchant`);
    }
    const referenceId = webhookReferenceId(payload);
    const bookingId = bookingIdFromReference(referenceId);
    if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'Beam webhook reference is missing booking id');
    const providerRef = webhookProviderRef(payload);
    if (!providerRef) throw apiError('PAYMENT_REQUIRED', 400, 'Beam webhook provider reference is missing');
    const eventId = paymentDocId('beam_webhook', `${eventType}:${webhookIdentity(eventType, payload)}:${sha256(rawRequestBody(req))}`);
    const amountMinor = webhookAmount(payload);
    const paymentLinkId = cleanString(payload.paymentLinkId || payload.sourceId, 180);

    logger.info('Beam archery webhook received', {
      event_type: eventType,
      booking_id: bookingId,
      provider_ref: providerRef,
      payment_link_id: paymentLinkId,
      amount_minor: amountMinor,
      payment_environment: config.environment,
      webhook_event_id: eventId,
    });

    const result = await db.runTransaction(async transaction => {
      const webhookEventRef = db.collection('payment_webhook_events').doc(eventId);
      const eventSnap = await transaction.get(webhookEventRef);
      if (eventSnap.exists) {
        return { status: 'DUPLICATE', duplicate: true, webhook_event_id: webhookEventRef.id };
      }
      const webhookEventBase = {
        webhook_event_id: eventId,
        branch_id: '',
        provider: 'BEAM',
        payment_environment: paymentEnvironment(),
        event_type: eventType,
        provider_ref: providerRef,
        booking_id: bookingId,
        signature_hash: sha256(signature),
        raw_payload_hash: sha256(rawRequestBody(req)),
        status: 'RECEIVED',
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      };

      const bookingRef = db.collection('bookings').doc(bookingId);
      const bookingSnap = await transaction.get(bookingRef);
      if (!bookingSnap.exists) throw apiError('BOOKING_NOT_FOUND', 404, 'Booking was not found');
      const booking = bookingSnap.data() || {};
      if (booking.service_type !== SERVICE_TYPE) throw apiError('BOOKING_NOT_FOUND', 404, 'Archery booking was not found');
      const branchId = normalizeBranchId(booking.branch_id);
      webhookEventBase.branch_id = branchId;

      let providerPayment = null;
      const duplicatePaymentSnap = await transaction.get(
        db.collection('payments')
          .where('provider', '==', 'BEAM')
          .where('provider_ref', '==', providerRef)
          .limit(1)
      );
      if (!duplicatePaymentSnap.empty) {
        const duplicateDoc = duplicatePaymentSnap.docs[0];
        const duplicate = duplicateDoc.data() || {};
        if (duplicate.booking_id !== bookingId) {
          throw apiError('PAYMENT_ALREADY_RECORDED', 409, 'Beam provider_ref already belongs to another booking');
        }
        providerPayment = { ref: duplicateDoc.ref, data: duplicate };
        const paymentStatus = cleanString(duplicate.payment_status || duplicate.status, 60).toUpperCase();
        if (['PAID_ONLINE', 'PAID_PENDING_REVIEW', 'FAILED', 'CANCELLED', 'REFUNDED'].includes(paymentStatus)) {
          transaction.set(webhookEventRef, {
            ...webhookEventBase,
            status: 'DUPLICATE_PAYMENT',
            payment_id: duplicateDoc.id,
            updated_at: FieldValue.serverTimestamp(),
          }, { merge: true });
          return { status: 'DUPLICATE_PAYMENT', duplicate: true, booking_id: bookingId, payment_id: duplicateDoc.id };
        }
      }

      const existing = providerPayment || await findBookingPayment(transaction, db, branchId, bookingId);
      const paymentRef = existing?.ref || db.collection('payments').doc(paymentDocId('beam', `${branchId}:${bookingId}:${providerRef}`));
      if (SUCCESS_EVENTS.has(eventType)) {
        if (!isTerminalPaidStatus(payload)) throw apiError('PAYMENT_STATUS_INVALID', 409, 'Beam payment was not successful');
        return processSuccessfulWebhook(transaction, db, {
          branchId,
          eventType,
          payload,
          bookingRef,
          booking,
          paymentRef,
          existingPayment: existing?.data || null,
          providerRef,
          amountMinor,
          paymentLinkId,
          webhookEventRef,
          webhookEventBase,
        });
      }

      const failedStatus = FAILED_EVENTS.has(eventType) ? 'FAILED' : CANCELLED_EVENTS.has(eventType) ? 'CANCELLED' : 'IGNORED';
      await releaseArcheryPromotionApplications(transaction, db, {
        branchId,
        bookingId,
        booking,
        reason: `Beam payment ${failedStatus.toLowerCase()}`,
        actor: { uid: 'BEAM_WEBHOOK', role: 'SYSTEM', system: true },
      });
      await markPaymentTerminal(transaction, db, {
        paymentRef,
        branchId,
        bookingId,
        memberId: cleanString(booking.member_id || booking.uid || booking.customerUid, 160),
        amount: amountFromBooking(booking),
        amountMinor,
        paymentStatus: failedStatus,
        status: failedStatus,
        providerRef,
        paymentLinkId,
        transactionId: providerRef,
        idempotencyKey: `beam_webhook_${sha256(`${eventType}:${providerRef}`).slice(0, 48)}`,
        payload,
        existingPayment: existing?.data || null,
      });
      transaction.update(bookingRef, {
        payment_status: failedStatus,
        paymentStatus: failedStatus.toLowerCase(),
        updated_at: FieldValue.serverTimestamp(),
        ...archeryPromotionStatusUpdate(booking, 'released', { reason: failedStatus }),
      });
      transaction.set(webhookEventRef, {
        ...webhookEventBase,
        status: failedStatus,
        payment_id: paymentRef.id,
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { status: failedStatus, branch_id: branchId, booking_id: bookingId, payment_id: paymentRef.id };
    });

    let loyaltyRedemption = null;
    let loyaltyRelease = null;
    let loyaltyRedemptionError = '';
    if (result.status === 'PROCESSED' && result.branch_id && result.booking_id && result.payment_id) {
      try {
        loyaltyRedemption = await commitArcheryLoyaltyForBooking(db, {
          branchId: result.branch_id,
          bookingId: result.booking_id,
          paymentId: result.payment_id,
          actor: { uid: 'BEAM_WEBHOOK', role: 'SYSTEM', system: true },
        });
      } catch (error) {
        loyaltyRedemptionError = cleanString(error.code || error.message || 'LOYALTY_REDEMPTION_COMMIT_FAILED', 180);
      }
    } else if (['FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED'].includes(result.status) && result.branch_id && result.booking_id) {
      try {
        loyaltyRelease = await releaseArcheryLoyaltyForBooking(db, {
          branchId: result.branch_id,
          bookingId: result.booking_id,
          reason: result.status === 'RECONCILIATION_REQUIRED' ? 'beam-payment-review-required' : `beam-payment-${String(result.status).toLowerCase()}`,
          actor: { uid: 'BEAM_WEBHOOK', role: 'SYSTEM', system: true },
        });
      } catch (error) {
        loyaltyRedemptionError = cleanString(error.code || error.message || 'LOYALTY_REDEMPTION_RELEASE_FAILED', 180);
      }
    }

    logger.info('Beam archery webhook processed', {
      event_type: eventType,
      booking_id: bookingId,
      provider_ref: providerRef,
      payment_link_id: paymentLinkId,
      amount_minor: amountMinor,
      payment_environment: config.environment,
      result_status: result.status || '',
      payment_id: result.payment_id || '',
      reconciliation_id: result.reconciliation_id || '',
      duplicate: result.duplicate === true,
      loyalty_redemption_status: loyaltyRedemption?.status || loyaltyRelease?.status || '',
      loyalty_redemption_error: loyaltyRedemptionError,
    });
    res.status(200).json({
      ok: true,
      ...result,
      loyalty_redemption: loyaltyRedemption || loyaltyRelease || null,
      loyalty_redemption_error: loyaltyRedemptionError,
    });
  } catch (error) {
    logger.warn('Beam archery webhook failed', {
      code: error.code || '',
      status: error.statusCode || 500,
      error_message: error.message,
      event: beamEvent(req),
      reference_id: webhookReferenceId(req.body || ''),
      provider_ref: webhookProviderRef(req.body || {}),
    });
    sendError(res, error);
  }
});

const reconcileBeamLatePayment = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  requireRoles(actor, ['OWNER', 'MANAGER'], branchId);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const reconciliationId = cleanString(data.reconciliation_id || data.reconciliationId, 180);
  const action = cleanString(data.action || 'MARK_REVIEWED', 60).toUpperCase();
  if (!reconciliationId) throw apiError('RECONCILIATION_REQUIRED', 400, 'reconciliation_id is required');

  return db.runTransaction(async transaction => {
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    const ref = db.collection('payment_reconciliation_queue').doc(reconciliationId);
    const snap = await transaction.get(ref);
    if (!snap.exists) throw apiError('RECONCILIATION_NOT_FOUND', 404, 'Reconciliation item was not found');
    const item = snap.data() || {};
    if (item.branch_id !== branchId) throw apiError('RECONCILIATION_NOT_FOUND', 404, 'Reconciliation item was not found for this branch');
    const status = action === 'MARK_REFUND_REQUIRED' ? 'REFUND_REQUIRED' : 'REVIEWED';
    transaction.update(ref, {
      status,
      reviewed_by: actor.uid,
      reviewed_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
    writeAuditLog(transaction, db, {
      branchId,
      actor,
      staffSessionId,
      action: 'reconcileBeamLatePayment',
      targetCollection: 'payment_reconciliation_queue',
      targetId: reconciliationId,
      before: item,
      after: { reconciliation_id: reconciliationId, status },
      requestId,
    });
    return { reconciliation_id: reconciliationId, status };
  });
}, {
  name: 'reconcileBeamLatePayment',
  methods: ['POST'],
});

module.exports = {
  createBeamArcheryPayment,
  beamArcheryPaymentWebhook,
  getArcheryPaymentStatus,
  reconcileBeamLatePayment,
  verifyBeamSignature,
};
