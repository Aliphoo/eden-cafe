const { FieldValue } = require('./firestore');
const { sha256 } = require('./idempotency');
const {
  SERVICE_TYPE,
  RESOURCE_TYPE_ID,
  apiError,
  cleanString,
  timestampToDate,
} = require('./time');

const ACTIVE_LOCK_STATUSES = new Set(['HELD', 'CONFIRMED', 'CHECKED_IN']);

function laneNumberFromValue(value) {
  const text = cleanString(value, 120).toUpperCase();
  const match = text.match(/(?:LANE[_\s-]?|_)(\d{1,2})$/) || text.match(/(\d{1,2})/);
  if (!match) return 999;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : 999;
}

function isLaneResource(docSnap) {
  const data = docSnap.data() || {};
  const status = cleanString(data.status || 'ACTIVE', 30).toUpperCase();
  if (['INACTIVE', 'DISABLED', 'DELETED'].includes(status)) return false;
  return data.service_type === SERVICE_TYPE
    || data.resource_type_id === RESOURCE_TYPE_ID
    || cleanString(data.type, 60).toUpperCase() === RESOURCE_TYPE_ID
    || cleanString(data.code || docSnap.id, 120).toUpperCase().includes('LANE');
}

function normalizeLaneResource(docSnap) {
  const data = docSnap.data() || {};
  const resourceId = cleanString(data.resource_id || data.id || docSnap.id, 160);
  return {
    resource_id: resourceId,
    doc_id: docSnap.id,
    name: cleanString(data.name || data.label || resourceId, 120),
    code: cleanString(data.code || resourceId, 80),
    sort_order: Number(data.sort_order || data.lane_number || laneNumberFromValue(data.code || resourceId)) || 999,
    raw: data,
  };
}

async function loadLaneResources(db, branchId, transaction = null) {
  const query = db.collection('resources').where('branch_id', '==', branchId);
  const snap = transaction ? await transaction.get(query) : await query.get();
  const lanes = [];
  snap.forEach(docSnap => {
    if (isLaneResource(docSnap)) lanes.push(normalizeLaneResource(docSnap));
  });
  lanes.sort((a, b) => a.sort_order - b.sort_order || a.resource_id.localeCompare(b.resource_id));
  return lanes.slice(0, 10);
}

function lockDocId(branchId, resourceId, slotKey) {
  return `lock_${sha256(`${branchId}|${resourceId}|${slotKey}`).slice(0, 48)}`;
}

function lockRef(db, branchId, resourceId, slotKey) {
  return db.collection('resource_locks').doc(lockDocId(branchId, resourceId, slotKey));
}

function isActiveLock(data = {}, now = new Date()) {
  const status = cleanString(data.lock_status || data.status, 40).toUpperCase();
  if (!ACTIVE_LOCK_STATUSES.has(status)) return false;
  if (status === 'HELD') {
    const expiresAt = timestampToDate(data.expires_at || data.hold_expires_at || data.holdExpiresAt);
    return !expiresAt || expiresAt.getTime() > now.getTime();
  }
  return true;
}

async function readSlotLocks(transaction, db, branchId, resourceId, slotKeys) {
  const refs = slotKeys.map(slotKey => ({
    slot_key: slotKey,
    ref: lockRef(db, branchId, resourceId, slotKey),
  }));
  const snaps = await Promise.all(refs.map(lock => transaction.get(lock.ref)));
  return refs.map((lock, index) => ({
    ...lock,
    snap: snaps[index],
    data: snaps[index].exists ? snaps[index].data() || {} : null,
  }));
}

async function readSlotLocksOutsideTransaction(db, branchId, resourceId, slotKeys) {
  const refs = slotKeys.map(slotKey => ({
    slot_key: slotKey,
    ref: lockRef(db, branchId, resourceId, slotKey),
  }));
  const snaps = await db.getAll(...refs.map(lock => lock.ref));
  return refs.map((lock, index) => ({
    ...lock,
    snap: snaps[index],
    data: snaps[index].exists ? snaps[index].data() || {} : null,
  }));
}

async function findAvailableLane(transaction, db, branchId, slotKeys) {
  const selected = await findAvailableLanes(transaction, db, branchId, slotKeys, 1);
  return { lane: selected.lanes[0], locks: selected.locks };
}

async function findAvailableLanes(transaction, db, branchId, slotKeys, requiredCount = 1) {
  const count = Math.floor(Number(requiredCount || 1) || 1);
  if (count < 1 || count > 10) {
    throw apiError('INVALID_PARTY_SIZE', 400, 'party_size must be an integer from 1 to 10');
  }
  const lanes = await loadLaneResources(db, branchId, transaction);
  if (!lanes.length) {
    throw apiError('NO_LANE_AVAILABLE', 409, 'No active archery lanes are configured for this branch');
  }

  const now = new Date();
  const selectedLanes = [];
  const selectedLocks = [];
  for (const lane of lanes) {
    const locks = await readSlotLocks(transaction, db, branchId, lane.resource_id, slotKeys);
    const conflict = locks.find(lock => lock.snap.exists && isActiveLock(lock.data, now));
    if (!conflict) {
      selectedLanes.push(lane);
      selectedLocks.push(...locks.map(lock => ({ ...lock, resource_id: lane.resource_id })));
      if (selectedLanes.length >= count) {
        return { lanes: selectedLanes, locks: selectedLocks };
      }
    }
  }
  throw apiError('NO_LANE_AVAILABLE', 409, 'Not enough lanes are available for the requested time');
}

async function assertResourceAvailable(transaction, db, branchId, resourceId, slotKeys, allowedBookingId = '') {
  const locks = await readSlotLocks(transaction, db, branchId, resourceId, slotKeys);
  const now = new Date();
  const conflict = locks.find(lock => {
    if (!lock.snap.exists || !isActiveLock(lock.data, now)) return false;
    return cleanString(lock.data.booking_id, 180) !== allowedBookingId;
  });
  if (conflict) throw apiError('ACTIVE_LOCK_EXISTS', 409, 'Requested resource has an active lock');
  return locks;
}

function writeLocks(transaction, lockEntries, options = {}) {
  const now = FieldValue.serverTimestamp();
  lockEntries.forEach(lock => {
    const resourceId = cleanString(lock.resource_id || options.resourceId, 180);
    transaction.set(lock.ref, {
      lock_id: lock.ref.id,
      branch_id: options.branchId,
      booking_id: options.bookingId,
      member_id: options.memberId,
      service_type: SERVICE_TYPE,
      resource_type_id: RESOURCE_TYPE_ID,
      resource_id: resourceId,
      assigned_resource_id: resourceId,
      slot_key: lock.slot_key,
      lock_status: options.status,
      status: options.status,
      lock_type: options.lockType || 'BOOKING',
      expires_at: options.expiresAt || null,
      hold_expires_at: options.status === 'HELD' ? options.expiresAt || null : null,
      released_at: null,
      updated_at: now,
      created_at: now,
    }, { merge: true });
  });
}

async function queryLocksForBooking(transaction, db, branchId, bookingId) {
  const query = db.collection('resource_locks')
    .where('branch_id', '==', branchId)
    .where('booking_id', '==', bookingId);
  return transaction.get(query);
}

async function updateLocksForBooking(transaction, db, branchId, bookingId, updates = {}) {
  const snap = await queryLocksForBooking(transaction, db, branchId, bookingId);
  snap.forEach(docSnap => {
    transaction.set(docSnap.ref, {
      ...updates,
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return snap.size;
}

async function releaseLocksForBooking(transaction, db, branchId, bookingId, options = {}) {
  return updateLocksForBooking(transaction, db, branchId, bookingId, {
    lock_status: 'RELEASED',
    status: 'RELEASED',
    released_at: FieldValue.serverTimestamp(),
    released_by: cleanString(options.actorId, 160),
    release_reason: cleanString(options.reason, 300),
  });
}

module.exports = {
  ACTIVE_LOCK_STATUSES,
  loadLaneResources,
  readSlotLocksOutsideTransaction,
  findAvailableLane,
  findAvailableLanes,
  assertResourceAvailable,
  writeLocks,
  queryLocksForBooking,
  updateLocksForBooking,
  releaseLocksForBooking,
  isActiveLock,
  lockRef,
  lockDocId,
};
