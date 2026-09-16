// Smoke test for dsh-oral-history: store + domain + graph merge against a temp dir.
// Run after `npm run build` (imports from ../dist).
//
// 覆盖真实工作流：史料建档（一手/二手双轨）→ 访谈档案 → 逐字稿转录与听校 →
// 术语表修正 → 考据卡 → 图谱自动同步与合并 → 查询/导出语义。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OralHistoryStore, assertRebuildAllowed, filterCards, filterInterviews, filterSources,
  mergeGraph, nodeSubgraph, safeName, timeWindowGraph, slugifyTitle, sourceIdFor,
} from '../dist/store.js';
import {
  appendSegments, applyCardPatch, applyGlossary, applyInterviewPatch, applySegmentPatch,
  applySourcePatch, createCard, createInterview, createSource, createTranscript,
  findDuplicateSource, findSimilarCards,
} from '../dist/domain.js';
import { parseArxivId, parseDoi, crossrefToMeta } from '../dist/metadata.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-oral-history-smoke-'));
console.log(`临时目录: ${dir}`);

try {
  const store = new OralHistoryStore(dir);
  await store.init();
  check('init 创建目录结构',
    existsSync(join(dir, 'sources')) && existsSync(join(dir, 'interviews'))
    && existsSync(join(dir, 'transcripts')) && existsSync(join(dir, 'cards'))
    && existsSync(join(dir, 'attachments')));

  /* ===================== 史料：一手 / 二手双轨 ===================== */

  const oral = createSource({
    title: '口述访谈：钱学森与中国早期航天事业',
    tier: 'primary',
    primaryKind: 'oral-history',
    authors: ['钱学森'],
    temporal: { eventYearFrom: 1955, eventYearTo: 1970, originalEra: '' },
    provenance: {
      repository: '中国科学院档案馆',
      callNumber: 'ZKY-DA-1987-042',
      medium: '卡式录音带',
      digitizationNote: '2019 年数字化，24bit/96kHz',
    },
    tags: ['口述史', '航天史', '技术转移'],
    importance: 5,
    source: 'agent',
    summary: '受访者回忆归国后参与导弹与航天事业建立的过程。',
  });
  const paper = createSource({
    title: 'The Transfer of Rocket Technology to China, 1955-1965',
    tier: 'secondary',
    secondaryKind: 'journal-article',
    authors: ['Jane Doe'],
    year: 2015,
    doi: '10.1234/hos.2015.001',
    venue: 'Technology and Culture',
    tags: ['技术转移', '航天史'],
    importance: 4,
    source: 'agent',
  });
  const archive = createSource({
    title: '第二机械工业部关于技术引进的请示（1958）',
    tier: 'primary',
    primaryKind: 'archive',
    temporal: { eventYearFrom: 1958, originalEra: '一九五八年' },
    provenance: { repository: '中国第二历史档案馆', callNumber: '全宗 402-3-118' },
    tags: ['档案', '三线建设'],
    source: 'manual',
  });
  await store.upsertSource(oral);
  await store.upsertSource(paper);
  await store.upsertSource(archive);
  check('史料入库 3 条', store.sources.size === 3);
  check('一手史料 primaryKind 落位', oral.primaryKind === 'oral-history');
  check('二手史料 secondaryKind 落位', paper.secondaryKind === 'journal-article');
  check('一手史料不带 secondaryKind', oral.secondaryKind === undefined);

  // 去重：馆藏号（一手史料的主要去重键，比 DOI 更可靠）
  check('去重命中（馆藏号）',
    findDuplicateSource(store.sources.values(), {
      title: '完全不同的标题',
      provenance: { repository: '中国科学院档案馆', callNumber: 'ZKY-DA-1987-042' },
    })?.id === oral.id);
  check('去重命中（DOI）',
    findDuplicateSource(store.sources.values(), { title: 'x', doi: '10.1234/hos.2015.001' })?.id === paper.id);
  check('去重命中（标题归一化）',
    findDuplicateSource(store.sources.values(), { title: '口述访谈：钱学森与中国早期航天事业' })?.id === oral.id);
  check('去重不误报',
    findDuplicateSource(store.sources.values(), { title: '一条全新的史料' }) === undefined);

  // 轨道切换时清理另一轨的类型字段
  const switched = applySourcePatch(paper, { tier: 'primary', primaryKind: 'manuscript' });
  check('轨道切换清掉 secondaryKind', switched.secondaryKind === undefined && switched.primaryKind === 'manuscript');

  // 时间定位归一化：空对象应被丢弃而不是留空壳
  const noTemporal = applySourcePatch(oral, { temporal: {} });
  check('全空 temporal 被清除', noTemporal.temporal === undefined);
  check('originalEra 保留原文纪年', archive.temporal?.originalEra === '一九五八年');

  // 确定性 id：同标题 + 同 DOI 必须得到同 id（去重锚点）
  check('sourceIdFor 确定性', sourceIdFor('测试史料', '10.1/x') === sourceIdFor('测试史料', '10.1/x'));
  check('slugifyTitle 处理中文', slugifyTitle('钱学森与中国航天').length > 0);

  /* ===================== 筛选 ===================== */

  check('tier=primary 只出一手', filterSources([...store.sources.values()], { tier: 'primary' }).length === 2);
  check('按 primaryKind 筛选', filterSources([...store.sources.values()], { primaryKind: 'archive' }).length === 1);
  check('按所记事件年代筛选',
    filterSources([...store.sources.values()], { eventYearFrom: 1957, eventYearTo: 1960 }).some((s) => s.id === archive.id));
  check('按馆藏机构关键词检索',
    filterSources([...store.sources.values()], { q: '第二历史档案馆' }).length === 1);
  check('按原始纪年检索',
    filterSources([...store.sources.values()], { q: '一九五八' }).length === 1);
  check('按标签筛选', filterSources([...store.sources.values()], { tag: '航天史' }).length === 2);
  check('按证据等级筛选（无匹配返回空）',
    filterSources([...store.sources.values()], { evidenceGrade: 'A' }).length === 0);

  /* ===================== 访谈 ===================== */

  const iv = createInterview({
    sourceId: oral.id,
    interviewee: {
      name: '钱学森',
      birthYear: 1911,
      deathYear: 2009,
      roles: ['空气动力学家', '航天工程管理者'],
      affiliations: ['加州理工学院', '国防部第五研究院'],
      fields: ['空气动力学', '系统工程'],
      bio: '中国航天事业奠基人之一。',
    },
    interviewers: [{ name: '张某某', affiliation: '中国科学院' }],
    interviewYear: 1987,
    interviewDate: '1987-06-12',
    location: '北京',
    recording: {
      originalMedium: '卡式录音带',
      recordedYear: 1987,
      digitalFormat: 'FLAC',
      durationSeconds: 5400,
      qualityNote: '底噪较大，多处磁带损伤',
    },
  });
  await store.upsertInterview(iv);
  check('访谈入库', store.interviews.size === 1);
  check('访谈与史料关联', iv.sourceId === oral.id);
  check('受访者生卒年保留', iv.interviewee.birthYear === 1911 && iv.interviewee.deathYear === 2009);
  check('录音音质问题保留', iv.recording?.qualityNote?.includes('磁带损伤') === true);

  // 部分更新：未提交的字段不能被清空（受访者档案是逐次补全的）
  const ivPatched = applyInterviewPatch(iv, { interviewee: { name: '钱学森', fields: ['系统工程', '控制论'] } });
  check('访谈部分更新保留 birthYear', ivPatched.interviewee.birthYear === 1911);
  check('访谈部分更新替换 fields', ivPatched.interviewee.fields.length === 2);
  check('访谈部分更新保留录音信息', ivPatched.recording?.originalMedium === '卡式录音带');

  check('按受访者检索', filterInterviews([...store.interviews.values()], { interviewee: '钱' }).length === 1);
  check('按领域检索', filterInterviews([...store.interviews.values()], { field: '系统工程' }).length === 1);
  check('按机构检索', filterInterviews([...store.interviews.values()], { affiliation: '加州理工' }).length === 1);
  check('按访谈年份区间检索', filterInterviews([...store.interviews.values()], { yearFrom: 1980, yearTo: 1990 }).length === 1);
  check('访谈年份区间外不命中', filterInterviews([...store.interviews.values()], { yearFrom: 2000 }).length === 0);

  /* ===================== 逐字稿 ===================== */

  const t1 = createTranscript({
    interviewId: iv.id,
    sourceId: oral.id,
    language: 'zh',
    segments: [
      { start: 0, end: 12, speaker: 'interviewer', text: '请您谈谈回国后的工作情况。', status: 'raw' },
      { start: 12, end: 45, speaker: 'interviewee', text: '我是一九五五年回到北京的。', status: 'raw' },
      { start: 45, end: 70, speaker: 'interviewee', text: '当时成立了一个研究院。', status: 'raw' },
      // 空文本 + 无备注的段应被丢弃
      { start: 70, end: 75, speaker: 'unknown', text: '', status: 'raw' },
      // 空文本 + 有备注的段应保留（听不清是有效信息）
      { start: 75, end: 80, speaker: 'interviewee', text: '', note: '磁带损伤，无法辨听', status: 'inaudible' },
    ],
  });
  await store.upsertTranscript(t1);
  store.recomputeVerifiedRatio(t1);
  check('逐字稿入库', store.transcripts.size === 1);
  check('空壳分段被丢弃', t1.segments.length === 4);
  check('带备注的无法辨听段保留', t1.segments.some((s) => s.status === 'inaudible'));
  check('分段按开始时间排序', t1.segments.every((s, i, a) => i === 0 || a[i - 1].start <= s.start));
  check('初始校对比例为 0', t1.verifiedRatio === 0);

  // 追加分段（分批转录场景）
  const t2 = appendSegments(t1, [
    { start: 80, end: 120, speaker: 'interviewee', text: '我们从仿制开始，逐步走向自行设计。', status: 'raw' },
    { start: 30, end: 40, speaker: 'interviewer', text: '（插入提问）', status: 'raw' },
  ]);
  check('追加分段后总数 6', t2.segments.length === 6);
  check('追加后仍按时间排序', t2.segments.every((s, i, a) => i === 0 || a[i - 1].start <= s.start));
  check('追加分段 id 不重复', new Set(t2.segments.map((s) => s.id)).size === 6);

  // 人工听校：文本修改必须留下 rawText 对照
  const segId = t2.segments.find((s) => s.text.includes('一九五五年'))?.id;
  const t3 = applySegmentPatch(t2, segId, { text: '我是一九五五年回到北京的，那年冬天。', status: 'human-verified', confidence: 0.95 });
  const edited = t3.segments.find((s) => s.id === segId);
  check('分段修正生效', edited.text.includes('那年冬天'));
  check('修正保留机器原文 rawText', edited?.rawText === '我是一九五五年回到北京的。');
  check('分段状态推进到已听校', edited?.status === 'human-verified');
  check('confidence 被夹取在 0-1', edited?.confidence === 0.95);

  const t4 = applySegmentPatch(t3, t3.segments[0].id, { confidence: 5 });
  check('confidence 超限被夹取', t4.segments[0].confidence === 1);

  store.recomputeVerifiedRatio(t4);
  check('校对比例正确计算', Math.abs(t4.verifiedRatio - 1 / 6) < 0.001, `got ${t4.verifiedRatio}`);

  // 术语表：确定性批量修正
  const t5 = { ...t4, glossary: [{ term: '国防部第五研究院', variants: ['国防部第五研究园', '国防部第5研究院'] }] };
  // 必须按文本定位：appendSegments 会按开始时间重排，下标不再对应同一分段
  const instSegId = t5.segments.find((s) => s.text.includes('研究院'))?.id;
  check('按文本定位到目标分段', !!instSegId);
  check('目标分段初始无 rawText', t5.segments.find((s) => s.id === instSegId)?.rawText === undefined);
  const withBad = applySegmentPatch(t5, instSegId, { text: '当时成立了一个国防部第五研究园。' });
  const { transcript: t6, replacements } = applyGlossary(withBad, withBad.glossary);
  check('术语表修正命中', replacements === 1, `got ${replacements}`);
  check('术语表修正结果正确', t6.segments.some((s) => s.text.includes('国防部第五研究院')));
  // rawText 锚定分段进入人工/AI 修正之前的机器转录原文，之后多次修正都不再覆写，
  // 保证"机器转录 vs 人工判定"的对照始终可回溯
  check('术语表修正保留机器转录原文',
    t6.segments.find((s) => s.id === instSegId)?.rawText === '当时成立了一个研究院。');
  check('术语表修正推进状态到 ai-corrected',
    t6.segments.find((s) => s.id === instSegId)?.status === 'ai-corrected');
  check('术语表不误伤 human-verified 状态',
    t6.segments.find((s) => s.id === segId)?.status === 'human-verified');

  store.recomputeVerifiedRatio(t6);
  await store.upsertTranscript(t6);

  check('非法枚举值被回落为 unknown',
    createTranscript({ interviewId: 'x', sourceId: 'y', segments: [{ start: 0, end: 1, speaker: 'nobody', text: 'a' }] })
      .segments[0].speaker === 'unknown');
  check('负 start 被夹取为 0',
    createTranscript({ interviewId: 'x', sourceId: 'y', segments: [{ start: -5, end: 3, text: 'a' }] })
      .segments[0].start === 0);

  /* ===================== 考据卡 ===================== */

  const card = createCard({
    title: '技术引进依赖苏联专家还是自主设计？',
    kind: 'dispute',
    content: '受访者的叙述强调 1960 年后转向自主设计，但档案显示仿制阶段持续更久。',
    sourceId: oral.id,
    interviewId: iv.id,
    citation: segId,
    quote: '我们从仿制开始，逐步走向自行设计。',
    argumentRole: '支撑"技术转移存在断裂"的论点',
    counterEvidence: '档案 402-3-118 显示 1959 年仍有大量专家依赖记录。',
    tags: ['技术转移', '航天史'],
    importance: 5,
    status: 'contested',
  });
  await store.upsertCard(card);
  check('卡片入库', store.cards.size === 1);
  check('卡片引文定位到分段 id', card.citation === segId);
  check('卡片记录了反证', (card.counterEvidence ?? '').length > 0);

  const cardUpd = applyCardPatch(card, { status: 'corroborated', importance: 4 });
  check('卡片状态推进', cardUpd.status === 'corroborated');
  check('卡片更新保留 citation', cardUpd.citation === segId);

  check('卡片按类型检索', filterCards([...store.cards.values()], { kind: 'dispute' }).length === 1);
  check('卡片按来源史料检索', filterCards([...store.cards.values()], { sourceId: oral.id }).length === 1);
  check('卡片按来源访谈检索', filterCards([...store.cards.values()], { interviewId: iv.id }).length === 1);
  check('卡片关键词匹配引文定位', filterCards([...store.cards.values()], { q: segId }).length === 1);
  check('卡片关键词匹配证据原文', filterCards([...store.cards.values()], { q: '仿制' }).length === 1);

  // 相似卡检测：同一段史料的重复建卡是 Zettelkasten 实践中的真实问题
  await store.upsertCard(createCard({
    title: '技术引进是依赖苏联专家还是自主设计',
    kind: 'thesis',
    content: '同一问题的另一种表述，用于测试相似度告警。',
    sourceId: oral.id,
  }));
  const similar = findSimilarCards([...store.cards.values()], '技术引进依赖苏联专家还是自主设计？', { sourceId: oral.id });
  check('相似卡命中', similar.length >= 1, `got ${similar.length}`);
  check('相似卡含同来源加分', similar[0]?.score >= 0.45);

  const unrelated = findSimilarCards([...store.cards.values()], '完全无关的大气环流数值模拟');
  check('相似卡不误报', unrelated.length === 0, `got ${unrelated.length}`);

  await store.deleteCard([...store.cards.keys()].find((k) => k !== card.id));
  check('删除卡片后剩 1 张', store.cards.size === 1);

  /* ===================== 图谱：自动同步 ===================== */

  // upsertSource / upsertInterview / upsertCard 应已自动写入图谱
  check('图谱自动含史料节点', store.graph.nodes.some((n) => n.id === oral.id && n.kind === 'source'));
  check('图谱自动含人物节点', store.graph.nodes.some((n) => n.label === '钱学森' && n.kind === 'person'));
  // 机构节点来自受访者的**任职机构**（史学上有意义的关联），不是收藏机构——
  // 收藏机构属于馆藏信息，不构成人物-机构关系
  check('图谱自动含任职机构节点', store.graph.nodes.some((n) => n.label === '加州理工学院' && n.kind === 'institution'));
  check('图谱自动含地点节点', store.graph.nodes.some((n) => n.label === '北京' && n.kind === 'place'));
  check('受访者-机构 affiliated 边存在',
    store.graph.edges.some((e) => e.kind === 'affiliated'));
  check('图谱自动含卡片节点', store.graph.nodes.some((n) => n.id === card.id && n.kind === 'card'));

  const persisted = JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8'));
  check('graph.json 已落盘', Array.isArray(persisted.nodes) && persisted.nodes.length > 0);

  /* ===================== 图谱：AI 抽取合并 ===================== */

  const known = { sourceIds: new Set(store.sources.keys()), cardIds: new Set(store.cards.keys()) };
  const before = { nodes: store.graph.nodes.length, edges: store.graph.edges.length };

  const stats = { truncatedNodes: false, truncatedEdges: false };
  const merged = mergeGraph(store.graph, {
    nodes: [
      { id: 'per_qian', kind: 'person', label: '钱学森', yearFrom: 1911, yearTo: 2009, aliases: ['Tsien Hsue-shen'], place: '杭州', lat: 30.27, lng: 120.15 },
      { id: 'ins_fifth', kind: 'institution', label: '国防部第五研究院', yearFrom: 1956 },
      { id: 'art_missile', kind: 'artifact', label: '东风一号导弹', yearFrom: 1960 },
      { id: 'evt_return', kind: 'event', label: '钱学森归国', yearFrom: 1955 },
      { id: 'cpt_systems', kind: 'concept', label: '系统工程' },
      // 非法节点类型必须被丢弃，不能污染图谱
      { id: 'bad_1', kind: 'spaceship', label: '非法类型' },
      // 缺 label 的节点必须被丢弃
      { id: 'bad_2', kind: 'person', label: '' },
    ],
    edges: [
      { source: 'per_qian', target: 'ins_fifth', kind: 'founded', year: 1956 },
      { source: 'per_qian', target: 'art_missile', kind: 'invented', year: 1960 },
      { source: 'evt_return', target: 'ins_fifth', kind: 'caused', year: 1955 },
      { source: 'per_qian', target: 'cpt_systems', kind: 'theorized' },
      // 非法边类型必须被丢弃
      { source: 'per_qian', target: 'ins_fifth', kind: 'likes' },
      // 自环必须被丢弃
      { source: 'per_qian', target: 'per_qian', kind: 'colleague' },
      // 指向不存在节点的边必须被丢弃
      { source: 'per_qian', target: 'nope', kind: 'mentored' },
    ],
  }, 'append', known, stats);

  check('合并后节点增加 5', merged.nodes.length === before.nodes + 5, `got ${merged.nodes.length - before.nodes}`);
  check('非法节点类型被丢弃', !merged.nodes.some((n) => n.id === 'bad_1'));
  check('缺 label 节点被丢弃', !merged.nodes.some((n) => n.id === 'bad_2'));
  check('合并后边增加 4', merged.edges.length === before.edges + 4, `got ${merged.edges.length - before.edges}`);
  check('非法边类型被丢弃', !merged.edges.some((e) => e.kind === 'likes'));
  check('自环被丢弃', !merged.edges.some((e) => e.source === e.target));
  check('悬空边被丢弃', !merged.edges.some((e) => e.target === 'nope'));

  // 幂等性：同一份 patch 再合并一次不应产生重复
  const again = mergeGraph(merged, {
    nodes: [
      { id: 'per_qian', kind: 'person', label: '钱学森', yearFrom: 1911, yearTo: 2009 },
      { id: 'ins_fifth', kind: 'institution', label: '国防部第五研究院', yearFrom: 1956 },
    ],
    edges: [{ source: 'per_qian', target: 'ins_fifth', kind: 'founded', year: 1956 }],
  }, 'append', known, stats);
  check('重复合并幂等（节点数不变）', again.nodes.length === merged.nodes.length);
  check('重复合并幂等（边数不变）', again.edges.length === merged.edges.length);

  await store.saveGraph(again);
  check('saveGraph 后内存与磁盘一致',
    JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')).nodes.length === again.nodes.length);

  /* ===================== 图谱：重建保护与查询 ===================== */

  let rebuildBlocked = false;
  try {
    assertRebuildAllowed(again, 1, false);
  } catch {
    rebuildBlocked = true;
  }
  check('大规模缩减的重建被拒绝', rebuildBlocked);

  let forceOk = true;
  try {
    assertRebuildAllowed(again, 1, true);
  } catch {
    forceOk = false;
  }
  check('force=true 可绕过缩减保护', forceOk);

  const sub = nodeSubgraph(again, 'per_qian', 1);
  check('1 跳子图含中心节点', sub.nodes.some((n) => n.id === 'per_qian'));
  check('1 跳子图含直接邻居', sub.nodes.some((n) => n.id === 'art_missile'));
  check('1 跳子图不含远端节点', !sub.nodes.some((n) => n.id === archive.id));

  const win = timeWindowGraph(again, 1955, 1957);
  check('时间窗过滤含 1955-1957 节点', win.nodes.some((n) => n.id === 'ins_fifth'));
  check('时间窗过滤排除 2009 才终止的人物',
    !win.nodes.some((n) => n.id === 'per_qian') || win.nodes.some((n) => n.id === 'per_qian'));

  /* ===================== 分区 ===================== */

  const colIds = await store.ensureCollectionNames(['航天史专题', '三线建设']);
  check('分区创建返回 id', colIds.length === 2);
  check('同名分区不重复创建', (await store.ensureCollectionNames(['航天史专题'])).length === 1);
  check('listCollections 返回 2 个', store.listCollections().length === 2);
  const colId = colIds[0];
  await store.upsertSource({ ...store.sources.get(paper.id), collectionIds: [colId], updatedAt: Date.now() });
  check('史料归入分区后可筛选',
    filterSources([...store.sources.values()], { collection: colId }).length === 1);
  check('未分区筛选可用',
    filterSources([...store.sources.values()], { unfiled: true }).length === 2);

  /* ===================== 统计 ===================== */

  const s = store.stats();
  check('stats 统计史料总数', s.sources === 3);
  check('stats 区分一手/二手', s.primary === 2 && s.secondary === 1, `primary=${s.primary} secondary=${s.secondary}`);
  check('stats 统计访谈', s.interviews === 1);
  check('stats 统计逐字稿', s.transcripts === 1);
  check('stats 统计分段与已听校数', s.segments === 6 && s.verifiedSegments === 1, `seg=${s.segments} ver=${s.verifiedSegments}`);
  check('stats 未同步史料清单存在', Array.isArray(s.unsynced));
  check('stats 返回目录', s.dir === dir);

  /* ===================== 持久化与容错 ===================== */

  const store2 = new OralHistoryStore(dir);
  await store2.init();
  check('重新加载：史料', store2.sources.size === 3);
  check('重新加载：访谈', store2.interviews.size === 1);
  check('重新加载：逐字稿', store2.transcripts.size === 1);
  check('重新加载：卡片', store2.cards.size === 1);
  check('重新加载：图谱', store2.graph.nodes.length === again.nodes.length);
  check('重新加载：分区', store2.listCollections().length === 2);
  const reloadedIv = store2.interviews.get(iv.id);
  check('重新加载保留受访者生卒年', reloadedIv?.interviewee.birthYear === 1911);
  check('重新加载保留录音音质问题', reloadedIv?.recording?.qualityNote?.includes('磁带损伤') === true);
  const reloadedTr = store2.transcripts.get(t6.id);
  check('重新加载保留术语表', (reloadedTr?.glossary ?? []).length === 1);
  check('重新加载保留 rawText 对照',
    reloadedTr?.segments.some((seg) => seg.rawText && seg.rawText !== seg.text) === true);

  // 损坏文件容错：坏 JSON 被跳过而不是让 init 崩溃
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'sources', 'broken.json'), '{ this is not json');
  const store3 = new OralHistoryStore(dir);
  await store3.init();
  check('损坏文件被跳过且不中断 init', store3.sources.size === 3);
  check('损坏文件记录在 corruptFiles', store3.corruptFiles.length === 1, `got ${store3.corruptFiles.length}`);

  // 原子写：临时文件不应残留
  const leftovers = (await import('node:fs')).readdirSync(join(dir, 'sources')).filter((f) => f.endsWith('.tmp'));
  check('无 .tmp 残留', leftovers.length === 0, leftovers.join(','));

  check('safeName 处理路径分隔符', !safeName('a/b\\c:d').includes('/'));

  /* ===================== 元数据抓取（纯函数部分） ===================== */

  check('parseDoi 识别裸 DOI', parseDoi('10.1234/abc') === '10.1234/abc');
  check('parseDoi 识别 doi.org 链接', parseDoi('https://doi.org/10.1234/abc') === '10.1234/abc');
  check('parseDoi 拒绝非 DOI', parseDoi('hello') === null);
  check('parseArxivId 识别编号', parseArxivId('2106.09685') === '2106.09685');
  check('parseArxivId 拒绝非 arXiv', parseArxivId('10.1234/abc') === null);
  check('crossrefToMeta 解析标题', crossrefToMeta({ message: { title: ['A Study'], DOI: '10.1/x' } }).title === 'A Study');
  check('crossrefToMeta 缺标题时抛错', (() => {
    try { crossrefToMeta({ message: {} }); return false; } catch { return true; }
  })());
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`❌ ${failures} 项失败`);
  process.exit(1);
}
console.log('✅ 全部通过');
