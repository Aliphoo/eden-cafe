import { Capacitor, registerPlugin } from "@capacitor/core";
import type { CartLine, PaymentMethod, StoreProfile } from "../domain/pos";
import {
  buildPromptPayPayload,
  createQrDataUrl,
  createQrDataUrlWithLogo
} from "./promptPay";

const CUSTOMER_DISPLAY_STATE_KEY = "eden-pos-customer-display-state-v1";
const CUSTOMER_DISPLAY_SETTINGS_KEY = "eden-pos-customer-display-settings-v1";
const CUSTOMER_DISPLAY_CHANNEL = "eden-pos-customer-display";

export type CustomerDisplayStage = "idle" | "cart" | "payment" | "paid";

export type CustomerDisplayLine = {
  id: string;
  name: string;
  variantName?: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  total: number;
  note?: string;
};

export type CustomerDisplayState = {
  stage: CustomerDisplayStage;
  storeName: string;
  promptPayId: string;
  promptPayPayload: string;
  promptPayQrDataUrl: string;
  merchantName: string;
  city: string;
  lines: CustomerDisplayLine[];
  subtotal: number;
  discount: number;
  taxIncluded: number;
  total: number;
  paid: number;
  change: number;
  paymentMethod: PaymentMethod | "";
  paymentLabel: string;
  customerName: string;
  message: string;
  updatedAt: string;
};

export type CustomerDisplaySettings = {
  enabled: boolean;
  nativePresentation: boolean;
  showQr: boolean;
  showLineItems: boolean;
  idleMessage: string;
  promoMessage: string;
};

type NativeDisplayInfo = {
  id: number;
  name: string;
  width: number;
  height: number;
  rotation: number;
};

type NativeCustomerDisplayPlugin = {
  getDisplays(): Promise<{ available: boolean; displays: NativeDisplayInfo[] }>;
  show(options: {
    state: CustomerDisplayState;
    settings: CustomerDisplaySettings;
  }): Promise<{ available: boolean; displayName?: string }>;
  update(options: {
    state: CustomerDisplayState;
    settings: CustomerDisplaySettings;
  }): Promise<{ available: boolean }>;
  dismiss(): Promise<void>;
};

const NativeCustomerDisplay = registerPlugin<NativeCustomerDisplayPlugin>(
  "CustomerDisplay"
);

const defaultCustomerDisplaySettings: CustomerDisplaySettings = {
  enabled: false,
  nativePresentation: true,
  showQr: true,
  showLineItems: true,
  idleMessage: "ยินดีต้อนรับสู่ Eden Cafe",
  promoMessage: "รายการสินค้าและยอดชำระจะแสดงที่หน้าจอนี้"
};

export const getDefaultCustomerDisplayState = (): CustomerDisplayState => ({
  stage: "idle",
  storeName: "Eden Cafe",
  promptPayId: "",
  promptPayPayload: "",
  promptPayQrDataUrl: "",
  merchantName: "Eden Cafe",
  city: "Chiang Rai",
  lines: [],
  subtotal: 0,
  discount: 0,
  taxIncluded: 0,
  total: 0,
  paid: 0,
  change: 0,
  paymentMethod: "",
  paymentLabel: "",
  customerName: "Walk-in Customer",
  message: defaultCustomerDisplaySettings.idleMessage,
  updatedAt: new Date().toISOString()
});

const safeJsonParse = <Value>(raw: string | null, fallback: Value): Value => {
  if (!raw) return fallback;

  try {
    return JSON.parse(raw) as Value;
  } catch {
    return fallback;
  }
};

const broadcastCustomerDisplayState = (state: CustomerDisplayState) => {
  if (!("BroadcastChannel" in window)) return;

  const channel = new BroadcastChannel(CUSTOMER_DISPLAY_CHANNEL);
  channel.postMessage(state);
  channel.close();
};

export const loadCustomerDisplaySettings = (): CustomerDisplaySettings => ({
  ...defaultCustomerDisplaySettings,
  ...safeJsonParse<Partial<CustomerDisplaySettings>>(
    window.localStorage.getItem(CUSTOMER_DISPLAY_SETTINGS_KEY),
    {}
  )
});

export const saveCustomerDisplaySettings = (
  settings: CustomerDisplaySettings
) => {
  const normalized = {
    ...defaultCustomerDisplaySettings,
    ...settings
  };
  window.localStorage.setItem(
    CUSTOMER_DISPLAY_SETTINGS_KEY,
    JSON.stringify(normalized)
  );
  return normalized;
};

export const readCustomerDisplayState = () =>
  safeJsonParse<CustomerDisplayState>(
    window.localStorage.getItem(CUSTOMER_DISPLAY_STATE_KEY),
    getDefaultCustomerDisplayState()
  );

export const subscribeCustomerDisplayState = (
  onState: (state: CustomerDisplayState) => void
) => {
  let channel: BroadcastChannel | null = null;

  if ("BroadcastChannel" in window) {
    channel = new BroadcastChannel(CUSTOMER_DISPLAY_CHANNEL);
    channel.onmessage = (event) => {
      onState(event.data as CustomerDisplayState);
    };
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === CUSTOMER_DISPLAY_STATE_KEY) {
      onState(readCustomerDisplayState());
    }
  };

  window.addEventListener("storage", onStorage);

  return () => {
    channel?.close();
    window.removeEventListener("storage", onStorage);
  };
};

export const buildCustomerDisplayState = (input: {
  cart: CartLine[];
  customerName?: string;
  message?: string;
  paid?: number;
  paymentMethod?: PaymentMethod;
  paymentLabel?: string;
  stage?: CustomerDisplayStage;
  store: StoreProfile;
  totals: {
    subtotal: number;
    discount: number;
    taxIncluded: number;
    total: number;
  };
}): CustomerDisplayState => {
  const lines = input.cart.map((line) => {
    const gross = line.unitPrice * line.quantity;
    const discount = Math.max(line.lineDiscount ?? 0, 0);

    return {
      id: `${line.productId}:${line.variantId || "base"}`,
      name: line.name,
      variantName: line.variantName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discount,
      total: Math.max(gross - discount, 0),
      note: line.note
    };
  });

  const paid = Math.max(input.paid ?? 0, 0);
  const stage = input.stage ?? (lines.length ? "cart" : "idle");
  const promptPayId = input.store.promptPayId || "";
  const merchantName = input.store.merchantName || input.store.name || "Eden Cafe";
  const city = input.store.city || "Chiang Rai";
  const promptPayPayload =
    input.paymentMethod === "qr" && promptPayId && input.totals.total > 0
      ? buildPromptPayPayload(input.totals.total, {
          promptPayId,
          merchantName,
          city
        })
      : "";

  return {
    stage,
    storeName: input.store.name || "Eden Cafe",
    promptPayId,
    promptPayPayload,
    promptPayQrDataUrl: promptPayPayload ? createQrDataUrl(promptPayPayload) : "",
    merchantName,
    city,
    lines,
    subtotal: input.totals.subtotal,
    discount: input.totals.discount,
    taxIncluded: input.totals.taxIncluded,
    total: input.totals.total,
    paid,
    change: Math.max(paid - input.totals.total, 0),
    paymentMethod: input.paymentMethod || "",
    paymentLabel: input.paymentLabel || "",
    customerName: input.customerName || "Walk-in Customer",
    message:
      input.message ||
      (lines.length
        ? "ตรวจสอบรายการและยอดชำระ"
        : defaultCustomerDisplaySettings.idleMessage),
    updatedAt: new Date().toISOString()
  };
};

export const getCustomerDisplayNativeStatus = async () => {
  if (!Capacitor.isNativePlatform()) {
    return { available: false, displays: [] as NativeDisplayInfo[] };
  }

  return NativeCustomerDisplay.getDisplays();
};

export const showCustomerDisplay = async (
  state = readCustomerDisplayState(),
  settings = loadCustomerDisplaySettings()
) => {
  if (!Capacitor.isNativePlatform()) {
    return { available: false };
  }

  return NativeCustomerDisplay.show({ state, settings });
};

export const hideCustomerDisplay = async () => {
  if (!Capacitor.isNativePlatform()) return;
  await NativeCustomerDisplay.dismiss();
};

export const publishCustomerDisplayState = async (
  state: CustomerDisplayState
) => {
  let displayState = state;
  if (state.promptPayPayload) {
    const promptPayQrDataUrl = await createQrDataUrlWithLogo(
      state.promptPayPayload,
      { logoSrc: "Images/Logo.webp" }
    ).catch(() => state.promptPayQrDataUrl);
    displayState = { ...state, promptPayQrDataUrl };
  }

  window.localStorage.setItem(
    CUSTOMER_DISPLAY_STATE_KEY,
    JSON.stringify(displayState)
  );
  broadcastCustomerDisplayState(displayState);

  const settings = loadCustomerDisplaySettings();
  if (
    settings.enabled &&
    settings.nativePresentation &&
    Capacitor.isNativePlatform()
  ) {
    await NativeCustomerDisplay.update({ state: displayState, settings }).catch(() =>
      NativeCustomerDisplay.show({ state: displayState, settings }).catch(() => null)
    );
  }
};

export const openCustomerDisplayWindow = () => {
  const url = new URL(window.location.href);
  url.searchParams.set("customerDisplay", "1");
  url.hash = "";
  return window.open(
    url.toString(),
    "eden-customer-display",
    "popup,width=960,height=640"
  );
};

export const isCustomerDisplayRoute = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("customerDisplay") === "1" || window.location.hash === "#customer-display";
};
