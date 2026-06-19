(() => {
    const CART_KEY = 'eden_cart';

    function isEnglishPage() {
        return location.pathname.includes('-en') || location.pathname.endsWith('/en');
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
        window.cart = cart;
    }

    function cartTotal(cart = window.cart || []) {
        return cart.reduce((sum, item) => sum + ((Number(item.price) || 0) * (Number(item.quantity) || 0)), 0);
    }

    function updateGlobalCartBadge() {
        const cart = readCart();
        const totalItems = cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
        document.querySelectorAll('#global-cart-badge').forEach(badge => {
            badge.textContent = totalItems;
            badge.style.display = totalItems > 0 ? 'flex' : 'none';
        });
    }

    function renderCart() {
        const cart = readCart();
        window.cart = cart;
        const container = document.getElementById('cart-items-container');
        const totalEl = document.getElementById('cart-total-price');
        const emptyText = isEnglishPage() ? 'Your cart is empty' : 'ตะกร้าของคุณยังว่างอยู่';

        if (container) {
            if (!cart.length) {
                container.innerHTML = '<p class="empty-cart-msg">' + emptyText + '</p>';
            } else {
                container.innerHTML = cart.map(item => {
                    const id = escapeHTML(item.id);
                    return '<div class="cart-item" data-id="' + id + '">'
                        + '<div><strong>' + escapeHTML(item.name) + '</strong>'
                        + '<small style="display:block;color:#777;">' + money(item.price) + ' x ' + (Number(item.quantity) || 0) + '</small></div>'
                        + '<div style="display:flex;align-items:center;gap:8px;">'
                        + '<button type="button" class="cart-qty" data-action="dec" data-id="' + id + '">-</button>'
                        + '<span>' + (Number(item.quantity) || 0) + '</span>'
                        + '<button type="button" class="cart-qty" data-action="inc" data-id="' + id + '">+</button>'
                        + '</div></div>';
                }).join('');
            }
        }
        if (totalEl) totalEl.textContent = money(cartTotal(cart));
        updateGlobalCartBadge();
    }

    function addToCart(idOrName, nameOrPrice, maybePrice) {
        const legacyCall = typeof maybePrice === 'undefined';
        const id = legacyCall ? String(idOrName || Date.now()) : String(idOrName || nameOrPrice || Date.now());
        const name = legacyCall ? String(idOrName || '') : String(nameOrPrice || '');
        const price = legacyCall ? Number(nameOrPrice) || 0 : Number(maybePrice) || 0;
        const cart = readCart();
        const existing = cart.find(item => item.id === id);
        if (existing) existing.quantity += 1;
        else cart.push({ id, name, price, quantity: 1 });
        saveCart(cart);
        renderCart();
    }

    function changeQty(id, delta) {
        const cart = readCart()
            .map(item => item.id === id ? { ...item, quantity: Math.max(0, (Number(item.quantity) || 0) + delta) } : item)
            .filter(item => item.quantity > 0);
        saveCart(cart);
        renderCart();
    }

    function openCart() {
        document.getElementById('cart-sidebar')?.classList.add('open');
        document.getElementById('cart-overlay')?.classList.add('open');
        renderCart();
    }

    function closeCart() {
        document.getElementById('cart-sidebar')?.classList.remove('open');
        document.getElementById('cart-overlay')?.classList.remove('open');
    }

    function checkout() {
        const cart = readCart();
        if (!cart.length) {
            alert(isEnglishPage() ? 'Please add items to your cart first.' : 'กรุณาเพิ่มสินค้าในตะกร้าก่อน');
            return;
        }
        location.href = isEnglishPage() ? '/checkout-en' : '/checkout';
    }

    function canUseMenuOrderButton(button) {
        if (button?.dataset?.menuRequiresAccess !== 'true') return true;
        return window.EdenMenuOrderAccess?.allowed === true;
    }

    function menuOrderDeniedMessage() {
        return isEnglishPage()
            ? 'Add to cart from the menu is available only for authorized Eden Cafe staff ordering inside the store.'
            : 'ปุ่มเพิ่มลงตะกร้าหน้าเมนูเปิดใช้เฉพาะพนักงาน/ผู้ได้รับสิทธิ์สั่งภายในร้าน Eden Cafe เท่านั้น';
    }

    window.cart = readCart();
    window.addToCart = addToCart;
    window.updateCartUI = renderCart;
    window.updateGlobalCartBadge = updateGlobalCartBadge;
    window.checkout = checkout;

    document.addEventListener('click', event => {
        const addButton = event.target.closest('.btn-add-cart');
        if (addButton && !addButton.disabled && addButton.dataset.cartHandledByShop !== 'true') {
            if (!canUseMenuOrderButton(addButton)) {
                event.preventDefault();
                alert(menuOrderDeniedMessage());
                return;
            }
            addToCart(addButton.dataset.id || addButton.dataset.name, addButton.dataset.name, addButton.dataset.price);
            openCart();
            const original = addButton.textContent;
            addButton.textContent = isEnglishPage() ? 'Added ✓' : 'เพิ่มแล้ว ✓';
            setTimeout(() => { addButton.textContent = original; }, 1200);
        }

        const qtyButton = event.target.closest('.cart-qty');
        if (qtyButton) changeQty(qtyButton.dataset.id, qtyButton.dataset.action === 'inc' ? 1 : -1);

        if (event.target.closest('#close-cart-btn') || event.target.closest('#cart-overlay')) closeCart();

        const cartIcon = event.target.closest('.global-cart-icon');
        if (cartIcon && document.getElementById('cart-sidebar')) {
            event.preventDefault();
            openCart();
        }
    });

    document.addEventListener('DOMContentLoaded', renderCart);
})();
