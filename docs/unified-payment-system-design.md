# Eden Cafe Web Unified Payment System Design

วันที่ออกแบบ: 2026-06-07

สถานะ: เอกสารออกแบบ backend/payment architecture สำหรับเว็บ `edencafe.co` เท่านั้น ยังไม่เขียนโค้ดจริง ไม่แก้ UI ไม่แก้ CSS ไม่แก้ frontend และไม่ deploy production

ขอบเขต: ใช้แนวทาง Eden Archery Payment เป็น baseline แล้วขยายเป็น Web Payment Core กลางสำหรับ `ARCHERY_BOOKING`, `TABLE_BOOKING`, `ROOM_BOOKING`, `SHOP_ORDER` และ `MEMBERSHIP_REWARD_WEB` ในอนาคต

นอกขอบเขตรอบนี้: POS, POS APK, walk-in payment, ระบบหน้าร้าน, payment flow ของเครื่อง POS, และ role/payment logic สำหรับงานหน้าร้าน

หลักการบังคับ:

- Payment Gateway และ trusted backend/webhook เป็น source of truth ของการยืนยันชำระเงิน
- Frontend ห้าม confirm payment เอง
- Client ห้ามเขียน `payments` โดยตรง
- Client ห้ามแก้ `bookings` หรือ `orders` เป็น `paid`/`confirmed` เอง
- ทุก mutating payment action ต้องมี `idempotency_key`
- Secret ทั้งหมดต้องอยู่ใน Firebase Secret Manager หรือ runtime secret ที่ผ่าน preflight แล้วเท่านั้น
- ห้าม hardcode API key, merchant ID, webhook secret หรือ production key
- Webhook ต้อง verify signature ด้วย raw body ก่อนประมวลผล
- Duplicate webhook และ duplicate `provider_ref` ต้องไม่สร้าง payment ซ้ำ
- Late payment ต้องเข้า `payment_reconciliation_queue`
- Staff/system action ทุกครั้งต้องเขียน `audit_logs`

## 1. Unified Web Payment Architecture

Payment Core ของเว็บควรถูกวางเป็น backend boundary เดียวระหว่างหน้าเว็บทุกหน้าและ payment provider

ส่วนประกอบหลัก:

- Client web pages: Archery booking, table booking, room booking, checkout/shop, profile/order history
- Cloud Functions payment API: entrypoint เดียวสำหรับ create/read/cancel/refund/reconcile payment
- Payment Core service: validate source, amount, currency, status transition, idempotency, allocation, refund และ receipt web
- Provider adapter: Beam เป็น adapter แรก และแยกจาก business logic เพื่อเพิ่ม provider อื่นในอนาคตได้
- Webhook handler: verify signature, dedupe event, validate provider payload, update payment/source ใน transaction
- Service adapters: logic เฉพาะ `ARCHERY_BOOKING`, `TABLE_BOOKING`, `ROOM_BOOKING`, `SHOP_ORDER`, `MEMBERSHIP_REWARD_WEB`
- Reconciliation queue: จัดการ late payment, expired source, amount mismatch, currency mismatch, unknown source
- Audit log: บันทึก staff/system mutation และเหตุการณ์สำคัญจาก webhook
- Firestore rules boundary: client read ตามสิทธิ์, write payment-sensitive collections ผ่าน Cloud Functions เท่านั้น

Flow มาตรฐานของเว็บ:

1. Backend สร้าง source เช่น booking hold หรือ shop order draft
2. Client เรียก `createPaymentIntent` พร้อม `branch_id`, `service_type`, `source_type`, `source_id`, `provider`, `idempotency_key`
3. Backend อ่าน source และตรวจ owner/branch/status/expiry/amount/currency
4. Backend สร้างหรือ reuse `payments` status `PENDING`
5. Backend เรียก Beam/provider adapter ด้วย provider idempotency key
6. Client ได้เฉพาะ sanitized payment response เช่น `payment_id`, `payment_link_url`, `status`
7. Provider ส่ง webhook กลับมา
8. Webhook verify signature, event whitelist, merchant/env, `provider_ref`, amount, currency, source status
9. Firestore transaction update `payments`, source status, allocation/refund/reconciliation และ audit log
10. Customer/staff อ่านสถานะผ่าน API หรือ Firestore read-only policy เท่านั้น

Baseline ที่ต้อง generalize จาก Archery Payment:

- ใช้ Secret Manager สำหรับ Beam sandbox/production secret
- แยก `payment_env` และ live flag เพื่อป้องกัน sandbox/production mismatch
- ใช้ idempotent transaction สำหรับ mutating action
- ใช้ `payment_webhook_events` เพื่อกัน webhook replay
- ใช้ `provider_ref` เพื่อกัน double payment ข้าม source
- ถ้า provider paid แต่ source expired/cancelled ต้องเป็น `PAID_PENDING_REVIEW` และเข้า reconciliation
- ไม่ให้ customer เรียก confirm payment เอง

## 2. Firestore Data Model

### `payments`

เอกสารหลักของ payment attempt หรือ terminal online payment สำหรับเว็บ

Field สำคัญ:

- `payment_id`: string, doc id
- `branch_id`: string
- `member_id`: string optional
- `source_type`: `BOOKING`, `ORDER`, `MEMBERSHIP`, `REWARD`
- `source_id`: id ของ booking/order/source document
- `service_type`: `ARCHERY_BOOKING`, `TABLE_BOOKING`, `ROOM_BOOKING`, `SHOP_ORDER`, `MEMBERSHIP_REWARD_WEB`
- `provider`: `BEAM` หรือ provider online อื่นในอนาคต
- `payment_env`: `sandbox`, `production`
- `amount`: number major unit
- `amount_minor`: number minor unit สำหรับ provider
- `currency`: `THB`
- `status`: canonical payment status
- `provider_status`: raw/normalized provider status
- `provider_ref`: unique provider reference เช่น Beam charge/paymentLink id
- `provider_payment_link_id`: provider link id ถ้ามี
- `payment_link_url`: sanitized payment URL
- `idempotency_key`: key จาก client/staff API call
- `idempotency_hash`: payload hash optional
- `receipt_id`: web receipt id ถ้ามี
- `refund_status`: summary ของ refund
- `refund_amount`: total refunded amount
- `metadata`: sanitized service/provider metadata
- `created_at`, `updated_at`, `paid_at`, `failed_at`, `cancelled_at`, `refunded_at`

Index/unique guard:

- `branch_id + created_at`
- `service_type + source_id`
- `source_type + source_id + status`
- `provider + payment_env + provider_ref`
- `member_id + created_at`

Duplicate protection ต้องทำใน transaction ด้วย deterministic doc id หรือ query guard บน `provider + payment_env + provider_ref`

### `payment_items`

Line items สำหรับ audit amount

- `payment_item_id`
- `payment_id`
- `branch_id`
- `source_type`
- `source_id`
- `service_type`
- `item_type`: `PACKAGE`, `TABLE_DEPOSIT`, `ROOM_HOUR`, `PRODUCT`, `SHIPPING`, `DISCOUNT`, `POINT_REDEMPTION`
- `item_ref`
- `name`
- `quantity`
- `unit_price`
- `line_total`
- `currency`
- `created_at`

### `payment_allocations`

ใช้เมื่อ payment หนึ่งก้อนจ่ายหลายส่วน เช่น deposit/balance/shipping/partial refund

- `allocation_id`
- `payment_id`
- `branch_id`
- `source_type`
- `source_id`
- `service_type`
- `allocation_type`: `PRINCIPAL`, `DEPOSIT`, `BALANCE`, `SHIPPING`, `POINT_REDEMPTION`, `REFUND`
- `amount`
- `currency`
- `status`
- `created_at`, `updated_at`

### `payment_webhook_events`

Webhook event log สำหรับ dedupe และ forensic audit

- `webhook_event_id`: deterministic id จาก provider, event type, event identity และ raw body hash
- `branch_id`
- `payment_id`
- `source_type`
- `source_id`
- `service_type`
- `provider`
- `payment_env`
- `event_type`
- `provider_ref`
- `signature_hash`
- `raw_payload_hash`
- `status`: `RECEIVED`, `PROCESSED`, `DUPLICATE`, `DUPLICATE_PAYMENT`, `RECONCILIATION_REQUIRED`, `FAILED_VALIDATION`
- `reconciliation_id`
- `error_code`
- `created_at`, `updated_at`

Raw payload ควรเก็บแบบ redacted หรือเก็บเฉพาะ hash เว้นแต่มี policy ชัดเจนว่าไม่มีข้อมูลอ่อนไหว

### `payment_reconciliation_queue`

Queue สำหรับ paid event ที่ไม่ควร confirm source อัตโนมัติ

- `reconciliation_id`
- `branch_id`
- `payment_id`
- `source_type`
- `source_id`
- `service_type`
- `member_id`
- `provider`
- `payment_env`
- `provider_ref`
- `amount`
- `amount_minor`
- `currency`
- `reason`: `HOLD_EXPIRED`, `SOURCE_CANCELLED`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `UNKNOWN_SOURCE`, `DUPLICATE_CONFLICT`
- `status`: `OPEN`, `REVIEWED`, `REFUND_REQUIRED`, `RESOLVED`, `CLOSED`
- `reviewed_by`, `reviewed_at`
- `resolution_note`
- `created_at`, `updated_at`

### `refund_requests`

คำขอ refund ก่อนอนุมัติ

- `refund_request_id`
- `branch_id`
- `payment_id`
- `source_type`
- `source_id`
- `service_type`
- `member_id`
- `requested_amount`
- `max_refundable_amount`
- `reason`
- `status`: `REQUESTED`, `APPROVED`, `REJECTED`, `CANCELLED`
- `requested_by`
- `approved_by`
- `created_at`, `updated_at`, `approved_at`

### `refunds`

รายการ refund ที่อนุมัติ/ส่ง provider แล้ว

- `refund_id`
- `refund_request_id`
- `payment_id`
- `branch_id`
- `provider`
- `payment_env`
- `provider_ref`
- `provider_refund_ref`
- `amount`
- `currency`
- `status`: `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED`
- `idempotency_key`
- `created_by`
- `created_at`, `updated_at`, `refunded_at`

### `receipts`

ใช้เฉพาะ web receipt ถ้าธุรกิจต้องการออกหลักฐานจาก booking/order web payment

- `receipt_id`
- `branch_id`
- `payment_id`
- `source_type`
- `source_id`
- `service_type`
- `receipt_no`
- `member_id`
- `amount`
- `currency`
- `payment_method`
- `issued_at`
- `voided_at`
- `voided_by`
- `status`: `ISSUED`, `VOIDED`

### `audit_logs`

ใช้ schema เดิมและขยาย target ได้:

- `audit_log_id`
- `branch_id`
- `actor_id`
- `actor_role`
- `actor_type`: `CUSTOMER`, `STAFF`, `SYSTEM`
- `staff_session_id`
- `action`
- `target_collection`
- `target_id`
- `before_snapshot`
- `after_snapshot`
- `reason`
- `request_id`
- `created_at`

### `idempotency_keys`

- doc id จาก `branch_id + action + sha256(idempotency_key)`
- `payload_hash`
- `response`
- `actor_id`
- `expires_at`
- client อ่าน/เขียนไม่ได้

## 3. Payment Status Standard

Canonical status สำหรับเว็บ:

- `UNPAID`: source ต้องจ่าย แต่ยังไม่มี payment attempt
- `PENDING`: สร้าง provider intent/link แล้ว ยังไม่ terminal
- `PAID_ONLINE`: provider/webhook ยืนยันว่าจ่ายสำเร็จ
- `FAILED`: provider แจ้ง failed หรือ payment attempt ล้มเหลว
- `CANCELLED`: payment/source ถูกยกเลิกก่อนจ่ายสำเร็จ
- `REFUND_REQUESTED`: มี refund request เปิดอยู่
- `REFUNDED`: refund เต็มจำนวนสำเร็จ
- `PARTIALLY_REFUNDED`: refund บางส่วนสำเร็จ
- `PAID_PENDING_REVIEW`: provider แจ้งจ่ายสำเร็จ แต่ source expired/cancelled/mismatch/ต้องตรวจสอบ

ห้ามใช้ status สำหรับงานหน้าร้านในรอบนี้

Mapping กับ source status:

### Archery Booking

- Booking `HELD` + payment `UNPAID`: hold lane แล้ว ยังไม่สร้าง payment link
- Booking `HELD` + payment `PENDING`: มี Beam link แล้ว รอ webhook
- Booking `CONFIRMED` + payment `PAID_ONLINE`: webhook สำเร็จและ resource lock ถูก confirm
- Booking unchanged + payment `PAID_PENDING_REVIEW`: hold หมดอายุหรือ status ไม่ตรง ต้อง reconcile
- Booking `CANCELLED` + payment `REFUND_REQUESTED/REFUNDED`: cancel/refund flow

### Table Booking

- Table booking `HELD` + payment `UNPAID/PENDING`: รอ deposit/full payment
- Table booking `CONFIRMED` + payment `PAID_ONLINE`: deposit/full payment สำเร็จ
- Table booking `CHECKED_IN`: operational status ไม่ใช่ payment confirmation
- Table booking `CANCELLED` + payment `REFUND_REQUESTED/REFUNDED`: refund ตาม policy
- Table booking `NO_SHOW`: policy ตัดสินว่าคืนเงินหรือไม่

### Room Booking

- Room booking `HELD` + payment `UNPAID/PENDING`: รอชำระ package/deposit
- Room booking `CONFIRMED` + payment `PAID_ONLINE`: reserve สำเร็จ
- Room booking `CHECKED_IN/CHECKED_OUT`: operational lifecycle
- Room booking `NO_SHOW/CANCELLED`: อาจเปิด refund request หรือ mark non-refundable

### Shop Order

- Order `PENDING_PAYMENT` + payment `UNPAID/PENDING`: order รอจ่าย
- Order `PAID` หรือ `PROCESSING` + payment `PAID_ONLINE`: webhook ยืนยันแล้ว เริ่ม fulfillment ได้
- Order `SHIPPED/COMPLETED`: shipping/fulfillment status แยกจาก payment status
- Order `CANCELLED` + payment `CANCELLED/REFUND_REQUESTED/REFUNDED`
- Order fulfilled + payment `PARTIALLY_REFUNDED`: partial refund ไม่ลบ payment history

Legacy compatibility:

- `orders.paymentStatus` เดิมที่เป็น `pending`, `paid`, `failed`, `refunded` ต้องกลายเป็น derived summary field
- หลัง migrate แล้ว source of truth คือ `payments.status` ที่มาจาก backend/webhook เท่านั้น
- Checkout frontend ต้องไม่เป็น path ที่ทำให้ order กลายเป็น paid ได้

## 4. API Contract

ทุก API ต้อง return `{ ok: true, ... }` เมื่อสำเร็จ และ error response แบบมี `code` โดยไม่เปิดเผย secret/provider raw detail

### `createPaymentIntent`

- Purpose: สร้าง payment attempt กลางสำหรับ service เว็บ
- Input: `branch_id`, `service_type`, `source_type`, `source_id`, `provider`, `idempotency_key`, optional `return_url`
- Output: `payment_id`, `status`, `provider`, `payment_env`, `payment_link_url`, `expires_at`, `amount`, `currency`, `replayed`
- Required role: `CUSTOMER` สำหรับ source ของตัวเอง, `ARCHERY_STAFF/MANAGER/OWNER` สำหรับ staff-created source ตาม branch
- Idempotency: required
- Collections read: source collection, existing `payments`, `idempotency_keys`
- Collections write: `payments`, `payment_items`, source payment summary fields, `audit_logs`, `idempotency_keys`
- Transaction required: yes for Firestore mutation; provider call ใช้ pre-check/post-write idempotency pattern
- Audit log: required

### `createBeamPayment`

- Purpose: Beam adapter สำหรับ payment link/intent
- Input: source snapshot, `payment_id`, amount/currency, idempotency key, env
- Output: `provider_ref`, `payment_link_url`, redacted provider response
- Required role: internal only via `createPaymentIntent`
- Idempotency: provider idempotency key required
- Collections read/write: no direct Firestore write except through caller
- Transaction required: no provider call inside Firestore transaction
- Audit log: caller logs

### `getPaymentStatus`

- Purpose: อ่าน payment/source status ล่าสุด
- Input: `branch_id`, `payment_id` or `source_type + source_id`
- Output: canonical payment status, source status, sanitized payment fields
- Required role: `CUSTOMER` owner only, staff by branch permission
- Idempotency: not required
- Collections read: `payments`, source collection
- Collections write: none
- Transaction required: optional read transaction
- Audit log: not required for normal reads

### `paymentWebhook`

- Purpose: รับ provider webhook และ update payment/source
- Input: raw HTTP body, provider headers, event headers
- Output: `status`, `payment_id`, `source_id`, optional `reconciliation_id`
- Required role: `SYSTEM`; trust มาจาก signature verification ไม่ใช่ customer/staff auth
- Idempotency: event identity + raw body hash
- Collections read: `payments`, source collection, `payment_webhook_events`
- Collections write: `payment_webhook_events`, `payments`, source collection, `payment_reconciliation_queue`, `audit_logs`, optional `receipts`
- Transaction required: yes
- Audit log: required for terminal mutation and reconciliation

### `requestRefund`

- Purpose: เปิด refund request โดยไม่ refund เงินทันที
- Input: `branch_id`, `payment_id`, `source_type`, `source_id`, `amount`, `reason`, `idempotency_key`
- Output: `refund_request_id`, `status`
- Required role: `CUSTOMER` owner can request, staff can request by branch
- Idempotency: required
- Collections read: `payments`, source collection, existing refunds
- Collections write: `refund_requests`, payment summary `REFUND_REQUESTED`, `audit_logs`, `idempotency_keys`
- Transaction required: yes
- Audit log: required

### `approveRefund`

- Purpose: manager/owner อนุมัติ refund และ optionally call provider refund API
- Input: `branch_id`, `refund_request_id`, `approval_action`, `amount`, `staff_session_id`, `idempotency_key`
- Output: `refund_id`, `refund_status`, updated payment status
- Required role: `MANAGER`, `OWNER`
- Idempotency: required
- Collections read: `refund_requests`, `payments`, source collection, `staff_sessions`
- Collections write: `refunds`, `refund_requests`, `payments`, source refund summary, `payment_allocations`, `audit_logs`, `idempotency_keys`
- Transaction required: yes for Firestore mutation; provider refund call ใช้ pre/post pattern
- Audit log: required

### `reconcileLatePayment`

- Purpose: resolve `PAID_PENDING_REVIEW` หรือ queue item
- Input: `branch_id`, `reconciliation_id`, `action`, `staff_session_id`, `reason`, `idempotency_key`
- Output: reconciliation status and optional source/payment updates
- Required role: `MANAGER`, `OWNER`
- Idempotency: required for mutating resolution
- Collections read: `payment_reconciliation_queue`, `payments`, source collection, `staff_sessions`
- Collections write: queue item, `payments`, source collection, optional `refund_requests`, `audit_logs`, `idempotency_keys`
- Transaction required: yes
- Audit log: required

### `cancelPendingPayment`

- Purpose: cancel non-terminal pending payment attempt
- Input: `branch_id`, `payment_id` or `source_type + source_id`, `reason`, `idempotency_key`
- Output: payment/source status
- Required role: `CUSTOMER` owner for own pending payment, staff by branch
- Idempotency: required
- Collections read: `payments`, source collection
- Collections write: `payments`, source payment summary, `audit_logs`, `idempotency_keys`
- Transaction required: yes
- Audit log: required

### `listPaymentsForSource`

- Purpose: อ่าน payment attempts ของ source เดียว
- Input: `branch_id`, `source_type`, `source_id`
- Output: sanitized payment list
- Required role: `CUSTOMER` owner only, staff by branch
- Idempotency: not required
- Collections read: `payments`, source collection
- Collections write: none
- Transaction required: no
- Audit log: not required

### `issueWebReceipt`

- Purpose: issue หรือ re-issue web receipt หลัง paid status
- Input: `branch_id`, `payment_id`, optional `receipt_format`, `staff_session_id`, `idempotency_key`
- Output: `receipt_id`, `receipt_no`, issued fields
- Required role: `SYSTEM` after webhook หรือ `MANAGER/OWNER` สำหรับ re-issue/void
- Idempotency: required
- Collections read: `payments`, source collection, existing `receipts`
- Collections write: `receipts`, payment `receipt_id`, `audit_logs`, `idempotency_keys`
- Transaction required: yes
- Audit log: required for staff re-issue/void

## 5. Webhook / Reconciliation Design

Webhook endpoint คือทางเดียวที่ mark online payment เป็น paid

Beam webhook processing:

1. Accept เฉพาะ `POST`
2. Read raw body ก่อน parse
3. Load webhook secret จาก Secret Manager ตาม `payment_env`
4. Verify `X-Beam-Signature` ด้วย HMAC และ timing-safe compare
5. Validate event type จาก whitelist เช่น `payment_link.paid`, `charge.succeeded`, `charge.failed`, `card_authorization.failed`, `card_authorization.canceled`
6. Validate merchant id และ payment environment
7. Extract `provider_ref`, `referenceId`, `source_id`, `amount`, `currency`
8. Create deterministic `webhook_event_id`
9. Transaction:
   - if event exists: return duplicate success response
   - find payment by `provider + payment_env + provider_ref`
   - if provider ref belongs to another source: fail and open investigation/reconciliation
   - read source
   - validate amount/currency/status/expiry
   - update payment/source or enqueue reconciliation
   - write webhook event status
   - write audit log
10. Return 200 only when event is safely recorded/processed/duplicated

Duplicate protection:

- Duplicate webhook event: same `webhook_event_id` returns `DUPLICATE`
- Duplicate provider payment: same `provider_ref` on same source returns `DUPLICATE_PAYMENT`
- Cross-source provider ref collision: reject and queue investigation
- Same `idempotency_key` with different payload: reject with `IDEMPOTENCY_PAYLOAD_MISMATCH`

Validation rules:

- Amount must match expected source total or valid outstanding balance
- Currency must be `THB`
- Source must exist and belong to expected branch/service
- Source must be payable: not cancelled, not already paid, not expired unless reconciliation
- Provider event must be terminal enough before marking paid
- Payment env must match expected sandbox/production

Late payment handling:

- If provider says paid but source expired/cancelled/not payable, set payment `PAID_PENDING_REVIEW`
- Do not confirm booking/order automatically
- Write `payment_reconciliation_queue`
- Manager/owner resolves via `reconcileLatePayment`
- Resolution options:
  - honor payment and confirm replacement/valid source
  - create refund request
  - link to replacement source
  - close as duplicate/no action after evidence

Retry behavior:

- Provider retry must be idempotent and safe
- Already-recorded event should return 200 duplicate
- Invalid signature returns 401 and writes no terminal payment
- Trusted but mismatched provider payload can write event/queue for review

Monitoring:

- Alert on `payment_reconciliation_queue.status == OPEN` older than SLA
- Alert on signature failure spike
- Alert on amount/currency mismatch
- Alert on production/sandbox env mismatch
- Daily report by branch/service: paid, failed, cancelled, reconciliation, refund

## 6. Service-Specific Web Payment Flows

### `ARCHERY_BOOKING`

Baseline flow:

- Backend creates booking `HELD`, `payment_status = UNPAID`, resource locks `HELD`
- `createPaymentIntent` creates Beam link and payment `PENDING`
- Beam webhook success:
  - validate booking still `HELD`
  - validate hold expiry
  - validate amount/currency
  - update resource locks to `CONFIRMED`
  - update booking `CONFIRMED`
  - update payment `PAID_ONLINE`
  - write audit log
- Late paid event:
  - payment `PAID_PENDING_REVIEW`
  - queue reconciliation
  - no auto lane confirmation

### `TABLE_BOOKING`

Expected web flow:

- Backend creates table booking/hold with `UNPAID`
- Deposit optional:
  - if deposit required, `createPaymentIntent` creates payment for deposit allocation
  - if no deposit required, booking policy decides confirmation without payment core
- Full payment optional:
  - use allocation `BALANCE`
- Webhook paid:
  - confirm booking if hold valid
  - mark deposit/full allocation paid
- Cancellation:
  - unpaid booking can cancel source
  - paid booking opens refund flow based on policy
- Client cannot mark booking paid/confirmed

### `ROOM_BOOKING`

Expected web flow:

- Backend creates room booking with hourly package/payment items
- Deposit/full payment handled by allocations
- Webhook paid confirms booking if room hold valid
- Check-in/check-out are operational statuses
- No-show/cancel policy controls refund request eligibility
- Late payment after room hold expiry enters reconciliation

### `SHOP_ORDER`

Expected web flow:

- Checkout creates order `PENDING_PAYMENT` through backend-controlled path
- `createPaymentIntent` validates cart total, shipping, discount, currency
- Client can redirect to provider but cannot set order paid
- Webhook success:
  - payment `PAID_ONLINE`
  - order `PAID` or `PROCESSING`
  - optional web receipt
  - fulfillment/shipping can start
- Shipping status remains separate from payment status
- Partial refund:
  - `refund_request` -> `refund` -> `payment_allocations`
  - order can remain fulfilled while payment becomes `PARTIALLY_REFUNDED`
- Current/legacy checkout fields such as `paymentStatus` must be derived compatibility fields after migration

### `MEMBERSHIP_REWARD_WEB`

Future flow:

- Points are issued only after terminal `PAID_ONLINE`
- Use payment/order/booking id as idempotency key for point ledger
- Refund creates reverse/adjust reward ledger entry
- Point redemption becomes `payment_items` or `payment_allocations` with `POINT_REDEMPTION`
- Customer cannot trigger point earning by manually changing payment/order state

## 7. Security & RBAC

Roles:

- `CUSTOMER`: own source/payment read, create intent for own payable source, request refund for own payment
- `ARCHERY_STAFF`: branch-scoped service/booking operations only where allowed
- `MANAGER`: refund approval and reconciliation for allowed branch
- `OWNER`: all branch/payment/admin capabilities
- `SYSTEM`: webhook, scheduled jobs, internal processors

Rules:

- Customer can read own payment only
- Customer cannot write `payments`
- Customer cannot confirm payment
- Customer cannot update booking/order payment-confirmed fields
- Staff actions are branch-scoped
- Manager/owner can approve refund and reconcile
- System receives webhook and runs scheduled jobs
- Staff/system actions must write audit log
- Provider secret access restricted to Cloud Functions only

Out of scope: role/payment logic for POS, cashier counter payment, and machine/front-store flows

Preflight before production key use:

- Confirm `payment_env = production`
- Confirm live flag enabled only for production
- Confirm production merchant id/api key/webhook secret exist in Secret Manager
- Confirm return URL domain is `https://edencafe.co`
- Confirm webhook endpoint is deployed and signature validation active
- Confirm no debug/mock customer confirmation flag is enabled
- Confirm Firestore rules deny direct payment writes

## 8. Firestore Rules Policy

Policy หลัก: client read ได้ตาม ownership/staff role แต่ payment-sensitive write ผ่าน Cloud Functions/Admin SDK เท่านั้น

Collection policy:

- `payments`
  - Customer read: own `member_id`/source only
  - Staff read: owner/manager/service staff by branch
  - Client create/update/delete: deny
- `payment_items`
  - Read follows parent payment/source ownership
  - Client write: deny
- `payment_allocations`
  - Customer read own allocation through parent payment/source
  - Staff read by branch
  - Client write: deny
- `payment_webhook_events`
  - Owner/manager read by branch
  - Customer read: deny
  - Client write: deny
- `payment_reconciliation_queue`
  - Owner/manager read by branch
  - Client write: deny
- `refund_requests`
  - Customer read own request
  - Staff read by branch
  - Client write: deny; customer creates through `requestRefund`
- `refunds`
  - Customer read own refund summary
  - Staff read by branch
  - Client write: deny
- `receipts`
  - Customer read own web receipt
  - Staff read by branch
  - Client write: deny
- `audit_logs`
  - Owner/manager read by branch
  - Client write/delete: deny
- `idempotency_keys`
  - Client read/write/delete: deny

Source collection policy:

- `bookings`, `booking_items`, `resource_locks`, `lane_sessions`: direct client write denied for payment-sensitive fields
- `orders`: direct client update to `paymentStatus = paid`, paid timestamps, payment provider refs, or fulfillment unlock fields must be removed/blocked after migration
- Table/room booking collections: client can request/hold through API, but cannot mark payment-confirmed fields

Rule helpers needed:

- `ownsResource()`
- `canReadResourceBranchAsStaff()`
- `canReadResourceBranchAsOwnerManager()`
- `denyWrite()`
- field-level deny for payment confirmation aliases on legacy collections

## 9. Migration / Rollout Plan

Phase 0: Web Payment Audit

- Scan frontend/backend web files for direct `paymentStatus = paid`, direct confirm action, direct payment writes
- Identify all source collections and payment-confirmed fields
- Confirm current Archery webhook, reconciliation, idempotency, audit behavior
- Identify checkout/shop legacy behavior that must become backend/webhook-owned
- No production change

Phase 1: Payment Core Schema

- Add/confirm collections, indexes, rules, audit schema
- Add compatibility mapping for existing `payment_status` and `paymentStatus`
- Do not switch production traffic yet

Phase 2: Unified Beam Webhook Handler

- Generalize current Archery Beam webhook into provider adapter + service router
- Keep old Archery webhook path active until migration passes
- Route events by `referenceId` format เช่น `SERVICE_TYPE:source_id`
- Sandbox replay tests for duplicate, invalid signature, wrong amount, expired source

Phase 3: Archery Migrate To Core

- Move current Archery payment functions onto core abstractions
- Preserve frontend response shape where existing web depends on it
- Verify resource locks, late payment queue, webhook replay, refund path

Phase 4: Shop Orders

- Introduce backend checkout/payment source adapter
- Stop treating frontend `paymentStatus = paid` as source of truth
- Webhook becomes only path to `PAID/PROCESSING`
- Add partial refund allocation support

Phase 5: Table Booking

- Add table source adapter for deposit/full payment
- Add hold expiry and status validation
- Add cancellation/refund policy hooks

Phase 6: Room Booking

- Add room source adapter for package/deposit/full payment
- Add check-in/no-show separation from payment status
- Add late payment reconciliation

Phase 7: Web Reward/Point Integration

- Points earned only after `PAID_ONLINE`
- Point redemption and refund reversal are idempotent ledger actions
- No point mutation from client payment status

Phase 8: Production QA / Monitoring

- Run no-go checklist
- Confirm production secrets by preflight without exposing values
- Confirm Firestore rules deployed to intended project
- Confirm custom domain and Firebase Hosting route to correct functions
- Enable service by service with rollback switch
- Monitor webhook failures and reconciliation queue daily during launch

Rollback principles:

- Do not delete legacy source fields during first rollout
- Write canonical and legacy summary fields until admin/profile views are migrated
- Rollback may disable new create-payment entrypoints but must keep webhook processing active
- Never bypass webhook to fix production payment; use reconciliation/admin audited action

## 10. QA & No-Go Checklist

Required QA cases:

- Payment success updates payment and source exactly once
- Payment failed records `FAILED` and does not confirm source
- Payment cancelled records `CANCELLED` and does not confirm source
- Duplicate webhook returns safe duplicate response and creates no second payment
- Invalid signature returns 401 and creates no terminal payment
- Wrong amount rejects/queues and never confirms source
- Wrong currency rejects/queues and never confirms source
- Expired source creates `PAID_PENDING_REVIEW` and reconciliation item
- Refund request creates `refund_requests` and audit
- Refund approve requires manager/owner and writes `refunds`
- Customer direct write to `payments` denied by Firestore rules
- Customer direct confirm payment denied
- Webhook replay does not duplicate source updates, receipts, points, or allocations
- Reconciliation queue can be reviewed/resolved by manager/owner only
- Audit log exists for staff/system/customer mutating actions
- Shop order cannot become paid from frontend
- Booking cannot become confirmed from frontend payment action
- Reward points are not issued before paid webhook
- Production env mismatch fails closed
- Missing provider secret fails closed
- Provider ref collision across two sources fails closed
- Partial refund keeps paid history and writes allocation/refund records
- Web receipt issue/reissue is idempotent

No-go checklist before production:

- Any frontend path can mark payment as paid/confirmed
- Any client can write `payments`, `payment_items`, `payment_allocations`, `payment_webhook_events`, `payment_reconciliation_queue`, `refunds`, `refund_requests`, `receipts`, or `audit_logs`
- Webhook signature verification is disabled or accepts parsed body instead of raw body
- `idempotency_key` is optional on mutating API
- Production API key/webhook secret is hardcoded or readable by frontend
- Sandbox and production env/live flag mismatch is possible
- Duplicate `provider_ref` can create two terminal payments
- Late payment auto-confirms expired/cancelled source
- Amount/currency mismatch can be marked paid
- Refund approval is available to customer
- Audit log is missing for staff/system mutation
- Reconciliation queue has no manager/owner workflow
- Firestore indexes/rules are not deployed to intended Firebase project
- Monitoring/alert path for webhook failures and reconciliation queue is absent
- Rollback plan would stop webhook processing for already-created provider links

Recommended first implementation boundary:

- Start with Phase 0 audit only
- Keep frontend unchanged initially
- Build Payment Core around current Archery backend first
- Add emulator/rules tests before exposing new endpoints to shop/table/room
- Treat every payment status transition as backend-owned, transactionally written, and auditable
