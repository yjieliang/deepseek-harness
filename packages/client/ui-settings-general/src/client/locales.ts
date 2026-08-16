/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'retry': '重试',
  'bootHome.label': '数据目录 (DSH_HOME)',
  'bootHome.current': '当前:',
  'bootHome.source.default': '默认',
  'bootHome.source.env': '环境变量',
  'bootHome.source.file': '配置文件',
  'bootHome.source.configured': '启动参数',
  'bootHome.placeholder': '留空使用默认 ~/.dsh,或输入绝对路径',
  'bootHome.save': '保存',
  'bootHome.clear': '恢复默认',
  'bootHome.error': '无法读取数据目录设置。',
  'bootHome.saved-restart': '已保存,重启后生效。',
  'bootHome.cleared-restart': '已清除,重启后回到默认。',
  'bootHome.envWins': '检测到环境变量 DSH_HOME,下次启动将以环境变量为准。',
  'bootHome.restartHint': '修改后需重启 DeepSeek Harness 才生效;已有数据不会自动迁移。',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'retry': 'Retry',
  'bootHome.label': 'Data directory (DSH_HOME)',
  'bootHome.current': 'Current:',
  'bootHome.source.default': 'default',
  'bootHome.source.env': 'environment variable',
  'bootHome.source.file': 'config file',
  'bootHome.source.configured': 'launcher',
  'bootHome.placeholder': 'Leave empty for the default ~/.dsh, or type an absolute path',
  'bootHome.save': 'Save',
  'bootHome.clear': 'Restore default',
  'bootHome.error': 'Could not read the data-directory setting.',
  'bootHome.saved-restart': 'Saved — takes effect after a restart.',
  'bootHome.cleared-restart': 'Cleared — the next boot returns to the default.',
  'bootHome.envWins': 'A DSH_HOME environment variable is set, so the next boot uses the variable.',
  'bootHome.restartHint': 'Changes take effect after restarting DeepSeek Harness; existing data is not migrated automatically.',
} satisfies Record<SettingsKey, string>
