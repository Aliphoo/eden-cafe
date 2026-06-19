import { auth, db, storage } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    setDoc
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
    deleteObject,
    getDownloadURL,
    ref,
    uploadBytes
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

const rootId = 'blog-cms-admin-root';
const collections = {
    posts: 'blogs',
    categories: 'blog_categories',
    tags: 'blog_tags',
    media: 'blog_media_assets',
    revisions: 'blog_revisions',
    users: 'blog_users',
    settings: 'blog_settings'
};

let state = {
    tab: 'overview',
    posts: [],
    categories: [],
    tags: [],
    media: [],
    users: [],
    editingId: '',
    filterStatus: 'all',
    filterCategory: 'all',
    filterAuthor: 'all',
    sortBy: 'updated_at',
    search: '',
    previewMode: 'desktop',
    autosaveTimer: null,
    lastSaved: '',
    statusMessage: '',
    statusType: 'info'
};

const actionTypes = Object.freeze({
    new: 'navigation',
    edit: 'navigation',
    'preview-mode': 'navigation',
    prompt: 'utility',
    'add-faq': 'utility',
    'save-draft': 'async-write',
    publish: 'async-write',
    schedule: 'async-write',
    duplicate: 'async-write',
    archive: 'async-write',
    delete: 'destructive-write',
    'add-category': 'async-write',
    'add-tag': 'async-write',
    'save-category': 'async-write',
    'save-tag': 'async-write',
    'upload-media': 'async-upload',
    'copy-media': 'async-utility',
    'delete-media': 'destructive-write',
    seed: 'async-write',
    'upload-cover': 'async-upload'
});

const actionBusyLabels = Object.freeze({
    'save-draft': 'Saving...',
    publish: 'Publishing...',
    schedule: 'Scheduling...',
    duplicate: 'Duplicating...',
    archive: 'Archiving...',
    delete: 'Deleting...',
    'add-category': 'Adding...',
    'add-tag': 'Adding...',
    'save-category': 'Saving...',
    'save-tag': 'Saving...',
    'upload-media': 'Uploading...',
    'copy-media': 'Copying...',
    'delete-media': 'Deleting...',
    seed: 'Seeding...',
    'upload-cover': 'Uploading...'
});

const actionProgressMessages = Object.freeze({
    'save-draft': 'กำลังบันทึก Draft...',
    publish: 'กำลัง Publish บทความ...',
    schedule: 'กำลังตั้งเวลาเผยแพร่...',
    duplicate: 'กำลังคัดลอกบทความ...',
    archive: 'กำลัง Archive บทความ...',
    delete: 'กำลังลบบทความ...',
    'add-category': 'กำลังเพิ่ม Category...',
    'add-tag': 'กำลังเพิ่ม Tag...',
    'save-category': 'กำลังบันทึก Category...',
    'save-tag': 'กำลังบันทึก Tag...',
    'upload-media': 'กำลังอัปโหลดรูปภาพ...',
    'copy-media': 'กำลังคัดลอก URL...',
    'delete-media': 'กำลังลบรูปภาพ...',
    seed: 'กำลังสร้างข้อมูลเริ่มต้น...',
    'upload-cover': 'กำลังอัปโหลดรูปหน้าปก...'
});

const actionSuccessMessages = Object.freeze({
    'save-draft': 'บันทึก Draft สำเร็จ',
    publish: 'Publish บทความสำเร็จ',
    schedule: 'ตั้งเวลาเผยแพร่สำเร็จ',
    duplicate: 'คัดลอกบทความสำเร็จ',
    archive: 'Archive บทความสำเร็จ',
    delete: 'ลบบทความสำเร็จ',
    'add-category': 'เพิ่ม Category สำเร็จ',
    'add-tag': 'เพิ่ม Tag สำเร็จ',
    'save-category': 'บันทึก Category สำเร็จ',
    'save-tag': 'บันทึก Tag สำเร็จ',
    'upload-media': 'อัปโหลดรูปภาพสำเร็จ',
    'copy-media': 'คัดลอก URL แล้ว',
    'delete-media': 'ลบรูปภาพสำเร็จ',
    seed: 'สร้างข้อมูลเริ่มต้นสำเร็จ',
    'upload-cover': 'อัปโหลดรูปหน้าปกสำเร็จ'
});

class BlogValidationError extends Error {
    constructor(message, missing = []) {
        super(message);
        this.name = 'BlogValidationError';
        this.missing = missing;
        this.isValidationError = true;
    }
}

const blankPost = () => ({
    title: '',
    slug: '',
    excerpt: '',
    content: '',
    cover_image_url: '',
    cover_image_alt: '',
    cover_image_caption: '',
    status: 'draft',
    author_id: auth.currentUser?.uid || '',
    author_name: auth.currentUser?.displayName || auth.currentUser?.email || 'Eden Writer',
    category_id: '',
    category_name: '',
    tag_ids: [],
    tags: [],
    seo_title: '',
    seo_description: '',
    focus_keyword: '',
    canonical_url: '',
    og_title: '',
    og_description: '',
    og_image_url: '',
    twitter_title: '',
    twitter_description: '',
    twitter_image_url: '',
    robots_index: true,
    robots_follow: true,
    schema_type: 'BlogPosting',
    brand_context: '',
    business_context: '',
    faqs: [],
    is_featured: false,
    published_at: '',
    scheduled_at: ''
});

function $(selector, scope = document) {
    return scope.querySelector(selector);
}

function $all(selector, scope = document) {
    return [...scope.querySelectorAll(selector)];
}

function text(value = '') {
    return String(value ?? '').trim();
}

function escapeHTML(value = '') {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function slugify(value = '') {
    return text(value)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function htmlToText(html = '') {
    const div = document.createElement('div');
    div.innerHTML = html;
    return text(div.textContent || div.innerText || '');
}

function countWords(html = '') {
    const value = htmlToText(html);
    const thaiChars = ((value.match(/[\u0E00-\u0E7F]+/g) || []).join('')).length;
    const latinWords = (value.match(/[A-Za-z0-9]+/g) || []).length;
    return latinWords + Math.ceil(thaiChars / 5);
}

function readingTime(words = 0) {
    return Math.max(1, Math.ceil(words / 220));
}

function nowIso() {
    return new Date().toISOString();
}

function waitForAuthReady() {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise((resolve) => {
        let done = false;
        let unsubscribe = () => {};
        const finish = (user) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unsubscribe();
            resolve(user);
        };
        const timer = setTimeout(() => finish(auth.currentUser || null), 2500);
        unsubscribe = onAuthStateChanged(auth, finish);
    });
}

function dateValue(value) {
    if (!value) return '';
    if (typeof value?.toDate === 'function') return value.toDate().toISOString();
    return String(value);
}

function formatDate(value) {
    const raw = dateValue(value);
    if (!raw) return '-';
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('th-TH');
}

function normalizePost(id, data = {}) {
    const title = text(data.title);
    const categoryName = text(data.category_name || data.categoryName || data.category || '');
    const tags = Array.isArray(data.tags) ? data.tags.map(text).filter(Boolean) : text(data.tags).split(',').map(text).filter(Boolean);
    const content = text(data.content || data.body);
    return {
        id,
        ...blankPost(),
        ...data,
        title,
        slug: slugify(data.slug || id || title),
        excerpt: text(data.excerpt || data.seo_description || htmlToText(content).slice(0, 170)),
        content,
        cover_image_url: text(data.cover_image_url || data.coverImageUrl || data.imageUrl || data.og_image_url),
        cover_image_alt: text(data.cover_image_alt || data.coverAlt || title),
        status: text(data.status || 'draft').toLowerCase(),
        author_id: text(data.author_id || data.authorId || ''),
        author_name: text(data.author_name || data.authorName || data.author || 'Eden Writer'),
        category_id: text(data.category_id || data.categoryId || slugify(categoryName)),
        category_name: categoryName,
        tag_ids: Array.isArray(data.tag_ids) ? data.tag_ids.map(text) : tags.map(slugify),
        tags,
        faqs: Array.isArray(data.faqs) ? data.faqs : [],
        robots_index: data.robots_index !== false,
        robots_follow: data.robots_follow !== false,
        schema_type: text(data.schema_type || data.schemaType || 'BlogPosting'),
        is_featured: data.is_featured === true || data.isFeatured === true,
        published_at: dateValue(data.published_at || data.publishedAt),
        scheduled_at: dateValue(data.scheduled_at || data.scheduledAt),
        created_at: dateValue(data.created_at || data.createdAt),
        updated_at: dateValue(data.updated_at || data.updatedAt),
        word_count: Number(data.word_count || data.wordCount) || countWords(content),
        reading_time: Number(data.reading_time || data.readingTime) || readingTime(countWords(content))
    };
}

async function listCollection(name) {
    const snap = await getDocs(collection(db, name));
    return snap.docs.map((item) => ({ id: item.id, ...item.data() }));
}

async function getBlogRole() {
    const user = auth.currentUser;
    if (!user) return null;
    const existing = await getDoc(doc(db, collections.users, user.uid)).catch(() => null);
    if (existing?.exists()) return { id: existing.id, ...existing.data() };
    const fallback = {
        id: user.uid,
        name: user.displayName || user.email || 'Eden Writer',
        email: user.email || '',
        role: 'admin',
        avatar_url: user.photoURL || '',
        bio: '',
        created_at: nowIso(),
        updated_at: nowIso()
    };
    await setDoc(doc(db, collections.users, user.uid), fallback, { merge: true }).catch(() => null);
    return fallback;
}

function canPublish() {
    const role = state.currentUser?.role || 'writer';
    return role === 'admin' || role === 'editor';
}

function canManage() {
    return (state.currentUser?.role || 'writer') === 'admin';
}

async function refreshData() {
    state.currentUser = await getBlogRole();
    const [posts, categories, tags, media, users] = await Promise.all([
        listCollection(collections.posts),
        listCollection(collections.categories).catch(() => []),
        listCollection(collections.tags).catch(() => []),
        listCollection(collections.media).catch(() => []),
        listCollection(collections.users).catch(() => [])
    ]);
    state.posts = posts.map((item) => normalizePost(item.id, item)).sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
    state.categories = categories.map((item) => ({ id: item.id, name: text(item.name), slug: slugify(item.slug || item.id || item.name), description: text(item.description), seo_title: text(item.seo_title), seo_description: text(item.seo_description), is_active: item.is_active !== false }));
    state.tags = tags.map((item) => ({ id: item.id, name: text(item.name), slug: slugify(item.slug || item.id || item.name) }));
    state.media = media.map((item) => ({ id: item.id, ...item })).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    state.users = users.map((item) => ({ id: item.id, ...item }));
}

function installStyles() {
    if ($('#blog-cms-admin-style')) return;
    const style = document.createElement('style');
    style.id = 'blog-cms-admin-style';
    style.textContent = `
        .blog-cms-admin-root{
            --cms-bg:#f6f7f4;--cms-panel:#ffffff;--cms-panel-soft:#fbfcfa;--cms-line:#d9e2dc;
            --cms-text:#14231b;--cms-muted:#66736c;--cms-green:#17633f;--cms-green-dark:#103e2b;
            --cms-green-soft:#e7f3ec;--cms-blue:#285b83;--cms-blue-soft:#e7f0f7;
            --cms-amber:#966310;--cms-amber-soft:#fff2d7;--cms-red:#a13a3a;--cms-red-soft:#fde8e8;
            display:grid;gap:16px;color:var(--cms-text);background:var(--cms-bg);padding:2px 0 18px;
        }
        .blog-cms-topbar{display:grid;grid-template-columns:minmax(280px,1fr)auto;gap:18px;align-items:center;padding:18px 20px;border:1px solid #d2ded6;border-radius:8px;background:linear-gradient(135deg,#123925,#1c5f3d);color:#fff;box-shadow:0 18px 32px rgba(20,45,31,.14)}
        .blog-cms-topbar h2{font-size:1.75rem;line-height:1.1;margin:3px 0 0;color:#fff}.blog-cms-eyebrow{display:block;font-size:.75rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#bfe3cc}
        .blog-cms-topbar-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}.blog-cms-topbar-meta span{border:1px solid rgba(255,255,255,.26);background:rgba(255,255,255,.1);border-radius:999px;padding:6px 10px;font-weight:800;font-size:.82rem}
        .blog-cms-topbar-actions{display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap}.blog-cms-admin-root button,.blog-cms-admin-root input,.blog-cms-admin-root select,.blog-cms-admin-root textarea{font:inherit}
        .blog-cms-tabs{display:flex;gap:4px;align-items:center;overflow-x:auto;border:1px solid var(--cms-line);border-radius:8px;background:var(--cms-panel);padding:6px;box-shadow:0 10px 24px rgba(31,51,39,.05)}
        .blog-cms-tabs button{white-space:nowrap;border:0;background:transparent;color:#385044;border-radius:6px;padding:9px 12px;font-weight:800;cursor:pointer}
        .blog-cms-tabs button:hover{background:#f0f5f1}.blog-cms-tabs button.active{background:var(--cms-green-dark);color:#fff}
        .blog-cms-card{background:var(--cms-panel);border:1px solid var(--cms-line);border-radius:8px;padding:16px;box-shadow:0 10px 24px rgba(22,41,29,.055)}
        .blog-cms-card h3{margin:0 0 12px;color:#17291f;font-size:1rem;line-height:1.3}.blog-cms-muted{color:var(--cms-muted)}
        .blog-cms-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;border:1px solid var(--cms-green-dark);border-radius:7px;background:var(--cms-green-dark);color:#fff;padding:8px 12px;font-weight:850;text-decoration:none;cursor:pointer;line-height:1}
        .blog-cms-btn:hover{filter:brightness(.98);transform:translateY(-1px)}.blog-cms-btn.secondary{border-color:#cbd8d0;background:#fff;color:#20362a}.blog-cms-btn.ghost{border-color:transparent;background:transparent;color:#284238}.blog-cms-btn.danger{border-color:#b84a4a;background:#b84a4a;color:#fff}
        .blog-cms-btn:disabled{opacity:.48;cursor:not-allowed;transform:none}.blog-cms-btn.is-busy{opacity:.76;cursor:progress;transform:none;pointer-events:none}.blog-cms-btn.is-busy::before{content:"";width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:blogCmsSpin .75s linear infinite}.blog-cms-icon-btn{min-width:48px;padding:0 9px}.blog-cms-action-stack{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
        @keyframes blogCmsSpin{to{transform:rotate(360deg)}}
        .blog-cms-chip-list{display:flex;gap:8px;flex-wrap:wrap}.blog-cms-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid #cbd8d0;background:#fff;border-radius:999px;padding:7px 10px;font-weight:800;color:#33483d;cursor:pointer}.blog-cms-chip.active{background:var(--cms-green-soft);color:var(--cms-green);border-color:#a7d2b8}
        .blog-cms-kpis{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:10px}.blog-cms-kpi{display:grid;gap:6px;min-height:104px}.blog-cms-kpi strong{font-size:1.95rem;line-height:1;color:#14231b}.blog-cms-kpi span{color:var(--cms-muted);font-weight:850}.blog-cms-kpi small{color:#7a8780;font-weight:700}
        .blog-cms-dashboard-grid{display:grid;grid-template-columns:minmax(0,1.45fr)minmax(280px,.75fr);gap:14px}.blog-cms-attention{display:grid;gap:10px}.blog-cms-attention-row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;border:1px solid #edf1ed;border-radius:8px;padding:11px 12px;background:#fbfcfb}.blog-cms-attention-row strong{font-size:1.25rem}.blog-cms-attention-row.warn strong{color:var(--cms-amber)}.blog-cms-attention-row.danger strong{color:var(--cms-red)}.blog-cms-attention-row.info strong{color:var(--cms-blue)}
        .blog-cms-pipeline{display:grid;gap:10px}.blog-cms-pipeline-row{display:grid;grid-template-columns:100px 1fr 42px;gap:10px;align-items:center;font-weight:800;color:#3c5146}.blog-cms-bar{height:9px;background:#edf2ee;border-radius:999px;overflow:hidden}.blog-cms-bar span{display:block;height:100%;background:var(--cms-green);border-radius:999px}.blog-cms-bar.draft span{background:var(--cms-amber)}.blog-cms-bar.scheduled span{background:var(--cms-blue)}.blog-cms-bar.archived span{background:var(--cms-red)}
        .blog-cms-toolbar{display:grid;grid-template-columns:minmax(260px,1fr)150px 170px 160px 150px;gap:10px;align-items:end}.blog-cms-toolbar input,.blog-cms-toolbar select,.blog-cms-form input,.blog-cms-form select,.blog-cms-form textarea{width:100%;min-height:42px;border:1px solid #cfdcd4;border-radius:7px;padding:9px 11px;background:#fff;color:var(--cms-text);outline:none}.blog-cms-toolbar input:focus,.blog-cms-toolbar select:focus,.blog-cms-form input:focus,.blog-cms-form select:focus,.blog-cms-form textarea:focus{border-color:#78af8b;box-shadow:0 0 0 3px rgba(23,99,63,.12)}
        .blog-cms-field-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:10px}.blog-cms-form label{display:grid;gap:6px;color:#43564c;font-weight:850;font-size:.84rem}.blog-cms-form label span{display:flex;align-items:center;gap:8px}.blog-cms-form textarea{min-height:96px;resize:vertical}
        .blog-cms-table-wrap{overflow:auto}.blog-cms-table{min-width:980px;width:100%;border-collapse:separate;border-spacing:0}.blog-cms-table th,.blog-cms-table td{border-bottom:1px solid #edf1ed;padding:12px 11px;text-align:left;vertical-align:middle}.blog-cms-table th{position:sticky;top:0;background:#f8faf8;color:#536159;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;z-index:1}.blog-cms-table tr:hover td{background:#fbfcfa}.blog-cms-post-title{display:grid;gap:4px}.blog-cms-post-title strong{line-height:1.35}.blog-cms-post-title small{color:#6d7a72}.blog-cms-cover-thumb{width:72px;height:52px;object-fit:cover;border-radius:7px;background:#edf2ee;border:1px solid #dfe8e2}.blog-cms-cover-empty{width:72px;height:52px;border-radius:7px;border:1px dashed #c7d5cc;background:#f4f7f4;color:#84918a;display:grid;place-items:center;font-weight:850}
        .blog-cms-status{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;font-size:.76rem;font-weight:900;text-transform:capitalize}.blog-cms-status.published{background:var(--cms-green-soft);color:var(--cms-green)}.blog-cms-status.draft{background:var(--cms-amber-soft);color:var(--cms-amber)}.blog-cms-status.scheduled{background:var(--cms-blue-soft);color:var(--cms-blue)}.blog-cms-status.archived{background:var(--cms-red-soft);color:var(--cms-red)}
        .blog-cms-score{display:grid;gap:5px;min-width:92px}.blog-cms-score-line{height:7px;border-radius:999px;background:#e9eee9;overflow:hidden}.blog-cms-score-line span{display:block;height:100%;background:var(--cms-green)}.blog-cms-score small{font-weight:850;color:#51645a}
        .blog-cms-editor-grid{display:grid;grid-template-columns:minmax(0,1fr)340px;gap:14px;align-items:start}.blog-cms-editor-main,.blog-cms-sidebar{display:grid;gap:12px;align-content:start}.blog-cms-editor-main{min-width:0}.blog-cms-sidebar{position:sticky;top:14px}
        .blog-cms-editor-toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.blog-cms-editor-toolbar h3{margin:0}.blog-cms-card>.blog-cms-editor-toolbar{margin-bottom:12px}.blog-cms-title-input{font-size:1.6rem;font-weight:900;line-height:1.2}.blog-cms-rich-toolbar{display:flex;gap:6px;flex-wrap:wrap;border:1px solid #dfe8e2;background:#f8faf8;border-radius:8px;padding:8px}.blog-cms-rich-toolbar button{border:1px solid transparent;background:#fff;color:#26382f;border-radius:6px;padding:7px 9px;font-weight:850;cursor:pointer}.blog-cms-rich-toolbar button:hover{border-color:#bcd0c3}
        .blog-cms-editor{min-height:470px;border:1px solid #cfdcd4;border-radius:8px;padding:22px;background:#fff;line-height:1.82;outline:none;overflow:auto;font-size:1rem}.blog-cms-editor:focus{border-color:#78af8b;box-shadow:0 0 0 3px rgba(23,99,63,.1)}.blog-cms-editor:empty:before{content:attr(data-placeholder);color:#88958e}
        .blog-cms-preview{border:1px solid #dfe8e2;border-radius:8px;background:#fff;padding:20px;line-height:1.8}.blog-cms-preview.mobile{max-width:390px;margin:auto}.blog-cms-preview img{max-width:100%;height:auto}
        .blog-cms-check{display:grid;gap:8px}.blog-cms-check div{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;border:1px solid #edf1ed;border-radius:7px;padding:8px 10px}.blog-cms-check strong{border-radius:999px;padding:4px 8px;font-size:.75rem}.blog-cms-check .pass strong{background:var(--cms-green-soft);color:var(--cms-green)}.blog-cms-check .warn strong{background:var(--cms-amber-soft);color:var(--cms-amber)}.blog-cms-check .missing strong{background:var(--cms-red-soft);color:var(--cms-red)}
        .blog-cms-media-grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px}.blog-cms-media-card img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:7px;background:#edf1ed}.blog-cms-alert{border:1px solid #c8dcff;background:#eef5ff;color:#285b83;border-radius:8px;padding:12px;font-weight:800}.blog-cms-alert.success{border-color:#b7dfc1;background:#edf8f0;color:#17633f}.blog-cms-alert.error{border-color:#f0b7b7;background:#fff0f0;color:#9b2f2f}
        @media(max-width:1180px){.blog-cms-topbar,.blog-cms-editor-grid,.blog-cms-dashboard-grid,.blog-cms-toolbar,.blog-cms-field-grid{grid-template-columns:1fr}.blog-cms-sidebar{position:static}.blog-cms-kpis{grid-template-columns:repeat(2,minmax(130px,1fr))}.blog-cms-media-grid{grid-template-columns:repeat(2,minmax(150px,1fr))}.blog-cms-topbar-actions{justify-content:flex-start}}
        @media(max-width:640px){.blog-cms-admin-root{padding-bottom:10px}.blog-cms-topbar{padding:15px}.blog-cms-kpis{grid-template-columns:1fr}.blog-cms-action-stack,.blog-cms-topbar-actions{width:100%}.blog-cms-btn{width:100%}.blog-cms-icon-btn{width:auto}.blog-cms-table{min-width:760px}}
    `;
    document.head.appendChild(style);
}

function root() {
    return document.getElementById(rootId);
}

function setStatus(message, type = 'info') {
    state.statusMessage = text(message);
    state.statusType = type || 'info';
    const el = $('#blog-cms-admin-status');
    if (el) {
        el.className = `blog-cms-alert ${state.statusType}`;
        el.textContent = state.statusMessage;
        el.style.display = state.statusMessage ? 'block' : 'none';
        el.setAttribute('role', state.statusType === 'error' ? 'alert' : 'status');
        el.setAttribute('aria-live', state.statusType === 'error' ? 'assertive' : 'polite');
    }
}

function actionNeedsBusy(action) {
    const type = actionTypes[action];
    return type === 'async-write' || type === 'async-upload' || type === 'async-utility' || type === 'destructive-write';
}

function setActionBusy(actionEl, action) {
    if (!actionEl || !actionNeedsBusy(action)) return () => {};
    if (actionEl.dataset.blogBusy === 'true') return null;
    const previous = {
        disabled: actionEl.disabled,
        label: actionEl.textContent
    };
    actionEl.dataset.blogBusy = 'true';
    actionEl.setAttribute('aria-busy', 'true');
    actionEl.classList.add('is-busy');
    if ('disabled' in actionEl) actionEl.disabled = true;
    if (actionBusyLabels[action]) actionEl.textContent = actionBusyLabels[action];
    return () => {
        if (!actionEl.isConnected) return;
        actionEl.dataset.blogBusy = 'false';
        actionEl.removeAttribute('aria-busy');
        actionEl.classList.remove('is-busy');
        if ('disabled' in actionEl) actionEl.disabled = previous.disabled;
        actionEl.textContent = previous.label;
    };
}

function formatActionError(error, action = '') {
    if (error?.isValidationError) return error.message;
    const raw = text(error?.message || error);
    const code = text(error?.code);
    if (code.includes('permission-denied') || /missing or insufficient permissions|permission denied|403/i.test(raw)) {
        if (['add-category', 'save-category'].includes(action)) {
            return 'Firebase ปฏิเสธสิทธิ์: สิทธิ์ collection หมวดหมู่ยังไม่พร้อมหรือบัญชีนี้ไม่มีสิทธิ์จัดการ Category';
        }
        return 'Firebase ปฏิเสธสิทธิ์: บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ หรือ Firestore rules ยังไม่อนุญาต';
    }
    if (code.includes('unavailable') || /network|offline|failed to fetch|internet/i.test(raw)) {
        return 'เชื่อมต่อไม่ได้: ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง';
    }
    if (/slug/i.test(raw) && /ซ้ำ|duplicate|already/i.test(raw)) {
        return 'Publish ไม่สำเร็จ: Slug ซ้ำ';
    }
    return raw || 'ดำเนินการไม่สำเร็จ';
}

async function runAction(actionEl, action, work) {
    const restore = setActionBusy(actionEl, action);
    if (restore === null) return null;
    if (actionNeedsBusy(action)) setStatus(actionProgressMessages[action] || 'กำลังดำเนินการ...', 'info');
    try {
        const result = await work();
        if (actionNeedsBusy(action) && result !== false) {
            setStatus(actionSuccessMessages[action] || 'ดำเนินการสำเร็จ', 'success');
        }
        return result;
    } catch (error) {
        setStatus(formatActionError(error, action), 'error');
        return null;
    } finally {
        if (restore) restore();
    }
}

function navHTML() {
    const tabs = [
        ['overview', 'Dashboard'],
        ['posts', 'Posts'],
        ['editor', state.editingId ? 'Editor' : 'New Post'],
        ['categories', 'หมวดหมู่'],
        ['tags', 'Tags'],
        ['media', 'Media'],
        ['seo', 'SEO'],
        ['authors', 'ผู้เขียน'],
        ['settings', 'Settings'],
        ['assistant', 'Assistant']
    ];
    return `<nav class="blog-cms-tabs" aria-label="Blog CMS sections">${tabs.map(([id, label]) => `<button type="button" data-blog-cms-tab="${id}" class="${state.tab === id ? 'active' : ''}">${label}</button>`).join('')}</nav>`;
}

function layoutHTML(content) {
    const published = state.posts.filter((post) => post.status === 'published').length;
    return `
        <div class="blog-cms-topbar">
            <div>
                <span class="blog-cms-eyebrow">Content Operations</span>
                <h2>Blog CMS</h2>
                <div class="blog-cms-topbar-meta">
                    <span>${state.posts.length} posts</span>
                    <span>${published} published</span>
                    <span>Role: ${escapeHTML(state.currentUser?.role || 'writer')}</span>
                </div>
            </div>
            <div class="blog-cms-topbar-actions">
                <a class="blog-cms-btn secondary" href="/blog" target="_blank" rel="noopener">ดูหน้าบล็อก</a>
                <button class="blog-cms-btn" type="button" data-blog-action="new">New Post</button>
                <button class="blog-cms-btn secondary" type="button" data-blog-action="seed">Seed Data</button>
            </div>
        </div>
        <div id="blog-cms-admin-status" class="blog-cms-alert ${escapeHTML(state.statusType || 'info')}" style="${state.statusMessage ? '' : 'display:none'}" role="${state.statusType === 'error' ? 'alert' : 'status'}" aria-live="${state.statusType === 'error' ? 'assertive' : 'polite'}">${escapeHTML(state.statusMessage || '')}</div>
        ${navHTML()}
        ${content}
    `;
}

function checklistStats(post) {
    const items = seoChecklist(post);
    const passed = items.filter((item) => item.state === 'ผ่าน').length;
    return { items, passed, total: items.length, percent: items.length ? Math.round((passed / items.length) * 100) : 0 };
}

function checklistTone(item) {
    if (item.state === 'ผ่าน') return 'pass';
    return item.state === 'ควรปรับปรุง' ? 'warn' : 'missing';
}

function kpiCard(label, value, caption = '') {
    return `<div class="blog-cms-card blog-cms-kpi"><strong>${value}</strong><span>${label}</span>${caption ? `<small>${caption}</small>` : ''}</div>`;
}

function statCards() {
    const missingSeo = state.posts.filter((post) => checklistStats(post).passed < 9).length;
    const missingCover = state.posts.filter((post) => !post.cover_image_url).length;
    const missingMeta = state.posts.filter((post) => !post.seo_description).length;
    const lastUpdated = state.posts[0]?.updated_at || state.posts[0]?.created_at;
    return `
        <div class="blog-cms-kpis">
            ${kpiCard('บทความทั้งหมด', state.posts.length, lastUpdated ? `อัปเดตล่าสุด ${formatDate(lastUpdated)}` : 'ยังไม่มีข้อมูล')}
            ${kpiCard('Published', state.posts.filter((post) => post.status === 'published').length, 'แสดงบนหน้าบ้าน')}
            ${kpiCard('Draft', state.posts.filter((post) => post.status === 'draft').length, 'รอตรวจ/เขียนต่อ')}
            ${kpiCard('Scheduled', state.posts.filter((post) => post.status === 'scheduled').length, 'ตั้งเวลาเผยแพร่')}
            ${kpiCard('หมวดหมู่', state.categories.length, `${state.tags.length} tags`)}
        </div>
        <div class="blog-cms-dashboard-grid">
            <div class="blog-cms-card">
                <h3>Publishing Pipeline</h3>
                <div class="blog-cms-pipeline">
                    ${pipelineRow('Published', state.posts.filter((post) => post.status === 'published').length, state.posts.length, 'published')}
                    ${pipelineRow('Draft', state.posts.filter((post) => post.status === 'draft').length, state.posts.length, 'draft')}
                    ${pipelineRow('Scheduled', state.posts.filter((post) => post.status === 'scheduled').length, state.posts.length, 'scheduled')}
                    ${pipelineRow('Archived', state.posts.filter((post) => post.status === 'archived').length, state.posts.length, 'archived')}
                </div>
            </div>
            <div class="blog-cms-card">
                <h3>ต้องตรวจวันนี้</h3>
                <div class="blog-cms-attention">
                    ${attentionRow('SEO score ต่ำ', missingSeo, 'danger')}
                    ${attentionRow('ไม่มี Cover Image', missingCover, 'warn')}
                    ${attentionRow('ไม่มี Meta Description', missingMeta, 'info')}
                </div>
            </div>
        </div>
    `;
}

function pipelineRow(label, count, total, tone) {
    const pct = total ? Math.round((count / total) * 100) : 0;
    return `<div class="blog-cms-pipeline-row"><span>${label}</span><div class="blog-cms-bar ${tone}"><span style="width:${pct}%"></span></div><strong>${count}</strong></div>`;
}

function attentionRow(label, count, tone) {
    return `<div class="blog-cms-attention-row ${tone}"><span>${label}</span><strong>${count}</strong></div>`;
}

function overviewHTML() {
    return `
        ${statCards()}
        <div class="blog-cms-card">
            <div class="blog-cms-editor-toolbar">
                <h3>บทความล่าสุด</h3>
                <button class="blog-cms-btn secondary" type="button" data-blog-cms-tab="posts">ดูทั้งหมด</button>
            </div>
            <div class="blog-cms-table-wrap">
                <table class="blog-cms-table">
                    <thead><tr><th>Title</th><th>Status</th><th>Category</th><th>SEO</th><th>Updated</th><th></th></tr></thead>
                    <tbody>${state.posts.slice(0, 8).map((post) => {
                        const score = checklistStats(post);
                        return `<tr><td><div class="blog-cms-post-title"><strong>${escapeHTML(post.title || '-')}</strong><small>/${escapeHTML(post.slug)}</small></div></td><td>${statusBadge(post.status)}</td><td>${escapeHTML(post.category_name || '-')}</td><td>${scoreHTML(score)}</td><td>${formatDate(post.updated_at || post.created_at)}</td><td><button class="blog-cms-btn secondary" type="button" data-blog-action="edit" data-id="${escapeHTML(post.id)}">Edit</button></td></tr>`;
                    }).join('') || `<tr><td colspan="6">ยังไม่มีบทความ</td></tr>`}</tbody>
                </table>
            </div>
        </div>
    `;
}

function statusBadge(status) {
    const safe = text(status || 'draft').toLowerCase();
    return `<span class="blog-cms-status ${safe}">${escapeHTML(safe)}</span>`;
}

function filteredPosts() {
    return state.posts
        .filter((post) => !state.search || `${post.title} ${post.excerpt} ${post.tags.join(' ')}`.toLowerCase().includes(state.search.toLowerCase()))
        .filter((post) => state.filterStatus === 'all' || post.status === state.filterStatus)
        .filter((post) => state.filterCategory === 'all' || post.category_id === state.filterCategory)
        .filter((post) => state.filterAuthor === 'all' || post.author_id === state.filterAuthor || post.author_name === state.filterAuthor)
        .sort((a, b) => String(b[state.sortBy] || '').localeCompare(String(a[state.sortBy] || '')));
}

function postListHTML() {
    const authors = [...new Set(state.posts.map((post) => post.author_id || post.author_name).filter(Boolean))];
    const rows = filteredPosts();
    return `
        <div class="blog-cms-card">
            <div class="blog-cms-editor-toolbar">
                <h3>Post Library</h3>
                <button class="blog-cms-btn" type="button" data-blog-action="new">New Post</button>
            </div>
            <div class="blog-cms-toolbar">
                <input id="blog-cms-search" type="search" placeholder="ค้นหาจากชื่อ, excerpt, tag" value="${escapeHTML(state.search)}">
                <select id="blog-cms-filter-status"><option value="all">ทุกสถานะ</option>${['draft','published','scheduled','archived'].map((item) => `<option value="${item}" ${state.filterStatus === item ? 'selected' : ''}>${item}</option>`).join('')}</select>
                <select id="blog-cms-filter-category"><option value="all">ทุกหมวดหมู่</option>${state.categories.map((item) => `<option value="${escapeHTML(item.id)}" ${state.filterCategory === item.id ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}</select>
                <select id="blog-cms-filter-author"><option value="all">ทุกผู้เขียน</option>${authors.map((item) => `<option value="${escapeHTML(item)}" ${state.filterAuthor === item ? 'selected' : ''}>${escapeHTML(item)}</option>`).join('')}</select>
                <select id="blog-cms-sort"><option value="created_at">วันที่สร้าง</option><option value="updated_at" ${state.sortBy === 'updated_at' ? 'selected' : ''}>วันที่แก้ไข</option><option value="published_at" ${state.sortBy === 'published_at' ? 'selected' : ''}>วันที่เผยแพร่</option></select>
            </div>
        </div>
        <div class="blog-cms-card blog-cms-table-wrap">
            <table class="blog-cms-table">
                <thead><tr><th>Cover</th><th>Title</th><th>Status</th><th>Category</th><th>SEO</th><th>Updated</th><th>Actions</th></tr></thead>
                <tbody>${rows.map(postRowHTML).join('') || '<tr><td colspan="7">ไม่พบบทความ</td></tr>'}</tbody>
            </table>
        </div>
    `;
}

function scoreHTML(score) {
    return `<div class="blog-cms-score"><div class="blog-cms-score-line"><span style="width:${score.percent}%"></span></div><small>${score.passed}/${score.total}</small></div>`;
}

function postRowHTML(post) {
    const cover = post.cover_image_url ? `<img class="blog-cms-cover-thumb" src="${escapeHTML(post.cover_image_url)}" alt="">` : '<div class="blog-cms-cover-empty">IMG</div>';
    const score = checklistStats(post);
    return `<tr>
        <td>${cover}</td>
        <td><div class="blog-cms-post-title"><strong>${escapeHTML(post.title || 'Untitled')}</strong><small>/${escapeHTML(post.slug || '-')} · ${escapeHTML(post.author_name || 'No author')}</small></div></td>
        <td>${statusBadge(post.status)}</td>
        <td>${escapeHTML(post.category_name || post.category_id || '-')}</td>
        <td>${scoreHTML(score)}</td>
        <td>${formatDate(post.updated_at || post.published_at || post.created_at)}</td>
        <td>
            <div class="blog-cms-action-stack">
                <button class="blog-cms-btn secondary" type="button" data-blog-action="edit" data-id="${escapeHTML(post.id)}">Edit</button>
                <a class="blog-cms-btn secondary" href="/blog/${encodeURIComponent(post.slug)}" target="_blank" rel="noopener">Preview</a>
                <button class="blog-cms-btn ghost blog-cms-icon-btn" type="button" title="Duplicate" data-blog-action="duplicate" data-id="${escapeHTML(post.id)}">Copy</button>
                <button class="blog-cms-btn ghost blog-cms-icon-btn" type="button" title="Archive" data-blog-action="archive" data-id="${escapeHTML(post.id)}">Arc</button>
                <button class="blog-cms-btn danger blog-cms-icon-btn" type="button" title="Delete" data-blog-action="delete" data-id="${escapeHTML(post.id)}">Del</button>
            </div>
        </td>
    </tr>`;
}

function currentPost() {
    return state.posts.find((post) => post.id === state.editingId) || blankPost();
}

function editorHTML() {
    const post = currentPost();
    const tags = new Set(post.tag_ids || []);
    const score = checklistStats(post);
    return `
        <div class="blog-cms-editor-grid">
            <div class="blog-cms-editor-main">
                <div class="blog-cms-card blog-cms-form">
                    <div class="blog-cms-editor-toolbar">
                        <div class="blog-cms-chip-list">
                            ${statusBadge(post.status || 'draft')}
                            <span class="blog-cms-chip">SEO ${score.passed}/${score.total}</span>
                            <span class="blog-cms-muted">${state.lastSaved ? `บันทึกล่าสุด ${state.lastSaved}` : 'Autosave ทุก 12 วินาที'}</span>
                        </div>
                        <div class="blog-cms-action-stack">
                            <button class="blog-cms-btn secondary" type="button" data-blog-action="preview-mode">${state.previewMode === 'desktop' ? 'Preview Mobile' : 'Preview Desktop'}</button>
                            <button class="blog-cms-btn secondary" type="button" data-blog-action="save-draft">Save Draft</button>
                            <button class="blog-cms-btn" type="button" data-blog-action="publish">Publish</button>
                            <button class="blog-cms-btn secondary" type="button" data-blog-action="schedule">Schedule</button>
                        </div>
                    </div>
                    <div class="blog-cms-field-grid">
                        <label>Title
                            <input id="blog-title" class="blog-cms-title-input" value="${escapeHTML(post.title)}" placeholder="ชื่อบทความ">
                        </label>
                        <label>Slug
                            <input id="blog-slug" value="${escapeHTML(post.slug)}" placeholder="url-slug">
                        </label>
                    </div>
                    <label>Excerpt
                        <textarea id="blog-excerpt" placeholder="สรุปสั้นสำหรับหน้ารวมบทความและ meta">${escapeHTML(post.excerpt)}</textarea>
                    </label>
                </div>
                <div class="blog-cms-card">
                    <div class="blog-cms-editor-toolbar">
                        <h3>Content</h3>
                        <span class="blog-cms-muted"><span id="blog-word-count">${post.word_count || 0}</span> words · <span id="blog-reading-time">${post.reading_time || 1}</span> นาทีอ่าน</span>
                    </div>
                    <div class="blog-cms-rich-toolbar">
                        ${[['h2','H2'],['h3','H3'],['h4','H4'],['p','Paragraph'],['ul','Bullet'],['ol','Number'],['quote','Quote'],['image','Image'],['gallery','Gallery'],['divider','Divider'],['cta','CTA'],['table','Table'],['faq','FAQ'],['youtube','YouTube'],['html','HTML'],['internal','Internal Link'],['related','Related Posts']].map(([cmd,label]) => `<button type="button" data-blog-insert="${cmd}">${label}</button>`).join('')}
                    </div>
                    <div id="blog-content-editor" class="blog-cms-editor" contenteditable="true" data-placeholder="เขียนบทความ วางจาก Google Docs หรือเพิ่ม block จาก toolbar ได้ที่นี่">${post.content || ''}</div>
                </div>
                <div class="blog-cms-card">
                    <div class="blog-cms-editor-toolbar">
                        <h3>Preview</h3>
                        <span class="blog-cms-muted">${state.previewMode === 'desktop' ? 'Desktop' : 'Mobile'}</span>
                    </div>
                    <article id="blog-preview" class="blog-cms-preview ${state.previewMode}"></article>
                </div>
            </div>
            <aside class="blog-cms-sidebar">
                ${sidebarHTML(post, tags)}
            </aside>
        </div>
    `;
}

function sidebarHTML(post, selectedTags) {
    return `
        <div class="blog-cms-card blog-cms-form">
            <h3>Publish Settings</h3>
            <label>Status
                <select id="blog-status"><option value="draft">Draft</option><option value="published" ${post.status === 'published' ? 'selected' : ''}>Published</option><option value="scheduled" ${post.status === 'scheduled' ? 'selected' : ''}>Scheduled</option><option value="archived" ${post.status === 'archived' ? 'selected' : ''}>Archived</option></select>
            </label>
            <label>Published At
                <input id="blog-published-at" type="datetime-local" value="${toLocalInput(post.published_at)}">
            </label>
            <label>Scheduled At
                <input id="blog-scheduled-at" type="datetime-local" value="${toLocalInput(post.scheduled_at)}">
            </label>
            <label>Author
                <input id="blog-author-name" value="${escapeHTML(post.author_name)}" placeholder="Author">
            </label>
            <label><span><input id="blog-robots-index" type="checkbox" ${post.robots_index !== false ? 'checked' : ''}> Allow Indexing</span></label>
            <label><span><input id="blog-featured" type="checkbox" ${post.is_featured ? 'checked' : ''}> Featured Post</span></label>
        </div>
        <div class="blog-cms-card blog-cms-form">
            <h3>Category & Tags</h3>
            <label>Category
                <select id="blog-category"><option value="">เลือกหมวดหมู่</option>${state.categories.map((item) => `<option value="${escapeHTML(item.id)}" ${post.category_id === item.id ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}</select>
            </label>
            <div class="blog-cms-chip-list">${state.tags.map((tag) => `<button type="button" class="blog-cms-chip ${selectedTags.has(tag.id) ? 'active' : ''}" data-blog-tag="${escapeHTML(tag.id)}">${escapeHTML(tag.name)}</button>`).join('')}</div>
            <div class="blog-cms-field-grid"><input id="blog-new-category" placeholder="เพิ่ม Category"><button class="blog-cms-btn secondary" type="button" data-blog-action="add-category">Add</button></div>
            <div class="blog-cms-field-grid"><input id="blog-new-tag" placeholder="เพิ่ม Tag"><button class="blog-cms-btn secondary" type="button" data-blog-action="add-tag">Add</button></div>
        </div>
        <div class="blog-cms-card blog-cms-form">
            <h3>Cover Image</h3>
            ${post.cover_image_url ? `<img src="${escapeHTML(post.cover_image_url)}" alt="" style="width:100%;border-radius:8px;aspect-ratio:16/9;object-fit:cover">` : ''}
            <label>Upload Image
                <input id="blog-cover-upload" type="file" accept="image/*">
            </label>
            <label>Image URL
                <input id="blog-cover-url" value="${escapeHTML(post.cover_image_url)}" placeholder="Cover Image URL">
            </label>
            <label>Alt Text
                <input id="blog-cover-alt" value="${escapeHTML(post.cover_image_alt)}" placeholder="Alt Text">
            </label>
            <label>Caption
                <input id="blog-cover-caption" value="${escapeHTML(post.cover_image_caption || '')}" placeholder="Caption">
            </label>
        </div>
        <div class="blog-cms-card blog-cms-form">
            <h3>SEO / AEO / GEO</h3>
            <label>Focus Keyword
                <input id="blog-focus-keyword" value="${escapeHTML(post.focus_keyword)}" placeholder="Focus Keyword">
            </label>
            <label>SEO Title
                <input id="blog-seo-title" value="${escapeHTML(post.seo_title)}" placeholder="SEO Title">
            </label>
            <label>Meta Description
                <textarea id="blog-seo-description" placeholder="Meta Description">${escapeHTML(post.seo_description)}</textarea>
            </label>
            <label>Canonical URL
                <input id="blog-canonical-url" value="${escapeHTML(post.canonical_url)}" placeholder="Canonical URL">
            </label>
            <label>OG Title
                <input id="blog-og-title" value="${escapeHTML(post.og_title || '')}" placeholder="OG Title">
            </label>
            <label>OG Description
                <textarea id="blog-og-description" placeholder="OG Description">${escapeHTML(post.og_description || '')}</textarea>
            </label>
            <label>OG Image
                <input id="blog-og-image" value="${escapeHTML(post.og_image_url || '')}" placeholder="OG Image">
            </label>
            <label>Twitter Title
                <input id="blog-twitter-title" value="${escapeHTML(post.twitter_title || '')}" placeholder="Twitter Title">
            </label>
            <label>Twitter Description
                <textarea id="blog-twitter-description" placeholder="Twitter Description">${escapeHTML(post.twitter_description || '')}</textarea>
            </label>
            <label>Twitter Image
                <input id="blog-twitter-image" value="${escapeHTML(post.twitter_image_url || '')}" placeholder="Twitter Image">
            </label>
            <label>Schema Type
                <select id="blog-schema-type">${['Article','BlogPosting','FAQPage','BreadcrumbList','LocalBusiness','Organization','Product'].map((type) => `<option ${post.schema_type === type ? 'selected' : ''}>${type}</option>`).join('')}</select>
            </label>
            <label>Brand Context
                <textarea id="blog-brand-context" placeholder="Brand Context">${escapeHTML(post.brand_context || '')}</textarea>
            </label>
            <label>Local GEO
                <textarea id="blog-business-context" placeholder="ข้อมูลธุรกิจ Local GEO">${escapeHTML(post.business_context || '')}</textarea>
            </label>
            <button class="blog-cms-btn secondary" type="button" data-blog-action="add-faq">+ FAQ Block</button>
        </div>
        <div class="blog-cms-card"><h3>SEO Checklist</h3><div class="blog-cms-check" id="blog-seo-checklist"></div></div>
    `;
}

function toLocalInput(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 16);
}

function fromLocalInput(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function readEditorPost(statusOverride = '') {
    const existing = currentPost();
    const content = $('#blog-content-editor')?.innerHTML || '';
    const words = countWords(content);
    const category = state.categories.find((item) => item.id === $('#blog-category')?.value);
    const selectedTags = $all('[data-blog-tag].active').map((item) => item.dataset.blogTag);
    const tagNames = selectedTags.map((id) => state.tags.find((tag) => tag.id === id)?.name || id);
    return {
        ...existing,
        title: text($('#blog-title')?.value),
        slug: slugify($('#blog-slug')?.value || $('#blog-title')?.value),
        excerpt: text($('#blog-excerpt')?.value),
        content,
        status: statusOverride || $('#blog-status')?.value || 'draft',
        author_id: existing.author_id || auth.currentUser?.uid || '',
        author_name: text($('#blog-author-name')?.value || auth.currentUser?.displayName || auth.currentUser?.email),
        category_id: category?.id || '',
        category_name: category?.name || '',
        tag_ids: selectedTags,
        tags: tagNames,
        cover_image_url: text($('#blog-cover-url')?.value),
        cover_image_alt: text($('#blog-cover-alt')?.value),
        cover_image_caption: text($('#blog-cover-caption')?.value),
        focus_keyword: text($('#blog-focus-keyword')?.value),
        seo_title: text($('#blog-seo-title')?.value),
        seo_description: text($('#blog-seo-description')?.value),
        canonical_url: text($('#blog-canonical-url')?.value),
        og_title: text($('#blog-og-title')?.value),
        og_description: text($('#blog-og-description')?.value),
        og_image_url: text($('#blog-og-image')?.value),
        twitter_title: text($('#blog-twitter-title')?.value),
        twitter_description: text($('#blog-twitter-description')?.value),
        twitter_image_url: text($('#blog-twitter-image')?.value),
        robots_index: $('#blog-robots-index')?.checked !== false,
        robots_follow: true,
        schema_type: $('#blog-schema-type')?.value || 'BlogPosting',
        brand_context: text($('#blog-brand-context')?.value),
        business_context: text($('#blog-business-context')?.value),
        is_featured: !!$('#blog-featured')?.checked,
        published_at: fromLocalInput($('#blog-published-at')?.value),
        scheduled_at: fromLocalInput($('#blog-scheduled-at')?.value),
        word_count: words,
        reading_time: readingTime(words)
    };
}

function seoChecklist(post) {
    const content = post.content || '';
    const stripped = htmlToText(content);
    return [
        ['มี Focus Keyword', post.focus_keyword ? 'ผ่าน' : 'ยังไม่ได้ทำ'],
        ['SEO Title ไม่ยาวเกินไป', post.seo_title ? (post.seo_title.length <= 60 ? 'ผ่าน' : 'ควรปรับปรุง') : 'ยังไม่ได้ทำ'],
        ['Meta Description ครบ', post.seo_description ? (post.seo_description.length <= 160 ? 'ผ่าน' : 'ควรปรับปรุง') : 'ยังไม่ได้ทำ'],
        ['URL Slug อ่านง่าย', post.slug && /^[\p{L}\p{N}-]+$/u.test(post.slug) ? 'ผ่าน' : 'ยังไม่ได้ทำ'],
        ['มี H2/H3', /<h[23]/i.test(content) ? 'ผ่าน' : 'ควรปรับปรุง'],
        ['รูปมี Alt Text', post.cover_image_alt || !/<img/i.test(content) ? 'ผ่าน' : 'ควรปรับปรุง'],
        ['มี Internal Link', /href=["']\//i.test(content) ? 'ผ่าน' : 'ควรปรับปรุง'],
        ['มี External Link', /href=["']https?:\/\//i.test(content) ? 'ผ่าน' : 'ควรปรับปรุง'],
        ['มี FAQ', (post.faqs || []).length || /FAQ|คำถาม/i.test(stripped) ? 'ผ่าน' : 'ควรปรับปรุง'],
        ['ความยาวเหมาะสม', countWords(content) >= 600 ? 'ผ่าน' : 'ควรปรับปรุง'],
        ['มี CTA', /ติดต่อ|จอง|สมัคร|ซื้อ|อ่านต่อ|ดูเมนู|cta/i.test(stripped) ? 'ผ่าน' : 'ควรปรับปรุง'],
        ['มี Schema', post.schema_type ? 'ผ่าน' : 'ยังไม่ได้ทำ']
    ].map(([label, state]) => ({ label, state }));
}

function updateEditorStats() {
    const post = readEditorPost();
    const words = countWords(post.content);
    const wordEl = $('#blog-word-count');
    const timeEl = $('#blog-reading-time');
    if (wordEl) wordEl.textContent = words;
    if (timeEl) timeEl.textContent = readingTime(words);
    const preview = $('#blog-preview');
    if (preview) {
        preview.innerHTML = `<h1>${escapeHTML(post.title || 'Untitled')}</h1>${post.excerpt ? `<p>${escapeHTML(post.excerpt)}</p>` : ''}${post.cover_image_url ? `<img src="${escapeHTML(post.cover_image_url)}" alt="${escapeHTML(post.cover_image_alt)}" style="max-width:100%;border-radius:10px">` : ''}<div>${post.content || ''}</div>`;
    }
    const checklist = $('#blog-seo-checklist');
    if (checklist) {
        checklist.innerHTML = seoChecklist(post).map((item) => `<div class="${checklistTone(item)}"><span>${escapeHTML(item.label)}</span><strong>${escapeHTML(item.state)}</strong></div>`).join('');
    }
}

function actionNameForStatus(status) {
    if (status === 'published') return 'Publish';
    if (status === 'scheduled') return 'Schedule';
    return 'Save Draft';
}

async function validatePost(post) {
    const isPublishFlow = post.status === 'published' || post.status === 'scheduled';
    const missing = [];
    if (!post.title) missing.push('Title');
    if (!post.slug) missing.push('Slug');
    if (isPublishFlow && !canPublish()) missing.push('user role เป็น admin หรือ editor');
    if (isPublishFlow && !post.category_id) missing.push('Category');
    if (isPublishFlow && !htmlToText(post.content)) missing.push('เนื้อหาใน editor');
    if (post.status === 'scheduled' && !post.scheduled_at) missing.push('วันและเวลา Schedule');
    if (missing.length) {
        throw new BlogValidationError(`${actionNameForStatus(post.status)} ไม่สำเร็จ ยังขาด: ${missing.join(', ')}`, missing);
    }
    const duplicate = state.posts.find((item) => item.slug === post.slug && item.id !== post.id);
    if (duplicate) throw new BlogValidationError(`${actionNameForStatus(post.status)} ไม่สำเร็จ: Slug ซ้ำ`, ['Slug ซ้ำ']);
}

async function savePost(statusOverride = '', options = {}) {
    const post = readEditorPost(statusOverride);
    await validatePost(post);
    const payload = {
        ...post,
        status: statusOverride || post.status,
        updated_at: nowIso(),
        updatedBy: auth.currentUser?.uid || ''
    };
    if (payload.status === 'published' && !payload.published_at) payload.published_at = nowIso();
    if (!state.editingId) {
        payload.created_at = nowIso();
        payload.createdAt = payload.created_at;
        payload.updatedAt = payload.updated_at;
        const created = await addDoc(collection(db, collections.posts), payload);
        state.editingId = created.id;
    } else {
        payload.updatedAt = payload.updated_at;
        await setDoc(doc(db, collections.posts, state.editingId), payload, { merge: true });
        await addDoc(collection(db, collections.revisions), { post_id: state.editingId, title: payload.title, content: payload.content, edited_by: auth.currentUser?.uid || '', created_at: nowIso() });
    }
    state.lastSaved = new Date().toLocaleTimeString('th-TH');
    await refreshData();
    render();
    if (!options.silent) setStatus('บันทึกบทความสำเร็จ');
}

async function uploadMediaFile(file, meta = {}) {
    if (!file) return null;
    if (!/^image\//i.test(file.type)) throw new Error('กรุณาเลือกไฟล์รูปภาพ');
    if (file.size > 5 * 1024 * 1024) throw new Error('รูปต้องไม่เกิน 5MB');
    const safeName = `${Date.now()}-${slugify(file.name) || 'image'}`;
    const storageRef = ref(storage, `blogs/${safeName}`);
    await uploadBytes(storageRef, file, { contentType: file.type });
    const url = await getDownloadURL(storageRef);
    const payload = {
        filename: file.name,
        url,
        storage_path: `blogs/${safeName}`,
        alt_text: meta.alt_text || '',
        caption: meta.caption || '',
        size: file.size,
        mime_type: file.type,
        uploaded_by: auth.currentUser?.uid || '',
        created_at: nowIso()
    };
    const created = await addDoc(collection(db, collections.media), payload);
    return { id: created.id, ...payload };
}

function categoriesHTML() {
    return `<div class="blog-cms-card blog-cms-form"><h3>Category Manager</h3><div class="blog-cms-toolbar"><input id="category-name" placeholder="ชื่อหมวดหมู่"><input id="category-description" placeholder="Description"><input id="category-seo-title" placeholder="SEO Title"><input id="category-seo-description" placeholder="SEO Description"><button class="blog-cms-btn" type="button" data-blog-action="save-category">บันทึก</button></div></div><div class="blog-cms-card blog-cms-table-wrap"><table class="blog-cms-table"><thead><tr><th>ชื่อ</th><th>Slug</th><th>Description</th><th>จำนวนบทความ</th></tr></thead><tbody>${state.categories.map((cat) => `<tr><td>${escapeHTML(cat.name)}</td><td>${escapeHTML(cat.slug)}</td><td>${escapeHTML(cat.description || '-')}</td><td>${state.posts.filter((post) => post.category_id === cat.id).length}</td></tr>`).join('') || '<tr><td colspan="4">ยังไม่มีหมวดหมู่</td></tr>'}</tbody></table></div>`;
}

function tagsHTML() {
    return `<div class="blog-cms-card blog-cms-form"><h3>Tag Manager</h3><div class="blog-cms-toolbar"><input id="tag-name" placeholder="ชื่อ Tag"><button class="blog-cms-btn" type="button" data-blog-action="save-tag">บันทึก Tag</button></div></div><div class="blog-cms-card"><div class="blog-cms-chip-list">${state.tags.map((tag) => `<span class="blog-cms-chip">${escapeHTML(tag.name)} (${state.posts.filter((post) => post.tag_ids.includes(tag.id)).length})</span>`).join('') || 'ยังไม่มี Tags'}</div></div>`;
}

function mediaHTML() {
    return `<div class="blog-cms-card blog-cms-form"><h3>Media Library</h3><div class="blog-cms-toolbar"><input id="media-search" placeholder="Search Image"><input id="media-alt" placeholder="Alt Text"><input id="media-caption" placeholder="Caption"><input id="media-upload" type="file" accept="image/*"><button class="blog-cms-btn" type="button" data-blog-action="upload-media">Upload Image</button></div></div><div class="blog-cms-media-grid">${state.media.map((asset) => `<div class="blog-cms-card blog-cms-media-card"><img src="${escapeHTML(asset.url)}" alt="${escapeHTML(asset.alt_text || asset.filename)}"><strong>${escapeHTML(asset.filename)}</strong><small>${Math.round((asset.size || 0) / 1024)} KB · ${escapeHTML(asset.mime_type || '')}</small><div class="blog-cms-chip-list"><button class="blog-cms-btn secondary" data-blog-action="copy-media" data-url="${escapeHTML(asset.url)}">Copy URL</button><button class="blog-cms-btn danger" data-blog-action="delete-media" data-id="${escapeHTML(asset.id)}">Delete</button></div></div>`).join('') || '<div class="blog-cms-card">ยังไม่มีรูปภาพ</div>'}</div>`;
}

function simplePageHTML(title, body) {
    return `<div class="blog-cms-card"><h3>${title}</h3>${body}</div>`;
}

function assistantHTML() {
    const prompts = ['Generate Blog Outline','Generate SEO Title','Generate Meta Description','Generate FAQ','Rewrite Paragraph','Expand Content','Shorten Content','Improve SEO','Generate CTA','Generate Social Caption','Generate Image Alt Text','Suggest Internal Links','Suggest Tags','Suggest Category'];
    return simplePageHTML('AI Blog Assistant', `<p class="blog-cms-muted">ปุ่มเหล่านี้เป็น Prompt Template พร้อมต่อ OpenAI API ภายหลัง</p><div class="blog-cms-chip-list">${prompts.map((prompt) => `<button class="blog-cms-btn secondary" data-blog-action="prompt" data-prompt="${escapeHTML(prompt)}">${escapeHTML(prompt)}</button>`).join('')}</div><textarea id="blog-ai-output" style="margin-top:12px;min-height:180px" placeholder="Prompt จะปรากฏที่นี่"></textarea>`);
}

function activeHTML() {
    if (state.tab === 'overview') return overviewHTML();
    if (state.tab === 'posts') return postListHTML();
    if (state.tab === 'editor') return editorHTML();
    if (state.tab === 'categories') return categoriesHTML();
    if (state.tab === 'tags') return tagsHTML();
    if (state.tab === 'media') return mediaHTML();
    if (state.tab === 'seo') return simplePageHTML('SEO Settings', '<p>รองรับ Meta Title, Meta Description, Canonical, OG/Twitter, JSON-LD Article/FAQ/Breadcrumb/LocalBusiness และ Sitemap-ready URL ในระดับบทความแล้ว</p>');
    if (state.tab === 'authors') return simplePageHTML('ผู้เขียนและ Role', `<p>ผู้ใช้ถูกเก็บใน <code>blog_users</code> และรองรับ role <strong>admin</strong>, <strong>editor</strong>, <strong>writer</strong>.</p><div class="blog-cms-table-wrap"><table class="blog-cms-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>${state.users.map((u) => `<tr><td>${escapeHTML(u.name || u.id)}</td><td>${escapeHTML(u.email || '-')}</td><td>${escapeHTML(u.role || 'writer')}</td></tr>`).join('')}</tbody></table></div>`);
    if (state.tab === 'settings') return simplePageHTML('ตั้งค่าระบบ Blog', '<p>โครงสร้างพร้อมต่อระบบ E-commerce, Landing Page, default social image, sitemap และ scheduled publish worker ในอนาคต</p>');
    if (state.tab === 'assistant') return assistantHTML();
    return overviewHTML();
}

function render() {
    installStyles();
    const el = root();
    if (!el) return;
    el.innerHTML = layoutHTML(activeHTML());
    bindEvents();
    if (state.tab === 'editor') {
        updateEditorStats();
        bindEditorAutosave();
    }
}

function bindEvents() {
    const el = root();
    if (!el) return;
    $all('[data-blog-cms-tab]', el).forEach((button) => button.addEventListener('click', () => {
        state.tab = button.dataset.blogCmsTab;
        if (state.tab === 'editor' && !state.editingId) state.editingId = '';
        render();
    }));
    $('#blog-cms-search')?.addEventListener('input', (event) => { state.search = event.target.value; render(); });
    $('#blog-cms-filter-status')?.addEventListener('change', (event) => { state.filterStatus = event.target.value; render(); });
    $('#blog-cms-filter-category')?.addEventListener('change', (event) => { state.filterCategory = event.target.value; render(); });
    $('#blog-cms-filter-author')?.addEventListener('change', (event) => { state.filterAuthor = event.target.value; render(); });
    $('#blog-cms-sort')?.addEventListener('change', (event) => { state.sortBy = event.target.value; render(); });
    el.addEventListener('click', handleAction);
    $all('#blog-title,#blog-slug,#blog-excerpt,#blog-content-editor,#blog-status,#blog-published-at,#blog-scheduled-at,#blog-author-name,#blog-category,#blog-cover-url,#blog-cover-alt,#blog-cover-caption,#blog-focus-keyword,#blog-seo-title,#blog-seo-description,#blog-canonical-url,#blog-og-title,#blog-og-description,#blog-og-image,#blog-twitter-title,#blog-twitter-description,#blog-twitter-image,#blog-schema-type,#blog-brand-context,#blog-business-context', el).forEach((input) => {
        input.addEventListener('input', () => {
            if (input.id === 'blog-title' && !$('#blog-slug')?.value) $('#blog-slug').value = slugify(input.value);
            updateEditorStats();
        });
        input.addEventListener('change', updateEditorStats);
    });
    $('#blog-cover-upload')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        await runAction(event.target, 'upload-cover', async () => {
            const asset = await uploadMediaFile(file, { alt_text: $('#blog-cover-alt')?.value || $('#blog-title')?.value });
            $('#blog-cover-url').value = asset.url;
            updateEditorStats();
        });
    });
}

function insertBlock(command) {
    const editor = $('#blog-content-editor');
    if (!editor) return;
    const blocks = {
        h2: '<h2>หัวข้อ H2</h2>',
        h3: '<h3>หัวข้อ H3</h3>',
        h4: '<h4>หัวข้อ H4</h4>',
        p: '<p>ย่อหน้าใหม่...</p>',
        ul: '<ul><li>Bullet answer</li><li>ประเด็นสำคัญ</li></ul>',
        ol: '<ol><li>ขั้นตอนที่ 1</li><li>ขั้นตอนที่ 2</li></ol>',
        quote: '<blockquote>Quote หรือข้อมูลสำคัญ</blockquote>',
        image: '<figure><img src="/Hero/Hero.webp" alt="อธิบายรูปภาพ"><figcaption>Caption รูปภาพ</figcaption></figure>',
        gallery: '<div class="blog-gallery"><figure><img src="/Hero/Hero.webp" alt="Gallery image"><figcaption>Gallery caption</figcaption></figure></div>',
        divider: '<hr>',
        cta: '<p><a class="btn" href="/booking">จองบริการกับ Eden Cafe</a></p>',
        table: '<table><thead><tr><th>หัวข้อ</th><th>รายละเอียด</th></tr></thead><tbody><tr><td>ข้อมูล</td><td>คำอธิบาย</td></tr></tbody></table>',
        faq: '<h2>FAQ</h2><h3>คำถามที่พบบ่อย?</h3><p>คำตอบแบบสั้น ชัดเจน เหมาะกับ AEO/GEO</p>',
        youtube: '<iframe src="https://www.youtube.com/embed/" title="YouTube video" loading="lazy"></iframe>',
        html: '<div class="custom-html">HTML Block</div>',
        internal: '<p><a href="/blog">อ่านบทความอื่นใน Eden Cafe Blog</a></p>',
        related: '<section data-related-posts="manual"><h2>Related Posts</h2><p>เลือกลิงก์บทความที่เกี่ยวข้อง</p></section>'
    };
    editor.focus();
    document.execCommand('insertHTML', false, blocks[command] || '');
    updateEditorStats();
}

async function handleAction(event) {
    const actionEl = event.target.closest('[data-blog-action],[data-blog-insert],[data-blog-tag]');
    if (!actionEl) return;
    const action = actionEl.dataset.blogAction;
    if (actionEl.dataset.blogInsert) return insertBlock(actionEl.dataset.blogInsert);
    if (actionEl.dataset.blogTag) {
        actionEl.classList.toggle('active');
        updateEditorStats();
        return;
    }
    if (action === 'new') { state.editingId = ''; state.tab = 'editor'; render(); return; }
    if (action === 'edit') { state.editingId = actionEl.dataset.id; state.tab = 'editor'; render(); return; }
    if (action === 'preview-mode') { state.previewMode = state.previewMode === 'desktop' ? 'mobile' : 'desktop'; render(); return; }
    if (action === 'add-faq') return addFaqToEditor();
    if (action === 'prompt') return promptTemplate(actionEl.dataset.prompt);

    return runAction(actionEl, action, async () => {
        if (action === 'save-draft') return savePost('draft', { silent: true });
        if (action === 'publish') return savePost('published', { silent: true });
        if (action === 'schedule') return savePost('scheduled', { silent: true });
        if (action === 'duplicate') return duplicatePost(actionEl.dataset.id);
        if (action === 'archive') return archivePost(actionEl.dataset.id);
        if (action === 'delete') return deletePostById(actionEl.dataset.id);
        if (action === 'add-category') return addCategoryFromEditor();
        if (action === 'add-tag') return addTagFromEditor();
        if (action === 'save-category') return saveCategoryManager();
        if (action === 'save-tag') return saveTagManager();
        if (action === 'upload-media') return uploadMediaManager();
        if (action === 'copy-media') return navigator.clipboard.writeText(actionEl.dataset.url);
        if (action === 'delete-media') return deleteMedia(actionEl.dataset.id);
        if (action === 'seed') return seedBlogCms();
        return null;
    });
}

function bindEditorAutosave() {
    if (state.autosaveTimer) clearInterval(state.autosaveTimer);
    state.autosaveTimer = setInterval(async () => {
        if (state.tab !== 'editor') return;
        const post = readEditorPost('draft');
        if (!post.title || !htmlToText(post.content)) return;
        try {
            await savePost('draft', { silent: true });
        } catch (error) {
        }
    }, 12000);
}

async function duplicatePost(id) {
    const source = state.posts.find((post) => post.id === id);
    if (!source) return;
    const copy = { ...source, title: `${source.title} Copy`, slug: `${source.slug}-copy-${Date.now()}`, status: 'draft', published_at: '', scheduled_at: '', created_at: nowIso(), updated_at: nowIso() };
    delete copy.id;
    await addDoc(collection(db, collections.posts), copy);
    await refreshData();
    render();
}

async function archivePost(id) {
    await setDoc(doc(db, collections.posts, id), { status: 'archived', updated_at: nowIso(), updatedAt: nowIso() }, { merge: true });
    await refreshData();
    render();
}

async function deletePostById(id) {
    if (!confirm('ลบบทความนี้?')) return false;
    await deleteDoc(doc(db, collections.posts, id));
    await refreshData();
    render();
    return true;
}

async function addCategoryFromEditor() {
    const name = text($('#blog-new-category')?.value);
    if (!name) throw new BlogValidationError('เพิ่ม Category ไม่สำเร็จ ยังขาด: ชื่อ Category', ['ชื่อ Category']);
    const id = slugify(name);
    await setDoc(doc(db, collections.categories, id), { name, slug: id, is_active: true, created_at: nowIso(), updated_at: nowIso() }, { merge: true });
    await refreshData();
    render();
    return true;
}

async function addTagFromEditor() {
    const name = text($('#blog-new-tag')?.value);
    if (!name) throw new BlogValidationError('เพิ่ม Tag ไม่สำเร็จ ยังขาด: ชื่อ Tag', ['ชื่อ Tag']);
    const id = slugify(name);
    await setDoc(doc(db, collections.tags, id), { name, slug: id, created_at: nowIso(), updated_at: nowIso() }, { merge: true });
    await refreshData();
    render();
    return true;
}

async function saveCategoryManager() {
    const name = text($('#category-name')?.value);
    if (!name) throw new Error('กรุณาใส่ชื่อหมวดหมู่');
    const id = slugify(name);
    await setDoc(doc(db, collections.categories, id), { name, slug: id, description: text($('#category-description')?.value), seo_title: text($('#category-seo-title')?.value), seo_description: text($('#category-seo-description')?.value), is_active: true, created_at: nowIso(), updated_at: nowIso() }, { merge: true });
    await refreshData();
    render();
}

async function saveTagManager() {
    const name = text($('#tag-name')?.value);
    if (!name) throw new Error('กรุณาใส่ชื่อ Tag');
    const id = slugify(name);
    await setDoc(doc(db, collections.tags, id), { name, slug: id, created_at: nowIso(), updated_at: nowIso() }, { merge: true });
    await refreshData();
    render();
}

async function uploadMediaManager() {
    const file = $('#media-upload')?.files?.[0];
    if (!file) throw new BlogValidationError('อัปโหลดรูปภาพไม่สำเร็จ ยังขาด: ไฟล์รูปภาพ', ['ไฟล์รูปภาพ']);
    const asset = await uploadMediaFile(file, { alt_text: $('#media-alt')?.value, caption: $('#media-caption')?.value });
    if (asset) {
        await refreshData();
        render();
    }
    return true;
}

async function deleteMedia(id) {
    const asset = state.media.find((item) => item.id === id);
    if (!asset || !confirm('ลบรูปนี้?')) return false;
    await deleteDoc(doc(db, collections.media, id));
    if (asset.storage_path) await deleteObject(ref(storage, asset.storage_path)).catch(() => null);
    await refreshData();
    render();
    return true;
}

function addFaqToEditor() {
    const question = prompt('คำถาม FAQ');
    const answer = question ? prompt('คำตอบ') : '';
    if (!question || !answer) return;
    const editor = $('#blog-content-editor');
    if (editor) editor.innerHTML += `<h2>FAQ</h2><h3>${escapeHTML(question)}</h3><p>${escapeHTML(answer)}</p>`;
    updateEditorStats();
}

function promptTemplate(name) {
    const output = $('#blog-ai-output');
    if (!output) return;
    output.value = `Prompt Template: ${name}\n\nใช้บริบท Eden Cafe, ภาษาไทยอ่านง่าย, โครงสร้าง SEO/AEO/GEO, ใส่คำตอบสั้นสำหรับ AI search, FAQ, CTA และ internal links.`;
}

async function seedBlogCms() {
    const categories = [['seo', 'SEO'], ['marketing', 'Marketing'], ['knowledge', 'Knowledge'], ['news', 'News'], ['tutorial', 'Tutorial']];
    const tags = ['SEO', 'Blog', 'Content Marketing', 'AEO', 'GEO', 'Website'];
    const posts = [
        ['วิธีเขียนบทความ SEO ให้ติด Google', 'seo-writing-google', 'seo'],
        ['Blog สำคัญกับธุรกิจออนไลน์อย่างไร', 'why-blog-matters-online-business', 'marketing'],
        ['วิธีเลือก Keyword สำหรับบทความ', 'keyword-research-for-articles', 'seo'],
        ['การเขียน FAQ ให้เหมาะกับ AEO และ GEO', 'faq-writing-aeo-geo', 'knowledge'],
        ['เทคนิคทำ Internal Link ให้เว็บไซต์แข็งแรงขึ้น', 'internal-link-techniques', 'tutorial']
    ];
    await Promise.all(categories.map(([id, name]) => setDoc(doc(db, collections.categories, id), { name, slug: id, description: `หมวด ${name}`, seo_title: `${name} Blog`, seo_description: `รวมบทความหมวด ${name}`, is_active: true, updated_at: nowIso(), created_at: nowIso() }, { merge: true })));
    await Promise.all(tags.map((name) => setDoc(doc(db, collections.tags, slugify(name)), { name, slug: slugify(name), updated_at: nowIso(), created_at: nowIso() }, { merge: true })));
    await Promise.all(posts.map(([title, slug, category], index) => setDoc(doc(db, collections.posts, slug), {
        title, slug, excerpt: `ตัวอย่างบทความสำหรับ Blog CMS: ${title}`,
        content: `<h2>สรุปคำตอบ</h2><p>${title} ควรเริ่มจากความต้องการของผู้อ่าน คำค้นหา และโครงสร้างบทความที่ตอบคำถามได้ชัดเจน</p><h2>แนวทางใช้งานจริง</h2><p>จัดหัวข้อย่อย ใส่ตัวอย่างที่เกี่ยวกับธุรกิจ เพิ่ม internal link ไปยัง <a href="/blog">บทความอื่น</a> และปิดท้ายด้วย CTA เช่น <a href="/booking">จองบริการ</a></p><h2>FAQ</h2><h3>ควรเริ่มอย่างไร?</h3><p>เริ่มจากคำถามหลักของผู้อ่าน แล้ววาง H2/H3 ให้ตอบเป็นลำดับ</p>`,
        cover_image_url: '/Hero/Hero.webp', cover_image_alt: title, status: index < 3 ? 'published' : 'draft',
        author_id: auth.currentUser?.uid || '', author_name: auth.currentUser?.displayName || auth.currentUser?.email || 'Eden Writer',
        category_id: category, category_name: categories.find(([id]) => id === category)?.[1] || '',
        tag_ids: ['seo', 'blog'], tags: ['SEO', 'Blog'], seo_title: title, seo_description: `อ่าน${title} พร้อมแนวทาง SEO, AEO และ GEO`,
        focus_keyword: title.split(' ')[0], robots_index: true, robots_follow: true, schema_type: 'BlogPosting',
        faqs: [{ question: `ควรเริ่ม ${title} อย่างไร`, answer: 'เริ่มจากคำถามหลักของผู้อ่าน แล้ววาง H2/H3 ให้ตอบได้เป็นลำดับ' }],
        is_featured: index === 0, published_at: index < 3 ? nowIso() : '', created_at: nowIso(), updated_at: nowIso(), createdAt: nowIso(), updatedAt: nowIso()
    }, { merge: true })));
    await refreshData();
    render();
}

window.fetchBlogsFromCloud = async () => {
    await waitForAuthReady();
    await refreshData();
    render();
};
window.openBlogModal = () => {
    state.editingId = '';
    state.tab = 'editor';
    render();
};
window.closeBlogModal = () => {};
window.editBlog = (id) => {
    state.editingId = id || '';
    state.tab = 'editor';
    render();
};
window.deleteBlog = deletePostById;
window.seedSeoBlogPosts = seedBlogCms;

window.addEventListener('eden-blog-cms-open-editor', () => window.openBlogModal());
window.addEventListener('eden-blog-cms-edit-post', (event) => window.editBlog(event.detail?.id || ''));
window.addEventListener('eden-blog-cms-delete-post', (event) => window.deleteBlog(event.detail?.id || ''));
window.addEventListener('eden-blog-cms-seed', () => window.seedSeoBlogPosts());

document.addEventListener('DOMContentLoaded', async () => {
    const el = root();
    if (!el) return;
    installStyles();
    el.innerHTML = '<div class="blog-cms-admin-loading">กำลังโหลด Blog CMS ใหม่...</div>';
    try {
        await waitForAuthReady();
        await refreshData();
        render();
    } catch (error) {
        el.innerHTML = `<div class="blog-cms-alert">โหลด Blog CMS ไม่สำเร็จ: ${escapeHTML(error.message || error)}</div>`;
        console.error('Blog CMS admin failed:', error);
    }
});
