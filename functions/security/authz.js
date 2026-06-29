const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { apiError, cleanString, timestampToDate } = require('../shared/time');

const REGION = 'asia-southeast1';
const VALID_ROLES = new Set(['OWNER', 'MANAGER', 'ARCHERY_STAFF', 'CASHIER', 'CUSTOMER']);
const ADMIN_PERMISSION_FALLBACKS = {
  archery: ['bookings'],
};
const ALLOWED_ORIGINS = new Set([
  'https://edencafe.co',
  'https://www.edencafe.co',
  'https://edencafe-d9095.web.app',
  'https://edencafe-d9095.firebaseapp.com',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
  'http://localhost:3000',
  'http://localhost:5174',
  'http://localhost:5000',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5000',
]);

function setCors(req, res) {
  const origin = req.get('origin') || '';
  if (
    ALLOWED_ORIGINS.has(origin)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Eden-System-Key,X-Request-Id');
  res.set('Access-Control-Max-Age', '3600');
}

function requestData(req) {
  return req.method === 'GET' ? (req.query || {}) : (req.body || {});
}

function bearerToken(req) {
  const header = req.get('authorization') || req.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

async function verifyActor(req, db, options = {}) {
  const token = bearerToken(req);
  if (!token) {
    if (options.optional) return null;
    throw apiError('AUTH_REQUIRED', 401, 'Authentication is required');
  }

  const decoded = await admin.auth().verifyIdToken(token);
  const uid = decoded.uid;
  const [userSnap, adminSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('admin_users').doc(uid).get(),
  ]);
  const user = userSnap.exists ? userSnap.data() || {} : {};
  const adminUser = adminSnap.exists ? adminSnap.data() || {} : {};
  const role = resolveRole(decoded, user, adminUser);
  const branchIds = resolveBranchIds(decoded, user, adminUser);

  return {
    uid,
    email: decoded.email || user.email || adminUser.email || '',
    role,
    branch_ids: branchIds,
    is_staff: role !== 'CUSTOMER' || decoded.is_staff === true || user.is_staff === true,
    claims: decoded,
    user,
    admin_user: adminUser,
  };
}

function resolveRole(decoded = {}, user = {}, adminUser = {}) {
  if (decoded.is_owner === true || decoded.role === 'OWNER') return 'OWNER';
  const claimRole = cleanString(decoded.role, 40).toUpperCase();
  if (VALID_ROLES.has(claimRole)) return claimRole;
  const userRole = cleanString(user.role, 40).toUpperCase();
  if (VALID_ROLES.has(userRole)) return userRole;
  const legacyRole = cleanString(adminUser.role, 40).toLowerCase();
  if (legacyRole === 'owner') return 'OWNER';
  if (legacyRole === 'head_manager') return 'MANAGER';
  if (legacyRole === 'manager') {
    if (!adminUserHasPermission(adminUser, 'archery')) return 'CUSTOMER';
    const archeryRole = cleanString(adminUser.archery_role || adminUser.archeryRole, 40).toUpperCase();
    if (VALID_ROLES.has(archeryRole) && archeryRole !== 'CUSTOMER') return archeryRole;
    return 'MANAGER';
  }
  if (legacyRole === 'staff') return 'ARCHERY_STAFF';
  return 'CUSTOMER';
}

function adminUserHasPermission(adminUser = {}, permission = '') {
  if (!permission) return true;
  if (adminUser.status !== 'active') return false;
  const role = cleanString(adminUser.role, 40).toLowerCase();
  if (role === 'owner' || role === 'head_manager') return true;
  if (role !== 'manager') return false;
  if (adminUser.permissions && adminUser.permissions[permission] === true) return true;
  if (Object.prototype.hasOwnProperty.call(adminUser.permissions || {}, permission)) return false;
  return (ADMIN_PERMISSION_FALLBACKS[permission] || []).some(fallback => adminUser.permissions?.[fallback] === true);
}

function resolveBranchIds(decoded = {}, user = {}, adminUser = {}) {
  if (Array.isArray(decoded.branch_ids)) return decoded.branch_ids.map(String);
  if (Array.isArray(user.branch_ids)) return user.branch_ids.map(String);
  if (Array.isArray(adminUser.branch_ids)) return adminUser.branch_ids.map(String);
  if (user.primary_branch_id) return [String(user.primary_branch_id)];
  if (adminUser.primary_branch_id) return [String(adminUser.primary_branch_id)];
  return [];
}

function hasBranch(actor, branchId) {
  if (!actor) return false;
  if (actor.role === 'OWNER') return true;
  return Array.isArray(actor.branch_ids) && actor.branch_ids.includes(branchId);
}

function requireRoles(actor, roles, branchId = '') {
  if (!actor) throw apiError('AUTH_REQUIRED', 401, 'Authentication is required');
  if (!roles.includes(actor.role)) {
    throw apiError('STAFF_PERMISSION_REQUIRED', 403, 'Required role is missing');
  }
  if (branchId && !hasBranch(actor, branchId)) {
    throw apiError('STAFF_PERMISSION_REQUIRED', 403, 'Actor is not allowed for this branch');
  }
}

function requireMember(actor, memberId) {
  if (!actor) throw apiError('AUTH_REQUIRED', 401, 'Authentication is required');
  if (actor.uid !== memberId) {
    throw apiError('STAFF_PERMISSION_REQUIRED', 403, 'member_id does not match authenticated user');
  }
}

async function requireStaffSession(transaction, db, actor, branchId, staffSessionId) {
  requireRoles(actor, ['OWNER', 'MANAGER', 'ARCHERY_STAFF', 'CASHIER'], branchId);
  const sessionId = cleanString(staffSessionId, 180);
  if (!sessionId) throw apiError('STAFF_SESSION_REQUIRED', 401, 'staff_session_id is required');
  const ref = db.collection('staff_sessions').doc(sessionId);
  const snap = await transaction.get(ref);
  if (!snap.exists) throw apiError('STAFF_SESSION_REQUIRED', 401, 'staff session not found');
  const session = snap.data() || {};
  const expiresAt = timestampToDate(session.expires_at);
  if (
    session.staff_id !== actor.uid
    || session.branch_id !== branchId
    || cleanString(session.status, 30).toUpperCase() !== 'ACTIVE'
    || (expiresAt && expiresAt.getTime() <= Date.now())
  ) {
    throw apiError('STAFF_SESSION_REQUIRED', 401, 'staff session is not active');
  }
  return { ref, data: session };
}

function isTrustedSystemRequest(req) {
  const expected = process.env.PAYMENT_WEBHOOK_SECRET || process.env.EDEN_SYSTEM_KEY || '';
  const provided = req.get('x-eden-system-key') || '';
  return Boolean(expected && provided && provided === expected);
}

function systemActor() {
  return {
    uid: 'SYSTEM',
    role: 'SYSTEM',
    branch_ids: [],
    is_staff: false,
    system: true,
  };
}

function sendError(res, error) {
  const status = error.statusCode || error.status || 500;
  const code = error.code || (status === 409 ? 'CONFLICT' : 'INTERNAL');
  res.status(status).json({
    ok: false,
    error: code,
    code,
    message: status >= 500 ? 'Internal server error' : error.message,
    details: status >= 500 ? undefined : error.details,
  });
}

function httpFunction(handler, options = {}) {
  const methods = options.methods || ['POST'];
  return onRequest({ region: REGION, secrets: options.secrets || [] }, async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (!methods.includes(req.method)) {
      res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED', code: 'METHOD_NOT_ALLOWED' });
      return;
    }

    const db = admin.firestore();
    try {
      const actor = await verifyActor(req, db, { optional: options.optionalAuth === true });
      const result = await handler({
        req,
        res,
        db,
        data: requestData(req),
        actor,
        requestId: cleanString(req.get('x-request-id') || req.get('x-cloud-trace-context') || '', 120),
      });
      if (!res.headersSent) res.status(options.successStatus || 200).json({ ok: true, ...result });
    } catch (error) {
      logger.warn('Eden Archery function failed', {
        function: options.name || 'unknown',
        code: error.code || '',
        status: error.statusCode || 500,
        error_message: error.message,
      });
      sendError(res, error);
    }
  });
}

module.exports = {
  REGION,
  httpFunction,
  verifyActor,
  requireRoles,
  requireMember,
  requireStaffSession,
  hasBranch,
  isTrustedSystemRequest,
  systemActor,
  sendError,
};
