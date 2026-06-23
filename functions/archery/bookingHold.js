const { httpFunction, requireMember } = require('../security/authz');
const { runIdempotentTransaction } = require('../shared/idempotency');
const { FieldValue, Timestamp } = require('../shared/firestore');
const {
  SERVICE_TYPE,
  RESOURCE_TYPE_ID,
  HOLD_MINUTES,
  apiError,
  cleanString,
  normalizeBranchId,
  normalizeTiming,
  timestampFromBangkok,
  generateSlotKeys,
} = require('../shared/time');
const {
  findAvailableLanes,
  writeLocks,
} = require('../shared/locks');
const {
  loadArcheryPricingConfig,
  calculateArcheryPricing,
  normalizePartySize,
} = require('./pricing');

function assertNoClientLane(data = {}) {
  if (
    data.assigned_resource_id
    || data.assignedResourceId
    || data.resource_id
    || data.resourceId
    || data.lane_id
    || data.laneId
  ) {
    throw apiError('LANE_SELECTION_NOT_ALLOWED', 400, 'Lane is auto-assigned by the backend');
  }
}

async function readMemberInTransaction(transaction, db, memberId) {
  const userRef = db.collection('users').doc(memberId);
  const summaryRef = db.collection('member_summaries').doc(memberId);
  const [userSnap, summarySnap] = await Promise.all([
    transaction.get(userRef),
    transaction.get(summaryRef),
  ]);
  if (!userSnap.exists && !summarySnap.exists) {
    throw apiError('MEMBER_NOT_FOUND', 404, 'Eden member was not found');
  }
  return {
    user: userSnap.exists ? userSnap.data() || {} : {},
    summary: summarySnap.exists ? summarySnap.data() || {} : {},
  };
}

function bookingDisplayName(member = {}, fallback = 'Eden Member') {
  const user = member.user || {};
  const summary = member.summary || {};
  return cleanString(
    user.displayName
      || user.display_name
      || summary.displayName
      || summary.name
      || fallback,
    120
  );
}

function bookingPhone(member = {}, fallback = '') {
  const user = member.user || {};
  const summary = member.summary || {};
  return cleanString(user.phone || user.phone_display || summary.phone || fallback, 40);
}

function bookingEmail(member = {}, fallback = '') {
  const user = member.user || {};
  const summary = member.summary || {};
  return cleanString(user.email || summary.email || fallback, 180).toLowerCase();
}

function laneNumberFromLane(lane = {}) {
  const text = cleanString(`${lane.resource_id || ''} ${lane.code || ''} ${lane.name || ''}`, 260);
  const match = text.match(/(?:LANE[_\s-]?|_)(\d{1,2})\b/i) || text.match(/(\d{1,2})/);
  if (match) return Number(match[1]);
  const sortOrder = Number(lane.sort_order || 0) || 0;
  return sortOrder >= 1 && sortOrder <= 10 ? sortOrder : 0;
}

function buildBookingPayload(options = {}) {
  const now = FieldValue.serverTimestamp();
  const timing = options.timing;
  const pricing = options.pricing || {};
  const amount = Number(pricing.amount_total || options.amount || 0) || 0;
  const assignedResourceIds = Array.isArray(options.resourceIds) && options.resourceIds.length
    ? options.resourceIds
    : [options.resourceId].filter(Boolean);
  const assignedLaneNumbers = Array.isArray(options.laneNumbers) ? options.laneNumbers : [];
  return {
    booking_id: options.bookingId,
    branch_id: options.branchId,
    service_type: SERVICE_TYPE,
    member_id: options.memberId,
    uid: options.memberId,
    customerUid: options.memberId,
    userId: options.memberId,
    source: options.source,
    booking_date: timing.booking_date,
    date: timing.booking_date,
    start_time: timing.start_time,
    startTime: timing.start_time,
    end_time: timing.end_time,
    endTime: timing.end_time,
    start_at: timestampFromBangkok(timing.booking_date, timing.start_time),
    end_at: timestampFromBangkok(timing.booking_date, timing.end_time),
    duration_minutes: timing.duration_minutes,
    package_code: timing.package_code,
    assigned_resource_id: options.resourceId,
    resource_id: options.resourceId,
    assigned_resource_ids: assignedResourceIds,
    assigned_lane_numbers: assignedLaneNumbers,
    party_size: Number(pricing.party_size || options.partySize || 1) || 1,
    required_lane_count: Number(pricing.required_lane_count || options.requiredLaneCount || assignedResourceIds.length || 1) || 1,
    resource_type_id: RESOURCE_TYPE_ID,
    booking_status: options.bookingStatus,
    status: options.bookingStatus,
    payment_method: cleanString(options.paymentMethod, 40),
    payment_status: options.paymentStatus,
    amount_total: amount,
    package_amount: Number(pricing.package_amount || amount) || 0,
    ability_option_id: pricing.ability_option_id || '',
    ability_label: pricing.ability_label || '',
    coach_required: pricing.coach_required === true,
    coach_rate_per_hour: Number(pricing.coach_rate_per_hour || 0) || 0,
    coach_amount: Number(pricing.coach_amount || 0) || 0,
    equipment_option_id: pricing.equipment_option_id || '',
    equipment_label: pricing.equipment_label || '',
    equipment_rate_per_hour: Number(pricing.equipment_rate_per_hour || 0) || 0,
    equipment_amount: Number(pricing.equipment_amount || 0) || 0,
    amount_breakdown: pricing.amount_breakdown || {
      package: amount,
      coach: 0,
      equipment: 0,
      total: amount,
    },
    pricing_version: pricing.pricing_version || '',
    pricing_updated_at: pricing.pricing_updated_at || null,
    currency: 'THB',
    customer_name: options.customerName,
    name: options.customerName,
    customer_phone: options.customerPhone,
    phone: options.customerPhone,
    customer_email: options.customerEmail,
    note: cleanString(options.note, 500),
    expires_at: options.expiresAt || null,
    idempotency_key: options.idempotencyKey,
    created_by: options.actorId,
    updated_by: options.actorId,
    created_at: now,
    updated_at: now,
  };
}

function buildBookingItemPayload(options = {}) {
  const now = FieldValue.serverTimestamp();
  const item = options.item || {};
  const amount = Number(item.amount || options.amount || 0) || 0;
  const quantity = Math.max(1, Math.floor(Number(item.quantity || options.quantity || 1) || 1));
  const unitPrice = Number(item.unit_amount || item.unit_price || (amount / quantity) || amount || 0) || 0;
  return {
    booking_item_id: options.bookingItemId,
    booking_id: options.bookingId,
    branch_id: options.branchId,
    service_type: SERVICE_TYPE,
    member_id: options.memberId,
    item_type: item.item_type || options.itemType || 'PACKAGE',
    label: cleanString(item.label || '', 120),
    package_code: options.timing.package_code,
    duration_minutes: options.timing.duration_minutes,
    quantity,
    unit_price: unitPrice,
    total_price: amount,
    rate_per_hour: item.rate_per_hour == null ? null : Number(item.rate_per_hour || 0) || 0,
    resource_id: options.resourceId,
    created_at: now,
    updated_at: now,
  };
}

async function createArcheryBookingInTransaction(transaction, db, options = {}) {
  const member = await readMemberInTransaction(transaction, db, options.memberId);
  const pricingConfig = options.pricingConfig || await loadArcheryPricingConfig(transaction, db);
  const pricing = options.pricing || calculateArcheryPricing(pricingConfig, options.timing, options.pricingSelection || {});
  const partySize = normalizePartySize(pricing);
  const requiredLaneCount = partySize;
  const slotKeys = generateSlotKeys(options.timing);
  const selected = await findAvailableLanes(transaction, db, options.branchId, slotKeys, requiredLaneCount);
  const selectedLanes = selected.lanes || [];
  const primaryLane = selectedLanes[0];
  if (!primaryLane) throw apiError('NO_LANE_AVAILABLE', 409, 'No lane is available for the requested time');
  const assignedResourceIds = selectedLanes.map(lane => lane.resource_id);
  const assignedLaneNumbers = selectedLanes.map(laneNumberFromLane).filter(Boolean);
  const bookingRef = options.bookingRef || db.collection('bookings').doc();
  const expiresAt = options.bookingStatus === 'HELD'
    ? Timestamp.fromMillis(Date.now() + (HOLD_MINUTES * 60 * 1000))
    : null;
  const customerName = cleanString(options.customerName, 120) || bookingDisplayName(member);
  const customerPhone = cleanString(options.customerPhone, 40) || bookingPhone(member);
  const customerEmail = cleanString(options.customerEmail, 180).toLowerCase() || bookingEmail(member);

  const bookingPayload = buildBookingPayload({
    bookingId: bookingRef.id,
    branchId: options.branchId,
    memberId: options.memberId,
    source: options.source,
    timing: options.timing,
    resourceId: primaryLane.resource_id,
    resourceIds: assignedResourceIds,
    laneNumbers: assignedLaneNumbers,
    partySize,
    requiredLaneCount,
    bookingStatus: options.bookingStatus,
    paymentStatus: options.paymentStatus,
    amount: pricing.amount_total,
    pricing,
    customerName,
    customerPhone,
    customerEmail,
    note: options.note,
    expiresAt,
    idempotencyKey: options.idempotencyKey,
    actorId: options.actorId,
  });

  transaction.set(bookingRef, bookingPayload);
  (pricing.booking_items || []).forEach(item => {
    const itemType = cleanString(item.item_type || 'PACKAGE', 40).toLowerCase();
    const bookingItemRef = db.collection('booking_items').doc(`${bookingRef.id}_${itemType}`);
    transaction.set(bookingItemRef, buildBookingItemPayload({
      bookingItemId: bookingItemRef.id,
      bookingId: bookingRef.id,
      branchId: options.branchId,
      memberId: options.memberId,
      timing: options.timing,
      resourceId: primaryLane.resource_id,
      quantity: partySize,
      item,
    }));
  });
  writeLocks(transaction, selected.locks, {
    branchId: options.branchId,
    bookingId: bookingRef.id,
    memberId: options.memberId,
    resourceId: primaryLane.resource_id,
    status: options.lockStatus || options.bookingStatus,
    lockType: options.lockType || 'BOOKING',
    expiresAt,
  });

  return {
    bookingRef,
    booking: bookingPayload,
    booking_id: bookingRef.id,
    assigned_resource_id: primaryLane.resource_id,
    assigned_resource_ids: assignedResourceIds,
    assigned_lane_numbers: assignedLaneNumbers,
    expires_at: expiresAt,
  };
}

const createArcheryHold = httpFunction(async ({ db, data, actor }) => {
  assertNoClientLane(data);
  const branchId = normalizeBranchId(data.branch_id);
  const memberId = cleanString(data.member_id || actor?.uid, 160);
  requireMember(actor, memberId);
  const timing = normalizeTiming(data);
  const idempotencyKey = cleanString(data.idempotency_key || data.idempotencyKey, 180);
  const pricingConfig = await loadArcheryPricingConfig(null, db);
  const pricingPreview = calculateArcheryPricing(pricingConfig, timing, data);
  const partySize = normalizePartySize(pricingPreview);

  const result = await runIdempotentTransaction(db, {
    branchId,
    action: 'createArcheryHold',
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
      equipment_option_id: pricingPreview.equipment_option_id,
    },
  }, async transaction => {
    const created = await createArcheryBookingInTransaction(transaction, db, {
      branchId,
      memberId,
      source: 'ONLINE',
      timing,
      pricingConfig,
      pricingSelection: data,
      bookingStatus: 'HELD',
      paymentStatus: 'UNPAID',
      lockStatus: 'HELD',
      idempotencyKey,
      actorId: actor.uid,
      customerName: data.customer_name || data.customerName,
      customerPhone: data.customer_phone || data.customerPhone,
      customerEmail: data.customer_email || data.customerEmail,
      note: data.note,
    });
    return {
      booking_id: created.booking_id,
      branch_id: branchId,
      service_type: SERVICE_TYPE,
      booking_status: 'HELD',
      payment_status: 'UNPAID',
      booking_date: created.booking.booking_date,
      start_time: created.booking.start_time,
      end_time: created.booking.end_time,
      duration_minutes: created.booking.duration_minutes,
      package_code: created.booking.package_code,
      party_size: created.booking.party_size,
      required_lane_count: created.booking.required_lane_count,
      assigned_resource_ids: created.assigned_resource_ids,
      assigned_lane_numbers: created.assigned_lane_numbers,
      amount_total: created.booking.amount_total,
      package_amount: created.booking.package_amount,
      ability_option_id: created.booking.ability_option_id,
      ability_label: created.booking.ability_label,
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
      expires_at: created.expires_at.toDate().toISOString(),
      payment_required: true,
    };
  });

  return {
    replayed: result.replayed,
    ...result.response,
  };
}, {
  name: 'createArcheryHold',
  methods: ['POST'],
});

module.exports = {
  createArcheryHold,
  createArcheryBookingInTransaction,
  readMemberInTransaction,
  assertNoClientLane,
  buildBookingPayload,
  buildBookingItemPayload,
};
