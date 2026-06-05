import type { PosData } from "../domain/pos";
import edenSlipLogoUrl from "../assets/eden-slip-logo.webp";

export const seedData: PosData = {
  categoryOrder: [],
  store: {
    name: "Eden Cafe",
    taxRate: 0.07,
    receiptPrefix: "POS",
    printLogoDataUrl: edenSlipLogoUrl,
    printLogoFileName: "Logo Eden 2026 slip.webp",
    receiptHeaderBusinessName: "Eden Cafe",
    receiptHeaderBranch: "สำนักงานใหญ่",
    receiptHeaderAddress: "เชียงราย",
    receiptTaxId: "",
    receiptPhone: "",
    receiptWebsite: "www.edencafe.co",
    receiptTitle: "ใบกำกับภาษีอย่างย่อ/ใบเสร็จรับเงิน",
    receiptFooterNote: "ขอบคุณที่สนับสนุน Eden Cafe",
    receiptFooterTaxNote: "VAT INCLUDED",
    promptPayId: "057556001655",
    merchantName: "EDEN CAFE",
    city: "CHIANG RAI",
    promptPayAccountId: "eden-main",
    promptPayAccounts: [
      {
        id: "eden-main",
        label: "Eden Cafe Main",
        promptPayId: "057556001655",
        merchantName: "EDEN CAFE",
        city: "CHIANG RAI",
        order: 1
      }
    ],
    promptPayEnabled: true,
    promptPayLocked: true,
    firebaseProjectId: "edencafe-d9095"
  },
  customers: [],
  loyaltyConfig: {
    enabled: true,
    spendPerPoint: 25,
    pointValue: 1,
    expiryMonths: 24,
    maxRedeemPercent: 30,
    minRedeemPoints: 20,
    earnAfterDiscount: true,
    earnOnRedeemedAmount: false,
    excludedCategories: ["เครื่องดื่มแอลกอฮอล์", "ฝากเงิน", "โปรแรง"],
    tierMultipliers: { Silver: 1, Gold: 1.25, Platinum: 1.5 }
  },
  discounts: [
    { id: "discount-1", label: "ส่วนลด 1%", type: "percent", value: 1, active: true, order: 10 },
    { id: "discount-2", label: "ส่วนลด 2%", type: "percent", value: 2, active: true, order: 20 },
    { id: "discount-5", label: "ส่วนลด 5%", type: "percent", value: 5, active: true, order: 30 },
    { id: "discount-10", label: "ส่วนลด 10%", type: "percent", value: 10, active: true, order: 40 },
    { id: "discount-15", label: "ส่วนลด 15%", type: "percent", value: 15, active: true, order: 50 },
    { id: "discount-20", label: "ส่วนลด 20%", type: "percent", value: 20, active: true, order: 60 },
    { id: "discount-30", label: "ส่วนลด 30%", type: "percent", value: 30, active: true, order: 70 },
    { id: "fish-35", label: "ส่วนลดปลา 35%", type: "percent", value: 35, active: true, order: 80 },
    { id: "project-5", label: "โครงการผาฮี้ 5%", type: "percent", value: 5, active: true, order: 90 },
    { id: "staff-25", label: "ส่วนลดพนักงาน 25%", type: "percent", value: 25, active: true, order: 100 }
  ],
  receipts: [],
  tables: [],
  security: {
    enabled: false,
    lockTimeoutMinutes: 3,
    pinHash: "",
    pinSalt: ""
  },
  products: []
};
