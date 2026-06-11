import {
  Banknote,
  Minus,
  MoreVertical,
  Plus,
  ReceiptText,
  Save,
  Trash2,
  UserCheck,
  UserPlus
} from "lucide-react";
import { useState } from "react";
import { formatCurrency, formatNumber } from "../../../domain/money";
import type { CartLine, CustomerProfile } from "../../../domain/pos";

type CartPanelProps = {
  cart: CartLine[];
  discount: number;
  total: number;
  subtotal: number;
  tax: number;
  onDiscountChange(value: number): void;
  onPayment(): void;
  onSaveOpenBill(): void;
  onCustomerClick(): void;
  onQuantity(productId: string, quantity: number): void;
  onClear(): void;
  selectedCustomer?: CustomerProfile | null;
};

const cartLineTotal = (line: CartLine) =>
  Math.max(line.unitPrice * line.quantity - (line.lineDiscount ?? 0), 0);

export const CartPanel = ({
  cart,
  discount,
  onClear,
  onCustomerClick,
  onDiscountChange,
  onPayment,
  onSaveOpenBill,
  onQuantity,
  selectedCustomer,
  subtotal,
  tax,
  total
}: CartPanelProps) => {
  const [actionsOpen, setActionsOpen] = useState(false);
  const CustomerIcon = selectedCustomer ? UserCheck : UserPlus;

  return (
  <aside className="checkout-panel" aria-label="ตั๋วออเดอร์">
    <div className="order-topbar">
      <h2>ตั๋วออเดอร์</h2>
      <div className="order-icons">
        <button
          aria-label="เพิ่มลูกค้า"
          className="flat-icon-button"
          onClick={onCustomerClick}
          title="เพิ่มลูกค้าในหน้าชำระเงิน"
          type="button"
        >
          <CustomerIcon size={20} />
        </button>
        <button
          aria-expanded={actionsOpen}
          aria-label="เมนูตั๋วออเดอร์"
          className="flat-icon-button"
          onClick={() => setActionsOpen((open) => !open)}
          title="เมนูตั๋วออเดอร์"
          type="button"
        >
          <MoreVertical size={20} />
        </button>
        {actionsOpen && (
          <div className="order-actions-menu" role="menu">
            <button
              disabled={cart.length === 0}
              onClick={() => {
                onPayment();
                setActionsOpen(false);
              }}
              role="menuitem"
              type="button"
            >
              ชำระเงิน
            </button>
            <button
              disabled={cart.length === 0}
              onClick={() => {
                onSaveOpenBill();
                setActionsOpen(false);
              }}
              role="menuitem"
              type="button"
            >
              บันทึกบิลค้างชำระ
            </button>
            <button
              disabled={cart.length === 0}
              onClick={() => {
                onClear();
                setActionsOpen(false);
              }}
              role="menuitem"
              type="button"
            >
              ล้างตั๋ว
            </button>
          </div>
        )}
      </div>
    </div>

    <div className="dining-row">
      <span>เสิร์ฟในร้าน</span>
      <span aria-hidden="true">▾</span>
    </div>

    {selectedCustomer && (
      <button
        className="ticket-customer-chip"
        onClick={onCustomerClick}
        type="button"
      >
        <UserCheck aria-hidden="true" size={18} />
        <span>
          <strong>{selectedCustomer.displayName}</strong>
          <small>
            {selectedCustomer.memberCode || selectedCustomer.phone || selectedCustomer.uid}
            {` · ${formatNumber(selectedCustomer.points ?? 0)} แต้ม`}
          </small>
        </span>
      </button>
    )}

    <div className="cart-lines loyverse-lines">
      {cart.length === 0 ? (
        <div className="empty-state">
          <ReceiptText aria-hidden="true" size={28} />
          <span>ยังไม่มีรายการ</span>
        </div>
      ) : (
        cart.map((line) => (
          <div className="cart-line" key={line.productId}>
            <div className="line-copy">
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
            <strong className="line-total">
              {formatCurrency(cartLineTotal(line))}
            </strong>
            <div className="quantity-control">
              <button
                aria-label={`ลดจำนวน ${line.name}`}
                className="icon-button"
                onClick={() => onQuantity(line.productId, line.quantity - 1)}
                title="ลดจำนวน"
                type="button"
              >
                <Minus size={16} />
              </button>
              <span>{line.quantity}</span>
              <button
                aria-label={`เพิ่มจำนวน ${line.name}`}
                className="icon-button"
                onClick={() => onQuantity(line.productId, line.quantity + 1)}
                title="เพิ่มจำนวน"
                type="button"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
        ))
      )}
    </div>

    <div className="discount-row">
      <label htmlFor="discount">ส่วนลด</label>
      <input
        id="discount"
        min="0"
        onChange={(event) => onDiscountChange(Number(event.target.value))}
        type="number"
        value={discount}
      />
    </div>

    <dl className="totals order-totals">
      <div>
        <dt>รวมภาษี</dt>
        <dd>{formatCurrency(tax)}</dd>
      </div>
      <div>
        <dt>ยอดสินค้า</dt>
        <dd>{formatCurrency(subtotal)}</dd>
      </div>
      <div className="grand-total">
        <dt>รวมทั้งหมด</dt>
        <dd>{formatCurrency(total)}</dd>
      </div>
    </dl>

    <div className="order-action-bar">
      <button
        className="secondary-action"
        disabled={cart.length === 0}
        onClick={onClear}
        type="button"
      >
        <Trash2 aria-hidden="true" size={18} />
        ล้าง
      </button>
      <button
        className="bill-action"
        disabled={cart.length === 0}
        onClick={onSaveOpenBill}
        type="button"
      >
        <Save aria-hidden="true" size={18} />
        บันทึกบิล
      </button>
      <button
        className="primary-action"
        disabled={cart.length === 0}
        onClick={onPayment}
        type="button"
      >
        <Banknote aria-hidden="true" size={18} />
        ชำระเงิน
      </button>
    </div>
  </aside>
  );
};
