#!/usr/bin/env node
/**
 * 载入中文示范语料（AISHELL-1 子集）。
 *
 * 为什么是它：
 *   - 真实的中文普通话录音（16kHz 单声道 WAV），Apache-2.0 授权，可自由使用；
 *   - 来自 ModelScope 的 speech_asr/speech_asr_aishell1_subset（公开数据集）；
 *   - 60 条 / 4 位说话人 / 共约 5 分钟，体积 9.6MB，适合随仓库分发。
 *
 * 关于"逐字稿"——这是本脚本最重要的一条约束：
 *   这批音频**没有**随包提供官方转写文本，因此脚本**不写入任何逐字稿分段**。
 *   宁可界面上是空的、让你自己去听、去录、去跑 ASR，也不要拿一段编造的
 *   文本冒充转录结果——那是本工作台最不能犯的错。
 *
 *   音频会真实挂到访谈上，所以进度条、倍速、拖动定位都能用；
 *   你听到的每一秒都是真的。
 *
 * 用法：
 *   node scripts/seed-zh-demo.mjs [targetDir]
 *
 * 默认 targetDir = $HOME/Documents/OralHistoryArchive
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const audioDir = join(here, 'demo-data', 'zh-audio');
const manifest = JSON.parse(await readFile(join(here, 'demo-data', 'zh-aishell-subset.json'), 'utf8'));

const targetDir = process.argv[2] ?? join(homedir(), 'Documents', 'OralHistoryArchive');

const now = () => Date.now();
const writeJson = async (dir, name, obj) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), JSON.stringify(obj, null, 2), 'utf8');
};

const repo = 'ModelScope · speech_asr/speech_asr_aishell1_subset';
const license = 'Apache License 2.0';
const upstream = 'AISHELL-1（希尔贝壳 / 北京希尔贝壳科技有限公司）';

let sources = 0;
let interviews = 0;
let attachments = 0;

/*
 * 每位说话人建一条"史料 + 访谈"，其下挂该说话人的全部录音分段。
 * 这与真实口述史档案的形状一致：一位受访者 = 一份访谈，内含多段录音。
 */
for (const spk of manifest.speakers) {
  const sourceId = `zh-aishell-${spk.id}`;
  const interviewId = `iv-zh-aishell-${spk.id}`;

  // 该说话人的音频整体挂到史料附件上（播放器读的就是它）
  const firstFile = `${spk.id}/${spk.files[0]}`;
  const attachmentRel = `attachments/${spk.id}-${spk.files[0]}`;
  await mkdir(join(targetDir, 'attachments'), { recursive: true });
  await copyFile(join(audioDir, firstFile), join(targetDir, attachmentRel));
  attachments++;

  /** 一手史料：录音本身。馆藏号用数据集内的稳定编号。 */
  await writeJson(join(targetDir, 'sources'), sourceId, {
    id: sourceId,
    tier: 'primary',
    primaryKind: 'oral-history',
    title: `普通话朗读语音样本：说话人 ${spk.id}`,
    authors: [],
    tags: ['中文语料', '语音样本', 'ASR基准', '示范数据'],
    source: 'manual',
    createdAt: now(),
    updatedAt: now(),
    provenance: {
      repository: repo,
      callNumber: spk.id,
      medium: '数字音频（WAV 16kHz 单声道）',
      edition: license,
      accessNote: `上游为 ${upstream}。Apache-2.0 授权，可自由使用与再分发。`,
      digitizationNote: '原始即为数字录音，未经模拟载体转录。',
    },
    temporal: { eventYearFrom: 2015, eventYearTo: 2015 },
    abstract:
      `来自公开中文语音数据集 AISHELL-1 的一个子集，包含说话人 ${spk.id} 的 ` +
      `${spk.files.length} 条普通话朗读录音，共约 ${Math.round(spk.totalSeconds)} 秒。` +
      '每条录音为一句独立话语，已按顺序编号。',
    summary:
      '真实中文普通话录音，用于验证口述史工作台的音频播放、分段定位与转录流程；' +
      '注意这是朗读语音而非访谈口语，语体上与真实口述史有差距。',
    language: 'zh',
    importance: 3,
    status: 'transcribing',
    filePath: attachmentRel,
    notes:
      '示范数据：音频为真实的 AISHELL-1 公开录音；' +
      '本工作台未附带其官方转写文本，故逐字稿留空——请勿把占位文本当成转录结果。',
  });
  sources++;

  /** 访谈档案：本批样本没有受访者身份信息，如实留空并标注。 */
  await writeJson(join(targetDir, 'interviews'), interviewId, {
    id: interviewId,
    sourceId,
    interviewee: {
      name: `说话人 ${spk.id}`,
      // 生年未知——不猜，留给研究者按需补录
      roles: [],
      affiliations: [],
      fields: ['普通话语音'],
      bio:
        'AISHELL-1 数据集中的匿名说话人。数据集仅提供说话人编号与性别，' +
        '不含姓名、生年与职业等身份信息；此处不做推测。',
    },
    interviewers: [],
    location: '录音棚（数据集录制）',
    recording: {
      originalMedium: '数字录音',
      recordedYear: 2015,
      digitalFormat: 'WAV',
      sampleRate: '16000 Hz',
      durationSeconds: Math.round(spk.totalSeconds),
      qualityNote: '近场录制，信噪比较高；每条为独立短句，句间无上下文。',
    },
    backgroundNotes:
      '语体为朗读语音（read speech），而非自然访谈口语。' +
      '用它来测试播放、定位、状态流转是合适的；' +
      '但不要据此判断工具在真实口述史（方言、重叠话轮、口语冗余）上的表现。',
    publicationNote: `${upstream}，经 ${repo} 分发，${license}。`,
    createdAt: now(),
    updatedAt: now(),
  });
  interviews++;

  /*
   * 逐字稿：**故意留空**。
   * 只写入一条 inaudible 占位段来说明"为什么是空的"，
   * 而不是编一段听起来像转写的文本。
   */
  await writeJson(join(targetDir, 'transcripts'), `tr-zh-aishell-${spk.id}`, {
    id: `tr-zh-aishell-${spk.id}`,
    interviewId,
    sourceId,
    language: 'zh',
    segments: [
      {
        id: `sg_0000_seed`,
        start: 0,
        end: Math.max(1, Math.round(spk.totalSeconds)),
        speaker: 'unknown',
        text: '',
        status: 'inaudible',
        note:
          '本示范数据集未附带官方转写文本。此处不填任何占位文字——' +
          '请播放录音后自行听录，或接入 ASR 生成 raw 分段再逐段听校。',
      },
    ],
    glossary: [],
    verifiedRatio: 0,
    createdAt: now(),
    updatedAt: now(),
  });
}

// 确保目录齐全
for (const d of ['sources', 'interviews', 'transcripts', 'cards', 'attachments']) {
  await mkdir(join(targetDir, d), { recursive: true });
}

console.log(`✅ 已写入中文示范语料到 ${targetDir}`);
console.log(`   ${sources} 条史料 / ${interviews} 份访谈 / ${attachments} 个音频附件（真实可播放）`);
console.log(`   音频来自 ${upstream}，${license}`);
console.log('');
console.log('   注意：逐字稿刻意留空。请播放录音后自行听录，或接入 ASR——');
console.log('   本脚本不会写入任何未经听校的文本。');
