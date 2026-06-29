const {
  httpFunction,
  requireMember,
  isTrustedSystemRequest,
  systemActor,
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
  commitArcheryPromotionApplications,
  archeryPromotionStatusUpdate,
} = require('./promotions');

function paymentDocId(providerRef, fallback) {
  return `pay_online_${sha256(providerRef || fallback).slice(0, 40)}`;
}

function envValue(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : String(value);
}

function boolEnv(name, fallback = false) {
  const value = envValue(name, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function paymentEnv() {
  return cleanString(envValue('PAYMENT_ENV', 'sandbox'), 40).toLowerCase() || 'sandbox';
}

function isProductionPaymentMode() {
  return boolEnv('ARCHERY_PAYMENT_LIVE', false) || paymentEnv() === 'production';
}

function allowCustomerMockConfirm() {
  return !isProductionPaymentMode() && boolEnv('ARCHERY_ALLOW_CUSTOMER_MOCK_CONFIRM', false);
}

function assertConfirmActorAllowed(actor) {
  if (actor?.role === 'SYSTEM' || actor?.system === true) return;
  if (allowCustomerMockConfirm()) return;
  throw apiError(
    'PAYMENT_CONFIRM_FORBIDDEN',
    403,
    isProductionPaymentMode()
      ? 'Production archery payment confirmation must come from trusted backend/webhook only'
      : 'Customer mock payment confirmation is disabled'
  );
}

const confirmArcheryBooking = httpFunction(async ({ req, db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  const bookingId = cleanString(data.booking_id || data.bookingId, 180);
  const providerRef = cleanString(data.provider_ref || data.providerRef, 180);
  const paymentIdInput = cleanString(data.payment_id || data.paymentId, 180);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');
  if (!providerRef && !paymentIdInput) throw apiError('PAYMENT_REQUIRED', 400, 'payment_id or provider_ref is required');

  const effectiveActor = actor || (isTrustedSystemRequest(req) ? systemActor() : null);
  if (!effectiveActor) throw apiError('AUTH_REQUIRED', 401, 'Authentication or trusted system key is required');
  assertConfirmActorAllowed(effectiveActor);

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'confirmArcheryBooking',
    idempotencyKey,
    actorId: effectiveActor.uid,
    payload: { booking_id: bookingId, provider_ref: providerRef, payment_id: paymentIdInput },
  }, async transaction => {
    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingSnap = await transaction.get(bookingRef);
    if (!bookingSnap.exists) throw apiError('BOOKING_NOT_FOUND', 404, 'Booking was not found');
    const booking = bookingSnap.data() || {};
    if (booking.branch_id !== branchId || booking.service_type !== SERVICE_TYPE) {
      throw apiError('BOOKING_NOT_FOUND', 404, 'Archery booking was not found for this branch');
    }
    const memberId = cleanString(booking.member_id || booking.uid || booking.customerUid, 160);
    if (effectiveActor.role !== 'SYSTEM') requireMember(effectiveActor, memberId);

    const bookingStatus = cleanString(booking.booking_status || booking.status, 40).toUpperCase();
    if (bookingStatus !== 'HELD') {
      throw apiError('BOOKING_STATE_DOES_NOT_ALLOW_ACTION', 409, 'Only HELD bookings can be confirmed');
    }
    const expiresAt = timestampToDate(booking.expires_at || booking.hold_expires_at || booking.holdExpiresAt);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw apiError('HOLD_EXPIRED', 409, 'Booking hold has expired');
    }

    if (providerRef) {
      const duplicatePaymentSnap = await transaction.get(
        db.collection('payments').where('provider_ref', '==', providerRef).limit(1)
      );
      if (!duplicatePaymentSnap.empty) {
        const duplicate = duplicatePaymentSnap.docs[0].data() || {};
        if (duplicate.booking_id !== bookingId) {
          throw apiError('PAYMENT_ALREADY_RECORDED', 409, 'provider_ref has already been recorded');
        }
      }
    }

    const paymentRef = db.collection('payments').doc(paymentIdInput || paymentDocId(providerRef, `${bookingId}:${idempotencyKey}`));
    const paymentSnap = await transaction.get(paymentRef);
    if (paymentSnap.exists && (paymentSnap.data() || {}).booking_id !== bookingId) {
      throw apiError('PAYMENT_ALREADY_RECORDED', 409, 'payment_id has already been recorded');
    }

    const now = FieldValue.serverTimestamp();
    const locksSnap = await queryLocksForBooking(transaction, db, branchId, bookingId);
    await commitArcheryPromotionApplications(transaction, db, {
      branchId,
      bookingId,
      booking,
      paymentId: paymentRef.id,
      actor: effectiveActor,
      requestId,
    });
    locksSnap.forEach(lockSnap => {
      transaction.set(lockSnap.ref, {
        lock_status: 'CONFIRMED',
        status: 'CONFIRMED',
        expires_at: null,
        hold_expires_at: null,
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    transaction.set(paymentRef, {
      payment_id: paymentRef.id,
      branch_id: branchId,
      booking_id: bookingId,
      member_id: memberId,
      service_type: SERVICE_TYPE,
      amount: Number(booking.amount_total || booking.total_price || 0) || 0,
      currency: booking.currency || 'THB',
      payment_method: 'ONLINE',
      payment_status: 'PAID_ONLINE',
      status: 'PAID',
      provider: cleanString(data.provider || 'ONLINE_PROVIDER', 80),
      provider_ref: providerRef || paymentIdInput,
      idempotency_key: idempotencyKey,
      paid_at: now,
      created_at: paymentSnap.exists ? paymentSnap.data().created_at || now : now,
      updated_at: now,
    }, { merge: true });

    transaction.update(bookingRef, {
      booking_status: 'CONFIRMED',
      status: 'CONFIRMED',
      payment_status: 'PAID_ONLINE',
      payment_id: paymentRef.id,
      provider_ref: providerRef || paymentIdInput,
      confirmed_at: now,
      updated_at: now,
      ...archeryPromotionStatusUpdate(booking, 'redeemed', { paymentId: paymentRef.id }),
    });

    writeAuditLog(transaction, db, {
      branchId,
      actor: effectiveActor,
      actorType: effectiveActor.role === 'SYSTEM' ? 'SYSTEM' : 'CUSTOMER',
      action: 'confirmArcheryBooking',
      targetCollection: 'bookings',
      targetId: bookingId,
      before: booking,
      after: { booking_id: bookingId, booking_status: 'CONFIRMED', payment_status: 'PAID_ONLINE' },
      requestId,
    });

    return {
      booking_id: bookingId,
      payment_id: paymentRef.id,
      booking_status: 'CONFIRMED',
      payment_status: 'PAID_ONLINE',
      qr_payload: {
        type: 'EDEN_ARCHERY_BOOKING',
        branch_id: branchId,
        booking_id: bookingId,
        member_id: memberId,
      },
    };
  });

  return {
    replayed: result.replayed,
    ...result.response,
  };
}, {
  name: 'confirmArcheryBooking',
  methods: ['POST'],
  optionalAuth: true,
});

module.exports = {
  confirmArcheryBooking,
};
