#!/usr/bin/env node
/**
 * 转录准确率评估：本地跑 Whisper，与金标准逐字稿比对，输出字错率（CER）。
 *
 * 用途有两层：
 *   1) 现在——用公开中文语料（AISHELL-1）产出可复核的基线数字；
 *   2) 将来——拿到真实访谈 + 精校稿后，换成自己的数据，同一套指标即可对比。
 *
 * 之所以自己写而不是调现成库：这台机器没有 pip，装不了 jiwer 之类；
 * 而 CER 的编辑距离实现很短，与其引入依赖不如直接写清楚算法，
 * 让评审者能一眼看懂指标是怎么算出来的。
 *
 * 用法：
 *   node scripts/eval-asr.mjs --truth <金标准文件> --hyp <识别结果目录> [--json]
 *
 * 金标准格式（每行一条）：
 *   <音频id> 参考文本
 *   例：BAC009S0002W0122 而 对 楼市 成交 抑制 作用 最 大 的 限 购
 *   （文本中的空格会被忽略，便于与分词后的语料对接）
 *
 * 识别结果目录：每个音频一个 <音频id>.txt，内容为该条的识别文本。
 *
 * 输出：总体 CER、准确率、逐条分布、最差样例。
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
const truthPath = arg('--truth');
const hypDir = arg('--hyp');
const asJson = argv.includes('--json');

if (!truthPath || !hypDir) {
  console.error('用法: node scripts/eval-asr.mjs --truth <金标准> --hyp <识别结果目录> [--json]');
  process.exit(2);
}
if (!existsSync(truthPath)) { console.error(`金标准文件不存在: ${truthPath}`); process.exit(2); }
if (!existsSync(hypDir)) { console.error(`识别结果目录不存在: ${hypDir}`); process.exit(2); }

/* ---------- 文本归一化 ----------
 * 不做归一化的话，标点和空白会把 CER 抬高，掩盖真正的识别错误。
 * 这里只保留实义字符，并统一繁简、全半角数字。
 */

/** 繁→简：只覆盖常见字。真实项目应换完整的 OpenCC 映射表。 */
const T2S = {
  這:'这',個:'个',來:'来',時:'时',們:'们',為:'为',會:'会',後:'后',車:'车',間:'间',
  開:'开',關:'关',區:'区',國:'国',學:'学',產:'产',業:'业',麼:'么',樣:'样',將:'将',
  實:'实',現:'现',發:'发',對:'对',應:'应',內:'内',兩:'两',從:'从',無:'无',點:'点',
  還:'还',經:'经',濟:'济',廣:'广',東:'东',門:'门',見:'见',長:'长',問:'问',題:'题',
  報:'报',導:'导',體:'体',數:'数',據:'据',縣:'县',鄉:'乡',親:'亲',愛:'爱',樂:'乐',
  語:'语',書:'书',讀:'读',寫:'写',認:'认',識:'识',讓:'让',該:'该',設:'设',計:'计',
  論:'论',議:'议',員:'员',團:'团',隊:'队',戰:'战',爭:'争',軍:'军',農:'农',輕:'轻',
  馬:'马',鳥:'鸟',魚:'鱼',龍:'龙',風:'风',雲:'云',電:'电',氣:'气',機:'机',場:'场',
  價:'价',錢:'钱',銀:'银',資:'资',質:'质',則:'则',規:'规',範:'范',標:'标',準:'准',
  確:'确',條:'条',約:'约',級:'级',組:'组',織:'织',統:'统',結:'结',構:'构',權:'权',
  義:'义',務:'务',責:'责',華:'华',僑:'侨',亞:'亚',歐:'欧',韓:'韩',臺:'台',灣:'湾',
  綜:'综',詢:'询',監:'监',認:'认',雄:'雄',偉:'伟',變:'变',購:'购',線:'线',貨:'货',
  緊:'紧',隨:'随',後:'后',極:'极',強:'强',財:'财',貸:'贷',銀:'银',執:'执',稱:'称',
  產:'产',復:'复',甦:'苏',處:'处',階:'阶',段:'段',繼:'继',續:'续',積:'积',極:'极',
};

function normalize(s) {
  let t = String(s ?? '');
  // 去空白
  t = t.replace(/\s+/g, '');
  // 去标点（中英文）
  t = t.replace(/[，。、,.;:!?！？；：""''“”‘’（）()《》〈〉【】\[\]\-—…·~～]/g, '');
  // 繁→简
  t = t.replace(/[\u4e00-\u9fff]/g, (c) => T2S[c] ?? c);
  return t;
}

/* ---------- 编辑距离（Levenshtein）----------
 * CER = 编辑距离 / 参考长度。
 * 标准实现，O(len(ref) * len(hyp))；句子级别足够快。
 */
function editDistance(a, b) {
  const r = [...a], h = [...b];
  // 滚动数组，省内存
  let prev = new Array(h.length + 1);
  let cur = new Array(h.length + 1);
  for (let j = 0; j <= h.length; j++) prev[j] = j;
  for (let i = 1; i <= r.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[h.length];
}

/* ---------- 读金标准 ---------- */
const truth = new Map();
for (const line of (await readFile(truthPath, 'utf8')).split('\n')) {
  const t = line.trim();
  if (!t) continue;
  const sp = t.indexOf(' ');
  if (sp === -1) continue;
  truth.set(t.slice(0, sp), t.slice(sp + 1));
}

/* ---------- 读识别结果并打分 ---------- */
const rows = [];
let missing = 0;
for (const [id, refRaw] of truth) {
  const p = join(hypDir, `${id}.txt`);
  if (!existsSync(p)) { missing++; continue; }
  const hypRaw = (await readFile(p, 'utf8')).trim();
  const ref = normalize(refRaw);
  const hyp = normalize(hypRaw);
  if (!ref) continue;
  const dist = editDistance(ref, hyp);
  rows.push({ id, ref, hyp, dist, len: ref.length, cer: dist / ref.length });
}

if (rows.length === 0) {
  console.error('没有可评估的样本（检查文件名是否与金标准 id 对应）');
  process.exit(1);
}

/* ---------- 汇总 ---------- */
const totalRef = rows.reduce((s, r) => s + r.len, 0);
const totalDist = rows.reduce((s, r) => s + r.dist, 0);
const cer = totalDist / totalRef;
const sorted = [...rows].sort((a, b) => a.cer - b.cer);
const median = sorted[Math.floor(sorted.length / 2)].cer;

const bucket = (lo, hi) => rows.filter((r) => r.cer >= lo && r.cer < hi).length;
const summary = {
  samples: rows.length,
  missing,
  referenceChars: totalRef,
  edits: totalDist,
  cer,
  accuracy: 1 - cer,
  perSentence: { best: sorted[0].cer, median, worst: sorted[sorted.length - 1].cer },
  buckets: {
    perfect: rows.filter((r) => r.cer === 0).length,
    minor: bucket(0, 0.2),
    moderate: bucket(0.2, 0.4),
    severe: rows.filter((r) => r.cer >= 0.4).length,
  },
};

if (asJson) {
  console.log(JSON.stringify({ summary, rows }, null, 2));
} else {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  console.log('══════ 转录准确率评估 ══════');
  console.log(`  样本数        ${summary.samples}${missing ? `（另有 ${missing} 条缺识别结果）` : ''}`);
  console.log(`  参考总字数    ${summary.referenceChars}`);
  console.log(`  编辑距离合计  ${summary.edits}`);
  console.log('');
  console.log(`  字错率 CER    ${pct(summary.cer)}`);
  console.log(`  字准确率      ${pct(summary.accuracy)}`);
  console.log('');
  console.log(`  逐条 CER      最好 ${pct(summary.perSentence.best)} / 中位 ${pct(summary.perSentence.median)} / 最差 ${pct(summary.perSentence.worst)}`);
  console.log('');
  console.log('  错误分布：');
  console.log(`    完全正确       ${summary.buckets.perfect} 条`);
  console.log(`    轻微 (<20%)    ${summary.buckets.minor} 条`);
  console.log(`    中等 (20-40%)  ${summary.buckets.moderate} 条`);
  console.log(`    严重 (>=40%)   ${summary.buckets.severe} 条`);
  console.log('');
  console.log('  ── 最接近的 3 条 ──');
  for (const r of sorted.slice(0, 3)) {
    console.log(`    [${pct(r.cer)}] ${r.id}`);
    console.log(`      真值: ${r.ref}`);
    console.log(`      机器: ${r.hyp}`);
  }
  console.log('');
  console.log('  ── 最差的 3 条 ──');
  for (const r of sorted.slice(-3).reverse()) {
    console.log(`    [${pct(r.cer)}] ${r.id}`);
    console.log(`      真值: ${r.ref}`);
    console.log(`      机器: ${r.hyp}`);
  }
}
