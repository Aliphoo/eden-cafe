const { httpFunction, requireRoles, requireStaffSession } = require('../security/authz');
const { runIdempotentTransaction } = require('../shared/idempotency');
const { writeAuditLog } = require('../shared/audit');
const { FieldValue } = require('../shared/firestore');
const {
  SERVICE_TYPE,
  apiError,
  cleanString,
  normalizeBranchId,
  normalizeTiming,
} = require('../shared/time');
const {
  createArcheryBookingInTransaction,
  assertNoClientLane,
} = require('./bookingHold');

const WALKIN_PAYMENT_STATUSES = new Set(['PAID_COUNTER', 'UNPAID']);

const createWalkInArcheryBooking = httpFunction(async ({ db, data, actor, requestId }) => {
  assertNoClientLane(data);
  const branchId = normalizeBranchId(data.branch_id);
  requireRoles(actor, ['OWNER', 'MANAGER', 'ARCHERY_STAFF'], branchId);

  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const memberId = cleanString(data.member_id || data.memberId, 160);
  if (!memberId) throw apiError('MEMBER_NOT_FOUND', 404, 'member_id is required');
  const timing = normalizeTiming(data);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  const paymentStatus = cleanString(data.payment_status || data.paymentStatus || 'UNPAID', 40).toUpperCase();
  if (!WALKIN_PAYMENT_STATUSES.has(paymentStatus)) {
    throw apiError('INVALID_PAYMENT_STATUS', 400, 'Walk-in payment_status must be PAID_COUNTER or UNPAID');
  }
  const amount = Number(data.amount || data.amount_total || 0) || 0;

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'createWalkInArcheryBooking',
    idempotencyKey,
    actorId: actor.uid,
    payload: {
      member_id: memberId,
      booking_date: timing.booking_date,
      start_time: timing.start_time,
      duration_minutes: timing.duration_minutes,
      package_code: timing.package_code,
      payment_status: paymentStatus,
    },
  }, async transaction => {
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    const created = await createArcheryBookingInTransaction(transaction, db, {
      branchId,
      memberId,
      source: 'WALK_IN',
      timing,
      amount,
      bookingStatus: 'CONFIRMED',
      paymentStatus,
      lockStatus: 'CONFIRMED',
      idempotencyKey,
      actorId: actor.uid,
      customerName: data.customer_name || data.customerName,
      customerPhone: data.customer_phone || data.customerPhone,
      customerEmail: data.customer_email || data.customerEmail,
      note: data.note,
    });

    let paymentId = '';
    if (paymentStatus === 'PAID_COUNTER') {
      const paymentRef = db.collection('payments').doc();
      paymentId = paymentRef.id;
      transaction.set(paymentRef, {
        payment_id: paymentRef.id,
        branch_id: branchId,
        booking_id: created.booking_id,
        member_id: memberId,
        service_type: SERVICE_TYPE,
        amount,
        currency: 'THB',
        payment_method: 'COUNTER',
        payment_status: 'PAID_COUNTER',
        status: 'PAID',
        idempotency_key: idempotencyKey,
        cashier_uid: actor.uid,
        paid_at: FieldValue.serverTimestamp(),
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
      transaction.update(created.bookingRef, { payment_id: paymentRef.id });
    }

    writeAuditLog(transaction, db, {
      branchId,
      actor,
      staffSessionId,
      action: 'createWalkInArcheryBooking',
      targetCollection: 'bookings',
      targetId: created.booking_id,
      after: {
        booking_id: created.booking_id,
        booking_status: 'CONFIRMED',
        payment_status: paymentStatus,
        assigned_resource_id: created.assigned_resource_id,
      },
      requestId,
    });

    return {
      booking_id: created.booking_id,
      branch_id: branchId,
      service_type: SERVICE_TYPE,
      booking_status: 'CONFIRMED',
      payment_status: paymentStatus,
      payment_id: paymentId,
      assigned_resource_id: created.assigned_resource_id,
    };
  });

  return {
    replayed: result.replayed,
    ...result.response,
  };
}, {
  name: 'createWalkInArcheryBooking',
  methods: ['POST'],
});

module.exports = {
  createWalkInArcheryBooking,
};
