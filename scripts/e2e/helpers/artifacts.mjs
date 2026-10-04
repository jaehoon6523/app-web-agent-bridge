import fs from 'node:fs';
import path from 'node:path';

// Each file is a separate finalizer: one write failure cannot skip later evidence.
export function addArtifactWrites(owner, output, artifacts, phase = 90) {
  for (const [name, content] of artifacts) {
    owner.add(`artifact ${name}`, errors => fs.writeFileSync(path.join(output, name), content(errors)), phase);
  }
}
