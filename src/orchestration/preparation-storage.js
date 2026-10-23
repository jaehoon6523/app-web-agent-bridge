import {Worker} from 'node:worker_threads';

export async function openStoredPreparation(options, create) {
  const storage = await openPreparationStorage(options.filename);
  let service;
  try {
    service = create({...options, storage});
    await service.saveImmediate();
    return service;
  } catch (error) {
    try { await (service ? service.close() : storage.close()); }
    catch (cleanup) { throw Object.assign(new AggregateError([error,cleanup], 'Preparation initialization and close failed'),
      {resourceClosureFailed:cleanup.resourceClosureFailed === true}); }
    throw error;
  }
}

const restore = value => Object.assign(value.errors
  ? new AggregateError(value.errors.map(restore), value.message)
  : new Error(value.message), {...value, ...(value.cause ? {cause:restore(value.cause)} : {}),
    ...(value.errors ? {errors:value.errors.map(restore)} : {})});

export async function openPreparationStorage(filename, {timeoutMs = 8000, terminationMs = 2000} = {}) {
  const worker = new Worker(new URL('./preparation-storage-worker.js', import.meta.url),
    {workerData:{filename}, execArgv:process.execArgv.filter(arg => !arg.startsWith('--input-type'))});
  const requests = new Map();
  let sequence = 0, failure, closing, exitCode, pending = Promise.resolve();
  const bounded = async (promise, ms, phase) => {
    let timer;
    try {
      return await Promise.race([promise,new Promise((_,reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Preparation storage deadline exceeded.'),
          {code:'PREPARATION_STORAGE_TIMEOUT',phase})),ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  const fail = error => {
    failure ??= error;
    for (const request of requests.values()) request.reject(failure);
    requests.clear();
  };
  const ready = new Promise((resolve,reject) => requests.set(0,{resolve,reject}));
  worker.on('message', message => {
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    if (message.error) request.reject(restore(message.error));
    else request.resolve(message.value);
  });
  worker.on('error', fail);
  const exited = new Promise(resolve => worker.once('exit', code => {
    exitCode = code;
    fail(Object.assign(new Error('Preparation storage worker exited.'), {code:'PREPARATION_STORAGE_EXIT', exitCode:code}));
    resolve(code);
  }));
  const finishFailure = async errors => {
    if (exitCode === undefined) {
      fail(errors[0]);
      const forced = Object.assign(new Error('Preparation storage required forced cleanup.'),
        {code:'PREPARATION_STORAGE_FORCED_CLEANUP',resourceClosureFailed:true,terminationConfirmed:false});
      errors.push(forced);
      try {
        await bounded(worker.terminate(),terminationMs,'terminate');
        forced.terminationConfirmed = exitCode !== undefined;
      } catch (error) { errors.push(error); worker.unref(); }
    }
    if (exitCode !== undefined && exitCode !== 0) errors.push(Object.assign(new Error('Preparation storage exited abnormally.'),
      {code:'PREPARATION_STORAGE_EXIT',exitCode,resourceClosureFailed:true}));
    const distinct = [...new Set(errors)];
    const error = distinct.length === 1 ? distinct[0] : new AggregateError(distinct,'Preparation storage operation and closure failed');
    if (distinct.some(item => item.resourceClosureFailed)) error.resourceClosureFailed = true;
    throw error;
  };
  const call = message => {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return bounded(new Promise((resolve,reject) => {
      requests.set(id,{resolve,reject});
      try { worker.postMessage({id,...message}); }
      catch (error) { requests.delete(id); reject(error); }
    }),timeoutMs,message.type).catch(error => {
      requests.delete(id);
      if (error.code === 'PREPARATION_STORAGE_TIMEOUT') fail(error);
      throw error;
    });
  };
  let data;
  try { data = await bounded(ready,timeoutMs,'initialize'); }
  catch (error) {
    const errors = [error];
    try { await bounded(exited,terminationMs,'initialization-exit'); }
    catch (cleanup) { errors.push(cleanup); }
    return finishFailure(errors);
  }
  return {
    data,
    persist(json, committed = () => {}, wait = true) {
      if (closing) return Promise.reject(Object.assign(new Error('Preparation storage closed.'), {code:'PREPARATION_CLOSED'}));
      const operation = async () => {
        await call({type:'write',json:json(),wait});
        committed();
      };
      pending = pending.then(operation,operation);
      void pending.catch(() => {});
      return pending;
    },
    close() {
      return closing ??= (async () => {
        const errors = [];
        const graceful = (async () => {
          try { await pending; } catch (error) { errors.push(error); }
          try { await call({type:'close'}); } catch (error) { errors.push(error); }
          await exited;
        })();
        try { await bounded(graceful,timeoutMs,'close'); }
        catch (error) { errors.push(error); }
        if (errors.length || exitCode !== 0) return finishFailure(errors);
      })();
    },
  };
}
