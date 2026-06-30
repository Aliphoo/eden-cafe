const { FieldValue, Timestamp } = require('./shared/firestore');
const { apiError, cleanString, timestampToDate } = require('./shared/time');
const { sha256 } = require('./shared/idempotency');
const loyaltyFormula = require('./loyaltyFormula');

const DEFAULT_RESERVATION_MINUTES = 15;
const RESERVATION_STATUSES = new Set(['reserved', 'redeemed', 'released', 'expired']);

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function positiveMoney(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, roundMoney(number));
}

function integerPoints(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function normalizeSourceType(value) {
  const sourceType = cleanString(value, 80).toUpperCase();
  if (['SHOP', 'ONLINE', 'ONLINE_SHOP'].includes(sourceType)) return 'SHOP_ORDER';
  if (['ARCHERY', 'ARCHERY_HOLD'].includes(sourceType)) return 'ARCHERY_BOOKING';
  if (['POS', 'POS_ORDER', 'POS_SALE'].includes(sourceType)) return 'POS_RECEIPT';
  return sourceType;
}

function channelFromSourceType(value) {
  const sourceType = normalizeSourceType(value);
  if (sourceType === 'SHOP_ORDER') return 'SHOP';
  if (sourceType === 'ARCHERY_BOOKING') return 'ARCHERY';
  if (sourceType === 'POS_RECEIPT') return 'POS';
  return cleanString(value, 40).toUpperCase();
}

function normalizeStatus(value, fallback = '') {
  const status = cleanString(value || fallback, 40).toLowerCase();
  return RESERVATION_STATUSES.has(status) ? status : '';
}

function sourceIdFromInput(input = {}) {
  return cleanString(
    input.source_id
      || input.sourceId
      || input.order_id
      || input.orderId
      || input.booking_id
      || input.bookingId
      || input.receipt_no
      || input.receiptNo,
    180
  );
}

function memberIdFromInput(input = {}) {
  return cleanString(
    input.member_id
      || input.memberId
      || input.customer_uid
      || input.customerUid
      || input.userId
      || input.uid,
    180
  );
}

function assertSourceId(sourceId) {
  if (!sourceId) throw apiError('LOYALTY_SOURCE_REQUIRED', 400, 'source_id is required');
}

function assertMemberId(memberId) {
  if (!memberId) throw apiError('LOYALTY_MEMBER_REQUIRED', 400, 'member_id is required');
}

function reservationDocId(memberId, sourceType, sourceId, idempotencyKey) {
  return `loyalty_${sha256(`${memberId}:${sourceType}:${sourceId}:${idempotencyKey}`).slice(0, 40)}`;
}

function reservationExpiresAt(minutes = DEFAULT_RESERVATION_MINUTES) {
  return Timestamp.fromMillis(Date.now() + (Math.max(1, Number(minutes) || DEFAULT_RESERVATION_MINUTES) * 60 * 1000));
}

function reservationExpired(row = {}, nowMs = Date.now()) {
  const date = timestampToDate(row.reservationExpiresAt || row.expiresAt);
  return Boolean(date && date.getTime() <= nowMs);
}

function memberName(member = {}, summary = {}) {
  return cleanString(
    member.displayName
      || member.display_name
      || member.name
      || member.customerName
      || summary.memberName
      || summary.displayName
      || summary.name
      || 'Eden Member',
    160
  );
}

function memberEmail(member = {}, summary = {}) {
  return cleanString(member.email || summary.memberEmail || summary.email || '', 180).toLowerCase();
}

function memberCode(member = {}, summary = {}) {
  return cleanString(member.memberCode || summary.memberCode || '', 80);
}

function summaryPointsBalance(member = {}, summary = {}) {
  if (summary.pointsBalance !== undefined) return integerPoints(summary.pointsBalance);
  return integerPoints(member.points);
}

function summaryReservedPoints(summary = {}) {
  return integerPoints(summary.reservedPoints);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFiniteNumber(values, fallback = 0) {
  for (const value of values) {
    const number = finiteNumberOrNull(value);
    if (number !== null) return number;
  }
  return fallback;
}

function normalizeQuoteInput(input = {}) {
  const sourceType = normalizeSourceType(input.source_type || input.sourceType || input.channel || '');
  const sourceId = sourceIdFromInput(input);
  const memberId = memberIdFromInput(input);
  const items = loyaltyFormula.normalizePosSaleItems(input.items || input.lines || []);
  const subtotal = positiveMoney(firstFiniteNumber([
    input.subtotal,
    input.subTotal,
    input.total_before_discount,
    input.totalBeforeDiscount,
    loyaltyFormula.sumPosItemsSubtotal(items),
  ], 0));
  const orderDiscount = positiveMoney(firstFiniteNumber([
    input.order_discount,
    input.orderDiscount,
    input.normalDiscount,
    input.discount,
    input.discount_total,
    input.discountTotal,
  ], 0));
  const totalBeforeLoyalty = positiveMoney(firstFiniteNumber([
    input.total_before_loyalty,
    input.totalBeforeLoyalty,
    input.amount_before_loyalty,
    input.amountBeforeLoyalty,
    input.amount_total,
    input.amountTotal,
    input.totalAmount,
    input.total,
    Math.max(0, subtotal - orderDiscount),
  ], Math.max(0, subtotal - orderDiscount)));
  const redeemableAmount = positiveMoney(firstFiniteNumber([
    input.redeemable_amount,
    input.redeemableAmount,
    input.eligible_amount,
    input.eligibleAmount,
    totalBeforeLoyalty,
  ], totalBeforeLoyalty));
  return {
    sourceType,
    sourceId,
    memberId,
    branchId: cleanString(input.branch_id || input.branchId, 80),
    idempotencyKey: cleanString(input.idempotency_key || input.idempotencyKey || sourceId, 180),
    requestedRedeemedPoints: integerPoints(input.redeemed_points || input.redeemedPoints || input.points || input.requestedRedeemedPoints),
    items,
    subtotal,
    orderDiscount,
    totalBeforeLoyalty,
    redeemableAmount: Math.min(redeemableAmount, totalBeforeLoyalty),
    reservationMinutes: Math.max(1, Number(input.reservation_minutes || input.reservationMinutes) || DEFAULT_RESERVATION_MINUTES),
    earnEligible: input.earn_eligible === false || input.earnEligible === false ? false : true,
  };
}

function quoteFromState({ input, config, member, summary }) {
  const loyaltyConfig = loyaltyFormula.normalizeLoyaltySettings(config || {});
  const pointsBalance = summaryPointsBalance(member, summary);
  const reservedPoints = summaryReservedPoints(summary);
  const availablePoints = Math.max(0, pointsBalance - reservedPoints);
  const requestedRedeemedPoints = integerPoints(input.requestedRedeemedPoints);

  let blockedReason = '';
  if (!loyaltyConfig.enabled) {
    blockedReason = 'loyalty-disabled';
  } else if (!input.memberId) {
    blockedReason = 'missing-member';
  } else if (requestedRedeemedPoints > availablePoints) {
    blockedReason = 'insufficient-points';
  } else if (
    requestedRedeemedPoints > 0
    && loyaltyConfig.minRedeemPoints > 0
    && requestedRedeemedPoints < loyaltyConfig.minRedeemPoints
  ) {
    blockedReason = 'below-min-redeem-points';
  }

  const maxDiscountByPercent = roundMoney((input.redeemableAmount * loyaltyConfig.maxRedeemPercent) / 100);
  const maxPointsByPercent = loyaltyConfig.pointValue > 0
    ? Math.floor(maxDiscountByPercent / loyaltyConfig.pointValue)
    : 0;
  const maxPointsByTotal = loyaltyConfig.pointValue > 0
    ? Math.floor(input.totalBeforeLoyalty / loyaltyConfig.pointValue)
    : 0;
  const maxRedeemablePoints = Math.max(0, Math.min(availablePoints, maxPointsByPercent, maxPointsByTotal));
  if (!blockedReason && requestedRedeemedPoints > maxRedeemablePoints) {
    blockedReason = 'exceeds-max-redeem-percent';
  }

  const redeemedPoints = !blockedReason ? Math.min(requestedRedeemedPoints, maxRedeemablePoints) : 0;
  const loyaltyDiscount = roundMoney(Math.min(input.totalBeforeLoyalty, redeemedPoints * loyaltyConfig.pointValue));
  const payableAmount = roundMoney(Math.max(0, input.totalBeforeLoyalty - loyaltyDiscount));

  const eligibleSubtotal = loyaltyFormula.eligibleSubtotalForPosSale(input.items, loyaltyConfig.excludedCategories);
  const subtotalAfterLineDiscount = input.items.reduce(
    (sum, item) => sum + Math.max(0, item.unitPrice * item.quantity - item.lineDiscount),
    0
  );
  const allocationBase = subtotalAfterLineDiscount > 0 ? subtotalAfterLineDiscount : input.subtotal;
  const eligibleRatio = allocationBase > 0 ? Math.min(1, eligibleSubtotal / allocationBase) : 0;
  const orderDiscountShare = loyaltyConfig.earnAfterDiscount
    ? input.orderDiscount * eligibleRatio
    : 0;
  const redeemedDiscountShare = loyaltyConfig.earnOnRedeemedAmount
    ? 0
    : loyaltyDiscount * eligibleRatio;
  const earnBase = input.earnEligible
    ? Math.max(0, eligibleSubtotal - orderDiscountShare - redeemedDiscountShare)
    : 0;
  const memberTotalSpent = Math.max(0, Number(member.totalSpent || summary.totalSpent || 0));
  const currentTier = loyaltyFormula.memberTierFromMetrics(pointsBalance, memberTotalSpent, loyaltyConfig.membershipTiers);
  const multiplier = Number(loyaltyConfig.tierMultipliers[currentTier] || 1);
  const earnedPoints = input.earnEligible && loyaltyConfig.spendPerPoint > 0
    ? Math.floor((earnBase / loyaltyConfig.spendPerPoint) * multiplier)
    : 0;

  return {
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    channel: channelFromSourceType(input.sourceType),
    memberId: input.memberId,
    pointsBalance,
    reservedPoints,
    availablePoints,
    requestedRedeemedPoints,
    maxRedeemablePoints,
    redeemedPoints,
    loyaltyDiscount,
    payableAmount,
    eligibleAmount: roundMoney(eligibleSubtotal),
    earnBase: roundMoney(earnBase),
    earnedPoints,
    currentTier,
    blockedReason,
    config: {
      pointValue: loyaltyConfig.pointValue,
      maxRedeemPercent: loyaltyConfig.maxRedeemPercent,
      minRedeemPoints: loyaltyConfig.minRedeemPoints,
      spendPerPoint: loyaltyConfig.spendPerPoint,
    },
  };
}

async function readLoyaltyState(transaction, db, memberId) {
  assertMemberId(memberId);
  const userRef = db.collection('users').doc(memberId);
  const summaryRef = db.collection('member_summaries').doc(memberId);
  const loyaltyRef = db.collection('site_settings').doc('loyalty');
  const [userSnap, summarySnap, loyaltySnap] = await Promise.all([
    transaction.get(userRef),
    transaction.get(summaryRef),
    transaction.get(loyaltyRef),
  ]);
  if (!userSnap.exists && !summarySnap.exists) {
    throw apiError('LOYALTY_MEMBER_NOT_FOUND', 404, 'Member profile was not found');
  }
  return {
    userRef,
    summaryRef,
    loyaltyRef,
    member: userSnap.exists ? userSnap.data() || {} : {},
    summary: summarySnap.exists ? summarySnap.data() || {} : {},
    config: loyaltySnap.exists ? loyaltySnap.data() || {} : {},
  };
}

async function releaseExpiredReservationsInTransaction(transaction, db, memberId, summaryRef, summary = {}, nowMs = Date.now(), options = {}) {
  const query = db.collection('loyalty_reservations')
    .where('memberId', '==', memberId)
    .where('status', '==', 'reserved')
    .limit(50);
  const snap = await transaction.get(query);
  if (!snap || snap.empty) return { releasedPoints: 0, releasedCount: 0 };
  let releasedPoints = 0;
  let releasedCount = 0;
  const now = FieldValue.serverTimestamp();
  snap.docs.forEach(docSnap => {
    const row = docSnap.data() || {};
    if (!reservationExpired(row, nowMs)) return;
    const points = integerPoints(row.redeemedPoints);
    if (!points) return;
    releasedPoints += points;
    releasedCount += 1;
    transaction.update(docSnap.ref, {
      status: 'expired',
      releasedAt: now,
      releaseReason: 'reservation-expired',
      updatedAt: now,
    });
  });
  if (releasedPoints > 0 && options.updateSummary !== false) {
    const currentReserved = summaryReservedPoints(summary);
    transaction.set(summaryRef, {
      reservedPoints: Math.max(0, currentReserved - releasedPoints),
      updatedAt: now,
    }, { merge: true });
  }
  return { releasedPoints, releasedCount };
}

async function quoteLoyaltyRedemptionInTransaction(transaction, db, input = {}) {
  const normalized = normalizeQuoteInput(input);
  const state = await readLoyaltyState(transaction, db, normalized.memberId);
  const quote = quoteFromState({
    input: normalized,
    config: state.config,
    member: state.member,
    summary: state.summary,
  });
  return {
    ...quote,
    memberName: memberName(state.member, state.summary),
    memberCode: memberCode(state.member, state.summary),
  };
}

async function quoteLoyaltyRedemption(db, input = {}) {
  return db.runTransaction(transaction => quoteLoyaltyRedemptionInTransaction(transaction, db, input));
}

async function reserveLoyaltyRedemptionInTransaction(transaction, db, input = {}, context = {}) {
  const normalized = normalizeQuoteInput(input);
  assertSourceId(normalized.sourceId);
  if (!normalized.idempotencyKey) throw apiError('LOYALTY_IDEMPOTENCY_REQUIRED', 400, 'idempotency_key is required');

  const reservationId = reservationDocId(normalized.memberId, normalized.sourceType, normalized.sourceId, normalized.idempotencyKey);
  const reservationRef = db.collection('loyalty_reservations').doc(reservationId);
  const state = await readLoyaltyState(transaction, db, normalized.memberId);
  const reservationSnap = await transaction.get(reservationRef);
  const expired = await releaseExpiredReservationsInTransaction(
    transaction,
    db,
    normalized.memberId,
    state.summaryRef,
    state.summary,
    Date.now(),
    { updateSummary: false }
  );
  const refreshedSummary = {
    ...state.summary,
    reservedPoints: Math.max(0, summaryReservedPoints(state.summary) - expired.releasedPoints),
  };
  if (reservationSnap.exists) {
    const existing = reservationSnap.data() || {};
    const status = normalizeStatus(existing.status);
    if ((status === 'reserved' && !reservationExpired(existing)) || status === 'redeemed') {
      return {
        reservationId,
        status,
        sourceType: existing.sourceType || normalized.sourceType,
        sourceId: existing.sourceId || normalized.sourceId,
        memberId: existing.memberId || normalized.memberId,
        redeemedPoints: integerPoints(existing.redeemedPoints),
        loyaltyDiscount: positiveMoney(existing.loyaltyDiscount),
        payableAmount: positiveMoney(existing.payableAmount),
        replayed: true,
      };
    }
  }

  const quote = quoteFromState({
    input: normalized,
    config: state.config,
    member: state.member,
    summary: refreshedSummary,
  });
  if (quote.requestedRedeemedPoints <= 0) throw apiError('LOYALTY_REDEEM_POINTS_REQUIRED', 400, 'redeemed_points must be greater than zero');
  if (quote.blockedReason) {
    throw apiError('LOYALTY_REDEEM_BLOCKED', 409, 'Loyalty redemption is not allowed', { reason: quote.blockedReason, quote });
  }
  const now = FieldValue.serverTimestamp();
  const payload = {
    id: reservationId,
    reservationId,
    status: 'reserved',
    branchId: normalized.branchId,
    memberId: normalized.memberId,
    memberCode: memberCode(state.member, refreshedSummary),
    memberName: memberName(state.member, refreshedSummary),
    memberEmail: memberEmail(state.member, refreshedSummary),
    sourceType: normalized.sourceType,
    sourceId: normalized.sourceId,
    channel: quote.channel,
    idempotencyKey: normalized.idempotencyKey,
    redeemedPoints: quote.redeemedPoints,
    loyaltyDiscount: quote.loyaltyDiscount,
    payableAmount: quote.payableAmount,
    eligibleAmount: quote.eligibleAmount,
    pointsBalance: quote.pointsBalance,
    pointsReservedBefore: quote.reservedPoints,
    pointValue: quote.config.pointValue,
    maxRedeemPercent: quote.config.maxRedeemPercent,
    reservationExpiresAt: reservationExpiresAt(normalized.reservationMinutes),
    createdAt: now,
    updatedAt: now,
    createdBy: context.actor?.uid || cleanString(input.created_by || input.createdBy, 180),
    createdByEmail: cleanString(context.actor?.email || '', 180),
  };
  transaction.set(reservationRef, payload, { merge: false });
  transaction.set(state.summaryRef, {
    reservedPoints: quote.reservedPoints + quote.redeemedPoints,
    updatedAt: now,
  }, { merge: true });
  return {
    reservationId,
    status: 'reserved',
    sourceType: normalized.sourceType,
    sourceId: normalized.sourceId,
    memberId: normalized.memberId,
    redeemedPoints: quote.redeemedPoints,
    loyaltyDiscount: quote.loyaltyDiscount,
    payableAmount: quote.payableAmount,
    maxRedeemablePoints: quote.maxRedeemablePoints,
    expiresAt: payload.reservationExpiresAt,
    replayed: false,
  };
}

async function reserveLoyaltyRedemption(db, input = {}, context = {}) {
  return db.runTransaction(transaction => reserveLoyaltyRedemptionInTransaction(transaction, db, input, context));
}

async function commitLoyaltyReservationInTransaction(transaction, db, input = {}, context = {}) {
  const reservationId = cleanString(input.reservation_id || input.reservationId, 180);
  if (!reservationId) throw apiError('LOYALTY_RESERVATION_REQUIRED', 400, 'reservation_id is required');
  const reservationRef = db.collection('loyalty_reservations').doc(reservationId);
  const reservationSnap = await transaction.get(reservationRef);
  if (!reservationSnap.exists) throw apiError('LOYALTY_RESERVATION_NOT_FOUND', 404, 'Loyalty reservation was not found');
  const reservation = reservationSnap.data() || {};
  const status = normalizeStatus(reservation.status);
  if (status === 'redeemed') {
    return {
      reservationId,
      status: 'redeemed',
      ledgerId: cleanString(reservation.redeemLedgerId || reservation.ledgerId, 180),
      replayed: true,
    };
  }
  if (status !== 'reserved') throw apiError('LOYALTY_RESERVATION_NOT_RESERVED', 409, 'Loyalty reservation is not reserved');
  if (reservationExpired(reservation)) throw apiError('LOYALTY_RESERVATION_EXPIRED', 409, 'Loyalty reservation has expired');

  const memberId = cleanString(reservation.memberId, 180);
  const state = await readLoyaltyState(transaction, db, memberId);
  const pointsBefore = summaryPointsBalance(state.member, state.summary);
  const redeemedPoints = integerPoints(reservation.redeemedPoints);
  if (pointsBefore < redeemedPoints) throw apiError('LOYALTY_BALANCE_INSUFFICIENT', 409, 'Member points balance is not enough');
  const pointsAfter = Math.max(0, pointsBefore - redeemedPoints);
  const totalSpent = Math.max(0, Number(state.member.totalSpent || state.summary.totalSpent || 0));
  const loyaltySettings = loyaltyFormula.normalizeLoyaltySettings(state.config || {});
  const tier = loyaltyFormula.memberTierFromMetrics(pointsAfter, totalSpent, loyaltySettings.membershipTiers);
  const sourceType = normalizeSourceType(reservation.sourceType);
  const channel = channelFromSourceType(sourceType);
  const ledgerId = cleanString(input.ledger_id || input.ledgerId, 180)
    || `loyalty-redeem-${reservationId}`.slice(0, 260);
  const ledgerRef = db.collection('point_ledger').doc(ledgerId);
  const ledgerSnap = await transaction.get(ledgerRef);
  if (ledgerSnap.exists) {
    transaction.update(reservationRef, {
      status: 'redeemed',
      redeemLedgerId: ledgerId,
      committedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { reservationId, status: 'redeemed', ledgerId, replayed: true };
  }

  const now = FieldValue.serverTimestamp();
  transaction.set(ledgerRef, {
    userId: memberId,
    memberCode: cleanString(reservation.memberCode || memberCode(state.member, state.summary), 80),
    memberName: cleanString(reservation.memberName || memberName(state.member, state.summary), 160),
    memberEmail: cleanString(reservation.memberEmail || memberEmail(state.member, state.summary), 180),
    type: `${channel.toLowerCase()}_redeem`,
    pointsDelta: -redeemedPoints,
    pointsBefore,
    pointsAfter,
    amount: positiveMoney(reservation.loyaltyDiscount),
    source: channel.toLowerCase(),
    sourceType,
    sourceId: cleanString(reservation.sourceId, 180),
    branchId: cleanString(reservation.branchId, 80),
    reservationId,
    paymentId: cleanString(input.payment_id || input.paymentId, 180),
    receiptId: cleanString(input.receipt_id || input.receiptId, 180),
    idempotencyKey: cleanString(reservation.idempotencyKey, 180),
    createdAt: now,
    createdBy: context.actor?.uid || cleanString(input.created_by || input.createdBy, 180),
    createdByEmail: cleanString(context.actor?.email || '', 180),
  });
  transaction.set(state.userRef, {
    points: pointsAfter,
    tier,
    loyaltyUpdatedAt: now,
    updatedAt: now,
  }, { merge: true });
  transaction.set(state.summaryRef, {
    pointsBalance: pointsAfter,
    reservedPoints: Math.max(0, summaryReservedPoints(state.summary) - redeemedPoints),
    totalRedeemed: FieldValue.increment(redeemedPoints),
    tier,
    lastLedgerId: ledgerId,
    updatedAt: now,
  }, { merge: true });
  transaction.update(reservationRef, {
    status: 'redeemed',
    redeemLedgerId: ledgerId,
    paymentId: cleanString(input.payment_id || input.paymentId, 180),
    receiptId: cleanString(input.receipt_id || input.receiptId, 180),
    committedAt: now,
    updatedAt: now,
  });
  return {
    reservationId,
    status: 'redeemed',
    ledgerId,
    memberId,
    redeemedPoints,
    loyaltyDiscount: positiveMoney(reservation.loyaltyDiscount),
    pointsBefore,
    pointsAfter,
    tier,
    replayed: false,
  };
}

async function commitLoyaltyReservation(db, input = {}, context = {}) {
  return db.runTransaction(transaction => commitLoyaltyReservationInTransaction(transaction, db, input, context));
}

async function releaseLoyaltyReservationInTransaction(transaction, db, input = {}, context = {}) {
  const reservationId = cleanString(input.reservation_id || input.reservationId, 180);
  if (!reservationId) throw apiError('LOYALTY_RESERVATION_REQUIRED', 400, 'reservation_id is required');
  const reservationRef = db.collection('loyalty_reservations').doc(reservationId);
  const snap = await transaction.get(reservationRef);
  if (!snap.exists) return { reservationId, status: 'missing', replayed: true };
  const reservation = snap.data() || {};
  const expectedMemberId = memberIdFromInput(input);
  if (expectedMemberId && cleanString(reservation.memberId, 180) !== expectedMemberId) {
    throw apiError('LOYALTY_RESERVATION_MEMBER_MISMATCH', 403, 'Loyalty reservation belongs to another member');
  }
  const status = normalizeStatus(reservation.status);
  if (status === 'released' || status === 'expired') return { reservationId, status, replayed: true };
  if (status === 'redeemed') throw apiError('LOYALTY_RESERVATION_ALREADY_REDEEMED', 409, 'Redeemed loyalty reservations cannot be released');
  if (status !== 'reserved') throw apiError('LOYALTY_RESERVATION_NOT_RESERVED', 409, 'Loyalty reservation cannot be released');
  const memberId = cleanString(reservation.memberId, 180);
  const summaryRef = db.collection('member_summaries').doc(memberId);
  const summarySnap = await transaction.get(summaryRef);
  const summary = summarySnap.exists ? summarySnap.data() || {} : {};
  const points = integerPoints(reservation.redeemedPoints);
  const now = FieldValue.serverTimestamp();
  transaction.update(reservationRef, {
    status: input.expired === true ? 'expired' : 'released',
    releasedAt: now,
    releaseReason: cleanString(input.reason || 'released', 300),
    releasedBy: context.actor?.uid || cleanString(input.released_by || input.releasedBy, 180),
    updatedAt: now,
  });
  if (points > 0) {
    transaction.set(summaryRef, {
      reservedPoints: Math.max(0, summaryReservedPoints(summary) - points),
      updatedAt: now,
    }, { merge: true });
  }
  return { reservationId, status: input.expired === true ? 'expired' : 'released', replayed: false };
}

async function releaseLoyaltyReservation(db, input = {}, context = {}) {
  return db.runTransaction(transaction => releaseLoyaltyReservationInTransaction(transaction, db, input, context));
}

module.exports = {
  channelFromSourceType,
  commitLoyaltyReservation,
  commitLoyaltyReservationInTransaction,
  normalizeQuoteInput,
  normalizeSourceType,
  quoteFromState,
  quoteLoyaltyRedemption,
  quoteLoyaltyRedemptionInTransaction,
  releaseExpiredReservationsInTransaction,
  releaseLoyaltyReservation,
  releaseLoyaltyReservationInTransaction,
  reservationDocId,
  reserveLoyaltyRedemption,
  reserveLoyaltyRedemptionInTransaction,
};
