import { DatabaseSync as NativeDatabaseSync } from "node:sqlite";

// Node 22.5's get() returns an object of NULL columns for an empty result.
// Normalize only that affected runtime at the actual persistence boundary;
// all() preserves real SQLite rows, including legitimate nullable columns.
const needsEmptyRowCompatibility = /^22\.5\./u.test(process.versions.node);

export class DatabaseSync extends NativeDatabaseSync {
  prepare(sql) {
    const statement = super.prepare(sql);
    if (needsEmptyRowCompatibility) {
      statement.get = (...parameters) => statement.all(...parameters)[0];
    }
    return statement;
  }
}
