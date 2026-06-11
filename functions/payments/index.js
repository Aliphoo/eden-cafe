const { httpFunction, requireRoles, requireStaffSession } = require('../security/authz');
const { runIdempotentTransaction, sha256 } = require('../shared/idempotency');
const { writeAuditLog } = require('../shared/audit');
const { FieldValue } = require('../shared/firestore');
const {
  SERVICE_TYPE,
  apiError,
  cleanString,
  normalizeBranchId,
} = require('../shared/time');
const beamArcheryPayments = require('./beamArchery');
const webPaymentCore = require('./webPaymentCore');

function paymentId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 40)}`;
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

const recordCounterPayment = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  requireRoles(actor, ['OWNER', 'MANAGER', 'CASHIER'], branchId);
  const bookingId = cleanString(data.booking_id || data.bookingId, 180);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  if (!bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'recordCounterPayment',
    idempotencyKey,
    actorId: actor.uid,
    payload: {
      booking_id: bookingId,
      amount: data.amount,
      method: data.method,
    },
  }, async transaction => {
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    const { ref, booking } = await readArcheryBooking(transaction, db, branchId, bookingId);
    const currentPaymentStatus = cleanString(booking.payment_status, 40).toUpperCase();
    if (['PAID_ONLINE', 'PAID_COUNTER', 'PAID'].includes(currentPaymentStatus)) {
      throw apiError('PAYMENT_ALREADY_RECORDED', 409, 'Payment has already been recorded');
    }
    const amount = Number(data.amount || booking.amount_total || 0) || 0;
    const paymentRef = db.collection('payments').doc(paymentId('counter', `${branchId}:${bookingId}:${idempotencyKey}`));
    const paymentSnap = await transaction.get(paymentRef);
    if (paymentSnap.exists) {
      const existing = paymentSnap.data() || {};
      if (existing.booking_id !== bookingId) {
        throw apiError('PAYMENT_ALREADY_RECORDED', 409, 'idempotency_key has already recorded another payment');
      }
    }
    const now = FieldValue.serverTimestamp();
    transaction.set(paymentRef, {
      payment_id: paymentRef.id,
      branch_id: branchId,
      booking_id: bookingId,
      member_id: booking.member_id,
      service_type: SERVICE_TYPE,
      amount,
      currency: booking.currency || 'THB',
      payment_method: cleanString(data.method || 'COUNTER', 40).toUpperCase(),
      payment_status: 'PAID_COUNTER',
      status: 'PAID',
      idempotency_key: idempotencyKey,
      cashier_uid: actor.uid,
      paid_at: now,
      created_at: now,
      updated_at: now,
    }, { merge: true });
    transaction.update(ref, {
      payment_id: paymentRef.id,
      payment_status: 'PAID_COUNTER',
      paid_at: now,
      paid_by: actor.uid,
      updated_at: now,
    });
    writeAuditLog(transaction, db, {
      branchId,
      actor,
      staffSessionId,
      action: 'recordCounterPayment',
      targetCollection: 'payments',
      targetId: paymentRef.id,
      before: booking,
      after: { booking_id: bookingId, payment_status: 'PAID_COUNTER' },
      requestId,
    });
    return {
      booking_id: bookingId,
      payment_id: paymentRef.id,
      payment_status: 'PAID_COUNTER',
    };
  });

  return { replayed: result.replayed, ...result.response };
}, {
  name: 'recordCounterPayment',
  methods: ['POST'],
});

const refundPayment = httpFunction(async ({ db, data, actor, requestId }) => {
  const branchId = normalizeBranchId(data.branch_id);
  requireRoles(actor, ['OWNER', 'MANAGER'], branchId);
  const paymentIdInput = cleanString(data.payment_id || data.paymentId, 180);
  const bookingId = cleanString(data.booking_id || data.bookingId, 180);
  const reason = cleanString(data.reason, 500);
  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  if (!paymentIdInput || !bookingId) throw apiError('PAYMENT_REQUIRED', 400, 'payment_id and booking_id are required');
  if (!reason) throw apiError('REASON_REQUIRED', 400, 'reason is required');

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'refundPayment',
    idempotencyKey,
    actorId: actor.uid,
    payload: {
      payment_id: paymentIdInput,
      booking_id: bookingId,
      amount: data.amount,
      reason,
    },
  }, async transaction => {
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    const paymentRef = db.collection('payments').doc(paymentIdInput);
    const paymentSnap = await transaction.get(paymentRef);
    if (!paymentSnap.exists) throw apiError('PAYMENT_NOT_FOUND', 404, 'Payment was not found');
    const payment = paymentSnap.data() || {};
    if (payment.branch_id !== branchId || payment.booking_id !== bookingId) {
      throw apiError('PAYMENT_NOT_FOUND', 404, 'Payment was not found for this booking');
    }
    if (['REFUNDED', 'VOIDED'].includes(cleanString(payment.payment_status || payment.status, 40).toUpperCase())) {
      throw apiError('PAYMENT_ALREADY_RECORDED', 409, 'Payment was already refunded');
    }
    const { ref: bookingRef, booking } = await readArcheryBooking(transaction, db, branchId, bookingId);
    const amount = Number(data.amount || payment.amount || 0) || 0;
    const now = FieldValue.serverTimestamp();
    transaction.update(paymentRef, {
      payment_status: 'REFUNDED',
      status: 'REFUNDED',
      refund_amount: amount,
      refund_reason: reason,
      refunded_by: actor.uid,
      refunded_at: now,
      updated_at: now,
    });
    transaction.update(bookingRef, {
      refund_required: false,
      refund_status: 'REFUNDED',
      refunded_at: now,
      refunded_by: actor.uid,
      updated_at: now,
    });
    writeAuditLog(transaction, db, {
      branchId,
      actor,
      staffSessionId,
      action: 'refundPayment',
      targetCollection: 'payments',
      targetId: paymentIdInput,
      before: payment,
      after: { payment_id: paymentIdInput, payment_status: 'REFUNDED', refund_amount: amount },
      reason,
      requestId,
    });
    return {
      booking_id: bookingId,
      payment_id: paymentIdInput,
      refund_status: 'REFUNDED',
      refund_amount: amount,
      previous_booking_status: booking.booking_status || booking.status || '',
    };
  });

  return { replayed: result.replayed, ...result.response };
}, {
  name: 'refundPayment',
  methods: ['POST'],
});

module.exports = {
  recordCounterPayment,
  refundPayment,
  createBeamArcheryPayment: beamArcheryPayments.createBeamArcheryPayment,
  beamArcheryPaymentWebhook: beamArcheryPayments.beamArcheryPaymentWebhook,
  getArcheryPaymentStatus: beamArcheryPayments.getArcheryPaymentStatus,
  reconcileBeamLatePayment: beamArcheryPayments.reconcileBeamLatePayment,
  createPaymentIntent: webPaymentCore.createPaymentIntent,
  getPaymentStatus: webPaymentCore.getPaymentStatus,
  listPaymentsForSource: webPaymentCore.listPaymentsForSource,
  cancelPendingPayment: webPaymentCore.cancelPendingPayment,
  requestRefund: webPaymentCore.requestRefund,
  approveRefund: webPaymentCore.approveRefund,
  reconcileLatePayment: webPaymentCore.reconcileLatePayment,
  issueWebReceipt: webPaymentCore.issueWebReceipt,
  paymentWebhook: webPaymentCore.paymentWebhook,
};
