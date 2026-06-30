const logger = require('firebase-functions/logger');
const { FieldValue, Timestamp } = require('../shared/firestore');
const { cleanString } = require('../shared/time');
const loyaltyFormula = require('../loyaltyFormula');

function safeIdPart(value, maxLength = 120) {
  return cleanString(value, maxLength)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function archeryLoyaltyLedgerId(bookingId) {
  return `archery-earn-${safeIdPart(bookingId, 180)}`.slice(0, 260);
}

function archeryMemberId(booking = {}) {
  return cleanString(
    booking.customerUid
      || booking.uid
      || booking.member_id
      || booking.memberId
      || booking.userId,
    160
  );
}

function archeryAmount(booking = {}) {
  return Math.max(0, Number(
    booking.amount_total
      || booking.amountTotal
      || booking.totalAmount
      || booking.total
      || booking.price
      || booking.amount
      || 0
  ) || 0);
}

function expiryTimestamp(months) {
  const value = Math.floor(Number(months || 0));
  if (!value) return null;
  const date = new Date();
  date.setMonth(date.getMonth() + value);
  return Timestamp.fromDate(date);
}

function memberName(member = {}, summary = {}, booking = {}) {
  return cleanString(
    member.displayName
      || member.name
      || member.customerName
      || summary.memberName
      || summary.displayName
      || summary.name
      || booking.customer_name
      || booking.name
      || 'Eden Member',
    160
  );
}

function memberEmail(member = {}, summary = {}) {
  return cleanString(member.email || summary.memberEmail || summary.email || '', 180);
}

function memberCode(member = {}, summary = {}) {
  return cleanString(member.memberCode || summary.memberCode || '', 80);
}

function calculateArcheryLoyalty({ config = {}, member = null, summary = {}, booking = {}, ledgerExists = false } = {}) {
  const bookingId = cleanString(booking.booking_id || booking.id, 180);
  const userId = archeryMemberId(booking);
  const amount = archeryAmount(booking);
  const loyaltyConfig = loyaltyFormula.normalizeLoyaltySettings(config);

  if (ledgerExists) {
    return { status: 'already_applied', reason: 'ledger-exists', bookingId, userId, amount, earnedPoints: 0 };
  }
  if (!bookingId) {
    return { status: 'skipped', reason: 'missing-booking-id', bookingId, userId, amount, earnedPoints: 0 };
  }
  if (!userId) {
    return { status: 'skipped', reason: 'missing-member', bookingId, userId, amount, earnedPoints: 0 };
  }
  if (!member) {
    return { status: 'skipped', reason: 'member-not-found', bookingId, userId, amount, earnedPoints: 0 };
  }
  if (!loyaltyConfig.enabled) {
    return { status: 'skipped', reason: 'loyalty-disabled', bookingId, userId, amount, earnedPoints: 0 };
  }
  if (amount <= 0) {
    return { status: 'skipped', reason: 'no-eligible-amount', bookingId, userId, amount, earnedPoints: 0 };
  }

  const memberTotalSpent = Math.max(0, Number(member.totalSpent || 0));
  const memberVisitCount = Math.max(0, Math.floor(Number(member.visitCount || 0)));
  const summaryTotalSpent = Math.max(0, Number(summary.totalSpent ?? memberTotalSpent));
  const summaryVisitCount = Math.max(0, Math.floor(Number(summary.visitCount ?? memberVisitCount)));
  const memberPoints = Math.max(0, Math.floor(Number(member.points || 0)));
  const estimatedLegacyPoints = loyaltyConfig.spendPerPoint > 0
    ? Math.floor(memberTotalSpent / loyaltyConfig.spendPerPoint)
    : 0;
  const pointsBefore = summary.pointsBalance !== undefined
    ? Math.max(0, Math.floor(Number(summary.pointsBalance || 0)))
    : Math.max(memberPoints, estimatedLegacyPoints);
  const currentTier = loyaltyFormula.memberTierFromMetrics(
    pointsBefore,
    Math.max(memberTotalSpent, summaryTotalSpent),
    loyaltyConfig.membershipTiers
  );
  const multiplier = Number(loyaltyConfig.tierMultipliers[currentTier] || 1);
  const earnedPoints = loyaltyConfig.spendPerPoint > 0
    ? Math.floor((amount / loyaltyConfig.spendPerPoint) * multiplier)
    : 0;

  if (earnedPoints <= 0) {
    return {
      status: 'skipped',
      reason: 'zero-earned-points',
      bookingId,
      userId,
      amount,
      earnedPoints: 0,
      pointsBefore,
      currentTier,
      multiplier,
    };
  }

  const pointsAfter = pointsBefore + earnedPoints;
  const totalSpentAfter = memberTotalSpent + amount;
  const summaryTotalSpentAfter = summaryTotalSpent + amount;
  const visitCountAfter = memberVisitCount + 1;
  const summaryVisitCountAfter = summaryVisitCount + 1;
  const tier = loyaltyFormula.memberTierFromMetrics(
    pointsAfter,
    Math.max(totalSpentAfter, summaryTotalSpentAfter),
    loyaltyConfig.membershipTiers
  );
  const summaryLifetimeBase = Math.max(
    Math.max(0, Number(summary.lifetimePoints || 0)),
    pointsBefore
  );

  return {
    status: 'synced',
    bookingId,
    userId,
    amount,
    earnedPoints,
    pointsBefore,
    pointsAfter,
    currentTier,
    tier,
    multiplier,
    totalSpentAfter,
    summaryTotalSpentAfter,
    visitCountAfter,
    summaryVisitCountAfter,
    summaryLifetimePointsAfter: summaryLifetimeBase + earnedPoints,
    config: loyaltyConfig,
  };
}

async function readArcheryLoyaltyState(transaction, db, options = {}) {
  const booking = options.booking || {};
  const bookingId = cleanString(options.bookingId || booking.booking_id || booking.id, 180);
  const userId = archeryMemberId(booking);
  const ledgerId = archeryLoyaltyLedgerId(bookingId);
  const ledgerRef = db.collection('point_ledger').doc(ledgerId);
  const loyaltyRef = db.collection('site_settings').doc('loyalty');

  if (!bookingId || !userId) {
    const [loyaltySnap, ledgerSnap] = await Promise.all([
      transaction.get(loyaltyRef),
      transaction.get(ledgerRef),
    ]);
    return {
      booking,
      bookingId,
      userId,
      ledgerId,
      ledgerRef,
      loyaltyRef,
      config: loyaltySnap.exists ? loyaltySnap.data() || {} : {},
      ledgerExists: ledgerSnap.exists,
      existingLedger: ledgerSnap.exists ? ledgerSnap.data() || {} : null,
    };
  }

  const userRef = db.collection('users').doc(userId);
  const summaryRef = db.collection('member_summaries').doc(userId);
  const [userSnap, summarySnap, loyaltySnap, ledgerSnap] = await Promise.all([
    transaction.get(userRef),
    transaction.get(summaryRef),
    transaction.get(loyaltyRef),
    transaction.get(ledgerRef),
  ]);

  return {
    booking,
    bookingId,
    userId,
    ledgerId,
    userRef,
    summaryRef,
    ledgerRef,
    loyaltyRef,
    member: userSnap.exists ? userSnap.data() || {} : null,
    summary: summarySnap.exists ? summarySnap.data() || {} : {},
    config: loyaltySnap.exists ? loyaltySnap.data() || {} : {},
    ledgerExists: ledgerSnap.exists,
    existingLedger: ledgerSnap.exists ? ledgerSnap.data() || {} : null,
  };
}

function writeArcheryLoyaltyState(transaction, state = {}, options = {}) {
  const calculation = calculateArcheryLoyalty({
    config: state.config,
    member: state.member,
    summary: state.summary,
    booking: state.booking,
    ledgerExists: state.ledgerExists,
  });

  if (calculation.status !== 'synced') {
    logger.info('Archery loyalty skipped', {
      status: calculation.status,
      reason: calculation.reason || '',
      booking_id: state.bookingId || calculation.bookingId || '',
      member_id: state.userId || calculation.userId || '',
      ledger_id: state.ledgerId || '',
    });
    return {
      ...calculation,
      ledgerId: state.ledgerId || '',
    };
  }

  const now = FieldValue.serverTimestamp();
  const booking = state.booking || {};
  const member = state.member || {};
  const summary = state.summary || {};
  const paymentId = cleanString(options.paymentId || booking.payment_id, 180);
  const actorId = cleanString(options.actorId || options.createdBy || '', 160);
  const actorEmail = cleanString(options.actorEmail || '', 180);
  const ledgerPayload = {
    userId: calculation.userId,
    memberCode: memberCode(member, summary),
    memberName: memberName(member, summary, booking),
    memberEmail: memberEmail(member, summary),
    type: 'archery_earn',
    pointsDelta: calculation.earnedPoints,
    pointsBefore: calculation.pointsBefore,
    pointsAfter: calculation.pointsAfter,
    amount: calculation.amount,
    bookingId: calculation.bookingId,
    booking_id: calculation.bookingId,
    paymentId,
    payment_id: paymentId,
    idempotencyKey: state.ledgerId,
    source: 'archery',
    branchId: cleanString(booking.branch_id, 80),
    branch_id: cleanString(booking.branch_id, 80),
    paymentStatus: cleanString(options.paymentStatus || booking.payment_status || booking.paymentStatus, 60),
    payment_status: cleanString(options.paymentStatus || booking.payment_status || booking.paymentStatus, 60),
    bookingStatus: cleanString(options.bookingStatus || booking.booking_status || booking.status, 60),
    booking_status: cleanString(options.bookingStatus || booking.booking_status || booking.status, 60),
    bookingDate: cleanString(booking.booking_date || booking.date, 40),
    booking_date: cleanString(booking.booking_date || booking.date, 40),
    createdAt: now,
    createdBy: actorId,
    createdByEmail: actorEmail,
  };
  const expiresAt = expiryTimestamp(calculation.config.expiryMonths);
  if (expiresAt) ledgerPayload.expiresAt = expiresAt;

  transaction.set(state.ledgerRef, ledgerPayload);
  transaction.set(state.userRef, {
    points: calculation.pointsAfter,
    totalSpent: calculation.totalSpentAfter,
    visitCount: calculation.visitCountAfter,
    tier: calculation.tier,
    loyaltyUpdatedAt: now,
    updatedAt: now,
  }, { merge: true });
  transaction.set(state.summaryRef, {
    userId: calculation.userId,
    memberCode: ledgerPayload.memberCode,
    memberName: ledgerPayload.memberName,
    memberEmail: ledgerPayload.memberEmail,
    pointsBalance: calculation.pointsAfter,
    tier: calculation.tier,
    lifetimePoints: calculation.summaryLifetimePointsAfter,
    totalSpent: calculation.summaryTotalSpentAfter,
    visitCount: calculation.summaryVisitCountAfter,
    lastLedgerId: state.ledgerId,
    updatedAt: now,
  }, { merge: true });

  logger.info('Archery loyalty applied', {
    booking_id: calculation.bookingId,
    member_id: calculation.userId,
    ledger_id: state.ledgerId,
    earned_points: calculation.earnedPoints,
    amount: calculation.amount,
  });

  return {
    ...calculation,
    ledgerId: state.ledgerId,
  };
}

module.exports = {
  archeryAmount,
  archeryLoyaltyLedgerId,
  archeryMemberId,
  calculateArcheryLoyalty,
  readArcheryLoyaltyState,
  writeArcheryLoyaltyState,
};
