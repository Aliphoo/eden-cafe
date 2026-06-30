const {
  httpFunction,
  requireMember,
  requireRoles,
  requireStaffSession,
} = require('../security/authz');
const { FieldValue } = require('../shared/firestore');
const {
  SERVICE_TYPE,
  apiError,
  cleanString,
  normalizeBranchId,
  timestampToDate,
} = require('../shared/time');
const loyaltyWallet = require('../loyaltyWallet');

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function integerPoints(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
}

function firstNumber(values, fallback = 0) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return fallback;
}

function isStaffActor(actor = {}) {
  return ['OWNER', 'MANAGER', 'ARCHERY_STAFF', 'CASHIER'].includes(actor.role);
}

function requestedRedeemedPoints(data = {}) {
  return integerPoints(
    data.redeemed_points
      ?? data.redeemedPoints
      ?? data.loyalty_redeemed_points
      ?? data.loyaltyRedeemedPoints
      ?? data.loyalty?.redeemed_points
      ?? data.loyalty?.redeemedPoints
      ?? data.points
  );
}

function bookingMemberId(booking = {}) {
  return cleanString(
    booking.member_id
      || booking.memberId
      || booking.customerUid
      || booking.uid
      || booking.userId,
    180
  );
}

function bookingAmountBeforeLoyalty(booking = {}) {
  return roundMoney(firstNumber([
    booking.total_before_loyalty,
    booking.totalBeforeLoyalty,
    booking.amount_before_loyalty,
    booking.amountBeforeLoyalty,
    booking.amount_total,
    booking.totalAmount,
    booking.total,
    booking.amount,
  ], 0));
}

function bookingPayableAmount(booking = {}) {
  return roundMoney(firstNumber([
    booking.amount_total,
    booking.totalAmount,
    booking.total,
    booking.amount,
  ], 0));
}

function bookingLoyaltyReservationId(booking = {}) {
  return cleanString(booking.loyalty_reservation_id || booking.loyaltyReservationId, 180);
}

function bookingLoyaltyStatus(booking = {}) {
  return cleanString(booking.loyalty_status || booking.loyaltyStatus, 40).toLowerCase();
}

function archeryLoyaltyItems(booking = {}) {
  const itemSource = Array.isArray(booking.booking_items) ? booking.booking_items : [];
  const lines = itemSource.map((item, index) => {
    const quantity = Math.max(1, Math.floor(Number(item.quantity || 1) || 1));
    const amount = roundMoney(item.amount || item.total_price || item.lineTotal || item.total || 0);
    if (amount <= 0) return null;
    return {
      productId: cleanString(item.item_type || item.itemType || `ARCHERY_${index}`, 120),
      name: cleanString(item.label || item.item_type || 'Archery item', 180),
      category: 'archery',
      quantity,
      unitPrice: roundMoney(item.unit_amount || item.unit_price || (amount / quantity) || amount),
      lineDiscount: 0,
    };
  }).filter(Boolean);
  if (lines.length) return lines;
  const amount = bookingAmountBeforeLoyalty(booking);
  return amount > 0
    ? [{
      productId: cleanString(booking.package_code || 'ARCHERY_BOOKING', 120),
      name: cleanString(booking.package_code || 'Eden Archery', 180),
      category: 'archery',
      quantity: 1,
      unitPrice: amount,
      lineDiscount: 0,
    }]
    : [];
}

function assertBookingCanReserveLoyalty(booking = {}) {
  const status = cleanString(booking.booking_status || booking.status, 40).toUpperCase();
  if (status !== 'HELD') {
    throw apiError('BOOKING_STATE_DOES_NOT_ALLOW_ACTION', 409, 'Only HELD bookings can reserve loyalty points');
  }
  const paymentStatus = cleanString(booking.payment_status || booking.paymentStatus, 40).toUpperCase();
  if (['PENDING', 'PAID_ONLINE', 'PAID_COUNTER', 'PAID', 'PAID_PROMO'].includes(paymentStatus)) {
    throw apiError('LOYALTY_PAYMENT_ALREADY_STARTED', 409, 'Loyalty points must be reserved before payment starts');
  }
  const expiresAt = timestampToDate(booking.expires_at || booking.hold_expires_at || booking.holdExpiresAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw apiError('HOLD_EXPIRED', 409, 'Booking hold has expired');
  }
}

function loyaltyBookingPatch(booking = {}, reservation = {}) {
  const totalBeforeLoyalty = bookingAmountBeforeLoyalty(booking);
  const payableAmount = roundMoney(Math.max(0, reservation.payableAmount ?? (totalBeforeLoyalty - reservation.loyaltyDiscount)));
  const loyaltyDiscount = roundMoney(reservation.loyaltyDiscount);
  return {
    amount_total: payableAmount,
    totalAmount: payableAmount,
    total: payableAmount,
    total_before_loyalty: totalBeforeLoyalty,
    totalBeforeLoyalty,
    amount_before_loyalty: totalBeforeLoyalty,
    amountBeforeLoyalty: totalBeforeLoyalty,
    loyalty_discount: loyaltyDiscount,
    loyaltyDiscount,
    redeemed_points: integerPoints(reservation.redeemedPoints),
    redeemedPoints: integerPoints(reservation.redeemedPoints),
    loyalty_reservation_id: reservation.reservationId,
    loyaltyReservationId: reservation.reservationId,
    loyalty_status: 'reserved',
    loyaltyStatus: 'reserved',
    payment_required: payableAmount > 0,
    amount_breakdown: {
      ...(booking.amount_breakdown || {}),
      total_before_loyalty: totalBeforeLoyalty,
      loyalty_discount: loyaltyDiscount,
      total: payableAmount,
    },
    updated_at: FieldValue.serverTimestamp(),
  };
}

function loyaltyStatusPatch(status, result = {}, details = {}) {
  const normalized = cleanString(status, 40).toLowerCase();
  if (!normalized) return {};
  const patch = {
    loyalty_status: normalized,
    loyaltyStatus: normalized,
    updated_at: FieldValue.serverTimestamp(),
  };
  if (result.reservationId) {
    patch.loyalty_reservation_id = result.reservationId;
    patch.loyaltyReservationId = result.reservationId;
  }
  if (result.ledgerId) {
    patch.loyalty_redeem_ledger_id = result.ledgerId;
    patch.loyaltyRedeemLedgerId = result.ledgerId;
  }
  if (details.paymentId) {
    patch.loyalty_payment_id = details.paymentId;
    patch.loyaltyPaymentId = details.paymentId;
  }
  if (details.reason) {
    patch.loyalty_release_reason = cleanString(details.reason, 300);
    patch.loyaltyReleaseReason = cleanString(details.reason, 300);
  }
  return patch;
}

async function readArcheryBooking(transaction, db, branchId, bookingId) {
  const ref = db.collection('bookings').doc(bookingId);
  const snap = await transaction.get(ref);
  if (!snap.exists) throw apiError('BOOKING_NOT_FOUND', 404, 'Booking was not found');
  const booking = snap.data() || {};
  if (booking.branch_id !== branchId || booking.service_type !== SERVICE_TYPE) {
    throw apiError('BOOKING_NOT_FOUND', 404, 'Archery booking was not found for this branch');
  }
  return { ref, booking };
}

async function requireArcheryLoyaltyActor(transaction, db, actor, branchId, booking, staffSessionId = '') {
  const memberId = bookingMemberId(booking);
  if (isStaffActor(actor)) {
    requireRoles(actor, ['OWNER', 'MANAGER', 'ARCHERY_STAFF', 'CASHIER'], branchId);
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    return memberId;
  }
  requireMember(actor, memberId);
  return memberId;
}

async function reserveArcheryLoyaltyForBookingInTransaction(transaction, db, input = {}, context = {}) {
  const branchId = normalizeBranchId(input.branch_id || input.branchId);
  const bookingId = cleanString(input.booking_id || input.bookingId, 180);
  const points = requestedRedeemedPoints(input);
  if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');
  if (points <= 0) throw apiError('LOYALTY_REDEEM_POINTS_REQUIRED', 400, 'redeemed_points must be greater than zero');

  const { ref, booking } = await readArcheryBooking(transaction, db, branchId, bookingId);
  await requireArcheryLoyaltyActor(
    transaction,
    db,
    context.actor || {},
    branchId,
    booking,
    input.staff_session_id || input.staffSessionId
  );
  assertBookingCanReserveLoyalty(booking);

  const existingReservationId = bookingLoyaltyReservationId(booking);
  const existingStatus = bookingLoyaltyStatus(booking);
  if (existingReservationId && existingStatus === 'reserved') {
    throw apiError('LOYALTY_ALREADY_RESERVED', 409, 'This booking already has reserved loyalty points');
  }

  const totalBeforeLoyalty = bookingPayableAmount(booking);
  if (totalBeforeLoyalty <= 0) throw apiError('LOYALTY_TOTAL_INVALID', 400, 'Booking total must be greater than zero');
  const reservation = await loyaltyWallet.reserveLoyaltyRedemptionInTransaction(transaction, db, {
    source_type: 'ARCHERY_BOOKING',
    source_id: bookingId,
    member_id: bookingMemberId(booking),
    branch_id: branchId,
    idempotency_key: cleanString(input.idempotency_key || input.idempotencyKey || `archery-loyalty-${bookingId}`, 180),
    totalBeforeLoyalty,
    redeemableAmount: totalBeforeLoyalty,
    redeemedPoints: points,
    items: archeryLoyaltyItems(booking),
    reservationMinutes: Math.max(1, Number(input.reservation_minutes || input.reservationMinutes) || 15),
    earnEligible: false,
  }, context);
  const patch = loyaltyBookingPatch(booking, reservation);
  transaction.update(ref, patch);
  return {
    booking_id: bookingId,
    branch_id: branchId,
    booking_status: booking.booking_status || booking.status || '',
    payment_status: booking.payment_status || booking.paymentStatus || 'UNPAID',
    payment_required: patch.payment_required,
    amount_total: patch.amount_total,
    totalAmount: patch.totalAmount,
    total_before_loyalty: patch.total_before_loyalty,
    loyalty_discount: patch.loyalty_discount,
    redeemed_points: patch.redeemed_points,
    loyalty_reservation_id: reservation.reservationId,
    loyalty_status: 'reserved',
    loyalty: reservation,
  };
}

const reserveArcheryLoyaltyRedemption = httpFunction(async ({ db, data, actor, requestId }) => {
  const result = await db.runTransaction(transaction => reserveArcheryLoyaltyForBookingInTransaction(transaction, db, data, {
    actor,
    requestId,
  }));
  return result;
}, {
  name: 'reserveArcheryLoyaltyRedemption',
  methods: ['POST'],
});

async function commitArcheryLoyaltyRedemptionInTransaction(transaction, db, booking = {}, options = {}) {
  const reservationId = bookingLoyaltyReservationId(booking);
  const status = bookingLoyaltyStatus(booking);
  if (!reservationId || status === 'redeemed') return null;
  const result = await loyaltyWallet.commitLoyaltyReservationInTransaction(transaction, db, {
    reservation_id: reservationId,
    payment_id: options.paymentId || booking.payment_id || booking.paymentId || '',
    receipt_id: options.bookingId || booking.booking_id || booking.id || '',
    ledger_id: `archery-redeem-${reservationId}`.slice(0, 260),
  }, {
    actor: options.actor || { uid: 'SYSTEM', role: 'SYSTEM', system: true },
  });
  return result;
}

async function releaseArcheryLoyaltyRedemptionInTransaction(transaction, db, booking = {}, options = {}) {
  const reservationId = bookingLoyaltyReservationId(booking);
  const status = bookingLoyaltyStatus(booking);
  if (!reservationId || status === 'released' || status === 'expired') return null;
  if (status === 'redeemed') return null;
  const result = await loyaltyWallet.releaseLoyaltyReservationInTransaction(transaction, db, {
    reservation_id: reservationId,
    member_id: bookingMemberId(booking),
    reason: options.reason || 'archery-released',
    expired: options.expired === true,
  }, {
    actor: options.actor || { uid: 'SYSTEM', role: 'SYSTEM', system: true },
  });
  return result;
}

async function commitArcheryLoyaltyForBooking(db, options = {}) {
  const branchId = normalizeBranchId(options.branchId || options.branch_id);
  const bookingId = cleanString(options.bookingId || options.booking_id, 180);
  if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');
  return db.runTransaction(async transaction => {
    const { ref, booking } = await readArcheryBooking(transaction, db, branchId, bookingId);
    const result = await commitArcheryLoyaltyRedemptionInTransaction(transaction, db, {
      ...booking,
      booking_id: bookingId,
      payment_id: options.paymentId || options.payment_id || booking.payment_id || '',
    }, {
      paymentId: options.paymentId || options.payment_id || booking.payment_id || '',
      bookingId,
      actor: options.actor || { uid: 'SYSTEM', role: 'SYSTEM', system: true },
    });
    if (result) {
      transaction.update(ref, loyaltyStatusPatch('redeemed', result, {
        paymentId: options.paymentId || options.payment_id || booking.payment_id || '',
      }));
    }
    return result;
  });
}

async function releaseArcheryLoyaltyForBooking(db, options = {}) {
  const branchId = normalizeBranchId(options.branchId || options.branch_id);
  const bookingId = cleanString(options.bookingId || options.booking_id, 180);
  if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');
  return db.runTransaction(async transaction => {
    const { ref, booking } = await readArcheryBooking(transaction, db, branchId, bookingId);
    const result = await releaseArcheryLoyaltyRedemptionInTransaction(transaction, db, booking, {
      reason: options.reason || 'archery-released',
      expired: options.expired === true,
      actor: options.actor || { uid: 'SYSTEM', role: 'SYSTEM', system: true },
    });
    if (result) {
      transaction.update(ref, loyaltyStatusPatch(options.expired === true ? 'expired' : 'released', result, {
        reason: options.reason || 'archery-released',
      }));
    }
    return result;
  });
}

module.exports = {
  archeryLoyaltyItems,
  bookingLoyaltyReservationId,
  bookingLoyaltyStatus,
  commitArcheryLoyaltyForBooking,
  commitArcheryLoyaltyRedemptionInTransaction,
  loyaltyBookingPatch,
  loyaltyStatusPatch,
  releaseArcheryLoyaltyForBooking,
  releaseArcheryLoyaltyRedemptionInTransaction,
  requestArcheryRedeemedPoints: requestedRedeemedPoints,
  reserveArcheryLoyaltyForBookingInTransaction,
  reserveArcheryLoyaltyRedemption,
};
