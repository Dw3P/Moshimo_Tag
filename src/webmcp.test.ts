import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatch,
  getSnapshot,
  type StoragePort,
  type CommandResult,
} from './app-state.ts';
import { initializeTestPersistence as initializePersistence } from './test-fixtures.ts';
import {
  createReviewTools,
  createSiteTools,
  registerReviewTools,
  registerSiteTools,
  type ModelContextPort,
  type WebMcpAvailability,
  type WebMcpActivity,
  type WebMcpTool,
} from './webmcp.ts';

class MemoryStorage implements StoragePort {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const proposedItems = [
  {
    timeOrCue: '09:00',
    title: 'Open the workshop',
    body: 'Welcome the group and explain the goal.',
    tags: [
      {
        question: 'What if several guests arrive late?',
        rationale: 'A delayed opening can make the first exercise unclear.',
        summary: 'Keep the opening understandable for late arrivals.',
        cases: [
          {
            title: 'Only a few guests are late',
            suggestedActions: ['Start on time and reserve a short recap.'],
          },
        ],
      },
    ],
  },
];

function createAiProject() {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const created = dispatch({
    type: 'project.create',
    payload: {
      title: 'Workshop',
      description: 'Run a two-hour workshop for twelve guests.',
      requestReview: true,
    },
  });
  assert.equal(created.ok, true);
  const snapshot = getSnapshot();
  assert.ok(snapshot.project.activeReviewRequest);
  return { snapshot, storage };
}

function findTool(tools: WebMcpTool[], name: string): WebMcpTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} should be registered`);
  return tool;
}

function beginNormalReview(
  kind:
    | 'timeline_whatifs'
    | 'item_whatifs'
    | 'tag_cases'
    | 'case_actions'
    | 'timeline_gaps',
  ownerId: string,
) {
  const result = dispatch({
    type: 'review.request',
    payload: { kind, ownerId },
  });
  assert.equal(result.ok, true);
  const snapshot = getSnapshot();
  const request = snapshot.project.activeReviewRequest;
  assert.ok(request);
  return {
    request,
    projectId: snapshot.project.id,
    projectVersion: snapshot.project.version,
  };
}

function beginStaleRecheck(tagIds: string[]) {
  const item = getSnapshot().project.timeline.find(
    (entry) => entry.id === 'item-leave-home',
  );
  assert.ok(item);
  const edited = dispatch({
    type: 'timeline.update',
    payload: {
      itemId: item.id,
      timeOrCue: '15:10',
      title: item.title,
      body: item.body,
    },
  });
  assert.equal(edited.ok, true);
  const requested = dispatch({
    type: 'recheck.request',
    payload: { tagIds },
  });
  assert.equal(requested.ok, true);
  const snapshot = getSnapshot();
  const request = snapshot.project.activeRecheckRequest;
  assert.ok(request);
  return { snapshot, request };
}

test('WebMCP reads the explicit project_plan scope and atomically applies its Draft bundle', async () => {
  const { snapshot } = createAiProject();
  const request = snapshot.project.activeReviewRequest;
  assert.ok(request);
  const tools = createReviewTools({ dispatch, getSnapshot });
  const readTool = findTool(tools, 'get_review_context');
  const applyTool = findTool(tools, 'apply_review_suggestions');
  const beforeRead = getSnapshot();

  const read = JSON.parse(
    await readTool.execute(
      { requestId: request.id },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(read.ok, true);
  assert.equal(read.request.kind, 'project_plan');
  assert.equal(read.project.title, 'Workshop');
  assert.equal(
    read.project.brief,
    'Run a two-hour workshop for twelve guests.',
  );
  assert.equal(read.project.timelineItemCount, 0);
  assert.deepEqual(read.limits, {
    items: [1, 12],
    tagsPerItem: [1, 2],
    casesPerTag: [1, 4],
    suggestedActionsPerCase: [1, 5],
  });
  assert.strictEqual(getSnapshot(), beforeRead);

  const input = {
    idempotencyKey: 'workshop-plan-v1',
    kind: 'project_plan',
    requestId: request.id,
    projectId: snapshot.project.id,
    projectVersion: snapshot.project.version,
    items: proposedItems,
  };
  const appliedText = await applyTool.execute(input, {
    signal: new AbortController().signal,
  });
  const applied = JSON.parse(appliedText);
  assert.equal(applied.ok, true);
  assert.equal(applied.code, 'OK');
  assert.equal(getSnapshot().project.timeline.length, 1);
  assert.equal(getSnapshot().project.timeline[0].status, 'draft');
  assert.equal(getSnapshot().project.timeline[0].tags[0].source, 'agent');
  assert.equal(
    getSnapshot().project.timeline[0].tags[0].anchorItemId,
    getSnapshot().project.timeline[0].id,
  );
  assert.equal(
    getSnapshot().project.timeline[0].tags[0].cases[0].response,
    null,
  );
  assert.equal(getSnapshot().project.activeReviewRequest, null);

  const afterApply = getSnapshot();
  const replayText = await applyTool.execute(input, {
    signal: new AbortController().signal,
  });
  assert.equal(replayText, appliedText);
  assert.strictEqual(getSnapshot(), afterApply);
});

test('WebMCP rejects malformed, cancelled, and conflicting project_plan calls without mutation', async () => {
  const { snapshot } = createAiProject();
  const request = snapshot.project.activeReviewRequest;
  assert.ok(request);
  const applyTool = findTool(
    createReviewTools({ dispatch, getSnapshot }),
    'apply_review_suggestions',
  );

  const beforeMalformed = getSnapshot();
  const malformed = JSON.parse(
    await applyTool.execute(
      {
        idempotencyKey: 'bad-extra',
        kind: 'project_plan',
        requestId: request.id,
        projectId: snapshot.project.id,
        projectVersion: snapshot.project.version,
        items: proposedItems,
        extra: true,
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'INVALID_INPUT');
  assert.strictEqual(getSnapshot(), beforeMalformed);

  const cancelledController = new AbortController();
  cancelledController.abort();
  const cancelled = JSON.parse(
    await applyTool.execute(
      {
        idempotencyKey: 'cancelled-plan',
        kind: 'project_plan',
        requestId: request.id,
        projectId: snapshot.project.id,
        projectVersion: snapshot.project.version,
        items: proposedItems,
      },
      { signal: cancelledController.signal },
    ),
  );
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'CANCELLED');
  assert.strictEqual(getSnapshot(), beforeMalformed);

  const successfulInput = {
    idempotencyKey: 'same-key',
    kind: 'project_plan',
    requestId: request.id,
    projectId: snapshot.project.id,
    projectVersion: snapshot.project.version,
    items: proposedItems,
  };
  const successful = JSON.parse(
    await applyTool.execute(successfulInput, {
      signal: new AbortController().signal,
    }),
  );
  assert.equal(successful.ok, true);
  const afterSuccessful = getSnapshot();
  const conflict = JSON.parse(
    await applyTool.execute(
      {
        ...successfulInput,
        items: [
          {
            ...proposedItems[0],
            title: 'A different plan with the same key',
          },
        ],
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'DUPLICATE');
  assert.strictEqual(getSnapshot(), afterSuccessful);
});

test('WebMCP reads and applies every normal review scope through the same tool pair', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const tools = createReviewTools({ dispatch, getSnapshot });
  const readTool = findTool(tools, 'get_review_context');
  const applyTool = findTool(tools, 'apply_review_suggestions');

  const timelineReview = beginNormalReview(
    'timeline_whatifs',
    getSnapshot().project.id,
  );
  const timelineContext = JSON.parse(
    await readTool.execute(
      { requestId: timelineReview.request.id },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(timelineContext.ok, true);
  assert.equal(timelineContext.request.kind, 'timeline_whatifs');
  assert.equal(timelineContext.scope.timeline.length, 3);
  assert.equal(timelineContext.scope.timeline[0].id, 'item-leave-home');
  assert.equal(timelineContext.scope.timeline[0].existingWhatIfs.length, 2);
  assert.deepEqual(timelineContext.limits.tags, [1, 5]);
  assert.deepEqual(timelineContext.limits.casesPerTag, [1, 6]);
  const appliedTimeline = JSON.parse(
    await applyTool.execute(
      {
        idempotencyKey: 'normal-timeline-whatifs',
        kind: 'timeline_whatifs',
        requestId: timelineReview.request.id,
        projectId: timelineReview.projectId,
        projectVersion: timelineReview.projectVersion,
        tags: [
          {
            anchorItemId: 'item-flight',
            question: 'What if the boarding gate changes?',
            rationale: 'A late gate change can consume the remaining buffer.',
            summary: 'Keep the live gate assignment visible until boarding.',
            cases: [
              {
                title: 'Gate changes within the same terminal',
                suggestedActions: ['Walk directly to the new gate and confirm boarding time.'],
              },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(appliedTimeline.ok, true);
  assert.equal(
    getSnapshot().project.timeline[2].tags.at(-1)?.question,
    'What if the boarding gate changes?',
  );

  const itemReview = beginNormalReview('item_whatifs', 'item-airport');
  const itemContext = JSON.parse(
    await readTool.execute(
      { requestId: itemReview.request.id },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(itemContext.scope.item.id, 'item-airport');
  const appliedItem = JSON.parse(
    await applyTool.execute(
      {
        idempotencyKey: 'normal-item-whatifs',
        kind: 'item_whatifs',
        requestId: itemReview.request.id,
        projectId: itemReview.projectId,
        projectVersion: itemReview.projectVersion,
        tags: [
          {
            anchorItemId: 'item-airport',
            question: 'What if bag drop closes early?',
            rationale: 'A changed deadline can block the checked bag.',
            summary: 'Confirm the real cutoff before waiting elsewhere.',
            cases: [
              {
                title: 'Bag drop is still open',
                suggestedActions: ['Complete bag drop before optional airport tasks.'],
              },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(appliedItem.ok, true);

  const tagReview = beginNormalReview('tag_cases', 'tag-traffic');
  const tagContext = JSON.parse(
    await readTool.execute(
      { requestId: tagReview.request.id },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(tagContext.scope.tag.id, 'tag-traffic');
  assert.equal(tagContext.scope.item.id, 'item-leave-home');
  const appliedCases = JSON.parse(
    await applyTool.execute(
      {
        idempotencyKey: 'normal-tag-cases',
        kind: 'tag_cases',
        requestId: tagReview.request.id,
        projectId: tagReview.projectId,
        projectVersion: tagReview.projectVersion,
        tagId: 'tag-traffic',
        cases: [
          {
            title: 'Road closes completely',
            suggestedActions: ['Switch to rail before entering the closed area.'],
          },
        ],
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(appliedCases.ok, true);

  const caseReview = beginNormalReview('case_actions', 'case-traffic-light');
  const caseContext = JSON.parse(
    await readTool.execute(
      { requestId: caseReview.request.id },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(caseContext.scope.case.id, 'case-traffic-light');
  assert.equal(caseContext.scope.tag.id, 'tag-traffic');
  const appliedActions = JSON.parse(
    await applyTool.execute(
      {
        idempotencyKey: 'normal-case-actions',
        kind: 'case_actions',
        requestId: caseReview.request.id,
        projectId: caseReview.projectId,
        projectVersion: caseReview.projectVersion,
        caseId: 'case-traffic-light',
        suggestedActions: ['Leave as planned.', 'Confirm the route with the driver.'],
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(appliedActions.ok, true);

  const gapReview = beginNormalReview('timeline_gaps', getSnapshot().project.id);
  const gapContext = JSON.parse(
    await readTool.execute(
      { requestId: gapReview.request.id },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(gapContext.scope.timeline.length, 3);
  assert.ok(gapContext.scope.existingGapSuggestions.length >= 2);
  assert.deepEqual(gapContext.limits.gaps, [0, 3]);
  const timelineCountBeforeGap = getSnapshot().project.timeline.length;
  const appliedGaps = JSON.parse(
    await applyTool.execute(
      {
        idempotencyKey: 'normal-timeline-gaps',
        kind: 'timeline_gaps',
        requestId: gapReview.request.id,
        projectId: gapReview.projectId,
        projectVersion: gapReview.projectVersion,
        gaps: [
          {
            insertAfterItemId: 'item-airport',
            timeOrCue: '18:10',
            title: 'Check the live gate',
            body: 'Confirm the assigned gate before leaving the concourse.',
          },
        ],
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(appliedGaps.ok, true);
  assert.equal(getSnapshot().project.timeline.length, timelineCountBeforeGap);
  assert.equal(getSnapshot().project.gapSuggestions.at(-1)?.status, 'proposed');
});

test('WebMCP reads and atomically applies an explicit stale Tag recheck without exposing or changing human responses', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const saved = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-light',
      disposition: 'accept',
      actions: ['Take the usual route and leave as planned.'],
      when: '',
      status: null,
    },
  });
  assert.equal(saved.ok, true);
  const { snapshot, request } = beginStaleRecheck(['tag-traffic']);
  const tools = createReviewTools({ dispatch, getSnapshot });
  const readTool = findTool(tools, 'get_stale_tag_context');
  const applyTool = findTool(tools, 'apply_tag_recheck');
  const beforeRead = getSnapshot();

  const readText = await readTool.execute(
    {},
    { signal: new AbortController().signal },
  );
  const read = JSON.parse(readText);
  assert.equal(read.ok, true);
  assert.equal(read.request.id, request.id);
  assert.equal(read.scope.items.length, 1);
  assert.equal(read.scope.items[0].id, 'item-leave-home');
  assert.equal(read.scope.items[0].staleWhatIfs[0].id, 'tag-traffic');
  assert.equal(read.scope.items[0].staleWhatIfs[0].needsRecheck, true);
  assert.equal(readText.includes('response'), false);
  assert.deepEqual(read.limits, {
    tags: [1, 5],
    casesPerTag: [1, 6],
    suggestedActionsPerCase: [1, 5],
  });
  assert.strictEqual(getSnapshot(), beforeRead);

  const tagVersion = request.tags[0].tagVersion;
  const input = {
    idempotencyKey: 'retain-traffic-v1',
    requestId: request.id,
    projectId: snapshot.project.id,
    projectVersion: snapshot.project.version,
    outcomes: [
      {
        tagId: 'tag-traffic',
        tagVersion,
        outcome: 'retain',
      },
    ],
  };
  const cancelledController = new AbortController();
  cancelledController.abort();
  const cancelled = JSON.parse(
    await applyTool.execute(
      { ...input, idempotencyKey: 'cancelled-retain-traffic-v1' },
      { signal: cancelledController.signal },
    ),
  );
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'CANCELLED');
  assert.strictEqual(getSnapshot(), beforeRead);

  const appliedText = await applyTool.execute(input, {
    signal: new AbortController().signal,
  });
  const applied = JSON.parse(appliedText);
  assert.equal(applied.ok, true);
  const afterApply = getSnapshot();
  const retained = afterApply.project.timeline[0].tags.find(
    (tag) => tag.id === 'tag-traffic',
  );
  assert.equal(retained?.needsRecheck, false);
  assert.deepEqual(retained?.cases[0].response, {
    disposition: 'accept',
    actions: ['Take the usual route and leave as planned.'],
    when: '',
    status: null,
  });
  assert.equal(afterApply.project.activeRecheckRequest, null);

  const replayText = await applyTool.execute(input, {
    signal: new AbortController().signal,
  });
  assert.equal(replayText, appliedText);
  assert.strictEqual(getSnapshot(), afterApply);
});

test('WebMCP activity callback marks normal review reads, failed saves, and successful saves', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const activities: WebMcpActivity[] = [];
  const tools = createReviewTools({
    dispatch,
    getSnapshot,
    onActivity: (activity) => activities.push(activity),
  });
  const readTool = findTool(tools, 'get_review_context');
  const applyTool = findTool(tools, 'apply_review_suggestions');
  const review = beginNormalReview(
    'timeline_whatifs',
    getSnapshot().project.id,
  );

  const read = JSON.parse(
    await readTool.execute(
      { requestId: review.request.id },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(read.ok, true);
  assert.deepEqual(activities, [
    {
      phase: 'reviewing',
      requestId: review.request.id,
      kind: 'timeline_whatifs',
    },
  ]);

  const proposal = {
    anchorItemId: 'item-flight',
    question: 'What if the boarding gate changes?',
    rationale: 'A late gate change can consume the remaining buffer.',
    summary: 'Keep the live gate assignment visible until boarding.',
    cases: [
      {
        title: 'Gate changes within the same terminal',
        suggestedActions: ['Walk directly to the new gate.'],
      },
    ],
  };
  const input = {
    idempotencyKey: 'activity-normal-v1',
    kind: 'timeline_whatifs' as const,
    requestId: review.request.id,
    projectId: review.projectId,
    projectVersion: review.projectVersion,
    tags: [proposal],
  };
  const failed = JSON.parse(
    await applyTool.execute(
      { ...input, projectVersion: review.projectVersion + 1 },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'VERSION_CONFLICT');
  assert.deepEqual(activities.slice(1), [
    {
      phase: 'saving',
      requestId: review.request.id,
      kind: 'timeline_whatifs',
    },
    {
      phase: 'waiting',
      requestId: review.request.id,
      kind: 'timeline_whatifs',
    },
  ]);

  const applied = JSON.parse(
    await applyTool.execute(input, {
      signal: new AbortController().signal,
    }),
  );
  assert.equal(applied.ok, true);
  assert.deepEqual(activities.slice(3), [
    {
      phase: 'saving',
      requestId: review.request.id,
      kind: 'timeline_whatifs',
    },
  ]);
  assert.equal(getSnapshot().project.activeReviewRequest, null);
});

test('WebMCP activity callback marks stale recheck reads and save failures', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const activities: WebMcpActivity[] = [];
  const { snapshot, request } = beginStaleRecheck(['tag-traffic']);
  const tools = createReviewTools({
    dispatch,
    getSnapshot,
    onActivity: (activity) => activities.push(activity),
  });
  const readTool = findTool(tools, 'get_stale_tag_context');
  const applyTool = findTool(tools, 'apply_tag_recheck');

  const read = JSON.parse(
    await readTool.execute(
      {},
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(read.ok, true);
  assert.deepEqual(activities, [
    { phase: 'reviewing', requestId: request.id, kind: 'recheck' },
  ]);

  const input = {
    idempotencyKey: 'activity-recheck-v1',
    requestId: request.id,
    projectId: snapshot.project.id,
    projectVersion: snapshot.project.version,
    outcomes: [
      {
        tagId: 'tag-traffic',
        tagVersion: request.tags[0].tagVersion,
        outcome: 'retain' as const,
      },
    ],
  };
  const failed = JSON.parse(
    await applyTool.execute(
      { ...input, projectVersion: snapshot.project.version + 1 },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'VERSION_CONFLICT');
  assert.deepEqual(activities.slice(1), [
    { phase: 'saving', requestId: request.id, kind: 'recheck' },
    { phase: 'waiting', requestId: request.id, kind: 'recheck' },
  ]);

  const applied = JSON.parse(
    await applyTool.execute(input, {
      signal: new AbortController().signal,
    }),
  );
  assert.equal(applied.ok, true);
  assert.deepEqual(activities.slice(3), [
    { phase: 'saving', requestId: request.id, kind: 'recheck' },
  ]);
  assert.equal(getSnapshot().project.activeRecheckRequest, null);
});

test('WebMCP registration reports support, registers four static tools, and aborts all tools on cleanup', async () => {
  const { snapshot } = createAiProject();
  const registered: Array<{
    tool: WebMcpTool;
    signal: AbortSignal | undefined;
  }> = [];
  const statuses: WebMcpAvailability[] = [];
  const activities: WebMcpActivity[] = [];
  const modelContext: ModelContextPort = {
    async registerTool(tool, options) {
      registered.push({ tool, signal: options?.signal });
    },
  };
  const dispose = registerReviewTools(
    { modelContext },
    { dispatch, getSnapshot },
    (status) => statuses.push(status),
    (activity) => activities.push(activity),
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    registered.map(({ tool }) => tool.name),
    [
      'get_review_context',
      'apply_review_suggestions',
      'get_stale_tag_context',
      'apply_tag_recheck',
    ],
  );
  assert.equal(registered[0].tool.annotations?.readOnlyHint, true);
  assert.equal(registered[0].tool.annotations?.untrustedContentHint, true);
  assert.equal(registered[1].tool.annotations?.readOnlyHint, false);
  assert.equal(registered[1].tool.annotations?.untrustedContentHint, true);
  assert.equal(registered[2].tool.annotations?.readOnlyHint, true);
  assert.equal(registered[2].tool.annotations?.untrustedContentHint, true);
  assert.equal(registered[3].tool.annotations?.readOnlyHint, false);
  assert.equal(registered[3].tool.annotations?.untrustedContentHint, true);
  assert.deepEqual(statuses, ['checking', 'available']);
  assert.equal(registered.every(({ signal }) => signal?.aborted === false), true);

  const read = JSON.parse(
    await registered[0].tool.execute(
      { requestId: snapshot.project.activeReviewRequest?.id },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(read.ok, true);
  assert.deepEqual(activities, [
    {
      phase: 'reviewing',
      requestId: snapshot.project.activeReviewRequest?.id,
      kind: 'project_plan',
    },
  ]);

  dispose();
  assert.equal(registered.every(({ signal }) => signal?.aborted === true), true);

  const unsupported: WebMcpAvailability[] = [];
  const disposeUnsupported = registerReviewTools(
    {},
    { dispatch, getSnapshot },
    (status) => unsupported.push(status),
  );
  assert.deepEqual(unsupported, ['unavailable']);
  disposeUnsupported();
});

test('Direct Site tools discover eleven static tools and expose bounded section projections', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const registered: WebMcpTool[] = [];
  const statuses: WebMcpAvailability[] = [];
  const modelContext: ModelContextPort = {
    async registerTool(tool) {
      registered.push(tool);
    },
  };
  const dispose = registerSiteTools(
    { modelContext },
    { dispatch, getSnapshot },
    (status) => statuses.push(status),
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    registered.map((tool) => tool.name),
    [
      'list_projects',
      'get_project',
      'create_project',
      'open_project',
      'update_project',
      'set_project_view',
      'edit_plan',
      'edit_what_if',
      'edit_case',
      'edit_plan_b_options',
      'get_export_projection',
    ],
  );
  assert.deepEqual(statuses, ['checking', 'available']);
  assert.equal(registered.slice(0, 2).every((tool) => tool.annotations?.readOnlyHint), true);
  assert.equal(registered.slice(2, 10).every((tool) => tool.annotations?.readOnlyHint === false), true);
  assert.equal(registered[10].annotations?.readOnlyHint, true);
  assert.equal(registered[10].annotations?.untrustedContentHint, true);

  const editSituationTool = findTool(registered, 'edit_case');
  assert.equal(editSituationTool.title, 'Edit Situation');
  assert.match(
    editSituationTool.description,
    /Situation.+under a broader What-if/,
  );
  assert.match(
    findTool(registered, 'create_project').description,
    /cases field name for compatibility/,
  );
  assert.match(
    findTool(registered, 'create_project').description,
    /only the person may decide/i,
  );
  assert.match(editSituationTool.description, /do not operate page response choices/i);
  assert.match(
    findTool(registered, 'edit_plan_b_options').description,
    /leave the Situation undecided and stop/i,
  );

  const listTool = findTool(registered, 'list_projects');
  const getTool = findTool(registered, 'get_project');
  const list = JSON.parse(
    await listTool.execute({}, { signal: new AbortController().signal }),
  );
  assert.equal(list.ok, true);
  assert.equal(list.currentProjectId, getSnapshot().project.id);
  assert.equal(list.projects[0].id, getSnapshot().project.id);

  const project = JSON.parse(
    await getTool.execute(
      { section: 'project' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(project.ok, true);
  assert.equal(project.project.id, getSnapshot().project.id);
  assert.equal(project.project.description, getSnapshot().project.description);

  const plan = JSON.parse(
    await getTool.execute(
      { section: 'plan' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.items.length, getSnapshot().project.timeline.length);
  assert.equal(plan.items[0].tags[0].source, 'agent');
  assert.equal(typeof plan.items[0].tags[0].version, 'number');
  assert.equal(plan.items[0].tags[0].lifecycle, 'active');
  assert.equal('needsRecheck' in plan.items[0].tags[0], true);
  assert.equal('impact' in plan.items[0].tags[0], true);
  assert.equal('suggestedActions' in plan.items[0].tags[0].cases[0], true);
  assert.equal('planBOptionsDraft' in plan.items[0].tags[0].cases[0], true);
  assert.equal('response' in plan.items[0].tags[0].cases[0], true);

  const whatIf = JSON.parse(
    await getTool.execute(
      { section: 'what_if', entityId: 'tag-traffic' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(whatIf.ok, true);
  assert.equal(whatIf.whatIf.id, 'tag-traffic');

  const whatIfArea = JSON.parse(
    await getTool.execute(
      { section: 'what_if' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(whatIfArea.ok, true);
  assert.equal(whatIfArea.items.length, getSnapshot().project.timeline.length);
  assert.equal(whatIfArea.items[0].item.id, 'item-leave-home');
  assert.equal(whatIfArea.items[0].whatIfs[0].id, 'tag-traffic');
  assert.equal(whatIfArea.items[0].whatIfs[0].cases[0].id, 'case-traffic-light');

  const caseContext = JSON.parse(
    await getTool.execute(
      { section: 'case', entityId: 'case-traffic-light' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(caseContext.ok, true);
  assert.equal(caseContext.case.id, 'case-traffic-light');

  const beforeFinal = getSnapshot();
  const finalEmpty = JSON.parse(
    await getTool.execute(
      { section: 'final' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(finalEmpty.ok, true);
  assert.deepEqual(finalEmpty.items, []);
  assert.strictEqual(getSnapshot(), beforeFinal);

  const saved = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-light',
      disposition: 'accept',
      actions: ['Take the usual route.'],
      when: '',
      status: null,
    },
  });
  assert.equal(saved.ok, true);
  const finalSelected = JSON.parse(
    await getTool.execute(
      { section: 'final' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(finalSelected.items.length, 1);
  assert.equal(finalSelected.items[0].tags[0].lifecycle, 'active');
  assert.equal(finalSelected.items[0].tags[0].cases[0].response.disposition, 'accept');

  dispose();
  assert.equal(statuses.at(-1), 'available');
});

test('Direct Site tools expose an empty workspace as create context without a sample Project', async () => {
  const storage = new MemoryStorage();
  assert.deepEqual(initializePersistence(() => storage, 'empty'), {
    kind: 'ready',
    source: 'empty',
  });
  const tools = createSiteTools({ dispatch, getSnapshot });
  const list = JSON.parse(
    await findTool(tools, 'list_projects').execute(
      {},
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(list.ok, true);
  assert.equal(list.workspaceStatus, 'empty');
  assert.equal(list.currentProjectId, getSnapshot().project.id);
  assert.equal(list.currentProjectVersion, getSnapshot().project.version);
  assert.deepEqual(list.projects, []);

  const missing = JSON.parse(
    await findTool(tools, 'get_project').execute(
      { section: 'project' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_FOUND');

  const created = JSON.parse(
    await findTool(tools, 'create_project').execute(
      {
        idempotencyKey: 'empty-workspace-create',
        projectId: list.currentProjectId,
        projectVersion: list.currentProjectVersion,
        title: 'Market day',
        description: 'Prepare for a weekend market event.',
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(created.ok, true);
  assert.equal(getSnapshot().project.title, 'Market day');
  assert.deepEqual(getSnapshot().projects, []);
});

test('Direct Site mutation tools map every agent-owned operation to the shared command dispatcher', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const commands: unknown[] = [];
  const committedOperations: string[] = [];
  const dispatchSpy = (raw: unknown): CommandResult => {
    commands.push(raw);
    return { ok: true, code: 'OK', affectedIds: [], version: getSnapshot().project.version };
  };
  const tools = createSiteTools({
    dispatch: dispatchSpy,
    getSnapshot,
    onMutationCommitted: ({ operation }) => committedOperations.push(operation),
  });
  const create = findTool(tools, 'create_project');
  const open = findTool(tools, 'open_project');
  const update = findTool(tools, 'update_project');
  const view = findTool(tools, 'set_project_view');
  const plan = findTool(tools, 'edit_plan');
  const whatIf = findTool(tools, 'edit_what_if');
  const caseTool = findTool(tools, 'edit_case');
  const planB = findTool(tools, 'edit_plan_b_options');
  const project = getSnapshot().project;
  const base = {
    projectId: project.id,
    projectVersion: project.version,
  };
  const signal = () => ({ signal: new AbortController().signal });
  const planBundle = [
    {
      timeOrCue: '09:00',
      title: 'Open the workshop',
      body: 'Welcome the group.',
      tags: [
        {
          question: 'What if the door is locked?',
          rationale: 'The venue may open late.',
          summary: 'Keep a nearby fallback.',
          cases: [
            {
              title: 'Staff is delayed',
              suggestedActions: ['Call the venue contact.'],
            },
          ],
        },
      ],
    },
  ];

  await create.execute(
    { ...base, idempotencyKey: 'site-create-manual', title: 'Manual', description: '' },
    signal(),
  );
  await create.execute(
    {
      ...base,
      idempotencyKey: 'site-create-bundle',
      title: 'Bundled',
      description: 'A bundled plan.',
      items: planBundle,
    },
    signal(),
  );
  await open.execute(
    {
      ...base,
      idempotencyKey: 'site-open',
      targetProjectId: project.id,
    },
    signal(),
  );
  await update.execute(
    {
      ...base,
      idempotencyKey: 'site-update',
      title: 'Updated title',
      description: 'Updated description.',
    },
    signal(),
  );
  await view.execute(
    { ...base, idempotencyKey: 'site-view', viewMode: 'final' },
    signal(),
  );
  await plan.execute(
    {
      ...base,
      idempotencyKey: 'site-plan-add',
      operation: 'add',
      timeOrCue: '18:00',
      title: 'Leave',
      body: 'Leave the venue.',
    },
    signal(),
  );
  await plan.execute(
    {
      ...base,
      idempotencyKey: 'site-plan-update',
      operation: 'update',
      itemId: 'item-leave-home',
      itemVersion: 1,
      timeOrCue: '15:25',
      title: 'Leave home early',
      body: 'Leave with extra buffer.',
    },
    signal(),
  );
  await plan.execute(
    {
      ...base,
      idempotencyKey: 'site-plan-move',
      operation: 'move',
      itemId: 'item-leave-home',
      itemVersion: 1,
      direction: 'down',
    },
    signal(),
  );
  await plan.execute(
    {
      ...base,
      idempotencyKey: 'site-plan-delete',
      operation: 'delete',
      itemId: 'item-leave-home',
      itemVersion: 1,
    },
    signal(),
  );
  await whatIf.execute(
    {
      ...base,
      idempotencyKey: 'site-whatif-add',
      operation: 'add',
      itemId: 'item-leave-home',
      itemVersion: 1,
      question: 'What if the taxi is late?',
      rationale: 'Traffic can delay the first leg.',
      summary: 'Use a confirmed alternative.',
      cases: [{ title: 'Traffic is heavy', suggestedActions: ['Use the train.'] }],
    },
    signal(),
  );
  await whatIf.execute(
    {
      ...base,
      idempotencyKey: 'site-whatif-update',
      operation: 'update',
      tagId: 'tag-traffic',
      tagVersion: 1,
      question: 'What if the taxi is very late?',
      rationale: 'Traffic can consume the buffer.',
      summary: 'Switch to a confirmed alternative.',
    },
    signal(),
  );
  await whatIf.execute(
    {
      ...base,
      idempotencyKey: 'site-whatif-delete',
      operation: 'delete',
      tagId: 'tag-taxi',
      tagVersion: 1,
    },
    signal(),
  );
  await whatIf.execute(
    {
      ...base,
      idempotencyKey: 'site-whatif-impact',
      operation: 'set_impact',
      tagId: 'tag-traffic',
      tagVersion: 1,
      impact: {
        rank: 5,
        expectedLossAmount: 120,
        currency: 'USD',
        penalty: 'May miss boarding.',
      },
    },
    signal(),
  );
  await whatIf.execute(
    {
      ...base,
      idempotencyKey: 'site-whatif-sort',
      operation: 'sort_by_impact',
      itemId: 'item-leave-home',
      itemVersion: 1,
    },
    signal(),
  );
  await caseTool.execute(
    {
      ...base,
      idempotencyKey: 'site-case-add',
      operation: 'add',
      tagId: 'tag-traffic',
      tagVersion: 1,
      title: 'Traffic is severe',
      suggestedActions: ['Take the train.'],
    },
    signal(),
  );
  await caseTool.execute(
    {
      ...base,
      idempotencyKey: 'site-case-update',
      operation: 'update',
      caseId: 'case-traffic-light',
      caseVersion: 1,
      title: 'Traffic is manageable',
      suggestedActions: ['Keep the usual route.'],
    },
    signal(),
  );
  await caseTool.execute(
    {
      ...base,
      idempotencyKey: 'site-case-delete',
      operation: 'delete',
      caseId: 'case-traffic-medium',
      caseVersion: 1,
    },
    signal(),
  );
  await planB.execute(
    {
      ...base,
      idempotencyKey: 'site-plan-b-replace',
      operation: 'replace',
      caseId: 'case-traffic-light',
      caseVersion: 1,
      options: ['Keep the usual route and leave as planned.'],
    },
    signal(),
  );
  assert.deepEqual(
    commands.map((command) => (command as { type: string }).type),
    [
      'project.create',
      'project.createWithPlan',
      'project.open',
      'project.update',
      'project.view.set',
      'timeline.add',
      'timeline.update',
      'timeline.move',
      'timeline.delete',
      'tag.create',
      'tag.update',
      'tag.delete',
      'tag.impact.set',
      'tags.sortByImpact',
      'case.create',
      'case.update',
      'case.delete',
      'case.planBOptions.set',
    ],
  );
  assert.deepEqual(committedOperations, [
    'create_project',
    'create_project',
    'open_project',
    'update_project',
    'set_project_view',
    'edit_plan',
    'edit_plan',
    'edit_plan',
    'edit_plan',
    'edit_what_if',
    'edit_what_if',
    'edit_what_if',
    'edit_what_if',
    'edit_what_if',
    'edit_case',
    'edit_case',
    'edit_case',
    'edit_plan_b_options',
  ]);
  assert.deepEqual(
    (commands[1] as { payload: { items: unknown[] } }).payload.items,
    planBundle,
  );
  assert.deepEqual(
    (commands[12] as { payload: { impact: SiteImpactLike } }).payload.impact,
    {
      rank: 5,
      expectedLossAmount: 120,
      currency: 'USD',
      penalty: 'May miss boarding.',
    },
  );
});

test('Direct WebMCP creates and edits an empty or populated Plan B draft without deciding for the person', async () => {
  const storage = new MemoryStorage();
  assert.deepEqual(initializePersistence(() => storage, 'empty'), {
    kind: 'ready',
    source: 'empty',
  });
  const committedSnapshots: Array<{
    operation: string;
    committedVersion: number;
    visibleVersion: number;
    planBOptionsDraft: string[] | null;
  }> = [];
  const tools = createSiteTools({
    dispatch,
    getSnapshot,
    onMutationCommitted: ({ operation, version }) => {
      const snapshot = getSnapshot();
      committedSnapshots.push({
        operation,
        committedVersion: version,
        visibleVersion: snapshot.project.version,
        planBOptionsDraft:
          snapshot.project.timeline[0]?.tags[0]?.cases[0]?.planBOptionsDraft ??
          null,
      });
    },
  });
  const list = JSON.parse(
    await findTool(tools, 'list_projects').execute(
      {},
      { signal: new AbortController().signal },
    ),
  );
  const created = JSON.parse(
    await findTool(tools, 'create_project').execute(
      {
        idempotencyKey: 'candidate-plan-b-only',
        projectId: list.currentProjectId,
        projectVersion: list.currentProjectVersion,
        title: 'Bake a baguette',
        description: 'Prepare one baguette.',
        items: [
          {
            timeOrCue: '11:45',
            title: 'Bake',
            body: 'Score and bake the loaf.',
            tags: [
              {
                question: 'What if the crust darkens too early?',
                rationale: 'Strong top heat can finish the crust first.',
                summary: 'Protect the crust while finishing the center.',
                cases: [
                  {
                    title: 'The center is still underbaked',
                    suggestedActions: [
                      'Tent the loaf with foil.',
                      'Lower the oven by 10°C and continue baking.',
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(created.ok, true);

  const caseItem = getSnapshot().project.timeline[0].tags[0].cases[0];
  assert.deepEqual(caseItem.suggestedActions, [
    'Tent the loaf with foil.',
    'Lower the oven by 10°C and continue baking.',
  ]);
  assert.equal(caseItem.planBOptionsDraft, null);
  assert.equal(caseItem.response, null);

  const currentCase = () =>
    getSnapshot().project.timeline[0].tags[0].cases[0];
  const editPlanB = findTool(tools, 'edit_plan_b_options');
  assert.equal(
    JSON.stringify(editPlanB.inputSchema).includes('disposition'),
    false,
  );
  const replaceDraft = JSON.parse(
    await editPlanB.execute(
      {
        idempotencyKey: 'plan-b-draft-replace',
        projectId: getSnapshot().project.id,
        projectVersion: getSnapshot().project.version,
        operation: 'replace',
        caseId: currentCase().id,
        caseVersion: currentCase().version,
        options: [
          'Tent the loaf with foil.',
          'Lower the oven by 10°C and continue baking.',
        ],
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(replaceDraft.ok, true);
  assert.deepEqual(replaceDraft.authority, {
    scope: 'candidate_edit_only',
    caseResponse: 'unchanged',
    nextRequiredActor: 'human',
  });
  assert.deepEqual(currentCase().planBOptionsDraft, [
    'Tent the loaf with foil.',
    'Lower the oven by 10°C and continue baking.',
  ]);
  assert.deepEqual(committedSnapshots.at(-1), {
    operation: 'edit_plan_b_options',
    committedVersion: getSnapshot().project.version,
    visibleVersion: getSnapshot().project.version,
    planBOptionsDraft: [
      'Tent the loaf with foil.',
      'Lower the oven by 10°C and continue baking.',
    ],
  });
  assert.equal(currentCase().response, null);

  const caseProjection = JSON.parse(
    await findTool(tools, 'get_project').execute(
      { section: 'case', entityId: currentCase().id },
      { signal: new AbortController().signal },
    ),
  );
  assert.deepEqual(
    caseProjection.case.planBOptionsDraft,
    currentCase().planBOptionsDraft,
  );
  assert.equal(caseProjection.case.response, null);

  const updatedDraft = JSON.parse(
    await editPlanB.execute(
      {
        idempotencyKey: 'plan-b-draft-update',
        projectId: getSnapshot().project.id,
        projectVersion: getSnapshot().project.version,
        operation: 'update',
        caseId: currentCase().id,
        caseVersion: currentCase().version,
        optionNumber: 2,
        option: 'Reduce the oven by 15°C and finish baking.',
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(updatedDraft.ok, true);
  assert.deepEqual(currentCase().planBOptionsDraft, [
    'Tent the loaf with foil.',
    'Reduce the oven by 15°C and finish baking.',
  ]);

  const addedDraft = JSON.parse(
    await editPlanB.execute(
      {
        idempotencyKey: 'plan-b-draft-add',
        projectId: getSnapshot().project.id,
        projectVersion: getSnapshot().project.version,
        operation: 'add',
        caseId: currentCase().id,
        caseVersion: currentCase().version,
        option: 'Move the loaf to a lower rack.',
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(addedDraft.ok, true);
  assert.equal(currentCase().planBOptionsDraft?.length, 3);

  const deletedDraftOption = JSON.parse(
    await editPlanB.execute(
      {
        idempotencyKey: 'plan-b-draft-delete',
        projectId: getSnapshot().project.id,
        projectVersion: getSnapshot().project.version,
        operation: 'delete',
        caseId: currentCase().id,
        caseVersion: currentCase().version,
        optionNumber: 1,
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(deletedDraftOption.ok, true);
  assert.deepEqual(currentCase().planBOptionsDraft, [
    'Reduce the oven by 15°C and finish baking.',
    'Move the loaf to a lower rack.',
  ]);

  const discardedDraft = JSON.parse(
    await editPlanB.execute(
      {
        idempotencyKey: 'plan-b-draft-discard',
        projectId: getSnapshot().project.id,
        projectVersion: getSnapshot().project.version,
        operation: 'discard',
        caseId: currentCase().id,
        caseVersion: currentCase().version,
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(discardedDraft.ok, true);
  assert.equal(currentCase().planBOptionsDraft, null);

  const emptyDraft = JSON.parse(
    await editPlanB.execute(
      {
        idempotencyKey: 'plan-b-draft-empty',
        projectId: getSnapshot().project.id,
        projectVersion: getSnapshot().project.version,
        operation: 'replace',
        caseId: currentCase().id,
        caseVersion: currentCase().version,
        options: [],
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(emptyDraft.ok, true);
  assert.deepEqual(currentCase().planBOptionsDraft, []);

  const finalDraft = JSON.parse(
    await editPlanB.execute(
      {
        idempotencyKey: 'plan-b-draft-from-empty',
        projectId: getSnapshot().project.id,
        projectVersion: getSnapshot().project.version,
        operation: 'add',
        caseId: currentCase().id,
        caseVersion: currentCase().version,
        option: 'Tent the loaf and finish on a lower rack.',
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(finalDraft.ok, true);
  assert.deepEqual(currentCase().planBOptionsDraft, [
    'Tent the loaf and finish on a lower rack.',
  ]);
  assert.equal(currentCase().response, null);

  const editCase = findTool(tools, 'edit_case');
  assert.equal(JSON.stringify(editCase.inputSchema).includes('save_response'), false);
  assert.equal(JSON.stringify(editCase.inputSchema).includes('disposition'), false);
  const beforeRejectedDecision = getSnapshot();
  const rejectedDecision = JSON.parse(
    await editCase.execute(
      {
        idempotencyKey: 'agent-must-not-decide',
        projectId: beforeRejectedDecision.project.id,
        projectVersion: beforeRejectedDecision.project.version,
        operation: 'save_response',
        caseId: caseItem.id,
        caseVersion: caseItem.version,
        response: {
          disposition: 'plan_b',
          actions: ['Tent the loaf with foil.'],
          when: '',
          status: null,
        },
      },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(rejectedDecision.ok, false);
  assert.equal(rejectedDecision.code, 'INVALID_INPUT');
  assert.strictEqual(getSnapshot(), beforeRejectedDecision);

  const humanDecision = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: caseItem.id,
      disposition: 'plan_b',
      actions: [...(currentCase().planBOptionsDraft ?? [])],
      when: '',
      status: null,
    },
  });
  assert.equal(humanDecision.ok, true);
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[0].response?.actions,
    ['Tent the loaf and finish on a lower rack.'],
  );
  assert.equal(
    getSnapshot().project.timeline[0].tags[0].cases[0].planBOptionsDraft,
    null,
  );
});

type SiteImpactLike = {
  rank: number;
  expectedLossAmount: number | null;
  currency: string | null;
  penalty: string;
};

test('Direct Site mutations enforce strict input, current versions, cancellation, idempotency, and save failure no-op', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const project = getSnapshot().project;
  const calls: unknown[] = [];
  const committedOperations: string[] = [];
  const dispatchSpy = (raw: unknown): CommandResult => {
    calls.push(raw);
    return { ok: true, code: 'OK', affectedIds: ['item-leave-home'], version: project.version + 1 };
  };
  const tools = createSiteTools({
    dispatch: dispatchSpy,
    getSnapshot,
    onMutationCommitted: ({ operation }) => committedOperations.push(operation),
  });
  const plan = findTool(tools, 'edit_plan');
  const base = {
    projectId: project.id,
    projectVersion: project.version,
    operation: 'update' as const,
    itemId: 'item-leave-home',
    itemVersion: 1,
    timeOrCue: '15:20',
    title: 'Leave home soon',
    body: 'Leave with a small buffer.',
  };
  const malformed = JSON.parse(
    await plan.execute(
      { ...base, idempotencyKey: 'strict-extra', extra: true },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'INVALID_INPUT');
  assert.equal(calls.length, 0);

  const stale = JSON.parse(
    await plan.execute(
      { ...base, idempotencyKey: 'strict-stale', projectVersion: project.version + 1 },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'VERSION_CONFLICT');
  assert.equal(calls.length, 0);

  const cancelledController = new AbortController();
  cancelledController.abort();
  const cancelled = JSON.parse(
    await plan.execute(
      { ...base, idempotencyKey: 'strict-cancelled' },
      { signal: cancelledController.signal },
    ),
  );
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'CANCELLED');
  assert.equal(calls.length, 0);

  const firstInput = { ...base, idempotencyKey: 'strict-replay' };
  const firstText = await plan.execute(firstInput, {
    signal: new AbortController().signal,
  });
  const replayText = await plan.execute(firstInput, {
    signal: new AbortController().signal,
  });
  assert.equal(replayText, firstText);
  assert.equal(calls.length, 1);
  assert.deepEqual(committedOperations, ['edit_plan']);
  const duplicate = JSON.parse(
    await plan.execute(
      { ...firstInput, title: 'A different title' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'DUPLICATE');
  assert.equal(calls.length, 1);

  const failureCalls: unknown[] = [];
  const failureCommits: string[] = [];
  const saveFailure = createSiteTools({
    dispatch: (raw) => {
      failureCalls.push(raw);
      return {
        ok: false,
        code: 'SAVE_FAILED',
        message: 'state.save: local persistence failed.',
        retryable: true,
      };
    },
    getSnapshot,
    onMutationCommitted: ({ operation }) => failureCommits.push(operation),
  });
  const failed = JSON.parse(
    await findTool(saveFailure, 'edit_plan').execute(
      { ...firstInput, idempotencyKey: 'strict-save-failed' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'SAVE_FAILED');
  assert.equal(failureCalls.length, 1);
  assert.deepEqual(failureCommits, []);

  const noChangeCommits: string[] = [];
  const noChangeTools = createSiteTools({
    dispatch: () => ({
      ok: true,
      code: 'NO_CHANGES',
      affectedIds: [],
      version: project.version,
    }),
    getSnapshot,
    onMutationCommitted: ({ operation }) => noChangeCommits.push(operation),
  });
  const unchanged = JSON.parse(
    await findTool(noChangeTools, 'edit_plan').execute(
      { ...firstInput, idempotencyKey: 'strict-no-changes' },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.code, 'NO_CHANGES');
  assert.deepEqual(noChangeCommits, []);
});

test('get_export_projection defaults to a human-readable grouped table', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const tool = findTool(
    createSiteTools({ dispatch, getSnapshot }),
    'get_export_projection',
  );
  const result = JSON.parse(
    await tool.execute({}, { signal: new AbortController().signal }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.projection, 'human_summary');
  assert.equal(result.entryScope, 'all');
  assert.equal(result.projectTitle, 'Test Flight Plan');
  assert.equal('project' in result, false);
  assert.equal(result.presentationContract.projectTitlePlacement, 'heading_once');
  assert.equal(result.presentationContract.repeatedPlanCells, 'blank');
  assert.equal(result.presentationContract.repeatedWhatIfCells, 'blank');
  assert.equal(result.presentationContract.internalMetadata, 'omit');
  assert.deepEqual(
    result.columns.map((column: { key: string }) => column.key),
    [
      'time_or_cue',
      'plan',
      'plan_details',
      'what_if',
      'case',
      'selection',
      'decision',
      'candidate_actions',
      'saved_response',
      'when',
      'status',
      'impact',
    ],
  );
  assert.equal(result.rows.length, 8);
  assert.equal(result.rows[0].plan, 'Leave home');
  assert.equal(result.rows[0].what_if, 'What if traffic is much worse than expected?');
  assert.equal(result.rows[0].case, 'Under 15 min');
  assert.equal(result.rows[0].candidate_actions, '1. Take the usual route and leave as planned.');
  assert.equal(result.rows[1].plan, '');
  assert.equal(result.rows[1].what_if, '');
  assert.equal(result.rows[1].case, '15–45 min');
  assert.equal(result.rows[3].plan, '');
  assert.equal(result.rows[3].what_if, 'What if the taxi does not arrive?');
  assert.equal(result.rows[5].plan, 'Arrive at airport');
  assert.equal(JSON.stringify(result).includes('project-test-trip'), false);
  assert.equal(JSON.stringify(result).includes('"version"'), false);
});

test('get_export_projection strictly validates projection, scope, and columns', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const tool = findTool(
    createSiteTools({ dispatch, getSnapshot }),
    'get_export_projection',
  );
  const signal = { signal: new AbortController().signal };
  const invalidInputs: unknown[] = [
    { projection: 'unknown' },
    { projection: 'timeline', extra: true },
    { projection: 'timeline', entryScope: 'selected' },
    { projection: 'timeline', columns: [] },
    { projection: 'human_summary', columns: ['case'] },
    { projection: 'case_matrix', columns: ['case', 'case'] },
    { projection: 'case_matrix', columns: ['not_a_column'] },
    { projection: 'case_matrix', columns: 'case' },
  ];
  for (const input of invalidInputs) {
    const result = JSON.parse(await tool.execute(input, signal));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_INPUT');
  }
});

test('get_export_projection keeps saved Case scope, one-Case cardinality, and action provenance', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const tools = createSiteTools({ dispatch, getSnapshot });
  const tool = findTool(tools, 'get_export_projection');
  const signal = { signal: new AbortController().signal };

  const accepted = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-light',
      disposition: 'accept',
      actions: ['Human response: keep the usual route.'],
      when: '',
      status: null,
    },
  });
  assert.equal(accepted.ok, true);
  const planned = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-heavy',
      disposition: 'plan_b',
      actions: ['Response option one.', 'Response option two.'],
      when: '',
      status: null,
    },
  });
  assert.equal(planned.ok, true);
  const dismissed = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-medium',
      disposition: 'dismiss',
      actions: [],
      when: '',
      status: null,
    },
  });
  assert.equal(dismissed.ok, true);

  const selected = JSON.parse(
    await tool.execute({ projection: 'case_matrix' }, signal),
  );
  assert.equal(selected.ok, true);
  assert.equal(selected.entryScope, 'selected_only');
  assert.equal(selected.records.length, 2);
  assert.deepEqual(
    selected.records.map((record: Record<string, unknown>) => record.case),
    ['Under 15 min', 'Over 45 min'],
  );
  assert.deepEqual(selected.records[0].candidate_actions, [
    'Take the usual route and leave as planned.',
  ]);
  assert.deepEqual(selected.records[0].response_actions, [
    'Human response: keep the usual route.',
  ]);
  assert.equal(selected.records[0].entry_scope, 'selected');
  assert.equal(selected.records[0].decision, 'accept');
  assert.deepEqual(selected.records[1].response_actions, [
    'Response option one.',
    'Response option two.',
  ]);

  const candidates = JSON.parse(
    await tool.execute({ projection: 'case_matrix', entryScope: 'candidates' }, signal),
  );
  assert.equal(candidates.ok, true);
  assert.equal(candidates.records.every((record: Record<string, unknown>) => record.entry_scope === 'candidate'), true);
  assert.equal(candidates.records.some((record: Record<string, unknown>) => record.case === 'Driver is delayed'), true);
  assert.equal(candidates.records.some((record: Record<string, unknown>) => record.case === 'Under 15 min'), false);
  assert.equal(candidates.records.some((record: Record<string, unknown>) => record.case === 'Over 45 min'), false);

  const all = JSON.parse(
    await tool.execute({ projection: 'case_matrix', entryScope: 'all' }, signal),
  );
  assert.equal(all.ok, true);
  assert.equal(all.records.length, 7);
  assert.equal(all.records.some((record: Record<string, unknown>) => record.case === '15–45 min'), false);
  assert.equal(all.records.filter((record: Record<string, unknown>) => record.case === 'Under 15 min').length, 1);
  assert.equal(all.records.filter((record: Record<string, unknown>) => record.case === 'Over 45 min').length, 1);
});

test('get_export_projection preserves plan order and caller-supplied case matrix column order', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const before = getSnapshot();
  const tool = findTool(
    createSiteTools({ dispatch, getSnapshot }),
    'get_export_projection',
  );
  const signal = { signal: new AbortController().signal };
  const columns = ['case', 'plan_order', 'candidate_actions', 'decision'] as const;
  const matrix = JSON.parse(
    await tool.execute({ projection: 'case_matrix', entryScope: 'all', columns }, signal),
  );
  assert.equal(matrix.ok, true);
  assert.deepEqual(matrix.columns, columns);
  assert.deepEqual(Object.keys(matrix.records[0]), columns);
  assert.equal(matrix.records[0].case, 'Under 15 min');
  assert.equal(matrix.records[0].plan_order, 1);
  assert.deepEqual(matrix.records[0].candidate_actions, [
    'Take the usual route and leave as planned.',
  ]);
  assert.equal(matrix.records[0].decision, null);

  const timeline = JSON.parse(
    await tool.execute({ projection: 'timeline', entryScope: 'all' }, signal),
  );
  assert.equal(timeline.ok, true);
  assert.deepEqual(
    timeline.records.map((record: { planOrder: number }) => record.planOrder),
    [1, 2, 3],
  );
  assert.equal(timeline.records[0].entries.length, 5);
  assert.equal(timeline.records[1].entries.length, 2);
  assert.equal(timeline.records[2].entries.length, 1);
  assert.equal(timeline.records[0].entries[0].whatIf, 'What if traffic is much worse than expected?');
  assert.deepEqual(timeline.records[0].entries[0].candidateActions, [
    'Take the usual route and leave as planned.',
  ]);
  assert.deepEqual(timeline.records[0].entries[0].responseActions, []);
  assert.strictEqual(getSnapshot(), before);
});

test('get_export_projection returns runbook sections and excludes resolved or dismissed history', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const baseSnapshot = getSnapshot();
  const customSnapshot = JSON.parse(JSON.stringify(baseSnapshot)) as typeof baseSnapshot;
  customSnapshot.project.timeline[0].tags[1].lifecycle = 'resolved';
  customSnapshot.project.timeline[1].tags[0].cases[0].response = {
    disposition: 'dismiss',
    actions: [],
    when: '',
    status: null,
  };
  const tool = findTool(
    createSiteTools({ dispatch, getSnapshot: () => customSnapshot }),
    'get_export_projection',
  );
  const runbook = JSON.parse(
    await tool.execute({ projection: 'runbook', entryScope: 'all' }, {
      signal: new AbortController().signal,
    }),
  );
  assert.equal(runbook.ok, true);
  assert.equal(runbook.sections.length, 3);
  assert.equal(runbook.sections[0].selectedResponses.length, 3);
  assert.equal(runbook.sections[0].selectedResponses.some((entry: { whatIf: string }) => entry.whatIf === 'What if the taxi does not arrive?'), false);
  assert.equal(runbook.sections[1].selectedResponses.length, 1);
  assert.equal(runbook.sections[1].selectedResponses[0].case, 'A digital copy is available');
});

test('get_export_projection returns stable NOT_FOUND and whole-result OUTPUT_LIMIT errors', async () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const notFoundTool = findTool(
    createSiteTools({ dispatch, getSnapshot }),
    'get_export_projection',
  );
  const signal = { signal: new AbortController().signal };
  const notFound = JSON.parse(
    await notFoundTool.execute(
      { projectId: 'missing-project', projection: 'timeline' },
      signal,
    ),
  );
  assert.equal(notFound.ok, false);
  assert.equal(notFound.code, 'NOT_FOUND');

  const baseSnapshot = getSnapshot();
  const oversizedSnapshot = JSON.parse(JSON.stringify(baseSnapshot)) as typeof baseSnapshot;
  oversizedSnapshot.project.title = 'x'.repeat(12_000);
  const oversizedTool = findTool(
    createSiteTools({ dispatch, getSnapshot: () => oversizedSnapshot }),
    'get_export_projection',
  );
  const oversized = JSON.parse(
    await oversizedTool.execute({ projection: 'timeline' }, signal),
  );
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, 'OUTPUT_LIMIT');
  assert.equal('records' in oversized, false);
});
