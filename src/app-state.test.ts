import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatch,
  getHistoryAvailability,
  getSnapshot,
  type StoragePort,
} from './app-state.ts';
import { initializeTestPersistence as initializePersistence } from './test-fixtures.ts';

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

test('shared command path validates and applies Timeline mutations atomically', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'seed',
  });
  const initial = getSnapshot();
  const malformed = dispatch({
    type: 'timeline.add',
    payload: {
      timeOrCue: '',
      title: 'Unexpected',
      body: '',
      requestReview: false,
      extra: true,
    },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'INVALID_INPUT');
  assert.strictEqual(getSnapshot(), initial);

  const projectUpdate = dispatch({
    type: 'project.update',
    payload: {
      title: 'Tokyo Flight Plan',
      description: 'A human-owned route to the airport.',
    },
  });
  assert.equal(projectUpdate.ok, true);
  assert.equal(getSnapshot().project.version, initial.project.version + 1);

  const beforeAdd = getSnapshot();
  const added = dispatch({
    type: 'timeline.add',
    payload: {
      timeOrCue: '18:00',
      title: '<script>Check baggage</script>',
      body: '<img src=x onerror=alert(1)> remains plain text',
      requestReview: false,
    },
  });
  assert.equal(added.ok, true);
  const addedId = added.ok ? added.affectedIds[0] : '';
  const afterAdd = getSnapshot();
  assert.equal(afterAdd.project.version, beforeAdd.project.version + 1);
  assert.equal(afterAdd.project.timeline.at(-1)?.id, addedId);
  assert.equal(afterAdd.project.timeline.at(-1)?.status, 'draft');
  assert.deepEqual(afterAdd.project.timeline.at(-1)?.tags, []);
  assert.equal(
    afterAdd.project.timeline.at(-1)?.title,
    '<script>Check baggage</script>',
  );

  const beforeEdit = getSnapshot();
  const edited = dispatch({
    type: 'timeline.update',
    payload: {
      itemId: 'item-leave-home',
      timeOrCue: '15:15',
      title: 'Leave home earlier',
      body: 'Taxi pickup moves fifteen minutes earlier.',
    },
  });
  assert.equal(edited.ok, true);
  const afterEdit = getSnapshot();
  const editedItem = afterEdit.project.timeline.find(
    (item) => item.id === 'item-leave-home',
  );
  const unrelatedItem = afterEdit.project.timeline.find(
    (item) => item.id === 'item-airport',
  );
  assert.equal(afterEdit.project.version, beforeEdit.project.version + 1);
  assert.equal(editedItem?.version, 2);
  assert.equal(editedItem?.tags.every((tag) => tag.needsRecheck), true);
  assert.equal(unrelatedItem?.tags.some((tag) => tag.needsRecheck), false);

  const beforeMove = getSnapshot();
  const moved = dispatch({
    type: 'timeline.move',
    payload: { itemId: addedId, direction: 'up' },
  });
  assert.equal(moved.ok, true);
  const movedIndex = getSnapshot().project.timeline.findIndex(
    (item) => item.id === addedId,
  );
  assert.equal(movedIndex, beforeMove.project.timeline.length - 2);

  const beforeDelete = getSnapshot();
  const deleted = dispatch({
    type: 'timeline.delete',
    payload: { itemId: addedId },
  });
  assert.equal(deleted.ok, true);
  assert.equal(
    getSnapshot().project.timeline.some((item) => item.id === addedId),
    false,
  );
  assert.equal(getSnapshot().undoDelete?.item.id, addedId);
  assert.equal(getSnapshot().project.version, beforeDelete.project.version + 1);

  const undone = dispatch({ type: 'timeline.undoDelete' });
  assert.equal(undone.ok, true);
  assert.equal(getSnapshot().project.timeline[movedIndex]?.id, addedId);
  assert.equal(getSnapshot().undoDelete, null);

  const beforeInvalidMove = getSnapshot();
  const invalidMove = dispatch({
    type: 'timeline.move',
    payload: { itemId: beforeInvalidMove.project.timeline[0].id, direction: 'up' },
  });
  assert.equal(invalidMove.ok, false);
  assert.equal(invalidMove.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), beforeInvalidMove);

  const manualTag = dispatch({
    type: 'tag.add',
    payload: {
      anchorItemId: 'item-airport',
      question: 'What if the bag is overweight?',
      caseTitle: 'A small excess fee applies',
      ownAction: 'Pay the fee and continue to security.',
      requestReview: false,
    },
  });
  assert.equal(manualTag.ok, true);
  const manualTagId = manualTag.ok ? manualTag.affectedIds[0] : '';
  const addedTag = getSnapshot()
    .project.timeline.find((item) => item.id === 'item-airport')
    ?.tags.find((tag) => tag.id === manualTagId);
  assert.equal(addedTag?.source, 'human');
  assert.equal(addedTag?.version, 1);
  assert.equal(addedTag?.cases[0].source, 'human');
  assert.equal(addedTag?.cases[0].suggestedActionSource, 'human');

  const manualCase = dispatch({
    type: 'case.add',
    payload: {
      tagId: manualTagId,
      title: 'The bag must be repacked',
      ownAction: '',
      requestReview: false,
    },
  });
  assert.equal(manualCase.ok, true);
  const updatedTag = getSnapshot()
    .project.timeline.find((item) => item.id === 'item-airport')
    ?.tags.find((tag) => tag.id === manualTagId);
  assert.equal(updatedTag?.version, 2);
  assert.equal(updatedTag?.cases.length, 2);
  assert.deepEqual(updatedTag?.cases[1].suggestedActions, []);
  assert.equal(updatedTag?.cases[1].suggestedActionSource, null);

  const review = dispatch({
    type: 'review.request',
    payload: { kind: 'tag_cases', ownerId: manualTagId },
  });
  assert.equal(review.ok, true);
  const request = getSnapshot().project.activeReviewRequest;
  assert.equal(request?.kind, 'tag_cases');
  const waitingState = getSnapshot();
  const blockedSecondRequest = dispatch({
    type: 'review.request',
    payload: { kind: 'timeline_whatifs', ownerId: waitingState.project.id },
  });
  assert.equal(blockedSecondRequest.ok, false);
  assert.equal(blockedSecondRequest.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), waitingState);

  const beforeManualMutation = getSnapshot();
  const timelineBeforeCrossingGap = beforeManualMutation.project.timeline.map(
    (item) => item.id,
  );
  const manualMutation = dispatch({
    type: 'timeline.move',
    payload: { itemId: 'item-airport', direction: 'down' },
  });
  assert.equal(manualMutation.ok, true);
  assert.equal(getSnapshot().project.activeReviewRequest, null);
  assert.deepEqual(
    getSnapshot().project.timeline.map((item) => item.id),
    timelineBeforeCrossingGap,
    'moving a Plan item crosses the adjacent proposed step before another Plan item',
  );
  assert.equal(
    getSnapshot().project.gapSuggestions.find(
      (gap) => gap.id === 'gap-confirm-arrival',
    )?.insertAfterItemId,
    'item-leave-home',
    'the proposed step moves one visual slot before the Plan item',
  );

  const movedGap = dispatch({
    type: 'gap.move',
    payload: { suggestionId: 'gap-confirm-arrival', direction: 'down' },
  });
  assert.equal(movedGap.ok, true);
  assert.equal(
    getSnapshot().project.gapSuggestions.find(
      (gap) => gap.id === 'gap-confirm-arrival',
    )?.insertAfterItemId,
    'item-airport',
    'a proposed step can move through the same combined order as Plan items',
  );

  const reviewToClear = dispatch({
    type: 'review.request',
    payload: { kind: 'tag_cases', ownerId: manualTagId },
  });
  assert.equal(reviewToClear.ok, true);
  const requestToClear = getSnapshot().project.activeReviewRequest;
  const cleared = dispatch({
    type: 'review.clear',
    payload: { requestId: requestToClear?.id ?? '' },
  });
  assert.equal(cleared.ok, true);
  assert.equal(getSnapshot().project.activeReviewRequest, null);

  const gapAdded = dispatch({
    type: 'gap.add',
    payload: { suggestionId: 'gap-check-documents' },
  });
  assert.equal(gapAdded.ok, true);
  const gapItemId = gapAdded.ok ? gapAdded.affectedIds[1] : '';
  const gapItemIndex = getSnapshot().project.timeline.findIndex(
    (item) => item.id === gapItemId,
  );
  const gapAnchorIndex = getSnapshot().project.timeline.findIndex(
    (item) => item.id === 'item-leave-home',
  );
  assert.equal(gapItemIndex, gapAnchorIndex + 1);
  assert.equal(
    getSnapshot().project.gapSuggestions.find(
      (gap) => gap.id === 'gap-check-documents',
    )?.status,
    'accepted',
  );

  const gapIgnored = dispatch({
    type: 'gap.ignore',
    payload: { suggestionId: 'gap-confirm-arrival' },
  });
  assert.equal(gapIgnored.ok, true);
  assert.equal(
    getSnapshot().project.gapSuggestions.find(
      (gap) => gap.id === 'gap-confirm-arrival',
    )?.status,
    'ignored',
  );

  const deleteGapAnchor = dispatch({
    type: 'timeline.delete',
    payload: { itemId: 'item-leave-home' },
  });
  assert.equal(deleteGapAnchor.ok, true);
  assert.equal(
    getSnapshot().project.gapSuggestions.some(
      (gap) => gap.insertAfterItemId === 'item-leave-home',
    ),
    false,
  );
  assert.equal(
    getSnapshot().undoDelete?.gapSuggestions.some(
      (gap) => gap.id === 'gap-check-documents' && gap.status === 'accepted',
    ),
    true,
  );
  const undoGapAnchor = dispatch({ type: 'timeline.undoDelete' });
  assert.equal(undoGapAnchor.ok, true);
  assert.equal(
    getSnapshot().project.gapSuggestions.find(
      (gap) => gap.id === 'gap-check-documents',
    )?.status,
    'accepted',
  );

  const addAndAsk = dispatch({
    type: 'timeline.add',
    payload: {
      timeOrCue: '18:30',
      title: 'Walk to the gate',
      body: 'Follow the latest gate information.',
      requestReview: true,
    },
  });
  assert.equal(addAndAsk.ok, true);
  const requestedItemId = addAndAsk.ok ? addAndAsk.affectedIds[0] : '';
  const itemRequest = getSnapshot().project.activeReviewRequest;
  assert.equal(itemRequest?.kind, 'item_whatifs');
  assert.equal(itemRequest?.ownerId, requestedItemId);
  assert.equal(itemRequest?.projectVersion, getSnapshot().project.version);
});

test('AI Project Plan applies Draft Timeline items and anchored What ifs atomically', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');

  const created = dispatch({
    type: 'project.create',
    payload: {
      title: 'Launch talk',
      description: 'Prepare a five-minute product launch talk for customers.',
      requestReview: true,
    },
  });
  assert.equal(created.ok, true);
  const request = getSnapshot().project.activeReviewRequest;
  assert.equal(request?.kind, 'project_plan');
  assert.equal(getSnapshot().project.timeline.length, 0);

  const beforeInvalid = getSnapshot();
  const invalid = dispatch({
    type: 'review.project_plan.apply',
    payload: {
      requestId: request?.id ?? '',
      projectId: beforeInvalid.project.id,
      projectVersion: beforeInvalid.project.version,
      items: [
        {
          timeOrCue: '00:00',
          title: 'Opening',
          body: 'Welcome the audience.',
          tags: [],
        },
      ],
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_INPUT');
  assert.strictEqual(getSnapshot(), beforeInvalid);

  const applied = dispatch({
    type: 'review.project_plan.apply',
    payload: {
      requestId: request?.id ?? '',
      projectId: beforeInvalid.project.id,
      projectVersion: beforeInvalid.project.version,
      items: [
        {
          timeOrCue: '00:00',
          title: 'Opening',
          body: 'Welcome the audience and state the purpose.',
          tags: [
            {
              question: 'What if the room has not settled yet?',
              rationale: 'The opening may be lost while people are talking.',
              summary: 'Choose how to get attention before starting.',
              cases: [
                {
                  title: 'Noise continues',
                  suggestedActions: [
                    'Ask the host for a brief introduction, then begin.',
                  ],
                },
              ],
            },
          ],
        },
        {
          timeOrCue: '03:30',
          title: 'Product reveal',
          body: 'Show the product and explain the main benefit.',
          tags: [
            {
              question: 'What if the demo screen is unavailable?',
              rationale: 'The audience still needs a concrete explanation.',
              summary: 'Keep a screen-free explanation ready.',
              cases: [
                {
                  title: 'Display cannot be restored',
                  suggestedActions: [
                    'Use the prepared verbal walkthrough and continue.',
                    'Show the printed product image if it is available.',
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  assert.equal(applied.ok, true);

  const seeded = getSnapshot();
  assert.equal(seeded.project.version, beforeInvalid.project.version + 1);
  assert.equal(seeded.project.activeReviewRequest, null);
  assert.equal(seeded.project.timeline.length, 2);
  assert.deepEqual(
    seeded.project.timeline.map((item) => item.title),
    ['Opening', 'Product reveal'],
  );
  assert.equal(
    seeded.project.timeline.every((item) => item.status === 'draft'),
    true,
  );
  for (const item of seeded.project.timeline) {
    assert.equal(item.tags.length, 1);
    assert.equal(item.tags[0].anchorItemId, item.id);
    assert.equal(item.tags[0].source, 'agent');
    assert.equal(item.tags[0].needsRecheck, false);
    assert.equal(item.tags[0].cases[0].source, 'agent');
    assert.equal(item.tags[0].cases[0].suggestedActionSource, 'agent');
    assert.equal(item.tags[0].cases[0].response, null);
  }
});

test('project_plan review is created only by With AI project creation', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');

  const before = getSnapshot();
  const directRequest = dispatch({
    type: 'review.request',
    payload: { kind: 'project_plan', ownerId: before.project.id },
  });
  assert.equal(directRequest.ok, false);
  assert.equal(directRequest.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), before);

  const created = dispatch({
    type: 'project.create',
    payload: {
      title: 'With AI project',
      description: 'Prepare the launch sequence.',
      requestReview: true,
    },
  });
  assert.equal(created.ok, true);
  assert.equal(getSnapshot().project.activeReviewRequest?.kind, 'project_plan');
});

test('resolved Tag history is read-only and does not block an active duplicate question', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');

  const edit = dispatch({
    type: 'timeline.update',
    payload: {
      itemId: 'item-leave-home',
      timeOrCue: '15:15',
      title: 'Leave home',
      body: 'Taxi pickup is planned outside the apartment.',
    },
  });
  assert.equal(edit.ok, true);
  const requested = dispatch({
    type: 'recheck.request',
    payload: { tagIds: ['tag-traffic'] },
  });
  assert.equal(requested.ok, true);
  const recheckRequest = getSnapshot().project.activeRecheckRequest;
  assert.ok(recheckRequest);
  const applied = dispatch({
    type: 'recheck.apply',
    payload: {
      request: recheckRequest,
      projectId: getSnapshot().project.id,
      projectVersion: getSnapshot().project.version,
      outcomes: [
        {
          tagId: 'tag-traffic',
          tagVersion: recheckRequest.tags[0].tagVersion,
          outcome: 'resolve',
        },
      ],
    },
  });
  assert.equal(applied.ok, true);
  assert.equal(
    getSnapshot().project.timeline[0].tags.find((tag) => tag.id === 'tag-traffic')
      ?.lifecycle,
    'resolved',
  );

  const beforeCaseAdd = getSnapshot();
  const caseAdd = dispatch({
    type: 'case.add',
    payload: {
      tagId: 'tag-traffic',
      title: 'History cannot change',
      ownAction: '',
      requestReview: false,
    },
  });
  assert.equal(caseAdd.ok, false);
  assert.equal(caseAdd.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), beforeCaseAdd);

  const responseSave = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: 'case-traffic-light',
      disposition: 'covered',
      actions: [],
      when: '',
      status: null,
    },
  });
  assert.equal(responseSave.ok, false);
  assert.equal(responseSave.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), beforeCaseAdd);

  const tagReview = dispatch({
    type: 'review.request',
    payload: { kind: 'tag_cases', ownerId: 'tag-traffic' },
  });
  assert.equal(tagReview.ok, false);
  assert.equal(tagReview.code, 'INVALID_STATE');
  const caseReview = dispatch({
    type: 'review.request',
    payload: { kind: 'case_actions', ownerId: 'case-traffic-light' },
  });
  assert.equal(caseReview.ok, false);
  assert.equal(caseReview.code, 'INVALID_STATE');

  const normalReview = dispatch({
    type: 'review.request',
    payload: {
      kind: 'timeline_whatifs',
      ownerId: getSnapshot().project.id,
    },
  });
  assert.equal(normalReview.ok, true);
  const reviewRequest = getSnapshot().project.activeReviewRequest;
  assert.ok(reviewRequest);
  const duplicateQuestion = dispatch({
    type: 'review.suggestions.apply',
    payload: {
      kind: 'timeline_whatifs',
      request: reviewRequest,
      projectId: getSnapshot().project.id,
      projectVersion: getSnapshot().project.version,
      tags: [
        {
          anchorItemId: 'item-leave-home',
          question: 'What if traffic is much worse than expected?',
          rationale: 'The resolved question is historical and can be reconsidered.',
          summary: 'Create a current suggestion with the same question.',
          cases: [
            {
              title: 'Current traffic review',
              suggestedActions: ['Check the current route before leaving.'],
            },
          ],
        },
      ],
    },
  });
  assert.equal(duplicateQuestion.ok, true);
  assert.equal(
    getSnapshot().project.timeline[0].tags.at(-1)?.question,
    'What if traffic is much worse than expected?',
  );
});

test('direct agent commands create, edit, sort, and delete bounded What-if data', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const beforeInvalid = getSnapshot();
  const invalidCreate = dispatch({
    type: 'project.createWithPlan',
    payload: {
      title: 'Broken plan',
      description: 'This should not partially create.',
      items: [
        {
          timeOrCue: '09:00',
          title: 'Step',
          body: '',
          tags: [
            {
              question: 'What if?',
              rationale: 'Prepare a fallback.',
              summary: 'Choose one.',
              impact: {
                rank: 6,
                expectedLossAmount: null,
                currency: null,
                penalty: '',
              },
              cases: [{ title: 'Fallback', suggestedActions: ['Continue.'] }],
            },
          ],
        },
      ],
    },
  });
  assert.equal(invalidCreate.ok, false);
  assert.equal(invalidCreate.code, 'INVALID_INPUT');
  assert.strictEqual(getSnapshot(), beforeInvalid);

  const created = dispatch({
    type: 'project.createWithPlan',
    payload: {
      title: 'Agent plan',
      description: 'A bounded plan with impact metadata.',
      items: [
        {
          timeOrCue: '09:00',
          title: 'Prepare',
          body: 'Gather the inputs.',
          tags: [
            {
              question: 'What if an input is missing?',
              rationale: 'The first step depends on complete inputs.',
              summary: 'Pick a recovery path.',
              impact: {
                rank: 3,
                expectedLossAmount: 12.5,
                currency: 'USD',
                penalty: 'Small delay.',
              },
              cases: [{ title: 'One missing', suggestedActions: ['Find a substitute.'] }],
            },
          ],
        },
      ],
    },
  });
  assert.equal(created.ok, true);
  const createdItem = getSnapshot().project.timeline[0];
  const createdTag = createdItem.tags[0];
  assert.equal(createdTag.source, 'agent');
  assert.deepEqual(createdTag.impact, {
    rank: 3,
    expectedLossAmount: 12.5,
    currency: 'USD',
    penalty: 'Small delay.',
  });
  assert.equal(createdTag.cases[0].source, 'agent');

  const invalidImpactBefore = getSnapshot();
  const invalidImpact = dispatch({
    type: 'tag.impact.set',
    payload: {
      tagId: createdTag.id,
      impact: {
        rank: 4,
        expectedLossAmount: 1,
        currency: null,
        penalty: '',
      },
    },
  });
  assert.equal(invalidImpact.ok, false);
  assert.equal(invalidImpact.code, 'INVALID_INPUT');
  assert.strictEqual(getSnapshot(), invalidImpactBefore);

  const addedTag = dispatch({
    type: 'tag.create',
    payload: {
      anchorItemId: createdItem.id,
      question: 'What if the substitute also fails?',
      rationale: 'A second fallback may be needed.',
      summary: 'Keep one confirmed backup.',
      impact: {
        rank: 5,
        expectedLossAmount: null,
        currency: null,
        penalty: 'Major delay.',
      },
      cases: [{ title: 'Backup fails', suggestedActions: ['Pause and reassess.'] }],
    },
  });
  assert.equal(addedTag.ok, true);
  const addedTagId = addedTag.ok ? addedTag.affectedIds[0] : '';
  const secondTag = getSnapshot().project.timeline[0].tags.find(
    (tag) => tag.id === addedTagId,
  );
  assert.equal(secondTag?.source, 'agent');
  assert.equal(secondTag?.impact?.rank, 5);

  const sorted = dispatch({
    type: 'tags.sortByImpact',
    payload: { itemId: createdItem.id },
  });
  assert.equal(sorted.ok, true);
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags.map((tag) => tag.id),
    [addedTagId, createdTag.id],
  );

  const manuallyMoved = dispatch({
    type: 'tag.move',
    payload: { tagId: createdTag.id, direction: 'up' },
  });
  assert.equal(manuallyMoved.ok, true);
  assert.deepEqual(
    getSnapshot().project.timeline[0].tags.map((tag) => tag.id),
    [createdTag.id, addedTagId],
  );
  const beforeMoveBoundary = getSnapshot();
  const movePastStart = dispatch({
    type: 'tag.move',
    payload: { tagId: createdTag.id, direction: 'up' },
  });
  assert.equal(movePastStart.ok, false);
  assert.equal(movePastStart.code, 'INVALID_STATE');
  assert.strictEqual(getSnapshot(), beforeMoveBoundary);

  const resorted = dispatch({
    type: 'tags.sortByImpact',
    payload: { itemId: createdItem.id },
  });
  assert.equal(resorted.ok, true);
  const sortNoOp = dispatch({
    type: 'tags.sortByImpact',
    payload: { itemId: createdItem.id },
  });
  assert.equal(sortNoOp.ok, true);
  assert.equal(sortNoOp.code, 'NO_CHANGES');

  const addedCase = dispatch({
    type: 'case.create',
    payload: {
      tagId: addedTagId,
      title: 'A second backup',
      suggestedActions: ['Call the coordinator.'],
    },
  });
  assert.equal(addedCase.ok, true);
  const addedCaseId = addedCase.ok ? addedCase.affectedIds[1] : '';
  const updatedCase = dispatch({
    type: 'case.update',
    payload: {
      caseId: addedCaseId,
      title: 'A confirmed second backup',
      suggestedActions: ['Call the coordinator.', 'Record the decision.'],
    },
  });
  assert.equal(updatedCase.ok, true);
  const updatedCaseValue = getSnapshot().project.timeline[0].tags
    .find((tag) => tag.id === addedTagId)?.cases.find((entry) => entry.id === addedCaseId);
  assert.equal(updatedCaseValue?.source, 'agent');
  assert.equal(updatedCaseValue?.suggestedActionSource, 'agent');
  assert.equal(updatedCaseValue?.title, 'A confirmed second backup');

  const answeredCase = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: addedCaseId,
      disposition: 'covered',
      actions: [],
      when: '',
      status: null,
    },
  });
  assert.equal(answeredCase.ok, true);

  const deletedCase = dispatch({
    type: 'case.delete',
    payload: { caseId: addedCaseId },
  });
  assert.equal(deletedCase.ok, true);
  assert.equal(
    getSnapshot().project.timeline[0].tags
      .find((tag) => tag.id === addedTagId)?.cases.some((entry) => entry.id === addedCaseId),
    false,
  );

  const updatedTag = dispatch({
    type: 'tag.update',
    payload: {
      tagId: addedTagId,
      question: 'What if the substitute fails?',
      rationale: 'A second fallback may be needed.',
      summary: 'Keep one confirmed backup.',
    },
  });
  assert.equal(updatedTag.ok, true);
  assert.equal(
    getSnapshot().project.timeline[0].tags.find((tag) => tag.id === addedTagId)?.question,
    'What if the substitute fails?',
  );

  const remainingCaseId = getSnapshot().project.timeline[0].tags.find(
    (tag) => tag.id === addedTagId,
  )?.cases[0].id;
  const answeredTag = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: remainingCaseId ?? '',
      disposition: 'covered',
      actions: [],
      when: '',
      status: null,
    },
  });
  assert.equal(answeredTag.ok, true);

  const deletedTag = dispatch({
    type: 'tag.delete',
    payload: { tagId: addedTagId },
  });
  assert.equal(deletedTag.ok, true);
  assert.equal(
    getSnapshot().project.timeline[0].tags.some((tag) => tag.id === addedTagId),
    false,
  );
  assert.deepEqual(initializePersistence(() => storage), {
    kind: 'ready',
    source: 'stored',
  });
  assert.equal(getSnapshot().project.timeline[0].tags[0].impact?.rank, 3);
});

test('deleting the final Case removes its What-if and history restores it', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage, 'empty').kind, 'ready');
  const created = dispatch({
    type: 'project.createWithPlan',
    payload: {
      title: 'Single What if',
      description: '',
      items: [
        {
          timeOrCue: '09:00',
          title: 'Start',
          body: '',
          tags: [
            {
              question: 'What if this changes?',
              rationale: 'The plan could change.',
              summary: 'Choose what to do.',
              impact: null,
              cases: [
                {
                  title: 'Only case',
                  suggestedActions: ['Review the change.'],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  assert.equal(created.ok, true);
  const onlyTag = getSnapshot().project.timeline[0].tags[0];
  const onlyCase = onlyTag.cases[0];
  const answered = dispatch({
    type: 'case.response.save',
    payload: {
      caseId: onlyCase.id,
      disposition: 'covered',
      actions: [],
      when: '',
      status: null,
    },
  });
  assert.equal(answered.ok, true);

  const deleted = dispatch({
    type: 'case.delete',
    payload: { caseId: onlyCase.id },
  });
  assert.equal(deleted.ok, true);
  assert.deepEqual(getSnapshot().project.timeline[0].tags, []);
  assert.deepEqual(getHistoryAvailability(), { canUndo: true, canRedo: false });

  const deletionVersion = getSnapshot().project.version;
  const undone = dispatch({ type: 'history.undo' });
  assert.equal(undone.ok, true);
  assert.equal(getSnapshot().project.timeline[0].tags[0].id, onlyTag.id);
  assert.ok(getSnapshot().project.version > deletionVersion);
  assert.deepEqual(getHistoryAvailability(), { canUndo: true, canRedo: true });

  const redone = dispatch({ type: 'history.redo' });
  assert.equal(redone.ok, true);
  assert.deepEqual(getSnapshot().project.timeline[0].tags, []);
  assert.deepEqual(getHistoryAvailability(), { canUndo: true, canRedo: false });

  const undoAgain = dispatch({ type: 'history.undo' });
  assert.equal(undoAgain.ok, true);
  const replacementEdit = dispatch({
    type: 'timeline.update',
    payload: {
      itemId: getSnapshot().project.timeline[0].id,
      timeOrCue: '09:15',
      title: 'Start',
      body: '',
    },
  });
  assert.equal(replacementEdit.ok, true);
  assert.equal(getHistoryAvailability().canRedo, false);
});

test('direct agent mutations contain storage failures and preserve versions', () => {
  const storage = new MemoryStorage();
  assert.equal(initializePersistence(() => storage).kind, 'ready');
  const tag = getSnapshot().project.timeline[0].tags[0];
  const before = getSnapshot();
  const bytes = storage.values.get('moshimo-tag:state:v1');
  storage.setItem = () => {
    throw new Error('write failed');
  };
  const failed = dispatch({
    type: 'tag.impact.set',
    payload: {
      tagId: tag.id,
      projectVersion: before.project.version,
      tagVersion: tag.version,
      impact: {
        rank: 5,
        expectedLossAmount: 10,
        currency: 'JPY',
        penalty: 'High.',
      },
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'SAVE_FAILED');
  assert.strictEqual(getSnapshot(), before);
  assert.equal(storage.values.get('moshimo-tag:state:v1'), bytes);
});
