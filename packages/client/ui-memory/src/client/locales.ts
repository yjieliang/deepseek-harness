/** Locale bundles for the memory settings section. */

/** Locale keys the memory section renders. */
export type MemorySettingsKey =
  | 'nav' | 'sectionIntro' | 'loading' | 'error' | 'retry'
  | 'add' | 'addTitle' | 'addIntro' | 'edit' | 'editTitle' | 'editIntro'
  | 'topic' | 'topicPlaceholder' | 'value' | 'valuePlaceholder'
  | 'save' | 'saving' | 'cancel' | 'close'
  | 'topicInvalid' | 'valueRequired' | 'override' | 'overrideHint'
  | 'delete' | 'deleteTitle' | 'deleteDescription' | 'deleteConfirm' | 'deleting'
  | 'sourceUser' | 'sourceProposed' | 'empty' | 'noWritable'

/** English copy. */
export const en: Record<MemorySettingsKey, string> = {
  nav: 'Memory',
  sectionIntro:
    'These user habits are injected into the prompt of new sessions. Habits the agent proposes '
    + 'in conversation appear here once you confirm them.',
  loading: 'Loading memories…',
  error: 'Could not load memories.',
  retry: 'Retry',
  add: 'Add memory',
  addTitle: 'Add memory',
  addIntro: 'The topic names the subject; the value is what the next session should always know.',
  edit: 'Edit',
  editTitle: 'Edit memory',
  editIntro: 'Saved changes apply to sessions started afterwards.',
  topic: 'Topic',
  topicPlaceholder: 'e.g. style or code-review',
  value: 'Content',
  valuePlaceholder: 'Describe the habit, e.g. reply in Simplified Chinese',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  close: 'Close',
  topicInvalid: 'The topic must start with a lowercase letter and use lowercase letters, digits, hyphens, and underscores (max 32 characters).',
  valueRequired: 'Give the memory some content.',
  override: 'Save anyway',
  overrideHint:
    'The content looks like a prompt injection or a secret and was rejected by the safety guard. '
    + 'If you are sure, press “Save anyway”.',
  delete: 'Delete',
  deleteTitle: 'Delete this memory?',
  deleteDescription: 'New sessions will no longer inject this habit. Running sessions are unaffected.',
  deleteConfirm: 'Delete',
  deleting: 'Deleting…',
  sourceUser: 'User',
  sourceProposed: 'Agent-proposed',
  empty: 'No memories yet. Tell the agent “always …” in a conversation, or press “Add memory”.',
  noWritable: 'This browser cannot write settings here.',
}

/** Simplified Chinese copy. */
export const zh: Record<MemorySettingsKey, string> = {
  nav: '记忆',
  sectionIntro: '这些用户习惯会注入到新会话的提示词中。Agent 在对话中提议的习惯，经你确认后也会出现在这里。',
  loading: '正在加载记忆…',
  error: '无法加载记忆。',
  retry: '重试',
  add: '添加记忆',
  addTitle: '添加记忆',
  addIntro: '主题命名这条习惯；内容是新会话应当始终知道的事实。',
  edit: '编辑',
  editTitle: '编辑记忆',
  editIntro: '保存后对此后新建的会话生效。',
  topic: '主题',
  topicPlaceholder: '例如 style 或 code-review',
  value: '内容',
  valuePlaceholder: '描述这条习惯，例如：对话请使用中文回复',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  close: '关闭',
  topicInvalid: '主题必须以小写字母开头，只能包含小写字母、数字、连字符和下划线，最长 32 个字符。',
  valueRequired: '请填写记忆内容。',
  override: '仍然保存',
  overrideHint: '内容疑似包含提示注入或密钥片段，已被安全校验拒绝。若确认无误，请点击「仍然保存」。',
  delete: '删除',
  deleteTitle: '删除这条记忆？',
  deleteDescription: '删除后，新会话将不再注入这条习惯；运行中的会话不受影响。',
  deleteConfirm: '删除',
  deleting: '删除中…',
  sourceUser: '用户',
  sourceProposed: 'Agent 提议',
  empty: '还没有记忆。可以在对话里对 Agent 说「以后都…」，或直接点「添加记忆」。',
  noWritable: '当前浏览器无法在此写入设置。',
}
