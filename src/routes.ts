/**
 * dsh-oral-history — REST routes under /oral-history/* (host half).
 *
 * NOTE: routes must NOT live under /api — dsh-client-connection owns the
 * /api prefix (RPC bridge) and would swallow them.
 *
 * POST/PUT bodies are forced to application/json (CSRF hardening).
 * Validation uses @deepseek-ai/schemastery schemas.
 */
import type { Context } from '@deepseek-ai/cordis';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import z from '@deepseek-ai/schemastery';
import type {
  CardKind, CardQuery, CardSort, CardStatus, EvidenceGrade, GraphNodeKind, InterviewQuery,
  KnowledgeGraph, OralHistoryConfig, PrimaryKind, SecondaryKind, SegmentStatus, SourceQuery,
  SourceSort, SourceStatus, SourceTier, SpeakerRole,
} from './shared/types.js';
import {
  CARD_KINDS, CARD_STATUSES, EVIDENCE_GRADES, GRAPH_EDGE_KINDS, GRAPH_NODE_KINDS,
  PRIMARY_KINDS, SECONDARY_KINDS, SEGMENT_STATUSES, SOURCE_STATUSES, SOURCE_TIERS, SPEAKER_ROLES,
} from './shared/types.js';
import type { OralHistoryStore } from './store.js';
import {
  allCardTags, allSourceTags, assertRebuildAllowed, filterCards, filterInterviews,
  filterSources, mergeGraph, nodeSubgraph, safeName, timeWindowGraph,
} from './store.js';
import {
  appendSegments, applyCardPatch, applyGlossary, applyInterviewPatch, applySegmentPatch,
  applySourcePatch, createCard, createInterview, createSource, createTranscript,
  findDuplicateSource, findSimilarCards,
} from './domain.js';
import { fetchMetadata } from './metadata.js';

const ATTACH_MAX_BYTES = 200 * 1024 * 1024; // 音频比 PDF 大得多

/* ==========================================================================
 * Schemastery 输入 schema（全量创建）
 * ========================================================================== */

const ALL = 'all';

const SourceInputSchema = z.object({
  title: z.string().required(),
  tier: z.union(['primary', 'secondary']).default('primary'),
  primaryKind: z.string().default(''),
  secondaryKind: z.string().default(''),
  authors: z.array(z.string()).default([]),
  temporal: z.any(),
  provenance: z.any(),
  doi: z.string().default(''),
  venue: z.string().default(''),
  year: z.number(),
  arxivId: z.string().default(''),
  url: z.string().default(''),
  abstract: z.string().default(''),
  summary: z.string().default(''),
  language: z.string().default(''),
  tags: z.array(z.string()).default([]),
  importance: z.number(),
  status: z.string().default(''),
  evidenceGrade: z.string().default(''),
  notes: z.string().default(''),
});

/**
 * PUT 部分更新 schema：所有字段可选、无默认值——
 * 未提交的字段不会出现在输出里，applyPatch 视为"保持不变"而不是"清空"。
 */
export const SourcePatchSchema = z.object({
  title: z.string(),
  tier: z.union(['primary', 'secondary']),
  primaryKind: z.string(),
  secondaryKind: z.string(),
  authors: z.array(z.string()),
  temporal: z.any(),
  provenance: z.any(),
  doi: z.string(),
  venue: z.string(),
  year: z.number(),
  arxivId: z.string(),
  url: z.string(),
  abstract: z.string(),
  summary: z.string(),
  language: z.string(),
  tags: z.array(z.string()),
  importance: z.number(),
  status: z.string(),
  evidenceGrade: z.string(),
  notes: z.string(),
  // 附件路径也必须可 patch：否则文件上传后无法把 filePath 写回史料
  // （pickSubmitted 会丢弃 schema 未声明的字段）
  filePath: z.string(),
});

const InterviewInputSchema = z.object({
  sourceId: z.string().required(),
  interviewee: z.any(),
  interviewers: z.any(),
  interviewYear: z.number(),
  interviewDate: z.string().default(''),
  location: z.string().default(''),
  recording: z.any(),
  audioPath: z.string().default(''),
  durationSeconds: z.number(),
  questionOutline: z.string().default(''),
  backgroundNotes: z.string().default(''),
  publicationNote: z.string().default(''),
});

export const InterviewPatchSchema = z.object({
  sourceId: z.string(),
  interviewee: z.any(),
  interviewers: z.any(),
  interviewYear: z.number(),
  interviewDate: z.string(),
  location: z.string(),
  recording: z.any(),
  audioPath: z.string(),
  durationSeconds: z.number(),
  questionOutline: z.string(),
  backgroundNotes: z.string(),
  publicationNote: z.string(),
});

const CardInputSchema = z.object({
  title: z.string().required(),
  kind: z.string().default('other'),
  content: z.string().required(),
  sourceId: z.string().default(''),
  interviewId: z.string().default(''),
  citation: z.string().default(''),
  quote: z.string().default(''),
  argumentRole: z.string().default(''),
  counterEvidence: z.string().default(''),
  tags: z.array(z.string()).default([]),
  importance: z.number().default(3),
  status: z.string().default('draft'),
  notes: z.string().default(''),
  relatedCardIds: z.array(z.string()).default([]),
});

export const CardPatchSchema = z.object({
  title: z.string(),
  kind: z.string(),
  content: z.string(),
  sourceId: z.string(),
  interviewId: z.string(),
  citation: z.string(),
  quote: z.string(),
  argumentRole: z.string(),
  counterEvidence: z.string(),
  tags: z.array(z.string()),
  importance: z.number(),
  status: z.string(),
  notes: z.string(),
  relatedCardIds: z.array(z.string()),
});

/* ==========================================================================
 * 工具函数
 * ========================================================================== */

/**
 * schemastery 对未提交的可选数组字段会隐式填 []（等效默认值，实测确认），
 * 会把 patch 语义破坏成"清空该字段"。这里把校验输出裁剪为"实际出现在
 * 提交 body 里的字段"：既保留类型校验，又保证 PUT 只动用户提交的字段。
 */
export function pickSubmitted<S extends (data: any) => object>(schema: S, body: Record<string, any>): Partial<ReturnType<S>> {
  const out = { ...(schema(body) as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    if (!(k in body)) delete out[k];
  }
  return out as Partial<ReturnType<S>>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/json')) {
      reject(new Error('请求必须是 application/json'));
      return;
    }
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4_000_000) {
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Raw binary body reader for attachment upload (octet-stream only, size-capped). */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/octet-stream')) {
      reject(new Error('上传必须是 application/octet-stream'));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`文件过大（上限 ${Math.floor(maxBytes / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/**
 * 流式发送 attachments/ 下的文件（音频、扫描件、PDF）。
 * 音频用 inline + Range 友好：浏览器 <audio> 依赖 206 才能拖动进度条，
 * 这里至少保证 content-length 与 type 正确，由浏览器自行处理缓冲。
 */
async function streamAttachment(dir: string, rel: string, res: ServerResponse): Promise<void> {
  const file = join(dir, rel);
  try {
    const st = await stat(file);
    const ext = (rel.split('.').pop() ?? '').toLowerCase();
    res.statusCode = 200;
    res.setHeader('content-type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
    res.setHeader('content-length', String(st.size));
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(rel.split('/').pop() ?? 'file')}"`);
    createReadStream(file).pipe(res);
  } catch {
    sendJson(res, 404, { error: '附件文件不存在' });
  }
}

/** 403 unless loopback：0.1.5 的 Web 认证门不覆盖插件命名路由，/oral-history/* 需要自己的本机围栏。 */
function guardRoute(req: IncomingMessage, res: ServerResponse): boolean {
  const addr = req.socket.remoteAddress ?? '';
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  sendJson(res, 403, { error: '仅允许本机(loopback)访问' });
  return false;
}

function num(s: string | null): number | undefined {
  if (s === null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function pathInfo(req: IncomingMessage, prefix: string): { rest: string; params: URLSearchParams } {
  const u = new URL(req.url ?? '/', 'http://localhost');
  return { rest: u.pathname.slice(prefix.length), params: u.searchParams };
}

/** 分段的附件扩展名白名单 → content-type（音频/文档/扫描件）。 */
const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac',
  ogg: 'audio/ogg', aac: 'audio/aac', wma: 'audio/x-ms-wma', amr: 'audio/amr',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', tif: 'image/tiff', tiff: 'image/tiff',
};

const MAX_PATH_SEGMENT = 200;

/** 校验并规范化客户端提交的附件相对路径：必须落在 attachments/ 下，禁止穿越。 */
function safeAttachmentPath(rel: string): string | undefined {
  const p = rel.trim().replace(/\\/g, '/');
  if (!p.startsWith('attachments/')) return undefined;
  const rest = p.slice('attachments/'.length);
  if (!rest || rest.includes('..') || rest.startsWith('/') || rest.length > MAX_PATH_SEGMENT) return undefined;
  return `attachments/${rest}`;
}

/* ==========================================================================
 * 路由注册
 * ========================================================================== */

export function registerOralHistoryRoutes(
  ctx: Context,
  getStore: () => Promise<OralHistoryStore>,
  getConfig: () => OralHistoryConfig,
  updateConfig: (patch: Partial<OralHistoryConfig>) => Promise<void>,
): void {
  const PREFIX = '/oral-history';

  /** 统一异常包装：把 handler 里的 throw 转成 JSON 错误响应。 */
  const wrap = (
    fn: (req: IncomingMessage, res: ServerResponse, info: { rest: string; params: URLSearchParams }) => Promise<void> | void,
    routePath = PREFIX,
  ) => async (req: IncomingMessage, res: ServerResponse) => {
    if (!guardRoute(req, res)) return;
    try {
      // rest 相对**该路由自身**的完整路径计算：
      // prefix 路由注册为 /oral-history/interviews，故 /oral-history/interviews/<id> 的 rest 是 "/<id>"。
      // 若相对 PREFIX 计算会得到 "/interviews/<id>"，查表必然落空。
      await fn(req, res, pathInfo(req, routePath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 400, { error: msg });
      else res.end();
    }
  };

  const routes: WebRoute[] = [];
  const route = (kind: 'exact' | 'prefix', path: string, handler: WebRoute['handler']) => {
    routes.push({ kind, path: `${PREFIX}${path}`, handler });
  };

  /**
   * prefix 路由的处理器工厂：wrap 需要知道该路由的完整路径才能正确切出 rest。
   * path 是相对 PREFIX 的路径（如 '/interviews'）。
   */
  const wrapped = (
    path: string,
    fn: (req: IncomingMessage, res: ServerResponse, info: { rest: string; params: URLSearchParams }) => Promise<void> | void,
  ): WebRoute['handler'] => wrap(fn, `${PREFIX}${path}`);

  /* ---------- config ---------- */

  route('exact', '/config', wrap(async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, getConfig());
      return;
    }
    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req) || '{}');
      await updateConfig(body as Partial<OralHistoryConfig>);
      sendJson(res, 200, { ok: true, config: getConfig() });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / PUT' });
  }));

  /* ---------- stats ---------- */

  route('exact', '/stats', wrap(async (_req, res) => {
    const store = await getStore();
    sendJson(res, 200, store.stats());
  }));

  /* ---------- 元数据抓取（仅二手研究：DOI / arXiv） ---------- */

  route('exact', '/fetch', wrap(async (req, res, { params }) => {
    const input = params.get('input') ?? '';
    if (!input.trim()) {
      sendJson(res, 400, { error: '缺少 input 参数' });
      return;
    }
    const cfg = getConfig();
    const meta = await fetchMetadata(input, cfg.fetchProxy || undefined);
    sendJson(res, 200, meta);
  }));

  /* ---------- 标签汇总 ---------- */

  route('exact', '/tags', wrap(async (req, res, { params }) => {
    const store = await getStore();
    const scope = params.get('scope') ?? ALL;
    if (scope === 'cards') sendJson(res, 200, { tags: allCardTags(store.cards.values()) });
    else sendJson(res, 200, { tags: allSourceTags(store.sources.values()) });
  }));

  /* ---------- 分区（collections） ---------- */

  route('exact', '/collections', wrap(async (req, res) => {
    const store = await getStore();
    if (req.method === 'GET') {
      sendJson(res, 200, { collections: store.listCollections() });
      return;
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}') as { name?: string; color?: string };
      const name = (body.name ?? '').trim();
      if (!name) throw new Error('分区名称不能为空');
      const ids = await store.ensureCollectionNames([name]);
      const col = store.collections.get(ids[0]);
      if (body.color && col) {
        await store.upsertCollection({ ...col, color: body.color, updatedAt: Date.now() });
      }
      sendJson(res, 201, { ok: true, collection: store.collections.get(ids[0]) });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / POST' });
  }));

  route('prefix', '/collections', wrapped('/collections', async (req, res, { rest: rawRest }) => {
    const store = await getStore();
    const rest = rawRest.replace(/^\//, '');
    const id = decodeURIComponent(rest);
    if (!id) {
      sendJson(res, 400, { error: '缺少分区 id' });
      return;
    }
    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req) || '{}') as { name?: string; color?: string };
      const cur = store.collections.get(id);
      if (!cur) {
        sendJson(res, 404, { error: '分区不存在' });
        return;
      }
      const name = body.name !== undefined ? body.name.trim() : cur.name;
      if (!name) throw new Error('分区名称不能为空');
      const next = { ...cur, name, color: body.color !== undefined ? (body.color || undefined) : cur.color, updatedAt: Date.now() };
      await store.upsertCollection(next);
      sendJson(res, 200, { ok: true, collection: next });
      return;
    }
    if (req.method === 'DELETE') {
      const ok = store.collections.delete(id);
      if (ok) await store.deleteCollection(id);
      sendJson(res, 200, { ok });
      return;
    }
    sendJson(res, 405, { error: '仅支持 PUT / DELETE' });
  }));

  /* ---------- 史料（sources） ---------- */

  route('exact', '/sources', wrap(async (req, res, { params }) => {
    const store = await getStore();
    if (req.method === 'GET') {
      const q: SourceQuery = {
        q: params.get('q') ?? undefined,
        tier: (params.get('tier') ?? undefined) as SourceTier | undefined,
        primaryKind: (params.get('primaryKind') ?? undefined) as PrimaryKind | undefined,
        secondaryKind: (params.get('secondaryKind') ?? undefined) as SecondaryKind | undefined,
        tag: params.get('tag') ?? undefined,
        yearFrom: num(params.get('yearFrom')),
        yearTo: num(params.get('yearTo')),
        eventYearFrom: num(params.get('eventYearFrom')),
        eventYearTo: num(params.get('eventYearTo')),
        importance: num(params.get('importance')),
        collection: params.get('collection') ?? undefined,
        unfiled: params.get('unfiled') === '1',
        status: (params.get('status') ?? undefined) as SourceStatus | undefined,
        evidenceGrade: (params.get('evidenceGrade') ?? undefined) as EvidenceGrade | undefined,
        language: params.get('language') ?? undefined,
        sort: (params.get('sort') ?? undefined) as SourceSort | undefined,
      };
      const list = filterSources([...store.sources.values()], q);
      const limit = num(params.get('limit'));
      const total = list.length;
      sendJson(res, 200, { total, sources: limit ? list.slice(0, limit) : list });
      return;
    }
    if (req.method === 'POST') {
      const raw = JSON.parse(await readBody(req) || '{}');
      const input = new SourceInputSchema(raw);
      const dup = findDuplicateSource(store.sources.values(), {
        title: input.title,
        doi: input.doi || undefined,
        provenance: input.provenance,
      });
      const colIds = Array.isArray(raw.collectionIds) && raw.collectionIds.length
        ? await store.ensureCollectionNames(raw.collectionIds as string[])
        : undefined;
      if (dup) {
        if (raw.update) {
          const next = applySourcePatch(dup, {
            ...input,
            ...(colIds ? { collectionIds: colIds } : {}),
          } as never);
          await store.upsertSource(next);
          sendJson(res, 200, { ok: true, created: false, duplicate: true, updated: true, source: next });
          return;
        }
        sendJson(res, 200, { ok: true, created: false, duplicate: true, updated: false, source: dup });
        return;
      }
      const src = createSource({
        ...input,
        ...(colIds ? { collectionIds: colIds } : {}),
        source: 'manual',
      } as never);
      await store.upsertSource(src);
      sendJson(res, 201, { ok: true, created: true, duplicate: false, updated: false, source: src });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / POST' });
  }));

  route('prefix', '/sources', wrapped('/sources', async (req, res, { rest: rawRest }) => {
    const store = await getStore();
    const rest = rawRest.replace(/^\//, '');
    // 子资源路由：<id>/attachment
    const attachMatch = /^([^/]+)\/attachment$/.exec(rest);
    if (attachMatch) {
      const id = decodeURIComponent(attachMatch[1]);
      const src = store.sources.get(id);
      if (!src) {
        sendJson(res, 404, { error: '史料不存在' });
        return;
      }
      if (req.method === 'GET') {
        if (!src.filePath) {
          sendJson(res, 404, { error: '该史料没有附件' });
          return;
        }
        const rel = safeAttachmentPath(src.filePath);
        if (!rel) {
          sendJson(res, 400, { error: '附件路径不合法' });
          return;
        }
        await streamAttachment(store.dir, rel, res);
        return;
      }
      if (req.method === 'PUT') {
        const buf = await readRawBody(req, ATTACH_MAX_BYTES);
        if (!buf.length) throw new Error('上传内容为空');
        const ext = (String(req.headers['x-file-ext'] ?? 'bin').replace(/[^A-Za-z0-9]/g, '') || 'bin').slice(0, 8);
        const rel = `attachments/${safeName(id)}.${ext}`;
        await mkdir(join(store.dir, 'attachments'), { recursive: true });
        const target = join(store.dir, rel);
        const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
        await writeFile(tmp, buf);
        await rename(tmp, target).catch(async (err: unknown) => {
          await unlink(tmp).catch(() => {});
          throw err;
        });
        await store.upsertSource({ ...src, filePath: rel, updatedAt: Date.now() });
        sendJson(res, 200, { ok: true, filePath: rel });
        return;
      }
      sendJson(res, 405, { error: '仅支持 GET / PUT' });
      return;
    }

    const id = decodeURIComponent(rest);
    const src = store.sources.get(id);
    if (!src) {
      sendJson(res, 404, { error: '史料不存在' });
      return;
    }
    if (req.method === 'GET') {
      const linked = [...store.interviews.values()].filter((iv) => iv.sourceId === id);
      const cards = filterCards([...store.cards.values()], { sourceId: id });
      sendJson(res, 200, { source: src, interviews: linked, cards });
      return;
    }
    if (req.method === 'PUT') {
      const raw = JSON.parse(await readBody(req) || '{}');
      const patch = pickSubmitted(SourcePatchSchema, raw);
      const colIds = Array.isArray(raw.collectionIds)
        ? await store.ensureCollectionNames(raw.collectionIds as string[])
        : undefined;
      const next = applySourcePatch(src, {
        ...(patch as Record<string, unknown>),
        ...(colIds !== undefined ? { collectionIds: colIds } : {}),
      } as never);
      await store.upsertSource(next);
      sendJson(res, 200, { ok: true, source: next });
      return;
    }
    if (req.method === 'DELETE') {
      await store.deleteSource(id);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / PUT / DELETE' });
  }));

  /* ---------- 访谈（interviews） ---------- */

  route('exact', '/interviews', wrap(async (req, res, { params }) => {
    const store = await getStore();
    if (req.method === 'GET') {
      const q: InterviewQuery = {
        q: params.get('q') ?? undefined,
        interviewee: params.get('interviewee') ?? undefined,
        field: params.get('field') ?? undefined,
        affiliation: params.get('affiliation') ?? undefined,
        yearFrom: num(params.get('yearFrom')),
        yearTo: num(params.get('yearTo')),
      };
      const list = filterInterviews([...store.interviews.values()], q);
      sendJson(res, 200, { total: list.length, interviews: list });
      return;
    }
    if (req.method === 'POST') {
      const raw = JSON.parse(await readBody(req) || '{}');
      const input = new InterviewInputSchema(raw);
      if (!store.sources.has(input.sourceId)) {
        sendJson(res, 400, { error: `史料不存在: ${input.sourceId}（请先创建史料）` });
        return;
      }
      const iv = createInterview(input as never);
      await store.upsertInterview(iv);
      // 回填史料的 interviewId 反向引用
      const src = store.sources.get(input.sourceId);
      if (src && !src.interviewId) {
        await store.upsertSource({ ...src, interviewId: iv.id, updatedAt: Date.now() });
      }
      sendJson(res, 201, { ok: true, interview: iv });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / POST' });
  }));

  route('prefix', '/interviews', wrapped('/interviews', async (req, res, { rest: rawRest }) => {
    const store = await getStore();
    const rest = rawRest.replace(/^\//, '');

    /*
     * 子资源：GET /interviews/<id>/audio —— 采访录音流。
     * 优先访谈自带的 audioPath，回落到来源史料的附件（filePath）——
     * 实际档案里录音常挂在史料上（一份史料对应一盘磁带），但单个访谈也可能单独指定。
     * 两者都没有则 404，前端据此显示"尚未关联录音"。
     */
    const audioMatch = /^([^/]+)\/audio$/.exec(rest);
    if (audioMatch) {
      const iv0 = store.interviews.get(decodeURIComponent(audioMatch[1]));
      if (!iv0) {
        sendJson(res, 404, { error: '访谈不存在' });
        return;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '仅支持 GET' });
        return;
      }
      const src0 = store.sources.get(iv0.sourceId);
      const rel = safeAttachmentPath(iv0.audioPath ?? '') ?? safeAttachmentPath(src0?.filePath ?? '');
      if (!rel) {
        sendJson(res, 404, { error: '该访谈尚未关联录音' });
        return;
      }
      await streamAttachment(store.dir, rel, res);
      return;
    }

    const iv = store.interviews.get(decodeURIComponent(rest));
    if (!iv) {
      sendJson(res, 404, { error: '访谈不存在' });
      return;
    }
    if (req.method === 'GET') {
      const transcript = [...store.transcripts.values()].find((t) => t.interviewId === iv.id) ?? null;
      const source = store.sources.get(iv.sourceId) ?? null;
      sendJson(res, 200, { interview: iv, transcript, source });
      return;
    }
    if (req.method === 'PUT') {
      const raw = JSON.parse(await readBody(req) || '{}');
      const patch = pickSubmitted(InterviewPatchSchema, raw);
      const next = applyInterviewPatch(iv, patch as never);
      await store.upsertInterview(next);
      sendJson(res, 200, { ok: true, interview: next });
      return;
    }
    if (req.method === 'DELETE') {
      await store.deleteInterview(iv.id);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / PUT / DELETE' });
  }));

  /* ---------- 逐字稿（transcripts） ---------- */

  route('prefix', '/transcripts', wrapped('/transcripts', async (req, res, { rest: rawRest }) => {
    const store = await getStore();
    const rest = rawRest.replace(/^\//, '');
    const id = decodeURIComponent(rest);

    // POST /transcripts/by-interview/<interviewId> —— 按访谈取稿（新建或读取）
    const byIv = /^by-interview\/(.+)$/.exec(id);
    if (byIv) {
      const interviewId = decodeURIComponent(byIv[1]);
      const existing = [...store.transcripts.values()].find((t) => t.interviewId === interviewId);
      if (req.method === 'GET') {
        sendJson(res, 200, { transcript: existing ?? null });
        return;
      }
      if (req.method === 'POST') {
        const iv = store.interviews.get(interviewId);
        if (!iv) {
          sendJson(res, 404, { error: '访谈不存在' });
          return;
        }
        const raw = JSON.parse(await readBody(req) || '{}');
        if (existing) {
          const next = appendSegments(existing, raw.segments, Date.now());
          store.recomputeVerifiedRatio(next);
          await store.upsertTranscript(next);
          sendJson(res, 200, { ok: true, created: false, transcript: next });
          return;
        }
        const t = createTranscript({
          interviewId,
          sourceId: iv.sourceId,
          language: raw.language ?? getConfig().defaultLanguage,
          segments: raw.segments,
        });
        store.recomputeVerifiedRatio(t);
        await store.upsertTranscript(t);
        await store.upsertInterview({ ...iv, transcriptId: t.id, updatedAt: Date.now() });
        sendJson(res, 201, { ok: true, created: true, transcript: t });
        return;
      }
      sendJson(res, 405, { error: '仅支持 GET / POST' });
      return;
    }

    const t = store.transcripts.get(id);
    if (!t) {
      sendJson(res, 404, { error: '逐字稿不存在' });
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { transcript: t });
      return;
    }
    if (req.method === 'PUT') {
      const raw = JSON.parse(await readBody(req) || '{}');
      // 支持三种更新：追加分段 / 改单段 / 覆盖术语表
      if (Array.isArray(raw.appendSegments)) {
        const next = appendSegments(t, raw.appendSegments, Date.now());
        store.recomputeVerifiedRatio(next);
        await store.upsertTranscript(next);
        sendJson(res, 200, { ok: true, transcript: next });
        return;
      }
      if (raw.segmentId) {
        const next = applySegmentPatch(t, String(raw.segmentId), raw.patch ?? {}, Date.now());
        store.recomputeVerifiedRatio(next);
        await store.upsertTranscript(next);
        sendJson(res, 200, { ok: true, transcript: next });
        return;
      }
      if (raw.glossary !== undefined) {
        const next = { ...t, glossary: Array.isArray(raw.glossary) ? raw.glossary : [], updatedAt: Date.now() };
        await store.upsertTranscript(next);
        sendJson(res, 200, { ok: true, transcript: next });
        return;
      }
      if (raw.applyGlossary) {
        const { transcript: next, replacements } = applyGlossary(t, t.glossary ?? [], Date.now());
        store.recomputeVerifiedRatio(next);
        await store.upsertTranscript(next);
        sendJson(res, 200, { ok: true, transcript: next, replacements });
        return;
      }
      sendJson(res, 400, { error: '未识别的更新请求（需 appendSegments / segmentId / glossary / applyGlossary）' });
      return;
    }
    if (req.method === 'DELETE') {
      await store.deleteTranscript(t.id);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / PUT / DELETE' });
  }));

  /* ---------- 考据卡（cards） ---------- */

  route('exact', '/cards', wrap(async (req, res, { params }) => {
    const store = await getStore();
    if (req.method === 'GET') {
      const q: CardQuery = {
        q: params.get('q') ?? undefined,
        kind: (params.get('kind') ?? undefined) as CardKind | undefined,
        tag: params.get('tag') ?? undefined,
        importance: num(params.get('importance')),
        status: (params.get('status') ?? undefined) as CardStatus | undefined,
        sourceId: params.get('sourceId') ?? undefined,
        interviewId: params.get('interviewId') ?? undefined,
        sort: (params.get('sort') ?? undefined) as CardSort | undefined,
      };
      const list = filterCards([...store.cards.values()], q);
      sendJson(res, 200, { total: list.length, cards: list });
      return;
    }
    if (req.method === 'POST') {
      const raw = JSON.parse(await readBody(req) || '{}');
      const input = new CardInputSchema(raw);
      const related = Array.isArray(input.relatedCardIds)
        ? store.filterExistingCardIds(input.relatedCardIds as string[])
        : [];
      const card = createCard({
        ...(input as unknown as Record<string, unknown>),
        ...(related.length ? { relatedCardIds: related } : {}),
      } as never);
      await store.upsertCard(card);
      const similar = findSimilarCards([...store.cards.values()], card.title, {
        excludeId: card.id,
        sourceId: card.sourceId,
      });
      sendJson(res, 201, { ok: true, card, ...(similar.length ? { similar } : {}) });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / POST' });
  }));

  route('prefix', '/cards', wrapped('/cards', async (req, res, { rest: rawRest }) => {
    const store = await getStore();
    const rest = rawRest.replace(/^\//, '');
    const card = store.cards.get(decodeURIComponent(rest));
    if (!card) {
      sendJson(res, 404, { error: '卡片不存在' });
      return;
    }
    if (req.method === 'GET') {
      const backlinks = [...store.cards.values()].filter((c) => c.relatedCardIds?.includes(card.id));
      const source = card.sourceId ? store.sources.get(card.sourceId) ?? null : null;
      sendJson(res, 200, { card, backlinks, source });
      return;
    }
    if (req.method === 'PUT') {
      const raw = JSON.parse(await readBody(req) || '{}');
      const patch = pickSubmitted(CardPatchSchema, raw);
      if (Array.isArray((patch as { relatedCardIds?: string[] }).relatedCardIds)) {
        (patch as { relatedCardIds?: string[] }).relatedCardIds =
          store.filterExistingCardIds((patch as { relatedCardIds: string[] }).relatedCardIds);
      }
      const next = applyCardPatch(card, patch as never);
      await store.upsertCard(next);
      sendJson(res, 200, { ok: true, card: next });
      return;
    }
    if (req.method === 'DELETE') {
      await store.deleteCard(card.id);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / PUT / DELETE' });
  }));

  /* ---------- 谱系图（graph） ---------- */

  route('exact', '/graph', wrap(async (req, res, { params }) => {
    const store = await getStore();
    if (req.method === 'GET') {
      let graph: KnowledgeGraph = store.graph;
      const center = params.get('center');
      const hops = num(params.get('hops')) ?? 1;
      if (center) graph = nodeSubgraph(graph, center, hops);
      const yf = num(params.get('yearFrom'));
      const yt = num(params.get('yearTo'));
      if (yf !== undefined || yt !== undefined) graph = timeWindowGraph(graph, yf, yt);
      const kinds = params.get('kinds');
      if (kinds) {
        const wanted = new Set(kinds.split(',').filter(Boolean));
        const keep = new Set(graph.nodes.filter((n) => wanted.has(n.kind)).map((n) => n.id));
        graph = {
          nodes: graph.nodes.filter((n) => keep.has(n.id)),
          edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
        };
      }
      sendJson(res, 200, graph);
      return;
    }
    if (req.method === 'PUT') {
      const raw = JSON.parse(await readBody(req) || '{}') as {
        nodes?: KnowledgeGraph['nodes'];
        edges?: KnowledgeGraph['edges'];
        mode?: 'append' | 'rebuild';
        force?: boolean;
      };
      const incoming = { nodes: raw.nodes ?? [], edges: raw.edges ?? [] };
      const mode = raw.mode === 'rebuild' ? 'rebuild' : 'append';
      if (mode === 'rebuild') {
        assertRebuildAllowed(store.graph, incoming.nodes.length + incoming.edges.length, !!raw.force);
      }
      const merged = mergeGraph(
        store.graph,
        incoming,
        mode,
        { sourceIds: new Set(store.sources.keys()), cardIds: new Set(store.cards.keys()) },
      );
      await store.saveGraph(merged, mode === 'rebuild');
      sendJson(res, 200, { ok: true, ...merged, count: { nodes: merged.nodes.length, edges: merged.edges.length } });
      return;
    }
    sendJson(res, 405, { error: '仅支持 GET / PUT' });
  }));

  /** 启发式同步：把史料/访谈/卡片的确定性关系补进图谱（无需 AI）。 */
  route('exact', '/graph/sync', wrap(async (req, res) => {
    const store = await getStore();
    const sources = [...store.sources.values()];
    const sourcePatch = store.sourceNodePatch(sources);
    const ivPatch = store.interviewSyncPatch([...store.interviews.values()], sources);
    const cardPatch = store.cardSyncPatch([...store.cards.values()], sources);
    const patch = {
      nodes: [...sourcePatch.nodes, ...ivPatch.nodes, ...cardPatch.nodes],
      edges: [...ivPatch.edges, ...cardPatch.edges],
    };
    const merged = mergeGraph(
      store.graph,
      patch,
      'append',
      { sourceIds: new Set(store.sources.keys()), cardIds: new Set(store.cards.keys()) },
    );
    await store.saveGraph(merged);
    sendJson(res, 200, {
      ok: true,
      added: { nodes: patch.nodes.length, edges: patch.edges.length },
      total: { nodes: merged.nodes.length, edges: merged.edges.length },
    });
  }));

  /** 删除孤立的 source/card 节点（其记录已被删除时）。 */
  route('exact', '/graph/prune', wrap(async (_req, res) => {
    const store = await getStore();
    const aliveSources = new Set(store.sources.keys());
    const aliveCards = new Set(store.cards.keys());
    const keep = new Set(
      store.graph.nodes
        .filter((n) => (n.kind !== 'source' || aliveSources.has(n.id)) && (n.kind !== 'card' || aliveCards.has(n.id)))
        .map((n) => n.id),
    );
    const removed = store.graph.nodes.length - keep.size;
    const next: KnowledgeGraph = {
      nodes: store.graph.nodes.filter((n) => keep.has(n.id)),
      edges: store.graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
    await store.saveGraph(next);
    sendJson(res, 200, { ok: true, removedNodes: removed, total: { nodes: next.nodes.length, edges: next.edges.length } });
  }));

  /** 枚举所有合法枚举值（供前端下拉直接读取，避免前后端硬编码漂移）。 */
  route('exact', '/enums', wrap(async (_req, res) => {
    sendJson(res, 200, {
      tiers: SOURCE_TIERS,
      primaryKinds: PRIMARY_KINDS,
      secondaryKinds: SECONDARY_KINDS,
      sourceStatuses: SOURCE_STATUSES,
      evidenceGrades: EVIDENCE_GRADES,
      speakerRoles: SPEAKER_ROLES,
      segmentStatuses: SEGMENT_STATUSES,
      cardKinds: CARD_KINDS,
      cardStatuses: CARD_STATUSES,
      graphNodeKinds: GRAPH_NODE_KINDS,
      graphEdgeKinds: GRAPH_EDGE_KINDS,
    });
  }));

  /* ---------- 导出（Markdown / 档案清单） ---------- */

  route('exact', '/export/interview', wrap(async (req, res, { params }) => {
    const store = await getStore();
    const id = params.get('id') ?? '';
    const iv = store.interviews.get(id);
    if (!iv) {
      sendJson(res, 404, { error: '访谈不存在' });
      return;
    }
    const source = store.sources.get(iv.sourceId);
    const t = [...store.transcripts.values()].find((x) => x.interviewId === iv.id);
    const cards = filterCards([...store.cards.values()], { interviewId: iv.id });
    const md = renderInterviewMarkdown(iv, source, t, cards);
    if (params.get('download') === '1') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/markdown; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(safeName(iv.id))}.md"`);
      res.end(md);
      return;
    }
    sendJson(res, 200, { markdown: md });
  }));

  route('exact', '/export/cards', wrap(async (req, res, { params }) => {
    const store = await getStore();
    const cards = filterCards([...store.cards.values()], {
      sourceId: params.get('sourceId') ?? undefined,
      kind: (params.get('kind') ?? undefined) as CardKind | undefined,
    });
    const md = cards.map((c) => renderCardMarkdown(c, store)).join('\n\n---\n\n');
    if (params.get('download') === '1') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/markdown; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="evidence-cards.md"');
      res.end(md);
      return;
    }
    sendJson(res, 200, { markdown: md, count: cards.length });
  }));

  ctx.effect(() => {
    const disposers = routes.map((r) => ctx.webServer.register(r));
    return () => { for (const d of disposers) d(); };
  }, 'dsh-oral-history: routes');
}

/* ==========================================================================
 * Markdown 渲染
 * ========================================================================== */

function renderCardMarkdown(c: import('./shared/types.js').EvidenceCard, store: OralHistoryStore): string {
  const lines: string[] = [`## ${c.title}`, ''];
  lines.push(`- 类型：${c.kind}　状态：${c.status}　重要度：${'★'.repeat(c.importance)}`);
  if (c.sourceId) {
    const s = store.sources.get(c.sourceId);
    lines.push(`- 来源史料：${s ? `${s.title}（${s.tier === 'primary' ? '一手' : '二手'}）` : c.sourceId}`);
  }
  if (c.citation) lines.push(`- 引文定位：${c.citation}`);
  if (c.argumentRole) lines.push(`- 论证角色：${c.argumentRole}`);
  if (c.tags.length) lines.push(`- 标签：${c.tags.map((t) => `#${t}`).join(' ')}`);
  lines.push('', c.content);
  if (c.quote) lines.push('', '> ' + c.quote.split('\n').join('\n> '));
  if (c.counterEvidence) lines.push('', `**反证 / 存疑：** ${c.counterEvidence}`);
  if (c.notes) lines.push('', `**备注：** ${c.notes}`);
  return lines.join('\n');
}

function renderInterviewMarkdown(
  iv: import('./shared/types.js').Interview,
  source: import('./shared/types.js').Source | undefined,
  t: import('./shared/types.js').Transcript | undefined,
  cards: import('./shared/types.js').EvidenceCard[],
): string {
  const L: string[] = [];
  L.push(`# ${iv.interviewee.name} 访谈记录`, '');
  const ie = iv.interviewee;
  const life = [ie.birthYear ? `${ie.birthYear}—` : '', ie.deathYear ? String(ie.deathYear) : ''].join('');
  L.push(`- 受访者：${ie.name}${life ? `（${life}）` : ''}`);
  if (ie.roles.length) L.push(`- 身份：${ie.roles.join('、')}`);
  if (ie.affiliations.length) L.push(`- 机构：${ie.affiliations.join('、')}`);
  if (ie.fields.length) L.push(`- 领域：${ie.fields.join('、')}`);
  if (iv.interviewers.length) L.push(`- 访谈者：${iv.interviewers.map((x) => x.name + (x.affiliation ? `（${x.affiliation}）` : '')).join('、')}`);
  if (iv.interviewDate || iv.interviewYear) L.push(`- 访谈时间：${iv.interviewDate ?? iv.interviewYear}`);
  if (iv.location) L.push(`- 访谈地点：${iv.location}`);
  if (iv.recording?.originalMedium) L.push(`- 原始载体：${iv.recording.originalMedium}`);
  if (iv.recording?.durationSeconds) L.push(`- 时长：${Math.round(iv.recording.durationSeconds / 60)} 分钟`);
  if (source?.provenance?.repository) L.push(`- 收藏机构：${source.provenance.repository}`);
  if (source?.provenance?.callNumber) L.push(`- 馆藏号：${source.provenance.callNumber}`);
  L.push('');

  if (ie.bio) L.push('## 人物小传', '', ie.bio, '');
  if (iv.backgroundNotes) L.push('## 背景补充', '', iv.backgroundNotes, '');
  if (iv.questionOutline) L.push('## 访谈提纲', '', iv.questionOutline, '');

  if (t && t.segments.length) {
    L.push('## 逐字稿', '');
    if (t.verifiedRatio !== undefined) {
      L.push(`_校对进度：${Math.round(t.verifiedRatio * 100)}%（${t.segments.filter((s) => s.status === 'human-verified').length}/${t.segments.length} 段已人工听校）_`, '');
    }
    for (const s of t.segments) {
      const mm = String(Math.floor(s.start / 60)).padStart(2, '0');
      const ss = String(Math.floor(s.start % 60)).padStart(2, '0');
      const who = s.speakerLabel ?? (s.speaker === 'interviewer' ? '访谈者' : s.speaker === 'interviewee' ? '受访者' : s.speaker === 'third-party' ? '第三方' : '未标注');
      const flag = s.status === 'human-verified' ? '' : s.status === 'inaudible' ? ' `[无法辨听]`' : s.status === 'uncertain' ? ' `[存疑]`' : ' `[未校]`';
      L.push(`**[${mm}:${ss}] ${who}：**${flag}`, '', s.text, '');
      if (s.note) L.push(`> 听校备注：${s.note}`, '');
    }
  }

  if (cards.length) {
    L.push('## 相关考据卡', '');
    for (const c of cards) {
      L.push(`### ${c.title}`, '', `- 类型：${c.kind}　状态：${c.status}`);
      if (c.citation) L.push(`- 引文定位：${c.citation}`);
      L.push('', c.content, '');
      if (c.quote) L.push('> ' + c.quote.split('\n').join('\n> '), '');
    }
  }
  return L.join('\n');
}
