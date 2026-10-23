import fs from 'node:fs';
import path from 'node:path';
import {parentPort, workerData} from 'node:worker_threads';
import {DatabaseSync} from '../persistence/sqlite-database.js';
import {persistPreparation} from './preparation-persistence.js';

let db;
const describe = error => ({message:error.message, code:error.code, errcode:error.errcode,
  errstr:error.errstr, stack:error.stack,
  errors:error.errors?.map(describe), cause:error.cause ? describe(error.cause) : undefined});
try {
  fs.mkdirSync(path.dirname(workerData.filename), {recursive:true});
  db = new DatabaseSync(workerData.filename);
  db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS preparation_state (id INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT;');
  const row = db.prepare('SELECT json FROM preparation_state WHERE id=1').get();
  parentPort.postMessage({id:0, value:row ? JSON.parse(String(row.json)) : null});
} catch (error) {
  try { db?.close(); } catch (cleanup) { error = new AggregateError([error,cleanup], 'Preparation initialization and close failed'); }
  parentPort.postMessage({id:0, error:describe(error)});
  parentPort.close();
}

// Serialize commands even when SQLite BUSY retries yield the worker's event loop.
let pending = Promise.resolve();
parentPort.on('message', message => {
  pending = pending.then(async () => {
    try {
      if (message.type === 'close') {
        db.close();
        parentPort.postMessage({id:message.id});
        parentPort.close();
      } else {
        if (message.wait) await persistPreparation(db, () => message.json, () => {}, () => false);
        else db.prepare('INSERT INTO preparation_state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(message.json);
        parentPort.postMessage({id:message.id});
      }
    } catch (error) {
      parentPort.postMessage({id:message.id, error:describe(error)});
      if (message.type === 'close') parentPort.close();
    }
  });
});
