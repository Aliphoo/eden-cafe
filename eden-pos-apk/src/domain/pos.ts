export type PaymentMethod =
  | "cash"
  | "transfer"
  | "thai_chuay_thai_plus"
  | "qr"
  | "card"
  | "other";
export type DiscountType = "percent" | "amount";

export type PaymentAdjustment = {
  id: string;
  adjustedAt: string;
  adjustedByUid?: string;
  adjustedByName: string;
  adjustedByEmail?: string;
  previousPaymentMethod: PaymentMethod;
  previousPaymentLabel: string;
  nextPaymentMethod: PaymentMethod;
  nextPaymentLabel: string;
  amount: number;
  reason: string;
};

export type RefundReasonCode =
  | "missing_item"
  | "incomplete_order"
  | "overcharged"
  | "out_of_stock_after_payment"
  | "customer_return"
  | "other";

export type RefundStockAction = "no_stock_return" | "return_to_stock";

export type RefundLine = {
  id: string;
  lineKey: string;
  productId: string;
  sourceProductId?: string;
  variantId?: string;
  variantName?: string;
  sku: string;
  name: string;
  category: string;
  quantity: number;
  unitPrice: number;
  cost: number;
  grossAmount: number;
  lineDiscount: number;
  orderDiscountShare: number;
  discount: number;
  taxIncluded: number;
  netAmount: number;
  note?: string;
  stockAction: RefundStockAction;
};

export type RefundAdjustment = {
  id: string;
  refundNo: string;
  createdAt: string;
  businessDate: string;
  reasonCode: RefundReasonCode;
  reason: string;
  note?: string;
  status: "completed";
  paymentMethod: PaymentMethod;
  paymentLabel: string;
  subtotal: number;
  discount: number;
  taxIncluded: number;
  amount: number;
  lines: RefundLine[];
  cashierUid?: string;
  cashierName: string;
  cashierEmail?: string;
  approvedByUid: string;
  approvedByName: string;
  approvedByEmail: string;
  approvedByRole: string;
};

export type RefundRequestLine = {
  lineKey: string;
  quantity: number;
  stockAction: RefundStockAction;
};

export type ReceiptRefundRequest = {
  lines: RefundRequestLine[];
  reasonCode: RefundReasonCode;
  reason: string;
  note?: string;
  managerEmail: string;
  managerPassword: string;
};

export type PosDiscountOption = {
  id: string;
  label: string;
  type: DiscountType;
  value: number;
  active: boolean;
  order: number;
};

export type ProductVariant = {
  id: string;
  name: string;
  sku: string;
  price: number;
  cost: number;
  stock: number;
  lowStock?: number;
  availableForSale: boolean;
};

export type Product = {
  id: string;
  sourceProductId?: string;
  variantId?: string;
  variantName?: string;
  sku: string;
  name: string;
  category: string;
  categoryId?: string;
  price: number;
  cost?: number;
  stock: number;
  color: string;
  imageUrl: string;
  taxEnabled: boolean;
  trackStock: boolean;
  variants?: ProductVariant[];
  active: boolean;
};

export type CartLine = {
  productId: string;
  sourceProductId?: string;
  variantId?: string;
  variantName?: string;
  sku: string;
  name: string;
  category: string;
  unitPrice: number;
  cost: number;
  note?: string;
  lineDiscount?: number;
  lineDiscountRate?: number;
  lineDiscountLabel?: string;
  lineDiscountType?: DiscountType;
  lineDiscountValue?: number;
  taxEnabled: boolean;
  quantity: number;
};

export type OrderTicketPrintedItem = {
  key: string;
  quantity: number;
  name: string;
  variantName?: string;
  category: string;
  note?: string;
  updatedAt: string;
};

export type ProductSaleSelection = {
  product: Product;
  variant?: ProductVariant;
  quantity: number;
  note?: string;
  discountRate?: number;
  discountLabel?: string;
  discountType?: DiscountType;
  discountValue?: number;
};

export type CustomerProfile = {
  uid: string;
  displayName: string;
  email?: string;
  phone: string;
  phoneNormalized: string;
  lineId?: string;
  tier: string;
  memberCode: string;
  points?: number;
  totalSpent?: number;
  visitCount?: number;
  profileSynced: boolean;
  source: "eden" | "local";
  updatedAt: string;
};

export type LoyaltyConfig = {
  enabled: boolean;
  spendPerPoint: number;
  pointValue: number;
  expiryMonths: number;
  maxRedeemPercent: number;
  minRedeemPoints: number;
  earnAfterDiscount: boolean;
  earnOnRedeemedAmount: boolean;
  excludedCategories: string[];
  tierMultipliers: Record<string, number>;
  updatedAt?: string;
};

export type LoyaltySummary = {
  customerUid: string;
  pointsBalance: number;
  tier?: string;
  lifetimePoints?: number;
  totalRedeemed?: number;
  totalSpent?: number;
  visitCount?: number;
  updatedAt?: string;
};

export type LoyaltyRedemption = {
  redeemedPoints: number;
  discountAmount: number;
  pointValue: number;
};

export type LoyaltyResult = {
  customerUid?: string;
  earnedPoints: number;
  redeemedPoints: number;
  loyaltyDiscount: number;
  pointsBefore?: number;
  pointsAfter?: number;
  tier?: string;
  eligibleAmount?: number;
  earnBase?: number;
  idempotencyKey?: string;
  ledgerIds?: {
    earn?: string;
    redeem?: string;
  };
  syncedAt?: string;
  error?: string;
};

export type LoyaltySkipReason = "test-order" | "soft-launch";

export type Receipt = {
  id: string;
  number: string;
  parentReceiptId?: string;
  splitFromReceiptNumber?: string;
  firestoreId?: string;
  createdAt: string;
  openedAt?: string;
  paidAt?: string;
  closedAt?: string;
  businessDate: string;
  items: CartLine[];
  subtotal: number;
  discount: number;
  normalDiscount?: number;
  loyaltyDiscount?: number;
  totalBeforeLoyalty?: number;
  tax: number;
  taxIncluded: number;
  total: number;
  totalAmount: number;
  paid: number;
  paidAmount: number;
  change: number;
  changeAmount: number;
  paymentMethod: PaymentMethod;
  paymentLabel: string;
  customerName: string;
  phone: string;
  tableId?: string;
  tableNumber?: string;
  tableName?: string;
  tableZone?: string;
  customerUid?: string;
  customerEmail?: string;
  customerLineId?: string;
  customerTier?: string;
  customerMemberCode?: string;
  customerProfileSynced?: boolean;
  note: string;
  source: "pos";
  orderType: "pos";
  status: "pending" | "processing" | "completed" | "cancelled";
  paymentStatus: "pending" | "paid" | "failed" | "refunded";
  billStatus: "open" | "paid" | "cancelled";
  isOpenBill: boolean;
  orderMode: "pay_now" | "open_bill";
  syncStatus: "local" | "syncing" | "synced" | "failed";
  syncError?: string;
  isTestOrder?: boolean;
  softLaunch?: boolean;
  loyalty?: LoyaltyResult;
  loyaltyRedemption?: LoyaltyRedemption;
  earnedPoints?: number;
  redeemedPoints?: number;
  loyaltySyncStatus?:
    | "skipped"
    | "pending"
    | "syncing"
    | "synced"
    | "failed"
    | "local";
  loyaltyError?: string;
  loyaltySkipReason?: LoyaltySkipReason | "";
  loyaltyIdempotencyKey?: string;
  loyaltySyncedAt?: string;
  paymentAdjustments?: PaymentAdjustment[];
  paymentAdjustedAt?: string;
  paymentAdjustedBy?: string;
  refundAdjustments?: RefundAdjustment[];
  refundStatus?: "none" | "partial" | "full";
  refundedAmount?: number;
  refundedAt?: string;
  refundedBy?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  restoredAt?: string;
  restoredBy?: string;
  orderTicketPrintedItems?: OrderTicketPrintedItem[];
  orderTicketPrintedAt?: string;
};

export type PosTable = {
  id: string;
  code: string;
  name: string;
  zone: string;
  seats: number;
  status: "available" | "booked" | "unavailable";
  order: number;
};

export type PromptPayAccount = {
  id: string;
  label: string;
  promptPayId: string;
  merchantName: string;
  city: string;
  order: number;
};

export type StoreProfile = {
  name: string;
  taxRate: number;
  receiptPrefix: string;
  printLogoDataUrl: string;
  printLogoFileName: string;
  printLogoUpdatedAt?: string;
  receiptHeaderBusinessName?: string;
  receiptHeaderBranch?: string;
  receiptHeaderAddress?: string;
  receiptTaxId?: string;
  receiptPhone?: string;
  receiptWebsite?: string;
  receiptTitle?: string;
  receiptFooterNote?: string;
  receiptFooterTaxNote?: string;
  promptPayId: string;
  merchantName: string;
  city: string;
  promptPayAccountId?: string;
  promptPayAccounts?: PromptPayAccount[];
  promptPayEnabled?: boolean;
  promptPayLocked?: boolean;
  softLaunch?: boolean;
  firebaseProjectId: string;
};

export type SecuritySettings = {
  enabled: boolean;
  lockTimeoutMinutes: number;
  pinHash: string;
  pinSalt: string;
  updatedAt?: string;
};

export type PosData = {
  categoryOrder: string[];
  customers: CustomerProfile[];
  discounts: PosDiscountOption[];
  loyaltyConfig: LoyaltyConfig;
  products: Product[];
  receipts: Receipt[];
  security: SecuritySettings;
  store: StoreProfile;
  tables: PosTable[];
};
