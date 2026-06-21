import { ArrowLeft, Check, Minus, Plus, ReceiptText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { calculateTotals, formatCurrency } from "../../../domain/money";
import type {
  CartLine,
  CustomerProfile,
  LoyaltyConfig,
  LoyaltyRedemption,
  PaymentMethod,
  PosTable,
  Receipt,
  StoreProfile
} from "../../../domain/pos";
import { receiptOpenedAtValue } from "../../../domain/receiptDates";
import { PaymentDialog } from "./PaymentDialog";

type CustomerInput = {
  displayName: string;
  phone: string;
};

type SplitBillDialogProps = {
  bill: Receipt | null;
  customers: CustomerProfile[];
  loyaltyConfig: LoyaltyConfig;
  store: StoreProfile;
  tables: PosTable[];
  onClose(): void;
  onCompleteSplit(
    receiptId: string,
    quantities: Record<string, number>,
    method: PaymentMethod,
    paid: number,
    details?: {
      customer?: CustomerProfile;
      customerName?: string;
      loyaltyRedemption?: LoyaltyRedemption;
      phone?: string;
      tableId?: string;
      tableNumber?: string;
      tableName?: string;
      tableZone?: string;
      note?: string;
    }
  ): Receipt | null;
  onSaveCustomerLocal(input: CustomerInput): CustomerProfile;
  onSyncCustomer(input: CustomerInput): Promise<CustomerProfile>;
};

const subtotalFor = (lines: CartLine[]) =>
  lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);

const lineDiscountFor = (lines: CartLine[]) =>
  lines.reduce((sum, line) => sum + (line.lineDiscount ?? 0), 0);

const scaleLineQuantity = (line: CartLine, quantity: number): CartLine => {
  const ratio = line.quantity > 0 ? quantity / line.quantity : 0;

  return {
    ...line,
    quantity,
    lineDiscount: Math.round((line.lineDiscount ?? 0) * ratio)
  };
};

export const SplitBillDialog = ({
  bill,
  customers,
  loyaltyConfig,
  onClose,
  onCompleteSplit,
  onSaveCustomerLocal,
  onSyncCustomer,
  store,
  tables
}: SplitBillDialogProps) => {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [paymentOpen, setPaymentOpen] = useState(false);

  useEffect(() => {
    setQuantities({});
    setPaymentOpen(false);
  }, [bill?.id]);

  const selectedLines = useMemo(() => {
    if (!bill) {
      return [];
    }

    return bill.items
      .map((line) => {
        const quantity = Math.min(
          Math.max(Math.floor(quantities[line.productId] ?? 0), 0),
          line.quantity
        );

        return quantity > 0 ? scaleLineQuantity(line, quantity) : null;
      })
      .filter((line): line is CartLine => Boolean(line));
  }, [bill, quantities]);

  const selectedSubtotal = useMemo(
    () => subtotalFor(selectedLines),
    [selectedLines]
  );
  const sourceOrderDiscount = bill
    ? Math.max(0, bill.discount - lineDiscountFor(bill.items))
    : 0;
  const sourceSubtotal = Math.max(bill?.subtotal ?? 0, 0);
  const selectedDiscount =
    bill && selectedSubtotal > 0 && sourceSubtotal > 0
      ? selectedSubtotal >= sourceSubtotal
        ? sourceOrderDiscount
        : Math.round(sourceOrderDiscount * (selectedSubtotal / sourceSubtotal))
      : 0;
  const selectedTotals = useMemo(
    () => calculateTotals(selectedLines, store, selectedDiscount),
    [selectedDiscount, selectedLines, store]
  );
  const selectedCount = selectedLines.reduce(
    (sum, line) => sum + line.quantity,
    0
  );
  const billCustomer = useMemo(() => {
    if (!bill?.customerUid) {
      return null;
    }

    const fallbackCustomer: CustomerProfile = {
      uid: bill.customerUid,
      displayName: bill.customerName,
      email: bill.customerEmail,
      phone: bill.phone,
      phoneNormalized: bill.phone,
      lineId: bill.customerLineId,
      tier: bill.customerTier || "Silver",
      memberCode: bill.customerMemberCode || bill.customerUid,
      points: 0,
      profileSynced: Boolean(bill.customerProfileSynced),
      source: bill.customerProfileSynced ? "eden" : "local",
      updatedAt: bill.openedAt || bill.createdAt
    };

    return (
      customers.find((customer) => customer.uid === bill.customerUid) ??
      fallbackCustomer
    );
  }, [bill, customers]);

  if (!bill) {
    return null;
  }

  const setLineQuantity = (line: CartLine, quantity: number) => {
    setQuantities((current) => ({
      ...current,
      [line.productId]: Math.min(Math.max(quantity, 0), line.quantity)
    }));
  };

  const selectAll = () => {
    setQuantities(
      Object.fromEntries(
        bill.items.map((line) => [line.productId, line.quantity])
      )
    );
  };

  const clearSelection = () => {
    setQuantities({});
  };

  const canPay = selectedLines.length > 0 && selectedTotals.total > 0;

  return (
    <div
      aria-labelledby="split-bill-title"
      aria-modal="true"
      className="split-bill-view"
      role="dialog"
    >
      <aside className="split-bill-panel">
        <div className="order-topbar">
          <h2>บิลค้างชำระ</h2>
        </div>
        <div className="split-bill-summary">
          <ReceiptText aria-hidden="true" size={24} />
          <div>
            <strong>{bill.number}</strong>
            <span>
              {new Intl.DateTimeFormat("th-TH", {
                dateStyle: "medium",
                timeStyle: "short"
              }).format(new Date(receiptOpenedAtValue(bill)))}
            </span>
          </div>
          <strong>{formatCurrency(bill.total)}</strong>
        </div>
        <div className="split-bill-original-lines">
          {bill.items.map((line) => (
            <div key={line.productId}>
              <span>
                {line.name} x {line.quantity}
              </span>
              <strong>{formatCurrency(line.unitPrice * line.quantity)}</strong>
            </div>
          ))}
        </div>
      </aside>

      <section className="split-bill-main">
        <div className="payment-toolbar">
          <button
            aria-label="กลับ"
            className="payment-back"
            onClick={onClose}
            title="กลับ"
            type="button"
          >
            <ArrowLeft size={24} />
          </button>
          <span>แยกบิล</span>
        </div>

        <div className="split-bill-content">
          <div className="split-bill-heading">
            <div>
              <p>เลือกสินค้าที่ต้องการชำระ</p>
              <h2 id="split-bill-title">แยกบิลสำหรับการชำระเงิน</h2>
            </div>
            <div className="split-bill-tools">
              <button onClick={selectAll} type="button">
                เลือกทั้งหมด
              </button>
              <button onClick={clearSelection} type="button">
                ล้างเลือก
              </button>
            </div>
          </div>

          <div className="split-line-list">
            {bill.items.map((line) => {
              const quantity = quantities[line.productId] ?? 0;

              return (
                <div className="split-line" key={line.productId}>
                  <div className="split-line-copy">
                    <strong>{line.name}</strong>
                    <span>
                      เหลือ {line.quantity} · {formatCurrency(line.unitPrice)}
                    </span>
                  </div>
                  <div className="split-line-quantity">
                    <button
                      aria-label={`ลดจำนวน ${line.name}`}
                      className="icon-button"
                      onClick={() => setLineQuantity(line, quantity - 1)}
                      type="button"
                    >
                      <Minus size={16} />
                    </button>
                    <span>{quantity}</span>
                    <button
                      aria-label={`เพิ่มจำนวน ${line.name}`}
                      className="icon-button"
                      onClick={() => setLineQuantity(line, quantity + 1)}
                      type="button"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  <strong>{formatCurrency(line.unitPrice * quantity)}</strong>
                </div>
              );
            })}
          </div>

          <div className="split-pay-summary">
            <div>
              <span>เลือกแล้ว</span>
              <strong>{selectedCount} รายการ</strong>
            </div>
            <div>
              <span>ส่วนลดที่ปันมา</span>
              <strong>{formatCurrency(selectedTotals.discount)}</strong>
            </div>
            <div>
              <span>VAT รวมในราคา</span>
              <strong>{formatCurrency(selectedTotals.tax)}</strong>
            </div>
            <div className="split-pay-total">
              <span>ยอดชำระบิลนี้</span>
              <strong>{formatCurrency(selectedTotals.total)}</strong>
            </div>
            <button
              aria-label="ชำระรายการที่เลือก"
              className="split-pay-button"
              disabled={!canPay}
              onClick={() => setPaymentOpen(true)}
              type="button"
            >
              <Check aria-hidden="true" size={18} />
              ชำระรายการที่เลือก
            </button>
          </div>
        </div>
      </section>

      <PaymentDialog
        cart={selectedLines}
        discount={selectedTotals.discount}
        initialCustomer={billCustomer}
        loyaltyConfig={loyaltyConfig}
        onClose={() => setPaymentOpen(false)}
        onComplete={(method, paid, details) => {
          const receipt = onCompleteSplit(
            bill.id,
            quantities,
            method,
            paid,
            details
          );
          if (receipt) {
            setPaymentOpen(false);
            onClose();
          }

          return receipt;
        }}
        onSaveCustomerLocal={onSaveCustomerLocal}
        onSaveOpenBill={() => null}
        onSyncCustomer={onSyncCustomer}
        open={paymentOpen}
        orderDiscount={selectedTotals.orderDiscount}
        store={store}
        tables={tables}
        subtotal={selectedTotals.subtotal}
        tax={selectedTotals.tax}
        total={selectedTotals.total}
      />
    </div>
  );
};
