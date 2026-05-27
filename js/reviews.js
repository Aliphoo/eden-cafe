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
    if (!response.ok) throw new Error(data.error || `Review cache unavailable: ${response.status}`);

    const documents = Array.isArray(data.documents) ? data.documents : [];
    const cacheDoc = documents.find(doc => String(doc.name || '').endsWith('/cache')) || documents[0];
    const cache = cacheDoc ? fromFirestoreFields(cacheDoc.fields || {}) : null;
    if (!cache) throw new Error('Review cache is empty');
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
    } catch (error) {
        showReviewCachePending(error.message);
    }
}

function showReviewCachePending(reason) {
    const countEl = document.getElementById('google-rating-count');
    const containerEl = document.getElementById('google-reviews-container');
    if (!containerEl) return;

    const path = window.location.pathname;
    const isEnglish = path.includes('-en') || path.endsWith('/en');
    const mapsReviewURL = 'https://maps.app.goo.gl/BYJNa4mXjVNaLDPy5';

    if (countEl) {
        countEl.textContent = isEnglish
            ? '(waiting for real Google Maps review cache)'
            : '(กำลังรอข้อมูลรีวิวจริงจาก Google Maps)';
    }

    containerEl.innerHTML = `
        <div class="hero-review-card">
            <div style="display: flex; gap: 10px; margin-bottom: 8px; align-items: center;">
                <div style="width: 32px; height: 32px; background: rgba(255,255,255,0.3); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.9rem;">G</div>
                <div>
                    <div style="font-size: 0.85rem; font-weight: bold; line-height: 1; color: white;">Google Maps Reviews</div>
                    <div style="color: #FFD700; font-size: 0.75rem; margin-top: 3px;">${isEnglish ? 'Waiting for real data' : 'รอข้อมูลจริง'}</div>
                </div>
            </div>
            <p style="font-size: 0.8rem; line-height: 1.4; opacity: 0.9; margin: 0; font-style: italic; color: white;">
                "${isEnglish ? 'The review cache is not ready yet. No fake reviews are shown here.' : 'ระบบยังไม่มี cache รีวิวจริง จึงไม่แสดงรีวิวปลอมในหน้านี้'}"
            </p>
        </div>
        <div class="hero-review-card">
            <div style="display: flex; gap: 10px; margin-bottom: 8px; align-items: center;">
                <div style="width: 32px; height: 32px; background: rgba(255,215,0,0.25); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.85rem; color: white;">5★</div>
                <div>
                    <div style="font-size: 0.85rem; font-weight: bold; line-height: 1; color: white;">${isEnglish ? '5-star review feed' : 'ฟีดรีวิว 5 ดาว'}</div>
                    <div style="color: #FFD700; font-size: 0.75rem; margin-top: 3px;">★★★★★</div>
                </div>
            </div>
            <p style="font-size: 0.8rem; line-height: 1.4; opacity: 0.9; margin: 0; font-style: italic; color: white;">
                "${isEnglish ? 'Once the server API key is configured, this area will show the newest five 5-star Google reviews.' : 'เมื่อตั้งค่า Server API key แล้ว ตรงนี้จะแสดงรีวิว Google 5 ดาวล่าสุด จำนวน 5 รีวิว'}"
            </p>
        </div>
        <div class="hero-review-card">
            <div style="display: flex; gap: 10px; margin-bottom: 8px; align-items: center;">
                <div style="width: 32px; height: 32px; background: rgba(255,255,255,0.3); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.9rem;">↗</div>
                <div>
                    <div style="font-size: 0.85rem; font-weight: bold; line-height: 1; color: white;">${isEnglish ? 'Latest reviews' : 'รีวิวล่าสุด'}</div>
                    <div style="color: #FFD700; font-size: 0.75rem; margin-top: 3px;">Google Maps</div>
                </div>
            </div>
            <p style="font-size: 0.8rem; line-height: 1.4; opacity: 0.9; margin: 0 0 10px; font-style: italic; color: white;">
                "${isEnglish ? 'Open the live Google Maps profile to view the latest public reviews now.' : 'เปิดโปรไฟล์ Google Maps เพื่อดูรีวิวจริงล่าสุดได้ทันที'}"
            </p>
            <a href="${mapsReviewURL}" target="_blank" rel="noopener noreferrer" style="display:inline-flex; padding: 7px 12px; border-radius: 999px; background: rgba(255,255,255,0.22); color: white; text-decoration: none; font-size: 0.78rem; font-weight: 700;">
                ${isEnglish ? 'Open Google Maps' : 'เปิด Google Maps'}
            </a>
        </div>`;
    console.warn('Review cache pending:', reason);
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
        showReviewCachePending('Review cache has no 5-star reviews');
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
