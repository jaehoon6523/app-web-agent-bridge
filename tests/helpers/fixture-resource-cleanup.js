// Keep the operation failure and independent resource-cleanup failures intact.
// Do not delete a fixture while child closure remains unconfirmed.
export async function waitForResourceOwner(waitForChild, ownerClosed, timeoutMs = 1500) {
  const childClosure = await waitForChild();
  let timer;
  try {
    await Promise.race([ownerClosed,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Object.assign(new Error('RESOURCE_OWNER_CLOSE_UNCONFIRMED'),
        {code:'RESOURCE_OWNER_CLOSE_UNCONFIRMED'})),timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
  return childClosure;
}

export async function settleFixture({operationError = null, stop = null, cleanup, observe = () => {}}) {
  let stopError = null;
  let cleanupError = null;
  let observationError = null;
  let closeConfirmed = stop == null;
  if (stop != null) {
    try { await stop(); closeConfirmed = true; }
    catch (error) { stopError = error; }
  }
  if (closeConfirmed) {
    try { await cleanup(); }
    catch (error) {
      cleanupError = error;
      try { observe({phase:'cleanup-failed',error,closeConfirmed}); }
      catch (observerError) { observationError = observerError; }
    }
  } else {
    try { observe({phase:'cleanup-skipped',error:stopError,closeConfirmed}); }
    catch (observerError) { observationError = observerError; }
  }
  const errors = [operationError,stopError,cleanupError,observationError].filter(Boolean);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors,'Fixture operation/closure/cleanup failed');
}
