const fs = require('fs');
const path = require('path');

const SCRAPE_PATH = path.join(__dirname, '..', 'backups', 'loyverse-image-scrape-live.json');
const IMPORT_PATH = path.join(__dirname, '..', 'backups', 'loyverse-products-import-ready-2026-05-27T13-54-11-923Z.json');
const OUT_DIR = path.join(__dirname, '..', 'Images', 'loyverse', 'menu');
const MAP_PATH = path.join(OUT_DIR, 'image-map.json');

const CONCURRENCY = 8;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function extensionFrom(response, url) {
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  const cleanUrl = String(url).split('?')[0].toLowerCase();
  if (cleanUrl.endsWith('.png')) return '.png';
  if (cleanUrl.endsWith('.webp')) return '.webp';
  if (cleanUrl.endsWith('.gif')) return '.gif';
  return '.jpg';
}

async function download(item) {
  const response = await fetch(item.sourceImageUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const ext = extensionFrom(response, item.sourceImageUrl);
  const fileName = `${item.id}${ext}`;
  const localPath = path.join(OUT_DIR, fileName);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, bytes);
  return {
    ...item,
    imageUrl: `Images/loyverse/menu/${fileName}`,
    byteSize: bytes.length,
    contentType: response.headers.get('content-type') || '',
  };
}

async function runQueue(items) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      try {
        results.push(await download(current));
      } catch (error) {
        results.push({ ...current, error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const scrape = readJson(SCRAPE_PATH);
  const imported = readJson(IMPORT_PATH);
  const productById = new Map((imported.products || []).map(product => [product.id, product]));

  const candidates = (scrape.items || [])
    .filter(item => item.imageUrl && item.nameMatches)
    .map(item => {
      const product = productById.get(item.id) || {};
      return {
        collection: 'products',
        id: item.id,
        loyverseId: item.loyverseId,
        name: product.name || item.name,
        scrapedName: item.scrapedName,
        category: product.category || '',
        sourceUrl: item.sourceUrl,
        sourceImageUrl: item.imageUrl,
      };
    })
    .filter(item => normalizeName(item.name) === normalizeName(item.scrapedName));

  const downloaded = await runQueue(candidates);
  const ok = downloaded.filter(item => !item.error);
  const failed = downloaded.filter(item => item.error);

  ok.sort((a, b) => a.id.localeCompare(b.id));
  failed.sort((a, b) => a.id.localeCompare(b.id));

  const map = {
    generatedAt: new Date().toISOString(),
    source: 'loyverse',
    totalCandidates: candidates.length,
    downloaded: ok.length,
    failed: failed.length,
    items: ok.map(item => ({
      collection: item.collection,
      id: item.id,
      loyverseId: item.loyverseId,
      name: item.name,
      category: item.category,
      sourceUrl: item.sourceUrl,
      sourceImageUrl: item.sourceImageUrl,
      imageUrl: item.imageUrl,
      byteSize: item.byteSize,
      contentType: item.contentType,
    })),
    failedItems: failed.map(item => ({
      id: item.id,
      name: item.name,
      sourceImageUrl: item.sourceImageUrl,
      error: item.error,
    })),
  };

  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2), 'utf8');
  console.log(JSON.stringify({
    totalCandidates: candidates.length,
    downloaded: ok.length,
    failed: failed.length,
    mapPath: MAP_PATH,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
