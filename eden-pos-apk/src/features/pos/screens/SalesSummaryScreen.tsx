import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Download,
  ReceiptText,
  Tags,
  TrendingUp,
  WalletCards
} from "lucide-react";
import { useMemo, useState } from "react";
import { formatCurrency } from "../../../domain/money";
import type { PaymentMethod, Receipt } from "../../../domain/pos";
import {
  receiptNetDiscount,
  receiptNetTaxIncluded,
  receiptNetTotal,
  receiptRefunds,
  receiptTotalRefunded
} from "../../../domain/receiptAdjustments";

type SalesSummaryScreenProps = {
  receipts: Receipt[];
};

type ReportSection =
  | "summary"
  | "products"
  | "categories"
  | "payments"
  | "paymentAdjustments"
  | "refunds"
  | "receipts"
  | "discounts"
  | "tax";

type SummaryRow = {
  key: string;
  label: string;
  quantity: number;
  sales: number;
  subtitle?: string;
};

type CategoryExportRow = SummaryRow & {
  cost: number;
  grossProfit: number;
};

type ExcelValue = string | number | null | undefined;

type ExcelSection = {
  title: string;
  headers: string[];
  rows: ExcelValue[][];
};

type SalesRangePreset = "today" | "yesterday" | "week" | "month" | "custom";

type SalesDateRange = {
  start: string;
  end: string;
};

type ReportLine = {
  sourceProductId?: string;
  productId: string;
  variantId?: string;
  category: string;
  name: string;
  variantName?: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  lineDiscount?: number;
  cost?: number;
};

const reportSections: Array<{ id: ReportSection; label: string }> = [
  { id: "summary", label: "สรุปยอดขาย" },
  { id: "products", label: "ยอดขายตามสินค้า" },
  { id: "categories", label: "ยอดขาย แยกตาม หมวดหมู่" },
  { id: "payments", label: "ยอดขาย แยกตาม ประเภทการชำระเงิน" },
  { id: "paymentAdjustments", label: "ประวัติปรับช่องทาง" },
  { id: "refunds", label: "คืนเงิน" },
  { id: "receipts", label: "ใบเสร็จรับเงิน" },
  { id: "discounts", label: "ส่วนลด" },
  { id: "tax", label: "ภาษี" }
];

const paymentLabels: Record<PaymentMethod, string> = {
  cash: "เงินสด",
  transfer: "โอนเงิน",
  thai_chuay_thai_plus: "ไทยช่วยไทยพลัส",
  qr: "QR Payment",
  card: "บัตร",
  other: "อื่น ๆ"
};

const dateKey = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

const receiptDateKey = (receipt: Receipt) =>
  receipt.businessDate || dateKey(new Date(receipt.createdAt));

const todayKey = () => dateKey(new Date());

const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateKey(date);
};

const normalizeDateRange = (range: SalesDateRange): SalesDateRange =>
  range.start <= range.end ? range : { start: range.end, end: range.start };

const presetDateRange = (
  preset: Exclude<SalesRangePreset, "custom">,
  anchor = todayKey()
): SalesDateRange => {
  if (preset === "yesterday") {
    const yesterday = addDays(anchor, -1);
    return { start: yesterday, end: yesterday };
  }

  if (preset === "week") {
    return { start: addDays(anchor, -6), end: anchor };
  }

  if (preset === "month") {
    return { start: addDays(anchor, -29), end: anchor };
  }

  return { start: anchor, end: anchor };
};

const rangeLengthDays = (range: SalesDateRange) => {
  const normalized = normalizeDateRange(range);
  const start = new Date(`${normalized.start}T00:00:00`).getTime();
  const end = new Date(`${normalized.end}T00:00:00`).getTime();
  return Math.max(Math.round((end - start) / 86_400_000) + 1, 1);
};

const shiftDateRange = (
  range: SalesDateRange,
  preset: SalesRangePreset,
  direction: -1 | 1
): SalesDateRange => {
  const normalized = normalizeDateRange(range);
  const step =
    preset === "week"
      ? 7
      : preset === "month"
        ? 30
        : preset === "custom"
          ? rangeLengthDays(normalized)
          : 1;

  return {
    start: addDays(normalized.start, step * direction),
    end: addDays(normalized.end, step * direction)
  };
};

const formatRangeLabel = (start: string, end: string) => {
  const formatter = new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });

  return `${formatter.format(new Date(`${start}T00:00:00`))} - ${formatter.format(
    new Date(`${end}T00:00:00`)
  )}`;
};

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat("th-TH", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));

const receiptLineSales = (line: ReportLine) =>
  Math.max(line.unitPrice * line.quantity - Math.max(line.lineDiscount ?? 0, 0), 0);

const receiptLineCost = (line: ReportLine) =>
  Math.max(line.cost ?? 0, 0) * Math.max(line.quantity, 0);

const receiptCost = (receipt: Receipt) =>
  receipt.items.reduce(
    (sum, item) => sum + Math.max(item.cost ?? 0, 0) * item.quantity,
    0
  );

const receiptRefundCost = (receipt: Receipt) =>
  receiptRefunds(receipt).reduce(
    (sum, refund) =>
      sum +
      refund.lines.reduce(
        (lineSum, line) => lineSum + Math.max(line.cost ?? 0, 0) * line.quantity,
        0
      ),
    0
  );

const receiptNetCost = (receipt: Receipt) =>
  Math.max(receiptCost(receipt) - receiptRefundCost(receipt), 0);

const receiptQuantity = (receipt: Receipt) =>
  receipt.items.reduce((sum, item) => sum + item.quantity, 0);

const receiptRefundQuantity = (receipt: Receipt) =>
  receiptRefunds(receipt).reduce(
    (sum, refund) =>
      sum + refund.lines.reduce((lineSum, line) => lineSum + line.quantity, 0),
    0
  );

const receiptNetQuantity = (receipt: Receipt) =>
  Math.max(receiptQuantity(receipt) - receiptRefundQuantity(receipt), 0);

const receiptSubtotal = (receipt: Receipt) =>
  receipt.items.reduce((sum, item) => sum + Math.max(item.unitPrice, 0) * item.quantity, 0);

const aggregateRows = (
  receipts: Receipt[],
  keyForLine: (line: ReportLine) => string,
  labelForLine: (line: ReportLine) => string,
  subtitleForLine?: (line: ReportLine) => string
) => {
  const map = new Map<string, SummaryRow>();

  receipts.forEach((receipt) => {
    receipt.items.forEach((line) => {
      const key = keyForLine(line);
      const current = map.get(key) ?? {
        key,
        label: labelForLine(line),
        quantity: 0,
        sales: 0,
        subtitle: subtitleForLine?.(line)
      };

      map.set(key, {
        ...current,
        quantity: current.quantity + line.quantity,
        sales: current.sales + receiptLineSales(line)
      });
    });

    receiptRefunds(receipt).forEach((refund) => {
      refund.lines.forEach((line) => {
        const key = keyForLine(line);
        const current = map.get(key) ?? {
          key,
          label: labelForLine(line),
          quantity: 0,
          sales: 0,
          subtitle: subtitleForLine?.(line)
        };

        map.set(key, {
          ...current,
          quantity: current.quantity - line.quantity,
          sales: current.sales - Math.max(line.netAmount, 0)
        });
      });
    });
  });

  return Array.from(map.values()).sort((a, b) => b.sales - a.sales);
};

const escapeHtml = (value: ExcelValue) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fileNamePart = (value: string) =>
  value
    .trim()
    .replace(/[^\u0e00-\u0e7fa-zA-Z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

const excelCell = (value: ExcelValue, tag: "td" | "th" = "td") => {
  const isNumber = typeof value === "number" && Number.isFinite(value);
  const style = isNumber ? ' style="mso-number-format:\'#,##0.00\';text-align:right;"' : "";

  return `<${tag}${style}>${escapeHtml(isNumber ? Number(value.toFixed(2)) : value)}</${tag}>`;
};

const buildExcelHtml = (
  title: string,
  subtitle: string,
  sections: ExcelSection[]
) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: "Noto Sans Thai", Arial, sans-serif; color: #173f30; }
    h1 { color: #137234; margin-bottom: 4px; }
    h2 { margin: 24px 0 8px; color: #174b38; }
    p { margin-top: 0; color: #5f6f68; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
    th { background: #137234; color: #ffffff; font-weight: 700; }
    th, td { border: 1px solid #cfded4; padding: 8px 10px; vertical-align: top; }
    tr:nth-child(even) td { background: #f4fbf6; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(subtitle)}</p>
  ${sections
    .map(
      (section) => `
        <h2>${escapeHtml(section.title)}</h2>
        <table>
          <thead>
            <tr>${section.headers.map((header) => excelCell(header, "th")).join("")}</tr>
          </thead>
          <tbody>
            ${section.rows
              .map((row) => `<tr>${row.map((cell) => excelCell(cell)).join("")}</tr>`)
              .join("")}
          </tbody>
        </table>
      `
    )
    .join("")}
</body>
</html>`;

const saveFile = async (fileName: string, blob: Blob) => {
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: fileName
      });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const downloadExcel = async (
  fileName: string,
  title: string,
  subtitle: string,
  sections: ExcelSection[]
) => {
  const html = buildExcelHtml(title, subtitle, sections);
  const blob = new Blob([`\uFEFF${html}`], {
    type: "application/vnd.ms-excel;charset=utf-8"
  });

  await saveFile(fileName, blob);
};

export const SalesSummaryScreen = ({ receipts }: SalesSummaryScreenProps) => {
  const [rangePreset, setRangePreset] = useState<SalesRangePreset>("today");
  const [dateRange, setDateRange] = useState<SalesDateRange>(() =>
    presetDateRange("today")
  );
  const [section, setSection] = useState<ReportSection>("summary");
  const normalizedDateRange = normalizeDateRange(dateRange);
  const rangeStart = normalizedDateRange.start;
  const rangeEnd = normalizedDateRange.end;

  const rangeReceipts = useMemo(
    () =>
      receipts.filter((receipt) => {
        const key = receiptDateKey(receipt);
        return key >= rangeStart && key <= rangeEnd;
      }),
    [rangeEnd, rangeStart, receipts]
  );
  const paidReceipts = rangeReceipts.filter(
    (receipt) => receipt.paymentStatus === "paid"
  );
  const pendingReceipts = rangeReceipts.filter(
    (receipt) => receipt.paymentStatus !== "paid"
  );

  const totals = useMemo(() => {
    const netSales = paidReceipts.reduce(
      (sum, receipt) => sum + receiptNetTotal(receipt),
      0
    );
    const discounts = paidReceipts.reduce(
      (sum, receipt) => sum + receiptNetDiscount(receipt),
      0
    );
    const taxIncluded = paidReceipts.reduce(
      (sum, receipt) => sum + receiptNetTaxIncluded(receipt),
      0
    );
    const cost = paidReceipts.reduce((sum, receipt) => sum + receiptNetCost(receipt), 0);
    const refunds = paidReceipts.reduce(
      (sum, receipt) => sum + receiptTotalRefunded(receipt),
      0
    );
    const pending = pendingReceipts.reduce((sum, receipt) => sum + receipt.total, 0);

    return {
      cost,
      discounts,
      grossProfit: Math.max(netSales - cost, 0),
      netSales,
      pending,
      refunds,
      taxIncluded
    };
  }, [paidReceipts, pendingReceipts, rangeReceipts]);

  const productRows = useMemo(
    () =>
      aggregateRows(
        paidReceipts,
        (line) => `${line.sourceProductId || line.productId}:${line.variantId || "base"}`,
        (line) => line.name,
        (line) => line.variantName || line.sku
      ),
    [paidReceipts]
  );
  const categoryRows = useMemo(
    () =>
      aggregateRows(
        paidReceipts,
        (line) => line.category || "ไม่ระบุหมวดหมู่",
        (line) => line.category || "ไม่ระบุหมวดหมู่"
      ),
    [paidReceipts]
  );
  const paymentRows = useMemo(() => {
    const map = new Map<PaymentMethod, SummaryRow>();
    paidReceipts.forEach((receipt) => {
      const current = map.get(receipt.paymentMethod) ?? {
        key: receipt.paymentMethod,
        label: paymentLabels[receipt.paymentMethod],
        quantity: 0,
        sales: 0
      };
      map.set(receipt.paymentMethod, {
        ...current,
        quantity: current.quantity + 1,
        sales: current.sales + receiptNetTotal(receipt)
      });
    });
    return Array.from(map.values()).sort((a, b) => b.sales - a.sales);
  }, [paidReceipts]);
  const paymentAdjustmentRows = useMemo(
    () =>
      paidReceipts
        .flatMap((receipt) =>
          (receipt.paymentAdjustments ?? []).flatMap((adjustment) => {
            const auditNote = `${receipt.number} · ${adjustment.previousPaymentLabel} → ${adjustment.nextPaymentLabel} · ${formatDateTime(adjustment.adjustedAt)} · ${adjustment.adjustedByName} · ${adjustment.reason}`;

            return [
              {
                key: `${receipt.id}-${adjustment.id}-out`,
                label: `${adjustment.previousPaymentLabel} (ปรับออก)`,
                quantity: 1,
                sales: -Math.abs(adjustment.amount),
                subtitle: auditNote
              },
              {
                key: `${receipt.id}-${adjustment.id}-in`,
                label: `${adjustment.nextPaymentLabel} (ปรับเข้า)`,
                quantity: 1,
                sales: Math.abs(adjustment.amount),
                subtitle: auditNote
              }
            ];
          })
        )
        .sort((a, b) => b.subtitle.localeCompare(a.subtitle, "th")),
    [paidReceipts]
  );
  const refundRows = useMemo(
    () =>
      paidReceipts
        .flatMap((receipt) =>
          receiptRefunds(receipt).map((refund) => ({
            key: refund.id,
            label: `${refund.refundNo} · ${receipt.number}`,
            quantity: refund.lines.reduce((sum, line) => sum + line.quantity, 0),
            sales: -Math.abs(refund.amount),
            subtitle: `${formatDateTime(refund.createdAt)} · ${refund.reason} · อนุมัติโดย ${refund.approvedByName}`
          }))
        )
        .sort((a, b) => b.subtitle.localeCompare(a.subtitle, "th")),
    [paidReceipts]
  );
  const discountRows: SummaryRow[] = [
    {
      key: "discounts",
      label: "ส่วนลดทั้งหมด",
      quantity: paidReceipts.filter((receipt) => receipt.discount > 0).length,
      sales: totals.discounts,
      subtitle: "จากใบเสร็จที่ชำระแล้ว"
    }
  ];
  const taxRows: SummaryRow[] = [
    {
      key: "tax",
      label: "VAT รวมในราคา",
      quantity: paidReceipts.length,
      sales: totals.taxIncluded,
      subtitle: "คำนวณจากยอดชำระแล้ว"
    }
  ];
  const activeRows =
    section === "products"
      ? productRows
      : section === "categories"
        ? categoryRows
        : section === "payments"
          ? paymentRows
          : section === "paymentAdjustments"
            ? paymentAdjustmentRows
            : section === "refunds"
              ? refundRows
              : section === "discounts"
                ? discountRows
                : section === "tax"
                  ? taxRows
                  : [];
  const tableTotalQuantity =
    section === "paymentAdjustments"
      ? paymentAdjustmentRows.length
      : section === "refunds"
        ? refundRows.reduce((sum, row) => sum + row.quantity, 0)
      : paidReceipts.length;
  const tableTotalSales =
    section === "paymentAdjustments"
      ? paymentAdjustmentRows.reduce((sum, row) => sum + row.sales, 0)
      : section === "refunds"
        ? refundRows.reduce((sum, row) => sum + row.sales, 0)
      : totals.netSales;

  const chartRows = paidReceipts.map((receipt) => ({
    id: receipt.id,
    label: receipt.number,
    total: receiptNetTotal(receipt)
  }));
  const chartMax = Math.max(...chartRows.map((row) => row.total), 1);
  const rangeLabel = formatRangeLabel(rangeStart, rangeEnd);

  const categoryExportRows = useMemo<CategoryExportRow[]>(() => {
    const map = new Map<string, CategoryExportRow>();

    paidReceipts.forEach((receipt) => {
      receipt.items.forEach((line) => {
        const key = line.category || "ไม่ระบุหมวดหมู่";
        const sales = receiptLineSales(line);
        const cost = receiptLineCost(line);
        const current = map.get(key) ?? {
          key,
          label: key,
          quantity: 0,
          sales: 0,
          cost: 0,
          grossProfit: 0
        };

        map.set(key, {
          ...current,
          quantity: current.quantity + line.quantity,
          sales: current.sales + sales,
          cost: current.cost + cost,
          grossProfit: current.grossProfit + (sales - cost)
        });
      });

      receiptRefunds(receipt).forEach((refund) => {
        refund.lines.forEach((line) => {
          const key = line.category || "ไม่ระบุหมวดหมู่";
          const sales = Math.max(line.netAmount, 0);
          const cost = Math.max(line.cost ?? 0, 0) * line.quantity;
          const current = map.get(key) ?? {
            key,
            label: key,
            quantity: 0,
            sales: 0,
            cost: 0,
            grossProfit: 0
          };

          map.set(key, {
            ...current,
            quantity: current.quantity - line.quantity,
            sales: current.sales - sales,
            cost: current.cost - cost,
            grossProfit: current.grossProfit - (sales - cost)
          });
        });
      });
    });

    return Array.from(map.values()).sort((a, b) => b.sales - a.sales);
  }, [paidReceipts]);

  const receiptExportRows = useMemo<ExcelValue[][]>(
    () =>
      paidReceipts.map((receipt) => [
        receipt.number,
        formatDateTime(receipt.createdAt),
        receipt.customerName || "Walk-in Customer",
        receipt.phone || "",
        receiptNetQuantity(receipt),
        receiptSubtotal(receipt),
        receiptNetDiscount(receipt),
        receiptNetTaxIncluded(receipt),
        receiptTotalRefunded(receipt),
        receiptNetTotal(receipt),
        paymentLabels[receipt.paymentMethod] || receipt.paymentLabel || receipt.paymentMethod,
        receipt.status
      ]),
    [paidReceipts]
  );

  const itemExportRows = useMemo<ExcelValue[][]>(() => {
    const rows = paidReceipts.flatMap((receipt) =>
      receipt.items.map((line) => {
        const sales = receiptLineSales(line);
        const cost = receiptLineCost(line);
        const profit = sales - cost;
        const margin = sales > 0 ? (profit / sales) * 100 : 0;

        return [
          receipt.number,
          formatDateTime(receipt.createdAt),
          line.category || "ไม่ระบุหมวดหมู่",
          line.name,
          line.variantName || "ปกติ",
          line.sku || "",
          line.quantity,
          line.unitPrice,
          Math.max(line.lineDiscount ?? 0, 0),
          sales,
          cost,
          profit,
          margin
        ];
      })
    );

    return rows.sort(
      (a, b) =>
        String(a[2]).localeCompare(String(b[2]), "th") ||
        String(a[3]).localeCompare(String(b[3]), "th")
    );
  }, [paidReceipts]);

  const overviewSection: ExcelSection = {
    title: "ภาพรวมยอดขาย",
    headers: ["รายการ", "ค่า"],
    rows: [
      ["ช่วงวันที่", rangeLabel],
      ["จำนวนใบเสร็จที่ชำระแล้ว", paidReceipts.length],
      ["ยอดขายสุทธิ", totals.netSales],
      ["คืนเงิน", totals.refunds],
      ["ส่วนลด", totals.discounts],
      ["VAT รวมในราคา", totals.taxIncluded],
      ["ต้นทุนสินค้า", totals.cost],
      ["กำไรรวม", totals.grossProfit],
      ["บิลค้างชำระ", totals.pending]
    ]
  };

  const categorySection: ExcelSection = {
    title: "ยอดขายตามหมวดหมู่",
    headers: ["หมวดหมู่", "จำนวน", "ยอดขายสุทธิ", "ต้นทุน", "กำไรรวม", "Margin %"],
    rows: categoryExportRows.map((row) => [
      row.label,
      row.quantity,
      row.sales,
      row.cost,
      row.grossProfit,
      row.sales > 0 ? (row.grossProfit / row.sales) * 100 : 0
    ])
  };

  const receiptSection: ExcelSection = {
    title: "ใบเสร็จรับเงิน",
    headers: [
      "เลขที่",
      "วันที่ / เวลา",
      "ลูกค้า",
      "เบอร์โทร",
      "จำนวนรายการ",
      "ยอดก่อนส่วนลด",
      "ส่วนลด",
      "VAT รวมในราคา",
      "คืนเงิน",
      "ยอดสุทธิ",
      "วิธีชำระเงิน",
      "สถานะ"
    ],
    rows: receiptExportRows
  };

  const itemSection: ExcelSection = {
    title: "รายละเอียดสินค้า",
    headers: [
      "เลขที่ใบเสร็จ",
      "วันที่ / เวลา",
      "หมวดหมู่",
      "สินค้า",
      "ตัวแปร",
      "SKU",
      "จำนวน",
      "ราคาต่อหน่วย",
      "ส่วนลดรายการ",
      "ยอดขายสุทธิ",
      "ต้นทุน",
      "กำไร",
      "Margin %"
    ],
    rows: itemExportRows
  };

  const handlePresetChange = (value: SalesRangePreset) => {
    setRangePreset(value);
    if (value !== "custom") {
      setDateRange(presetDateRange(value));
    }
  };

  const handleDateRangeChange = (field: keyof SalesDateRange, value: string) => {
    if (!value) return;
    setRangePreset("custom");
    setDateRange((current) => ({ ...current, [field]: value }));
  };

  const moveDateRange = (direction: -1 | 1) => {
    setDateRange((current) => shiftDateRange(current, rangePreset, direction));
  };

  const exportExcel = async (mode: "all" | "categories") => {
    if (!paidReceipts.length) return;

    const safeRange = fileNamePart(`${rangeStart}-to-${rangeEnd}`);
    if (mode === "categories") {
      await downloadExcel(
        `eden-pos-sales-by-category-${safeRange}.xls`,
        "Eden POS - รายงานยอดขายตามหมวดหมู่",
        `ช่วงวันที่ ${rangeLabel}`,
        [overviewSection, categorySection, itemSection]
      );
      return;
    }

    await downloadExcel(
      `eden-pos-sales-all-${safeRange}.xls`,
      "Eden POS - รายงานยอดขายทั้งหมด",
      `ช่วงวันที่ ${rangeLabel}`,
      [overviewSection, receiptSection, categorySection, itemSection]
    );
  };
  return (
    <main className="sales-summary-screen">
      <section className="sales-summary-toolbar">
        <button
          aria-label="ช่วงก่อนหน้า"
          onClick={() => moveDateRange(-1)}
          type="button"
        >
          <ChevronLeft aria-hidden="true" size={18} />
        </button>
        <div className="sales-range-chip">
          <CalendarDays aria-hidden="true" size={16} />
          <strong>{rangeLabel}</strong>
        </div>
        <button
          aria-label="ช่วงถัดไป"
          onClick={() => moveDateRange(1)}
          type="button"
        >
          <ChevronRight aria-hidden="true" size={18} />
        </button>
        <select
          aria-label="ช่วงวันที่"
          className="sales-range-preset"
          value={rangePreset}
          onChange={(event) => handlePresetChange(event.target.value as SalesRangePreset)}
        >
          <option value="today">วันนี้</option>
          <option value="yesterday">เมื่อวาน</option>
          <option value="week">1 สัปดาห์</option>
          <option value="month">1 เดือน</option>
          <option value="custom">เลือกช่วงเอง</option>
        </select>
        {rangePreset === "custom" && (
          <div className="sales-custom-range">
            <label>
              <span>เริ่ม</span>
              <input
                aria-label="วันที่เริ่มต้น"
                max={dateRange.end}
                onChange={(event) => handleDateRangeChange("start", event.target.value)}
                type="date"
                value={dateRange.start}
              />
            </label>
            <label>
              <span>ถึง</span>
              <input
                aria-label="วันที่สิ้นสุด"
                min={dateRange.start}
                onChange={(event) => handleDateRangeChange("end", event.target.value)}
                type="date"
                value={dateRange.end}
              />
            </label>
          </div>
        )}
        <select aria-label="ช่วงเวลา" value="all-day" onChange={() => undefined}>
          <option value="all-day">ตลอดทั้งวัน</option>
        </select>
        <select aria-label="พนักงาน" value="all-staff" onChange={() => undefined}>
          <option value="all-staff">พนักงานทั้งหมด</option>
        </select>
      </section>

      <section className="sales-dashboard">
        <aside className="sales-report-nav" aria-label="เมนูรายงาน">
          {reportSections.map((item) => (
            <button
              className={section === item.id ? "active" : ""}
              key={item.id}
              onClick={() => setSection(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </aside>

        <div className="sales-report-main">
          <section className="sales-kpi-grid" aria-label="ตัวเลขสรุป">
            <article>
              <CircleDollarSign aria-hidden="true" size={20} />
              <span>คืนเงิน</span>
              <strong>{formatCurrency(totals.refunds)}</strong>
              <small>
                {totals.refunds > 0 ? "มีรายการคืนเงินในช่วงนี้" : "ไม่มีรายการคืนเงิน"}
              </small>
            </article>
            <article>
              <Tags aria-hidden="true" size={20} />
              <span>ส่วนลด</span>
              <strong>{formatCurrency(totals.discounts)}</strong>
              <small>{paidReceipts.filter((receipt) => receipt.discount > 0).length} ใบเสร็จในช่วงนี้</small>
            </article>
            <article>
              <TrendingUp aria-hidden="true" size={20} />
              <span>ยอดขายสุทธิ</span>
              <strong>{formatCurrency(totals.netSales)}</strong>
              <small>ช่วงวันที่ {rangeLabel}</small>
            </article>
            <article>
              <WalletCards aria-hidden="true" size={20} />
              <span>กำไรรวม</span>
              <strong>{formatCurrency(totals.grossProfit)}</strong>
              <small>ต้นทุนสินค้า {formatCurrency(totals.cost)}</small>
            </article>
          </section>

          <section className="sales-chart-panel" aria-label="กราฟยอดขาย">
            <div className="sales-chart-head">
              <strong>
                {section === "summary"
                  ? "ยอดขายตามใบเสร็จ"
                  : reportSections.find((item) => item.id === section)?.label}
              </strong>
              <div>
                <span>พื้นที่</span>
                <span>วัน</span>
              </div>
            </div>
            {chartRows.length ? (
              <div className="sales-bar-chart">
                {chartRows.map((row) => (
                  <div className="sales-chart-row" key={row.id}>
                    <span>{formatCurrency(row.total)}</span>
                    <div>
                      <i style={{ width: `${Math.max((row.total / chartMax) * 100, 6)}%` }} />
                    </div>
                    <small>{row.label}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="sales-empty-chart">ยังไม่มียอดขายที่ชำระแล้วในช่วงนี้</div>
            )}
          </section>

          <section className="sales-export-panel">
            <div className="sales-export-head">
              <strong>ส่งออก Excel</strong>
              <div className="sales-export-actions">
                <button
                  disabled={!paidReceipts.length}
                  onClick={() => void exportExcel("all")}
                  type="button"
                >
                  <Download aria-hidden="true" size={18} />
                  ยอดขายทั้งหมด
                </button>
                <button
                  disabled={!paidReceipts.length}
                  onClick={() => void exportExcel("categories")}
                  type="button"
                >
                  <Download aria-hidden="true" size={18} />
                  ตามหมวดหมู่
                </button>
              </div>
            </div>

            <div className="sales-summary-table">
              <div className="sales-summary-table-row header">
                <span>รายการ</span>
                <span>จำนวน</span>
                <span>ยอดขาย</span>
                <span>วันที่ / ช่วงเวลา</span>
              </div>
              <div className="sales-summary-table-row total">
                <strong>รวมทั้งหมด</strong>
                <strong>{tableTotalQuantity}</strong>
                <strong>{formatCurrency(tableTotalSales)}</strong>
                <strong>{rangeLabel}</strong>
              </div>

              {section === "summary" || section === "receipts" ? (
                paidReceipts.map((receipt) => (
                  <div className="sales-summary-table-row" key={receipt.id}>
                    <strong>
                      <ReceiptText aria-hidden="true" size={16} />
                      {receipt.number}
                    </strong>
                    <span>
                      {receiptNetQuantity(receipt)}
                    </span>
                    <span>{formatCurrency(receiptNetTotal(receipt))}</span>
                    <span>
                      {new Intl.DateTimeFormat("th-TH", {
                        dateStyle: "short",
                        timeStyle: "short"
                      }).format(new Date(receipt.createdAt))}
                      {receipt.customerName ? ` · ${receipt.customerName}` : ""}
                    </span>
                  </div>
                ))
              ) : (
                activeRows.map((row) => (
                  <div className="sales-summary-table-row" key={row.key}>
                    <strong>{row.label}</strong>
                    <span>{row.quantity}</span>
                    <span>{formatCurrency(row.sales)}</span>
                    <span>{row.subtitle || rangeLabel}</span>
                  </div>
                ))
              )}

              {((section === "summary" || section === "receipts") &&
                !paidReceipts.length) ||
              (section !== "summary" &&
                section !== "receipts" &&
                !activeRows.length) ? (
                <div className="sales-summary-empty">ยังไม่มีข้อมูลในช่วงนี้</div>
              ) : null}
            </div>

            {totals.pending > 0 && (
              <small className="sales-pending-note">
                มีบิลค้างชำระในช่วงนี้ {formatCurrency(totals.pending)}
              </small>
            )}
          </section>
        </div>
      </section>
    </main>
  );
};
