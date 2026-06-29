const { FieldValue, Timestamp } = require('../shared/firestore');
const { apiError, cleanString, timestampToDate } = require('../shared/time');
const { sha256 } = require('../shared/idempotency');
const { writeAuditLog } = require('../shared/audit');

const PROMO_CHANNELS = new Set(['POS', 'SHOP', 'ARCHERY']);
const ACTIVE_REDEMPTION_STATUSES = new Set(['reserved', 'redeemed']);
const MUTATION_ROLES = new Set(['OWNER', 'MANAGER', 'ARCHERY_STAFF', 'CASHIER']);
const DEFAULT_RESERVATION_MINUTES = 15;

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function positiveMoney(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, roundMoney(number));
}

function normalizeCode(value) {
  return cleanString(value, 80)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 40);
}

function normalizeStatus(value, fallback = '') {
  return cleanString(value || fallback, 40).toLowerCase();
}

function normalizeSourceType(value) {
  const sourceType = cleanString(value, 80).toUpperCase();
  if (['SHOP', 'ONLINE', 'ONLINE_SHOP'].includes(sourceType)) return 'SHOP_ORDER';
  if (['ARCHERY', 'ARCHERY_HOLD'].includes(sourceType)) return 'ARCHERY_BOOKING';
  if (['POS', 'POS_ORDER'].includes(sourceType)) return 'POS_RECEIPT';
  return sourceType;
}

function channelFromSourceType(sourceType) {
  const normalized = normalizeSourceType(sourceType);
  if (normalized === 'SHOP_ORDER') return 'SHOP';
  if (normalized === 'ARCHERY_BOOKING') return 'ARCHERY';
  if (normalized === 'POS_RECEIPT' || normalized === 'POS_SALE') return 'POS';
  const direct = cleanString(sourceType, 40).toUpperCase();
  return PROMO_CHANNELS.has(direct) ? direct : '';
}

function normalizeChannels(value) {
  const source = Array.isArray(value) ? value : [];
  const channels = source
    .map(item => cleanString(item, 40).toUpperCase())
    .filter(item => PROMO_CHANNELS.has(item));
  return channels.length ? Array.from(new Set(channels)) : ['POS'];
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(item => cleanString(item, 120)).filter(Boolean);
  return cleanString(value, 2000)
    .split(/[\n,]+/)
    .map(item => cleanString(item, 120))
    .filter(Boolean);
}

function normalizeArcheryItem(value) {
  const item = cleanString(value, 80).toUpperCase();
  if (!item) return '';
  if (item.startsWith('ARCHERY_')) return item;
  if (item === 'PACKAGE') return 'ARCHERY_PACKAGE';
  if (item === 'COACH') return 'ARCHERY_COACH';
  if (item === 'EQUIPMENT') return 'ARCHERY_EQUIPMENT';
  return item;
}

function dateMillis(value) {
  const date = timestampToDate(value);
  if (date) return date.getTime();
  const text = cleanString(value, 80);
  if (!text) return 0;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function isStarted(startsAt, nowMs = Date.now()) {
  const millis = dateMillis(startsAt);
  return !millis || millis <= nowMs;
}

function isExpired(expiresAt, nowMs = Date.now()) {
  const millis = dateMillis(expiresAt);
  return Boolean(millis && millis <= nowMs);
}

function normalizePromotion(id, data = {}) {
  const type = normalizeStatus(data.type, 'percent') === 'amount' ? 'amount' : 'percent';
  const value = positiveMoney(data.value);
  return {
    id: cleanString(id || data.id, 120),
    name: cleanString(data.name || data.label, 160),
    type,
    value: type === 'percent' ? Math.min(value, 100) : Math.min(value, 1000000),
    active: data.active !== false && normalizeStatus(data.status, 'active') === 'active',
    status: normalizeStatus(data.status, data.active === false ? 'paused' : 'active'),
    channels: normalizeChannels(data.channels),
    targetType: normalizeStatus(data.targetType || data.target_type, 'all'),
    categoryIds: normalizeList(data.categoryIds || data.category_ids).map(item => item.toLowerCase()),
    productIds: normalizeList(data.productIds || data.product_ids),
    variantIds: normalizeList(data.variantIds || data.variant_ids),
    archeryItems: normalizeList(data.archeryItems || data.archery_items).map(normalizeArcheryItem).filter(Boolean),
    minSubtotal: positiveMoney(data.minSubtotal ?? data.min_subtotal),
    maxDiscount: positiveMoney(data.maxDiscount ?? data.max_discount),
    maxRedemptions: Math.max(0, Math.floor(Number(data.maxRedemptions ?? data.max_redemptions) || 0)),
    maxPerCustomer: Math.max(0, Math.floor(Number(data.maxPerCustomer ?? data.max_per_customer) || 0)),
    startsAt: data.startsAt || data.starts_at || '',
    expiresAt: data.expiresAt || data.expires_at || '',
    stackingPolicy: normalizeStatus(data.stackingPolicy || data.stacking_policy, 'exclusive') === 'stackable' ? 'stackable' : 'exclusive',
    primaryCode: normalizeCode(data.primaryCode || data.code),
    usedCount: Math.max(0, Math.floor(Number(data.usedCount ?? data.used_count) || 0)),
    reservedCount: Math.max(0, Math.floor(Number(data.reservedCount ?? data.reserved_count) || 0)),
  };
}

function normalizePromotionCode(id, data = {}) {
  const code = normalizeCode(data.code || id);
  return {
    id: code,
    code,
    promotionId: cleanString(data.promotionId || data.promotion_id, 120),
    active: data.active !== false && normalizeStatus(data.status, 'active') === 'active',
    status: normalizeStatus(data.status, data.active === false ? 'paused' : 'active'),
    channels: normalizeChannels(data.channels),
    usedCount: Math.max(0, Math.floor(Number(data.usedCount ?? data.used_count) || 0)),
    reservedCount: Math.max(0, Math.floor(Number(data.reservedCount ?? data.reserved_count) || 0)),
    maxRedemptions: Math.max(0, Math.floor(Number(data.maxRedemptions ?? data.max_redemptions) || 0)),
    expiresAt: data.expiresAt || data.expires_at || '',
  };
}

function lineAmount(line = {}) {
  const direct = positiveMoney(
    line.lineTotal
      ?? line.line_total
      ?? line.total
      ?? line.totalAmount
      ?? line.total_amount
      ?? line.total_price
      ?? line.amount,
    0
  );
  if (direct > 0) return direct;
  const unit = positiveMoney(line.unitPrice ?? line.unit_price ?? line.price ?? line.unit_amount, 0);
  const quantity = Math.max(1, Math.floor(Number(line.quantity ?? line.qty ?? 1) || 1));
  return roundMoney(unit * quantity);
}

function normalizeLine(line = {}, index = 0) {
  const productId = cleanString(line.productId || line.product_id || line.id || line.sku, 160);
  const variantId = cleanString(line.variantId || line.variant_id || line.variant || '', 160);
  const categoryId = cleanString(line.categoryId || line.category_id || line.category || line.categoryName || line.category_name, 160);
  const categoryIds = Array.from(new Set([
    ...normalizeList(line.categoryIds || line.category_ids || line.categories),
    categoryId,
  ].map(item => item.toLowerCase()).filter(Boolean)));
  const rawArchery = line.archeryItem || line.archery_item || line.itemType || line.item_type || categoryId;
  const archeryItem = normalizeArcheryItem(rawArchery);
  const amount = lineAmount(line);
  return {
    index,
    productId,
    variantId,
    variantKey: productId && variantId ? `${productId}::${variantId}` : variantId,
    categoryId,
    categoryIds,
    categoryKey: categoryId.toLowerCase(),
    categoryKeys: categoryIds.length ? categoryIds : (categoryId ? [categoryId.toLowerCase()] : []),
    archeryItem,
    amount,
    quantity: Math.max(1, Math.floor(Number(line.quantity ?? line.qty ?? 1) || 1)),
    label: cleanString(line.name || line.label || line.title || productId || archeryItem, 180),
  };
}

function normalizeLines(lines = [], subtotal = 0) {
  const normalized = Array.isArray(lines)
    ? lines.map(normalizeLine).filter(line => line.amount > 0)
    : [];
  if (normalized.length) return normalized;
  const amount = positiveMoney(subtotal);
  return amount > 0
    ? [{ index: 0, productId: '', variantId: '', variantKey: '', categoryId: '', categoryIds: [], categoryKey: '', categoryKeys: [], archeryItem: '', amount, quantity: 1, label: 'Subtotal' }]
    : [];
}

function lineMatchesPromotion(line, promotion) {
  const hasTargets = promotion.categoryIds.length
    || promotion.productIds.length
    || promotion.variantIds.length
    || promotion.archeryItems.length;
  if (!hasTargets || promotion.targetType === 'all') return true;
  if (line.categoryKey && promotion.categoryIds.includes(line.categoryKey)) return true;
  if (Array.isArray(line.categoryKeys) && line.categoryKeys.some(categoryKey => promotion.categoryIds.includes(categoryKey))) return true;
  if (line.productId && promotion.productIds.includes(line.productId)) return true;
  if (line.variantId && promotion.variantIds.includes(line.variantId)) return true;
  if (line.variantKey && promotion.variantIds.includes(line.variantKey)) return true;
  if (line.archeryItem && promotion.archeryItems.includes(line.archeryItem)) return true;
  return false;
}

function allocateDiscount(eligibleLines, discountAmount) {
  const total = roundMoney(eligibleLines.reduce((sum, line) => sum + line.amount, 0));
  if (!eligibleLines.length || total <= 0 || discountAmount <= 0) return [];
  let allocated = 0;
  return eligibleLines.map((line, index) => {
    const isLast = index === eligibleLines.length - 1;
    const amount = isLast
      ? roundMoney(discountAmount - allocated)
      : roundMoney(discountAmount * (line.amount / total));
    allocated = roundMoney(allocated + amount);
    return {
      lineIndex: line.index,
      productId: line.productId,
      variantId: line.variantId,
      categoryId: line.categoryId,
      categoryIds: line.categoryIds || [],
      archeryItem: line.archeryItem,
      eligibleAmount: line.amount,
      discountAmount: amount,
    };
  }).filter(row => row.discountAmount > 0);
}

function calculatePromotionApplication(promotion, options = {}) {
  const lines = normalizeLines(options.items || options.lines || [], options.subtotal);
  const subtotal = positiveMoney(
    options.subtotal,
    lines.reduce((sum, line) => sum + line.amount, 0)
  );
  const eligibleLines = lines.filter(line => lineMatchesPromotion(line, promotion));
  const eligibleSubtotal = roundMoney(eligibleLines.reduce((sum, line) => sum + line.amount, 0));
  if (eligibleSubtotal <= 0) {
    throw apiError('PROMO_NOT_APPLICABLE', 409, 'Promo code does not apply to these items');
  }
  if (promotion.minSubtotal > 0 && eligibleSubtotal < promotion.minSubtotal) {
    throw apiError('PROMO_MIN_SUBTOTAL_NOT_MET', 409, 'Promo minimum subtotal is not met', {
      minSubtotal: promotion.minSubtotal,
      eligibleSubtotal,
    });
  }
  const rawDiscount = promotion.type === 'amount'
    ? promotion.value
    : roundMoney(eligibleSubtotal * (promotion.value / 100));
  const capped = promotion.maxDiscount > 0 ? Math.min(rawDiscount, promotion.maxDiscount) : rawDiscount;
  const discountAmount = roundMoney(Math.min(capped, eligibleSubtotal, subtotal));
  if (discountAmount <= 0) throw apiError('PROMO_DISCOUNT_ZERO', 409, 'Promo discount is zero');
  return {
    subtotal,
    eligibleSubtotal,
    discountAmount,
    totalAfterDiscount: roundMoney(Math.max(0, subtotal - discountAmount)),
    lineAllocations: allocateDiscount(eligibleLines, discountAmount),
  };
}

async function readPromotionByCode(transaction, db, codeValue) {
  const code = normalizeCode(codeValue);
  if (!code) throw apiError('PROMO_CODE_REQUIRED', 400, 'promo_code is required');
  const codeRef = db.collection('promotion_codes').doc(code);
  const codeSnap = transaction ? await transaction.get(codeRef) : await codeRef.get();
  if (!codeSnap.exists) throw apiError('PROMO_CODE_INVALID', 404, 'Promo code is invalid');
  const codeData = normalizePromotionCode(codeSnap.id, codeSnap.data() || {});
  if (!codeData.active) throw apiError('PROMO_CODE_INACTIVE', 409, 'Promo code is not active');
  const promotionRef = db.collection('promotions').doc(codeData.promotionId);
  const promotionSnap = transaction ? await transaction.get(promotionRef) : await promotionRef.get();
  if (!promotionSnap.exists) throw apiError('PROMO_NOT_FOUND', 404, 'Promo campaign was not found');
  const promotion = normalizePromotion(promotionSnap.id, promotionSnap.data() || {});
  if (!promotion.active) throw apiError('PROMO_INACTIVE', 409, 'Promo campaign is not active');
  return { codeRef, codeData, promotionRef, promotion };
}

async function countCustomerRedemptions(transaction, db, promotionId, customerUid) {
  if (!customerUid) return 0;
  const query = db.collection('promotion_redemptions')
    .where('promotionId', '==', promotionId)
    .where('customerUid', '==', customerUid);
  const snap = transaction ? await transaction.get(query) : await query.get();
  let count = 0;
  snap.forEach(docSnap => {
    const row = docSnap.data() || {};
    if (ACTIVE_REDEMPTION_STATUSES.has(normalizeStatus(row.status))) count += 1;
  });
  return count;
}

async function validatePromotionInTransaction(transaction, db, input = {}) {
  const sourceType = normalizeSourceType(input.source_type || input.sourceType || input.channel || '');
  const channel = channelFromSourceType(sourceType || input.channel);
  if (!channel) throw apiError('PROMO_CHANNEL_REQUIRED', 400, 'source_type or channel is required');
  const customerUid = cleanString(input.customer_uid || input.customerUid || input.member_id || input.memberId || '', 180);
  const nowMs = Date.now();
  const { codeData, promotion } = await readPromotionByCode(transaction, db, input.promo_code || input.promoCode || input.code);
  if (!promotion.channels.includes(channel) || !codeData.channels.includes(channel)) {
    throw apiError('PROMO_CHANNEL_NOT_ALLOWED', 409, 'Promo code is not available for this channel');
  }
  if (!isStarted(promotion.startsAt, nowMs)) throw apiError('PROMO_NOT_STARTED', 409, 'Promo campaign has not started');
  if (isExpired(promotion.expiresAt, nowMs) || isExpired(codeData.expiresAt, nowMs)) {
    throw apiError('PROMO_EXPIRED', 409, 'Promo code has expired');
  }
  const maxRedemptions = Math.min(
    ...[promotion.maxRedemptions, codeData.maxRedemptions].filter(value => value > 0)
  );
  const hasMaxRedemptions = Number.isFinite(maxRedemptions) && maxRedemptions > 0;
  const reservedOrUsed = Math.max(promotion.usedCount + promotion.reservedCount, codeData.usedCount + codeData.reservedCount);
  if (hasMaxRedemptions && reservedOrUsed >= maxRedemptions) {
    throw apiError('PROMO_REDEMPTION_LIMIT_REACHED', 409, 'Promo code redemption limit has been reached');
  }
  if (promotion.maxPerCustomer > 0) {
    if (!customerUid) throw apiError('PROMO_CUSTOMER_REQUIRED', 400, 'customer_uid is required for this promo');
    const customerCount = await countCustomerRedemptions(transaction, db, promotion.id, customerUid);
    if (customerCount >= promotion.maxPerCustomer) {
      throw apiError('PROMO_CUSTOMER_LIMIT_REACHED', 409, 'Promo code customer limit has been reached');
    }
  }
  const application = calculatePromotionApplication(promotion, input);
  return {
    valid: true,
    code: codeData.code,
    promotionId: promotion.id,
    promotionName: promotion.name,
    channel,
    sourceType,
    customerUid,
    type: promotion.type,
    value: promotion.value,
    stackingPolicy: promotion.stackingPolicy,
    ...application,
  };
}

async function validatePromotion(db, input = {}) {
  return db.runTransaction(transaction => validatePromotionInTransaction(transaction, db, input));
}

function redemptionDocId(promotionId, code, sourceType, sourceId) {
  return `promo_${sha256(`${promotionId}:${code}:${sourceType}:${sourceId}`).slice(0, 40)}`;
}

function reservationExpiresAt(minutes = DEFAULT_RESERVATION_MINUTES) {
  return Timestamp.fromMillis(Date.now() + (Math.max(1, Number(minutes) || DEFAULT_RESERVATION_MINUTES) * 60 * 1000));
}

function assertSourceId(sourceId) {
  if (!sourceId) throw apiError('PROMO_SOURCE_REQUIRED', 400, 'source_id is required');
}

async function reservePromotionRedemptionInTransaction(transaction, db, input = {}, context = {}) {
  const sourceType = normalizeSourceType(input.source_type || input.sourceType || input.channel || '');
  const sourceId = cleanString(input.source_id || input.sourceId || input.order_id || input.orderId || input.booking_id || input.bookingId || input.receipt_no || input.receiptNo, 180);
  assertSourceId(sourceId);
  const validation = await validatePromotionInTransaction(transaction, db, { ...input, sourceType });
  const redemptionId = redemptionDocId(validation.promotionId, validation.code, sourceType, sourceId);
  const redemptionRef = db.collection('promotion_redemptions').doc(redemptionId);
  const redemptionSnap = await transaction.get(redemptionRef);
  if (redemptionSnap.exists) {
    const existing = redemptionSnap.data() || {};
    const status = normalizeStatus(existing.status);
    if (status === 'reserved' || status === 'redeemed') {
      return {
        redemptionId,
        status,
        code: normalizeCode(existing.code || validation.code),
        promotionId: cleanString(existing.promotionId || validation.promotionId, 120),
        promotionName: cleanString(existing.promotionName || validation.promotionName, 160),
        channel: cleanString(existing.channel || validation.channel, 40),
        discountAmount: positiveMoney(existing.discountAmount ?? existing.discount_amount),
        eligibleSubtotal: positiveMoney(existing.eligibleSubtotal ?? existing.eligible_subtotal),
        lineAllocations: Array.isArray(existing.lineAllocations) ? existing.lineAllocations : [],
        replayed: true,
      };
    }
  }
  const branchId = cleanString(input.branch_id || input.branchId, 80);
  const customerUid = cleanString(validation.customerUid || input.customer_uid || input.customerUid, 180);
  const cashierUid = cleanString(input.cashier_uid || input.cashierUid || context.actor?.uid || '', 180);
  const now = FieldValue.serverTimestamp();
  transaction.set(redemptionRef, {
    id: redemptionId,
    code: validation.code,
    promotionId: validation.promotionId,
    promotionName: validation.promotionName,
    channel: validation.channel,
    sourceType,
    sourceId,
    branchId,
    customerUid,
    cashierUid,
    discountAmount: validation.discountAmount,
    eligibleSubtotal: validation.eligibleSubtotal,
    subtotal: validation.subtotal,
    lineAllocations: validation.lineAllocations,
    status: 'reserved',
    reservationExpiresAt: reservationExpiresAt(input.reservation_minutes || input.reservationMinutes),
    createdAt: now,
    updatedAt: now,
  }, { merge: false });
  transaction.update(db.collection('promotions').doc(validation.promotionId), {
    reservedCount: FieldValue.increment(1),
    updatedAt: now,
  });
  transaction.update(db.collection('promotion_codes').doc(validation.code), {
    reservedCount: FieldValue.increment(1),
    updatedAt: now,
  });
  if (context.audit !== false) {
    writeAuditLog(transaction, db, {
      branchId,
      actor: context.actor || {},
      action: 'reservePromotionRedemption',
      targetCollection: 'promotion_redemptions',
      targetId: redemptionId,
      before: null,
      after: { source_id: sourceId, payment_status: 'PROMO_RESERVED', status: 'reserved' },
      requestId: context.requestId,
    });
  }
  return {
    redemptionId,
    status: 'reserved',
    code: validation.code,
    promotionId: validation.promotionId,
    promotionName: validation.promotionName,
    channel: validation.channel,
    discountAmount: validation.discountAmount,
    eligibleSubtotal: validation.eligibleSubtotal,
    lineAllocations: validation.lineAllocations,
    replayed: false,
  };
}

async function reservePromotionRedemption(db, input = {}, context = {}) {
  return db.runTransaction(transaction => reservePromotionRedemptionInTransaction(transaction, db, input, context));
}

async function commitPromotionRedemptionInTransaction(transaction, db, input = {}, context = {}) {
  const sourceType = normalizeSourceType(input.source_type || input.sourceType || input.channel || '');
  const sourceId = cleanString(input.source_id || input.sourceId || input.order_id || input.orderId || input.booking_id || input.bookingId || input.receipt_no || input.receiptNo, 180);
  const code = normalizeCode(input.promo_code || input.promoCode || input.code);
  const promotionId = cleanString(input.promotion_id || input.promotionId, 120);
  assertSourceId(sourceId);
  if (!code || !promotionId) throw apiError('PROMO_REFERENCE_REQUIRED', 400, 'promo code and promotion_id are required');
  const redemptionId = cleanString(input.redemption_id || input.redemptionId, 120) || redemptionDocId(promotionId, code, sourceType, sourceId);
  const redemptionRef = db.collection('promotion_redemptions').doc(redemptionId);
  const snap = await transaction.get(redemptionRef);
  if (!snap.exists) throw apiError('PROMO_REDEMPTION_NOT_FOUND', 404, 'Promo redemption was not found');
  const redemption = snap.data() || {};
  const status = normalizeStatus(redemption.status);
  if (status === 'redeemed') {
    return { redemptionId, status: 'redeemed', replayed: true };
  }
  if (status !== 'reserved') {
    throw apiError('PROMO_REDEMPTION_NOT_RESERVED', 409, 'Promo redemption is not reserved');
  }
  const now = FieldValue.serverTimestamp();
  transaction.update(redemptionRef, {
    status: 'redeemed',
    committedAt: now,
    paymentId: cleanString(input.payment_id || input.paymentId, 180),
    receiptId: cleanString(input.receipt_id || input.receiptId, 180),
    updatedAt: now,
  });
  transaction.update(db.collection('promotions').doc(promotionId), {
    reservedCount: FieldValue.increment(-1),
    usedCount: FieldValue.increment(1),
    updatedAt: now,
  });
  transaction.update(db.collection('promotion_codes').doc(code), {
    reservedCount: FieldValue.increment(-1),
    usedCount: FieldValue.increment(1),
    updatedAt: now,
  });
  if (context.audit !== false) {
    writeAuditLog(transaction, db, {
      branchId: cleanString(redemption.branchId || input.branch_id || input.branchId, 80),
      actor: context.actor || {},
      action: 'commitPromotionRedemption',
      targetCollection: 'promotion_redemptions',
      targetId: redemptionId,
      before: redemption,
      after: { source_id: sourceId, payment_status: 'PROMO_REDEEMED', status: 'redeemed' },
      requestId: context.requestId,
    });
  }
  return {
    redemptionId,
    status: 'redeemed',
    discountAmount: positiveMoney(redemption.discountAmount),
    replayed: false,
  };
}

async function commitPromotionRedemption(db, input = {}, context = {}) {
  return db.runTransaction(transaction => commitPromotionRedemptionInTransaction(transaction, db, input, context));
}

async function redeemPromotionRedemptionInTransaction(transaction, db, input = {}, context = {}) {
  const sourceType = normalizeSourceType(input.source_type || input.sourceType || input.channel || '');
  const sourceId = cleanString(input.source_id || input.sourceId || input.order_id || input.orderId || input.booking_id || input.bookingId || input.receipt_no || input.receiptNo, 180);
  assertSourceId(sourceId);
  const { codeData, promotion } = await readPromotionByCode(transaction, db, input.promo_code || input.promoCode || input.code);
  const redemptionId = cleanString(input.redemption_id || input.redemptionId, 120)
    || redemptionDocId(promotion.id, codeData.code, sourceType, sourceId);
  const redemptionRef = db.collection('promotion_redemptions').doc(redemptionId);
  const redemptionSnap = await transaction.get(redemptionRef);
  const branchId = cleanString(input.branch_id || input.branchId, 80);
  const now = FieldValue.serverTimestamp();

  if (redemptionSnap.exists) {
    const existing = redemptionSnap.data() || {};
    const status = normalizeStatus(existing.status);
    if (status === 'redeemed') {
      return {
        redemptionId,
        status: 'redeemed',
        code: normalizeCode(existing.code || codeData.code),
        promotionId: cleanString(existing.promotionId || promotion.id, 120),
        promotionName: cleanString(existing.promotionName || promotion.name, 160),
        channel: cleanString(existing.channel || channelFromSourceType(sourceType), 40),
        discountAmount: positiveMoney(existing.discountAmount ?? existing.discount_amount),
        eligibleSubtotal: positiveMoney(existing.eligibleSubtotal ?? existing.eligible_subtotal),
        lineAllocations: Array.isArray(existing.lineAllocations) ? existing.lineAllocations : [],
        replayed: true,
      };
    }
    if (status !== 'reserved') {
      throw apiError('PROMO_REDEMPTION_NOT_RESERVED', 409, 'Promo redemption cannot be redeemed');
    }
    transaction.update(redemptionRef, {
      status: 'redeemed',
      committedAt: now,
      paymentId: cleanString(input.payment_id || input.paymentId, 180),
      receiptId: cleanString(input.receipt_id || input.receiptId || sourceId, 180),
      updatedAt: now,
    });
    transaction.update(db.collection('promotions').doc(cleanString(existing.promotionId || promotion.id, 120)), {
      reservedCount: FieldValue.increment(-1),
      usedCount: FieldValue.increment(1),
      updatedAt: now,
    });
    transaction.update(db.collection('promotion_codes').doc(normalizeCode(existing.code || codeData.code)), {
      reservedCount: FieldValue.increment(-1),
      usedCount: FieldValue.increment(1),
      updatedAt: now,
    });
    if (context.audit !== false) {
      writeAuditLog(transaction, db, {
        branchId: cleanString(existing.branchId || branchId, 80),
        actor: context.actor || {},
        action: 'redeemPromotionRedemption',
        targetCollection: 'promotion_redemptions',
        targetId: redemptionId,
        before: existing,
        after: { source_id: sourceId, payment_status: 'PROMO_REDEEMED', status: 'redeemed' },
        requestId: context.requestId,
      });
    }
    return {
      redemptionId,
      status: 'redeemed',
      code: normalizeCode(existing.code || codeData.code),
      promotionId: cleanString(existing.promotionId || promotion.id, 120),
      promotionName: cleanString(existing.promotionName || promotion.name, 160),
      channel: cleanString(existing.channel || channelFromSourceType(sourceType), 40),
      discountAmount: positiveMoney(existing.discountAmount ?? existing.discount_amount),
      eligibleSubtotal: positiveMoney(existing.eligibleSubtotal ?? existing.eligible_subtotal),
      lineAllocations: Array.isArray(existing.lineAllocations) ? existing.lineAllocations : [],
      replayed: false,
    };
  }

  const validation = await validatePromotionInTransaction(transaction, db, {
    ...input,
    promo_code: codeData.code,
    sourceType,
  });
  const customerUid = cleanString(validation.customerUid || input.customer_uid || input.customerUid, 180);
  const cashierUid = cleanString(input.cashier_uid || input.cashierUid || context.actor?.uid || '', 180);
  transaction.set(redemptionRef, {
    id: redemptionId,
    code: validation.code,
    promotionId: validation.promotionId,
    promotionName: validation.promotionName,
    channel: validation.channel,
    sourceType,
    sourceId,
    branchId,
    customerUid,
    cashierUid,
    discountAmount: validation.discountAmount,
    eligibleSubtotal: validation.eligibleSubtotal,
    subtotal: validation.subtotal,
    lineAllocations: validation.lineAllocations,
    status: 'redeemed',
    committedAt: now,
    paymentId: cleanString(input.payment_id || input.paymentId, 180),
    receiptId: cleanString(input.receipt_id || input.receiptId || sourceId, 180),
    createdAt: now,
    updatedAt: now,
  }, { merge: false });
  transaction.update(db.collection('promotions').doc(validation.promotionId), {
    usedCount: FieldValue.increment(1),
    updatedAt: now,
  });
  transaction.update(db.collection('promotion_codes').doc(validation.code), {
    usedCount: FieldValue.increment(1),
    updatedAt: now,
  });
  if (context.audit !== false) {
    writeAuditLog(transaction, db, {
      branchId,
      actor: context.actor || {},
      action: 'redeemPromotionRedemption',
      targetCollection: 'promotion_redemptions',
      targetId: redemptionId,
      before: null,
      after: { source_id: sourceId, payment_status: 'PROMO_REDEEMED', status: 'redeemed' },
      requestId: context.requestId,
    });
  }
  return {
    redemptionId,
    status: 'redeemed',
    code: validation.code,
    promotionId: validation.promotionId,
    promotionName: validation.promotionName,
    channel: validation.channel,
    discountAmount: validation.discountAmount,
    eligibleSubtotal: validation.eligibleSubtotal,
    lineAllocations: validation.lineAllocations,
    replayed: false,
  };
}

async function redeemPromotionRedemption(db, input = {}, context = {}) {
  return db.runTransaction(transaction => redeemPromotionRedemptionInTransaction(transaction, db, input, context));
}

async function releasePromotionRedemptionInTransaction(transaction, db, input = {}, context = {}) {
  const sourceType = normalizeSourceType(input.source_type || input.sourceType || input.channel || '');
  const sourceId = cleanString(input.source_id || input.sourceId || input.order_id || input.orderId || input.booking_id || input.bookingId || input.receipt_no || input.receiptNo, 180);
  const code = normalizeCode(input.promo_code || input.promoCode || input.code);
  const promotionId = cleanString(input.promotion_id || input.promotionId, 120);
  assertSourceId(sourceId);
  if (!code || !promotionId) throw apiError('PROMO_REFERENCE_REQUIRED', 400, 'promo code and promotion_id are required');
  const redemptionId = cleanString(input.redemption_id || input.redemptionId, 120) || redemptionDocId(promotionId, code, sourceType, sourceId);
  const redemptionRef = db.collection('promotion_redemptions').doc(redemptionId);
  const snap = await transaction.get(redemptionRef);
  if (!snap.exists) return { redemptionId, status: 'missing', replayed: true };
  const redemption = snap.data() || {};
  const status = normalizeStatus(redemption.status);
  if (status === 'released') return { redemptionId, status: 'released', replayed: true };
  if (status !== 'reserved') throw apiError('PROMO_REDEMPTION_NOT_RESERVED', 409, 'Promo redemption cannot be released');
  const now = FieldValue.serverTimestamp();
  transaction.update(redemptionRef, {
    status: 'released',
    releasedAt: now,
    releaseReason: cleanString(input.reason, 300),
    updatedAt: now,
  });
  transaction.update(db.collection('promotions').doc(promotionId), {
    reservedCount: FieldValue.increment(-1),
    updatedAt: now,
  });
  transaction.update(db.collection('promotion_codes').doc(code), {
    reservedCount: FieldValue.increment(-1),
    updatedAt: now,
  });
  if (context.audit !== false) {
    writeAuditLog(transaction, db, {
      branchId: cleanString(redemption.branchId || input.branch_id || input.branchId, 80),
      actor: context.actor || {},
      action: 'releasePromotionRedemption',
      targetCollection: 'promotion_redemptions',
      targetId: redemptionId,
      before: redemption,
      after: { source_id: sourceId, payment_status: 'PROMO_RELEASED', status: 'released' },
      reason: input.reason,
      requestId: context.requestId,
    });
  }
  return { redemptionId, status: 'released', replayed: false };
}

async function releasePromotionRedemption(db, input = {}, context = {}) {
  return db.runTransaction(transaction => releasePromotionRedemptionInTransaction(transaction, db, input, context));
}

function assertMutationActor(actor = {}) {
  const adminUser = actor.admin_user || {};
  const adminRole = cleanString(adminUser.role, 40).toLowerCase();
  const hasDiscountAccess = adminUser.status === 'active'
    && (
      adminRole === 'owner'
      || adminRole === 'head_manager'
      || (adminRole === 'manager' && adminUser.permissions?.discounts === true)
    );
  if (!actor || (!MUTATION_ROLES.has(actor.role) && !hasDiscountAccess)) {
    throw apiError('STAFF_PERMISSION_REQUIRED', 403, 'Staff permission is required');
  }
}

async function readVoucher(transaction, db, codeValue) {
  const code = normalizeCode(codeValue);
  if (!code) throw apiError('VOUCHER_CODE_REQUIRED', 400, 'voucher_code is required');
  const ref = db.collection('gift_vouchers').doc(code);
  const snap = await transaction.get(ref);
  if (!snap.exists) throw apiError('VOUCHER_NOT_FOUND', 404, 'Gift voucher was not found');
  const data = snap.data() || {};
  const status = normalizeStatus(data.status, data.active === false ? 'voided' : 'active');
  return {
    ref,
    voucher: {
      id: cleanString(data.id || ref.id, 120),
      code: normalizeCode(data.code || ref.id),
      initialAmount: positiveMoney(data.initialAmount ?? data.initial_amount),
      balance: positiveMoney(data.balance),
      status,
      active: data.active !== false && status === 'active',
      expiresAt: data.expiresAt || data.expires_at || '',
      raw: data,
    },
  };
}

function assertVoucherRedeemable(voucher) {
  if (!voucher.active) throw apiError('VOUCHER_INACTIVE', 409, 'Gift voucher is not active');
  if (voucher.balance <= 0) throw apiError('VOUCHER_EMPTY', 409, 'Gift voucher has no remaining balance');
  if (isExpired(voucher.expiresAt)) throw apiError('VOUCHER_EXPIRED', 409, 'Gift voucher has expired');
}

function voucherLedgerId(prefix, voucherId, sourceType, sourceId, idempotencyKey) {
  return `${prefix}_${sha256(`${voucherId}:${sourceType}:${sourceId}:${idempotencyKey || ''}`).slice(0, 40)}`;
}

async function validateGiftVoucherInTransaction(transaction, db, input = {}) {
  const { voucher } = await readVoucher(transaction, db, input.voucher_code || input.voucherCode || input.code);
  assertVoucherRedeemable(voucher);
  const requested = positiveMoney(input.amount || input.amount_due || input.amountDue, voucher.balance);
  if (requested <= 0) throw apiError('VOUCHER_AMOUNT_INVALID', 400, 'Voucher amount must be greater than zero');
  if (input.require_full_coverage === true && voucher.balance < requested) {
    throw apiError('VOUCHER_BALANCE_INSUFFICIENT', 409, 'Gift voucher balance is not enough');
  }
  const amount = roundMoney(Math.min(requested, voucher.balance));
  return {
    valid: true,
    voucherId: voucher.id,
    code: voucher.code,
    status: voucher.status,
    balance: voucher.balance,
    amount,
    balanceAfter: roundMoney(voucher.balance - amount),
    expiresAt: voucher.expiresAt || '',
  };
}

async function validateGiftVoucher(db, input = {}) {
  return db.runTransaction(transaction => validateGiftVoucherInTransaction(transaction, db, input));
}

async function redeemGiftVoucherInTransaction(transaction, db, input = {}, context = {}) {
  const sourceType = normalizeSourceType(input.source_type || input.sourceType || '');
  const sourceId = cleanString(input.source_id || input.sourceId || input.order_id || input.orderId || input.booking_id || input.bookingId || input.receipt_no || input.receiptNo, 180);
  assertSourceId(sourceId);
  const idempotencyKey = cleanString(input.idempotency_key || input.idempotencyKey || sourceId, 180);
  const { ref, voucher } = await readVoucher(transaction, db, input.voucher_code || input.voucherCode || input.code);
  const ledgerId = voucherLedgerId('voucher_redeem', voucher.id, sourceType, sourceId, idempotencyKey);
  const ledgerRef = db.collection('gift_voucher_ledger').doc(ledgerId);
  const ledgerSnap = await transaction.get(ledgerRef);
  if (ledgerSnap.exists) {
    const row = ledgerSnap.data() || {};
    return {
      voucherId: voucher.id,
      ledgerId,
      amount: Math.abs(Number(row.amount || 0) || 0),
      balanceAfter: positiveMoney(row.balanceAfter),
      replayed: true,
    };
  }
  assertVoucherRedeemable(voucher);
  const requested = positiveMoney(input.amount || input.amount_due || input.amountDue || voucher.balance);
  if (requested <= 0) throw apiError('VOUCHER_AMOUNT_INVALID', 400, 'Voucher redeem amount must be greater than zero');
  if (input.require_full_coverage === true && voucher.balance < requested) {
    throw apiError('VOUCHER_BALANCE_INSUFFICIENT', 409, 'Gift voucher balance is not enough');
  }
  const amount = roundMoney(Math.min(requested, voucher.balance));
  const balanceAfter = roundMoney(voucher.balance - amount);
  const now = FieldValue.serverTimestamp();
  transaction.update(ref, {
    balance: balanceAfter,
    status: balanceAfter <= 0 ? 'redeemed' : 'active',
    active: balanceAfter > 0,
    updatedAt: now,
    updatedBy: context.actor?.uid || '',
  });
  transaction.set(ledgerRef, {
    id: ledgerId,
    voucherId: voucher.id,
    code: voucher.code,
    type: 'redeem',
    amount: -amount,
    balanceBefore: voucher.balance,
    balanceAfter,
    sourceType,
    sourceId,
    actorUid: context.actor?.uid || cleanString(input.actor_uid || input.actorUid, 180),
    createdAt: now,
  }, { merge: false });
  if (context.audit !== false) {
    writeAuditLog(transaction, db, {
      branchId: cleanString(input.branch_id || input.branchId, 80),
      actor: context.actor || {},
      action: 'redeemGiftVoucher',
      targetCollection: 'gift_vouchers',
      targetId: voucher.id,
      before: voucher.raw,
      after: { source_id: sourceId, status: balanceAfter <= 0 ? 'redeemed' : 'active' },
      requestId: context.requestId,
    });
  }
  return { voucherId: voucher.id, ledgerId, amount, balanceAfter, replayed: false };
}

async function redeemGiftVoucher(db, input = {}, context = {}) {
  return db.runTransaction(transaction => redeemGiftVoucherInTransaction(transaction, db, input, context));
}

async function refundGiftVoucherInTransaction(transaction, db, input = {}, context = {}) {
  const sourceType = normalizeSourceType(input.source_type || input.sourceType || '');
  const sourceId = cleanString(input.source_id || input.sourceId || input.order_id || input.orderId || input.booking_id || input.bookingId || input.receipt_no || input.receiptNo, 180);
  assertSourceId(sourceId);
  const idempotencyKey = cleanString(input.idempotency_key || input.idempotencyKey || sourceId, 180);
  const { ref, voucher } = await readVoucher(transaction, db, input.voucher_code || input.voucherCode || input.code);
  const amount = positiveMoney(input.amount);
  if (amount <= 0) throw apiError('VOUCHER_AMOUNT_INVALID', 400, 'Voucher refund amount must be greater than zero');
  if (voucher.status === 'voided') throw apiError('VOUCHER_VOIDED', 409, 'Voided gift voucher cannot be refunded');
  if (roundMoney(voucher.balance + amount) > voucher.initialAmount) {
    throw apiError('VOUCHER_REFUND_EXCEEDS_INITIAL_AMOUNT', 409, 'Gift voucher refund exceeds initial amount');
  }
  const ledgerId = voucherLedgerId('voucher_refund', voucher.id, sourceType, sourceId, idempotencyKey);
  const ledgerRef = db.collection('gift_voucher_ledger').doc(ledgerId);
  const ledgerSnap = await transaction.get(ledgerRef);
  if (ledgerSnap.exists) {
    const row = ledgerSnap.data() || {};
    return {
      voucherId: voucher.id,
      ledgerId,
      amount: positiveMoney(row.amount),
      balanceAfter: positiveMoney(row.balanceAfter),
      replayed: true,
    };
  }
  const balanceAfter = roundMoney(voucher.balance + amount);
  const now = FieldValue.serverTimestamp();
  transaction.update(ref, {
    balance: balanceAfter,
    status: 'active',
    active: true,
    updatedAt: now,
    updatedBy: context.actor?.uid || '',
  });
  transaction.set(ledgerRef, {
    id: ledgerId,
    voucherId: voucher.id,
    code: voucher.code,
    type: 'refund',
    amount,
    balanceBefore: voucher.balance,
    balanceAfter,
    sourceType,
    sourceId,
    actorUid: context.actor?.uid || cleanString(input.actor_uid || input.actorUid, 180),
    createdAt: now,
  }, { merge: false });
  if (context.audit !== false) {
    writeAuditLog(transaction, db, {
      branchId: cleanString(input.branch_id || input.branchId, 80),
      actor: context.actor || {},
      action: 'refundGiftVoucher',
      targetCollection: 'gift_vouchers',
      targetId: voucher.id,
      before: voucher.raw,
      after: { source_id: sourceId, status: 'active' },
      requestId: context.requestId,
    });
  }
  return { voucherId: voucher.id, ledgerId, amount, balanceAfter, replayed: false };
}

async function refundGiftVoucher(db, input = {}, context = {}) {
  return db.runTransaction(transaction => refundGiftVoucherInTransaction(transaction, db, input, context));
}

module.exports = {
  normalizeCode,
  normalizeSourceType,
  channelFromSourceType,
  normalizePromotion,
  normalizePromotionCode,
  normalizeLine,
  calculatePromotionApplication,
  validatePromotion,
  validatePromotionInTransaction,
  reservePromotionRedemption,
  reservePromotionRedemptionInTransaction,
  commitPromotionRedemption,
  commitPromotionRedemptionInTransaction,
  redeemPromotionRedemption,
  redeemPromotionRedemptionInTransaction,
  releasePromotionRedemption,
  releasePromotionRedemptionInTransaction,
  validateGiftVoucher,
  validateGiftVoucherInTransaction,
  redeemGiftVoucher,
  redeemGiftVoucherInTransaction,
  refundGiftVoucher,
  refundGiftVoucherInTransaction,
  assertMutationActor,
};
