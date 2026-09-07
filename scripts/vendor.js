#!/usr/bin/env node
/**
 * Copy third-party renderers out of node_modules and into public/vendor.
 *
 * The problem this solves: a library pasted into `public/` never gets updated.
 * Nobody remembers it is there, security fixes never land, and two years later
 * the app ships a renderer with a known advisory. So npm stays the source of
 * truth — it already knows versions, integrity, and `npm audit` — and this
 * script only copies the built files each library ships.
 *
 * That keeps the two properties that matter: no bundler and no build step for
 * the user, and `npm update` is a real update path rather than a hope.
 *
 * Runs on postinstall. Anything missing is skipped, not fatal: these are
 * optional dependencies, and Reflect has to work without them — a `mermaid`
 * block simply stays a code block.
 *
 * We take the classic single-file build, not the ES module entry, and the
 * reason is not taste. Third-party renderers run inside the artifact sandbox,
 * which has an opaque origin, and **an opaque-origin document cannot import an
 * ES module over the network** — the fetch fails regardless of CORS headers or
 * CSP. Measured both ways in a browser: a classic `<script src>` from this
 * origin loads inside the sandbox; `import()` of the same origin fails with
 * "Failed to fetch dynamically imported module", while the identical import
 * succeeds in a non-sandboxed frame.
 *
 * So: one self-contained classic file, no chunks to fetch, and the page finds
 * the library's global by looking rather than by hardcoding an internal name.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'public', 'vendor');

/** Source maps are for the library's authors, not for us. */
const wanted = (name) =>
  /\.(mjs|js|css|woff2)$/.test(name) && !name.endsWith('.min.js.map');

const LIBRARIES = [
  {
    name: 'mermaid',
    dir: 'mermaid',
    entry: 'dist/mermaid.min.js',
    why: 'diagrams — flowcharts, sequence, state, gantt',
  },
  {
    // Math renders inline in the prose, so this one is loaded by the app rather
    // than inlined into a frame — see the note in index.html about why KaTeX is
    // the exception to the sandbox rule.
    name: 'katex',
    dir: 'katex',
    entry: 'dist/katex.min.js',
    trees: [
      { from: 'dist/fonts', to: 'fonts' },
      { from: 'dist', to: '.', only: ['katex.min.css'] },
    ],
    why: 'mathematics — $inline$ and $display$',
  },
  {
    // CodeMirror is not one file, it is two dozen small ES modules that import
    // each other by bare name. Bundlers exist to resolve those names; browsers
    // resolve them with an import map, which is a JSON object rather than a
    // build step. So we copy each package's ES entry and write the map.
    //
    // This one runs in the app, not the sandbox, so modules are fine here — the
    // no-subresources rule only binds the artifact frame.
    name: 'codemirror',
    dir: 'cm',
    graph: ['codemirror', '@codemirror/lang-javascript', '@codemirror/lang-html', '@codemirror/lang-json'],
    why: 'the code editor in the artifact pane',
  },
];

const exists = (p) => fsp.access(p).then(() => true).catch(() => false);

async function copyTree(from, to, only = null) {
  const entries = await fsp.readdir(from, { withFileTypes: true });
  let bytes = 0;
  let files = 0;
  await fsp.mkdir(to, { recursive: true });

  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (only) continue; // a named-file copy does not mean the whole subtree
      const nested = await copyTree(source, target);
      bytes += nested.bytes;
      files += nested.files;
    } else if (wanted(entry.name) && (!only || only.includes(entry.name))) {
      const data = await fsp.readFile(source);
      await fsp.writeFile(target, data);
      bytes += data.length;
      files += 1;
    }
  }
  return { bytes, files };
}

/** A package's ES entry, however it chooses to declare it. */
function esEntry(meta) {
  const exported = meta.exports?.['.'];
  const chosen =
    (typeof exported === 'string' && exported) ||
    exported?.import?.default ||
    exported?.import ||
    exported?.default ||
    meta.module ||
    meta.main ||
    'index.js';
  return String(chosen).replace(/^\.\//, '');
}

/**
 * Copy a package and everything it imports, and build the import map that lets
 * a browser resolve the bare names between them.
 */
async function vendorGraph(lib) {
  const roots = lib.graph;
  const outDir = path.join(VENDOR, lib.dir);
  await fsp.rm(outDir, { recursive: true, force: true });

  const imports = {};
  const seen = new Set();
  let bytes = 0;
  let version = '';
  let license = '';

  async function walk(name) {
    if (seen.has(name)) return;
    const pkgDir = path.join(ROOT, 'node_modules', name);
    if (!(await exists(path.join(pkgDir, 'package.json')))) return;
    seen.add(name);

    const meta = JSON.parse(await fsp.readFile(path.join(pkgDir, 'package.json'), 'utf8'));
    const source = path.join(pkgDir, esEntry(meta));
    if (!(await exists(source))) return;

    const target = path.join(outDir, name, 'index.js');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const code = await fsp.readFile(source);
    await fsp.writeFile(target, code);

    bytes += code.length;
    imports[name] = `/vendor/${lib.dir}/${name}/index.js`;
    if (name === lib.name) {
      version = meta.version;
      license = meta.license || 'unknown';
    }

    for (const dep of Object.keys(meta.dependencies || {})) await walk(dep);
  }

  for (const root of roots) await walk(root);
  if (!imports[lib.name]) return null;

  return {
    name: lib.name,
    version,
    license,
    url: imports[lib.name],
    type: 'importmap',
    // Handed to the page as-is; the browser does the resolving.
    importMap: { imports },
    why: lib.why,
    files: seen.size,
    bytes,
    sha256: crypto.createHash('sha256').update(JSON.stringify(imports)).digest('hex').slice(0, 16),
  };
}

async function vendor(lib) {
  if (lib.graph) return vendorGraph(lib);
  const pkgDir = path.join(ROOT, 'node_modules', lib.name);
  const entry = path.join(pkgDir, lib.entry);
  if (!(await exists(entry))) return null;

  const meta = JSON.parse(await fsp.readFile(path.join(pkgDir, 'package.json'), 'utf8'));
  const outDir = path.join(VENDOR, lib.dir);
  await fsp.rm(outDir, { recursive: true, force: true }); // no leftovers from an older version
  await fsp.mkdir(outDir, { recursive: true });

  const code = await fsp.readFile(entry);
  const file = path.basename(lib.entry);
  await fsp.writeFile(path.join(outDir, file), code);

  let bytes = code.length;
  let files = 1;
  for (const tree of lib.trees || []) {
    const source = path.join(pkgDir, tree.from);
    if (!(await exists(source))) continue;
    const copied = await copyTree(source, path.join(outDir, tree.to), tree.only);
    bytes += copied.bytes;
    files += copied.files;
  }

  return {
    name: lib.name,
    version: meta.version,
    license: meta.license || 'unknown',
    // What the page imports. Everything else is reached from here.
    url: `/vendor/${lib.dir}/${file}`,
    type: 'classic',
    why: lib.why,
    files,
    bytes,
    // Lets `reflect doctor` tell a stale copy from a current one offline.
    sha256: crypto.createHash('sha256').update(code).digest('hex').slice(0, 16),
  };
}

const found = [];
for (const lib of LIBRARIES) {
  const entry = await vendor(lib);
  if (entry) found.push(entry);
}

// No timestamp: the manifest should change only when a library does, so that a
// diff means something.
await fsp.mkdir(VENDOR, { recursive: true });
await fsp.writeFile(path.join(VENDOR, 'manifest.json'), `${JSON.stringify({ libraries: found }, null, 2)}\n`);

if (found.length) {
  for (const l of found) {
    console.log(
      `  vendored ${l.name} ${l.version} — ${l.files} files, ${(l.bytes / 1024 / 1024).toFixed(1)}MB, ${l.license}`
    );
  }
} else {
  console.log('  no optional renderers installed — mermaid blocks will stay code blocks');
}
