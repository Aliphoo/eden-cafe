#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const args = new Set(process.argv.slice(2));
const commit = args.has("--commit");
const limitArg = Number(
  [...args]
    .find((arg) => arg.startsWith("--limit="))
    ?.slice("--limit=".length)
);
const maxDocs = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : 0;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

const db = admin.firestore();
const orders = db.collection("orders");
const query = orders
  .where("source", "==", "pos")
  .where("paymentStatus", "==", "paid")
  .where("orderMode", "==", "open_bill");

const timestampToDate = (value) => {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value.toMillis === "function") {
    const date = new Date(value.toMillis());
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
};

const bangkokDateKey = (date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

const bangkokDateLabel = (date) =>
  new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    dateStyle: "short"
  }).format(date);

const bangkokDateTimeLabel = (date) =>
  new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);

const snap = await query.get();
const docs = maxDocs ? snap.docs.slice(0, maxDocs) : snap.docs;
let checked = 0;
let updated = 0;
let skipped = 0;
const unresolved = [];
let batch = db.batch();
let pendingWrites = 0;

const flush = async () => {
  if (!pendingWrites) return;
  if (commit) await batch.commit();
  batch = db.batch();
  pendingWrites = 0;
};

for (const docSnap of docs) {
  checked += 1;
  const data = docSnap.data() || {};
  const paidAtDate = timestampToDate(data.paidAt);
  const closedAtDate = timestampToDate(data.closedAt);
  const sourceDate = paidAtDate || closedAtDate;

  if (!sourceDate) {
    unresolved.push({
      id: docSnap.id,
      receiptNo: data.receiptNo || data.id || "",
      reason: "missing paidAt and closedAt"
    });
    continue;
  }

  const businessDate = bangkokDateKey(sourceDate);
  const patch = {
    businessDate,
    businessDateLabel: bangkokDateLabel(sourceDate),
    date: bangkokDateTimeLabel(sourceDate),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (!paidAtDate && closedAtDate) {
    patch.paidAt = data.closedAt;
  }

  const alreadyAligned =
    data.businessDate === patch.businessDate &&
    data.businessDateLabel === patch.businessDateLabel &&
    data.date === patch.date &&
    (paidAtDate || !closedAtDate);

  if (alreadyAligned) {
    skipped += 1;
    continue;
  }

  updated += 1;
  if (commit) {
    batch.set(docSnap.ref, patch, { merge: true });
    pendingWrites += 1;
    if (pendingWrites >= 400) await flush();
  }
}

await flush();

console.log(
  JSON.stringify(
    {
      mode: commit ? "commit" : "dry-run",
      checked,
      wouldUpdate: commit ? undefined : updated,
      updated: commit ? updated : undefined,
      skipped,
      unresolved
    },
    null,
    2
  )
);
