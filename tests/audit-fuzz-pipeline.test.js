import { registerAuditFuzzPipeline } from "./helpers/audit-fuzz-pipeline.js";

// Explicit replay keeps the original audit-fuzz.test.js entry point.
if (!process.env.AUDIT_FUZZ_CASE) registerAuditFuzzPipeline(1);
