/** `lookup` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.lookup': '翻译 / 名词介绍',
  'card.title': '划词查询',
  'card.translation': '翻译',
  'card.meanings': '释义',
  'card.intro': '名词介绍',
  'card.explain': '详细解释',
  'card.explaining': '正在生成详细解释…',
  'card.explainFailed': '详细解释生成失败，请重试',
  'card.loading': '查询中…',
  'card.failed': '查询失败，请稍后重试',
  'card.noResult': '没有找到该词的释义',
  'card.close': '关闭',
  'card.source': '来源',
  'card.empty': '请先在回复中划选一个词',
} satisfies Record<string, string>

/** The lookup namespace key union. */
export type LookupKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'action.lookup': 'Translate / Explain',
  'card.title': 'Word lookup',
  'card.translation': 'Translation',
  'card.meanings': 'Meanings',
  'card.intro': 'Introduction',
  'card.explain': 'Explain in detail',
  'card.explaining': 'Generating explanation…',
  'card.explainFailed': 'Explanation failed, please retry',
  'card.loading': 'Looking up…',
  'card.failed': 'Lookup failed, please retry later',
  'card.noResult': 'No entry found for this word',
  'card.close': 'Close',
  'card.source': 'Source',
  'card.empty': 'Select a word in the reply first',
} satisfies Record<LookupKey, string>
