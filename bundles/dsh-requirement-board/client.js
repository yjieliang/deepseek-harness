/**
 * Requirement Board — the browser half.
 *
 * A plain-JavaScript Client module (no JSX, no imports beyond the platform
 * React) registering two things: the sidebar entry and the main-column page it
 * opens. The page renders the Host's shared board and drives it through
 * `/api/requirement-board`.
 *
 * Live data arrives on one channel: a Server-Sent Events stream from
 * `/api/requirement-board/events`. A committed change in *any* session pushes
 * one event, the page refetches the snapshot, and every open page re-renders —
 * that is the cross-session synchronisation a user sees.
 */
window.__ModuleLoader__.load({
  id: 'dsh-requirement-board',
  factory(require) {
    const React = require('react')
    /**
     * Platform primitives from the shared baseline module table: the visual
     * language every other panel speaks, styled only through `--dsw-*` tokens.
     */
    const { Button, Checkbox, Input, Modal, Pill, StateDot, Tag, Toast } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /**
     * Selector for a reader that wants the whole snapshot. The renderer binds
     * every `hooks` source to `use<Name>(selector, equality?)`, so a component
     * that reads the whole fact still passes a selector: the platform's uSES
     * bridge calls it unconditionally.
     */
    const identity = value => value

    /** Route prefix the Host half registered. */
    const API = '/api/requirement-board'
    /** Sidebar list id and main-panel key; one id addresses both seats. */
    const PANEL_ID = 'requirement-board'
    /** Client locale namespace. */
    const NS = 'requirement-board'
    /** Media types the image route accepts, and the ceilings it enforces. */
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    const IMAGE_MAX_BYTES = 20 * 1024 * 1024
    const IMAGE_MAX_COUNT = 20
    /**
     * Role declaration bounds, mirrored from the Host's own gate
     * (`host/model.js`): they are what the duty editor counts and caps, while the
     * Host stays the authority that accepts or refuses a write.
     */
    const ROLE_NAME_MAX = 40
    const ROLE_DUTIES_MAX = 12
    const ROLE_DUTY_MAX = 40

    /**
     * Structured-question bounds, mirrored from the Host's own gate
     * (`host/model.js`): the editor caps and counts with them, while the Host
     * stays the authority that accepts or refuses a write.
     */
    const OPTION_QUESTIONS_MAX = 6
    const OPTION_CHOICES_MAX = 8
    const OPTION_PROMPT_MAX = 300
    const OPTION_LABEL_MAX = 80
    const OPTION_DETAIL_MAX = 600

    /** The thumbnail and download address of one stored image. */
    const imageURL = id => `${API}/image/${encodeURIComponent(id)}`

    /**
     * One stored image's id, from either its reference or a bare id.
     *
     * The create command names images by id, so a Host that echoes the ids back
     * as strings is read the same way as one that answers with references.
     * @param image - an image reference or a bare id.
     * @returns the id, or `undefined` when the entry names none.
     */
    const imageId = image => (typeof image === 'string' ? image : image?.id)

    /**
     * One fetched page split into one group per project.
     *
     * Groups are ordered by name so two renders of an unchanged board agree, and
     * the requirements belonging to no project come last: they are the ones a
     * reader is most likely to file next, not the board's default reading.
     * @param items - requirements in the order the Host listed them.
     * @param emptyLabel - name of the group holding the requirements with no project.
     * @returns `[{ key, label, items }]`, in group order; empty for an empty page.
     */
    const projectGroups = (items, emptyLabel) => {
      const groups = new Map()
      for (const item of items) {
        const name = item.project ?? ''
        if (!groups.has(name)) groups.set(name, [])
        groups.get(name).push(item)
      }
      return [...groups.entries()]
        .sort(([a], [b]) => (a === '' ? 1 : (b === '' ? -1 : a.localeCompare(b))))
        .map(([name, groupItems]) => ({
          key: name === '' ? PROJECT_UNASSIGNED : name,
          label: name === '' ? emptyLabel : name,
          items: groupItems,
        }))
    }

    /** Every user-visible string the page renders. */
    const DICT = {
      en: {
        panel: 'Requirements',
        title: 'Requirement Board',
        subtitle: 'Shared by every session of this Harness',
        refresh: 'Refresh',
        newRequirement: 'New requirement',
        newTemplate: 'New template',
        loading: 'Loading the board…',
        empty: 'No requirement matches the current filter.',
        emptyBoard: 'No requirement yet. Create one here, or ask the agent to.',
        filterSession: 'Session',
        filterOwner: 'Owner',
        filterStatus: 'Status',
        filterPriority: 'Priority',
        filterQuery: 'Search',
        all: 'All',
        open: 'Open',
        statusActive: 'Active',
        statusBlocked: 'Blocked',
        statusDone: 'Done',
        statusArchived: 'Archived',
        statusPending: 'Not started',
        priorityLow: 'Low',
        priorityNormal: 'Normal',
        priorityHigh: 'High',
        priorityUrgent: 'Urgent',
        owner: 'Owner',
        unassigned: 'Unassigned',
        sessions: 'Sessions',
        template: 'Template',
        flow: 'Flow',
        nodeDetail: 'Node detail',
        selectNode: 'Select a node in the flow to see its detail and history.',
        completionManual: 'The assignee confirms completion',
        completionChecklist: 'All checklist entries must be ticked',
        requireNote: 'A note is required to finish this node',
        checks: 'Checklist',
        entered: 'Entered',
        completed: 'Completed',
        spent: 'Time in node',
        history: 'Transition history',
        noHistory: 'No transition yet.',
        advance: 'Finish and advance',
        rollback: 'Roll back here',
        jump: 'Jump here',
        reopen: 'Reopen',
        block: 'Block',
        unblock: 'Unblock',
        archive: 'Archive',
        restore: 'Restore',
        remove: 'Delete',
        note: 'Note',
        notePlaceholder: 'Why is this transition happening?',
        blockReasonPlaceholder: 'What is blocking this requirement?',
        confirm: 'Confirm',
        cancel: 'Cancel',
        close: 'Close',
        create: 'Create',
        summary: 'Brief',
        summaryHint: 'Say what is wanted and why it matters in one or two plain sentences — leave the implementation detail to the description.',
        summaryEmpty: 'This requirement has no brief: it was written before the field existed.',
        project: 'Project',
        projectHint: 'A short name for the effort this belongs to — the same spelling for every requirement in it, and empty when it belongs to none.',
        projectUnassigned: 'No project',
        groupProject: 'Group by project',
        description: 'Description',
        titleField: 'Title',
        projectProgress: 'Project progress',
        completionRate: 'Completion',
        total: 'Total',
        blockedTitle: 'Blockers',
        stalledTitle: 'Stalled',
        nodeDurations: 'Average time per node',
        noBlocked: 'Nothing is blocked.',
        noStalled: 'Nothing is stalled.',
        samples: 'samples',
        avg: 'avg',
        durationHint: 'Every figure is node residence time — from entering the node to leaving it, including the wait before anyone claimed it.',
        templateName: 'Template name',
        templateDescription: 'Template description',
        templateNodes: 'Nodes',
        templateNodesHint: 'One node per line:  name | assignee | checklist item;checklist item',
        templateNodesExample: 'Requirements review | Ann | scope agreed;stakeholders confirmed\nSolution design | Ben\nImplementation\nVerification\nRelease',
        nodesLabel: 'Nodes',
        deleteConfirm: 'Delete this requirement and its whole history? This cannot be undone.',
        nodeCount: 'nodes',
        updated: 'Updated',
        revision: 'rev',
        dependencies: 'Depends on',
        blockedBecause: 'Blocked because',
        lastTransition: 'Last transition',
        live: 'Live updates connected',
        unknownError: 'The operation failed.',
        errCompletionNotMet: 'The current node is not finished yet.',
        errDependencyNotMet: 'A prerequisite node is not finished yet.',
        errConflict: 'Another session changed this requirement first. Refresh and retry.',
        errTemplateConflict: 'Another session changed this template first. Your draft is kept below.',
        errNotFound: 'That requirement no longer exists.',
        errInvalidTransition: 'That transition is not allowed from the current state.',
        errInUse: 'The template is still used by requirements.',
        errInvalidArgument: 'The input is not valid.',
        errForbidden: 'The request was rejected.',
        errInvalidState: 'The requirement is already in that state.',
        errInvalidRole: 'That role id is not valid.',
        errLockRequired: 'Take the execution lock before changing this requirement.',
        errNotLockHolder: 'Only the session holding this lock can release it.',
        errRoleMismatch: 'This requirement is routed to a different role.',
        errDecisionTask: 'Only the human decides a decision requirement.',
        errLocked: 'Another session holds the execution lock.',
        errReserved: 'Another session has queued this requirement.',
        errSessionBusy: 'That session already executes another requirement.',
        roles: 'Roles',
        newRole: 'New role',
        roleId: 'Role id',
        roleName: 'Display name',
        roleDuties: 'Duties',
        roleDutiesHint: 'Comma-separated, up to 12',
        rolesColumn: 'Roles',
        presetsColumn: 'Preset associations',
        roleSearch: 'Search roles',
        presetSearch: 'Search presets',
        roleGroupRegistered: 'Registered',
        roleGroupEphemeral: 'Temporary',
        rolesNoMatch: 'No role matches this search.',
        presetsNoMatch: 'No preset matches this search.',
        roleDutyAdd: 'Add a duty',
        roleDutyRemove: 'Remove',
        roleDutyCount: '{count}/12',
        roleDutyEmptyHint: 'Empty lines are not written; each duty is at most 40 characters.',
        roleDutyMerged: 'Merged {count} duplicate duties.',
        roleDiscardConfirm: 'This form has unsaved changes.',
        roleDiscardConfirmDrop: 'Discard and close',
        roleDiscardConfirmKeep: 'Keep editing',
        roleFormError: 'This role was not saved.',
        roleRowError: 'This role was not deleted.',
        roleEditTitle: 'Edit · {name} ({id})',
        roleRegisterTitle: 'Register role · {name} ({id})',
        roleNone: 'No role',
        anyRole: 'Any role',
        rolesEmpty: 'No role is recorded yet.',
        rolesUnregistered: 'In use but unrecorded',
        roleEphemeral: 'Temporary',
        roleBoundSession: 'Bound session',
        roleBoundTask: 'Bound task',
        roleDutiesMissing: 'No duties recorded',
        roleUnregistered: 'Unrecorded',
        roleHoldersCount: '{count} present',
        roleRunningCount: '{count} running',
        roleNoHolders: 'no one present',
        roleHoldersUnknown: 'Presence unavailable',
        roleOpen: '{count} open',
        roleSourcePreset: 'from a preset declaration',
        roleSourceManual: 'registered in the panel',
        roleSourceObserved: 'preset id fallback',
        roleSourceDelegated: 'minted by delegation',
        rolePresets: 'Preset modes',
        presetsReading: 'Reading the preset registry…',
        presetsEmpty: 'The preset registry lists no preset.',
        presetsUnavailableAbsent: 'The preset registry is not mounted here, so preset associations are unavailable.',
        presetsUnavailableFailed: 'Reading the preset registry failed, so preset associations are unavailable.',
        presetUnregistered: 'no role record for this preset',
        presetRoleInvalid: 'preset id is not a usable role id',
        presetBroken: 'preset unavailable',
        presetRegister: 'Register role',
        presetSessions: '{count} on this preset',
        presetInferred: 'role inferred from the preset id; no session observed yet',
        edit: 'Edit',
        save: 'Save',
        removeRole: 'Delete role',
        removeRoleConfirm: 'Delete this role? Requirements that still name it become unrecorded.',
        filterRole: 'Role',
        filterKind: 'Kind',
        kindTask: 'Task',
        kindDecision: 'Decision',
        filterClaimable: 'Only claimable',
        filterPanel: 'Filters',
        filterShow: 'Show filters',
        filterHide: 'Hide filters',
        filterSummaryAll: 'All requirements',
        filterRoleAll: 'All roles',
        filterRemove: 'Remove this filter',

        claimableYes: 'Ready to take',
        claimableNo: 'Not takeable',
        claimableHint: 'The hand-off pool: unfinished, unlocked work, regardless of role.',
        lock: 'Execution lock',
        locked: 'Locked',
        unlocked: 'Unlocked',
        lockHolder: 'Holder',
        lockHeldSince: 'Held for',
        lockTouched: 'Lease touched',
        lockOrphaned: 'Orphaned',
        lockExpired: 'Lease expired',
        lockStale: 'No renewal for',
        releaseLock: 'Release lock',
        staleNotice: 'Synchronisation interrupted; this data may be out of date.',
        retry: 'Retry',
        recheck: 'Re-check',
        view: 'View',
        viewBoard: 'Board',
        viewQueue: 'Queues',
        viewDecisions: 'Decisions',
        viewDecisionsHint: 'Only a person can advance a decision requirement. An AI session is refused by rule, not by fault.',
        decisionsEmpty: 'No decision is waiting for a person.',
        decisionBadge: 'Human decision',
        requestedBy: 'Requested by',
        queueTitle: 'Reserved queues',
        queueEmpty: 'No session has reserved a requirement.',
        queueCount: 'Reserved {count}',
        queueSoftHint: 'A reservation is a soft hold: reserved work stays out of the hand-off pool.',
        reservedBadge: 'Reserved',
        clearReservation: 'Clear reservation',
        reservationCleared: 'Reservation cleared.',
        reservationAbsent: 'Nothing was reserved.',
        filterMe: 'Session (me)',
        filterMeHint: 'Answer eligibility for this session',
        roleHuman: 'Human inbox',
        executions: 'Execution units',
        executionsHint: 'Observed execution moves the observation revision, never the requirement revision.',
        executionsEmpty: 'Nothing is executing on this requirement.',
        executionsTruncated: 'Only the most recent units are kept; earlier ones were dropped.',
        executionSyncOff: 'Execution sync is off: only the lock is known, so an empty list is not "nothing running".',
        executionSyncGap: 'Execution sync has a gap: what is shown may be stale.',
        executionSyncReason: 'Reason',
        executionSyncAt: 'Last observed',
        execRevLine: 'Observations are at execRev {exec}; the requirement revision is still {rev}.',
        runningBadge: 'Executing {count}',
        statsRunning: 'Executing',
        statsExecIgnored: 'Unattributed',
        statsExecGaps: 'Observation gaps',
        unitJob: 'Job',
        unitSubagent: 'Subagent',
        unitStarted: 'Started',
        unitFinished: 'Finished',
        unitStale: 'no update since',
        queueNext: 'next',
        queueHint: "The service names each queue's head and order; the panel does not reorder it.",
        authExpired: 'This panel session has expired.',
        authExpiredHint: 'Reopen the panel to sign in again; automatic retries are stopped until then.',
        authCrossOrigin: 'This request was refused as cross-origin.',
        authCrossOriginHint: 'Open the panel from its own address; automatic retries are stopped until then.',
        delegation: 'Hand-off',
        delegatedTo: 'Delegated to',
        delegatedBadge: 'Delegated',
        delegatedRoleBefore: 'Role before hand-off',
        delegatedAt: 'Delegated at',
        delegate: 'Delegate',
        delegateTarget: 'Target session',
        delegateDuties: 'Duties (optional)',
        delegateDutiesHint: 'Comma-separated',
        delegateNeedsSession: 'Name the session this work goes to.',
        delegateDone: 'Handed to {session}.',
        revokeDelegation: 'Revoke hand-off',
        delegationRevoked: 'Hand-off revoked.',
        delegationAbsent: 'There was no hand-off to revoke.',
        notDelegated: 'Not delegated to a session.',
        statsUnfinished: 'Unfinished',
        statsQueued: 'Queued',
        statsReserved: 'Reserved',
        statsPendingDelegations: 'Pending hand-offs',
        statsOrphanedLocks: 'Orphaned locks',
        statsByRole: 'Open by role',
        criticalPath: 'Critical path',
        criticalTag: 'Critical path',
        effectivePriority: 'Effective level',
        ownPriority: 'Stored priority',
        priorityLiftedHint: 'Raised by the work it holds up; nothing is written back to the requirement.',
        gates: 'Gates',
        gatesHint: 'Advancing waits for unfinished work. Archiving a blocker does not finish it.',
        blocksOnTitle: 'Depends on',
        blockedByTitle: 'Blocked by',
        gatedBadge: 'Blocked by {count}',
        blocksBadge: 'Waiting on {count}',
        parentRequirement: 'Parent',
        childrenTitle: 'Sub-requirements',
        noneLinked: 'None',
        blocksOnHint: 'Comma-separated requirement ids',
        eligibility: 'Eligibility',
        eligibilityFor: 'Read for {me}',
        eligibilityPanel: 'the panel',
        advanceableYes: 'Can advance',
        advanceableNo: 'Cannot advance',
        advanceableHint: 'Can advance means the lock is in hand and neither gate stands in the way — a different question from can claim.',
        forceAdvance: 'Force advance',
        forceConfirm: 'Force it',
        forceWarning: 'Forcing overrides the gate and records what it overrode in the history. It is never the default path.',
        forceApplied: 'Forced through; the gate it overrode is recorded in the history.',
        editRequirement: 'Edit',
        updateApplied: 'Requirement updated.',
        copyId: 'Copy ID',
        copiedId: 'Requirement ID copied.',
        errCopyId: 'Could not copy the requirement ID.',
        keyboardHint: 'j / k move · / search',
        statsFilterHint: 'Filter the list by this reading',
        loadMore: 'Load more ({shown} / {total})',
        listReloaded: 'The board changed; the list is back on its first page.',
        batchSelect: 'Select',
        batchExit: 'Exit selection',
        batchChosen: '{count} of {total} chosen',
        batchAll: 'Select all',
        batchNone: 'Clear selection',
        batchArchive: 'Archive',
        batchPriority: 'Priority',
        batchRole: 'Role',
        batchApply: 'Apply',
        batchUnchanged: 'Leave unchanged',
        batchWorking: 'Working…',
        batchResultTitle: 'Batch result',
        batchResultSummary: 'Succeeded {ok}, conflicts {conflict}, failed {failed}',
        batchResultOk: 'Succeeded',
        batchResultConflict: 'Conflicts',
        batchResultFailed: 'Failed',
        shortcutsTitle: 'Keyboard shortcuts',
        shortcutMove: 'Move the selection: j / k or ↑ / ↓',
        shortcutSearch: 'Open the filters and focus the search: /',
        shortcutClear: 'Clear the search: Esc',
        shortcutHelp: 'Show this help: ?',
        // Built-in template text is seeded into storage in Chinese by the Host;
        // the panel localizes it for the built-in id, so an English reader does
        // not get Chinese template and node names. Custom templates keep the
        // names their editors gave them.
        builtinTplStandard: 'Standard development flow',
        builtinTplStandardDesc: 'Review → design → implement → verify → release',
        builtinNodeReview: 'Requirement review',
        builtinNodeReviewDesc: 'Confirm scope, acceptance criteria, and stakeholders.',
        builtinNodeDesign: 'Solution design',
        builtinNodeDesignDesc: 'Produce an executable technical or product plan.',
        builtinNodeBuild: 'Implementation',
        builtinNodeBuildDesc: 'Complete the implementation and self-test it.',
        builtinNodeVerify: 'Verification',
        builtinNodeVerifyDesc: 'Run the test cases and close the defects.',
        builtinNodeRelease: 'Release',
        builtinNodeReleaseDesc: 'Produce the release artifact and confirm the rollout.',
        errDelegated: 'Another session handed this requirement on already.',
        errDelegatedRole: 'A delegated requirement keeps its temporary role until the delegation ends.',
        errPanelOnly: 'Only a person may clear another session reservation.',
        errSessionRequired: 'A session must be named.',
        errDelegateToSelf: 'A session cannot delegate to itself; it claims the work instead.',
        errNotOwned: 'The target session is not this session own sub-session.',
        errNotRelated: 'The caller is neither the creator, the owner, nor a member of this requirement.',
        errBlockedBy: 'Unfinished requirements stand in the way.',
        errCycle: 'That link would close a cycle.',
        errSelfReference: 'A requirement cannot depend on itself.',
        errMissingTarget: 'That requirement does not exist.',
        images: 'Images',
        addImage: 'Add image',
        pasteImageHint: 'Paste a screenshot (Ctrl+V) or pick a file · PNG/JPEG/WebP/GIF · up to 20 MiB each.',
        imageUploading: 'Uploading…',
        imageUploadFailed: '{name} was not uploaded.',
        imageTypeRejected: 'Not an accepted image type: {names}. Use PNG, JPEG, WebP or GIF.',
        imageTooLarge: 'Too large (over 20 MiB): {names}.',
        imageLimitReached: 'At most {max} images per requirement.',
        removeImage: 'Remove image',
        pastedImageName: 'pasted image',

        optionsTitle: 'Options (the decision question)',
        optionsCreateHint: 'Each question is one decision; every choice is a row the person picks. Question and choice ids are assigned in order (q1, q2 …; A, B, …).',
        optionQuestion: 'Question',
        optionQuestionPlaceholder: 'What should the person decide?',
        optionAddQuestion: 'Add question',
        optionRemoveQuestion: 'Remove question',
        optionItem: 'Choices',
        optionItemPlaceholder: 'The choice as the person reads it',
        optionItemDescription: 'Cost or benefit',
        optionItemDescriptionPlaceholder: 'What this choice costs or buys',
        optionAddItem: 'Add choice',
        optionRemoveItem: 'Remove choice',
        optionRecommended: 'Recommended',
        optionNeedQuestion: 'Every question needs its prompt.',
        optionNeedItems: 'Every question needs at least two choices with a label.',
        optionNeedOneRecommended: 'At most one choice per question may be recommended.',
        optionsHint: 'The board assigns question and choice ids in order; the panel submits the choice id.',
        optionAwaitingHuman: 'Waiting for your choice',
        optionChooseOne: 'Choose one',
        optionYourAnswer: 'Your answer',
        optionSubmitAnswer: 'Submit answer',
        optionAnsweredTag: 'Answered',
        optionAnswerNote: 'Reason (optional)',
        optionAnsweredAt: 'Answered at',
        optionAnswerSaved: 'Your answer was recorded.',

        templates: 'Flow templates',
        templateList: 'Templates',
        templateBuiltin: 'Built-in',
        templateArchived: 'Archived',
        includeArchived: 'Include archived',
        templateEmpty: 'No flow template is stored yet.',
        templateDetailEmpty: 'Select a template to see its flow and its version history.',
        templateInUse: 'Bound requirements',
        templatePinnedOld: 'Still on an older version',
        templateCurrentRevision: 'Current version {revision}',
        templateRevisionLine: 'Version {revision}',
        templateVersions: 'Version history',
        templateVersionsEmpty: 'This template has a single version so far.',
        templateVersionAuthor: 'By',
        templateVersionSummary: 'Summary',
        templateNoSummary: 'No summary recorded.',
        templatePinnedCount: 'Pinned by {count}',
        templatePinsUnknown: 'The Host did not report the pin counts.',
        templatePinsTruncated: 'Only the first {count} requirements were read; the counts are a lower bound.',
        templatePreview: 'Flow preview (read-only)',
        templateEditStructure: 'Edit the flow (appends a version)',
        templateEditMetadata: 'Template name and description',
        templateMetadataHint: 'Editing these does not append a version; it changes no requirement either.',
        templateRevisionUnchanged: 'The version stays {revision}; nothing is appended to the version history.',
        templateReviseHint: 'Saving appends one version. It changes no requirement: every requirement keeps running the version it is pinned to until you migrate it.',
        templateNodeId: 'Node id',
        templateNodeName: 'Node name',
        templateNodeDescription: 'Node description',
        templateNodeDepends: 'Depends on',
        templateNodeCompletion: 'Completion',
        templateNodeChecklist: 'Checklist entries',
        templateAddNode: 'Add node',
        templateMoveUp: 'Move up',
        templateMoveDown: 'Move down',
        templateRemoveNode: 'Remove',
        templateAddCheck: 'Add entry',
        templateRemoveCheck: 'Remove entry',
        templateNeedName: 'Every node needs a name.',
        templateNeedNodes: 'A template needs at least one node.',
        templateSaved: 'Version {revision} appended.',
        templateMetadataSaved: 'The template name and description were updated.',
        templateMigration: 'Migrate requirements',
        templateMigrationHint: "The board's own answer is the authority here: the first call is refused unless every still-pinned requirement moves at once, and the refusal carries the list below.",
        templateMigrationStep: 'Step {step}/{total}',
        templateMigrationRead: 'Read the affected requirements',
        templateMigrationNone: 'No requirement is still on an older version.',
        templateMigrationRow: '{title} ({id})',
        templateMigrationFrom: 'Current node',
        templateMigrationTo: 'After migration',
        templateMigrationCleared: 'The ticks of this node will be cleared (the checklist length changed).',
        templateMigrationKept: 'The ticks of this node are kept.',
        templateMigrationBulk: 'Migrate every listed requirement',
        templateMigrationBulkWarn: 'This is the unconfirmed bulk form: it changes every requirement above at once. Confirm to send it with force.',
        templateMigrationPicked: 'Migrate the selected {count}',
        templateMigrationDone: 'Migrated {count} requirement(s).',
        templateMigratedBy: 'Still pinned',
        templateArchiveAction: 'Archive',
        templateRestoreAction: 'Restore',
        templateArchivedNotice: 'This template is archived: it is no longer offered to new requirements, but the requirements already running it keep their flow.',
        templateClone: 'Duplicate',
        templateCloneHint: 'The supported way to change a built-in flow: the copy is an ordinary template you may edit.',
        templateDelete: 'Delete template',
        templateDeleteBound: 'These requirements are bound to this template and will be moved to {fallback}:',
        templateDeleteClear: 'This template is bound by no requirement and can be deleted.',
        templateDeleteConfirm: 'Delete this template and its whole version history? The requirements above are rebound and cannot be undone.',
        templateDeleteArmed: 'Confirm the deletion and the rebind',
        templatePrune: 'Drop this version',
        templatePruneDisabled: 'This version is pinned by {count} requirement(s) ({ids}), so dropping it would leave them without a flow.',
        templatePruneConfirm: 'Drop revision {revision} of this template?',
        templateMutated: 'The template was updated.',
        templateCloned: 'Template duplicated as {name}.',
        templateCloneTitle: 'Duplicate · {name}',
        templateNameRequired: 'A name is required.',
        templateNodesRequired: 'At least one node line is required.',
        templateFormError: 'This template was not saved.',
        templateDiscardConfirm: 'This form has unsaved changes.',
        templateDiscardConfirmDrop: 'Discard and close',
        templateDiscardConfirmKeep: 'Keep editing',
        templateDeleted: 'Template deleted; its requirements were rebound.',
        templateArchived: 'Template archived.',
        templateRestored: 'Template restored.',
        templatePruned: 'Revision {revision} was dropped.',
        errTemplateBuiltin: 'A built-in template cannot be edited, archived, or deleted; duplicate it first.',
        errTemplateDefault: 'That template is this deployment default and cannot be archived or deleted.',
        errTemplateEmptyNodes: 'A template needs at least one node.',
        errTemplateCycle: 'That dependency would close a cycle.',
        errTemplateUnknownDep: 'A node depends on a node that is not in the list.',
        errTemplateDuplicateId: 'Two nodes carry the same id.',
        errTemplateInUse: 'The template is still used by requirements.',
        errTemplateInvalidConfig: 'The default template this deployment would rebind to is not stored, so nothing was changed.',
        clearFilters: 'Clear all',
        statsAlertHint: 'needs attention',
        // v3 (§3): the toolbar's popover grammar, the list head, and the two
        // view-context folds the right column demotes the overview into.
        moreReadings: 'More readings',
        moreFilters: 'More filters',
        secOverview: 'Overview',
        secQueueCaliber: 'Queue caliber',
        secDecisions: 'Decision flow',
        listTitle: 'Requirements',
        answerHow: 'How to answer',
        agentBoundary: 'Agent boundary',
        caliberReserve: 'Reserve',
        caliberHead: 'Head and order',
        caliberCap: 'Ceiling',
        caliberCapBody: 'A session queue stops at the configured ceiling: a further reservation is refused, never the oldest dropped.',
        answerHowBody: 'Pick a choice in the decision detail; the answer is written back onto the requirement and every session reads it.',
        agentBoundaryBody: 'An agent cannot choose, archive, or hand on a decision requirement.',
        // The concept sheet prints a small English identifier inside each
        // section heading. It identifies the section rather than describing it,
        // so both dictionaries carry the same word.
        secBody: 'BODY',
        secImages: 'IMAGES',
        secOptions: 'OPTIONS',
        secEligibility: 'ELIGIBILITY',
        secGates: 'GATES',
        secExecutions: 'EXECUTIONS',
        secLock: 'LOCK',
        secHandoff: 'HANDOFF',
        secFlow: 'FLOW',
        secNode: 'NODE',
        secHistory: 'HISTORY',
        secChecks: 'CHECKS',
        secDurations: 'DURATIONS',
        secBlocked: 'BLOCKED',
        secStalled: 'STALLED',
        secStructure: 'STRUCTURE',
        secPreview: 'PREVIEW',
        secVersions: 'VERSIONS',
      },
      zh: {
        panel: '需求看板',
        title: '需求看板',
        subtitle: '本 Harness 的所有会话共享',
        refresh: '刷新',
        newRequirement: '新建需求',
        newTemplate: '新建流程模板',
        loading: '正在加载看板…',
        empty: '没有符合当前筛选条件的需求。',
        emptyBoard: '还没有需求。可以在这里新建，或让 AI 创建。',
        filterSession: '所属会话',
        filterOwner: '负责人',
        filterStatus: '状态',
        filterPriority: '优先级',
        filterQuery: '搜索',
        all: '全部',
        open: '未完成',
        statusActive: '进行中',
        statusBlocked: '阻塞',
        statusDone: '已完成',
        statusArchived: '已归档',
        statusPending: '未开始',
        priorityLow: '低',
        priorityNormal: '普通',
        priorityHigh: '高',
        priorityUrgent: '紧急',
        owner: '负责人',
        unassigned: '未分配',
        sessions: '所属会话',
        template: '流程模板',
        flow: '流程图',
        nodeDetail: '节点详情',
        selectNode: '点击流程图中的节点查看详情与流转历史。',
        completionManual: '由处理人确认完成',
        completionChecklist: '需勾选全部检查项方可完成',
        requireNote: '完成该节点必须填写说明',
        checks: '检查项',
        entered: '进入时间',
        completed: '完成时间',
        spent: '节点耗时',
        history: '流转历史',
        noHistory: '暂无流转记录。',
        advance: '完成并推进',
        rollback: '回退到此节点',
        jump: '强制跳转到此节点',
        reopen: '重新打开',
        block: '标记阻塞',
        unblock: '解除阻塞',
        archive: '归档',
        restore: '恢复',
        remove: '删除',
        note: '说明',
        notePlaceholder: '本次流转的原因…',
        blockReasonPlaceholder: '阻塞原因是什么？',
        confirm: '确定',
        cancel: '取消',
        close: '关闭',
        create: '创建',
        summary: '简述',
        summaryHint: '用一两句大白话说清楚要做什么、为什么值得做；实现细节留给下面的描述。',
        summaryEmpty: '这条需求还没有简述：它写在简述字段出现之前。',
        project: '项目',
        projectHint: '给这摊活起个短名字，同一个项目里每条需求的写法保持一致；不属于任何项目就留空。',
        projectUnassigned: '未归属',
        groupProject: '按项目分组',
        description: '描述',
        titleField: '标题',
        projectProgress: '项目进度',
        completionRate: '完成率',
        total: '总数',
        blockedTitle: '阻塞项',
        stalledTitle: '停滞项',
        nodeDurations: '各节点平均耗时',
        noBlocked: '当前没有阻塞项。',
        noStalled: '当前没有停滞项。',
        samples: '样本',
        avg: '平均',
        durationHint: '各值均为节点停留时长：从进入节点到离开，含接手前的排队等待。',
        templateName: '模板名称',
        templateDescription: '模板说明',
        templateNodes: '节点列表',
        templateNodesHint: '每行一个节点：名称 | 负责人 | 检查项1;检查项2',
        templateNodesExample: '需求评审 | 张三 | 范围明确;干系人确认\n方案设计 | 李四\n开发实现\n测试验证\n发布上线',
        nodesLabel: '节点',
        deleteConfirm: '删除该需求及其全部流转历史？此操作不可撤销。',
        nodeCount: '个节点',
        updated: '更新于',
        revision: '版本',
        dependencies: '前置节点',
        blockedBecause: '阻塞原因',
        lastTransition: '最近流转',
        live: '实时同步已连接',
        unknownError: '操作失败。',
        errCompletionNotMet: '当前节点尚未满足完成条件。',
        errDependencyNotMet: '前置节点尚未完成。',
        errConflict: '其他会话已先修改该需求，请刷新后重试。',
        errTemplateConflict: '其他会话已先改了这个模板；你的草稿保留在下面。',
        errNotFound: '该需求已不存在。',
        errInvalidTransition: '当前状态下不允许该流转。',
        errInUse: '模板仍被需求使用。',
        errInvalidArgument: '输入不合法。',
        errForbidden: '请求被拒绝。',
        errInvalidState: '该需求已处于此状态。',
        errInvalidRole: '角色 ID 不合法。',
        errLockRequired: '改这项需求前要先拿执行锁。',
        errNotLockHolder: '只有持锁的会话才能释放这把锁。',
        errRoleMismatch: '这项需求路由给了别的角色。',
        errDecisionTask: '决策类需求只能由人推进。',
        errLocked: '其他会话持有执行锁。',
        errReserved: '其他会话已把这项需求排进队列。',
        errSessionBusy: '该会话已在执行另一项需求。',
        roles: '角色管理',
        newRole: '新建角色',
        roleId: '角色 ID',
        roleName: '显示名',
        roleDuties: '职能',
        roleDutiesHint: '用逗号分隔，最多 12 项',
        rolesColumn: '角色',
        presetsColumn: '预设关联',
        roleSearch: '检索角色',
        presetSearch: '检索预设',
        roleGroupRegistered: '已登记',
        roleGroupEphemeral: '临时',
        rolesNoMatch: '没有角色匹配这个检索词。',
        presetsNoMatch: '没有预设匹配这个检索词。',
        roleDutyAdd: '添加一条',
        roleDutyRemove: '移除',
        roleDutyCount: '{count}/12',
        roleDutyEmptyHint: '空行不会写入；每条最多 40 字。',
        roleDutyMerged: '已合并 {count} 条重复职能。',
        roleDiscardConfirm: '这份表单还有未保存的改动。',
        roleDiscardConfirmDrop: '丢弃并关闭',
        roleDiscardConfirmKeep: '继续编辑',
        roleFormError: '该角色未保存。',
        roleRowError: '该角色未删除。',
        roleEditTitle: '编辑 · {name}（{id}）',
        roleRegisterTitle: '登记角色 · {name}（{id}）',
        roleNone: '未指定角色',
        anyRole: '任意角色',
        rolesEmpty: '还没有登记任何角色。',
        rolesUnregistered: '在用但未登记',
        roleEphemeral: '临时',
        roleBoundSession: '绑定会话',
        roleBoundTask: '绑定任务',
        roleDutiesMissing: '没有登记职能',
        roleUnregistered: '未登记',
        roleHoldersCount: '{count} 人在线',
        roleRunningCount: '{count} 执行中',
        roleNoHolders: '暂无人在线',
        roleHoldersUnknown: '无法统计在线状态',
        roleOpen: '{count} 个未完成',
        roleSourcePreset: '来自预设声明',
        roleSourceManual: '面板登记',
        roleSourceObserved: '预设 id 兜底',
        roleSourceDelegated: '派发铸造',
        rolePresets: '预设模式',
        presetsReading: '正在读取预设名册…',
        presetsEmpty: '预设名册里没有任何预设。',
        presetsUnavailableAbsent: '这个组合里没有挂载预设注册表，无法显示预设关联。',
        presetsUnavailableFailed: '读取预设名册失败，无法显示预设关联。',
        presetUnregistered: '该预设的角色没有登记',
        presetRoleInvalid: '预设 id 不是合法角色 id',
        presetBroken: '预设不可用',
        presetRegister: '登记角色',
        presetSessions: '{count} 个会话在此预设',
        presetInferred: '按预设 id 推定，尚无会话确认',
        edit: '编辑',
        save: '保存',
        removeRole: '删除角色',
        removeRoleConfirm: '删除该角色？仍引用它的需求会变成「未登记」',
        filterRole: '角色',
        filterKind: '类型',
        kindTask: '任务',
        kindDecision: '决策',
        filterClaimable: '只看可接',
        filterPanel: '筛选',
        filterShow: '展开筛选',
        filterHide: '收起筛选',
        filterSummaryAll: '全部需求',
        filterRoleAll: '全部角色',
        filterRemove: '移除该筛选',

        claimableYes: '可接手',
        claimableNo: '不可接手',
        claimableHint: '可接手池：未完成、未归档、锁空闲的活，不区分角色',
        lock: '执行锁',
        locked: '已锁',
        unlocked: '未锁',
        lockHolder: '持有者',
        lockHeldSince: '已持有',
        lockTouched: '续约于',
        lockOrphaned: '孤儿锁',
        lockExpired: '租约已过期',
        lockStale: '未续约',
        releaseLock: '释放锁',
        staleNotice: '同步中断，数据可能过期',
        retry: '重试',
        recheck: '重新检查',
        view: '视图',
        viewBoard: '看板',
        viewQueue: '队列',
        viewDecisions: '要我拍板',
        viewDecisionsHint: '决策类需求只能由人推进；AI 会话会被规则拒绝，这不是故障。',
        decisionsEmpty: '当前没有等人拍板的决策。',
        decisionBadge: '要人拍板',
        requestedBy: '提出者',
        queueTitle: '预留队列',
        queueEmpty: '没有任何会话预留需求。',
        queueCount: '已预留 {count} 项',
        queueSoftHint: '预留是软占用：被预留的需求不会出现在可接手池里。',
        reservedBadge: '已被预留',
        clearReservation: '清除预留',
        reservationCleared: '已清除预留。',
        reservationAbsent: '本来就没有预留。',
        filterMe: '会话口径（me）',
        filterMeHint: '按这个会话的口径回答资格',
        roleHuman: '人的收件箱',
        executions: '执行单元',
        executionsHint: '执行观测推进的是观测版本，不会推进需求版本。',
        executionsEmpty: '这条需求当前没有执行单元。',
        executionsTruncated: '只保留最近的执行单元，更早的已被丢弃。',
        executionSyncOff: '执行同步已关闭：只知道锁，空列表不等于「没有在执行」。',
        executionSyncGap: '执行同步有缺口：屏幕上的状态可能已经过期。',
        executionSyncReason: '原因',
        executionSyncAt: '最近观测',
        execRevLine: '观测版本 execRev {exec}；需求版本仍为 {rev}。',
        runningBadge: '执行中 {count}',
        statsRunning: '执行中',
        statsExecIgnored: '未归因事件',
        statsExecGaps: '观测缺口',
        unitJob: '作业',
        unitSubagent: '子会话',
        unitStarted: '开始',
        unitFinished: '结束',
        unitStale: '自上次更新',
        queueNext: '下一个',
        queueHint: '每个队列的队头与顺序都由服务端给出，面板不重排。',
        authExpired: '面板会话已过期。',
        authExpiredHint: '请重新打开面板以重新登录；在此之前不会自动重试。',
        authCrossOrigin: '该请求被判为跨源并拒绝。',
        authCrossOriginHint: '请从面板自身的地址打开；在此之前不会自动重试。',
        delegation: '委托',
        delegatedTo: '已派发给',
        delegatedBadge: '已派发',
        delegatedRoleBefore: '派发前角色',
        delegatedAt: '派发时间',
        delegate: '派发',
        delegateTarget: '目标会话',
        delegateDuties: '职能（可选）',
        delegateDutiesHint: '用逗号分隔',
        delegateNeedsSession: '请填写接收这项工作的会话。',
        delegateDone: '已派发给 {session}。',
        revokeDelegation: '撤销派发',
        delegationRevoked: '已撤销派发。',
        delegationAbsent: '本来就没有委托，无需撤销。',
        notDelegated: '未派发给任何会话。',
        statsUnfinished: '未结束',
        statsQueued: '排队中',
        statsReserved: '被预留',
        statsPendingDelegations: '待接派发',
        statsOrphanedLocks: '孤儿锁',
        statsByRole: '按角色未结束',
        criticalPath: '关键路径',
        criticalTag: '关键路径',
        effectivePriority: '有效等级',
        ownPriority: '自身 priority',
        priorityLiftedHint: '因为挡住了进行中的工作而被抬高；不会写回需求。',
        gates: '门禁',
        gatesHint: '推进要等前置的未完成工作；把挡路的需求归档并不等于完成它。',
        blocksOnTitle: '前置需求（我依赖）',
        blockedByTitle: '当前挡着我',
        gatedBadge: '被挡 {count} 项',
        blocksBadge: '等待 {count} 项',
        parentRequirement: '父需求',
        childrenTitle: '子需求',
        noneLinked: '无',
        blocksOnHint: '逗号分隔的需求 ID',
        eligibility: '资格口径',
        eligibilityFor: '口径：{me}',
        eligibilityPanel: '面板',
        advanceableYes: '可推进',
        advanceableNo: '推不动',
        advanceableHint: '「可推进」＝持有执行锁且门禁已清，和「可接手」是两个口径。',
        forceAdvance: '强制推进',
        forceConfirm: '确认强制推进',
        forceWarning: '强制推进会越过门禁，并把被越过的门禁记入历史；这不是默认路径。',
        forceApplied: '已强制推进，被越过的门禁记入历史。',
        editRequirement: '编辑',
        updateApplied: '已更新需求。',
        copyId: '复制 ID',
        copiedId: '已复制需求 ID。',
        errCopyId: '复制需求 ID 失败。',
        keyboardHint: 'j / k 移动 · / 搜索',
        statsFilterHint: '按这个读数过滤列表',
        loadMore: '加载更多（{shown} / {total}）',
        listReloaded: '看板有更新，列表已回到第一页。',
        batchSelect: '批量',
        batchExit: '退出选择',
        batchChosen: '已选 {count} / {total}',
        batchAll: '全选',
        batchNone: '清空选择',
        batchArchive: '归档',
        batchPriority: '优先级',
        batchRole: '角色',
        batchApply: '应用',
        batchUnchanged: '不修改',
        batchWorking: '处理中…',
        batchResultTitle: '批量结果',
        batchResultSummary: '成功 {ok} 条，冲突 {conflict} 条，失败 {failed} 条',
        batchResultOk: '成功',
        batchResultConflict: '冲突',
        batchResultFailed: '失败',
        shortcutsTitle: '键盘快捷键',
        shortcutMove: '移动选中：j / k 或 ↑ / ↓',
        shortcutSearch: '展开筛选并聚焦搜索：/',
        shortcutClear: '清空搜索：Esc',
        shortcutHelp: '显示这份帮助：？',
        builtinTplStandard: '标准研发流程',
        builtinTplStandardDesc: '评审 → 设计 → 实现 → 验证 → 发布',
        builtinNodeReview: '需求评审',
        builtinNodeReviewDesc: '确认范围、验收标准与相关方。',
        builtinNodeDesign: '方案设计',
        builtinNodeDesignDesc: '给出可执行的技术或产品方案。',
        builtinNodeBuild: '开发实现',
        builtinNodeBuildDesc: '完成实现并自测通过。',
        builtinNodeVerify: '测试验证',
        builtinNodeVerifyDesc: '执行用例并关闭缺陷。',
        builtinNodeRelease: '发布上线',
        builtinNodeReleaseDesc: '产出发布物并完成上线确认。',
        errDelegated: '该需求已被派发给其他会话。',
        errDelegatedRole: '派发期间该需求用临时角色路由，结束派发后才能改。',
        errPanelOnly: '只有人可以通过面板清除其他会话的预留。',
        errSessionRequired: '需要指定会话。',
        errDelegateToSelf: '不能派发给自己，自己要做就直接认领。',
        errNotOwned: '目标会话不是调用方的子会话。',
        errNotRelated: '调用方既不是创建者、负责人，也不是该需求的成员。',
        errBlockedBy: '被未完成的需求挡着。',
        errCycle: '这条关系会成环。',
        errSelfReference: '需求不能依赖自己。',
        errMissingTarget: '目标需求不存在。',
        images: '图片',
        addImage: '添加图片',
        pasteImageHint: '可粘贴截图（Ctrl+V）或选择文件 · PNG/JPEG/WebP/GIF · 单张 ≤ 20 MiB',
        imageUploading: '上传中…',
        imageUploadFailed: '{name} 未能上传。',
        imageTypeRejected: '不支持的文件类型：{names}。请使用 PNG、JPEG、WebP 或 GIF。',
        imageTooLarge: '文件过大（超过 20 MiB）：{names}。',
        imageLimitReached: '每条需求最多 {max} 张图片。',
        removeImage: '移除图片',
        pastedImageName: '粘贴的图片',

        optionsTitle: '选项（裁决题）',
        optionsCreateHint: '每道题就是一次要人拍板的选择；每个选项是一行人可以直接选的答案。题目与选项的 id 按顺序自动分配（q1、q2…；A、B…）。',
        optionQuestion: '题目',
        optionQuestionPlaceholder: '要让人拍板的问题是什么？',
        optionAddQuestion: '添加题目',
        optionRemoveQuestion: '移除题目',
        optionItem: '选项',
        optionItemPlaceholder: '人看到的选项文字',
        optionItemDescription: '代价或好处',
        optionItemDescriptionPlaceholder: '这个选项的代价或好处',
        optionAddItem: '添加选项',
        optionRemoveItem: '移除选项',
        optionRecommended: '推荐',
        optionNeedQuestion: '每道题都要有题干。',
        optionNeedItems: '每道题至少要有两个填了文字的选项。',
        optionNeedOneRecommended: '每道题最多只能推荐一个选项。',
        optionsHint: '题目与选项的 id 由看板按顺序分配，面板提交的是选项 id。',
        optionAwaitingHuman: '在等你选',
        optionChooseOne: '选一个',
        optionYourAnswer: '你的选择',
        optionSubmitAnswer: '提交选择',
        optionAnsweredTag: '已作答',
        optionAnswerNote: '理由（可选）',
        optionAnsweredAt: '作答时间',
        optionAnswerSaved: '已记录你的选择。',

        templates: '流程模板管理',
        templateList: '模板列表',
        templateBuiltin: '内置',
        templateArchived: '已归档',
        includeArchived: '含已归档',
        templateEmpty: '还没有任何流程模板。',
        templateDetailEmpty: '选择一个模板，查看它的流程图与版本历史。',
        templateInUse: '在用需求',
        templatePinnedOld: '仍钉旧版',
        templateCurrentRevision: '当前第 {revision} 版',
        templateRevisionLine: '第 {revision} 版',
        templateVersions: '版本历史',
        templateVersionsEmpty: '该模板目前只有一版。',
        templateVersionAuthor: '作者',
        templateVersionSummary: '摘要',
        templateNoSummary: '没有记录摘要。',
        templatePinnedCount: '被 {count} 条需求钉住',
        templatePinsUnknown: '宿主没有报告钉住条数。',
        templatePinsTruncated: '只读到前 {count} 条需求，条数是下界。',
        templatePreview: '流程预览（只读）',
        templateEditStructure: '编辑流程（保存＝追加一个版本）',
        templateEditMetadata: '模板名称与说明',
        templateMetadataHint: '改这两项不追加版本，也不改任何需求。',
        templateRevisionUnchanged: '版本仍是第 {revision} 版，不会进入版本历史。',
        templateReviseHint: '保存即追加一个版本，一行需求都不动：每条需求仍按自己钉住的那一版跑，直到你把它迁移过去。',
        templateNodeId: '节点 id',
        templateNodeName: '节点名称',
        templateNodeDescription: '节点说明',
        templateNodeDepends: '前置节点',
        templateNodeCompletion: '完成条件',
        templateNodeChecklist: '检查项',
        templateAddNode: '添加节点',
        templateMoveUp: '上移',
        templateMoveDown: '下移',
        templateRemoveNode: '移除',
        templateAddCheck: '添加检查项',
        templateRemoveCheck: '删除检查项',
        templateNeedName: '每个节点都要有名称。',
        templateNeedNodes: '模板至少需要一个节点。',
        templateSaved: '已追加第 {revision} 版。',
        templateMetadataSaved: '模板名称与说明已更新。',
        templateMigration: '迁移需求',
        templateMigrationHint: '这里以宿主自己的答复为准：不指名需求时会先被拒，被拒的答复里带着下面这份清单。',
        templateMigrationStep: '第 {step}/{total} 步',
        templateMigrationRead: '读取受影响的需求',
        templateMigrationNone: '没有需求还钉在旧版上。',
        templateMigrationRow: '{title}（{id}）',
        templateMigrationFrom: '当前节点',
        templateMigrationTo: '迁移后节点',
        templateMigrationCleared: '该节点的勾选会被清空（检查项数量变了）。',
        templateMigrationKept: '该节点的勾选会保留。',
        templateMigrationBulk: '全部迁移',
        templateMigrationBulkWarn: '这是未指名需求的批量形式：会一次改掉上面每一条需求。确认后带 force 发出。',
        templateMigrationPicked: '迁移选中的 {count} 条',
        templateMigrationDone: '已迁移 {count} 条需求。',
        templateMigratedBy: '仍钉住',
        templateArchiveAction: '归档',
        templateRestoreAction: '恢复',
        templateArchivedNotice: '该模板已归档：不再出现在新建需求的选择器里，但已在跑的需求照旧按各自钉住的版本跑。',
        templateClone: '复制',
        templateCloneHint: '改内置流程的正路：复制出来的是一份可正常编辑的普通模板。',
        templateDelete: '删除模板',
        templateDeleteBound: '以下需求绑在该模板上，删除后会被改绑到 {fallback}：',
        templateDeleteClear: '没有任何需求绑定该模板，可以直接删除。',
        templateDeleteConfirm: '删除该模板及其全部版本历史？上面列出的需求会被改绑，此操作不可撤销。',
        templateDeleteArmed: '确认删除并改绑',
        templatePrune: '裁剪该版本',
        templatePruneDisabled: '该版本被 {count} 条需求钉住（{ids}），裁掉它们就没有流程可解析了。',
        templatePruneConfirm: '裁剪该模板的第 {revision} 版？',
        templateMutated: '模板已更新。',
        templateCloned: '已复制为 {name}。',
        templateCloneTitle: '复制 · {name}',
        templateNameRequired: '名称必填。',
        templateNodesRequired: '至少要有一行节点。',
        templateFormError: '该模板未保存。',
        templateDiscardConfirm: '这份表单还有未保存的改动。',
        templateDiscardConfirmDrop: '丢弃并关闭',
        templateDiscardConfirmKeep: '继续编辑',
        templateDeleted: '模板已删除，其需求已改绑。',
        templateArchived: '模板已归档。',
        templateRestored: '模板已恢复。',
        templatePruned: '第 {revision} 版已裁剪。',
        errTemplateBuiltin: '内置模板不可编辑、不可归档、不可删除；请先复制一份。',
        errTemplateDefault: '该模板是本部署的默认模板，不可归档、不可删除。',
        errTemplateEmptyNodes: '模板至少需要一个节点。',
        errTemplateCycle: '该前置关系会成环。',
        errTemplateUnknownDep: '某个节点的前置节点不在列表里。',
        errTemplateDuplicateId: '有两个节点用了同一个 id。',
        errTemplateInUse: '模板仍被需求使用。',
        errTemplateInvalidConfig: '本部署用来改绑的默认模板不存在，因此一个需求也没有改动。',
        clearFilters: '清除全部',
        statsAlertHint: '需要处理',
        // v3（§3）：工具条弹层语法、列表头，以及右栏收纳概览的两个视图语境折叠。
        moreReadings: '更多读数',
        moreFilters: '更多筛选',
        secOverview: '板概览',
        secQueueCaliber: '队列口径',
        secDecisions: '决策流程',
        listTitle: '需求列表',
        answerHow: '怎么回答',
        agentBoundary: '代理边界',
        caliberReserve: '预留',
        caliberHead: '队头与顺序',
        caliberCap: '上限',
        caliberCapBody: '一个会话的预留队列到配置上限即止：超出时拒绝追加，而不是丢弃最旧。',
        answerHowBody: '在决策详情里选择选项；答案回写在需求上，任何会话都能读到。',
        agentBoundaryBody: '智能体不能选择、不能归档、不能转派决策类需求。',
        // 分节小字是分节的英文标识（概念稿的视觉语言），两种语言用同一个词。
        secBody: 'BODY',
        secImages: 'IMAGES',
        secOptions: 'OPTIONS',
        secEligibility: 'ELIGIBILITY',
        secGates: 'GATES',
        secExecutions: 'EXECUTIONS',
        secLock: 'LOCK',
        secHandoff: 'HANDOFF',
        secFlow: 'FLOW',
        secNode: 'NODE',
        secHistory: 'HISTORY',
        secChecks: 'CHECKS',
        secDurations: 'DURATIONS',
        secBlocked: 'BLOCKED',
        secStalled: 'STALLED',
        secStructure: 'STRUCTURE',
        secPreview: 'PREVIEW',
        secVersions: 'VERSIONS',
      },
    }

    /** Boards map a service error code onto its localized explanation. */
    const ERROR_KEYS = {
      'completion-not-met': 'errCompletionNotMet',
      'dependency-not-met': 'errDependencyNotMet',
      conflict: 'errConflict',
      'not-found': 'errNotFound',
      'invalid-transition': 'errInvalidTransition',
      'invalid-state': 'errInvalidState',
      'invalid-role': 'errInvalidRole',
      'in-use': 'errInUse',
      'invalid-argument': 'errInvalidArgument',
      'forbidden-origin': 'authCrossOrigin',
      forbidden: 'errForbidden',
      unauthenticated: 'authExpired',
    }

    /**
     * `conflict` and `forbidden` carry a stable `details.reason` that names which
     * row of the claim decision table refused. Those rows explain themselves
     * better than the code alone, so they win over the code's own sentence.
     */
    const CONFLICT_REASONS = {
      locked: 'errLocked',
      reserved: 'errReserved',
      'session-busy': 'errSessionBusy',
      delegated: 'errDelegated',
      'delegated-role': 'errDelegatedRole',
    }
    const FORBIDDEN_REASONS = {
      'lock-required': 'errLockRequired',
      'not-lock-holder': 'errNotLockHolder',
      'role-mismatch': 'errRoleMismatch',
      'decision-task': 'errDecisionTask',
      'panel-only': 'errPanelOnly',
      'not-owned': 'errNotOwned',
      'not-related': 'errNotRelated',
    }
    /**
     * Reasons that arrive under `invalid-argument` or `invalid-input`
     * (`delegate` uses the second code for the same class of refusal).
     */
    const INVALID_REASONS = {
      'session-required': 'errSessionRequired',
      'delegate-to-self': 'errDelegateToSelf',
      cycle: 'errCycle',
      'self-reference': 'errSelfReference',
      'missing-target': 'errMissingTarget',
    }
    /**
     * `invalid-transition` carries `details.reason` too: a refused `advance` or
     * `complete` names `blocked-by` and the unfinished blockers it waits on, which
     * the code's own sentence does not say.
     */
    const TRANSITION_REASONS = {
      'blocked-by': 'errBlockedBy',
    }

    /** Board filter keys and the locale key naming each one. */
    const FILTER_LABELS = {
      session: 'filterSession',
      owner: 'filterOwner',
      status: 'filterStatus',
      priority: 'filterPriority',
      role: 'filterRole',
      kind: 'filterKind',
      project: 'project',
    }

    /**
     * Filter keys the Host's list route understands (`host/http.js`). `role` is
     * the routing role in force (`?role=human` is the human's inbox); `me` is the
     * session whose reading of the hand-off pool is asked for. Passing a key the
     * route ignores would look like it worked, so the sets are kept apart.
     */
    const HOST_FILTER_KEYS = ['session', 'owner', 'status', 'priority', 'kind', 'role', 'templateId', 'project', 'query', 'claimable', 'me']

    /**
     * Project select value standing for "belongs to no project".
     *
     * A `<select>` value is a string, so the empty one cannot mean both "every
     * project" and the Host's own spelling of the unassigned filter — the empty
     * string. The sentinel names the second state in the control and is mapped
     * back to `''` before the filter leaves the page.
     */
    const PROJECT_UNASSIGNED = '__unassigned__'

    /**
     * DOM ids of the project suggestion lists.
     *
     * The create dialog and the inline edit form each own one: both can be on
     * screen at once, and two elements sharing an id would leave one input
     * reading the other's suggestions.
     */
    const PROJECT_SUGGESTIONS_CREATE = 'rb-project-suggestions-create'
    const PROJECT_SUGGESTIONS_EDIT = 'rb-project-suggestions-edit'

    /** Role select value standing for "the requirement names no role". */
    /**
     * The small English identifier the concept sheet prints inside a section
     * heading. Only the detail column's sections carry one; a section with no
     * entry here renders its title alone.
     */
    const SECTION_EN = {
      description: 'secBody',
      images: 'secImages',
      options: 'secOptions',
      eligibility: 'secEligibility',
      gates: 'secGates',
      executions: 'secExecutions',
      lock: 'secLock',
      delegation: 'secHandoff',
      flow: 'secFlow',
      nodeDetail: 'secNode',
      history: 'secHistory',
      checks: 'secChecks',
      nodeDurations: 'secDurations',
      blockedTitle: 'secBlocked',
      stalledTitle: 'secStalled',
      templateEditStructure: 'secStructure',
      templatePreview: 'secPreview',
      templateVersions: 'secVersions',
    }

    /**
     * One section heading: the concept's orange bar and the section's English
     * identifier.
     * @param labelKey - Dictionary key naming the section.
     * @param t - The panel's translator.
     */
    const sectionHead = (labelKey, t) => h('div', { className: 'rb-section-title' },
      h('span', null, t(labelKey)),
      SECTION_EN[labelKey] === undefined ? null : h('span', { className: 'rb-en' }, t(SECTION_EN[labelKey])))

    /**
     * One foldable section of the detail column.
     *
     * It opens by default: folding is available, but no reading is hidden from a
     * reader who has not folded it.
     * @param labelKey - Dictionary key naming the section.
     * @param t - The panel's translator.
     * @param children - The section body, in order.
     */
    const foldSection = (labelKey, t, ...children) => h('details', { className: 'rb-fold', open: true },
      h('summary', { className: 'rb-fold-summary' },
        h('span', null, t(labelKey)),
        SECTION_EN[labelKey] === undefined ? null : h('span', { className: 'rb-en' }, t(SECTION_EN[labelKey])),
        h('span', { className: 'rb-caret', 'aria-hidden': 'true' }, '▶')),
      h('div', { className: 'rb-fold-body' }, children))

    /**
     * The same fold, starting closed (v3 §3 V3-7).
     *
     * A view's own reading leads its right column; the board overview travels
     * along folded, present for the reader who wants it without competing for
     * the place of honour.
     * @param labelKey - Dictionary key naming the section.
     * @param t - The panel's translator.
     * @param children - The section body, in order.
     */
    const foldSectionClosed = (labelKey, t, ...children) => h('details', { className: 'rb-fold' },
      h('summary', { className: 'rb-fold-summary' },
        h('span', null, t(labelKey)),
        SECTION_EN[labelKey] === undefined ? null : h('span', { className: 'rb-en' }, t(SECTION_EN[labelKey])),
        h('span', { className: 'rb-caret', 'aria-hidden': 'true' }, '▶')),
      h('div', { className: 'rb-fold-body' }, children))
    const ROLE_NONE = '\u0000none'

    /** Milliseconds in one display unit, largest first. */
    const DURATION_UNITS = [
      ['d', 86_400_000],
      ['h', 3_600_000],
      ['m', 60_000],
      ['s', 1000],
    ]

    /** Format a millisecond span compactly; `null` renders as an em dash. */
    function formatDuration(ms) {
      if (ms === null || ms === undefined) return '—'
      if (ms < 1000) return '0s'
      const parts = []
      let rest = ms
      for (const [suffix, size] of DURATION_UNITS) {
        const value = Math.floor(rest / size)
        if (value > 0) {
          parts.push(`${value}${suffix}`)
          rest -= value * size
        }
        if (parts.length === 2) break
      }
      return parts.join(' ')
    }

    /** Format an ISO instant for the reader's locale, or an em dash. */
    function formatInstant(value) {
      if (value === null || value === undefined || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString()
    }

    /**
     * Create the page's one observable snapshot source.
     *
     * The renderer binds `getSnapshot`/`subscribe` to a `useBoard()` hook, so
     * the source keeps a stable identity while its snapshot reference changes
     * only when the fact moves.
     */
    function createSnapshotSource(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: listener => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        publish(next) {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** The locale key explaining one board error, or undefined when it has none. */
    function errorKey(error) {
      const reason = error?.details?.reason
      if (error?.code === 'conflict' && CONFLICT_REASONS[reason] !== undefined) return CONFLICT_REASONS[reason]
      if (error?.code === 'forbidden' && FORBIDDEN_REASONS[reason] !== undefined) return FORBIDDEN_REASONS[reason]
      if ((error?.code === 'invalid-argument' || error?.code === 'invalid-input') && INVALID_REASONS[reason] !== undefined) return INVALID_REASONS[reason]
      if (error?.code === 'invalid-transition' && TRANSITION_REASONS[reason] !== undefined) return TRANSITION_REASONS[reason]
      return ERROR_KEYS[error?.code] ?? (error?.code === 'invalid-input' ? ERROR_KEYS['invalid-argument'] : undefined)
    }

    /** Normalise a board service error for display. */
    function describeError(error, t) {
      const key = errorKey(error)
      const head = key === undefined ? t('unknownError') : t(key)
      const detail = typeof error?.message === 'string' && error.message !== '' ? error.message : ''
      return detail === '' ? head : `${head} (${detail})`
    }

    /** Fill `{name}` placeholders in one dictionary line. */
    function interpolate(text, params) {
      if (params === undefined || params === null) return text
      return String(text).replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
    }

    /** Everything a browser remembers between visits; none of it is board data. */
    const PREFERENCES_KEY = 'requirement-board:v1'

    /** The filter reading an untouched board uses. */
    const FILTER_DEFAULTS = {
      session: '', owner: '', status: 'open', priority: '', query: '', role: '', kind: '',
      project: undefined, claimable: false, me: '',
    }

    /** Values the Host accepts for the enumerated filter keys. */
    const FILTER_VALUES = {
      status: ['open', 'active', 'blocked', 'done', 'archived', ''],
      priority: ['', 'low', 'normal', 'high', 'urgent'],
      kind: ['', 'task', 'decision'],
    }

    /**
     * The preferences a previous visit stored, or `null` where the browser has
     * none or keeps an unreadable value. Storage is a convenience, never board
     * state: an unreadable value reads as "no preferences", not as a failure.
     */
    function readPreferences() {
      try {
        const raw = globalThis.localStorage?.getItem(PREFERENCES_KEY)
        if (typeof raw !== 'string' || raw === '') return null
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    /** Persist preferences; a browser that refuses storage simply forgets them. */
    function writePreferences(preferences) {
      try {
        globalThis.localStorage?.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
      } catch {
        // Private mode, a full quota, or no storage at all: the panel still works.
      }
    }

    /**
     * One stored filter reading, or `null` when nothing usable was stored.
     *
     * Only the Host's own filter keys survive, and enumerated keys are checked
     * against their accepted values: a hand-edited document cannot ask the page
     * for a reading the service would refuse.
     * @param value - the stored value.
     * @returns the filter to ask for, or `null`.
     */
    function sanitizeFilter(value) {
      if (value === null || typeof value !== 'object') return null
      const filter = { ...FILTER_DEFAULTS }
      for (const key of Object.keys(FILTER_DEFAULTS)) {
        const stored = value[key]
        if (stored === undefined) continue
        if (key === 'project') {
          if (typeof stored === 'string') filter.project = stored
          continue
        }
        if (key === 'claimable') {
          if (typeof stored === 'boolean') filter.claimable = stored
          continue
        }
        if (typeof stored !== 'string') continue
        if (FILTER_VALUES[key] !== undefined && !FILTER_VALUES[key].includes(stored)) continue
        filter[key] = stored
      }
      return filter
    }

    /**
     * Localized display text for the built-in template the Host seeds.
     *
     * The seed keeps its stored names in one language; the panel substitutes
     * display text for the built-in id only. A custom template (or an unknown
     * built-in) keeps whatever its editors stored.
     */
    const BUILTIN_TEMPLATE_TEXT = {
      'tpl-standard': {
        name: 'builtinTplStandard',
        description: 'builtinTplStandardDesc',
        nodes: {
          review: { name: 'builtinNodeReview', description: 'builtinNodeReviewDesc' },
          design: { name: 'builtinNodeDesign', description: 'builtinNodeDesignDesc' },
          build: { name: 'builtinNodeBuild', description: 'builtinNodeBuildDesc' },
          verify: { name: 'builtinNodeVerify', description: 'builtinNodeVerifyDesc' },
          release: { name: 'builtinNodeRelease', description: 'builtinNodeReleaseDesc' },
        },
      },
    }

    /** One built-in template's text block, or `undefined` for a custom template. */
    function builtinText(id) {
      return BUILTIN_TEMPLATE_TEXT[id]
    }

    /** One template record with a built-in template's display text localized. */
    function localizeTemplate(template, t) {
      const text = template === null || template === undefined ? undefined : builtinText(template.id)
      if (text === undefined || template.builtin !== true) return template
      return {
        ...template,
        name: t(text.name),
        description: t(text.description),
        nodes: (template.nodes ?? []).map(node => {
          const labels = text.nodes[node.id]
          return labels === undefined ? node : { ...node, name: t(labels.name), description: t(labels.description) }
        }),
      }
    }

    /** One requirement with its built-in template's display text localized. */
    function localizeRequirement(requirement, t) {
      const text = requirement.template === undefined ? undefined : builtinText(requirement.templateId)
      if (text === undefined || requirement.template.builtin !== true) return requirement
      const nodeWithText = node => {
        const labels = node === null || node === undefined ? undefined : text.nodes[node.id]
        return labels === undefined ? node : { ...node, name: t(labels.name) }
      }
      return {
        ...requirement,
        template: { ...requirement.template, name: t(text.name) },
        flow: Array.isArray(requirement.flow) ? requirement.flow.map(nodeWithText) : requirement.flow,
        history: Array.isArray(requirement.history)
          ? requirement.history.map(entry => {
            const from = entry.from === null || entry.from === undefined ? undefined : text.nodes[entry.from]
            const to = entry.to === undefined ? undefined : text.nodes[entry.to]
            if (from === undefined && to === undefined) return entry
            return {
              ...entry,
              fromName: from === undefined ? entry.fromName : t(from.name),
              toName: to === undefined ? entry.toName : t(to.name),
            }
          })
          : requirement.history,
        progress: requirement.progress === undefined
          ? requirement.progress
          : { ...requirement.progress, activeNode: nodeWithText(requirement.progress.activeNode) },
      }
    }

    /**
     * How long a burst of committed-change events shares one read.
     *
     * The Host pushes `changed` once per committed write, and one write burst
     * (execution sync alone) can raise many of them. Every read fetches the whole
     * snapshot, so the page waits the burst out instead of reading per event.
     */
    const CHANGED_READ_DEBOUNCE_MS = 200

    /**
     * Rows one snapshot page carries.
     *
     * A board larger than one page is read a page at a time: the list appends the
     * next page on request, and the Host's `offset`/`limit` are what make the rest
     * of the board reachable at all.
     */
    const SNAPSHOT_PAGE_SIZE = 200

    /**
     * The board controller: owns the snapshot, the SSE subscription, and every
     * call to the Host. Components receive its snapshot and callbacks and never
     * touch the network themselves.
     */
    function createBoardController() {
      const source = createSnapshotSource({
        status: 'loading',
        error: null,
        revision: 0,
        requirements: [],
        total: 0,
        templates: [],
        roles: { items: [], unregistered: [] },
        claimableIds: null,
        stats: null,
        projects: [],
        queues: [],
        filter: { session: '', owner: '', status: 'open', priority: '', query: '', role: '', kind: '', project: undefined, claimable: false, me: '' },
        connected: false,
        everConnected: false,
        auth: '',
        /** Whether one appended page is in flight, so the control can say so. */
        loadingMore: false,
        /**
         * Counts a committed change that folded an extended list back to its
         * first page; the page turns a new count into one muted note.
         */
        listReset: 0,
      })
      /** The app-level toast fact; the `shell.overlay` host owns its lifetime. */
      const toast = createSnapshotSource(null)
      let stream = null
      let stopped = false
      let everConnected = false
      let toastSeq = 0
      /** `''`, or the trust gate's refusal that stopped this page's reads. */
      let auth = ''
      /** Sequence of the newest issued read; only that read may publish. */
      let readSeq = 0
      /** The newest read's request, aborted once a newer read supersedes it. */
      let inFlight = null
      /** The pending read a burst of `changed` events shares, or `null`. */
      let changedTimer = null

      /** Merge a partial snapshot into the published one. */
      const publish = patch => source.publish({ ...source.getSnapshot(), ...patch })

      /**
       * Raise one transient message on the app-level toast host.
       *
       * The overlay entry that renders this outlives the panel, so a message
       * about an action that closed or replaced the reporting surface survives
       * the close.
       */
      const notify = (kind, text) => {
        toastSeq += 1
        toast.publish({ kind, text, at: Date.now(), seq: toastSeq })
      }

      /**
       * Ask the Host for the ids it reports as takeable.
       *
       * `claimable` is a derived field the snapshot does not carry, and the
       * eligibility rules must not be re-derived here, so the panel reads the
       * Host's own answer from the route that already applies them. The `me`
       * the caller is reading with travels too, so the badge answers the same
       * question as the pool: a session id opens the role clause, an empty `me`
       * asks for the panel's hand-off pool. `null` means "the Host did not
       * answer" and the badge is omitted rather than guessed.
       * @param me - Session whose reading is asked; `''` asks for the panel.
       * @param signal - aborts this side read together with the read it serves.
       * @returns a Set of requirement ids, or `null`.
       */
      const fetchClaimable = async (me, signal) => {
        try {
          const suffix = me === '' ? '' : `&me=${encodeURIComponent(me)}`
          const response = await fetch(`${API}/snapshot?claimable=true&limit=200${suffix}`, { headers: { accept: 'application/json' }, signal })
          const payload = await response.json().catch(() => null)
          if (refused(response, payload)) return null
          if (payload?.ok !== true) return null
          return new Set(payload.data.requirements.map(item => item.id))
        } catch (error) {
          // A badge's absence is the honest reading of a failed side read; the
          // board itself still renders from the answered snapshot.
          void error
          return null
        }
      }

      /**
       * Every requirement the board holds, unfiltered, for pin counting.
       *
       * A template's "still pinned to an old revision" count is the Host's own
       * judgment over the same set `deleteTemplate`/`pruneTemplateVersion` use
       * (every bound requirement, done and archived included), so the drawer asks
       * the requirement route for that whole set rather than re-deriving it from
       * the filtered page the reader happens to be looking at. Runs and images are
       * not needed, and the page cap is the route's own maximum.
       * @param signal - aborts this side read together with the read it serves.
       * @returns `{ items, total }`, or `null` when the Host did not answer.
       */
      const fetchPinList = async signal => {
        try {
          const response = await fetch(`${API}/snapshot?limit=200`, { headers: { accept: 'application/json' }, signal })
          const payload = await response.json().catch(() => null)
          if (refused(response, payload)) return null
          if (payload?.ok !== true) return null
          return { items: payload.data.requirements, total: payload.data.total }
        } catch (error) {
          // A missing pin count is the honest reading of a failed side read; the
          // drawer renders the template without one instead of guessing zero.
          void error
          return null
        }
      }

      /**
       * The snapshot query for one filter reading.
       *
       * The project filter has three states and its empty one is a filter of its
       * own — the requirements belonging to no project — so it travels even when
       * empty instead of being dropped like a blank text filter. `limit` is the
       * page size; an appended page adds its own `offset`.
       * @param filter - the filter reading to ask for.
       * @returns the query carrying it.
       */
      const snapshotQuery = filter => {
        const query = new URLSearchParams()
        for (const key of HOST_FILTER_KEYS) {
          const value = filter[key]
          if (key === 'project') {
            if (value !== undefined && value !== null) query.set(key, String(value))
            continue
          }
          if (value === '' || value === false || value === undefined || value === null) continue
          query.set(key, String(value))
        }
        query.set('limit', String(SNAPSHOT_PAGE_SIZE))
        return query
      }

      /**
       * Read the board, honouring the current filter.
       *
       * Answers can arrive in any order, so only the newest issued read may
       * publish: a slow answer that lands after a newer one would otherwise put
       * the panel back on an older revision while the data itself is correct.
       * Each read also aborts the read it supersedes, whose work is already
       * redundant. A filter change is a read like any other and wins the same
       * way, so a switch still takes effect when its answer carries the revision
       * the page already shows — the guard is "newest read", never "newest
       * revision".
       * @param options - `notifyReset` marks the read as one a committed change
       * triggered, so folding an extended list back to page one can say so.
       */
      const refresh = async (options = {}) => {
        // A refused page stops reading entirely: the gate answers every route
        // the same way, so a read now would only repeat the refusal.
        if (auth !== '') return
        readSeq += 1
        const seq = readSeq
        inFlight?.abort()
        const request = new AbortController()
        inFlight = request
        /** Whether a newer read, or this page's stop, owns this read's answer. */
        const superseded = () => seq !== readSeq || request.signal.aborted
        const filter = source.getSnapshot().filter
        const extended = source.getSnapshot().requirements.length > SNAPSHOT_PAGE_SIZE
        const query = snapshotQuery(filter)
        // `me` is the session both eligibility answers are asked for — the
        // hand-off pool reading *and* `advanceable` — so it travels on its own.
        try {
          const response = await fetch(`${API}/snapshot?${query.toString()}`, { headers: { accept: 'application/json' }, signal: request.signal })
          const payload = await response.json().catch(() => null)
          if (refused(response, payload)) return
          if (payload === null || payload.ok !== true) {
            throw Object.assign(new Error(payload?.error?.message ?? `HTTP ${response.status}`), { code: payload?.error?.code })
          }
          const requirements = payload.data.requirements
          const claimableIds = filter.claimable === true
            ? new Set(requirements.map(item => item.id))
            : await fetchClaimable(filter.me, request.signal)
          if (superseded()) return
          publish({
            status: 'ready',
            error: null,
            revision: payload.data.revision,
            requirements,
            total: payload.data.total,
            templates: payload.data.templates,
            roles: payload.data.roles ?? { items: [], unregistered: [] },
            claimableIds,
            stats: payload.data.stats,
            // The board's project vocabulary, read across every requirement rather
            // than the filtered page: a filter that narrowed the list must not also
            // take away the names needed to leave it. A Host that does not report
            // it falls back to the names on the page.
            projects: Array.isArray(payload.data.projects) ? payload.data.projects : [],
            // Every session's queue in the order the service will take it. The
            // panel renders positions from this projection instead of ordering
            // reservations itself, so a receipt's `head` and the queue view name
            // the same item.
            queues: Array.isArray(payload.data.queues) ? payload.data.queues : [],
          })
          // A committed change re-reads page one. A reader who had appended
          // pages is now looking at a folded list, so the page says so once.
          if (options.notifyReset === true && extended && requirements.length <= SNAPSHOT_PAGE_SIZE) {
            publish({ listReset: (source.getSnapshot().listReset ?? 0) + 1 })
          }
        } catch (error) {
          // A failed read keeps the last good payload on screen: a transient
          // failure must not blank a board the user is working in. The error
          // object is kept raw so the banner is translated at render time, when
          // the active locale is known.
          // A superseded read is not the newest reading of the board, so its
          // failure is dropped with its answer instead of reported.
          if (superseded()) return
          publish({ status: 'ready', error })
        } finally {
          if (inFlight === request) inFlight = null
        }
      }

      /**
       * Append the next page of the board.
       *
       * The list reads page by page so a board larger than one page is reachable
       * in the panel; the filter is the page's own reading, and a filter change
       * while the page is in flight discards the answer because it belongs to a
       * reading that is no longer on screen.
       */
      const loadMore = async () => {
        const current = source.getSnapshot()
        if (current.status !== 'ready' || current.loadingMore === true || auth !== '') return
        if (current.requirements.length >= current.total) return
        const filter = current.filter
        const query = snapshotQuery(filter)
        query.set('offset', String(current.requirements.length))
        publish({ loadingMore: true })
        try {
          const response = await fetch(`${API}/snapshot?${query.toString()}`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => null)
          if (refused(response, payload)) return
          if (payload === null || payload.ok !== true) {
            throw Object.assign(new Error(payload?.error?.message ?? `HTTP ${response.status}`), { code: payload?.error?.code })
          }
          const now = source.getSnapshot()
          if (now.filter !== filter) {
            publish({ loadingMore: false })
            return
          }
          const known = new Set(now.requirements.map(row => row.id))
          const page = Array.isArray(payload.data.requirements) ? payload.data.requirements : []
          publish({
            requirements: [...now.requirements, ...page.filter(row => !known.has(row.id))],
            total: typeof payload.data.total === 'number' ? payload.data.total : now.total,
            loadingMore: false,
          })
        } catch (error) {
          publish({ loadingMore: false, error })
        }
      }

      /**
       * Treat the platform trust gate's refusal as terminal for this page.
       *
       * Every route is fenced the same way, so an expired cookie fails the
       * snapshot, the stream, and every command alike. Retrying on a timer would
       * hammer the gate while the reader waits for a board that cannot arrive;
       * the panel says what happened and waits for the page to be opened again.
       * @param kind - `expired` for a missing or stale credential, `cross-origin`
       * for a request the Host does not accept from this origin.
       */
      const stopAuth = kind => {
        stream?.close()
        stream = null
        if (auth === kind) return
        auth = kind
        publish({ auth: kind, status: 'ready', connected: false, error: null })
      }

      /**
       * Whether a response is the trust gate's refusal rather than a failure.
       * @returns true when the read was refused and the panel stopped retrying.
       */
      const refused = (response, payload) => {
        const code = payload?.error?.code
        const expired = response?.status === 401 || code === 'unauthenticated'
        const crossOrigin = response?.status === 403 || code === 'forbidden-origin'
        if (!expired && !crossOrigin) return false
        stopAuth(expired ? 'expired' : 'cross-origin')
        return true
      }

      /**
       * Send one request to a board route and unwrap its `{ ok, data }` envelope.
       *
       * The platform trust gate fences every route the same way, so a refusal is
       * terminal for this page wherever it arrives: stop the reads here rather
       * than only at the caller, which would otherwise keep asking a board it
       * cannot reach. The caller still reports the failure on its own surface.
       * @param path - route under the board prefix, query string included.
       * @param init - `fetch` options; the caller owns the body and headers.
       * @returns the response's `data`.
       */
      const request = async (path, init) => {
        let response
        try {
          response = await fetch(`${API}${path}`, init)
        } catch (error) {
          throw Object.assign(new Error(String(error?.message ?? error)), { code: 'network' })
        }
        const body = await response.json().catch(() => null)
        if (body === null || body.ok !== true) {
          const code = body?.error?.code ?? 'internal'
          if (code === 'unauthenticated' || response.status === 401) stopAuth('expired')
          else if (code === 'forbidden-origin' || response.status === 403) stopAuth('cross-origin')
          throw Object.assign(new Error(body?.error?.message ?? `HTTP ${response.status}`), {
            code,
            details: body?.error?.details,
          })
        }
        return body.data
      }

      /** Send one command to the Host and surface its failure. */
      const command = (action, payload) => request('/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      })

      /**
       * Store one pasted image and return the reference a command names.
       *
       * The body is the image itself rather than JSON, so it carries the media
       * type it declares and the original filename travels as `?name=`.
       * @param file - the image the reader pasted or picked.
       * @returns the stored image's reference, whose `id` goes into `images`.
       */
      const uploadImage = async file => {
        const name = typeof file?.name === 'string' && file.name !== '' ? file.name : 'image'
        const data = await request(`/image?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'content-type': file.type },
          body: file,
        })
        if (imageId(data?.image) === undefined) {
          throw Object.assign(new Error('the image route answered without an image reference'), { code: 'internal' })
        }
        return data.image
      }

      /** Replace the filter and read again. */
      const setFilter = patch => {
        publish({ filter: { ...source.getSnapshot().filter, ...patch } })
        void refresh()
      }

      /**
       * Queue the one read a burst of committed changes shares.
       *
       * The delay is trailing, so the read happens after the burst rather than at
       * its first event and a burst of writes costs one whole-snapshot read
       * instead of one per event. A read the reader triggers (a command, a filter
       * switch, the refresh control) is never queued; those read at once.
       */
      const scheduleChangedRead = () => {
        if (stopped || auth !== '') return
        if (changedTimer !== null) clearTimeout(changedTimer)
        changedTimer = setTimeout(() => {
          changedTimer = null
          void refresh({ notifyReset: true })
        }, CHANGED_READ_DEBOUNCE_MS)
      }

      /**
       * Open the SSE stream; the Host pushes one event per committed change.
       *
       * A stream that drops may have missed changes while it was down, so the
       * first `ready` after a drop refetches the whole snapshot rather than
       * trusting what the page kept. The initial connection does not, because
       * `start` already read once.
       */
      const connect = () => {
        if (stopped || auth !== '' || typeof EventSource === 'undefined') return
        stream = new EventSource(`${API}/events`)
        stream.addEventListener('ready', () => {
          const reconnected = everConnected
          everConnected = true
          publish({ connected: true, everConnected: true })
          if (reconnected) void refresh()
        })
        stream.addEventListener('changed', () => {
          everConnected = true
          publish({ connected: true, everConnected: true })
          scheduleChangedRead()
        })
        stream.addEventListener('error', () => publish({ connected: false }))
      }

      return {
        source,
        toast,
        face: {
          refresh,
          loadMore,
          /**
           * Read once more after the trust gate's refusal.
           *
           * This is a single, reader-triggered read, not a retry: the page kept
           * its connection closed precisely so that nothing repeats the refusal
           * on its own. Reopening the stream here lets a page whose credential
           * came back resume live updates.
           */
          recheck: () => {
            auth = ''
            // Clear the notice before reading; a re-check that is refused again
            // republishes the refusal through `stopAuth`.
            publish({ auth: '' })
            connect()
            return refresh()
          },
          setFilter,
          fetchPinList,
          command: async (action, payload) => {
            const data = await command(action, payload)
            await refresh()
            return data
          },
          uploadImage,
          notify,
          dismissToast: () => toast.publish(null),
          errorText: (error, t) => describeError(error, t),
        },
        start() {
          void refresh()
          connect()
          const onVisible = () => {
            if (document.visibilityState === 'visible') void refresh()
          }
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            stopped = true
            if (changedTimer !== null) clearTimeout(changedTimer)
            changedTimer = null
            document.removeEventListener('visibilitychange', onVisible)
            stream?.close()
            stream = null
          }
        },
      }
    }

    /** Shared stylesheet rendered as a React element so unmounting removes it. */
    const CSS = `
/* Requirement board panel stylesheet.
 *
 * Visual language: the kanban-redesign concept sheet, mapped onto platform
 * tokens. Every colour resolves through a --dsw-* alias or through one of the
 * local variables registered below; see UI-REDESIGN.md §2 for the mapping and
 * §5 for the recorded deviations. The two local families exist because the
 * platform has no orange accent (--dsw-alias-brand-primary is monochrome) and
 * no violet, and the concept's identity is exactly those two hues.
 */
.rb-root {
  --rb-accent:#f06423; --rb-accent-strong:#ff7733;
  --rb-accent-soft:rgba(240,100,35,.12); --rb-accent-line:rgba(240,100,35,.35);
  --rb-accent-fill:#c2410c; --rb-accent-fill-strong:#9a3412;
  --rb-on-accent:#fff;
  /* v3 text-grade inks (V3-11): the dark arm's semantic text keeps the icon-grade
   * values, which measure >=4.5:1 on the layer surfaces they sit on. */
  --rb-ink-ok:var(--dsw-alias-state-success-primary); --rb-ink-warn:var(--dsw-alias-state-warn-primary);
  --rb-ink-err:var(--dsw-alias-state-error-primary); --rb-ink-info:var(--dsw-alias-state-business-primary);
  --rb-ink-vio:var(--rb-violet); --rb-ink-accent:var(--rb-accent);
  --rb-violet:#9b8cf2; --rb-violet-soft:rgba(155,140,242,.12);
  --rb-tint-success:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
  --rb-tint-warn:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  --rb-tint-error:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  --rb-tint-info:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  --rb-num:var(--dsw-font-family-brand); --rb-mono:var(--ds-font-family-code);
  display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base);
  font-size:13px; line-height:1.55;
}
/* The concept sheet defines one dark theme. The platform requires both, so the
 * two accent families get a light arm with contrast that survives on white:
 * #f06423 measures 3.20:1 against white, #c2410c measures 5.18:1. */
body:not([data-ds-dark-theme]) .rb-root {
  --rb-accent:#c2410c; --rb-accent-strong:#9a3412;
  --rb-accent-soft:rgba(194,65,12,.10); --rb-accent-line:rgba(194,65,12,.35);
  --rb-accent-fill:#c2410c; --rb-accent-fill-strong:#9a3412;
  --rb-on-accent:#fff;
  /* v3 text-grade inks (V3-11): the platform's state hues are icon-grade; as small
   * text on their own 10% tints over white they measure 1.96-4.4:1. The text grade
   * steps one rung deeper and measures >=4.5:1 on each tint (ok 5.7 / warn 5.6 /
   * err 6.5 / info 6.9 / vio 6.4 / accent 7.0). Icons and graphics keep the icon
   * grade above; only color declarations read these. */
  --rb-ink-ok:#166534; --rb-ink-warn:#92400e; --rb-ink-err:#991b1b;
  --rb-ink-info:#1e40af; --rb-ink-vio:#5b21b6; --rb-ink-accent:#9a3412;
  --rb-violet:#6d5bd0; --rb-violet-soft:rgba(109,91,208,.12);
}
/* The platform portals a Dialog outside .rb-root, so a custom property declared
 * on the panel root does not reach anything inside one, and a var() that
 * resolves to nothing leaves the declaration invalid at computed-value time --
 * which reads as currentColor for a border, as transparent for a background, and
 * as the inherited family for a font. The portal-reachable family is therefore
 * re-declared on the theme carrier, the nearest ancestor every portaled surface
 * inherits from: the accent triple, the error tint, the primary stroke an earlier
 * round added, the numeric family, and (v3) the two text-grade inks a portaled
 * toast or role-form dialog paints. Each arm repeats the value .rb-root
 * already holds, so nothing inside the panel changes -- the panel root's own
 * declaration still wins on its own subtree, because an element's own custom
 * property beats the one it would inherit -- and nothing is declared on :root,
 * which would leak these variables into every other panel and into the shell.
 * The error tint and the numeric family are theme-invariant expressions, and both
 * are restated in both carriers so the rule reads the same for every carried
 * variable: one declaration per theme arm. DESIGN.md section 16 records what a
 * portaled surface renders for each of them.
 *
 * Only a variable a portaled surface consumes is carried: a declaration nothing
 * outside the panel can read buys no rendering and costs a second place to keep
 * in step. The registry variables left out of both arms, with the evidence for
 * each, are listed in DESIGN.md section 16.5.
 */
body {
  --rb-accent:#f06423; --rb-accent-soft:rgba(240,100,35,.12); --rb-accent-line:rgba(240,100,35,.35);
  --rb-tint-error:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  --rb-accent-strong:#ff7733;
  /* v3: the two text-grade inks a portaled toast or role-form dialog paints. */
  --rb-ink-err:var(--dsw-alias-state-error-primary); --rb-ink-warn:var(--dsw-alias-state-warn-primary);
  --rb-num:var(--dsw-font-family-brand);
}
body:not([data-ds-dark-theme]) {
  --rb-accent:#c2410c; --rb-accent-soft:rgba(194,65,12,.10); --rb-accent-line:rgba(194,65,12,.35);
  --rb-tint-error:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  --rb-accent-strong:#9a3412;
  --rb-ink-err:#991b1b; --rb-ink-warn:#92400e;
  --rb-num:var(--dsw-font-family-brand);
}

/* ---------- Top bar ---------- */
.rb-header { display:flex; align-items:center; gap:12px; height:64px; padding:0 18px; flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1); }
.rb-logo { flex:none; width:30px; height:30px; border-radius:var(--dsw-radius-sm);
  display:grid; place-items:center; color:var(--rb-on-accent);
  background:linear-gradient(150deg, var(--rb-accent), var(--rb-accent-strong));
  box-shadow:0 2px 10px -2px var(--rb-accent-line); }
.rb-heading { display:flex; flex-direction:column; min-width:0; gap:1px; }
.rb-title { font-size:16px; font-weight:600; letter-spacing:.01em; }
.rb-sub { display:flex; align-items:center; gap:6px; font-size:12px;
  color:var(--dsw-alias-label-tertiary); }
.rb-live { flex:none; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary);
  box-shadow:0 0 6px var(--dsw-alias-state-success-primary); animation:rb-pulse 2.4s infinite; }
@keyframes rb-pulse { 50% { opacity:.4; } }
.rb-grow { flex:1 1 auto; }
/* The top bar is the panel's identity surface, so its buttons take the concept
 * frame instead of the platform ghost skin. Repeated class names win on
 * specificity, not on stylesheet order, matching the existing danger-button
 * override. This arm keeps its pre-change stroke (l2) as the regression
 * baseline; only the primary button in the header changes, and it changes
 * because the primary arm below is later and now equally specific. */
.rb-header .rb-btn.rb-btn { height:32px; padding:0 13px; font-size:13px; font-weight:500;
  border-radius:var(--dsw-radius-sm); border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.rb-header .rb-btn.rb-btn:hover { color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-3); border-color:var(--dsw-alias-border-l3); }
/* Every panel Button carries the rb-btn marker class on the element itself:
 * the platform primitive's class names are hashed, and a dialog portals outside
 * .rb-root, so neither the platform's names nor a panel subtree scope can be
 * relied on. The concept sheet's 1px frame is the design baseline the previous
 * visual pass missed, and --dsw-alias-border-l3 is the strongest neutral stroke
 * alias the platform exposes. The doubled class name raises specificity above
 * the primitive instead of depending on load order. */
.rb-btn.rb-btn { border:1px solid var(--dsw-alias-border-l3); }
/* The four states restate the stroke rather than clearing it. focus-visible
 * declares border-color only: the platform owns the focus ring
 * (packages/client/ui-theme/src/styles/focus.css:10-13), and a pointer-modality
 * focus is made transparent there on purpose. disabled compensates the
 * platform's :disabled opacity .4 with an opaque neutral, so the stroke
 * survives the composite instead of fading into the fill. */
.rb-btn.rb-btn:hover { border-color:var(--dsw-alias-border-l3); }
.rb-btn.rb-btn:active { border-color:var(--dsw-alias-border-l3); }
.rb-btn.rb-btn:focus-visible { border-color:var(--dsw-alias-border-l3); }
.rb-btn.rb-btn:disabled { border-color:var(--dsw-alias-label-tertiary); }
/* The detail row already carried a 1px l2 stroke before this change, so its arm
 * is restated at equal specificity here to keep it: these are compact inline
 * actions whose frame was a deliberate l2, and re-tinting them to the neutral
 * l3 would be a visible change nothing asked for. */
.rb-detail-actions .rb-btn.rb-btn { border:1px solid var(--dsw-alias-border-l2); }
/* Geometry (see the geometry note): the platform's box-sizing:border-box
 * absorbs a 1px border only when the width is definite, and these controls are
 * auto-width, so the stroke would add 2px to the outer box. Each marked arm
 * takes the border's 1px back out of its horizontal padding, which is why the
 * values sit one pixel below the platform base. A control that already carried
 * a stroke (the top bar's buttons, the detail row's, the outline variant's
 * 0.5px) is deliberately not marked: for it the border was already inside the
 * box and padding back would shrink it by the same 2px. */
.rb-btn-pad.rb-btn-pad { padding:0 13px; }
.rb-btn-pad.rb-btn-pad.rb-btn-sm.rb-btn-sm { padding:0 9px; }
/* A primary-variant button that keeps the platform's fill has to take the
 * primary arm's stroke rather than the neutral one: that fill is near-black in
 * the light theme and near-white in the dark one, so an l3 stroke composites
 * into it and reads as no stroke at all. This arm carries the stroke only --
 * fill, height, padding, and weight stay the platform's -- which is why it is a
 * separate marker from rb-btn-primary, whose rule also restyles the fill. */
.rb-btn-primary-stroke.rb-btn-primary-stroke { border-color:var(--rb-accent-strong); }
.rb-btn-primary-stroke.rb-btn-primary-stroke:hover { border-color:var(--rb-accent-strong); }
.rb-btn-primary-stroke.rb-btn-primary-stroke:active { border-color:var(--rb-accent-strong); }
.rb-btn-primary-stroke.rb-btn-primary-stroke:focus-visible { border-color:var(--rb-accent-strong); }
.rb-btn-primary-stroke.rb-btn-primary-stroke:disabled { border-color:var(--dsw-alias-label-tertiary); }
/* Primary and danger restate the stroke at three repeated class names, (0,3,0),
 * so they beat the baseline rule without depending on order. At (0,2,0) they
 * would tie with it, and a border shorthand against a bare border-color
 * resolves by load order -- exactly the ambiguity this form removes. */
.rb-btn-primary.rb-btn-primary.rb-btn-primary { height:32px; padding:0 13px; font-size:13px; font-weight:600;
  border-radius:var(--dsw-radius-sm); border:1px solid var(--rb-accent-strong); color:var(--rb-on-accent);
  background:var(--rb-accent-fill); box-shadow:0 2px 10px -2px var(--rb-accent-line); }
.rb-btn-primary.rb-btn-primary.rb-btn-primary:hover { background:var(--rb-accent-fill-strong);
  color:var(--rb-on-accent); border-color:var(--rb-accent-strong); }
.rb-btn-primary.rb-btn-primary.rb-btn-primary:active { border-color:var(--rb-accent-strong); }
.rb-btn-primary.rb-btn-primary.rb-btn-primary:focus-visible { border-color:var(--rb-accent-strong); }
.rb-btn-primary.rb-btn-primary.rb-btn-primary:disabled { border-color:var(--dsw-alias-label-tertiary); }
.rb-btn-danger.rb-btn-danger.rb-btn-danger { border:1px solid var(--dsw-alias-state-error-primary);
  color:var(--rb-ink-err); }
.rb-btn-danger.rb-btn-danger.rb-btn-danger:hover { border-color:var(--dsw-alias-state-error-primary); }
.rb-btn-danger.rb-btn-danger.rb-btn-danger:active { border-color:var(--dsw-alias-state-error-primary); }
.rb-btn-danger.rb-btn-danger.rb-btn-danger:focus-visible { border-color:var(--dsw-alias-state-error-primary); }
.rb-btn-danger.rb-btn-danger.rb-btn-danger:disabled { border-color:var(--dsw-alias-label-tertiary); }
/* The top bar's primary button is the one marked site whose pre-change padding
 * came from the panel's own primary rule (13px) rather than the platform base
 * (14px), so its compensation is 12px, not 13px. It is not pad-marked because
 * the top bar arm below would then have to be fought; this rule outranks it. */
.rb-header .rb-btn-primary.rb-btn-primary.rb-btn-primary { padding:0 12px; }

/* ---------- View switcher ---------- */
.rb-views { display:flex; align-items:center; gap:12px; padding:14px 18px 0; flex:none; flex-wrap:wrap; }
.rb-segmented { display:inline-flex; align-items:center; gap:2px; padding:3px;
  border-radius:var(--dsw-radius-sm); border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); }
.rb-views .rb-seg.rb-seg { height:28px; padding:0 16px; border:0; border-radius:var(--dsw-radius-sm);
  background:transparent; color:var(--dsw-alias-label-tertiary); font-size:13px; font-weight:500; }
.rb-views .rb-seg.rb-seg:hover { color:var(--dsw-alias-label-secondary); background:transparent; }
.rb-views .rb-seg.rb-seg-on { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-3);
  box-shadow:var(--dsw-shadow-lv1), inset 0 0 0 1px var(--dsw-alias-border-l2); }

/* ---------- KPI band ---------- */
/* The concept's band, as its own seven columns: hero, five readings, alert.
 * Below the panel's own breakpoint the same cells wrap instead of overflowing,
 * because the shell can narrow this column at any time. */
.rb-stats { display:grid; grid-template-columns:300px repeat(5, minmax(0,1fr)) 220px; gap:10px;
  padding:16px 18px 0; flex:none; }
.rb-stat { box-sizing:border-box; min-width:0; padding:12px 14px; border-radius:var(--dsw-radius-md);
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
  transition:border-color .18s var(--ds-ease-out); }
.rb-stat:hover { border-color:var(--dsw-alias-border-l2); }
.rb-stat-label { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:500;
  color:var(--dsw-alias-label-tertiary); }
.rb-stat-value { font-family:var(--rb-num); font-size:26px; font-weight:500; line-height:1.2;
  margin-top:4px; font-variant-numeric:tabular-nums; }
.rb-stat-value-dim { color:var(--dsw-alias-label-tertiary); }
.rb-stat-hero { flex:0 0 300px; display:flex; align-items:center; gap:14px; }
.rb-ring { position:relative; flex:none; width:56px; height:56px; }
.rb-ring svg { display:block; transform:rotate(-90deg); }
.rb-ring-track { fill:none; stroke:var(--dsw-alias-border-l2); stroke-width:4; }
.rb-ring-fill { fill:none; stroke:var(--rb-accent); stroke-width:4; stroke-linecap:round;
  transition:stroke-dasharray .3s var(--ds-ease-out); }
.rb-ring-pct { position:absolute; inset:0; display:grid; place-items:center;
  font-family:var(--rb-num); font-size:14px; font-weight:500; color:var(--rb-accent);
  font-variant-numeric:tabular-nums; }
.rb-hero-frac { font-size:12px; color:var(--dsw-alias-label-tertiary); margin-top:2px; }
.rb-hero-frac b { font-family:var(--rb-num); font-weight:500; color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums; }
.rb-stat-alert { flex:0 1 200px; cursor:default; text-align:left; font:inherit;
  border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent);
  background:linear-gradient(180deg, var(--rb-tint-warn), var(--dsw-alias-bg-layer-1)); }
.rb-stat-alert .rb-stat-label, .rb-stat-alert .rb-stat-value { color:var(--rb-ink-warn); }
.rb-stat-alert .rb-go { font-size:11px; color:var(--dsw-alias-label-tertiary); margin-top:2px; }
.rb-submetrics { display:flex; flex-wrap:wrap; gap:6px 20px; padding:10px 22px 14px; flex:none;
  font-size:12px; color:var(--dsw-alias-label-tertiary); }
/* One reading of the strip: its label and its value, kept as two nodes. */
.rb-submetric { display:inline-flex; align-items:baseline; gap:6px; }
.rb-kpi { flex:none; }
.rb-stat-alert-clear { border-color:var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); }
.rb-stat-alert-clear .rb-stat-label, .rb-stat-alert-clear .rb-stat-value {
  color:var(--dsw-alias-label-tertiary); }
.rb-hero-text { min-width:0; }
.rb-submetrics .rb-role-tally { flex:1 1 100%; }
.rb-submetrics b { font-family:var(--rb-num); font-weight:500; color:var(--dsw-alias-label-secondary);
  margin-left:4px; font-variant-numeric:tabular-nums; }

/* ---------- Filters ---------- */
.rb-filters { display:flex; flex-direction:column; gap:8px; padding:12px 18px; flex:none;
  align-items:stretch; border-top:1px solid var(--dsw-alias-border-l1); }
/* The switch, the summary of what is in force, and the row count: one line, and
 * it stays one line however many filters are on — the chips scroll sideways
 * rather than wrap, so folding the area really gives the board its space back. */
.rb-filter-bar { display:flex; align-items:center; gap:8px; min-width:0; }
.rb-filter-chips { display:flex; align-items:center; gap:6px; flex-wrap:nowrap; overflow-x:auto;
  min-width:0; max-width:100%; }
.rb-filter-controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.rb-filter { display:inline-flex; align-items:center; gap:4px; }
.rb-filters .rb-chip.rb-chip { height:26px; padding:0 11px; border-radius:999px; font-size:12px;
  border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); }
.rb-filters .rb-chip.rb-chip:hover { border-color:var(--dsw-alias-border-l3); color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-1); }
.rb-filters .rb-chip.rb-chip-on { border-color:var(--rb-accent-line); background:var(--rb-accent-soft);
  color:var(--rb-accent); box-shadow:none; }
.rb-chip-n { font-family:var(--rb-num); font-size:11px; color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums; }
.rb-filters .rb-chip.rb-chip-on .rb-chip-n { color:var(--rb-accent); opacity:.8; }
.rb-clear { margin-left:auto; border:0; background:none; font-size:12px; cursor:pointer;
  color:var(--dsw-alias-label-tertiary); padding:0 4px; }
.rb-clear:hover { color:var(--rb-accent); }
.rb-chip-label { max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rb-live-off { background:var(--dsw-alias-label-tertiary); box-shadow:none; animation:none; }
.rb-count-chip { font-family:var(--rb-num); font-size:11px; font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary); }

/* ---------- Structured options ---------- */
/* The create dialog's question editor and the detail's answer block. Both read
 * as cards: one card per question and one row per choice, so a question with
 * eight choices stays one block instead of flooding the surface. */
.rb-options-editor { display:flex; flex-direction:column; gap:8px; margin-top:4px; }
.rb-option-hint { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.rb-choice-name { flex:1 1 140px; min-width:0; display:flex; }
.rb-choice-name input { width:100%; }
.rb-choice-detail { flex:1 1 180px; min-width:0; display:flex; }
.rb-choice-detail input { width:100%; }
.rb-choice-rec { flex:none; font-size:12px; }
.rb-question { display:flex; flex-direction:column; gap:6px; margin-top:8px; }
.rb-question-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.rb-question-prompt { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
/* The selectable choice. The chosen one reuses the summary chip's accent pair,
 * which is how the panel already says "this is the one in force". */
.rb-choice { display:flex; align-items:flex-start; gap:8px; padding:6px 8px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md); cursor:pointer; }
.rb-choice-on { border-color:var(--rb-accent-line); background:var(--rb-accent-soft); }
.rb-choice input[type="radio"] { flex:none; margin-top:2px; }
.rb-choice-body { display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
.rb-choice-text { font-size:13px; }
.rb-choice-cost { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.rb-choice-note { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.rb-answer-form { display:flex; flex-direction:column; gap:8px; align-items:flex-start; margin-top:10px; }

/* Native select, textarea, and the project input keep their own element,
 * aligned to the Input primitive's frame so a field looks the same whichever
 * element draws it. The project input is a plain element because it carries a
 * suggestion list the primitive does not forward. */
.rb-select, .rb-textarea, .rb-input { font:inherit; font-size:14px; line-height:22px; color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-1); border:.5px solid var(--dsw-alias-border-l4);
  border-radius:var(--dsw-radius-md); padding:0 8px; height:32px; min-width:0; }
.rb-select:focus, .rb-textarea:focus, .rb-input:focus { border-color:var(--dsw-alias-state-business-primary); outline:none; }
.rb-select::placeholder, .rb-textarea::placeholder, .rb-input::placeholder { color:var(--dsw-alias-label-dimmed); }
.rb-textarea { width:100%; min-height:64px; height:auto; padding:6px 8px; resize:vertical; box-sizing:border-box; }
.rb-input { width:100%; box-sizing:border-box; }

/* ---------- Two-column body ---------- */
.rb-body { display:flex; gap:16px; flex:1 1 auto; min-height:0; padding:14px 18px 18px; }
.rb-list { width:330px; flex:none; overflow:auto; min-height:0; display:flex; flex-direction:column; gap:8px; }
.rb-detail { flex:1 1 auto; overflow:auto; min-width:0; padding:22px 26px 26px; }
.rb-detail-top { display:flex; align-items:flex-start; gap:12px; margin-bottom:6px; }
.rb-detail-head { display:flex; align-items:center; gap:10px 12px; flex-wrap:wrap; min-width:0; }
.rb-detail-actions { margin-left:auto; display:flex; gap:6px; flex:none; flex-wrap:wrap; justify-content:flex-end; }
.rb-detail-actions button { height:28px; padding:0 11px; font-size:12px; border-radius:var(--dsw-radius-sm);
  border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-secondary); }
.rb-detail-actions button:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2);
  border-color:var(--dsw-alias-border-l3); }
.rb-detail-actions .rb-btn-danger { color:var(--rb-ink-err);
  border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent); }
.rb-detail .rb-title { font-size:19px; font-weight:600; line-height:1.45; letter-spacing:.01em; }
.rb-badge-group { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; flex:none; padding-top:3px; }

/* ---------- Requirement cards ---------- */
.rb-card { display:block; width:100%; text-align:left; appearance:none; font:inherit; cursor:pointer;
  padding:12px; border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); color:inherit; transition:border-color .16s var(--ds-ease-out); }
.rb-card:hover { border-color:var(--dsw-alias-border-l2); }
.rb-card-selected { border-color:var(--rb-accent-line); background:var(--dsw-alias-bg-layer-2);
  box-shadow:inset 2px 0 0 var(--rb-accent); }
.rb-card-title { font-weight:500; margin-bottom:6px; overflow-wrap:anywhere; }
.rb-card-meta { font-size:11px; color:var(--dsw-alias-label-tertiary); display:flex; gap:6px; flex-wrap:wrap; align-items:center; }

/* ---------- Queue panel ---------- */
.rb-panel { border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md);
  padding:14px 16px; background:var(--dsw-alias-bg-layer-1); }
.rb-panel-head { display:flex; align-items:center; gap:8px; padding:14px 16px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1); }
.rb-panel-head h2 { font-size:13px; font-weight:600; }
.rb-count { font-family:var(--rb-num); font-size:11px; font-weight:500; font-variant-numeric:tabular-nums;
  color:var(--rb-ink-vio); background:var(--rb-violet-soft); border-radius:999px; padding:1px 8px; }
.rb-queue { display:flex; flex-direction:column; gap:8px; overflow:auto; min-height:0; }
.rb-queue-note { font-size:12px; line-height:1.7; padding:10px 12px; border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-2); border-left:2px solid var(--rb-violet);
  color:var(--dsw-alias-label-tertiary); }
.rb-queue-group { display:flex; flex-direction:column; gap:6px; padding:12px;
  border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2); }
.rb-queue-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px; }
.rb-queue-session { font-size:13px; font-weight:500; }
.rb-queue-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:var(--dsw-radius-sm);
  flex-wrap:wrap; row-gap:6px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.rb-queue-title { flex:1 1 160px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rb-queue-row > *:not(.rb-queue-title) { flex-shrink:0; }
.rb-queue-row .rb-btn { white-space:nowrap; }
.rb-def-row { display:flex; gap:10px; padding:7px 2px; font-size:12.5px;
  border-bottom:1px dashed var(--dsw-alias-border-l1); }
.rb-def-row:last-child { border-bottom:0; }
.rb-def-row dt { flex:none; width:76px; color:var(--dsw-alias-label-tertiary); }
.rb-def-row dd { margin:0; color:var(--dsw-alias-label-secondary); }
.rb-role-tally { display:flex; align-items:center; gap:6px; flex-wrap:wrap; width:100%; }

/* ---------- Section headers, folding, prose ---------- */
.rb-section { margin-bottom:16px; }
.rb-section-title { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600;
  color:var(--dsw-alias-label-primary); margin-bottom:10px; text-transform:none; letter-spacing:0; }
.rb-section-title::before { content:""; flex:none; width:3px; height:13px; border-radius:2px;
  background:var(--rb-accent); }
.rb-en { font-family:var(--rb-num); font-size:10px; font-weight:500; letter-spacing:.06em;
  text-transform:uppercase; color:var(--dsw-alias-label-tertiary); }
.rb-prose { font-size:13px; color:var(--dsw-alias-label-secondary); line-height:1.85;
  margin:0 0 4px; overflow-wrap:anywhere; }
details.rb-fold { border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1); margin-bottom:16px; overflow:hidden; }
details.rb-fold > summary.rb-fold-summary { cursor:pointer; list-style:none; display:flex; align-items:center;
  gap:8px; padding:10px 14px; font-size:13px; font-weight:500; transition:background .15s var(--ds-ease-out); }
details.rb-fold > summary.rb-fold-summary::-webkit-details-marker { display:none; }
details.rb-fold > summary.rb-fold-summary:hover { background:var(--dsw-alias-bg-layer-2); }
details.rb-fold > summary.rb-fold-summary::before { content:""; flex:none; width:3px; height:13px;
  border-radius:2px; background:var(--rb-accent); }
.rb-caret { margin-left:auto; color:var(--dsw-alias-label-tertiary); font-size:11px;
  transition:transform .2s var(--ds-ease-out); }
details.rb-fold[open] > summary.rb-fold-summary .rb-caret { transform:rotate(90deg); }
.rb-fold-body { padding:4px 16px 14px 16px; }
/* ---------- Meta grid ---------- */
.rb-meta-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:1px;
  background:var(--dsw-alias-border-l1); border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-md); overflow:hidden; margin-bottom:22px; }
.rb-meta-cell { background:var(--dsw-alias-bg-layer-1); padding:10px 14px; min-width:0; }
.rb-meta-k { font-size:11px; color:var(--dsw-alias-label-tertiary); margin-bottom:2px; }
.rb-meta-v { font-size:12.5px; color:var(--dsw-alias-label-primary); font-weight:500;
  overflow-wrap:anywhere; }
.rb-meta-v-mono { font-family:var(--rb-mono); font-size:11px; font-weight:400;
  color:var(--dsw-alias-label-secondary); }
.rb-meta-v-hi { color:var(--rb-ink-warn); }
.rb-meta-v-num { font-family:var(--rb-num); font-variant-numeric:tabular-nums; }

/* ---------- State chips, reserve banner ---------- */

/* ---------- Gate rows and key/value grids ---------- */
.rb-gate { display:grid; gap:8px; }
.rb-gate-row { display:flex; align-items:baseline; gap:14px; padding:10px 14px;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-md); font-size:12.5px; }
.rb-gk { flex:none; width:110px; color:var(--dsw-alias-label-tertiary); font-size:12px; }
.rb-gv { min-width:0; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.rb-gate-blocking { border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
  background:linear-gradient(180deg, var(--rb-tint-error), var(--dsw-alias-bg-layer-2)); }
.rb-gate-blocking .rb-gk { color:var(--rb-ink-err); }
.rb-req-link { display:inline-block; font-family:var(--rb-mono); font-size:11px; color:var(--rb-ink-info);
  background:var(--rb-tint-info); padding:1px 7px; border-radius:4px; border:1px solid transparent;
  margin:0 4px 2px 0; }
.rb-kv { display:grid; grid-template-columns:110px minmax(0,1fr); gap:8px 14px; font-size:12.5px; }
.rb-kv-key { color:var(--dsw-alias-label-tertiary); font-size:12px; }
.rb-kv-val { color:var(--dsw-alias-label-secondary); min-width:0; overflow-wrap:anywhere; }

/* ---------- Flow chart ---------- */
.rb-flow { overflow-x:auto; overflow-y:hidden; padding:6px 2px 14px; }
.rb-flow-canvas { position:relative; }
.rb-flow-edges { position:absolute; left:0; top:0; overflow:visible; pointer-events:none; }
.rb-edge-path { fill:none; stroke:var(--dsw-alias-border-l3); stroke-width:1.5; }
.rb-edge-head { fill:var(--dsw-alias-border-l3); }
.rb-edge-done .rb-edge-path { stroke:var(--rb-accent-line); }
.rb-edge-done .rb-edge-head { fill:var(--rb-accent-line); }
.rb-node { position:absolute; box-sizing:border-box; overflow:hidden; padding:7px 9px;
  border-radius:var(--dsw-radius-sm); border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary);
  cursor:pointer; text-align:left; font:inherit; appearance:none; }
.rb-node:hover { border-color:var(--dsw-alias-border-l3); }
.rb-node-name { font-weight:500; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rb-node-meta { font-size:11px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rb-node-done { border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent);
  background:var(--rb-tint-success); color:var(--dsw-alias-label-primary); }
.rb-node-done .rb-node-mark { color:var(--rb-ink-ok); }
.rb-node-active { border-color:var(--rb-accent-line); background:var(--rb-accent-soft);
  color:var(--dsw-alias-label-primary); box-shadow:0 0 0 1px var(--rb-accent-line); }
.rb-node-active .rb-node-mark { color:var(--rb-accent); }
.rb-node-pending .rb-node-mark { color:var(--dsw-alias-label-tertiary); }
.rb-node-picked { outline:1px dashed var(--dsw-alias-label-tertiary); outline-offset:2px; }
.rb-node-mark { font-size:11px; }

/* ---------- Checks, history, execution units ---------- */
.rb-check { display:flex; gap:8px; align-items:flex-start; padding:3px 0; cursor:pointer; }
.rb-check-done { color:var(--rb-ink-ok); }
.rb-checks { display:flex; flex-direction:column; gap:4px; }
.rb-check-row { display:flex; align-items:center; gap:6px; }
.rb-history { display:flex; flex-direction:column; gap:0; max-height:280px; overflow:auto; }
.rb-history-row { display:flex; gap:10px; font-size:12px; align-items:baseline; padding:8px 2px;
  border-bottom:1px dashed var(--dsw-alias-border-l1); }
.rb-history-row:last-child { border-bottom:0; }
.rb-history-time { font-family:var(--rb-num); color:var(--dsw-alias-label-tertiary); font-size:11px;
  white-space:nowrap; font-variant-numeric:tabular-nums; }
.rb-exec-list { display:flex; flex-direction:column; gap:6px; margin:4px 0; }
.rb-exec-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12px;
  padding:8px 12px; border-radius:var(--dsw-radius-sm); border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); }
.rb-depends { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

/* ---------- Empty, loading, error ---------- */
.rb-empty { display:flex; flex-direction:column; align-items:center; gap:6px; padding:30px 20px;
  border:1px dashed var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md);
  color:var(--dsw-alias-label-tertiary); text-align:center; }
.rb-empty-ico { width:34px; height:34px; border-radius:9px; background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l1); display:grid; place-items:center; font-size:15px;
  margin-bottom:2px; }
.rb-empty-t { font-size:13px; font-weight:500; color:var(--dsw-alias-label-secondary); }
.rb-skeleton { display:flex; flex-direction:column; gap:8px; padding:10px 12px; }
.rb-skeleton-row { height:14px; border-radius:4px;
  background:linear-gradient(90deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1));
  animation:rb-shimmer 1.4s infinite linear; }
@keyframes rb-shimmer { 0% { opacity:.55; } 50% { opacity:1; } 100% { opacity:.55; } }
/* A reading kept for assistive technology while the visible form is a skeleton. */
.rb-sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden;
  clip-path:inset(50%); white-space:nowrap; border:0; }
.rb-error { color:var(--rb-ink-err); }
.rb-warn { color:var(--rb-ink-warn); }
.rb-muted { color:var(--dsw-alias-label-tertiary); }
.rb-ink-success { color:var(--rb-ink-ok); }
.rb-ink-info { color:var(--rb-ink-info); }
.rb-icon { display:block; }

/* ---------- Notices ---------- */
.rb-notice { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:12px 16px 0;
  padding:10px 14px; border-radius:var(--dsw-radius-md); font-size:12px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); }
.rb-notice-error, .rb-notice-auth { border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
  background:var(--rb-tint-error); color:var(--rb-ink-err); }
.rb-notice-stale { border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);
  background:var(--rb-tint-warn); color:var(--rb-ink-warn); }
.rb-notice-hint { border-left:3px solid var(--rb-accent); }
.rb-notice-sync { background:var(--rb-tint-warn); }
.rb-notice-force { border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
  background:var(--rb-tint-error); }

/* ---------- Dialog chrome, fields, images ---------- */
.rb-dialog, .rb-dialog-wide, .rb-dialog-drawer, .rb-dialog-roles { max-height:100%; font-size:13px;
  line-height:1.55; color:var(--dsw-alias-label-primary); }
.rb-dialog { width:min(560px, 100%); }
.rb-dialog-wide { width:min(680px, 100%); }
.rb-dialog-drawer { width:min(960px, 100%); }
.rb-dialog-roles { width:min(920px, 100%); min-height:0; }
.rb-field { display:flex; flex-direction:column; gap:3px; }
.rb-field-label { font-size:11px; color:var(--dsw-alias-label-tertiary); }
.rb-images { display:flex; flex-wrap:wrap; gap:8px; }
.rb-image-row { display:flex; align-items:center; gap:6px; }
.rb-image-thumb { max-width:160px; max-height:120px; border-radius:var(--dsw-radius-sm);
  border:1px solid var(--dsw-alias-border-l2); object-fit:cover; }
/* The helper tier is the smaller 11px size, but it keeps the secondary label
 * colour the picker's own gate reads: a hint a person must act on is not the
 * tertiary tier reserved for metadata. */
.rb-image-hint { flex:1; min-width:0; font-size:11px; color:var(--dsw-alias-label-secondary); }
.rb-image-tile { position:relative; width:96px; height:96px; }
.rb-image-tile-thumb { display:block; width:100%; height:100%; box-sizing:border-box;
  border-radius:var(--dsw-radius-sm); border:1px solid var(--dsw-alias-border-l2); object-fit:cover; }
.rb-image-tile-state { display:flex; align-items:center; justify-content:center; width:100%;
  height:100%; padding:6px; box-sizing:border-box; overflow:hidden; text-align:center;
  word-break:break-all; font-size:11px; border-radius:var(--dsw-radius-sm);
  border:1px dashed var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.rb-image-tile .rb-image-remove { position:absolute; top:4px; right:4px; width:20px; height:20px;
  min-width:20px; padding:0; border-radius:50%; font-size:12px; line-height:1;
  border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); }
.rb-image-tile .rb-image-remove:hover { color:var(--rb-ink-err);
  border-color:var(--dsw-alias-state-error-primary); }
/* The picker is driven by its own button, so the native control stays out of
 * the layout but remains reachable for the keyboard and assistive technology. */
.rb-file-input { position:absolute; width:1px; height:1px; padding:0; margin:-1px;
  overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }

/* ---------- Template drawer and management surfaces ---------- */
.rb-drawer { display:flex; gap:14px; align-items:flex-start; min-height:320px; }
.rb-drawer-list { width:264px; flex:none; display:flex; flex-direction:column; gap:6px; }
.rb-drawer-body { flex:1 1 auto; min-width:0; }
.rb-drawer-filter { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.rb-template-rows { display:flex; flex-direction:column; gap:6px; max-height:52vh; overflow:auto; }
.rb-template-row { display:flex; flex-direction:column; gap:4px; width:100%; text-align:left; font:inherit;
  appearance:none; cursor:pointer; padding:10px 12px; border-radius:var(--dsw-radius-md);
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:inherit; }
.rb-template-row:hover { border-color:var(--dsw-alias-border-l2); }
/* The picked row keeps the accent stroke while the pointer is on it: the state arm
   doubles its base class so it outranks the hovered base rule, which is one
   class plus one pseudo-class. */
.rb-template-row.rb-template-row-picked { border-color:var(--rb-accent-line); background:var(--dsw-alias-bg-layer-2);
  box-shadow:inset 2px 0 0 var(--rb-accent); }
.rb-template-row-title { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-weight:500; }
.rb-version-list { display:flex; flex-direction:column; gap:6px; }
.rb-version-row { display:flex; flex-direction:column; gap:4px; padding:10px 12px;
  border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); }
.rb-node-card { display:flex; flex-direction:column; gap:8px; padding:10px 12px;
  border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); }
.rb-node-card-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.rb-node-heading { font-weight:500; }
.rb-node-fields { display:flex; gap:8px; flex-wrap:wrap; }
.rb-node-fields > .rb-field { flex:1 1 180px; min-width:0; }
.rb-impact-row { display:flex; flex-direction:column; gap:4px; padding:10px 12px;
  border-radius:var(--dsw-radius-md); border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); }
.rb-impact-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.rb-impact-move { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:12px; }

/* ---------- Role management: two columns, duty editor, in-place confirm ----------
   Role management is the one surface that reads a role and the presets that
   resolve to it side by side, so each column owns its own search box and its
   own scroll body: the grid splits the width evenly and only the column that
   overflows moves. A scroll body needs a bounded height, which the platform
   modal body does not supply, so it also caps at the template drawer's 52vh. */
.rb-roles-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  min-height:0; flex:1; }
.rb-roles-col { display:flex; flex-direction:column; gap:8px; min-width:0; min-height:0;
  padding:10px 14px; }
.rb-roles-col:first-child { border-right:1px solid var(--dsw-alias-border-l1); }
.rb-roles-col-head { display:flex; align-items:baseline; gap:6px; }
.rb-roles-search { flex:none; }
.rb-roles-scroll { overflow:auto; min-height:0; flex:1; max-height:52vh; display:flex;
  flex-direction:column; gap:8px; }
.rb-role-confirm { display:flex; flex-direction:column; gap:6px; margin-top:4px; padding:8px 10px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
  border-radius:var(--dsw-radius-sm); background:var(--rb-tint-error);
  color:var(--rb-ink-err); font-size:12px; }
.rb-duty-row { display:flex; align-items:center; gap:6px; }
.rb-duty-row > span { flex:1 1 auto; min-width:0; }
.rb-duty-count { font-family:var(--rb-num); font-size:11px; color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums; }
.rb-form-error { display:flex; flex-direction:column; gap:4px; padding:8px 10px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
  border-radius:var(--dsw-radius-sm); background:var(--rb-tint-error);
  color:var(--rb-ink-err); font-size:12px; }
.rb-preset-empty { padding:4px 2px 8px; }
.rb-role-list { display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-md); overflow:hidden; max-height:40vh; overflow-y:auto;
  background:var(--dsw-alias-bg-layer-1); }
.rb-role-row { display:flex; flex-direction:column; gap:3px; padding:10px 12px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1); }
.rb-role-row:last-child { border-bottom:1px solid var(--dsw-alias-border-l1); }
/* The row the form dialog addresses stays marked for as long as that dialog is
   open, so "which row am I editing" is answered on the list itself. The state arm
   doubles its base class -- the idiom the chip and primary button arms already use
   -- because one class ties with the base row rule and with the last-child rule,
   both of which sit later in the sheet. */
.rb-role-row.rb-role-row-editing { border-color:var(--rb-accent-line); background:var(--dsw-alias-bg-layer-2);
  box-shadow:inset 2px 0 0 var(--rb-accent); }
.rb-role-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.rb-role-name { font-weight:500; }
.rb-duties { display:flex; flex-wrap:wrap; gap:4px; }
.rb-preset-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 12px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1); }
.rb-table { width:100%; border-collapse:collapse; font-size:12px; }
.rb-table td, .rb-table th { text-align:left; padding:6px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.rb-table th { color:var(--dsw-alias-label-tertiary); font-weight:500; }
.rb-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }

/* ---------- The requirement's brief ---------- */
/* The plain-language reading sits above the metadata grid, so it is the first
   thing a reader meets after the title; the full description stays behind its
   fold below. A record written before the field shows the placeholder in the
   same frame rather than an empty gap. */
.rb-summary { border:1px solid var(--dsw-alias-border-l1); border-radius:var(--rb-radius-md);
  background:var(--dsw-alias-bg-layer-1); padding:12px 14px; margin-top:14px; }
.rb-summary-tag { display:flex; align-items:center; gap:7px; margin-bottom:6px;
  font-family:var(--rb-num); font-size:11px; letter-spacing:.08em; text-transform:uppercase;
  color:var(--dsw-alias-label-tertiary); }
.rb-summary-text { margin:0; font-size:15px; line-height:1.6; overflow-wrap:anywhere;
  color:var(--dsw-alias-label-primary); }
.rb-summary-empty .rb-summary-text { color:var(--dsw-alias-label-tertiary); }
.rb-card-summary { margin:0 0 6px; font-size:12px; line-height:1.45; overflow-wrap:anywhere;
  color:var(--dsw-alias-label-secondary); display:-webkit-box; -webkit-line-clamp:2;
  -webkit-box-orient:vertical; overflow:hidden; }
.rb-textarea-brief { min-height:58px; }

/* ---------- Project ----------
   The project is the label a reader sorts a crowded board by, so it leads the
   card's metadata row as a quiet capsule and names each grouped section. The
   group header states its own count, which is what a reader compares projects
   by; the unassigned group carries the same frame with a dimmed name. */
.rb-card-project { display:inline-flex; align-items:center; height:18px; padding:0 6px;
  border-radius:var(--dsw-radius-sm); background:var(--rb-accent-soft); color:var(--rb-accent);
  font-size:11px; line-height:1; white-space:nowrap; max-width:140px; overflow:hidden;
  text-overflow:ellipsis; }
.rb-group { display:flex; flex-direction:column; gap:8px; }
/* The three role groups and the preset section are headed by a real h3, so the
   element's own size and weight are reset here: the name and count runs carry
   the type, in the role columns and in the board's project groups alike. */
.rb-group-head { display:flex; align-items:baseline; gap:6px; padding:2px 2px 0;
  margin:0; font-size:12px; font-weight:500; }
.rb-group-name { font-size:12px; font-weight:500; color:var(--dsw-alias-label-primary);
  overflow-wrap:anywhere; }
.rb-group-n { font-family:var(--rb-num); font-size:11px; color:var(--dsw-alias-label-tertiary); }

/* ---------- v2 density pass ----------
 * The design sample's direction, applied to the panel: a tighter top bar, one
 * bordered KPI strip instead of seven separate cards, cards whose status is a
 * rail and whose progress sits on the title line, and a detail pane whose
 * identity/title/actions stay put while the body scrolls. Colours stay on the
 * platform's own aliases: the panel must read as part of the harness, not as a
 * separately skinned surface. */
.rb-header { height:56px; gap:14px; padding:0 16px; }
.rb-header .rb-title { font-size:15px; }
.rb-header .rb-sub { gap:5px; font-size:11px; }
.rb-header .rb-btn.rb-btn { height:28px; padding:0 11px; font-size:12.5px; }
.rb-header .rb-btn-primary.rb-btn-primary.rb-btn-primary { height:30px; }
.rb-views { gap:12px; padding:10px 16px 0; }
.rb-segmented { padding:2px; }
.rb-views .rb-seg.rb-seg { height:26px; padding:0 14px; font-size:12.5px; }
.rb-filters { gap:6px; padding:10px 16px; }
.rb-filters .rb-chip.rb-chip { height:24px; padding:0 10px; font-size:12px; }
.rb-select, .rb-textarea, .rb-input { height:28px; font-size:13px; }

/* One strip for the seven KPI readings: the cells keep their grid columns and
 * lose their own frames, so the band reads as a table of numbers. */
.rb-stats { gap:0; margin:10px 16px 0; padding:0;
  border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.rb-stat { border:0; border-right:1px solid var(--dsw-alias-border-l1);
  border-radius:0; background:transparent; padding:10px 14px; }
.rb-stat:hover { border-color:var(--dsw-alias-border-l1); }
.rb-stat-alert { border-right:0; }
.rb-submetrics { padding:8px 16px 12px; }
/* The readings that are controls: same cells, a pressed state and a cursor. */
.rb-stat-action { text-align:left; cursor:pointer; font:inherit; }
.rb-stat-action:hover { background:var(--rb-accent-soft); }
.rb-stat-action:focus-visible { outline:2px solid var(--rb-accent-line); outline-offset:-2px; }
.rb-stat-on { box-shadow:inset 0 -2px 0 var(--rb-accent); }
.rb-submetric-action { cursor:pointer; border-radius:4px; padding:0 3px; margin:0 -3px; }
.rb-submetric-action:hover { color:var(--dsw-alias-label-primary); background:var(--rb-accent-soft); }
.rb-submetric-on, .rb-submetric-on b { color:var(--rb-accent); }

/* Body split and cards. */
.rb-body { padding:12px 16px 16px; gap:14px; }
.rb-list { width:360px; gap:6px; }
.rb-card { position:relative; overflow:hidden; padding:10px 12px 9px 14px; }
/* A card is a fixed row of a scrolling column. Its own overflow:hidden -- the
 * rail clip -- gives it an automatic minimum height of zero, so a list taller
 * than the column used to flex-shrink every card: the title and the summary
 * survived, but the meta chips and the date row were cut off inside the card
 * and the list had nothing left to scroll. Cards keep their content height;
 * the column scrolls. Group sections wrap nested lists, so they carry the same
 * rule. */
.rb-list > .rb-card, .rb-list > .rb-group { flex:none; }
.rb-card::before { content:""; position:absolute; left:0; top:9px; bottom:9px; width:3px;
  border-radius:0 3px 3px 0; background:var(--dsw-alias-border-l3); }
.rb-card[data-status="active"]::before { background:var(--rb-accent); }
.rb-card[data-status="blocked"]::before { background:var(--dsw-alias-state-error-primary); }
.rb-card[data-status="done"]::before { background:var(--dsw-alias-state-success-primary); }
.rb-card[data-status="archived"]::before { background:var(--dsw-alias-border-l3); }
.rb-card[data-kind="decision"]::before { background:var(--rb-violet); }
.rb-card-title-row { display:flex; align-items:baseline; gap:8px; }
.rb-card-title { flex:1 1 auto; margin-bottom:0; font-size:13px; line-height:1.4; }
.rb-card-progress { flex:none; font-family:var(--rb-num); font-size:11px;
  color:var(--dsw-alias-label-tertiary); font-variant-numeric:tabular-nums; }
.rb-card-progress b { color:var(--rb-accent); font-weight:500; }
.rb-card-summary { display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical;
  overflow:hidden; margin-top:3px; font-size:12px; line-height:1.5;
  color:var(--dsw-alias-label-tertiary); }
.rb-card-meta { gap:4px 8px; margin-top:6px; font-size:11px; }
.rb-card-meta + .rb-card-meta { margin-top:3px; }
.rb-list-more { display:flex; justify-content:center; padding:8px 0 2px; }
/* Selection mode: the list column becomes a pane so the toolbar sits above the
 * scrolling rows; the row itself is the toggle (no nested control inside the
 * card button), and the check mark is its visual state. */
.rb-list-pane { display:flex; flex-direction:column; min-height:0; width:360px; flex:none; gap:6px; }
.rb-list-pane > .rb-list { flex:1 1 auto; width:auto; }
.rb-batch { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:7px 9px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1); font-size:11.5px; color:var(--dsw-alias-label-tertiary); }
.rb-batch .rb-btn.rb-btn { height:24px; padding:0 8px; font-size:11.5px; }
.rb-batch-count { color:var(--rb-accent); font-family:var(--rb-num); }
.rb-batch-select { height:24px; font-size:11.5px; }
.rb-card-selectable { cursor:pointer; }
.rb-card-chosen { border-color:var(--rb-accent-line); box-shadow:inset 0 0 0 1px var(--rb-accent-line); }
.rb-batch-check { flex:none; width:14px; height:14px; border-radius:4px; display:grid; place-items:center;
  border:1px solid var(--dsw-alias-border-l3); color:transparent; font-size:10px; }
.rb-card-chosen .rb-batch-check { background:var(--rb-accent); border-color:var(--rb-accent); color:#fff; }
.rb-batch-result { display:grid; gap:10px; font-size:12.5px; }
.rb-batch-group h3 { margin:0 0 4px; font-size:12px; font-weight:600; }
.rb-batch-row { color:var(--dsw-alias-label-secondary); font-family:var(--rb-mono); font-size:11px; word-break:break-all; }
.rb-shortcuts { display:grid; gap:9px; }
.rb-shortcut { font-size:13px; color:var(--dsw-alias-label-secondary); }

/* Detail: the two identity rows stick to the top of the scrolling pane. */
.rb-detail { padding:0 26px 26px; }
.rb-detail-id { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:6px;
  padding:12px 0 5px; background:var(--dsw-alias-bg-base);
  font-family:var(--rb-mono); font-size:11px; color:var(--dsw-alias-label-tertiary); }
.rb-detail-id .rb-btn.rb-btn { height:22px; padding:0 7px; font-size:11px;
  border-color:transparent; background:transparent; color:var(--dsw-alias-label-tertiary); }
.rb-detail-id .rb-btn.rb-btn:hover { color:var(--rb-accent); background:var(--rb-accent-soft);
  border-color:transparent; }
.rb-detail-top { position:sticky; top:34px; z-index:2; padding-bottom:10px; margin-bottom:6px;
  background:var(--dsw-alias-bg-base); }
.rb-detail .rb-title { font-size:17px; }
.rb-detail-actions .rb-btn.rb-btn { height:26px; padding:0 9px; font-size:12px; }
.rb-keys { display:flex; align-items:center; gap:4px; margin-left:8px; font-size:11px;
  color:var(--dsw-alias-label-tertiary); }
.rb-keys kbd { font:11px var(--rb-mono); color:var(--dsw-alias-label-tertiary);
  border:1px solid var(--dsw-alias-border-l2); border-bottom-width:2px; border-radius:4px;
  padding:0 4px; background:var(--dsw-alias-bg-layer-1); }

/* ---------- Adaptation ---------- */
@media (max-width:1240px) {
  .rb-body { flex-direction:column; }
  .rb-list { width:auto; }
  .rb-list-pane { width:auto; }
  .rb-meta-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
  /* Too narrow for seven columns: the band's cells wrap, keeping their order. */
  .rb-stats { display:flex; flex-wrap:wrap; align-items:stretch; }
  .rb-stat { flex:1 1 104px; }
  .rb-stat-hero, .rb-stat-alert { flex:1 1 100%; }
}
@media (max-width:900px) {
  .rb-detail, .rb-body, .rb-stats, .rb-filters, .rb-views { padding-left:12px; padding-right:12px; }
  .rb-detail { padding-top:16px; }
  .rb-stat-hero, .rb-stat-alert { flex:1 1 100%; }
  .rb-meta-grid { grid-template-columns:minmax(0,1fr); }
  /* A cell that spans two columns would otherwise force an implicit second
   * track and keep the "one column" arm at two unequal columns. The scoped
   * selector outranks the span rule the v3 pass declares further down. */
  .rb-meta-grid .rb-meta-cell-span2 { grid-column:span 1; }
}
@media (max-width:760px) {
  /* Side by side is the point of this dialog, so the narrow arm keeps both
     columns at a usable width and lets the grid scroll horizontally instead of
     stacking them: a stacked pair has to be scrolled between anyway. */
  .rb-roles-grid { grid-template-columns:minmax(300px,1fr) minmax(300px,1fr); overflow-x:auto; }
}
@media (prefers-reduced-motion: reduce) {
  .rb-live, .rb-skeleton-row { animation:none; }
  .rb-stat, .rb-card, .rb-node, .rb-caret, .rb-ring-fill { transition:none; }
}

/* ---------- v3 optimization pass ----------
 * The third design round (design-notes.md §3): accessibility grades the platform
 * aliases do not carry, the filter toolbar's single-row grammar with two
 * independent popovers, reading measure, zero-value demotion, and the container
 * keyed band breakpoint. Everything here overrides by later order or by a
 * doubled/tripled class arm; the v1 and v2 rules above stay untouched so their
 * recorded deviations keep reading true. Colours stay on --dsw-* aliases or on
 * the --rb-* registry; the only literals are the light arm's text-grade inks
 * declared in the arm blocks above.
 */
/* C-2: the radius the brief card references but no block ever defined. */
.rb-root { --rb-radius-md:var(--dsw-radius-md); container-type:inline-size; }
/* P6/C-3: revive the alert cell the v2 strip reset killed by source order. The
 * triple-class arm outranks the v2 strip reset without editing the v2 rule, so the next
 * density pass cannot silently repeat the regression; the smoke suite asserts
 * the computed ring. */
.rb-stats .rb-stat.rb-stat-alert { background:linear-gradient(180deg, var(--rb-tint-warn), var(--dsw-alias-bg-layer-1));
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); }
.rb-stats .rb-stat.rb-stat-alert.rb-stat-alert-clear { background:var(--dsw-alias-bg-layer-1); box-shadow:none; }
/* P6: the band wraps when the shell column narrows, whatever the viewport says. */
@container (max-width:1080px) {
  .rb-stats { display:flex; flex-wrap:wrap; align-items:stretch; }
  .rb-stat { flex:1 1 104px; border-right:0; border-top:1px solid var(--dsw-alias-border-l1); }
  .rb-stat:first-child { border-top:0; }
  .rb-stat-hero, .rb-stat-alert { flex:1 1 100%; }
}
/* P3: one solid focus ring, keyboard modality only; inputs keep theirs back. */
.rb-stat-action:focus-visible { outline:2px solid var(--rb-accent); outline-offset:-2px; }
.rb-root .rb-select:focus-visible, .rb-root .rb-textarea:focus-visible, .rb-root .rb-input:focus-visible,
.rb-root summary.rb-fold-summary:focus-visible { outline:2px solid var(--rb-accent); outline-offset:1px; }
/* P7: every repeated control reaches a 24px hit target. */
.rb-detail-id .rb-btn.rb-btn { height:24px; }
.rb-submetric-action { padding:3px 6px; margin:-3px -6px; min-height:24px; }
.rb-image-tile .rb-image-remove { width:24px; height:24px; min-width:24px; top:3px; right:3px; }
.rb-clear { min-height:24px; padding:4px 8px; }
/* V3-1: an empty meta value keeps the cell surface and reads as a dash. */
.rb-meta-v[data-empty="true"] { color:var(--dsw-alias-label-tertiary); font-weight:400; }
.rb-meta-cell-span2 { grid-column:span 2; }
/* V3-2/V3-3: a reading measure for prose; history notes are metadata tier (12px
 * stays) but keep the same measure so command lines stop running 100+ chars. */
.rb-prose { max-width:68ch; }
.rb-history-row { max-width:68ch; }
/* V3-3 landed on the prose measure: the description renders as one wrapping
 * paragraph, so there is no code block element to style in this product. */
/* V3-4: the status rail only where a state needs action; done and archived cards
 * carry their badge instead of a saturated edge. */
.rb-card[data-status="done"]::before, .rb-card[data-status="archived"]::before { background:transparent; }
/* V3-6: zero readings step down; a zero that is still a control says so on hover. */
.rb-stat-value[data-zero="true"] { color:var(--dsw-alias-label-tertiary); }
.rb-stat-action:hover .rb-stat-value { text-decoration:underline; text-underline-offset:3px; }
/* V3-5/V3-21/V3-22/V3-23: one-row toolbar. The right cluster hangs off a container
 * that is always rendered, so hiding the clear button cannot drag the count and
 * the key hint into the left group. Value triggers open their own dimension menu;
 * "more filters" opens the whole grid; the two never share a state. */
.rb-filters { position:relative; }
.rb-bar-right { margin-left:auto; display:inline-flex; align-items:center; gap:8px; }
.rb-trigger { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 10px;
  border-radius:var(--dsw-radius-sm); color:var(--dsw-alias-label-secondary); font:inherit; font-size:12.5px; }
.rb-trigger:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.rb-trigger::after { content:"▾"; font-size:9px; color:var(--dsw-alias-label-tertiary); }
.rb-trigger-on { background:var(--rb-accent-soft); color:var(--rb-ink-accent); }
.rb-trigger-wrap { position:relative; display:inline-flex; }
.rb-status-pop { position:absolute; top:calc(100% + 4px); left:0; z-index:7; min-width:150px;
  background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md); box-shadow:var(--dsw-shadow-lv2); padding:6px;
  display:flex; flex-direction:column; gap:2px; }
.rb-status-opt { display:flex; align-items:center; justify-content:space-between; gap:10px; height:32px;
  padding:0 10px; border-radius:var(--dsw-radius-sm); text-align:left; font:inherit; font-size:12.5px;
  color:var(--dsw-alias-label-secondary); }
.rb-status-opt:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.rb-status-opt-on { color:var(--rb-ink-accent); background:var(--rb-accent-soft); }
.rb-filter-pop { position:absolute; top:calc(100% + 4px); left:16px; right:16px; z-index:6;
  background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md); box-shadow:var(--dsw-shadow-lv2); padding:12px; }
.rb-filter-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:8px; }
.rb-field-span2 { grid-column:span 2; }
.rb-toggle-row { grid-column:1 / -1; display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; }
.rb-toggle { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 10px;
  border-radius:999px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); font-size:12px; }
.rb-toggle:hover { border-color:var(--dsw-alias-border-l3); color:var(--dsw-alias-label-primary); }
.rb-toggle-on { border-color:var(--rb-accent-line); background:var(--rb-accent-soft); color:var(--rb-ink-accent); }
/* V3-18: one control family — 32px frames at the small radius; the caret is drawn
 * by the field so no native select chrome survives. */
.rb-select, .rb-input { height:32px; border-radius:var(--dsw-radius-sm); }
.rb-select { appearance:none; -webkit-appearance:none; padding-right:26px; }
.rb-field:has(.rb-select) { position:relative; }
.rb-field:has(.rb-select)::after { content:"▾"; position:absolute; right:10px; top:50%;
  transform:translateY(-50%); font-size:9px; color:var(--dsw-alias-label-tertiary); pointer-events:none; }
/* V3-25: the badge row scrolls with the body; the sticky stack keeps two rows. */
.rb-detail-badges { padding:10px 0 0; }
/* v3 motion: popover and trigger feedback join the existing 160ms family. */
.rb-trigger, .rb-status-opt, .rb-toggle, .rb-filter-pop, .rb-status-pop {
  transition:background .16s var(--ds-ease-out), color .16s var(--ds-ease-out), border-color .16s var(--ds-ease-out); }
.rb-btn:active, .rb-card:active, .rb-seg:active { transform:translateY(1px); }
@media (prefers-reduced-motion: reduce) {
  .rb-trigger, .rb-status-opt, .rb-toggle, .rb-filter-pop, .rb-status-pop { transition:none; }
  .rb-btn:active, .rb-card:active, .rb-seg:active { transform:none; }
}
@media (max-width:1240px) {
  .rb-filter-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
}
/* V3-8: the list column's head row — title, visible count, batch entry. The
 * entry button hangs right off the row whatever the count reads. */
.rb-list-head{display:flex;align-items:center;gap:8px;padding:2px 2px 4px;flex:none}
.rb-list-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.rb-list-count{font-family:var(--rb-num);font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;line-height:16px}
.rb-search{flex:1 1 220px;max-width:420px}
.rb-list-head .rb-btn-sm{margin-left:auto}
`

    /** One labelled form field. */
    function Field({ label, children }) {
      return h('label', { className: 'rb-field' }, h('span', { className: 'rb-field-label' }, label), children)
    }

    /**
     * A modal surface.
     *
     * The platform Modal owns the mask, the surface, Escape for the top layer,
     * the Tab trap, entry and return focus, and the frame's overlay inset; this
     * wrapper only supplies localized copy and the dialog's width.
     *
     * `className` replaces the width tiers rather than joining them: a surface
     * that needs its own width states it once, and the three defaults stay the
     * whole set for every other dialog.
     */
    function Dialog({ title, closeLabel, onClose, children, footer, wide, drawer, className }) {
      return h(Modal, {
        open: true,
        onClose,
        title,
        closeLabel,
        className: className ?? (drawer === true ? 'rb-dialog-drawer' : wide === true ? 'rb-dialog-wide' : 'rb-dialog'),
        footer,
      }, children)
    }

    /**
     * The app-level toast host.
     *
     * Declared into `shell.overlay`, so the shell mounts it for the whole app
     * rather than the panel: an operation that closes or replaces the panel must
     * still be able to report its outcome. The banner primitive owns its own
     * placement and fade, and reports completion through `onDone`.
     *
     * Three weights, because an idempotent cleanup that found nothing to do is
     * neither a success nor a failure: `error` is a refusal, `info` is a change
     * that landed, and `muted` is "already in that state". Only `info` earns the
     * success glyph; the other two keep the neutral icon seat.
     */
    function BoardToast({ useToast, dismissToast }) {
      const toast = typeof useToast === 'function' ? useToast(identity) : null
      if (toast === null) return null
      // The banner fades itself out and reports completion, so the host keeps no
      // timer. Only a landed change earns the success glyph; a refusal and an
      // "already in that state" note keep the neutral icon seat.
      return h(Toast, {
        text: toast.text,
        tone: toast.kind === 'info' ? 'success' : undefined,
        holdMs: toast.kind === 'error' ? 8000 : 3500,
        onDone: () => dismissToast(),
      })
    }

    /** The display name of one role id, falling back to the id itself. */
    function roleName(role, roles) {
      if (role === '') return ''
      const record = (roles?.items ?? []).find(item => item.id === role)
      return record === undefined || record.name === role ? role : `${record.name} (${role})`
    }

    /**
     * Read one stored lock for display.
     *
     * Only fields the record carries are reported: the lease threshold is a Host
     * configuration the snapshot does not expose, so how long the lock has gone
     * without renewal is shown as an age and never as a verdict.
     * @param lock - The stored lock, or null.
     * @returns display facts, or `null` when nothing is locked.
     */
    function lockFacts(lock) {
      if (lock === null || lock === undefined) return null
      const now = Date.now()
      const held = Date.parse(lock.at)
      const touched = Date.parse(lock.touchedAt ?? lock.at)
      return {
        holder: lock.name === undefined || lock.name === '' ? lock.session : `${lock.name} (${lock.session})`,
        heldMs: Number.isFinite(held) ? Math.max(0, now - held) : null,
        idleMs: Number.isFinite(touched) ? Math.max(0, now - touched) : null,
        orphaned: lock.orphaned === true,
        expired: lock.expired === true,
      }
    }

    /**
     * The panel line each stored role `source` renders as.
     *
     * The source is what ties a role row back to the preset it came from: a
     * declaration shipped with a preset, the preset id itself, a human's edit, or
     * a delegation's temporary role.
     */
    const ROLE_SOURCE_KEYS = {
      preset: 'roleSourcePreset',
      manual: 'roleSourceManual',
      observed: 'roleSourceObserved',
      delegated: 'roleSourceDelegated',
    }

    /**
     * Whether two role drafts are the same edit.
     *
     * The duty list is compared as a list — order and repeats both count — so
     * adding, removing, reordering, or restating a duty all read as a change. An
     * untouched draft closes without a prompt; anything else is the reader's to
     * confirm before it is lost.
     * @param left - one draft.
     * @param right - the draft it started from.
     * @returns whether the two are the same edit.
     */
    function sameRoleDraft(left, right) {
      return left.roleId === right.roleId
        && left.roleName === right.roleName
        && left.duties.length === right.duties.length
        && left.duties.every((duty, index) => duty === right.duties[index])
    }

    /**
     * The duty list a `role.put` carries, and how many repeats it absorbed.
     *
     * The Host's own reader (`host/model.js` `asStringArray`) trims each entry,
     * drops the empty ones, and keeps the first occurrence of a repeat; the panel
     * applies the same rule before submitting, so the list it shows is the list
     * that lands. A repeat merges rather than failing, and the caller states how
     * many merged — an empty list is a legal declaration, and is exactly what
     * `dutiesMissing` reports.
     * @param duties - the editor's rows, one string each.
     * @returns `{ duties, merged }`, the merged list and the repeats it dropped.
     */
    function mergedDuties(duties) {
      const kept = []
      let merged = 0
      for (const duty of duties) {
        const text = duty.trim()
        if (text === '') continue
        if (kept.includes(text)) {
          merged += 1
          continue
        }
        kept.push(text)
      }
      return { duties: kept, merged }
    }

    /**
     * Whether two template form drafts are the same edit.
     *
     * Every field the form owns is compared, so a duplicate draft, which carries
     * only a name, compares as an untouched one while any typed character asks
     * first. An untouched draft closes without a prompt.
     * @param left - one draft.
     * @param right - the draft it started from.
     * @returns whether the two are the same edit.
     */
    function sameTemplateDraft(left, right) {
      return left.name === right.name
        && left.description === right.description
        && left.nodes === right.nodes
    }

    /**
     * The role form, as a second dialog over role management.
     *
     * Three entries share this one layer — a new role, a line edit, and a
     * one-click registration from a preset — so the row a form addresses is
     * stated twice: in the dialog title, which names that row, and on the row
     * itself, which stays marked while the form is open. Fields and their bounds
     * are the Host's own (`role.put`): the display name and each duty carry the
     * 40-character cap on the control, the duty editor counts its rows against
     * the twelve-row ceiling, and the id's charset is the Host's to refuse — its
     * message is what the error block shows.
     *
     * Duties are one row each (`role.duty.<i>`) rather than comma-separated text:
     * a duty may then contain a comma, and each row is added or removed on its
     * own. The body is a `form`, so Enter in any field submits through it — which
     * is why the action row is inside the form and not in `Modal.footer`. Escape
     * and the mask belong to the platform modal layer and arrive here as
     * `onAttemptClose`, which turns them into the discard confirmation while the
     * draft differs from the value it started as.
     * @returns the second-layer dialog.
     */
    function RoleFormDialog({ form, discard, busy, error, merged, t, onPatch, onDutyChange, onDutyAdd, onDutyRemove, onAttemptClose, onDrop, onKeep, onSave }) {
      const value = form.value
      const name = value.roleName.trim() === '' ? value.roleId : value.roleName.trim()
      const title = form.mode === 'new'
        ? t('newRole')
        : interpolate(t(form.mode === 'edit' ? 'roleEditTitle' : 'roleRegisterTitle'), { name, id: value.roleId })
      return h(Dialog, { title, closeLabel: t('close'), onClose: onAttemptClose },
        h('form', { onSubmit: event => { event.preventDefault(); onSave() } },
          h(Field, { label: t('roleId') }, h(Input, {
            name: 'role.roleId',
            value: value.roleId,
            disabled: form.mode === 'edit',
            'data-modal-autofocus': true,
            onChange: event => onPatch({ roleId: event.target.value }),
          })),
          h(Field, { label: t('roleName') }, h(Input, {
            name: 'role.roleName',
            value: value.roleName,
            maxLength: ROLE_NAME_MAX,
            onChange: event => onPatch({ roleName: event.target.value }),
          })),
          h('div', { className: 'rb-field' },
            h('div', { className: 'rb-field-label' },
              h('span', null, t('roleDuties')),
              h('span', { className: 'rb-duty-count' }, interpolate(t('roleDutyCount'), { count: value.duties.length }))),
            value.duties.map((duty, index) => h('div', { key: `duty.${index}`, className: 'rb-duty-row' },
              h(Input, {
                name: `role.duty.${index}`,
                value: duty,
                maxLength: ROLE_DUTY_MAX,
                onChange: event => onDutyChange(index, event.target.value),
              }),
              h(Button, {
                className: 'rb-btn-pad rb-btn-sm rb-btn',
                variant: 'ghost',
                size: 'sm',
                name: `role.duty.remove.${index}`,
                disabled: busy,
                onClick: () => onDutyRemove(index),
              }, t('roleDutyRemove')))),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: 'role.duty.add',
              disabled: busy || value.duties.length >= ROLE_DUTIES_MAX,
              onClick: () => onDutyAdd(),
            }, t('roleDutyAdd')),
            h('div', { className: 'rb-muted' }, t('roleDutyEmptyHint')),
            merged > 0 ? h('div', { className: 'rb-muted' }, interpolate(t('roleDutyMerged'), { count: merged })) : null),
          error === null ? null : h('div', { className: 'rb-form-error', name: 'role.form.error' },
            h('div', null, t('roleFormError')),
            h('div', null, error)),
          discard ? h('div', { className: 'rb-panel' },
            h('div', null, t('roleDiscardConfirm')),
            h('div', { className: 'rb-row' },
              h(Button, { className: 'rb-btn', variant: 'outline', name: 'role.discard.drop', onClick: () => onDrop() }, t('roleDiscardConfirmDrop')),
              h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', name: 'role.discard.keep', onClick: () => onKeep() }, t('roleDiscardConfirmKeep')))) : null,
          h('div', { className: 'rb-row' },
            h(Button, {
              className: 'rb-btn-primary-stroke rb-btn-pad rb-btn',
              variant: 'primary',
              type: 'submit',
              name: 'role.save',
              disabled: busy || value.roleId.trim() === '',
            }, t('save')),
            h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', name: 'role.cancel', onClick: () => onAttemptClose() }, t('cancel')))))
    }

    /**
     * The template form, as a second dialog over the template drawer.
     *
     * Two entries share this one layer — a new template, and a duplicate of the
     * template the drawer has selected — so the title names its subject: the
     * blank draft is `newTemplate`, the copy is `templateCloneTitle` with the row
     * it copies. The field names and the submit predicate are the ones the inline
     * form used, so the command bodies are unchanged; the required-field line
     * states what the disabled submit is waiting for, because a disabled control
     * alone does not say why. The body is a `form`, so Enter in any field submits
     * through it — which is why the action row is inside the form and not in
     * `Modal.footer`. Escape and the mask belong to the platform modal layer and
     * arrive here as `onAttemptClose`, which turns them into the discard
     * confirmation while the draft differs from the value it started as.
     * @returns the second-layer dialog.
     */
    function TemplateFormDialog({ form, discard, busy, error, t, onPatch, onAttemptClose, onDrop, onKeep, onSave }) {
      const value = form.value
      const blank = form.mode === 'new'
      const title = blank ? t('newTemplate') : interpolate(t('templateCloneTitle'), { name: form.sourceName })
      const nameMissing = value.name.trim() === ''
      const nodesMissing = blank && value.nodes.trim() === ''
      return h(Dialog, { title, closeLabel: t('close'), onClose: onAttemptClose },
        h('form', { onSubmit: event => { event.preventDefault(); onSave() } },
          h(Field, { label: t('templateName') }, h(Input, {
            name: blank ? 'template.new.name' : 'template.clone.name',
            value: value.name,
            'data-modal-autofocus': true,
            onChange: event => onPatch({ name: event.target.value }),
          })),
          blank ? null : h('div', { className: 'rb-muted' }, t('templateCloneHint')),
          blank ? h(Field, { label: t('templateDescription') }, h(Input, {
            name: 'template.new.description',
            value: value.description,
            onChange: event => onPatch({ description: event.target.value }),
          })) : null,
          blank ? h(Field, { label: `${t('templateNodes')} — ${t('templateNodesHint')}` }, h('textarea', {
            className: 'rb-textarea',
            name: 'template.new.nodes',
            style: { minHeight: 90 },
            value: value.nodes,
            placeholder: t('templateNodesExample'),
            onChange: event => onPatch({ nodes: event.target.value }),
          })) : null,
          nameMissing || nodesMissing
            ? h('div', { className: 'rb-muted', name: 'template.form.required' },
              nameMissing ? h('div', null, t('templateNameRequired')) : null,
              nodesMissing ? h('div', null, t('templateNodesRequired')) : null)
            : null,
          error === null ? null : h('div', { className: 'rb-form-error', name: 'template.form.error' },
            h('div', null, t('templateFormError')),
            h('div', null, error)),
          discard ? h('div', { className: 'rb-panel' },
            h('div', null, t('templateDiscardConfirm')),
            h('div', { className: 'rb-row' },
              h(Button, { className: 'rb-btn', variant: 'outline', name: 'template.discard.drop', onClick: () => onDrop() }, t('templateDiscardConfirmDrop')),
              h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', name: 'template.discard.keep', onClick: () => onKeep() }, t('templateDiscardConfirmKeep')))) : null,
          h('div', { className: 'rb-row' },
            h(Button, {
              className: 'rb-btn-primary-stroke rb-btn-pad rb-btn',
              variant: 'primary',
              type: 'submit',
              name: blank ? 'template.create' : 'template.clone.confirm',
              disabled: busy || nameMissing || nodesMissing,
            }, t(blank ? 'create' : 'templateClone')),
            h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', type: 'button', name: 'template.form.cancel', disabled: busy, onClick: () => onAttemptClose() }, t('cancel')))))
    }

    /**
     * Role management: the recorded roles, the ids in use but unrecorded, the
     * presets that resolve to them, and the panel's only write path into the
     * roles table (`put`/`delete`).
     *
     * A temporary role is shown with what delegation bound it to, and typed in,
     * because the task that minted it owns its lifetime; an unrecorded row can
     * be registered here, which is the only way a requirement's dangling role id
     * stops reading as unregistered.
     *
     * The dialog reads as two columns because the question it answers is an
     * association: the left column is every role (recorded, temporary, in use but
     * unrecorded) and the right column is every declared preset with the role its
     * sessions resolve to. Each column searches and scrolls on its own, so a long
     * pair of lists never scrolls one against the other. The roster is read when
     * the dialog opens and again after a `put` or `delete`, so a registration
     * this panel just made stops reading as one still to make.
     *
     * Writes report where they were asked for: a refused save in the form dialog,
     * a refused delete on its own row, and a refused roster read as the roster
     * section's degraded state. Role management therefore takes the command path
     * directly rather than the page's shared `run`, whose error branch raises the
     * overlay toast.
     */
    function RolesDialog({ roles, status, busy, invoke, onClose, t }) {
      const [confirmId, setConfirmId] = useState(null)
      const [rowErrors, setRowErrors] = useState({})
      const [form, setForm] = useState(null)
      const [discard, setDiscard] = useState(false)
      const [formError, setFormError] = useState(null)
      const [roleQuery, setRoleQuery] = useState('')
      const [presetQuery, setPresetQuery] = useState('')
      // `null` is "still reading": the preset roster is read when the dialog
      // opens, because the registry audits every preset as it lists them and the
      // board's own read path must not wait on that.
      const [presets, setPresets] = useState(null)
      const live = useRef(true)
      const items = roles?.items ?? []
      const unregistered = roles?.unregistered ?? []
      /**
       * Read the preset roster: when the dialog opens, and again after a write
       * that changes which presets have a role record — otherwise the section
       * keeps offering a registration the Host has already recorded, or hides
       * one it no longer has. A read the Host refuses becomes the section's own
       * degraded state, with the Host's reason, rather than an overlay toast.
       */
      const loadPresets = async () => {
        const result = await invoke('role.list')
        if (!live.current) return
        const roster = result.ok && result.data !== null && typeof result.data === 'object'
          ? result.data.presets
          : null
        // A roster the Host did not answer with is a degraded section, not an
        // empty one: "no presets declared" and "cannot read them" are different
        // facts and the panel states which one it has.
        setPresets(roster ?? {
          items: [],
          unavailable: {
            code: 'read-failed',
            detail: result.ok ? '' : String(result.error?.message ?? result.error ?? ''),
          },
        })
      }
      useEffect(() => {
        // One read per dialog open. The dialog is mounted per open, so the first
        // render's `invoke` is the one to use; depending on it would re-read
        // without a new open whenever the locale changed its identity. The
        // liveness flag is re-armed on every mount because a ref outlives one in
        // the test renderer's slot reuse.
        live.current = true
        void loadPresets()
        return () => { live.current = false }
      }, [])

      /**
       * Open the form dialog over one starting value.
       *
       * `target` names the row the form addresses, so the list can mark it while
       * the form is open: the role itself for an edit, the preset for a
       * registration, and nothing for a role that has no row yet.
       */
      const openForm = (mode, target, value) => {
        setForm({ mode, target, initial: value, value })
        setDiscard(false)
        setFormError(null)
      }
      /** Edit one existing role; the id stays pinned to the record being edited. */
      const startEdit = record => openForm('edit', { kind: 'role', id: record.id }, {
        roleId: record.id,
        roleName: record.name ?? record.id,
        duties: [...(record.duties ?? [])],
      })
      /** Register an unrecorded role, prefilled from the preset that named it. */
      const registerPreset = preset => openForm('preset', { kind: 'preset', id: preset.id }, {
        roleId: preset.roleId,
        roleName: preset.name === '' ? preset.id : preset.name,
        duties: [''],
      })
      const patchForm = patch => {
        // A refusal belongs to the draft that caused it, so editing clears it.
        setFormError(null)
        setForm(current => current === null ? null : { ...current, value: { ...current.value, ...patch } })
      }
      const changeDuty = (index, text) => setForm(current => current === null ? null : {
        ...current,
        value: {
          ...current.value,
          duties: current.value.duties.map((duty, at) => (at === index ? text : duty)),
        },
      })
      const addDuty = () => setForm(current => current === null ? null : {
        ...current,
        value: { ...current.value, duties: [...current.value.duties, ''] },
      })
      const removeDuty = index => setForm(current => current === null ? null : ({
        ...current,
        value: {
          ...current.value,
          duties: [...current.value.duties.slice(0, index), ...current.value.duties.slice(index + 1)],
        },
      }))
      const dropForm = () => {
        setForm(null)
        setDiscard(false)
        setFormError(null)
      }
      /**
       * The form dialog's own close control, standing in for cancel, Escape, and
       * the mask. A changed draft asks first; while that confirmation is up, this
       * path takes the confirmation back instead of the input, so discarding
       * stays an explicit act.
       */
      const attemptCloseForm = () => {
        if (discard) {
          setDiscard(false)
          return
        }
        if (form !== null && !sameRoleDraft(form.value, form.initial)) {
          setDiscard(true)
          return
        }
        dropForm()
      }
      /** Save the draft; a refusal lands in the form dialog, never as a toast. */
      const submitForm = async () => {
        if (form === null) return
        const { duties } = mergedDuties(form.value.duties)
        const result = await invoke('role.put', {
          role: { roleId: form.value.roleId.trim(), roleName: form.value.roleName.trim(), duties },
        })
        if (!result.ok) {
          setFormError(String(result.error?.message ?? result.error ?? ''))
          return
        }
        dropForm()
        void loadPresets()
      }
      /** Delete one role; a refusal lands on that row. */
      const deleteRole = async id => {
        const result = await invoke('role.delete', { id })
        if (!result.ok) {
          setRowErrors(current => ({ ...current, [id]: String(result.error?.message ?? result.error ?? '') }))
          return
        }
        setRowErrors(current => {
          const next = { ...current }
          delete next[id]
          return next
        })
        setConfirmId(null)
        void loadPresets()
      }

      const presence = record => {
        const holders = record.holders
        if (holders?.online === null || holders?.online === undefined) return t('roleHoldersUnknown')
        // Idle is online minus running, so the row states it only when a holder is executing.
        if (holders.online === 0) return t('roleNoHolders')
        const online = interpolate(t('roleHoldersCount'), { count: holders.online })
        return (holders.running ?? 0) > 0
          ? `${online} · ${interpolate(t('roleRunningCount'), { count: holders.running })}`
          : online
      }

      /** Whether the form dialog addresses one named row, and in which column. */
      const addressed = (kind, id) => form !== null && form.target.kind === kind && form.target.id === id

      /** One row's own delete confirmation and its own refusal, both in its subtree. */
      const rowTail = record => [
        confirmId === record.id
          ? h('div', { key: 'confirm', className: 'rb-role-confirm' },
            h('div', null, t('removeRoleConfirm')),
            h('div', { className: 'rb-row' },
              h(Button, {
                variant: 'outline',
                className: 'rb-btn rb-btn-danger',
                name: `role.confirm.${record.id}`,
                disabled: busy,
                onClick: () => void deleteRole(record.id),
              }, t('confirm')),
              h(Button, {
                className: 'rb-btn-pad rb-btn',
                variant: 'ghost',
                name: `role.confirm.cancel.${record.id}`,
                onClick: () => setConfirmId(null),
              }, t('cancel'))))
          : null,
        typeof rowErrors[record.id] === 'string'
          ? h('div', { key: 'error', className: 'rb-form-error', name: `role.row.error.${record.id}` },
            h('div', null, t('roleRowError')),
            h('div', null, rowErrors[record.id]))
          : null,
      ]

      const row = (record, unrecorded) => h('div', {
        key: record.id,
        className: `rb-role-row${addressed('role', record.id) ? ' rb-role-row-editing' : ''}`,
        'aria-current': addressed('role', record.id) ? 'true' : undefined,
      },
        h('div', { className: 'rb-role-head' },
          h('span', { className: 'rb-role-name' }, record.name ?? record.id),
          h(Tag, { tone: 'outline' }, record.id),
          record.ephemeral === true ? h(Tag, { tone: 'warning' }, t('roleEphemeral')) : null,
          record.ephemeral !== true && typeof ROLE_SOURCE_KEYS[record.source] === 'string'
            ? h(Tag, { tone: 'neutral' }, t(ROLE_SOURCE_KEYS[record.source]))
            : null,
          unrecorded || record.dutiesMissing === true
            ? h(Tag, { tone: unrecorded ? 'danger' : 'warning' },
              unrecorded ? t('roleUnregistered') : t('roleDutiesMissing'))
            : null,
          h('span', { className: 'rb-grow' }),
          record.ephemeral !== true
            ? h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
name: `role.edit.${record.id}`,
              disabled: busy,
              onClick: () => startEdit(record),
            }, t('edit'))
            : null,
          !unrecorded && record.ephemeral !== true
            ? h(Button, {
              variant: 'outline',
              size: 'sm',
              className: 'rb-btn-sm rb-btn rb-btn-danger',
name: `role.remove.${record.id}`,
              disabled: busy,
              onClick: () => setConfirmId(record.id),
            }, t('removeRole'))
            : null),
        (record.duties ?? []).length > 0
          ? h('div', { className: 'rb-duties' }, record.duties.map(duty => h(Tag, { key: duty, tone: 'outline' }, duty)))
          : null,
        h('div', { className: 'rb-card-meta' },
          h('span', null, `${interpolate(t('roleOpen'), { count: record.open ?? 0 })} · ${presence(record)}`)),
        record.boundSession !== undefined || record.boundTask !== undefined
          ? h('div', { className: 'rb-card-meta' },
            record.boundSession !== undefined ? h('span', null, `${t('roleBoundSession')}: ${record.boundSession}`) : null,
            record.boundTask !== undefined ? h('span', null, `${t('roleBoundTask')}: ${record.boundTask}`) : null)
          : null,
        rowTail(record))

      /** One declared preset and the role its sessions resolve to. */
      const presetRow = preset => h('div', {
        key: `preset.${preset.id}`,
        className: 'rb-role-row rb-preset-row',
        'aria-current': addressed('preset', preset.id) ? 'true' : undefined,
      },
        h('div', { className: 'rb-role-head' },
          h('span', { className: 'rb-role-name' }, preset.name === '' ? preset.id : preset.name),
          h(Tag, { tone: 'outline' }, preset.id),
          preset.broken !== '' ? h('span', { title: preset.broken }, h(Tag, { tone: 'danger' }, t('presetBroken'))) : null,
          // One state tag: a preset id that cannot be a role id has nothing to
          // register, an unrecorded role is what the register button addresses,
          // and a recorded role missing its duties is the same degradation the
          // role rows report.
          preset.roleId === ''
            ? h(Tag, { tone: 'danger' }, t('presetRoleInvalid'))
            : preset.recorded === false
              ? h(Tag, { tone: 'warning' }, t('presetUnregistered'))
              : preset.dutiesMissing === true
                ? h(Tag, { tone: 'warning' }, t('roleDutiesMissing'))
                : null,
          h('span', { className: 'rb-grow' }),
          preset.roleId !== '' && preset.recorded === false
            ? h(Button, {
              className: 'rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn',
              variant: 'primary',
              size: 'sm',
              name: `preset.register.${preset.id}`,
              disabled: busy,
              onClick: () => registerPreset(preset),
            }, t('presetRegister'))
            : null),
        h('div', { className: 'rb-card-meta' },
          h('span', null, `${t('filterRole')}: ${preset.roleId === '' ? '—' : roleName(preset.roleId, roles)}`),
          h('span', null, interpolate(t('presetSessions'), { count: preset.online ?? 0 })),
          h('span', null, interpolate(t('roleOpen'), { count: preset.open ?? 0 })),
          preset.confirmed === false && preset.roleId !== ''
            ? h('span', null, t('presetInferred'))
            : null))

      const loaded = items.length > 0 || unregistered.length > 0

      /**
       * One group's heading with the count of the rows below it.
       *
       * A real heading element rather than a styled row: a group and its count
       * are the outline of what is on screen, so a reader, an accessibility
       * tool, and a browser gate all find that group's rows from its heading.
       */
      const groupHead = (label, count) => h('h3', { className: 'rb-group-head' },
        h('span', { className: 'rb-group-name' }, label),
        ' ',
        h('span', { className: 'rb-group-n' }, String(count)))

      // Search is a reading of the lists, never a filter on the wire, and an
      // empty box filters nothing; matching is a trimmed, case-insensitive
      // substring over the fields a reader would name a row by.
      const hits = (query, fields) => query === ''
        || fields.some(field => String(field ?? '').trim().toLowerCase().includes(query))
      const needle = query => query.trim().toLowerCase()
      const dutiesOf = roleId => (items.find(record => record.id === roleId)?.duties ?? [])
      const shownRoles = list => list.filter(record => hits(needle(roleQuery), [record.id, record.name, ...(record.duties ?? [])]))
      const registered = shownRoles(items.filter(record => record.ephemeral !== true))
      const ephemeral = shownRoles(items.filter(record => record.ephemeral === true))
      const unrecorded = shownRoles(unregistered)
      const rosterReadable = presets !== null && (presets.unavailable === null || presets.unavailable === undefined)
      const shownPresets = rosterReadable
        ? (presets.items ?? []).filter(preset => hits(needle(presetQuery),
          [preset.id, preset.name, preset.roleId, preset.roleName, ...dutiesOf(preset.roleId)]))
        : []

      /**
       * The left column: the three groups, each stating its filtered count.
       *
       * "No role is recorded at all" and "nothing matches this search" are
       * different facts; the second cannot be read off the first because the
       * first is decided before the search runs.
       */
      const roleColumn = () => {
        if (status === 'loading' && !loaded) {
          return h('div', { className: 'rb-skeleton' }, [0, 1, 2].map(index => h('div', {
            key: index,
            className: 'rb-skeleton-row',
            style: { width: `${90 - index * 18}%` },
          })))
        }
        if (!loaded) return h('div', { className: 'rb-muted' }, t('rolesEmpty'))
        if (registered.length === 0 && ephemeral.length === 0 && unrecorded.length === 0) {
          return h('div', { className: 'rb-muted' }, t('rolesNoMatch'))
        }
        const group = (label, records, missing) => records.length === 0 ? null : h('div', {
          key: label,
          className: 'rb-group',
        }, groupHead(label, records.length), records.map(record => row(record, missing)))
        return [
          group(t('roleGroupRegistered'), registered, false),
          group(t('roleGroupEphemeral'), ephemeral, false),
          group(t('rolesUnregistered'), unrecorded, true),
        ]
      }

      /**
       * The right column: one section, `rolePresets`, titled with the count of
       * the presets the search left.
       *
       * Three states stay apart, and none of them changes because of a search
       * term: still reading, unreadable (with the Host's own reason), and read.
       * An empty roster is a fact about the deployment — no preset is declared —
       * and is stated as one rather than shown as nothing.
       */
      const rosterColumn = () => {
        if (presets === null) {
          return h('div', { className: 'rb-muted rb-preset-empty' }, t('presetsReading'))
        }
        if (presets.unavailable !== null && presets.unavailable !== undefined) {
          return h('div', { className: 'rb-muted rb-preset-empty' },
            h('div', null, t(presets.unavailable.code === 'service-absent' ? 'presetsUnavailableAbsent' : 'presetsUnavailableFailed')),
            typeof presets.unavailable.detail === 'string' && presets.unavailable.detail !== ''
              ? h('div', null, presets.unavailable.detail)
              : null)
        }
        const title = groupHead(t('rolePresets'), shownPresets.length)
        if ((presets.items ?? []).length === 0) {
          return h('div', { className: 'rb-group' }, title,
            h('div', { className: 'rb-muted rb-preset-empty' }, t('presetsEmpty')))
        }
        if (shownPresets.length === 0) {
          return h('div', { className: 'rb-group' }, title,
            h('div', { className: 'rb-muted rb-preset-empty' }, t('presetsNoMatch')))
        }
        return h('div', { className: 'rb-group' }, title, shownPresets.map(presetRow))
      }

      /** One column's head and its own search box. */
      const columnSearch = (label, name, value, placeholder, onChange) => [
        h('div', { key: 'head', className: 'rb-roles-col-head' },
          h('span', { className: 'rb-group-name' }, label)),
        h('div', { key: 'search', className: 'rb-roles-search' }, h(Input, {
          name,
          value,
          placeholder,
          'aria-label': placeholder,
          onChange: event => onChange(event.target.value),
        })),
      ]

      return h(Dialog, {
        title: t('roles'),
        className: 'rb-dialog-roles',
        closeLabel: t('close'),
        onClose,
        footer: [
          h(Button, {
            className: 'rb-btn-pad rb-btn',
            variant: 'ghost',
            key: 'new',
            name: 'role.new',
            disabled: busy,
            onClick: () => openForm('new', { kind: 'new', id: '' }, { roleId: '', roleName: '', duties: [''] }),
          }, t('newRole')),
          h('span', { key: 'grow', className: 'rb-grow' }),
          h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', key: 'close', onClick: onClose}, t('close')),
        ],
      },
        h('div', { className: 'rb-roles-grid' },
          h('div', { className: 'rb-roles-col' },
            ...columnSearch(t('rolesColumn'), 'role.search', roleQuery, t('roleSearch'), setRoleQuery),
            h('div', { key: 'rows', className: 'rb-roles-scroll' }, roleColumn())),
          h('div', { className: 'rb-roles-col' },
            ...columnSearch(t('presetsColumn'), 'preset.search', presetQuery, t('presetSearch'), setPresetQuery),
            h('div', { key: 'rows', className: 'rb-roles-scroll' }, rosterColumn()))),
        form === null ? null : h(RoleFormDialog, {
          form,
          discard,
          busy,
          error: formError,
          merged: mergedDuties(form.value.duties).merged,
          t,
          onPatch: patchForm,
          onDutyChange: changeDuty,
          onDutyAdd: addDuty,
          onDutyRemove: removeDuty,
          onAttemptClose: attemptCloseForm,
          onDrop: dropForm,
          onKeep: () => setDiscard(false),
          onSave: () => void submitForm(),
        }))
    }

    /** The sidebar entry: the panel id's icon and accessible label. */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h('svg', {
        className: 'rb-icon',
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        h('rect', { x: 3, y: 4, width: 7, height: 6, rx: 1.5 }),
        h('rect', { x: 14, y: 4, width: 7, height: 6, rx: 1.5 }),
        h('rect', { x: 8.5, y: 14, width: 7, height: 6, rx: 1.5 }),
        h('path', { d: 'M10 7h4M12 10v4' }))
    }


    /** Tag tone for each requirement status. */
    const STATUS_TONES = { active: 'info', blocked: 'danger', done: 'success', archived: 'neutral' }

    /** Tag tone for each stored priority: only the two urgent levels stand out. */
    const PRIORITY_TONES = { high: 'warning', urgent: 'warning' }

    /** Status badge, localized. */
    function StatusBadge({ status, t }) {
      const key = { active: 'statusActive', blocked: 'statusBlocked', done: 'statusDone', archived: 'statusArchived', pending: 'statusPending' }[status] ?? 'statusPending'
      return h(Tag, { tone: STATUS_TONES[status] ?? 'outline' }, t(key))
    }

    /** Priority badge. */
    function PriorityBadge({ priority, t }) {
      const key = { low: 'priorityLow', normal: 'priorityNormal', high: 'priorityHigh', urgent: 'priorityUrgent' }[priority] ?? 'priorityNormal'
      return h(Tag, { tone: PRIORITY_TONES[priority] ?? 'outline' }, t(key))
    }

    /**
     * The role a requirement is routed to; a requirement open to all shows none.
     *
     * `unregistered` marks a routing the board has no role record for: the
     * requirement is really routed to that id, so the badge warns instead of
     * showing a bare id that reads like a registered role (§3.4).
     */
    function RoleBadge({ role, roles, unregistered, t }) {
      if (role === undefined || role === '') return null
      const title = unregistered === true ? `${role} · ${t('roleUnregistered')}` : role
      return h('span', { title }, h(Tag, { tone: unregistered === true ? 'warning' : 'info' }, roleName(role, roles)))
    }

    /** A decision requirement: the person decides it, no session may. */
    function KindBadge({ kind, t }) {
      if (kind !== 'decision') return null
      return h('span', { title: t('viewDecisionsHint') }, h(Tag, { tone: 'warning' }, t('decisionBadge')))
    }

    /** A soft reservation held by one session, named from the snapshot's join. */
    function ReservedBadge({ reservedBy, t }) {
      if (reservedBy === null || reservedBy === undefined || reservedBy === '') return null
      return h('span', { title: t('queueSoftHint') }, h(Tag, { tone: 'info' }, `${t('reservedBadge')}: ${reservedBy}`))
    }

    /** One requirement handed to a named session. */
    function DelegatedBadge({ delegatedTo, t }) {
      if (delegatedTo === null || delegatedTo === undefined) return null
      const who = delegatedTo.name === undefined || delegatedTo.name === '' ? delegatedTo.session : `${delegatedTo.name} (${delegatedTo.session})`
      return h('span', { title: t('delegation') }, h(Tag, { tone: 'success' }, `${t('delegatedBadge')}: ${who}`))
    }

    /** Unfinished work this requirement waits on before it may advance. */
    function GatedBadge({ gated, blockedBy, t }) {
      if (gated !== true) return null
      const blockers = Array.isArray(blockedBy) ? blockedBy : []
      return h('span', { title: `${t('blockedByTitle')}: ${blockers.join(', ')}` },
        h(Tag, { tone: 'danger' }, t('gatedBadge', { count: blockers.length })))
    }

    /** Declared blockers, whether or not they are still unfinished. */
    function BlocksBadge({ blocksOn, t }) {
      const links = Array.isArray(blocksOn) ? blocksOn : []
      if (links.length === 0) return null
      return h('span', { title: `${t('blocksOnTitle')}: ${links.join(', ')}` },
        h(Tag, { tone: 'outline' }, t('blocksBadge', { count: links.length })))
    }

    /**
     * The requirement reads at a level raised by the work it holds up.
     *
     * `effectivePriority` is derived on every read and never stored, so the badge
     * names the effective level and says the stored one is untouched — a reader
     * must not conclude the priority was changed.
     */
    function CriticalBadge({ escalated, effectivePriority, priority, t }) {
      if (escalated !== true || typeof effectivePriority !== 'string' || effectivePriority === '') return null
      return h('span', { title: t('priorityLiftedHint') },
        h(Tag, { tone: 'warning' }, `${t('criticalTag')}: ${effectivePriority}↑`))
    }

    /**
     * The two eligibility answers, each labeled with the reading it was asked for.
     *
     * `claimable` and `advanceable` answer different questions — whether this
     * session could take the requirement now, and whether it could move it on —
     * so they are shown as two badges, never merged into one "can do". A read
     * that named a session reports both; one that did not reports neither, and
     * nothing is guessed. `advanceable` has no fallback: the id set the panel
     * reads separately answers `claimable` only.
     */
    function EligibilityBadges({ item, me, claimableIds, t }) {
      const reading = me === undefined || me === null || me === '' ? t('eligibilityPanel') : me
      const label = t('eligibilityFor', { me: reading })
      const claimable = typeof item.claimable === 'boolean'
        ? item.claimable
        : claimableIds === null || claimableIds === undefined ? undefined : claimableIds.has(item.id)
      const badges = []
      if (claimable !== undefined) {
        badges.push(h('span', { key: 'claimable', title: `${t('claimableHint')} · ${label}` },
          h(Tag, { tone: claimable ? 'success' : 'outline' }, claimable ? t('claimableYes') : t('claimableNo'))))
      }
      if (typeof item.advanceable === 'boolean') {
        badges.push(h('span', { key: 'advanceable', title: `${t('advanceableHint')} · ${label}` },
          h(Tag, { tone: item.advanceable ? 'info' : 'outline' }, item.advanceable ? t('advanceableYes') : t('advanceableNo'))))
      }
      return badges.length === 0 ? null : h('span', { className: 'rb-badge-group' }, badges)
    }

    /* Chart geometry, in integer pixels, shared by the node boxes and the SVG
     * edge overlay so an edge always meets the exact box edges it connects. */
    const FLOW_NODE_WIDTH = 150
    const FLOW_NODE_HEIGHT = 62
    const FLOW_COLUMN_GAP = 54
    const FLOW_ROW_GAP = 12

    /**
     * The flow chart.
     *
     * Nodes are laid out as a layered graph: every node sits one column right of
     * its latest prerequisite, and siblings of a column stack below each other, so
     * the columns read as the requirement's actual progress order rather than the
     * template's listing order. Every declared `dependsOn` pair gets its own bezier
     * edge with an arrowhead, so a join into one node is visible as two inbound
     * edges. Clicking a node selects it for the detail panel.
     */
    function FlowChart({ requirement, selectedNodeId, onSelect, t }) {
      const flow = requirement.flow
      if (flow.length === 0) return null
      const byId = new Map(flow.map(node => [node.id, node]))
      // Longest path from a root: a node's column clears every prerequisite.
      // Templates are acyclic (the Host rejects cycles), so the recursion ends.
      const columns = new Map()
      const columnOf = node => {
        const known = columns.get(node.id)
        if (known !== undefined) return known
        const parents = node.dependsOn.filter(id => byId.has(id))
        const column = parents.length === 0 ? 0 : Math.max(...parents.map(id => columnOf(byId.get(id)))) + 1
        columns.set(node.id, column)
        return column
      }
      // Rows fill each column in listing order, so no two boxes overlap.
      const rows = new Map()
      const nextRow = new Map()
      for (const node of flow) {
        const column = columnOf(node)
        const row = nextRow.get(column) ?? 0
        rows.set(node.id, row)
        nextRow.set(column, row + 1)
      }
      const xOf = node => columns.get(node.id) * (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP)
      const yOf = node => rows.get(node.id) * (FLOW_NODE_HEIGHT + FLOW_ROW_GAP)

      const edges = []
      const lanes = []
      for (const node of flow) {
        const targetColumn = columns.get(node.id)
        const targetX = xOf(node)
        const targetY = yOf(node) + FLOW_NODE_HEIGHT / 2
        for (const id of node.dependsOn) {
          const parent = byId.get(id)
          if (parent === undefined) continue
          const sourceColumn = columns.get(parent.id)
          const sourceX = xOf(parent) + FLOW_NODE_WIDTH
          const sourceY = yOf(parent) + FLOW_NODE_HEIGHT / 2
          let path
          if (targetColumn - sourceColumn === 1) {
            const bend = Math.max(14, (targetX - sourceX) / 2)
            path = `M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY}, ${targetX - bend} ${targetY}, ${targetX} ${targetY}`
          } else {
            // A dependency that skips steps would cut through the boxes it spans, so
            // it dips beneath them. Both the descent and the rise finish within half
            // a column gap, which keeps them clear of the intervening columns; the
            // arrival stays horizontal, so the arrowhead still points right.
            const between = flow.filter(other => columns.get(other.id) > sourceColumn && columns.get(other.id) < targetColumn)
            const laneY = (between.length === 0
              ? Math.max(sourceY, targetY) + FLOW_NODE_HEIGHT
              : Math.max(...between.map(other => yOf(other) + FLOW_NODE_HEIGHT))) + FLOW_ROW_GAP / 2
            lanes.push(laneY)
            const reach = Math.min((FLOW_COLUMN_GAP - 6) / 2, (targetX - sourceX) / 4)
            path = `M ${sourceX} ${sourceY}`
              + ` C ${sourceX + reach} ${sourceY}, ${sourceX + reach} ${laneY}, ${sourceX + 2 * reach} ${laneY}`
              + ` L ${targetX - 2 * reach} ${laneY}`
              + ` C ${targetX - reach} ${laneY}, ${targetX - reach} ${targetY}, ${targetX} ${targetY}`
          }
          edges.push({
            key: `${id}->${node.id}`,
            done: parent.status === 'done',
            path,
            head: `${targetX},${targetY} ${targetX - 6},${targetY - 4} ${targetX - 6},${targetY + 4}`,
          })
        }
      }

      const width = Math.max(...flow.map(xOf)) + FLOW_NODE_WIDTH
      const nodeBottom = Math.max(...flow.map(yOf)) + FLOW_NODE_HEIGHT
      const laneBottom = lanes.length === 0 ? 0 : Math.max(...lanes) + FLOW_ROW_GAP / 2
      const height = Math.max(nodeBottom, laneBottom)

      return h('div', { className: 'rb-flow', role: 'group', 'aria-label': t('flow') },
        h('div', { className: 'rb-flow-canvas', style: { width: `${width}px`, height: `${height}px` } },
          h('svg', {
            className: 'rb-flow-edges',
            width,
            height,
            viewBox: `0 0 ${width} ${height}`,
            'aria-hidden': true,
          }, edges.map(edge => h('g', { key: edge.key, className: edge.done ? 'rb-edge rb-edge-done' : 'rb-edge' },
            h('path', { className: 'rb-edge-path', d: edge.path }),
            h('polygon', { className: 'rb-edge-head', points: edge.head })))),
          flow.map((node, index) => {
            const parents = node.dependsOn.filter(id => byId.has(id)).map(id => byId.get(id).name)
            const meta = []
            if (node.assignee !== '') meta.push(node.assignee)
            if (node.completion?.type === 'checklist') meta.push(`${node.checks.filter(Boolean).length}/${node.checks.length}`)
            const mark = node.status === 'done' ? '✔' : node.status === 'active' ? '◐' : '○'
            return h('button', {
              key: node.id,
              type: 'button',
              className: `rb-node rb-node-${node.status}${node.id === selectedNodeId ? ' rb-node-picked' : ''}`,
              style: {
                left: `${xOf(node)}px`,
                top: `${yOf(node)}px`,
                width: `${FLOW_NODE_WIDTH}px`,
                height: `${FLOW_NODE_HEIGHT}px`,
              },
              onClick: () => onSelect(node.id),
              'aria-pressed': node.id === selectedNodeId,
              title: parents.length === 0 ? node.name : `${node.name} · ${t('dependencies')}: ${parents.join(', ')}`,
            },
              h('div', { className: 'rb-node-mark' }, `${mark} ${index + 1}/${flow.length}`),
              h('div', { className: 'rb-node-name' }, node.name),
              meta.length > 0 ? h('div', { className: 'rb-node-meta' }, meta.join(' · ')) : null)
          })))
    }

    /**
     * Statistics strip: completion rate, status counts, blockers, stalls, and
     * the coordination counters the Host only reports once the stage that owns
     * each one has landed.
     *
     * Every later counter is behind its own presence check: a snapshot from a
     * build without `byKind` or `reserved` renders the cells it does carry
     * rather than a fabricated zero.
     */
    /**
     * The KPI band: a completion ring, the five readings that decide what to do
     * next, one alert tile, and a secondary strip for the rest. Only the
     * arrangement is new — every reading still comes from the same `stats`
     * payload, and none of the Host's counters changed.
     */
    /**
     * The KPI band.
     *
     * The readings that name a set the board can be filtered to are controls:
     * they write the ordinary filter the filter area writes, so the chip that
     * appears is the receipt and the page keeps one source of truth. Readings
     * with no matching filter (completion rate, totals, stalled, queue, execution
     * sync) stay read-only: the panel has no "stalled only" or "queued only"
     * filter, and a control that cannot produce the list it names is worse than
     * a number.
     */
    function StatsStrip({ stats, roles, t, filter, setFilter }) {
      /** Whether the zero readings' popover is open (v3 §3 V3-6). */
      const [moreOpen, setMoreOpen] = useState(false)
      if (stats === null) return null
      const rate = Math.round(stats.completionRate * 100)
      const circumference = 2 * Math.PI * 24
      const done = stats.byStatus.done ?? 0
      const tiles = [
        { label: t('total'), value: String(stats.total) },
        { label: t('statusActive'), value: String(stats.byStatus.active ?? 0), filter: 'active' },
        { label: t('statusBlocked'), value: String(stats.byStatus.blocked ?? 0), filter: 'blocked' },
        { label: t('statusDone'), value: String(done), filter: 'done' },
        { label: t('blockedTitle'), value: String(stats.blocked.length), warn: stats.blocked.length > 0 },
      ]
      const sub = []
      if (stats.byKind !== undefined) {
        sub.push(
          { label: t('statsUnfinished'), value: String(stats.total - done) },
          { label: t('kindTask'), value: String(stats.byKind.task ?? 0) },
          { label: t('kindDecision'), value: String(stats.byKind.decision ?? 0), warn: (stats.byKind.decision ?? 0) > 0, filter: 'decision' },
        )
      }
      if (typeof stats.queued === 'number') sub.push({ label: t('statsQueued'), value: String(stats.queued) })
      // The critical path is the requirements whose level the work they hold up
      // raised — the same set each `escalated` row marks, counted by the Host.
      if (typeof stats.criticalPath === 'number') {
        sub.push({ label: t('criticalPath'), value: String(stats.criticalPath), warn: stats.criticalPath > 0 })
      }
      if (typeof stats.reserved === 'number') sub.push({ label: t('statsReserved'), value: String(stats.reserved), warn: stats.reserved > 0 })
      if (typeof stats.pendingDelegations === 'number') {
        sub.push({ label: t('statsPendingDelegations'), value: String(stats.pendingDelegations), warn: stats.pendingDelegations > 0 })
      }
      if (typeof stats.orphanedLocks === 'number') {
        sub.push({ label: t('statsOrphanedLocks'), value: String(stats.orphanedLocks), warn: stats.orphanedLocks > 0 })
      }
      // §5.6's execution readings. Both count what was observed rather than what
      // a document says, so they are read straight off the host's counters.
      if (typeof stats.running === 'number') {
        sub.push({ label: t('statsRunning'), value: String(stats.running) })
      }
      if (stats.execSync !== undefined && stats.execSync !== null) {
        const gaps = stats.execSync.gaps ?? 0
        const ignored = stats.execSync.ignored ?? 0
        sub.push({ label: t('statsExecGaps'), value: String(gaps), warn: gaps > 0 })
        if (ignored > 0) sub.push({ label: t('statsExecIgnored'), value: String(ignored) })
      }
      const stalled = stats.stalled.length
      const tally = Array.isArray(stats.byRole) ? stats.byRole.filter(row => (row.total ?? 0) > 0).slice(0, 6) : []
      // v3 §3 V3-6: a zero reading names an empty set, so the first screen keeps
      // only the readings that name something; the zeros wait in a popover one
      // click away. The decision count keeps its own filter even in there.
      const shown = sub.filter(cell => cell.value !== '0')
      const hidden = sub.filter(cell => cell.value === '0')
      /** One sub-reading; inside the popover, any click on it also closes it. */
      const subReading = (cell, insidePop) => cell.filter === 'decision'
        ? h('button', {
          key: cell.label,
          type: 'button',
          name: 'stats.decision',
          className: `rb-submetric rb-submetric-action${filter.kind === 'decision' ? ' rb-submetric-on' : ''}`,
          'aria-pressed': filter.kind === 'decision',
          title: t('statsFilterHint'),
          // Deciding shows the open decisions: the default reading, so the
          // count the tile reports and the list it opens agree.
          onClick: () => {
            setFilter({ kind: filter.kind === 'decision' ? '' : 'decision', status: 'open' })
            if (insidePop) setMoreOpen(false)
          },
        },
          h('span', { className: 'rb-stat-label' }, cell.label),
          h('b', { className: cell.warn === true ? 'rb-warn' : undefined }, cell.value))
        : h('span', {
          key: cell.label,
          className: 'rb-submetric',
          onClick: insidePop ? () => setMoreOpen(false) : undefined,
        },
          h('span', { className: 'rb-stat-label' }, cell.label),
          h('b', { className: cell.warn === true ? 'rb-warn' : undefined }, cell.value))
      return h('div', { className: 'rb-kpi' },
        h('div', { className: 'rb-stats' },
          h('div', { className: 'rb-stat rb-stat-hero' },
            h('div', { className: 'rb-ring' },
              h('svg', { width: 56, height: 56, viewBox: '0 0 56 56', 'aria-hidden': 'true' },
                h('circle', { className: 'rb-ring-track', cx: 28, cy: 28, r: 24 }),
                h('circle', {
                  className: 'rb-ring-fill', cx: 28, cy: 28, r: 24,
                  style: { strokeDasharray: `${(circumference * rate / 100).toFixed(2)} ${circumference.toFixed(2)}` },
                })),
              h('div', { className: 'rb-ring-pct' }, `${rate}%`)),
            h('div', { className: 'rb-hero-text' },
              h('div', { className: 'rb-stat-label' }, t('completionRate')),
              h('div', { className: 'rb-hero-frac' },
                `${t('statusDone')} `, h('b', null, String(done)), ' / ', h('b', null, String(stats.total))))),
          tiles.map(tile => {
            const reading = h('div', { className: 'rb-stat-label' }, tile.label)
            const value = h('div', {
              className: `rb-stat-value${tile.warn ? ' rb-warn' : ''}`,
              'data-zero': tile.value === '0' ? 'true' : undefined,
            }, tile.value)
            if (tile.filter === undefined) return h('div', { key: tile.label, className: 'rb-stat' }, reading, value)
            const on = filter.status === tile.filter
            return h('button', {
              key: tile.label,
              type: 'button',
              name: `stats.${tile.filter}`,
              className: `rb-stat rb-stat-action${on ? ' rb-stat-on' : ''}`,
              'aria-pressed': on,
              title: t('statsFilterHint'),
              // A status reading replaces the kind reading: the two narrow the
              // same list along different axes, and keeping a leftover kind from
              // an earlier click would show a list this tile does not name.
              onClick: () => setFilter({ status: on ? 'open' : tile.filter, kind: '' }),
            }, reading, value)
          }),
          // The alert tile is a reading, not a control: it carries no click
          // target because the panel has no "stalled only" filter to open.
          h('div', { className: `rb-stat rb-stat-alert${stalled > 0 ? '' : ' rb-stat-alert-clear'}` },
            h('div', { className: 'rb-stat-label' }, t('stalledTitle')),
            h('div', { className: 'rb-stat-value', 'data-zero': stalled === 0 ? 'true' : undefined }, String(stalled)),
            stalled > 0 ? h('div', { className: 'rb-go' }, t('statsAlertHint')) : null)),
        sub.length === 0 && tally.length === 0 ? null : h('div', { className: 'rb-submetrics' },
          // Each reading keeps a label node beside its value node: the strip is
          // the same reading as a tile, only placed second.
          shown.map(cell => subReading(cell, false)),
          hidden.length === 0 ? null : h('button', {
            type: 'button',
            name: 'stats.more',
            className: 'rb-submetric rb-submetric-action',
            'aria-expanded': moreOpen,
            onClick: () => setMoreOpen(current => !current),
          },
            h('span', { className: 'rb-stat-label' }, t('moreReadings')),
            h('b', null, String(hidden.length))),
          moreOpen && hidden.length > 0
            ? h('div', { className: 'rb-sub-pop' }, hidden.map(cell => subReading(cell, true)))
            : null,
          tally.length === 0 ? null : h('span', { className: 'rb-role-tally' },
            h('span', { className: 'rb-field-label' }, t('statsByRole')),
            tally.map(row => h(Tag, { key: row.role === '' ? '(none)' : row.role, tone: 'outline' },
              `${row.role === '' ? t('roleNone') : roleName(row.role, roles)} ${row.total}`)))))
    }

    /** One node's detail: condition, checklist, timings, and the actions it allows. */
    function NodeDetail({ requirement, node, onAction, busy, t }) {
      const [note, setNote] = useState('')
      const [pendingAction, setPendingAction] = useState(null)
      useEffect(() => {
        setNote('')
        setPendingAction(null)
      }, [requirement.id, node?.id])

      if (node === null) return h('div', { className: 'rb-muted' }, t('selectNode'))
      const active = node.status === 'active'
      const index = requirement.flow.findIndex(candidate => candidate.id === node.id)
      const currentIndex = requirement.flow.findIndex(candidate => candidate.id === requirement.nodeId)
      const canRollback = index < currentIndex
      const canJump = index > currentIndex
      const unmetChecks = node.completion?.type === 'checklist'
        ? node.checks.map((checked, position) => (checked ? null : node.completion.checklist[position])).filter(Boolean)
        : []
      const needsNote = active && node.completion?.requireNote === true
      const finishDisabled = !active || unmetChecks.length > 0 || (needsNote && note.trim() === '') || busy
      const run = (action, payload) => onAction(action, { id: requirement.id, expectedRev: requirement.rev, ...payload })

      return h('div', { className: 'rb-panel' },
        h('div', { className: 'rb-row' },
          h('strong', null, node.name),
          h(StatusBadge, { status: node.status, t }),
          node.assignee !== '' ? h('span', { className: 'rb-muted' }, `${t('owner')}: ${node.assignee}`) : null),
        node.description !== '' ? h('div', { className: 'rb-muted', style: { marginTop: 4 } }, node.description) : null,
        h('div', { className: 'rb-kv', style: { marginTop: 8 } },
          h('span', { className: 'rb-kv-key' }, t('flow')),
          h('span', null, node.completion?.type === 'checklist' ? t('completionChecklist') : t('completionManual')),
          h('span', { className: 'rb-kv-key' }, t('entered')),
          h('span', null, formatInstant(node.enteredAt)),
          h('span', { className: 'rb-kv-key' }, t('completed')),
          h('span', null, formatInstant(node.completedAt)),
          h('span', { className: 'rb-kv-key' }, t('spent')),
          h('span', null, formatDuration(node.completedAt !== null && node.enteredAt !== null
            ? new Date(node.completedAt).getTime() - new Date(node.enteredAt).getTime()
            : node.status === 'active' && node.enteredAt !== null ? Date.now() - new Date(node.enteredAt).getTime() : null))),
        node.completion?.type === 'checklist' ? h('div', { className: 'rb-section' },
          sectionHead('checks', t),
          node.completion.checklist.map((label, position) => h('label', {
            key: label,
            className: `rb-check${node.checks[position] ? ' rb-check-done' : ''}`,
          },
            h('input', {
              type: 'checkbox',
              name: 'node.checklist',
              checked: node.checks[position] === true,
              disabled: !active || busy,
              onChange: event => onAction('checklist', {
                id: requirement.id,
                expectedRev: requirement.rev,
                index: position,
                checked: event.target.checked,
              }),
            }),
            h('span', null, label)))) : null,
        h('div', { className: 'rb-field', style: { marginTop: 10 } },
          h('span', { className: 'rb-field-label' }, t('note')),
          h('textarea', {
            className: 'rb-textarea',
            value: note,
            placeholder: t('notePlaceholder'),
            onChange: event => setNote(event.target.value),
          })),
        pendingAction === 'block' ? h('div', { className: 'rb-row' },
          h(Button, {
            variant: 'outline',
            className: 'rb-btn rb-btn-danger',
disabled: busy || note.trim() === '',
            onClick: () => run('block', { reason: note.trim() }),
          }, t('block')),
          h('span', { className: 'rb-muted' }, t('blockReasonPlaceholder'))) : null,
        h('div', { className: 'rb-row', style: { marginTop: 8 } },
          h(Button, {
            className: 'rb-btn-primary-stroke rb-btn-pad rb-btn',
            variant: 'primary',
disabled: finishDisabled,
            title: unmetChecks.length > 0 ? `${t('errCompletionNotMet')} ${unmetChecks.join(', ')}` : undefined,
            onClick: () => run('transition', { transition: 'advance', note: note.trim() }),
          }, t('advance')),
          canRollback ? h(Button, {
            className: 'rb-btn-pad rb-btn',
            variant: 'ghost',
disabled: busy || note.trim() === '',
            onClick: () => run('transition', { transition: 'rollback', to: node.id, note: note.trim() }),
          }, t('rollback')) : null,
          canJump ? h(Button, {
            className: 'rb-btn-pad rb-btn',
            variant: 'ghost',
disabled: busy || note.trim() === '',
            onClick: () => run('transition', { transition: 'jump', to: node.id, note: note.trim(), force: true }),
          }, t('jump')) : null,
          h('span', { className: 'rb-grow' }),
          h(Button, {
            className: 'rb-btn-pad rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
onClick: () => setPendingAction(pendingAction === 'block' ? null : 'block'),
          }, t('block'))))
    }

    /** Retained transition history, newest first. */
    function History({ requirement, t }) {
      const entries = [...(requirement.history ?? [])].reverse()
      if (entries.length === 0) return h('div', { className: 'rb-muted' }, t('noHistory'))
      return h('div', { className: 'rb-history' }, entries.map(entry => h('div', { key: entry.id, className: 'rb-history-row' },
        h('span', { className: 'rb-history-time' }, formatInstant(entry.at)),
        h('span', { className: 'rb-kv-key' }, entry.action),
        h('span', null, entry.from === null || entry.from === ''
          ? entry.toName
          : `${entry.fromName} → ${entry.toName}`),
        entry.note !== '' ? h('span', { className: 'rb-muted' }, `· ${entry.note}`) : null,
        entry.force ? h('span', { className: 'rb-warn' }, '· force') : null,
        entry.durationMs !== null && entry.durationMs !== undefined ? h('span', { className: 'rb-muted' }, `· ${formatDuration(entry.durationMs)}`) : null)))
    }

    /** Per-node average durations plus the blocker and stall lists. */
    /**
     * The board overview's three sections (v3 §3 V3-7/V3-19).
     *
     * The board view reads them open; the queue and decisions views keep them
     * inside one closed fold beside their own reading. When every duration row
     * rests on a single sample, min and max only repeat the average, so both
     * columns stay out of the table.
     */
    function overviewSections(stats, t) {
      const tables = stats.nodeDurations.slice(0, 12)
      /** A duration row's node name, localized for the built-in template. */
      const durationName = row => {
        const text = builtinText(row.templateId)
        const labels = text === undefined ? undefined : text.nodes[row.nodeId]
        return labels === undefined ? row.name : t(labels.name)
      }
      const singleSample = tables.length > 0 && tables.every(row => row.samples === 1)
      return [
        h('div', { className: 'rb-section', key: 'durations' },
          sectionHead('nodeDurations', t),
          h('div', { className: 'rb-muted' }, t('durationHint')),
          tables.length === 0 ? h('div', { className: 'rb-muted' }, '—') : h('table', { className: 'rb-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('nodesLabel')),
              h('th', null, t('samples')),
              h('th', null, t('avg')),
              singleSample ? null : h('th', { key: 'min' }, 'min'),
              singleSample ? null : h('th', { key: 'max' }, 'max'))),
            h('tbody', null, tables.map(row => h('tr', { key: `${row.templateId}:${row.nodeId}` },
              h('td', null, durationName(row)),
              h('td', null, String(row.samples)),
              h('td', null, formatDuration(row.avgMs)),
              singleSample ? null : h('td', { key: 'min' }, formatDuration(row.minMs)),
              singleSample ? null : h('td', { key: 'max' }, formatDuration(row.maxMs))))))),
        h('div', { className: 'rb-section', key: 'blocked' },
          sectionHead('blockedTitle', t),
          stats.blocked.length === 0 ? h('div', { className: 'rb-muted' }, t('noBlocked')) : h('div', null, stats.blocked.map(item => h('div', {
            key: item.id,
            className: 'rb-row',
          },
            h('span', { className: 'rb-error' }, item.title),
            h('span', { className: 'rb-muted' }, item.reason),
            h('span', { className: 'rb-muted' }, formatDuration(item.blockedMs)))))),
        h('div', { className: 'rb-section', key: 'stalled' },
          sectionHead('stalledTitle', t),
          stats.stalled.length === 0 ? h('div', { className: 'rb-muted' }, t('noStalled')) : h('div', null, stats.stalled.map(item => h('div', {
            key: item.id,
            className: 'rb-row',
          },
            h('span', { className: 'rb-warn' }, item.title),
            h('span', { className: 'rb-muted' }, item.node),
            h('span', { className: 'rb-muted' }, formatDuration(item.idleMs)))))),
      ]
    }

    function ProgressPanel({ stats, t }) {
      if (stats === null) return null
      return h('div', null, overviewSections(stats, t))
    }

    /** The requirement creation dialog. */
    function CreateRequirementDialog({ templates, defaultTemplateId, projects, onClose, onSubmit, onUpload, busy, t }) {
      const [form, setForm] = useState({
        title: '',
        summary: '',
        project: '',
        description: '',
        priority: 'normal',
        owner: '',
        templateId: defaultTemplateId,
        sessions: '',
      })
      /**
       * The images this requirement already carries, in the order they were
       * added. One row is tracked from the moment its file arrives until its
       * upload lands, fails, or the reader removes it, so the dialog can never
       * submit an id it does not have.
       */
      const [images, setImages] = useState([])
      /** The last refusal or upload failure; empty when nothing is wrong. */
      const [notice, setNotice] = useState('')
      /** Numbers the image rows so two identical files stay distinct rows. */
      const [sequence, setSequence] = useState(0)
      /**
       * The structured question this requirement puts to the person, one row per
       * question and one row per choice, each tracked by a stable key: an edit,
       * an insertion or a removal must never move a half-typed prompt or hand a
       * choice to another question.
       */
      const [questions, setQuestions] = useState([])
      /** Mints those keys, so two rows added in one gesture cannot share one. */
      const optionSeq = useRef(0)
      const picker = useRef(null)
      const set = patch => setForm(current => ({ ...current, ...patch }))
      const uploading = images.some(image => image.status === 'uploading')
      const stored = images.filter(image => image.status === 'ready').map(image => image.ref.id)

      /** The name a notice calls one offered file by. */
      const describe = file => (typeof file?.name === 'string' && file.name !== '' ? file.name : t('pastedImageName'))

      /** Store one accepted file, following its upload until it settles. */
      const upload = async (file, key) => {
        setImages(list => [...list, { key, name: describe(file), status: 'uploading', ref: null }])
        try {
          const ref = await onUpload(file)
          setImages(list => list.map(entry => (entry.key === key ? { ...entry, status: 'ready', ref } : entry)))
        } catch (error) {
          setImages(list => list.map(entry => (entry.key === key ? { ...entry, status: 'failed' } : entry)))
          setNotice(t('imageUploadFailed', { name: describe(file) }))
        }
      }

      /**
       * Take every file one paste or picker selection offered.
       *
       * A file the route would refuse is reported here and never uploaded: the
       * media types and the ceilings are the route's own, so the reader learns
       * about the refusal before a request is spent on it.
       * @param files - offered files, in clipboard or picker order.
       */
      const accept = files => {
        const usable = files.filter(file => IMAGE_TYPES.includes(file.type) && !(file.size > IMAGE_MAX_BYTES))
        const badType = files.filter(file => !IMAGE_TYPES.includes(file.type))
        const tooLarge = files.filter(file => IMAGE_TYPES.includes(file.type) && file.size > IMAGE_MAX_BYTES)
        // The route's own count ceiling, applied before its turn: a selection
        // that overflows it keeps the files that fit instead of spending a
        // refusal on every entry.
        const accepted = usable.slice(0, Math.max(IMAGE_MAX_COUNT - images.length, 0))
        const overLimit = usable.slice(accepted.length)
        const parts = []
        if (badType.length > 0) parts.push(t('imageTypeRejected', { names: badType.map(describe).join(', ') }))
        if (tooLarge.length > 0) parts.push(t('imageTooLarge', { names: tooLarge.map(describe).join(', ') }))
        if (overLimit.length > 0) parts.push(t('imageLimitReached', { max: IMAGE_MAX_COUNT }))
        setNotice(parts.join(' '))
        // Every accepted file starts uploading at once: the paste gesture is the
        // reader's confirmation, and the thumbnail appears exactly when its id
        // exists, so a half-uploaded requirement can never be submitted.
        accepted.forEach((file, index) => void upload(file, `image-${sequence + index}`))
        if (accepted.length > 0) setSequence(sequence + accepted.length)
      }

      /**
       * Take the images out of one clipboard payload.
       *
       * A paste carrying no image is left completely alone so the browser
       * inserts its text as usual; a paste carrying one suppresses that insert,
       * because the clipboard's text must not land beside the screenshot.
       */
      const paste = event => {
        const items = Array.from(event.clipboardData?.items ?? [])
        const files = items
          .filter(item => item.kind === 'file' && String(item.type ?? '').startsWith('image/'))
          .map(item => item.getAsFile())
          .filter(file => file !== null && file !== undefined)
        if (files.length === 0) return
        event.preventDefault()
        accept(files)
      }

      /** Take the files one picker selection offered, and reset the control. */
      const pick = event => {
        const files = Array.from(event.target.files ?? [])
        event.target.value = ''
        accept(files)
      }

      /**
       * One tracked image: a fixed tile that carries its own remove control.
       *
       * The control states the picture it drops in its accessible name, because
       * the tile shows the picture alone; hovering it turns the label tone to
       * the error colour, which is the whole affordance the text button carried.
       */
      const imageRow = (image, index) => h('div', { key: image.key, className: 'rb-image-tile' },
        image.status === 'ready'
          ? h('img', { className: 'rb-image-tile-thumb', src: imageURL(image.ref.id), alt: image.name, title: image.name })
          : h('span', {
            className: `rb-image-tile-state${image.status === 'failed' ? ' rb-error' : ' rb-muted'}`,
            title: image.name,
          }, image.status === 'failed' ? image.name : t('imageUploading')),
        h(Button, {
          variant: 'ghost',
          size: 'sm',
          className: 'rb-btn-pad rb-btn-sm rb-btn rb-image-remove',
          name: `requirement.image.remove.${index}`,
          title: t('removeImage'),
          'aria-label': `${t('removeImage')}: ${image.name}`,
          onClick: () => setImages(list => list.filter(entry => entry.key !== image.key)),
        }, '×'))

      /** A fresh key for one question or choice row. */
      const mintOptionKey = prefix => {
        optionSeq.current += 1
        return `option-${prefix}-${optionSeq.current}`
      }
      /** One choice row as a question starts it: a label, a cost, and no advice. */
      const blankChoice = () => ({ key: mintOptionKey('c'), label: '', detail: '', recommended: false })
      const patchQuestion = (key, patch) => setQuestions(list => list.map(entry => (entry.key === key ? { ...entry, ...patch } : entry)))
      const patchChoices = (questionKey, change) => setQuestions(list => list.map(question => (question.key === questionKey
        ? { ...question, choices: change(question.choices) }
        : question)))
      const patchChoice = (questionKey, choiceKey, patch) => patchChoices(questionKey, choices => choices.map(choice => (choice.key === choiceKey ? { ...choice, ...patch } : choice)))
      /** Add a question with the two choices every question must offer. */
      const addQuestion = () => setQuestions(list => [...list, {
        key: mintOptionKey('q'),
        prompt: '',
        choices: [blankChoice(), blankChoice()],
      }])
      const removeQuestion = key => setQuestions(list => list.filter(entry => entry.key !== key))
      const addChoice = questionKey => patchChoices(questionKey, choices => [...choices, blankChoice()])
      const removeChoice = (questionKey, choiceKey) => patchChoices(questionKey, choices => choices.filter(choice => choice.key !== choiceKey))

      /**
       * Mark one choice as the question's advice.
       *
       * At most one choice per question may carry it, so ticking a second one
       * moves the mark instead of adding to it: the rule is held by the control
       * rather than reported after a submit the Host would refuse.
       * @param questionKey - The question row's key.
       * @param choiceKey - The choice row's key.
       * @param next - Whether that row is now the recommended one.
       */
      const recommendChoice = (questionKey, choiceKey, next) => patchChoices(questionKey, choices => choices.map(choice => ({
        ...choice,
        recommended: next && choice.key === choiceKey,
      })))

      /**
       * The questions as the create payload carries them.
       *
       * A row whose text trims to nothing is dropped rather than sent: the Host
       * refuses an empty prompt, an empty label and a question with fewer than
       * two choices, and an unfinished row is exactly what the reader means by
       * "not this one". `detail` and `recommended` are omitted when they carry
       * nothing, which is how the Host stores them.
       */
      const optionPayload = questions.map(question => ({
        prompt: question.prompt.trim(),
        choices: question.choices
          .map(choice => ({ label: choice.label.trim(), detail: choice.detail.trim(), recommended: choice.recommended === true }))
          .filter(choice => choice.label !== '')
          .map(choice => ({
            label: choice.label,
            ...(choice.detail === '' ? {} : { detail: choice.detail }),
            ...(choice.recommended ? { recommended: true } : {}),
          })),
      }))
      /** The draft is sendable only when every question asks at least two choices. */
      const optionsReady = optionPayload.every(question => question.prompt !== '' && question.choices.length >= 2)
      /** Why the option draft cannot be saved yet, or the empty string. */
      const optionProblem = optionPayload.some(question => question.prompt === '')
        ? t('optionNeedQuestion')
        : optionPayload.some(question => question.choices.length < 2) ? t('optionNeedItems') : ''

      return h(Dialog, {
        title: t('newRequirement'),
        closeLabel: t('close'),
        onClose,
        footer: [
          h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', key: 'cancel', onClick: onClose}, t('cancel')),
          h(Button, {
            className: 'rb-btn-primary-stroke rb-btn-pad rb-btn',
            variant: 'primary',
key: 'ok',
            disabled: busy || uploading || form.title.trim() === '' || form.summary.trim() === '' || !optionsReady,
            onClick: () => onSubmit({
              title: form.title.trim(),
              summary: form.summary.trim(),
              project: form.project.trim(),
              description: form.description.trim(),
              priority: form.priority,
              owner: form.owner.trim(),
              templateId: form.templateId,
              sessions: form.sessions.split(',').map(entry => entry.trim()).filter(Boolean),
              images: stored,
              // A requirement that asks nothing carries no `options` field at all,
              // so a board written here stays byte-identical to one written before
              // the field existed.
              ...(optionPayload.length === 0 ? {} : { options: optionPayload }),
            }),
          }, t('create')),
        ],
      },
        h(Field, { label: t('titleField') }, h(Input, {
          name: 'requirement.title',
          value: form.title,
          onChange: event => set({ title: event.target.value }),
        })),
        h(Field, { label: t('summary') },
          h('textarea', {
            className: 'rb-textarea rb-textarea-brief',
            name: 'requirement.summary',
            value: form.summary,
            maxLength: 300,
            onChange: event => set({ summary: event.target.value }),
          }),
          h('div', { className: 'rb-image-hint' }, t('summaryHint'))),
        h(Field, { label: t('description') },
          h('textarea', {
            className: 'rb-textarea',
            name: 'requirement.description',
            value: form.description,
            onPaste: paste,
            onChange: event => set({ description: event.target.value }),
          }),
          h('div', { className: 'rb-row', style: { marginTop: 4 } },
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: 'requirement.image.pick',
              onClick: () => picker.current?.click(),
            }, t('addImage')),
            h('span', { className: 'rb-image-hint' }, t('pasteImageHint')),
            h('input', {
              ref: picker,
              className: 'rb-file-input',
              type: 'file',
              name: 'requirement.image.file',
              accept: IMAGE_TYPES.join(','),
              multiple: true,
              onChange: pick,
            })),
          images.length === 0 ? null : h('div', { className: 'rb-images', style: { marginTop: 8 } }, images.map(imageRow)),
          notice === '' ? null : h('div', {
            className: 'rb-notice rb-notice-error',
            role: 'alert',
            style: { margin: '8px 0 0' },
          }, notice)),
        // The structured question, when this requirement asks one: a decision
        // requirement carries its choices here instead of spelling them out in
        // the description, and a task may carry them too when a person has to
        // pick before the work can go on.
        h('div', { className: 'rb-options-editor' },
          h('div', { className: 'rb-field-label' }, t('optionsTitle')),
          h('div', { className: 'rb-option-hint' }, t('optionsCreateHint')),
          h('div', { className: 'rb-option-hint' }, t('optionNeedOneRecommended')),
          questions.map((question, index) => h('div', { key: question.key, className: 'rb-node-card' },
            h('div', { className: 'rb-node-card-head' },
              h('span', { className: 'rb-node-heading' }, `${index + 1}. ${question.prompt.trim() === '' ? t('optionQuestion') : question.prompt.trim()}`),
              h(Tag, { tone: 'outline' }, `q${index + 1}`),
              h('span', { className: 'rb-grow' }),
              h(Button, {
                className: 'rb-btn-pad rb-btn-sm rb-btn',
                variant: 'ghost',
                size: 'sm',
                name: `option.question.remove.${index}`,
                disabled: busy,
                onClick: () => removeQuestion(question.key),
              }, t('optionRemoveQuestion'))),
            h(Field, { label: t('optionQuestion') }, h(Input, {
              name: `option.question.prompt.${index}`,
              value: question.prompt,
              maxLength: OPTION_PROMPT_MAX,
              placeholder: t('optionQuestionPlaceholder'),
              onChange: event => patchQuestion(question.key, { prompt: event.target.value }),
            })),
            h('div', null,
              h('div', { className: 'rb-field-label' }, t('optionItem')),
              h('div', { className: 'rb-checks' }, question.choices.map((choice, at) => h('div', {
                key: choice.key,
                className: 'rb-check-row',
              },
                h(Input, {
                  className: 'rb-choice-name',
                  name: `option.item.label.${index}.${at}`,
                  value: choice.label,
                  maxLength: OPTION_LABEL_MAX,
                  placeholder: t('optionItemPlaceholder'),
                  'aria-label': t('optionItem'),
                  onChange: event => patchChoice(question.key, choice.key, { label: event.target.value }),
                }),
                h(Input, {
                  className: 'rb-choice-detail',
                  name: `option.item.detail.${index}.${at}`,
                  value: choice.detail,
                  maxLength: OPTION_DETAIL_MAX,
                  placeholder: t('optionItemDescriptionPlaceholder'),
                  // The detail column has no visible label of its own, so the column
                  // name travels with the field.
                  'aria-label': t('optionItemDescription'),
                  onChange: event => patchChoice(question.key, choice.key, { detail: event.target.value }),
                }),
                h(Checkbox, {
                  className: 'rb-choice-rec',
                  checked: choice.recommended === true,
                  label: t('optionRecommended'),
                  disabled: busy,
                  onChange: next => recommendChoice(question.key, choice.key, next),
                }),
                h(Button, {
                  className: 'rb-btn-pad rb-btn-sm rb-btn',
                  variant: 'ghost',
                  size: 'sm',
                  name: `option.item.remove.${index}.${at}`,
                  disabled: busy || question.choices.length <= 2,
                  onClick: () => removeChoice(question.key, choice.key),
                }, t('optionRemoveItem'))))),
              h(Button, {
                className: 'rb-btn-pad rb-btn-sm rb-btn',
                variant: 'ghost',
                size: 'sm',
                name: `option.item.add.${index}`,
                disabled: busy || question.choices.length >= OPTION_CHOICES_MAX,
                onClick: () => addChoice(question.key),
              }, t('optionAddItem'))))),
          h('div', { className: 'rb-row', style: { marginTop: 8 } },
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: 'option.question.add',
              disabled: busy || questions.length >= OPTION_QUESTIONS_MAX,
              onClick: addQuestion,
            }, t('optionAddQuestion'))),
          optionProblem === '' ? null : h('div', {
            className: 'rb-notice rb-notice-error',
            role: 'alert',
          }, optionProblem)),
        h('div', { className: 'rb-row' },
          h(Field, { label: t('filterPriority') }, h('select', {
            className: 'rb-select',
            name: 'requirement.priority',
            value: form.priority,
            onChange: event => set({ priority: event.target.value }),
          }, ['low', 'normal', 'high', 'urgent'].map(value => h('option', { key: value, value }, t(`priority${value[0].toUpperCase()}${value.slice(1)}`))))),
          h(Field, { label: t('owner') }, h(Input, {
            name: 'requirement.owner',
            value: form.owner,
            onChange: event => set({ owner: event.target.value }),
          }))),
        h(Field, { label: t('template') }, h('select', {
          className: 'rb-select',
          name: 'requirement.templateId',
          value: form.templateId,
          onChange: event => set({ templateId: event.target.value }),
        }, templates.map(template => h('option', { key: template.id, value: template.id }, `${template.name} (${template.nodes.length} ${t('nodeCount')})`)))),
        // The project is free text with the board's own names offered as
        // suggestions: the field is a label rather than a reference, so a typo
        // makes a group of its own instead of being refused, and the hint is what
        // keeps one project spelled one way.
        h(Field, { label: t('project') },
          h('input', {
            className: 'rb-input',
            name: 'requirement.project',
            value: form.project,
            list: PROJECT_SUGGESTIONS_CREATE,
            maxLength: 60,
            onChange: event => set({ project: event.target.value }),
          }),
          h('datalist', { id: PROJECT_SUGGESTIONS_CREATE }, projects.map(name => h('option', { key: name, value: name }))),
          h('div', { className: 'rb-image-hint' }, t('projectHint'))),
        h(Field, { label: t('sessions') }, h(Input, {
          name: 'requirement.sessions',
          value: form.sessions,
          placeholder: 'ses_a, ses_b',
          onChange: event => set({ sessions: event.target.value }),
        })))
    }

    /** A node declaration as the read-only chart consumes one. */
    function templateFlowNode(node) {
      return {
        id: node.id,
        name: node.name,
        order: node.order ?? 0,
        dependsOn: [...(node.dependsOn ?? [])],
        assignee: node.assignee ?? '',
        description: node.description ?? '',
        completion: node.completion ?? { type: 'manual', checklist: [], requireNote: false },
        status: 'pending',
        enteredAt: null,
        completedAt: null,
        checks: (node.completion?.checklist ?? []).map(() => false),
        note: '',
      }
    }

    /**
     * Group a template's bound requirements by the revision each is pinned to.
     * @param pins - The bound requirements as the requirement route reports them.
     * @returns a Map from revision number to the requirements pinned there.
     */
    function pinsByRevision(pins) {
      const grouped = new Map()
      for (const requirement of pins) {
        const revision = requirement.templateRevision ?? 1
        grouped.set(revision, [...(grouped.get(revision) ?? []), requirement])
      }
      return grouped
    }

    /**
     * The flow-template drawer: the list, the read-only detail, the version
     * editor, and the four management actions (migrate, prune, archive, delete).
     *
     * The drawer never derives a flow fact the Host owns. The pinned-revision
     * counts come from the requirements route, the migration impact comes from
     * `template.migrate`'s own refusal, and the prune gate reuses the same pin
     * list, so a version the Host would refuse to drop is disabled here for the
     * same reason rather than a re-implementation of it. Every draft lives in
     * this component's state and reaches the board only through a command: a
     * half-edited template is never stored, so a new requirement cannot be
     * created against it (§11.7). The two writes that keep a draft on screen —
     * the new template and the duplicate — run through `invokeQuiet`, so their
     * refusal is reported by the form dialog that asked for the save rather than
     * by the overlay toast, which would fade while the draft stayed.
     */
    function TemplateDrawer({ templates, pins, pinsTruncated, busy, run, invokeQuiet, controller, revision, onClose, t }) {
      const [list, setList] = useState(templates)
      const [includeArchived, setIncludeArchived] = useState(false)
      const [selectedId, setSelectedId] = useState(null)
      const [record, setRecord] = useState(null)
      const [detailError, setDetailError] = useState(null)
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(null)
      const [conflict, setConflict] = useState(null)
      const [notice, setNotice] = useState(null)
      const [migrating, setMigrating] = useState(null)
      // Bumped on every opening, so the migration dialog can tell one opening
      // from the next and never inherit the impact list of a run that finished.
      const [migrateOpens, setMigrateOpens] = useState(0)
      const [deleting, setDeleting] = useState(false)
      const [deleteArmed, setDeleteArmed] = useState(false)
      const [pruneTarget, setPruneTarget] = useState(null)
      const [form, setForm] = useState(null)
      const [discard, setDiscard] = useState(false)
      const [formError, setFormError] = useState(null)
      const editingRef = useRef(false)
      editingRef.current = editing
      /** Whether the Host has answered the list read of this drawer at least once. */
      const listLoadedRef = useRef(false)

      /**
       * Run one command behind an inline notice instead of only the app toast.
       *
       * A dialog that keeps unsaved input (the version editor and the migration
       * impact list) has to say what went wrong exactly where the work is, because
       * a toast fades while the draft stays on screen.
       */
      const invoke = useCallback(async (action, payload) => {
        const result = await run(action, payload)
        setNotice(result.ok ? null : result.error)
        return result
      }, [run])

      /** Read the bounded list; archived templates are included on request only. */
      const loadList = useCallback(async include => {
        const result = await run('template.list', { includeArchived: include })
        if (!result.ok) return
        listLoadedRef.current = true
        setList(result.data?.items ?? [])
      }, [run])

      /** Read one template's full record (versions, changes, archived flag). */
      const loadDetail = useCallback(async id => {
        const result = await run('template.get', { id })
        if (!result.ok) {
          setDetailError(result.error)
          setRecord(null)
          return
        }
        setDetailError(null)
        setRecord(result.data)
      }, [run])

      useEffect(() => {
        void loadList(includeArchived)
      }, [loadList, includeArchived])

      // The board is shared: a committed template write by any session arrives as
      // a revision move. The list follows it; an open editor does not, because
      // reloading the record under a draft would discard the draft, and the draft
      // is the thing the reader would have to retype (§11.7).
      useEffect(() => {
        if (revision === 0) return
        void loadList(includeArchived)
        if (selectedId !== null && !editingRef.current) void loadDetail(selectedId)
      }, [revision, includeArchived, selectedId, loadList, loadDetail])

      const visible = useMemo(() => list
        .filter(template => includeArchived || template.archived !== true)
        .sort((left, right) => (Number(right.builtin === true) - Number(left.builtin === true))
          || String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))), [list, includeArchived])

      // The drawer opens on a template rather than on an empty detail pane: the
      // first row is selected once the list has landed, and a pick the reader
      // made is never replaced. The empty state stays for a genuinely empty list.
      useEffect(() => {
        if (selectedId !== null || !listLoadedRef.current || visible.length === 0) return
        setSelectedId(visible[0].id)
      }, [selectedId, visible])

      const row = visible.find(template => template.id === selectedId)
        ?? visible.find(template => template.id === record?.id)
        ?? null
      const detail = record !== null && record.id === row?.id ? record : null
      const versions = detail?.versions ?? []
      const currentRevision = detail?.revision ?? row?.revision ?? 1
      const bound = useMemo(() => (pins ?? []).filter(requirement => requirement.templateId === row?.id), [pins, row?.id])
      const pinned = useMemo(() => pinsByRevision(bound), [bound])
      const pinnedToOld = bound.filter(requirement => (requirement.templateRevision ?? 1) !== currentRevision).length
      /**
       * Where a bound requirement lands once this template is deleted.
       *
       * The board rebinds to the deployment's default template, which is the same
       * record this panel offers a new requirement by default: the first template
       * the Host lists. It is named rather than assumed, so a deployment whose
       * default is an archived or later template shows a name the reader can
       * recognise as wrong instead of a silent wrong destination.
       */
      const fallback = visible.find(template => template.id !== row?.id) ?? null
      const landingOf = requirement => {
        if (fallback === null) return '—'
        const nodes = fallback.nodes ?? []
        const keeps = nodes.some(node => node.id === requirement.nodeId)
        const node = keeps ? requirement.nodeId : (nodes[0]?.id ?? '—')
        return `${fallback.name} · ${(nodes.find(candidate => candidate.id === node)?.name) ?? node}`
      }

      useEffect(() => {
        if (row === null) {
          if (selectedId !== null) {
            setSelectedId(null)
            setRecord(null)
            setEditing(false)
            setDraft(null)
          }
          return
        }
        if (detail !== null) return
        void loadDetail(row.id)
      }, [row, detail, selectedId, loadDetail])

      const startEdit = () => {
        setConflict(null)
        setNotice(null)
        setMigrating(null)
        setEditing(true)
      }
      /** Open the migration dialog for one target revision, as a fresh reading. */
      const openMigration = (target, from) => {
        setMigrateOpens(current => current + 1)
        setMigrating({ target, from })
      }
      // The draft holds only unsaved input and must not be seeded while rendering:
      // it is built once when the editor opens and again whenever the record it
      // edits moves underneath it.
      useEffect(() => {
        if (!editing) {
          setDraft(null)
          return
        }
        setDraft({
          name: detail?.name ?? row?.name ?? '',
          description: detail?.description ?? row?.description ?? '',
          nodes: (detail?.nodes ?? row?.nodes ?? []).map(node => ({
            id: node.id,
            name: node.name,
            description: node.description ?? '',
            dependsOn: [...(node.dependsOn ?? [])],
            type: node.completion?.type === 'checklist' ? 'checklist' : 'manual',
            checklist: [...(node.completion?.checklist ?? [])],
          })),
        })
      }, [editing, detail?.id, detail?.revision, row?.id])
      const patchDraft = patch => setDraft(current => ({ ...current, ...patch }))
      const ownIds = draft === null ? [] : draft.nodes.map(node => node.id)
      const reviseSaved = async result => {
        setEditing(false)
        setDraft(null)
        setConflict(null)
        controller.notify('info', interpolate(t('templateSaved'), { revision: result.data?.revision ?? '' }))
        await loadList(includeArchived)
        if (selectedId !== null) await loadDetail(selectedId)
      }

      /** Add a node whose derived id cannot collide with the current list. */
      const addNode = () => {
        const taken = new Set(draft.nodes.map(node => node.id))
        let index = draft.nodes.length + 1
        while (taken.has(`node-${index}`)) index += 1
        patchDraft({
          nodes: [...draft.nodes, {
            id: `node-${index}`,
            name: '',
            description: '',
            dependsOn: [],
            type: 'manual',
            checklist: [],
          }],
        })
      }

      /** Remove one node and every reference the other nodes held to it. */
      const removeNode = id => patchDraft({
        nodes: draft.nodes
          .filter(node => node.id !== id)
          .map(node => ({ ...node, dependsOn: node.dependsOn.filter(parent => parent !== id) })),
      })

      /** Swap one node with its neighbour, so the declared order can move. */
      const moveNode = (index, delta) => {
        const target = index + delta
        if (target < 0 || target >= draft.nodes.length) return
        const nodes = [...draft.nodes]
        const [moved] = nodes.splice(index, 1)
        nodes.splice(target, 0, moved)
        patchDraft({ nodes })
      }
      const patchNode = (index, patch) => patchDraft({
        nodes: draft.nodes.map((node, position) => (position === index ? { ...node, ...patch } : node)),
      })
      const toggleDepends = (index, parentId, next) => {
        const node = draft.nodes[index]
        patchNode(index, {
          dependsOn: next
            ? [...node.dependsOn, parentId]
            : node.dependsOn.filter(id => id !== parentId),
        })
      }
      const checkLine = (onChange, value, name) => h(Input, { name, value, onChange })

      const structureReady = draft !== null && draft.name.trim() !== '' && draft.nodes.length > 0
        && draft.nodes.every(node => node.name.trim() !== '')

      /**
       * Save the template's own name and description without moving a version.
       *
       * This is the panel's metadata path (§11.5): it appends nothing to the
       * version history and changes no requirement, and the form says so.
       */
      const saveMetadata = async () => {
        const result = await invoke('template.metadata', {
          id: row.id,
          patch: { name: draft.name.trim(), description: draft.description.trim() },
        })
        if (!result.ok) {
          if (result.error?.code === 'conflict') {
            setConflict(result.error)
            await loadDetail(row.id)
          }
          return
        }
        setConflict(null)
        controller.notify('info', t('templateMetadataSaved'))
        await loadList(includeArchived)
        await loadDetail(row.id)
      }

      /**
       * Append a version with the whole target node list.
       *
       * `expectedRevision` is the record's own revision, so two editors appending
       * at once cannot both win: the loser's editing content is kept on screen and
       * the conflict names the revision that is now current (§11.5).
       */
      const saveStructure = async () => {
        const nodes = draft.nodes.map(node => ({
          id: node.id,
          name: node.name.trim(),
          description: node.description.trim(),
          dependsOn: node.dependsOn,
          assignee: '',
          completion: node.type === 'checklist'
            ? { type: 'checklist', checklist: node.checklist.map(line => line.trim()).filter(line => line !== '') }
            : { type: 'manual', checklist: [], requireNote: false },
        }))
        const result = await invoke('template.revise', {
          id: row.id,
          patch: {
            name: draft.name.trim(),
            description: draft.description.trim(),
            nodes,
            expectedRevision: currentRevision,
          },
        })
        if (!result.ok) {
          if (result.error?.code === 'conflict') {
            setConflict(result.error)
            await loadList(includeArchived)
            await loadDetail(row.id)
          }
          return
        }
        await reviseSaved(result)
      }

      /** Archive the template, or restore it when it is already archived. */
      const archive = async archived => {
        const result = await invoke('template.archive', { id: row.id, archived })
        if (!result.ok) return
        controller.notify('info', t(archived ? 'templateArchived' : 'templateRestored'))
        await loadList(includeArchived)
        await loadDetail(row.id)
      }

      const prune = async revisionToDrop => {
        const result = await invoke('template.prune', { id: row.id, revision: revisionToDrop })
        setPruneTarget(null)
        if (!result.ok) return
        controller.notify('info', interpolate(t('templatePruned'), { revision: revisionToDrop }))
        await loadList(includeArchived)
        await loadDetail(row.id)
      }

      /**
       * Open the form layer over one starting draft.
       *
       * `sourceName` names the template a duplicate copies, and is empty for a new
       * one; it is what the dialog title states, so a copy reads as a copy of a
       * named row rather than as a blank template.
       */
      const openForm = (mode, sourceName, value) => {
        setForm({ mode, sourceName, initial: value, value })
        setDiscard(false)
        setFormError(null)
      }
      const patchForm = patch => {
        // A refusal belongs to the draft that caused it, so editing clears it.
        setFormError(null)
        setForm(current => current === null ? null : { ...current, value: { ...current.value, ...patch } })
      }
      const dropForm = () => {
        setForm(null)
        setDiscard(false)
        setFormError(null)
      }
      /**
       * The form's own close control, standing in for cancel, Escape, and the
       * mask. A changed draft asks first; while that confirmation is up, this path
       * takes the confirmation back instead of the input, so discarding a draft
       * stays an explicit act.
       */
      const attemptCloseForm = () => {
        if (discard) {
          setDiscard(false)
          return
        }
        if (form !== null && !sameTemplateDraft(form.value, form.initial)) {
          setDiscard(true)
          return
        }
        dropForm()
      }

      /** Copy the current version into a fresh, editable template. */
      const cloneTemplate = async name => {
        const result = await invokeQuiet('template.clone', { id: row.id, name: name.trim() })
        if (!result.ok) {
          setFormError(String(result.error?.message ?? result.error ?? ''))
          return
        }
        controller.notify('info', interpolate(t('templateCloned'), { name: name.trim() }))
        dropForm()
        await loadList(includeArchived)
      }

      /**
       * Create one custom template from the panel's node-per-line form.
       *
       * The line syntax is the one the create dialog has always used
       * (`name | assignee | check;check`), parsed here and sent as declarations
       * the service normalizes and validates. A refusal lands in the form dialog
       * and leaves the draft untouched.
       */
      const createNew = async value => {
        const nodes = value.nodes.split('\n').map(line => line.trim()).filter(line => line !== '').map(line => {
          const [head, ...rest] = line.split('|').map(part => part.trim())
          const checks = (rest[1] ?? '').split(';').map(entry => entry.trim()).filter(entry => entry !== '')
          return {
            name: head,
            assignee: rest[0] ?? '',
            completion: checks.length === 0
              ? { type: 'manual', checklist: [], requireNote: false }
              : { type: 'checklist', checklist: checks },
          }
        })
        const result = await invokeQuiet('template.create', {
          template: { name: value.name.trim(), description: value.description.trim(), nodes },
        })
        if (!result.ok) {
          setFormError(String(result.error?.message ?? result.error ?? ''))
          return
        }
        controller.notify('info', t('templateMutated'))
        dropForm()
        await loadList(includeArchived)
        if (result.data?.id !== undefined) setSelectedId(result.data.id)
      }

      /**
       * Delete the template, rebinding every bound requirement.
       *
       * The board refuses a template a requirement is bound to unless the caller
       * passes `force`, because the rebind rewrites those requirements. The panel
       * therefore lists them first and arms a second, explicit confirmation: the
       * destinations shown come from the same first-listed template this panel
       * offers a new requirement as its default, and each is the node that
       * requirement keeps or the fallback's first node when its own is gone.
       */
      const deleteTemplate = async () => {
        const result = await invoke('template.delete', { id: row.id, force: bound.length > 0 })
        if (!result.ok) return
        controller.notify('info', t('templateDeleted'))
        setDeleting(false)
        setDeleteArmed(false)
        setSelectedId(null)
        setRecord(null)
        setEditing(false)
        await loadList(includeArchived)
      }

      /**
       * One version's row: its own facts and the two acts that address it.
       *
       * Dropping a version is disabled exactly when a requirement is pinned to
       * it, and the reason names those requirements. The gate is the same set the
       * Host refuses on, read from the requirement route rather than re-derived.
       */
      const versionRow = version => {
        const heldBy = pinned.get(version.revision) ?? []
        const blocked = heldBy.length > 0
        return h('div', { key: `v${version.revision}`, className: 'rb-version-row' },
          h('div', { className: 'rb-node-card-head' },
            h(Tag, { tone: version.revision === currentRevision ? 'info' : 'outline' },
              interpolate(t('templateRevisionLine'), { revision: version.revision })),
            blocked
              ? h(Tag, { tone: 'warning' }, interpolate(t('templatePinnedCount'), { count: heldBy.length }))
              : null,
            h('span', { className: 'rb-grow' }),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: `template.prune.${version.revision}`,
              disabled: busy || blocked,
              title: blocked
                ? interpolate(t('templatePruneDisabled'), {
                  count: heldBy.length,
                  ids: heldBy.map(requirement => requirement.id).join(', '),
                })
                : t('templatePruneConfirm', { revision: version.revision }),
              onClick: () => setPruneTarget(version.revision),
            }, t('templatePrune')),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: `template.migrate.${version.revision}`,
              disabled: busy,
              onClick: () => openMigration(currentRevision, version.revision),
            }, t('templateMigration'))),
          h('div', { className: 'rb-card-meta' },
            h('span', null, `${t('updated')}: ${formatInstant(version.at)}`),
            h('span', null, `${t('templateVersionAuthor')}: ${version.by === '' ? '—' : version.by}`),
            h('span', null, `${t('nodesLabel')}: ${(version.nodes ?? []).length}`)),
          h('div', { className: 'rb-muted' }, version.summary === '' ? t('templateNoSummary') : version.summary),
          blocked
            ? h('div', { className: 'rb-warn' }, interpolate(t('templatePruneDisabled'), {
              count: heldBy.length,
              ids: heldBy.map(requirement => requirement.id).join(', '),
            }))
            : null)
      }

      const editBody = () => [
        h('div', { className: 'rb-panel' },
          h('div', { className: 'rb-field-label' }, t('templateEditMetadata')),
          h('div', { className: 'rb-node-fields' },
            h(Field, { label: t('templateName') }, h(Input, {
              name: 'template.edit.name',
              value: draft.name,
              onChange: event => patchDraft({ name: event.target.value }),
            })),
            h(Field, { label: t('templateDescription') }, h(Input, {
              name: 'template.edit.description',
              value: draft.description,
              onChange: event => patchDraft({ description: event.target.value }),
            }))),
          h('div', { className: 'rb-muted', style: { marginTop: 6 } }, t('templateMetadataHint')),
          h('div', { className: 'rb-muted' }, interpolate(t('templateRevisionUnchanged'), { revision: currentRevision })),
          h('div', { className: 'rb-row', style: { marginTop: 6 } },
            h(Button, {
              className: 'rb-btn-sm rb-btn',
              variant: 'outline',
              size: 'sm',
              name: 'template.metadata.save',
              disabled: busy || draft.name.trim() === '',
              onClick: () => void saveMetadata(),
            }, t('save')))),
        h('div', { className: 'rb-section' },
          sectionHead('templateEditStructure', t),
          h('div', { className: 'rb-muted' }, t('templateReviseHint'))),
        conflict === null ? null : h('div', { className: 'rb-notice rb-notice-error', role: 'alert' },
          h('span', null, t('errTemplateConflict')),
          h('span', { className: 'rb-muted' }, interpolate(t('templateCurrentRevision'), { revision: currentRevision }))),
        draft.nodes.length === 0
          ? h('div', { className: 'rb-notice rb-notice-error' }, t('templateNeedNodes'))
          : null,
        draft.nodes.some(node => node.name.trim() === '')
          ? h('div', { className: 'rb-notice' }, t('templateNeedName'))
          : null,
        draft.nodes.map((node, index) => h('div', { key: `${node.id}#${index}`, className: 'rb-node-card' },
          h('div', { className: 'rb-node-card-head' },
            h('span', { className: 'rb-node-heading' }, `${index + 1}. ${node.name === '' ? t('templateNodeName') : node.name}`),
            h(Tag, { tone: 'outline' }, node.id),
            h('span', { className: 'rb-grow' }),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: `template.node.up.${index}`,
              disabled: busy || index === 0,
              onClick: () => moveNode(index, -1),
            }, t('templateMoveUp')),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: `template.node.down.${index}`,
              disabled: busy || index === draft.nodes.length - 1,
              onClick: () => moveNode(index, 1),
            }, t('templateMoveDown')),
            h(Button, {
              variant: 'ghost',
              size: 'sm',
              className: 'rb-btn-pad rb-btn-sm rb-btn rb-btn-danger',
              name: `template.node.remove.${index}`,
              disabled: busy,
              onClick: () => removeNode(node.id),
            }, t('templateRemoveNode'))),
          h('div', { className: 'rb-node-fields' },
            h(Field, { label: t('templateNodeId') }, h(Input, {
              name: `template.node.id.${index}`,
              value: node.id,
              onChange: event => {
                const next = event.target.value
                patchDraft({
                  nodes: draft.nodes.map((candidate, position) => (position === index
                    ? { ...candidate, id: next }
                    : { ...candidate, dependsOn: candidate.dependsOn.map(id => (id === node.id ? next : id)) })),
                })
              },
            })),
            h(Field, { label: t('templateNodeName') }, h(Input, {
              name: `template.node.name.${index}`,
              value: node.name,
              onChange: event => patchNode(index, { name: event.target.value }),
            }))),
          h(Field, { label: t('templateNodeDescription') }, h(Input, {
            name: `template.node.description.${index}`,
            value: node.description,
            onChange: event => patchNode(index, { description: event.target.value }),
          })),
          h('div', { className: 'rb-depends' },
            h('span', { className: 'rb-field-label' }, t('templateNodeDepends')),
            ownIds.filter(id => id !== node.id).map(id => h(Checkbox, {
              key: id,
              checked: node.dependsOn.includes(id),
              label: id,
              disabled: busy,
              onChange: next => toggleDepends(index, id, next),
            }))),
          h('div', { className: 'rb-node-fields' },
            h(Field, { label: t('templateNodeCompletion') }, h('select', {
              className: 'rb-select',
              name: `template.node.completion.${index}`,
              value: node.type,
              onChange: event => patchNode(index, { type: event.target.value }),
            },
              h('option', { value: 'manual' }, t('completionManual')),
              h('option', { value: 'checklist' }, t('completionChecklist'))))),
          node.type !== 'checklist' ? null : h('div', null,
            h('div', { className: 'rb-field-label' }, t('templateNodeChecklist')),
            h('div', { className: 'rb-checks' }, node.checklist.map((line, position) => h('div', {
              key: `check-${position}`,
              className: 'rb-check-row',
            },
              checkLine(
                event => patchNode(index, { checklist: node.checklist.map((entry, at) => (at === position ? event.target.value : entry)) }),
                line,
                `template.node.check.${index}.${position}`,
              ),
              h(Button, {
                className: 'rb-btn-pad rb-btn-sm rb-btn',
                variant: 'ghost',
                size: 'sm',
                name: `template.node.check.remove.${index}.${position}`,
                disabled: busy,
                onClick: () => patchNode(index, { checklist: node.checklist.filter((entry, at) => at !== position) }),
              }, t('templateRemoveCheck'))))),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: `template.node.check.add.${index}`,
              disabled: busy,
              onClick: () => patchNode(index, { checklist: [...node.checklist, ''] }),
            }, t('templateAddCheck'))))),
        h('div', { className: 'rb-row', style: { marginTop: 8 } },
          h(Button, {
            className: 'rb-btn-pad rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
            name: 'template.node.add',
            disabled: busy,
            onClick: addNode,
          }, t('templateAddNode')),
          h('span', { className: 'rb-grow' }),
          h(Button, {
            className: 'rb-btn-pad rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
            name: 'template.edit.cancel',
            disabled: busy,
            onClick: () => {
              setEditing(false)
              setConflict(null)
              setNotice(null)
            },
          }, t('cancel')),
          h(Button, {
            className: 'rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn',
            variant: 'primary',
            size: 'sm',
            name: 'template.revise.save',
            disabled: busy || !structureReady,
            onClick: () => void saveStructure(),
          }, t('save'))),
      ]

      const detailBody = () => detail === null
        ? h('div', { className: 'rb-muted' }, t('templateDetailEmpty'))
        : [
          h('div', { className: 'rb-panel' },
            h('div', { className: 'rb-node-card-head' },
              h('strong', null, detail.name),
              detail.builtin === true ? h(Tag, { tone: 'outline' }, t('templateBuiltin')) : null,
              detail.archived === true ? h(Tag, { tone: 'warning' }, t('templateArchived')) : null,
              h(Tag, { tone: 'info' }, interpolate(t('templateCurrentRevision'), { revision: currentRevision }))),
            detail.description === '' ? null : h('div', { className: 'rb-muted', style: { marginTop: 4 } }, detail.description),
            h('div', { className: 'rb-kv', style: { marginTop: 6 } },
              h('span', { className: 'rb-kv-key' }, t('templateInUse')),
              h('span', null, String(bound.length)),
              h('span', { className: 'rb-kv-key' }, t('templatePinnedOld')),
              h('span', { className: pinnedToOld > 0 ? 'rb-warn' : '' }, String(pinnedToOld)),
              h('span', { className: 'rb-kv-key' }, t('updated')),
              h('span', null, formatInstant(detail.updatedAt)),
              h('span', { className: 'rb-kv-key' }, t('nodesLabel')),
              h('span', null, String((detail.nodes ?? []).length))),
            pinsTruncated && bound.length > 0
              ? h('div', { className: 'rb-warn', style: { marginTop: 6 } }, interpolate(t('templatePinsTruncated'), { count: bound.length }))
              : null,
            pins === null
              ? h('div', { className: 'rb-warn', style: { marginTop: 6 } }, t('templatePinsUnknown'))
              : null,
            detail.archived === true
              ? h('div', { className: 'rb-notice rb-notice-hint', style: { margin: '8px 0 0' } }, t('templateArchivedNotice'))
              : null),
          h('div', { className: 'rb-section' },
            sectionHead('templatePreview', t),
            h(FlowChart, {
              requirement: { id: detail.id, flow: (detail.nodes ?? []).map(templateFlowNode) },
              selectedNodeId: null,
              onSelect: () => {},
              t,
            })),
          h('div', { className: 'rb-row', style: { marginTop: 10 } },
            h(Button, { className: 'rb-btn-pad rb-btn-sm rb-btn', variant: 'ghost', size: 'sm', name: 'template.edit', disabled: busy, onClick: startEdit }, t('edit')),
            h(Button, { className: 'rb-btn-pad rb-btn-sm rb-btn', variant: 'ghost', size: 'sm', name: 'template.migrate', disabled: busy, onClick: () => openMigration(currentRevision, undefined) }, t('templateMigration')),
            h(Button, { className: 'rb-btn-pad rb-btn-sm rb-btn', variant: 'ghost', size: 'sm', name: 'template.clone', disabled: busy, onClick: () => openForm('clone', detail.name, { name: '', description: '', nodes: '' }) }, t('templateClone')),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: 'template.archive',
              disabled: busy,
              onClick: () => void archive(detail.archived !== true),
            }, t(detail.archived === true ? 'templateRestoreAction' : 'templateArchiveAction')),
            h(Button, {
              variant: 'outline',
              size: 'sm',
              className: 'rb-btn-sm rb-btn rb-btn-danger',
              name: 'template.delete',
              disabled: busy,
              onClick: () => setDeleting(true),
            }, t('templateDelete'))),
          h('div', { className: 'rb-section' },
            sectionHead('templateVersions', t),
            versions.length === 0
              ? h('div', { className: 'rb-muted' }, t('templateVersionsEmpty'))
              : h('div', { className: 'rb-version-list' }, versions.map(versionRow))),
          h('div', { className: 'rb-section' },
            sectionHead('templateEditStructure', t),
            h('div', { className: 'rb-muted' }, t('templateReviseHint'))),
        ]

      return h(Dialog, {
        title: t('templates'),
        wide: true,
        drawer: true,
        closeLabel: t('close'),
        onClose,
        footer: [h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', key: 'close', onClick: onClose }, t('close'))],
      },
        h('div', { className: 'rb-drawer' },
          h('div', { className: 'rb-drawer-list' },
            h('div', { className: 'rb-drawer-filter' },
              h('span', { className: 'rb-section-title' }, t('templateList')),
              h(Checkbox, {
                checked: includeArchived,
                label: t('includeArchived'),
                onChange: next => setIncludeArchived(next),
              })),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
              name: 'template.new',
              disabled: busy,
              onClick: () => openForm('new', '', { name: '', description: '', nodes: '' }),
            }, t('newTemplate')),
            listLoadedRef.current && visible.length === 0
              ? h('div', { className: 'rb-muted' }, t('templateEmpty'))
              : null,
            h('div', { className: 'rb-template-rows', role: 'list' }, visible.map(template => h('button', {
              key: template.id,
              type: 'button',
              role: 'listitem',
              className: `rb-template-row${template.id === row?.id ? ' rb-template-row-picked' : ''}`,
              onClick: () => setSelectedId(template.id),
            },
              h('div', { className: 'rb-template-row-title' },
                h('span', null, template.name),
                template.builtin === true ? h(Tag, { tone: 'outline' }, t('templateBuiltin')) : null,
                template.archived === true ? h(Tag, { tone: 'warning' }, t('templateArchived')) : null),
              h('div', { className: 'rb-card-meta' },
                h('span', null, interpolate(t('templateCurrentRevision'), { revision: template.revision ?? 1 })),
                h('span', null, `${(template.nodes ?? []).length} ${t('nodeCount')}`),
                h('span', null, `${t('templateInUse')} ${
                  pins === null ? '—' : String((pins ?? []).filter(requirement => requirement.templateId === template.id).length)
                }`),
                pins === null ? null : h('span', {
                  className: (pins ?? []).some(requirement => requirement.templateId === template.id
                    && (requirement.templateRevision ?? 1) !== (template.revision ?? 1)) ? 'rb-warn' : '',
                }, `${t('templatePinnedOld')} ${
                  (pins ?? []).filter(requirement => requirement.templateId === template.id
                    && (requirement.templateRevision ?? 1) !== (template.revision ?? 1)).length
                }`)),
              h('div', { className: 'rb-card-meta' }, h('span', null, `${t('updated')}: ${formatInstant(template.updatedAt)}`)))))),
          h('div', { className: 'rb-drawer-body' },
            detailError === null ? null : h('div', { className: 'rb-notice rb-notice-error', role: 'alert' },
              controller.errorText(detailError, t)),
            notice === null ? null : h('div', { className: 'rb-notice rb-notice-error', role: 'alert' },
              controller.errorText(notice, t)),
            pruneTarget === null ? null : h('div', { className: 'rb-notice rb-notice-force', role: 'alert' },
              h('span', null, interpolate(t('templatePruneConfirm'), { revision: pruneTarget })),
              h('span', { className: 'rb-grow' }),
              h(Button, {
                variant: 'outline',
                size: 'sm',
                className: 'rb-btn-sm rb-btn rb-btn-danger',
                disabled: busy,
                onClick: () => void prune(pruneTarget),
              }, t('confirm')),
              h(Button, { className: 'rb-btn-pad rb-btn-sm rb-btn', variant: 'ghost', size: 'sm', onClick: () => setPruneTarget(null) }, t('cancel'))),
            row === null
              ? h('div', { className: 'rb-muted' }, t('templateDetailEmpty'))
              : editing && draft !== null ? editBody() : detailBody())),
        migrating === null || row === null ? null : h(MigrateTemplateDialog, {
          template: { id: row.id, name: detail?.name ?? row.name, nodes: detail?.nodes ?? row.nodes ?? [] },
          openedAt: migrateOpens,
          bound,
          busy,
          invoke,
          controller,
          t,
          onClose: () => setMigrating(null),
          onDone: async () => {
            setMigrating(null)
            await loadList(includeArchived)
            if (selectedId !== null) await loadDetail(selectedId)
          },
        }),
        form === null ? null : h(TemplateFormDialog, {
          form,
          discard,
          busy,
          error: formError,
          t,
          onPatch: patchForm,
          onAttemptClose: attemptCloseForm,
          onDrop: dropForm,
          onKeep: () => setDiscard(false),
          onSave: () => form.mode === 'new' ? void createNew(form.value) : void cloneTemplate(form.value.name),
        }),
        deleting ? h('div', { className: 'rb-panel', style: { marginTop: 12 } },
          h('div', null, t('templateDeleteConfirm')),
          bound.length === 0
            ? h('div', { className: 'rb-muted' }, t('templateDeleteClear'))
            : h('div', null,
              h('div', { className: 'rb-muted' }, interpolate(t('templateDeleteBound'), {
                fallback: fallback === null ? '—' : `${fallback.name} (${fallback.id})`,
              })),
              h('div', { className: 'rb-version-list' }, bound.map(requirement => h('div', {
                key: requirement.id,
                className: 'rb-impact-row',
              },
                h('span', null, interpolate(t('templateMigrationRow'), { title: requirement.title, id: requirement.id })),
                h('span', { className: 'rb-muted' }, interpolate(t('templateRevisionLine'), { revision: requirement.templateRevision ?? 1 })),
                h('div', { className: 'rb-impact-move' },
                  h('span', { className: 'rb-muted' }, `${t('templateMigrationFrom')}: ${requirement.nodeId}`),
                  h('span', { 'aria-hidden': true }, '→'),
                  h('span', null, landingOf(requirement)))))),
          h('div', { className: 'rb-row', style: { marginTop: 8 } },
            h(Button, {
              variant: 'outline',
              size: 'sm',
              className: 'rb-btn-sm rb-btn rb-btn-danger',
              name: 'template.delete.confirm',
              disabled: busy,
              onClick: () => {
                if (bound.length > 0 && !deleteArmed) {
                  setDeleteArmed(true)
                  return
                }
                void deleteTemplate()
              },
            }, bound.length > 0 && !deleteArmed ? t('templateDeleteArmed') : t('confirm')),
            h(Button, { className: 'rb-btn-pad rb-btn-sm rb-btn', variant: 'ghost', size: 'sm', onClick: () => { setDeleting(false); setDeleteArmed(false) } }, t('cancel')))))
          : null)
    }

    /**
     * Move the requirements pinned to an older revision onto the current one.
     *
     * The impact list is not computed here: the first call omits `requirementIds`,
     * which the Host refuses with `in-use` *before* it changes anything, and that
     * refusal's `details.affected` is rendered row by row. Confirming then sends
     * the named ids (or the bulk form with `force`), so the cost is visible before
     * the act rather than reported after it (§11.5, I4).
     *
     * `openedAt` names the opening this mount belongs to: the drawer hands a new
     * one every time the dialog is opened, so a migration that already ran cannot
     * leave its impact list behind for the next reader to confirm by accident.
     */
    function MigrateTemplateDialog({ template, openedAt, bound, busy, invoke, controller, t, onClose, onDone }) {
      const [affected, setAffected] = useState(null)
      const [selected, setSelected] = useState([])
      const [notice, setNotice] = useState('')
      const [bulk, setBulk] = useState(false)
      const [reading, setReading] = useState(false)
      useEffect(() => {
        setAffected(null)
        setSelected([])
        setBulk(false)
        setNotice('')
      }, [openedAt])
      const ids = affected === null ? [] : affected.map(entry => entry.id)
      const checked = id => selected.includes(id)
      const picked = ids.filter(id => checked(id)).length

      /**
       * Ask the Host for the impact, using its own refusal as the answer.
       *
       * This read calls the Host directly rather than through the drawer's
       * `invoke`: a refusal here is the step's expected outcome — `in-use` is how
       * the impact list arrives — so it is neither a toast nor an error notice,
       * and only a different failure is reported as one.
       */
      const read = async () => {
        setNotice('')
        setReading(true)
        try {
          const data = await controller.command('template.migrate', { id: template.id })
          const rows = data?.affected ?? []
          setAffected(rows)
          setSelected(rows.map(entry => entry.id))
          setNotice(t('templateMigrationNone'))
        } catch (error) {
          if (error?.code !== 'in-use') {
            controller.notify('error', controller.errorText(error, t))
            return
          }
          const rows = error?.details?.affected ?? []
          setAffected(rows)
          setSelected(rows.map(entry => entry.id))
        } finally {
          setReading(false)
        }
      }

      /** Send one confirmed migration: named ids, or the bulk form with force. */
      const confirm = async () => {
        const body = bulk
          ? { id: template.id, force: true }
          : { id: template.id, requirementIds: ids.filter(id => checked(id)) }
        const result = await invoke('template.migrate', body)
        if (!result.ok) return
        controller.notify('info', interpolate(t('templateMigrationDone'), { count: (result.data?.migrated ?? []).length }))
        setNotice('')
        await onDone()
      }

      const nameOf = id => {
        const found = bound.find(requirement => requirement.id === id)
        return found === undefined ? id : interpolate(t('templateMigrationRow'), { title: found.title, id })
      }
      const declared = template.nodes ?? []
      const nodeNameOf = id => declared.find(node => node.id === id)?.name ?? id

      const row = entry => h('label', { key: entry.id, className: 'rb-impact-row' },
        h('div', { className: 'rb-impact-head' },
          h(Checkbox, {
            checked: checked(entry.id),
            label: nameOf(entry.id),
            disabled: busy,
            onChange: next => setSelected(current => (next
              ? [...new Set([...current, entry.id])]
              : current.filter(id => id !== entry.id))),
          }),
          h(Tag, { tone: 'outline' }, interpolate(t('templateRevisionLine'), { revision: entry.revision }))),
        h('div', { className: 'rb-impact-move' },
          h('span', { className: 'rb-muted' }, `${t('templateMigrationFrom')}: ${nodeNameOf(entry.nodeId)}`),
          h('span', { 'aria-hidden': true }, '→'),
          h('span', null, `${t('templateMigrationTo')}: ${nodeNameOf(entry.next)}`)),
        h('div', { className: entry.clearedChecks ? 'rb-warn' : 'rb-muted' },
          entry.clearedChecks ? t('templateMigrationCleared') : t('templateMigrationKept')))

      const step = affected === null ? 1 : bulk ? 3 : 2
      return h(Dialog, {
        title: `${t('templateMigration')} — ${template.name}`,
        wide: true,
        closeLabel: t('close'),
        onClose,
        footer: [
          h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', key: 'cancel', onClick: onClose }, t('cancel')),
          affected === null
            ? h(Button, { className: 'rb-btn-primary-stroke rb-btn-pad rb-btn', variant: 'primary', key: 'read', disabled: busy || reading, onClick: () => void read() }, t('templateMigrationRead'))
            : h(Button, {
              className: 'rb-btn-primary-stroke rb-btn-pad rb-btn',
              variant: 'primary',
              key: 'confirm',
              disabled: busy || (!bulk && picked === 0),
              onClick: () => void confirm(),
            }, bulk ? t('templateMigrationBulk') : interpolate(t('templateMigrationPicked'), { count: picked })),
        ],
      },
        h('div', { className: 'rb-muted' }, interpolate(t('templateMigrationStep'), { step, total: 3 })),
        h('div', { className: 'rb-notice rb-notice-hint' }, t('templateMigrationHint')),
        notice === '' ? null : h('div', { className: 'rb-notice' }, notice),
        affected === null
          ? h('div', { className: 'rb-muted' }, interpolate(t('templateCurrentRevision'), { revision: template.revision ?? 1 }))
          : affected.length === 0
            ? h('div', { className: 'rb-muted' }, t('templateMigrationNone'))
            : h('div', { className: 'rb-version-list' }, affected.map(row)),
        affected === null || affected.length === 0 ? null : h('div', { className: 'rb-row', style: { marginTop: 8 } },
          h(Button, {
            className: 'rb-btn-pad rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
            name: 'template.migrate.all',
            disabled: busy,
            onClick: () => { setBulk(true); setNotice(t('templateMigrationBulkWarn')) },
          }, t('templateMigrationBulk')),
          h(Button, {
            className: 'rb-btn-pad rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
            name: 'template.migrate.pick',
            disabled: busy || bulk,
            onClick: () => { setBulk(false); setSelected([]) },
          }, interpolate(t('templateMigrationPicked'), { count: 0 }))))
    }

    /** The full requirement detail: header, flow chart, node detail, history. */
    /**
     * Hand one requirement to a named session.
     *
     * The panel may delegate to any session, including one that does not exist
     * yet: the human is not restricted to its own sub-sessions (`host/service.js`
     * `#assertOwnedTarget`), so the field takes a session id rather than a picker.
     */
    function DelegationForm({ busy, onDelegate, t }) {
      const [form, setForm] = useState({ session: '', duties: '', roleName: '' })
      const set = patch => setForm(current => ({ ...current, ...patch }))
      const ready = form.session.trim() !== ''
      return h('div', { className: 'rb-panel' },
        h('div', { className: 'rb-row' },
          h(Field, { label: t('delegateTarget') }, h(Input, {
            name: 'delegate.session',
            value: form.session,
            onChange: event => set({ session: event.target.value }),
          })),
          h(Field, { label: t('delegateDuties') }, h(Input, {
            name: 'delegate.duties',
            value: form.duties,
            placeholder: t('delegateDutiesHint'),
            onChange: event => set({ duties: event.target.value }),
          })),
          h(Field, { label: t('roleName') }, h(Input, {
            name: 'delegate.roleName',
            value: form.roleName,
            onChange: event => set({ roleName: event.target.value }),
          }))),
        h('div', { className: 'rb-row' },
          ready ? null : h('span', { className: 'rb-muted' }, t('delegateNeedsSession')),
          h('span', { className: 'rb-grow' }),
          h(Button, {
            className: 'rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn',
            variant: 'primary',
            size: 'sm',
name: 'delegate.submit',
            disabled: busy || !ready,
            onClick: () => onDelegate({
              session: form.session.trim(),
              duties: form.duties.split(',').map(entry => entry.trim()).filter(Boolean),
              roleName: form.roleName.trim()
            }),
          }, t('delegate'))))
    }

    /**
     * The fields a person may change on a requirement: priority, routing, and the
     * two gate links.
     *
     * The gate fields are shown only when the row carries them: a Host that does
     * not report `parentId`/`blocksOn` must not be handed an empty list that
     * would clear links it never showed. They are read as ids because the parent
     * or blocker may sit outside the fetched page, and the Host refuses a link it
     * cannot resolve (`missing-target`).
     */
    function EditFields({ requirement, roleOptions, projects, busy, onSave, onCancel, t }) {
      const hasParent = requirement.parentId !== undefined
      const hasBlocks = Array.isArray(requirement.blocksOn)
      // A Host that does not report the project must not be handed an empty one:
      // the field would clear a fact it never showed.
      const hasProject = requirement.project !== undefined
      const [draft, setDraft] = useState({
        priority: requirement.priority,
        role: requirement.role === '' ? ROLE_NONE : requirement.role,
        project: hasProject ? requirement.project : '',
        parentId: hasParent ? requirement.parentId ?? '' : '',
        blocksOn: hasBlocks ? requirement.blocksOn.join(', ') : '',
      })
      return h('div', { className: 'rb-panel' },
        h('div', { className: 'rb-row' },
          h(Field, { label: t('filterPriority') }, h('select', {
            className: 'rb-select',
            name: 'edit.priority',
            value: draft.priority,
            onChange: event => setDraft({ ...draft, priority: event.target.value }),
          }, ['low', 'normal', 'high', 'urgent'].map(value => h('option', { key: value, value },
            t(`priority${value[0].toUpperCase()}${value.slice(1)}`))))),
          h(Field, { label: t('filterRole') }, h('select', {
            className: 'rb-select',
            name: 'edit.role',
            value: draft.role,
            onChange: event => setDraft({ ...draft, role: event.target.value }),
          }, roleOptions.map(option => h('option', { key: option.value, value: option.value }, option.label))))),
        hasProject ? h('div', { className: 'rb-row' },
          h(Field, { label: t('project') },
            h('input', {
              className: 'rb-input',
              name: 'edit.project',
              value: draft.project,
              list: PROJECT_SUGGESTIONS_EDIT,
              maxLength: 60,
              onChange: event => setDraft({ ...draft, project: event.target.value }),
            }),
            h('datalist', { id: PROJECT_SUGGESTIONS_EDIT }, projects.map(name => h('option', { key: name, value: name }))))) : null,
        hasParent || hasBlocks ? h('div', { className: 'rb-row' },
          hasParent ? h(Field, { label: t('parentRequirement') }, h(Input, {
            name: 'edit.parentId',
            value: draft.parentId,
            onChange: event => setDraft({ ...draft, parentId: event.target.value }),
          })) : null,
          hasBlocks ? h(Field, { label: t('blocksOnTitle') }, h(Input, {
            name: 'edit.blocksOn',
            value: draft.blocksOn,
            placeholder: t('blocksOnHint'),
            onChange: event => setDraft({ ...draft, blocksOn: event.target.value }),
          })) : null) : null,
        h('div', { className: 'rb-row' },
          h('span', { className: 'rb-grow' }),
          h(Button, { className: 'rb-btn-pad rb-btn-sm rb-btn', variant: 'ghost', size: 'sm', onClick: onCancel}, t('cancel')),
          h(Button, {
            className: 'rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn',
            variant: 'primary',
            size: 'sm',
name: 'edit.save',
            disabled: busy,
            onClick: () => onSave({
              priority: draft.priority,
              role: draft.role === ROLE_NONE ? '' : draft.role,
              ...(hasProject ? { project: draft.project.trim() } : {}),
              ...(hasParent ? { parentId: draft.parentId.trim() } : {}),
              ...(hasBlocks ? { blocksOn: draft.blocksOn.split(',').map(entry => entry.trim()).filter(entry => entry !== '') } : {})
            }),
          }, t('save'))))
    }

    function RequirementDetail({ requirement, controller, run, busy, roles, roleOptions, projects, claimableIds, me, requirements, onDelegate, onRevokeDelegation, t }) {
      const [selectedNodeId, setSelectedNodeId] = useState(requirement.nodeId)
      const [confirmDelete, setConfirmDelete] = useState(false)
      const [editing, setEditing] = useState(false)
      const [forceOffer, setForceOffer] = useState(null)
      const [note, setNote] = useState('')
      /**
       * The choices this reader has picked in the option section but not yet
       * submitted, by question id, and the one reason that may travel with them.
       * They are a draft and nothing else: what the section shows as answered
       * always comes from the requirement's own `answer`.
       */
      const [picks, setPicks] = useState({})
      const [answerNote, setAnswerNote] = useState('')
      // Re-sync the view when another requirement is selected. This runs during
      // render rather than from an effect: an effect also fires when the panel
      // re-mounts, which would discard a half-typed edit or a gate refusal the
      // reader is still working through.
      const [syncedTo, setSyncedTo] = useState(`${requirement.id}#${requirement.nodeId}`)
      if (syncedTo !== `${requirement.id}#${requirement.nodeId}`) {
        setSyncedTo(`${requirement.id}#${requirement.nodeId}`)
        setSelectedNodeId(requirement.nodeId)
        setNote('')
        setEditing(false)
        setForceOffer(null)
        setPicks({})
        setAnswerNote('')
      }
      // The gate refusal offer belongs to the requirement that raised it, so a
      // value left from another selection can neither show here nor be armed.
      const forceRequest = forceOffer !== null && forceOffer.id === requirement.id ? forceOffer : null
      const node = requirement.flow.find(candidate => candidate.id === selectedNodeId) ?? null
      const last = requirement.lastTransition ?? null
      const lock = lockFacts(requirement.lock)
      const delegation = requirement.delegatedTo ?? null
      // The temporary role a hand-off minted for this requirement, read from the
      // role table the snapshot carries: it is the row that names this task.
      const temporary = (roles?.items ?? []).find(record => record.ephemeral === true && record.boundTask === requirement.id) ?? null
      /** A linked requirement id as `title (id)`, or the bare id when not listed. */
      const reference = id => {
        const known = (requirements ?? []).find(item => item.id === id)
        return known === undefined ? id : `${known.title} (${id})`
      }
      /**
       * One cell of the detail's meta grid: a dim label above its value.
       *
       * v3 §3 V3-1: the grid is a fixed ten cells, so an absent fact reads as a
       * dash on the cell's own surface rather than as a hole in the table; a
       * mono value carries its full text as a title because the cell clips it.
       * @param label - The cell's dim label.
       * @param value - The reading; empty renders as an em dash.
       * @param variant - Optional value class, e.g. the mono or numeral family.
       * @param options - `span2` fills two columns; `title` names the full value.
       */
      const metaCell = (label, value, variant, options) => {
        const opts = options ?? {}
        const empty = value === '' || value === null || value === undefined || value === '—'
        return h('div', { className: `rb-meta-cell${opts.span2 === true ? ' rb-meta-cell-span2' : ''}`, key: label },
          h('div', { className: 'rb-meta-k' }, label),
          h('div', {
            className: `rb-meta-v${variant === undefined ? '' : ` ${variant}`}`,
            'data-empty': empty ? 'true' : undefined,
            title: opts.title,
          }, empty ? '—' : value))
      }
      /**
       * Copy the requirement's id to the clipboard.
       *
       * The id is the handle every board tool and every message about this
       * requirement names, so moving work from the panel into a conversation
       * starts by getting that exact string. Clipboard access is attempted first;
       * the hidden textarea is the fallback for a context that does not expose it,
       * and either outcome is reported in the same toast the panel's writes use.
       */
      const copyRequirementId = async () => {
        const id = requirement.id
        try {
          if (globalThis.navigator?.clipboard?.writeText !== undefined) {
            await globalThis.navigator.clipboard.writeText(id)
          } else {
            const area = globalThis.document.createElement('textarea')
            area.value = id
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.top = '-1000px'
            area.style.opacity = '0'
            globalThis.document.body.appendChild(area)
            area.select()
            const refused = typeof globalThis.document.execCommand !== 'function' || globalThis.document.execCommand('copy') !== true
            globalThis.document.body.removeChild(area)
            if (refused) throw new Error('the clipboard is unavailable')
          }
          controller.notify('info', t('copiedId'))
        } catch {
          controller.notify('error', t('errCopyId'))
        }
      }
      /** Linked requirement ids as reference chips, or the "nothing linked" wording. */
      const linkList = ids => (ids ?? []).length === 0
        ? t('noneLinked')
        : (ids ?? []).map((id, index) => h('span', { key: `${id}#${index}`, className: 'rb-req-link' }, reference(id)))
      // The reading the two eligibility answers were asked for. A read that named
      // a session reports both per row; without one, `claimable` falls back to the
      // separately read id set and `advanceable` stays unknown rather than guessed.
      const reading = me === undefined || me === null || me === '' ? t('eligibilityPanel') : me
      const claimableAnswer = typeof requirement.claimable === 'boolean'
        ? requirement.claimable
        : claimableIds === null || claimableIds === undefined ? undefined : claimableIds.has(requirement.id)
      const advanceableAnswer = typeof requirement.advanceable === 'boolean' ? requirement.advanceable : undefined
      /**
       * The images stored with this requirement's description.
       *
       * The create command names images by id, so a Host that echoes the ids
       * back as strings reads the same as one that answers with references. An
       * entry naming no id is dropped rather than rendered as a broken image.
       */
      const descriptionImages = (Array.isArray(requirement.images) ? requirement.images : [])
        .map(image => ({ id: imageId(image), name: typeof image === 'string' ? '' : image?.name ?? '' }))
        .filter(image => typeof image.id === 'string' && image.id !== '')
      /**
       * The observed execution units of one requirement (§5.5).
       *
       * The three readings stay apart because they are different facts: sync
       * turned off (only the lock is known), sync on with a gap (something was not
       * observed), and sync on with nothing running (the units really are empty).
       * A missing `executions` field renders nothing rather than an empty table,
       * and `truncated` says the list is only the most recent slice. The
       * observation revision is printed beside the requirement revision because
       * executions move the former and never the latter.
       */
      const executionsSection = () => {
        const list = Array.isArray(requirement.executions) ? requirement.executions : null
        const sync = requirement.sync === undefined || requirement.sync === null ? null : requirement.sync
        if (list === null && sync === null) return null
        const units = list ?? []
        const running = typeof requirement.running === 'number'
          ? requirement.running
          : units.filter(unit => unit.status === 'running' || unit.status === 'stopping').length
        const settled = sync === null || (sync.enabled === true && sync.gap !== true)
        return foldSection('executions', t,
          running > 0 ? h('div', null, h(Tag, { tone: 'success' }, t('runningBadge', { count: running }))) : null,
          sync !== null && sync.enabled === false
            ? h('div', { className: 'rb-notice rb-notice-sync rb-warn' }, t('executionSyncOff'))
            : null,
          sync !== null && sync.enabled === true && sync.gap === true
            ? h('div', { className: 'rb-notice rb-notice-sync rb-warn' },
              h('span', null, t('executionSyncGap')),
              typeof sync.reason === 'string' && sync.reason !== ''
                ? h('span', { className: 'rb-muted' }, `${t('executionSyncReason')}: ${sync.reason}`)
                : null,
              typeof sync.syncedAt === 'string' && sync.syncedAt !== ''
                ? h('span', { className: 'rb-muted' }, `${t('executionSyncAt')}: ${formatInstant(sync.syncedAt)}`)
                : null)
            : null,
          units.length === 0 && settled ? h('div', { className: 'rb-empty', role: 'status' },
            h('span', { className: 'rb-empty-ico', 'aria-hidden': 'true' }, '◌'),
            h('span', { className: 'rb-empty-t' }, t('executionsEmpty'))) : null,
          units.length === 0 ? null : h('div', { className: 'rb-exec-list', role: 'list' }, units.map((unit, index) => h('div', {
            key: `${typeof unit.ref === 'string' ? unit.ref : 'unit'}#${index}`,
            className: `rb-exec-row${unit.stale === true ? ' rb-warn' : ''}`,
            role: 'listitem',
          },
            h(Tag, { tone: 'outline' }, t(unit.kind === 'job' ? 'unitJob' : 'unitSubagent')),
            typeof unit.label === 'string' && unit.label !== '' ? h('span', null, unit.label) : null,
            typeof unit.status === 'string' && unit.status !== ''
              ? h('span', { className: unit.status === 'running' || unit.status === 'stopping' ? 'rb-warn' : 'rb-muted' }, unit.status)
              : null,
            typeof unit.startedAt === 'string' && unit.startedAt !== ''
              ? h('span', { className: 'rb-muted' }, `${t('unitStarted')}: ${formatInstant(unit.startedAt)}`)
              : null,
            typeof unit.finishedAt === 'string' && unit.finishedAt !== ''
              ? h('span', { className: 'rb-muted' }, `${t('unitFinished')}: ${formatInstant(unit.finishedAt)}`)
              : null,
            unit.stale === true ? h('span', { className: 'rb-warn' }, t('unitStale')) : null,
            typeof unit.detail === 'string' && unit.detail !== '' ? h('span', { className: 'rb-muted' }, unit.detail) : null))),
          requirement.executionsTruncated === true ? h('div', { className: 'rb-muted' }, t('executionsTruncated')) : null,
          h('div', { className: 'rb-muted' }, t('executionsHint')),
          h('div', { className: 'rb-muted' }, t('execRevLine', { exec: requirement.execRev ?? 0, rev: requirement.rev })))
      }
      /**
       * The structured questions this requirement puts to the person.
       *
       * A record written before the field existed asks nothing, and a Host that
       * sends none renders no section at all rather than an empty one. `answer`
       * is the record's own map from question id to choice id and is the only
       * thing that ever reads as answered.
       */
      const questions = Array.isArray(requirement.options) ? requirement.options : []
      const answers = requirement.answer ?? {}
      const outstanding = questions.filter(question => answers[question.id] === undefined)

      /**
       * Send the reader's selections among the questions still open.
       *
       * Only those questions travel, and only the ones this reader picked: the
       * service merges a partial map, so a requirement asking two questions may
       * be answered one at a time. The draft is dropped once the write landed,
       * because the answer the section shows is the record's own — held to the
       * next refresh like every other fact on this page.
       */
      const submitAnswer = async () => {
        const answer = {}
        for (const question of outstanding) {
          if (picks[question.id] !== undefined) answer[question.id] = picks[question.id]
        }
        if (Object.keys(answer).length === 0) return
        const result = await run('decide', {
          id: requirement.id,
          expectedRev: requirement.rev,
          answer,
          note: answerNote.trim(),
        })
        if (!result.ok) return
        setPicks({})
        setAnswerNote('')
        controller.notify('info', t('optionAnswerSaved'))
      }

      /**
       * The option section: one block per question, its choices, and the form
       * that sends the picks among the questions still open.
       *
       * An answered question keeps its choices on screen with the stored pick
       * marked and its radios disabled: a person reads what the record holds,
       * and a question the record has settled is not offered again.
       */
      const optionsSection = () => {
        if (questions.length === 0) return null
        /** The choice one stored answer names, or null when it names none. */
        const chosenChoice = (question, id) => question.choices.find(choice => choice.id === id) ?? null
        return foldSection('options', t,
          // The header already says this decision waits for a person; the notice
          // says it again here, where the choices are.
          requirement.kind === 'decision' && outstanding.length > 0
            ? h('div', { className: 'rb-notice rb-notice-hint' }, t('optionAwaitingHuman'))
            : null,
          h('div', { className: 'rb-muted' }, t('optionsHint')),
          questions.map(question => {
            const chosen = answers[question.id]
            const open = chosen === undefined
            return h('div', { key: question.id, className: 'rb-question' },
              h('div', { className: 'rb-question-head' },
                h('span', { className: 'rb-question-prompt' }, question.prompt),
                h(Tag, { tone: 'outline' }, question.id),
                open ? null : h(Tag, { tone: 'success' }, t('optionAnsweredTag'))),
              h('div', { className: 'rb-field-label' }, open ? t('optionChooseOne') : t('optionYourAnswer')),
              question.choices.map(choice => {
                const on = open ? picks[question.id] === choice.id : chosen === choice.id
                return h('label', {
                  key: choice.id,
                  className: on ? 'rb-choice rb-choice-on' : 'rb-choice',
                },
                  h('input', {
                    type: 'radio',
                    name: `options.pick.${question.id}`,
                    value: choice.id,
                    checked: on,
                    disabled: !open || busy,
                    onChange: () => setPicks(current => ({ ...current, [question.id]: choice.id })),
                  }),
                  h('span', { className: 'rb-choice-body' },
                    h('span', { className: 'rb-choice-text' }, choice.label),
                    choice.recommended === true ? h(Tag, { tone: 'warning' }, t('optionRecommended')) : null,
                    choice.detail === undefined || choice.detail === '' ? null : h('span', { className: 'rb-choice-cost' }, choice.detail)))
              }),
              open || requirement.answeredAt === undefined || requirement.answeredAt === '' ? null : h('div', { className: 'rb-choice-note' },
                `${t('optionAnsweredAt')} ${formatInstant(requirement.answeredAt)}`,
                chosenChoice(question, chosen) === null ? null : h('span', { className: 'rb-muted' }, ` · ${t('optionYourAnswer')}: ${chosenChoice(question, chosen).label}`))
            )
          }),
          outstanding.length === 0 ? null : h('div', { className: 'rb-answer-form' },
            h(Field, { label: t('optionAnswerNote') }, h(Input, {
              name: 'options.note',
              value: answerNote,
              maxLength: 500,
              disabled: busy,
              onChange: event => setAnswerNote(event.target.value),
            })),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'primary',
              size: 'sm',
              name: 'options.submit',
              disabled: busy || outstanding.every(question => picks[question.id] === undefined),
              onClick: () => void submitAnswer(),
            }, t('optionSubmitAnswer'))),
          requirement.answerNote === undefined || requirement.answerNote === '' ? null : h('div', { className: 'rb-muted' },
            `${t('optionAnswerNote')}: ${requirement.answerNote}`))
      }
      return h('div', null,
        // The id and its copy control ride in the sticky identity row: the id is
        // the handle every tool and message names, so it stays in reach while the
        // body scrolls.
        h('div', { className: 'rb-detail-id' },
          h('span', null, requirement.id),
          h(Button, {
            className: 'rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
            name: 'requirement.copyId',
            onClick: () => void copyRequirementId(),
          }, t('copyId'))),
        h('div', { className: 'rb-detail-top' },
          h('div', { className: 'rb-detail-head' },
            h('h2', { className: 'rb-title', style: { margin: 0 } }, requirement.title)),
          h('span', { className: 'rb-grow' }),
          h('div', { className: 'rb-detail-actions' },
          h(Button, {
            className: 'rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
disabled: busy,
            onClick: () => setEditing(current => !current),
          }, t('editRequirement')),
          requirement.status === 'done'
            ? h(Button, {
              className: 'rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
disabled: busy,
              onClick: () => void run('transition', { id: requirement.id, expectedRev: requirement.rev, transition: 'reopen' }),
            }, t('reopen'))
            : null,
          requirement.status === 'blocked'
            ? h(Button, {
              className: 'rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
disabled: busy,
              onClick: () => void run('unblock', { id: requirement.id, expectedRev: requirement.rev, note: note.trim() }),
            }, t('unblock'))
            : null,
          requirement.status === 'archived'
            ? h(Button, {
              className: 'rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
disabled: busy,
              onClick: () => void run('restore', { id: requirement.id, expectedRev: requirement.rev }),
            }, t('restore'))
            : h(Button, {
              className: 'rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
disabled: busy,
              onClick: () => void run('archive', { id: requirement.id, expectedRev: requirement.rev }),
            }, t('archive')),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            className: 'rb-btn-sm rb-btn rb-btn-danger',
disabled: busy,
            onClick: () => setConfirmDelete(true),
            }, t('remove')))),
        // v3 §3 V3-25: the badge row scrolls with the body as its first node;
        // the sticky stack keeps only the identity row and the title/actions row.
        h('div', { className: 'rb-detail-badges' },
          h('div', { className: 'rb-badge-group' },
            h(StatusBadge, { status: requirement.status, t }),
            h(PriorityBadge, { priority: requirement.priority, t }),
            h(KindBadge, { kind: requirement.kind, t }),
            // A decision whose questions are still open says so where the reader
            // lands, before the folded section that asks them.
            requirement.kind === 'decision' && outstanding.length > 0
              ? h(Tag, { tone: 'warning' }, t('optionAwaitingHuman'))
              : null,
            h(RoleBadge, { role: requirement.role, roles, unregistered: requirement.roleUnregistered === true, t }),
            h(EligibilityBadges, { item: requirement, me, claimableIds, t }),
            h(CriticalBadge, {
              escalated: requirement.escalated,
              effectivePriority: requirement.effectivePriority,
              priority: requirement.priority,
              t,
            }),
            h(GatedBadge, { gated: requirement.gated, blockedBy: requirement.blockedBy, t }),
            h(BlocksBadge, { blocksOn: requirement.blocksOn, t }),
            h(DelegatedBadge, { delegatedTo: delegation, t }),
            h(ReservedBadge, { reservedBy: requirement.reservedBy, t }))),
        h('div', { className: `rb-summary${requirement.summary === '' ? ' rb-summary-empty' : ''}` },
          h('div', { className: 'rb-summary-tag' },
            h('span', null, t('summary')),
            h('span', { className: 'rb-en' }, 'BRIEF')),
          h('p', { className: 'rb-summary-text' },
            requirement.summary === '' ? t('summaryEmpty') : requirement.summary)),
        editing
          ? h(EditFields, {
            requirement,
            roleOptions,
            projects,
            busy,
            t,
            onCancel: () => setEditing(false),
            onSave: async patch => {
              const result = await run('update', { id: requirement.id, expectedRev: requirement.rev, patch })
              if (result.ok) {
                controller.notify('info', t('updateApplied'))
                setEditing(false)
              }
            },
          })
          : null,
        // v3 §3 V3-1/V3-15: a fixed ten cells in a fixed order — the stored
        // priority and the kind ride on the badge row above instead of doubling
        // here, and the last two cells span two columns so the grid ends full.
        h('div', { className: 'rb-meta-grid' },
          metaCell(t('owner'), requirement.owner === '' ? '' : requirement.owner),
          metaCell(t('project'), requirement.project === undefined || requirement.project === '' ? '' : requirement.project),
          metaCell(t('template'), requirement.template.name),
          metaCell(t('updated'), formatInstant(requirement.updatedAt)),
          metaCell(t('sessions'), requirement.sessions.join(', '), 'rb-meta-v-mono',
            { title: requirement.sessions.join(', ') }),
          metaCell(t('requestedBy'), requirement.requestedBy ?? '', 'rb-meta-v-mono',
            { title: requirement.requestedBy === undefined || requirement.requestedBy === '' ? undefined : requirement.requestedBy }),
          metaCell(t('revision'), String(requirement.rev), 'rb-meta-v-num'),
          metaCell(t('effectivePriority'),
            requirement.escalated === true && typeof requirement.effectivePriority === 'string' && requirement.effectivePriority !== ''
              ? `${requirement.effectivePriority}↑`
              : '',
            requirement.escalated === true ? 'rb-meta-v-hi' : undefined),
          metaCell(t('lock'), lock === null ? '' : lock.holder, 'rb-meta-v-mono',
            { span2: true, title: lock === null ? undefined : lock.holder }),
          metaCell(t('delegation'),
            delegation === null
              ? ''
              : delegation.name === undefined || delegation.name === '' ? delegation.session : `${delegation.name} (${delegation.session})`,
            'rb-meta-v-mono',
            {
              span2: true,
              title: delegation === null
                ? undefined
                : delegation.name === undefined || delegation.name === '' ? delegation.session : `${delegation.name} (${delegation.session})`,
            })),
        requirement.escalated === true
          ? h('div', { className: 'rb-muted', style: { marginTop: 4 } }, t('priorityLiftedHint'))
          : null,
        requirement.blockReason !== '' ? h('div', { className: 'rb-error', style: { marginTop: 4 } }, `${t('blockedBecause')}: ${requirement.blockReason}`) : null,
        requirement.description === '' ? null : foldSection('description', t,
          h('p', { className: 'rb-prose' }, requirement.description)),
        descriptionImages.length === 0 ? null : foldSection('images', t,
          h('div', { className: 'rb-images' }, descriptionImages.map((image, index) => h('a', {
            key: `${image.id}#${index}`,
            className: 'rb-image-row',
            href: imageURL(image.id),
            target: '_blank',
            rel: 'noreferrer',
            title: image.name === '' ? image.id : image.name,
          }, h('img', {
            className: 'rb-image-thumb',
            src: imageURL(image.id),
            alt: image.name === '' ? image.id : image.name,
          }))))),
        optionsSection(),
        foldSection('eligibility', t,
          h('div', { className: 'rb-muted' }, t('eligibilityFor', { me: reading })),
          h('div', { className: 'rb-kv' },
            h('span', { className: 'rb-kv-key' }, t('claimableYes')),
            h('span', { className: claimableAnswer === true ? 'rb-ink-success' : undefined }, claimableAnswer === undefined
              ? '—'
              : claimableAnswer ? t('claimableYes') : t('claimableNo')),
            h('span', { className: 'rb-kv-key' }, t('advanceableYes')),
            h('span', { className: advanceableAnswer === true ? 'rb-ink-info' : undefined }, advanceableAnswer === undefined
              ? '—'
              : advanceableAnswer ? t('advanceableYes') : t('advanceableNo'))),
          h('div', { className: 'rb-muted' }, t('advanceableHint'))),
        foldSection('gates', t,
          h('div', { className: 'rb-gate' },
            h('div', { className: 'rb-gate-row' },
              h('span', { className: 'rb-gk rb-kv-key' }, t('parentRequirement')),
              h('span', { className: 'rb-gv' }, requirement.parentId === undefined || requirement.parentId === null || requirement.parentId === ''
                ? t('noneLinked')
                : reference(requirement.parentId))),
            h('div', { className: 'rb-gate-row' },
              h('span', { className: 'rb-gk rb-kv-key' }, t('childrenTitle')),
              h('span', { className: 'rb-gv' }, linkList(requirement.children))),
            h('div', { className: 'rb-gate-row' },
              h('span', { className: 'rb-gk rb-kv-key' }, t('blocksOnTitle')),
              h('span', { className: 'rb-gv' }, linkList(requirement.blocksOn))),
            // The row the requirement is actually waiting on carries the red
            // frame the concept gives the current blocker.
            h('div', { className: `rb-gate-row${requirement.gated === true ? ' rb-gate-blocking' : ''}` },
              h('span', { className: 'rb-gk rb-kv-key' }, t('blockedByTitle')),
              h('span', { className: 'rb-gv' }, linkList(requirement.blockedBy)))),
          h('div', { className: 'rb-muted' }, t('gatesHint'))),
        executionsSection(),
        foldSection('lock', t,
          lock === null
            ? h('div', { className: 'rb-muted' }, t('unlocked'))
            : h('div', { className: `rb-panel${lock.orphaned ? ' rb-error' : ''}` },
              h('div', { className: 'rb-kv' },
                h('span', { className: 'rb-kv-key' }, t('lockHolder')),
                h('span', null, lock.holder),
                h('span', { className: 'rb-kv-key' }, t('lockHeldSince')),
                h('span', null, `${formatDuration(lock.heldMs)} · ${formatInstant(requirement.lock.at)}`),
                h('span', { className: 'rb-kv-key' }, t('lockTouched')),
                h('span', null, `${formatInstant(requirement.lock.touchedAt ?? requirement.lock.at)} · ${t('lockStale')} ${formatDuration(lock.idleMs)}`)),
              lock.orphaned ? h('div', { className: 'rb-error', style: { marginTop: 4 } }, t('lockOrphaned')) : null,
              lock.expired ? h('div', { className: 'rb-warn', style: { marginTop: 4 } }, t('lockExpired')) : null,
              h('div', { className: 'rb-row', style: { marginTop: 6 } },
                h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  className: 'rb-btn-sm rb-btn rb-btn-danger',
disabled: busy,
                  onClick: () => void run('release', { id: requirement.id, expectedRev: requirement.rev }),
                }, t('releaseLock'))))),
        foldSection('delegation', t,
          delegation === null
            ? h('div', null,
              h('div', { className: 'rb-muted' }, t('notDelegated')),
              h(DelegationForm, { busy, t, onDelegate: form => onDelegate(requirement, form) }))
            : h('div', { className: 'rb-panel' },
              h('div', { className: 'rb-kv' },
                h('span', { className: 'rb-kv-key' }, t('delegatedTo')),
                h('span', null, delegation.name === undefined || delegation.name === '' ? delegation.session : `${delegation.name} (${delegation.session})`),
                h('span', { className: 'rb-kv-key' }, t('filterRole')),
                h('span', null, roleName(delegation.roleId ?? '', roles) || delegation.roleId || t('roleNone')),
                h('span', { className: 'rb-kv-key' }, t('delegatedRoleBefore')),
                h('span', null, roleName(delegation.roleBefore ?? '', roles) || t('roleNone')),
                h('span', { className: 'rb-kv-key' }, t('delegatedAt')),
                h('span', null, formatInstant(delegation.at))),
              temporary === null
                ? null
                : h('div', { className: 'rb-card-meta' },
                  h(Tag, { tone: 'warning' }, t('roleEphemeral')),
                  h('span', null, `${t('roleBoundSession')}: ${temporary.boundSession ?? '—'}`),
                  h('span', null, `${t('roleBoundTask')}: ${temporary.boundTask ?? '—'}`)),
              h('div', { className: 'rb-row', style: { marginTop: 6 } },
                h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  className: 'rb-btn-sm rb-btn rb-btn-danger',
name: 'revoke.delegation',
                  disabled: busy,
                  onClick: () => onRevokeDelegation(requirement),
                }, t('revokeDelegation'))))),
        foldSection('flow', t,
          h(FlowChart, { requirement, selectedNodeId, onSelect: setSelectedNodeId, t })),
        foldSection('nodeDetail', t,
          h(NodeDetail, {
            requirement,
            node,
            busy,
            t,
            onAction: async (action, payload) => {
              const result = await run(action, payload)
              if (result.ok) {
                setNote('')
                setForceOffer(null)
                return
              }
              // A gate refusal is the one failure with a way forward: name the
              // blockers in place and offer the force, which stays a separate,
              // confirmed act (`invalid-transition` with `reason: 'blocked-by'`).
              if (result.error?.code === 'invalid-transition' && result.error.details?.reason === 'blocked-by') {
                setForceOffer({
                  id: requirement.id,
                  body: payload,
                  blockedBy: Array.isArray(result.error.details.blockedBy) ? result.error.details.blockedBy : [],
                  armed: false,
                })
              }
            },
          }),
          forceRequest === null ? null : h('div', { className: 'rb-notice rb-notice-force' },
            h('span', null, t('errBlockedBy')),
            h('span', { className: 'rb-muted' }, forceRequest.blockedBy.length === 0
              ? t('noneLinked')
              : forceRequest.blockedBy.map(id => reference(id)).join(', ')),
            h('span', { className: 'rb-grow' }),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
name: 'force.request',
              disabled: busy,
              onClick: () => setForceOffer(current => current === null ? null : { ...current, armed: true }),
            }, t('forceAdvance')),
            h(Button, {
              className: 'rb-btn-pad rb-btn-sm rb-btn',
              variant: 'ghost',
              size: 'sm',
onClick: () => setForceOffer(null),
            }, t('cancel')))),
        foldSection('history', t,
          last !== null ? h('div', { className: 'rb-muted', style: { marginBottom: 6 } },
            `${t('lastTransition')}: ${last.fromName || last.action} → ${last.toName} · ${formatInstant(last.at)}`) : null,
          h(History, { requirement, t })),
        forceRequest !== null && forceRequest.armed === true ? h(Dialog, {
          title: t('forceAdvance'),
          closeLabel: t('close'),
          onClose: () => setForceOffer(current => current === null ? null : { ...current, armed: false }),
          footer: [
            h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', key: 'cancel', onClick: () => setForceOffer(null)}, t('cancel')),
            h(Button, {
              variant: 'outline',
              className: 'rb-btn rb-btn-danger',
key: 'ok',
              name: 'force.confirm',
              disabled: busy,
              onClick: async () => {
                const result = await run('transition', { ...forceRequest.body, force: true })
                if (!result.ok) return
                controller.notify('info', t('forceApplied'))
                setForceOffer(null)
              },
            }, t('forceConfirm')),
          ],
        },
          h('div', null, t('forceWarning')),
          h('div', { className: 'rb-muted', style: { marginTop: 6 } }, `${t('blockedByTitle')}: ${forceRequest.blockedBy.length === 0
            ? t('noneLinked')
            : forceRequest.blockedBy.map(id => reference(id)).join(', ')}`)) : null,
        confirmDelete ? h(Dialog, {
          title: t('remove'),
          closeLabel: t('close'),
          onClose: () => setConfirmDelete(false),
          footer: [
            h(Button, { className: 'rb-btn-pad rb-btn', variant: 'ghost', key: 'cancel', onClick: () => setConfirmDelete(false)}, t('cancel')),
            h(Button, {
              variant: 'outline',
              className: 'rb-btn rb-btn-danger',
key: 'ok',
              disabled: busy,
              onClick: async () => {
                if ((await run('delete', { id: requirement.id, expectedRev: requirement.rev })).ok) setConfirmDelete(false)
              },
            }, t('confirm')),
          ],
        }, h('div', null, t('deleteConfirm'))) : null)
    }

    /** The main-column page. */
    /**
     * The board page's keyboard habits: j/k or the arrow keys move the list
     * selection, `/` opens the filters and focuses the search, Escape clears the
     * search while the search itself has focus. Typing fields keep their own
     * keys, and a dialog or the queue view leaves the list alone.
     *
     * C-1 (v3): the dialog gate sits before the `/` branch — a key stroke inside
     * a portaled dialog must never reach the page behind it, whatever the key;
     * and Escape only clears the query when the focused field is the search, so
     * cancelling a typo in a dialog input cannot silently drop the board filter.
     * @param board - the page state published by the current render.
     * @param event - the document keydown event.
     */
    function handleBoardKey(board, event) {
      if (board === null || board === undefined || event === undefined || event === null) return
      if (event.defaultPrevented === true || event.metaKey === true || event.ctrlKey === true || event.altKey === true) return
      const target = event.target ?? null
      const tag = target?.tagName ?? ''
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true
      if (typing) {
        if (event.key !== 'Escape') return
        target.blur?.()
        if (target.getAttribute?.('name') === 'query' && board.filter.query !== '') board.setFilter({ query: '' })
        return
      }
      if (board.dialog !== null) return
      if (event.key === '/') {
        event.preventDefault?.()
        board.openFilters()
        later(() => document.querySelector?.('input[name="query"]')?.focus())
        return
      }
      if (event.key === '?') {
        event.preventDefault?.()
        board.openHelp()
        return
      }
      if (board.view === 'queue') return
      const step = event.key === 'j' || event.key === 'ArrowDown' ? 1
        : event.key === 'k' || event.key === 'ArrowUp' ? -1
          : 0
      if (step === 0) return
      const items = board.visible
      if (items.length === 0) return
      event.preventDefault?.()
      const index = items.findIndex(item => item.id === board.selectedId)
      const next = items[Math.min(items.length - 1, Math.max(0, (index < 0 ? 0 : index) + step))]
      if (next === undefined || next.id === board.selectedId) return
      board.setSelectedId(next.id)
      later(() => document.querySelector?.(`[data-req="${next.id}"]`)?.scrollIntoView?.({ block: 'nearest' }))
    }

    /** Run after the browser has painted the state change, or immediately where
     * no animation frame exists (the offline client smoke test). */
    function later(callback) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback)
      else callback()
    }

    function BoardPage(props) {
      const state = props.useBoard(identity)
      const t = props.t
      const controller = props.controller
      const [dialog, setDialog] = useState(null)
      const [selectedId, setSelectedId] = useState(null)
      const [busy, setBusy] = useState(false)
      const [view, setView] = useState('board')
      /**
       * Whether the board is split into one section per project.
       *
       * Grouping is a reading of the same rows rather than a filter, so it stays
       * on the page: the Host is asked for nothing extra, and the requirement the
       * reader had selected stays selected across the switch.
       */
      const [grouped, setGrouped] = useState(false)
      /**
       * Whether the reader has folded or opened the filter area, and `null`
       * while she has not said anything: an untouched area follows the filters
       * themselves, so it opens by itself once one is in force. The choice is
       * this component's own and is written nowhere else.
       */
      const [filtersOpen, setFiltersOpen] = useState(null)
      /**
       * Whether the status trigger's own dimension menu is open (v3 §3 V3-22).
       *
       * It is a state of its own: the value trigger opens this small menu and
       * the "more filters" trigger opens the whole grid, and the two never
       * share one switch, so opening one never surprises the reader with the
       * other's contents.
       */
      const [statusMenuOpen, setStatusMenuOpen] = useState(false)
      /** Every requirement the board holds, unfiltered, for the drawer's pin counts. */
      const [pins, setPins] = useState(null)
      const [pinsTruncated, setPinsTruncated] = useState(false)
      /**
       * Selection mode for batch operations.
       *
       * The writes stay per requirement on the Host: the panel runs them one by
       * one and reports a per-id outcome, because one bulk request would hide
       * which row a revision conflict belonged to. Selection is a mode, not a
       * stored filter — leaving it writes nothing.
       */
      const [selecting, setSelecting] = useState(false)
      const [chosenIds, setChosenIds] = useState(() => new Set())
      const [batchPriority, setBatchPriority] = useState('')
      const [batchRole, setBatchRole] = useState('')
      const [batchBusy, setBatchBusy] = useState(false)
      /** The last batch's per-id outcome, or `null` when its dialog is closed. */
      const [batchResult, setBatchResult] = useState(null)

      const requirements = state.requirements
      const roles = state.roles
      const filter = state.filter
      /**
       * The summed template projection the snapshot carries.
       *
       * It is the list the drawer starts from; the drawer reads it again through
       * `template.list` so an archived template can be asked for, and this copy is
       * what a freshly opened drawer renders before that answer lands. The
       * built-in template's stored text is replaced with the active locale's.
       */
      const templates = (state.templates ?? []).map(template => localizeTemplate(template, t))
      /**
       * The listed rows exactly as the Host answered them.
       *
       * Every filter control travels to the Host, `role` included, because the
       * service filters by the routing role in force (`?role=human` is the human's
       * inbox) and answers with the same result set the model's `list` sees. The
       * page never narrows the fetched page itself: a row the service sent is a
       * row the reader asked for. Built-in template text is localized for display
       * here, once, so cards, detail, and the flow chart agree.
       */
      const visible = requirements.map(requirement => localizeRequirement(requirement, t))
      const selected = useMemo(
        () => visible.find(item => item.id === selectedId) ?? null,
        [visible, selectedId],
      )
      useEffect(() => {
        if (visible.length === 0 || selected !== null) return
        // A restored selection is kept only while its row is on screen; a row that
        // is filtered out (or gone) falls back to the first one.
        if (selectedId !== null && visible.some(item => item.id === selectedId)) return
        setSelectedId(visible[0].id)
      }, [visible, selected, selectedId])
      /**
       * Restore what this browser last had open, once. This is a reading of the
       * reader's own preferences, not board state: a stale id or an unreadable
       * document falls back to the defaults instead of failing the page.
       */
      const preferencesRestored = useRef(false)
      useEffect(() => {
        if (preferencesRestored.current) return
        preferencesRestored.current = true
        const saved = readPreferences()
        if (saved === null) return
        if (saved.view === 'board' || saved.view === 'queue' || saved.view === 'decisions') setView(saved.view)
        if (typeof saved.grouped === 'boolean') setGrouped(saved.grouped)
        if (typeof saved.selectedId === 'string' && saved.selectedId !== '') setSelectedId(saved.selectedId)
        const restored = sanitizeFilter(saved.filter)
        if (restored !== null) props.setFilter(restored)
      }, [props])
      /** Remember the reader's view, filter, grouping, and selection for the next visit. */
      useEffect(() => {
        writePreferences({ view, grouped, selectedId: selectedId ?? '', filter })
      }, [view, grouped, selectedId, filter])

      /** Run one command with the busy flag, the error notice, and a success flag. */
      const run = useCallback(async (action, payload) => {
        setBusy(true)
        try {
          const data = await controller.command(action, payload)
          return { ok: true, data }
        } catch (error) {
          controller.notify('error', controller.errorText(error, t))
          return { ok: false, error }
        } finally {
          setBusy(false)
        }
      }, [controller, t])

      /**
       * Run one command with the busy flag and no app toast.
       *
       * Role management reports a refusal where the work is — in the form dialog
       * that asked for the save, or on the row that asked for the delete — so it
       * takes the command path directly instead of `run`, whose error branch
       * raises the overlay toast. The toast would fade while the draft stayed on
       * screen, and the reader would have no reason next to the control.
       */
      const invokeQuietly = useCallback(async (action, payload) => {
        setBusy(true)
        try {
          const data = await controller.command(action, payload)
          return { ok: true, data }
        } catch (error) {
          return { ok: false, error }
        } finally {
          setBusy(false)
        }
      }, [controller])

      /** Toggle one row in selection mode. */
      const toggleChosen = id => setChosenIds(current => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      /** Select every listed row, or clear when all are already chosen. */
      const toggleChooseAll = () => setChosenIds(current =>
        current.size === visible.length && visible.length > 0
          ? new Set()
          : new Set(visible.map(item => item.id)))
      /** Leave selection mode and drop the selection and the pending patch. */
      const exitSelection = () => {
        setSelecting(false)
        setChosenIds(new Set())
        setBatchPriority('')
        setBatchRole('')
      }
      /**
       * Run one operation over the chosen rows, one requirement at a time.
       *
       * Each write carries the revision this list read, so a row another session
       * changed in between fails its own compare-and-set and is reported as a
       * conflict instead of being overwritten. The result keeps three groups so
       * the reader can retry exactly the rows that still need it; partial success
       * is a normal outcome, not an error.
       * @param action - Host command: `archive`, or `update` with a patch.
       * @param patchFor - the `update` patch for one row; omit for archive.
       */
      const runBatch = async (action, patchFor) => {
        if (batchBusy || chosenIds.size === 0) return
        setBatchBusy(true)
        const outcome = { ok: [], conflicts: [], failed: [] }
        const rows = visible.filter(item => chosenIds.has(item.id))
        try {
          for (const row of rows) {
            try {
              const payload = { id: row.id, expectedRev: row.rev }
              if (patchFor !== undefined) payload.patch = patchFor(row)
              await controller.command(action, payload)
              outcome.ok.push(row.id)
            } catch (error) {
              const entry = { id: row.id, message: controller.errorText(error, t) }
              if (error?.code === 'conflict') outcome.conflicts.push(entry)
              else outcome.failed.push(entry)
            }
          }
        } finally {
          setBatchBusy(false)
          setBatchResult({ ...outcome, action })
          exitSelection()
        }
      }

      /**
       * The selection-mode toolbar above the list.
       *
       * The entry button lives in the list head (v3 §3 V3-8); while selection is
       * on, this bar carries the count and the pending patch controls, and the
       * writes stay per requirement on the Host through {@link runBatch}.
       */
      const renderBatchBar = () => h('div', { className: 'rb-batch' },
        h('span', { className: 'rb-batch-count', role: 'status' }, t('batchChosen', { count: chosenIds.size, total: visible.length })),
        selecting
          ? h(Button, {
            className: 'rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
            name: 'batch.all',
            onClick: toggleChooseAll,
          }, t(chosenIds.size === visible.length && visible.length > 0 ? 'batchNone' : 'batchAll'))
          : null,
        selecting
          ? h(Button, {
            className: 'rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
            name: 'batch.archive',
            disabled: batchBusy || chosenIds.size === 0,
            onClick: () => void runBatch('archive'),
          }, batchBusy ? t('batchWorking') : t('batchArchive'))
          : null,
        selecting
          ? h('select', {
            className: 'rb-select rb-batch-select',
            name: 'batch.priority',
            'aria-label': t('batchPriority'),
            value: batchPriority,
            onChange: event => setBatchPriority(event.target.value),
          },
            h('option', { value: '' }, `${t('batchPriority')}: ${t('batchUnchanged')}`),
            ['low', 'normal', 'high', 'urgent'].map(value => h('option', { key: value, value }, t(`priority${value[0].toUpperCase()}${value.slice(1)}`))))
          : null,
        selecting
          ? h(Button, {
            className: 'rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
            name: 'batch.priorityApply',
            disabled: batchBusy || chosenIds.size === 0 || batchPriority === '',
            onClick: () => void runBatch('update', () => ({ priority: batchPriority })),
          }, t('batchApply'))
          : null,
        selecting
          ? h('select', {
            className: 'rb-select rb-batch-select',
            name: 'batch.role',
            'aria-label': t('batchRole'),
            value: batchRole,
            onChange: event => setBatchRole(event.target.value),
          },
            h('option', { value: '' }, `${t('batchRole')}: ${t('batchUnchanged')}`),
            roleOptions.map(option => h('option', { key: option.value, value: option.value }, option.label)))
          : null,
        selecting
          ? h(Button, {
            className: 'rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
            name: 'batch.roleApply',
            disabled: batchBusy || chosenIds.size === 0 || batchRole === '',
            onClick: () => void runBatch('update', () => ({ role: batchRole })),
          }, t('batchApply'))
          : null)

      /**
       * Read the unfiltered requirement set the drawer counts pins from.
       *
       * The read runs only while the drawer is open: its whole purpose is the
       * drawer's per-version "still pinned" counts, and the board page keeps its
       * own filtered read. It repeats on every committed change so a template
       * write by another session moves the counts the reader is looking at.
       */
      const readPins = useCallback(async () => {
        const answer = await controller.fetchPinList()
        if (answer === null) {
          setPins(null)
          setPinsTruncated(false)
          return
        }
        setPins(answer.items)
        setPinsTruncated(answer.total > answer.items.length)
      }, [controller])

      useEffect(() => {
        if (dialog !== 'template') return
        void readPins()
      }, [dialog, state.revision, readPins])

      /**
       * Switch view, restating the filter each view reads with.
       *
       * `queue` and `decisions` answer their own question and would be misread
       * through a leftover takeover filter, so both state the reading they want;
       * going back to the board only drops the kind.
       */
      const showView = next => {
        setView(next)
        if (next === 'queue') props.setFilter({ kind: '', role: '', claimable: false, me: '' })
        else if (next === 'decisions') props.setFilter({ kind: 'decision', role: '', claimable: false, me: '' })
        else props.setFilter({ kind: '' })
      }

      /** Clear one session's soft reservation on one requirement. */
      const clearReservation = async (session, item) => {
        const result = await run('unqueue', { id: item.id, targetSession: session })
        if (!result.ok) return
        // The receipt's `changed` separates "the reservation went away" from
        // "there was nothing to clear". An idempotent cleanup that found nothing
        // reports itself as a light note, never as a success.
        const changed = result.data?.changed === true
        controller.notify(changed ? 'info' : 'muted', t(changed ? 'reservationCleared' : 'reservationAbsent'))
      }

      const delegate = async (item, form) => {
        const result = await run('delegate', {
          id: item.id,
          session: form.session,
          duties: form.duties.length === 0 ? undefined : form.duties,
          roleName: form.roleName === '' ? undefined : form.roleName,
          expectedRev: item.rev,
        })
        if (result.ok) controller.notify('info', t('delegateDone', { session: form.session }))
      }

      /** End one requirement's hand-off, reporting the idempotent no-op distinctly. */
      const revokeDelegation = async item => {
        const result = await run('delegate', { id: item.id, revoke: true, expectedRev: item.rev })
        if (!result.ok) return
        const changed = result.data?.changed === true
        controller.notify(changed ? 'info' : 'muted', t(changed ? 'delegationRevoked' : 'delegationAbsent'))
      }

      /**
       * Every session's queue exactly as the service projects it.
       *
       * The order inside a row is the order the session will take the work in,
       * and `head` is the item a `queue`/`unqueue` receipt names, so the panel
       * renders the rows it was given and never orders reservations itself.
       */
      const queueRows = useMemo(() => (Array.isArray(state.queues) ? state.queues : [])
        .filter(row => (row.items ?? []).length > 0), [state.queues])
      /** One queued id's own row, when the fetched page lists it. */
      const requirementById = useMemo(() => {
        const map = new Map()
        for (const item of requirements) map.set(item.id, item)
        return map
      }, [requirements])

      /**
       * Whether this page is the unfiltered reading of an untouched board.
       *
       * The route reports `total` after filtering, so a filtered-to-zero answer
       * is indistinguishable from an empty board by `total` alone; the copy has
       * to come from whether the user asked for anything at all.
       */
      const defaultReading = filter.query === '' && filter.status === 'open' && filter.owner === ''
        && filter.session === '' && filter.priority === '' && filter.kind === '' && filter.role === ''
        && filter.claimable !== true && filter.me === ''
      const boardIsEmpty = defaultReading && state.total === 0

      const sessions = useMemo(() => {
        const seen = new Set()
        for (const item of requirements) for (const session of item.sessions) seen.add(session)
        for (const row of state.stats?.bySession ?? []) seen.add(row.session)
        return [...seen]
      }, [requirements, state.stats])
      const owners = useMemo(() => {
        const seen = new Set()
        for (const item of requirements) if (item.owner !== '') seen.add(item.owner)
        for (const row of state.stats?.byOwner ?? []) if (row.owner !== '(unassigned)') seen.add(row.owner)
        return [...seen]
      }, [requirements, state.stats])
      /**
       * The project names the filter, the group headers, and the form suggestions
       * offer.
       *
       * The Host reports the board's whole vocabulary, which is what keeps a
       * narrowed list from also narrowing the way out of it. A Host that reports
       * none is read through the page it did send, so the control still names the
       * projects the reader can see.
       */
      const projects = useMemo(() => {
        const seen = new Set(state.projects ?? [])
        for (const item of requirements) if (item.project !== undefined && item.project !== '') seen.add(item.project)
        return [...seen].sort((a, b) => a.localeCompare(b))
      }, [state.projects, requirements])
      /** Every role id the board has seen, recorded or only referenced. */
      const roleOptions = useMemo(() => {
        const seen = new Set()
        const options = [{ value: ROLE_NONE, label: t('roleNone') }]
        for (const record of roles?.items ?? []) {
          if (seen.has(record.id)) continue
          seen.add(record.id)
          options.push({ value: record.id, label: record.name === record.id ? record.id : `${record.name} (${record.id})` })
        }
        for (const record of roles?.unregistered ?? []) {
          if (seen.has(record.id)) continue
          seen.add(record.id)
          options.push({ value: record.id, label: `${record.id} · ${t('roleUnregistered')}` })
        }
        return options
      }, [roles, t])
      /**
       * The values the role filter may ask the Host for.
       *
       * The service reads `role` as the routing role in force and takes an empty
       * value to mean "no filter", so "no role recorded" cannot be asked for and
       * is not offered. The reserved `human` role is offered explicitly: it is
       * the human's inbox, and `me` (a session id) cannot express it.
       */
      const roleFilterOptions = useMemo(() => {
        const options = roleOptions.filter(option => option.value !== ROLE_NONE)
        if (!options.some(option => option.value === 'human')) {
          options.unshift({ value: 'human', label: t('roleHuman') })
        }
        return options
      }, [roleOptions, t])
      /** Unfinished requirements per role, as the Host already counts them. */
      const roleTally = useMemo(() => {
        const map = new Map()
        for (const row of state.stats?.byRole ?? []) map.set(row.role, row.total ?? 0)
        return map
      }, [state.stats])
      /**
       * One role filter value as the reader saw it offered: the reserved
       * `human` inbox by its own name, a recorded role by its record's label,
       * and a value the board never offered by the id it was asked for.
       */
      const roleFilterLabel = value => {
        if (value === 'human') return t('roleHuman')
        const option = roleFilterOptions.find(entry => entry.value === value)
        return option === undefined ? value : option.label
      }
      /**
       * The role filter as one compact control.
       *
       * It is a native select, so a long role list opens as the platform's own
       * scrolling dropdown and never adds a row to the page. The values and the
       * count beside each one are the ones the capsule row carried: every value
       * the Host may be asked for (`human` is its own inbox), each role's open
       * count from the Host's own tally, and "all" counting what is on screen.
       */
      const roleSelect = h('label', { className: 'rb-field', style: { flex: '0 1 180px' } },
        h('span', { className: 'rb-field-label' }, t(FILTER_LABELS.role)),
        h('select', {
          className: 'rb-select',
          name: 'filter.role',
          value: filter.role,
          'aria-label': t(FILTER_LABELS.role),
          onChange: event => props.setFilter({ role: event.target.value }),
        },
          h('option', { value: '' }, `${t('filterRoleAll')} (${visible.length})`),
          roleFilterOptions.map(option => h('option', { key: option.value, value: option.value },
            `${roleFilterLabel(option.value)} (${roleTally.get(option.value) ?? 0})`))))

      /**
       * The filters in force, each as the summary chip that names it and the
       * patch that clears it.
       *
       * A filter is in force when it asks for something the untouched board
       * would not: that reading is the open status, no project, and nothing
       * else, so those are what every entry here is compared against.
       */
      const activeFilters = useMemo(() => {
        const statusKeys = { open: 'open', active: 'statusActive', blocked: 'statusBlocked', done: 'statusDone', archived: 'statusArchived' }
        const priorityKeys = { low: 'priorityLow', normal: 'priorityNormal', high: 'priorityHigh', urgent: 'priorityUrgent' }
        const list = []
        if (filter.query !== '') list.push({ key: 'query', label: `${t('filterQuery')}: ${filter.query}`, clear: { query: '' } })
        if (filter.status !== 'open') list.push({ key: 'status', label: `${t('filterStatus')}: ${t(statusKeys[filter.status] ?? 'open')}`, clear: { status: 'open' } })
        if (filter.priority !== '') list.push({ key: 'priority', label: `${t('filterPriority')}: ${t(priorityKeys[filter.priority] ?? 'priorityNormal')}`, clear: { priority: '' } })
        if (filter.owner !== '') list.push({ key: 'owner', label: `${t('filterOwner')}: ${filter.owner}`, clear: { owner: '' } })
        if (filter.session !== '') list.push({ key: 'session', label: `${t('filterSession')}: ${filter.session}`, clear: { session: '' } })
        if (filter.kind !== '') list.push({ key: 'kind', label: `${t('filterKind')}: ${t(filter.kind === 'decision' ? 'kindDecision' : 'kindTask')}`, clear: { kind: '' } })
        if (filter.project !== undefined) list.push({ key: 'project', label: `${t('project')}: ${filter.project === '' ? t('projectUnassigned') : filter.project}`, clear: { project: undefined } })
        if (filter.role !== '') list.push({ key: 'role', label: `${t('filterRole')}: ${roleFilterLabel(filter.role)}`, clear: { role: '' } })
        if (filter.claimable === true) list.push({ key: 'claimable', label: t('filterClaimable'), clear: { claimable: false } })
        if (filter.me !== '') list.push({ key: 'me', label: `${t('filterMe')}: ${filter.me}`, clear: { me: '' } })
        return list
      }, [filter, t, visible.length, roles, roleFilterOptions])
      /**
       * One filter in force: its label, and a click that clears just that one.
       *
       * v3 §3 V3-14: the label can be clipped by the chip's own width, so the
       * title carries the full text and the accessible name adds the clearing
       * action it performs.
       */
      const filterChip = entry => h(Pill, {
        key: `filter.chip.${entry.key}`,
        className: 'rb-chip rb-chip-on',
        active: true,
        title: entry.label,
        'aria-label': `${entry.label} (${t('filterRemove')})`,
        name: `filter.chip.${entry.key}`,
        onClick: () => props.setFilter(entry.clear),
      }, h('span', { className: 'rb-chip-label' }, entry.label),
      h('span', { className: 'rb-chip-n', 'aria-hidden': 'true' }, '×'))
      /** Whether the controls are on screen, as the reader last left it. */
      // v3: the filter area is an overlay popover now, so an active filter must
      // not auto-open it over the list — the trigger's own value is the receipt.
      const filtersShown = filtersOpen === true
      /**
       * The reading the status trigger names, and the menu its own popover
       * offers (v3 §3 V3-22).
       *
       * The trigger carries the value in force, so the chip no longer repeats
       * it; the menu is the dimension's own four readings with the Host's
       * counts, and picking one writes the same `status` filter a KPI tile
       * writes. `archived` stays reachable through a restored preference and
       * reads on the trigger, though the menu offers the four live readings.
       */
      const statusKeys = { open: 'open', active: 'statusActive', blocked: 'statusBlocked', done: 'statusDone', archived: 'statusArchived' }
      const statusOn = filter.status !== '' && filter.status !== 'open'
      const statusTriggerLabel = `${t('filterStatus')}: ${filter.status === '' ? t('all') : t(statusKeys[filter.status] ?? 'open')}`
      const statusOptions = [
        { key: '', label: t('all') },
        { key: 'active', label: t('statusActive'), count: state.stats?.byStatus?.active ?? 0 },
        { key: 'blocked', label: t('statusBlocked'), count: state.stats?.byStatus?.blocked ?? 0 },
        { key: 'done', label: t('statusDone'), count: state.stats?.byStatus?.done ?? 0 },
      ]

      /**
       * One labelled filter control, so a select is never a bare value list.
       *
       * v3 §3 V3-5: the fields live in the popover's grid, so the wrapper is an
       * `rb-field` — the class that draws the select's caret — and the session
       * field may ask for two columns of room for its ids.
       */
      const select = (key, values, emptyLabel = t('all'), fieldClass = 'rb-field') => h('label', { key, className: fieldClass },
        h('span', { className: 'rb-field-label' }, t(FILTER_LABELS[key])),
        h('select', {
          className: 'rb-select',
          name: key,
          value: filter[key],
          'aria-label': t(FILTER_LABELS[key]),
          onChange: event => props.setFilter({ [key]: event.target.value }),
        },
          h('option', { value: '' }, emptyLabel),
          values.map(value => h('option', { key: value.value, value: value.value }, value.label))))

      const views = [
        { key: 'board', label: t('viewBoard') },
        { key: 'queue', label: t('viewQueue') },
        { key: 'decisions', label: t('viewDecisions') },
      ]

      /**
       * One queued requirement inside its session's row.
       *
       * A queue item is an id and the instant it was reserved, so the title comes
       * from the fetched page when that id is on it and the bare id stands in
       * otherwise. The first item carries the "next" mark the service's own
       * `head` names; nothing here reorders the row.
       * @param session - Session id the queue row belongs to.
       * @param entry - One `{ id, at }` item from the service's projection.
       * @param next - Whether this item is the row's head.
       */
      const queueRow = (session, entry, next) => {
        const item = requirementById.get(entry.id) ?? null
        return h('div', { key: entry.id, className: 'rb-queue-row' },
          next ? h(Tag, { tone: 'info' }, t('queueNext')) : null,
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            className: 'rb-btn-pad rb-btn-sm rb-btn rb-queue-title',
            onClick: () => setSelectedId(entry.id),
          }, item === null ? entry.id : item.title),
          item === null ? null : h(StatusBadge, { status: item.status, t }),
          item === null ? null : h(RoleBadge, { role: item.role, roles, unregistered: item.roleUnregistered === true, t }),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            className: 'rb-btn-sm rb-btn rb-btn-danger',
            name: `unqueue.${entry.id}`,
            disabled: busy,
            onClick: () => void clearReservation(session, entry),
          }, t('clearReservation')))
      }

      /**
       * One board card, shared by the flat list and the grouped sections.
       *
       * The project tag leads the metadata row: it is the fact the reader sorts by
       * when the board holds many requirements, and it is absent — not blank — for
       * one that belongs to no project, so nothing renders in its place.
       * @param item - one requirement from the fetched page.
       */
      const card = item => {
        const lock = lockFacts(item.lock)
        // The node progress on the title line: the active node's ordinal over
        // the whole flow, so a glance says how far along the work is.
        const step = item.progress.done === item.progress.total
          ? item.progress.total
          : item.progress.done + 1
        const chosen = chosenIds.has(item.id)
        return h('button', {
          key: item.id,
          type: 'button',
          role: 'listitem',
          'data-req': item.id,
          'data-status': item.status,
          'data-kind': item.kind,
          'aria-pressed': selecting ? chosen : undefined,
          // v3 §3 V3-14: the selected card states its currency to a reader, not
          // only through its border and background.
          'aria-current': item.id === selectedId && !selecting ? 'true' : undefined,
          className: `rb-card${item.id === selectedId && !selecting ? ' rb-card-selected' : ''}`
            + `${selecting ? ' rb-card-selectable' : ''}${selecting && chosen ? ' rb-card-chosen' : ''}`,
          onClick: () => { if (selecting) toggleChosen(item.id); else setSelectedId(item.id) },
        },
          h('div', { className: 'rb-card-title-row' },
            selecting ? h('span', { className: 'rb-batch-check', 'aria-hidden': 'true' }, chosen ? '✓' : '') : null,
            h('div', { className: 'rb-card-title' }, item.title),
            h('span', { className: 'rb-card-progress' },
              `${item.progress.activeNode?.name ?? item.nodeId} `,
              h('b', null, `${step}/${item.progress.total}`))),
          item.summary === undefined || item.summary === '' ? null : h('div', { className: 'rb-card-summary' }, item.summary),
          h('div', { className: 'rb-card-meta' },
            item.project === undefined || item.project === '' ? null : h('span', { className: 'rb-card-project' }, item.project),
            h(StatusBadge, { status: item.status, t }),
            h(PriorityBadge, { priority: item.priority, t }),
            h(CriticalBadge, {
              escalated: item.escalated,
              effectivePriority: item.effectivePriority,
              priority: item.priority,
              t,
            }),
            h(KindBadge, { kind: item.kind, t }),
            h(RoleBadge, { role: item.role, roles, unregistered: item.roleUnregistered === true, t }),
            h(EligibilityBadges, { item, me: filter.me, claimableIds: state.claimableIds, t }),
            h(GatedBadge, { gated: item.gated, blockedBy: item.blockedBy, t }),
            h(BlocksBadge, { blocksOn: item.blocksOn, t }),
            h(DelegatedBadge, { delegatedTo: item.delegatedTo, t }),
            h(ReservedBadge, { reservedBy: item.reservedBy, t }),
            h('span', null, item.owner === '' ? t('unassigned') : item.owner)),
          lock === null ? null : h('div', { className: `rb-card-meta${lock.orphaned ? ' rb-error' : ''}` },
            h('span', null, `🔒 ${lock.holder}`),
            h('span', null, `${t('lockHeldSince')} ${formatDuration(lock.heldMs)}`),
            lock.orphaned ? h('span', null, t('lockOrphaned')) : null),
          h('div', { className: 'rb-card-meta' },
            h('span', null, formatInstant(item.updatedAt))))
      }

      /** The queue view: each session's own order and who is next. */
      const renderQueue = () => h('div', { className: 'rb-list', role: 'list' },
        h('div', { className: 'rb-panel-head' },
          h('h2', null, t('viewQueue')),
          h('span', { className: 'rb-count' }, String(queueRows.length))),
        state.status === 'loading'
          ? h('div', { className: 'rb-skeleton' }, [0, 1, 2].map(index => h('div', {
            key: index,
            className: 'rb-skeleton-row',
            style: { height: 44 },
          })))
          : null,
        queueRows.length === 0 && state.status !== 'loading' && state.auth === ''
          ? h('div', { className: 'rb-empty', role: 'status' },
            h('span', { className: 'rb-empty-ico', 'aria-hidden': 'true' }, '◌'),
            h('span', { className: 'rb-empty-t' }, t('queueEmpty')))
          : null,
        // v3 §3 V3-17: the purple note and the order hint move into the right
        // column's queue-caliber fold; the left column keeps only the rows.
        h('div', { className: 'rb-queue' },
          queueRows.map(row => h('div', { key: row.session, className: 'rb-queue-group' },
            h('div', { className: 'rb-queue-head' },
              h('span', { className: 'rb-queue-session' }, `${t('queueTitle')}: ${row.session}`),
              h(Tag, { tone: 'outline' }, t('queueCount', { count: row.items.length }))),
            row.items.map((entry, index) => queueRow(row.session, entry, index === 0))))))

      /**
       * The state the keyboard handler reads, swapped on every render.
       *
       * The handler itself is installed once at the plugin level (so disposal
       * removes it); reading through this ref is what keeps it current without
       * re-binding a document listener on every state change.
       */
      const keyState = useRef(null)
      keyState.current = {
        visible,
        selectedId,
        view,
        dialog,
        filter,
        setSelectedId,
        setFilter: props.setFilter,
        openFilters: () => setFiltersOpen(true),
        openHelp: () => setDialog('keys'),
      }
      useEffect(() => {
        props.setKeyboardHandler(event => handleBoardKey(keyState.current, event))
        return () => props.setKeyboardHandler(null)
      }, [props.setKeyboardHandler])

      /** Turn a committed change that folded an extended list into one muted note. */
      const resetSeen = useRef(state.listReset ?? 0)
      useEffect(() => {
        const seen = state.listReset ?? 0
        if (seen > resetSeen.current) {
          resetSeen.current = seen
          controller.notify('muted', t('listReloaded'))
        }
        resetSeen.current = seen
      }, [state.listReset, controller, t])

      return h('div', { className: 'rb-root' },
        h('style', null, CSS),
        h('div', { className: 'rb-header' },
          // A drawn mark rather than a letter: the panel's identity must not
          // depend on any one locale's script or on a bundled font.
          h('span', { className: 'rb-logo', 'aria-hidden': 'true' },
            h('svg', { width: 16, height: 16, viewBox: '0 0 16 16' },
              h('rect', { x: 1, y: 2, width: 4, height: 12, rx: 1.5, fill: 'currentColor' }),
              h('rect', { x: 6, y: 2, width: 4, height: 8, rx: 1.5, fill: 'currentColor', opacity: 0.72 }),
              h('rect', { x: 11, y: 2, width: 4, height: 10, rx: 1.5, fill: 'currentColor', opacity: 0.5 }))),
          h('div', { className: 'rb-heading' },
            h('span', { className: 'rb-title' }, t('title')),
            h('span', { className: 'rb-sub' },
              h('span', {
                className: `rb-live${state.connected ? '' : ' rb-live-off'}`,
                title: t('live'),
              }),
              h('span', null, t('subtitle')))),
          h('span', { className: 'rb-grow' }),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            className: 'rb-btn-sm rb-btn',
name: 'refresh',
            disabled: state.auth !== '',
            onClick: () => void props.refresh(),
          }, t('refresh')),
          h(Button, { variant: 'ghost', size: 'sm', className: 'rb-btn-sm rb-btn', onClick: () => setDialog('roles')}, t('roles')),
          h(Button, { variant: 'ghost', size: 'sm', className: 'rb-btn-sm rb-btn', onClick: () => setDialog('template')}, t('templates')),
          h(Button, {
            variant: 'primary',
            size: 'sm',
            className: 'rb-btn-sm rb-btn rb-btn-primary',
            onClick: () => setDialog('requirement'),
          }, t('newRequirement'))),
        h('div', { className: 'rb-views', role: 'tablist', 'aria-label': t('view') },
          h('div', { className: 'rb-segmented' },
            views.map(entry => h(Pill, {
              key: entry.key,
              role: 'tab',
              name: `view.${entry.key}`,
              id: `rb-view-tab-${entry.key}`,
              className: view === entry.key ? 'rb-seg rb-seg-on' : 'rb-seg',
              active: view === entry.key,
              'aria-selected': view === entry.key,
              'aria-controls': 'rb-board-view',
              // Roving tabindex: one stop for the tablist, the arrow keys move
              // between the views, which is the tab pattern readers expect.
              tabIndex: view === entry.key ? 0 : -1,
              onClick: () => showView(entry.key),
              onKeyDown: event => {
                const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                if (step === 0) return
                event.preventDefault?.()
                const index = views.findIndex(candidate => candidate.key === view)
                const nextView = views[(index + step + views.length) % views.length]
                showView(nextView.key)
                later(() => document.getElementById?.(`rb-view-tab-${nextView.key}`)?.focus())
              },
            }, entry.label)))),
        // The trust gate's refusal is not a transient failure and has no retry: the
        // page cannot reach the board again until it is opened afresh, so the
        // notice says which refusal it was and carries no button that would only
        // repeat it.
        state.auth === '' ? null : h('div', { className: 'rb-notice rb-notice-auth', role: 'alert' },
          h('span', null, t(state.auth === 'expired' ? 'authExpired' : 'authCrossOrigin')),
          h('span', { className: 'rb-muted' }, t(state.auth === 'expired' ? 'authExpiredHint' : 'authCrossOriginHint')),
          h(Button, {
            className: 'rb-btn-pad rb-btn-sm rb-btn',
            variant: 'ghost',
            size: 'sm',
name: 'auth.recheck',
            onClick: () => void props.recheck(),
          }, t('recheck'))),
        state.auth === '' && state.everConnected && !state.connected
          ? h('div', { className: 'rb-notice rb-notice-stale' },
            h('span', null, t('staleNotice')),
            h(Button, { className: 'rb-btn-pad rb-btn-sm rb-btn', variant: 'ghost', size: 'sm', onClick: () => void props.refresh()}, t('retry')))
          : null,
        state.auth === '' && state.error !== null
          ? h('div', { className: 'rb-notice rb-notice-error' },
            h('span', null, controller.errorText(state.error, t)),
            h(Button, { className: 'rb-btn-pad rb-btn-sm rb-btn', variant: 'ghost', size: 'sm', onClick: () => void props.refresh()}, t('retry')))
          : null,
        // v3 §3 V3-7: the decisions view's explanation is no longer an orphan
        // banner above the band; it leads the right column's decision-flow fold.
        h(StatsStrip, { stats: state.stats, roles, t, filter, setFilter: props.setFilter }),
        view === 'board' ? h('div', { className: 'rb-filters' },
          // v3 §3 V3-5/V3-21/V3-22/V3-23: one row — the search, the status value
          // trigger with its own dimension menu, the "more filters" trigger that
          // opens the whole grid as a popover over the list, the receipts of what
          // is in force, and a right cluster hanging off a container that is
          // always rendered so hiding the clear button cannot drag it left.
          h('div', { className: 'rb-filter-bar' },
            h(Input, {
              className: 'rb-input rb-search',
              name: 'query',
              value: filter.query,
              'aria-label': t('filterQuery'),
              onChange: event => props.setFilter({ query: event.target.value }),
            }),
            h('span', {
              className: 'rb-trigger-wrap',
              // A click outside the wrap moves the focus elsewhere, which is the
              // cheapest outside-click the page can listen for.
              onBlur: event => {
                if (!event.currentTarget.contains(event.relatedTarget ?? null)) setStatusMenuOpen(false)
              },
            },
              h('button', {
                type: 'button',
                className: `rb-trigger${statusOn ? ' rb-trigger-on' : ''}`,
                'data-on': statusOn ? 'true' : undefined,
                'aria-expanded': statusMenuOpen,
                'aria-haspopup': 'menu',
                onClick: () => setStatusMenuOpen(current => !current),
              }, statusTriggerLabel),
              statusMenuOpen ? h('div', { className: 'rb-status-pop', role: 'menu', 'aria-label': t('filterStatus') },
                statusOptions.map(option => {
                  const chosen = option.key === ''
                    ? filter.status === '' || filter.status === 'open'
                    : filter.status === option.key
                  return h('button', {
                    key: option.key === '' ? 'all' : option.key,
                    type: 'button',
                    role: 'menuitemradio',
                    className: `rb-status-opt${chosen ? ' rb-status-opt-on' : ''}`,
                    'aria-checked': chosen,
                    onClick: () => {
                      props.setFilter({ status: option.key || 'open', kind: '' })
                      setStatusMenuOpen(false)
                    },
                  },
                    h('span', null, option.label),
                    option.count === undefined ? null : h('span', { className: 'rb-chip-n' }, String(option.count)))
                })) : null),
            h('button', {
              type: 'button',
              className: 'rb-trigger',
              name: 'filter.toggle',
              'aria-expanded': filtersShown,
              onClick: () => setFiltersOpen(!filtersShown),
            }, t('moreFilters')),
            activeFilters.length === 0
              ? h('span', { className: 'rb-muted' }, t('filterSummaryAll'))
              : h('div', { className: 'rb-filter-chips' },
                // The status reading rides on the trigger above; a chip beside it
                // would repeat it word for word.
                activeFilters.filter(entry => entry.key !== 'status').map(filterChip)),
            h('span', { className: 'rb-bar-right' },
              activeFilters.length === 0 ? null : h('button', {
                type: 'button',
                className: 'rb-clear',
                name: 'filter.clear',
                onClick: () => props.setFilter({
                  query: '', status: '', priority: '', owner: '', session: '', role: '', kind: '', project: undefined, claimable: false, me: '',
                }),
              }, t('clearFilters')),
              h('span', { className: 'rb-count-chip' }, `${visible.length} / ${state.stats?.total ?? 0}`),
              h('span', { className: 'rb-keys', 'aria-hidden': 'true' }, t('keyboardHint')))),
          filtersShown ? h('div', { className: 'rb-filter-pop' },
            h('div', { className: 'rb-filter-grid' },
              select('session', sessions.map(value => ({ value, label: value })), t('all'), 'rb-field rb-field-span2'),
              select('kind', [
                { value: 'task', label: t('kindTask') },
                { value: 'decision', label: t('kindDecision') },
              ]),
              // The project control cannot use `select`: its empty value is the
              // Host's spelling of "belongs to no project", so the option standing for
              // "every project" needs a value of its own and the sentinel maps back to
              // the empty string on the way out.
              h('label', { className: 'rb-field' },
                h('span', { className: 'rb-field-label' }, t(FILTER_LABELS.project)),
                h('select', {
                  className: 'rb-select',
                  name: 'project',
                  value: filter.project === undefined ? '' : (filter.project === '' ? PROJECT_UNASSIGNED : filter.project),
                  'aria-label': t(FILTER_LABELS.project),
                  onChange: event => props.setFilter({
                    project: event.target.value === ''
                      ? undefined
                      : (event.target.value === PROJECT_UNASSIGNED ? '' : event.target.value),
                  }),
                },
                  h('option', { value: '' }, t('all')),
                  h('option', { value: PROJECT_UNASSIGNED }, t('projectUnassigned')),
                  projects.filter(name => name !== PROJECT_UNASSIGNED).map(name => h('option', { key: name, value: name }, name)))),
              select('priority', ['low', 'normal', 'high', 'urgent'].map(value => ({
                value,
                label: t(`priority${value[0].toUpperCase()}${value.slice(1)}`),
              }))),
              select('owner', owners.map(value => ({ value, label: value }))),
              h('div', { className: 'rb-toggle-row' },
                h('button', {
                  type: 'button',
                  className: `rb-toggle${grouped ? ' rb-toggle-on' : ''}`,
                  'aria-pressed': grouped,
                  onClick: () => setGrouped(!grouped),
                }, t('groupProject')),
                h('button', {
                  type: 'button',
                  className: `rb-toggle${filter.claimable === true ? ' rb-toggle-on' : ''}`,
                  'aria-pressed': filter.claimable === true,
                  onClick: () => props.setFilter({ claimable: filter.claimable !== true }),
                }, t('filterClaimable')),
                h('label', { className: 'rb-field', style: { flex: '0 1 220px' } },
                  h('span', { className: 'rb-field-label' }, t('filterMe')),
                  h(Input, {
                    className: 'rb-input',
                    name: 'me',
                    value: filter.me,
                    title: t('filterMeHint'),
                    'aria-label': t('filterMe'),
                    onChange: event => props.setFilter({ me: event.target.value }),
                  })),
                roleSelect))) : null)
          : null,
        h('div', { className: 'rb-body', id: 'rb-board-view' },
          view === 'queue'
            ? renderQueue()
            : h('div', { className: 'rb-list-pane' },
              // v3 §3 V3-8: the column names itself, counts what it shows, and
              // carries the batch entry on the same row instead of a button
              // floating above the list with nothing to belong to.
              h('div', { className: 'rb-list-head' },
                h('span', { className: 'rb-list-title' }, view === 'decisions' ? t('viewDecisions') : t('listTitle')),
                h('span', { className: 'rb-list-count' }, String(visible.length)),
                h(Button, {
                  className: 'rb-btn rb-btn-sm',
                  variant: selecting ? 'ghost' : 'outline',
                  size: 'sm',
                  name: 'batch.toggle',
                  onClick: () => { if (selecting) exitSelection(); else setSelecting(true) },
                }, t(selecting ? 'batchExit' : 'batchSelect'))),
              selecting ? renderBatchBar() : null,
              h('div', { className: 'rb-list', role: 'list' },
              state.status === 'loading'
                ? h('div', null,
                  // The skeleton is the visual; the status line stays for a
                  // reader that cannot see it.
                  h('span', { className: 'rb-sr', role: 'status' }, t('loading')),
                  h('div', { className: 'rb-skeleton' }, [0, 1, 2, 3].map(index => h('div', {
                    key: index,
                    className: 'rb-skeleton-row',
                    style: { height: index === 0 ? 14 : 52 },
                  }))))
                : null,
              visible.length === 0 && state.status !== 'loading' && state.auth === ''
                ? h('div', { className: 'rb-empty', role: 'status' },
                  h('span', { className: 'rb-empty-ico', 'aria-hidden': 'true' }, '◌'),
                  h('span', { className: 'rb-empty-t' }, view === 'decisions'
                    ? t('decisionsEmpty')
                    : boardIsEmpty ? t('emptyBoard') : t('empty')))
                : null,
              grouped
                ? projectGroups(visible, t('projectUnassigned')).map(group => h('section', { key: group.key, className: 'rb-group' },
                  h('div', { className: 'rb-group-head' },
                    h('span', { className: 'rb-group-name' }, group.label),
                    h('span', { className: 'rb-group-n' }, String(group.items.length))),
                  h('div', { className: 'rb-list', role: 'list' }, group.items.map(card))))
                : visible.map(card),
              // A board larger than one page says how much of it is on screen
              // and appends the next page on request.
              visible.length < state.total && state.status === 'ready'
                ? h('div', { className: 'rb-list-more' },
                  h(Button, {
                    variant: 'outline',
                    size: 'sm',
                    className: 'rb-btn-pad rb-btn-sm rb-btn',
                    name: 'board.loadMore',
                    disabled: state.loadingMore === true,
                    onClick: () => void props.loadMore(),
                  }, t('loadMore', { shown: visible.length, total: state.total })))
                : null)),
          // The scroll container is keyed by the selected requirement, so
          // switching rows remounts it and the new detail starts at its top.
          h('div', { className: 'rb-detail', key: selected === null ? 'none' : selected.id },
            selected !== null
              ? h(RequirementDetail, {
                requirement: selected,
                controller,
                run,
                busy,
                roles,
                roleOptions,
                projects,
                claimableIds: state.claimableIds,
                me: filter.me,
                requirements,
                onDelegate: delegate,
                onRevokeDelegation: revokeDelegation,
                t,
              })
              // v3 §3 V3-7/V3-20: no hint line repeats the left column's empty
              // state; the one reading the right column adds on an empty board
              // is the invitation to create the first requirement.
              : view === 'board' && state.stats?.total === 0
                ? h('div', { className: 'rb-muted' }, t('emptyBoard'))
                : null,
            // v3 §3 V3-7: the right column answers the view it is in. The queue
            // and decisions views lead with their own caliber and keep the board
            // overview folded beside it; the board view reads the overview open.
            view === 'queue'
              ? h('div', null,
                foldSection('secQueueCaliber', t,
                  h('dl', { style: { margin: 0 } },
                    h('div', { className: 'rb-def-row' },
                      h('dt', null, t('caliberReserve')),
                      h('dd', null, t('queueSoftHint'))),
                    h('div', { className: 'rb-def-row' },
                      h('dt', null, t('caliberHead')),
                      h('dd', null, t('queueHint'))),
                    h('div', { className: 'rb-def-row' },
                      h('dt', null, t('caliberCap')),
                      h('dd', null, t('caliberCapBody'))))),
                foldSectionClosed('secOverview', t, h(ProgressPanel, { stats: state.stats, t })))
              : view === 'decisions'
                ? h('div', null,
                  foldSection('secDecisions', t,
                    h('div', { className: 'rb-notice rb-notice-hint', role: 'note', style: { margin: '0 0 10px' } },
                      h('span', null, t('viewDecisionsHint')),
                      h(Tag, { tone: 'warning' }, t('decisionBadge'))),
                    h('dl', { style: { margin: 0 } },
                      h('div', { className: 'rb-def-row' },
                        h('dt', null, t('answerHow')),
                        h('dd', null, t('answerHowBody'))),
                      h('div', { className: 'rb-def-row' },
                        h('dt', null, t('agentBoundary')),
                        h('dd', null, t('agentBoundaryBody'))))),
                  foldSectionClosed('secOverview', t, h(ProgressPanel, { stats: state.stats, t })))
                : h(ProgressPanel, { stats: state.stats, t }))),
        dialog === 'requirement' ? h(CreateRequirementDialog, {
          templates,
          defaultTemplateId: state.templates[0]?.id ?? 'tpl-standard',
          projects,
          busy,
          t,
          onUpload: props.uploadImage,
          onClose: () => setDialog(null),
          onSubmit: async form => {
            const created = await run('create', { requirement: form })
            setDialog(null)
            return created
          },
        }) : null,
        dialog === 'template' ? h(TemplateDrawer, {
          templates,
          pins,
          pinsTruncated,
          busy,
          run,
          invokeQuiet: invokeQuietly,
          controller,
          revision: state.revision,
          onClose: () => setDialog(null),
          t,
        }) : null,
        dialog === 'roles' ? h(RolesDialog, {
          roles,
          status: state.status,
          busy,
          invoke: invokeQuietly,
          onClose: () => setDialog(null),
          t,
        }) : null,
        batchResult === null ? null : h(Dialog, {
          title: t('batchResultTitle'),
          closeLabel: t('close'),
          onClose: () => setBatchResult(null),
          footer: [h(Button, {
            key: 'close',
            className: 'rb-btn-pad rb-btn',
            variant: 'ghost',
            onClick: () => setBatchResult(null),
          }, t('close'))],
        },
          h('div', { className: 'rb-batch-result' },
            h('div', { className: 'rb-muted' }, t('batchResultSummary', {
              ok: batchResult.ok.length,
              conflict: batchResult.conflicts.length,
              failed: batchResult.failed.length,
            })),
            [['ok', 'batchResultOk'], ['conflicts', 'batchResultConflict'], ['failed', 'batchResultFailed']].map(([group, label]) =>
              batchResult[group].length === 0 ? null : h('div', { key: group, className: 'rb-batch-group' },
                h('h3', null, `${t(label)} (${batchResult[group].length})`),
                batchResult[group].map(entry => typeof entry === 'string'
                  ? h('div', { key: entry, className: 'rb-batch-row' }, entry)
                  : h('div', { key: entry.id, className: 'rb-batch-row' }, `${entry.id} — ${entry.message}`)))))),
        dialog === 'keys' ? h(Dialog, {
          title: t('shortcutsTitle'),
          closeLabel: t('close'),
          onClose: () => setDialog(null),
          footer: [h(Button, {
            key: 'close',
            className: 'rb-btn-pad rb-btn',
            variant: 'ghost',
            onClick: () => setDialog(null),
          }, t('close'))],
        },
          h('div', { className: 'rb-shortcuts' },
            ['shortcutMove', 'shortcutSearch', 'shortcutClear', 'shortcutHelp'].map(key =>
              h('div', { key, className: 'rb-shortcut' }, t(key))))) : null)
    }

    return {
      name: PANEL_ID,
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')
        let t = (key, params) => interpolate(DICT.en[key] ?? key, params)
        if (locale !== undefined && locale !== null) {
          ctx.effect(() => locale.register(NS, DICT), 'requirement-board: locale')
          const translate = locale.bind(NS)
          // The dictionary owns its `{name}` placeholders, so they are filled
          // here whether or not the locale layer substitutes them.
          t = (key, params) => {
            const text = translate(key, params)
            return interpolate(text === undefined || text === '' ? DICT.en[key] ?? key : text, params)
          }
        }
        const controller = createBoardController()
        ctx.effect(() => controller.start(), 'requirement-board: board sync')
        /**
         * The page's keyboard habits are listened for at the document, so a key
         * typed while the page has focus anywhere inside it still counts. The
         * listener and the page's handler both go away with the plugin effect.
         */
        const keyboard = { handler: null }
        ctx.effect(() => {
          const onKeyDown = event => { if (keyboard.handler !== null) keyboard.handler(event) }
          document.addEventListener('keydown', onKeyDown)
          return () => {
            keyboard.handler = null
            document.removeEventListener('keydown', onKeyDown)
          }
        }, 'requirement-board: keyboard navigation')

        const face = {
          hooks: { board: controller.source },
          t,
          controller: controller.face,
          uploadImage: controller.face.uploadImage,
          refresh: controller.face.refresh,
          loadMore: controller.face.loadMore,
          recheck: controller.face.recheck,
          setFilter: controller.face.setFilter,
          setKeyboardHandler: handler => { keyboard.handler = handler },
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon))
        // The toast host is declared into `shell.overlay`, not into the panel:
        // it must outlive the panel so a command that closes it still reports.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: `${PANEL_ID}.toast`,
          order: 30,
          locale: NS,
          inject: () => ({ hooks: { toast: controller.toast }, dismissToast: controller.face.dismissToast }),
        }, BoardToast))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => face,
        }, BoardPage))
      },
    }
  },
})
