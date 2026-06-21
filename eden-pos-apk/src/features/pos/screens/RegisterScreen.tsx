import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { customerProfileFromReceipt } from "../receiptCustomer";

type RegisterScreenProps = {
  activeCategory: string;
  activeBill: ReturnType<typeof import("../usePosRegister").usePosRegister>["activeBill"];
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
  onRefreshLoyaltyConfig: ReturnType<typeof import("../usePosRegister").usePosRegister>["refreshLoyaltyConfig"];
  onSaveCustomerLocal: ReturnType<typeof import("../usePosRegister").usePosRegister>["saveLocalCustomer"];
  onSearch(value: string): void;
  onReorderCategories(categories: string[]): void;
  onSelectCategory(category: string): void;
  onSyncCustomer: ReturnType<typeof import("../usePosRegister").usePosRegister>["syncCustomerFromPhone"];
};

export const RegisterScreen = ({
  activeCategory,
  activeBill,
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
  onRefreshLoyaltyConfig,
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
  const [activeBillCustomerDetached, setActiveBillCustomerDetached] =
    useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const activeBillCustomer = useMemo(
    () => customerProfileFromReceipt(activeBill, customers),
    [activeBill, customers]
  );
  const activeBillId = activeBill?.id ?? "";
  const effectiveSelectedCustomer =
    selectedCustomer ??
    (activeBillCustomerDetached ? null : activeBillCustomer);

  useEffect(() => {
    if (!activeBillId) {
      setActiveBillCustomerDetached(false);
      return;
    }

    setSelectedCustomer(activeBillCustomer);
    setActiveBillCustomerDetached(false);
  }, [activeBillId]);

  const openPayment = useCallback(async () => {
    try {
      await onRefreshLoyaltyConfig();
    } catch (error) {
      console.warn("Unable to refresh loyalty config before payment", error);
    }
    setPaymentOpen(true);
  }, [onRefreshLoyaltyConfig]);

  useEffect(() => {
    if (paymentRequest > 0 && cart.length > 0) {
      void openPayment();
    }
  }, [cart.length, openPayment, paymentRequest]);

  const clearTicket = () => {
    onClear();
    setSelectedCustomer(null);
    setActiveBillCustomerDetached(false);
  };

  const handleCustomerChange = (customer: CustomerProfile | null) => {
    setSelectedCustomer(customer);
    setActiveBillCustomerDetached(Boolean(activeBill && !customer));
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
    customer: details.customer ?? effectiveSelectedCustomer ?? undefined,
    customerName:
      details.customerName ??
      effectiveSelectedCustomer?.displayName ??
      "Walk-in Customer",
    phone: details.phone ?? effectiveSelectedCustomer?.phone ?? ""
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
        onPayment={() => {
          void openPayment();
        }}
        onSaveOpenBill={() => {
          const receipt = saveOpenBillWithCustomer();
          if (receipt) {
            setPaymentOpen(false);
          }
        }}
        onQuantity={onQuantity}
        selectedCustomer={effectiveSelectedCustomer}
        subtotal={totals.subtotal}
        tax={totals.tax}
        total={totals.total}
      />

      <MemberPickerDialog
        localCustomers={customers}
        onClose={() => setMemberPickerOpen(false)}
        onCreateNew={() => {
          setMemberPickerOpen(false);
          void openPayment();
        }}
        onSelect={(customer) => {
          setSelectedCustomer(customer);
          setActiveBillCustomerDetached(false);
          setMemberPickerOpen(false);
        }}
        open={memberPickerOpen}
      />

      <PaymentDialog
        cart={cart}
        discount={totals.discount}
        initialCustomer={effectiveSelectedCustomer}
        loyaltyConfig={loyaltyConfig}
        onClose={() => setPaymentOpen(false)}
        onComplete={completeSaleWithCustomer}
        onCustomerChange={handleCustomerChange}
        onSaveCustomerLocal={onSaveCustomerLocal}
        onSaveOpenBill={saveOpenBillWithCustomer}
        onSyncCustomer={onSyncCustomer}
        open={paymentOpen}
        orderDiscount={totals.orderDiscount}
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
