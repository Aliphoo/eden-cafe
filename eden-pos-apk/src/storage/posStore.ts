import type {
  LoyaltyConfig,
  PosData,
  PromptPayAccount,
  Receipt,
  SecuritySettings,
  StoreProfile
} from "../domain/pos";
import { normalizeLoyaltyConfig } from "../domain/loyalty";
import { receiptRefundStatus, receiptTotalRefunded } from "../domain/receiptAdjustments";
import { seedData } from "./seed";

const STORAGE_KEY = "personal-pos-data-v1";

const LEGACY_SAMPLE_PRODUCT_IDS = new Set([
  "prod-iced-coffee",
  "prod-thai-tea",
  "prod-water",
  "prod-basil-chicken",
  "prod-pork-fried-rice",
  "prod-toast"
]);

const localDateKey = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

const MOJIBAKE_PATTERN = /(?:à¸|à¹|Â|â€|â†|Ã|ð)/;
const CP1252_BYTES: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f
};

const cp1252BytesFromText = (value: string) =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return CP1252_BYTES[code] ?? (code <= 0xff ? code : 0x3f);
  });

const repairMojibakeText = (value: string) => {
  if (!MOJIBAKE_PATTERN.test(value)) return value;

  const repaired = new TextDecoder("utf-8", { fatal: false }).decode(
    new Uint8Array(cp1252BytesFromText(value))
  );
  if (!repaired || repaired.includes("\uFFFD")) return value;
  if (MOJIBAKE_PATTERN.test(repaired)) return value;

  return repaired;
};

const repairPersistedLanguage = (value: unknown): unknown => {
  if (typeof value === "string") {
    return repairMojibakeText(value);
  }

  if (Array.isArray(value)) {
    return value.map(repairPersistedLanguage);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        repairPersistedLanguage(item)
      ])
    );
  }

  return value;
};

const hydrateReceipt = (receipt: Receipt): Receipt => {
  const isPaid =
    receipt.paymentStatus === "paid" ||
    (!receipt.paymentStatus && receipt.billStatus !== "open");
  const paidAmount =
    receipt.paidAmount ?? receipt.paid ?? (isPaid ? receipt.total : 0);
  const loyaltyDiscount = receipt.loyaltyDiscount ?? 0;
  const totalBeforeLoyalty =
    receipt.totalBeforeLoyalty ??
    (loyaltyDiscount > 0 ? receipt.total + loyaltyDiscount : receipt.total);
  const normalDiscount = receipt.normalDiscount ?? receipt.discount ?? 0;
  const loyaltySyncStatus =
    receipt.loyaltySyncStatus ??
    (isPaid && receipt.customerUid && receipt.customerProfileSynced ? "pending" : "skipped");

  return {
    ...receipt,
    businessDate:
      receipt.businessDate || localDateKey(new Date(receipt.createdAt)),
    taxIncluded: receipt.taxIncluded ?? receipt.tax ?? 0,
    totalAmount: receipt.totalAmount ?? receipt.total,
    normalDiscount,
    loyaltyDiscount,
    totalBeforeLoyalty,
    paid: receipt.paid ?? paidAmount,
    paidAmount,
    change: receipt.change ?? 0,
    changeAmount: receipt.changeAmount ?? receipt.change ?? 0,
    paymentLabel:
      receipt.paymentLabel ?? (isPaid ? receipt.paymentMethod : "ค้างชำระ"),
    customerName: receipt.customerName || "Walk-in Customer",
    phone: receipt.phone || "",
    tableId: receipt.tableId || "",
    tableNumber: receipt.tableNumber || "",
    tableName: receipt.tableName || "",
    tableZone: receipt.tableZone || "",
    note: receipt.note || "",
    source: "pos",
    orderType: "pos",
    status: receipt.status ?? (isPaid ? "completed" : "pending"),
    paymentStatus: receipt.paymentStatus ?? (isPaid ? "paid" : "pending"),
    billStatus: receipt.billStatus ?? (isPaid ? "paid" : "open"),
    isOpenBill: receipt.isOpenBill ?? !isPaid,
    orderMode: receipt.orderMode ?? (isPaid ? "pay_now" : "open_bill"),
    syncStatus: receipt.syncStatus ?? "local",
    loyalty: receipt.loyalty,
    loyaltyRedemption: receipt.loyaltyRedemption,
    earnedPoints: receipt.earnedPoints ?? receipt.loyalty?.earnedPoints ?? 0,
    redeemedPoints:
      receipt.redeemedPoints ?? receipt.loyaltyRedemption?.redeemedPoints ?? 0,
    loyaltySyncStatus,
    loyaltyError: receipt.loyaltyError || "",
    loyaltyIdempotencyKey: receipt.loyaltyIdempotencyKey || receipt.number,
    loyaltySyncedAt: receipt.loyaltySyncedAt || "",
    paymentAdjustments: receipt.paymentAdjustments ?? [],
    paymentAdjustedAt: receipt.paymentAdjustedAt || "",
    paymentAdjustedBy: receipt.paymentAdjustedBy || "",
    refundAdjustments: receipt.refundAdjustments ?? [],
    refundStatus: receipt.refundStatus ?? receiptRefundStatus(receipt),
    refundedAmount: receipt.refundedAmount ?? receiptTotalRefunded(receipt),
    refundedAt: receipt.refundedAt || "",
    refundedBy: receipt.refundedBy || "",
    cancelledAt: receipt.cancelledAt || "",
    cancelledBy: receipt.cancelledBy || "",
    restoredAt: receipt.restoredAt || "",
    restoredBy: receipt.restoredBy || "",
    orderTicketPrintedItems: receipt.orderTicketPrintedItems ?? [],
    orderTicketPrintedAt: receipt.orderTicketPrintedAt || ""
  };
};

const cleanPromptPayId = (value: unknown) =>
  String(value ?? "").replace(/\D/g, "");

const normalizePromptPayAccount = (
  account: Partial<PromptPayAccount> | undefined,
  index: number,
  fallback: StoreProfile
): PromptPayAccount => {
  const promptPayId = cleanPromptPayId(account?.promptPayId || fallback.promptPayId);

  return {
    id:
      String(account?.id || account?.label || `promptpay-${index + 1}`)
        .trim()
        .slice(0, 80) || `promptpay-${index + 1}`,
    label:
      String(account?.label || `PromptPay ${index + 1}`)
        .trim()
        .slice(0, 80) || `PromptPay ${index + 1}`,
    promptPayId,
    merchantName:
      String(account?.merchantName || fallback.merchantName)
        .trim()
        .slice(0, 25) || fallback.merchantName,
    city:
      String(account?.city || fallback.city)
        .trim()
        .slice(0, 15) || fallback.city,
    order: Number.isFinite(Number(account?.order)) ? Number(account?.order) : index + 1
  };
};

const limitStoreText = (value: unknown, maxLength: number) =>
  String(value ?? "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, maxLength);

const hydrateStore = (store: Partial<StoreProfile> = {}): StoreProfile => {
  const hasExplicitPrintLogoChoice =
    Boolean(store.printLogoDataUrl) ||
    Boolean(store.printLogoFileName) ||
    Object.prototype.hasOwnProperty.call(store, "printLogoUpdatedAt");
  const mergedStore = {
    ...seedData.store,
    ...store
  };
  const rawAccounts =
    Array.isArray(mergedStore.promptPayAccounts) &&
    mergedStore.promptPayAccounts.length
      ? mergedStore.promptPayAccounts
      : [
          {
            id: mergedStore.promptPayAccountId || seedData.store.promptPayAccountId,
            label: "Eden Cafe Main",
            promptPayId: mergedStore.promptPayId,
            merchantName: mergedStore.merchantName,
            city: mergedStore.city,
            order: 1
          }
        ];
  const accounts = rawAccounts
    .map((account, index) =>
      normalizePromptPayAccount(account, index, mergedStore)
    )
    .filter((account) => account.promptPayId)
    .sort((a, b) => a.order - b.order)
    .map((account, index) => ({ ...account, order: index + 1 }));
  const fallbackAccounts = accounts.length
    ? accounts
    : [
        normalizePromptPayAccount(
          seedData.store.promptPayAccounts?.[0],
          0,
          seedData.store
        )
      ];
  const requestedAccountId = String(mergedStore.promptPayAccountId || "").trim();
  const selectedAccount =
    fallbackAccounts.find((account) => account.id === requestedAccountId) ||
    fallbackAccounts[0];

  return {
    ...mergedStore,
    printLogoDataUrl: hasExplicitPrintLogoChoice
      ? mergedStore.printLogoDataUrl
      : seedData.store.printLogoDataUrl,
    printLogoFileName: hasExplicitPrintLogoChoice
      ? mergedStore.printLogoFileName
      : seedData.store.printLogoFileName,
    receiptHeaderBusinessName:
      limitStoreText(
        mergedStore.receiptHeaderBusinessName || mergedStore.name,
        120
      ) || seedData.store.receiptHeaderBusinessName,
    receiptHeaderBranch: limitStoreText(mergedStore.receiptHeaderBranch, 120),
    receiptHeaderAddress: limitStoreText(mergedStore.receiptHeaderAddress, 300),
    receiptTaxId: limitStoreText(mergedStore.receiptTaxId, 40),
    receiptPhone: limitStoreText(mergedStore.receiptPhone, 80),
    receiptWebsite: limitStoreText(mergedStore.receiptWebsite, 120),
    receiptTitle:
      limitStoreText(mergedStore.receiptTitle, 120) ||
      seedData.store.receiptTitle,
    receiptFooterNote: limitStoreText(mergedStore.receiptFooterNote, 300),
    receiptFooterTaxNote: limitStoreText(mergedStore.receiptFooterTaxNote, 80),
    promptPayAccountId: selectedAccount.id,
    promptPayAccounts: fallbackAccounts,
    promptPayEnabled: mergedStore.promptPayEnabled !== false,
    promptPayLocked: true,
    promptPayId: selectedAccount.promptPayId,
    merchantName: selectedAccount.merchantName,
    city: selectedAccount.city
  };
};

const hydrateSecurity = (
  security: Partial<SecuritySettings> | undefined
): SecuritySettings => ({
  ...seedData.security,
  ...security,
  enabled: Boolean(security?.enabled),
  lockTimeoutMinutes: Math.max(
    1,
    Number(security?.lockTimeoutMinutes ?? seedData.security.lockTimeoutMinutes)
  ),
  pinHash: security?.pinHash ?? "",
  pinSalt: security?.pinSalt ?? ""
});

const hydrateLoyaltyConfig = (
  config: Partial<LoyaltyConfig> | undefined
): LoyaltyConfig => normalizeLoyaltyConfig(config ?? seedData.loyaltyConfig);

const hydratePosData = (data: Partial<PosData>): PosData => {
  const categoryOrder = Array.isArray(data.categoryOrder)
    ? data.categoryOrder
        .map((category) => String(category).trim())
        .filter(Boolean)
    : seedData.categoryOrder;

  return {
    categoryOrder,
    store: hydrateStore(data.store),
    security: hydrateSecurity(data.security),
    customers: data.customers ?? [],
    discounts: Array.isArray(data.discounts) ? data.discounts : seedData.discounts,
    loyaltyConfig: hydrateLoyaltyConfig(data.loyaltyConfig),
    tables: Array.isArray(data.tables) ? data.tables : seedData.tables,
    receipts: (data.receipts ?? []).map(hydrateReceipt),
    products: (data.products ?? [])
      .filter((product) => !LEGACY_SAMPLE_PRODUCT_IDS.has(product.id))
      .map((product) => ({
        ...product,
        imageUrl: product.imageUrl ?? "",
        taxEnabled: product.taxEnabled ?? true,
        trackStock: product.trackStock ?? false,
        active: product.active ?? true
      }))
  };
};

export const loadPosData = (): PosData => {
  const raw = window.localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return hydratePosData(seedData);
  }

  try {
    return hydratePosData(
      repairPersistedLanguage(JSON.parse(raw)) as Partial<PosData>
    );
  } catch {
    return hydratePosData(seedData);
  }
};

export const savePosData = (data: PosData) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
};

export const makeId = (prefix: string) => {
  const random =
    window.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
};
