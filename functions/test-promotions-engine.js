const assert = require('node:assert/strict');
const engine = require('./promotions/engine');

const SERVER_NOW = 'SERVER_TIMESTAMP';

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function transformValue(value, previous = 0) {
  if (value && typeof value === 'object') {
    if (value.constructor?.name === 'NumericIncrementTransform') {
      return Number(previous || 0) + Number(value.operand || 0);
    }
    if (value.constructor?.name === 'ServerTimestampTransform') {
      return SERVER_NOW;
    }
  }
  return clone(value);
}

function applyTransforms(next = {}, previous = {}) {
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => [key, transformValue(value, previous[key])])
  );
}

class FakeDocSnapshot {
  constructor(id, data) {
    this.id = id;
    this._data = data;
    this.exists = Boolean(data);
  }

  data() {
    return clone(this._data);
  }
}

class FakeQuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }

  forEach(callback) {
    this.docs.forEach(callback);
  }
}

class FakeDocRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.collectionName = collectionName;
    this.id = id;
  }
}

class FakeQuery {
  constructor(db, collectionName, clauses = []) {
    this.db = db;
    this.collectionName = collectionName;
    this.clauses = clauses;
  }

  where(field, operator, value) {
    if (operator !== '==') throw new Error(`Unsupported fake query operator: ${operator}`);
    return new FakeQuery(this.db, this.collectionName, [...this.clauses, { field, value }]);
  }
}

class FakeCollectionRef {
  constructor(db, collectionName) {
    this.db = db;
    this.collectionName = collectionName;
  }

  doc(id) {
    return new FakeDocRef(this.db, this.collectionName, id);
  }

  where(field, operator, value) {
    return new FakeQuery(this.db, this.collectionName, []).where(field, operator, value);
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
  }

  async get(target) {
    if (target instanceof FakeDocRef) {
      return new FakeDocSnapshot(target.id, this.db.readDoc(target.collectionName, target.id));
    }
    if (target instanceof FakeQuery) {
      const docs = this.db.query(target.collectionName, target.clauses)
        .map(({ id, data }) => new FakeDocSnapshot(id, data));
      return new FakeQuerySnapshot(docs);
    }
    throw new Error('Unsupported fake transaction get target');
  }

  set(ref, data, options = {}) {
    const previous = this.db.readDoc(ref.collectionName, ref.id) || {};
    const transformed = applyTransforms(data, previous);
    this.db.writeDoc(ref.collectionName, ref.id, options.merge ? { ...previous, ...transformed } : transformed);
  }

  update(ref, data) {
    const previous = this.db.readDoc(ref.collectionName, ref.id);
    if (!previous) throw new Error(`Missing fake doc for update: ${ref.collectionName}/${ref.id}`);
    this.db.writeDoc(ref.collectionName, ref.id, { ...previous, ...applyTransforms(data, previous) });
  }
}

class FakeFirestore {
  constructor(seed = {}) {
    this.store = new Map();
    Object.entries(seed).forEach(([collectionName, docs]) => {
      const collection = new Map();
      Object.entries(docs).forEach(([id, data]) => collection.set(id, clone(data)));
      this.store.set(collectionName, collection);
    });
  }

  collection(collectionName) {
    return new FakeCollectionRef(this, collectionName);
  }

  async runTransaction(callback) {
    return callback(new FakeTransaction(this));
  }

  readDoc(collectionName, id) {
    return clone(this.store.get(collectionName)?.get(id));
  }

  writeDoc(collectionName, id, data) {
    if (!this.store.has(collectionName)) this.store.set(collectionName, new Map());
    this.store.get(collectionName).set(id, clone(data));
  }

  query(collectionName, clauses = []) {
    return Array.from(this.store.get(collectionName)?.entries() || [])
      .filter(([, data]) => clauses.every(clause => data?.[clause.field] === clause.value))
      .map(([id, data]) => ({ id, data: clone(data) }));
  }
}

function expectApiError(code, fn) {
  assert.throws(fn, error => error?.code === code);
}

async function expectAsyncApiError(code, fn) {
  await assert.rejects(fn, error => error?.code === code);
}

function promotionSeed(overrides = {}) {
  return {
    'promo-coffee': {
      id: 'promo-coffee',
      name: 'Coffee 20',
      type: 'percent',
      value: 20,
      active: true,
      status: 'active',
      channels: ['POS', 'SHOP', 'ARCHERY'],
      targetType: 'limited',
      categoryIds: ['coffee'],
      productIds: [],
      variantIds: [],
      archeryItems: [],
      minSubtotal: 0,
      maxDiscount: 0,
      maxRedemptions: 0,
      maxPerCustomer: 0,
      startsAt: '',
      expiresAt: '',
      stackingPolicy: 'exclusive',
      primaryCode: 'COFFEE20',
      usedCount: 0,
      reservedCount: 0,
      ...overrides,
    },
  };
}

function codeSeed(overrides = {}) {
  return {
    COFFEE20: {
      id: 'COFFEE20',
      code: 'COFFEE20',
      promotionId: 'promo-coffee',
      active: true,
      status: 'active',
      channels: ['POS', 'SHOP', 'ARCHERY'],
      usedCount: 0,
      reservedCount: 0,
      maxRedemptions: 0,
      expiresAt: '',
      ...overrides,
    },
  };
}

async function run() {
  const application = engine.calculatePromotionApplication(engine.normalizePromotion('promo-coffee', promotionSeed()['promo-coffee']), {
    subtotal: 500,
    items: [
      { productId: 'latte', categoryId: 'coffee', lineTotal: 200 },
      { productId: 'cake', categoryId: 'bakery', lineTotal: 300 },
    ],
  });
  assert.equal(application.eligibleSubtotal, 200);
  assert.equal(application.discountAmount, 40);
  assert.equal(application.totalAfterDiscount, 460);
  assert.deepEqual(application.lineAllocations.map(row => [row.productId, row.discountAmount]), [['latte', 40]]);

  const capped = engine.calculatePromotionApplication(engine.normalizePromotion('promo-cap', {
    ...promotionSeed()['promo-coffee'],
    value: 50,
    maxDiscount: 60,
    categoryIds: [],
    targetType: 'all',
  }), { subtotal: 300 });
  assert.equal(capped.discountAmount, 60);

  expectApiError('PROMO_NOT_APPLICABLE', () => engine.calculatePromotionApplication(engine.normalizePromotion('promo-bakery', {
    ...promotionSeed()['promo-coffee'],
    categoryIds: ['bakery'],
  }), {
    subtotal: 200,
    items: [{ productId: 'latte', categoryId: 'coffee', lineTotal: 200 }],
  }));

  const validDb = new FakeFirestore({
    promotions: promotionSeed(),
    promotion_codes: codeSeed(),
    promotion_redemptions: {},
  });
  const valid = await engine.validatePromotion(validDb, {
    promo_code: 'COFFEE20',
    source_type: 'POS',
    subtotal: 500,
    items: [
      { productId: 'latte', categoryId: 'coffee', lineTotal: 200 },
      { productId: 'cake', categoryId: 'bakery', lineTotal: 300 },
    ],
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.channel, 'POS');
  assert.equal(valid.discountAmount, 40);

  const expiredDb = new FakeFirestore({
    promotions: promotionSeed({ expiresAt: '2020-01-01T00:00:00.000Z' }),
    promotion_codes: codeSeed(),
    promotion_redemptions: {},
  });
  await expectAsyncApiError('PROMO_EXPIRED', () => engine.validatePromotion(expiredDb, {
    promo_code: 'COFFEE20',
    source_type: 'POS',
    subtotal: 200,
    items: [{ categoryId: 'coffee', lineTotal: 200 }],
  }));

  const flowDb = new FakeFirestore({
    promotions: promotionSeed(),
    promotion_codes: codeSeed(),
    promotion_redemptions: {},
  });
  const reserved = await engine.reservePromotionRedemption(flowDb, {
    promo_code: 'COFFEE20',
    source_type: 'POS',
    source_id: 'receipt-1',
    subtotal: 200,
    items: [{ productId: 'latte', categoryId: 'coffee', lineTotal: 200 }],
  }, { audit: false, actor: { uid: 'cashier-1', role: 'CASHIER' } });
  assert.equal(reserved.status, 'reserved');
  assert.equal(flowDb.readDoc('promotions', 'promo-coffee').reservedCount, 1);
  const committed = await engine.commitPromotionRedemption(flowDb, {
    promo_code: 'COFFEE20',
    promotion_id: 'promo-coffee',
    source_type: 'POS',
    source_id: 'receipt-1',
  }, { audit: false });
  assert.equal(committed.status, 'redeemed');
  assert.equal(flowDb.readDoc('promotions', 'promo-coffee').reservedCount, 0);
  assert.equal(flowDb.readDoc('promotions', 'promo-coffee').usedCount, 1);

  await engine.reservePromotionRedemption(flowDb, {
    promo_code: 'COFFEE20',
    source_type: 'POS',
    source_id: 'receipt-2',
    subtotal: 200,
    items: [{ productId: 'latte', categoryId: 'coffee', lineTotal: 200 }],
  }, { audit: false, actor: { uid: 'cashier-1', role: 'CASHIER' } });
  const released = await engine.releasePromotionRedemption(flowDb, {
    promo_code: 'COFFEE20',
    promotion_id: 'promo-coffee',
    source_type: 'POS',
    source_id: 'receipt-2',
    reason: 'payment_failed',
  }, { audit: false });
  assert.equal(released.status, 'released');
  assert.equal(flowDb.readDoc('promotions', 'promo-coffee').reservedCount, 0);
  assert.equal(flowDb.readDoc('promotions', 'promo-coffee').usedCount, 1);

  const voucherDb = new FakeFirestore({
    gift_vouchers: {
      GV500: {
        id: 'GV500',
        code: 'GV500',
        initialAmount: 500,
        balance: 500,
        status: 'active',
        active: true,
        expiresAt: '',
      },
    },
    gift_voucher_ledger: {},
  });
  const voucher = await engine.validateGiftVoucher(voucherDb, {
    voucher_code: 'GV500',
    amount: 200,
  });
  assert.equal(voucher.amount, 200);
  assert.equal(voucher.balanceAfter, 300);
  const redeemed = await engine.redeemGiftVoucher(voucherDb, {
    voucher_code: 'GV500',
    source_type: 'POS',
    source_id: 'receipt-1',
    amount: 200,
    idempotency_key: 'receipt-1-voucher',
  }, { audit: false, actor: { uid: 'cashier-1' } });
  assert.equal(redeemed.amount, 200);
  assert.equal(redeemed.balanceAfter, 300);
  assert.equal(voucherDb.readDoc('gift_vouchers', 'GV500').balance, 300);
  const replayed = await engine.redeemGiftVoucher(voucherDb, {
    voucher_code: 'GV500',
    source_type: 'POS',
    source_id: 'receipt-1',
    amount: 200,
    idempotency_key: 'receipt-1-voucher',
  }, { audit: false, actor: { uid: 'cashier-1' } });
  assert.equal(replayed.replayed, true);
  assert.equal(voucherDb.readDoc('gift_vouchers', 'GV500').balance, 300);
  const refunded = await engine.refundGiftVoucher(voucherDb, {
    voucher_code: 'GV500',
    source_type: 'POS',
    source_id: 'refund-1',
    amount: 50,
    idempotency_key: 'refund-1-voucher',
  }, { audit: false, actor: { uid: 'manager-1' } });
  assert.equal(refunded.amount, 50);
  assert.equal(refunded.balanceAfter, 350);
  assert.equal(voucherDb.readDoc('gift_vouchers', 'GV500').balance, 350);
  await expectAsyncApiError('VOUCHER_REFUND_EXCEEDS_INITIAL_AMOUNT', () => engine.refundGiftVoucher(voucherDb, {
    voucher_code: 'GV500',
    source_type: 'POS',
    source_id: 'refund-2',
    amount: 200,
  }, { audit: false }));

  console.log('Promotion engine tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
