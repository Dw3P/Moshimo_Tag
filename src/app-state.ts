export type ItemStatus = 'scheduled' | 'draft';
export type TagSource = 'agent' | 'human';
export type SuggestedActionSource = 'agent' | 'human';
export type ImpactRank = 1 | 2 | 3 | 4 | 5;
export interface TagImpact {
  rank: ImpactRank;
  expectedLossAmount: number | null;
  currency: string | null;
  penalty: string;
}
export type CaseDisposition =
  | 'covered'
  | 'accept'
  | 'prepare'
  | 'plan_b'
  | 'dismiss';
export type PreparationStatus = 'pending' | 'done';
export type ViewMode = 'editing' | 'final';
export type ReviewKind =
  | 'project_plan'
  | 'timeline_whatifs'
  | 'item_whatifs'
  | 'tag_cases'
  | 'case_actions'
  | 'timeline_gaps';

export interface MoshimoCase {
  id: string;
  version: number;
  source: TagSource;
  title: string;
  suggestedActions: string[];
  suggestedActionSource: SuggestedActionSource | null;
  planBOptionsDraft: string[] | null;
  response: CaseResponse | null;
}

export interface CaseResponse {
  disposition: CaseDisposition;
  actions: string[];
  when: string;
  status: PreparationStatus | null;
}

export interface MoshimoTag {
  id: string;
  version: number;
  anchorItemId: string;
  source: TagSource;
  needsRecheck: boolean;
  lifecycle: 'active' | 'resolved';
  basedOnItemVersion: number;
  basedOnProjectVersion: number;
  question: string;
  rationale: string;
  summary: string;
  impact: TagImpact | null;
  cases: MoshimoCase[];
}

export interface TimelineItem {
  id: string;
  version: number;
  timeOrCue: string;
  title: string;
  body: string;
  status: ItemStatus;
  tags: MoshimoTag[];
}

export interface DeletedTimelineItem {
  item: TimelineItem;
  index: number;
  gapSuggestions: PlanGapSuggestion[];
}

export interface ReviewRequest {
  id: string;
  kind: ReviewKind;
  ownerId: string;
  ownerVersion: number;
  projectVersion: number;
}

export interface RecheckRequestTag {
  tagId: string;
  tagVersion: number;
  itemId: string;
  itemVersion: number;
}

export interface RecheckRequest {
  id: string;
  projectVersion: number;
  tags: RecheckRequestTag[];
}

export interface PlanGapSuggestion {
  id: string;
  source: 'agent';
  insertAfterItemId: string | null;
  timeOrCue: string;
  title: string;
  body: string;
  status: 'proposed' | 'accepted' | 'ignored';
}

export interface ProjectState {
  id: string;
  version: number;
  title: string;
  description: string;
  viewMode: ViewMode;
  timeline: TimelineItem[];
  gapSuggestions: PlanGapSuggestion[];
  activeReviewRequest: ReviewRequest | null;
  activeRecheckRequest: RecheckRequest | null;
}

export interface ProjectPlanCaseInput {
  title: string;
  suggestedActions: string[];
}

export interface ProjectPlanTagInput {
  question: string;
  rationale: string;
  summary: string;
  impact: TagImpact | null;
  cases: ProjectPlanCaseInput[];
}

export interface ProjectPlanItemInput {
  timeOrCue: string;
  title: string;
  body: string;
  tags: ProjectPlanTagInput[];
}

type NormalReviewKind = Exclude<ReviewKind, 'project_plan'>;

interface ReviewSuggestionRequestInput {
  id: string;
  kind: ReviewKind;
  ownerId: string;
  ownerVersion: number;
  projectVersion: number;
}

interface ReviewSuggestionCaseInput {
  title: string;
  suggestedActions: string[];
}

interface ReviewSuggestionTagInput {
  anchorItemId: string;
  question: string;
  rationale: string;
  summary: string;
  cases: ReviewSuggestionCaseInput[];
}

interface ReviewSuggestionGapInput {
  insertAfterItemId: string | null;
  timeOrCue: string;
  title: string;
  body: string;
}

type ReviewSuggestionsApplyPayload =
  | {
      kind: 'timeline_whatifs' | 'item_whatifs';
      request: ReviewSuggestionRequestInput;
      projectId: string;
      projectVersion: number;
      tags: ReviewSuggestionTagInput[];
    }
  | {
      kind: 'tag_cases';
      request: ReviewSuggestionRequestInput;
      projectId: string;
      projectVersion: number;
      tagId: string;
      cases: ReviewSuggestionCaseInput[];
    }
  | {
      kind: 'case_actions';
      request: ReviewSuggestionRequestInput;
      projectId: string;
      projectVersion: number;
      caseId: string;
      suggestedActions: string[];
    }
  | {
      kind: 'timeline_gaps';
      request: ReviewSuggestionRequestInput;
      projectId: string;
      projectVersion: number;
      gaps: ReviewSuggestionGapInput[];
    };

type RecheckReplacementInput = ReviewSuggestionTagInput;

type RecheckOutcomeInput =
  | {
      tagId: string;
      tagVersion: number;
      outcome: 'retain' | 'resolve';
    }
  | {
      tagId: string;
      tagVersion: number;
      outcome: 'replace';
      replacement: RecheckReplacementInput;
    };

export interface AppState {
  schemaVersion: 6;
  project: ProjectState;
  projects: ProjectState[];
  undoDelete: DeletedTimelineItem | null;
}

export type AppCommand =
  | {
      type: 'project.create';
      payload: { title: string; description: string; requestReview: boolean };
    }
  | {
      type: 'project.createWithPlan';
      payload: {
        title: string;
        description: string;
        items: ProjectPlanItemInput[];
      };
    }
  | {
      type: 'review.project_plan.apply';
      payload: {
        requestId: string;
        projectId: string;
        projectVersion: number;
        items: ProjectPlanItemInput[];
      };
    }
  | {
      type: 'review.suggestions.apply';
      payload: ReviewSuggestionsApplyPayload;
    }
  | { type: 'recheck.request'; payload: { tagIds: string[] } }
  | {
      type: 'recheck.apply';
      payload: {
        request: RecheckRequest;
        projectId: string;
        projectVersion: number;
        outcomes: RecheckOutcomeInput[];
      };
    }
  | { type: 'recheck.clear'; payload: { requestId: string } }
  | { type: 'project.open'; payload: { projectId: string } }
  | { type: 'project.delete'; payload: { projectId: string } }
  | {
      type: 'project.update';
      payload: { title: string; description: string };
    }
  | {
      type: 'project.view.set';
      payload: { viewMode: ViewMode };
    }
  | {
      type: 'timeline.add';
      payload: {
        timeOrCue: string;
        title: string;
        body: string;
        requestReview: boolean;
      };
    }
  | {
      type: 'timeline.update';
      payload: {
        itemId: string;
        timeOrCue: string;
        title: string;
        body: string;
      };
    }
  | {
      type: 'timeline.move';
      payload: { itemId: string; direction: 'up' | 'down' };
    }
  | { type: 'timeline.delete'; payload: { itemId: string } }
  | { type: 'timeline.undoDelete' }
  | { type: 'history.undo' }
  | { type: 'history.redo' }
  | {
      type: 'tag.add';
      payload: {
        anchorItemId: string;
        question: string;
        caseTitle: string;
        ownAction: string;
        requestReview: boolean;
      };
    }
  | {
      type: 'tag.create';
      payload: {
        anchorItemId: string;
        question: string;
        rationale: string;
        summary: string;
        impact: TagImpact | null;
        cases: ProjectPlanCaseInput[];
        projectVersion?: number;
        itemVersion?: number;
      };
    }
  | {
      type: 'tag.update';
      payload: {
        tagId: string;
        question: string;
        rationale: string;
        summary: string;
        projectVersion?: number;
        tagVersion?: number;
      };
    }
  | {
      type: 'tag.delete';
      payload: {
        tagId: string;
        projectVersion?: number;
        tagVersion?: number;
      };
    }
  | {
      type: 'tag.move';
      payload: {
        tagId: string;
        direction: 'up' | 'down';
        projectVersion?: number;
        tagVersion?: number;
      };
    }
  | {
      type: 'tag.impact.set';
      payload: {
        tagId: string;
        impact: TagImpact | null;
        projectVersion?: number;
        tagVersion?: number;
      };
    }
  | {
      type: 'tags.sortByImpact';
      payload: { itemId: string | null; projectVersion?: number };
    }
  | {
      type: 'case.add';
      payload: {
        tagId: string;
        title: string;
        ownAction: string;
        requestReview: boolean;
      };
    }
  | {
      type: 'case.create';
      payload: {
        tagId: string;
        title: string;
        suggestedActions: string[];
        projectVersion?: number;
        tagVersion?: number;
      };
    }
  | {
      type: 'case.update';
      payload: {
        caseId: string;
        title: string;
        suggestedActions: string[];
        projectVersion?: number;
        caseVersion?: number;
      };
    }
  | {
      type: 'case.delete';
      payload: {
        caseId: string;
        projectVersion?: number;
        caseVersion?: number;
      };
    }
  | {
      type: 'case.planBOptions.set';
      payload: {
        caseId: string;
        options: string[] | null;
        projectVersion?: number;
        caseVersion?: number;
      };
    }
  | {
      type: 'case.response.save';
      payload: {
        caseId: string;
        disposition: CaseDisposition;
        actions: string[];
        when: string;
        status: PreparationStatus | null;
      };
    }
  | {
      type: 'gap.move';
      payload: { suggestionId: string; direction: 'up' | 'down' };
    }
  | { type: 'gap.add'; payload: { suggestionId: string } }
  | { type: 'gap.ignore'; payload: { suggestionId: string } }
  | {
      type: 'review.request';
      payload: { kind: ReviewKind; ownerId: string };
    }
  | { type: 'review.clear'; payload: { requestId: string } };

export type CommandResult =
  | {
      ok: true;
      code: 'OK' | 'NO_CHANGES';
      affectedIds: string[];
      version: number;
    }
  | {
      ok: false;
      code:
        | 'INVALID_INPUT'
        | 'LIMIT_EXCEEDED'
        | 'NOT_FOUND'
        | 'INVALID_STATE'
        | 'VERSION_CONFLICT'
        | 'SAVE_FAILED'
        | 'DUPLICATE';
      message: string;
      retryable: boolean;
    };

export const MAX_PROJECTS = 10;
export const STORAGE_KEY = 'moshimo-tag:state:v1';
export const EMPTY_WORKSPACE_PROJECT_ID = 'workspace-empty';

export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PersistenceResult =
  | { kind: 'ready'; source: 'empty' | 'seed' | 'stored' | 'reset' }
  | {
      kind: 'recovery';
      reason:
        | 'corrupt'
        | 'invalid_shape'
        | 'unsupported_version'
        | 'read_failed'
        | 'reset_failed';
      message: string;
    };

const emptyWorkspaceState: AppState = {
  schemaVersion: 6,
  project: {
    id: EMPTY_WORKSPACE_PROJECT_ID,
    version: 1,
    title: 'Start a project',
    description: '',
    viewMode: 'editing',
    timeline: [],
    gapSuggestions: [],
    activeReviewRequest: null,
    activeRecheckRequest: null,
  },
  projects: [],
  undoDelete: null,
};

export interface PersistenceOptions {
  bootstrapState?: AppState;
}

const LEGACY_DEBUG_PROJECT_ID = 'project-airport-trip';

export function isEmptyWorkspaceProject(project: ProjectState): boolean {
  return project.id === EMPTY_WORKSPACE_PROJECT_ID;
}

function bootstrapState(options?: PersistenceOptions): AppState {
  const value = options?.bootstrapState ?? emptyWorkspaceState;
  return JSON.parse(JSON.stringify(value)) as AppState;
}

let state = emptyWorkspaceState;
let sequence = 0;
let persistenceStorage: StoragePort | null = null;
let persistenceMode: 'uninitialized' | 'ready' | 'recovery' = 'uninitialized';
const HISTORY_LIMIT = 50;
let undoHistory: AppState[] = [];
let redoHistory: AppState[] = [];
const listeners = new Set<() => void>();

function clearHistory(): void {
  undoHistory = [];
  redoHistory = [];
}

function cloneHistoryState(value: AppState): AppState {
  return JSON.parse(JSON.stringify({ ...value, undoDelete: null })) as AppState;
}

export function getSnapshot(): AppState {
  return state;
}

export function getServerSnapshot(): AppState {
  return emptyWorkspaceState;
}

export function getHistoryAvailability(): {
  canUndo: boolean;
  canRedo: boolean;
} {
  return {
    canUndo: undoHistory.length > 0,
    canRedo: redoHistory.length > 0,
  };
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function appId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function clean(value: string): string {
  return value.normalize('NFC').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    expected.every((key, index) => key === actual[index])
  );
}

function isReviewKind(value: unknown): value is ReviewKind {
  return (
    value === 'project_plan' ||
    value === 'timeline_whatifs' ||
    value === 'item_whatifs' ||
    value === 'tag_cases' ||
    value === 'case_actions' ||
    value === 'timeline_gaps'
  );
}

function isNormalReviewKind(value: unknown): value is NormalReviewKind {
  return (
    value === 'timeline_whatifs' ||
    value === 'item_whatifs' ||
    value === 'tag_cases' ||
    value === 'case_actions' ||
    value === 'timeline_gaps'
  );
}

function isCaseDisposition(value: unknown): value is CaseDisposition {
  return (
    value === 'covered' ||
    value === 'accept' ||
    value === 'prepare' ||
    value === 'plan_b' ||
    value === 'dismiss'
  );
}

function isPreparationStatus(value: unknown): value is PreparationStatus {
  return value === 'pending' || value === 'done';
}

function isViewMode(value: unknown): value is ViewMode {
  return value === 'editing' || value === 'final';
}

function isImpactRank(value: unknown): value is ImpactRank {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

type ImpactParseResult =
  | { ok: true; value: TagImpact | null }
  | { ok: false };

function parseImpact(value: unknown): ImpactParseResult {
  if (value === null) return { ok: true, value: null };
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'currency',
      'expectedLossAmount',
      'penalty',
      'rank',
    ]) ||
    !isImpactRank(value.rank) ||
    (value.expectedLossAmount !== null &&
      (typeof value.expectedLossAmount !== 'number' ||
        !Number.isFinite(value.expectedLossAmount) ||
        value.expectedLossAmount < 0)) ||
    (value.currency !== null &&
      (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))) ||
    (value.expectedLossAmount === null) !== (value.currency === null) ||
    typeof value.penalty !== 'string' ||
    textLength(value.penalty) > 240
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      rank: value.rank,
      expectedLossAmount: value.expectedLossAmount,
      currency: value.currency,
      penalty: value.penalty,
    },
  };
}

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every((key) => allowed.has(key))
  );
}

type OptionalVersions = {
  projectVersion?: number;
  itemVersion?: number;
  tagVersion?: number;
  caseVersion?: number;
};

function parseOptionalVersions(
  value: Record<string, unknown>,
  names: (keyof OptionalVersions)[],
): OptionalVersions | null {
  const versions: OptionalVersions = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) {
      if (!isVersion(value[name])) return null;
      versions[name] = value[name] as number;
    }
  }
  return versions;
}

function parseProjectPlanCases(value: unknown): ProjectPlanCaseInput[] | null {
  if (!Array.isArray(value)) return null;
  const cases: ProjectPlanCaseInput[] = [];
  for (const rawCase of value) {
    if (
      !isRecord(rawCase) ||
      !hasExactKeys(rawCase, ['suggestedActions', 'title']) ||
      typeof rawCase.title !== 'string' ||
      !Array.isArray(rawCase.suggestedActions) ||
      !rawCase.suggestedActions.every((action) => typeof action === 'string')
    ) {
      return null;
    }
    cases.push({
      title: rawCase.title,
      suggestedActions: [...rawCase.suggestedActions],
    });
  }
  return cases;
}

function parseProjectPlanItems(value: unknown): ProjectPlanItemInput[] | null {
  if (!Array.isArray(value)) return null;

  const items: ProjectPlanItemInput[] = [];
  for (const rawItem of value) {
    if (
      !isRecord(rawItem) ||
      !hasExactKeys(rawItem, ['body', 'tags', 'timeOrCue', 'title']) ||
      typeof rawItem.timeOrCue !== 'string' ||
      typeof rawItem.title !== 'string' ||
      typeof rawItem.body !== 'string' ||
      !Array.isArray(rawItem.tags)
    ) {
      return null;
    }

    const tags: ProjectPlanTagInput[] = [];
    for (const rawTag of rawItem.tags) {
      if (
        !isRecord(rawTag) ||
        (!hasExactKeys(rawTag, [
          'cases',
          'question',
          'rationale',
          'summary',
        ]) &&
          !hasExactKeys(rawTag, [
            'cases',
            'impact',
            'question',
            'rationale',
            'summary',
          ])) ||
        typeof rawTag.question !== 'string' ||
        typeof rawTag.rationale !== 'string' ||
        typeof rawTag.summary !== 'string' ||
        !Array.isArray(rawTag.cases)
      ) {
        return null;
      }

      const cases = parseProjectPlanCases(rawTag.cases);
      if (cases === null) return null;
      const impactResult =
        Object.prototype.hasOwnProperty.call(rawTag, 'impact')
          ? parseImpact(rawTag.impact)
          : { ok: true as const, value: null };
      if (!impactResult.ok) return null;
      tags.push({
        question: rawTag.question,
        rationale: rawTag.rationale,
        summary: rawTag.summary,
        impact: impactResult.value,
        cases,
      });
    }
    items.push({
      timeOrCue: rawItem.timeOrCue,
      title: rawItem.title,
      body: rawItem.body,
      tags,
    });
  }
  return items;
}

function parseReviewSuggestionRequest(
  value: unknown,
): ReviewSuggestionRequestInput | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'kind',
      'ownerId',
      'ownerVersion',
      'projectVersion',
    ]) ||
    typeof value.id !== 'string' ||
    !isReviewKind(value.kind) ||
    typeof value.ownerId !== 'string' ||
    typeof value.ownerVersion !== 'number' ||
    !Number.isSafeInteger(value.ownerVersion) ||
    typeof value.projectVersion !== 'number' ||
    !Number.isSafeInteger(value.projectVersion)
  ) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind,
    ownerId: value.ownerId,
    ownerVersion: value.ownerVersion,
    projectVersion: value.projectVersion,
  };
}

function parseReviewSuggestionCases(
  value: unknown,
): ReviewSuggestionCaseInput[] | null {
  if (!Array.isArray(value)) return null;
  const cases: ReviewSuggestionCaseInput[] = [];
  for (const rawCase of value) {
    if (
      !isRecord(rawCase) ||
      !hasExactKeys(rawCase, ['suggestedActions', 'title']) ||
      typeof rawCase.title !== 'string' ||
      !Array.isArray(rawCase.suggestedActions) ||
      !rawCase.suggestedActions.every((action) => typeof action === 'string')
    ) {
      return null;
    }
    cases.push({
      title: rawCase.title,
      suggestedActions: [...rawCase.suggestedActions],
    });
  }
  return cases;
}

function parseReviewSuggestionTags(
  value: unknown,
): ReviewSuggestionTagInput[] | null {
  if (!Array.isArray(value)) return null;
  const tags: ReviewSuggestionTagInput[] = [];
  for (const rawTag of value) {
    const cases = isRecord(rawTag)
      ? parseReviewSuggestionCases(rawTag.cases)
      : null;
    if (
      !isRecord(rawTag) ||
      !hasExactKeys(rawTag, [
        'anchorItemId',
        'cases',
        'question',
        'rationale',
        'summary',
      ]) ||
      typeof rawTag.anchorItemId !== 'string' ||
      typeof rawTag.question !== 'string' ||
      typeof rawTag.rationale !== 'string' ||
      typeof rawTag.summary !== 'string' ||
      cases === null
    ) {
      return null;
    }
    tags.push({
      anchorItemId: rawTag.anchorItemId,
      question: rawTag.question,
      rationale: rawTag.rationale,
      summary: rawTag.summary,
      cases,
    });
  }
  return tags;
}

function parseReviewSuggestionGaps(
  value: unknown,
): ReviewSuggestionGapInput[] | null {
  if (!Array.isArray(value)) return null;
  const gaps: ReviewSuggestionGapInput[] = [];
  for (const rawGap of value) {
    if (
      !isRecord(rawGap) ||
      !hasExactKeys(rawGap, ['body', 'insertAfterItemId', 'timeOrCue', 'title']) ||
      (rawGap.insertAfterItemId !== null &&
        typeof rawGap.insertAfterItemId !== 'string') ||
      typeof rawGap.timeOrCue !== 'string' ||
      typeof rawGap.title !== 'string' ||
      typeof rawGap.body !== 'string'
    ) {
      return null;
    }
    gaps.push({
      insertAfterItemId: rawGap.insertAfterItemId,
      timeOrCue: rawGap.timeOrCue,
      title: rawGap.title,
      body: rawGap.body,
    });
  }
  return gaps;
}

function parseRecheckRequest(value: unknown): RecheckRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'projectVersion', 'tags']) ||
    typeof value.id !== 'string' ||
    typeof value.projectVersion !== 'number' ||
    !Number.isSafeInteger(value.projectVersion) ||
    !Array.isArray(value.tags)
  ) {
    return null;
  }
  const tags: RecheckRequestTag[] = [];
  for (const rawTag of value.tags) {
    if (
      !isRecord(rawTag) ||
      !hasExactKeys(rawTag, ['itemId', 'itemVersion', 'tagId', 'tagVersion']) ||
      typeof rawTag.tagId !== 'string' ||
      typeof rawTag.tagVersion !== 'number' ||
      !Number.isSafeInteger(rawTag.tagVersion) ||
      typeof rawTag.itemId !== 'string' ||
      typeof rawTag.itemVersion !== 'number' ||
      !Number.isSafeInteger(rawTag.itemVersion)
    ) {
      return null;
    }
    tags.push({
      tagId: rawTag.tagId,
      tagVersion: rawTag.tagVersion,
      itemId: rawTag.itemId,
      itemVersion: rawTag.itemVersion,
    });
  }
  return { id: value.id, projectVersion: value.projectVersion, tags };
}

function parseRecheckOutcomes(value: unknown): RecheckOutcomeInput[] | null {
  if (!Array.isArray(value)) return null;
  const outcomes: RecheckOutcomeInput[] = [];
  for (const rawOutcome of value) {
    if (
      !isRecord(rawOutcome) ||
      typeof rawOutcome.tagId !== 'string' ||
      typeof rawOutcome.tagVersion !== 'number' ||
      !Number.isSafeInteger(rawOutcome.tagVersion) ||
      typeof rawOutcome.outcome !== 'string'
    ) {
      return null;
    }
    if (rawOutcome.outcome === 'retain' || rawOutcome.outcome === 'resolve') {
      if (!hasExactKeys(rawOutcome, ['outcome', 'tagId', 'tagVersion'])) {
        return null;
      }
      outcomes.push({
        tagId: rawOutcome.tagId,
        tagVersion: rawOutcome.tagVersion,
        outcome: rawOutcome.outcome,
      });
      continue;
    }
    if (
      rawOutcome.outcome !== 'replace' ||
      !hasExactKeys(rawOutcome, [
        'outcome',
        'replacement',
        'tagId',
        'tagVersion',
      ])
    ) {
      return null;
    }
    const replacements = parseReviewSuggestionTags([rawOutcome.replacement]);
    if (replacements === null || replacements.length !== 1) return null;
    outcomes.push({
      tagId: rawOutcome.tagId,
      tagVersion: rawOutcome.tagVersion,
      outcome: 'replace',
      replacement: replacements[0],
    });
  }
  return outcomes;
}

function parseCommand(raw: unknown): AppCommand | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return null;
  }

  if (
    raw.type === 'timeline.undoDelete' ||
    raw.type === 'history.undo' ||
    raw.type === 'history.redo'
  ) {
    return hasExactKeys(raw, ['type']) ? { type: raw.type } : null;
  }

  if (!hasExactKeys(raw, ['payload', 'type']) || !isRecord(raw.payload)) {
    return null;
  }

  const payload = raw.payload;
  switch (raw.type) {
    case 'project.create': {
      if (
        !hasExactKeys(payload, ['description', 'requestReview', 'title']) ||
        typeof payload.title !== 'string' ||
        typeof payload.description !== 'string' ||
        typeof payload.requestReview !== 'boolean'
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          title: payload.title,
          description: payload.description,
          requestReview: payload.requestReview,
        },
      };
    }
    case 'project.createWithPlan': {
      const items = parseProjectPlanItems(payload.items);
      if (
        !hasExactKeys(payload, ['description', 'items', 'title']) ||
        typeof payload.title !== 'string' ||
        typeof payload.description !== 'string' ||
        items === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: { title: payload.title, description: payload.description, items },
      };
    }
    case 'review.project_plan.apply': {
      const items = parseProjectPlanItems(payload.items);
      if (
        !hasExactKeys(payload, [
          'items',
          'projectId',
          'projectVersion',
          'requestId',
        ]) ||
        typeof payload.requestId !== 'string' ||
        typeof payload.projectId !== 'string' ||
        typeof payload.projectVersion !== 'number' ||
        !Number.isSafeInteger(payload.projectVersion) ||
        items === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          requestId: payload.requestId,
          projectId: payload.projectId,
          projectVersion: payload.projectVersion,
          items,
        },
      };
    }
    case 'review.suggestions.apply': {
      const request = parseReviewSuggestionRequest(payload.request);
      if (
        !isNormalReviewKind(payload.kind) ||
        request === null ||
        typeof payload.projectId !== 'string' ||
        typeof payload.projectVersion !== 'number' ||
        !Number.isSafeInteger(payload.projectVersion)
      ) {
        return null;
      }

      if (
        payload.kind === 'timeline_whatifs' ||
        payload.kind === 'item_whatifs'
      ) {
        const tags = parseReviewSuggestionTags(payload.tags);
        if (
          !hasExactKeys(payload, [
            'kind',
            'projectId',
            'projectVersion',
            'request',
            'tags',
          ]) ||
          tags === null
        ) {
          return null;
        }
        return {
          type: raw.type,
          payload: {
            kind: payload.kind,
            request,
            projectId: payload.projectId,
            projectVersion: payload.projectVersion,
            tags,
          },
        };
      }

      if (payload.kind === 'tag_cases') {
        const cases = parseReviewSuggestionCases(payload.cases);
        if (
          !hasExactKeys(payload, [
            'cases',
            'kind',
            'projectId',
            'projectVersion',
            'request',
            'tagId',
          ]) ||
          typeof payload.tagId !== 'string' ||
          cases === null
        ) {
          return null;
        }
        return {
          type: raw.type,
          payload: {
            kind: payload.kind,
            request,
            projectId: payload.projectId,
            projectVersion: payload.projectVersion,
            tagId: payload.tagId,
            cases,
          },
        };
      }

      if (payload.kind === 'case_actions') {
        if (
          !hasExactKeys(payload, [
            'caseId',
            'kind',
            'projectId',
            'projectVersion',
            'request',
            'suggestedActions',
          ]) ||
          typeof payload.caseId !== 'string' ||
          !Array.isArray(payload.suggestedActions) ||
          !payload.suggestedActions.every((action) => typeof action === 'string')
        ) {
          return null;
        }
        return {
          type: raw.type,
          payload: {
            kind: payload.kind,
            request,
            projectId: payload.projectId,
            projectVersion: payload.projectVersion,
            caseId: payload.caseId,
            suggestedActions: [...payload.suggestedActions],
          },
        };
      }

      const gaps = parseReviewSuggestionGaps(payload.gaps);
      if (
        !hasExactKeys(payload, [
          'gaps',
          'kind',
          'projectId',
          'projectVersion',
          'request',
        ]) ||
        gaps === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          kind: payload.kind,
          request,
          projectId: payload.projectId,
          projectVersion: payload.projectVersion,
          gaps,
        },
      };
    }
    case 'recheck.request': {
      if (
        !hasExactKeys(payload, ['tagIds']) ||
        !Array.isArray(payload.tagIds) ||
        !payload.tagIds.every((tagId) => typeof tagId === 'string')
      ) {
        return null;
      }
      return { type: raw.type, payload: { tagIds: [...payload.tagIds] } };
    }
    case 'recheck.apply': {
      const request = parseRecheckRequest(payload.request);
      const outcomes = parseRecheckOutcomes(payload.outcomes);
      if (
        !hasExactKeys(payload, [
          'outcomes',
          'projectId',
          'projectVersion',
          'request',
        ]) ||
        request === null ||
        outcomes === null ||
        typeof payload.projectId !== 'string' ||
        typeof payload.projectVersion !== 'number' ||
        !Number.isSafeInteger(payload.projectVersion)
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          request,
          projectId: payload.projectId,
          projectVersion: payload.projectVersion,
          outcomes,
        },
      };
    }
    case 'recheck.clear': {
      if (
        !hasExactKeys(payload, ['requestId']) ||
        typeof payload.requestId !== 'string'
      ) {
        return null;
      }
      return { type: raw.type, payload: { requestId: payload.requestId } };
    }
    case 'project.open': {
      if (
        !hasExactKeys(payload, ['projectId']) ||
        typeof payload.projectId !== 'string'
      ) {
        return null;
      }
      return { type: raw.type, payload: { projectId: payload.projectId } };
    }
    case 'project.delete': {
      if (
        !hasExactKeys(payload, ['projectId']) ||
        typeof payload.projectId !== 'string'
      ) {
        return null;
      }
      return { type: raw.type, payload: { projectId: payload.projectId } };
    }
    case 'project.update': {
      if (
        !hasExactKeys(payload, ['description', 'title']) ||
        typeof payload.title !== 'string' ||
        typeof payload.description !== 'string'
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: { title: payload.title, description: payload.description },
      };
    }
    case 'project.view.set': {
      if (
        !hasExactKeys(payload, ['viewMode']) ||
        !isViewMode(payload.viewMode)
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: { viewMode: payload.viewMode },
      };
    }
    case 'timeline.add': {
      if (
        !hasExactKeys(payload, [
          'body',
          'requestReview',
          'timeOrCue',
          'title',
        ]) ||
        typeof payload.timeOrCue !== 'string' ||
        typeof payload.title !== 'string' ||
        typeof payload.body !== 'string' ||
        typeof payload.requestReview !== 'boolean'
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          timeOrCue: payload.timeOrCue,
          title: payload.title,
          body: payload.body,
          requestReview: payload.requestReview,
        },
      };
    }
    case 'timeline.update': {
      if (
        !hasExactKeys(payload, ['body', 'itemId', 'timeOrCue', 'title']) ||
        typeof payload.itemId !== 'string' ||
        typeof payload.timeOrCue !== 'string' ||
        typeof payload.title !== 'string' ||
        typeof payload.body !== 'string'
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          itemId: payload.itemId,
          timeOrCue: payload.timeOrCue,
          title: payload.title,
          body: payload.body,
        },
      };
    }
    case 'timeline.move': {
      if (
        !hasExactKeys(payload, ['direction', 'itemId']) ||
        typeof payload.itemId !== 'string' ||
        (payload.direction !== 'up' && payload.direction !== 'down')
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: { itemId: payload.itemId, direction: payload.direction },
      };
    }
    case 'timeline.delete': {
      if (
        !hasExactKeys(payload, ['itemId']) ||
        typeof payload.itemId !== 'string'
      ) {
        return null;
      }
      return { type: raw.type, payload: { itemId: payload.itemId } };
    }
    case 'tag.add': {
      if (
        !hasExactKeys(payload, [
          'anchorItemId',
          'caseTitle',
          'ownAction',
          'question',
          'requestReview',
        ]) ||
        typeof payload.anchorItemId !== 'string' ||
        typeof payload.question !== 'string' ||
        typeof payload.caseTitle !== 'string' ||
        typeof payload.ownAction !== 'string' ||
        typeof payload.requestReview !== 'boolean'
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          anchorItemId: payload.anchorItemId,
          question: payload.question,
          caseTitle: payload.caseTitle,
          ownAction: payload.ownAction,
          requestReview: payload.requestReview,
        },
      };
    }
    case 'tag.create': {
      const cases = parseProjectPlanCases(payload.cases);
      const impact = Object.prototype.hasOwnProperty.call(payload, 'impact')
        ? parseImpact(payload.impact)
        : ({ ok: true as const, value: null });
      const versions = parseOptionalVersions(payload, [
        'projectVersion',
        'itemVersion',
      ]);
      if (
        !hasRequiredAndOptionalKeys(
          payload,
          ['anchorItemId', 'cases', 'question', 'rationale', 'summary'],
          ['impact', 'itemVersion', 'projectVersion'],
        ) ||
        typeof payload.anchorItemId !== 'string' ||
        typeof payload.question !== 'string' ||
        typeof payload.rationale !== 'string' ||
        typeof payload.summary !== 'string' ||
        cases === null ||
        !impact.ok ||
        versions === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          anchorItemId: payload.anchorItemId,
          question: payload.question,
          rationale: payload.rationale,
          summary: payload.summary,
          impact: impact.value,
          cases,
          ...versions,
        },
      };
    }
    case 'tag.update': {
      const versions = parseOptionalVersions(payload, [
        'projectVersion',
        'tagVersion',
      ]);
      if (
        !hasRequiredAndOptionalKeys(
          payload,
          ['rationale', 'summary', 'question', 'tagId'],
          ['projectVersion', 'tagVersion'],
        ) ||
        typeof payload.tagId !== 'string' ||
        typeof payload.question !== 'string' ||
        typeof payload.rationale !== 'string' ||
        typeof payload.summary !== 'string' ||
        versions === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          tagId: payload.tagId,
          question: payload.question,
          rationale: payload.rationale,
          summary: payload.summary,
          ...versions,
        },
      };
    }
    case 'tag.delete': {
      const versions = parseOptionalVersions(payload, [
        'projectVersion',
        'tagVersion',
      ]);
      if (
        !hasRequiredAndOptionalKeys(
          payload,
          ['tagId'],
          ['projectVersion', 'tagVersion'],
        ) ||
        typeof payload.tagId !== 'string' ||
        versions === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: { tagId: payload.tagId, ...versions },
      };
    }
    case 'tag.move': {
      const versions = parseOptionalVersions(payload, [
        'projectVersion',
        'tagVersion',
      ]);
      if (
        !hasRequiredAndOptionalKeys(
          payload,
          ['direction', 'tagId'],
          ['projectVersion', 'tagVersion'],
        ) ||
        typeof payload.tagId !== 'string' ||
        (payload.direction !== 'up' && payload.direction !== 'down') ||
        versions === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          tagId: payload.tagId,
          direction: payload.direction,
          ...versions,
        },
      };
    }
    case 'tag.impact.set':
    case 'impact.set': {
      const impact = parseImpact(payload.impact);
      const versions = parseOptionalVersions(payload, [
        'projectVersion',
        'tagVersion',
      ]);
      if (
        !hasRequiredAndOptionalKeys(
          payload,
          ['impact', 'tagId'],
          ['projectVersion', 'tagVersion'],
        ) ||
        typeof payload.tagId !== 'string' ||
        !impact.ok ||
        versions === null
      ) {
        return null;
      }
      return {
        type: 'tag.impact.set',
        payload: { tagId: payload.tagId, impact: impact.value, ...versions },
      };
    }
    case 'tags.sortByImpact': {
      const versions = parseOptionalVersions(payload, ['projectVersion']);
      if (
        !hasRequiredAndOptionalKeys(payload, ['itemId'], ['projectVersion']) ||
        (payload.itemId !== null && typeof payload.itemId !== 'string') ||
        versions === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: { itemId: payload.itemId, ...versions },
      };
    }
    case 'case.add': {
      if (
        !hasExactKeys(payload, [
          'ownAction',
          'requestReview',
          'tagId',
          'title',
        ]) ||
        typeof payload.tagId !== 'string' ||
        typeof payload.title !== 'string' ||
        typeof payload.ownAction !== 'string' ||
        typeof payload.requestReview !== 'boolean'
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          tagId: payload.tagId,
          title: payload.title,
          ownAction: payload.ownAction,
          requestReview: payload.requestReview,
        },
      };
    }
    case 'case.create': {
      const versions = parseOptionalVersions(payload, [
        'projectVersion',
        'tagVersion',
      ]);
      if (
        !hasRequiredAndOptionalKeys(
          payload,
          ['suggestedActions', 'tagId', 'title'],
          ['projectVersion', 'tagVersion'],
        ) ||
        typeof payload.tagId !== 'string' ||
        typeof payload.title !== 'string' ||
        !Array.isArray(payload.suggestedActions) ||
        !payload.suggestedActions.every((action) => typeof action === 'string') ||
        versions === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          tagId: payload.tagId,
          title: payload.title,
          suggestedActions: [...payload.suggestedActions],
          ...versions,
        },
      };
    }
    case 'case.update': {
      const versions = parseOptionalVersions(payload, [
        'projectVersion',
        'caseVersion',
      ]);
      if (
        !hasRequiredAndOptionalKeys(
          payload,
          ['caseId', 'suggestedActions', 'title'],
          ['caseVersion', 'projectVersion'],
        ) ||
        typeof payload.caseId !== 'string' ||
        typeof payload.title !== 'string' ||
        !Array.isArray(payload.suggestedActions) ||
        !payload.suggestedActions.every((action) => typeof action === 'string') ||
        versions === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          caseId: payload.caseId,
          title: payload.title,
          suggestedActions: [...payload.suggestedActions],
          ...versions,
        },
      };
    }
    case 'case.delete': {
      const versions = parseOptionalVersions(payload, [
        'projectVersion',
        'caseVersion',
      ]);
      if (
        !hasRequiredAndOptionalKeys(payload, ['caseId'], [
          'caseVersion',
          'projectVersion',
        ]) ||
        typeof payload.caseId !== 'string' ||
        versions === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: { caseId: payload.caseId, ...versions },
      };
    }
    case 'case.planBOptions.set': {
      const versions = parseOptionalVersions(payload, [
        'projectVersion',
        'caseVersion',
      ]);
      if (
        !hasRequiredAndOptionalKeys(payload, ['caseId', 'options'], [
          'caseVersion',
          'projectVersion',
        ]) ||
        typeof payload.caseId !== 'string' ||
        (payload.options !== null &&
          (!Array.isArray(payload.options) ||
            !payload.options.every((option) => typeof option === 'string'))) ||
        versions === null
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          caseId: payload.caseId,
          options:
            payload.options === null ? null : [...payload.options],
          ...versions,
        },
      };
    }
    case 'case.response.save': {
      if (
        !hasExactKeys(payload, [
          'actions',
          'caseId',
          'disposition',
          'status',
          'when',
        ]) ||
        typeof payload.caseId !== 'string' ||
        !isCaseDisposition(payload.disposition) ||
        !Array.isArray(payload.actions) ||
        !payload.actions.every((action) => typeof action === 'string') ||
        typeof payload.when !== 'string' ||
        (payload.status !== null && !isPreparationStatus(payload.status))
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          caseId: payload.caseId,
          disposition: payload.disposition,
          actions: [...payload.actions],
          when: payload.when,
          status: payload.status,
        },
      };
    }
    case 'gap.move': {
      if (
        !hasExactKeys(payload, ['direction', 'suggestionId']) ||
        typeof payload.suggestionId !== 'string' ||
        (payload.direction !== 'up' && payload.direction !== 'down')
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: {
          suggestionId: payload.suggestionId,
          direction: payload.direction,
        },
      };
    }
    case 'gap.add':
    case 'gap.ignore': {
      if (
        !hasExactKeys(payload, ['suggestionId']) ||
        typeof payload.suggestionId !== 'string'
      ) {
        return null;
      }
      return { type: raw.type, payload: { suggestionId: payload.suggestionId } };
    }
    case 'review.request': {
      if (
        !hasExactKeys(payload, ['kind', 'ownerId']) ||
        !isReviewKind(payload.kind) ||
        typeof payload.ownerId !== 'string'
      ) {
        return null;
      }
      return {
        type: raw.type,
        payload: { kind: payload.kind, ownerId: payload.ownerId },
      };
    }
    case 'review.clear': {
      if (
        !hasExactKeys(payload, ['requestId']) ||
        typeof payload.requestId !== 'string'
      ) {
        return null;
      }
      return { type: raw.type, payload: { requestId: payload.requestId } };
    }
    default:
      return null;
  }
}

function textLength(value: string): number {
  return Array.from(value).length;
}

function isBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === 'string' &&
    value === value.normalize('NFC').trim() &&
    textLength(value) >= minimum &&
    textLength(value) <= maximum
  );
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function addUniqueId(value: unknown, ids: Set<string>): value is string {
  if (!isBoundedString(value, 1, 160) || ids.has(value)) return false;
  ids.add(value);
  return true;
}

function validateStoredCaseResponse(value: unknown): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['actions', 'disposition', 'status', 'when']) ||
    !isCaseDisposition(value.disposition) ||
    !Array.isArray(value.actions) ||
    !value.actions.every((action) => isBoundedString(action, 1, 1200)) ||
    textLength((value.actions as string[]).join('')) > 4800 ||
    !isBoundedString(value.when, 0, 120) ||
    (value.status !== null && !isPreparationStatus(value.status))
  ) {
    return false;
  }

  if (value.disposition === 'dismiss') {
    return value.actions.length === 0 && value.when === '' && value.status === null;
  }
  if (value.disposition === 'covered' || value.disposition === 'accept') {
    return (
      value.actions.length <= 1 && value.when === '' && value.status === null
    );
  }
  if (value.disposition === 'prepare') {
    return value.actions.length === 1;
  }
  return (
    value.actions.length >= 1 &&
    value.actions.length <= 5 &&
    value.when === '' &&
    value.status === null
  );
}

function validateStoredImpact(value: unknown): boolean {
  const parsed = parseImpact(value);
  if (!parsed.ok) return false;
  if (parsed.value === null) return true;
  return parsed.value.penalty === clean(parsed.value.penalty);
}

type StoredSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6;

function validateStoredCase(
  value: unknown,
  ids: Set<string>,
  schemaVersion: StoredSchemaVersion = 6,
): boolean {
  if (!isRecord(value)) return false;
  const currentShape = hasExactKeys(value, [
    'id',
    'response',
    'source',
    'suggestedActions',
    'title',
    'version',
  ]);
  const v5Shape = hasExactKeys(value, [
    'id',
    'response',
    'source',
    'suggestedActionSource',
    'suggestedActions',
    'title',
    'version',
  ]);
  const v6Shape = hasExactKeys(value, [
    'id',
    'planBOptionsDraft',
    'response',
    'source',
    'suggestedActionSource',
    'suggestedActions',
    'title',
    'version',
  ]);
  const legacyShape = hasExactKeys(value, [
    'id',
    'source',
    'suggestedActions',
    'title',
  ]);
  const useLegacyShape = schemaVersion === 1 && legacyShape && !currentShape;
  if (schemaVersion >= 6 && !v6Shape) return false;
  if (schemaVersion >= 4 && schemaVersion < 6 && !v5Shape) return false;
  if (schemaVersion >= 2 && schemaVersion < 4 && !currentShape) return false;
  if (schemaVersion === 1 && !currentShape && !useLegacyShape) return false;
  if (
    !addUniqueId(value.id, ids) ||
    (value.source !== 'agent' && value.source !== 'human') ||
    !isBoundedString(value.title, 1, 120) ||
    !Array.isArray(value.suggestedActions) ||
    value.suggestedActions.length > 5 ||
    (value.source === 'agent' && value.suggestedActions.length === 0) ||
    !value.suggestedActions.every((action) =>
      isBoundedString(action, 1, 1200),
    ) ||
    textLength((value.suggestedActions as string[]).join('')) > 4800
  ) {
    return false;
  }
  if (useLegacyShape) return true;
  if (schemaVersion >= 4) {
    const suggestedActionSource = value.suggestedActionSource;
    if (
      (suggestedActionSource !== 'agent' &&
        suggestedActionSource !== 'human' &&
        suggestedActionSource !== null) ||
      (value.suggestedActions.length === 0
        ? suggestedActionSource !== null
        : suggestedActionSource === null)
    ) {
      return false;
    }
  }
  if (schemaVersion >= 6) {
    const planBOptionsDraft = value.planBOptionsDraft;
    if (
      planBOptionsDraft !== null &&
      (!Array.isArray(planBOptionsDraft) ||
        planBOptionsDraft.length > 5 ||
        !planBOptionsDraft.every((option) =>
          isBoundedString(option, 1, 1200),
        ) ||
        textLength((planBOptionsDraft as string[]).join('')) > 4800)
    ) {
      return false;
    }
  }
  return (
    isVersion(value.version) && validateStoredCaseResponse(value.response)
  );
}

function validateStoredTag(
  value: unknown,
  anchorItemId: string,
  ids: Set<string>,
  schemaVersion: StoredSchemaVersion = 6,
): boolean {
  if (!isRecord(value)) return false;
  const v4Shape = hasExactKeys(value, [
    'anchorItemId',
    'basedOnItemVersion',
    'basedOnProjectVersion',
    'cases',
    'id',
    'lifecycle',
    'needsRecheck',
    'question',
    'rationale',
    'source',
    'summary',
    'version',
  ]);
  const v5Shape = hasExactKeys(value, [
    'anchorItemId',
    'basedOnItemVersion',
    'basedOnProjectVersion',
    'cases',
    'id',
    'impact',
    'lifecycle',
    'needsRecheck',
    'question',
    'rationale',
    'source',
    'summary',
    'version',
  ]);
  const legacyShape = hasExactKeys(value, [
    'anchorItemId',
    'cases',
    'id',
    'needsRecheck',
    'question',
    'rationale',
    'source',
    'summary',
    'version',
  ]);
  const basicShape = hasExactKeys(value, [
    'anchorItemId',
    'cases',
    'id',
    'question',
    'rationale',
    'source',
    'summary',
  ]);
  const useBasicShape = schemaVersion === 1 && basicShape && !legacyShape;
  const useLegacyShape =
    schemaVersion < 3 && legacyShape && !v4Shape;
  if (schemaVersion >= 5 && !v5Shape) return false;
  if (schemaVersion === 4 && !v4Shape) return false;
  if (schemaVersion === 3 && !v4Shape) return false;
  if (schemaVersion === 2 && !legacyShape) return false;
  if (schemaVersion === 1 && !v4Shape && !useLegacyShape && !useBasicShape) {
    return false;
  }
  if (
    !addUniqueId(value.id, ids) ||
    value.anchorItemId !== anchorItemId ||
    (value.source !== 'agent' && value.source !== 'human') ||
    !isBoundedString(value.question, 1, 180) ||
    !isBoundedString(value.rationale, 1, 400) ||
    !isBoundedString(value.summary, 1, 400) ||
    !Array.isArray(value.cases) ||
    value.cases.length < 1 ||
    value.cases.length > 6 ||
    !value.cases.every((caseItem) =>
      validateStoredCase(caseItem, ids, schemaVersion),
    )
  ) {
    return false;
  }
  if (!useBasicShape && !isVersion(value.version)) return false;
  if (!useBasicShape && typeof value.needsRecheck !== 'boolean') return false;
  if (
    (v4Shape || v5Shape) &&
    (value.lifecycle !== 'active' && value.lifecycle !== 'resolved')
  ) {
    return false;
  }
  if (
    (v4Shape || v5Shape) &&
    (!isVersion(value.basedOnItemVersion) ||
      !isVersion(value.basedOnProjectVersion) ||
      (value.lifecycle === 'resolved' && value.needsRecheck))
  ) {
    return false;
  }
  if (schemaVersion >= 5 && !validateStoredImpact(value.impact)) {
    return false;
  }

  const cases = value.cases as MoshimoCase[];
  const tagText = [
    value.question,
    value.rationale,
    value.summary,
    value.impact && isRecord(value.impact) && typeof value.impact.penalty === 'string'
      ? value.impact.penalty
      : '',
    ...cases.flatMap((caseItem) => [
      caseItem.title,
      ...caseItem.suggestedActions,
      ...(caseItem.planBOptionsDraft ?? []),
    ]),
  ].join('');
  return textLength(tagText) <= 6000;
}

function validateStoredItem(
  value: unknown,
  ids: Set<string>,
  schemaVersion: StoredSchemaVersion = 6,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'body',
      'id',
      'status',
      'tags',
      'timeOrCue',
      'title',
      'version',
    ]) ||
    !addUniqueId(value.id, ids) ||
    !isVersion(value.version) ||
    !isBoundedString(value.timeOrCue, 0, 40) ||
    !isBoundedString(value.title, 1, 120) ||
    !isBoundedString(value.body, 0, 1200) ||
    (value.status !== 'scheduled' && value.status !== 'draft') ||
    !Array.isArray(value.tags)
  ) {
    return false;
  }

  return value.tags.every((tag) =>
    validateStoredTag(tag, value.id as string, ids, schemaVersion),
  );
}

function validateStoredGap(
  value: unknown,
  anchorIds: Set<string>,
  ids: Set<string>,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'body',
      'id',
      'insertAfterItemId',
      'source',
      'status',
      'timeOrCue',
      'title',
    ]) ||
    !addUniqueId(value.id, ids) ||
    value.source !== 'agent' ||
    (value.insertAfterItemId !== null &&
      (typeof value.insertAfterItemId !== 'string' ||
        !anchorIds.has(value.insertAfterItemId))) ||
    !isBoundedString(value.timeOrCue, 0, 40) ||
    !isBoundedString(value.title, 1, 120) ||
    !isBoundedString(value.body, 1, 1200) ||
    (value.status !== 'proposed' &&
      value.status !== 'accepted' &&
      value.status !== 'ignored')
  ) {
    return false;
  }
  return true;
}

function validateStoredReviewRequest(
  value: unknown,
  project: ProjectState,
  ids: Set<string>,
  schemaVersion: StoredSchemaVersion = 6,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'kind',
      'ownerId',
      'ownerVersion',
      'projectVersion',
    ]) ||
    !addUniqueId(value.id, ids) ||
    !isReviewKind(value.kind) ||
    !isBoundedString(value.ownerId, 1, 160) ||
    !isVersion(value.ownerVersion) ||
    !isVersion(value.projectVersion) ||
    value.projectVersion !== project.version
  ) {
    return false;
  }

  if (
    value.kind === 'project_plan' ||
    value.kind === 'timeline_whatifs' ||
    value.kind === 'timeline_gaps'
  ) {
    if (value.kind === 'project_plan' && project.timeline.length !== 0) {
      return false;
    }
    return (
      value.ownerId === project.id && value.ownerVersion === project.version
    );
  }

  for (const item of project.timeline) {
    if (value.kind === 'item_whatifs' && value.ownerId === item.id) {
      return value.ownerVersion === item.version;
    }
    for (const tag of item.tags) {
      const tagIsActive =
        schemaVersion < 3 || tag.lifecycle === 'active';
      if (value.kind === 'tag_cases' && value.ownerId === tag.id) {
        return tagIsActive && value.ownerVersion === tag.version;
      }
      if (value.kind === 'case_actions' && tagIsActive) {
        const caseItem = tag.cases.find((entry) => entry.id === value.ownerId);
        if (caseItem) return value.ownerVersion === caseItem.version;
      }
    }
  }
  return false;
}

function validateStoredRecheckRequest(
  value: unknown,
  project: ProjectState,
  ids: Set<string>,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'projectVersion', 'tags']) ||
    !addUniqueId(value.id, ids) ||
    !isVersion(value.projectVersion) ||
    value.projectVersion !== project.version ||
    !Array.isArray(value.tags) ||
    value.tags.length < 1 ||
    value.tags.length > 5
  ) {
    return false;
  }

  const seenTagIds = new Set<string>();
  for (const rawTag of value.tags) {
    if (
      !isRecord(rawTag) ||
      !hasExactKeys(rawTag, ['itemId', 'itemVersion', 'tagId', 'tagVersion']) ||
      !isBoundedString(rawTag.tagId, 1, 160) ||
      !isBoundedString(rawTag.itemId, 1, 160) ||
      !isVersion(rawTag.tagVersion) ||
      !isVersion(rawTag.itemVersion) ||
      seenTagIds.has(rawTag.tagId)
    ) {
      return false;
    }
    seenTagIds.add(rawTag.tagId);
    const item = project.timeline.find((entry) => entry.id === rawTag.itemId);
    const tag = item?.tags.find((entry) => entry.id === rawTag.tagId);
    if (
      !item ||
      !tag ||
      tag.lifecycle !== 'active' ||
      !tag.needsRecheck ||
      tag.version !== rawTag.tagVersion ||
      item.version !== rawTag.itemVersion ||
      tag.anchorItemId !== item.id
    ) {
      return false;
    }
  }
  return true;
}

function validateStoredProject(
  value: unknown,
  ids: Set<string>,
  allowActiveReviewRequest: boolean,
  minimumTimelineItems = 0,
  schemaVersion: StoredSchemaVersion = 6,
): value is ProjectState {
  if (!isRecord(value)) return false;

  const basicV1Shape =
    schemaVersion === 1 &&
    hasExactKeys(value, ['description', 'id', 'timeline', 'title', 'version']);
  if (basicV1Shape) {
    if (
      !addUniqueId(value.id, ids) ||
      !isVersion(value.version) ||
      !isBoundedString(value.title, 1, 120) ||
      !isBoundedString(value.description, 0, 1000) ||
      !Array.isArray(value.timeline) ||
      value.timeline.length < minimumTimelineItems ||
      value.timeline.length > 30 ||
      !value.timeline.every((item) => validateStoredItem(item, ids, 1))
    ) {
      return false;
    }
    return true;
  }

  const legacyShape = hasExactKeys(value, [
    'activeReviewRequest',
    'description',
    'gapSuggestions',
    'id',
    'timeline',
    'title',
    'version',
    'viewMode',
  ]);
  const currentShape = hasExactKeys(value, [
    'activeRecheckRequest',
    'activeReviewRequest',
    'description',
    'gapSuggestions',
    'id',
    'timeline',
    'title',
    'version',
    'viewMode',
  ]);
  if (schemaVersion >= 3 ? !currentShape : !legacyShape) return false;
  if (
    !addUniqueId(value.id, ids) ||
    !isVersion(value.version) ||
    !isBoundedString(value.title, 1, 120) ||
    !isBoundedString(value.description, 0, 1000) ||
    !isViewMode(value.viewMode) ||
    !Array.isArray(value.timeline) ||
    value.timeline.length < minimumTimelineItems ||
    value.timeline.length > 30 ||
    !value.timeline.every((item) =>
      validateStoredItem(item, ids, schemaVersion),
    ) ||
    !Array.isArray(value.gapSuggestions)
  ) {
    return false;
  }

  const project = value as unknown as ProjectState;
  const itemIds = new Set(project.timeline.map((item) => item.id));
  if (
    !project.gapSuggestions.every((gap) =>
      validateStoredGap(gap, itemIds, ids),
    )
  ) {
    return false;
  }

  if (project.activeReviewRequest !== null) {
    if (
      !allowActiveReviewRequest ||
      !validateStoredReviewRequest(
        project.activeReviewRequest,
        project,
        ids,
        schemaVersion,
      )
    ) {
      return false;
    }
  }
  if (
    project.activeReviewRequest !== null &&
    project.activeRecheckRequest !== null
  ) {
    return false;
  }
  if (schemaVersion >= 3 && project.activeRecheckRequest !== null) {
    return (
      allowActiveReviewRequest &&
      validateStoredRecheckRequest(project.activeRecheckRequest, project, ids)
    );
  }
  return schemaVersion < 3 || project.activeRecheckRequest === null;
}

function validateStoredUndoDelete(
  value: unknown,
  ids: Set<string>,
  schemaVersion: StoredSchemaVersion = 6,
): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['gapSuggestions', 'index', 'item']) ||
    !Number.isSafeInteger(value.index) ||
    Number(value.index) < 0 ||
    Number(value.index) > 30 ||
    !Array.isArray(value.gapSuggestions) ||
    !validateStoredItem(value.item, ids, schemaVersion)
  ) {
    return false;
  }

  const deletedItem = value.item as TimelineItem;
  const deletedAnchor = new Set([deletedItem.id]);
  return value.gapSuggestions.every(
    (gap) =>
      validateStoredGap(gap, deletedAnchor, ids) &&
      (gap as PlanGapSuggestion).insertAfterItemId === deletedItem.id,
  );
}

interface LegacyAppState {
  schemaVersion: 1;
  project: unknown;
  undoDelete: unknown;
}

interface StoredAppStateV2 {
  schemaVersion: 2;
  project: unknown;
  projects: unknown[];
  undoDelete: unknown;
}

interface StoredAppStateV3 {
  schemaVersion: 3;
  project: unknown;
  projects: unknown[];
  undoDelete: unknown;
}

interface StoredAppStateV4 {
  schemaVersion: 4;
  project: unknown;
  projects: unknown[];
  undoDelete: unknown;
}

interface StoredAppStateV5 {
  schemaVersion: 5;
  project: unknown;
  projects: unknown[];
  undoDelete: unknown;
}

function validateLegacyAppState(value: unknown): value is LegacyAppState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['project', 'schemaVersion', 'undoDelete']) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.project)
  ) {
    return false;
  }

  const ids = new Set<string>();
  return (
    validateStoredProject(value.project, ids, true, 1, 1) &&
    validateStoredUndoDelete(value.undoDelete, ids, 1)
  );
}

function validateStoredAppStateV2(value: unknown): value is StoredAppStateV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'project',
      'projects',
      'schemaVersion',
      'undoDelete',
    ]) ||
    value.schemaVersion !== 2 ||
    !isRecord(value.project) ||
    !Array.isArray(value.projects) ||
    value.projects.length > MAX_PROJECTS - 1
  ) {
    return false;
  }

  const ids = new Set<string>();
  if (!validateStoredProject(value.project, ids, true, 0, 2)) return false;
  if (
    !value.projects.every((project) =>
      validateStoredProject(project, ids, false, 0, 2),
    )
  ) {
    return false;
  }

  return validateStoredUndoDelete(value.undoDelete, ids, 2);
}

function validateStoredAppState(
  value: unknown,
  schemaVersion: 3 | 4 | 5 | 6,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'project',
      'projects',
      'schemaVersion',
      'undoDelete',
    ]) ||
    value.schemaVersion !== schemaVersion ||
    !isRecord(value.project) ||
    !Array.isArray(value.projects) ||
    value.projects.length > MAX_PROJECTS - 1
  ) {
    return false;
  }

  const ids = new Set<string>();
  if (!validateStoredProject(value.project, ids, true, 0, schemaVersion)) {
    return false;
  }
  if (
    !value.projects.every((project) =>
      validateStoredProject(project, ids, false, 0, schemaVersion),
    )
  ) {
    return false;
  }

  return validateStoredUndoDelete(value.undoDelete, ids, schemaVersion);
}

function validateStoredAppStateV3(value: unknown): value is StoredAppStateV3 {
  return validateStoredAppState(value, 3);
}

function validateStoredAppStateV4(value: unknown): value is StoredAppStateV4 {
  return validateStoredAppState(value, 4);
}

function validateStoredAppStateV5(value: unknown): value is StoredAppStateV5 {
  return validateStoredAppState(value, 5);
}

export function validateAppState(value: unknown): value is AppState {
  return validateStoredAppState(value, 6);
}

function migrateCaseToV6(value: Record<string, unknown>): MoshimoCase {
  const source = value.source as TagSource;
  const suggestedActions = [...(value.suggestedActions as string[])];
  const response =
    'response' in value ? (value.response as CaseResponse | null) : null;
  const version = typeof value.version === 'number' ? value.version : 1;
  const legacyHumanCaseWasFilledByAgent =
    source === 'human' &&
    (suggestedActions.length > 1 || (version > 1 && response === null));
  return {
    id: value.id as string,
    version,
    source,
    title: value.title as string,
    suggestedActions,
    suggestedActionSource:
      suggestedActions.length === 0
        ? null
        : source === 'agent' || legacyHumanCaseWasFilledByAgent
          ? 'agent'
          : 'human',
    planBOptionsDraft:
      'planBOptionsDraft' in value
        ? value.planBOptionsDraft === null
          ? null
          : [...(value.planBOptionsDraft as string[])]
        : null,
    response,
  };
}

function migrateTagToV6(
  value: Record<string, unknown>,
  itemId: string,
  itemVersion: number,
  projectVersion: number,
): MoshimoTag {
  return {
    id: value.id as string,
    version: typeof value.version === 'number' ? value.version : 1,
    anchorItemId: itemId,
    source: value.source as TagSource,
    needsRecheck:
      typeof value.needsRecheck === 'boolean' ? value.needsRecheck : false,
    lifecycle: value.lifecycle === 'resolved' ? 'resolved' : 'active',
    basedOnItemVersion:
      typeof value.basedOnItemVersion === 'number'
        ? value.basedOnItemVersion
        : itemVersion,
    basedOnProjectVersion:
      typeof value.basedOnProjectVersion === 'number'
        ? value.basedOnProjectVersion
        : projectVersion,
    question: value.question as string,
    rationale: value.rationale as string,
    summary: value.summary as string,
    impact:
      'impact' in value ? (value.impact as TagImpact | null) : null,
    cases: (value.cases as Record<string, unknown>[]).map(migrateCaseToV6),
  };
}

function migrateItemToV6(
  value: Record<string, unknown>,
  projectVersion: number,
): TimelineItem {
  const itemVersion = typeof value.version === 'number' ? value.version : 1;
  const itemId = value.id as string;
  return {
    id: itemId,
    version: itemVersion,
    timeOrCue: value.timeOrCue as string,
    title: value.title as string,
    body: value.body as string,
    status: value.status === 'draft' ? 'draft' : 'scheduled',
    tags: (value.tags as Record<string, unknown>[]).map((tag) =>
      migrateTagToV6(tag, itemId, itemVersion, projectVersion),
    ),
  };
}

function migrateProjectToV6(value: Record<string, unknown>): ProjectState {
  const projectVersion = typeof value.version === 'number' ? value.version : 1;
  const projectId = value.id as string;
  const timeline = Array.isArray(value.timeline)
    ? (value.timeline as Record<string, unknown>[]).map((item) =>
        migrateItemToV6(item, projectVersion),
      )
    : [];
  return {
    id: projectId,
    version: projectVersion,
    title: value.title as string,
    description: value.description as string,
    viewMode: value.viewMode === 'final' ? 'final' : 'editing',
    timeline,
    gapSuggestions: Array.isArray(value.gapSuggestions)
      ? (value.gapSuggestions as PlanGapSuggestion[]).map((gap) => ({ ...gap }))
      : [],
    // Legacy review/recheck requests are intentionally not replayed after a
    // schema migration. Their owner/version snapshots may no longer describe
    // the migrated state and the old flow is dormant in the direct-tool model.
    activeReviewRequest: null,
    activeRecheckRequest: null,
  };
}

function migrateUndoDeleteToV6(
  value: unknown,
  projectVersion: number,
): DeletedTimelineItem | null {
  if (!isRecord(value) || !isRecord(value.item)) return null;
  const item = migrateItemToV6(value.item, projectVersion);
  const gapSuggestions = Array.isArray(value.gapSuggestions)
    ? (value.gapSuggestions as PlanGapSuggestion[]).map((gap) => ({ ...gap }))
    : [];
  return {
    item,
    index: typeof value.index === 'number' ? value.index : 0,
    gapSuggestions,
  };
}

function migrateLegacyState(value: LegacyAppState): AppState {
  return {
    schemaVersion: 6,
    project: migrateProjectToV6(value.project as Record<string, unknown>),
    projects: [],
    undoDelete: migrateUndoDeleteToV6(
      value.undoDelete,
      (value.project as Record<string, unknown>).version as number,
    ),
  };
}

function migrateV2State(value: StoredAppStateV2): AppState {
  const project = migrateProjectToV6(value.project as Record<string, unknown>);
  return {
    schemaVersion: 6,
    project,
    projects: value.projects.map((storedProject) =>
      migrateProjectToV6(storedProject as Record<string, unknown>),
    ),
    undoDelete: migrateUndoDeleteToV6(value.undoDelete, project.version),
  };
}

function migrateV3State(value: StoredAppStateV3): AppState {
  const project = migrateProjectToV6(value.project as Record<string, unknown>);
  return {
    schemaVersion: 6,
    project,
    projects: value.projects.map((storedProject) =>
      migrateProjectToV6(storedProject as Record<string, unknown>),
    ),
    undoDelete: migrateUndoDeleteToV6(value.undoDelete, project.version),
  };
}

function migrateV4State(value: StoredAppStateV4): AppState {
  const project = migrateProjectToV6(value.project as Record<string, unknown>);
  return {
    schemaVersion: 6,
    project,
    projects: value.projects.map((storedProject) =>
      migrateProjectToV6(storedProject as Record<string, unknown>),
    ),
    undoDelete: migrateUndoDeleteToV6(value.undoDelete, project.version),
  };
}

function migrateV5State(value: StoredAppStateV5): AppState {
  const project = migrateProjectToV6(value.project as Record<string, unknown>);
  return {
    schemaVersion: 6,
    project,
    projects: value.projects.map((storedProject) =>
      migrateProjectToV6(storedProject as Record<string, unknown>),
    ),
    undoDelete: migrateUndoDeleteToV6(value.undoDelete, project.version),
  };
}

function recovery(
  reason: Extract<PersistenceResult, { kind: 'recovery' }>['reason'],
  message: string,
): PersistenceResult {
  return { kind: 'recovery', reason, message };
}

function removeLegacyDebugProject(value: AppState): {
  value: AppState;
  changed: boolean;
} {
  const projects = value.projects.filter(
    (project) => project.id !== LEGACY_DEBUG_PROJECT_ID,
  );
  if (value.project.id !== LEGACY_DEBUG_PROJECT_ID) {
    if (projects.length === value.projects.length) {
      return { value: { ...value, undoDelete: null }, changed: false };
    }
    return {
      value: { ...value, projects, undoDelete: null },
      changed: true,
    };
  }

  if (projects.length === 0) {
    return { value: bootstrapState(), changed: true };
  }

  const [project, ...remainingProjects] = projects;
  return {
    value: {
      schemaVersion: 6,
      project,
      projects: remainingProjects,
      undoDelete: null,
    },
    changed: true,
  };
}

function activateStoredState(value: AppState): PersistenceResult {
  const cleaned = removeLegacyDebugProject(value);
  if (cleaned.changed && persistenceStorage) {
    try {
      if (
        isEmptyWorkspaceProject(cleaned.value.project) &&
        cleaned.value.projects.length === 0
      ) {
        persistenceStorage.removeItem(STORAGE_KEY);
      } else {
        persistenceStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned.value));
      }
    } catch {
      console.warn(
        'local.cleanup: legacy debug Project could not be removed from saved data.',
      );
    }
  }

  state = cleaned.value;
  sequence = 0;
  persistenceMode = 'ready';
  listeners.forEach((listener) => listener());
  return {
    kind: 'ready',
    source:
      cleaned.changed && isEmptyWorkspaceProject(state.project)
        ? 'empty'
        : 'stored',
  };
}

export function initializePersistence(
  getStorage: () => StoragePort,
  options?: PersistenceOptions,
): PersistenceResult {
  let stored: string | null;
  clearHistory();
  persistenceMode = 'recovery';
  persistenceStorage = null;
  try {
    persistenceStorage = getStorage();
    stored = persistenceStorage.getItem(STORAGE_KEY);
  } catch {
    return recovery(
      'read_failed',
      'local.load: saved Plan data could not be read.',
    );
  }

  if (stored === null) {
    state = bootstrapState(options);
    sequence = 0;
    persistenceMode = 'ready';
    listeners.forEach((listener) => listener());
    return {
      kind: 'ready',
      source: options?.bootstrapState ? 'seed' : 'empty',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return recovery('corrupt', 'local.load: saved Plan data is not valid JSON.');
  }

  if (isRecord(parsed) && parsed.schemaVersion === 1) {
    if (!validateLegacyAppState(parsed)) {
      return recovery(
        'invalid_shape',
        'local.load: saved Plan data has an invalid structure.',
      );
    }
    return activateStoredState(migrateLegacyState(parsed));
  }
  if (!isRecord(parsed) || typeof parsed.schemaVersion !== 'number') {
    return recovery(
      'invalid_shape',
      'local.load: saved Plan data has an invalid structure.',
    );
  }
  if (parsed.schemaVersion === 2) {
    if (!validateStoredAppStateV2(parsed)) {
      return recovery(
        'invalid_shape',
        'local.load: saved Plan data has an invalid structure.',
      );
    }
    return activateStoredState(migrateV2State(parsed));
  }
  if (parsed.schemaVersion === 3) {
    if (!validateStoredAppStateV3(parsed)) {
      return recovery(
        'invalid_shape',
        'local.load: saved Plan data has an invalid structure.',
      );
    }
    return activateStoredState(migrateV3State(parsed));
  }
  if (parsed.schemaVersion === 4) {
    if (!validateStoredAppStateV4(parsed)) {
      return recovery(
        'invalid_shape',
        'local.load: saved Plan data has an invalid structure.',
      );
    }
    return activateStoredState(migrateV4State(parsed));
  }
  if (parsed.schemaVersion === 5) {
    if (!validateStoredAppStateV5(parsed)) {
      return recovery(
        'invalid_shape',
        'local.load: saved Plan data has an invalid structure.',
      );
    }
    return activateStoredState(migrateV5State(parsed));
  }
  if (parsed.schemaVersion !== 6) {
    return recovery(
      'unsupported_version',
      'local.load: this saved Plan uses an unsupported version.',
    );
  }
  if (!validateAppState(parsed)) {
    return recovery(
      'invalid_shape',
      'local.load: saved Plan data has an invalid structure.',
    );
  }

  return activateStoredState(parsed);
}

export function resetPersistence(
  getStorage?: () => StoragePort,
  options?: PersistenceOptions,
): PersistenceResult {
  clearHistory();
  persistenceMode = 'recovery';
  try {
    const storage = getStorage ? getStorage() : persistenceStorage;
    if (!storage) throw new Error('Storage is not available.');
    storage.removeItem(STORAGE_KEY);
    persistenceStorage = storage;
  } catch {
    return recovery(
      'reset_failed',
      'local.reset: local Plan data could not be removed.',
    );
  }

  state = bootstrapState(options);
  sequence = 0;
  persistenceMode = 'ready';
  listeners.forEach((listener) => listener());
  return { kind: 'ready', source: 'reset' };
}

function failure(
  code: Extract<CommandResult, { ok: false }>['code'],
  message: string,
  retryable: boolean,
): CommandResult {
  return { ok: false, code, message, retryable };
}

function noChanges(): CommandResult {
  return {
    ok: true,
    code: 'NO_CHANGES',
    affectedIds: [],
    version: state.project.version,
  };
}

function publish(next: AppState, affectedIds: string[]): CommandResult {
  if (persistenceMode !== 'ready' || !persistenceStorage) {
    return failure(
      'SAVE_FAILED',
      'state.save: local persistence needs recovery before changes can be saved.',
      true,
    );
  }

  const durableState: AppState = { ...next, undoDelete: null };
  if (!validateAppState(durableState)) {
    return failure(
      'SAVE_FAILED',
      'state.save: the next Plan state failed validation.',
      false,
    );
  }
  try {
    persistenceStorage.setItem(STORAGE_KEY, JSON.stringify(durableState));
  } catch {
    return failure(
      'SAVE_FAILED',
      'state.save: this change could not be saved locally.',
      true,
    );
  }

  undoHistory = [...undoHistory, cloneHistoryState(state)].slice(-HISTORY_LIMIT);
  redoHistory = [];
  state = next;
  listeners.forEach((listener) => listener());
  return {
    ok: true,
    code: 'OK',
    affectedIds,
    version: state.project.version,
  };
}

function historyProjectRevision(
  target: ProjectState,
  current: ProjectState | undefined,
): ProjectState {
  const projectVersion = Math.max(target.version, current?.version ?? 0) + 1;
  const currentItemById = new Map(
    (current?.timeline ?? []).map((item) => [item.id, item] as const),
  );
  const timeline = target.timeline.map((item) => {
    const currentItem = currentItemById.get(item.id);
    const itemVersion = Math.max(item.version, currentItem?.version ?? 0) + 1;
    const currentTagById = new Map(
      (currentItem?.tags ?? []).map((tag) => [tag.id, tag] as const),
    );
    const tags = item.tags.map((tag) => {
      const currentTag = currentTagById.get(tag.id);
      const currentCaseById = new Map(
        (currentTag?.cases ?? []).map((caseItem) => [caseItem.id, caseItem] as const),
      );
      return {
        ...tag,
        version: Math.max(tag.version, currentTag?.version ?? 0) + 1,
        basedOnItemVersion: itemVersion,
        basedOnProjectVersion: projectVersion,
        cases: tag.cases.map((caseItem) => ({
          ...caseItem,
          version:
            Math.max(
              caseItem.version,
              currentCaseById.get(caseItem.id)?.version ?? 0,
            ) + 1,
        })),
      };
    });
    return { ...item, version: itemVersion, tags };
  });

  return {
    ...target,
    version: projectVersion,
    timeline,
    activeReviewRequest: null,
    activeRecheckRequest: null,
  };
}

function historyRevision(target: AppState): AppState {
  const currentProjects = new Map(
    [state.project, ...state.projects].map((project) => [project.id, project] as const),
  );
  return {
    ...cloneHistoryState(target),
    project: historyProjectRevision(
      target.project,
      currentProjects.get(target.project.id),
    ),
    projects: target.projects.map((project) =>
      historyProjectRevision(project, currentProjects.get(project.id)),
    ),
    undoDelete: null,
  };
}

function restoreHistory(direction: 'undo' | 'redo'): CommandResult {
  if (persistenceMode !== 'ready' || !persistenceStorage) {
    return failure(
      'SAVE_FAILED',
      `history.${direction}: local persistence needs recovery before changes can be restored.`,
      true,
    );
  }
  const source = direction === 'undo' ? undoHistory : redoHistory;
  if (source.length === 0) {
    return failure(
      'INVALID_STATE',
      `history.${direction}: there is nothing to ${direction}.`,
      false,
    );
  }

  const next = historyRevision(source[source.length - 1]);
  if (!validateAppState(next)) {
    return failure(
      'SAVE_FAILED',
      `history.${direction}: the restored state failed validation.`,
      false,
    );
  }
  try {
    persistenceStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    return failure(
      'SAVE_FAILED',
      `history.${direction}: the restored state could not be saved locally.`,
      true,
    );
  }

  const current = cloneHistoryState(state);
  if (direction === 'undo') {
    undoHistory = undoHistory.slice(0, -1);
    redoHistory = [...redoHistory, current].slice(-HISTORY_LIMIT);
  } else {
    redoHistory = redoHistory.slice(0, -1);
    undoHistory = [...undoHistory, current].slice(-HISTORY_LIMIT);
  }
  state = next;
  listeners.forEach((listener) => listener());
  return {
    ok: true,
    code: 'OK',
    affectedIds: [next.project.id],
    version: next.project.version,
  };
}

function validateTimelineText(
  operation:
    | 'timeline.add'
    | 'timeline.update'
    | 'review.project_plan.apply',
  timeOrCueValue: string,
  titleValue: string,
  bodyValue: string,
):
  | { ok: true; timeOrCue: string; title: string; body: string }
  | { ok: false; result: CommandResult } {
  const timeOrCue = clean(timeOrCueValue);
  const title = clean(titleValue);
  const body = clean(bodyValue);

  if (Array.from(title).length < 1 || Array.from(title).length > 120) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        `${operation}: title must be 1–120 characters.`,
        true,
      ),
    };
  }
  if (Array.from(body).length > 1200 || Array.from(timeOrCue).length > 40) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        `${operation}: plan text or time cue is too long.`,
        true,
      ),
    };
  }

  return { ok: true, timeOrCue, title, body };
}

type MutationValidation<T> =
  | { ok: true; value: T }
  | { ok: false; result: CommandResult };

function normalizeImpactInput(
  value: TagImpact | null,
  operation: string,
): MutationValidation<TagImpact | null> {
  const parsed = parseImpact(value);
  if (!parsed.ok) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        `${operation}: impact has an invalid rank, amount, currency, or penalty.`,
        true,
      ),
    };
  }
  if (parsed.value === null) return { ok: true, value: null };
  const penalty = clean(parsed.value.penalty);
  if (textLength(penalty) > 240) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        `${operation}: impact penalty must be at most 240 characters.`,
        true,
      ),
    };
  }
  return {
    ok: true,
    value: {
      rank: parsed.value.rank,
      expectedLossAmount: parsed.value.expectedLossAmount,
      currency: parsed.value.currency,
      penalty,
    },
  };
}

function sameImpact(left: TagImpact | null, right: TagImpact | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.rank === right.rank &&
      left.expectedLossAmount === right.expectedLossAmount &&
      left.currency === right.currency &&
      left.penalty === right.penalty)
  );
}

function validateAgentCases(
  cases: ProjectPlanCaseInput[],
  operation: string,
  maximum: number,
): MutationValidation<ProjectPlanCaseInput[]> {
  if (cases.length < 1) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        `${operation}: at least one Case is required.`,
        true,
      ),
    };
  }
  if (cases.length > maximum) {
    return {
      ok: false,
      result: failure(
        'LIMIT_EXCEEDED',
        `${operation}: at most ${maximum} Cases are supported.`,
        false,
      ),
    };
  }

  const normalized: ProjectPlanCaseInput[] = [];
  const titles = new Set<string>();
  for (const caseInput of cases) {
    const title = clean(caseInput.title);
    if (textLength(title) < 1 || textLength(title) > 120) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          `${operation}: Case title must be 1–120 characters.`,
          true,
        ),
      };
    }
    if (titles.has(title)) {
      return {
        ok: false,
        result: failure(
          'DUPLICATE',
          `${operation}: Case titles must be unique within a What if.`,
          false,
        ),
      };
    }
    titles.add(title);
    if (caseInput.suggestedActions.length < 1) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          `${operation}: every agent Case needs a suggested action.`,
          true,
        ),
      };
    }
    if (caseInput.suggestedActions.length > 5) {
      return {
        ok: false,
        result: failure(
          'LIMIT_EXCEEDED',
          `${operation}: each Case supports at most five suggested actions.`,
          false,
        ),
      };
    }
    const suggestedActions = caseInput.suggestedActions.map(clean);
    if (
      suggestedActions.some(
        (action) => textLength(action) < 1 || textLength(action) > 1200,
      ) ||
      textLength(suggestedActions.join('')) > 4800
    ) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          `${operation}: suggested action text is outside the allowed length.`,
          true,
        ),
      };
    }
    normalized.push({ title, suggestedActions });
  }
  return { ok: true, value: normalized };
}

function validateAgentTagText(
  input: {
    question: string;
    rationale: string;
    summary: string;
    impact: TagImpact | null;
    cases: ProjectPlanCaseInput[];
  },
  operation: string,
  maximumCases: number,
): MutationValidation<{
  question: string;
  rationale: string;
  summary: string;
  impact: TagImpact | null;
  cases: ProjectPlanCaseInput[];
}> {
  const question = clean(input.question);
  const rationale = clean(input.rationale);
  const summary = clean(input.summary);
  if (
    textLength(question) < 1 ||
    textLength(question) > 180 ||
    textLength(rationale) < 1 ||
    textLength(rationale) > 400 ||
    textLength(summary) < 1 ||
    textLength(summary) > 400
  ) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        `${operation}: What-if text is outside the allowed length.`,
        true,
      ),
    };
  }
  const impact = normalizeImpactInput(input.impact, operation);
  if (!impact.ok) return impact;
  const normalizedCases = validateAgentCases(input.cases, operation, maximumCases);
  if (!normalizedCases.ok) return normalizedCases;
  const tagText = [
    question,
    rationale,
    summary,
    impact.value?.penalty ?? '',
    ...normalizedCases.value.flatMap((caseInput) => [
      caseInput.title,
      ...caseInput.suggestedActions,
    ]),
  ].join('');
  if (textLength(tagText) > 6000) {
    return {
      ok: false,
      result: failure(
        'LIMIT_EXCEEDED',
        `${operation}: What-if text has reached its limit.`,
        false,
      ),
    };
  }
  return {
    ok: true,
    value: {
      question,
      rationale,
      summary,
      impact: impact.value,
      cases: normalizedCases.value,
    },
  };
}

function validateProjectPlanItems(
  items: ProjectPlanItemInput[],
):
  | { ok: true; items: ProjectPlanItemInput[] }
  | { ok: false; result: CommandResult } {
  if (items.length < 1) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        'review.project_plan.apply: at least one Timeline item is required.',
        true,
      ),
    };
  }
  if (items.length > 12) {
    return {
      ok: false,
      result: failure(
        'LIMIT_EXCEEDED',
        'review.project_plan.apply: a maximum of 12 Timeline items is supported.',
        false,
      ),
    };
  }

  const normalizedItems: ProjectPlanItemInput[] = [];
  for (const item of items) {
    const validatedItem = validateTimelineText(
      'review.project_plan.apply',
      item.timeOrCue,
      item.title,
      item.body,
    );
    if (!validatedItem.ok) return validatedItem;

    if (item.tags.length < 1) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          'review.project_plan.apply: every Timeline item needs a What if.',
          true,
        ),
      };
    }
    if (item.tags.length > 2) {
      return {
        ok: false,
        result: failure(
          'LIMIT_EXCEEDED',
          'review.project_plan.apply: each Timeline item supports at most two What ifs.',
          false,
        ),
      };
    }

    const normalizedTags: ProjectPlanTagInput[] = [];
    for (const tag of item.tags) {
      const question = clean(tag.question);
      const rationale = clean(tag.rationale);
      const summary = clean(tag.summary);
      if (
        textLength(question) < 1 ||
        textLength(question) > 180 ||
        textLength(rationale) < 1 ||
        textLength(rationale) > 400 ||
        textLength(summary) < 1 ||
        textLength(summary) > 400
      ) {
        return {
          ok: false,
          result: failure(
            'INVALID_INPUT',
            'review.project_plan.apply: What if text is outside the allowed length.',
            true,
          ),
        };
      }
      const impact = normalizeImpactInput(
        tag.impact,
        'review.project_plan.apply',
      );
      if (!impact.ok) return impact;
      if (tag.cases.length < 1) {
        return {
          ok: false,
          result: failure(
            'INVALID_INPUT',
            'review.project_plan.apply: every What if needs a Case.',
            true,
          ),
        };
      }
      if (tag.cases.length > 4) {
        return {
          ok: false,
          result: failure(
            'LIMIT_EXCEEDED',
            'review.project_plan.apply: each What if supports at most four Cases.',
            false,
          ),
        };
      }

      const normalizedCases: ProjectPlanCaseInput[] = [];
      const caseTitles = new Set<string>();
      for (const caseInput of tag.cases) {
        const title = clean(caseInput.title);
        if (textLength(title) < 1 || textLength(title) > 120) {
          return {
            ok: false,
            result: failure(
              'INVALID_INPUT',
              'review.project_plan.apply: Case title must be 1–120 characters.',
              true,
            ),
          };
        }
        if (caseTitles.has(title)) {
          return {
            ok: false,
            result: failure(
              'DUPLICATE',
              'review.project_plan.apply: Case titles must be unique within a What if.',
              false,
            ),
          };
        }
        caseTitles.add(title);
        if (caseInput.suggestedActions.length < 1) {
          return {
            ok: false,
            result: failure(
              'INVALID_INPUT',
              'review.project_plan.apply: every agent Case needs a suggested action.',
              true,
            ),
          };
        }
        if (caseInput.suggestedActions.length > 5) {
          return {
            ok: false,
            result: failure(
              'LIMIT_EXCEEDED',
              'review.project_plan.apply: each Case supports at most five suggested actions.',
              false,
            ),
          };
        }
        const suggestedActions = caseInput.suggestedActions.map(clean);
        if (
          suggestedActions.some(
            (action) => textLength(action) < 1 || textLength(action) > 1200,
          ) ||
          textLength(suggestedActions.join('')) > 4800
        ) {
          return {
            ok: false,
            result: failure(
              'INVALID_INPUT',
              'review.project_plan.apply: suggested action text is outside the allowed length.',
              true,
            ),
          };
        }
        normalizedCases.push({ title, suggestedActions });
      }

      const tagText = [
        question,
        rationale,
        summary,
        impact.value?.penalty ?? '',
        ...normalizedCases.flatMap((caseInput) => [
          caseInput.title,
          ...caseInput.suggestedActions,
        ]),
      ].join('');
      if (textLength(tagText) > 6000) {
        return {
          ok: false,
          result: failure(
            'LIMIT_EXCEEDED',
            'review.project_plan.apply: What if text has reached its limit.',
            false,
          ),
        };
      }
      normalizedTags.push({
        question,
        rationale,
        summary,
        impact: impact.value,
        cases: normalizedCases,
      });
    }

    normalizedItems.push({
      timeOrCue: validatedItem.timeOrCue,
      title: validatedItem.title,
      body: validatedItem.body,
      tags: normalizedTags,
    });
  }
  return { ok: true, items: normalizedItems };
}

type ReviewSuggestionValidation<T> =
  | { ok: true; value: T }
  | { ok: false; result: CommandResult };

function validateReviewSuggestionCases(
  cases: ReviewSuggestionCaseInput[],
  operation:
    | 'timeline_whatifs'
    | 'item_whatifs'
    | 'tag_cases'
    | 'recheck.replace',
): ReviewSuggestionValidation<ReviewSuggestionCaseInput[]> {
  if (cases.length < 1) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        `${operation}: at least one Case is required.`,
        true,
      ),
    };
  }
  if (cases.length > 6) {
    return {
      ok: false,
      result: failure(
        'LIMIT_EXCEEDED',
        `${operation}: at most six Cases may be proposed.`,
        false,
      ),
    };
  }

  const normalized: ReviewSuggestionCaseInput[] = [];
  for (const caseInput of cases) {
    const title = clean(caseInput.title);
    if (textLength(title) < 1 || textLength(title) > 120) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          `${operation}: Case title must be 1–120 characters.`,
          true,
        ),
      };
    }
    if (caseInput.suggestedActions.length < 1) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          `${operation}: every agent Case needs a suggested action.`,
          true,
        ),
      };
    }
    if (caseInput.suggestedActions.length > 5) {
      return {
        ok: false,
        result: failure(
          'LIMIT_EXCEEDED',
          `${operation}: each Case supports at most five suggested actions.`,
          false,
        ),
      };
    }

    const suggestedActions = caseInput.suggestedActions.map(clean);
    if (
      suggestedActions.some(
        (action) => textLength(action) < 1 || textLength(action) > 1200,
      )
    ) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          `${operation}: suggested action text is outside the allowed length.`,
          true,
        ),
      };
    }
    if (textLength(suggestedActions.join('')) > 4800) {
      return {
        ok: false,
        result: failure(
          'LIMIT_EXCEEDED',
          `${operation}: suggested action text has reached its limit.`,
          false,
        ),
      };
    }
    normalized.push({ title, suggestedActions });
  }
  return { ok: true, value: normalized };
}

function validateReviewSuggestionTags(
  tags: ReviewSuggestionTagInput[],
  operation: 'timeline_whatifs' | 'item_whatifs',
): ReviewSuggestionValidation<ReviewSuggestionTagInput[]> {
  if (tags.length < 1) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        `${operation}: at least one What if is required.`,
        true,
      ),
    };
  }
  if (tags.length > 5) {
    return {
      ok: false,
      result: failure(
        'LIMIT_EXCEEDED',
        `${operation}: at most five What ifs may be proposed.`,
        false,
      ),
    };
  }

  const normalized: ReviewSuggestionTagInput[] = [];
  for (const tagInput of tags) {
    const anchorItemId = clean(tagInput.anchorItemId);
    const question = clean(tagInput.question);
    const rationale = clean(tagInput.rationale);
    const summary = clean(tagInput.summary);
    if (!isBoundedString(anchorItemId, 1, 160)) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          `${operation}: Tag anchor must be a bounded item ID.`,
          true,
        ),
      };
    }
    if (
      textLength(question) < 1 ||
      textLength(question) > 180 ||
      textLength(rationale) < 1 ||
      textLength(rationale) > 400 ||
      textLength(summary) < 1 ||
      textLength(summary) > 400
    ) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          `${operation}: What if text is outside the allowed length.`,
          true,
        ),
      };
    }

    const validatedCases = validateReviewSuggestionCases(
      tagInput.cases,
      operation,
    );
    if (!validatedCases.ok) return validatedCases;
    const tagText = [
      question,
      rationale,
      summary,
      ...validatedCases.value.flatMap((caseInput) => [
        caseInput.title,
        ...caseInput.suggestedActions,
      ]),
    ].join('');
    if (textLength(tagText) > 6000) {
      return {
        ok: false,
        result: failure(
          'LIMIT_EXCEEDED',
          `${operation}: What if text has reached its limit.`,
          false,
        ),
      };
    }
    normalized.push({
      anchorItemId,
      question,
      rationale,
      summary,
      cases: validatedCases.value,
    });
  }
  return { ok: true, value: normalized };
}

function validateReviewSuggestionActions(
  suggestedActionsInput: string[],
): ReviewSuggestionValidation<string[]> {
  if (suggestedActionsInput.length < 1) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        'case_actions: at least one suggested action is required.',
        true,
      ),
    };
  }
  if (suggestedActionsInput.length > 5) {
    return {
      ok: false,
      result: failure(
        'LIMIT_EXCEEDED',
        'case_actions: at most five suggested actions are supported.',
        false,
      ),
    };
  }
  const suggestedActions = suggestedActionsInput.map(clean);
  if (
    suggestedActions.some(
      (action) => textLength(action) < 1 || textLength(action) > 1200,
    )
  ) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        'case_actions: suggested action text is outside the allowed length.',
        true,
      ),
    };
  }
  if (textLength(suggestedActions.join('')) > 4800) {
    return {
      ok: false,
      result: failure(
        'LIMIT_EXCEEDED',
        'case_actions: suggested action text has reached its limit.',
        false,
      ),
    };
  }
  return { ok: true, value: suggestedActions };
}

function validateReviewSuggestionGaps(
  gaps: ReviewSuggestionGapInput[],
): ReviewSuggestionValidation<ReviewSuggestionGapInput[]> {
  if (gaps.length > 3) {
    return {
      ok: false,
      result: failure(
        'LIMIT_EXCEEDED',
        'timeline_gaps: at most three gap suggestions may be proposed.',
        false,
      ),
    };
  }
  const normalized: ReviewSuggestionGapInput[] = [];
  for (const gapInput of gaps) {
    const insertAfterItemId =
      gapInput.insertAfterItemId === null
        ? null
        : clean(gapInput.insertAfterItemId);
    const timeOrCue = clean(gapInput.timeOrCue);
    const title = clean(gapInput.title);
    const body = clean(gapInput.body);
    if (
      (insertAfterItemId !== null &&
        !isBoundedString(insertAfterItemId, 1, 160)) ||
      textLength(timeOrCue) > 40 ||
      textLength(title) < 1 ||
      textLength(title) > 120 ||
      textLength(body) < 1 ||
      textLength(body) > 1200
    ) {
      return {
        ok: false,
        result: failure(
          'INVALID_INPUT',
          'timeline_gaps: gap text or anchor is outside the allowed length.',
          true,
        ),
      };
    }
    normalized.push({ insertAfterItemId, timeOrCue, title, body });
  }
  return { ok: true, value: normalized };
}

function makeReviewRequest(
  kind: ReviewKind,
  ownerId: string,
  ownerVersion: number,
  projectVersion: number,
): ReviewRequest {
  return {
    id: appId('review'),
    kind,
    ownerId,
    ownerVersion,
    projectVersion,
  };
}

function resolveReviewOwner(
  kind: ReviewKind,
  ownerId: string,
): { id: string; version: number } | null {
  if (
    kind === 'project_plan' ||
    kind === 'timeline_whatifs' ||
    kind === 'timeline_gaps'
  ) {
    return ownerId === state.project.id
      ? { id: state.project.id, version: state.project.version }
      : null;
  }

  for (const item of state.project.timeline) {
    if (kind === 'item_whatifs' && item.id === ownerId) {
      return { id: item.id, version: item.version };
    }
    for (const tag of item.tags) {
      if (kind === 'tag_cases' && tag.id === ownerId) {
        return tag.lifecycle === 'active'
          ? { id: tag.id, version: tag.version }
          : null;
      }
      if (kind === 'case_actions' && tag.lifecycle === 'active') {
        const caseItem = tag.cases.find((entry) => entry.id === ownerId);
        if (caseItem) return { id: caseItem.id, version: caseItem.version };
      }
    }
  }
  return null;
}

function isResolvedReviewOwner(kind: ReviewKind, ownerId: string): boolean {
  if (kind === 'tag_cases') {
    return state.project.timeline.some((item) =>
      item.tags.some((tag) => tag.id === ownerId && tag.lifecycle === 'resolved'),
    );
  }
  if (kind === 'case_actions') {
    return state.project.timeline.some((item) =>
      item.tags.some(
        (tag) =>
          tag.lifecycle === 'resolved' &&
          tag.cases.some((caseItem) => caseItem.id === ownerId),
      ),
    );
  }
  return false;
}

function validateReviewSuggestionRequest(
  payload: ReviewSuggestionsApplyPayload,
):
  | { ok: true; request: ReviewRequest; owner: { id: string; version: number } }
  | { ok: false; result: CommandResult } {
  const requestInput = payload.request;
  const request = state.project.activeReviewRequest;
  const requestId = clean(requestInput.id);
  if (!request || request.id !== requestId) {
    return {
      ok: false,
      result: failure(
        'NOT_FOUND',
        'review.suggestions.apply: active request was not found.',
        false,
      ),
    };
  }
  if (
    request.kind !== payload.kind ||
    requestInput.kind !== payload.kind
  ) {
    return {
      ok: false,
      result: failure(
        'INVALID_STATE',
        'review.suggestions.apply: active request is for another review.',
        true,
      ),
    };
  }

  const projectId = clean(payload.projectId);
  if (projectId !== state.project.id) {
    return {
      ok: false,
      result: failure(
        'NOT_FOUND',
        'review.suggestions.apply: Project was not found.',
        false,
      ),
    };
  }
  if (
    !isVersion(payload.projectVersion) ||
    !isVersion(requestInput.ownerVersion) ||
    !isVersion(requestInput.projectVersion)
  ) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        'review.suggestions.apply: request versions must be positive integers.',
        true,
      ),
    };
  }
  if (
    payload.projectVersion !== state.project.version ||
    request.projectVersion !== state.project.version ||
    requestInput.projectVersion !== state.project.version
  ) {
    return {
      ok: false,
      result: failure(
        'VERSION_CONFLICT',
        'review.suggestions.apply: Project or request version is stale.',
        true,
      ),
    };
  }
  if (requestInput.ownerVersion !== request.ownerVersion) {
    return {
      ok: false,
      result: failure(
        'VERSION_CONFLICT',
        'review.suggestions.apply: review scope version is stale.',
        true,
      ),
    };
  }
  if (clean(requestInput.ownerId) !== request.ownerId) {
    return {
      ok: false,
      result: failure(
        'INVALID_STATE',
        'review.suggestions.apply: review scope owner does not match the request.',
        true,
      ),
    };
  }

  const owner = resolveReviewOwner(payload.kind, request.ownerId);
  if (!owner) {
    return {
      ok: false,
      result: failure(
        'INVALID_STATE',
        'review.suggestions.apply: review scope is no longer available.',
        true,
      ),
    };
  }
  if (owner.version !== request.ownerVersion) {
    return {
      ok: false,
      result: failure(
        'VERSION_CONFLICT',
        'review.suggestions.apply: review scope version is stale.',
        true,
      ),
    };
  }
  return { ok: true, request, owner };
}

function makeAgentCase(input: ReviewSuggestionCaseInput): MoshimoCase {
  return {
    id: appId('case'),
    version: 1,
    source: 'agent',
    title: input.title,
    suggestedActions: [...input.suggestedActions],
    suggestedActionSource: 'agent',
    planBOptionsDraft: null,
    response: null,
  };
}

function applyReviewSuggestions(
  command: Extract<AppCommand, { type: 'review.suggestions.apply' }>,
): CommandResult {
  const payload = command.payload;
  const requestValidation = validateReviewSuggestionRequest(payload);
  if (!requestValidation.ok) return requestValidation.result;
  const { request } = requestValidation;

  if (
    payload.kind === 'timeline_whatifs' ||
    payload.kind === 'item_whatifs'
  ) {
    const validated = validateReviewSuggestionTags(payload.tags, payload.kind);
    if (!validated.ok) return validated.result;

    const tagsByAnchor = new Map<string, ReviewSuggestionTagInput[]>();
    const existingFingerprints = new Set<string>();
    const itemById = new Map(
      state.project.timeline.map((item) => [item.id, item]),
    );
    for (const item of state.project.timeline) {
      for (const tag of item.tags) {
        if (tag.lifecycle === 'active') {
          existingFingerprints.add(`${item.id}\u0000${tag.question}`);
        }
      }
    }
    const batchFingerprints = new Set<string>();
    for (const tagInput of validated.value) {
      const anchorItemId = tagInput.anchorItemId;
      if (!itemById.has(anchorItemId)) {
        return failure(
          'INVALID_STATE',
          'review.suggestions.apply: Tag anchor was not found in the current Plan.',
          true,
        );
      }
      if (
        payload.kind === 'item_whatifs' &&
        anchorItemId !== request.ownerId
      ) {
        return failure(
          'INVALID_STATE',
          'review.suggestions.apply: Tag anchor is outside the requested item.',
          true,
        );
      }
      const fingerprint = `${anchorItemId}\u0000${tagInput.question}`;
      if (
        existingFingerprints.has(fingerprint) ||
        batchFingerprints.has(fingerprint)
      ) {
        return failure(
          'DUPLICATE',
          'review.suggestions.apply: a What if already exists at this anchor.',
          false,
        );
      }
      batchFingerprints.add(fingerprint);
      const siblingTags = tagsByAnchor.get(anchorItemId) ?? [];
      siblingTags.push(tagInput);
      tagsByAnchor.set(anchorItemId, siblingTags);
    }

    const affectedIds: string[] = [];
    const addedTags = new Map<string, MoshimoTag[]>();
    for (const [anchorItemId, tagInputs] of tagsByAnchor) {
      const nextTags = tagInputs.map((tagInput) => {
        const cases = tagInput.cases.map(makeAgentCase);
        const tag: MoshimoTag = {
          id: appId('tag'),
          version: 1,
          anchorItemId,
          source: 'agent',
          needsRecheck: false,
          lifecycle: 'active',
          basedOnItemVersion:
            (itemById.get(anchorItemId)?.version ?? 0) + 1,
          basedOnProjectVersion: state.project.version + 1,
          question: tagInput.question,
          rationale: tagInput.rationale,
          summary: tagInput.summary,
          impact: null,
          cases,
        };
        affectedIds.push(tag.id, ...cases.map((caseItem) => caseItem.id));
        return tag;
      });
      addedTags.set(anchorItemId, nextTags);
    }

    const timeline = state.project.timeline.map((item) => {
      const nextTags = addedTags.get(item.id);
      if (!nextTags) return item;
      return {
        ...item,
        version: item.version + 1,
        tags: [...item.tags, ...nextTags],
      };
    });
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: state.project.version + 1,
          timeline,
          activeReviewRequest: null,
        },
      },
      [...affectedIds, request.id],
    );
  }

  if (payload.kind === 'tag_cases') {
    const validated = validateReviewSuggestionCases(payload.cases, payload.kind);
    if (!validated.ok) return validated.result;
    const tagId = clean(payload.tagId);
    if (tagId !== request.ownerId) {
      return failure(
        'INVALID_STATE',
        'review.suggestions.apply: Case scope is outside the requested What if.',
        true,
      );
    }

    let itemIndex = -1;
    let tagIndex = -1;
    for (const [nextItemIndex, item] of state.project.timeline.entries()) {
      const nextTagIndex = item.tags.findIndex((tag) => tag.id === tagId);
      if (nextTagIndex >= 0) {
        itemIndex = nextItemIndex;
        tagIndex = nextTagIndex;
        break;
      }
    }
    if (itemIndex < 0 || tagIndex < 0) {
      return failure(
        'INVALID_STATE',
        'review.suggestions.apply: What if scope is no longer available.',
        true,
      );
    }

    const currentItem = state.project.timeline[itemIndex];
    const currentTag = currentItem.tags[tagIndex];
    if (currentTag.lifecycle !== 'active') {
      return failure(
        'INVALID_STATE',
        'review.suggestions.apply: resolved What if history is read-only.',
        false,
      );
    }
    if (currentTag.cases.length + validated.value.length > 6) {
      return failure(
        'LIMIT_EXCEEDED',
        'review.suggestions.apply: this What if supports at most six Cases.',
        false,
      );
    }
    const existingTitles = new Set(
      currentTag.cases.map((caseItem) => caseItem.title),
    );
    const batchTitles = new Set<string>();
    for (const caseInput of validated.value) {
      if (
        existingTitles.has(caseInput.title) ||
        batchTitles.has(caseInput.title)
      ) {
        return failure(
          'DUPLICATE',
          'review.suggestions.apply: a Case title already exists in this What if.',
          false,
        );
      }
      batchTitles.add(caseInput.title);
    }
    const tagText = [
      currentTag.question,
      currentTag.rationale,
      currentTag.summary,
      ...currentTag.cases.flatMap((caseItem) => [
        caseItem.title,
        ...caseItem.suggestedActions,
        ...(caseItem.planBOptionsDraft ?? []),
      ]),
      ...validated.value.flatMap((caseInput) => [
        caseInput.title,
        ...caseInput.suggestedActions,
      ]),
    ].join('');
    if (textLength(tagText) > 6000) {
      return failure(
        'LIMIT_EXCEEDED',
        'review.suggestions.apply: What if text has reached its limit.',
        false,
      );
    }

    const cases = validated.value.map(makeAgentCase);
    const updatedTag: MoshimoTag = {
      ...currentTag,
      version: currentTag.version + 1,
      cases: [...currentTag.cases, ...cases],
    };
    const tags = [...currentItem.tags];
    tags[tagIndex] = updatedTag;
    const timeline = [...state.project.timeline];
    timeline[itemIndex] = {
      ...currentItem,
      version: currentItem.version + 1,
      tags,
    };
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: state.project.version + 1,
          timeline,
          activeReviewRequest: null,
        },
      },
      [tagId, ...cases.map((caseItem) => caseItem.id), request.id],
    );
  }

  if (payload.kind === 'case_actions') {
    const validated = validateReviewSuggestionActions(payload.suggestedActions);
    if (!validated.ok) return validated.result;
    const caseId = clean(payload.caseId);
    if (caseId !== request.ownerId) {
      return failure(
        'INVALID_STATE',
        'review.suggestions.apply: action scope is outside the requested Case.',
        true,
      );
    }

    let itemIndex = -1;
    let tagIndex = -1;
    let caseIndex = -1;
    for (const [nextItemIndex, item] of state.project.timeline.entries()) {
      for (const [nextTagIndex, tag] of item.tags.entries()) {
        const nextCaseIndex = tag.cases.findIndex(
          (caseItem) => caseItem.id === caseId,
        );
        if (nextCaseIndex >= 0) {
          itemIndex = nextItemIndex;
          tagIndex = nextTagIndex;
          caseIndex = nextCaseIndex;
          break;
        }
      }
      if (caseIndex >= 0) break;
    }
    if (itemIndex < 0 || tagIndex < 0 || caseIndex < 0) {
      return failure(
        'INVALID_STATE',
        'review.suggestions.apply: Case scope is no longer available.',
        true,
      );
    }

    const currentItem = state.project.timeline[itemIndex];
    const currentTag = currentItem.tags[tagIndex];
    if (currentTag.lifecycle !== 'active') {
      return failure(
        'INVALID_STATE',
        'review.suggestions.apply: resolved What if history is read-only.',
        false,
      );
    }
    const currentCase = currentTag.cases[caseIndex];
    if (
      currentCase.suggestedActions.length === validated.value.length &&
      currentCase.suggestedActions.every(
        (action, index) => action === validated.value[index],
      )
    ) {
      return failure(
        'DUPLICATE',
        'review.suggestions.apply: these suggested actions are already present.',
        false,
      );
    }
    const replacementTagText = [
      currentTag.question,
      currentTag.rationale,
      currentTag.summary,
      ...currentTag.cases.flatMap((caseItem) => [
        caseItem.title,
        ...(caseItem.id === currentCase.id
          ? validated.value
          : caseItem.suggestedActions),
        ...(caseItem.planBOptionsDraft ?? []),
      ]),
    ].join('');
    if (textLength(replacementTagText) > 6000) {
      return failure(
        'LIMIT_EXCEEDED',
        'review.suggestions.apply: What if text has reached its limit.',
        false,
      );
    }
    const cases = [...currentTag.cases];
    cases[caseIndex] = {
      ...currentCase,
      version: currentCase.version + 1,
      suggestedActions: validated.value,
      suggestedActionSource: 'agent',
    };
    const tags = [...currentItem.tags];
    tags[tagIndex] = { ...currentTag, cases };
    const timeline = [...state.project.timeline];
    timeline[itemIndex] = { ...currentItem, tags };
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: state.project.version + 1,
          timeline,
          activeReviewRequest: null,
        },
      },
      [caseId, request.id],
    );
  }

  if (payload.kind !== 'timeline_gaps') {
    return failure(
      'INVALID_STATE',
      'review.suggestions.apply: unsupported review scope.',
      false,
    );
  }
  const validated = validateReviewSuggestionGaps(payload.gaps);
  if (!validated.ok) return validated.result;
  const existingFingerprints = new Set(
    state.project.gapSuggestions.map(
      (gap) => `${gap.insertAfterItemId ?? ''}\u0000${gap.title}\u0000${gap.body}`,
    ),
  );
  const batchFingerprints = new Set<string>();
  for (const gapInput of validated.value) {
    if (
      gapInput.insertAfterItemId !== null &&
      !state.project.timeline.some(
        (item) => item.id === gapInput.insertAfterItemId,
      )
    ) {
      return failure(
        'INVALID_STATE',
        'review.suggestions.apply: gap anchor was not found in the current Plan.',
        true,
      );
    }
    const fingerprint = `${gapInput.insertAfterItemId ?? ''}\u0000${gapInput.title}\u0000${gapInput.body}`;
    if (
      existingFingerprints.has(fingerprint) ||
      batchFingerprints.has(fingerprint)
    ) {
      return failure(
        'DUPLICATE',
        'review.suggestions.apply: this gap suggestion already exists.',
        false,
      );
    }
    batchFingerprints.add(fingerprint);
  }

  const gaps = validated.value.map((gapInput) => ({
    id: appId('gap'),
    source: 'agent' as const,
    insertAfterItemId: gapInput.insertAfterItemId,
    timeOrCue: gapInput.timeOrCue,
    title: gapInput.title,
    body: gapInput.body,
    status: 'proposed' as const,
  }));
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: state.project.version + 1,
        timeline: state.project.timeline,
        gapSuggestions:
          gaps.length > 0
            ? [...state.project.gapSuggestions, ...gaps]
            : state.project.gapSuggestions,
        activeReviewRequest: null,
      },
    },
    [...gaps.map((gap) => gap.id), request.id],
  );
}

function validateRecheckReplacement(
  input: RecheckReplacementInput,
): ReviewSuggestionValidation<RecheckReplacementInput> {
  const anchorItemId = clean(input.anchorItemId);
  const question = clean(input.question);
  const rationale = clean(input.rationale);
  const summary = clean(input.summary);
  if (!isBoundedString(anchorItemId, 1, 160)) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        'recheck.apply: replacement anchor must be a bounded item ID.',
        true,
      ),
    };
  }
  if (
    textLength(question) < 1 ||
    textLength(question) > 180 ||
    textLength(rationale) < 1 ||
    textLength(rationale) > 400 ||
    textLength(summary) < 1 ||
    textLength(summary) > 400
  ) {
    return {
      ok: false,
      result: failure(
        'INVALID_INPUT',
        'recheck.apply: replacement What if text is outside the allowed length.',
        true,
      ),
    };
  }
  const validatedCases = validateReviewSuggestionCases(
    input.cases,
    'recheck.replace',
  );
  if (!validatedCases.ok) return validatedCases;
  const caseTitles = new Set<string>();
  for (const caseInput of validatedCases.value) {
    if (caseTitles.has(caseInput.title)) {
      return {
        ok: false,
        result: failure(
          'DUPLICATE',
          'recheck.apply: replacement Case titles must be unique.',
          false,
        ),
      };
    }
    caseTitles.add(caseInput.title);
  }
  const tagText = [
    question,
    rationale,
    summary,
    ...validatedCases.value.flatMap((caseInput) => [
      caseInput.title,
      ...caseInput.suggestedActions,
    ]),
  ].join('');
  if (textLength(tagText) > 6000) {
    return {
      ok: false,
      result: failure(
        'LIMIT_EXCEEDED',
        'recheck.apply: replacement What if text has reached its limit.',
        false,
      ),
    };
  }
  return {
    ok: true,
    value: {
      anchorItemId,
      question,
      rationale,
      summary,
      cases: validatedCases.value,
    },
  };
}

function findTagLocation(
  tagId: string,
): { itemIndex: number; tagIndex: number } | null {
  for (const [itemIndex, item] of state.project.timeline.entries()) {
    const tagIndex = item.tags.findIndex((tag) => tag.id === tagId);
    if (tagIndex >= 0) return { itemIndex, tagIndex };
  }
  return null;
}

function applyRecheckRequest(
  command: Extract<AppCommand, { type: 'recheck.request' }>,
): CommandResult {
  if (state.project.activeReviewRequest) {
    return failure(
      'INVALID_STATE',
      'recheck.request: finish or cancel the active review first.',
      true,
    );
  }
  const normalizedTagIds = command.payload.tagIds.map(clean);
  if (
    normalizedTagIds.length < 1 ||
    normalizedTagIds.length > 5 ||
    normalizedTagIds.some((tagId) => !isBoundedString(tagId, 1, 160))
  ) {
    return failure(
      normalizedTagIds.length > 5 ? 'LIMIT_EXCEEDED' : 'INVALID_INPUT',
      'recheck.request: choose one to five bounded Tag IDs.',
      normalizedTagIds.length > 5 ? false : true,
    );
  }
  if (new Set(normalizedTagIds).size !== normalizedTagIds.length) {
    return failure(
      'DUPLICATE',
      'recheck.request: each Tag may be requested only once.',
      false,
    );
  }

  const capturedTags: RecheckRequestTag[] = [];
  for (const tagId of normalizedTagIds) {
    const location = findTagLocation(tagId);
    if (!location) {
      return failure(
        'NOT_FOUND',
        'recheck.request: one requested Tag was not found.',
        false,
      );
    }
    const item = state.project.timeline[location.itemIndex];
    const tag = item.tags[location.tagIndex];
    if (tag.lifecycle !== 'active' || !tag.needsRecheck) {
      return failure(
        'INVALID_STATE',
        'recheck.request: every requested Tag must be active and stale.',
        true,
      );
    }
    capturedTags.push({
      tagId: tag.id,
      tagVersion: tag.version,
      itemId: item.id,
      itemVersion: item.version,
    });
  }

  const projectVersion = state.project.version + 1;
  const request: RecheckRequest = {
    id: appId('recheck'),
    projectVersion,
    tags: capturedTags,
  };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        activeRecheckRequest: request,
      },
    },
    [request.id, ...normalizedTagIds],
  );
}

function applyRecheck(
  command: Extract<AppCommand, { type: 'recheck.apply' }>,
): CommandResult {
  const active = state.project.activeRecheckRequest;
  if (!active) {
    return failure(
      'NOT_FOUND',
      'recheck.apply: active recheck request was not found.',
      false,
    );
  }
  const payload = command.payload;
  const projectId = clean(payload.projectId);
  if (projectId !== state.project.id) {
    return failure('NOT_FOUND', 'recheck.apply: Project was not found.', false);
  }
  if (!isVersion(payload.projectVersion)) {
    return failure(
      'INVALID_INPUT',
      'recheck.apply: projectVersion must be a positive integer.',
      true,
    );
  }
  const request = payload.request;
  if (clean(request.id) !== active.id) {
    return failure(
      'NOT_FOUND',
      'recheck.apply: active recheck request was not found.',
      false,
    );
  }
  if (
    payload.projectVersion !== state.project.version ||
    active.projectVersion !== state.project.version ||
    request.projectVersion !== state.project.version
  ) {
    return failure(
      'VERSION_CONFLICT',
      'recheck.apply: Project or request version is stale.',
      true,
    );
  }
  if (
    request.tags.length !== active.tags.length ||
    request.tags.some((entry, index) => {
      const expected = active.tags[index];
      return (
        clean(entry.tagId) !== expected.tagId ||
        entry.tagVersion !== expected.tagVersion ||
        clean(entry.itemId) !== expected.itemId ||
        entry.itemVersion !== expected.itemVersion
      );
    })
  ) {
    return failure(
      'INVALID_STATE',
      'recheck.apply: request scope no longer matches the current request.',
      true,
    );
  }

  const outcomeByTagId = new Map<string, RecheckOutcomeInput>();
  if (payload.outcomes.length !== active.tags.length) {
    return failure(
      'INVALID_STATE',
      'recheck.apply: exactly one outcome is required for every requested Tag.',
      true,
    );
  }
  for (const outcome of payload.outcomes) {
    const tagId = clean(outcome.tagId);
    if (outcomeByTagId.has(tagId)) {
      return failure(
        'DUPLICATE',
        'recheck.apply: each requested Tag needs one unique outcome.',
        false,
      );
    }
    const captured = active.tags.find((entry) => entry.tagId === tagId);
    if (!captured) {
      return failure(
        'INVALID_STATE',
        'recheck.apply: outcome contains an unrequested Tag.',
        true,
      );
    }
    if (outcome.tagVersion !== captured.tagVersion) {
      return failure(
        'INVALID_STATE',
        'recheck.apply: a requested Tag version is stale.',
        true,
      );
    }
    outcomeByTagId.set(tagId, outcome);
  }

  const locations = new Map<
    string,
    { itemIndex: number; tagIndex: number; item: TimelineItem; tag: MoshimoTag }
  >();
  for (const captured of active.tags) {
    const location = findTagLocation(captured.tagId);
    if (!location) {
      return failure(
        'INVALID_STATE',
        'recheck.apply: a requested Tag is no longer available.',
        true,
      );
    }
    const item = state.project.timeline[location.itemIndex];
    const tag = item.tags[location.tagIndex];
    if (
      tag.lifecycle !== 'active' ||
      !tag.needsRecheck ||
      tag.version !== captured.tagVersion ||
      item.id !== captured.itemId ||
      item.version !== captured.itemVersion ||
      tag.anchorItemId !== item.id
    ) {
      return failure(
        'INVALID_STATE',
        'recheck.apply: a requested Tag or anchor is stale.',
        true,
      );
    }
    locations.set(captured.tagId, { ...location, item, tag });
  }

  const normalizedReplacements = new Map<string, RecheckReplacementInput>();
  const replacementFingerprints = new Set<string>();
  for (const [tagId, outcome] of outcomeByTagId) {
    if (outcome.outcome !== 'replace') continue;
    const location = locations.get(tagId);
    if (!location || !outcome.replacement) {
      return failure(
        'INVALID_INPUT',
        'recheck.apply: replace requires a replacement Tag.',
        true,
      );
    }
    const validated = validateRecheckReplacement(outcome.replacement);
    if (!validated.ok) return validated.result;
    if (validated.value.anchorItemId !== location.item.id) {
      return failure(
        'INVALID_STATE',
        'recheck.apply: replacement anchor is outside the stale Tag scope.',
        true,
      );
    }
    const fingerprint = `${validated.value.anchorItemId}\u0000${validated.value.question}`;
    if (replacementFingerprints.has(fingerprint)) {
      return failure(
        'DUPLICATE',
        'recheck.apply: replacement What ifs must be unique at each anchor.',
        false,
      );
    }
    replacementFingerprints.add(fingerprint);
    for (const sibling of location.item.tags) {
      if (
        sibling.id !== tagId &&
        sibling.lifecycle === 'active' &&
        sibling.anchorItemId === location.item.id &&
        sibling.question === validated.value.question
      ) {
        return failure(
          'DUPLICATE',
          'recheck.apply: a replacement What if already exists at this anchor.',
          false,
        );
      }
    }
    normalizedReplacements.set(tagId, validated.value);
  }

  const finalProjectVersion = state.project.version + 1;
  const affectedItemIds = new Set(
    [...locations.values()].map((location) => location.item.id),
  );
  const finalItemVersions = new Map(
    [...affectedItemIds].map((itemId) => {
      const item = state.project.timeline.find((entry) => entry.id === itemId);
      return [itemId, (item?.version ?? 0) + 1];
    }),
  );
  const affectedIds: string[] = [];
  const timeline = state.project.timeline.map((item) => {
    if (!affectedItemIds.has(item.id)) return item;
    const itemOutcomes = new Map<string, RecheckOutcomeInput>();
    for (const tag of item.tags) {
      const outcome = outcomeByTagId.get(tag.id);
      if (outcome) itemOutcomes.set(tag.id, outcome);
    }
    const nextTags: MoshimoTag[] = [];
    for (const tag of item.tags) {
      const outcome = itemOutcomes.get(tag.id);
      if (!outcome) {
        nextTags.push(tag);
        continue;
      }
      const nextOldTag: MoshimoTag = {
        ...tag,
        version: tag.version + 1,
        lifecycle: outcome.outcome === 'retain' ? 'active' : 'resolved',
        needsRecheck: outcome.outcome === 'retain' ? false : false,
        ...(outcome.outcome === 'retain'
          ? {
              basedOnItemVersion: finalItemVersions.get(item.id) ?? item.version,
              basedOnProjectVersion: finalProjectVersion,
            }
          : {}),
      };
      nextTags.push(nextOldTag);
      affectedIds.push(tag.id);
      if (outcome.outcome === 'replace') {
        const replacement = normalizedReplacements.get(tag.id);
        if (!replacement) continue;
        const cases = replacement.cases.map(makeAgentCase);
        const nextTag: MoshimoTag = {
          id: appId('tag'),
          version: 1,
          anchorItemId: item.id,
          source: 'agent',
          needsRecheck: false,
          lifecycle: 'active',
          basedOnItemVersion: finalItemVersions.get(item.id) ?? item.version,
          basedOnProjectVersion: finalProjectVersion,
          question: replacement.question,
          rationale: replacement.rationale,
          summary: replacement.summary,
          impact: null,
          cases,
        };
        nextTags.push(nextTag);
        affectedIds.push(nextTag.id, ...cases.map((caseItem) => caseItem.id));
      }
    }
    return {
      ...item,
      version: finalItemVersions.get(item.id) ?? item.version + 1,
      tags: nextTags,
    };
  });

  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: finalProjectVersion,
        timeline,
        activeRecheckRequest: null,
      },
    },
    [...affectedIds, active.id],
  );
}

function clearRecheck(
  command: Extract<AppCommand, { type: 'recheck.clear' }>,
): CommandResult {
  const active = state.project.activeRecheckRequest;
  const requestId = clean(command.payload.requestId);
  if (!active || active.id !== requestId) {
    return failure(
      'NOT_FOUND',
      'recheck.clear: active recheck request was not found.',
      false,
    );
  }
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: state.project.version + 1,
        activeRecheckRequest: null,
      },
    },
    [active.id],
  );
}

function versionConflictIfStale(
  expected: number | undefined,
  actual: number,
  operation: string,
  subject: string,
): CommandResult | null {
  if (expected === undefined || expected === actual) return null;
  return failure(
    'VERSION_CONFLICT',
    `${operation}: ${subject} version is stale.`,
    true,
  );
}

function caseLocation(
  caseId: string,
): { itemIndex: number; tagIndex: number; caseIndex: number } | null {
  for (const [itemIndex, item] of state.project.timeline.entries()) {
    for (const [tagIndex, tag] of item.tags.entries()) {
      const caseIndex = tag.cases.findIndex((caseItem) => caseItem.id === caseId);
      if (caseIndex >= 0) return { itemIndex, tagIndex, caseIndex };
    }
  }
  return null;
}

function makeProjectPlanTimeline(
  items: ProjectPlanItemInput[],
  projectVersion: number,
  affectedIds: string[],
): TimelineItem[] {
  return items.map((itemInput) => {
    const itemId = appId('item');
    affectedIds.push(itemId);
    const tags = itemInput.tags.map((tagInput) => {
      const tagId = appId('tag');
      affectedIds.push(tagId);
      const cases = tagInput.cases.map((caseInput) => {
        const caseItem = makeAgentCase(caseInput);
        affectedIds.push(caseItem.id);
        return caseItem;
      });
      return {
        id: tagId,
        version: 1,
        anchorItemId: itemId,
        source: 'agent' as const,
        needsRecheck: false,
        lifecycle: 'active' as const,
        basedOnItemVersion: 1,
        basedOnProjectVersion: projectVersion,
        question: tagInput.question,
        rationale: tagInput.rationale,
        summary: tagInput.summary,
        impact: tagInput.impact,
        cases,
      } satisfies MoshimoTag;
    });
    return {
      id: itemId,
      version: 1,
      timeOrCue: itemInput.timeOrCue,
      title: itemInput.title,
      body: itemInput.body,
      status: 'draft' as const,
      tags,
    };
  });
}

function createProjectWithPlan(
  command: Extract<AppCommand, { type: 'project.createWithPlan' }>,
): CommandResult {
  const title = clean(command.payload.title);
  const description = clean(command.payload.description);
  if (textLength(title) < 1 || textLength(title) > 120) {
    return failure(
      'INVALID_INPUT',
      'project.createWithPlan: title must be 1–120 characters.',
      true,
    );
  }
  if (textLength(description) > 1000) {
    return failure(
      'INVALID_INPUT',
      'project.createWithPlan: description must be 0–1,000 characters.',
      true,
    );
  }
  if (
    state.projects.length + (isEmptyWorkspaceProject(state.project) ? 0 : 1) >=
    MAX_PROJECTS
  ) {
    return failure(
      'LIMIT_EXCEEDED',
      `project.createWithPlan: a maximum of ${MAX_PROJECTS} Projects is supported.`,
      false,
    );
  }
  const validated = validateProjectPlanItems(command.payload.items);
  if (!validated.ok) return validated.result;
  const project: ProjectState = {
    id: appId('project'),
    version: 1,
    title,
    description,
    viewMode: 'editing',
    timeline: [],
    gapSuggestions: [],
    activeReviewRequest: null,
    activeRecheckRequest: null,
  };
  const replacingEmptyWorkspace = isEmptyWorkspaceProject(state.project);
  const affectedIds: string[] = [
    ...(replacingEmptyWorkspace ? [] : [state.project.id]),
    project.id,
  ];
  project.timeline = makeProjectPlanTimeline(
    validated.items,
    project.version,
    affectedIds,
  );
  return publish(
    {
      ...state,
      project,
      projects: replacingEmptyWorkspace
        ? state.projects
        : [...state.projects, state.project],
      undoDelete: null,
    },
    affectedIds,
  );
}

function locateActiveTag(
  tagId: string,
  operation: string,
):
  | {
      itemIndex: number;
      tagIndex: number;
      item: TimelineItem;
      tag: MoshimoTag;
    }
  | { result: CommandResult } {
  const location = findTagLocation(tagId);
  if (!location) {
    return { result: failure('NOT_FOUND', `${operation}: What if was not found.`, false) };
  }
  const item = state.project.timeline[location.itemIndex];
  const tag = item.tags[location.tagIndex];
  if (tag.lifecycle !== 'active') {
    return {
      result: failure(
        'INVALID_STATE',
        `${operation}: resolved What if history is read-only.`,
        false,
      ),
    };
  }
  return { ...location, item, tag };
}

function createTag(
  command: Extract<AppCommand, { type: 'tag.create' }>,
): CommandResult {
  const operation = 'tag.create';
  const anchorItemId = clean(command.payload.anchorItemId);
  if (!isBoundedString(anchorItemId, 1, 160)) {
    return failure('INVALID_INPUT', `${operation}: anchor item is invalid.`, true);
  }
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const itemIndex = state.project.timeline.findIndex(
    (item) => item.id === anchorItemId,
  );
  if (itemIndex < 0) {
    return failure('NOT_FOUND', `${operation}: Plan item was not found.`, false);
  }
  const item = state.project.timeline[itemIndex];
  const itemVersionError = versionConflictIfStale(
    command.payload.itemVersion,
    item.version,
    operation,
    'Plan item',
  );
  if (itemVersionError) return itemVersionError;
  const validated = validateAgentTagText(command.payload, operation, 6);
  if (!validated.ok) return validated.result;
  if (
    item.tags.some(
      (tag) =>
        tag.lifecycle === 'active' && tag.question === validated.value.question,
    )
  ) {
    return failure(
      'DUPLICATE',
      `${operation}: a What if already exists at this Plan item.`,
      false,
    );
  }
  const projectVersion = state.project.version + 1;
  const itemVersion = item.version + 1;
  const tagId = appId('tag');
  const cases = validated.value.cases.map(makeAgentCase);
  const tag: MoshimoTag = {
    id: tagId,
    version: 1,
    anchorItemId,
    source: 'agent',
    needsRecheck: false,
    lifecycle: 'active',
    basedOnItemVersion: itemVersion,
    basedOnProjectVersion: projectVersion,
    question: validated.value.question,
    rationale: validated.value.rationale,
    summary: validated.value.summary,
    impact: validated.value.impact,
    cases,
  };
  const timeline = [...state.project.timeline];
  timeline[itemIndex] = {
    ...item,
    version: itemVersion,
    tags: [...item.tags, tag],
  };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        timeline,
        activeReviewRequest: null,
      },
    },
    [tagId, ...cases.map((caseItem) => caseItem.id)],
  );
}

function updateTag(
  command: Extract<AppCommand, { type: 'tag.update' }>,
): CommandResult {
  const operation = 'tag.update';
  const tagId = clean(command.payload.tagId);
  const located = locateActiveTag(tagId, operation);
  if ('result' in located) return located.result;
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const tagVersionError = versionConflictIfStale(
    command.payload.tagVersion,
    located.tag.version,
    operation,
    'What-if',
  );
  if (tagVersionError) return tagVersionError;
  const question = clean(command.payload.question);
  const rationale = clean(command.payload.rationale);
  const summary = clean(command.payload.summary);
  if (
    textLength(question) < 1 ||
    textLength(question) > 180 ||
    textLength(rationale) < 1 ||
    textLength(rationale) > 400 ||
    textLength(summary) < 1 ||
    textLength(summary) > 400
  ) {
    return failure(
      'INVALID_INPUT',
      `${operation}: What-if text is outside the allowed length.`,
      true,
    );
  }
  if (
    located.item.tags.some(
      (tag) =>
        tag.id !== located.tag.id &&
        tag.lifecycle === 'active' &&
        tag.question === question,
    )
  ) {
    return failure(
      'DUPLICATE',
      `${operation}: a What if already exists at this Plan item.`,
      false,
    );
  }
  const tagText = [
    question,
    rationale,
    summary,
    located.tag.impact?.penalty ?? '',
    ...located.tag.cases.flatMap((caseItem) => [
      caseItem.title,
      ...caseItem.suggestedActions,
      ...(caseItem.planBOptionsDraft ?? []),
    ]),
  ].join('');
  if (textLength(tagText) > 6000) {
    return failure(
      'LIMIT_EXCEEDED',
      `${operation}: What-if text has reached its limit.`,
      false,
    );
  }
  if (
    question === located.tag.question &&
    rationale === located.tag.rationale &&
    summary === located.tag.summary
  ) {
    return noChanges();
  }
  const projectVersion = state.project.version + 1;
  const itemVersion = located.item.version + 1;
  const updatedTag: MoshimoTag = {
    ...located.tag,
    version: located.tag.version + 1,
    basedOnItemVersion: itemVersion,
    basedOnProjectVersion: projectVersion,
    question,
    rationale,
    summary,
  };
  const tags = [...located.item.tags];
  tags[located.tagIndex] = updatedTag;
  const timeline = [...state.project.timeline];
  timeline[located.itemIndex] = { ...located.item, version: itemVersion, tags };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        timeline,
        activeReviewRequest: null,
      },
    },
    [tagId],
  );
}

function deleteTag(
  command: Extract<AppCommand, { type: 'tag.delete' }>,
): CommandResult {
  const operation = 'tag.delete';
  const tagId = clean(command.payload.tagId);
  const located = locateActiveTag(tagId, operation);
  if ('result' in located) return located.result;
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const tagVersionError = versionConflictIfStale(
    command.payload.tagVersion,
    located.tag.version,
    operation,
    'What-if',
  );
  if (tagVersionError) return tagVersionError;
  const projectVersion = state.project.version + 1;
  const itemVersion = located.item.version + 1;
  const tags = located.item.tags.filter((tag) => tag.id !== tagId);
  const timeline = [...state.project.timeline];
  timeline[located.itemIndex] = { ...located.item, version: itemVersion, tags };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        timeline,
        activeReviewRequest: null,
      },
    },
    [tagId],
  );
}

function setTagImpact(
  command: Extract<AppCommand, { type: 'tag.impact.set' }>,
): CommandResult {
  const operation = 'tag.impact.set';
  const tagId = clean(command.payload.tagId);
  const located = locateActiveTag(tagId, operation);
  if ('result' in located) return located.result;
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const tagVersionError = versionConflictIfStale(
    command.payload.tagVersion,
    located.tag.version,
    operation,
    'What-if',
  );
  if (tagVersionError) return tagVersionError;
  const impact = normalizeImpactInput(command.payload.impact, operation);
  if (!impact.ok) return impact.result;
  if (sameImpact(located.tag.impact, impact.value)) return noChanges();

  const projectVersion = state.project.version + 1;
  const itemVersion = located.item.version + 1;
  const updatedTag: MoshimoTag = {
    ...located.tag,
    version: located.tag.version + 1,
    basedOnItemVersion: itemVersion,
    basedOnProjectVersion: projectVersion,
    impact: impact.value,
  };
  const tags = [...located.item.tags];
  tags[located.tagIndex] = updatedTag;
  const timeline = [...state.project.timeline];
  timeline[located.itemIndex] = { ...located.item, version: itemVersion, tags };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        timeline,
        activeReviewRequest: null,
      },
    },
    [tagId],
  );
}

function moveTag(
  command: Extract<AppCommand, { type: 'tag.move' }>,
): CommandResult {
  const operation = 'tag.move';
  const tagId = clean(command.payload.tagId);
  const located = locateActiveTag(tagId, operation);
  if ('result' in located) return located.result;
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const tagVersionError = versionConflictIfStale(
    command.payload.tagVersion,
    located.tag.version,
    operation,
    'What-if',
  );
  if (tagVersionError) return tagVersionError;

  const activeTagIndices = located.item.tags
    .map((tag, index) => (tag.lifecycle === 'active' ? index : -1))
    .filter((index) => index >= 0);
  const from = activeTagIndices.indexOf(located.tagIndex);
  const to = command.payload.direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= activeTagIndices.length) {
    return failure(
      'INVALID_STATE',
      `${operation}: What if is already at the ${
        command.payload.direction === 'up' ? 'start' : 'end'
      }.`,
      true,
    );
  }

  const targetTagIndex = activeTagIndices[to];
  const targetTag = located.item.tags[targetTagIndex];
  const tags = [...located.item.tags];
  [tags[located.tagIndex], tags[targetTagIndex]] = [
    tags[targetTagIndex],
    tags[located.tagIndex],
  ];
  const timeline = [...state.project.timeline];
  timeline[located.itemIndex] = {
    ...located.item,
    version: located.item.version + 1,
    tags,
  };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: state.project.version + 1,
        timeline,
        activeReviewRequest: null,
      },
    },
    [located.item.id, located.tag.id, targetTag.id],
  );
}

function sortTagsByImpact(
  command: Extract<AppCommand, { type: 'tags.sortByImpact' }>,
): CommandResult {
  const operation = 'tags.sortByImpact';
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const itemId =
    command.payload.itemId === null ? null : clean(command.payload.itemId);
  if (itemId !== null && !isBoundedString(itemId, 1, 160)) {
    return failure('INVALID_INPUT', `${operation}: Plan item is invalid.`, true);
  }
  if (itemId !== null && !state.project.timeline.some((item) => item.id === itemId)) {
    return failure('NOT_FOUND', `${operation}: Plan item was not found.`, false);
  }

  const changedItemIds: string[] = [];
  const changedTagIds: string[] = [];
  const projectVersion = state.project.version + 1;
  const timeline = state.project.timeline.map((item) => {
    if (itemId !== null && item.id !== itemId) return item;
    if (item.tags.length < 2) return item;
    const sorted = item.tags
      .map((tag, index) => ({ tag, index }))
      .sort((left, right) => {
        const leftRank = left.tag.impact?.rank ?? 0;
        const rightRank = right.tag.impact?.rank ?? 0;
        return rightRank - leftRank || left.index - right.index;
      })
      .map(({ tag }) => tag);
    const changed = sorted.some((tag, index) => tag.id !== item.tags[index]?.id);
    if (!changed) return item;
    changedItemIds.push(item.id);
    changedTagIds.push(...sorted.map((tag) => tag.id));
    return { ...item, version: item.version + 1, tags: sorted };
  });
  if (changedItemIds.length === 0) return noChanges();
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        timeline,
        activeReviewRequest: null,
      },
    },
    [...changedItemIds, ...changedTagIds],
  );
}

function createCase(
  command: Extract<AppCommand, { type: 'case.create' }>,
): CommandResult {
  const operation = 'case.create';
  const tagId = clean(command.payload.tagId);
  const located = locateActiveTag(tagId, operation);
  if ('result' in located) return located.result;
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const tagVersionError = versionConflictIfStale(
    command.payload.tagVersion,
    located.tag.version,
    operation,
    'What-if',
  );
  if (tagVersionError) return tagVersionError;
  const validated = validateAgentCases(
    [{ title: command.payload.title, suggestedActions: command.payload.suggestedActions }],
    operation,
    1,
  );
  if (!validated.ok) return validated.result;
  if (located.tag.cases.length >= 6) {
    return failure(
      'LIMIT_EXCEEDED',
      `${operation}: this What-if already has six Cases.`,
      false,
    );
  }
  const caseInput = validated.value[0];
  if (located.tag.cases.some((caseItem) => caseItem.title === caseInput.title)) {
    return failure(
      'DUPLICATE',
      `${operation}: a Case title already exists in this What if.`,
      false,
    );
  }
  const tagText = [
    located.tag.question,
    located.tag.rationale,
    located.tag.summary,
    located.tag.impact?.penalty ?? '',
    ...located.tag.cases.flatMap((caseItem) => [
      caseItem.title,
      ...caseItem.suggestedActions,
      ...(caseItem.planBOptionsDraft ?? []),
    ]),
    caseInput.title,
    ...caseInput.suggestedActions,
  ].join('');
  if (textLength(tagText) > 6000) {
    return failure(
      'LIMIT_EXCEEDED',
      `${operation}: What-if text has reached its limit.`,
      false,
    );
  }
  const caseItem = makeAgentCase(caseInput);
  const projectVersion = state.project.version + 1;
  const itemVersion = located.item.version + 1;
  const updatedTag: MoshimoTag = {
    ...located.tag,
    version: located.tag.version + 1,
    basedOnItemVersion: itemVersion,
    basedOnProjectVersion: projectVersion,
    cases: [...located.tag.cases, caseItem],
  };
  const tags = [...located.item.tags];
  tags[located.tagIndex] = updatedTag;
  const timeline = [...state.project.timeline];
  timeline[located.itemIndex] = { ...located.item, version: itemVersion, tags };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        timeline,
        activeReviewRequest: null,
      },
    },
    [tagId, caseItem.id],
  );
}

function updateCase(
  command: Extract<AppCommand, { type: 'case.update' }>,
): CommandResult {
  const operation = 'case.update';
  const caseId = clean(command.payload.caseId);
  const location = caseLocation(caseId);
  if (!location) {
    return failure('NOT_FOUND', `${operation}: Case was not found.`, false);
  }
  const item = state.project.timeline[location.itemIndex];
  const tag = item.tags[location.tagIndex];
  if (tag.lifecycle !== 'active') {
    return failure(
      'INVALID_STATE',
      `${operation}: resolved What-if history is read-only.`,
      false,
    );
  }
  const currentCase = tag.cases[location.caseIndex];
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const caseVersionError = versionConflictIfStale(
    command.payload.caseVersion,
    currentCase.version,
    operation,
    'Case',
  );
  if (caseVersionError) return caseVersionError;
  const validated = validateAgentCases(
    [{ title: command.payload.title, suggestedActions: command.payload.suggestedActions }],
    operation,
    1,
  );
  if (!validated.ok) return validated.result;
  const caseInput = validated.value[0];
  if (
    tag.cases.some(
      (caseItem) =>
        caseItem.id !== currentCase.id && caseItem.title === caseInput.title,
    )
  ) {
    return failure(
      'DUPLICATE',
      `${operation}: a Case title already exists in this What if.`,
      false,
    );
  }
  const tagText = [
    tag.question,
    tag.rationale,
    tag.summary,
    tag.impact?.penalty ?? '',
    ...tag.cases.flatMap((caseItem) => [
      caseItem.title,
      ...(caseItem.id === currentCase.id
        ? caseInput.suggestedActions
        : caseItem.suggestedActions),
      ...(caseItem.planBOptionsDraft ?? []),
    ]),
  ].join('');
  if (textLength(tagText) > 6000) {
    return failure(
      'LIMIT_EXCEEDED',
      `${operation}: What-if text has reached its limit.`,
      false,
    );
  }
  if (
    currentCase.title === caseInput.title &&
    currentCase.suggestedActions.length === caseInput.suggestedActions.length &&
    currentCase.suggestedActions.every(
      (action, index) => action === caseInput.suggestedActions[index],
    ) &&
    currentCase.suggestedActionSource === 'agent'
  ) {
    return noChanges();
  }
  const projectVersion = state.project.version + 1;
  const itemVersion = item.version + 1;
  const cases = [...tag.cases];
  cases[location.caseIndex] = {
    ...currentCase,
    version: currentCase.version + 1,
    title: caseInput.title,
    suggestedActions: [...caseInput.suggestedActions],
    suggestedActionSource: 'agent',
  };
  const tags = [...item.tags];
  tags[location.tagIndex] = {
    ...tag,
    version: tag.version + 1,
    basedOnItemVersion: itemVersion,
    basedOnProjectVersion: projectVersion,
    cases,
  };
  const timeline = [...state.project.timeline];
  timeline[location.itemIndex] = { ...item, version: itemVersion, tags };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        timeline,
        activeReviewRequest: null,
      },
    },
    [caseId, tag.id],
  );
}

function setCasePlanBOptions(
  command: Extract<AppCommand, { type: 'case.planBOptions.set' }>,
): CommandResult {
  const operation = 'case.planBOptions.set';
  const caseId = clean(command.payload.caseId);
  const location = caseLocation(caseId);
  if (!location) {
    return failure('NOT_FOUND', `${operation}: Case was not found.`, false);
  }
  const item = state.project.timeline[location.itemIndex];
  const tag = item.tags[location.tagIndex];
  if (tag.lifecycle !== 'active') {
    return failure(
      'INVALID_STATE',
      `${operation}: resolved What-if history is read-only.`,
      false,
    );
  }
  const currentCase = tag.cases[location.caseIndex];
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const caseVersionError = versionConflictIfStale(
    command.payload.caseVersion,
    currentCase.version,
    operation,
    'Case',
  );
  if (caseVersionError) return caseVersionError;

  const options =
    command.payload.options === null
      ? null
      : command.payload.options.map(clean);
  if (
    options !== null &&
    (options.length > 5 ||
      options.some(
        (option) => textLength(option) < 1 || textLength(option) > 1200,
      ) ||
      textLength(options.join('')) > 4800)
  ) {
    return failure(
      'INVALID_INPUT',
      `${operation}: Plan B options are outside the allowed bounds.`,
      true,
    );
  }

  const tagText = [
    tag.question,
    tag.rationale,
    tag.summary,
    tag.impact?.penalty ?? '',
    ...tag.cases.flatMap((caseItem) => [
      caseItem.title,
      ...caseItem.suggestedActions,
      ...(caseItem.id === currentCase.id
        ? options ?? []
        : caseItem.planBOptionsDraft ?? []),
    ]),
  ].join('');
  if (textLength(tagText) > 6000) {
    return failure(
      'LIMIT_EXCEEDED',
      `${operation}: What-if text has reached its limit.`,
      false,
    );
  }

  const currentOptions = currentCase.planBOptionsDraft;
  if (
    currentOptions === options ||
    (currentOptions !== null &&
      options !== null &&
      currentOptions.length === options.length &&
      currentOptions.every((option, index) => option === options[index]))
  ) {
    return noChanges();
  }

  const projectVersion = state.project.version + 1;
  const itemVersion = item.version + 1;
  const cases = [...tag.cases];
  cases[location.caseIndex] = {
    ...currentCase,
    version: currentCase.version + 1,
    planBOptionsDraft: options === null ? null : [...options],
  };
  const tags = [...item.tags];
  tags[location.tagIndex] = {
    ...tag,
    version: tag.version + 1,
    basedOnItemVersion: itemVersion,
    basedOnProjectVersion: projectVersion,
    cases,
  };
  const timeline = [...state.project.timeline];
  timeline[location.itemIndex] = { ...item, version: itemVersion, tags };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        timeline,
        activeReviewRequest: null,
      },
    },
    [caseId, tag.id],
  );
}

function deleteCase(
  command: Extract<AppCommand, { type: 'case.delete' }>,
): CommandResult {
  const operation = 'case.delete';
  const caseId = clean(command.payload.caseId);
  const location = caseLocation(caseId);
  if (!location) {
    return failure('NOT_FOUND', `${operation}: Case was not found.`, false);
  }
  const item = state.project.timeline[location.itemIndex];
  const tag = item.tags[location.tagIndex];
  if (tag.lifecycle !== 'active') {
    return failure(
      'INVALID_STATE',
      `${operation}: resolved What-if history is read-only.`,
      false,
    );
  }
  const currentCase = tag.cases[location.caseIndex];
  const projectVersionError = versionConflictIfStale(
    command.payload.projectVersion,
    state.project.version,
    operation,
    'Project',
  );
  if (projectVersionError) return projectVersionError;
  const caseVersionError = versionConflictIfStale(
    command.payload.caseVersion,
    currentCase.version,
    operation,
    'Case',
  );
  if (caseVersionError) return caseVersionError;
  const projectVersion = state.project.version + 1;
  const itemVersion = item.version + 1;
  if (tag.cases.length === 1) {
    const tags = item.tags.filter((entry) => entry.id !== tag.id);
    const timeline = [...state.project.timeline];
    timeline[location.itemIndex] = { ...item, version: itemVersion, tags };
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: projectVersion,
          timeline,
          activeReviewRequest: null,
        },
      },
      [caseId, tag.id],
    );
  }
  const cases = tag.cases.filter((caseItem) => caseItem.id !== caseId);
  const tags = [...item.tags];
  tags[location.tagIndex] = {
    ...tag,
    version: tag.version + 1,
    basedOnItemVersion: itemVersion,
    basedOnProjectVersion: projectVersion,
    cases,
  };
  const timeline = [...state.project.timeline];
  timeline[location.itemIndex] = { ...item, version: itemVersion, tags };
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: projectVersion,
        timeline,
        activeReviewRequest: null,
      },
    },
    [caseId, tag.id],
  );
}

type EditingOrderEntry =
  | { kind: 'item'; id: string }
  | { kind: 'gap'; id: string };

function proposedEditingOrder(project: ProjectState): EditingOrderEntry[] {
  const order: EditingOrderEntry[] = [];
  const proposedGaps = project.gapSuggestions.filter(
    (gap) => gap.status === 'proposed',
  );

  for (const item of project.timeline) {
    order.push({ kind: 'item', id: item.id });
    for (const gap of proposedGaps) {
      if (gap.insertAfterItemId === item.id) {
        order.push({ kind: 'gap', id: gap.id });
      }
    }
  }

  for (const gap of proposedGaps) {
    if (gap.insertAfterItemId === null) {
      order.push({ kind: 'gap', id: gap.id });
    }
  }

  return order;
}

function moveEditingOrderEntry(
  entry: EditingOrderEntry,
  direction: 'up' | 'down',
  operation: 'timeline.move' | 'gap.move',
): CommandResult {
  const order = proposedEditingOrder(state.project);
  const from = order.findIndex(
    (candidate) => candidate.kind === entry.kind && candidate.id === entry.id,
  );
  if (from < 0) {
    return failure(
      'NOT_FOUND',
      `${operation}: ${entry.kind === 'item' ? 'item' : 'suggestion'} was not found.`,
      false,
    );
  }

  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= order.length) {
    return failure(
      'INVALID_STATE',
      `${operation}: entry is already at the ${direction === 'up' ? 'start' : 'end'}.`,
      true,
    );
  }

  const nextOrder = [...order];
  [nextOrder[from], nextOrder[to]] = [nextOrder[to], nextOrder[from]];
  const firstItemIndex = nextOrder.findIndex(
    (candidate) => candidate.kind === 'item',
  );
  if (
    firstItemIndex > 0 &&
    nextOrder.slice(0, firstItemIndex).some((candidate) => candidate.kind === 'gap')
  ) {
    return failure(
      'INVALID_STATE',
      `${operation}: a suggested step cannot be placed before the first Plan item.`,
      true,
    );
  }

  const itemById = new Map(
    state.project.timeline.map((item) => [item.id, item] as const),
  );
  const proposedGapById = new Map(
    state.project.gapSuggestions
      .filter((gap) => gap.status === 'proposed')
      .map((gap) => [gap.id, gap] as const),
  );
  const timeline = nextOrder.flatMap((candidate) => {
    if (candidate.kind !== 'item') return [];
    const item = itemById.get(candidate.id);
    return item ? [item] : [];
  });
  let precedingItemId: string | null = null;
  const proposedGaps: PlanGapSuggestion[] = [];
  const changedGapIds: string[] = [];
  for (const candidate of nextOrder) {
    if (candidate.kind === 'item') {
      precedingItemId = candidate.id;
      continue;
    }
    const gap = proposedGapById.get(candidate.id);
    if (!gap) continue;
    const movedGap = { ...gap, insertAfterItemId: precedingItemId };
    proposedGaps.push(movedGap);
    if (gap.insertAfterItemId !== movedGap.insertAfterItemId) {
      changedGapIds.push(gap.id);
    }
  }
  const inactiveGaps = state.project.gapSuggestions.filter(
    (gap) => gap.status !== 'proposed',
  );
  const crossed = order[to];

  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: state.project.version + 1,
        timeline,
        gapSuggestions: [...proposedGaps, ...inactiveGaps],
        activeReviewRequest: null,
      },
    },
    [...new Set([entry.id, crossed.id, ...changedGapIds])],
  );
}

export function dispatch(raw: unknown): CommandResult {
  const command = parseCommand(raw);
  if (!command) {
    return failure(
      'INVALID_INPUT',
      'command: expected a supported command payload.',
      false,
    );
  }

  if (
    state.project.activeReviewRequest &&
    (command.type === 'project.create' ||
      command.type === 'project.createWithPlan' ||
      command.type === 'project.open' ||
      command.type === 'project.delete' ||
      command.type === 'tag.create' ||
      command.type === 'tag.update' ||
      command.type === 'tag.delete' ||
      command.type === 'tag.move' ||
      command.type === 'tag.impact.set' ||
      command.type === 'tags.sortByImpact' ||
      command.type === 'case.create' ||
      command.type === 'case.update' ||
      command.type === 'case.planBOptions.set' ||
      command.type === 'case.delete' ||
      (command.type === 'timeline.add' && command.payload.requestReview) ||
      (command.type === 'tag.add' && command.payload.requestReview) ||
      (command.type === 'case.add' && command.payload.requestReview))
  ) {
    return failure(
      'INVALID_STATE',
      `${command.type}: cancel the active review request before continuing.`,
      true,
    );
  }

  if (
    state.project.activeRecheckRequest &&
    command.type !== 'recheck.apply' &&
    command.type !== 'recheck.clear'
  ) {
    return failure(
      'INVALID_STATE',
      `${command.type}: finish or cancel the active recheck first.`,
      true,
    );
  }

  if (command.type === 'history.undo') {
    return restoreHistory('undo');
  }
  if (command.type === 'history.redo') {
    return restoreHistory('redo');
  }

  if (command.type === 'recheck.request') {
    return applyRecheckRequest(command);
  }
  if (command.type === 'recheck.apply') {
    return applyRecheck(command);
  }
  if (command.type === 'recheck.clear') {
    return clearRecheck(command);
  }

  if (command.type === 'project.createWithPlan') {
    return createProjectWithPlan(command);
  }

  if (command.type === 'project.create') {
    const title = clean(command.payload.title);
    const description = clean(command.payload.description);
    if (textLength(title) < 1 || textLength(title) > 120) {
      return failure(
        'INVALID_INPUT',
        'project.create: title must be 1–120 characters.',
        true,
      );
    }
    if (textLength(description) > 1000) {
      return failure(
        'INVALID_INPUT',
        'project.create: description must be 0–1,000 characters.',
        true,
      );
    }
    if (command.payload.requestReview && textLength(description) < 1) {
      return failure(
        'INVALID_INPUT',
        'project.create: an AI brief is required when requesting review.',
        true,
      );
    }
    if (
      state.projects.length +
        (isEmptyWorkspaceProject(state.project) ? 0 : 1) >=
      MAX_PROJECTS
    ) {
      return failure(
        'LIMIT_EXCEEDED',
        `project.create: a maximum of ${MAX_PROJECTS} Projects is supported.`,
        false,
      );
    }
    const project: ProjectState = {
      id: appId('project'),
      version: 1,
      title,
      description,
      viewMode: 'editing',
      timeline: [],
      gapSuggestions: [],
      activeReviewRequest: null,
      activeRecheckRequest: null,
    };
    if (command.payload.requestReview) {
      project.activeReviewRequest = makeReviewRequest(
        'project_plan',
        project.id,
        project.version,
        project.version,
      );
    }
    const replacingEmptyWorkspace = isEmptyWorkspaceProject(state.project);
    return publish(
      {
        ...state,
        project,
        projects: replacingEmptyWorkspace
          ? state.projects
          : [...state.projects, state.project],
        undoDelete: null,
      },
      [
        ...(replacingEmptyWorkspace ? [] : [state.project.id]),
        project.id,
        ...(project.activeReviewRequest
          ? [project.activeReviewRequest.id]
          : []),
      ],
    );
  }

  if (command.type === 'project.open') {
    const projectId = clean(command.payload.projectId);
    if (projectId === state.project.id) return noChanges();
    const index = state.projects.findIndex((project) => project.id === projectId);
    if (index < 0) {
      return failure('NOT_FOUND', 'project.open: Project was not found.', false);
    }
    const project = state.projects[index];
    const projects = [...state.projects];
    if (isEmptyWorkspaceProject(state.project)) {
      projects.splice(index, 1);
    } else {
      projects[index] = state.project;
    }
    return publish(
      { ...state, project, projects, undoDelete: null },
      [state.project.id, project.id],
    );
  }

  if (command.type === 'project.delete') {
    const projectId = clean(command.payload.projectId);
    if (
      isEmptyWorkspaceProject(state.project) ||
      projectId !== state.project.id
    ) {
      return failure(
        'NOT_FOUND',
        'project.delete: current Project was not found.',
        false,
      );
    }
    const nextProject = state.projects[0] ?? null;
    const nextState: AppState = nextProject
      ? {
          ...state,
          project: nextProject,
          projects: state.projects.slice(1),
          undoDelete: null,
        }
      : emptyWorkspaceState;
    return publish(
      nextState,
      [projectId, ...(nextProject ? [nextProject.id] : [])],
    );
  }

  if (command.type === 'project.view.set') {
    if (command.payload.viewMode === state.project.viewMode) {
      return noChanges();
    }
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: state.project.version + 1,
          viewMode: command.payload.viewMode,
          activeReviewRequest: null,
        },
      },
      [state.project.id],
    );
  }

  if (command.type === 'project.update') {
    const title = clean(command.payload.title);
    const description = clean(command.payload.description);
    if (
      Array.from(title).length < 1 ||
      Array.from(title).length > 120 ||
      Array.from(description).length > 1000
    ) {
      return failure(
        'INVALID_INPUT',
        'project.update: title or description is outside the allowed length.',
        true,
      );
    }
    if (
      title === state.project.title &&
      description === state.project.description
    ) {
      return noChanges();
    }
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: state.project.version + 1,
          title,
          description,
          activeReviewRequest: null,
        },
      },
      [state.project.id],
    );
  }

  if (command.type === 'timeline.add') {
    const validated = validateTimelineText(
      command.type,
      command.payload.timeOrCue,
      command.payload.title,
      command.payload.body,
    );
    if (!validated.ok) return validated.result;
    if (state.project.timeline.length >= 30) {
      return failure(
        'LIMIT_EXCEEDED',
        'timeline.add: this Plan already has 30 items.',
        false,
      );
    }
    const itemId = appId('item');
    const projectVersion = state.project.version + 1;
    const request = command.payload.requestReview
      ? makeReviewRequest('item_whatifs', itemId, 1, projectVersion)
      : null;
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: projectVersion,
          timeline: [
            ...state.project.timeline,
            {
              id: itemId,
              version: 1,
              timeOrCue: validated.timeOrCue,
              title: validated.title,
              body: validated.body,
              status: 'draft',
              tags: [],
            },
          ],
          activeReviewRequest: request,
        },
      },
      request ? [itemId, request.id] : [itemId],
    );
  }

  if (command.type === 'timeline.update') {
    const itemId = clean(command.payload.itemId);
    const index = state.project.timeline.findIndex((item) => item.id === itemId);
    if (index < 0) {
      return failure('NOT_FOUND', 'timeline.update: item was not found.', false);
    }
    const validated = validateTimelineText(
      command.type,
      command.payload.timeOrCue,
      command.payload.title,
      command.payload.body,
    );
    if (!validated.ok) return validated.result;

    const current = state.project.timeline[index];
    if (
      validated.timeOrCue === current.timeOrCue &&
      validated.title === current.title &&
      validated.body === current.body
    ) {
      return noChanges();
    }

    const tags = current.tags.map((tag) =>
      tag.lifecycle === 'active'
        ? {
            ...tag,
            version: tag.version + 1,
            needsRecheck: true,
          }
        : tag,
    );
    const updated: TimelineItem = {
      ...current,
      version: current.version + 1,
      timeOrCue: validated.timeOrCue,
      title: validated.title,
      body: validated.body,
      tags,
    };
    const timeline = [...state.project.timeline];
    timeline[index] = updated;
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: state.project.version + 1,
          timeline,
          activeReviewRequest: null,
        },
      },
      [itemId, ...tags.map((tag) => tag.id)],
    );
  }

  if (command.type === 'timeline.move') {
    const itemId = clean(command.payload.itemId);
    return moveEditingOrderEntry(
      { kind: 'item', id: itemId },
      command.payload.direction,
      command.type,
    );
  }

  if (command.type === 'gap.move') {
    const suggestionId = clean(command.payload.suggestionId);
    return moveEditingOrderEntry(
      { kind: 'gap', id: suggestionId },
      command.payload.direction,
      command.type,
    );
  }

  if (command.type === 'timeline.delete') {
    if (state.project.timeline.length === 0) {
      return failure(
        'INVALID_STATE',
        'timeline.delete: there are no Plan items to delete.',
        false,
      );
    }
    const itemId = clean(command.payload.itemId);
    const index = state.project.timeline.findIndex((item) => item.id === itemId);
    if (index < 0) {
      return failure('NOT_FOUND', 'timeline.delete: item was not found.', false);
    }
    const item = state.project.timeline[index];
    const timeline = state.project.timeline.filter((entry) => entry.id !== itemId);
    const anchoredGapSuggestions = state.project.gapSuggestions.filter(
      (gap) => gap.insertAfterItemId === itemId,
    );
    const gapSuggestions = state.project.gapSuggestions.filter(
      (gap) => !anchoredGapSuggestions.some((anchored) => anchored.id === gap.id),
    );
    return publish(
      {
        ...state,
        project: {
          ...state.project,
          version: state.project.version + 1,
          timeline,
          gapSuggestions,
          activeReviewRequest: null,
        },
        undoDelete: { item, index, gapSuggestions: anchoredGapSuggestions },
      },
      [itemId, ...anchoredGapSuggestions.map((gap) => gap.id)],
    );
  }

  if (command.type === 'timeline.undoDelete') {
    const deleted = state.undoDelete;
    if (!deleted) {
      return failure(
        'INVALID_STATE',
        'timeline.undoDelete: there is no deleted item to restore.',
        false,
      );
    }
    if (state.project.timeline.length >= 30) {
      return failure(
        'LIMIT_EXCEEDED',
        'timeline.undoDelete: this Plan already has 30 items.',
        false,
      );
    }
    if (state.project.timeline.some((item) => item.id === deleted.item.id)) {
      return failure(
        'INVALID_STATE',
        'timeline.undoDelete: the item is already present.',
        false,
      );
    }

    const timeline = [...state.project.timeline];
    timeline.splice(Math.min(deleted.index, timeline.length), 0, deleted.item);
    return publish(
      {
        ...state,
        project: {
          ...state.project,
          version: state.project.version + 1,
          timeline,
          gapSuggestions: [
            ...state.project.gapSuggestions,
            ...deleted.gapSuggestions,
          ],
          activeReviewRequest: null,
        },
        undoDelete: null,
      },
      [deleted.item.id, ...deleted.gapSuggestions.map((gap) => gap.id)],
    );
  }

  if (command.type === 'tag.create') {
    return createTag(command);
  }
  if (command.type === 'tag.update') {
    return updateTag(command);
  }
  if (command.type === 'tag.delete') {
    return deleteTag(command);
  }
  if (command.type === 'tag.move') {
    return moveTag(command);
  }
  if (command.type === 'tag.impact.set') {
    return setTagImpact(command);
  }
  if (command.type === 'tags.sortByImpact') {
    return sortTagsByImpact(command);
  }

  if (command.type === 'tag.add') {
    const anchorItemId = clean(command.payload.anchorItemId);
    const question = clean(command.payload.question);
    const caseTitle = clean(command.payload.caseTitle);
    const ownAction = clean(command.payload.ownAction);
    if (
      Array.from(question).length < 1 ||
      Array.from(question).length > 180 ||
      Array.from(caseTitle).length < 1 ||
      Array.from(caseTitle).length > 120 ||
      Array.from(ownAction).length > 1200 ||
      Array.from(question + caseTitle + ownAction).length > 6000
    ) {
      return failure(
        'INVALID_INPUT',
        'tag.add: question, Case, or action is outside the allowed length.',
        true,
      );
    }
    const itemIndex = state.project.timeline.findIndex(
      (item) => item.id === anchorItemId,
    );
    if (itemIndex < 0) {
      return failure('NOT_FOUND', 'tag.add: Plan item was not found.', false);
    }

    const tagId = appId('tag');
    const caseId = appId('case');
    const projectVersion = state.project.version + 1;
    const itemVersion = state.project.timeline[itemIndex].version + 1;
    const tag: MoshimoTag = {
      id: tagId,
      version: 1,
      anchorItemId,
      source: 'human',
      needsRecheck: false,
      lifecycle: 'active',
      basedOnItemVersion: itemVersion,
      basedOnProjectVersion: projectVersion,
      question,
      rationale: 'Added by you to prepare this part of the Plan.',
      summary: 'Decide what you want to do in each situation.',
      impact: null,
      cases: [
        {
          id: caseId,
          version: 1,
          source: 'human',
          title: caseTitle,
          suggestedActions: ownAction ? [ownAction] : [],
          suggestedActionSource: ownAction ? 'human' : null,
          planBOptionsDraft: null,
          response: null,
        },
      ],
    };
    const timeline = [...state.project.timeline];
    const currentItem = timeline[itemIndex];
    timeline[itemIndex] = {
      ...currentItem,
      version: currentItem.version + 1,
      tags: [...currentItem.tags, tag],
    };
    const request = command.payload.requestReview
      ? makeReviewRequest('tag_cases', tagId, tag.version, projectVersion)
      : null;
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: projectVersion,
          timeline,
          activeReviewRequest: request,
        },
      },
      request ? [tagId, caseId, request.id] : [tagId, caseId],
    );
  }

  if (command.type === 'case.create') {
    return createCase(command);
  }
  if (command.type === 'case.update') {
    return updateCase(command);
  }
  if (command.type === 'case.planBOptions.set') {
    return setCasePlanBOptions(command);
  }
  if (command.type === 'case.delete') {
    return deleteCase(command);
  }

  if (command.type === 'case.add') {
    const tagId = clean(command.payload.tagId);
    const title = clean(command.payload.title);
    const ownAction = clean(command.payload.ownAction);
    if (
      Array.from(title).length < 1 ||
      Array.from(title).length > 120 ||
      Array.from(ownAction).length > 1200
    ) {
      return failure(
        'INVALID_INPUT',
        'case.add: title or action is outside the allowed length.',
        true,
      );
    }

    let itemIndex = -1;
    let tagIndex = -1;
    for (const [nextItemIndex, item] of state.project.timeline.entries()) {
      const nextTagIndex = item.tags.findIndex((tag) => tag.id === tagId);
      if (nextTagIndex >= 0) {
        itemIndex = nextItemIndex;
        tagIndex = nextTagIndex;
        break;
      }
    }
    if (itemIndex < 0 || tagIndex < 0) {
      return failure('NOT_FOUND', 'case.add: What if was not found.', false);
    }

    const currentItem = state.project.timeline[itemIndex];
    const currentTag = currentItem.tags[tagIndex];
    if (currentTag.lifecycle !== 'active') {
      return failure(
        'INVALID_STATE',
        'case.add: resolved What if history is read-only.',
        false,
      );
    }
    if (currentTag.cases.length >= 6) {
      return failure(
        'LIMIT_EXCEEDED',
        'case.add: this What if already has six Cases.',
        false,
      );
    }
    const nextTagText = [
      currentTag.question,
      currentTag.rationale,
      currentTag.summary,
      ...currentTag.cases.flatMap((entry) => [
        entry.title,
        ...entry.suggestedActions,
      ]),
      title,
      ownAction,
    ].join('');
    if (Array.from(nextTagText).length > 6000) {
      return failure(
        'LIMIT_EXCEEDED',
        'case.add: this What if has reached its text limit.',
        false,
      );
    }
    const caseId = appId('case');
    const caseItem: MoshimoCase = {
      id: caseId,
      version: 1,
      source: 'human',
      title,
      suggestedActions: ownAction ? [ownAction] : [],
      suggestedActionSource: ownAction ? 'human' : null,
      planBOptionsDraft: null,
      response: null,
    };
    const updatedTag: MoshimoTag = {
      ...currentTag,
      version: currentTag.version + 1,
      cases: [...currentTag.cases, caseItem],
    };
    const tags = [...currentItem.tags];
    tags[tagIndex] = updatedTag;
    const timeline = [...state.project.timeline];
    timeline[itemIndex] = {
      ...currentItem,
      version: currentItem.version + 1,
      tags,
    };
    const projectVersion = state.project.version + 1;
    const request = command.payload.requestReview
      ? makeReviewRequest('case_actions', caseId, 1, projectVersion)
      : null;
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: projectVersion,
          timeline,
          activeReviewRequest: request,
        },
      },
      request ? [tagId, caseId, request.id] : [tagId, caseId],
    );
  }

  if (command.type === 'case.response.save') {
    const caseId = clean(command.payload.caseId);
    const actions = command.payload.actions.map(clean);
    const when = clean(command.payload.when);
    const { disposition, status } = command.payload;
    if (
      actions.some(
        (action) => textLength(action) < 1 || textLength(action) > 1200,
      ) ||
      textLength(actions.join('')) > 4800 ||
      textLength(when) > 120
    ) {
      return failure(
        'INVALID_INPUT',
        'case.response.save: action or timing text is outside the allowed length.',
        true,
      );
    }
    const zeroActionDisposition = disposition === 'dismiss';
    const optionalMemoDisposition =
      disposition === 'covered' || disposition === 'accept';
    const oneActionDisposition = disposition === 'prepare';
    const hasValidShape =
      (zeroActionDisposition && actions.length === 0) ||
      (optionalMemoDisposition && actions.length <= 1) ||
      (oneActionDisposition && actions.length === 1) ||
      (disposition === 'plan_b' && actions.length >= 1 && actions.length <= 5);
    const hasValidPreparationFields =
      disposition === 'prepare'
        ? status === null || isPreparationStatus(status)
        : when === '' && status === null;
    if (!hasValidShape || !hasValidPreparationFields) {
      return failure(
        'INVALID_INPUT',
        'case.response.save: response fields do not match the selected decision.',
        true,
      );
    }

    let itemIndex = -1;
    let tagIndex = -1;
    let caseIndex = -1;
    for (const [nextItemIndex, item] of state.project.timeline.entries()) {
      for (const [nextTagIndex, tag] of item.tags.entries()) {
        const nextCaseIndex = tag.cases.findIndex(
          (caseItem) => caseItem.id === caseId,
        );
        if (nextCaseIndex >= 0) {
          itemIndex = nextItemIndex;
          tagIndex = nextTagIndex;
          caseIndex = nextCaseIndex;
          break;
        }
      }
      if (caseIndex >= 0) break;
    }
    if (itemIndex < 0 || tagIndex < 0 || caseIndex < 0) {
      return failure(
        'NOT_FOUND',
        'case.response.save: Case was not found.',
        false,
      );
    }

    const currentItem = state.project.timeline[itemIndex];
    const currentTag = currentItem.tags[tagIndex];
    if (currentTag.lifecycle !== 'active') {
      return failure(
        'INVALID_STATE',
        'case.response.save: resolved What if history is read-only.',
        false,
      );
    }
    const currentCase = currentTag.cases[caseIndex];
    const response: CaseResponse = { disposition, actions, when, status };
    if (
      currentCase.response?.disposition === response.disposition &&
      currentCase.response.when === response.when &&
      currentCase.response.status === response.status &&
      currentCase.response.actions.length === response.actions.length &&
      currentCase.response.actions.every(
        (action, index) => action === response.actions[index],
      ) &&
      (disposition !== 'plan_b' || currentCase.planBOptionsDraft === null)
    ) {
      return noChanges();
    }

    const cases = [...currentTag.cases];
    cases[caseIndex] = {
      ...currentCase,
      version: currentCase.version + 1,
      planBOptionsDraft:
        disposition === 'plan_b' ? null : currentCase.planBOptionsDraft,
      response,
    };
    const tags = [...currentItem.tags];
    tags[tagIndex] = { ...currentTag, cases };
    const timeline = [...state.project.timeline];
    timeline[itemIndex] = { ...currentItem, tags };
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: state.project.version + 1,
          timeline,
          activeReviewRequest: null,
        },
      },
      [caseId],
    );
  }

  if (command.type === 'gap.add' || command.type === 'gap.ignore') {
    const suggestionId = clean(command.payload.suggestionId);
    const gapIndex = state.project.gapSuggestions.findIndex(
      (suggestion) => suggestion.id === suggestionId,
    );
    if (gapIndex < 0) {
      return failure('NOT_FOUND', `${command.type}: suggestion was not found.`, false);
    }
    const gap = state.project.gapSuggestions[gapIndex];
    if (gap.status !== 'proposed') {
      return failure(
        'INVALID_STATE',
        `${command.type}: suggestion is already ${gap.status}.`,
        false,
      );
    }
    const gapSuggestions = [...state.project.gapSuggestions];
    if (command.type === 'gap.ignore') {
      gapSuggestions[gapIndex] = { ...gap, status: 'ignored' };
      return publish(
        {
          ...state,
          undoDelete: null,
          project: {
            ...state.project,
            version: state.project.version + 1,
            gapSuggestions,
            activeReviewRequest: null,
          },
        },
        [suggestionId],
      );
    }

    if (state.project.timeline.length >= 30) {
      return failure(
        'LIMIT_EXCEEDED',
        'gap.add: this Plan already has 30 items.',
        false,
      );
    }
    const anchorIndex = gap.insertAfterItemId
      ? state.project.timeline.findIndex(
          (item) => item.id === gap.insertAfterItemId,
        )
      : state.project.timeline.length - 1;
    if (gap.insertAfterItemId && anchorIndex < 0) {
      return failure('NOT_FOUND', 'gap.add: insertion anchor was not found.', false);
    }
    const itemId = appId('item');
    const timeline = [...state.project.timeline];
    timeline.splice(anchorIndex + 1, 0, {
      id: itemId,
      version: 1,
      timeOrCue: gap.timeOrCue,
      title: gap.title,
      body: gap.body,
      status: 'draft',
      tags: [],
    });
    gapSuggestions[gapIndex] = { ...gap, status: 'accepted' };
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: state.project.version + 1,
          timeline,
          gapSuggestions,
          activeReviewRequest: null,
        },
      },
      [suggestionId, itemId],
    );
  }

  if (command.type === 'review.suggestions.apply') {
    return applyReviewSuggestions(command);
  }

  if (command.type === 'review.project_plan.apply') {
    const requestId = clean(command.payload.requestId);
    const projectId = clean(command.payload.projectId);
    const request = state.project.activeReviewRequest;
    if (!request || request.id !== requestId) {
      return failure(
        'NOT_FOUND',
        'review.project_plan.apply: active request was not found.',
        false,
      );
    }
    if (request.kind !== 'project_plan') {
      return failure(
        'INVALID_STATE',
        'review.project_plan.apply: active request is for another review.',
        true,
      );
    }
    if (projectId !== state.project.id) {
      return failure(
        'NOT_FOUND',
        'review.project_plan.apply: Project was not found.',
        false,
      );
    }
    if (!isVersion(command.payload.projectVersion)) {
      return failure(
        'INVALID_INPUT',
        'review.project_plan.apply: projectVersion must be a positive integer.',
        true,
      );
    }
    if (
      command.payload.projectVersion !== state.project.version ||
      request.projectVersion !== state.project.version
    ) {
      return failure(
        'VERSION_CONFLICT',
        'review.project_plan.apply: Project or request version is stale.',
        true,
      );
    }
    if (request.ownerVersion !== state.project.version) {
      return failure(
        'VERSION_CONFLICT',
        'review.project_plan.apply: review scope version is stale.',
        true,
      );
    }
    if (request.ownerId !== state.project.id) {
      return failure(
        'INVALID_STATE',
        'review.project_plan.apply: review scope owner does not match the Project.',
        true,
      );
    }
    if (state.project.timeline.length !== 0) {
      return failure(
        'INVALID_STATE',
        'review.project_plan.apply: the Project already has Timeline items.',
        true,
      );
    }

    const validated = validateProjectPlanItems(command.payload.items);
    if (!validated.ok) return validated.result;

    const affectedIds: string[] = [];
    const finalProjectVersion = state.project.version + 1;
    const timeline: TimelineItem[] = validated.items.map((itemInput) => {
      const itemId = appId('item');
      affectedIds.push(itemId);
      const tags: MoshimoTag[] = itemInput.tags.map((tagInput) => {
        const tagId = appId('tag');
        affectedIds.push(tagId);
        const cases: MoshimoCase[] = tagInput.cases.map((caseInput) => {
          const caseId = appId('case');
          affectedIds.push(caseId);
          return {
            id: caseId,
            version: 1,
            source: 'agent',
            title: caseInput.title,
            suggestedActions: [...caseInput.suggestedActions],
            suggestedActionSource: 'agent',
            planBOptionsDraft: null,
            response: null,
          };
        });
        return {
          id: tagId,
          version: 1,
          anchorItemId: itemId,
          source: 'agent',
          needsRecheck: false,
          lifecycle: 'active',
          basedOnItemVersion: 1,
          basedOnProjectVersion: finalProjectVersion,
          question: tagInput.question,
          rationale: tagInput.rationale,
          summary: tagInput.summary,
          impact: tagInput.impact,
          cases,
        };
      });
      return {
        id: itemId,
        version: 1,
        timeOrCue: itemInput.timeOrCue,
        title: itemInput.title,
        body: itemInput.body,
        status: 'draft',
        tags,
      };
    });

    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: finalProjectVersion,
          timeline,
          activeReviewRequest: null,
        },
      },
      [...affectedIds, request.id],
    );
  }

  if (command.type === 'review.request') {
    if (command.payload.kind === 'project_plan') {
      return failure(
        'INVALID_STATE',
        'review.request: project_plan is available only from project.create with requestReview.',
        false,
      );
    }
    if (state.project.activeReviewRequest) {
      return failure(
        'INVALID_STATE',
        'review.request: finish or cancel the active request first.',
        true,
      );
    }
    const ownerId = clean(command.payload.ownerId);
    const owner = resolveReviewOwner(command.payload.kind, ownerId);
    if (!owner) {
      if (isResolvedReviewOwner(command.payload.kind, ownerId)) {
        return failure(
          'INVALID_STATE',
          'review.request: resolved Tag or Case history is read-only.',
          false,
        );
      }
      return failure('NOT_FOUND', 'review.request: scope was not found.', false);
    }
    const projectVersion = state.project.version + 1;
    const ownerVersion =
      command.payload.kind === 'timeline_whatifs' ||
      command.payload.kind === 'timeline_gaps'
        ? projectVersion
        : owner.version;
    const request = makeReviewRequest(
      command.payload.kind,
      owner.id,
      ownerVersion,
      projectVersion,
    );
    return publish(
      {
        ...state,
        undoDelete: null,
        project: {
          ...state.project,
          version: projectVersion,
          activeReviewRequest: request,
        },
      },
      [request.id],
    );
  }

  if (command.type !== 'review.clear') {
    return failure(
      'INVALID_INPUT',
      'command: expected a supported command payload.',
      false,
    );
  }
  const request = state.project.activeReviewRequest;
  const requestId = clean(command.payload.requestId);
  if (!request || request.id !== requestId) {
    return failure('NOT_FOUND', 'review.clear: active request was not found.', false);
  }
  return publish(
    {
      ...state,
      undoDelete: null,
      project: {
        ...state.project,
        version: state.project.version + 1,
        activeReviewRequest: null,
      },
    },
    [request.id],
  );
}
