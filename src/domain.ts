/**
 * dsh-oral-history — domain helpers shared by routes and agent tools:
 * create/merge semantics for sources, interviews, transcripts and evidence cards.
 * Pure functions; all I/O happens in OralHistoryStore.
 */
import type {
  CardKind, CardStatus, EvidenceCard, Interview, Interviewer, Interviewee,
  PrimaryKind, Provenance, SecondaryKind, Segment, SegmentStatus, Source, SourceStatus,
  SourceTier, TemporalSpan, Transcript, EvidenceGrade, SpeakerRole,
} from './shared/types.js';
import {
  CARD_KINDS, CARD_STATUSES, EVIDENCE_GRADES, PRIMARY_KINDS, SECONDARY_KINDS,
  SEGMENT_STATUSES, SOURCE_STATUSES, SPEAKER_ROLES, SOURCE_TIERS,
} from './shared/types.js';
import { newCardId, newInterviewId, newSegmentId, newTranscriptId, sourceIdFor } from './store.js';

/* ==========================================================================
 * 史料
 * ========================================================================== */

export interface SourcePatch {
  title?: string;
  /** 附件相对路径（attachments/xxx） */
  filePath?: string;
  tier?: SourceTier;
  primaryKind?: PrimaryKind;
  secondaryKind?: SecondaryKind;
  authors?: string[];
  temporal?: TemporalSpan;
  provenance?: Provenance;
  doi?: string;
  venue?: string;
  year?: number;
  arxivId?: string;
  url?: string;
  abstract?: string;
  summary?: string;
  language?: string;
  tags?: string[];
  importance?: number;
  status?: SourceStatus;
  evidenceGrade?: EvidenceGrade;
  notes?: string;
  collectionIds?: string[];
}

const pickEnum = <T extends readonly string[]>(arr: T, v: unknown, fallback?: T[number]): T[number] | undefined =>
  typeof v === 'string' && (arr as readonly string[]).includes(v) ? (v as T[number]) : fallback;

const cleanStr = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
};

const cleanTags = (tags: unknown): string[] =>
  [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean))];

/** 归一化时间定位：丢掉全空对象，保留原样纪年文本。 */
function normalizeTemporal(t: unknown): TemporalSpan | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const o = t as Record<string, unknown>;
  const out: TemporalSpan = {};
  for (const k of ['eventYearFrom', 'eventYearTo', 'createdYearFrom', 'createdYearTo'] as const) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.trunc(v);
  }
  const era = cleanStr(o.originalEra);
  if (era) out.originalEra = era;
  return Object.keys(out).length ? out : undefined;
}

/** 归一化馆藏信息：丢掉全空对象。 */
function normalizeProvenance(p: unknown): Provenance | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const o = p as Record<string, unknown>;
  const out: Provenance = {};
  for (const k of ['repository', 'callNumber', 'edition', 'medium', 'accessNote', 'digitizationNote'] as const) {
    const v = cleanStr(o[k]);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Build a new Source. */
export function createSource(input: SourcePatch & { source: 'agent' | 'manual' }, now = Date.now()): Source {
  const title = (input.title ?? '').trim();
  if (!title) throw new Error('史料标题不能为空');
  const tier = pickEnum(SOURCE_TIERS, input.tier, 'primary')!;
  const doi = cleanStr(input.doi);
  const src: Source = {
    id: sourceIdFor(title, doi),
    tier,
    title,
    authors: [...(input.authors ?? [])].map((a) => String(a).trim()).filter(Boolean),
    tags: cleanTags(input.tags),
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };

  if (tier === 'primary') {
    src.primaryKind = pickEnum(PRIMARY_KINDS, input.primaryKind, 'other-primary');
  } else {
    src.secondaryKind = pickEnum(SECONDARY_KINDS, input.secondaryKind, 'other-secondary');
  }

  const temporal = normalizeTemporal(input.temporal);
  if (temporal) src.temporal = temporal;
  const provenance = normalizeProvenance(input.provenance);
  if (provenance) src.provenance = provenance;

  if (doi) src.doi = doi;
  const venue = cleanStr(input.venue);
  if (venue) src.venue = venue;
  if (typeof input.year === 'number') src.year = input.year;
  const arxivId = cleanStr(input.arxivId);
  if (arxivId) src.arxivId = arxivId;
  const url = cleanStr(input.url);
  if (url) src.url = url;
  if (input.abstract !== undefined) src.abstract = input.abstract;
  if (input.summary !== undefined) src.summary = input.summary;
  const lang = cleanStr(input.language);
  if (lang) src.language = lang;
  if (typeof input.importance === 'number') src.importance = input.importance;
  src.status = pickEnum(SOURCE_STATUSES, input.status, 'unprocessed');
  const grade = pickEnum(EVIDENCE_GRADES, input.evidenceGrade);
  if (grade) src.evidenceGrade = grade;
  if (input.notes !== undefined) src.notes = input.notes;
  const cols = cleanTags(input.collectionIds);
  if (cols.length) src.collectionIds = cols;

  return src;
}

/** Merge only the provided fields onto an existing source. */
export function applySourcePatch(existing: Source, patch: SourcePatch, now = Date.now()): Source {
  const next: Source = { ...existing, updatedAt: now };
  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.tier !== undefined) {
    const t = pickEnum(SOURCE_TIERS, patch.tier);
    if (t) {
      next.tier = t;
      // 切换轨道时清掉另一轨的类型字段，避免出现 primary+secondaryKind 并存的脏数据
      if (t === 'primary') {
        delete next.secondaryKind;
        next.primaryKind = pickEnum(PRIMARY_KINDS, patch.primaryKind, next.primaryKind ?? 'other-primary');
      } else {
        delete next.primaryKind;
        next.secondaryKind = pickEnum(SECONDARY_KINDS, patch.secondaryKind, next.secondaryKind ?? 'other-secondary');
      }
    }
  }
  if (patch.primaryKind !== undefined && next.tier === 'primary') {
    const k = pickEnum(PRIMARY_KINDS, patch.primaryKind);
    if (k) next.primaryKind = k;
  }
  if (patch.secondaryKind !== undefined && next.tier === 'secondary') {
    const k = pickEnum(SECONDARY_KINDS, patch.secondaryKind);
    if (k) next.secondaryKind = k;
  }
  if (patch.authors !== undefined) next.authors = [...patch.authors].map((a) => String(a).trim()).filter(Boolean);
  if (patch.temporal !== undefined) {
    const t = normalizeTemporal(patch.temporal);
    if (t) next.temporal = t;
    else delete next.temporal;
  }
  if (patch.provenance !== undefined) {
    const p = normalizeProvenance(patch.provenance);
    if (p) next.provenance = p;
    else delete next.provenance;
  }
  if (patch.doi !== undefined) {
    const v = cleanStr(patch.doi);
    if (v) next.doi = v; else delete next.doi;
  }
  if (patch.venue !== undefined) {
    const v = cleanStr(patch.venue);
    if (v) next.venue = v; else delete next.venue;
  }
  if (patch.year !== undefined) {
    if (typeof patch.year === 'number') next.year = patch.year; else delete next.year;
  }
  if (patch.arxivId !== undefined) {
    const v = cleanStr(patch.arxivId);
    if (v) next.arxivId = v; else delete next.arxivId;
  }
  if (patch.url !== undefined) {
    const v = cleanStr(patch.url);
    if (v) next.url = v; else delete next.url;
  }
  if (patch.abstract !== undefined) next.abstract = patch.abstract;
  if (patch.summary !== undefined) next.summary = patch.summary;
  if (patch.language !== undefined) {
    const v = cleanStr(patch.language);
    if (v) next.language = v; else delete next.language;
  }
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.importance !== undefined) next.importance = patch.importance;
  if (patch.status !== undefined) {
    const s = pickEnum(SOURCE_STATUSES, patch.status);
    if (s) next.status = s;
  }
  if (patch.evidenceGrade !== undefined) {
    const g = pickEnum(EVIDENCE_GRADES, patch.evidenceGrade);
    if (g) next.evidenceGrade = g; else delete next.evidenceGrade;
  }
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.filePath !== undefined) {
    const v = cleanStr(patch.filePath);
    if (v) next.filePath = v; else delete next.filePath;
  }
  if (patch.collectionIds !== undefined) {
    const ids = cleanTags(patch.collectionIds);
    if (ids.length === 0) delete next.collectionIds;
    else next.collectionIds = ids;
  }
  if (!next.title) throw new Error('史料标题不能为空');
  return next;
}

/**
 * 史料去重：DOI → 馆藏号（repository+callNumber）→ 标题（归一化）。
 * 一手史料多无 DOI，馆藏号是更强的唯一键；都没有时退化为标题匹配。
 */
export function findDuplicateSource(
  sources: Iterable<Source>,
  patch: { title?: string; doi?: string; provenance?: Provenance },
): Source | undefined {
  const doi = patch.doi?.trim().toLowerCase();
  const call = patch.provenance?.callNumber?.trim().toLowerCase();
  const repo = patch.provenance?.repository?.trim().toLowerCase();
  const titleKey = patch.title?.trim().toLowerCase().replace(/\s+/g, '');
  for (const s of sources) {
    if (doi && s.doi && s.doi.toLowerCase() === doi) return s;
    if (call && s.provenance?.callNumber) {
      const sameCall = s.provenance.callNumber.trim().toLowerCase() === call;
      const sameRepo = !repo || !s.provenance.repository || s.provenance.repository.trim().toLowerCase() === repo;
      if (sameCall && sameRepo) return s;
    }
    if (titleKey && s.title.trim().toLowerCase().replace(/\s+/g, '') === titleKey) return s;
  }
  return undefined;
}

/* ==========================================================================
 * 访谈
 * ========================================================================== */

export interface InterviewPatch {
  sourceId?: string;
  interviewee?: Partial<Interviewee>;
  interviewers?: Interviewer[];
  interviewYear?: number;
  interviewDate?: string;
  location?: string;
  recording?: Interview['recording'];
  audioPath?: string;
  durationSeconds?: number;
  questionOutline?: string;
  backgroundNotes?: string;
  publicationNote?: string;
}

function normalizeInterviewee(v: unknown): Interviewee {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const name = cleanStr(o.name);
  if (!name) throw new Error('受访者姓名不能为空');
  const out: Interviewee = {
    name,
    roles: cleanTags(o.roles),
    affiliations: cleanTags(o.affiliations),
    fields: cleanTags(o.fields),
  };
  if (typeof o.birthYear === 'number' && Number.isFinite(o.birthYear)) out.birthYear = Math.trunc(o.birthYear);
  if (typeof o.deathYear === 'number' && Number.isFinite(o.deathYear)) out.deathYear = Math.trunc(o.deathYear);
  const bio = cleanStr(o.bio);
  if (bio) out.bio = bio;
  return out;
}

function normalizeInterviewers(v: unknown): Interviewer[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const name = cleanStr(o.name);
      if (!name) return undefined;
      const aff = cleanStr(o.affiliation);
      return aff ? { name, affiliation: aff } : { name };
    })
    .filter((x): x is Interviewer => !!x);
}

function normalizeRecording(v: unknown): Interview['recording'] | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: NonNullable<Interview['recording']> = {};
  for (const k of ['originalMedium', 'digitalFormat', 'sampleRate', 'qualityNote'] as const) {
    const s = cleanStr(o[k]);
    if (s) out[k] = s;
  }
  if (typeof o.recordedYear === 'number' && Number.isFinite(o.recordedYear)) out.recordedYear = Math.trunc(o.recordedYear);
  if (typeof o.durationSeconds === 'number' && Number.isFinite(o.durationSeconds)) out.durationSeconds = Math.trunc(o.durationSeconds);
  return Object.keys(out).length ? out : undefined;
}

export function createInterview(input: InterviewPatch, now = Date.now()): Interview {
  const sourceId = cleanStr(input.sourceId);
  if (!sourceId) throw new Error('访谈必须关联一条史料（sourceId）');
  const iv: Interview = {
    id: newInterviewId(),
    sourceId,
    interviewee: normalizeInterviewee(input.interviewee),
    interviewers: normalizeInterviewers(input.interviewers),
    createdAt: now,
    updatedAt: now,
  };
  if (typeof input.interviewYear === 'number') iv.interviewYear = input.interviewYear;
  const date = cleanStr(input.interviewDate);
  if (date) iv.interviewDate = date;
  const loc = cleanStr(input.location);
  if (loc) iv.location = loc;
  const rec = normalizeRecording(input.recording);
  if (rec) iv.recording = rec;
  const audio = cleanStr(input.audioPath);
  if (audio) iv.audioPath = audio;
  if (typeof input.durationSeconds === 'number') iv.durationSeconds = input.durationSeconds;
  if (input.questionOutline !== undefined) iv.questionOutline = input.questionOutline;
  if (input.backgroundNotes !== undefined) iv.backgroundNotes = input.backgroundNotes;
  if (input.publicationNote !== undefined) iv.publicationNote = input.publicationNote;
  return iv;
}

export function applyInterviewPatch(existing: Interview, patch: InterviewPatch, now = Date.now()): Interview {
  const next: Interview = { ...existing, updatedAt: now };
  if (patch.sourceId !== undefined) {
    const s = cleanStr(patch.sourceId);
    if (s) next.sourceId = s;
  }
  if (patch.interviewee !== undefined) {
    // 部分更新：未提交的字段保持原值（受访者档案是逐次补全的）
    next.interviewee = normalizeInterviewee({ ...existing.interviewee, ...patch.interviewee });
  }
  if (patch.interviewers !== undefined) next.interviewers = normalizeInterviewers(patch.interviewers);
  if (patch.interviewYear !== undefined) {
    if (typeof patch.interviewYear === 'number') next.interviewYear = patch.interviewYear;
    else delete next.interviewYear;
  }
  if (patch.interviewDate !== undefined) {
    const v = cleanStr(patch.interviewDate);
    if (v) next.interviewDate = v; else delete next.interviewDate;
  }
  if (patch.location !== undefined) {
    const v = cleanStr(patch.location);
    if (v) next.location = v; else delete next.location;
  }
  if (patch.recording !== undefined) {
    const r = normalizeRecording(patch.recording);
    if (r) next.recording = r; else delete next.recording;
  }
  if (patch.audioPath !== undefined) {
    const v = cleanStr(patch.audioPath);
    if (v) next.audioPath = v; else delete next.audioPath;
  }
  if (patch.durationSeconds !== undefined) {
    if (typeof patch.durationSeconds === 'number') next.durationSeconds = patch.durationSeconds;
    else delete next.durationSeconds;
  }
  if (patch.questionOutline !== undefined) next.questionOutline = patch.questionOutline;
  if (patch.backgroundNotes !== undefined) next.backgroundNotes = patch.backgroundNotes;
  if (patch.publicationNote !== undefined) next.publicationNote = patch.publicationNote;
  return next;
}

/* ==========================================================================
 * 逐字稿
 * ========================================================================== */

export interface SegmentInput {
  start: number;
  end: number;
  speaker?: SpeakerRole;
  speakerLabel?: string;
  text: string;
  rawText?: string;
  status?: SegmentStatus;
  confidence?: number;
  note?: string;
  entityIds?: string[];
}

/** 归一化一批分段输入：校验时间区间、枚举回落、id 生成、按开始时间排序。 */
export function normalizeSegments(input: unknown, startIndex = 0): Segment[] {
  if (!Array.isArray(input)) return [];
  const out: Segment[] = [];
  input.forEach((raw, i) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const start = typeof o.start === 'number' && Number.isFinite(o.start) ? Math.max(0, o.start) : 0;
    const end = typeof o.end === 'number' && Number.isFinite(o.end) ? Math.max(start, o.end) : start;
    const text = typeof o.text === 'string' ? o.text : '';
    // 允许空文本段（静音/听不清），但不允许既无文本又无备注的空壳
    const note = cleanStr(o.note);
    if (!text.trim() && !note) return;
    const seg: Segment = {
      id: newSegmentId(startIndex + i),
      start,
      end,
      speaker: pickEnum(SPEAKER_ROLES, o.speaker, 'unknown')!,
      text,
      status: pickEnum(SEGMENT_STATUSES, o.status, 'raw')!,
    };
    const label = cleanStr(o.speakerLabel);
    if (label) seg.speakerLabel = label;
    const rawText = typeof o.rawText === 'string' && o.rawText.trim() ? o.rawText : undefined;
    if (rawText) seg.rawText = rawText;
    if (typeof o.confidence === 'number' && Number.isFinite(o.confidence)) {
      seg.confidence = Math.min(1, Math.max(0, o.confidence));
    }
    if (note) seg.note = note;
    const ents = cleanTags(o.entityIds);
    if (ents.length) seg.entityIds = ents;
    out.push(seg);
  });
  return out.sort((a, b) => a.start - b.start);
}

export function createTranscript(
  input: { interviewId: string; sourceId: string; language?: string; segments?: unknown },
  now = Date.now(),
): Transcript {
  const interviewId = cleanStr(input.interviewId);
  const sourceId = cleanStr(input.sourceId);
  if (!interviewId) throw new Error('逐字稿必须关联访谈（interviewId）');
  if (!sourceId) throw new Error('逐字稿必须关联史料（sourceId）');
  const t: Transcript = {
    id: newTranscriptId(),
    interviewId,
    sourceId,
    segments: normalizeSegments(input.segments),
    createdAt: now,
    updatedAt: now,
  };
  const lang = cleanStr(input.language);
  if (lang) t.language = lang;
  return t;
}

/** 追加分段（续传/分批转录场景），自动接续已有 id 序号。 */
export function appendSegments(existing: Transcript, input: unknown, now = Date.now()): Transcript {
  const added = normalizeSegments(input, existing.segments.length);
  const segments = [...existing.segments, ...added].sort((a, b) => a.start - b.start);
  return { ...existing, segments, updatedAt: now };
}

/** 更新既有分段的校对结果（AI 修正 / 人工听校）。 */
export function applySegmentPatch(
  existing: Transcript,
  segmentId: string,
  patch: { text?: string; status?: SegmentStatus; confidence?: number; note?: string; speaker?: SpeakerRole; speakerLabel?: string; entityIds?: string[] },
  now = Date.now(),
): Transcript {
  const idx = existing.segments.findIndex((s) => s.id === segmentId);
  if (idx < 0) throw new Error(`逐字稿分段不存在: ${segmentId}`);
  const cur = existing.segments[idx];
  const next: Segment = { ...cur };
  if (patch.text !== undefined) {
    // 首次修改时把当前文本留作 rawText，保住"机器转录 vs 人工修正"的对照
    if (!next.rawText && patch.text !== cur.text) next.rawText = cur.text;
    next.text = patch.text;
  }
  if (patch.status !== undefined) {
    const s = pickEnum(SEGMENT_STATUSES, patch.status);
    if (s) next.status = s;
  }
  if (patch.confidence !== undefined) {
    if (typeof patch.confidence === 'number') next.confidence = Math.min(1, Math.max(0, patch.confidence));
    else delete next.confidence;
  }
  if (patch.note !== undefined) {
    const v = cleanStr(patch.note);
    if (v) next.note = v; else delete next.note;
  }
  if (patch.speaker !== undefined) {
    const s = pickEnum(SPEAKER_ROLES, patch.speaker);
    if (s) next.speaker = s;
  }
  if (patch.speakerLabel !== undefined) {
    const v = cleanStr(patch.speakerLabel);
    if (v) next.speakerLabel = v; else delete next.speakerLabel;
  }
  if (patch.entityIds !== undefined) {
    const ids = cleanTags(patch.entityIds);
    if (ids.length) next.entityIds = ids; else delete next.entityIds;
  }
  const segments = [...existing.segments];
  segments[idx] = next;
  return { ...existing, segments, updatedAt: now };
}

/**
 * 用术语表批量修正分段文本（确定性替换，非 AI）。
 * 返回修改计数，便于报告"本次修正了 N 处"。
 */
export function applyGlossary(transcript: Transcript, glossary: { term: string; variants?: string[] }[], now = Date.now()): { transcript: Transcript; replacements: number } {
  if (!glossary.length) return { transcript, replacements: 0 };
  let total = 0;
  const segments = transcript.segments.map((seg) => {
    let text = seg.text;
    for (const g of glossary) {
      for (const v of g.variants ?? []) {
        const variant = v.trim();
        if (!variant || variant === g.term) continue;
        if (!text.includes(variant)) continue;
        const before = text;
        text = text.split(variant).join(g.term);
        if (text !== before) total++;
      }
    }
    if (text === seg.text) return seg;
    // 保留原始文本作为对照，并把状态推进到 ai-corrected（术语表修正是确定性规则，不是人工听校）
    const next: Segment = { ...seg, text };
    if (!next.rawText) next.rawText = seg.text;
    if (next.status === 'raw') next.status = 'ai-corrected';
    return next;
  });
  return { transcript: { ...transcript, segments, updatedAt: now }, replacements: total };
}

/* ==========================================================================
 * 考据卡
 * ========================================================================== */

export interface CardPatch {
  title?: string;
  kind?: CardKind;
  content?: string;
  sourceId?: string;
  interviewId?: string;
  citation?: string;
  quote?: string;
  argumentRole?: string;
  counterEvidence?: string;
  tags?: string[];
  importance?: number;
  status?: CardStatus;
  notes?: string;
  relatedCardIds?: string[];
}

export function createCard(input: CardPatch, now = Date.now()): EvidenceCard {
  const title = (input.title ?? '').trim();
  const content = (input.content ?? '').trim();
  if (!title) throw new Error('卡片标题不能为空');
  if (!content) throw new Error('卡片内容不能为空');
  const card: EvidenceCard = {
    id: newCardId(),
    title,
    kind: pickEnum(CARD_KINDS, input.kind, 'other')!,
    content,
    tags: cleanTags(input.tags),
    importance: input.importance ?? 3,
    status: pickEnum(CARD_STATUSES, input.status, 'draft')!,
    createdAt: now,
    updatedAt: now,
  };
  const sid = cleanStr(input.sourceId);
  if (sid) card.sourceId = sid;
  const iid = cleanStr(input.interviewId);
  if (iid) card.interviewId = iid;
  const cit = cleanStr(input.citation);
  if (cit) card.citation = cit;
  const quote = cleanStr(input.quote);
  if (quote) card.quote = quote;
  const role = cleanStr(input.argumentRole);
  if (role) card.argumentRole = role;
  const counter = cleanStr(input.counterEvidence);
  if (counter) card.counterEvidence = counter;
  if (input.notes !== undefined) card.notes = input.notes;
  const rel = cleanTags(input.relatedCardIds);
  if (rel.length) card.relatedCardIds = rel;
  return card;
}

export function applyCardPatch(existing: EvidenceCard, patch: CardPatch, now = Date.now()): EvidenceCard {
  const next: EvidenceCard = { ...existing, updatedAt: now };
  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.kind !== undefined) {
    const k = pickEnum(CARD_KINDS, patch.kind);
    if (k) next.kind = k;
  }
  if (patch.content !== undefined) next.content = patch.content.trim();
  if (patch.sourceId !== undefined) {
    const v = cleanStr(patch.sourceId);
    if (v) next.sourceId = v; else delete next.sourceId;
  }
  if (patch.interviewId !== undefined) {
    const v = cleanStr(patch.interviewId);
    if (v) next.interviewId = v; else delete next.interviewId;
  }
  if (patch.citation !== undefined) {
    const v = cleanStr(patch.citation);
    if (v) next.citation = v; else delete next.citation;
  }
  if (patch.quote !== undefined) {
    const v = cleanStr(patch.quote);
    if (v) next.quote = v; else delete next.quote;
  }
  if (patch.argumentRole !== undefined) {
    const v = cleanStr(patch.argumentRole);
    if (v) next.argumentRole = v; else delete next.argumentRole;
  }
  if (patch.counterEvidence !== undefined) {
    const v = cleanStr(patch.counterEvidence);
    if (v) next.counterEvidence = v; else delete next.counterEvidence;
  }
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.importance !== undefined) next.importance = patch.importance;
  if (patch.status !== undefined) {
    const s = pickEnum(CARD_STATUSES, patch.status);
    if (s) next.status = s;
  }
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.relatedCardIds !== undefined) {
    const ids = cleanTags(patch.relatedCardIds);
    if (ids.length === 0) delete next.relatedCardIds;
    else next.relatedCardIds = ids;
  }
  if (!next.title) throw new Error('卡片标题不能为空');
  if (!next.content) throw new Error('卡片内容不能为空');
  return next;
}

/* ==========================================================================
 * 相似卡检测（标题 token Jaccard + 同来源加分）
 * ========================================================================== */

export interface SimilarCardHit {
  id: string;
  title: string;
  score: number;
}

/** 标题分词：ASCII 词（小写）+ 中文字符 bigram（中文无空格，bigram 是最小可用语义单元）。 */
function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  const ascii = title.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
  for (const w of ascii) tokens.add(w);
  const cjk = title.match(/[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk[i] + cjk[i + 1]);
  if (cjk.length === 1) tokens.add(cjk[0]);
  return tokens;
}

/**
 * 找出与给定标题相似的现有卡片（非阻塞提醒用）。
 * score = 标题 token Jaccard + 同来源史料 0.15 加分；阈值 0.45。
 * 史学写作中重复建卡（同一段史料反复摘录）是常见问题，这个提醒直接针对它。
 */
export function findSimilarCards(
  cards: EvidenceCard[],
  title: string,
  opts?: { excludeId?: string; sourceId?: string; limit?: number },
): SimilarCardHit[] {
  const limit = opts?.limit ?? 3;
  const target = titleTokens(title);
  if (!target.size) return [];
  const out: SimilarCardHit[] = [];
  for (const c of cards) {
    if (c.id === opts?.excludeId) continue;
    const t = titleTokens(c.title);
    if (!t.size) continue;
    let inter = 0;
    for (const x of target) if (t.has(x)) inter++;
    const jaccard = inter / (target.size + t.size - inter);
    const score = jaccard + (opts?.sourceId && c.sourceId === opts.sourceId ? 0.15 : 0);
    if (score >= 0.45) out.push({ id: c.id, title: c.title, score: Math.round(score * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
