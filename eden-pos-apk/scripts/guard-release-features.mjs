import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".html"]);
const bundleExtensions = new Set([".js", ".css", ".html"]);

const apkPaths = [
  "android/app/build/outputs/apk/release/app-release.apk",
  "artifacts/EdenCafePOS-1.24-v25-release.apk",
  "EdenCafePOS-release.apk"
];

const features = [
  {
    name: "split bill",
    required: [/split-bill/i, /แยกบิล/]
  },
  {
    name: "category drag/order",
    required: [/category-drag-icon/i, /กดค้างแล้วลากเพื่อเรียงลำดับ/]
  },
  {
    name: "sales date presets",
    required: [/วันนี้/, /เมื่อวาน/, /1 สัปดาห์/, /1 เดือน/, /เลือกช่วง/]
  },
  {
    name: "Thai Chuay Thai Plus payment",
    required: [/ไทยช่วยไทยพลัส/]
  },
  {
    name: "Loyalty",
    required: [/loyalty/i, /Loyalty points|แต้ม|คะแนน/]
  },
  {
    name: "Printer settings",
    required: [/printer-settings-view/i, /เครื่องพิมพ์/]
  },
  {
    name: "Slip logo/header/footer settings",
    required: [/print-logo-control/i, /slip-preview-header/i, /slip-preview-footer/i]
  }
];

const toPosix = (value) => value.replace(/\\/g, "/");
const rel = (filePath) => toPosix(path.relative(projectRoot, filePath));

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

    entries.push(data.toString("utf8"));
  }

  return entries;
};

const collectScopeText = (label, dir, extensions) => {
  const files = walkFiles(dir, extensions);
  return {
    label,
    files: files.length,
    text: files.map((file) => fs.readFileSync(file, "utf8")).join("\n")
  };
};

const scopes = [
  collectScopeText("src", "src", sourceExtensions),
  collectScopeText("dist", "dist", bundleExtensions),
  collectScopeText(
    "android-assets",
    "android/app/src/main/assets/public",
    bundleExtensions
  )
];

for (const apkPath of apkPaths) {
  const absolutePath = path.join(projectRoot, apkPath);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }
  scopes.push({
    label: `apk:${apkPath}`,
    files: 1,
    text: extractZipTextEntries(
      absolutePath,
      (entryName) =>
        entryName.startsWith("assets/public/") &&
        [".js", ".css", ".html"].includes(path.extname(entryName))
    ).join("\n")
  });
}

const failures = [];

for (const scope of scopes) {
  if (!scope.files || !scope.text.trim()) {
    failures.push(`${scope.label}: no release text found to scan`);
    continue;
  }

  for (const feature of features) {
    const missing = feature.required.filter((pattern) => !pattern.test(scope.text));
    if (missing.length) {
      failures.push(
        `${scope.label}: missing ${feature.name} marker(s): ${missing
          .map((pattern) => pattern.toString())
          .join(", ")}`
      );
    }
  }
}

if (failures.length) {
  console.error("Release feature guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

const apkScopes = scopes.filter((scope) => scope.label.startsWith("apk:")).length;
console.log(
  `Release feature guard passed: ${features.length} feature groups found across ${scopes.length} scopes (${apkScopes} APK scope(s)).`
);
