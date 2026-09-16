/**
 * dsh-oral-history — host half.
 *
 * Cordis plugin providing:
 *  - settings namespace `oral-history` (archive directory, defaults, proxy, ASR endpoint)
 *  - REST routes /oral-history/* (sources / interviews / transcripts / cards / graph / stats / config)
 *  - 17 agent-facing tools:
 *      source_save / source_update / source_search / source_get / source_fetch_meta
 *      interview_save / interview_search / interview_get
 *      transcript_save / transcript_get / transcript_glossary_add
 *      card_create / card_search / card_update
 *      kg_extract / kg_query / attachment_link
 *
 * Data lives as local JSON files under the configured data directory
 * (see src/store.ts). All AI-generated content flows through tool arguments
 * produced in conversation — the host never calls an LLM itself.
 */
import type { Context } from '@deepseek-ai/cordis';
// 注意：DSH 生态提供的是 @deepseek-ai/schemastery，裸包名 schemastery 在运行期无法解析
import z from '@deepseek-ai/schemastery';
// 仅加载 dsh-settings 的 Context 类型增强(ctx.settings)
import type {} from '@deepseek-ai/dsh-settings';
import type { OralHistoryConfig } from './shared/types.js';
import { OralHistoryStore } from './store.js';
import { registerOralHistoryRoutes } from './routes.js';
import { registerOralHistoryTools } from './tools.js';

export const name = 'dsh-oral-history';

/** Host services this plugin waits for (settings registry, http carrier, tool registry, prompt assembly). */
export const inject = ['settings', 'webServer', 'tools', 'systemPrompt'];

// settings 命名空间必须是纯小写 kebab-case（类型层校验）
const NS = 'oral-history';

function defaultDataDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
  return `${home}/Documents/OralHistoryArchive`;
}

const ConfigSchema = z.object({
  // 必须有 default：bundle 装载时不带 config，required() 会让整棵插件树装载失败。
  // 默认值就是 defaultDataDir()，设置页可覆盖。
  dataDir: z.string().default(defaultDataDir()),
  defaultTags: z.array(z.string()).default([]),
  fetchProxy: z.string().default(''),
  openalexEmail: z.string().default(''),
  defaultLanguage: z.string().default('zh'),
  asrEndpoint: z.string().default(''),
  glossaryPath: z.string().default(''),
});

/** 口述史研究工作流：把 建档 → 转录 → 标注 → 考据 串成 agent 的默认工作方式 */
const WORKFLOW_PROMPT = [
  '口述史研究工作流（用户要求建档、转录、整理、考据口述史料时严格遵守）：',
  '1) 建档：新史料一律用 source_save 入库，tier 必须明确——',
  '   受访者本人的访谈录音、档案原件、手稿、历史报刊等属 primary（一手史料）；',
  '   现代学者的研究论文、专著属 secondary（二手研究）。',
  '   口述访谈的受访者信息（生卒年、身份、机构、领域）用 interview_save 单独建档，并关联 sourceId。',
  '2) 转录：逐字稿用 transcript_save 分段写入（每段含 start/end 秒、speaker、text）。',
  '   机器转录结果先以 status=raw 存入，AI 按术语表与上下文修正后置为 ai-corrected；',
  '   只有人工听校确认的段落才能置为 human-verified。听不清的段落用 status=inaudible，不得臆造内容。',
  '   遇到反复转录错误的专名，用 transcript_glossary_add 记入术语表，供后续批量修正。',
  '3) 标注：从逐字稿中抽取人物、机构、事件、器物、概念、地点，用 kg_extract 两阶段建图。',
  '   历史关系请使用史学关系词（师承 mentored、论战 debated、技术转移 transferred、',
  '   本土化 localized、赞助 patronized、接任 succeeded 等），不要用理工科的"提出/改进"类关系。',
  '   关系能确定年代时务必填 year，以便时间轴演化。',
  '4) 考据：把值得沉淀的证据/考释/论点用 card_create 建卡，kind 选 extract（摘录）/ chronology（编年）/',
  '   exegesis（考释）/ dispute（争议）/ thesis（论点）/ concept（概念）/ context（背景）。',
  '   卡片必须带 citation（引文定位：逐字稿段落 id / 卷宗号 / 页码）与 quote（证据原文），让卡片自包含。',
  '   存在相反材料时填 counterEvidence，不要只记录支持性证据。',
  '用户提到的史料尚未入库时，先 source_save 再走上述流程。',
  '严禁编造史料内容：无法从已入库材料中确认的年代、人名、事件，必须标注为待考而非直接断言。',
].join('\n');

export function apply(ctx: Context) {
  ctx.effect(
    () => (ctx as any).systemPrompt.section({
      name: 'dsh-oral-history-workflow',
      order: 152,
      text: WORKFLOW_PROMPT,
    }),
    'dsh-oral-history: workflow prompt',
  );

  const scope = ctx.settings.register(NS, ConfigSchema, {});

  const getConfig = (): OralHistoryConfig => {
    const cfg = scope.get() as OralHistoryConfig | undefined;
    return {
      dataDir: cfg?.dataDir?.trim() || defaultDataDir(),
      defaultTags: cfg?.defaultTags ?? [],
      fetchProxy: cfg?.fetchProxy?.trim() || '',
      openalexEmail: cfg?.openalexEmail?.trim() || '',
      defaultLanguage: cfg?.defaultLanguage?.trim() || 'zh',
      asrEndpoint: cfg?.asrEndpoint?.trim() || '',
      glossaryPath: cfg?.glossaryPath?.trim() || '',
    };
  };

  // Lazy singleton store, re-created when the configured directory changes.
  let storePromise: Promise<OralHistoryStore> | null = null;
  let storeDir = '';

  const getStore = (): Promise<OralHistoryStore> => {
    const dir = getConfig().dataDir;
    if (!storePromise || storeDir !== dir) {
      // 目录热切换：旧 store 打 disposed 标记，在途请求的后续写操作会显式失败
      storePromise?.then((old) => old.dispose()).catch(() => {});
      storeDir = dir;
      const store = new OralHistoryStore(dir);
      storePromise = store.init()
        .then(() => {
          const s = store.stats();
          console.log(
            `[dsh-oral-history] 史料库就绪: ${dir}（${s.sources} 条史料 / ${s.primary} 一手 + ${s.secondary} 二手 / `
            + `${s.interviews} 访谈 / ${s.segments} 段落（已校 ${s.verifiedSegments}）/ ${s.cards} 张卡片 / `
            + `图谱 ${s.nodes} 节点 ${s.edges} 边）`,
          );
          return store;
        })
        .catch((err) => {
          storePromise = null;
          throw err;
        });
    }
    return storePromise;
  };

  const updateConfig = async (patch: Partial<OralHistoryConfig>): Promise<void> => {
    await scope.update({ ...getConfig(), ...patch });
  };

  registerOralHistoryRoutes(ctx, getStore, getConfig, updateConfig);
  const toolCount = registerOralHistoryTools(ctx, getStore, getConfig);

  console.log(`[dsh-oral-history] host half ready: settings ns + /oral-history/* routes + ${toolCount} agent tools`);
}
