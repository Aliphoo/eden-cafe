const { httpFunction } = require('../security/authz');
const crypto = require('crypto');
const { FieldValue } = require('../shared/firestore');
const { apiError, cleanString } = require('../shared/time');
const { writeAuditLog } = require('../shared/audit');
const engine = require('./engine');

const ADMIN_EMAILS = new Set([
  'admin@edencafe.com',
  'phoo1236@gmail.com',
  'sonsawan.1231@gmail.com',
]);
const PROMO_CHANNELS = new Set(['POS', 'SHOP', 'ARCHERY']);
const PROMO_STATUSES = new Set(['active', 'paused']);
const VOUCHER_STATUSES = new Set(['active', 'redeemed', 'expired', 'voided']);

function actorContext(actor, requestId) {
  return {
    actor,
    requestId,
  };
}

function requireMutationActor(actor) {
  engine.assertMutationActor(actor);
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function positiveMoney(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, roundMoney(number));
}

function normalizeDiscountType(value) {
  return cleanString(value, 20).toLowerCase() === 'amount' ? 'amount' : 'percent';
}

function normalizeStatus(value, allowed, fallback) {
  const normalized = cleanString(value || fallback, 40).toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeChannels(value) {
  const source = Array.isArray(value) ? value : [];
  const channels = source
    .map(item => cleanString(item, 40).toUpperCase())
    .filter(item => PROMO_CHANNELS.has(item));
  return channels.length ? Array.from(new Set(channels)) : ['POS'];
}

function normalizeList(value, maxLength = 120) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map(item => cleanString(item, maxLength)).filter(Boolean)));
  }
  return Array.from(new Set(cleanString(value, 5000)
    .split(/[\n,]+/)
    .map(item => cleanString(item, maxLength))
    .filter(Boolean)));
}

function normalizeArcheryItems(value) {
  return normalizeList(value, 80).map(item => {
    const normalized = item.toUpperCase();
    if (normalized.startsWith('ARCHERY_')) return normalized;
    if (normalized === 'PACKAGE') return 'ARCHERY_PACKAGE';
    if (normalized === 'COACH') return 'ARCHERY_COACH';
    if (normalized === 'EQUIPMENT') return 'ARCHERY_EQUIPMENT';
    return normalized;
  }).filter(Boolean);
}

function cleanDateText(value) {
  return cleanString(value, 80);
}

function hasDiscountAdminAccess(actor = {}) {
  const email = cleanString(actor.email, 180).toLowerCase();
  if (ADMIN_EMAILS.has(email)) return true;
  const adminUser = actor.admin_user || {};
  if (adminUser.status !== 'active') return false;
  const role = cleanString(adminUser.role, 40).toLowerCase();
  if (role === 'owner' || role === 'head_manager') return true;
  return role === 'manager' && adminUser.permissions?.discounts === true;
}

function requireDiscountAdmin(actor) {
  if (!hasDiscountAdminAccess(actor)) {
    throw apiError('STAFF_PERMISSION_REQUIRED', 403, 'Discount admin permission is required');
  }
}

function hash(value, length = 16) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function randomSuffix(length = 8) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').toUpperCase().slice(0, length);
}

function bulkCount(value, max = 100) {
  const count = Math.floor(Number(value) || 0);
  if (count < 1 || count > max) {
    throw apiError('INVALID_BULK_COUNT', 400, `count must be between 1 and ${max}`);
  }
  return count;
}

function auditSummary(action, targetCollection, targetId, actor, requestId, after = {}) {
  return {
    audit_log_id: '',
    branch_id: '',
    actor_id: cleanString(actor?.uid, 160),
    actor_role: cleanString(actor?.role, 60),
    actor_type: 'STAFF',
    staff_session_id: '',
    action: cleanString(action, 120),
    target_collection: cleanString(targetCollection, 80),
    target_id: cleanString(targetId, 180),
    before_snapshot: null,
    after_snapshot: after,
    reason: '',
    request_id: cleanString(requestId, 120),
    created_at: FieldValue.serverTimestamp(),
  };
}

function setBatchAudit(batch, db, options = {}) {
  const ref = db.collection('audit_logs').doc();
  batch.set(ref, {
    ...auditSummary(
      options.action,
      options.targetCollection,
      options.targetId,
      options.actor,
      options.requestId,
      options.after,
    ),
    audit_log_id: ref.id,
  });
}

function buildPromotionPayload(data = {}, existing = {}) {
  const code = engine.normalizeCode(data.code || data.primaryCode);
  const name = cleanString(data.name || data.label, 160);
  const type = normalizeDiscountType(data.type);
  const value = positiveMoney(data.value);
  if (!name) throw apiError('PROMO_NAME_REQUIRED', 400, 'name is required');
  if (!code) throw apiError('PROMO_CODE_REQUIRED', 400, 'code is required');
  if (value <= 0 || (type === 'percent' && value > 100)) {
    throw apiError('PROMO_VALUE_INVALID', 400, 'value is invalid');
  }
  const categoryIds = normalizeList(data.categoryIds || data.category_ids).map(item => item.toLowerCase());
  const productIds = normalizeList(data.productIds || data.product_ids);
  const variantIds = normalizeList(data.variantIds || data.variant_ids);
  const archeryItems = normalizeArcheryItems(data.archeryItems || data.archery_items);
  const hasTargets = categoryIds.length || productIds.length || variantIds.length || archeryItems.length;
  const status = normalizeStatus(data.status, PROMO_STATUSES, 'active');
  const maxRedemptions = Math.max(0, Math.floor(Number(data.maxRedemptions ?? data.max_redemptions) || 0));
  const promotionId = cleanString(data.id || data.promotionId || `promo-${code.toLowerCase()}`, 120);
  return {
    promotionId,
    code,
    previousCode: engine.normalizeCode(data.previousCode || data.previous_code || data.previousCodeId),
    promotion: {
      id: promotionId,
      name,
      type,
      value: type === 'percent' ? Math.min(value, 100) : Math.min(value, 1000000),
      active: status === 'active',
      status,
      channels: normalizeChannels(data.channels),
      targetType: hasTargets ? 'limited' : 'all',
      categoryIds,
      productIds,
      variantIds,
      archeryItems,
      minSubtotal: positiveMoney(data.minSubtotal ?? data.min_subtotal),
      maxDiscount: positiveMoney(data.maxDiscount ?? data.max_discount),
      maxRedemptions,
      maxPerCustomer: Math.max(0, Math.floor(Number(data.maxPerCustomer ?? data.max_per_customer) || 0)),
      startsAt: cleanDateText(data.startsAt || data.starts_at),
      expiresAt: cleanDateText(data.expiresAt || data.expires_at),
      stackingPolicy: cleanString(data.stackingPolicy || data.stacking_policy, 40).toLowerCase() === 'stackable'
        ? 'stackable'
        : 'exclusive',
      primaryCode: code,
      usedCount: Math.max(0, Math.floor(Number(existing.usedCount ?? existing.used_count) || 0)),
      reservedCount: Math.max(0, Math.floor(Number(existing.reservedCount ?? existing.reserved_count) || 0)),
    },
    codeDoc: {
      id: code,
      code,
      promotionId,
      active: status === 'active',
      status,
      channels: normalizeChannels(data.channels),
      maxRedemptions,
      expiresAt: cleanDateText(data.expiresAt || data.expires_at),
    },
  };
}

function buildVoucherPayload(data = {}) {
  const code = engine.normalizeCode(data.code || data.voucherCode || data.voucher_code);
  const existingId = cleanString(data.id || data.voucherId || data.voucher_id, 120);
  if (!code) throw apiError('VOUCHER_CODE_REQUIRED', 400, 'code is required');
  if (existingId && existingId !== code) {
    throw apiError('VOUCHER_CODE_CHANGE_UNSUPPORTED', 409, 'Gift voucher code cannot be changed after issue');
  }
  const initialAmount = positiveMoney(data.initialAmount ?? data.initial_amount);
  const balance = positiveMoney(data.balance);
  if (initialAmount <= 0) throw apiError('VOUCHER_AMOUNT_INVALID', 400, 'initialAmount must be greater than zero');
  if (balance > initialAmount) throw apiError('VOUCHER_BALANCE_INVALID', 400, 'balance cannot exceed initialAmount');
  const status = normalizeStatus(data.status, VOUCHER_STATUSES, 'active');
  return {
    voucherId: code,
    voucher: {
      id: code,
      code,
      initialAmount,
      balance,
      currency: 'THB',
      status,
      active: status === 'active',
      expiresAt: cleanDateText(data.expiresAt || data.expires_at),
      issuedTo: cleanString(data.issuedTo || data.issued_to, 160),
      note: cleanString(data.note, 400),
    },
  };
}

async function uniqueCodes(db, collectionName, prefix, count) {
  const normalizedPrefix = engine.normalizeCode(prefix) || 'PROMO';
  const codes = [];
  const seen = new Set();
  let attempts = 0;
  while (codes.length < count && attempts < count * 20) {
    attempts += 1;
    const code = engine.normalizeCode(`${normalizedPrefix}-${randomSuffix(8)}`);
    if (!code || seen.has(code)) continue;
    const snap = await db.collection(collectionName).doc(code).get();
    if (snap.exists) continue;
    seen.add(code);
    codes.push(code);
  }
  if (codes.length !== count) {
    throw apiError('UNABLE_TO_GENERATE_UNIQUE_CODES', 409, 'Unable to generate unique codes');
  }
  return codes;
}

const adminUpsertPromotion = httpFunction(async ({ db, data, actor, requestId }) => {
  requireDiscountAdmin(actor);
  const base = buildPromotionPayload(data || {});
  const result = await db.runTransaction(async transaction => {
    const promoRef = db.collection('promotions').doc(base.promotionId);
    const promoSnap = await transaction.get(promoRef);
    const existingPromo = promoSnap.exists ? promoSnap.data() || {} : {};
    const payload = buildPromotionPayload(data || {}, existingPromo);
    const codeRef = db.collection('promotion_codes').doc(payload.code);
    const codeSnap = await transaction.get(codeRef);
    const existingCode = codeSnap.exists ? codeSnap.data() || {} : {};
    if (codeSnap.exists && cleanString(existingCode.promotionId, 120) !== payload.promotionId) {
      throw apiError('PROMO_CODE_CONFLICT', 409, 'Promo code is already assigned to another promotion');
    }
    const now = FieldValue.serverTimestamp();
    transaction.set(promoRef, {
      ...payload.promotion,
      updatedAt: now,
      updatedBy: actor.uid || '',
      ...(promoSnap.exists ? {} : { createdAt: now, createdBy: actor.uid || '' }),
    }, { merge: promoSnap.exists });
    if (payload.previousCode && payload.previousCode !== payload.code) {
      transaction.set(db.collection('promotion_codes').doc(payload.previousCode), {
        active: false,
        status: 'replaced',
        replacedBy: payload.code,
        updatedAt: now,
        updatedBy: actor.uid || '',
      }, { merge: true });
    }
    transaction.set(codeRef, {
      ...payload.codeDoc,
      usedCount: Math.max(0, Math.floor(Number(existingCode.usedCount ?? existingCode.used_count) || 0)),
      reservedCount: Math.max(0, Math.floor(Number(existingCode.reservedCount ?? existingCode.reserved_count) || 0)),
      updatedAt: now,
      updatedBy: actor.uid || '',
      ...(codeSnap.exists ? {} : { createdAt: now, createdBy: actor.uid || '' }),
    }, { merge: codeSnap.exists });
    writeAuditLog(transaction, db, {
      actor,
      action: promoSnap.exists ? 'adminUpdatePromotion' : 'adminCreatePromotion',
      targetCollection: 'promotions',
      targetId: payload.promotionId,
      before: existingPromo,
      after: payload.promotion,
      requestId,
    });
    return { promotionId: payload.promotionId, code: payload.code };
  });
  return { promotion: result };
}, {
  name: 'adminUpsertPromotion',
  methods: ['POST'],
});

const adminDeletePromotion = httpFunction(async ({ db, data, actor, requestId }) => {
  requireDiscountAdmin(actor);
  const promotionId = cleanString(data?.id || data?.promotionId, 120);
  if (!promotionId) throw apiError('PROMOTION_ID_REQUIRED', 400, 'promotionId is required');
  const promoRef = db.collection('promotions').doc(promotionId);
  const [promoSnap, codesSnap] = await Promise.all([
    promoRef.get(),
    db.collection('promotion_codes').where('promotionId', '==', promotionId).get(),
  ]);
  const batch = db.batch();
  batch.delete(promoRef);
  codesSnap.forEach(docSnap => batch.delete(docSnap.ref));
  setBatchAudit(batch, db, {
    actor,
    requestId,
    action: 'adminDeletePromotion',
    targetCollection: 'promotions',
    targetId: promotionId,
    after: { deleted: true, code_count: codesSnap.size },
  });
  await batch.commit();
  return { promotion: { id: promotionId, deleted: true, existed: promoSnap.exists, codeCount: codesSnap.size } };
}, {
  name: 'adminDeletePromotion',
  methods: ['POST'],
});

const adminBulkGeneratePromotionCodes = httpFunction(async ({ db, data, actor, requestId }) => {
  requireDiscountAdmin(actor);
  const promotionId = cleanString(data?.promotionId || data?.id, 120);
  if (!promotionId) throw apiError('PROMOTION_ID_REQUIRED', 400, 'promotionId is required');
  const count = bulkCount(data?.count, 100);
  const promoSnap = await db.collection('promotions').doc(promotionId).get();
  if (!promoSnap.exists) throw apiError('PROMOTION_NOT_FOUND', 404, 'Promotion was not found');
  const promo = engine.normalizePromotion(promotionId, promoSnap.data() || {});
  const codes = await uniqueCodes(db, 'promotion_codes', data?.prefix || promo.primaryCode || promotionId, count);
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  codes.forEach(code => {
    batch.set(db.collection('promotion_codes').doc(code), {
      id: code,
      code,
      promotionId,
      active: promo.active,
      status: promo.status,
      channels: promo.channels,
      usedCount: 0,
      reservedCount: 0,
      maxRedemptions: promo.maxRedemptions,
      expiresAt: promo.expiresAt || '',
      createdAt: now,
      updatedAt: now,
      createdBy: actor.uid || '',
      updatedBy: actor.uid || '',
    }, { merge: false });
  });
  setBatchAudit(batch, db, {
    actor,
    requestId,
    action: 'adminBulkGeneratePromotionCodes',
    targetCollection: 'promotion_codes',
    targetId: promotionId,
    after: { count, promotion_id: promotionId, sample_codes: codes.slice(0, 10) },
  });
  await batch.commit();
  return { codes, count };
}, {
  name: 'adminBulkGeneratePromotionCodes',
  methods: ['POST'],
});

const adminUpsertGiftVoucher = httpFunction(async ({ db, data, actor, requestId }) => {
  requireDiscountAdmin(actor);
  const parsed = buildVoucherPayload(data || {});
  const result = await db.runTransaction(async transaction => {
    const ref = db.collection('gift_vouchers').doc(parsed.voucherId);
    const snap = await transaction.get(ref);
    const previous = snap.exists ? snap.data() || {} : {};
    const balanceBefore = positiveMoney(previous.balance);
    const delta = roundMoney(parsed.voucher.balance - balanceBefore);
    const now = FieldValue.serverTimestamp();
    transaction.set(ref, {
      ...parsed.voucher,
      updatedAt: now,
      updatedBy: actor.uid || '',
      ...(snap.exists ? {} : { createdAt: now, createdBy: actor.uid || '' }),
    }, { merge: snap.exists });
    let ledgerId = '';
    if (!snap.exists || Math.abs(delta) > 0.001) {
      const type = snap.exists ? 'adjust' : 'issue';
      ledgerId = `voucher_${type}_${parsed.voucherId}_${hash(requestId || `${Date.now()}`, 12)}`;
      transaction.set(db.collection('gift_voucher_ledger').doc(ledgerId), {
        id: ledgerId,
        voucherId: parsed.voucherId,
        code: parsed.voucher.code,
        type,
        amount: delta,
        balanceBefore,
        balanceAfter: parsed.voucher.balance,
        sourceType: 'ADMIN',
        sourceId: parsed.voucherId,
        actorUid: actor.uid || '',
        createdAt: now,
      }, { merge: true });
    }
    writeAuditLog(transaction, db, {
      actor,
      action: snap.exists ? 'adminUpdateGiftVoucher' : 'adminIssueGiftVoucher',
      targetCollection: 'gift_vouchers',
      targetId: parsed.voucherId,
      before: previous,
      after: parsed.voucher,
      requestId,
    });
    return { voucherId: parsed.voucherId, ledgerId };
  });
  return { voucher: result };
}, {
  name: 'adminUpsertGiftVoucher',
  methods: ['POST'],
});

const adminVoidGiftVoucher = httpFunction(async ({ db, data, actor, requestId }) => {
  requireDiscountAdmin(actor);
  const voucherId = engine.normalizeCode(data?.id || data?.voucherId || data?.code);
  if (!voucherId) throw apiError('VOUCHER_CODE_REQUIRED', 400, 'voucherId is required');
  const result = await db.runTransaction(async transaction => {
    const ref = db.collection('gift_vouchers').doc(voucherId);
    const snap = await transaction.get(ref);
    if (!snap.exists) throw apiError('VOUCHER_NOT_FOUND', 404, 'Gift voucher was not found');
    const voucher = snap.data() || {};
    const balanceBefore = positiveMoney(voucher.balance);
    const now = FieldValue.serverTimestamp();
    transaction.set(ref, {
      status: 'voided',
      active: false,
      balance: 0,
      updatedAt: now,
      updatedBy: actor.uid || '',
    }, { merge: true });
    const ledgerId = `voucher_void_${voucherId}_${hash(requestId || `${Date.now()}`, 12)}`;
    transaction.set(db.collection('gift_voucher_ledger').doc(ledgerId), {
      id: ledgerId,
      voucherId,
      code: engine.normalizeCode(voucher.code || voucherId),
      type: 'void',
      amount: -balanceBefore,
      balanceBefore,
      balanceAfter: 0,
      sourceType: 'ADMIN',
      sourceId: voucherId,
      actorUid: actor.uid || '',
      createdAt: now,
    }, { merge: true });
    writeAuditLog(transaction, db, {
      actor,
      action: 'adminVoidGiftVoucher',
      targetCollection: 'gift_vouchers',
      targetId: voucherId,
      before: voucher,
      after: { id: voucherId, code: voucher.code || voucherId, status: 'voided', balance: 0 },
      requestId,
    });
    return { voucherId, ledgerId };
  });
  return { voucher: result };
}, {
  name: 'adminVoidGiftVoucher',
  methods: ['POST'],
});

const adminBulkGenerateGiftVouchers = httpFunction(async ({ db, data, actor, requestId }) => {
  requireDiscountAdmin(actor);
  const count = bulkCount(data?.count, 100);
  const amount = positiveMoney(data?.initialAmount ?? data?.amount);
  if (amount <= 0) throw apiError('VOUCHER_AMOUNT_INVALID', 400, 'initialAmount must be greater than zero');
  const codes = await uniqueCodes(db, 'gift_vouchers', data?.prefix || `GV${Math.floor(amount)}`, count);
  const expiresAt = cleanDateText(data?.expiresAt || data?.expires_at);
  const note = cleanString(data?.note, 400);
  const issuedTo = cleanString(data?.issuedTo || data?.issued_to, 160);
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  codes.forEach(code => {
    batch.set(db.collection('gift_vouchers').doc(code), {
      id: code,
      code,
      initialAmount: amount,
      balance: amount,
      currency: 'THB',
      status: 'active',
      active: true,
      expiresAt,
      issuedTo,
      note,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.uid || '',
      updatedBy: actor.uid || '',
    }, { merge: false });
    const ledgerId = `voucher_issue_${code}_${hash(requestId || code, 12)}`;
    batch.set(db.collection('gift_voucher_ledger').doc(ledgerId), {
      id: ledgerId,
      voucherId: code,
      code,
      type: 'issue',
      amount,
      balanceBefore: 0,
      balanceAfter: amount,
      sourceType: 'ADMIN_BULK',
      sourceId: code,
      actorUid: actor.uid || '',
      createdAt: now,
    }, { merge: false });
  });
  setBatchAudit(batch, db, {
    actor,
    requestId,
    action: 'adminBulkGenerateGiftVouchers',
    targetCollection: 'gift_vouchers',
    targetId: engine.normalizeCode(data?.prefix || `GV${Math.floor(amount)}`),
    after: { count, amount, sample_codes: codes.slice(0, 10), expires_at: expiresAt },
  });
  await batch.commit();
  return { vouchers: codes, count };
}, {
  name: 'adminBulkGenerateGiftVouchers',
  methods: ['POST'],
});

const validatePromotion = httpFunction(async ({ db, data }) => {
  const result = await engine.validatePromotion(db, data || {});
  return { promotion: result };
}, {
  name: 'validatePromotion',
  methods: ['POST'],
});

const reservePromotionRedemption = httpFunction(async ({ db, data, actor, requestId }) => {
  requireMutationActor(actor);
  const result = await engine.reservePromotionRedemption(db, data || {}, actorContext(actor, requestId));
  return { redemption: result };
}, {
  name: 'reservePromotionRedemption',
  methods: ['POST'],
});

const commitPromotionRedemption = httpFunction(async ({ db, data, actor, requestId }) => {
  requireMutationActor(actor);
  const result = await engine.commitPromotionRedemption(db, data || {}, actorContext(actor, requestId));
  return { redemption: result };
}, {
  name: 'commitPromotionRedemption',
  methods: ['POST'],
});

const redeemPromotionRedemption = httpFunction(async ({ db, data, actor, requestId }) => {
  requireMutationActor(actor);
  const result = await engine.redeemPromotionRedemption(db, data || {}, actorContext(actor, requestId));
  return { redemption: result };
}, {
  name: 'redeemPromotionRedemption',
  methods: ['POST'],
});

const releasePromotionRedemption = httpFunction(async ({ db, data, actor, requestId }) => {
  requireMutationActor(actor);
  const result = await engine.releasePromotionRedemption(db, data || {}, actorContext(actor, requestId));
  return { redemption: result };
}, {
  name: 'releasePromotionRedemption',
  methods: ['POST'],
});

const validateGiftVoucher = httpFunction(async ({ db, data }) => {
  const result = await engine.validateGiftVoucher(db, data || {});
  return { voucher: result };
}, {
  name: 'validateGiftVoucher',
  methods: ['POST'],
});

const redeemGiftVoucher = httpFunction(async ({ db, data, actor, requestId }) => {
  requireMutationActor(actor);
  const result = await engine.redeemGiftVoucher(db, data || {}, actorContext(actor, requestId));
  return { voucher: result };
}, {
  name: 'redeemGiftVoucher',
  methods: ['POST'],
});

const refundGiftVoucher = httpFunction(async ({ db, data, actor, requestId }) => {
  requireMutationActor(actor);
  const result = await engine.refundGiftVoucher(db, {
    ...(data || {}),
    reason: cleanString(data?.reason, 300),
  }, actorContext(actor, requestId));
  return { voucher: result };
}, {
  name: 'refundGiftVoucher',
  methods: ['POST'],
});

module.exports = {
  adminUpsertPromotion,
  adminDeletePromotion,
  adminBulkGeneratePromotionCodes,
  adminUpsertGiftVoucher,
  adminVoidGiftVoucher,
  adminBulkGenerateGiftVouchers,
  validatePromotion,
  reservePromotionRedemption,
  commitPromotionRedemption,
  redeemPromotionRedemption,
  releasePromotionRedemption,
  validateGiftVoucher,
  redeemGiftVoucher,
  refundGiftVoucher,
  engine,
};
