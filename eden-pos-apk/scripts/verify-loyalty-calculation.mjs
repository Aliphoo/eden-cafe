import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const backendFormula = require("../../functions/loyaltyFormula.js");

const loyaltySource = await readFile(
  new URL("../src/domain/loyalty.ts", import.meta.url),
  "utf8"
);
const loyaltyModule = ts.transpileModule(loyaltySource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
});
const { calculateLoyaltyPreview } = await import(
  `data:text/javascript;base64,${Buffer.from(loyaltyModule.outputText).toString("base64")}`
);

const baseConfig = {
  enabled: true,
  spendPerPoint: 25,
  pointValue: 1,
  expiryMonths: 24,
  maxRedeemPercent: 30,
  minRedeemPoints: 20,
  earnAfterDiscount: true,
  earnOnRedeemedAmount: false,
  excludedCategories: [],
  tierMultipliers: { Silver: 1, Gold: 1.25, Platinum: 1.5 },
};

const fixtures = [
  {
    name: "no discount",
    lines: [{ name: "Coffee", category: "Cafe", unitPrice: 100, quantity: 1, lineDiscount: 0 }],
    orderDiscount: 0,
    expectedEarnBase: 100,
    expectedPoints: 4,
  },
  {
    name: "line discount only",
    lines: [{ name: "Coffee", category: "Cafe", unitPrice: 100, quantity: 1, lineDiscount: 20 }],
    orderDiscount: 0,
    expectedEarnBase: 80,
    expectedPoints: 3,
  },
  {
    name: "order discount only",
    lines: [{ name: "Coffee", category: "Cafe", unitPrice: 100, quantity: 1, lineDiscount: 0 }],
    orderDiscount: 20,
    expectedEarnBase: 80,
    expectedPoints: 3,
  },
  {
    name: "both discounts",
    lines: [{ name: "Meal set", category: "Cafe", unitPrice: 200, quantity: 1, lineDiscount: 40 }],
    orderDiscount: 20,
    expectedEarnBase: 140,
    expectedPoints: 5,
  },
  {
    name: "redeem valid with min and max percent",
    lines: [{ name: "Meal set", category: "Cafe", unitPrice: 200, quantity: 1, lineDiscount: 0 }],
    orderDiscount: 0,
    redeemPoints: 30,
    availablePoints: 100,
    expectedEarnBase: 170,
    expectedPoints: 6,
    expectedRedeemedPoints: 30,
    expectedLoyaltyDiscount: 30,
  },
  {
    name: "excluded category",
    lines: [
      { name: "Coffee", category: "Cafe", unitPrice: 100, quantity: 1, lineDiscount: 0 },
      { name: "Gift card", category: "Gift Card", unitPrice: 100, quantity: 1, lineDiscount: 0 },
    ],
    config: { excludedCategories: ["gift card"] },
    orderDiscount: 0,
    expectedEligibleAmount: 100,
    expectedEarnBase: 100,
    expectedPoints: 4,
  },
  {
    name: "Gold multiplier",
    lines: [{ name: "Meal set", category: "Cafe", unitPrice: 200, quantity: 1, lineDiscount: 40 }],
    orderDiscount: 20,
    tier: "Gold",
    expectedEarnBase: 140,
    expectedPoints: 7,
  },
  {
    name: "Platinum multiplier",
    lines: [{ name: "Meal set", category: "Cafe", unitPrice: 200, quantity: 1, lineDiscount: 40 }],
    orderDiscount: 20,
    tier: "Platinum",
    expectedEarnBase: 140,
    expectedPoints: 8,
  },
];

const rejectionFixtures = [
  {
    name: "redeem below minRedeemPoints",
    lines: [{ name: "Meal set", category: "Cafe", unitPrice: 200, quantity: 1, lineDiscount: 0 }],
    redeemPoints: 10,
    availablePoints: 100,
    expectedBackendError: "Minimum redeem points is 20",
  },
  {
    name: "redeem over maxRedeemPercent",
    lines: [{ name: "Meal set", category: "Cafe", unitPrice: 200, quantity: 1, lineDiscount: 0 }],
    redeemPoints: 80,
    availablePoints: 100,
    expectedBackendError: "Redeemed points exceed max redeem percent",
  },
];

const orderDiscountResolverFixtures = [
  {
    name: "legacy totals.discount includes line discount",
    lines: [{ name: "Meal set", category: "Cafe", unitPrice: 200, quantity: 1, lineDiscount: 40 }],
    subtotal: 200,
    discount: 60,
    netAmount: 140,
    expectedOrderDiscount: 20,
  },
  {
    name: "explicit normalDiscount is already bill-level",
    lines: [{ name: "Meal set", category: "Cafe", unitPrice: 200, quantity: 1, lineDiscount: 40 }],
    subtotal: 200,
    normalDiscount: 20,
    netAmount: 140,
    expectedOrderDiscount: 20,
  },
  {
    name: "explicit orderDiscount wins as bill-level discount",
    lines: [{ name: "Meal set", category: "Cafe", unitPrice: 200, quantity: 1, lineDiscount: 40 }],
    subtotal: 200,
    orderDiscount: 20,
    discount: 60,
    netAmount: 140,
    expectedOrderDiscount: 20,
  },
];

const failures = [];
const results = [];

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual, expected, label) {
  if (Math.abs(actual - expected) > 0.0001) {
    failures.push(`${label}: expected ${expected}, got ${actual}`);
  }
}

function grossSubtotal(lines) {
  return lines.reduce((sum, line) => sum + Math.max(0, line.unitPrice * line.quantity), 0);
}

function lineDiscountTotal(lines) {
  return lines.reduce(
    (sum, line) => sum + Math.min(Math.max(0, line.lineDiscount || 0), line.unitPrice * line.quantity),
    0
  );
}

function makeConfig(overrides = {}) {
  return {
    ...baseConfig,
    ...overrides,
    tierMultipliers: {
      ...baseConfig.tierMultipliers,
      ...(overrides.tierMultipliers || {}),
    },
  };
}

function makeCustomer(points, tier) {
  return {
    uid: "test-member",
    profileSynced: true,
    points,
    tier,
  };
}

function makeBackendMember(points, tier) {
  return {
    points,
    tier,
    totalSpent: 0,
    visitCount: 0,
  };
}

function makeBackendSummary(points, tier) {
  return {
    pointsBalance: points,
    tier,
    lifetimePoints: points,
    totalRedeemed: 0,
    totalSpent: 0,
    visitCount: 0,
  };
}

function makeBackendItems(lines) {
  return lines.map((line, index) => ({
    productId: `fixture-${index + 1}`,
    name: line.name,
    category: line.category,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineDiscount: line.lineDiscount || 0,
  }));
}

function calculatePair(fixture) {
  const config = makeConfig(fixture.config);
  const tier = fixture.tier || "Silver";
  const availablePoints = fixture.availablePoints ?? 100;
  const subtotal = grossSubtotal(fixture.lines);
  const orderDiscount = fixture.orderDiscount || 0;
  const totalBeforeLoyalty = Math.max(0, subtotal - lineDiscountTotal(fixture.lines) - orderDiscount);
  const redeemPoints = fixture.redeemPoints || 0;

  const preview = calculateLoyaltyPreview({
    config,
    customer: makeCustomer(availablePoints, tier),
    lines: fixture.lines,
    orderDiscount,
    requestedRedeemPoints: redeemPoints,
    subtotal,
    totalBeforeLoyalty,
  });
  const backend = backendFormula.calculatePosLoyaltySale({
    config,
    member: makeBackendMember(availablePoints, tier),
    summary: makeBackendSummary(availablePoints, tier),
    items: makeBackendItems(fixture.lines),
    subtotal,
    netAmount: totalBeforeLoyalty,
    orderDiscount,
    requestedRedeemedPoints: redeemPoints,
  });

  return { preview, backend, subtotal, totalBeforeLoyalty };
}

for (const fixture of fixtures) {
  try {
    const { preview, backend, subtotal, totalBeforeLoyalty } = calculatePair(fixture);
    if (preview.blockedReason) {
      failures.push(`${fixture.name}: POS preview blocked unexpectedly: ${preview.blockedReason}`);
      continue;
    }

    assertEqual(preview.earnedPoints, backend.earnedPoints, `${fixture.name} earnedPoints parity`);
    assertEqual(preview.redeemedPoints, backend.redeemedPoints, `${fixture.name} redeemedPoints parity`);
    assertClose(preview.loyaltyDiscount, backend.loyaltyDiscount, `${fixture.name} loyaltyDiscount parity`);
    assertClose(preview.eligibleAmount, backend.eligibleAmount, `${fixture.name} eligibleAmount parity`);
    assertClose(preview.earnBase, backend.earnBase, `${fixture.name} earnBase parity`);
    assertClose(backend.earnBase, fixture.expectedEarnBase, `${fixture.name} expected earnBase`);
    assertEqual(backend.earnedPoints, fixture.expectedPoints, `${fixture.name} expected earnedPoints`);

    if (fixture.expectedEligibleAmount !== undefined) {
      assertClose(
        backend.eligibleAmount,
        fixture.expectedEligibleAmount,
        `${fixture.name} expected eligibleAmount`
      );
    }
    if (fixture.expectedRedeemedPoints !== undefined) {
      assertEqual(
        backend.redeemedPoints,
        fixture.expectedRedeemedPoints,
        `${fixture.name} expected redeemedPoints`
      );
    }
    if (fixture.expectedLoyaltyDiscount !== undefined) {
      assertClose(
        backend.loyaltyDiscount,
        fixture.expectedLoyaltyDiscount,
        `${fixture.name} expected loyaltyDiscount`
      );
    }

    results.push({
      name: fixture.name,
      subtotal,
      totalBeforeLoyalty,
      earnBase: backend.earnBase,
      earnedPoints: backend.earnedPoints,
      redeemedPoints: backend.redeemedPoints,
    });
  } catch (error) {
    failures.push(`${fixture.name}: ${error.message}`);
  }
}

for (const fixture of rejectionFixtures) {
  const config = makeConfig(fixture.config);
  const subtotal = grossSubtotal(fixture.lines);
  const orderDiscount = fixture.orderDiscount || 0;
  const totalBeforeLoyalty = Math.max(0, subtotal - lineDiscountTotal(fixture.lines) - orderDiscount);
  const tier = fixture.tier || "Silver";
  const availablePoints = fixture.availablePoints ?? 100;
  const preview = calculateLoyaltyPreview({
    config,
    customer: makeCustomer(availablePoints, tier),
    lines: fixture.lines,
    orderDiscount,
    requestedRedeemPoints: fixture.redeemPoints || 0,
    subtotal,
    totalBeforeLoyalty,
  });

  if (!preview.blockedReason) {
    failures.push(`${fixture.name}: POS preview did not block invalid redemption`);
  }

  try {
    backendFormula.calculatePosLoyaltySale({
      config,
      member: makeBackendMember(availablePoints, tier),
      summary: makeBackendSummary(availablePoints, tier),
      items: makeBackendItems(fixture.lines),
      subtotal,
      netAmount: totalBeforeLoyalty,
      orderDiscount,
      requestedRedeemedPoints: fixture.redeemPoints || 0,
    });
    failures.push(`${fixture.name}: backend accepted invalid redemption`);
  } catch (error) {
    if (!String(error.message).includes(fixture.expectedBackendError)) {
      failures.push(
        `${fixture.name}: backend error expected "${fixture.expectedBackendError}", got "${error.message}"`
      );
    }
  }

  results.push({
    name: fixture.name,
    subtotal,
    totalBeforeLoyalty,
    earnBase: "blocked",
    earnedPoints: "blocked",
    redeemedPoints: "blocked",
  });
}

for (const fixture of orderDiscountResolverFixtures) {
  const resolved = backendFormula.resolvePosOrderDiscount({
    orderDiscount: fixture.orderDiscount,
    normalDiscount: fixture.normalDiscount,
    discount: fixture.discount,
    subtotal: fixture.subtotal,
    netAmount: fixture.netAmount,
    items: makeBackendItems(fixture.lines),
  });

  assertClose(
    resolved,
    fixture.expectedOrderDiscount,
    `${fixture.name} expected bill-level order discount`
  );

  results.push({
    name: fixture.name,
    subtotal: fixture.subtotal,
    totalBeforeLoyalty: fixture.netAmount,
    earnBase: "resolver",
    earnedPoints: "resolver",
    redeemedPoints: "resolver",
    orderDiscount: resolved,
  });
}

console.table(results);

if (failures.length > 0) {
  console.error("\nLoyalty fixture failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "\nLoyalty fixture passed: POS preview and backend formula match, and line discounts are not deducted twice."
);
