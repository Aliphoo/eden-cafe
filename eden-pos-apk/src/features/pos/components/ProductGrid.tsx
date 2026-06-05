import type { CSSProperties } from "react";
import { Package } from "lucide-react";
import { formatCurrency } from "../../../domain/money";
import type { Product } from "../../../domain/pos";

type ProductGridProps = {
  loading?: boolean;
  products: Product[];
  onAdd(product: Product): void;
};

const sellableVariants = (product: Product) =>
  (product.variants ?? []).filter((variant) => {
    if (variant.availableForSale === false) return false;
    return !product.trackStock || variant.stock > 0;
  });

const productPriceLabel = (product: Product) => {
  const variants = sellableVariants(product);

  if (variants.length <= 1) {
    return formatCurrency(variants[0]?.price ?? product.price);
  }

  const prices = variants.map((variant) => variant.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  return min === max
    ? formatCurrency(min)
    : `${formatCurrency(min)} - ${formatCurrency(max)}`;
};

export const ProductGrid = ({
  loading = false,
  products,
  onAdd
}: ProductGridProps) => (
  <section className="product-grid" aria-label="รายการสินค้า">
    {loading ? (
      <div className="product-empty-state">
        <Package aria-hidden="true" size={34} />
        <strong>กำลังโหลดเมนู Eden...</strong>
        <span>กำลังซิงค์รายการจากระบบหลังบ้าน</span>
      </div>
    ) : products.length === 0 ? (
      <div className="product-empty-state">
        <Package aria-hidden="true" size={34} />
        <strong>ยังไม่มีสินค้าให้แสดง</strong>
        <span>กดซิงค์เมนูหรือเพิ่มสินค้าในหน้ารายการสินค้า</span>
      </div>
    ) : (
      products.map((product) => {
      const hasStock = !product.trackStock || product.stock > 0;

      return (
        <button
          className="product-tile"
          disabled={!hasStock}
          key={product.id}
          onClick={() => onAdd(product)}
          style={
            {
              "--product-color": product.color
            } as CSSProperties
          }
          type="button"
        >
          {product.imageUrl ? (
            <img alt="" className="product-photo" src={product.imageUrl} />
          ) : (
            <span className="product-photo fallback">
              <Package aria-hidden="true" size={32} />
            </span>
          )}
          <span className="product-overlay">
            <span className="product-name">{product.name}</span>
            <span>{productPriceLabel(product)}</span>
          </span>
        </button>
      );
      })
    )}
  </section>
);
