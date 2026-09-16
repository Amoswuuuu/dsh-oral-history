# 口述史工作台 · dsh-oral-history

> 面向**科学技术史**研究的 DSH Web 插件：口述史料建档 → 音频转录 → 人工听校 → 考据卡片 → 时空谱系图谱。

A [DSH (DeepSeek Harness)](https://github.com/deepseek-ai) Web plugin for **oral-history research in the history of science and technology**. It turns interview recordings into citable, verifiable evidence — and keeps the machine-vs-human provenance of every sentence.

本插件基于 [`Amoswuuuu/dsh-scholar`](https://github.com/Amoswuuuu/dsh-scholar)（学者工作台）改造，把「论文库 / Idea 书柜 / 知识图谱」重构为「史料库 / 考据卡片 / 时空谱系」，并把**口述史音频**作为一等公民。

---

## 为什么单独做口述史

科技史研究里，**口述史是最难也最不可替代的一手史料**：它记录了档案里不会写的东西——技术决策的实际过程、失败路线的细节、师徒之间的隐性知识、厂矿与实验室的日常。

但它也最难处理：

| 困难 | 本工作台的对策 |
|---|---|
| 音频无法检索、无法引用 | 逐字稿分段 + 秒级时间戳，每段可定位回音频 |
| 机器转录错误率高，专名尤其严重 | 术语表 + 确定性批量修正，保留机器原文对照 |
| 无法判断哪句可信 | 五级校对状态（未校 / AI修正 / 已听校 / 存疑 / 无法辨听），逐段可见 |
| 转录质量与史料价值脱钩 | 校对进度量化（`verifiedRatio`），未校内容永久带标记 |
| 受访者记忆的年代与史料成书年代混淆 | **双层时间模型**：所记事件年代 vs 成书/录音年代，分开检索 |
| 一手与二手混在一起 | **双轨史料库**：一手（档案/手稿/器物/口述）与二手（论文/专著）分轨，字段与检索维度各不相同 |
| 只记支持性证据 | 卡片强制「反证/存疑」字段，已定论但无反证的卡片会被提示 |

**反臆造是硬约束**：工作流提示词禁止编造历史内容；无法核实的年代、人名、事件一律标 `待考`；只有人工听校确认的段落才能标记为 `human-verified`。

---

## 三个视图 + 一条转录工作线

### 1. 史料库（双轨）
一手史料与二手研究分轨管理，**字段集按轨道切换**：

- **一手**：载体类型（口述访谈/档案/手稿/古籍/报刊/专利/器物/照片/书信/实验记录）、**馆藏信息**（收藏机构 / 馆藏号 / 版本 / 载体 / 获取说明 / 数字化说明）、**原始纪年**（如「康熙二十三年」）。
- **二手**：DOI / arXiv / 期刊 / 卷期，可一键抓取元数据。

去重键按史料类型分层：**馆藏号 > DOI > 标题**。对一手史料而言，馆藏号才是真正的唯一标识——这是与论文管理器的关键分野。

检索维度含**所记事件年代**（`eventYearFrom/To`）——一份 1985 年的回忆录可能记的是 1958 年的事，这个区分对科技史检索是刚需。

### 2. 访谈与逐字稿
本插件的主战场。左侧访谈档案，右侧转录工作台：

- **音频播放器**：自定义播放/暂停、进度条、**0.75×–2× 倍速**（辨听方言与快速语流的关键）。
- **卡拉OK式跟随**：播放时自动高亮当前分段并滚动到视野内。
- **逐段校订**：点击时间戳跳转播放；行内编辑文本；修改时自动留存 `rawText`（机器转录原文），"机器 vs 人工"的对照永久可回溯。
- **五级校对状态**：`raw`（未校）→ `ai-corrected`（AI 修正）→ `human-verified`（已听校），另有 `uncertain`（存疑）、`inaudible`（无法辨听）。听不清的段落**允许为空文本 + 备注**——"听不清"本身就是有效信息。
- **术语表**：把反复转录错误的专名（人名/机构/术语）登记为 `正确写法 ← 错误写法`，可对全文做**确定性**批量修正（非 AI，可复现）。
- **进度可视化**：按状态堆叠的进度条 + 整体校对比例。

### 3. 考据卡片（Zettelkasten）
以**论证单元**而非"笔记"为单位。字段设计针对史学写作的实际缺陷：

- `kind`：史料摘录 / 史实编年 / 概念辨析 / 考释解读 / 学术争议 / 论文论点 / 时代背景
- `citation`：引文定位（逐字稿段落 id / 卷宗号 / 页码）——填了段落 id 就能**一键跳回逐字稿对应位置**
- `quote`：证据原文，供日后核对
- `argumentRole`：这张卡在论文里承担什么
- `counterEvidence`：**反证/存疑**——只记支持性证据是史学写作的严重缺陷，UI 会对"已定论但无反证"的卡片给出提示
- `status`：草稿 → 已获旁证 → 已成定论；另有 存在争议 / 已弃用

三种视图：**看板**（拖拽推进状态）、列表、表格。建卡时自动检测**相似卡**（标题 Jaccard + 同来源加分），因为"同一段史料反复摘录"是 Zettelkasten 实践中的真实问题。

### 4. 时空谱系
不是通用的"知识图谱"，而是**科技史谱系图**：

- **节点类型**：人物 / 机构 / 器物技术 / 事件 / 概念 / 文献著作 / 地点
- **关系类型按史学关系族组织**：师承 `mentored`、同事 `colleague`、赞助提携 `patronized`、**论战 `debated`**、接任 `succeeded`；任职 `affiliated`、创立 `founded`；发明 `invented`、改良 `improved`、**技术转移 `transferred`**、**本土化 `localized`**、理论化 `theorized`、应用 `applied`；著述 `authored`、引用 `cited`、批注考释 `annotated`；先于 `preceded`、导致 `caused`、影响 `influenced`

  ——刻意不使用理工科的"提出/改进/对比"类关系，那些词无法表达史学关切。

- **时间轴力导向**：节点按年代沿横轴排布，可拉时间窗只看某一时期；无年代的节点进入中性带而非堆积在 0 年。
- **地理力**：带经纬度的节点按地理邻近度聚类。
- **论战边高亮**：`debated` 用加粗 + 危险色 + 虚线，因为学术争论在本领域是**研究对象**，不是边角情况。
- **方向性**：师承/著述/发明等画箭头，同事/任职等无向；时间因果类虚线。

史料、访谈、卡片会**自动**进图（人物、任职机构、地点、来源关系，纯启发式、无 AI）；语义关系由对话中的 AI 通过 `kg_extract` 抽取后提交。

---

## 安装

插件通过 DSH 的 bundle 机制装载。在 profile 的 `cordis.patch.yml` 中引入：

```yaml
- insert:
    - id: dsh-oral-history
      name: dsh-oral-history
```

并确保包可被 profile 的 `node_modules` 解析（例如 `npm install /path/to/dsh-oral-history` 或建立链接）。

```bash
npm install
npm run build
```

重启 DSH Web 后，侧栏底部出现「口述史」入口。

### 配置
设置页可配置：档案目录（默认 `~/Documents/OralHistoryArchive`）、默认标签、默认语种、ASR 服务端点、出网代理、OpenAlex 邮箱。

档案目录结构：

```
OralHistoryArchive/
├── sources/          # 一条史料一个 JSON
├── interviews/       # 访谈档案
├── transcripts/      # 逐字稿（含分段与术语表）
├── cards/            # 考据卡片
├── attachments/      # 录音、扫描件、逐字稿文档（上限 200MB/文件）
├── collections.json  # 分区
└── graph.json        # 时空谱系图谱
```

全部为本地文件，**原子写入**（临时文件 + rename），无数据库、无外部服务。损坏文件会被跳过并记录，不会导致加载失败。

---

## 给 AI 的工具

宿主本身**从不调用 LLM**。所有 AI 生成的内容都通过对话中的工具调用进入，经宿主校验后落盘：

| 工具 | 用途 |
|---|---|
| `source_save` / `source_update` / `source_search` / `source_get` | 史料建档、更新、检索、读取 |
| `source_fetch_meta` | 按 DOI / arXiv 抓取二手文献元数据 |
| `interview_save` / `interview_search` / `interview_get` | 访谈档案（受访者生卒年、任职机构、录音信息） |
| `transcript_save` / `transcript_get` | 逐字稿分段写入与读取（含单段修正） |
| `transcript_glossary_add` | 术语表登记 + 确定性批量修正 |
| `card_create` / `card_search` / `card_update` | 考据卡片 |
| `kg_extract` / `kg_query` | 谱系图谱抽取（prepare/commit 两阶段）与查询 |
| `attachment_link` | 把已上传文件关联到史料或访谈 |

插件还会向系统提示注入 `dsh-oral-history-workflow` 工作流段落（建档 → 转录 → 标注 → 考据），约束 AI 的工作方式与**反臆造**要求。

---

## 转录管线

```
音频 ──► ASR（Whisper 等）──► status=raw 分段
                                  │
                    术语表确定性修正 ──► status=ai-corrected
                                  │
                        人工对照音频听校 ──► status=human-verified
                                  │
                            考据卡片（citation = 段落 id）
```

`asrEndpoint` 可指向本地 Whisper 服务；留空则纯手工转录。**AI 修正永远不能直接产生 `human-verified`**——该状态只能由人工听校赋予，这是证据分级的基础。

---

## 开发

```bash
npm run build          # tsc（宿主 ESM）+ tsdown（客户端 CJS）+ wrap-client
npm run typecheck      # 宿主类型检查
npm run typecheck:client
npm run smoke          # 端到端测试：领域/存储 smoke + 全部 REST 路由（150+ 断言，纯 Node，无需浏览器）
```

### 示范数据集（真实公开史料）

仓库带一个策展过的示范数据集，取自 **Computer History Museum 公开在线馆藏目录**的口述史专藏——
12 位 AI 史 / 计算机史人物（McCarthy、Knuth、Feigenbaum、Pearl、Hamilton、Kahn、Metcalfe、
Catmull、Wilkes、Aho、Ozzie、Vittal），含真实馆藏号、机构、领域与目录摘要。

```bash
node scripts/seed-demo.mjs --with-transcript   # 写入默认档案目录
```

这一步只写入**元数据**，不下载音频（CHM 音频有独立使用条款，请遵守其条款后自行获取）。
它顺带演示了本工作台的一个核心主张：**馆藏号（callNumber）是比 DOI 更可靠的一手史料去重键**。

载入后可直接用真实数据验证三个视图与图谱：`MIT` 会正确聚合出 McCarthy 与 Metcalfe 两位校友，
`q=LISP` 命中 McCarthy、`q=TeX` 命中 Knuth 与 Aho——师承与机构网络是从档案里长出来的，不是写死的。

### 架构

```
src/
├── index.ts            # 插件入口：settings 命名空间、工作流提示词、装配
├── store.ts            # 本地持久化：原子写、写锁、图谱合并、启发式入图
├── domain.ts           # 领域语义：创建/合并/补丁、去重、相似卡、分段归一化
├── routes.ts           # REST /oral-history/*
├── tools.ts            # 17 个 agent 工具
├── metadata.ts         # DOI / arXiv 元数据抓取（含代理支持）
├── shared/types.ts     # 全量数据模型（前后端共用）
└── client/
    ├── index.tsx       # 抽屉外壳：侧栏入口 / overlay / 设置页 / 深链
    ├── ui.tsx          # 无依赖 UI 原语 + 史学配色（节点/边/分段/轨道）
    ├── SourceLibraryView.tsx
    ├── TranscriptView.tsx
    ├── EvidenceCardView.tsx
    ├── GenealogyGraphView.tsx
    ├── SettingsSection.tsx
    ├── rightbar.tsx    # 官方右侧栏页签
    ├── nav.ts          # 跨视图导航（useSyncExternalStore）
    ├── api.ts
    └── locales.ts      # 中英双语（键集强制一致）

scripts/
├── smoke-test.mjs      # 领域 + 存储端到端断言
├── route-test.mjs      # 全部 REST 路由（含真实 http 附件流）
├── seed-demo.mjs       # 载入 CHM 示范数据集
└── demo-data/          # 策展后的真实公开元数据
```

技术约束备忘：

- 插件路由**不能**挂在 `/api` 下——该前缀由 `dsh-client-connection` 占用。
- settings 命名空间必须是小写 kebab-case。
- 客户端 bundle 的注册 id 必须等于 `package.json` 的 `name`。
- 必须用 `@deepseek-ai/schemastery`，裸 `schemastery` 在运行期无法解析。
- 图谱渲染为手写力导向，**零新增依赖**。

---

## 许可

MIT
