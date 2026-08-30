import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatch,
  getSnapshot,
  STORAGE_KEY,
  type StoragePort,
} from './app-state.ts';
import { initializeTestPersistence as initializePersistence } from './test-fixtures.ts';

class MemoryStorage implements StoragePort {
  readonly values = new Map<string, string>();
  setError: Error | null = null;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.setError) throw this.setError;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function makeLeaveHomeStale() {
  const item = getSnapshot().project.timeline.find(
    (entry) => entry.id === 'item-leave-home',
  );
  assert.ok(item);
  const result = dispatch({
    type: 'timeline.update',
    payload: {
      itemId: item.id,
      timeOrCue: '15:15',
      title: item.title,
      body: item.body,
    },
  });
  assert.equal(result.ok, true);
}

function requestRecheck(tagIds: string[]) {
  const result = dispatch({
    type: 'recheck.request',
    payload: { tagIds },
  });
  assert.equal(result.ok, true);
  const snapshot = getSnapshot();
  const request = snapshot.project.activeRecheckRequest;
  assert.ok(request);
  return {
    request,
    projectId: snapshot.project.id,
    projectVersion: snapshot.project.version,
  };
}

test('a saved Plan edit marks only active anchored Tags stale and requires an explicit bounded recheck request', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const before = getSnapshot();
  const trafficBefore = before.project.timeline[0].tags[0];
  const airportBefore = before.project.timeline[1].tags[0];

  makeLeaveHomeStale();
  const changed = getSnapshot();
  const leaveHome = changed.project.timeline[0];
  assert.equal(leaveHome.tags.every((tag) => tag.needsRecheck), true);
  assert.equal(
    leaveHome.tags.every((tag) => tag.lifecycle === 'active'),
    true,
  );
  assert.equal(
    leaveHome.tags[0].basedOnItemVersion,
    trafficBefore.basedOnItemVersion,
  );
  assert.equal(changed.project.timeline[1].tags[0].needsRecheck, false);
  assert.equal(
    changed.project.timeline[1].tags[0].basedOnItemVersion,
    airportBefore.basedOnItemVersion,
  );
  assert.equal(changed.project.activeRecheckRequest, null);

  const beforeInvalid = getSnapshot();
  const invalid = dispatch({
    type: 'recheck.request',
    payload: { tagIds: ['tag-security'] },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), beforeInvalid);

  const requested = requestRecheck(['tag-traffic', 'tag-taxi']);
  assert.deepEqual(
    requested.request.tags.map((tag) => tag.tagId),
    ['tag-traffic', 'tag-taxi'],
  );
  assert.equal(
    requested.request.tags.every(
      (tag) => tag.itemId === 'item-leave-home' && tag.itemVersion === leaveHome.version,
    ),
    true,
  );
  assert.ok(storage.values.get(STORAGE_KEY)?.includes(requested.request.id));
});

test('retain, resolve, and replace recheck outcomes commit atomically while preserving prior human responses', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');

  const responseResult = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-light',
      disposition: 'accept',
      actions: ['Take the usual route and leave as planned.'],
      when: '',
      status: null,
    },
  });
  assert.equal(responseResult.ok, true);
  const manualTag = dispatch({
    type: 'tag.add',
    payload: {
      anchorItemId: 'item-leave-home',
      question: 'What if I forget the travel documents?',
      caseTitle: 'Documents are still at home',
      ownAction: 'Return before leaving the neighborhood.',
      requestReview: false,
    },
  });
  assert.equal(manualTag.ok, true);
  const manualTagId = manualTag.ok
    ? manualTag.affectedIds.find((id) => id.startsWith('tag-'))
    : undefined;
  assert.ok(manualTagId);

  makeLeaveHomeStale();
  const requested = requestRecheck([
    'tag-traffic',
    'tag-taxi',
    manualTagId,
  ]);
  const requestTags = new Map(
    requested.request.tags.map((entry) => [entry.tagId, entry]),
  );
  const result = dispatch({
    type: 'recheck.apply',
    payload: {
      request: requested.request,
      projectId: requested.projectId,
      projectVersion: requested.projectVersion,
      outcomes: [
        {
          tagId: 'tag-traffic',
          tagVersion: requestTags.get('tag-traffic')?.tagVersion ?? 0,
          outcome: 'replace',
          replacement: {
            anchorItemId: 'item-leave-home',
            question: 'What if road traffic threatens the new departure time?',
            rationale: 'The earlier departure still depends on road conditions.',
            summary: 'Choose transport using the live delay.',
            cases: [
              {
                title: 'Delay stays under 15 minutes',
                suggestedActions: ['Leave at the new time and monitor the route.'],
              },
            ],
          },
        },
        {
          tagId: 'tag-taxi',
          tagVersion: requestTags.get('tag-taxi')?.tagVersion ?? 0,
          outcome: 'retain',
        },
        {
          tagId: manualTagId,
          tagVersion: requestTags.get(manualTagId)?.tagVersion ?? 0,
          outcome: 'resolve',
        },
      ],
    },
  });
  assert.equal(result.ok, true);

  const snapshot = getSnapshot();
  assert.equal(snapshot.project.activeRecheckRequest, null);
  const tags = snapshot.project.timeline[0].tags;
  const oldTraffic = tags.find((tag) => tag.id === 'tag-traffic');
  const retainedTaxi = tags.find((tag) => tag.id === 'tag-taxi');
  const resolvedManual = tags.find((tag) => tag.id === manualTagId);
  const replacement = tags.find(
    (tag) => tag.question === 'What if road traffic threatens the new departure time?',
  );
  assert.equal(oldTraffic?.lifecycle, 'resolved');
  assert.deepEqual(oldTraffic?.cases[0].response, {
    disposition: 'accept',
    actions: ['Take the usual route and leave as planned.'],
    when: '',
    status: null,
  });
  assert.equal(retainedTaxi?.lifecycle, 'active');
  assert.equal(retainedTaxi?.needsRecheck, false);
  assert.equal(resolvedManual?.lifecycle, 'resolved');
  assert.equal(resolvedManual?.cases[0].suggestedActionSource, 'human');
  assert.equal(replacement?.source, 'agent');
  assert.equal(replacement?.lifecycle, 'active');
  assert.equal(replacement?.needsRecheck, false);
  assert.equal(
    replacement?.cases.every(
      (entry) => entry.suggestedActionSource === 'agent',
    ),
    true,
  );
  assert.equal(replacement?.cases.every((entry) => entry.response === null), true);
  assert.notEqual(replacement?.id, oldTraffic?.id);
  assert.equal(
    snapshot.project.timeline[1].tags.every((tag) => !tag.needsRecheck),
    true,
  );
});

test('invalid or failed recheck keeps the complete stale state and stored bytes unchanged', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  makeLeaveHomeStale();
  const requested = requestRecheck(['tag-traffic']);
  const requestTag = requested.request.tags[0];
  const before = getSnapshot();
  const bytesBefore = storage.values.get(STORAGE_KEY);

  const invalid = dispatch({
    type: 'recheck.apply',
    payload: {
      request: requested.request,
      projectId: requested.projectId,
      projectVersion: requested.projectVersion,
      outcomes: [
        {
          tagId: 'tag-traffic',
          tagVersion: requestTag.tagVersion,
          outcome: 'replace',
          replacement: {
            anchorItemId: 'item-leave-home',
            question: 'What if one invalid Case breaks the recheck?',
            rationale: 'The whole replacement must remain atomic.',
            summary: 'Reject the whole replacement.',
            cases: Array.from({ length: 7 }, (_, index) => ({
              title: `Case ${index + 1}`,
              suggestedActions: ['Keep the previous stale Tag.'],
            })),
          },
        },
      ],
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'LIMIT_EXCEEDED');
  assert.strictEqual(getSnapshot(), before);
  assert.equal(storage.values.get(STORAGE_KEY), bytesBefore);

  storage.setError = new Error('write failed');
  const saveFailed = dispatch({
    type: 'recheck.apply',
    payload: {
      request: requested.request,
      projectId: requested.projectId,
      projectVersion: requested.projectVersion,
      outcomes: [
        {
          tagId: 'tag-traffic',
          tagVersion: requestTag.tagVersion,
          outcome: 'retain',
        },
      ],
    },
  });
  assert.equal(saveFailed.ok, false);
  assert.equal(saveFailed.code, 'SAVE_FAILED');
  assert.strictEqual(getSnapshot(), before);
  assert.equal(storage.values.get(STORAGE_KEY), bytesBefore);
});
