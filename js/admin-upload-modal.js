const STYLE_ID = 'eden-admin-upload-modal-style';
const MODAL_ID = 'eden-admin-upload-modal';
const IMAGE_DEFAULT_MAX_SIZE = 8 * 1024 * 1024;
const SPREADSHEET_DEFAULT_MAX_SIZE = 12 * 1024 * 1024;

let modalElements = null;
let closeTimer = null;

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatBytes(bytes = 0) {
    const size = Number(bytes) || 0;
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
    if (size >= 1024) return `${Math.round(size / 1024)} KB`;
    return `${size} B`;
}

function fileLabel(file) {
    if (!file) return 'No file selected';
    return `${file.name || 'upload-file'} - ${formatBytes(file.size)}`;
}

function withCacheBust(url) {
    try {
        const parsed = new URL(url, window.location.href);
        parsed.searchParams.set('_uploadCheck', String(Date.now()));
        return parsed.href;
    } catch (_) {
        return url;
    }
}

function verifyImageURL(url, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        if (!url || typeof url !== 'string') {
            reject(new Error('Upload finished without a public image URL'));
            return;
        }
        const img = new Image();
        const timeout = window.setTimeout(() => {
            img.onload = null;
            img.onerror = null;
            reject(new Error('Uploaded image URL did not respond in time'));
        }, timeoutMs);
        img.onload = () => {
            window.clearTimeout(timeout);
            resolve(url);
        };
        img.onerror = () => {
            window.clearTimeout(timeout);
            reject(new Error('Uploaded image URL cannot be opened publicly'));
        };
        img.referrerPolicy = 'no-referrer';
        img.src = withCacheBust(url);
    });
}

function ensureModalStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .eden-upload-backdrop {
            position: fixed;
            inset: 0;
            z-index: 10000;
            display: grid;
            place-items: center;
            padding: 20px;
            color: #f5f8f8;
            background:
                linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px),
                rgba(4, 7, 10, 0.72);
            background-size: 56px 56px, 56px 56px, auto;
            backdrop-filter: blur(12px);
        }
        .eden-upload-backdrop[hidden] { display: none; }
        .eden-upload-dialog {
            width: min(940px, 100%);
            max-height: min(900px, calc(100vh - 32px));
            display: grid;
            grid-template-rows: auto minmax(0, 1fr) auto;
            border: 1px solid rgba(37, 208, 185, 0.26);
            border-radius: 8px;
            overflow: hidden;
            background:
                radial-gradient(circle at 50% 18%, rgba(37, 208, 185, 0.15), transparent 22rem),
                linear-gradient(180deg, rgba(16, 23, 30, 0.98), rgba(9, 13, 18, 0.98));
            box-shadow: 0 24px 90px rgba(0, 0, 0, 0.52), 0 0 60px rgba(37, 208, 185, 0.12);
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .eden-upload-head,
        .eden-upload-foot {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            padding: 18px 22px;
            border-bottom: 1px solid rgba(156, 177, 188, 0.18);
        }
        .eden-upload-foot {
            border-top: 1px solid rgba(156, 177, 188, 0.18);
            border-bottom: 0;
            background: rgba(8, 12, 16, 0.92);
        }
        .eden-upload-title {
            display: flex;
            min-width: 0;
            align-items: center;
            gap: 14px;
        }
        .eden-upload-icon {
            width: 44px;
            height: 44px;
            display: grid;
            flex: 0 0 auto;
            place-items: center;
            border-radius: 8px;
            color: #05100e;
            background: linear-gradient(135deg, #25d0b9, #9ff8ef);
            box-shadow: 0 0 28px rgba(37, 208, 185, 0.2);
        }
        .eden-upload-title h2 {
            margin: 0;
            color: #f5f8f8;
            font-size: clamp(22px, 3vw, 34px);
            line-height: 1.08;
            letter-spacing: 0;
        }
        .eden-upload-title p,
        .eden-upload-note,
        .eden-upload-check span,
        .eden-upload-metric small {
            margin: 6px 0 0;
            color: #a3b1b8;
        }
        .eden-upload-actions {
            display: flex;
            gap: 8px;
        }
        .eden-upload-icon-btn,
        .eden-upload-text-btn,
        .eden-upload-primary-btn {
            min-height: 42px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            border-radius: 8px;
            font: inherit;
            font-weight: 850;
        }
        .eden-upload-icon-btn {
            width: 42px;
            border: 1px solid rgba(156, 177, 188, 0.18);
            color: #f5f8f8;
            background: rgba(9, 13, 17, 0.84);
            cursor: pointer;
        }
        .eden-upload-text-btn {
            border: 1px solid rgba(156, 177, 188, 0.18);
            color: #f5f8f8;
            background: rgba(12, 18, 24, 0.84);
            padding: 10px 14px;
            cursor: pointer;
        }
        .eden-upload-primary-btn {
            border: 1px solid rgba(37, 208, 185, 0.42);
            color: #06100f;
            background: linear-gradient(135deg, #25d0b9, #9cf8ee);
            padding: 10px 14px;
        }
        .eden-upload-primary-btn:disabled {
            color: #8c9ba3;
            border-color: rgba(156, 177, 188, 0.18);
            background: rgba(12, 18, 24, 0.84);
            opacity: 1;
            cursor: not-allowed;
        }
        .eden-upload-body {
            overflow: auto;
            padding: 22px;
        }
        .eden-upload-steps {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 10px;
            margin-bottom: 18px;
        }
        .eden-upload-step {
            min-height: 48px;
            display: flex;
            align-items: center;
            gap: 10px;
            border: 1px solid rgba(37, 208, 185, 0.25);
            border-radius: 8px;
            padding: 10px 13px;
            color: #eaf7f6;
            background: rgba(10, 15, 20, 0.74);
            font-weight: 850;
        }
        .eden-upload-step-num {
            width: 26px;
            height: 26px;
            display: grid;
            place-items: center;
            flex: 0 0 auto;
            border: 2px solid rgba(37, 208, 185, 0.52);
            border-radius: 50%;
            color: #73ebdc;
            font-size: 13px;
        }
        .eden-upload-grid {
            display: grid;
            grid-template-columns: minmax(0, 1.2fr) minmax(300px, 0.8fr);
            gap: 16px;
            align-items: stretch;
        }
        .eden-upload-drop {
            min-height: 320px;
            display: grid;
            place-items: center;
            border: 2px dashed rgba(37, 208, 185, 0.66);
            border-radius: 8px;
            padding: clamp(24px, 4vw, 46px);
            text-align: center;
            background:
                radial-gradient(circle at 50% 48%, rgba(37, 208, 185, 0.18), transparent 15rem),
                rgba(8, 15, 18, 0.84);
            box-shadow: inset 0 0 34px rgba(37, 208, 185, 0.06);
        }
        .eden-upload-symbol {
            width: 68px;
            height: 68px;
            display: grid;
            place-items: center;
            margin: 0 auto 18px;
            border: 1px solid rgba(37, 208, 185, 0.36);
            border-radius: 8px;
            color: #73ebdc;
            background: rgba(10, 18, 22, 0.92);
            box-shadow: 0 0 28px rgba(37, 208, 185, 0.18);
        }
        .eden-upload-drop h3 {
            margin: 0;
            color: #f5f8f8;
            font-size: clamp(26px, 4vw, 40px);
            line-height: 1.05;
            letter-spacing: 0;
        }
        .eden-upload-drop p {
            max-width: 430px;
            margin: 12px auto 0;
            color: #a3b1b8;
        }
        .eden-upload-file {
            max-width: min(100%, 440px);
            display: inline-flex;
            align-items: center;
            gap: 10px;
            margin-top: 20px;
            border: 1px solid rgba(37, 208, 185, 0.28);
            border-radius: 8px;
            padding: 12px 14px;
            color: #e9f6f4;
            background: rgba(13, 19, 25, 0.9);
            box-shadow: 0 10px 32px rgba(0, 0, 0, 0.24);
        }
        .eden-upload-file span,
        .eden-upload-url span {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .eden-upload-panel {
            display: grid;
            gap: 13px;
            border: 1px solid rgba(156, 177, 188, 0.18);
            border-radius: 8px;
            padding: 15px;
            background: rgba(10, 15, 20, 0.82);
        }
        .eden-upload-progress-title {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            color: #f5f8f8;
            font-weight: 850;
        }
        .eden-upload-progress-title span:last-child {
            color: #73ebdc;
        }
        .eden-upload-bar {
            height: 10px;
            overflow: hidden;
            border-radius: 999px;
            background: rgba(154, 176, 189, 0.12);
        }
        .eden-upload-fill {
            width: 0%;
            height: 100%;
            border-radius: inherit;
            background: linear-gradient(90deg, #25d0b9, #9cf8ee);
            box-shadow: 0 0 22px rgba(37, 208, 185, 0.34);
            transition: width 0.24s ease;
        }
        .eden-upload-metrics {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 9px;
        }
        .eden-upload-metric {
            min-height: 78px;
            display: grid;
            align-content: center;
            gap: 8px;
            border: 1px solid rgba(156, 177, 188, 0.18);
            border-radius: 8px;
            padding: 11px;
            background: rgba(16, 23, 30, 0.82);
        }
        .eden-upload-metric strong {
            color: #f5f8f8;
            font-size: clamp(20px, 2vw, 27px);
            line-height: 1;
        }
        .eden-upload-checks {
            display: grid;
            gap: 10px;
        }
        .eden-upload-check {
            display: grid;
            grid-template-columns: 26px minmax(0, 1fr) auto;
            gap: 10px;
            align-items: center;
            border: 1px solid rgba(156, 177, 188, 0.18);
            border-radius: 8px;
            padding: 10px;
            background: rgba(12, 18, 24, 0.76);
        }
        .eden-upload-check-dot {
            width: 26px;
            height: 26px;
            display: grid;
            place-items: center;
            border-radius: 50%;
            color: #07100f;
            background: #64727b;
        }
        .eden-upload-check[data-state="done"] .eden-upload-check-dot {
            background: #68d391;
        }
        .eden-upload-check[data-state="active"] .eden-upload-check-dot {
            color: #ffc857;
            border: 1px solid rgba(255, 200, 87, 0.38);
            background: rgba(255, 200, 87, 0.12);
        }
        .eden-upload-check[data-state="error"] .eden-upload-check-dot {
            color: #fff;
            background: #ff6b68;
        }
        .eden-upload-check strong {
            display: block;
            margin-bottom: 2px;
            color: #f5f8f8;
            font-size: 13px;
        }
        .eden-upload-check small {
            color: #6e7c84;
            white-space: nowrap;
        }
        .eden-upload-result {
            display: grid;
            gap: 10px;
            border: 1px solid rgba(37, 208, 185, 0.22);
            border-radius: 8px;
            padding: 13px;
            background: rgba(37, 208, 185, 0.07);
        }
        .eden-upload-result strong {
            color: #f5f8f8;
        }
        .eden-upload-url-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 8px;
            align-items: center;
        }
        .eden-upload-url {
            min-height: 42px;
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            border: 1px solid rgba(37, 208, 185, 0.22);
            border-radius: 8px;
            padding: 9px 11px;
            color: #dff7f3;
            background: rgba(4, 10, 12, 0.78);
        }
        .eden-upload-error {
            display: none;
            border: 1px solid rgba(255, 107, 104, 0.36);
            border-radius: 8px;
            padding: 10px 12px;
            color: #ffd2d1;
            background: rgba(255, 107, 104, 0.1);
        }
        .eden-upload-error.is-visible { display: block; }
        .eden-upload-svg {
            width: 18px;
            height: 18px;
            flex: 0 0 auto;
        }
        .eden-file-control {
            position: relative;
            width: 100%;
            min-width: 0;
            display: grid;
            gap: 7px;
            color: #20342d;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .eden-file-native {
            position: absolute;
            width: 1px;
            height: 1px;
            opacity: 0;
            overflow: hidden;
            pointer-events: none;
        }
        .eden-file-trigger {
            min-height: 44px;
            width: 100%;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 9px;
            border: 1px solid rgba(37, 208, 185, 0.36);
            border-radius: 8px;
            padding: 10px 12px;
            color: #eaf7f6;
            background:
                radial-gradient(circle at 50% 20%, rgba(37, 208, 185, 0.16), transparent 12rem),
                linear-gradient(180deg, rgba(15, 24, 30, 0.98), rgba(8, 13, 18, 0.98));
            box-shadow: 0 10px 26px rgba(4, 11, 13, 0.16), inset 0 0 0 1px rgba(255,255,255,0.03);
            font: inherit;
            font-weight: 850;
            line-height: 1.15;
            letter-spacing: 0;
            cursor: pointer;
        }
        .eden-file-trigger:hover,
        .eden-file-control.is-dragging .eden-file-trigger {
            border-color: rgba(37, 208, 185, 0.72);
            box-shadow: 0 12px 30px rgba(4, 11, 13, 0.18), 0 0 24px rgba(37, 208, 185, 0.14);
        }
        .eden-file-control.is-selected .eden-file-trigger {
            border-color: rgba(104, 211, 145, 0.58);
        }
        .eden-file-meta {
            min-width: 0;
            display: block;
            color: #66776f;
            font-size: 0.79rem;
            font-weight: 750;
            line-height: 1.25;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        @media (max-width: 820px) {
            .eden-upload-backdrop { padding: 10px; }
            .eden-upload-dialog { max-height: calc(100vh - 20px); }
            .eden-upload-head,
            .eden-upload-foot {
                align-items: stretch;
                flex-direction: column;
                padding: 16px;
            }
            .eden-upload-body { padding: 16px; }
            .eden-upload-steps,
            .eden-upload-grid,
            .eden-upload-metrics {
                grid-template-columns: 1fr;
            }
            .eden-upload-drop { min-height: 260px; }
        }
    `;
    document.head.appendChild(style);
}

function uploadIcon(path) {
    return `<svg class="eden-upload-svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">${path}</svg>`;
}

function filePickerLabel(input) {
    const accept = String(input.getAttribute('accept') || '').toLowerCase();
    const id = String(input.id || '').toLowerCase();
    if (accept.includes('.xls') || id.includes('xlsx')) return 'Select XLSX file';
    if (accept.includes('image') || id.includes('image') || id.includes('hero') || id.includes('cover')) return 'Select image';
    return 'Select file';
}

function syncFileControl(input) {
    const control = input.closest('.eden-file-control');
    if (!control) return;
    const meta = control.querySelector('[data-eden-file-meta]');
    const file = input.files?.[0] || null;
    control.classList.toggle('is-selected', Boolean(file));
    if (meta) meta.textContent = fileLabel(file);
}

function shouldSkipFileInput(input) {
    if (!input || input.dataset.edenFileEnhanced === 'true') return true;
    if (input.hidden) return true;
    if (String(input.style.display || '').toLowerCase() === 'none') return true;
    return false;
}

export function enhanceAdminFileInputs(root = document) {
    ensureModalStyle();
    const scope = root instanceof Element || root instanceof Document ? root : document;
    scope.querySelectorAll('input[type="file"]').forEach(input => {
        if (input.dataset.edenFileEnhanced === 'true') {
            syncFileControl(input);
            return;
        }
        if (shouldSkipFileInput(input)) return;

        const control = document.createElement('div');
        control.className = 'eden-file-control';
        const label = input.id ? input.closest('label') : null;
        if (label && label.contains(input)) {
            label.htmlFor = input.id;
            label.insertAdjacentElement('afterend', control);
        } else {
            input.insertAdjacentElement('beforebegin', control);
        }

        input.dataset.edenFileEnhanced = 'true';
        input.classList.add('eden-file-native');
        control.appendChild(input);
        control.insertAdjacentHTML('beforeend', `
            <button class="eden-file-trigger" type="button" data-eden-file-trigger>
                ${uploadIcon('<path d="M12 19V5m0 0-5 5m5-5 5 5" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="2.35" stroke-linecap="round"/>')}
                <span>${escapeHTML(filePickerLabel(input))}</span>
            </button>
            <span class="eden-file-meta" data-eden-file-meta>No file selected</span>
        `);

        control.querySelector('[data-eden-file-trigger]')?.addEventListener('click', () => input.click());
        input.addEventListener('change', () => syncFileControl(input));
        ['dragenter', 'dragover'].forEach(type => {
            control.addEventListener(type, event => {
                event.preventDefault();
                control.classList.add('is-dragging');
            });
        });
        ['dragleave', 'dragend', 'drop'].forEach(type => {
            control.addEventListener(type, () => control.classList.remove('is-dragging'));
        });
        control.addEventListener('drop', event => {
            event.preventDefault();
            if (!event.dataTransfer?.files?.length) return;
            input.files = event.dataTransfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        syncFileControl(input);
    });
}

function ensureModal() {
    if (modalElements) return modalElements;
    ensureModalStyle();

    const root = document.createElement('div');
    root.id = MODAL_ID;
    root.className = 'eden-upload-backdrop';
    root.hidden = true;
    root.innerHTML = `
        <section class="eden-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="eden-upload-title">
            <header class="eden-upload-head">
                <div class="eden-upload-title">
                    <div class="eden-upload-icon">${uploadIcon('<path d="M12 19V5m0 0-5 5m5-5 5 5" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>')}</div>
                    <div>
                        <h2 id="eden-upload-title">Upload file</h2>
                        <p data-upload-subtitle>Preparing upload</p>
                    </div>
                </div>
                <div class="eden-upload-actions">
                    <button class="eden-upload-icon-btn" type="button" data-upload-copy title="Copy result URL">${uploadIcon('<path d="M8 8h10v10H8V8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6 16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>')}</button>
                    <button class="eden-upload-icon-btn" type="button" data-upload-close title="Close">${uploadIcon('<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>')}</button>
                </div>
            </header>
            <div class="eden-upload-body">
                <div class="eden-upload-steps">
                    <div class="eden-upload-step"><span class="eden-upload-step-num">1</span> Border</div>
                    <div class="eden-upload-step"><span class="eden-upload-step-num">2</span> Glow</div>
                    <div class="eden-upload-step"><span class="eden-upload-step-num">3</span> Copy</div>
                </div>
                <div class="eden-upload-grid">
                    <div class="eden-upload-drop">
                        <div>
                            <div class="eden-upload-symbol">${uploadIcon('<path d="M12 19V5m0 0-5 5m5-5 5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>')}</div>
                            <h3 data-upload-drop-title>Release to upload</h3>
                            <p data-upload-drop-copy>Drop zone preview for the selected Admin upload.</p>
                            <div class="eden-upload-file">${uploadIcon('<path d="M6 4h8l4 4v12H6V4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 4v5h5" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>')}<span data-upload-file>file</span></div>
                        </div>
                    </div>
                    <aside class="eden-upload-panel">
                        <div class="eden-upload-progress-title">
                            <span data-upload-label>Preparing</span>
                            <span data-upload-percent>0%</span>
                        </div>
                        <div class="eden-upload-bar"><div class="eden-upload-fill" data-upload-fill></div></div>
                        <div class="eden-upload-metrics">
                            <div class="eden-upload-metric"><small>Percent</small><strong data-upload-metric-percent>0%</strong></div>
                            <div class="eden-upload-metric"><small>Time left</small><strong data-upload-time>--</strong></div>
                            <div class="eden-upload-metric"><small>State</small><strong data-upload-state>Idle</strong></div>
                        </div>
                        <div class="eden-upload-checks" data-upload-checks></div>
                        <div class="eden-upload-result">
                            <strong data-upload-result-title>Verified URL</strong>
                            <div class="eden-upload-url-row">
                                <div class="eden-upload-url">${uploadIcon('<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>')}<span data-upload-result>waiting for result</span></div>
                                <button class="eden-upload-icon-btn" type="button" data-upload-copy-inline title="Copy result URL">${uploadIcon('<path d="M8 8h10v10H8V8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6 16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>')}</button>
                            </div>
                        </div>
                        <div class="eden-upload-error" data-upload-error></div>
                    </aside>
                </div>
            </div>
            <footer class="eden-upload-foot">
                <div class="eden-upload-note" data-upload-note>Target field waits until this upload passes verification.</div>
                <button class="eden-upload-primary-btn" type="button" data-upload-done disabled>${uploadIcon('<path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')}Use verified result</button>
            </footer>
        </section>
    `;
    document.body.appendChild(root);

    modalElements = {
        root,
        title: root.querySelector('#eden-upload-title'),
        subtitle: root.querySelector('[data-upload-subtitle]'),
        dropTitle: root.querySelector('[data-upload-drop-title]'),
        dropCopy: root.querySelector('[data-upload-drop-copy]'),
        file: root.querySelector('[data-upload-file]'),
        label: root.querySelector('[data-upload-label]'),
        percent: root.querySelector('[data-upload-percent]'),
        metricPercent: root.querySelector('[data-upload-metric-percent]'),
        time: root.querySelector('[data-upload-time]'),
        state: root.querySelector('[data-upload-state]'),
        fill: root.querySelector('[data-upload-fill]'),
        checks: root.querySelector('[data-upload-checks]'),
        resultTitle: root.querySelector('[data-upload-result-title]'),
        result: root.querySelector('[data-upload-result]'),
        note: root.querySelector('[data-upload-note]'),
        error: root.querySelector('[data-upload-error]'),
        done: root.querySelector('[data-upload-done]'),
        copyButtons: root.querySelectorAll('[data-upload-copy], [data-upload-copy-inline]')
    };

    root.querySelector('[data-upload-close]').addEventListener('click', () => closeUploadModal());
    modalElements.done.addEventListener('click', () => closeUploadModal());
    modalElements.copyButtons.forEach(button => {
        button.addEventListener('click', async () => {
            const text = modalElements.result.textContent || '';
            if (!text || /waiting|failed/i.test(text)) return;
            await navigator.clipboard?.writeText(text).catch(() => null);
        });
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !root.hidden) closeUploadModal();
    });
    return modalElements;
}

function closeUploadModal() {
    if (closeTimer) window.clearTimeout(closeTimer);
    closeTimer = null;
    const ui = ensureModal();
    ui.root.hidden = true;
}

function setChecks(ui, checks) {
    ui.checks.innerHTML = checks.map(check => `
        <div class="eden-upload-check" data-state="${escapeHTML(check.state || 'pending')}" data-check-id="${escapeHTML(check.id)}">
            <span class="eden-upload-check-dot">${uploadIcon('<path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>')}</span>
            <div><strong>${escapeHTML(check.label)}</strong><span>${escapeHTML(check.detail || 'pending')}</span></div>
            <small>${escapeHTML(check.status || 'pending')}</small>
        </div>
    `).join('');
}

function updateCheck(ui, id, state, detail, status) {
    const row = Array.from(ui.checks.querySelectorAll('[data-check-id]'))
        .find(item => item.dataset.checkId === id);
    if (!row) return;
    row.dataset.state = state;
    if (detail !== undefined) row.querySelector('span:not(.eden-upload-check-dot)')?.replaceChildren(document.createTextNode(detail));
    if (status !== undefined) row.querySelector('small').textContent = status;
}

function setProgress(ui, label, percent, state = 'Wait', seconds = null) {
    const rounded = Math.max(0, Math.min(100, Math.round(percent)));
    ui.label.textContent = label;
    ui.percent.textContent = `${rounded}%`;
    ui.metricPercent.textContent = `${rounded}%`;
    ui.state.textContent = state;
    ui.time.textContent = seconds === null ? '--' : `0:${String(Math.max(0, Math.round(seconds))).padStart(2, '0')}`;
    ui.fill.style.width = `${rounded}%`;
}

function startTicker(ui, start, stop, label) {
    let value = start;
    let seconds = 48;
    setProgress(ui, label, value, 'Wait', seconds);
    const timer = window.setInterval(() => {
        value = Math.min(stop, value + Math.max(1, (stop - value) * 0.12));
        seconds = Math.max(3, seconds - 3);
        setProgress(ui, label, value, value >= stop - 3 ? 'Verify' : 'Wait', seconds);
    }, 520);
    return () => window.clearInterval(timer);
}

function openUploadModal(options, checks) {
    const ui = ensureModal();
    if (closeTimer) window.clearTimeout(closeTimer);
    closeTimer = null;
    ui.title.textContent = options.title || `Upload ${options.surface || 'file'}`;
    ui.subtitle.textContent = options.subtitle || options.folder || 'Admin upload';
    ui.dropTitle.textContent = options.dropTitle || 'Release to upload';
    ui.dropCopy.textContent = options.dropCopy || 'Keep this window open while the upload is being checked.';
    ui.file.textContent = fileLabel(options.file);
    ui.resultTitle.textContent = options.resultTitle || 'Verified URL';
    ui.result.textContent = options.pendingResultText || 'waiting for result';
    ui.note.textContent = options.targetField
        ? `Target field: ${options.targetField}. The form waits until this operation passes verification.`
        : 'The form waits until this operation passes verification.';
    ui.error.textContent = '';
    ui.error.classList.remove('is-visible');
    ui.done.innerHTML = `${uploadIcon('<path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" stroke-width="2"/>')}Waiting for verification`;
    ui.done.disabled = true;
    setChecks(ui, checks);
    setProgress(ui, 'Preparing', 0, 'Idle');
    ui.root.hidden = false;
    return ui;
}

function validateImage(file, maxSize) {
    if (!file) throw new Error('Please choose an image file before uploading');
    if (!/^image\//i.test(file.type || '')) throw new Error('Please choose an image file');
    if (file.size > maxSize) throw new Error(`Image is too large. Maximum size is ${formatBytes(maxSize)}`);
}

function validateSpreadsheet(file, maxSize) {
    if (!file) throw new Error('Please choose an XLSX file before uploading');
    const name = String(file.name || '').toLowerCase();
    if (!/\.(xlsx|xls)$/.test(name)) throw new Error('Please choose an .xlsx or .xls file');
    if (file.size > maxSize) throw new Error(`Spreadsheet is too large. Maximum size is ${formatBytes(maxSize)}`);
}

async function completeWithResult(ui, resultText, autoCloseMs) {
    ui.result.textContent = resultText || 'completed';
    ui.done.innerHTML = `${uploadIcon('<path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')}Use verified result`;
    ui.done.disabled = false;
    setProgress(ui, 'Complete', 100, 'Done', 0);
    if (autoCloseMs > 0) {
        closeTimer = window.setTimeout(() => closeUploadModal(), autoCloseMs);
    }
}

async function failWithError(ui, error) {
    ui.error.textContent = error?.message || 'Upload failed';
    ui.error.classList.add('is-visible');
    ui.done.disabled = false;
    ui.done.textContent = 'Close';
    setProgress(ui, 'Failed', 100, 'Error', null);
}

export async function runAdminImageUploadFlow(options = {}) {
    const maxSize = options.maxSize || IMAGE_DEFAULT_MAX_SIZE;
    const checks = [
        { id: 'type', label: 'File type', detail: 'image file pending', state: 'pending', status: 'pending' },
        { id: 'size', label: 'Size limit', detail: `max ${formatBytes(maxSize)}`, state: 'pending', status: 'pending' },
        { id: 'prepare', label: options.transform ? 'Conversion' : 'Preparation', detail: options.transform ? 'convert to WebP' : 'prepare selected file', state: 'pending', status: 'pending' },
        { id: 'upload', label: 'Upload', detail: options.folder ? `folder: ${options.folder}` : 'send file', state: 'pending', status: 'pending' },
        { id: 'verify', label: 'URL verification', detail: 'block save if public URL returns 404', state: 'pending', status: 'pending' }
    ];
    const ui = openUploadModal({
        ...options,
        title: options.title || `Upload ${options.surface || 'image'}`,
        pendingResultText: 'waiting for verified URL'
    }, checks);

    let failureCheckId = 'type';
    try {
        setProgress(ui, 'Checking file', 8, 'Check', 44);
        validateImage(options.file, maxSize);
        if (typeof options.validate === 'function') options.validate(options.file);
        updateCheck(ui, 'type', 'done', options.file.type || 'image file accepted', 'done');
        failureCheckId = 'size';
        updateCheck(ui, 'size', 'done', `${formatBytes(options.file.size)} under ${formatBytes(maxSize)}`, 'done');

        failureCheckId = 'prepare';
        updateCheck(ui, 'prepare', 'active', options.transform ? 'converting image' : 'preparing upload', 'working');
        setProgress(ui, options.transform ? 'Converting' : 'Preparing', 24, 'Work', 34);
        const uploadPayload = options.transform ? await options.transform(options.file) : options.file;
        updateCheck(ui, 'prepare', 'done', options.transform ? 'WebP ready' : 'file ready', 'done');

        failureCheckId = 'upload';
        updateCheck(ui, 'upload', 'active', 'upload in progress', 'working');
        const stopTicker = startTicker(ui, 42, 88, 'Uploading');
        let uploadedUrl;
        try {
            uploadedUrl = await options.upload(uploadPayload, options.file);
        } finally {
            stopTicker();
        }
        updateCheck(ui, 'upload', 'done', 'upload response received', 'done');

        failureCheckId = 'verify';
        updateCheck(ui, 'verify', 'active', 'opening public image URL', 'checking');
        setProgress(ui, 'Verifying URL', 92, 'Verify', 8);
        if (options.verifyUrl !== false) await verifyImageURL(uploadedUrl, options.verifyTimeoutMs || 12000);
        updateCheck(ui, 'verify', 'done', 'public URL opened successfully', 'done');

        await completeWithResult(ui, uploadedUrl, options.autoCloseMs ?? 900);
        return uploadedUrl;
    } catch (error) {
        updateCheck(ui, failureCheckId, 'error', error?.message || 'upload failed', 'failed');
        await failWithError(ui, error);
        throw error;
    }
}

export async function runAdminFileOperationFlow(options = {}) {
    const maxSize = options.maxSize || SPREADSHEET_DEFAULT_MAX_SIZE;
    const checks = [
        { id: 'type', label: 'File type', detail: 'spreadsheet pending', state: 'pending', status: 'pending' },
        { id: 'size', label: 'Size limit', detail: `max ${formatBytes(maxSize)}`, state: 'pending', status: 'pending' },
        { id: 'process', label: options.processLabel || 'Processing', detail: options.processDetail || 'read and write rows', state: 'pending', status: 'pending' }
    ];
    const ui = openUploadModal({
        ...options,
        title: options.title || `Upload ${options.surface || 'file'}`,
        resultTitle: options.resultTitle || 'Result',
        pendingResultText: options.pendingResultText || 'waiting for import result',
        dropCopy: options.dropCopy || 'Keep this window open while the file is being processed.'
    }, checks);

    let failureCheckId = 'type';
    try {
        setProgress(ui, 'Checking file', 10, 'Check', 36);
        validateSpreadsheet(options.file, maxSize);
        updateCheck(ui, 'type', 'done', '.xlsx / .xls accepted', 'done');
        failureCheckId = 'size';
        updateCheck(ui, 'size', 'done', `${formatBytes(options.file.size)} under ${formatBytes(maxSize)}`, 'done');

        failureCheckId = 'process';
        updateCheck(ui, 'process', 'active', options.processDetail || 'processing file', 'working');
        const stopTicker = startTicker(ui, 34, 92, options.processLabel || 'Processing');
        let result;
        try {
            result = await options.operation(options.file);
        } finally {
            stopTicker();
        }
        updateCheck(ui, 'process', 'done', 'operation completed', 'done');
        const resultText = typeof options.resultText === 'function' ? options.resultText(result) : (options.resultText || 'completed');
        await completeWithResult(ui, resultText, options.autoCloseMs ?? 900);
        return result;
    } catch (error) {
        updateCheck(ui, failureCheckId, 'error', error?.message || 'operation failed', 'failed');
        await failWithError(ui, error);
        throw error;
    }
}
