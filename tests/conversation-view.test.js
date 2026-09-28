import assert from "node:assert/strict";
import test from "node:test";

import { renderConversation } from "../public/conversation-view.js";

function fakeNode(tag, value = "", className = "") {
  return {
    tag,
    textContent:value,
    className,
    children:[],
    append(...items) { this.children.push(...items); },
  };
}

function fakeTimeline() {
  return {
    children:[],
    replaceChildren() { this.children = []; },
    append(...items) { this.children.push(...items); },
  };
}

test("conversation projection keeps controller packets and technical identities out of the human timeline", () => {
  const assertions = JSON.stringify({
    type:"REVIEW_ASSERTIONS",
    runId:"run-1",
    requestId:"audit-1",
    candidateId:"candidate-secret",
    auditManifestHash:"sha256:secret",
    assessments:[
      { requirementId:"R1", verdict:"SATISFIED", evidenceRefs:["e1"] },
      { requirementId:"R2", verdict:"SATISFIED", evidenceRefs:["e1"] },
    ],
    findingDecisions:[],
    newFindings:[],
  });
  const run = {
    preparationSnapshot:{
      discussion:[{ actor:"USER", content:"화면 정리", createdAt:"2026-09-24T06:00:00Z" }],
    },
    messages:[
      { role:"JUDGE", phase:"ROUND0", content:JSON.stringify({ type:"INVALID_RESPONSE", error:"bad packet" }),
        createdAt:"2026-09-24T07:00:00Z", candidateId:"candidate-secret", auditManifestHash:"sha256:secret" },
      { role:"JUDGE", phase:"ROUND0", content:assertions,
        createdAt:"2026-09-24T07:05:00Z", candidateId:"candidate-secret", auditManifestHash:"sha256:secret" },
      { role:"CRITIC", phase:"ROUND0", content:assertions,
        createdAt:"2026-09-24T07:06:00Z", candidateId:"candidate-secret", auditManifestHash:"sha256:secret" },
    ],
    reviews:[{
      decision:"PASS",
      candidateId:"candidate-secret",
      auditManifestHash:"sha256:secret",
      report:{ assessments:[{ requirementId:"R1" }, { requirementId:"R2" }] },
    }],
  };
  const timeline = fakeTimeline();
  renderConversation(run, timeline, fakeNode, (value) => value ? "시간" : "확인 전");
  const rendered = JSON.stringify(timeline);

  assert.doesNotMatch(rendered, /INVALID_RESPONSE|REVIEW_ASSERTIONS|candidate-secret|sha256:secret/u);
  assert.match(rendered, /요구사항 2개 검토 · 충족 2 · 새 필수 지적 없음/u);
  assert.match(rendered, /검토 통과/u);
  assert.doesNotMatch(rendered, /확인 전/u);
});
