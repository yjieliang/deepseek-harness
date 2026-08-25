# Agent Note: Models 设置页的模型图片输入开关

Status: implemented

[English](2026-08-20-model-image-input-switch.md) | 中文

## Problem

pi-ai 网关或手工声明的自定义提供方可以对外提供视觉模型，但只有当其 profile 条目指名 `image` 输入模态时，模型才接受图片。Models 设置页的模型列表编辑器（pi-ai 与自定义提供方家族）每行只暴露 `id`、`name`、`contextWindow` 和 `maxTokens`，因此启用图片输入只能手改 `settings.yaml`——这是配置平面唯一无法设置的能力。

## Decision

pi-ai 模型列表编辑器（`ModelListEditor`）在每行既有的进阶折叠区里、容量字段旁，新增一个按行的**图片输入开关**。开启写入 `input: ['text', 'image']`；关闭写入 `input: ['text']`。两个方向都显式写入模态列表，因此关掉开关永远意味着「该模型不接受图片」，而不是悄悄继承允许图片的路由级 `defaultInput`。未声明 `input` 的行渲染为未勾选，因为卡片看不到继承的路由默认值，也从不假装知道它。

开关走既有的草稿 → `settings.mutate` 路径 op 流水线，因此无需改动任何 wire、schema 或持久化表面：该值与容量编辑完全一样落入 profile 的 `models` 数组，pi-ai 适配器既有的 `input` 字段校验与解析原样生效。行保持结构开放，因此带模态的行因兄弟字段而被编辑时，其模态会被保留。

开关只存在于 pi-ai 家族的编辑器（`ModelListEditor`），不在直接 DeepSeek 目录编辑器里：直接适配器使用命名不同的 `inputModalities` 字段，交付纯文本默认值，且其官方 API 当前不提供图片（确实存在的精确模型 opt-in 由[直接 DeepSeek 视觉输入](2026-08-19-direct-deepseek-vision-input.md)覆盖），在那里放开关只会提供一个官方路由无法兑现的能力。

## 曾考虑的替代方案

- **三态开关（继承／开／关）**——未采纳：卡片读不到继承值（路由 `defaultInput` 与已安装 catalog 都是宿主侧事实），无法如实渲染继承态；一个实际接受图片却显示未勾选的开关是谎言。
- **只读能力徽标**——未采纳：需求本身是管理面，徽标仍会迫使需要在这里改动的人去改 `settings.yaml`。
- **在直接 DeepSeek 编辑器加同样的开关**——如上未采纳：字段命名不同、默认纯文本，且官方 API 没有可启用的图片端点。
- **关闭时清除 `input` 以回到继承**——未采纳：关闭必须是斩钉截铁的「该模型不接受图片」，而未设置字段会去询问下一层，那里可能是允许图片的路由。

## Consequences

pi-ai 网关与自定义提供方背后的视觉模型现在可以在 Models 页启用或禁用图片输入，无需触碰 `settings.yaml`。显式 `['text']` 覆盖会压过允许图片的路由 `defaultInput`，这正是开关的意义。从未声明模态的行行为与之前完全一致。DeepSeek 编辑器保持不变，其字段集合继续限定在官方路由实际能兑现的范围。
