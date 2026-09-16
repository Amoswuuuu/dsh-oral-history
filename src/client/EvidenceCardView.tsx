import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { CardKind, CardSort, CardStatus, EvidenceCard, Interview, Provenance, Source } from '../shared/types';
import { CARD_KINDS, CARD_STATUSES } from '../shared/types';
import { api, loadSavedFilters, qs, saveFilters } from './api';
import { navBus, useNav, type TFunc } from './nav';
import { refreshCounts } from './index';
import {
  Btn, Chip, EmptyState, Field, FilterChip, Icon, IconButton, Icons, Input, Meta, Modal,
  SchStyles, SearchInput, Section, Select, Stars, T, Textarea, categoryColor, labelStyle,
  statusColor, truncate,
} from './ui';
import { cardStatusLabels, kindLabels } from './locales';

/* ==========================================================================
 * 考据卡片视图（Zettelkasten 工作台）
 *
 * 史学语境：一张卡不是"想法"，而是一个**论证单元**——引文 + 考释 + 反证。
 * 因此详情页的顺序是固定的：引文定位 → 证据原文 → 考释论证 → 论证角色 → 反证。
 * 本视图最重要的交互是「定位到逐字稿」：把考据卡钉回史料本身，
 * 让"证据—出处"这条链永远可回溯，而不是让卡片变成无源的断言。
 * ========================================================================== */

const FILTERS_KEY = 'oh-card-filters';

type ViewMode = 'board' | 'list' | 'table';
type GroupBy = 'status' | 'kind' | 'tag';

interface SavedFilters {
  q: string;
  kind: string;
  status: string;
  tag: string;
  importance: string;
  sort: string;
  view: string;
  groupBy: string;
}

/** 看板列：自动宽度 + 横向滚动，最少 4 列宽以容纳分组维度切换 */
const BOARD_MIN_COLS = 4;
/** 卡片下拉（新建表单的来源史料 / 访谈 / 关联卡）的候选上限 */
const SOURCE_LIMIT = 200;
const CARD_LIMIT = 500;

const VIEW_MODES: { id: ViewMode; label: string; icon: string }[] = [
  { id: 'board', label: 'card.view', icon: Icons.kanban },
  { id: 'list', label: 'card.list', icon: Icons.list },
  { id: 'table', label: 'card.table', icon: Icons.table },
];

const GROUP_BYS: { id: GroupBy; label: string }[] = [
  { id: 'status', label: 'card.groupStatus' },
  { id: 'kind', label: 'card.groupKind' },
  { id: 'tag', label: 'card.groupTag' },
];

const SORTS: { id: CardSort; label: string }[] = [
  { id: 'createdAt', label: 'card.sortCreated' },
  { id: 'importance', label: 'card.sortImportance' },
  { id: 'title', label: 'card.sortTitle' },
];

/** 无标签卡片在看板"按标签"分组里的兜底列键（分组键与卡片 id 不可能撞） */
const NO_TAG = '__oh_no_tag__';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

/**
 * 判断 citation 是否指向逐字稿分段。
 * 服务端产出的分段 id 形如 `sg_0001_ab12`（见 store.newSegmentId）；
 * AI 与研究者手工标注时则常写 `seg_3` / `segment 12`——两种都要认，
 * 因为手工标注恰恰是最常见的引文定位写法。
 */
function isSegmentCitation(s: string | undefined): boolean {
  if (!s) return false;
  return /^(sg|seg|segment)[\s_-]*\d+/i.test(s.trim());
}

/* ---------- 小构件 ---------- */

/** 状态药丸（看板卡片 / 列表行 / 表格共用）；文案取自 cardStatusLabels */
function StatusPill({ status }: { status: CardStatus }) {
  const c = statusColor(status);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
      borderRadius: 999, padding: '1px 7px', fontSize: 9.5, fontWeight: 600, color: c,
      background: `color-mix(in srgb, ${c} 14%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 34%, transparent)`,
      whiteSpace: 'nowrap',
    }}>
      <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: c }} />
      {cardStatusLabels[status]}
    </span>
  );
}

/** 区块内的空值提示：反制"看不见的缺失"——史学研究里沉默的证据同样重要 */
function Missing({ text, icon }: { text: string; icon: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: T.caption, fontStyle: 'italic' }}>
      <Icon d={icon} size={11} color={T.caption} />
      {text}
    </div>
  );
}

export function EvidenceCardView({ t }: { t: TFunc }) {
  const nav = useNav();

  /* ---------- 筛选/视图状态（会话级持久） ---------- */
  const [saved] = useState(() => loadSavedFilters<SavedFilters>(FILTERS_KEY));
  const [q, setQ] = useState(saved.q ?? '');
  const [kind, setKind] = useState(saved.kind ?? '');
  const [status, setStatus] = useState(saved.status ?? '');
  const [tag, setTag] = useState(saved.tag ?? '');
  const [importance, setImportance] = useState(saved.importance ?? '');
  const [sort, setSort] = useState<CardSort>((saved.sort as CardSort) ?? 'createdAt');
  const [view, setView] = useState<ViewMode>((saved.view as ViewMode) ?? 'board');
  const [groupBy, setGroupBy] = useState<GroupBy>((saved.groupBy as GroupBy) ?? 'status');

  const debouncedQ = useDebounced(q, 250);

  /* ---------- 数据 ---------- */
  const [cards, setCards] = useState<EvidenceCard[] | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState('');
  /** 下拉候选（来源史料 / 全部卡片标题）加载失败时的降级提示 */
  const [degraded, setDegraded] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [allCards, setAllCards] = useState<EvidenceCard[]>([]);
  const [busy, setBusy] = useState('');

  /* ---------- 弹窗 ---------- */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form, setForm] = useState<{ card: EvidenceCard | null } | null>(null);
  /** POST 返回的相似卡提醒（非阻塞，防重复建卡） */
  const [similar, setSimilar] = useState<{ id: string; title: string; score: number }[]>([]);
  const [dropError, setDropError] = useState('');

  /* ---------- 看板拖拽 ---------- */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  /** 刚落位的卡片：播放 sch-dropped 弹簧脉冲后清除 */
  const [droppedId, setDroppedId] = useState<string | null>(null);
  const droppedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragIdRef = useRef<string | null>(null);
  dragIdRef.current = dragId;

  useEffect(() => () => { if (droppedTimer.current) clearTimeout(droppedTimer.current); }, []);

  /* ---------- 加载 ---------- */

  // 请求序号：慢响应回来时不许覆盖新的筛选结果
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const data = await api<{ total: number; cards: EvidenceCard[] }>(
        `/oral-history/cards${qs({ q: debouncedQ, kind, tag, importance, status, sort, limit: CARD_LIMIT })}`,
      );
      if (seq !== loadSeq.current) return;
      setCards(data.cards ?? []);
      setError('');
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setCards([]);
      setError(errText(e));
    }
  }, [debouncedQ, kind, tag, importance, status, sort]);

  useEffect(() => { void load(); }, [load]);

  const loadTags = useCallback(async () => {
    try {
      const r = await api<{ tags: string[] }>('/oral-history/tags?scope=cards');
      setTags(r.tags ?? []);
    } catch {
      /* 标签下拉非关键路径：失败即空列表 */
    }
  }, []);
  useEffect(() => { void loadTags(); }, [loadTags]);

  /** 关联卡片 / 来源史料标题解析需要全量标题（不受筛选影响） */
  const loadLookups = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([
        api<{ cards: EvidenceCard[] }>(`/oral-history/cards${qs({ sort: 'title', limit: CARD_LIMIT })}`),
        api<{ sources: Source[] }>(`/oral-history/sources${qs({ sort: 'title', limit: SOURCE_LIMIT })}`),
      ]);
      setAllCards(c.cards ?? []);
      setSources(s.sources ?? []);
      setDegraded('');
    } catch (e) {
      console.warn('dsh-oral-history: card lookups failed', e);
      setDegraded(t('common.partialLoadFailed'));
    }
  }, [t]);
  useEffect(() => { void loadLookups(); }, [loadLookups]);

  const reloadAll = useCallback(async () => {
    await Promise.all([load(), loadTags(), loadLookups()]);
  }, [load, loadTags, loadLookups]);

  // 筛选/视图落盘（会话级）
  useEffect(() => {
    saveFilters(FILTERS_KEY, { q, kind, status, tag, importance, sort, view, groupBy });
  }, [q, kind, status, tag, importance, sort, view, groupBy]);

  /* ---------- 跨视图：从史料详情"建一张考据卡" ---------- */
  useEffect(() => {
    if (!nav.prefillSourceId) return;
    setForm({ card: null });
    navBus.consumePrefill();
  }, [nav.prefillSourceId]);

  /* ---------- 跨视图：深链打开某张卡 ---------- */
  const openDetail = useCallback((id: string) => {
    setDetailId(id);
    navBus.consumeCardId();
  }, []);

  useEffect(() => {
    if (nav.cardId) void openDetail(nav.cardId);
  }, [nav.cardId, openDetail]);

  /* ---------- 写入 ---------- */

  const applyStatus = useCallback(async (card: EvidenceCard, next: CardStatus): Promise<boolean> => {
    try {
      await api(`/oral-history/cards/${encodeURIComponent(card.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ status: next }),
      });
      // 乐观更新本地状态，看板立即可见（随后 load() 再对齐服务端）
      setCards((cur) => (cur ? cur.map((c) => (c.id === card.id ? { ...c, status: next } : c)) : cur));
      setError('');
      await load();
      refreshCounts();
      return true;
    } catch (e) {
      setDropError(errText(e));
      return false;
    }
  }, [load]);

  /** 看板落位：换状态。落位脉冲先播，请求失败则回滚并提示 */
  const onDropTo = useCallback((next: CardStatus | null) => {
    const id = dragIdRef.current;
    setDragId(null);
    setDropCol(null);
    if (!id || !next) return;
    const card = (cards ?? []).find((c) => c.id === id);
    if (!card || card.status === next) return;
    setDroppedId(id);
    if (droppedTimer.current) clearTimeout(droppedTimer.current);
    droppedTimer.current = setTimeout(() => setDroppedId((cur) => (cur === id ? null : cur)), 700);
    setDropError('');
    // 失败时用 load() 拉回真实状态，避免本地乐观更新与服务端不一致
    void applyStatus(card, next).then((ok) => { if (!ok) void load(); });
  }, [cards, applyStatus, load]);

  const changeImportance = useCallback(async (card: EvidenceCard, v: number) => {
    try {
      await api(`/oral-history/cards/${encodeURIComponent(card.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ importance: v }),
      });
      setCards((cur) => (cur ? cur.map((c) => (c.id === card.id ? { ...c, importance: v } : c)) : cur));
      refreshCounts();
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  const removeCard = useCallback(async (card: EvidenceCard) => {
    if (!window.confirm(t('common.confirmDelete'))) return;
    try {
      setBusy('delete');
      await api(`/oral-history/cards/${encodeURIComponent(card.id)}`, { method: 'DELETE' });
      setDetailId(null);
      setForm(null);
      await reloadAll();
      refreshCounts();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  }, [t, reloadAll]);

  /** 保存（新建 / 编辑）。draft.id 为空即新建 */
  const saveCard = useCallback(async (draft: EvidenceCard): Promise<boolean> => {
    const body = {
      title: draft.title,
      kind: draft.kind,
      content: draft.content,
      sourceId: draft.sourceId ?? '',
      interviewId: draft.interviewId ?? '',
      citation: draft.citation ?? '',
      quote: draft.quote ?? '',
      argumentRole: draft.argumentRole ?? '',
      counterEvidence: draft.counterEvidence ?? '',
      tags: draft.tags,
      importance: draft.importance,
      status: draft.status,
      notes: draft.notes ?? '',
      relatedCardIds: draft.relatedCardIds ?? [],
    };
    try {
      setBusy('save');
      if (draft.id) {
        await api(`/oral-history/cards/${encodeURIComponent(draft.id)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        setSimilar([]);
      } else {
        const res = await api<{ card: EvidenceCard; similar?: { id: string; title: string; score: number }[] }>(
          '/oral-history/cards',
          { method: 'POST', body: JSON.stringify(body) },
        );
        // 相似卡提醒是非阻塞的：卡片已建成，只是提醒"同一段史料可能已建过卡"
        setSimilar(res.similar ?? []);
        if (res.card) setDetailId(res.card.id);
      }
      await reloadAll();
      refreshCounts();
      setError('');
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy('');
    }
  }, [reloadAll]);

  /* ---------- 派生数据 ---------- */

  const sourceOf = useCallback((id?: string): Source | undefined => {
    if (!id) return undefined;
    return sources.find((s) => s.id === id);
  }, [sources]);

  const sourceLabel = useCallback((s: Source): string => {
    const tier = s.tier === 'primary' ? t('source.tier.primary') : t('source.tier.secondary');
    return `${truncate(s.title, 42)} · ${tier}`;
  }, [t]);

  /** 看板列：按状态 / 类型 / 标签切分 */
  const columns = useMemo(() => {
    const list = cards ?? [];
    if (groupBy === 'kind') {
      return CARD_KINDS
        .map((k) => ({ key: k as string, label: kindLabels[k], color: categoryColor(k), list: list.filter((c) => c.kind === k), dropTo: null as CardStatus | null }))
        .filter((col) => col.list.length > 0);
    }
    if (groupBy === 'tag') {
      const keys = new Set<string>();
      for (const c of list) {
        if (c.tags.length) for (const tg of c.tags) keys.add(tg);
        else keys.add(NO_TAG);
      }
      return [...keys]
        .sort((a, b) => (a === NO_TAG ? 1 : b === NO_TAG ? -1 : a.localeCompare(b)))
        .map((k) => ({
          key: k,
          label: k === NO_TAG ? t('card.noTags') : `#${k}`,
          color: T.caption,
          list: list.filter((c) => (k === NO_TAG ? c.tags.length === 0 : c.tags.includes(k))),
          dropTo: null as CardStatus | null,
        }));
    }
    return CARD_STATUSES.map((s) => ({
      key: s as string,
      label: cardStatusLabels[s],
      color: statusColor(s),
      list: list.filter((c) => c.status === s),
      dropTo: s as CardStatus | null,
    }));
  }, [cards, groupBy, t]);

  /** 表格视图本地排序（不动服务端排序） */
  const [tableSort, setTableSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'createdAt', dir: -1 });
  const tableRows = useMemo(() => {
    const list = [...(cards ?? [])];
    const d = tableSort.dir;
    list.sort((a, b) => {
      switch (tableSort.key) {
        case 'title': return d * a.title.localeCompare(b.title);
        case 'kind': return d * kindLabels[a.kind].localeCompare(kindLabels[b.kind]) || a.title.localeCompare(b.title);
        case 'status': return d * a.status.localeCompare(b.status) || a.title.localeCompare(b.title);
        case 'importance': return d * (a.importance - b.importance) || a.title.localeCompare(b.title);
        default: return d * (a.createdAt - b.createdAt);
      }
    });
    return list;
  }, [cards, tableSort]);
  const toggleTableSort = (key: string) =>
    setTableSort((cur) => ({ key, dir: cur.key === key && cur.dir === -1 ? 1 : -1 }));

  const filtersActive = !!(kind || status || tag || importance);
  const activeCount = cards?.length ?? 0;
  const detailCard = detailId ? (cards ?? []).find((c) => c.id === detailId) ?? allCards.find((c) => c.id === detailId) ?? null : null;

  /* ---------- 工具栏 ---------- */

  const toolbar = (
    <div style={{ flex: 'none' }}>
      <div style={{ padding: '8px 10px 6px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <SearchInput value={q} onChange={setQ} placeholder={t('card.searchPh')} />
        <Select value={kind} onChange={(e) => setKind(e.target.value)} title={t('card.kindAll')} style={{ flex: 'none', minWidth: 92 }}>
          <option value="">{t('card.kindAll')}</option>
          {CARD_KINDS.map((k) => <option key={k} value={k}>{kindLabels[k]}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} title={t('card.statusAll')} style={{ flex: 'none', minWidth: 88 }}>
          <option value="">{t('card.statusAll')}</option>
          {CARD_STATUSES.map((s) => <option key={s} value={s}>{cardStatusLabels[s]}</option>)}
        </Select>
        <Select value={tag} onChange={(e) => setTag(e.target.value)} title={t('card.tagAll')} style={{ flex: 'none', minWidth: 90 }}>
          <option value="">{t('card.tagAll')}</option>
          {tags.map((tg) => <option key={tg} value={tg}>{tg}</option>)}
        </Select>
        <Select value={importance} onChange={(e) => setImportance(e.target.value)} title={t('card.importanceAll')} style={{ flex: 'none', minWidth: 84 }}>
          <option value="">{t('card.importanceAll')}</option>
          {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as CardSort)} title={t('card.sort')} style={{ flex: 'none', minWidth: 84 }}>
          {SORTS.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}
        </Select>
        <span style={{ flex: 1 }} />
        {/* 视图模式分段控件（与史料库同款节奏） */}
        <span style={{
          display: 'inline-flex', borderRadius: 8, padding: 2, flex: 'none',
          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
        }}>
          {VIEW_MODES.map((m) => (
            <IconButton
              key={m.id}
              label={t(m.label)}
              size={22}
              active={view === m.id}
              onClick={() => setView(m.id)}
              icon={<Icon d={m.icon} size={12} />}
            />
          ))}
        </span>
        <Btn tone="primary" onClick={() => { setSimilar([]); setForm({ card: null }); }}>
          <Icon d={Icons.plus} size={12} /> {t('card.add')}
        </Btn>
      </div>

      {/* 看板分组维度 + 活跃筛选摘要 */}
      <div style={{ padding: '0 10px 7px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {view === 'board' && (
          <>
            <span style={{ fontSize: 10, color: T.caption, letterSpacing: '.04em' }}>{t('card.groupBy')}</span>
            <span style={{ display: 'inline-flex', borderRadius: 8, padding: 2, background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))' }}>
              {GROUP_BYS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGroupBy(g.id)}
                  className="sch-press"
                  style={{
                    height: 20, padding: '0 8px', border: 'none', borderRadius: 6, cursor: 'pointer',
                    fontSize: 10.5, whiteSpace: 'nowrap',
                    background: groupBy === g.id ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 16%, transparent)' : 'transparent',
                    color: groupBy === g.id ? T.business : T.secondary,
                    fontWeight: groupBy === g.id ? 600 : 400,
                  }}
                >
                  {t(g.label)}
                </button>
              ))}
            </span>
          </>
        )}
        {filtersActive && (
          <>
            {kind && <FilterChip label={kindLabels[kind as CardKind]} onRemove={() => setKind('')} />}
            {status && <FilterChip label={cardStatusLabels[status as CardStatus]} onRemove={() => setStatus('')} />}
            {tag && <FilterChip label={`#${tag}`} onRemove={() => setTag('')} />}
            {importance && <FilterChip label={`★ ≥ ${importance}`} onRemove={() => setImportance('')} />}
          </>
        )}
      </div>
    </div>
  );

  /* ---------- 卡片渲染 ---------- */

  /** 看板卡片（可拖拽） */
  const renderBoardCard = (c: EvidenceCard, i: number) => (
    <button
      key={c.id}
      type="button"
      data-dsh-part="card-kanban-item"
      draggable
      onDragStart={(e) => {
        setDragId(c.id);
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', c.id);
        } catch { /* 某些宿主禁用 dataTransfer，不影响内部拖拽 */ }
      }}
      onDragEnd={() => { setDragId(null); setDropCol(null); }}
      onClick={() => void openDetail(c.id)}
      className={`sch-card sch-press${dragId === c.id ? ' sch-dragging' : ''}${droppedId === c.id ? ' sch-dropped' : ''}`}
      style={{
        textAlign: 'left', cursor: 'grab', border: '1px solid var(--dsw-alias-border-l2)',
        background: T.cardBg, borderRadius: 9, padding: '8px 9px',
        ['--sch-i' as string]: Math.min(i, 14),
        color: 'var(--dsw-alias-label-primary)',
      }}
    >
      <div style={{ fontSize: 11.5, fontWeight: 650, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {c.title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5 }}>
        <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: categoryColor(c.kind), flex: 'none' }} />
        <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '.02em', color: categoryColor(c.kind), whiteSpace: 'nowrap' }}>
          {kindLabels[c.kind]}
        </span>
        {c.quote && <span title={t('card.quote')} style={{ fontSize: 9, color: T.purple, fontWeight: 700 }}>❝</span>}
        {c.counterEvidence
          ? <span title={t('card.counterEvidence')} style={{ fontSize: 9, color: T.danger, fontWeight: 700 }}>⚖</span>
          : (c.status === 'settled' || c.status === 'corroborated')
            ? <span title={t('card.noCounterEvidence')} style={{ color: T.warning, display: 'inline-flex' }}><Icon d={Icons.caution} size={9} /></span>
            : null}
        <span style={{ flex: 1 }} />
        {c.sourceId && <Icon d={Icons.book} size={9} color={T.caption} />}
        <Stars value={c.importance} size={8} />
      </div>
      {c.citation && (
        <div style={{
          marginTop: 4, fontSize: 9, color: T.caption, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {truncate(c.citation, 30)}
        </div>
      )}
    </button>
  );

  /** 列表行 */
  const renderListRow = (c: EvidenceCard, i: number) => (
    <button
      key={c.id}
      type="button"
      onClick={() => void openDetail(c.id)}
      className="sch-card sch-press"
      style={{
        display: 'flex', alignItems: 'stretch', gap: 9, width: '100%', textAlign: 'left',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9, padding: '7px 9px 7px 0',
        background: T.cardBg, marginBottom: 5, cursor: 'pointer', color: 'var(--dsw-alias-label-primary)',
        ['--sch-i' as string]: Math.min(i, 14),
      }}
    >
      {/* 类型色条 */}
      <span aria-hidden style={{ width: 3, flex: 'none', borderRadius: '0 3px 3px 0', background: categoryColor(c.kind) }} />
      <span style={{ flex: 1, minWidth: 0, display: 'block' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.title}
          </span>
          <StatusPill status={c.status} />
          <Stars value={c.importance} size={9} />
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 9.5, color: T.caption }}>
          <span style={{ color: categoryColor(c.kind), fontWeight: 600 }}>{kindLabels[c.kind]}</span>
          {c.citation && (
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
              {c.citation}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {c.tags.slice(0, 3).map((tg) => <Chip key={tg} label={`#${tg}`} />)}
        </span>
      </span>
    </button>
  );

  /* ---------- 详情弹窗 ---------- */

  const detail = detailCard ? (
    <CardDetail
      card={detailCard}
      t={t}
      sourceOf={sourceOf}
      allCards={allCards}
      onClose={() => setDetailId(null)}
      onEdit={() => setForm({ card: detailCard })}
      onDelete={() => void removeCard(detailCard)}
      onImportance={(v) => void changeImportance(detailCard, v)}
      onOpenCard={(id) => void openDetail(id)}
      onSaved={() => void reloadAll()}
      error={error}
    />
  ) : null;

  /* ---------- 主体 ---------- */

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SchStyles />
      {toolbar}
      {error && !detailCard && <div style={{ color: T.danger, padding: '0 12px 6px', fontSize: 11 }}>{error}</div>}
      {degraded && <div style={{ color: T.warning, padding: '0 12px 6px', fontSize: 11 }}>{degraded}</div>}
      {dropError && (
        <div style={{ padding: '0 12px 6px', fontSize: 11, color: T.danger, display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icon d={Icons.caution} size={11} color={T.danger} />
          {dropError}
        </div>
      )}

      {/* 相似卡提醒（POST 后非阻塞横幅） */}
      {similar.length > 0 && (
        <div className="sch-fade" style={{
          margin: '0 10px 6px', padding: '7px 9px', borderRadius: 9, fontSize: 11,
          background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 36%, transparent)',
          display: 'flex', alignItems: 'flex-start', gap: 6,
        }}>
          <Icon d={Icons.caution} size={13} color={T.warning} />
          <div style={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>
            <span style={{ color: T.secondary }}>
              {t('card.similar') /* 标题列表以可点击链接紧随其后，避免在 t() 里拼 JSX */}
            </span>
            {similar.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => void openDetail(s.id)}
                style={{
                  border: 'none', background: 'none', cursor: 'pointer', padding: '0 2px',
                  color: T.business, fontSize: 11, textDecoration: 'underline',
                }}
              >
                {truncate(s.title, 24)}
              </button>
            ))}
          </div>
          <IconButton label={t('common.close')} size={18} onClick={() => setSimilar([])} icon={<Icon d={Icons.close} size={10} />} />
        </div>
      )}

      <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px 12px' }}>
        {cards === null && <div style={{ color: T.caption, padding: 12, fontSize: 11.5 }}>{t('common.loading')}</div>}
        {cards !== null && activeCount === 0 && (
          q || filtersActive
            ? <EmptyState icon={<Icon d={Icons.search} size={34} />} title={t('common.empty')} />
            : <EmptyState
                icon={<Icon d={Icons.cards} size={38} />}
                title={t('common.empty')}
                hint={t('card.contentPh')}
                action={<Btn tone="primary" onClick={() => setForm({ card: null })}><Icon d={Icons.plus} size={12} /> {t('card.add')}</Btn>}
              />
        )}

        {cards !== null && activeCount > 0 && (
          <div key={`${view}|${groupBy}|${debouncedQ}|${kind}|${status}|${tag}|${importance}|${sort}|${tableSort.key}${tableSort.dir}`} className="sch-fade">
            {/* ── 看板 ── */}
            {view === 'board' && (
              <div
                data-dsh-part="card-board"
                className="sch-stagger"
                style={{ display: 'flex', gap: 8, alignItems: 'stretch', minHeight: 300 }}
              >
                {columns.map((col) => {
                  const isDrop = dropCol === col.key;
                  const droppable = col.dropTo !== null;
                  return (
                    <div
                      key={col.key}
                      data-dsh-part="kanban-col"
                      data-col={col.key}
                      className={`sch-kanban-col${isDrop ? ' sch-drop-target' : ''}`}
                      onDragOver={(e) => {
                        // 只有"按状态"分组的列接受落位；其他维度的列不改变状态
                        if (!droppable || !dragIdRef.current) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        setDropCol(col.key);
                      }}
                      onDragLeave={() => setDropCol((cur) => (cur === col.key ? null : cur))}
                      onDrop={(e) => {
                        if (!droppable) return;
                        e.preventDefault();
                        onDropTo(col.dropTo);
                      }}
                      style={{
                        flex: `1 1 ${Math.max(120, Math.floor(560 / Math.max(BOARD_MIN_COLS, columns.length)))}px`,
                        minWidth: 118, display: 'flex', flexDirection: 'column',
                        borderRadius: 10, padding: 6,
                        border: `1px solid ${isDrop ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 55%, transparent)' : 'var(--dsw-alias-border-l2)'}`,
                        background: isDrop
                          ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 7%, transparent)'
                          : 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 4px 7px', fontSize: 10.5, color: T.caption, fontWeight: 600 }}>
                        <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: col.color, flex: 'none' }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.label}</span>
                        <span style={{ flex: 1 }} />
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{col.list.length}</span>
                      </div>
                      <div className="sch-scroll sch-stagger" style={{ flex: 1, minHeight: 60, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {col.list.map((c, i) => renderBoardCard(c, i))}
                        {col.list.length === 0 && (
                          <div style={{ fontSize: 10, color: T.caption, padding: '8px 4px', textAlign: 'center', opacity: .7 }}>
                            {t('common.empty')}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── 列表 ── */}
            {view === 'list' && (
              <div data-dsh-part="card-list" className="sch-stagger">
                {cards.map((c, i) => renderListRow(c, i))}
              </div>
            )}

            {/* ── 表格 ── */}
            {view === 'table' && (
              <div data-dsh-part="card-table" style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,2.2fr) 68px 66px minmax(84px,1.2fr) minmax(70px,1fr) 54px minmax(70px,1fr)', background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
                  {([
                    { key: 'title', label: t('card.col.title') },
                    { key: 'kind', label: t('card.col.kind') },
                    { key: 'status', label: t('card.col.status') },
                    { key: 'citation', label: t('card.col.citation') },
                    { key: 'source', label: t('card.col.source') },
                    { key: 'importance', label: t('card.col.importance') },
                    { key: 'tags', label: t('card.col.tags') },
                  ] as const).map((h) => {
                    const sortable = h.key === 'title' || h.key === 'kind' || h.key === 'status' || h.key === 'importance';
                    return (
                      <button
                        key={h.key}
                        type="button"
                        data-dsh-part="table-head"
                        onClick={sortable ? () => toggleTableSort(h.key) : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 3, padding: '6px 8px', fontSize: 10, fontWeight: 600,
                          color: T.caption, background: 'transparent', border: 'none',
                          cursor: sortable ? 'pointer' : 'default', textAlign: 'left', letterSpacing: '.03em',
                        }}
                      >
                        {h.label}
                        {sortable && <span style={{ opacity: tableSort.key === h.key ? 1 : 0, fontSize: 8 }}>{tableSort.dir === -1 ? '▼' : '▲'}</span>}
                      </button>
                    );
                  })}
                </div>
                <div className="sch-stagger">
                  {tableRows.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => void openDetail(c.id)}
                      data-dsh-part="card-table-row"
                      style={{
                        display: 'grid', gridTemplateColumns: 'minmax(120px,2.2fr) 68px 66px minmax(84px,1.2fr) minmax(70px,1fr) 54px minmax(70px,1fr)',
                        width: '100%', textAlign: 'left', alignItems: 'center',
                        padding: '5px 0', fontSize: 11, cursor: 'pointer', border: 'none',
                        borderBottom: '1px solid var(--dsw-alias-border-l1)',
                        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
                        ['--sch-i' as string]: Math.min(i, 16),
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = T.hoverBg; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span aria-hidden style={{ width: 3, height: 13, borderRadius: 2, background: categoryColor(c.kind), flex: 'none' }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 550 }}>{c.title}</span>
                      </span>
                      <span style={{ padding: '0 8px', fontSize: 10, color: categoryColor(c.kind), fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {kindLabels[c.kind]}
                      </span>
                      <span style={{ padding: '0 8px' }}><StatusPill status={c.status} /></span>
                      <span style={{ padding: '0 8px', fontSize: 9.5, color: T.caption, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.citation || '—'}
                      </span>
                      <span style={{ padding: '0 8px', fontSize: 9.5, color: T.caption, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {sourceOf(c.sourceId)?.title ?? (c.sourceId ? truncate(c.sourceId, 14) : t('card.noSource'))}
                      </span>
                      <span style={{ padding: '0 8px' }}><Stars value={c.importance} size={8} /></span>
                      <span style={{ padding: '0 8px', display: 'flex', gap: 3, overflow: 'hidden' }}>
                        {c.tags.slice(0, 2).map((tg) => <Chip key={tg} label={`#${tg}`} />)}
                        {c.tags.length > 2 && <span style={{ fontSize: 9, color: T.caption }}>+{c.tags.length - 2}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {detail}

      {/* 新建 / 编辑表单 */}
      {form && (
        <CardForm
          t={t}
          card={form.card}
          sources={sources}
          allCards={allCards}
          defaultSourceId={nav.prefillSourceId ?? ''}
          sourceLabel={sourceLabel}
          busy={busy === 'save'}
          error={error}
          onSave={async (draft) => {
            const ok = await saveCard(draft);
            // 保存成功后关闭表单；详情弹窗由 saveCard 内的 setDetailId 打开
            if (ok) setForm(null);
            return ok;
          }}
          onDelete={form.card ? () => void removeCard(form.card as EvidenceCard) : undefined}
          onClose={() => { setForm(null); setSimilar([]); setError(''); }}
        />
      )}
    </div>
  );
}

/* ==========================================================================
 * 卡片详情
 * ========================================================================== */

function CardDetail(props: {
  card: EvidenceCard;
  t: TFunc;
  sourceOf: (id?: string) => Source | undefined;
  allCards: EvidenceCard[];
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onImportance: (v: number) => void;
  onOpenCard: (id: string) => void;
  onSaved: () => void;
  error: string;
}) {
  const { card, t, sourceOf, allCards, onClose, onEdit, onDelete, onImportance, onOpenCard, onSaved, error } = props;
  const [linked, setLinked] = useState<EvidenceCard[] | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [relPick, setRelPick] = useState('');
  const [relBusy, setRelBusy] = useState(false);

  const loadDetail = useCallback(async () => {
    try {
      const r = await api<{ card: EvidenceCard; backlinks: EvidenceCard[]; source: Source | null }>(
        `/oral-history/cards/${encodeURIComponent(card.id)}`,
      );
      setLinked(r.backlinks ?? []);
      setSource(r.source ?? null);
      setLoadErr('');
    } catch (e) {
      setLinked([]);
      setLoadErr(errText(e));
    }
  }, [card.id]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const related = (card.relatedCardIds ?? []).map((id) => allCards.find((c) => c.id === id) ?? null).filter(Boolean) as EvidenceCard[];
  const backlinks = linked ?? [];
  // 后端已把反链与正链分开；去重避免同一张卡两头出现
  const backlinkIds = new Set(backlinks.map((c) => c.id));
  const candidates = allCards
    .filter((c) => c.id !== card.id && !backlinkIds.has(c.id) && !(card.relatedCardIds ?? []).includes(c.id))
    .filter((c) => !relPick.trim() || c.title.toLowerCase().includes(relPick.trim().toLowerCase()))
    .slice(0, 40);

  const src = source ?? sourceOf(card.sourceId);

  /** 「定位到逐字稿」——本视图最重要的动作：把卡片钉回史料 */
  const canJump = !!card.interviewId && isSegmentCitation(card.citation);
  const jump = () => {
    navBus.go('interviews', { interviewId: card.interviewId ?? null, focusSegmentId: card.citation ?? null });
    onClose();
  };

  const addRelation = async (target: EvidenceCard) => {
    try {
      setRelBusy(true);
      await api(`/oral-history/cards/${encodeURIComponent(card.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ relatedCardIds: [...(card.relatedCardIds ?? []), target.id] }),
      });
      setRelPick('');
      onSaved();
      await loadDetail();
    } catch (e) {
      setLoadErr(errText(e));
    } finally {
      setRelBusy(false);
    }
  };

  const removeRelation = async (targetId: string) => {
    try {
      setRelBusy(true);
      await api(`/oral-history/cards/${encodeURIComponent(card.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ relatedCardIds: (card.relatedCardIds ?? []).filter((x) => x !== targetId) }),
      });
      onSaved();
      await loadDetail();
    } catch (e) {
      setLoadErr(errText(e));
    } finally {
      setRelBusy(false);
    }
  };

  const accent = categoryColor(card.kind);
  /** 已成定论 / 已获旁证却没有反证记录——方法上可疑，必须提示 */
  const noCounterWarn = !card.counterEvidence && (card.status === 'settled' || card.status === 'corroborated');

  const linkBtn = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="sch-press"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--dsw-alias-border-l2)',
        background: 'none', borderRadius: 999, padding: '1px 8px', fontSize: 10.5, cursor: 'pointer',
        color: T.secondary, maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
    >
      <Icon d={Icons.cards} size={9} color={T.caption} />
      {label}
    </button>
  );

  return (
    <Modal title={t('card.detail')} onClose={onClose} width={640}>
      <SchStyles />
      <div className="sch-fade" key={card.id + String(card.updatedAt)}>
        {/* 1. 头部：类型 / 状态 / 重要度 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Chip label={kindLabels[card.kind]} color={accent} />
          <Chip label={cardStatusLabels[card.status]} color={statusColor(card.status)} />
          <span style={{ flex: 1 }} />
          <Stars value={card.importance} onChange={onImportance} />
          <IconButton label={t('common.edit')} size={22} onClick={onEdit} icon={<Icon d={Icons.edit} size={12} />} />
          <IconButton label={t('common.delete')} size={22} color={T.danger} onClick={onDelete} icon={<Icon d={Icons.trash} size={12} />} />
        </div>
        <div style={{ fontWeight: 700, fontSize: 14.5, marginTop: 10, lineHeight: 1.45 }}>{card.title}</div>
        {loadErr && <div style={{ color: T.danger, fontSize: 11, marginTop: 6 }}>{loadErr}</div>}
        {error && <div style={{ color: T.danger, fontSize: 11, marginTop: 6 }}>{error}</div>}

        {/* 2. 引文定位 —— 证据链的锚点 */}
        <Section
          title={t('card.citation')}
          icon={<Icon d={Icons.quote} size={11} />}
          accent={card.citation ? accent : undefined}
        >
          {card.citation ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 12.5, fontWeight: 600, letterSpacing: '.02em',
                padding: '2px 7px', borderRadius: 6,
                background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
                border: '1px solid var(--dsw-alias-border-l2)',
                wordBreak: 'break-all',
              }}>
                {card.citation}
              </span>
              {canJump && (
                <Btn tone="soft" onClick={jump} title={t('card.citationJump')}>
                  <Icon d={Icons.mic} size={12} /> {t('card.citationJump')}
                </Btn>
              )}
              {card.sourceId && (
                <Btn onClick={() => { navBus.go('sources', { sourceId: card.sourceId }); onClose(); }}>
                  <Icon d={Icons.book} size={12} /> {t('card.openSource')}
                </Btn>
              )}
            </div>
          ) : (
            <Missing text={t('card.noCitation')} icon={Icons.caution} />
          )}
          {card.interviewId && !canJump && card.citation && (
            <div style={{ marginTop: 6, fontSize: 10.5, color: T.caption }}>
              {t('card.interview')}: {truncate(card.interviewId, 24)}
            </div>
          )}
        </Section>

        {/* 3. 证据原文 */}
        <Section title={t('card.quote')} icon={<Icon d={Icons.quote} size={11} />}>
          {card.quote ? (
            <blockquote style={{
              margin: 0, padding: '7px 10px', borderRadius: 8,
              borderLeft: `3px solid ${accent}`, fontStyle: 'italic',
              background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.09))',
              color: T.secondary, fontSize: 12, lineHeight: 1.75, whiteSpace: 'pre-wrap',
            }}>
              {card.quote}
            </blockquote>
          ) : (
            <Missing text={t('card.noQuote')} icon={Icons.quote} />
          )}
        </Section>

        {/* 4. 考释与论证 */}
        <Section title={t('card.content')} icon={<Icon d={Icons.doc} size={11} />}>
          <div style={{ fontSize: 12.5, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>{card.content}</div>
        </Section>

        {/* 5. 论证角色 */}
        <Section title={t('card.argumentRole')} icon={<Icon d={Icons.link} size={11} />}>
          {card.argumentRole
            ? <div style={{ fontSize: 12, lineHeight: 1.7, color: T.secondary }}>{card.argumentRole}</div>
            : <Missing text={t('card.noArgumentRole')} icon={Icons.caution} />}
        </Section>

        {/* 6. 反证 / 存疑 —— 只记支持性证据是严重缺陷 */}
        <Section
          title={t('card.counterEvidence')}
          icon={<Icon d={Icons.caution} size={11} />}
          accent={card.counterEvidence ? T.warning : undefined}
        >
          {card.counterEvidence ? (
            <div style={{
              padding: '7px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.75, whiteSpace: 'pre-wrap',
              color: T.secondary,
              border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 40%, transparent)',
              background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 9%, transparent)',
            }}>
              {card.counterEvidence}
            </div>
          ) : noCounterWarn ? (
            <div style={{
              display: 'flex', gap: 6, alignItems: 'flex-start', padding: '6px 9px', borderRadius: 8,
              fontSize: 11, lineHeight: 1.65, color: T.warning,
              border: '1px dashed color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 45%, transparent)',
            }}>
              <Icon d={Icons.caution} size={12} color={T.warning} />
              <span>{t('card.noCounterEvidence')}</span>
            </div>
          ) : (
            <Missing text={t('card.noCounterEvidence')} icon={Icons.caution} />
          )}
        </Section>

        {/* 7. 来源史料 */}
        <Section title={t('card.source')} icon={<Icon d={Icons.book} size={11} />}>
          {src ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: 12, flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{src.title}</span>
                <Btn tone="soft" onClick={() => { navBus.go('sources', { sourceId: src.id }); onClose(); }}>
                  <Icon d={Icons.book} size={12} /> {t('card.openSource')}
                </Btn>
              </div>
              <div style={{ marginTop: 7, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                <Chip
                  label={src.tier === 'primary' ? t('source.tier.primary') : t('source.tier.secondary')}
                  color={src.tier === 'primary' ? T.success : T.purple}
                />
                {src.evidenceGrade && <Chip label={t('source.evidenceGrade') + ' ' + src.evidenceGrade} color={T.business} />}
                {src.year !== undefined && <Chip label={String(src.year)} />}
              </div>
              {/* 馆藏信息——一手史料的可靠性来自"可核对" */}
              {src.provenance && <ProvenanceBlock p={src.provenance} t={t} />}
              {src.authors.length > 0 && <div style={{ marginTop: 6 }}><Meta k={t('source.authors')} v={src.authors.join('、')} /></div>}
            </>
          ) : (
            <Missing text={card.sourceId ? truncate(card.sourceId, 40) : t('card.noSource')} icon={Icons.book} />
          )}
        </Section>

        {/* 8. 关联卡片 + 反链 */}
        <Section title={t('card.related')} icon={<Icon d={Icons.link} size={11} />}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {related.length === 0
              ? <Missing text={t('card.noRelated')} icon={Icons.link} />
              : related.map((c) => (
                  <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    {linkBtn(truncate(c.title, 26), () => onOpenCard(c.id))}
                    <IconButton
                      label={t('common.delete')}
                      size={16}
                      disabled={relBusy}
                      onClick={() => void removeRelation(c.id)}
                      icon={<Icon d={Icons.close} size={9} />}
                    />
                  </span>
                ))}
          </div>

          <div style={{ marginTop: 9, fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption }}>
            {t('card.backlinks')} · {backlinks.length}
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
            {backlinks.length === 0
              ? <Missing text={t('card.noBacklinks')} icon={Icons.link} />
              : backlinks.map((c) => <span key={c.id}>{linkBtn(truncate(c.title, 26), () => onOpenCard(c.id))}</span>)}
          </div>

          {/* 添加关联：搜索已有卡片 */}
          <div style={{ marginTop: 10 }}>
            <span style={labelStyle}>{t('card.addRelation')}</span>
            <SearchInput value={relPick} onChange={setRelPick} placeholder={t('card.relatedPickPh')} />
            {relPick.trim() !== '' && (
              <div className="sch-scroll" style={{ maxHeight: 130, overflowY: 'auto', marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {candidates.length === 0 && <div style={{ fontSize: 10.5, color: T.caption, padding: 4 }}>{t('common.empty')}</div>}
                {candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={relBusy}
                    onClick={() => void addRelation(c)}
                    className="sch-card"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left', cursor: 'pointer',
                      border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '4px 7px',
                      background: 'none', color: 'var(--dsw-alias-label-primary)', fontSize: 11,
                    }}
                  >
                    <span aria-hidden style={{ width: 3, height: 11, borderRadius: 2, background: categoryColor(c.kind), flex: 'none' }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                    <StatusPill status={c.status} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </Section>

        {/* 标签 / 备注 / 时间戳 */}
        {card.tags.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 11, flexWrap: 'wrap' }}>
            {card.tags.map((tg) => <Chip key={tg} label={`#${tg}`} />)}
          </div>
        )}
        {card.notes && (
          <div style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.6, color: T.secondary, whiteSpace: 'pre-wrap' }}>
            <span style={{ color: T.caption }}>{t('card.notes')}: </span>{card.notes}
          </div>
        )}
        <div style={{ marginTop: 12, display: 'flex', gap: 12, fontSize: 10, color: T.caption, flexWrap: 'wrap' }}>
          <span>{t('card.createdAt')} {fmtTime(card.createdAt)}</span>
          <span>{t('card.updatedAt')} {fmtTime(card.updatedAt)}</span>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', opacity: .7 }}>{card.id}</span>
        </div>
      </div>
    </Modal>
  );
}

/** 馆藏信息块（一手史料的可靠性证明） */
function ProvenanceBlock({ p, t }: { p: Provenance; t: TFunc }) {
  const rows: [string, string | undefined][] = [
    [t('source.provenance.repository'), p.repository],
    [t('source.provenance.callNumber'), p.callNumber],
    [t('source.provenance.edition'), p.edition],
    [t('source.provenance.medium'), p.medium],
    [t('source.provenance.accessNote'), p.accessNote],
  ];
  if (!rows.some(([, v]) => v)) return null;
  return (
    <div style={{ marginTop: 7 }}>
      {rows.map(([k, v]) => <Meta key={k} k={k} v={v} />)}
    </div>
  );
}

/* ==========================================================================
 * 新建 / 编辑表单
 * ========================================================================== */

interface FormDraft {
  id?: string;
  title: string;
  kind: CardKind;
  content: string;
  sourceId: string;
  interviewId: string;
  citation: string;
  quote: string;
  argumentRole: string;
  counterEvidence: string;
  tagsText: string;
  importance: number;
  status: CardStatus;
  notes: string;
  relatedCardIds: string[];
}

function toDraft(card: EvidenceCard | null, defaultSourceId: string): FormDraft {
  if (!card) {
    return {
      title: '', kind: 'extract', content: '', sourceId: defaultSourceId, interviewId: '',
      citation: '', quote: '', argumentRole: '', counterEvidence: '',
      tagsText: '', importance: 3, status: 'draft', notes: '', relatedCardIds: [],
    };
  }
  return {
    id: card.id,
    title: card.title,
    kind: card.kind,
    content: card.content,
    sourceId: card.sourceId ?? '',
    interviewId: card.interviewId ?? '',
    citation: card.citation ?? '',
    quote: card.quote ?? '',
    argumentRole: card.argumentRole ?? '',
    counterEvidence: card.counterEvidence ?? '',
    tagsText: card.tags.join(', '),
    importance: card.importance,
    status: card.status,
    notes: card.notes ?? '',
    relatedCardIds: [...(card.relatedCardIds ?? [])],
  };
}

function parseTags(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s.split(/[,，、;；]/)) {
    const v = raw.trim().replace(/^#/, '');
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function CardForm(props: {
  t: TFunc;
  card: EvidenceCard | null;
  sources: Source[];
  allCards: EvidenceCard[];
  defaultSourceId: string;
  sourceLabel: (s: Source) => string;
  busy: boolean;
  error: string;
  onSave: (draft: EvidenceCard) => Promise<boolean>;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const { t, card, sources, allCards, defaultSourceId, sourceLabel, busy, error, onSave, onDelete, onClose } = props;
  const [d, setD] = useState<FormDraft>(() => toDraft(card, defaultSourceId));
  const [interviews, setInterviews] = useState<Interview[] | null>(null);
  const [interviewErr, setInterviewErr] = useState('');
  const [relPick, setRelPick] = useState('');
  const [invalid, setInvalid] = useState('');
  const [dirty, setDirty] = useState(false);

  const patch = (p: Partial<FormDraft>) => { setD((cur) => ({ ...cur, ...p })); setDirty(true); };

  // 来源史料选定后，懒加载该史料下的访谈档案
  useEffect(() => {
    if (!d.sourceId) { setInterviews(null); setInterviewErr(''); return; }
    let alive = true;
    setInterviews(null);
    setInterviewErr('');
    void api<{ interviews: Interview[] }>(`/oral-history/interviews${qs({ q: '' })}`)
      .then((r) => {
        if (!alive) return;
        setInterviews((r.interviews ?? []).filter((iv) => iv.sourceId === d.sourceId));
      })
      .catch((e) => {
        if (!alive) return;
        setInterviews([]);
        setInterviewErr(errText(e));
      });
    return () => { alive = false; };
  }, [d.sourceId]);

  const related = d.relatedCardIds
    .map((id) => allCards.find((c) => c.id === id))
    .filter(Boolean) as EvidenceCard[];
  const relCandidates = allCards
    .filter((c) => c.id !== d.id && !d.relatedCardIds.includes(c.id))
    .filter((c) => !relPick.trim() || c.title.toLowerCase().includes(relPick.trim().toLowerCase()))
    .slice(0, 30);

  const submit = async () => {
    if (!d.title.trim() || !d.content.trim()) { setInvalid(t('card.formRequired')); return; }
    setInvalid('');
    const payload: EvidenceCard = {
      id: d.id ?? '',
      title: d.title.trim(),
      kind: d.kind,
      content: d.content,
      sourceId: d.sourceId || undefined,
      interviewId: d.interviewId || undefined,
      citation: d.citation,
      quote: d.quote,
      argumentRole: d.argumentRole,
      counterEvidence: d.counterEvidence,
      tags: parseTags(d.tagsText),
      importance: d.importance,
      status: d.status,
      notes: d.notes,
      relatedCardIds: d.relatedCardIds,
      createdAt: card?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    const ok = await onSave(payload);
    if (ok) setDirty(false);
  };

  const close = () => {
    if (dirty && !window.confirm(t('common.confirmDiscard'))) return;
    onClose();
  };

  return (
    <Modal title={d.id ? t('card.edit') : t('card.new')} onClose={close} width={560}>
      <SchStyles />
      <div onInput={() => setDirty(true)}>
        <Field label={`${t('card.formTitle')} *`}>
          <Input value={d.title} onChange={(e) => patch({ title: e.target.value })} placeholder={t('card.formTitlePh')} />
        </Field>

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Field label={`${t('card.kind')} *`}>
              <Select value={d.kind} onChange={(e) => patch({ kind: e.target.value as CardKind })} style={{ width: '100%' }}>
                {CARD_KINDS.map((k) => <option key={k} value={k}>{kindLabels[k]}</option>)}
              </Select>
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label={t('card.status')}>
              <Select value={d.status} onChange={(e) => patch({ status: e.target.value as CardStatus })} style={{ width: '100%' }}>
                {CARD_STATUSES.map((s) => <option key={s} value={s}>{cardStatusLabels[s]}</option>)}
              </Select>
            </Field>
          </div>
          <div style={{ flex: 'none' }}>
            <Field label={t('card.importance')}>
              <div style={{ height: 26, display: 'flex', alignItems: 'center' }}>
                <Stars value={d.importance} onChange={(v) => patch({ importance: v })} size={13} />
              </div>
            </Field>
          </div>
        </div>

        <Field label={`${t('card.content')} *`} hint={t('card.contentPh')}>
          <Textarea rows={5} value={d.content} onChange={(e) => patch({ content: e.target.value })} placeholder={t('card.contentPh')} />
        </Field>

        <Field label={t('card.citation')}>
          <Input value={d.citation} onChange={(e) => patch({ citation: e.target.value })} placeholder={t('card.citationPh')} />
        </Field>

        <Field label={t('card.quote')}>
          <Textarea rows={3} value={d.quote} onChange={(e) => patch({ quote: e.target.value })} placeholder={t('card.quotePh')} />
        </Field>

        <Field label={t('card.argumentRole')}>
          <Input value={d.argumentRole} onChange={(e) => patch({ argumentRole: e.target.value })} placeholder={t('card.argumentRolePh')} />
        </Field>

        <Field label={t('card.counterEvidence')}>
          <Textarea rows={3} value={d.counterEvidence} onChange={(e) => patch({ counterEvidence: e.target.value })} placeholder={t('card.counterEvidencePh')} />
        </Field>

        <Field label={t('card.source')}>
          <Select value={d.sourceId} onChange={(e) => patch({ sourceId: e.target.value, interviewId: '' })} style={{ width: '100%' }}>
            <option value="">{t('card.sourceNone')}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{sourceLabel(s)}</option>)}
          </Select>
        </Field>

        <Field label={t('card.interview')} hint={!d.sourceId ? t('card.interviewHint') : undefined}>
          <Select
            value={d.interviewId}
            disabled={!d.sourceId || interviews === null}
            onChange={(e) => patch({ interviewId: e.target.value })}
            style={{ width: '100%' }}
          >
            <option value="">{interviews === null && d.sourceId ? t('common.loading') : t('card.interviewNone')}</option>
            {(interviews ?? []).map((iv) => (
              <option key={iv.id} value={iv.id}>
                {iv.interviewee.name}{iv.interviewYear ? ` · ${iv.interviewYear}` : ''}
              </option>
            ))}
          </Select>
          {interviewErr && <div style={{ color: T.danger, fontSize: 10.5, marginTop: 3 }}>{interviewErr}</div>}
        </Field>

        <Field label={t('card.tags')}>
          <Input value={d.tagsText} onChange={(e) => patch({ tagsText: e.target.value })} placeholder={t('card.tagsPh')} />
        </Field>

        {/* 关联卡片：先选后搜 */}
        <Field label={`${t('card.related')}${d.relatedCardIds.length ? ` · ${t('card.relatedSelected', { n: d.relatedCardIds.length })}` : ''}`}>
          {related.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 5 }}>
              {related.map((c) => (
                <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  <Chip label={truncate(c.title, 22)} color={categoryColor(c.kind)} />
                  <IconButton
                    label={t('common.delete')}
                    size={15}
                    onClick={() => patch({ relatedCardIds: d.relatedCardIds.filter((x) => x !== c.id) })}
                    icon={<Icon d={Icons.close} size={9} />}
                  />
                </span>
              ))}
            </div>
          )}
          <SearchInput value={relPick} onChange={setRelPick} placeholder={t('card.relatedPickPh')} />
          {relPick.trim() !== '' && (
            <div className="sch-scroll" style={{ maxHeight: 120, overflowY: 'auto', marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {relCandidates.length === 0 && <div style={{ fontSize: 10.5, color: T.caption, padding: 4 }}>{t('common.empty')}</div>}
              {relCandidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => { patch({ relatedCardIds: [...d.relatedCardIds, c.id] }); setRelPick(''); }}
                  className="sch-card"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left', cursor: 'pointer',
                    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '4px 7px',
                    background: 'none', color: 'var(--dsw-alias-label-primary)', fontSize: 11,
                  }}
                >
                  <span aria-hidden style={{ width: 3, height: 11, borderRadius: 2, background: categoryColor(c.kind), flex: 'none' }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                  <span style={{ fontSize: 9, color: T.caption }}>{kindLabels[c.kind]}</span>
                </button>
              ))}
            </div>
          )}
        </Field>

        <Field label={t('card.notes')}>
          <Textarea rows={2} value={d.notes} onChange={(e) => patch({ notes: e.target.value })} />
        </Field>

        {invalid && <div style={{ color: T.danger, fontSize: 11, marginBottom: 8 }}>{invalid}</div>}
        {error && <div style={{ color: T.danger, fontSize: 11, marginBottom: 8 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          {onDelete && (
            <Btn tone="danger" onClick={onDelete} disabled={busy}>
              <Icon d={Icons.trash} size={12} /> {t('common.delete')}
            </Btn>
          )}
          <span style={{ flex: 1 }} />
          <Btn onClick={close} disabled={busy}>{t('common.cancel')}</Btn>
          <Btn tone="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t('common.loading') : t('common.save')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
