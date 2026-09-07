#!/usr/bin/env node
/**
 * The command line, which for a local-first app is the install experience.
 *
 * Four things a person actually needs: start it, check why it is not working,
 * bring their history in, and find out where their files live. Everything else
 * belongs in the app.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const HELP = `
${c.bold('reflect')} — a local-first assistant whose memory is a folder of files you own

  ${c.bold('reflect')}                  start it, and open it in your browser
  ${c.bold('reflect doctor')}           check that everything it needs is present
  ${c.bold('reflect import <file>')}    bring in a ChatGPT export (.zip or conversations.json)
  ${c.bold('reflect where')}            print where your memory lives

Options
  --home <path>     use a different memory folder    ${c.dim('(default ~/.reflect)')}
  --port <number>   serve on a different port        ${c.dim('(default 3040)')}
  --no-open         do not open a browser
  --dry-run         for import: report, write nothing
  --limit <n>       for import: stop after n conversations
`;

function parseArgs(argv) {
  const args = { _: [], open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--no-open') args.open = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--home') args.home = argv[++i];
    else if (a === '--port') args.port = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a.startsWith('--')) args.unknown = a;
    else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.home) process.env.REFLECT_HOME = path.resolve(args.home);
if (args.port) process.env.PORT = String(args.port);

if (args.unknown) {
  console.error(c.red(`Unknown option ${args.unknown}`));
  console.log(HELP);
  process.exit(1);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const { homePath, DEFAULT_CONFIG, PORT } = await import('../src/config.js');
const command = args._[0] || 'start';

// ─────────────────────────────────────────────────────────────────── where

if (command === 'where') {
  console.log(homePath());
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────── doctor

if (command === 'doctor') {
  console.log(c.bold('\nreflect doctor\n'));
  let fatal = 0;

  const line = (ok, label, detail) => {
    const mark = ok === true ? c.green('✓') : ok === 'warn' ? c.yellow('!') : c.red('✗');
    console.log(`  ${mark} ${label}${detail ? c.dim(`  ${detail}`) : ''}`);
    if (ok === false) fatal++;
  };

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20, `Node ${process.versions.node}`, major >= 20 ? '' : 'Reflect needs Node 20 or newer');

  const home = homePath();
  const homeExists = await fsp.stat(home).then(() => true).catch(() => false);
  line(true, `memory folder ${home}`, homeExists ? '' : 'will be created on first run');

  const url = process.env.OLLAMA_URL || DEFAULT_CONFIG.ollamaUrl;
  let models = [];
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    models = data.models || [];
    line(true, `Ollama at ${url}`, `${models.length} models`);
  } catch (err) {
    line(false, `Ollama at ${url}`, `not reachable — start Ollama, then run this again`);
  }

  if (models.length) {
    const chat = models.filter(
      (m) => (m.capabilities || []).includes('completion') && !(m.capabilities || []).includes('embedding')
    );
    const embed = models.filter((m) => (m.capabilities || []).includes('embedding'));

    line(chat.length > 0, `chat model`, chat.length ? chat[0].name : 'none — try: ollama pull qwen3:4b');
    line(
      embed.length > 0 ? true : 'warn',
      `embedding model`,
      embed.length
        ? embed[0].name
        : 'none — recall will use keywords only. try: ollama pull nomic-embed-text'
    );
  }

  // ── vendored renderers ────────────────────────────────────────────────
  // The update problem, made visible: a library copied into public/ is one
  // nobody remembers to update. Doctor is where it gets remembered.
  const manifestPath = path.join(ROOT, 'public', 'vendor', 'manifest.json');
  const manifest = await fsp
    .readFile(manifestPath, 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => null);

  const libs = manifest?.libraries || [];
  if (!libs.length) {
    line('warn', 'extra renderers', 'none installed — diagrams stay code blocks. try: npm install mermaid');
  } else {
    for (const lib of libs) {
      line(true, `${lib.name} ${lib.version}`, `${(lib.bytes / 1024 / 1024).toFixed(1)}MB · ${lib.license} · ${lib.why}`);
    }

    // Only asks the registry if it can be reached quickly; being offline is a
    // normal state for this app, not a failure worth a red mark.
    const outdated = await new Promise((resolve) => {
      const proc = spawn('npm', ['outdated', '--json', ...libs.map((l) => l.name)], { cwd: ROOT });
      let out = '';
      const timer = setTimeout(() => { proc.kill(); resolve(null); }, 8000);
      proc.stdout.on('data', (d) => { out += d; });
      proc.on('error', () => { clearTimeout(timer); resolve(null); });
      proc.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out || '{}')); } catch { resolve(null); } });
    });

    if (outdated === null) {
      line('warn', 'update check', 'could not reach npm — skipped');
    } else {
      const stale = Object.entries(outdated);
      if (!stale.length) line(true, 'renderers are current', '');
      else
        for (const [name, info] of stale)
          line('warn', `${name} is behind`, `${info.current} → ${info.latest}. run: npm run update:extras`);
    }
  }

  console.log(
    fatal === 0
      ? c.green('\n  ready\n')
      : c.red(`\n  ${fatal} problem${fatal > 1 ? 's' : ''} to fix first\n`)
  );
  process.exit(fatal === 0 ? 0 : 1);
}

// ────────────────────────────────────────────────────────────────── import

if (command === 'import') {
  const file = args._[1];
  if (!file) {
    console.error(c.red('\n  Which file? Try: reflect import ~/Downloads/chatgpt-export.zip\n'));
    process.exit(1);
  }

  const { scaffold } = await import('../src/store/FileStore.js');
  const { importExport } = await import('../src/import/ChatGPT.js');
  await scaffold();

  console.log(c.dim(`\n  reading ${file}`));
  try {
    let lastLine = 0;
    const summary = await importExport(path.resolve(file), {
      dryRun: args.dryRun,
      limit: Number.isFinite(args.limit) ? args.limit : Infinity,
      onProgress: (p) => {
        if (p.imported - lastLine >= 25) {
          lastLine = p.imported;
          process.stdout.write(c.dim(`\r  ${p.imported} conversations…`));
        }
      },
    });

    process.stdout.write('\r\x1b[K');
    console.log(
      `  ${c.green('✓')} ${args.dryRun ? 'would import' : 'imported'} ${summary.imported} conversations` +
        c.dim(` (${summary.turns} turns)`)
    );
    if (summary.skipped) console.log(c.dim(`    ${summary.skipped} already imported`));
    if (summary.empty) console.log(c.dim(`    ${summary.empty} had nothing in them`));
    console.log(c.dim(`\n  they are in ${path.join(homePath(), 'conversations')}\n`));
  } catch (err) {
    console.error(c.red(`\n  ${err.message}\n`));
    process.exit(1);
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────── start

if (command === 'start') {
  const port = Number(process.env.PORT || PORT);
  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: process.env,
    stdio: 'inherit',
  });

  if (args.open) {
    // Give it a moment to bind, then hand the user the app rather than a URL.
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    setTimeout(() => {
      spawn(opener, [`http://localhost:${port}`], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    }, 1200);
  }

  const stop = () => {
    server.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('exit', (code) => process.exit(code ?? 0));
} else {
  console.error(c.red(`\n  Unknown command "${command}"`));
  console.log(HELP);
  process.exit(1);
}
