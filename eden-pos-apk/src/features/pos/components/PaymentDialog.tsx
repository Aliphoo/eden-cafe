import {
  ArrowLeft,
  Banknote,
  BadgePercent,
  Check,
  Coins,
  CreditCard,
  FileText,
  Landmark,
  QrCode,
  RefreshCw,
  Save,
  Smartphone,
  UserCheck,
  WalletCards
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  formatCurrency,
  formatNumber
} from "../../../domain/money";
import { calculateLoyaltyPreview } from "../../../domain/loyalty";
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
import {
  buildPromptPayPayload,
  createQrDataUrl,
  createQrDataUrlWithLogo
} from "../../../integrations/promptPay";
import {
  buildCustomerDisplayState,
  publishCustomerDisplayState
} from "../../../integrations/customerDisplay";

type CustomerInput = {
  displayName: string;
  phone: string;
};

type PaymentDialogProps = {
  cart: CartLine[];
  discount: number;
  open: boolean;
  orderDiscount: number;
  store: StoreProfile;
  tables: PosTable[];
  subtotal: number;
  tax: number;
  total: number;
  loyaltyConfig: LoyaltyConfig;
  initialCustomer?: CustomerProfile | null;
  onClose(): void;
  onComplete(
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
      isTestOrder?: boolean;
      softLaunch?: boolean;
      note?: string;
    }
  ): Receipt | null;
  onSaveOpenBill(details?: {
    customer?: CustomerProfile;
    customerName?: string;
    loyaltyRedemption?: LoyaltyRedemption;
    phone?: string;
    tableId?: string;
    tableNumber?: string;
    tableName?: string;
    tableZone?: string;
    isTestOrder?: boolean;
    softLaunch?: boolean;
    note?: string;
  }): Receipt | null;
  onCustomerChange?(customer: CustomerProfile | null): void;
  onSaveCustomerLocal(input: CustomerInput): CustomerProfile;
  onSyncCustomer(input: CustomerInput): Promise<CustomerProfile>;
};

const methods: Array<{
  id: PaymentMethod;
  label: string;
  hint: string;
  icon: typeof Banknote;
}> = [
  {
    id: "cash",
    label: "เงินสด",
    hint: "รับเงินสดและคำนวณเงินทอน",
    icon: Banknote
  },
  {
    id: "transfer",
    label: "โอนเงิน",
    hint: "บันทึกเป็นการโอนเงิน",
    icon: Smartphone
  },
  {
    id: "thai_chuay_thai_plus",
    label: "ไทยช่วยไทยพลัส",
    hint: "บันทึกเป็นช่องทางไทยช่วยไทยพลัส",
    icon: Landmark
  },
  {
    id: "qr",
    label: "QR Payment",
    hint: "PromptPay ตามยอดชำระ",
    icon: QrCode
  },
  {
    id: "card",
    label: "บัตร",
    hint: "บัตรเครดิต/เดบิต",
    icon: CreditCard
  },
  {
    id: "other",
    label: "อื่น ๆ",
    hint: "ช่องทางชำระเงินอื่น",
    icon: WalletCards
  }
];

const nextRoundedAmount = (value: number, unit: number) =>
  Math.ceil(value / unit) * unit;

const cleanPhoneDigits = (value: string) => value.replace(/\D/g, "");

const customerSyncFailureMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const isPermissionError =
    /permission|insufficient|denied|unauthenticated|login|ล็อกอิน|สิทธิ์/i.test(
      message
    );

  if (isPermissionError) {
    return "ยังไม่ได้ล็อกอินแอดมิน Eden หรือบัญชีนี้ไม่มีสิทธิ์ซิงค์ลูกค้า กดบันทึกข้อมูลเพื่อเก็บในเครื่อง";
  }

  return message
    ? `ซิงค์ไม่ได้: ${message} กดบันทึกข้อมูลเพื่อเก็บในเครื่อง`
    : "ซิงค์ไม่ได้ กดบันทึกข้อมูลเพื่อเก็บในเครื่อง";
};

const cartLineTotal = (line: CartLine) =>
  Math.max(line.unitPrice * line.quantity - (line.lineDiscount ?? 0), 0);

export const PaymentDialog = ({
  cart,
  discount,
  initialCustomer,
  onClose,
  onComplete,
  onCustomerChange,
  onSaveOpenBill,
  onSaveCustomerLocal,
  onSyncCustomer,
  loyaltyConfig,
  open,
  orderDiscount,
  store,
  tables,
  subtotal,
  tax,
  total
}: PaymentDialogProps) => {
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [paid, setPaid] = useState(total);
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [selectedTableId, setSelectedTableId] = useState("");
  const [note, setNote] = useState("");
  const [customerMode, setCustomerMode] = useState<"sync" | "save" | "saved">(
    "sync"
  );
  const [customerBusy, setCustomerBusy] = useState(false);
  const [customerStatus, setCustomerStatus] = useState<{
    message: string;
    state: "idle" | "success" | "warning" | "error";
  }>({ message: "กรอกเบอร์โทรเพื่อซิงค์หรือบันทึกลูกค้า", state: "idle" });
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerProfile | null>(null);
  const [promptPayQrUrl, setPromptPayQrUrl] = useState("");
  const [redeemPoints, setRedeemPoints] = useState("");
  const [isTestOrder, setIsTestOrder] = useState(false);

  useEffect(() => {
    if (open) {
      setPaid(total);
      setMethod("cash");
      setCustomerName(initialCustomer?.displayName ?? "");
      setPhone(initialCustomer?.phone ?? "");
      setSelectedTableId("");
      setNote("");
      setCustomerMode("sync");
      setCustomerBusy(false);
      setRedeemPoints("");
      setIsTestOrder(false);
      setCustomerStatus({
        message: "กรอกเบอร์โทรเพื่อซิงค์หรือบันทึกลูกค้า",
        state: "idle"
      });
      setSelectedCustomer(initialCustomer ?? null);
      if (initialCustomer) {
        setCustomerStatus({
          message: initialCustomer.memberCode
            ? `เลือกสมาชิกแล้ว: ${initialCustomer.memberCode}`
            : "เลือกสมาชิกจากหลังบ้านแล้ว",
          state: "success"
        });
      }
    }
  }, [initialCustomer, open, total]);

  const loyaltyBlockedByMode = isTestOrder || store.softLaunch === true;
  const effectiveLoyaltyConfig = useMemo(
    () =>
      loyaltyBlockedByMode
        ? { ...loyaltyConfig, enabled: false }
        : loyaltyConfig,
    [loyaltyBlockedByMode, loyaltyConfig]
  );

  const loyaltyPreview = useMemo(
    () =>
      calculateLoyaltyPreview({
        config: effectiveLoyaltyConfig,
        customer: loyaltyBlockedByMode ? null : selectedCustomer,
        lines: cart,
        orderDiscount,
        requestedRedeemPoints: loyaltyBlockedByMode ? 0 : Number(redeemPoints || 0),
        subtotal,
        totalBeforeLoyalty: total
      }),
    [
      cart,
      discount,
      effectiveLoyaltyConfig,
      loyaltyBlockedByMode,
      orderDiscount,
      redeemPoints,
      selectedCustomer,
      subtotal,
      total
    ]
  );
  const payableTotal = loyaltyPreview.payableTotal;
  const loyaltyDiscount = loyaltyPreview.loyaltyDiscount;

  useEffect(() => {
    if (!open || method === "cash") return;
    setPaid(payableTotal);
  }, [method, open, payableTotal]);

  const quickAmounts = useMemo(
    () =>
      Array.from(
        new Set([
          nextRoundedAmount(payableTotal, 10),
          nextRoundedAmount(payableTotal, 50),
          500,
          1000
        ])
      ).filter((amount) => amount >= payableTotal),
    [payableTotal]
  );

  const promptPay = useMemo(() => {
    if (method !== "qr" || payableTotal <= 0) {
      return { payload: "" };
    }

    const payload = buildPromptPayPayload(payableTotal, {
      promptPayId: store.promptPayId,
      merchantName: store.merchantName,
      city: store.city
    });

    return { payload };
  }, [method, payableTotal, store.city, store.merchantName, store.promptPayId]);

  const selectedMethod = useMemo(
    () => methods.find((item) => item.id === method) ?? methods[0],
    [method]
  );
  const selectedTable = useMemo(
    () => tables.find((table) => table.id === selectedTableId) ?? null,
    [selectedTableId, tables]
  );

  useEffect(() => {
    let isActive = true;

    if (!promptPay.payload) {
      setPromptPayQrUrl("");
      return () => {
        isActive = false;
      };
    }

    setPromptPayQrUrl(createQrDataUrl(promptPay.payload));
    void createQrDataUrlWithLogo(promptPay.payload).then((qrUrl) => {
      if (isActive) {
        setPromptPayQrUrl(qrUrl);
      }
    });

    return () => {
      isActive = false;
    };
  }, [promptPay.payload]);

  const customerDisplayState = useMemo(
    () =>
      buildCustomerDisplayState({
        cart,
        customerName:
          selectedCustomer?.displayName || customerName || "Walk-in Customer",
        message:
          method === "qr"
            ? "สแกน QR เพื่อชำระเงิน"
            : `เลือกชำระด้วย ${selectedMethod.label}`,
        paid: method === "cash" ? paid : payableTotal,
        paymentMethod: method,
        paymentLabel: selectedMethod.label,
        stage: "payment",
        store,
        totals: {
          subtotal,
          discount,
          taxIncluded: tax,
          total: payableTotal
        }
      }),
    [
      cart,
      customerName,
      discount,
      method,
      paid,
      payableTotal,
      selectedCustomer?.displayName,
      selectedMethod.label,
      store,
      subtotal,
      tax,
      total
    ]
  );

  useEffect(() => {
    if (!open) return;
    void publishCustomerDisplayState(customerDisplayState);
  }, [customerDisplayState, open]);

  if (!open) {
    return null;
  }

  const effectivePaid = method === "cash" ? paid : payableTotal;
  const change = method === "cash" ? Math.max(0, paid - payableTotal) : 0;
  const loyaltyRedeemRequested = Number(redeemPoints || 0) > 0;
  const loyaltyRedeemAllowed =
    !loyaltyRedeemRequested || !loyaltyPreview.blockedReason;
  const canComplete =
    (method === "cash" ? paid >= payableTotal : payableTotal > 0) &&
    loyaltyRedeemAllowed;
  const customerPhoneReady = cleanPhoneDigits(phone).length >= 6;
  const CustomerActionIcon =
    customerMode === "save" || customerMode === "saved" ? Save : RefreshCw;
  const customerActionLabel = customerBusy
    ? customerMode === "save"
      ? "กำลังบันทึก..."
      : "กำลังซิงค์..."
    : customerMode === "saved"
      ? "บันทึกแล้ว"
      : customerMode === "save"
        ? "บันทึกข้อมูล"
        : "ซิงค์/ลงทะเบียน";

  const resetCustomerBinding = () => {
    setSelectedCustomer(null);
    setRedeemPoints("");
    onCustomerChange?.(null);
    setCustomerMode("sync");
    setCustomerStatus({
      message: "ข้อมูลลูกค้าเปลี่ยนแล้ว กดซิงค์อีกครั้งเมื่อต้องการผูกสมาชิก",
      state: "idle"
    });
  };

  const handleCustomerAction = async () => {
    if (!customerPhoneReady) {
      setCustomerStatus({
        message: "กรอกเบอร์โทรอย่างน้อย 6 หลักก่อน",
        state: "warning"
      });
      return;
    }

    const input = {
      displayName: customerName.trim() || "Walk-in Customer",
      phone: phone.trim()
    };

    if (customerMode === "save" || customerMode === "saved") {
      const customer = onSaveCustomerLocal(input);
      setSelectedCustomer(customer);
      setRedeemPoints("");
      onCustomerChange?.(customer);
      setCustomerName(customer.displayName);
      setPhone(customer.phone);
      setCustomerMode("saved");
      setCustomerStatus({
        message: "บันทึกข้อมูลลูกค้าไว้ในเครื่องแล้ว",
        state: "success"
      });
      return;
    }

    setCustomerBusy(true);
    setCustomerStatus({
      message: "กำลังซิงค์หรือสร้างสมาชิกจากเบอร์โทร...",
      state: "warning"
    });
    try {
      const customer = await onSyncCustomer(input);
      setSelectedCustomer(customer);
      setRedeemPoints("");
      onCustomerChange?.(customer);
      setCustomerName(customer.displayName);
      setPhone(customer.phone || phone);
      setCustomerMode("sync");
      setCustomerStatus({
        message: customer.memberCode
          ? `ซิงค์ข้อมูลแล้ว: ${customer.memberCode}`
          : "ซิงค์ข้อมูลลูกค้าแล้ว",
        state: "success"
      });
    } catch (error) {
      setSelectedCustomer(null);
      onCustomerChange?.(null);
      setCustomerMode("save");
      setCustomerStatus({
        message: customerSyncFailureMessage(error),
        state: "error"
      });
    } finally {
      setCustomerBusy(false);
    }
  };

  const paymentDetails = () => ({
    customer: selectedCustomer ?? undefined,
    customerName,
    loyaltyRedemption: loyaltyPreview.redemption,
    phone,
    tableId: selectedTable?.id || "",
    tableNumber: selectedTable?.code || "",
    tableName: selectedTable?.name || "",
    tableZone: selectedTable?.zone || "",
    isTestOrder,
    softLaunch: store.softLaunch === true,
    note
  });

  return (
    <div
      aria-labelledby="payment-title"
      aria-modal="true"
      className="payment-view"
      role="dialog"
    >
      <aside className="payment-order-panel" aria-label="สรุปออเดอร์">
        <div className="order-topbar">
          <h2>ตั๋วออเดอร์</h2>
        </div>
        <div className="dining-row">
          <span>เสิร์ฟในร้าน</span>
          <span aria-hidden="true">▾</span>
        </div>

        <div className="payment-order-lines">
          {cart.map((line) => (
            <div className="payment-order-line" key={line.productId}>
              <div>
                <strong>
                  {line.name} x {line.quantity}
                </strong>
                <span>{line.variantName || line.category}</span>
                {line.note && <small>{line.note}</small>}
                {line.lineDiscount ? (
                  <small className="line-discount">
                    {line.lineDiscountLabel || "ส่วนลด"} -{formatCurrency(line.lineDiscount)}
                  </small>
                ) : null}
              </div>
              <strong>{formatCurrency(cartLineTotal(line))}</strong>
            </div>
          ))}
        </div>

        <dl className="totals order-totals">
          <div>
            <dt>ส่วนลด</dt>
            <dd>{formatCurrency(discount)}</dd>
          </div>
          <div>
            <dt>ส่วนลดจากแต้ม</dt>
            <dd>{formatCurrency(loyaltyDiscount)}</dd>
          </div>
          <div>
            <dt>VAT 7% รวมในราคา</dt>
            <dd>{formatCurrency(tax)}</dd>
          </div>
          <div>
            <dt>ยอดก่อนส่วนลด</dt>
            <dd>{formatCurrency(subtotal)}</dd>
          </div>
          <div className="grand-total">
            <dt>ยอดสุทธิ</dt>
            <dd>{formatCurrency(payableTotal)}</dd>
          </div>
        </dl>
      </aside>

      <section className="payment-main">
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
          <span>แยก</span>
        </div>

        <div className="payment-content eden-payment-content">
          <div className="amount-due">
            <h2 id="payment-title">{formatCurrency(payableTotal)}</h2>
            {loyaltyDiscount > 0 && (
              <small>
                ยอดก่อนใช้แต้ม {formatCurrency(total)} / ลดแต้ม{" "}
                {formatCurrency(loyaltyDiscount)}
              </small>
            )}
            <p>จำนวนเงินที่ต้องชำระ</p>
          </div>

          <div className="customer-payment-grid">
            <label>
              ลูกค้า
              <input
                onChange={(event) => {
                  setCustomerName(event.target.value);
                  resetCustomerBinding();
                }}
                placeholder="Walk-in Customer"
                value={customerName}
              />
            </label>
            <label>
              เบอร์โทร
              <div className="customer-phone-action">
                <input
                  onChange={(event) => {
                    setPhone(event.target.value);
                    resetCustomerBinding();
                  }}
                  placeholder="ถ้ามี"
                  value={phone}
                />
                <button
                  className={customerMode === "save" ? "fallback" : ""}
                  disabled={customerBusy || !customerPhoneReady}
                  onClick={() => void handleCustomerAction()}
                  type="button"
                >
                  <CustomerActionIcon aria-hidden="true" size={18} />
                  {customerActionLabel}
                </button>
              </div>
            </label>
            <label>
              โต๊ะ
              <select
                onChange={(event) => setSelectedTableId(event.target.value)}
                value={selectedTableId}
              >
                <option value="">ไม่ระบุโต๊ะ</option>
                {tables.map((table) => (
                  <option
                    disabled={table.status === "unavailable"}
                    key={table.id}
                    value={table.id}
                  >
                    {table.code} ? {table.name}
                    {table.zone ? ` ? ${table.zone}` : ""}
                    {table.seats ? ` ? ${table.seats} ที่นั่ง` : ""}
                    {table.status === "booked" ? " ? จองแล้ว" : ""}
                    {table.status === "unavailable" ? " ? ปิดใช้งาน" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className={`customer-sync-status ${customerStatus.state}`}>
              <UserCheck aria-hidden="true" size={18} />
              <span>{customerStatus.message}</span>
            </div>
          </div>

          <label className="test-order-toggle">
            <input
              checked={isTestOrder}
              onChange={(event) => {
                setIsTestOrder(event.target.checked);
                if (event.target.checked) setRedeemPoints("");
              }}
              type="checkbox"
            />
            <span>
              <strong>Test order</strong>
              <small>Skip loyalty sync and write loyaltyError=test-order.</small>
            </span>
          </label>

          {store.softLaunch === true && (
            <div className="loyalty-warning">
              Soft launch is active. Loyalty sync will be skipped.
            </div>
          )}

          {selectedCustomer && (
            <div className={`customer-chip ${selectedCustomer.source}`}>
              <strong>{selectedCustomer.displayName}</strong>
              <span>
                {selectedCustomer.memberCode || selectedCustomer.uid}
                {selectedCustomer.tier ? ` · ${selectedCustomer.tier}` : ""}
              </span>
            </div>
          )}

          <section className="loyalty-payment-panel" aria-label="Loyalty points">
            <div className="loyalty-stat">
              <Coins aria-hidden="true" size={20} />
              <span>แต้มคงเหลือ</span>
              <strong>{formatNumber(loyaltyPreview.availablePoints)}</strong>
            </div>
            <div className="loyalty-stat">
              <BadgePercent aria-hidden="true" size={20} />
              <span>แต้มที่จะได้รับ</span>
              <strong>{formatNumber(loyaltyPreview.earnedPoints)}</strong>
            </div>
            <label>
              ใช้แต้ม
              <input
                disabled={
                  loyaltyBlockedByMode ||
                  !selectedCustomer?.profileSynced ||
                  !effectiveLoyaltyConfig.enabled
                }
                inputMode="numeric"
                min="0"
                onChange={(event) =>
                  setRedeemPoints(event.target.value.replace(/\D/g, ""))
                }
                placeholder={effectiveLoyaltyConfig.enabled ? "0" : "Loyalty disabled"}
                type="text"
                value={redeemPoints}
              />
            </label>
            <div className="loyalty-discount-readout">
              <span>ส่วนลดจากแต้ม</span>
              <strong>{formatCurrency(loyaltyDiscount)}</strong>
            </div>
            {loyaltyPreview.blockedReason && redeemPoints ? (
              <p className="loyalty-warning">{loyaltyPreview.blockedReason}</p>
            ) : (
              <p>
                ส่วนลดปกติ {formatCurrency(discount)} แยกจากส่วนลดแต้ม{" "}
                {formatCurrency(loyaltyDiscount)}
              </p>
            )}
          </section>

          <div className="cash-entry">
            <label htmlFor="paid-amount">
              <Banknote aria-hidden="true" size={22} />
              {method === "cash" ? "รับเงินสด" : "บันทึกเต็มจำนวนอัตโนมัติ"}
            </label>
            <div className="cash-input-row">
              <input
                autoFocus
                disabled={method !== "cash"}
                id="paid-amount"
                min="0"
                onChange={(event) => setPaid(Number(event.target.value))}
                type="number"
                value={effectivePaid}
              />
              <button
                aria-label="ยืนยันชำระเงิน"
                disabled={!canComplete}
                onClick={() => {
                  const receipt = onComplete(method, effectivePaid, paymentDetails());
                  if (receipt) {
                    onClose();
                  }
                }}
                type="button"
              >
                <Check aria-hidden="true" size={18} />
                ยืนยันการชำระเงิน
              </button>
            </div>
            <button
              className="bill-save-button"
              disabled={cart.length === 0}
              onClick={() => {
                const receipt = onSaveOpenBill(paymentDetails());
                if (receipt) {
                  onClose();
                }
              }}
              type="button"
            >
              <Save aria-hidden="true" size={18} />
              บันทึกบิลค้างชำระ
            </button>
          </div>

          {method === "cash" && (
            <div className="quick-cash-grid">
              <button onClick={() => setPaid(payableTotal)} type="button">
                รับพอดี
              </button>
              {quickAmounts.map((amount) => (
                <button
                  key={amount}
                  onClick={() => setPaid(amount)}
                  type="button"
                >
                  {formatCurrency(amount)}
                </button>
              ))}
            </div>
          )}

          {method === "qr" && (
            <section className="promptpay-panel" aria-label="PromptPay QR">
              <div className="promptpay-copy">
                <span>PromptPay</span>
                <strong>{store.promptPayId}</strong>
                <small>สแกนจ่ายตามยอดสุทธิ</small>
              </div>
              <div className="promptpay-qr-wrap">
                <img alt="PromptPay QR Payment" src={promptPayQrUrl} />
              </div>
              <div className="promptpay-total">
                <span>ยอด QR</span>
                <strong>{formatCurrency(payableTotal)}</strong>
              </div>
              <small className="promptpay-status">
                พร้อมสแกนชำระผ่าน PromptPay {store.promptPayId}
              </small>
              <textarea readOnly value={promptPay.payload} />
            </section>
          )}

          <div className="payment-method-list">
            {methods.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={method === item.id ? "selected" : ""}
                  key={item.id}
                  onClick={() => {
                    setMethod(item.id);
                    if (item.id !== "cash") {
                      setPaid(payableTotal);
                    }
                  }}
                  type="button"
                >
                  <Icon aria-hidden="true" size={22} />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                </button>
              );
            })}
            <label className="payment-note">
              <FileText aria-hidden="true" size={20} />
              <textarea
                onChange={(event) => setNote(event.target.value)}
                placeholder="หมายเหตุ เช่น โต๊ะ A1 / เลขอ้างอิงโอน"
                value={note}
              />
            </label>
            <div className="change-row">
              <Landmark aria-hidden="true" size={22} />
              <span>เงินทอน</span>
              <strong>{formatCurrency(change)}</strong>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
