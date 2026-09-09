# Agent Note: 知识库引用域改为可贡献来源

Status: implemented

[English](2026-08-18-kb-detachable-reference-domain.md) | 中文

相关：[按需检索笔记](2026-08-18-kb-on-demand-and-reference.md)持有检索门控决策，本笔记为其落地机制；[引擎收敛笔记](2026-08-15-kb-engine-convergence-tool-package.md)的决策不受影响。

## 问题

`@kb:` 引用管线把知识库知识硬编码进必须比它活得更久的包:`ui-reference` 内置 kb 候选域、`ui-input-trigger` 的冻结 `appearance` 联合类型点名 `'kb'`、`ui-conversation` 同时存在 kb 图标分支与转录扫描器的 `@kb:` 前缀分支、`dsh-file-reference` 的 prompt 为 `@kb:` carve out `@` 文件规则。删除 kb 组合行会留下 kb 分支——该能力不可拆卸。

## 决策

把每个 kb 分支反转为扩展点,并由 kb 插件扮演贡献方;16 个工具、面板与 `@kb:` 体验全部不变。

- **kb 引用域成为独立触发来源。** `@deepseek-ai/dsh-client-ui-kb` 经 `ctx.inputTriggers` 注册 `knowledge-base` `InputTriggerSource`(order 1,排在 file/session 来源之后),分节菜单渲染不变。来源自身拥有标题/路径前缀列举、`kb:` 命名空间剥离、quoted 抑制,以及携带 `kb` appearance 的原子 `@kb:` 插入。
- **appearance 联合类型开放,贡献域注册其纯文本前缀。** `ReferenceInsert.appearance` 放宽为 `ReferenceAppearance = 'session' | 'file' | 'folder' | (string & {})`,文档化默认是未知 kind 不渲染域图标。新增 `ctx.referenceAppearances` 服务(由契约所有者 `dsh-client-ui-input-trigger` 持有)把 `@` token 映射到贡献 kind;ui-kb 注册 `{ kind: 'kb', tokenPrefixes: ['kb:'] }`。
- **图标经 chain slot 路由。** `ui-conversation` 声明 `conversation.input.refGlyph` 与 `conversation.chat.refGlyph` 两个 chain slot;其内建目录作为核心 kind 的 owner fallback,ui-kb 向两者注册数据图标占位(`select: kind === 'kb'`)。转录扫描器接收 kind 映射与由 ChatView 用自身 `renderSlotChain` 合成的 slot 分发 `renderGlyph`——inject 只携带 `kindForToken` 半面,因为 ReactNode 内容必须走 slot。
- **`@kb:` 语法 carve-out 移入 kb 段。** `dsh-tool-kb` 的 prompt 段位于 order 100,在 file-reference 段(order 99)的 `@` 语法规则之后,其【引用语法】一段是模型的最终裁决;`FILE_REFERENCE_PROMPT` 回归纯工作区文件规则。每个域的 `@` 语法裁决由自己的段持有,核心 prompt 不再点名 kb 工具。

## 已否决的备选

**保留合并来源并新增候选提供方接口。** 否决:输入触发管线本就按触发符注册独立来源,第二个注册表会重复 `registerSource` 的处置与菜单分组语义。

**经 inject 传 ReactNode 生产回调渲染图标。** 否决:客户端纪律要求 ReactNode 内容经 slot 路由;chain kind 正是为无 owner 接管而生,fallback 留在声明者手里。

**开放 `appearance` 但把 kb 图标硬编码在 `ui-conversation`。** 否决:这会在必须比能力活得更久的包里留下 kb 残留。

## 后果

拆下 kb(删除组合行)会连同候选、appearance 映射、图标占位与 prompt carve-out 一起消失,`ui-reference`、`ui-input-trigger`、`ui-conversation`、`dsh-file-reference` 不再有任何 kb 分支。两个新 slot 声明与 `referenceAppearances` 服务是下一个引用域的可复用座位。kb version token 保持普通字符串:`types.ts` 已把 wire 词汇文档化为 client-safe 纯 JSON,branding 会波及 typert 生成物而收益有限——待生成物再生成时一并重估。

## 测试

`ui-input-trigger` 新增 appearance 注册表 spec;`ui-kb` 新增引用来源 spec(注册、前缀列举、命名空间剥离、quoted 抑制、失败折叠、上限、原子插入、占位处置);`ui-conversation` 的 spec 钉住 stub 占位下的贡献图标路由与无占位默认;`ui-reference` 的 spec 移除 kb 域并保留 file/session 行为。`tool-kb` 注册 spec 钉住 order-100 段。`examples/kb-agent` 快照套件是无密钥的组合层证据:已录制的 `kb-search-turn` 场景在每次运行全新种子库上(harness 把 `DSH_HOME` 指向生成的 cwd)引导完整组合树,其 header pin 持有 order-100 段全文与全部 16 个工具 schema。场景受约束地只做检索:`kb_get` 的 version 令牌内嵌 fs stat 身份(文件索引与时间戳),重新创建的种子文档永远无法重放。
