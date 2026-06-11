import type { CartLine, Receipt, StoreProfile } from "./pos";

const safeNumber = (value: unknown) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
};

export const formatNumber = (value: unknown, fractionDigits = 0) => {
  const digits = Math.max(0, Math.min(fractionDigits, 6));
  const fixed = safeNumber(value).toFixed(digits);
  const [integerPart, decimalPart] = fixed.split(".");
  const sign = integerPart.startsWith("-") ? "-" : "";
  const integer = integerPart.replace(/^-/, "");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return decimalPart ? `${sign}${grouped}.${decimalPart}` : `${sign}${grouped}`;
};

export const formatCurrency = (value: unknown) =>
  `฿${formatNumber(Math.round(safeNumber(value)))}`;

export const formatBaht = formatCurrency;

export const calculateTotals = (
  lines: CartLine[],
  store: StoreProfile,
  discount = 0
) => {
  const subtotal = lines.reduce(
    (sum, line) => sum + line.unitPrice * line.quantity,
    0
  );
  const lineDiscount = lines.reduce((sum, line) => {
    const lineSubtotal = line.unitPrice * line.quantity;
    return sum + Math.min(Math.max(line.lineDiscount ?? 0, 0), lineSubtotal);
  }, 0);
  const subtotalAfterLineDiscount = Math.max(subtotal - lineDiscount, 0);
  const orderDiscount = Math.min(Math.max(discount, 0), subtotalAfterLineDiscount);
  const safeDiscount = lineDiscount + orderDiscount;
  const total = Math.max(subtotal - safeDiscount, 0);
  const taxableSubtotal = lines
    .filter((line) => line.taxEnabled !== false)
    .reduce((sum, line) => {
      const lineSubtotal = line.unitPrice * line.quantity;
      const lineDiscountAmount = Math.min(
        Math.max(line.lineDiscount ?? 0, 0),
        lineSubtotal
      );
      return sum + Math.max(lineSubtotal - lineDiscountAmount, 0);
    }, 0);
  const taxableAfterDiscount =
    subtotalAfterLineDiscount > 0
      ? Math.max(
          taxableSubtotal -
            orderDiscount * (taxableSubtotal / subtotalAfterLineDiscount),
          0
        )
      : 0;
  const tax =
    store.taxRate > 0
      ? Math.round((taxableAfterDiscount * store.taxRate) / (1 + store.taxRate))
      : 0;

  return {
    subtotal,
    discount: safeDiscount,
    lineDiscount,
    orderDiscount,
    tax,
    taxIncluded: tax,
    total
  };
};

export const createReceiptNumber = (
  prefix: string,
  now = new Date()
) => {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timePart = now.toTimeString().slice(0, 8).replace(/:/g, "");
  return `${prefix}-${datePart}-${timePart}`;
};

export const createRefundNumber = (now = new Date()) =>
  createReceiptNumber("RF", now);

export const paymentMethodLabel = (method: string) =>
  (
    {
      cash: "เงินสด",
      transfer: "โอนเงิน",
      thai_chuay_thai_plus: "ไทยช่วยไทยพลัส",
      qr: "QR Payment",
      card: "บัตร",
      other: "อื่น ๆ"
    } as Record<string, string>
  )[method] ?? method;
