import { Capacitor } from "@capacitor/core";
import { initializeApp, getApps } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  browserSessionPersistence,
  getAuth,
  getRedirectResult,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  initializeAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithRedirect,
  signOut,
  type User,
  type UserCredential
} from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Firestore,
  type DocumentData,
  type QuerySnapshot,
  type Unsubscribe
} from "firebase/firestore";
import type {
  CustomerProfile,
  LoyaltyConfig,
  LoyaltyResult,
  LoyaltySummary,
  PosDiscountOption,
  PosTable,
  Product,
  ProductVariant,
  PromptPayAccount,
  Receipt
} from "../domain/pos";
import {
  normalizeLoyaltyConfig,
  normalizeLoyaltySummary
} from "../domain/loyalty";
import {
  receiptNetDiscount,
  receiptNetTaxIncluded,
  receiptNetTotal,
  receiptRefundStatus,
  receiptTotalRefunded
} from "../domain/receiptAdjustments";

const EDEN_BASE_URL = "https://www.edencafe.co/";
const FUNCTIONS_BASE_URL =
  "https://asia-southeast1-edencafe-d9095.cloudfunctions.net";
const ADMIN_IMAGE_MAX_FILE_SIZE = 8 * 1024 * 1024;
const ADMIN_IMAGE_MAX_EDGE = 1800;
const EDEN_ADMIN_EMAILS = [
  "admin@edencafe.com",
  "phoo1236@gmail.com",
  "sonsawan.1231@gmail.com"
];

const firebaseConfig = {
  apiKey: "AIzaSyAbNysIXcBwGKZe6nHJUivqyZxS2PwnCfg",
  authDomain: "edencafe-d9095.firebaseapp.com",
  projectId: "edencafe-d9095",
  storageBucket: "edencafe-d9095.firebasestorage.app",
  messagingSenderId: "962163014966",
  appId: "1:962163014966:web:f22614bfa594c7fd1cc797",
  measurementId: "G-QXGQVWB8LH"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

const createEdenAuth = () => {
  if (!Capacitor.isNativePlatform()) {
    return getAuth(app);
  }

  try {
    return initializeAuth(app, {
      persistence: indexedDBLocalPersistence
    });
  } catch (_error) {
    return getAuth(app);
  }
};

export const edenAuth = createEdenAuth();
export const edenDb = getFirestore(app);

const getRefundManagerApp = () =>
  getApps().find((item) => item.name === "eden-refund-manager") ??
  initializeApp(firebaseConfig, "eden-refund-manager");

const getRefundManagerAuth = () => {
  const refundApp = getRefundManagerApp();

  try {
    return initializeAuth(refundApp, {
      persistence: inMemoryPersistence
    });
  } catch (_error) {
    return getAuth(refundApp);
  }
};

export const isEdenNativeApp = () => Capacitor.isNativePlatform();

const edenAuthPersistence = Capacitor.isNativePlatform()
  ? Promise.resolve()
  : setPersistence(edenAuth, browserLocalPersistence)
      .catch(() => setPersistence(edenAuth, browserSessionPersistence))
      .catch(() => setPersistence(edenAuth, inMemoryPersistence));

export const normalizePhone = (value: string) =>
  String(value ?? "")
    .replace(/[^\d+]/g, "")
    .replace(/^\+66/, "0")
    .replace(/[^\d]/g, "");

const normalizeEmail = (value: unknown) =>
  String(value ?? "").trim().toLowerCase();

type EdenCategory = {
  id: string;
  name?: string;
  nameTh?: string;
  nameEn?: string;
  color?: string;
  order?: number;
};

type EdenTableSource = Record<string, unknown> & {
  id: string;
  code?: string;
  name?: string;
  zone?: string;
  tableZone?: string;
  seats?: number;
  capacity?: number;
  status?: string;
  kind?: string;
  mapEnabled?: boolean;
  order?: number;
};

export type EdenCategoryOption = {
  id: string;
  name: string;
  color?: string;
  order?: number;
};

export type PosProductSyncDraft = Pick<
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
  | "taxEnabled"
  | "trackStock"
> & {
  categoryId?: string;
};

type EdenProductSource = Record<string, unknown> & {
  id: string;
  name?: string;
  nameTh?: string;
  nameEn?: string;
  category?: string;
  price?: number;
  cost?: number;
  sku?: string;
  stock?: number;
  imageUrl?: string;
  image?: string;
  availableForSale?: boolean | string;
  showOnPos?: boolean | string;
  taxEnabled?: boolean | string;
  trackStock?: boolean | string;
  variants?: Array<Record<string, unknown>>;
};

export type EdenPromptPaySettings = {
  enabled: boolean;
  activeAccountId: string;
  accounts: PromptPayAccount[];
  promptPayId: string;
  merchantName: string;
  city: string;
};

const EDEN_PROMPTPAY_DEFAULT_ACCOUNT: PromptPayAccount = {
  id: "eden-main",
  label: "Eden Cafe Main",
  promptPayId: "057556001655",
  merchantName: "EDEN CAFE",
  city: "CHIANG RAI",
  order: 1
};

const cleanPromptPayId = (value: unknown) =>
  String(value ?? "").replace(/\D/g, "");

const isValidPromptPayId = (value: unknown) => {
  const id = cleanPromptPayId(value);
  return /^0\d{9}$/.test(id) || /^\d{13}$/.test(id) || /^\d{15}$/.test(id);
};

const promptPayAccountId = (
  account: Record<string, unknown>,
  index: number,
  usedIds: Set<string>
) => {
  const rawId = String(account.id || account.key || "").trim();
  const seed = rawId || (
    String(account.label || account.promptPayId || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || `promptpay-${index + 1}`
  );
  let candidate = seed;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `${seed}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
};

const normalizeEdenPromptPayAccount = (
  value: Record<string, unknown> = {},
  index = 0,
  usedIds = new Set<string>()
): PromptPayAccount => {
  const promptPayId = cleanPromptPayId(
    value.promptPayId ||
      value.idValue ||
      value.number ||
      value.promptpay ||
      EDEN_PROMPTPAY_DEFAULT_ACCOUNT.promptPayId
  );

  return {
    id: promptPayAccountId(value, index, usedIds),
    label:
      String(value.label || value.name || value.accountName || `PromptPay ${index + 1}`)
        .trim()
        .slice(0, 80) || `PromptPay ${index + 1}`,
    promptPayId: isValidPromptPayId(promptPayId)
      ? promptPayId
      : EDEN_PROMPTPAY_DEFAULT_ACCOUNT.promptPayId,
    merchantName:
      String(value.merchantName || EDEN_PROMPTPAY_DEFAULT_ACCOUNT.merchantName)
        .trim()
        .slice(0, 25) || EDEN_PROMPTPAY_DEFAULT_ACCOUNT.merchantName,
    city:
      String(value.city || EDEN_PROMPTPAY_DEFAULT_ACCOUNT.city)
        .trim()
        .slice(0, 15) || EDEN_PROMPTPAY_DEFAULT_ACCOUNT.city,
    order: Number.isFinite(Number(value.order)) ? Number(value.order) : index + 1
  };
};

const normalizeEdenPromptPaySettings = (
  data: Record<string, unknown> = {}
): EdenPromptPaySettings => {
  const legacyAccount = {
    id: data.accountId || data.activeAccountId || EDEN_PROMPTPAY_DEFAULT_ACCOUNT.id,
    label: data.label || data.accountName || EDEN_PROMPTPAY_DEFAULT_ACCOUNT.label,
    promptPayId: data.promptPayId,
    merchantName: data.merchantName,
    city: data.city,
    order: 1
  };
  const rawAccounts =
    Array.isArray(data.accounts) && data.accounts.length
      ? data.accounts
      : [legacyAccount];
  const usedIds = new Set<string>();
  const accounts = rawAccounts
    .map((account, index) =>
      normalizeEdenPromptPayAccount(
        (account || {}) as Record<string, unknown>,
        index,
        usedIds
      )
    )
    .sort((a, b) => a.order - b.order)
    .map((account, index) => ({ ...account, order: index + 1 }));
  const accountList = accounts.length
    ? accounts
    : [normalizeEdenPromptPayAccount(EDEN_PROMPTPAY_DEFAULT_ACCOUNT)];
  let activeAccountId = String(
    data.activeAccountId || data.selectedAccountId || data.accountId || ""
  ).trim();

  if (!accountList.some((account) => account.id === activeAccountId)) {
    activeAccountId = accountList[0].id;
  }

  const activeAccount =
    accountList.find((account) => account.id === activeAccountId) ||
    accountList[0];

  return {
    enabled: data.enabled !== false,
    activeAccountId,
    accounts: accountList,
    promptPayId: activeAccount.promptPayId,
    merchantName: activeAccount.merchantName,
    city: activeAccount.city
  };
};

const parseBool = (value: unknown, fallback = false) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const text = String(value).trim().toLowerCase();
  return ["true", "1", "yes", "y", "available", "sale", "on", "เปิด", "ขาย", "ใช่"].includes(text);
};

const toNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const limitText = (value: unknown, maxLength: number) =>
  String(value ?? "").trim().slice(0, maxLength);

const assetUrl = (value: unknown) => {
  const url = String(value ?? "").trim();

  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("Images/") || url.startsWith("Hero/")) {
    return new URL(url, EDEN_BASE_URL).toString();
  }

  return new URL("Images/Logo.webp", EDEN_BASE_URL).toString();
};

const colorForCategory = (categoryId: string, category?: EdenCategory) =>
  category?.color ||
  (
    {
      coffee: "#5f4735",
      tea: "#6f8f4e",
      drink: "#2f8d36",
      food: "#b9873c",
      bakery: "#8f623c",
      snack: "#c65f2f",
      general: "#4f8cc9"
    } as Record<string, string>
  )[categoryId] ||
  "#43a947";

const categoryName = (categoryId: string, category?: EdenCategory) =>
  category?.name || category?.nameTh || category?.nameEn || categoryId || "เมนู";

const categoryOptionFromData = (
  id: string,
  category: Partial<EdenCategory> = {}
): EdenCategoryOption => ({
  id,
  name: categoryName(id, { id, ...category }),
  color: category.color,
  order: category.order
});

const slugifyId = (value: string, fallback = "item") => {
  const ascii = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (ascii) return ascii.slice(0, 80);
  const thaiSafe = String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\u0e00-\u0e7fa-zA-Z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
  return thaiSafe ? thaiSafe.slice(0, 80) : fallback;
};

const dataUrlToImage = (dataUrl: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("โหลดรูปภาพไม่สำเร็จ"));
    image.src = dataUrl;
  });

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("อ่านไฟล์รูปภาพไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(new Error("แปลงรูปภาพเป็น base64 ไม่สำเร็จ"));
    reader.readAsDataURL(blob);
  });

export const compressImageToWebP = async (file: File, quality = 0.82) => {
  if (!file || !/^image\//i.test(file.type || "")) {
    throw new Error("กรุณาเลือกไฟล์รูปภาพเท่านั้น");
  }
  if (file.size > ADMIN_IMAGE_MAX_FILE_SIZE) {
    throw new Error("รูปภาพใหญ่เกินไป กรุณาใช้ไฟล์ไม่เกิน 8MB");
  }

  const image = await dataUrlToImage(await readFileAsDataUrl(file));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("อุปกรณ์นี้ไม่สามารถแปลงรูปภาพได้");
  }

  const scale = Math.min(
    1,
    ADMIN_IMAGE_MAX_EDGE / Math.max(image.width, image.height)
  );
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("แปลงรูปภาพเป็น .webp ไม่สำเร็จ"));
          return;
        }
        resolve(blob);
      },
      "image/webp",
      quality
    );
  });
};

export const uploadEdenProductImage = async (
  file: File,
  options: { categoryId: string; productId: string }
) => {
  const user = edenAuth.currentUser;
  if (!user) {
    throw new Error("ต้องล็อกอินแอดมินก่อนอัปโหลดรูปสินค้า");
  }

  const webpBlob = await compressImageToWebP(file);
  const token = await user.getIdToken(true);
  const safeCategoryId = slugifyId(options.categoryId, "general");
  const safeProductId = slugifyId(options.productId, "product");
  const response = await fetch(`${FUNCTIONS_BASE_URL}/uploadSpaceshipImage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      folder: `products/${safeCategoryId}`,
      fileName: `${safeProductId}-${Date.now()}.webp`,
      mimeType: "image/webp",
      imageBase64: await blobToBase64(webpBlob)
    })
  });
  const result = (await response.json().catch(() => ({}))) as {
    url?: string;
    error?: string;
  };

  if (!response.ok || !result.url) {
    throw new Error(result.error || "อัปโหลดรูปภาพไป Spaceship ไม่สำเร็จ");
  }

  return result.url;
};

const variantId = (variant: Record<string, unknown>, index: number) =>
  String(variant.id ?? variant.sku ?? variant.name ?? index).trim() ||
  String(index);

const normalizeEdenProduct = (
  product: EdenProductSource,
  categories: Record<string, EdenCategory>
): Product[] => {
  const categoryId = String(product.category || "general");
  const category = categories[categoryId];
  const name = String(product.name || product.nameTh || product.nameEn || product.id);
  const price = toNumber(product.price);
  const cost = toNumber(product.cost);
  const stock = toNumber(product.stock, 99);
  const trackStock = parseBool(product.trackStock, false);
  const taxEnabled = parseBool(product.taxEnabled, true);
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const productActive =
    parseBool(product.availableForSale, true) && parseBool(product.showOnPos, true);
  const base = {
    sourceProductId: product.id,
    sku: String(product.sku || ""),
    name,
    category: categoryName(categoryId, category),
    categoryId,
    color: colorForCategory(categoryId, category),
    imageUrl: assetUrl(product.imageUrl || product.image),
    active: productActive,
    taxEnabled,
    trackStock
  };

  if (!variants.length) {
    return [
      {
        ...base,
        id: product.id,
        price,
        cost,
        stock: trackStock ? stock : Math.max(stock, 99)
      }
    ];
  }

  const normalizedVariants: ProductVariant[] = variants
    .filter((variant) => parseBool(variant.availableForSale, true))
    .map((variant, index) => {
      const id = variantId(variant, index);
      const variantName = String(variant.name || "").trim();
      const variantPrice = toNumber(variant.price, price);
      const variantStock = toNumber(variant.stock, stock);

      return {
        id,
        name: variantName || "ปกติ",
        sku: String(variant.sku || product.sku || ""),
        price: variantPrice,
        cost: toNumber(variant.cost, cost),
        stock: trackStock ? variantStock : Math.max(variantStock, 99),
        lowStock: toNumber(variant.lowStock),
        availableForSale: parseBool(variant.availableForSale, true)
      };
    });

  if (!normalizedVariants.length) {
    return [
      {
        ...base,
        id: product.id,
        price,
        cost,
        stock: trackStock ? stock : Math.max(stock, 99)
      }
    ];
  }

  const firstVariant = normalizedVariants[0];
  const variantStock = normalizedVariants.reduce(
    (sum, variant) => sum + Math.max(variant.stock, 0),
    0
  );

  return [
    {
      ...base,
      active: productActive && normalizedVariants.length > 0,
      id: product.id,
      price: firstVariant?.price ?? price,
      cost: firstVariant?.cost ?? cost,
      stock: trackStock ? variantStock : Math.max(stock, variantStock, 99),
      variants: normalizedVariants
    }
  ];
};

const normalizeEdenDiscount = (
  id: string,
  data: Record<string, unknown>
): PosDiscountOption | null => {
  const label = String(data.label ?? "").trim();
  const type = data.type === "amount" ? "amount" : "percent";
  const rawValue = Number(data.value ?? 0);

  if (!label || !Number.isFinite(rawValue) || rawValue <= 0) return null;

  return {
    id,
    label,
    type,
    value: type === "percent" ? Math.min(rawValue, 100) : Math.min(rawValue, 100000),
    active: data.active !== false,
    order: Number.isFinite(Number(data.order)) ? Number(data.order) : 999
  };
};

const discountsFromSnapshot = (discountSnap: QuerySnapshot<DocumentData>) =>
  discountSnap.docs
    .map((discountDoc) =>
      normalizeEdenDiscount(discountDoc.id, discountDoc.data() as Record<string, unknown>)
    )
    .filter((discount): discount is PosDiscountOption => Boolean(discount))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, "th"));

const normalizeEdenTable = (input: EdenTableSource): PosTable | null => {
  if (input.kind && input.kind !== "table") return null;
  if (input.mapEnabled === false) return null;

  const id = String(input.id || input.code || "").trim();
  if (!id) return null;

  const code = String(input.code || id.toUpperCase()).trim();
  const name = String(input.name || code).trim();
  const zone = String(input.zone || input.tableZone || "Indoor").trim();
  const status = ["available", "booked", "unavailable"].includes(
    String(input.status)
  )
    ? (String(input.status) as PosTable["status"])
    : "available";

  return {
    id,
    code,
    name,
    zone,
    seats: Math.max(1, Number(input.seats || input.capacity) || 4),
    status,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 999
  };
};

const tablesFromSnapshot = (tableSnap: QuerySnapshot<DocumentData>) =>
  tableSnap.docs
    .map((tableDoc) =>
      normalizeEdenTable({
        id: tableDoc.id,
        ...(tableDoc.data() as Record<string, unknown>)
      })
    )
    .filter((table): table is PosTable => Boolean(table))
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.zone.localeCompare(b.zone, "th") ||
        a.code.localeCompare(b.code, "th")
    );

const categoriesFromSnapshot = (categorySnap: QuerySnapshot<DocumentData>) =>
  Object.fromEntries(
    categorySnap.docs.map((categoryDoc) => [
      categoryDoc.id,
      { id: categoryDoc.id, ...(categoryDoc.data() as Omit<EdenCategory, "id">) }
    ])
  );

const productsFromSnapshot = (
  productSnap: QuerySnapshot<DocumentData>,
  categories: Record<string, EdenCategory>
) =>
  productSnap.docs
    .flatMap((productDoc) =>
      normalizeEdenProduct(
        { id: productDoc.id, ...(productDoc.data() as Record<string, unknown>) },
        categories
      )
    )
    .filter((product) => product.active)
    .sort((a, b) => a.name.localeCompare(b.name, "th"));

export const loadEdenLoyaltyConfig = async (): Promise<LoyaltyConfig> => {
  try {
    const snap = await getDoc(doc(edenDb, "site_settings", "loyalty"));
    return normalizeLoyaltyConfig(
      snap.exists() ? (snap.data() as Partial<LoyaltyConfig>) : undefined
    );
  } catch (error) {
    console.warn("Unable to load Eden loyalty config, using local defaults", error);
    return normalizeLoyaltyConfig();
  }
};

export const loadEdenCatalog = async () => {
  const [categorySnap, productSnap, promptPaySnap, discountSnap, tableSnap] = await Promise.all([
    getDocs(query(collection(edenDb, "categories"))),
    getDocs(query(collection(edenDb, "products"))),
    getDoc(doc(edenDb, "site_settings", "promptpay")),
    getDocs(query(collection(edenDb, "pos_discounts"))),
    getDocs(query(collection(edenDb, "tables")))
  ]);

  const categories = categoriesFromSnapshot(categorySnap);
  const products = productsFromSnapshot(productSnap, categories);

  const promptPay = normalizeEdenPromptPaySettings(
    promptPaySnap.exists()
      ? (promptPaySnap.data() as Record<string, unknown>)
      : {}
  );
  const discounts = discountsFromSnapshot(discountSnap);
  const tables = tablesFromSnapshot(tableSnap);

  return { products, categories, promptPay, discounts, tables };
};

export const subscribeEdenMenu = (
  onChange: (catalog: {
    products: Product[];
    categories: Record<string, EdenCategory>;
  }) => void,
  onError?: (error: Error) => void
): Unsubscribe => {
  let latestCategorySnap: QuerySnapshot<DocumentData> | null = null;
  let latestProductSnap: QuerySnapshot<DocumentData> | null = null;

  const emitIfReady = () => {
    if (!latestCategorySnap || !latestProductSnap) return;
    const categories = categoriesFromSnapshot(latestCategorySnap);
    onChange({
      categories,
      products: productsFromSnapshot(latestProductSnap, categories)
    });
  };

  const stopCategories = onSnapshot(
    query(collection(edenDb, "categories")),
    (categorySnap) => {
      latestCategorySnap = categorySnap;
      emitIfReady();
    },
    (error) => {
      onError?.(error);
    }
  );
  const stopProducts = onSnapshot(
    query(collection(edenDb, "products")),
    (productSnap) => {
      latestProductSnap = productSnap;
      emitIfReady();
    },
    (error) => {
      onError?.(error);
    }
  );

  return () => {
    stopCategories();
    stopProducts();
  };
};

export const subscribeEdenDiscounts = (
  onChange: (discounts: PosDiscountOption[]) => void,
  onError?: (error: Error) => void
): Unsubscribe =>
  onSnapshot(
    query(collection(edenDb, "pos_discounts")),
    (discountSnap) => {
      onChange(discountsFromSnapshot(discountSnap));
    },
    (error) => {
      onError?.(error);
    }
  );

export const subscribeEdenTables = (
  onChange: (tables: PosTable[]) => void,
  onError?: (error: Error) => void
): Unsubscribe =>
  onSnapshot(
    query(collection(edenDb, "tables")),
    (tableSnap) => {
      onChange(tablesFromSnapshot(tableSnap));
    },
    (error) => {
      onError?.(error);
    }
  );

export const loadEdenCategoryOptions = async () => {
  const categorySnap = await getDocs(query(collection(edenDb, "categories")));
  return categorySnap.docs
    .map((categoryDoc) =>
      categoryOptionFromData(categoryDoc.id, categoryDoc.data() as EdenCategory)
    )
    .sort((a, b) => {
      const orderA = a.order ?? 999;
      const orderB = b.order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name, "th");
    });
};

export const ensureEdenCategory = async (input: {
  id?: string;
  name: string;
  color?: string;
}) => {
  const name = limitText(input.name, 120);
  if (!name) {
    throw new Error("กรุณาระบุหมวดหมู่สินค้า");
  }

  const id = slugifyId(input.id || name, "general");
  const categoryRef = doc(edenDb, "categories", id);
  const snap = await getDoc(categoryRef);
  const payload = {
    name,
    nameTh: name,
    color: input.color || "#43a947",
    updatedAt: new Date().toISOString()
  };

  await setDoc(
    categoryRef,
    snap.exists()
      ? payload
      : {
          ...payload,
          order: Date.now(),
          createdAt: new Date().toISOString()
        },
    { merge: true }
  );

  return categoryOptionFromData(id, {
    ...(snap.exists() ? (snap.data() as EdenCategory) : {}),
    ...payload
  });
};

export const syncPosProductToEden = async (
  product: PosProductSyncDraft,
  options: { imageFile?: File | null } = {}
) => {
  const user = edenAuth.currentUser;
  if (!user) {
    throw new Error("ต้องล็อกอินแอดมินก่อนบันทึกสินค้าไปหลังบ้าน");
  }

  await requireEdenPosAccess(user);
  const category = await ensureEdenCategory({
    id: product.categoryId,
    name: product.category,
    color: product.color
  });
  const productId = slugifyId(product.id || product.sku || product.name, "product");
  const imageUrl = options.imageFile
    ? await uploadEdenProductImage(options.imageFile, {
        categoryId: category.id,
        productId
      })
    : product.imageUrl.trim();

  if (!imageUrl) {
    throw new Error("กรุณาอัปโหลดรูปภาพ หรือใส่ URL รูปสินค้า");
  }

  const payload = {
    handle: productId,
    sku: product.sku,
    name: product.name,
    nameTh: product.name,
    description: "",
    price: Math.max(0, product.price),
    cost: Math.max(0, product.cost ?? 0),
    stock: Math.max(0, product.stock),
    imageUrl,
    category: category.id,
    trackStock: product.trackStock ?? false,
    availableForSale: true,
    showOnWebsite: true,
    showOnPos: true,
    showInShop: false,
    taxName: "eden cafe",
    taxRate: 7,
    taxEnabled: product.taxEnabled !== false,
    color: product.color || category.color || "#43a947",
    shape: "rounded",
    source: "pos-apk",
    updatedAt: new Date().toISOString(),
    updatedBy: user.uid
  };

  const productRef = doc(edenDb, "products", productId);
  const existingProductSnap = await getDoc(productRef);

  await setDoc(
    productRef,
    {
      ...payload,
      ...(existingProductSnap.exists() ? {} : { createdAt: new Date().toISOString() })
    },
    { merge: true }
  );

  return {
    id: productId,
    category,
    imageUrl
  };
};

export const edenUserLabel = (user: User | null) =>
  user ? user.displayName || user.email || user.uid : "";

export type EdenAdminAccess = {
  canUsePos: boolean;
  displayName: string;
  email: string;
  permissions: Record<string, boolean>;
  role: string;
  source: "bootstrap" | "firestore";
  status: string;
  uid: string;
};

const adminRoleDefaults = (role: string) => {
  const allPermissions = {
    bookings: true,
    blogs: true,
    dashboard: true,
    discounts: true,
    faqs: true,
    footer: true,
    members: true,
    orders: true,
    pos: true,
    products: true,
    promptpay: true,
    rooms: true,
    shop: true,
    tables: true
  };

  if (role === "owner" || role === "head_manager") return allPermissions;
  return {
    dashboard: true,
    members: false,
    pos: false,
    discounts: false,
    orders: true,
    bookings: true,
    tables: false,
    rooms: false,
    products: false,
    shop: false,
    blogs: false,
    faqs: false,
    promptpay: false,
    footer: false
  };
};

const adminAccessCanUsePos = (access: Pick<EdenAdminAccess, "permissions" | "role" | "status"> | null) => {
  if (!access || access.status !== "active") return false;
  if (access.role === "owner" || access.role === "head_manager") return true;
  return access.permissions?.pos === true;
};

const adminAccessCanApproveRefund = (
  access: Pick<EdenAdminAccess, "role" | "status"> | null
) => Boolean(access && access.status === "active" && (
  access.role === "owner" || access.role === "head_manager"
));

export const loadEdenAdminAccess = async (
  user: User | null = edenAuth.currentUser,
  db: Firestore = edenDb
): Promise<EdenAdminAccess | null> => {
  if (!user) return null;

  const email = normalizeEmail(user.email);
  if (EDEN_ADMIN_EMAILS.includes(email)) {
    const permissions = adminRoleDefaults("owner");
    return {
      canUsePos: true,
      displayName: user.displayName || email || "Owner",
      email,
      permissions,
      role: "owner",
      source: "bootstrap",
      status: "active",
      uid: user.uid
    };
  }

  const adminSnap = await getDoc(doc(db, "admin_users", user.uid));
  if (!adminSnap.exists()) return null;

  const data = adminSnap.data() as Record<string, unknown>;
  const role = String(data.role || "manager");
  const permissions = {
    ...adminRoleDefaults(role),
    ...((data.permissions || {}) as Record<string, boolean>)
  };
  const access = {
    canUsePos: false,
    displayName: limitText(data.displayName || user.displayName || user.email, 120),
    email: normalizeEmail(data.email || user.email),
    permissions,
    role,
    source: "firestore" as const,
    status: String(data.status || ""),
    uid: user.uid
  };

  return {
    ...access,
    canUsePos: adminAccessCanUsePos(access)
  };
};

export const requireEdenPosAccess = async (user = edenAuth.currentUser) => {
  const access = await loadEdenAdminAccess(user);
  if (!access?.canUsePos) {
    throw new Error(
      "บัญชีนี้ล็อกอินได้แล้ว แต่ยังไม่มีสิทธิ์ Eden POS APK ใน admin_users หรือไม่ได้อยู่ในรายชื่อแอดมินหลัก"
    );
  }
  return access;
};

export const authorizeEdenRefundManager = async (
  email: string,
  password: string
) => {
  const refundAuth = getRefundManagerAuth();
  await setPersistence(refundAuth, inMemoryPersistence).catch(() => undefined);

  try {
    const credential = await signInWithEmailAndPassword(
      refundAuth,
      normalizeEmail(email),
      password
    );
    const access = await loadEdenAdminAccess(
      credential.user,
      getFirestore(getRefundManagerApp())
    );

    if (!adminAccessCanApproveRefund(access)) {
      throw new Error(
        "บัญชีนี้ไม่มีสิทธิ์อนุมัติคืนเงิน ต้องเป็น Owner หรือ Head Manager เท่านั้น"
      );
    }

    return access;
  } finally {
    await signOut(refundAuth).catch(() => undefined);
  }
};

export const observeEdenAuth = (callback: (user: User | null) => void) =>
  onAuthStateChanged(edenAuth, callback);

export const signInEdenAdmin = async (email: string, password: string) => {
  await edenAuthPersistence;
  const credential = await signInWithEmailAndPassword(edenAuth, email, password);
  await requireEdenPosAccess(credential.user);
  return credential;
};

export const sendEdenAdminPasswordReset = async (email: string) => {
  await edenAuthPersistence;
  return sendPasswordResetEmail(edenAuth, normalizeEmail(email));
};

const isPopupFallbackError = (error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code ?? "")
      : "";

  return [
    "auth/cancelled-popup-request",
    "auth/operation-not-supported-in-this-environment",
    "auth/popup-blocked"
  ].includes(code);
};

let edenRedirectResultPromise: Promise<UserCredential | null> | null = null;

export const resolveEdenAuthRedirect = () => {
  if (Capacitor.isNativePlatform()) {
    return Promise.resolve(null);
  }

  edenRedirectResultPromise ??= edenAuthPersistence
    .then(() => getRedirectResult(edenAuth))
    .then(async (result) => {
      if (result?.user) {
        await requireEdenPosAccess(result.user);
      }
      return result;
    })
    .catch((error) => {
      edenRedirectResultPromise = null;
      throw error;
    });

  return edenRedirectResultPromise;
};

const signInEdenGoogleNative = async () => {
  const { FirebaseAuthentication } = await import(
    "@capacitor-firebase/authentication"
  );
  const result = await FirebaseAuthentication.signInWithGoogle({
    skipNativeAuth: true,
    useCredentialManager: false
  });
  const idToken = result.credential?.idToken;
  const accessToken = result.credential?.accessToken;

  if (!idToken && !accessToken) {
    throw new Error(
      "Google ไม่ส่ง token กลับมา ตรวจสอบ default_web_client_id, SHA-1/SHA-256 ของ Android app และการเปิด Google provider ใน Firebase"
    );
  }

  const credential = GoogleAuthProvider.credential(
    idToken || null,
    accessToken || null
  );
  const userCredential = await signInWithCredential(edenAuth, credential);
  await requireEdenPosAccess(userCredential.user);
  return userCredential;
};

export const signInEdenGoogleAdmin = async () => {
  await edenAuthPersistence;

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  if (Capacitor.isNativePlatform()) {
    try {
      return await signInEdenGoogleNative();
    } catch (error) {
      if (!isPopupFallbackError(error)) {
        throw error;
      }
    }
  }

  await signInWithRedirect(edenAuth, provider);
  return null;
};

export const signOutEdenAdmin = async () => {
  if (Capacitor.isNativePlatform()) {
    try {
      const { FirebaseAuthentication } = await import(
        "@capacitor-firebase/authentication"
      );
      await FirebaseAuthentication.signOut();
    } catch (_error) {
      // The web Firebase session below is the source of truth for Firestore.
    }
  }

  return signOut(edenAuth);
};

const cleanCustomerProfile = (
  uid: string,
  data: Record<string, unknown>,
  source: CustomerProfile["source"] = "eden"
): CustomerProfile => {
  const displayName = limitText(
    data.displayName ||
      data.name ||
      data.customerName ||
      data.email ||
      "Eden Member",
    120
  );
  const phone = limitText(data.phone || data.mobile || data.tel || "", 40);

  return {
    uid,
    displayName,
    email: limitText(data.email, 180),
    phone,
    phoneNormalized: normalizePhone(String(data.phoneNormalized || phone)),
    lineId: limitText(data.lineId, 80),
    tier: limitText(data.tier || "Silver", 30),
    memberCode: limitText(data.memberCode || uid.slice(0, 12), 40),
    points: toNumber(data.points),
    totalSpent: toNumber(data.totalSpent),
    visitCount: toNumber(data.visitCount),
    profileSynced: source === "eden",
    source,
    updatedAt: new Date().toISOString()
  };
};

const estimateLegacyPoints = (
  data: Record<string, unknown>,
  loyaltyConfig: LoyaltyConfig,
  fallbackPoints = 0
) => {
  const storedPoints = Math.max(0, Math.floor(toNumber(data.points, fallbackPoints)));
  if (storedPoints > 0) return storedPoints;

  const fallback = Math.max(0, Math.floor(fallbackPoints));
  if (!loyaltyConfig.enabled || loyaltyConfig.spendPerPoint <= 0) {
    return fallback;
  }

  const totalSpentPoints = Math.floor(
    Math.max(0, toNumber(data.totalSpent)) / loyaltyConfig.spendPerPoint
  );
  return Math.max(fallback, totalSpentPoints);
};

export const loadEdenLoyaltySummary = async (
  customerUid: string,
  fallbackPoints = 0,
  loyaltyConfig?: LoyaltyConfig
): Promise<LoyaltySummary> => {
  const uid = String(customerUid || "").trim();
  if (!uid) {
    return normalizeLoyaltySummary("", undefined, fallbackPoints);
  }

  const summarySnap = await getDoc(doc(edenDb, "member_summaries", uid));
  if (summarySnap.exists()) {
    return normalizeLoyaltySummary(
      uid,
      summarySnap.data() as Partial<LoyaltySummary>,
      fallbackPoints
    );
  }

  const userSnap = await getDoc(doc(edenDb, "users", uid));
  const userData = userSnap.exists()
    ? (userSnap.data() as Record<string, unknown>)
    : {};
  const config = loyaltyConfig ?? (await loadEdenLoyaltyConfig());
  const estimatedPoints = estimateLegacyPoints(userData, config, fallbackPoints);
  return normalizeLoyaltySummary(
    uid,
    {
      tier: limitText(userData.tier || "Silver", 30),
      totalSpent: toNumber(userData.totalSpent),
      visitCount: toNumber(userData.visitCount)
    },
    estimatedPoints
  );
};

const withLoyaltySummary = async (
  customer: CustomerProfile,
  loyaltyConfig?: LoyaltyConfig
) => {
  try {
    const summary = await loadEdenLoyaltySummary(
      customer.uid,
      customer.points ?? 0,
      loyaltyConfig
    );
    return {
      ...customer,
      points: summary.pointsBalance,
      totalSpent: summary.totalSpent ?? customer.totalSpent,
      visitCount: summary.visitCount ?? customer.visitCount,
      tier: summary.tier || customer.tier
    };
  } catch (_error) {
    return customer;
  }
};

const scoreEdenCustomerCandidate = (
  customer: CustomerProfile,
  rawPhone: string,
  displayName = ""
) => {
  const phone = normalizePhone(rawPhone);
  const name = displayName.trim().toLowerCase();
  const candidateName = customer.displayName.trim().toLowerCase();
  const candidatePhones = [
    customer.phone,
    customer.phoneNormalized
  ].map((value) => normalizePhone(value));
  let score = 0;

  if (candidatePhones.some((value) => value === phone)) score += 500;
  if (candidatePhones.some((value) => value.includes(phone) || phone.includes(value))) {
    score += 200;
  }
  if (name && candidateName === name) score += 250;
  if (name && (candidateName.includes(name) || name.includes(candidateName))) {
    score += 90;
  }
  if ((customer.points ?? 0) > 0) score += 520;
  if ((customer.totalSpent ?? 0) > 0) score += 120;
  if ((customer.visitCount ?? 0) > 0) score += 40;
  if (customer.email) score += 80;
  if (/^ED-/i.test(customer.memberCode)) score += 60;
  if (/^pos-phone-/i.test(customer.uid)) score -= 220;
  if (/^(POS|LOCAL)/i.test(customer.memberCode)) score -= 120;

  return score;
};

export const findEdenCustomerByPhone = async (
  rawPhone: string,
  displayName = ""
) => {
  const phone = normalizePhone(rawPhone);
  if (phone.length < 6) {
    return null;
  }

  const candidates = new Map<string, CustomerProfile>();
  const customerQueries = new Map<string, ReturnType<typeof query>>();
  const addCustomerQuery = (field: string, value: string, queryLimit = 10) => {
    const cleanValue = String(value || "").trim();
    if (!cleanValue) return;
    customerQueries.set(
      `${field}:${cleanValue}`,
      query(collection(edenDb, "users"), where(field, "==", cleanValue), limit(queryLimit))
    );
  };

  ["phone", "mobile", "tel", "phoneNumber"].forEach((field) => {
    addCustomerQuery(field, rawPhone);
    addCustomerQuery(field, phone);
  });
  addCustomerQuery("phoneNormalized", phone);

  const cleanDisplayName = displayName.trim();
  if (cleanDisplayName.length >= 2) {
    ["displayName", "name", "customerName"].forEach((field) =>
      addCustomerQuery(field, cleanDisplayName, 5)
    );
  }

  for (const customerQuery of customerQueries.values()) {
    const snap = await getDocs(customerQuery);
    snap.forEach((customerDoc) => {
      candidates.set(
        customerDoc.id,
        cleanCustomerProfile(customerDoc.id, customerDoc.data() as Record<string, unknown>)
      );
    });
  }

  const loyaltyConfig = await loadEdenLoyaltyConfig();
  const enriched = await Promise.all(
    Array.from(candidates.values()).map((candidate) =>
      withLoyaltySummary(candidate, loyaltyConfig)
    )
  );
  const customer = enriched
    .sort(
      (a, b) =>
        scoreEdenCustomerCandidate(b, rawPhone, displayName) -
        scoreEdenCustomerCandidate(a, rawPhone, displayName)
    )[0] ?? null;

  return customer;
};

export const loadEdenMembers = async (options: {
  search?: string;
  limitCount?: number;
} = {}) => {
  const user = edenAuth.currentUser;
  if (!user) {
    throw new Error("ต้องล็อกอินแอดมิน Eden ก่อนจึงจะดูรายชื่อสมาชิกได้");
  }

  await requireEdenPosAccess(user);

  const memberLimit = Math.min(Math.max(options.limitCount ?? 250, 20), 500);
  const snap = await getDocs(query(collection(edenDb, "users"), limit(memberLimit)));
  const searchText = String(options.search || "").trim().toLowerCase();
  const searchDigits = normalizePhone(searchText);
  const members = snap.docs
    .map((memberDoc) => {
      const data = memberDoc.data() as Record<string, unknown>;
      const status = String(data.status || "active").toLowerCase();

      if (["deleted", "disabled", "blocked"].includes(status)) {
        return null;
      }

      return cleanCustomerProfile(memberDoc.id, data);
    })
    .filter((member): member is CustomerProfile => Boolean(member));

  const filteredMembers = members
    .filter((member) => {
      if (!searchText) return true;

      const haystack = [
        member.displayName,
        member.email,
        member.phone,
        member.phoneNormalized,
        member.lineId,
        member.memberCode,
        member.tier
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        haystack.includes(searchText) ||
        (searchDigits ? member.phoneNormalized.includes(searchDigits) : false)
      );
    })
    .sort((a, b) => {
      const codeA = a.memberCode || "";
      const codeB = b.memberCode || "";
      if (codeA && codeB && codeA !== codeB) {
        return codeA.localeCompare(codeB, "th");
      }
      return a.displayName.localeCompare(b.displayName, "th");
    });

  const loyaltyConfig = await loadEdenLoyaltyConfig();
  return Promise.all(
    filteredMembers.map((member) => withLoyaltySummary(member, loyaltyConfig))
  );
};

export const syncOrRegisterEdenCustomerByPhone = async (input: {
  displayName: string;
  phone: string;
}) => {
  const phone = normalizePhone(input.phone);
  if (phone.length < 6) {
    throw new Error("กรอกเบอร์โทรอย่างน้อย 6 หลักก่อนซิงค์ข้อมูล");
  }

  if (!edenAuth.currentUser) {
    throw new Error(
      "ต้องล็อกอินแอดมินในหน้าตั้งค่าก่อนจึงจะซิงค์ลูกค้าขึ้น Firebase ได้"
    );
  }

  const existing = await findEdenCustomerByPhone(input.phone, input.displayName);
  if (existing) {
    return existing;
  }

  const uid = `pos-phone-${phone}`;
  const displayName = limitText(input.displayName || `ลูกค้า ${phone}`, 120);
  const memberCode = `POS${phone.slice(-6)}`;
  const payload = {
    uid,
    displayName,
    name: displayName,
    email: "",
    phone: input.phone,
    phoneNormalized: phone,
    memberCode,
    tier: "Silver",
    points: 0,
    totalSpent: 0,
    visitCount: 0,
    status: "active",
    source: "pos-phone",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await setDoc(doc(edenDb, "users", uid), payload, { merge: true });
  return withLoyaltySummary(cleanCustomerProfile(uid, payload));
};

export const syncReceiptToEdenOrders = async (receipt: Receipt) => {
  const user = edenAuth.currentUser;
  if (!user) {
    throw new Error("ยังไม่ได้เข้าสู่ระบบแอดมิน Eden Cafe");
  }

  const refundTotal = receiptTotalRefunded(receipt);
  const netTotal = receiptNetTotal(receipt);
  const netDiscount = receiptNetDiscount(receipt);
  const netTaxIncluded = receiptNetTaxIncluded(receipt);
  const refundStatus = receiptRefundStatus(receipt);
  const loyaltyDiscount = receipt.loyaltyDiscount ?? 0;
  const redeemedPoints =
    receipt.redeemedPoints ?? receipt.loyaltyRedemption?.redeemedPoints ?? 0;
  const earnedPoints = receipt.earnedPoints ?? receipt.loyalty?.earnedPoints ?? 0;
  const loyaltyResult = receipt.loyalty;

  const order = {
    id: receipt.number,
    receiptNo: receipt.number,
    date: new Date(receipt.createdAt).toLocaleString("th-TH", {
      dateStyle: "short",
      timeStyle: "short"
    }),
    businessDate: receipt.businessDate,
    businessDateLabel: new Date(receipt.businessDate).toLocaleDateString("th-TH"),
    source: "pos",
    orderType: "pos",
    status: receipt.status,
    paymentStatus: receipt.paymentStatus,
    paymentMethod: receipt.paymentMethod,
    paymentLabel: receipt.paymentLabel,
    paymentAdjustments: (receipt.paymentAdjustments ?? []).map((adjustment) => ({
      id: adjustment.id,
      adjustedAt: adjustment.adjustedAt,
      adjustedByUid: adjustment.adjustedByUid || "",
      adjustedByName: adjustment.adjustedByName,
      adjustedByEmail: adjustment.adjustedByEmail || "",
      previousPaymentMethod: adjustment.previousPaymentMethod,
      previousPaymentLabel: adjustment.previousPaymentLabel,
      nextPaymentMethod: adjustment.nextPaymentMethod,
      nextPaymentLabel: adjustment.nextPaymentLabel,
      amount: adjustment.amount,
      reason: adjustment.reason
    })),
    paymentAdjustedAt: receipt.paymentAdjustedAt || "",
    paymentAdjustedBy: receipt.paymentAdjustedBy || "",
    refundAdjustments: (receipt.refundAdjustments ?? []).map((adjustment) => ({
      id: adjustment.id,
      refundNo: adjustment.refundNo,
      createdAt: adjustment.createdAt,
      businessDate: adjustment.businessDate,
      reasonCode: adjustment.reasonCode,
      reason: adjustment.reason,
      note: adjustment.note || "",
      status: adjustment.status,
      paymentMethod: adjustment.paymentMethod,
      paymentLabel: adjustment.paymentLabel,
      subtotal: adjustment.subtotal,
      discount: adjustment.discount,
      taxIncluded: adjustment.taxIncluded,
      amount: adjustment.amount,
      cashierUid: adjustment.cashierUid || "",
      cashierName: adjustment.cashierName,
      cashierEmail: adjustment.cashierEmail || "",
      approvedByUid: adjustment.approvedByUid,
      approvedByName: adjustment.approvedByName,
      approvedByEmail: adjustment.approvedByEmail,
      approvedByRole: adjustment.approvedByRole,
      lines: adjustment.lines.map((line) => ({
        id: line.id,
        lineKey: line.lineKey,
        productId: line.sourceProductId || line.productId.split("::")[0],
        variantId: line.variantId || "base",
        sku: line.sku,
        name: line.name,
        variantName: line.variantName || "",
        category: line.category,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        cost: line.cost,
        grossAmount: line.grossAmount,
        lineDiscount: line.lineDiscount,
        orderDiscountShare: line.orderDiscountShare,
        discount: line.discount,
        taxIncluded: line.taxIncluded,
        netAmount: line.netAmount,
        note: line.note || "",
        stockAction: line.stockAction
      }))
    })),
    refundStatus,
    refundedAmount: refundTotal,
    refundedAt: receipt.refundedAt || "",
    refundedBy: receipt.refundedBy || "",
    uid: user.uid,
    customerName: receipt.customerName,
    phone: receipt.phone,
    tableId: receipt.tableId || "",
    tableNumber: receipt.tableNumber || "",
    tableName: receipt.tableName || "",
    tableZone: receipt.tableZone || "",
    customerUid: receipt.customerUid || "",
    customerEmail: receipt.customerEmail || "",
    customerLineId: receipt.customerLineId || "",
    customerTier: receipt.customerTier || "",
    customerMemberCode: receipt.customerMemberCode || "",
    customerProfileSynced: receipt.customerProfileSynced || false,
    loyaltySyncStatus: receipt.loyaltySyncStatus || "skipped",
    loyaltyError: receipt.loyaltyError || "",
    loyaltyIdempotencyKey: receipt.loyaltyIdempotencyKey || receipt.number,
    loyaltySyncedAt: receipt.loyaltySyncedAt || "",
    loyaltyDiscount,
    redeemedPoints,
    earnedPoints,
    totalBeforeLoyalty: receipt.totalBeforeLoyalty ?? receipt.total,
    normalDiscount: receipt.normalDiscount ?? receipt.discount,
    loyaltyRedemption: {
      redeemedPoints,
      discountAmount: receipt.loyaltyRedemption?.discountAmount ?? loyaltyDiscount,
      pointValue: receipt.loyaltyRedemption?.pointValue ?? 0
    },
    loyalty: {
      customerUid: loyaltyResult?.customerUid || receipt.customerUid || "",
      earnedPoints,
      redeemedPoints,
      loyaltyDiscount,
      pointsBefore: loyaltyResult?.pointsBefore ?? 0,
      pointsAfter: loyaltyResult?.pointsAfter ?? 0,
      tier: loyaltyResult?.tier || receipt.customerTier || "",
      eligibleAmount: loyaltyResult?.eligibleAmount ?? 0,
      earnBase: loyaltyResult?.earnBase ?? 0,
      idempotencyKey: loyaltyResult?.idempotencyKey || receipt.loyaltyIdempotencyKey || receipt.number,
      earnLedgerId: loyaltyResult?.ledgerIds?.earn || "",
      redeemLedgerId: loyaltyResult?.ledgerIds?.redeem || "",
      syncedAt: loyaltyResult?.syncedAt || receipt.loyaltySyncedAt || ""
    },
    address: "หน้าร้าน Eden Cafe",
    note: receipt.note,
    items: receipt.items.map((item) => ({
      productId: item.sourceProductId || item.productId.split("::")[0],
      variantId: item.variantId || "base",
      name: item.name,
      variantName: item.variantName || "",
      note: item.note || "",
      sku: item.sku,
      category: item.category,
      price: item.unitPrice,
      cost: item.cost,
      quantity: item.quantity,
      lineTotal: item.unitPrice * item.quantity,
      lineDiscount: item.lineDiscount || 0,
      lineDiscountRate: item.lineDiscountRate || 0,
      lineDiscountLabel: item.lineDiscountLabel || "",
      taxEnabled: item.taxEnabled
    })),
    subtotal: receipt.subtotal,
    discount: netDiscount,
    taxIncluded: netTaxIncluded,
    originalDiscount: receipt.discount,
    originalTaxIncluded: receipt.taxIncluded,
    originalTotal: receipt.total,
    originalTotalAmount: receipt.totalAmount,
    refundTotal,
    netTotal,
    total: netTotal,
    totalAmount: netTotal,
    paidAmount: receipt.paidAmount,
    changeAmount: receipt.changeAmount,
    cashierUid: user.uid,
    cashierName: user.displayName || user.email || "Eden POS",
    cashierEmail: user.email || "",
    isTestOrder: false,
    softLaunch: false,
    stockAdjusted: false,
    stockAdjustments: [],
    stockMode: "apk-no-stock",
    billStatus: receipt.billStatus,
    isOpenBill: receipt.isOpenBill,
    orderMode: receipt.orderMode,
    cancelledAt: receipt.cancelledAt || "",
    cancelledBy: receipt.cancelledBy || "",
    restoredAt: receipt.restoredAt || "",
    restoredBy: receipt.restoredBy || "",
    timestamp: serverTimestamp(),
    ...(receipt.firestoreId ? {} : { createdAt: serverTimestamp() }),
    closedAt: serverTimestamp(),
    closedBy: user.uid,
    closedByName: user.displayName || user.email || "Eden POS",
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
  };

  if (receipt.firestoreId) {
    await setDoc(doc(edenDb, "orders", receipt.firestoreId), order, { merge: true });
    return receipt.firestoreId;
  }

  const docRef = await addDoc(collection(edenDb, "orders"), order);
  return docRef.id;
};

export const applyPosLoyaltySale = async (
  receipt: Receipt,
  orderId = receipt.firestoreId
): Promise<LoyaltyResult> => {
  const user = edenAuth.currentUser;
  if (!user) {
    throw new Error("ยังไม่ได้เข้าสู่ระบบแอดมิน Eden Cafe");
  }
  if (!receipt.customerUid || !receipt.customerProfileSynced) {
    throw new Error("บิลนี้ยังไม่มีสมาชิก Eden ที่ซิงก์แล้ว");
  }

  const token = await user.getIdToken();
  const response = await fetch(`${FUNCTIONS_BASE_URL}/applyPosLoyaltySale`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      orderId: orderId || receipt.firestoreId || receipt.number,
      firestoreId: orderId || receipt.firestoreId || "",
      receiptNo: receipt.number,
      customerUid: receipt.customerUid,
      netAmount: receipt.totalBeforeLoyalty ?? receipt.totalAmount ?? receipt.total,
      normalDiscount: receipt.normalDiscount ?? receipt.discount ?? 0,
      subtotal: receipt.subtotal,
      items: receipt.items.map((item) => ({
        productId: item.sourceProductId || item.productId.split("::")[0],
        variantId: item.variantId || "base",
        sku: item.sku,
        name: item.name,
        variantName: item.variantName || "",
        category: item.category,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineDiscount: item.lineDiscount || 0,
        taxEnabled: item.taxEnabled
      })),
      redeemedPoints:
        receipt.redeemedPoints ?? receipt.loyaltyRedemption?.redeemedPoints ?? 0,
      loyaltyDiscount: receipt.loyaltyDiscount ?? 0,
      idempotencyKey: receipt.loyaltyIdempotencyKey || receipt.number
    })
  });
  const result = (await response.json().catch(() => ({}))) as {
    loyalty?: LoyaltyResult;
    error?: string;
  };

  if (!response.ok || !result.loyalty) {
    throw new Error(result.error || "ซิงก์แต้ม Loyalty ไม่สำเร็จ");
  }

  return result.loyalty;
};
