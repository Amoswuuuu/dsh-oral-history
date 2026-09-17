import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { api, qs, loadSavedFilters, saveFilters } from './api';
import { navBus, useNav, type TFunc } from './nav';
import { refreshCounts } from './index';
import {
  Btn, Chip, EmptyState, Field, FilterChip, Icon, IconButton, Icons, Input,
  Meta, Modal, Section, SearchInput, Select, T, Textarea, labelStyle,
  segmentColor, truncate, Z,
} from './ui';
import { segmentStatusLabels } from './locales';
import type {
  GlossaryEntry, Interview, Interviewer, RecordingTech, Segment, SegmentStatus, Source,
  SpeakerRole, Transcript,
} from '../shared/types';
import { SEGMENT_STATUSES, SPEAKER_ROLES } from '../shared/types';

/* ==========================================================================
 * 访谈与逐字稿 —— 口述史工作台的核心视图
 *
 * 布局：主从（master–detail）。左=访谈列表，右=打开访谈的逐字稿工作区。
 * 窄容器（<640px）折叠为单列：列表 ⇄ 详情，带返回按钮。
 *
 * 产品重点：边听录音边校订逐字稿。播放器 + 时间戳分段 + "卡拉OK"式
 * 自动高亮跟随，是本视图存在的理由；进度条与校订状态则让"哪些内容
 * 经过人工听校"这一证据质量问题始终可见（反虚构硬要求）。
 * ========================================================================== */

/* ---------- 常量 ---------- */

/** 窄屏阈值：容器宽度小于此值时折叠为主从互斥的单列 */
const NARROW_PX = 640;
/** 音频播放倍速档位——方言/老年受访者语速需放慢听辨 */
const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
/** 分段结束时间缺失时的兜底时长（秒） */
const DEFAULT_SEG_SECONDS = 5;
/** 列表筛选持久化键 */
const FILTER_KEY = 'oh-interviews-filters';

/**
 * 左侧字段筛选与排序的可选值。
 *
 * 注意：这些是**史料数据的取值**（受访者的专业领域、任职机构名），
 * 不是界面文案——它们直接作为 `field` / `affiliation` 查询参数发给后端，
 * 必须与库中存在的字符串逐字一致，因此不走 t()。侧栏选项由库内实际取值
 * 驱动，这里只是给常见科技史领域一个快捷入口。
 */
const FIELD_OPTIONS = [
  '核物理', '高能物理', '光学', '力学', '数学', '化学', '地质', '生物',
  '医学', '农学', '冶金', '机械', '电机', '土木', '建筑', '航空', '航天',
  '计算机', '半导体', '无线电', '化工', '水利', '矿业', '纺织',
];
const AFFILIATION_OPTIONS = [
  '中国科学院', '中国社会科学院', '中国工程院', '北京大学', '清华大学',
  '复旦大学', '上海交通大学', '浙江大学', '南京大学', '中国科学技术大学',
  '核工业部', '航天工业部', '机械工业部', '冶金工业部', '铁道部',
  '中国科学院力学研究所', '中国科学院物理研究所', '中国科学院近代物理研究所',
];
/** 访谈者所属机构的常见值（新建表单的 datalist） */
const INTERVIEWER_AFFILIATION_OPTIONS = [
  '中国科学院自然科学史研究所', '中国科学院大学', '北京大学科学史与科学哲学研究中心',
  '清华大学科学技术史系', '上海交通大学科学史与科学文化研究院', '中国科学技术大学科技史与科技考古系',
];

/** 术语表条目类别 */
const GLOSSARY_KINDS = ['person', 'institution', 'term', 'place'] as const;

/** 左列排序方式 */
type IvSort = 'year' | 'name';

/**
 * 列表接口返回的访谈条目。
 * GET /oral-history/interviews 在 Interview 之上附加了两个派生字段：
 * segments（分段数）与 verifiedRatio（人工听校比例），用于列表行的进度条。
 * 这两个字段不属于 Interview 本体，只在此处声明。
 */
interface InterviewListItem extends Interview {
  segments: number;
  verifiedRatio: number;
}

/** 列表筛选状态（持久化于 sessionStorage） */
interface IvFilters {
  q: string;
  field: string;
  affiliation: string;
  sort: IvSort;
}

/* ---------- 纯工具 ---------- */

/** 秒 → MM:SS（超过一小时则 H:MM:SS） */
function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 生卒年：1912–1999 / 1912– / 空 */
function lifeDates(birth?: number, death?: number): string {
  if (birth && death) return `${birth}–${death}`;
  if (birth) return `${birth}–`;
  if (death) return `–${death}`;
  return '';
}

/** 访谈时间显示：具体日期优先，其次年份 */
function interviewWhen(iv: Interview): string {
  return iv.interviewDate || (iv.interviewYear ? String(iv.interviewYear) : '');
}

/** 排序用年份（无年份排到最后） */
function sortYear(iv: Interview): number {
  if (iv.interviewYear) return iv.interviewYear;
  const m = /(\d{4})/.exec(iv.interviewDate ?? '');
  return m ? Number(m[1]) : -Infinity;
}

/** 逗号 / 顿号 / 分号分隔 → 去空数组 */
function splitList(s: string): string[] {
  return s.split(/[,，、;；]/).map((x) => x.trim()).filter(Boolean);
}

/** 空串 → undefined（避免把空字段写进 patch） */
function orUndef(s: string): string | undefined {
  const v = s.trim();
  return v ? v : undefined;
}

/** 数字输入串 → number | undefined */
function toNum(s: string): number | undefined {
  const v = s.trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/* ---------- 逐字稿文本解析（手工写入分段） ---------- */

const SPEAKER_ALIASES: Record<string, SpeakerRole> = {
  interviewer: 'interviewer', interviewee: 'interviewee', 'third-party': 'third-party', unknown: 'unknown',
  '访谈者': 'interviewer', '采访者': 'interviewer', '访问者': 'interviewer',
  '受访者': 'interviewee', '口述者': 'interviewee', '被访者': 'interviewee', '叙述者': 'interviewee',
  '第三方': 'third-party', '旁人': 'third-party', '家属': 'third-party', '他人': 'third-party',
  '未标注': 'unknown', '未知': 'unknown',
};

/** 宽松解析说话人字段；无法识别时归入 unknown，并保留原文作为 label */
function parseSpeaker(raw: string): { speaker: SpeakerRole; speakerLabel?: string } {
  const key = raw.trim().toLowerCase();
  if (!key) return { speaker: 'unknown' };
  const hit = SPEAKER_ALIASES[key] ?? SPEAKER_ALIASES[raw.trim()];
  if (hit) return { speaker: hit };
  return { speaker: 'third-party', speakerLabel: raw.trim() };
}

/**
 * 解析用户粘贴的文本。
 * 1) 若整体是 JSON 数组 → 直接当 segments 用（宽松取字段）。
 * 2) 否则按 "[MM:SS] 说话人: 正文" 逐行解析；无时间戳的续行并入上一段。
 * 结束时间未知时取 start + 5，或下一段起点（更贴近真实节奏）。
 */
function parseSegmentBlob(raw: string): { segments: Array<Record<string, unknown>>; error?: string } {
  const text = raw.trim();
  if (!text) return { segments: [], error: 'empty' };

  // --- JSON 分支 ---
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return { segments: parsed.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') };
      }
    } catch {
      /* 不是合法 JSON —— 退回时间戳行解析 */
    }
  }

  // --- 时间戳行分支 ---
  // 支持 [MM:SS] / MM:SS / [H:MM:SS]，时间戳后可选 "说话人:" 或 "说话人："
  const lineRe = /^\s*(?:\[|\()?\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*(?:\]|\))?\s*(.*)$/;
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = lineRe.exec(line);
    if (m) {
      const h = m[1] ? Number(m[1]) : 0;
      const start = h * 3600 + Number(m[2]) * 60 + Number(m[3]);
      let rest = (m[4] ?? '').trim();
      let who: { speaker: SpeakerRole; speakerLabel?: string } = { speaker: 'unknown' };
      // "说话人: 正文" —— 冒号前不超过 12 字符，避免把正文里的冒号误当说话人
      const cm = /^([^:：]{1,12})[:：]\s*(.*)$/.exec(rest);
      if (cm) {
        who = parseSpeaker(cm[1]);
        rest = cm[2].trim();
      }
      out.push({
        start,
        end: start + DEFAULT_SEG_SECONDS,
        speaker: who.speaker,
        ...(who.speakerLabel ? { speakerLabel: who.speakerLabel } : {}),
        text: rest,
        status: 'raw',
      });
      continue;
    }
    // 无时间戳的续行：接到上一段正文后面
    if (out.length) out[out.length - 1].text = `${String(out[out.length - 1].text)} ${line.trim()}`.trim();
  }

  if (!out.length) return { segments: [], error: 'unparsed' };

  // 用下一段起点回填 end（比固定 +5 秒更贴近真实节奏）
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i];
    const next = out[i + 1];
    if (typeof cur.start === 'number' && typeof next.start === 'number' && next.start > cur.start) {
      cur.end = next.start;
    }
  }
  return { segments: out };
}

/* ==========================================================================
 * 访谈建档 / 编辑表单
 *
 * 同一套表单服务"新建"与"编辑"：edit 非空时走 PUT，否则走 POST。
 * 提交前剥离 undefined/空值，让 PUT 的"部分更新"语义不被空字段破坏。
 * ========================================================================== */

interface IvFormProps {
  t: TFunc;
  /** 口语史料候选项（primaryKind = oral-history） */
  sources: Source[];
  /** 焦点进入时预选的史料 id */
  initialSourceId: string;
  /** 传入则为编辑模式 */
  edit: Interview | null;
  onClose: () => void;
  onSaved: (iv: Interview, created: boolean) => void;
}

function IntervieweeForm({ t, sources, initialSourceId, edit, onClose, onSaved }: IvFormProps) {
  const ie = edit?.interviewee;
  const rec = edit?.recording;

  const [sourceId, setSourceId] = useState(edit?.sourceId ?? initialSourceId ?? '');
  const [name, setName] = useState(ie?.name ?? '');
  const [birthYear, setBirthYear] = useState(ie?.birthYear !== undefined ? String(ie.birthYear) : '');
  const [deathYear, setDeathYear] = useState(ie?.deathYear !== undefined ? String(ie.deathYear) : '');
  const [roles, setRoles] = useState((ie?.roles ?? []).join('、'));
  const [affiliations, setAffiliations] = useState((ie?.affiliations ?? []).join('、'));
  const [fields, setFields] = useState((ie?.fields ?? []).join('、'));
  const [bio, setBio] = useState(ie?.bio ?? '');

  const [interviewers, setInterviewers] = useState<Interviewer[]>(
    edit?.interviewers?.length ? edit.interviewers.map((x) => ({ ...x })) : [{ name: '' }],
  );

  const [interviewDate, setInterviewDate] = useState(edit?.interviewDate ?? '');
  const [interviewYear, setInterviewYear] = useState(edit?.interviewYear !== undefined ? String(edit.interviewYear) : '');
  const [location, setLocation] = useState(edit?.location ?? '');

  const [originalMedium, setOriginalMedium] = useState(rec?.originalMedium ?? '');
  const [recordedYear, setRecordedYear] = useState(rec?.recordedYear !== undefined ? String(rec.recordedYear) : '');
  const [digitalFormat, setDigitalFormat] = useState(rec?.digitalFormat ?? '');
  const [sampleRate, setSampleRate] = useState(rec?.sampleRate ?? '');
  const [durationSeconds, setDurationSeconds] = useState(rec?.durationSeconds !== undefined ? String(rec.durationSeconds) : '');
  const [qualityNote, setQualityNote] = useState(rec?.qualityNote ?? '');

  const [questionOutline, setQuestionOutline] = useState(edit?.questionOutline ?? '');
  const [backgroundNotes, setBackgroundNotes] = useState(edit?.backgroundNotes ?? '');
  const [publicationNote, setPublicationNote] = useState(edit?.publicationNote ?? '');

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setInterviewer = (i: number, patch: Partial<Interviewer>) =>
    setInterviewers((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const submit = async () => {
    if (!name.trim()) { setErr(t('iv.nameRequired')); return; }
    if (!sourceId) { setErr(t('iv.sourceRequired')); return; }
    setSaving(true);
    setErr(null);

    // 录音技术信息：只保留有值的字段，全空则整体省略
    const recording: RecordingTech = {};
    const om = orUndef(originalMedium); if (om) recording.originalMedium = om;
    const ry = toNum(recordedYear); if (ry !== undefined) recording.recordedYear = ry;
    const df = orUndef(digitalFormat); if (df) recording.digitalFormat = df;
    const sr = orUndef(sampleRate); if (sr) recording.sampleRate = sr;
    const ds = toNum(durationSeconds); if (ds !== undefined) recording.durationSeconds = ds;
    const qn = orUndef(qualityNote); if (qn) recording.qualityNote = qn;

    const payload: Record<string, unknown> = {
      sourceId,
      interviewee: {
        name: name.trim(),
        ...(toNum(birthYear) !== undefined ? { birthYear: toNum(birthYear) } : {}),
        ...(toNum(deathYear) !== undefined ? { deathYear: toNum(deathYear) } : {}),
        roles: splitList(roles),
        affiliations: splitList(affiliations),
        fields: splitList(fields),
        ...(orUndef(bio) ? { bio: bio.trim() } : {}),
      },
      interviewers: interviewers
        .map((x) => ({ name: x.name.trim(), affiliation: (x.affiliation ?? '').trim() }))
        .filter((x) => x.name)
        .map((x) => (x.affiliation ? x : { name: x.name })),
      ...(toNum(interviewYear) !== undefined ? { interviewYear: toNum(interviewYear) } : {}),
      interviewDate: interviewDate.trim(),
      location: location.trim(),
      ...(Object.keys(recording).length ? { recording } : {}),
      questionOutline,
      backgroundNotes,
      publicationNote,
    };

    try {
      if (edit) {
        const res = await api<{ interview: Interview }>(`/oral-history/interviews/${encodeURIComponent(edit.id)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        refreshCounts();
        onSaved(res.interview, false);
      } else {
        const res = await api<{ interview: Interview }>('/oral-history/interviews', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        refreshCounts();
        onSaved(res.interview, true);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={edit ? t('iv.edit') : t('iv.new')} onClose={onClose} width={620}>
      <Field label={t('iv.source')} hint={t('iv.sourceHint')}>
        <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)} style={{ width: '100%' }}>
          <option value="">—</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}{s.year ? `（${s.year}）` : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={`${t('iv.interviewee')} · ${t('iv.name')}`}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('iv.namePh')} />
      </Field>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Field label={t('iv.birthYear')}>
            <Input value={birthYear} onChange={(e) => setBirthYear(e.target.value)} inputMode="numeric" placeholder="1912" />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t('iv.deathYear')}>
            <Input value={deathYear} onChange={(e) => setDeathYear(e.target.value)} inputMode="numeric" placeholder="1999" />
          </Field>
        </div>
      </div>

      <Field label={t('iv.roles')}>
        <Input value={roles} onChange={(e) => setRoles(e.target.value)} placeholder={t('iv.rolesPh')} />
      </Field>
      <Field label={t('iv.affiliations')} hint={t('iv.affiliationsPh')}>
        <Input value={affiliations} onChange={(e) => setAffiliations(e.target.value)} />
      </Field>
      <Field label={t('iv.fields')}>
        <Input value={fields} onChange={(e) => setFields(e.target.value)} placeholder={t('iv.fieldsPh')} />
      </Field>
      <Field label={t('iv.bio')}>
        <Textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder={t('iv.bioPh')} />
      </Field>

      {/* 访谈者：可增删的行列表 */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ ...labelStyle, marginBottom: 0 }}>{t('iv.interviewers')}</span>
          <span style={{ flex: 1 }} />
          <IconButton
            label={t('iv.interviewerAdd')}
            size={20}
            onClick={() => setInterviewers((l) => [...l, { name: '' }])}
            icon={<Icon d={Icons.plus} size={12} />}
          />
        </div>
        {interviewers.map((ivr, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <Input
              value={ivr.name}
              onChange={(e) => setInterviewer(i, { name: e.target.value })}
              placeholder={t('iv.interviewerName')}
              style={{ flex: 1 }}
            />
            <Input
              value={ivr.affiliation ?? ''}
              onChange={(e) => setInterviewer(i, { affiliation: e.target.value })}
              placeholder={t('iv.interviewerAffiliation')}
              list="oh-interviewer-affiliations"
              style={{ flex: 1.4 }}
            />
            <IconButton
              label={t('iv.interviewerRemove')}
              size={22}
              color={T.danger}
              disabled={interviewers.length <= 1}
              onClick={() => setInterviewers((l) => l.filter((_, j) => j !== i))}
              icon={<Icon d={Icons.trash} size={12} />}
            />
          </div>
        ))}
        <datalist id="oh-interviewer-affiliations">
          {INTERVIEWER_AFFILIATION_OPTIONS.map((a) => <option key={a} value={a} />)}
        </datalist>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1.4 }}>
          <Field label={t('iv.interviewDate')}>
            <Input value={interviewDate} onChange={(e) => setInterviewDate(e.target.value)} placeholder={t('iv.interviewDatePh')} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t('iv.interviewYear')}>
            <Input value={interviewYear} onChange={(e) => setInterviewYear(e.target.value)} inputMode="numeric" placeholder="1985" />
          </Field>
        </div>
      </div>
      <Field label={t('iv.location')}>
        <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t('iv.locationPh')} />
      </Field>

      {/* 录音技术信息 —— 决定转录音质与处理难度 */}
      <div style={{ marginTop: 4, marginBottom: 8, paddingTop: 8, borderTop: `1px solid ${T.borderL2}` }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption, marginBottom: 8 }}>
          {t('iv.recording')}
        </div>
        <Field label={t('iv.originalMedium')}>
          <Input value={originalMedium} onChange={(e) => setOriginalMedium(e.target.value)} placeholder={t('iv.originalMediumPh')} />
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Field label={t('iv.recordedYear')}>
              <Input value={recordedYear} onChange={(e) => setRecordedYear(e.target.value)} inputMode="numeric" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label={t('iv.digitalFormat')}>
              <Input value={digitalFormat} onChange={(e) => setDigitalFormat(e.target.value)} placeholder={t('iv.digitalFormatPh')} />
            </Field>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <Field label={t('iv.sampleRate')}>
              <Input value={sampleRate} onChange={(e) => setSampleRate(e.target.value)} placeholder={t('iv.sampleRatePh')} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label={t('iv.durationSeconds')}>
              <Input value={durationSeconds} onChange={(e) => setDurationSeconds(e.target.value)} inputMode="numeric" placeholder="3600" />
            </Field>
          </div>
        </div>
        <Field label={t('iv.qualityNote')}>
          <Textarea value={qualityNote} onChange={(e) => setQualityNote(e.target.value)} rows={2} placeholder={t('iv.qualityNotePh')} />
        </Field>
      </div>

      <Field label={t('iv.questionOutline')}>
        <Textarea value={questionOutline} onChange={(e) => setQuestionOutline(e.target.value)} rows={2} placeholder={t('iv.questionOutlinePh')} />
      </Field>
      <Field label={t('iv.backgroundNotes')}>
        <Textarea value={backgroundNotes} onChange={(e) => setBackgroundNotes(e.target.value)} rows={2} placeholder={t('iv.backgroundNotesPh')} />
      </Field>
      <Field label={t('iv.publicationNote')}>
        <Textarea value={publicationNote} onChange={(e) => setPublicationNote(e.target.value)} rows={2} placeholder={t('iv.publicationNotePh')} />
      </Field>

      {err && <div style={{ color: T.danger, fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
        <Btn onClick={onClose} disabled={saving}>{t('common.cancel')}</Btn>
        <Btn tone="primary" onClick={() => void submit()} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </Btn>
      </div>
    </Modal>
  );
}

/* ==========================================================================
 * 进度条 —— 校对进度可视化（列表行与详情页共用）
 * ========================================================================== */

/** 细横向进度条：verifiedRatio 越大越绿，直观呈现"档案被人工核验的比例" */
export function ProgressBar({ ratio, width = 44, height = 4 }: { ratio: number; width?: number; height?: number }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return (
    <span
      style={{
        display: 'inline-block', width, height, borderRadius: height / 2, flex: 'none',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.25))', overflow: 'hidden', verticalAlign: 'middle',
      }}
      role="progressbar"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{
        display: 'block', height: '100%', width: `${Math.round(pct * 100)}%`,
        background: 'var(--dsw-alias-state-success-primary, #30a46c)',
        transition: 'width .2s ease',
      }} />
    </span>
  );
}

/* ==========================================================================
 * 分段行 —— 主列表与右侧栏速览共用的唯一实现
 *
 * readOnly=true（右侧栏速览）时：不编辑、不显示快捷状态按钮、不 seek，
 * 只保留时间戳 / 说话人 / 正文 / 状态色条 / 备注 / 高亮。
 * active=true 是"卡拉OK"跟随态，主列表据 currentTime 计算后传入。
 * ========================================================================== */

/** 校对状态配色 —— 供视图各处（状态条、计数、图例）复用 */
export function segmentStatusColor(status: string): string {
  return segmentColor(status);
}

/** 说话人显示名：优先自定义称呼，否则按角色取本地化标签 */
function speakerName(t: TFunc, seg: Segment): string {
  if (seg.speakerLabel) return seg.speakerLabel;
  return t(`tr.speaker.${seg.speaker}`);
}

export function SegmentRow({ seg, active, readOnly, t, onSeek, onSave, onSetStatus }: {
  seg: Segment;
  active?: boolean;
  readOnly?: boolean;
  t: (key: string, params?: Record<string, unknown>) => string;
  onSeek?: (start: number) => void;
  onSave?: (nextText: string) => void;
  onSetStatus?: (status: SegmentStatus) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(seg.text);
  const [showRaw, setShowRaw] = useState(false);

  // 外部文本变化（重新加载后）时同步草稿，避免停在旧值
  useEffect(() => { if (!editing) setDraft(seg.text); }, [seg.text, editing]);

  const color = segmentColor(seg.status);
  const interactive = !readOnly;

  const beginEdit = () => {
    if (!interactive) return;
    setDraft(seg.text);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (draft !== seg.text) onSave?.(draft);
  };

  return (
    <div
      data-segment-id={seg.id}
      style={{
        position: 'relative', display: 'flex', gap: 8, padding: '6px 8px 6px 10px',
        borderLeft: `3px solid ${color}`,
        borderRadius: 7,
        background: active
          ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 15%, transparent)'
          : 'transparent',
        boxShadow: active
          ? 'inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 34%, transparent)'
          : 'none',
        transition: 'background .16s ease, box-shadow .16s ease',
      }}
    >
      {/* 时间戳：点击跳转并播放 */}
      <button
        type="button"
        disabled={readOnly || !onSeek}
        onClick={readOnly ? undefined : () => onSeek?.(seg.start)}
        title={readOnly ? undefined : t('tr.jumpTo')}
        style={{
          flex: 'none', alignSelf: 'flex-start', height: 20, padding: '0 6px',
          border: 'none', borderRadius: 5, fontVariantNumeric: 'tabular-nums',
          fontSize: 10.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          cursor: readOnly ? 'default' : 'pointer',
          background: active
            ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 24%, transparent)'
            : T.cardBg,
          color: active ? T.business : T.secondary,
        }}
      >
        [{fmtTime(seg.start)}]
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* 说话人 + 状态 + 把握度 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 2 }}>
          <span style={{
            fontSize: 10, fontWeight: 600, color: T.secondary, flex: 'none',
            padding: '0 5px', height: 16, lineHeight: '16px', borderRadius: 4,
            background: T.cardBg,
          }}>
            {speakerName(t, seg)}
          </span>
          <span style={{ fontSize: 9.5, color, flex: 'none' }}>{segmentStatusLabels[seg.status]}</span>
          {seg.confidence !== undefined && (
            <span style={{ fontSize: 9.5, color: T.caption, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(seg.confidence * 100)}%
            </span>
          )}
          <span style={{ flex: 1 }} />
          {interactive && !editing && (
            <span style={{ display: 'inline-flex', gap: 1, flex: 'none' }}>
              <IconButton
                label={t('tr.editSegment')} size={20}
                onClick={beginEdit}
                icon={<Icon d={Icons.edit} size={11} />}
              />
            </span>
          )}
        </div>

        {/* 正文：点击即编辑 */}
        {editing ? (
          <div>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, Math.max(2, Math.ceil(draft.length / 46)))}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
              }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 5, justifyContent: 'flex-end' }}>
              <Btn onClick={() => setEditing(false)}>{t('common.cancel')}</Btn>
              <Btn tone="primary" onClick={commit}>{t('common.save')}</Btn>
            </div>
          </div>
        ) : (
          <div
            onClick={beginEdit}
            style={{
              fontSize: 12, lineHeight: 1.65, color: T.primary, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              cursor: interactive ? 'text' : 'default',
              // 未校/无法辨听的内容降低视觉权重，绝不冒充可信文本
              opacity: seg.status === 'inaudible' ? 0.6 : 1,
              fontStyle: seg.status === 'inaudible' ? 'italic' : 'normal',
            }}
          >
            {seg.text}
          </div>
        )}

        {/* 听校备注：警示色斜体 */}
        {seg.note && (
          <div style={{
            marginTop: 3, fontSize: 10.5, lineHeight: 1.5, fontStyle: 'italic',
            color: T.warning, display: 'flex', gap: 4, alignItems: 'flex-start',
          }}>
            <span style={{ flex: 'none', marginTop: 1 }}><Icon d={Icons.caution} size={10} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>{seg.note}</span>
          </div>
        )}

        {/* 机器转录原文 —— 保留"机器 vs 人工"的对照，是考订的依据 */}
        {seg.rawText && (
          <div style={{ marginTop: 3 }}>
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'none',
                padding: 0, cursor: 'pointer', fontSize: 10, color: T.caption,
              }}
            >
              <Icon d={showRaw ? Icons.chevronDown : Icons.chevronRight} size={9} />
              {t('tr.rawText')}
            </button>
            {showRaw && (
              <div style={{
                marginTop: 3, padding: '4px 7px', borderRadius: 6, fontSize: 11, lineHeight: 1.55,
                color: T.caption, background: T.cardBg, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {seg.rawText}
              </div>
            )}
          </div>
        )}

        {/* 快捷校订动作 */}
        {interactive && onSetStatus && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            <Chip
              label={t('tr.markVerified')}
              active={seg.status === 'human-verified'}
              color={T.success}
              onClick={() => onSetStatus('human-verified')}
            />
            <Chip
              label={t('tr.markUncertain')}
              active={seg.status === 'uncertain'}
              color={T.warning}
              onClick={() => onSetStatus('uncertain')}
            />
            <Chip
              label={t('tr.markInaudible')}
              active={seg.status === 'inaudible'}
              color={T.danger}
              onClick={() => onSetStatus('inaudible')}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ==========================================================================
 * 音频播放器 —— 听校的地基
 *
 * 自定义控件：播放/暂停、可拖动进度条、当前/总时长、倍速。
 * 慢放（0.75×）对方言重、语速快的老年受访者是刚需。
 * 卸载时务必 pause()，避免离开视图后音频继续播放。
 * ========================================================================== */

function AudioPlayer({ t, src, segList, attachAudio, currentTime, duration, playing, speed, error, onToggle, onSeek, onSpeed, onTimeUpdate, onDurationChange, onError, timelineOnly }: {
  t: TFunc;
  /** 录音地址；为 null 表示尚未关联录音，此时仅提供"逐字稿时间轴"拖动 */
  src: string | null;
  segList: Segment[];
  /** 用回调而非 RefObject：父组件需要一个不随卸载被置空的元素句柄 */
  attachAudio: (el: HTMLAudioElement | null) => void;
  currentTime: number;
  duration: number;
  playing: boolean;
  speed: number;
  error: string | null;
  onToggle: () => void;
  onSeek: (sec: number) => void;
  onSpeed: (v: number) => void;
  onTimeUpdate: (sec: number) => void;
  onDurationChange: (sec: number) => void;
  onError: () => void;
  /** true = 无录音，用逐字稿时间轴驱动进度条（仍可拖动定位分段） */
  timelineOnly?: boolean;
}) {
  const total = duration || 0;
  const pctOf = (v: number) => (total > 0 ? Math.max(0, Math.min(1, v / total)) : 0);

  /** 进度条指针位置 → 秒（拖动与点击共用） */
  const seekFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || total <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return ratio * total;
  };

  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);
  const shown = dragging ? dragValue : currentTime;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* 真实 <audio> 元素：src 由调用方决定（见 audioSrcFor 注释）。
          无录音时不渲染该元素——但下面的进度条仍然可用，走 timelineOnly 分支。 */}
      {src !== null && (
      <audio
        ref={attachAudio}
        src={src}
        preload="metadata"
        onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => onDurationChange(e.currentTarget.duration)}
        onDurationChange={(e) => onDurationChange(e.currentTarget.duration)}
        onEnded={() => onTimeUpdate(0)}
        onError={onError}
        style={{ display: 'none' }}
      />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={onToggle}
          title={playing ? t('tr.pause') : t('tr.playAll')}
          aria-label={playing ? t('tr.pause') : t('tr.playAll')}
          className="sch-press"
          style={{
            width: 30, height: 30, flex: 'none', borderRadius: 999, border: 'none', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 18%, transparent)',
            color: T.business,
          }}
        >
          {playing
            ? <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden><path d="M3 2h2.2v8H3zM6.8 2H9v8H6.8z" fill="currentColor" /></svg>
            : <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden><path d="M3 1.8l7 4.2-7 4.2z" fill="currentColor" /></svg>}
        </button>

        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11, color: T.secondary, flex: 'none' }}>
          {fmtTime(shown)} / {fmtTime(total)}
        </span>

        {/* 进度条：点击/拖动定位；叠加分段刻度，便于看清结构 */}
        <div
          role="slider"
          tabIndex={0}
          aria-label={t('tr.seek')}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(shown)}
          onPointerDown={(e) => {
            if (total <= 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            setDragValue(seekFromEvent(e));
          }}
          onPointerMove={(e) => { if (dragging) setDragValue(seekFromEvent(e)); }}
          onPointerUp={(e) => {
            if (!dragging) return;
            const v = seekFromEvent(e);
            setDragging(false);
            onSeek(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); onSeek(Math.max(0, shown - 5)); }
            if (e.key === 'ArrowRight') { e.preventDefault(); onSeek(Math.min(total, shown + 5)); }
          }}
          style={{
            position: 'relative', flex: 1, minWidth: 60, height: 16,
            display: 'flex', alignItems: 'center', cursor: 'pointer', touchAction: 'none',
          }}
        >
          <span style={{
            position: 'absolute', left: 0, right: 0, height: 5, borderRadius: 3,
            background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.25))', overflow: 'hidden',
          }}>
            <span style={{
              display: 'block', height: '100%', width: `${pctOf(shown) * 100}%`,
              background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            }} />
          </span>
          {/* 分段刻度：每一段起点一道细线，映射逐字稿结构 */}
          {total > 0 && segList.slice(0, 400).map((s) => (
            <span
              key={s.id}
              style={{
                position: 'absolute', left: `${pctOf(s.start) * 100}%`, top: 3, width: 1, height: 10,
                background: segmentColor(s.status), opacity: 0.55, pointerEvents: 'none',
              }}
            />
          ))}
          <span style={{
            position: 'absolute', left: `${pctOf(shown) * 100}%`, width: 11, height: 11, borderRadius: 999,
            transform: 'translateX(-50%)', pointerEvents: 'none',
            background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            boxShadow: '0 0 0 2px var(--dsw-alias-bg-base, #161616)',
          }} />
        </div>

        {/* 倍速：方言听辨的关键控件 */}
        <Select
          value={String(speed)}
          onChange={(e) => onSpeed(Number(e.target.value))}
          title={t('tr.speed')}
          style={{ width: 74, flex: 'none' }}
        >
          {SPEEDS.map((s) => <option key={s} value={String(s)}>{s}×</option>)}
        </Select>
      </div>

      {error && <div style={{ fontSize: 10.5, color: T.danger }}>{error}</div>}
    </div>
  );
}

/* ==========================================================================
 * 手工写入分段
 *
 * 支持两种输入：JSON 数组，或 "[MM:SS] 说话人: 正文" 行。
 * 解析尽量宽松——转录结果常从别处粘贴而来，格式并不整齐。
 * ========================================================================== */

function AppendSegmentsModal({ t, hasTranscript, onClose, onSubmit }: {
  t: TFunc;
  hasTranscript: boolean;
  onClose: () => void;
  onSubmit: (segments: Array<Record<string, unknown>>) => Promise<void>;
}) {
  const [raw, setRaw] = useState('');
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const preview = useMemo(() => parseSegmentBlob(raw), [raw]);

  const submit = async () => {
    if (!preview.segments.length) { setErr(t('tr.parseFail')); return; }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(language.trim() ? preview.segments.map((s) => ({ ...s, language })) : preview.segments);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={t('tr.appendSegments')} onClose={onClose} width={560}>
      <Field label={t('tr.appendHint')} hint={t('tr.appendFormat')}>
        <Textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={10}
          autoFocus
          placeholder={t('tr.appendPh')}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 }}
        />
      </Field>
      {!hasTranscript && (
        <Field label={t('tr.language')} hint={t('tr.languageHint')}>
          <Input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="zh" style={{ width: 120 }} />
        </Field>
      )}
      {raw.trim() && (
        <div style={{ fontSize: 11, color: preview.segments.length ? T.success : T.danger, marginBottom: 8 }}>
          {preview.segments.length ? t('tr.parseOk', { n: preview.segments.length }) : t('tr.parseFail')}
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: T.danger, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Btn onClick={onClose} disabled={busy}>{t('common.cancel')}</Btn>
        <Btn tone="primary" onClick={() => void submit()} disabled={busy || !preview.segments.length}>
          {busy ? t('common.saving') : t('common.save')}
        </Btn>
      </div>
    </Modal>
  );
}

/* ==========================================================================
 * 术语表面板
 *
 * 领域专名（人名、机构、术语）是 ASR 出错的重灾区。把反复出错的写法登记下来，
 * 即可对全文做确定性批量修正——这比逐段手改可靠得多，也留下可复核的规则。
 * 保存为整表替换（PUT {glossary: [...]}）。
 * ========================================================================== */

function GlossaryPanel({ t, entries, onSave, onSaveAndApply, busy }: {
  t: TFunc;
  entries: GlossaryEntry[];
  onSave: (next: GlossaryEntry[]) => Promise<void>;
  onSaveAndApply: (next: GlossaryEntry[]) => Promise<void>;
  busy: boolean;
}) {
  const [term, setTerm] = useState('');
  const [variants, setVariants] = useState('');
  const [kind, setKind] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const draft = (): GlossaryEntry | null => {
    const tm = term.trim();
    if (!tm) return null;
    const vars = splitList(variants);
    return {
      term: tm,
      ...(vars.length ? { variants: vars } : {}),
      ...(kind.trim() ? { kind: kind.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
  };

  const add = () => {
    const e = draft();
    if (!e) { setErr(t('tr.glossaryTermRequired')); return; }
    setErr(null);
    setTerm(''); setVariants(''); setKind(''); setNote('');
    void onSave([...entries, e]);
  };

  return (
    <Section title={t('tr.glossary')} sub={t('tr.glossarySub')} icon={<Icon d={Icons.book} size={11} />}>
      {entries.length === 0 && (
        <div style={{ fontSize: 11, color: T.caption, marginBottom: 8 }}>{t('tr.glossaryEmpty')}</div>
      )}

      {/* 已有条目：正确写法 + 误转录（删除线） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: entries.length ? 10 : 0 }}>
        {entries.map((g, i) => (
          <div key={`${g.term}-${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 11.5, fontWeight: 600, color: T.success, flex: 'none',
              padding: '1px 7px', borderRadius: 5,
              background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 14%, transparent)',
            }}>
              {g.term}
            </span>
            <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
              {(g.variants ?? []).map((v, j) => (
                <span key={`${v}-${j}`} style={{
                  fontSize: 10.5, color: T.caption, textDecoration: 'line-through',
                  padding: '1px 6px', borderRadius: 999, border: `1px solid ${T.borderL2}`,
                }}>
                  {v}
                </span>
              ))}
              {g.kind && <span style={{ fontSize: 10, color: T.caption, alignSelf: 'center' }}>· {g.kind}</span>}
              {g.note && <span style={{ fontSize: 10, color: T.caption, alignSelf: 'center' }}>· {truncate(g.note, 40)}</span>}
            </span>
            <IconButton
              label={t('common.delete')} size={20} color={T.danger} disabled={busy}
              onClick={() => void onSave(entries.filter((_, j) => j !== i))}
              icon={<Icon d={Icons.trash} size={11} />}
            />
          </div>
        ))}
      </div>

      {/* 新增条目 */}
      <div style={{ borderTop: entries.length ? `1px solid ${T.borderL2}` : 'none', paddingTop: entries.length ? 9 : 0 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 7 }}>
          <div style={{ flex: '0 0 30%' }}>
            <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={t('tr.glossaryTerm')} />
          </div>
          <div style={{ flex: 1 }}>
            <Input value={variants} onChange={(e) => setVariants(e.target.value)} placeholder={t('tr.glossaryVariantsPh')} />
          </div>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 96, flex: 'none' }}>
            <option value="">{t('tr.glossaryKindAll')}</option>
            {GLOSSARY_KINDS.map((k) => <option key={k} value={k}>{t(`tr.glossaryKind.${k}`)}</option>)}
          </Select>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('tr.glossaryNotePh')} style={{ flex: 1 }} />
          <Btn onClick={add} disabled={busy} title={t('tr.glossaryAdd')}>
            <Icon d={Icons.plus} size={11} />
            {t('tr.glossaryAdd')}
          </Btn>
          <Btn tone="soft" disabled={busy} onClick={() => { const e = draft(); void onSaveAndApply(e ? [...entries, e] : entries); }}>
            <Icon d={Icons.sparkle} size={11} />
            {t('tr.glossarySaveApply')}
          </Btn>
        </div>
        {err && <div style={{ fontSize: 10.5, color: T.danger, marginTop: 5 }}>{err}</div>}
      </div>

      <div style={{ fontSize: 10.5, color: T.caption, marginTop: 8, lineHeight: 1.6 }}>{t('tr.glossaryHint')}</div>
    </Section>
  );
}

/* ==========================================================================
 * 校对进度汇总
 *
 * 档案的"证据质量"必须一眼可见：各状态段数 + 堆叠条 + 总体人工听校比例。
 * 未校内容永远不能被当作可信史料——这是本工具的反虚构底线。
 * ========================================================================== */

function ProgressSummary({ t, segments, verifiedRatio }: { t: TFunc; segments: Segment[]; verifiedRatio: number }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of SEGMENT_STATUSES) c[s] = 0;
    for (const s of segments) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [segments]);

  const total = segments.length;
  const pct = Math.max(0, Math.min(1, Number.isFinite(verifiedRatio) ? verifiedRatio : 0));

  return (
    <Section title={t('tr.progressTitle')} icon={<Icon d={Icons.verified} size={11} />}>
      {/* 堆叠条：各状态占比 */}
      <div style={{
        display: 'flex', height: 9, borderRadius: 5, overflow: 'hidden', marginBottom: 7,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.22))',
      }}>
        {total > 0 && SEGMENT_STATUSES.map((st) => {
          const n = counts[st] ?? 0;
          if (!n) return null;
          return (
            <span
              key={st}
              title={`${t(`tr.statusCount.${st}`)} ${n}`}
              style={{ width: `${(n / total) * 100}%`, background: segmentColor(st), height: '100%' }}
            />
          );
        })}
      </div>

      {/* 计数图例 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 7 }}>
        {SEGMENT_STATUSES.map((st) => (
          <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: T.secondary }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: segmentColor(st), flex: 'none' }} />
            {t(`tr.statusCount.${st}`)}
            <span style={{ color: T.caption, fontVariantNumeric: 'tabular-nums' }}>{counts[st] ?? 0}</span>
          </span>
        ))}
      </div>

      {/* 总体人工听校比例 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ flex: 1 }}><ProgressBar ratio={pct} width={160} height={6} /></span>
        <span style={{ fontSize: 11, color: T.secondary, flex: 'none' }}>
          {t('tr.verifiedRatio', { pct: Math.round(pct * 100) })}
        </span>
        <span style={{ fontSize: 10.5, color: T.caption, flex: 'none' }}>
          {t('tr.verifiedCount', { n: counts['human-verified'] ?? 0, total })}
        </span>
      </div>
    </Section>
  );
}

/* ==========================================================================
 * 主视图
 * ========================================================================== */

/**
 * 音频 URL 解析。
 *
 * 已核对 src/routes.ts：**访谈没有独立的音频路由**（不存在
 * /oral-history/interviews/:id/audio）。可用的音频/附件出口只有
 * GET /oral-history/sources/:sourceId/attachment，它按扩展名返回
 * audio/* 或 octet-stream，且要求 source.filePath 落在 attachments/ 下。
 *
 * 因此优先级为：
 *   1) interview.audioPath 存在 → 仍走史料附件路由（文件实际由史料持有）
 *   2) source.filePath 存在    → 史料附件路由
 *   3) 都没有                   → 渲染 tr.noAudioHint
 */
/**
 * 录音地址：走访谈专属的音频路由，服务端会优先取访谈自带 audioPath、
 * 回落到来源史料的附件——客户端不必关心录音挂在哪一层。
 */
function audioSrcFor(iv: Interview, source: Source | null): string | null {
  const hasAudioFile = !!iv.audioPath || !!source?.filePath;
  if (!hasAudioFile) return null;
  return `/oral-history/interviews/${encodeURIComponent(iv.id)}/audio`;
}

export function TranscriptView({ t }: { t: (key: string, params?: Record<string, unknown>) => string }) {
  const nav = useNav();

  /* ---------- 响应式：容器宽度 ---------- */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const measure = () => {
      const w = wrapRef.current?.clientWidth ?? window.innerWidth;
      setNarrow(w < NARROW_PX);
    };
    measure();
    const el = wrapRef.current;
    let ro: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  /* ---------- 列表状态 ---------- */
  const saved = useRef(loadSavedFilters<IvFilters>(FILTER_KEY)).current;
  const [q, setQ] = useState(saved.q ?? '');
  const [debouncedQ, setDebouncedQ] = useState(saved.q ?? '');
  const [field, setField] = useState(saved.field ?? '');
  const [affiliation, setAffiliation] = useState(saved.affiliation ?? '');
  const [sort, setSort] = useState<IvSort>(saved.sort ?? 'year');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 280);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    saveFilters(FILTER_KEY, { q, field, affiliation, sort } satisfies IvFilters);
  }, [q, field, affiliation, sort]);

  const [list, setList] = useState<InterviewListItem[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);

  const loadList = useCallback(() => {
    let alive = true;
    setListErr(null);
    void api<{ total: number; interviews: InterviewListItem[] }>(
      `/oral-history/interviews${qs({ q: debouncedQ, field, affiliation })}`,
    )
      .then((res) => { if (alive) setList(res.interviews ?? []); })
      .catch((e: unknown) => {
        if (!alive) return;
        setList([]);
        setListErr(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [debouncedQ, field, affiliation]);

  useEffect(() => loadList(), [loadList]);

  /* ---------- 详情状态 ---------- */
  const [detail, setDetail] = useState<{ interview: Interview; transcript: Transcript | null; source: Source | null } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  /**
   * 正在请求/已加载的访谈 id。
   * 三条路径都可能要求打开同一份访谈（nav.interviewId 的 effect、列表加载完后的
   * 预选消费、以及点击行）——没有这道闸就会出现同一 id 的重复请求。
   */
  const loadedIdRef = useRef<string | null>(null);

  const loadDetail = useCallback((id: string) => {
    if (loadedIdRef.current === id) return;
    loadedIdRef.current = id;
    let alive = true;
    setDetailLoading(true);
    setDetailErr(null);
    void api<{ interview: Interview; transcript: Transcript | null; source: Source | null }>(
      `/oral-history/interviews/${encodeURIComponent(id)}`,
    )
      .then((res) => { if (alive) setDetail(res); })
      .catch((e: unknown) => {
        if (alive) {
          // 失败时释放闸门，允许重试同一 id
          loadedIdRef.current = null;
          setDetailErr(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, []);

  /** 强制重新拉取（写操作/编辑保存后需要最新数据） */
  const reloadDetail = useCallback((id: string) => {
    loadedIdRef.current = null;
    loadDetail(id);
  }, [loadDetail]);

  /* ---------- 选中访谈：nav.interviewId 优先 ---------- */
  const selectedId = detail?.interview.id ?? null;
  useEffect(() => {
    const wanted = nav.interviewId;
    if (wanted && wanted !== selectedId) loadDetail(wanted);
  }, [nav.interviewId, selectedId, loadDetail]);

  /** 列表加载完后：nav.interviewId 与 nav.sourceId 的预选消费 */
  const consumedListIntent = useRef(false);
  useEffect(() => {
    if (consumedListIntent.current || !list) return;
    const wantedIv = nav.interviewId;
    const wantedSrc = nav.sourceId;
    if (wantedIv) {
      consumedListIntent.current = true;
      loadDetail(wantedIv);
      return;
    }
    if (wantedSrc) {
      consumedListIntent.current = true;
      const hit = list.find((x) => x.sourceId === wantedSrc);
      if (hit) loadDetail(hit.id);
      navBus.consumeSourceId();
    }
  }, [list, nav.interviewId, nav.sourceId, loadDetail]);

  /* ---------- 新建 / 编辑 ---------- */
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Interview | null>(null);
  /** 口语史料候选；null = 尚未加载 */
  const [ohSources, setOhSources] = useState<Source[] | null>(null);
  const [sourcesErr, setSourcesErr] = useState<string | null>(null);

  const loadOhSources = useCallback(async (): Promise<Source[]> => {
    try {
      const res = await api<{ total: number; sources: Source[] }>(
        `/oral-history/sources${qs({ tier: 'primary', primaryKind: 'oral-history' })}`,
      );
      const next = res.sources ?? [];
      setOhSources(next);
      setSourcesErr(null);
      return next;
    } catch (e) {
      setOhSources([]);
      setSourcesErr(e instanceof Error ? e.message : String(e));
      return [];
    }
  }, []);

  /** 「建立访谈档案」：先确认存在口语史料，空则给引导而不是空表单 */
  const openNewForm = useCallback(async () => {
    setEditTarget(null);
    const sources = ohSources ?? await loadOhSources();
    if (!sources.length) {
      setFormOpen(true); // 由 noSources 分支渲染引导文案
      return;
    }
    setFormOpen(true);
  }, [ohSources, loadOhSources]);

  /** 消费史料详情页带来的 prefill（只消费一次） */
  const consumedPrefill = useRef(false);
  useEffect(() => {
    if (consumedPrefill.current) return;
    const prefill = nav.prefillInterviewSourceId;
    if (!prefill) return;
    consumedPrefill.current = true;
    setEditTarget(null);
    setFormOpen(true);
    navBus.consumePrefill();
  }, [nav.prefillInterviewSourceId]);

  const onSaved = (iv: Interview, created: boolean) => {
    setFormOpen(false);
    setEditTarget(null);
    loadList();
    // 表单刚改过数据，必须绕过去重闸门重新拉取
    reloadDetail(iv.id);
    if (created) navBus.patch({ interviewId: iv.id });
  };

  /* ---------- 音频 ---------- */
  /** 当前 <audio> 元素（可写：ref 回调需要写入） */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [audioErr, setAudioErr] = useState<string | null>(null);

  /**
   * 卸载时暂停音频。
   *
   * 注意：React 会在执行 effect 清理函数**之前**把 ref.current 置为 null，
   * 所以这里不能依赖 audioRef.current —— 必须用一个独立的"元素句柄"来接住
   * 那个 DOM 节点（由 ref 回调在挂载/卸载时写入），否则 pause() 永远不会被调用，
   * 离开视图后录音会继续播放。
   *
   * 依赖数组为空：只在真正卸载时跑一次；切换访谈由下面那个 effect 负责。
   */
  const mediaElRef = useRef<HTMLAudioElement | null>(null);
  const attachAudio = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
    if (el) mediaElRef.current = el;
  }, []);

  useEffect(() => () => {
    const el = mediaElRef.current;
    if (!el) return;
    el.pause();
    try { el.currentTime = 0; } catch { /* 元数据未就绪时忽略 */ }
  }, []);

  /** 切换访谈时也要停下来，避免上一份录音继续播放 */
  const firstSelectRef = useRef(true);
  useEffect(() => {
    if (firstSelectRef.current) { firstSelectRef.current = false; return; }
    mediaElRef.current?.pause();
  }, [selectedId]);

  // 倍速作用于元素（React 的 <audio> 没有 speed 属性）
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed; }, [speed, selectedId]);

  // 播放状态跟随元素（用户用原生控件或系统媒体键操作时也要同步）
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
    };
  }, [selectedId]);

  // 切换访谈时重置时间轴
  useEffect(() => { setCurrentTime(0); setDuration(0); setPlaying(false); setAudioErr(null); }, [selectedId]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setAudioErr(t('tr.playbackUnsupported')));
    else el.pause();
  }, [t]);

  /** 定位。无音频元素时（未关联录音）仍然更新游标——时间轴照常可拖动。 */
  const seek = useCallback((sec: number) => {
    const v = Math.max(0, sec);
    const el = audioRef.current;
    if (el) { try { el.currentTime = v; } catch { /* 忽略未就绪 */ } }
    setCurrentTime(v);
  }, []);

  /** 点时间戳：定位；有录音时接着播放，没有就只定位。 */
  const seekAndPlay = useCallback((sec: number) => {
    const v = Math.max(0, sec);
    const el = audioRef.current;
    if (el) {
      try { el.currentTime = v; } catch { /* ignore */ }
      void el.play().catch(() => setAudioErr(t('tr.playbackUnsupported')));
    }
    setCurrentTime(v);
  }, [t]);

  /* ---------- 逐字稿状态 ---------- */
  const [statusFilter, setStatusFilter] = useState<SegmentStatus | 'all'>('all');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [speakerFilter, setSpeakerFilter] = useState<SpeakerRole | 'all'>('all');
  const [glossaryMsg, setGlossaryMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [segErr, setSegErr] = useState<string | null>(null);
  const [appendOpen, setAppendOpen] = useState(false);

  const transcript = detail?.transcript ?? null;
  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);

  /** 详情里的逐字稿可能为 null（访谈存在但从未转录）——按访谈补拉一次 */
  const [fetchedTranscript, setFetchedTranscript] = useState<Transcript | null>(null);
  useEffect(() => {
    setFetchedTranscript(null);
    if (!detail || detail.transcript || !detail.interview.transcriptId) return;
    let alive = true;
    void api<{ transcript: Transcript | null }>(
      `/oral-history/transcripts/by-interview/${encodeURIComponent(detail.interview.id)}`,
    )
      .then((res) => { if (alive) setFetchedTranscript(res.transcript ?? null); })
      .catch(() => { /* 无稿是正常状态 */ });
    return () => { alive = false; };
  }, [detail]);

  const activeTranscript = transcript ?? fetchedTranscript;
  const activeSegments = useMemo(() => activeTranscript?.segments ?? [], [activeTranscript]);

  /** 过滤后的分段 */
  const visibleSegments = useMemo(() => {
    return activeSegments.filter((s) => {
      if (pendingOnly && s.status === 'human-verified') return false;
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (speakerFilter !== 'all' && s.speaker !== speakerFilter) return false;
      return true;
    });
  }, [activeSegments, pendingOnly, statusFilter, speakerFilter]);

  /** 播放位置所在分段 —— "卡拉OK"跟随的核心计算 */
  const activeSegmentId = useMemo(() => {
    if (!activeSegments.length) return null;
    let hit: Segment | null = null;
    for (const s of activeSegments) {
      if (currentTime >= s.start && currentTime < s.end) { hit = s; break; }
      if (s.start <= currentTime) hit = s;
    }
    // 落到所有分段之前时，取第一段
    if (!hit && currentTime < activeSegments[0].start) hit = activeSegments[0];
    return hit?.id ?? null;
  }, [activeSegments, currentTime]);

  /** 自动滚动到当前分段（只在播放位置跨段时触发，避免与手动滚动打架） */
  const listScrollerRef = useRef<HTMLDivElement>(null);
  /** 详情列的滚动容器——卡拉OK跟随与 nav 定位都作用于它 */
  const detailScrollerRef = useRef<HTMLDivElement>(null);
  const lastScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSegmentId || activeSegmentId === lastScrolledRef.current) return;
    lastScrolledRef.current = activeSegmentId;
    const host = detailScrollerRef.current;
    const node = host?.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(activeSegmentId)}"]`);
    if (!host || !node) return;
    // 容器内滚动：只在该行不可见时才动，保持阅读位置稳定
    const hostRect = host.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (rect.top < hostRect.top + 8 || rect.bottom > hostRect.bottom - 8) {
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeSegmentId]);

  /** nav.focusSegmentId：挂载/变化时定位并高亮，然后消费 */
  const [focusSegmentId, setFocusSegmentId] = useState<string | null>(null);
  useEffect(() => {
    const target = nav.focusSegmentId;
    if (!target || !activeSegments.length) return;
    const node = detailScrollerRef.current?.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(target)}"]`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFocusSegmentId(target);
    navBus.consumeFocusSegment();
    const timer = setTimeout(() => setFocusSegmentId(null), 2600);
    return () => clearTimeout(timer);
  }, [nav.focusSegmentId, activeSegments]);

  /* ---------- 逐字稿写操作 ---------- */

  /** 统一写入口：PUT 后本地替换并用返回值重算（同时刷新徽标） */
  const putTranscript = useCallback(async (body: Record<string, unknown>): Promise<Transcript | null> => {
    const id = activeTranscript?.id;
    if (!id) return null;
    setBusy(true);
    setSegErr(null);
    try {
      const res = await api<{ transcript: Transcript; replacements?: number }>(
        `/oral-history/transcripts/${encodeURIComponent(id)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
      setFetchedTranscript(res.transcript);
      setDetail((d) => (d ? { ...d, transcript: res.transcript } : d));
      refreshCounts();
      return res.transcript;
    } catch (e) {
      setSegErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [activeTranscript?.id]);

  const setSegmentStatus = useCallback((segId: string, status: SegmentStatus) => {
    void putTranscript({ segmentId: segId, patch: { status } });
  }, [putTranscript]);

  const saveSegmentText = useCallback((segId: string, text: string) => {
    void putTranscript({ segmentId: segId, patch: { text } });
  }, [putTranscript]);

  /** 写入分段：已有稿 → appendSegments；无稿 → 先建稿 */
  const appendSegmentsToTranscript = useCallback(async (segs: Array<Record<string, unknown>>) => {
    const iv = detail?.interview;
    if (!iv) return;
    setBusy(true);
    setSegErr(null);
    try {
      if (activeTranscript) {
        const res = await api<{ transcript: Transcript }>(
          `/oral-history/transcripts/${encodeURIComponent(activeTranscript.id)}`,
          { method: 'PUT', body: JSON.stringify({ appendSegments: segs }) },
        );
        setFetchedTranscript(res.transcript);
        setDetail((d) => (d ? { ...d, transcript: res.transcript } : d));
      } else {
        const res = await api<{ transcript: Transcript }>(
          `/oral-history/transcripts/by-interview/${encodeURIComponent(iv.id)}`,
          { method: 'POST', body: JSON.stringify({ segments: segs, language: undefined }) },
        );
        setFetchedTranscript(res.transcript);
        setDetail((d) => (d ? { ...d, transcript: res.transcript } : d));
      }
      refreshCounts();
      setAppendOpen(false);
    } catch (e) {
      setSegErr(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, [detail?.interview, activeTranscript]);

  /** 保存术语表（整表替换） */
  const saveGlossary = useCallback(async (next: GlossaryEntry[]) => {
    await putTranscript({ glossary: next });
  }, [putTranscript]);

  /** 保存术语表并立即应用 */
  const saveAndApplyGlossary = useCallback(async (next: GlossaryEntry[]) => {
    const saved = await putTranscript({ glossary: next });
    if (!saved) return;
    setBusy(true);
    try {
      const res = await api<{ transcript: Transcript; replacements?: number }>(
        `/oral-history/transcripts/${encodeURIComponent(saved.id)}`,
        { method: 'PUT', body: JSON.stringify({ applyGlossary: true }) },
      );
      setFetchedTranscript(res.transcript);
      setDetail((d) => (d ? { ...d, transcript: res.transcript } : d));
      setGlossaryMsg(t('tr.glossaryApplied', { n: res.replacements ?? 0 }));
      refreshCounts();
      setTimeout(() => setGlossaryMsg(null), 3600);
    } catch (e) {
      setSegErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [putTranscript, t]);

  // applyGlossary 的 replacements 在响应顶层而非 transcript 内，所以这里不复用 putTranscript
  const applyGlossaryExplicit = useCallback(async () => {
    const id = activeTranscript?.id;
    if (!id) return;
    setBusy(true);
    setSegErr(null);
    try {
      const res = await api<{ transcript: Transcript; replacements?: number }>(
        `/oral-history/transcripts/${encodeURIComponent(id)}`,
        { method: 'PUT', body: JSON.stringify({ applyGlossary: true }) },
      );
      setFetchedTranscript(res.transcript);
      setDetail((d) => (d ? { ...d, transcript: res.transcript } : d));
      setGlossaryMsg(t('tr.glossaryApplied', { n: res.replacements ?? 0 }));
      refreshCounts();
      setTimeout(() => setGlossaryMsg(null), 3600);
    } catch (e) {
      setSegErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [activeTranscript?.id, t]);

  const exportMd = useCallback(() => {
    const id = detail?.interview.id;
    if (!id) return;
    window.open(`/oral-history/export/interview${qs({ id, download: 1 })}`, '_blank', 'noopener');
  }, [detail?.interview.id]);

  /* ---------- 选中一行 ---------- */
  const selectInterview = useCallback((id: string) => {
    setDetail(null);
    setFetchedTranscript(null);
    setStatusFilter('all');
    setPendingOnly(false);
    setSpeakerFilter('all');
    setSegErr(null);
    // 用户显式点击，即使同一行也重新拉取（可能需要最新数据）
    reloadDetail(id);
    navBus.patch({ interviewId: id });
  }, [reloadDetail]);

  const backToList = useCallback(() => {
    loadedIdRef.current = null;
    setDetail(null);
    setFetchedTranscript(null);
    navBus.patch({ interviewId: null });
  }, []);

  /* ---------- 排序后的列表 ---------- */
  const sortedList = useMemo(() => {
    const arr = [...(list ?? [])];
    if (sort === 'name') {
      arr.sort((a, b) => a.interviewee.name.localeCompare(b.interviewee.name, 'zh-Hans-CN'));
    } else {
      arr.sort((a, b) => sortYear(b) - sortYear(a));
    }
    return arr;
  }, [list, sort]);

  const iv = detail?.interview ?? null;
  const src = detail?.source ?? null;
  const audioSrc = iv ? audioSrcFor(iv, src) : null;

  /**
   * 无录音时的进度条总长：取逐字稿最后一段的结束秒数。
   * 这样"尚未拿到录音"的访谈依然能拖动时间轴定位分段——
   * 逐字稿本身就携带时间信息，不该因为缺音频而把它一起藏起来。
   */
  const timelineDuration = useMemo(() => {
    const segs = detail?.transcript?.segments ?? [];
    let end = 0;
    for (const sg of segs) if (sg.end > end) end = sg.end;
    return end;
  }, [detail]);

  /* ---------- 列表列 ---------- */
  const listColumn = (
    <div style={{
      width: narrow ? '100%' : 248, flex: narrow ? '1 1 auto' : 'none',
      minWidth: 0, display: 'flex', flexDirection: 'column',
      borderRight: narrow ? 'none' : `1px solid ${T.borderL2}`,
    }}>
      {/* 工具条：搜索 + 新建 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '0 0 8px', flex: 'none' }}>
        <SearchInput value={q} onChange={setQ} placeholder={t('iv.searchPh')} />
        <Btn tone="primary" onClick={() => void openNewForm()} title={t('iv.new')}>
          <Icon d={Icons.plus} size={11} />
        </Btn>
      </div>

      {/* 筛选：领域 / 机构 / 排序 */}
      <div style={{ display: 'flex', gap: 5, padding: '0 0 8px', flex: 'none', flexWrap: 'wrap' }}>
        <Select value={field} onChange={(e) => setField(e.target.value)} style={{ flex: '1 1 70px' }}>
          <option value="">{t('iv.fieldAll')}</option>
          {FIELD_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
        </Select>
        <Select value={affiliation} onChange={(e) => setAffiliation(e.target.value)} style={{ flex: '1 1 70px' }}>
          <option value="">{t('iv.affiliationAll')}</option>
          {AFFILIATION_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as IvSort)} style={{ flex: '0 0 62px' }}>
          <option value="year">{t('iv.sortYear')}</option>
          <option value="name">{t('iv.sortName')}</option>
        </Select>
      </div>

      {/* 活动筛选提示 */}
      {(field || affiliation) && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', paddingBottom: 7, flex: 'none' }}>
          {field && <FilterChip label={field} onRemove={() => setField('')} />}
          {affiliation && <FilterChip label={affiliation} onRemove={() => setAffiliation('')} />}
        </div>
      )}

      {listErr && <div style={{ fontSize: 10.5, color: T.danger, paddingBottom: 6 }}>{listErr}</div>}

      {/* 访谈行 */}
      <div ref={listScrollerRef} className="sch-scroll sch-list" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {list === null && (
          <div style={{ fontSize: 11, color: T.caption, padding: '10px 2px' }}>{t('common.loading')}</div>
        )}
        {list !== null && sortedList.length === 0 && (
          <EmptyState
            icon={<Icon d={Icons.mic} size={26} />}
            title={t('iv.noInterviews')}
            hint={t('iv.noInterviewsHint')}
            action={<Btn onClick={() => void openNewForm()}>{t('iv.new')}</Btn>}
          />
        )}
        {sortedList.map((item, i) => {
          const life = lifeDates(item.interviewee.birthYear, item.interviewee.deathYear);
          const who = [...item.interviewee.roles, ...item.interviewee.affiliations].slice(0, 2).join(' · ');
          const ratio = Math.max(0, Math.min(1, Number.isFinite(item.verifiedRatio) ? item.verifiedRatio : 0));
          const on = item.id === selectedId;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => selectInterview(item.id)}
              className="sch-card"
              style={{
                // 用 --sch-i 驱动入场 stagger
                ['--sch-i' as string]: i,
                display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                marginBottom: 6, padding: '7px 9px', borderRadius: 9,
                border: `1px solid ${on ? 'transparent' : T.borderL2}`,
                background: on
                  ? 'linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 16%, transparent), color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 9%, transparent))'
                  : 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
                boxShadow: on ? 'inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 40%, transparent)' : 'none',
                color: T.primary,
              }}
            >
              {/* 受访者 + 生卒年 */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
                <span style={{ fontWeight: 700, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.interviewee.name}
                </span>
                {life && <span style={{ fontSize: 10, color: T.caption, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{life}</span>}
                <span style={{ flex: 1 }} />
                {/* 录音载体徽标：提示转录难度 */}
                {item.recording?.originalMedium && (
                  <span title={item.recording.originalMedium} style={{
                    flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 9,
                    color: T.warning, padding: '0 5px', height: 15, lineHeight: '15px', borderRadius: 4,
                    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f5a524) 14%, transparent)',
                    maxWidth: 84, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    <Icon d={Icons.tape} size={9} />
                    {truncate(item.recording.originalMedium, 7)}
                  </span>
                )}
              </div>

              {who && (
                <div style={{ fontSize: 10.5, color: T.secondary, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {who}
                </div>
              )}

              {/* 时间 / 地点 / 段数 */}
              <div style={{ display: 'flex', gap: 6, fontSize: 10, color: T.caption, marginTop: 3, flexWrap: 'wrap' }}>
                {interviewWhen(item) && <span>{interviewWhen(item)}</span>}
                {item.location && <span>· {truncate(item.location, 12)}</span>}
                {item.segments > 0 && <span>· {t('tr.segments', { count: item.segments })}</span>}
              </div>

              {/* 校对进度条：档案被人工核验的比例 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5 }}>
                <span style={{ flex: 1 }}><ProgressBar ratio={ratio} /></span>
                <span style={{ fontSize: 9.5, color: ratio >= 1 ? T.success : T.caption, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
                  {t('tr.verifiedRatio', { pct: Math.round(ratio * 100) })}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  /* ---------- 详情列 ---------- */
  const detailColumn = (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingLeft: narrow ? 0 : 12 }}>
      {detailLoading && !iv && (
        <div style={{ fontSize: 11, color: T.caption, padding: '10px 2px' }}>{t('common.loading')}</div>
      )}
      {detailErr && <div style={{ fontSize: 11, color: T.danger, padding: '6px 2px' }}>{detailErr}</div>}

      {!detailLoading && !iv && !detailErr && (
        <EmptyState
          icon={<Icon d={Icons.waveform} size={28} />}
          title={t('iv.selectPrompt')}
          hint={t('iv.selectPromptHint')}
        />
      )}

      {iv && (
        <>
          {/* 头部：受访者档案 + 通往史料的链接 */}
          <div style={{ flex: 'none', paddingBottom: 8 }}>
            {narrow && (
              <div style={{ marginBottom: 6 }}>
                <Btn onClick={backToList} title={t('common.back')}>
                  <Icon d={Icons.back} size={11} />
                  {t('iv.all')}
                </Btn>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{iv.interviewee.name}</span>
                  {lifeDates(iv.interviewee.birthYear, iv.interviewee.deathYear) && (
                    <span style={{ fontSize: 11, color: T.caption, fontVariantNumeric: 'tabular-nums' }}>
                      {lifeDates(iv.interviewee.birthYear, iv.interviewee.deathYear)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                  {iv.interviewee.roles.map((r) => <Chip key={`r-${r}`} label={r} />)}
                  {iv.interviewee.fields.map((f) => (
                    <Chip key={`f-${f}`} label={f} color={T.teal} />
                  ))}
                  {iv.interviewee.affiliations.map((a) => (
                    <Chip key={`a-${a}`} label={a} color={T.purple} />
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 2, flex: 'none' }}>
                <IconButton
                  label={t('iv.edit')}
                  onClick={() => { setEditTarget(iv); setFormOpen(true); void loadOhSources(); }}
                  icon={<Icon d={Icons.edit} size={13} />}
                />
                <IconButton
                  label={t('tr.export')}
                  onClick={exportMd}
                  icon={<Icon d={Icons.download} size={13} />}
                />
              </div>
            </div>

            <div style={{
              marginTop: 7, paddingTop: 7, borderTop: `1px solid ${T.borderL2}`,
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '2px 12px',
            }}>
              {interviewWhen(iv) && <Meta k={t('iv.interviewDate')} v={interviewWhen(iv)} />}
              {iv.location && <Meta k={t('iv.location')} v={iv.location} />}
              {iv.interviewers.length > 0 && (
                <Meta
                  k={t('iv.interviewers')}
                  v={iv.interviewers.map((x) => (x.affiliation ? `${x.name}（${x.affiliation}）` : x.name)).join('、')}
                />
              )}
              {iv.recording?.originalMedium && <Meta k={t('iv.originalMedium')} v={iv.recording.originalMedium} />}
              {iv.recording?.qualityNote && <Meta k={t('iv.qualityNote')} v={iv.recording.qualityNote} />}
              {src && (
                <Meta
                  k={t('iv.source')}
                  v={
                    <button
                      type="button"
                      onClick={() => navBus.go('sources', { sourceId: iv.sourceId })}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'none',
                        padding: 0, cursor: 'pointer', color: T.business, fontSize: 11, textAlign: 'left',
                      }}
                    >
                      <Icon d={Icons.link} size={10} />
                      {truncate(src.title, 32)}
                    </button>
                  }
                />
              )}
            </div>
            {!src && (
              <button
                type="button"
                onClick={() => navBus.go('sources', { sourceId: iv.sourceId })}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'none',
                  padding: '4px 0 0', cursor: 'pointer', color: T.business, fontSize: 10.5,
                }}
              >
                <Icon d={Icons.link} size={10} />
                {t('iv.openSource')}
              </button>
            )}
          </div>

          {/* 音频 + 逐字稿工具区 */}
          <div ref={detailScrollerRef} className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {/* 播放器 —— 始终渲染。
                没有录音文件时，进度条改由逐字稿时间轴驱动（timelineOnly），
                你仍然可以拖动定位到任意分段；只是按播放不会出声。
                这样"尚未关联录音"和"没有界面可用"就是两件事。 */}
            <Section title={t('iv.audio')} icon={<Icon d={Icons.waveform} size={11} />}>
              {audioSrc === null && (
                <div style={{ fontSize: 11, color: T.caption, lineHeight: 1.6, marginBottom: 6 }}>
                  {t('tr.noAudioHint')}
                </div>
              )}
              <AudioPlayer
                t={t}
                src={audioSrc}
                timelineOnly={audioSrc === null}
                segList={activeSegments}
                attachAudio={attachAudio}
                currentTime={currentTime}
                duration={duration || timelineDuration}
                playing={playing}
                speed={speed}
                error={audioErr}
                onToggle={togglePlay}
                onSeek={seek}
                onSpeed={setSpeed}
                onTimeUpdate={setCurrentTime}
                onDurationChange={setDuration}
                onError={() => setAudioErr(t('tr.playbackUnsupported'))}
              />
            </Section>

            {/* 进度汇总 */}
            <ProgressSummary
              t={t}
              segments={activeSegments}
              verifiedRatio={Math.max(0, Math.min(1, activeTranscript?.verifiedRatio ?? 0))}
            />

            {/* 工具栏：过滤 + 批量动作 */}
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <Chip label={t('tr.statusAll')} active={statusFilter === 'all' && !pendingOnly} onClick={() => { setStatusFilter('all'); setPendingOnly(false); }} />
              {SEGMENT_STATUSES.map((st) => (
                <Chip
                  key={st}
                  label={t(`tr.statusCount.${st}`)}
                  color={segmentColor(st)}
                  active={statusFilter === st}
                  onClick={() => { setStatusFilter(statusFilter === st ? 'all' : st); setPendingOnly(false); }}
                />
              ))}
              <Chip
                label={t('tr.filterPending')}
                active={pendingOnly}
                color={T.warning}
                onClick={() => { setPendingOnly((v) => !v); setStatusFilter('all'); }}
              />
              <span style={{ flex: 1 }} />
              <Select
                value={speakerFilter}
                onChange={(e) => setSpeakerFilter(e.target.value as SpeakerRole | 'all')}
                style={{ width: 92, flex: 'none' }}
              >
                <option value="all">{t('tr.speaker')}·{t('tr.statusAll').replace(/^全部/, '全部')}</option>
                {SPEAKER_ROLES.map((r) => <option key={r} value={r}>{t(`tr.speaker.${r}`)}</option>)}
              </Select>
            </div>

            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
              <Btn onClick={() => setAppendOpen(true)} disabled={busy}>
                <Icon d={Icons.plus} size={11} />
                {t('tr.appendSegments')}
              </Btn>
              <Btn
                tone="soft"
                disabled={busy || !activeTranscript || !(activeTranscript.glossary?.length)}
                onClick={() => void applyGlossaryExplicit()}
              >
                <Icon d={Icons.sparkle} size={11} />
                {t('tr.glossaryApply')}
              </Btn>
              <Btn onClick={exportMd}>
                <Icon d={Icons.download} size={11} />
                {t('tr.export')}
              </Btn>
              {glossaryMsg && <span style={{ fontSize: 10.5, color: T.success }}>{glossaryMsg}</span>}
              {busy && <span style={{ fontSize: 10.5, color: T.caption }}>{t('tr.saving')}</span>}
            </div>

            {segErr && <div style={{ fontSize: 10.5, color: T.danger, marginTop: 6 }}>{segErr}</div>}

            {/* 分段列表 —— 核心交互 */}
            <Section
              title={t('tr.segments', { count: visibleSegments.length })}
              sub={activeSegments.length !== visibleSegments.length ? t('tr.filtered', { total: activeSegments.length }) : undefined}
              icon={<Icon d={Icons.list} size={11} />}
            >
              {activeSegments.length === 0 && (
                <EmptyState
                  icon={<Icon d={Icons.doc} size={24} />}
                  title={t('tr.noSegments')}
                  hint={t('tr.noSegmentsHint')}
                  action={<Btn onClick={() => setAppendOpen(true)}>{t('tr.appendSegments')}</Btn>}
                />
              )}
              {activeSegments.length > 0 && visibleSegments.length === 0 && (
                <div style={{ fontSize: 11, color: T.caption, padding: '8px 2px' }}>{t('tr.noMatch')}</div>
              )}
              <div className="sch-stagger" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {visibleSegments.map((s, i) => (
                  <div key={s.id} style={{ ['--sch-i' as string]: i }}>
                    <SegmentRow
                      seg={s}
                      t={t}
                      active={s.id === activeSegmentId}
                      onSeek={audioSrc ? seekAndPlay : undefined}
                      onSave={(text) => saveSegmentText(s.id, text)}
                      onSetStatus={(st) => setSegmentStatus(s.id, st)}
                    />
                    {/* nav 定位高亮：短暂脉冲，帮助从考据卡跳转后立刻找到该段 */}
                    {s.id === focusSegmentId && (
                      <div style={{
                        height: 2, margin: '-2px 8px 2px 10px', borderRadius: 1,
                        background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
                        animation: 'schBdIn .4s ease both',
                      }} />
                    )}
                  </div>
                ))}
              </div>
            </Section>

            {/* 术语表 */}
            {activeTranscript && (
              <GlossaryPanel
                t={t}
                entries={activeTranscript.glossary ?? []}
                busy={busy}
                onSave={saveGlossary}
                onSaveAndApply={saveAndApplyGlossary}
              />
            )}

            {iv.questionOutline && (
              <Section title={t('iv.questionOutline')} icon={<Icon d={Icons.list} size={11} />}>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, color: T.secondary, lineHeight: 1.65 }}>{iv.questionOutline}</div>
              </Section>
            )}
            {iv.backgroundNotes && (
              <Section title={t('iv.backgroundNotes')} icon={<Icon d={Icons.book} size={11} />}>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, color: T.secondary, lineHeight: 1.65 }}>{iv.backgroundNotes}</div>
              </Section>
            )}
            {iv.interviewee.bio && (
              <Section title={t('iv.bio')} icon={<Icon d={Icons.quote} size={11} />}>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, color: T.secondary, lineHeight: 1.65 }}>{iv.interviewee.bio}</div>
              </Section>
            )}

            <div style={{ height: 10 }} />
          </div>
        </>
      )}
    </div>
  );

  /* ---------- 组装 ---------- */
  const showDetail = !narrow || !!iv;

  return (
    <div
      ref={wrapRef}
      data-dsh-plugin="dsh-oral-history"
      data-dsh-part="transcript-view"
      style={{ flex: 1, minHeight: 0, display: 'flex', padding: '0 12px 0', overflow: 'hidden' }}
    >
      {(!narrow || !showDetail) && listColumn}
      {showDetail && detailColumn}

      {/* 新建 / 编辑访谈 */}
      {formOpen && editTarget === null && ohSources !== null && ohSources.length === 0 && (
        <Modal title={t('iv.new')} onClose={() => setFormOpen(false)} width={440}>
          <EmptyState
            icon={<Icon d={Icons.archive} size={26} />}
            title={t('iv.noSources')}
            hint={sourcesErr ? sourcesErr : t('iv.noSourcesHint')}
            action={<Btn tone="primary" onClick={() => { setFormOpen(false); navBus.go('sources'); }}>{t('iv.goSources')}</Btn>}
          />
        </Modal>
      )}
      {formOpen && (editTarget !== null || (ohSources !== null && ohSources.length > 0)) && (
        <IntervieweeForm
          t={t}
          sources={ohSources ?? []}
          initialSourceId={nav.prefillInterviewSourceId ?? ''}
          edit={editTarget}
          onClose={() => { setFormOpen(false); setEditTarget(null); }}
          onSaved={onSaved}
        />
      )}

      {/* 手工写入分段 */}
      {appendOpen && (
        <AppendSegmentsModal
          t={t}
          hasTranscript={!!activeTranscript}
          onClose={() => setAppendOpen(false)}
          onSubmit={appendSegmentsToTranscript}
        />
      )}
    </div>
  );
}
