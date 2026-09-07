/**
 * Files someone brings to a conversation.
 *
 * An attachment is a real file: `attachments/<conversationId>/<name>`, written
 * through the storage port's byte methods so a photo on disk is a photo. You
 * can open it in Preview, copy it out, and find it after Reflect is gone. That
 * is the same promise the memory files make, and an attachment is no less
 * yours for having been dragged rather than typed.
 *
 * Filed under the conversation rather than in one pool, because that is the
 * question people actually ask — "what did I send in that chat?" — and because
 * deleting a conversation should take its files with it rather than leaving
 * orphans nobody can attribute.
 *
 * What reaches the model is a separate decision from what is stored. A 400 KB
 * log is a legitimate thing to attach and an illegitimate thing to paste into
 * a prompt whole, so text is excerpted against a budget and the excerpt says
 * that it is one. Silently truncating is how a model ends up confidently
 * answering about the half of a file it was shown.
 */

import { paths } from '../core/Keys.js';
import { join, basename } from '../core/Storage.js';
import { storage } from '../core/Storage.js';

/** No paths, no traversal, no surprises — a name, an optional extension. */
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,120})$/;

const CONVERSATION = /^[A-Za-z0-9._-]+$/;

/** Anything bigger is a file to point at, not a file to carry in a chat. */
export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * How much of a text file may reach the prompt.
 *
 * Roughly 3,000 tokens: enough for a document worth discussing, small enough
 * that attaching three of them does not evict the conversation they are about.
 */
export const EXCERPT_CHARS = 12000;

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'csv', 'tsv',
  'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs',
  'sh', 'bash', 'zsh', 'sql', 'html', 'css', 'xml', 'ini', 'conf', 'log', 'env',
]);

const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export const extensionOf = (name) => String(name).split('.').pop().toLowerCase();

export const isImage = (name) => Boolean(IMAGE_EXT[extensionOf(name)]);
export const mimeOf = (name) => IMAGE_EXT[extensionOf(name)] || 'application/octet-stream';

/**
 * Is this text we can excerpt?
 *
 * Extension first, then the bytes — a `.log` really is text, and a `.txt` that
 * is secretly a zip is not. A NUL byte in the first few hundred bytes is the
 * cheap, reliable tell that every diff tool uses.
 */
export function looksTextual(name, bytes = null) {
  if (isImage(name)) return false;
  if (bytes && bytes.subarray(0, 512).includes(0)) return false;
  return TEXT_EXT.has(extensionOf(name)) || Boolean(bytes);
}

export function attachmentKey(conversationId, name) {
  if (!CONVERSATION.test(conversationId)) throw new Error(`Unsafe conversation id: ${conversationId}`);
  if (!NAME.test(name) || name.includes('..')) throw new Error(`Unsafe attachment name: ${name}`);
  return join(paths().attachments, conversationId, name);
}

/** Store one file. Returns what the client needs to show a chip. */
export async function saveAttachment(conversationId, name, bytes) {
  if (bytes.length > MAX_BYTES) {
    throw new Error(`${name} is ${(bytes.length / 1e6).toFixed(1)} MB — the limit is ${MAX_BYTES / 1e6} MB.`);
  }
  const store = await storage();
  await store.writeBytes(attachmentKey(conversationId, name), bytes);
  return describeAttachment(name, bytes.length);
}

export const describeAttachment = (name, bytes) => ({
  name,
  bytes,
  kind: isImage(name) ? 'image' : looksTextual(name) ? 'text' : 'file',
});

export async function listAttachments(conversationId) {
  if (!CONVERSATION.test(conversationId)) return [];
  const store = await storage();
  const prefix = join(paths().attachments, conversationId);
  const names = await store.list(prefix);
  const found = [];
  for (const name of names) {
    const bytes = await store.readBytes(join(prefix, name));
    if (bytes) found.push(describeAttachment(name, bytes.length));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readAttachment(conversationId, name) {
  const store = await storage();
  return store.readBytes(attachmentKey(conversationId, name));
}

export async function removeAttachment(conversationId, name) {
  const store = await storage();
  const key = attachmentKey(conversationId, name);
  if (!(await store.exists(key))) return false;
  await store.remove(key);
  return true;
}

/** Everything for one conversation, so deleting a chat does not leave orphans. */
export async function removeAllFor(conversationId) {
  if (!CONVERSATION.test(conversationId)) return;
  const store = await storage();
  await store.removeAll(join(paths().attachments, conversationId));
}

/**
 * Turn attachments into something a turn can carry.
 *
 * Text is excerpted and labelled. Images are handed back as base64 for the
 * adapter to place, because where an image goes in a request is the one part of
 * this that differs per runtime — Ollama takes an `images` array on the
 * message, OpenAI takes content parts — and that belongs behind the port.
 *
 * @returns {Promise<{text: string, images: string[], used: object[]}>}
 */
export async function materialise(conversationId, names = [], { budget = EXCERPT_CHARS } = {}) {
  const parts = [];
  const images = [];
  const used = [];
  let remaining = budget;

  for (const name of names) {
    let bytes;
    try {
      bytes = await readAttachment(conversationId, name);
    } catch {
      continue; // an unsafe name is not an attachment
    }
    if (!bytes) continue;

    if (isImage(name)) {
      images.push(Buffer.from(bytes).toString('base64'));
      used.push({ name, kind: 'image', bytes: bytes.length });
      continue;
    }

    if (!looksTextual(name, bytes)) {
      // Named, not read. The model should know a file arrived even when its
      // contents are not something we can put in a prompt.
      parts.push(`[${name} — ${(bytes.length / 1024).toFixed(0)} KB, not a text file]`);
      used.push({ name, kind: 'file', bytes: bytes.length });
      continue;
    }

    const full = new TextDecoder().decode(bytes);
    const room = Math.max(0, remaining);
    const excerpt = full.length > room ? full.slice(0, room) : full;
    remaining -= excerpt.length;

    // Say so. A model told it has the whole file will answer as if it does.
    const note =
      excerpt.length < full.length
        ? `\n\n[…truncated: showing ${excerpt.length} of ${full.length} characters of ${name}]`
        : '';
    parts.push(`--- ${name} ---\n${excerpt}${note}`);
    used.push({ name, kind: 'text', bytes: bytes.length, truncated: excerpt.length < full.length });
  }

  return { text: parts.join('\n\n'), images, used };
}
