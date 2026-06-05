import { Check, MessageSquare, Minus, Percent, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatCurrency, formatNumber } from "../../../domain/money";
import type {
  PosDiscountOption,
  Product,
  ProductSaleSelection,
  ProductVariant
} from "../../../domain/pos";

type ProductOptionDialogProps = {
  discounts: PosDiscountOption[];
  product: Product | null;
  onAdd(selection: ProductSaleSelection): void;
  onClose(): void;
};

const baseVariantForProduct = (product: Product): ProductVariant => ({
  id: product.variantId || "base",
  name: product.variantName || "ปกติ",
  sku: product.sku,
  price: product.price,
  cost: product.cost ?? 0,
  stock: product.stock,
  availableForSale: true
});

const sellableOptions = (product: Product) => {
  const variants =
    product.variants?.filter((variant) => {
      if (variant.availableForSale === false) return false;
      return !product.trackStock || variant.stock > 0;
    }) ?? [];

  return variants.length ? variants : [baseVariantForProduct(product)];
};

const discountAmount = (gross: number, discount?: PosDiscountOption) => {
  if (!discount) return 0;
  const value = Math.max(discount.value, 0);
  const amount =
    discount.type === "amount" ? value : gross * (Math.min(value, 100) / 100);

  return Math.round(Math.min(Math.max(amount, 0), gross));
};

const discountValueLabel = (discount: PosDiscountOption) =>
  discount.type === "amount"
    ? `฿${formatNumber(discount.value, 2).replace(/\.00$/, "")}`
    : `${formatNumber(discount.value, 2).replace(/\.00$/, "")}%`;

export const ProductOptionDialog = ({
  discounts,
  onAdd,
  onClose,
  product
}: ProductOptionDialogProps) => {
  const options = useMemo(
    () => (product ? sellableOptions(product) : []),
    [product]
  );
  const discountOptions = useMemo(
    () =>
      discounts
        .filter((discount) => discount.active && discount.label && discount.value > 0)
        .slice()
        .sort((a, b) => {
          const orderDiff = (a.order ?? 999) - (b.order ?? 999);
          if (orderDiff) return orderDiff;
          return a.label.localeCompare(b.label, "th");
        }),
    [discounts]
  );
  const hasBackendVariants = Boolean(product?.variants?.length);
  const [selectedId, setSelectedId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [discountId, setDiscountId] = useState("");

  useEffect(() => {
    setSelectedId(options[0]?.id ?? "");
    setQuantity(1);
    setNote("");
    setDiscountId("");
  }, [options, product?.id]);

  if (!product) {
    return null;
  }

  const selectedVariant = options.find((variant) => variant.id === selectedId) ?? options[0];
  const selectedDiscount = discountOptions.find(
    (discount) => discount.id === discountId
  );
  const maxQuantity = product.trackStock
    ? Math.max(selectedVariant?.stock ?? 0, 0)
    : 99;
  const safeQuantity = Math.min(Math.max(quantity, 1), Math.max(maxQuantity, 1));
  const unitPrice = selectedVariant?.price ?? product.price;
  const gross = unitPrice * safeQuantity;
  const lineDiscount = discountAmount(gross, selectedDiscount);
  const lineTotal = Math.max(gross - lineDiscount, 0);

  const setClampedQuantity = (value: number) => {
    setQuantity(Math.min(Math.max(Math.floor(value) || 1, 1), Math.max(maxQuantity, 1)));
  };

  const canSave = Boolean(selectedVariant) && (!product.trackStock || maxQuantity > 0);

  return (
    <div
      className="item-option-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <section
        aria-labelledby="item-option-title"
        aria-modal="true"
        className="item-option-dialog"
        role="dialog"
      >
        <header className="item-option-header">
          <button
            aria-label="ปิด"
            className="item-option-close"
            onClick={onClose}
            title="ปิด"
            type="button"
          >
            <X size={26} />
          </button>
          <h2 id="item-option-title">
            {product.name} {formatCurrency(unitPrice)}
          </h2>
          <button
            className="item-option-save ghost"
            disabled={!canSave}
            onClick={() => {
              if (!selectedVariant) return;
              onAdd({
                product,
                variant: hasBackendVariants ? selectedVariant : undefined,
                quantity: safeQuantity,
                note,
                discountRate:
                  selectedDiscount?.type === "percent" ? selectedDiscount.value : 0,
                discountType: selectedDiscount?.type,
                discountValue: selectedDiscount?.value,
                discountLabel: selectedDiscount?.label
              });
            }}
            type="button"
          >
            บันทึก
          </button>
        </header>

        <div className="item-option-body">
          <section className="item-option-section">
            <h3>ตัวแปร</h3>
            <div className="variant-choice-grid">
              {options.map((variant) => (
                <button
                  className={variant.id === selectedVariant?.id ? "selected" : ""}
                  disabled={product.trackStock && variant.stock <= 0}
                  key={variant.id}
                  onClick={() => {
                    setSelectedId(variant.id);
                    setClampedQuantity(quantity);
                  }}
                  type="button"
                >
                  <span>{variant.name || "ปกติ"}</span>
                  <strong>{formatCurrency(variant.price)}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="item-option-section">
            <h3>จำนวน</h3>
            <div className="quantity-slider-row">
              <button
                aria-label="ลดจำนวน"
                onClick={() => setClampedQuantity(safeQuantity - 1)}
                type="button"
              >
                <Minus size={24} />
              </button>
              <input
                aria-label="จำนวน"
                min="1"
                max={maxQuantity}
                onChange={(event) => setClampedQuantity(Number(event.target.value))}
                type="number"
                value={safeQuantity}
              />
              <button
                aria-label="เพิ่มจำนวน"
                onClick={() => setClampedQuantity(safeQuantity + 1)}
                type="button"
              >
                <Plus size={24} />
              </button>
            </div>
          </section>

          <label className="item-note-field">
            <span>
              <MessageSquare aria-hidden="true" size={20} />
              หมายเหตุ
            </span>
            <input
              onChange={(event) => setNote(event.target.value)}
              placeholder="เช่น หวานน้อย แยกน้ำแข็ง"
              value={note}
            />
          </label>

          <section className="item-option-section">
            <h3>ส่วนลด</h3>
            <div className="discount-toggle-grid">
              {discountOptions.map((discount) => {
                const selected = discount.id === discountId;

                return (
                  <button
                    className={selected ? "selected" : ""}
                    key={discount.id}
                    onClick={() =>
                      setDiscountId((current) =>
                        current === discount.id ? "" : discount.id
                      )
                    }
                    type="button"
                  >
                    <span>
                      {discount.type === "amount" ? (
                        <b aria-hidden="true">฿</b>
                      ) : (
                        <Percent aria-hidden="true" size={18} />
                      )}
                      {discount.label}
                      <small>{discountValueLabel(discount)}</small>
                    </span>
                    <i aria-hidden="true">
                      {selected && <Check size={14} />}
                    </i>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="item-option-footer">
          <span>
            {selectedVariant?.name || "ปกติ"} x {safeQuantity}
          </span>
          <strong>{formatCurrency(lineTotal)}</strong>
        </footer>
      </section>
    </div>
  );
};
