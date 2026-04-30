import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageFiles = [
  'package.json',
  'packages/cli/package.json',
  'packages/controller-extension/package.json',
];
const lockFile = 'package-lock.json';
const historyFile = 'extension-version-history.json';
const historyMarkdownFile = 'CHANGELOG.md';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const packages = packageFiles.map((relativePath) => ({
  relativePath,
  json: readJson(relativePath),
}));
const currentVersion = assertSynchronizedVersions(packages);
const nextVersion = resolveNextVersion(currentVersion, args.bump);
const today = args.date ?? new Date().toISOString().slice(0, 10);
const note = args.note ?? defaultNote(args.bump, currentVersion, nextVersion);
const history = readHistory(currentVersion, today);

if (history.history.some((entry) => entry.version === nextVersion)) {
  throw new Error(`Version ${nextVersion} already exists in ${historyFile}`);
}

const entry = {
  version: nextVersion,
  date: today,
  kind: inferKind(args.bump),
  previousVersion: currentVersion,
  notes: note,
};

if (args.dryRun) {
  console.log(`Would bump extension build version ${currentVersion} -> ${nextVersion}`);
  console.log(`Would update: ${packageFiles.join(', ')}, ${lockFile}, ${historyFile}, ${historyMarkdownFile}`);
  console.log(`History note: ${note}`);
  process.exit(0);
}

for (const pkg of packages) {
  pkg.json.version = nextVersion;
  writeJson(pkg.relativePath, pkg.json);
}

updatePackageLock(nextVersion);

history.currentVersion = nextVersion;
history.updatedAt = today;
history.history.push(entry);
writeJson(historyFile, history);
writeFileSync(join(root, historyMarkdownFile), renderHistoryMarkdown(history), 'utf-8');

console.log(`Bumped extension build version ${currentVersion} -> ${nextVersion}`);
console.log(`Recorded ${nextVersion} in ${historyFile} and ${historyMarkdownFile}`);

function parseArgs(argv) {
  const parsed = {
    bump: 'patch',
    date: npmConfigValue('date'),
    dryRun: npmConfigBoolean('dry_run') || npmConfigBoolean('dry-run'),
    help: false,
    note: npmConfigValue('note'),
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--date') {
      parsed.date = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--note') {
      parsed.note = requireValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length > 0) {
    parsed.bump = positionals[0];
  }
  if (positionals.length > 1 && !parsed.note) {
    parsed.note = positionals.slice(1).join(' ');
  }

  return parsed;
}

function npmConfigValue(name) {
  const value = process.env[`npm_config_${name}`];
  if (!value || value === 'true') return undefined;
  return value;
}

function npmConfigBoolean(name) {
  return process.env[`npm_config_${name}`] === 'true';
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: npm run version:extension -- [patch|minor|major|x.y.z] [-- --note "message"] [--dry-run]

Examples:
  npm run version:extension -- patch --note "Controller install resolver fix"
  npm run version:extension -- minor --note "New live testing workflow"
  npm run version:extension -- 0.2.0 --note "Release candidate baseline"
  npm run version:extension -- patch --dry-run
`);
}

function assertSynchronizedVersions(packageEntries) {
  const versions = new Set(packageEntries.map((entry) => entry.json.version));
  if (versions.size !== 1) {
    const details = packageEntries
      .map((entry) => `${entry.relativePath}: ${entry.json.version}`)
      .join('\n  ');
    throw new Error(`Package versions are not synchronized:\n  ${details}`);
  }
  return packageEntries[0].json.version;
}

function resolveNextVersion(currentVersion, bump) {
  if (isSemver(bump)) {
    assertGreaterVersion(currentVersion, bump);
    return bump;
  }

  const current = parseStableSemver(currentVersion);
  if (bump === 'major') return `${current.major + 1}.0.0`;
  if (bump === 'minor') return `${current.major}.${current.minor + 1}.0`;
  if (bump === 'patch') return `${current.major}.${current.minor}.${current.patch + 1}`;
  throw new Error(`Expected bump to be patch, minor, major, or x.y.z. Received: ${bump}`);
}

function inferKind(bump) {
  return ['patch', 'minor', 'major'].includes(bump) ? bump : 'explicit';
}

function defaultNote(bump, currentVersion, nextVersion) {
  return `${inferKind(bump)} version bump from ${currentVersion} to ${nextVersion}`;
}

function parseStableSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Auto-increment requires a stable x.y.z version. Current version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isSemver(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function assertGreaterVersion(currentVersion, nextVersion) {
  const current = parseStableSemver(stripPrerelease(currentVersion));
  const next = parseStableSemver(stripPrerelease(nextVersion));
  if (
    next.major < current.major ||
    (next.major === current.major && next.minor < current.minor) ||
    (next.major === current.major && next.minor === current.minor && next.patch <= current.patch)
  ) {
    throw new Error(`Next version must be greater than current version (${currentVersion}). Received: ${nextVersion}`);
  }
}

function stripPrerelease(version) {
  return version.split(/[+-]/, 1)[0];
}

function readHistory(currentVersion, today) {
  if (!existsSync(join(root, historyFile))) {
    return {
      schemaVersion: 1,
      currentVersion,
      updatedAt: today,
      packages: packageFiles,
      history: [baselineEntry(currentVersion, today)],
    };
  }

  const history = readJson(historyFile);
  if (!Array.isArray(history.history)) {
    throw new Error(`${historyFile} must contain a history array`);
  }
  if (!history.history.some((entry) => entry.version === currentVersion)) {
    history.history.push(baselineEntry(currentVersion, today));
  }
  return history;
}

function baselineEntry(version, today) {
  return {
    version,
    date: today,
    kind: 'baseline',
    notes: 'Baseline before automated extension build versioning.',
  };
}

function updatePackageLock(nextVersion) {
  if (!existsSync(join(root, lockFile))) return;
  const lock = readJson(lockFile);
  lock.version = nextVersion;
  const paths = ['', 'packages/cli', 'packages/controller-extension'];
  for (const packagePath of paths) {
    if (lock.packages?.[packagePath]) {
      lock.packages[packagePath].version = nextVersion;
    }
  }
  writeJson(lockFile, lock);
}

function renderHistoryMarkdown(history) {
  const rows = [...history.history]
    .reverse()
    .map((entry) => `| ${entry.version} | ${entry.date} | ${entry.kind} | ${escapeMarkdownTable(entry.notes)} |`)
    .join('\n');

  return `# Changelog

This changelog records versions for the build artifacts produced by this repository:
the CLI package, the bundled controller extension VSIX, and release artifacts.

Use \`npm run version:extension -- <patch|minor|major|x.y.z> --note "summary"\`
to update versions. The command updates package manifests, package-lock metadata,
\`${historyFile}\`, and this file together.

| Version | Date | Kind | Notes |
| ------- | ---- | ---- | ----- |
${rows}
`;
}

function escapeMarkdownTable(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf-8'));
}

function writeJson(relativePath, json) {
  writeFileSync(join(root, relativePath), `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
}
