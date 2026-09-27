/**
 * The desktop shell.
 *
 * Reflect is a local web app and stays one: this process starts the same
 * Express server `npm start` would, on a port the OS picks, and points a window
 * at it. There is no second implementation of anything, and running from a
 * terminal remains a first-class way to use it.
 *
 * The shell exists for one reason that a browser tab cannot supply — **being
 * running**. A scheduled task only fires while the server is up, and before
 * this, "every day at 09:00" honestly meant "if a terminal happens to be open
 * at nine". Closing the window therefore hides it rather than quitting; the
 * tray is how you get it back, and Quit is how you mean it.
 *
 * The server runs in this process rather than as a child. It is one less thing
 * to supervise, kill, and orphan, and the lifetimes are identical anyway — if
 * the shell is gone there is nobody to serve. The cost is that an unhandled
 * throw in either takes both, which is why the crash handlers below tell the
 * user rather than vanishing.
 */

import { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } from 'electron';
import path from 'node:path';
import { trayIconPng } from './icon.js';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Set once the server is listening; everything else waits for it. */
let baseUrl = null;
let win = null;
let tray = null;
let quitting = false;

// Two copies would race for the same memory folder, and both would start a
// scheduler — every task would run twice. The second instance hands its
// argv to the first and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  main();
}

async function main() {
  await app.whenReady();

  try {
    baseUrl = await startServer();
  } catch (err) {
    dialog.showErrorBox('Reflect could not start', String(err?.stack || err));
    app.quit();
    return;
  }

  createWindow();
  createTray();

  // macOS: clicking the dock icon with no windows open should reopen one
  // rather than doing nothing.
  app.on('activate', () => showWindow());
}

/**
 * Start the Express app on a port the OS chooses.
 *
 * Port 0 rather than 3040 because a packaged app must not fail to start
 * because something else took a number — and because two Reflects, one from a
 * terminal and one from the icon, should be able to coexist.
 */
async function startServer() {
  const { createApp } = await import('../src/app.js');
  const { startScheduler } = await import('../src/tasks/Scheduler.js');

  const { app: expressApp, quietWork } = await createApp();

  return new Promise((resolve, reject) => {
    const server = expressApp.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      expressApp.set('selfUrl', url);
      // The whole point of the shell: the clock runs because the app is open.
      startScheduler({ baseUrl: url, onQuiet: quietWork });
      console.log(`Reflect serving ${url}`);
      resolve(url);
    });
    server.on('error', reject);
  });
}

function createWindow(hash = '') {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 520,
    minHeight: 480,
    title: 'Reflect',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Pinned rather than left to the default, so the page can reserve exactly
    // the right amount of room for them. Unpinned they sat on top of the
    // Reflect mark in the sidebar.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 15 } } : {}),
    backgroundColor: '#f7f7f8',
    // Nothing in the page needs Node, and the page renders model output.
    // Keeping the renderer sandboxed means a prompt injection that reaches the
    // DOM is still only in a browser tab.
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  win.loadURL(baseUrl + hash);

  // Tell the page it is inside the shell, and which one. The same HTML is
  // served to an ordinary browser, where there are no traffic lights to avoid
  // and no title bar to stand in for — so this cannot be baked into the CSS.
  // Set on dom-ready rather than once, so it survives a reload.
  win.webContents.on('dom-ready', () => {
    win.webContents
      .executeJavaScript(`document.documentElement.dataset.shell = ${JSON.stringify(process.platform)}`)
      .catch(() => {});
  });

  // Closing is hiding, so that tasks keep their clock. Quit means quit.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });

  // A link to somewhere else belongs in the user's real browser, with their
  // extensions and their session — not in a chrome-less window with no address
  // bar, which is the shape phishing likes.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(baseUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

function showWindow(hash = '') {
  if (!win || win.isDestroyed()) createWindow(hash);
  else {
    win.show();
    win.focus();
    // Already open on a conversation: ask the page to switch rather than
    // reloading it, which would throw away whatever is on screen.
    if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
  }
}

function createTray() {
  const icon = nativeImage.createFromBuffer(trayIconPng(32));
  // The alpha channel carries the shape and every pixel is black, which is what
  // lets macOS tint it — without this the icon is a black smudge on a dark
  // menu bar.
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Reflect');
  tray.on('click', () => showWindow());
  refreshTrayMenu();

  // The menu is the only place the schedule is visible without opening the
  // window, so it has to age. A minute is well under the shortest cadence a
  // task can have.
  setInterval(refreshTrayMenu, 60_000).unref?.();
}

/** "in 20 min", "tomorrow 09:00" — the same question the Tasks screen answers. */
function whenNext(iso) {
  const then = new Date(iso);
  const mins = Math.round((then - Date.now()) / 60000);
  if (mins < 1) return 'due now';
  if (mins < 60) return `in ${mins} min`;
  const clock = then.toTimeString().slice(0, 5);
  const days = Math.round((new Date(then).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  return `${then.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
}

/**
 * What is scheduled, shown where being-running is the whole point.
 *
 * The tray exists because a task only fires while Reflect is up. Saying nothing
 * about the schedule made it a launcher with a Quit button — you could not tell
 * from the menu bar whether leaving it running was buying you anything.
 *
 * Read over HTTP from the server in this process rather than from the task
 * files: it is the same list the Tasks screen shows, computed once, so the two
 * cannot disagree about what "next" means.
 */
async function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;

  let scheduled = [];
  try {
    const res = await fetch(`${baseUrl}/api/tasks`);
    const { tasks } = await res.json();
    scheduled = tasks
      .filter((t) => t.valid && t.enabled && t.nextRun)
      .sort((a, b) => new Date(a.nextRun) - new Date(b.nextRun));
  } catch {
    // The server is in this process, so this only fails while it is still
    // coming up. An empty schedule is the right thing to show meanwhile.
  }

  const next = scheduled[0];
  const summary = !scheduled.length
    ? { label: 'Nothing scheduled', enabled: false }
    : { label: `Next: ${next.name} — ${whenNext(next.nextRun)}`, enabled: false };

  tray.setToolTip(
    scheduled.length
      ? `Reflect — ${scheduled.length} task${scheduled.length === 1 ? '' : 's'} scheduled`
      : 'Reflect'
  );

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Reflect', click: () => showWindow() },
      { label: 'Tasks…', click: () => showWindow('#tasks') },
      { type: 'separator' },
      summary,
      ...scheduled.slice(1, 4).map((t) => ({
        label: `        ${t.name} — ${whenNext(t.nextRun)}`,
        enabled: false,
      })),
      { type: 'separator' },
      {
        label: 'Open memory folder',
        click: async () => {
          const { homePath } = await import('../src/config.js');
          shell.openPath(homePath());
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Reflect',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

// Hiding the window must not end the process — that is what keeps the
// scheduler alive. Quit is the only way out, and on Windows and Linux the tray
// is what makes that discoverable.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  // Local connectors are child processes; they leave when Reflect does.
  import('../src/connectors/Connectors.js').then((c) => c.shutdown()).catch(() => {});
  quitting = true;
});

// The server shares this process, so an unhandled throw would otherwise take
// the app down with no explanation at all.
process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Reflect hit an error', String(err?.stack || err));
});
process.on('unhandledRejection', (err) => {
  dialog.showErrorBox('Reflect hit an error', String(err?.stack || err));
});
