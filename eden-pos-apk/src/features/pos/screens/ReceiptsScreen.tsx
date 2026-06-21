import {
  AlertTriangle,
  ArrowLeftRight,
  Banknote,
  Ban,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  GitBranch,
  Clock3,
  History,
  Landmark,
  Pencil,
  Printer,
  QrCode,
  RefreshCw,
  RotateCcw,
  Save,
  Smartphone,
  Table2,
  Undo2,
  User,
  WalletCards,
  X,
  type LucideIcon
} from "lucide-react";
import { useMemo, useState } from "react";
import { formatCurrency } from "../../../domain/money";
import type { PaymentMethod, Receipt, ReceiptRefundRequest } from "../../../domain/pos";
import {
  receiptNetTotal,
  receiptRefundStatus,
  receiptTotalRefunded
} from "../../../domain/receiptAdjustments";
import {
  localDateKey,
  receiptReportDateKey,
  receiptReportDateTime
} from "../../../domain/receiptDates";
import { ReceiptRefundDialog } from "../components/ReceiptRefundDialog";

type ReceiptsScreenProps = {
  receipts: Receipt[];
  onCancelBill(receiptId: string): Receipt | null;
  onEditBill(receiptId: string): void;
  onPayBill(receiptId: string): void;
  onPrintReceipt(receiptId: string): Promise<void> | void;
  onRestoreBill(receiptId: string): Receipt | null;
  onRetryLoyalty(receiptId: string): Receipt | null;
  onSplitBill(receiptId: string): void;
  onRefundReceipt(
    receiptId: string,
    request: ReceiptRefundRequest
  ): Promise<unknown>;
  onAdjustPayment(
    receiptId: string,
    paymentMethod: PaymentMethod,
    reason: string
  ): void;
  taxRate: number;
};

type ReceiptStatusFilter =
  | "all"
  | "pending_all"
  | "pending"
  | "paid"
  | "cancelled";

type PrintState = {
  receiptId: string;
  status: "printing" | "printed" | "failed";
  message: string;
};

const statusFilters: Array<{
  id: ReceiptStatusFilter;
  label: string;
}> = [
  { id: "all", label: "ทุกรายการ" },
  { id: "pending_all", label: "บิลค้างทั้งหมด" },
  { id: "pending", label: "บิลค้างชำระ" },
  { id: "paid", label: "ชำระเงินสำเร็จ" }
];
statusFilters.push({ id: "cancelled", label: "บิลที่ถูกยกเลิก" });

const methodLabel: Record<PaymentMethod, string> = {
  cash: "เงินสด",
  transfer: "โอนเงิน",
  thai_chuay_thai_plus: "ไทยช่วยไทยพลัส",
  qr: "QR Payment",
  card: "บัตร",
  other: "อื่น ๆ"
};

const methodIcon: Record<PaymentMethod, LucideIcon> = {
  cash: Banknote,
  transfer: Smartphone,
  thai_chuay_thai_plus: Landmark,
  qr: QrCode,
  card: CreditCard,
  other: WalletCards
};

const paymentMethodOptions = Object.keys(methodLabel) as PaymentMethod[];

const syncLabel: Record<Receipt["syncStatus"], string> = {
  local: "เก็บในเครื่อง",
  syncing: "กำลังส่ง",
  synced: "ซิงค์แล้ว",
  failed: "ส่งไม่สำเร็จ"
};

const loyaltyReason = (receipt: Receipt) =>
  receipt.loyaltySkipReason ||
  (receipt.loyaltySyncStatus === "skipped" ? receipt.loyaltyError || "" : "");

const loyaltyStatusText = (receipt: Receipt) => {
  const reason = loyaltyReason(receipt);
  const status = receipt.loyaltySyncStatus || "skipped";
  const parts = [`Loyalty ${status}`];
  if (status === "skipped" && reason) parts.push(reason);
  if (receipt.earnedPoints) parts.push(`+${receipt.earnedPoints}`);
  if (receipt.redeemedPoints) parts.push(`redeemed ${receipt.redeemedPoints}`);
  return parts.join(" / ");
};

const dateKey = localDateKey;

const receiptDateKey = receiptReportDateKey;

const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateKey(date);
};

const formatDateLabel = (value: string) =>
  new Intl.DateTimeFormat("th-TH", {
    dateStyle: "full"
  }).format(new Date(`${value}T00:00:00`));

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));

const isPendingReceipt = (receipt: Receipt) =>
  receipt.billStatus !== "cancelled" &&
  receipt.paymentStatus !== "refunded" &&
  (receipt.paymentStatus === "pending" ||
    receipt.paymentStatus === "failed" ||
    receipt.billStatus === "open" ||
    receipt.isOpenBill ||
    receipt.status === "pending");

const receiptOpenedTime = (receipt: Receipt) => {
  const candidates = [
    receipt.openedAt,
    receipt.createdAt,
    receiptReportDateTime(receipt)
  ];
  for (const value of candidates) {
    const time = new Date(value || "").getTime();
    if (Number.isFinite(time)) return time;
  }
  return Date.now();
};

const pendingAgeInfo = (receipt: Receipt) => {
  const openedTime = receiptOpenedTime(receipt);
  const ageMs = Math.max(0, Date.now() - openedTime);
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  const severity = days >= 2 ? "danger" : days >= 1 ? "warning" : "normal";
  const label =
    days >= 1
      ? `ค้าง ${days} วัน`
      : hours >= 1
        ? `ค้าง ${hours} ชม.`
        : "ค้างไม่ถึง 1 ชม.";

  return { label, severity };
};

export const ReceiptsScreen = ({
  onAdjustPayment,
  onCancelBill,
  onEditBill,
  onPayBill,
  onPrintReceipt,
  onRetryLoyalty,
  onRestoreBill,
  onSplitBill,
  onRefundReceipt,
  receipts,
  taxRate
}: ReceiptsScreenProps) => {
  const today = dateKey(new Date());
  const [selectedDate, setSelectedDate] = useState(today);
  const [statusFilter, setStatusFilter] =
    useState<ReceiptStatusFilter>("pending_all");
  const [adjustingReceipt, setAdjustingReceipt] = useState<Receipt | null>(null);
  const [nextPaymentMethod, setNextPaymentMethod] =
    useState<PaymentMethod>("cash");
  const [adjustReason, setAdjustReason] = useState("");
  const [refundingReceipt, setRefundingReceipt] = useState<Receipt | null>(null);
  const [printState, setPrintState] = useState<PrintState | null>(null);
  const dateReceipts = useMemo(
    () => receipts.filter((receipt) => receiptDateKey(receipt) === selectedDate),
    [receipts, selectedDate]
  );
  const allPendingReceipts = useMemo(
    () =>
      receipts
        .filter(isPendingReceipt)
        .sort((a, b) => receiptOpenedTime(a) - receiptOpenedTime(b)),
    [receipts]
  );
  const paidReceipts = dateReceipts.filter(
    (receipt) => receipt.paymentStatus === "paid"
  );
  const pendingReceipts = dateReceipts.filter(
    isPendingReceipt
  );
  const cancelledReceipts = dateReceipts.filter(
    (receipt) => receipt.billStatus === "cancelled"
  );
  const visibleReceipts = useMemo(() => {
    if (statusFilter === "paid") {
      return paidReceipts;
    }

    if (statusFilter === "pending_all") {
      return allPendingReceipts;
    }

    if (statusFilter === "pending") {
      return pendingReceipts;
    }

    if (statusFilter === "cancelled") {
      return cancelledReceipts;
    }

    return dateReceipts;
  }, [
    allPendingReceipts,
    cancelledReceipts,
    dateReceipts,
    paidReceipts,
    pendingReceipts,
    statusFilter
  ]);
  const paidTotal = paidReceipts.reduce(
    (sum, receipt) => sum + receiptNetTotal(receipt),
    0
  );
  const pendingTotal = pendingReceipts.reduce(
    (sum, receipt) => sum + receipt.total,
    0
  );
  const allPendingTotal = allPendingReceipts.reduce(
    (sum, receipt) => sum + receipt.total,
    0
  );
  const statusCounts: Record<ReceiptStatusFilter, number> = {
    all: dateReceipts.length,
    pending_all: allPendingReceipts.length,
    pending: pendingReceipts.length,
    paid: paidReceipts.length,
    cancelled: cancelledReceipts.length
  };
  const emptyMessage =
    statusFilter === "pending_all"
      ? "ไม่มีบิลค้างชำระทั้งหมด"
      : statusFilter === "pending"
      ? "ไม่มีบิลค้างชำระในวันที่เลือก"
      : statusFilter === "paid"
        ? "ไม่มีรายการชำระเงินสำเร็จในวันที่เลือก"
        : "ไม่มีใบเสร็จหรือบิลค้างชำระในวันที่เลือก";
  const latestAdjustment =
    adjustingReceipt?.paymentAdjustments?.[
      (adjustingReceipt.paymentAdjustments?.length ?? 0) - 1
    ];
  const canSubmitAdjustment =
    Boolean(adjustingReceipt) &&
    nextPaymentMethod !== adjustingReceipt?.paymentMethod &&
    adjustReason.trim().length >= 3;

  const openAdjustPayment = (receipt: Receipt) => {
    setAdjustingReceipt(receipt);
    setNextPaymentMethod(receipt.paymentMethod);
    setAdjustReason("");
  };

  const closeAdjustPayment = () => {
    setAdjustingReceipt(null);
    setAdjustReason("");
  };

  const submitAdjustment = () => {
    if (!adjustingReceipt || !canSubmitAdjustment) return;

    onAdjustPayment(adjustingReceipt.id, nextPaymentMethod, adjustReason);
    closeAdjustPayment();
  };

  const handlePrintReceipt = async (receipt: Receipt) => {
    setPrintState({
      receiptId: receipt.id,
      status: "printing",
      message: "กำลังส่งงานพิมพ์..."
    });

    try {
      await onPrintReceipt(receipt.id);
      setPrintState({
        receiptId: receipt.id,
        status: "printed",
        message: "ส่งงานพิมพ์แล้ว"
      });
    } catch (error) {
      setPrintState({
        receiptId: receipt.id,
        status: "failed",
        message:
          error instanceof Error
            ? `พิมพ์ไม่สำเร็จ: ${error.message}`
            : "พิมพ์ไม่สำเร็จ"
      });
    }
  };

  const submitRefund = async (request: ReceiptRefundRequest) => {
    if (!refundingReceipt) return;
    await onRefundReceipt(refundingReceipt.id, request);
  };

  const handleCancelBill = (receipt: Receipt) => {
    const confirmed = window.confirm(
      `ยกเลิกบิล ${receipt.number} ทั้งหมดใช่ไหม? บิลจะย้ายไปอยู่ในประวัติบิลที่ถูกยกเลิก`
    );
    if (!confirmed) return;
    onCancelBill(receipt.id);
  };

  const handleRestoreBill = (receipt: Receipt) => {
    const restored = onRestoreBill(receipt.id);
    if (restored) {
      setStatusFilter("pending");
    }
  };

  return (
    <main className="workspace receipts-layout">
      <div className="section-toolbar">
        <div>
          <p>ประวัติ</p>
          <h2>ใบเสร็จรับเงินและบิลค้างชำระ</h2>
        </div>
        <strong className={allPendingReceipts.length ? "receipt-global-alert" : ""}>
          ค้างชำระทั้งหมด {allPendingReceipts.length} /{" "}
          {formatCurrency(allPendingTotal)}
        </strong>
      </div>

      {statusFilter !== "pending_all" ? (
        <section className="receipt-date-panel" aria-label="เลือกวันที่ใบเสร็จ">
          <button
            aria-label="วันก่อนหน้า"
            onClick={() => setSelectedDate((current) => addDays(current, -1))}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={20} />
          </button>
          <label className="receipt-date-field">
            <CalendarDays aria-hidden="true" size={18} />
            <input
              onChange={(event) => setSelectedDate(event.target.value || today)}
              type="date"
              value={selectedDate}
            />
          </label>
          <button
            aria-label="วันถัดไป"
            onClick={() => setSelectedDate((current) => addDays(current, 1))}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={20} />
          </button>
          <button
            className="receipt-today-button"
            onClick={() => setSelectedDate(today)}
            type="button"
          >
            วันนี้
          </button>
        </section>
      ) : (
        <section className="receipt-all-pending-panel" aria-label="บิลค้างชำระทั้งหมด">
          <AlertTriangle aria-hidden="true" size={20} />
          <div>
            <strong>บิลค้างชำระทั้งหมดจากทุกวัน</strong>
            <span>เรียงจากบิลเก่าสุดก่อน เพื่อช่วยเคลียร์รายการที่เสี่ยงตกหล่น</span>
          </div>
        </section>
      )}

      <div className="receipt-date-summary">
        {statusFilter === "pending_all" ? (
          <>
            <span>ไม่จำกัดวันที่</span>
            <strong>บิลค้างทั้งหมด {allPendingReceipts.length}</strong>
            <strong>ยอดค้างทั้งหมด {formatCurrency(allPendingTotal)}</strong>
          </>
        ) : (
          <>
            <span>{formatDateLabel(selectedDate)}</span>
            <strong>ยอดชำระแล้ว {formatCurrency(paidTotal)}</strong>
            <strong>ค้างชำระ {formatCurrency(pendingTotal)}</strong>
          </>
        )}
      </div>

      <div className="receipt-status-tabs" role="tablist" aria-label="ตัวกรองสถานะบิล">
        {statusFilters.map((filter) => (
          <button
            aria-selected={statusFilter === filter.id}
            className={statusFilter === filter.id ? "active" : ""}
            key={filter.id}
            onClick={() => setStatusFilter(filter.id)}
            role="tab"
            type="button"
          >
            <span>{filter.label}</span>
            <strong>{statusCounts[filter.id]}</strong>
          </button>
        ))}
      </div>

      <section className="receipt-list" aria-label="รายการใบเสร็จ">
        {visibleReceipts.length === 0 ? (
          <div className="empty-state wide">
            {emptyMessage}
          </div>
        ) : (
          visibleReceipts.map((receipt) => {
            const Icon = methodIcon[receipt.paymentMethod];
            const isPaid = receipt.paymentStatus === "paid";
            const isCancelled = receipt.billStatus === "cancelled";
            const isPending = !isPaid && !isCancelled;
            const ageInfo = isPending ? pendingAgeInfo(receipt) : null;
            const StatusIcon = isCancelled ? Ban : isPaid ? CheckCircle2 : Clock3;
            const adjustmentCount = receipt.paymentAdjustments?.length ?? 0;
            const refundedAmount = receiptTotalRefunded(receipt);
            const netTotal = receiptNetTotal(receipt);
            const refundStatus = receiptRefundStatus(receipt);
            const customerLabel =
              receipt.customerName && receipt.customerName !== "Walk-in Customer"
                ? receipt.customerName
                : "";
            const tableLabel = [
              receipt.tableNumber,
              receipt.tableName &&
              receipt.tableName !== receipt.tableNumber
                ? receipt.tableName
                : "",
              receipt.tableZone
            ]
              .filter(Boolean)
              .join(" · ");
            const isPrinting =
              printState?.receiptId === receipt.id &&
              printState.status === "printing";
            const receiptLatestAdjustment =
              receipt.paymentAdjustments?.[
                (receipt.paymentAdjustments?.length ?? 0) - 1
              ];
            const loyaltyReasonCode = loyaltyReason(receipt);

            return (
              <article
                className={`receipt-item ${
                  isCancelled ? "cancelled" : isPaid ? "paid" : "pending"
                } ${ageInfo ? `age-${ageInfo.severity}` : ""}`}
                key={receipt.id}
              >
                <div className="receipt-head">
                  <div>
                    <strong>{receipt.number}</strong>
                    <span>
                      {new Intl.DateTimeFormat("th-TH", {
                        dateStyle: "medium",
                        timeStyle: "short"
                      }).format(new Date(receiptReportDateTime(receipt)))}
                    </span>
                  </div>
                  <div className="receipt-total">
                    {formatCurrency(netTotal)}
                    {refundedAmount > 0 && (
                      <small>คืนแล้ว {formatCurrency(refundedAmount)}</small>
                    )}
                  </div>
                </div>

                {(tableLabel || customerLabel) && (
                  <div className="receipt-meta">
                    {tableLabel && (
                      <span>
                        <Table2 aria-hidden="true" size={16} />
                        โต๊ะ {tableLabel}
                      </span>
                    )}
                    {customerLabel && (
                      <span>
                        <User aria-hidden="true" size={16} />
                        {customerLabel}
                      </span>
                    )}
                  </div>
                )}

                <div className="receipt-lines">
                  {receipt.items.map((item) => (
                    <span key={`${receipt.id}-${item.productId}-${item.variantId}`}>
                      {item.name} x{item.quantity}
                      {item.variantName ? ` / ${item.variantName}` : ""}
                      {item.lineDiscount ? ` (${item.lineDiscountLabel || "ส่วนลด"})` : ""}
                    </span>
                  ))}
                </div>

                <div className="receipt-foot">
                  <span>
                    <Icon aria-hidden="true" size={16} />
                    {isPaid ? methodLabel[receipt.paymentMethod] : "ยังไม่ชำระ"}
                  </span>
                  {ageInfo && (
                    <span className={`receipt-age ${ageInfo.severity}`}>
                      <AlertTriangle aria-hidden="true" size={16} />
                      {ageInfo.label}
                    </span>
                  )}
                  {isPaid && <span>ทอน {formatCurrency(receipt.change)}</span>}
                  <span
                    className={`receipt-payment-status ${
                      isCancelled ? "cancelled" : isPaid ? "paid" : "pending"
                    }`}
                  >
                    <StatusIcon aria-hidden="true" size={16} />
                    {isCancelled
                      ? "บิลถูกยกเลิก"
                      : isPaid
                        ? "ชำระแล้ว"
                        : "ค้างชำระ"}
                  </span>
                  <span className={`receipt-sync ${receipt.syncStatus}`}>
                    {syncLabel[receipt.syncStatus]}
                  </span>
                  {receipt.loyaltySyncStatus && (
                    <span className={`receipt-loyalty ${receipt.loyaltySyncStatus}`}>
                      {loyaltyStatusText(receipt)}
                    </span>
                  )}
                  {adjustmentCount > 0 && (
                    <span className="receipt-adjusted">
                      <History aria-hidden="true" size={16} />
                      ปรับช่องทาง {adjustmentCount} ครั้ง
                    </span>
                  )}
                  {refundStatus !== "none" && (
                    <span className={`receipt-refunded ${refundStatus}`}>
                      <RotateCcw aria-hidden="true" size={16} />
                      {refundStatus === "full" ? "คืนเงินเต็มจำนวน" : "คืนเงินบางส่วน"}
                    </span>
                  )}
                </div>

                <div className="receipt-actions">
                  {isPending && (
                    <>
                      <button onClick={() => onEditBill(receipt.id)} type="button">
                        <Pencil aria-hidden="true" size={16} />
                        เปิดบิล
                      </button>
                      <button
                        className="receipt-split-button"
                        onClick={() => onSplitBill(receipt.id)}
                        type="button"
                      >
                        <GitBranch aria-hidden="true" size={16} />
                        แยกบิล
                      </button>
                      <button
                        className="primary"
                        onClick={() => onPayBill(receipt.id)}
                        type="button"
                      >
                        <Banknote aria-hidden="true" size={16} />
                        ชำระเงิน
                      </button>
                      <button
                        className="danger"
                        onClick={() => handleCancelBill(receipt)}
                        type="button"
                      >
                        <Ban aria-hidden="true" size={16} />
                        ยกเลิกบิล
                      </button>
                    </>
                  )}
                  {isCancelled && (
                    <button
                      className="restore"
                      onClick={() => handleRestoreBill(receipt)}
                      type="button"
                    >
                      <Undo2 aria-hidden="true" size={16} />
                      เรียกคืนบิล
                    </button>
                  )}
                  {isPaid && (
                    <button
                      onClick={() => openAdjustPayment(receipt)}
                      type="button"
                    >
                      <ArrowLeftRight aria-hidden="true" size={16} />
                      แก้ช่องทาง
                    </button>
                  )}
                  {isPaid && (
                    <button
                      disabled={refundStatus === "full"}
                      onClick={() => setRefundingReceipt(receipt)}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" size={16} />
                      คืนเงิน
                    </button>
                  )}
                  {isPaid &&
                    ["failed", "local"].includes(
                      receipt.loyaltySyncStatus || ""
                    ) && (
                      <button
                        onClick={() => onRetryLoyalty(receipt.id)}
                        type="button"
                      >
                        <RefreshCw aria-hidden="true" size={16} />
                        retry แต้ม
                      </button>
                    )}

                  {!isCancelled && (
                    <button
                      disabled={isPrinting}
                      onClick={() => void handlePrintReceipt(receipt)}
                      type="button"
                    >
                      <Printer aria-hidden="true" size={16} />
                      {isPrinting ? "กำลังพิมพ์" : "พิมพ์"}
                    </button>
                  )}
                </div>

                {printState?.receiptId === receipt.id && (
                  <small
                    className={`receipt-print-status ${printState.status}`}
                  >
                    {printState.message}
                  </small>
                )}

                {receiptLatestAdjustment && (
                  <small className="receipt-audit-note">
                    ล่าสุด: {receiptLatestAdjustment.previousPaymentLabel} →{" "}
                    {receiptLatestAdjustment.nextPaymentLabel} โดย{" "}
                    {receiptLatestAdjustment.adjustedByName} ·{" "}
                    {receiptLatestAdjustment.reason}
                  </small>
                )}

                {receipt.syncError && (
                  <small className="receipt-error">{receipt.syncError}</small>
                )}
                {receipt.loyaltyError &&
                  receipt.loyaltyError !== loyaltyReasonCode && (
                  <small className="receipt-error">
                    loyalty: {receipt.loyaltyError}
                  </small>
                )}
              </article>
            );
          })
        )}
      </section>

      {refundingReceipt && (
        <ReceiptRefundDialog
          onClose={() => setRefundingReceipt(null)}
          onSubmit={submitRefund}
          receipt={refundingReceipt}
          taxRate={taxRate}
        />
      )}

      {adjustingReceipt && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="payment-adjust-title"
            aria-modal="true"
            className="dialog payment-adjust-dialog"
            role="dialog"
          >
            <div className="dialog-header">
              <div>
                <p>ปรับช่องทางชำระเงิน</p>
                <h2 id="payment-adjust-title">{adjustingReceipt.number}</h2>
              </div>
              <button
                aria-label="ปิด"
                className="icon-button"
                onClick={closeAdjustPayment}
                type="button"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </div>

            <div className="payment-adjust-summary">
              <span>ยอดชำระ</span>
              <strong>{formatCurrency(adjustingReceipt.total)}</strong>
              <small>
                เดิม: {methodLabel[adjustingReceipt.paymentMethod]} ·{" "}
                {adjustingReceipt.customerName || "Walk-in Customer"}
              </small>
            </div>

            <div className="payment-methods payment-adjust-methods">
              {paymentMethodOptions.map((method) => {
                const MethodIcon = methodIcon[method];

                return (
                  <button
                    className={nextPaymentMethod === method ? "selected" : ""}
                    key={method}
                    onClick={() => setNextPaymentMethod(method)}
                    type="button"
                  >
                    <MethodIcon aria-hidden="true" size={18} />
                    {methodLabel[method]}
                  </button>
                );
              })}
            </div>

            <label className="field-label payment-adjust-reason">
              เหตุผลในการปรับ
              <textarea
                onChange={(event) => setAdjustReason(event.target.value)}
                placeholder="เช่น พนักงานเลือกเงินสดผิด จริงเป็นโอนบัญชี Eden Main"
                rows={4}
                value={adjustReason}
              />
            </label>

            {latestAdjustment && (
              <div className="payment-adjust-history">
                <strong>ประวัติล่าสุด</strong>
                <span>
                  {latestAdjustment.previousPaymentLabel} →{" "}
                  {latestAdjustment.nextPaymentLabel}
                </span>
                <small>
                  {formatDateTime(latestAdjustment.adjustedAt)} ·{" "}
                  {latestAdjustment.adjustedByName}
                </small>
                <small>{latestAdjustment.reason}</small>
              </div>
            )}

            <div className="dialog-actions">
              <button onClick={closeAdjustPayment} type="button">
                ยกเลิก
              </button>
              <button
                className="primary"
                disabled={!canSubmitAdjustment}
                onClick={submitAdjustment}
                type="button"
              >
                <Save aria-hidden="true" size={18} />
                บันทึกการปรับ
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
};
