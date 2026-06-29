const { apiError, cleanString } = require('../shared/time');
const promotionsEngine = require('../promotions/engine');

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function archeryPromoCode(value) {
  return promotionsEngine.normalizeCode(value);
}

function archeryItemCode(value) {
  const item = cleanString(value, 80).toUpperCase();
  if (!item) return '';
  return item.startsWith('ARCHERY_') ? item : `ARCHERY_${item}`;
}

function archeryBookingDate(timing = {}) {
  return cleanString(timing.booking_date || timing.bookingDate || timing.service_date || timing.serviceDate || '', 40);
}

function archeryPromotionLines(pricing = {}, timing = {}) {
  const items = Array.isArray(pricing.booking_items) ? pricing.booking_items : [];
  const bookingDate = archeryBookingDate(timing);
  return items.map((item, index) => {
    const itemType = archeryItemCode(item.item_type || item.itemType || '');
    const amount = roundMoney(item.amount || item.total_price || item.lineTotal || 0);
    const quantity = Math.max(1, Math.floor(Number(item.quantity || 1) || 1));
    return {
      id: `${timing.package_code || 'ARCHERY'}_${itemType || index}`,
      productId: itemType,
      archeryItem: itemType,
      itemType,
      item_type: itemType,
      label: cleanString(item.label || itemType || 'Archery item', 180),
      quantity,
      unitPrice: roundMoney(item.unit_amount || item.unit_price || (amount / quantity) || amount),
      lineTotal: amount,
      amount,
      durationMinutes: timing.duration_minutes || timing.packageMinutes || 0,
      bookingDate,
      booking_date: bookingDate,
      serviceDate: bookingDate,
      service_date: bookingDate,
    };
  }).filter(item => item.archeryItem && item.amount > 0);
}

function normalizePromotionLineAllocations(value) {
  return Array.isArray(value)
    ? value.map(row => ({
      lineIndex: Math.max(0, Math.floor(Number(row.lineIndex ?? row.line_index ?? 0) || 0)),
      productId: cleanString(row.productId || row.product_id, 160),
      variantId: cleanString(row.variantId || row.variant_id, 160),
      categoryId: cleanString(row.categoryId || row.category_id, 160),
      categoryIds: Array.isArray(row.categoryIds || row.category_ids)
        ? (row.categoryIds || row.category_ids).map(item => cleanString(item, 160)).filter(Boolean)
        : [],
      archeryItem: archeryItemCode(row.archeryItem || row.archery_item),
      eligibleAmount: roundMoney(row.eligibleAmount ?? row.eligible_amount),
      discountAmount: roundMoney(row.discountAmount ?? row.discount_amount),
    })).filter(row => row.discountAmount > 0)
    : [];
}

function promotionApplicationFromReservation(promoCode, reservation = {}) {
  const code = archeryPromoCode(reservation.code || promoCode);
  const promotionId = cleanString(reservation.promotionId || reservation.promotion_id, 120);
  const discountAmount = roundMoney(reservation.discountAmount ?? reservation.discount_amount);
  if (!code || !promotionId || discountAmount <= 0) return null;
  return {
    type: 'PROMO_CODE',
    code,
    promoCode: code,
    promotionId,
    promotionName: cleanString(reservation.promotionName || reservation.promotion_name, 160),
    redemptionId: cleanString(reservation.redemptionId || reservation.redemption_id, 120),
    status: cleanString(reservation.status || 'reserved', 40).toLowerCase(),
    discountAmount,
    eligibleSubtotal: roundMoney(reservation.eligibleSubtotal ?? reservation.eligible_subtotal),
    lineAllocations: normalizePromotionLineAllocations(reservation.lineAllocations || reservation.line_allocations),
  };
}

function promotionApplications(source = {}, { includeRedeemed = true } = {}) {
  const raw = Array.isArray(source.promoApplications)
    ? source.promoApplications
    : Array.isArray(source.promo_applications)
      ? source.promo_applications
      : [];
  return raw.map(application => {
    const code = archeryPromoCode(application.code || application.promoCode || application.promo_code);
    const promotionId = cleanString(application.promotionId || application.promotion_id, 120);
    const discountAmount = roundMoney(application.discountAmount ?? application.discount_amount);
    const status = cleanString(application.status || 'reserved', 40).toLowerCase();
    if (status === 'released' || status === 'voided') return null;
    if (!includeRedeemed && status !== 'reserved') return null;
    if (!code || !promotionId || discountAmount <= 0) return null;
    return {
      code,
      promotionId,
      redemptionId: cleanString(application.redemptionId || application.redemption_id, 120),
      status,
      discountAmount,
    };
  }).filter(Boolean);
}

function promotionApplicationsWithStatus(source = {}, status = '', details = {}) {
  const raw = Array.isArray(source.promoApplications)
    ? source.promoApplications
    : Array.isArray(source.promo_applications)
      ? source.promo_applications
      : [];
  const normalizedStatus = cleanString(status, 40).toLowerCase();
  return raw.map(application => ({
    ...application,
    status: normalizedStatus,
    paymentId: details.paymentId || application.paymentId || application.payment_id || '',
    payment_id: details.paymentId || application.payment_id || application.paymentId || '',
    releaseReason: details.reason || application.releaseReason || application.release_reason || '',
  }));
}

async function reserveArcheryPromotionInTransaction(transaction, db, options = {}) {
  const code = archeryPromoCode(options.promoCode || options.promo_code);
  const subtotal = roundMoney(options.pricing?.amount_total || 0);
  if (!code) {
    return {
      promoCode: '',
      discountAmount: 0,
      totalAmount: subtotal,
      promoApplications: [],
      lineAllocations: [],
    };
  }
  const reservation = await promotionsEngine.reservePromotionRedemptionInTransaction(transaction, db, {
    branch_id: options.branchId,
    promo_code: code,
    source_type: 'ARCHERY_BOOKING',
    source_id: options.bookingId,
    customer_uid: options.memberId,
    member_id: options.memberId,
    booking_date: archeryBookingDate(options.timing),
    bookingDate: archeryBookingDate(options.timing),
    service_date: archeryBookingDate(options.timing),
    serviceDate: archeryBookingDate(options.timing),
    subtotal,
    items: archeryPromotionLines(options.pricing, options.timing),
  }, {
    actor: options.actor || {},
    requestId: options.requestId || '',
  });
  const application = promotionApplicationFromReservation(code, reservation);
  if (!application) throw apiError('PROMO_CODE_INVALID', 409, 'Promo code is invalid');
  const totalAmount = roundMoney(Math.max(0, subtotal - application.discountAmount));
  return {
    promoCode: code,
    discountAmount: application.discountAmount,
    totalAmount,
    promoApplications: [application],
    lineAllocations: application.lineAllocations || [],
  };
}

function applyArcheryPromotionToPricing(pricing = {}, promotion = {}) {
  const subtotal = roundMoney(pricing.amount_total || 0);
  const discount = roundMoney(promotion.discountAmount || 0);
  const total = roundMoney(Math.max(0, promotion.totalAmount ?? (subtotal - discount)));
  const promoApplications = Array.isArray(promotion.promoApplications) ? promotion.promoApplications : [];
  return {
    ...pricing,
    amount_total: total,
    discount,
    discount_total: discount,
    subtotal_amount: subtotal,
    total_before_discount: subtotal,
    promo_code: promotion.promoCode || '',
    promoCode: promotion.promoCode || '',
    promoApplications,
    promo_applications: promoApplications,
    promotionRedemptionIds: promoApplications.map(application => application.redemptionId).filter(Boolean),
    promotionLineAllocations: promotion.lineAllocations || [],
    promotion_line_allocations: promotion.lineAllocations || [],
    amount_breakdown: {
      ...(pricing.amount_breakdown || {}),
      subtotal,
      discount,
      total,
    },
  };
}

async function commitArcheryPromotionApplications(transaction, db, options = {}) {
  const booking = options.booking || {};
  const applications = promotionApplications(booking);
  const results = [];
  for (const application of applications) {
    if (application.status === 'redeemed') continue;
    results.push(await promotionsEngine.commitPromotionRedemptionInTransaction(transaction, db, {
      branch_id: options.branchId || booking.branch_id,
      promo_code: application.code,
      promotion_id: application.promotionId,
      redemption_id: application.redemptionId,
      source_type: 'ARCHERY_BOOKING',
      source_id: options.bookingId || booking.booking_id || booking.id,
      payment_id: options.paymentId || '',
    }, {
      actor: options.actor || { uid: 'SYSTEM', role: 'SYSTEM', system: true },
      requestId: options.requestId || '',
      audit: options.audit !== false,
    }));
  }
  return results;
}

async function releaseArcheryPromotionApplications(transaction, db, options = {}) {
  const booking = options.booking || {};
  const applications = promotionApplications(booking, { includeRedeemed: false });
  const results = [];
  for (const application of applications) {
    results.push(await promotionsEngine.releasePromotionRedemptionInTransaction(transaction, db, {
      branch_id: options.branchId || booking.branch_id,
      promo_code: application.code,
      promotion_id: application.promotionId,
      redemption_id: application.redemptionId,
      source_type: 'ARCHERY_BOOKING',
      source_id: options.bookingId || booking.booking_id || booking.id,
      reason: options.reason || 'Archery hold was not paid',
    }, {
      actor: options.actor || { uid: 'SYSTEM', role: 'SYSTEM', system: true },
      requestId: options.requestId || '',
      audit: options.audit !== false,
    }));
  }
  return results;
}

function archeryPromotionStatusUpdate(booking = {}, status = '', details = {}) {
  const promoApplications = promotionApplicationsWithStatus(booking, status, details);
  if (!promoApplications.length) return {};
  return {
    promoApplications,
    promo_applications: promoApplications,
  };
}

module.exports = {
  archeryPromoCode,
  archeryPromotionLines,
  reserveArcheryPromotionInTransaction,
  applyArcheryPromotionToPricing,
  commitArcheryPromotionApplications,
  releaseArcheryPromotionApplications,
  archeryPromotionStatusUpdate,
};
