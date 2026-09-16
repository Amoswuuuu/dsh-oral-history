/**
 * dsh-oral-history — local JSON file storage.
 *
 * Layout under the configured data directory:
 *   sources/<id>.json       one Source per file（史料条目）
 *   interviews/<id>.json    one Interview per file（访谈档案）
 *   transcripts/<id>.json   one Transcript per file（逐字稿，含分段）
 *   cards/<id>.json         one EvidenceCard per file（考据卡）
 *   collections.json        SourceCollection[]
 *   graph.json              KnowledgeGraph（谱系图）
 *   attachments/            音频 / 扫描件 / 文档附件
 *
 * All writes are atomic (tmp file + rename). Loads tolerate corrupt files
 * (skipped with a warning) so a single bad write never breaks the archive.
 */
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CardQuery, EvidenceCard, GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, Interview,
  InterviewQuery, KnowledgeGraph, OralHistoryStats, Source, SourceCollection,
  SourceQuery, Transcript,
} from './shared/types.js';
import { GRAPH_EDGE_KINDS } from './shared/types.js';

export const EMPTY_GRAPH: KnowledgeGraph = { nodes: [], edges: [] };

const MAX_GRAPH_NODES = 4000;
const MAX_GRAPH_EDGES = 12000;

/* ==========================================================================
 * Id 生成
 * ========================================================================== */

/** Filesystem-safe id derived from a title (stable across runs). */
export function slugifyTitle(title: string): string {
  const base = title.toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'source';
  const hash = createHash('sha1').update(title.trim().toLowerCase()).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Source id：有 DOI 用 DOI（去重主键），否则用标题 slug。
 * 注意：一手史料通常没有 DOI，标题 slug 是主要路径。
 */
export function sourceIdFor(title: string, doi?: string): string {
  const d = doi?.trim();
  if (d) return `doi_${d.replace(/[^A-Za-z0-9._/-]/g, '_')}`;
  return slugifyTitle(title);
}

/**
 * 史料节点 id 的规范化（保持与 concept 前缀不相交）。
 * 徽标前缀：per_ 人物 / ins_ 机构 / art_ 器物 / evt_ 事件 / cpt_ 概念 /
 *          pub_ 著作 / plc_ 地点 / src_ 史料 / card_ 考据卡
 */
export const NODE_PREFIX: Record<string, string> = {
  person: 'per',
  institution: 'ins',
  artifact: 'art',
  event: 'evt',
  concept: 'cpt',
  publication: 'pub',
  place: 'plc',
  source: 'src',
  card: 'card',
};

/**
 * Canonical graph node id：已规范化的 id 原样保留（模型可复用），
 * 裸 slug 按 kind 加前缀。CJK 字符保留（id 只存在于 graph.json 与工具参数，
 * 不进文件名/URL）。
 */
export function graphNodeId(input: string, kind: string): string {
  const prefix = NODE_PREFIX[kind] ?? 'cpt';
  const trimmed = input.trim();
  const m = new RegExp(`^(${Object.values(NODE_PREFIX).join('|')})_(.+)$`).exec(trimmed);
  const raw = m ? m[2] : trimmed;
  const base = raw.toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'node';
  return `${prefix}_${base}`;
}

/** 向后兼容别名（概念节点专用）。 */
export function conceptId(input: string): string {
  return graphNodeId(input, 'concept');
}

export function newCardId(): string {
  return `c_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

export function newInterviewId(): string {
  return `iv_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

export function newTranscriptId(): string {
  return `tr_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

export function newSegmentId(index: number): string {
  return `sg_${String(index).padStart(4, '0')}_${randomUUID().slice(0, 4)}`;
}

export function newCollectionId(): string {
  return `col_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

/* ==========================================================================
 * 筛选
 * ========================================================================== */

/** Case-insensitive keyword match across a source's searchable fields. */
function sourceMatches(s: Source, q: string): boolean {
  const needle = q.toLowerCase();
  const fields: (string | undefined)[] = [
    s.title, s.summary, s.abstract, s.venue, s.doi, s.arxivId, s.notes,
    s.provenance?.repository, s.provenance?.callNumber, s.provenance?.edition,
    s.provenance?.medium, s.temporal?.originalEra, s.language,
    ...s.authors, ...s.tags,
  ];
  return fields.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
}

export function filterSources(all: Source[], query: SourceQuery): Source[] {
  let out = all;
  if (query.q) out = out.filter((s) => sourceMatches(s, query.q as string));
  if (query.tier) out = out.filter((s) => s.tier === query.tier);
  if (query.primaryKind) out = out.filter((s) => s.primaryKind === query.primaryKind);
  if (query.secondaryKind) out = out.filter((s) => s.secondaryKind === query.secondaryKind);
  if (query.tag) {
    const t = String(query.tag).toLowerCase();
    out = out.filter((s) => s.tags.some((tag) => tag.toLowerCase() === t));
  }
  if (query.yearFrom) out = out.filter((s) => (s.year ?? 0) >= (query.yearFrom as number));
  if (query.yearTo) out = out.filter((s) => (s.year ?? 9999) <= (query.yearTo as number));
  // 事件年代：落入区间的史料（区间有交叠即算命中，史学检索的常见语义）
  if (query.eventYearFrom !== undefined) {
    const f = query.eventYearFrom;
    out = out.filter((s) => (s.temporal?.eventYearTo ?? s.temporal?.eventYearFrom ?? s.year ?? 9999) >= f);
  }
  if (query.eventYearTo !== undefined) {
    const t = query.eventYearTo;
    out = out.filter((s) => (s.temporal?.eventYearFrom ?? s.temporal?.eventYearTo ?? s.year ?? 0) <= t);
  }
  if (query.importance) out = out.filter((s) => (s.importance ?? 0) >= (query.importance as number));
  if (query.collection) out = out.filter((s) => (s.collectionIds ?? []).includes(query.collection as string));
  if (query.unfiled) out = out.filter((s) => (s.collectionIds ?? []).length === 0);
  if (query.status) out = out.filter((s) => (s.status ?? 'unprocessed') === query.status);
  if (query.evidenceGrade) out = out.filter((s) => s.evidenceGrade === query.evidenceGrade);
  if (query.language) out = out.filter((s) => (s.language ?? '').toLowerCase() === String(query.language).toLowerCase());

  const sort = query.sort ?? 'createdAt';
  out = [...out].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'year') return (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title);
    if (sort === 'eventYear') {
      const av = a.temporal?.eventYearFrom ?? a.year ?? 0;
      const bv = b.temporal?.eventYearFrom ?? b.year ?? 0;
      return av - bv || a.title.localeCompare(b.title);
    }
    return b.createdAt - a.createdAt || a.title.localeCompare(b.title);
  });
  return out;
}

function cardMatches(c: EvidenceCard, q: string): boolean {
  const needle = q.toLowerCase();
  return [c.title, c.content, c.notes, c.quote, c.citation, c.argumentRole, c.counterEvidence]
    .some((v) => typeof v === 'string' && v.toLowerCase().includes(needle))
    || c.tags.some((tag) => tag.toLowerCase().includes(needle));
}

export function filterCards(all: EvidenceCard[], query: CardQuery): EvidenceCard[] {
  let out = all;
  if (query.q) out = out.filter((c) => cardMatches(c, query.q as string));
  if (query.kind) out = out.filter((c) => c.kind === query.kind);
  if (query.tag) out = out.filter((c) => c.tags.includes(query.tag as string));
  if (query.importance) out = out.filter((c) => c.importance >= (query.importance as number));
  if (query.status) out = out.filter((c) => c.status === query.status);
  if (query.sourceId) out = out.filter((c) => c.sourceId === query.sourceId);
  if (query.interviewId) out = out.filter((c) => c.interviewId === query.interviewId);

  const sort = query.sort ?? 'createdAt';
  out = [...out].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'importance') return b.importance - a.importance || b.createdAt - a.createdAt;
    return b.createdAt - a.createdAt;
  });
  return out;
}

function interviewMatches(iv: Interview, q: string): boolean {
  const needle = q.toLowerCase();
  const fields: (string | undefined)[] = [
    iv.interviewee.name, iv.interviewee.bio, iv.location, iv.questionOutline,
    iv.backgroundNotes, iv.recording?.originalMedium, iv.recording?.qualityNote,
    ...iv.interviewee.roles, ...iv.interviewee.affiliations, ...iv.interviewee.fields,
    ...iv.interviewers.map((x) => x.name),
  ];
  return fields.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
}

export function filterInterviews(all: Interview[], query: InterviewQuery): Interview[] {
  let out = all;
  if (query.q) out = out.filter((iv) => interviewMatches(iv, query.q as string));
  if (query.interviewee) {
    const n = String(query.interviewee).toLowerCase();
    out = out.filter((iv) => iv.interviewee.name.toLowerCase().includes(n));
  }
  if (query.field) {
    const f = String(query.field).toLowerCase();
    out = out.filter((iv) => iv.interviewee.fields.some((x) => x.toLowerCase().includes(f)));
  }
  if (query.affiliation) {
    const a = String(query.affiliation).toLowerCase();
    out = out.filter((iv) => iv.interviewee.affiliations.some((x) => x.toLowerCase().includes(a)));
  }
  if (query.yearFrom) out = out.filter((iv) => (iv.interviewYear ?? 0) >= (query.yearFrom as number));
  if (query.yearTo) out = out.filter((iv) => (iv.interviewYear ?? 9999) <= (query.yearTo as number));
  return [...out].sort((a, b) => (b.interviewYear ?? 0) - (a.interviewYear ?? 0) || a.interviewee.name.localeCompare(b.interviewee.name));
}

/** Union of all tags across sources (sorted, deduped). */
export function allSourceTags(sources: Iterable<Source>): string[] {
  const set = new Set<string>();
  for (const s of sources) for (const tag of s.tags) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function allCardTags(cards: Iterable<EvidenceCard>): string[] {
  const set = new Set<string>();
  for (const c of cards) for (const tag of c.tags) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/* ==========================================================================
 * 谱系图合并
 * ========================================================================== */

/**
 * Resolve an edge endpoint against known node ids: an exact id wins;
 * otherwise a bare slug is canonicalized by trying each known node's
 * prefixed form so model submissions that omit the prefix still resolve.
 */
function resolveEndpoint(nodes: Map<string, GraphNode>, raw: string): string | undefined {
  if (nodes.has(raw)) return raw;
  for (const kind of Object.keys(NODE_PREFIX)) {
    const cid = graphNodeId(raw, kind);
    if (nodes.has(cid)) return cid;
  }
  // 退化：概念前缀（历史行为）
  const cid = conceptId(raw);
  return nodes.has(cid) ? cid : undefined;
}

export interface GraphMergeStats {
  truncatedNodes: boolean;
  truncatedEdges: boolean;
}

/**
 * Merge a model-submitted node/edge set into the graph.
 * - rebuild: start from an empty base; append: keep existing content
 * - node ids are canonicalized per kind; source/card nodes must reference real records
 * - edges have endpoints resolved canonically, self-loops dropped, deduped
 * - append 模式下旧边并入结果并参与去重
 */
export function mergeGraph(
  existing: KnowledgeGraph,
  incoming: { nodes: GraphNode[]; edges: GraphEdge[] },
  mode: 'append' | 'rebuild',
  known: { sourceIds: ReadonlySet<string>; cardIds: ReadonlySet<string> },
  stats?: GraphMergeStats,
): KnowledgeGraph {
  const base = mode === 'rebuild' ? { nodes: [] as GraphNode[], edges: [] as GraphEdge[] } : existing;
  const nodes = new Map<string, GraphNode>();
  for (const n of base.nodes) nodes.set(n.id, n);

  let truncatedNodes = false;
  for (const raw of incoming.nodes) {
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!id || !label) continue;
    const rawKind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    // 非法节点类型直接丢弃，**不能**回落为 concept：
    // kind 在史学图谱里是一项分类主张（人物≠概念≠器物），
    // 把 AI 臆造的类型静默改写成"概念"会污染图谱且无从察觉。
    if (!GRAPH_NODE_KINDS_SAFE.includes(rawKind)) continue;
    const kind = rawKind as GraphNodeKind;

    let node: GraphNode;
    if (kind === 'source') {
      // 史料节点必须是真实史料
      const sid = known.sourceIds.has(id) ? id : [...known.sourceIds].find((x) => x === graphNodeId(id, 'source'));
      if (!sid) continue;
      node = { id: sid, kind: 'source', label };
    } else if (kind === 'card') {
      if (!known.cardIds.has(id)) continue;
      node = { id, kind: 'card', label };
    } else {
      node = { id: graphNodeId(id, kind), kind, label };
    }
    // 时空与别名元数据透传（史学图谱的核心维度）
    if (node.kind !== 'source' && node.kind !== 'card') {
      if (typeof raw.yearFrom === 'number') node.yearFrom = raw.yearFrom;
      if (typeof raw.yearTo === 'number') node.yearTo = raw.yearTo;
      if (typeof raw.lat === 'number') node.lat = raw.lat;
      if (typeof raw.lng === 'number') node.lng = raw.lng;
      if (typeof raw.place === 'string' && raw.place.trim()) node.place = raw.place.trim();
      if (Array.isArray(raw.aliases) && raw.aliases.length) {
        node.aliases = [...new Set(raw.aliases.map((a) => String(a).trim()).filter(Boolean))];
      }
      if (typeof raw.note === 'string' && raw.note.trim()) node.note = raw.note.trim();
    }
    if (nodes.size >= MAX_GRAPH_NODES) { truncatedNodes = true; break; }
    nodes.set(node.id, node);
  }

  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  let truncatedEdges = false;
  for (const e of base.edges) {
    if (edges.length >= MAX_GRAPH_EDGES) { truncatedEdges = true; break; }
    seen.add(`${e.source}|${e.kind}|${e.target}`);
    edges.push(e);
  }
  for (const raw of incoming.edges) {
    const source = typeof raw.source === 'string' ? raw.source.trim() : '';
    const target = typeof raw.target === 'string' ? raw.target.trim() : '';
    if (!source || !target || source === target) continue;
    if (!GRAPH_EDGE_KINDS.includes(raw.kind as GraphEdgeKind)) continue;
    const rs = resolveEndpoint(nodes, source);
    const rt = resolveEndpoint(nodes, target);
    if (!rs || !rt || rs === rt) continue;
    const key = `${rs}|${raw.kind}|${rt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (edges.length >= MAX_GRAPH_EDGES) { truncatedEdges = true; break; }
    const edge: GraphEdge = { source: rs, target: rt, kind: raw.kind as GraphEdgeKind };
    if (typeof raw.year === 'number') edge.year = raw.year;
    if (typeof raw.note === 'string' && raw.note.trim()) edge.note = raw.note.trim();
    edges.push(edge);
  }

  if (truncatedNodes || truncatedEdges) {
    console.warn(`[dsh-oral-history] 图谱超出上限（节点 ${MAX_GRAPH_NODES} / 边 ${MAX_GRAPH_EDGES}），已截断`);
  }
  if (stats) {
    stats.truncatedNodes = truncatedNodes;
    stats.truncatedEdges = truncatedEdges;
  }
  return { nodes: [...nodes.values()], edges };
}

/** 运行期可用的节点种类白名单（与 shared/types 的 GRAPH_NODE_KINDS 保持一致）。 */
const GRAPH_NODE_KINDS_SAFE: string[] = [
  'person', 'institution', 'artifact', 'event', 'concept', 'publication', 'place', 'source', 'card',
];

/** Subgraph containing one node and its N-hop neighbors. */
export function nodeSubgraph(graph: KnowledgeGraph, centerId: string, hops = 1): KnowledgeGraph {
  const center = graph.nodes.find((n) => n.id === centerId);
  if (!center) return EMPTY_GRAPH;
  const keep = new Set<string>([centerId]);
  let frontier = new Set<string>([centerId]);
  for (let h = 0; h < hops; h++) {
    const next = new Set<string>();
    for (const e of graph.edges) {
      if (frontier.has(e.source) && !keep.has(e.target)) { keep.add(e.target); next.add(e.target); }
      if (frontier.has(e.target) && !keep.has(e.source)) { keep.add(e.source); next.add(e.source); }
    }
    frontier = next;
    if (!frontier.size) break;
  }
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

/** 向后兼容别名。 */
export const conceptSubgraph = nodeSubgraph;

/**
 * 时间窗过滤：保留年代与窗口有交叠的节点。
 * 无年代信息的节点（如概念）默认保留——史学图谱中概念通常无确切年代，
 * 过滤掉会让图谱在任何一个时间窗内都空掉。
 */
export function timeWindowGraph(graph: KnowledgeGraph, from?: number, to?: number): KnowledgeGraph {
  if (from === undefined && to === undefined) return graph;
  const keep = new Set<string>();
  for (const n of graph.nodes) {
    const nf = n.yearFrom ?? n.yearTo;
    const nt = n.yearTo ?? n.yearFrom;
    if (nf === undefined) { keep.add(n.id); continue; }
    const lo = from ?? -Infinity;
    const hi = to ?? Infinity;
    if ((nt as number) >= lo && (nf as number) <= hi) keep.add(n.id);
  }
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

/* ==========================================================================
 * 文件名安全
 * ========================================================================== */

/** Windows 保留设备名（含扩展名前的主干命中也算，如 con.json）。 */
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function safeName(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return WIN_RESERVED.test(s) || WIN_RESERVED.test(s.split('.')[0] ?? '') ? `${s}_` : s;
}
export { safeName };

/**
 * rebuild 保护：现有规模较大（节点+边 > 20）而 incoming 总量不足现有 50% 时拒绝，
 * 防止模型幻觉（rebuild + 少量节点/空数组）一次性清空整个图谱。
 */
export function assertRebuildAllowed(existing: KnowledgeGraph, incomingTotal: number, force: boolean): void {
  if (force) return;
  const existingTotal = existing.nodes.length + existing.edges.length;
  if (existingTotal <= 20) return;
  if (incomingTotal * 2 >= existingTotal) return;
  throw new Error(
    `拒绝缩减型 rebuild：现有图谱 ${existing.nodes.length} 节点 + ${existing.edges.length} 边（共 ${existingTotal} 项），`
    + `提交仅 ${incomingTotal} 项（不足 50%）。如确要缩小重建请带 force=true 确认，或改用 append 增量合并`,
  );
}

/* ==========================================================================
 * Store
 * ========================================================================== */

export class OralHistoryStore {
  readonly dir: string;
  sources = new Map<string, Source>();
  interviews = new Map<string, Interview>();
  transcripts = new Map<string, Transcript>();
  cards = new Map<string, EvidenceCard>();
  collections = new Map<string, SourceCollection>();
  graph: KnowledgeGraph = EMPTY_GRAPH;
  /** init 期间跳过的损坏文件清单（相对路径），随 stats 暴露给面板告警。 */
  corruptFiles: string[] = [];
  private disposed = false;
  /** 实例级写互斥（promise 链）：串行化所有读-改-写，防止并发覆盖/撕裂文件。 */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  dispose(): void {
    this.disposed = true;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('存储目录已切换，请重试');
  }

  async init(): Promise<void> {
    const dirs = ['sources', 'interviews', 'transcripts', 'cards', 'attachments'];
    for (const d of dirs) await mkdir(join(this.dir, d), { recursive: true });

    this.sources = await this.loadDir<Source>('sources', (v) =>
      !!v && typeof v.id === 'string' && typeof v.title === 'string' && !!v.title && (v.tier === 'primary' || v.tier === 'secondary'));
    this.interviews = await this.loadDir<Interview>('interviews', (v) =>
      !!v && typeof v.id === 'string' && !!v.interviewee && typeof v.interviewee.name === 'string');
    this.transcripts = await this.loadDir<Transcript>('transcripts', (v) =>
      !!v && typeof v.id === 'string' && typeof v.interviewId === 'string' && Array.isArray(v.segments));
    this.cards = await this.loadDir<EvidenceCard>('cards', (v) =>
      !!v && typeof v.id === 'string' && typeof v.title === 'string' && !!v.title);

    // collections.json
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'collections.json'), 'utf8')) as SourceCollection[];
      if (Array.isArray(raw)) for (const c of raw) if (c && typeof c.id === 'string') this.collections.set(c.id, c);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.corruptFiles.push('collections.json');
        console.warn(`[dsh-oral-history] 跳过损坏的 collections.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // graph.json
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'graph.json'), 'utf8')) as KnowledgeGraph;
      if (raw && Array.isArray(raw.nodes) && Array.isArray(raw.edges)) this.graph = raw;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.corruptFiles.push('graph.json');
        console.warn(`[dsh-oral-history] 跳过损坏的 graph.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async loadDir<T>(sub: string, valid: (v: any) => boolean): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const dir = join(this.dir, sub);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      return out;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const v = JSON.parse(await readFile(join(dir, f), 'utf8'));
        if (valid(v)) out.set(v.id, v as T);
        else {
          this.corruptFiles.push(`${sub}/${f}`);
          console.warn(`[dsh-oral-history] ${sub}/${f} 结构不合法，已跳过`);
        }
      } catch (err) {
        this.corruptFiles.push(`${sub}/${f}`);
        console.warn(`[dsh-oral-history] 跳过损坏的 ${sub}/${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  /** Atomic JSON write: tmp file + rename. */
  private async writeJson(rel: string, value: unknown): Promise<void> {
    this.assertLive();
    const file = join(this.dir, rel);
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, file).catch(async (err: unknown) => {
      await unlink(tmp).catch(() => {});
      throw err;
    });
  }

  private async removeFile(rel: string): Promise<void> {
    this.assertLive();
    await unlink(join(this.dir, rel)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    });
  }

  /* ---------- sources ---------- */

  upsertSource(source: Source): Promise<void> {
    return this.withLock(async () => {
      this.sources.set(source.id, source);
      await this.writeJson(join('sources', `${safeName(source.id)}.json`), source);
      // 史料自动进图谱（source 节点，幂等）
      const patch = this.sourceNodePatch([source]);
      if (patch.nodes.length) {
        await this.mergeIntoGraph(patch);
      }
    });
  }

  /** 把启发式补丁并入图谱（内部使用，已在锁内）。 */
  private async mergeIntoGraph(patch: { nodes: GraphNode[]; edges: GraphEdge[] }, mode: 'append' | 'rebuild' = 'append'): Promise<void> {
    const merged = mergeGraph(
      this.graph,
      patch,
      mode,
      { sourceIds: new Set(this.sources.keys()), cardIds: new Set(this.cards.keys()) },
    );
    this.graph = merged;
    await this.writeJson('graph.json', merged);
  }

  deleteSource(id: string): Promise<void> {
    return this.withLock(async () => {
      this.sources.delete(id);
      await this.removeFile(join('sources', `${safeName(id)}.json`));
      // 级联：解除卡片与图谱中的引用（不删除卡片本身，只剥离来源）
      let cardsChanged = false;
      for (const c of this.cards.values()) {
        if (c.sourceId === id) {
          delete c.sourceId;
          c.updatedAt = Date.now();
          cardsChanged = true;
          await this.writeJson(join('cards', `${safeName(c.id)}.json`), c);
        }
      }
      void cardsChanged;
      const graph = { ...this.graph, nodes: this.graph.nodes.filter((n) => n.id !== id) };
      const alive = new Set(graph.nodes.map((n) => n.id));
      graph.edges = graph.edges.filter((e) => alive.has(e.source) && alive.has(e.target));
      this.graph = graph;
      await this.writeJson('graph.json', graph);
    });
  }

  /* ---------- interviews ---------- */

  upsertInterview(iv: Interview): Promise<void> {
    return this.withLock(async () => {
      this.interviews.set(iv.id, iv);
      await this.writeJson(join('interviews', `${safeName(iv.id)}.json`), iv);
      // 访谈自动进图谱（受访者人物 / 机构 / 地点，幂等）
      const patch = this.interviewSyncPatch([iv], [...this.sources.values()]);
      if (patch.nodes.length || patch.edges.length) {
        await this.mergeIntoGraph(patch);
      }
    });
  }

  deleteInterview(id: string): Promise<void> {
    return this.withLock(async () => {
      this.interviews.delete(id);
      await this.removeFile(join('interviews', `${safeName(id)}.json`));
      // 级联：其逐字稿一并删除
      for (const t of [...this.transcripts.values()]) {
        if (t.interviewId === id) {
          this.transcripts.delete(t.id);
          await this.removeFile(join('transcripts', `${safeName(t.id)}.json`));
        }
      }
      for (const c of this.cards.values()) {
        if (c.interviewId === id) {
          delete c.interviewId;
          c.updatedAt = Date.now();
          await this.writeJson(join('cards', `${safeName(c.id)}.json`), c);
        }
      }
    });
  }

  /* ---------- transcripts ---------- */

  upsertTranscript(t: Transcript): Promise<void> {
    return this.withLock(async () => {
      this.transcripts.set(t.id, t);
      await this.writeJson(join('transcripts', `${safeName(t.id)}.json`), t);
    });
  }

  deleteTranscript(id: string): Promise<void> {
    return this.withLock(async () => {
      this.transcripts.delete(id);
      await this.removeFile(join('transcripts', `${safeName(id)}.json`));
    });
  }

  /** Roll the verified-ratio counter from the current segment statuses. */
  recomputeVerifiedRatio(t: Transcript): void {
    const total = t.segments.length;
    if (!total) { t.verifiedRatio = 0; return; }
    const verified = t.segments.filter((s) => s.status === 'human-verified').length;
    t.verifiedRatio = Math.round((verified / total) * 1000) / 1000;
  }

  /* ---------- cards ---------- */

  upsertCard(card: EvidenceCard): Promise<void> {
    return this.withLock(async () => {
      this.cards.set(card.id, card);
      await this.writeJson(join('cards', `${safeName(card.id)}.json`), card);
      // 卡片自动进图谱（card 节点 + derived_from/related 边，幂等）
      const patch = this.cardSyncPatch([card], [...this.sources.values()]);
      if (patch.nodes.length || patch.edges.length) {
        await this.mergeIntoGraph(patch);
      }
    });
  }

  deleteCard(id: string): Promise<void> {
    return this.withLock(async () => {
      this.cards.delete(id);
      await this.removeFile(join('cards', `${safeName(id)}.json`));
      // 剥离其他卡片对它的关联
      for (const c of this.cards.values()) {
        if (c.relatedCardIds?.includes(id)) {
          c.relatedCardIds = c.relatedCardIds.filter((x) => x !== id);
          if (!c.relatedCardIds.length) delete c.relatedCardIds;
          c.updatedAt = Date.now();
          await this.writeJson(join('cards', `${safeName(c.id)}.json`), c);
        }
      }
      // 剥离图谱中的卡片节点
      const alive = new Set(this.graph.nodes.filter((n) => n.id !== id).map((n) => n.id));
      const graph: KnowledgeGraph = {
        nodes: this.graph.nodes.filter((n) => n.id !== id),
        edges: this.graph.edges.filter((e) => alive.has(e.source) && alive.has(e.target)),
      };
      this.graph = graph;
      await this.writeJson('graph.json', graph);
    });
  }

  /* ---------- collections ---------- */

  private async persistCollections(): Promise<void> {
    await this.writeJson('collections.json', [...this.collections.values()]);
  }

  /** Create collections for the given names, returning their ids (existing names reused). */
  ensureCollectionNames(names: string[]): Promise<string[]> {
    return this.withLock(async () => {
      const ids: string[] = [];
      let changed = false;
      for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;
        const existing = [...this.collections.values()].find((c) => c.name === name);
        if (existing) { ids.push(existing.id); continue; }
        const now = Date.now();
        const col: SourceCollection = { id: newCollectionId(), name, createdAt: now, updatedAt: now };
        this.collections.set(col.id, col);
        ids.push(col.id);
        changed = true;
      }
      if (changed) await this.persistCollections();
      return ids;
    });
  }

  upsertCollection(col: SourceCollection): Promise<void> {
    return this.withLock(async () => {
      this.collections.set(col.id, col);
      await this.persistCollections();
    });
  }

  deleteCollection(id: string): Promise<void> {
    return this.withLock(async () => {
      this.collections.delete(id);
      await this.persistCollections();
      // 从史料上剥离该分区（不删除史料）
      for (const s of this.sources.values()) {
        if (s.collectionIds?.includes(id)) {
          s.collectionIds = s.collectionIds.filter((x) => x !== id);
          if (!s.collectionIds.length) delete s.collectionIds;
          s.updatedAt = Date.now();
          await this.writeJson(join('sources', `${safeName(s.id)}.json`), s);
        }
      }
    });
  }

  /* ---------- graph ---------- */

  saveGraph(graph: KnowledgeGraph, backup = false): Promise<void> {
    return this.withLock(async () => {
      if (backup) {
        try {
          const cur = await readFile(join(this.dir, 'graph.json'), 'utf8');
          await writeFile(join(this.dir, 'graph.json.bak'), cur, 'utf8');
        } catch { /* 首次写入无备份可做 */ }
      }
      this.graph = graph;
      await this.writeJson('graph.json', graph);
    });
  }

  /* ---------- 启发式图谱同步（无 AI） ---------- */

  /**
   * 史料自动入图：每条史料建 source 节点。返回缺失部分，调用方经 mergeGraph 合并。
   * 幂等；标题变更时覆盖式刷新 label。
   */
  sourceNodePatch(sources: Source[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = new Map(this.graph.nodes.map((n) => [n.id, n]));
    const out: GraphNode[] = [];
    for (const s of sources) {
      const existing = nodes.get(s.id);
      if (!existing) {
        if (nodes.size >= MAX_GRAPH_NODES) continue;
        out.push({ id: s.id, kind: 'source', label: s.title });
      } else if (existing.kind === 'source' && existing.label !== s.title) {
        out.push({ id: s.id, kind: 'source', label: s.title });
      }
    }
    return { nodes: out, edges: [] };
  }

  /**
   * 访谈自动入图（无 AI）：受访者 → 人物节点；访谈者 → 人物节点 + 师承/同事边留待 AI；
   * 受访者机构 → 机构节点 + affiliated 边；访谈 → interviewed 关系由史料节点承载。
   * 只做确定性部分，语义关系仍靠 kg_extract。
   */
  interviewSyncPatch(interviews: Interview[], sources: Source[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = new Map(this.graph.nodes.map((n) => [n.id, n]));
    const seen = new Set(this.graph.edges.map((e) => `${e.source}|${e.kind}|${e.target}`));
    const sourceTitle = new Map(sources.map((s) => [s.id, s.title]));
    const outNodes: GraphNode[] = [];
    const outEdges: GraphEdge[] = [];
    const addNode = (n: GraphNode) => {
      if (nodes.size >= MAX_GRAPH_NODES) return;
      nodes.set(n.id, n);
      outNodes.push(n);
    };
    const addEdge = (source: string, target: string, kind: GraphEdgeKind) => {
      if (source === target) return;
      const key = `${source}|${kind}|${target}`;
      if (seen.has(key)) return;
      seen.add(key);
      outEdges.push({ source, target, kind });
    };

    for (const iv of interviews) {
      // 史料节点必须存在，访谈挂在其上
      if (iv.sourceId && sourceTitle.has(iv.sourceId) && !nodes.has(iv.sourceId)) {
        addNode({ id: iv.sourceId, kind: 'source', label: sourceTitle.get(iv.sourceId)! });
      }
      // 受访者人物节点
      const perId = graphNodeId(iv.interviewee.name, 'person');
      if (!nodes.has(perId)) {
        addNode({
          id: perId,
          kind: 'person',
          label: iv.interviewee.name,
          ...(iv.interviewee.birthYear !== undefined ? { yearFrom: iv.interviewee.birthYear } : {}),
          ...(iv.interviewee.deathYear !== undefined ? { yearTo: iv.interviewee.deathYear } : {}),
          ...(iv.interviewee.roles.length ? { note: iv.interviewee.roles.join('、') } : {}),
        });
      }
      // 受访者机构 → 机构节点 + affiliated 边
      for (const aff of iv.interviewee.affiliations) {
        if (!aff.trim()) continue;
        const insId = graphNodeId(aff, 'institution');
        if (!nodes.has(insId)) addNode({ id: insId, kind: 'institution', label: aff.trim() });
        addEdge(perId, insId, 'affiliated');
      }
      // 访谈地点 → 地点节点 + 发生于
      if (iv.location?.trim()) {
        const plcId = graphNodeId(iv.location, 'place');
        if (!nodes.has(plcId)) addNode({ id: plcId, kind: 'place', label: iv.location.trim() });
        if (iv.sourceId && nodes.has(iv.sourceId)) addEdge(iv.sourceId, plcId, 'related');
      }
    }
    return { nodes: outNodes, edges: outEdges };
  }

  /**
   * 考据卡自动入图（无 AI）：卡片 → card 节点；
   * derived_from 边指向来源史料；related 边连接相关卡片。
   */
  cardSyncPatch(cards: EvidenceCard[], sources: Source[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = new Map(this.graph.nodes.map((n) => [n.id, n]));
    const seen = new Set(this.graph.edges.map((e) => `${e.source}|${e.kind}|${e.target}`));
    const sourceTitle = new Map(sources.map((s) => [s.id, s.title]));
    const cardIds = new Set<string>([...cards.map((c) => c.id), ...this.cards.keys()]);
    const outNodes: GraphNode[] = [];
    const outEdges: GraphEdge[] = [];
    const addNode = (n: GraphNode) => {
      if (nodes.size >= MAX_GRAPH_NODES) return;
      nodes.set(n.id, n);
      outNodes.push(n);
    };
    const addEdge = (source: string, target: string, kind: GraphEdgeKind) => {
      if (source === target) return;
      const key = `${source}|${kind}|${target}`;
      if (seen.has(key)) return;
      seen.add(key);
      outEdges.push({ source, target, kind });
    };

    for (const c of cards) {
      const existing = nodes.get(c.id);
      if (!existing) addNode({ id: c.id, kind: 'card', label: c.title });
      else if (existing.kind === 'card' && existing.label !== c.title) {
        outNodes.push({ id: c.id, kind: 'card', label: c.title });
      }
      if (c.sourceId && sourceTitle.has(c.sourceId)) {
        if (!nodes.has(c.sourceId)) addNode({ id: c.sourceId, kind: 'source', label: sourceTitle.get(c.sourceId)! });
        addEdge(c.id, c.sourceId, 'derived_from');
      }
      for (const rid of c.relatedCardIds ?? []) {
        if (rid === c.id || !cardIds.has(rid)) continue;
        const [a, b] = [c.id, rid].sort();
        addEdge(a, b, 'related');
      }
    }
    return { nodes: outNodes, edges: outEdges };
  }

  /** 仅保留真实存在的卡片 id（用于关联字段）。 */
  filterExistingCardIds(ids: string[]): string[] {
    return [...new Set(ids.filter((x) => this.cards.has(x)))];
  }

  /** 仅保留真实存在的分区 id。 */
  filterExistingCollectionIds(ids: string[]): string[] {
    return [...new Set(ids.filter((id) => this.collections.has(id)))];
  }

  /** List collections ordered by creation. */
  listCollections(): SourceCollection[] {
    return [...this.collections.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /* ---------- stats ---------- */

  stats(): OralHistoryStats {
    let primary = 0;
    let secondary = 0;
    for (const s of this.sources.values()) (s.tier === 'primary' ? primary++ : secondary++);
    let segments = 0;
    let verifiedSegments = 0;
    for (const t of this.transcripts.values()) {
      segments += t.segments.length;
      verifiedSegments += t.segments.filter((s) => s.status === 'human-verified').length;
    }
    const graphNodeIds = new Set(this.graph.nodes.map((n) => n.id));
    const unsynced = [...this.sources.values()]
      .filter((s) => !graphNodeIds.has(s.id))
      .map((s) => ({ id: s.id, title: s.title }));

    return {
      sources: this.sources.size,
      primary,
      secondary,
      interviews: this.interviews.size,
      transcripts: this.transcripts.size,
      segments,
      verifiedSegments,
      cards: this.cards.size,
      nodes: this.graph.nodes.length,
      edges: this.graph.edges.length,
      dir: this.dir,
      unsynced,
      corruptFiles: this.corruptFiles.length ? [...this.corruptFiles] : undefined,
    };
  }
}
