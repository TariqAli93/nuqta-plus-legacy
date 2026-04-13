/**
 * build-backend.js
 *
 * Builds a self-contained backend artifact in ./dist-backend that will later
 * be copied verbatim into the packaged Electron app at:
 *   <app>/resources/backend
 *
 * Pipeline:
 *   1. Clean ./dist-backend
 *   2. Copy ./backend sources (excluding node_modules)
 *   3. Install production dependencies via npm
 *   4. Rebuild better-sqlite3 (prebuild if available, else from source)
 *   5. Verify dist-backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node
 *   6. Verify better-sqlite3 actually loads under the bundled backend Node runtime
 *
 * On any failure this script exits with a non-zero code so the electron
 * packaging step is never reached with a broken backend.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = __dirname;
const SOURCE_DIR = path.join(ROOT, 'backend');
const DIST_DIR = path.join(ROOT, 'dist-backend');
const IS_WIN = process.platform === 'win32';
const BUNDLED_NODE = path.join(DIST_DIR, 'bin', IS_WIN ? 'node.exe' : 'node');

const BETTER_SQLITE_NATIVE = path.join(
  DIST_DIR,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);

const REQUIRED_SOURCE_FILES = [
  'src/server.js',
  'src/db.js',
  'package.json',
];

const log = (msg) => console.log(`[build-backend] ${msg}`);
const warn = (msg) => console.warn(`[build-backend] ⚠ ${msg}`);
const fail = (msg) => {
  console.error(`[build-backend] ❌ ${msg}`);
  process.exit(1);
};

function cleanDist() {
  if (fs.existsSync(DIST_DIR)) {
    log('Cleaning dist-backend...');
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

function copyBackendSource() {
  log('Copying backend source → dist-backend (excluding node_modules)...');
  if (!fs.existsSync(SOURCE_DIR)) {
    fail(`Backend source directory not found: ${SOURCE_DIR}`);
  }

  fs.cpSync(SOURCE_DIR, DIST_DIR, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      // Normalise path separators so Windows and POSIX behave the same.
      const rel = path.relative(SOURCE_DIR, src).split(path.sep);
      // Exclude the source backend's node_modules entirely — we install
      // a fresh production tree inside dist-backend below.
      if (rel[0] === 'node_modules') return false;
      // Exclude any lock files that might pollute the install.
      if (rel.length === 1 && rel[0] === 'package-lock.json') return false;
      if (rel.length === 1 && rel[0] === 'pnpm-lock.yaml') return false;
      // Exclude local envs.
      if (rel.length === 1 && rel[0].startsWith('.env')) return false;
      return true;
    },
  });

  // Sanity check the copy.
  for (const rel of REQUIRED_SOURCE_FILES) {
    const abs = path.join(DIST_DIR, rel);
    if (!fs.existsSync(abs)) fail(`Source copy missing required file: ${rel}`);
  }
}

function installProductionDeps() {
  log('Installing production dependencies inside dist-backend...');
  // We deliberately use npm (not pnpm) to get a flat, self-contained
  // node_modules tree with no workspace / symlink tricks — electron-builder
  // and the bundled Node runtime both need a plain tree.
  execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', {
    cwd: DIST_DIR,
    stdio: 'inherit',
    env: { ...process.env },
  });

  if (!fs.existsSync(path.join(DIST_DIR, 'node_modules'))) {
    fail('npm install completed but dist-backend/node_modules is missing');
  }
}

function rebuildBetterSqlite() {
  log('Rebuilding better-sqlite3...');
  try {
    // First try: fetch prebuild binaries for the current platform/ABI.
    execSync('npm rebuild better-sqlite3', {
      cwd: DIST_DIR,
      stdio: 'inherit',
    });
  } catch (err) {
    warn(`Prebuild rebuild failed (${err.message}); falling back to --build-from-source`);
    execSync('npm rebuild better-sqlite3 --build-from-source', {
      cwd: DIST_DIR,
      stdio: 'inherit',
    });
  }
}

function verifyNativeBinary() {
  if (!fs.existsSync(BETTER_SQLITE_NATIVE)) {
    fail(
      `Native binary missing: ${path.relative(ROOT, BETTER_SQLITE_NATIVE)}\n` +
        'better-sqlite3 did not produce a compiled .node file. ' +
        'Check that build tools (python, VS Build Tools on Windows) are installed.'
    );
  }
  log(`✓ native binary present: ${path.relative(ROOT, BETTER_SQLITE_NATIVE)}`);
}

function verifyLoadUnderBundledNode() {
  if (!fs.existsSync(BUNDLED_NODE)) {
    if (IS_WIN) {
      fail(
        `Bundled Node runtime missing: ${BUNDLED_NODE}\n` +
          'Make sure backend/bin/node.exe is committed to the source tree.'
      );
    }
    warn(
      `Bundled Node runtime not present on this platform (${process.platform}); ` +
        'skipping runtime load test. The Windows build must still be verified on Windows.'
    );
    return;
  }

  log('Verifying better-sqlite3 loads under the bundled backend Node...');
  try {
    // Run from dist-backend so node resolves ./node_modules/better-sqlite3.
    execSync(
      `"${BUNDLED_NODE}" -e "const d=require('better-sqlite3');const db=new d(':memory:');db.prepare('SELECT 1').get();db.close();console.log('[build-backend] better-sqlite3 loaded OK under bundled node')"`,
      {
        cwd: DIST_DIR,
        stdio: 'inherit',
      }
    );
  } catch (err) {
    fail(
      'better-sqlite3 failed to load under the bundled backend Node runtime. ' +
        'This is almost always an ABI mismatch: the version of node.exe in ' +
        'backend/bin/ does not match the Node major used to compile ' +
        'better-sqlite3. Rebuild better-sqlite3 against the bundled node, or ' +
        'replace backend/bin/node.exe with a matching major version.'
    );
  }
}

function main() {
  log(`Platform: ${process.platform}`);
  log(`Source:   ${SOURCE_DIR}`);
  log(`Dist:     ${DIST_DIR}`);

  cleanDist();
  copyBackendSource();
  installProductionDeps();
  rebuildBetterSqlite();
  verifyNativeBinary();
  verifyLoadUnderBundledNode();

  log('✅ Backend build complete — dist-backend is ready for packaging');
}

main();
