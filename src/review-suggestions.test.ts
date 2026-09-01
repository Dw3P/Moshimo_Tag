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

function beginReview(
  kind:
    | 'timeline_whatifs'
    | 'item_whatifs'
    | 'tag_cases'
    | 'case_actions'
    | 'timeline_gaps',
  ownerId: string,
) {
  const requested = dispatch({
    type: 'review.request',
    payload: { kind, ownerId },
  });
  assert.equal(requested.ok, true);
  const snapshot = getSnapshot();
  const request = snapshot.project.activeReviewRequest;
  assert.ok(request);
  assert.equal(request.kind, kind);
  return {
    request,
    projectId: snapshot.project.id,
    projectVersion: snapshot.project.version,
  };
}

const weatherTag = {
  anchorItemId: 'item-flight',
  question: 'What if severe weather delays boarding?',
  rationale: 'The final departure time may move after passengers reach the gate.',
  summary: 'Keep the onward plan flexible until boarding is confirmed.',
  cases: [
    {
      title: 'Delay is under one hour',
      suggestedActions: ['Stay near the gate and monitor the confirmed boarding time.'],
    },
    {
      title: 'Delay exceeds one hour',
      suggestedActions: ['Notify the destination contact and reassess onward transport.'],
    },
  ],
};

test('normal review applies scoped Tags, Cases, actions, and Gap proposals without adopting them', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');

  const savedResponse = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-light',
      planBId: null,
      disposition: 'accept',
      actions: ['Take the usual route and leave as planned.'],
      when: '',
      status: null,
    },
  });
  assert.equal(savedResponse.ok, true);
  const responseBeforeReview = getSnapshot().project.timeline[0].tags[0].cases[0].response;

  const timelineReview = beginReview(
    'timeline_whatifs',
    getSnapshot().project.id,
  );
  const itemsBeforeTimelineReview = getSnapshot().project.timeline;
  const appliedTimelineReview = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'timeline_whatifs',
      ...timelineReview,
      tags: [weatherTag],
    },
  });
  assert.equal(appliedTimelineReview.ok, true);
  assert.equal(getSnapshot().project.activeReviewRequest, null);
  assert.equal(getSnapshot().project.timeline[0].version, itemsBeforeTimelineReview[0].version);
  assert.equal(getSnapshot().project.timeline[1].version, itemsBeforeTimelineReview[1].version);
  assert.equal(getSnapshot().project.timeline[2].version, itemsBeforeTimelineReview[2].version + 1);
  const addedWeatherTag = getSnapshot().project.timeline[2].tags.at(-1);
  assert.equal(addedWeatherTag?.question, weatherTag.question);
  assert.equal(addedWeatherTag?.source, 'agent');
  assert.equal(addedWeatherTag?.anchorItemId, 'item-flight');
  assert.equal(addedWeatherTag?.cases.length, 2);
  assert.equal(addedWeatherTag?.cases.every((entry) => entry.response === null), true);
  assert.equal(
    addedWeatherTag?.cases.every(
      (entry) => entry.suggestedActionSource === 'agent',
    ),
    true,
  );
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[0].response,
    responseBeforeReview,
  );

  const itemReview = beginReview('item_whatifs', 'item-airport');
  const beforeWrongAnchor = getSnapshot();
  const wrongAnchor = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'item_whatifs',
      ...itemReview,
      tags: [
        {
          ...weatherTag,
          question: 'What if the flight gate changes?',
        },
      ],
    },
  });
  assert.equal(wrongAnchor.ok, false);
  assert.equal(wrongAnchor.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), beforeWrongAnchor);

  const appliedItemReview = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'item_whatifs',
      ...itemReview,
      tags: [
        {
          ...weatherTag,
          anchorItemId: 'item-airport',
          question: 'What if check-in closes earlier than expected?',
          rationale: 'A schedule change can reduce the available check-in window.',
          summary: 'Confirm the actual deadline before optional airport tasks.',
        },
      ],
    },
  });
  assert.equal(appliedItemReview.ok, true);
  assert.equal(
    getSnapshot().project.timeline[1].tags.at(-1)?.question,
    'What if check-in closes earlier than expected?',
  );

  const tagReview = beginReview('tag_cases', 'tag-traffic');
  const trafficCaseCount = getSnapshot().project.timeline[0].tags[0].cases.length;
  const appliedTagReview = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'tag_cases',
      ...tagReview,
      tagId: 'tag-traffic',
      cases: [
        {
          title: 'Road is closed completely',
          suggestedActions: ['Switch to rail before the taxi enters the closed area.'],
        },
      ],
    },
  });
  assert.equal(appliedTagReview.ok, true);
  assert.equal(
    getSnapshot().project.timeline[0].tags[0].cases.length,
    trafficCaseCount + 1,
  );
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags[0].cases[0].response,
    responseBeforeReview,
  );

  const caseReview = beginReview('case_actions', 'case-traffic-light');
  const appliedCaseReview = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'case_actions',
      ...caseReview,
      caseId: 'case-traffic-light',
      suggestedActions: [
        'Leave as planned.',
        'Message the driver to confirm the current route.',
      ],
    },
  });
  assert.equal(appliedCaseReview.ok, true);
  const updatedCase = getSnapshot().project.timeline[0].tags[0].cases[0];
  assert.deepEqual(updatedCase.suggestedActions, [
    'Leave as planned.',
    'Message the driver to confirm the current route.',
  ]);
  assert.deepEqual(updatedCase.response, responseBeforeReview);

  const gapReview = beginReview('timeline_gaps', getSnapshot().project.id);
  const timelineBeforeGap = getSnapshot().project.timeline;
  const appliedGapReview = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'timeline_gaps',
      ...gapReview,
      gaps: [
        {
          insertAfterItemId: 'item-airport',
          timeOrCue: '18:00',
          title: 'Confirm the boarding gate',
          body: 'Check the live gate assignment before walking away from the concourse.',
        },
      ],
    },
  });
  assert.equal(appliedGapReview.ok, true);
  assert.strictEqual(getSnapshot().project.timeline, timelineBeforeGap);
  const addedGap = getSnapshot().project.gapSuggestions.at(-1);
  assert.equal(addedGap?.title, 'Confirm the boarding gate');
  assert.equal(addedGap?.status, 'proposed');
  assert.equal(getSnapshot().project.activeReviewRequest, null);
  assert.ok(storage.values.get(STORAGE_KEY)?.includes('Confirm the boarding gate'));
});

test('case_actions preserves Case ownership while recording agent action provenance', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');

  const added = dispatch({
    type: 'tag.add',
    payload: {
      anchorItemId: 'item-flight',
      question: 'What if the destination changes at the last minute?',
      caseTitle: 'A new destination is confirmed',
      ownAction: '',
      requestReview: false,
    },
  });
  assert.equal(added.ok, true);
  const tagId = added.ok ? added.affectedIds[0] : '';
  const caseId = added.ok ? added.affectedIds[1] : '';
  const createdCase = getSnapshot().project.timeline[2].tags.find(
    (tag) => tag.id === tagId,
  )?.cases[0];
  assert.equal(createdCase?.source, 'human');
  assert.equal(createdCase?.suggestedActionSource, null);
  assert.deepEqual(createdCase?.suggestedActions, []);

  const requestResult = dispatch({
    type: 'review.request',
    payload: { kind: 'case_actions', ownerId: caseId },
  });
  assert.equal(requestResult.ok, true);
  const request = getSnapshot().project.activeReviewRequest;
  assert.ok(request);

  const applied = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'case_actions',
      request: request!,
      projectId: getSnapshot().project.id,
      projectVersion: getSnapshot().project.version,
      caseId,
      suggestedActions: ['Confirm the new destination before changing transport.'],
    },
  });
  assert.equal(applied.ok, true);
  const updatedCase = getSnapshot().project.timeline[2].tags.find(
    (tag) => tag.id === tagId,
  )?.cases[0];
  assert.equal(updatedCase?.source, 'human');
  assert.equal(updatedCase?.suggestedActionSource, 'agent');
  assert.deepEqual(updatedCase?.suggestedActions, [
    'Confirm the new destination before changing transport.',
  ]);

  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  const reloadedCase = getSnapshot().project.timeline[2].tags.find(
    (tag) => tag.id === tagId,
  )?.cases[0];
  assert.equal(reloadedCase?.source, 'human');
  assert.equal(reloadedCase?.suggestedActionSource, 'agent');
});

test('normal review rejects an invalid or duplicate batch atomically and preserves the request on save failure', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');

  const review = beginReview('timeline_whatifs', getSnapshot().project.id);
  const beforeInvalid = getSnapshot();
  const bytesBeforeInvalid = storage.values.get(STORAGE_KEY);
  const invalid = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'timeline_whatifs',
      ...review,
      tags: [
        weatherTag,
        {
          ...weatherTag,
          anchorItemId: 'item-airport',
          question: 'What if one invalid Tag breaks the batch?',
          cases: Array.from({ length: 7 }, (_, index) => ({
            title: `Case ${index + 1}`,
            suggestedActions: ['Keep the entire batch atomic.'],
          })),
        },
      ],
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'LIMIT_EXCEEDED');
  assert.strictEqual(getSnapshot(), beforeInvalid);
  assert.equal(storage.values.get(STORAGE_KEY), bytesBeforeInvalid);

  const duplicate = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'timeline_whatifs',
      ...review,
      tags: [
        {
          ...weatherTag,
          anchorItemId: 'item-leave-home',
          question: 'What if traffic is much worse than expected?',
        },
      ],
    },
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'DUPLICATE');
  assert.strictEqual(getSnapshot(), beforeInvalid);

  storage.setError = new Error('write failed');
  const saveFailed = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'timeline_whatifs',
      ...review,
      tags: [weatherTag],
    },
  });
  assert.equal(saveFailed.ok, false);
  assert.equal(saveFailed.code, 'SAVE_FAILED');
  assert.strictEqual(getSnapshot(), beforeInvalid);
  assert.equal(storage.values.get(STORAGE_KEY), bytesBeforeInvalid);
});

test('a zero-gap review completes without creating a Timeline item or suggestion', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const review = beginReview('timeline_gaps', getSnapshot().project.id);
  const before = getSnapshot();
  const result = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'timeline_gaps',
      ...review,
      gaps: [],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(getSnapshot().project.timeline.length, before.project.timeline.length);
  assert.equal(
    getSnapshot().project.gapSuggestions.length,
    before.project.gapSuggestions.length,
  );
  assert.equal(getSnapshot().project.activeReviewRequest, null);
});
