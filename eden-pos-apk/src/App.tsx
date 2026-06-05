import {
  BarChart3,
  ChevronDown,
  LockKeyhole,
  LogIn,
  LogOut,
  Menu,
  PackageSearch,
  ReceiptText,
  Search,
  Settings2,
  ShoppingCart,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatCurrency } from "./domain/money";
import type { Product } from "./domain/pos";
import { receiptNetTotal } from "./domain/receiptAdjustments";
import { ProductEditorDialog } from "./features/pos/components/ProductEditorDialog";
import { LockScreen } from "./features/pos/components/LockScreen";
import { SplitBillDialog } from "./features/pos/components/SplitBillDialog";
import { StoreSettingsDialog } from "./features/pos/components/StoreSettingsDialog";
import { CustomerDisplayScreen } from "./features/pos/screens/CustomerDisplayScreen";
import { InventoryScreen } from "./features/pos/screens/InventoryScreen";
import { ReceiptsScreen } from "./features/pos/screens/ReceiptsScreen";
import { RegisterScreen } from "./features/pos/screens/RegisterScreen";
import { SalesSummaryScreen } from "./features/pos/screens/SalesSummaryScreen";
import {
  type ProductDraft,
  usePosRegister
} from "./features/pos/usePosRegister";
import {
  edenUserLabel,
  observeEdenAuth,
  resolveEdenAuthRedirect,
  signOutEdenAdmin
} from "./integrations/edenFirebase";
import { isCustomerDisplayRoute } from "./integrations/customerDisplay";
import { printPosReceiptToFrontBarPrinter } from "./integrations/posPrinter";
import edenLogo from "./assets/eden-logo.webp";

type View = "register" | "inventory" | "receipts" | "summary";

const navItems: Array<{
  id: View;
  label: string;
  icon: typeof ShoppingCart;
}> = [
  { id: "register", label: "ยอดขาย", icon: ShoppingCart },
  { id: "receipts", label: "ใบเสร็จรับเงิน", icon: ReceiptText },
  { id: "inventory", label: "รายการสินค้า", icon: PackageSearch }
];

const viewTitles: Record<View, string> = {
  register: "รายการทั้งหมด",
  inventory: "รายการสินค้า",
  receipts: "ใบเสร็จรับเงิน",
  summary: "สรุปยอดขาย"
};

const localDateKey = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

const PosApp = () => {
  const pos = usePosRegister();
  const [view, setView] = useState<View>("register");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<ProductDraft | null>(
    null
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminAccount, setAdminAccount] = useState("");
  const [authChecked, setAuthChecked] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [paymentRequest, setPaymentRequest] = useState(0);
  const [splitBillId, setSplitBillId] = useState<string | null>(null);
  const [lockScreenOpen, setLockScreenOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    const authFallbackTimer = window.setTimeout(() => {
      if (mounted) {
        setAuthChecked(true);
      }
    }, 2500);

    void resolveEdenAuthRedirect()
      .catch((error) => {
        console.warn("Eden Google sign-in redirect failed", error);
      })
      .finally(() => {
        if (mounted) {
          setAuthChecked(true);
        }
      });

    const unsubscribe = observeEdenAuth((user) => {
      if (!mounted) return;
      window.clearTimeout(authFallbackTimer);
      setAdminAccount(edenUserLabel(user));
      setAuthChecked(true);
    });

    return () => {
      mounted = false;
      window.clearTimeout(authFallbackTimer);
      unsubscribe();
    };
  }, []);

  const securityConfigured =
    pos.data.security.enabled && Boolean(pos.data.security.pinHash);
  const lockTimeoutMs =
    Math.max(1, pos.data.security.lockTimeoutMinutes) * 60 * 1000;

  useEffect(() => {
    if (!securityConfigured) {
      setLockScreenOpen(false);
      return;
    }

    let timer = window.setTimeout(() => {
      setLockScreenOpen(true);
    }, lockTimeoutMs);
    const resetTimer = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setLockScreenOpen(true);
      }, lockTimeoutMs);
    };
    const events = ["pointerdown", "keydown", "touchstart"];

    events.forEach((eventName) =>
      window.addEventListener(eventName, resetTimer, { passive: true })
    );

    return () => {
      window.clearTimeout(timer);
      events.forEach((eventName) =>
        window.removeEventListener(eventName, resetTimer)
      );
    };
  }, [lockScreenOpen, lockTimeoutMs, securityConfigured]);

  const lockNow = () => {
    if (!securityConfigured) {
      setSettingsOpen(true);
      setDrawerOpen(false);
      return;
    }

    setLockScreenOpen(true);
    setDrawerOpen(false);
  };

  const unlockWithPin = async (pin: string) => {
    const ok = await pos.verifySecurityPin(pin);
    if (ok) {
      setLockScreenOpen(false);
    }

    return ok;
  };

  const todayTotal = useMemo(() => {
    const today = localDateKey(new Date());
    return pos.data.receipts
      .filter(
        (receipt) =>
          (receipt.businessDate || localDateKey(new Date(receipt.createdAt))) ===
            today &&
          receipt.paymentStatus === "paid"
      )
      .reduce((sum, receipt) => sum + receiptNetTotal(receipt), 0);
  }, [pos.data.receipts]);

  const openEditor = (product?: Product) => {
    setEditingProduct(product ?? pos.createBlankProduct());
  };

  const selectView = (nextView: View) => {
    setView(nextView);
    setCategoryMenuOpen(false);
    setDrawerOpen(false);
  };

  const selectRegisterCategory = (category: string) => {
    pos.setQuery("");
    pos.setActiveCategory(category);
    setCategoryMenuOpen(false);
  };

  const focusProductSearch = () => {
    if (view !== "register") return;
    document.getElementById("product-search")?.focus();
  };

  const openAdminLogin = () => {
    setSettingsOpen(true);
    setDrawerOpen(false);
  };

  const logoutAdmin = async () => {
    setAuthBusy(true);
    try {
      await signOutEdenAdmin();
    } finally {
      setAuthBusy(false);
    }
  };

  const openBillFromReceipts = (receiptId: string, payNow = false) => {
    const receipt = pos.loadBillToCart(receiptId);

    if (!receipt) {
      return;
    }

    setView("register");
    setDrawerOpen(false);
    if (payNow) {
      setPaymentRequest((current) => current + 1);
    }
  };

  const printReceiptFromHistory = async (receiptId: string) => {
    const receipt = pos.data.receipts.find((item) => item.id === receiptId);
    if (!receipt) {
      throw new Error("ไม่พบใบเสร็จนี้");
    }

    await printPosReceiptToFrontBarPrinter(receipt, { fallback: true });
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          aria-label="เปิดเมนู"
          className="top-icon-button"
          onClick={() => setDrawerOpen(true)}
          title="เปิดเมนู"
          type="button"
        >
          <Menu size={26} />
        </button>

        <div className="app-brand-mark" aria-label="Eden Cafe POS">
          <img src={edenLogo} alt="Eden Cafe" />
        </div>

        {view === "register" ? (
          <button
            aria-expanded={categoryMenuOpen}
            className="top-title top-title-button"
            onClick={() => setCategoryMenuOpen((open) => !open)}
            title="เลือกหมวดหมู่"
            type="button"
          >
            <span>
              {pos.activeCategory === pos.categories[0]
                ? viewTitles.register
                : pos.activeCategory}
            </span>
            <ChevronDown aria-hidden="true" size={18} />
          </button>
        ) : (
          <div className="top-title">
            <span>{viewTitles[view]}</span>
          </div>
        )}

        {categoryMenuOpen && view === "register" && (
          <div className="header-category-menu" role="menu">
            {pos.categories.map((category) => (
              <button
                className={category === pos.activeCategory ? "active" : ""}
                key={category}
                onClick={() => selectRegisterCategory(category)}
                role="menuitem"
                type="button"
              >
                {category === pos.categories[0] ? viewTitles.register : category}
              </button>
            ))}
          </div>
        )}

        <div className="header-spacer" />

        <div className="day-summary" aria-label="ยอดขายวันนี้">
          <span>วันนี้</span>
          <strong>{formatCurrency(todayTotal)}</strong>
        </div>

        <button
          aria-label="ค้นหาสินค้า"
          className="top-icon-button"
          disabled={view !== "register"}
          onClick={focusProductSearch}
          title="ค้นหาสินค้า"
          type="button"
        >
          <Search size={24} />
        </button>

        <button
          aria-label="ตั้งค่า"
          className="top-icon-button"
          onClick={() => setSettingsOpen(true)}
          title="ตั้งค่า"
          type="button"
        >
          <Settings2 size={22} />
        </button>
      </header>

      {drawerOpen && (
        <div className="drawer-layer">
          <button
            aria-label="ปิดเมนู"
            className="drawer-scrim"
            onClick={() => setDrawerOpen(false)}
            type="button"
          />
          <aside className="app-drawer" aria-label="เมนูหลัก">
            <div className="drawer-profile">
              <div className="drawer-profile-content">
                <div className="drawer-logo-card">
                  <img src={edenLogo} alt="Eden Cafe" />
                </div>
                <strong>{pos.data.store.name}</strong>
                <span>POS 1</span>
                <small>{pos.data.store.receiptPrefix}</small>
                <div className="drawer-auth-status">
                  <span>
                    {!authChecked
                      ? "กำลังตรวจสอบบัญชีแอดมิน..."
                      : adminAccount
                      ? "ล็อกอินแอดมินแล้ว"
                      : "ยังไม่ได้ล็อกอินแอดมิน"}
                  </span>
                  {adminAccount && <small>{adminAccount}</small>}
                  {adminAccount ? (
                    <button
                      className="drawer-auth-button"
                      disabled={authBusy}
                      onClick={() => void logoutAdmin()}
                      type="button"
                    >
                      <LogOut aria-hidden="true" size={18} />
                      ล็อกเอ้าท์
                    </button>
                  ) : (
                    <button
                      className="drawer-auth-button"
                      disabled={authBusy}
                      onClick={openAdminLogin}
                      type="button"
                    >
                      <LogIn aria-hidden="true" size={18} />
                      ล็อกอินแอดมิน
                    </button>
                  )}
                </div>
              </div>
              <button
                aria-label="ปิดเมนู"
                className="drawer-close"
                onClick={() => setDrawerOpen(false)}
                title="ปิดเมนู"
                type="button"
              >
                <X size={18} />
              </button>
            </div>

            <nav className="drawer-nav">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={view === item.id ? "active" : ""}
                    key={item.id}
                    onClick={() => selectView(item.id)}
                    type="button"
                  >
                    <Icon aria-hidden="true" size={22} />
                    {item.label}
                  </button>
                );
              })}
              <button
                disabled={!securityConfigured}
                onClick={lockNow}
                title={
                  securityConfigured
                    ? "ล็อกหน้าจอ POS"
                    : "เปิดระบบล็อกหน้าจอในตั้งค่าก่อน"
                }
                type="button"
              >
                <LockKeyhole aria-hidden="true" size={22} />
                ล็อกหน้าจอ
              </button>
              <button
                onClick={() => {
                  setSettingsOpen(true);
                  setDrawerOpen(false);
                }}
                type="button"
              >
                <Settings2 aria-hidden="true" size={22} />
                การตั้งค่า
              </button>
              <button
                className={view === "summary" ? "active" : ""}
                onClick={() => selectView("summary")}
                type="button"
              >
                <BarChart3 aria-hidden="true" size={22} />
                สรุปยอดขาย
              </button>
            </nav>

            <div className="drawer-version">v.0.1.0</div>
          </aside>
        </div>
      )}

      {view === "register" && (
        <RegisterScreen
          activeCategory={pos.activeCategory}
          cart={pos.cart}
          catalogLoading={pos.catalogLoading}
          categories={pos.categories}
          categoryColors={pos.categoryColors}
          customers={pos.data.customers}
          discount={pos.discount}
          discounts={pos.data.discounts}
          loyaltyConfig={pos.data.loyaltyConfig}
          onAdd={pos.addToCart}
          onClear={pos.clearCart}
          onComplete={pos.completeSale}
          onDiscount={pos.setDiscount}
          onNewProduct={pos.createBlankProduct}
          onQuantity={pos.setQuantity}
          onSaveOpenBill={pos.saveOpenBill}
          onSaveCustomerLocal={pos.saveLocalCustomer}
          onSearch={pos.setQuery}
          onReorderCategories={pos.reorderCategories}
          onSelectCategory={selectRegisterCategory}
          onSyncCustomer={pos.syncCustomerFromPhone}
          paymentRequest={paymentRequest}
          products={pos.filteredProducts}
          query={pos.query}
          store={pos.data.store}
          tables={pos.data.tables}
          totals={pos.totals}
        />
      )}

      {view === "inventory" && (
        <InventoryScreen
          categories={pos.productCategoryOptions}
          onArchive={pos.archiveProduct}
          onCreate={() => openEditor()}
          onEdit={openEditor}
          products={pos.data.products.filter((product) => product.active)}
        />
      )}

      {view === "receipts" && (
        <ReceiptsScreen
          onAdjustPayment={pos.adjustReceiptPayment}
          onCancelBill={pos.cancelOpenBill}
          onEditBill={(receiptId) => openBillFromReceipts(receiptId)}
          onPayBill={(receiptId) => openBillFromReceipts(receiptId, true)}
          onPrintReceipt={printReceiptFromHistory}
          onRefundReceipt={pos.refundReceiptItems}
          onRestoreBill={pos.restoreCancelledBill}
          onRetryLoyalty={pos.retryLoyaltySync}
          onSplitBill={setSplitBillId}
          receipts={pos.data.receipts}
          taxRate={pos.data.store.taxRate}
        />
      )}

      {view === "summary" && (
        <SalesSummaryScreen receipts={pos.data.receipts} />
      )}

      <ProductEditorDialog
        categories={pos.productCategoryOptions}
        draft={editingProduct}
        onClose={() => setEditingProduct(null)}
        onSave={pos.saveProduct}
        open={Boolean(editingProduct)}
      />

      <StoreSettingsDialog
        onClose={() => setSettingsOpen(false)}
        onSave={pos.saveStore}
        onSaveSecurity={pos.saveSecuritySettings}
        onSyncCatalog={pos.syncEdenCatalog}
        open={settingsOpen}
        productCategories={pos.categories.filter(
          (category) => category !== pos.categories[0]
        )}
        security={pos.data.security}
        store={pos.data.store}
        syncState={pos.syncState}
      />

      <SplitBillDialog
        bill={
          splitBillId
            ? pos.data.receipts.find((receipt) => receipt.id === splitBillId) ??
              null
            : null
        }
        customers={pos.data.customers}
        loyaltyConfig={pos.data.loyaltyConfig}
        onClose={() => setSplitBillId(null)}
        onCompleteSplit={pos.splitOpenBill}
        onSaveCustomerLocal={pos.saveLocalCustomer}
        onSyncCustomer={pos.syncCustomerFromPhone}
        store={pos.data.store}
        tables={pos.data.tables}
      />

      <LockScreen
        locked={lockScreenOpen}
        onUnlock={unlockWithPin}
        storeName={pos.data.store.name}
        timeoutMinutes={pos.data.security.lockTimeoutMinutes}
      />
    </div>
  );
};

export const App = () =>
  isCustomerDisplayRoute() ? <CustomerDisplayScreen /> : <PosApp />;
