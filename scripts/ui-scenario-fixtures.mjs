// Explicit provider fixtures: never launch a real worker or send a ChatGPT prompt.
export function createUiScenarioFixture(targetRoot) {
  const at = '2026-09-13T00:00:00Z';
  let preparation = null, phase = null, version = 1, offline = false;
  let extensionAuthenticated = true, lastWebBinding = null, runtimeAvailable = true;
  let judgeReviewerAvailability = 'AVAILABLE', criticReviewerAvailability = 'AVAILABLE';
  const mutations = [];
  const run = () => ({ runId: 'active', version, mode: 'CODE_CHANGE', phase, objective: 'UI scenario task',
    createdAt: at, updatedAt: at, requirements: { items: [] }, findings: [],
    worker: { provider: 'codex', model: 'fixture-model' },
    reviewers: { JUDGE: { provider: 'CLAUDE_WEB' }, CRITIC: { provider: 'CHATGPT_WEB' } },
    candidate: { candidateId: 'candidate-qa' }, capture: { artifact: { sha256: 'hash-qa' } },
    baseCommit: 'base-qa',
    coordination: phase === 'REVIEW_RUNNING'
      ? { phase: 'ROUND0', activeRole: 'JUDGE', auditManifestHash: 'manifest-qa' }
      : { phase: 'ACCEPTED', activeRole: null, auditManifestHash: 'manifest-qa' },
    conversationBindings: [
      { role: 'JUDGE', provider: 'CLAUDE_WEB', bindingStatus: 'BOUND', activeDeliveryId: null,
        conversationUrl: 'https://claude.ai/chat/judge-fixture', conversationId: 'judge-fixture' },
      { role: 'CRITIC', provider: 'CHATGPT_WEB', bindingStatus: 'BOUND', activeDeliveryId: null,
        conversationUrl: 'https://chatgpt.com/c/critic-fixture', conversationId: 'critic-fixture' },
    ],
    reviewArtifacts: ['AWAITING_APPLY', 'APPLIED'].includes(phase) ? [
      { role: 'JUDGE', candidateId: 'candidate-qa' },
      { role: 'CRITIC', candidateId: 'candidate-qa' },
    ] : [],
    reviews: [{ reviewId: 'review-qa', candidateId: 'candidate-qa' }] });
  function state(url) {
    const requested = new URL(url).searchParams;
    const terminal = ['CANCELLED', 'APPLIED', 'AWAITING_APPLY'].includes(phase);
    const old = requested.get('runId') === 'old';
    const selected = old ? { ...run(), runId: 'old', phase: 'CANCELLED', objective: 'Previous task' }
      : phase && !(requested.get('view') === 'start' && terminal) ? run() : null;
    const workflow = preparation?.lifecycle === 'ACTIVE'
      ? { stage: ['WAITING_WEB_RESPONSE', 'WEB_BLOCKED'].includes(preparation.state) ? 'START' : 'PREPARE',
        state: preparation.state, preparationId: preparation.preparationId, preparationVersion: preparation.version }
      : selected ? { stage: old || terminal ? 'RESULT' : 'WORK', state: selected.phase, runId: selected.runId, runVersion: selected.version }
        : { stage: 'START', state: 'START_IDLE' };
    const caps = preparation?.lifecycle === 'ACTIVE'
      ? ['preparation.cancel', ...(preparation.state === 'DISCUSSING' ? ['preparation.reply'] : []),
        ...(preparation.state === 'AGREEMENT_READY' ? ['preparation.approve', 'preparation.reply'] : [])]
      : phase && !terminal ? phase === 'RECOVERY_REQUIRED' ? ['run.reconcile', 'run.abandon']
        : phase === 'HOLD' ? ['code.review.retry', 'run.stop']
          : phase === 'WORKER_RUNNING' ? ['run.stop', 'code.worker.intervene'] : ['run.stop']
        : ['preparation.start', ...(phase === 'AWAITING_APPLY' && !old
          ? ['code.apply', 'evidence.get', 'evidence.export', 'code.review.discuss', 'run.stop'] : [])];
    const runs = phase ? [{ runId: 'old', phase: 'CANCELLED', objective: 'Previous task' }, run()] : [];
    return { workflow, preparation, run: selected, runs,
      runtimeAvailability: runtimeAvailable
        ? { ready: true, code: null, message: null }
        : { ready: false, code: 'RUNTIME_FAULT_INJECTED', message: 'fixture runtime unavailable' },
      dataKnowledge: { runs: { status: runtimeAvailable
        ? (runs.length ? 'AVAILABLE_NONEMPTY' : 'AVAILABLE_EMPTY') : 'UNAVAILABLE' } },
      preflight: {
        checks: { codeWorkerExecutableConfigured: true, extensionAuthenticated },
        lastWebBinding,
      },
      commandCapabilities: caps, messages: [], events: [], findings: [], assessments: [], deliveries: [],
      workerRuntime: phase === 'WORKER_RUNNING' ? { turnId: 'worker-turn-fixture' } : null,
      reviewerRuntimes: {
        JUDGE: { provider: 'CLAUDE_WEB', providerEvidence: 'ADAPTER_IMPLEMENTATION', model: null, modelEvidence: 'UNOBSERVED',
          availability: judgeReviewerAvailability, errorCode: judgeReviewerAvailability === 'AVAILABLE' ? null : 'REVIEWER_PROVIDER_UNAVAILABLE' },
        CRITIC: { provider: 'CHATGPT_WEB', providerEvidence: 'ADAPTER_IMPLEMENTATION', model: null, modelEvidence: 'UNOBSERVED',
          availability: criticReviewerAvailability, errorCode: criticReviewerAvailability === 'AVAILABLE' ? null : 'REVIEWER_PROVIDER_UNAVAILABLE' },
      },
      evidence: selected?.phase === 'AWAITING_APPLY' ? [{ evidenceId: 'evidence-qa', kind: 'PATCH', producer: 'CONTROLLER',
        candidateId: 'candidate-qa', createdAt: at, result: {} }] : [] };
  }
  return {
    mutations,
    get version() { return version; },
    set offline(value) { offline = value; },
    set extensionAuthenticated(value) { extensionAuthenticated = value === true; },
    set lastWebBinding(value) { lastWebBinding = value ? structuredClone(value) : null; },
    set runtimeAvailable(value) { runtimeAvailable = value === true; },
    set judgeReviewerAvailability(value) { judgeReviewerAvailability = value; },
    set criticReviewerAvailability(value) { criticReviewerAvailability = value; },
    set phase(value) { phase = value; version++; },
    discuss() {
      preparation.state = 'DISCUSSING'; preparation.version++;
      preparation.webSession = { ...preparation.webSession, conversationUrl: 'https://chatgpt.com/c/created', conversationId: 'created', bindingState: 'BOUND' };
      preparation.agreement.summary = 'Which visible change should be made?';
      preparation.agreement.unresolvedQuestions = ['Which visible change should be made?'];
    },
    block() { preparation.state = 'WEB_BLOCKED'; preparation.version++;
      preparation.error = { code: 'WEB_DOCUMENT_CHANGED', message: 'Prepare the reloaded ChatGPT document again.' }; },
    async install(page) {
      await page.route('**/api/state*', route => offline ? route.abort() : route.fulfill({ json: state(route.request().url()) }));
      await page.route('**/api/preparations**', async route => {
        const body = route.request().postDataJSON(), pathname = new URL(route.request().url()).pathname;
        mutations.push({ pathname, body });
        if (pathname === '/api/preparations') {
          preparation = { preparationId: 'prep-qa', version: 1, lifecycle: 'ACTIVE', state: 'WAITING_WEB_RESPONSE',
            objective: body.objective, targetRoot, conversationUrl: body.conversationUrl, updatedAt: at,
            webSession: { sessionId: 'web-qa', conversationUrl: body.conversationUrl, conversationId: null,
              bindingState: 'ROOT_READY', documentId: 'document-qa', frameId: 0, tabId: 7 },
            diagnostics: { exactConversation: true }, deliveries: [], discussion: [],
            agreement: { status: 'DISCUSSING', summary: '', unresolvedQuestions: [], requirements: [] } };
        } else if (pathname.endsWith('/reply')) {
          preparation.version++; preparation.state = 'AGREEMENT_READY';
          preparation.discussion.push({ turnId: 'reply-1', preparationId: 'prep-qa', sequence: 1, actor: 'USER', content: body.content });
          preparation.agreement = { status: 'READY', summary: 'Show a greeting.', unresolvedQuestions: [],
            requirements: [{ statement: 'Show a greeting', acceptanceCriteria: 'Greeting is visible' }] };
        } else if (pathname.endsWith('/approve')) { preparation.lifecycle = 'COMPLETED'; phase = 'WORKER_RUNNING'; version++; }
        else if (pathname.endsWith('/cancel')) preparation = null;
        else throw new Error(`Unexpected preparation mutation: ${pathname}`);
        await route.fulfill({ json: { accepted: true } });
      });
      await page.route('**/api/commands', async route => {
        const body = route.request().postDataJSON(); mutations.push({ pathname: '/api/commands', body });
        if (body.type === 'run.reconcile') {
          await route.fulfill({ json: { payload: { runId: 'active', classification: 'RECOVERY_REQUIRED',
            observations: [{ source: 'controller', stage: phase }], allowedActions: ['run.abandon'], readOnly: true } } }); return;
        }
        if (['run.stop', 'run.abandon'].includes(body.type)) phase = 'CANCELLED';
        else if (body.type === 'code.review.retry') phase = 'REVIEW_RUNNING';
        else if (body.type === 'code.apply') phase = 'APPLIED';
        else if (body.type === 'evidence.get') {
          await route.fulfill({ json: { payload: { kind: 'PATCH', content: 'Verified UI fixture evidence',
            startLine: 1, endLine: 1, totalLines: 1, omittedAfter: false } } }); return;
        } else throw new Error(`Unexpected run command: ${body.type}`);
        version++; await route.fulfill({ json: { payload: { runId: 'active' } } });
      });
    },
  };
}
