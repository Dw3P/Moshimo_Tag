'use client';

import Image from 'next/image';
import {
  FormEvent,
  Fragment,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  dispatch,
  getHistoryAvailability,
  getServerSnapshot,
  getSnapshot,
  initializePersistence,
  isEmptyWorkspaceProject,
  resetPersistence,
  subscribe,
  type CaseDisposition,
  type CaseResponse,
  type CaseResponseCandidate,
  type CommandResult,
  type ImpactRank,
  type MoshimoCase,
  type MoshimoTag,
  type PersistenceResult,
  type PlanGapSuggestion,
  type PlanBCountermeasure,
  type PreparationStatus,
  type ProjectState,
  type ReviewKind,
  type TimelineItem,
} from '@/src/app-state';
import {
  registerReviewTools,
  registerSiteTools,
  type ModelContextPort,
  type WebMcpAvailability,
} from '@/src/webmcp';

function submittedForReview(event: FormEvent<HTMLFormElement>): boolean {
  const submitter = (event.nativeEvent as SubmitEvent).submitter;
  return submitter instanceof HTMLButtonElement && submitter.value === 'review';
}

const dispositionLabels: Record<CaseDisposition, string> = {
  covered: 'Already covered',
  accept: 'Accept risk',
  prepare: 'Prepare',
  dismiss: 'Dismiss',
};

const dispositionDescriptions: Record<CaseDisposition, string> = {
  covered: 'The main Plan already handles this Situation.',
  accept: 'Continue without adding a preventive action.',
  prepare: 'Add what must be ready before carrying out this countermeasure.',
  dismiss: 'Do not use this countermeasure in the Final plan.',
};

type ReviewActivityState = 'waiting' | 'reviewing' | 'saving';

type EditableCaseDisposition = Extract<
  CaseDisposition,
  'covered' | 'accept' | 'prepare'
>;

interface CaseResponseDraft {
  actions: string[];
  when: string;
  status: PreparationStatus;
}

const AGENT_EXAMPLE_REQUEST =
  'On this open Moshimo Tag page, use WebMCP to create a Project for [what you want to plan — e.g. baking a baguette]. Add the expected Plan, likely What ifs, Situations, main countermeasures, and useful Plan B countermeasures. Unless I name other people, write every action for the Project owner to carry out alone. Leave every decision undecided for me to review.';

function normalizeReviewActivity(value: unknown): ReviewActivityState {
  const activity =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? (() => {
            const record = value as Record<string, unknown>;
            return record.phase ?? record.status ?? record.state ?? record.type;
          })()
        : null;
  return activity === 'reviewing' || activity === 'saving'
    ? activity
    : 'waiting';
}

function reviewScopeLabel(
  project: ProjectState,
  kind: ReviewKind,
  ownerId: string,
): string {
  switch (kind) {
    case 'project_plan':
      return `New project · ${project.title}`;
    case 'timeline_whatifs':
      return 'Full Plan';
    case 'timeline_gaps':
      return 'Gaps';
    case 'item_whatifs':
      return `Item · ${
        project.timeline.find((item) => item.id === ownerId)?.title ??
        'selected item'
      }`;
    case 'tag_cases': {
      const tag = project.timeline
        .flatMap((item) => item.tags)
        .find((candidate) => candidate.id === ownerId);
      return `What if · ${tag?.question ?? 'selected What if'}`;
    }
    case 'case_actions': {
      const caseItem = project.timeline
        .flatMap((item) => item.tags)
        .flatMap((tag) => tag.cases)
        .find((candidate) => candidate.id === ownerId);
      return `Situation · ${caseItem?.title ?? 'selected situation'}`;
    }
  }
}

function recheckScopeLabel(project: ProjectState, tagIds: string[]): string {
  const tags = project.timeline
    .flatMap((item) => item.tags)
    .filter((tag) => tagIds.includes(tag.id));
  if (tags.length === 1) return `Recheck · ${tags[0].question}`;
  return `Recheck · ${tags.length || 1} stale What ifs`;
}

function activeRequestKey(project: ProjectState): string | null {
  if (project.activeReviewRequest) return project.activeReviewRequest.id;
  if (project.activeRecheckRequest) return project.activeRecheckRequest.id;
  return null;
}

type EditingOrderEntry =
  | { kind: 'item'; id: string }
  | { kind: 'gap'; id: string };

function proposedEditingOrder(project: ProjectState): EditingOrderEntry[] {
  const entries: EditingOrderEntry[] = [];
  const proposedGaps = project.gapSuggestions.filter(
    (gap) => gap.status === 'proposed',
  );
  for (const item of project.timeline) {
    entries.push({ kind: 'item', id: item.id });
    for (const gap of proposedGaps) {
      if (gap.insertAfterItemId === item.id) {
        entries.push({ kind: 'gap', id: gap.id });
      }
    }
  }
  for (const gap of proposedGaps) {
    if (gap.insertAfterItemId === null) {
      entries.push({ kind: 'gap', id: gap.id });
    }
  }
  return entries;
}

function canMoveEditingEntry(
  project: ProjectState,
  entry: EditingOrderEntry,
  direction: 'up' | 'down',
): boolean {
  const entries = proposedEditingOrder(project);
  const from = entries.findIndex(
    (candidate) => candidate.kind === entry.kind && candidate.id === entry.id,
  );
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= entries.length) return false;
  const next = [...entries];
  [next[from], next[to]] = [next[to], next[from]];
  const firstItemIndex = next.findIndex((candidate) => candidate.kind === 'item');
  return (
    firstItemIndex < 0 ||
    !next.slice(0, firstItemIndex).some((candidate) => candidate.kind === 'gap')
  );
}

type InterfaceIconName =
  | 'call-split'
  | 'chevron-right'
  | 'check-circle-outline'
  | 'close'
  | 'delete'
  | 'info-outline'
  | 'person'
  | 'redo'
  | 'schedule'
  | 'smart-toy'
  | 'sort'
  | 'undo'
  | 'verified-user';

const dispositionIconNames: Record<CaseDisposition, InterfaceIconName> = {
  covered: 'verified-user',
  accept: 'check-circle-outline',
  prepare: 'schedule',
  dismiss: 'close',
};

function InterfaceIcon({
  className,
  name,
}: {
  className: string;
  name: InterfaceIconName;
}) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={className}
      height={24}
      src={`/icons/${name}.svg`}
      width={24}
    />
  );
}

function AiIcon() {
  return <InterfaceIcon className="ai-action-icon" name="smart-toy" />;
}

function HumanActionIcon() {
  return <InterfaceIcon className="action-source-icon" name="person" />;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <InterfaceIcon
      className={`disclosure-icon ${expanded ? 'is-expanded' : ''}`}
      name="chevron-right"
    />
  );
}

function SuggestedActionBlock({
  actions,
  source,
  historical = false,
}: {
  actions: string[];
  source: NonNullable<MoshimoCase['suggestedActionSource']>;
  historical?: boolean;
}) {
  const label =
    source === 'agent'
      ? historical
        ? 'AI suggestion history'
        : 'AI suggestion — not adopted'
      : historical
        ? 'Your starting action history'
        : 'Your starting action';

  return (
    <section aria-label={label} className="suggested-action-block">
      <span className="action-source-mark" title={label}>
        {source === 'agent' ? <AiIcon /> : <HumanActionIcon />}
      </span>
      <div className="suggested-action-list">
        {actions.map((action, index) => (
          <p key={`${action}-${index}`}>{action}</p>
        ))}
      </div>
    </section>
  );
}

function PlanActionIcon({
  name,
}: {
  name: 'edit' | 'move-up' | 'move-down' | 'delete';
}) {
  return (
    <svg
      aria-hidden="true"
      className="plan-action-icon"
      focusable="false"
      viewBox="0 0 24 24"
    >
      {name === 'edit' ? (
        <>
          <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
          <path d="m13.5 6.5 4 4" />
        </>
      ) : null}
      {name === 'move-up' ? (
        <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
      ) : null}
      {name === 'move-down' ? (
        <path d="M12 5v14m-5.5-5.5L12 19l5.5-5.5" />
      ) : null}
      {name === 'delete' ? (
        <>
          <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
          <path d="M10 11v5M14 11v5" />
        </>
      ) : null}
    </svg>
  );
}

type ProjectDialogMode = 'new' | 'open';
type NewProjectMode = 'ai' | 'manual';

// Keep the legacy, button-gated AI request flow available for a future
// migration, but keep it out of the current direct-WebMCP product surface.
const LEGACY_AI_UI_ENABLED = false;

type ManualImpactLevel = 'unset' | `${ImpactRank}`;

const impactLabels: Record<ImpactRank, string> = {
  1: 'Low',
  2: 'Low–medium',
  3: 'Medium',
  4: 'Medium–high',
  5: 'High',
};

function manualImpactLevel(impact: MoshimoTag['impact']): ManualImpactLevel {
  return impact ? `${impact.rank}` : 'unset';
}

function manualImpactRank(
  level: Exclude<ManualImpactLevel, 'unset'>,
): ImpactRank {
  return Number(level) as ImpactRank;
}

function ImpactBadge({ impact }: { impact: MoshimoTag['impact'] }) {
  if (!impact) return null;

  const amount =
    impact.expectedLossAmount === null ||
    !Number.isFinite(impact.expectedLossAmount)
      ? null
      : `${impact.currency ? `${impact.currency} ` : ''}${new Intl.NumberFormat(
          'en-US',
          { maximumFractionDigits: 2 },
        ).format(impact.expectedLossAmount)}`;

  return (
    <span
      aria-label={`Impact ${impactLabels[impact.rank]}, rank ${impact.rank} of 5`}
      className="impact-badge"
    >
      <span>
        {impactLabels[impact.rank]} impact{amount ? ` · ${amount}` : ''}
      </span>
      {impact.penalty ? (
        <small title={impact.penalty}>Penalty: {impact.penalty}</small>
      ) : null}
    </span>
  );
}

function ProjectDialog({
  mode,
  newTitle,
  newMode,
  planningBrief,
  projects,
  currentProjectId,
  reviewBlocked,
  onClose,
  onCreate,
  onNewTitleChange,
  onNewModeChange,
  onPlanningBriefChange,
  onOpen,
}: {
  mode: ProjectDialogMode;
  newTitle: string;
  newMode: NewProjectMode;
  planningBrief: string;
  projects: ProjectState[];
  currentProjectId: string;
  reviewBlocked: boolean;
  onClose: () => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onNewTitleChange: (value: string) => void;
  onNewModeChange: (mode: NewProjectMode) => void;
  onPlanningBriefChange: (value: string) => void;
  onOpen: (projectId: string) => void;
}) {
  const aiTabRef = useRef<HTMLButtonElement>(null);
  const manualTabRef = useRef<HTMLButtonElement>(null);
  const inactiveProjects = projects.filter(
    (project) => project.id !== currentProjectId,
  );

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    event.preventDefault();
    const nextMode =
      event.key === 'Home'
        ? 'ai'
        : event.key === 'End'
          ? 'manual'
          : newMode === 'ai'
            ? 'manual'
            : 'ai';
    onNewModeChange(nextMode);
    (nextMode === 'ai' ? aiTabRef : manualTabRef).current?.focus();
  }

  return (
    <div className="project-dialog-backdrop">
      <section
        aria-labelledby="project-dialog-title"
        aria-modal="true"
        className="project-dialog"
        role="dialog"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="project-dialog-heading">
          <div>
            <p className="eyebrow">Projects</p>
            <h2 id="project-dialog-title">
              {mode === 'new' ? 'New project' : 'Open project'}
            </h2>
          </div>
          <button
            aria-label="Close project dialog"
            autoFocus={mode === 'open'}
            className="project-dialog-close"
            type="button"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {mode === 'new' ? (
          <>
            {LEGACY_AI_UI_ENABLED ? (
              <div
                aria-label="Project creation mode"
                className="project-dialog-tabs"
                role="tablist"
              >
                <button
                  aria-controls="project-create-panel"
                  aria-selected={newMode === 'ai'}
                  className={newMode === 'ai' ? 'is-active' : undefined}
                  id="project-tab-ai"
                  ref={aiTabRef}
                  role="tab"
                  tabIndex={newMode === 'ai' ? 0 : -1}
                  type="button"
                  onKeyDown={handleTabKeyDown}
                  onClick={() => onNewModeChange('ai')}
                >
                  With AI
                </button>
                <button
                  aria-controls="project-create-panel"
                  aria-selected={newMode === 'manual'}
                  className={newMode === 'manual' ? 'is-active' : undefined}
                  id="project-tab-manual"
                  ref={manualTabRef}
                  role="tab"
                  tabIndex={newMode === 'manual' ? 0 : -1}
                  type="button"
                  onKeyDown={handleTabKeyDown}
                  onClick={() => onNewModeChange('manual')}
                >
                  Manual
                </button>
              </div>
            ) : null}
            <div
              aria-label={LEGACY_AI_UI_ENABLED ? undefined : 'Create project'}
              aria-labelledby={
                LEGACY_AI_UI_ENABLED
                  ? newMode === 'ai'
                    ? 'project-tab-ai'
                    : 'project-tab-manual'
                  : undefined
              }
              className="project-dialog-tabpanel"
              id="project-create-panel"
              role={LEGACY_AI_UI_ENABLED ? 'tabpanel' : undefined}
            >
              {LEGACY_AI_UI_ENABLED && newMode === 'ai' ? (
                <p className="project-dialog-copy">
                  Describe what you are planning. From this title and brief, a
                  compatible browser AI can create an editable initial Timeline
                  with What ifs attached to each step.
                </p>
              ) : null}
              <form onSubmit={onCreate}>
                <label htmlFor="new-project-title">
                  Project title
                  <input
                    autoFocus
                    id="new-project-title"
                    maxLength={120}
                    name="title"
                    placeholder="e.g. Weekend in Tokyo…"
                    required
                    value={newTitle}
                    onChange={(event) =>
                      onNewTitleChange(event.currentTarget.value)
                    }
                  />
                </label>
                {LEGACY_AI_UI_ENABLED && newMode === 'ai' ? (
                  <label htmlFor="new-project-brief">
                    Planning brief
                    <textarea
                      id="new-project-brief"
                      maxLength={1000}
                      name="description"
                      placeholder="What are you planning…"
                      required
                      rows={4}
                      value={planningBrief}
                      onChange={(event) =>
                        onPlanningBriefChange(event.currentTarget.value)
                      }
                    />
                  </label>
                ) : null}
                <div className="form-actions project-dialog-actions">
                  <button type="button" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    className={`primary-action ${
                      LEGACY_AI_UI_ENABLED && newMode === 'ai'
                        ? 'ai-create-action'
                        : ''
                    }`}
                    disabled={reviewBlocked}
                    type="submit"
                  >
                    {LEGACY_AI_UI_ENABLED && newMode === 'ai' ? (
                      <>
                        <AiIcon />
                        Create Plan with AI
                      </>
                    ) : (
                      'Create project'
                    )}
                  </button>
                </div>
              </form>
            </div>
          </>
        ) : inactiveProjects.length ? (
          <div className="project-list" aria-label="Other projects">
            {inactiveProjects.map((project) => (
              <button
                className="project-list-item"
                disabled={reviewBlocked}
                key={project.id}
                type="button"
                onClick={() => onOpen(project.id)}
              >
                <span>
                  <strong>{project.title}</strong>
                  {project.description ? (
                    <small>{project.description}</small>
                  ) : null}
                </span>
                <span aria-hidden="true" className="project-list-arrow">
                  →
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="project-dialog-empty">
            No other saved Projects yet.
          </p>
        )}
      </section>
    </div>
  );
}

function ProjectDeleteDialog({
  project,
  onClose,
  onConfirm,
}: {
  project: ProjectState;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="project-dialog-backdrop">
      <section
        aria-describedby="delete-project-description"
        aria-labelledby="delete-project-title"
        aria-modal="true"
        className="project-dialog delete-project-dialog"
        role="alertdialog"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="project-dialog-heading">
          <div>
            <p className="eyebrow">Delete Project</p>
            <h2 id="delete-project-title">Delete “{project.title}”?</h2>
          </div>
          <button
            aria-label="Close delete Project dialog"
            className="project-dialog-close"
            type="button"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <p className="project-dialog-copy" id="delete-project-description">
          This removes the Project and its Plan, What ifs, situations, and responses
          from this browser. This action cannot be undone.
        </p>
        <div className="form-actions project-dialog-actions">
          <button autoFocus type="button" onClick={onClose}>
            Keep project
          </button>
          <button className="danger-action" type="button" onClick={onConfirm}>
            Delete project
          </button>
        </div>
      </section>
    </div>
  );
}

function EmptyWorkspace({
  canOpenProject,
  onCreateProject,
  onOpenProject,
}: {
  canOpenProject: boolean;
  onCreateProject: () => void;
  onOpenProject: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  async function copyExampleRequest() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable.');
      }
      await navigator.clipboard.writeText(AGENT_EXAMPLE_REQUEST);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1600);
    } catch (error) {
      console.error('Failed to copy the WebMCP example request.', error);
      setCopyState('failed');
    }
  }

  return (
    <div className="empty-workspace" id="top">
      <section className="empty-workspace-hero" aria-labelledby="empty-title">
        <div className="empty-workspace-intro">
          <h1 id="empty-title">Moshimo Tag</h1>
          <p className="empty-workspace-lede">
            <strong>Moshimo is Japanese for “what if.”</strong> Put the expected
            Plan and its possible detours side by side. Decide the response
            before you need it, then keep only the final choices.
          </p>
          <p className="empty-workspace-support">
            Works for trips, events, procedures, schedules, and other plans.
          </p>
        </div>
        <div className="empty-workspace-actions" aria-label="Ways to get started">
          <button className="primary-action" type="button" onClick={onCreateProject}>
            Create project
          </button>
          <button
            disabled={!canOpenProject}
            title={canOpenProject ? undefined : 'No saved projects yet'}
            type="button"
            onClick={onOpenProject}
          >
            Open project
          </button>
        </div>
      </section>

      <div className="start-paths" aria-label="Ways to use Moshimo Tag">
        <section
          aria-labelledby="quick-tour-title"
          className="start-path start-path-manual"
        >
          <h2 className="start-path-label" id="quick-tour-title">
            Create it yourself
          </h2>
          <div className="manual-guide" id="quick-tour">
            <p className="guide-kicker">Manual · 4 steps</p>
            <ol className="manual-guide-steps">
              <li>
                <h3>Step 1 — Add a Plan</h3>
                <p className="tutorial-step-copy">
                  Start with what you expect to happen, in order.
                </p>
                <figure className="tutorial-shot tutorial-shot-plan">
                  <Image
                    alt="A real Moshimo Tag Plan card for leaving home"
                    height={225}
                    src="/tutorial/steps/01-plan.jpg"
                    width={535}
                  />
                </figure>
              </li>
              <li>
                <h3>Step 2 — Attach a What if</h3>
                <p className="tutorial-step-copy">
                  Add a possible disruption beside the Plan it could change.
                </p>
                <figure className="tutorial-shot tutorial-shot-what-if">
                  <Image
                    alt="Two real What ifs connected to one Plan item"
                    height={160}
                    src="/tutorial/steps/02-what-ifs.jpg"
                    width={730}
                  />
                </figure>
              </li>
              <li>
                <h3>Step 3 — Choose a response</h3>
                <p className="tutorial-step-copy">
                  Open a What if, then choose how to handle each situation.
                </p>
                <figure className="tutorial-shot tutorial-shot-case">
                  <Image
                    alt="One expanded What if with an Action, Plan B, and response choices"
                    height={653}
                    src="/tutorial/steps/03-situation-response.png"
                    width={730}
                  />
                </figure>
              </li>
              <li>
                <h3>Step 4 — Review the Final view</h3>
                <p className="tutorial-step-copy">
                  Review only the responses you kept, connected to the Plan.
                </p>
                <figure className="tutorial-shot tutorial-shot-final">
                  <Image
                    alt="A real Final view where one Plan branches to selected Actions and Plan B"
                    height={1050}
                    src="/tutorial/steps/04-final-plan-review.jpg"
                    width={1280}
                  />
                </figure>
              </li>
            </ol>
          </div>
        </section>

        <div aria-hidden="true" className="start-path-or">
          <span>or</span>
        </div>

        <section
          aria-labelledby="agent-start-title"
          className="start-path start-path-agent"
        >
          <h2 className="start-path-label" id="agent-start-title">
            Work with an agent
          </h2>
          <div className="agent-start" id="agent-start">
            <p className="guide-kicker">WebMCP · one request</p>
            <figure className="agent-flow-visual">
              <Image
                alt="A person asks an agent, the agent applies the request through WebMCP, and a Plan with linked What ifs is ready"
                height={1200}
                src="/tutorial/agent-webmcp-flow.svg"
                unoptimized
                width={1200}
              />
            </figure>
            <p className="agent-start-intro">
              Give ChatGPT or Codex a request, optionally attach source material,
              and ask it to work on this open Moshimo Tag page through WebMCP.
              It can turn your material into the expected steps, likely problems,
              and practical options for handling each one. You decide what to
              keep, change, or remove.
            </p>

            <div className="agent-start-example">
              <div className="agent-example-heading">
                <p className="agent-example-label">Example request</p>
                <button
                  aria-label={
                    copyState === 'copied'
                      ? 'Example request copied'
                      : 'Copy example request'
                  }
                  className="agent-example-copy"
                  title={
                    copyState === 'copied'
                      ? 'Copied'
                      : 'Copy example request'
                  }
                  type="button"
                  onClick={copyExampleRequest}
                >
                  <Image
                    aria-hidden="true"
                    alt=""
                    height={16}
                    src={
                      copyState === 'copied'
                        ? '/icons/check.svg'
                        : '/icons/content-copy.svg'
                    }
                    width={16}
                  />
                  <span aria-live="polite" className="visually-hidden">
                    {copyState === 'copied'
                      ? 'Example request copied'
                      : 'Copy example request'}
                  </span>
                </button>
              </div>
              <blockquote>{AGENT_EXAMPLE_REQUEST}</blockquote>
              {copyState === 'failed' ? (
                <p className="agent-copy-error" role="status">
                  Copy failed. Select and copy the request manually.
                </p>
              ) : null}
            </div>

            <div className="agent-file-examples">
              <strong>You can attach (optional)</strong>
              <ul>
                <li>Itinerary or flight details (PDF or CSV)</li>
                <li>Run sheet or checklist (CSV)</li>
                <li>Traffic report, hotel booking, or notes</li>
                <li>A spoken brief (transcribed)</li>
              </ul>
            </div>

            <p className="agent-privacy-note">
              WebMCP lets a compatible agent read and edit this page without a
              separate Moshimo Tag plugin or MCP server setup. Keep this page
              open and give the agent a clear instruction.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function CountermeasureCard({
  caseId,
  situationTitle,
  planBId,
  label,
  actions,
  source,
  response,
  responseCandidates,
  onDelete,
  onFeedback,
}: {
  caseId: string;
  situationTitle: string;
  planBId: string | null;
  label: string;
  actions: string[];
  source: PlanBCountermeasure['source'] | null;
  response: CaseResponse | null;
  responseCandidates: CaseResponseCandidate[];
  onDelete?: () => void;
  onFeedback: (result: CommandResult, successMessage: string) => boolean;
}) {
  const [editingDecision, setEditingDecision] = useState(false);
  const [draftDisposition, setDraftDisposition] =
    useState<EditableCaseDisposition | null>(null);
  const [draft, setDraft] = useState<CaseResponseDraft | null>(null);
  const [editingAction, setEditingAction] = useState(false);
  const [actionDraft, setActionDraft] = useState(actions.join('\n\n'));
  const choiceGroupRef = useRef<HTMLDivElement>(null);
  const editResponseRef = useRef<HTMLButtonElement>(null);
  const focusAfterRender = useRef<'choices' | 'saved' | null>(null);

  useEffect(() => {
    if (focusAfterRender.current === 'saved') {
      editResponseRef.current?.focus();
    } else if (focusAfterRender.current === 'choices') {
      choiceGroupRef.current?.querySelector('button')?.focus();
    }
    focusAfterRender.current = null;
  }, [draftDisposition, editingDecision, response]);

  function initialDraft(disposition: EditableCaseDisposition): CaseResponseDraft {
    const existing = response?.disposition === disposition ? response : null;
    const candidate = responseCandidates.find(
      (entry) => entry.disposition === disposition,
    );
    const startingPoint = existing ?? candidate ?? null;
    const optionalMemo = disposition === 'covered' || disposition === 'accept';
    return {
      actions: startingPoint
        ? optionalMemo && startingPoint.actions.length === 0
          ? ['']
          : [...startingPoint.actions]
        : [''],
      when: startingPoint?.when ?? '',
      status: existing?.status ?? 'pending',
    };
  }

  function beginDisposition(disposition: EditableCaseDisposition) {
    setDraftDisposition(disposition);
    setDraft(initialDraft(disposition));
    setEditingDecision(true);
  }

  function closeDecision(nextFocus: 'choices' | 'saved' | null = null) {
    focusAfterRender.current = nextFocus;
    setEditingDecision(false);
    setDraftDisposition(null);
    setDraft(null);
  }

  function saveDismissedDecision() {
    const result = dispatch({
      type: 'case.response.save',
      payload: {
        caseId,
        planBId,
        disposition: 'dismiss',
        actions: [],
        when: '',
        status: null,
      },
    });
    if (onFeedback(result, `${label} dismissed for ${situationTitle}.`)) {
      closeDecision('saved');
    }
  }

  function chooseDisposition(disposition: CaseDisposition) {
    if (disposition === 'dismiss') {
      saveDismissedDecision();
      return;
    }
    beginDisposition(disposition);
  }

  function editSavedResponse() {
    if (!response) return;
    if (response.disposition === 'dismiss') {
      setEditingDecision(true);
      setDraftDisposition(null);
      setDraft(null);
      return;
    }
    beginDisposition(response.disposition);
  }

  function saveResponse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftDisposition || !draft) return;
    const optionalMemo = draft.actions[0]?.trim() ?? '';
    const isOptionalMemo =
      draftDisposition === 'covered' || draftDisposition === 'accept';
    const result = dispatch({
      type: 'case.response.save',
      payload: {
        caseId,
        planBId,
        disposition: draftDisposition,
        actions: isOptionalMemo
          ? optionalMemo
            ? [optionalMemo]
            : []
          : [optionalMemo],
        when: draftDisposition === 'prepare' ? draft.when.trim() : '',
        status: draftDisposition === 'prepare' ? draft.status : null,
      },
    });
    if (onFeedback(result, `${label} response saved for ${situationTitle}.`)) {
      closeDecision('saved');
    }
  }

  function saveAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = actionDraft.trim();
    const result = planBId
      ? dispatch({
          type: 'case.planB.update',
          payload: { caseId, planBId, action: value },
        })
      : dispatch({
          type: 'case.action.update',
          payload: {
            caseId,
            suggestedActions: value
              .split(/\n\s*\n/u)
              .map((action) => action.trim())
              .filter(Boolean),
          },
        });
    if (onFeedback(result, `${label} updated for ${situationTitle}.`)) {
      setEditingAction(false);
    }
  }

  const showChoices = response === null || editingDecision;
  const isOptionalMemo =
    draftDisposition === 'covered' || draftDisposition === 'accept';

  return (
    <section
      aria-label={`${label} for ${situationTitle}`}
      className={`countermeasure-card ${planBId ? 'is-plan-b' : 'is-main'}`}
    >
      <header className="countermeasure-heading">
        <span className="countermeasure-kicker">{label}</span>
        <div className="countermeasure-tools">
          {!response ? <span className="case-status">! Undecided</span> : null}
          <button
            aria-label={`Edit ${label} for ${situationTitle}`}
            className="countermeasure-edit-action"
            type="button"
            onClick={() => {
              setActionDraft(actions.join('\n\n'));
              setEditingAction(true);
            }}
          >
            Edit action
          </button>
          {onDelete ? (
            <button
              aria-label={`Delete ${label} for ${situationTitle}`}
              className="inline-delete-action"
              title={`Delete ${label}`}
              type="button"
              onClick={onDelete}
            >
              <InterfaceIcon className="delete-action-icon" name="delete" />
            </button>
          ) : null}
        </div>
      </header>

      {editingAction ? (
        <form className="countermeasure-edit-form" onSubmit={saveAction}>
          <label>
            {label}
            <textarea
              autoFocus
              maxLength={planBId ? 1200 : 4800}
              required
              rows={3}
              value={actionDraft}
              onChange={(event) => setActionDraft(event.currentTarget.value)}
            />
          </label>
          {!planBId ? (
            <p>Separate multiple steps with a blank line.</p>
          ) : null}
          <div className="form-actions">
            <button
              type="button"
              onClick={() => {
                setActionDraft(actions.join('\n\n'));
                setEditingAction(false);
              }}
            >
              Cancel
            </button>
            <button className="primary-action" type="submit">
              Save action
            </button>
          </div>
        </form>
      ) : source && actions.length ? (
        <SuggestedActionBlock actions={actions} source={source} />
      ) : (
        <div className="empty-case-action">No countermeasure added yet.</div>
      )}

      {response && !editingDecision ? (
        <section
          aria-label={`Saved response for ${label}`}
          className="saved-case-response"
        >
          <div className="saved-response-copy">
            {response.disposition === 'covered' ? (
              <div className="saved-decision-summary">
                <strong>This countermeasure is already in place.</strong>
                <p>
                  {response.actions[0] ? (
                    <><span>Memo</span>{response.actions[0]}</>
                  ) : (
                    'No memo added.'
                  )}
                </p>
              </div>
            ) : response.disposition === 'accept' ? (
              <div className="saved-decision-summary">
                <strong>Risk accepted without using this countermeasure.</strong>
                <p>
                  {response.actions[0] ? (
                    <><span>Memo</span>{response.actions[0]}</>
                  ) : (
                    'No memo added.'
                  )}
                </p>
              </div>
            ) : response.disposition === 'prepare' ? (
              <>
                <p>{response.actions[0]}</p>
                <p className="preparation-meta">
                  {response.when ? `When: ${response.when} · ` : ''}
                  Status: {response.status ?? 'pending'}
                </p>
              </>
            ) : (
              <p>This countermeasure will not appear in the Final plan.</p>
            )}
          </div>
          <span className="case-status is-decided saved-response-status">
            ✓ {dispositionLabels[response.disposition]}
          </span>
          <button
            aria-label={`Edit response for ${label} in ${situationTitle}`}
            ref={editResponseRef}
            type="button"
            onClick={editSavedResponse}
          >
            Edit response
          </button>
        </section>
      ) : null}

      {responseCandidates.length ? (
        <section
          aria-label={`WebMCP response candidates for ${label}`}
          className="response-candidate-panel"
        >
          <div className="response-candidate-heading">
            <span>WebMCP candidates</span>
            <small>
              {response ? 'Saved response unchanged' : 'Prepared only · you decide'}
            </small>
          </div>
          <div className="response-candidate-list">
            {responseCandidates.map((candidate) => (
              <article key={candidate.disposition}>
                <strong>{dispositionLabels[candidate.disposition]}</strong>
                {candidate.actions[0] ? (
                  <p>
                    {candidate.disposition === 'prepare'
                      ? candidate.actions[0]
                      : `Memo: ${candidate.actions[0]}`}
                  </p>
                ) : (
                  <p>No memo proposed.</p>
                )}
                {candidate.disposition === 'prepare' && candidate.when ? (
                  <small>When: {candidate.when}</small>
                ) : null}
              </article>
            ))}
          </div>
          <p className="response-candidate-note">
            {response
              ? 'These candidates do not change the saved response.'
              : 'Nothing is decided until you choose and save a response.'}
          </p>
        </section>
      ) : null}

      {showChoices ? (
        <div
          aria-label={`Human decision only: response choices for ${label} in ${situationTitle}. Agents must leave this countermeasure undecided.`}
          className="case-choice-group"
          ref={choiceGroupRef}
          role="group"
        >
          {(Object.keys(dispositionLabels) as CaseDisposition[]).map(
            (disposition) => (
              <button
                aria-label={`Human decision only: ${dispositionLabels[disposition]} for ${label}. ${dispositionDescriptions[disposition]}`}
                aria-pressed={draftDisposition === disposition}
                className={
                  draftDisposition === disposition ? 'is-selected' : undefined
                }
                key={disposition}
                title={dispositionDescriptions[disposition]}
                type="button"
                onClick={() => chooseDisposition(disposition)}
              >
                <InterfaceIcon
                  className="case-choice-icon"
                  name={dispositionIconNames[disposition]}
                />
                <span>{dispositionLabels[disposition]}</span>
              </button>
            ),
          )}
        </div>
      ) : null}

      {editingDecision && draftDisposition && draft ? (
        <form
          aria-label={`Human decision editor for ${label}. Agents must not submit this response.`}
          className="case-response-editor"
          onSubmit={saveResponse}
        >
          <div className="response-editor-heading">
            <div>
              <p className="eyebrow">
                Your response · {dispositionLabels[draftDisposition]}
              </p>
              <strong>
                {draftDisposition === 'covered'
                  ? 'Record how this countermeasure is already covered'
                  : draftDisposition === 'accept'
                    ? 'Accept the risk without using this countermeasure'
                    : 'Write what must be ready before this countermeasure can work'}
              </strong>
              <p className="response-editor-guidance">
                {isOptionalMemo
                  ? 'Add a memo only if it helps explain the decision. This is optional.'
                  : 'Prepare is not the countermeasure itself. Record the prerequisite or setup needed to carry it out.'}
              </p>
            </div>
            <span className="human-label">Human decision · not saved</span>
          </div>

          <div className="response-action-field">
            <label>
              <span className="response-field-title">
                {isOptionalMemo ? 'Memo' : 'Preparation action'}
                {isOptionalMemo ? <span>(optional)</span> : null}
              </span>
              <textarea
                aria-label={`${isOptionalMemo ? 'Optional memo' : 'Preparation action'} for ${label}`}
                autoFocus
                maxLength={1200}
                placeholder={
                  draftDisposition === 'covered'
                    ? 'e.g. This is already included in the checklist.'
                    : draftDisposition === 'accept'
                      ? 'e.g. Continue as an experiment and accept the outcome.'
                      : 'e.g. Put the backup equipment by the workspace.'
                }
                required={!isOptionalMemo}
                rows={3}
                value={draft.actions[0] ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    actions: [event.currentTarget.value],
                  })
                }
              />
            </label>
          </div>

          {draftDisposition === 'prepare' ? (
            <div className="preparation-fields">
              <label>
                When <span>(optional)</span>
                <input
                  maxLength={120}
                  placeholder="e.g. Before leaving"
                  value={draft.when}
                  onChange={(event) =>
                    setDraft({ ...draft, when: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                Status
                <select
                  value={draft.status}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      status: event.currentTarget.value as PreparationStatus,
                    })
                  }
                >
                  <option value="pending">Pending</option>
                  <option value="done">Done</option>
                </select>
              </label>
            </div>
          ) : null}

          <div className="form-actions">
            <button
              type="button"
              onClick={() => closeDecision(response ? 'saved' : 'choices')}
            >
              Cancel
            </button>
            <button
              aria-label={`Human decision only: Save response for ${label}`}
              className="primary-action"
              type="submit"
            >
              Save response
            </button>
          </div>
        </form>
      ) : null}

      {editingDecision && !draftDisposition && response ? (
        <button
          className="cancel-response-edit"
          type="button"
          onClick={() => closeDecision('saved')}
        >
          Cancel editing
        </button>
      ) : null}
    </section>
  );
}

function CaseCard({
  caseItem,
  index,
  isOnlyCase,
  aiRequestBlocked,
  onDelete,
  onFeedback,
  onRequestReview,
}: {
  caseItem: MoshimoCase;
  index: number;
  isOnlyCase: boolean;
  aiRequestBlocked: boolean;
  onDelete: () => void;
  onFeedback: (result: CommandResult, successMessage: string) => boolean;
  onRequestReview: (kind: ReviewKind, ownerId: string) => void;
}) {
  const [addingPlanB, setAddingPlanB] = useState(false);
  const responses = [
    caseItem.response,
    ...caseItem.planBOptions.map((option) => option.response),
  ];
  const undecidedCount = responses.filter((response) => response === null).length;
  const deleteActionTitle = isOnlyCase
    ? 'Delete Situation and this What if'
    : 'Delete Situation';

  function addPlanB(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const action = String(new FormData(form).get('action') ?? '').trim();
    const result = dispatch({
      type: 'case.planB.add',
      payload: { caseId: caseItem.id, action },
    });
    if (onFeedback(result, `Plan B added for ${caseItem.title}.`)) {
      form.reset();
      setAddingPlanB(false);
    }
  }

  return (
    <article
      aria-labelledby={`case-heading-${caseItem.id}`}
      className="case-card"
    >
      <div className="case-heading">
        <div className="case-heading-meta">
          <span>Situation {index + 1}</span>
          <span className={`case-status ${undecidedCount === 0 ? 'is-decided' : ''}`}>
            {undecidedCount
              ? `! ${undecidedCount} undecided`
              : '✓ All decided'}
          </span>
        </div>
        <h4 id={`case-heading-${caseItem.id}`}>{caseItem.title}</h4>
        <div className="case-heading-controls">
          <button
            aria-label={`Add Plan B for ${caseItem.title}`}
            className="case-add-plan-b-action"
            disabled={addingPlanB || caseItem.planBOptions.length >= 5}
            type="button"
            onClick={() => setAddingPlanB(true)}
          >
            <InterfaceIcon className="case-choice-icon" name="call-split" />
            <span>+ Plan B</span>
          </button>
          <button
            aria-label={`Delete Situation ${caseItem.title}`}
            className="inline-delete-action"
            title={deleteActionTitle}
            type="button"
            onClick={onDelete}
          >
            <InterfaceIcon className="delete-action-icon" name="delete" />
          </button>
        </div>
      </div>

      <div
        className={`countermeasure-stack ${caseItem.planBOptions.length ? 'has-plan-b' : ''}`}
      >
        <CountermeasureCard
          actions={caseItem.suggestedActions}
          caseId={caseItem.id}
          label="Action"
          onFeedback={onFeedback}
          planBId={null}
          response={caseItem.response}
          responseCandidates={caseItem.responseCandidates}
          situationTitle={caseItem.title}
          source={caseItem.suggestedActionSource}
        />

        {caseItem.planBOptions.length ? (
          <div className="plan-b-branch">
            {caseItem.planBOptions.map((option, planBIndex) => (
              <div className="plan-b-node" key={option.id}>
                <CountermeasureCard
                  actions={[option.action]}
                  caseId={caseItem.id}
                  label={`Plan_B ${planBIndex + 1}`}
                  onDelete={() => {
                    const result = dispatch({
                      type: 'case.planB.delete',
                      payload: { caseId: caseItem.id, planBId: option.id },
                    });
                    onFeedback(result, `Plan B ${planBIndex + 1} deleted.`);
                  }}
                  onFeedback={onFeedback}
                  planBId={option.id}
                  response={option.response}
                  responseCandidates={option.responseCandidates}
                  situationTitle={caseItem.title}
                  source={option.source}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {addingPlanB ? (
        <form className="add-plan-b-panel" onSubmit={addPlanB}>
          <div>
            <p className="eyebrow">Fallback countermeasure</p>
            <strong>Add Plan B</strong>
            <p>Use it if the earlier countermeasure cannot work.</p>
          </div>
          <label>
            Plan B action
            <textarea
              autoFocus
              maxLength={1200}
              name="action"
              placeholder="What will the Project owner do instead?"
              required
              rows={3}
            />
          </label>
          <div className="form-actions">
            <button type="button" onClick={() => setAddingPlanB(false)}>
              Cancel
            </button>
            <button className="primary-action" type="submit">
              Add Plan B
            </button>
          </div>
        </form>
      ) : null}

      {caseItem.suggestedActions.length === 0 && LEGACY_AI_UI_ENABLED ? (
        <button
          aria-label={`Ask AI for actions for ${caseItem.title}`}
          disabled={aiRequestBlocked}
          type="button"
          onClick={() => onRequestReview('case_actions', caseItem.id)}
        >
          Ask AI for actions
        </button>
      ) : null}
    </article>
  );
}

function TagCard({
  tag,
  expanded,
  onToggle,
  aiRequestBlocked,
  onFeedback,
  onImpactChange,
  onMove,
  onRequestRecheck,
  onRequestReview,
  canMoveDown,
  canMoveUp,
  showOrderControls,
}: {
  tag: MoshimoTag;
  expanded: boolean;
  onToggle: () => void;
  aiRequestBlocked: boolean;
  onFeedback: (result: CommandResult, successMessage: string) => boolean;
  onImpactChange: (tag: MoshimoTag, level: ManualImpactLevel) => void;
  onMove: (tagId: string, direction: 'up' | 'down') => void;
  onRequestRecheck: (tagId: string) => void;
  onRequestReview: (kind: ReviewKind, ownerId: string) => void;
  canMoveDown: boolean;
  canMoveUp: boolean;
  showOrderControls: boolean;
}) {
  const [showAddCase, setShowAddCase] = useState(false);
  const undecidedCount = tag.cases.reduce(
    (count, caseItem) =>
      count +
      (caseItem.response === null ? 1 : 0) +
      caseItem.planBOptions.filter((option) => option.response === null).length,
    0,
  );

  function addCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const requestReview = submittedForReview(event);
    const title = String(formData.get('title') ?? '').trim();
    const result = dispatch({
      type: 'case.add',
      payload: {
        tagId: tag.id,
        title,
        ownAction: String(formData.get('ownAction') ?? ''),
        requestReview,
      },
    });
    if (
      onFeedback(
        result,
        requestReview
          ? `Situation added. Review requested for Situation · ${title}. Waiting for an AI agent.`
          : 'Situation added to this What if.',
      )
    ) {
      form.reset();
      setShowAddCase(false);
    }
  }

  function deleteCase(caseItem: MoshimoCase) {
    const result = dispatch({
      type: 'case.delete',
      payload: { caseId: caseItem.id },
    });
    onFeedback(
      result,
      tag.cases.length === 1
        ? `Situation ${caseItem.title} and its What if deleted.`
        : `Situation ${caseItem.title} deleted.`,
    );
  }

  function deleteWhatIf() {
    const result = dispatch({
      type: 'tag.delete',
      payload: { tagId: tag.id },
    });
    onFeedback(result, `What if ${tag.question} deleted.`);
  }

  return (
    <section className={`tag-card ${expanded ? 'is-expanded' : ''}`}>
      <div
        className={`tag-card-header ${
          showOrderControls ? 'has-order-controls' : ''
        }`}
      >
        <button
          className="tag-summary"
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span aria-hidden="true" className="disclosure">
            <ChevronIcon expanded={expanded} />
          </span>
          <span
            aria-label={
              tag.source === 'agent'
                ? 'Agent-created What if'
                : 'Your What if'
            }
            className="tag-source-mark"
            role="img"
            title={
              tag.source === 'agent'
                ? 'Agent-created What if'
                : 'Your What if'
            }
          >
            {tag.source === 'agent' ? <AiIcon /> : <HumanActionIcon />}
          </span>
          <span className="tag-question">{tag.question}</span>
          <span
            className={`undecided ${
              tag.needsRecheck
                ? 'needs-recheck'
                : undecidedCount === 0
                  ? 'is-decided'
                  : ''
            }`}
          >
            {tag.needsRecheck
              ? `! Needs recheck${
                  undecidedCount ? ` · ${undecidedCount} undecided` : ''
                }`
              : undecidedCount
                ? `! ${undecidedCount} undecided`
                : '✓ All decided'}
          </span>
        </button>

        <div className="tag-manual-controls">
          <label className="tag-impact-control">
            <span className="tag-impact-label">
              Impact
              <span
                aria-label="Impact means how serious the outcome would be if this What if happens."
                className="impact-help"
                role="img"
                tabIndex={0}
                title="How serious the outcome would be if this What if happens."
              >
                <InterfaceIcon
                  className="impact-help-icon"
                  name="info-outline"
                />
              </span>
            </span>
            <select
              aria-label={`Impact for ${tag.question}`}
              disabled={aiRequestBlocked}
              value={manualImpactLevel(tag.impact)}
              onChange={(event) =>
                onImpactChange(
                  tag,
                  event.currentTarget.value as ManualImpactLevel,
                )
              }
            >
              <option value="unset">Not set</option>
              <option value="1">Low</option>
              <option value="2">Low–medium</option>
              <option value="3">Medium</option>
              <option value="4">Medium–high</option>
              <option value="5">High</option>
            </select>
          </label>
          {showOrderControls ? (
            <div
              aria-label={`Manual order for ${tag.question}`}
              className="tag-order-controls"
              role="group"
            >
              <span className="visually-hidden">Order</span>
              <button
                aria-label={`Move ${tag.question} up`}
                disabled={!canMoveUp || aiRequestBlocked}
                title="Move up"
                type="button"
                onClick={() => onMove(tag.id, 'up')}
              >
                <PlanActionIcon name="move-up" />
              </button>
              <button
                aria-label={`Move ${tag.question} down`}
                disabled={!canMoveDown || aiRequestBlocked}
                title="Move down"
                type="button"
                onClick={() => onMove(tag.id, 'down')}
              >
                <PlanActionIcon name="move-down" />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {tag.needsRecheck ? (
        <div className="tag-recheck-action">
          <span>This What if is no longer current after a Plan edit.</span>
          {LEGACY_AI_UI_ENABLED ? (
            <button
              aria-label={`Recheck ${tag.question} with AI`}
              disabled={aiRequestBlocked}
              type="button"
              onClick={() => onRequestRecheck(tag.id)}
            >
              Recheck with AI
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="tag-detail" hidden={!expanded}>
        <div className="tag-detail-intro">
          <div className="tag-detail-meta">
            <span className="suggestion-label">
              {tag.source === 'agent'
                ? 'Agent suggestion — not adopted'
                : 'Added by you'}
            </span>
          </div>
          <div className="tag-detail-copy">
            <p className="tag-detail-guidance">{tag.summary}</p>
          </div>
        </div>
        <div className="case-list">
          {tag.cases.map((caseItem, index) => (
            <CaseCard
              aiRequestBlocked={aiRequestBlocked}
              caseItem={caseItem}
              index={index}
              isOnlyCase={tag.cases.length === 1}
              key={caseItem.id}
              onDelete={() => deleteCase(caseItem)}
              onFeedback={onFeedback}
              onRequestReview={onRequestReview}
            />
          ))}
        </div>
        {showAddCase ? (
          <form className="compact-composer" onSubmit={addCase}>
            <p className="eyebrow">Add a Situation</p>
            <label>
              Situation title
              <input
                maxLength={120}
                name="title"
                placeholder="What else might happen?"
                required
              />
            </label>
            <label>
              Your starting action <span>(optional)</span>
              <textarea
                maxLength={1200}
                name="ownAction"
                placeholder="What might you do in this situation?"
                rows={3}
              />
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setShowAddCase(false)}>
                Cancel
              </button>
              <button type="submit" value="add">
                Add only
              </button>
              {LEGACY_AI_UI_ENABLED ? (
                <button
                  className="primary-action"
                  disabled={aiRequestBlocked}
                  type="submit"
                  value="review"
                >
                  Add &amp; ask AI
                </button>
              ) : null}
            </div>
          </form>
        ) : (
          <div className="tag-actions">
            <button
              aria-label={`Add a Situation to ${tag.question}`}
              type="button"
              onClick={() => setShowAddCase(true)}
            >
              + Add Situation
            </button>
            {LEGACY_AI_UI_ENABLED ? (
              <button
                aria-label={`Ask AI about ${tag.question}`}
                disabled={aiRequestBlocked}
                type="button"
                onClick={() => onRequestReview('tag_cases', tag.id)}
              >
                Ask AI about this What if
              </button>
            ) : null}
            <button
              aria-label={`Delete What if ${tag.question}`}
              className="delete-what-if-action"
              title="Delete What if"
              type="button"
              onClick={deleteWhatIf}
            >
              <InterfaceIcon className="delete-action-icon" name="delete" />
              <span>Delete What if</span>
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ResolvedTagCard({
  tag,
  expanded,
  onToggle,
}: {
  tag: MoshimoTag;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <section className={`tag-card resolved-tag-card ${expanded ? 'is-expanded' : ''}`}>
      <button
        aria-expanded={expanded}
        className="tag-summary"
        type="button"
        onClick={onToggle}
      >
        <span className="tag-origin resolved-tag-origin">Resolved history</span>
        <span className="tag-question">{tag.question}</span>
        <ImpactBadge impact={tag.impact} />
        <span className="resolved-tag-status">Not current</span>
        <span aria-hidden="true" className="disclosure">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>

      {expanded ? (
        <div className="tag-detail resolved-tag-detail">
          <div className="tag-detail-meta">
            <span>Non-current history</span>
            <span className="suggestion-label resolved-tag-label">
              Resolved · read-only history
            </span>
          </div>
          <p className="tag-rationale">{tag.rationale}</p>
          <h3>{tag.summary}</h3>
          <div className="case-list">
            {tag.cases.map((caseItem, index) => (
              <article className="case-card resolved-case-card" key={caseItem.id}>
                <div className="case-heading">
                  <span>Situation {index + 1}</span>
                  <h4>{caseItem.title}</h4>
                  <span className="resolved-case-status">Archived</span>
                </div>
                {caseItem.suggestedActionSource &&
                caseItem.suggestedActions.length ? (
                  <SuggestedActionBlock
                    actions={caseItem.suggestedActions}
                    historical
                    source={caseItem.suggestedActionSource}
                  />
                ) : null}
                {caseItem.response ? (
                  <section
                    aria-label={`Previous response for ${caseItem.title}`}
                    className="resolved-case-response"
                  >
                    <p className="resolved-case-note">
                      Previous response ·{' '}
                      {dispositionLabels[caseItem.response.disposition]}
                    </p>
                    {caseItem.response.actions.length ? (
                      <ol>
                        {caseItem.response.actions.map((action, actionIndex) => (
                          <li key={`${action}-${actionIndex}`}>{action}</li>
                        ))}
                      </ol>
                    ) : null}
                  </section>
                ) : null}
                {caseItem.planBOptions.map((option, planBIndex) => (
                  <section
                    aria-label={`Previous Plan B ${planBIndex + 1} for ${caseItem.title}`}
                    className="resolved-case-response resolved-plan-b-response"
                    key={option.id}
                  >
                    <p className="resolved-case-note">
                      Plan B {planBIndex + 1}
                      {option.response
                        ? ` · ${dispositionLabels[option.response.disposition]}`
                        : ' · Undecided'}
                    </p>
                    <p>{option.action}</p>
                    {option.response?.actions.length ? (
                      <ol>
                        {option.response.actions.map((action, actionIndex) => (
                          <li key={`${action}-${actionIndex}`}>{action}</li>
                        ))}
                      </ol>
                    ) : null}
                  </section>
                ))}
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GapSuggestionRow({
  gap,
  canMoveDown,
  canMoveUp,
  onAdd,
  onIgnore,
  onMove,
}: {
  gap: PlanGapSuggestion;
  canMoveDown: boolean;
  canMoveUp: boolean;
  onAdd: () => void;
  onIgnore: () => void;
  onMove: (direction: 'up' | 'down') => void;
}) {
  return (
    <article className="timeline-row gap-row">
      <div className="plan-lane">
        <span className="mobile-lane-label">Plan</span>
        <section className="gap-card">
          <div className="gap-card-heading">
            <p className="eyebrow">Possible missing step · review to add</p>
            <div
              aria-label={`Reorder suggested step ${gap.title}`}
              className="gap-order-controls"
              role="group"
            >
              <button
                aria-label={`Move suggested step ${gap.title} earlier`}
                disabled={!canMoveUp}
                title="Move up"
                type="button"
                onClick={() => onMove('up')}
              >
                <PlanActionIcon name="move-up" />
              </button>
              <button
                aria-label={`Move suggested step ${gap.title} later`}
                disabled={!canMoveDown}
                title="Move down"
                type="button"
                onClick={() => onMove('down')}
              >
                <PlanActionIcon name="move-down" />
              </button>
            </div>
          </div>
          <p className="time-cue">{gap.timeOrCue || 'Suggested position'}</p>
          <h2>{gap.title}</h2>
          <p>{gap.body}</p>
          <div className="form-actions">
            <button
              aria-label={`Ignore suggested step ${gap.title}`}
              type="button"
              onClick={onIgnore}
            >
              Ignore
            </button>
            <button
              className="primary-action"
              aria-label={`Add suggested step ${gap.title} to Timeline`}
              type="button"
              onClick={onAdd}
            >
              Add to Timeline
            </button>
          </div>
        </section>
      </div>
      <div className="what-if-lane gap-explainer">
        <span className="mobile-lane-label">What if?</span>
        <strong>You decide whether this belongs in the Plan.</strong>
        {LEGACY_AI_UI_ENABLED ? (
          <p>
            This is a suggested gap, not an AI-generated Plan item. Add it only
            after you review it; it becomes a normal Draft.
          </p>
        ) : (
          <p>
            Review the suggestion first. Add it only when it belongs in your
            Plan; it becomes a normal Draft.
          </p>
        )}
      </div>
    </article>
  );
}

type SelectedCountermeasureResponse = {
  id: string;
  kind: 'main' | 'plan-b';
  label: string;
  actions: string[];
  response: CaseResponse;
};

type SelectedCaseResponse = {
  tag: MoshimoTag;
  caseItem: MoshimoCase;
  caseIndex: number;
  countermeasures: SelectedCountermeasureResponse[];
};

type SelectedTagResponseGroup = {
  tag: MoshimoTag;
  cases: Array<Omit<SelectedCaseResponse, 'tag'>>;
};

function TimelineLaneHeadings({
  aiRequestBlocked,
  onFindGaps,
  onReviewPlan,
}: {
  aiRequestBlocked: boolean;
  onFindGaps: () => void;
  onReviewPlan: () => void;
}) {
  return (
    <section className="lane-headings" aria-label="Timeline workspace controls">
      <div>
        <span>Plan</span>
        <small>What you expect to happen</small>
        {LEGACY_AI_UI_ENABLED ? (
          <button
            disabled={aiRequestBlocked}
            type="button"
            onClick={onFindGaps}
          >
            Ask AI to find gaps
          </button>
        ) : null}
      </div>
      <div>
        <span>What if?</span>
        <small>Situations and your response at each moment</small>
        {LEGACY_AI_UI_ENABLED ? (
          <button
            disabled={aiRequestBlocked}
            type="button"
            onClick={onReviewPlan}
          >
            Ask AI to review full Plan
          </button>
        ) : null}
      </div>
    </section>
  );
}

function FinalLaneHeadings() {
  return (
    <section className="lane-headings final-lane-headings" aria-label="Final Timeline lanes">
      <div>
        <span>Plan</span>
      </div>
      <div>
        <span>What if?</span>
      </div>
    </section>
  );
}

function FinalResponseCard({
  tag,
  caseItem,
  caseIndex,
  countermeasures,
}: SelectedCaseResponse) {
  const mainCountermeasure = countermeasures.find(
    (countermeasure) => countermeasure.kind === 'main',
  );
  const planBCountermeasures = countermeasures.filter(
    (countermeasure) => countermeasure.kind === 'plan-b',
  );

  function renderCountermeasure({
    id,
    kind,
    label,
    actions,
    response,
  }: SelectedCountermeasureResponse) {
    return (
      <section
        className={`final-response is-${response.disposition.replace('_', '-')} is-${kind}`}
        key={id}
      >
        <div className="final-countermeasure-heading">
          <span>{label}</span>
          <div className="final-response-decision">
            <InterfaceIcon
              className="final-response-decision-icon"
              name={dispositionIconNames[response.disposition]}
            />
            <strong>{dispositionLabels[response.disposition]}</strong>
          </div>
        </div>
        <div className="final-countermeasure-action">
          <span>Countermeasure</span>
          {actions.map((action, actionIndex) => (
            <p key={`${action}-${actionIndex}`}>{action}</p>
          ))}
        </div>
        {response.disposition === 'covered' ? (
          response.actions[0] ? (
            <div className="final-response-copy">
              <p className="final-response-memo">
                <span>Memo</span>
                {response.actions[0]}
              </p>
            </div>
          ) : null
        ) : response.disposition === 'accept' ? (
          <div className="final-response-copy">
            <p>Risk accepted without using this countermeasure.</p>
            {response.actions[0] ? (
              <p className="final-response-memo">
                <span>Memo</span>
                {response.actions[0]}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="final-preparation-copy">
            <span>Preparation</span>
            <p>{response.actions[0]}</p>
          </div>
        )}
        {response.disposition === 'prepare' ? (
          <small>
            {response.when ? `When: ${response.when} · ` : ''}
            Status: {response.status ?? 'pending'}
          </small>
        ) : null}
        {tag.needsRecheck ? (
          <small className="final-needs-recheck">
            Needs recheck after the Plan changed.
          </small>
        ) : null}
      </section>
    );
  }

  return (
    <section className="final-response-case">
      <header className="final-response-case-heading">
        <span>Situation {caseIndex + 1}</span>
        <h3>{caseItem.title}</h3>
      </header>
      <div
        className={`final-countermeasure-list ${planBCountermeasures.length ? 'has-plan-b' : ''}`}
      >
        {mainCountermeasure ? renderCountermeasure(mainCountermeasure) : null}
        {planBCountermeasures.length ? (
          <div
            className={`final-plan-b-branch ${mainCountermeasure ? '' : 'without-main'}`}
          >
            {planBCountermeasures.map((countermeasure) => (
              <div className="final-plan-b-node" key={countermeasure.id}>
                {renderCountermeasure(countermeasure)}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function FinalTagGroupCard({
  tag,
  cases,
}: SelectedTagResponseGroup) {
  const [expanded, setExpanded] = useState(true);

  return (
    <details
      className="final-tag-group"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="final-tag-question">
        <span>{tag.question}</span>
        <ImpactBadge impact={tag.impact} />
        <span aria-hidden="true" className="disclosure">
          {expanded ? '⌃' : '⌄'}
        </span>
      </summary>
      <div className="final-tag-cases">
        {cases.map(({ caseItem, caseIndex, countermeasures }) => (
          <FinalResponseCard
            caseIndex={caseIndex}
            caseItem={caseItem}
            countermeasures={countermeasures}
            key={caseItem.id}
            tag={tag}
          />
        ))}
      </div>
    </details>
  );
}

function selectedResponseGroupsForItem(
  item: TimelineItem,
): SelectedTagResponseGroup[] {
  const groups: SelectedTagResponseGroup[] = [];
  for (const tag of item.tags) {
    if (tag.lifecycle === 'resolved') continue;
    const cases: SelectedTagResponseGroup['cases'] = [];
    for (const [caseIndex, caseItem] of tag.cases.entries()) {
      const countermeasures: SelectedCountermeasureResponse[] = [];
      if (caseItem.response && caseItem.response.disposition !== 'dismiss') {
        countermeasures.push({
          id: `${caseItem.id}:main`,
          kind: 'main',
          label: 'Action',
          actions: caseItem.suggestedActions,
          response: caseItem.response,
        });
      }
      caseItem.planBOptions.forEach((option, planBIndex) => {
        if (option.response && option.response.disposition !== 'dismiss') {
          countermeasures.push({
            id: option.id,
            kind: 'plan-b',
            label: `Plan_B ${planBIndex + 1}`,
            actions: [option.action],
            response: option.response,
          });
        }
      });
      if (countermeasures.length) {
        cases.push({ caseItem, caseIndex, countermeasures });
      }
    }
    if (cases.length) groups.push({ tag, cases });
  }
  return groups;
}

function FinalTimeline({
  projectId,
  timeline,
}: {
  projectId: string;
  timeline: TimelineItem[];
}) {
  return (
    <section className="timeline final-timeline" aria-label="Final Timeline">
        {timeline.map((item) => {
          const groups = selectedResponseGroupsForItem(item);
          return (
            <article
              className={`timeline-row final-row ${
                groups.length ? 'has-selected-response' : ''
              }`}
              key={`${projectId}:${item.id}`}
            >
              <div className="plan-lane">
                <span className="mobile-lane-label">Plan</span>
                <section className="plan-card">
                  <p className="time-cue">{item.timeOrCue || 'Draft'}</p>
                  <h2>{item.title}</h2>
                  {item.body ? <p>{item.body}</p> : null}
                </section>
              </div>
              <section
                aria-label={`Selected responses for ${item.title}`}
                className={`what-if-lane final-response-cell ${
                  groups.length
                    ? groups.length > 1
                      ? 'has-responses is-branched'
                      : 'has-responses'
                    : ''
                }`}
              >
                {groups.length ? (
                  <span className="mobile-lane-label">What if?</span>
                ) : null}
                {groups.length ? (
                  <div className="final-tag-groups">
                    {groups.map(({ tag, cases }) => (
                      <div className="final-tag-group-branch" key={tag.id}>
                        <span
                          aria-hidden="true"
                          className="final-tag-group-incoming"
                        />
                        <FinalTagGroupCard cases={cases} tag={tag} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="visually-hidden">
                    No selected response for this item.
                  </span>
                )}
              </section>
            </article>
          );
        })}
    </section>
  );
}

function AppHeader({
  localStatus,
  localStatusTone = 'saved',
  webMcpStatus = 'checking',
}: {
  localStatus?: string;
  localStatusTone?: 'saved' | 'warning';
  webMcpStatus?: WebMcpAvailability;
}) {
  const [showWebMcpDetails, setShowWebMcpDetails] = useState(false);
  const webMcpLabel: Record<WebMcpAvailability, string> = {
    checking: 'Checking WebMCP tool availability',
    available: 'WebMCP tools available. View tools and capabilities.',
    unavailable:
      'WebMCP tools unavailable. View tool capabilities and compatibility information.',
    failed:
      'WebMCP tools unavailable. View tool capabilities and compatibility information.',
  };
  const webMcpCaption: Record<WebMcpAvailability, string> = {
    checking: 'CHECKING TOOLS',
    available: 'TOOLS AVAILABLE',
    unavailable: 'TOOLS UNAVAILABLE',
    failed: 'TOOLS UNAVAILABLE',
  };

  useEffect(() => {
    if (!showWebMcpDetails) return;
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setShowWebMcpDetails(false);
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [showWebMcpDetails]);

  return (
    <header className="app-header">
      <a className="brand" href="#top" aria-label="Moshimo Tag home">
        <span className="brand-mark" aria-hidden="true">
          M
        </span>
        Moshimo Tag
      </a>
      <div className="header-statuses">
        {localStatus ? (
          <span
            className={`local-save-status ${
              localStatusTone === 'warning' ? 'is-warning' : ''
            }`}
          >
            {localStatus}
          </span>
        ) : null}
        <div className="webmcp-status-wrap">
          <button
            aria-label={webMcpLabel[webMcpStatus]}
            aria-controls="webmcp-capabilities"
            aria-expanded={showWebMcpDetails}
            aria-haspopup="dialog"
            className={`webmcp-status webmcp-status-${webMcpStatus}`}
            type="button"
            onClick={() => setShowWebMcpDetails((current) => !current)}
          >
            <Image
              alt=""
              aria-hidden="true"
              className="webmcp-badge-image"
              height={300}
              priority
              src="/webmcp-tools-badge.png"
              width={652}
            />
            <span className="webmcp-tools-caption">
              {webMcpCaption[webMcpStatus]}
            </span>
          </button>
          {showWebMcpDetails ? (
            <aside
              aria-labelledby="webmcp-capabilities-title"
              className="webmcp-capabilities"
              id="webmcp-capabilities"
              role="dialog"
              tabIndex={-1}
            >
              <div className="webmcp-capabilities-heading">
                <div>
                  <p className="eyebrow">WebMCP</p>
                  <h2 id="webmcp-capabilities-title">Work with this open page</h2>
                </div>
                <button
                  aria-label="Close WebMCP capabilities"
                  className="webmcp-capabilities-close"
                  type="button"
                  onClick={() => setShowWebMcpDetails(false)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
              <p className="webmcp-capabilities-intro">
                Ask ChatGPT or Codex to draft and update this Project through
                WebMCP.
              </p>
              <ul className="webmcp-capability-list">
                <li>
                  <span className="webmcp-capability-icon is-plan">
                    <InterfaceIcon
                      className="webmcp-capability-icon-image"
                      name="schedule"
                    />
                  </span>
                  <span>
                    <strong>Build the Project</strong>
                    <span>Create and update the Plan in its intended order.</span>
                  </span>
                </li>
                <li>
                  <span className="webmcp-capability-icon is-what-if">
                    <InterfaceIcon
                      className="webmcp-capability-icon-image"
                      name="call-split"
                    />
                  </span>
                  <span>
                    <strong>Prepare the possibilities</strong>
                    <span>
                      Add What ifs, Situations, candidate actions, and Plan B
                      options.
                    </span>
                  </span>
                </li>
                <li>
                  <span className="webmcp-capability-icon is-human">
                    <InterfaceIcon
                      className="webmcp-capability-icon-image"
                      name="verified-user"
                    />
                  </span>
                  <span>
                    <strong>You make every decision</strong>
                    <span>
                      Only you choose Already covered, Accept risk, Prepare,
                      Plan B, or Dismiss.
                    </span>
                  </span>
                </li>
                <li>
                  <span className="webmcp-capability-icon is-final">
                    <InterfaceIcon
                      className="webmcp-capability-icon-image"
                      name="check-circle-outline"
                    />
                  </span>
                  <span>
                    <strong>Review the Final plan</strong>
                    <span>Read the responses you selected, grouped by Situation.</span>
                  </span>
                </li>
              </ul>
            </aside>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  const appState = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const historyAvailability = getHistoryAvailability();
  const [expandedTagIds, setExpandedTagIds] = useState<string[]>([]);
  const [shownResolvedItemIds, setShownResolvedItemIds] = useState<string[]>(
    [],
  );
  const [showAdd, setShowAdd] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [addingTagForItemId, setAddingTagForItemId] = useState<string | null>(
    null,
  );
  const [manualWhatIfItemIds, setManualWhatIfItemIds] = useState<string[]>([]);
  const [projectDialog, setProjectDialog] =
    useState<ProjectDialogMode | null>(null);
  const [showDeleteProject, setShowDeleteProject] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [newProjectMode, setNewProjectMode] =
    useState<NewProjectMode>(LEGACY_AI_UI_ENABLED ? 'ai' : 'manual');
  const [planningBrief, setPlanningBrief] = useState('');
  const [persistence, setPersistence] = useState<PersistenceResult | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);
  const [webMcpStatus, setWebMcpStatus] =
    useState<WebMcpAvailability>('checking');
  const [webMcpActivity, setWebMcpActivity] =
    useState<{ phase: ReviewActivityState; requestKey: string | null }>({
      phase: 'waiting',
      requestKey: null,
    });
  const [, refreshAfterWebMcpMutation] = useState(0);
  const projectIdRef = useRef(appState.project.id);
  const showAddAfterProjectSwitchRef = useRef(false);

  function resetProjectScopedUi(showTimelineComposer = false) {
    setShowAdd(showTimelineComposer);
    setEditingItemId(null);
    setAddingTagForItemId(null);
    setManualWhatIfItemIds([]);
    setExpandedTagIds([]);
    setShownResolvedItemIds([]);
    setShowDeleteProject(false);
  }

  useEffect(() => {
    if (projectIdRef.current === appState.project.id) return;
    projectIdRef.current = appState.project.id;
    setProjectDialog(null);
    setNewProjectTitle('');
    setNewProjectMode(LEGACY_AI_UI_ENABLED ? 'ai' : 'manual');
    setPlanningBrief('');
    setShowAdd(showAddAfterProjectSwitchRef.current);
    setEditingItemId(null);
    setAddingTagForItemId(null);
    setManualWhatIfItemIds([]);
    setExpandedTagIds([]);
    setShownResolvedItemIds([]);
    setShowDeleteProject(false);
    showAddAfterProjectSwitchRef.current = false;
  }, [appState.project.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPersistence(initializePersistence(() => window.localStorage));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const persistenceReady = persistence?.kind === 'ready';

  const aiRequestBlocked = LEGACY_AI_UI_ENABLED && Boolean(
    appState.project.activeReviewRequest ||
      appState.project.activeRecheckRequest,
  );
  function handleWebMcpActivity(activity: unknown) {
    setWebMcpActivity({
      phase: normalizeReviewActivity(activity),
      requestKey: activeRequestKey(getSnapshot().project),
    });
  }

  useEffect(() => {
    if (!persistenceReady) return;

    const modelContext = (
      document as Document & { modelContext?: ModelContextPort }
    ).modelContext;
    if (LEGACY_AI_UI_ENABLED) {
      return registerReviewTools(
        { modelContext },
        { dispatch, getSnapshot },
        setWebMcpStatus,
        handleWebMcpActivity,
      );
    }
    return registerSiteTools(
      { modelContext },
      {
        dispatch,
        getSnapshot,
        onMutationCommitted: () => {
          // Explicitly bridge the WebMCP host callback into React after the
          // shared command has persisted and published state.
          refreshAfterWebMcpMutation((revision) => revision + 1);
        },
      },
      setWebMcpStatus,
    );
  }, [persistenceReady]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(
      () => setFeedback(null),
      feedback.kind === 'error' ? 8000 : 4500,
    );
    return () => window.clearTimeout(timer);
  }, [feedback]);

  function report(result: CommandResult, successMessage: string): boolean {
    if (!result.ok) {
      if (result.code === 'SAVE_FAILED') setSaveFailed(true);
      setFeedback({
        kind: 'error',
        message:
          result.code === 'SAVE_FAILED'
            ? persistence?.kind === 'ready' && persistence.source === 'stored'
              ? "Couldn't save this change. Your previous saved Plan is still intact."
              : "Couldn't save this change. The current Plan is unchanged."
            : result.message,
      });
      return false;
    }
    setSaveFailed(false);
    setPersistence({ kind: 'ready', source: 'stored' });
    setFeedback({ kind: 'success', message: successMessage });
    return true;
  }

  function retryLocalPlan() {
    const result = initializePersistence(() => window.localStorage);
    setSaveFailed(false);
    setPersistence(result);
  }

  function resetLocalPlan() {
    const result = resetPersistence(() => window.localStorage);
    setSaveFailed(false);
    setPersistence(result);
    if (result.kind === 'ready') {
      setFeedback({
        kind: 'success',
        message: 'Local Plan reset. You can start a new Project.',
      });
    }
  }

  function closeProjectDialog() {
    setProjectDialog(null);
    setNewProjectTitle('');
    setNewProjectMode(LEGACY_AI_UI_ENABLED ? 'ai' : 'manual');
    setPlanningBrief('');
  }

  function openNewProjectDialog() {
    if (aiRequestBlocked) return;
    setNewProjectTitle('');
    setNewProjectMode(LEGACY_AI_UI_ENABLED ? 'ai' : 'manual');
    setPlanningBrief('');
    setProjectDialog('new');
  }

  function openProjectDialog() {
    if (aiRequestBlocked) return;
    setNewProjectMode(LEGACY_AI_UI_ENABLED ? 'ai' : 'manual');
    setPlanningBrief('');
    setProjectDialog('open');
  }

  function deleteCurrentProject() {
    const title = appState.project.title;
    const result = dispatch({
      type: 'project.delete',
      payload: { projectId: appState.project.id },
    });
    if (report(result, `${title} deleted from this browser.`)) {
      setShowDeleteProject(false);
      if (isEmptyWorkspaceProject(getSnapshot().project)) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}#top`,
        );
        window.requestAnimationFrame(() => {
          document.getElementById('top')?.scrollIntoView({ block: 'start' });
        });
      }
    }
  }

  function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (aiRequestBlocked) return;
    const requestReview = newProjectMode === 'ai';
    const title = newProjectTitle.trim();
    const description = requestReview ? planningBrief.trim() : '';
    showAddAfterProjectSwitchRef.current = !requestReview;
    const result = dispatch({
      type: 'project.create',
      payload: { title, description, requestReview },
    });
    if (
      !report(
        result,
        requestReview
          ? `Project created. Review requested for New project · ${title}. Waiting for an AI agent.`
          : 'Project created. Add your first Plan item below.',
      )
    ) {
      showAddAfterProjectSwitchRef.current = false;
      return;
    }
    closeProjectDialog();
    resetProjectScopedUi(!requestReview);
  }

  function openProject(projectId: string) {
    if (aiRequestBlocked) return;
    showAddAfterProjectSwitchRef.current = false;
    const result = dispatch({
      type: 'project.open',
      payload: { projectId },
    });
    if (!report(result, 'Project opened.')) return;
    closeProjectDialog();
    resetProjectScopedUi();
  }

  function addPlanItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const requestReview = submittedForReview(event);
    const result = dispatch({
      type: 'timeline.add',
      payload: {
        timeOrCue: String(formData.get('timeOrCue') ?? ''),
        title: String(formData.get('title') ?? ''),
        body: String(formData.get('body') ?? ''),
        requestReview,
      },
    });

    if (
      !report(
        result,
        requestReview
          ? `Plan item added. Review requested for Item · ${String(
              formData.get('title') ?? '',
            ).trim()}. Waiting for an AI agent.`
          : 'Plan item added. The next Add control is ready below it.',
      )
    )
      return;

    form.reset();
    setShowAdd(false);
  }

  function updatePlanItem(
    event: FormEvent<HTMLFormElement>,
    itemId: string,
  ) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const result = dispatch({
      type: 'timeline.update',
      payload: {
        itemId,
        timeOrCue: String(formData.get('timeOrCue') ?? ''),
        title: String(formData.get('title') ?? ''),
        body: String(formData.get('body') ?? ''),
      },
    });
    if (report(result, 'Plan item updated. Attached What ifs now need recheck.')) {
      setEditingItemId(null);
    }
  }

  function movePlanItem(itemId: string, direction: 'up' | 'down') {
    const result = dispatch({
      type: 'timeline.move',
      payload: { itemId, direction },
    });
    report(
      result,
      `Plan item moved ${direction === 'up' ? 'earlier' : 'later'}.`,
    );
  }

  function undoChange() {
    report(dispatch({ type: 'history.undo' }), 'Last change undone.');
  }

  function redoChange() {
    report(dispatch({ type: 'history.redo' }), 'Last undone change restored.');
  }

  function moveGapSuggestion(
    suggestionId: string,
    direction: 'up' | 'down',
  ) {
    const result = dispatch({
      type: 'gap.move',
      payload: { suggestionId, direction },
    });
    report(
      result,
      `Suggested step moved ${direction === 'up' ? 'earlier' : 'later'}.`,
    );
  }

  function moveWhatIf(tagId: string, direction: 'up' | 'down') {
    const result = dispatch({
      type: 'tag.move',
      payload: { tagId, direction },
    });
    report(
      result,
      `What if moved ${direction === 'up' ? 'up' : 'down'}.`,
    );
  }

  function setWhatIfImpact(tag: MoshimoTag, level: ManualImpactLevel) {
    const result = dispatch({
      type: 'tag.impact.set',
      payload: {
        tagId: tag.id,
        impact:
          level === 'unset'
            ? null
            : {
                rank: manualImpactRank(level),
                expectedLossAmount: tag.impact?.expectedLossAmount ?? null,
                currency: tag.impact?.currency ?? null,
                penalty: tag.impact?.penalty ?? '',
              },
      },
    });
    report(
      result,
      level === 'unset'
        ? 'What if impact cleared.'
        : `What if impact set to ${impactLabels[manualImpactRank(level)]}.`,
    );
  }

  function sortWhatIfsByImpact(itemId: string) {
    const result = dispatch({
      type: 'tags.sortByImpact',
      payload: { itemId },
    });
    report(
      result,
      result.ok && result.code === 'NO_CHANGES'
        ? 'What ifs already follow impact order.'
        : 'What ifs sorted from highest to lowest impact.',
    );
  }

  function deletePlanItem(item: TimelineItem) {
    const result = dispatch({
      type: 'timeline.delete',
      payload: { itemId: item.id },
    });
    if (report(result, `${item.title} deleted. Undo is available.`)) {
      setEditingItemId((current) => (current === item.id ? null : current));
    }
  }

  function addWhatIf(event: FormEvent<HTMLFormElement>, itemId: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const result = dispatch({
      type: 'tag.add',
      payload: {
        anchorItemId: itemId,
        question: String(formData.get('question') ?? ''),
        caseTitle: String(formData.get('caseTitle') ?? ''),
        ownAction: String(formData.get('ownAction') ?? ''),
        requestReview: false,
      },
    });
    if (
      report(result, 'Your What if was added.')
    ) {
      const newTagId = result.ok ? result.affectedIds[0] : '';
      form.reset();
      setAddingTagForItemId(null);
      if (newTagId) {
        setExpandedTagIds((current) =>
          current.includes(newTagId) ? current : [...current, newTagId],
        );
      }
    }
  }

  function toggleTag(tagId: string) {
    setExpandedTagIds((current) =>
      current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId],
    );
  }

  function toggleResolvedTags(itemId: string) {
    setShownResolvedItemIds((current) =>
      current.includes(itemId)
        ? current.filter((id) => id !== itemId)
        : [...current, itemId],
    );
  }

  function requestReview(kind: ReviewKind, ownerId: string) {
    if (aiRequestBlocked) return;
    const result = dispatch({
      type: 'review.request',
      payload: { kind, ownerId },
    });
    report(
      result,
      `Review requested for ${reviewScopeLabel(
        appState.project,
        kind,
        ownerId,
      )}. Waiting for an AI agent.`,
    );
  }

  function requestRecheck(tagId: string) {
    if (aiRequestBlocked) return;
    const result = dispatch({
      type: 'recheck.request',
      payload: { tagIds: [tagId] },
    });
    report(
      result,
      `Recheck requested for ${recheckScopeLabel(appState.project, [tagId])}. Waiting for an AI agent.`,
    );
  }

  function clearReviewRequest() {
    const reviewRequest = appState.project.activeReviewRequest;
    if (reviewRequest) {
      const result = dispatch({
        type: 'review.clear',
        payload: { requestId: reviewRequest.id },
      });
      report(result, 'Review request cancelled.');
      return;
    }
    const recheckRequest = appState.project.activeRecheckRequest;
    if (recheckRequest) {
      const result = dispatch({
        type: 'recheck.clear',
        payload: { requestId: recheckRequest.id },
      });
      report(result, 'Recheck request cancelled.');
    }
  }

  function setPlanView(viewMode: 'editing' | 'final') {
    const result = dispatch({
      type: 'project.view.set',
      payload: { viewMode },
    });
    report(
      result,
      viewMode === 'final'
        ? 'Final view now shows your selected responses only.'
        : 'Editing restored. All suggestions and responses are available.',
    );
  }

  function resolveGap(gap: PlanGapSuggestion, action: 'add' | 'ignore') {
    const result = dispatch({
      type: action === 'add' ? 'gap.add' : 'gap.ignore',
      payload: { suggestionId: gap.id },
    });
    report(
      result,
      action === 'add'
        ? `${gap.title} added to the Timeline.`
        : `${gap.title} ignored.`,
    );
  }

  if (!persistence) {
    return (
      <main className="workspace">
        <AppHeader webMcpStatus={webMcpStatus} />
        <section className="persistence-panel" aria-live="polite">
          <p className="eyebrow">Local Plan</p>
          <h1>Opening your local Plan…</h1>
          <p>Saved data is checked before the workspace is shown.</p>
        </section>
      </main>
    );
  }

  if (persistence.kind === 'recovery') {
    return (
      <main className="workspace">
        <AppHeader
          localStatus="Local save needs attention"
          localStatusTone="warning"
          webMcpStatus={webMcpStatus}
        />
        <section className="persistence-panel" aria-live="polite">
          <p className="eyebrow">Recovery</p>
          <h1>We couldn&apos;t open your saved Plan.</h1>
          <p>{persistence.message}</p>
          <p>
            Nothing was silently replaced. Retry, or remove only Moshimo
            Tag&apos;s local data and return to the start screen.
          </p>
          <div className="form-actions">
            <button type="button" onClick={retryLocalPlan}>
              Try again
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={resetLocalPlan}
            >
              Reset local Plan
            </button>
          </div>
        </section>
      </main>
    );
  }

  const isEmptyWorkspace = isEmptyWorkspaceProject(appState.project);
  const localStatus = saveFailed
    ? 'Save failed · changes not saved'
    : isEmptyWorkspace
      ? 'No project yet'
      : persistence.source === 'stored'
      ? 'Saved locally'
      : persistence.source === 'reset'
        ? 'Ready · saves on first change'
        : 'Ready · saves on first change';

  if (isEmptyWorkspace) {
    return (
      <main className="workspace empty-workspace-shell">
        <AppHeader
          localStatus={localStatus}
          localStatusTone={saveFailed ? 'warning' : 'saved'}
          webMcpStatus={webMcpStatus}
        />
        <EmptyWorkspace
          canOpenProject={appState.projects.length > 0}
          onCreateProject={openNewProjectDialog}
          onOpenProject={openProjectDialog}
        />
        {projectDialog ? (
          <ProjectDialog
            currentProjectId={appState.project.id}
            mode={projectDialog}
            newTitle={newProjectTitle}
            newMode={newProjectMode}
            planningBrief={planningBrief}
            onClose={closeProjectDialog}
            onCreate={createProject}
            onNewModeChange={setNewProjectMode}
            onNewTitleChange={setNewProjectTitle}
            onPlanningBriefChange={setPlanningBrief}
            onOpen={openProject}
            projects={appState.projects}
            reviewBlocked={aiRequestBlocked}
          />
        ) : null}
        {feedback ? (
          <p
            className="live-region"
            data-kind={feedback.kind}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {feedback.message}
          </p>
        ) : null}
      </main>
    );
  }

  const activeReviewRequest = appState.project.activeReviewRequest;
  const activeRecheckRequest = appState.project.activeRecheckRequest;
  const activeReviewTarget = activeReviewRequest
    ? reviewScopeLabel(
        appState.project,
        activeReviewRequest.kind,
        activeReviewRequest.ownerId,
      )
    : activeRecheckRequest
      ? recheckScopeLabel(
          appState.project,
          activeRecheckRequest.tags.map((tag) => tag.tagId),
        )
      : '';
  const currentRequestKey = activeRequestKey(appState.project);
  const activeReviewStatus =
    currentRequestKey !== webMcpActivity.requestKey
      ? 'Waiting for an AI agent'
      : webMcpActivity.phase === 'reviewing'
      ? 'AI is reviewing…'
      : webMcpActivity.phase === 'saving'
        ? 'Saving AI suggestions…'
        : 'Waiting for an AI agent';

  return (
    <main className="workspace">
      <AppHeader
        localStatus={localStatus}
        localStatusTone={saveFailed ? 'warning' : 'saved'}
        webMcpStatus={webMcpStatus}
      />

      <section className="project-header" id="top">
        <div>
          <h1>{appState.project.title}</h1>
        </div>
        <div className="project-header-actions" aria-label="Project actions">
          <div className="history-actions" aria-label="Edit history" role="group">
            <button
              aria-label="Undo last change"
              disabled={!historyAvailability.canUndo || aiRequestBlocked}
              title="Undo"
              type="button"
              onClick={undoChange}
            >
              <InterfaceIcon className="history-action-icon" name="undo" />
            </button>
            <button
              aria-label="Redo last undone change"
              disabled={!historyAvailability.canRedo || aiRequestBlocked}
              title="Redo"
              type="button"
              onClick={redoChange}
            >
              <InterfaceIcon className="history-action-icon" name="redo" />
            </button>
          </div>
          <button
            disabled={aiRequestBlocked}
            type="button"
            onClick={openNewProjectDialog}
          >
            New project
          </button>
          <button
            disabled={aiRequestBlocked}
            type="button"
            onClick={openProjectDialog}
          >
            Open project
          </button>
          <button
            className={`project-mode-action ${
              appState.project.viewMode === 'editing' ? 'primary-action' : ''
            }`}
            type="button"
            onClick={() =>
              setPlanView(
                appState.project.viewMode === 'editing' ? 'final' : 'editing',
              )
            }
          >
            {appState.project.viewMode === 'editing'
              ? 'View final plan'
              : 'Edit plan'}
          </button>
        </div>
      </section>

      {projectDialog ? (
        <ProjectDialog
          currentProjectId={appState.project.id}
          mode={projectDialog}
          newTitle={newProjectTitle}
          newMode={newProjectMode}
          planningBrief={planningBrief}
          onClose={closeProjectDialog}
          onCreate={createProject}
          onNewModeChange={setNewProjectMode}
          onNewTitleChange={setNewProjectTitle}
          onPlanningBriefChange={setPlanningBrief}
          onOpen={openProject}
          projects={appState.projects}
          reviewBlocked={aiRequestBlocked}
        />
      ) : null}

      <section className="mobile-action-dock" aria-label="Plan actions">
        {appState.project.viewMode === 'editing' ? (
          <>
            {LEGACY_AI_UI_ENABLED ? (
              <button
                disabled={aiRequestBlocked}
                type="button"
                onClick={() => requestReview('timeline_gaps', appState.project.id)}
              >
                <AiIcon />
                Find gaps
              </button>
            ) : null}
            {LEGACY_AI_UI_ENABLED ? (
              <button
                disabled={aiRequestBlocked}
                type="button"
                onClick={() =>
                  requestReview('timeline_whatifs', appState.project.id)
                }
              >
                <AiIcon />
                Review plan
              </button>
            ) : null}
          </>
        ) : null}
        <button
          className="primary-action"
          type="button"
          onClick={() =>
            setPlanView(
              appState.project.viewMode === 'editing' ? 'final' : 'editing',
            )
          }
        >
          {appState.project.viewMode === 'editing'
            ? 'View final plan'
            : 'Edit plan'}
        </button>
      </section>

      <div hidden={appState.project.viewMode !== 'final'}>
        <FinalLaneHeadings />
        <FinalTimeline
          projectId={appState.project.id}
          timeline={appState.project.timeline}
        />
      </div>

      <div hidden={appState.project.viewMode !== 'editing'}>
        <>
      <TimelineLaneHeadings
        aiRequestBlocked={aiRequestBlocked}
        onFindGaps={() => requestReview('timeline_gaps', appState.project.id)}
        onReviewPlan={() =>
          requestReview('timeline_whatifs', appState.project.id)
        }
      />

      <section className="timeline" aria-label="Project Timeline">
        {appState.project.timeline.map((item) => {
          const activeTags = item.tags.filter(
            (tag) => tag.lifecycle === 'active',
          );
          const resolvedTags = item.tags.filter(
            (tag) => tag.lifecycle === 'resolved',
          );
          const showingResolved = shownResolvedItemIds.includes(item.id);

          return (
            <Fragment key={`${appState.project.id}:${item.id}`}>
          <article className="timeline-row">
            <div className="plan-lane">
              <span className="mobile-lane-label">Plan</span>
              {editingItemId === item.id ? (
                <form
                  className="edit-panel"
                  onSubmit={(event) => updatePlanItem(event, item.id)}
                >
                  <p className="eyebrow">Edit Plan item</p>
                  <div className="field-grid">
                    <label>
                      When / order cue <span>(optional)</span>
                      <input
                        defaultValue={item.timeOrCue}
                        maxLength={40}
                        name="timeOrCue"
                      />
                    </label>
                    <label>
                      Title
                      <input
                        defaultValue={item.title}
                        maxLength={120}
                        name="title"
                        required
                      />
                    </label>
                  </div>
                  <label>
                    Plan or draft text
                    <textarea
                      defaultValue={item.body}
                      maxLength={1200}
                      name="body"
                      rows={4}
                    />
                  </label>
                  <div className="form-actions">
                    <button type="button" onClick={() => setEditingItemId(null)}>
                      Cancel
                    </button>
                    <button
                      className="primary-action"
                      type="submit"
                    >
                      Save changes
                    </button>
                  </div>
                </form>
              ) : (
                <section className="plan-card">
                  <div className="plan-card-heading">
                    <div>
                      <p className="time-cue">{item.timeOrCue || 'Draft'}</p>
                      <h2>{item.title}</h2>
                    </div>
                    <div
                      className="plan-card-actions"
                      aria-label={`Edit and reorder ${item.title}`}
                    >
                      <button
                        aria-label={`Edit ${item.title}`}
                        title="Edit"
                        type="button"
                        onClick={() => setEditingItemId(item.id)}
                      >
                        <PlanActionIcon name="edit" />
                      </button>
                      <button
                        aria-label={`Move ${item.title} earlier`}
                        disabled={
                          !canMoveEditingEntry(
                            appState.project,
                            { kind: 'item', id: item.id },
                            'up',
                          )
                        }
                        title="Move up"
                        type="button"
                        onClick={() => movePlanItem(item.id, 'up')}
                      >
                        <PlanActionIcon name="move-up" />
                      </button>
                      <button
                        aria-label={`Move ${item.title} later`}
                        disabled={
                          !canMoveEditingEntry(
                            appState.project,
                            { kind: 'item', id: item.id },
                            'down',
                          )
                        }
                        title="Move down"
                        type="button"
                        onClick={() => movePlanItem(item.id, 'down')}
                      >
                        <PlanActionIcon name="move-down" />
                      </button>
                      <button
                        aria-label={`Delete ${item.title}`}
                        title="Delete"
                        type="button"
                        onClick={() => deletePlanItem(item)}
                      >
                        <PlanActionIcon name="delete" />
                      </button>
                    </div>
                  </div>
                  {item.body ? <p>{item.body}</p> : null}
                  {item.status === 'draft' ? (
                    <span className="draft-state">Saved · not reviewed</span>
                  ) : null}
                  <div
                    className="item-actions"
                    aria-label={`Actions for ${item.title}`}
                  >
                    <div className="item-actions-ai">
                      {LEGACY_AI_UI_ENABLED ? (
                        <div
                          className="what-if-control"
                          role="group"
                          aria-label={`Add a What if for ${item.title}`}
                        >
                          <button
                            className="what-if-trigger"
                            aria-label={
                              manualWhatIfItemIds.includes(item.id)
                                ? `Add a What if manually for ${item.title}`
                                : `Ask AI for What ifs for ${item.title}`
                            }
                            disabled={
                              !manualWhatIfItemIds.includes(item.id) &&
                              aiRequestBlocked
                            }
                            type="button"
                            onClick={() => {
                              if (manualWhatIfItemIds.includes(item.id)) {
                                setAddingTagForItemId(item.id);
                                return;
                              }
                              requestReview('item_whatifs', item.id);
                            }}
                          >
                            + What if
                          </button>
                          <label className="with-ai-option">
                            <input
                              checked={!manualWhatIfItemIds.includes(item.id)}
                              type="checkbox"
                              onChange={(event) => {
                                const useAi = event.currentTarget.checked;
                                setManualWhatIfItemIds((current) =>
                                  useAi
                                    ? current.filter((id) => id !== item.id)
                                    : current.includes(item.id)
                                      ? current
                                      : [...current, item.id],
                                );
                                if (useAi) {
                                  setAddingTagForItemId((current) =>
                                    current === item.id ? null : current,
                                  );
                                }
                              }}
                            />
                            With AI
                          </label>
                        </div>
                      ) : (
                        <button
                          className="manual-what-if-trigger"
                          aria-label={`Add a What if for ${item.title}`}
                          type="button"
                          onClick={() => setAddingTagForItemId(item.id)}
                        >
                          + What if
                        </button>
                      )}
                    </div>
                  </div>
                </section>
              )}
            </div>

            <div
              className={`what-if-lane item-what-if-lane ${
                item.tags.length ? 'has-what-ifs' : ''
              }`}
            >
              <span className="mobile-lane-label">What if?</span>
              {addingTagForItemId === item.id ? (
                <form
                  className="tag-composer"
                  onSubmit={(event) => addWhatIf(event, item.id)}
                >
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">Your What if</p>
                      <h2>Add a What if</h2>
                    </div>
                    <span className="human-label">Added by you</span>
                  </div>
                  <label>
                    What might happen?
                    <input
                      maxLength={180}
                      name="question"
                      placeholder="What if…?"
                      required
                    />
                  </label>
                  <label>
                    First Situation
                    <input
                      maxLength={120}
                      name="caseTitle"
                      placeholder="Describe one possible situation"
                      required
                    />
                  </label>
                  <label>
                    Your starting action <span>(optional)</span>
                    <textarea
                      maxLength={1200}
                      name="ownAction"
                      placeholder="What might you do in this situation?"
                      rows={3}
                    />
                  </label>
                  <div className="form-actions">
                    <button
                      type="button"
                      onClick={() => setAddingTagForItemId(null)}
                    >
                      Cancel
                    </button>
                    <button className="primary-action" type="submit">
                      Add What if
                    </button>
                  </div>
                </form>
              ) : null}
              {activeTags.length ? (
                <div className="tag-group">
                  <div className="tag-group-heading">
                    <p className="tag-count">
                      {activeTags.length} active What if
                      {activeTags.length === 1 ? '' : 's'} attached to this item
                    </p>
                    {activeTags.length > 1 ? (
                      <button
                        aria-label="Sort What ifs by impact"
                        className="sort-what-ifs"
                        disabled={
                          aiRequestBlocked ||
                          !activeTags.some((tag) => tag.impact !== null)
                        }
                        title={
                          activeTags.some((tag) => tag.impact !== null)
                            ? 'Sort highest impact first'
                            : 'Set an Impact level first'
                        }
                        type="button"
                        onClick={() => sortWhatIfsByImpact(item.id)}
                      >
                        <InterfaceIcon
                          className="sort-impact-icon"
                          name="sort"
                        />
                        <span>Sort by impact</span>
                      </button>
                    ) : null}
                  </div>
                  {activeTags.map((tag, tagIndex) => (
                    <div className="tag-card-branch" key={tag.id}>
                      <span
                        aria-hidden="true"
                        className="tag-card-incoming"
                      />
                      <TagCard
                        canMoveDown={tagIndex < activeTags.length - 1}
                        canMoveUp={tagIndex > 0}
                        expanded={expandedTagIds.includes(tag.id)}
                        onFeedback={report}
                        onImpactChange={setWhatIfImpact}
                        onMove={moveWhatIf}
                        onRequestRecheck={requestRecheck}
                        onRequestReview={requestReview}
                        onToggle={() => toggleTag(tag.id)}
                        aiRequestBlocked={aiRequestBlocked}
                        showOrderControls={activeTags.length > 1}
                        tag={tag}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              {resolvedTags.length ? (
                <div className="resolved-tags-section">
                  <button
                    aria-expanded={showingResolved}
                    className="resolved-toggle"
                    type="button"
                    onClick={() => toggleResolvedTags(item.id)}
                  >
                    {showingResolved
                      ? 'Hide resolved'
                      : `Show ${resolvedTags.length} resolved`}
                  </button>
                  {showingResolved ? (
                    <div className="resolved-tag-group">
                      {resolvedTags.map((tag) => (
                        <ResolvedTagCard
                          expanded={expandedTagIds.includes(tag.id)}
                          key={tag.id}
                          onToggle={() => toggleTag(tag.id)}
                          tag={tag}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {!activeTags.length && !resolvedTags.length ? (
                <p className="empty-what-if">No What ifs attached yet.</p>
              ) : null}
            </div>
          </article>
          {appState.project.gapSuggestions
            .filter(
              (gap) =>
                gap.status === 'proposed' &&
                gap.insertAfterItemId === item.id,
            )
            .map((gap) => (
              <GapSuggestionRow
                canMoveDown={canMoveEditingEntry(
                  appState.project,
                  { kind: 'gap', id: gap.id },
                  'down',
                )}
                canMoveUp={canMoveEditingEntry(
                  appState.project,
                  { kind: 'gap', id: gap.id },
                  'up',
                )}
                gap={gap}
                key={gap.id}
                onAdd={() => resolveGap(gap, 'add')}
                onIgnore={() => resolveGap(gap, 'ignore')}
                onMove={(direction) => moveGapSuggestion(gap.id, direction)}
              />
            ))}
          </Fragment>
        );
        })}

        {appState.project.gapSuggestions
          .filter(
            (gap) => gap.status === 'proposed' && gap.insertAfterItemId === null,
          )
          .map((gap) => (
            <GapSuggestionRow
              canMoveDown={canMoveEditingEntry(
                appState.project,
                { kind: 'gap', id: gap.id },
                'down',
              )}
              canMoveUp={canMoveEditingEntry(
                appState.project,
                { kind: 'gap', id: gap.id },
                'up',
              )}
              gap={gap}
              key={gap.id}
              onAdd={() => resolveGap(gap, 'add')}
              onIgnore={() => resolveGap(gap, 'ignore')}
              onMove={(direction) => moveGapSuggestion(gap.id, direction)}
            />
          ))}

        <article className="timeline-row add-row">
          <div className="plan-lane">
            <span className="mobile-lane-label">Plan</span>
            {showAdd ? (
              <form className="add-panel" onSubmit={addPlanItem}>
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">You write first</p>
                    <h2>Add a plan item</h2>
                  </div>
                  <span className="human-label">User-authored</span>
                </div>
                <p>Write the schedule item, step, cue, or draft passage first.</p>
                <div className="field-grid">
                  <label>
                    When / order cue <span>(optional)</span>
                    <input
                      maxLength={40}
                      name="timeOrCue"
                      placeholder="e.g. 18:30 or Opening"
                    />
                  </label>
                  <label>
                    Title
                    <input
                      maxLength={120}
                      name="title"
                      placeholder="What will happen?"
                      required
                    />
                  </label>
                </div>
                <label>
                  Plan or draft text
                  <textarea
                    maxLength={1200}
                    name="body"
                    placeholder="Write what you expect to do, say, or present."
                    rows={4}
                  />
                </label>
                <div className="form-actions">
                  <button type="button" onClick={() => setShowAdd(false)}>
                    Cancel
                  </button>
                  <button
                    className="primary-action"
                    type="submit"
                    value="add"
                  >
                    Add only
                  </button>
                  {LEGACY_AI_UI_ENABLED ? (
                    <button
                      disabled={aiRequestBlocked}
                      type="submit"
                      value="review"
                    >
                      Add &amp; ask AI
                    </button>
                  ) : null}
                </div>
              </form>
            ) : (
              <button
                className="add-plan-button"
                type="button"
                onClick={() => setShowAdd(true)}
              >
                + Add plan item
              </button>
            )}
          </div>
        </article>
      </section>
        </>
      </div>

      <footer className="project-footer">
        <button
          aria-label={`Delete project ${appState.project.title}`}
          className="delete-project-trigger"
          disabled={aiRequestBlocked}
          title="Delete project"
          type="button"
          onClick={() => setShowDeleteProject(true)}
        >
          <PlanActionIcon name="delete" />
          <span className="visually-hidden">Delete project</span>
        </button>
      </footer>

      {showDeleteProject ? (
        <ProjectDeleteDialog
          project={appState.project}
          onClose={() => setShowDeleteProject(false)}
          onConfirm={deleteCurrentProject}
        />
      ) : null}

      {LEGACY_AI_UI_ENABLED && aiRequestBlocked ? (
        <section
          aria-busy="true"
          aria-label={`${activeReviewStatus} · ${activeReviewTarget}`}
          className="review-request-snackbar"
          role="status"
        >
          <div className="review-request-snackbar-state">
            <span className="review-spinner" aria-hidden="true" />
            <div>
              <strong>{activeReviewStatus}</strong>
              <span>{activeReviewTarget}</span>
            </div>
          </div>
          <button type="button" onClick={clearReviewRequest}>
            Cancel request
          </button>
        </section>
      ) : null}

      {feedback ? (
        <p
          className={`live-region ${
            LEGACY_AI_UI_ENABLED && aiRequestBlocked
              ? 'has-review-snackbar'
              : ''
          }`}
          data-kind={feedback.kind}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {feedback.message}
        </p>
      ) : null}
    </main>
  );
}
