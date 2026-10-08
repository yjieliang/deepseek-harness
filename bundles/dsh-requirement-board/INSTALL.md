# 安装与部署

本包是一个 profile 级 Cordis bundle：一个 Host 插件（`index.js` + `host/`）、一个浏览器半边（`client.js`）、
一份行声明（`cordis.patch.yml`），以及显示元数据（`locale/*.json` 与 `icon.svg`）。包内是普通 ESM
JavaScript，**没有构建步骤**、没有安装脚本。

## 前置

DSH 运行时需为 `0.2.1-alpha.1` 一系：`package.json` 的 `peerDependencies` 声明
`@deepseek-ai/dsh-storage-domain@^0.2.1-alpha.1`，不满足时安装会被拒并给出原因（`incompatible with dsh
<version>`）。这是**刻意**的——`host/domain.js` 直接调用该服务的 API，跨版本运行会崩或丢数据。确要在
其他 dsh 线上运行，用 `plugin_manager { action: "set_version_exemption", target:
"dsh-requirement-board@1.0.0", runtimeVersion: "<该运行时版本>", acceptRisk: true }` 为该组合授一次精确豁免。

## 安装

在目标机上把仓库放到任意目录，然后：

```
plugin_manager { action: "install_bundle", target: "<仓库绝对路径>/bundles/dsh-requirement-board" }
```

- 本地目录安装是**链接**语义：profile 的 `node_modules` 里放符号链接指向这个目录，不拷贝，也不按 `files`
  过滤。所以目录原地更新即生效（见「升级」），换目录才需重新安装。
- `application: applied` 表示已生效；`restart-required` 表示重启 `dsh web` 后才生效。
- 刷新 Web GUI（默认 `http://127.0.0.1:3080`），侧边栏出现「需求看板」。

## 依赖是怎么解析的

`host/` 导入 `@deepseek-ai/dsh-storage-domain` 与 `zod`。链接安装的包**不会装自己的依赖**，这两个名字走
DSH 的运行时解析拦截：linked 包的 bare 导入在该包自己的 `peerDependencies` 里列出该名时，由安装层
（dsh 自带的那一份）应答。因此：

- **不要**把这两个名字挪回 `dependencies`，也**不要**在包内 `node_modules/` 里放指向某台机器仓库的
  Junction——那是这套机制要取代的不可移植做法。
- 祖先目录（例如仓库根的 `node_modules`）恰好存在同名包并不参与这个判定；判定只看该位置的清单
  是否把该名列为 peer。
- `zod` 能作为 installation 条目被应答，是因为 `@deepseek-ai/dsh-storage-domain` 自己声明了
  `zod@^4.4.3`，而 base 挂载了该服务；两者都在安装层的依赖图里。

## 可选：把看板数据放到 SQLite

默认即可工作：dsh 自带的 `storage-domain` 以 `backend: json` 打开 `requirement_board` 域。要换 SQLite，
在**部署侧**的补丁（profile 的 `cordis.patch.yml`，或启动时的 `--patch` 覆盖层）里加两段——介质属于部署
策略，不属插件包：

```yaml
- insert:
    - id: storage-sqlite
      name: "@deepseek-ai/dsh-storage-sqlite"
      config:
        path: !!js dshHomePath('storages/requirement_board.db')
        journalMode: wal
- id: storage-domain
  config:
    backend: json
    routes:
      requirement_board: sqlite
```

两条实测的维护陷阱：`storage-sqlite` 没有任何更早的层声明它，所以必须用 `insert`（否则报
`patch: entry not found` 并被跳过）；`storage-domain` 已由 `packages/bundle/base/cordis.patch.yml` 声明，
用 id 定位的补丁**整体替换** `config`，所以 `backend` 必须原样重述（否则报 `$.backend missing required
value`）。路由键必须是下划线的 `requirement_board`——连字符键匹配不到任何域，会静默回退 JSON。
`!!js dshHomePath(...)` 在部署补丁层是否绑定同一批辅助函数未经实测；不成立时退回字面绝对路径
（并接受该路径不可移植）。

## 可选：preset 里的角色声明

`role.js` 导出为 `dsh-requirement-board/role`，供 preset 在自己的隔离组里发布一个角色声明
（见 ROLE-DISPATCH.md §2.3）。这属于 **preset 层**：每个要参与派发的 preset 各加一行，不塞进本包的补丁。

## 升级

1. 改 Host 代码（`index.js`、`host/**`）→ 重启 `dsh web`。profile 的 HMR 不监听插件模块文件，重新启用插件
   只重跑配置，Node 的 ESM 缓存仍返回旧模块。
2. 改浏览器半边（`client.js`）→ 刷新页面即可，模块注册表按文件时间戳生成 `rev`。
3. 改了 `package.json` 的显示元数据或 `cordis.patch.yml` → 重启后再看插件清单。
4. 换了目录 → 重新 `install_bundle`。

## 验证

- **显示元数据**：`plugin_manager { action: "list_plugins" }` 里该行的标题应是「需求看板 / Requirement
  Board」，而不是包名 `dsh-requirement-board`。元数据读的是 `locale/<lang>.json` 的 `meta.title`；写成扁平
  的 `title` 会被整份忽略并静默退回包名。
- **无浏览器**：`node tests/smoke.mjs`、`node tests/loader.mjs`、`node tests/client-smoke.mjs`（桩件真实
  渲染面板）、`node tests/composition/driver.mjs`（真组合通道）。整份套件清单见 README「开发与测试」。
  注意：套件是**普通 Node 程序**，不经过 dsh 的解析拦截，所以 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-app-boot`、
  `@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-storage-json` 与 `zod` 必须在普通 Node 下可解析
  （`package.json` 的 `devDependencies` 记录了这份需求）。本包不在仓库的 pnpm workspace 里，仓库的
  `pnpm install` 不会为它装这些；从一台装好的开发机跑，或在包目录里补上等价的 `node_modules` 链接。
- **对正在运行的 GUI**：`node tests/live.mjs [baseUrl]`（默认 `http://127.0.0.1:3080`）。

## 交付时的静态校验

本包转正时在源树上做过（**未**在实时 profile 上执行 `install_bundle`）：

- 全部 `*.js` / `*.mjs` 通过 `node --check`；
- `cordis.patch.yml` 通过 YAML 解析；
- 运行时文件的每一个导入说明符都能归入三类之一：`node:` 内建、`peerDependencies` 里声明的两个包、或包内
  存在的相对文件；
- 运行时文件与清单中不存在本机绝对路径（无 `C:\`、无 `Users\...`、无 `.artifacts/`）；
- `exports` 覆盖 `./locale/en.json` 与 `./locale/zh.json`（`package-meta.ts` 要求英文存在、其余同目录文件
  按语言 id 命名并逐个经 exports 解析）。
