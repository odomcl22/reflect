/**
 * Reaching the person when they are not looking at Reflect.
 *
 * Every tool Reflect had could read, write, search or remember — and not one of
 * them could reach you. So a task at eight in the morning produced a
 * conversation sitting in a list, waiting to be found. That inverts the point
 * of a scheduled task: one you have to remember to check is a note, not an
 * assistant.
 *
 * Three ways out, and the differences between them are the whole design.
 *
 * **A notification** goes to this machine's own screen. It reaches nobody else
 * and leaves nothing behind, so it needs no permission and no list.
 *
 * **A message** actually sends, to a real person, and cannot be recalled. It
 * goes only to handles on a list the person wrote. The list starts empty, so
 * out of the box this tool can reach exactly nobody, and the intended first
 * entry is your own number.
 *
 * **An email is a draft.** It opens in Mail with everything filled in and stops
 * there. Nothing is sent, so any address is safe, because the send button is a
 * person's finger.
 *
 * ## Why this is not code execution
 *
 * Reflect runs AppleScript, and the rule here has been that a tool never runs
 * code. Both are true, because the script is fixed and lives in this file. What
 * the model supplies arrives as `argv` — arguments to a program, the way a file
 * path arrives at `grep` — and AppleScript reads them as data. Nothing the
 * model writes is ever parsed as script:
 *
 *     osascript -e 'on run argv' … -- 'hello"; do shell script "echo pwned'
 *     → got: hello"; do shell script "echo pwned
 *
 * That is the injection returned as text rather than run. There is no shell in
 * the path either — execFile takes an argument array, so quoting never happens
 * and so can never be got wrong.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJSON, writeJSON } from '../store/FileStore.js';

const run = promisify(execFile);

const FILE = 'delivery.json';

/** Long enough for Mail to launch cold, short enough not to hang a task. */
const TIMEOUT_MS = 20_000;

export const available = () => process.platform === 'darwin';

const unavailable = () => ({
  ok: false,
  reason: 'Sending only works on macOS, which is where the Messages and Mail apps are.',
});

/**
 * Fixed scripts. Every one of them reads its inputs from `argv`.
 *
 * Kept together and kept short, because this is the security surface: if a
 * line here ever interpolates a value instead of indexing argv, the guarantee
 * in the header above quietly stops being true.
 */
const SCRIPTS = {
  notify: [
    'on run argv',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    'end run',
  ],
  message: [
    'on run argv',
    'tell application "Messages"',
    'set svc to 1st account whose service type = iMessage',
    'send (item 2 of argv) to participant (item 1 of argv) of svc',
    'end tell',
    'end run',
  ],
  // `visible:true` is the point of this one — the draft opens in front of the
  // person rather than sitting in a queue they never see.
  mail: [
    'on run argv',
    'tell application "Mail"',
    'set m to make new outgoing message with properties {subject:(item 2 of argv), content:(item 3 of argv), visible:true}',
    'tell m to make new to recipient at end of to recipients with properties {address:(item 1 of argv)}',
    'activate',
    'end tell',
    'end run',
  ],
};

async function osascript(name, args) {
  const flags = SCRIPTS[name].flatMap((line) => ['-e', line]);
  try {
    // `--` closes the option list, so a value beginning with a dash is an
    // argument rather than a flag osascript tries to understand.
    await run('/usr/bin/osascript', [...flags, '--', ...args.map((a) => String(a ?? ''))], {
      timeout: TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    // The common failure is permission: macOS asks once, per app, and until
    // someone answers the dialog this fails rather than hangs.
    const why = /not allowed|Not authorized|-1743/i.test(String(err.stderr || err.message))
      ? 'macOS has not been given permission yet — allow Reflect to control that app in System Settings → Privacy & Security → Automation.'
      : String(err.stderr || err.message).trim().slice(0, 200);
    return { ok: false, reason: why };
  }
}

// ─────────────────────────────────────────────────────────── who may be reached

const normalize = (handle) => String(handle || '').replace(/[\s()\-.]/g, '').trim();

/** The list of people Reflect may message. Empty until a person adds someone. */
export async function contacts() {
  const state = (await readJSON(FILE, null)) || {};
  return Array.isArray(state.contacts) ? state.contacts : [];
}

/**
 * Add someone. A person's decision, like a folder grant.
 *
 * Deliberately not reachable by any tool: nothing the model says can put a
 * number on this list, which is what keeps `message` from being a way to
 * contact strangers.
 */
export async function allow(handle, name = '') {
  const clean = normalize(handle);
  if (!clean) return { ok: false, reason: 'that is not a phone number or address' };
  if (!/^\+?\d{5,}$/.test(clean) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    return { ok: false, reason: 'a phone number or an Apple ID email is needed' };
  }
  const list = await contacts();
  if (list.some((c) => normalize(c.handle) === clean)) return { ok: true, already: true };
  list.push({ handle: clean, name: String(name || '').slice(0, 60) });
  await writeJSON(FILE, { contacts: list });
  return { ok: true, handle: clean };
}

export async function revoke(handle) {
  const clean = normalize(handle);
  const list = await contacts();
  const next = list.filter((c) => normalize(c.handle) !== clean);
  await writeJSON(FILE, { contacts: next });
  return { ok: true, removed: list.length - next.length };
}

export async function isAllowed(handle) {
  const clean = normalize(handle);
  return (await contacts()).some((c) => normalize(c.handle) === clean);
}

// ─────────────────────────────────────────────────────────────────── the three

/** A banner on this machine. Reaches nobody else, so it asks for nothing. */
export async function notify({ title = 'Reflect', body }) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, reason: 'nothing to say' };
  if (!available()) return unavailable();
  const done = await osascript('notify', [String(title).slice(0, 100), text.slice(0, 400)]);
  return done.ok ? { ok: true, kind: 'notify', body: text } : done;
}

/**
 * An iMessage, which actually sends and cannot be taken back.
 *
 * The allowlist is checked here rather than trusted from the caller, because
 * this is the one function in the file whose mistakes reach another person.
 */
export async function message({ to, text }) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, reason: 'nothing to send' };
  if (!available()) return unavailable();
  if (!(await isAllowed(to))) {
    return {
      ok: false,
      reason: `Reflect may not message ${to}. Add them in Settings first — a message sends for real, so the list is yours to write.`,
    };
  }
  const done = await osascript('message', [normalize(to), body.slice(0, 2000)]);
  return done.ok ? { ok: true, kind: 'message', to: normalize(to), text: body } : done;
}

/**
 * An email, opened and left alone.
 *
 * Any address is fine precisely because nothing is sent: the draft appears in
 * front of the person with everything filled in, and the last action is theirs.
 */
export async function mailDraft({ to, subject = '', body = '' }) {
  const address = String(to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { ok: false, reason: 'that is not an email address' };
  }
  if (!available()) return unavailable();
  const done = await osascript('mail', [address, String(subject).slice(0, 200), String(body).slice(0, 5000)]);
  return done.ok ? { ok: true, kind: 'mail', to: address, subject } : done;
}
