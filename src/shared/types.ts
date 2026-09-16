/**
 * dsh-oral-history — shared data model (used by both host and client halves).
 *
 * 口述史工作台的数据模型。核心区分：
 *   - Source（史料）：一手史料 / 二手研究 双轨。口述史访谈录音是一手史料。
 *   - Interview（访谈）：口述史特有的史料子类型，承载音频、逐字稿、受访者。
 *   - Transcript（逐字稿）：可校对、可标注、可引用定位的文本层。
 *   - Evidence card（考据卡）：Zettelkasten 风格的证据/考释/论点卡片。
 *   - Genealogy graph（谱系图）：人物、机构、技术、事件及其历史关系。
 */

/* ==========================================================================
 * 史料（Sources）—— 双轨制
 * ========================================================================== */

/** 一手史料 / 二手研究 */
export const SOURCE_TIERS = ['primary', 'secondary'] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

/** 一手史料的载体类型（口述史只是其中一种） */
export const PRIMARY_KINDS = [
  'oral-history', // 口述史访谈（本项目重点）
  'archive', // 档案文献
  'manuscript', // 手稿 / 抄本
  'rare-book', // 古籍 / 珍本
  'periodical', // 历史报刊
  'patent', // 专利文书
  'instrument', // 仪器 / 器物
  'photograph', // 历史照片
  'correspondence', // 书信
  'lab-notebook', // 实验记录 / 工作笔记
  'other-primary',
] as const;
export type PrimaryKind = (typeof PRIMARY_KINDS)[number];

/** 二手研究的类型 */
export const SECONDARY_KINDS = [
  'journal-article', // 期刊论文
  'monograph', // 学术专著
  'edited-volume', // 编著 / 论文集
  'dissertation', // 学位论文
  'review-essay', // 综述 / 书评
  'reference-work', // 工具书 / 百科全书
  'other-secondary',
] as const;
export type SecondaryKind = (typeof SECONDARY_KINDS)[number];

/** 史料的可信度 / 证据等级（史学常用分层，供筛选与图谱加权） */
export const EVIDENCE_GRADES = ['A', 'B', 'C', 'D'] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

/** 史料的整理状态 */
export const SOURCE_STATUSES = [
  'unprocessed', // 未处理（如仅有原始音频）
  'transcribing', // 转录 / 听校中
  'transcribed', // 已出逐字稿
  'annotated', // 已标注（实体 / 术语 / 存疑点）
  'published', // 已出版 / 已定稿
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** 史料的时间定位 —— 史学特有的"多层时间" */
export interface TemporalSpan {
  /** 史料所记述事件的发生年代（可为区间） */
  eventYearFrom?: number;
  eventYearTo?: number;
  /** 史料本身的产生 / 成书年代 */
  createdYearFrom?: number;
  createdYearTo?: number;
  /** 原始纪年原文（如"康熙二十三年"、"民国二十五年"），保留原样以便考证 */
  originalEra?: string;
}

/** 一手史料的馆藏与版本信息 */
export interface Provenance {
  /** 收藏机构 / 档案馆 / 图书馆 */
  repository?: string;
  /** 馆藏号 / 档案号 / 索书号 */
  callNumber?: string;
  /** 版本说明（如"清乾隆武英殿刻本"、"磁带原件"） */
  edition?: string;
  /** 载体形态（如"开盘磁带 1/4 英寸"、"线装"、"PDF 扫描件"） */
  medium?: string;
  /** 获取方式与授权说明 */
  accessNote?: string;
  /** 数字化来源与处理说明 */
  digitizationNote?: string;
}

export interface Source {
  id: string;
  tier: SourceTier;
  /** 一手史料的载体类型 */
  primaryKind?: PrimaryKind;
  /** 二手研究的类型 */
  secondaryKind?: SecondaryKind;

  title: string;
  /** 一手史料的历史作者 / 口述者；二手研究的现代作者 */
  authors: string[];

  /** 时间定位（多层时间） */
  temporal?: TemporalSpan;

  /** 一手史料：馆藏与版本 */
  provenance?: Provenance;

  /** 二手研究：DOI / 出版信息 */
  doi?: string;
  venue?: string;
  year?: number;
  /** arXiv 编号（仅部分近现代科技史研究适用） */
  arxivId?: string;

  url?: string;
  abstract?: string;
  /** AI 一句话总结 */
  summary?: string;

  /** 语种（历史文献常为多语种） */
  language?: string;

  tags: string[];
  /** 1–5 */
  importance?: number;
  /** 整理状态 */
  status?: SourceStatus;
  /** 证据等级 */
  evidenceGrade?: EvidenceGrade;

  /** 关联的访谈记录 id（一手口述史史料专用） */
  interviewId?: string;
  /** 附件相对路径（attachments/<file>） */
  filePath?: string;

  source: 'agent' | 'manual';
  notes?: string;
  /** 收集分区（多重归属，引用 collections.json 的 id） */
  collectionIds?: string[];

  createdAt: number;
  updatedAt: number;
}

/** 史料收集分区（Zotero 式多重归属） */
export interface SourceCollection {
  id: string;
  name: string;
  color?: string;
  createdAt: number;
  updatedAt: number;
}

/* ==========================================================================
 * 访谈（Interviews）—— 口述史特有的史料子类型
 * ========================================================================== */

/** 受访者档案 */
export interface Interviewee {
  name: string;
  /** 生卒年（史学惯例：生年-卒年，健在者留空卒年） */
  birthYear?: number;
  deathYear?: number;
  /** 主要身份 / 职称 */
  roles: string[];
  /** 所属机构（历史任职，按时间可多条） */
  affiliations: string[];
  /** 研究领域 / 专业 */
  fields: string[];
  /** 人物小传 */
  bio?: string;
}

/** 访谈者（采访人）档案 */
export interface Interviewer {
  name: string;
  affiliation?: string;
}

/** 录音/录像技术信息 —— 决定转录音质与处理难度 */
export interface RecordingTech {
  /** 原始载体（如"开盘磁带"、"卡式录音带"、"DAT"、"数字录音笔"） */
  originalMedium?: string;
  /** 录音年代 */
  recordedYear?: number;
  /** 数字化格式 */
  digitalFormat?: string;
  /** 采样率 / 位深 */
  sampleRate?: string;
  /** 音频总时长（秒） */
  durationSeconds?: number;
  /** 音质评估与已知问题（底噪、串音、变速、断带等） */
  qualityNote?: string;
}

/** 访谈记录：一条访谈 = 一次史料单元 */
export interface Interview {
  id: string;
  /** 关联的史料条目 id */
  sourceId: string;

  interviewee: Interviewee;
  interviewers: Interviewer[];

  /** 访谈发生时间 */
  interviewYear?: number;
  interviewDate?: string;
  /** 访谈地点 */
  location?: string;

  /** 录音技术信息 */
  recording?: RecordingTech;

  /** 音频文件相对路径（attachments/<file>） */
  audioPath?: string;
  /** 音频时长（秒） */
  durationSeconds?: number;

  /** 逐字稿（见 Transcript） */
  transcriptId?: string;

  /** 访谈提纲 / 已问问题 */
  questionOutline?: string;
  /** 背景知识补充（课题组整理） */
  backgroundNotes?: string;
  /** 出版与授权状态 */
  publicationNote?: string;

  createdAt: number;
  updatedAt: number;
}

/* ==========================================================================
 * 逐字稿（Transcripts）—— 可校对、可标注、可引用
 * ========================================================================== */

/** 说话人角色 */
export const SPEAKER_ROLES = ['interviewer', 'interviewee', 'third-party', 'unknown'] as const;
export type SpeakerRole = (typeof SPEAKER_ROLES)[number];

/** 逐字稿分段的校对状态 */
export const SEGMENT_STATUSES = [
  'raw', // 机器转录原始输出，未校对
  'ai-corrected', // AI 按术语表/上下文修正
  'human-verified', // 人工听校确认
  'uncertain', // 存疑，需回听
  'inaudible', // 无法辨听
] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

/** 逐字稿的一段（对应音频的一个时间区间） */
export interface Segment {
  id: string;
  /** 起始时间（秒，相对音频起点） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  speaker: SpeakerRole;
  /** 说话人标注名（如具体姓名；unknown 时留空） */
  speakerLabel?: string;
  /** 正文（校对后的文本） */
  text: string;
  /** 机器转录原始文本（保留以便对照与训练） */
  rawText?: string;
  /** 校对状态 */
  status: SegmentStatus;
  /** 置信度 0–1（ASR 输出或人工评估） */
  confidence?: number;
  /** 存疑说明 / 听校备注 */
  note?: string;
  /** 该段涉及的实体 id（指向图谱节点） */
  entityIds?: string[];
}

/** 逐字稿 */
export interface Transcript {
  id: string;
  /** 关联访谈 id */
  interviewId: string;
  /** 关联史料 id */
  sourceId: string;
  language?: string;
  segments: Segment[];
  /** 术语表：领域专名 → 正确写法（供 AI 修正 ASR 错误） */
  glossary?: GlossaryEntry[];
  /** 校对进度（0–1，人工确认段数 / 总段数） */
  verifiedRatio?: number;
  createdAt: number;
  updatedAt: number;
}

/** 术语表条目：把易错的 ASR 输出映射到正确写法 */
export interface GlossaryEntry {
  /** 正确写法（如"钱学森"） */
  term: string;
  /** 常见的错误转录变体 */
  variants?: string[];
  /** 类别（人名 / 机构 / 术语 / 地名） */
  kind?: string;
  /** 说明 */
  note?: string;
}

/* ==========================================================================
 * 考据卡（Evidence / Exegesis Cards）—— Zettelkasten 风格
 * ========================================================================== */

/**
 * 卡片类型 —— 对应史学工作的不同环节。
 * 与理工科"Idea 卡（创新点/待验证）"不同，史学卡片以"证据—考释—论点"为核心。
 */
export const CARD_KINDS = [
  'extract', // 史料摘录：原文片段 + 出处
  'chronology', // 史实编年：确定的人/事/物年代
  'concept', // 史学概念：范式、学派、术语辨析
  'exegesis', // 考释：对某段史料的解读与论证
  'dispute', // 争议：学术争论中的一方观点
  'thesis', // 论点：论文的论证单元
  'context', // 背景：时代/制度/社会语境
  'other',
] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** 卡片状态 —— 史学写作的论证成熟度 */
export const CARD_STATUSES = [
  'draft', // 草稿
  'corroborated', // 已获旁证
  'contested', // 存在反证 / 有争议
  'settled', // 已定论，可直接引用
  'dropped', // 搁置
] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export interface EvidenceCard {
  id: string;
  title: string;
  kind: CardKind;
  /** 核心内容：考释、论证或摘录正文 */
  content: string;

  /** 来源史料 id（可空） */
  sourceId?: string;
  /** 来源访谈 id（可空） */
  interviewId?: string;
  /** 引文定位：逐字稿段落 id / 页码 / 档案卷宗号 */
  citation?: string;
  /** 证据摘录原文（让卡片自包含） */
  quote?: string;

  /** 论证角色：这张卡在论文里承担什么 */
  argumentRole?: string;
  /** 反证 / 存疑：与本文论点相左的材料 */
  counterEvidence?: string;

  tags: string[];
  /** 1–5 */
  importance: number;
  status: CardStatus;

  notes?: string;
  /** 卡片间关联 */
  relatedCardIds?: string[];

  createdAt: number;
  updatedAt: number;
}

/* ==========================================================================
 * 谱系图（Genealogy Graph）—— 科技史时空谱系
 * ========================================================================== */

/**
 * 节点类型 —— 科技史的实体类别。
 * 与理工科"论文+概念"不同，史学图谱以"人—机构—造物—事件—概念"构成。
 */
export const GRAPH_NODE_KINDS = [
  'person', // 人物（科学家 / 工程师 / 工匠 / 官员 / 传教士）
  'institution', // 机构 / 学派 / 学会 / 实验室 / 厂矿
  'artifact', // 器物 / 仪器 / 装置 / 技术产品
  'event', // 事件（发现 / 发明 / 论战 / 会议 / 政策）
  'concept', // 概念 / 理论 / 范式 / 术语
  'publication', // 著作 / 论文 / 档案 / 报告
  'place', // 地点 / 地区 / 厂址
  'source', // 史料节点（对应 Source）
  'card', // 考据卡节点（对应 EvidenceCard）
] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

/**
 * 边类型 —— 历史关系的种类。
 * 刻意区分于理工科的"提出/改进/对比"，史学关系强调社会性与时间性。
 */
export const GRAPH_EDGE_KINDS = [
  // 人物关系
  'mentored', // 师承：A 师从 B
  'colleague', // 同事 / 合作者
  'patronized', // 赞助 / 提携：A 资助或提携 B
  'debated', // 论战 / 争鸣（含优先权之争）
  'succeeded', // 接任 / 继承职位
  // 机构与人物
  'affiliated', // 任职 / 隶属
  'founded', // 创立
  // 技术与知识
  'invented', // 发明 / 创制
  'improved', // 改良 / 优化
  'transferred', // 技术转移 / 引进
  'localized', // 本土化改制 / 在地适应
  'theorized', // 理论化 / 概念提出
  'applied', // 应用 / 使用
  // 文献与证据
  'authored', // 著述
  'cited', // 引用 / 参见
  'annotated', // 批注 / 考释
  'derived_from', // 源自（考据卡的史料来源）
  // 时间与因果
  'preceded', // 先于（时间序列）
  'caused', // 导致 / 促成
  'influenced', // 影响
  'related', // 其他关联
] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** 时间定位：年代（用于时间轴过滤） */
  yearFrom?: number;
  yearTo?: number;
  /** 地理定位：经纬度（用于空间过滤） */
  lat?: number;
  lng?: number;
  /** 地点名（无经纬度时的文字定位） */
  place?: string;
  /** 别名 / 异写（历史人物常有多种写法） */
  aliases?: string[];
  /** 一句话说明 */
  note?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** 关系发生年代（可选，用于时间轴上的动态演化） */
  year?: number;
  /** 关系说明 */
  note?: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/* ==========================================================================
 * 统计与配置
 * ========================================================================== */

export interface OralHistoryStats {
  sources: number;
  primary: number;
  secondary: number;
  interviews: number;
  transcripts: number;
  segments: number;
  verifiedSegments: number;
  cards: number;
  nodes: number;
  edges: number;
  dir: string;
  /** 已入库但尚未入图的史料（id+title） */
  unsynced?: { id: string; title: string }[];
  /** init 时跳过的损坏文件清单（相对路径） */
  corruptFiles?: string[];
}

export interface OralHistoryConfig {
  /** 数据根目录 */
  dataDir: string;
  defaultTags?: string[];
  /** 可选出网代理，如 http://127.0.0.1:7890 */
  fetchProxy?: string;
  /** OpenAlex polite pool 联系邮箱 */
  openalexEmail?: string;
  /** 默认语种 */
  defaultLanguage?: string;
  /** 转录服务端点（可选，用于 ASR 管线） */
  asrEndpoint?: string;
  /** 术语表文件路径（可选） */
  glossaryPath?: string;
}

/* ==========================================================================
 * 查询类型
 * ========================================================================== */

export type SourceSort = 'createdAt' | 'year' | 'title' | 'eventYear';
export type CardSort = 'createdAt' | 'importance' | 'title';

export interface SourceQuery {
  q?: string;
  tier?: SourceTier;
  primaryKind?: PrimaryKind;
  secondaryKind?: SecondaryKind;
  tag?: string;
  yearFrom?: number;
  yearTo?: number;
  /** 按史料所记事件的年代筛选（史学常用） */
  eventYearFrom?: number;
  eventYearTo?: number;
  importance?: number;
  collection?: string;
  unfiled?: boolean;
  status?: SourceStatus;
  evidenceGrade?: EvidenceGrade;
  language?: string;
  sort?: SourceSort;
}

export interface CardQuery {
  q?: string;
  kind?: CardKind;
  tag?: string;
  importance?: number;
  status?: CardStatus;
  sourceId?: string;
  interviewId?: string;
  sort?: CardSort;
}

export interface InterviewQuery {
  q?: string;
  /** 受访者姓名关键词 */
  interviewee?: string;
  field?: string;
  affiliation?: string;
  yearFrom?: number;
  yearTo?: number;
  status?: SourceStatus;
}

/** 谱系图查询：按时间窗与节点类型过滤 */
export interface GraphQuery {
  kinds?: GraphNodeKind[];
  edgeKinds?: GraphEdgeKind[];
  yearFrom?: number;
  yearTo?: number;
  /** 以某节点为中心的 N 跳子图 */
  centerId?: string;
  hops?: number;
  q?: string;
}
