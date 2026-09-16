import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EvidenceCard, Interview, PrimaryKind, SecondaryKind, Source, SourceCollection, SourceSort,
  SourceStatus, SourceTier, EvidenceGrade,
} from '../shared/types';
import { PRIMARY_KINDS, SECONDARY_KINDS, EVIDENCE_GRADES, SOURCE_STATUSES } from '../shared/types';
import { api, loadSavedFilters, qs, saveFilters } from './api';
import { navBus, useNav, type TFunc } from './nav';
import { refreshCounts } from './index';
import {
  Btn, Chip, EmptyState, Field, FilterChip, Icon, IconButton, Icons, Input, Meta, Modal,
  SchStyles, SearchInput, Section, Select, Stars, T, Textarea, tierColor,
} from './ui';
import {
  evidenceGradeLabels, kindLabels, primaryKindLabels, secondaryKindLabels, sourceStatusLabels,
} from './locales';

/* ==========================================================================
 * 常量
 * ========================================================================== */

/** 筛选/排序状态按会话存 sessionStorage 的键（视图重挂载后可恢复）。 */
const FILTERS_KEY = 'oh-sources-filters';

/** 分区色板——与 ui.tsx 的 tierColor 同族，避免出现刺眼的自定义色。 */
const COL_COLORS = ['#4d6bfe', '#30a46c', '#f5a524', '#e5484d', '#7c5cff', '#0d9488', '#0891b2', '#b45309'];

/** 附件上限（与服务端 ATTACH_MAX_BYTES 一致：200MB）。 */
const ATTACH_MAX_BYTES = 200 * 1024 * 1024;

/** 列表请求序号：慢的旧响应回来时若已有更新的请求，直接丢弃。 */
let loadSeq = 0;

/** 视图内部三态：列表 / 详情 / 编辑表单（表单本身走 Modal，但仍占一个模式位）。 */
type Mode = 'list' | 'detail' | 'edit';

/**
 * 排序键。服务端只认 SourceSort 的四种；`importance` 是视图自己排的
 * （见 normalizeSort / serverSort）。
 */
type SortKey = SourceSort | 'importance';

const SERVER_SORTS: readonly string[] = ['createdAt', 'year', 'title', 'eventYear'];

/** 校验从 sessionStorage 恢复的排序值——旧版本/手改过的值一律回落到 createdAt。 */
function normalizeSort(v: string | undefined): SortKey {
  return v === 'importance' || (v !== undefined && SERVER_SORTS.includes(v))
    ? (v as SortKey)
    : 'createdAt';
}

/** 交给服务端的排序参数：importance 不由服务端处理。 */
function serverSort(s: SortKey): SourceSort {
  return s === 'importance' ? 'createdAt' : s;
}

/** 一手 / 二手 的可选「类型」并集。 */
type AnyKind = PrimaryKind | SecondaryKind;

interface Filters {
  q: string;
  tier: SourceTier | '';
  kind: AnyKind | '';
  tag: string;
  status: SourceStatus | '';
  grade: EvidenceGrade | '';
  eventFrom: string;
  eventTo: string;
  col: string;
  unfiled: boolean;
  sort: SourceSort;
}

const EMPTY_FILTERS: Filters = {
  q: '', tier: '', kind: '', tag: '', status: '', grade: '',
  eventFrom: '', eventTo: '', col: '', unfiled: false, sort: 'createdAt',
};

/** 详情接口响应：GET /oral-history/sources/:id */
interface SourceDetail {
  source: Source;
  interviews: Interview[];
  cards: EvidenceCard[];
}

/** POST /oral-history/sources 响应 */
interface CreateResult {
  ok: boolean;
  created: boolean;
  duplicate: boolean;
  updated: boolean;
  source: Source;
}

/** GET /oral-history/fetch 响应（host 的 PaperMeta） */
interface FetchedMeta {
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  arxivId?: string;
  doi?: string;
  url?: string;
  abstract?: string;
}

/* ==========================================================================
 * 工具
 * ========================================================================== */

/** 逗号（中英文）分隔的列表输入 → 去空数组。 */
function splitList(s: string): string[] {
  return s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

/** 数字输入 → number | undefined（空串即未填，不写 0）。 */
function numOrUndef(s: string): number | undefined {
  const v = s.trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const has = (v: string | undefined | null): boolean => typeof v === 'string' && v.trim().length > 0;

/** 只有 http(s) 才可点击——DOII/URL 字段可能是任意 agent 输入的字符串。 */
function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/** DOI → doi.org 链接（剥掉用户可能粘贴的 https://doi.org/ 前缀）。 */
function doiHref(doi: string): string {
  return `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim()}`;
}

function arxivHref(id: string): string {
  return `https://arxiv.org/abs/${id.replace(/^arxiv:/i, '').trim()}`;
}

/** 从文件名取扩展名（用于上传时的 x-file-ext 头）。 */
function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : 'bin';
}

/** 大小 → 人类可读。 */
function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 区间渲染：1958 / 1958–1962 / 起 1958 / 至 1962。 */
function rangeText(from?: number, to?: number): string {
  if (from !== undefined && to !== undefined) return from === to ? String(from) : `${from}–${to}`;
  if (from !== undefined) return `${from}–`;
  if (to !== undefined) return `–${to}`;
  return '';
}

/** 事件的年代区间（列表与详情共用）。 */
function eventRange(src: Source): string {
  return rangeText(src.temporal?.eventYearFrom, src.temporal?.eventYearTo);
}

/** 成书 / 出版年——列表里「成书」与「所记事件」必须能一眼分开。 */
function createdYear(src: Source): number | undefined {
  return src.temporal?.createdYearFrom ?? src.year;
}

/** 轨道徽章文案 key。 */
function tierLabelKey(tier: SourceTier): string {
  return tier === 'primary' ? 'source.tier.primary' : 'source.tier.secondary';
}

/** 类型标签：按轨道取对应的 label map（缺失时回退到「其他」）。 */
function kindLabel(src: Source, t: TFunc): string {
  if (src.tier === 'primary') {
    return primaryKindLabels[src.primaryKind ?? 'other-primary'] ?? t('source.primaryKind');
  }
  return secondaryKindLabels[src.secondaryKind ?? 'other-secondary'] ?? t('source.secondaryKind');
}

/** 是否缺少「可引用」所必需的馆藏信息（一手史料的硬要求）。 */
function provenanceMissing(src: Source): boolean {
  if (src.tier !== 'primary') return false;
  const p = src.provenance;
  // 只要机构或馆藏号任一存在，就算立得住脚；两者全无 = 不可引用
  return !has(p?.repository) && !has(p?.callNumber);
}

/** 详情/列表都用的状态点颜色。 */
function sourceStatusColor(status: SourceStatus | undefined): string {
  switch (status) {
    case 'published': return T.success;
    case 'annotated': return T.teal;
    case 'transcribed': return T.business;
    case 'transcribing': return T.warning;
    default: return 'rgba(127,127,127,.85)'; // unprocessed / 未填
  }
}

/** 证据等级配色：A 直接证据最重，D 存疑最轻。 */
function gradeColor(grade: EvidenceGrade | undefined): string {
  switch (grade) {
    case 'A': return T.success;
    case 'B': return T.business;
    case 'C': return T.warning;
    case 'D': return T.danger;
    default: return T.caption;
  }
}

/**
 * 逐字稿状态 → 文案 key。
 * 有 transcriptId 即视为已出稿（校对进度属于逐字稿视图的职责，这里不重复计算）。
 */
function transcriptStatusKey(iv: Interview): string {
  return iv.transcriptId ? 'iv.transcript' : 'iv.transcriptNone';
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

/** 表单草稿：数组字段在编辑期以逗号串保存，提交时再切分。 */
interface Draft {
  tier: SourceTier;
  primaryKind: PrimaryKind;
  secondaryKind: SecondaryKind;
  title: string;
  authors: string;
  tags: string;
  language: string;
  importance: number;
  status: SourceStatus | '';
  evidenceGrade: EvidenceGrade | '';
  summary: string;
  abstract: string;
  notes: string;
  // 二手
  doi: string;
  venue: string;
  year: string;
  arxivId: string;
  url: string;
  // 一手：时间定位
  eventYearFrom: string;
  eventYearTo: string;
  createdYearFrom: string;
  createdYearTo: string;
  originalEra: string;
  // 一手：馆藏
  repository: string;
  callNumber: string;
  edition: string;
  medium: string;
  accessNote: string;
  digitizationNote: string;
  // 分区（存名称，服务端按名称自动建档）
  collectionNames: string[];
}

function draftFrom(src: Source | null, defaultCollection: string): Draft {
  const s = src;
  return {
    tier: s?.tier ?? 'primary',
    primaryKind: s?.primaryKind ?? 'oral-history',
    secondaryKind: s?.secondaryKind ?? 'journal-article',
    title: s?.title ?? '',
    authors: (s?.authors ?? []).join(', '),
    tags: (s?.tags ?? []).join(', '),
    language: s?.language ?? '',
    importance: s?.importance ?? 3,
    status: s?.status ?? 'unprocessed',
    evidenceGrade: s?.evidenceGrade ?? '',
    summary: s?.summary ?? '',
    abstract: s?.abstract ?? '',
    notes: s?.notes ?? '',
    doi: s?.doi ?? '',
    venue: s?.venue ?? '',
    year: s?.year !== undefined ? String(s.year) : '',
    arxivId: s?.arxivId ?? '',
    url: s?.url ?? '',
    eventYearFrom: s?.temporal?.eventYearFrom !== undefined ? String(s.temporal.eventYearFrom) : '',
    eventYearTo: s?.temporal?.eventYearTo !== undefined ? String(s.temporal.eventYearTo) : '',
    createdYearFrom: s?.temporal?.createdYearFrom !== undefined ? String(s.temporal.createdYearFrom) : '',
    createdYearTo: s?.temporal?.createdYearTo !== undefined ? String(s.temporal.createdYearTo) : '',
    originalEra: s?.temporal?.originalEra ?? '',
    repository: s?.provenance?.repository ?? '',
    callNumber: s?.provenance?.callNumber ?? '',
    edition: s?.provenance?.edition ?? '',
    medium: s?.provenance?.medium ?? '',
    accessNote: s?.provenance?.accessNote ?? '',
    digitizationNote: s?.provenance?.digitizationNote ?? '',
    // 新建且当前正选中某个分区时，预勾选它（Zotero 式「在新分区里新建」）
    collectionNames: defaultCollection ? [defaultCollection] : [],
  };
}

/* ==========================================================================
 * 主视图
 * ========================================================================== */

export function SourceLibraryView({ t }: { t: (key: string, params?: Record<string, unknown>) => string }) {
  const nav = useNav();

  /* ---------- 数据 ---------- */
  const [sources, setSources] = useState<Source[] | null>(null);
  const [allSources, setAllSources] = useState<Source[]>([]);
  const [collections, setCollections] = useState<SourceCollection[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  /** 非致命降级（collections / tags 加载失败）——不打断浏览，但必须可见 */
  const [degraded, setDegraded] = useState('');

  /* ---------- 视图模式 ---------- */
  const [mode, setMode] = useState<Mode>('list');
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [form, setForm] = useState<{ initial: Source | null } | null>(null);

  /* ---------- 布局 ---------- */
  const [railOpen, setRailOpen] = useState(true);
  /** 分区管理弹窗（新建 / 改名 / 改色 / 删除） */
  const [colModal, setColModal] = useState(false);

  /* ---------- 筛选 ---------- */
  const [saved] = useState(() => loadSavedFilters<Filters>(FILTERS_KEY));
  const [q, setQ] = useState(saved.q ?? EMPTY_FILTERS.q);
  const [tier, setTier] = useState<SourceTier | ''>(saved.tier ?? '');
  const [kind, setKind] = useState<AnyKind | ''>(saved.kind ?? '');
  const [tag, setTag] = useState(saved.tag ?? '');
  const [status, setStatus] = useState<SourceStatus | ''>(saved.status ?? '');
  const [grade, setGrade] = useState<EvidenceGrade | ''>(saved.grade ?? '');
  const [eventFrom, setEventFrom] = useState(saved.eventFrom ?? '');
  const [eventTo, setEventTo] = useState(saved.eventTo ?? '');
  const [col, setCol] = useState(saved.col ?? '');
  const [unfiled, setUnfiled] = useState(saved.unfiled ?? false);

  const debouncedQ = useDebounced(q, 250);

  /* ---------- 操作反馈 ---------- */
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 2600);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const shownError = actionError || loadError;

  /* ---------- 加载：分区 ---------- */
  const loadCollections = useCallback(async () => {
    try {
      const r = await api<{ collections: SourceCollection[] }>('/oral-history/collections');
      const list = r.collections ?? [];
      setCollections(list);
      // 当前筛选指向的分区可能已在别处被删——回落到「全部」而不是对着幽灵 id 空转
      setCol((cur) => (cur && !list.some((c) => c.id === cur) ? '' : cur));
    } catch (e) {
      console.warn('dsh-oral-history: collections load failed', e);
      setDegraded(t('common.partialLoadFailed'));
    }
  }, [t]);

  /* ---------- 加载：标签汇总 ---------- */
  const loadTags = useCallback(async () => {
    try {
      const r = await api<{ tags: string[] }>('/oral-history/tags?scope=sources');
      setTags(r.tags ?? []);
    } catch (e) {
      console.warn('dsh-oral-history: tags load failed', e);
      setDegraded(t('common.partialLoadFailed'));
    }
  }, [t]);

  /**
   * 排序。服务端的 SourceSort 只有 createdAt / year / title / eventYear 四种，
   * 但「重要度」是筛选史料时最常用的排序——所以它在前端排，
   * 其余四种交给服务端（并回落到服务端默认的 createdAt）。
   */
  const [sort, setSort] = useState<SortKey>(() => normalizeSort(saved.sort));

  /* ---------- 加载：列表 ---------- */
  const load = useCallback(async () => {
    const seq = ++loadSeq;
    setLoading(true);
    try {
      const query = qs({
        q: debouncedQ,
        tier: tier || undefined,
        // 类型筛选按当前轨道落到对应字段，服务端两个字段是分开的
        primaryKind: tier !== 'secondary' && kind ? kind : undefined,
        secondaryKind: tier !== 'primary' && kind ? kind : undefined,
        tag: tag || undefined,
        status: status || undefined,
        evidenceGrade: grade || undefined,
        eventYearFrom: eventFrom || undefined,
        eventYearTo: eventTo || undefined,
        collection: col || undefined,
        unfiled: unfiled ? 1 : undefined,
        sort: serverSort(sort),
      });
      const data = await api<{ total: number; sources: Source[] }>(`/oral-history/sources${query}`);
      if (seq !== loadSeq) return; // 已有更新请求，丢弃过期响应
      setSources(data.sources ?? []);
      setLoadError('');
    } catch (e) {
      if (seq !== loadSeq) return;
      setLoadError(e instanceof Error ? e.message : String(e));
      setSources([]);
    } finally {
      if (seq === loadSeq) setLoading(false);
    }
  }, [debouncedQ, tier, kind, tag, status, grade, eventFrom, eventTo, col, unfiled, sort]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadCollections(); }, [loadCollections]);
  useEffect(() => { void loadTags(); }, [loadTags]);

  /** 全量史料：分区计数与「未分区」计数必须用全量口径，不能跟着筛选走。 */
  const loadAll = useCallback(async () => {
    try {
      const r = await api<{ sources: Source[] }>('/oral-history/sources?sort=title');
      setAllSources(r.sources ?? []);
    } catch (e) {
      // 计数缺失不阻塞浏览，但要留痕
      console.warn('dsh-oral-history: full source load failed', e);
    }
  }, []);
  useEffect(() => { void loadAll(); }, [loadAll]);

  // 筛选/排序变化即落盘（会话级）
  useEffect(() => {
    saveFilters(FILTERS_KEY, { q, tier, kind, tag, status, grade, eventFrom, eventTo, col, unfiled, sort });
  }, [q, tier, kind, tag, status, grade, eventFrom, eventTo, col, unfiled, sort]);

  /* ---------- 详情 ---------- */
  const openDetail = useCallback(async (id: string) => {
    setActionError('');
    setMode('detail');
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await api<SourceDetail>(`/oral-history/sources/${encodeURIComponent(id)}`);
      setDetail(r);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setMode('list');
    setDetail(null);
    setActionError('');
  }, []);

  // 深链 / 跨视图跳转：nav.sourceId 变化即打开对应详情（消费后清空，避免重复触发）
  useEffect(() => {
    if (!nav.sourceId) return;
    void openDetail(nav.sourceId);
    navBus.consumeSourceId();
  }, [nav.sourceId, openDetail]);

  /* ---------- 写入 ---------- */
  const saveSource = useCallback(async (payload: Record<string, unknown>, id: string | null) => {
    const path = id ? `/oral-history/sources/${encodeURIComponent(id)}` : '/oral-history/sources';
    const res = await api<CreateResult>(path, {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    return res;
  }, []);

  const afterWrite = useCallback(async (id: string | null) => {
    setForm(null);
    await Promise.all([load(), loadAll(), loadCollections(), loadTags()]);
    refreshCounts();
    if (id) await openDetail(id);
    else setMode('list');
  }, [load, loadAll, loadCollections, loadTags, openDetail]);

  const removeSource = useCallback(async (src: Source) => {
    if (!window.confirm(`${t('common.confirmDelete')}\n${src.title}`)) return;
    try {
      await api(`/oral-history/sources/${encodeURIComponent(src.id)}`, { method: 'DELETE' });
      setActionError('');
      closeDetail();
      await Promise.all([load(), loadAll()]);
      refreshCounts();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }, [t, load, loadAll, closeDetail]);

  /* ---------- 派生 ---------- */
  /**
   * 渲染用的列表。`importance` 排序在此完成（服务端不支持），
   * 其余排序服务端已排好序，这里原样透传。
   */
  const list = useMemo(() => {
    const rows = sources ?? [];
    if (sort !== 'importance') return rows;
    return [...rows].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)
      || b.createdAt - a.createdAt
      || a.title.localeCompare(b.title));
  }, [sources, sort]);
  const filtersActive = !!(tier || kind || tag || status || grade || eventFrom || eventTo || unfiled || col);

  /** 当前轨道下「类型」下拉可选项：一手 / 二手 / 两者并集。 */
  const kindOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    if (tier === 'primary') {
      for (const k of PRIMARY_KINDS) opts.push({ value: k, label: primaryKindLabels[k] });
    } else if (tier === 'secondary') {
      for (const k of SECONDARY_KINDS) opts.push({ value: k, label: secondaryKindLabels[k] });
    } else {
      for (const k of PRIMARY_KINDS) opts.push({ value: k, label: primaryKindLabels[k] });
      for (const k of SECONDARY_KINDS) opts.push({ value: k, label: secondaryKindLabels[k] });
    }
    return opts;
  }, [tier]);

  // 切换轨道后，原来的类型值可能在新轨道里不存在——清掉而不是留着空结果
  useEffect(() => {
    if (!kind) return;
    const valid: readonly string[] = tier === 'primary' ? PRIMARY_KINDS
      : tier === 'secondary' ? SECONDARY_KINDS
        : [...PRIMARY_KINDS, ...SECONDARY_KINDS];
    if (!valid.includes(kind)) setKind('');
  }, [tier, kind]);

  const activeCollection = collections.find((c) => c.id === col) ?? null;

  const countFor = useCallback((pred: (s: Source) => boolean) => allSources.filter(pred).length, [allSources]);

  const clearAll = useCallback(() => {
    setQ(''); setTier(''); setKind(''); setTag(''); setStatus(''); setGrade('');
    setEventFrom(''); setEventTo(''); setCol(''); setUnfiled(false);
  }, []);

  /* ======================================================================
   * 列表行
   * ====================================================================== */
  const renderRow = (src: Source, i: number) => {
    const bar = tierColor(src.tier, src.primaryKind);
    const isPrimary = src.tier === 'primary';
    const ev = eventRange(src);
    const cv = createdYear(src);
    // 成书年只在「与所记事件年不同」时才单独显示，避免 1958 / 1958 的冗余
    const showCreated = cv !== undefined && String(cv) !== ev;
    const prov = src.provenance;
    const provLine = [prov?.repository, prov?.callNumber].filter(has).join(' · ');
    const warnProv = provenanceMissing(src);
    const stColor = sourceStatusColor(src.status);

    return (
      <button
        key={src.id}
        type="button"
        data-dsh-plugin="dsh-oral-history"
        data-dsh-part="source-card"
        className="sch-card sch-press"
        onClick={() => void openDetail(src.id)}
        style={{
          position: 'relative', display: 'block', width: '100%', textAlign: 'left',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
          borderRadius: 12, marginBottom: 9, cursor: 'pointer',
          color: 'var(--dsh-alias-label-primary)', overflow: 'hidden',
          padding: '11px 12px 10px 16px',
          ['--sch-i' as string]: Math.min(i, 20),
        }}
      >
        {/* 左侧色条：轨道 + 载体类型，扫一眼就能分拣 */}
        <span aria-hidden style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: bar,
        }} />

        {/* 标题行 */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <TierBadge tier={src.tier} t={t} />
          <span style={{
            flex: 'none', fontSize: 9.5, fontWeight: 600, padding: '1px 6px', borderRadius: 5,
            color: T.secondary, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
            border: '1px solid var(--dsw-alias-border-l2)', whiteSpace: 'nowrap',
          }}>{kindLabel(src, t)}</span>
          <span style={{
            flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13, lineHeight: 1.45, letterSpacing: '.003em',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{src.title}</span>
          {src.importance ? <Stars value={src.importance} size={10} /> : null}
        </div>

        {/* 作者 / 口述者 */}
        <div style={{ fontSize: 11, color: T.secondary, marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {src.authors.length
              ? `${src.authors.slice(0, 3).join('、')}${src.authors.length > 3 ? ' 等' : ''}`
              : t('source.noAuthors')}
          </span>
          {src.source === 'agent' && (
            <span title={t('source.sourceAgent')} style={{ display: 'inline-flex', flex: 'none' }}>
              <Icon d={Icons.sparkle} size={10} color={T.business} />
            </span>
          )}
          {stColor && (
            <span title={src.status ? sourceStatusLabels[src.status] : t('common.unknown')} style={{
              flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 3,
              fontSize: 9.5, color: stColor,
            }}>
              <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: stColor }} />
              {src.status ? sourceStatusLabels[src.status] : t('common.unknown')}
            </span>
          )}
          {src.evidenceGrade && (
            <span style={{
              flex: 'none', fontSize: 9, fontWeight: 700, padding: '0 5px', borderRadius: 4,
              color: gradeColor(src.evidenceGrade),
              background: `color-mix(in srgb, ${gradeColor(src.evidenceGrade)} 14%, transparent)`,
              border: `1px solid color-mix(in srgb, ${gradeColor(src.evidenceGrade)} 32%, transparent)`,
            }} title={t('source.evidenceGrade')}>{src.evidenceGrade}</span>
          )}
        </div>

        {/* 时间定位：所记事件年代 vs 成书年代，必须能分清 */}
        <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5 }}>
          {has(src.temporal?.originalEra) ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, color: T.teal, fontWeight: 600,
            }}>
              <Icon d={Icons.timeline} size={10} color={T.teal} />
              {src.temporal?.originalEra}
              {ev && <span style={{ color: T.caption, fontWeight: 400 }}>({ev})</span>}
            </span>
          ) : ev ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: T.secondary }}>
              <Icon d={Icons.timeline} size={10} color={T.caption} />
              <span style={{ color: T.caption }}>{t('source.temporal.eventFrom').replace(/起$/, '')}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: T.primary }}>{ev}</span>
            </span>
          ) : (
            <span style={{ color: T.caption }}>{t('source.temporalNone')}</span>
          )}
          {showCreated && (
            <span style={{ color: T.caption, fontVariantNumeric: 'tabular-nums' }}>
              {t('source.createdYear', { year: cv })}
            </span>
          )}
        </div>

        {/* 馆藏：一手史料可引用性的关键；缺失时必须显眼 */}
        {provLine ? (
          <div style={{
            marginTop: 5, fontSize: 10.5, display: 'flex', alignItems: 'center', gap: 5,
            color: T.secondary, minWidth: 0,
          }}>
            <Icon d={Icons.archive} size={10} color={T.caption} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {prov?.repository}
              {has(prov?.repository) && has(prov?.callNumber) ? ' · ' : ''}
              {has(prov?.callNumber) && (
                <span style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10,
                  padding: '0 4px', borderRadius: 4,
                  background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14))',
                }}>{prov?.callNumber}</span>
              )}
            </span>
          </div>
        ) : warnProv ? (
          <div style={{
            marginTop: 5, fontSize: 10.5, display: 'inline-flex', alignItems: 'center', gap: 4,
            color: T.warning,
          }}>
            <Icon d={Icons.caution} size={10} color={T.warning} />
            {t('source.provenanceMissing')}
          </div>
        ) : null}

        {/* 标签 / 分区色点 */}
        {(src.tags.length > 0 || (src.collectionIds ?? []).length > 0) && (
          <div style={{ display: 'flex', gap: 4, marginTop: 7, flexWrap: 'wrap', alignItems: 'center' }}>
            {(src.collectionIds ?? []).map((cid) => {
              const c = collections.find((x) => x.id === cid);
              if (!c) return null;
              return (
                <span key={cid} title={c.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <span aria-hidden style={{
                    width: 6, height: 6, borderRadius: 999,
                    background: c.color ?? 'var(--dsw-alias-label-caption)',
                  }} />
                </span>
              );
            })}
            {src.tags.slice(0, 5).map((tg) => <Chip key={tg} label={tg} />)}
            {src.tags.length > 5 && <span style={{ fontSize: 10, color: T.caption }}>+{src.tags.length - 5}</span>}
          </div>
        )}
      </button>
    );
  };

  /* ======================================================================
   * 详情
   * ====================================================================== */
  if (mode === 'detail') {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <SchStyles />
        <div className="sch-scroll sch-fade" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px 16px', fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <Btn onClick={closeDetail}><Icon d={Icons.back} size={12} /> {t('common.back')}</Btn>
            <span style={{ flex: 1 }} />
          </div>
          {shownError && <div style={{ color: T.danger, fontSize: 11, marginBottom: 8 }}>{shownError}</div>}
          {detailLoading && <div style={{ color: T.caption, fontSize: 11.5 }}>{t('common.loading')}</div>}
          {!detailLoading && !detail && !shownError && <EmptyState icon={<Icon d={Icons.archive} size={34} />} title={t('common.empty')} />}
          {detail && (
            <SourceDetailPane
              t={t}
              detail={detail}
              collections={collections}
              onEdit={() => setForm({ initial: detail.source })}
              onDelete={() => void removeSource(detail.source)}
              onChanged={() => { void openDetail(detail.source.id); void loadAll(); }}
              onError={setActionError}
              onNotice={showNotice}
            />
          )}
        </div>

        {form && (
          <SourceFormModal
            t={t}
            initial={form.initial}
            collections={collections}
            defaultCollectionName={activeCollection?.name ?? ''}
            onClose={() => setForm(null)}
            onSaved={afterWrite}
            save={saveSource}
          />
        )}
      </div>
    );
  }

  /* ======================================================================
   * 列表
   * ====================================================================== */
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SchStyles />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* ---------- 分区栏 ---------- */}
        {railOpen && (
          <div
            data-dsh-plugin="dsh-oral-history"
            data-dsh-part="collection-rail"
            className="sch-scroll"
            style={{
              width: 150, flex: 'none', borderRight: '1px solid var(--dsw-alias-border-l2)',
              padding: '8px 6px 10px', overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 4px 5px' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', color: T.caption }}>
                {t('source.collections')}
              </span>
              <span style={{ flex: 1 }} />
              <IconButton
                label={t('col.new')}
                size={18}
                onClick={() => setColModal(true)}
                icon={<Icon d={Icons.plus} size={10} />}
              />
            </div>

            <RailItem
              label={t('col.all')}
              count={countFor(() => true)}
              active={!col && !unfiled}
              onClick={() => { setCol(''); setUnfiled(false); }}
            />
            {collections.map((c) => (
              <RailItem
                key={c.id}
                label={c.name}
                color={c.color}
                count={countFor((s) => (s.collectionIds ?? []).includes(c.id))}
                active={col === c.id}
                onClick={() => { setUnfiled(false); setCol(col === c.id ? '' : c.id); }}
              />
            ))}
            <RailItem
              label={t('col.unfiled')}
              count={countFor((s) => (s.collectionIds ?? []).length === 0)}
              active={unfiled}
              dim
              onClick={() => { setCol(''); setUnfiled(!unfiled); }}
            />

            <button
              type="button"
              data-dsh-plugin="dsh-oral-history"
              data-dsh-part="rail-new-collection"
              onClick={() => setColModal(true)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 5, marginTop: 6,
                padding: '5px 7px', borderRadius: 8, fontSize: 11, cursor: 'pointer',
                background: 'transparent', border: '1px dashed var(--dsw-alias-border-l2)', color: T.business,
              }}
            >
              <Icon d={Icons.plus} size={10} /> {t('col.new')}
            </button>
          </div>
        )}

        {/* ---------- 主列 ---------- */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* 工具条 */}
          <div style={{ padding: '8px 10px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
            <IconButton
              label={t('source.rail')}
              active={railOpen}
              onClick={() => setRailOpen(!railOpen)}
              icon={<Icon d={Icons.rail} size={13} />}
            />
            <SearchInput value={q} onChange={setQ} placeholder={t('source.searchPh')} />
            <Btn
              tone="primary"
              onClick={() => { setActionError(''); setForm({ initial: null }); }}
            >
              <Icon d={Icons.plus} size={12} /> {t('source.add')}
            </Btn>
          </div>

          {/* 轨道切换——本视图最重要的控件 */}
          <div style={{ padding: '0 10px 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span title={t('source.tierHint')} style={{ fontSize: 10.5, color: T.caption, flex: 'none' }}>
              {t('source.tier')}
            </span>
            <TierToggle tier={tier} onChange={(v) => { setTier(v); setKind(''); }} t={t} />
          </div>

          {/* 次级筛选 */}
          <div style={{ padding: '0 10px 6px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as AnyKind | '')} title={t('source.primaryKind')} style={{ minWidth: 104 }}>
              <option value="">{t('source.kindAll')}</option>
              {kindOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value as SourceStatus | '')} title={t('source.status')} style={{ minWidth: 96 }}>
              <option value="">{t('source.statusAll')}</option>
              {SOURCE_STATUSES.map((s) => <option key={s} value={s}>{sourceStatusLabels[s]}</option>)}
            </Select>
            <Select value={grade} onChange={(e) => setGrade(e.target.value as EvidenceGrade | '')} title={t('source.evidenceGrade')} style={{ minWidth: 104 }}>
              <option value="">{t('source.evidenceGradeAll')}</option>
              {EVIDENCE_GRADES.map((g) => <option key={g} value={g}>{evidenceGradeLabels[g]}</option>)}
            </Select>
            <Select value={tag} onChange={(e) => setTag(e.target.value)} title={t('source.tagAll')} style={{ minWidth: 96 }}>
              <option value="">{t('source.tagAll')}</option>
              {tags.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
            </Select>
            <Select value={sort} onChange={(e) => setSort(e.target.value as SourceSort)} title={t('source.sort')} style={{ minWidth: 104 }}>
              <option value="createdAt">{t('source.sortCreated')}</option>
              <option value="eventYear">{t('source.sortEventYear')}</option>
              <option value="year">{t('source.sortYear')}</option>
              <option value="title">{t('source.sortTitle')}</option>
              <option value="importance">{t('source.sortImportance')}</option>
            </Select>
          </div>

          {/* 所记事件年代区间：科技史检索的主维度 */}
          <div style={{ padding: '0 10px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 10.5, color: T.caption, flex: 'none' }}>{t('source.eventYearAll')}</span>
            <Input
              type="number"
              value={eventFrom}
              placeholder={t('source.temporal.eventFrom')}
              title={t('source.temporal.hint')}
              onChange={(e) => setEventFrom(e.target.value)}
              style={{ width: 96 }}
            />
            <span style={{ color: T.caption }}>–</span>
            <Input
              type="number"
              value={eventTo}
              placeholder={t('source.temporal.eventTo')}
              title={t('source.temporal.hint')}
              onChange={(e) => setEventTo(e.target.value)}
              style={{ width: 96 }}
            />
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10.5, color: T.caption, fontVariantNumeric: 'tabular-nums' }}>
              {t('source.count', { count: list.length })}
            </span>
          </div>

          {/* 已生效的筛选 */}
          {filtersActive && (
            <div style={{ padding: '0 10px 7px', display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              {tier && <FilterChip label={t(tierLabelKey(tier))} onRemove={() => { setTier(''); setKind(''); }} />}
              {kind && (
                <FilterChip
                  label={tier === 'secondary' ? (secondaryKindLabels[kind as SecondaryKind] ?? kind) : (primaryKindLabels[kind as PrimaryKind] ?? kind)}
                  onRemove={() => setKind('')}
                />
              )}
              {status && <FilterChip label={sourceStatusLabels[status]} onRemove={() => setStatus('')} />}
              {grade && <FilterChip label={evidenceGradeLabels[grade]} onRemove={() => setGrade('')} />}
              {tag && <FilterChip label={`#${tag}`} onRemove={() => setTag('')} />}
              {(eventFrom || eventTo) && (
                <FilterChip
                  label={`${t('source.eventYearAll')} ${eventFrom || '…'}–${eventTo || '…'}`}
                  onRemove={() => { setEventFrom(''); setEventTo(''); }}
                />
              )}
              {col && <FilterChip label={activeCollection?.name ?? t('source.collections')} onRemove={() => setCol('')} />}
              {unfiled && <FilterChip label={t('col.unfiled')} onRemove={() => setUnfiled(false)} />}
              {q && <FilterChip label={q} onRemove={() => setQ('')} />}
              <button
                type="button"
                onClick={clearAll}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 10.5,
                  color: T.caption, textDecoration: 'underline', padding: '0 2px',
                }}
              >{t('col.all')}</button>
            </div>
          )}

          {shownError && <div style={{ color: T.danger, padding: '2px 12px 6px', fontSize: 11 }}>{shownError}</div>}
          {notice && !shownError && <div style={{ color: T.success, padding: '2px 12px 6px', fontSize: 11 }}>{notice}</div>}
          {degraded && !shownError && !notice && (
            <div style={{ color: T.warning, padding: '2px 12px 6px', fontSize: 11 }}>{degraded}</div>
          )}

          {/* 列表 */}
          <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 12px' }}>
            {loading && list.length === 0 && (
              <div aria-hidden>{[74, 66, 58].map((h, i) => <div key={i} className="sch-skeleton" style={{ height: h }} />)}</div>
            )}
            {!loading && list.length === 0 && !shownError && (
              // 有筛选的 0 结果 = 「没搜到」，不是「库是空的」——避免误导性空态
              q || filtersActive ? (
                <EmptyState icon={<Icon d={Icons.search} size={34} />} title={t('common.empty')} />
              ) : (
                <EmptyState
                  icon={<Icon d={Icons.archive} size={38} />}
                  title={t('common.empty')}
                  hint={t('source.temporal.hint')}
                  action={
                    <Btn tone="primary" onClick={() => { setActionError(''); setForm({ initial: null }); }}>
                      <Icon d={Icons.plus} size={12} /> {t('source.add')}
                    </Btn>
                  }
                />
              )
            )}
            <div key={`${debouncedQ}|${sort}|${tier}|${kind}|${col}|${unfiled}`} className="sch-fade sch-list">
              {list.map((s, i) => renderRow(s, i))}
            </div>
          </div>
        </div>
      </div>

      {/* ---------- 弹层 ---------- */}
      {colModal && (
        <CollectionsModal
          t={t}
          collections={collections}
          onClose={() => setColModal(false)}
          onChanged={() => { void loadCollections(); void loadAll(); void load(); }}
        />
      )}
      {form && (
        <SourceFormModal
          t={t}
          initial={form.initial}
          collections={collections}
          defaultCollectionName={activeCollection?.name ?? ''}
          onClose={() => setForm(null)}
          onSaved={afterWrite}
          save={saveSource}
        />
      )}
    </div>
  );
}

/* ==========================================================================
 * 轨道切换（分段控件）——一手 / 二手是史学研究的第一道分拣
 * ========================================================================== */
function TierToggle({ tier, onChange, t }: {
  tier: SourceTier | '';
  onChange: (v: SourceTier | '') => void;
  t: TFunc;
}) {
  const items: { value: SourceTier | ''; label: string; color: string }[] = [
    { value: '', label: t('source.tierAll'), color: T.secondary },
    { value: 'primary', label: t('source.tier.primary'), color: tierColor('primary', 'oral-history') },
    { value: 'secondary', label: t('source.tier.secondary'), color: tierColor('secondary') },
  ];
  return (
    <span
      data-dsh-plugin="dsh-oral-history"
      data-dsh-part="tier-toggle"
      title={t('source.tierHint')}
      style={{
        display: 'inline-flex', gap: 2, padding: 2, borderRadius: 9, flex: 'none',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
        border: '1px solid var(--dsw-alias-border-l2)',
      }}
    >
      {items.map((it) => {
        const active = tier === it.value;
        return (
          <button
            key={it.value || 'all'}
            type="button"
            onClick={() => onChange(it.value)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 10px',
              borderRadius: 7, cursor: active ? 'default' : 'pointer', border: 'none',
              fontSize: 11.5, fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
              background: active
                ? `color-mix(in srgb, ${it.color} 20%, var(--dsw-alias-bg-base, #161616))`
                : 'transparent',
              color: active ? it.color : T.secondary,
              boxShadow: active ? `inset 0 0 0 1px color-mix(in srgb, ${it.color} 45%, transparent)` : 'none',
              transition: 'background .13s ease, color .13s ease',
            }}
          >
            {it.value && (
              <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: it.color, opacity: active ? 1 : .5 }} />
            )}
            {it.label}
          </button>
        );
      })}
    </span>
  );
}

/** 轨道徽章：一手视觉权重明显高于二手（一手是本工作台的主战场）。 */
function TierBadge({ tier, t }: { tier: SourceTier; t: TFunc }) {
  const primary = tier === 'primary';
  const color = primary ? T.business : T.purple;
  return (
    <span
      title={primary ? t('source.tier.primary') : t('source.tier.secondary')}
      style={{
        flex: 'none', display: 'inline-flex', alignItems: 'center',
        fontSize: primary ? 10 : 9.5, fontWeight: primary ? 700 : 500,
        padding: primary ? '1.5px 7px' : '1px 6px', borderRadius: 5,
        letterSpacing: '.02em',
        color: primary ? '#fff' : color,
        background: primary ? color : `color-mix(in srgb, ${color} 13%, transparent)`,
        border: `1px solid ${primary ? color : `color-mix(in srgb, ${color} 34%, transparent)`}`,
      }}
    >
      {primary ? t('source.primaryBadge') : t('source.secondaryBadge')}
    </span>
  );
}

/** 侧栏单行：色点 + 名称 + 计数，选中态底色。 */
function RailItem({ label, count, color, active, dim, onClick }: {
  label: string;
  count: number;
  color?: string;
  active?: boolean;
  dim?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-dsh-plugin="dsh-oral-history"
      data-dsh-part="rail-item"
      title={label}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
        padding: '5px 7px', borderRadius: 8, marginBottom: 1,
        background: active ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14))' : 'transparent',
        border: 'none', cursor: 'pointer',
        color: dim ? T.secondary : 'var(--dsh-alias-label-primary)',
        fontSize: 11.5, fontWeight: active ? 600 : 400,
      }}
    >
      {color && <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: color, flex: 'none' }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontSize: 10, color: T.caption, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
    </button>
  );
}

/* ==========================================================================
 * 详情面板
 * ========================================================================== */
function SourceDetailPane({ t, detail, collections, onEdit, onDelete, onChanged, onError, onNotice }: {
  t: TFunc;
  detail: SourceDetail;
  collections: SourceCollection[];
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}) {
  const { source: s, interviews, cards } = detail;
  const [uploading, setUploading] = useState(false);
  const primary = s.tier === 'primary';
  const prov = s.provenance;
  const ev = eventRange(s);
  const cv = createdYear(s);
  const warnProv = provenanceMissing(s);
  const bar = tierColor(s.tier, s.primaryKind);

  /** 上传附件：octet-stream + x-file-ext 头（与服务端 readRawBody 的约定一致）。 */
  const upload = async (file: File | undefined) => {
    if (!file) return;
    // 客户端先挡一道，避免白等一次 200MB 的失败上传
    if (file.size > ATTACH_MAX_BYTES) {
      onError(t('source.fileSizeLimit'));
      return;
    }
    setUploading(true);
    onError('');
    try {
      const res = await fetch(`/oral-history/sources/${encodeURIComponent(s.id)}/attachment`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-file-ext': extOf(file.name) },
        body: file,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onNotice(t('source.fileReplace'));
      onChanged();
      refreshCounts();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="sch-fade" data-dsh-plugin="dsh-oral-history" data-dsh-part="source-detail">
      {/* 1. 头部 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span aria-hidden style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: bar, flex: 'none' }} />
        <span style={{ flex: 1, fontWeight: 700, fontSize: 14.5, lineHeight: 1.5, letterSpacing: '.005em' }}>
          {s.title}
        </span>
        <IconButton label={t('common.edit')} onClick={onEdit} icon={<Icon d={Icons.edit} size={14} />} />
        <IconButton label={t('common.delete')} color={T.danger} onClick={onDelete} icon={<Icon d={Icons.trash} size={14} />} />
      </div>

      <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <TierBadge tier={s.tier} t={t} />
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 6, color: T.secondary,
          background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
          border: '1px solid var(--dsw-alias-border-l2)',
        }}>{kindLabel(s, t)}</span>
        {s.status && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: sourceStatusColor(s.status) }}>
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: sourceStatusColor(s.status) }} />
            {sourceStatusLabels[s.status]}
          </span>
        )}
        {s.evidenceGrade && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 6,
            color: gradeColor(s.evidenceGrade),
            background: `color-mix(in srgb, ${gradeColor(s.evidenceGrade)} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${gradeColor(s.evidenceGrade)} 32%, transparent)`,
          }}>{evidenceGradeLabels[s.evidenceGrade]}</span>
        )}
        <Stars value={s.importance ?? 0} />
        <span style={{ flex: 1 }} />
        <Chip label={s.source === 'agent' ? t('source.sourceAgent') : t('source.sourceManual')} />
      </div>

      {s.tags.length > 0 && (
        <div style={{ marginTop: 7, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {s.tags.map((tg) => <Chip key={tg} label={tg} />)}
        </div>
      )}

      {/* 2. 时间定位 */}
      <Section
        title={t('source.temporal')}
        sub={t('source.temporal.hint')}
        icon={<Icon d={Icons.timeline} size={11} color={T.teal} />}
        accent={T.teal}
      >
        <Meta k={t('source.temporal.eventFrom')} v={s.temporal?.eventYearFrom !== undefined ? String(s.temporal.eventYearFrom) : undefined} />
        <Meta k={t('source.temporal.eventTo')} v={s.temporal?.eventYearTo !== undefined ? String(s.temporal.eventYearTo) : undefined} />
        <Meta k={t('source.temporal.createdFrom')} v={s.temporal?.createdYearFrom !== undefined ? String(s.temporal.createdYearFrom) : undefined} />
        <Meta k={t('source.temporal.createdTo')} v={s.temporal?.createdYearTo !== undefined ? String(s.temporal.createdYearTo) : undefined} />
        <Meta k={t('source.temporal.originalEra')} v={s.temporal?.originalEra} />
        {s.year !== undefined && <Meta k={t('source.year')} v={String(s.year)} />}
        {!ev && !has(s.temporal?.originalEra) && cv === undefined && (
          <div style={{ color: T.caption, fontSize: 11 }}>{t('source.temporalNone')}</div>
        )}
      </Section>

      {/* 3. 馆藏信息 */}
      <Section
        title={t('source.provenance')}
        icon={<Icon d={Icons.archive} size={11} color={warnProv ? T.warning : T.caption} />}
        accent={warnProv && primary ? T.warning : undefined}
      >
        {warnProv && primary && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 5, marginBottom: 7, fontSize: 11,
            color: T.warning, lineHeight: 1.55,
          }}>
            <Icon d={Icons.caution} size={12} color={T.warning} />
            <span>{t('source.provenanceRequired')}</span>
          </div>
        )}
        <Meta k={t('source.provenance.repository')} v={prov?.repository} />
        <Meta
          k={t('source.provenance.callNumber')}
          v={has(prov?.callNumber) ? (
            // 馆藏号是比 DOI 更可靠的去重键——等宽字体强化
            <span style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5,
              fontWeight: 600, padding: '1px 5px', borderRadius: 4,
              background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14))',
            }}>{prov?.callNumber}</span>
          ) : undefined}
        />
        <Meta k={t('source.provenance.edition')} v={prov?.edition} />
        <Meta k={t('source.provenance.medium')} v={prov?.medium} />
        <Meta k={t('source.provenance.accessNote')} v={prov?.accessNote} />
        <Meta k={t('source.provenance.digitizationNote')} v={prov?.digitizationNote} />
        {!prov?.repository && !prov?.callNumber && !prov?.edition && !prov?.medium && !prov?.accessNote && !prov?.digitizationNote && !primary && (
          <div style={{ color: T.caption, fontSize: 11 }}>{t('common.empty')}</div>
        )}
      </Section>

      {/* 4. 内容 */}
      {has(s.summary) && (
        <Section title={t('source.summary')} icon={<Icon d={Icons.sparkle} size={11} color={T.business} />} accent={T.business}>
          <div style={{ lineHeight: 1.65 }}>{s.summary}</div>
        </Section>
      )}
      {has(s.abstract) && (
        <Section title={t('source.abstract')}>
          <div style={{ lineHeight: 1.65, color: T.secondary }}>{s.abstract}</div>
        </Section>
      )}
      {has(s.notes) && (
        <Section title={t('source.notes')}>
          <div style={{ lineHeight: 1.6, color: T.secondary, whiteSpace: 'pre-wrap' }}>{s.notes}</div>
        </Section>
      )}

      {/* 5. 关联访谈 */}
      <Section
        title={t('source.interviews')}
        sub={t('source.count', { count: interviews.length })}
        icon={<Icon d={Icons.mic} size={11} color={T.business} />}
      >
        {interviews.length === 0 ? (
          <div style={{ color: T.caption, fontSize: 11, lineHeight: 1.6, marginBottom: 8 }}>
            {t('source.interviewsNone')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {interviews.map((iv) => {
              return (
                <div key={iv.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9, padding: '7px 9px',
                  background: T.cardBg,
                }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600 }}>
                      {iv.interviewee?.name ?? t('common.unknown')}
                      {iv.interviewYear ? (
                        <span style={{ color: T.caption, fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>
                          {' · '}{iv.interviewYear}
                        </span>
                      ) : null}
                    </span>
                    <span style={{ display: 'block', fontSize: 10.5, color: T.secondary, marginTop: 2 }}>
                      {[iv.location, t(transcriptStatusKey(iv))].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <Btn
                    tone={iv.transcriptId ? 'soft' : 'default'}
                    onClick={() => navBus.go('interviews', { interviewId: iv.id })}
                  >
                    <Icon d={Icons.waveform} size={11} /> {t('iv.transcriptOpen')}
                  </Btn>
                </div>
              );
            })}
          </div>
        )}
        <Btn tone="primary" onClick={() => navBus.go('interviews', { prefillInterviewSourceId: s.id })}>
          <Icon d={Icons.plus} size={11} /> {t('iv.new')}
        </Btn>
      </Section>

      {/* 6. 相关考据卡 */}
      <Section
        title={t('source.cards')}
        sub={t('source.count', { count: cards.length })}
        icon={<Icon d={Icons.cards} size={11} color={T.warning} />}
      >
        {cards.length === 0 ? (
          <div style={{ color: T.caption, fontSize: 11, lineHeight: 1.6, marginBottom: 8 }}>{t('source.cardsNone')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
            {cards.map((c) => (
              <button
                key={c.id}
                type="button"
                data-dsh-plugin="dsh-oral-history"
                data-dsh-part="source-card-ref"
                className="sch-press"
                onClick={() => navBus.go('cards', { cardId: c.id })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
                  border: '1px solid var(--dsw-alias-border-l2)', background: T.cardBg, borderRadius: 9,
                  padding: '7px 9px', cursor: 'pointer', color: 'var(--dsh-alias-label-primary)',
                }}
              >
                <span aria-hidden style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: T.warning, opacity: .6 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 600 }}>
                  {c.title}
                </span>
                <span style={{ flex: 'none', fontSize: 10, color: T.caption }}>{kindLabels[c.kind]}</span>
                <Stars value={c.importance} size={9} />
              </button>
            ))}
          </div>
        )}
        <Btn onClick={() => navBus.go('cards', { prefillSourceId: s.id })}>
          <Icon d={Icons.plus} size={11} /> {t('source.cardCreate')}
        </Btn>
      </Section>

      {/* 7. 附件（扫描件 / 录音） */}
      <Section title={t('source.file')} sub={t('source.fileHint')} icon={<Icon d={Icons.doc} size={11} color={T.caption} />}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {s.filePath ? (
            <a
              href={`/oral-history/sources/${encodeURIComponent(s.id)}/attachment`}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: T.business, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}
            >
              <Icon d={Icons.external} size={11} /> {t('source.fileOpen')}
              <span style={{ color: T.caption, fontSize: 10.5 }}>
                {s.filePath.split('/').pop()}
              </span>
            </a>
          ) : (
            <span style={{ color: T.caption, fontSize: 11 }}>{t('source.noFile')}</span>
          )}
          <label style={{
            cursor: uploading ? 'default' : 'pointer', color: T.business, fontSize: 11.5,
            display: 'inline-flex', alignItems: 'center', gap: 4, opacity: uploading ? .55 : 1,
          }}>
            <Icon d={Icons.download} size={11} />
            {uploading
              ? t('source.fileUploading')
              : s.filePath ? t('source.fileReplace') : t('source.fileUpload')}
            <input
              type="file"
              hidden
              disabled={uploading}
              onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }}
            />
          </label>
          <span style={{ fontSize: 10, color: T.caption }}>{t('source.attachmentHint')}</span>
        </div>
      </Section>

      {/* 8. 外部链接 */}
      {(has(s.doi) || has(s.arxivId) || has(s.url) || has(s.venue) || s.year !== undefined) && (
        <Section title={t('source.externalLinks')} icon={<Icon d={Icons.link} size={11} color={T.caption} />}>
          <Meta k={t('source.venue')} v={s.venue} />
          <Meta k={t('source.year')} v={s.year !== undefined ? String(s.year) : undefined} />
          <Meta
            k={t('source.doi')}
            v={has(s.doi) ? (
              <a href={doiHref(s.doi ?? '')} target="_blank" rel="noreferrer noopener"
                style={{ color: T.business, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                {s.doi} <Icon d={Icons.external} size={10} />
              </a>
            ) : undefined}
          />
          <Meta
            k={t('source.arxivId')}
            v={has(s.arxivId) ? (
              <a href={arxivHref(s.arxivId ?? '')} target="_blank" rel="noreferrer noopener"
                style={{ color: T.business, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                {s.arxivId} <Icon d={Icons.external} size={10} />
              </a>
            ) : undefined}
          />
          <Meta
            k={t('source.url')}
            v={has(s.url) ? (
              isHttpUrl(s.url ?? '') ? (
                <a href={s.url} target="_blank" rel="noreferrer noopener"
                  style={{ color: T.business, display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 230 }}>{s.url}</span>
                  <Icon d={Icons.external} size={10} />
                </a>
              ) : (
                // 非 http(s) 协议（agent 可能写入任意串）降级为纯文本，不可点击
                <span style={{ wordBreak: 'break-all' }}>{s.url}</span>
              )
            ) : undefined}
          />
          <Meta k={t('source.language')} v={s.language} />
        </Section>
      )}

      {/* 分区 */}
      <Section title={t('source.collections')} icon={<Icon d={Icons.stack} size={11} color={T.caption} />}>
        {(s.collectionIds ?? []).length === 0 ? (
          <div style={{ color: T.caption, fontSize: 11 }}>{t('source.collectionsNone')}</div>
        ) : (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(s.collectionIds ?? []).map((cid) => {
              const c = collections.find((x) => x.id === cid);
              return c ? <Chip key={cid} label={c.name} color={c.color} /> : null;
            })}
          </div>
        )}
      </Section>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Btn tone="primary" onClick={onEdit}><Icon d={Icons.edit} size={11} /> {t('common.edit')}</Btn>
        <Btn tone="danger" onClick={onDelete}><Icon d={Icons.trash} size={11} /> {t('common.delete')}</Btn>
      </div>
    </div>
  );
}

/* ==========================================================================
 * 分区管理（新建 / 改名 / 改色 / 删除）
 * ========================================================================== */
function CollectionsModal({ t, collections, onClose, onChanged }: {
  t: TFunc;
  collections: SourceCollection[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [cols, setCols] = useState<SourceCollection[]>(collections);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(COL_COLORS[0]);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ collections: SourceCollection[] }>('/oral-history/collections');
      setCols(r.collections ?? []);
      setErr('');
    } catch (e) {
      // 保留旧列表但不再静默——与「空列表」可区分
      console.warn('dsh-oral-history: collections refresh failed', e);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const res = await api<{ ok: boolean; collection?: SourceCollection }>('/oral-history/collections', {
        method: 'POST',
        body: JSON.stringify({ name, color: newColor }),
      });
      setNewName('');
      setErr('');
      // 同名分区会被服务端复用——明确告知，而不是假装新建成功
      setNote(res.collection && cols.some((c) => c.id === res.collection?.id) ? t('col.merged') : '');
      await refresh();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveEdit = async (id: string, patch: { name?: string; color?: string }) => {
    try {
      await api(`/oral-history/collections/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      setEditing(null);
      setErr('');
      await refresh();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string, name: string) => {
    // 删除分区不删史料——警告必须写清楚，否则没人敢点
    if (!window.confirm(`${t('common.confirmDelete')}\n${name}\n${t('col.deleteHint')}`)) return;
    try {
      await api(`/oral-history/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setErr('');
      await refresh();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal title={t('col.manage')} onClose={onClose} width={450}>
      <div className="sch-fade">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 }}>
          <Input
            value={newName}
            placeholder={t('col.addPh')}
            onChange={(e) => { setNewName(e.target.value); setNote(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          />
          <span style={{ display: 'inline-flex', gap: 3, flex: 'none' }}>
            {COL_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={t('col.color')}
                title={t('col.color')}
                onClick={() => setNewColor(c)}
                style={{
                  width: 15, height: 15, borderRadius: 999, background: c, padding: 0, cursor: 'pointer',
                  border: newColor === c ? '2px solid var(--dsw-alias-label-primary)' : 'none',
                }}
              />
            ))}
          </span>
          <Btn tone="primary" onClick={() => void create()} disabled={!newName.trim()}>
            <Icon d={Icons.plus} size={11} /> {t('col.new')}
          </Btn>
        </div>

        {err && <div style={{ color: T.danger, fontSize: 11, marginBottom: 8 }}>{err}</div>}
        {note && <div style={{ color: T.success, fontSize: 11, marginBottom: 8 }}>{note}</div>}

        <div style={{ fontSize: 10.5, color: T.caption, marginBottom: 8, lineHeight: 1.5 }}>{t('col.deleteHint')}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cols.length === 0 && <div style={{ color: T.caption, fontSize: 11.5 }}>{t('common.empty')}</div>}
          {cols.map((c) => (
            editing?.id === c.id ? (
              <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Input
                  value={editing.name}
                  autoFocus
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(c.id, { name: editing.name }); }}
                />
                <Btn tone="primary" onClick={() => void saveEdit(c.id, { name: editing.name })}>{t('common.save')}</Btn>
                <Btn onClick={() => setEditing(null)}>{t('common.cancel')}</Btn>
              </div>
            ) : (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9, padding: '6px 8px',
                background: T.cardBg,
              }}>
                <span aria-hidden style={{
                  width: 10, height: 10, borderRadius: 999, flex: 'none',
                  background: c.color ?? 'var(--dsw-alias-label-caption)',
                }} />
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </span>
                <span style={{ display: 'inline-flex', gap: 2, flex: 'none' }}>
                  {COL_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={t('col.color')}
                      onClick={() => void saveEdit(c.id, { color })}
                      style={{
                        width: 12, height: 12, borderRadius: 999, cursor: 'pointer', padding: 0,
                        background: color, opacity: c.color === color ? 1 : .45,
                        border: c.color === color ? '1.5px solid var(--dsw-alias-label-primary)' : 'none',
                      }}
                    />
                  ))}
                </span>
                <IconButton label={t('common.edit')} size={22} onClick={() => setEditing({ id: c.id, name: c.name })} icon={<Icon d={Icons.edit} size={13} />} />
                <IconButton label={t('common.delete')} size={22} color={T.danger} onClick={() => void remove(c.id, c.name)} icon={<Icon d={Icons.trash} size={13} />} />
              </div>
            )
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ==========================================================================
 * 新建 / 编辑表单
 * ========================================================================== */
function SourceFormModal({ t, initial, collections, defaultCollectionName, onClose, onSaved, save }: {
  t: TFunc;
  initial: Source | null;
  collections: SourceCollection[];
  defaultCollectionName: string;
  onClose: () => void;
  onSaved: (id: string | null) => void | Promise<void>;
  save: (payload: Record<string, unknown>, id: string | null) => Promise<CreateResult>;
}) {
  const [d, setD] = useState<Draft>(() => draftFrom(initial, initial ? '' : defaultCollectionName));
  const [invalid, setInvalid] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  /** 元数据抓取 */
  const [fetchSrc, setFetchSrc] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** 服务端判重：duplicate=true 且 updated=false 时给出「合并更新」出口 */
  const [dup, setDup] = useState<Source | null>(null);

  const isEdit = !!initial;
  const primary = d.tier === 'primary';

  const set = (patch: Partial<Draft>) => {
    setTouched(true);
    setDup(null);
    setD((cur) => ({ ...cur, ...patch }));
  };

  const tryClose = () => {
    if (touched && !window.confirm(t('common.confirmDiscard'))) return;
    onClose();
  };

  /**
   * 组装提交体。
   *
   * 两点必须小心：
   *  1. `undefined` 会被 JSON.stringify 丢掉——想表达"清空该字段"只能用 `''`/`null`。
   *  2. PUT 是部分更新（服务端 pickSubmitted 只接受实际出现的键），所以
   *     "另一轨的字段"必须显式提交空值才会被清掉，否则会出现
   *     primary + doi 并存的脏记录。
   * 因此：一手轨显式提交二手字段的空值，二手轨显式提交一手字段的空值。
   */
  const buildPayload = (patch?: { tier?: SourceTier }): Record<string, unknown> => {
    const tier = patch?.tier ?? d.tier;
    const isPrimary = tier === 'primary';

    const temporal = isPrimary ? {
      eventYearFrom: numOrUndef(d.eventYearFrom),
      eventYearTo: numOrUndef(d.eventYearTo),
      createdYearFrom: numOrUndef(d.createdYearFrom),
      createdYearTo: numOrUndef(d.createdYearTo),
      originalEra: has(d.originalEra) ? d.originalEra.trim() : '',
    } : null;

    const provenance = isPrimary ? {
      repository: has(d.repository) ? d.repository.trim() : '',
      callNumber: has(d.callNumber) ? d.callNumber.trim() : '',
      edition: has(d.edition) ? d.edition.trim() : '',
      medium: has(d.medium) ? d.medium.trim() : '',
      accessNote: has(d.accessNote) ? d.accessNote.trim() : '',
      digitizationNote: has(d.digitizationNote) ? d.digitizationNote.trim() : '',
    } : null;

    return {
      tier,
      // 轨道切换时另一轨的类型字段由服务端 applySourcePatch 清理；这里给空串即可
      primaryKind: isPrimary ? d.primaryKind : '',
      secondaryKind: isPrimary ? '' : d.secondaryKind,
      title: d.title.trim(),
      authors: splitList(d.authors),
      tags: splitList(d.tags),
      importance: d.importance,
      status: d.status || '',
      evidenceGrade: d.evidenceGrade || '',
      summary: d.summary,
      abstract: d.abstract,
      notes: d.notes,
      language: has(d.language) ? d.language.trim() : '',
      // 分区按名称提交；服务端 ensureCollectionNames 会自动建出未知名称
      collectionIds: d.collectionNames,

      // 一手字段：二手轨一律提交 null 以清除
      temporal,
      provenance,

      // 二手字段：一手轨一律提交 '' 以清除
      doi: isPrimary ? '' : (has(d.doi) ? d.doi.trim() : ''),
      venue: isPrimary ? '' : (has(d.venue) ? d.venue.trim() : ''),
      arxivId: isPrimary ? '' : (has(d.arxivId) ? d.arxivId.trim() : ''),
      url: isPrimary ? '' : (has(d.url) ? d.url.trim() : ''),
      // year 的空值必须是 null（undefined 会被 stringify 丢掉，服务端便当作"未提交"）
      year: isPrimary ? null : (numOrUndef(d.year) ?? null),
    };
  };

  const submit = async (opts?: { update?: boolean; tier?: SourceTier }) => {
    if (!d.title.trim()) { setInvalid(t('source.titleRequired')); return; }
    if (!d.tier) { setInvalid(t('source.tierRequired')); return; }
    setInvalid('');
    setErr('');
    setBusy(true);
    try {
      const payload = buildPayload(opts?.tier ? { tier: opts.tier } : undefined);
      if (opts?.update) payload.update = true;
      const res = await save(payload, initial?.id ?? null);
      // 判重：库中已有同一条（馆藏号 / DOI / 标题命中），且未要求合并
      if (res.duplicate && !res.updated) {
        setDup(res.source);
        setBusy(false);
        return;
      }
      await onSaved(res.source?.id ?? initial?.id ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  /** 抓取 DOI / arXiv 元数据（仅二手研究有 DOI）。 */
  const grabMeta = async () => {
    if (!fetchSrc.trim() || fetching) return;
    setFetching(true);
    setFetchNote(null);
    try {
      const r = await api<FetchedMeta & { error?: string }>(`/oral-history/fetch${qs({ input: fetchSrc.trim() })}`);
      if (!r || !r.title) throw new Error(r?.error ?? t('source.fetchFail'));
      setTouched(true);
      setD((cur) => ({
        ...cur,
        title: r.title || cur.title,
        authors: r.authors?.length ? r.authors.join(', ') : cur.authors,
        year: r.year !== undefined ? String(r.year) : cur.year,
        venue: r.venue ?? cur.venue,
        arxivId: r.arxivId ?? cur.arxivId,
        doi: r.doi ?? cur.doi,
        url: r.url ?? cur.url,
        abstract: r.abstract ?? cur.abstract,
      }));
      setFetchNote({ ok: true, text: t('source.fetchOk') });
      setFetchSrc('');
    } catch (e) {
      setFetchNote({ ok: false, text: `${t('source.fetchFail')}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setFetching(false);
    }
  };

  const toggleCollection = (name: string) => {
    setTouched(true);
    setD((cur) => ({
      ...cur,
      collectionNames: cur.collectionNames.includes(name)
        ? cur.collectionNames.filter((x) => x !== name)
        : [...cur.collectionNames, name],
    }));
  };

  return (
    <Modal title={initial ? t('source.edit') : t('source.new')} onClose={tryClose} width={560}>
      <div className="sch-fade" style={{ maxWidth: 520 }}>
        {/* 轨道——切换它会换掉类型下拉，并显隐馆藏区块 */}
        <Field label={t('source.tier')} hint={t('source.tierHint')}>
          <TierToggle
            tier={d.tier}
            onChange={(v) => { if (v) set({ tier: v }); }}
            t={t}
          />
        </Field>

        <Field label={t('source.new')}>
          <Input
            value={d.title}
            placeholder={t('source.titlePh')}
            autoFocus
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label={t('source.authors')}>
            <Input value={d.authors} placeholder={t('source.authorsPh')} onChange={(e) => set({ authors: e.target.value })} />
          </Field>
          <Field label={primary ? t('source.primaryKind') : t('source.secondaryKind')}>
            <Select
              value={primary ? d.primaryKind : d.secondaryKind}
              onChange={(e) => {
                const v = e.target.value;
                if (primary) set({ primaryKind: v as PrimaryKind });
                else set({ secondaryKind: v as SecondaryKind });
              }}
              style={{ width: '100%' }}
            >
              {primary
                ? PRIMARY_KINDS.map((k) => <option key={k} value={k}>{primaryKindLabels[k]}</option>)
                : SECONDARY_KINDS.map((k) => <option key={k} value={k}>{secondaryKindLabels[k]}</option>)}
            </Select>
          </Field>
        </div>

        {/* ---------- 一手：时间定位 ---------- */}
        {primary && (
          <Section title={t('source.temporal')} sub={t('source.temporal.hint')} icon={<Icon d={Icons.timeline} size={11} color={T.teal} />} accent={T.teal}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Field label={t('source.temporal.eventFrom')} hint={t('source.temporal.hint')}>
                <Input type="number" value={d.eventYearFrom} onChange={(e) => set({ eventYearFrom: e.target.value })} />
              </Field>
              <Field label={t('source.temporal.eventTo')}>
                <Input type="number" value={d.eventYearTo} onChange={(e) => set({ eventYearTo: e.target.value })} />
              </Field>
              <Field label={t('source.temporal.createdFrom')}>
                <Input type="number" value={d.createdYearFrom} onChange={(e) => set({ createdYearFrom: e.target.value })} />
              </Field>
              <Field label={t('source.temporal.createdTo')}>
                <Input type="number" value={d.createdYearTo} onChange={(e) => set({ createdYearTo: e.target.value })} />
              </Field>
            </div>
            <Field label={t('source.temporal.originalEra')}>
              <Input value={d.originalEra} placeholder={t('source.temporal.originalEraPh')} onChange={(e) => set({ originalEra: e.target.value })} />
            </Field>
          </Section>
        )}

        {/* ---------- 一手：馆藏 ---------- */}
        {primary && (
          <Section title={t('source.provenance')} icon={<Icon d={Icons.archive} size={11} color={T.caption} />}>
            <div style={{ fontSize: 10.5, color: T.warning, lineHeight: 1.5, marginBottom: 7 }}>
              {t('source.provenanceRequired')}
            </div>
            <Field label={t('source.provenance.repository')}>
              <Input value={d.repository} placeholder={t('source.provenance.repositoryPh')} onChange={(e) => set({ repository: e.target.value })} />
            </Field>
            <Field label={t('source.provenance.callNumber')} hint={t('source.provenance.callNumberPh')}>
              <Input value={d.callNumber} onChange={(e) => set({ callNumber: e.target.value })} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Field label={t('source.provenance.edition')}>
                <Input value={d.edition} onChange={(e) => set({ edition: e.target.value })} />
              </Field>
              <Field label={t('source.provenance.medium')}>
                <Input value={d.medium} onChange={(e) => set({ medium: e.target.value })} />
              </Field>
            </div>
            <Field label={t('source.provenance.accessNote')}>
              <Input value={d.accessNote} onChange={(e) => set({ accessNote: e.target.value })} />
            </Field>
            <Field label={t('source.provenance.digitizationNote')}>
              <Input value={d.digitizationNote} onChange={(e) => set({ digitizationNote: e.target.value })} />
            </Field>
          </Section>
        )}

        {/* ---------- 二手：DOI / 出版信息 ---------- */}
        {!primary && (
          <Section title={t('source.fetch')} sub={t('source.fetchHint')} icon={<Icon d={Icons.sparkle} size={11} color={T.business} />} accent={T.business}>
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                value={fetchSrc}
                placeholder={t('source.fetchPh')}
                onChange={(e) => { setFetchSrc(e.target.value); setFetchNote(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void grabMeta(); }}
              />
              <Btn tone="soft" disabled={fetching} onClick={() => void grabMeta()} style={{ flex: 'none' }}>
                <Icon d={fetching ? Icons.refresh : Icons.sparkle} size={12} className={fetching ? 'sch-spin' : undefined} />
                {fetching ? t('source.fetching') : t('source.fetch')}
              </Btn>
            </div>
            {fetchNote && (
              <div style={{ fontSize: 10.5, marginTop: 4, color: fetchNote.ok ? T.success : T.danger }}>{fetchNote.text}</div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
              <Field label={t('source.doi')}>
                <Input value={d.doi} onChange={(e) => set({ doi: e.target.value })} />
              </Field>
              <Field label={t('source.arxivId')}>
                <Input value={d.arxivId} onChange={(e) => set({ arxivId: e.target.value })} />
              </Field>
              <Field label={t('source.venue')}>
                <Input value={d.venue} onChange={(e) => set({ venue: e.target.value })} />
              </Field>
              <Field label={t('source.year')}>
                <Input type="number" value={d.year} onChange={(e) => set({ year: e.target.value })} />
              </Field>
            </div>
            <Field label={t('source.url')}>
              <Input value={d.url} onChange={(e) => set({ url: e.target.value })} />
            </Field>
          </Section>
        )}

        {/* ---------- 通用字段 ---------- */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <Field label={t('source.language')}>
            <Input value={d.language} onChange={(e) => set({ language: e.target.value })} />
          </Field>
          <Field label={t('source.status')}>
            <Select value={d.status} onChange={(e) => set({ status: e.target.value as SourceStatus | '' })} style={{ width: '100%' }}>
              <option value="">{t('source.statusAll')}</option>
              {SOURCE_STATUSES.map((s) => <option key={s} value={s}>{sourceStatusLabels[s]}</option>)}
            </Select>
          </Field>
          <Field label={t('source.evidenceGrade')}>
            <Select value={d.evidenceGrade} onChange={(e) => set({ evidenceGrade: e.target.value as EvidenceGrade | '' })} style={{ width: '100%' }}>
              <option value="">{t('source.evidenceGradeAll')}</option>
              {EVIDENCE_GRADES.map((g) => <option key={g} value={g}>{evidenceGradeLabels[g]}</option>)}
            </Select>
          </Field>
        </div>

        <Field label={t('source.importance')}>
          <Stars value={d.importance} onChange={(v) => set({ importance: v })} size={15} />
        </Field>

        <Field label={t('source.tags')}>
          <Input value={d.tags} placeholder={t('source.tagsPh')} onChange={(e) => set({ tags: e.target.value })} />
        </Field>

        <Field label={t('source.summary')}>
          <Textarea rows={2} value={d.summary} placeholder={t('source.summaryPh')} onChange={(e) => set({ summary: e.target.value })} style={{ minHeight: 46 }} />
        </Field>
        <Field label={t('source.abstract')}>
          <Textarea rows={3} value={d.abstract} onChange={(e) => set({ abstract: e.target.value })} style={{ minHeight: 62 }} />
        </Field>
        <Field label={t('source.notes')}>
          <Textarea rows={2} value={d.notes} onChange={(e) => set({ notes: e.target.value })} style={{ minHeight: 42 }} />
        </Field>

        <Field label={t('source.collections')}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {collections.length === 0 && <span style={{ fontSize: 11, color: T.caption }}>{t('common.empty')}</span>}
            {collections.map((c) => {
              const active = d.collectionNames.includes(c.name);
              return (
                <Chip
                  key={c.id}
                  label={c.name}
                  active={active}
                  color={active ? (c.color ?? T.business) : undefined}
                  onClick={() => toggleCollection(c.name)}
                />
              );
            })}
          </div>
        </Field>

        {/* 判重出口：库中已有同一条，让用户决定是否合并更新 */}
        {dup && (
          <div style={{
            border: `1px solid color-mix(in srgb, ${T.warning} 40%, transparent)`,
            background: `color-mix(in srgb, ${T.warning} 10%, transparent)`,
            borderRadius: 9, padding: '8px 10px', marginBottom: 8,
          }}>
            <div style={{ fontSize: 11, color: T.warning, lineHeight: 1.55, marginBottom: 6 }}>
              {t('source.duplicateHint')}
            </div>
            <div style={{ fontSize: 11, color: T.secondary, marginBottom: 7 }}>{dup.title}</div>
            <Btn tone="soft" disabled={busy} onClick={() => void submit({ update: true })}>
              <Icon d={Icons.refresh} size={11} /> {t('source.duplicateUpdate')}
            </Btn>
          </div>
        )}

        {invalid && <div style={{ color: T.danger, fontSize: 11, marginBottom: 6 }}>{invalid}</div>}
        {err && <div style={{ color: T.danger, fontSize: 11, marginBottom: 6 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, margin: '6px 0 10px' }}>
          <Btn tone="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? t('common.loading') : t('common.save')}
          </Btn>
          <Btn onClick={tryClose}>{t('common.cancel')}</Btn>
          {isEdit && <span style={{ flex: 1 }} />}
          {isEdit && (
            <span style={{ fontSize: 10.5, color: T.caption, alignSelf: 'center' }}>
              {t('source.importedBy')}: {initial?.source === 'agent' ? t('source.sourceAgent') : t('source.sourceManual')}
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default SourceLibraryView;
