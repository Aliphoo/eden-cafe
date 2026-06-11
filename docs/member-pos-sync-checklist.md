# Eden Cafe Member / POS Sync Verification

Use this checklist after deploying the website, Firestore rules, and Cloud Functions.

## Source Of Truth

- `users`: member identity and public profile fields.
- `orders.customerUid`: member owner for POS orders.
- `orders.uid`: cashier/admin creator for POS orders, legacy/online owner for non-POS orders.
- `member_summaries` and `point_ledger`: loyalty balance and audit trail.

## Manual Flow

1. Register or choose a real member account.
2. Sign in to the member Profile and note current points, total spent, visits, and recent orders.
3. Open POS with an admin account that has `pos` permission.
4. Search the member by phone, email, name, or member code, then sync the customer.
5. Add sellable items and complete a paid POS checkout with soft launch/test mode off.
6. Confirm the receipt is created even if loyalty sync reports a recoverable failure.
7. Reopen the member Profile and confirm the POS receipt appears in order history.
8. Confirm points, total spent, visits, tier, `member_summaries`, and `point_ledger` update once.
9. Open Admin member detail and confirm the same POS receipt appears with online orders and bookings.
10. Repeat checkout in soft launch/test mode and confirm no points or summary totals change.
11. Retry or refresh after a completed sale and confirm loyalty is not double-counted.

## Expected Order Statuses

- Paid POS order with synced member: `loyaltySyncStatus = synced`.
- Paid POS order without member: `loyaltySyncStatus = skipped`, `loyaltyError = no-customer`.
- Test/soft-launch POS order: `loyaltySyncStatus = skipped`, `loyaltyError = test-order`.
- Loyalty function failure: receipt remains valid and `loyaltySyncStatus = failed`.
