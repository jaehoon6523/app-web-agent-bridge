/**
 * Explicit evidence from a resource owner that closure failed. Operation and
 * rollback aggregates alone never satisfy this contract.
 */
export class ResourceClosureError extends AggregateError {
  /** @param {{resourceOwner:string, failureStage:string, operationError:any,
   * cleanupErrors:any[], cause?:any, errors?:any[],
   * resourceFailures?:Array<{resourceOwner:string, failureStage:string, error:any}>, code?:string}} input */
  constructor({resourceOwner, failureStage, operationError, cleanupErrors,
    cause = operationError, errors = [operationError, ...cleanupErrors], resourceFailures,
    code = "RESOURCE_CLOSURE_FAILED"}) {
    super(errors, "Resource operation and closure failed.", {cause});
    this.name = "ResourceClosureError";
    this.code = code;
    this.resourceClosureFailed = true;
    this.resourceOwner = resourceOwner;
    this.failureStage = failureStage;
    this.operationError = operationError;
    this.cleanupErrors = cleanupErrors;
    this.resourceFailures = resourceFailures ?? cleanupErrors.map(error => ({resourceOwner, failureStage, error}));
  }
}

export function isResourceClosureFailure(error) {
  return error instanceof ResourceClosureError && error.resourceClosureFailed === true;
}
