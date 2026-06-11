import type { CustomerProfile, Receipt } from "../../domain/pos";

const WALK_IN_NAMES = new Set(["walk-in", "walk-in customer"]);

export const isWalkInCustomerName = (name?: string | null) =>
  !name || WALK_IN_NAMES.has(name.trim().toLowerCase());

export const receiptHasCustomerIdentity = (receipt?: Receipt | null) => {
  if (!receipt) return false;

  return Boolean(
    receipt.customerUid ||
      receipt.customerMemberCode ||
      !isWalkInCustomerName(receipt.customerName)
  );
};

export const customerProfileFromReceipt = (
  receipt: Receipt | null | undefined,
  customers: CustomerProfile[] = []
): CustomerProfile | null => {
  if (!receiptHasCustomerIdentity(receipt) || !receipt) {
    return null;
  }

  const uid = receipt.customerUid?.trim() || "";
  const memberCode = receipt.customerMemberCode?.trim() || "";
  const existingCustomer = uid
    ? customers.find((customer) => customer.uid === uid)
    : undefined;

  if (existingCustomer) {
    return existingCustomer;
  }

  return {
    uid: uid || memberCode || `receipt-${receipt.id}`,
    displayName:
      receipt.customerName?.trim() || memberCode || uid || "Walk-in Customer",
    email: receipt.customerEmail,
    phone: receipt.phone || "",
    phoneNormalized: receipt.phone || "",
    lineId: receipt.customerLineId,
    tier: receipt.customerTier || "Silver",
    memberCode: memberCode || uid,
    points: 0,
    profileSynced: Boolean(receipt.customerProfileSynced),
    source: receipt.customerProfileSynced ? "eden" : "local",
    updatedAt: receipt.createdAt
  };
};
