/**
 * Boot. Everything interesting is in `app.js`.
 */

import { PORT, HOST } from './config.js';
import { createApp, VERSION } from './app.js';
import { startScheduler } from './tasks/Scheduler.js';
import { listTasks } from './tasks/Tasks.js';

const { app, home, config, quietWork } = await createApp();
const { shutdown: closeConnectors } = await import('./connectors/Connectors.js');
// Local connectors are child processes. They leave when Reflect does.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => closeConnectors().finally(() => process.exit(0)));

// The scheduler belongs to the running server, not to createApp: the tests
// build apps constantly and none of them should start a clock.
const server = app.listen(PORT, HOST, async () => {
  // The port that was actually bound, which is not always the one that was
  // asked for — the desktop shell passes 0 and takes whatever is free. Anything
  // that needs to call the server from inside the server reads this rather than
  // rebuilding the address from a constant that may be stale.
  const { port } = server.address();
  app.set('selfUrl', `http://127.0.0.1:${port}`);

  console.log(`\n  Reflect ${VERSION}`);
  console.log(`  http://localhost:${port}`);
  console.log(`  home   ${home.where}`);
  console.log(`  model  ${config.model || 'none — start a runtime and reload'}`);
  if (HOST !== '127.0.0.1') console.log(`  bind   ${HOST} — reachable from your network`);

  const scheduled = (await listTasks()).filter((t) => t.valid && t.enabled && t.schedule.kind !== 'manual');
  if (scheduled.length) {
    console.log(`  tasks  ${scheduled.map((t) => `${t.name} (${t.schedule.text})`).join(', ')}`);
  }
  console.log('');

  startScheduler({
    baseUrl: app.get('selfUrl'),
    onQuiet: quietWork,
    onRun: (run) =>
      console.log(run.ok ? `  ran task ${run.name}` : `  task ${run.name} failed: ${run.error}`),
  });
});
