const { FieldValue } = require('./firestore');
const { cleanString } = require('./time');

function compactSnapshot(value) {
  if (!value || typeof value !== 'object') return value || null;
  const allowed = [
    'booking_id',
    'order_id',
    'branch_id',
    'service_type',
    'source_type',
    'source_id',
    'member_id',
    'booking_status',
    'status',
    'payment_status',
    'payment_id',
    'refund_request_id',
    'refund_id',
    'refund_status',
    'receipt_id',
    'promotion_id',
    'promotionId',
    'promo_code',
    'promoCode',
    'code',
    'voucher_id',
    'voucherId',
    'discount_amount',
    'discountAmount',
    'initial_amount',
    'initialAmount',
    'balance',
    'balance_before',
    'balanceBefore',
    'balance_after',
    'balanceAfter',
    'amount',
    'channels',
    'target_type',
    'targetType',
    'category_ids',
    'categoryIds',
    'product_ids',
    'productIds',
    'variant_ids',
    'variantIds',
    'archery_items',
    'archeryItems',
    'assigned_resource_id',
    'resource_id',
    'start_time',
    'end_time',
    'duration_minutes',
    'refund_required',
    'cancel_requested',
  ];
  return allowed.reduce((snapshot, key) => {
    if (Object.prototype.hasOwnProperty.call(value, key)) snapshot[key] = value[key];
    return snapshot;
  }, {});
}

function writeAuditLog(transaction, db, options = {}) {
  const ref = db.collection('audit_logs').doc();
  const actor = options.actor || {};
  transaction.set(ref, {
    audit_log_id: ref.id,
    branch_id: cleanString(options.branchId, 80),
    actor_id: cleanString(actor.uid || options.actorId || '', 160),
    actor_role: cleanString(actor.role || options.actorRole || '', 60),
    actor_type: cleanString(options.actorType || actor.actorType || (actor.system ? 'SYSTEM' : 'STAFF'), 40),
    staff_session_id: cleanString(options.staffSessionId || '', 180),
    action: cleanString(options.action, 120),
    target_collection: cleanString(options.targetCollection, 80),
    target_id: cleanString(options.targetId, 180),
    before_snapshot: compactSnapshot(options.before),
    after_snapshot: compactSnapshot(options.after),
    reason: cleanString(options.reason, 500),
    request_id: cleanString(options.requestId, 120),
    created_at: FieldValue.serverTimestamp(),
  });
  return ref;
}

module.exports = {
  writeAuditLog,
};
