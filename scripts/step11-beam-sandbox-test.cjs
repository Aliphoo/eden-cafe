const http = require('node:http');
const crypto = require('node:crypto');
const admin = require('../functions/node_modules/firebase-admin');

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'edencafe-d9095';
const BRANCH_ID = 'BKK_MAIN';
const BEAM_PORT = Number(process.env.STEP11_FAKE_BEAM_PORT || 7077);
const FUNCTION_BASE = `http://127.0.0.1:5001/${PROJECT_ID}/asia-southeast1`;
const FIRESTORE_REST_BASE = `http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const runId = Date.now().toString(36);
const customerUid = `step11_customer_${runId}`;
const customerEmail = `${customerUid}@example.test`;
const customerPassword = 'Sandbox-Test-12345';
const bookingDate = new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
const startTimes = ['10:00', '11:15', '12:30', '13:45', '15:00', '16:15', '17:30'];
let timeCursor = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoLaneLeak(value, label) {
  const text = JSON.stringify(value);
  assert(!/assigned_resource_id|lane_id|laneId|resource_id/i.test(text), `${label} leaked lane/resource id`);
}

function basicAuth(merchantId, apiKey) {
  return `Basic ${Buffer.from(`${merchantId}:${apiKey}`).toString('base64')}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve({ raw, json: raw ? JSON.parse(raw) : {} });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function startFakeBeam() {
  const requests = [];
  const linksByIdempotencyKey = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/v1/payment-links') {
        const { json } = await readJsonBody(req);
        const expectedAuth = basicAuth(process.env.BEAM_MERCHANT_ID_SANDBOX, process.env.BEAM_API_KEY_SANDBOX);
        if (req.headers.authorization !== expectedAuth) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_auth' }));
          return;
        }
        const idempotencyKey = req.headers['x-beam-idempotency-key'] || `no-key-${requests.length}`;
        let paymentLinkId = linksByIdempotencyKey.get(idempotencyKey);
        if (!paymentLinkId) {
          paymentLinkId = `plink_${runId}_${linksByIdempotencyKey.size + 1}`;
          linksByIdempotencyKey.set(idempotencyKey, paymentLinkId);
        }
        requests.push({ idempotencyKey, body: json });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: paymentLinkId,
          paymentLinkId,
          url: `http://127.0.0.1:${BEAM_PORT}/pay/${paymentLinkId}`,
          status: 'ACTIVE',
          order: json.order,
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(BEAM_PORT, '127.0.0.1', resolve);
  });

  return {
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text };
  }
  return { response, json };
}

async function callFunction(name, body, idToken) {
  const { response, json } = await fetchJson(`${FUNCTION_BASE}/${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:5000',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(`${name} failed: ${response.status} ${JSON.stringify(json)}`);
    error.status = response.status;
    error.payload = json;
    throw error;
  }
  return json;
}

async function callFunctionExpectStatus(name, body, idToken, expectedStatus) {
  const { response, json } = await fetchJson(`${FUNCTION_BASE}/${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:5000',
    },
    body: JSON.stringify(body),
  });
  assert(response.status === expectedStatus, `${name} expected ${expectedStatus}, got ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function signWebhook(raw) {
  const key = Buffer.from(String(process.env.BEAM_WEBHOOK_SECRET_SANDBOX || ''), 'base64');
  return crypto.createHmac('sha256', key).update(Buffer.from(raw)).digest('base64');
}

async function sendWebhook(eventType, payload, options = {}) {
  const raw = JSON.stringify(payload);
  const { response, json } = await fetchJson(`${FUNCTION_BASE}/beamArcheryPaymentWebhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-beam-event': eventType,
      'x-beam-signature': options.invalidSignature ? 'invalid-signature' : signWebhook(raw),
    },
    body: raw,
  });
  return { status: response.status, json };
}

async function setupFirebase() {
  assert(process.env.FIRESTORE_EMULATOR_HOST, 'FIRESTORE_EMULATOR_HOST is required');
  assert(process.env.FIREBASE_AUTH_EMULATOR_HOST, 'FIREBASE_AUTH_EMULATOR_HOST is required');
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();

  await admin.auth().createUser({
    uid: customerUid,
    email: customerEmail,
    password: customerPassword,
  });

  await Promise.all([
    db.collection('users').doc(customerUid).set({
      uid: customerUid,
      email: customerEmail,
      displayName: 'Step 11 Customer',
      role: 'CUSTOMER',
      branch_id: BRANCH_ID,
      primary_branch_id: BRANCH_ID,
      branch_ids: [BRANCH_ID],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
    db.collection('member_summaries').doc(customerUid).set({
      member_id: customerUid,
      uid: customerUid,
      email: customerEmail,
      name: 'Step 11 Customer',
      branch_id: BRANCH_ID,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
  ]);

  const resources = [];
  for (let index = 1; index <= 10; index += 1) {
    const code = `LANE_${String(index).padStart(2, '0')}`;
    resources.push(db.collection('resources').doc(code).set({
      resource_id: code,
      branch_id: BRANCH_ID,
      service_type: 'ARCHERY',
      resource_type_id: 'ARCHERY_LANE',
      code,
      name: code,
      status: 'ACTIVE',
      sort_order: index,
      lane_number: index,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }));
  }
  await Promise.all(resources);

  const signInUrl = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`;
  const { response, json } = await fetchJson(signInUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: customerEmail,
      password: customerPassword,
      returnSecureToken: true,
    }),
  });
  assert(response.ok && json.idToken, `Unable to sign in test customer: ${JSON.stringify(json)}`);
  return { db, idToken: json.idToken };
}

async function createHoldAndPayment(idToken, overrides = {}) {
  const startTime = overrides.start_time || startTimes[timeCursor++ % startTimes.length];
  const hold = await callFunction('createArcheryHold', {
    branch_id: BRANCH_ID,
    member_id: customerUid,
    booking_date: bookingDate,
    start_time: startTime,
    duration_minutes: 60,
    package_code: 'ARCHERY_60',
    amount: 350,
    idempotency_key: `step11_hold_${runId}_${startTime}`,
  }, idToken);
  assert(hold.booking_id, 'createArcheryHold did not return booking_id');
  assertNoLaneLeak(hold, 'createArcheryHold response');

  const directConfirm = await callFunctionExpectStatus('confirmArcheryBooking', {
    branch_id: BRANCH_ID,
    booking_id: hold.booking_id,
    provider_ref: `customer_direct_${hold.booking_id}`,
    idempotency_key: `step11_direct_confirm_${runId}_${hold.booking_id}`,
  }, idToken, 403);
  assert(directConfirm.code === 'PAYMENT_CONFIRM_FORBIDDEN', 'Customer direct confirm should be forbidden');

  const payment = await callFunction('createBeamArcheryPayment', {
    branch_id: BRANCH_ID,
    booking_id: hold.booking_id,
    idempotency_key: `step11_payment_${runId}_${hold.booking_id}`,
  }, idToken);
  assert(payment.payment_status === 'PENDING', 'Beam payment should start as PENDING');
  assert(payment.payment_link_url, 'Beam payment link URL is required');
  assertNoLaneLeak(payment, 'createBeamArcheryPayment response');
  return { hold, payment };
}

function paidPaymentLinkPayload(bookingId, paymentLinkId, overrides = {}) {
  return {
    paymentLinkId,
    merchantId: process.env.BEAM_MERCHANT_ID_SANDBOX,
    url: `http://127.0.0.1:${BEAM_PORT}/pay/${paymentLinkId}`,
    status: overrides.status || 'PAID',
    order: {
      netAmount: overrides.amountMinor ?? 35000,
      currency: overrides.currency || 'THB',
      description: 'Eden Archery',
      referenceId: `ARCHERY:${bookingId}`,
      internalNote: bookingId,
      orderItems: [],
    },
    linkSettings: {
      qrPromptPay: { isEnabled: true },
    },
    collectDeliveryAddress: false,
    collectPhoneNumber: true,
    redirectUrl: 'http://127.0.0.1:5000/archery/booking/confirm',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    feeType: 'TRANSACTION_FEE',
  };
}

function chargePayload(bookingId, paymentLinkId, status = 'FAILED') {
  return {
    chargeId: `ch_${runId}_${Math.random().toString(36).slice(2, 8)}`,
    merchantId: process.env.BEAM_MERCHANT_ID_SANDBOX,
    referenceId: `ARCHERY:${bookingId}`,
    status,
    currency: 'THB',
    amount: 35000,
    source: 'PAYMENT_LINK',
    sourceId: paymentLinkId,
    transactionTime: new Date().toISOString(),
    paymentMethod: { paymentMethodType: 'QR_PROMPT_PAY', qrPromptPay: {} },
    failureCode: status === 'FAILED' ? 'CH_PROCESSING_FAILED' : '',
  };
}

async function expectDirectWriteDenied(collectionName, idToken) {
  const { response, json } = await fetchJson(`${FIRESTORE_REST_BASE}/${collectionName}/step11_direct_${runId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        branch_id: { stringValue: BRANCH_ID },
        member_id: { stringValue: customerUid },
        service_type: { stringValue: 'ARCHERY' },
      },
    }),
  });
  assert(response.status === 403 || response.status === 401, `${collectionName} direct write should be denied, got ${response.status} ${JSON.stringify(json)}`);
}

async function main() {
  assert(process.env.PAYMENT_ENV === 'sandbox', 'PAYMENT_ENV must be sandbox for this test');
  assert(process.env.ARCHERY_PAYMENT_LIVE === 'false', 'ARCHERY_PAYMENT_LIVE must be false');
  assert(process.env.ARCHERY_PAYMENT_PROVIDER === 'BEAM', 'ARCHERY_PAYMENT_PROVIDER must be BEAM');
  assert(process.env.BEAM_API_BASE_URL_SANDBOX === `http://127.0.0.1:${BEAM_PORT}`, 'BEAM_API_BASE_URL_SANDBOX must point to fake Beam');

  const fakeBeam = await startFakeBeam();
  try {
    const { db, idToken } = await setupFirebase();

    const success = await createHoldAndPayment(idToken);
    assert(fakeBeam.requests.length >= 1, 'Fake Beam did not receive payment link create request');
    assert(fakeBeam.requests[0].body.order.referenceId === `ARCHERY:${success.hold.booking_id}`, 'Beam request referenceId mismatch');

    const pendingStatus = await callFunction('getArcheryPaymentStatus', {
      branch_id: BRANCH_ID,
      booking_id: success.hold.booking_id,
    }, idToken);
    assert(pendingStatus.payment_status === 'PENDING', 'Payment status should be PENDING before webhook');
    assertNoLaneLeak(pendingStatus, 'getArcheryPaymentStatus pending response');

    await expectDirectWriteDenied('bookings', idToken);
    await expectDirectWriteDenied('resource_locks', idToken);
    await expectDirectWriteDenied('payments', idToken);
    await expectDirectWriteDenied('payment_webhook_events', idToken);
    await expectDirectWriteDenied('payment_reconciliation_queue', idToken);

    const successPayload = paidPaymentLinkPayload(success.hold.booking_id, success.payment.beam_payment_link_id);
    const successWebhook = await sendWebhook('payment_link.paid', successPayload);
    assert(successWebhook.status === 200 && successWebhook.json.status === 'PROCESSED', `Success webhook failed: ${successWebhook.status} ${JSON.stringify(successWebhook.json)}`);

    const confirmedStatus = await callFunction('getArcheryPaymentStatus', {
      branch_id: BRANCH_ID,
      booking_id: success.hold.booking_id,
    }, idToken);
    assert(confirmedStatus.booking_status === 'CONFIRMED', 'Booking should be CONFIRMED after paid webhook');
    assert(confirmedStatus.payment_status === 'PAID_ONLINE', 'Payment should be PAID_ONLINE after paid webhook');
    assertNoLaneLeak(confirmedStatus, 'getArcheryPaymentStatus confirmed response');

    const locksSnap = await db.collection('resource_locks')
      .where('booking_id', '==', success.hold.booking_id)
      .get();
    assert(!locksSnap.empty, 'Confirmed booking should have locks');
    locksSnap.forEach(docSnap => {
      const lock = docSnap.data();
      assert(lock.lock_status === 'CONFIRMED', `Lock ${docSnap.id} should be CONFIRMED`);
    });

    const duplicateWebhook = await sendWebhook('payment_link.paid', successPayload);
    assert(duplicateWebhook.status === 200 && duplicateWebhook.json.duplicate === true, 'Duplicate webhook should be idempotent');

    const invalidSignature = await sendWebhook('payment_link.paid', successPayload, { invalidSignature: true });
    assert(invalidSignature.status === 401 && invalidSignature.json.code === 'WEBHOOK_SIGNATURE_INVALID', 'Invalid signature should be rejected');

    const wrongAmount = await createHoldAndPayment(idToken);
    const wrongAmountWebhook = await sendWebhook(
      'payment_link.paid',
      paidPaymentLinkPayload(wrongAmount.hold.booking_id, wrongAmount.payment.beam_payment_link_id, { amountMinor: 1 })
    );
    assert(wrongAmountWebhook.status === 409 && wrongAmountWebhook.json.code === 'PAYMENT_AMOUNT_MISMATCH', 'Wrong amount should be rejected');

    const wrongCurrency = await createHoldAndPayment(idToken);
    const wrongCurrencyWebhook = await sendWebhook(
      'payment_link.paid',
      paidPaymentLinkPayload(wrongCurrency.hold.booking_id, wrongCurrency.payment.beam_payment_link_id, { currency: 'USD' })
    );
    assert(wrongCurrencyWebhook.status === 409 && wrongCurrencyWebhook.json.code === 'PAYMENT_CURRENCY_MISMATCH', 'Wrong currency should be rejected');

    const failed = await createHoldAndPayment(idToken);
    const failedWebhook = await sendWebhook('charge.failed', chargePayload(failed.hold.booking_id, failed.payment.beam_payment_link_id, 'FAILED'));
    assert(failedWebhook.status === 200 && failedWebhook.json.status === 'FAILED', 'Failed payment webhook should mark payment failed');

    const cancelled = await createHoldAndPayment(idToken);
    const cancelledWebhook = await sendWebhook('card_authorization.canceled', {
      cardAuthorizationId: `ca_${runId}`,
      merchantId: process.env.BEAM_MERCHANT_ID_SANDBOX,
      referenceId: `ARCHERY:${cancelled.hold.booking_id}`,
      status: 'CANCELED',
      currency: 'THB',
      amount: 35000,
    });
    assert(cancelledWebhook.status === 200 && cancelledWebhook.json.status === 'CANCELLED', 'Cancelled payment webhook should mark payment cancelled');

    const late = await createHoldAndPayment(idToken);
    await db.collection('bookings').doc(late.hold.booking_id).set({
      expires_at: admin.firestore.Timestamp.fromDate(new Date(Date.now() - 60 * 1000)),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    const lateWebhook = await sendWebhook('payment_link.paid', paidPaymentLinkPayload(late.hold.booking_id, late.payment.beam_payment_link_id));
    assert(lateWebhook.status === 200 && lateWebhook.json.status === 'RECONCILIATION_REQUIRED', 'Late paid webhook should go to reconciliation');
    const queueSnap = await db.collection('payment_reconciliation_queue')
      .where('booking_id', '==', late.hold.booking_id)
      .where('status', '==', 'OPEN')
      .get();
    assert(!queueSnap.empty, 'Late payment should create reconciliation queue item');

    const lateBookingSnap = await db.collection('bookings').doc(late.hold.booking_id).get();
    assert(lateBookingSnap.data().booking_status !== 'CONFIRMED', 'Late payment must not confirm expired hold');

    console.log(JSON.stringify({
      passed: true,
      tests: 15,
      booking_date: bookingDate,
      success_booking_id: success.hold.booking_id,
      fake_beam_requests: fakeBeam.requests.length,
    }, null, 2));
  } finally {
    await fakeBeam.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
