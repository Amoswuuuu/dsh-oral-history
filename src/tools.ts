/**
 * dsh-oral-history — agent-facing tools (registered via ctx.tools.register).
 *
 * These are what let the conversation model build the archive on the user's
 * behalf: file sources, create interview records, write and correct
 * transcripts, capture evidence cards, and build the genealogy graph.
 * All AI-generated content arrives as structured tool arguments (validated by
 * defineTool), is checked against the store, and is persisted locally.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type {
  CardKind, CardStatus, EvidenceCard, GlossaryEntry, GraphEdge, GraphNode, GraphNodeKind,
  OralHistoryConfig, SegmentStatus, Source, SourceStatus, SpeakerRole, Transcript,
} from './shared/types.js';
import {
  CARD_KINDS, CARD_STATUSES, EVIDENCE_GRADES, GRAPH_EDGE_KINDS, GRAPH_NODE_KINDS,
  PRIMARY_KINDS, SECONDARY_KINDS, SEGMENT_STATUSES, SOURCE_STATUSES, SOURCE_TIERS, SPEAKER_ROLES,
} from './shared/types.js';
import type { OralHistoryStore } from './store.js';
import { assertRebuildAllowed, filterCards, filterInterviews, filterSources, mergeGraph, nodeSubgraph, safeName } from './store.js';
import type { GraphMergeStats } from './store.js';
import {
  appendSegments, applyCardPatch, applyGlossary, applyInterviewPatch, applySegmentPatch,
  applySourcePatch, createCard, createInterview, createSource, createTranscript,
  findDuplicateSource, findSimilarCards,
} from './domain.js';
import { fetchMetadata } from './metadata.js';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const renderJson = (_args: unknown, value: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
];

/** Deep-clone a value into plain JSON (drops `undefined`) so entities satisfy JsonValue. */
const toJson = (v: unknown): any => JSON.parse(JSON.stringify(v));

const int = (n: number | undefined, min: number, max: number): number | undefined => {
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`数值必须在 ${min}-${max} 之间`);
  return n;
};

/* ---------- conversation card presentation ---------- */

const callView = (title: string, rawInput?: unknown) => ({
  card: 'generic' as const,
  title,
  kind: 'other' as const,
  ...(rawInput !== undefined ? { rawInput } : {}),
});

const resultView = (title: string, md: string) => ({
  card: 'generic' as const,
  title,
  content: [{ type: 'text', text: md } as ContentBlock],
});

const TIER_LABELS: Record<string, string> = { primary: '一手', secondary: '二手' };
const SEG_STATUS_LABELS: Record<string, string> = {
  raw: '未校', 'ai-corrected': 'AI修正', 'human-verified': '已听校', uncertain: '存疑', inaudible: '无法辨听',
};

const mdSource = (s: Record<string, any>): string => {
  if (!s || !s.title) return '';
  const kind = s.tier === 'primary' ? s.primaryKind : s.secondaryKind;
  const meta = [
    TIER_LABELS[s.tier] ?? s.tier,
    kind,
    s.year,
    s.provenance?.repository,
    s.provenance?.callNumber,
    s.temporal?.originalEra,
  ].filter(Boolean).join(' · ');
  const tags = (s.tags ?? []).length ? (s.tags as string[]).map((x) => `#${x}`).join(' ') : '';
  const stars = s.importance ? `重要度 ${'★'.repeat(s.importance)}` : '';
  const grade = s.evidenceGrade ? `证据等级 ${s.evidenceGrade}` : '';
  return [`**${s.title}**`, meta, [tags, [stars, grade].filter(Boolean).join(' · ')].filter(Boolean).join('  ')]
    .filter(Boolean).join('\n');
};

const mdCard = (c: Record<string, any>): string => {
  if (!c || !c.title) return '';
  const meta = [c.kind, c.status, c.citation].filter(Boolean).join(' · ');
  const tags = (c.tags ?? []).length ? (c.tags as string[]).map((x) => `#${x}`).join(' ') : '';
  return [`**${c.title}**`, meta, tags].filter(Boolean).join('\n');
};

const mdList = (items: string[], more = 0): string =>
  items.join('\n') + (more > 0 ? `\n_…另有 ${more} 条未列出_` : '');

function candidateList(sources: Source[]): { id: string; title: string }[] {
  return sources.slice(0, 5).map((s) => ({ id: s.id, title: s.title }));
}

function findSourceCandidates(store: OralHistoryStore, key: string): Source[] {
  const k = key.trim();
  if (!k) return [];
  const direct = store.sources.get(k);
  if (direct) return [direct];
  return filterSources([...store.sources.values()], { q: k });
}

/** 枚举值校验：给出非法值时返回可选值清单（帮模型自我纠正）。 */
function validateEnum<T extends readonly string[]>(arr: T, v: unknown, label: string): T[number] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (arr as readonly string[]).includes(v)) return v as T[number];
  throw new Error(`${label} 非法值 "${String(v)}"，可选：${arr.join(' / ')}`);
}

/** 枚举值清单注入工具描述，避免模型凭记忆臆造。 */
const enumDoc = (arr: readonly string[]) => arr.join('|');

export function registerOralHistoryTools(
  ctx: Context,
  getStore: () => Promise<OralHistoryStore>,
  getConfig: () => OralHistoryConfig,
): number {
  let toolCount = 0;
  ctx.effect(() => {
    const disposers = [

      /* ================= 1. source_save ================= */
      ctx.tools.register(defineTool({
        name: 'source_save',
        description:
          '把一条史料保存进口述史工作台的史料库。用户要求"保存这条史料/把这份档案入库"时调用。'
          + `tier 必填：primary=一手史料（口述访谈录音、档案原件、手稿、古籍、历史报刊、专利、器物、照片、书信、实验记录）；`
          + `secondary=二手研究（期刊论文、专著、编著、学位论文、综述、工具书）。`
          + `primaryKind 可选值：${enumDoc(PRIMARY_KINDS)}；secondaryKind 可选值：${enumDoc(SECONDARY_KINDS)}。`
          + '一手史料请务必填写 provenance（repository 收藏机构 / callNumber 馆藏号 / edition 版本 / medium 载体）——'
          + '馆藏号是比 DOI 更可靠的去重键；以及 temporal（eventYearFrom/To 所记事件年代、originalEra 原始纪年如"康熙二十三年"）。'
          + '已在库中（馆藏号/DOI/标题命中）时默认不覆盖并返回已存在记录；update=true 时合并更新。'
          + 'tags 给 2-5 个标签；summary 给一句话说明这条史料讲了什么、为什么重要。',
        parameters: {
          title: { type: 'string', required: true, description: '史料标题' },
          tier: { type: 'string', required: true, description: `史料轨道：${enumDoc(SOURCE_TIERS)}（primary=一手 / secondary=二手）` },
          primaryKind: { type: 'string', description: `一手史料载体类型：${enumDoc(PRIMARY_KINDS)}` },
          secondaryKind: { type: 'string', description: `二手研究类型：${enumDoc(SECONDARY_KINDS)}` },
          authors: { type: 'array', items: { type: 'string' }, description: '一手史料填历史作者/口述者；二手研究填现代作者' },
          temporal: { type: 'json', description: '时间定位：{eventYearFrom, eventYearTo, createdYearFrom, createdYearTo, originalEra}（originalEra 保留原始纪年原文）' },
          provenance: { type: 'json', description: '馆藏信息：{repository, callNumber, edition, medium, accessNote, digitizationNote}' },
          doi: { type: 'string', description: 'DOI（仅二手研究通常有）' },
          venue: { type: 'string', description: '期刊/会议/出版社' },
          year: { type: 'integer', description: '出版/成书年份' },
          language: { type: 'string', description: '语种' },
          url: { type: 'string', description: '链接' },
          abstract: { type: 'string', description: '摘要或内容提要' },
          summary: { type: 'string', description: '一句话说明这条史料的内容与价值' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，如 口述史、计算机史、三线建设' },
          importance: { type: 'integer', description: '重要度 1-5（默认 3）' },
          status: { type: 'string', description: `整理状态：${enumDoc(SOURCE_STATUSES)}` },
          evidenceGrade: { type: 'string', description: `证据等级：${enumDoc(EVIDENCE_GRADES)}` },
          notes: { type: 'string', description: '备注' },
          update: { type: 'boolean', description: '已存在时是否合并更新（默认 false）' },
          collections: { type: 'array', items: { type: 'string' }, description: '收集分区名称列表；不存在的分区自动创建' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              created: { type: 'boolean' },
              duplicate: { type: 'boolean' },
              updated: { type: 'boolean' },
              source: { type: 'json' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`保存史料：${String(args.title ?? '').slice(0, 32)}`, {
          tier: args.tier, primaryKind: args.primaryKind, tags: args.tags,
        }),
        presentResult: (args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          const s: any = v.source ?? {};
          const state = v.updated ? '已合并更新' : v.created ? '已入库' : '已在库中';
          const hint = v.duplicate && !v.updated ? '_该史料已在库中；update=true 可合并更新_' : '';
          return resultView(`${state}：${String(s.title ?? '').slice(0, 32)}`, [mdSource(s), hint].filter(Boolean).join('\n'));
        },
        async execute(args: any) {
          const store = await getStore();
          const tier = validateEnum(SOURCE_TIERS, args.tier, 'tier');
          if (!tier) throw new Error('tier 必填：primary（一手）或 secondary（二手）');
          const year = int(args.year, 1000, 2200);
          const importance = int(args.importance, 1, 5);
          const colIds = Array.isArray(args.collections)
            ? await store.ensureCollectionNames(args.collections as string[])
            : undefined;
          const patch = {
            ...args,
            tier,
            year,
            importance,
            primaryKind: validateEnum(PRIMARY_KINDS, args.primaryKind, 'primaryKind'),
            secondaryKind: validateEnum(SECONDARY_KINDS, args.secondaryKind, 'secondaryKind'),
            status: validateEnum(SOURCE_STATUSES, args.status, 'status'),
            evidenceGrade: validateEnum(EVIDENCE_GRADES, args.evidenceGrade, 'evidenceGrade'),
            ...(colIds !== undefined && colIds.length ? { collectionIds: colIds } : {}),
          };
          const dup = findDuplicateSource(store.sources.values(), {
            title: args.title,
            doi: args.doi,
            provenance: args.provenance,
          });
          if (dup) {
            if (args.update) {
              const next = applySourcePatch(dup, patch as never);
              await store.upsertSource(next);
              return { ok: true, created: false, duplicate: true, updated: true, source: toJson(next) };
            }
            return { ok: true, created: false, duplicate: true, updated: false, source: toJson(dup) };
          }
          const tags = [...new Set([...(getConfig().defaultTags ?? []), ...(args.tags ?? [])])];
          const src = createSource({ ...patch, tags, source: 'agent' } as never);
          await store.upsertSource(src);
          return { ok: true, created: true, duplicate: false, updated: false, source: toJson(src) };
        },
      })),

      /* ================= 2. source_update ================= */
      ctx.tools.register(defineTool({
        name: 'source_update',
        description:
          '更新史料库中一条已有史料的元数据。只更新提供的字段。'
          + '用户说"把这条移到 XX 分区/补上馆藏号/改重要度"等场景使用，id 可用 source_search 查到。',
        parameters: {
          id: { type: 'string', required: true, description: '史料 id' },
          title: { type: 'string', description: '新标题' },
          tier: { type: 'string', description: `史料轨道：${enumDoc(SOURCE_TIERS)}` },
          primaryKind: { type: 'string', description: `一手史料载体类型：${enumDoc(PRIMARY_KINDS)}` },
          secondaryKind: { type: 'string', description: `二手研究类型：${enumDoc(SECONDARY_KINDS)}` },
          authors: { type: 'array', items: { type: 'string' }, description: '作者列表（整体替换）' },
          temporal: { type: 'json', description: '时间定位对象（整体替换）' },
          provenance: { type: 'json', description: '馆藏信息对象（整体替换）' },
          summary: { type: 'string', description: '一句话说明' },
          abstract: { type: 'string', description: '摘要' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签（整体替换）' },
          importance: { type: 'integer', description: '重要度 1-5' },
          status: { type: 'string', description: `整理状态：${enumDoc(SOURCE_STATUSES)}` },
          evidenceGrade: { type: 'string', description: `证据等级：${enumDoc(EVIDENCE_GRADES)}` },
          language: { type: 'string', description: '语种' },
          notes: { type: 'string', description: '备注' },
          collections: { type: 'array', items: { type: 'string' }, description: '分区名列表（整体替换，空数组清空）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, source: { type: 'json' } } },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`更新史料：${String(args.id ?? '').slice(0, 32)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          return resultView(`已更新：${String(v.source?.title ?? '').slice(0, 32)}`, mdSource(v.source ?? {}));
        },
        async execute(args: any) {
          const store = await getStore();
          const cur = store.sources.get(String(args.id));
          if (!cur) throw new Error(`史料不存在: ${args.id}`);
          const colIds = Array.isArray(args.collections)
            ? await store.ensureCollectionNames(args.collections as string[])
            : undefined;
          const next = applySourcePatch(cur, {
            ...args,
            importance: int(args.importance, 1, 5),
            primaryKind: validateEnum(PRIMARY_KINDS, args.primaryKind, 'primaryKind'),
            secondaryKind: validateEnum(SECONDARY_KINDS, args.secondaryKind, 'secondaryKind'),
            status: validateEnum(SOURCE_STATUSES, args.status, 'status'),
            evidenceGrade: validateEnum(EVIDENCE_GRADES, args.evidenceGrade, 'evidenceGrade'),
            ...(colIds !== undefined ? { collectionIds: args.collections.length ? colIds : [] } : {}),
          } as never);
          await store.upsertSource(next);
          return { ok: true, source: toJson(next) };
        },
      })),

      /* ================= 3. source_search ================= */
      ctx.tools.register(defineTool({
        name: 'source_search',
        description:
          '在本地史料库中检索史料。返回精简字段（id/标题/轨道/类型/年代/标签/馆藏/说明）。'
          + '关键词可匹配标题/作者/摘要/标签/馆藏机构/馆藏号/原始纪年。'
          + 'tier=primary 只看一手史料，tier=secondary 只看二手研究。'
          + 'eventYearFrom/eventYearTo 按"史料所记事件的年代"筛选（不同于 year 出版年）——'
          + '这是科技史检索最常用的维度。',
        parameters: {
          q: { type: 'string', description: '关键词' },
          tier: { type: 'string', description: `史料轨道：${enumDoc(SOURCE_TIERS)}` },
          primaryKind: { type: 'string', description: `一手史料载体类型：${enumDoc(PRIMARY_KINDS)}` },
          tag: { type: 'string', description: '按标签精确筛选' },
          yearFrom: { type: 'integer', description: '出版/成书年份下限' },
          yearTo: { type: 'integer', description: '出版/成书年份上限' },
          eventYearFrom: { type: 'integer', description: '所记事件年代下限' },
          eventYearTo: { type: 'integer', description: '所记事件年代上限' },
          status: { type: 'string', description: `整理状态：${enumDoc(SOURCE_STATUSES)}` },
          evidenceGrade: { type: 'string', description: `证据等级：${enumDoc(EVIDENCE_GRADES)}` },
          language: { type: 'string', description: '语种' },
          limit: { type: 'integer', description: '返回上限（默认 10，最大 50）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, total: { type: 'integer' }, sources: { type: 'json' } } },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`检索史料：${String(args.q ?? args.tier ?? '全部').slice(0, 30)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          const items = (v.sources ?? []) as any[];
          const md = items.length ? mdList(items.map((s) => `- ${mdSource(s).split('\n')[0]} \`${s.id}\``)) : '_没有匹配的史料_';
          return resultView(`史料检索：${v.total ?? 0} 条`, md);
        },
        async execute(args: any) {
          const store = await getStore();
          const limit = Math.min(Math.max(int(args.limit, 1, 50) ?? 10, 1), 50);
          const list = filterSources([...store.sources.values()], {
            q: args.q,
            tier: validateEnum(SOURCE_TIERS, args.tier, 'tier'),
            primaryKind: validateEnum(PRIMARY_KINDS, args.primaryKind, 'primaryKind'),
            tag: args.tag,
            yearFrom: int(args.yearFrom, 1000, 2200),
            yearTo: int(args.yearTo, 1000, 2200),
            eventYearFrom: int(args.eventYearFrom, -3000, 2200),
            eventYearTo: int(args.eventYearTo, -3000, 2200),
            status: validateEnum(SOURCE_STATUSES, args.status, 'status'),
            evidenceGrade: validateEnum(EVIDENCE_GRADES, args.evidenceGrade, 'evidenceGrade'),
            language: args.language,
          });
          const slim = list.slice(0, limit).map((s) => ({
            id: s.id, title: s.title, tier: s.tier,
            kind: s.tier === 'primary' ? s.primaryKind : s.secondaryKind,
            year: s.year, eventYear: s.temporal?.eventYearFrom,
            originalEra: s.temporal?.originalEra,
            repository: s.provenance?.repository, callNumber: s.provenance?.callNumber,
            status: s.status, evidenceGrade: s.evidenceGrade,
            tags: s.tags, summary: s.summary,
          }));
          return { ok: true, total: list.length, sources: toJson(slim) };
        },
      })),

      /* ================= 4. source_get ================= */
      ctx.tools.register(defineTool({
        name: 'source_get',
        description: '读取史料库中单条史料的完整记录（含时间定位、馆藏信息、摘要、备注），以及关联的访谈与考据卡。',
        parameters: { id: { type: 'string', required: true, description: '史料 id 或标题关键词' } },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' }, source: { type: 'json' },
              interviews: { type: 'json' }, cards: { type: 'json' },
              error: { type: 'string' }, candidates: { type: 'json' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`读取史料：${String(args.id ?? '').slice(0, 32)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          if (v.error) return resultView('未找到史料', v.error);
          return resultView(`史料详情：${String(v.source?.title ?? '').slice(0, 30)}`, mdSource(v.source ?? {}));
        },
        async execute(args: any) {
          const store = await getStore();
          const hits = findSourceCandidates(store, String(args.id));
          if (!hits.length) return { ok: false, error: `未找到史料: ${args.id}` };
          if (hits.length > 1) {
            return { ok: false, error: `关键词有歧义，命中 ${hits.length} 条，请改用精确 id`, candidates: candidateList(hits) };
          }
          const s = hits[0];
          const interviews = [...store.interviews.values()].filter((iv) => iv.sourceId === s.id);
          const cards = filterCards([...store.cards.values()], { sourceId: s.id });
          return {
            ok: true,
            source: toJson(s),
            interviews: toJson(interviews),
            cards: toJson(cards.map((c) => ({ id: c.id, title: c.title, kind: c.kind, status: c.status }))),
          };
        },
      })),

      /* ================= 5. source_fetch_meta ================= */
      ctx.tools.register(defineTool({
        name: 'source_fetch_meta',
        description:
          '按 DOI 或 arXiv 编号联网抓取二手研究的元数据（标题/作者/年份/期刊/摘要），用于填表或核对。'
          + '仅适用于现代学术文献；一手史料（档案、手稿、口述录音）没有 DOI，请人工录入馆藏信息。',
        parameters: { input: { type: 'string', required: true, description: 'DOI、doi.org 链接、arXiv 编号或 arXiv 链接' } },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, meta: { type: 'json' }, error: { type: 'string' } } },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`抓取元数据：${String(args.input ?? '').slice(0, 30)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          if (v.error) return resultView('抓取失败', v.error);
          return resultView(`元数据：${String(v.meta?.title ?? '').slice(0, 30)}`, mdSource({ ...v.meta, tier: 'secondary' }));
        },
        async execute(args: any) {
          try {
            const meta = await fetchMetadata(String(args.input), getConfig().fetchProxy || undefined);
            return { ok: true, meta: toJson(meta) };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      })),

      /* ================= 6. interview_save ================= */
      ctx.tools.register(defineTool({
        name: 'interview_save',
        description:
          '为一条已入库的口述史史料建立访谈档案（受访者、访谈者、时间地点、录音技术信息）。'
          + '已有访谈时带 interviewId 则合并更新。'
          + 'interviewee 必填 name；建议同时补齐 birthYear/deathYear（史学惯例）、roles（身份）、'
          + 'affiliations（历史任职机构，可多条）、fields（研究领域）、bio（人物小传）。'
          + 'recording 记录原始载体（如"开盘磁带"）、录音年代、数字化格式、音质问题——'
          + '这些直接决定转录难度，务必如实填写。',
        parameters: {
          sourceId: { type: 'string', required: true, description: '关联的史料 id（须已 source_save 入库）' },
          interviewId: { type: 'string', description: '已有访谈 id（提供则合并更新而非新建）' },
          interviewee: { type: 'json', required: true, description: '受访者：{name, birthYear, deathYear, roles[], affiliations[], fields[], bio}' },
          interviewers: { type: 'json', description: '访谈者数组：[{name, affiliation}]' },
          interviewYear: { type: 'integer', description: '访谈年份' },
          interviewDate: { type: 'string', description: '访谈日期（可精确到日）' },
          location: { type: 'string', description: '访谈地点' },
          recording: { type: 'json', description: '录音信息：{originalMedium, recordedYear, digitalFormat, sampleRate, durationSeconds, qualityNote}' },
          audioPath: { type: 'string', description: '音频附件相对路径（attachments/xxx），上传后在详情页设置' },
          questionOutline: { type: 'string', description: '访谈提纲/已问问题' },
          backgroundNotes: { type: 'string', description: '背景知识补充（课题组整理）' },
          publicationNote: { type: 'string', description: '出版与授权状态' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, created: { type: 'boolean' }, interview: { type: 'json' } } },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`访谈建档：${String(args.interviewee?.name ?? args.sourceId ?? '').slice(0, 28)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          const iv: any = v.interview ?? {};
          const ie: any = iv.interviewee ?? {};
          const md = [
            `**${ie.name ?? ''}**`,
            [ie.roles?.join('、'), ie.affiliations?.join('、'), ie.fields?.join('、')].filter(Boolean).join(' · '),
            [iv.interviewDate ?? iv.interviewYear, iv.location].filter(Boolean).join(' · '),
            iv.recording?.originalMedium ? `原始载体：${iv.recording.originalMedium}` : '',
          ].filter(Boolean).join('\n');
          return resultView(`${v.created ? '已建档' : '已更新'}：${ie.name ?? ''}`, md);
        },
        async execute(args: any) {
          const store = await getStore();
          const sourceId = String(args.sourceId);
          if (!store.sources.has(sourceId)) {
            throw new Error(`史料不存在: ${sourceId}（请先 source_save 建史料，再把访谈挂上去）`);
          }
          if (args.interviewId) {
            const cur = store.interviews.get(String(args.interviewId));
            if (!cur) throw new Error(`访谈不存在: ${args.interviewId}`);
            const next = applyInterviewPatch(cur, args as never);
            await store.upsertInterview(next);
            return { ok: true, created: false, interview: toJson(next) };
          }
          const iv = createInterview(args as never);
          await store.upsertInterview(iv);
          const src = store.sources.get(sourceId);
          if (src && !src.interviewId) {
            await store.upsertSource({ ...src, interviewId: iv.id, updatedAt: Date.now() });
          }
          return { ok: true, created: true, interview: toJson(iv) };
        },
      })),

      /* ================= 7. interview_search ================= */
      ctx.tools.register(defineTool({
        name: 'interview_search',
        description:
          '检索已建档的口述访谈。可按受访者姓名、研究领域、任职机构、访谈年份区间筛选，'
          + '或按关键词匹配受访者小传/地点/录音信息。返回访谈 id、受访者信息、访谈时间地点、校对进度。',
        parameters: {
          q: { type: 'string', description: '关键词' },
          interviewee: { type: 'string', description: '受访者姓名关键词' },
          field: { type: 'string', description: '研究领域关键词' },
          affiliation: { type: 'string', description: '任职机构关键词' },
          yearFrom: { type: 'integer', description: '访谈年份下限' },
          yearTo: { type: 'integer', description: '访谈年份上限' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, total: { type: 'integer' }, interviews: { type: 'json' } } },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`检索访谈：${String(args.interviewee ?? args.q ?? '全部').slice(0, 28)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          const items = (v.interviews ?? []) as any[];
          const md = items.length
            ? mdList(items.map((iv) => `- **${iv.interviewee?.name}** ${[iv.interviewYear, iv.location].filter(Boolean).join(' · ')} \`${iv.id}\``))
            : '_没有匹配的访谈_';
          return resultView(`访谈检索：${v.total ?? 0} 条`, md);
        },
        async execute(args: any) {
          const store = await getStore();
          const list = filterInterviews([...store.interviews.values()], {
            q: args.q,
            interviewee: args.interviewee,
            field: args.field,
            affiliation: args.affiliation,
            yearFrom: int(args.yearFrom, 1900, 2200),
            yearTo: int(args.yearTo, 1900, 2200),
          });
          const slim = list.map((iv) => {
            const t = [...store.transcripts.values()].find((x) => x.interviewId === iv.id);
            return {
              id: iv.id, sourceId: iv.sourceId,
              interviewee: iv.interviewee,
              interviewers: iv.interviewers,
              interviewYear: iv.interviewYear, interviewDate: iv.interviewDate, location: iv.location,
              recording: iv.recording,
              transcriptId: t?.id, segments: t?.segments.length ?? 0, verifiedRatio: t?.verifiedRatio,
            };
          });
          return { ok: true, total: list.length, interviews: toJson(slim) };
        },
      })),

      /* ================= 8. interview_get ================= */
      ctx.tools.register(defineTool({
        name: 'interview_get',
        description: '读取一份访谈档案的完整信息，含受访者档案、录音信息、逐字稿校对进度与分段统计。',
        parameters: { id: { type: 'string', required: true, description: '访谈 id' } },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, interview: { type: 'json' }, transcript: { type: 'json' }, source: { type: 'json' }, error: { type: 'string' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`读取访谈：${String(args.id ?? '').slice(0, 30)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          if (v.error) return resultView('未找到访谈', v.error);
          const ie: any = v.interview?.interviewee ?? {};
          const t: any = v.transcript;
          const md = [
            `**${ie.name ?? ''}**`,
            ie.bio ?? '',
            t ? `逐字稿 ${t.segments?.length ?? 0} 段，校对进度 ${Math.round((t.verifiedRatio ?? 0) * 100)}%` : '_尚无逐字稿_',
          ].filter(Boolean).join('\n\n');
          return resultView(`访谈：${ie.name ?? ''}`, md);
        },
        async execute(args: any) {
          const store = await getStore();
          const iv = store.interviews.get(String(args.id));
          if (!iv) return { ok: false, error: `访谈不存在: ${args.id}` };
          const t = [...store.transcripts.values()].find((x) => x.interviewId === iv.id) ?? null;
          return {
            ok: true,
            interview: toJson(iv),
            transcript: t
              ? toJson({
                id: t.id, language: t.language, segmentCount: t.segments.length,
                verifiedRatio: t.verifiedRatio, glossary: t.glossary,
                statusCounts: t.segments.reduce((acc: Record<string, number>, s) => {
                  acc[s.status] = (acc[s.status] ?? 0) + 1;
                  return acc;
                }, {}),
              })
              : null,
            source: toJson(store.sources.get(iv.sourceId) ?? null),
          };
        },
      })),

      /* ================= 9. transcript_save ================= */
      ctx.tools.register(defineTool({
        name: 'transcript_save',
        description:
          '写入或追加口述访谈逐字稿分段。每段必须含 start/end（秒）与 text。'
          + '机器转录结果一律先以 status=raw 存入；AI 依据上下文与术语表修正后置为 ai-corrected；'
          + '只有人工听校确认的段落才能标 human-verified。听不清的段落标 inaudible 并在 note 说明，'
          + '**严禁凭推测编造内容**。'
          + 'segmentId + patch 用于修正单个既有分段（建议对 ai-corrected 段落填 confidence 0-1 表达把握程度）。'
          + '既有逐字稿时默认追加分段；未提供 interviewId 时按 interviewId 查找已有稿。',
        parameters: {
          interviewId: { type: 'string', required: true, description: '访谈 id' },
          language: { type: 'string', description: '语种' },
          segments: { type: 'json', description: '分段数组：[{start, end, speaker, speakerLabel, text, rawText, status, confidence, note, entityIds}]' },
          segmentId: { type: 'string', description: '要修正的既有分段 id（与 patch 配合使用）' },
          patch: { type: 'json', description: '分段修正：{text, status, confidence, note, speaker, speakerLabel, entityIds}' },
          glossary: { type: 'json', description: '整体替换术语表：[{term, variants[], kind, note}]' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' }, created: { type: 'boolean' }, transcriptId: { type: 'string' },
              segments: { type: 'integer' }, verifiedRatio: { type: 'number' }, error: { type: 'string' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(
          args.segmentId ? `修正分段：${String(args.segmentId).slice(0, 24)}` : `写入逐字稿：${Array.isArray(args.segments) ? args.segments.length : 0} 段`,
        ),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          if (v.error) return resultView('写入失败', v.error);
          const md = `分段总数：${v.segments ?? 0}\n校对进度：${Math.round((v.verifiedRatio ?? 0) * 100)}%`;
          return resultView(v.created ? '逐字稿已建立' : '逐字稿已更新', md);
        },
        async execute(args: any) {
          const store = await getStore();
          const interviewId = String(args.interviewId);
          const iv = store.interviews.get(interviewId);
          if (!iv) throw new Error(`访谈不存在: ${interviewId}`);
          let t = [...store.transcripts.values()].find((x) => x.interviewId === interviewId);

          // 修正单段
          if (args.segmentId) {
            if (!t) throw new Error('该访谈尚无逐字稿，无法修正分段');
            const patch = args.patch ?? {};
            const next = applySegmentPatch(t, String(args.segmentId), {
              ...patch,
              status: validateEnum(SEGMENT_STATUSES, patch.status, 'status') as SegmentStatus | undefined,
              speaker: validateEnum(SPEAKER_ROLES, patch.speaker, 'speaker') as SpeakerRole | undefined,
            }, Date.now());
            store.recomputeVerifiedRatio(next);
            await store.upsertTranscript(next);
            return { ok: true, created: false, transcriptId: next.id, segments: next.segments.length, verifiedRatio: next.verifiedRatio };
          }

          // 整体替换术语表
          if (args.glossary !== undefined) {
            if (!t) throw new Error('该访谈尚无逐字稿，无法设置术语表');
            const next = { ...t, glossary: Array.isArray(args.glossary) ? args.glossary : [], updatedAt: Date.now() };
            await store.upsertTranscript(next);
            return { ok: true, created: false, transcriptId: next.id, segments: next.segments.length, verifiedRatio: next.verifiedRatio };
          }

          if (!Array.isArray(args.segments) || !args.segments.length) {
            throw new Error('需要提供 segments 数组，或 segmentId+patch，或 glossary');
          }

          if (t) {
            const next = appendSegments(t, args.segments, Date.now());
            store.recomputeVerifiedRatio(next);
            await store.upsertTranscript(next);
            return { ok: true, created: false, transcriptId: next.id, segments: next.segments.length, verifiedRatio: next.verifiedRatio };
          }
          t = createTranscript({
            interviewId,
            sourceId: iv.sourceId,
            language: args.language ?? getConfig().defaultLanguage,
            segments: args.segments,
          });
          store.recomputeVerifiedRatio(t);
          await store.upsertTranscript(t);
          await store.upsertInterview({ ...iv, transcriptId: t.id, updatedAt: Date.now() });
          return { ok: true, created: true, transcriptId: t.id, segments: t.segments.length, verifiedRatio: t.verifiedRatio };
        },
      })),

      /* ================= 10. transcript_get ================= */
      ctx.tools.register(defineTool({
        name: 'transcript_get',
        description:
          '读取访谈逐字稿。默认返回全部段落的完整文本（含时间戳、说话人、校对状态、存疑备注），'
          + '供对话中精读、引用与考据。段落多时可先用 status 只取未校对/存疑的段落。'
          + 'range 可按秒取一段（如只读 300-600 秒区间）。',
        parameters: {
          interviewId: { type: 'string', required: true, description: '访谈 id' },
          status: { type: 'string', description: `只取该状态的段落：${enumDoc(SEGMENT_STATUSES)}` },
          rangeStart: { type: 'integer', description: '起始秒' },
          rangeEnd: { type: 'integer', description: '结束秒' },
          withRaw: { type: 'boolean', description: '是否附带机器转录原文 rawText（默认 false）' },
          limit: { type: 'integer', description: '段落上限（默认 200，最大 1000）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' }, transcriptId: { type: 'string' }, total: { type: 'integer' },
              returned: { type: 'integer' }, verifiedRatio: { type: 'number' }, glossary: { type: 'json' },
              segments: { type: 'json' }, error: { type: 'string' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`读取逐字稿：${String(args.interviewId ?? '').slice(0, 26)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          if (v.error) return resultView('未找到逐字稿', v.error);
          const segs = (v.segments ?? []) as any[];
          const body = segs.slice(0, 12).map((s) => {
            const mm = String(Math.floor(s.start / 60)).padStart(2, '0');
            const ss = String(Math.floor(s.start % 60)).padStart(2, '0');
            return `[${mm}:${ss}] ${s.speakerLabel ?? s.speaker}：${String(s.text).slice(0, 80)}`;
          }).join('\n');
          return resultView(`逐字稿：${v.returned ?? 0}/${v.total ?? 0} 段`, body + (segs.length > 12 ? '\n_…_': ''));
        },
        async execute(args: any) {
          const store = await getStore();
          const t = [...store.transcripts.values()].find((x) => x.interviewId === String(args.interviewId));
          if (!t) return { ok: false, error: `该访谈尚无逐字稿: ${args.interviewId}` };
          const limit = Math.min(Math.max(int(args.limit, 1, 1000) ?? 200, 1), 1000);
          let segs = t.segments;
          const st = validateEnum(SEGMENT_STATUSES, args.status, 'status');
          if (st) segs = segs.filter((s) => s.status === st);
          const rs = int(args.rangeStart, 0, 1_000_000);
          const re = int(args.rangeEnd, 0, 1_000_000);
          if (rs !== undefined) segs = segs.filter((s) => s.end >= rs);
          if (re !== undefined) segs = segs.filter((s) => s.start <= re);
          const returned = segs.slice(0, limit).map((s) => ({
            id: s.id, start: s.start, end: s.end, speaker: s.speaker, speakerLabel: s.speakerLabel,
            text: s.text, status: s.status, confidence: s.confidence, note: s.note, entityIds: s.entityIds,
            ...(args.withRaw && s.rawText ? { rawText: s.rawText } : {}),
          }));
          return {
            ok: true, transcriptId: t.id, total: t.segments.length, returned: returned.length,
            verifiedRatio: t.verifiedRatio, glossary: toJson(t.glossary ?? []), segments: toJson(returned),
          };
        },
      })),

      /* ================= 11. transcript_glossary_add ================= */
      ctx.tools.register(defineTool({
        name: 'transcript_glossary_add',
        description:
          '把反复转录错误的领域专名加入术语表（人名/机构/术语/地名）。'
          + 'terms 传 [{term: 正确写法, variants: [常见错误转录], kind, note}]。'
          + 'save=true 时立即对该稿执行一次确定性批量替换（variant → term），'
          + '被修正的段落状态会从 raw 推进到 ai-corrected，原文本保留在 rawText 供对照。',
        parameters: {
          interviewId: { type: 'string', required: true, description: '访谈 id' },
          terms: { type: 'json', required: true, description: '术语数组：[{term, variants[], kind, note}]' },
          save: { type: 'boolean', description: '是否立即对全文应用术语表（默认 false，仅登记）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, glossarySize: { type: 'integer' }, replacements: { type: 'integer' }, error: { type: 'string' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`登记术语：${Array.isArray(args.terms) ? args.terms.length : 0} 条`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          if (v.error) return resultView('登记失败', v.error);
          return resultView('术语表已更新', `术语总数：${v.glossarySize ?? 0}${v.replacements ? `\n本次修正：${v.replacements} 处` : ''}`);
        },
        async execute(args: any) {
          const store = await getStore();
          const t = [...store.transcripts.values()].find((x) => x.interviewId === String(args.interviewId));
          if (!t) throw new Error(`该访谈尚无逐字稿: ${args.interviewId}`);
          const incoming = Array.isArray(args.terms) ? args.terms : [];
          if (!incoming.length) throw new Error('terms 不能为空');
          const merged: GlossaryEntry[] = [...(t.glossary ?? [])];
          for (const raw of incoming) {
            const term = String(raw?.term ?? '').trim();
            if (!term) continue;
            const variants = Array.isArray(raw?.variants) ? raw.variants.map((v: unknown) => String(v).trim()).filter(Boolean) : [];
            const idx = merged.findIndex((g) => g.term === term);
            if (idx >= 0) {
              const prev = merged[idx];
              merged[idx] = {
                ...prev,
                variants: [...new Set([...(prev.variants ?? []), ...variants])],
                ...(raw.kind ? { kind: String(raw.kind) } : {}),
                ...(raw.note ? { note: String(raw.note) } : {}),
              };
            } else {
              merged.push({
                term,
                ...(variants.length ? { variants } : {}),
                ...(raw.kind ? { kind: String(raw.kind) } : {}),
                ...(raw.note ? { note: String(raw.note) } : {}),
              });
            }
          }
          let next: Transcript = { ...t, glossary: merged, updatedAt: Date.now() };
          let replacements = 0;
          if (args.save) {
            const res = applyGlossary(next, merged, Date.now());
            next = res.transcript;
            replacements = res.replacements;
          }
          store.recomputeVerifiedRatio(next);
          await store.upsertTranscript(next);
          return { ok: true, glossarySize: merged.length, replacements };
        },
      })),

      /* ================= 12. card_create ================= */
      ctx.tools.register(defineTool({
        name: 'card_create',
        description:
          '把一条证据、考释、争议或论点保存为考据卡（Zettelkasten 风格）。'
          + `kind 可选：${enumDoc(CARD_KINDS)}——`
          + 'extract=史料摘录、chronology=史实编年、concept=史学概念辨析、exegesis=考释解读、'
          + 'dispute=学术争议中的一方观点、thesis=论文论点单元、context=时代背景。'
          + `status 可选：${enumDoc(CARD_STATUSES)}。`
          + '请务必填 citation（引文定位：逐字稿段落 id / 卷宗号 / 页码）与 quote（证据原文），让卡片自包含。'
          + '存在相反材料时填 counterEvidence——史学写作里只记支持性证据是严重缺陷。'
          + 'content 写考释与论证本身，不要复述史料摘要。',
        parameters: {
          title: { type: 'string', required: true, description: '卡片标题（一句话）' },
          kind: { type: 'string', required: true, description: `卡片类型：${enumDoc(CARD_KINDS)}` },
          content: { type: 'string', required: true, description: '考释/论证/摘录正文' },
          sourceId: { type: 'string', description: '来源史料 id' },
          interviewId: { type: 'string', description: '来源访谈 id' },
          citation: { type: 'string', description: '引文定位：逐字稿段落 id / 卷宗号 / 页码' },
          quote: { type: 'string', description: '证据原文摘录' },
          argumentRole: { type: 'string', description: '论证角色：这张卡在论文里承担什么' },
          counterEvidence: { type: 'string', description: '反证/存疑：与本文论点相左的材料' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          importance: { type: 'integer', description: '重要度 1-5（默认 3）' },
          status: { type: 'string', description: `状态：${enumDoc(CARD_STATUSES)}（默认 draft）` },
          notes: { type: 'string', description: '备注' },
          relatedIds: { type: 'array', items: { type: 'string' }, description: '关联已有卡片 id 列表' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, card: { type: 'json' }, similar: { type: 'json' } } },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`建卡：${String(args.title ?? '').slice(0, 32)}`, { kind: args.kind, citation: args.citation }),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          const similar = (v.similar ?? []) as any[];
          const hint = similar.length
            ? `\n\n_⚠ 已有相似卡片：${similar.map((s) => `${s.title}(${s.score})`).join('、')}_`
            : '';
          return resultView(`已建卡：${String(v.card?.title ?? '').slice(0, 30)}`, mdCard(v.card ?? {}) + hint);
        },
        async execute(args: any) {
          const store = await getStore();
          const kind = validateEnum(CARD_KINDS, args.kind, 'kind');
          if (!kind) throw new Error(`kind 必填：${CARD_KINDS.join(' / ')}`);
          const related = Array.isArray(args.relatedIds) ? store.filterExistingCardIds(args.relatedIds as string[]) : [];
          const card = createCard({
            ...args,
            kind,
            importance: int(args.importance, 1, 5) ?? 3,
            status: validateEnum(CARD_STATUSES, args.status, 'status') as CardStatus | undefined,
            ...(related.length ? { relatedCardIds: related } : {}),
          } as never);
          await store.upsertCard(card);
          const similar = findSimilarCards([...store.cards.values()], card.title, {
            excludeId: card.id,
            sourceId: card.sourceId,
          });
          return { ok: true, card: toJson(card), ...(similar.length ? { similar: toJson(similar) } : {}) };
        },
      })),

      /* ================= 13. card_search ================= */
      ctx.tools.register(defineTool({
        name: 'card_search',
        description:
          '检索考据卡。可按类型、状态、标签、重要度、来源史料/访谈筛选，或按关键词匹配标题/内容/引文定位/证据原文。',
        parameters: {
          q: { type: 'string', description: '关键词' },
          kind: { type: 'string', description: `卡片类型：${enumDoc(CARD_KINDS)}` },
          status: { type: 'string', description: `状态：${enumDoc(CARD_STATUSES)}` },
          tag: { type: 'string', description: '按标签精确筛选' },
          importance: { type: 'integer', description: '最低重要度 1-5' },
          sourceId: { type: 'string', description: '来源史料 id' },
          interviewId: { type: 'string', description: '来源访谈 id' },
          limit: { type: 'integer', description: '返回上限（默认 10，最大 50）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, total: { type: 'integer' }, cards: { type: 'json' } } },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`检索卡片：${String(args.q ?? args.kind ?? '全部').slice(0, 28)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          const items = (v.cards ?? []) as any[];
          const md = items.length
            ? mdList(items.map((c) => `- ${mdCard(c).split('\n')[0]} \`${c.id}\``))
            : '_没有匹配的卡片_';
          return resultView(`卡片检索：${v.total ?? 0} 条`, md);
        },
        async execute(args: any) {
          const store = await getStore();
          const limit = Math.min(Math.max(int(args.limit, 1, 50) ?? 10, 1), 50);
          const list = filterCards([...store.cards.values()], {
            q: args.q,
            kind: validateEnum(CARD_KINDS, args.kind, 'kind') as CardKind | undefined,
            status: validateEnum(CARD_STATUSES, args.status, 'status') as CardStatus | undefined,
            tag: args.tag,
            importance: int(args.importance, 1, 5),
            sourceId: args.sourceId,
            interviewId: args.interviewId,
          });
          const slim = list.slice(0, limit).map((c) => ({
            id: c.id, title: c.title, kind: c.kind, status: c.status,
            citation: c.citation, sourceId: c.sourceId, importance: c.importance,
            tags: c.tags, content: c.content, quote: c.quote,
            counterEvidence: c.counterEvidence, argumentRole: c.argumentRole,
          }));
          return { ok: true, total: list.length, cards: toJson(slim) };
        },
      })),

      /* ================= 14. card_update ================= */
      ctx.tools.register(defineTool({
        name: 'card_update',
        description:
          '更新一张考据卡。只更新提供的字段。常用于推进状态（draft → corroborated → settled）'
          + '或补上反证、论证角色、卡片关联。',
        parameters: {
          id: { type: 'string', required: true, description: '卡片 id' },
          title: { type: 'string', description: '新标题' },
          kind: { type: 'string', description: `卡片类型：${enumDoc(CARD_KINDS)}` },
          content: { type: 'string', description: '正文' },
          sourceId: { type: 'string', description: '来源史料 id' },
          citation: { type: 'string', description: '引文定位' },
          quote: { type: 'string', description: '证据原文' },
          argumentRole: { type: 'string', description: '论证角色' },
          counterEvidence: { type: 'string', description: '反证/存疑' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签（整体替换）' },
          importance: { type: 'integer', description: '重要度 1-5' },
          status: { type: 'string', description: `状态：${enumDoc(CARD_STATUSES)}` },
          notes: { type: 'string', description: '备注' },
          relatedIds: { type: 'array', items: { type: 'string' }, description: '关联卡片 id（整体替换）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, card: { type: 'json' } } },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`更新卡片：${String(args.id ?? '').slice(0, 30)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          return resultView(`已更新：${String(v.card?.title ?? '').slice(0, 30)}`, mdCard(v.card ?? {}));
        },
        async execute(args: any) {
          const store = await getStore();
          const cur = store.cards.get(String(args.id));
          if (!cur) throw new Error(`卡片不存在: ${args.id}`);
          const related = Array.isArray(args.relatedIds) ? store.filterExistingCardIds(args.relatedIds as string[]) : undefined;
          const next = applyCardPatch(cur, {
            ...args,
            kind: validateEnum(CARD_KINDS, args.kind, 'kind') as CardKind | undefined,
            status: validateEnum(CARD_STATUSES, args.status, 'status') as CardStatus | undefined,
            importance: int(args.importance, 1, 5),
            ...(related !== undefined ? { relatedCardIds: related } : {}),
          } as never);
          await store.upsertCard(next);
          return { ok: true, card: toJson(next) };
        },
      })),

      /* ================= 15. kg_extract ================= */
      ctx.tools.register(defineTool({
        name: 'kg_extract',
        description:
          '向科技史时空谱系图谱提交实体与关系（两阶段：prepare 取现有图谱 → commit 提交）。'
          + `节点 kind 可选：${enumDoc(GRAPH_NODE_KINDS)}——`
          + 'person=人物（科学家/工程师/工匠/官员/传教士）、institution=机构/学派/学会/实验室/厂矿、'
          + 'artifact=器物/仪器/装置/技术产品、event=事件（发现/发明/论战/会议/政策）、'
          + 'concept=概念/理论/范式、publication=著作/论文/档案、place=地点。'
          + 'source/card 节点由系统自动维护，无需提交。'
          + `边 kind 可选：${enumDoc(GRAPH_EDGE_KINDS)}——`
          + '人物关系用 mentored（师承）/colleague（同事）/patronized（赞助提携）/debated（论战，含优先权之争）/succeeded（接任）；'
          + '人物机构用 affiliated（任职）/founded（创立）；技术与知识用 invented（发明）/improved（改良）/'
          + 'transferred（技术转移引进）/localized（本土化改制）/theorized（理论化）/applied（应用）；'
          + '文献用 authored（著述）/cited（引用）/annotated（批注考释）；'
          + '时间因果用 preceded（先于）/caused（导致）/influenced（影响）。'
          + '**不要使用理工科的"提出/改进/对比"类关系**。'
          + '节点尽量填 yearFrom/yearTo（用于时间轴演化过滤）、alias（别名/异写）、place，'
          + '人物节点填 lat/lng 可上地图。边能确定年代时填 year。'
          + 'mode=append 增量合并（默认），rebuild 重建（会拒绝缩减型提交，除非 force=true）。',
        parameters: {
          stage: { type: 'string', required: true, description: 'prepare=取现有图谱与未入图史料 / commit=提交节点与边' },
          nodes: { type: 'json', description: '节点数组：[{id, kind, label, yearFrom, yearTo, aliases[], place, lat, lng, note}]（commit 阶段）' },
          edges: { type: 'json', description: '边数组：[{source, target, kind, year, note}]（commit 阶段）' },
          mode: { type: 'string', description: 'append（默认，增量）或 rebuild（重建）' },
          force: { type: 'boolean', description: 'rebuild 时显式允许缩减（默认 false）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean' }, stage: { type: 'string' },
              graph: { type: 'json' }, unsynced: { type: 'json' },
              added: { type: 'json' }, total: { type: 'json' },
              truncated: { type: 'json' }, instructions: { type: 'string' }, error: { type: 'string' },
            },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(args.stage === 'commit' ? `提交图谱：${Array.isArray(args.nodes) ? args.nodes.length : 0} 节点` : '准备图谱抽取'),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          if (v.error) return resultView('图谱操作失败', v.error);
          if (v.stage === 'prepare') {
            return resultView('图谱现状', `现有 ${v.graph?.nodes?.length ?? 0} 节点 / ${v.graph?.edges?.length ?? 0} 边\n未入图史料：${v.unsynced?.length ?? 0} 条`);
          }
          return resultView('图谱已更新', `新增 ${v.added?.nodes ?? 0} 节点 / ${v.added?.edges ?? 0} 边\n合计 ${v.total?.nodes ?? 0} 节点 / ${v.total?.edges ?? 0} 边`);
        },
        async execute(args: any) {
          const store = await getStore();
          const stage = String(args.stage);
          if (stage === 'prepare') {
            const inGraph = new Set(store.graph.nodes.map((n) => n.id));
            const unsynced = [...store.sources.values()]
              .filter((s) => !inGraph.has(s.id))
              .map((s) => ({ id: s.id, title: s.title, tier: s.tier }));
            return {
              ok: true, stage: 'prepare',
              graph: toJson(store.graph),
              unsynced,
              instructions:
                '请从已入库史料与逐字稿中抽取实体与关系，然后用 stage=commit 提交。'
                + '人物、机构、器物、事件、概念、地点各按 kind 区分；关系用史学关系词（mentored/debated/transferred 等）。'
                + '无法从材料中确认的年代与人名不得臆造——宁可不填 yearFrom，也不要猜。',
            };
          }
          if (stage !== 'commit') throw new Error('stage 必须是 prepare 或 commit');
          const incoming = {
            nodes: (Array.isArray(args.nodes) ? args.nodes : []) as GraphNode[],
            edges: (Array.isArray(args.edges) ? args.edges : []) as GraphEdge[],
          };
          if (!incoming.nodes.length && !incoming.edges.length) {
            throw new Error('commit 阶段需要提供 nodes 或 edges');
          }
          const mode = args.mode === 'rebuild' ? 'rebuild' : 'append';
          if (mode === 'rebuild') {
            assertRebuildAllowed(store.graph, incoming.nodes.length + incoming.edges.length, !!args.force);
          }
          const stats: GraphMergeStats = { truncatedNodes: false, truncatedEdges: false };
          const merged = mergeGraph(
            store.graph,
            incoming,
            mode,
            { sourceIds: new Set(store.sources.keys()), cardIds: new Set(store.cards.keys()) },
            stats,
          );
          const before = { nodes: store.graph.nodes.length, edges: store.graph.edges.length };
          await store.saveGraph(merged, mode === 'rebuild');
          return {
            ok: true, stage: 'commit',
            added: { nodes: merged.nodes.length - before.nodes, edges: merged.edges.length - before.edges },
            total: { nodes: merged.nodes.length, edges: merged.edges.length },
            truncated: { nodes: stats.truncatedNodes, edges: stats.truncatedEdges },
          };
        },
      })),

      /* ================= 16. kg_query ================= */
      ctx.tools.register(defineTool({
        name: 'kg_query',
        description:
          '查询科技史谱系图谱。可按节点类型/关系类型/年代窗过滤，或取某个节点为中心的 N 跳子图'
          + '（如"某位科学家 2 跳内的师承与合作网络"）。也可按关键词定位节点。'
          + '返回节点（含年代、别名、地点）与边（含关系年代），供对话中分析人物关系、技术传播路径与时间脉络。',
        parameters: {
          center: { type: 'string', description: '中心节点 id（取子图时用）' },
          hops: { type: 'integer', description: '子图跳数（默认 1，最大 3）' },
          kinds: { type: 'array', items: { type: 'string' }, description: `节点类型过滤：${enumDoc(GRAPH_NODE_KINDS)}` },
          edgeKinds: { type: 'array', items: { type: 'string' }, description: `关系类型过滤：${enumDoc(GRAPH_EDGE_KINDS)}` },
          yearFrom: { type: 'integer', description: '年代下限' },
          yearTo: { type: 'integer', description: '年代上限' },
          q: { type: 'string', description: '按节点标签/别名关键词定位' },
          limit: { type: 'integer', description: '节点上限（默认 100，最大 500）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, nodes: { type: 'json' }, edges: { type: 'json' }, total: { type: 'json' } },
          },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`查询图谱：${String(args.center ?? args.q ?? '全部').slice(0, 28)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          const nodes = (v.nodes ?? []) as any[];
          const byKind = nodes.reduce((acc: Record<string, number>, n) => {
            acc[n.kind] = (acc[n.kind] ?? 0) + 1;
            return acc;
          }, {});
          const summary = Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(' · ');
          return resultView(`图谱查询：${nodes.length} 节点 / ${v.edges?.length ?? 0} 边`, summary || '_无匹配节点_');
        },
        async execute(args: any) {
          const store = await getStore();
          const limit = Math.min(Math.max(int(args.limit, 1, 500) ?? 100, 1), 500);
          let nodes = store.graph.nodes;
          let edges = store.graph.edges;

          if (args.center) {
            const hops = Math.min(Math.max(int(args.hops, 1, 3) ?? 1, 1), 3);
            const sub = nodeSubgraph({ nodes, edges }, String(args.center), hops);
            nodes = sub.nodes;
            edges = sub.edges;
          }

          if (Array.isArray(args.kinds) && args.kinds.length) {
            const wanted = new Set(args.kinds.map((k: unknown) => String(k)));
            nodes = nodes.filter((n) => wanted.has(n.kind));
          }
          if (Array.isArray(args.edgeKinds) && args.edgeKinds.length) {
            const wanted = new Set(args.edgeKinds.map((k: unknown) => String(k)));
            edges = edges.filter((e) => wanted.has(e.kind));
          }
          if (typeof args.yearFrom === 'number' || typeof args.yearTo === 'number') {
            const lo = typeof args.yearFrom === 'number' ? args.yearFrom : -Infinity;
            const hi = typeof args.yearTo === 'number' ? args.yearTo : Infinity;
            nodes = nodes.filter((n) => {
              if (n.yearFrom === undefined && n.yearTo === undefined) return true; // 无年代的概念节点保留
              const nf = n.yearFrom ?? n.yearTo!;
              const nt = n.yearTo ?? n.yearFrom!;
              return nt >= lo && nf <= hi;
            });
          }
          if (args.q) {
            const needle = String(args.q).toLowerCase();
            nodes = nodes.filter((n) =>
              n.label.toLowerCase().includes(needle)
              || (n.aliases ?? []).some((a) => a.toLowerCase().includes(needle))
              || (n.note ?? '').toLowerCase().includes(needle));
          }

          const kept = new Set(nodes.slice(0, limit).map((n) => n.id));
          const outNodes = nodes.filter((n) => kept.has(n.id));
          const outEdges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
          return {
            ok: true,
            nodes: toJson(outNodes),
            edges: toJson(outEdges),
            total: { nodes: outNodes.length, edges: outEdges.length },
          };
        },
      })),

      /* ================= 17. attachment_link ================= */
      ctx.tools.register(defineTool({
        name: 'attachment_link',
        description:
          '把已上传到工作台附件目录的文件路径登记到史料或访谈上。'
          + '（文件本身在面板里上传；录音、扫描件、逐字稿文档都走这里关联。）'
          + 'target=source 时写史料的 filePath；target=interview 时写访谈的 audioPath。',
        parameters: {
          target: { type: 'string', required: true, description: 'source 或 interview' },
          id: { type: 'string', required: true, description: '史料 id 或访谈 id' },
          filePath: { type: 'string', required: true, description: '附件相对路径（attachments/xxx.mp3）' },
          durationSeconds: { type: 'integer', description: 'target=interview 时可同时登记音频时长（秒）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
          render: renderJson,
          presentationMeta: (_a: unknown, value: any) => value,
        },
        presentCall: (args: any) => callView(`关联附件：${String(args.filePath ?? '').slice(0, 30)}`),
        presentResult: (_args: any, result: { value?: any; meta?: any }) => {
          const v: any = result.value ?? result.meta ?? {};
          if (v.error) return resultView('关联失败', v.error);
          return resultView('附件已关联', '');
        },
        async execute(args: any) {
          const store = await getStore();
          const rel = String(args.filePath).trim().replace(/\\/g, '/');
          if (!rel.startsWith('attachments/') || rel.includes('..')) {
            throw new Error('附件路径必须以 attachments/ 开头且不含 ..');
          }
          const target = String(args.target);
          if (target === 'source') {
            const src = store.sources.get(String(args.id));
            if (!src) return { ok: false, error: `史料不存在: ${args.id}` };
            await store.upsertSource({ ...src, filePath: rel, updatedAt: Date.now() });
            return { ok: true };
          }
          if (target === 'interview') {
            const iv = store.interviews.get(String(args.id));
            if (!iv) return { ok: false, error: `访谈不存在: ${args.id}` };
            await store.upsertInterview({
              ...iv,
              audioPath: rel,
              ...(typeof args.durationSeconds === 'number' ? { durationSeconds: args.durationSeconds } : {}),
              updatedAt: Date.now(),
            });
            return { ok: true };
          }
          throw new Error('target 必须是 source 或 interview');
        },
      })),

    ];
    toolCount = disposers.length;
    return () => { for (const d of disposers) d(); };
  }, 'dsh-oral-history: tools');

  return toolCount;
}
