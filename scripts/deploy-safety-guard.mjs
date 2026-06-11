#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ID = 'edencafe-d9095';
const DEFAULT_SITE = 'edencafe-d9095';
const ROOT_NAME = 'Eden Cafe Website';
const MINIMAL_DIR = 'firebase-default-hosting-minimal';
const ROLLBACK_CHANNEL_PREFIX = 'rollback-before-minimal';

function parseArgs(argv) {
  const args = {
    workflow: '',
    command: '',
    cwd: process.cwd(),
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workflow') {
      args.workflow = argv[++i] || '';
    } else if (arg === '--command') {
      args.command = argv[++i] || '';
    } else if (arg === '--cwd') {
      args.cwd = argv[++i] || '';
    } else if (arg === '--json') {
      args.json = true;
    } else if (!arg.startsWith('--')) {
      args.command = [args.command, arg].filter(Boolean).join(' ');
    }
  }

  return args;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function findRepoRoot(startDir) {
  let current = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    if (path.basename(current) === ROOT_NAME && exists(path.join(current, 'firebase.json'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

function commandIncludes(command, pattern) {
  return pattern.test(command);
}

function onlyArg(command) {
  const match = command.match(/--only\s+("[^"]+"|'[^']+'|[^\s]+)/);
  if (!match) return '';
  return match[1].replace(/^['"]|['"]$/g, '');
}

function hasHostingInOnly(command) {
  return onlyArg(command).split(',').map((part) => part.trim()).some((part) => part === 'hosting' || part.startsWith('hosting:'));
}

function hasOnlyArg(command) {
  return /--only\s+/.test(command);
}

function inspectFirebaseConfig(configPath) {
  const config = readJson(configPath);
  const hosting = config?.hosting;
  return {
    exists: Boolean(config),
    hostingPublic: hosting?.public || null,
    hostingSite: hosting?.site || null,
    hasHosting: Boolean(hosting),
    hasRedirects: Array.isArray(hosting?.redirects) && hosting.redirects.length > 0,
    redirectsCount: Array.isArray(hosting?.redirects) ? hosting.redirects.length : 0,
    hasRewrites: Array.isArray(hosting?.rewrites) && hosting.rewrites.length > 0,
    rewritesCount: Array.isArray(hosting?.rewrites) ? hosting.rewrites.length : 0,
    headersSources: Array.isArray(hosting?.headers) ? hosting.headers.map((entry) => entry.source || entry.glob || '') : [],
  };
}

function inspectMinimalPackage(repoRoot) {
  const packageDir = path.join(repoRoot, MINIMAL_DIR);
  const publicDir = path.join(packageDir, 'public');
  const firebaseConfig = inspectFirebaseConfig(path.join(packageDir, 'firebase.json'));
  const publicFiles = exists(publicDir)
    ? fs.readdirSync(publicDir, { recursive: true }).map((file) => normalizeSlashes(file)).sort()
    : [];
  const indexHtml = exists(path.join(publicDir, 'index.html')) ? fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8') : '';
  const notFoundHtml = exists(path.join(publicDir, '404.html')) ? fs.readFileSync(path.join(publicDir, '404.html'), 'utf8') : '';
  const robotsTxt = exists(path.join(publicDir, 'robots.txt')) ? fs.readFileSync(path.join(publicDir, 'robots.txt'), 'utf8') : '';

  return {
    packageDir,
    firebaseConfig,
    publicFiles,
    hasPublicAuthHelperDir: publicFiles.some((file) => file.startsWith('__/')),
    indexHasNoindex: /<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(indexHtml),
    notFoundHasNoindex: /<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(notFoundHtml),
    robotsDisallowAll: /User-agent:\s*\*\s*\r?\nDisallow:\s*\//i.test(robotsTxt),
    hasCatchAllHeader: firebaseConfig.headersSources.some((source) => source === '**' || source === '/**' || source === '**/*'),
  };
}

function validateSpaceship(command) {
  const issues = [];
  const warnings = [];

  if (commandIncludes(command, /\bfirebase(\.cmd)?\b/i)) {
    issues.push('Spaceship frontend upload must not use Firebase CLI.');
  }

  if (/\bdeploy\b/i.test(command)) {
    warnings.push('Use exact upload manifest/package only; do not upload broad directories.');
  }

  return { issues, warnings };
}

function validateFirebaseMinimal({ command, cwd, repoRoot }) {
  const issues = [];
  const warnings = [];
  const minimal = inspectMinimalPackage(repoRoot);
  const cwdNormalized = normalizeSlashes(path.resolve(cwd));
  const minimalDirNormalized = normalizeSlashes(path.resolve(minimal.packageDir));

  if (cwdNormalized !== minimalDirNormalized) {
    issues.push(`Firebase minimal restore must run from ${minimal.packageDir}.`);
  }

  if (!commandIncludes(command, /\bfirebase(\.cmd)?\s+deploy\b/i)) {
    issues.push('Firebase minimal restore command must be a firebase deploy command.');
  }

  if (!/--project\s+edencafe-d9095\b/.test(command)) {
    issues.push(`Command must specify --project ${PROJECT_ID}.`);
  }

  if (!/--only\s+hosting\b/.test(command)) {
    issues.push('Command must specify --only hosting.');
  }

  if (!/--config\s+firebase\.json\b/.test(command)) {
    issues.push('Command must specify --config firebase.json from the minimal folder.');
  }

  if (minimal.firebaseConfig.hostingSite !== DEFAULT_SITE) {
    issues.push(`Minimal firebase.json must target hosting.site ${DEFAULT_SITE}.`);
  }

  if (minimal.firebaseConfig.hostingPublic !== 'public') {
    issues.push('Minimal firebase.json must use hosting.public "public".');
  }

  if (minimal.firebaseConfig.hasRedirects || minimal.firebaseConfig.hasRewrites) {
    issues.push('Minimal firebase.json must not contain redirects or rewrites.');
  }

  if (minimal.hasPublicAuthHelperDir) {
    issues.push('Minimal public directory must not contain public/__/ because it can affect Firebase reserved auth paths.');
  }

  if (!minimal.indexHasNoindex || !minimal.notFoundHasNoindex || !minimal.robotsDisallowAll) {
    issues.push('Minimal public files must include noindex HTML pages and robots.txt Disallow: /.');
  }

  if (minimal.hasCatchAllHeader) {
    issues.push('Minimal headers must not use catch-all sources such as ** because they can affect /__/auth/*.');
  }

  if (!/--message\s+/.test(command)) {
    warnings.push('Add --message so release history explains why the default domains changed.');
  }

  warnings.push(`Before deploy, clone current live to a rollback channel such as ${ROLLBACK_CHANNEL_PREFIX}-restore-YYYYMMDD.`);
  return { issues, warnings, minimal };
}

function validateFirebaseBackend({ command, cwd, repoRoot }) {
  const issues = [];
  const warnings = [];
  const rootConfig = inspectFirebaseConfig(path.join(repoRoot, 'firebase.json'));
  const cwdNormalized = normalizeSlashes(path.resolve(cwd));
  const repoRootNormalized = normalizeSlashes(path.resolve(repoRoot));

  if (cwdNormalized !== repoRootNormalized) {
    warnings.push('Backend deploys normally run from repo root so functions/ and firestore.rules resolve predictably.');
  }

  if (!commandIncludes(command, /\bfirebase(\.cmd)?\s+deploy\b/i)) {
    issues.push('Firebase backend/rules workflow must be a firebase deploy command.');
  }

  if (!/--project\s+edencafe-d9095\b/.test(command)) {
    issues.push(`Command must specify --project ${PROJECT_ID}.`);
  }

  if (!hasOnlyArg(command)) {
    issues.push('Command must include --only to prevent accidental Hosting deploy.');
  }

  if (hasHostingInOnly(command)) {
    issues.push('Backend/rules deploy command must not include hosting in --only.');
  }

  if (!/(--only\s+[^ ]*(functions|firestore:rules|firestore|storage:rules|storage)[^ ]*)/.test(command)) {
    warnings.push('Expected --only functions and/or firestore:rules/storage:rules. Verify the exact backend target.');
  }

  if (rootConfig.hostingPublic === '.') {
    warnings.push('Root firebase.json uses hosting.public "."; never run a root deploy that includes hosting.');
  }

  return { issues, warnings, rootConfig };
}

function validateRootHostingPredeploy({ cwd, repoRoot }) {
  const issues = [];
  const warnings = [];
  const rootConfig = inspectFirebaseConfig(path.join(repoRoot, 'firebase.json'));
  const cwdNormalized = normalizeSlashes(path.resolve(cwd));
  const repoRootNormalized = normalizeSlashes(path.resolve(repoRoot));

  if (cwdNormalized !== repoRootNormalized) {
    warnings.push('Root Hosting predeploy guard was not run from the repo root.');
  }

  if (rootConfig.hostingPublic === '.') {
    issues.push(
      'BLOCKED: Firebase Hosting deploy from repo root is disabled because root firebase.json has hosting.public ".".'
    );
    issues.push(
      `Use ${path.join(repoRoot, MINIMAL_DIR)} for Firebase default minimal/noindex Hosting, or exact Spaceship upload for edencafe.co.`
    );
  }

  return { issues, warnings, rootConfig };
}

function validateRootHostingHazard({ command, cwd, repoRoot }) {
  const issues = [];
  const rootConfig = inspectFirebaseConfig(path.join(repoRoot, 'firebase.json'));
  const cwdIsRepoRoot = normalizeSlashes(path.resolve(cwd)) === normalizeSlashes(path.resolve(repoRoot));

  if (cwdIsRepoRoot && rootConfig.hostingPublic === '.' && commandIncludes(command, /\bfirebase(\.cmd)?\s+deploy\b/i)) {
    const deploysAll = !hasOnlyArg(command) && !/--except\s+[^ ]*hosting/.test(command);
    const deploysHosting = hasHostingInOnly(command);
    if (deploysAll || deploysHosting) {
      issues.push('BLOCKED: root firebase.json has hosting.public "." and this command would deploy Hosting from repo root.');
    }
  }

  return { issues, rootConfig };
}

const args = parseArgs(process.argv.slice(2));
const command = args.command.trim();
const cwd = path.resolve(args.cwd || process.cwd());
const repoRoot = findRepoRoot(cwd);
const workflow = args.workflow || 'detect';

const result = {
  ok: true,
  workflow,
  cwd,
  repoRoot,
  command,
  issues: [],
  warnings: [],
  inspected: {},
};

if (!command) {
  result.issues.push('Missing --command. Pass the exact command you intend to run.');
}

const rootHazard = validateRootHostingHazard({ command, cwd, repoRoot });
result.issues.push(...rootHazard.issues);
result.inspected.rootFirebase = rootHazard.rootConfig;

if (workflow === 'spaceship') {
  const validation = validateSpaceship(command);
  result.issues.push(...validation.issues);
  result.warnings.push(...validation.warnings);
} else if (workflow === 'firebase-minimal') {
  const validation = validateFirebaseMinimal({ command, cwd, repoRoot });
  result.issues.push(...validation.issues);
  result.warnings.push(...validation.warnings);
  result.inspected.minimalPackage = validation.minimal;
} else if (workflow === 'firebase-backend') {
  const validation = validateFirebaseBackend({ command, cwd, repoRoot });
  result.issues.push(...validation.issues);
  result.warnings.push(...validation.warnings);
} else if (workflow === 'root-hosting-predeploy') {
  const validation = validateRootHostingPredeploy({ cwd, repoRoot });
  result.issues.push(...validation.issues);
  result.warnings.push(...validation.warnings);
  result.inspected.rootFirebase = validation.rootConfig;
} else if (workflow !== 'detect') {
  result.issues.push('Unknown --workflow. Use spaceship, firebase-minimal, firebase-backend, root-hosting-predeploy, or detect.');
}

result.ok = result.issues.length === 0;

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Deploy safety guard: ${result.ok ? 'PASS' : 'BLOCKED'}`);
  if (result.issues.length) {
    console.log('\nIssues:');
    result.issues.forEach((issue) => console.log(`- ${issue}`));
  }
  if (result.warnings.length) {
    console.log('\nWarnings:');
    result.warnings.forEach((warning) => console.log(`- ${warning}`));
  }
}

process.exit(result.ok ? 0 : 2);
