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
const {
  loadArcheryPricingConfig,
  calculateArcheryPricing,
  normalizePartySize,
} = require('./pricing');
const {
  readArcheryLoyaltyState,
  writeArcheryLoyaltyState,
} = require('./loyalty');

const WALKIN_PAYMENT_METHODS = new Set(['QR_PAYMENT', 'CASH']);

const createWalkInArcheryBooking = httpFunction(async ({ db, data, actor, requestId }) => {
  assertNoClientLane(data);
  const branchId = normalizeBranchId(data.branch_id);
  requireRoles(actor, ['OWNER', 'MANAGER', 'ARCHERY_STAFF'], branchId);

  const staffSessionId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const memberId = cleanString(data.member_id || data.memberId, 160);
  if (!memberId) throw apiError('MEMBER_NOT_FOUND', 404, 'member_id is required');
  const timing = normalizeTiming(data);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  const legacyPaymentStatus = cleanString(data.payment_status || data.paymentStatus || '', 40).toUpperCase();
  const requestedPaymentMethod = cleanString(data.payment_method || data.paymentMethod || '', 40).toUpperCase();
  const paymentMethod = requestedPaymentMethod
    || (legacyPaymentStatus === 'PAID_COUNTER' ? 'CASH' : 'QR_PAYMENT');
  if (!WALKIN_PAYMENT_METHODS.has(paymentMethod)) {
    throw apiError('INVALID_PAYMENT_METHOD', 400, 'Walk-in payment_method must be QR_PAYMENT or CASH');
  }
  const isCash = paymentMethod === 'CASH';
  const bookingStatus = isCash ? 'CONFIRMED' : 'HELD';
  const paymentStatus = isCash ? 'PAID_COUNTER' : 'UNPAID';
  const lockStatus = isCash ? 'CONFIRMED' : 'HELD';
  const pricingConfig = await loadArcheryPricingConfig(null, db);
  const pricingPreview = calculateArcheryPricing(pricingConfig, timing, data);
  const partySize = normalizePartySize(pricingPreview);

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
      party_size: partySize,
      ability_option_id: pricingPreview.ability_option_id,
      participant_options: pricingPreview.participant_options,
      equipment_option_id: pricingPreview.equipment_option_id,
      payment_method: paymentMethod,
      payment_status: paymentStatus,
    },
  }, async transaction => {
    await requireStaffSession(transaction, db, actor, branchId, staffSessionId);
    const bookingRef = db.collection('bookings').doc();
    const paymentRef = paymentStatus === 'PAID_COUNTER'
      ? db.collection('payments').doc()
      : null;
    let loyaltyState = null;
    if (paymentRef) {
      loyaltyState = await readArcheryLoyaltyState(transaction, db, {
        bookingId: bookingRef.id,
        booking: {
          booking_id: bookingRef.id,
          branch_id: branchId,
          service_type: SERVICE_TYPE,
          member_id: memberId,
          uid: memberId,
          customerUid: memberId,
          source: 'WALK_IN',
          booking_status: bookingStatus,
          status: bookingStatus,
          payment_method: paymentMethod,
          payment_status: paymentStatus,
          payment_id: paymentRef.id,
          amount_total: pricingPreview.amount_total,
          booking_date: timing.booking_date,
          date: timing.booking_date,
          customer_name: data.customer_name || data.customerName,
          name: data.customer_name || data.customerName,
        },
      });
    }
    const created = await createArcheryBookingInTransaction(transaction, db, {
      bookingRef,
      branchId,
      memberId,
      source: 'WALK_IN',
      timing,
      pricingConfig,
      pricingSelection: data,
      bookingStatus,
      paymentMethod,
      paymentStatus,
      lockStatus,
      idempotencyKey,
      actorId: actor.uid,
      customerName: data.customer_name || data.customerName,
      customerPhone: data.customer_phone || data.customerPhone,
      customerEmail: data.customer_email || data.customerEmail,
      note: data.note,
    });

    let paymentId = '';
    let loyaltyResult = null;
    if (paymentRef) {
      paymentId = paymentRef.id;
      transaction.set(paymentRef, {
        payment_id: paymentRef.id,
        branch_id: branchId,
        booking_id: created.booking_id,
        member_id: memberId,
        service_type: SERVICE_TYPE,
        amount: created.booking.amount_total,
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
      loyaltyState.booking = {
        ...created.booking,
        payment_id: paymentRef.id,
        payment_status: paymentStatus,
      };
      loyaltyResult = writeArcheryLoyaltyState(transaction, loyaltyState, {
        paymentId: paymentRef.id,
        paymentStatus,
        bookingStatus,
        actorId: actor.uid,
        actorEmail: actor.email || '',
      });
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
        booking_status: bookingStatus,
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        assigned_resource_id: created.assigned_resource_id,
        assigned_resource_ids: created.assigned_resource_ids,
        assigned_lane_numbers: created.assigned_lane_numbers,
        party_size: created.booking.party_size,
        required_lane_count: created.booking.required_lane_count,
        amount_total: created.booking.amount_total,
        ability_option_id: created.booking.ability_option_id,
        participant_options: created.booking.participant_options,
        staff_count: created.booking.staff_count,
        equipment_option_id: created.booking.equipment_option_id,
      },
      requestId,
    });

    return {
      booking_id: created.booking_id,
      branch_id: branchId,
      service_type: SERVICE_TYPE,
      booking_status: bookingStatus,
      payment_method: paymentMethod,
      payment_status: paymentStatus,
      payment_id: paymentId,
      assigned_resource_id: created.assigned_resource_id,
      assigned_resource_ids: created.assigned_resource_ids,
      assigned_lane_numbers: created.assigned_lane_numbers,
      party_size: created.booking.party_size,
      required_lane_count: created.booking.required_lane_count,
      amount_total: created.booking.amount_total,
      package_amount: created.booking.package_amount,
      ability_option_id: created.booking.ability_option_id,
      ability_label: created.booking.ability_label,
      participant_options: created.booking.participant_options,
      staff_count: created.booking.staff_count,
      coach_required: created.booking.coach_required,
      coach_rate_per_hour: created.booking.coach_rate_per_hour,
      coach_amount: created.booking.coach_amount,
      equipment_option_id: created.booking.equipment_option_id,
      equipment_label: created.booking.equipment_label,
      equipment_rate_per_hour: created.booking.equipment_rate_per_hour,
      equipment_amount: created.booking.equipment_amount,
      amount_breakdown: created.booking.amount_breakdown,
      pricing_version: created.booking.pricing_version,
      pricing_updated_at: created.booking.pricing_updated_at,
      expires_at: created.expires_at ? created.expires_at.toDate().toISOString() : null,
      payment_required: paymentMethod === 'QR_PAYMENT',
      loyalty: loyaltyResult,
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
