import type { Receipt } from "./pos";

type ReceiptDateLike = Pick<
  Partial<Receipt>,
  "businessDate" | "closedAt" | "createdAt" | "openedAt" | "paidAt" | "paymentStatus"
>;

export const localDateKey = (date: Date = new Date()) => {
  const safeDate =
    date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const local = new Date(safeDate.getTime() - safeDate.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

const isDateKey = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const parseDate = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const firstValidDateValue = (...values: unknown[]) => {
  for (const value of values) {
    const date = parseDate(value);
    if (date) return String(value);
  }
  return "";
};

export const receiptOpenedAtValue = (receipt: ReceiptDateLike) =>
  firstValidDateValue(
    receipt.openedAt,
    receipt.createdAt,
    receipt.paidAt,
    receipt.closedAt
  );

export const receiptPaidAtValue = (receipt: ReceiptDateLike) => {
  if (receipt.paymentStatus !== "paid") return "";
  return firstValidDateValue(receipt.paidAt, receipt.closedAt);
};

export const receiptReportDateTime = (receipt: ReceiptDateLike) =>
  receipt.paymentStatus === "paid"
    ? receiptPaidAtValue(receipt) ||
      (isDateKey(receipt.businessDate) ? `${receipt.businessDate}T00:00:00` : "") ||
      receiptOpenedAtValue(receipt)
    : receiptOpenedAtValue(receipt);

export const receiptReportDateKey = (receipt: ReceiptDateLike) => {
  if (receipt.paymentStatus === "paid") {
    const paidAt = parseDate(receiptPaidAtValue(receipt));
    if (paidAt) return localDateKey(paidAt);
    if (isDateKey(receipt.businessDate)) return receipt.businessDate;
    const fallback = parseDate(receiptOpenedAtValue(receipt));
    return fallback ? localDateKey(fallback) : localDateKey();
  }

  if (isDateKey(receipt.businessDate)) return receipt.businessDate;
  const openedAt = parseDate(receiptOpenedAtValue(receipt));
  return openedAt ? localDateKey(openedAt) : localDateKey();
};

export const receiptReportTimestamp = (receipt: ReceiptDateLike) => {
  const reportDate = parseDate(receiptReportDateTime(receipt));
  return reportDate ? reportDate.getTime() : 0;
};
