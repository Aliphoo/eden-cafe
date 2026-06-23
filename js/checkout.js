(() => {
    const SHIPPING_FEE = 50;
    const CART_KEY = 'eden_cart';
    const FULFILLMENT_KEY = 'eden_checkout_fulfillment';
    const CHECKOUT_PAYMENT_STATE_KEY = 'eden_checkout_payment_state';
    const PENDING_ORDER_KEY = 'eden_pending_order';
    const BRANCH_ID = 'BKK_MAIN';
    let discount = 0;
    let latestTotal = 0;

    function isEnglishPage() {
        return location.pathname.includes('-en');
    }

    function t(th, en) {
        return isEnglishPage() ? en : th;
    }

    function money(value) {
        return '฿' + (Number(value) || 0).toLocaleString('en-US');
    }

    function escapeHTML(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function readCart() {
        try {
            const value = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
            return Array.isArray(value) ? value : [];
        } catch (_) {
            return [];
        }
    }

    function saveCart(cart) {
        localStorage.setItem(CART_KEY, JSON.stringify(cart));
    }

    function readLocalJSON(key, fallback = null) {
        try {
            const value = JSON.parse(localStorage.getItem(key) || 'null');
            return value == null ? fallback : value;
        } catch (_) {
            return fallback;
        }
    }

    function randomId(prefix = 'checkout') {
        const cryptoId = window.crypto?.randomUUID?.();
        if (cryptoId) return `${prefix}_${cryptoId}`;
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function checkoutPayloadSignature(payload) {
        return JSON.stringify(payload);
    }

    function checkoutIdempotencyKey(signature) {
        const state = readLocalJSON(CHECKOUT_PAYMENT_STATE_KEY, null);
        if (state?.signature === signature && state.key) return state.key;
        const key = randomId('shop_checkout');
        localStorage.setItem(CHECKOUT_PAYMENT_STATE_KEY, JSON.stringify({ key, signature }));
        return key;
    }

    function clearCheckoutPendingState() {
        localStorage.removeItem(CHECKOUT_PAYMENT_STATE_KEY);
        localStorage.removeItem(PENDING_ORDER_KEY);
    }

    function getUser() {
        try {
            return JSON.parse(localStorage.getItem('eden_user') || 'null');
        } catch (_) {
            return null;
        }
    }

    function setUser(user) {
        if (!user?.uid) return;
        localStorage.setItem('eden_user', JSON.stringify(user));
        window.dispatchEvent(new CustomEvent('eden:user-changed'));
    }

    function cleanString(value, maxLength = 300) {
        return String(value ?? '').trim().slice(0, maxLength);
    }

    function normalizeShippingAddressStructured(value = {}, fallbackText = '') {
        const source = value && typeof value === 'object' ? value : {};
        const normalized = {
            addressLine: cleanString(source.addressLine || source.address_line || source.line1 || source.address || '', 250),
            subdistrict: cleanString(source.subdistrict || source.subdistrictName || source.subdistrict_name || '', 80),
            district: cleanString(source.district || source.districtName || source.district_name || '', 80),
            province: cleanString(source.province || source.provinceName || source.province_name || '', 80),
            zipcode: cleanString(source.zipcode || source.postalCode || source.postal_code || source.zip || '', 10)
        };
        if (!Object.values(normalized).some(Boolean) && fallbackText) {
            normalized.addressLine = cleanString(fallbackText, 250);
        }
        return normalized;
    }

    function checkoutAddressFields() {
        return normalizeShippingAddressStructured({
            addressLine: document.getElementById('address')?.value,
            subdistrict: document.getElementById('subdistrict')?.value,
            district: document.getElementById('district')?.value,
            province: document.getElementById('province')?.value,
            zipcode: document.getElementById('zipcode')?.value
        });
    }

    function formatShippingAddress(address = {}) {
        return [
            address.addressLine,
            address.subdistrict,
            address.district,
            address.province,
            address.zipcode
        ].map(part => cleanString(part, 250)).filter(Boolean).join(', ');
    }

    function profileAddressForCheckout(user = getUser()) {
        if (!user) return normalizeShippingAddressStructured();
        return normalizeShippingAddressStructured(
            user.shippingAddressStructured || user.shipping_address_structured || user,
            user.shippingAddress || user.address || ''
        );
    }

    function setCheckoutFieldIfEmpty(id, value) {
        const field = document.getElementById(id);
        if (!field || cleanString(field.value, 500)) return;
        field.value = value || '';
    }

    function prefillCheckoutAddressFromProfile() {
        if (getFulfillmentMethod() !== 'delivery') return;
        const address = profileAddressForCheckout();
        if (!Object.values(address).some(Boolean)) return;
        setCheckoutFieldIfEmpty('address', address.addressLine);
        setCheckoutFieldIfEmpty('subdistrict', address.subdistrict);
        setCheckoutFieldIfEmpty('district', address.district);
        setCheckoutFieldIfEmpty('province', address.province);
        setCheckoutFieldIfEmpty('zipcode', address.zipcode);
    }

    function syncCheckoutAddressToProfileCache(address, addressText) {
        const user = getUser();
        if (!user?.uid) return;
        setUser({
            ...user,
            shippingAddress: addressText,
            address: addressText,
            shippingAddressStructured: address,
            addressLine: address.addressLine,
            subdistrict: address.subdistrict,
            district: address.district,
            province: address.province,
            zipcode: address.zipcode
        });
    }

    function subtotal(cart) {
        return cart.reduce((sum, item) => sum + ((Number(item.price) || 0) * (Number(item.quantity) || 0)), 0);
    }

    function getFulfillmentMethod() {
        const checked = document.querySelector('input[name="fulfillment-method"]:checked');
        if (checked) return checked.value;
        const stored = localStorage.getItem(FULFILLMENT_KEY);
        return stored === 'pickup' ? 'pickup' : 'delivery';
    }

    function shippingFee() {
        return getFulfillmentMethod() === 'pickup' ? 0 : SHIPPING_FEE;
    }

    function updateShippingLineUI() {
        const summaryLines = document.querySelectorAll('.summary-box .summary-line');
        if (!summaryLines.length) return;
        const shippingLine = summaryLines[1];
        if (!shippingLine) return;
        const spans = shippingLine.querySelectorAll('span');
        if (spans[0]) spans[0].textContent = getFulfillmentMethod() === 'pickup'
            ? t('ค่าจัดส่ง', 'Shipping Fee')
            : t('ค่าจัดส่ง (เหมาจ่าย)', 'Delivery Fee (Flat Rate)');
        if (spans[1]) spans[1].textContent = money(readCart().length ? shippingFee() : 0);
    }

    function changeQty(itemId, delta) {
        const next = readCart()
            .map(item => item.id === itemId ? { ...item, quantity: Math.max(0, (Number(item.quantity) || 0) + delta) } : item)
            .filter(item => (Number(item.quantity) || 0) > 0);
        saveCart(next);
        renderCheckout();
        if (typeof window.updateGlobalCartBadge === 'function') window.updateGlobalCartBadge();
    }

    function removeItem(itemId) {
        const next = readCart().filter(item => item.id !== itemId);
        saveCart(next);
        renderCheckout();
        if (typeof window.updateGlobalCartBadge === 'function') window.updateGlobalCartBadge();
    }

    function injectFulfillmentUI() {
        const form = document.getElementById('checkout-form');
        if (!form || document.getElementById('fulfillment-method-block')) return;
        const block = document.createElement('div');
        block.id = 'fulfillment-method-block';
        block.className = 'checkout-fulfillment';
        block.innerHTML = `
            <div class="checkout-field-title">${t('วิธีรับสินค้า', 'Fulfillment Method')}</div>
            <div class="fulfillment-options" role="radiogroup" aria-label="${t('วิธีรับสินค้า', 'Fulfillment Method')}">
                <label class="fulfillment-card">
                    <input type="radio" name="fulfillment-method" value="delivery">
                    <span class="fulfillment-card-body">
                        <span class="fulfillment-mark" aria-hidden="true"></span>
                        <span class="fulfillment-copy">
                            <strong>${t('จัดส่ง', 'Delivery')}</strong>
                            <small>${t('ส่งถึงที่อยู่ของคุณ', 'Ship to your address')}</small>
                        </span>
                    </span>
                </label>
                <label class="fulfillment-card">
                    <input type="radio" name="fulfillment-method" value="pickup">
                    <span class="fulfillment-card-body">
                        <span class="fulfillment-mark" aria-hidden="true"></span>
                        <span class="fulfillment-copy">
                            <strong>${t('รับที่ร้าน', 'Pickup at Store')}</strong>
                            <small>${t('ใช้แค่ชื่อและเบอร์โทร', 'Name and phone only')}</small>
                        </span>
                    </span>
                </label>
            </div>
        `;
        form.prepend(block);

        const saved = localStorage.getItem(FULFILLMENT_KEY);
        const selected = saved === 'pickup' ? 'pickup' : 'delivery';
        const target = block.querySelector(`input[value="${selected}"]`);
        if (target) target.checked = true;

        block.querySelectorAll('input[name="fulfillment-method"]').forEach(radio => {
            radio.addEventListener('change', () => {
                localStorage.setItem(FULFILLMENT_KEY, radio.value);
                updateFulfillmentFormUI();
                renderCheckout();
            });
        });
    }

    function updateFulfillmentFormUI() {
        const pickup = getFulfillmentMethod() === 'pickup';
        const deliveryIds = ['address', 'subdistrict', 'district', 'province', 'zipcode'];
        deliveryIds.forEach(id => {
            const field = document.getElementById(id);
            if (!field) return;
            field.required = !pickup;
            const wrapper = field.closest('.form-group') || field.parentElement;
            const row = field.closest('.form-row');
            if (wrapper) wrapper.style.display = pickup ? 'none' : '';
            if (row) {
                const visible = Array.from(row.querySelectorAll('input,textarea')).some(el => {
                    const group = el.closest('.form-group') || el.parentElement;
                    return group && group.style.display !== 'none';
                });
                row.style.display = visible ? '' : 'none';
            }
        });
        updateShippingLineUI();
        if (!pickup) prefillCheckoutAddressFromProfile();
    }

    function renderCheckout() {
        const cart = readCart();
        const container = document.getElementById('checkout-items');
        const subtotalEl = document.getElementById('subtotal');
        const totalEl = document.getElementById('grand-total');
        const emptyText = t('ตะกร้าว่าง กรุณากลับไปเลือกสินค้าในหน้าร้านค้า', 'Your cart is empty. Please return to the shop.');
        const sub = subtotal(cart);
        const fee = cart.length ? shippingFee() : 0;
        latestTotal = Math.max(0, sub + fee - discount);

        if (container) {
            container.innerHTML = cart.length ? cart.map(item => (
                '<div class="checkout-item-row">'
                + '<span><span class="checkout-item-name">' + escapeHTML(item.name) + '</span><span class="checkout-item-meta">' + money(item.price) + ' x ' + (Number(item.quantity) || 0) + '</span></span>'
                + '<div class="checkout-item-side">'
                + '<span class="checkout-item-price">' + money((Number(item.price) || 0) * (Number(item.quantity) || 0)) + '</span>'
                + '<div class="checkout-item-actions">'
                + '<button type="button" class="checkout-qty-btn" data-act="dec" data-id="' + escapeHTML(item.id) + '" aria-label="' + t('ลดจำนวน', 'Decrease quantity') + '">-</button>'
                + '<button type="button" class="checkout-qty-btn" data-act="inc" data-id="' + escapeHTML(item.id) + '" aria-label="' + t('เพิ่มจำนวน', 'Increase quantity') + '">+</button>'
                + '<button type="button" class="checkout-remove-btn" data-act="del" data-id="' + escapeHTML(item.id) + '">' + t('ลบ', 'Remove') + '</button>'
                + '</div></div></div>'
            )).join('') : '<p style="color:#777;">' + emptyText + '</p>';
        }

        if (subtotalEl) subtotalEl.textContent = money(sub);
        if (totalEl) totalEl.textContent = money(latestTotal);
        updateShippingLineUI();
    }

    function applyPromoCode() {
        const input = document.getElementById('promo-code-input');
        const message = document.getElementById('promo-message');
        const discountLine = document.getElementById('discount-line');
        const discountAmount = document.getElementById('discount-amount');
        const appliedName = document.getElementById('applied-promo-name');
        if (!input || !message || !discountLine || !discountAmount || !appliedName) return;
        const code = String(input.value || '').trim().toUpperCase();
        const sub = subtotal(readCart());

        if (code === 'EDEN10' && sub > 0) {
            discount = Math.round(sub * 0.1);
            message.style.display = 'block';
            message.style.color = '#1A9345';
            message.textContent = t('ใช้โค้ดสำเร็จ: ลด 10%', 'Promo applied: 10% off');
            discountLine.style.display = 'flex';
            discountAmount.textContent = '-' + money(discount);
            appliedName.textContent = 'EDEN10';
        } else {
            discount = 0;
            message.style.display = 'block';
            message.style.color = '#e53935';
            message.textContent = t('รหัสส่วนลดไม่ถูกต้อง', 'Invalid promo code');
            discountLine.style.display = 'none';
        }
        renderCheckout();
    }

    function appliedPromoCode() {
        const code = String(document.getElementById('promo-code-input')?.value || '').trim().toUpperCase();
        return discount > 0 && code === 'EDEN10' ? code : '';
    }

    function currentReturnUrl() {
        const url = new URL(location.href);
        url.search = '';
        url.hash = '';
        return url.toString();
    }

    function clearPaymentReturnParams() {
        const url = new URL(location.href);
        ['payment_id', 'source_id', 'payment_return', 'status'].forEach(key => url.searchParams.delete(key));
        history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }

    async function waitForPaymentApi() {
        for (let i = 0; i < 80; i += 1) {
            if (window.EdenApi?.createShopOrderDraft && window.EdenApi?.createPaymentIntent) return window.EdenApi;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return null;
    }

    function paymentStatusFromResult(result = {}) {
        return String(result.source?.payment_status || result.payment?.payment_status || result.payment?.status || '').toUpperCase();
    }

    function isPaidPaymentStatus(status) {
        return status === 'PAID_ONLINE' || status === 'PAID';
    }

    async function handlePaymentReturn() {
        const params = new URLSearchParams(location.search);
        const pendingOrder = readLocalJSON(PENDING_ORDER_KEY, null);
        const paymentId = params.get('payment_id') || pendingOrder?.payment_id || '';
        const sourceId = params.get('source_id') || pendingOrder?.source_id || pendingOrder?.firestoreId || '';
        const isBeamReturn = params.has('payment_id') || params.has('source_id') || params.has('payment_return');
        if (!paymentId && !sourceId) return false;

        const api = await waitForPaymentApi();
        if (!api?.getPaymentStatus) return false;

        try {
            const statusRequest = { branch_id: pendingOrder?.branch_id || BRANCH_ID };
            if (paymentId) {
                statusRequest.payment_id = paymentId;
            } else {
                statusRequest.source_type = 'SHOP_ORDER';
                statusRequest.source_id = sourceId;
                statusRequest.provider = 'BEAM';
            }

            const statusResult = await api.getPaymentStatus(statusRequest);
            const status = paymentStatusFromResult(statusResult);
            if (isPaidPaymentStatus(status)) {
                const modal = document.getElementById('success-modal');
                const orderIdEl = document.getElementById('order-id');
                if (orderIdEl) orderIdEl.textContent = pendingOrder?.id || pendingOrder?.order_id || sourceId;
                if (modal) modal.style.display = 'flex';
                localStorage.removeItem(CART_KEY);
                clearCheckoutPendingState();
                if (typeof window.updateGlobalCartBadge === 'function') window.updateGlobalCartBadge();
                clearPaymentReturnParams();
                return true;
            }

            if (isBeamReturn && (status === 'FAILED' || status === 'CANCELLED')) {
                alert(t('Payment was not completed. Your cart is still available.', 'Payment was not completed. Your cart is still available.'));
                clearPaymentReturnParams();
            } else if (isBeamReturn) {
                clearPaymentReturnParams();
            }
        } catch (error) {
            console.warn('Payment status check failed:', error);
        }
        return false;
    }

    async function confirmOrder(event) {
        const cart = readCart();
        if (!cart.length) {
            alert(t('ตะกร้าของคุณยังว่างอยู่', 'Your cart is empty.'));
            return;
        }

        const user = getUser();
        if (!user || !user.uid) {
            alert(t('กรุณาเข้าสู่ระบบก่อนชำระเงิน', 'Please sign in before checkout.'));
            if (typeof window.openLoginModal === 'function') window.openLoginModal();
            return;
        }

        const fulfillmentMethod = getFulfillmentMethod();
        const name = document.getElementById('fname')?.value.trim() || '';
        const phone = document.getElementById('phone')?.value.trim() || '';
        let addressText = '';

        if (!name || !phone) {
            alert(t('กรุณากรอกชื่อและเบอร์โทรให้ครบ', 'Please fill in full name and phone number.'));
            return;
        }

        if (fulfillmentMethod === 'delivery') {
            const shippingAddressStructured = checkoutAddressFields();
            const addressParts = [
                shippingAddressStructured.addressLine,
                shippingAddressStructured.subdistrict,
                shippingAddressStructured.district,
                shippingAddressStructured.province,
                shippingAddressStructured.zipcode
            ].filter(Boolean);
            if (addressParts.length < 5) {
                alert(t('กรุณากรอกข้อมูลจัดส่งให้ครบถ้วน', 'Please complete shipping information.'));
                return;
            }
            addressText = formatShippingAddress(shippingAddressStructured);
            syncCheckoutAddressToProfileCache(shippingAddressStructured, addressText);
        } else {
            addressText = t('รับที่ร้าน', 'Pickup at Store');
        }

        const button = event?.target || document.querySelector('[onclick^="confirmOrder"]');
        const originalText = button?.textContent;
        if (button) {
            button.disabled = true;
            button.textContent = t('กำลังสร้างคำสั่งซื้อ...', 'Creating order...');
        }

        try {
            const api = await waitForPaymentApi();
            if (!api) throw new Error('Payment service is not ready');

            const promoCode = appliedPromoCode();
            const draftPayload = {
                branch_id: BRANCH_ID,
                items: cart.map(item => ({ id: item.id, name: item.name, quantity: Number(item.quantity) || 0 })),
                customer_name: name,
                phone,
                address: addressText,
                fulfillment_method: fulfillmentMethod,
                promo_code: promoCode
            };
            const idempotencyKey = checkoutIdempotencyKey(checkoutPayloadSignature(draftPayload));
            const draft = await api.createShopOrderDraft({
                ...draftPayload,
                idempotency_key: idempotencyKey
            });

            if (button) button.textContent = t('Opening Beam...', 'Opening Beam...');
            const payment = await api.createPaymentIntent({
                branch_id: draft.branch_id || BRANCH_ID,
                source_type: 'SHOP_ORDER',
                source_id: draft.source_id,
                provider: 'BEAM',
                idempotency_key: `${idempotencyKey}_beam`,
                return_url: currentReturnUrl()
            });

            if (!payment.payment_link_url) throw new Error('Beam payment link was not returned');
            localStorage.setItem(PENDING_ORDER_KEY, JSON.stringify({
                id: draft.order_id,
                order_id: draft.order_id,
                source_id: draft.source_id,
                firestoreId: draft.source_id,
                branch_id: draft.branch_id || BRANCH_ID,
                payment_id: payment.payment_id,
                paymentStatus: payment.payment_status || payment.status || 'PENDING',
                status: 'pending',
                totalAmount: draft.amount,
                fulfillmentMethod,
                source: 'online',
                orderType: 'shop',
                paymentMethod: 'beam',
                paymentLabel: 'Beam'
            }));
            location.href = payment.payment_link_url;
        } catch (error) {
            console.error('Order create failed:', error);
            alert(t('ไม่สามารถสร้างคำสั่งซื้อได้ กรุณาลองใหม่', 'Could not create order. Please try again.'));
            if (button) {
                button.disabled = false;
                button.textContent = originalText;
            }
        }
    }

    document.addEventListener('click', event => {
        const actionBtn = event.target.closest('[data-act][data-id]');
        if (!actionBtn) return;
        const itemId = actionBtn.dataset.id;
        const act = actionBtn.dataset.act;
        if (act === 'inc') changeQty(itemId, 1);
        if (act === 'dec') changeQty(itemId, -1);
        if (act === 'del') removeItem(itemId);
    });

    window.applyPromoCode = applyPromoCode;
    window.confirmOrder = confirmOrder;
    window.addEventListener('eden:user-changed', prefillCheckoutAddressFromProfile);

    document.addEventListener('DOMContentLoaded', async () => {
        injectFulfillmentUI();
        updateFulfillmentFormUI();
        await handlePaymentReturn();
        renderCheckout();
    });
})();
