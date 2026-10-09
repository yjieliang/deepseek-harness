# 反证记录（break it and it goes red）

对最终交付字节做三次「故意改坏一条 → 两个仪表转红 → 恢复 → 转绿」的循环。
每次循环都用 `rollout/counter-proof.mjs` 改**授权源** `rollout/new-panel.css`，
重新拼接进 `client.js`，发布到部署副本（浏览器门只认已发布字节），跑完两个仪表后恢复原值。

复现：`cd .artifacts/requirement-board/rollout && node counter-proof.mjs <label> <pattern> <replacement>`

仪表：
- `tests/client-smoke.mjs`（源码级，389 条）
- `tests/verification/panel-render.e2e.mjs`（真浏览器，`127.0.0.1:3110`，56 条）

## 1. 颜色：`--rb-accent:#f06423;` → `--rb-accent:#f06424;`

### 改坏
- client-smoke：**RED**（388/389）
  - `FAIL the stylesheet declares the accent once per theme arm`（列出实际两臂取值）
- panel-render：**RED**（54/56）
  - `FAIL the accent reaches the panel as the concept's orange (rgb(240, 100, 36))`
  - `FAIL the primary action carries that accent (rgb(240, 100, 35))`

### 恢复
- client-smoke：绿 389/389 ｜ panel-render：绿 56/56

## 2. 字号：`.rb-stat-value` `font-size:26px` → `27px`

### 改坏
- client-smoke：**RED**（388/389）
  - `FAIL the reading faces keep the concept type scale`
- panel-render：**RED**（55/56）
  - `FAIL the reading keeps 26px tabular numerals (27px, tabular-nums)`

### 恢复
- client-smoke：绿 389/389 ｜ panel-render：绿 56/56

## 3. 几何：KPI 带 `grid-template-columns:300px … 220px` → `240px … 220px`

### 改坏
- client-smoke：**RED**（388/389）
  - `FAIL the band keeps the concept proportions — the band declares neither the concept columns nor its narrow arm`
- panel-render：**RED**（55/56）
  - `FAIL the band keeps the concept columns (240px 120.797px 120.797px 120.797px 120.797px 120.812px 220px)`

### 恢复
- client-smoke：绿 389/389 ｜ panel-render：绿 56/56

## 收尾核对（三个循环之后）

```
client-smoke: 389/389 checks passed
panel-render: 56/56 checks passed
g-hygiene:    6/6 checks passed
```

三次改坏分别在**源码断言**与**真浏览器计算样式**两侧各触发一条对应断言，
说明新增的颜色/字号/几何断言不是「写了但不会红」的空断言。
