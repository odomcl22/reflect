/**
 * The HTTP surface.
 *
 * Split out from `server.js` so the routes can be exercised without binding the
 * real port: the tests build an app against a temp `REFLECT_HOME`, listen on 0,
 * and talk to it over `fetch`. `server.js` is then only the boot script.
 */

import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { paths, homePath, PORT, HOST } from './config.js';
import { scaffold, loadConfig, saveConfig, readText, writeText } from './store/FileStore.js';
import * as Conversations from './store/ConversationStore.js';
import { useInference, inference } from './core/Inference.js';
import { adapterFor, detect } from './runtimes/Providers.js';
import { pickDefaultModel, canExtract } from './core/ModelChoice.js';
import { PROVIDERS as SearchProviders, search as runSearch } from './web/Search.js';
import { continueElsewhere, branchFrom } from './context/Continue.js';
import { notice, dismiss as dismissNotice } from './reflect/Notice.js';
import { todayPage } from './reflect/Today.js';
import { open as openPromises, settle as settlePromise } from './reflect/Promises.js';
import { summary as ledgerSummary, entries as ledgerEntries } from './reflect/Ledger.js';
import * as Deliver from './deliver/Deliver.js';
import { shouldSleep, sleep as sleepPass } from './reflect/Sleep.js';
import { sources as receiptSources } from './reflect/Receipts.js';
import { versions as listVersions, readVersion, restore as restoreVersion, snapshot as takeVersion } from './reflect/Versions.js';
import { yearbook, yearsAvailable } from './documents/Yearbook.js';
import { markdownToPdf } from './documents/Pdf.js';
import { searchModels, listQuants } from './runtimes/Catalogue.js';
import { createChatHandler } from './api/ChatController.js';
import { loadSoul } from './modes/Soul.js';
import { DEPTHS, windowFor, HARD_CAP } from './context/ContextBudget.js';
import * as Memory from './store/MemoryFiles.js';
import { recall, getIndex } from './recall/Recall.js';
import { readMemoryPath, allTools } from './reflect/MemoryTools.js';
import { searchHistory, timeline } from './recall/History.js';
import { LEVELS, LEVEL_NAMES, normalizeLevel } from './core/Thinking.js';
import { join } from './core/Storage.js';
import { importExport } from './import/ChatGPT.js';
import * as Skills from './skills/Skills.js';
import { installStarterSkills } from './skills/Starter.js';
import * as Grants from './grants/Grants.js';
import * as Tasks from './tasks/Tasks.js';
import { runTask, startScheduler } from './tasks/Scheduler.js';
import * as Folders from './grants/Folders.js';
import * as Attachments from './attachments/Attachments.js';
import * as Whisper from './speech/Whisper.js';
import * as Assistants from './assistants/Assistants.js';
import { checkInstance } from './web/Safety.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const VERSION = '2.0.0-m9';

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Only the person at this machine may talk to this server.
 *
 * Reflect has no authentication, on the premise that the only thing that can
 * reach it is the browser of the person sitting here. Binding to loopback is
 * half of enforcing that premise. This is the other half, and until M10 it did
 * not exist: the app ran `cors()` with no options, which sets
 * `Access-Control-Allow-Origin: *`.
 *
 * That is worse than it sounds. Loopback does not protect against the user's
 * own browser — any page they happened to have open could `fetch` the API and
 * *read the response*, because the wildcard told the browser that was allowed.
 * A single visit to a hostile page while Reflect was running was enough to read
 * USER.md, list every connected folder, and write files into them. There was no
 * cross-origin case to support in the first place: the client is served by this
 * same app, from this same origin.
 *
 * Two checks, because they stop different attacks:
 *
 *  - **Origin** stops an ordinary cross-site request. With no wildcard the
 *    browser already refuses to hand over the response, but rejecting outright
 *    also stops the request having a side effect on the way in.
 *  - **Host** stops DNS rebinding, where a name the attacker controls is
 *    re-pointed at 127.0.0.1 so their page becomes same-origin and the Origin
 *    check passes honestly. The request still carries their hostname, and a
 *    server that only answers to `localhost` is not there to be rebound to.
 *
 * Someone who sets `REFLECT_HOST` is deliberately serving beyond this machine
 * and has said so, so the Host check steps aside for them. The Origin check
 * does not: serving your own network is not the same as inviting every website
 * your family visits.
 */
export function localOnly(req, res, next) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (HOST === '127.0.0.1' && !LOOPBACK.has(host)) {
    return res.status(403).json({ error: 'Reflect only answers on localhost.' });
  }

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return res.status(403).json({ error: 'Reflect does not answer other websites.' });
    }
  }

  next();
}

/**
 * Build the app. Scaffolds the home folder and resolves a default model, so
 * whoever calls this gets something that works on a first run.
 *
 * @returns {Promise<{app: import('express').Express, home: object, config: object}>}
 */
export async function createApp() {
  const app = express();
  app.use(localOnly);
  app.use(express.json({ limit: '4mb' }));
  app.use(express.static(path.join(here, '..', 'public')));

  const home = await scaffold();
  let config = await loadConfig();

  // Whatever runs the models. A saved choice is obeyed; otherwise this falls
  // back to Ollama at its usual address, which is what every install before M9
  // was doing implicitly.
  //
  // Detection deliberately does *not* happen here. Probing at boot and adopting
  // whatever answers would mean a machine that happens to have Ollama running
  // silently stops using the runtime holding all the user's models. Detection
  // belongs to `/api/runtimes`, where a person is looking at the result.
  let runtime = config.runtime
    ? adapterFor(config.runtime)
    : await inference({ baseUrl: config.ollamaUrl });
  if (config.runtime) useInference(runtime);

  // Pick a default model on first run: the largest that fits in memory, which
  // is not the same as the largest. See ModelChoice — a model that has to be
  // paged in makes a first run look broken.
  //
  // Also re-pick when the saved model is not there any more. A model name only
  // means anything to the runtime that listed it, so switching runtimes leaves
  // the setting pointing at nothing — found live, with `runtime: ollama` and
  // `model: ggml-org/gemma-4-12B-it-GGUF:Q4_0` still saved from llama.cpp.
  // Every turn then failed with "model not found", which reads as a broken
  // install rather than a stale setting.
  try {
    const installed = await runtime.listModels();
    const known = installed.some((m) => m.name === config.model);
    if (!config.model || !known) {
      const pick = pickDefaultModel(installed, { totalMemoryBytes: os.totalmem() });
      if (pick) {
        const why = config.model ? `${config.model} is not installed here` : pick.reason;
        config = await saveConfig({ model: pick.name });
        console.log(`  model  ${pick.name} — ${why}`);
      }
    }
  } catch {
    // No runtime yet — the UI will prompt.
  }

  // A new install opens on four example skills rather than an empty panel and a
  // blank editor. Only ever on a folder that has none — a deleted starter stays
  // deleted, and an edited one is the user's file from then on.
  await installStarterSkills({ listSkills: Skills.listSkills, writeSkill: Skills.writeSkill }).catch(() => {});

  // ---- status -------------------------------------------------------------

  app.get('/api/health', wrap(async (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      home: home.where,
      storage: home.kind,
      runtime: await runtime.health(),
    });
  }));

  // ---- models -------------------------------------------------------------

  app.get('/api/models', wrap(async (_req, res) => {
    const current = (await loadConfig()).model;
    try {
      res.json({
        models: await runtime.listModels(),
        current,
        // So the picker can decide whether to draw a pull button, rather than
        // drawing one and finding out.
        capabilities: runtime.capabilities?.() || null,
      });
    } catch (err) {
      res.json({ models: [], current, error: err.message });
    }
  }));

  /**
   * Download a model, streaming progress.
   *
   * SSE rather than a JSON response because a pull is minutes long and the only
   * thing worse than a slow download is one with no evidence it is happening.
   */
  app.post('/api/models/pull', wrap(async (req, res) => {
    const model = String(req.body?.model || '').trim();
    if (!model) return res.status(400).json({ error: 'Which model?' });
    if (!runtime.pull) {
      return res.status(400).json({ error: `${runtime.capabilities?.().label || 'This runtime'} cannot download models` });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    // Closing the tab must stop the download, not leave it running against a
    // reader nobody is holding. Same lesson as the chat stream in M6.
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
      for await (const event of runtime.pull(model, { signal: controller.signal })) send(event);
    } catch (err) {
      if (!controller.signal.aborted) send({ type: 'error', message: err.message });
    }
    res.end();
  }));

  // ---- the catalogue ------------------------------------------------------
  // Searching Hugging Face, so choosing a model does not require already
  // knowing its name. Proxied through the server rather than called from the
  // page: the client is same-origin-only by design, and routing it here keeps
  // that rule intact.

  app.get('/api/catalogue', wrap(async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ models: [] });
    try {
      res.json({ models: await searchModels(query) });
    } catch (err) {
      // Offline is a normal state for a local-first app. Say so plainly rather
      // than leaving a spinner running.
      res.status(502).json({ error: `Could not reach Hugging Face — ${err.message}` });
    }
  }));

  app.get('/api/catalogue/:owner/:repo', wrap(async (req, res) => {
    const repo = `${req.params.owner}/${req.params.repo}`;
    try {
      res.json({ repo, quants: await listQuants(repo, { totalMemoryBytes: os.totalmem() }) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  }));

  // ---- runtimes -----------------------------------------------------------

  /**
   * What could run models here, and what is running them now.
   *
   * Detection happens on request rather than at boot: probing is only useful
   * when somebody is looking at the answer, and adopting whatever answers a
   * well-known port would silently move a person off the runtime holding all
   * their models.
   */
  app.get('/api/runtimes', wrap(async (_req, res) => {
    const saved = (await loadConfig()).runtime;
    res.json({
      current: saved
        ? { ...saved, capabilities: runtime.capabilities?.() || null }
        : { provider: 'ollama', baseUrl: config.ollamaUrl, implicit: true, capabilities: runtime.capabilities?.() || null },
      detected: await detect(),
      health: await runtime.health(),
    });
  }));

  /** Choose one. Verified before it is saved, so a typo cannot strand the app. */
  app.put('/api/runtime', wrap(async (req, res) => {
    const { provider, baseUrl = null, apiKey = null } = req.body || {};
    let candidate;
    try {
      candidate = adapterFor({ provider, baseUrl, apiKey });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const health = await candidate.health();
    if (!health.ok) {
      return res.status(400).json({
        error: `Nothing is answering at ${health.url}${health.error ? ` (${health.error})` : ''}`,
      });
    }

    runtime = candidate;
    useInference(runtime);
    // The chosen model almost certainly does not exist on the new runtime, and
    // a stale name produces a confusing 404 on the next turn rather than an
    // obvious "pick a model".
    const models = await runtime.listModels().catch(() => []);
    const keep = models.some((m) => m.name === config.model) ? config.model : (models[0]?.name ?? null);

    config = await saveConfig({ runtime: { provider, baseUrl, apiKey }, model: keep, embedModel: null });
    res.json({
      ok: true,
      current: { provider, baseUrl, capabilities: runtime.capabilities?.() || null },
      model: keep,
      models,
    });
  }));

  // ---- settings -----------------------------------------------------------

  app.get('/api/settings', wrap(async (_req, res) => {
    const soul = await loadSoul();
    // Which installed models are big enough to write memory. The floor is
    // measured, not guessed — below about 3B a model returns valid empty JSON
    // instead of facts, so memory quietly stops working and nothing reports an
    // error. The picker says so rather than letting someone choose one.
    let capable = null;
    try {
      capable = (await runtime.listModels()).filter(canExtract).map((m) => m.name);
    } catch {
      capable = null; // No runtime, no opinion.
    }
    res.json({
      ...(await loadConfig()),
      extractCapable: capable,
      modes: soul.modes,
      depths: DEPTHS.filter(Boolean).map(({ key, name }) => ({ key, name })),
      thinkingLevels: LEVELS.map((key) => ({ key, name: LEVEL_NAMES[key] })),
    });
  }));

  app.post('/api/settings', wrap(async (req, res) => {
    const allowed = ['model', 'mode', 'depth', 'thinking', 'maxContext', 'artifacts', 'autoExtract', 'extractModel', 'theme', 'keepWarmMinutes', 'speech', 'sleep'];
    const patch = {};
    for (const key of allowed) if (key in (req.body || {})) patch[key] = req.body[key];
    if ('thinking' in patch) patch.thinking = normalizeLevel(patch.thinking);
    // A window is RAM. Clamp rather than trust, so a typo cannot wedge the app
    // into reloading a model with a window the machine will not survive.
    if ('maxContext' in patch) patch.maxContext = windowFor(HARD_CAP, patch.maxContext);
    res.json(await saveConfig(patch));
  }));

  // ---- conversations ------------------------------------------------------

  app.get('/api/conversations', wrap(async (_req, res) => {
    res.json({ conversations: await Conversations.list() });
  }));

  app.get('/api/conversations/:id', wrap(async (req, res) => {
    const turns = await Conversations.turns(req.params.id);
    res.json({ id: req.params.id, meta: await Conversations.meta(req.params.id), turns });
  }));

  app.delete('/api/conversations/:id', wrap(async (req, res) => {
    const gone = await Conversations.remove(req.params.id);
    if (!gone) return res.status(404).json({ error: 'No such conversation.' });
    // Its files go with it. Attachments are filed under the conversation
    // precisely so that deleting one does not leave orphans nobody can place.
    await Attachments.removeAllFor(req.params.id);
    res.json({ ok: true, id: req.params.id });
  }));

  /**
   * File a conversation under a project, or take it out of one.
   *
   * The slug names a `projects/<slug>.md` the Reflector already maintains, so
   * grouping chats does not invent a second kind of project — it points at the
   * one that is already there.
   */
  app.post('/api/conversations/:id/project', wrap(async (req, res) => {
    const slug = req.body?.project ? Memory.slugify(String(req.body.project)) : null;
    await Conversations.setProject(req.params.id, slug);
    res.json({ ok: true, id: req.params.id, project: slug });
  }));

  /**
   * Carry this conversation into a new one that still knows everything.
   *
   * The reason Reflect exists: a long conversation that hits its limit should
   * not take its contents with it. Nothing is deleted or moved — the old
   * conversation stays readable, and the new one records what it continues.
   */
  app.post('/api/conversations/:id/continue', wrap(async (req, res) => {
    const config = await loadConfig();
    const model = config.extractModel || config.model;
    if (!model) return res.status(400).json({ error: 'No model selected.' });

    const result = await continueElsewhere({
      conversationId: req.params.id,
      // The live one, not a fresh adapter: it may have been switched since boot.
      runtime,
      model,
    });
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json(result);
  }));

  /**
   * Split a new conversation off from a point in this one.
   *
   * No model call and nothing to summarise — the turns are copied as they are,
   * which is the point. Instant, and the original is untouched.
   */
  app.post('/api/conversations/:id/branch', wrap(async (req, res) => {
    const result = await branchFrom({
      conversationId: req.params.id,
      turnId: String(req.body?.turnId || ''),
    });
    if (!result.ok) return res.status(400).json({ error: result.reason });
    res.json(result);
  }));

  // ---- receipts -----------------------------------------------------------
  // Where each memory came from. Newest sighting per fact; matching is done by
  // the client against whatever file it has open.

  app.get('/api/memory/sources', wrap(async (_req, res) => {
    res.json({ sources: await receiptSources() });
  }));

  // ---- print your year ----------------------------------------------------
  // The journal, the projects and the profile, bound. No AI company can offer
  // this, and the reason is structural rather than technical: it requires
  // having given you the files in the first place.

  app.get('/api/memory/years', wrap(async (_req, res) => {
    res.json({ years: await yearsAvailable() });
  }));

  app.get('/api/memory/year/:year.pdf', wrap(async (req, res) => {
    const year = String(req.params.year).replace(/\D/g, '').slice(0, 4);
    if (year.length !== 4) return res.status(400).json({ error: 'Which year?' });

    const { markdown, empty } = await yearbook(year);
    if (empty) return res.status(404).json({ error: `Nothing was written down in ${year}.` });

    const bytes = markdownToPdf(markdown);
    res.setHeader('Content-Type', 'application/pdf');
    // A filename people will recognise a year later in a downloads folder.
    res.setHeader('Content-Disposition', `attachment; filename="Reflect ${year}.pdf"`);
    res.send(bytes);
  }));

  // ---- the memory timeline ------------------------------------------------
  // What Reflect believed, and when. Every version of USER.md is a byte-exact
  // copy — the file is under a kilobyte, so keeping all of them costs less
  // than one photograph and answers "undo that" without a dependency.

  app.get('/api/memory/versions', wrap(async (_req, res) => {
    res.json({ versions: await listVersions() });
  }));

  app.get('/api/memory/versions/:id', wrap(async (req, res) => {
    const content = await readVersion(req.params.id);
    if (content === null) return res.status(404).json({ error: 'That version is no longer kept.' });
    res.json({ id: req.params.id, content });
  }));

  app.post('/api/memory/versions/:id/restore', wrap(async (req, res) => {
    const done = await restoreVersion(req.params.id);
    if (!done.ok) return res.status(400).json({ error: done.reason });
    res.json(done);
  }));

  // ---- the mirror ---------------------------------------------------------
  // Today's page: what Reflect holds, played back. Computed from files in the
  // time it takes to read them — see reflect/Today.js for why nothing on it is
  // ever generated.

  app.get('/api/today', wrap(async (_req, res) => {
    res.json(await todayPage({}));
  }));

  // ---- who Reflect may reach ----------------------------------------------
  // The same shape as a folder grant, and for the same reason: a message sends
  // for real and cannot be recalled, so the list of people it may go to is
  // written by a person and by nothing else. No tool can add to it.
  app.get('/api/delivery', wrap(async (_req, res) => {
    res.json({ available: Deliver.available(), contacts: await Deliver.contacts() });
  }));

  app.post('/api/delivery/allow', wrap(async (req, res) => {
    const done = await Deliver.allow(req.body?.handle, req.body?.name);
    if (!done.ok) return res.status(400).json(done);
    res.json({ ...done, contacts: await Deliver.contacts() });
  }));

  app.post('/api/delivery/revoke', wrap(async (req, res) => {
    await Deliver.revoke(req.body?.handle);
    res.json({ ok: true, contacts: await Deliver.contacts() });
  }));

  // A person pressing Test is asking for exactly one notification, which is the
  // one delivery here that reaches nobody but them.
  app.post('/api/delivery/test', wrap(async (_req, res) => {
    res.json(await Deliver.notify({ body: 'This is how Reflect will reach you.' }));
  }));

  // ---- the ledger ---------------------------------------------------------
  // The footer used to assert that nothing leaves this machine. It now reports
  // it, from a count taken at the sockets themselves — which is the only form
  // of that claim worth believing, and the only one that stays true when the
  // person points their runtime at the machine in the next room.
  app.get('/api/ledger', wrap(async (_req, res) => {
    res.json({ summary: await ledgerSummary(), entries: await ledgerEntries() });
  }));

  // ---- promises -----------------------------------------------------------
  // Remembering forward. Recorded from the person's own sentence as it is
  // typed, surfaced on the morning page when the day arrives, and closed by
  // hand — Reflect has no way to know whether you actually called your mother,
  // and guessing would be the one thing that makes this feature a liar.
  app.get('/api/promises', wrap(async (_req, res) => {
    res.json({ promises: await openPromises() });
  }));

  app.post('/api/promises/:id/:state', wrap(async (req, res) => {
    const done = await settlePromise(req.params.id, req.params.state);
    if (!done.ok) return res.status(404).json(done);
    res.json(done);
  }));

  // ---- noticing -----------------------------------------------------------
  // The one thing a local assistant can do that a stateless one cannot: say
  // something you did not ask about, because it still remembers. Computed from
  // files rather than generated, so it costs nothing and cannot invent.

  app.get('/api/notice', wrap(async (_req, res) => {
    res.json({ notice: await notice({}) });
  }));

  app.post('/api/notice/dismiss', wrap(async (req, res) => {
    const key = String(req.body?.key || '');
    if (!key) return res.status(400).json({ error: 'Which notice?' });
    await dismissNotice(key);
    res.json({ ok: true, key });
  }));

  // ---- projects -----------------------------------------------------------
  // A project is projects/<slug>.md, the same file the Reflector writes into on
  // its own. These routes exist so one can also be started deliberately, named,
  // and thrown away — the Reflector can only ever create them sideways.

  app.get('/api/projects', wrap(async (_req, res) => {
    res.json({ projects: await Memory.listProjects() });
  }));

  app.post('/api/projects', wrap(async (req, res) => {
    try {
      res.json(await Memory.createProject(String(req.body?.name || '')));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  app.post('/api/projects/:slug/name', wrap(async (req, res) => {
    try {
      const renamed = await Memory.renameProject(req.params.slug, String(req.body?.name || ''));
      if (!renamed) return res.status(404).json({ error: `No project called "${req.params.slug}".` });
      res.json(renamed);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  /**
   * Delete the project file. The conversations filed under it are untouched and
   * keep their slug, so nothing that was said disappears with the folder — they
   * simply stop being grouped.
   */
  app.delete('/api/projects/:slug', wrap(async (req, res) => {
    const gone = await Memory.removeProject(req.params.slug);
    if (!gone) return res.status(404).json({ error: `No project called "${req.params.slug}".` });
    res.json({ ok: true, slug: req.params.slug });
  }));

  app.post('/api/conversations/:id/title', wrap(async (req, res) => {
    res.json({ title: await Conversations.setTitle(req.params.id, String(req.body?.title || '')) });
  }));

  // ---- history ------------------------------------------------------------
  // Your past, as opposed to your memory. Searched when asked and never
  // injected — see the note at the top of recall/History.js.

  app.get('/api/history/search', wrap(async (req, res) => {
    const query = String(req.query.q || '');
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    res.json({ query, ...(await searchHistory(query, { limit })) });
  }));

  app.get('/api/history/timeline', wrap(async (req, res) => {
    const months = Math.min(Number(req.query.months) || 24, 240);
    res.json({ timeline: await timeline({ months }) });
  }));

  /**
   * Import a ChatGPT export by path. A browser cannot hand us a real path, and
   * uploading a 200MB export through JSON would be worse, so the field takes
   * the path the user already has in their downloads folder — the same argument
   * `reflect import` takes.
   */
  app.post('/api/history/import', wrap(async (req, res) => {
    const file = String(req.body?.file || '').trim();
    if (!file) return res.status(400).json({ error: 'Which file? Give the path to your export.' });

    const asked = Number(req.body?.limit);
    const limit = Number.isFinite(asked) && asked > 0 ? asked : Infinity;

    try {
      const summary = await importExport(file, { limit, dryRun: Boolean(req.body?.dryRun) });
      res.json({ ...summary, dryRun: Boolean(req.body?.dryRun), where: join(homePath(), paths().conversations) });
    } catch (err) {
      // A bad path or a zip we cannot read is the user's problem to fix, not a
      // server fault: give them the message, which already says what to do.
      res.status(400).json({ error: err.message });
    }
  }));

  // ---- skills ---------------------------------------------------------------
  // Instructions you can teach it, in the open Agent Skills format: a folder
  // with a SKILL.md. Invalid ones are listed with their problems rather than
  // hidden, because a skill that silently does nothing is the worst outcome.

  app.get('/api/skills', wrap(async (_req, res) => {
    const skills = await Skills.listSkills();
    res.json({
      skills: skills.map(({ body, ...rest }) => ({ ...rest, bytes: body.length })),
      catalogueTokens: Math.ceil(Skills.catalogue(skills).length / 4),
    });
  }));

  app.get('/api/skills/:name', wrap(async (req, res) => {
    const skill = await Skills.readSkill(req.params.name);
    if (!skill) return res.status(404).json({ error: `No skill called "${req.params.name}".` });
    res.json({ ...skill, source: await readText(skill.key, '') });
  }));

  app.put('/api/skills/:name', wrap(async (req, res) => {
    try {
      const skill = await Skills.writeSkill(req.params.name, String(req.body?.source ?? ''));
      res.json(skill);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  app.post('/api/skills/:name/enabled', wrap(async (req, res) => {
    const skill = await Skills.setSkillEnabled(req.params.name, Boolean(req.body?.enabled));
    if (!skill) return res.status(404).json({ error: `No skill called "${req.params.name}".` });
    res.json(skill);
  }));

  app.delete('/api/skills/:name', wrap(async (req, res) => {
    const gone = await Skills.removeSkill(req.params.name);
    if (!gone) return res.status(404).json({ error: 'No such skill.' });
    res.json({ ok: true, name: req.params.name });
  }));

  // ---- tasks --------------------------------------------------------------
  // A saved instruction, with an optional clock. Running one is an ordinary
  // turn through /api/chat — there is no second execution path, on purpose.

  app.get('/api/tasks', wrap(async (_req, res) => {
    // nextRun is computed here rather than in the browser because the schedule
    // is stored as English and only Tasks.js knows how to read it. Sending the
    // sentence and asking the client to parse it again is how the two drift.
    const tasks = (await Tasks.listTasks()).map((t) => ({
      ...t,
      nextRun: Tasks.nextRun(t)?.toISOString() || null,
    }));
    res.json({ tasks });
  }));

  app.put('/api/tasks/:name', wrap(async (req, res) => {
    try {
      const instruction = String(req.body?.instruction ?? '');

      // An explicit value is a person answering the question, and wins. Absent,
      // the task keeps what it had unless the new wording asks for more — so
      // editing a task never quietly removes a permission you granted it, and
      // adding "and email it to me" grants one without a second step.
      const previous = await Tasks.readTask(req.params.name).catch(() => null);
      const reach = Tasks.REACH.includes(req.body?.reach)
        ? req.body.reach
        : Tasks.widerReach(previous?.reach ?? 'none', Tasks.reachFor(instruction));

      const task = await Tasks.writeTask(req.params.name, {
        instruction,
        when: String(req.body?.when ?? 'manual'),
        enabled: req.body?.enabled !== false,
        reach,
      });
      res.json(task);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  app.delete('/api/tasks/:name', wrap(async (req, res) => {
    const gone = await Tasks.removeTask(req.params.name);
    if (!gone) return res.status(404).json({ error: 'No such task.' });
    res.json({ ok: true, name: req.params.name });
  }));

  /** Run it now, whatever its schedule says. */
  app.post('/api/tasks/:name/run', wrap(async (req, res) => {
    const task = await Tasks.readTask(req.params.name);
    if (!task) return res.status(404).json({ error: 'No such task.' });
    if (!task.valid) return res.status(400).json({ error: task.problems.join('; ') });
    // The address the server is actually bound to, set by whoever called
    // listen(). The PORT constant is only a fallback: under the desktop shell
    // the real port is chosen at runtime, and a task that posts to 3040 would
    // reach either nothing or somebody else's Reflect.
    const selfUrl = req.app.get('selfUrl') || `http://127.0.0.1:${PORT}`;
    res.json(await runTask(task, { baseUrl: selfUrl }));
  }));


  // ---- attachments --------------------------------------------------------
  // Files someone brought to a conversation. Stored as real files under the
  // conversation, so they can be opened outside Reflect and go away with it.

  app.get('/api/attachments/:id', wrap(async (req, res) => {
    res.json({ attachments: await Attachments.listAttachments(req.params.id) });
  }));

  /**
   * Upload one file.
   *
   * Raw body rather than multipart: multipart would mean a parser dependency
   * for a single route, and base64 in JSON would inflate every upload by a
   * third. The name travels in the URL, where it is validated.
   */
  app.put(
    '/api/attachments/:id/:name',
    express.raw({ type: '*/*', limit: Attachments.MAX_BYTES }),
    wrap(async (req, res) => {
      try {
        const saved = await Attachments.saveAttachment(req.params.id, req.params.name, new Uint8Array(req.body));
        res.json(saved);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  app.get('/api/attachments/:id/:name', wrap(async (req, res) => {
    let bytes;
    try {
      bytes = await Attachments.readAttachment(req.params.id, req.params.name);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!bytes) return res.status(404).json({ error: 'No such attachment.' });
    res.setHeader('Content-Type', Attachments.mimeOf(req.params.name));
    // It is the user's own file coming back to them, but it is also bytes an
    // attacker could have talked the model into writing. Never let the browser
    // decide it is HTML and run it in this origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(bytes));
  }));

  app.delete('/api/attachments/:id/:name', wrap(async (req, res) => {
    try {
      const gone = await Attachments.removeAttachment(req.params.id, req.params.name);
      if (!gone) return res.status(404).json({ error: 'No such attachment.' });
      res.json({ ok: true, name: req.params.name });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));


  // ---- dictation ----------------------------------------------------------
  // Speech to text, on this machine. The browser records; whisper.cpp
  // transcribes; nothing is uploaded and no audio is kept. See speech/Whisper.js
  // for why this is not the browser's SpeechRecognition, which is twenty lines
  // and would send the microphone to Google.

  const resourcesPath = process.resourcesPath || null;

  app.get('/api/dictation', wrap(async (_req, res) => {
    const cfg = await loadConfig();
    const model = cfg.dictationModel || Whisper.DEFAULT_MODEL;
    res.json({
      available: Boolean(Whisper.findBinary({ resourcesPath })),
      model,
      ready: Whisper.hasModel(model),
      models: Object.entries(Whisper.MODELS).map(([name, m]) => ({ name, bytes: m.bytes, note: m.note })),
    });
  }));

  /** Fetch the weights. Same progress shape as a chat model pull. */
  app.post('/api/dictation/pull', wrap(async (req, res) => {
    const model = String(req.body?.model || '') || Whisper.DEFAULT_MODEL;
    if (!Whisper.MODELS[model]) return res.status(400).json({ error: `Unknown model: ${model}` });

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
      for await (const event of Whisper.pullModel(model, { signal: controller.signal })) send(event);
      await saveConfig({ dictationModel: model });
    } catch (err) {
      if (!controller.signal.aborted) send({ type: 'error', message: err.message });
    }
    res.end();
  }));

  /**
   * Transcribe one clip of 16 kHz mono WAV.
   *
   * Called repeatedly while someone is speaking, each time with the utterance
   * so far, so the text firms up rather than arriving in disconnected pieces.
   * The audio is never written to disk — it exists as a request body and then
   * it is gone.
   */
  app.post(
    '/api/dictation/transcribe',
    express.raw({ type: 'audio/wav', limit: '25mb' }),
    wrap(async (req, res) => {
      if (!req.body?.length) return res.status(400).json({ error: 'No audio.' });
      const model = (await loadConfig()).dictationModel || Whisper.DEFAULT_MODEL;
      try {
        const text = await Whisper.transcribe(new Uint8Array(req.body), { model, resourcesPath });
        if (text === null) {
          return res.status(503).json({ error: 'Dictation is not set up on this machine.' });
        }
        res.json({ text });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    })
  );

  // ---- assistants ---------------------------------------------------------
  // A role you can pick: how Reflect speaks, which model answers, which tools
  // and skills are on the table. Never a separate memory — see
  // assistants/Assistants.js for why that is the one thing they do not change.

  app.get('/api/assistants', wrap(async (_req, res) => {
    res.json({ assistants: await Assistants.listAssistants(), current: (await loadConfig()).assistant || 'reflect' });
  }));

  app.put('/api/assistants/:name', wrap(async (req, res) => {
    try {
      const saved = await Assistants.writeAssistant(req.params.name, {
        description: String(req.body?.description ?? ''),
        persona: String(req.body?.persona ?? ''),
        model: req.body?.model || null,
        tools: req.body?.tools ?? null,
        skills: req.body?.skills ?? null,
      });
      res.json(saved);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  app.delete('/api/assistants/:name', wrap(async (req, res) => {
    try {
      const gone = await Assistants.removeAssistant(req.params.name);
      if (!gone) return res.status(404).json({ error: `No assistant called "${req.params.name}".` });
      res.json({ ok: true, name: req.params.name });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  // ---- tools --------------------------------------------------------------
  // What the model is allowed to reach for. Folder tools appear only once a
  // folder is connected, so the list says why one is unavailable rather than
  // hiding it and leaving the reason to be guessed.

  app.get('/api/tools', wrap(async (_req, res) => {
    const cfg = await loadConfig();
    const disabled = new Set(cfg.disabledTools || []);
    const grants = await Grants.listGrants();
    const canWrite = grants.some((g) => g.access === 'write');

    res.json({
      tools: allTools().map((t) => ({
        ...t,
        enabled: !disabled.has(t.name),
        available:
          t.group === 'Memory'
            ? true
            : t.group === 'The web'
              ? Boolean(cfg.web?.enabled)
              : ['file_write', 'folder_create'].includes(t.name)
                ? canWrite
                : grants.length > 0,
        why:
          t.group === 'Memory'
            ? null
            : t.group === 'The web'
              ? (cfg.web?.enabled ? null : 'Switch the web on to use this')
              : grants.length === 0
                ? 'Connect a folder to use this'
                : ['file_write', 'folder_create'].includes(t.name) && !canWrite
                  ? 'Raise a folder to writing to use this'
                  : null,
      })),
    });
  }));

  app.put('/api/tools', wrap(async (req, res) => {
    const { name, enabled } = req.body || {};
    const known = new Set(allTools().map((t) => t.name));
    if (!known.has(name)) return res.status(400).json({ error: `No tool called "${name}".` });

    const cfg = await loadConfig();
    const disabled = new Set(cfg.disabledTools || []);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await saveConfig({ disabledTools: [...disabled] });
    res.json({ ok: true, name, enabled: Boolean(enabled) });
  }));

  // ---- the web ----------------------------------------------------------
  // The one part of Reflect that talks to anything outside this machine, and
  // therefore the one part with its own switch. What leaves is the search terms
  // and the address of a page — never memory, conversations, or files.

  app.get('/api/web', wrap(async (_req, res) => {
    const cfg = await loadConfig();
    const web = cfg.web || {};
    res.json({
      enabled: Boolean(web.enabled),
      provider: web.provider || 'mojeek',
      baseUrl: web.baseUrl || null,
      // Whether a key is set, never the key. It is read back into a form, and a
      // secret that renders into the DOM is a secret in the page source.
      hasKey: Boolean(web.apiKey),
      providers: Object.entries(SearchProviders).map(([id, p]) => ({
        id,
        label: p.label,
        needs: p.needs,
        note: p.note,
      })),
    });
  }));

  app.put('/api/web', wrap(async (req, res) => {
    const cfg = await loadConfig();
    const current = cfg.web || {};
    const { enabled, provider, apiKey, baseUrl } = req.body || {};

    if (provider !== undefined && !SearchProviders[provider]) {
      return res.status(400).json({ error: `No search provider called "${provider}".` });
    }

    // Refused when it is typed rather than when it is used, so the error lands
    // in the box the person is looking at. The call itself checks again — this
    // is the friendlier of the two, not the one doing the work.
    if (baseUrl) {
      const safe = await checkInstance(baseUrl);
      if (!safe.ok) return res.status(400).json({ error: `That address will not do: ${safe.reason}` });
    }

    const web = {
      ...current,
      ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(baseUrl !== undefined ? { baseUrl: baseUrl || null } : {}),
      // An absent key leaves the stored one alone; an empty string clears it.
      // Without that distinction, saving the form after a reload would wipe the
      // key every time, because the form never had it to send back.
      ...(apiKey !== undefined ? { apiKey: apiKey === '' ? null : apiKey } : {}),
    };

    await saveConfig({ web });
    res.json({ ok: true, enabled: web.enabled, provider: web.provider, hasKey: Boolean(web.apiKey) });
  }));

  /** Prove it works before trusting it, and say plainly what went wrong. */
  app.post('/api/web/test', wrap(async (req, res) => {
    const cfg = await loadConfig();
    const web = { ...(cfg.web || {}), ...(req.body || {}) };
    const found = await runSearch(String(req.body?.query || 'what is laminar flow'), {
      provider: web.provider,
      apiKey: web.apiKey,
      baseUrl: web.baseUrl,
      limit: 3,
    });
    res.json(found.ok ? { ok: true, provider: found.provider, results: found.results } : { ok: false, reason: found.reason });
  }));

  // ---- grants -----------------------------------------------------------
  // The only things Reflect may touch outside its own memory folder. A grant is
  // a person's decision: nothing here can be created by a model or a skill.

  app.get('/api/grants', wrap(async (_req, res) => {
    res.json({ folders: await Grants.listGrants() });
  }));

  app.post('/api/grants', wrap(async (req, res) => {
    try {
      const folder = await Grants.grant(req.body?.path, req.body?.access || 'read');
      res.json(folder);
    } catch (err) {
      // A bad path is the user's to fix, and the message says how.
      res.status(400).json({ error: err.message });
    }
  }));

  app.delete('/api/grants', wrap(async (req, res) => {
    const gone = await Grants.revoke(req.query.path || req.body?.path);
    if (!gone) return res.status(404).json({ error: 'That folder was not connected.' });
    res.json({ ok: true });
  }));

  /** Browsing a connected folder from the UI, with the same checks the tools use. */
  app.get('/api/grants/list', wrap(async (req, res) => {
    try {
      res.json(await Folders.listFolder(req.query.path));
    } catch (err) {
      res.status(403).json({ error: err.message });
    }
  }));

  // ---- memory -------------------------------------------------------------
  // Everything Reflect knows is a file, so the API is a file browser. Editing a
  // file here changes what Reflect believes on the very next turn.

  app.get('/api/memory', wrap(async (_req, res) => {
    res.json({
      profile: { path: 'USER.md', empty: !(await Memory.readProfile()) },
      soul: { path: 'SOUL.md' },
      projects: await Memory.listProjects(),
      journal: await Memory.readJournal(7),
    });
  }));

  app.get('/api/memory/search', wrap(async (req, res) => {
    const query = String(req.query.q || '');
    const { results, trace } = await recall(query, { limit: 12 });
    res.json({ query, results, trace });
  }));

  /** The index is derived. Deleting it is a supported, safe operation. */
  app.post('/api/memory/reindex', wrap(async (_req, res) => {
    const index = getIndex();
    await index.clear();
    const sync = await index.sync(await Memory.collectChunks());
    res.json(sync);
  }));

  /** Read any memory file by its user-facing path: USER.md, projects/x, journal/2026-08-12. */
  app.get('/api/memory/file', wrap(async (req, res) => {
    const target = String(req.query.path || '');
    if (target.toLowerCase() === 'soul.md' || target.toLowerCase() === 'soul') {
      return res.json({ path: 'SOUL.md', content: await readText(paths().soul, '') });
    }
    const content = await readMemoryPath(target);
    if (content === null) return res.status(404).json({ error: `No memory file at "${target}".` });
    res.json({ path: target, content });
  }));

  app.put('/api/memory/file', wrap(async (req, res) => {
    const target = String(req.body?.path || '');
    const content = String(req.body?.content ?? '');
    const lower = target.toLowerCase();

    if (lower === 'soul.md' || lower === 'soul') {
      await writeText(paths().soul, content);
      return res.json({ ok: true, path: 'SOUL.md' });
    }
    if (lower === 'user.md' || lower === 'profile') {
      await takeVersion({ reason: 'you edited it' }).catch(() => {});
      await Memory.writeProfile(content);
      return res.json({ ok: true, path: 'USER.md' });
    }
    const project = /^projects\/(.+?)(?:\.md)?$/i.exec(target);
    if (project) {
      await Memory.writeProject(Memory.slugify(project[1]), content);
      return res.json({ ok: true, path: target });
    }
    res.status(400).json({ error: `Cannot write to "${target}".` });
  }));

  // Legacy shorthand kept so the M1 client keeps working.
  app.get('/api/memory/:file(user|soul)', wrap(async (req, res) => {
    const target = req.params.file === 'soul' ? paths().soul : paths().user;
    res.json({ file: path.basename(target), content: await readText(target, '') });
  }));

  app.put('/api/memory/:file(user|soul)', wrap(async (req, res) => {
    const target = req.params.file === 'soul' ? paths().soul : paths().user;
    // Your own edits go on the timeline too. A memory you deleted by hand at
    // midnight is exactly the one you want back in the morning.
    if (target === paths().user) await takeVersion({ reason: 'you edited it' }).catch(() => {});
    await writeText(target, String(req.body?.content ?? ''));
    res.json({ ok: true, file: path.basename(target) });
  }));

  // ---- chat ---------------------------------------------------------------

  // Built per request rather than once: `runtime` is reassigned when someone
  // changes it, and a handler that captured the old value would keep talking to
  // a runtime the user has already moved off. Creating the closure is free.
  app.post('/api/chat', (req, _res, next) => {
    // The idle clock sleep watches. Stamped on the way in, not the way out, so
    // a long streaming reply still counts as the person being here.
    app.set('lastChatAt', Date.now());
    next();
  }, (req, res) => createChatHandler({ runtime })(req, res));

  /**
   * Maintenance for a tick when nothing louder wanted the machine.
   *
   * Sleep decides for itself whether it is time (a new day, ten quiet minutes)
   * — this only supplies what it cannot know: the live runtime, the model, and
   * when the person last typed. Passed to the scheduler as onQuiet by both the
   * CLI server and the desktop shell, so neither has to know what sleep is.
   */
  const quietWork = async () => {
    const cfg = await loadConfig();
    if (cfg.sleep === false || !cfg.model) return;
    const check = await shouldSleep({ lastChatAt: app.get('lastChatAt') || 0 });
    if (!check.should) return;
    const result = await sleepPass({ runtime, model: cfg.model });
    if (result.changed) console.log('  sleep  tidied USER.md — the version before it is on the timeline');
    else if (result.reason && !/already ran/.test(result.reason)) console.log(`  sleep  ${result.reason}`);
  };

  return { app, home, config, quietWork };
}
