import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const bundleExtensions = new Set([".js"]);

const apkPaths = [
  "android/app/build/outputs/apk/release/app-release.apk",
  "artifacts/EdenCafePOS-1.24-v25-release.apk",
  "EdenCafePOS-release.apk"
];

const toPosix = (value) => value.replace(/\\/g, "/");
const rel = (filePath) => toPosix(path.relative(projectRoot, filePath));

const readTextFile = (filePath) => ({
  label: rel(filePath),
  text: fs.readFileSync(filePath, "utf8")
});

const walkFiles = (dir, extensions) => {
  const root = path.join(projectRoot, dir);
  if (!fs.existsSync(root)) {
    return [];
  }

  const results = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  };
  walk(root);
  return results.sort();
};

const findEndOfCentralDirectory = (buffer) => {
  const lowerBound = Math.max(0, buffer.length - 0xffff - 22);
  for (let index = buffer.length - 22; index >= lowerBound; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      return index;
    }
  }
  return -1;
};

const extractZipTextEntries = (zipPath, matcher) => {
  const buffer = fs.readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error(`Cannot read ZIP central directory from ${rel(zipPath)}`);
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];

  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry in ${rel(zipPath)}`);
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const entryName = buffer
      .subarray(nameStart, nameStart + fileNameLength)
      .toString("utf8");

    offset = nameStart + fileNameLength + extraLength + commentLength;

    if (!matcher(entryName)) {
      continue;
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header for ${entryName}`);
    }

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;

    if (compressionMethod === 0) {
      data = compressed;
    } else if (compressionMethod === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${entryName}`);
    }

    entries.push({
      label: `${rel(zipPath)}!${entryName}`,
      text: data.toString("utf8")
    });
  }

  return entries;
};

const collectScopes = () => {
  const scopes = [
    {
      label: "src",
      entries: walkFiles("src", codeExtensions).map(readTextFile)
    },
    {
      label: "dist",
      entries: walkFiles("dist", bundleExtensions).map(readTextFile)
    },
    {
      label: "android-assets",
      entries: walkFiles("android/app/src/main/assets/public", bundleExtensions).map(readTextFile)
    }
  ];

  for (const apkPath of apkPaths) {
    const absolutePath = path.join(projectRoot, apkPath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    scopes.push({
      label: `apk:${apkPath}`,
      entries: extractZipTextEntries(
        absolutePath,
        (entryName) => entryName.startsWith("assets/public/") && entryName.endsWith(".js")
      )
    });
  }

  return scopes;
};

const compact = (text) => text.replace(/\s+/g, " ").trim().slice(0, 240);

const failures = [];
const scopes = collectScopes();

const assertNoIntlNumberFormat = (entry) => {
  if (entry.text.includes("Intl.NumberFormat")) {
    failures.push({
      label: entry.label,
      reason: "Intl.NumberFormat is not allowed in POS release bundles; use manual money formatting."
    });
  }
};

const assertSafeFractionDigits = (entry) => {
  const pattern = /maximumFractionDigits\s*:\s*0/g;
  let match;
  while ((match = pattern.exec(entry.text))) {
    const context = entry.text.slice(Math.max(0, match.index - 140), match.index + 180);
    if (!/minimumFractionDigits\s*:\s*0/.test(context)) {
      failures.push({
        label: entry.label,
        reason: `maximumFractionDigits: 0 without nearby minimumFractionDigits: 0 -> ${compact(context)}`
      });
    }
  }
};

const assertNoMoneyLocaleString = (entry) => {
  const pattern = /\.toLocaleString\s*\(/g;
  const riskyBefore =
    /(\b(total|amount|paid|change|discount|price|subtotal|payable|tax|loyaltyDiscount|redeem|refund|points|quantity|qty)\b|\.(total|amount|paid|change|discount|price|subtotal|payable|tax|points))[^;\n]{0,90}$/i;
  const moneyContext = /(฿|baht|currency|formatCurrency|formatBaht)/i;
  const dateContext = /(new Date|DateTimeFormat|createdAt|updatedAt|date|time|Time:|toISOString)/i;
  let match;

  while ((match = pattern.exec(entry.text))) {
    const before = entry.text.slice(Math.max(0, match.index - 120), match.index);
    const context = entry.text.slice(Math.max(0, match.index - 180), match.index + 220);
    if ((riskyBefore.test(before) || moneyContext.test(context)) && !dateContext.test(context)) {
      failures.push({
        label: entry.label,
        reason: `Potential money toLocaleString() usage -> ${compact(context)}`
      });
    }
  }
};

for (const scope of scopes) {
  if (!scope.entries.length && ["src", "dist", "android-assets"].includes(scope.label)) {
    failures.push({
      label: scope.label,
      reason: "Expected scan target has no JavaScript/TypeScript files."
    });
  }

  for (const entry of scope.entries) {
    assertNoIntlNumberFormat(entry);
    assertSafeFractionDigits(entry);
    assertNoMoneyLocaleString(entry);
  }
}

if (failures.length) {
  console.error("Money formatter guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure.label}: ${failure.reason}`);
  }
  process.exit(1);
}

const scanned = scopes.reduce((count, scope) => count + scope.entries.length, 0);
const apkScopes = scopes.filter((scope) => scope.label.startsWith("apk:")).length;
console.log(
  `Money formatter guard passed: scanned ${scanned} files across ${scopes.length} scopes (${apkScopes} APK scope(s)).`
);
