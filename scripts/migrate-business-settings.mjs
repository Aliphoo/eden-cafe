import { createRequire } from 'node:module';

const DEFAULT_PROJECT_ID = 'edencafe-d9095';
const CONFIRM_TEXT = 'CREATE_SITE_SETTINGS_BUSINESS';
const args = process.argv.slice(2);

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = args.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasArg(name) {
  return args.includes(`--${name}`);
}

const projectId = argValue('project-id', DEFAULT_PROJECT_ID);
const apply = hasArg('apply');
const confirmText = argValue('confirm');
const stdoutOnly = hasArg('stdout-only');

function cleanText(value, fallback = '', maxLength = 500) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maxLength);
}

function cleanUrl(value) {
  const text = cleanText(value, '', 500);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decodeFirestoreValue(item)])
    );
  }
  return null;
}

function decodeFirestoreDocument(raw) {
  return Object.fromEntries(
    Object.entries(raw?.fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)])
  );
}

async function readSiteSettingsDoc(docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/site_settings/${docId}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Unable to read site_settings/${docId}: HTTP ${response.status}`);
  return decodeFirestoreDocument(await response.json());
}

function uniqueUrls(values) {
  return Array.from(new Set(values.map(cleanUrl).filter(Boolean))).slice(0, 12);
}

function normalizeLegacyAddress(value) {
  const text = cleanText(value, '', 500);
  if (!text || /อำเมือง/.test(text) || !/57100/.test(text)) {
    return '306 หมู่ 7 ตำบลนางแล อำเภอเมืองเชียงราย จังหวัดเชียงราย 57100';
  }
  return text;
}

function normalizePhoneDisplay(value) {
  const text = cleanText(value, '', 40);
  if (/^\d{10}$/.test(text)) return text.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  return text || '098-008-0383';
}

function buildBusinessDoc({ footer = {}, index = {} } = {}) {
  const phone = cleanText(footer.phone, '0980080383', 40);
  const instagram = cleanUrl(footer.instagram);
  const facebook = cleanUrl(footer.facebook);
  const line = cleanUrl(footer.line);
  const googleMapsUrl = cleanUrl(footer.googleMapsUrl || footer.google_maps_url) || 'https://maps.app.goo.gl/BYJNa4mXjVNaLDPy5';
  const business = {
    brandName: cleanText(footer.brandName, 'Eden Cafe.', 120),
    brandNameEn: cleanText(footer.brandNameEn || footer.brandName, 'Eden Cafe.', 120),
    legalName: cleanText(footer.legalName, 'Eden Cafe Thailand', 160),
    tagline: cleanText(
      footer.tagline,
      'กาแฟพิเศษระดับพรีเมียม ท่ามกลางสวนธรรมชาติและบรรยากาศสงบ พื้นที่พักผ่อนสำหรับการใช้ชีวิตช้า ๆ พร้อมอาหาร เครื่องดื่ม และประสบการณ์ Wellness เพื่อสุขภาพ',
      320
    ),
    taglineEn: cleanText(footer.taglineEn, 'Premium specialty coffee and a calm garden escape in Chiang Rai.', 320),
    description: cleanText(index.aboutBodyTh || footer.tagline, 'Eden Cafe เป็นคาเฟ่ธรรมชาติและร้านกาแฟพิเศษในตำบลนางแล อำเภอเมืองเชียงราย จังหวัดเชียงราย', 900),
    descriptionEn: cleanText(index.aboutBodyEn || footer.taglineEn, 'Eden Cafe is a nature cafe and specialty coffee destination in Nang Lae, Mueang Chiang Rai, Chiang Rai, Thailand.', 900),
    address: normalizeLegacyAddress(footer.address),
    addressEn: cleanText(footer.addressEn, '306 Moo 7, Nang Lae, Mueang Chiang Rai, Chiang Rai 57100', 500),
    streetAddress: '306 Moo 7, Nang Lae',
    addressLocality: 'Mueang Chiang Rai',
    addressRegion: 'Chiang Rai',
    postalCode: '57100',
    addressCountry: 'TH',
    latitude: null,
    longitude: null,
    phone,
    phoneDisplay: normalizePhoneDisplay(footer.phoneDisplay || footer.phone),
    email: cleanText(footer.email, 'edencafe.2565@gmail.com', 180),
    websiteUrl: 'https://edencafe.co/',
    googleMapsUrl,
    opens: '09:00',
    closes: '18:00',
    openingHoursText: 'เปิดทุกวัน 09:00-18:00 น.',
    openingHoursTextEn: 'Open daily 09:00-18:00',
    instagram,
    facebook,
    line,
    sameAs: uniqueUrls([instagram, facebook, line, googleMapsUrl]),
    copyright: cleanText(footer.copyright, '© 2017 Eden Cafe Thailand. สงวนลิขสิทธิ์ | Optimized for SEO, AEO & GEO', 220),
    copyrightEn: cleanText(footer.copyrightEn, '© 2017 Eden Cafe Thailand. All rights reserved | Optimized for SEO, AEO & GEO', 220),
    source: 'site_settings/footer + site_settings/index migration'
  };

  return {
    ...business,
    addressStructured: {
      streetAddress: business.streetAddress,
      addressLocality: business.addressLocality,
      addressRegion: business.addressRegion,
      postalCode: business.postalCode,
      addressCountry: business.addressCountry
    },
    geo: {
      latitude: business.latitude,
      longitude: business.longitude
    },
    openingHours: {
      days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      opens: business.opens,
      closes: business.closes
    },
    socials: {
      instagram: business.instagram,
      facebook: business.facebook,
      line: business.line
    }
  };
}

function validateBusinessDoc(doc) {
  const text = JSON.stringify(doc);
  const banned = [/คาเฟ่กรุงเทพ/i, /เมืองใหญ่/i, /heart of Thailand/i, /อำเมือง/i, /13\.7563/, /100\.5018/, /07:30/, /your-official-page/i, /your-official-id/i];
  const hit = banned.find(pattern => pattern.test(text));
  if (hit) throw new Error(`Refusing to migrate placeholder business value: ${hit}`);
  if (!doc.brandName || !doc.phone || !doc.email) throw new Error('Business doc requires brandName, phone, and email.');
}

async function applyBusinessDoc(doc) {
  if (confirmText !== CONFIRM_TEXT) {
    throw new Error(`Use --apply --confirm=${CONFIRM_TEXT} to write site_settings/business.`);
  }
  const require = createRequire(import.meta.url);
  let admin;
  try {
    admin = require('../functions/node_modules/firebase-admin');
  } catch (_) {
    admin = require('firebase-admin');
  }
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId,
      credential: admin.credential.applicationDefault()
    });
  }
  await admin.firestore().collection('site_settings').doc('business').set({
    ...doc,
    migratedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: 'scripts/migrate-business-settings.mjs'
  }, { merge: true });
}

async function main() {
  const [existingBusiness, footer, index] = await Promise.all([
    readSiteSettingsDoc('business'),
    readSiteSettingsDoc('footer'),
    readSiteSettingsDoc('index')
  ]);

  const doc = buildBusinessDoc({ footer: footer || {}, index: index || {} });
  validateBusinessDoc(doc);

  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    projectId,
    existingBusiness: Boolean(existingBusiness),
    sourceDocs: {
      footer: Boolean(footer),
      index: Boolean(index)
    },
    targetDoc: 'site_settings/business',
    business: doc
  };

  if (apply) {
    await applyBusinessDoc(doc);
    summary.applied = true;
  }

  if (stdoutOnly) {
    process.stdout.write(JSON.stringify(summary, null, 2));
  } else {
    console.log(JSON.stringify(summary, null, 2));
    if (!apply) {
      console.log(`Dry run only. To write, rerun with --apply --confirm=${CONFIRM_TEXT}`);
    }
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
