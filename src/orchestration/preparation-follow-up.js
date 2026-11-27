const MAX_FOLLOW_UP_HANDOFF_NOTES = 20;
const MAX_FOLLOW_UP_HANDOFF_CHARS = 12_000;
export function followUpHandoffNotes(prior) {
  const valid = (Array.isArray(prior?.operatorNotes) ? prior.operatorNotes : [])
    .filter((note) => ["NOTE","DECISION"].includes(note?.kind)
      && typeof note?.text === "string" && note.text.trim())
    .map((note) => ({
      noteId:typeof note.noteId === "string" ? note.noteId : null,
      kind:note.kind,
      text:note.text.trim(),
      phase:typeof note.phase === "string" ? note.phase : null,
      candidateId:typeof note.candidateId === "string" ? note.candidateId : null,
      createdAt:typeof note.createdAt === "string" ? note.createdAt : null,
    }));
  const selected = [];
  let chars = 0;
  for (let index = valid.length - 1; index >= 0 && selected.length < MAX_FOLLOW_UP_HANDOFF_NOTES; index--) {
    const note = valid[index];
    if (chars + note.text.length > MAX_FOLLOW_UP_HANDOFF_CHARS) break;
    selected.push(note);
    chars += note.text.length;
  }
  selected.reverse();
  return {
    items:selected,
    totalCount:valid.length,
    omittedCount:Math.max(0, valid.length - selected.length),
  };
}
