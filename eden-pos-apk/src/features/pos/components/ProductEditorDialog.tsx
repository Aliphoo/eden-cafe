import { ImagePlus, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { EdenCategoryOption } from "../../../integrations/edenFirebase";
import type { ProductDraft } from "../usePosRegister";

type ProductEditorDialogProps = {
  categories: EdenCategoryOption[];
  draft: ProductDraft | null;
  open: boolean;
  onClose(): void;
  onSave(product: ProductDraft): Promise<void> | void;
};

const colorOptions = ["#2f6f73", "#c65f2f", "#4f8cc9", "#6f8f4e", "#b9873c", "#7b5fa3"];

export const ProductEditorDialog = ({
  categories,
  draft,
  onClose,
  onSave,
  open
}: ProductEditorDialogProps) => {
  const [form, setForm] = useState<ProductDraft | null>(draft);
  const [categoryMode, setCategoryMode] = useState("existing");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setForm(draft);
    setImageFile(null);
    setImagePreview("");
    setMessage("");
    const matchedCategory = draft
      ? categories.find(
          (category) =>
            category.id === draft.categoryId || category.name === draft.category
        )
      : null;
    setCategoryMode(matchedCategory ? matchedCategory.id : "new");
    setNewCategoryName(matchedCategory ? "" : draft?.category ?? "");
  }, [categories, draft]);

  useEffect(() => {
    if (!imageFile) return;
    const preview = URL.createObjectURL(imageFile);
    setImagePreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [imageFile]);

  if (!open || !form) {
    return null;
  }

  const update = <Key extends keyof ProductDraft>(
    key: Key,
    value: ProductDraft[Key]
  ) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const selectedCategory = categories.find(
    (category) => category.id === categoryMode
  );
  const categoryName =
    categoryMode === "new"
      ? newCategoryName.trim()
      : selectedCategory?.name || form.category;
  const categoryId =
    categoryMode === "new" ? undefined : selectedCategory?.id || form.categoryId;
  const canSave = form.name.trim() && form.sku.trim() && categoryName;

  const handleSave = async () => {
    if (!canSave || saving) return;

    setSaving(true);
    setMessage(
      imageFile
        ? "กำลังแปลงรูปภาพเป็น .webp และบันทึกสินค้า..."
        : "กำลังบันทึกสินค้า..."
    );

    try {
      await onSave({
        ...form,
        category: categoryName,
        categoryId,
        imageFile
      });
      onClose();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "บันทึกสินค้าไม่สำเร็จ"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        aria-labelledby="product-title"
        className="dialog"
        role="dialog"
      >
        <div className="dialog-header">
          <div>
            <p>สินค้า</p>
            <h2 id="product-title">{form.name || "รายการใหม่"}</h2>
          </div>
          <button
            aria-label="ปิด"
            className="icon-button ghost"
            onClick={onClose}
            title="ปิด"
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="form-grid product-form-grid-apk">
          <label>
            ชื่อสินค้า
            <input
              onChange={(event) => update("name", event.target.value)}
              value={form.name}
            />
          </label>
          <label>
            SKU
            <input
              onChange={(event) => update("sku", event.target.value)}
              value={form.sku}
            />
          </label>
          <label>
            หมวดหมู่
            <select
              onChange={(event) => {
                const value = event.target.value;
                setCategoryMode(value);
                if (value === "new") {
                  setNewCategoryName(form.category || "");
                  return;
                }
                const category = categories.find((item) => item.id === value);
                if (category) {
                  update("category", category.name);
                  update("categoryId", category.id);
                }
              }}
              value={categoryMode}
            >
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
              <option value="new">+ เพิ่มหมวดหมู่ใหม่</option>
            </select>
          </label>
          {categoryMode === "new" && (
            <label>
              ชื่อหมวดหมู่ใหม่
              <input
                onChange={(event) => {
                  setNewCategoryName(event.target.value);
                  update("category", event.target.value);
                  update("categoryId", undefined);
                }}
                placeholder="เช่น บาร์ / ห้องครัว / เมนูพิเศษ"
                value={newCategoryName}
              />
            </label>
          )}
          <label>
            ราคา
            <input
              min="0"
              onChange={(event) => update("price", Number(event.target.value))}
              type="number"
              value={form.price}
            />
          </label>
          <label>
            สต็อก
            <input
              min="0"
              onChange={(event) => update("stock", Number(event.target.value))}
              type="number"
              value={form.stock}
            />
          </label>
          <label>
            URL รูปสินค้า
            <input
              onChange={(event) => update("imageUrl", event.target.value)}
              placeholder="https://..."
              value={form.imageUrl}
            />
          </label>
        </div>

        <section className="product-image-uploader">
          <div className="product-image-preview">
            {imagePreview || form.imageUrl ? (
              <img alt="" src={imagePreview || form.imageUrl} />
            ) : (
              <ImagePlus aria-hidden="true" size={38} />
            )}
          </div>
          <div>
            <strong>รูปสินค้า</strong>
            <span>เลือกไฟล์รูปภาพ ระบบจะแปลงเป็น .webp ก่อนอัปโหลดไปตามหมวดหมู่</span>
            <label className="image-upload-button">
              <ImagePlus aria-hidden="true" size={18} />
              เพิ่มรูปภาพ
              <input
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setImageFile(file);
                  if (file) {
                    setMessage(`เลือก ${file.name} แล้ว จะอัปโหลดเป็น .webp ตอนบันทึก`);
                  }
                }}
                type="file"
              />
            </label>
          </div>
        </section>

        <div className="swatch-row" role="group">
          {colorOptions.map((color) => (
            <button
              aria-label={`สี ${color}`}
              className={form.color === color ? "selected" : ""}
              key={color}
              onClick={() => update("color", color)}
              style={{ backgroundColor: color }}
              title={color}
              type="button"
            />
          ))}
        </div>

        <button
          className="primary-action"
          disabled={!canSave || saving}
          onClick={() => void handleSave()}
          type="button"
        >
          <Save aria-hidden="true" size={20} />
          {saving ? "กำลังบันทึก..." : "บันทึกสินค้า"}
        </button>
        {message && <small className="dialog-status-message">{message}</small>}
      </section>
    </div>
  );
};
