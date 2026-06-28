import { db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const SETTINGS_REF = doc(db, 'site_settings', 'index');
const CACHE_KEY = 'eden_index_settings_cache_v1';
const PROMO_HIDE_TODAY_KEY = 'eden_promo_popup_hide_date_v1';
const PROMO_MAX_SLIDES = 8;
const ABOUT_QUICK_FACTS_MAX = 6;
const ABOUT_STORY_BLOCKS_MAX = 5;
const ABOUT_FAQ_MAX = 5;
const ABOUT_RELATED_LINKS_MAX = 6;

const FALLBACK_INDEX = {
    heroImageUrl: '/Hero/Hero.webp',
    heroTitleTh: 'จากใจเรา สู่มือคุณ',
    heroSubtitleTh: 'ยินดีต้อนรับสู่ Eden Cafe - พื้นที่พักผ่อนท่ามกลางธรรมชาติของเชียงราย สัมผัสเมล็ดกาแฟที่ปลูกอย่างใส่ใจและคั่วอย่างพิถีพิถันจากเกษตรกรไทย',
    heroTitleEn: 'Discover the True Taste of Thai Specialty Coffee',
    heroSubtitleEn: 'Welcome to Eden Cafe - a calm nature escape in Chiang Rai. Experience locally sourced, ethically grown coffee beans roasted with care.',
    aboutTitleTh: 'เรื่องราวของเรา: จากยอดดอยสู่แก้วกาแฟของคุณ',
    aboutBodyTh: 'Eden Cafe เกิดขึ้นจากความหลงใหลในศิลปะการชงกาแฟและการสนับสนุนเกษตรกรไทย เราคัดสรรเมล็ดกาแฟจากแหล่งปลูกที่ดีที่สุดบนยอดดอยในประเทศไทย คั่วด้วยเทคนิคพิเศษเพื่อให้ได้รสชาติที่เป็นเอกลักษณ์ ไม่เหมือนใคร บรรยากาศร้านของเราออกแบบสไตล์มินิมอล อิงธรรมชาติ เพื่อให้คุณได้พักผ่อนอย่างแท้จริง',
    aboutTitleEn: 'Our Story: From Thai Mountains to Your Cup',
    aboutBodyEn: 'Eden Cafe was born out of a passion for the art of coffee brewing and supporting Thai farmers. We carefully select coffee beans from the best high-altitude farms in Thailand, roasted with special techniques to achieve a unique flavor. Our minimalist, nature-inspired design offers a true sanctuary for relaxation.',
    aboutSeo: {
        hero: {
            subtitleTh: 'คาเฟ่ธรรมชาติในนางแล เชียงราย ที่เล่าเรื่องกาแฟไทยผ่านเมล็ดจากพื้นที่สูง การคั่วอย่างพิถีพิถัน และพื้นที่พักผ่อนที่ใกล้ชิดธรรมชาติ',
            subtitleEn: 'A nature cafe in Nang Lae, Chiang Rai, sharing Thai coffee through highland beans, careful roasting, and a calm space close to nature.',
            imageUrl: '/Hero/Hero.webp',
            imageAltTh: 'บรรยากาศธรรมชาติของ Eden Cafe เชียงราย พร้อมกาแฟพิเศษจากเมล็ดกาแฟไทย',
            imageAltEn: 'Nature setting at Eden Cafe Chiang Rai with Thai specialty coffee'
        },
        quickFacts: [
            { labelTh: 'ที่ตั้ง', valueTh: 'นางแล อำเภอเมืองเชียงราย', labelEn: 'Location', valueEn: 'Nang Lae, Mueang Chiang Rai' },
            { labelTh: 'กาแฟ', valueTh: 'เมล็ดกาแฟไทยจากแหล่งปลูกบนดอย', labelEn: 'Coffee', valueEn: 'Thai highland coffee beans' },
            { labelTh: 'บรรยากาศ', valueTh: 'มินิมอล สงบ ใกล้ธรรมชาติ', labelEn: 'Atmosphere', valueEn: 'Minimal, calm, close to nature' },
            { labelTh: 'เวลาเปิด', valueTh: 'เปิดทุกวัน 09:00-18:00', labelEn: 'Hours', valueEn: 'Open daily 09:00-18:00' }
        ],
        storyBlocks: [
            {
                headingTh: 'เริ่มจากความตั้งใจต่อกาแฟไทย',
                bodyTh: 'Eden Cafe เลือกเล่าเรื่องกาแฟผ่านเมล็ดจากแหล่งปลูกในประเทศไทย โดยให้ความสำคัญกับคุณภาพ ความสด และเอกลักษณ์ของรสชาติในแต่ละแก้ว',
                headingEn: 'Rooted in Thai coffee',
                bodyEn: 'Eden Cafe tells its story through coffee beans grown in Thailand, with attention to quality, freshness, and the character of every cup.'
            },
            {
                headingTh: 'พื้นที่พักผ่อนในเชียงราย',
                bodyTh: 'ร้านออกแบบให้เป็นพื้นที่สงบสำหรับจิบกาแฟ ทำงาน พบเพื่อน หรือใช้เวลาช้า ๆ กับตัวเอง ท่ามกลางบรรยากาศธรรมชาติของเชียงราย',
                headingEn: 'A calm Chiang Rai escape',
                bodyEn: 'The cafe is designed as a peaceful place to drink coffee, work, meet friends, or slow down in a nature-inspired Chiang Rai setting.'
            }
        ],
        coffeeOrigin: {
            titleTh: 'กาแฟจากยอดดอยสู่แก้วของคุณ',
            bodyTh: 'เราให้ความสำคัญกับเมล็ดกาแฟไทยจากพื้นที่สูง เพราะอากาศเย็นและสภาพแวดล้อมช่วยสร้างกลิ่นหอม ความหวาน และมิติรสชาติที่เหมาะกับกาแฟพิเศษ',
            titleEn: 'From Thai mountains to your cup',
            bodyEn: 'We focus on Thai highland coffee because cooler growing conditions help develop aroma, natural sweetness, and the layered taste expected from specialty coffee.'
        },
        faq: [
            {
                questionTh: 'Eden Cafe อยู่ที่ไหน?',
                answerTh: 'Eden Cafe ตั้งอยู่ที่ตำบลนางแล อำเภอเมืองเชียงราย จังหวัดเชียงราย เป็นคาเฟ่ธรรมชาติและร้านกาแฟพิเศษสำหรับพักผ่อนใกล้ธรรมชาติ',
                questionEn: 'Where is Eden Cafe located?',
                answerEn: 'Eden Cafe is located in Nang Lae, Mueang Chiang Rai, Chiang Rai, Thailand. It is a nature cafe and specialty coffee destination.'
            },
            {
                questionTh: 'จุดเด่นของกาแฟ Eden Cafe คืออะไร?',
                answerTh: 'จุดเด่นคือการคัดสรรเมล็ดกาแฟไทยจากแหล่งปลูกบนดอยและการคั่วที่ตั้งใจดึงกลิ่นหอม ความกลมกล่อม และเอกลักษณ์ของกาแฟไทย',
                questionEn: 'What makes Eden Cafe coffee special?',
                answerEn: 'The coffee focuses on Thai highland beans and careful roasting to highlight aroma, balance, and the character of Thai specialty coffee.'
            },
            {
                questionTh: 'Eden Cafe เหมาะกับใครบ้าง?',
                answerTh: 'เหมาะสำหรับคนที่มองหาคาเฟ่เชียงรายบรรยากาศสงบ จิบกาแฟ ทำงาน พบเพื่อน หรือพักผ่อนในพื้นที่ที่ใกล้ชิดธรรมชาติ',
                questionEn: 'Who is Eden Cafe good for?',
                answerEn: 'It is a good fit for visitors looking for a calm Chiang Rai cafe for coffee, work, meeting friends, or relaxing close to nature.'
            }
        ],
        relatedLinks: [
            { labelTh: 'ดูเมนู', labelEn: 'View menu', href: '/menu', descriptionTh: 'สำรวจเมนูกาแฟ เครื่องดื่ม และอาหารของ Eden Cafe', descriptionEn: 'Explore coffee, drinks, and food from Eden Cafe.' },
            { labelTh: 'จองโต๊ะหรือห้องรับรอง', labelEn: 'Book a table or room', href: '/booking', descriptionTh: 'เลือกวัน เวลา และพื้นที่นั่งที่ต้องการ', descriptionEn: 'Choose your date, time, and preferred space.' },
            { labelTh: 'เรื่องกาแฟดอยเชียงราย', labelEn: 'Chiang Rai mountain coffee', href: '/blog/chiang-rai-mountain-coffee', descriptionTh: 'อ่านต่อเรื่องกาแฟจากพื้นที่สูงในเชียงราย', descriptionEn: 'Read more about highland coffee from Chiang Rai.' }
        ],
        seo: {
            titleTh: 'เรื่องราว Eden Cafe เชียงราย | คาเฟ่ธรรมชาติและกาแฟพิเศษนางแล',
            titleEn: 'About Eden Cafe Chiang Rai | Nature Cafe & Thai Specialty Coffee',
            metaDescriptionTh: 'รู้จัก Eden Cafe คาเฟ่ธรรมชาติในนางแล เชียงราย ที่ใส่ใจเมล็ดกาแฟไทยจากแหล่งปลูกบนดอย การคั่วอย่างพิถีพิถัน และพื้นที่พักผ่อนใกล้ธรรมชาติ',
            metaDescriptionEn: 'Discover Eden Cafe in Nang Lae, Chiang Rai, a nature cafe focused on Thai highland coffee beans, careful roasting, and a calm place to relax.',
            ogImage: 'https://edencafe.co/Images/Logo.webp'
        }
    }
};

function cleanText(value, fallback, maxLength) {
    const text = String(value ?? '').trim();
    return (text || fallback).slice(0, maxLength);
}

function cleanOptionalText(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeImageURL(value, fallback = FALLBACK_INDEX.heroImageUrl) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/?(Images|Hero)\//i.test(url)) return url.startsWith('/') ? url : '/' + url;
    return fallback;
}

function safeOptionalLinkURL(value) {
    const url = String(value || '').trim();
    if (!url) return '';
    if (/^(https?:|mailto:|tel:)/i.test(url)) return url.slice(0, 500);
    if (/^\/(?!\/)/.test(url) || /^#/.test(url)) return url.slice(0, 500);
    return '';
}

function cleanRows(rows, mapper, maxItems) {
    return (Array.isArray(rows) ? rows : [])
        .map(mapper)
        .filter(Boolean)
        .slice(0, maxItems);
}

function normalizeAboutSeo(raw = {}) {
    const fallback = FALLBACK_INDEX.aboutSeo;
    const hero = raw.hero || {};
    const coffeeOrigin = raw.coffeeOrigin || raw.coffee_origin || {};
    const seo = raw.seo || {};
    return {
        hero: {
            subtitleTh: cleanText(hero.subtitleTh || raw.heroSubtitleTh, fallback.hero.subtitleTh, 320),
            subtitleEn: cleanText(hero.subtitleEn || raw.heroSubtitleEn, fallback.hero.subtitleEn, 320),
            imageUrl: safeImageURL(hero.imageUrl || hero.image_url || raw.imageUrl || '', fallback.hero.imageUrl),
            imageAltTh: cleanText(hero.imageAltTh || raw.imageAltTh, fallback.hero.imageAltTh, 180),
            imageAltEn: cleanText(hero.imageAltEn || raw.imageAltEn, fallback.hero.imageAltEn, 180)
        },
        quickFacts: cleanRows(raw.quickFacts || raw.quick_facts || fallback.quickFacts, (item = {}) => {
            const row = {
                labelTh: cleanOptionalText(item.labelTh || item.label_th || item.label, 80),
                valueTh: cleanOptionalText(item.valueTh || item.value_th || item.value, 180),
                labelEn: cleanOptionalText(item.labelEn || item.label_en || item.label, 80),
                valueEn: cleanOptionalText(item.valueEn || item.value_en || item.value, 180)
            };
            return (row.labelTh || row.valueTh || row.labelEn || row.valueEn) ? row : null;
        }, ABOUT_QUICK_FACTS_MAX),
        storyBlocks: cleanRows(raw.storyBlocks || raw.story_blocks || fallback.storyBlocks, (item = {}) => {
            const row = {
                headingTh: cleanOptionalText(item.headingTh || item.heading_th || item.titleTh, 120),
                bodyTh: cleanOptionalText(item.bodyTh || item.body_th || item.body, 500),
                headingEn: cleanOptionalText(item.headingEn || item.heading_en || item.titleEn, 120),
                bodyEn: cleanOptionalText(item.bodyEn || item.body_en || item.body, 500)
            };
            return (row.headingTh || row.bodyTh || row.headingEn || row.bodyEn) ? row : null;
        }, ABOUT_STORY_BLOCKS_MAX),
        coffeeOrigin: {
            titleTh: cleanText(coffeeOrigin.titleTh || coffeeOrigin.title_th, fallback.coffeeOrigin.titleTh, 140),
            bodyTh: cleanText(coffeeOrigin.bodyTh || coffeeOrigin.body_th, fallback.coffeeOrigin.bodyTh, 700),
            titleEn: cleanText(coffeeOrigin.titleEn || coffeeOrigin.title_en, fallback.coffeeOrigin.titleEn, 140),
            bodyEn: cleanText(coffeeOrigin.bodyEn || coffeeOrigin.body_en, fallback.coffeeOrigin.bodyEn, 700)
        },
        faq: cleanRows(raw.faq || raw.faqs || fallback.faq, (item = {}) => {
            const row = {
                questionTh: cleanOptionalText(item.questionTh || item.question_th || item.question, 180),
                answerTh: cleanOptionalText(item.answerTh || item.answer_th || item.answer, 500),
                questionEn: cleanOptionalText(item.questionEn || item.question_en || item.question, 180),
                answerEn: cleanOptionalText(item.answerEn || item.answer_en || item.answer, 500)
            };
            return (row.questionTh || row.answerTh || row.questionEn || row.answerEn) ? row : null;
        }, ABOUT_FAQ_MAX),
        relatedLinks: cleanRows(raw.relatedLinks || raw.related_links || fallback.relatedLinks, (item = {}) => {
            const href = safeOptionalLinkURL(item.href || item.url || '');
            const row = {
                labelTh: cleanOptionalText(item.labelTh || item.label_th || item.label, 90),
                labelEn: cleanOptionalText(item.labelEn || item.label_en || item.label, 90),
                href,
                descriptionTh: cleanOptionalText(item.descriptionTh || item.description_th || item.description, 180),
                descriptionEn: cleanOptionalText(item.descriptionEn || item.description_en || item.description, 180)
            };
            return href && (row.labelTh || row.labelEn) ? row : null;
        }, ABOUT_RELATED_LINKS_MAX),
        seo: {
            titleTh: cleanText(seo.titleTh || seo.title_th, fallback.seo.titleTh, 70),
            titleEn: cleanText(seo.titleEn || seo.title_en, fallback.seo.titleEn, 70),
            metaDescriptionTh: cleanText(seo.metaDescriptionTh || seo.meta_description_th, fallback.seo.metaDescriptionTh, 170),
            metaDescriptionEn: cleanText(seo.metaDescriptionEn || seo.meta_description_en, fallback.seo.metaDescriptionEn, 170),
            ogImage: safeImageURL(seo.ogImage || seo.og_image || '', fallback.seo.ogImage)
        }
    };
}

function isEnglishPage() {
    return document.documentElement.lang?.toLowerCase().startsWith('en')
        || /(?:^|\/)en(?:\.html)?(?:$|[?#/])/.test(window.location.pathname)
        || /-en\.html$/.test(window.location.pathname);
}

function normalizePromoPopup(raw = {}) {
    const slides = Array.isArray(raw.slides)
        ? raw.slides.map((slide, index) => ({
            imageUrl: safeImageURL(slide.imageUrl || slide.image_url || '', ''),
            linkUrl: safeOptionalLinkURL(slide.linkUrl || slide.link_url || ''),
            altText: cleanOptionalText(slide.altText || slide.alt || '', 180),
            order: Number.isFinite(Number(slide.order)) ? Number(slide.order) : index + 1
        })).filter(slide => slide.imageUrl).sort((a, b) => a.order - b.order).slice(0, PROMO_MAX_SLIDES)
        : [];
    return {
        enabled: raw.enabled === true,
        title: cleanOptionalText(raw.title || raw.titleTh || raw.titleEn || 'Eden Cafe promotions', 90),
        slides
    };
}

function normalizeIndexSettings(data = {}) {
    return {
        heroImageUrl: safeImageURL(data.heroImageUrl || data.hero_image_url || FALLBACK_INDEX.heroImageUrl),
        heroTitleTh: cleanText(data.heroTitleTh, FALLBACK_INDEX.heroTitleTh, 120),
        heroSubtitleTh: cleanText(data.heroSubtitleTh, FALLBACK_INDEX.heroSubtitleTh, 320),
        heroTitleEn: cleanText(data.heroTitleEn, FALLBACK_INDEX.heroTitleEn, 120),
        heroSubtitleEn: cleanText(data.heroSubtitleEn, FALLBACK_INDEX.heroSubtitleEn, 320),
        aboutTitleTh: cleanText(data.aboutTitleTh, FALLBACK_INDEX.aboutTitleTh, 140),
        aboutBodyTh: cleanText(data.aboutBodyTh, FALLBACK_INDEX.aboutBodyTh, 900),
        aboutTitleEn: cleanText(data.aboutTitleEn, FALLBACK_INDEX.aboutTitleEn, 140),
        aboutBodyEn: cleanText(data.aboutBodyEn, FALLBACK_INDEX.aboutBodyEn, 900),
        aboutSeo: normalizeAboutSeo(data.aboutSeo || data.about_seo || {})
    };
}

function setText(selector, value) {
    const element = document.querySelector(selector);
    if (element && value) element.textContent = value;
}

function aboutText(row = {}, key, lang) {
    return row[`${key}${lang}`] || row[`${key}${lang === 'En' ? 'Th' : 'En'}`] || '';
}

function setMeta(selector, value) {
    if (!value) return;
    const element = document.querySelector(selector);
    if (element) element.setAttribute('content', value);
}

function updateSeoMetadata(seo = {}, lang = 'Th') {
    const title = aboutText(seo, 'title', lang);
    const description = aboutText(seo, 'metaDescription', lang);
    if (title) {
        document.title = title;
        setMeta('meta[property="og:title"]', title);
        setMeta('meta[name="twitter:title"]', title);
    }
    if (description) {
        setMeta('meta[name="description"]', description);
        setMeta('meta[property="og:description"]', description);
        setMeta('meta[name="twitter:description"]', description);
    }
    if (seo.ogImage) {
        setMeta('meta[property="og:image"]', seo.ogImage);
        setMeta('meta[name="twitter:image"]', seo.ogImage);
    }
}

function renderAboutFaqSchema(faqs = [], lang = 'Th') {
    const id = 'eden-about-faq-schema';
    document.getElementById(id)?.remove();
    const mainEntity = faqs
        .map(item => ({
            question: aboutText(item, 'question', lang),
            answer: aboutText(item, 'answer', lang)
        }))
        .filter(item => item.question && item.answer);
    if (!mainEntity.length) return;
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = id;
    script.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: mainEntity.map(item => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: {
                '@type': 'Answer',
                text: item.answer
            }
        }))
    });
    document.head.appendChild(script);
}

function renderAboutSeo(aboutSeo = FALLBACK_INDEX.aboutSeo, lang = 'Th') {
    const subtitle = aboutText(aboutSeo.hero, 'subtitle', lang);
    setText('[data-index-about="hero-subtitle"]', subtitle);

    const image = document.querySelector('[data-index-about-image]');
    if (image) {
        image.src = aboutSeo.hero.imageUrl;
        image.alt = aboutText(aboutSeo.hero, 'imageAlt', lang);
    }

    const quickFacts = document.querySelector('[data-index-about="quick-facts"]');
    if (quickFacts) {
        quickFacts.innerHTML = aboutSeo.quickFacts.map(item => `
            <article class="about-fact">
                <span>${escapeHTML(aboutText(item, 'label', lang))}</span>
                <strong>${escapeHTML(aboutText(item, 'value', lang))}</strong>
            </article>
        `).join('');
    }

    const storyBlocks = document.querySelector('[data-index-about="story-blocks"]');
    if (storyBlocks) {
        storyBlocks.innerHTML = aboutSeo.storyBlocks.map(item => `
            <article class="about-story-card">
                <h3>${escapeHTML(aboutText(item, 'heading', lang))}</h3>
                <p>${escapeHTML(aboutText(item, 'body', lang))}</p>
            </article>
        `).join('');
    }

    const origin = document.querySelector('[data-index-about="coffee-origin"]');
    if (origin) {
        origin.innerHTML = `
            <h3>${escapeHTML(aboutText(aboutSeo.coffeeOrigin, 'title', lang))}</h3>
            <p>${escapeHTML(aboutText(aboutSeo.coffeeOrigin, 'body', lang))}</p>
        `;
    }

    const faq = document.querySelector('[data-index-about="faq"]');
    if (faq) {
        faq.innerHTML = aboutSeo.faq.map((item, index) => `
            <article class="about-faq-item">
                <details${index === 0 ? ' open' : ''}>
                    <summary>${escapeHTML(aboutText(item, 'question', lang))}</summary>
                    <p>${escapeHTML(aboutText(item, 'answer', lang))}</p>
                </details>
            </article>
        `).join('');
    }
    renderAboutFaqSchema(aboutSeo.faq, lang);

    const links = document.querySelector('[data-index-about="related-links"]');
    if (links) {
        links.innerHTML = aboutSeo.relatedLinks.map(item => {
            const label = aboutText(item, 'label', lang);
            const description = aboutText(item, 'description', lang);
            return `
                <a class="about-related-link" href="${escapeHTML(item.href)}">
                    <strong>${escapeHTML(label)}</strong>
                    ${description ? `<span>${escapeHTML(description)}</span>` : ''}
                </a>
            `;
        }).join('');
    }

    updateSeoMetadata(aboutSeo.seo, lang);
}

function setHeroImage(imageUrl) {
    const hero = document.querySelector('#home.hero');
    if (!hero || !imageUrl) return;

    const apply = () => {
        hero.style.setProperty('--index-hero-image', `url("${imageUrl}")`);
        hero.classList.add('index-hero-ready');
    };

    const image = new Image();
    image.onload = apply;
    image.onerror = apply;
    image.src = imageUrl;
    if (image.complete) apply();
}

function applyIndexSettings(rawSettings = {}, source = '') {
    const settings = normalizeIndexSettings(rawSettings);
    const lang = isEnglishPage() ? 'En' : 'Th';

    setText('[data-index-setting="hero-title"]', settings[`heroTitle${lang}`]);
    setText('[data-index-setting="hero-subtitle"]', settings[`heroSubtitle${lang}`]);
    setText('[data-index-setting="about-title"]', settings[`aboutTitle${lang}`]);
    setText('[data-index-setting="about-body"]', settings[`aboutBody${lang}`]);
    renderAboutSeo(settings.aboutSeo, lang);
    setHeroImage(settings.heroImageUrl);
    document.documentElement.classList.add('index-settings-applied');
    if (source) document.documentElement.dataset.indexSettingsSource = source;
}

function readCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

function writeCache(settings) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(normalizeIndexSettings(settings)));
    } catch (_) {
        // Cache is a speed optimization only.
    }
}

function localDateStamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isPromoHiddenToday() {
    try {
        return localStorage.getItem(PROMO_HIDE_TODAY_KEY) === localDateStamp();
    } catch (_) {
        return false;
    }
}

function hidePromoForToday() {
    try {
        localStorage.setItem(PROMO_HIDE_TODAY_KEY, localDateStamp());
    } catch (_) {
        // Visitor storage can be unavailable in private contexts.
    }
}

function destroyPromoPopup() {
    document.querySelector('.eden-promo-popup')?.remove();
    document.body?.classList.remove('eden-promo-popup-open');
}

function promoIcon(path) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
}

function shouldOpenLinkInNewTab(url) {
    try {
        const parsed = new URL(url, window.location.href);
        return parsed.origin !== window.location.origin && /^https?:$/i.test(parsed.protocol);
    } catch (_) {
        return false;
    }
}

function renderPromoPopup(rawPopup = {}) {
    const popup = normalizePromoPopup(rawPopup);
    destroyPromoPopup();
    if (!popup.enabled || !popup.slides.length || isPromoHiddenToday()) return;

    const isEn = isEnglishPage();
    let activeIndex = 0;
    const root = document.createElement('div');
    root.className = 'eden-promo-popup';
    root.innerHTML = `
        <div class="eden-promo-popup__scrim" data-promo-close></div>
        <section class="eden-promo-popup__dialog" role="dialog" aria-modal="true" aria-label="${isEn ? 'Promotions' : 'โปรโมชั่น'}">
            <div class="eden-promo-popup__stage">
                <button type="button" class="eden-promo-popup__nav eden-promo-popup__nav--prev" data-promo-prev aria-label="${isEn ? 'Previous promotion' : 'โปรโมชั่นก่อนหน้า'}">
                    ${promoIcon('<path d="m15 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')}
                </button>
                <div class="eden-promo-popup__media" data-promo-media></div>
                <button type="button" class="eden-promo-popup__nav eden-promo-popup__nav--next" data-promo-next aria-label="${isEn ? 'Next promotion' : 'โปรโมชั่นถัดไป'}">
                    ${promoIcon('<path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>')}
                </button>
            </div>
            <div class="eden-promo-popup__dots" data-promo-dots></div>
            <footer class="eden-promo-popup__footer">
                <label class="eden-promo-popup__check">
                    <input type="checkbox" data-promo-hide-today>
                    <span>${isEn ? 'Do not show again today' : 'ไม่ต้องแสดงอีกวันนี้'}</span>
                </label>
                <button type="button" class="eden-promo-popup__close" data-promo-close aria-label="${isEn ? 'Close promotions' : 'ปิดโปรโมชั่น'}">
                    ${promoIcon('<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>')}
                </button>
            </footer>
        </section>
    `;

    const media = root.querySelector('[data-promo-media]');
    const dots = root.querySelector('[data-promo-dots]');
    const hideToday = root.querySelector('[data-promo-hide-today]');

    function rememberIfRequested() {
        if (hideToday?.checked) hidePromoForToday();
    }

    function closePopup() {
        rememberIfRequested();
        destroyPromoPopup();
        document.removeEventListener('keydown', handleKeydown);
    }

    function renderSlide(index) {
        activeIndex = (index + popup.slides.length) % popup.slides.length;
        const slide = popup.slides[activeIndex];
        const img = document.createElement('img');
        img.src = slide.imageUrl;
        img.alt = slide.altText || popup.title || (isEn ? 'Promotion' : 'โปรโมชั่น');
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';

        media.replaceChildren();
        if (slide.linkUrl) {
            const link = document.createElement('a');
            link.href = slide.linkUrl;
            link.className = 'eden-promo-popup__link';
            if (shouldOpenLinkInNewTab(slide.linkUrl)) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            link.addEventListener('click', rememberIfRequested);
            link.appendChild(img);
            media.appendChild(link);
        } else {
            media.appendChild(img);
        }

        dots.querySelectorAll('button').forEach((button, dotIndex) => {
            button.classList.toggle('is-active', dotIndex === activeIndex);
            button.setAttribute('aria-current', dotIndex === activeIndex ? 'true' : 'false');
        });
    }

    function handleKeydown(event) {
        if (event.key === 'Escape') closePopup();
        if (event.key === 'ArrowLeft' && popup.slides.length > 1) renderSlide(activeIndex - 1);
        if (event.key === 'ArrowRight' && popup.slides.length > 1) renderSlide(activeIndex + 1);
    }

    dots.replaceChildren(...popup.slides.map((_, index) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.setAttribute('aria-label', `${isEn ? 'Show promotion' : 'ดูโปรโมชั่น'} ${index + 1}`);
        dot.addEventListener('click', () => renderSlide(index));
        return dot;
    }));

    root.querySelectorAll('[data-promo-close]').forEach(button => button.addEventListener('click', closePopup));
    root.querySelector('[data-promo-prev]')?.addEventListener('click', () => renderSlide(activeIndex - 1));
    root.querySelector('[data-promo-next]')?.addEventListener('click', () => renderSlide(activeIndex + 1));
    root.classList.toggle('is-single-slide', popup.slides.length <= 1);

    document.body.appendChild(root);
    document.body.classList.add('eden-promo-popup-open');
    document.addEventListener('keydown', handleKeydown);
    renderSlide(0);
}

async function loadIndexSettings() {
    const cached = readCache();
    if (cached) applyIndexSettings(cached, 'cache');

    try {
        const snap = await getDoc(SETTINGS_REF);
        if (!snap.exists()) {
            destroyPromoPopup();
            if (!cached) applyIndexSettings(FALLBACK_INDEX, 'fallback');
            return;
        }
        const rawSettings = snap.data();
        const settings = normalizeIndexSettings(rawSettings);
        writeCache(settings);
        applyIndexSettings(settings, 'firestore');
        renderPromoPopup(rawSettings.promoPopup || rawSettings.promo_popup || {});
    } catch (_) {
        if (!cached) applyIndexSettings(FALLBACK_INDEX, 'fallback');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadIndexSettings);
} else {
    loadIndexSettings();
}
