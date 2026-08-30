import {
  isEmptyWorkspaceProject,
  type AppState,
  type CommandResult,
  type MoshimoCase,
  type MoshimoTag,
  type PlanGapSuggestion,
  type ProjectState,
  type RecheckRequest,
  type ReviewKind,
  type ReviewRequest,
  type TimelineItem,
} from './app-state.ts';

export type WebMcpAvailability =
  | 'checking'
  | 'available'
  | 'failed'
  | 'unavailable';

export type WebMcpActivity = {
  phase: 'reviewing' | 'saving' | 'waiting';
  requestId: string;
  kind: ReviewKind | 'recheck';
};

export interface WebMcpExecuteOptions {
  signal: AbortSignal;
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    input: unknown,
    options: WebMcpExecuteOptions,
  ) => Promise<string>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
}

export interface ModelContextPort {
  registerTool(
    tool: WebMcpTool,
    options?: {
      signal?: AbortSignal;
      exposedTo?: string[];
    },
  ): Promise<unknown>;
}

interface ReviewToolDependencies {
  dispatch: (raw: unknown) => CommandResult;
  getSnapshot: () => AppState;
  onActivity?: (activity: WebMcpActivity) => void;
}

interface ModelContextHost {
  modelContext?: ModelContextPort | null;
}

interface CachedApplyResult {
  fingerprint: string;
  result: string;
}

type NormalReviewKind = Exclude<ReviewKind, 'project_plan'>;

type ReviewTagProposal = {
  anchorItemId: string;
  question: string;
  rationale: string;
  summary: string;
  cases: ReviewCaseProposal[];
};

type ReviewCaseProposal = {
  title: string;
  suggestedActions: string[];
};

type ReviewGapProposal = {
  insertAfterItemId: string | null;
  timeOrCue: string;
  title: string;
  body: string;
};

type ProjectPlanApplyInput = {
  idempotencyKey: string;
  kind: 'project_plan';
  requestId: string;
  projectId: string;
  projectVersion: number;
  items: unknown[];
};

type NormalApplyInput =
  | {
      idempotencyKey: string;
      kind: 'timeline_whatifs' | 'item_whatifs';
      requestId: string;
      projectId: string;
      projectVersion: number;
      tags: ReviewTagProposal[];
    }
  | {
      idempotencyKey: string;
      kind: 'tag_cases';
      requestId: string;
      projectId: string;
      projectVersion: number;
      tagId: string;
      cases: ReviewCaseProposal[];
    }
  | {
      idempotencyKey: string;
      kind: 'case_actions';
      requestId: string;
      projectId: string;
      projectVersion: number;
      caseId: string;
      suggestedActions: string[];
    }
  | {
      idempotencyKey: string;
      kind: 'timeline_gaps';
      requestId: string;
      projectId: string;
      projectVersion: number;
      gaps: ReviewGapProposal[];
    };

type ApplyInput = ProjectPlanApplyInput | NormalApplyInput;

type RecheckOutcomeProposal =
  | {
      tagId: string;
      tagVersion: number;
      outcome: 'retain' | 'resolve';
    }
  | {
      tagId: string;
      tagVersion: number;
      outcome: 'replace';
      replacement: ReviewTagProposal;
    };

type TagRecheckApplyInput = {
  idempotencyKey: string;
  requestId: string;
  projectId: string;
  projectVersion: number;
  outcomes: RecheckOutcomeProposal[];
};

type ValidationFailure = {
  ok: false;
  code: 'DUPLICATE' | 'INVALID_INPUT' | 'LIMIT_EXCEEDED';
  message: string;
};

type ValidationSuccess<T> = { ok: true; value: T };

type ValidationResult<T> = ValidationFailure | ValidationSuccess<T>;

const PROJECT_PLAN_LIMITS = {
  items: [1, 12],
  tagsPerItem: [1, 2],
  casesPerTag: [1, 4],
  suggestedActionsPerCase: [1, 5],
} as const;

const NORMAL_REVIEW_LIMITS = {
  tags: [1, 5],
  casesPerTag: [1, 6],
  suggestedActionsPerCase: [1, 5],
  gaps: [0, 3],
} as const;

const READ_OUTPUT_LIMIT = 12_000;
const APPLY_CACHE_LIMIT = 64;

const APPLY_KEYS = [
  'idempotencyKey',
  'kind',
  'requestId',
  'projectId',
  'projectVersion',
  'items',
];

const SHARED_APPLY_KEYS = [
  'idempotencyKey',
  'kind',
  'projectId',
  'projectVersion',
  'requestId',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function notifyActivity(
  dependencies: ReviewToolDependencies,
  activity: WebMcpActivity,
): void {
  try {
    dependencies.onActivity?.(activity);
  } catch {
    // Activity feedback is UI-only and must not change the tool result.
  }
}

function isSuccessfulResult(result: string): boolean {
  try {
    const parsed: unknown = JSON.parse(result);
    return isRecord(parsed) && parsed.ok === true;
  } catch {
    return false;
  }
}

function notifyReviewActivityAfterSuccess(
  result: string,
  dependencies: ReviewToolDependencies,
  requestId: string,
  kind: ReviewKind | 'recheck',
): string {
  if (isSuccessfulResult(result)) {
    notifyActivity(dependencies, { phase: 'reviewing', requestId, kind });
  }
  return result;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function textLength(value: string): number {
  return Array.from(value).length;
}

function clean(value: string): string {
  return value.normalize('NFC').trim();
}

function isNonEmptyId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = clean(value);
  return textLength(normalized) >= 1 && textLength(normalized) <= 160;
}

function errorResult(
  code:
    | 'CANCELLED'
    | 'DUPLICATE'
    | 'INVALID_INPUT'
    | 'INVALID_STATE'
    | 'LIMIT_EXCEEDED'
    | 'NOT_FOUND'
    | 'OUTPUT_LIMIT'
    | 'SAVE_FAILED'
    | 'UNAVAILABLE'
    | 'VERSION_CONFLICT',
  message: string,
  retryable: boolean,
): string {
  return JSON.stringify({ ok: false, code, message, retryable });
}

function isAborted(options: WebMcpExecuteOptions | undefined): boolean {
  return options?.signal?.aborted === true;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = stableValue(value[key]);
  }
  return sorted;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(stableValue(value));
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

function applyActivityIdentity(
  input: unknown,
  kind: 'review' | 'recheck',
): { requestId: string; kind: ReviewKind | 'recheck' } | null {
  if (!isRecord(input) || !isNonEmptyId(input.requestId)) return null;
  if (kind === 'recheck') return { requestId: input.requestId, kind };
  return isReviewKind(input.kind)
    ? { requestId: input.requestId, kind: input.kind }
    : null;
}

function notifyApplyActivity(
  dependencies: ReviewToolDependencies,
  identity: { requestId: string; kind: ReviewKind | 'recheck' } | null,
  phase: 'saving' | 'waiting',
): void {
  if (identity) notifyActivity(dependencies, { ...identity, phase });
}

function isBoundedText(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  if (typeof value !== 'string') return false;
  const normalized = clean(value);
  return textLength(normalized) >= minimum && textLength(normalized) <= maximum;
}

function invalidInput(message: string): ValidationFailure {
  return { ok: false, code: 'INVALID_INPUT', message };
}

function limitExceeded(message: string): ValidationFailure {
  return { ok: false, code: 'LIMIT_EXCEEDED', message };
}

function duplicateInput(message: string): ValidationFailure {
  return { ok: false, code: 'DUPLICATE', message };
}

function isVersion(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

function validateReviewCase(
  value: unknown,
): ValidationResult<ReviewCaseProposal> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['suggestedActions', 'title']) ||
    !isBoundedText(value.title, 1, 120) ||
    !Array.isArray(value.suggestedActions)
  ) {
    return invalidInput(
      'apply_review_suggestions: each Case needs a title and suggestedActions.',
    );
  }
  if (value.suggestedActions.length < 1) {
    return invalidInput(
      'apply_review_suggestions: each agent Case needs a suggested action.',
    );
  }
  if (value.suggestedActions.length > NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1]) {
    return limitExceeded(
      'apply_review_suggestions: a Case has too many suggested actions.',
    );
  }
  if (
    !value.suggestedActions.every((action) =>
      isBoundedText(action, 1, 1200),
    ) ||
    textLength((value.suggestedActions as string[]).join('')) > 4800
  ) {
    return invalidInput(
      'apply_review_suggestions: suggested action text is outside the allowed length.',
    );
  }
  return {
    ok: true,
    value: {
      title: value.title,
      suggestedActions: [...value.suggestedActions] as string[],
    },
  };
}

function validateReviewCases(
  value: unknown,
): ValidationResult<ReviewCaseProposal[]> {
  if (!Array.isArray(value)) {
    return invalidInput(
      'apply_review_suggestions: cases must be an array.',
    );
  }
  if (value.length < NORMAL_REVIEW_LIMITS.casesPerTag[0]) {
    return invalidInput(
      'apply_review_suggestions: at least one Case is required.',
    );
  }
  if (value.length > NORMAL_REVIEW_LIMITS.casesPerTag[1]) {
    return limitExceeded(
      'apply_review_suggestions: a What if has too many Cases.',
    );
  }
  const cases: ReviewCaseProposal[] = [];
  for (const rawCase of value) {
    const result = validateReviewCase(rawCase);
    if (!result.ok) return result;
    cases.push(result.value);
  }
  return { ok: true, value: cases };
}

function validateReviewTag(
  value: unknown,
): ValidationResult<ReviewTagProposal> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'anchorItemId',
      'cases',
      'question',
      'rationale',
      'summary',
    ]) ||
    !isNonEmptyId(value.anchorItemId) ||
    !isBoundedText(value.question, 1, 180) ||
    !isBoundedText(value.rationale, 1, 400) ||
    !isBoundedText(value.summary, 1, 400)
  ) {
    return invalidInput(
      'apply_review_suggestions: each What if needs bounded text and an anchorItemId.',
    );
  }
  const cases = validateReviewCases(value.cases);
  if (!cases.ok) return cases;
  const tagText = [
    value.question,
    value.rationale,
    value.summary,
    ...cases.value.flatMap((caseItem) => [
      caseItem.title,
      ...caseItem.suggestedActions,
    ]),
  ].join('');
  if (textLength(tagText) > 6000) {
    return limitExceeded(
      'apply_review_suggestions: a What if has reached its text limit.',
    );
  }
  return {
    ok: true,
    value: {
      anchorItemId: value.anchorItemId,
      question: value.question,
      rationale: value.rationale,
      summary: value.summary,
      cases: cases.value,
    },
  };
}

function validateReviewTags(
  value: unknown,
): ValidationResult<ReviewTagProposal[]> {
  if (!Array.isArray(value)) {
    return invalidInput(
      'apply_review_suggestions: tags must be an array.',
    );
  }
  if (value.length < NORMAL_REVIEW_LIMITS.tags[0]) {
    return invalidInput(
      'apply_review_suggestions: at least one What if is required.',
    );
  }
  if (value.length > NORMAL_REVIEW_LIMITS.tags[1]) {
    return limitExceeded(
      'apply_review_suggestions: too many What ifs were proposed.',
    );
  }
  const tags: ReviewTagProposal[] = [];
  for (const rawTag of value) {
    const result = validateReviewTag(rawTag);
    if (!result.ok) return result;
    tags.push(result.value);
  }
  return { ok: true, value: tags };
}

function validateSuggestedActions(
  value: unknown,
): ValidationResult<string[]> {
  if (!Array.isArray(value)) {
    return invalidInput(
      'apply_review_suggestions: suggestedActions must be an array.',
    );
  }
  if (value.length < NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[0]) {
    return invalidInput(
      'apply_review_suggestions: at least one suggested action is required.',
    );
  }
  if (value.length > NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1]) {
    return limitExceeded(
      'apply_review_suggestions: too many suggested actions were proposed.',
    );
  }
  if (
    !value.every((action) => isBoundedText(action, 1, 1200)) ||
    textLength((value as string[]).join('')) > 4800
  ) {
    return invalidInput(
      'apply_review_suggestions: suggested action text is outside the allowed length.',
    );
  }
  return { ok: true, value: [...value] as string[] };
}

function validateReviewGaps(
  value: unknown,
): ValidationResult<ReviewGapProposal[]> {
  if (!Array.isArray(value)) {
    return invalidInput(
      'apply_review_suggestions: gaps must be an array.',
    );
  }
  if (value.length > NORMAL_REVIEW_LIMITS.gaps[1]) {
    return limitExceeded(
      'apply_review_suggestions: too many gap suggestions were proposed.',
    );
  }
  const gaps: ReviewGapProposal[] = [];
  for (const rawGap of value) {
    if (
      !isRecord(rawGap) ||
      !hasExactKeys(rawGap, ['body', 'insertAfterItemId', 'timeOrCue', 'title']) ||
      (rawGap.insertAfterItemId !== null &&
        !isNonEmptyId(rawGap.insertAfterItemId)) ||
      !isBoundedText(rawGap.timeOrCue, 0, 40) ||
      !isBoundedText(rawGap.title, 1, 120) ||
      !isBoundedText(rawGap.body, 1, 1200)
    ) {
      return invalidInput(
        'apply_review_suggestions: each gap needs a bounded anchor, title, and body.',
      );
    }
    gaps.push({
      insertAfterItemId: rawGap.insertAfterItemId,
      timeOrCue: rawGap.timeOrCue,
      title: rawGap.title,
      body: rawGap.body,
    });
  }
  return { ok: true, value: gaps };
}

function validateApplyInput(input: unknown): ValidationResult<ApplyInput> {
  if (
    !isRecord(input) ||
    !SHARED_APPLY_KEYS.every((key) =>
      Object.prototype.hasOwnProperty.call(input, key),
    )
  ) {
    return invalidInput(
      'apply_review_suggestions: expected one strict review proposal shape.',
    );
  }
  if (
    !isIdempotencyKey(input.idempotencyKey) ||
    !isReviewKind(input.kind) ||
    !isNonEmptyId(input.requestId) ||
    !isNonEmptyId(input.projectId) ||
    typeof input.projectVersion !== 'number' ||
    !Number.isSafeInteger(input.projectVersion) ||
    input.projectVersion < 1
  ) {
    return invalidInput(
      'apply_review_suggestions: request identifiers and version are invalid.',
    );
  }

  if (input.kind === 'project_plan') {
    if (!hasExactKeys(input, APPLY_KEYS) || !Array.isArray(input.items)) {
      return invalidInput(
        'apply_review_suggestions: expected the project_plan proposal shape.',
      );
    }
    return {
      ok: true,
      value: {
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        requestId: input.requestId,
        projectId: input.projectId,
        projectVersion: input.projectVersion,
        items: input.items,
      },
    };
  }

  if (
    (input.kind === 'timeline_whatifs' || input.kind === 'item_whatifs') &&
    !hasExactKeys(input, [...SHARED_APPLY_KEYS, 'tags'])
  ) {
    return invalidInput(
      'apply_review_suggestions: expected a Tag proposal shape for this review.',
    );
  }
  if (input.kind === 'timeline_whatifs' || input.kind === 'item_whatifs') {
    const tags = validateReviewTags(input.tags);
    if (!tags.ok) return tags;
    return {
      ok: true,
      value: {
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        requestId: input.requestId,
        projectId: input.projectId,
        projectVersion: input.projectVersion,
        tags: tags.value,
      },
    };
  }

  if (input.kind === 'tag_cases') {
    if (
      !hasExactKeys(input, [...SHARED_APPLY_KEYS, 'cases', 'tagId']) ||
      !isNonEmptyId(input.tagId)
    ) {
      return invalidInput(
        'apply_review_suggestions: expected a Tag Case proposal shape.',
      );
    }
    const cases = validateReviewCases(input.cases);
    if (!cases.ok) return cases;
    return {
      ok: true,
      value: {
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        requestId: input.requestId,
        projectId: input.projectId,
        projectVersion: input.projectVersion,
        tagId: input.tagId,
        cases: cases.value,
      },
    };
  }

  if (input.kind === 'case_actions') {
    if (
      !hasExactKeys(input, [...SHARED_APPLY_KEYS, 'caseId', 'suggestedActions']) ||
      !isNonEmptyId(input.caseId)
    ) {
      return invalidInput(
        'apply_review_suggestions: expected a Case action proposal shape.',
      );
    }
    const suggestedActions = validateSuggestedActions(input.suggestedActions);
    if (!suggestedActions.ok) return suggestedActions;
    return {
      ok: true,
      value: {
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        requestId: input.requestId,
        projectId: input.projectId,
        projectVersion: input.projectVersion,
        caseId: input.caseId,
        suggestedActions: suggestedActions.value,
      },
    };
  }

  if (
    !hasExactKeys(input, [...SHARED_APPLY_KEYS, 'gaps'])
  ) {
    return invalidInput(
      'apply_review_suggestions: expected a gap proposal shape.',
    );
  }
  const gaps = validateReviewGaps(input.gaps);
  if (!gaps.ok) return gaps;
  return {
    ok: true,
    value: {
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      requestId: input.requestId,
      projectId: input.projectId,
      projectVersion: input.projectVersion,
      gaps: gaps.value,
    },
  };
}

function projectPlanRequestIsCurrent(project: ProjectState): boolean {
  const request = project.activeReviewRequest;
  return (
    request !== null &&
    request.kind === 'project_plan' &&
    request.ownerId === project.id &&
    request.ownerVersion === project.version &&
    request.projectVersion === project.version
  );
}

interface ResolvedReviewScope {
  item?: TimelineItem;
  tag?: MoshimoTag;
  caseItem?: MoshimoCase;
}

function resolveReviewScope(
  project: ProjectState,
  request: ReviewRequest,
): ResolvedReviewScope | null {
  if (
    request.kind === 'project_plan' ||
    request.kind === 'timeline_whatifs' ||
    request.kind === 'timeline_gaps'
  ) {
    return request.ownerId === project.id ? {} : null;
  }

  for (const item of project.timeline) {
    if (request.kind === 'item_whatifs' && request.ownerId === item.id) {
      return { item };
    }
    for (const tag of item.tags) {
      if (tag.lifecycle === 'resolved') continue;
      if (request.kind === 'tag_cases' && request.ownerId === tag.id) {
        return { item, tag };
      }
      if (request.kind === 'case_actions') {
        const caseItem = tag.cases.find(
          (candidate) => candidate.id === request.ownerId,
        );
        if (caseItem) return { item, tag, caseItem };
      }
    }
  }
  return null;
}

function reviewRequestIsCurrent(
  project: ProjectState,
  request: ReviewRequest,
): boolean {
  if (request.projectVersion !== project.version) return false;
  if (request.kind === 'project_plan') {
    return projectPlanRequestIsCurrent(project);
  }
  const scope = resolveReviewScope(project, request);
  if (!scope) return false;
  if (
    request.kind === 'timeline_whatifs' ||
    request.kind === 'timeline_gaps'
  ) {
    return (
      request.ownerId === project.id && request.ownerVersion === project.version
    );
  }
  if (request.kind === 'item_whatifs') {
    return scope.item?.version === request.ownerVersion;
  }
  if (request.kind === 'tag_cases') {
    return scope.tag?.version === request.ownerVersion;
  }
  return scope.caseItem?.version === request.ownerVersion;
}

function projectCaseContext(caseItem: MoshimoCase) {
  return {
    id: caseItem.id,
    version: caseItem.version,
    title: caseItem.title,
    suggestedActions: [...caseItem.suggestedActions],
  };
}

function projectTagContext(tag: MoshimoTag) {
  return {
    id: tag.id,
    version: tag.version,
    anchorItemId: tag.anchorItemId,
    question: tag.question,
    rationale: tag.rationale,
    summary: tag.summary,
    needsRecheck: tag.needsRecheck,
    existingCases: tag.cases.map(projectCaseContext),
  };
}

function projectItemSummary(item: TimelineItem) {
  return {
    id: item.id,
    version: item.version,
    timeOrCue: item.timeOrCue,
    title: item.title,
    body: item.body,
    status: item.status,
  };
}

function projectItemContext(item: TimelineItem) {
  return {
    ...projectItemSummary(item),
    existingWhatIfs: item.tags
      .filter((tag) => tag.lifecycle !== 'resolved')
      .map(projectTagContext),
  };
}

function projectGapContext(gap: PlanGapSuggestion) {
  return {
    id: gap.id,
    source: gap.source,
    insertAfterItemId: gap.insertAfterItemId,
    timeOrCue: gap.timeOrCue,
    title: gap.title,
    body: gap.body,
    status: gap.status,
  };
}

function requestContext(request: ReviewRequest) {
  return {
    id: request.id,
    kind: request.kind,
    ownerId: request.ownerId,
    ownerVersion: request.ownerVersion,
    projectVersion: request.projectVersion,
  };
}

function recheckRequestContext(request: RecheckRequest) {
  return {
    id: request.id,
    projectVersion: request.projectVersion,
    tags: request.tags.map((tag) => ({
      tagId: tag.tagId,
      tagVersion: tag.tagVersion,
      itemId: tag.itemId,
      itemVersion: tag.itemVersion,
    })),
  };
}

function projectContext(project: ProjectState) {
  return {
    id: project.id,
    title: project.title,
    brief: project.description,
    version: project.version,
    timelineItemCount: project.timeline.length,
  };
}

function findTagLocation(
  project: ProjectState,
  tagId: string,
): { item: TimelineItem; tag: MoshimoTag } | null {
  for (const item of project.timeline) {
    const tag = item.tags.find((candidate) => candidate.id === tagId);
    if (tag) return { item, tag };
  }
  return null;
}

function recheckRequestIsCurrent(
  project: ProjectState,
  request: RecheckRequest,
): boolean {
  if (
    project.activeReviewRequest !== null ||
    !isNonEmptyId(request.id) ||
    !isVersion(request.projectVersion) ||
    request.projectVersion !== project.version ||
    !Array.isArray(request.tags) ||
    request.tags.length < 1 ||
    request.tags.length > 5
  ) {
    return false;
  }

  const seenTagIds = new Set<string>();
  for (const requestedTag of request.tags) {
    if (
      !isNonEmptyId(requestedTag.tagId) ||
      !isVersion(requestedTag.tagVersion) ||
      !isNonEmptyId(requestedTag.itemId) ||
      !isVersion(requestedTag.itemVersion) ||
      seenTagIds.has(requestedTag.tagId)
    ) {
      return false;
    }
    seenTagIds.add(requestedTag.tagId);
    const location = findTagLocation(project, requestedTag.tagId);
    if (
      !location ||
      location.item.id !== requestedTag.itemId ||
      location.item.version !== requestedTag.itemVersion ||
      location.tag.version !== requestedTag.tagVersion ||
      location.tag.lifecycle !== 'active' ||
      !location.tag.needsRecheck ||
      location.tag.anchorItemId !== location.item.id
    ) {
      return false;
    }
  }
  return true;
}

function staleTagContext(tag: MoshimoTag) {
  return projectTagContext(tag);
}

function staleItemContext(
  item: TimelineItem,
  staleTags: MoshimoTag[],
) {
  return {
    ...projectItemSummary(item),
    staleWhatIfs: staleTags.map(staleTagContext),
  };
}

function normalReviewLimits(kind: NormalReviewKind) {
  if (kind === 'timeline_whatifs' || kind === 'item_whatifs') {
    return {
      tags: [...NORMAL_REVIEW_LIMITS.tags],
      casesPerTag: [...NORMAL_REVIEW_LIMITS.casesPerTag],
      suggestedActionsPerCase: [
        ...NORMAL_REVIEW_LIMITS.suggestedActionsPerCase,
      ],
    };
  }
  if (kind === 'tag_cases') {
    return {
      casesPerTag: [...NORMAL_REVIEW_LIMITS.casesPerTag],
      suggestedActionsPerCase: [
        ...NORMAL_REVIEW_LIMITS.suggestedActionsPerCase,
      ],
    };
  }
  if (kind === 'case_actions') {
    return {
      suggestedActionsPerCase: [
        ...NORMAL_REVIEW_LIMITS.suggestedActionsPerCase,
      ],
    };
  }
  return { gaps: [...NORMAL_REVIEW_LIMITS.gaps] };
}

function boundedJson(value: unknown, toolName: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return errorResult(
      'UNAVAILABLE',
      `${toolName}: context could not be serialized.`,
      false,
    );
  }
  if (serialized === undefined) {
    return errorResult(
      'UNAVAILABLE',
      `${toolName}: context could not be serialized.`,
      false,
    );
  }
  if (textLength(serialized) > READ_OUTPUT_LIMIT) {
    return errorResult(
      'OUTPUT_LIMIT',
      `${toolName}: context exceeds the output limit.`,
      false,
    );
  }
  return serialized;
}

function readReviewContext(
  input: unknown,
  options: WebMcpExecuteOptions,
  dependencies: ReviewToolDependencies,
): string {
  if (isAborted(options)) {
    return errorResult(
      'CANCELLED',
      'get_review_context: execution was cancelled.',
      true,
    );
  }

  if (
    !isRecord(input) ||
    !(
      hasExactKeys(input, []) ||
      hasExactKeys(input, ['requestId'])
    ) ||
    (Object.prototype.hasOwnProperty.call(input, 'requestId') &&
      !isNonEmptyId(input.requestId))
  ) {
    return errorResult(
      'INVALID_INPUT',
      'get_review_context: expected an optional requestId.',
      true,
    );
  }

  let snapshot: AppState;
  try {
    snapshot = dependencies.getSnapshot();
  } catch {
    return errorResult(
      'UNAVAILABLE',
      'get_review_context: current Project is unavailable.',
      true,
    );
  }

  const project = snapshot.project;
  const request = project.activeReviewRequest;
  if (!request) {
    return errorResult(
      'NOT_FOUND',
      'get_review_context: no active review request was found.',
      false,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(input, 'requestId') &&
    input.requestId !== request.id
  ) {
    return errorResult(
      'NOT_FOUND',
      'get_review_context: the requested review was not found.',
      false,
    );
  }
  if (!reviewRequestIsCurrent(project, request)) {
    return errorResult(
      'INVALID_STATE',
      'get_review_context: the review request is stale or no longer owned by the current scope.',
      true,
    );
  }

  const common = {
    ok: true as const,
    request: requestContext(request),
    project: projectContext(project),
  };

  if (request.kind === 'project_plan') {
    if (project.timeline.length !== 0) {
      return errorResult(
        'INVALID_STATE',
        'get_review_context: the project_plan request is already populated.',
        true,
      );
    }
    return notifyReviewActivityAfterSuccess(
      boundedJson(
        {
          ...common,
          limits: {
            items: [...PROJECT_PLAN_LIMITS.items],
            tagsPerItem: [...PROJECT_PLAN_LIMITS.tagsPerItem],
            casesPerTag: [...PROJECT_PLAN_LIMITS.casesPerTag],
            suggestedActionsPerCase: [
              ...PROJECT_PLAN_LIMITS.suggestedActionsPerCase,
            ],
          },
        },
        'get_review_context',
      ),
      dependencies,
      request.id,
      request.kind,
    );
  }

  const scope = resolveReviewScope(project, request);
  if (!scope) {
    return errorResult(
      'INVALID_STATE',
      'get_review_context: the review owner was not found.',
      true,
    );
  }

  if (request.kind === 'timeline_whatifs' || request.kind === 'timeline_gaps') {
    const scopeValue =
      request.kind === 'timeline_gaps'
        ? {
            timeline: project.timeline.map(projectItemContext),
            existingGapSuggestions:
              project.gapSuggestions.map(projectGapContext),
          }
        : { timeline: project.timeline.map(projectItemContext) };
    return notifyReviewActivityAfterSuccess(
      boundedJson(
        {
          ...common,
          scope: scopeValue,
          limits: normalReviewLimits(request.kind),
        },
        'get_review_context',
      ),
      dependencies,
      request.id,
      request.kind,
    );
  }

  if (request.kind === 'item_whatifs') {
    if (!scope.item) {
      return errorResult(
        'INVALID_STATE',
        'get_review_context: the requested Timeline item was not found.',
        true,
      );
    }
    return notifyReviewActivityAfterSuccess(
      boundedJson(
        {
          ...common,
          scope: { item: projectItemContext(scope.item) },
          limits: normalReviewLimits(request.kind),
        },
        'get_review_context',
      ),
      dependencies,
      request.id,
      request.kind,
    );
  }

  if (request.kind === 'tag_cases') {
    if (!scope.item || !scope.tag) {
      return errorResult(
        'INVALID_STATE',
        'get_review_context: the requested What if was not found.',
        true,
      );
    }
    return notifyReviewActivityAfterSuccess(
      boundedJson(
        {
          ...common,
          scope: {
            item: projectItemSummary(scope.item),
            tag: projectTagContext(scope.tag),
          },
          limits: normalReviewLimits(request.kind),
        },
        'get_review_context',
      ),
      dependencies,
      request.id,
      request.kind,
    );
  }

  if (!scope.item || !scope.tag || !scope.caseItem) {
    return errorResult(
      'INVALID_STATE',
      'get_review_context: the requested Case was not found.',
      true,
    );
  }
  return notifyReviewActivityAfterSuccess(
    boundedJson(
      {
        ...common,
        scope: {
          item: projectItemSummary(scope.item),
          tag: projectTagContext(scope.tag),
          case: projectCaseContext(scope.caseItem),
        },
        limits: normalReviewLimits(request.kind),
      },
      'get_review_context',
    ),
    dependencies,
    request.id,
    request.kind,
  );
}

function validateStaleReadInput(
  input: unknown,
): ValidationResult<{ requestId?: string; tagIds?: string[] }> {
  if (
    !isRecord(input) ||
    (!hasExactKeys(input, []) &&
      !hasExactKeys(input, ['requestId']) &&
      !hasExactKeys(input, ['tagIds']) &&
      !hasExactKeys(input, ['requestId', 'tagIds'])) ||
    (Object.prototype.hasOwnProperty.call(input, 'requestId') &&
      !isNonEmptyId(input.requestId))
  ) {
    return invalidInput(
      'get_stale_tag_context: expected an optional requestId and Tag ID subset.',
    );
  }

  if (!Object.prototype.hasOwnProperty.call(input, 'tagIds')) {
    return {
      ok: true,
      value: Object.prototype.hasOwnProperty.call(input, 'requestId')
        ? { requestId: input.requestId as string }
        : {},
    };
  }

  if (!Array.isArray(input.tagIds)) {
    return invalidInput(
      'get_stale_tag_context: tagIds must be an array when supplied.',
    );
  }
  if (input.tagIds.length < 1) {
    return invalidInput(
      'get_stale_tag_context: tagIds must contain at least one Tag ID.',
    );
  }
  if (input.tagIds.length > 5) {
    return limitExceeded(
      'get_stale_tag_context: at most five Tag IDs may be requested.',
    );
  }
  if (!input.tagIds.every(isNonEmptyId)) {
    return invalidInput(
      'get_stale_tag_context: each Tag ID must be a bounded string.',
    );
  }
  const tagIds = [...input.tagIds] as string[];
  if (new Set(tagIds).size !== tagIds.length) {
    return duplicateInput(
      'get_stale_tag_context: each Tag ID may be requested only once.',
    );
  }
  return {
    ok: true,
    value: Object.prototype.hasOwnProperty.call(input, 'requestId')
      ? { requestId: input.requestId as string, tagIds }
      : { tagIds },
  };
}

function readStaleTagContext(
  input: unknown,
  options: WebMcpExecuteOptions,
  dependencies: ReviewToolDependencies,
): string {
  if (isAborted(options)) {
    return errorResult(
      'CANCELLED',
      'get_stale_tag_context: execution was cancelled.',
      true,
    );
  }

  const validation = validateStaleReadInput(input);
  if (!validation.ok) {
    return errorResult(
      validation.code,
      validation.message,
      validation.code !== 'LIMIT_EXCEEDED' && validation.code !== 'DUPLICATE',
    );
  }

  let snapshot: AppState;
  try {
    snapshot = dependencies.getSnapshot();
  } catch {
    return errorResult(
      'UNAVAILABLE',
      'get_stale_tag_context: current Project is unavailable.',
      true,
    );
  }

  const project = snapshot.project;
  const request = project.activeRecheckRequest;
  if (
    !request ||
    (validation.value.requestId !== undefined &&
      request.id !== validation.value.requestId)
  ) {
    return errorResult(
      'NOT_FOUND',
      'get_stale_tag_context: active recheck request was not found.',
      false,
    );
  }
  if (!recheckRequestIsCurrent(project, request)) {
    return errorResult(
      'INVALID_STATE',
      'get_stale_tag_context: the recheck request is stale or no longer owned by the current Project.',
      true,
    );
  }

  const selectedTagIds = new Set(
    validation.value.tagIds ?? request.tags.map((tag) => tag.tagId),
  );
  const requestTagIds = new Set(request.tags.map((tag) => tag.tagId));
  for (const tagId of selectedTagIds) {
    if (!requestTagIds.has(tagId)) {
      return errorResult(
        'INVALID_STATE',
        'get_stale_tag_context: a requested Tag is outside the active recheck scope.',
        true,
      );
    }
  }

  const items = project.timeline.flatMap((item) => {
    const staleTags = item.tags.filter((tag) => selectedTagIds.has(tag.id));
    return staleTags.length ? [staleItemContext(item, staleTags)] : [];
  });

  return notifyReviewActivityAfterSuccess(
    boundedJson(
      {
        ok: true,
        request: recheckRequestContext(request),
        project: projectContext(project),
        scope: { items },
        limits: {
          tags: [...NORMAL_REVIEW_LIMITS.tags],
          casesPerTag: [...NORMAL_REVIEW_LIMITS.casesPerTag],
          suggestedActionsPerCase: [
            ...NORMAL_REVIEW_LIMITS.suggestedActionsPerCase,
          ],
        },
      },
      'get_stale_tag_context',
    ),
    dependencies,
    request.id,
    'recheck',
  );
}

function isIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 100 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function validateRecheckOutcome(
  value: unknown,
): ValidationResult<RecheckOutcomeProposal> {
  if (
    !isRecord(value) ||
    !isNonEmptyId(value.tagId) ||
    !isVersion(value.tagVersion) ||
    typeof value.outcome !== 'string'
  ) {
    return invalidInput(
      'apply_tag_recheck: each outcome needs a bounded tagId, tagVersion, and outcome.',
    );
  }

  if (value.outcome === 'retain' || value.outcome === 'resolve') {
    if (!hasExactKeys(value, ['outcome', 'tagId', 'tagVersion'])) {
      return invalidInput(
        'apply_tag_recheck: retain and resolve outcomes do not accept extra fields.',
      );
    }
    return {
      ok: true,
      value: {
        tagId: value.tagId,
        tagVersion: value.tagVersion,
        outcome: value.outcome,
      },
    };
  }

  if (
    value.outcome !== 'replace' ||
    !hasExactKeys(value, ['outcome', 'replacement', 'tagId', 'tagVersion'])
  ) {
    return invalidInput(
      'apply_tag_recheck: outcome must be retain, resolve, or replace with an exact replacement.',
    );
  }

  const replacement = validateReviewTag(value.replacement);
  if (!replacement.ok) {
    return {
      ok: false,
      code: replacement.code,
      message: replacement.message.replace(
        'apply_review_suggestions',
        'apply_tag_recheck',
      ),
    };
  }
  return {
    ok: true,
    value: {
      tagId: value.tagId,
      tagVersion: value.tagVersion,
      outcome: 'replace',
      replacement: replacement.value,
    },
  };
}

function validateRecheckOutcomes(
  value: unknown,
): ValidationResult<RecheckOutcomeProposal[]> {
  if (!Array.isArray(value)) {
    return invalidInput('apply_tag_recheck: outcomes must be an array.');
  }
  if (value.length < 1) {
    return invalidInput(
      'apply_tag_recheck: at least one Tag outcome is required.',
    );
  }
  if (value.length > 5) {
    return limitExceeded(
      'apply_tag_recheck: at most five Tag outcomes may be supplied.',
    );
  }

  const outcomes: RecheckOutcomeProposal[] = [];
  const tagIds = new Set<string>();
  for (const rawOutcome of value) {
    const outcome = validateRecheckOutcome(rawOutcome);
    if (!outcome.ok) return outcome;
    if (tagIds.has(outcome.value.tagId)) {
      return duplicateInput(
        'apply_tag_recheck: each Tag may have only one outcome.',
      );
    }
    tagIds.add(outcome.value.tagId);
    outcomes.push(outcome.value);
  }
  return { ok: true, value: outcomes };
}

function validateTagRecheckApplyInput(
  input: unknown,
): ValidationResult<TagRecheckApplyInput> {
  const expectedKeys = [
    'idempotencyKey',
    'outcomes',
    'projectId',
    'projectVersion',
    'requestId',
  ];
  if (
    !isRecord(input) ||
    !hasExactKeys(input, expectedKeys) ||
    !isIdempotencyKey(input.idempotencyKey) ||
    !isNonEmptyId(input.requestId) ||
    !isNonEmptyId(input.projectId) ||
    !isVersion(input.projectVersion)
  ) {
    return invalidInput(
      'apply_tag_recheck: expected the strict idempotency, request, Project, version, and outcomes shape.',
    );
  }

  const outcomes = validateRecheckOutcomes(input.outcomes);
  if (!outcomes.ok) return outcomes;
  return {
    ok: true,
    value: {
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      projectId: input.projectId,
      projectVersion: input.projectVersion,
      outcomes: outcomes.value,
    },
  };
}

function normalApplyRequest(
  input: NormalApplyInput,
  dependencies: ReviewToolDependencies,
): { ok: true; request: ReviewRequest } | { ok: false; result: string } {
  let snapshot: AppState;
  try {
    snapshot = dependencies.getSnapshot();
  } catch {
    return {
      ok: false,
      result: errorResult(
        'UNAVAILABLE',
        'apply_review_suggestions: current Project is unavailable.',
        true,
      ),
    };
  }

  const project = snapshot.project;
  const request = project.activeReviewRequest;
  if (!request || request.id !== input.requestId) {
    return {
      ok: false,
      result: errorResult(
        'NOT_FOUND',
        'apply_review_suggestions: active review request was not found.',
        false,
      ),
    };
  }
  if (request.kind !== input.kind) {
    return {
      ok: false,
      result: errorResult(
        'INVALID_STATE',
        'apply_review_suggestions: active request is for another review.',
        true,
      ),
    };
  }
  if (input.projectId !== project.id) {
    return {
      ok: false,
      result: errorResult(
        'NOT_FOUND',
        'apply_review_suggestions: Project was not found.',
        false,
      ),
    };
  }
  if (input.projectVersion !== project.version) {
    return {
      ok: false,
      result: errorResult(
        'VERSION_CONFLICT',
        'apply_review_suggestions: Project version is stale.',
        true,
      ),
    };
  }
  if (!reviewRequestIsCurrent(project, request)) {
    return {
      ok: false,
      result: errorResult(
        'INVALID_STATE',
        'apply_review_suggestions: Project or review request is stale.',
        true,
      ),
    };
  }
  return { ok: true, request };
}

function normalApplyPayload(
  input: NormalApplyInput,
  request: ReviewRequest,
): Record<string, unknown> {
  const common = {
    kind: input.kind,
    request: requestContext(request),
    projectId: input.projectId,
    projectVersion: input.projectVersion,
  };
  if (input.kind === 'timeline_whatifs' || input.kind === 'item_whatifs') {
    return { ...common, tags: input.tags };
  }
  if (input.kind === 'tag_cases') {
    return { ...common, tagId: input.tagId, cases: input.cases };
  }
  if (input.kind === 'case_actions') {
    return {
      ...common,
      caseId: input.caseId,
      suggestedActions: input.suggestedActions,
    };
  }
  const gapInput = input as Extract<NormalApplyInput, { kind: 'timeline_gaps' }>;
  return { ...common, gaps: gapInput.gaps };
}

function cacheSuccessfulApply(
  cache: Map<string, CachedApplyResult>,
  key: string,
  value: CachedApplyResult,
) {
  cache.set(key, value);
  while (cache.size > APPLY_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function executeApplyReviewSuggestions(
  input: unknown,
  options: WebMcpExecuteOptions,
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): string {
  if (isAborted(options)) {
    return errorResult(
      'CANCELLED',
      'apply_review_suggestions: execution was cancelled.',
      true,
    );
  }

  const validation = validateApplyInput(input);
  if (!validation.ok) {
    return errorResult(
      validation.code,
      validation.message,
      validation.code !== 'LIMIT_EXCEEDED' && validation.code !== 'DUPLICATE',
    );
  }
  const validatedInput = validation.value;

  let inputFingerprint: string;
  try {
    inputFingerprint = fingerprint(input);
  } catch {
    return errorResult(
      'INVALID_INPUT',
      'apply_review_suggestions: proposal could not be read.',
      true,
    );
  }

  const previous = cache.get(validatedInput.idempotencyKey);
  if (previous) {
    if (previous.fingerprint === inputFingerprint) return previous.result;
    return errorResult(
      'DUPLICATE',
      'apply_review_suggestions: idempotencyKey was already used for another proposal.',
      false,
    );
  }

  if (isAborted(options)) {
    return errorResult(
      'CANCELLED',
      'apply_review_suggestions: execution was cancelled.',
      true,
    );
  }

  let command: Record<string, unknown>;
  if (validatedInput.kind === 'project_plan') {
    command = {
      type: 'review.project_plan.apply',
      payload: {
        requestId: validatedInput.requestId,
        projectId: validatedInput.projectId,
        projectVersion: validatedInput.projectVersion,
        items: validatedInput.items,
      },
    };
  } else {
    const currentRequest = normalApplyRequest(validatedInput, dependencies);
    if (!currentRequest.ok) return currentRequest.result;
    if (isAborted(options)) {
      return errorResult(
        'CANCELLED',
        'apply_review_suggestions: execution was cancelled.',
        true,
      );
    }
    command = {
      type: 'review.suggestions.apply',
      payload: normalApplyPayload(validatedInput, currentRequest.request),
    };
  }

  let result: CommandResult;
  try {
    result = dependencies.dispatch(command);
  } catch {
    return errorResult(
      'UNAVAILABLE',
      'apply_review_suggestions: the Project command could not be completed.',
      true,
    );
  }

  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    return errorResult(
      'UNAVAILABLE',
      'apply_review_suggestions: the command returned no result.',
      true,
    );
  }
  if (result.ok) {
    cacheSuccessfulApply(cache, validatedInput.idempotencyKey, {
      fingerprint: inputFingerprint,
      result: serialized,
    });
  }
  return serialized;
}

function applyReviewSuggestions(
  input: unknown,
  options: WebMcpExecuteOptions,
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): string {
  const identity = applyActivityIdentity(input, 'review');
  notifyApplyActivity(dependencies, identity, 'saving');
  const result = executeApplyReviewSuggestions(
    input,
    options,
    dependencies,
    cache,
  );
  if (!isSuccessfulResult(result)) {
    notifyApplyActivity(dependencies, identity, 'waiting');
  }
  return result;
}

function executeApplyTagRecheck(
  input: unknown,
  options: WebMcpExecuteOptions,
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): string {
  if (isAborted(options)) {
    return errorResult(
      'CANCELLED',
      'apply_tag_recheck: execution was cancelled.',
      true,
    );
  }

  const validation = validateTagRecheckApplyInput(input);
  if (!validation.ok) {
    return errorResult(
      validation.code,
      validation.message,
      validation.code !== 'LIMIT_EXCEEDED' && validation.code !== 'DUPLICATE',
    );
  }
  const validatedInput = validation.value;

  let inputFingerprint: string;
  try {
    inputFingerprint = fingerprint(input);
  } catch {
    return errorResult(
      'INVALID_INPUT',
      'apply_tag_recheck: proposal could not be read.',
      true,
    );
  }

  const previous = cache.get(validatedInput.idempotencyKey);
  if (previous) {
    if (previous.fingerprint === inputFingerprint) return previous.result;
    return errorResult(
      'DUPLICATE',
      'apply_tag_recheck: idempotencyKey was already used for another proposal.',
      false,
    );
  }

  if (isAborted(options)) {
    return errorResult(
      'CANCELLED',
      'apply_tag_recheck: execution was cancelled.',
      true,
    );
  }

  let snapshot: AppState;
  try {
    snapshot = dependencies.getSnapshot();
  } catch {
    return errorResult(
      'UNAVAILABLE',
      'apply_tag_recheck: current Project is unavailable.',
      true,
    );
  }

  const project = snapshot.project;
  const request = project.activeRecheckRequest;
  if (!request || request.id !== validatedInput.requestId) {
    return errorResult(
      'NOT_FOUND',
      'apply_tag_recheck: active recheck request was not found.',
      false,
    );
  }
  if (validatedInput.projectId !== project.id) {
    return errorResult(
      'NOT_FOUND',
      'apply_tag_recheck: Project was not found.',
      false,
    );
  }
  if (validatedInput.projectVersion !== project.version) {
    return errorResult(
      'VERSION_CONFLICT',
      'apply_tag_recheck: Project version is stale.',
      true,
    );
  }
  if (
    project.activeReviewRequest ||
    !recheckRequestIsCurrent(project, request)
  ) {
    return errorResult(
      'INVALID_STATE',
      'apply_tag_recheck: Project or recheck request is stale.',
      true,
    );
  }

  if (validatedInput.outcomes.length !== request.tags.length) {
    return errorResult(
      'INVALID_STATE',
      'apply_tag_recheck: exactly one outcome is required for every requested Tag.',
      true,
    );
  }

  const requestedTagIds = new Set(request.tags.map((tag) => tag.tagId));
  for (const outcome of validatedInput.outcomes) {
    if (!requestedTagIds.has(outcome.tagId)) {
      return errorResult(
        'INVALID_STATE',
        'apply_tag_recheck: outcome contains a Tag outside the active request.',
        true,
      );
    }
    const requestedTag = request.tags.find(
      (tag) => tag.tagId === outcome.tagId,
    );
    if (!requestedTag || requestedTag.tagVersion !== outcome.tagVersion) {
      return errorResult(
        'INVALID_STATE',
        'apply_tag_recheck: a requested Tag version is stale.',
        true,
      );
    }
    if (outcome.outcome === 'replace') {
      const location = findTagLocation(project, outcome.tagId);
      if (!location || outcome.replacement.anchorItemId !== location.item.id) {
        return errorResult(
          'INVALID_STATE',
          'apply_tag_recheck: replacement anchor is outside the stale Tag scope.',
          true,
        );
      }
    }
  }

  if (isAborted(options)) {
    return errorResult(
      'CANCELLED',
      'apply_tag_recheck: execution was cancelled.',
      true,
    );
  }

  let result: CommandResult;
  try {
    result = dependencies.dispatch({
      type: 'recheck.apply',
      payload: {
        request,
        projectId: validatedInput.projectId,
        projectVersion: validatedInput.projectVersion,
        outcomes: validatedInput.outcomes,
      },
    });
  } catch {
    return errorResult(
      'UNAVAILABLE',
      'apply_tag_recheck: the Project command could not be completed.',
      true,
    );
  }

  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    return errorResult(
      'UNAVAILABLE',
      'apply_tag_recheck: the command returned no result.',
      true,
    );
  }
  if (result.ok) {
    cacheSuccessfulApply(cache, validatedInput.idempotencyKey, {
      fingerprint: inputFingerprint,
      result: serialized,
    });
  }
  return serialized;
}

function applyTagRecheck(
  input: unknown,
  options: WebMcpExecuteOptions,
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): string {
  const identity = applyActivityIdentity(input, 'recheck');
  notifyApplyActivity(dependencies, identity, 'saving');
  const result = executeApplyTagRecheck(
    input,
    options,
    dependencies,
    cache,
  );
  if (!isSuccessfulResult(result)) {
    notifyApplyActivity(dependencies, identity, 'waiting');
  }
  return result;
}

function createGetReviewContextTool(
  dependencies: ReviewToolDependencies,
): WebMcpTool {
  return {
    name: 'get_review_context',
    title: 'Read review context',
    description:
      'Read the current explicitly requested review scope and its bounded proposal limits.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          description: 'Optional active review request ID.',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      untrustedContentHint: true,
    },
    execute: async (input, options) =>
      readReviewContext(input, options, dependencies),
  };
}

function createApplyReviewSuggestionsTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  const sharedProperties = {
    idempotencyKey: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      pattern: '^[\\x21-\\x7e]+$',
    },
    requestId: { type: 'string', minLength: 1, maxLength: 160 },
    projectId: { type: 'string', minLength: 1, maxLength: 160 },
    projectVersion: { type: 'integer', minimum: 1 },
  };
  const projectPlanCaseSchema = {
    type: 'object',
    required: ['title', 'suggestedActions'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 },
      suggestedActions: {
        type: 'array',
        minItems: 1,
        maxItems: PROJECT_PLAN_LIMITS.suggestedActionsPerCase[1],
        items: { type: 'string', minLength: 1, maxLength: 1200 },
      },
    },
  };
  const projectPlanTagSchema = {
    type: 'object',
    required: ['question', 'rationale', 'summary', 'cases'],
    additionalProperties: false,
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 180 },
      rationale: { type: 'string', minLength: 1, maxLength: 400 },
      summary: { type: 'string', minLength: 1, maxLength: 400 },
      cases: {
        type: 'array',
        minItems: 1,
        maxItems: PROJECT_PLAN_LIMITS.casesPerTag[1],
        items: projectPlanCaseSchema,
      },
    },
  };
  const projectPlanItemSchema = {
    type: 'object',
    required: ['timeOrCue', 'title', 'body', 'tags'],
    additionalProperties: false,
    properties: {
      timeOrCue: { type: 'string', maxLength: 40 },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      body: { type: 'string', maxLength: 1200 },
      tags: {
        type: 'array',
        minItems: PROJECT_PLAN_LIMITS.tagsPerItem[0],
        maxItems: PROJECT_PLAN_LIMITS.tagsPerItem[1],
        items: projectPlanTagSchema,
      },
    },
  };
  const normalCaseSchema = {
    type: 'object',
    required: ['title', 'suggestedActions'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 },
      suggestedActions: {
        type: 'array',
        minItems: NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[0],
        maxItems: NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1],
        items: { type: 'string', minLength: 1, maxLength: 1200 },
      },
    },
  };
  const normalTagSchema = {
    type: 'object',
    required: [
      'anchorItemId',
      'question',
      'rationale',
      'summary',
      'cases',
    ],
    additionalProperties: false,
    properties: {
      anchorItemId: { type: 'string', minLength: 1, maxLength: 160 },
      question: { type: 'string', minLength: 1, maxLength: 180 },
      rationale: { type: 'string', minLength: 1, maxLength: 400 },
      summary: { type: 'string', minLength: 1, maxLength: 400 },
      cases: {
        type: 'array',
        minItems: NORMAL_REVIEW_LIMITS.casesPerTag[0],
        maxItems: NORMAL_REVIEW_LIMITS.casesPerTag[1],
        items: normalCaseSchema,
      },
    },
  };
  const shared = (kind: NormalReviewKind, extra: Record<string, unknown>) => ({
    type: 'object',
    required: [
      ...SHARED_APPLY_KEYS,
      ...Object.keys(extra),
    ],
    additionalProperties: false,
    properties: {
      ...sharedProperties,
      kind: { type: 'string', const: kind },
      ...extra,
    },
  });

  return {
    name: 'apply_review_suggestions',
    title: 'Apply review suggestions',
    description:
      'Apply one validated proposal for the explicitly requested project_plan, What if, Case, or gap review.',
    inputSchema: {
      oneOf: [
        {
          type: 'object',
          required: [...SHARED_APPLY_KEYS, 'items'],
          additionalProperties: false,
          properties: {
            ...sharedProperties,
            kind: { type: 'string', const: 'project_plan' },
            items: {
              type: 'array',
              minItems: PROJECT_PLAN_LIMITS.items[0],
              maxItems: PROJECT_PLAN_LIMITS.items[1],
              items: projectPlanItemSchema,
            },
          },
        },
        shared('timeline_whatifs', {
          tags: {
            type: 'array',
            minItems: NORMAL_REVIEW_LIMITS.tags[0],
            maxItems: NORMAL_REVIEW_LIMITS.tags[1],
            items: normalTagSchema,
          },
        }),
        shared('item_whatifs', {
          tags: {
            type: 'array',
            minItems: NORMAL_REVIEW_LIMITS.tags[0],
            maxItems: NORMAL_REVIEW_LIMITS.tags[1],
            items: normalTagSchema,
          },
        }),
        shared('tag_cases', {
          tagId: { type: 'string', minLength: 1, maxLength: 160 },
          cases: {
            type: 'array',
            minItems: NORMAL_REVIEW_LIMITS.casesPerTag[0],
            maxItems: NORMAL_REVIEW_LIMITS.casesPerTag[1],
            items: normalCaseSchema,
          },
        }),
        shared('case_actions', {
          caseId: { type: 'string', minLength: 1, maxLength: 160 },
          suggestedActions: {
            type: 'array',
            minItems: NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[0],
            maxItems: NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1],
            items: { type: 'string', minLength: 1, maxLength: 1200 },
          },
        }),
        shared('timeline_gaps', {
          gaps: {
            type: 'array',
            minItems: NORMAL_REVIEW_LIMITS.gaps[0],
            maxItems: NORMAL_REVIEW_LIMITS.gaps[1],
            items: {
              type: 'object',
              required: ['insertAfterItemId', 'timeOrCue', 'title', 'body'],
              additionalProperties: false,
              properties: {
                insertAfterItemId: {
                  type: ['string', 'null'],
                  maxLength: 160,
                },
                timeOrCue: { type: 'string', maxLength: 40 },
                title: { type: 'string', minLength: 1, maxLength: 120 },
                body: { type: 'string', minLength: 1, maxLength: 1200 },
              },
            },
          },
        }),
      ],
    },
    annotations: {
      readOnlyHint: false,
      untrustedContentHint: true,
    },
    execute: async (input, options) =>
      applyReviewSuggestions(input, options, dependencies, cache),
  };
}

function createGetStaleTagContextTool(
  dependencies: ReviewToolDependencies,
): WebMcpTool {
  return {
    name: 'get_stale_tag_context',
    title: 'Read stale What if context',
    description:
      'Read the current explicitly requested stale What if scope and its bounded recheck proposal limits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requestId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          description: 'Optional active stale recheck request ID.',
        },
        tagIds: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          description: 'Optional subset of Tags captured by the request.',
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      untrustedContentHint: true,
    },
    execute: async (input, options) =>
      readStaleTagContext(input, options, dependencies),
  };
}

function createApplyTagRecheckTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  const replacementCaseSchema = {
    type: 'object',
    required: ['title', 'suggestedActions'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 },
      suggestedActions: {
        type: 'array',
        minItems: NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[0],
        maxItems: NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1],
        items: { type: 'string', minLength: 1, maxLength: 1200 },
      },
    },
  };
  const replacementSchema = {
    type: 'object',
    required: ['anchorItemId', 'question', 'rationale', 'summary', 'cases'],
    additionalProperties: false,
    properties: {
      anchorItemId: { type: 'string', minLength: 1, maxLength: 160 },
      question: { type: 'string', minLength: 1, maxLength: 180 },
      rationale: { type: 'string', minLength: 1, maxLength: 400 },
      summary: { type: 'string', minLength: 1, maxLength: 400 },
      cases: {
        type: 'array',
        minItems: NORMAL_REVIEW_LIMITS.casesPerTag[0],
        maxItems: NORMAL_REVIEW_LIMITS.casesPerTag[1],
        items: replacementCaseSchema,
      },
    },
  };
  const outcomeProperties = {
    tagId: { type: 'string', minLength: 1, maxLength: 160 },
    tagVersion: { type: 'integer', minimum: 1 },
  };

  return {
    name: 'apply_tag_recheck',
    title: 'Apply stale What if recheck',
    description:
      'Apply one validated retain, resolve, or replacement outcome for each explicitly requested stale What if.',
    inputSchema: {
      type: 'object',
      required: [
        'idempotencyKey',
        'requestId',
        'projectId',
        'projectVersion',
        'outcomes',
      ],
      additionalProperties: false,
      properties: {
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          pattern: '^[\\x21-\\x7e]+$',
        },
        requestId: { type: 'string', minLength: 1, maxLength: 160 },
        projectId: { type: 'string', minLength: 1, maxLength: 160 },
        projectVersion: { type: 'integer', minimum: 1 },
        outcomes: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            oneOf: [
              {
                type: 'object',
                required: ['tagId', 'tagVersion', 'outcome'],
                additionalProperties: false,
                properties: {
                  ...outcomeProperties,
                  outcome: { type: 'string', const: 'retain' },
                },
              },
              {
                type: 'object',
                required: ['tagId', 'tagVersion', 'outcome'],
                additionalProperties: false,
                properties: {
                  ...outcomeProperties,
                  outcome: { type: 'string', const: 'resolve' },
                },
              },
              {
                type: 'object',
                required: ['tagId', 'tagVersion', 'outcome', 'replacement'],
                additionalProperties: false,
                properties: {
                  ...outcomeProperties,
                  outcome: { type: 'string', const: 'replace' },
                  replacement: replacementSchema,
                },
              },
            ],
          },
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      untrustedContentHint: true,
    },
    execute: async (input, options) =>
      applyTagRecheck(input, options, dependencies, cache),
  };
}

export function createReviewTools(
  dependencies: ReviewToolDependencies,
): WebMcpTool[] {
  const cache = new Map<string, CachedApplyResult>();
  return [
    createGetReviewContextTool(dependencies),
    createApplyReviewSuggestionsTool(dependencies, cache),
    createGetStaleTagContextTool(dependencies),
    createApplyTagRecheckTool(dependencies, cache),
  ];
}

export function registerReviewTools(
  host: ModelContextHost,
  dependencies: ReviewToolDependencies,
  onAvailability: (availability: WebMcpAvailability) => void = () => {},
  onActivity?: (activity: WebMcpActivity) => void,
): () => void {
  const modelContext = host.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== 'function') {
    onAvailability('unavailable');
    return () => {};
  }

  onAvailability('checking');
  const controller = new AbortController();
  let disposed = false;
  const tools = createReviewTools(
    onActivity ? { ...dependencies, onActivity } : dependencies,
  );

  void (async () => {
    try {
      await Promise.all(
        tools.map((tool) =>
          modelContext.registerTool(tool, { signal: controller.signal }),
        ),
      );
      if (!disposed) onAvailability('available');
    } catch {
      controller.abort();
      if (!disposed) onAvailability('failed');
    }
  })();

  return () => {
    disposed = true;
    controller.abort();
  };
}

/*
 * Direct Site tools
 *
 * The request-bound review tools above are retained as dormant implementation
 * assets.  The current page registers the small, direct Project/Plan/What-if/
 * Case surface below instead.
 */

type SiteImpact = {
  rank: 1 | 2 | 3 | 4 | 5;
  expectedLossAmount: number | null;
  currency: string | null;
  penalty: string;
};

type SitePlanCaseInput = {
  title: string;
  suggestedActions: string[];
};

type SitePlanTagInput = {
  question: string;
  rationale: string;
  summary: string;
  impact?: SiteImpact | null;
  cases: SitePlanCaseInput[];
};

type SitePlanItemInput = {
  timeOrCue: string;
  title: string;
  body: string;
  tags: SitePlanTagInput[];
};

type SiteResponseInput = {
  disposition: 'covered' | 'accept' | 'prepare' | 'plan_b' | 'dismiss';
  actions: string[];
  when: string;
  status: 'pending' | 'done' | null;
};

type SiteMutationBase = {
  idempotencyKey: string;
  projectId: string;
  projectVersion: number;
};

type SiteCreateProjectInput = SiteMutationBase & {
  title: string;
  description: string;
  items?: SitePlanItemInput[];
};

type SiteOpenProjectInput = SiteMutationBase & { targetProjectId: string };

type SiteUpdateProjectInput = SiteMutationBase & {
  title: string;
  description: string;
};

type SiteSetProjectViewInput = SiteMutationBase & {
  viewMode: 'editing' | 'final';
};

type SiteEditPlanInput =
  | (SiteMutationBase & {
      operation: 'add';
      timeOrCue: string;
      title: string;
      body: string;
    })
  | (SiteMutationBase & {
      operation: 'update';
      itemId: string;
      itemVersion: number;
      timeOrCue: string;
      title: string;
      body: string;
    })
  | (SiteMutationBase & {
      operation: 'move';
      itemId: string;
      itemVersion: number;
      direction: 'up' | 'down';
    })
  | (SiteMutationBase & {
      operation: 'delete';
      itemId: string;
      itemVersion: number;
    });

type SiteEditWhatIfInput =
  | (SiteMutationBase & {
      operation: 'add';
      itemId: string;
      itemVersion: number;
      question: string;
      rationale: string;
      summary: string;
      cases: SitePlanCaseInput[];
      impact?: SiteImpact | null;
    })
  | (SiteMutationBase & {
      operation: 'update';
      tagId: string;
      tagVersion: number;
      question: string;
      rationale: string;
      summary: string;
    })
  | (SiteMutationBase & {
      operation: 'delete';
      tagId: string;
      tagVersion: number;
    })
  | (SiteMutationBase & {
      operation: 'set_impact';
      tagId: string;
      tagVersion: number;
      impact: SiteImpact | null;
    })
  | (SiteMutationBase & {
      operation: 'sort_by_impact';
      itemId: string;
      itemVersion: number;
    });

type SiteEditCaseInput =
  | (SiteMutationBase & {
      operation: 'add';
      tagId: string;
      tagVersion: number;
      title: string;
      suggestedActions: string[];
    })
  | (SiteMutationBase & {
      operation: 'update';
      caseId: string;
      caseVersion: number;
      title: string;
      suggestedActions: string[];
    })
  | (SiteMutationBase & {
      operation: 'delete';
      caseId: string;
      caseVersion: number;
    });

type SiteEditPlanBOptionsInput =
  | (SiteMutationBase & {
      operation: 'replace';
      caseId: string;
      caseVersion: number;
      options: string[];
    })
  | (SiteMutationBase & {
      operation: 'add';
      caseId: string;
      caseVersion: number;
      option: string;
    })
  | (SiteMutationBase & {
      operation: 'update';
      caseId: string;
      caseVersion: number;
      optionNumber: number;
      option: string;
    })
  | (SiteMutationBase & {
      operation: 'delete';
      caseId: string;
      caseVersion: number;
      optionNumber: number;
    })
  | (SiteMutationBase & {
      operation: 'discard';
      caseId: string;
      caseVersion: number;
    });

type SiteMutationInput =
  | SiteCreateProjectInput
  | SiteOpenProjectInput
  | SiteUpdateProjectInput
  | SiteSetProjectViewInput
  | SiteEditPlanInput
  | SiteEditWhatIfInput
  | SiteEditCaseInput
  | SiteEditPlanBOptionsInput;

type SiteTagState = MoshimoTag & { impact?: SiteImpact | null };

type ExportProjection = 'human_summary' | 'timeline' | 'case_matrix' | 'runbook';
type ExportEntryScope = 'selected_only' | 'candidates' | 'all';
type ExportEntryKind = 'candidate' | 'selected';
type ExportColumn =
  | 'plan_order'
  | 'time_or_cue'
  | 'plan_title'
  | 'plan_body'
  | 'what_if'
  | 'case'
  | 'entry_scope'
  | 'decision'
  | 'candidate_actions'
  | 'response_actions'
  | 'when'
  | 'status'
  | 'impact_rank'
  | 'expected_loss_amount'
  | 'currency'
  | 'penalty';

type ExportProjectionInput = {
  projectId?: string;
  projection: ExportProjection;
  entryScope: ExportEntryScope;
  columns?: ExportColumn[];
};

type HumanSummaryColumn = {
  key:
    | 'time_or_cue'
    | 'plan'
    | 'plan_details'
    | 'what_if'
    | 'case'
    | 'selection'
    | 'decision'
    | 'candidate_actions'
    | 'saved_response'
    | 'when'
    | 'status'
    | 'impact';
  label: string;
};

type ProjectOutputEntry = {
  whatIf: string;
  case: string;
  entryScope: ExportEntryKind;
  decision: 'covered' | 'accept' | 'prepare' | 'plan_b' | null;
  candidateActions: string[];
  responseActions: string[];
  when: string;
  status: 'pending' | 'done' | null;
  impact: {
    rank: 1 | 2 | 3 | 4 | 5;
    expectedLossAmount: number | null;
    currency: string | null;
    penalty: string;
  } | null;
};

const EXPORT_COLUMNS = [
  'plan_order',
  'time_or_cue',
  'plan_title',
  'plan_body',
  'what_if',
  'case',
  'entry_scope',
  'decision',
  'candidate_actions',
  'response_actions',
  'when',
  'status',
  'impact_rank',
  'expected_loss_amount',
  'currency',
  'penalty',
] as const satisfies readonly ExportColumn[];

const HUMAN_SUMMARY_COLUMNS = [
  { key: 'time_or_cue', label: 'Time / cue' },
  { key: 'plan', label: 'Plan' },
  { key: 'plan_details', label: 'Plan details' },
  { key: 'what_if', label: 'What if' },
  { key: 'case', label: 'Case' },
  { key: 'selection', label: 'Selection' },
  { key: 'decision', label: 'Decision' },
  { key: 'candidate_actions', label: 'Candidate actions' },
  { key: 'saved_response', label: 'Saved response' },
  { key: 'when', label: 'When' },
  { key: 'status', label: 'Status' },
  { key: 'impact', label: 'Impact' },
] as const satisfies readonly HumanSummaryColumn[];

function siteHasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function siteParseBase(
  input: unknown,
  operation: string,
  extraRequired: string[] = [],
  extraOptional: string[] = [],
):
  | { ok: true; value: Record<string, unknown> }
  | ValidationFailure {
  const baseRequired = ['idempotencyKey', 'projectId', 'projectVersion'];
  const allowed = [...baseRequired, ...extraRequired, ...extraOptional];
  if (
    !isRecord(input) ||
    !siteHasOnlyKeys(input, allowed) ||
    !baseRequired.every((key) =>
      Object.prototype.hasOwnProperty.call(input, key),
    ) ||
    !extraRequired.every((key) =>
      Object.prototype.hasOwnProperty.call(input, key),
    ) ||
    !isIdempotencyKey(input.idempotencyKey) ||
    !isNonEmptyId(input.projectId) ||
    !isVersion(input.projectVersion)
  ) {
    return invalidInput(`${operation}: expected the strict Project/version shape.`);
  }
  return { ok: true, value: input };
}

function siteParseText(
  value: unknown,
  minimum: number,
  maximum: number,
): string | null {
  return isBoundedText(value, minimum, maximum) ? clean(value) : null;
}

function siteParseVersionedId(
  value: Record<string, unknown>,
  operation: string,
  idName: string,
  versionName: string,
): ValidationResult<{ id: string; version: number }> {
  const id = value[idName];
  const version = value[versionName];
  if (!isNonEmptyId(id) || !isVersion(version)) {
    return invalidInput(
      `${operation}: ${idName} and ${versionName} must be current bounded values.`,
    );
  }
  return { ok: true, value: { id, version } };
}

function siteParsePlanCase(
  value: unknown,
  operation: string,
  allowEmptyActions: boolean,
): ValidationResult<SitePlanCaseInput> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['suggestedActions', 'title']) ||
    !isBoundedText(value.title, 1, 120) ||
    !Array.isArray(value.suggestedActions)
  ) {
    return invalidInput(`${operation}: each Case needs a strict title/actions shape.`);
  }
  const actions = value.suggestedActions;
  if (
    actions.length > NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1] ||
    (!allowEmptyActions && actions.length < 1) ||
    !actions.every((action) => isBoundedText(action, 1, 1200)) ||
    textLength((actions as unknown[]).join('')) > 4800
  ) {
    return actions.length > NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1]
      ? limitExceeded(`${operation}: a Case has too many suggested actions.`)
      : invalidInput(`${operation}: Case actions are outside the allowed bounds.`);
  }
  return {
    ok: true,
    value: {
      title: clean(value.title),
      suggestedActions: actions.map((action) => clean(action as string)),
    },
  };
}

function siteParsePlanCases(
  value: unknown,
  operation: string,
  minimum: number,
  maximum: number,
  allowEmptyActions: boolean,
): ValidationResult<SitePlanCaseInput[]> {
  if (!Array.isArray(value)) {
    return invalidInput(`${operation}: cases must be an array.`);
  }
  if (value.length < minimum) {
    return invalidInput(`${operation}: at least ${minimum} Case is required.`);
  }
  if (value.length > maximum) {
    return limitExceeded(`${operation}: too many Cases were supplied.`);
  }
  const cases: SitePlanCaseInput[] = [];
  for (const rawCase of value) {
    const parsed = siteParsePlanCase(rawCase, operation, allowEmptyActions);
    if (!parsed.ok) return parsed;
    cases.push(parsed.value);
  }
  return { ok: true, value: cases };
}

function siteParsePlanItems(
  value: unknown,
  operation: string,
): ValidationResult<SitePlanItemInput[]> {
  if (!Array.isArray(value)) {
    return invalidInput(`${operation}: items must be an array.`);
  }
  if (value.length < PROJECT_PLAN_LIMITS.items[0]) {
    return invalidInput(`${operation}: at least one Plan item is required.`);
  }
  if (value.length > PROJECT_PLAN_LIMITS.items[1]) {
    return limitExceeded(`${operation}: at most twelve Plan items are supported.`);
  }
  const items: SitePlanItemInput[] = [];
  for (const rawItem of value) {
    if (
      !isRecord(rawItem) ||
      !hasExactKeys(rawItem, ['body', 'tags', 'timeOrCue', 'title'])
    ) {
      return invalidInput(`${operation}: each Plan item needs an exact text/tags shape.`);
    }
    const timeOrCue = siteParseText(rawItem.timeOrCue, 0, 40);
    const title = siteParseText(rawItem.title, 1, 120);
    const body = siteParseText(rawItem.body, 0, 1200);
    if (timeOrCue === null || title === null || body === null) {
      return invalidInput(`${operation}: Plan text is outside the allowed bounds.`);
    }
    if (!Array.isArray(rawItem.tags)) {
      return invalidInput(`${operation}: each Plan item needs a Tags array.`);
    }
    if (
      rawItem.tags.length < PROJECT_PLAN_LIMITS.tagsPerItem[0] ||
      rawItem.tags.length > PROJECT_PLAN_LIMITS.tagsPerItem[1]
    ) {
      return rawItem.tags.length > PROJECT_PLAN_LIMITS.tagsPerItem[1]
        ? limitExceeded(`${operation}: each Plan item may have at most two What-ifs.`)
        : invalidInput(`${operation}: each Plan item needs a What-if.`);
    }
    const tags: SitePlanTagInput[] = [];
    for (const rawTag of rawItem.tags) {
      if (
        !isRecord(rawTag) ||
        (!hasExactKeys(rawTag, ['cases', 'question', 'rationale', 'summary']) &&
          !hasExactKeys(rawTag, [
            'cases',
            'impact',
            'question',
            'rationale',
            'summary',
          ]))
      ) {
        return invalidInput(`${operation}: each What-if needs an exact text/Cases shape.`);
      }
      const question = siteParseText(rawTag.question, 1, 180);
      const rationale = siteParseText(rawTag.rationale, 1, 400);
      const summary = siteParseText(rawTag.summary, 1, 400);
      if (question === null || rationale === null || summary === null) {
        return invalidInput(`${operation}: What-if text is outside the allowed bounds.`);
      }
      const parsedCases = siteParsePlanCases(
        rawTag.cases,
        operation,
        PROJECT_PLAN_LIMITS.casesPerTag[0],
        PROJECT_PLAN_LIMITS.casesPerTag[1],
        false,
      );
      if (!parsedCases.ok) return parsedCases;
      let impact: SiteImpact | null | undefined;
      if (Object.prototype.hasOwnProperty.call(rawTag, 'impact')) {
        const parsedImpact = siteParseImpact(rawTag.impact, operation);
        if (!parsedImpact.ok) return parsedImpact;
        impact = parsedImpact.value;
      }
      tags.push({
        question,
        rationale,
        summary,
        cases: parsedCases.value,
        ...(impact === undefined ? {} : { impact }),
      });
    }
    items.push({ timeOrCue, title, body, tags });
  }
  return { ok: true, value: items };
}

function siteParseImpact(
  value: unknown,
  operation: string,
): ValidationResult<SiteImpact | null> {
  if (value === null) return { ok: true, value: null };
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'currency',
      'expectedLossAmount',
      'penalty',
      'rank',
    ]) ||
    !Number.isSafeInteger(value.rank) ||
    Number(value.rank) < 1 ||
    Number(value.rank) > 5 ||
    (value.expectedLossAmount !== null &&
      (typeof value.expectedLossAmount !== 'number' ||
        !Number.isFinite(value.expectedLossAmount) ||
        value.expectedLossAmount < 0)) ||
    (value.currency !== null &&
      (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))) ||
    (value.expectedLossAmount === null) !== (value.currency === null) ||
    !isBoundedText(value.penalty, 0, 240)
  ) {
    return invalidInput(`${operation}: impact must match the bounded rank/amount/currency shape.`);
  }
  return {
    ok: true,
    value: {
      rank: value.rank as 1 | 2 | 3 | 4 | 5,
      expectedLossAmount: value.expectedLossAmount as number | null,
      currency: value.currency as string | null,
      penalty: clean(value.penalty),
    },
  };
}

function siteImpactProjection(tag: MoshimoTag): SiteImpact | null {
  const impact = (tag as SiteTagState).impact;
  if (!impact) return null;
  return {
    rank: impact.rank,
    expectedLossAmount: impact.expectedLossAmount,
    currency: impact.currency,
    penalty: impact.penalty,
  };
}

function siteResponseProjection(
  response: MoshimoCase['response'],
): SiteResponseInput | null {
  if (!response) return null;
  return {
    disposition: response.disposition,
    actions: [...response.actions],
    when: response.when,
    status: response.status,
  };
}

function siteCaseProjection(caseItem: MoshimoCase) {
  return {
    id: caseItem.id,
    version: caseItem.version,
    source: caseItem.source,
    title: caseItem.title,
    suggestedActions: [...caseItem.suggestedActions],
    suggestedActionSource: caseItem.suggestedActionSource,
    planBOptionsDraft:
      caseItem.planBOptionsDraft === null
        ? null
        : [...caseItem.planBOptionsDraft],
    response: siteResponseProjection(caseItem.response),
  };
}

function siteTagProjection(tag: MoshimoTag) {
  return {
    id: tag.id,
    version: tag.version,
    anchorItemId: tag.anchorItemId,
    source: tag.source,
    lifecycle: tag.lifecycle,
    needsRecheck: tag.needsRecheck,
    basedOnItemVersion: tag.basedOnItemVersion,
    basedOnProjectVersion: tag.basedOnProjectVersion,
    question: tag.question,
    rationale: tag.rationale,
    summary: tag.summary,
    impact: siteImpactProjection(tag),
    cases: tag.cases.map(siteCaseProjection),
  };
}

function siteItemProjection(item: TimelineItem) {
  return {
    id: item.id,
    version: item.version,
    timeOrCue: item.timeOrCue,
    title: item.title,
    body: item.body,
    status: item.status,
    tags: item.tags.map(siteTagProjection),
  };
}

function siteGapProjection(gap: PlanGapSuggestion) {
  return {
    id: gap.id,
    source: gap.source,
    insertAfterItemId: gap.insertAfterItemId,
    timeOrCue: gap.timeOrCue,
    title: gap.title,
    body: gap.body,
    status: gap.status,
  };
}

function siteProjectMetadata(project: ProjectState) {
  return {
    id: project.id,
    version: project.version,
    title: project.title,
    description: project.description,
    viewMode: project.viewMode,
    timelineItemCount: project.timeline.length,
    gapSuggestionCount: project.gapSuggestions.length,
  };
}

function siteProjectList(snapshot: AppState): ProjectState[] {
  const projects: ProjectState[] = [];
  const seen = new Set<string>();
  for (const project of [snapshot.project, ...snapshot.projects]) {
    if (isEmptyWorkspaceProject(project)) continue;
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    projects.push(project);
  }
  return projects;
}

function siteFindProject(
  snapshot: AppState,
  projectId: string | undefined,
): ProjectState | null {
  const projects = siteProjectList(snapshot);
  if (projectId === undefined) {
    return isEmptyWorkspaceProject(snapshot.project) ? null : snapshot.project;
  }
  return projects.find((project) => project.id === projectId) ?? null;
}

function siteFindTag(
  project: ProjectState,
  tagId: string,
): { item: TimelineItem; tag: MoshimoTag } | null {
  for (const item of project.timeline) {
    const tag = item.tags.find((candidate) => candidate.id === tagId);
    if (tag) return { item, tag };
  }
  return null;
}

function siteFindCase(
  project: ProjectState,
  caseId: string,
): { item: TimelineItem; tag: MoshimoTag; caseItem: MoshimoCase } | null {
  for (const item of project.timeline) {
    for (const tag of item.tags) {
      const caseItem = tag.cases.find((candidate) => candidate.id === caseId);
      if (caseItem) return { item, tag, caseItem };
    }
  }
  return null;
}

function siteValidateExportProjection(
  input: unknown,
): ValidationResult<ExportProjectionInput> {
  const allowedKeys = ['columns', 'entryScope', 'projectId', 'projection'];
  if (
    !isRecord(input) ||
    !siteHasOnlyKeys(input, allowedKeys)
  ) {
    return invalidInput(
      'get_export_projection: expected the strict optional Project/projection/scope shape.',
    );
  }

  const projection: ExportProjection = Object.prototype.hasOwnProperty.call(
    input,
    'projection',
  )
    ? (input.projection as ExportProjection)
    : 'human_summary';
  if (
    projection !== 'human_summary' &&
    projection !== 'timeline' &&
    projection !== 'case_matrix' &&
    projection !== 'runbook'
  ) {
    return invalidInput(
      'get_export_projection: projection must be human_summary, timeline, case_matrix, or runbook.',
    );
  }

  const hasProjectId = Object.prototype.hasOwnProperty.call(input, 'projectId');
  if (hasProjectId && !isNonEmptyId(input.projectId)) {
    return invalidInput(
      'get_export_projection: projectId must be a bounded ID when supplied.',
    );
  }

  let entryScope: ExportEntryScope =
    projection === 'human_summary' ? 'all' : 'selected_only';
  if (Object.prototype.hasOwnProperty.call(input, 'entryScope')) {
    if (
      input.entryScope !== 'selected_only' &&
      input.entryScope !== 'candidates' &&
      input.entryScope !== 'all'
    ) {
      return invalidInput(
        'get_export_projection: entryScope must be selected_only, candidates, or all.',
      );
    }
    entryScope = input.entryScope;
  }

  let columns: ExportColumn[] | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'columns')) {
    if (projection !== 'case_matrix') {
      return invalidInput(
        'get_export_projection: columns applies only to case_matrix.',
      );
    }
    if (!Array.isArray(input.columns)) {
      return invalidInput(
        'get_export_projection: columns must be an array of fixed column names.',
      );
    }
    const seen = new Set<string>();
    columns = [];
    for (const column of input.columns) {
      if (
        typeof column !== 'string' ||
        !(EXPORT_COLUMNS as readonly string[]).includes(column)
      ) {
        return invalidInput(
          'get_export_projection: columns contains an unknown column.',
        );
      }
      if (seen.has(column)) {
        return invalidInput(
          'get_export_projection: columns must not contain duplicates.',
        );
      }
      seen.add(column);
      columns.push(column as ExportColumn);
    }
  }

  return {
    ok: true,
    value: {
      ...(hasProjectId ? { projectId: input.projectId as string } : {}),
      projection,
      entryScope,
      ...(columns === undefined ? {} : { columns }),
    },
  };
}

function siteExportEntryKind(
  response: MoshimoCase['response'],
  entryScope: ExportEntryScope,
): ExportEntryKind | null {
  if (response === null) {
    return entryScope === 'selected_only' ? null : 'candidate';
  }
  if (response.disposition === 'dismiss' || entryScope === 'candidates') {
    return null;
  }
  return 'selected';
}

function siteExportEntry(
  tag: MoshimoTag,
  caseItem: MoshimoCase,
  entryKind: ExportEntryKind,
): ProjectOutputEntry {
  const response = caseItem.response;
  return {
    whatIf: tag.question,
    case: caseItem.title,
    entryScope: entryKind,
    decision: response?.disposition === 'dismiss' ? null : response?.disposition ?? null,
    candidateActions: [...caseItem.suggestedActions],
    responseActions: response ? [...response.actions] : [],
    when: response?.when ?? '',
    status: response?.status ?? null,
    impact: siteImpactProjection(tag),
  };
}

function siteExportEntries(
  item: TimelineItem,
  entryScope: ExportEntryScope,
): ProjectOutputEntry[] {
  const entries: ProjectOutputEntry[] = [];
  for (const tag of item.tags) {
    if (tag.lifecycle !== 'active') continue;
    for (const caseItem of tag.cases) {
      const entryKind = siteExportEntryKind(caseItem.response, entryScope);
      if (entryKind === null) continue;
      entries.push(siteExportEntry(tag, caseItem, entryKind));
    }
  }
  return entries;
}

function siteExportCaseMatrixRecord(
  item: TimelineItem,
  tag: MoshimoTag,
  caseItem: MoshimoCase,
  planOrder: number,
  entryKind: ExportEntryKind,
  columns: readonly ExportColumn[],
): Record<string, string | number | null | string[]> {
  const entry = siteExportEntry(tag, caseItem, entryKind);
  const values: Record<ExportColumn, string | number | null | string[]> = {
    plan_order: planOrder,
    time_or_cue: item.timeOrCue,
    plan_title: item.title,
    plan_body: item.body,
    what_if: entry.whatIf,
    case: entry.case,
    entry_scope: entry.entryScope,
    decision: entry.decision,
    candidate_actions: entry.candidateActions,
    response_actions: entry.responseActions,
    when: entry.when,
    status: entry.status,
    impact_rank: entry.impact?.rank ?? null,
    expected_loss_amount: entry.impact?.expectedLossAmount ?? null,
    currency: entry.impact?.currency ?? null,
    penalty: entry.impact?.penalty ?? null,
  };
  const record: Record<string, string | number | null | string[]> = {};
  for (const column of columns) record[column] = values[column];
  return record;
}

function siteHumanActions(actions: readonly string[]): string {
  return actions.map((action, index) => `${index + 1}. ${action}`).join('\n');
}

function siteHumanDecision(response: MoshimoCase['response']): string {
  switch (response?.disposition) {
    case 'covered':
      return 'Covered';
    case 'accept':
      return 'Accepted';
    case 'prepare':
      return 'Prepare';
    case 'plan_b':
      return 'Plan B';
    default:
      return 'Undecided';
  }
}

function siteHumanImpact(tag: MoshimoTag): string {
  const impact = siteImpactProjection(tag);
  if (!impact) return '';
  const lines = [`Rank: ${impact.rank}/5`];
  if (impact.expectedLossAmount !== null && impact.currency !== null) {
    lines.push(`Expected loss: ${impact.currency} ${impact.expectedLossAmount}`);
  }
  if (impact.penalty !== '') lines.push(`Penalty: ${impact.penalty}`);
  return lines.join('\n');
}

function siteHumanSummaryRows(
  project: ProjectState,
  entryScope: ExportEntryScope,
): Array<Record<HumanSummaryColumn['key'], string>> {
  const rows: Array<Record<HumanSummaryColumn['key'], string>> = [];
  for (const item of project.timeline) {
    let wrotePlan = false;
    for (const tag of item.tags) {
      if (tag.lifecycle !== 'active') continue;
      const includedCases = tag.cases.flatMap((caseItem) => {
        const entryKind = siteExportEntryKind(caseItem.response, entryScope);
        return entryKind === null ? [] : [{ caseItem, entryKind }];
      });
      includedCases.forEach(({ caseItem, entryKind }, caseIndex) => {
        const response = caseItem.response;
        rows.push({
          time_or_cue: wrotePlan ? '' : item.timeOrCue,
          plan: wrotePlan ? '' : item.title,
          plan_details: wrotePlan ? '' : item.body,
          what_if: caseIndex === 0 ? tag.question : '',
          case: caseItem.title,
          selection: entryKind === 'selected' ? 'Selected' : 'Candidate',
          decision: siteHumanDecision(response),
          candidate_actions: siteHumanActions(caseItem.suggestedActions),
          saved_response: siteHumanActions(response?.actions ?? []),
          when: response?.when ?? '',
          status:
            response?.status === 'done'
              ? 'Done'
              : response?.status === 'pending'
                ? 'Pending'
                : '',
          impact: caseIndex === 0 ? siteHumanImpact(tag) : '',
        });
        wrotePlan = true;
      });
    }
    if (!wrotePlan) {
      rows.push({
        time_or_cue: item.timeOrCue,
        plan: item.title,
        plan_details: item.body,
        what_if: '',
        case: '',
        selection: '',
        decision: '',
        candidate_actions: '',
        saved_response: '',
        when: '',
        status: '',
        impact: '',
      });
    }
  }
  return rows;
}

function siteExportProjection(
  project: ProjectState,
  projection: ExportProjection,
  entryScope: ExportEntryScope,
  requestedColumns?: readonly ExportColumn[],
) {
  if (projection === 'human_summary') {
    const rows = siteHumanSummaryRows(project, entryScope);
    return {
      ok: true,
      code: 'OK',
      projectTitle: project.title,
      entryScope,
      presentationContract: {
        profile: 'human_readable',
        projectTitlePlacement: 'heading_once',
        repeatedPlanCells: 'blank',
        repeatedWhatIfCells: 'blank',
        internalMetadata: 'omit',
        orderedActions: 'numbered_line_breaks',
        candidateAndResponse: 'separate',
      },
      projection,
      columns: HUMAN_SUMMARY_COLUMNS.map((column) => ({ ...column })),
      rows,
      count: rows.length,
    } as const;
  }

  const renderingContract = {
    recordUnit:
      projection === 'timeline'
        ? 'plan_item'
        : projection === 'case_matrix'
          ? 'case'
          : 'section',
    orderedArrays: 'keep_in_record',
    candidateAndResponse: 'separate',
  } as const;
  const metadata = {
    id: project.id,
    version: project.version,
    title: project.title,
  };

  if (projection === 'timeline') {
    const records = project.timeline.map((item, index) => ({
      planOrder: index + 1,
      timeOrCue: item.timeOrCue,
      planTitle: item.title,
      planBody: item.body,
      entries: siteExportEntries(item, entryScope),
    }));
    return {
      ok: true,
      code: 'OK',
      project: metadata,
      entryScope,
      renderingContract,
      projection,
      records,
      count: records.length,
    };
  }

  if (projection === 'runbook') {
    const sections = project.timeline.map((item, index) => ({
      planOrder: index + 1,
      timeOrCue: item.timeOrCue,
      planTitle: item.title,
      planBody: item.body,
      selectedResponses: siteExportEntries(item, entryScope),
    }));
    return {
      ok: true,
      code: 'OK',
      project: metadata,
      entryScope,
      renderingContract,
      projection,
      sections,
      count: sections.length,
    };
  }

  const columns = requestedColumns ?? EXPORT_COLUMNS;
  const records: Array<Record<string, string | number | null | string[]>> = [];
  project.timeline.forEach((item, itemIndex) => {
    if (item.tags.length === 0) return;
    for (const tag of item.tags) {
      if (tag.lifecycle !== 'active') continue;
      for (const caseItem of tag.cases) {
        const entryKind = siteExportEntryKind(caseItem.response, entryScope);
        if (entryKind === null) continue;
        records.push(
          siteExportCaseMatrixRecord(
            item,
            tag,
            caseItem,
            itemIndex + 1,
            entryKind,
            columns,
          ),
        );
      }
    }
  });
  return {
    ok: true,
    code: 'OK',
    project: metadata,
    entryScope,
    renderingContract,
    projection,
    columns: [...columns],
    records,
    count: records.length,
  };
}

function siteReadExportProjection(
  input: unknown,
  dependencies: ReviewToolDependencies,
): string {
  const validation = siteValidateExportProjection(input);
  if (!validation.ok) {
    return errorResult(validation.code, validation.message, false);
  }
  let snapshot: AppState;
  try {
    snapshot = dependencies.getSnapshot();
  } catch {
    return errorResult(
      'UNAVAILABLE',
      'get_export_projection: the requested Project is unavailable.',
      true,
    );
  }
  const project = siteFindProject(snapshot, validation.value.projectId);
  if (!project) {
    return errorResult(
      'NOT_FOUND',
      'get_export_projection: Project was not found.',
      false,
    );
  }
  let result: ReturnType<typeof siteExportProjection>;
  try {
    result = siteExportProjection(
      project,
      validation.value.projection,
      validation.value.entryScope,
      validation.value.columns,
    );
  } catch {
    return errorResult(
      'UNAVAILABLE',
      'get_export_projection: the saved Project could not be projected.',
      true,
    );
  }
  return boundedJson(result, 'get_export_projection');
}

function siteFinalProjection(project: ProjectState, entityId?: string) {
  const items = project.timeline
    .filter((item) => entityId === undefined || item.id === entityId)
    .map((item) => {
      const tags = item.tags
        .filter((tag) => tag.lifecycle === 'active')
        .map((tag) => {
          const cases = tag.cases.filter(
            (caseItem) =>
              caseItem.response !== null &&
              caseItem.response.disposition !== 'dismiss',
          );
          if (cases.length === 0) return null;
          return {
            ...siteTagProjection(tag),
            cases: cases.map(siteCaseProjection),
          };
        })
        .filter((tag): tag is NonNullable<typeof tag> => tag !== null);
      if (tags.length === 0) return null;
      return {
        id: item.id,
        version: item.version,
        timeOrCue: item.timeOrCue,
        title: item.title,
        body: item.body,
        status: item.status,
        tags,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return { items };
}

function siteReadListProjects(
  input: unknown,
  dependencies: ReviewToolDependencies,
): string {
  if (!isRecord(input) || !hasExactKeys(input, [])) {
    return errorResult(
      'INVALID_INPUT',
      'list_projects: expected an empty input object.',
      false,
    );
  }
  let snapshot: AppState;
  try {
    snapshot = dependencies.getSnapshot();
  } catch {
    return errorResult(
      'UNAVAILABLE',
      'list_projects: current Projects are unavailable.',
      true,
    );
  }
  return boundedJson(
    {
      ok: true,
      workspaceStatus: isEmptyWorkspaceProject(snapshot.project)
        ? 'empty'
        : 'active',
      currentProjectId: snapshot.project.id,
      currentProjectVersion: snapshot.project.version,
      projects: siteProjectList(snapshot).map((project) => ({
        id: project.id,
        version: project.version,
        title: project.title,
        viewMode: project.viewMode,
        timelineItemCount: project.timeline.length,
      })),
    },
    'list_projects',
  );
}

function siteReadProject(
  input: unknown,
  dependencies: ReviewToolDependencies,
): string {
  if (
    !isRecord(input) ||
    !siteHasOnlyKeys(input, ['entityId', 'projectId', 'section']) ||
    !Object.prototype.hasOwnProperty.call(input, 'section') ||
    !isNonEmptyId(input.section) ||
    (input.section !== 'project' &&
      input.section !== 'plan' &&
      input.section !== 'what_if' &&
      input.section !== 'case' &&
      input.section !== 'final') ||
    (Object.prototype.hasOwnProperty.call(input, 'projectId') &&
      input.projectId !== undefined &&
      !isNonEmptyId(input.projectId)) ||
    (Object.prototype.hasOwnProperty.call(input, 'entityId') &&
      input.entityId !== undefined &&
      !isNonEmptyId(input.entityId))
  ) {
    return errorResult(
      'INVALID_INPUT',
      'get_project: expected a strict section, optional Project ID, and optional entity ID.',
      false,
    );
  }
  let snapshot: AppState;
  try {
    snapshot = dependencies.getSnapshot();
  } catch {
    return errorResult(
      'UNAVAILABLE',
      'get_project: the requested Project is unavailable.',
      true,
    );
  }
  const project = siteFindProject(snapshot, input.projectId as string | undefined);
  if (!project) {
    return errorResult(
      'NOT_FOUND',
      isEmptyWorkspaceProject(snapshot.project)
        ? 'get_project: create a Project before reading Project content.'
        : 'get_project: Project was not found.',
      false,
    );
  }
  const section = input.section as 'project' | 'plan' | 'what_if' | 'case' | 'final';
  const entityId = input.entityId as string | undefined;
  const metadata = siteProjectMetadata(project);
  if (section === 'project') {
    return boundedJson(
      {
        ok: true,
        section,
        project: metadata,
        gaps: project.gapSuggestions.map(siteGapProjection),
      },
      'get_project',
    );
  }
  if (section === 'plan') {
    return boundedJson(
      {
        ok: true,
        section,
        project: metadata,
        items: project.timeline.map(siteItemProjection),
        gaps: project.gapSuggestions.map(siteGapProjection),
      },
      'get_project',
    );
  }
  if (section === 'final') {
    return boundedJson(
      { ok: true, section, project: metadata, ...siteFinalProjection(project, entityId) },
      'get_project',
    );
  }
  if (section === 'what_if') {
    if (!entityId) {
      return boundedJson(
        {
          ok: true,
          section,
          project: metadata,
          items: project.timeline.map((item) => ({
            item: {
              id: item.id,
              version: item.version,
              timeOrCue: item.timeOrCue,
              title: item.title,
            },
            whatIfs: item.tags.map(siteTagProjection),
          })),
        },
        'get_project',
      );
    }
    const location = siteFindTag(project, entityId);
    if (!location) {
      return errorResult('NOT_FOUND', 'get_project: What-if was not found.', false);
    }
    return boundedJson(
      {
        ok: true,
        section,
        project: metadata,
        item: {
          id: location.item.id,
          version: location.item.version,
          timeOrCue: location.item.timeOrCue,
          title: location.item.title,
        },
        whatIf: siteTagProjection(location.tag),
      },
      'get_project',
    );
  }
  if (!entityId) {
    return errorResult(
      'INVALID_INPUT',
      'get_project: entityId is required for the case section.',
      false,
    );
  }
  const location = siteFindCase(project, entityId);
  if (!location) {
    return errorResult('NOT_FOUND', 'get_project: Case was not found.', false);
  }
  return boundedJson(
    {
      ok: true,
      section,
      project: metadata,
      item: {
        id: location.item.id,
        version: location.item.version,
        timeOrCue: location.item.timeOrCue,
        title: location.item.title,
      },
      whatIf: siteTagProjection(location.tag),
      case: siteCaseProjection(location.caseItem),
    },
    'get_project',
  );
}

function siteValidateCreateProject(
  input: unknown,
): ValidationResult<SiteCreateProjectInput> {
  const base = siteParseBase(
    input,
    'create_project',
    ['title', 'description'],
    ['items'],
  );
  if (!base.ok) return base;
  const title = siteParseText(base.value.title, 1, 120);
  const description = siteParseText(base.value.description, 0, 1000);
  if (title === null || description === null) {
    return invalidInput('create_project: title or description is outside the allowed bounds.');
  }
  let items: SitePlanItemInput[] | undefined;
  if (Object.prototype.hasOwnProperty.call(base.value, 'items')) {
    const parsed = siteParsePlanItems(base.value.items, 'create_project');
    if (!parsed.ok) return parsed;
    items = parsed.value;
  }
  return {
    ok: true,
    value: {
      idempotencyKey: base.value.idempotencyKey as string,
      projectId: base.value.projectId as string,
      projectVersion: base.value.projectVersion as number,
      title,
      description,
      ...(items === undefined ? {} : { items }),
    },
  };
}

function siteValidateOpenProject(
  input: unknown,
): ValidationResult<SiteOpenProjectInput> {
  const base = siteParseBase(input, 'open_project', ['targetProjectId']);
  if (!base.ok) return base;
  if (!isNonEmptyId(base.value.targetProjectId)) {
    return invalidInput('open_project: targetProjectId must be a bounded ID.');
  }
  return {
    ok: true,
    value: {
      idempotencyKey: base.value.idempotencyKey as string,
      projectId: base.value.projectId as string,
      projectVersion: base.value.projectVersion as number,
      targetProjectId: base.value.targetProjectId,
    },
  };
}

function siteValidateUpdateProject(
  input: unknown,
): ValidationResult<SiteUpdateProjectInput> {
  const base = siteParseBase(
    input,
    'update_project',
    ['title', 'description'],
  );
  if (!base.ok) return base;
  const title = siteParseText(base.value.title, 1, 120);
  const description = siteParseText(base.value.description, 0, 1000);
  if (title === null || description === null) {
    return invalidInput('update_project: title or description is outside the allowed bounds.');
  }
  return {
    ok: true,
    value: {
      idempotencyKey: base.value.idempotencyKey as string,
      projectId: base.value.projectId as string,
      projectVersion: base.value.projectVersion as number,
      title,
      description,
    },
  };
}

function siteValidateSetProjectView(
  input: unknown,
): ValidationResult<SiteSetProjectViewInput> {
  const base = siteParseBase(input, 'set_project_view', ['viewMode']);
  if (!base.ok) return base;
  if (base.value.viewMode !== 'editing' && base.value.viewMode !== 'final') {
    return invalidInput('set_project_view: viewMode must be editing or final.');
  }
  return {
    ok: true,
    value: {
      idempotencyKey: base.value.idempotencyKey as string,
      projectId: base.value.projectId as string,
      projectVersion: base.value.projectVersion as number,
      viewMode: base.value.viewMode,
    },
  };
}

function siteValidatePlanEdit(
  input: unknown,
): ValidationResult<SiteEditPlanInput> {
  if (!isRecord(input) || typeof input.operation !== 'string') {
    return invalidInput('edit_plan: operation is required.');
  }
  if (input.operation === 'add') {
    const base = siteParseBase(
      input,
      'edit_plan',
      ['operation', 'timeOrCue', 'title', 'body'],
    );
    if (!base.ok) return base;
    const timeOrCue = siteParseText(base.value.timeOrCue, 0, 40);
    const title = siteParseText(base.value.title, 1, 120);
    const body = siteParseText(base.value.body, 0, 1200);
    if (timeOrCue === null || title === null || body === null) {
      return invalidInput('edit_plan: Plan text is outside the allowed bounds.');
    }
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'add',
        timeOrCue,
        title,
        body,
      },
    };
  }
  if (input.operation === 'update') {
    const base = siteParseBase(
      input,
      'edit_plan',
      ['operation', 'itemId', 'itemVersion', 'timeOrCue', 'title', 'body'],
    );
    if (!base.ok) return base;
    const item = siteParseVersionedId(base.value, 'edit_plan', 'itemId', 'itemVersion');
    if (!item.ok) return item;
    const timeOrCue = siteParseText(base.value.timeOrCue, 0, 40);
    const title = siteParseText(base.value.title, 1, 120);
    const body = siteParseText(base.value.body, 0, 1200);
    if (timeOrCue === null || title === null || body === null) {
      return invalidInput('edit_plan: Plan text is outside the allowed bounds.');
    }
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'update',
        itemId: item.value.id,
        itemVersion: item.value.version,
        timeOrCue,
        title,
        body,
      },
    };
  }
  if (input.operation === 'move') {
    const base = siteParseBase(
      input,
      'edit_plan',
      ['operation', 'itemId', 'itemVersion', 'direction'],
    );
    if (!base.ok) return base;
    const item = siteParseVersionedId(base.value, 'edit_plan', 'itemId', 'itemVersion');
    if (!item.ok) return item;
    if (base.value.direction !== 'up' && base.value.direction !== 'down') {
      return invalidInput('edit_plan: direction must be up or down.');
    }
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'move',
        itemId: item.value.id,
        itemVersion: item.value.version,
        direction: base.value.direction,
      },
    };
  }
  if (input.operation === 'delete') {
    const base = siteParseBase(
      input,
      'edit_plan',
      ['operation', 'itemId', 'itemVersion'],
    );
    if (!base.ok) return base;
    const item = siteParseVersionedId(base.value, 'edit_plan', 'itemId', 'itemVersion');
    if (!item.ok) return item;
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'delete',
        itemId: item.value.id,
        itemVersion: item.value.version,
      },
    };
  }
  return invalidInput('edit_plan: operation must be add, update, move, or delete.');
}

function siteValidateWhatIfEdit(
  input: unknown,
): ValidationResult<SiteEditWhatIfInput> {
  if (!isRecord(input) || typeof input.operation !== 'string') {
    return invalidInput('edit_what_if: operation is required.');
  }
  if (input.operation === 'add') {
    const base = siteParseBase(
      input,
      'edit_what_if',
      [
        'operation',
        'itemId',
        'itemVersion',
        'question',
        'rationale',
        'summary',
        'cases',
      ],
      ['impact'],
    );
    if (!base.ok) return base;
    const item = siteParseVersionedId(base.value, 'edit_what_if', 'itemId', 'itemVersion');
    if (!item.ok) return item;
    const question = siteParseText(base.value.question, 1, 180);
    const rationale = siteParseText(base.value.rationale, 1, 400);
    const summary = siteParseText(base.value.summary, 1, 400);
    if (question === null || rationale === null || summary === null) {
      return invalidInput('edit_what_if: What-if text is outside the allowed bounds.');
    }
    const cases = siteParsePlanCases(
      base.value.cases,
      'edit_what_if',
      1,
      NORMAL_REVIEW_LIMITS.casesPerTag[1],
      false,
    );
    if (!cases.ok) return cases;
    let impact: SiteImpact | null | undefined;
    if (Object.prototype.hasOwnProperty.call(base.value, 'impact')) {
      const parsedImpact = siteParseImpact(base.value.impact, 'edit_what_if');
      if (!parsedImpact.ok) return parsedImpact;
      impact = parsedImpact.value;
    }
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'add',
        itemId: item.value.id,
        itemVersion: item.value.version,
        question,
        rationale,
        summary,
        cases: cases.value,
        ...(impact === undefined ? {} : { impact }),
      },
    };
  }
  if (input.operation === 'update') {
    const base = siteParseBase(
      input,
      'edit_what_if',
      ['operation', 'tagId', 'tagVersion', 'question', 'rationale', 'summary'],
    );
    if (!base.ok) return base;
    const tag = siteParseVersionedId(base.value, 'edit_what_if', 'tagId', 'tagVersion');
    if (!tag.ok) return tag;
    const question = siteParseText(base.value.question, 1, 180);
    const rationale = siteParseText(base.value.rationale, 1, 400);
    const summary = siteParseText(base.value.summary, 1, 400);
    if (question === null || rationale === null || summary === null) {
      return invalidInput('edit_what_if: What-if text is outside the allowed bounds.');
    }
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'update',
        tagId: tag.value.id,
        tagVersion: tag.value.version,
        question,
        rationale,
        summary,
      },
    };
  }
  if (input.operation === 'delete') {
    const base = siteParseBase(
      input,
      'edit_what_if',
      ['operation', 'tagId', 'tagVersion'],
    );
    if (!base.ok) return base;
    const tag = siteParseVersionedId(base.value, 'edit_what_if', 'tagId', 'tagVersion');
    if (!tag.ok) return tag;
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'delete',
        tagId: tag.value.id,
        tagVersion: tag.value.version,
      },
    };
  }
  if (input.operation === 'set_impact') {
    const base = siteParseBase(
      input,
      'edit_what_if',
      ['operation', 'tagId', 'tagVersion', 'impact'],
    );
    if (!base.ok) return base;
    const tag = siteParseVersionedId(base.value, 'edit_what_if', 'tagId', 'tagVersion');
    if (!tag.ok) return tag;
    const impact = siteParseImpact(base.value.impact, 'edit_what_if');
    if (!impact.ok) return impact;
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'set_impact',
        tagId: tag.value.id,
        tagVersion: tag.value.version,
        impact: impact.value,
      },
    };
  }
  if (input.operation === 'sort_by_impact') {
    const base = siteParseBase(
      input,
      'edit_what_if',
      ['operation', 'itemId', 'itemVersion'],
    );
    if (!base.ok) return base;
    const item = siteParseVersionedId(base.value, 'edit_what_if', 'itemId', 'itemVersion');
    if (!item.ok) return item;
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'sort_by_impact',
        itemId: item.value.id,
        itemVersion: item.value.version,
      },
    };
  }
  return invalidInput(
    'edit_what_if: operation must be add, update, delete, set_impact, or sort_by_impact.',
  );
}

function siteValidateCaseEdit(
  input: unknown,
): ValidationResult<SiteEditCaseInput> {
  if (!isRecord(input) || typeof input.operation !== 'string') {
    return invalidInput('edit_case: operation is required.');
  }
  if (input.operation === 'add') {
    const base = siteParseBase(
      input,
      'edit_case',
      ['operation', 'tagId', 'tagVersion', 'title', 'suggestedActions'],
    );
    if (!base.ok) return base;
    const tag = siteParseVersionedId(base.value, 'edit_case', 'tagId', 'tagVersion');
    if (!tag.ok) return tag;
    const title = siteParseText(base.value.title, 1, 120);
    if (title === null) {
      return invalidInput('edit_case: Case title is outside the allowed bounds.');
    }
    const parsedCase = siteParsePlanCase(
      { title, suggestedActions: base.value.suggestedActions },
      'edit_case',
      false,
    );
    if (!parsedCase.ok) return parsedCase;
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'add',
        tagId: tag.value.id,
        tagVersion: tag.value.version,
        title: parsedCase.value.title,
        suggestedActions: parsedCase.value.suggestedActions,
      },
    };
  }
  if (input.operation === 'update') {
    const base = siteParseBase(
      input,
      'edit_case',
      ['operation', 'caseId', 'caseVersion', 'title', 'suggestedActions'],
    );
    if (!base.ok) return base;
    const caseValue = siteParseVersionedId(base.value, 'edit_case', 'caseId', 'caseVersion');
    if (!caseValue.ok) return caseValue;
    const title = siteParseText(base.value.title, 1, 120);
    if (title === null) {
      return invalidInput('edit_case: Case title is outside the allowed bounds.');
    }
    const parsedCase = siteParsePlanCase(
      { title, suggestedActions: base.value.suggestedActions },
      'edit_case',
      false,
    );
    if (!parsedCase.ok) return parsedCase;
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'update',
        caseId: caseValue.value.id,
        caseVersion: caseValue.value.version,
        title: parsedCase.value.title,
        suggestedActions: parsedCase.value.suggestedActions,
      },
    };
  }
  if (input.operation === 'delete') {
    const base = siteParseBase(
      input,
      'edit_case',
      ['operation', 'caseId', 'caseVersion'],
    );
    if (!base.ok) return base;
    const caseValue = siteParseVersionedId(base.value, 'edit_case', 'caseId', 'caseVersion');
    if (!caseValue.ok) return caseValue;
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation: 'delete',
        caseId: caseValue.value.id,
        caseVersion: caseValue.value.version,
      },
    };
  }
  return invalidInput(
    'edit_case: operation must be add, update, or delete. Case decisions are saved only by the person in the page UI.',
  );
}

function siteParsePlanBOptions(
  value: unknown,
): ValidationResult<string[]> {
  if (!Array.isArray(value)) {
    return invalidInput('edit_plan_b_options: options must be an array.');
  }
  if (value.length > 5) {
    return limitExceeded(
      'edit_plan_b_options: a Case may have at most five Plan B options.',
    );
  }
  if (
    !value.every((option) => isBoundedText(option, 1, 1200)) ||
    textLength((value as unknown[]).join('')) > 4800
  ) {
    return invalidInput(
      'edit_plan_b_options: option text is outside the allowed bounds.',
    );
  }
  return {
    ok: true,
    value: value.map((option) => clean(option as string)),
  };
}

function siteValidatePlanBOptionsEdit(
  input: unknown,
): ValidationResult<SiteEditPlanBOptionsInput> {
  if (!isRecord(input) || typeof input.operation !== 'string') {
    return invalidInput('edit_plan_b_options: operation is required.');
  }
  const operation = input.operation;
  if (operation === 'replace') {
    const base = siteParseBase(input, 'edit_plan_b_options', [
      'operation',
      'caseId',
      'caseVersion',
      'options',
    ]);
    if (!base.ok) return base;
    const caseValue = siteParseVersionedId(
      base.value,
      'edit_plan_b_options',
      'caseId',
      'caseVersion',
    );
    if (!caseValue.ok) return caseValue;
    const options = siteParsePlanBOptions(base.value.options);
    if (!options.ok) return options;
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation,
        caseId: caseValue.value.id,
        caseVersion: caseValue.value.version,
        options: options.value,
      },
    };
  }
  if (operation === 'add') {
    const base = siteParseBase(input, 'edit_plan_b_options', [
      'operation',
      'caseId',
      'caseVersion',
      'option',
    ]);
    if (!base.ok) return base;
    const caseValue = siteParseVersionedId(
      base.value,
      'edit_plan_b_options',
      'caseId',
      'caseVersion',
    );
    if (!caseValue.ok) return caseValue;
    const option = siteParseText(base.value.option, 1, 1200);
    if (option === null) {
      return invalidInput(
        'edit_plan_b_options: option text is outside the allowed bounds.',
      );
    }
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation,
        caseId: caseValue.value.id,
        caseVersion: caseValue.value.version,
        option,
      },
    };
  }
  if (operation === 'update' || operation === 'delete') {
    const required = [
      'operation',
      'caseId',
      'caseVersion',
      'optionNumber',
      ...(operation === 'update' ? ['option'] : []),
    ];
    const base = siteParseBase(input, 'edit_plan_b_options', required);
    if (!base.ok) return base;
    const caseValue = siteParseVersionedId(
      base.value,
      'edit_plan_b_options',
      'caseId',
      'caseVersion',
    );
    if (!caseValue.ok) return caseValue;
    if (
      !Number.isInteger(base.value.optionNumber) ||
      (base.value.optionNumber as number) < 1 ||
      (base.value.optionNumber as number) > 5
    ) {
      return invalidInput(
        'edit_plan_b_options: optionNumber must identify Option 1 through Option 5.',
      );
    }
    if (operation === 'update') {
      const option = siteParseText(base.value.option, 1, 1200);
      if (option === null) {
        return invalidInput(
          'edit_plan_b_options: option text is outside the allowed bounds.',
        );
      }
      return {
        ok: true,
        value: {
          idempotencyKey: base.value.idempotencyKey as string,
          projectId: base.value.projectId as string,
          projectVersion: base.value.projectVersion as number,
          operation,
          caseId: caseValue.value.id,
          caseVersion: caseValue.value.version,
          optionNumber: base.value.optionNumber as number,
          option,
        },
      };
    }
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation,
        caseId: caseValue.value.id,
        caseVersion: caseValue.value.version,
        optionNumber: base.value.optionNumber as number,
      },
    };
  }
  if (operation === 'discard') {
    const base = siteParseBase(input, 'edit_plan_b_options', [
      'operation',
      'caseId',
      'caseVersion',
    ]);
    if (!base.ok) return base;
    const caseValue = siteParseVersionedId(
      base.value,
      'edit_plan_b_options',
      'caseId',
      'caseVersion',
    );
    if (!caseValue.ok) return caseValue;
    return {
      ok: true,
      value: {
        idempotencyKey: base.value.idempotencyKey as string,
        projectId: base.value.projectId as string,
        projectVersion: base.value.projectVersion as number,
        operation,
        caseId: caseValue.value.id,
        caseVersion: caseValue.value.version,
      },
    };
  }
  return invalidInput(
    'edit_plan_b_options: operation must be replace, add, update, delete, or discard.',
  );
}

function siteCommandFailure(
  code: Extract<CommandResult, { ok: false }>['code'],
  message: string,
  retryable: boolean,
): CommandResult {
  return { ok: false, code, message, retryable };
}

function siteEntityVersionFailure(
  operation: string,
  entity: string,
): CommandResult {
  return siteCommandFailure(
    'VERSION_CONFLICT',
    `${operation}: ${entity} version is stale.`,
    true,
  );
}

function siteEntityNotFound(
  operation: string,
  entity: string,
): CommandResult {
  return siteCommandFailure(
    'NOT_FOUND',
    `${operation}: ${entity} was not found.`,
    false,
  );
}

function siteResolvedReadOnly(
  operation: string,
  entity: string,
): CommandResult {
  return siteCommandFailure(
    'INVALID_STATE',
    `${operation}: resolved ${entity} history is read-only.`,
    false,
  );
}

function siteDispatchMutation(
  value: SiteMutationInput,
  dependencies: ReviewToolDependencies,
  operation: string,
): CommandResult {
  if (operation === 'create_project') {
    const createValue = value as SiteCreateProjectInput;
    if (createValue.items !== undefined) {
      return dependencies.dispatch({
        type: 'project.createWithPlan',
        payload: {
          title: createValue.title,
          description: createValue.description,
          items: createValue.items,
        },
      });
    }
    return dependencies.dispatch({
      type: 'project.create',
      payload: {
        title: createValue.title,
        description: createValue.description,
        requestReview: false,
      },
    });
  }

  if (operation === 'open_project' && 'targetProjectId' in value) {
    return dependencies.dispatch({
      type: 'project.open',
      payload: { projectId: value.targetProjectId },
    });
  }

  if (operation === 'update_project') {
    const updateValue = value as SiteUpdateProjectInput;
    return dependencies.dispatch({
      type: 'project.update',
      payload: { title: updateValue.title, description: updateValue.description },
    });
  }

  if (operation === 'set_project_view' && 'viewMode' in value) {
    return dependencies.dispatch({
      type: 'project.view.set',
      payload: { viewMode: value.viewMode },
    });
  }

  if (operation === 'edit_plan' && 'operation' in value && value.operation === 'add') {
    const addValue = value as Extract<SiteEditPlanInput, { operation: 'add' }>;
    return dependencies.dispatch({
      type: 'timeline.add',
      payload: {
        timeOrCue: addValue.timeOrCue,
        title: addValue.title,
        body: addValue.body,
        requestReview: false,
      },
    });
  }

  if (
    operation === 'edit_plan' &&
    'operation' in value &&
    'itemId' in value &&
    ('timeOrCue' in value || 'direction' in value)
  ) {
    if ('direction' in value) {
      return dependencies.dispatch({
        type: 'timeline.move',
        payload: { itemId: value.itemId, direction: value.direction },
      });
    }
    return dependencies.dispatch({
      type: 'timeline.update',
      payload: {
        itemId: value.itemId,
        timeOrCue: value.timeOrCue,
        title: value.title,
        body: value.body,
      },
    });
  }

  if (
    operation === 'edit_plan' &&
    'operation' in value &&
    'itemId' in value &&
    'itemVersion' in value
  ) {
    return dependencies.dispatch({
      type: 'timeline.delete',
      payload: { itemId: value.itemId },
    });
  }

  if (operation === 'edit_what_if' && 'operation' in value && value.operation === 'set_impact') {
    return dependencies.dispatch({
      type: 'tag.impact.set',
      payload: {
        tagId: value.tagId,
        impact: value.impact,
        projectVersion: value.projectVersion,
        tagVersion: value.tagVersion,
      },
    });
  }

  if (operation === 'edit_what_if' && 'operation' in value && value.operation === 'sort_by_impact') {
    return dependencies.dispatch({
      type: 'tags.sortByImpact',
      payload: {
        itemId: value.itemId,
        projectVersion: value.projectVersion,
      },
    });
  }

  if (operation === 'edit_what_if' && 'operation' in value && 'itemId' in value && 'question' in value) {
    return dependencies.dispatch({
      type: 'tag.create',
      payload: {
        anchorItemId: value.itemId,
        question: value.question,
        rationale: value.rationale,
        summary: value.summary,
        cases: value.cases,
        impact: value.impact ?? null,
        projectVersion: value.projectVersion,
        itemVersion: value.itemVersion,
      },
    });
  }

  if (operation === 'edit_what_if' && 'operation' in value && 'tagId' in value && 'question' in value) {
    return dependencies.dispatch({
      type: 'tag.update',
      payload: {
        tagId: value.tagId,
        question: value.question,
        rationale: value.rationale,
        summary: value.summary,
        projectVersion: value.projectVersion,
        tagVersion: value.tagVersion,
      },
    });
  }

  if (operation === 'edit_what_if' && 'operation' in value && 'tagId' in value && value.operation === 'delete') {
    return dependencies.dispatch({
      type: 'tag.delete',
      payload: {
        tagId: value.tagId,
        projectVersion: value.projectVersion,
        tagVersion: value.tagVersion,
      },
    });
  }

  if (operation === 'edit_case' && 'operation' in value && 'tagId' in value && 'title' in value) {
    return dependencies.dispatch({
      type: 'case.create',
      payload: {
        tagId: value.tagId,
        title: value.title,
        suggestedActions: value.suggestedActions,
        projectVersion: value.projectVersion,
        tagVersion: value.tagVersion,
      },
    });
  }

  if (operation === 'edit_case' && 'operation' in value && 'caseId' in value && value.operation === 'update') {
    const caseValue = value as Extract<
      SiteEditCaseInput,
      { operation: 'update' }
    >;
    return dependencies.dispatch({
      type: 'case.update',
      payload: {
        caseId: caseValue.caseId,
        title: caseValue.title,
        suggestedActions: caseValue.suggestedActions,
        projectVersion: caseValue.projectVersion,
        caseVersion: caseValue.caseVersion,
      },
    });
  }

  if (operation === 'edit_case' && 'operation' in value && 'caseId' in value && value.operation === 'delete') {
    return dependencies.dispatch({
      type: 'case.delete',
      payload: {
        caseId: value.caseId,
        projectVersion: value.projectVersion,
        caseVersion: value.caseVersion,
      },
    });
  }

  if (
    operation === 'edit_plan_b_options' &&
    'operation' in value &&
    'caseId' in value &&
    'caseVersion' in value
  ) {
    const planBValue = value as SiteEditPlanBOptionsInput;
    let options: string[] | null;
    if (planBValue.operation === 'replace') {
      options = [...planBValue.options];
    } else if (planBValue.operation === 'discard') {
      options = null;
    } else {
      const snapshot = dependencies.getSnapshot();
      const location = siteFindCase(snapshot.project, planBValue.caseId);
      if (!location) {
        return siteEntityNotFound('edit_plan_b_options', 'Case');
      }
      options = [...(location.caseItem.planBOptionsDraft ?? [])];
      if (planBValue.operation === 'add') {
        if (options.length >= 5) {
          return siteCommandFailure(
            'LIMIT_EXCEEDED',
            'edit_plan_b_options: this Case already has five Plan B options.',
            false,
          );
        }
        options.push(planBValue.option);
      } else {
        const optionIndex = planBValue.optionNumber - 1;
        if (optionIndex < 0 || optionIndex >= options.length) {
          return siteCommandFailure(
            'NOT_FOUND',
            `edit_plan_b_options: Option ${planBValue.optionNumber} was not found in this draft.`,
            false,
          );
        }
        if (planBValue.operation === 'update') {
          options[optionIndex] = planBValue.option;
        } else {
          options.splice(optionIndex, 1);
        }
      }
    }
    return dependencies.dispatch({
      type: 'case.planBOptions.set',
      payload: {
        caseId: planBValue.caseId,
        options,
        projectVersion: planBValue.projectVersion,
        caseVersion: planBValue.caseVersion,
      },
    });
  }

  return siteCommandFailure(
    'INVALID_INPUT',
    'site mutation: unsupported operation shape.',
    false,
  );
}

function siteValidateCurrentEntity(
  value: SiteMutationInput,
  project: ProjectState,
): CommandResult | null {
  if (!('operation' in value)) return null;

  if ('itemId' in value) {
    const item = project.timeline.find((candidate) => candidate.id === value.itemId);
    if (!item) return siteEntityNotFound('site mutation', 'Plan item');
    if ('itemVersion' in value && item.version !== value.itemVersion) {
      return siteEntityVersionFailure('site mutation', 'Plan item');
    }
  }

  if ('tagId' in value) {
    const location = siteFindTag(project, value.tagId);
    if (!location) return siteEntityNotFound('site mutation', 'What-if');
    if ('tagVersion' in value && location.tag.version !== value.tagVersion) {
      return siteEntityVersionFailure('site mutation', 'What-if');
    }
    if (location.tag.lifecycle !== 'active') {
      return siteResolvedReadOnly('site mutation', 'What-if');
    }
  }

  if ('caseId' in value) {
    const location = siteFindCase(project, value.caseId);
    if (!location) return siteEntityNotFound('site mutation', 'Case');
    if ('caseVersion' in value && location.caseItem.version !== value.caseVersion) {
      return siteEntityVersionFailure('site mutation', 'Case');
    }
    if (location.tag.lifecycle !== 'active') {
      return siteResolvedReadOnly('site mutation', 'Case');
    }
  }
  return null;
}

function executeSiteMutation<T extends SiteMutationBase>(
  input: unknown,
  options: WebMcpExecuteOptions,
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
  operation: string,
  validate: (input: unknown) => ValidationResult<T>,
): string {
  if (isAborted(options)) {
    return errorResult('CANCELLED', `${operation}: execution was cancelled.`, true);
  }
  const validation = validate(input);
  if (!validation.ok) {
    return errorResult(
      validation.code,
      validation.message,
      validation.code !== 'LIMIT_EXCEEDED' && validation.code !== 'DUPLICATE',
    );
  }
  const value = validation.value;
  let inputFingerprint: string;
  try {
    inputFingerprint = fingerprint(input);
  } catch {
    return errorResult('INVALID_INPUT', `${operation}: input could not be read.`, true);
  }
  const previous = cache.get(value.idempotencyKey);
  if (previous) {
    if (previous.fingerprint === inputFingerprint) return previous.result;
    return errorResult(
      'DUPLICATE',
      `${operation}: idempotencyKey was already used for another operation.`,
      false,
    );
  }

  let snapshot: AppState;
  try {
    snapshot = dependencies.getSnapshot();
  } catch {
    return errorResult('UNAVAILABLE', `${operation}: current Project is unavailable.`, true);
  }
  const project = snapshot.project;
  if (isEmptyWorkspaceProject(project) && operation !== 'create_project') {
    return errorResult(
      'INVALID_STATE',
      `${operation}: create a Project before changing Project content.`,
      false,
    );
  }
  if (value.projectId !== project.id) {
    return errorResult('NOT_FOUND', `${operation}: current Project was not found.`, false);
  }
  if (value.projectVersion !== project.version) {
    return errorResult('VERSION_CONFLICT', `${operation}: Project version is stale.`, true);
  }
  const entityFailure = siteValidateCurrentEntity(
    value as unknown as SiteMutationInput,
    project,
  );
  if (entityFailure) return JSON.stringify(entityFailure);
  if (isAborted(options)) {
    return errorResult('CANCELLED', `${operation}: execution was cancelled.`, true);
  }

  let result: CommandResult;
  try {
    result = siteDispatchMutation(
      value as unknown as SiteMutationInput,
      dependencies,
      operation,
    );
  } catch {
    return errorResult('UNAVAILABLE', `${operation}: the Project command could not be completed.`, true);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    return errorResult('UNAVAILABLE', `${operation}: the command result could not be serialized.`, true);
  }
  if (result.ok) {
    cacheSuccessfulApply(cache, value.idempotencyKey, {
      fingerprint: inputFingerprint,
      result: serialized,
    });
  }
  return serialized;
}

const SITE_BASE_SCHEMA = {
  idempotencyKey: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
    pattern: '^[\\x21-\\x7e]+$',
  },
  projectId: { type: 'string', minLength: 1, maxLength: 160 },
  projectVersion: { type: 'integer', minimum: 1 },
};

const SITE_CASE_SCHEMA = {
  type: 'object',
  required: ['suggestedActions', 'title'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    suggestedActions: {
      type: 'array',
      minItems: 1,
      maxItems: NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1],
      items: { type: 'string', minLength: 1, maxLength: 1200 },
    },
  },
};

const SITE_CREATE_ITEM_SCHEMA = {
  type: 'object',
  required: ['body', 'tags', 'timeOrCue', 'title'],
  additionalProperties: false,
  properties: {
    timeOrCue: { type: 'string', maxLength: 40 },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    body: { type: 'string', maxLength: 1200 },
    tags: {
      type: 'array',
      minItems: PROJECT_PLAN_LIMITS.tagsPerItem[0],
      maxItems: PROJECT_PLAN_LIMITS.tagsPerItem[1],
      items: {
        type: 'object',
        required: ['cases', 'question', 'rationale', 'summary'],
        additionalProperties: false,
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 180 },
          rationale: { type: 'string', minLength: 1, maxLength: 400 },
          summary: { type: 'string', minLength: 1, maxLength: 400 },
          cases: {
            type: 'array',
            minItems: PROJECT_PLAN_LIMITS.casesPerTag[0],
            maxItems: PROJECT_PLAN_LIMITS.casesPerTag[1],
            items: SITE_CASE_SCHEMA,
          },
          impact: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['currency', 'expectedLossAmount', 'penalty', 'rank'],
                additionalProperties: false,
                properties: {
                  rank: { type: 'integer', minimum: 1, maximum: 5 },
                  expectedLossAmount: { type: ['number', 'null'], minimum: 0 },
                  currency: { type: ['string', 'null'], pattern: '^[A-Z]{3}$' },
                  penalty: { type: 'string', maxLength: 240 },
                },
              },
            ],
          },
        },
      },
    },
  },
};

const SITE_IMPACT_SCHEMA = {
  oneOf: [
    { type: 'null' },
    {
      type: 'object',
      required: ['currency', 'expectedLossAmount', 'penalty', 'rank'],
      additionalProperties: false,
      properties: {
        rank: { type: 'integer', minimum: 1, maximum: 5 },
        expectedLossAmount: { type: ['number', 'null'], minimum: 0 },
        currency: { type: ['string', 'null'], pattern: '^[A-Z]{3}$' },
        penalty: { type: 'string', maxLength: 240 },
      },
    },
  ],
};

const EXPORT_PROJECTION_SCHEMA = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', minLength: 1, maxLength: 160 },
    projection: {
      type: 'string',
      enum: ['human_summary', 'timeline', 'case_matrix', 'runbook'],
      default: 'human_summary',
    },
    entryScope: {
      type: 'string',
      enum: ['selected_only', 'candidates', 'all'],
      description:
        'Omit for all active Cases in human_summary; other projections default to selected_only.',
    },
    columns: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: [...EXPORT_COLUMNS] },
    },
  },
};

function siteSchema(
  operation: string,
  required: string[],
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'object',
    required: [...['idempotencyKey', 'projectId', 'projectVersion', 'operation'], ...required],
    additionalProperties: false,
    properties: {
      ...SITE_BASE_SCHEMA,
      operation: { type: 'string', const: operation },
      ...properties,
    },
  };
}

function createListProjectsTool(
  dependencies: ReviewToolDependencies,
): WebMcpTool {
  return {
    name: 'list_projects',
    title: 'List Projects',
    description:
      'Read workspace status, the current Project context, and bounded locally saved Project summaries. When workspaceStatus is empty, use currentProjectId and currentProjectVersion only as the create_project mutation context.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => siteReadListProjects(input, dependencies),
  };
}

function createGetProjectTool(
  dependencies: ReviewToolDependencies,
): WebMcpTool {
  return {
    name: 'get_project',
    title: 'Read Project',
    description: 'Read a bounded Project, Plan, What-if, Case, or selected Final projection.',
    inputSchema: {
      type: 'object',
      required: ['section'],
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', minLength: 1, maxLength: 160 },
        section: {
          type: 'string',
          enum: ['project', 'plan', 'what_if', 'case', 'final'],
        },
        entityId: { type: 'string', minLength: 1, maxLength: 160 },
      },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => siteReadProject(input, dependencies),
  };
}

function createProjectTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  return {
    name: 'create_project',
    title: 'Create Project',
    description:
      'Create a Project, optionally with one atomic ordered Plan bundle containing What-if Cases and concrete candidate actions. Candidate actions remain undecided for the person to accept, edit, or dismiss in the page UI. On an empty workspace, first call list_projects and use its currentProjectId/currentProjectVersion as this mutation context.',
    inputSchema: {
      type: 'object',
      required: ['description', 'idempotencyKey', 'projectId', 'projectVersion', 'title'],
      additionalProperties: false,
      properties: {
        ...SITE_BASE_SCHEMA,
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 1000 },
        items: {
          type: 'array',
          minItems: PROJECT_PLAN_LIMITS.items[0],
          maxItems: PROJECT_PLAN_LIMITS.items[1],
          items: SITE_CREATE_ITEM_SCHEMA,
        },
      },
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, options) =>
      executeSiteMutation(
        input,
        options,
        dependencies,
        cache,
        'create_project',
        siteValidateCreateProject,
      ),
  };
}

function createOpenProjectTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  return {
    name: 'open_project',
    title: 'Open Project',
    description: 'Open one bounded locally saved Project by ID.',
    inputSchema: {
      type: 'object',
      required: ['idempotencyKey', 'projectId', 'projectVersion', 'targetProjectId'],
      additionalProperties: false,
      properties: {
        ...SITE_BASE_SCHEMA,
        targetProjectId: { type: 'string', minLength: 1, maxLength: 160 },
      },
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, options) =>
      executeSiteMutation(
        input,
        options,
        dependencies,
        cache,
        'open_project',
        siteValidateOpenProject,
      ),
  };
}

function createUpdateProjectTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  return {
    name: 'update_project',
    title: 'Update Project',
    description: 'Update only the current Project title and description.',
    inputSchema: {
      type: 'object',
      required: ['description', 'idempotencyKey', 'projectId', 'projectVersion', 'title'],
      additionalProperties: false,
      properties: {
        ...SITE_BASE_SCHEMA,
        title: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 1000 },
      },
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, options) =>
      executeSiteMutation(
        input,
        options,
        dependencies,
        cache,
        'update_project',
        siteValidateUpdateProject,
      ),
  };
}

function createSetProjectViewTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  return {
    name: 'set_project_view',
    title: 'Set Project View',
    description: 'Switch the current Project between editing and final view.',
    inputSchema: {
      type: 'object',
      required: ['idempotencyKey', 'projectId', 'projectVersion', 'viewMode'],
      additionalProperties: false,
      properties: {
        ...SITE_BASE_SCHEMA,
        viewMode: { type: 'string', enum: ['editing', 'final'] },
      },
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, options) =>
      executeSiteMutation(
        input,
        options,
        dependencies,
        cache,
        'set_project_view',
        siteValidateSetProjectView,
      ),
  };
}

function createEditPlanTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  const itemProperties = {
    itemId: { type: 'string', minLength: 1, maxLength: 160 },
    itemVersion: { type: 'integer', minimum: 1 },
  };
  return {
    name: 'edit_plan',
    title: 'Edit Plan',
    description: 'Perform exactly one bounded add, update, move, or delete Plan operation.',
    inputSchema: {
      oneOf: [
        siteSchema('add', ['timeOrCue', 'title', 'body'], {
          timeOrCue: { type: 'string', maxLength: 40 },
          title: { type: 'string', minLength: 1, maxLength: 120 },
          body: { type: 'string', maxLength: 1200 },
        }),
        siteSchema('update', ['itemId', 'itemVersion', 'timeOrCue', 'title', 'body'], {
          ...itemProperties,
          timeOrCue: { type: 'string', maxLength: 40 },
          title: { type: 'string', minLength: 1, maxLength: 120 },
          body: { type: 'string', maxLength: 1200 },
        }),
        siteSchema('move', ['itemId', 'itemVersion', 'direction'], {
          ...itemProperties,
          direction: { type: 'string', enum: ['up', 'down'] },
        }),
        siteSchema('delete', ['itemId', 'itemVersion'], itemProperties),
      ],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, options) =>
      executeSiteMutation(
        input,
        options,
        dependencies,
        cache,
        'edit_plan',
        siteValidatePlanEdit,
      ),
  };
}

function createEditWhatIfTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  const tagProperties = {
    tagId: { type: 'string', minLength: 1, maxLength: 160 },
    tagVersion: { type: 'integer', minimum: 1 },
  };
  const itemProperties = {
    itemId: { type: 'string', minLength: 1, maxLength: 160 },
    itemVersion: { type: 'integer', minimum: 1 },
  };
  const caseSchema = {
    type: 'object',
    required: ['suggestedActions', 'title'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 },
      suggestedActions: {
        type: 'array',
        minItems: 1,
        maxItems: NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1],
        items: { type: 'string', minLength: 1, maxLength: 1200 },
      },
    },
  };
  const tagTextProperties = {
    question: { type: 'string', minLength: 1, maxLength: 180 },
    rationale: { type: 'string', minLength: 1, maxLength: 400 },
    summary: { type: 'string', minLength: 1, maxLength: 400 },
    cases: {
      type: 'array',
      minItems: 1,
      maxItems: NORMAL_REVIEW_LIMITS.casesPerTag[1],
      items: caseSchema,
    },
  };
  return {
    name: 'edit_what_if',
    title: 'Edit What-if',
    description:
      'Perform exactly one bounded add, update, delete, impact, or stable impact-sort operation. Added Cases contain candidate actions only and remain undecided.',
    inputSchema: {
      oneOf: [
        siteSchema('add', [
          'itemId',
          'itemVersion',
          'question',
          'rationale',
          'summary',
          'cases',
        ], {
          ...itemProperties,
          ...tagTextProperties,
          impact: SITE_IMPACT_SCHEMA,
        }),
        siteSchema('update', ['tagId', 'tagVersion', 'question', 'rationale', 'summary'], {
          ...tagProperties,
          question: tagTextProperties.question,
          rationale: tagTextProperties.rationale,
          summary: tagTextProperties.summary,
        }),
        siteSchema('delete', ['tagId', 'tagVersion'], tagProperties),
        siteSchema('set_impact', ['tagId', 'tagVersion', 'impact'], {
          ...tagProperties,
          impact: SITE_IMPACT_SCHEMA,
        }),
        siteSchema('sort_by_impact', ['itemId', 'itemVersion'], itemProperties),
      ],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, options) =>
      executeSiteMutation(
        input,
        options,
        dependencies,
        cache,
        'edit_what_if',
        siteValidateWhatIfEdit,
      ),
  };
}

function createEditCaseTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  const caseProperties = {
    caseId: { type: 'string', minLength: 1, maxLength: 160 },
    caseVersion: { type: 'integer', minimum: 1 },
  };
  const tagProperties = {
    tagId: { type: 'string', minLength: 1, maxLength: 160 },
    tagVersion: { type: 'integer', minimum: 1 },
  };
  const suggestedActions = {
    type: 'array',
    minItems: 1,
    maxItems: NORMAL_REVIEW_LIMITS.suggestedActionsPerCase[1],
    items: { type: 'string', minLength: 1, maxLength: 1200 },
  };
  return {
    name: 'edit_case',
    title: 'Edit Case',
    description:
      'Add, update, or delete one bounded Case and its concrete candidate actions. This tool cannot accept, dismiss, or save a human response; the person makes that decision in the page UI.',
    inputSchema: {
      oneOf: [
        siteSchema('add', ['tagId', 'tagVersion', 'title', 'suggestedActions'], {
          ...tagProperties,
          title: { type: 'string', minLength: 1, maxLength: 120 },
          suggestedActions,
        }),
        siteSchema('update', ['caseId', 'caseVersion', 'title', 'suggestedActions'], {
          ...caseProperties,
          title: { type: 'string', minLength: 1, maxLength: 120 },
          suggestedActions,
        }),
        siteSchema('delete', ['caseId', 'caseVersion'], caseProperties),
      ],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, options) =>
      executeSiteMutation(
        input,
        options,
        dependencies,
        cache,
        'edit_case',
        siteValidateCaseEdit,
      ),
  };
}

function createEditPlanBOptionsTool(
  dependencies: ReviewToolDependencies,
  cache: Map<string, CachedApplyResult>,
): WebMcpTool {
  const caseProperties = {
    caseId: { type: 'string', minLength: 1, maxLength: 160 },
    caseVersion: { type: 'integer', minimum: 1 },
  };
  const option = { type: 'string', minLength: 1, maxLength: 1200 };
  const optionNumber = { type: 'integer', minimum: 1, maximum: 5 };
  return {
    name: 'edit_plan_b_options',
    title: 'Edit Plan B Options',
    description:
      'Create or edit the unsaved Plan B option draft for any Case under any What-if. Use replace with an empty options array to create an empty draft; use add, update, or delete for individual options; use discard to remove the draft. optionNumber is one-based (Option 1 through Option 5). This tool never accepts or saves the Plan B decision—the person reviews, edits, rejects, or saves it in the page UI.',
    inputSchema: {
      oneOf: [
        siteSchema('replace', ['caseId', 'caseVersion', 'options'], {
          ...caseProperties,
          options: {
            type: 'array',
            maxItems: 5,
            items: option,
          },
        }),
        siteSchema('add', ['caseId', 'caseVersion', 'option'], {
          ...caseProperties,
          option,
        }),
        siteSchema(
          'update',
          ['caseId', 'caseVersion', 'optionNumber', 'option'],
          { ...caseProperties, optionNumber, option },
        ),
        siteSchema('delete', ['caseId', 'caseVersion', 'optionNumber'], {
          ...caseProperties,
          optionNumber,
        }),
        siteSchema('discard', ['caseId', 'caseVersion'], caseProperties),
      ],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, options) =>
      executeSiteMutation(
        input,
        options,
        dependencies,
        cache,
        'edit_plan_b_options',
        siteValidatePlanBOptionsEdit,
      ),
  };
}

function createGetExportProjectionTool(
  dependencies: ReviewToolDependencies,
): WebMcpTool {
  return {
    name: 'get_export_projection',
    title: 'Read Export Projection',
    description:
      'Read a bounded projection of the last saved Project as structured JSON. Omit projection, or use human_summary, for ordinary human-readable CSV, spreadsheet, document, or summary requests: it returns the Project title once, omits internal IDs/version, and supplies table-ready rows whose repeated Plan and What-if cells are intentionally blank. Preserve those blanks and do not repeat the Project title in every row. Use timeline, case_matrix, or runbook only when the user explicitly requests machine-readable records, a detailed Case matrix, or a runbook. Candidate actions and saved responses remain separate, ordered actions stay in one cell with line breaks, and resolved/dismissed history is excluded.',
    inputSchema: EXPORT_PROJECTION_SCHEMA,
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => siteReadExportProjection(input, dependencies),
  };
}

export function createSiteTools(
  dependencies: ReviewToolDependencies,
): WebMcpTool[] {
  const cache = new Map<string, CachedApplyResult>();
  return [
    createListProjectsTool(dependencies),
    createGetProjectTool(dependencies),
    createProjectTool(dependencies, cache),
    createOpenProjectTool(dependencies, cache),
    createUpdateProjectTool(dependencies, cache),
    createSetProjectViewTool(dependencies, cache),
    createEditPlanTool(dependencies, cache),
    createEditWhatIfTool(dependencies, cache),
    createEditCaseTool(dependencies, cache),
    createEditPlanBOptionsTool(dependencies, cache),
    createGetExportProjectionTool(dependencies),
  ];
}

export function registerSiteTools(
  host: ModelContextHost,
  dependencies: ReviewToolDependencies,
  onAvailability: (availability: WebMcpAvailability) => void = () => {},
): () => void {
  const modelContext = host.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== 'function') {
    onAvailability('unavailable');
    return () => {};
  }

  onAvailability('checking');
  const controller = new AbortController();
  let disposed = false;
  const tools = createSiteTools(dependencies);

  void (async () => {
    try {
      await Promise.all(
        tools.map((tool) =>
          modelContext.registerTool(tool, { signal: controller.signal }),
        ),
      );
      if (!disposed) onAvailability('available');
    } catch {
      controller.abort();
      if (!disposed) onAvailability('failed');
    }
  })();

  return () => {
    disposed = true;
    controller.abort();
  };
}
