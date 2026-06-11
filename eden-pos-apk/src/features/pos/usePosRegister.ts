import { useCallback, useEffect, useMemo, useState } from "react";
import {
  calculateTotals,
  createRefundNumber,
  createReceiptNumber,
  formatCurrency,
  formatNumber,
  paymentMethodLabel
} from "../../domain/money";
import {
  hashPin,
  makeSalt,
  verifyPinHash
} from "../../domain/security";
import type {
  CartLine,
  CustomerProfile,
  DiscountType,
  LoyaltySkipReason,
  LoyaltyRedemption,
  PaymentAdjustment,
  PaymentMethod,
  PosData,
  Product,
  ProductSaleSelection,
  ProductVariant,
  ReceiptRefundRequest,
  RefundAdjustment,
  Receipt,
  SecuritySettings,
  StoreProfile
} from "../../domain/pos";
import { calculateLoyaltyPreview } from "../../domain/loyalty";
import {
  buildRefundLines,
  receiptRefundStatus,
  receiptTotalRefunded,
  refundLinesDiscount,
  refundLinesTax,
  refundLinesTotal
} from "../../domain/receiptAdjustments";
import { localDateKey } from "../../domain/receiptDates";
import { mergeReceiptHistory } from "../../domain/receiptHistorySync";
import {
  authorizeEdenRefundManager,
  edenAuth,
  edenUserLabel,
  type EdenCategoryOption,
  applyPosLoyaltySale,
  loadEdenCatalog,
  loadEdenLoyaltyConfig,
  loadEdenPosOrderHistory,
  loadEdenLoyaltySummary,
  normalizePhone,
  observeEdenAuth,
  subscribeEdenDiscounts,
  subscribeEdenMenu,
  subscribeEdenTables,
  syncPosProductToEden,
  syncOrRegisterEdenCustomerByPhone,
  syncReceiptToEdenOrders
} from "../../integrations/edenFirebase";
import {
  buildCustomerDisplayState,
  publishCustomerDisplayState
} from "../../integrations/customerDisplay";
import {
  autoPrintOrderTickets,
  autoPrintPosReceipt,
  printPaidReceiptFromConfiguredTemplate,
  type AutoPrintOrderTicketsResult
} from "../../integrations/posPrinter";
import { loadPosData, makeId, savePosData } from "../../storage/posStore";
import {
  customerProfileFromReceipt,
  isWalkInCustomerName,
  receiptHasCustomerIdentity
} from "./receiptCustomer";

export type ProductDraft = Pick<
  Product,
  | "id"
  | "sku"
  | "name"
  | "category"
  | "categoryId"
  | "price"
  | "cost"
  | "stock"
  | "color"
  | "imageUrl"
> & {
  imageFile?: File | null;
};

type SyncState = {
  status: "idle" | "syncing" | "synced" | "failed";
  message: string;
  lastSyncedAt?: string;
};

type HistorySyncState = SyncState & {
  uploaded?: number;
  imported?: number;
  updated?: number;
  skipped?: number;
  conflicts?: number;
  scanned?: number;
  errors?: string[];
};

export type PosUpdateSafety = {
  canUpdate: boolean;
  blockingReasons: string[];
  warnings: string[];
  hasActiveCart: boolean;
  hasOpenBill: boolean;
  openBillCount: number;
  openBillNumbers: string[];
  ignoredOpenBillMarkers: number;
  hasUnsyncedOrders: boolean;
  hasPendingLoyaltySync: boolean;
  networkOnline: boolean;
};

type CustomerInput = {
  displayName: string;
  phone: string;
};

type BillDetails = {
  customer?: CustomerProfile;
  customerName?: string;
  phone?: string;
  tableId?: string;
  tableNumber?: string;
  tableName?: string;
  tableZone?: string;
  loyaltyRedemption?: LoyaltyRedemption;
  isTestOrder?: boolean;
  softLaunch?: boolean;
  note?: string;
};

type SecurityDraft = Pick<
  SecuritySettings,
  "enabled" | "lockTimeoutMinutes"
> & {
  pin?: string;
};

type SplitQuantities = Record<string, number>;

const ALL_CATEGORY = "ทั้งหมด";

const sellableVariants = (product: Product) =>
  (product.variants ?? []).filter((variant) => {
    if (variant.availableForSale === false) return false;
    return !product.trackStock || variant.stock > 0;
  });

const cartProductId = (product: Product, variant?: ProductVariant) =>
  variant ? `${product.sourceProductId || product.id}::${variant.id}` : product.id;

const stockForSelection = (product: Product, variant?: ProductVariant) =>
  product.trackStock
    ? Math.max(variant?.stock ?? product.stock, 0)
    : Number.POSITIVE_INFINITY;

const lineDiscountAmount = (
  unitPrice: number,
  quantity: number,
  discountType: DiscountType = "percent",
  discountValue = 0
) => {
  const gross = Math.max(unitPrice, 0) * Math.max(quantity, 0);
  const safeValue = Math.max(discountValue, 0);
  const discount =
    discountType === "amount"
      ? safeValue
      : gross * (Math.min(safeValue, 100) / 100);

  return Math.round(Math.min(Math.max(discount, 0), gross));
};

const receiptLineDiscount = (receipt: Receipt) =>
  receipt.items.reduce((sum, item) => sum + (item.lineDiscount ?? 0), 0);

const businessDate = localDateKey;

const isOpenBill = (receipt: Receipt) =>
  receipt.billStatus !== "cancelled" &&
  (receipt.isOpenBill ||
    receipt.billStatus === "open" ||
    receipt.paymentStatus === "pending");

const receiptHasOpenBillContent = (receipt: Receipt) =>
  receipt.items.some((item) => Math.max(item.quantity, 0) > 0) ||
  Math.max(
    receipt.totalAmount ?? receipt.total ?? receipt.subtotal ?? 0,
    receipt.subtotal ?? 0
  ) > 0;

const isActionableOpenBill = (receipt: Receipt) =>
  isOpenBill(receipt) && receiptHasOpenBillContent(receipt);

const applyRefundStockReturns = (
  products: Product[],
  refundLines: RefundAdjustment["lines"]
) =>
  products.map((product) => {
    if (!product.trackStock) return product;

    const productRefundLines = refundLines.filter(
      (line) =>
        line.stockAction === "return_to_stock" &&
        (line.sourceProductId === product.id ||
          line.productId === product.id ||
          line.productId.split("::")[0] === product.id)
    );

    if (!productRefundLines.length) return product;

    if (product.variants?.length) {
      const variants = product.variants.map((variant) => {
        const returnedQuantity = productRefundLines
          .filter((line) => line.variantId === variant.id)
          .reduce((sum, line) => sum + line.quantity, 0);

        return returnedQuantity
          ? { ...variant, stock: variant.stock + returnedQuantity }
          : variant;
      });

      return {
        ...product,
        variants,
        stock: variants.reduce(
          (sum, variant) => sum + Math.max(variant.stock, 0),
          0
        )
      };
    }

    const returnedQuantity = productRefundLines.reduce(
      (sum, line) => sum + line.quantity,
      0
    );

    return returnedQuantity
      ? { ...product, stock: product.stock + returnedQuantity }
      : product;
  });

export const usePosRegister = () => {
  const [data, setData] = useState<PosData>(() => loadPosData());
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORY);
  const [discount, setDiscount] = useState(0);
  const [activeBillId, setActiveBillId] = useState<string | null>(null);
  const [edenCategories, setEdenCategories] = useState<EdenCategoryOption[]>(
    []
  );
  const [syncState, setSyncState] = useState<SyncState>({
    status: "idle",
    message: "ยังไม่ได้ซิงค์ข้อมูล Eden"
  });
  const [historySyncState, setHistorySyncState] = useState<HistorySyncState>({
    status: "idle",
    message: "ยังไม่ได้ซิงค์ประวัติ"
  });

  const [networkOnline, setNetworkOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false
  );

  const resolveOrderModeFlags = (
    details: BillDetails = {},
    sourceReceipt?: Receipt | null
  ) => ({
    isTestOrder: sourceReceipt?.isTestOrder === true || details.isTestOrder === true,
    softLaunch:
      sourceReceipt?.softLaunch === true ||
      details.softLaunch === true ||
      data.store.softLaunch === true
  });

  const loyaltySkipReasonFor = (
    flags: Pick<Receipt, "isTestOrder" | "softLaunch">
  ): LoyaltySkipReason | "" => {
    if (flags.isTestOrder) return "test-order";
    if (flags.softLaunch) return "soft-launch";
    return "";
  };

  useEffect(() => {
    savePosData(data);
  }, [data]);

  useEffect(() => {
    const updateNetworkState = () => {
      setNetworkOnline(navigator.onLine !== false);
    };

    window.addEventListener("online", updateNetworkState);
    window.addEventListener("offline", updateNetworkState);
    updateNetworkState();

    return () => {
      window.removeEventListener("online", updateNetworkState);
      window.removeEventListener("offline", updateNetworkState);
    };
  }, []);

  const syncEdenCatalog = useCallback(async () => {
    setSyncState({ status: "syncing", message: "กำลังซิงค์เมนูจาก Eden Cafe..." });

    try {
      const [remote, loyaltyConfig] = await Promise.all([
        loadEdenCatalog(),
        loadEdenLoyaltyConfig()
      ]);
      const remoteCategories = Object.entries(remote.categories).map(
        ([id, category]) => ({
          id,
          name:
            category.name ||
            category.nameTh ||
            category.nameEn ||
            id,
          color: category.color,
          order: category.order
        })
      );
      setEdenCategories(
        remoteCategories.sort((a, b) => {
          const orderA = a.order ?? 999;
          const orderB = b.order ?? 999;
          if (orderA !== orderB) return orderA - orderB;
          return a.name.localeCompare(b.name, "th");
        })
      );
      setData((current) => ({
        ...current,
        discounts: remote.discounts,
        loyaltyConfig,
        products: remote.products.length ? remote.products : current.products,
        tables: remote.tables,
        store: {
          ...current.store,
          promptPayAccountId:
            remote.promptPay.activeAccountId || current.store.promptPayAccountId,
          promptPayAccounts:
            remote.promptPay.accounts.length > 0
              ? remote.promptPay.accounts
              : current.store.promptPayAccounts,
          promptPayEnabled: remote.promptPay.enabled,
          promptPayLocked: true,
          promptPayId:
            remote.promptPay.promptPayId || current.store.promptPayId,
          merchantName:
            remote.promptPay.merchantName || current.store.merchantName,
          city: remote.promptPay.city || current.store.city
        }
      }));
      setSyncState({
        status: "synced",
        message: `ซิงค์เมนู Eden แล้ว ${formatNumber(remote.products.length)} รายการ`,
        lastSyncedAt: new Date().toISOString()
      });
    } catch (error) {
      setSyncState({
        status: "failed",
        message:
          error instanceof Error
            ? `ซิงค์ Eden ไม่สำเร็จ: ${error.message}`
            : "ซิงค์ Eden ไม่สำเร็จ"
      });
    }
  }, []);

  useEffect(() => {
    void syncEdenCatalog();
  }, [syncEdenCatalog]);

  useEffect(() => {
    let stopMenu: (() => void) | null = null;
    let stopDiscounts: (() => void) | null = null;
    let stopTables: (() => void) | null = null;

    const attachRealtimeListeners = () => {
      stopMenu?.();
      stopDiscounts?.();
      stopTables?.();
      stopMenu = subscribeEdenMenu(
        (remote) => {
          const remoteCategories = Object.entries(remote.categories).map(
            ([id, category]) => ({
              id,
              name:
                category.name ||
                category.nameTh ||
                category.nameEn ||
                id,
              color: category.color,
              order: category.order
            })
          );
          setEdenCategories(
            remoteCategories.sort((a, b) => {
              const orderA = a.order ?? 999;
              const orderB = b.order ?? 999;
              if (orderA !== orderB) return orderA - orderB;
              return a.name.localeCompare(b.name, "th");
            })
          );
          setData((current) => ({
            ...current,
            products: remote.products.length ? remote.products : current.products
          }));
          setSyncState({
            status: "synced",
            message: `ซิงค์เมนู Eden แล้ว ${formatNumber(remote.products.length)} รายการ`,
            lastSyncedAt: new Date().toISOString()
          });
        },
        (error) => {
          setSyncState((current) => ({
            ...current,
            status: "failed",
            message: `ซิงค์เมนู POS ไม่สำเร็จ: ${error.message}`
          }));
        }
      );
      stopDiscounts = subscribeEdenDiscounts(
        (discounts) => {
          setData((current) => ({
            ...current,
            discounts
          }));
        },
        (error) => {
          setSyncState((current) => ({
            ...current,
            status: "failed",
            message: `ซิงค์ส่วนลด POS ไม่สำเร็จ: ${error.message}`
          }));
        }
      );
      stopTables = subscribeEdenTables(
        (tables) => {
          setData((current) => ({
            ...current,
            tables
          }));
        },
        (error) => {
          setSyncState((current) => ({
            ...current,
            status: "failed",
            message: `ซิงค์โต๊ะ POS ไม่สำเร็จ: ${error.message}`
          }));
        }
      );
    };

    attachRealtimeListeners();

    const stopAuth = observeEdenAuth((user) => {
      attachRealtimeListeners();

      if (user) {
        void syncEdenCatalog();
      }
    });

    return () => {
      stopMenu?.();
      stopDiscounts?.();
      stopTables?.();
      stopAuth();
    };
  }, [syncEdenCatalog]);

  const activeProducts = useMemo(
    () => data.products.filter((product) => product.active),
    [data.products]
  );
  const catalogLoading =
    activeProducts.length === 0 &&
    (syncState.status === "idle" || syncState.status === "syncing");

  const naturalCategories = useMemo(
    () => [
      ALL_CATEGORY,
      ...Array.from(new Set(activeProducts.map((product) => product.category)))
    ],
    [activeProducts]
  );
  const categories = useMemo(() => {
    const available = naturalCategories.filter(
      (category) => category !== ALL_CATEGORY
    );
    const savedOrder = data.categoryOrder.filter((category) =>
      available.includes(category)
    );
    const newCategories = available.filter(
      (category) => !savedOrder.includes(category)
    );

    return [ALL_CATEGORY, ...savedOrder, ...newCategories];
  }, [data.categoryOrder, naturalCategories]);
  const categoryColors = useMemo(() => {
    const colorMap: Record<string, string> = {
      [ALL_CATEGORY]: "#1A9345"
    };

    activeProducts.forEach((product) => {
      if (!colorMap[product.category]) {
        colorMap[product.category] = product.color;
      }
    });

    return colorMap;
  }, [activeProducts]);

  useEffect(() => {
    if (!categories.includes(activeCategory)) {
      setActiveCategory(ALL_CATEGORY);
    }
  }, [activeCategory, categories]);

  const reorderCategories = useCallback((nextCategories: string[]) => {
    setData((current) => {
      const activeCategoryNames = new Set(
        current.products
          .filter((product) => product.active)
          .map((product) => product.category)
      );
      const nextOrder = nextCategories
        .filter((category) => category !== ALL_CATEGORY)
        .map((category) => category.trim())
        .filter(
          (category, index, list) =>
            Boolean(category) &&
            activeCategoryNames.has(category) &&
            list.indexOf(category) === index
        );

      return {
        ...current,
        categoryOrder: nextOrder
      };
    });
  }, []);

  const productCategoryOptions = useMemo(() => {
    const optionMap = new Map<string, EdenCategoryOption>();

    edenCategories.forEach((category) => {
      optionMap.set(category.id, category);
    });

    activeProducts.forEach((product) => {
      const id = product.categoryId || product.category;
      if (!optionMap.has(id)) {
        optionMap.set(id, {
          id,
          name: product.category,
          color: product.color
        });
      }
    });

    return Array.from(optionMap.values()).sort((a, b) => {
      const orderA = a.order ?? 999;
      const orderB = b.order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name, "th");
    });
  }, [activeProducts, edenCategories]);

  const filteredProducts = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();

    return activeProducts.filter((product) => {
      const matchesCategory =
        activeCategory === ALL_CATEGORY || product.category === activeCategory;
      const matchesQuery =
        !lowerQuery ||
        product.name.toLowerCase().includes(lowerQuery) ||
        product.sku.toLowerCase().includes(lowerQuery) ||
        sellableVariants(product).some(
          (variant) =>
            variant.name.toLowerCase().includes(lowerQuery) ||
            variant.sku.toLowerCase().includes(lowerQuery)
        );

      return matchesCategory && matchesQuery;
    });
  }, [activeCategory, activeProducts, query]);

  const totals = useMemo(
    () => calculateTotals(cart, data.store, discount),
    [cart, data.store, discount]
  );

  const openBills = useMemo(
    () =>
      data.receipts
        .filter(isActionableOpenBill)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        ),
    [data.receipts]
  );

  const updateSafety = useMemo<PosUpdateSafety>(() => {
    const hasActiveCart = cart.length > 0;
    const hasOpenBill = openBills.length > 0;
    const openBillNumbers = openBills
      .slice(0, 5)
      .map((receipt) => receipt.number || receipt.id)
      .filter(Boolean);
    const ignoredOpenBillMarkers = data.receipts.filter(
      (receipt) => isOpenBill(receipt) && !receiptHasOpenBillContent(receipt)
    ).length;
    const hasUnsyncedOrders = data.receipts.some(
      (receipt) => receipt.status !== "cancelled" && receipt.syncStatus !== "synced"
    );
    const hasPendingLoyaltySync = data.receipts.some((receipt) =>
      ["local", "pending", "syncing"].includes(receipt.loyaltySyncStatus || "")
    );
    const blockingReasons = [
      hasActiveCart ? "Finish or clear the current cart before updating." : "",
      hasOpenBill
        ? `Close ${openBills.length} open bill${openBills.length === 1 ? "" : "s"} before updating${openBillNumbers.length ? `: ${openBillNumbers.join(", ")}` : "."}`
        : "",
      hasUnsyncedOrders ? "Wait for all POS orders to finish syncing." : "",
      hasPendingLoyaltySync ? "Wait for loyalty sync to finish." : "",
      networkOnline ? "" : "Connect the POS to the network before updating."
    ].filter(Boolean);
    const warnings = [
      ignoredOpenBillMarkers > 0
        ? `Ignored ${ignoredOpenBillMarkers} empty stale open-bill marker${ignoredOpenBillMarkers === 1 ? "" : "s"} while checking update safety.`
        : ""
    ].filter(Boolean);

    return {
      canUpdate: blockingReasons.length === 0,
      blockingReasons,
      warnings,
      hasActiveCart,
      hasOpenBill,
      openBillCount: openBills.length,
      openBillNumbers,
      ignoredOpenBillMarkers,
      hasUnsyncedOrders,
      hasPendingLoyaltySync,
      networkOnline
    };
  }, [cart.length, data.receipts, networkOnline, openBills]);

  const customerDisplayState = useMemo(
    () =>
      buildCustomerDisplayState({
        cart,
        store: data.store,
        totals
      }),
    [cart, data.store, totals]
  );

  useEffect(() => {
    void publishCustomerDisplayState(customerDisplayState);
  }, [customerDisplayState]);

  const addToCart = (selection: Product | ProductSaleSelection) => {
    const isConfiguredSelection = "product" in selection;
    const product = isConfiguredSelection ? selection.product : selection;
    const variant = isConfiguredSelection ? selection.variant : undefined;
    const quantityToAdd = isConfiguredSelection
      ? Math.max(1, Math.floor(selection.quantity || 1))
      : 1;
    const discountType: DiscountType = isConfiguredSelection
      ? selection.discountType ?? "percent"
      : "percent";
    const discountValue = isConfiguredSelection
      ? Math.max(selection.discountValue ?? selection.discountRate ?? 0, 0)
      : 0;
    const discountLabel = isConfiguredSelection ? selection.discountLabel ?? "" : "";
    const note = isConfiguredSelection ? selection.note?.trim() ?? "" : "";
    const productId = cartProductId(product, variant);
    const sourceProductId = product.sourceProductId || product.id.split("::")[0];
    const unitPrice = variant?.price ?? product.price;
    const availableStock = stockForSelection(product, variant);

    if (product.trackStock && availableStock <= 0) {
      return;
    }

    setCart((current) => {
      const existing = current.find((line) => line.productId === productId);
      const currentQuantity = existing?.quantity ?? 0;
      const nextQuantity = currentQuantity + quantityToAdd;

      if (product.trackStock && currentQuantity >= availableStock) {
        return current;
      }

      if (existing) {
        const quantity = Math.min(nextQuantity, availableStock);
        const activeDiscountType =
          existing.lineDiscountType ?? discountType;
        const activeDiscountValue =
          existing.lineDiscountValue ?? existing.lineDiscountRate ?? discountValue;
        const nextNote =
          note && existing.note && existing.note !== note
            ? `${existing.note}; ${note}`
            : existing.note || note;

        return current.map((line) =>
          line.productId === productId
            ? {
                ...line,
                note: nextNote,
                quantity,
                lineDiscount: lineDiscountAmount(
                  line.unitPrice,
                  quantity,
                  activeDiscountType,
                  activeDiscountValue
                ),
                lineDiscountRate:
                  activeDiscountType === "percent" ? activeDiscountValue : 0,
                lineDiscountType: activeDiscountType,
                lineDiscountValue: activeDiscountValue,
                lineDiscountLabel:
                  line.lineDiscountLabel ||
                  (activeDiscountValue > 0
                    ? discountLabel ||
                      (activeDiscountType === "amount"
                        ? `ส่วนลด ${formatCurrency(activeDiscountValue)}`
                        : `ส่วนลด ${activeDiscountValue}%`)
                    : "")
              }
            : line
        );
      }

      const quantity = Math.min(quantityToAdd, availableStock);
      const lineDiscount = lineDiscountAmount(
        unitPrice,
        quantity,
        discountType,
        discountValue
      );

      return [
        ...current,
        {
          productId,
          sourceProductId,
          variantId: variant?.id || product.variantId || "base",
          variantName: variant?.name || product.variantName || "",
          sku: variant?.sku || product.sku,
          name: product.name,
          category: product.category,
          unitPrice,
          cost: variant?.cost ?? product.cost ?? 0,
          note,
          lineDiscount,
          lineDiscountRate: discountType === "percent" ? discountValue : 0,
          lineDiscountType: discountType,
          lineDiscountValue: discountValue,
          lineDiscountLabel:
            discountValue > 0
              ? discountLabel ||
                (discountType === "amount"
                  ? `ส่วนลด ${formatCurrency(discountValue)}`
                  : `ส่วนลด ${discountValue}%`)
              : "",
          taxEnabled: product.taxEnabled !== false,
          quantity
        }
      ];
    });
  };

  const setQuantity = (productId: string, nextQuantity: number) => {
    const line = cart.find((item) => item.productId === productId);
    const sourceProductId = line?.sourceProductId || productId.split("::")[0];
    const product = data.products.find(
      (item) => item.id === productId || item.id === sourceProductId
    );
    const variant = product?.variants?.find(
      (item) => item.id === line?.variantId
    );
    const maxQuantity = product?.trackStock
      ? stockForSelection(product, variant)
      : nextQuantity;
    const quantity = Math.min(Math.max(nextQuantity, 0), maxQuantity);

    setCart((current) =>
      quantity === 0
        ? current.filter((line) => line.productId !== productId)
        : current.map((line) =>
            line.productId === productId
              ? {
                  ...line,
                  quantity,
                  lineDiscount: lineDiscountAmount(
                    line.unitPrice,
                    quantity,
                    line.lineDiscountType ?? "percent",
                    line.lineDiscountValue ?? line.lineDiscountRate ?? 0
                  )
                }
              : line
          )
    );
  };

  const clearCart = () => {
    setCart([]);
    setDiscount(0);
    setActiveBillId(null);
  };

  const saveProduct = async (draft: ProductDraft) => {
    const localDraft = {
      ...draft,
      imageFile: undefined,
      imageUrl: draft.imageUrl.trim()
    };

    setData((current) => {
      const exists = current.products.some((product) => product.id === localDraft.id);
      const product: Product = {
        ...localDraft,
        cost: Math.max(0, localDraft.cost ?? 0),
        price: Math.max(0, localDraft.price),
        stock: Math.max(0, localDraft.stock),
        imageUrl: localDraft.imageUrl,
        taxEnabled: true,
        trackStock: false,
        active: true
      };

      return {
        ...current,
        products: exists
          ? current.products.map((item) =>
              item.id === product.id ? product : item
            )
          : [...current.products, product]
      };
    });

    try {
      const synced = await syncPosProductToEden(
        {
          ...localDraft,
          taxEnabled: true,
          trackStock: false
        },
        { imageFile: draft.imageFile }
      );

      setEdenCategories((current) => {
        const next = [
          synced.category,
          ...current.filter((category) => category.id !== synced.category.id)
        ];
        return next.sort((a, b) => {
          const orderA = a.order ?? 999;
          const orderB = b.order ?? 999;
          if (orderA !== orderB) return orderA - orderB;
          return a.name.localeCompare(b.name, "th");
        });
      });

      setData((current) => ({
        ...current,
        products: current.products.map((product) =>
          product.id === localDraft.id
            ? {
                ...product,
                id: synced.id,
                category: synced.category.name,
                categoryId: synced.category.id,
                imageUrl: synced.imageUrl
              }
            : product
        )
      }));
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `บันทึกในเครื่องแล้ว แต่ส่งเข้าหลังบ้านไม่สำเร็จ: ${error.message}`
          : "บันทึกในเครื่องแล้ว แต่ส่งเข้าหลังบ้านไม่สำเร็จ"
      );
    }
  };

  const archiveProduct = (productId: string) => {
    setData((current) => ({
      ...current,
      products: current.products.map((product) =>
        product.id === productId ? { ...product, active: false } : product
      )
    }));
    setCart((current) => current.filter((line) => line.productId !== productId));
  };

  const saveStore = (store: StoreProfile) => {
    setData((current) => ({
      ...current,
      store: {
        ...store,
        taxRate: Math.max(0, store.taxRate)
      }
    }));
  };

  const saveSecuritySettings = async (settings: SecurityDraft) => {
    let pinHash = data.security.pinHash;
    let pinSalt = data.security.pinSalt;

    if (settings.pin) {
      pinSalt = makeSalt();
      pinHash = await hashPin(settings.pin, pinSalt);
    }

    if (!settings.enabled) {
      pinHash = "";
      pinSalt = "";
    }

    setData((current) => ({
      ...current,
      security: {
        ...current.security,
        enabled: settings.enabled,
        lockTimeoutMinutes: Math.max(1, settings.lockTimeoutMinutes),
        pinHash,
        pinSalt,
        updatedAt: new Date().toISOString()
      }
    }));
  };

  const verifySecurityPin = (pin: string) =>
    verifyPinHash(pin, data.security.pinSalt, data.security.pinHash);

  const upsertCustomer = (customer: CustomerProfile) => {
    setData((current) => ({
      ...current,
      customers: [
        customer,
        ...current.customers.filter(
          (item) =>
            item.uid !== customer.uid &&
            item.phoneNormalized !== customer.phoneNormalized
        )
      ]
    }));
  };

  const saveLocalCustomer = (input: CustomerInput) => {
    const phoneNormalized = normalizePhone(input.phone);
    const now = new Date().toISOString();
    const customer: CustomerProfile = {
      uid: phoneNormalized ? `local-phone-${phoneNormalized}` : makeId("local-customer"),
      displayName: input.displayName.trim() || "Walk-in Customer",
      phone: input.phone.trim(),
      phoneNormalized,
      tier: "Local",
      memberCode: phoneNormalized ? `LOCAL${phoneNormalized.slice(-6)}` : "LOCAL",
      profileSynced: false,
      source: "local",
      updatedAt: now
    };

    upsertCustomer(customer);
    return customer;
  };

  const syncCustomerFromPhone = async (input: CustomerInput) => {
    const customer = await syncOrRegisterEdenCustomerByPhone(input);
    upsertCustomer(customer);
    return customer;
  };

  const updateReceiptSyncState = (
    receiptId: string,
    patch: Partial<Receipt>
  ) => {
    setData((current) => ({
      ...current,
      receipts: current.receipts.map((receipt) =>
        receipt.id === receiptId ? { ...receipt, ...patch } : receipt
      )
    }));
  };

  const applyOrderTicketPrintResult = (
    receiptId: string,
    result: false | AutoPrintOrderTicketsResult
  ) => {
    if (!result) return;

    const printedAt =
      result.printedItems[0]?.updatedAt || new Date().toISOString();
    updateReceiptSyncState(receiptId, {
      orderTicketPrintedItems: result.printedItems,
      orderTicketPrintedAt: printedAt
    });
  };

  const autoPrintAndTrackOrderTickets = async (receipt: Receipt) => {
    const result = await autoPrintOrderTickets(receipt);
    applyOrderTicketPrintResult(receipt.id, result);
    return result;
  };

  const printPaidReceiptAfterPayment = async (receipt: Receipt) => {
    const autoPrinted = await autoPrintPosReceipt(receipt);

    if (autoPrinted) {
      return autoPrinted;
    }

    return printPaidReceiptFromConfiguredTemplate(receipt, {
      fallback: true,
      silent: false
    });
  };

  const updateCustomerLoyaltyCache = (
    customerUid: string,
    points?: number,
    tier?: string
  ) => {
    setData((current) => ({
      ...current,
      customers: current.customers.map((customer) =>
        customer.uid === customerUid
          ? {
              ...customer,
              points: points ?? customer.points,
              tier: tier || customer.tier,
              updatedAt: new Date().toISOString()
            }
          : customer
      )
    }));
  };

  const refreshCustomerLoyalty = async (customerUid: string) => {
    const summary = await loadEdenLoyaltySummary(customerUid);
    updateCustomerLoyaltyCache(
      customerUid,
      summary.pointsBalance,
      summary.tier
    );
    return summary;
  };

  const receiptCanApplyLoyalty = (receipt: Receipt) =>
    receipt.paymentStatus === "paid" &&
    receipt.billStatus === "paid" &&
    !receipt.isOpenBill &&
    receipt.isTestOrder !== true &&
    receipt.softLaunch !== true &&
    Boolean(receipt.customerUid && receipt.customerProfileSynced);

  const buildLoyaltyReceiptFields = (
    receiptNo: string,
    lines: CartLine[],
    sourceTotals: typeof totals,
    details: BillDetails,
    sourceReceipt?: Receipt | null
  ): Partial<Receipt> & { payableTotal: number } => {
    const orderFlags = resolveOrderModeFlags(details, sourceReceipt);
    const skipReason = loyaltySkipReasonFor(orderFlags);
    const fallbackCustomer =
      shouldPreserveReceiptCustomer(details, sourceReceipt) && sourceReceipt
        ? customerProfileFromReceipt(sourceReceipt)
        : null;
    const loyaltyCustomer = details.customer ?? fallbackCustomer ?? undefined;
    const preview = calculateLoyaltyPreview({
      config: data.loyaltyConfig,
      customer: loyaltyCustomer,
      lines,
      normalDiscount: sourceTotals.discount,
      requestedRedeemPoints: details.loyaltyRedemption?.redeemedPoints ?? 0,
      subtotal: sourceTotals.subtotal,
      totalBeforeLoyalty: sourceTotals.total
    });
    const loyaltyActive =
      !skipReason &&
      Boolean(loyaltyCustomer?.uid && loyaltyCustomer.profileSynced) &&
      data.loyaltyConfig.enabled;
    const redemption = skipReason
      ? {
          redeemedPoints: 0,
          discountAmount: 0,
          pointValue: preview.redemption?.pointValue ?? data.loyaltyConfig.pointValue
        }
      : preview.redemption;

    return {
      ...orderFlags,
      normalDiscount: sourceTotals.discount,
      totalBeforeLoyalty: sourceTotals.total,
      loyaltyDiscount: skipReason ? 0 : preview.loyaltyDiscount,
      loyaltyRedemption: redemption,
      redeemedPoints: skipReason ? 0 : preview.redeemedPoints,
      earnedPoints: skipReason ? 0 : preview.earnedPoints,
      loyaltySyncStatus: loyaltyActive ? "pending" : "skipped",
      loyaltyError: skipReason,
      loyaltySkipReason: skipReason,
      loyaltyIdempotencyKey: receiptNo,
      payableTotal: skipReason ? sourceTotals.total : preview.payableTotal
    };
  };

  const syncReceiptWithBackend = async (receipt: Receipt) => {
    try {
      const firestoreId = await syncReceiptToEdenOrders(receipt);
      const basePatch: Partial<Receipt> = {
        firestoreId,
        syncStatus: "synced",
        syncError: ""
      };

      if (!receiptCanApplyLoyalty(receipt)) {
        const skipReason =
          receipt.loyaltySkipReason || loyaltySkipReasonFor(receipt);
        const patch: Partial<Receipt> = {
          ...basePatch,
          loyaltySyncStatus: skipReason
            ? "skipped"
            : receipt.loyaltySyncStatus || "skipped",
          loyaltyError: receipt.loyaltyError || skipReason || "",
          loyaltySkipReason: skipReason
        };
        updateReceiptSyncState(receipt.id, patch);
        return { ...receipt, ...patch };
      }

      updateReceiptSyncState(receipt.id, {
        ...basePatch,
        loyaltySyncStatus: "syncing",
        loyaltyError: ""
      });

      try {
        const loyalty = await applyPosLoyaltySale(
          { ...receipt, firestoreId },
          firestoreId
        );
        const patch: Partial<Receipt> = {
          ...basePatch,
          loyalty,
          earnedPoints: loyalty.earnedPoints,
          redeemedPoints: loyalty.redeemedPoints,
          loyaltyDiscount: loyalty.loyaltyDiscount,
          loyaltySyncStatus: "synced",
          loyaltyError: "",
          loyaltyIdempotencyKey: loyalty.idempotencyKey || receipt.number,
          loyaltySyncedAt: loyalty.syncedAt || new Date().toISOString()
        };
        updateReceiptSyncState(receipt.id, patch);
        if (receipt.customerUid) {
          updateCustomerLoyaltyCache(
            receipt.customerUid,
            loyalty.pointsAfter,
            loyalty.tier
          );
        }
        return { ...receipt, ...patch };
      } catch (error) {
        const patch: Partial<Receipt> = {
          ...basePatch,
          loyaltySyncStatus: "failed",
          loyaltyError:
            error instanceof Error ? error.message : "loyalty sync failed"
        };
        updateReceiptSyncState(receipt.id, patch);
        return { ...receipt, ...patch };
      }
    } catch (error) {
      const patch: Partial<Receipt> = {
        syncStatus: "local",
        syncError: error instanceof Error ? error.message : "sync failed",
        loyaltySyncStatus: receiptCanApplyLoyalty(receipt) ? "local" : "skipped",
        loyaltyError:
          receipt.loyaltyError || loyaltySkipReasonFor(receipt) || "",
        loyaltySkipReason:
          receipt.loyaltySkipReason || loyaltySkipReasonFor(receipt)
      };
      updateReceiptSyncState(receipt.id, patch);
      throw error;
    }
  };

  const syncReceipt = (receipt: Receipt) => {
    void syncReceiptWithBackend(receipt);
  };

  const syncReceiptHistory = async () => {
    setHistorySyncState({
      status: "syncing",
      message: "กำลังซิงค์ประวัติรายการ..."
    });

    const uploadCandidates = data.receipts.filter((receipt) =>
      ["local", "failed"].includes(receipt.syncStatus)
    );
    const errors: string[] = [];
    let uploaded = 0;
    let workingReceipts = data.receipts;

    try {
      for (const receipt of uploadCandidates) {
        const retryReceipt: Receipt = {
          ...receipt,
          syncStatus: "syncing",
          syncError: ""
        };
        updateReceiptSyncState(receipt.id, retryReceipt);

        try {
          const syncedReceipt = await syncReceiptWithBackend(retryReceipt);
          uploaded += 1;
          workingReceipts = workingReceipts.map((item) =>
            item.id === receipt.id ? { ...item, ...syncedReceipt } : item
          );
        } catch (error) {
          errors.push(
            `${receipt.number}: ${
              error instanceof Error ? error.message : "ส่งขึ้นหลังบ้านไม่สำเร็จ"
            }`
          );
        }
      }

      const remoteHistory = await loadEdenPosOrderHistory();
      const mergePreview = mergeReceiptHistory(
        workingReceipts,
        remoteHistory.receipts
      );

      setData((current) => ({
        ...current,
        receipts: mergeReceiptHistory(
          current.receipts,
          remoteHistory.receipts
        ).receipts
      }));

      const allErrors = [
        ...errors,
        ...remoteHistory.errors,
        ...mergePreview.conflicts.map(
          (conflict) => `${conflict.number}: ${conflict.reason}`
        )
      ];
      const message = [
        `ส่ง ${formatNumber(uploaded)}`,
        `ดึงใหม่ ${formatNumber(mergePreview.imported)}`,
        `อัปเดต ${formatNumber(mergePreview.updated)}`,
        `ข้าม ${formatNumber(mergePreview.skipped)}`
      ].join(" · ");

      setHistorySyncState({
        status: allErrors.length ? "failed" : "synced",
        message: allErrors.length
          ? `${message} · มีปัญหา ${formatNumber(allErrors.length)} รายการ`
          : message,
        lastSyncedAt: new Date().toISOString(),
        uploaded,
        imported: mergePreview.imported,
        updated: mergePreview.updated,
        skipped: mergePreview.skipped,
        conflicts: mergePreview.conflicts.length,
        scanned: remoteHistory.scanned,
        errors: allErrors.slice(0, 8)
      });
    } catch (error) {
      setHistorySyncState({
        status: "failed",
        message:
          error instanceof Error
            ? `ซิงค์ประวัติไม่สำเร็จ: ${error.message}`
            : "ซิงค์ประวัติไม่สำเร็จ",
        errors: errors.slice(0, 8)
      });
    }
  };

  const retryLoyaltySync = (receiptId: string): Receipt | null => {
    const receipt = data.receipts.find((item) => item.id === receiptId);
    if (!receipt || !receiptCanApplyLoyalty(receipt)) {
      return null;
    }

    const retryReceipt: Receipt = {
      ...receipt,
      syncStatus: "syncing",
      syncError: "",
      loyaltySyncStatus: "pending",
      loyaltyError: ""
    };

    updateReceiptSyncState(receipt.id, retryReceipt);
    syncReceipt(retryReceipt);
    return retryReceipt;
  };

  const adjustReceiptPayment = (
    receiptId: string,
    nextPaymentMethod: PaymentMethod,
    reason: string
  ): Receipt | null => {
    const currentReceipt = data.receipts.find((receipt) => receipt.id === receiptId);
    const cleanReason = reason.trim();

    if (
      !currentReceipt ||
      currentReceipt.paymentStatus !== "paid" ||
      currentReceipt.paymentMethod === nextPaymentMethod ||
      !cleanReason
    ) {
      return null;
    }

    const user = edenAuth.currentUser;
    const nextPaymentLabel = paymentMethodLabel(nextPaymentMethod);
    const now = new Date().toISOString();
    const adjustment: PaymentAdjustment = {
      id: makeId("payment-adjustment"),
      adjustedAt: now,
      adjustedByUid: user?.uid || "",
      adjustedByName: edenUserLabel(user) || "POS",
      adjustedByEmail: user?.email || "",
      previousPaymentMethod: currentReceipt.paymentMethod,
      previousPaymentLabel:
        currentReceipt.paymentLabel || paymentMethodLabel(currentReceipt.paymentMethod),
      nextPaymentMethod,
      nextPaymentLabel,
      amount: currentReceipt.total,
      reason: cleanReason
    };
    const nextPaidAmount =
      nextPaymentMethod === "cash"
        ? currentReceipt.paidAmount || currentReceipt.total
        : currentReceipt.total;
    const nextChangeAmount =
      nextPaymentMethod === "cash" ? currentReceipt.changeAmount || 0 : 0;
    const updatedReceipt: Receipt = {
      ...currentReceipt,
      paymentMethod: nextPaymentMethod,
      paymentLabel: nextPaymentLabel,
      paid: nextPaidAmount,
      paidAmount: nextPaidAmount,
      change: nextChangeAmount,
      changeAmount: nextChangeAmount,
      paymentAdjustments: [
        ...(currentReceipt.paymentAdjustments ?? []),
        adjustment
      ],
      paymentAdjustedAt: now,
      paymentAdjustedBy: adjustment.adjustedByName,
      syncStatus: "syncing",
      syncError: ""
    };

    setData((current) => ({
      ...current,
      receipts: current.receipts.map((receipt) =>
        receipt.id === receiptId ? updatedReceipt : receipt
      )
    }));
    syncReceipt(updatedReceipt);

    return updatedReceipt;
  };

  const refundReceiptItems = async (
    receiptId: string,
    request: ReceiptRefundRequest
  ): Promise<Receipt | null> => {
    const currentReceipt = data.receipts.find((receipt) => receipt.id === receiptId);
    const cleanReason = request.reason.trim();
    const managerEmail = request.managerEmail.trim();

    if (!currentReceipt || currentReceipt.paymentStatus !== "paid") {
      return null;
    }

    if (!cleanReason || !managerEmail || !request.managerPassword) {
      throw new Error("กรอกเหตุผลและบัญชีผู้อนุมัติให้ครบก่อนคืนเงิน");
    }

    const refundLineDrafts = buildRefundLines(
      currentReceipt,
      request.lines,
      data.store.taxRate
    );
    const refundAmount = refundLinesTotal(refundLineDrafts);

    if (refundAmount <= 0) {
      throw new Error("เลือกรายการและจำนวนที่ต้องการคืนเงินก่อน");
    }

    const managerAccess = await authorizeEdenRefundManager(
      managerEmail,
      request.managerPassword
    );
    if (!managerAccess) {
      throw new Error("ไม่พบบัญชีผู้อนุมัติคืนเงิน");
    }
    const cashier = edenAuth.currentUser;
    const now = new Date();
    const createdAt = now.toISOString();
    const refundLines = refundLineDrafts.map((line) => ({
      ...line,
      id: makeId("refund-line")
    }));
    const refund: RefundAdjustment = {
      id: makeId("refund"),
      refundNo: createRefundNumber(now),
      createdAt,
      businessDate: businessDate(now),
      reasonCode: request.reasonCode,
      reason: cleanReason,
      note: request.note?.trim() || "",
      status: "completed",
      paymentMethod: currentReceipt.paymentMethod,
      paymentLabel:
        currentReceipt.paymentLabel || paymentMethodLabel(currentReceipt.paymentMethod),
      subtotal: refundLines.reduce((sum, line) => sum + line.grossAmount, 0),
      discount: refundLinesDiscount(refundLines),
      taxIncluded: refundLinesTax(refundLines),
      amount: refundAmount,
      lines: refundLines,
      cashierUid: cashier?.uid || "",
      cashierName: edenUserLabel(cashier) || "Eden POS",
      cashierEmail: cashier?.email || "",
      approvedByUid: managerAccess.uid,
      approvedByName: managerAccess.displayName || managerAccess.email,
      approvedByEmail: managerAccess.email,
      approvedByRole: managerAccess.role
    };
    const refundAdjustments = [
      ...(currentReceipt.refundAdjustments ?? []),
      refund
    ];
    const updatedReceipt: Receipt = {
      ...currentReceipt,
      refundAdjustments,
      refundStatus: receiptRefundStatus({
        ...currentReceipt,
        refundAdjustments
      }),
      refundedAmount: receiptTotalRefunded({
        ...currentReceipt,
        refundAdjustments
      }),
      refundedAt: createdAt,
      refundedBy: refund.approvedByName,
      syncStatus: "syncing",
      syncError: ""
    };

    setData((current) => ({
      ...current,
      receipts: current.receipts.map((receipt) =>
        receipt.id === receiptId ? updatedReceipt : receipt
      ),
      products: applyRefundStockReturns(current.products, refundLines)
    }));

    // TODO: Add an idempotent loyalty reversal function before changing points on refunds.
    syncReceipt(updatedReceipt);
    void autoPrintPosReceipt(updatedReceipt).catch((error) => {
      console.warn("Unable to auto print refunded POS receipt", error);
    });

    return updatedReceipt;
  };

  const shouldPreserveReceiptCustomer = (
    details: BillDetails,
    sourceReceipt?: Receipt | null
  ) => {
    if (details.customer || !receiptHasCustomerIdentity(sourceReceipt)) {
      return false;
    }

    const detailName = details.customerName?.trim();
    const receiptName = sourceReceipt?.customerName?.trim();

    return (
      isWalkInCustomerName(detailName) ||
      Boolean(detailName && receiptName && detailName === receiptName)
    );
  };

  const buildCustomerFields = (
    details: BillDetails,
    sourceReceipt?: Receipt | null
  ) => {
    const customer = details.customer;
    const preserveReceiptCustomer = shouldPreserveReceiptCustomer(
      details,
      sourceReceipt
    );

    return {
      customerName:
        customer?.displayName ||
        (preserveReceiptCustomer ? sourceReceipt?.customerName : "") ||
        details.customerName ||
        "Walk-in Customer",
      phone:
        customer?.phone ||
        details.phone ||
        (preserveReceiptCustomer ? sourceReceipt?.phone : "") ||
        "",
      tableId: details.tableId?.trim() || "",
      tableNumber: details.tableNumber?.trim() || "",
      tableName: details.tableName?.trim() || "",
      tableZone: details.tableZone?.trim() || "",
      customerUid:
        (customer?.profileSynced ? customer.uid : "") ||
        (preserveReceiptCustomer ? sourceReceipt?.customerUid : "") ||
        "",
      customerEmail:
        customer?.email ||
        (preserveReceiptCustomer ? sourceReceipt?.customerEmail : "") ||
        "",
      customerLineId:
        customer?.lineId ||
        (preserveReceiptCustomer ? sourceReceipt?.customerLineId : "") ||
        "",
      customerTier:
        customer?.tier ||
        (preserveReceiptCustomer ? sourceReceipt?.customerTier : "") ||
        "",
      customerMemberCode:
        customer?.memberCode ||
        (preserveReceiptCustomer ? sourceReceipt?.customerMemberCode : "") ||
        "",
      customerProfileSynced:
        customer?.profileSynced ||
        (preserveReceiptCustomer
          ? Boolean(sourceReceipt?.customerProfileSynced)
          : false),
      note: details.note || ""
    };
  };

  const loadBillToCart = (receiptId: string): Receipt | null => {
    const receipt = data.receipts.find((item) => item.id === receiptId);

    if (!receipt || receipt.billStatus === "cancelled") {
      return null;
    }

    setCart(receipt.items.map((item) => ({ ...item })));
    setDiscount(Math.max(0, receipt.discount - receiptLineDiscount(receipt)));
    setActiveBillId(receipt.billStatus === "open" ? receipt.id : null);
    return receipt;
  };

  const saveOpenBill = (details: BillDetails = {}): Receipt | null => {
    if (cart.length === 0) {
      return null;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const existingBill = activeBillId
      ? data.receipts.find((receipt) => receipt.id === activeBillId)
      : undefined;
    const createdAt = existingBill?.createdAt ?? nowIso;
    const openedAt = existingBill?.openedAt ?? existingBill?.createdAt ?? nowIso;
    const customerFields = buildCustomerFields(details, existingBill);
    const orderFlags = resolveOrderModeFlags(details, existingBill);
    const skipReason = loyaltySkipReasonFor(orderFlags);
    const receipt: Receipt = {
      id: existingBill?.id ?? makeId("receipt"),
      number:
        existingBill?.number ?? createReceiptNumber(data.store.receiptPrefix, now),
      firestoreId: existingBill?.firestoreId,
      createdAt,
      openedAt,
      paidAt: "",
      businessDate: existingBill?.businessDate ?? businessDate(new Date(openedAt)),
      items: cart.map((item) => ({ ...item })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      normalDiscount: totals.discount,
      loyaltyDiscount: 0,
      totalBeforeLoyalty: totals.total,
      tax: totals.taxIncluded,
      taxIncluded: totals.taxIncluded,
      total: totals.total,
      totalAmount: totals.total,
      paid: 0,
      paidAmount: 0,
      change: 0,
      changeAmount: 0,
      paymentMethod: "cash",
      paymentLabel: "ค้างชำระ",
      ...customerFields,
      tableId: customerFields.tableId || existingBill?.tableId || "",
      tableNumber: customerFields.tableNumber || existingBill?.tableNumber || "",
      tableName: customerFields.tableName || existingBill?.tableName || "",
      tableZone: customerFields.tableZone || existingBill?.tableZone || "",
      source: "pos",
      orderType: "pos",
      status: "pending",
      paymentStatus: "pending",
      billStatus: "open",
      isOpenBill: true,
      orderMode: "open_bill",
      syncStatus: "syncing",
      syncError: "",
      ...orderFlags,
      earnedPoints: 0,
      redeemedPoints: 0,
      loyaltySyncStatus: "skipped",
      loyaltyError: skipReason,
      loyaltySkipReason: skipReason,
      loyaltyIdempotencyKey: existingBill?.number ?? "",
      orderTicketPrintedItems: existingBill?.orderTicketPrintedItems ?? [],
      orderTicketPrintedAt: existingBill?.orderTicketPrintedAt || ""
    };

    setData((current) => ({
      ...current,
      receipts: existingBill
        ? current.receipts.map((item) =>
            item.id === existingBill.id ? receipt : item
          )
        : [receipt, ...current.receipts]
    }));
    clearCart();
    syncReceipt(receipt);
    void autoPrintAndTrackOrderTickets(receipt).catch((error) => {
      console.warn("Unable to auto print POS order tickets", error);
    });

    return receipt;
  };

  const completeSale = (
    paymentMethod: PaymentMethod,
    paid: number,
    details: BillDetails = {}
  ): Receipt | null => {
    if (cart.length === 0) {
      return null;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const existingBill = activeBillId
      ? data.receipts.find((receipt) => receipt.id === activeBillId)
      : undefined;
    const receiptNo =
      existingBill?.number ?? createReceiptNumber(data.store.receiptPrefix, now);
    const loyaltyFields = buildLoyaltyReceiptFields(
      receiptNo,
      cart,
      totals,
      details,
      existingBill
    );
    const payableTotal = loyaltyFields.payableTotal;

    if (paid < payableTotal) {
      return null;
    }

    const paidAmount = paymentMethod === "cash" ? paid : payableTotal;
    const customerFields = buildCustomerFields(details, existingBill);
    const isExistingOpenBill = Boolean(existingBill);
    const createdAt = existingBill?.createdAt ?? nowIso;
    const openedAt = existingBill?.openedAt ?? existingBill?.createdAt ?? nowIso;
    const receipt: Receipt = {
      id: existingBill?.id ?? makeId("receipt"),
      number: receiptNo,
      firestoreId: existingBill?.firestoreId,
      createdAt,
      openedAt,
      paidAt: nowIso,
      closedAt: nowIso,
      businessDate: businessDate(now),
      items: cart.map((item) => ({ ...item })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      normalDiscount: totals.discount,
      loyaltyDiscount: loyaltyFields.loyaltyDiscount ?? 0,
      totalBeforeLoyalty: totals.total,
      tax: totals.taxIncluded,
      taxIncluded: totals.taxIncluded,
      total: payableTotal,
      totalAmount: payableTotal,
      paid: paidAmount,
      paidAmount,
      change: paymentMethod === "cash" ? Math.max(0, paidAmount - payableTotal) : 0,
      changeAmount:
        paymentMethod === "cash" ? Math.max(0, paidAmount - payableTotal) : 0,
      paymentMethod,
      paymentLabel: paymentMethodLabel(paymentMethod),
      ...customerFields,
      tableId: customerFields.tableId || existingBill?.tableId || "",
      tableNumber: customerFields.tableNumber || existingBill?.tableNumber || "",
      tableName: customerFields.tableName || existingBill?.tableName || "",
      tableZone: customerFields.tableZone || existingBill?.tableZone || "",
      source: "pos",
      orderType: "pos",
      status: "completed",
      paymentStatus: "paid",
      billStatus: "paid",
      isOpenBill: false,
      orderMode: isExistingOpenBill ? "open_bill" : "pay_now",
      syncStatus: "syncing",
      syncError: "",
      isTestOrder: loyaltyFields.isTestOrder,
      softLaunch: loyaltyFields.softLaunch,
      loyaltyRedemption: loyaltyFields.loyaltyRedemption,
      earnedPoints: loyaltyFields.earnedPoints,
      redeemedPoints: loyaltyFields.redeemedPoints,
      loyaltySyncStatus: loyaltyFields.loyaltySyncStatus,
      loyaltyError: loyaltyFields.loyaltyError,
      loyaltySkipReason: loyaltyFields.loyaltySkipReason,
      loyaltyIdempotencyKey: loyaltyFields.loyaltyIdempotencyKey,
      orderTicketPrintedItems: existingBill?.orderTicketPrintedItems ?? [],
      orderTicketPrintedAt: existingBill?.orderTicketPrintedAt || ""
    };

    setData((current) => ({
      ...current,
      receipts: existingBill
        ? current.receipts.map((item) =>
            item.id === existingBill.id ? receipt : item
          )
        : [receipt, ...current.receipts],
      products: current.products.map((product) => {
        if (!product.trackStock) {
          return product;
        }

        const soldLines = cart.filter(
          (line) =>
            line.productId === product.id ||
            line.sourceProductId === product.id ||
            line.productId.split("::")[0] === product.id
        );

        if (!soldLines.length) {
          return product;
        }

        if (product.variants?.length) {
          const variants = product.variants.map((variant) => {
            const soldQuantity = soldLines
              .filter((line) => line.variantId === variant.id)
              .reduce((sum, line) => sum + line.quantity, 0);

            return soldQuantity
              ? { ...variant, stock: Math.max(0, variant.stock - soldQuantity) }
              : variant;
          });

          return {
            ...product,
            variants,
            stock: variants.reduce(
              (sum, variant) => sum + Math.max(variant.stock, 0),
              0
            )
          };
        }

        const soldQuantity = soldLines.reduce(
          (sum, line) => sum + line.quantity,
          0
        );
        return { ...product, stock: Math.max(0, product.stock - soldQuantity) };
      })
    }));
    clearCart();

    syncReceipt(receipt);
    void (async () => {
      if (!isExistingOpenBill) {
        try {
          await autoPrintAndTrackOrderTickets(receipt);
        } catch (error) {
          console.warn("Unable to auto print POS order tickets", error);
        }
      }

      try {
        await printPaidReceiptAfterPayment(receipt);
      } catch (error) {
        console.warn("Unable to print paid POS receipt", error);
      }
    })();

    return receipt;
  };

  const cancelOpenBill = (receiptId: string): Receipt | null => {
    const receipt = data.receipts.find((item) => item.id === receiptId);
    if (!receipt || !isOpenBill(receipt)) {
      return null;
    }

    const now = new Date().toISOString();
    const cancelledReceipt: Receipt = {
      ...receipt,
      status: "cancelled",
      paymentStatus: "pending",
      billStatus: "cancelled",
      isOpenBill: false,
      syncStatus: "syncing",
      syncError: "",
      cancelledAt: now,
      cancelledBy: edenUserLabel(edenAuth.currentUser) || "Eden POS"
    };

    setData((current) => ({
      ...current,
      receipts: current.receipts.map((item) =>
        item.id === receiptId ? cancelledReceipt : item
      )
    }));

    if (activeBillId === receiptId) {
      clearCart();
    }

    syncReceipt(cancelledReceipt);
    return cancelledReceipt;
  };

  const restoreCancelledBill = (receiptId: string): Receipt | null => {
    const receipt = data.receipts.find(
      (item) => item.id === receiptId && item.billStatus === "cancelled"
    );
    if (!receipt) {
      return null;
    }

    const restoredReceipt: Receipt = {
      ...receipt,
      status: "pending",
      paymentStatus: "pending",
      billStatus: "open",
      isOpenBill: true,
      orderMode: "open_bill",
      syncStatus: "syncing",
      syncError: "",
      restoredAt: new Date().toISOString(),
      restoredBy: edenUserLabel(edenAuth.currentUser) || "Eden POS"
    };

    setData((current) => ({
      ...current,
      receipts: current.receipts.map((item) =>
        item.id === receiptId ? restoredReceipt : item
      )
    }));

    syncReceipt(restoredReceipt);
    return restoredReceipt;
  };

  const splitOpenBill = (
    receiptId: string,
    quantities: SplitQuantities,
    paymentMethod: PaymentMethod,
    paid: number,
    details: BillDetails = {}
  ): Receipt | null => {
    const sourceReceipt = data.receipts.find(
      (receipt) => receipt.id === receiptId && isOpenBill(receipt)
    );

    if (!sourceReceipt) {
      return null;
    }

    const scaleLine = (line: CartLine, quantity: number): CartLine => {
      const ratio = line.quantity > 0 ? quantity / line.quantity : 0;

      return {
        ...line,
        quantity,
        lineDiscount: Math.round((line.lineDiscount ?? 0) * ratio)
      };
    };
    const selectedLines = sourceReceipt.items
      .map((line) => {
        const quantity = Math.min(
          Math.max(Math.floor(quantities[line.productId] ?? 0), 0),
          line.quantity
        );

        return quantity > 0 ? scaleLine(line, quantity) : null;
      })
      .filter((line): line is CartLine => Boolean(line));

    if (!selectedLines.length) {
      return null;
    }

    const remainingLines = sourceReceipt.items
      .map((line) => {
        const selectedQuantity = Math.min(
          Math.max(Math.floor(quantities[line.productId] ?? 0), 0),
          line.quantity
        );
        const remainingQuantity = line.quantity - selectedQuantity;

        return remainingQuantity > 0 ? scaleLine(line, remainingQuantity) : null;
      })
      .filter((line): line is CartLine => Boolean(line));
    const sourceLineDiscount = receiptLineDiscount(sourceReceipt);
    const sourceOrderDiscount = Math.max(
      0,
      sourceReceipt.discount - sourceLineDiscount
    );
    const selectedSubtotal = selectedLines.reduce(
      (sum, line) => sum + line.unitPrice * line.quantity,
      0
    );
    const sourceSubtotal = Math.max(sourceReceipt.subtotal, 0);
    const selectedOrderDiscount =
      sourceSubtotal > 0
        ? Math.round(sourceOrderDiscount * (selectedSubtotal / sourceSubtotal))
        : 0;
    const selectedTotals = calculateTotals(
      selectedLines,
      data.store,
      selectedOrderDiscount
    );
    const now = new Date();
    const nowIso = now.toISOString();
    const openedAt = sourceReceipt.openedAt ?? sourceReceipt.createdAt ?? nowIso;
    const splitReceiptNo = createReceiptNumber(data.store.receiptPrefix, now);
    const loyaltyFields = buildLoyaltyReceiptFields(
      splitReceiptNo,
      selectedLines,
      selectedTotals,
      details,
      sourceReceipt
    );
    const payableTotal = loyaltyFields.payableTotal;

    if (selectedTotals.total <= 0 || paid < payableTotal) {
      return null;
    }

    const remainingOrderDiscount =
      sourceSubtotal > 0
        ? Math.max(
            0,
            sourceOrderDiscount -
              Math.round(sourceOrderDiscount * (selectedSubtotal / sourceSubtotal))
          )
        : 0;
    const remainingTotals = calculateTotals(
      remainingLines,
      data.store,
      remainingOrderDiscount
    );
    const paidAmount = paymentMethod === "cash" ? paid : payableTotal;
    const customerFields = buildCustomerFields({
      customerName: sourceReceipt.customerName,
      phone: sourceReceipt.phone,
      note: details.note || sourceReceipt.note,
      ...details
    }, sourceReceipt);
    const splitReceipt: Receipt = {
      id: makeId("receipt"),
      number: splitReceiptNo,
      parentReceiptId: sourceReceipt.id,
      splitFromReceiptNumber: sourceReceipt.number,
      createdAt: nowIso,
      openedAt,
      paidAt: nowIso,
      closedAt: nowIso,
      businessDate: businessDate(now),
      items: selectedLines.map((item) => ({ ...item })),
      subtotal: selectedTotals.subtotal,
      discount: selectedTotals.discount,
      normalDiscount: selectedTotals.discount,
      loyaltyDiscount: loyaltyFields.loyaltyDiscount ?? 0,
      totalBeforeLoyalty: selectedTotals.total,
      tax: selectedTotals.taxIncluded,
      taxIncluded: selectedTotals.taxIncluded,
      total: payableTotal,
      totalAmount: payableTotal,
      paid: paidAmount,
      paidAmount,
      change:
        paymentMethod === "cash"
          ? Math.max(0, paidAmount - payableTotal)
          : 0,
      changeAmount:
        paymentMethod === "cash"
          ? Math.max(0, paidAmount - payableTotal)
          : 0,
      paymentMethod,
      paymentLabel: paymentMethodLabel(paymentMethod),
      ...customerFields,
      tableId: sourceReceipt.tableId || "",
      tableNumber: sourceReceipt.tableNumber || "",
      tableName: sourceReceipt.tableName || "",
      tableZone: sourceReceipt.tableZone || "",
      source: "pos",
      orderType: "pos",
      status: "completed",
      paymentStatus: "paid",
      billStatus: "paid",
      isOpenBill: false,
      orderMode: "open_bill",
      syncStatus: "syncing",
      syncError: "",
      isTestOrder: loyaltyFields.isTestOrder,
      softLaunch: loyaltyFields.softLaunch,
      loyaltyRedemption: loyaltyFields.loyaltyRedemption,
      earnedPoints: loyaltyFields.earnedPoints,
      redeemedPoints: loyaltyFields.redeemedPoints,
      loyaltySyncStatus: loyaltyFields.loyaltySyncStatus,
      loyaltyError: loyaltyFields.loyaltyError,
      loyaltySkipReason: loyaltyFields.loyaltySkipReason,
      loyaltyIdempotencyKey: loyaltyFields.loyaltyIdempotencyKey
    };
    const sourceSkipReason =
      sourceReceipt.loyaltySkipReason || loyaltySkipReasonFor(sourceReceipt);
    const updatedSource: Receipt = remainingLines.length
      ? {
          ...sourceReceipt,
          openedAt,
          paidAt: "",
          closedAt: "",
          businessDate:
            sourceReceipt.businessDate || businessDate(new Date(openedAt)),
          items: remainingLines.map((item) => ({ ...item })),
          subtotal: remainingTotals.subtotal,
          discount: remainingTotals.discount,
          normalDiscount: remainingTotals.discount,
          loyaltyDiscount: 0,
          totalBeforeLoyalty: remainingTotals.total,
          tax: remainingTotals.taxIncluded,
          taxIncluded: remainingTotals.taxIncluded,
          total: remainingTotals.total,
          totalAmount: remainingTotals.total,
          paid: 0,
          paidAmount: 0,
          change: 0,
          changeAmount: 0,
          paymentStatus: "pending",
          billStatus: "open",
          isOpenBill: true,
          syncStatus: "syncing",
          syncError: "",
          earnedPoints: 0,
          redeemedPoints: 0,
          loyaltySyncStatus: "skipped",
          loyaltyError: sourceReceipt.loyaltyError || sourceSkipReason || "",
          loyaltySkipReason: sourceSkipReason
        }
      : {
          ...sourceReceipt,
          openedAt,
          paidAt: "",
          closedAt: "",
          items: [],
          subtotal: 0,
          discount: 0,
          normalDiscount: 0,
          loyaltyDiscount: 0,
          totalBeforeLoyalty: 0,
          tax: 0,
          taxIncluded: 0,
          total: 0,
          totalAmount: 0,
          paymentStatus: "pending",
          billStatus: "cancelled",
          isOpenBill: false,
          status: "cancelled",
          syncStatus: "syncing",
          syncError: "",
          earnedPoints: 0,
          redeemedPoints: 0,
          loyaltySyncStatus: "skipped",
          loyaltyError: sourceReceipt.loyaltyError || sourceSkipReason || "",
          loyaltySkipReason: sourceSkipReason
        };

    setData((current) => ({
      ...current,
      receipts: [
        splitReceipt,
        ...current.receipts.map((receipt) =>
          receipt.id === sourceReceipt.id ? updatedSource : receipt
        )
      ],
      products: current.products.map((product) => {
        if (!product.trackStock) {
          return product;
        }

        const soldLines = selectedLines.filter(
          (line) =>
            line.productId === product.id ||
            line.sourceProductId === product.id ||
            line.productId.split("::")[0] === product.id
        );

        if (!soldLines.length) {
          return product;
        }

        if (product.variants?.length) {
          const variants = product.variants.map((variant) => {
            const soldQuantity = soldLines
              .filter((line) => line.variantId === variant.id)
              .reduce((sum, line) => sum + line.quantity, 0);

            return soldQuantity
              ? { ...variant, stock: Math.max(0, variant.stock - soldQuantity) }
              : variant;
          });

          return {
            ...product,
            variants,
            stock: variants.reduce(
              (sum, variant) => sum + Math.max(variant.stock, 0),
              0
            )
          };
        }

        const soldQuantity = soldLines.reduce(
          (sum, line) => sum + line.quantity,
          0
        );
        return { ...product, stock: Math.max(0, product.stock - soldQuantity) };
      })
    }));

    if (activeBillId === sourceReceipt.id) {
      if (remainingLines.length) {
        setCart(remainingLines.map((item) => ({ ...item })));
        setDiscount(remainingOrderDiscount);
      } else {
        clearCart();
      }
    }
    syncReceipt(splitReceipt);
    syncReceipt(updatedSource);
    void printPaidReceiptAfterPayment(splitReceipt).catch((error) => {
      console.warn("Unable to print paid split POS receipt", error);
    });

    return splitReceipt;
  };

  const createBlankProduct = (): ProductDraft => ({
    id: makeId("product"),
    sku: "",
    name: "",
    category: "ทั่วไป",
    categoryId: "general",
    cost: 0,
    price: 0,
    stock: 0,
    color: "#2f6f73",
    imageUrl: ""
  });

  return {
    activeCategory,
    activeBill: activeBillId
      ? data.receipts.find((receipt) => receipt.id === activeBillId) ?? null
      : null,
    addToCart,
    archiveProduct,
    adjustReceiptPayment,
    cart,
    catalogLoading,
    categories,
    categoryColors,
    clearCart,
    completeSale,
    cancelOpenBill,
    createBlankProduct,
    data,
    discount,
    filteredProducts,
    historySyncState,
    loadBillToCart,
    openBills,
    productCategoryOptions,
    query,
    refundReceiptItems,
    refreshCustomerLoyalty,
    retryLoyaltySync,
    restoreCancelledBill,
    saveLocalCustomer,
    saveOpenBill,
    saveProduct,
    saveSecuritySettings,
    saveStore,
    reorderCategories,
    setActiveCategory,
    setDiscount,
    setQuantity,
    setQuery,
    syncCustomerFromPhone,
    syncEdenCatalog,
    syncReceiptHistory,
    syncState,
    splitOpenBill,
    totals,
    updateSafety,
    verifySecurityPin
  };
};
