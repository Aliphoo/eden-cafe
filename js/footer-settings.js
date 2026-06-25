import {
    applyBusinessFooterSettings,
    defaultBusinessSettings,
    loadPublicBusinessSettings
} from './business-settings.js';

async function loadPublicFooterSettings() {
    applyBusinessFooterSettings(defaultBusinessSettings());

    try {
        const settings = await loadPublicBusinessSettings();
        applyBusinessFooterSettings(settings);
    } catch (_) {
        // The default business footer is already applied.
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPublicFooterSettings, { once: true });
} else {
    loadPublicFooterSettings();
}
