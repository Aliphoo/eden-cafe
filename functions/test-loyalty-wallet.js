const assert = require('node:assert/strict');
const { Timestamp } = require('./shared/firestore');
const loyaltyWallet = require('./loyaltyWallet');

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
      visitCount: 4,
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
    ...overrides,
  });
}

async function testQuoteRespectsPercentAndReservedBalance() {
  const db = seedDb();
  const quote = await loyaltyWallet.quoteLoyaltyRedemption(db, {
    member_id: 'member-1',
    source_type: 'SHOP_ORDER',
    source_id: 'order-1',
    totalBeforeLoyalty: 200,
    redeemableAmount: 200,
    redeemedPoints: 60,
    items: [{ productId: 'coffee', name: 'Coffee', quantity: 4, unitPrice: 50 }],
  });
  assert.equal(quote.availablePoints, 90);
  assert.equal(quote.maxRedeemablePoints, 60);
  assert.equal(quote.redeemedPoints, 60);
  assert.equal(quote.loyaltyDiscount, 60);

  const blocked = await loyaltyWallet.quoteLoyaltyRedemption(db, {
    member_id: 'member-1',
    source_type: 'SHOP_ORDER',
    source_id: 'order-1',
    totalBeforeLoyalty: 200,
    redeemableAmount: 200,
    redeemedPoints: 80,
    items: [{ productId: 'coffee', name: 'Coffee', quantity: 4, unitPrice: 50 }],
  });
  assert.equal(blocked.blockedReason, 'exceeds-max-redeem-percent');
  assert.equal(blocked.redeemedPoints, 0);
}

async function testReserveCommitAndRelease() {
  const db = seedDb();
  const reservation = await loyaltyWallet.reserveLoyaltyRedemption(db, {
    member_id: 'member-1',
    source_type: 'SHOP_ORDER',
    source_id: 'order-1',
    idempotency_key: 'checkout-1',
    totalBeforeLoyalty: 200,
    redeemableAmount: 200,
    redeemedPoints: 60,
    items: [{ productId: 'coffee', name: 'Coffee', quantity: 4, unitPrice: 50 }],
  }, { actor: { uid: 'member-1', email: 'mali@example.test' } });
  assert.equal(reservation.status, 'reserved');
  assert.equal(db.data('member_summaries/member-1').reservedPoints, 70);

  const replay = await loyaltyWallet.reserveLoyaltyRedemption(db, {
    member_id: 'member-1',
    source_type: 'SHOP_ORDER',
    source_id: 'order-1',
    idempotency_key: 'checkout-1',
    totalBeforeLoyalty: 200,
    redeemableAmount: 200,
    redeemedPoints: 60,
    items: [{ productId: 'coffee', name: 'Coffee', quantity: 4, unitPrice: 50 }],
  });
  assert.equal(replay.replayed, true);
  assert.equal(db.data('member_summaries/member-1').reservedPoints, 70);

  const commit = await loyaltyWallet.commitLoyaltyReservation(db, {
    reservation_id: reservation.reservationId,
    payment_id: 'payment-1',
  }, { actor: { uid: 'SYSTEM', email: '' } });
  assert.equal(commit.status, 'redeemed');
  assert.equal(commit.redeemedPoints, 60);
  assert.equal(commit.pointsBefore, 100);
  assert.equal(commit.pointsAfter, 40);
  assert.equal(db.data('users/member-1').points, 40);
  assert.equal(db.data('member_summaries/member-1').pointsBalance, 40);
  assert.equal(db.data('member_summaries/member-1').reservedPoints, 10);
  assert.equal(db.data(`point_ledger/${commit.ledgerId}`).type, 'shop_redeem');

  const releaseDb = seedDb();
  const releaseReservation = await loyaltyWallet.reserveLoyaltyRedemption(releaseDb, {
    member_id: 'member-1',
    source_type: 'ARCHERY_BOOKING',
    source_id: 'booking-1',
    idempotency_key: 'hold-1',
    totalBeforeLoyalty: 100,
    redeemableAmount: 100,
    redeemedPoints: 20,
    items: [{ productId: 'archery', name: 'Archery', quantity: 1, unitPrice: 100 }],
  });
  assert.equal(releaseDb.data('member_summaries/member-1').reservedPoints, 30);
  const release = await loyaltyWallet.releaseLoyaltyReservation(releaseDb, {
    reservation_id: releaseReservation.reservationId,
    member_id: 'member-1',
    reason: 'payment-cancelled',
  });
  assert.equal(release.status, 'released');
  assert.equal(releaseDb.data('member_summaries/member-1').reservedPoints, 10);
}

async function testExpiredReservationsAreReleasedDuringReserve() {
  const expiredId = loyaltyWallet.reservationDocId('member-1', 'SHOP_ORDER', 'old-order', 'old-key');
  const sameKeyExpiredId = loyaltyWallet.reservationDocId('member-1', 'SHOP_ORDER', 'same-order', 'same-key');
  const db = seedDb({
    [`loyalty_reservations/${expiredId}`]: {
      id: expiredId,
      reservationId: expiredId,
      status: 'reserved',
      memberId: 'member-1',
      sourceType: 'SHOP_ORDER',
      sourceId: 'old-order',
      redeemedPoints: 15,
      loyaltyDiscount: 15,
      reservationExpiresAt: Timestamp.fromMillis(Date.now() - 60_000),
    },
    [`loyalty_reservations/${sameKeyExpiredId}`]: {
      id: sameKeyExpiredId,
      reservationId: sameKeyExpiredId,
      status: 'reserved',
      memberId: 'member-1',
      sourceType: 'SHOP_ORDER',
      sourceId: 'same-order',
      redeemedPoints: 20,
      loyaltyDiscount: 20,
      reservationExpiresAt: Timestamp.fromMillis(Date.now() - 60_000),
    },
    'member_summaries/member-1': {
      userId: 'member-1',
      pointsBalance: 100,
      reservedPoints: 45,
      totalSpent: 1000,
      lifetimePoints: 100,
      totalRedeemed: 0,
      tier: 'Silver',
    },
  });
  const newReservation = await loyaltyWallet.reserveLoyaltyRedemption(db, {
    member_id: 'member-1',
    source_type: 'SHOP_ORDER',
    source_id: 'new-order',
    idempotency_key: 'new-key',
    totalBeforeLoyalty: 100,
    redeemableAmount: 100,
    redeemedPoints: 20,
    items: [{ productId: 'tea', name: 'Tea', quantity: 2, unitPrice: 50 }],
  });
  assert.equal(newReservation.replayed, false);
  assert.equal(db.data(`loyalty_reservations/${expiredId}`).status, 'expired');
  assert.equal(db.data('member_summaries/member-1').reservedPoints, 30);

  const sameKeyReplay = await loyaltyWallet.reserveLoyaltyRedemption(db, {
    member_id: 'member-1',
    source_type: 'SHOP_ORDER',
    source_id: 'same-order',
    idempotency_key: 'same-key',
    totalBeforeLoyalty: 100,
    redeemableAmount: 100,
    redeemedPoints: 20,
    items: [{ productId: 'cake', name: 'Cake', quantity: 1, unitPrice: 100 }],
  });
  assert.equal(sameKeyReplay.replayed, false);
  assert.equal(db.data(`loyalty_reservations/${sameKeyExpiredId}`).status, 'reserved');
  assert.equal(db.data('member_summaries/member-1').reservedPoints, 50);
}

async function run() {
  await testQuoteRespectsPercentAndReservedBalance();
  await testReserveCommitAndRelease();
  await testExpiredReservationsAreReleasedDuringReserve();
  console.log('loyalty wallet tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
