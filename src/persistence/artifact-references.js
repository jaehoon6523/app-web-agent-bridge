function collect(value, hashes) {
  if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)) hashes.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collect(item, hashes));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collect(item, hashes));
}

export function listArtifactHashesEntity(database, runId = null) {
  const rows = runId === null
    ? database.prepare("SELECT payload_json FROM domain_events").all()
    : database.prepare("SELECT payload_json FROM domain_events WHERE run_id = ?").all(runId);
  const hashes = new Set();
  for (const row of rows) collect(JSON.parse(row.payload_json), hashes);
  return hashes;
}
