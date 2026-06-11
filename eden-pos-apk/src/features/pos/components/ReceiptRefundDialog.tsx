import {
  AlertCircle,
  Minus,
  Plus,
  RotateCcw,
  ShieldCheck,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatCurrency } from "../../../domain/money";
import type {
  Receipt,
  ReceiptRefundRequest,
  RefundReasonCode,
  RefundStockAction
} from "../../../domain/pos";
import {
  buildRefundLines,
  receiptLineKey,
  receiptLineRemainingQuantity,
  receiptNetTotal,
  receiptTotalRefunded,
  refundLinesTotal
} from "../../../domain/receiptAdjustments";

type ReceiptRefundDialogProps = {
  receipt: Receipt;
  taxRate: number;
  onClose(): void;
  onSubmit(request: ReceiptRefundRequest): Promise<void>;
};

const reasonOptions: Array<{ value: RefundReasonCode; label: string }> = [
  { value: "missing_item", label: "ลูกค้าไม่ได้รับสินค้า" },
  { value: "incomplete_order", label: "ออเดอร์ได้ไม่ครบ" },
  { value: "overcharged", label: "คิดเงินเกิน" },
  { value: "out_of_stock_after_payment", label: "สินค้าหมดหลังรับชำระ" },
  { value: "customer_return", label: "ลูกค้าคืนสินค้า" },
  { value: "other", label: "อื่น ๆ" }
];

const clampQuantity = (value: number, max: number) =>
  Math.min(Math.max(Math.floor(Number.isFinite(value) ? value : 0), 0), max);

export const ReceiptRefundDialog = ({
  onClose,
  onSubmit,
  receipt,
  taxRate
}: ReceiptRefundDialogProps) => {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [stockActions, setStockActions] = useState<Record<string, RefundStockAction>>(
    {}
  );
  const [reasonCode, setReasonCode] =
    useState<RefundReasonCode>("missing_item");
  const [reason, setReason] = useState(reasonOptions[0].label);
  const [note, setNote] = useState("");
  const [managerEmail, setManagerEmail] = useState("");
  const [managerPassword, setManagerPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const refundableLines = useMemo(
    () =>
      receipt.items.map((line, index) => {
        const lineKey = receiptLineKey(line, index);
        return {
          line,
          lineKey,
          remaining: receiptLineRemainingQuantity(receipt, line, index)
        };
      }),
    [receipt]
  );

  useEffect(() => {
    setQuantities({});
    setStockActions({});
    setReasonCode("missing_item");
    setReason(reasonOptions[0].label);
    setNote("");
    setManagerEmail("");
    setManagerPassword("");
    setError("");
  }, [receipt.id]);

  const selectedLines = useMemo(
    () =>
      refundableLines
        .map((item) => ({
          lineKey: item.lineKey,
          quantity: clampQuantity(quantities[item.lineKey] ?? 0, item.remaining),
          stockAction: stockActions[item.lineKey] ?? "no_stock_return"
        }))
        .filter((item) => item.quantity > 0),
    [quantities, refundableLines, stockActions]
  );

  const estimatedLines = useMemo(
    () => buildRefundLines(receipt, selectedLines, taxRate),
    [receipt, selectedLines, taxRate]
  );
  const refundAmount = refundLinesTotal(estimatedLines);
  const canSubmit =
    refundAmount > 0 &&
    reason.trim().length >= 3 &&
    managerEmail.trim().length > 3 &&
    managerPassword.length > 0 &&
    !submitting;

  const changeQuantity = (lineKey: string, max: number, next: number) => {
    setQuantities((current) => ({
      ...current,
      [lineKey]: clampQuantity(next, max)
    }));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");

    try {
      await onSubmit({
        lines: selectedLines,
        reasonCode,
        reason,
        note,
        managerEmail,
        managerPassword
      });
      onClose();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "บันทึกคืนเงินไม่สำเร็จ"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const refundedAmount = receiptTotalRefunded(receipt);
  const netTotal = receiptNetTotal(receipt);

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        aria-labelledby="refund-dialog-title"
        aria-modal="true"
        className="dialog refund-dialog"
        role="dialog"
      >
        <div className="dialog-header">
          <div>
            <p>Refund Adjustment</p>
            <h2 id="refund-dialog-title">คืนเงิน / แก้รายการในบิล</h2>
          </div>
          <button
            aria-label="ปิด"
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        <div className="refund-summary-strip">
          <span>
            <small>เลขที่บิล</small>
            <strong>{receipt.number}</strong>
          </span>
          <span>
            <small>ยอดเดิม</small>
            <strong>{formatCurrency(receipt.total)}</strong>
          </span>
          <span>
            <small>คืนแล้ว</small>
            <strong>{formatCurrency(refundedAmount)}</strong>
          </span>
          <span>
            <small>ยอดสุทธิ</small>
            <strong>{formatCurrency(netTotal)}</strong>
          </span>
        </div>

        <div className="refund-lines">
          {refundableLines.map(({ line, lineKey, remaining }) => {
            const quantity = quantities[lineKey] ?? 0;
            const stockAction = stockActions[lineKey] ?? "no_stock_return";
            const disabled = remaining <= 0;

            return (
              <article
                className={disabled ? "refund-line-row disabled" : "refund-line-row"}
                key={lineKey}
              >
                <div className="refund-line-main">
                  <strong>
                    {line.name}
                    {line.variantName ? ` / ${line.variantName}` : ""}
                  </strong>
                  <small>
                    เหลือคืนได้ {remaining} จาก {line.quantity} ·{" "}
                    {formatCurrency(line.unitPrice)}
                  </small>
                </div>
                <div className="refund-quantity-control">
                  <button
                    disabled={disabled || quantity <= 0}
                    onClick={() => changeQuantity(lineKey, remaining, quantity - 1)}
                    type="button"
                  >
                    <Minus aria-hidden="true" size={16} />
                  </button>
                  <input
                    disabled={disabled}
                    max={remaining}
                    min={0}
                    onChange={(event) =>
                      changeQuantity(lineKey, remaining, Number(event.target.value))
                    }
                    type="number"
                    value={quantity}
                  />
                  <button
                    disabled={disabled || quantity >= remaining}
                    onClick={() => changeQuantity(lineKey, remaining, quantity + 1)}
                    type="button"
                  >
                    <Plus aria-hidden="true" size={16} />
                  </button>
                </div>
                <select
                  disabled={disabled || quantity <= 0}
                  onChange={(event) =>
                    setStockActions((current) => ({
                      ...current,
                      [lineKey]: event.target.value as RefundStockAction
                    }))
                  }
                  value={stockAction}
                >
                  <option value="no_stock_return">ไม่คืนเข้าสต๊อก</option>
                  <option value="return_to_stock">คืนสินค้าเข้าสต๊อก</option>
                </select>
              </article>
            );
          })}
        </div>

        <div className="refund-form-grid">
          <label className="field-label">
            เหตุผล
            <select
              onChange={(event) => {
                const value = event.target.value as RefundReasonCode;
                setReasonCode(value);
                setReason(
                  reasonOptions.find((item) => item.value === value)?.label || ""
                );
              }}
              value={reasonCode}
            >
              {reasonOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            รายละเอียดเหตุผล
            <input
              onChange={(event) => setReason(event.target.value)}
              placeholder="เช่น ลูกค้าไม่ได้รับกาแฟ Cold Brew 1 แก้ว"
              value={reason}
            />
          </label>
          <label className="field-label refund-note-field">
            หมายเหตุเพิ่มเติม
            <textarea
              onChange={(event) => setNote(event.target.value)}
              placeholder="เลขอ้างอิงโอนคืน / รายละเอียดสำหรับตรวจสอบย้อนหลัง"
              rows={3}
              value={note}
            />
          </label>
        </div>

        <section className="refund-manager-box" aria-label="ผู้อนุมัติคืนเงิน">
          <div>
            <ShieldCheck aria-hidden="true" size={22} />
            <strong>ยืนยันสิทธิ์ Manager</strong>
            <small>ต้องเป็น Owner หรือ Head Manager เท่านั้น</small>
          </div>
          <label className="field-label">
            Email ผู้อนุมัติ
            <input
              autoComplete="username"
              inputMode="email"
              onChange={(event) => setManagerEmail(event.target.value)}
              value={managerEmail}
            />
          </label>
          <label className="field-label">
            Password ผู้อนุมัติ
            <input
              autoComplete="current-password"
              onChange={(event) => setManagerPassword(event.target.value)}
              type="password"
              value={managerPassword}
            />
          </label>
        </section>

        {error && (
          <div className="dialog-status-message error">
            <AlertCircle aria-hidden="true" size={18} />
            {error}
          </div>
        )}

        <div className="refund-total-bar">
          <span>ยอดที่จะคืนเงิน</span>
          <strong>{formatCurrency(refundAmount)}</strong>
        </div>

        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            ยกเลิก
          </button>
          <button
            className="primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={18} />
            {submitting ? "กำลังบันทึก..." : "ยืนยันคืนเงิน"}
          </button>
        </div>
      </section>
    </div>
  );
};
