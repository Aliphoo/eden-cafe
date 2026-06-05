import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  CustomerProfile,
  LoyaltyConfig,
  LoyaltyRedemption,
  PosDiscountOption,
  PosTable,
  Product,
  ProductSaleSelection,
  StoreProfile
} from "../../../domain/pos";
import type { ProductDraft } from "../usePosRegister";
import { CartPanel } from "../components/CartPanel";
import { CategoryRail } from "../components/CategoryRail";
import { MemberPickerDialog } from "../components/MemberPickerDialog";
import { PaymentDialog } from "../components/PaymentDialog";
import { ProductGrid } from "../components/ProductGrid";
import { ProductOptionDialog } from "../components/ProductOptionDialog";

type RegisterScreenProps = {
  activeCategory: string;
  cart: ReturnType<typeof import("../usePosRegister").usePosRegister>["cart"];
  categories: string[];
  categoryColors: Record<string, string>;
  customers: CustomerProfile[];
  catalogLoading: boolean;
  discount: number;
  discounts: PosDiscountOption[];
  loyaltyConfig: LoyaltyConfig;
  products: Product[];
  query: string;
  store: StoreProfile;
  tables: PosTable[];
  totals: ReturnType<typeof import("../usePosRegister").usePosRegister>["totals"];
  paymentRequest: number;
  onAdd(selection: ProductSaleSelection): void;
  onClear(): void;
  onComplete: ReturnType<typeof import("../usePosRegister").usePosRegister>["completeSale"];
  onDiscount(value: number): void;
  onNewProduct(): ProductDraft;
  onSaveOpenBill: ReturnType<typeof import("../usePosRegister").usePosRegister>["saveOpenBill"];
  onQuantity(productId: string, quantity: number): void;
  onSaveCustomerLocal: ReturnType<typeof import("../usePosRegister").usePosRegister>["saveLocalCustomer"];
  onSearch(value: string): void;
  onReorderCategories(categories: string[]): void;
  onSelectCategory(category: string): void;
  onSyncCustomer: ReturnType<typeof import("../usePosRegister").usePosRegister>["syncCustomerFromPhone"];
};

export const RegisterScreen = ({
  activeCategory,
  cart,
  catalogLoading,
  categories,
  categoryColors,
  customers,
  discount,
  discounts,
  loyaltyConfig,
  onAdd,
  onClear,
  onComplete,
  onDiscount,
  onQuantity,
  onSaveOpenBill,
  onSaveCustomerLocal,
  onSearch,
  onReorderCategories,
  onSelectCategory,
  onSyncCustomer,
  paymentRequest,
  products,
  query,
  store,
  tables,
  totals
}: RegisterScreenProps) => {
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerProfile | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  useEffect(() => {
    if (paymentRequest > 0 && cart.length > 0) {
      setPaymentOpen(true);
    }
  }, [cart.length, paymentRequest]);

  const clearTicket = () => {
    onClear();
    setSelectedCustomer(null);
  };

  const customerDetails = (details: {
    customer?: CustomerProfile;
    customerName?: string;
    loyaltyRedemption?: LoyaltyRedemption;
    phone?: string;
    tableId?: string;
    tableNumber?: string;
    tableName?: string;
    tableZone?: string;
    note?: string;
  } = {}) => ({
    ...details,
    customer: details.customer ?? selectedCustomer ?? undefined,
    customerName:
      details.customerName ?? selectedCustomer?.displayName ?? "Walk-in Customer",
    phone: details.phone ?? selectedCustomer?.phone ?? ""
  });

  const completeSaleWithCustomer = (
    ...args: Parameters<typeof onComplete>
  ) => {
    const [method, paid, details] = args;
    const receipt = onComplete(method, paid, customerDetails(details));
    if (receipt) {
      setSelectedCustomer(null);
    }
    return receipt;
  };

  const saveOpenBillWithCustomer = (
    details?: Parameters<typeof onSaveOpenBill>[0]
  ) => {
    const receipt = onSaveOpenBill(customerDetails(details));
    if (receipt) {
      setSelectedCustomer(null);
    }
    return receipt;
  };

  return (
    <main className="workspace register-layout">
      <section className="sales-floor">
        <div className="search-row">
          <label className="search-box" htmlFor="product-search">
            <Search aria-hidden="true" size={18} />
            <input
              id="product-search"
              onChange={(event) => onSearch(event.target.value)}
              placeholder="ค้นหาสินค้า"
              value={query}
            />
          </label>
        </div>

        <ProductGrid
          loading={catalogLoading}
          onAdd={(product) => setSelectedProduct(product)}
          products={products}
        />

        <CategoryRail
          activeCategory={activeCategory}
          categories={categories}
          categoryColors={categoryColors}
          onReorderCategories={onReorderCategories}
          onSelectCategory={onSelectCategory}
        />
      </section>

      <CartPanel
        cart={cart}
        discount={discount}
        onClear={clearTicket}
        onCustomerClick={() => setMemberPickerOpen(true)}
        onDiscountChange={onDiscount}
        onPayment={() => setPaymentOpen(true)}
        onSaveOpenBill={() => {
          const receipt = saveOpenBillWithCustomer();
          if (receipt) {
            setPaymentOpen(false);
          }
        }}
        onQuantity={onQuantity}
        selectedCustomer={selectedCustomer}
        subtotal={totals.subtotal}
        tax={totals.tax}
        total={totals.total}
      />

      <MemberPickerDialog
        localCustomers={customers}
        onClose={() => setMemberPickerOpen(false)}
        onCreateNew={() => {
          setMemberPickerOpen(false);
          setPaymentOpen(true);
        }}
        onSelect={(customer) => {
          setSelectedCustomer(customer);
          setMemberPickerOpen(false);
        }}
        open={memberPickerOpen}
      />

      <PaymentDialog
        cart={cart}
        discount={totals.discount}
        initialCustomer={selectedCustomer}
        loyaltyConfig={loyaltyConfig}
        onClose={() => setPaymentOpen(false)}
        onComplete={completeSaleWithCustomer}
        onCustomerChange={setSelectedCustomer}
        onSaveCustomerLocal={onSaveCustomerLocal}
        onSaveOpenBill={saveOpenBillWithCustomer}
        onSyncCustomer={onSyncCustomer}
        open={paymentOpen}
        store={store}
        tables={tables}
        subtotal={totals.subtotal}
        tax={totals.tax}
        total={totals.total}
      />

      <ProductOptionDialog
        discounts={discounts}
        onAdd={(selection) => {
          onAdd(selection);
          setSelectedProduct(null);
        }}
        onClose={() => setSelectedProduct(null)}
        product={selectedProduct}
      />
    </main>
  );
};
