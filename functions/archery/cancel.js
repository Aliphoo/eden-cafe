const { httpFunction, requireRoles, requireStaffSession } = require('../security/authz');
const { runIdempotentTransaction } = require('../shared/idempotency');
const { writeAuditLog } = require('../shared/audit');
const { FieldValue } = require('../shared/firestore');
const {
  SERVICE_TYPE,
  apiError,
  cleanString,
  normalizeBranchId,
} = require('../shared/time');
const {
  queryLocksForBooking,
} = require('../shared/locks');
const {
  releaseArcheryPromotionApplications,
  archeryPromotionStatusUpdate,
} = require('./promotions');
const {
  releaseArcheryLoyaltyForBooking,
} = require('./loyaltyRedemption');

function readBookingOrThrow(transaction, db, branchId, bookingId) {
  const ref = db.collection('bookings').doc(bookingId);
  return transaction.get(ref).then(snap => {
    if (!snap.exists) throw apiError('BOOKING_NOT_FOUND', 404, 'Booking was not found');
    const booking = snap.data() || {};
    if (booking.branch_id !== branchId || booking.service_type !== SERVICE_TYPE) {
      throw apiError('BOOKING_NOT_FOUND', 404, 'Archery booking was not found for this branch');
    }
    return { ref, booking };
  });
}

const requestCancelBooking = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  const bookingId = cleanString(data.booking_id || data.bookingId, 180);
  const reason = cleanString(data.reason, 500);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');
  if (!reason) throw apiError('REASON_REQUIRED', 400, 'reason is required');

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'requestCancelBooking',
    idempotencyKey,
    actorId: actor.uid,
    payload: { booking_id: bookingId, reason },
  }, async transaction => {
    const { ref, booking } = await readBookingOrThrow(transaction, db, branchId, bookingId);
    const memberId = cleanString(booking.member_id || booking.uid || booking.customerUid, 160);

    if (actor.role === 'CUSTOMER') {
      if (memberId !== actor.uid) throw apiError('STAFF_PERMISSION_REQUIRED', 403, 'Cannot request cancel for another member');
    } else {
      requireRoles(actor, ['OWNER', 'MANAGER', 'ARCHERY_STAFF', 'CASHIER'], branchId);
      await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    }

    const status = cleanString(booking.booking_status || booking.status, 40).toUpperCase();
    if (['CANCELLED', 'COMPLETED', 'EXPIRED'].includes(status)) {
      throw apiError('BOOKING_STATE_DOES_NOT_ALLOW_ACTION', 409, 'Booking cannot be cancelled in this state');
    }

    const now = FieldValue.serverTimestamp();
    transaction.update(ref, {
      cancel_requested: true,
      cancel_request_status: 'PENDING',
      cancel_request_reason: reason,
      cancel_requested_by: actor.uid,
      cancel_requested_by_role: actor.role,
      cancel_requested_at: now,
      updated_at: now,
    });

    writeAuditLog(transaction, db, {
      branchId,
      actor,
      actorType: actor.role === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF',
      staffSessionId,
      action: 'requestCancelBooking',
      targetCollection: 'bookings',
      targetId: bookingId,
      before: booking,
      after: { booking_id: bookingId, cancel_request_status: 'PENDING' },
      reason,
      requestId,
    });

    return {
      booking_id: bookingId,
      cancel_request_status: 'PENDING',
    };
  });

  let loyaltyRelease = null;
  let loyaltyReleaseError = '';
  if (result.response?.booking_id && result.response?.refund_required === false) {
    try {
      loyaltyRelease = await releaseArcheryLoyaltyForBooking(db, {
        branchId,
        bookingId: result.response.booking_id,
        reason,
        actor,
      });
    } catch (error) {
      loyaltyReleaseError = cleanString(error.code || error.message || 'LOYALTY_REDEMPTION_RELEASE_FAILED', 180);
    }
  }

  return {
    replayed: result.replayed,
    ...result.response,
    loyalty_redemption: loyaltyRelease,
    loyalty_redemption_error: loyaltyReleaseError,
  };
}, {
  name: 'requestCancelBooking',
  methods: ['POST'],
});

const approveCancelBooking = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  requireRoles(actor, ['OWNER', 'MANAGER'], branchId);
  const bookingId = cleanString(data.booking_id || data.bookingId, 180);
  const reason = cleanString(data.reason, 500);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');
  if (!reason) throw apiError('REASON_REQUIRED', 400, 'reason is required');

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'approveCancelBooking',
    idempotencyKey,
    actorId: actor.uid,
    payload: { booking_id: bookingId, reason },
  }, async transaction => {
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    const { ref, booking } = await readBookingOrThrow(transaction, db, branchId, bookingId);
    const status = cleanString(booking.booking_status || booking.status, 40).toUpperCase();
    if (['CANCELLED', 'COMPLETED', 'EXPIRED'].includes(status)) {
      throw apiError('BOOKING_STATE_DOES_NOT_ALLOW_ACTION', 409, 'Booking cannot be cancelled in this state');
    }

    const paid = ['PAID_ONLINE', 'PAID_COUNTER', 'PAID'].includes(cleanString(booking.payment_status, 40).toUpperCase());
    const locksSnap = await queryLocksForBooking(transaction, db, branchId, bookingId);
    if (!paid) {
      await releaseArcheryPromotionApplications(transaction, db, {
        branchId,
        bookingId,
        booking,
        reason,
        actor,
        requestId,
      });
    }
    locksSnap.forEach(lockSnap => {
      transaction.set(lockSnap.ref, {
        lock_status: 'RELEASED',
        status: 'RELEASED',
        released_at: FieldValue.serverTimestamp(),
        released_by: actor.uid,
        release_reason: reason,
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    const now = FieldValue.serverTimestamp();
    transaction.update(ref, {
      booking_status: 'CANCELLED',
      status: 'CANCELLED',
      cancel_request_status: 'APPROVED',
      cancel_approved_by: actor.uid,
      cancel_approved_at: now,
      cancel_reason: reason,
      refund_required: paid,
      updated_at: now,
      ...(paid ? {} : archeryPromotionStatusUpdate(booking, 'released', { reason })),
    });

    writeAuditLog(transaction, db, {
      branchId,
      actor,
      staffSessionId,
      action: 'approveCancelBooking',
      targetCollection: 'bookings',
      targetId: bookingId,
      before: booking,
      after: { booking_id: bookingId, booking_status: 'CANCELLED', refund_required: paid },
      reason,
      requestId,
    });

    return {
      booking_id: bookingId,
      booking_status: 'CANCELLED',
      refund_required: paid,
    };
  });

  return {
    replayed: result.replayed,
    ...result.response,
  };
}, {
  name: 'approveCancelBooking',
  methods: ['POST'],
});

module.exports = {
  requestCancelBooking,
  approveCancelBooking,
  readBookingOrThrow,
};
