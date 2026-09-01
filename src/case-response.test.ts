import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatch,
  getSnapshot,
  type StoragePort,
} from './app-state.ts';
import { initializeTestPersistence as initializePersistence } from './test-fixtures.ts';

class ResponseStorage implements StoragePort {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('write failed');
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('Case responses are human-owned, bounded, isolated, and durable', () => {
  const storage = new ResponseStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');

  const trafficItemBefore = getSnapshot().project.timeline[0];
  const trafficTagBefore = trafficItemBefore.tags[0];
  const mediumBefore = trafficTagBefore.cases[1];
  const originalSuggestions = [...trafficTagBefore.cases[0].suggestedActions];

  assert.equal(
    dispatch({
      type: 'case.response.save',
      payload: {
        caseId: 'case-traffic-light',
      planBId: null,
        disposition: 'covered',
        actions: [],
        when: '',
        status: null,
      },
    }).ok,
    true,
  );
  const coveredState = getSnapshot();
  const coveredItem = coveredState.project.timeline[0];
  const coveredTag = coveredItem.tags[0];
  assert.equal(coveredItem.version, trafficItemBefore.version);
  assert.equal(coveredTag.version, trafficTagBefore.version);
  assert.strictEqual(coveredTag.cases[1], mediumBefore);
  assert.equal(coveredTag.cases[0].version, 2);
  assert.deepEqual(coveredTag.cases[0].response, {
    disposition: 'covered',
    actions: [],
    when: '',
    status: null,
  });

  assert.equal(
    dispatch({
      type: 'case.response.save',
      payload: {
        caseId: 'case-traffic-light',
      planBId: null,
        disposition: 'accept',
        actions: [],
        when: '',
        status: null,
      },
    }).ok,
    true,
  );
  const acceptedCase = getSnapshot().project.timeline[0].tags[0].cases[0];
  assert.equal(acceptedCase.response?.disposition, 'accept');
  assert.deepEqual(acceptedCase.suggestedActions, originalSuggestions);
  assert.deepEqual(acceptedCase.response?.actions, []);

  assert.equal(
    dispatch({
      type: 'case.response.save',
      payload: {
        caseId: 'case-traffic-light',
      planBId: null,
        disposition: 'accept',
        actions: ['Continue as an experiment and accept the result.'],
        when: '',
        status: null,
      },
    }).ok,
    true,
  );
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[0].response?.actions,
    ['Continue as an experiment and accept the result.'],
  );

  assert.equal(
    dispatch({
      type: 'case.response.save',
      payload: {
        caseId: 'case-traffic-light',
      planBId: null,
        disposition: 'covered',
        actions: ['The main Plan already includes a backup route.'],
        when: '',
        status: null,
      },
    }).ok,
    true,
  );
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[0].response?.actions,
    ['The main Plan already includes a backup route.'],
  );

  assert.equal(
    dispatch({
      type: 'case.response.save',
      payload: {
        caseId: 'case-traffic-medium',
      planBId: null,
        disposition: 'prepare',
        actions: ['Check the airport rail route before leaving.'],
        when: 'Before leaving',
        status: 'pending',
      },
    }).ok,
    true,
  );
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[1].response,
    {
      disposition: 'prepare',
      actions: ['Check the airport rail route before leaving.'],
      when: 'Before leaving',
      status: 'pending',
    },
  );

  const addedPlanB = dispatch({
    type: 'case.planB.add',
    payload: {
      caseId: 'case-traffic-heavy',
      action: 'Switch to a later flight if the rail route is unavailable.',
    },
  });
  assert.equal(addedPlanB.ok, true);
  const planBId =
    getSnapshot().project.timeline[0].tags[0].cases[2].planBOptions[0].id;
  const planBResponse = {
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-heavy',
      planBId,
      disposition: 'prepare',
      actions: ['Check the later-flight inventory before leaving home.'],
      when: '',
      status: 'pending',
    },
  } as const;
  assert.equal(dispatch(planBResponse).ok, true);
  const planBState = getSnapshot();
  assert.deepEqual(
    planBState.project.timeline[0].tags[0].cases[2].planBOptions[0].response
      ?.actions,
    planBResponse.payload.actions,
  );
  assert.equal(planBState.project.timeline[0].tags[0].cases[2].response, null);
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[2].planBOptions[0].response
      ?.actions,
    planBResponse.payload.actions,
  );

  const unchanged = getSnapshot();
  const unchangedResult = dispatch(planBResponse);
  assert.equal(unchangedResult.ok, true);
  assert.equal(unchangedResult.code, 'NO_CHANGES');
  assert.strictEqual(getSnapshot(), unchanged);

  const invalidPayloads = [
    { disposition: 'prepare', actions: [] },
    { disposition: 'prepare', actions: ['1', '2'] },
    { disposition: 'accept', actions: ['1', '2'] },
    { disposition: 'covered', actions: ['one memo', 'a second memo'] },
  ] as const;
  for (const invalid of invalidPayloads) {
    const beforeInvalid = getSnapshot();
    const result = dispatch({
      type: 'case.response.save',
      payload: {
        caseId: 'case-traffic-heavy',
      planBId: null,
        disposition: invalid.disposition,
        actions: [...invalid.actions],
        when: '',
        status: null,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_INPUT');
    assert.strictEqual(getSnapshot(), beforeInvalid);
  }

  const beforeWrongFields = getSnapshot();
  const wrongFields = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-heavy',
      planBId: null,
      disposition: 'accept',
      actions: ['Use the rail route.'],
      when: 'Only prepare may use this',
      status: null,
    },
  });
  assert.equal(wrongFields.ok, false);
  assert.strictEqual(getSnapshot(), beforeWrongFields);

  const review = dispatch({
    type: 'review.request',
    payload: { kind: 'case_actions', ownerId: 'case-taxi-late' },
  });
  assert.equal(review.ok, true);
  assert.ok(getSnapshot().project.activeReviewRequest);
  assert.equal(
    dispatch({
      type: 'case.response.save',
      payload: {
        caseId: 'case-taxi-late',
      planBId: null,
        disposition: 'dismiss',
        actions: [],
        when: '',
        status: null,
      },
    }).ok,
    true,
  );
  assert.equal(getSnapshot().project.activeReviewRequest, null);

  assert.equal(getSnapshot().project.viewMode, 'editing');
  assert.equal(
    dispatch({
      type: 'project.view.set',
      payload: { viewMode: 'final' },
    }).ok,
    true,
  );
  assert.equal(getSnapshot().project.viewMode, 'final');
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.viewMode, 'final');
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[2].planBOptions[0].response
      ?.actions,
    planBResponse.payload.actions,
  );
  assert.equal(
    dispatch({
      type: 'project.view.set',
      payload: { viewMode: 'editing' },
    }).ok,
    true,
  );
  const beforeNoChange = getSnapshot();
  const noViewChange = dispatch({
    type: 'project.view.set',
    payload: { viewMode: 'editing' },
  });
  assert.equal(noViewChange.ok, true);
  assert.equal(noViewChange.code, 'NO_CHANGES');
  assert.strictEqual(getSnapshot(), beforeNoChange);

  storage.failWrites = true;
  const beforeFailedSave = getSnapshot();
  const failedSave = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-taxi-missing',
      planBId: null,
      disposition: 'accept',
      actions: ['Request another car.'],
      when: '',
      status: null,
    },
  });
  assert.equal(failedSave.ok, false);
  assert.equal(failedSave.code, 'SAVE_FAILED');
  assert.strictEqual(getSnapshot(), beforeFailedSave);

  const failedFinish = dispatch({
    type: 'project.view.set',
    payload: { viewMode: 'final' },
  });
  assert.equal(failedFinish.ok, false);
  assert.equal(failedFinish.code, 'SAVE_FAILED');
  assert.strictEqual(getSnapshot(), beforeFailedSave);
});

test('Main and Plan B countermeasures are independently editable, decidable, and deletable', () => {
  const storage = new ResponseStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');

  assert.equal(
    dispatch({
      type: 'case.planB.add',
      payload: {
        caseId: 'case-traffic-light',
        action: 'Take the train if the road route stops moving.',
      },
    }).ok,
    true,
  );
  const currentCase = () =>
    getSnapshot().project.timeline[0].tags[0].cases[0];
  const planBId = currentCase().planBOptions[0].id;

  assert.equal(
    dispatch({
      type: 'case.response.save',
      payload: {
        caseId: currentCase().id,
        planBId: null,
        disposition: 'covered',
        actions: [],
        when: '',
        status: null,
      },
    }).ok,
    true,
  );
  assert.equal(
    dispatch({
      type: 'case.response.save',
      payload: {
        caseId: currentCase().id,
        planBId,
        disposition: 'accept',
        actions: ['Use only if the delay becomes severe.'],
        when: '',
        status: null,
      },
    }).ok,
    true,
  );
  assert.equal(currentCase().response?.disposition, 'covered');
  assert.equal(currentCase().planBOptions[0].response?.disposition, 'accept');

  assert.equal(
    dispatch({
      type: 'case.action.update',
      payload: {
        caseId: currentCase().id,
        suggestedActions: ['Leave ten minutes earlier on the usual route.'],
      },
    }).ok,
    true,
  );
  assert.equal(currentCase().response, null);
  assert.equal(currentCase().planBOptions[0].response?.disposition, 'accept');

  assert.equal(
    dispatch({
      type: 'case.planB.update',
      payload: {
        caseId: currentCase().id,
        planBId,
        action: 'Take the nearest rail route if traffic stops moving.',
      },
    }).ok,
    true,
  );
  assert.equal(currentCase().planBOptions[0].response, null);
  assert.equal(
    currentCase().planBOptions[0].action,
    'Take the nearest rail route if traffic stops moving.',
  );

  assert.equal(
    dispatch({
      type: 'case.planB.delete',
      payload: { caseId: currentCase().id, planBId },
    }).ok,
    true,
  );
  assert.deepEqual(currentCase().planBOptions, []);
});
