import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from './database.ts';
import { startBackgroundWorkers } from './background.ts';
import type { Application } from './application.ts';

test('actual migrations allow all maintenance loops to execute and persist stopped heartbeats', async () => {
  const database = await createDatabase({});
  let workers: ReturnType<typeof startBackgroundWorkers> | undefined;
  try {
    await database.migrate();
    const ran = new Set<string>();
    let allRan: () => void = () => {};
    const ready = new Promise<void>(resolve => { allRan = resolve; });
    const mark = (kind: string) => { ran.add(kind); if (ran.size === 5) allRan(); return Promise.resolve({ errors: [] }); };
    const app = {
      database, config: {}, dshBackend: {},
      githubMaintenance: { run: () => mark('github-maintenance') },
      retentionMaintenance: { run: () => mark('retention-maintenance') },
      resourceLinkMaintenance: { runOnce: () => mark('resource-links') },
      planningNotifications: { worker: { runOnce: () => mark('planning-notifications') } },
      organizerNotifications: { drain: () => mark('organizer-notifications') },
    } as unknown as Application;
    workers = startBackgroundWorkers(app);
    const timeout = setTimeout(() => allRan(), 3000);
    try { await ready; } finally { clearTimeout(timeout); }
    assert.equal(ran.size, 5, 'a rejected heartbeat must not silently prevent maintenance work');
    await workers.stop();
    const result = await database.query<{kind:string;status:string}>('SELECT kind,status FROM backend_worker_heartbeats ORDER BY kind');
    assert.deepEqual(result.rows.map(row => row.kind), [...ran].sort());
    assert.ok(result.rows.every(row => row.status === 'stopped'));
    await assert.rejects(database.query("INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at) VALUES('invalid','untrusted-worker','idle',now())"));
  } finally { await workers?.stop(); await database.close(); }
});
