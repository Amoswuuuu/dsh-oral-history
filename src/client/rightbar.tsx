/**
 * 官方右侧 Sidebar(0.1.5+)的「口述史」页签。
 *
 * 两阶段注册(照 dsh-client-ui-sidebar-files 的官方姿势):
 *  1. ctx.sidebarRightTabs.register(定义) —— 静态类型声明
 *  2. ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
 *       { name, key: 定义id, locale: NS }, Body)) —— body 组件
 *
 * body 双模:无 params = 迷你检索(防抖拉 /oral-history/interviews);
 * params.interviewId = 访谈速览(与对话并排阅读逐字稿,不遮会话)。
 * 旧宿主无 sidebarRightTabs/sidebarRight 服务时静默跳过(特性检测)。
 */
import React from 'react';
import type { Interview, Transcript } from '../shared/types';
import { api, qs } from './api';
import { SegmentRow } from './TranscriptView';

const NS = 'oral-history';
/** 注册 id = 包名(tab 系统里实现的身份,也是 body 注册的 key) */
const TAB_ID = 'dsh-oral-history';
export const INTERVIEW_TAB_KIND = 'dsh-oral-history.interview';

/* ---------- openTab 服务句柄(apply 时注入,旧宿主为 null) ---------- */
let svc: { openTab(kind: string, options?: { params?: unknown }): void } | null = null;

/** 入口可用性(TranscriptView 据此显示/隐藏「右侧栏打开」)。 */
export function rightbarAvailable(): boolean {
  return svc !== null;
}

/** 在右侧栏打开一份访谈(params 省略 = 打开检索模式);服务缺席时静默 no-op。 */
export function openInterviewInRightbar(id?: string, segmentId?: string): void {
  try {
    svc?.openTab(INTERVIEW_TAB_KIND, id ? { params: { interviewId: id, segmentId } } : undefined);
  } catch {
    /* 服务未挂载(无会话 seat)——忽略 */
  }
}

/* ---------- body ---------- */

type InterviewLite = Pick<Interview, 'id' | 'sourceId' | 'interviewee' | 'interviewYear' | 'location'> & {
  transcriptId?: string;
  segments?: number;
  verifiedRatio?: number;
};

function ProgressBar({ ratio }: { ratio: number }) {
  return (
    <span style={{
      display: 'inline-block', width: 44, height: 4, borderRadius: 2,
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.25))', overflow: 'hidden', verticalAlign: 'middle',
    }}>
      <span style={{
        display: 'block', height: '100%', width: `${Math.round(ratio * 100)}%`,
        background: 'var(--dsw-alias-state-success-primary, #30a46c)',
      }} />
    </span>
  );
}

function InterviewTabBody({ useTabInfo, t }: { useTabInfo: () => { tab: any }; t: (key: string, params?: Record<string, unknown>) => string }) {
  const { tab } = useTabInfo();
  const nav = tab?.navigation;
  const paramsId: string | undefined = nav?.params?.interviewId;
  const paramsSegment: string | undefined = nav?.params?.segmentId;
  const revision: number = nav?.revision ?? 0;

  const [selectedId, setSelectedId] = React.useState<string | null>(paramsId ?? null);
  React.useEffect(() => {
    if (paramsId) setSelectedId(paramsId);
  }, [paramsId, revision]);

  if (selectedId) {
    return <InterviewPeek id={selectedId} focusSegmentId={paramsSegment} t={t} onBack={() => setSelectedId(null)} />;
  }
  return <InterviewSearch t={t} onPick={setSelectedId} />;
}

function InterviewSearch({ t, onPick }: { t: (key: string, params?: Record<string, unknown>) => string; onPick: (id: string) => void }) {
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [list, setList] = React.useState<InterviewLite[] | null>(null);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  React.useEffect(() => {
    let alive = true;
    setErr('');
    api<{ interviews: InterviewLite[] }>(`/oral-history/interviews${qs({ q: debounced })}`)
      .then((d) => { if (alive) setList(d.interviews ?? []); })
      .catch((e) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { alive = false; };
  }, [debounced]);

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: '100%' }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('iv.searchPh')}
        style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 12, borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', outline: 'none' }}
      />
      {err && <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-danger-primary)' }}>{err}</div>}
      {list && list.length === 0 && !err && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', padding: '8px 2px' }}>
          {t('iv.noInterview')}
        </div>
      )}
      {list?.map((iv) => (
        <button
          key={iv.id}
          type="button"
          onClick={() => onPick(iv.id)}
          style={{ textAlign: 'left', cursor: 'pointer', display: 'block', width: '100%', padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
            fontSize: 12, lineHeight: 1.5 }}
        >
          <div style={{ fontWeight: 600 }}>{iv.interviewee?.name}</div>
          <div style={{ marginTop: 3, display: 'flex', gap: 6, alignItems: 'center', color: 'var(--dsw-alias-label-caption)', fontSize: 11 }}>
            {iv.interviewYear ? <span>{iv.interviewYear}</span> : null}
            {iv.location ? <span>· {iv.location}</span> : null}
            {typeof iv.verifiedRatio === 'number' && iv.segments ? (
              <>
                <ProgressBar ratio={iv.verifiedRatio} />
                <span>{t('tr.verifiedRatio', { pct: Math.round(iv.verifiedRatio * 100) })}</span>
              </>
            ) : null}
          </div>
        </button>
      ))}
    </div>
  );
}

function InterviewPeek({ id, focusSegmentId, t, onBack }: {
  id: string; focusSegmentId?: string;
  t: (key: string, params?: Record<string, unknown>) => string; onBack: () => void;
}) {
  const [iv, setIv] = React.useState<Interview | null>(null);
  const [tr, setTr] = React.useState<Transcript | null>(null);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    setErr(''); setIv(null); setTr(null);
    api<{ interview: Interview; transcript: Transcript | null }>(`/oral-history/interviews/${encodeURIComponent(id)}`)
      .then((d) => { if (alive) { setIv(d.interview); setTr(d.transcript); } })
      .catch((e) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
    return () => { alive = false; };
  }, [id]);

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9, minHeight: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" onClick={onBack} style={{ cursor: 'pointer', border: 0, background: 'none',
          color: 'var(--dsw-alias-label-caption)', fontSize: 11, padding: 0 }}>{t('common.back')}</button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)' }}>{t('rightbar.hint')}</span>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-danger-primary)' }}>{err}</div>}
      {!iv && !err && <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>{t('common.loading')}</div>}
      {iv && (
        <>
          <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.55 }}>{iv.interviewee.name}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>
            {iv.interviewYear ? <span>{iv.interviewYear}</span> : null}
            {iv.location ? <span>· {iv.location}</span> : null}
            {iv.recording?.originalMedium ? <span>· {iv.recording.originalMedium}</span> : null}
          </div>
          {iv.interviewee.bio && (
            <div style={{ fontSize: 11.5, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' }}>{iv.interviewee.bio}</div>
          )}
          {tr && tr.segments.length > 0 && typeof tr.verifiedRatio === 'number' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>
              <ProgressBar ratio={tr.verifiedRatio} />
              {t('tr.verifiedRatio', { pct: Math.round(tr.verifiedRatio * 100) })}
              <span>· {t('tr.segments', { count: tr.segments.length })}</span>
            </div>
          )}
          {/* 只读速览:右侧栏与对话并排,便于边读边引用。编辑仍在主面板进行。 */}
          {tr && (
            <div style={{ borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tr.segments.slice(0, 60).map((s) => (
                <SegmentRow
                  key={s.id}
                  seg={s}
                  active={!!focusSegmentId && s.id === focusSegmentId}
                  readOnly
                  t={t}
                />
              ))}
              {tr.segments.length > 60 && (
                <div style={{ fontSize: 10.5, color: 'var(--dsw-alias-label-caption)' }}>…</div>
              )}
            </div>
          )}
          {!tr && <div style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-caption)' }}>{t('iv.transcriptNone')}</div>}
        </>
      )}
    </div>
  );
}

/* ---------- 注册(apply 时调用;旧宿主无该服务时静默跳过) ---------- */

export function registerOralHistoryRightbar(ctx: any): void {
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (ctx2: any) => {
    svc = ctx2.sidebarRight;
    const t = ctx2.locale.bind(NS);
    ctx2.effect(() => ctx2.sidebarRightTabs.register({
      id: TAB_ID,
      kind: INTERVIEW_TAB_KIND,
      title: () => t('rightbar.tab'),
      guide: [{
        order: 62,
        title: () => t('rightbar.tab'),
        description: () => t('rightbar.hint'),
      }],
    }), 'dsh-oral-history: rightbar interview tab type');
    ctx2.effect(() => ctx2.slots.inject('sidebar.right.pane.tab', () => ctx2.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
    }, InterviewTabBody)), 'dsh-oral-history: rightbar interview tab body');
    return () => { svc = null; };
  });
}
