const assert = require('node:assert/strict');
const { Timestamp } = require('./shared/firestore');
const archeryLoyalty = require('./archery/loyaltyRedemption');

function clone(value) {
  if (value === undefined) return undefined;
  if (value && typeof value.toDate === 'function') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(item => clone(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function isIncrement(value) {
  return value && typeof value === 'object' && value.constructor?.name === 'NumericIncrementTransform';
}

function isServerTimestamp(value) {
  return value && typeof value === 'object' && value.constructor?.name === 'ServerTimestampTransform';
}

function applyField(current, value) {
  if (isIncrement(value)) return (Number(current) || 0) + Number(value.operand || 0);
  if (isServerTimestamp(value)) return new Date().toISOString();
  return clone(value);
}

function applyPatch(target, data = {}) {
  const next = { ...(target || {}) };
  Object.entries(data).forEach(([key, value]) => {
    next[key] = applyField(next[key], value);
  });
  return next;
}

class FakeDocSnap {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this._data = data;
    this.exists = data !== undefined;
  }

  data() {
    return clone(this._data);
  }
}

class FakeQuerySnap {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
    this.size = docs.length;
  }
}

class FakeDocRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.collectionName = collectionName;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }
}

class FakeQuery {
  constructor(collectionRef, filters = [], limitValue = 0) {
    this.collectionRef = collectionRef;
    this.filters = filters;
    this.limitValue = limitValue;
  }

  where(field, op, value) {
    return new FakeQuery(this.collectionRef, [...this.filters, { field, op, value }], this.limitValue);
  }

  limit(value) {
    return new FakeQuery(this.collectionRef, this.filters, Number(value) || 0);
  }
}

class FakeCollection {
  constructor(db, name) {
    this.db = db;
    this.name = name;
  }

  doc(id) {
    return new FakeDocRef(this.db, this.name, id);
  }

  where(field, op, value) {
    return new FakeQuery(this, [{ field, op, value }]);
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
  }

  async get(refOrQuery) {
    if (refOrQuery instanceof FakeQuery) {
      let docs = Array.from(this.db.store.entries())
        .filter(([path]) => path.startsWith(`${refOrQuery.collectionRef.name}/`))
        .map(([path, data]) => {
          const id = path.slice(refOrQuery.collectionRef.name.length + 1);
          return new FakeDocSnap(new FakeDocRef(this.db, refOrQuery.collectionRef.name, id), data);
        })
        .filter(docSnap => refOrQuery.filters.every(filter => {
          if (filter.op !== '==') throw new Error(`Unsupported filter op ${filter.op}`);
          return docSnap.data()?.[filter.field] === filter.value;
        }));
      if (refOrQuery.limitValue > 0) docs = docs.slice(0, refOrQuery.limitValue);
      return new FakeQuerySnap(docs);
    }
    return new FakeDocSnap(refOrQuery, this.db.store.get(refOrQuery.path));
  }

  set(ref, data, options = {}) {
    const current = this.db.store.get(ref.path);
    this.db.store.set(ref.path, options.merge ? applyPatch(current, data) : applyPatch({}, data));
  }

  update(ref, data) {
    const current = this.db.store.get(ref.path);
    if (!current) throw new Error(`Missing document ${ref.path}`);
    this.db.store.set(ref.path, applyPatch(current, data));
  }
}

class FakeDb {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed).map(([path, data]) => [path, clone(data)]));
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  async runTransaction(callback) {
    return callback(new FakeTransaction(this));
  }

  data(path) {
    return this.store.get(path);
  }
}

function seedDb(overrides = {}) {
  return new FakeDb({
    'site_settings/loyalty': {
      enabled: true,
      spendPerPoint: 25,
      pointValue: 1,
      maxRedeemPercent: 30,
      minRedeemPoints: 20,
      earnAfterDiscount: true,
      earnOnRedeemedAmount: false,
      tierMultipliers: { Silver: 1, Gold: 1.25, Platinum: 1.5 },
      membershipTiers: {
        Silver: { minPoints: 0, minTotalSpent: 0 },
        Gold: { minPoints: 1200, minTotalSpent: 15000 },
        Platinum: { minPoints: 5000, minTotalSpent: 50000 },
      },
    },
    'users/member-1': {
      displayName: 'Mali',
      email: 'mali@example.test',
      memberCode: 'E001',
      points: 100,
      totalSpent: 1000,
      tier: 'Silver',
    },
    'member_summaries/member-1': {
      userId: 'member-1',
      memberName: 'Mali',
      memberEmail: 'mali@example.test',
      memberCode: 'E001',
      pointsBalance: 100,
      reservedPoints: 10,
      totalSpent: 1000,
      lifetimePoints: 100,
      totalRedeemed: 0,
      tier: 'Silver',
    },
    'bookings/booking-1': {
      booking_id: 'booking-1',
      branch_id: 'main',
      service_type: 'ARCHERY',
      member_id: 'member-1',
      booking_status: 'HELD',
      status: 'HELD',
      payment_status: 'UNPAID',
      amount_total: 200,
      totalAmount: 200,
      package_code: 'ARCHERY_60',
      expires_at: Timestamp.fromMillis(Date.now() + 10 * 60_000),
      booking_items: [
        { item_type: 'PACKAGE', label: 'Archery 60 min', quantity: 1, unit_amount: 200, amount: 200 },
      ],
      amount_breakdown: { total: 200 },
    },
    ...overrides,
  });
}

async function reserveBookingPoints(db, points = 60, bookingId = 'booking-1') {
  return db.runTransaction(transaction => archeryLoyalty.reserveArcheryLoyaltyForBookingInTransaction(transaction, db, {
    branch_id: 'main',
    booking_id: bookingId,
    redeemed_points: points,
    idempotency_key: `${bookingId}-loyalty-${points}`,
  }, {
    actor: { uid: 'member-1', role: 'CUSTOMER', email: 'mali@example.test' },
  }));
}

async function testReserveAdjustsBookingPayable() {
  const db = seedDb();
  const result = await reserveBookingPoints(db, 60);
  const booking = db.data('bookings/booking-1');
  assert.equal(result.amount_total, 140);
  assert.equal(result.total_before_loyalty, 200);
  assert.equal(result.loyalty_discount, 60);
  assert.equal(result.redeemed_points, 60);
  assert.equal(result.loyalty_status, 'reserved');
  assert.equal(booking.amount_total, 140);
  assert.equal(booking.payment_required, true);
  assert.equal(booking.loyalty_reservation_id, result.loyalty_reservation_id);
  assert.equal(db.data('member_summaries/member-1').reservedPoints, 70);
}

async function testCommitReservedBookingPoints() {
  const db = seedDb();
  const reservation = await reserveBookingPoints(db, 60);
  const commit = await archeryLoyalty.commitArcheryLoyaltyForBooking(db, {
    branchId: 'main',
    bookingId: 'booking-1',
    paymentId: 'pay-1',
    actor: { uid: 'BEAM_WEBHOOK', role: 'SYSTEM', system: true },
  });
  const booking = db.data('bookings/booking-1');
  assert.equal(commit.status, 'redeemed');
  assert.equal(commit.redeemedPoints, 60);
  assert.equal(db.data('users/member-1').points, 40);
  assert.equal(db.data('member_summaries/member-1').pointsBalance, 40);
  assert.equal(db.data('member_summaries/member-1').reservedPoints, 10);
  assert.equal(db.data(`point_ledger/${commit.ledgerId}`).type, 'archery_redeem');
  assert.equal(booking.loyalty_status, 'redeemed');
  assert.equal(booking.loyalty_reservation_id, reservation.loyalty_reservation_id);
}

async function testReleaseReservedBookingPoints() {
  const db = seedDb();
  await reserveBookingPoints(db, 20);
  const release = await archeryLoyalty.releaseArcheryLoyaltyForBooking(db, {
    branchId: 'main',
    bookingId: 'booking-1',
    reason: 'payment-cancelled',
    actor: { uid: 'BEAM_WEBHOOK', role: 'SYSTEM', system: true },
  });
  const booking = db.data('bookings/booking-1');
  assert.equal(release.status, 'released');
  assert.equal(db.data('member_summaries/member-1').reservedPoints, 10);
  assert.equal(booking.loyalty_status, 'released');
  assert.equal(booking.loyalty_release_reason, 'payment-cancelled');
}

async function run() {
  await testReserveAdjustsBookingPayable();
  await testCommitReservedBookingPoints();
  await testReleaseReservedBookingPoints();
  console.log('archery loyalty redemption tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
