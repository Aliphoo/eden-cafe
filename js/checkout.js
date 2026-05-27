(() => {
    const SHIPPING_FEE = 50;
    let discount = 0;
    let latestTotal = 0;

    function isEnglishPage() {
        return location.pathname.includes('-en');
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
            const value = JSON.parse(localStorage.getItem('eden_cart') || '[]');
            return Array.isArray(value) ? value : [];
        } catch (_) {
            return [];
        }
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
            localStorage.removeItem('eden_cart');
            localStorage.removeItem('eden_pending_order');
            if (typeof window.updateGlobalCartBadge === 'function') window.updateGlobalCartBadge();
            return;
        }

        const cart = readCart();
        const container = document.getElementById('checkout-items');
        const subtotalEl = document.getElementById('subtotal');
        const totalEl = document.getElementById('grand-total');
        const emptyText = isEnglishPage() ? 'Your cart is empty. Please return to the shop.' : 'ตะกร้าว่าง กรุณากลับไปเลือกสินค้าในหน้าร้านค้า';
        const sub = subtotal(cart);
        latestTotal = Math.max(0, sub + SHIPPING_FEE - discount);

        if (container) {
            container.innerHTML = cart.length ? cart.map(item => (
                '<div class="summary-line" style="align-items:flex-start;">'
                + '<span>' + escapeHTML(item.name) + '<br><small style="color:#777;">' + money(item.price) + ' x ' + (Number(item.quantity) || 0) + '</small></span>'
                + '<span>' + money((Number(item.price) || 0) * (Number(item.quantity) || 0)) + '</span>'
                + '</div>'
            )).join('') : '<p style="color:#777;">' + emptyText + '</p>';
        }
        if (subtotalEl) subtotalEl.textContent = money(sub);
        if (totalEl) totalEl.textContent = money(latestTotal);
    }

    function applyPromoCode() {
        const input = document.getElementById('promo-code-input');
        const message = document.getElementById('promo-message');
        const discountLine = document.getElementById('discount-line');
        const discountAmount = document.getElementById('discount-amount');
        const appliedName = document.getElementById('applied-promo-name');
        const code = String(input?.value || '').trim().toUpperCase();
        const sub = subtotal(readCart());

        if (code === 'EDEN10' && sub > 0) {
            discount = Math.round(sub * 0.1);
            if (message) {
                message.style.display = 'block';
                message.style.color = '#1A9345';
                message.textContent = isEnglishPage() ? 'Promo applied: 10% off' : 'ใช้โค้ดสำเร็จ: ลด 10%';
            }
            if (discountLine) discountLine.style.display = 'flex';
            if (discountAmount) discountAmount.textContent = '-' + money(discount);
            if (appliedName) appliedName.textContent = 'EDEN10';
        } else {
            discount = 0;
            if (message) {
                message.style.display = 'block';
                message.style.color = '#e53935';
                message.textContent = isEnglishPage() ? 'Invalid promo code' : 'รหัสส่วนลดไม่ถูกต้อง';
            }
            if (discountLine) discountLine.style.display = 'none';
        }
        renderCheckout();
    }

    async function waitForSaveOrder() {
        for (let i = 0; i < 20; i += 1) {
            if (typeof window.saveOrderToCloud === 'function') return window.saveOrderToCloud;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return null;
    }

    async function confirmOrder(event) {
        const cart = readCart();
        if (!cart.length) {
            alert(isEnglishPage() ? 'Your cart is empty.' : 'ตะกร้าของคุณยังว่างอยู่');
            return;
        }

        const user = getUser();
        if (!user || !user.uid) {
            alert(isEnglishPage() ? 'Please sign in before checkout.' : 'กรุณาเข้าสู่ระบบก่อนชำระเงิน');
            if (typeof window.openLoginModal === 'function') window.openLoginModal();
            return;
        }

        const name = document.getElementById('fname')?.value.trim() || '';
        const phone = document.getElementById('phone')?.value.trim() || '';
        const addressParts = ['address', 'subdistrict', 'district', 'province', 'zipcode']
            .map(id => document.getElementById(id)?.value.trim())
            .filter(Boolean);
        if (!name || !phone || addressParts.length < 5) {
            alert(isEnglishPage() ? 'Please complete shipping information.' : 'กรุณากรอกข้อมูลจัดส่งให้ครบถ้วน');
            return;
        }

        const button = event?.target || document.querySelector('[onclick^="confirmOrder"]');
        const originalText = button?.textContent;
        if (button) {
            button.disabled = true;
            button.textContent = isEnglishPage() ? 'Creating order...' : 'กำลังสร้างคำสั่งซื้อ...';
        }

        const orderId = '#ED' + Date.now().toString().slice(-8);
        const orderData = {
            id: orderId,
            date: new Date().toISOString(),
            items: cart.map(item => ({ id: item.id, name: item.name, price: Number(item.price) || 0, quantity: Number(item.quantity) || 0 })),
            totalAmount: latestTotal,
            uid: user.uid,
            customerName: name,
            phone,
            address: addressParts.join(', '),
            status: 'pending_payment'
        };

        try {
            const saveOrder = await waitForSaveOrder();
            if (saveOrder) await saveOrder(orderData);
            localStorage.setItem('eden_pending_order', JSON.stringify(orderData));
            location.href = '/feelfreepay?amount=' + encodeURIComponent(latestTotal) + '&order=' + encodeURIComponent(orderId) + '&lang=' + (isEnglishPage() ? 'en' : 'th');
        } catch (error) {
            console.error('Order create failed:', error);
            alert(isEnglishPage() ? 'Could not create order. Please try again.' : 'ไม่สามารถสร้างคำสั่งซื้อได้ กรุณาลองใหม่');
            if (button) {
                button.disabled = false;
                button.textContent = originalText;
            }
        }
    }

    window.applyPromoCode = applyPromoCode;
    window.confirmOrder = confirmOrder;
    document.addEventListener('DOMContentLoaded', renderCheckout);
})();
