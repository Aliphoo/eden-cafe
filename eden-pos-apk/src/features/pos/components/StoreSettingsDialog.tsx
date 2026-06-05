import {
  Bluetooth,
  Cable,
  CheckCircle2,
  Chrome,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  ImageUp,
  KeyRound,
  LockKeyhole,
  LogIn,
  LogOut,
  Menu,
  Monitor,
  Percent,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Trash2,
  Usb,
  Wifi
} from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type {
  PromptPayAccount,
  SecuritySettings,
  StoreProfile
} from "../../../domain/pos";
import {
  edenUserLabel,
  isEdenNativeApp,
  loadEdenAdminAccess,
  observeEdenAuth,
  resolveEdenAuthRedirect,
  sendEdenAdminPasswordReset,
  signInEdenAdmin,
  signInEdenGoogleAdmin,
  signOutEdenAdmin
} from "../../../integrations/edenFirebase";
import {
  getCustomerDisplayNativeStatus,
  hideCustomerDisplay,
  loadCustomerDisplaySettings,
  openCustomerDisplayWindow,
  readCustomerDisplayState,
  saveCustomerDisplaySettings,
  showCustomerDisplay,
  type CustomerDisplaySettings
} from "../../../integrations/customerDisplay";
import {
  capabilityLabel,
  checkPosPrintBridge,
  createPosPrinterProfile,
  describePosPrinter,
  loadPosPrinterSettings,
  listNativeBluetoothPrinterDevices,
  listNativeUsbPrinterDevices,
  normalizePosPrinterProfile,
  printerConnectionOptions,
  printerGroupOptions,
  savePosPrinterSettings,
  testPosPrinterProfile,
  type NativeBluetoothPrinterDevice,
  type NativeUsbPrinterDevice,
  type PosPrinterProfile,
  type PosPrinterSettings,
  type PrinterCodepage,
  type PrinterConnection
} from "../../../integrations/posPrinter";

type SyncState = {
  status: "idle" | "syncing" | "synced" | "failed";
  message: string;
  lastSyncedAt?: string;
};

type StoreSettingsDialogProps = {
  open: boolean;
  security: SecuritySettings;
  store: StoreProfile;
  syncState: SyncState;
  onClose(): void;
  onSave(store: StoreProfile): void;
  onSaveSecurity(settings: {
    enabled: boolean;
    lockTimeoutMinutes: number;
    pin?: string;
  }): Promise<void>;
  onSyncCatalog(): Promise<void> | void;
  productCategories: string[];
};

type SettingsSection = "printers" | "display" | "tax" | "security" | "general";

const settingsSections: Array<{
  id: SettingsSection;
  label: string;
  icon: typeof Printer;
}> = [
  { id: "printers", label: "เครื่องพิมพ์", icon: Printer },
  { id: "display", label: "ระบบจอแสดงผลฝั่งลูกค้า", icon: Monitor },
  { id: "tax", label: "ภาษี", icon: Percent },
  { id: "security", label: "ล็อกหน้าจอ POS", icon: LockKeyhole },
  { id: "general", label: "ทั่วไป", icon: Settings }
];

const printerConnectionIcons: Record<PrinterConnection, typeof Printer> = {
  "bridge-network": Wifi,
  "browser-serial": Cable,
  "browser-usb": Usb,
  "browser-bluetooth": Bluetooth,
  "browser-print": FileText
};

type PrinterStatusMessage = {
  text: string;
  tone: "ready" | "warning" | "error";
};

const activePrinterDraft = (settings: PosPrinterSettings) =>
  settings.printers.find((printer) => printer.id === settings.activePrinterId) ??
  settings.printers[0] ??
  createPosPrinterProfile();

const MAX_PRINT_LOGO_BYTES = 1_500_000;

const cleanPromptPayId = (value: unknown) =>
  String(value ?? "").replace(/\D/g, "");

const fallbackPromptPayAccount = (store: StoreProfile): PromptPayAccount => ({
  id: store.promptPayAccountId || "eden-main",
  label: "Eden Cafe Main",
  promptPayId: cleanPromptPayId(store.promptPayId),
  merchantName: store.merchantName || "EDEN CAFE",
  city: store.city || "CHIANG RAI",
  order: 1
});

const normalizedPromptPayAccounts = (store: StoreProfile) => {
  const rawAccounts =
    Array.isArray(store.promptPayAccounts) && store.promptPayAccounts.length
      ? store.promptPayAccounts
      : [fallbackPromptPayAccount(store)];

  return rawAccounts
    .map((account, index) => ({
      ...account,
      id: String(account.id || `promptpay-${index + 1}`),
      label: String(account.label || `PromptPay ${index + 1}`),
      promptPayId: cleanPromptPayId(account.promptPayId),
      merchantName: String(account.merchantName || store.merchantName || "EDEN CAFE"),
      city: String(account.city || store.city || "CHIANG RAI"),
      order: Number.isFinite(Number(account.order)) ? Number(account.order) : index + 1
    }))
    .filter((account) => account.promptPayId)
    .sort((a, b) => a.order - b.order)
    .map((account, index) => ({ ...account, order: index + 1 }));
};

const withAuthTimeout = <T,>(promise: Promise<T>, timeoutMs = 8000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      window.setTimeout(
        () =>
          reject(
            new Error(
              "ตรวจสอบสิทธิ์ POS นานเกินไป ลองเชื่อมต่ออินเทอร์เน็ตแล้วกดใหม่"
            )
          ),
        timeoutMs
      );
    })
  ]);

const firebaseAuthCode = (error: unknown) => {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: string }).code ?? "");
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.match(/auth\/[a-z0-9-]+/i)?.[0] ?? "";
};

const authFailureMessage = (
  error: unknown,
  method: "email" | "google" | "redirect" | "access"
) => {
  const code = firebaseAuthCode(error);
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (code === "auth/operation-not-allowed") {
    const provider =
      method === "email" ? "Email/Password" : "Google";
    return `Firebase ยังไม่ได้เปิด ${provider}: ไปที่ Firebase Console > Authentication > Sign-in method แล้วเปิด ${provider}`;
  }

  if (code === "auth/unauthorized-domain") {
    return "โดเมนนี้ยังไม่ได้อยู่ใน Authorized domains ของ Firebase Authentication";
  }

  if (
    code === "auth/invalid-credential" ||
    code === "auth/user-not-found" ||
    code === "auth/wrong-password"
  ) {
    return "อีเมลหรือรหัสผ่านไม่ถูกต้อง หรือบัญชีนี้ยังไม่ได้สร้างใน Firebase Authentication";
  }

  if (
    code === "auth/popup-closed-by-user" ||
    code === "auth/cancelled-popup-request"
  ) {
    return "ยกเลิกการเข้าสู่ระบบ Google แล้ว";
  }

  if (code === "auth/network-request-failed") {
    return "เชื่อมต่อ Firebase ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง";
  }

  if (
    method === "google" &&
    /developer|10|default_web_client_id|token|sha|google/i.test(message)
  ) {
    return "Google Login บน APK ยังตั้งค่า Android OAuth ไม่ครบ ให้เพิ่ม SHA-1/SHA-256 ของ APK ใน Firebase, ดาวน์โหลด google-services.json ใหม่ใส่ android/app/ แล้ว rebuild APK หรือใช้ Email/Password ก่อน";
  }

  return message || "เข้าสู่ระบบไม่สำเร็จ";
};

export const StoreSettingsDialog = ({
  onClose,
  onSave,
  onSaveSecurity,
  onSyncCatalog,
  open,
  productCategories,
  security,
  store,
  syncState
}: StoreSettingsDialogProps) => {
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("printers");
  const [form, setForm] = useState(store);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [authLabel, setAuthLabel] = useState("");
  const [authMessage, setAuthMessage] = useState(
    "เข้าสู่ระบบแอดมินเพื่อส่งออเดอร์ขึ้นระบบ Eden"
  );
  const [authBusy, setAuthBusy] = useState(false);
  const [securityEnabled, setSecurityEnabled] = useState(security.enabled);
  const [timeoutPreset, setTimeoutPreset] = useState<"3" | "5" | "custom">(
    "3"
  );
  const [customTimeout, setCustomTimeout] = useState(
    security.lockTimeoutMinutes
  );
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [securityMessage, setSecurityMessage] = useState(
    "ตั้ง PIN เพื่อเปิดใช้งานล็อกหน้าจออัตโนมัติ"
  );
  const [saveBusy, setSaveBusy] = useState(false);
  const [logoMessage, setLogoMessage] = useState(
    store.printLogoDataUrl
      ? "โลโก้นี้จะแสดงบนสุดของใบปริ้น"
      : "อัปโหลดโลโก้ไฟล์ .webp สำหรับใบปริ้น"
  );
  const nativeApp = isEdenNativeApp();
  const [printerSettings, setPrinterSettings] = useState<PosPrinterSettings>(
    () => loadPosPrinterSettings()
  );
  const [printerDraft, setPrinterDraft] = useState<PosPrinterProfile>(() =>
    activePrinterDraft(loadPosPrinterSettings())
  );
  const [printerStatus, setPrinterStatus] = useState<PrinterStatusMessage>({
    text: "โหลดการตั้งค่าเครื่องพิมพ์แล้ว",
    tone: "ready"
  });
  const [bridgeStatus, setBridgeStatus] = useState("ยังไม่ได้ตรวจสอบ");
  const [printerBusy, setPrinterBusy] = useState(false);
  const [usbDevices, setUsbDevices] = useState<NativeUsbPrinterDevice[]>([]);
  const [usbBusy, setUsbBusy] = useState(false);
  const [bluetoothDevices, setBluetoothDevices] = useState<
    NativeBluetoothPrinterDevice[]
  >([]);
  const [bluetoothBusy, setBluetoothBusy] = useState(false);
  const [customerDisplaySettings, setCustomerDisplaySettings] =
    useState<CustomerDisplaySettings>(() => loadCustomerDisplaySettings());
  const [customerDisplayStatus, setCustomerDisplayStatus] = useState(
    "ยังไม่ได้ตรวจสอบจอฝั่งลูกค้า"
  );
  const [customerDisplayBusy, setCustomerDisplayBusy] = useState(false);
  const promptPayAccounts = useMemo(
    () => normalizedPromptPayAccounts(form),
    [form]
  );
  const selectedPromptPayAccount =
    promptPayAccounts.find((account) => account.id === form.promptPayAccountId) ||
    promptPayAccounts[0] ||
    fallbackPromptPayAccount(form);

  const selectPromptPayAccount = (accountId: string) => {
    setForm((current) => {
      const accounts = normalizedPromptPayAccounts(current);
      const selected =
        accounts.find((account) => account.id === accountId) ||
        accounts[0] ||
        fallbackPromptPayAccount(current);

      return {
        ...current,
        promptPayAccountId: selected.id,
        promptPayAccounts: accounts,
        promptPayEnabled: current.promptPayEnabled !== false,
        promptPayLocked: true,
        promptPayId: selected.promptPayId,
        merchantName: selected.merchantName,
        city: selected.city
      };
    });
  };

  useEffect(() => {
    setForm(store);
    setLogoMessage(
      store.printLogoDataUrl
        ? "โลโก้นี้จะแสดงบนสุดของใบปริ้น"
        : "อัปโหลดโลโก้ไฟล์ .webp สำหรับใบปริ้น"
    );
  }, [store]);

  useEffect(() => {
    setSecurityEnabled(security.enabled);
    setTimeoutPreset(
      security.lockTimeoutMinutes === 3
        ? "3"
        : security.lockTimeoutMinutes === 5
          ? "5"
          : "custom"
    );
    setCustomTimeout(security.lockTimeoutMinutes);
    setPin("");
    setPinConfirm("");
    setSecurityMessage(
      security.pinHash
        ? "มี PIN สำหรับปลดล็อกแล้ว เว้นช่อง PIN ไว้ได้ถ้าไม่ต้องการเปลี่ยน"
        : "ตั้ง PIN เพื่อเปิดใช้งานล็อกหน้าจออัตโนมัติ"
    );
  }, [security, open]);

  useEffect(() => {
    if (!open) return;
    const settings = loadPosPrinterSettings();
    setPrinterSettings(settings);
    setPrinterDraft(activePrinterDraft(settings));
    setCustomerDisplaySettings(loadCustomerDisplaySettings());
    setCustomerDisplayStatus("พร้อมตั้งค่าจอฝั่งลูกค้า");
    setPrinterStatus({
      text: "โหลดการตั้งค่าเครื่องพิมพ์แล้ว",
      tone: "ready"
    });
  }, [open]);

  useEffect(
    () =>
      observeEdenAuth((user) => {
        setAuthLabel(edenUserLabel(user));
        if (!user) {
          setAuthMessage("เข้าสู่ระบบแอดมินเพื่อส่งออเดอร์ขึ้นระบบ Eden");
          return;
        }

        setAuthMessage("กำลังตรวจสอบสิทธิ์ POS...");
        void withAuthTimeout(loadEdenAdminAccess(user))
          .then((access) => {
            setAuthMessage(
              access?.canUsePos
                ? `พร้อมส่งใบเสร็จจาก APK ไปยัง Firestore (${access.role})`
                : "ล็อกอินแล้ว แต่บัญชีนี้ยังไม่มีสิทธิ์ POS ในระบบ Eden"
            );
          })
          .catch((error) => {
            setAuthMessage(
              error instanceof Error
                ? `ตรวจสอบสิทธิ์ POS ไม่สำเร็จ: ${error.message}`
                : "ตรวจสอบสิทธิ์ POS ไม่สำเร็จ"
            );
          });
      }),
    []
  );

  useEffect(() => {
    void resolveEdenAuthRedirect().catch((error) => {
      setAuthMessage(`ตรวจสอบ Google Login ไม่สำเร็จ: ${authFailureMessage(error, "redirect")}`);
    });
  }, []);

  if (!open) {
    return null;
  }

  const taxPercent = Number((form.taxRate * 100).toFixed(2));
  const storeCanSave =
    form.name.trim() && form.receiptPrefix.trim() && form.promptPayId.trim();
  const logoUpdatedLabel = form.printLogoUpdatedAt
    ? new Intl.DateTimeFormat("th-TH", {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(form.printLogoUpdatedAt))
    : "";
  const hasSecurityPin = Boolean(security.pinHash);
  const selectedTimeout =
    timeoutPreset === "custom" ? customTimeout : Number(timeoutPreset);
  const cleanPin = pin.replace(/\D/g, "");
  const cleanPinConfirm = pinConfirm.replace(/\D/g, "");
  const changingPin = cleanPin.length > 0 || cleanPinConfirm.length > 0;
  const pinReady =
    !changingPin || (cleanPin.length >= 4 && cleanPin === cleanPinConfirm);
  const securityCanSave =
    !securityEnabled ||
    ((hasSecurityPin || cleanPin.length >= 4) &&
      pinReady &&
      selectedTimeout >= 1);
  const canSave = Boolean(storeCanSave && securityCanSave && !saveBusy);
  const activeLabel =
    settingsSections.find((section) => section.id === activeSection)?.label ??
    "การตั้งค่า";
  const lastSyncedLabel = syncState.lastSyncedAt
    ? new Intl.DateTimeFormat("th-TH", {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date(syncState.lastSyncedAt))
    : "";
  const slipHeaderPreviewLines = [
    form.receiptHeaderBusinessName || form.name,
    form.receiptHeaderBranch ? `สาขา ${form.receiptHeaderBranch}` : "",
    form.receiptHeaderAddress,
    form.receiptTaxId ? `เลขผู้เสียภาษี ${form.receiptTaxId}` : "",
    form.receiptPhone ? `เบอร์โทร ${form.receiptPhone}` : "",
    form.receiptWebsite ? `เว็บไซต์ ${form.receiptWebsite}` : ""
  ]
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);
  const slipFooterPreviewLines = String(form.receiptFooterNote ?? "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const slipPreviewTitle =
    form.receiptTitle?.trim() || "ใบกำกับภาษีอย่างย่อ/ใบเสร็จรับเงิน";

  const saveSettings = async () => {
    if (!canSave) return;

    if (securityEnabled && !hasSecurityPin && cleanPin.length < 4) {
      setSecurityMessage("ตั้ง PIN อย่างน้อย 4 หลักก่อนเปิดล็อกหน้าจอ");
      return;
    }

    if (changingPin && cleanPin.length < 4) {
      setSecurityMessage("PIN ใหม่ต้องมีอย่างน้อย 4 หลัก");
      return;
    }

    if (changingPin && cleanPin !== cleanPinConfirm) {
      setSecurityMessage("PIN และยืนยัน PIN ไม่ตรงกัน");
      return;
    }

    setSaveBusy(true);
    try {
      await onSaveSecurity({
        enabled: securityEnabled,
        lockTimeoutMinutes: selectedTimeout,
        pin: changingPin ? cleanPin : undefined
      });
      onSave(form);
    } finally {
      setSaveBusy(false);
    }
  };

  const handleLogoFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    const fileName = file.name.trim();
    const isWebp =
      file.type === "image/webp" || fileName.toLowerCase().endsWith(".webp");

    if (!isWebp) {
      setLogoMessage("รองรับเฉพาะไฟล์โลโก้ .webp");
      return;
    }

    if (file.size > MAX_PRINT_LOGO_BYTES) {
      setLogoMessage("ไฟล์โลโก้ควรไม่เกิน 1.5 MB เพื่อบันทึกในเครื่อง");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setLogoMessage("อ่านไฟล์โลโก้ไม่สำเร็จ");
        return;
      }

      setForm((current) => ({
        ...current,
        printLogoDataUrl: reader.result as string,
        printLogoFileName: fileName || "receipt-logo.webp",
        printLogoUpdatedAt: new Date().toISOString()
      }));
      setLogoMessage("พร้อมใช้โลโก้นี้บนใบปริ้น");
    };
    reader.onerror = () => setLogoMessage("อ่านไฟล์โลโก้ไม่สำเร็จ");
    reader.readAsDataURL(file);
  };

  const clearPrintLogo = () => {
    setForm((current) => ({
      ...current,
      printLogoDataUrl: "",
      printLogoFileName: "",
      printLogoUpdatedAt: new Date().toISOString()
    }));
    setLogoMessage("ลบโลโก้สำหรับใบปริ้นแล้ว");
  };

  const handleSignIn = async () => {
    if (!adminEmail.trim() || !adminPassword) {
      setAuthMessage("กรอกอีเมลและรหัสผ่านแอดมินก่อน");
      return;
    }

    setAuthBusy(true);
    setAuthMessage("กำลังเข้าสู่ระบบ Eden...");
    try {
      await signInEdenAdmin(adminEmail.trim(), adminPassword);
      setAdminPassword("");
      setAuthMessage("เข้าสู่ระบบแล้ว พร้อมส่งออเดอร์ขึ้น Eden");
    } catch (error) {
      setAuthMessage(`เข้าสู่ระบบไม่สำเร็จ: ${authFailureMessage(error, "email")}`);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthBusy(true);
    setAuthMessage("กำลังเปิด Google Login...");
    try {
      const result = await Promise.race([
        signInEdenGoogleAdmin(),
        new Promise<null>((_, reject) => {
          window.setTimeout(
            () =>
              reject(
                new Error(
                  "Google Login ไม่ตอบกลับ ลองตรวจว่าแท็บเล็ตมี Google Play Services และเพิ่ม SHA ใน Firebase แล้ว"
                )
              ),
            15000
          );
        })
      ]);
      setAuthMessage(
        result?.user
          ? "เข้าสู่ระบบด้วย Google แล้ว พร้อมส่งออเดอร์ขึ้น Eden"
          : "เปิดหน้า Google แล้ว กรุณาเลือกบัญชีและกลับมาที่ POS"
      );
    } catch (error) {
      setAuthMessage(
        `เข้าสู่ระบบด้วย Google ไม่สำเร็จ: ${authFailureMessage(error, "google")}`
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!adminEmail.trim()) {
      setAuthMessage("กรอกอีเมลแอดมินก่อน แล้วกดตั้ง/รีเซ็ตรหัสผ่าน");
      return;
    }

    setAuthBusy(true);
    setAuthMessage("กำลังส่งลิงก์ตั้งรหัสผ่านไปที่อีเมล...");
    try {
      await sendEdenAdminPasswordReset(adminEmail.trim());
      setAuthMessage(
        "ส่งลิงก์ตั้ง/รีเซ็ตรหัสผ่านแล้ว เปิดอีเมลนี้เพื่อสร้างรหัสผ่าน จากนั้นกลับมาล็อกอินใน APK ด้วย Email/Password"
      );
    } catch (error) {
      setAuthMessage(
        `ส่งลิงก์ตั้งรหัสผ่านไม่สำเร็จ: ${authFailureMessage(error, "email")}`
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    setAuthBusy(true);
    try {
      await signOutEdenAdmin();
      setAuthMessage("ออกจากระบบแอดมินแล้ว");
    } finally {
      setAuthBusy(false);
    }
  };

  const persistPrinterSettings = (nextSettings: PosPrinterSettings) => {
    const saved = savePosPrinterSettings(nextSettings);
    setPrinterSettings(saved);
    return saved;
  };

  const updatePrinterGlobal = (patch: Partial<PosPrinterSettings>) => {
    const saved = persistPrinterSettings({
      ...printerSettings,
      ...patch
    });
    setPrinterDraft(activePrinterDraft(saved));
  };

  const updatePrinterDraft = (patch: Partial<PosPrinterProfile>) => {
    setPrinterDraft((current) => ({
      ...current,
      ...patch
    }));
  };

  const togglePrinterDraftList = (
    field: "printerGroups" | "categoryFilters",
    value: string
  ) => {
    setPrinterDraft((current) => {
      const set = new Set(current[field]);
      if (set.has(value)) {
        set.delete(value);
      } else {
        set.add(value);
      }

      return {
        ...current,
        [field]: Array.from(set)
      };
    });
  };

  const handleSelectPrinter = (printerId: string) => {
    const saved = persistPrinterSettings({
      ...printerSettings,
      activePrinterId: printerId
    });
    setPrinterDraft(activePrinterDraft(saved));
    setPrinterStatus({
      text: "เปลี่ยนเครื่องพิมพ์หลักแล้ว",
      tone: "ready"
    });
  };

  const handleCreatePrinter = () => {
    const profile = createPosPrinterProfile({
      name: "New POS Printer"
    });
    const saved = persistPrinterSettings({
      ...printerSettings,
      activePrinterId: profile.id,
      printers: [...printerSettings.printers, profile]
    });
    setPrinterDraft(activePrinterDraft(saved));
    setPrinterStatus({
      text: "สร้างโปรไฟล์ใหม่แล้ว แก้ไขรายละเอียดแล้วกดบันทึก",
      tone: "ready"
    });
  };

  const handleSavePrinter = () => {
    const profile = normalizePosPrinterProfile(printerDraft);
    const exists = printerSettings.printers.some(
      (printer) => printer.id === profile.id
    );
    const printers = exists
      ? printerSettings.printers.map((printer) =>
          printer.id === profile.id ? profile : printer
        )
      : [...printerSettings.printers, profile];
    const saved = persistPrinterSettings({
      ...printerSettings,
      activePrinterId: profile.id,
      printers
    });

    setPrinterDraft(activePrinterDraft(saved));
    setPrinterStatus({
      text: "บันทึกโปรไฟล์เครื่องพิมพ์แล้ว",
      tone: "ready"
    });
  };

  const handleDeletePrinter = () => {
    if (printerSettings.printers.length <= 1) {
      setPrinterStatus({
        text: "ต้องมีโปรไฟล์เครื่องพิมพ์อย่างน้อย 1 รายการ",
        tone: "warning"
      });
      return;
    }

    const printers = printerSettings.printers.filter(
      (printer) => printer.id !== printerDraft.id
    );
    const saved = persistPrinterSettings({
      ...printerSettings,
      activePrinterId: printers[0]?.id || "",
      printers
    });
    setPrinterDraft(activePrinterDraft(saved));
    setPrinterStatus({
      text: "ลบโปรไฟล์เครื่องพิมพ์แล้ว",
      tone: "warning"
    });
  };

  const handleCheckBridge = async () => {
    if (printerDraft.connection !== "bridge-network") {
      setBridgeStatus("ไม่จำเป็น");
      setPrinterStatus({
        text: "โหมดนี้ไม่ต้องใช้ Eden Print Bridge ให้กด Test Print เพื่อทดสอบเครื่องพิมพ์โดยตรง",
        tone: "ready"
      });
      return;
    }

    setPrinterBusy(true);
    setBridgeStatus("กำลังตรวจสอบ...");
    try {
      await checkPosPrintBridge(printerDraft.endpoint);
      setBridgeStatus("Online");
      setPrinterStatus({
        text: `Eden Print Bridge ออนไลน์ที่ ${printerDraft.endpoint}`,
        tone: "ready"
      });
    } catch (error) {
      setBridgeStatus("Offline");
      setPrinterStatus({
        text:
          error instanceof Error
            ? `Bridge ใช้งานไม่ได้: ${error.message}`
            : "Bridge ใช้งานไม่ได้",
        tone: "warning"
      });
    } finally {
      setPrinterBusy(false);
    }
  };

  const handleTestPrint = async () => {
    setPrinterBusy(true);
    setPrinterStatus({
      text: "กำลังส่งใบเทสต์ไปเครื่องพิมพ์...",
      tone: "ready"
    });
    try {
      const result = await testPosPrinterProfile(
        normalizePosPrinterProfile(printerDraft)
      );
      setPrinterStatus({
        text: result.message,
        tone: result.tone
      });
    } finally {
      setPrinterBusy(false);
    }
  };

  const firstWritableUsbEndpoint = (device: NativeUsbPrinterDevice) => {
    let fallback:
      | {
          usbInterface: NonNullable<NativeUsbPrinterDevice["interfaces"]>[number];
          endpoint: NonNullable<
            NativeUsbPrinterDevice["interfaces"]
          >[number]["endpoints"][number];
        }
      | null = null;

    for (const usbInterface of device.interfaces ?? []) {
      const endpoint = usbInterface.endpoints.find((item) => item.writable);
      if (!endpoint) {
        continue;
      }

      const target = { usbInterface, endpoint };
      if (usbInterface.interfaceClass === 7) {
        return target;
      }

      fallback ??= target;
    }

    return fallback;
  };

  const usbDeviceLabel = (device: NativeUsbPrinterDevice) =>
    [device.productName, device.manufacturerName, device.deviceName]
      .filter(Boolean)
      .join(" / ") || `USB ${device.vendorId}:${device.productId}`;

  const handleScanUsbPrinters = async () => {
    setUsbBusy(true);
    setPrinterStatus({
      text: "กำลังค้นหาเครื่องพิมพ์ USB จาก Android...",
      tone: "ready"
    });

    try {
      const devices = await listNativeUsbPrinterDevices();
      setUsbDevices(devices);
      const printableCount = devices.filter(firstWritableUsbEndpoint).length;
      setPrinterStatus({
        text: devices.length
          ? `พบ USB ${devices.length} รายการ / ใช้พิมพ์ได้ ${printableCount} รายการ ให้กดเลือกเครื่องที่เป็นปริ้นเตอร์ครัว`
          : "ไม่พบอุปกรณ์ USB จาก Android ตรวจสาย USB/OTG และเปิดสิทธิ์ USB ให้แอพ",
        tone: devices.length ? "ready" : "warning"
      });
    } catch (error) {
      setPrinterStatus({
        text:
          error instanceof Error
            ? `ค้นหา USB ไม่สำเร็จ: ${error.message}`
            : "ค้นหา USB ไม่สำเร็จ",
        tone: "error"
      });
    } finally {
      setUsbBusy(false);
    }
  };

  const handleUseUsbDevice = (device: NativeUsbPrinterDevice) => {
    const target = firstWritableUsbEndpoint(device);

    if (!target) {
      setPrinterStatus({
        text: "เครื่องนี้ยังไม่พบ endpoint สำหรับส่งข้อมูลพิมพ์ ลองส่งรูปหน้าจอนี้มาให้ผมดูรายละเอียด USB",
        tone: "warning"
      });
      return;
    }

    updatePrinterDraft({
      connection: "browser-usb",
      vendorId: String(device.vendorId),
      productId: String(device.productId),
      deviceName: device.deviceName,
      productName: device.productName || "",
      interfaceNumber: target.usbInterface.id,
      endpointNumber: target.endpoint.endpointNumber
    });
    setPrinterStatus({
      text: `เลือก ${usbDeviceLabel(device)} แล้ว กดบันทึกโปรไฟล์ จากนั้นกด Test Print`,
      tone: "ready"
    });
  };

  const bluetoothDeviceLabel = (device: NativeBluetoothPrinterDevice) =>
    [device.name, device.address].filter(Boolean).join(" / ") ||
    "Bluetooth printer";

  const handleScanBluetoothPrinters = async () => {
    setBluetoothBusy(true);
    setPrinterStatus({
      text: "กำลังค้นหาเครื่องพิมพ์ Bluetooth ที่จับคู่แล้วจาก Android...",
      tone: "ready"
    });

    try {
      const devices = await listNativeBluetoothPrinterDevices();
      setBluetoothDevices(devices);
      setPrinterStatus({
        text: devices.length
          ? `พบ Bluetooth ที่จับคู่แล้ว ${devices.length} รายการ ให้เลือกเครื่องพิมพ์แล้วกดบันทึกโปรไฟล์`
          : "ยังไม่พบ Bluetooth ที่จับคู่ไว้ใน Android ให้ pair เครื่องพิมพ์ใน Settings ของเครื่อง POS ก่อน",
        tone: devices.length ? "ready" : "warning"
      });
    } catch (error) {
      setPrinterStatus({
        text:
          error instanceof Error
            ? `ค้นหา Bluetooth ไม่สำเร็จ: ${error.message}`
            : "ค้นหา Bluetooth ไม่สำเร็จ",
        tone: "error"
      });
    } finally {
      setBluetoothBusy(false);
    }
  };

  const handleUseBluetoothDevice = (device: NativeBluetoothPrinterDevice) => {
    updatePrinterDraft({
      connection: "browser-bluetooth",
      bluetoothAddress: device.address,
      bluetoothName: device.name || ""
    });
    setPrinterStatus({
      text: `เลือก ${bluetoothDeviceLabel(device)} แล้ว กดบันทึกโปรไฟล์ จากนั้นกด Test Print`,
      tone: "ready"
    });
  };

  const updateCustomerDisplaySettings = (
    patch: Partial<CustomerDisplaySettings>
  ) => {
    setCustomerDisplaySettings((current) =>
      saveCustomerDisplaySettings({
        ...current,
        ...patch
      })
    );
  };

  const handleCheckCustomerDisplay = async () => {
    setCustomerDisplayBusy(true);
    setCustomerDisplayStatus("กำลังตรวจสอบจอที่สองในเครื่อง...");
    try {
      const result = await getCustomerDisplayNativeStatus();
      setCustomerDisplayStatus(
        result.available
          ? `พบจอฝั่งลูกค้า ${result.displays.length} จอ: ${result.displays
              .map((display) => display.name)
              .join(", ")}`
          : "ยังไม่พบจอที่สองในเครื่องนี้ ใช้ปุ่มเปิดหน้าจอ Preview เพื่อทดสอบก่อนได้"
      );
    } catch (error) {
      setCustomerDisplayStatus(
        error instanceof Error
          ? `ตรวจจอฝั่งลูกค้าไม่สำเร็จ: ${error.message}`
          : "ตรวจจอฝั่งลูกค้าไม่สำเร็จ"
      );
    } finally {
      setCustomerDisplayBusy(false);
    }
  };

  const handleStartCustomerDisplay = async () => {
    const saved = saveCustomerDisplaySettings({
      ...customerDisplaySettings,
      enabled: true
    });
    setCustomerDisplaySettings(saved);
    setCustomerDisplayBusy(true);
    setCustomerDisplayStatus("กำลังเริ่มจอฝั่งลูกค้า...");
    try {
      const result = await showCustomerDisplay(readCustomerDisplayState(), saved);
      setCustomerDisplayStatus(
        result.available
          ? `เริ่มจอฝั่งลูกค้าแล้ว${result.displayName ? ` (${result.displayName})` : ""}`
          : "เปิดโหมดจอฝั่งลูกค้าแล้ว แต่เครื่องนี้ยังไม่รายงานจอที่สอง"
      );
    } catch (error) {
      setCustomerDisplayStatus(
        error instanceof Error
          ? `เริ่มจอฝั่งลูกค้าไม่สำเร็จ: ${error.message}`
          : "เริ่มจอฝั่งลูกค้าไม่สำเร็จ"
      );
    } finally {
      setCustomerDisplayBusy(false);
    }
  };

  const handleStopCustomerDisplay = async () => {
    updateCustomerDisplaySettings({ enabled: false });
    await hideCustomerDisplay();
    setCustomerDisplayStatus("ปิดจอฝั่งลูกค้าแล้ว");
  };

  const handleOpenCustomerDisplayPreview = () => {
    const displayWindow = openCustomerDisplayWindow();
    setCustomerDisplayStatus(
      displayWindow
        ? "เปิดหน้าจอ Preview แล้ว สามารถลากไปไว้จอที่สองเพื่อทดสอบได้"
        : "เปิดหน้าต่าง Preview ไม่สำเร็จ อาจถูก browser บล็อก popup"
    );
  };

  const renderPrinterPanel = () => {
    const activePrinter = activePrinterDraft(printerSettings);
    const ActiveIcon =
      printerConnectionIcons[activePrinter.connection] ?? Printer;
    const DraftIcon = printerConnectionIcons[printerDraft.connection] ?? Printer;
    const showBridgeFields = printerDraft.connection === "bridge-network";
    const showSerialFields = printerDraft.connection === "browser-serial";
    const showUsbFields = printerDraft.connection === "browser-usb";
    const showBleFields = printerDraft.connection === "browser-bluetooth";
    const bridgeRequired = printerDraft.connection === "bridge-network";

    return (
      <div className="printer-settings-view">
        <section
          aria-label="สถานะเครื่องพิมพ์"
          className="printer-status-grid"
        >
          <div className="printer-status-card">
            <ActiveIcon aria-hidden="true" size={24} />
            <span>เครื่องพิมพ์หลัก</span>
            <strong>{activePrinter.name}</strong>
            <small>{describePosPrinter(activePrinter)}</small>
          </div>
          <div className="printer-status-card">
            <CheckCircle2 aria-hidden="true" size={24} />
            <span>ความสามารถ Browser</span>
            <strong>{capabilityLabel()}</strong>
            <small>APK ใช้ LAN Bridge ได้ และ Web API จะขึ้นเมื่อ WebView รองรับ</small>
          </div>
          <div className="printer-status-card">
            {bridgeRequired ? (
              <Wifi aria-hidden="true" size={24} />
            ) : (
              <Usb aria-hidden="true" size={24} />
            )}
            <span>{bridgeRequired ? "Eden Print Bridge" : "USB Native"}</span>
            <strong>{bridgeRequired ? bridgeStatus : "ไม่ต้องใช้ Bridge"}</strong>
            <small>
              {bridgeRequired
                ? "จำเป็นสำหรับพิมพ์ raw ESC/POS ไปเครื่อง LAN/WiFi"
                : "เสียบ USB กับเครื่อง Android POS แล้วกด Test Print ได้เลย"}
            </small>
          </div>
        </section>

        <div className="printer-workspace">
          <section className="printer-panel">
            <div className="printer-panel-title">
              <h2>การใช้งาน</h2>
              <span>เลือกโปรไฟล์หลักสำหรับเครื่อง POS เครื่องนี้</span>
            </div>

            <label className="printer-switch-row">
              <input
                checked={printerSettings.enabled}
                onChange={(event) =>
                  updatePrinterGlobal({ enabled: event.target.checked })
                }
                type="checkbox"
              />
              <span>ใช้ POS printer ก่อน browser print</span>
            </label>
            <label className="printer-switch-row">
              <input
                checked={printerSettings.autoPrint}
                onChange={(event) =>
                  updatePrinterGlobal({ autoPrint: event.target.checked })
                }
                type="checkbox"
              />
              <span>พิมพ์ใบเสร็จอัตโนมัติหลังชำระเงิน</span>
            </label>
            <label className="printer-switch-row">
              <input
                checked={printerSettings.autoPrintOrderTickets}
                onChange={(event) =>
                  updatePrinterGlobal({
                    autoPrintOrderTickets: event.target.checked
                  })
                }
                type="checkbox"
              />
              <span>พิมพ์ใบสั่งงานอัตโนมัติเมื่อบันทึกบิล/ชำระทันที</span>
            </label>

            <label className="printer-field">
              เครื่องพิมพ์หลัก
              <select
                onChange={(event) => handleSelectPrinter(event.target.value)}
                value={printerSettings.activePrinterId}
              >
                {printerSettings.printers.map((printer) => (
                  <option key={printer.id} value={printer.id}>
                    {printer.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="printer-profile-list">
              {printerSettings.printers.map((printer) => {
                const Icon = printerConnectionIcons[printer.connection] ?? Printer;
                return (
                  <button
                    className={[
                      "printer-profile-card",
                      printer.id === printerSettings.activePrinterId
                        ? "active"
                        : "",
                      printer.id === printerDraft.id ? "editing" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={printer.id}
                    onClick={() => setPrinterDraft(printer)}
                    type="button"
                  >
                    <Icon aria-hidden="true" size={21} />
                    <span>
                      <strong>{printer.name}</strong>
                      <small>{describePosPrinter(printer)}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="printer-panel printer-editor-panel">
            <div className="printer-panel-title with-action">
              <div>
                <h2>โปรไฟล์เครื่องพิมพ์</h2>
                <span>ตั้งค่า LAN, USB/Serial, Bluetooth BLE หรือ browser fallback</span>
              </div>
              <DraftIcon aria-hidden="true" size={28} />
            </div>

            <div className="printer-form-grid">
              <label className="printer-field wide">
                ชื่อโปรไฟล์
                <input
                  onChange={(event) =>
                    updatePrinterDraft({ name: event.target.value })
                  }
                  placeholder="Counter Printer 80mm"
                  value={printerDraft.name}
                />
              </label>

              <label className="printer-field wide">
                วิธีเชื่อมต่อ
                <select
                  onChange={(event) =>
                    updatePrinterDraft({
                      connection: event.target.value as PrinterConnection
                    })
                  }
                  value={printerDraft.connection}
                >
                  {printerConnectionOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="printer-field">
                ขนาดกระดาษ
                <select
                  onChange={(event) =>
                    updatePrinterDraft({
                      paperWidth:
                        Number(event.target.value) === 58 ? 58 : 80
                    })
                  }
                  value={printerDraft.paperWidth}
                >
                  <option value={80}>80 mm</option>
                  <option value={58}>58 mm</option>
                </select>
              </label>

              <label className="printer-field">
                จำนวนสำเนา
                <input
                  max={4}
                  min={1}
                  onChange={(event) =>
                    updatePrinterDraft({
                      copies: Math.max(1, Number(event.target.value) || 1)
                    })
                  }
                  type="number"
                  value={printerDraft.copies}
                />
              </label>

              {showBridgeFields && (
                <>
                  <label className="printer-field wide">
                    Bridge endpoint
                    <input
                      onChange={(event) =>
                        updatePrinterDraft({ endpoint: event.target.value })
                      }
                      placeholder="http://127.0.0.1:8787"
                      type="url"
                      value={printerDraft.endpoint}
                    />
                  </label>
                  <label className="printer-field">
                    IP เครื่องพิมพ์ LAN
                    <input
                      onChange={(event) =>
                        updatePrinterDraft({ host: event.target.value })
                      }
                      placeholder="192.168.1.50"
                      value={printerDraft.host}
                    />
                  </label>
                  <label className="printer-field">
                    Port
                    <input
                      max={65535}
                      min={1}
                      onChange={(event) =>
                        updatePrinterDraft({
                          port: Math.max(1, Number(event.target.value) || 9100)
                        })
                      }
                      type="number"
                      value={printerDraft.port}
                    />
                  </label>
                </>
              )}

              {showSerialFields && (
                <label className="printer-field">
                  Baud rate
                  <input
                    min={1200}
                    onChange={(event) =>
                      updatePrinterDraft({
                        baudRate: Math.max(1200, Number(event.target.value) || 9600)
                      })
                    }
                    type="number"
                    value={printerDraft.baudRate}
                  />
                </label>
              )}

              {showUsbFields && (
                <>
                  <div className="printer-usb-tools">
                    <button
                      disabled={usbBusy}
                      onClick={() => void handleScanUsbPrinters()}
                      type="button"
                    >
                      <Usb aria-hidden="true" size={18} />
                      {usbBusy ? "กำลังค้นหา..." : "ค้นหา USB printer"}
                    </button>
                    <small>
                      ถ้าเสียบหลายอุปกรณ์ ให้เลือกตัวที่เป็นเครื่องพิมพ์ครัว ระบบจะล็อก Vendor/Product ให้เอง
                    </small>
                  </div>
                  {usbDevices.length > 0 && (
                    <div className="printer-usb-device-list">
                      {usbDevices.map((device) => {
                        const target = firstWritableUsbEndpoint(device);
                        const targetText = target
                          ? `Interface ${target.usbInterface.id} / Endpoint ${target.endpoint.endpointNumber} / Packet ${target.endpoint.maxPacketSize}`
                          : "ไม่พบ output endpoint";

                        return (
                          <button
                            className={target ? "ready" : "warning"}
                            key={`${device.deviceName}-${device.vendorId}-${device.productId}`}
                            onClick={() => handleUseUsbDevice(device)}
                            type="button"
                          >
                            <strong>{usbDeviceLabel(device)}</strong>
                            <span>
                              VID {device.vendorId} / PID {device.productId} /{" "}
                              {device.hasPermission ? "มีสิทธิ์ USB" : "รอสิทธิ์ USB"}
                            </span>
                            <small>{targetText}</small>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <label className="printer-field">
                    USB Vendor ID (เว้นว่าง = อัตโนมัติ)
                    <input
                      onChange={(event) =>
                        updatePrinterDraft({ vendorId: event.target.value })
                      }
                      placeholder="0x04b8"
                      value={printerDraft.vendorId}
                    />
                  </label>
                  <label className="printer-field">
                    USB Product ID
                    <input
                      onChange={(event) =>
                        updatePrinterDraft({ productId: event.target.value })
                      }
                      placeholder="เช่น 0x0202 หรือ 513"
                      value={printerDraft.productId}
                    />
                  </label>
                  <label className="printer-field wide">
                    USB Device Name
                    <input
                      onChange={(event) =>
                        updatePrinterDraft({ deviceName: event.target.value })
                      }
                      placeholder="/dev/bus/usb/001/002"
                      value={printerDraft.deviceName}
                    />
                  </label>
                  <label className="printer-field">
                    Interface
                    <input
                      min={0}
                      onChange={(event) =>
                        updatePrinterDraft({
                          interfaceNumber: Math.max(
                            0,
                            Number(event.target.value) || 0
                          )
                        })
                      }
                      type="number"
                      value={printerDraft.interfaceNumber}
                    />
                  </label>
                  <label className="printer-field">
                    Endpoint
                    <input
                      min={1}
                      onChange={(event) =>
                        updatePrinterDraft({
                          endpointNumber: Math.max(
                            1,
                            Number(event.target.value) || 1
                          )
                        })
                      }
                      type="number"
                      value={printerDraft.endpointNumber}
                    />
                  </label>
                </>
              )}

              {showBleFields && (
                <>
                  <div className="printer-bluetooth-tools">
                    <button
                      disabled={bluetoothBusy}
                      onClick={() => void handleScanBluetoothPrinters()}
                      type="button"
                    >
                      <Bluetooth aria-hidden="true" size={18} />
                      {bluetoothBusy
                        ? "กำลังค้นหา..."
                        : "ค้นหา Bluetooth ที่จับคู่แล้ว"}
                    </button>
                    <small>
                      ใช้รายชื่อเครื่องที่ pair ไว้ใน Android แล้ว เหมาะกับเครื่องพิมพ์ความร้อนแบบ Bluetooth SPP
                    </small>
                  </div>
                  {bluetoothDevices.length > 0 && (
                    <div className="printer-bluetooth-device-list">
                      {bluetoothDevices.map((device) => (
                        <button
                          className="ready"
                          key={device.address || device.name}
                          onClick={() => handleUseBluetoothDevice(device)}
                          type="button"
                        >
                          <strong>{bluetoothDeviceLabel(device)}</strong>
                          <span>Address {device.address || "-"}</span>
                          <small>กดเลือกเครื่องนี้ แล้วบันทึกโปรไฟล์ก่อน Test Print</small>
                        </button>
                      ))}
                    </div>
                  )}
                  <label className="printer-field wide">
                    Bluetooth Name
                    <input
                      onChange={(event) =>
                        updatePrinterDraft({ bluetoothName: event.target.value })
                      }
                      placeholder="เช่น Printer001"
                      value={printerDraft.bluetoothName}
                    />
                  </label>
                  <label className="printer-field wide">
                    Bluetooth Address
                    <input
                      onChange={(event) =>
                        updatePrinterDraft({
                          bluetoothAddress: event.target.value
                        })
                      }
                      placeholder="เช่น 00:11:22:33:44:55"
                      value={printerDraft.bluetoothAddress}
                    />
                  </label>
                  <label className="printer-field wide">
                    BLE/SPP UUID (ปกติไม่ต้องแก้)
                    <input
                      onChange={(event) =>
                        updatePrinterDraft({ serviceUuid: event.target.value })
                      }
                      value={printerDraft.serviceUuid}
                    />
                  </label>
                  <label className="printer-field wide">
                    BLE characteristic UUID
                    <input
                      onChange={(event) =>
                        updatePrinterDraft({
                          characteristicUuid: event.target.value
                        })
                      }
                      value={printerDraft.characteristicUuid}
                    />
                  </label>
                </>
              )}

              <label className="printer-field">
                ESC/POS codepage
                <select
                  onChange={(event) =>
                    updatePrinterDraft({
                      codepage: event.target.value as PrinterCodepage
                    })
                  }
                  value={printerDraft.codepage}
                >
                  <option value="thai-raster">Thai raster image (แนะนำ)</option>
                  <option value="thai42">Thai raster compatible</option>
                  <option value="cp874">CP874 raster compatible</option>
                  <option value="utf8">UTF-8</option>
                  <option value="ascii">ASCII fallback</option>
                </select>
              </label>
            </div>

            <section className="printer-ticket-panel">
              <div className="printer-panel-title">
                <h2>รายการตั้งค่าเครื่องพิมพ์</h2>
                <span>แยกงานพิมพ์ใบเสร็จและ order ticket ของบาร์/ห้องครัว</span>
              </div>
              <div className="printer-toggle-grid">
                <label className="printer-switch-row">
                  <input
                    checked={printerDraft.printReceiptsAndBills}
                    onChange={(event) =>
                      updatePrinterDraft({
                        printReceiptsAndBills: event.target.checked
                      })
                    }
                    type="checkbox"
                  />
                  <span>พิมพ์ใบเสร็จและบิล</span>
                </label>
                <label className="printer-switch-row">
                  <input
                    checked={printerDraft.printOrderTickets}
                    onChange={(event) =>
                      updatePrinterDraft({
                        printOrderTickets: event.target.checked
                      })
                    }
                    type="checkbox"
                  />
                  <span>รายการสั่งพิมพ์ / order ticket</span>
                </label>
                <label className="printer-switch-row">
                  <input
                    checked={printerDraft.autoPrintReceipt}
                    onChange={(event) =>
                      updatePrinterDraft({
                        autoPrintReceipt: event.target.checked
                      })
                    }
                    type="checkbox"
                  />
                  <span>พิมพ์ใบเสร็จโดยอัตโนมัติ</span>
                </label>
                <label className="printer-switch-row">
                  <input
                    checked={printerDraft.singleItemTickets}
                    onChange={(event) =>
                      updatePrinterDraft({
                        singleItemTickets: event.target.checked
                      })
                    }
                    type="checkbox"
                  />
                  <span>พิมพ์รายการเดี่ยวต่อคำสั่งซื้อ</span>
                </label>
                <label className="printer-switch-row wide">
                  <input
                    checked={printerDraft.groupIdenticalItems}
                    onChange={(event) =>
                      updatePrinterDraft({
                        groupIdenticalItems: event.target.checked
                      })
                    }
                    type="checkbox"
                  />
                  <span>Group identical items in order tickets</span>
                </label>
              </div>
            </section>

            <section className="printer-ticket-panel">
              <div className="printer-panel-title">
                <h2>กลุ่มของเครื่องพิมพ์</h2>
                <span>ใช้กำหนดปลายทาง เช่น บาร์หรือห้องครัว</span>
              </div>
              <div className="printer-chip-grid">
                {printerGroupOptions.map((group) => (
                  <button
                    className={
                      printerDraft.printerGroups.includes(group.id)
                        ? "selected"
                        : ""
                    }
                    key={group.id}
                    onClick={() => togglePrinterDraftList("printerGroups", group.id)}
                    type="button"
                  >
                    {group.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="printer-ticket-panel">
              <div className="printer-panel-title">
                <h2>หมวดสินค้าที่ให้พิมพ์ที่เครื่องนี้</h2>
                <span>
                  ดึงจากเมนูที่ซิงค์จาก Eden Cafe ถ้าไม่เลือกหมวด ระบบจะถือว่าเครื่องนี้รับทุกหมวด
                </span>
              </div>
              <div className="printer-chip-grid category-chips">
                {productCategories.length ? (
                  productCategories.map((category) => (
                    <button
                      className={
                        printerDraft.categoryFilters.includes(category)
                          ? "selected"
                          : ""
                      }
                      key={category}
                      onClick={() =>
                        togglePrinterDraftList("categoryFilters", category)
                      }
                      type="button"
                    >
                      {category}
                    </button>
                  ))
                ) : (
                  <span className="printer-muted-note">
                    ยังไม่มีหมวดสินค้า กดซิงค์เมนูในแท็บทั่วไปก่อน
                  </span>
                )}
              </div>
            </section>

            <div className="printer-actions">
              <button onClick={handleCreatePrinter} type="button">
                <Plus aria-hidden="true" size={18} />
                New Profile
              </button>
              <button onClick={handleSavePrinter} type="button">
                <Save aria-hidden="true" size={18} />
                Save Profile
              </button>
              <button
                disabled={printerBusy || !bridgeRequired}
                onClick={() => void handleCheckBridge()}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={18} />
                {bridgeRequired ? "Check Bridge" : "No Bridge Needed"}
              </button>
              <button
                className="printer-primary"
                disabled={printerBusy}
                onClick={() => void handleTestPrint()}
                type="button"
              >
                <Printer aria-hidden="true" size={18} />
                Test Print
              </button>
              <button
                className="printer-danger"
                onClick={handleDeletePrinter}
                type="button"
              >
                <Trash2 aria-hidden="true" size={18} />
                Delete
              </button>
            </div>

            <div className={`printer-status-message ${printerStatus.tone}`}>
              {printerStatus.text}
            </div>
          </section>
        </div>

        <section className="printer-help-panel">
          <strong>วิธีใช้งานให้เหมือนระบบ POS Website</strong>
          <ul>
            <li>WiFi/LAN: รัน Eden Print Bridge แล้วใส่ IP เครื่องพิมพ์กับ port 9100</li>
            <li>Serial/USB/Bluetooth: ใช้ได้เมื่อ WebView หรือ browser รองรับ Web API นั้น</li>
            <li>Browser print: ใช้เป็นตัวสำรองสำหรับทดสอบ PDF หรือ driver ปกติ</li>
            <li>ถ้าปิดพิมพ์อัตโนมัติ ให้สั่งพิมพ์เองจากหน้าใบเสร็จรับเงิน</li>
            <li>Order ticket จะพิมพ์เฉพาะหมวดสินค้าที่เลือก เช่น เครื่องดื่มไปบาร์ อาหารไปห้องครัว</li>
          </ul>
        </section>
      </div>
    );
  };

  const renderDisplayPanel = () => (
    <>
      <div className="customer-display-settings">
        <section className="customer-display-status-card">
          <div className="settings-empty-icon">
            <Monitor aria-hidden="true" size={70} />
          </div>
          <div>
            <span>Customer Facing Display</span>
            <strong>
              {customerDisplaySettings.enabled
                ? "เปิดระบบจอฝั่งลูกค้าแล้ว"
                : "ยังไม่ได้เปิดระบบจอฝั่งลูกค้า"}
            </strong>
            <p>{customerDisplayStatus}</p>
          </div>
        </section>

        <section className="customer-display-settings-grid">
          <label className="printer-switch-row">
            <input
              checked={customerDisplaySettings.enabled}
              onChange={(event) =>
                updateCustomerDisplaySettings({ enabled: event.target.checked })
              }
              type="checkbox"
            />
            เปิดใช้งานจอฝั่งลูกค้า
          </label>
          <label className="printer-switch-row">
            <input
              checked={customerDisplaySettings.nativePresentation}
              onChange={(event) =>
                updateCustomerDisplaySettings({
                  nativePresentation: event.target.checked
                })
              }
              type="checkbox"
            />
            ใช้จอที่สองในเครื่อง POS แบบ SUNMI/iMin
          </label>
          <label className="printer-switch-row">
            <input
              checked={customerDisplaySettings.showLineItems}
              onChange={(event) =>
                updateCustomerDisplaySettings({
                  showLineItems: event.target.checked
                })
              }
              type="checkbox"
            />
            แสดงรายการสินค้าให้ลูกค้าเห็น
          </label>
          <label className="printer-switch-row">
            <input
              checked={customerDisplaySettings.showQr}
              onChange={(event) =>
                updateCustomerDisplaySettings({ showQr: event.target.checked })
              }
              type="checkbox"
            />
            แสดง QR PromptPay เมื่อมีออเดอร์
          </label>
        </section>

        <section className="settings-detail-section customer-display-copy-card">
          <h2>ข้อความหน้าจอว่าง</h2>
          <label className="settings-field">
            หัวข้อ
            <input
              onChange={(event) =>
                updateCustomerDisplaySettings({ idleMessage: event.target.value })
              }
              value={customerDisplaySettings.idleMessage}
            />
          </label>
          <label className="settings-field">
            ข้อความรอง
            <input
              onChange={(event) =>
                updateCustomerDisplaySettings({ promoMessage: event.target.value })
              }
              value={customerDisplaySettings.promoMessage}
            />
          </label>
        </section>

        <section className="customer-display-actions">
          <button
            disabled={customerDisplayBusy}
            onClick={() => void handleCheckCustomerDisplay()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={18} />
            ตรวจจอที่สอง
          </button>
          <button
            className="printer-primary"
            disabled={customerDisplayBusy}
            onClick={() => void handleStartCustomerDisplay()}
            type="button"
          >
            <Monitor aria-hidden="true" size={18} />
            เริ่มจอฝั่งลูกค้า
          </button>
          <button onClick={handleOpenCustomerDisplayPreview} type="button">
            <ExternalLink aria-hidden="true" size={18} />
            เปิด Preview
          </button>
          <button
            className="printer-danger"
            disabled={customerDisplayBusy}
            onClick={() => void handleStopCustomerDisplay()}
            type="button"
          >
            <Trash2 aria-hidden="true" size={18} />
            ปิดจอ
          </button>
        </section>

        <section className="printer-help-panel">
          <strong>รูปแบบที่รองรับ</strong>
          <ul>
            <li>เครื่อง POS มีจอที่สองในตัว: ใช้ Android Presentation เพื่อส่งยอดรวมและรายการไปที่จอลูกค้า</li>
            <li>คอมพิวเตอร์หรือจอเสริม: กดเปิด Preview แล้วลากหน้าต่างไปไว้จอที่สอง</li>
            <li>อุปกรณ์อีกเครื่องใน WiFi เดียวกัน: โครงระบบพร้อมต่อยอดเป็นการจับคู่ผ่านรหัสหรือ QR ในเฟสถัดไป</li>
          </ul>
        </section>
      </div>
      <div className="settings-empty-state">
        <div className="settings-empty-icon">
          <Monitor aria-hidden="true" size={86} />
        </div>
        <strong>ยังไม่ได้เชื่อมต่อจอแสดงผล</strong>
        <span>ตั้งค่าจอฝั่งลูกค้าสำหรับแสดงยอดชำระและรายการสินค้า</span>
      </div>
      <button
        aria-label="เพิ่มจอแสดงผล"
        className="settings-fab"
        type="button"
      >
        <Plus size={34} />
      </button>
    </>
  );

  const renderTaxPanel = () => (
    <div className="settings-detail-stack compact-settings-stack">
      <section className="settings-detail-section">
        <h2>ภาษี</h2>
        <label className="settings-field">
          ภาษีรวมในราคา (%)
          <input
            min="0"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                taxRate: Number(event.target.value) / 100
              }))
            }
            type="number"
            value={taxPercent}
          />
        </label>
      </section>
      <button
        className="primary-action settings-save-button"
        disabled={!canSave}
        onClick={() => void saveSettings()}
        type="button"
      >
        <Save aria-hidden="true" size={20} />
        บันทึกตั้งค่า
      </button>
    </div>
  );

  const renderSecurityPanel = () => (
    <div className="settings-detail-stack compact-settings-stack">
      <section className="settings-detail-section settings-security">
        <div className="settings-auth-head">
          <LockKeyhole aria-hidden="true" size={20} />
          <div>
            <strong>ล็อกหน้าจอ POS</strong>
            <span>ล็อกอัตโนมัติเมื่อไม่มีการใช้งาน และปลดล็อกด้วย PIN</span>
          </div>
        </div>

        <label className="security-toggle">
          <input
            checked={securityEnabled}
            onChange={(event) => setSecurityEnabled(event.target.checked)}
            type="checkbox"
          />
          เปิดใช้งานระบบล็อกหน้าจอ
        </label>

        <div
          className="security-timeout-grid"
          role="group"
          aria-label="เวลาพักจอก่อนล็อก"
        >
          {(["3", "5"] as const).map((value) => (
            <button
              className={timeoutPreset === value ? "selected" : ""}
              key={value}
              onClick={() => {
                setTimeoutPreset(value);
                setCustomTimeout(Number(value));
              }}
              type="button"
            >
              {value} นาที
            </button>
          ))}
          <button
            className={timeoutPreset === "custom" ? "selected" : ""}
            onClick={() => setTimeoutPreset("custom")}
            type="button"
          >
            กำหนดเอง
          </button>
          <label>
            นาที
            <input
              disabled={timeoutPreset !== "custom"}
              min="1"
              onChange={(event) =>
                setCustomTimeout(Math.max(1, Number(event.target.value)))
              }
              type="number"
              value={customTimeout}
            />
          </label>
        </div>

        <div className="security-pin-grid">
          <label>
            {hasSecurityPin ? "PIN ใหม่" : "ตั้ง PIN"}
            <input
              autoComplete="new-password"
              inputMode="numeric"
              maxLength={12}
              onChange={(event) =>
                setPin(event.target.value.replace(/\D/g, "").slice(0, 12))
              }
              placeholder={
                hasSecurityPin
                  ? "เว้นไว้ถ้าไม่เปลี่ยน"
                  : "อย่างน้อย 4 หลัก"
              }
              type="password"
              value={pin}
            />
          </label>
          <label>
            ยืนยัน PIN
            <input
              autoComplete="new-password"
              inputMode="numeric"
              maxLength={12}
              onChange={(event) =>
                setPinConfirm(
                  event.target.value.replace(/\D/g, "").slice(0, 12)
                )
              }
              placeholder="กรอกซ้ำเพื่อยืนยัน"
              type="password"
              value={pinConfirm}
            />
          </label>
        </div>

        <small className={securityCanSave ? "" : "warning"}>
          {securityMessage}
        </small>
      </section>

      <button
        className="primary-action settings-save-button"
        disabled={!canSave}
        onClick={() => void saveSettings()}
        type="button"
      >
        <Save aria-hidden="true" size={20} />
        บันทึกตั้งค่า
      </button>
    </div>
  );

  const renderGeneralPanel = () => (
    <div className="settings-detail-stack">
      <section className="settings-detail-section settings-print-logo">
        <div className="settings-auth-head">
          <ImageIcon aria-hidden="true" size={20} />
          <div>
            <strong>โลโก้สำหรับปริ้นใบเสร็จ</strong>
            <span>ไฟล์ .webp จะแสดงบนสุดของใบปริ้น 80mm</span>
          </div>
        </div>

        <div className="slip-template-grid">
          <div className="slip-template-form">
            <div className="print-logo-control">
              <div
                className={`print-logo-preview ${
                  form.printLogoDataUrl ? "has-logo" : ""
                }`}
              >
                {form.printLogoDataUrl ? (
                  <img
                    alt="โลโก้สำหรับปริ้นใบเสร็จ"
                    src={form.printLogoDataUrl}
                  />
                ) : (
                  <ImageIcon aria-hidden="true" size={32} />
                )}
              </div>
              <div className="print-logo-actions">
                <label className="settings-file-button">
                  <ImageUp aria-hidden="true" size={18} />
                  อัปโหลด .webp
                  <input
                    accept="image/webp,.webp"
                    onChange={handleLogoFile}
                    type="file"
                  />
                </label>
                {form.printLogoDataUrl && (
                  <button onClick={clearPrintLogo} type="button">
                    <Trash2 aria-hidden="true" size={18} />
                    ลบโลโก้
                  </button>
                )}
                <small>
                  {logoMessage}
                  {form.printLogoFileName ? ` · ${form.printLogoFileName}` : ""}
                  {form.printLogoDataUrl && logoUpdatedLabel
                    ? ` · ล่าสุด ${logoUpdatedLabel}`
                    : ""}
                </small>
              </div>
            </div>

            <div className="settings-form-grid slip-form-grid">
              <label className="settings-field">
                ชื่อย่อ / ชื่อร้านบนหัวสลิป
                <input
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      receiptHeaderBusinessName: event.target.value
                    }))
                  }
                  placeholder="Eden Cafe"
                  value={form.receiptHeaderBusinessName ?? ""}
                />
              </label>
              <label className="settings-field">
                สาขา
                <input
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      receiptHeaderBranch: event.target.value
                    }))
                  }
                  placeholder="สำนักงานใหญ่"
                  value={form.receiptHeaderBranch ?? ""}
                />
              </label>
              <label className="settings-field wide">
                ที่อยู่บนหัวสลิป
                <textarea
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      receiptHeaderAddress: event.target.value
                    }))
                  }
                  placeholder="บ้านเลขที่ / ถนน / ตำบล / อำเภอ / จังหวัด"
                  rows={3}
                  value={form.receiptHeaderAddress ?? ""}
                />
              </label>
              <label className="settings-field">
                เลขผู้เสียภาษี
                <input
                  inputMode="numeric"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      receiptTaxId: event.target.value
                    }))
                  }
                  placeholder="010555..."
                  value={form.receiptTaxId ?? ""}
                />
              </label>
              <label className="settings-field">
                เบอร์โทร
                <input
                  inputMode="tel"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      receiptPhone: event.target.value
                    }))
                  }
                  placeholder="08x-xxx-xxxx"
                  value={form.receiptPhone ?? ""}
                />
              </label>
              <label className="settings-field">
                เว็บไซต์
                <input
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      receiptWebsite: event.target.value
                    }))
                  }
                  placeholder="www.edencafe.co"
                  value={form.receiptWebsite ?? ""}
                />
              </label>
              <label className="settings-field">
                ชื่อเอกสารบนสลิป
                <input
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      receiptTitle: event.target.value
                    }))
                  }
                  placeholder="ใบกำกับภาษีอย่างย่อ/ใบเสร็จรับเงิน"
                  value={form.receiptTitle ?? ""}
                />
              </label>
              <label className="settings-field wide">
                ข้อความท้ายสลิป
                <textarea
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      receiptFooterNote: event.target.value
                    }))
                  }
                  placeholder="ขอบคุณที่สนับสนุน Eden Cafe"
                  rows={3}
                  value={form.receiptFooterNote ?? ""}
                />
              </label>
              <label className="settings-field">
                ข้อความภาษีท้ายสลิป
                <input
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      receiptFooterTaxNote: event.target.value
                    }))
                  }
                  placeholder="VAT INCLUDED"
                  value={form.receiptFooterTaxNote ?? ""}
                />
              </label>
            </div>
          </div>

          <aside className="slip-preview-card" aria-label="ตัวอย่างสลิป">
            <div className="slip-preview-title">
              <FileText aria-hidden="true" size={18} />
              ตัวอย่างสลิป 80mm
            </div>
            <div className="slip-preview-paper">
              {form.printLogoDataUrl && (
                <img
                  alt="โลโก้ตัวอย่างบนสลิป"
                  className="slip-preview-logo"
                  src={form.printLogoDataUrl}
                />
              )}
              <div className="slip-preview-header">
                {slipHeaderPreviewLines.map((line, index) => (
                  <span
                    className={index === 0 ? "strong" : ""}
                    key={`${line}-${index}`}
                  >
                    {line}
                  </span>
                ))}
              </div>
              <div className="slip-preview-rule" />
              <div className="slip-preview-document">
                <strong>{slipPreviewTitle}</strong>
                <span>วันที่</span>
              </div>
              <div className="slip-preview-meta">
                <div>
                  <span>{form.receiptPrefix || "POS"}-20260602-001</span>
                  <span>02/06/2026</span>
                </div>
              </div>
              <div className="slip-preview-rule dotted" />
              <div className="slip-preview-items">
                <div>
                  <span>1.00 กาแฟ Cold Brew / เย็น</span>
                  <span>119.00</span>
                </div>
                <div>
                  <span>1.00 เกี๊ยวหมู</span>
                  <span>79.00</span>
                </div>
              </div>
              <div className="slip-preview-rule dotted" />
              <div className="slip-preview-totals">
                <div>
                  <span>ส่วนลดรวม</span>
                  <span>0.00</span>
                </div>
                <div>
                  <span>ภาษีมูลค่าเพิ่ม</span>
                  <span>13.86</span>
                </div>
                <div className="strong">
                  <span>ยอดรวมสุทธิ</span>
                  <span>198.00</span>
                </div>
              </div>
              <div className="slip-preview-footer">
                {form.receiptFooterTaxNote && (
                  <strong>{form.receiptFooterTaxNote}</strong>
                )}
                {slipFooterPreviewLines.map((line, index) => (
                  <span key={`${line}-${index}`}>{line}</span>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section className="settings-detail-section">
        <h2>ข้อมูลร้าน</h2>
        <div className="settings-form-grid">
          <label className="settings-field">
            ชื่อร้าน
            <input
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  name: event.target.value
                }))
              }
              value={form.name}
            />
          </label>
          <label className="settings-field">
            Prefix ใบเสร็จ
            <input
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  receiptPrefix: event.target.value.toUpperCase()
                }))
              }
              value={form.receiptPrefix}
            />
          </label>
          <label className="settings-field">
            PromptPay ID
            <select
              className="promptpay-locked-select"
              onChange={(event) => selectPromptPayAccount(event.target.value)}
              value={selectedPromptPayAccount.id}
            >
              {promptPayAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} - {account.promptPayId}
                </option>
              ))}
            </select>
            <small className="promptpay-locked-note">
              เลขพร้อมเพย์ถูกล็อกจากหลังบ้าน เลือกได้เฉพาะบัญชีที่แอดมินอนุมัติ
            </small>
          </label>
          <label className="settings-field">
            ชื่อร้านบน QR
            <input readOnly value={form.merchantName} />
          </label>
          <label className="settings-field">
            เมือง
            <input readOnly value={form.city} />
          </label>
        </div>
      </section>

      <section className={`settings-sync-panel ${syncState.status}`}>
        <div>
          <strong>เมนูจาก www.edencafe.co</strong>
          <span>{syncState.message}</span>
          {lastSyncedLabel && <small>ล่าสุด {lastSyncedLabel}</small>}
        </div>
        <button
          className="tool-button"
          disabled={syncState.status === "syncing"}
          onClick={() => void onSyncCatalog()}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={18} />
          ซิงค์เมนู
        </button>
      </section>

      <section className="settings-auth">
        <div className="settings-auth-head">
          <ShieldCheck aria-hidden="true" size={20} />
          <div>
            <strong>บัญชีแอดมิน Eden</strong>
            <span>{authLabel || "ยังไม่ได้เข้าสู่ระบบ"}</span>
          </div>
        </div>
        <small>{authMessage}</small>
        {nativeApp && !authLabel && (
          <div className="settings-auth-note">
            <strong>แนะนำสำหรับ APK</strong>
            <span>
              ใช้ Email/Password ที่ตั้งจากหลังบ้านก่อน ส่วน Google Login บน Android
              ต้องเพิ่ม SHA และไฟล์ google-services.json ให้ครบก่อน rebuild
            </span>
          </div>
        )}

        {authLabel ? (
          <button
            className="settings-auth-button"
            disabled={authBusy}
            onClick={() => void handleSignOut()}
            type="button"
          >
            <LogOut aria-hidden="true" size={18} />
            ออกจากระบบ
          </button>
        ) : (
          <div className="settings-auth-form">
            <input
              autoComplete="email"
              onChange={(event) => setAdminEmail(event.target.value)}
              placeholder="อีเมลแอดมิน"
              type="email"
              value={adminEmail}
            />
            <input
              autoComplete="current-password"
              onChange={(event) => setAdminPassword(event.target.value)}
              placeholder="รหัสผ่าน"
              type="password"
              value={adminPassword}
            />
            <button
              className="settings-auth-button"
              disabled={authBusy}
              onClick={() => void handleSignIn()}
              type="button"
            >
              <LogIn aria-hidden="true" size={18} />
              เข้าสู่ระบบ
            </button>
            <button
              className="settings-auth-button reset-auth-button"
              disabled={authBusy}
              onClick={() => void handlePasswordReset()}
              type="button"
            >
              <KeyRound aria-hidden="true" size={18} />
              ตั้ง/รีเซ็ตรหัสผ่าน
            </button>
            <button
              className="settings-auth-button google-auth-button"
              disabled={authBusy}
              onClick={() => void handleGoogleSignIn()}
              type="button"
            >
              <Chrome aria-hidden="true" size={18} />
              {authBusy ? "กำลังเปิด Google..." : "เข้าสู่ระบบด้วย Google"}
            </button>
          </div>
        )}
      </section>

      <button
        className="primary-action settings-save-button"
        disabled={!canSave}
        onClick={() => void saveSettings()}
        type="button"
      >
        <Save aria-hidden="true" size={20} />
        บันทึกตั้งค่า
      </button>
    </div>
  );

  const renderActivePanel = () => {
    if (activeSection === "printers") return renderPrinterPanel();
    if (activeSection === "display") return renderDisplayPanel();
    if (activeSection === "tax") return renderTaxPanel();
    if (activeSection === "security") return renderSecurityPanel();
    return renderGeneralPanel();
  };

  return (
    <section
      aria-label="การตั้งค่า"
      className="settings-screen"
      role="dialog"
    >
      <header className="settings-screen-header">
        <div className="settings-screen-title">
          <button
            aria-label="กลับหน้าขาย"
            className="top-icon-button"
            onClick={onClose}
            title="กลับหน้าขาย"
            type="button"
          >
            <Menu size={26} />
          </button>
          <h1>การตั้งค่า</h1>
        </div>
        <div className="settings-active-title">
          <h2>{activeLabel}</h2>
        </div>
      </header>

      <div className="settings-screen-body">
        <aside className="settings-side-nav">
          <nav aria-label="หมวดตั้งค่า">
            {settingsSections.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  className={section.id === activeSection ? "active" : ""}
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  type="button"
                >
                  <Icon aria-hidden="true" size={24} />
                  <span>{section.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="settings-account-footer">
            <span>{authLabel || "ยังไม่ได้เข้าสู่ระบบ"}</span>
            {authLabel ? (
              <button
                disabled={authBusy}
                onClick={() => void handleSignOut()}
                type="button"
              >
                ออกจากระบบ
              </button>
            ) : (
              <button
                disabled={authBusy}
                onClick={() => setActiveSection("general")}
                type="button"
              >
                เข้าสู่ระบบ
              </button>
            )}
          </div>
        </aside>

        <main className="settings-detail-panel">{renderActivePanel()}</main>
      </div>
    </section>
  );
};
