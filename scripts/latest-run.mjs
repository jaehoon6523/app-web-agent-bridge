import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export function acquireLatestRun(directory, name, runId = randomUUID()) {
  if (!/^[a-z0-9-]+$/u.test(name) || !/^[a-zA-Z0-9_-]{1,100}$/u.test(runId)) throw Error('INVALID_RUN_ID');
  fs.mkdirSync(directory,{recursive:true});
  const lockFile = path.join(directory,`.${name}.owner.json`), token = randomUUID();
  // A native database transaction owns the lease. Its release does not depend
  // on deleting a marker file, and process exit closes the operating-system lock.
  const database = new DatabaseSync(path.join(directory,`.${name}.lock.sqlite`));
  try {
    database.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;');
  } catch (error) {
    database.close();
    if (error.errcode === 5 || error.errcode === 6 || /(?:locked|busy)/iu.test(error.message))
      throw Object.assign(Error('LATEST_RUN_BUSY: '+lockFile),{code:'LATEST_RUN_BUSY'});
    throw error;
  }
  const owner = {runId,token,pid:process.pid,active:true};
  try { fs.writeFileSync(lockFile,JSON.stringify(owner)); }
  catch (error) { database.exec('ROLLBACK'); database.close(); throw error; }
  return {runId,token,lockFile, release() {
    try {
      if (JSON.parse(fs.readFileSync(lockFile,'utf8')).token !== token) throw Error('LATEST_RUN_LOCK_CHANGED');
      fs.writeFileSync(lockFile,JSON.stringify({...owner,active:false}));
    } finally { try { database.exec('ROLLBACK'); } finally { database.close(); } }
  }};
}

// A browser subprocess joins its parent's lease; independent runs cannot clear
// another run's logs or profile. Completed owner metadata is not a held lease.
export function beginDiagnostics(directory, runId, parentToken) {
  const lockFile = path.join(directory,'.diagnostics.owner.json');
  if (parentToken) {
    const owner = JSON.parse(fs.readFileSync(lockFile,'utf8'));
    if (!owner.active || owner.runId !== runId || owner.token !== parentToken) throw Error('DIAGNOSTIC_LEASE_MISMATCH');
    return {token:parentToken, release() {}};
  }
  const lease = acquireLatestRun(directory,'diagnostics',runId);
  try {
    fs.rmSync(path.join(directory,'latest-diagnostics'),{recursive:true,force:true});
    fs.rmSync(path.join(directory,'diagnostic-runs'),{recursive:true,force:true});
    for (const name of ['latest-windows-diagnostics.json','latest-windows-diagnostics.log',
      'latest-direct-chromium-reload.json','latest-ack-windows-result.json','latest-diagnostic-regression.json'])
      fs.rmSync(path.join(directory,name),{force:true});
    return lease;
  } catch (error) { lease.release(); throw error; }
}
