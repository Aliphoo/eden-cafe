const REVIEW_CACHE_URL = 'https://firestore.googleapis.com/v1/projects/edencafe-d9095/databases/(default)/documents/google_reviews?pageSize=1';

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeImageURL(value) {
    const url = String(value ?? '').trim();
    return /^https?:\/\//i.test(url) ? url : '';
}

async function fetchReviewCache() {
    const response = await fetch(REVIEW_CACHE_URL, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Google review data unavailable: ${response.status}`);

    const documents = Array.isArray(data.documents) ? data.documents : [];
    const cacheDoc = documents.find(doc => String(doc.name || '').endsWith('/cache')) || documents[0];
    const cache = cacheDoc ? fromFirestoreFields(cacheDoc.fields || {}) : null;
    if (!cache) throw new Error('Google review data unavailable');
    return cache;
}

function fromFirestoreFields(fields) {
    const out = {};
    Object.entries(fields || {}).forEach(([key, value]) => {
        out[key] = fromFirestoreValue(value);
    });
    return out;
}

function fromFirestoreValue(value) {
    if (!value || typeof value !== 'object') return value;
    if ('stringValue' in value) return value.stringValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return Number(value.doubleValue);
    if ('booleanValue' in value) return Boolean(value.booleanValue);
    if ('timestampValue' in value) return value.timestampValue;
    if ('nullValue' in value) return null;
    if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
    if ('mapValue' in value) return fromFirestoreFields(value.mapValue.fields || {});
    return value;
}

async function loadCachedGoogleReviews() {
    const containerEl = document.getElementById('google-reviews-container');
    if (!containerEl) return;

    try {
        const cache = await fetchReviewCache();
        updateReviewsUI(cache);
    } catch (_) {
        showReviewCachePending();
    }
}

function showReviewCachePending() {
    const countEl = document.getElementById('google-rating-count');
    const containerEl = document.getElementById('google-reviews-container');
    if (!containerEl) return;

    const path = window.location.pathname;
    const isEnglish = path.includes('-en') || path.endsWith('/en');
    const mapsReviewURL = 'https://maps.app.goo.gl/BYJNa4mXjVNaLDPy5';
    const openLabel = isEnglish ? 'Open Google Maps' : 'เปิด Google Maps';

    if (countEl) {
        countEl.textContent = isEnglish ? '(Google Maps reviews)' : '(รีวิวบน Google Maps)';
    }

    const cards = [
        {
            icon: 'G',
            title: 'Google Maps Reviews',
            badge: 'Eden Cafe',
            text: isEnglish
                ? 'Read the latest public reviews from Eden Cafe on Google Maps.'
                : 'อ่านรีวิวจริงล่าสุดของ Eden Cafe ได้บน Google Maps'
        },
        {
            icon: '5★',
            title: isEnglish ? '5-star reviews' : 'รีวิว 5 ดาว',
            badge: '★★★★★',
            text: isEnglish
                ? 'See verified customer feedback directly on the public Google Maps profile.'
                : 'ดูเสียงตอบรับจากลูกค้าจริงได้จากโปรไฟล์ Google Maps ของร้าน'
        },
        {
            icon: '↗',
            title: isEnglish ? 'Latest reviews' : 'รีวิวล่าสุด',
            badge: 'Google Maps',
            text: isEnglish
                ? 'Open the live Google Maps profile to view the newest public reviews.'
                : 'เปิดโปรไฟล์ Google Maps เพื่อดูรีวิวจริงล่าสุดได้ทันที',
            action: true
        }
    ];

    containerEl.innerHTML = cards.map(card => `
        <div class="hero-review-card">
            <div style="display:flex; gap:10px; margin-bottom:8px; align-items:center;">
                <div style="width:32px; height:32px; background:rgba(255,255,255,0.3); border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:0.9rem; color:white;">${escapeHTML(card.icon)}</div>
                <div>
                    <div style="font-size:0.85rem; font-weight:bold; line-height:1; color:white;">${escapeHTML(card.title)}</div>
                    <div style="color:#FFD700; font-size:0.75rem; margin-top:3px;">${escapeHTML(card.badge)}</div>
                </div>
            </div>
            <p style="font-size:0.8rem; line-height:1.4; opacity:0.9; margin:0 0 ${card.action ? '10px' : '0'}; font-style:italic; color:white;">"${escapeHTML(card.text)}"</p>
            ${card.action ? `<a href="${mapsReviewURL}" target="_blank" rel="noopener noreferrer" style="display:inline-flex; padding:7px 12px; border-radius:999px; background:rgba(255,255,255,0.22); color:white; text-decoration:none; font-size:0.78rem; font-weight:700;">${escapeHTML(openLabel)}</a>` : ''}
        </div>
    `).join('');
}
function updateReviewsUI(cache) {
    const scoreEl = document.getElementById('google-rating-score');
    const countEl = document.getElementById('google-rating-count');
    const containerEl = document.getElementById('google-reviews-container');

    if (!scoreEl || !countEl || !containerEl) return;

    const path = window.location.pathname;
    const isEnglish = path.includes('-en') || path.endsWith('/en');
    const rating = Number(cache.rating) || 0;
    const totalReviews = Number(cache.userRatingsTotal) || Number(cache.user_ratings_total) || 0;
    const reviews = Array.isArray(cache.reviews) ? cache.reviews : [];

    if (rating > 0) scoreEl.textContent = '★ ' + rating.toFixed(1).replace('.0', '');
    if (totalReviews > 0) {
        countEl.textContent = isEnglish
            ? `(${totalReviews.toLocaleString()} reviews on Google Maps)`
            : `(${totalReviews.toLocaleString()} รีวิวบน Google Maps)`;
    }

    const visibleReviews = reviews.filter(review => Number(review.rating) === 5).slice(0, 5);
    if (visibleReviews.length === 0) {
        showReviewCachePending();
        return;
    }

    containerEl.innerHTML = '';
    visibleReviews.forEach(review => {
        const ratingValue = Math.max(0, Math.min(5, Number(review.rating) || 0));
        const starsStr = '★'.repeat(ratingValue);
        const authorName = String(review.authorName || review.author_name || 'Google user');
        const initial = escapeHTML(authorName.charAt(0).toUpperCase() || 'G');
        const profilePhotoUrl = safeImageURL(review.profilePhotoUrl || review.profile_photo_url);
        const profilePic = profilePhotoUrl
            ? '<img loading="lazy" src="' + profilePhotoUrl + '" alt="" referrerpolicy="no-referrer" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">'
            : initial;
        const reviewText = String(review.text || '');

        const cardHTML = `
            <div class="hero-review-card">
                <div style="display: flex; gap: 10px; margin-bottom: 8px; align-items: center;">
                    <div style="width: 32px; height: 32px; background: rgba(255,255,255,0.3); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.9rem; overflow: hidden;">
                        ${profilePic}
                    </div>
                    <div>
                        <div style="font-size: 0.85rem; font-weight: bold; line-height: 1; color: white;">${escapeHTML(authorName)}</div>
                        <div style="color: #FFD700; font-size: 0.75rem; margin-top: 3px;">${starsStr}</div>
                    </div>
                </div>
                <p style="font-size: 0.8rem; line-height: 1.4; opacity: 0.9; margin: 0; font-style: italic; color: white;">
                    "${escapeHTML(reviewText.length > 100 ? reviewText.substring(0, 100) + '...' : reviewText)}"
                </p>
            </div>`;

        containerEl.innerHTML += cardHTML;
    });
}

document.addEventListener('DOMContentLoaded', loadCachedGoogleReviews);
