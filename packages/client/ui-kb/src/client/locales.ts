/** `kb` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger.label': '知识库',
  'trigger.open': '打开知识库',
  'trigger.close': '关闭知识库',
  'panel.title': '知识库',
  'panel.searchPlaceholder': '搜索知识库…',
  'panel.new': '＋ 新建',
  'panel.newTitlePlaceholder': '新文档标题',
  'panel.create': '创建',
  'panel.cancel': '取消',
  'panel.trash': '🗑 回收站',
  'panel.back': '返回',
  'panel.close': '✕',
  'panel.empty': '暂无文档',
  'panel.trashEmpty': '回收站为空',
  'panel.edit': '✏ 编辑',
  'panel.delete': '🗑 删除',
  'panel.restore': '恢复',
  'panel.purge': '清除',
  'panel.save': '保存',
  'panel.cancelEdit': '取消编辑',
  'panel.editing': '编辑中 · Ctrl+S 保存',
  'panel.backlinks': '反向链接',
  'panel.emptyView': '← 选择左侧文档查看或编辑',
  'panel.trashHint': '回收站:恢复回收集箱,或彻底清除',
} satisfies Record<string, string>

/** The kb namespace key union. */
export type KbKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger.label': 'Knowledge Base',
  'trigger.open': 'Open knowledge base',
  'trigger.close': 'Close knowledge base',
  'panel.title': 'Knowledge Base',
  'panel.searchPlaceholder': 'Search knowledge base…',
  'panel.new': '＋ New',
  'panel.newTitlePlaceholder': 'New document title',
  'panel.create': 'Create',
  'panel.cancel': 'Cancel',
  'panel.trash': '🗑 Trash',
  'panel.back': 'Back',
  'panel.close': '✕',
  'panel.empty': 'No documents',
  'panel.trashEmpty': 'Trash is empty',
  'panel.edit': '✏ Edit',
  'panel.delete': '🗑 Delete',
  'panel.restore': 'Restore',
  'panel.purge': 'Purge',
  'panel.save': 'Save',
  'panel.cancelEdit': 'Cancel edit',
  'panel.editing': 'Editing · Ctrl+S to save',
  'panel.backlinks': 'Backlinks',
  'panel.emptyView': '← Select a document to view or edit',
  'panel.trashHint': 'Trash: restore to the inbox, or purge permanently',
} satisfies Record<KbKey, string>
