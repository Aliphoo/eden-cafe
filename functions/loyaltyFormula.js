function cleanString(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function errorWithStatus(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const DEFAULT_MEMBERSHIP_TIERS = {
  Silver: { minPoints: 0, minTotalSpent: 0 },
  Gold: { minPoints: 1200, minTotalSpent: 15000 },
  Platinum: { minPoints: 5000, minTotalSpent: 50000 },
};

function tierRuleValue(source, tier, field, fallback) {
  const direct = source?.[tier]?.[field];
  const upper = source?.[tier.toUpperCase()]?.[field];
  const value = direct ?? upper;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeMembershipTiers(raw = {}) {
  const source = raw?.membershipTiers || raw?.tierRules || raw || {};
  const goldPoints = Math.max(1, Math.trunc(tierRuleValue(source, 'Gold', 'minPoints', DEFAULT_MEMBERSHIP_TIERS.Gold.minPoints)));
  const goldSpent = Math.max(1, Math.trunc(tierRuleValue(source, 'Gold', 'minTotalSpent', DEFAULT_MEMBERSHIP_TIERS.Gold.minTotalSpent)));
  const platinumPoints = Math.max(goldPoints + 1, Math.trunc(tierRuleValue(source, 'Platinum', 'minPoints', DEFAULT_MEMBERSHIP_TIERS.Platinum.minPoints)));
  const platinumSpent = Math.max(goldSpent + 1, Math.trunc(tierRuleValue(source, 'Platinum', 'minTotalSpent', DEFAULT_MEMBERSHIP_TIERS.Platinum.minTotalSpent)));
  return {
    Silver: { minPoints: 0, minTotalSpent: 0 },
    Gold: { minPoints: goldPoints, minTotalSpent: goldSpent },
    Platinum: { minPoints: platinumPoints, minTotalSpent: platinumSpent },
  };
}

function normalizeLoyaltySettings(raw = {}) {
  const defaultTierMultipliers = { Silver: 1, Gold: 1.25, Platinum: 1.5 };
  const tierMultipliers = raw.tierMultipliers && typeof raw.tierMultipliers === 'object'
    ? {
      ...defaultTierMultipliers,
      ...Object.fromEntries(Object.entries(raw.tierMultipliers)
        .map(([tier, value]) => [tier, Math.max(0, numberOr(value, 1))])
        .filter(([, value]) => value > 0)),
    }
    : defaultTierMultipliers;

  return {
    enabled: raw.enabled !== false,
    spendPerPoint: Math.max(0, numberOr(raw.spendPerPoint, 25)),
    pointValue: Math.max(0, numberOr(raw.pointValue, 1)),
    expiryMonths: Math.max(0, Math.trunc(numberOr(raw.expiryMonths, 24))),
    maxRedeemPercent: Math.min(100, Math.max(0, numberOr(raw.maxRedeemPercent, 30))),
    minRedeemPoints: Math.max(0, Math.trunc(numberOr(raw.minRedeemPoints, 20))),
    earnAfterDiscount: raw.earnAfterDiscount !== false,
    earnOnRedeemedAmount: raw.earnOnRedeemedAmount === true,
    excludedCategories: Array.isArray(raw.excludedCategories)
      ? raw.excludedCategories.map(value => cleanString(value, 120).toLowerCase()).filter(Boolean)
      : [],
    membershipTierMode: 'points_or_spend',
    membershipTiers: normalizeMembershipTiers(raw.membershipTiers || raw.tierRules || DEFAULT_MEMBERSHIP_TIERS),
    tierMultipliers,
  };
}

function normalizePosSaleItems(items) {
  return Array.isArray(items)
    ? items.map(item => ({
      productId: cleanString(item.productId || item.id || item.menuItemId || '', 120),
      variantId: cleanString(item.variantId || item.variant || item.optionId || item.variantName || 'base', 80),
      sku: cleanString(item.sku || item.variantSku || '', 80),
      name: cleanString(item.name || item.productName || 'POS item', 180),
      variantName: cleanString(item.variantName || item.optionName || item.variant || '', 120),
      category: cleanString(item.category || item.categoryName || item.categoryId || '', 160),
      quantity: Math.max(0, Number(item.quantity ?? item.qty ?? 0)),
      unitPrice: Math.max(0, Number(item.unitPrice ?? item.price ?? item.basePrice ?? 0)),
      lineDiscount: Math.max(0, Number(item.lineDiscount ?? item.discount ?? 0)),
      taxEnabled: item.taxEnabled !== false,
    })).filter(item => item.quantity > 0)
    : [];
}

function sumPosItemsSubtotal(items) {
  return normalizePosSaleItems(items).reduce(
    (sum, item) => sum + Math.max(0, item.unitPrice * item.quantity),
    0
  );
}

function sumPosItemsLineDiscount(items) {
  return normalizePosSaleItems(items).reduce(
    (sum, item) => sum + Math.min(
      Math.max(0, item.lineDiscount),
      Math.max(0, item.unitPrice * item.quantity)
    ),
    0
  );
}

function eligibleSubtotalForPosSale(items, excludedCategories) {
  const excluded = new Set((excludedCategories || []).map(value => cleanString(value, 120).toLowerCase()));
  return normalizePosSaleItems(items).reduce((sum, item) => {
    const category = cleanString(item.category, 160).toLowerCase();
    if (category && excluded.has(category)) return sum;
    return sum + Math.max(0, item.unitPrice * item.quantity - item.lineDiscount);
  }, 0);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampOrderDiscount(value, subtotalAfterLineDiscount) {
  return Math.min(
    Math.max(0, Number(value) || 0),
    Math.max(0, subtotalAfterLineDiscount)
  );
}

function resolvePosOrderDiscount({ orderDiscount, normalDiscount, discount, subtotal, netAmount, items }) {
  const normalizedItems = normalizePosSaleItems(items);
  const itemSubtotal = sumPosItemsSubtotal(normalizedItems);
  const grossSubtotal = Math.max(0, Number(subtotal) || itemSubtotal);
  const lineDiscount = sumPosItemsLineDiscount(normalizedItems);
  const subtotalAfterLineDiscount = Math.max(0, grossSubtotal - lineDiscount);
  const netAmountNumber = finiteNumberOrNull(netAmount);

  if (netAmountNumber !== null) {
    return clampOrderDiscount(subtotalAfterLineDiscount - Math.max(0, netAmountNumber), subtotalAfterLineDiscount);
  }

  const explicitOrderDiscount = finiteNumberOrNull(orderDiscount);
  if (explicitOrderDiscount !== null) return clampOrderDiscount(explicitOrderDiscount, subtotalAfterLineDiscount);

  const normalDiscountNumber = finiteNumberOrNull(normalDiscount);
  const totalDiscountNumber = finiteNumberOrNull(discount);
  if (normalDiscountNumber !== null) {
    const looksLikeTotalDiscount =
      lineDiscount > 0 &&
      totalDiscountNumber !== null &&
      Math.abs(normalDiscountNumber - totalDiscountNumber) < 0.01;
    return clampOrderDiscount(
      looksLikeTotalDiscount ? normalDiscountNumber - lineDiscount : normalDiscountNumber,
      subtotalAfterLineDiscount
    );
  }

  if (totalDiscountNumber !== null) {
    return clampOrderDiscount(totalDiscountNumber - lineDiscount, subtotalAfterLineDiscount);
  }

  return 0;
}

function memberTierFromMetrics(points = 0, totalSpent = 0, membershipTiers = DEFAULT_MEMBERSHIP_TIERS) {
  const tiers = normalizeMembershipTiers(membershipTiers);
  const p = Number(points) || 0;
  const spent = Number(totalSpent) || 0;
  if (p >= tiers.Platinum.minPoints || spent >= tiers.Platinum.minTotalSpent) return 'Platinum';
  if (p >= tiers.Gold.minPoints || spent >= tiers.Gold.minTotalSpent) return 'Gold';
  return 'Silver';
}

function calculatePosLoyaltySale({
  config,
  member = {},
  summary = {},
  items = [],
  subtotal = 0,
  netAmount = 0,
  orderDiscount = 0,
  requestedRedeemedPoints = 0,
}) {
  const loyaltyConfig = normalizeLoyaltySettings(config);
  if (!loyaltyConfig.enabled) throw errorWithStatus('Loyalty is disabled');

  const normalizedItems = normalizePosSaleItems(items);
  const saleSubtotal = Math.max(0, Number(subtotal) || sumPosItemsSubtotal(normalizedItems));
  const saleNetAmount = Math.max(0, Number(netAmount) || 0);
  const redeemedPoints = Math.max(0, Math.trunc(Number(requestedRedeemedPoints || 0)));
  const safeOrderDiscount = resolvePosOrderDiscount({
    orderDiscount,
    subtotal: saleSubtotal,
    netAmount: saleNetAmount,
    items: normalizedItems,
  });
  const memberTotalSpent = Math.max(0, Number(member.totalSpent || 0));
  const memberVisitCount = Math.max(0, Math.floor(Number(member.visitCount || 0)));
  const summaryTotalSpent = Math.max(0, Number(summary.totalSpent ?? memberTotalSpent));
  const summaryVisitCount = Math.max(0, Math.floor(Number(summary.visitCount ?? memberVisitCount)));
  const summaryLifetimePoints = Math.max(0, Number(summary.lifetimePoints || 0));
  const summaryTotalRedeemed = Math.max(0, Number(summary.totalRedeemed || 0));
  const memberPoints = Math.max(0, Math.floor(Number(member.points || 0)));
  const estimatedLegacyPoints = loyaltyConfig.spendPerPoint > 0
    ? Math.floor(memberTotalSpent / loyaltyConfig.spendPerPoint)
    : 0;
  const pointsBefore = summary.pointsBalance !== undefined
    ? Math.max(0, Math.floor(Number(summary.pointsBalance || 0)))
    : Math.max(memberPoints, estimatedLegacyPoints);
  const summaryLifetimeBase = Math.max(summaryLifetimePoints, pointsBefore);

  if (redeemedPoints > pointsBefore) {
    throw errorWithStatus('Redeemed points exceed member balance');
  }
  if (redeemedPoints > 0 && loyaltyConfig.minRedeemPoints > 0 && redeemedPoints < loyaltyConfig.minRedeemPoints) {
    throw errorWithStatus(`Minimum redeem points is ${loyaltyConfig.minRedeemPoints}`);
  }

  const requestedDiscount = redeemedPoints * loyaltyConfig.pointValue;
  const maxRedeemDiscount = (saleNetAmount * loyaltyConfig.maxRedeemPercent) / 100;
  if (requestedDiscount > maxRedeemDiscount + 0.0001) {
    throw errorWithStatus('Redeemed points exceed max redeem percent');
  }
  if (requestedDiscount > saleNetAmount + 0.0001) {
    throw errorWithStatus('Redeemed points exceed sale amount');
  }

  const loyaltyDiscount = Math.min(saleNetAmount, requestedDiscount);
  const payableAmount = Math.max(0, saleNetAmount - loyaltyDiscount);
  const eligibleSubtotal = eligibleSubtotalForPosSale(normalizedItems, loyaltyConfig.excludedCategories);
  const subtotalBase = saleSubtotal > 0 ? saleSubtotal : sumPosItemsSubtotal(normalizedItems);
  const subtotalAfterLineDiscount = normalizedItems.reduce(
    (sum, item) => sum + Math.max(0, item.unitPrice * item.quantity - item.lineDiscount),
    0
  );
  const orderDiscountAllocationBase = subtotalAfterLineDiscount > 0
    ? subtotalAfterLineDiscount
    : subtotalBase;
  const eligibleRatio = orderDiscountAllocationBase > 0
    ? Math.min(1, eligibleSubtotal / orderDiscountAllocationBase)
    : 0;
  const orderDiscountShare = loyaltyConfig.earnAfterDiscount
    ? safeOrderDiscount * eligibleRatio
    : 0;
  const redeemedDiscountShare = loyaltyConfig.earnOnRedeemedAmount
    ? 0
    : loyaltyDiscount * eligibleRatio;
  const earnBase = Math.max(0, eligibleSubtotal - orderDiscountShare - redeemedDiscountShare);
  const currentTier = cleanString(member.tier || summary.tier || 'Silver', 40);
  const multiplier = Number(loyaltyConfig.tierMultipliers[currentTier] || 1);
  const earnedPoints = loyaltyConfig.spendPerPoint > 0
    ? Math.floor((earnBase / loyaltyConfig.spendPerPoint) * multiplier)
    : 0;
  const pointsAfter = Math.max(0, pointsBefore - redeemedPoints + earnedPoints);
  const totalSpentAfter = memberTotalSpent + payableAmount;
  const visitCountAfter = memberVisitCount + 1;
  const tier = memberTierFromMetrics(pointsAfter, totalSpentAfter, loyaltyConfig.membershipTiers);

  return {
    config: loyaltyConfig,
    earnedPoints,
    redeemedPoints,
    loyaltyDiscount,
    payableAmount,
    pointsBefore,
    pointsAfter,
    tier,
    eligibleAmount: eligibleSubtotal,
    earnBase,
    orderDiscount: safeOrderDiscount,
    totalSpentAfter,
    visitCountAfter,
    summaryTotalSpent,
    summaryVisitCount,
    summaryLifetimeBase,
    summaryTotalRedeemed,
  };
}

module.exports = {
  calculatePosLoyaltySale,
  eligibleSubtotalForPosSale,
  finiteNumberOrNull,
  memberTierFromMetrics,
  normalizeMembershipTiers,
  normalizeLoyaltySettings,
  normalizePosSaleItems,
  resolvePosOrderDiscount,
  sumPosItemsLineDiscount,
  sumPosItemsSubtotal,
};
