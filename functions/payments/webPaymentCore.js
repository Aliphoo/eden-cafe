const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');
const {
  REGION,
  httpFunction,
  requireRoles,
  requireStaffSession,
  hasBranch,
  sendError,
} = require('../security/authz');
const { runIdempotentTransaction, sha256 } = require('../shared/idempotency');
const { writeAuditLog } = require('../shared/audit');
const { FieldValue } = require('../shared/firestore');
const {
  apiError,
  cleanString,
  normalizeBranchId,
  timestampToDate,
} = require('../shared/time');
const { updateLocksForBooking } = require('../shared/locks');

const BEAM_API_KEY_SANDBOX = defineSecret('BEAM_API_KEY_SANDBOX');
const BEAM_WEBHOOK_SECRET_SANDBOX = defineSecret('BEAM_WEBHOOK_SECRET_SANDBOX');
const BEAM_MERCHANT_ID_SANDBOX = defineSecret('BEAM_MERCHANT_ID_SANDBOX');
const BEAM_API_KEY_PRODUCTION = defineSecret('BEAM_API_KEY_PRODUCTION');
const BEAM_WEBHOOK_SECRET_PRODUCTION = defineSecret('BEAM_WEBHOOK_SECRET_PRODUCTION');
const BEAM_MERCHANT_ID_PRODUCTION = defineSecret('BEAM_MERCHANT_ID_PRODUCTION');
const ARCHERY_PAYMENT_LIVE = defineSecret('ARCHERY_PAYMENT_LIVE');
const PAYMENT_ENV = defineSecret('PAYMENT_ENV');

const BEAM_RUNTIME_SECRETS = [
  BEAM_API_KEY_SANDBOX,
  BEAM_WEBHOOK_SECRET_SANDBOX,
  BEAM_MERCHANT_ID_SANDBOX,
  BEAM_API_KEY_PRODUCTION,
  BEAM_WEBHOOK_SECRET_PRODUCTION,
  BEAM_MERCHANT_ID_PRODUCTION,
  ARCHERY_PAYMENT_LIVE,
  PAYMENT_ENV,
];

const SOURCE_TYPES = new Set([
  'ARCHERY_BOOKING',
  'TABLE_BOOKING',
  'ROOM_BOOKING',
  'SHOP_ORDER',
  'MEMBERSHIP_REWARD_WEB',
]);

const SUCCESS_EVENTS = new Set(['payment_link.paid', 'charge.succeeded']);
const FAILED_EVENTS = new Set(['charge.failed', 'card_authorization.failed']);
const CANCELLED_EVENTS = new Set(['card_authorization.canceled']);
const ALLOWED_WEBHOOK_EVENTS = new Set([
  ...SUCCESS_EVENTS,
  ...FAILED_EVENTS,
  ...CANCELLED_EVENTS,
]);
const PAYABLE_PAYMENT_STATUSES = new Set(['', 'UNPAID', 'PENDING', 'FAILED', 'CANCELLED']);
const PAID_STATUSES = new Set(['PAID_ONLINE', 'PAID', 'PARTIALLY_REFUNDED']);
const TERMINAL_STATUSES = new Set([
  'PAID_ONLINE',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'PAID_PENDING_REVIEW',
]);
const DEFAULT_WEB_ORDER_BRANCH_ID = 'BKK_MAIN';
const DEFAULT_WEB_SHIPPING_FEE = 50;

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

function assertWebPaymentProvider() {
  const provider = cleanString(envValue('WEB_PAYMENT_PROVIDER', 'BEAM'), 40).toUpperCase();
  if (provider !== 'BEAM') throw apiError('PAYMENT_PROVIDER_DISABLED', 400, 'Web payment provider is not Beam');
  const env = paymentEnvironment();
  if (!['sandbox', 'production'].includes(env)) {
    throw apiError('PAYMENT_ENV_INVALID', 500, 'Web payment environment is invalid');
  }
  const live = boolValue(envValue('WEB_PAYMENT_LIVE', runtimeValue(ARCHERY_PAYMENT_LIVE, 'ARCHERY_PAYMENT_LIVE', 'false')));
  if (live && env !== 'production') {
    throw apiError('PAYMENT_ENV_LIVE_MISMATCH', 500, 'Live payments require PAYMENT_ENV=production');
  }
  if (!live && env === 'production') {
    throw apiError('PAYMENT_ENV_LIVE_MISMATCH', 500, 'Production payment environment requires WEB_PAYMENT_LIVE=true');
  }
}

function beamConfig({ webhook = false } = {}) {
  assertWebPaymentProvider();
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
  if (!merchantId || (webhook ? !webhookSecret : !apiKey)) {
    throw apiError(
      'PAYMENT_PROVIDER_NOT_CONFIGURED',
      500,
      `Beam ${environment} ${webhook ? 'merchant ID/webhook secret' : 'merchant ID/API key'} are not configured`
    );
  }
  return { merchantId, apiKey, webhookSecret, apiBaseUrl, environment, production };
}

function basicAuth(merchantId, apiKey) {
  return `Basic ${Buffer.from(`${merchantId}:${apiKey}`).toString('base64')}`;
}

function amountMinor(amount) {
  return Math.max(0, Math.round((Number(amount) || 0) * 100));
}

function paymentDocId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 40)}`;
}

function safeUpper(value, maxLength = 80) {
  return cleanString(value, maxLength).toUpperCase();
}

function normalizeProvider(value) {
  const provider = safeUpper(value || 'BEAM', 40);
  if (provider !== 'BEAM') throw apiError('PAYMENT_PROVIDER_UNSUPPORTED', 400, 'Only Beam web payment is supported');
  return provider;
}

function normalizeSourceType(value) {
  const sourceType = safeUpper(value, 80);
  if (sourceType === 'ARCHERY') return 'ARCHERY_BOOKING';
  if (sourceType === 'TABLE') return 'TABLE_BOOKING';
  if (sourceType === 'ROOM') return 'ROOM_BOOKING';
  if (sourceType === 'SHOP') return 'SHOP_ORDER';
  if (!SOURCE_TYPES.has(sourceType)) throw apiError('SOURCE_TYPE_UNSUPPORTED', 400, 'Unsupported web payment source_type');
  if (sourceType === 'MEMBERSHIP_REWARD_WEB') {
    throw apiError('SOURCE_TYPE_NOT_READY', 409, 'Membership/reward web payment is reserved for a later rollout');
  }
  return sourceType;
}

function sourceCollection(sourceType) {
  return sourceType === 'SHOP_ORDER' ? 'orders' : 'bookings';
}

function sourceIdFromInput(data = {}, sourceType = '') {
  return cleanString(
    data.source_id
      || data.sourceId
      || data.booking_id
      || data.bookingId
      || data.order_id
      || data.orderId
      || (sourceType === 'SHOP_ORDER' ? data.id : ''),
    180
  );
}

function memberIdFromSource(source = {}) {
  return cleanString(
    source.member_id
      || source.customerUid
      || source.customer_uid
      || source.memberUid
      || source.uid
      || source.userId
      || source.owner_id,
    180
  );
}

function sourcePaymentStatus(source = {}) {
  const raw = cleanString(source.payment_status || source.paymentStatus || source.status, 80);
  if (raw.toLowerCase() === 'paid') return 'PAID_ONLINE';
  if (raw.toLowerCase() === 'pending') return 'PENDING';
  if (raw.toLowerCase() === 'refunded') return 'REFUNDED';
  if (raw.toLowerCase() === 'failed') return 'FAILED';
  return raw.toUpperCase();
}

function sourceStatus(source = {}) {
  return cleanString(source.booking_status || source.status || source.order_status || '', 80);
}

function numericAmount(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function webOrderBranchId(value) {
  return normalizeBranchId(value || envValue('WEB_ORDER_BRANCH_ID', DEFAULT_WEB_ORDER_BRANCH_ID));
}

function normalizeShopOrderItems(rawItems = []) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw apiError('ORDER_ITEMS_REQUIRED', 400, 'Order items are required');
  }
  if (rawItems.length > 50) {
    throw apiError('ORDER_ITEMS_TOO_MANY', 400, 'Order has too many line items');
  }
  return rawItems.map((item, index) => {
    const rawId = cleanString(item.id || item.product_id || item.productId || item.sku, 160);
    const [baseRawId, variantRawId = ''] = rawId.split('::');
    const baseProductId = baseRawId.startsWith('menu-') ? baseRawId.slice(5) : baseRawId;
    const quantity = Math.floor(Number(item.quantity || item.qty || 0) || 0);
    if (!rawId) throw apiError('PRODUCT_REQUIRED', 400, `Product id is required for item ${index + 1}`);
    if (quantity < 1 || quantity > 99) throw apiError('QUANTITY_INVALID', 400, `Quantity is invalid for item ${index + 1}`);
    return {
      raw_id: rawId,
      product_id: baseProductId,
      product_raw_id: baseRawId,
      variant_id: cleanString(item.variant_id || item.variantId || variantRawId, 120),
      quantity,
      client_name: cleanString(item.name || item.label, 180),
    };
  });
}

function parseShopBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function firstAvailableVariant(product = {}) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  return variants.find(variant => parseShopBoolean(variant.availableForSale ?? variant.available ?? variant.enabled, true))
    || variants[0]
    || null;
}

function shopVariantKey(value) {
  return cleanString(value, 120).toLowerCase();
}

function findShopVariant(product = {}, variantId = '') {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  if (!variants.length) return null;
  const wanted = shopVariantKey(variantId);
  if (!wanted) return firstAvailableVariant(product);
  const found = variants.find(variant => {
    return [variant.id, variant.sku, variant.name].some(value => shopVariantKey(value) === wanted);
  });
  if (!found) throw apiError('PRODUCT_VARIANT_NOT_FOUND', 404, `Product variant was not found: ${variantId}`);
  if (!parseShopBoolean(found.availableForSale ?? found.available ?? found.enabled, true)) {
    throw apiError('PRODUCT_VARIANT_NOT_AVAILABLE', 409, `Product variant is not available: ${variantId}`);
  }
  return found;
}

function shopProductName(product = {}, fallback = 'Eden Product') {
  return cleanString(product.name || product.nameTh || product.nameEn || product.label || fallback, 180) || fallback;
}

function shopProductImage(product = {}) {
  return cleanString(product.imageUrl || product.image || product.photoUrl || '', 500);
}

function shopProductIsSellable(product = {}) {
  return parseShopBoolean(product.availableForSale ?? product.available, true)
    && parseShopBoolean(product.showInShop, false);
}

function shopProductPrice(product = {}, variant = null) {
  return roundMoney(variant?.price ?? variant?.salePrice ?? product.price ?? product.salePrice ?? 0);
}

function shopProductStock(product = {}, variant = null) {
  const value = variant?.stock ?? variant?.inStock ?? product.stock ?? product.inStock;
  const stock = Number(value);
  return Number.isFinite(stock) ? stock : null;
}

async function readShopProduct(transaction, db, item) {
  const candidates = Array.from(new Set([item.product_id, item.product_raw_id, item.raw_id].filter(Boolean)));
  for (const id of candidates) {
    const ref = db.collection('products').doc(id);
    const snap = await transaction.get(ref);
    if (snap.exists) return { ref, id, data: snap.data() || {} };
  }
  throw apiError('PRODUCT_NOT_FOUND', 404, `Product was not found: ${item.raw_id}`);
}

async function buildShopOrderLines(transaction, db, items) {
  const lines = [];
  for (const item of items) {
    const productSnap = await readShopProduct(transaction, db, item);
    const product = productSnap.data;
    if (!shopProductIsSellable(product)) {
      throw apiError('PRODUCT_NOT_AVAILABLE', 409, `Product is not available: ${item.raw_id}`);
    }
    const variant = findShopVariant(product, item.variant_id);
    const price = shopProductPrice(product, variant);
    if (price <= 0) throw apiError('PRODUCT_PRICE_INVALID', 409, `Product has no valid price: ${item.raw_id}`);
    if (product.trackStock === true || variant?.trackStock === true) {
      const stock = shopProductStock(product, variant);
      if (stock != null && stock < item.quantity) {
        throw apiError('PRODUCT_OUT_OF_STOCK', 409, `Product stock is not enough: ${item.raw_id}`);
      }
    }
    const lineTotal = roundMoney(price * item.quantity);
    lines.push({
      id: item.raw_id,
      productId: productSnap.id,
      sku: cleanString(variant?.sku || product.sku || productSnap.id, 120),
      variantId: cleanString(variant?.id || item.variant_id || '', 120),
      variantName: cleanString(variant?.name || '', 120),
      name: shopProductName(product, item.client_name),
      price,
      unitPrice: price,
      quantity: item.quantity,
      lineTotal,
      imageUrl: shopProductImage(product),
    });
  }
  return lines;
}

function normalizeFulfillmentMethod(value) {
  const method = cleanString(value || 'delivery', 30).toLowerCase();
  return method === 'pickup' ? 'pickup' : 'delivery';
}

function normalizeCustomerName(value) {
  const name = cleanString(value, 120);
  if (!name) throw apiError('CUSTOMER_NAME_REQUIRED', 400, 'Customer name is required');
  return name;
}

function normalizeCustomerPhone(value) {
  const phone = cleanString(value, 40);
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw apiError('CUSTOMER_PHONE_REQUIRED', 400, 'Customer phone is required');
  return phone;
}

function shopOrderDisplayId(sourceId) {
  return `#ED${sha256(sourceId).slice(0, 8).toUpperCase()}`;
}

function sourceAmount(sourceType, source = {}) {
  if (sourceType === 'SHOP_ORDER') {
    return numericAmount(source.totalAmount, source.total, source.amount_total, source.amount);
  }
  if (sourceType === 'ROOM_BOOKING') {
    return numericAmount(source.deposit_amount, source.balance_due, source.amount_due, source.amount_total, source.totalAmount, source.price, source.amount);
  }
  if (sourceType === 'TABLE_BOOKING') {
    return numericAmount(source.deposit_amount, source.balance_due, source.amount_due, source.amount_total, source.totalAmount, source.amount);
  }
  return numericAmount(source.amount_total, source.totalAmount, source.total_price, source.amount);
}

function sourceCurrency(source = {}) {
  return cleanString(source.currency || 'THB', 10).toUpperCase() || 'THB';
}

function sourceBranchId(source = {}, fallback = '') {
  return cleanString(source.branch_id || source.branchId || fallback, 80);
}

function sourceMatchesType(sourceType, source = {}) {
  const service = safeUpper(source.service_type || source.serviceType, 80);
  const bookingType = cleanString(source.bookingType || source.booking_type, 40).toLowerCase();
  const orderType = cleanString(source.orderType || source.order_type, 40).toLowerCase();
  if (sourceType === 'ARCHERY_BOOKING') return service === 'ARCHERY' || service === 'ARCHERY_BOOKING' || bookingType === 'archery';
  if (sourceType === 'TABLE_BOOKING') return service === 'TABLE' || service === 'TABLE_BOOKING' || bookingType === 'table';
  if (sourceType === 'ROOM_BOOKING') return service === 'ROOM' || service === 'ROOM_BOOKING' || bookingType === 'room';
  if (sourceType === 'SHOP_ORDER') return service === 'SHOP_ORDER' && source.payment_required === true;
  return false;
}

function statusAllowsPayment(sourceType, source = {}) {
  const status = sourceStatus(source).toUpperCase();
  const paymentStatus = sourcePaymentStatus(source);
  if (PAID_STATUSES.has(paymentStatus) || paymentStatus === 'REFUNDED' || paymentStatus === 'REFUND_REQUESTED') return false;
  if (!PAYABLE_PAYMENT_STATUSES.has(paymentStatus)) return false;
  if (sourceType === 'SHOP_ORDER') return !['COMPLETED', 'CANCELLED', 'REFUNDED', 'VOIDED'].includes(status);
  if (sourceType === 'ARCHERY_BOOKING') return ['HELD', 'PENDING'].includes(status);
  return !['CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'REFUNDED', 'VOIDED'].includes(status);
}

function sourceExpiry(source = {}) {
  return timestampToDate(source.expires_at || source.hold_expires_at || source.holdExpiresAt || source.payment_expires_at);
}

function sourceContextFromSnapshot(sourceType, sourceId, branchId, ref, data) {
  const sourceBranch = sourceBranchId(data, sourceType === 'SHOP_ORDER' ? '' : branchId);
  if (!sourceBranch) throw apiError('BRANCH_REQUIRED', 400, 'branch_id is required for this source');
  if (branchId && sourceBranch !== branchId) throw apiError('SOURCE_NOT_FOUND', 404, 'Source was not found for this branch');
  if (!sourceMatchesType(sourceType, data)) throw apiError('SOURCE_NOT_FOUND', 404, 'Source does not match source_type');
  const amount = sourceAmount(sourceType, data);
  const currency = sourceCurrency(data);
  if (amount <= 0) throw apiError('PAYMENT_AMOUNT_REQUIRED', 409, 'Source does not have a payable amount');
  if (currency !== 'THB') throw apiError('PAYMENT_CURRENCY_MISMATCH', 409, 'Only THB web payments are supported');
  return {
    ref,
    data,
    source_type: sourceType,
    source_id: sourceId,
    service_type: sourceType,
    branch_id: sourceBranch,
    member_id: memberIdFromSource(data),
    amount,
    amount_minor: amountMinor(amount),
    currency,
    status: sourceStatus(data),
    payment_status: sourcePaymentStatus(data),
    expires_at: sourceExpiry(data),
  };
}

function assertSourcePayable(context) {
  if (!context.member_id) throw apiError('SOURCE_OWNER_REQUIRED', 409, 'Source is missing member owner');
  if (!statusAllowsPayment(context.source_type, context.data)) {
    throw apiError('SOURCE_STATE_NOT_PAYABLE', 409, 'Source status does not allow online payment');
  }
  if (context.expires_at && context.expires_at.getTime() <= Date.now()) {
    throw apiError('SOURCE_EXPIRED', 409, 'Source payment window has expired');
  }
}

function assertActorCanUseSource(actor, context) {
  if (!actor) throw apiError('AUTH_REQUIRED', 401, 'Authentication is required');
  if (actor.uid === context.member_id) return;
  const staffRoles = context.source_type === 'ARCHERY_BOOKING'
    ? ['OWNER', 'MANAGER', 'ARCHERY_STAFF']
    : ['OWNER', 'MANAGER'];
  if (staffRoles.includes(actor.role) && hasBranch(actor, context.branch_id)) return;
  throw apiError('STAFF_PERMISSION_REQUIRED', 403, 'Actor is not allowed for this payment source');
}

async function readSource(transaction, db, branchId, sourceType, sourceId) {
  const ref = db.collection(sourceCollection(sourceType)).doc(sourceId);
  const snap = await transaction.get(ref);
  if (!snap.exists) throw apiError('SOURCE_NOT_FOUND', 404, 'Payment source was not found');
  return sourceContextFromSnapshot(sourceType, sourceId, branchId, ref, snap.data() || {});
}

async function findExistingPaymentForSource(transaction, db, context, provider = 'BEAM') {
  const directSnap = await transaction.get(
    db.collection('payments')
      .where('branch_id', '==', context.branch_id)
      .where('source_type', '==', context.source_type)
      .where('source_id', '==', context.source_id)
      .where('provider', '==', provider)
      .limit(1)
  );
  if (!directSnap.empty) {
    const docSnap = directSnap.docs[0];
    return { ref: docSnap.ref, data: docSnap.data() || {} };
  }

  const legacyField = context.source_type === 'SHOP_ORDER' ? 'order_id' : 'booking_id';
  const legacySnap = await transaction.get(
    db.collection('payments')
      .where('branch_id', '==', context.branch_id)
      .where(legacyField, '==', context.source_id)
      .where('provider', '==', provider)
      .limit(1)
  );
  if (legacySnap.empty) return null;
  const docSnap = legacySnap.docs[0];
  return { ref: docSnap.ref, data: docSnap.data() || {} };
}

function paymentStatus(payment = {}) {
  return safeUpper(payment.status || payment.payment_status, 80);
}

function sanitizePayment(payment = {}) {
  return {
    payment_id: payment.payment_id || '',
    branch_id: payment.branch_id || '',
    member_id: payment.member_id || '',
    source_type: payment.source_type || '',
    source_id: payment.source_id || payment.booking_id || payment.order_id || '',
    service_type: payment.service_type || payment.source_type || '',
    provider: payment.provider || '',
    payment_env: payment.payment_env || payment.payment_environment || '',
    payment_environment: payment.payment_environment || payment.payment_env || '',
    status: payment.status || payment.payment_status || '',
    payment_status: payment.payment_status || payment.status || '',
    provider_ref: payment.provider_ref || '',
    payment_link_url: payment.payment_link_url || '',
    amount: Number(payment.amount || 0) || 0,
    amount_minor: Number(payment.amount_minor || 0) || 0,
    currency: payment.currency || 'THB',
    receipt_id: payment.receipt_id || '',
    created_at: payment.created_at || null,
    paid_at: payment.paid_at || null,
    refunded_at: payment.refunded_at || null,
  };
}

function safeReturnUrl(input, config) {
  const fallback = config.production
    ? envValue('WEB_PAYMENT_RETURN_URL_PRODUCTION', 'https://edencafe.co/profile')
    : envValue('WEB_PAYMENT_RETURN_URL_SANDBOX', 'http://localhost:5000/profile');
  const candidate = cleanString(input, 700) || fallback;
  try {
    const url = new URL(candidate);
    const allowed = (
      url.hostname === 'edencafe.co'
      || url.hostname === 'www.edencafe.co'
      || url.hostname === 'edencafe-d9095.web.app'
      || url.hostname === 'edencafe-d9095.firebaseapp.com'
      || (['localhost', '127.0.0.1'].includes(url.hostname) && !config.production)
    );
    if (allowed) return url.toString();
  } catch (_) {
    return fallback;
  }
  return fallback;
}

function webReferenceId(context, paymentId) {
  return `EDENWEB|${context.source_type}|${context.source_id}|${paymentId}`;
}

function parseWebReferenceId(referenceId = '') {
  const parts = cleanString(referenceId, 500).split('|');
  if (parts.length === 4 && parts[0] === 'EDENWEB') {
    return {
      source_type: normalizeSourceType(parts[1]),
      source_id: cleanString(parts[2], 180),
      payment_id: cleanString(parts[3], 180),
    };
  }
  return null;
}

function itemNameForSource(context) {
  if (context.source_type === 'SHOP_ORDER') return `Eden Cafe order ${context.source_id}`;
  if (context.source_type === 'TABLE_BOOKING') return `Eden Cafe table booking ${context.source_id}`;
  if (context.source_type === 'ROOM_BOOKING') return `Eden Cafe room booking ${context.source_id}`;
  return `Eden Archery booking ${context.source_id}`;
}

async function createBeamPaymentLink(config, context, paymentId, idempotencyKey, returnUrl = '') {
  const redirect = safeReturnUrl(returnUrl, config);
  const body = {
    collectDeliveryAddress: false,
    collectPhoneNumber: true,
    expiresAt: (context.expires_at || new Date(Date.now() + (15 * 60 * 1000))).toISOString(),
    linkSettings: config.production ? {
      card: { isEnabled: false },
      cardInstallments: { isEnabled: false },
      eWallets: { isEnabled: false },
      mobileBanking: { isEnabled: false },
      qrPromptPay: { isEnabled: true },
      buyNowPayLater: { isEnabled: false },
    } : {
      card: { isEnabled: true },
      cardInstallments: { isEnabled: true },
      eWallets: { isEnabled: true },
      mobileBanking: { isEnabled: true },
      qrPromptPay: { isEnabled: true },
      buyNowPayLater: { isEnabled: false },
    },
    order: {
      currency: context.currency,
      description: itemNameForSource(context),
      internalNote: paymentId,
      netAmount: context.amount_minor,
      referenceId: webReferenceId(context, paymentId),
      orderItems: [{
        itemName: itemNameForSource(context).slice(0, 80),
        productId: context.source_type,
        sku: context.source_type,
        quantity: 1,
        price: context.amount_minor,
        description: context.source_id,
      }],
    },
    redirectUrl: `${redirect}${redirect.includes('?') ? '&' : '?'}payment_id=${encodeURIComponent(paymentId)}&source_id=${encodeURIComponent(context.source_id)}`,
    feeType: 'TRANSACTION_FEE',
  };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: basicAuth(config.merchantId, config.apiKey),
    'x-beam-idempotency-key': idempotencyKey,
  };
  const partnerId = envValue('BEAM_PARTNER_ID_SANDBOX', '');
  if (partnerId && !config.production) headers['X-Beam-Partner-ID'] = partnerId;

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
    logger.warn('Beam web payment link create failed', {
      status: response.status,
      payment_environment: config.environment,
      source_type: context.source_type,
      source_id: context.source_id,
      beam_error: result.error?.errorCode || result.error || result.message || '',
    });
    throw apiError('BEAM_PAYMENT_CREATE_FAILED', response.status || 502, `Unable to create Beam ${config.environment} payment link`);
  }
  return {
    raw: result,
    provider_ref: cleanString(result.id || result.paymentLinkId || result.payment_link_id, 180),
    payment_link_url: cleanString(result.url || result.paymentLinkUrl || result.payment_link_url, 700),
  };
}

function paymentItemRows(context, paymentId) {
  const now = FieldValue.serverTimestamp();
  if (context.source_type === 'SHOP_ORDER') {
    const rows = [];
    const items = Array.isArray(context.data.items) ? context.data.items : [];
    items.slice(0, 100).forEach((item, index) => {
      const quantity = Math.max(0, Number(item.quantity || item.qty || 0) || 0);
      const unit = Math.max(0, Number(item.price || item.unitPrice || item.unit_price || 0) || 0);
      rows.push({
        payment_item_id: `${paymentId}_${String(index + 1).padStart(3, '0')}`,
        payment_id: paymentId,
        branch_id: context.branch_id,
        member_id: context.member_id,
        source_type: context.source_type,
        source_id: context.source_id,
        service_type: context.service_type,
        item_type: 'PRODUCT',
        item_id: cleanString(item.id || item.sku || '', 120),
        label: cleanString(item.name || item.label || 'Product', 180),
        quantity,
        unit_amount: unit,
        amount: Math.max(0, unit * quantity),
        currency: context.currency,
        created_at: now,
        updated_at: now,
      });
    });
    const shipping = Number(context.data.shippingFee || context.data.shipping_fee || 0) || 0;
    if (shipping > 0) {
      rows.push({
        payment_item_id: `${paymentId}_shipping`,
        payment_id: paymentId,
        branch_id: context.branch_id,
        member_id: context.member_id,
        source_type: context.source_type,
        source_id: context.source_id,
        service_type: context.service_type,
        item_type: 'SHIPPING',
        label: 'Shipping',
        quantity: 1,
        unit_amount: shipping,
        amount: shipping,
        currency: context.currency,
        created_at: now,
        updated_at: now,
      });
    }
    const discount = Number(context.data.discount || 0) || 0;
    if (discount > 0) {
      rows.push({
        payment_item_id: `${paymentId}_discount`,
        payment_id: paymentId,
        branch_id: context.branch_id,
        member_id: context.member_id,
        source_type: context.source_type,
        source_id: context.source_id,
        service_type: context.service_type,
        item_type: 'DISCOUNT',
        label: 'Discount',
        quantity: 1,
        unit_amount: -discount,
        amount: -discount,
        currency: context.currency,
        created_at: now,
        updated_at: now,
      });
    }
    return rows.length ? rows : [genericPaymentItem(context, paymentId, 'ORDER_TOTAL')];
  }
  return [genericPaymentItem(context, paymentId, context.source_type === 'ROOM_BOOKING' ? 'ROOM_HOUR' : context.source_type === 'TABLE_BOOKING' ? 'TABLE_DEPOSIT' : 'PACKAGE')];
}

function genericPaymentItem(context, paymentId, itemType) {
  const now = FieldValue.serverTimestamp();
  return {
    payment_item_id: `${paymentId}_001`,
    payment_id: paymentId,
    branch_id: context.branch_id,
    member_id: context.member_id,
    source_type: context.source_type,
    source_id: context.source_id,
    service_type: context.service_type,
    item_type: itemType,
    label: itemNameForSource(context),
    quantity: 1,
    unit_amount: context.amount,
    amount: context.amount,
    currency: context.currency,
    created_at: now,
    updated_at: now,
  };
}

function pendingSourceUpdate(context, paymentId, provider, paymentEnv) {
  const now = FieldValue.serverTimestamp();
  const update = {
    payment_id: paymentId,
    payment_provider: provider,
    payment_env: paymentEnv,
    payment_environment: paymentEnv,
    payment_status: 'PENDING',
    paymentStatus: 'pending',
    payment_updated_at: now,
    updated_at: now,
    updatedAt: now,
  };
  if (context.source_type === 'SHOP_ORDER') {
    update.status = ['completed', 'cancelled'].includes(cleanString(context.data.status, 40).toLowerCase()) ? context.data.status : 'pending';
  }
  return update;
}

function sourcePaidUpdate(context, paymentId, providerRef) {
  const now = FieldValue.serverTimestamp();
  const update = {
    payment_id: paymentId,
    payment_status: 'PAID_ONLINE',
    paymentStatus: 'paid',
    provider_ref: providerRef,
    paid_at: now,
    paidAt: now,
    payment_updated_at: now,
    updated_at: now,
    updatedAt: now,
  };
  if (context.source_type === 'ARCHERY_BOOKING') {
    update.booking_status = 'CONFIRMED';
    update.status = 'CONFIRMED';
    update.confirmed_at = now;
  } else if (context.source_type === 'TABLE_BOOKING' || context.source_type === 'ROOM_BOOKING') {
    update.booking_status = 'CONFIRMED';
    update.status = 'confirmed';
    update.confirmed_at = now;
  } else if (context.source_type === 'SHOP_ORDER') {
    update.status = cleanString(context.data.status, 40).toLowerCase() === 'completed' ? context.data.status : 'processing';
    update.order_status = update.status;
  }
  return update;
}

function sourcePaymentOnlyUpdate(status) {
  const now = FieldValue.serverTimestamp();
  const legacy = status === 'PENDING' ? 'pending'
    : status === 'PAID_ONLINE' ? 'paid'
      : status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED' ? 'refunded'
        : 'failed';
  return {
    payment_status: status,
    paymentStatus: legacy,
    payment_updated_at: now,
    updated_at: now,
    updatedAt: now,
  };
}

function setPaymentBase(context, paymentId, providerResult, provider, idempotencyKey) {
  const now = FieldValue.serverTimestamp();
  return {
    payment_id: paymentId,
    branch_id: context.branch_id,
    member_id: context.member_id,
    source_type: context.source_type,
    source_id: context.source_id,
    service_type: context.service_type,
    booking_id: context.source_type.endsWith('_BOOKING') ? context.source_id : '',
    order_id: context.source_type === 'SHOP_ORDER' ? context.source_id : '',
    provider,
    payment_env: paymentEnvironment(),
    payment_environment: paymentEnvironment(),
    amount: context.amount,
    amount_minor: context.amount_minor,
    currency: context.currency,
    status: 'PENDING',
    payment_status: 'PENDING',
    payment_method: 'BEAM_CHECKOUT',
    provider_ref: providerResult.provider_ref,
    beam_payment_link_id: providerResult.provider_ref,
    payment_link_url: providerResult.payment_link_url,
    idempotency_key: idempotencyKey,
    raw_provider_response: providerResult.raw,
    paid_at: null,
    refunded_at: null,
    created_at: now,
    updated_at: now,
  };
}

const createShopOrderDraft = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = webOrderBranchId(data.branch_id || data.branchId);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  if (!idempotencyKey) throw apiError('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotency_key is required');

  const rawItems = normalizeShopOrderItems(data.items || data.cart || []);
  const fulfillmentMethod = normalizeFulfillmentMethod(data.fulfillment_method || data.fulfillmentMethod);
  const customerName = normalizeCustomerName(data.customer_name || data.customerName || data.name);
  const phone = normalizeCustomerPhone(data.phone || data.customerPhone);
  const address = cleanString(data.address, 700);
  if (fulfillmentMethod === 'delivery' && !address) {
    throw apiError('DELIVERY_ADDRESS_REQUIRED', 400, 'Delivery address is required');
  }
  const promoCode = cleanString(data.promo_code || data.promoCode, 40).toUpperCase();

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'createShopOrderDraft',
    idempotencyKey,
    actorId: actor.uid,
    payload: {
      items: rawItems.map(item => ({ product_id: item.product_id, raw_id: item.raw_id, variant_id: item.variant_id, quantity: item.quantity })),
      fulfillment_method: fulfillmentMethod,
      promo_code: promoCode,
      customer_name: customerName,
      phone,
      address,
    },
  }, async transaction => {
    const lines = await buildShopOrderLines(transaction, db, rawItems);
    const subtotal = roundMoney(lines.reduce((sum, item) => sum + item.lineTotal, 0));
    if (promoCode && promoCode !== 'EDEN10') throw apiError('PROMO_CODE_INVALID', 400, 'Promo code is invalid');
    const discount = promoCode === 'EDEN10' ? Math.min(subtotal, Math.round(subtotal * 0.1)) : 0;
    const shippingFee = fulfillmentMethod === 'pickup'
      ? 0
      : Math.max(0, Number(envValue('WEB_ORDER_SHIPPING_FEE', DEFAULT_WEB_SHIPPING_FEE)) || DEFAULT_WEB_SHIPPING_FEE);
    const totalAmount = roundMoney(Math.max(0, subtotal + shippingFee - discount));
    if (totalAmount <= 0) throw apiError('ORDER_TOTAL_INVALID', 409, 'Order total must be greater than zero');

    const orderRef = db.collection('orders').doc(paymentDocId('shop_order', `${branchId}:${actor.uid}:${idempotencyKey}`));
    const orderSnap = await transaction.get(orderRef);
    if (orderSnap.exists) {
      const existing = orderSnap.data() || {};
      if (existing.customerUid !== actor.uid && existing.uid !== actor.uid) {
        throw apiError('ORDER_ALREADY_EXISTS', 409, 'Order draft already belongs to another user');
      }
      return {
        source_type: 'SHOP_ORDER',
        source_id: orderRef.id,
        order_id: existing.id || existing.order_id || orderRef.id,
        branch_id: existing.branch_id || branchId,
        amount: Number(existing.totalAmount || existing.total || totalAmount) || totalAmount,
        currency: existing.currency || 'THB',
        status: existing.status || 'pending',
        payment_status: existing.payment_status || existing.paymentStatus || 'UNPAID',
      };
    }

    const now = FieldValue.serverTimestamp();
    const orderId = shopOrderDisplayId(orderRef.id);
    const orderPayload = {
      id: orderId,
      order_id: orderId,
      branch_id: branchId,
      source: 'online',
      orderType: 'shop',
      service_type: 'SHOP_ORDER',
      uid: actor.uid,
      customerUid: actor.uid,
      member_id: actor.uid,
      customerName,
      phone,
      address: fulfillmentMethod === 'pickup' ? 'Pickup at Store' : address,
      fulfillmentMethod,
      items: lines,
      subtotal,
      discount,
      promoCode,
      shippingFee,
      totalAmount,
      total: totalAmount,
      currency: 'THB',
      status: 'pending',
      order_status: 'pending',
      payment_status: 'UNPAID',
      paymentStatus: 'pending',
      paymentMethod: 'beam',
      paymentLabel: 'Beam',
      payment_provider: 'BEAM',
      payment_required: true,
      createdAt: now,
      created_at: now,
      timestamp: now,
      updatedAt: now,
      updated_at: now,
    };

    transaction.set(orderRef, orderPayload);
    writeAuditLog(transaction, db, {
      branchId,
      actor,
      actorType: 'CUSTOMER',
      action: 'createShopOrderDraft',
      targetCollection: 'orders',
      targetId: orderRef.id,
      before: null,
      after: { order_id: orderId, source_id: orderRef.id, payment_status: 'UNPAID', totalAmount },
      requestId,
    });

    return {
      source_type: 'SHOP_ORDER',
      source_id: orderRef.id,
      order_id: orderId,
      branch_id: branchId,
      amount: totalAmount,
      currency: 'THB',
      status: 'pending',
      payment_status: 'UNPAID',
      totals: {
        subtotal,
        discount,
        shippingFee,
        totalAmount,
      },
    };
  });

  return { replayed: result.replayed, ...result.response };
}, {
  name: 'createShopOrderDraft',
  methods: ['POST'],
});

const createPaymentIntent = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  const sourceType = normalizeSourceType(data.source_type || data.sourceType || data.service_type || data.serviceType);
  const sourceId = sourceIdFromInput(data, sourceType);
  const provider = normalizeProvider(data.provider || 'BEAM');
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  if (!sourceId) throw apiError('SOURCE_REQUIRED', 400, 'source_id is required');
  if (!idempotencyKey) throw apiError('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotency_key is required');

  const precheck = await db.runTransaction(async transaction => {
    const context = await readSource(transaction, db, branchId, sourceType, sourceId);
    assertActorCanUseSource(actor, context);
    assertSourcePayable(context);
    const existing = await findExistingPaymentForSource(transaction, db, context, provider);
    if (existing) {
      const status = paymentStatus(existing.data);
      if (status === 'PENDING' && existing.data.payment_link_url) return { existing: existing.data };
      if (PAID_STATUSES.has(status) || status === 'PAID_PENDING_REVIEW') {
        throw apiError('PAYMENT_ALREADY_RECORDED', 409, 'Payment is already recorded for this source');
      }
    }
    return { context };
  });

  if (precheck.existing) {
    return { replayed: true, ...sanitizePayment(precheck.existing) };
  }

  const paymentId = paymentDocId('webpay', `${branchId}:${sourceType}:${sourceId}:${provider}:${idempotencyKey}`);
  const providerResult = await createBeamPaymentLink(beamConfig(), precheck.context, paymentId, idempotencyKey, data.return_url || data.returnUrl);

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'createPaymentIntent',
    idempotencyKey,
    actorId: actor.uid,
    payload: {
      source_type: sourceType,
      source_id: sourceId,
      provider,
      amount: precheck.context.amount,
      provider_ref: providerResult.provider_ref,
    },
  }, async transaction => {
    const context = await readSource(transaction, db, branchId, sourceType, sourceId);
    assertActorCanUseSource(actor, context);
    assertSourcePayable(context);
    const existing = await findExistingPaymentForSource(transaction, db, context, provider);
    if (existing?.data?.payment_link_url) return sanitizePayment(existing.data);

    const paymentRef = db.collection('payments').doc(paymentId);
    const payment = setPaymentBase(context, paymentId, providerResult, provider, idempotencyKey);
    transaction.set(paymentRef, payment, { merge: true });
    paymentItemRows(context, paymentId).forEach(row => {
      transaction.set(db.collection('payment_items').doc(row.payment_item_id), row, { merge: true });
    });
    const allocationId = paymentDocId('payalloc', `${paymentId}:${context.source_type}:${context.source_id}`);
    transaction.set(db.collection('payment_allocations').doc(allocationId), {
      payment_allocation_id: allocationId,
      payment_id: paymentId,
      branch_id: context.branch_id,
      member_id: context.member_id,
      source_type: context.source_type,
      source_id: context.source_id,
      service_type: context.service_type,
      allocation_type: 'SOURCE_TOTAL',
      amount: context.amount,
      amount_minor: context.amount_minor,
      currency: context.currency,
      status: 'PENDING',
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.update(context.ref, pendingSourceUpdate(context, paymentId, provider, payment.payment_env));
    writeAuditLog(transaction, db, {
      branchId: context.branch_id,
      actor,
      actorType: actor.uid === context.member_id ? 'CUSTOMER' : 'STAFF',
      action: 'createPaymentIntent',
      targetCollection: 'payments',
      targetId: paymentId,
      before: context.data,
      after: { payment_id: paymentId, source_type: context.source_type, source_id: context.source_id, payment_status: 'PENDING' },
      requestId,
    });
    return sanitizePayment(payment);
  });

  return { replayed: result.replayed, ...result.response };
}, {
  name: 'createPaymentIntent',
  methods: ['POST'],
  secrets: BEAM_RUNTIME_SECRETS,
});

async function readPaymentByInput(transaction, db, data = {}) {
  const branchId = normalizeBranchId(data.branch_id);
  const paymentIdInput = cleanString(data.payment_id || data.paymentId, 180);
  if (paymentIdInput) {
    const ref = db.collection('payments').doc(paymentIdInput);
    const snap = await transaction.get(ref);
    if (!snap.exists) throw apiError('PAYMENT_NOT_FOUND', 404, 'Payment was not found');
    const payment = snap.data() || {};
    if (payment.branch_id !== branchId) throw apiError('PAYMENT_NOT_FOUND', 404, 'Payment was not found for this branch');
    return { ref, data: payment };
  }
  const sourceType = normalizeSourceType(data.source_type || data.sourceType || data.service_type || data.serviceType);
  const sourceId = sourceIdFromInput(data, sourceType);
  if (!sourceId) throw apiError('SOURCE_REQUIRED', 400, 'source_id is required');
  const context = await readSource(transaction, db, branchId, sourceType, sourceId);
  const existing = await findExistingPaymentForSource(transaction, db, context, normalizeProvider(data.provider || 'BEAM'));
  if (!existing) throw apiError('PAYMENT_NOT_FOUND', 404, 'Payment was not found for this source');
  return existing;
}

const getPaymentStatus = httpFunction(async ({ db, data, actor }) => {
  const result = await db.runTransaction(async transaction => {
    const payment = await readPaymentByInput(transaction, db, data);
    const sourceType = normalizeSourceType(payment.data.source_type || payment.data.service_type || (payment.data.order_id ? 'SHOP_ORDER' : 'ARCHERY_BOOKING'));
    const sourceId = cleanString(payment.data.source_id || payment.data.booking_id || payment.data.order_id, 180);
    const context = await readSource(transaction, db, payment.data.branch_id, sourceType, sourceId);
    assertActorCanUseSource(actor, context);
    return {
      payment: sanitizePayment(payment.data),
      source: {
        source_type: context.source_type,
        source_id: context.source_id,
        status: context.status,
        payment_status: context.payment_status,
      },
    };
  });
  return result;
}, {
  name: 'getPaymentStatus',
  methods: ['POST'],
});

const listPaymentsForSource = httpFunction(async ({ db, data, actor }) => {
  const branchId = normalizeBranchId(data.branch_id);
  const sourceType = normalizeSourceType(data.source_type || data.sourceType || data.service_type || data.serviceType);
  const sourceId = sourceIdFromInput(data, sourceType);
  if (!sourceId) throw apiError('SOURCE_REQUIRED', 400, 'source_id is required');
  const context = await db.runTransaction(async transaction => {
    const source = await readSource(transaction, db, branchId, sourceType, sourceId);
    assertActorCanUseSource(actor, source);
    return source;
  });
  const snap = await db.collection('payments')
    .where('branch_id', '==', context.branch_id)
    .where('source_type', '==', sourceType)
    .where('source_id', '==', sourceId)
    .limit(20)
    .get();
  return { payments: snap.docs.map(docSnap => sanitizePayment(docSnap.data() || {})) };
}, {
  name: 'listPaymentsForSource',
  methods: ['POST'],
});

const cancelPendingPayment = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  const reason = cleanString(data.reason || 'Customer cancelled pending payment', 500);
  if (!idempotencyKey) throw apiError('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotency_key is required');

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'cancelPendingPayment',
    idempotencyKey,
    actorId: actor.uid,
    payload: {
      payment_id: data.payment_id || data.paymentId || '',
      source_type: data.source_type || data.sourceType || '',
      source_id: data.source_id || data.sourceId || '',
      reason,
    },
  }, async transaction => {
    const payment = await readPaymentByInput(transaction, db, data);
    const sourceType = normalizeSourceType(payment.data.source_type || payment.data.service_type || (payment.data.order_id ? 'SHOP_ORDER' : 'ARCHERY_BOOKING'));
    const sourceId = cleanString(payment.data.source_id || payment.data.booking_id || payment.data.order_id, 180);
    const context = await readSource(transaction, db, branchId, sourceType, sourceId);
    assertActorCanUseSource(actor, context);
    const status = paymentStatus(payment.data);
    if (!['UNPAID', 'PENDING', 'FAILED'].includes(status)) throw apiError('PAYMENT_STATE_INVALID', 409, 'Only pending payments can be cancelled');
    transaction.update(payment.ref, {
      status: 'CANCELLED',
      payment_status: 'CANCELLED',
      cancel_reason: reason,
      cancelled_by: actor.uid,
      cancelled_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
    transaction.update(context.ref, sourcePaymentOnlyUpdate('CANCELLED'));
    writeAuditLog(transaction, db, {
      branchId,
      actor,
      actorType: actor.uid === context.member_id ? 'CUSTOMER' : 'STAFF',
      action: 'cancelPendingPayment',
      targetCollection: 'payments',
      targetId: payment.ref.id,
      before: payment.data,
      after: { payment_id: payment.ref.id, payment_status: 'CANCELLED' },
      reason,
      requestId,
    });
    return { payment_id: payment.ref.id, status: 'CANCELLED', payment_status: 'CANCELLED' };
  });

  return { replayed: result.replayed, ...result.response };
}, {
  name: 'cancelPendingPayment',
  methods: ['POST'],
});

function refundedAmount(payment = {}) {
  return Number(payment.refunded_amount || payment.refund_amount || 0) || 0;
}

const requestRefund = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  const reason = cleanString(data.reason, 500);
  if (!idempotencyKey) throw apiError('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotency_key is required');
  if (!reason) throw apiError('REASON_REQUIRED', 400, 'reason is required');

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'requestRefund',
    idempotencyKey,
    actorId: actor.uid,
    payload: {
      payment_id: data.payment_id || data.paymentId || '',
      amount: data.amount,
      reason,
    },
  }, async transaction => {
    const payment = await readPaymentByInput(transaction, db, data);
    const sourceType = normalizeSourceType(payment.data.source_type || payment.data.service_type || (payment.data.order_id ? 'SHOP_ORDER' : 'ARCHERY_BOOKING'));
    const sourceId = cleanString(payment.data.source_id || payment.data.booking_id || payment.data.order_id, 180);
    const context = await readSource(transaction, db, branchId, sourceType, sourceId);
    assertActorCanUseSource(actor, context);
    const status = paymentStatus(payment.data);
    if (!['PAID_ONLINE', 'PARTIALLY_REFUNDED'].includes(status)) throw apiError('PAYMENT_STATE_INVALID', 409, 'Only paid online payments can be refunded');
    const paidAmount = Number(payment.data.amount || 0) || 0;
    const amount = Number(data.amount || paidAmount) || 0;
    const remaining = Math.max(0, paidAmount - refundedAmount(payment.data));
    if (amount <= 0 || amount > remaining) throw apiError('REFUND_AMOUNT_INVALID', 400, 'Refund amount exceeds refundable balance');
    const refundRequestId = paymentDocId('refund_request', `${payment.ref.id}:${idempotencyKey}`);
    const refundRequestRef = db.collection('refund_requests').doc(refundRequestId);
    const payload = {
      refund_request_id: refundRequestId,
      branch_id: branchId,
      payment_id: payment.ref.id,
      member_id: context.member_id,
      source_type: context.source_type,
      source_id: context.source_id,
      service_type: context.service_type,
      amount,
      amount_minor: amountMinor(amount),
      currency: payment.data.currency || 'THB',
      reason,
      status: 'REQUESTED',
      requested_by: actor.uid,
      requested_by_role: actor.role,
      idempotency_key: idempotencyKey,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    };
    transaction.set(refundRequestRef, payload, { merge: true });
    transaction.update(payment.ref, {
      status: 'REFUND_REQUESTED',
      payment_status: 'REFUND_REQUESTED',
      refund_requested_amount: amount,
      refund_request_id: refundRequestId,
      updated_at: FieldValue.serverTimestamp(),
    });
    writeAuditLog(transaction, db, {
      branchId,
      actor,
      actorType: actor.uid === context.member_id ? 'CUSTOMER' : 'STAFF',
      action: 'requestRefund',
      targetCollection: 'refund_requests',
      targetId: refundRequestId,
      before: payment.data,
      after: { refund_request_id: refundRequestId, status: 'REQUESTED', amount },
      reason,
      requestId,
    });
    return { refund_request_id: refundRequestId, status: 'REQUESTED' };
  });

  return { replayed: result.replayed, ...result.response };
}, {
  name: 'requestRefund',
  methods: ['POST'],
});

const approveRefund = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  requireRoles(actor, ['OWNER', 'MANAGER'], branchId);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const refundRequestId = cleanString(data.refund_request_id || data.refundRequestId, 180);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  const approvalAction = safeUpper(data.approval_action || data.approvalAction || 'APPROVE', 40);
  const reason = cleanString(data.reason, 500);
  if (!refundRequestId) throw apiError('REFUND_REQUEST_REQUIRED', 400, 'refund_request_id is required');
  if (!idempotencyKey) throw apiError('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotency_key is required');

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'approveRefund',
    idempotencyKey,
    actorId: actor.uid,
    payload: { refund_request_id: refundRequestId, approval_action: approvalAction, reason },
  }, async transaction => {
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    const requestRef = db.collection('refund_requests').doc(refundRequestId);
    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists) throw apiError('REFUND_REQUEST_NOT_FOUND', 404, 'Refund request was not found');
    const request = requestSnap.data() || {};
    if (request.branch_id !== branchId) throw apiError('REFUND_REQUEST_NOT_FOUND', 404, 'Refund request was not found for this branch');
    const paymentRef = db.collection('payments').doc(request.payment_id);
    const paymentSnap = await transaction.get(paymentRef);
    if (!paymentSnap.exists) throw apiError('PAYMENT_NOT_FOUND', 404, 'Payment was not found');
    const payment = paymentSnap.data() || {};
    const sourceType = normalizeSourceType(request.source_type || payment.source_type || payment.service_type || (payment.order_id ? 'SHOP_ORDER' : 'ARCHERY_BOOKING'));
    const sourceId = cleanString(request.source_id || payment.source_id || payment.booking_id || payment.order_id, 180);
    const context = await readSource(transaction, db, branchId, sourceType, sourceId);

    if (approvalAction === 'REJECT') {
      transaction.update(requestRef, {
        status: 'REJECTED',
        rejected_by: actor.uid,
        rejected_at: FieldValue.serverTimestamp(),
        rejection_reason: reason,
        updated_at: FieldValue.serverTimestamp(),
      });
      transaction.update(paymentRef, {
        status: payment.previous_paid_status || 'PAID_ONLINE',
        payment_status: payment.previous_paid_status || 'PAID_ONLINE',
        updated_at: FieldValue.serverTimestamp(),
      });
      writeAuditLog(transaction, db, {
        branchId,
        actor,
        staffSessionId,
        action: 'rejectRefund',
        targetCollection: 'refund_requests',
        targetId: refundRequestId,
        before: request,
        after: { refund_request_id: refundRequestId, status: 'REJECTED' },
        reason,
        requestId,
      });
      return { refund_request_id: refundRequestId, status: 'REJECTED' };
    }

    const refundId = paymentDocId('refund', `${refundRequestId}:${idempotencyKey}`);
    const markRefunded = Boolean(data.mark_refunded || data.markRefunded || data.provider_refund_ref || data.providerRefundRef);
    const refundStatus = markRefunded ? 'REFUNDED' : 'PENDING_PROVIDER';
    const refundedTotal = refundedAmount(payment) + Number(request.amount || 0);
    const paymentRefundStatus = markRefunded
      ? (refundedTotal >= (Number(payment.amount || 0) || 0) ? 'REFUNDED' : 'PARTIALLY_REFUNDED')
      : 'REFUND_REQUESTED';
    transaction.set(db.collection('refunds').doc(refundId), {
      refund_id: refundId,
      refund_request_id: refundRequestId,
      branch_id: branchId,
      payment_id: paymentRef.id,
      member_id: context.member_id,
      source_type: context.source_type,
      source_id: context.source_id,
      service_type: context.service_type,
      provider: payment.provider || 'BEAM',
      provider_refund_ref: cleanString(data.provider_refund_ref || data.providerRefundRef, 180),
      amount: Number(request.amount || 0) || 0,
      amount_minor: Number(request.amount_minor || amountMinor(request.amount)) || 0,
      currency: request.currency || payment.currency || 'THB',
      status: refundStatus,
      approved_by: actor.uid,
      approved_at: FieldValue.serverTimestamp(),
      refunded_at: markRefunded ? FieldValue.serverTimestamp() : null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.update(requestRef, {
      status: refundStatus === 'REFUNDED' ? 'COMPLETED' : 'APPROVED',
      approved_by: actor.uid,
      approved_at: FieldValue.serverTimestamp(),
      refund_id: refundId,
      updated_at: FieldValue.serverTimestamp(),
    });
    transaction.update(paymentRef, {
      status: paymentRefundStatus,
      payment_status: paymentRefundStatus,
      refunded_amount: markRefunded ? refundedTotal : refundedAmount(payment),
      refunded_at: markRefunded && paymentRefundStatus === 'REFUNDED' ? FieldValue.serverTimestamp() : (payment.refunded_at || null),
      updated_at: FieldValue.serverTimestamp(),
    });
    if (markRefunded) transaction.update(context.ref, sourcePaymentOnlyUpdate(paymentRefundStatus));
    transaction.set(db.collection('payment_allocations').doc(paymentDocId('payalloc_refund', `${refundId}:${paymentRef.id}`)), {
      payment_allocation_id: paymentDocId('payalloc_refund', `${refundId}:${paymentRef.id}`),
      payment_id: paymentRef.id,
      refund_id: refundId,
      branch_id: branchId,
      member_id: context.member_id,
      source_type: context.source_type,
      source_id: context.source_id,
      service_type: context.service_type,
      allocation_type: 'REFUND',
      amount: -Math.abs(Number(request.amount || 0) || 0),
      amount_minor: -Math.abs(Number(request.amount_minor || amountMinor(request.amount)) || 0),
      currency: request.currency || payment.currency || 'THB',
      status: refundStatus,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
    writeAuditLog(transaction, db, {
      branchId,
      actor,
      staffSessionId,
      action: 'approveRefund',
      targetCollection: 'refunds',
      targetId: refundId,
      before: request,
      after: { refund_id: refundId, status: refundStatus, payment_status: paymentRefundStatus },
      reason,
      requestId,
    });
    return { refund_id: refundId, refund_status: refundStatus, payment_status: paymentRefundStatus };
  });

  return { replayed: result.replayed, ...result.response };
}, {
  name: 'approveRefund',
  methods: ['POST'],
});

function receiptNo(paymentId) {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `WEB-${ymd}-${sha256(paymentId).slice(0, 8).toUpperCase()}`;
}

function writeReceipt(transaction, db, payment, context, actor = { uid: 'SYSTEM', role: 'SYSTEM', system: true }) {
  const receiptId = paymentDocId('web_receipt', payment.payment_id || payment.id || context.source_id);
  const receiptRef = db.collection('receipts').doc(receiptId);
  transaction.set(receiptRef, {
    receipt_id: receiptId,
    receipt_no: receiptNo(payment.payment_id || receiptId),
    receipt_type: 'WEB',
    branch_id: context.branch_id,
    member_id: context.member_id,
    payment_id: payment.payment_id,
    source_type: context.source_type,
    source_id: context.source_id,
    service_type: context.service_type,
    amount: Number(payment.amount || context.amount || 0) || 0,
    amount_minor: Number(payment.amount_minor || context.amount_minor || 0) || 0,
    currency: payment.currency || context.currency || 'THB',
    status: 'ISSUED',
    issued_by: cleanString(actor.uid || 'SYSTEM', 180),
    issued_by_role: cleanString(actor.role || 'SYSTEM', 80),
    issued_at: FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });
  return receiptRef;
}

const issueWebReceipt = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  requireRoles(actor, ['OWNER', 'MANAGER'], branchId);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  if (!idempotencyKey) throw apiError('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotency_key is required');

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'issueWebReceipt',
    idempotencyKey,
    actorId: actor.uid,
    payload: { payment_id: data.payment_id || data.paymentId || '' },
  }, async transaction => {
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    const payment = await readPaymentByInput(transaction, db, data);
    const status = paymentStatus(payment.data);
    if (!['PAID_ONLINE', 'PARTIALLY_REFUNDED'].includes(status)) throw apiError('PAYMENT_STATE_INVALID', 409, 'Only paid web payments can receive a receipt');
    const sourceType = normalizeSourceType(payment.data.source_type || payment.data.service_type || (payment.data.order_id ? 'SHOP_ORDER' : 'ARCHERY_BOOKING'));
    const sourceId = cleanString(payment.data.source_id || payment.data.booking_id || payment.data.order_id, 180);
    const context = await readSource(transaction, db, branchId, sourceType, sourceId);
    const receiptRef = writeReceipt(transaction, db, payment.data, context, actor);
    transaction.update(payment.ref, {
      receipt_id: receiptRef.id,
      updated_at: FieldValue.serverTimestamp(),
    });
    writeAuditLog(transaction, db, {
      branchId,
      actor,
      staffSessionId,
      action: 'issueWebReceipt',
      targetCollection: 'receipts',
      targetId: receiptRef.id,
      before: payment.data,
      after: { receipt_id: receiptRef.id, payment_id: payment.ref.id },
      requestId,
    });
    return { receipt_id: receiptRef.id, receipt_no: receiptNo(payment.ref.id), status: 'ISSUED' };
  });

  return { replayed: result.replayed, ...result.response };
}, {
  name: 'issueWebReceipt',
  methods: ['POST'],
});

const reconcileLatePayment = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  requireRoles(actor, ['OWNER', 'MANAGER'], branchId);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const reconciliationId = cleanString(data.reconciliation_id || data.reconciliationId, 180);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  const action = safeUpper(data.action || 'MARK_REVIEWED', 60);
  const reason = cleanString(data.reason, 500);
  if (!reconciliationId) throw apiError('RECONCILIATION_REQUIRED', 400, 'reconciliation_id is required');
  if (!idempotencyKey) throw apiError('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotency_key is required');

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'reconcileLatePayment',
    idempotencyKey,
    actorId: actor.uid,
    payload: { reconciliation_id: reconciliationId, action, reason },
  }, async transaction => {
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    const queueRef = db.collection('payment_reconciliation_queue').doc(reconciliationId);
    const queueSnap = await transaction.get(queueRef);
    if (!queueSnap.exists) throw apiError('RECONCILIATION_NOT_FOUND', 404, 'Reconciliation item was not found');
    const queue = queueSnap.data() || {};
    if (queue.branch_id !== branchId) throw apiError('RECONCILIATION_NOT_FOUND', 404, 'Reconciliation item was not found for this branch');
    const paymentRef = db.collection('payments').doc(queue.payment_id);
    const paymentSnap = queue.payment_id ? await transaction.get(paymentRef) : null;
    const payment = paymentSnap?.exists ? paymentSnap.data() || {} : null;
    let context = null;
    if (payment) {
      const sourceType = normalizeSourceType(queue.source_type || payment.source_type || payment.service_type || (payment.order_id ? 'SHOP_ORDER' : 'ARCHERY_BOOKING'));
      const sourceId = cleanString(queue.source_id || payment.source_id || payment.booking_id || payment.order_id, 180);
      context = await readSource(transaction, db, branchId, sourceType, sourceId);
      if (action === 'HONOR_PAYMENT' || action === 'CONFIRM_SOURCE') {
        if (context.source_type === 'ARCHERY_BOOKING') {
          await updateLocksForBooking(transaction, db, branchId, context.source_id, {
            lock_status: 'CONFIRMED',
            status: 'CONFIRMED',
            expires_at: null,
            hold_expires_at: null,
          });
        }
      }
    }

    if ((action === 'HONOR_PAYMENT' || action === 'CONFIRM_SOURCE') && payment && context) {
      transaction.update(paymentRef, {
        status: 'PAID_ONLINE',
        payment_status: 'PAID_ONLINE',
        reviewed_by: actor.uid,
        reviewed_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
      transaction.update(context.ref, sourcePaidUpdate(context, paymentRef.id, payment.provider_ref || queue.provider_ref || ''));
      transaction.update(queueRef, {
        status: 'RESOLVED',
        resolution: action,
        reviewed_by: actor.uid,
        reviewed_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
    } else if (action === 'REQUEST_REFUND' && payment && context) {
      const refundRequestId = paymentDocId('refund_request', `${paymentRef.id}:${reconciliationId}`);
      transaction.set(db.collection('refund_requests').doc(refundRequestId), {
        refund_request_id: refundRequestId,
        branch_id: branchId,
        payment_id: paymentRef.id,
        member_id: context.member_id,
        source_type: context.source_type,
        source_id: context.source_id,
        service_type: context.service_type,
        amount: Number(payment.amount || queue.amount || 0) || 0,
        amount_minor: Number(payment.amount_minor || queue.amount_minor || 0) || 0,
        currency: payment.currency || queue.currency || 'THB',
        reason: reason || queue.reason || 'Late payment reconciliation refund',
        status: 'REQUESTED',
        requested_by: actor.uid,
        requested_by_role: actor.role,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.update(queueRef, {
        status: 'REFUND_REQUESTED',
        refund_request_id: refundRequestId,
        reviewed_by: actor.uid,
        reviewed_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
    } else {
      transaction.update(queueRef, {
        status: 'REVIEWED',
        resolution: action,
        reviewed_by: actor.uid,
        reviewed_at: FieldValue.serverTimestamp(),
        review_reason: reason,
        updated_at: FieldValue.serverTimestamp(),
      });
    }

    writeAuditLog(transaction, db, {
      branchId,
      actor,
      staffSessionId,
      action: 'reconcileLatePayment',
      targetCollection: 'payment_reconciliation_queue',
      targetId: reconciliationId,
      before: queue,
      after: { reconciliation_id: reconciliationId, action },
      reason,
      requestId,
    });
    return { reconciliation_id: reconciliationId, status: action === 'REQUEST_REFUND' ? 'REFUND_REQUESTED' : action === 'HONOR_PAYMENT' || action === 'CONFIRM_SOURCE' ? 'RESOLVED' : 'REVIEWED' };
  });

  return { replayed: result.replayed, ...result.response };
}, {
  name: 'reconcileLatePayment',
  methods: ['POST'],
});

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

function webhookEvent(req) {
  return cleanString(req.get('x-beam-event') || req.get('X-Beam-Event'), 80);
}

function webhookProviderRef(payload = {}) {
  return cleanString(payload.chargeId || payload.paymentLinkId || payload.cardAuthorizationId || payload.transactionId || payload.sourceId, 180);
}

function webhookReferenceId(payload = {}) {
  return cleanString(payload.referenceId || payload.order?.referenceId || payload.internalNote, 500);
}

function webhookIdentity(eventType, payload = {}) {
  return cleanString(payload.chargeId || payload.paymentLinkId || payload.cardAuthorizationId || payload.transactionId || payload.sourceId || `${eventType}:${JSON.stringify(payload)}`, 500);
}

function webhookCurrency(payload = {}) {
  return cleanString(payload.currency || payload.order?.currency, 10).toUpperCase();
}

function webhookAmountMinor(payload = {}) {
  const raw = payload.amount ?? payload.order?.netAmount ?? payload.grossAmount;
  return Math.round(Number(raw) || 0);
}

function isWebhookPaid(payload = {}) {
  const status = safeUpper(payload.status || payload.latestChargeStatus, 80);
  return status === 'PAID' || status === 'SUCCEEDED';
}

function setWebhookCors(req, res) {
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

async function findPaymentForWebhook(transaction, db, parsedRef, providerRef) {
  if (providerRef) {
    const byProvider = await transaction.get(
      db.collection('payments')
        .where('provider', '==', 'BEAM')
        .where('provider_ref', '==', providerRef)
        .limit(3)
    );
    if (!byProvider.empty) {
      const matches = byProvider.docs.map(docSnap => ({ ref: docSnap.ref, data: docSnap.data() || {} }));
      const selected = parsedRef?.payment_id
        ? matches.find(match => match.ref.id === parsedRef.payment_id)
        : matches[0];
      const payment = selected || matches[0];
      const parsedSourceMismatch = parsedRef && (
        cleanString(payment.data.source_type || payment.data.service_type, 80).toUpperCase() !== parsedRef.source_type
        || cleanString(payment.data.source_id || payment.data.booking_id || payment.data.order_id, 180) !== parsedRef.source_id
      );
      return {
        ...payment,
        provider_ref_collision: matches.length > 1 || parsedSourceMismatch,
        provider_ref_match_count: matches.length,
      };
    }
  }
  if (parsedRef?.payment_id) {
    const ref = db.collection('payments').doc(parsedRef.payment_id);
    const snap = await transaction.get(ref);
    if (snap.exists) return { ref, data: snap.data() || {} };
  }
  return null;
}

function webhookEventBase(eventId, payload, eventType, providerRef, signature) {
  const parsedRef = parseWebReferenceId(webhookReferenceId(payload));
  return {
    webhook_event_id: eventId,
    branch_id: '',
    provider: 'BEAM',
    payment_env: paymentEnvironment(),
    payment_environment: paymentEnvironment(),
    event_type: eventType,
    provider_ref: providerRef,
    source_type: parsedRef?.source_type || '',
    source_id: parsedRef?.source_id || '',
    payment_id: parsedRef?.payment_id || '',
    signature_hash: sha256(signature),
    raw_payload_hash: sha256(rawRequestBody({ rawBody: Buffer.from(JSON.stringify(payload || {})) })),
    status: 'RECEIVED',
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  };
}

function writeReconciliation(transaction, db, options = {}) {
  const id = paymentDocId('webpay_late', `${options.provider_ref}:${options.payment_id}:${options.reason}`);
  const ref = db.collection('payment_reconciliation_queue').doc(id);
  transaction.set(ref, {
    reconciliation_id: id,
    branch_id: options.branch_id || '',
    payment_id: options.payment_id || '',
    member_id: options.member_id || '',
    source_type: options.source_type || '',
    source_id: options.source_id || '',
    service_type: options.service_type || '',
    provider: 'BEAM',
    payment_env: paymentEnvironment(),
    payment_environment: paymentEnvironment(),
    provider_ref: options.provider_ref || '',
    amount: Number(options.amount || 0) || 0,
    amount_minor: Number(options.amount_minor || 0) || 0,
    currency: options.currency || 'THB',
    reason: options.reason || 'REVIEW_REQUIRED',
    status: 'OPEN',
    raw_webhook_payload: options.payload || null,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  }, { merge: true });
  return ref;
}

function webhookFailureStatus(eventType) {
  if (FAILED_EVENTS.has(eventType)) return 'FAILED';
  if (CANCELLED_EVENTS.has(eventType)) return 'CANCELLED';
  return 'IGNORED';
}

const paymentWebhook = onRequest({
  region: REGION,
  secrets: BEAM_RUNTIME_SECRETS,
}, async (req, res) => {
  setWebhookCors(req, res);
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
    const config = beamConfig({ webhook: true });
    const signature = verifyBeamSignature(req, config.webhookSecret);
    const eventType = webhookEvent(req);
    if (!ALLOWED_WEBHOOK_EVENTS.has(eventType)) throw apiError('WEBHOOK_EVENT_NOT_SUPPORTED', 400, 'Beam event is not supported');
    const payload = req.body || {};
    if (cleanString(payload.merchantId, 180) !== config.merchantId) {
      throw apiError('WEBHOOK_MERCHANT_MISMATCH', 403, `Beam merchant does not match ${config.environment} merchant`);
    }
    const parsedRef = parseWebReferenceId(webhookReferenceId(payload));
    const providerRef = webhookProviderRef(payload);
    if (!providerRef && !parsedRef?.payment_id) throw apiError('PAYMENT_REQUIRED', 400, 'Beam webhook payment reference is missing');
    const eventId = paymentDocId('webpay_webhook', `${eventType}:${webhookIdentity(eventType, payload)}:${sha256(rawRequestBody(req))}`);
    const payloadAmountMinor = webhookAmountMinor(payload);
    const payloadCurrency = webhookCurrency(payload);

    const result = await db.runTransaction(async transaction => {
      const webhookEventRef = db.collection('payment_webhook_events').doc(eventId);
      const eventSnap = await transaction.get(webhookEventRef);
      if (eventSnap.exists) return { status: 'DUPLICATE', duplicate: true, webhook_event_id: eventId };

      const payment = await findPaymentForWebhook(transaction, db, parsedRef, providerRef);
      const base = webhookEventBase(eventId, payload, eventType, providerRef, signature);
      if (!payment) {
        const queueRef = writeReconciliation(transaction, db, {
          provider_ref: providerRef,
          payment_id: parsedRef?.payment_id || '',
          source_type: parsedRef?.source_type || '',
          source_id: parsedRef?.source_id || '',
          amount_minor: payloadAmountMinor,
          currency: payloadCurrency || 'THB',
          reason: 'PAYMENT_NOT_FOUND',
          payload,
        });
        transaction.set(webhookEventRef, {
          ...base,
          status: 'RECONCILIATION_REQUIRED',
          reconciliation_id: queueRef.id,
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { status: 'RECONCILIATION_REQUIRED', reconciliation_id: queueRef.id };
      }

      if (payment.provider_ref_collision) {
        const queueRef = writeReconciliation(transaction, db, {
          branch_id: payment.data.branch_id || '',
          payment_id: payment.ref.id,
          member_id: payment.data.member_id || '',
          source_type: payment.data.source_type || parsedRef?.source_type || '',
          source_id: payment.data.source_id || payment.data.booking_id || payment.data.order_id || parsedRef?.source_id || '',
          service_type: payment.data.service_type || payment.data.source_type || '',
          provider_ref: providerRef,
          amount: payment.data.amount || 0,
          amount_minor: payloadAmountMinor,
          currency: payloadCurrency || payment.data.currency || 'THB',
          reason: 'PROVIDER_REF_COLLISION',
          payload,
        });
        transaction.set(webhookEventRef, {
          ...base,
          branch_id: payment.data.branch_id || '',
          payment_id: payment.ref.id,
          source_type: payment.data.source_type || parsedRef?.source_type || '',
          source_id: payment.data.source_id || payment.data.booking_id || payment.data.order_id || parsedRef?.source_id || '',
          status: 'RECONCILIATION_REQUIRED',
          reconciliation_id: queueRef.id,
          provider_ref_match_count: payment.provider_ref_match_count,
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { status: 'RECONCILIATION_REQUIRED', reconciliation_id: queueRef.id, payment_id: payment.ref.id };
      }

      const sourceType = normalizeSourceType(payment.data.source_type || payment.data.service_type || parsedRef?.source_type || (payment.data.order_id ? 'SHOP_ORDER' : 'ARCHERY_BOOKING'));
      const sourceId = cleanString(payment.data.source_id || payment.data.booking_id || payment.data.order_id || parsedRef?.source_id, 180);
      const context = await readSource(transaction, db, payment.data.branch_id, sourceType, sourceId);
      base.branch_id = context.branch_id;
      base.source_type = context.source_type;
      base.source_id = context.source_id;
      base.payment_id = payment.ref.id;

      const currentStatus = paymentStatus(payment.data);
      if (TERMINAL_STATUSES.has(currentStatus)) {
        transaction.set(webhookEventRef, {
          ...base,
          status: 'DUPLICATE_PAYMENT',
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { status: 'DUPLICATE_PAYMENT', duplicate: true, payment_id: payment.ref.id, source_id: context.source_id };
      }

      if (SUCCESS_EVENTS.has(eventType)) {
        if (!isWebhookPaid(payload)) throw apiError('PAYMENT_STATUS_INVALID', 409, 'Beam payment was not successful');
        const mismatch = payloadAmountMinor !== Number(payment.data.amount_minor || context.amount_minor)
          ? 'PAYMENT_AMOUNT_MISMATCH'
          : payloadCurrency !== context.currency
            ? 'PAYMENT_CURRENCY_MISMATCH'
            : '';
        const late = !statusAllowsPayment(context.source_type, context.data)
          || (context.expires_at && context.expires_at.getTime() <= Date.now());

        if (context.source_type === 'ARCHERY_BOOKING' && !mismatch && !late) {
          await updateLocksForBooking(transaction, db, context.branch_id, context.source_id, {
            lock_status: 'CONFIRMED',
            status: 'CONFIRMED',
            expires_at: null,
            hold_expires_at: null,
          });
        }

        if (mismatch || late) {
          transaction.update(payment.ref, {
            status: 'PAID_PENDING_REVIEW',
            payment_status: 'PAID_PENDING_REVIEW',
            provider_ref: providerRef || payment.data.provider_ref || '',
            raw_webhook_payload: payload,
            paid_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
          });
          const queueRef = writeReconciliation(transaction, db, {
            branch_id: context.branch_id,
            payment_id: payment.ref.id,
            member_id: context.member_id,
            source_type: context.source_type,
            source_id: context.source_id,
            service_type: context.service_type,
            provider_ref: providerRef || payment.data.provider_ref || '',
            amount: payment.data.amount || context.amount,
            amount_minor: payloadAmountMinor,
            currency: payloadCurrency || context.currency,
            reason: mismatch || 'SOURCE_NOT_PAYABLE_OR_EXPIRED',
            payload,
          });
          transaction.set(webhookEventRef, {
            ...base,
            status: 'RECONCILIATION_REQUIRED',
            reconciliation_id: queueRef.id,
            updated_at: FieldValue.serverTimestamp(),
          }, { merge: true });
          return { status: 'RECONCILIATION_REQUIRED', reconciliation_id: queueRef.id, payment_id: payment.ref.id };
        }

        const paidPayment = {
          ...payment.data,
          payment_id: payment.ref.id,
          status: 'PAID_ONLINE',
          payment_status: 'PAID_ONLINE',
          provider_ref: providerRef || payment.data.provider_ref || '',
        };
        const receiptRef = writeReceipt(transaction, db, paidPayment, context);
        transaction.update(payment.ref, {
          status: 'PAID_ONLINE',
          payment_status: 'PAID_ONLINE',
          provider_ref: providerRef || payment.data.provider_ref || '',
          raw_webhook_payload: payload,
          receipt_id: receiptRef.id,
          paid_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        });
        transaction.update(context.ref, sourcePaidUpdate(context, payment.ref.id, providerRef || payment.data.provider_ref || ''));
        transaction.set(webhookEventRef, {
          ...base,
          status: 'PROCESSED',
          receipt_id: receiptRef.id,
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: true });
        writeAuditLog(transaction, db, {
          branchId: context.branch_id,
          actor: { uid: 'BEAM_WEBHOOK', role: 'SYSTEM', system: true },
          actorType: 'SYSTEM',
          action: 'paymentWebhook',
          targetCollection: sourceCollection(context.source_type),
          targetId: context.source_id,
          before: context.data,
          after: { source_id: context.source_id, payment_id: payment.ref.id, payment_status: 'PAID_ONLINE' },
        });
        return { status: 'PROCESSED', payment_id: payment.ref.id, source_id: context.source_id, receipt_id: receiptRef.id };
      }

      const failedStatus = webhookFailureStatus(eventType);
      transaction.update(payment.ref, {
        status: failedStatus,
        payment_status: failedStatus,
        provider_ref: providerRef || payment.data.provider_ref || '',
        raw_webhook_payload: payload,
        updated_at: FieldValue.serverTimestamp(),
      });
      transaction.update(context.ref, sourcePaymentOnlyUpdate(failedStatus));
      transaction.set(webhookEventRef, {
        ...base,
        status: failedStatus,
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { status: failedStatus, payment_id: payment.ref.id, source_id: context.source_id };
    });

    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    logger.warn('Unified web payment webhook failed', {
      code: error.code || '',
      status: error.statusCode || 500,
      error_message: error.message,
      event: webhookEvent(req),
    });
    sendError(res, error);
  }
});

module.exports = {
  createShopOrderDraft,
  createPaymentIntent,
  getPaymentStatus,
  listPaymentsForSource,
  cancelPendingPayment,
  requestRefund,
  approveRefund,
  reconcileLatePayment,
  issueWebReceipt,
  paymentWebhook,
};
