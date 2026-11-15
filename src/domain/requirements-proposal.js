export function requirementsProposalIssues(packet) {
  const invalidFields = [], missingFields = [];
  const check = (field, value, valid) => {
    if (!valid) (value === undefined ? missingFields : invalidFields).push(field);
  };
  const nonEmptyString = value => typeof value === "string" && Boolean(value.trim());
  const questions = packet?.questions, items = packet?.items;
  check("type", packet?.type, packet?.type === "REQUIREMENTS_PROPOSAL");
  check("summary", packet?.summary, typeof packet?.summary === "string");
  check("questions", questions, Array.isArray(questions) && questions.every(nonEmptyString));
  check("items", items, Array.isArray(items) && items.length <= 30);
  if (Array.isArray(questions) && Array.isArray(items) && questions.length + items.length === 0) {
    invalidFields.push("questions_or_items");
  }
  if (Array.isArray(items)) for (const [index, item] of items.slice(0, 30).entries()) {
    for (const field of ["statement", "acceptanceCriteria"]) {
      check("items[" + index + "]." + field, item?.[field], nonEmptyString(item?.[field]));
    }
  }
  return {invalidFields, missingFields};
}
