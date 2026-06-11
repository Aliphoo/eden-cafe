import { Capacitor, registerPlugin } from "@capacitor/core";
import { formatNumber, paymentMethodLabel } from "../domain/money";
import type {
  CartLine,
  OrderTicketPrintedItem,
  PaymentMethod,
  Receipt,
  StoreProfile
} from "../domain/pos";
import {
  receiptNetDiscount,
  receiptNetTaxIncluded,
  receiptNetTotal,
  receiptRefunds,
  receiptTotalRefunded
} from "../domain/receiptAdjustments";
import {
  receiptOpenedAtValue,
  receiptReportDateTime
} from "../domain/receiptDates";
import { loadPosData } from "../storage/posStore";

export type PrinterConnection =
  | "bridge-network"
  | "browser-serial"
  | "browser-usb"
  | "browser-bluetooth"
  | "browser-print";

export type PrinterCodepage =
  | "thai-raster"
  | "thai42"
  | "cp874"
  | "ascii"
  | "utf8";

export type PosPrinterProfile = {
  id: string;
  name: string;
  connection: PrinterConnection;
  endpoint: string;
  host: string;
  port: number;
  baudRate: number;
  vendorId: string;
  productId: string;
  deviceName: string;
  productName: string;
  interfaceNumber: number;
  endpointNumber: number;
  bluetoothAddress: string;
  bluetoothName: string;
  serviceUuid: string;
  characteristicUuid: string;
  paperWidth: 58 | 80;
  copies: number;
  codepage: PrinterCodepage;
  printReceiptsAndBills: boolean;
  printOrderTickets: boolean;
  autoPrintReceipt: boolean;
  singleItemTickets: boolean;
  groupIdenticalItems: boolean;
  printerGroups: string[];
  categoryFilters: string[];
};

export type PosPrinterSettings = {
  enabled: boolean;
  autoPrint: boolean;
  autoPrintOrderTickets: boolean;
  activePrinterId: string;
  printers: PosPrinterProfile[];
};

type PrinterTone = "ready" | "warning" | "error";

type OrderTicketItem = {
  name: string;
  variantName?: string;
  category: string;
  quantity: number;
  note?: string;
};

type PrintableTicket = {
  receiptNo: string;
  title?: string;
  date: string;
  printerName: string;
  groupLabel: string;
  customerName: string;
  phone: string;
  tableId?: string;
  tableNumber?: string;
  tableName?: string;
  tableZone?: string;
  items: OrderTicketItem[];
};

type SerialPortLike = {
  writable?: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};

type UsbDeviceLike = {
  configuration?: unknown;
  open(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpointNumber: number, data: Uint8Array): Promise<unknown>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  close(): Promise<void>;
};

type BluetoothCharacteristicLike = {
  writeValue(data: Uint8Array): Promise<void>;
};

type BluetoothDeviceLike = {
  gatt?: {
    connected?: boolean;
    connect(): Promise<{
      getPrimaryService(serviceUuid: string): Promise<{
        getCharacteristic(
          characteristicUuid: string
        ): Promise<BluetoothCharacteristicLike>;
      }>;
    }>;
    disconnect(): void;
  };
};

type PrinterNavigator = Navigator & {
  serial?: {
    requestPort(): Promise<SerialPortLike>;
  };
  usb?: {
    requestDevice(options: { filters: Array<{ vendorId: number }> }): Promise<UsbDeviceLike>;
  };
  bluetooth?: {
    requestDevice(options: {
      filters: Array<{ services: string[] }>;
      optionalServices: string[];
    }): Promise<BluetoothDeviceLike>;
  };
};

type NativeUsbEscPosPrinterPlugin = {
  listDevices(): Promise<{
    devices: NativeUsbPrinterDevice[];
  }>;
  print(options: {
    payloadBase64: string;
    vendorId?: string;
    productId?: string;
    deviceName?: string;
    interfaceNumber?: string;
    endpointNumber?: string;
  }): Promise<{
    ok: boolean;
    bytes: number;
    device?: unknown;
    interfaceNumber?: number;
    endpointNumber?: number;
    endpointAddress?: number;
  }>;
};

const NativeUsbEscPosPrinter = registerPlugin<NativeUsbEscPosPrinterPlugin>(
  "UsbEscPosPrinter"
);

type NativeBluetoothEscPosPrinterPlugin = {
  listDevices(): Promise<{
    devices: NativeBluetoothPrinterDevice[];
  }>;
  print(options: {
    payloadBase64: string;
    address?: string;
    name?: string;
    uuid?: string;
  }): Promise<{
    ok: boolean;
    bytes: number;
    device?: NativeBluetoothPrinterDevice;
  }>;
};

const NativeBluetoothEscPosPrinter =
  registerPlugin<NativeBluetoothEscPosPrinterPlugin>("BluetoothEscPosPrinter");

export type NativeUsbEndpointInfo = {
  endpointNumber: number;
  address: number;
  direction: number;
  type: number;
  maxPacketSize: number;
  writable: boolean;
};

export type NativeUsbInterfaceInfo = {
  id: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  endpoints: NativeUsbEndpointInfo[];
};

export type NativeUsbPrinterDevice = {
  deviceName: string;
  vendorId: number;
  productId: number;
  deviceClass: number;
  manufacturerName?: string;
  productName?: string;
  hasPermission?: boolean;
  interfaces?: NativeUsbInterfaceInfo[];
};

export type NativeBluetoothPrinterDevice = {
  name: string;
  address: string;
  bondState: number;
  type: number;
};

type PrintableOrder = {
  receiptNo: string;
  logoDataUrl?: string;
  receiptTitle?: string;
  receiptHeaderLines?: string[];
  receiptFooterLines?: string[];
  receiptFooterTaxNote?: string;
  date: string;
  cashierName: string;
  paymentMethod: PaymentMethod;
  paymentLabel: string;
  items: Array<{
    name: string;
    variantName?: string;
    quantity: number;
    lineTotal: number;
    note?: string;
  }>;
  refunds?: Array<{
    refundNo: string;
    createdAt: string;
    reason: string;
    approvedByName: string;
    amount: number;
    lines: Array<{
      name: string;
      variantName?: string;
      quantity: number;
      amount: number;
    }>;
  }>;
  subtotal: number;
  discount: number;
  taxIncluded: number;
  originalTotalAmount?: number;
  refundedAmount?: number;
  totalAmount: number;
  paidAmount: number;
  changeAmount: number;
  customerName: string;
  phone: string;
  isTestOrder?: boolean;
  paymentStatus?: Receipt["paymentStatus"];
};

export type SalesSummaryCategoryReportRow = {
  label: string;
  quantity: number;
  sales: number;
};

export type SalesSummaryByCategoryReportInput = {
  rangeLabel: string;
  printedAt?: string | Date;
  totals: {
    receiptCount: number;
    netSales: number;
    refunds: number;
    discounts: number;
    taxIncluded: number;
    cost: number;
    grossProfit: number;
  };
  rows: SalesSummaryCategoryReportRow[];
  storeName?: string;
};

export const POS_PRINTER_STORAGE_KEY = "edenPosPrinterSettingsV1";
export const POS_PRINTER_BRIDGE_DEFAULT = "http://127.0.0.1:8787";
export const POS_PRINTER_DEFAULT_BLE_SERVICE =
  "0000ffe0-0000-1000-8000-00805f9b34fb";
export const POS_PRINTER_DEFAULT_BLE_CHARACTERISTIC =
  "0000ffe1-0000-1000-8000-00805f9b34fb";
export const POS_PRINTER_DEFAULT_BT_SPP_UUID =
  "00001101-0000-1000-8000-00805f9b34fb";

export const printerConnectionOptions: Array<{
  value: PrinterConnection;
  label: string;
  description: string;
}> = [
  {
    value: "bridge-network",
    label: "WiFi/LAN ผ่าน Eden Print Bridge",
    description: "เหมาะกับเครื่องพิมพ์ครัวหรือแคชเชียร์ที่ต่อ LAN พอร์ต 9100"
  },
  {
    value: "browser-serial",
    label: "สาย / Bluetooth SPP ผ่าน Web Serial",
    description: "ใช้กับเครื่องพิมพ์ที่ขึ้นเป็น serial port ใน browser ที่รองรับ"
  },
  {
    value: "browser-usb",
    label: "USB ผ่าน WebUSB",
    description: "ใช้กับเครื่องพิมพ์ USB ที่ browser อนุญาตให้ส่งข้อมูลออก"
  },
  {
    value: "browser-bluetooth",
    label: "Bluetooth BLE",
    description: "ใช้กับเครื่องพิมพ์ BLE ที่มี service/characteristic สำหรับเขียนข้อมูล"
  },
  {
    value: "browser-print",
    label: "Browser print fallback",
    description: "เปิดหน้าพิมพ์ธรรมดา ใช้ทดสอบ PDF หรือ driver ของระบบ"
  }
];

const nativeUsbOption = printerConnectionOptions.find(
  (option) => option.value === "browser-usb"
);
if (nativeUsbOption) {
  nativeUsbOption.label = "USB ผ่าน Android Native";
  nativeUsbOption.description =
    "ใช้กับเครื่องพิมพ์ USB ESC/POS ที่เสียบตรงกับเครื่อง Android POS";
}

const nativeBluetoothOption = printerConnectionOptions.find(
  (option) => option.value === "browser-bluetooth"
);
if (nativeBluetoothOption) {
  nativeBluetoothOption.label = "Bluetooth ผ่าน Android Native";
  nativeBluetoothOption.description =
    "ใช้กับเครื่องพิมพ์ Bluetooth ESC/POS ที่ pair ไว้แล้วใน Android";
}

export const printerGroupOptions: Array<{ id: string; label: string }> = [
  { id: "bar", label: "บาร์" },
  { id: "kitchen", label: "ห้องครัว" }
];

const allowedConnections = new Set<PrinterConnection>(
  printerConnectionOptions.map((option) => option.value)
);
const allowedCodepages = new Set<PrinterCodepage>([
  "thai-raster",
  "thai42",
  "cp874",
  "ascii",
  "utf8"
]);

const runtime: {
  serialPort: SerialPortLike | null;
} = {
  serialPort: null
};

const safeNumber = (value: unknown, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export const createPosPrinterId = () => {
  const random =
    window.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `printer-${random}`;
};

export const createPosPrinterProfile = (
  overrides: Partial<PosPrinterProfile> = {}
): PosPrinterProfile => ({
  id: overrides.id || createPosPrinterId(),
  name: overrides.name?.trim() || "Eden LAN Printer",
  connection:
    overrides.connection && allowedConnections.has(overrides.connection)
      ? overrides.connection
      : "bridge-network",
  endpoint: overrides.endpoint || POS_PRINTER_BRIDGE_DEFAULT,
  host: overrides.host?.trim() || "",
  port: Math.min(65535, Math.max(1, Math.round(safeNumber(overrides.port, 9100)))),
  baudRate: Math.max(1200, Math.round(safeNumber(overrides.baudRate, 9600))),
  vendorId: String(overrides.vendorId || "").trim(),
  productId: String(overrides.productId || "").trim(),
  deviceName: String(overrides.deviceName || "").trim(),
  productName: String(overrides.productName || "").trim(),
  interfaceNumber: Math.max(0, Math.round(safeNumber(overrides.interfaceNumber, 0))),
  endpointNumber: Math.max(1, Math.round(safeNumber(overrides.endpointNumber, 1))),
  bluetoothAddress: String(overrides.bluetoothAddress || "").trim(),
  bluetoothName: String(overrides.bluetoothName || "").trim(),
  serviceUuid: overrides.serviceUuid || POS_PRINTER_DEFAULT_BLE_SERVICE,
  characteristicUuid:
    overrides.characteristicUuid || POS_PRINTER_DEFAULT_BLE_CHARACTERISTIC,
  paperWidth: safeNumber(overrides.paperWidth, 80) === 58 ? 58 : 80,
  copies: Math.min(4, Math.max(1, Math.round(safeNumber(overrides.copies, 1)))),
  codepage:
    overrides.codepage && allowedCodepages.has(overrides.codepage)
      ? overrides.codepage
      : "thai-raster",
  printReceiptsAndBills: overrides.printReceiptsAndBills !== false,
  printOrderTickets: overrides.printOrderTickets === true,
  autoPrintReceipt: overrides.autoPrintReceipt !== false,
  singleItemTickets: overrides.singleItemTickets === true,
  groupIdenticalItems: overrides.groupIdenticalItems !== false,
  printerGroups: Array.isArray(overrides.printerGroups)
    ? overrides.printerGroups.map(String).filter(Boolean)
    : [],
  categoryFilters: Array.isArray(overrides.categoryFilters)
    ? overrides.categoryFilters.map(String).filter(Boolean)
    : []
});

export const normalizePosPrinterProfile = (
  profile: Partial<PosPrinterProfile> = {},
  index = 0
) =>
  createPosPrinterProfile({
    ...profile,
    id: String(profile.id || "").trim() || `printer-${index + 1}`,
    name:
      String(profile.name || "").trim() ||
      `POS Printer ${index + 1}`
  });

export const normalizePosPrinterSettings = (
  data: Partial<PosPrinterSettings> = {}
): PosPrinterSettings => {
  const rawPrinters = Array.isArray(data.printers) ? data.printers : [];
  const printers = rawPrinters.length
    ? rawPrinters.map((profile, index) =>
        normalizePosPrinterProfile(profile, index)
      )
    : [
        createPosPrinterProfile({
          id: "eden-default-lan",
          name: "Eden LAN Printer"
        })
      ];
  let activePrinterId = String(data.activePrinterId || "").trim();

  if (!printers.some((printer) => printer.id === activePrinterId)) {
    activePrinterId = printers[0]?.id || "";
  }

  return {
    enabled: data.enabled !== false,
    autoPrint: data.autoPrint === true,
    autoPrintOrderTickets: data.autoPrintOrderTickets !== false,
    activePrinterId,
    printers
  };
};

export const loadPosPrinterSettings = () => {
  try {
    const raw = window.localStorage.getItem(POS_PRINTER_STORAGE_KEY);
    return normalizePosPrinterSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizePosPrinterSettings({});
  }
};

export const savePosPrinterSettings = (settings: Partial<PosPrinterSettings>) => {
  const normalized = normalizePosPrinterSettings(settings);
  window.localStorage.setItem(
    POS_PRINTER_STORAGE_KEY,
    JSON.stringify(normalized)
  );
  return normalized;
};

export const currentPosPrinter = (settings = loadPosPrinterSettings()) =>
  settings.printers.find((printer) => printer.id === settings.activePrinterId) ||
  settings.printers[0] ||
  null;

const frontBarPrinterKeywords = [
  "หน้าบาร์",
  "บาร์",
  "frontbar",
  "front",
  "bar",
  "counter",
  "cashier"
];

const normalizePrinterSearchText = (value: string) =>
  value.toLocaleLowerCase("th-TH").replace(/\s+/g, "");

const isFrontBarPrinter = (printer: PosPrinterProfile) => {
  const searchableText = normalizePrinterSearchText(
    [
      printer.name,
      printer.deviceName,
      printer.productName,
      printer.bluetoothName
    ].join(" ")
  );

  return (
    printer.printerGroups.includes("bar") ||
    frontBarPrinterKeywords.some((keyword) =>
      searchableText.includes(normalizePrinterSearchText(keyword))
    )
  );
};

export const frontBarReceiptPrinter = (
  settings = loadPosPrinterSettings()
): PosPrinterProfile | null =>
  settings.printers.find(
    (printer) => printer.printReceiptsAndBills && isFrontBarPrinter(printer)
  ) ||
  settings.printers.find(isFrontBarPrinter) ||
  currentPosPrinter(settings);

export const receiptPrinter = (
  settings = loadPosPrinterSettings()
): PosPrinterProfile | null => {
  const active = currentPosPrinter(settings);
  if (active?.printReceiptsAndBills) {
    return active;
  }

  return (
    settings.printers.find(
      (printer) => printer.printReceiptsAndBills && isFrontBarPrinter(printer)
    ) ||
    settings.printers.find((printer) => printer.printReceiptsAndBills) ||
    frontBarReceiptPrinter(settings)
  );
};

export const describePosPrinter = (printer: PosPrinterProfile | null) => {
  if (!printer) return "ยังไม่ได้ตั้งค่า";
  const label =
    printerConnectionOptions.find((option) => option.value === printer.connection)
      ?.label ?? "Printer";

  if (printer.connection === "bridge-network") {
    return printer.host
      ? `${label} @ ${printer.host}:${printer.port}`
      : `${label} - ใส่ IP เครื่องพิมพ์ก่อน`;
  }

  if (printer.connection === "browser-serial") {
    return `${label} @ ${printer.baudRate} baud`;
  }

  if (printer.connection === "browser-usb") {
    if (printer.productName || printer.deviceName) {
      return `${label} - ${printer.productName || printer.deviceName}`;
    }
    if (printer.vendorId || printer.productId) {
      return `${label} vendor ${printer.vendorId || "auto"} product ${printer.productId || "auto"}`;
    }
    return `${label} - กดค้นหา USB เพื่อเลือกเครื่อง`;
  }

  if (printer.connection === "browser-bluetooth") {
    if (printer.bluetoothName || printer.bluetoothAddress) {
      return `${label} - ${printer.bluetoothName || printer.bluetoothAddress}`;
    }
    return `${label} - กดค้นหา Bluetooth เพื่อเลือกเครื่อง`;
  }

  return label;
};

export const getPrinterCapabilities = () => {
  const printerNavigator = navigator as PrinterNavigator;

  return {
    serial: Boolean(printerNavigator.serial),
    usb: Capacitor.isNativePlatform() || Boolean(printerNavigator.usb),
    bluetooth: Capacitor.isNativePlatform() || Boolean(printerNavigator.bluetooth)
  };
};

export const capabilityLabel = () => {
  const capabilities = getPrinterCapabilities();

  return [
    `Serial ${capabilities.serial ? "OK" : "No"}`,
    `USB ${capabilities.usb ? "OK" : "No"}`,
    `Bluetooth ${capabilities.bluetooth ? "OK" : "No"}`
  ].join(" / ");
};

export const listNativeUsbPrinterDevices = async () => {
  if (!Capacitor.isNativePlatform()) {
    return [] as NativeUsbPrinterDevice[];
  }

  const result = await NativeUsbEscPosPrinter.listDevices();
  return Array.isArray(result.devices) ? result.devices : [];
};

export const listNativeBluetoothPrinterDevices = async () => {
  if (!Capacitor.isNativePlatform()) {
    return [] as NativeBluetoothPrinterDevice[];
  }

  const result = await NativeBluetoothEscPosPrinter.listDevices();
  return Array.isArray(result.devices) ? result.devices : [];
};

export const normalizeBridgeEndpoint = (endpoint: string) =>
  String(endpoint || POS_PRINTER_BRIDGE_DEFAULT)
    .trim()
    .replace(/\/+$/, "") || POS_PRINTER_BRIDGE_DEFAULT;

export const checkPosPrintBridge = async (endpoint: string) => {
  const bridgeEndpoint = normalizeBridgeEndpoint(endpoint);
  const response = await fetch(`${bridgeEndpoint}/health`, { method: "GET" });
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Bridge health check failed");
  }

  return true;
};

const receiptMoneyText = (value: unknown) => `B${formatNumber(value, 2)}`;

const receiptLineWidth = (printer: Partial<PosPrinterProfile>) =>
  safeNumber(printer.paperWidth, 80) === 58 ? 32 : 42;

const reportQuantityText = (value: unknown) => {
  const quantity = safeNumber(value, 0);
  return formatNumber(quantity, Number.isInteger(quantity) ? 0 : 2);
};

const cleanReceiptText = (value: unknown) =>
  String(value ?? "")
    .replace(/\r/g, "")
    .replace(/[\t ]+/g, " ")
    .trim();

const ORDER_TICKET_FONT_SCALE = 1.5;
const orderTicketFontSize = (size: number) =>
  Math.max(1, Math.round(size * ORDER_TICKET_FONT_SCALE));

const isWalkInCustomerName = (value: unknown) =>
  cleanReceiptText(value).toLowerCase() === "walk-in customer";

const orderTicketCustomerLabel = (
  input: Pick<PrintableTicket, "customerName" | "phone">
) =>
  [
    isWalkInCustomerName(input.customerName) ? "" : input.customerName,
    input.phone
  ]
    .map(cleanReceiptText)
    .filter(Boolean)
    .join(" / ");

const orderTicketTableLabel = (
  input: Pick<
    PrintableTicket,
    "tableNumber" | "tableName" | "tableZone"
  >
) =>
  [
    input.tableNumber,
    input.tableName && input.tableName !== input.tableNumber
      ? input.tableName
      : "",
    input.tableZone
  ]
    .map(cleanReceiptText)
    .filter(Boolean)
    .join(" / ");

const centerReceiptText = (text: string, width: number) => {
  const clean = cleanReceiptText(text);
  if (clean.length >= width) return clean.slice(0, width);
  return `${" ".repeat(Math.floor((width - clean.length) / 2))}${clean}`;
};

const twoColumnReceiptText = (left: string, right: string, width: number) => {
  const cleanLeft = cleanReceiptText(left);
  const cleanRight = cleanReceiptText(right);
  const maxLeft = Math.max(1, width - cleanRight.length - 1);
  const clippedLeft =
    cleanLeft.length > maxLeft ? `${cleanLeft.slice(0, maxLeft - 1)}.` : cleanLeft;

  return `${clippedLeft}${" ".repeat(
    Math.max(1, width - clippedLeft.length - cleanRight.length)
  )}${cleanRight}`;
};

const wrapReceiptText = (text: string, width: number) => {
  const clean = cleanReceiptText(text);
  if (!clean) return [""];

  const lines: string[] = [];
  let rest = clean;

  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width * 0.45) cut = width;
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  lines.push(rest);
  return lines;
};

const splitReceiptLines = (value: unknown, limit = 8) =>
  String(value ?? "")
    .split(/\n/)
    .map((line) => cleanReceiptText(line))
    .filter(Boolean)
    .slice(0, limit);

const escapeReceiptHtml = (value: unknown) =>
  cleanReceiptText(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#039;";
      default:
        return char;
    }
  });

const receiptSlipTextFromStore = (store: StoreProfile) => {
  const headerLines = [
    store.receiptHeaderBusinessName || store.name,
    store.receiptHeaderBranch ? `สาขา ${store.receiptHeaderBranch}` : "",
    store.receiptHeaderAddress,
    store.receiptTaxId ? `เลขผู้เสียภาษี ${store.receiptTaxId}` : "",
    store.receiptPhone ? `เบอร์โทร ${store.receiptPhone}` : "",
    store.receiptWebsite ? `เว็บไซต์ ${store.receiptWebsite}` : ""
  ]
    .map((line) => cleanReceiptText(line))
    .filter(Boolean);

  return {
    receiptTitle:
      cleanReceiptText(store.receiptTitle) ||
      "ใบกำกับภาษีอย่างย่อ/ใบเสร็จรับเงิน",
    receiptHeaderLines: headerLines.length ? headerLines : [store.name],
    receiptFooterLines: splitReceiptLines(store.receiptFooterNote),
    receiptFooterTaxNote: cleanReceiptText(store.receiptFooterTaxNote)
  };
};

const receiptHeaderLines = (order: PrintableOrder) =>
  order.receiptHeaderLines?.filter(Boolean).length
    ? order.receiptHeaderLines.filter(Boolean)
    : ["Eden Cafe"];

const receiptFooterLines = (order: PrintableOrder) =>
  order.receiptFooterLines?.filter(Boolean) ?? [];

const encodeEscPosText = (text: string, codepage: PrinterCodepage = "thai42") => {
  if (codepage === "utf8") {
    return Array.from(new TextEncoder().encode(String(text ?? "")));
  }

  const bytes: number[] = [];
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 10 || code === 13 || code === 9 || (code >= 32 && code <= 126)) {
      bytes.push(code);
    } else if (codepage !== "ascii" && code >= 0x0e01 && code <= 0x0e5b) {
      bytes.push(code - 0x0d60);
    } else if (codepage !== "ascii" && code === 0x0e3f) {
      bytes.push(0x80);
    } else if (code === 0x2013 || code === 0x2014 || code === 0x2212) {
      bytes.push(45);
    } else if (code === 0x2022) {
      bytes.push(42);
    } else {
      bytes.push(63);
    }
  }
  return bytes;
};

const pushEscPosLine = (
  target: number[],
  text = "",
  printer: Partial<PosPrinterProfile> = {}
) => {
  target.push(...encodeEscPosText(text, printer.codepage), 10);
};

const hasDocumentCanvas = () =>
  typeof document !== "undefined" && typeof document.createElement === "function";

type RasterLine =
  | { kind: "text"; text: string; align?: CanvasTextAlign; size?: number; bold?: boolean }
  | { kind: "two-column"; left: string; right: string; size?: number; bold?: boolean }
  | { kind: "rule" }
  | { kind: "space"; height?: number };

const rasterPaperWidth = (printer: Partial<PosPrinterProfile>) =>
  safeNumber(printer.paperWidth, 80) === 58 ? 384 : 512;

const rasterFont = (size: number, bold = false) =>
  `${bold ? "700" : "500"} ${size}px "Noto Sans Thai", "Tahoma", "Arial", sans-serif`;

const wrapRasterText = (
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
) => {
  const clean = cleanReceiptText(text);
  if (!clean) return [""];

  const lines: string[] = [];
  let line = "";
  let lastBreak = -1;

  for (const char of clean) {
    const next = `${line}${char}`;
    if (/\s/.test(char) || char === "/" || char === "-") {
      lastBreak = next.length;
    }
    if (context.measureText(next).width <= maxWidth || !line) {
      line = next;
      continue;
    }

    if (lastBreak > 0 && lastBreak < next.length) {
      lines.push(next.slice(0, lastBreak).trim());
      line = next.slice(lastBreak).trimStart();
    } else {
      lines.push(line.trim());
      line = char.trimStart();
    }
    lastBreak = -1;
  }

  if (line.trim()) lines.push(line.trim());
  return lines.length ? lines : [clean];
};

const rasterizeReceiptLines = (
  lines: RasterLine[],
  printer: Partial<PosPrinterProfile>
) => {
  if (!hasDocumentCanvas()) return null;

  const width = rasterPaperWidth(printer);
  const paddingX = safeNumber(printer.paperWidth, 80) === 58 ? 18 : 24;
  const paddingY = 18;
  const maxTextWidth = width - paddingX * 2;
  const measureCanvas = document.createElement("canvas");
  const measureContext = measureCanvas.getContext("2d");
  if (!measureContext) return null;

  const planned: Array<{
    kind: "text" | "two-column" | "rule" | "space";
    text?: string;
    left?: string;
    right?: string;
    align?: CanvasTextAlign;
    size: number;
    bold: boolean;
    height: number;
  }> = [];

  const addText = (
    text: string,
    align: CanvasTextAlign,
    size: number,
    bold: boolean
  ) => {
    measureContext.font = rasterFont(size, bold);
    wrapRasterText(measureContext, text, maxTextWidth).forEach((lineText) => {
      planned.push({
        kind: "text",
        text: lineText,
        align,
        size,
        bold,
        height: Math.ceil(size * 1.38)
      });
    });
  };

  lines.forEach((line) => {
    if (line.kind === "space") {
      planned.push({
        kind: "space",
        size: 1,
        bold: false,
        height: Math.max(6, safeNumber(line.height, 12))
      });
      return;
    }

    if (line.kind === "rule") {
      planned.push({
        kind: "rule",
        size: 1,
        bold: false,
        height: 16
      });
      return;
    }

    if (line.kind === "two-column") {
      planned.push({
        kind: "two-column",
        left: line.left,
        right: line.right,
        size: line.size ?? 24,
        bold: line.bold === true,
        height: Math.ceil((line.size ?? 24) * 1.38)
      });
      return;
    }

    addText(
      line.text,
      line.align ?? "left",
      line.size ?? 24,
      line.bold === true
    );
  });

  const height =
    paddingY * 2 +
    planned.reduce((total, line) => total + line.height, 0) +
    24;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.ceil(height);
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.textBaseline = "alphabetic";

  let y = paddingY;
  planned.forEach((line) => {
    if (line.kind === "space") {
      y += line.height;
      return;
    }

    if (line.kind === "rule") {
      context.strokeStyle = "#000000";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(paddingX, y + Math.floor(line.height / 2));
      context.lineTo(width - paddingX, y + Math.floor(line.height / 2));
      context.stroke();
      y += line.height;
      return;
    }

    context.font = rasterFont(line.size, line.bold);
    const baseline = y + line.size;

    if (line.kind === "two-column") {
      context.textAlign = "left";
      context.fillText(cleanReceiptText(line.left), paddingX, baseline);
      context.textAlign = "right";
      context.fillText(cleanReceiptText(line.right), width - paddingX, baseline);
      y += line.height;
      return;
    }

    context.textAlign = line.align ?? "left";
    const x =
      line.align === "center"
        ? width / 2
        : line.align === "right"
          ? width - paddingX
          : paddingX;
    context.fillText(cleanReceiptText(line.text), x, baseline);
    y += line.height;
  });

  return canvas;
};

const pushEscPosRasterCanvas = (target: number[], canvas: HTMLCanvasElement) => {
  const context = canvas.getContext("2d");
  if (!context) return false;

  const width = canvas.width;
  const fullHeight = canvas.height;
  const image = context.getImageData(0, 0, width, fullHeight).data;
  let lastDarkRow = 0;

  for (let y = 0; y < fullHeight; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = image[offset + 3];
      const luminance =
        image[offset] * 0.299 + image[offset + 1] * 0.587 + image[offset + 2] * 0.114;
      if (alpha > 128 && luminance < 210) {
        lastDarkRow = y;
        break;
      }
    }
  }

  const height = Math.min(fullHeight, lastDarkRow + 16);
  const columnsL = width & 0xff;
  const columnsH = (width >> 8) & 0xff;
  const stripeHeight = 24;

  target.push(0x1b, 0x33, stripeHeight);

  for (let top = 0; top < height; top += stripeHeight) {
    const stripe: number[] = [];

    for (let x = 0; x < width; x += 1) {
      for (let byteIndex = 0; byteIndex < 3; byteIndex += 1) {
        let value = 0;
        for (let bit = 0; bit < 8; bit += 1) {
          const y = top + byteIndex * 8 + bit;
          if (y >= height) continue;
          const offset = (y * width + x) * 4;
          const alpha = image[offset + 3];
          const luminance =
            image[offset] * 0.299 +
            image[offset + 1] * 0.587 +
            image[offset + 2] * 0.114;
          if (alpha > 128 && luminance < 210) {
            value |= 0x80 >> bit;
          }
        }
        stripe.push(value);
      }
    }

    target.push(0x1b, 0x2a, 33, columnsL, columnsH, ...stripe, 10);
  }

  target.push(0x1b, 0x32);
  return true;
};

const buildRasterEscPosBytes = (
  lines: RasterLine[],
  printer: Partial<PosPrinterProfile>
) => {
  const canvas = rasterizeReceiptLines(lines, printer);
  if (!canvas) return null;

  const bytes: number[] = [0x1b, 0x40];
  if (!pushEscPosRasterCanvas(bytes, canvas)) return null;
  bytes.push(10, 10, 10, 0x1d, 0x56, 0x42, 0x00);
  return new Uint8Array(bytes);
};

const salesSummaryPrintedAtLabel = (
  printedAt: SalesSummaryByCategoryReportInput["printedAt"] = new Date()
) =>
  new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(printedAt instanceof Date ? printedAt : new Date(printedAt));

const salesSummaryReportStoreName = (
  input: SalesSummaryByCategoryReportInput
) => {
  const store = loadPosData().store;
  return (
    cleanReceiptText(
      input.storeName || store.receiptHeaderBusinessName || store.name
    ) || "Eden Cafe"
  );
};

const normalizedSalesSummaryRows = (
  input: SalesSummaryByCategoryReportInput
) =>
  input.rows
    .map((row) => ({
      label: cleanReceiptText(row.label) || "ไม่ระบุหมวดหมู่",
      quantity: safeNumber(row.quantity, 0),
      sales: safeNumber(row.sales, 0)
    }))
    .sort((a, b) => b.sales - a.sales);

const salesSummaryTotals = (rows: SalesSummaryCategoryReportRow[]) => ({
  quantity: rows.reduce((sum, row) => sum + safeNumber(row.quantity, 0), 0),
  sales: rows.reduce((sum, row) => sum + safeNumber(row.sales, 0), 0)
});

const buildRasterSalesSummaryPair = (
  printer: Partial<PosPrinterProfile>,
  left: string,
  right: string,
  options: { size?: number; bold?: boolean } = {}
): RasterLine[] => {
  const label = cleanReceiptText(left);
  const value = cleanReceiptText(right);
  const compactLimit = safeNumber(printer.paperWidth, 80) === 58 ? 14 : 20;

  if (label.length > compactLimit || value.length > 14) {
    return [
      {
        kind: "text",
        text: label,
        size: options.size ?? 22,
        bold: options.bold
      },
      {
        kind: "text",
        text: value,
        align: "right",
        size: options.size ?? 22,
        bold: options.bold
      }
    ];
  }

  return [
    {
      kind: "two-column",
      left: label,
      right: value,
      size: options.size ?? 22,
      bold: options.bold
    }
  ];
};

export const buildEscPosSalesSummaryByCategoryReportBytes = (
  input: SalesSummaryByCategoryReportInput,
  printer: Partial<PosPrinterProfile> = {}
) => {
  const rows = normalizedSalesSummaryRows(input);
  const totals = salesSummaryTotals(rows);
  const storeName = salesSummaryReportStoreName(input);
  const printedAt = salesSummaryPrintedAtLabel(input.printedAt);

  if (
    printer.codepage === "thai-raster" ||
    printer.codepage === "thai42" ||
    printer.codepage === "cp874"
  ) {
    const rowLines: RasterLine[] = rows.length
      ? rows.flatMap((row) => [
          { kind: "text" as const, text: row.label, size: 22, bold: true },
          ...buildRasterSalesSummaryPair(
            printer,
            `จำนวน ${reportQuantityText(row.quantity)}`,
            receiptMoneyText(row.sales),
            { size: 21 }
          )
        ])
      : [
          {
            kind: "text" as const,
            text: "ยังไม่มีข้อมูลในช่วงนี้",
            align: "center" as const,
            size: 22,
            bold: true
          }
        ];

    const raster = buildRasterEscPosBytes(
      [
        {
          kind: "text",
          text: storeName,
          align: "center",
          size: 30,
          bold: true
        },
        {
          kind: "text",
          text: "สรุปยอดขายตามหมวดหมู่",
          align: "center",
          size: 24,
          bold: true
        },
        { kind: "rule" },
        { kind: "text", text: `ช่วงวันที่: ${input.rangeLabel}`, size: 22 },
        { kind: "text", text: `พิมพ์เมื่อ: ${printedAt}`, size: 22 },
        { kind: "rule" },
        ...buildRasterSalesSummaryPair(
          printer,
          "จำนวนใบเสร็จที่ชำระแล้ว",
          reportQuantityText(input.totals.receiptCount),
          { size: 22 }
        ),
        ...buildRasterSalesSummaryPair(
          printer,
          "ยอดขายสุทธิ",
          receiptMoneyText(input.totals.netSales),
          { size: 22, bold: true }
        ),
        ...buildRasterSalesSummaryPair(
          printer,
          "คืนเงิน",
          receiptMoneyText(input.totals.refunds),
          { size: 22 }
        ),
        ...buildRasterSalesSummaryPair(
          printer,
          "ส่วนลด",
          receiptMoneyText(input.totals.discounts),
          { size: 22 }
        ),
        ...buildRasterSalesSummaryPair(
          printer,
          "VAT รวมในราคา",
          receiptMoneyText(input.totals.taxIncluded),
          { size: 22 }
        ),
        ...buildRasterSalesSummaryPair(
          printer,
          "ต้นทุนสินค้า",
          receiptMoneyText(input.totals.cost),
          { size: 22 }
        ),
        ...buildRasterSalesSummaryPair(
          printer,
          "กำไรรวม",
          receiptMoneyText(input.totals.grossProfit),
          { size: 22, bold: true }
        ),
        { kind: "rule" },
        {
          kind: "text",
          text: "หมวดหมู่ / จำนวน / ยอดขาย",
          align: "center",
          size: 22,
          bold: true
        },
        ...rowLines,
        { kind: "rule" },
        ...buildRasterSalesSummaryPair(
          printer,
          "รวมจำนวน",
          reportQuantityText(totals.quantity),
          { size: 23, bold: true }
        ),
        ...buildRasterSalesSummaryPair(
          printer,
          "รวมยอดขาย",
          receiptMoneyText(totals.sales),
          { size: 23, bold: true }
        ),
        { kind: "space", height: 8 },
        {
          kind: "text",
          text: "รายงานจาก Eden POS",
          align: "center",
          size: 22,
          bold: true
        }
      ],
      printer
    );
    if (raster) return raster;
  }

  const width = receiptLineWidth(printer);
  const bytes: number[] = [];
  const line = "-".repeat(width);

  bytes.push(0x1b, 0x40);
  if (printer.codepage === "thai42" || printer.codepage === "cp874") {
    bytes.push(0x1b, 0x74, 20);
  }

  bytes.push(0x1b, 0x61, 1, 0x1b, 0x45, 1);
  pushEscPosLine(bytes, centerReceiptText(storeName, width), printer);
  pushEscPosLine(
    bytes,
    centerReceiptText("สรุปยอดขายตามหมวดหมู่", width),
    printer
  );
  bytes.push(0x1b, 0x45, 0, 0x1b, 0x61, 0);
  pushEscPosLine(bytes, line, printer);
  wrapReceiptText(`ช่วงวันที่: ${input.rangeLabel}`, width).forEach((text) =>
    pushEscPosLine(bytes, text, printer)
  );
  wrapReceiptText(`พิมพ์เมื่อ: ${printedAt}`, width).forEach((text) =>
    pushEscPosLine(bytes, text, printer)
  );
  pushEscPosLine(bytes, line, printer);
  [
    ["จำนวนใบเสร็จที่ชำระแล้ว", reportQuantityText(input.totals.receiptCount)],
    ["ยอดขายสุทธิ", receiptMoneyText(input.totals.netSales)],
    ["คืนเงิน", receiptMoneyText(input.totals.refunds)],
    ["ส่วนลด", receiptMoneyText(input.totals.discounts)],
    ["VAT รวมในราคา", receiptMoneyText(input.totals.taxIncluded)],
    ["ต้นทุนสินค้า", receiptMoneyText(input.totals.cost)],
    ["กำไรรวม", receiptMoneyText(input.totals.grossProfit)]
  ].forEach(([label, value]) =>
    pushEscPosLine(bytes, twoColumnReceiptText(label, value, width), printer)
  );
  pushEscPosLine(bytes, line, printer);
  pushEscPosLine(
    bytes,
    centerReceiptText("หมวดหมู่ / จำนวน / ยอดขาย", width),
    printer
  );
  if (!rows.length) {
    pushEscPosLine(bytes, centerReceiptText("ยังไม่มีข้อมูลในช่วงนี้", width), printer);
  } else {
    rows.forEach((row) => {
      wrapReceiptText(row.label, width).forEach((text) =>
        pushEscPosLine(bytes, text, printer)
      );
      pushEscPosLine(
        bytes,
        twoColumnReceiptText(
          `จำนวน ${reportQuantityText(row.quantity)}`,
          receiptMoneyText(row.sales),
          width
        ),
        printer
      );
    });
  }
  pushEscPosLine(bytes, line, printer);
  pushEscPosLine(
    bytes,
    twoColumnReceiptText("รวมจำนวน", reportQuantityText(totals.quantity), width),
    printer
  );
  pushEscPosLine(
    bytes,
    twoColumnReceiptText("รวมยอดขาย", receiptMoneyText(totals.sales), width),
    printer
  );
  pushEscPosLine(bytes, line, printer);
  bytes.push(0x1b, 0x61, 1, 0x1b, 0x45, 1);
  pushEscPosLine(bytes, centerReceiptText("รายงานจาก Eden POS", width), printer);
  bytes.push(0x1b, 0x45, 0, 0x1b, 0x61, 0, 10, 10, 10, 0x1d, 0x56, 0x42, 0x00);

  return new Uint8Array(bytes);
};

const receiptToPrintableOrder = (receipt: Receipt): PrintableOrder => {
  const store = loadPosData().store;

  return {
    receiptNo: receipt.number,
    logoDataUrl: store.printLogoDataUrl,
    ...receiptSlipTextFromStore(store),
    date: new Intl.DateTimeFormat("th-TH", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(receiptReportDateTime(receipt))),
    cashierName: "Eden POS",
    paymentMethod: receipt.paymentMethod,
    paymentLabel: receipt.paymentLabel || paymentMethodLabel(receipt.paymentMethod),
    items: receipt.items.map((item) => ({
      name: item.name,
      variantName: item.variantName,
      quantity: item.quantity,
      lineTotal:
        item.unitPrice * item.quantity - Math.max(item.lineDiscount ?? 0, 0),
      note: item.note
    })),
    refunds: receiptRefunds(receipt).map((refund) => ({
      refundNo: refund.refundNo,
      createdAt: new Intl.DateTimeFormat("th-TH", {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(refund.createdAt)),
      reason: refund.reason,
      approvedByName: refund.approvedByName,
      amount: refund.amount,
      lines: refund.lines.map((line) => ({
        name: line.name,
        variantName: line.variantName,
        quantity: line.quantity,
        amount: line.netAmount
      }))
    })),
    subtotal: receipt.subtotal,
    discount: receiptNetDiscount(receipt),
    taxIncluded: receiptNetTaxIncluded(receipt),
    originalTotalAmount: receipt.totalAmount ?? receipt.total,
    refundedAmount: receiptTotalRefunded(receipt),
    totalAmount: receiptNetTotal(receipt),
    paidAmount: receipt.paidAmount ?? receipt.paid,
    changeAmount: receipt.changeAmount ?? receipt.change,
    customerName: receipt.customerName,
    phone: receipt.phone,
    paymentStatus: receipt.paymentStatus
  };
};

const buildPosPrinterTestOrder = (): PrintableOrder => {
  const store = loadPosData().store;
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");
  const timePart = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0")
  ].join("");

  return {
    receiptNo: `TEST-${datePart}-${timePart}`,
    logoDataUrl: store.printLogoDataUrl,
    ...receiptSlipTextFromStore(store),
    date: now.toLocaleString("th-TH"),
    cashierName: "Eden POS",
    paymentMethod: "cash",
    paymentLabel: "Cash",
    items: [{ name: "Eden POS test print", quantity: 1, lineTotal: 1 }],
    subtotal: 1,
    discount: 0,
    taxIncluded: 0,
    totalAmount: 1,
    paidAmount: 1,
    changeAmount: 0,
    customerName: "Test Customer",
    phone: "",
    isTestOrder: true,
    paymentStatus: "paid"
  };
};

const receiptToPrintableTicket = (
  receipt: Receipt,
  printer: PosPrinterProfile,
  items: OrderTicketItem[],
  title = "ORDER TICKET"
): PrintableTicket => ({
  receiptNo: receipt.number,
  title,
  date: new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(receiptOpenedAtValue(receipt))),
  printerName: printer.name,
  groupLabel:
    printer.printerGroups
      .map((group) =>
        printerGroupOptions.find((option) => option.id === group)?.label ?? group
      )
      .join(" / ") || "Order ticket",
  customerName: receipt.customerName,
  phone: receipt.phone,
  tableId: receipt.tableId,
  tableNumber: receipt.tableNumber,
  tableName: receipt.tableName,
  tableZone: receipt.tableZone,
  items
});

const orderTicketLineKey = (
  item: Pick<
    CartLine,
    "productId" | "variantId" | "category" | "name" | "variantName" | "note"
  >
) =>
  [
    item.productId,
    item.variantId || "base",
    cleanReceiptText(item.category),
    cleanReceiptText(item.name),
    cleanReceiptText(item.variantName),
    cleanReceiptText(item.note)
  ].join("::");

const aggregateOrderTicketLines = (items: CartLine[]) => {
  const grouped = new Map<
    string,
    {
      line: CartLine;
      quantity: number;
    }
  >();

  items.forEach((item) => {
    const key = orderTicketLineKey(item);
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity += item.quantity;
      return;
    }

    grouped.set(key, {
      line: { ...item },
      quantity: item.quantity
    });
  });

  return grouped;
};

export const orderTicketPrintedSnapshot = (
  receipt: Receipt,
  updatedAt = new Date().toISOString()
): OrderTicketPrintedItem[] =>
  Array.from(aggregateOrderTicketLines(receipt.items).entries()).map(
    ([key, { line, quantity }]) => ({
      key,
      quantity,
      name: line.name,
      variantName: line.variantName,
      category: line.category,
      note: line.note,
      updatedAt
    })
  );

const unprintedReceiptItems = (receipt: Receipt): CartLine[] => {
  const printedQuantities = new Map(
    (receipt.orderTicketPrintedItems ?? []).map((item) => [
      item.key,
      Math.max(0, Number(item.quantity) || 0)
    ])
  );

  return Array.from(aggregateOrderTicketLines(receipt.items).entries())
    .map(([key, { line, quantity }]) => {
      const printedQuantity = printedQuantities.get(key) ?? 0;
      const unprintedQuantity = quantity - printedQuantity;
      return unprintedQuantity > 0
        ? { ...line, quantity: unprintedQuantity }
        : null;
    })
    .filter((item): item is CartLine => Boolean(item));
};

const groupOrderTicketItems = (
  items: OrderTicketItem[],
  groupIdenticalItems: boolean
) => {
  if (!groupIdenticalItems) return items;

  const grouped = new Map<string, OrderTicketItem>();
  items.forEach((item) => {
    const key = [
      item.name,
      item.variantName || "",
      item.category,
      item.note || ""
    ].join("::");
    const existing = grouped.get(key);
    if (existing) {
      grouped.set(key, {
        ...existing,
        quantity: existing.quantity + item.quantity
      });
      return;
    }

    grouped.set(key, { ...item });
  });

  return Array.from(grouped.values());
};

const receiptItemsForPrinter = (
  receipt: Receipt,
  printer: PosPrinterProfile,
  sourceItems: CartLine[] = receipt.items
) => {
  const categories = new Set(printer.categoryFilters);
  const items = sourceItems
    .filter((item) => categories.size === 0 || categories.has(item.category))
    .map((item) => ({
      name: item.name,
      variantName: item.variantName,
      category: item.category,
      quantity: item.quantity,
      note: item.note
    }));

  return groupOrderTicketItems(items, printer.groupIdenticalItems);
};

const buildEscPosOrderTicketBytes = (
  ticket: PrintableTicket,
  printer: Partial<PosPrinterProfile> = {}
) => {
  const customerLabel = orderTicketCustomerLabel(ticket);
  const tableLabel = orderTicketTableLabel(ticket);

  if (
    printer.codepage === "thai-raster" ||
    printer.codepage === "thai42" ||
    printer.codepage === "cp874"
  ) {
    const raster = buildRasterEscPosBytes(
      [
        {
          kind: "text",
          text: ticket.title || "ORDER TICKET",
          align: "center",
          size: orderTicketFontSize(30),
          bold: true
        },
        {
          kind: "text",
          text: ticket.groupLabel || ticket.printerName,
          align: "center",
          size: orderTicketFontSize(26),
          bold: true
        },
        { kind: "rule" },
        ...(tableLabel
          ? [
              {
                kind: "text" as const,
                text: `Table: ${tableLabel}`,
                size: orderTicketFontSize(26),
                bold: true
              }
            ]
          : []),
        ...(customerLabel
          ? [
              {
                kind: "text" as const,
                text: `Customer: ${customerLabel}`,
                size: orderTicketFontSize(24),
                bold: true
              }
            ]
          : []),
        {
          kind: "text",
          text: `Receipt: ${ticket.receiptNo || "-"}`,
          size: orderTicketFontSize(24)
        },
        {
          kind: "text",
          text: `Time: ${ticket.date || new Date().toLocaleString("th-TH")}`,
          size: orderTicketFontSize(24)
        },
        { kind: "rule" },
        ...ticket.items.flatMap((item) => [
          {
            kind: "text" as const,
            text: `${item.quantity} x ${item.name}${item.variantName ? ` / ${item.variantName}` : ""}`,
            size: orderTicketFontSize(26),
            bold: true
          },
          {
            kind: "text" as const,
            text: item.category,
            size: orderTicketFontSize(22)
          },
          ...(item.note
            ? [
                {
                  kind: "text" as const,
                  text: `note: ${item.note}`,
                  size: orderTicketFontSize(22)
                }
              ]
            : []),
          { kind: "space" as const, height: 12 }
        ]),
        {
          kind: "text",
          text: ticket.printerName,
          align: "right",
          size: orderTicketFontSize(23)
        }
      ],
      printer
    );
    if (raster) return raster;
  }

  const width = receiptLineWidth(printer);
  const bytes: number[] = [];
  const line = "-".repeat(width);

  bytes.push(0x1b, 0x40);
  if (printer.codepage === "thai42" || printer.codepage === "cp874") {
    bytes.push(0x1b, 0x74, 20);
  }
  bytes.push(0x1b, 0x61, 1, 0x1b, 0x45, 1, 0x1d, 0x21, 0x11);
  pushEscPosLine(bytes, ticket.title || "ORDER TICKET", printer);
  bytes.push(0x1b, 0x45, 0, 0x1d, 0x21, 0x00);
  pushEscPosLine(bytes, ticket.groupLabel || ticket.printerName, printer);
  bytes.push(0x1b, 0x61, 0);
  pushEscPosLine(bytes, line, printer);
  if (tableLabel) {
    bytes.push(0x1d, 0x21, 0x10, 0x1b, 0x45, 1);
    wrapReceiptText(`Table: ${tableLabel}`, width).forEach((lineText) =>
      pushEscPosLine(bytes, lineText, printer)
    );
    bytes.push(0x1b, 0x45, 0, 0x1d, 0x21, 0x00);
  }
  if (customerLabel) {
    bytes.push(0x1d, 0x21, 0x10, 0x1b, 0x45, 1);
    wrapReceiptText(`Customer: ${customerLabel}`, width).forEach((lineText) =>
      pushEscPosLine(bytes, lineText, printer)
    );
    bytes.push(0x1b, 0x45, 0, 0x1d, 0x21, 0x00);
  }
  pushEscPosLine(bytes, `Receipt: ${ticket.receiptNo || "-"}`, printer);
  pushEscPosLine(bytes, `Time: ${ticket.date || new Date().toLocaleString("th-TH")}`, printer);
  pushEscPosLine(bytes, line, printer);

  bytes.push(0x1d, 0x21, 0x10, 0x1b, 0x45, 1);
  ticket.items.forEach((item) => {
    const name = cleanReceiptText(
      `${item.quantity} x ${item.name}${item.variantName ? ` / ${item.variantName}` : ""}`
    );
    wrapReceiptText(name, width).forEach((lineText) =>
      pushEscPosLine(bytes, lineText, printer)
    );
    pushEscPosLine(bytes, `  ${item.category}`, printer);
    if (item.note) {
      wrapReceiptText(`  note: ${item.note}`, width).forEach((noteLine) =>
        pushEscPosLine(bytes, noteLine, printer)
      );
    }
    pushEscPosLine(bytes, "", printer);
  });
  bytes.push(0x1b, 0x45, 0, 0x1d, 0x21, 0x00);

  bytes.push(0x1b, 0x61, 1);
  pushEscPosLine(bytes, centerReceiptText(ticket.printerName, width), printer);
  bytes.push(0x1b, 0x61, 0, 10, 10, 10, 0x1d, 0x56, 0x42, 0x00);

  return new Uint8Array(bytes);
};

export const buildEscPosReceiptBytes = (
  order: PrintableOrder,
  printer: Partial<PosPrinterProfile> = {}
) => {
  if (
    printer.codepage === "thai-raster" ||
    printer.codepage === "thai42" ||
    printer.codepage === "cp874"
  ) {
    const statusText =
      order.paymentStatus === "pending" ? "Pending Bill" : "POS Receipt";
    const documentTitle = order.isTestOrder
      ? "POS Receipt (TEST)"
      : order.receiptTitle || statusText;
    const headerRasterLines: RasterLine[] = receiptHeaderLines(order).map(
      (line, index) => ({
        kind: "text" as const,
        text: line,
        align: "center" as const,
        size: index === 0 ? 30 : 23,
        bold: index === 0
      })
    );
    const footerRasterLines: RasterLine[] = receiptFooterLines(order).map(
      (line) => ({
        kind: "text" as const,
        text: line,
        align: "center" as const,
        size: 22
      })
    );
    const itemLines: RasterLine[] = order.items.flatMap((item) => {
      const quantity = safeNumber(item.quantity, 1);
      const name = `${item.name || "Item"}${item.variantName ? ` / ${item.variantName}` : ""} x${quantity}`;
      const rows: RasterLine[] = [
        {
          kind: "two-column",
          left: name,
          right: receiptMoneyText(item.lineTotal),
          size: 24,
          bold: true
        }
      ];
      if (item.note) {
        rows.push({ kind: "text", text: `- ${item.note}`, size: 22 });
      }
      return rows;
    });
    const refundLines: RasterLine[] = (order.refunds ?? []).flatMap((refund) => [
      { kind: "rule" as const },
      {
        kind: "text" as const,
        text: `Refund ${refund.refundNo}`,
        size: 23,
        bold: true
      },
      ...refund.lines.map((line) => ({
        kind: "two-column" as const,
        left: `-${line.name}${line.variantName ? ` / ${line.variantName}` : ""} x${line.quantity}`,
        right: `-${receiptMoneyText(line.amount)}`,
        size: 22
      })),
      {
        kind: "text" as const,
        text: `Reason: ${refund.reason}`,
        size: 21
      },
      {
        kind: "text" as const,
        text: `Approved: ${refund.approvedByName}`,
        size: 21
      }
    ]);
    const raster = buildRasterEscPosBytes(
      [
        ...headerRasterLines,
        {
          kind: "text",
          text: documentTitle,
          align: "center",
          size: 23,
          bold: true
        },
        { kind: "rule" },
        { kind: "text", text: `Receipt: ${order.receiptNo || "-"}`, size: 23 },
        {
          kind: "text",
          text: `Time: ${order.date || new Date().toLocaleString("th-TH")}`,
          size: 23
        },
        { kind: "text", text: `Cashier: ${order.cashierName || "-"}`, size: 23 },
        ...(order.customerName || order.phone
          ? [
              {
                kind: "text" as const,
                text: `Customer: ${[order.customerName, order.phone]
                  .filter(Boolean)
                  .join(" / ")}`,
                size: 23
              }
            ]
          : []),
        { kind: "rule" },
        ...itemLines,
        { kind: "rule" },
        {
          kind: "two-column",
          left: "Subtotal",
          right: receiptMoneyText(order.subtotal),
          size: 23
        },
        {
          kind: "two-column",
          left: "Discount",
          right: `-${receiptMoneyText(order.discount)}`,
          size: 23
        },
        {
          kind: "two-column",
          left: "VAT included",
          right: receiptMoneyText(order.taxIncluded),
          size: 23
        },
        ...refundLines,
        ...(safeNumber(order.refundedAmount, 0) > 0
          ? [
              {
                kind: "two-column" as const,
                left: "Original total",
                right: receiptMoneyText(order.originalTotalAmount),
                size: 23
              },
              {
                kind: "two-column" as const,
                left: "Refund total",
                right: `-${receiptMoneyText(order.refundedAmount)}`,
                size: 23,
                bold: true
              }
            ]
          : []),
        {
          kind: "two-column",
          left: "Total",
          right: receiptMoneyText(order.totalAmount),
          size: 28,
          bold: true
        },
        {
          kind: "two-column",
          left: "Payment",
          right: order.paymentLabel || "-",
          size: 23
        },
        {
          kind: "two-column",
          left: "Paid",
          right: receiptMoneyText(order.paidAmount),
          size: 23
        },
        {
          kind: "two-column",
          left: "Change",
          right: receiptMoneyText(order.changeAmount),
          size: 23
        },
        { kind: "rule" },
        ...(order.receiptFooterTaxNote
          ? [
              {
                kind: "text" as const,
                text: order.receiptFooterTaxNote,
                align: "center" as const,
                size: 22,
                bold: true
              }
            ]
          : []),
        ...footerRasterLines
      ],
      printer
    );
    if (raster) return raster;
  }

  const width = receiptLineWidth(printer);
  const bytes: number[] = [];
  const line = "-".repeat(width);
  const statusText =
    order.paymentStatus === "pending" ? "Pending Bill" : "POS Receipt";
  const documentTitle = order.isTestOrder
    ? "POS Receipt (TEST)"
    : order.receiptTitle || statusText;
  const headerLines = receiptHeaderLines(order);
  const footerLines = receiptFooterLines(order);

  bytes.push(0x1b, 0x40);
  if (printer.codepage === "thai42" || printer.codepage === "cp874") {
    bytes.push(0x1b, 0x74, 20);
  }

  bytes.push(0x1b, 0x61, 1, 0x1b, 0x45, 1);
  headerLines.forEach((headerLine, index) => {
    if (index === 1) bytes.push(0x1b, 0x45, 0);
    pushEscPosLine(bytes, centerReceiptText(headerLine, width), printer);
  });
  if (!headerLines.length) {
    pushEscPosLine(bytes, centerReceiptText("Eden Cafe", width), printer);
  }
  bytes.push(0x1b, 0x45, 0);
  pushEscPosLine(bytes, centerReceiptText(documentTitle, width), printer);
  bytes.push(0x1b, 0x61, 0);
  pushEscPosLine(bytes, line, printer);
  pushEscPosLine(bytes, `Receipt: ${order.receiptNo || "-"}`, printer);
  pushEscPosLine(bytes, `Time: ${order.date || new Date().toLocaleString("th-TH")}`, printer);
  pushEscPosLine(bytes, `Cashier: ${order.cashierName || "-"}`, printer);
  if (order.customerName || order.phone) {
    pushEscPosLine(
      bytes,
      `Customer: ${[order.customerName, order.phone].filter(Boolean).join(" / ")}`,
      printer
    );
  }
  pushEscPosLine(bytes, line, printer);

  order.items.forEach((item) => {
    const quantity = safeNumber(item.quantity, 1);
    const name = cleanReceiptText(
      `${item.name || "Item"}${item.variantName ? ` / ${item.variantName}` : ""} x${quantity}`
    );
    const amount = receiptMoneyText(item.lineTotal);
    const itemLines = wrapReceiptText(name, Math.max(12, width - amount.length - 1));
    pushEscPosLine(bytes, twoColumnReceiptText(itemLines[0], amount, width), printer);
    itemLines.slice(1).forEach((extra) => pushEscPosLine(bytes, extra, printer));
    if (item.note) {
      wrapReceiptText(`- ${item.note}`, width).forEach((noteLine) =>
        pushEscPosLine(bytes, noteLine, printer)
      );
    }
  });

  pushEscPosLine(bytes, line, printer);
  pushEscPosLine(bytes, twoColumnReceiptText("Subtotal", receiptMoneyText(order.subtotal), width), printer);
  pushEscPosLine(bytes, twoColumnReceiptText("Discount", `-${receiptMoneyText(order.discount)}`, width), printer);
  pushEscPosLine(bytes, twoColumnReceiptText("VAT included", receiptMoneyText(order.taxIncluded), width), printer);
  (order.refunds ?? []).forEach((refund) => {
    pushEscPosLine(bytes, line, printer);
    pushEscPosLine(bytes, `Refund ${refund.refundNo}`, printer);
    refund.lines.forEach((refundLine) => {
      const name = `-${refundLine.name}${refundLine.variantName ? ` / ${refundLine.variantName}` : ""} x${refundLine.quantity}`;
      const amount = `-${receiptMoneyText(refundLine.amount)}`;
      wrapReceiptText(name, Math.max(12, width - amount.length - 1)).forEach(
        (lineText, index) =>
          pushEscPosLine(
            bytes,
            index === 0 ? twoColumnReceiptText(lineText, amount, width) : lineText,
            printer
          )
      );
    });
    pushEscPosLine(bytes, `Reason: ${refund.reason}`, printer);
    pushEscPosLine(bytes, `Approved: ${refund.approvedByName}`, printer);
  });
  if (safeNumber(order.refundedAmount, 0) > 0) {
    pushEscPosLine(bytes, twoColumnReceiptText("Original total", receiptMoneyText(order.originalTotalAmount), width), printer);
    pushEscPosLine(bytes, twoColumnReceiptText("Refund total", `-${receiptMoneyText(order.refundedAmount)}`, width), printer);
  }
  bytes.push(0x1b, 0x45, 1);
  pushEscPosLine(bytes, twoColumnReceiptText("Total", receiptMoneyText(order.totalAmount), width), printer);
  bytes.push(0x1b, 0x45, 0);
  pushEscPosLine(bytes, twoColumnReceiptText("Payment", order.paymentLabel || "-", width), printer);
  pushEscPosLine(bytes, twoColumnReceiptText("Paid", receiptMoneyText(order.paidAmount), width), printer);
  pushEscPosLine(bytes, twoColumnReceiptText("Change", receiptMoneyText(order.changeAmount), width), printer);
  pushEscPosLine(bytes, line, printer);
  bytes.push(0x1b, 0x61, 1);
  if (order.receiptFooterTaxNote) {
    bytes.push(0x1b, 0x45, 1);
    pushEscPosLine(bytes, centerReceiptText(order.receiptFooterTaxNote, width), printer);
    bytes.push(0x1b, 0x45, 0);
  }
  footerLines.forEach((footerLine) =>
    pushEscPosLine(bytes, centerReceiptText(footerLine, width), printer)
  );
  bytes.push(0x1b, 0x61, 0, 10, 10, 10, 0x1d, 0x56, 0x42, 0x00);

  return new Uint8Array(bytes);
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return window.btoa(binary);
};

const canUseBrowserPrintFallback = () => !Capacitor.isNativePlatform();

const hasUnconfiguredBridgePrinter = (printer: PosPrinterProfile | null) =>
  printer?.connection === "bridge-network" && !printer.host.trim();

const parseUsbVendorId = (value: string) => {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;

  const number = text.startsWith("0x")
    ? Number.parseInt(text.slice(2), 16)
    : Number.parseInt(text, 10);
  return Number.isFinite(number) ? number : null;
};

const printViaBridgeNetwork = async (
  printer: PosPrinterProfile,
  bytes: Uint8Array
) => {
  if (!printer.host.trim()) {
    throw new Error("กรุณาใส่ IP เครื่องพิมพ์ LAN ก่อน");
  }

  const endpoint = normalizeBridgeEndpoint(printer.endpoint);
  const response = await fetch(`${endpoint}/print/network`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      host: printer.host,
      port: printer.port || 9100,
      payloadBase64: bytesToBase64(bytes)
    })
  });
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Bridge print failed");
  }

  return data;
};

const printViaBrowserSerial = async (
  printer: PosPrinterProfile,
  bytes: Uint8Array
) => {
  const printerNavigator = navigator as PrinterNavigator;
  if (!printerNavigator.serial) {
    throw new Error("Web Serial ไม่พร้อมใช้งานบน browser นี้");
  }

  const port = runtime.serialPort || (await printerNavigator.serial.requestPort());
  runtime.serialPort = port;

  if (!port.writable) {
    await port.open({ baudRate: Math.max(1200, safeNumber(printer.baudRate, 9600)) });
  }

  const writer = port.writable?.getWriter();
  if (!writer) {
    throw new Error("ไม่สามารถเปิด serial writer ได้");
  }

  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }

  try {
    await port.close();
  } catch (error) {
    console.warn("Serial close skipped", error);
  }
  runtime.serialPort = null;
};

const printViaBrowserUsb = async (
  printer: PosPrinterProfile,
  bytes: Uint8Array
) => {
  if (Capacitor.isNativePlatform()) {
    const vendorId = String(printer.vendorId || "").trim();
    const productId = String(printer.productId || "").trim();
    const hasStableUsbId = Boolean(vendorId || productId);

    return NativeUsbEscPosPrinter.print({
      payloadBase64: bytesToBase64(bytes),
      vendorId,
      productId,
      deviceName: hasStableUsbId ? "" : printer.deviceName,
      interfaceNumber: String(printer.interfaceNumber),
      endpointNumber: String(printer.endpointNumber)
    });
  }

  const printerNavigator = navigator as PrinterNavigator;
  if (!printerNavigator.usb) {
    throw new Error("WebUSB ไม่พร้อมใช้งานบน browser นี้");
  }

  const vendorId = parseUsbVendorId(printer.vendorId);
  if (!vendorId) {
    throw new Error("กรุณาใส่ USB Vendor ID ก่อน");
  }

  const device = await printerNavigator.usb.requestDevice({
    filters: [{ vendorId }]
  });
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);

  await device.claimInterface(printer.interfaceNumber);
  await device.transferOut(printer.endpointNumber, bytes);

  try {
    await device.releaseInterface(printer.interfaceNumber);
  } catch (error) {
    console.warn("USB release skipped", error);
  }
  try {
    await device.close();
  } catch (error) {
    console.warn("USB close skipped", error);
  }
};

const printViaBluetoothBle = async (
  printer: PosPrinterProfile,
  bytes: Uint8Array
) => {
  if (Capacitor.isNativePlatform()) {
    return NativeBluetoothEscPosPrinter.print({
      payloadBase64: bytesToBase64(bytes),
      address: printer.bluetoothAddress,
      name: printer.bluetoothName,
      uuid:
        printer.serviceUuid && printer.serviceUuid !== POS_PRINTER_DEFAULT_BLE_SERVICE
          ? printer.serviceUuid
          : POS_PRINTER_DEFAULT_BT_SPP_UUID
    });
  }

  const printerNavigator = navigator as PrinterNavigator;
  if (!printerNavigator.bluetooth) {
    throw new Error("Web Bluetooth ไม่พร้อมใช้งานบน browser นี้");
  }

  const serviceUuid = printer.serviceUuid || POS_PRINTER_DEFAULT_BLE_SERVICE;
  const characteristicUuid =
    printer.characteristicUuid || POS_PRINTER_DEFAULT_BLE_CHARACTERISTIC;
  const device = await printerNavigator.bluetooth.requestDevice({
    filters: [{ services: [serviceUuid] }],
    optionalServices: [serviceUuid]
  });
  const server = await device.gatt?.connect();
  const service = await server?.getPrimaryService(serviceUuid);
  const characteristic = await service?.getCharacteristic(characteristicUuid);

  if (!characteristic) {
    throw new Error("ไม่พบ Bluetooth characteristic สำหรับพิมพ์");
  }

  for (let offset = 0; offset < bytes.length; offset += 180) {
    await characteristic.writeValue(bytes.slice(offset, offset + 180));
  }

  if (device.gatt?.connected) {
    device.gatt.disconnect();
  }
};

const printEscPosBytes = async (
  printer: PosPrinterProfile,
  bytes: Uint8Array
) => {
  if (printer.connection === "bridge-network") {
    return printViaBridgeNetwork(printer, bytes);
  }
  if (printer.connection === "browser-serial") {
    return printViaBrowserSerial(printer, bytes);
  }
  if (printer.connection === "browser-usb") {
    return printViaBrowserUsb(printer, bytes);
  }
  if (printer.connection === "browser-bluetooth") {
    return printViaBluetoothBle(printer, bytes);
  }

  throw new Error("โปรไฟล์นี้ใช้ browser print fallback");
};

const openReceiptPrintWindow = (order: PrintableOrder) => {
  const printWindow = window.open("", "_blank", "width=420,height=720");
  if (!printWindow) {
    throw new Error("เปิดหน้าพิมพ์ไม่ได้ กรุณาอนุญาต popup หรือใช้ Print Bridge");
  }

  const itemRows = order.items
    .map(
      (item) => `
        <tr>
          <td>
            ${cleanReceiptText(item.name)}
            ${item.variantName ? `<small>${cleanReceiptText(item.variantName)}</small>` : ""}
            ${item.note ? `<small>${cleanReceiptText(item.note)}</small>` : ""}
          </td>
          <td>x${item.quantity}</td>
          <td>${receiptMoneyText(item.lineTotal)}</td>
        </tr>
      `
    )
    .join("");

  const refundRows = (order.refunds ?? [])
    .map(
      (refund) => `
        <article class="refund-entry">
          <strong>Refund ${cleanReceiptText(refund.refundNo)} · -${receiptMoneyText(refund.amount)}</strong>
          <small>${cleanReceiptText(refund.createdAt)} · ${cleanReceiptText(refund.reason)}</small>
          ${refund.lines
            .map(
              (line) => `
                <div class="line refund-line">
                  <span>-${cleanReceiptText(line.name)}${line.variantName ? ` / ${cleanReceiptText(line.variantName)}` : ""} x${line.quantity}</span>
                  <span>-${receiptMoneyText(line.amount)}</span>
                </div>
              `
            )
            .join("")}
          <small>Approved by ${cleanReceiptText(refund.approvedByName)}</small>
        </article>
      `
    )
    .join("");

  const refundSummaryRows =
    safeNumber(order.refundedAmount, 0) > 0
      ? `
        <div class="line"><span>Original total</span><span>${receiptMoneyText(order.originalTotalAmount ?? order.totalAmount)}</span></div>
        <div class="line"><span>Refund total</span><span>-${receiptMoneyText(order.refundedAmount)}</span></div>
      `
      : "";
  const documentTitle = order.isTestOrder
    ? "POS Receipt (TEST)"
    : order.receiptTitle ||
      (order.paymentStatus === "pending" ? "Pending Bill" : "POS Receipt");
  const headerHtml = receiptHeaderLines(order)
    .map(
      (line, index) =>
        `<div class="${index === 0 ? "strong" : ""}">${escapeReceiptHtml(line)}</div>`
    )
    .join("");
  const footerTaxHtml = order.receiptFooterTaxNote
    ? `<strong>${escapeReceiptHtml(order.receiptFooterTaxNote)}</strong>`
    : "";
  const footerHtml = receiptFooterLines(order)
    .map((line) => `<span>${escapeReceiptHtml(line)}</span>`)
    .join("");

  printWindow.document.write(`
    <!doctype html>
    <html lang="th">
      <head>
        <meta charset="utf-8" />
        <title>${escapeReceiptHtml(order.receiptNo)}</title>
        <style>
          body { color: #222; font-family: "Noto Sans Thai", "Segoe UI", sans-serif; margin: 0; padding: 16px; }
          .receipt { margin: 0 auto; max-width: 320px; }
          .receipt-logo { display: block; margin: 0 auto 8px; max-height: 72px; max-width: 210px; object-fit: contain; }
          .receipt-head { font-size: 12px; line-height: 1.4; margin-bottom: 8px; text-align: center; }
          .receipt-head .strong { font-size: 20px; font-weight: 800; }
          h2 { font-size: 14px; margin: 4px 0 14px; text-align: center; }
          .meta, .totals { border-top: 1px dashed #aaa; margin-top: 10px; padding-top: 10px; }
          .line { display: flex; justify-content: space-between; gap: 12px; }
          table { border-collapse: collapse; margin-top: 10px; width: 100%; }
          td { border-bottom: 1px dashed #ddd; padding: 5px 0; vertical-align: top; }
          td:nth-child(2), td:nth-child(3) { text-align: right; white-space: nowrap; }
          small { color: #666; display: block; font-size: 11px; }
          .refunds { border-top: 1px dashed #aaa; margin-top: 10px; padding-top: 10px; }
          .refund-entry { display: grid; gap: 4px; margin-bottom: 8px; }
          .refund-line { font-size: 12px; }
          .total { font-size: 18px; font-weight: 800; }
          .thanks { border-top: 1px dashed #aaa; display: grid; gap: 3px; margin-top: 12px; padding-top: 12px; text-align: center; }
          .thanks span { display: block; }
          @media print { body { margin: 0; } }
        </style>
      </head>
      <body>
        <main class="receipt">
          ${order.logoDataUrl ? `<img class="receipt-logo" alt="Eden Cafe" src="${order.logoDataUrl}" />` : ""}
          <section class="receipt-head">${headerHtml}</section>
          <h2>${escapeReceiptHtml(documentTitle)}</h2>
          <section class="meta">
            <div class="line"><span>เลขที่</span><strong>${cleanReceiptText(order.receiptNo)}</strong></div>
            <div class="line"><span>เวลา</span><span>${cleanReceiptText(order.date)}</span></div>
            <div class="line"><span>ลูกค้า</span><span>${cleanReceiptText(order.customerName || "Walk-in Customer")}</span></div>
          </section>
          <table>${itemRows}</table>
          ${refundRows ? `<section class="refunds">${refundRows}</section>` : ""}
          <section class="totals">
            <div class="line"><span>ยอดก่อนส่วนลด</span><span>${receiptMoneyText(order.subtotal)}</span></div>
            <div class="line"><span>ส่วนลด</span><span>-${receiptMoneyText(order.discount)}</span></div>
            <div class="line"><span>VAT รวมในราคา</span><span>${receiptMoneyText(order.taxIncluded)}</span></div>
            ${refundSummaryRows}
            <div class="line total"><span>รวม</span><span>${receiptMoneyText(order.totalAmount)}</span></div>
            <div class="line"><span>ชำระ</span><span>${cleanReceiptText(order.paymentLabel)}</span></div>
            <div class="line"><span>รับเงิน</span><span>${receiptMoneyText(order.paidAmount)}</span></div>
            <div class="line"><span>ทอน</span><span>${receiptMoneyText(order.changeAmount)}</span></div>
          </section>
          <div class="thanks">${footerTaxHtml}${footerHtml}</div>
        </main>
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
  return true;
};

const openTicketPrintWindow = (ticket: PrintableTicket) => {
  const printWindow = window.open("", "_blank", "width=420,height=720");
  if (!printWindow) {
    throw new Error("เปิดหน้าพิมพ์ไม่ได้ กรุณาอนุญาต popup หรือใช้ Print Bridge");
  }

  const customerLabel = orderTicketCustomerLabel(ticket);
  const tableLabel = orderTicketTableLabel(ticket);
  const itemRows = ticket.items
    .map(
      (item) => `
        <li>
          <strong>${item.quantity} x ${cleanReceiptText(item.name)}</strong>
          ${item.variantName ? `<span>${cleanReceiptText(item.variantName)}</span>` : ""}
          <small>${cleanReceiptText(item.category)}</small>
          ${item.note ? `<small>note: ${cleanReceiptText(item.note)}</small>` : ""}
        </li>
      `
    )
    .join("");

  printWindow.document.write(`
    <!doctype html>
    <html lang="th">
      <head>
        <meta charset="utf-8" />
        <title>${ticket.receiptNo} - ${ticket.printerName}</title>
        <style>
          body { color: #222; font-family: "Noto Sans Thai", "Segoe UI", sans-serif; margin: 0; padding: 16px; }
          .ticket { margin: 0 auto; max-width: 320px; }
          h1 { font-size: 36px; margin: 0; text-align: center; }
          h2 { font-size: 23px; margin: 3px 0 14px; text-align: center; }
          .meta { border-top: 1px dashed #aaa; border-bottom: 1px dashed #aaa; padding: 10px 0; }
          .line { display: flex; font-size: 21px; justify-content: space-between; gap: 12px; }
          .line.highlight { font-size: 24px; font-weight: 800; }
          ul { list-style: none; margin: 12px 0; padding: 0; }
          li { border-bottom: 1px dashed #ddd; padding: 8px 0; }
          li strong { font-size: 24px; }
          span, small { color: #666; display: block; font-size: 18px; }
          .foot { border-top: 1px dashed #aaa; font-size: 21px; padding-top: 10px; text-align: center; }
          @media print { body { margin: 0; } }
        </style>
      </head>
      <body>
        <main class="ticket">
          <h1>${escapeReceiptHtml(ticket.title || "ORDER TICKET")}</h1>
          <h2>${cleanReceiptText(ticket.groupLabel || ticket.printerName)}</h2>
          <section class="meta">
            ${tableLabel ? `<div class="line highlight"><span>Table</span><strong>${escapeReceiptHtml(tableLabel)}</strong></div>` : ""}
            ${customerLabel ? `<div class="line highlight"><span>Customer</span><strong>${escapeReceiptHtml(customerLabel)}</strong></div>` : ""}
            <div class="line"><span>เลขที่</span><strong>${cleanReceiptText(ticket.receiptNo)}</strong></div>
            <div class="line"><span>เวลา</span><span>${cleanReceiptText(ticket.date)}</span></div>
          </section>
          <ul>${itemRows}</ul>
          <div class="foot">${cleanReceiptText(ticket.printerName)}</div>
        </main>
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
  return true;
};

const openSalesSummaryByCategoryReportPrintWindow = (
  input: SalesSummaryByCategoryReportInput
) => {
  const printWindow = window.open("", "_blank", "width=420,height=720");
  if (!printWindow) {
    throw new Error("เปิดหน้าพิมพ์ไม่ได้ กรุณาอนุญาต popup หรือใช้ Print Bridge");
  }

  const rows = normalizedSalesSummaryRows(input);
  const totals = salesSummaryTotals(rows);
  const storeName = salesSummaryReportStoreName(input);
  const printedAt = salesSummaryPrintedAtLabel(input.printedAt);
  const categoryRows = rows.length
    ? rows
        .map(
          (row) => `
            <tr>
              <td>${escapeReceiptHtml(row.label)}</td>
              <td>${reportQuantityText(row.quantity)}</td>
              <td>${receiptMoneyText(row.sales)}</td>
            </tr>
          `
        )
        .join("")
    : `<tr><td colspan="3" class="empty">ยังไม่มีข้อมูลในช่วงนี้</td></tr>`;

  printWindow.document.write(`
    <!doctype html>
    <html lang="th">
      <head>
        <meta charset="utf-8" />
        <title>Sales Summary By Category</title>
        <style>
          body { color: #222; font-family: "Noto Sans Thai", "Segoe UI", sans-serif; margin: 0; padding: 16px; }
          .report { margin: 0 auto; max-width: 320px; }
          h1 { font-size: 22px; margin: 0; text-align: center; }
          h2 { font-size: 15px; margin: 4px 0 12px; text-align: center; }
          .meta, .summary, .footer { border-top: 1px dashed #aaa; margin-top: 10px; padding-top: 10px; }
          .line { display: flex; justify-content: space-between; gap: 12px; }
          .line strong { text-align: right; }
          table { border-collapse: collapse; margin-top: 10px; width: 100%; }
          th, td { border-bottom: 1px dashed #ddd; padding: 5px 0; vertical-align: top; }
          th:nth-child(2), th:nth-child(3), td:nth-child(2), td:nth-child(3) { text-align: right; white-space: nowrap; }
          .empty { color: #666; text-align: center; }
          .total { font-size: 16px; font-weight: 800; }
          .footer { text-align: center; }
          @media print { body { margin: 0; } }
        </style>
      </head>
      <body>
        <main class="report">
          <h1>${escapeReceiptHtml(storeName)}</h1>
          <h2>สรุปยอดขายตามหมวดหมู่</h2>
          <section class="meta">
            <div>ช่วงวันที่: ${escapeReceiptHtml(input.rangeLabel)}</div>
            <div>พิมพ์เมื่อ: ${escapeReceiptHtml(printedAt)}</div>
          </section>
          <section class="summary">
            <div class="line"><span>จำนวนใบเสร็จที่ชำระแล้ว</span><strong>${reportQuantityText(input.totals.receiptCount)}</strong></div>
            <div class="line"><span>ยอดขายสุทธิ</span><strong>${receiptMoneyText(input.totals.netSales)}</strong></div>
            <div class="line"><span>คืนเงิน</span><strong>${receiptMoneyText(input.totals.refunds)}</strong></div>
            <div class="line"><span>ส่วนลด</span><strong>${receiptMoneyText(input.totals.discounts)}</strong></div>
            <div class="line"><span>VAT รวมในราคา</span><strong>${receiptMoneyText(input.totals.taxIncluded)}</strong></div>
            <div class="line"><span>ต้นทุนสินค้า</span><strong>${receiptMoneyText(input.totals.cost)}</strong></div>
            <div class="line"><span>กำไรรวม</span><strong>${receiptMoneyText(input.totals.grossProfit)}</strong></div>
          </section>
          <table>
            <thead>
              <tr><th>หมวดหมู่</th><th>จำนวน</th><th>ยอดขาย</th></tr>
            </thead>
            <tbody>${categoryRows}</tbody>
          </table>
          <section class="summary total">
            <div class="line"><span>รวมจำนวน</span><strong>${reportQuantityText(totals.quantity)}</strong></div>
            <div class="line"><span>รวมยอดขาย</span><strong>${receiptMoneyText(totals.sales)}</strong></div>
          </section>
          <div class="footer">รายงานจาก Eden POS</div>
        </main>
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
  return true;
};

const printOrderViaPrinter = async (
  order: PrintableOrder,
  options: { fallback?: boolean; silent?: boolean; profile?: PosPrinterProfile } = {}
) => {
  const settings = loadPosPrinterSettings();
  const printer = options.profile || currentPosPrinter(settings);
  const fallback = options.fallback !== false;
  const explicitProfile = Boolean(options.profile);

  if ((!explicitProfile && !settings.enabled) || !printer || printer.connection === "browser-print") {
    if (fallback && !options.silent && canUseBrowserPrintFallback()) {
      return openReceiptPrintWindow(order);
    }
    if (!printer) {
      throw new Error("ยังไม่ได้เลือกโปรไฟล์เครื่องพิมพ์");
    }
    if (!explicitProfile && !settings.enabled) {
      throw new Error("ยังไม่ได้เปิดใช้ POS printer ในหน้าตั้งค่า");
    }
    if (printer.connection === "browser-print") {
      throw new Error("Browser print ใช้ไม่ได้ใน APK กรุณาเลือก USB / LAN / Bluetooth");
    }
    return false;
  }

  if (!printer.printReceiptsAndBills && options.silent) {
    return false;
  }

  try {
    const bytes = buildEscPosReceiptBytes(order, printer);
    for (let copy = 0; copy < printer.copies; copy += 1) {
      await printEscPosBytes(printer, bytes);
    }
    return true;
  } catch (error) {
    console.warn("POS printer failed", error);
    if (fallback && !options.silent && canUseBrowserPrintFallback()) {
      return openReceiptPrintWindow(order);
    }
    throw error;
  }
};

const printTicketViaPrinter = async (
  ticket: PrintableTicket,
  printer: PosPrinterProfile,
  options: { fallback?: boolean; silent?: boolean } = {}
) => {
  const fallback = options.fallback !== false;

  if (printer.connection === "browser-print") {
    if (fallback && !options.silent && canUseBrowserPrintFallback()) {
      return openTicketPrintWindow(ticket);
    }
    if (!options.silent) {
      throw new Error("Browser print ใช้ไม่ได้ใน APK กรุณาเลือก USB / LAN / Bluetooth");
    }
    return false;
  }

  try {
    const bytes = buildEscPosOrderTicketBytes(ticket, printer);
    for (let copy = 0; copy < printer.copies; copy += 1) {
      await printEscPosBytes(printer, bytes);
    }
    return true;
  } catch (error) {
    console.warn("POS order ticket printer failed", error);
    if (fallback && !options.silent && canUseBrowserPrintFallback()) {
      return openTicketPrintWindow(ticket);
    }
    throw error;
  }
};

export const printPosReceipt = async (
  receipt: Receipt,
  options: { fallback?: boolean; silent?: boolean } = {}
) => printOrderViaPrinter(receiptToPrintableOrder(receipt), options);

export const printPosReceiptToFrontBarPrinter = async (
  receipt: Receipt,
  options: { fallback?: boolean; silent?: boolean } = {}
) =>
  printOrderViaPrinter(receiptToPrintableOrder(receipt), {
    ...options,
    profile: frontBarReceiptPrinter() ?? undefined
  });

export const printSalesSummaryByCategoryReport = async (
  input: SalesSummaryByCategoryReportInput,
  options: { fallback?: boolean; silent?: boolean; profile?: PosPrinterProfile } = {}
) => {
  const settings = loadPosPrinterSettings();
  const printer =
    options.profile || receiptPrinter(settings) || currentPosPrinter(settings);
  const fallback = options.fallback !== false;
  const explicitProfile = Boolean(options.profile);

  if (
    fallback &&
    !options.silent &&
    canUseBrowserPrintFallback() &&
    hasUnconfiguredBridgePrinter(printer)
  ) {
    return openSalesSummaryByCategoryReportPrintWindow(input);
  }

  if ((!explicitProfile && !settings.enabled) || !printer || printer.connection === "browser-print") {
    if (fallback && !options.silent && canUseBrowserPrintFallback()) {
      return openSalesSummaryByCategoryReportPrintWindow(input);
    }
    if (!printer) {
      throw new Error("ยังไม่ได้เลือกโปรไฟล์เครื่องพิมพ์");
    }
    if (!explicitProfile && !settings.enabled) {
      throw new Error("ยังไม่ได้เปิดใช้ POS printer ในหน้าตั้งค่า");
    }
    if (printer.connection === "browser-print") {
      throw new Error("Browser print ใช้ไม่ได้ใน APK กรุณาเลือก USB / LAN / Bluetooth");
    }
    return false;
  }

  if (!printer.printReceiptsAndBills && options.silent) {
    return false;
  }

  try {
    const bytes = buildEscPosSalesSummaryByCategoryReportBytes(input, printer);
    for (let copy = 0; copy < printer.copies; copy += 1) {
      await printEscPosBytes(printer, bytes);
    }
    return true;
  } catch (error) {
    console.warn("POS sales summary report printer failed", error);
    if (fallback && !options.silent && canUseBrowserPrintFallback()) {
      return openSalesSummaryByCategoryReportPrintWindow(input);
    }
    throw error;
  }
};

export const printPaidReceiptFromConfiguredTemplate = async (
  receipt: Receipt,
  options: { fallback?: boolean; silent?: boolean } = {}
) => {
  if (receipt.paymentStatus !== "paid") {
    return false;
  }

  return printPosReceipt(receipt, {
    fallback: options.fallback,
    silent: options.silent
  });
};

export const autoPrintPosReceipt = async (receipt: Receipt) => {
  const settings = loadPosPrinterSettings();
  const printer = currentPosPrinter(settings);
  if (
    !settings.enabled ||
    !settings.autoPrint ||
    !printer?.printReceiptsAndBills ||
    !printer.autoPrintReceipt ||
    receipt.paymentStatus !== "paid"
  ) {
    return false;
  }

  return printPaidReceiptFromConfiguredTemplate(receipt, {
    fallback: false,
    silent: true
  });
};

export type AutoPrintOrderTicketsResult = {
  printed: boolean;
  printedItems: OrderTicketPrintedItem[];
};

export const autoPrintOrderTickets = async (
  receipt: Receipt
): Promise<false | AutoPrintOrderTicketsResult> => {
  const settings = loadPosPrinterSettings();
  if (!settings.enabled || !settings.autoPrintOrderTickets) return false;

  const ticketPrinters = settings.printers.filter(
    (printer) => printer.printOrderTickets
  );
  if (!ticketPrinters.length) return false;

  const newItems = unprintedReceiptItems(receipt);
  const printedItems = orderTicketPrintedSnapshot(receipt);
  if (!newItems.length) {
    return {
      printed: false,
      printedItems
    };
  }

  const ticketTitle = receipt.orderTicketPrintedItems?.length
    ? "ADDED ITEMS"
    : "NEW ORDER";
  let printed = false;
  for (const printer of ticketPrinters) {
    const items = receiptItemsForPrinter(receipt, printer, newItems);
    if (!items.length) continue;

    if (printer.singleItemTickets) {
      for (const item of items) {
        await printTicketViaPrinter(
          receiptToPrintableTicket(receipt, printer, [item], ticketTitle),
          printer,
          { fallback: false, silent: true }
        );
      }
      printed = true;
      continue;
    }

    await printTicketViaPrinter(
      receiptToPrintableTicket(receipt, printer, items, ticketTitle),
      printer,
      { fallback: false, silent: true }
    );
    printed = true;
  }

  return {
    printed,
    printedItems
  };
};

export const testPosPrinterProfile = async (
  profile?: PosPrinterProfile
): Promise<{ ok: boolean; message: string; tone: PrinterTone }> => {
  const settings = loadPosPrinterSettings();
  const printer = profile || currentPosPrinter(settings);

  if (!printer) {
    return {
      ok: false,
      message: "สร้างหรือเลือกโปรไฟล์เครื่องพิมพ์ก่อน",
      tone: "warning"
    };
  }

  try {
    const printed = await printOrderViaPrinter(buildPosPrinterTestOrder(), {
      fallback: printer.connection === "browser-print",
      profile: printer
    });
    if (!printed) {
      return {
        ok: false,
        message: "ไม่ได้ส่งงานพิมพ์ กรุณาเลือกประเภทเครื่องพิมพ์หรือเปิดใช้ POS printer ก่อน",
        tone: "warning"
      };
    }
    return {
      ok: true,
      message: `ส่งใบเทสต์ไปที่ ${printer.name} แล้ว`,
      tone: "ready"
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `Test print ไม่สำเร็จ: ${error.message}`
          : "Test print ไม่สำเร็จ",
      tone: "error"
    };
  }
};
