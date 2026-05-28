const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRAPE_PATH = path.join(__dirname, '..', 'backups', 'loyverse-image-scrape-live.json');
const IMPORT_PATH = path.join(__dirname, '..', 'backups', 'loyverse-products-import-ready-2026-05-27T13-54-11-923Z.json');
const OUT_DIR = path.join(__dirname, '..', 'Images', 'loyverse', 'menu');
const MAP_PATH = path.join(OUT_DIR, 'image-map.json');

const CONCURRENCY = 8;

function findPython() {
  const candidates = [
    process.env.PYTHON,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python'),
    process.platform === 'win32' ? 'py' : null,
    'python3',
    'python',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false });
    if (result.status === 0) return candidate;
  }
  return null;
}

function convertMapToWebp() {
  if (process.argv.includes('--skip-webp')) return { skipped: true, reason: 'skip-webp flag' };

  const python = findPython();
  if (!python) {
    throw new Error('Python with Pillow is required to auto-convert Loyverse images to WebP.');
  }

  const scriptPath = path.join(__dirname, 'convert-loyverse-images-to-webp.py');
  const result = spawnSync(python, [scriptPath, '--map', MAP_PATH, '--delete-originals'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`WebP conversion failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || '{}');
}

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
  const webp = convertMapToWebp();

  console.log(JSON.stringify({
    totalCandidates: candidates.length,
    downloaded: ok.length,
    failed: failed.length,
    webp,
    mapPath: MAP_PATH,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
