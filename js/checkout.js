(() => {
    const SHIPPING_FEE = 50;
    const CART_KEY = 'eden_cart';
    const FULFILLMENT_KEY = 'eden_checkout_fulfillment';
    const CHECKOUT_PAYMENT_STATE_KEY = 'eden_checkout_payment_state';
    const PENDING_ORDER_KEY = 'eden_pending_order';
    const BRANCH_ID = 'BKK_MAIN';
    let discount = 0;
    let appliedPromo = null;
    let promoValidationToken = 0;
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

    function displayThaiPhone(phoneNumber = '') {
        const phone = cleanString(phoneNumber, 40);
        return phone.startsWith('+66') ? '0' + phone.slice(3) : phone;
    }

    function firstNonEmpty(...values) {
        for (const value of values) {
            const text = cleanString(value, 500);
            if (text) return text;
        }
        return '';
    }

    function profileAddressForCheckout(user = getUser()) {
        if (!user) return normalizeShippingAddressStructured();
        return normalizeShippingAddressStructured(
            user.shippingAddressStructured || user.shipping_address_structured || user,
            user.shippingAddress || user.address || ''
        );
    }

    function profileNameForCheckout(user = getUser()) {
        if (!user) return '';
        return firstNonEmpty(
            user.name,
            user.displayName,
            [user.firstName, user.lastName].filter(Boolean).join(' ')
        );
    }

    function profilePhoneForCheckout(user = getUser()) {
        if (!user) return '';
        if (user.phoneRemovedAt || user.phone_removed_at) {
            const checkoutPhone = firstNonEmpty(user.checkoutPhone, user.checkout_phone, user.contactPhone, user.contact_phone);
            return checkoutPhone || '';
        }
        const verifiedPhone = user.phoneVerified === true || !!user.phoneVerifiedAt || !!user.phone_number;
        const phoneNumberDisplay = displayThaiPhone(user.phoneNumber || user.phone_number || user.phoneE164 || '');
        return firstNonEmpty(
            verifiedPhone ? user.phone : '',
            verifiedPhone ? phoneNumberDisplay : '',
            user.checkoutPhone,
            user.checkout_phone,
            user.contactPhone,
            user.contact_phone,
            user.phone,
            phoneNumberDisplay
        );
    }

    function mergeProfileIntoCheckoutCache(profile = {}) {
        const user = getUser();
        if (!user?.uid || !profile || typeof profile !== 'object') return;
        const address = normalizeShippingAddressStructured(
            profile.shippingAddressStructured || profile.shipping_address_structured || {},
            profile.shippingAddress || profile.address || ''
        );
        const verifiedPhoneNumber = cleanString(profile.phone_number || profile.phoneE164 || '', 40);
        const checkoutPhone = cleanString(
            profile.checkoutPhone
            || profile.checkout_phone
            || profile.contactPhone
            || profile.contact_phone
            || (!verifiedPhoneNumber ? profile.phone : ''),
            40
        );
        const phoneDisplay = cleanString(profile.phone_display || displayThaiPhone(verifiedPhoneNumber), 40);
        const phoneVerified = profile.phoneVerified === true
            || profile.phone_verified === true
            || !!(profile.phoneVerifiedAt || profile.phone_verified_at);
        const phoneRemoved = !!(profile.phoneRemovedAt || profile.phone_removed_at)
            && !verifiedPhoneNumber
            && !checkoutPhone
            && profile.phoneVerified === false;
        const nextUser = {
            ...user,
            name: firstNonEmpty(profile.display_name, profile.displayName, user.name),
            displayName: firstNonEmpty(profile.display_name, profile.displayName, user.displayName),
            firstName: firstNonEmpty(profile.firstName, profile.first_name, user.firstName),
            lastName: firstNonEmpty(profile.lastName, profile.last_name, user.lastName),
            email: firstNonEmpty(profile.email, user.email),
            phone: phoneRemoved ? '' : (phoneDisplay || checkoutPhone || user.phone || ''),
            phoneNumber: phoneRemoved ? '' : (verifiedPhoneNumber || user.phoneNumber || ''),
            checkoutPhone: phoneRemoved ? '' : (checkoutPhone || user.checkoutPhone || ''),
            checkout_phone: phoneRemoved ? '' : (checkoutPhone || user.checkout_phone || ''),
            contactPhone: phoneRemoved ? '' : (checkoutPhone || user.contactPhone || ''),
            contact_phone: phoneRemoved ? '' : (checkoutPhone || user.contact_phone || ''),
            phoneVerified,
            phoneVerifiedAt: phoneRemoved ? '' : (profile.phoneVerifiedAt || profile.phone_verified_at || user.phoneVerifiedAt || ''),
            phoneRemovedAt: profile.phoneRemovedAt || profile.phone_removed_at || user.phoneRemovedAt || '',
            phone_removed_at: profile.phoneRemovedAt || profile.phone_removed_at || user.phone_removed_at || '',
            shippingAddress: profile.shippingAddress || user.shippingAddress || '',
            address: profile.shippingAddress || profile.address || user.address || '',
            shippingAddressStructured: Object.values(address).some(Boolean) ? address : user.shippingAddressStructured,
            addressLine: address.addressLine || user.addressLine || '',
            subdistrict: address.subdistrict || user.subdistrict || '',
            district: address.district || user.district || '',
            province: address.province || user.province || '',
            zipcode: address.zipcode || user.zipcode || ''
        };
        setUser(nextUser);
    }

    function setCheckoutFieldIfEmpty(id, value) {
        const field = document.getElementById(id);
        if (!field || cleanString(field.value, 500)) return;
        field.value = value || '';
    }

    function prefillCheckoutContactFromProfile() {
        const user = getUser();
        if (!user) return;
        setCheckoutFieldIfEmpty('fname', profileNameForCheckout(user));
        setCheckoutFieldIfEmpty('phone', profilePhoneForCheckout(user));
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

    function syncCheckoutPhoneToProfileCache(phone, profile = null) {
        if (profile && typeof profile === 'object') {
            mergeProfileIntoCheckoutCache(profile);
            return;
        }
        const user = getUser();
        if (!user?.uid) return;
        const verifiedPhone = user.phoneVerified === true || !!user.phoneVerifiedAt || !!cleanString(user.phoneNumber, 40);
        if (verifiedPhone) return;
        const checkoutPhone = cleanString(phone, 40);
        if (!checkoutPhone) return;
        setUser({
            ...user,
            phone: checkoutPhone,
            checkoutPhone,
            checkout_phone: checkoutPhone,
            contactPhone: checkoutPhone,
            contact_phone: checkoutPhone,
            phoneVerified: false,
            phoneVerifiedAt: ''
        });
    }

    function subtotal(cart) {
        return cart.reduce((sum, item) => sum + ((Number(item.price) || 0) * (Number(item.quantity) || 0)), 0);
    }

    function roundMoney(value) {
        return Math.round((Number(value) || 0) * 100) / 100;
    }

    function normalizePromoCode(value) {
        return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
    }

    function checkoutPromoCode() {
        return normalizePromoCode(document.getElementById('promo-code-input')?.value);
    }

    function cartPromoItems(cart = readCart()) {
        return cart
            .map(item => {
                const rawId = cleanString(item.id, 180);
                const [baseRawId, variantRawId = ''] = rawId.split('::');
                const productId = cleanString(
                    item.productId
                    || item.product_id
                    || (baseRawId.startsWith('menu-') ? baseRawId.slice(5) : baseRawId),
                    160
                );
                const variantId = cleanString(item.variantId || item.variant_id || variantRawId, 120);
                const categoryId = cleanString(item.categoryId || item.category_id || item.category, 160);
                const categoryIds = Array.isArray(item.categoryIds)
                    ? item.categoryIds.map(value => cleanString(value, 160)).filter(Boolean)
                    : (categoryId ? [categoryId] : []);
                const quantity = Math.max(0, Math.floor(Number(item.quantity) || 0));
                const price = Number(item.price) || 0;
                return {
                    id: rawId,
                    productId,
                    variantId,
                    categoryId,
                    categoryIds,
                    categoryName: cleanString(item.categoryName || item.category_name, 180),
                    name: cleanString(item.name, 180),
                    quantity,
                    price,
                    unitPrice: price,
                    lineTotal: roundMoney(price * quantity)
                };
            })
            .filter(item => item.quantity > 0 && item.lineTotal > 0);
    }

    function promoPayloadFromResponse(result = {}) {
        return result.promotion || result.redemption || result;
    }

    function promoErrorMessage(error = {}) {
        const code = String(error.code || error.error || '').toUpperCase();
        if (code.includes('EXPIRED')) return t('รหัสส่วนลดหมดอายุแล้ว', 'Promo code has expired.');
        if (code.includes('MIN_SUBTOTAL')) return t('ยอดสินค้าไม่ถึงขั้นต่ำของรหัสส่วนลดนี้', 'Cart subtotal does not meet this promo minimum.');
        if (code.includes('NOT_APPLICABLE')) return t('รหัสส่วนลดนี้ใช้กับสินค้าในตะกร้านี้ไม่ได้', 'Promo code does not apply to these items.');
        if (code.includes('LIMIT')) return t('รหัสส่วนลดนี้ถูกใช้ครบจำนวนแล้ว', 'Promo code redemption limit has been reached.');
        if (code.includes('CHANNEL')) return t('รหัสส่วนลดนี้ไม่เปิดใช้สำหรับร้านค้าออนไลน์', 'Promo code is not available for online shop.');
        if (code.includes('PROMO')) return t('รหัสส่วนลดไม่ถูกต้องหรือไม่พร้อมใช้งาน', 'Promo code is invalid or unavailable.');
        return t('ไม่สามารถตรวจสอบรหัสส่วนลดได้ กรุณาลองใหม่', 'Could not validate promo code. Please try again.');
    }

    function setPromoMessage(text, color = '#e53935') {
        const message = document.getElementById('promo-message');
        if (!message) return;
        message.style.display = text ? 'block' : 'none';
        message.style.color = color;
        message.textContent = text || '';
    }

    function syncPromoDiscountLine() {
        const discountLine = document.getElementById('discount-line');
        const discountAmount = document.getElementById('discount-amount');
        const appliedName = document.getElementById('applied-promo-name');
        if (!discountLine || !discountAmount || !appliedName) return;
        if (discount > 0 && appliedPromo?.code) {
            discountLine.style.display = 'flex';
            discountAmount.textContent = '-' + money(discount);
            appliedName.textContent = appliedPromo.code;
        } else {
            discountLine.style.display = 'none';
            discountAmount.textContent = '-' + money(0);
            appliedName.textContent = '';
        }
    }

    function clearAppliedPromo({ message = '', color = '#e53935' } = {}) {
        discount = 0;
        appliedPromo = null;
        syncPromoDiscountLine();
        setPromoMessage(message, message ? color : '#e53935');
    }

    function clearPromoAfterCartChange() {
        if (!appliedPromo && discount <= 0) return;
        promoValidationToken += 1;
        clearAppliedPromo({
            message: t('ตะกร้ามีการเปลี่ยนแปลง กรุณาใช้รหัสส่วนลดอีกครั้ง', 'Cart changed. Please apply the promo code again.'),
            color: '#8a5a00'
        });
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
        clearPromoAfterCartChange();
        renderCheckout();
        if (typeof window.updateGlobalCartBadge === 'function') window.updateGlobalCartBadge();
    }

    function removeItem(itemId) {
        const next = readCart().filter(item => item.id !== itemId);
        saveCart(next);
        clearPromoAfterCartChange();
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
        syncPromoDiscountLine();
        updateShippingLineUI();
    }

    async function applyPromoCode() {
        const input = document.getElementById('promo-code-input');
        if (!input) return;
        const code = normalizePromoCode(input.value);
        input.value = code;
        const cart = readCart();
        const sub = subtotal(cart);
        promoValidationToken += 1;
        const token = promoValidationToken;

        if (!code) {
            clearAppliedPromo({ message: t('กรุณากรอกรหัสส่วนลด', 'Enter a promo code.') });
            renderCheckout();
            return;
        }
        if (sub <= 0) {
            clearAppliedPromo({ message: t('ตะกร้าของคุณยังว่างอยู่', 'Your cart is empty.') });
            renderCheckout();
            return;
        }

        clearAppliedPromo();
        setPromoMessage(t('กำลังตรวจสอบรหัสส่วนลด...', 'Checking promo code...'), '#6b4f00');

        try {
            const api = await waitForPaymentApi();
            if (!api?.validatePromotion) throw new Error('Promo service is not ready');
            const result = await api.validatePromotion({
                branch_id: BRANCH_ID,
                promo_code: code,
                source_type: 'SHOP_ORDER',
                channel: 'SHOP',
                subtotal: sub,
                items: cartPromoItems(cart)
            });
            if (token !== promoValidationToken) return;
            const promo = promoPayloadFromResponse(result);
            const discountAmount = roundMoney(promo.discountAmount ?? promo.discount_amount);
            if (discountAmount <= 0) throw new Error('Promo discount is zero');
            discount = Math.min(sub, discountAmount);
            appliedPromo = {
                code: promo.code || code,
                promotionId: promo.promotionId || promo.promotion_id || '',
                promotionName: promo.promotionName || promo.promotion_name || '',
                discountAmount: discount,
                lineAllocations: Array.isArray(promo.lineAllocations) ? promo.lineAllocations : []
            };
            setPromoMessage(t('ใช้รหัสส่วนลดสำเร็จ', 'Promo code applied.'), '#1A9345');
            renderCheckout();
        } catch (error) {
            if (token !== promoValidationToken) return;
            console.warn('Promo validation failed:', error);
            clearAppliedPromo({ message: promoErrorMessage(error), color: '#e53935' });
            renderCheckout();
        }
    }

    function appliedPromoCode() {
        return checkoutPromoCode();
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

    async function refreshCheckoutProfileFromCloud() {
        const user = getUser();
        if (!user?.uid) return;
        const api = await waitForPaymentApi();
        if (!api?.getMyProfile) return;
        try {
            const result = await api.getMyProfile();
            if (result?.profile) {
                mergeProfileIntoCheckoutCache(result.profile);
                prefillCheckoutContactFromProfile();
                prefillCheckoutAddressFromProfile();
            }
        } catch (error) {
            console.warn('Checkout profile sync failed:', error);
        }
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
                items: cartPromoItems(cart),
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
            syncCheckoutPhoneToProfileCache(phone, draft.profile || null);

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
                totals: draft.totals || null,
                promoApplications: draft.promo_applications || [],
                fulfillmentMethod,
                source: 'online',
                orderType: 'shop',
                paymentMethod: 'beam',
                paymentLabel: 'Beam'
            }));
            location.href = payment.payment_link_url;
        } catch (error) {
            console.error('Order create failed:', error);
            const isPromoError = String(error.code || error.error || '').toUpperCase().includes('PROMO');
            if (isPromoError) {
                const message = promoErrorMessage(error);
                clearAppliedPromo({ message, color: '#e53935' });
                renderCheckout();
                alert(message);
            } else {
                alert(t('ไม่สามารถสร้างคำสั่งซื้อได้ กรุณาลองใหม่', 'Could not create order. Please try again.'));
            }
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
    window.addEventListener('eden:user-changed', () => {
        prefillCheckoutContactFromProfile();
        prefillCheckoutAddressFromProfile();
    });

    document.addEventListener('DOMContentLoaded', async () => {
        injectFulfillmentUI();
        updateFulfillmentFormUI();
        prefillCheckoutContactFromProfile();
        refreshCheckoutProfileFromCloud();
        await handlePaymentReturn();
        renderCheckout();
    });
})();
