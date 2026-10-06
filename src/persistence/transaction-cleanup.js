// A failed rollback is a second failure, never evidence of a safe retry.
export function rollbackAfterFailure(database, primary, message) {
  try { database.exec("ROLLBACK"); }
  catch (cleanup) { throw new AggregateError([primary, cleanup], message, {cause:primary}); }
  throw primary;
}
