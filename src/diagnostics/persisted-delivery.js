import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { classifyDeliveryOwnership } from '../orchestration/delivery-ownership.js';
import { diagnosticId, diagnosticToken, diagnosticFlag } from './diagnostic-schema.js';
const fail = code => Object.assign(new Error(code),{code});
const conversationKey = value => typeof value === 'string' && /^https:\/\/chatgpt\.com\/(?:c\/[a-f0-9-]{36})?$/u.test(value)
  ? createHash('sha256').update(value).digest('hex') : null;
async function readFile(filename, read) {
  if (!fs.existsSync(filename)) return {status:'ABSENT',records:[]};
  // Import lazily: the CLI and diagnostic bootstrap do not require SQLite startup.
  const { DatabaseSync } = await import('../persistence/sqlite-database.js');
  const db = new DatabaseSync(filename,{readOnly:true});
  try {db.exec('PRAGMA busy_timeout=0; BEGIN'); return {status:'OBSERVED',records:read(db)};}
  finally {db.close();}
}
const has = (db, table) => db.prepare('SELECT name FROM sqlite_schema WHERE type=\'table\' AND name=?').all(table).length > 0;
function preparationRows(db, expected) {
  if (!has(db,'preparation_state')) throw fail('DIAGNOSTIC_SCHEMA_UNAVAILABLE');
  return db.prepare(`SELECT 'PREPARATION' AS kind, json_extract(d.value,'$.deliveryId') AS deliveryId,
    COALESCE(json_extract(d.value,'$.sessionId'),json_extract(c.value,'$.webSession.sessionId')) AS sessionId,
    json_extract(c.value,'$.preparationId') AS runId, json_extract(c.value,'$.webSession.conversationUrl') AS conversationUrl,
    json_extract(c.value,'$.webSession.activeDeliveryId') IS json_extract(d.value,'$.deliveryId') AS active,
    json_extract(d.value,'$.state') AS state, json_extract(d.value,'$.processingState') AS processingState,
    json_type(d.value,'$.response') NOT IN ('null') AS responseStored
    FROM preparation_state p, json_each(p.json,'$.contexts') c, json_each(c.value,'$.deliveries') d
    WHERE json_extract(d.value,'$.deliveryId') = ? OR
      (COALESCE(json_extract(d.value,'$.sessionId'),json_extract(c.value,'$.webSession.sessionId')) = ?
        AND json_extract(c.value,'$.webSession.activeDeliveryId') = json_extract(d.value,'$.deliveryId')) OR
      (? IS NULL AND json_extract(c.value,'$.webSession.activeDeliveryId') = json_extract(d.value,'$.deliveryId')) LIMIT 33`)
    .all(expected.currentDeliveryId,expected.sessionId,expected.currentDeliveryId);
}
function controllerRows(db, expected) {
  const records = [];
  if (has(db,'code_change_runs')) {
    records.push(...db.prepare(`SELECT 'REVIEW' AS kind, json_extract(r.value,'$.deliveryId') AS deliveryId,
      json_extract(r.value,'$.sessionId') AS sessionId, json_extract(c.record_json,'$.runId') AS runId,
      json_extract(r.value,'$.conversationUrl') AS conversationUrl,
      json_extract(b.value,'$.activeDeliveryId') IS json_extract(r.value,'$.deliveryId') AS active,
      json_extract(r.value,'$.state') AS state, json_extract(r.value,'$.state') AS processingState, 1 AS responseStored
      FROM code_change_runs c, json_each(c.record_json,'$.conversationBindings') b,
        json_each(c.record_json,'$.webDeliveryReceipts') r
      WHERE json_extract(b.value,'$.sessionId') = json_extract(r.value,'$.sessionId')
        AND (json_extract(r.value,'$.deliveryId') = ? OR
          (json_extract(b.value,'$.sessionId') = ? AND json_extract(b.value,'$.activeDeliveryId') = json_extract(r.value,'$.deliveryId')) OR
          (? IS NULL AND json_extract(b.value,'$.activeDeliveryId') = json_extract(r.value,'$.deliveryId'))) LIMIT 33`)
      .all(expected.currentDeliveryId,expected.sessionId,expected.currentDeliveryId));
    records.push(...db.prepare(`SELECT 'REVIEW' AS kind, json_extract(b.value,'$.activeDeliveryId') AS deliveryId,
      json_extract(b.value,'$.sessionId') AS sessionId, json_extract(c.record_json,'$.runId') AS runId,
      json_extract(b.value,'$.conversationUrl') AS conversationUrl, 1 AS active,
      'UNRESOLVED' AS state, NULL AS processingState, 0 AS responseStored
      FROM code_change_runs c, json_each(c.record_json,'$.conversationBindings') b
      WHERE json_extract(b.value,'$.activeDeliveryId') IS NOT NULL AND
        (json_extract(b.value,'$.activeDeliveryId') = ? OR json_extract(b.value,'$.sessionId') = ? OR ? IS NULL)
        AND NOT EXISTS (SELECT 1 FROM json_each(c.record_json,'$.webDeliveryReceipts') r
          WHERE json_extract(r.value,'$.deliveryId') = json_extract(b.value,'$.activeDeliveryId')
            AND json_extract(r.value,'$.sessionId') = json_extract(b.value,'$.sessionId')) LIMIT 33`)
      .all(expected.currentDeliveryId,expected.sessionId,expected.currentDeliveryId));
  }
  if (has(db,'delivery_attempts') && has(db,'agent_sessions')) {
    records.push(...db.prepare(`SELECT 'DISCUSSION' AS kind, d.delivery_id AS deliveryId,
      json_extract(d.provider_receipt_json,'$.sessionBinding.sessionId') AS sessionId, d.run_id AS runId,
      json_extract(d.provider_receipt_json,'$.sessionBinding.externalSessionId') AS conversationUrl,
      json_extract(s.session_json,'$.activeTurnId') = json_extract(d.provider_receipt_json,'$.externalTurnId') AS active,
      d.state AS state, NULL AS processingState, NULL AS responseStored
      FROM delivery_attempts d LEFT JOIN agent_sessions s
        ON s.session_id = json_extract(d.provider_receipt_json,'$.sessionBinding.sessionId')
      WHERE d.delivery_id = ? OR (? IS NULL AND
        json_extract(s.session_json,'$.activeTurnId') = json_extract(d.provider_receipt_json,'$.externalTurnId'))
        LIMIT 33`).all(expected.currentDeliveryId,expected.currentDeliveryId));
  }
  if (!has(db,'code_change_runs') && !has(db,'delivery_attempts')) throw fail('DIAGNOSTIC_SCHEMA_UNAVAILABLE');
  return records;
}
function receiptMatches(value, expected) {
  return value?.deliveryId === expected.currentDeliveryId && value?.sessionId === expected.sessionId
    && value?.runId === expected.runId && value?.conversationUrl === expected.conversationUrl;
}
/** Read metadata only. This never constructs a runtime, migrates a store or mutates ownership. */
export async function readPersistedDelivery({databasePath,preparationPath}, observed) {
  const expected = {...observed,currentDeliveryId:observed?.currentDeliveryId ?? observed?.lastAcknowledgedDelivery?.deliveryId
    ?? observed?.lastDeliveryDiscard?.deliveryId};
  const observedAt = new Date().toISOString();
  const hasOwner = Boolean(expected.currentDeliveryId);
  if (!hasOwner) Object.assign(expected,{currentDeliveryId:null,sessionId:null,runId:null});
  if (hasOwner && (![expected.currentDeliveryId,expected.sessionId,expected.runId].every(diagnosticId) || !conversationKey(expected.conversationUrl)))
    return {source:'READ_ONLY_SQLITE',observedAt,status:'UNAVAILABLE',reason:'DELIVERY_IDENTITY_INCOMPLETE',records:null};
  const reads = await Promise.allSettled([readFile(preparationPath,db => preparationRows(db,expected)),
    readFile(databasePath,db => controllerRows(db,expected))]);
  const sources = reads.map((r,index) => ({source:index === 0 ? 'PREPARATION_STORE' : 'CONTROLLER_STORE',
    status:r.status === 'fulfilled' ? r.value.status : 'UNAVAILABLE',
    code:r.status === 'rejected' ? diagnosticToken(r.reason?.code) ?? 'PERSISTED_DELIVERY_READ_FAILED' : null}));
  const records = reads.flatMap(r => r.status === 'fulfilled' ? r.value.records : [])
    .map(r => ({...r,active:r.active == null ? null : Boolean(r.active),responseStored:r.responseStored == null ? null : Boolean(r.responseStored)}));
  const complete = sources.every(s => s.status !== 'UNAVAILABLE') && records.length < 33;
  const classification = complete ? hasOwner ? classifyDeliveryOwnership(expected,records) : {status:'SERVER_ONLY',records}
    : {status:'UNAVAILABLE',records};
  const exact = classification.status === 'MATCHED';
  const ackConfirmed = observed?.currentDeliveryId == null && receiptMatches(observed?.lastAcknowledgedDelivery,expected);
  const discardConfirmed = observed?.currentDeliveryId == null && receiptMatches(observed?.lastDeliveryDiscard,expected);
  return {source:'READ_ONLY_SQLITE',observedAt,status:classification.status,
    extensionStatus:observed ? 'OBSERVED' : 'UNAVAILABLE',
    reason:complete ? hasOwner ? null : observed ? 'NO_EXTENSION_OWNER' : 'EXTENSION_UNAVAILABLE' : records.length >= 33 ? 'DELIVERY_RECORDS_TRUNCATED' : 'PERSISTED_DELIVERY_READ_FAILED',sources,
    expected:{deliveryId:diagnosticId(expected.currentDeliveryId),sessionId:diagnosticId(expected.sessionId),runId:diagnosticId(expected.runId),
      conversationKey:conversationKey(expected.conversationUrl)},
    ackConfirmed,discardConfirmed,recordIntegrity:'NOT_VERIFIED',artifactIntegrity:'NOT_VERIFIED',
    assessment:!hasOwner && records.some(r => r.active === true) ? 'SERVER_ACTIVE_EXTENSION_OWNER_UNCONFIRMED' : exact && records[0].active === false && observed.currentDeliveryId === expected.currentDeliveryId
      ? 'SERVER_SETTLED_EXTENSION_OWNED' : exact && ackConfirmed ? 'ACK_RECEIPT_OBSERVED' : exact && discardConfirmed
        ? 'DISCARD_RECEIPT_OBSERVED' : classification.status === 'MISMATCH' ? 'DELIVERY_IDENTITY_CONFLICT' : 'REVIEW_DELIVERY_EVIDENCE',
    records:classification.records.slice(0,32).map(r => ({kind:diagnosticToken(r.kind),deliveryId:diagnosticId(r.deliveryId),
      sessionId:diagnosticId(r.sessionId),runId:diagnosticId(r.runId),conversationKey:conversationKey(r.conversationUrl),
      active:diagnosticFlag(r.active),state:diagnosticToken(r.state),processingState:diagnosticToken(r.processingState),
      responseStored:diagnosticFlag(r.responseStored)}))};
}
