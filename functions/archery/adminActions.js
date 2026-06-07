const { httpFunction, requireRoles, requireStaffSession } = require('../security/authz');
const { runIdempotentTransaction } = require('../shared/idempotency');
const { writeAuditLog } = require('../shared/audit');
const { FieldValue } = require('../shared/firestore');
const {
  SERVICE_TYPE,
  CLOSE_MINUTES,
  SLOT_MINUTES,
  apiError,
  cleanString,
  normalizeBranchId,
  normalizeTime,
  minutesFromTime,
  timeFromMinutes,
  timestampFromBangkok,
  generateSlotKeys,
  timingFromBooking,
} = require('../shared/time');
const {
  assertResourceAvailable,
  loadLaneResources,
  writeLocks,
  updateLocksForBooking,
  releaseLocksForBooking,
} = require('../shared/locks');
const { readBookingOrThrow } = require('./cancel');

function requireOperationalRole(actor, branchId) {
  requireRoles(actor, ['OWNER', 'MANAGER', 'ARCHERY_STAFF'], branchId);
}

function assertBookingStatus(booking, allowed) {
  const status = cleanString(booking.booking_status || booking.status, 40).toUpperCase();
  if (!allowed.includes(status)) {
    throw apiError('BOOKING_STATE_DOES_NOT_ALLOW_ACTION', 409, 'Booking state does not allow this action');
  }
  return status;
}

function baseAdminPayload(data, actor) {
  return {
    branchId: normalizeBranchId(data.branch_id),
    bookingId: cleanString(data.booking_id || data.bookingId, 180),
    staffSessionId: cleanString(data.staff_session_id || data.staffSessionId, 180),
    idempotencyKey: cleanString(data.idempotency_key || data.idempotencyKey, 180),
    reason: cleanString(data.reason, 500),
    actorId: actor.uid,
  };
}

async function withOperationalTransaction(db, actor, action, data, requestId, callback) {
  const payload = baseAdminPayload(data, actor);
  if (!payload.bookingId) throw apiError('BOOKING_REQUIRED', 400, 'booking_id is required');
  requireOperationalRole(actor, payload.branchId);
  const result = await runIdempotentTransaction(db, {
    branchId: payload.branchId,
    action,
    idempotencyKey: payload.idempotencyKey,
    actorId: actor.uid,
    payload: {
      booking_id: payload.bookingId,
      reason: payload.reason,
      action_payload: data,
    },
  }, async transaction => {
    await requireStaffSession(transaction, db, actor, payload.branchId, payload.staffSessionId);
    return callback(transaction, payload, requestId);
  });
  return { replayed: result.replayed, ...result.response };
}

const adminCheckInBooking = httpFunction(async ({ db, data, actor, requestId }) => (
  withOperationalTransaction(db, actor, 'adminCheckInBooking', data, requestId, async (transaction, payload) => {
    const { ref, booking } = await readBookingOrThrow(transaction, db, payload.branchId, payload.bookingId);
    assertBookingStatus(booking, ['CONFIRMED']);
    const timing = timingFromBooking(booking);
    const now = FieldValue.serverTimestamp();
    await updateLocksForBooking(transaction, db, payload.branchId, payload.bookingId, {
      lock_status: 'CHECKED_IN',
      status: 'CHECKED_IN',
    });
    transaction.update(ref, {
      booking_status: 'CHECKED_IN',
      status: 'CHECKED_IN',
      checked_in_at: now,
      checked_in_by: actor.uid,
      updated_at: now,
    });
    transaction.set(db.collection('lane_sessions').doc(payload.bookingId), {
      lane_session_id: payload.bookingId,
      branch_id: payload.branchId,
      booking_id: payload.bookingId,
      resource_id: booking.assigned_resource_id || booking.resource_id,
      member_id: booking.member_id,
      status: 'CHECKED_IN',
      checked_in_by: actor.uid,
      checked_in_at: now,
      planned_end_time: timing.end_time,
      created_at: now,
      updated_at: now,
    }, { merge: true });
    writeAuditLog(transaction, db, {
      branchId: payload.branchId,
      actor,
      staffSessionId: payload.staffSessionId,
      action: 'adminCheckInBooking',
      targetCollection: 'bookings',
      targetId: payload.bookingId,
      before: booking,
      after: { booking_id: payload.bookingId, booking_status: 'CHECKED_IN' },
      requestId,
    });
    return { booking_id: payload.bookingId, booking_status: 'CHECKED_IN' };
  })
), { name: 'adminCheckInBooking', methods: ['POST'] });

const adminCompleteBooking = httpFunction(async ({ db, data, actor, requestId }) => (
  withOperationalTransaction(db, actor, 'adminCompleteBooking', data, requestId, async (transaction, payload) => {
    const { ref, booking } = await readBookingOrThrow(transaction, db, payload.branchId, payload.bookingId);
    assertBookingStatus(booking, ['CONFIRMED', 'CHECKED_IN']);
    await releaseLocksForBooking(transaction, db, payload.branchId, payload.bookingId, {
      actorId: actor.uid,
      reason: 'COMPLETED',
    });
    const now = FieldValue.serverTimestamp();
    const rewardRef = db.collection('reward_points').doc(`archery_${payload.bookingId}`);
    const rewardPoints = Number(booking.reward_points || 0) || 0;
    transaction.update(ref, {
      booking_status: 'COMPLETED',
      status: 'COMPLETED',
      completed_at: now,
      completed_by: actor.uid,
      updated_at: now,
    });
    transaction.set(db.collection('lane_sessions').doc(payload.bookingId), {
      status: 'COMPLETED',
      completed_by: actor.uid,
      completed_at: now,
      updated_at: now,
    }, { merge: true });
    transaction.set(rewardRef, {
      reward_point_id: rewardRef.id,
      branch_id: payload.branchId,
      member_id: booking.member_id,
      booking_id: payload.bookingId,
      service_type: SERVICE_TYPE,
      points: rewardPoints,
      status: rewardPoints > 0 ? 'POSTED' : 'PENDING_POLICY',
      reason: 'ARCHERY_BOOKING_COMPLETED',
      idempotency_key: `reward_${payload.bookingId}`,
      created_at: now,
    }, { merge: true });
    writeAuditLog(transaction, db, {
      branchId: payload.branchId,
      actor,
      staffSessionId: payload.staffSessionId,
      action: 'adminCompleteBooking',
      targetCollection: 'bookings',
      targetId: payload.bookingId,
      before: booking,
      after: { booking_id: payload.bookingId, booking_status: 'COMPLETED' },
      requestId,
    });
    return { booking_id: payload.bookingId, booking_status: 'COMPLETED', reward_points: rewardPoints };
  })
), { name: 'adminCompleteBooking', methods: ['POST'] });

const adminMoveBookingLane = httpFunction(async ({ db, data, actor, requestId }) => (
  withOperationalTransaction(db, actor, 'adminMoveBookingLane', data, requestId, async (transaction, payload) => {
    const targetResourceId = cleanString(data.target_resource_id || data.new_resource_id || data.targetResourceId, 180);
    if (!targetResourceId) throw apiError('RESOURCE_REQUIRED', 400, 'target_resource_id is required');
    const { ref, booking } = await readBookingOrThrow(transaction, db, payload.branchId, payload.bookingId);
    assertBookingStatus(booking, ['CONFIRMED', 'CHECKED_IN']);
    const timing = timingFromBooking(booking);
    const slotKeys = generateSlotKeys(timing);
    const lanes = await loadLaneResources(db, payload.branchId, transaction);
    const target = lanes.find(lane => lane.resource_id === targetResourceId);
    if (!target) throw apiError('NO_LANE_AVAILABLE', 409, 'Target lane is not available in this branch');
    const targetLocks = await assertResourceAvailable(transaction, db, payload.branchId, targetResourceId, slotKeys, payload.bookingId);
    await releaseLocksForBooking(transaction, db, payload.branchId, payload.bookingId, {
      actorId: actor.uid,
      reason: 'MOVE_LANE',
    });
    const status = cleanString(booking.booking_status || booking.status, 40).toUpperCase() === 'CHECKED_IN' ? 'CHECKED_IN' : 'CONFIRMED';
    writeLocks(transaction, targetLocks, {
      branchId: payload.branchId,
      bookingId: payload.bookingId,
      memberId: booking.member_id,
      resourceId: targetResourceId,
      status,
      lockType: 'BOOKING',
    });
    const now = FieldValue.serverTimestamp();
    transaction.update(ref, {
      assigned_resource_id: targetResourceId,
      resource_id: targetResourceId,
      moved_at: now,
      moved_by: actor.uid,
      updated_at: now,
    });
    transaction.set(db.collection('lane_sessions').doc(payload.bookingId), {
      resource_id: targetResourceId,
      updated_at: now,
    }, { merge: true });
    writeAuditLog(transaction, db, {
      branchId: payload.branchId,
      actor,
      staffSessionId: payload.staffSessionId,
      action: 'adminMoveBookingLane',
      targetCollection: 'bookings',
      targetId: payload.bookingId,
      before: booking,
      after: { booking_id: payload.bookingId, assigned_resource_id: targetResourceId },
      reason: payload.reason,
      requestId,
    });
    return {
      booking_id: payload.bookingId,
      old_resource_id: booking.assigned_resource_id || booking.resource_id,
      new_resource_id: targetResourceId,
    };
  })
), { name: 'adminMoveBookingLane', methods: ['POST'] });

const adminExtendBooking = httpFunction(async ({ db, data, actor, requestId }) => (
  withOperationalTransaction(db, actor, 'adminExtendBooking', data, requestId, async (transaction, payload) => {
    const { ref, booking } = await readBookingOrThrow(transaction, db, payload.branchId, payload.bookingId);
    assertBookingStatus(booking, ['CONFIRMED', 'CHECKED_IN']);
    const timing = timingFromBooking(booking);
    const requestedEnd = cleanString(data.new_end_time || data.newEndTime, 10);
    const extraMinutes = Math.floor(Number(data.extra_minutes || data.extraMinutes || 0) || 0);
    let newEndMinutes = requestedEnd ? minutesFromTime(normalizeTime(requestedEnd)) : timing.end_minutes + extraMinutes;
    if (
      newEndMinutes <= timing.end_minutes
      || newEndMinutes > CLOSE_MINUTES
      || newEndMinutes % SLOT_MINUTES !== 0
    ) {
      throw apiError('OUTSIDE_OPERATING_HOURS', 400, 'Extension is outside operating hours');
    }
    const resourceId = cleanString(booking.assigned_resource_id || booking.resource_id, 180);
    const extraTiming = {
      booking_date: timing.booking_date,
      start_time: timing.end_time,
      end_time: timeFromMinutes(newEndMinutes),
      start_minutes: timing.end_minutes,
      end_minutes: newEndMinutes,
      duration_minutes: newEndMinutes - timing.end_minutes,
      package_code: `EXTEND_${newEndMinutes - timing.end_minutes}`,
    };
    const extraSlotKeys = generateSlotKeys(extraTiming);
    const extraLocks = await assertResourceAvailable(transaction, db, payload.branchId, resourceId, extraSlotKeys, payload.bookingId);
    const lockStatus = cleanString(booking.booking_status || booking.status, 40).toUpperCase() === 'CHECKED_IN' ? 'CHECKED_IN' : 'CONFIRMED';
    writeLocks(transaction, extraLocks, {
      branchId: payload.branchId,
      bookingId: payload.bookingId,
      memberId: booking.member_id,
      resourceId,
      status: lockStatus,
      lockType: 'BOOKING_EXTENSION',
    });
    const now = FieldValue.serverTimestamp();
    const newEndTime = timeFromMinutes(newEndMinutes);
    transaction.update(ref, {
      end_time: newEndTime,
      endTime: newEndTime,
      end_at: timestampFromBangkok(timing.booking_date, newEndTime),
      duration_minutes: newEndMinutes - timing.start_minutes,
      extended_minutes: (Number(booking.extended_minutes || 0) || 0) + extraTiming.duration_minutes,
      updated_at: now,
      updated_by: actor.uid,
    });
    transaction.set(db.collection('booking_items').doc(`${payload.bookingId}_extend_${newEndTime.replace(':', '')}`), {
      booking_id: payload.bookingId,
      branch_id: payload.branchId,
      service_type: SERVICE_TYPE,
      member_id: booking.member_id,
      item_type: 'EXTENSION',
      duration_minutes: extraTiming.duration_minutes,
      quantity: 1,
      unit_price: Number(data.extra_amount || 0) || 0,
      total_price: Number(data.extra_amount || 0) || 0,
      resource_id: resourceId,
      created_at: now,
      updated_at: now,
    }, { merge: true });
    transaction.set(db.collection('lane_sessions').doc(payload.bookingId), {
      planned_end_time: newEndTime,
      updated_at: now,
    }, { merge: true });
    writeAuditLog(transaction, db, {
      branchId: payload.branchId,
      actor,
      staffSessionId: payload.staffSessionId,
      action: 'adminExtendBooking',
      targetCollection: 'bookings',
      targetId: payload.bookingId,
      before: booking,
      after: { booking_id: payload.bookingId, end_time: newEndTime },
      reason: payload.reason,
      requestId,
    });
    return { booking_id: payload.bookingId, new_end_time: newEndTime, extra_minutes: extraTiming.duration_minutes };
  })
), { name: 'adminExtendBooking', methods: ['POST'] });

const adminMarkNoShow = httpFunction(async ({ db, data, actor, requestId }) => (
  withOperationalTransaction(db, actor, 'adminMarkNoShow', data, requestId, async (transaction, payload) => {
    if (!payload.reason) throw apiError('REASON_REQUIRED', 400, 'reason is required');
    const { ref, booking } = await readBookingOrThrow(transaction, db, payload.branchId, payload.bookingId);
    assertBookingStatus(booking, ['CONFIRMED']);
    await releaseLocksForBooking(transaction, db, payload.branchId, payload.bookingId, {
      actorId: actor.uid,
      reason: 'NO_SHOW',
    });
    const now = FieldValue.serverTimestamp();
    transaction.update(ref, {
      booking_status: 'NO_SHOW',
      status: 'NO_SHOW',
      no_show_at: now,
      no_show_by: actor.uid,
      no_show_reason: payload.reason,
      updated_at: now,
    });
    transaction.set(db.collection('lane_sessions').doc(payload.bookingId), {
      status: 'NO_SHOW',
      completed_at: now,
      updated_at: now,
    }, { merge: true });
    writeAuditLog(transaction, db, {
      branchId: payload.branchId,
      actor,
      staffSessionId: payload.staffSessionId,
      action: 'adminMarkNoShow',
      targetCollection: 'bookings',
      targetId: payload.bookingId,
      before: booking,
      after: { booking_id: payload.bookingId, booking_status: 'NO_SHOW' },
      reason: payload.reason,
      requestId,
    });
    return { booking_id: payload.bookingId, booking_status: 'NO_SHOW' };
  })
), { name: 'adminMarkNoShow', methods: ['POST'] });

module.exports = {
  adminCheckInBooking,
  adminCompleteBooking,
  adminMoveBookingLane,
  adminExtendBooking,
  adminMarkNoShow,
};
