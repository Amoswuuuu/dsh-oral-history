#!/usr/bin/env node
/**
 * 载入 Computer History Museum 公开口述史目录作为示范数据集。
 *
 * 数据来源：CHM 在线馆藏目录的口述史专藏（公开可访问的元数据）。
 * 本脚本只写入**元数据**——不下载音频（CHM 音频有独立的使用条款，
 * 请遵守其条款后再自行获取）。这样既能展示工作台的建档与检索能力，
 * 又不越界转载他人素材。
 *
 * 用法：
 *   node scripts/seed-demo.mjs [targetDir] [--with-transcript]
 *
 * 默认 targetDir = $HOME/Documents/OralHistoryArchive（插件的默认档案目录）。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(await readFile(join(here, 'demo-data', 'chm-oral-histories.json'), 'utf8'));

const args = process.argv.slice(2);
const withTranscript = args.includes('--with-transcript');
const targetDir = args.find((a) => !a.startsWith('--')) ?? join(homedir(), 'Documents', 'OralHistoryArchive');

/** CHM 记录 → 一手史料。馆藏号用 CHM 目录号——这正是"馆藏号是比 DOI 更可靠的去重键"的实例。 */
function toSource(r) {
  const id = `chm-oh-${r.catalogId}`;
  return {
    id,
    tier: 'primary',
    primaryKind: 'oral-history',
    title: r.title,
    authors: r.interviewee ? [r.interviewee] : [],
    tags: r.tags ?? [],
    source: 'agent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provenance: {
      repository: 'Computer History Museum',
      callNumber: r.catalogId,
      medium: r.medium ?? 'Video / audio recording',
      accessNote: 'CHM 在线馆藏目录公开记录；使用音频前请查阅 CHM 的使用条款。',
    },
    ...(r.yearFrom || r.yearTo
      ? { temporal: { ...(r.yearFrom ? { eventYearFrom: r.yearFrom } : {}), ...(r.yearTo ? { eventYearTo: r.yearTo } : {}) } }
      : {}),
    ...(r.birthYear ? {} : {}),
    abstract: r.description,
    summary: r.summary,
    language: 'en',
    importance: r.importance ?? 4,
    status: 'transcribed',
    url: `https://www.computerhistory.org/collections/catalog/${r.catalogId}/`,
    notes: '示范数据：元数据来自 CHM 公开目录，未附带音频。',
  };
}

/** 受访者档案——生卒年、机构、领域。史学惯例要求明确生卒年。 */
function toInterview(r, sourceId) {
  return {
    id: `iv-chm-${r.catalogId}`,
    sourceId,
    interviewee: {
      name: r.interviewee ?? r.title,
      ...(r.birthYear ? { birthYear: r.birthYear } : {}),
      ...(r.deathYear ? { deathYear: r.deathYear } : {}),
      roles: r.roles ?? [],
      affiliations: r.affiliations ?? [],
      fields: r.fields ?? [],
      ...(r.bio ? { bio: r.bio } : {}),
    },
    interviewers: (r.interviewers ?? []).map((n) => ({ name: n })),
    ...(r.interviewYear ? { interviewYear: r.interviewYear } : {}),
    ...(r.location ? { location: r.location } : {}),
    recording: {
      originalMedium: r.medium ?? 'Video',
      ...(r.durationSeconds ? { durationSeconds: r.durationSeconds } : {}),
    },
    ...(r.backgroundNotes ? { backgroundNotes: r.backgroundNotes } : {}),
    publicationNote: 'Computer History Museum 口述史专藏（公开目录记录）。',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * 示范逐字稿：用目录摘要切分成带时间戳的分段，
 * 并刻意保留一段 inaudible（真实转录里必然出现的情况）。
 * 状态一律 raw/ai-corrected——没有人工听校就不能标 human-verified。
 */
function toTranscript(r, interviewId, sourceId) {
  const text = (r.description ?? '').replace(/\s+/g, ' ').trim();
  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).trim().length > 180 && cur) { chunks.push(cur.trim()); cur = s; }
    else cur = (cur + ' ' + s).trim();
  }
  if (cur.trim()) chunks.push(cur.trim());

  let t = 0;
  const segments = [];
  segments.push({ start: 0, end: 12, speaker: 'interviewer', text: `This is an oral history interview with ${r.interviewee ?? r.title}.`, status: 'ai-corrected', confidence: 0.93 });
  t = 12;
  for (const c of chunks.slice(0, 14)) {
    const dur = Math.max(10, Math.round(c.length / 13));
    segments.push({ start: t, end: t + dur, speaker: 'interviewee', text: c, status: 'raw' });
    t += dur;
  }
  // 真实录音里必然有听不清的段落——留一段，证明工具不会假装听懂了
  segments.push({ start: t, end: t + 8, speaker: 'interviewee', text: '', note: 'Tape dropout / unintelligible passage — needs review against the recording.', status: 'inaudible' });

  return {
    id: `tr-chm-${r.catalogId}`,
    interviewId,
    sourceId,
    language: 'en',
    segments,
    glossary: r.glossary ?? [],
    verifiedRatio: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const writeJson = async (dir, name, obj) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), JSON.stringify(obj, null, 2), 'utf8');
};

let n = 0;
for (const r of rows) {
  const src = toSource(r);
  await writeJson(join(targetDir, 'sources'), src.id, src);
  if (r.interviewee) {
    const iv = toInterview(r, src.id);
    await writeJson(join(targetDir, 'interviews'), iv.id, iv);
    if (withTranscript) {
      const tr = toTranscript(r, iv.id, src.id);
      await writeJson(join(targetDir, 'transcripts'), tr.id, tr);
    }
  }
  n++;
}

for (const d of ['sources', 'interviews', 'transcripts', 'cards', 'attachments']) {
  await mkdir(join(targetDir, d), { recursive: true });
}
if (!existsSync(join(targetDir, 'graph.json'))) {
  await writeFile(join(targetDir, 'graph.json'), JSON.stringify({ nodes: [], edges: [] }, null, 2), 'utf8');
}

console.log(`✅ 已写入 ${n} 条 CHM 口述史记录到 ${targetDir}`);
console.log('   重启 DSH Web 后，在口述史工作台点「同步史料与卡片」把节点补进图谱。');
if (!withTranscript) console.log('   加 --with-transcript 可同时生成示范逐字稿。');
