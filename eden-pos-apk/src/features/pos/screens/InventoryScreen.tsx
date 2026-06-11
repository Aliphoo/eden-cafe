import { Edit3, ImageOff, ListFilter, PackagePlus, Trash2 } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { formatCurrency } from "../../../domain/money";
import type { Product } from "../../../domain/pos";
import type { EdenCategoryOption } from "../../../integrations/edenFirebase";

type InventoryScreenProps = {
  categories: EdenCategoryOption[];
  products: Product[];
  onArchive(productId: string): void;
  onCreate(): void;
  onEdit(product: Product): void;
};

const ALL_INVENTORY_CATEGORY = "__all__";

const InventoryImagePreview = ({ product }: { product: Product }) => {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = product.imageUrl.trim();
  const hasImage = Boolean(imageUrl) && !imageFailed;
  const style = {
    "--product-color": product.color
  } as CSSProperties;

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);

  return (
    <span
      className={`inventory-product-media ${hasImage ? "has-image" : "missing-image"}`}
      style={style}
      title={
        hasImage
          ? `รูปสินค้า ${product.name}`
          : imageUrl
            ? `รูปสินค้าโหลดไม่ได้: ${product.name}`
            : `ยังไม่มีรูปสินค้า: ${product.name}`
      }
    >
      {hasImage ? (
        <img
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
          src={imageUrl}
        />
      ) : (
        <>
          <ImageOff aria-hidden="true" size={18} />
          <small>{imageUrl ? "รูปเสีย" : "ไม่มีภาพ"}</small>
        </>
      )}
    </span>
  );
};

export const InventoryScreen = ({
  categories,
  onArchive,
  onCreate,
  onEdit,
  products
}: InventoryScreenProps) => {
  const [selectedCategory, setSelectedCategory] = useState(ALL_INVENTORY_CATEGORY);

  const categoryOptions = useMemo(() => {
    const optionMap = new Map<string, EdenCategoryOption & { count: number }>();

    categories.forEach((category) => {
      optionMap.set(category.id, { ...category, count: 0 });
    });

    products.forEach((product) => {
      const id = product.categoryId || product.category;
      const existing = optionMap.get(id) || {
        id,
        name: product.category,
        color: product.color,
        count: 0
      };

      optionMap.set(id, {
        ...existing,
        name: existing.name || product.category,
        count: existing.count + 1
      });
    });

    return Array.from(optionMap.values())
      .filter((category) => category.count > 0)
      .sort((a, b) => {
        const orderA = a.order ?? 999;
        const orderB = b.order ?? 999;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name, "th");
      });
  }, [categories, products]);

  useEffect(() => {
    if (
      selectedCategory !== ALL_INVENTORY_CATEGORY &&
      !categoryOptions.some((category) => category.id === selectedCategory)
    ) {
      setSelectedCategory(ALL_INVENTORY_CATEGORY);
    }
  }, [categoryOptions, selectedCategory]);

  const activeCategory = categoryOptions.find(
    (category) => category.id === selectedCategory
  );
  const visibleProducts =
    selectedCategory === ALL_INVENTORY_CATEGORY
      ? products
      : products.filter(
          (product) =>
            product.categoryId === selectedCategory ||
            product.category === selectedCategory ||
            product.category === activeCategory?.name
        );
  const missingImageCount = visibleProducts.filter(
    (product) => !product.imageUrl.trim()
  ).length;

  return (
    <main className="workspace">
      <div className="section-toolbar">
        <div>
          <p>สินค้า</p>
          <h2>คลังสินค้า</h2>
        </div>
        <button className="tool-button" onClick={onCreate} type="button">
          <PackagePlus aria-hidden="true" size={18} />
          เพิ่มสินค้า
        </button>
      </div>

      <section className="inventory-filter-panel" aria-label="ตัวกรองสินค้า">
        <label>
          <span>
            <ListFilter aria-hidden="true" size={18} />
            หมวดหมู่
          </span>
          <select
            onChange={(event) => setSelectedCategory(event.target.value)}
            value={selectedCategory}
          >
            <option value={ALL_INVENTORY_CATEGORY}>
              ทุกรายการ ({products.length})
            </option>
            {categoryOptions.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name} ({category.count})
              </option>
            ))}
          </select>
        </label>
        <div className="inventory-filter-summary">
          <strong>{visibleProducts.length}</strong>
          <span>จาก {products.length} รายการ</span>
          <small>ไม่มีภาพ {missingImageCount} รายการ</small>
        </div>
      </section>

      <section className="inventory-table" aria-label="คลังสินค้า">
        <div className="inventory-row header">
          <span>สินค้า</span>
          <span>หมวดหมู่</span>
          <span>ราคา</span>
          <span>สต็อก</span>
          <span />
        </div>
        {visibleProducts.map((product) => (
          <div className="inventory-row" key={product.id}>
            <span className="inventory-product">
              <InventoryImagePreview product={product} />
              <strong>{product.name}</strong>
              <small>{product.sku}</small>
            </span>
            <span>{product.category}</span>
            <span>{formatCurrency(product.price)}</span>
            <span>{product.stock}</span>
            <span className="row-actions">
              <button
                aria-label={`แก้ไข ${product.name}`}
                className="icon-button"
                onClick={() => onEdit(product)}
                title="แก้ไข"
                type="button"
              >
                <Edit3 size={16} />
              </button>
              <button
                aria-label={`ลบ ${product.name}`}
                className="icon-button danger"
                onClick={() => onArchive(product.id)}
                title="ลบ"
                type="button"
              >
                <Trash2 size={16} />
              </button>
            </span>
          </div>
        ))}
        {!visibleProducts.length && (
          <div className="inventory-empty-row">ไม่มีสินค้าในหมวดหมู่นี้</div>
        )}
      </section>
    </main>
  );
};
