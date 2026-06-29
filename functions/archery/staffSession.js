const admin = require('firebase-admin');
const { httpFunction, requireRoles } = require('../security/authz');
const { apiError, cleanString, normalizeBranchId } = require('../shared/time');

const SESSION_HOURS = 12;

const createSessionId = (actorUid) => {
  const random = Math.random().toString(36).slice(2, 12);
  return `archery-pos-${actorUid}-${Date.now()}-${random}`.replace(/[^a-zA-Z0-9_-]/g, '-');
};

const startArcheryStaffSession = httpFunction(async ({ db, data, actor }) => {
  const branchId = normalizeBranchId(data.branch_id || data.branchId);
  requireRoles(actor, ['OWNER', 'MANAGER', 'ARCHERY_STAFF', 'CASHIER'], branchId);

  const requestedId = cleanString(data.staff_session_id || data.staffSessionId, 180);
  const sessionId = requestedId || createSessionId(actor.uid);
  if (!sessionId) {
    throw apiError('STAFF_SESSION_REQUIRED', 400, 'staff_session_id is required');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);
  const sessionRef = db.collection('staff_sessions').doc(sessionId);
  await sessionRef.set({
    staff_session_id: sessionId,
    staff_id: actor.uid,
    staff_email: actor.email || '',
    role: actor.role || '',
    branch_id: branchId,
    status: 'ACTIVE',
    source: 'ARCHERY_POS',
    started_at: admin.firestore.Timestamp.fromDate(now),
    last_seen_at: admin.firestore.FieldValue.serverTimestamp(),
    expires_at: admin.firestore.Timestamp.fromDate(expiresAt),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    staff_session_id: sessionId,
    branch_id: branchId,
    status: 'ACTIVE',
    expires_at: expiresAt.toISOString(),
  };
}, {
  name: 'startArcheryStaffSession',
  methods: ['POST'],
});

module.exports = {
  startArcheryStaffSession,
};
