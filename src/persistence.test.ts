import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatch,
  EMPTY_WORKSPACE_PROJECT_ID,
  getSnapshot,
  isEmptyWorkspaceProject,
  MAX_PROJECTS,
  STORAGE_KEY,
  subscribe,
  type PersistenceResult,
  type StoragePort,
} from './app-state.ts';
import {
  initializeTestPersistence as initializePersistence,
  resetTestPersistence as resetPersistence,
  sampleTestState,
} from './test-fixtures.ts';

class ProfileStorage implements StoragePort {
  readonly values = new Map<string, string>();
  readonly getKeys: string[] = [];
  readonly setKeys: string[] = [];
  readonly removeKeys: string[] = [];
  beforeSet: (() => void) | null = null;
  getError: Error | null = null;
  setError: Error | null = null;
  removeError: Error | null = null;

  getItem(key: string): string | null {
    this.getKeys.push(key);
    if (this.getError) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.setKeys.push(key);
    this.beforeSet?.();
    if (this.setError) throw this.setError;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removeKeys.push(key);
    if (this.removeError) throw this.removeError;
    this.values.delete(key);
  }
}

function assertRecoveryReason(
  result: PersistenceResult,
  reason: Extract<PersistenceResult, { kind: 'recovery' }>['reason'],
): void {
  assert.equal(result.kind, 'recovery');
  if (result.kind === 'recovery') assert.equal(result.reason, reason);
}

function asSchemaVersion2Project(project: unknown) {
  const legacy = JSON.parse(JSON.stringify(project));
  delete legacy.activeRecheckRequest;
  for (const item of legacy.timeline) {
    for (const tag of item.tags) {
      delete tag.lifecycle;
      delete tag.basedOnItemVersion;
      delete tag.basedOnProjectVersion;
      delete tag.impact;
      for (const caseItem of tag.cases) {
        delete caseItem.suggestedActionSource;
        delete caseItem.planBOptions;
        delete caseItem.responseCandidates;
      }
    }
  }
  return legacy;
}

function asSchemaVersion3State(state: unknown) {
  const legacy = JSON.parse(JSON.stringify(state));
  legacy.schemaVersion = 3;
  for (const project of [legacy.project, ...legacy.projects]) {
    for (const item of project.timeline) {
      for (const tag of item.tags) {
        delete tag.impact;
        for (const caseItem of tag.cases) {
          delete caseItem.suggestedActionSource;
          delete caseItem.planBOptions;
          delete caseItem.responseCandidates;
        }
      }
    }
  }
  return legacy;
}

test('empty bootstrap stays out of saved Projects and returns after the last Project is deleted', () => {
  const storage = new ProfileStorage();
  assert.deepEqual(initializePersistence(() => storage, 'empty'), {
    kind: 'ready',
    source: 'empty',
  });
  assert.equal(getSnapshot().project.id, EMPTY_WORKSPACE_PROJECT_ID);
  assert.equal(isEmptyWorkspaceProject(getSnapshot().project), true);
  assert.equal(getSnapshot().project.timeline.length, 0);
  assert.deepEqual(getSnapshot().projects, []);

  const created = dispatch({
    type: 'project.create',
    payload: {
      title: 'First real Project',
      description: '',
      requestReview: false,
    },
  });
  assert.equal(created.ok, true);
  assert.equal(isEmptyWorkspaceProject(getSnapshot().project), false);
  assert.deepEqual(getSnapshot().projects, []);
  assert.equal(
    JSON.parse(storage.values.get(STORAGE_KEY) ?? '').projects.length,
    0,
  );

  const firstProjectId = getSnapshot().project.id;
  const createdSecond = dispatch({
    type: 'project.create',
    payload: {
      title: 'Second Project',
      description: '',
      requestReview: false,
    },
  });
  assert.equal(createdSecond.ok, true);
  const secondProjectId = getSnapshot().project.id;
  assert.equal(getSnapshot().projects[0].id, firstProjectId);

  const deletedSecond = dispatch({
    type: 'project.delete',
    payload: { projectId: secondProjectId },
  });
  assert.equal(deletedSecond.ok, true);
  assert.equal(getSnapshot().project.id, firstProjectId);
  assert.deepEqual(getSnapshot().projects, []);

  const deletedLast = dispatch({
    type: 'project.delete',
    payload: { projectId: firstProjectId },
  });
  assert.equal(deletedLast.ok, true);
  assert.equal(isEmptyWorkspaceProject(getSnapshot().project), true);
  assert.deepEqual(getSnapshot().projects, []);
  assert.deepEqual(initializePersistence(() => storage, 'empty'), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.id, EMPTY_WORKSPACE_PROJECT_ID);
});

test('production load removes the legacy bundled debug Project without discarding real Projects', () => {
  const legacyOnlyStorage = new ProfileStorage();
  const legacyOnly = JSON.parse(JSON.stringify(sampleTestState));
  legacyOnly.project.id = 'project-airport-trip';
  legacyOnly.project.title = 'Tokyo Flight';
  legacyOnlyStorage.values.set(STORAGE_KEY, JSON.stringify(legacyOnly));

  assert.deepEqual(initializePersistence(() => legacyOnlyStorage, 'empty'), {
    kind: 'ready',
    source: 'empty',
  });
  assert.equal(getSnapshot().project.id, EMPTY_WORKSPACE_PROJECT_ID);
  assert.deepEqual(legacyOnlyStorage.removeKeys, [STORAGE_KEY]);
  assert.equal(legacyOnlyStorage.values.has(STORAGE_KEY), false);

  const mixedStorage = new ProfileStorage();
  const mixed = JSON.parse(JSON.stringify(legacyOnly));
  const realProject = JSON.parse(JSON.stringify(sampleTestState.project));
  realProject.id = 'project-real-plan';
  realProject.title = 'My saved Plan';
  realProject.timeline = [];
  realProject.gapSuggestions = [];
  mixed.projects = [realProject];
  mixedStorage.values.set(STORAGE_KEY, JSON.stringify(mixed));

  assert.deepEqual(initializePersistence(() => mixedStorage, 'empty'), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.id, 'project-real-plan');
  assert.deepEqual(getSnapshot().projects, []);
  assert.deepEqual(mixedStorage.setKeys, [STORAGE_KEY]);
  assert.equal(
    JSON.stringify(JSON.parse(mixedStorage.values.get(STORAGE_KEY) ?? '')).includes(
      'project-airport-trip',
    ),
    false,
  );
});

test('local persistence Profile preserves valid state and contains every failure', () => {
  const storage = new ProfileStorage();
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'seed',
  });
  assert.deepEqual(storage.getKeys, [STORAGE_KEY]);

  const beforeRequest = getSnapshot();
  let snapshotDuringSet = getSnapshot();
  let listenerCalls = 0;
  storage.beforeSet = () => {
    snapshotDuringSet = getSnapshot();
  };
  const unsubscribe = subscribe(() => {
    listenerCalls += 1;
  });
  const requested = dispatch({
    type: 'review.request',
    payload: {
      kind: 'timeline_whatifs',
      ownerId: beforeRequest.project.id,
    },
  });
  unsubscribe();
  assert.equal(requested.ok, true);
  assert.strictEqual(snapshotDuringSet, beforeRequest);
  assert.equal(listenerCalls, 1);
  assert.deepEqual(storage.setKeys, [STORAGE_KEY]);

  const savedBytes = storage.values.get(STORAGE_KEY);
  assert.ok(savedBytes);
  const savedState = JSON.parse(savedBytes);
  assert.deepEqual(savedState, { ...getSnapshot(), undoDelete: null });
  assert.ok(savedState.project.timeline[0].tags[0].cases.length > 1);
  assert.ok(savedState.project.gapSuggestions.length > 0);
  assert.ok(savedState.project.activeReviewRequest);

  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.deepEqual(getSnapshot(), savedState);

  const activeRequestId = getSnapshot().project.activeReviewRequest?.id ?? '';
  assert.equal(
    dispatch({
      type: 'review.clear',
      payload: { requestId: activeRequestId },
    }).ok,
    true,
  );
  assert.equal(
    dispatch({
      type: 'timeline.delete',
      payload: { itemId: 'item-flight' },
    }).ok,
    true,
  );
  assert.ok(getSnapshot().undoDelete);
  assert.equal(JSON.parse(storage.values.get(STORAGE_KEY) ?? '').undoDelete, null);
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().undoDelete, null);

  const lastValid = getSnapshot();
  const corrupt = new ProfileStorage();
  corrupt.values.set(STORAGE_KEY, '{not-json');
  assertRecoveryReason(initializePersistence(() => corrupt), 'corrupt');
  assert.strictEqual(getSnapshot(), lastValid);
  const blockedDuringRecovery = dispatch({
    type: 'project.update',
    payload: {
      title: 'Must not overwrite recovery data',
      description: lastValid.project.description,
    },
  });
  assert.equal(blockedDuringRecovery.ok, false);
  assert.equal(blockedDuringRecovery.code, 'SAVE_FAILED');
  assert.equal(corrupt.values.get(STORAGE_KEY), '{not-json');
  assert.strictEqual(getSnapshot(), lastValid);

  const invalid = new ProfileStorage();
  invalid.values.set(STORAGE_KEY, JSON.stringify({ schemaVersion: 1 }));
  assertRecoveryReason(
    initializePersistence(() => invalid),
    'invalid_shape',
  );
  assert.strictEqual(getSnapshot(), lastValid);

  const nonNormalized = new ProfileStorage();
  const nonNormalizedState = JSON.parse(savedBytes);
  nonNormalizedState.project.title = ` ${nonNormalizedState.project.title}`;
  nonNormalized.values.set(STORAGE_KEY, JSON.stringify(nonNormalizedState));
  assertRecoveryReason(
    initializePersistence(() => nonNormalized),
    'invalid_shape',
  );
  assert.strictEqual(getSnapshot(), lastValid);

  const invalidViewMode = new ProfileStorage();
  const invalidViewModeState = JSON.parse(savedBytes);
  invalidViewModeState.project.viewMode = 'print';
  invalidViewMode.values.set(
    STORAGE_KEY,
    JSON.stringify(invalidViewModeState),
  );
  assertRecoveryReason(
    initializePersistence(() => invalidViewMode),
    'invalid_shape',
  );
  assert.strictEqual(getSnapshot(), lastValid);

  for (const schemaVersion of [0, 9]) {
    const unsupported = new ProfileStorage();
    unsupported.values.set(STORAGE_KEY, JSON.stringify({ schemaVersion }));
    assertRecoveryReason(
      initializePersistence(() => unsupported),
      'unsupported_version',
    );
    assert.strictEqual(getSnapshot(), lastValid);
  }

  const unreadable = new ProfileStorage();
  unreadable.getError = new Error('read denied');
  assertRecoveryReason(
    initializePersistence(() => unreadable),
    'read_failed',
  );
  assert.strictEqual(getSnapshot(), lastValid);

  const missingAfterStored = new ProfileStorage();
  assert.deepEqual(initializePersistence(() => missingAfterStored), {
    kind: 'ready',
    source: 'seed',
  });
  assert.equal(getSnapshot().project.title, 'Test Flight Plan');
  assert.equal(getSnapshot().project.timeline.length, 3);

  for (const error of [
    new Error('write failed'),
    new DOMException('quota full', 'QuotaExceededError'),
  ]) {
    const unwritable = new ProfileStorage();
    assert.equal(initializePersistence(() => unwritable).kind, 'ready');
    unwritable.setError = error;
    const beforeFailedSave = getSnapshot();
    let failedListenerCalls = 0;
    const stop = subscribe(() => {
      failedListenerCalls += 1;
    });
    const failed = dispatch({
      type: 'project.update',
      payload: {
        title: `${beforeFailedSave.project.title} retry`,
        description: beforeFailedSave.project.description,
      },
    });
    stop();
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'SAVE_FAILED');
    assert.strictEqual(getSnapshot(), beforeFailedSave);
    assert.equal(failedListenerCalls, 0);
  }

  const resettable = new ProfileStorage();
  resettable.values.set(STORAGE_KEY, '{broken');
  resettable.values.set('sentinel:other-app', 'keep');
  assert.equal(initializePersistence(() => resettable).kind, 'recovery');
  assert.deepEqual(resetPersistence(() => resettable), {
    kind: 'ready',
    source: 'reset',
  });
  assert.deepEqual(resettable.removeKeys, [STORAGE_KEY]);
  assert.equal(resettable.values.has(STORAGE_KEY), false);
  assert.equal(resettable.values.get('sentinel:other-app'), 'keep');
  assert.equal(getSnapshot().project.title, 'Test Flight Plan');

  const unresettable = new ProfileStorage();
  unresettable.values.set(STORAGE_KEY, savedBytes);
  unresettable.removeError = new Error('remove denied');
  const beforeFailedReset = getSnapshot();
  assertRecoveryReason(
    resetPersistence(() => unresettable),
    'reset_failed',
  );
  assert.strictEqual(getSnapshot(), beforeFailedReset);
  assert.equal(unresettable.values.get(STORAGE_KEY), savedBytes);
});

test('multi-project create/open uses one durable AppState and preserves empty Plans', () => {
  const storage = new ProfileStorage();
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'seed',
  });

  const originalProjectId = getSnapshot().project.id;
  const created = dispatch({
    type: 'project.create',
    payload: {
      title: 'Speech rehearsal',
      description: '',
      requestReview: false,
    },
  });
  assert.equal(created.ok, true);
  assert.equal(getSnapshot().project.title, 'Speech rehearsal');
  assert.equal(getSnapshot().project.timeline.length, 0);
  assert.equal(getSnapshot().projects.length, 1);
  assert.equal(getSnapshot().projects[0].id, originalProjectId);

  const addItem = dispatch({
    type: 'timeline.add',
    payload: {
      timeOrCue: '09:00',
      title: 'Opening',
      body: '',
      requestReview: false,
    },
  });
  assert.equal(addItem.ok, true);
  const newItemId = addItem.ok ? addItem.affectedIds[0] : '';
  assert.equal(getSnapshot().project.timeline.length, 1);
  assert.equal(
    dispatch({
      type: 'timeline.delete',
      payload: { itemId: newItemId },
    }).ok,
    true,
  );
  assert.equal(getSnapshot().project.timeline.length, 0);

  const newProjectId = getSnapshot().project.id;
  const openedOriginal = dispatch({
    type: 'project.open',
    payload: { projectId: originalProjectId },
  });
  assert.equal(openedOriginal.ok, true);
  assert.equal(getSnapshot().project.id, originalProjectId);
  assert.equal(getSnapshot().projects.length, 1);
  assert.equal(getSnapshot().projects[0].id, newProjectId);
  assert.equal(getSnapshot().undoDelete, null);

  const openedNew = dispatch({
    type: 'project.open',
    payload: { projectId: newProjectId },
  });
  assert.equal(openedNew.ok, true);
  assert.equal(getSnapshot().project.id, newProjectId);
  assert.equal(getSnapshot().project.timeline.length, 0);

  const request = dispatch({
    type: 'review.request',
    payload: { kind: 'timeline_whatifs', ownerId: newProjectId },
  });
  assert.equal(request.ok, true);
  const waitingState = getSnapshot();
  const blockedOpen = dispatch({
    type: 'project.open',
    payload: { projectId: originalProjectId },
  });
  assert.equal(blockedOpen.ok, false);
  assert.equal(blockedOpen.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), waitingState);
  const blockedCreate = dispatch({
    type: 'project.create',
    payload: {
      title: 'Blocked project',
      description: '',
      requestReview: false,
    },
  });
  assert.equal(blockedCreate.ok, false);
  assert.equal(blockedCreate.code, 'INVALID_STATE');
  const requestId = getSnapshot().project.activeReviewRequest?.id ?? '';
  assert.equal(
    dispatch({
      type: 'review.clear',
      payload: { requestId },
    }).ok,
    true,
  );

  const beforeFailedOpen = getSnapshot();
  const savedBeforeFailedOpen = storage.values.get(STORAGE_KEY);
  storage.setError = new Error('write failed');
  const failedOpen = dispatch({
    type: 'project.open',
    payload: { projectId: originalProjectId },
  });
  assert.equal(failedOpen.ok, false);
  assert.equal(failedOpen.code, 'SAVE_FAILED');
  assert.strictEqual(getSnapshot(), beforeFailedOpen);
  assert.equal(storage.values.get(STORAGE_KEY), savedBeforeFailedOpen);
  storage.setError = null;
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.id, newProjectId);
  assert.equal(getSnapshot().projects[0].id, originalProjectId);
  assert.equal(
    dispatch({
      type: 'project.open',
      payload: { projectId: originalProjectId },
    }).ok,
    true,
  );
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.id, originalProjectId);
  assert.equal(getSnapshot().projects[0].id, newProjectId);

  const limitStorage = new ProfileStorage();
  assert.equal(initializePersistence(() => limitStorage).kind, 'ready');
  for (let index = 0; index < MAX_PROJECTS - 1; index += 1) {
    assert.equal(
      dispatch({
        type: 'project.create',
        payload: {
          title: `Project ${index + 1}`,
          description: '',
          requestReview: false,
        },
      }).ok,
      true,
    );
  }
  const overLimit = dispatch({
    type: 'project.create',
    payload: {
      title: 'One too many',
      description: '',
      requestReview: false,
    },
  });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.code, 'LIMIT_EXCEEDED');
  assert.equal(getSnapshot().projects.length, MAX_PROJECTS - 1);
});

test('project.create manual and AI modes persist distinct request state atomically', () => {
  const storage = new ProfileStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const originalProjectId = getSnapshot().project.id;

  const manual = dispatch({
    type: 'project.create',
    payload: {
      title: 'Manual Plan',
      description: '',
      requestReview: false,
    },
  });
  assert.equal(manual.ok, true);
  assert.equal(manual.ok ? manual.affectedIds.length : 0, 2);
  const manualProjectId = getSnapshot().project.id;
  assert.equal(getSnapshot().project.description, '');
  assert.equal(getSnapshot().project.timeline.length, 0);
  assert.equal(getSnapshot().project.activeReviewRequest, null);
  assert.deepEqual(
    getSnapshot().projects.map((project) => project.id),
    [originalProjectId],
  );

  const manualBeforeReload = JSON.parse(storage.values.get(STORAGE_KEY) ?? '');
  assert.equal(manualBeforeReload.project.description, '');
  assert.equal(manualBeforeReload.project.activeReviewRequest, null);
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.id, manualProjectId);
  assert.equal(getSnapshot().project.timeline.length, 0);

  const beforeInvalid = getSnapshot();
  const missingFields = dispatch({
    type: 'project.create',
    payload: { title: 'Missing fields' },
  });
  assert.equal(missingFields.ok, false);
  assert.equal(missingFields.code, 'INVALID_INPUT');
  assert.strictEqual(getSnapshot(), beforeInvalid);
  const emptyBrief = dispatch({
    type: 'project.create',
    payload: {
      title: 'AI Plan',
      description: '',
      requestReview: true,
    },
  });
  assert.equal(emptyBrief.ok, false);
  assert.equal(emptyBrief.code, 'INVALID_INPUT');
  assert.strictEqual(getSnapshot(), beforeInvalid);

  const beforeFailed = getSnapshot();
  const bytesBeforeFailed = storage.values.get(STORAGE_KEY);
  storage.setError = new Error('write failed');
  const failed = dispatch({
    type: 'project.create',
    payload: {
      title: 'AI Plan',
      description: 'Prepare a short launch talk.',
      requestReview: true,
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'SAVE_FAILED');
  assert.strictEqual(getSnapshot(), beforeFailed);
  assert.equal(storage.values.get(STORAGE_KEY), bytesBeforeFailed);
  storage.setError = null;

  const ai = dispatch({
    type: 'project.create',
    payload: {
      title: 'AI Plan',
      description: 'Prepare a short launch talk.',
      requestReview: true,
    },
  });
  assert.equal(ai.ok, true);
  const request = getSnapshot().project.activeReviewRequest;
  assert.ok(request);
  assert.equal(request?.kind, 'project_plan');
  assert.equal(request?.ownerId, getSnapshot().project.id);
  assert.equal(request?.ownerVersion, 1);
  assert.equal(request?.projectVersion, 1);
  assert.equal(
    ai.ok ? ai.affectedIds.includes(request?.id ?? '') : false,
    true,
  );
  assert.equal(getSnapshot().project.description, 'Prepare a short launch talk.');
  assert.equal(getSnapshot().project.timeline.length, 0);
  assert.deepEqual(
    getSnapshot().projects.map((project) => project.id),
    [originalProjectId, manualProjectId],
  );

  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.title, 'AI Plan');
  assert.equal(getSnapshot().project.description, 'Prepare a short launch talk.');
  assert.equal(getSnapshot().project.timeline.length, 0);
  assert.equal(getSnapshot().project.activeReviewRequest?.kind, 'project_plan');
  assert.equal(getSnapshot().project.activeReviewRequest?.ownerVersion, 1);

  const planItems = [
    {
      timeOrCue: '00:00',
      title: 'Opening',
      body: 'Welcome the audience and state the purpose.',
      tags: [
        {
          question: 'What if the room is still noisy?',
          rationale: 'The opening may be missed while people are talking.',
          summary: 'Get attention before starting the talk.',
          cases: [
            {
              title: 'Noise continues',
              suggestedActions: ['Ask for a brief pause, then begin.'],
            },
          ],
        },
      ],
    },
  ];
  const beforeFailedApply = getSnapshot();
  const bytesBeforeFailedApply = storage.values.get(STORAGE_KEY);
  storage.setError = new Error('write failed');
  const failedApply = dispatch({
    type: 'review.project_plan.apply',
    payload: {
      requestId: request?.id ?? '',
      projectId: beforeFailedApply.project.id,
      projectVersion: beforeFailedApply.project.version,
      items: planItems,
    },
  });
  assert.equal(failedApply.ok, false);
  assert.equal(failedApply.code, 'SAVE_FAILED');
  assert.strictEqual(getSnapshot(), beforeFailedApply);
  assert.equal(storage.values.get(STORAGE_KEY), bytesBeforeFailedApply);
  storage.setError = null;

  const applied = dispatch({
    type: 'review.project_plan.apply',
    payload: {
      requestId: request?.id ?? '',
      projectId: beforeFailedApply.project.id,
      projectVersion: beforeFailedApply.project.version,
      items: planItems,
    },
  });
  assert.equal(applied.ok, true);
  assert.equal(getSnapshot().project.timeline.length, 1);
  assert.equal(getSnapshot().project.timeline[0].title, 'Opening');
  assert.equal(getSnapshot().project.timeline[0].tags[0].source, 'agent');
  assert.equal(getSnapshot().project.activeReviewRequest, null);

  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.timeline.length, 1);
  assert.equal(getSnapshot().project.timeline[0].tags[0].cases[0].response, null);

  const beforeNonemptyPlanRequest = getSnapshot();
  const nonemptyPlanRequest = dispatch({
    type: 'review.request',
    payload: {
      kind: 'project_plan',
      ownerId: beforeNonemptyPlanRequest.project.id,
    },
  });
  assert.equal(nonemptyPlanRequest.ok, false);
  assert.equal(nonemptyPlanRequest.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), beforeNonemptyPlanRequest);
});

test('schemaVersion 1 through 7 bytes are strictly validated and lazily migrated to v8', () => {
  const seedStorage = new ProfileStorage();
  assert.equal(initializePersistence(() => seedStorage).kind, 'ready');
  const schemaVersion2Project = asSchemaVersion2Project(
    getSnapshot().project,
  );

  const version2Storage = new ProfileStorage();
  version2Storage.values.set(
    STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 2,
      project: schemaVersion2Project,
      projects: [],
      undoDelete: null,
    }),
  );
  assert.deepEqual(initializePersistence(() => version2Storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(version2Storage.setKeys.length, 0);
  assert.equal(getSnapshot().schemaVersion, 8);
  assert.equal(getSnapshot().project.activeRecheckRequest, null);
  assert.equal(
    getSnapshot().project.timeline.every((item) =>
      item.tags.every(
        (tag) =>
          tag.lifecycle === 'active' &&
          tag.basedOnItemVersion === item.version &&
          tag.basedOnProjectVersion === getSnapshot().project.version,
      ),
    ),
    true,
  );

  const schemaVersion3State = asSchemaVersion3State(getSnapshot());
  const legacyAgentCase = schemaVersion3State.project.timeline[0].tags[0].cases[0];
  const legacyEmptyCase = schemaVersion3State.project.timeline[0].tags[0].cases[1];
  legacyEmptyCase.source = 'human';
  legacyEmptyCase.suggestedActions = [];
  const legacyHumanStartingCase = {
    id: 'case-v3-human-starting-action',
    version: 1,
    source: 'human',
    title: 'Human starting action',
    suggestedActions: ['Use the backup scale I already prepared.'],
    response: null,
  };
  const legacyAgentFilledHumanCase = {
    id: 'case-v3-agent-filled-human-case',
    version: 2,
    source: 'human',
    title: 'Agent filled this human Case',
    suggestedActions: [
      'Check the scale battery and contacts.',
      'Use a second scale or a bounded volume conversion.',
    ],
    response: null,
  };
  schemaVersion3State.project.timeline[0].tags[0].cases.push(
    legacyHumanStartingCase,
    legacyAgentFilledHumanCase,
  );
  const version3Storage = new ProfileStorage();
  version3Storage.values.set(STORAGE_KEY, JSON.stringify(schemaVersion3State));
  assert.deepEqual(initializePersistence(() => version3Storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(version3Storage.setKeys.length, 0);
  assert.equal(getSnapshot().schemaVersion, 8);
  assert.equal(
    getSnapshot().project.timeline[0].tags[0].cases[0].suggestedActionSource,
    'agent',
  );
  assert.equal(
    getSnapshot().project.timeline[0].tags[0].cases[1].suggestedActionSource,
    null,
  );
  assert.equal(
    getSnapshot().project.timeline[0].tags[0].cases[3].suggestedActionSource,
    'human',
  );
  assert.equal(
    getSnapshot().project.timeline[0].tags[0].cases[4].suggestedActionSource,
    'agent',
  );
  assert.equal(
    getSnapshot().project.timeline[0].tags[0].lifecycle,
    schemaVersion3State.project.timeline[0].tags[0].lifecycle,
  );
  assert.equal(legacyAgentCase.suggestedActionSource, undefined);

  const schemaVersion5State = JSON.parse(JSON.stringify(getSnapshot()));
  schemaVersion5State.schemaVersion = 5;
  for (const project of [
    schemaVersion5State.project,
    ...schemaVersion5State.projects,
  ]) {
    for (const item of project.timeline) {
      for (const tag of item.tags) {
        for (const caseItem of tag.cases) {
          delete caseItem.planBOptions;
          delete caseItem.responseCandidates;
        }
      }
    }
  }
  const version5Storage = new ProfileStorage();
  version5Storage.values.set(
    STORAGE_KEY,
    JSON.stringify(schemaVersion5State),
  );
  assert.deepEqual(initializePersistence(() => version5Storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().schemaVersion, 8);
  assert.equal(
    getSnapshot().project.timeline.every((item) =>
      item.tags.every((tag) =>
        tag.cases.every((caseItem) => caseItem.planBOptions.length === 0),
      ),
    ),
    true,
  );

  const schemaVersion6State = JSON.parse(JSON.stringify(getSnapshot()));
  schemaVersion6State.schemaVersion = 6;
  const v6Cases = schemaVersion6State.project.timeline[0].tags[0].cases;
  for (const project of [
    schemaVersion6State.project,
    ...schemaVersion6State.projects,
  ]) {
    for (const item of project.timeline) {
      for (const tag of item.tags) {
        for (const caseItem of tag.cases) {
          delete caseItem.planBOptions;
          delete caseItem.responseCandidates;
          caseItem.planBOptionsDraft = null;
        }
      }
    }
  }
  v6Cases[0].planBOptionsDraft = ['Use the backup route.'];
  v6Cases[1].response = {
    disposition: 'plan_b',
    actions: ['Call a second provider.'],
    when: '',
    status: null,
  };
  const version6Storage = new ProfileStorage();
  version6Storage.values.set(STORAGE_KEY, JSON.stringify(schemaVersion6State));
  assert.deepEqual(initializePersistence(() => version6Storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().schemaVersion, 8);
  const migratedCases = getSnapshot().project.timeline[0].tags[0].cases;
  assert.equal(migratedCases[0].planBOptions[0].action, 'Use the backup route.');
  assert.equal(migratedCases[0].planBOptions[0].response, null);
  assert.equal(migratedCases[1].response, null);
  assert.deepEqual(migratedCases[1].planBOptions[0].response, {
    disposition: 'prepare',
    actions: ['Call a second provider.'],
    when: '',
    status: 'pending',
  });

  const schemaVersion7State = JSON.parse(JSON.stringify(getSnapshot()));
  schemaVersion7State.schemaVersion = 7;
  for (const project of [
    schemaVersion7State.project,
    ...schemaVersion7State.projects,
  ]) {
    for (const item of project.timeline) {
      for (const tag of item.tags) {
        for (const caseItem of tag.cases) {
          delete caseItem.responseCandidates;
          for (const option of caseItem.planBOptions) {
            delete option.responseCandidates;
          }
        }
      }
    }
  }
  const version7Storage = new ProfileStorage();
  version7Storage.values.set(
    STORAGE_KEY,
    JSON.stringify(schemaVersion7State),
  );
  assert.deepEqual(initializePersistence(() => version7Storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().schemaVersion, 8);
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[0].responseCandidates,
    [],
  );
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[0].planBOptions[0]
      .responseCandidates,
    [],
  );

  const legacyStorage = new ProfileStorage();
  legacyStorage.values.set(
    STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      project: schemaVersion2Project,
      undoDelete: null,
    }),
  );

  assert.deepEqual(initializePersistence(() => legacyStorage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(legacyStorage.setKeys.length, 0);
  assert.equal(getSnapshot().schemaVersion, 8);
  assert.deepEqual(getSnapshot().projects, []);
  assert.equal(getSnapshot().project.title, 'Test Flight Plan');

  const legacyEmpty = new ProfileStorage();
  const legacyEmptyBytes = JSON.parse(
    legacyStorage.values.get(STORAGE_KEY) ?? '',
  );
  legacyEmptyBytes.project.timeline = [];
  legacyEmpty.values.set(STORAGE_KEY, JSON.stringify(legacyEmptyBytes));
  assertRecoveryReason(initializePersistence(() => legacyEmpty), 'invalid_shape');
  assert.deepEqual(initializePersistence(() => legacyStorage), {
    kind: 'ready',
    source: 'stored',
  });

  const created = dispatch({
    type: 'project.create',
    payload: {
      title: 'Migrated project',
      description: '',
      requestReview: false,
    },
  });
  assert.equal(created.ok, true);
  assert.deepEqual(legacyStorage.setKeys, [STORAGE_KEY]);
  const persisted = JSON.parse(legacyStorage.values.get(STORAGE_KEY) ?? '');
  assert.equal(persisted.schemaVersion, 8);
  assert.equal(Array.isArray(persisted.projects), true);
  assert.equal(persisted.projects.length, 1);

  assert.deepEqual(initializePersistence(() => legacyStorage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.title, 'Migrated project');
  assert.equal(getSnapshot().projects[0].title, 'Test Flight Plan');

  const invalidInactive = JSON.parse(JSON.stringify(persisted));
  invalidInactive.projects[0].activeReviewRequest = {};
  const invalidInactiveStorage = new ProfileStorage();
  invalidInactiveStorage.values.set(
    STORAGE_KEY,
    JSON.stringify(invalidInactive),
  );
  assertRecoveryReason(
    initializePersistence(() => invalidInactiveStorage),
    'invalid_shape',
  );

  const duplicateProject = JSON.parse(JSON.stringify(persisted));
  duplicateProject.projects[0].id = duplicateProject.project.id;
  const duplicateProjectStorage = new ProfileStorage();
  duplicateProjectStorage.values.set(
    STORAGE_KEY,
    JSON.stringify(duplicateProject),
  );
  assertRecoveryReason(
    initializePersistence(() => duplicateProjectStorage),
    'invalid_shape',
  );
});

test('schemaVersion 4 migration clears legacy requests and adds null Impact', () => {
  const seedStorage = new ProfileStorage();
  assert.equal(initializePersistence(() => seedStorage).kind, 'ready');
  const legacy = JSON.parse(
    JSON.stringify({
      ...getSnapshot(),
      schemaVersion: 4,
    }),
  );
  for (const project of [legacy.project, ...legacy.projects]) {
    for (const item of project.timeline) {
      for (const tag of item.tags) {
        delete tag.impact;
        for (const caseItem of tag.cases) {
          delete caseItem.planBOptions;
          delete caseItem.responseCandidates;
        }
      }
    }
  }
  legacy.project.activeReviewRequest = {
    id: 'legacy-review-request',
    kind: 'timeline_whatifs',
    ownerId: legacy.project.id,
    ownerVersion: legacy.project.version,
    projectVersion: legacy.project.version,
  };
  legacy.project.activeRecheckRequest = null;

  const storage = new ProfileStorage();
  storage.values.set(STORAGE_KEY, JSON.stringify(legacy));
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().schemaVersion, 8);
  assert.equal(getSnapshot().project.activeReviewRequest, null);
  assert.equal(getSnapshot().project.activeRecheckRequest, null);
  assert.equal(
    getSnapshot().project.timeline.every((item) =>
      item.tags.every((tag) => tag.impact === null),
    ),
    true,
  );

  const recheckLegacy = JSON.parse(JSON.stringify(legacy));
  recheckLegacy.project.activeReviewRequest = null;
  const recheckTag = recheckLegacy.project.timeline[0].tags[0];
  recheckTag.needsRecheck = true;
  recheckLegacy.project.activeRecheckRequest = {
    id: 'legacy-recheck-request',
    projectVersion: recheckLegacy.project.version,
    tags: [
      {
        tagId: recheckTag.id,
        tagVersion: recheckTag.version,
        itemId: recheckLegacy.project.timeline[0].id,
        itemVersion: recheckLegacy.project.timeline[0].version,
      },
    ],
  };
  const recheckStorage = new ProfileStorage();
  recheckStorage.values.set(STORAGE_KEY, JSON.stringify(recheckLegacy));
  assert.deepEqual(initializePersistence(() => recheckStorage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().schemaVersion, 8);
  assert.equal(getSnapshot().project.activeReviewRequest, null);
  assert.equal(getSnapshot().project.activeRecheckRequest, null);
  assert.equal(getSnapshot().project.timeline[0].tags[0].impact, null);
});
