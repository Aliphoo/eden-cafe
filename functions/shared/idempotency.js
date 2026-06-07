const crypto = require('crypto');
const { FieldValue, Timestamp } = require('./firestore');
const { apiError, cleanString } = require('./time');

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function idempotencyDocId(branchId, action, idempotencyKey) {
  return `${cleanString(branchId, 80)}_${cleanString(action, 80)}_${sha256(idempotencyKey).slice(0, 40)}`;
}

async function runIdempotentTransaction(db, options, executor) {
  const branchId = cleanString(options.branchId, 80);
  const action = cleanString(options.action, 80);
  const idempotencyKey = cleanString(options.idempotencyKey, 180);
  if (!branchId || !action || !idempotencyKey) {
    throw apiError('IDEMPOTENCY_KEY_REQUIRED', 400, 'idempotency_key is required');
  }

  const payloadHash = sha256(stableStringify(options.payload || {}));
  const idempotencyRef = db.collection('idempotency_keys').doc(idempotencyDocId(branchId, action, idempotencyKey));

  return db.runTransaction(async transaction => {
    const idempotencySnap = await transaction.get(idempotencyRef);
    if (idempotencySnap.exists) {
      const data = idempotencySnap.data() || {};
      if (data.payload_hash !== payloadHash) {
        throw apiError('IDEMPOTENCY_PAYLOAD_MISMATCH', 409, 'idempotency_key was reused with a different payload');
      }
      return {
        replayed: true,
        response: data.response || null,
      };
    }

    const response = await executor(transaction);
    transaction.set(idempotencyRef, {
      branch_id: branchId,
      action,
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      response: response || null,
      actor_id: cleanString(options.actorId, 160),
      created_at: FieldValue.serverTimestamp(),
      expires_at: Timestamp.fromMillis(Date.now() + (24 * 60 * 60 * 1000)),
    });
    return { replayed: false, response };
  });
}

module.exports = {
  sha256,
  stableStringify,
  runIdempotentTransaction,
};
