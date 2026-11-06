// Serialize index publication per owner while allowing other modules to use SQLite.
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Store } from './store';
import { integer } from './store-values';

export function acquireIndex(store: Store): () => void {
  return acquire(store, 'arachne_index_jobs');
}

export function acquireBackup(store: Store): () => void {
  return acquire(store, 'arachne_backup_jobs');
}

function acquire(store: Store, table: 'arachne_index_jobs' | 'arachne_backup_jobs'): () => void {
  const db = store.db;
  const lease = randomUUID();
  db.transaction(() => {
    const current = db
      .prepare(`SELECT process_id FROM ${table} WHERE project=? AND agent=?`)
      .get(store.project, store.agent) as { process_id: unknown } | undefined;
    if (current && isAlive(integer(current.process_id, 'index worker process', 2147483647))) {
      throw new Error('Maintenance is already running for this project and agent');
    }
    db.prepare(
      `INSERT OR REPLACE INTO ${table}(project,agent,lease_id,process_id) VALUES(?,?,?,?)`,
    ).run(store.project, store.agent, lease, process.pid);
  }).immediate();
  return () => {
    const connection = db.open ? db : new Database(store.dbPath, { timeout: 5000 });
    try {
      connection
        .prepare(`DELETE FROM ${table} WHERE project=? AND agent=? AND lease_id=?`)
        .run(store.project, store.agent, lease);
    } finally {
      if (connection !== db) connection.close();
    }
  };
}

function isAlive(pid: number): boolean {
  if (pid === 0) throw new Error('Invalid index worker process');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error('Unable to verify the existing index worker');
  }
}
