const CONSENT_KEY = 'eden_cookie_consent_v2';
const LEGACY_CONSENT_KEY = 'cookieConsent';
const SETTINGS_DOC = ['site_settings', 'marketing'];
const CONSENT_VERSION = 2;

const DEFAULT_CONSENT = Object.freeze({
    necessary: true,
    analytics: false,
    marketing: false
});

const EVENT_MAP = Object.freeze({
    page_view: { google: 'page_view', meta: 'PageView' },
    add_to_cart: { google: 'add_to_cart', meta: 'AddToCart' },
    begin_checkout: { google: 'begin_checkout', meta: 'InitiateCheckout' },
    purchase: { google: 'purchase', meta: 'Purchase' },
    booking_submit: { google: 'generate_lead', meta: 'Lead' }
});

let marketingSettings = null;
let currentConsent = null;
let googleToolsLoaded = false;
let metaPixelLoaded = false;
let checkoutTracked = false;
let purchaseTracked = false;
let pendingAutoSnapshot = null;

function isEnglishPage() {
    return location.pathname.includes('-en') || location.pathname.endsWith('/en');
}

function cleanText(value) {
    return String(value ?? '').trim();
}

function hasValue(value) {
    return cleanText(value).length > 0;
}

function boolValue(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null || cleanText(value) === '') return fallback;
    return ['true', '1', 'yes', 'y', 'enabled', 'on'].includes(cleanText(value).toLowerCase());
}

function readJSON(key, fallback = null) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || 'null');
        return value ?? fallback;
    } catch (_) {
        return fallback;
    }
}

function normalizeConsent(value = {}) {
    return {
        version: CONSENT_VERSION,
        necessary: true,
        analytics: value.analytics === true,
        marketing: value.marketing === true,
        updatedAt: value.updatedAt || new Date().toISOString()
    };
}

function readConsent() {
    const stored = readJSON(CONSENT_KEY, null);
    if (stored && stored.version === CONSENT_VERSION) return normalizeConsent(stored);

    if (localStorage.getItem(LEGACY_CONSENT_KEY) === 'true') {
        const migrated = normalizeConsent({ analytics: true, marketing: true });
        saveConsent(migrated);
        return migrated;
    }

    return null;
}

function saveConsent(consent) {
    const nextConsent = normalizeConsent(consent);
    localStorage.setItem(CONSENT_KEY, JSON.stringify(nextConsent));
    if (nextConsent.analytics || nextConsent.marketing) localStorage.setItem(LEGACY_CONSENT_KEY, 'true');
    currentConsent = nextConsent;
    updateGoogleConsent(nextConsent);
    window.dispatchEvent(new CustomEvent('eden:marketing-consent-changed', { detail: nextConsent }));
    return nextConsent;
}

function consentAllowsAnalytics() {
    return currentConsent?.analytics === true;
}

function consentAllowsMarketing() {
    return currentConsent?.marketing === true;
}

function normalizeSettings(data = {}) {
    const settings = {
        enabled: boolValue(data.enabled, false),
        googleTagManagerId: cleanText(data.googleTagManagerId).toUpperCase(),
        googleAnalyticsId: cleanText(data.googleAnalyticsId).toUpperCase(),
        googleAdsId: cleanText(data.googleAdsId).toUpperCase(),
        metaPixelId: cleanText(data.metaPixelId),
        debug: boolValue(data.debug, false)
    };
    settings.hasGoogle = [settings.googleTagManagerId, settings.googleAnalyticsId, settings.googleAdsId].some(hasValue);
    settings.hasMeta = hasValue(settings.metaPixelId);
    settings.hasAnyTool = settings.hasGoogle || settings.hasMeta;
    return settings;
}

async function loadSettings() {
    const fallback = normalizeSettings(window.EDEN_MARKETING_CONFIG || {});
    try {
        const [{ db }, { doc, getDoc }] = await Promise.all([
            import('./firebase-config.js'),
            import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")
        ]);
        const snap = await getDoc(doc(db, SETTINGS_DOC[0], SETTINGS_DOC[1]));
        if (snap.exists()) return normalizeSettings({ ...fallback, ...snap.data() });
    } catch (error) {
        console.warn('Marketing settings unavailable:', error);
    }
    return fallback;
}

function ensureGoogleConsentBootstrap() {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function gtag() {
        window.dataLayer.push(arguments);
    };
    window.gtag('consent', 'default', {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        wait_for_update: 500
    });
}

function updateGoogleConsent(consent = currentConsent || DEFAULT_CONSENT) {
    ensureGoogleConsentBootstrap();
    window.gtag('consent', 'update', {
        analytics_storage: consent.analytics ? 'granted' : 'denied',
        ad_storage: consent.marketing ? 'granted' : 'denied',
        ad_user_data: consent.marketing ? 'granted' : 'denied',
        ad_personalization: consent.marketing ? 'granted' : 'denied'
    });
}

function loadScript(src, id) {
    if (id && document.getElementById(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        if (id) script.id = id;
        script.async = true;
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Unable to load ' + src));
        document.head.appendChild(script);
    });
}

function loadGoogleTools(settings) {
    if (!settings.hasGoogle) return;
    ensureGoogleConsentBootstrap();

    if (hasValue(settings.googleTagManagerId)) {
        window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
        loadScript('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(settings.googleTagManagerId), 'eden-gtm-loader')
            .catch(error => console.warn('Google Tag Manager failed:', error));
    }

    const firstGtagId = settings.googleAnalyticsId || settings.googleAdsId;
    if (!firstGtagId) return;

    loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(firstGtagId), 'eden-gtag-loader')
        .then(() => {
            window.gtag('js', new Date());
            if (hasValue(settings.googleAnalyticsId) && consentAllowsAnalytics()) {
                window.gtag('config', settings.googleAnalyticsId, {
                    anonymize_ip: true,
                    send_page_view: true
                });
            }
            if (hasValue(settings.googleAdsId) && consentAllowsMarketing()) {
                window.gtag('config', settings.googleAdsId);
            }
        })
        .catch(error => console.warn('Google tag failed:', error));
}

function loadMetaPixel(settings) {
    if (!settings.hasMeta || window.fbq) return;

    window.fbq = function fbq() {
        window.fbq.callMethod
            ? window.fbq.callMethod.apply(window.fbq, arguments)
            : window.fbq.queue.push(arguments);
    };
    window.fbq.push = window.fbq;
    window.fbq.loaded = true;
    window.fbq.version = '2.0';
    window.fbq.queue = [];

    loadScript('https://connect.facebook.net/en_US/fbevents.js', 'eden-meta-pixel-loader')
        .then(() => {
            window.fbq('init', settings.metaPixelId);
            window.fbq('track', 'PageView');
        })
        .catch(error => console.warn('Meta Pixel failed:', error));
}

function loadAllowedIntegrations() {
    if (!marketingSettings?.enabled || !marketingSettings.hasAnyTool) return;
    if (!consentAllowsAnalytics() && !consentAllowsMarketing()) return;

    if ((consentAllowsAnalytics() || consentAllowsMarketing()) && !googleToolsLoaded) {
        loadGoogleTools(marketingSettings);
        googleToolsLoaded = true;
    }
    if (consentAllowsMarketing() && !metaPixelLoaded) {
        loadMetaPixel(marketingSettings);
        metaPixelLoaded = true;
    }
}

function moneyValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function readCart() {
    const cart = readJSON('eden_cart', []);
    return Array.isArray(cart) ? cart : [];
}

function cartValue() {
    return readCart().reduce((sum, item) => sum + (moneyValue(item.price) * moneyValue(item.quantity || 1)), 0);
}

function track(eventName, params = {}) {
    if (!marketingSettings?.enabled || !marketingSettings.hasAnyTool) return;
    const mapped = EVENT_MAP[eventName] || { google: eventName, meta: eventName };
    const payload = {
        currency: 'THB',
        ...params
    };

    if ((consentAllowsAnalytics() || consentAllowsMarketing()) && typeof window.gtag === 'function') {
        window.gtag('event', mapped.google, payload);
    }

    if (consentAllowsMarketing() && typeof window.fbq === 'function') {
        const metaPayload = {
            currency: payload.currency,
            value: payload.value,
            content_ids: payload.item_id ? [payload.item_id] : payload.content_ids,
            content_name: payload.item_name || payload.content_name
        };
        window.fbq('track', mapped.meta, metaPayload);
    }

    if (marketingSettings.debug) console.info('[EdenMarketing]', eventName, payload);
}

function removeLegacyBanner() {
    if (!document.getElementById('eden-legacy-consent-suppression')) {
        const style = document.createElement('style');
        style.id = 'eden-legacy-consent-suppression';
        style.textContent = '#cookie-consent{display:none!important;}';
        document.head.appendChild(style);
    }
    const legacyBanner = document.getElementById('cookie-consent');
    if (legacyBanner) {
        legacyBanner.style.display = 'none';
        legacyBanner.setAttribute('aria-hidden', 'true');
    }
}

function injectConsentStyles() {
    if (document.getElementById('eden-consent-styles')) return;
    const style = document.createElement('style');
    style.id = 'eden-consent-styles';
    style.textContent = `
        .eden-consent-shell{position:fixed;left:16px;right:16px;bottom:16px;z-index:10000;display:flex;justify-content:center;pointer-events:none;font-family:Inter,Prompt,system-ui,sans-serif}
        .eden-consent-card{width:min(760px,100%);background:rgba(255,255,255,.98);color:#243126;border:1px solid rgba(31,74,46,.18);box-shadow:0 18px 55px rgba(20,38,24,.22);border-radius:14px;padding:18px;pointer-events:auto}
        .eden-consent-card strong{display:block;font-size:1rem;color:#17351f;margin-bottom:6px}
        .eden-consent-card p{margin:0;color:#526052;font-size:.88rem;line-height:1.55}
        .eden-consent-actions{display:flex;gap:10px;justify-content:flex-end;align-items:center;flex-wrap:wrap;margin-top:14px}
        .eden-consent-btn{border:1px solid rgba(31,74,46,.22);background:#fff;color:#21412a;border-radius:999px;padding:9px 14px;font-weight:700;cursor:pointer}
        .eden-consent-btn.primary{background:#2f6f3e;color:#fff;border-color:#2f6f3e}
        .eden-consent-btn.ghost{background:#f3f7f1}
        .eden-consent-panel{display:none;margin-top:14px;padding-top:14px;border-top:1px solid #e3eadf}
        .eden-consent-panel.show{display:block}
        .eden-consent-option{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #edf2ea}
        .eden-consent-option:last-child{border-bottom:0}
        .eden-consent-option span{display:block;font-weight:700;color:#213927;margin-bottom:2px}
        .eden-consent-option small{display:block;color:#667466;line-height:1.45}
        .eden-consent-option input{width:20px;height:20px;accent-color:#2f6f3e;flex:0 0 auto;margin-top:2px}
        @media(max-width:640px){.eden-consent-actions{justify-content:stretch}.eden-consent-btn{flex:1 1 140px}.eden-consent-card{padding:16px}}
    `;
    document.head.appendChild(style);
}

function renderConsentBanner() {
    removeLegacyBanner();
    if (currentConsent || document.getElementById('eden-consent-banner')) return;

    const en = isEnglishPage();
    injectConsentStyles();

    const shell = document.createElement('div');
    shell.id = 'eden-consent-banner';
    shell.className = 'eden-consent-shell';
    shell.innerHTML = `
        <div class="eden-consent-card" role="dialog" aria-live="polite" aria-label="${en ? 'Cookie preferences' : 'การตั้งค่าคุกกี้'}">
            <strong>${en ? 'Cookie and marketing preferences' : 'การตั้งค่าคุกกี้และเครื่องมือการตลาด'}</strong>
            <p>${en
                ? 'We use necessary cookies for the website to work. Analytics and marketing tools such as Google or Meta Pixel will load only after your permission.'
                : 'เว็บไซต์ใช้คุกกี้ที่จำเป็นต่อการทำงานของระบบ ส่วน Analytics และเครื่องมือการตลาด เช่น Google หรือ Meta Pixel จะโหลดหลังจากได้รับอนุญาตจากคุณเท่านั้น'}</p>
            <div class="eden-consent-panel" id="eden-consent-panel">
                <label class="eden-consent-option">
                    <span>${en ? 'Necessary' : 'จำเป็นต่อการใช้งาน'}<small>${en ? 'Required for login, cart, checkout, and security.' : 'จำเป็นสำหรับล็อกอิน ตะกร้า ชำระเงิน และความปลอดภัย'}</small></span>
                    <input type="checkbox" checked disabled>
                </label>
                <label class="eden-consent-option">
                    <span>${en ? 'Analytics' : 'วิเคราะห์การใช้งาน'}<small>${en ? 'Helps us understand page performance and improve the website.' : 'ช่วยวิเคราะห์ประสิทธิภาพหน้าเว็บและปรับปรุงประสบการณ์ใช้งาน'}</small></span>
                    <input type="checkbox" id="eden-consent-analytics">
                </label>
                <label class="eden-consent-option">
                    <span>${en ? 'Marketing' : 'การตลาดและโฆษณา'}<small>${en ? 'Allows remarketing and campaign measurement with tools such as Google Ads and Meta Pixel.' : 'ใช้สำหรับวัดผลแคมเปญ รีมาร์เก็ตติ้ง และเครื่องมืออย่าง Google Ads / Meta Pixel'}</small></span>
                    <input type="checkbox" id="eden-consent-marketing">
                </label>
            </div>
            <div class="eden-consent-actions">
                <button class="eden-consent-btn ghost" type="button" data-consent-action="customize">${en ? 'Customize' : 'ตั้งค่าเอง'}</button>
                <button class="eden-consent-btn" type="button" data-consent-action="necessary">${en ? 'Necessary only' : 'เฉพาะจำเป็น'}</button>
                <button class="eden-consent-btn primary" type="button" data-consent-action="all">${en ? 'Accept all' : 'ยอมรับทั้งหมด'}</button>
            </div>
        </div>
    `;

    shell.addEventListener('click', event => {
        const action = event.target.closest('[data-consent-action]')?.dataset.consentAction;
        if (!action) return;

        if (action === 'customize') {
            shell.querySelector('#eden-consent-panel')?.classList.toggle('show');
            event.target.textContent = en ? 'Save choices' : 'บันทึกตัวเลือก';
            event.target.dataset.consentAction = 'save';
            return;
        }

        const analytics = action === 'all' || (action === 'save' && shell.querySelector('#eden-consent-analytics')?.checked);
        const marketing = action === 'all' || (action === 'save' && shell.querySelector('#eden-consent-marketing')?.checked);
        saveConsent({ analytics, marketing });
        shell.remove();
        loadAllowedIntegrations();
        trackAutoEvents();
    });

    document.body.appendChild(shell);
}

function captureAutoEventSnapshot() {
    const path = location.pathname;
    const params = new URLSearchParams(location.search);
    const cart = readCart();
    const pendingOrder = readJSON('eden_pending_order', null) || {};

    return {
        path,
        paid: params.get('paid') === '1',
        orderId: params.get('order') || pendingOrder.id || '',
        cart,
        cartValue: cartValue(),
        pendingValue: moneyValue(pendingOrder.totalAmount || pendingOrder.total),
        isCheckout: /\/checkout(?:-en)?(?:\.html)?$/i.test(path)
    };
}

function trackAutoEvents(snapshot = pendingAutoSnapshot || captureAutoEventSnapshot()) {
    if (!snapshot) return;

    if (!checkoutTracked && snapshot.isCheckout && snapshot.cart.length) {
        checkoutTracked = true;
        track('begin_checkout', {
            value: snapshot.cartValue,
            items: snapshot.cart.map(item => ({
                item_id: item.id,
                item_name: item.name,
                price: moneyValue(item.price),
                quantity: moneyValue(item.quantity || 1)
            }))
        });
    }

    if (!purchaseTracked && snapshot.paid) {
        purchaseTracked = true;
        track('purchase', {
            transaction_id: snapshot.orderId,
            value: snapshot.pendingValue || snapshot.cartValue
        });
    }
}

function bindBehaviorTracking() {
    document.addEventListener('click', event => {
        const addButton = event.target.closest('.btn-add-cart');
        if (addButton && !addButton.disabled) {
            track('add_to_cart', {
                item_id: addButton.dataset.id || addButton.dataset.name || '',
                item_name: addButton.dataset.name || '',
                value: moneyValue(addButton.dataset.price)
            });
        }
    });

    document.addEventListener('submit', event => {
        if (event.target?.matches?.('.booking-form')) {
            track('booking_submit', { content_name: 'Booking form' });
        }
    }, true);
}

function exposePublicAPI() {
    window.EdenMarketing = {
        get settings() { return marketingSettings; },
        get consent() { return currentConsent; },
        track,
        acceptAll() {
            saveConsent({ analytics: true, marketing: true });
            document.getElementById('eden-consent-banner')?.remove();
            loadAllowedIntegrations();
        },
        necessaryOnly() {
            saveConsent({ analytics: false, marketing: false });
            document.getElementById('eden-consent-banner')?.remove();
        },
        resetConsent() {
            localStorage.removeItem(CONSENT_KEY);
            localStorage.removeItem(LEGACY_CONSENT_KEY);
            currentConsent = null;
            googleToolsLoaded = false;
            metaPixelLoaded = false;
            renderConsentBanner();
        }
    };
}

async function init() {
    ensureGoogleConsentBootstrap();
    exposePublicAPI();
    currentConsent = readConsent();
    pendingAutoSnapshot = captureAutoEventSnapshot();
    removeLegacyBanner();

    if (!currentConsent) renderConsentBanner();
    else updateGoogleConsent(currentConsent);

    marketingSettings = await loadSettings();

    if (currentConsent) {
        updateGoogleConsent(currentConsent);
        loadAllowedIntegrations();
    }

    bindBehaviorTracking();
    trackAutoEvents();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
