const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.txt',
  '.yml',
  '.yaml'
]);
const IGNORED_DIRS = new Set([
  '.firebase',
  '.git',
  'backups',
  'functions/node_modules',
  'node_modules'
]);
const MOJIBAKE_PATTERNS = [
  /\u00E0\u00B8/u,
  /\u00E0\u00B9/u,
  /\u00F0\u0178/u,
  /\u00C3[\u0080-\u00BF]/u,
  /\u00C2[\u0080-\u00BF]/u,
  /\uFFFD/u
];

function isIgnored(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  return [...IGNORED_DIRS].some(dir => normalized === dir || normalized.startsWith(dir + '/'));
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(ROOT, fullPath);
    if (isIgnored(relativePath)) continue;
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function hasUtf16Bom(bytes) {
  return bytes.length >= 2 && (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  );
}

function hasMojibake(text) {
  return MOJIBAKE_PATTERNS.some(pattern => pattern.test(text));
}

const problems = [];
for (const file of walk(ROOT)) {
  const bytes = fs.readFileSync(file);
  const relativePath = path.relative(ROOT, file).replace(/\\/g, '/');
  if (hasUtf16Bom(bytes)) {
    problems.push(`${relativePath}: UTF-16 BOM detected. Save as UTF-8.`);
    continue;
  }

  const text = bytes.toString('utf8');
  if (hasMojibake(text)) {
    problems.push(`${relativePath}: possible mojibake detected.`);
  }
}

if (problems.length) {
  console.error('Encoding check failed:');
  for (const problem of problems) console.error('- ' + problem);
  console.error('\nUse Node fs readFileSync/writeFileSync with utf8, or PowerShell Get-Content/Set-Content with -Encoding UTF8.');
  process.exit(1);
}

console.log('Encoding check passed: UTF-8 text looks clean.');
