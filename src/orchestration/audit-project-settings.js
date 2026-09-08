import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readAuditProject, validateAuditProject } from "./audit-project.js";
import { sha256CanonicalJson } from "../domain/canonical-json.js";
import { GitChangeWorkspace } from "../repository/git-change-workspace.js";

export class AuditProjectSettings {
  constructor({ filename, fallbackFile }) {
    this.filename = filename;
    this.current = readAuditProject(fs.existsSync(filename) ? filename : fallbackFile);
  }
  snapshot() {
    return { ...structuredClone(this.current), version: sha256CanonicalJson(this.current) };
  }
  save(project, expectedVersion) {
    if (expectedVersion !== this.snapshot().version) {
      throw Object.assign(new Error("설정이 변경됐습니다. 다시 불러온 뒤 저장하세요."), { code: "PROJECT_VERSION_CONFLICT" });
    }
    const validated = validateAuditProject(project);
    const target = GitChangeWorkspace.inspectTarget(validated.targetRoot);
    validated.targetRoot = target.targetRoot;
    const previous = this.current.project?.requirements;
    if (previous && previous.requirementsId === validated.requirements.requirementsId
      && previous.revision === validated.requirements.revision
      && sha256CanonicalJson(previous) !== sha256CanonicalJson(validated.requirements)) {
      throw new Error("요구사항을 변경했다면 기준 버전도 변경하세요.");
    }
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: "wx" });
      fs.renameSync(temporary, this.filename);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    this.current = { project: validated, error: null };
    return this.snapshot();
  }
}
