import type { AppState, PersistenceResult, StoragePort } from './app-state.ts';
import {
  initializePersistence as initializeAppPersistence,
  resetPersistence as resetAppPersistence,
} from './app-state.ts';

export const sampleTestState: AppState = {
  schemaVersion: 8,
  project: {
    id: 'project-test-trip',
    version: 1,
    title: 'Test Flight Plan',
    description:
      'A simple route to the airport. Add what-if Tags only where a fallback would help.',
    viewMode: 'editing',
    timeline: [
      {
        id: 'item-leave-home',
        version: 1,
        timeOrCue: '15:30',
        title: 'Leave home',
        body: 'Taxi pickup is planned outside the apartment.',
        status: 'scheduled',
        tags: [
          {
            id: 'tag-traffic',
            version: 1,
            anchorItemId: 'item-leave-home',
            source: 'agent',
            needsRecheck: false,
            lifecycle: 'active',
            basedOnItemVersion: 1,
            basedOnProjectVersion: 1,
            question: 'What if traffic is much worse than expected?',
            rationale:
              'The current departure assumes a predictable drive to the airport.',
            summary: 'Choose how to leave based on the delay.',
            impact: null,
            cases: [
              {
                id: 'case-traffic-light',
                version: 1,
                source: 'agent',
                title: 'Under 15 min',
                suggestedActions: [
                  'Take the usual route and leave as planned.',
                ],
                suggestedActionSource: 'agent',
                planBOptions: [],
                responseCandidates: [],
                response: null,
              },
              {
                id: 'case-traffic-medium',
                version: 1,
                source: 'agent',
                title: '15–45 min',
                suggestedActions: [
                  'Leave earlier or ask the driver to use the alternate route.',
                ],
                suggestedActionSource: 'agent',
                planBOptions: [],
                responseCandidates: [],
                response: null,
              },
              {
                id: 'case-traffic-heavy',
                version: 1,
                source: 'agent',
                title: 'Over 45 min',
                suggestedActions: [
                  'Switch to the airport rail route from the nearest station.',
                ],
                suggestedActionSource: 'agent',
                planBOptions: [],
                responseCandidates: [],
                response: null,
              },
            ],
          },
          {
            id: 'tag-taxi',
            version: 1,
            anchorItemId: 'item-leave-home',
            source: 'agent',
            needsRecheck: false,
            lifecycle: 'active',
            basedOnItemVersion: 1,
            basedOnProjectVersion: 1,
            question: 'What if the taxi does not arrive?',
            rationale: 'The first leg depends on one pickup arriving on time.',
            summary: 'Use the fastest confirmed alternative instead of waiting indefinitely.',
            impact: null,
            cases: [
              {
                id: 'case-taxi-late',
                version: 1,
                source: 'agent',
                title: 'Driver is delayed',
                suggestedActions: [
                  'Call the driver and set a five-minute decision point.',
                ],
                suggestedActionSource: 'agent',
                planBOptions: [],
                responseCandidates: [],
                response: null,
              },
              {
                id: 'case-taxi-missing',
                version: 1,
                source: 'agent',
                title: 'Driver cannot be reached',
                suggestedActions: ['Request another car or walk to the station.'],
                suggestedActionSource: 'agent',
                planBOptions: [],
                responseCandidates: [],
                response: null,
              },
            ],
          },
        ],
      },
      {
        id: 'item-airport',
        version: 1,
        timeOrCue: '17:00',
        title: 'Arrive at airport',
        body: 'Check in, clear security, and walk to the gate.',
        status: 'scheduled',
        tags: [
          {
            id: 'tag-security',
            version: 1,
            anchorItemId: 'item-airport',
            source: 'agent',
            needsRecheck: false,
            lifecycle: 'active',
            basedOnItemVersion: 1,
            basedOnProjectVersion: 1,
            question: 'What if the security line is much longer than usual?',
            rationale: 'The plan leaves limited time between arrival and boarding.',
            summary: 'Protect the boarding buffer before optional airport tasks.',
            impact: null,
            cases: [
              {
                id: 'case-security-long',
                version: 1,
                source: 'agent',
                title: 'Queue exceeds 30 min',
                suggestedActions: ['Ask airport staff for the fastest valid lane.'],
                suggestedActionSource: 'agent',
                planBOptions: [],
                responseCandidates: [],
                response: null,
              },
            ],
          },
          {
            id: 'tag-document',
            version: 1,
            anchorItemId: 'item-airport',
            source: 'agent',
            needsRecheck: false,
            lifecycle: 'active',
            basedOnItemVersion: 1,
            basedOnProjectVersion: 1,
            question: 'What if a required document is missing?',
            rationale: 'Check-in depends on having the required documents.',
            summary: 'Confirm the recovery path before changing the rest of the trip.',
            impact: null,
            cases: [
              {
                id: 'case-document-copy',
                version: 1,
                source: 'agent',
                title: 'A digital copy is available',
                suggestedActions: ['Ask the airline whether the copy is accepted.'],
                suggestedActionSource: 'agent',
                planBOptions: [],
                responseCandidates: [],
                response: null,
              },
            ],
          },
        ],
      },
      {
        id: 'item-flight',
        version: 1,
        timeOrCue: '19:00',
        title: 'Flight',
        body: 'Board the booked flight to the destination.',
        status: 'scheduled',
        tags: [
          {
            id: 'tag-cancelled',
            version: 1,
            anchorItemId: 'item-flight',
            source: 'agent',
            needsRecheck: false,
            lifecycle: 'active',
            basedOnItemVersion: 1,
            basedOnProjectVersion: 1,
            question: 'What if the flight is cancelled?',
            rationale: 'A cancellation changes both timing and onward plans.',
            summary: 'Choose an alternative based on when the trip can still continue.',
            impact: null,
            cases: [
              {
                id: 'case-rebook',
                version: 1,
                source: 'agent',
                title: 'Same-day rebooking is available',
                suggestedActions: ['Rebook before arranging the onward journey.'],
                suggestedActionSource: 'agent',
                planBOptions: [],
                responseCandidates: [],
                response: null,
              },
            ],
          },
        ],
      },
    ],
    gapSuggestions: [
      {
        id: 'gap-check-documents',
        source: 'agent',
        insertAfterItemId: 'item-leave-home',
        timeOrCue: '16:30',
        title: 'Check travel documents',
        body: 'Confirm the passport and boarding details before reaching the airport.',
        status: 'proposed',
      },
      {
        id: 'gap-confirm-arrival',
        source: 'agent',
        insertAfterItemId: 'item-airport',
        timeOrCue: '17:30',
        title: 'Confirm the arrival plan',
        body: 'Tell the destination contact how and when you expect to arrive.',
        status: 'proposed',
      },
    ],
    activeReviewRequest: null,
    activeRecheckRequest: null,
  },
  projects: [],
  undoDelete: null,
};


export function initializeTestPersistence(
  getStorage: () => StoragePort,
  bootstrap: 'empty' | 'sample' = 'sample',
): PersistenceResult {
  return initializeAppPersistence(
    getStorage,
    bootstrap === 'sample' ? { bootstrapState: sampleTestState } : undefined,
  );
}

export function resetTestPersistence(
  getStorage?: () => StoragePort,
  bootstrap: 'empty' | 'sample' = 'sample',
): PersistenceResult {
  return resetAppPersistence(
    getStorage,
    bootstrap === 'sample' ? { bootstrapState: sampleTestState } : undefined,
  );
}
