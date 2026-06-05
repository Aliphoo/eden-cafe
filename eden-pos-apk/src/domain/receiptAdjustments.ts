import type {
  CartLine,
  Receipt,
  RefundLine,
  RefundRequestLine
} from "./pos";

const safeNumber = (value: unknown) =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const roundMoney = (value: number) => Math.round(safeNumber(value));

export const receiptLineKey = (line: CartLine, index = 0) =>
  [
    index,
    line.sourceProductId || line.productId.split("::")[0] || line.productId,
    line.productId,
    line.variantId || "base",
    line.sku || "",
    line.unitPrice,
    line.note || ""
  ].join("::");

export const receiptRefunds = (receipt: Receipt) =>
  (receipt.refundAdjustments ?? []).filter(
    (adjustment) => adjustment.status === "completed"
  );

export const receiptTotalRefunded = (receipt: Receipt) =>
  receiptRefunds(receipt).reduce(
    (sum, adjustment) => sum + Math.max(adjustment.amount, 0),
    0
  );

export const receiptRefundedDiscount = (receipt: Receipt) =>
  receiptRefunds(receipt).reduce(
    (sum, adjustment) => sum + Math.max(adjustment.discount, 0),
    0
  );

export const receiptRefundedTax = (receipt: Receipt) =>
  receiptRefunds(receipt).reduce(
    (sum, adjustment) => sum + Math.max(adjustment.taxIncluded, 0),
    0
  );

export const receiptNetTotal = (receipt: Receipt) =>
  Math.max(roundMoney((receipt.totalAmount ?? receipt.total) - receiptTotalRefunded(receipt)), 0);

export const receiptNetDiscount = (receipt: Receipt) =>
  Math.max(roundMoney((receipt.discount ?? 0) - receiptRefundedDiscount(receipt)), 0);

export const receiptNetTaxIncluded = (receipt: Receipt) =>
  Math.max(roundMoney((receipt.taxIncluded ?? receipt.tax ?? 0) - receiptRefundedTax(receipt)), 0);

export const receiptRefundStatus = (
  receipt: Receipt
): NonNullable<Receipt["refundStatus"]> => {
  const refunded = receiptTotalRefunded(receipt);
  if (refunded <= 0) return "none";
  return refunded >= Math.max(receipt.totalAmount ?? receipt.total, receipt.total)
    ? "full"
    : "partial";
};

export const receiptLineRefundedQuantity = (
  receipt: Receipt,
  lineKey: string
) =>
  receiptRefunds(receipt).reduce(
    (sum, adjustment) =>
      sum +
      adjustment.lines
        .filter((line) => line.lineKey === lineKey)
        .reduce((lineSum, line) => lineSum + Math.max(line.quantity, 0), 0),
    0
  );

export const receiptLineRemainingQuantity = (
  receipt: Receipt,
  line: CartLine,
  index = 0
) =>
  Math.max(
    Math.max(line.quantity, 0) -
      receiptLineRefundedQuantity(receipt, receiptLineKey(line, index)),
    0
  );

export const receiptOrderDiscount = (receipt: Receipt) => {
  const lineDiscount = receipt.items.reduce(
    (sum, line) => sum + Math.max(line.lineDiscount ?? 0, 0),
    0
  );
  return Math.max((receipt.discount ?? 0) - lineDiscount, 0);
};

export const buildRefundLines = (
  receipt: Receipt,
  selections: RefundRequestLine[],
  taxRate = 0
): Array<Omit<RefundLine, "id">> => {
  const selectionByKey = new Map(
    selections
      .filter((selection) => selection.quantity > 0)
      .map((selection) => [selection.lineKey, selection])
  );
  const orderDiscount = receiptOrderDiscount(receipt);
  const subtotalAfterLineDiscount = receipt.items.reduce((sum, line) => {
    const gross = Math.max(line.unitPrice, 0) * Math.max(line.quantity, 0);
    return sum + Math.max(gross - Math.max(line.lineDiscount ?? 0, 0), 0);
  }, 0);
  const taxRatio =
    receipt.total > 0
      ? Math.max(receipt.taxIncluded ?? receipt.tax ?? 0, 0) /
        Math.max(receipt.total, 1)
      : taxRate > 0
        ? taxRate / (1 + taxRate)
        : 0;

  return receipt.items.flatMap((line, index) => {
    const lineKey = receiptLineKey(line, index);
    const selection = selectionByKey.get(lineKey);
    if (!selection) return [];

    const remaining = receiptLineRemainingQuantity(receipt, line, index);
    const quantity = clamp(Math.floor(selection.quantity), 0, remaining);
    if (quantity <= 0) return [];

    const gross = Math.max(line.unitPrice, 0) * quantity;
    const lineDiscount = roundMoney(
      (Math.max(line.lineDiscount ?? 0, 0) / Math.max(line.quantity, 1)) *
        quantity
    );
    const lineNetBeforeOrderDiscount = Math.max(
      Math.max(line.unitPrice, 0) * Math.max(line.quantity, 0) -
        Math.max(line.lineDiscount ?? 0, 0),
      0
    );
    const orderDiscountShare = roundMoney(
      subtotalAfterLineDiscount > 0
        ? orderDiscount *
            (lineNetBeforeOrderDiscount / subtotalAfterLineDiscount) *
            (quantity / Math.max(line.quantity, 1))
        : 0
    );
    const discount = Math.min(lineDiscount + orderDiscountShare, gross);
    const netAmount = Math.max(gross - discount, 0);
    const taxIncluded = line.taxEnabled === false ? 0 : roundMoney(netAmount * taxRatio);

    return [
      {
        lineKey,
        productId: line.productId,
        sourceProductId: line.sourceProductId,
        variantId: line.variantId,
        variantName: line.variantName,
        sku: line.sku,
        name: line.name,
        category: line.category,
        quantity,
        unitPrice: line.unitPrice,
        cost: Math.max(line.cost ?? 0, 0),
        grossAmount: gross,
        lineDiscount,
        orderDiscountShare,
        discount,
        taxIncluded,
        netAmount,
        note: line.note,
        stockAction: selection.stockAction
      }
    ];
  });
};

export const refundLinesTotal = (lines: Array<Pick<RefundLine, "netAmount">>) =>
  lines.reduce((sum, line) => sum + Math.max(line.netAmount, 0), 0);

export const refundLinesDiscount = (
  lines: Array<Pick<RefundLine, "discount">>
) => lines.reduce((sum, line) => sum + Math.max(line.discount, 0), 0);

export const refundLinesTax = (
  lines: Array<Pick<RefundLine, "taxIncluded">>
) => lines.reduce((sum, line) => sum + Math.max(line.taxIncluded, 0), 0);
