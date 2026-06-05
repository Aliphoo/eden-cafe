(() => {
    const SHIPPING_FEE = 50;
    const CART_KEY = 'eden_cart';
    const FULFILLMENT_KEY = 'eden_checkout_fulfillment';
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

    function getUser() {
        try {
            return JSON.parse(localStorage.getItem('eden_user') || 'null');
        } catch (_) {
            return null;
        }
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
    }

    function renderCheckout() {
        const params = new URLSearchParams(location.search);
        if (params.get('paid') === '1') {
            const pendingOrder = (() => {
                try {
                    return JSON.parse(localStorage.getItem('eden_pending_order') || 'null');
                } catch (_) {
                    return null;
                }
            })();
            if (pendingOrder) {
                pendingOrder.status = 'paid';
                pendingOrder.paymentStatus = 'paid';
                pendingOrder.paidAt = new Date().toISOString();
                const history = (() => {
                    try {
                        const value = JSON.parse(localStorage.getItem('eden_order_history') || '[]');
                        return Array.isArray(value) ? value : [];
                    } catch (_) {
                        return [];
                    }
                })();
                const nextHistory = [pendingOrder, ...history.filter(order => order.id !== pendingOrder.id)].slice(0, 20);
                localStorage.setItem('eden_order_history', JSON.stringify(nextHistory));
            }
            const modal = document.getElementById('success-modal');
            const orderIdEl = document.getElementById('order-id');
            if (orderIdEl && params.get('order')) orderIdEl.textContent = params.get('order');
            if (modal) modal.style.display = 'flex';
            localStorage.removeItem(CART_KEY);
            localStorage.removeItem('eden_pending_order');
            if (typeof window.updateGlobalCartBadge === 'function') window.updateGlobalCartBadge();
            return;
        }

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

    async function waitForSaveOrder() {
        for (let i = 0; i < 80; i += 1) {
            if (typeof window.saveOrderToCloud === 'function') return window.saveOrderToCloud;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return null;
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
            const addressParts = ['address', 'subdistrict', 'district', 'province', 'zipcode']
                .map(id => document.getElementById(id)?.value.trim())
                .filter(Boolean);
            if (addressParts.length < 5) {
                alert(t('กรุณากรอกข้อมูลจัดส่งให้ครบถ้วน', 'Please complete shipping information.'));
                return;
            }
            addressText = addressParts.join(', ');
        } else {
            addressText = t('รับที่ร้าน', 'Pickup at Store');
        }

        const button = event?.target || document.querySelector('[onclick^="confirmOrder"]');
        const originalText = button?.textContent;
        if (button) {
            button.disabled = true;
            button.textContent = t('กำลังสร้างคำสั่งซื้อ...', 'Creating order...');
        }

        const orderId = '#ED' + Date.now().toString().slice(-8);
        const sub = subtotal(cart);
        const fee = shippingFee();
        const orderData = {
            id: orderId,
            date: new Date().toISOString(),
            items: cart.map(item => ({ id: item.id, name: item.name, price: Number(item.price) || 0, quantity: Number(item.quantity) || 0 })),
            subtotal: sub,
            discount,
            shippingFee: fee,
            totalAmount: latestTotal,
            total: latestTotal,
            uid: user.uid,
            customerName: name,
            phone,
            address: addressText,
            fulfillmentMethod,
            source: 'online',
            orderType: 'shop',
            paymentMethod: 'other',
            paymentLabel: 'Feelfreepay',
            paymentStatus: 'pending',
            status: 'pending'
        };

        try {
            const saveOrder = await waitForSaveOrder();
            if (!saveOrder) throw new Error('Order service is not ready');
            const firestoreId = await saveOrder(orderData);
            localStorage.setItem('eden_pending_order', JSON.stringify({ ...orderData, firestoreId }));
            location.href = '/feelfreepay?amount=' + encodeURIComponent(latestTotal) + '&order=' + encodeURIComponent(orderId) + '&lang=' + (isEnglishPage() ? 'en' : 'th');
        } catch (_) {
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

    document.addEventListener('DOMContentLoaded', () => {
        injectFulfillmentUI();
        updateFulfillmentFormUI();
        renderCheckout();
    });
})();
