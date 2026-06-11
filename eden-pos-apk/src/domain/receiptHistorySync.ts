import type {
  CartLine,
  PaymentAdjustment,
  PaymentMethod,
  Receipt,
  RefundAdjustment,
  RefundReasonCode,
  RefundStockAction
} from "./pos";
import { receiptRefundStatus } from "./receiptAdjustments";
import { receiptReportTimestamp } from "./receiptDates";

export type BackendPosOrder = Record<string, unknown> & {
  firestoreId?: string;
};

export type ReceiptHistoryMergeResult = {
  receipts: Receipt[];
  imported: number;
  updated: number;
  skipped: number;
  conflicts: Array<{
    number: string;
    reason: string;
  }>;
};

const PAYMENT_METHODS = new Set<PaymentMethod>([
  "cash",
  "transfer",
  "thai_chuay_thai_plus",
  "qr",
  "card",
  "other"
]);

const REFUND_REASON_CODES = new Set<RefundReasonCode>([
  "missing_item",
  "incomplete_order",
  "overcharged",
  "out_of_stock_after_payment",
  "customer_return",
  "other"
]);

const REFUND_STOCK_ACTIONS = new Set<RefundStockAction>([
  "no_stock_return",
  "return_to_stock"
]);

const safeString = (value: unknown, fallback = "") => {
  const text = String(value ?? "").trim();
  return text || fallback;
};

const safeNumber = (value: unknown, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const safeBoolean = (value: unknown, fallback = false) =>
  typeof value === "boolean" ? value : fallback;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const timestampToMillis = (value: unknown): number => {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const record = asRecord(value);
  const toDate = record.toDate;
  if (typeof toDate === "function") {
    const parsed = toDate.call(value);
    if (parsed instanceof Date) return parsed.getTime();
  }

  const seconds = safeNumber(record.seconds);
  if (seconds) return seconds * 1000 + safeNumber(record.nanoseconds) / 1_000_000;
  return 0;
};

const timestampToIso = (value: unknown, fallback = new Date().toISOString()) => {
  const millis = timestampToMillis(value);
  return millis ? new Date(millis).toISOString() : fallback;
};

const localDateKey = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

const safeBusinessDate = (value: unknown, referenceDate: string) => {
  const raw = safeString(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(referenceDate);
  return Number.isFinite(parsed.getTime())
    ? localDateKey(parsed)
    : localDateKey(new Date());
};

const normalizePaymentMethod = (value: unknown): PaymentMethod => {
  const method = safeString(value).toLowerCase() as PaymentMethod;
  return PAYMENT_METHODS.has(method) ? method : "other";
};

const normalizePaymentStatus = (
  value: unknown,
  status: string
): Receipt["paymentStatus"] => {
  const paymentStatus = safeString(value).toLowerCase();
  if (paymentStatus === "paid") return "paid";
  if (paymentStatus === "failed") return "failed";
  if (paymentStatus === "refunded") return "refunded";
  if (status === "completed") return "paid";
  return "pending";
};

const normalizeStatus = (value: unknown): Receipt["status"] => {
  const status = safeString(value).toLowerCase();
  if (status === "processing") return "processing";
  if (status === "completed" || status === "paid") return "completed";
  if (status === "cancelled" || status === "voided") return "cancelled";
  return "pending";
};

const normalizeBillStatus = (
  value: unknown,
  status: Receipt["status"],
  paymentStatus: Receipt["paymentStatus"],
  isOpenBill: boolean
): Receipt["billStatus"] => {
  const billStatus = safeString(value).toLowerCase();
  if (billStatus === "cancelled" || status === "cancelled") return "cancelled";
  if (billStatus === "paid" || paymentStatus === "paid") return "paid";
  if (isOpenBill || billStatus === "open") return "open";
  return "open";
};

const normalizeRefundReasonCode = (value: unknown): RefundReasonCode => {
  const code = safeString(value).toLowerCase() as RefundReasonCode;
  return REFUND_REASON_CODES.has(code) ? code : "other";
};

const normalizeRefundStockAction = (value: unknown): RefundStockAction => {
  const action = safeString(value).toLowerCase() as RefundStockAction;
  return REFUND_STOCK_ACTIONS.has(action) ? action : "no_stock_return";
};

export const isBackendPosOrder = (order: BackendPosOrder) => {
  const source = safeString(order.source).toLowerCase();
  const orderType = safeString(order.orderType).toLowerCase();
  return source === "pos" || orderType === "pos";
};

const orderItemToCartLine = (value: unknown, index: number): CartLine | null => {
  const item = asRecord(value);
  const sourceProductId = safeString(
    item.sourceProductId || item.productId || item.id,
    `imported-product-${index + 1}`
  );
  const variantId = safeString(item.variantId, "base");
  const productId =
    variantId && variantId !== "base"
      ? `${sourceProductId}::${variantId}`
      : sourceProductId;
  const quantity = Math.max(1, safeNumber(item.quantity, 1));
  const unitPrice = safeNumber(
    item.unitPrice ?? item.price,
    safeNumber(item.lineTotal) / quantity
  );

  return {
    productId,
    sourceProductId,
    variantId,
    variantName: safeString(item.variantName),
    sku: safeString(item.sku),
    name: safeString(item.name, `Imported item ${index + 1}`),
    category: safeString(item.category, "ไม่ระบุหมวดหมู่"),
    unitPrice,
    cost: safeNumber(item.cost),
    note: safeString(item.note),
    lineDiscount: safeNumber(item.lineDiscount ?? item.discount),
    lineDiscountRate: safeNumber(item.lineDiscountRate),
    lineDiscountLabel: safeString(item.lineDiscountLabel),
    taxEnabled: item.taxEnabled === undefined ? true : safeBoolean(item.taxEnabled, true),
    quantity
  };
};

const normalizePaymentAdjustments = (value: unknown): PaymentAdjustment[] =>
  asArray(value).map((item, index) => {
    const adjustment = asRecord(item);
    return {
      id: safeString(adjustment.id, `payment-adjustment-${index + 1}`),
      adjustedAt: timestampToIso(adjustment.adjustedAt),
      adjustedByUid: safeString(adjustment.adjustedByUid),
      adjustedByName: safeString(adjustment.adjustedByName, "Eden Admin"),
      adjustedByEmail: safeString(adjustment.adjustedByEmail),
      previousPaymentMethod: normalizePaymentMethod(adjustment.previousPaymentMethod),
      previousPaymentLabel: safeString(adjustment.previousPaymentLabel),
      nextPaymentMethod: normalizePaymentMethod(adjustment.nextPaymentMethod),
      nextPaymentLabel: safeString(adjustment.nextPaymentLabel),
      amount: safeNumber(adjustment.amount),
      reason: safeString(adjustment.reason)
    };
  });

const normalizeRefundAdjustments = (value: unknown): RefundAdjustment[] =>
  asArray(value).map((item, index) => {
    const adjustment = asRecord(item);
    const lines = asArray(adjustment.lines).map((lineValue, lineIndex) => {
      const line = asRecord(lineValue);
      return {
        id: safeString(line.id, `refund-line-${lineIndex + 1}`),
        lineKey: safeString(line.lineKey),
        productId: safeString(line.productId, `refund-product-${lineIndex + 1}`),
        sourceProductId: safeString(line.sourceProductId || line.productId),
        variantId: safeString(line.variantId, "base"),
        variantName: safeString(line.variantName),
        sku: safeString(line.sku),
        name: safeString(line.name, `Refund item ${lineIndex + 1}`),
        category: safeString(line.category, "ไม่ระบุหมวดหมู่"),
        quantity: safeNumber(line.quantity),
        unitPrice: safeNumber(line.unitPrice),
        cost: safeNumber(line.cost),
        grossAmount: safeNumber(line.grossAmount),
        lineDiscount: safeNumber(line.lineDiscount),
        orderDiscountShare: safeNumber(line.orderDiscountShare),
        discount: safeNumber(line.discount),
        taxIncluded: safeNumber(line.taxIncluded),
        netAmount: safeNumber(line.netAmount),
        note: safeString(line.note),
        stockAction: normalizeRefundStockAction(line.stockAction)
      };
    });

    return {
      id: safeString(adjustment.id, `refund-${index + 1}`),
      refundNo: safeString(adjustment.refundNo, `RF-${index + 1}`),
      createdAt: timestampToIso(adjustment.createdAt),
      businessDate: safeBusinessDate(
        adjustment.businessDate,
        timestampToIso(adjustment.createdAt)
      ),
      reasonCode: normalizeRefundReasonCode(adjustment.reasonCode),
      reason: safeString(adjustment.reason, "คืนเงิน"),
      note: safeString(adjustment.note),
      status: "completed",
      paymentMethod: normalizePaymentMethod(adjustment.paymentMethod),
      paymentLabel: safeString(adjustment.paymentLabel),
      subtotal: safeNumber(adjustment.subtotal),
      discount: safeNumber(adjustment.discount),
      taxIncluded: safeNumber(adjustment.taxIncluded),
      amount: safeNumber(adjustment.amount),
      lines,
      cashierUid: safeString(adjustment.cashierUid),
      cashierName: safeString(adjustment.cashierName, "Eden POS"),
      cashierEmail: safeString(adjustment.cashierEmail),
      approvedByUid: safeString(adjustment.approvedByUid),
      approvedByName: safeString(adjustment.approvedByName, "Eden Admin"),
      approvedByEmail: safeString(adjustment.approvedByEmail),
      approvedByRole: safeString(adjustment.approvedByRole, "admin")
    };
  });

export const backendOrderToReceipt = (
  firestoreId: string,
  order: BackendPosOrder
): Receipt | null => {
  if (!isBackendPosOrder(order)) return null;

  const items = asArray(order.items)
    .map(orderItemToCartLine)
    .filter((item): item is CartLine => Boolean(item));
  if (!items.length) return null;

  const number = safeString(order.receiptNo || order.id, firestoreId);
  const createdAt = timestampToIso(
    order.createdAt || order.openedAt || order.timestamp || order.date
  );
  const status = normalizeStatus(order.status);
  const paymentStatus = normalizePaymentStatus(order.paymentStatus, status);
  const openedAt = timestampToIso(order.openedAt || order.createdAt, createdAt);
  const closedAt = timestampToIso(order.closedAt, "");
  const paidAt =
    paymentStatus === "paid"
      ? timestampToIso(order.paidAt || order.closedAt, "")
      : "";
  const businessDate =
    paymentStatus === "paid" && paidAt
      ? safeBusinessDate("", paidAt)
      : safeBusinessDate(
          order.businessDate,
          paymentStatus === "paid" ? paidAt || closedAt || createdAt : openedAt
        );
  const isOpenBill = safeBoolean(
    order.isOpenBill,
    paymentStatus !== "paid" && status !== "cancelled"
  );
  const billStatus = normalizeBillStatus(
    order.billStatus,
    status,
    paymentStatus,
    isOpenBill
  );
  const paymentMethod = normalizePaymentMethod(order.paymentMethod);
  const subtotal = safeNumber(
    order.subtotal,
    items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
  );
  const discount = safeNumber(order.originalDiscount ?? order.discount);
  const taxIncluded = safeNumber(order.originalTaxIncluded ?? order.taxIncluded);
  const total = safeNumber(
    order.originalTotalAmount ?? order.originalTotal ?? order.totalAmount ?? order.total,
    Math.max(subtotal - discount, 0)
  );
  const loyaltyDiscount = safeNumber(order.loyaltyDiscount);
  const normalDiscount = safeNumber(order.normalDiscount, Math.max(discount - loyaltyDiscount, 0));
  const refundAdjustments = normalizeRefundAdjustments(order.refundAdjustments);
  const receipt: Receipt = {
    id: safeString(order.localReceiptId, `receipt-${firestoreId}`),
    number,
    firestoreId,
    createdAt,
    openedAt,
    paidAt,
    closedAt,
    businessDate,
    items,
    subtotal,
    discount,
    normalDiscount,
    loyaltyDiscount,
    totalBeforeLoyalty: safeNumber(order.totalBeforeLoyalty, total + loyaltyDiscount),
    tax: taxIncluded,
    taxIncluded,
    total,
    totalAmount: total,
    paid: safeNumber(order.paidAmount, paymentStatus === "paid" ? total : 0),
    paidAmount: safeNumber(order.paidAmount, paymentStatus === "paid" ? total : 0),
    change: safeNumber(order.changeAmount),
    changeAmount: safeNumber(order.changeAmount),
    paymentMethod,
    paymentLabel: safeString(order.paymentLabel, paymentStatus === "paid" ? paymentMethod : "ค้างชำระ"),
    customerName: safeString(order.customerName, "Walk-in Customer"),
    phone: safeString(order.phone),
    tableId: safeString(order.tableId),
    tableNumber: safeString(order.tableNumber),
    tableName: safeString(order.tableName),
    tableZone: safeString(order.tableZone),
    customerUid: safeString(order.customerUid),
    customerEmail: safeString(order.customerEmail),
    customerLineId: safeString(order.customerLineId),
    customerTier: safeString(order.customerTier),
    customerMemberCode: safeString(order.customerMemberCode),
    customerProfileSynced: safeBoolean(order.customerProfileSynced),
    note: safeString(order.note),
    source: "pos",
    orderType: "pos",
    status,
    paymentStatus,
    billStatus,
    isOpenBill: billStatus === "open" || isOpenBill,
    orderMode:
      billStatus === "open" || safeString(order.orderMode) === "open_bill"
        ? "open_bill"
        : "pay_now",
    syncStatus: "synced",
    syncError: "",
    isTestOrder: safeBoolean(order.isTestOrder),
    softLaunch: safeBoolean(order.softLaunch),
    loyalty: asRecord(order.loyalty) as Receipt["loyalty"],
    loyaltyRedemption: asRecord(order.loyaltyRedemption) as Receipt["loyaltyRedemption"],
    earnedPoints: safeNumber(order.earnedPoints),
    redeemedPoints: safeNumber(order.redeemedPoints),
    loyaltySyncStatus:
      safeString(order.loyaltySyncStatus) as Receipt["loyaltySyncStatus"] || "skipped",
    loyaltyError: safeString(order.loyaltyError),
    loyaltySkipReason: safeString(order.loyaltySkipReason) as Receipt["loyaltySkipReason"],
    loyaltyIdempotencyKey: safeString(order.loyaltyIdempotencyKey, number),
    loyaltySyncedAt: timestampToIso(order.loyaltySyncedAt, ""),
    paymentAdjustments: normalizePaymentAdjustments(order.paymentAdjustments),
    paymentAdjustedAt: timestampToIso(order.paymentAdjustedAt, ""),
    paymentAdjustedBy: safeString(order.paymentAdjustedBy),
    refundAdjustments,
    refundedAmount: safeNumber(order.refundedAmount ?? order.refundTotal),
    refundedAt: timestampToIso(order.refundedAt, ""),
    refundedBy: safeString(order.refundedBy),
    cancelledAt: timestampToIso(order.cancelledAt || order.voidedAt, ""),
    cancelledBy: safeString(order.cancelledBy || order.voidedByName || order.voidedBy),
    restoredAt: timestampToIso(order.restoredAt, ""),
    restoredBy: safeString(order.restoredBy),
    orderTicketPrintedItems: [],
    orderTicketPrintedAt: ""
  };

  return {
    ...receipt,
    refundStatus: receiptRefundStatus(receipt)
  };
};

const receiptIdentityKeys = (receipt: Receipt) =>
  [
    receipt.firestoreId ? `firestore:${receipt.firestoreId}` : "",
    receipt.number ? `number:${receipt.number}` : "",
    receipt.id ? `id:${receipt.id}` : ""
  ].filter(Boolean);

const receiptUpdatedTime = (receipt: Receipt) =>
  Math.max(
    timestampToMillis(receipt.restoredAt),
    timestampToMillis(receipt.cancelledAt),
    timestampToMillis(receipt.refundedAt),
    timestampToMillis(receipt.paymentAdjustedAt),
    timestampToMillis(receipt.paidAt),
    timestampToMillis(receipt.closedAt),
    timestampToMillis(receipt.openedAt),
    timestampToMillis(receipt.createdAt)
  );

const shouldProtectLocalReceipt = (receipt: Receipt) =>
  receipt.syncStatus !== "synced" ||
  receipt.billStatus === "open" ||
  receipt.isOpenBill === true;

export const mergeReceiptHistory = (
  localReceipts: Receipt[],
  remoteReceipts: Receipt[]
): ReceiptHistoryMergeResult => {
  const merged = [...localReceipts];
  const indexByKey = new Map<string, number>();

  merged.forEach((receipt, index) => {
    receiptIdentityKeys(receipt).forEach((key) => indexByKey.set(key, index));
  });

  const result: ReceiptHistoryMergeResult = {
    receipts: merged,
    imported: 0,
    updated: 0,
    skipped: 0,
    conflicts: []
  };

  remoteReceipts.forEach((remote) => {
    const matchIndex = receiptIdentityKeys(remote)
      .map((key) => indexByKey.get(key))
      .find((index): index is number => typeof index === "number");

    if (matchIndex === undefined) {
      result.receipts.unshift(remote);
      indexByKey.forEach((value, key) => {
        indexByKey.set(key, value + 1);
      });
      receiptIdentityKeys(remote).forEach((key) => indexByKey.set(key, 0));
      result.imported += 1;
      return;
    }

    const local = result.receipts[matchIndex];
    if (shouldProtectLocalReceipt(local)) {
      result.conflicts.push({
        number: remote.number,
        reason: "มีรายการในเครื่องที่ยังไม่ซิงค์หรือกำลังเปิดบิลอยู่"
      });
      return;
    }

    if (receiptUpdatedTime(remote) <= receiptUpdatedTime(local)) {
      result.skipped += 1;
      return;
    }

    const updated = {
      ...remote,
      id: local.id,
      number: remote.number || local.number,
      firestoreId: remote.firestoreId || local.firestoreId,
      syncStatus: "synced" as const,
      syncError: ""
    };
    result.receipts[matchIndex] = updated;
    receiptIdentityKeys(updated).forEach((key) => indexByKey.set(key, matchIndex));
    result.updated += 1;
  });

  result.receipts.sort(
    (a, b) =>
      (receiptReportTimestamp(b) || timestampToMillis(b.createdAt)) -
      (receiptReportTimestamp(a) || timestampToMillis(a.createdAt))
  );
  return result;
};
