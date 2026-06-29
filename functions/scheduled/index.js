const admin = require('firebase-admin');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { writeAuditLog } = require('../shared/audit');
const { FieldValue, Timestamp } = require('../shared/firestore');
const { SERVICE_TYPE, timestampToDate } = require('../shared/time');
const { queryLocksForBooking } = require('../shared/locks');
const {
  releaseArcheryPromotionApplications,
  archeryPromotionStatusUpdate,
} = require('../archery/promotions');

const expireOldHolds = onSchedule(
  {
    region: 'asia-southeast1',
    schedule: 'every 5 minutes',
    timeZone: 'Asia/Bangkok',
  },
  async () => {
    const db = admin.firestore();
    const now = Timestamp.now();
    const snap = await db.collection('bookings')
      .where('service_type', '==', SERVICE_TYPE)
      .where('booking_status', '==', 'HELD')
      .where('expires_at', '<', now)
      .limit(100)
      .get();

    let expiredCount = 0;
    let releasedLockCount = 0;
    for (const docSnap of snap.docs) {
      await db.runTransaction(async transaction => {
        const bookingRef = docSnap.ref;
        const freshSnap = await transaction.get(bookingRef);
        if (!freshSnap.exists) return;
        const booking = freshSnap.data() || {};
        const status = String(booking.booking_status || booking.status || '').toUpperCase();
        const expiresAt = timestampToDate(booking.expires_at);
        if (status !== 'HELD' || !expiresAt || expiresAt.getTime() >= Date.now()) return;

        const locksSnap = await queryLocksForBooking(transaction, db, booking.branch_id, bookingRef.id);
        await releaseArcheryPromotionApplications(transaction, db, {
          branchId: booking.branch_id,
          bookingId: bookingRef.id,
          booking,
          reason: 'HOLD_EXPIRED',
          actor: { uid: 'SYSTEM', role: 'SYSTEM', system: true },
        });
        locksSnap.forEach(lockSnap => {
          transaction.set(lockSnap.ref, {
            lock_status: 'RELEASED',
            status: 'RELEASED',
            released_at: FieldValue.serverTimestamp(),
            released_by: 'SYSTEM',
            release_reason: 'HOLD_EXPIRED',
            updated_at: FieldValue.serverTimestamp(),
          }, { merge: true });
        });
        transaction.update(bookingRef, {
          booking_status: 'EXPIRED',
          status: 'EXPIRED',
          expired_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
          ...archeryPromotionStatusUpdate(booking, 'released', { reason: 'HOLD_EXPIRED' }),
        });
        writeAuditLog(transaction, db, {
          branchId: booking.branch_id,
          actor: { uid: 'SYSTEM', role: 'SYSTEM', system: true },
          actorType: 'SYSTEM',
          action: 'expireOldHolds',
          targetCollection: 'bookings',
          targetId: bookingRef.id,
          before: booking,
          after: { booking_id: bookingRef.id, booking_status: 'EXPIRED' },
          reason: 'HOLD_EXPIRED',
        });
        expiredCount += 1;
        releasedLockCount += locksSnap.size;
      });
    }

    logger.info('Eden Archery expired old holds', {
      expiredCount,
      releasedLockCount,
    });
    return { expiredCount, releasedLockCount };
  }
);

module.exports = {
  expireOldHolds,
};
