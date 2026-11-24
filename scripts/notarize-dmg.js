#!/usr/bin/env node
/**
 * Sign, notarize and staple the Mac disk image.
 *
 * electron-builder signs and notarizes the app inside the disk image, but not
 * the disk image itself — and a downloaded .dmg is checked by Gatekeeper
 * before anyone sees the app in it. An unsigned one is reported as "no usable
 * signature", which is exactly the warning signing was meant to end.
 *
 *   APPLE_KEYCHAIN_PROFILE=<notarytool profile> node scripts/notarize-dmg.js
 *
 * The signing identity is the Developer ID Application certificate already in
 * the keychain; nothing about who signs is written into this repository. With
 * no profile set it stops and says so, rather than leaving a half-signed image.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });

const profile = process.env.APPLE_KEYCHAIN_PROFILE;
if (!profile) {
  console.error('Set APPLE_KEYCHAIN_PROFILE to a stored notarytool profile (xcrun notarytool store-credentials).');
  process.exit(1);
}

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const releaseDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'release');
const dmgs = fs.readdirSync(releaseDir).filter((f) => f.endsWith('.dmg') && f.includes(version));
if (!dmgs.length) {
  console.error(`No disk image for ${version} in release/. Run npm run dist first.`);
  process.exit(1);
}

// The certificate's SHA-1, so the person's name never has to appear here.
const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
const match = identities.split('\n').find((l) => l.includes('Developer ID Application'));
const identity = match?.match(/\b[0-9A-F]{40}\b/)?.[0];
if (!identity) {
  console.error('No Developer ID Application certificate in the keychain.');
  process.exit(1);
}

for (const name of dmgs) {
  const dmg = path.join(releaseDir, name);
  console.log(`signing    ${name}`);
  run('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, dmg]);
  console.log('notarizing (this waits for Apple)');
  run('/usr/bin/xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait'], { stdio: 'inherit' });
  run('/usr/bin/xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  // The check a downloaded image actually gets.
  const verdict = execFileSync('/usr/sbin/spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', dmg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(verdict.trim() || 'accepted');
}
