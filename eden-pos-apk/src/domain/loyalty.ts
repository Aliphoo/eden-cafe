import type {
  CartLine,
  CustomerProfile,
  LoyaltyConfig,
  LoyaltyRedemption,
  LoyaltyResult,
  LoyaltySummary
} from "./pos";

export const defaultLoyaltyConfig: LoyaltyConfig = {
  enabled: true,
  spendPerPoint: 25,
  pointValue: 1,
  expiryMonths: 24,
  maxRedeemPercent: 30,
  minRedeemPoints: 20,
  earnAfterDiscount: true,
  earnOnRedeemedAmount: false,
  excludedCategories: ["เครื่องดื่มแอลกอฮอล์", "ฝากเงิน", "โปรแรง"],
  tierMultipliers: { Silver: 1, Gold: 1.25, Platinum: 1.5 }
};

const numberOr = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeLoyaltyConfig = (
  config?: Partial<LoyaltyConfig> | null
): LoyaltyConfig => {
  const merged = {
    ...defaultLoyaltyConfig,
    ...(config ?? {})
  };

  return {
    ...merged,
    enabled: Boolean(merged.enabled),
    spendPerPoint: Math.max(0, numberOr(merged.spendPerPoint, defaultLoyaltyConfig.spendPerPoint)),
    pointValue: Math.max(0, numberOr(merged.pointValue, defaultLoyaltyConfig.pointValue)),
    expiryMonths: Math.max(0, Math.floor(numberOr(merged.expiryMonths, defaultLoyaltyConfig.expiryMonths))),
    maxRedeemPercent: Math.min(
      100,
      Math.max(0, numberOr(merged.maxRedeemPercent, defaultLoyaltyConfig.maxRedeemPercent))
    ),
    minRedeemPoints: Math.max(
      0,
      Math.floor(numberOr(merged.minRedeemPoints, defaultLoyaltyConfig.minRedeemPoints))
    ),
    earnAfterDiscount: merged.earnAfterDiscount !== false,
    earnOnRedeemedAmount: Boolean(merged.earnOnRedeemedAmount),
    excludedCategories: Array.isArray(merged.excludedCategories)
      ? merged.excludedCategories.map((category) => String(category).trim()).filter(Boolean)
      : [],
    tierMultipliers:
      merged.tierMultipliers && typeof merged.tierMultipliers === "object"
        ? Object.fromEntries(
            Object.entries(merged.tierMultipliers)
              .map(([tier, multiplier]) => [
                tier,
                Math.max(0, numberOr(multiplier, 1))
              ] as [string, number])
              .filter(([, multiplier]) => multiplier > 0)
          )
        : {},
    updatedAt: merged.updatedAt
  };
};

export const normalizeLoyaltySummary = (
  customerUid: string,
  summary?: Partial<LoyaltySummary> | null,
  fallbackPoints = 0
): LoyaltySummary => ({
  customerUid,
  pointsBalance: Math.max(
    0,
    Math.floor(numberOr(summary?.pointsBalance, fallbackPoints))
  ),
  tier: summary?.tier,
  lifetimePoints: Math.max(0, numberOr(summary?.lifetimePoints, 0)),
  totalRedeemed: Math.max(0, numberOr(summary?.totalRedeemed, 0)),
  totalSpent: Math.max(0, numberOr(summary?.totalSpent, 0)),
  visitCount: Math.max(0, Math.floor(numberOr(summary?.visitCount, 0))),
  updatedAt: summary?.updatedAt
});

export const customerCanUseLoyalty = (customer?: CustomerProfile | null) =>
  Boolean(customer?.uid && customer.profileSynced);

export const pointsBalanceForCustomer = (customer?: CustomerProfile | null) =>
  Math.max(0, Math.floor(numberOr(customer?.points, 0)));

const lineGross = (line: CartLine) =>
  Math.max(0, line.unitPrice * line.quantity - (line.lineDiscount ?? 0));

export const eligibleSubtotalForLoyalty = (
  lines: CartLine[],
  excludedCategories: string[]
) => {
  const excluded = new Set(
    excludedCategories.map((category) => category.trim().toLowerCase())
  );

  return lines.reduce((sum, line) => {
    const category = line.category.trim().toLowerCase();
    if (category && excluded.has(category)) {
      return sum;
    }
    return sum + lineGross(line);
  }, 0);
};

type LoyaltyPreviewInput = {
  config?: Partial<LoyaltyConfig> | null;
  customer?: CustomerProfile | null;
  lines: CartLine[];
  orderDiscount: number;
  requestedRedeemPoints: number;
  subtotal: number;
  totalBeforeLoyalty: number;
};

export const calculateLoyaltyPreview = ({
  config,
  customer,
  lines,
  orderDiscount,
  requestedRedeemPoints,
  subtotal,
  totalBeforeLoyalty
}: LoyaltyPreviewInput): LoyaltyResult & {
  availablePoints: number;
  blockedReason: string;
  payableTotal: number;
  redemption?: LoyaltyRedemption;
} => {
  const loyaltyConfig = normalizeLoyaltyConfig(config);
  const availablePoints = pointsBalanceForCustomer(customer);
  const canUseLoyalty = loyaltyConfig.enabled && customerCanUseLoyalty(customer);
  const requestedPoints = Math.max(0, Math.floor(numberOr(requestedRedeemPoints, 0)));
  const maxDiscountByPercent =
    (Math.max(0, totalBeforeLoyalty) * loyaltyConfig.maxRedeemPercent) / 100;
  const maxPointsByPercent =
    loyaltyConfig.pointValue > 0
      ? Math.floor(maxDiscountByPercent / loyaltyConfig.pointValue)
      : 0;
  const maxPointsByTotal =
    loyaltyConfig.pointValue > 0
      ? Math.floor(Math.max(0, totalBeforeLoyalty) / loyaltyConfig.pointValue)
      : 0;
  const maxRedeemablePoints = Math.max(
    0,
    Math.min(availablePoints, maxPointsByPercent, maxPointsByTotal)
  );

  let blockedReason = "";
  if (!loyaltyConfig.enabled) {
    blockedReason = "ยังไม่ได้เปิดใช้งาน Loyalty";
  } else if (!customer?.uid) {
    blockedReason = "เลือกสมาชิกก่อนใช้แต้ม";
  } else if (!customer.profileSynced) {
    blockedReason = "สมาชิกยังไม่ได้ซิงก์กับ Eden";
  } else if (requestedPoints > availablePoints) {
    blockedReason = "แต้มไม่พอ";
  } else if (
    requestedPoints > 0 &&
    loyaltyConfig.minRedeemPoints > 0 &&
    requestedPoints < loyaltyConfig.minRedeemPoints
  ) {
    blockedReason = `ใช้แต้มขั้นต่ำ ${loyaltyConfig.minRedeemPoints} แต้ม`;
  } else if (requestedPoints > maxRedeemablePoints) {
    blockedReason = "ใช้แต้มเกินเพดานส่วนลด";
  }

  const redeemedPoints =
    canUseLoyalty && !blockedReason ? Math.min(requestedPoints, maxRedeemablePoints) : 0;
  const loyaltyDiscount = Math.min(
    Math.max(0, totalBeforeLoyalty),
    redeemedPoints * loyaltyConfig.pointValue
  );
  const payableTotal = Math.max(0, totalBeforeLoyalty - loyaltyDiscount);
  const eligibleSubtotal = eligibleSubtotalForLoyalty(
    lines,
    loyaltyConfig.excludedCategories
  );
  const subtotalAfterLineDiscount = lines.reduce((sum, line) => sum + lineGross(line), 0);
  const orderDiscountAllocationBase =
    subtotalAfterLineDiscount > 0 ? subtotalAfterLineDiscount : Math.max(0, subtotal);
  const subtotalRatio =
    orderDiscountAllocationBase > 0
      ? Math.min(1, eligibleSubtotal / orderDiscountAllocationBase)
      : 0;
  const orderDiscountShare = loyaltyConfig.earnAfterDiscount
    ? Math.max(0, orderDiscount) * subtotalRatio
    : 0;
  const redeemedDiscountShare = loyaltyConfig.earnOnRedeemedAmount
    ? 0
    : loyaltyDiscount * subtotalRatio;
  const earnBase = canUseLoyalty
    ? Math.max(0, eligibleSubtotal - orderDiscountShare - redeemedDiscountShare)
    : 0;
  const tier = customer?.tier || "standard";
  const multiplier = loyaltyConfig.tierMultipliers[tier] ?? 1;
  const earnedPoints =
    canUseLoyalty && loyaltyConfig.spendPerPoint > 0
      ? Math.floor((earnBase / loyaltyConfig.spendPerPoint) * multiplier)
      : 0;

  return {
    customerUid: customer?.uid,
    earnedPoints,
    redeemedPoints,
    loyaltyDiscount,
    eligibleAmount: eligibleSubtotal,
    earnBase,
    availablePoints,
    blockedReason,
    payableTotal,
    redemption:
      redeemedPoints > 0
        ? {
            redeemedPoints,
            discountAmount: loyaltyDiscount,
            pointValue: loyaltyConfig.pointValue
          }
        : undefined
  };
};
