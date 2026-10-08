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
        edit: 'Edit',
        save: 'Save',
        removeRole: 'Delete role',
        removeRoleConfirm: 'Delete this role? Requirements that still name it become unrecorded.',
        filterRole: 'Role',
        filterKind: 'Kind',
        kindTask: 'Task',
        kindDecision: 'Decision',
        filterClaimable: 'Only claimable',

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
        errDelegated: 'Another session handed this requirement on already.',
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
        edit: '编辑',
        save: '保存',
        removeRole: '删除角色',
        removeRoleConfirm: '删除该角色？仍引用它的需求会变成「未登记」',
        filterRole: '角色',
        filterKind: '类型',
        kindTask: '任务',
        kindDecision: '决策',
        filterClaimable: '只看可接',

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
        errDelegated: '该需求已被派发给其他会话。',
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
    }

    /**
     * Filter keys the Host's list route understands (`host/http.js`). `role` is
     * the routing role in force (`?role=human` is the human's inbox); `me` is the
     * session whose reading of the hand-off pool is asked for. Passing a key the
     * route ignores would look like it worked, so the sets are kept apart.
     */
    const HOST_FILTER_KEYS = ['session', 'owner', 'status', 'priority', 'kind', 'role', 'templateId', 'query', 'claimable', 'me']

    /** Role select value standing for "the requirement names no role". */
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

    /**
     * How long a burst of committed-change events shares one read.
     *
     * The Host pushes `changed` once per committed write, and one write burst
     * (execution sync alone) can raise many of them. Every read fetches the whole
     * snapshot, so the page waits the burst out instead of reading per event.
     */
    const CHANGED_READ_DEBOUNCE_MS = 200

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
        queues: [],
        filter: { session: '', owner: '', status: 'open', priority: '', query: '', role: '', kind: '', claimable: false, me: '' },
        connected: false,
        everConnected: false,
        auth: '',
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
       */
      const refresh = async () => {
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
        const query = new URLSearchParams()
        for (const key of HOST_FILTER_KEYS) {
          const value = filter[key]
          if (value === '' || value === false || value === undefined || value === null) continue
          query.set(key, String(value))
        }
        query.set('limit', '200')
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
            // Every session's queue in the order the service will take it. The
            // panel renders positions from this projection instead of ordering
            // reservations itself, so a receipt's `head` and the queue view name
            // the same item.
            queues: Array.isArray(payload.data.queues) ? payload.data.queues : [],
          })
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
          void refresh()
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
.rb-root { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); font-size:13px; line-height:1.5; }
.rb-header { display:flex; align-items:center; gap:8px; padding:12px 16px; flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1); }
.rb-heading { display:flex; flex-direction:column; min-width:0; }
.rb-title { font-size:15px; font-weight:500; }
.rb-sub { font-size:11px; color:var(--dsw-alias-label-secondary); }
.rb-grow { flex:1 1 auto; }
/* Two classes so the override wins on specificity, not stylesheet order; no ancestor selector, so it also holds inside the Modal's body portal. */
.rb-btn-danger.rb-btn-danger { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.rb-scroll { overflow:auto; min-height:0; }
.rb-stats { display:flex; flex-wrap:wrap; gap:8px; padding:10px 16px; flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.rb-stat { min-width:96px; padding:6px 10px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); }
.rb-stat-label { font-size:11px; color:var(--dsw-alias-label-secondary); }
.rb-stat-value { font-size:16px; font-weight:500; }
.rb-bar { height:6px; border-radius:3px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; margin-top:6px; }
.rb-bar-fill { height:100%; background:var(--dsw-alias-brand-primary); }
.rb-filters { display:flex; flex-wrap:wrap; gap:10px; padding:8px 16px; flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1); align-items:center; }
.rb-filter { display:inline-flex; align-items:center; gap:4px; }
/* Native select and textarea keep their own element, aligned to the Input
 * primitive's frame so a field looks the same whichever element draws it. */
.rb-select, .rb-textarea { font:inherit; font-size:14px; line-height:22px; color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-1); border:.5px solid var(--dsw-alias-border-l4);
  border-radius:var(--dsw-radius-md); padding:0 8px; height:32px; min-width:0; }
.rb-select:focus, .rb-textarea:focus { border-color:var(--dsw-alias-state-business-primary); outline:none; }
.rb-select::placeholder, .rb-textarea::placeholder { color:var(--dsw-alias-label-dimmed); }
.rb-textarea { width:100%; min-height:64px; height:auto; padding:6px 8px; resize:vertical; box-sizing:border-box; }
/* Semantic ink for a value that reads as an answer rather than as a badge. */
.rb-ink-success { color:var(--dsw-alias-state-success-primary); }
.rb-ink-info { color:var(--dsw-alias-brand-primary); }
.rb-body { display:flex; flex:1 1 auto; min-height:0; }
.rb-list { width:308px; flex:none; overflow:auto; border-right:1px solid var(--dsw-alias-border-l1); }
.rb-detail { flex:1 1 auto; overflow:auto; min-width:0; padding:16px; }
.rb-card { display:block; width:100%; text-align:left; appearance:none; font:inherit; cursor:pointer;
  padding:10px 12px; border:0; border-bottom:1px solid var(--dsw-alias-border-l1);
  background:transparent; color:inherit; }
.rb-card:hover { background:var(--dsw-alias-bg-layer-1); }
.rb-card-selected { background:var(--dsw-alias-bg-layer-2); }
.rb-card-title { font-weight:500; margin-bottom:2px; overflow-wrap:anywhere; }
.rb-card-meta { font-size:11px; color:var(--dsw-alias-label-secondary); display:flex; gap:6px; flex-wrap:wrap; }
.rb-flow { overflow-x:auto; overflow-y:hidden; padding:6px 2px 14px; }
.rb-flow-canvas { position:relative; }
.rb-flow-edges { position:absolute; left:0; top:0; overflow:visible; pointer-events:none; }
.rb-edge-path { fill:none; stroke:var(--dsw-alias-state-idle-primary); stroke-width:1.5; }
.rb-edge-head { fill:var(--dsw-alias-state-idle-primary); }
.rb-edge-done .rb-edge-path { stroke:var(--dsw-alias-state-success-primary); }
.rb-edge-done .rb-edge-head { fill:var(--dsw-alias-state-success-primary); }
.rb-node { position:absolute; box-sizing:border-box; overflow:hidden; padding:7px 9px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); cursor:pointer; text-align:left; font:inherit; appearance:none; }
.rb-node:hover { border-color:var(--dsw-alias-label-secondary); }
.rb-node-name { font-weight:500; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rb-node-meta { font-size:10px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rb-node-done { border-color:var(--dsw-alias-state-success-primary); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.rb-node-done .rb-node-mark { color:var(--dsw-alias-state-success-primary); }
.rb-node-active { border-color:var(--dsw-alias-brand-primary); box-shadow:0 0 0 1px var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-primary); }
.rb-node-active .rb-node-mark { color:var(--dsw-alias-brand-primary); }
.rb-node-pending .rb-node-mark { color:var(--dsw-alias-state-idle-primary); }
.rb-node-picked { outline:1px dashed var(--dsw-alias-label-secondary); outline-offset:2px; }
.rb-node-mark { font-size:11px; }
.rb-section { margin-top:18px; }
.rb-section-title { font-size:12px; font-weight:500; color:var(--dsw-alias-label-secondary);
  text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }
.rb-panel { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:10px 12px;
  background:var(--dsw-alias-bg-layer-1); }
.rb-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.rb-kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:12px; }
.rb-kv-key { color:var(--dsw-alias-label-secondary); }
.rb-check { display:flex; gap:8px; align-items:flex-start; padding:3px 0; cursor:pointer; }
.rb-check-done { color:var(--dsw-alias-state-success-primary); }
.rb-history { display:flex; flex-direction:column; gap:6px; max-height:280px; overflow:auto; }
.rb-history-row { display:flex; gap:8px; font-size:12px; align-items:baseline; }
.rb-history-time { color:var(--dsw-alias-label-secondary); font-size:11px; white-space:nowrap; }
.rb-error { color:var(--dsw-alias-state-error-primary); }
.rb-warn { color:var(--dsw-alias-state-warn-primary); }
.rb-muted { color:var(--dsw-alias-label-secondary); }
.rb-notice { margin:8px 16px 0; padding:6px 10px; border-radius:6px; font-size:12px;
  border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); }
.rb-notice-error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
/* The platform Modal supplies the mask, surface, elevation, header, footer,
   and frame insets; the board only widens the card its tables need. The card is
   body-portaled, so it re-establishes the panel's own typographic context. */
.rb-dialog, .rb-dialog-wide { max-height:100%; font-size:13px; line-height:1.5;
  color:var(--dsw-alias-label-primary); }
.rb-dialog { width:min(560px, 100%); }
.rb-dialog-wide { width:min(680px, 100%); }
.rb-field { display:flex; flex-direction:column; gap:3px; }
.rb-field-label { font-size:11px; color:var(--dsw-alias-label-secondary); }
.rb-icon { display:block; }
.rb-table { width:100%; border-collapse:collapse; font-size:12px; }
.rb-table td, .rb-table th { text-align:left; padding:3px 6px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.rb-table th { color:var(--dsw-alias-label-secondary); font-weight:500; }
.rb-notice-stale { display:flex; align-items:center; gap:8px;
  border-color:var(--dsw-alias-state-warn-primary); }
.rb-notice-hint { display:flex; align-items:center; gap:8px;
  border-left:3px solid var(--dsw-alias-brand-primary); }
.rb-role-list { display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px; overflow:hidden; max-height:40vh; overflow-y:auto; }
.rb-role-row { display:flex; flex-direction:column; gap:3px; padding:8px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1); }
.rb-role-row:last-child { border-bottom:0; }
.rb-role-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.rb-role-name { font-weight:500; }
.rb-duties { display:flex; flex-wrap:wrap; gap:4px; }
.rb-skeleton { display:flex; flex-direction:column; gap:8px; padding:10px 12px; }
.rb-skeleton-row { height:14px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); }
.rb-views { display:flex; align-items:center; gap:4px; padding:8px 16px 0; flex:none; }
.rb-badge-group { display:inline-flex; align-items:center; gap:3px; }
.rb-notice-force { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  border-color:var(--dsw-alias-state-error-primary); }
.rb-role-tally { display:flex; align-items:center; gap:6px; flex-wrap:wrap; width:100%; }
.rb-queue { display:flex; flex-direction:column; gap:6px; padding:10px 12px; overflow:auto; }
.rb-queue-group { display:flex; flex-direction:column; gap:4px; padding:8px 10px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.rb-queue-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.rb-queue-session { font-weight:500; }
.rb-queue-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
.rb-queue-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rb-exec-list { display:flex; flex-direction:column; gap:4px; margin:4px 0; }
.rb-exec-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12px; }
.rb-notice-sync { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.rb-notice-auth { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  border-color:var(--dsw-alias-state-error-primary); }
/* Stored images: the description's screenshots, both while a create is being
   filled in and when a saved requirement is read back. */
.rb-images { display:flex; flex-wrap:wrap; gap:8px; }
.rb-image-row { display:flex; align-items:center; gap:6px; }
.rb-image-thumb { max-width:160px; max-height:120px; border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2); object-fit:cover; }
/* The create dialog offers each picture as a square tile whose remove control
   rides its corner, so a picture and the control that drops it read as one
   object; the tile keeps one size through uploading, stored and failed, so a
   settle never reflows the grid. */
.rb-image-hint { flex:1; min-width:0; font-size:11px; color:var(--dsw-alias-label-secondary); }
.rb-image-tile { position:relative; width:96px; height:96px; }
.rb-image-tile-thumb { display:block; width:100%; height:100%; box-sizing:border-box;
  border-radius:6px; border:1px solid var(--dsw-alias-border-l2); object-fit:cover; }
.rb-image-tile-state { display:flex; align-items:center; justify-content:center; width:100%;
  height:100%; padding:6px; box-sizing:border-box; overflow:hidden; text-align:center;
  word-break:break-all; font-size:11px; border-radius:6px;
  border:1px dashed var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.rb-image-tile .rb-image-remove { position:absolute; top:4px; right:4px; width:20px;
  height:20px; min-width:20px; padding:0; border-radius:50%; font-size:12px; line-height:1;
  border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); }
.rb-image-tile .rb-image-remove:hover { color:var(--dsw-alias-state-error-primary);
  border-color:var(--dsw-alias-state-error-primary); }
/* The picker is driven by its own button, so the native control stays out of
   the layout but remains reachable for the keyboard and assistive technology. */
.rb-file-input { position:absolute; width:1px; height:1px; padding:0; margin:-1px;
  overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
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
     */
    function Dialog({ title, closeLabel, onClose, children, footer, wide }) {
      return h(Modal, {
        open: true,
        onClose,
        title,
        closeLabel,
        className: wide === true ? 'rb-dialog-wide' : 'rb-dialog',
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
     * Role management: the recorded roles, the ids in use but unrecorded, and
     * the panel's only write path into the roles table (`put`/`delete`).
     *
     * A temporary role is shown with what delegation bound it to, and typed in,
     * because the task that minted it owns its lifetime; an unrecorded row can
     * be registered here, which is the only way a requirement's dangling role id
     * stops reading as unregistered.
     */
    function RolesDialog({ roles, status, busy, run, onClose, t }) {
      const [draft, setDraft] = useState(null)
      const [confirmId, setConfirmId] = useState(null)
      const items = roles?.items ?? []
      const unregistered = roles?.unregistered ?? []
      const set = patch => setDraft(current => ({ ...current, ...patch }))
      /** Open the form for a new role, or for one existing record. */
      const startEdit = record => setDraft({
        roleId: record.id,
        roleName: record.name ?? record.id,
        duties: (record.duties ?? []).join(', '),
        existing: record.name !== undefined,
      })
      const submit = async () => {
        const result = await run('role.put', {
          role: {
            roleId: draft.roleId.trim(),
            roleName: draft.roleName.trim(),
            duties: draft.duties.split(',').map(entry => entry.trim()).filter(Boolean),
          },
        })
        if (result.ok) setDraft(null)
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

      const row = (record, unrecorded) => h('div', { key: record.id, className: 'rb-role-row' },
        h('div', { className: 'rb-role-head' },
          h('span', { className: 'rb-role-name' }, record.name ?? record.id),
          h(Tag, { tone: 'outline' }, record.id),
          record.ephemeral === true ? h(Tag, { tone: 'warning' }, t('roleEphemeral')) : null,
          unrecorded || record.dutiesMissing === true
            ? h(Tag, { tone: unrecorded ? 'danger' : 'warning' },
              unrecorded ? t('roleUnregistered') : t('roleDutiesMissing'))
            : null,
          h('span', { className: 'rb-grow' }),
          record.ephemeral !== true
            ? h(Button, {
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
              className: 'rb-btn-danger',
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
          : null)

      const loaded = items.length > 0 || unregistered.length > 0
      return h(Dialog, {
        title: t('roles'),
        wide: true,
        closeLabel: t('close'),
        onClose,
        footer: [
          h(Button, { variant: 'ghost', key: 'new', disabled: busy, onClick: () => setDraft({ roleId: '', roleName: '', duties: '', existing: false })}, t('newRole')),
          h('span', { key: 'grow', className: 'rb-grow' }),
          h(Button, { variant: 'ghost', key: 'close', onClick: onClose}, t('close')),
        ],
      },
        draft !== null ? h('div', null,
          h(Field, { label: t('roleId') }, h(Input, {
            name: 'role.roleId',
            value: draft.roleId,
            disabled: draft.existing === true,
            onChange: event => set({ roleId: event.target.value }),
          })),
          h(Field, { label: t('roleName') }, h(Input, {
            name: 'role.roleName',
            value: draft.roleName,
            onChange: event => set({ roleName: event.target.value }),
          })),
          h(Field, { label: `${t('roleDuties')} — ${t('roleDutiesHint')}` }, h(Input, {
            name: 'role.duties',
            value: draft.duties,
            onChange: event => set({ duties: event.target.value }),
          })),
          h('div', { className: 'rb-row' },
            h(Button, {
              variant: 'primary',
name: 'role.save',
              disabled: busy || draft.roleId.trim() === '',
              onClick: () => void submit(),
            }, t('save')),
            h(Button, { variant: 'ghost', onClick: () => setDraft(null)}, t('cancel')))) : null,
        status === 'loading' && !loaded
          ? h('div', { className: 'rb-skeleton' }, [0, 1, 2].map(index => h('div', {
            key: index,
            className: 'rb-skeleton-row',
            style: { width: `${90 - index * 18}%` },
          })))
          : null,
        status !== 'loading' && !loaded ? h('div', { className: 'rb-muted' }, t('rolesEmpty')) : null,
        loaded
          ? h('div', { className: 'rb-role-list' },
            items.map(record => row(record, false)),
            unregistered.length > 0
              ? h('div', { className: 'rb-section-title', style: { padding: '8px 10px 0' } }, t('rolesUnregistered'))
              : null,
            unregistered.map(record => row(record, true)))
          : null,
        confirmId !== null ? h('div', { className: 'rb-panel' },
          h('div', null, t('removeRoleConfirm')),
          h('div', { className: 'rb-row' },
            h(Button, {
              variant: 'outline',
              className: 'rb-btn-danger',
disabled: busy,
              onClick: async () => {
                if ((await run('role.delete', { id: confirmId })).ok) setConfirmId(null)
              },
            }, t('confirm')),
            h(Button, { variant: 'ghost', onClick: () => setConfirmId(null)}, t('cancel')))) : null)
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

    /** The role a requirement is routed to; a requirement open to all shows none. */
    function RoleBadge({ role, roles }) {
      if (role === undefined || role === '') return null
      return h('span', { title: role }, h(Tag, { tone: 'info' }, roleName(role, roles)))
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
    function StatsStrip({ stats, roles, t }) {
      if (stats === null) return null
      const rate = Math.round(stats.completionRate * 100)
      const cells = [
        { label: t('total'), value: String(stats.total) },
        { label: t('statusActive'), value: String(stats.byStatus.active ?? 0) },
        { label: t('statusBlocked'), value: String(stats.byStatus.blocked ?? 0) },
        { label: t('statusDone'), value: String(stats.byStatus.done ?? 0) },
        { label: t('blockedTitle'), value: String(stats.blocked.length), warn: stats.blocked.length > 0 },
        { label: t('stalledTitle'), value: String(stats.stalled.length), warn: stats.stalled.length > 0 },
      ]
      if (stats.byKind !== undefined) {
        cells.push(
          { label: t('statsUnfinished'), value: String(stats.total - (stats.byStatus.done ?? 0)) },
          { label: t('kindTask'), value: String(stats.byKind.task ?? 0) },
          { label: t('kindDecision'), value: String(stats.byKind.decision ?? 0), warn: (stats.byKind.decision ?? 0) > 0 },
        )
      }
      if (typeof stats.queued === 'number') cells.push({ label: t('statsQueued'), value: String(stats.queued) })
      // The critical path is the requirements whose level the work they hold up
      // raised — the same set each `escalated` row marks, counted by the Host.
      if (typeof stats.criticalPath === 'number') {
        cells.push({ label: t('criticalPath'), value: String(stats.criticalPath), warn: stats.criticalPath > 0 })
      }
      if (typeof stats.reserved === 'number') cells.push({ label: t('statsReserved'), value: String(stats.reserved), warn: stats.reserved > 0 })
      if (typeof stats.pendingDelegations === 'number') {
        cells.push({ label: t('statsPendingDelegations'), value: String(stats.pendingDelegations), warn: stats.pendingDelegations > 0 })
      }
      if (typeof stats.orphanedLocks === 'number') {
        cells.push({ label: t('statsOrphanedLocks'), value: String(stats.orphanedLocks), warn: stats.orphanedLocks > 0 })
      }
      // §5.6's execution readings. Both count what was observed rather than what
      // a document says, so they are read straight off the host's counters.
      if (typeof stats.running === 'number') {
        cells.push({ label: t('statsRunning'), value: String(stats.running) })
      }
      if (stats.execSync !== undefined && stats.execSync !== null) {
        const gaps = stats.execSync.gaps ?? 0
        const ignored = stats.execSync.ignored ?? 0
        cells.push({ label: t('statsExecGaps'), value: String(gaps), warn: gaps > 0 })
        if (ignored > 0) cells.push({ label: t('statsExecIgnored'), value: String(ignored) })
      }
      const tally = Array.isArray(stats.byRole) ? stats.byRole.filter(row => (row.total ?? 0) > 0).slice(0, 6) : []
      return h('div', { className: 'rb-stats' },
        h('div', { className: 'rb-stat' },
          h('div', { className: 'rb-stat-label' }, t('completionRate')),
          h('div', { className: 'rb-stat-value' }, `${rate}%`),
          h('div', { className: 'rb-bar' }, h('div', { className: 'rb-bar-fill', style: { width: `${Math.max(2, rate)}%` } }))),
        cells.map(cell => h('div', { key: cell.label, className: 'rb-stat' },
          h('div', { className: 'rb-stat-label' }, cell.label),
          h('div', { className: `rb-stat-value${cell.warn ? ' rb-warn' : ''}` }, cell.value))),
        tally.length === 0 ? null : h('div', { className: 'rb-role-tally' },
          h('span', { className: 'rb-field-label' }, t('statsByRole')),
          tally.map(row => h(Tag, { key: row.role === '' ? '(none)' : row.role, tone: 'outline' },
            `${row.role === '' ? t('roleNone') : roleName(row.role, roles)} ${row.total}`))))
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
          h('div', { className: 'rb-section-title' }, t('checks')),
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
            className: 'rb-btn-danger',
disabled: busy || note.trim() === '',
            onClick: () => run('block', { reason: note.trim() }),
          }, t('block')),
          h('span', { className: 'rb-muted' }, t('blockReasonPlaceholder'))) : null,
        h('div', { className: 'rb-row', style: { marginTop: 8 } },
          h(Button, {
            variant: 'primary',
disabled: finishDisabled,
            title: unmetChecks.length > 0 ? `${t('errCompletionNotMet')} ${unmetChecks.join(', ')}` : undefined,
            onClick: () => run('transition', { transition: 'advance', note: note.trim() }),
          }, t('advance')),
          canRollback ? h(Button, {
            variant: 'ghost',
disabled: busy || note.trim() === '',
            onClick: () => run('transition', { transition: 'rollback', to: node.id, note: note.trim() }),
          }, t('rollback')) : null,
          canJump ? h(Button, {
            variant: 'ghost',
disabled: busy || note.trim() === '',
            onClick: () => run('transition', { transition: 'jump', to: node.id, note: note.trim(), force: true }),
          }, t('jump')) : null,
          h('span', { className: 'rb-grow' }),
          h(Button, {
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
    function ProgressPanel({ stats, t }) {
      if (stats === null) return null
      const tables = stats.nodeDurations.slice(0, 12)
      return h('div', null,
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('nodeDurations')),
          tables.length === 0 ? h('div', { className: 'rb-muted' }, '—') : h('table', { className: 'rb-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('nodesLabel')),
              h('th', null, t('samples')),
              h('th', null, t('avg')),
              h('th', null, 'min'),
              h('th', null, 'max'))),
            h('tbody', null, tables.map(row => h('tr', { key: `${row.templateId}:${row.nodeId}` },
              h('td', null, row.name),
              h('td', null, String(row.samples)),
              h('td', null, formatDuration(row.avgMs)),
              h('td', null, formatDuration(row.minMs)),
              h('td', null, formatDuration(row.maxMs))))))),
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('blockedTitle')),
          stats.blocked.length === 0 ? h('div', { className: 'rb-muted' }, t('noBlocked')) : h('div', null, stats.blocked.map(item => h('div', {
            key: item.id,
            className: 'rb-row',
          },
            h('span', { className: 'rb-error' }, item.title),
            h('span', { className: 'rb-muted' }, item.reason),
            h('span', { className: 'rb-muted' }, formatDuration(item.blockedMs)))))),
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('stalledTitle')),
          stats.stalled.length === 0 ? h('div', { className: 'rb-muted' }, t('noStalled')) : h('div', null, stats.stalled.map(item => h('div', {
            key: item.id,
            className: 'rb-row',
          },
            h('span', { className: 'rb-warn' }, item.title),
            h('span', { className: 'rb-muted' }, item.node),
            h('span', { className: 'rb-muted' }, formatDuration(item.idleMs)))))))
    }

    /** The requirement creation dialog. */
    function CreateRequirementDialog({ templates, defaultTemplateId, onClose, onSubmit, onUpload, busy, t }) {
      const [form, setForm] = useState({
        title: '',
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
          className: 'rb-image-remove',
          name: `requirement.image.remove.${index}`,
          title: t('removeImage'),
          'aria-label': `${t('removeImage')}: ${image.name}`,
          onClick: () => setImages(list => list.filter(entry => entry.key !== image.key)),
        }, '×'))

      return h(Dialog, {
        title: t('newRequirement'),
        closeLabel: t('close'),
        onClose,
        footer: [
          h(Button, { variant: 'ghost', key: 'cancel', onClick: onClose}, t('cancel')),
          h(Button, {
            variant: 'primary',
key: 'ok',
            disabled: busy || uploading || form.title.trim() === '',
            onClick: () => onSubmit({
              title: form.title.trim(),
              description: form.description.trim(),
              priority: form.priority,
              owner: form.owner.trim(),
              templateId: form.templateId,
              sessions: form.sessions.split(',').map(entry => entry.trim()).filter(Boolean),
              images: stored,
            }),
          }, t('create')),
        ],
      },
        h(Field, { label: t('titleField') }, h(Input, {
          name: 'requirement.title',
          value: form.title,
          onChange: event => set({ title: event.target.value }),
        })),
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
        h(Field, { label: t('sessions') }, h(Input, {
          name: 'requirement.sessions',
          value: form.sessions,
          placeholder: 'ses_a, ses_b',
          onChange: event => set({ sessions: event.target.value }),
        })))
    }

    /** The flow-template creation dialog. */
    function CreateTemplateDialog({ onClose, onSubmit, busy, t }) {
      const [form, setForm] = useState({ name: '', description: '', nodes: '' })
      const set = patch => setForm(current => ({ ...current, ...patch }))
      /** Parse `name | assignee | check;check` lines into node declarations. */
      const parseNodes = () => form.nodes
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
        .map(line => {
          const [name, assignee = '', checks = ''] = line.split('|').map(part => part.trim())
          const checklist = checks.split(';').map(entry => entry.trim()).filter(Boolean)
          return {
            name,
            assignee,
            completion: checklist.length > 0 ? { type: 'checklist', checklist } : { type: 'manual', checklist: [], requireNote: false },
          }
        })
      const nodes = parseNodes()
      return h(Dialog, {
        title: t('newTemplate'),
        closeLabel: t('close'),
        onClose,
        footer: [
          h(Button, { variant: 'ghost', key: 'cancel', onClick: onClose}, t('cancel')),
          h(Button, {
            variant: 'primary',
key: 'ok',
            disabled: busy || form.name.trim() === '' || nodes.length === 0,
            onClick: () => onSubmit({ name: form.name.trim(), description: form.description.trim(), nodes }),
          }, t('create')),
        ],
      },
        h(Field, { label: t('templateName') }, h(Input, {
          name: 'template.name',
          value: form.name,
          onChange: event => set({ name: event.target.value }),
        })),
        h(Field, { label: t('templateDescription') }, h(Input, {
          name: 'template.description',
          value: form.description,
          onChange: event => set({ description: event.target.value }),
        })),
        h(Field, { label: `${t('templateNodes')} — ${t('templateNodesHint')}` }, h('textarea', {
          className: 'rb-textarea',
          name: 'template.nodes',
          style: { minHeight: 120 },
          value: form.nodes,
          placeholder: t('templateNodesExample'),
          onChange: event => set({ nodes: event.target.value }),
        })),
        nodes.length > 0 ? h('div', { className: 'rb-muted' }, `${nodes.length} ${t('nodeCount')}: ${nodes.map(node => node.name).join(' → ')}`) : null)
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
    function EditFields({ requirement, roleOptions, busy, onSave, onCancel, t }) {
      const hasParent = requirement.parentId !== undefined
      const hasBlocks = Array.isArray(requirement.blocksOn)
      const [draft, setDraft] = useState({
        priority: requirement.priority,
        role: requirement.role === '' ? ROLE_NONE : requirement.role,
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
          h(Button, { variant: 'ghost', size: 'sm', onClick: onCancel}, t('cancel')),
          h(Button, {
            variant: 'primary',
            size: 'sm',
name: 'edit.save',
            disabled: busy,
            onClick: () => onSave({
              priority: draft.priority,
              role: draft.role === ROLE_NONE ? '' : draft.role,
              ...(hasParent ? { parentId: draft.parentId.trim() } : {}),
              ...(hasBlocks ? { blocksOn: draft.blocksOn.split(',').map(entry => entry.trim()).filter(entry => entry !== '') } : {})
            }),
          }, t('save'))))
    }

    function RequirementDetail({ requirement, controller, run, busy, roles, roleOptions, claimableIds, me, requirements, onDelegate, onRevokeDelegation, t }) {
      const [selectedNodeId, setSelectedNodeId] = useState(requirement.nodeId)
      const [confirmDelete, setConfirmDelete] = useState(false)
      const [editing, setEditing] = useState(false)
      const [forceOffer, setForceOffer] = useState(null)
      const [note, setNote] = useState('')
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
        return h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('executions')),
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
          units.length === 0 && settled ? h('div', { className: 'rb-muted' }, t('executionsEmpty')) : null,
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
      return h('div', null,
        h('div', { className: 'rb-row' },
          h('h2', { className: 'rb-title', style: { margin: 0 } }, requirement.title),
          h(StatusBadge, { status: requirement.status, t }),
          h(PriorityBadge, { priority: requirement.priority, t }),
          h(KindBadge, { kind: requirement.kind, t }),
          h(RoleBadge, { role: requirement.role, roles }),
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
          h(ReservedBadge, { reservedBy: requirement.reservedBy, t }),
          h('span', { className: 'rb-grow' }),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
disabled: busy,
            onClick: () => setEditing(current => !current),
          }, t('editRequirement')),
          requirement.status === 'done'
            ? h(Button, {
              variant: 'ghost',
              size: 'sm',
disabled: busy,
              onClick: () => void run('transition', { id: requirement.id, expectedRev: requirement.rev, transition: 'reopen' }),
            }, t('reopen'))
            : null,
          requirement.status === 'blocked'
            ? h(Button, {
              variant: 'ghost',
              size: 'sm',
disabled: busy,
              onClick: () => void run('unblock', { id: requirement.id, expectedRev: requirement.rev, note: note.trim() }),
            }, t('unblock'))
            : null,
          requirement.status === 'archived'
            ? h(Button, {
              variant: 'ghost',
              size: 'sm',
disabled: busy,
              onClick: () => void run('restore', { id: requirement.id, expectedRev: requirement.rev }),
            }, t('restore'))
            : h(Button, {
              variant: 'ghost',
              size: 'sm',
disabled: busy,
              onClick: () => void run('archive', { id: requirement.id, expectedRev: requirement.rev }),
            }, t('archive')),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            className: 'rb-btn-danger',
disabled: busy,
            onClick: () => setConfirmDelete(true),
          }, t('remove'))),
        editing
          ? h(EditFields, {
            requirement,
            roleOptions,
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
        h('div', { className: 'rb-card-meta', style: { marginTop: 4 } },
          h('span', null, `${t('ownPriority')}: ${t(`priority${requirement.priority[0].toUpperCase()}${requirement.priority.slice(1)}`)}`),
          requirement.escalated === true
            ? h('span', { className: 'rb-warn' }, `${t('effectivePriority')}: ${requirement.effectivePriority}↑`)
            : null,
          h('span', null, `${t('owner')}: ${requirement.owner === '' ? t('unassigned') : requirement.owner}`),
          h('span', null, `${t('template')}: ${requirement.template.name}`),
          h('span', null, `${t('filterKind')}: ${t(requirement.kind === 'decision' ? 'kindDecision' : 'kindTask')}`),
          h('span', null, `${t('sessions')}: ${requirement.sessions.length === 0 ? '—' : requirement.sessions.join(', ')}`),
          requirement.requestedBy === undefined || requirement.requestedBy === ''
            ? null
            : h('span', null, `${t('requestedBy')}: ${requirement.requestedBy}`),
          h('span', null, `${t('updated')}: ${formatInstant(requirement.updatedAt)}`),
          h('span', null, `${t('revision')} ${requirement.rev}`)),
        requirement.escalated === true
          ? h('div', { className: 'rb-muted', style: { marginTop: 4 } }, t('priorityLiftedHint'))
          : null,
        requirement.blockReason !== '' ? h('div', { className: 'rb-error', style: { marginTop: 4 } }, `${t('blockedBecause')}: ${requirement.blockReason}`) : null,
        requirement.description !== '' ? h('p', { className: 'rb-muted', style: { marginTop: 8 } }, requirement.description) : null,
        descriptionImages.length === 0 ? null : h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('images')),
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
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('eligibility')),
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
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('gates')),
          h('div', { className: 'rb-kv' },
            h('span', { className: 'rb-kv-key' }, t('parentRequirement')),
            h('span', null, requirement.parentId === undefined || requirement.parentId === null || requirement.parentId === ''
              ? t('noneLinked')
              : reference(requirement.parentId)),
            h('span', { className: 'rb-kv-key' }, t('childrenTitle')),
            h('span', null, (requirement.children ?? []).length === 0
              ? t('noneLinked')
              : requirement.children.map(child => reference(child)).join(', ')),
            h('span', { className: 'rb-kv-key' }, t('blocksOnTitle')),
            h('span', null, (requirement.blocksOn ?? []).length === 0
              ? t('noneLinked')
              : requirement.blocksOn.map(link => reference(link)).join(', ')),
            h('span', { className: 'rb-kv-key' }, t('blockedByTitle')),
            h('span', { className: requirement.gated === true ? 'rb-warn' : '' }, (requirement.blockedBy ?? []).length === 0
              ? t('noneLinked')
              : requirement.blockedBy.map(link => reference(link)).join(', '))),
          h('div', { className: 'rb-muted' }, t('gatesHint'))),
        executionsSection(),
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('lock')),
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
                  className: 'rb-btn-danger',
disabled: busy,
                  onClick: () => void run('release', { id: requirement.id, expectedRev: requirement.rev }),
                }, t('releaseLock'))))),
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('delegation')),
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
                  className: 'rb-btn-danger',
name: 'revoke.delegation',
                  disabled: busy,
                  onClick: () => onRevokeDelegation(requirement),
                }, t('revokeDelegation'))))),
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('flow')),
          h(FlowChart, { requirement, selectedNodeId, onSelect: setSelectedNodeId, t })),
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('nodeDetail')),
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
              variant: 'ghost',
              size: 'sm',
name: 'force.request',
              disabled: busy,
              onClick: () => setForceOffer(current => current === null ? null : { ...current, armed: true }),
            }, t('forceAdvance')),
            h(Button, {
              variant: 'ghost',
              size: 'sm',
onClick: () => setForceOffer(null),
            }, t('cancel')))),
        h('div', { className: 'rb-section' },
          h('div', { className: 'rb-section-title' }, t('history')),
          last !== null ? h('div', { className: 'rb-muted', style: { marginBottom: 6 } },
            `${t('lastTransition')}: ${last.fromName || last.action} → ${last.toName} · ${formatInstant(last.at)}`) : null,
          h(History, { requirement, t })),
        forceRequest !== null && forceRequest.armed === true ? h(Dialog, {
          title: t('forceAdvance'),
          closeLabel: t('close'),
          onClose: () => setForceOffer(current => current === null ? null : { ...current, armed: false }),
          footer: [
            h(Button, { variant: 'ghost', key: 'cancel', onClick: () => setForceOffer(null)}, t('cancel')),
            h(Button, {
              variant: 'outline',
              className: 'rb-btn-danger',
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
            h(Button, { variant: 'ghost', key: 'cancel', onClick: () => setConfirmDelete(false)}, t('cancel')),
            h(Button, {
              variant: 'outline',
              className: 'rb-btn-danger',
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
    function BoardPage(props) {
      const state = props.useBoard(identity)
      const t = props.t
      const controller = props.controller
      const [dialog, setDialog] = useState(null)
      const [selectedId, setSelectedId] = useState(null)
      const [busy, setBusy] = useState(false)
      const [view, setView] = useState('board')

      const requirements = state.requirements
      const roles = state.roles
      const filter = state.filter
      /**
       * The listed rows exactly as the Host answered them.
       *
       * Every filter control travels to the Host, `role` included, because the
       * service filters by the routing role in force (`?role=human` is the human's
       * inbox) and answers with the same result set the model's `list` sees. The
       * page never narrows the fetched page itself: a row the service sent is a
       * row the reader asked for.
       */
      const visible = requirements
      const selected = useMemo(
        () => visible.find(item => item.id === selectedId) ?? null,
        [visible, selectedId],
      )
      useEffect(() => {
        if (selected === null && visible.length > 0) setSelectedId(visible[0].id)
      }, [visible, selected])

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

      /** One labelled filter control, so a select is never a bare value list. */
      const select = (key, values, emptyLabel = t('all')) => h('span', { key, className: 'rb-filter' },
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

      /** One labelled checkbox filter; the wrapping label carries the accessible name. */
      const toggle = (key, label) => h(Checkbox, {
        key,
        checked: filter[key] === true,
        label: t(label),
        onChange: next => props.setFilter({ [key]: next }),
      })

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
            className: 'rb-queue-title',
onClick: () => setSelectedId(entry.id),
          }, item === null ? entry.id : item.title),
          item === null ? null : h(StatusBadge, { status: item.status, t }),
          item === null ? null : h(RoleBadge, { role: item.role, roles }),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            className: 'rb-btn-danger',
name: `unqueue.${entry.id}`,
            disabled: busy,
            onClick: () => void clearReservation(session, entry),
          }, t('clearReservation')))
      }

      /** The queue view: each session's own order and who is next. */
      const renderQueue = () => h('div', { className: 'rb-list', role: 'list' },
        state.status === 'loading' ? h('div', { className: 'rb-panel rb-muted', style: { margin: 12 } }, t('loading')) : null,
        queueRows.length === 0 && state.status !== 'loading' && state.auth === ''
          ? h('div', { className: 'rb-panel rb-muted', style: { margin: 12 } }, t('queueEmpty'))
          : null,
        h('div', { className: 'rb-queue' },
          h('div', { className: 'rb-muted' }, t('queueSoftHint')),
          h('div', { className: 'rb-muted' }, t('queueHint')),
          queueRows.map(row => h('div', { key: row.session, className: 'rb-queue-group' },
            h('div', { className: 'rb-queue-head' },
              h('span', { className: 'rb-queue-session' }, `${t('queueTitle')}: ${row.session}`),
              h(Tag, { tone: 'outline' }, t('queueCount', { count: row.items.length }))),
            row.items.map((entry, index) => queueRow(row.session, entry, index === 0))))))

      return h('div', { className: 'rb-root' },
        h('style', null, CSS),
        h('div', { className: 'rb-header' },
          h('div', { className: 'rb-heading' },
            h('span', { className: 'rb-title' }, t('title')),
            h('span', { className: 'rb-sub' }, t('subtitle'))),
          h('span', { title: t('live') }, h(StateDot, { state: state.connected ? 'done' : 'idle' })),
          h('span', { className: 'rb-grow' }),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
name: 'refresh',
            disabled: state.auth !== '',
            onClick: () => void props.refresh(),
          }, t('refresh')),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => setDialog('roles')}, t('roles')),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => setDialog('template')}, t('newTemplate')),
          h(Button, { variant: 'primary', size: 'sm', onClick: () => setDialog('requirement')}, t('newRequirement'))),
        h('div', { className: 'rb-views', role: 'tablist', 'aria-label': t('view') },
          views.map(entry => h(Pill, {
            key: entry.key,
            role: 'tab',
            name: `view.${entry.key}`,
            active: view === entry.key,
            'aria-pressed': view === entry.key,
            onClick: () => showView(entry.key),
          }, entry.label))),
        // The trust gate's refusal is not a transient failure and has no retry: the
        // page cannot reach the board again until it is opened afresh, so the
        // notice says which refusal it was and carries no button that would only
        // repeat it.
        state.auth === '' ? null : h('div', { className: 'rb-notice rb-notice-auth', role: 'alert' },
          h('span', null, t(state.auth === 'expired' ? 'authExpired' : 'authCrossOrigin')),
          h('span', { className: 'rb-muted' }, t(state.auth === 'expired' ? 'authExpiredHint' : 'authCrossOriginHint')),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
name: 'auth.recheck',
            onClick: () => void props.recheck(),
          }, t('recheck'))),
        state.auth === '' && state.everConnected && !state.connected
          ? h('div', { className: 'rb-notice rb-notice-stale' },
            h('span', null, t('staleNotice')),
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => void props.refresh()}, t('retry')))
          : null,
        state.auth === '' && state.error !== null
          ? h('div', { className: 'rb-notice rb-notice-error' },
            h('span', null, controller.errorText(state.error, t)),
            h(Button, { variant: 'ghost', size: 'sm', onClick: () => void props.refresh()}, t('retry')))
          : null,
        view === 'decisions'
          ? h('div', { className: 'rb-notice rb-notice-hint' },
            h('span', null, t('viewDecisionsHint')),
            h(Tag, { tone: 'warning' }, t('decisionBadge')))
          : null,
        h(StatsStrip, { stats: state.stats, roles, t }),
        view === 'board' ? h('div', { className: 'rb-filters' },
          h('span', { className: 'rb-filter' },
            h('span', { className: 'rb-field-label' }, t('filterQuery')),
            h(Input, {
              name: 'query',
              value: filter.query,
              'aria-label': t('filterQuery'),
              onChange: event => props.setFilter({ query: event.target.value }),
            })),
          select('status', [
            { value: 'open', label: t('open') },
            { value: 'active', label: t('statusActive') },
            { value: 'blocked', label: t('statusBlocked') },
            { value: 'done', label: t('statusDone') },
            { value: 'archived', label: t('statusArchived') },
          ]),
          select('priority', ['low', 'normal', 'high', 'urgent'].map(value => ({
            value,
            label: t(`priority${value[0].toUpperCase()}${value.slice(1)}`),
          }))),
          select('owner', owners.map(value => ({ value, label: value }))),
          select('session', sessions.map(value => ({ value, label: value }))),
          select('role', roleFilterOptions, t('anyRole')),
          select('kind', [
            { value: 'task', label: t('kindTask') },
            { value: 'decision', label: t('kindDecision') },
          ]),
          toggle('claimable', 'filterClaimable'),
          h('span', { className: 'rb-filter' },
            h('span', { className: 'rb-field-label' }, t('filterMe')),
            h(Input, {
              name: 'me',
              value: filter.me,
              title: t('filterMeHint'),
              'aria-label': t('filterMe'),
              onChange: event => props.setFilter({ me: event.target.value }),
            })),
          h('span', { className: 'rb-grow' }),
          h('span', { className: 'rb-muted' }, `${visible.length} / ${state.stats?.total ?? 0}`))
          : null,
        h('div', { className: 'rb-body' },
          view === 'queue'
            ? renderQueue()
            : h('div', { className: 'rb-list', role: 'list' },
              state.status === 'loading' ? h('div', { className: 'rb-panel rb-muted', style: { margin: 12 } }, t('loading')) : null,
              visible.length === 0 && state.status !== 'loading' && state.auth === ''
                ? h('div', { className: 'rb-panel rb-muted', style: { margin: 12 } }, view === 'decisions'
                  ? t('decisionsEmpty')
                  : boardIsEmpty ? t('emptyBoard') : t('empty'))
                : null,
              visible.map(item => {
                const lock = lockFacts(item.lock)
                return h('button', {
                  key: item.id,
                  type: 'button',
                  role: 'listitem',
                  className: `rb-card${item.id === selectedId ? ' rb-card-selected' : ''}`,
                  onClick: () => setSelectedId(item.id),
                },
                  h('div', { className: 'rb-card-title' }, item.title),
                  h('div', { className: 'rb-card-meta' },
                    h(StatusBadge, { status: item.status, t }),
                    h(PriorityBadge, { priority: item.priority, t }),
                    h(CriticalBadge, {
                      escalated: item.escalated,
                      effectivePriority: item.effectivePriority,
                      priority: item.priority,
                      t,
                    }),
                    h(KindBadge, { kind: item.kind, t }),
                    h(RoleBadge, { role: item.role, roles }),
                    h(EligibilityBadges, { item, me: filter.me, claimableIds: state.claimableIds, t }),
                    h(GatedBadge, { gated: item.gated, blockedBy: item.blockedBy, t }),
                    h(BlocksBadge, { blocksOn: item.blocksOn, t }),
                    h(DelegatedBadge, { delegatedTo: item.delegatedTo, t }),
                    h(ReservedBadge, { reservedBy: item.reservedBy, t }),
                    h('span', null, item.progress.done === item.progress.total ? `${item.progress.total}/${item.progress.total}` : `${item.progress.done + 1}/${item.progress.total}`),
                    h('span', null, item.owner === '' ? t('unassigned') : item.owner)),
                  lock === null ? null : h('div', { className: `rb-card-meta${lock.orphaned ? ' rb-error' : ''}` },
                    h('span', null, `🔒 ${lock.holder}`),
                    h('span', null, `${t('lockHeldSince')} ${formatDuration(lock.heldMs)}`),
                    lock.orphaned ? h('span', null, t('lockOrphaned')) : null),
                  h('div', { className: 'rb-card-meta' },
                    h('span', null, item.progress.activeNode?.name ?? item.nodeId),
                    h('span', null, formatInstant(item.updatedAt))))
              })),
          h('div', { className: 'rb-detail' },
            selected !== null
              ? h(RequirementDetail, {
                requirement: selected,
                controller,
                run,
                busy,
                roles,
                roleOptions,
                claimableIds: state.claimableIds,
                me: filter.me,
                requirements,
                onDelegate: delegate,
                onRevokeDelegation: revokeDelegation,
                t,
              })
              : h('div', { className: 'rb-muted' }, boardIsEmpty ? t('emptyBoard') : t('selectNode')),
            h(ProgressPanel, { stats: state.stats, t }))),
        dialog === 'requirement' ? h(CreateRequirementDialog, {
          templates: state.templates,
          defaultTemplateId: state.templates[0]?.id ?? 'tpl-standard',
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
        dialog === 'template' ? h(CreateTemplateDialog, {
          busy,
          t,
          onClose: () => setDialog(null),
          onSubmit: async form => {
            await run('template.create', { template: form })
            setDialog(null)
          },
        }) : null,
        dialog === 'roles' ? h(RolesDialog, {
          roles,
          status: state.status,
          busy,
          run,
          onClose: () => setDialog(null),
          t,
        }) : null)
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

        const face = {
          hooks: { board: controller.source },
          t,
          controller: controller.face,
          uploadImage: controller.face.uploadImage,
          refresh: controller.face.refresh,
          recheck: controller.face.recheck,
          setFilter: controller.face.setFilter,
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
