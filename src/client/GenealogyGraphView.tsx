/**
 * dsh-oral-history —— 时空谱系图（Genealogy Graph）
 *
 * 本文件由 dsh-scholar 的 GraphView 分叉而来：渲染机械（手写力导向、
 * 坐标变换、命中测试、指针交互）整体沿用，域语义全部重写：
 *
 *   1. 去掉「论文靠左 / 概念靠右」的列引力——那在本域毫无意义。改为：
 *      · 时间轴引力：按节点年代把 x 拉向对应刻度，图因此自左向右读作编年；
 *        无年代的节点进「中性带」，不堆在公元 0 年。
 *      · 地理引力：两个带经纬度的节点按其地理邻近度相互吸引，同地人物聚簇。
 *   2. 史学关系边：论战（debated）加粗 + 危险色 + 虚线，是第一等的研究对象；
 *      有向关系画箭头，对称关系不画；时间/因果族一律虚线。
 *   3. 节点按 nodeKind 着色，半径按度缩放（5–16px），别名进 tooltip。
 *
 * 依赖：只手写实现，零新增 npm 依赖。1500+ 节点下自动降级（跳标签、降透明度）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdgeKind, GraphNode, GraphNodeKind, KnowledgeGraph } from '../shared/types';
import { GRAPH_EDGE_KINDS, GRAPH_NODE_KINDS } from '../shared/types';
import { api, loadSavedFilters, qs, saveFilters } from './api';
import { navBus } from './nav';
import {
  Btn, Chip, edgeColor, EDGE_FAMILIES, EmptyState, Icon, IconButton, Icons, Input,
  Modal, nodeColor, SchStyles, SearchInput, T, truncate,
} from './ui';
import { edgeKindLabels, nodeKindLabels } from './locales';
import { refreshCounts } from './index';
import type { TFunc } from './nav';

/* ==========================================================================
 * 常量
 * ========================================================================== */

/** 筛选状态按 tab 存 sessionStorage（重新挂载恢复，关闭页面即失效）。 */
const FILTERS_KEY = 'oh-graph-filters';

const PAD = 70;
/** 节点半径上下界（radius scaled by degree，bounded） */
const R_MIN = 5;
const R_MAX = 16;

/**
 * 有向关系——需要画箭头。其余（colleague / affiliated / related 等对称关系）不画。
 * 与 shared/types 的 GRAPH_EDGE_KINDS 逐一对应，新增枚举值必须同步这张表。
 */
const DIRECTED: Record<GraphEdgeKind, boolean> = {
  mentored: true, colleague: false, patronized: true, debated: false, succeeded: true,
  affiliated: false, founded: true,
  invented: true, improved: true, transferred: true, localized: true, theorized: true, applied: false,
  authored: true, cited: true, annotated: true, derived_from: true,
  preceded: true, caused: true, influenced: true, related: false,
};

/** 时间 / 因果族——虚线渲染（即便不是论战）。 */
const TEMPORAL_KINDS = new Set<GraphEdgeKind>(['preceded', 'caused', 'influenced']);

/** 超出此节点数即降级渲染（服务端上限 4000 节点 / 12000 边）。 */
const DEGRADE_NODES = 600;
/** 超过此节点数不再绘制任何标签（即使密度滑块拉满）。 */
const LABEL_HARD_LIMIT = 1400;
/** 超过此节点数的布局放到下一帧算（同步算会把渲染线程钉死数秒）。 */
const ASYNC_LAYOUT_NODES = 400;

const FAMILY_ORDER = ['person', 'institution', 'technique', 'document', 'temporal'] as const;

/** 论战的虚线节奏（SVG stroke-dasharray） */
const DASH_DEBATED = '6 3';
const DASH_TEMPORAL = '3 3';

interface Pos { x: number; y: number }

/* ==========================================================================
 * 小工具
 * ========================================================================== */

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

/** 节点的年代定位：区间取中点；只有一端就用那一端。 */
function midYear(n: GraphNode): number | null {
  if (n.yearFrom !== undefined && n.yearTo !== undefined) return (n.yearFrom + n.yearTo) / 2;
  if (n.yearFrom !== undefined) return n.yearFrom;
  if (n.yearTo !== undefined) return n.yearTo;
  return null;
}

/** 年代区间文案（与详情面板一致）。 */
function yearRange(n: GraphNode): string | null {
  if (n.yearFrom !== undefined && n.yearTo !== undefined) return `${n.yearFrom} – ${n.yearTo}`;
  if (n.yearFrom !== undefined) return String(n.yearFrom);
  if (n.yearTo !== undefined) return String(n.yearTo);
  return null;
}

function hasGeo(n: GraphNode): boolean {
  return typeof n.lat === 'number' && typeof n.lng === 'number'
    && Number.isFinite(n.lat) && Number.isFinite(n.lng);
}

/** 度 → 半径（有界，hub 读起来更大）。 */
function radiusFor(deg: number): number {
  return Math.min(R_MAX, R_MIN + Math.sqrt(Math.max(0, deg)) * 1.6);
}

/** 年代 → 轴上的 0–1 参数；无年代返回 null（进中性带）。 */
type YearScale = (y: number | null) => number | null;

/** 边的线型：论战最醒目，其余按族分。 */
function edgeDash(kind: GraphEdgeKind): string | undefined {
  if (kind === 'debated') return DASH_DEBATED;
  if (TEMPORAL_KINDS.has(kind)) return DASH_TEMPORAL;
  return undefined;
}

/* ==========================================================================
 * 手写力导向布局
 *
 * 斥力 + 边弹簧 + 碰撞摊销 + 时间轴 x 引力 + 地理邻近引力。
 * 无第三方依赖；迭代次数按规模收敛，1500 节点仍在可接受范围内。
 * ========================================================================== */

interface SimOptions {
  timeline: boolean;
  spatial: boolean;
}

function simulate(
  graph: KnowledgeGraph,
  yearScale: YearScale,
  width: number,
  height: number,
  opts: SimOptions,
): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  const vel = new Map<string, { vx: number; vy: number }>();
  const n = graph.nodes.length;
  if (n === 0) return pos;

  const w = Math.max(200, width - PAD * 2);
  const h = Math.max(200, height - PAD * 2);
  const x0 = PAD;
  const y0 = PAD;
  /** 轴下方的刻度带高度——底部留给年代标签 */
  const axisH = opts.timeline ? 34 : 0;
  const bandH = Math.max(120, h - axisH);
  /** 无年代节点的中性带（左下区域，明确区别于任何年份） */
  const neutralX = x0 + w * 0.5;
  const neutralY = y0 + bandH * 0.82;

  /* ---- 初值：有年代的按年代铺开，无年代的落在中性带 ---- */
  for (const node of graph.nodes) {
    const u = opts.timeline ? yearScale(midYear(node)) : null;
    let px: number;
    let py: number;
    if (u !== null) {
      px = x0 + u * w + (Math.random() - 0.5) * w * 0.05;
      py = y0 + Math.random() * bandH;
    } else if (opts.timeline) {
      px = neutralX + (Math.random() - 0.5) * w * 0.4;
      py = neutralY + (Math.random() - 0.5) * Math.min(120, bandH * 0.22);
    } else {
      px = x0 + Math.random() * w;
      py = y0 + Math.random() * bandH;
    }
    pos.set(node.id, { x: px, y: py });
    vel.set(node.id, { vx: 0, vy: 0 });
  }

  /* ---- 地理坐标归一化：经纬度 → 平面（只对带经纬度的节点） ---- */
  const geoNodes = graph.nodes.filter(hasGeo);
  let gx0 = 0, gx1 = 1, gy0 = 0, gy1 = 1;
  if (geoNodes.length > 1) {
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (const nd of geoNodes) {
      const la = nd.lat as number;
      const ln = nd.lng as number;
      if (ln < mnx) mnx = ln;
      if (ln > mxx) mxx = ln;
      if (la < mny) mny = la;
      if (la > mxy) mxy = la;
    }
    const spanX = Math.max(0.5, mxx - mnx);
    const spanY = Math.max(0.5, mxy - mny);
    gx0 = mnx; gx1 = mnx + spanX;
    gy0 = mny; gy1 = mny + spanY;
  }
  const geoNorm = new Map<string, Pos>();
  const geoIds: string[] = [];
  for (const nd of geoNodes) {
    geoIds.push(nd.id);
    geoNorm.set(nd.id, {
      x: (((nd.lng as number) - gx0) / (gx1 - gx0)) * w,
      y: (((nd.lat as number) - gy0) / (gy1 - gy0)) * bandH,
    });
  }
  /**
   * 地理分辨率 λ：邻近度按 exp(-d/λ) 衰减。
   * 取横向跨度的 1/12——同一城市/同一厂址量级的点会互相吸引，跨省即几乎无作用。
   */
  const geoLambda = Math.max(1, w / 12);
  /** 邻桶方向：自身 + 右/右下/下/左下（覆盖半径 = 桶边长内的全部配对，且每对只算一次） */
  const GEO_NEIGH: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1], [-1, 1]];

  /**
   * 预计算每个地理节点的「引力目标」——地理坐标是静态的，所以这一步只需做
   * 一次（与迭代轮数无关）。
   *
   * 语义仍是「两个带经纬度的节点按地理邻近度互相吸引」，但不逐对施加：
   * 同一城市可能有上百个节点，逐对是 O(n²)。这里把每个节点的地理邻域
   * （4λ 截断内）加权求质心，让节点被该质心吸引：
   *   F = (centroid − pos) · w̄,  w̄ = 1 − exp(−Σ exp(−d_geo/λ))
   * 平衡态与逐对版一致：邻域内合力的方向就是质心方向；强度同样随地理邻近度
   * 衰减——同地 w̄→1（最强，聚成一簇），跨省 w̄→0（无作用）。
   *
   * 代价 O(n · 邻域)；同坐标的节点共享同一份邻域，实际远低于最坏值。
   */
  const geoPull = new Map<string, { tx: number; ty: number; w: number }>();
  if (opts.spatial && geoIds.length > 1) {
    const cut = geoLambda * 4;
    const cut2 = cut * cut;
    // 只对「不同地理坐标」建桶：坐标相同的点邻域完全一致，无需重复计算
    const byCoord = new Map<string, string[]>();
    for (const id of geoIds) {
      const g = geoNorm.get(id) as Pos;
      const key = `${g.x.toFixed(3)},${g.y.toFixed(3)}`;
      const bucket = byCoord.get(key);
      if (bucket) bucket.push(id); else byCoord.set(key, [id]);
    }
    const coords = [...byCoord.values()];
    const cell = cut;
    const cgrid = new Map<string, number[]>();
    coords.forEach((ids, idx) => {
      const g = geoNorm.get(ids[0]) as Pos;
      const key = `${Math.floor(g.x / cell)},${Math.floor(g.y / cell)}`;
      const bucket = cgrid.get(key);
      if (bucket) bucket.push(idx); else cgrid.set(key, [idx]);
    });
    coords.forEach((ids, idx) => {
      const ga = geoNorm.get(ids[0]) as Pos;
      const cx = Math.floor(ga.x / cell);
      const cy = Math.floor(ga.y / cell);
      let wsum = 0;
      let cxs = 0;
      let cys = 0;
      for (const [ox, oy] of GEO_NEIGH) {
        const bucket = cgrid.get(`${cx + ox},${cy + oy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j === idx) continue;
          const gb = geoNorm.get(coords[j][0]) as Pos;
          const gdx = gb.x - ga.x;
          const gdy = gb.y - ga.y;
          const d2 = gdx * gdx + gdy * gdy;
          if (d2 > cut2) continue;
          const wt = Math.exp(-Math.sqrt(d2) / geoLambda);
          wsum += wt;
          cxs += gb.x * wt;
          cys += gb.y * wt;
        }
      }
      if (wsum <= 0) return;
      const pull = { tx: cxs / wsum, ty: cys / wsum, w: 1 - Math.exp(-wsum) };
      for (const id of ids) geoPull.set(id, pull);
    });
  }
  const k = Math.sqrt((w * bandH) / n) * 0.85;
  /** 碰撞半径按平均度估一个上限 */
  const collisionR = Math.max(10, Math.min(26, k * 0.42));
  /**
   * 斥力作用半径 R：超出这个距离就不再互斥。
   * 小图 R=∞（全对全，最准）；大图取 4k——更远的配对按平方反比已可忽略，
   * 截断只损失长程微调，换来 O(n) 量级的候选数。
   */
  const cutoff = n <= 300 ? Infinity : k * 4;
  const iterations = n > 1200 ? 70 : n > 600 ? 100 : n > 300 ? 150 : 260;

  /**
   * 空间哈希网格（每轮重建：节点在动）。
   * 桶边长取作用半径，只需与同桶 + 右/下 4 个邻桶配对即可覆盖所有 d ≤ R 的对，
   * 且每对恰好被访问一次——无重复也无遗漏（哈希碰撞只带来多余候选，不会漏）。
   */
  const cell = Math.max(collisionR * 2, Number.isFinite(cutoff) ? cutoff : collisionR * 4);
  const grid = new Map<string, string[]>();
  const gx = (x: number) => Math.floor(x / cell);
  const gy = (y: number) => Math.floor(y / cell);
  /** 邻桶方向：自身 + 右/右下/下/左下（保证每对只算一次） */
  const NEIGH: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1], [-1, 1]];

  for (let iter = 0; iter < iterations; iter++) {
    const t = 1 - iter / iterations;

    /* ---- 斥力 ---- */
    if (n <= 300) {
      for (let i = 0; i < n; i++) {
        const pa = pos.get(graph.nodes[i].id) as Pos;
        const va = vel.get(graph.nodes[i].id) as { vx: number; vy: number };
        for (let j = i + 1; j < n; j++) {
          const pb = pos.get(graph.nodes[j].id) as Pos;
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          const d = Math.sqrt(d2);
          const f = Math.min((k * k) / d2, k * 0.35);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          va.vx += fx; va.vy += fy;
          const vb = vel.get(graph.nodes[j].id) as { vx: number; vy: number };
          vb.vx -= fx; vb.vy -= fy;
        }
      }
    } else {
      grid.clear();
      for (const nd of graph.nodes) {
        const p = pos.get(nd.id) as Pos;
        const key = `${gx(p.x)},${gy(p.y)}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(nd.id); else grid.set(key, [nd.id]);
      }
      const cut2 = cutoff * cutoff;
      for (const [key, bucket] of grid) {
        const comma = key.indexOf(',');
        const cx = Number(key.slice(0, comma));
        const cy = Number(key.slice(comma + 1));
        for (const [ox, oy] of NEIGH) {
          const other = grid.get(`${cx + ox},${cy + oy}`);
          if (!other) continue;
          const same = ox === 0 && oy === 0;
          const lim = same ? bucket.length : other.length;
          for (let i = 0; i < (same ? lim : bucket.length); i++) {
            const ia = bucket[i];
            const pa = pos.get(ia) as Pos;
            const va = vel.get(ia) as { vx: number; vy: number };
            for (let j = same ? i + 1 : 0; j < (same ? bucket.length : other.length); j++) {
              const ib = same ? bucket[j] : other[j];
              const pb = pos.get(ib) as Pos;
              const dx = pa.x - pb.x;
              const dy = pa.y - pb.y;
              let d2 = dx * dx + dy * dy;
              if (d2 < 1) d2 = 1;
              if (cut2 !== Infinity && d2 > cut2) continue;
              const d = Math.sqrt(d2);
              const f = Math.min((k * k) / d2, k * 0.35);
              const fx = (dx / d) * f;
              const fy = (dy / d) * f;
              va.vx += fx; va.vy += fy;
              const vb = vel.get(ib) as { vx: number; vy: number };
              vb.vx -= fx; vb.vy -= fy;
            }
          }
        }
      }
    }

    /* 边弹簧 */
    for (const e of graph.edges) {
      const pa = pos.get(e.source);
      const pb = pos.get(e.target);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - k) * 0.05;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      const va = vel.get(e.source) as { vx: number; vy: number };
      const vb = vel.get(e.target) as { vx: number; vy: number };
      va.vx += fx; va.vy += fy;
      vb.vx -= fx; vb.vy -= fy;
    }

    /* ---- 碰撞摊销：把过近的节点推开（保护半径，避免节点/标签互相遮挡） ----
     * 复用斥力那套空间哈希（桶边长 ≥ R ≥ collisionR），只在可见半径内推挤；
     * 大图时按 parity 隔轮执行——位置是渐进的，隔轮不会改变最终形态，只省一半时间。 */
    if (n <= 80 || iter % 2 === 0) {
      grid.clear();
      for (const nd of graph.nodes) {
        const p = pos.get(nd.id) as Pos;
        const key = `${gx(p.x)},${gy(p.y)}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(nd.id); else grid.set(key, [nd.id]);
      }
      const col2 = collisionR * collisionR;
      for (const [key, bucket] of grid) {
        const comma = key.indexOf(',');
        const cx = Number(key.slice(0, comma));
        const cy = Number(key.slice(comma + 1));
        for (const [ox, oy] of NEIGH) {
          const other = grid.get(`${cx + ox},${cy + oy}`);
          if (!other) continue;
          const same = ox === 0 && oy === 0;
          for (let i = 0; i < bucket.length; i++) {
            const pa = pos.get(bucket[i]) as Pos;
            const va = vel.get(bucket[i]) as { vx: number; vy: number };
            for (let j = same ? i + 1 : 0; j < other.length; j++) {
              const pb = pos.get(other[j]) as Pos;
              const dx = pb.x - pa.x;
              const dy = pb.y - pa.y;
              const d2 = dx * dx + dy * dy;
              if (d2 >= col2) continue;
              const d = Math.sqrt(d2) || 0.001;
              const push = (collisionR - d) * 0.35;
              const ux = dx / d;
              const uy = dy / d;
              pa.x -= ux * push;
              pa.y -= uy * push;
              pb.x += ux * push;
              pb.y += uy * push;
              va.vx -= ux * push * 0.2;
              va.vy -= uy * push * 0.2;
            }
          }
        }
      }
    }

    /* ---- 地理邻近引力 ----
     * 语义：两个带经纬度的节点按地理邻近度互相吸引，同地者聚成一簇。
     *
     * geoPull（引力目标 / 强度）在迭代前算好——地理坐标是静态的，所以"每个
     * 节点被谁吸引、吸到哪、引力多强"都是常量。这里每轮只做一次 O(geoIds)
     * 的查表施加，迭代开销与地理规模无关。
     *
     * 强度 0.085 明显高于普通向心力，才能压过斥力把同地节点真正拢成簇；
     * 仍低于时间轴引力的 0.05·(硬收敛)，所以编年顺序不会被地理打乱。 */
    if (opts.spatial && geoIds.length > 1) {
      const f = 0.085 * t;
      for (let k = 0; k < geoIds.length; k++) {
        const id = geoIds[k];
        const pull = geoPull.get(id);
        if (!pull) continue;
        const p = pos.get(id) as Pos;
        const c = vel.get(id) as { vx: number; vy: number };
        c.vx += (pull.tx - p.x) * f * pull.w;
        c.vy += (pull.ty - p.y) * f * pull.w;
      }
      // 轻微的"地理锚定"：把整体地理布局映到画布，避免聚簇漂到画布外
      for (const id of geoIds) {
        const g = geoNorm.get(id) as Pos;
        const p = pos.get(id) as Pos;
        p.x += (g.x - p.x) * 0.008 * t;
        p.y += (g.y - p.y) * 0.008 * t;
      }
    }

    /* 时间轴引力 + 竖向向心（不做左/右列引力） */
    for (const node of graph.nodes) {
      const p = pos.get(node.id) as Pos;
      const c = vel.get(node.id) as { vx: number; vy: number };
      if (opts.timeline) {
        const u = yearScale(midYear(node));
        if (u !== null) {
          // 年代明确的：x 向刻度收敛（编年轴是硬约束）
          p.x += (x0 + u * w - p.x) * 0.05 * t;
        } else {
          // 无年代的：只做很弱的回中性带，避免被别的年份吸附
          p.x += (neutralX - p.x) * 0.006 * t;
          p.y += (neutralY - p.y) * 0.02 * t;
        }
      }
      p.y += (y0 + bandH / 2 - p.y) * 0.005 * t;
      c.vx += (x0 + w / 2 - p.x) * 0.0015;
      c.vy += (y0 + bandH / 2 - p.y) * 0.0015;
    }

    /* 积分 */
    for (const node of graph.nodes) {
      const p = pos.get(node.id) as Pos;
      const c = vel.get(node.id) as { vx: number; vy: number };
      p.x += c.vx * t;
      p.y += c.vy * t;
      c.vx *= 0.85;
      c.vy *= 0.85;
      p.x = Math.max(24, Math.min(width - 24, p.x));
      p.y = Math.max(24, Math.min(height - 24, p.y));
    }
  }

  return pos;
}

/* ==========================================================================
 * 主视图
 * ========================================================================== */

interface GraphForm {
  q: string;
  yearFrom: string;
  yearTo: string;
  nodeKinds: GraphNodeKind[];
  edgeKinds: GraphEdgeKind[];
  labelThreshold: number;
  timeline: boolean;
  spatial: boolean;
}

export function GenealogyGraphView({ t }: { t: TFunc }) {
  /* ---------- 持久化的筛选 ---------- */
  const [saved] = useState(() => loadSavedFilters<GraphForm>(FILTERS_KEY));

  const [q, setQ] = useState(saved.q ?? '');
  const [yearFrom, setYearFrom] = useState(saved.yearFrom ?? '');
  const [yearTo, setYearTo] = useState(saved.yearTo ?? '');
  const [nodeKinds, setNodeKinds] = useState<GraphNodeKind[]>(
    Array.isArray(saved.nodeKinds) ? saved.nodeKinds.filter((k) => (GRAPH_NODE_KINDS as readonly string[]).includes(k)) : [],
  );
  const [edgeKinds, setEdgeKinds] = useState<GraphEdgeKind[]>(
    Array.isArray(saved.edgeKinds) ? saved.edgeKinds.filter((k) => (GRAPH_EDGE_KINDS as readonly string[]).includes(k)) : [],
  );
  const [labelThreshold, setLabelThreshold] = useState<number>(
    typeof saved.labelThreshold === 'number' ? Math.max(0, Math.min(100, saved.labelThreshold)) : 55,
  );
  const [timeline, setTimeline] = useState(saved.timeline !== false);
  const [spatial, setSpatial] = useState(saved.spatial === true);

  /* ---------- 数据 ---------- */
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<'' | 'sync' | 'prune'>('');
  const [extractOpen, setExtractOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);

  /** 焦点子图（点「扩展邻居」时设，1→2→3，再点回到全图） */
  const [centerId, setCenterId] = useState<string | null>(null);
  const [hops, setHops] = useState(0);

  /* ---------- 视图交互状态 ---------- */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** 最近一次 simulate 提交时的尺寸；null = 尚未测量（此时不模拟，消除挂载双模拟） */
  const layoutSizeRef = useRef<{ w: number; h: number } | null>(null);
  /** bump 才按新尺寸重排（settle 后宽度变化 ≥40px） */
  const [layoutKey, setLayoutKey] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [, setPositionsTick] = useState(0);
  const panOrigin = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  const debouncedQ = useDebounced(q, 250);
  /** 重新加载触发器（toolbar 的「重新加载」/ 筛选变更 / 同步后 refetch） */
  const [reloadKey, setReloadKey] = useState(0);

  /* ---------- 拉取 ---------- */
  const query = useMemo(() => qs({
    center: centerId ?? undefined,
    hops: centerId ? hops : undefined,
    yearFrom: yearFrom.trim() || undefined,
    yearTo: yearTo.trim() || undefined,
    kinds: nodeKinds.length ? nodeKinds.join(',') : undefined,
  }), [centerId, hops, yearFrom, yearTo, nodeKinds]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<KnowledgeGraph>(`/oral-history/graph${query}`)
      .then((g) => {
        if (!alive) return;
        setGraph({ nodes: g.nodes ?? [], edges: g.edges ?? [] });
        setError('');
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [query, reloadKey]);

  /* 筛选落盘（会话级） */
  useEffect(() => {
    saveFilters(FILTERS_KEY, { q, yearFrom, yearTo, nodeKinds, edgeKinds, labelThreshold, timeline, spatial });
  }, [q, yearFrom, yearTo, nodeKinds, edgeKinds, labelThreshold, timeline, spatial]);

  /* 选中的节点若被过滤掉，自动取消选中 */
  useEffect(() => {
    if (!selectedId || !graph) return;
    if (!graph.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [graph, selectedId]);

  /* ---------- 客户端过滤：只保留勾选的关系族 ---------- */
  const display = useMemo<KnowledgeGraph | null>(() => {
    if (!graph) return null;
    if (!edgeKinds.length) return graph;
    const keep = new Set<string>(edgeKinds);
    const edges = graph.edges.filter((e) => keep.has(e.kind));
    // 与学者版一致的语义：只剩被隐藏边的节点同步隐藏，原本就孤立的节点保持显示
    const keptIds = new Set<string>();
    const touched = new Set<string>();
    for (const e of graph.edges) { touched.add(e.source); touched.add(e.target); }
    for (const e of edges) { keptIds.add(e.source); keptIds.add(e.target); }
    return { nodes: graph.nodes.filter((n) => keptIds.has(n.id) || !touched.has(n.id)), edges };
  }, [graph, edgeKinds]);

  /* ---------- 时间轴刻度 ---------- */
  const yearExtent = useMemo(() => {
    if (!display) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of display.nodes) {
      const a = n.yearFrom ?? n.yearTo;
      const b = n.yearTo ?? n.yearFrom;
      if (a === undefined) continue;
      if (a < lo) lo = a;
      if ((b as number) > hi) hi = b as number;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (hi - lo < 1) { lo -= 1; hi += 1; }
    return { lo, hi };
  }, [display]);

  const yearScale = useCallback<YearScale>((y) => {
    if (y === null || !yearExtent) return null;
    return (y - yearExtent.lo) / (yearExtent.hi - yearExtent.lo);
  }, [yearExtent]);

  /** 轴上要画的年份刻度（约 6–10 个整数刻度，取整到易读的步长）。 */
  const axisTicks = useMemo(() => {
    if (!timeline || !yearExtent) return [] as number[];
    const span = yearExtent.hi - yearExtent.lo;
    const rough = span / 8;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, rough))));
    const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? pow * 10);
    const start = Math.ceil(yearExtent.lo / step) * step;
    const out: number[] = [];
    for (let y = start; y <= yearExtent.hi && out.length < 24; y += step) out.push(y);
    return out;
  }, [timeline, yearExtent]);

  /* ---------- 布局 ----------
   * 小图同步算（无闪烁）；超过 ASYNC_LAYOUT_NODES 的大图改为让出一帧后再算，
   * 否则 4000 节点约 3s 会把渲染线程钉死、连"计算中"都画不出来。 */
  const [laying, setLaying] = useState(false);
  const [positions, setPositions] = useState<Map<string, Pos>>(() => new Map());
  const layoutSeq = useRef(0);

  useEffect(() => {
    const sz = layoutSizeRef.current;
    if (!display || !sz) { setPositions(new Map()); return; }
    const seq = ++layoutSeq.current;
    if (display.nodes.length <= ASYNC_LAYOUT_NODES) {
      setLaying(false);
      setPositions(simulate(display, yearScale, sz.w, sz.h, { timeline, spatial }));
      return;
    }
    setLaying(true);
    // 双 rAF：先让"计算中…"真正上屏，再开始阻塞式的布局计算
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (seq !== layoutSeq.current) return; // 已有更新的布局请求
        const next = simulate(display, yearScale, sz.w, sz.h, { timeline, spatial });
        if (seq !== layoutSeq.current) return;
        setPositions(next);
        setLaying(false);
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [display, layoutKey, yearScale, timeline, spatial]);

  const posState = useRef(positions);
  posState.current = positions;

  /* ---------- 尺寸测量（ResizeObserver） ---------- */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    let lastW = 0;
    let lastH = 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const w = r.width;
      const h = r.height;
      if (w === lastW && h === lastH) return;
      if (!layoutSizeRef.current) {
        layoutSizeRef.current = { w, h };
        setSize({ w, h });
        setLayoutKey((k) => k + 1);
      } else {
        // 拖动抽屉期间只按新旧尺寸等比缩放既有坐标，不重算 simulate
        const rw = lastW ? w / lastW : 1;
        const rh = lastH ? h / lastH : 1;
        if (rw !== 1 || rh !== 1) {
          for (const p of posState.current.values()) { p.x *= rw; p.y *= rh; }
          setPositionsTick((v) => v + 1);
        }
        setSize({ w, h });
      }
      lastW = w;
      lastH = h;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const c = layoutSizeRef.current;
        if (!c) return;
        const r2 = el.getBoundingClientRect();
        if (r2.width <= 0 || r2.height <= 0) return;
        if (Math.abs(r2.width - c.w) >= 40 || Math.abs(r2.height - c.h) >= 40) {
          layoutSizeRef.current = { w: r2.width, h: r2.height };
          setSize({ w: r2.width, h: r2.height });
          setLayoutKey((k) => k + 1);
        }
      }, 150);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [graph]);

  /* ---------- 度 / 索引 / 高亮 ---------- */
  const degree = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of display?.edges ?? []) {
      m.set(e.source, (m.get(e.source) ?? 0) + 1);
      m.set(e.target, (m.get(e.target) ?? 0) + 1);
    }
    return m;
  }, [display]);

  /** 全量度（含被客户端过滤掉的关系）——详情面板显示"关联度"用全量更诚实 */
  const fullDegree = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of graph?.edges ?? []) {
      m.set(e.source, (m.get(e.source) ?? 0) + 1);
      m.set(e.target, (m.get(e.target) ?? 0) + 1);
    }
    return m;
  }, [graph]);

  const byId = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of display?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [display]);

  /** 搜索命中集合（label / alias 子串，大小写不敏感） */
  const matches = useMemo(() => {
    const f = debouncedQ.trim().toLowerCase();
    if (!f || !display) return null;
    const out = new Set<string>();
    for (const n of display.nodes) {
      if (n.label.toLowerCase().includes(f)
        || n.id.toLowerCase().includes(f)
        || (n.aliases ?? []).some((a) => a.toLowerCase().includes(f))) {
        out.add(n.id);
      }
    }
    return out;
  }, [display, debouncedQ]);

  const focusId = hoverId ?? selectedId;
  const highlight = useMemo(() => {
    if (!focusId || !display) return null;
    const nodes = new Set<string>([focusId]);
    const edges = new Set<number>();
    display.edges.forEach((e, i) => {
      if (e.source === focusId || e.target === focusId) { nodes.add(e.source); nodes.add(e.target); edges.add(i); }
    });
    return { nodes, edges };
  }, [focusId, display]);

  /* ---------- 适配窗口 ---------- */
  const fitScaleRef = useRef(1);
  const fitView = useCallback(() => {
    const arr = [...posState.current.values()];
    if (!arr.length || !size.w || !size.h) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of arr) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = 96;
    const bw = Math.max(100, maxX - minX);
    const bh = Math.max(100, maxY - minY);
    const scale = Math.max(0.25, Math.min(2.2, Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh)));
    fitScaleRef.current = scale;
    setView({
      x: size.w / 2 - scale * ((minX + maxX) / 2),
      y: size.h / 2 - scale * ((minY + maxY) / 2),
      scale,
    });
  }, [size.w, size.h]);

  useEffect(() => {
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);

  /** 把某个节点居中（搜索命中 / 关系端点点击都走这里） */
  const centerOn = useCallback((id: string) => {
    const p = posState.current.get(id);
    if (!p || !size.w || !size.h) return;
    const scale = Math.max(0.7, Math.min(1.6, view.scale));
    setView({ x: size.w / 2 - scale * p.x, y: size.h / 2 - scale * p.y, scale });
  }, [size.w, size.h, view.scale]);

  /* ---------- 标签密度 ---------- */
  const nodeCount = display?.nodes.length ?? 0;
  const edgeCount = display?.edges.length ?? 0;
  const degraded = nodeCount > DEGRADE_NODES;
  // 相对适配视图的放大倍数才是"密度"的真实含义（小图适配后 scale 本身很小）
  const zoomRatio = view.scale / (fitScaleRef.current || 1);
  /**
   * 标签闸门：密度滑块越高、按度排序越靠前的节点越先出标签。
   * 阈值语义：labelThreshold=0 → 只有 hover/选中给标签；
   *           100 → 全给（但大规模图仍有硬上限）。
   */
  const labelGate = useMemo(() => {
    if (!display) return { cutoff: -1, forced: new Set<string>() };
    if (nodeCount > LABEL_HARD_LIMIT) return { cutoff: Infinity, forced: new Set<string>() };
    const degs = display.nodes.map((n) => degree.get(n.id) ?? 0).sort((a, b) => b - a);
    const share = labelThreshold / 100;
    const allowed = Math.max(0, Math.round(degs.length * share));
    const cutoff = allowed === 0 ? Infinity : (degs[Math.min(allowed, degs.length) - 1] ?? 0);
    const forced = new Set<string>();
    if (matches) for (const id of matches) forced.add(id);
    if (selectedId) forced.add(selectedId);
    return { cutoff, forced };
  }, [display, degree, labelThreshold, nodeCount, matches, selectedId]);

  /** 缩放太小时淡出标签（绝对 scale 无意义，用相对适配的倍率） */
  const zoomLabelOpacity = Math.max(0, Math.min(1, (zoomRatio - 0.4) / 0.35));
  const labelOpacity = degraded ? zoomLabelOpacity * 0.85 : zoomLabelOpacity;
  /** 大规模图整体降透明度，减少绘制压力与视觉噪声 */
  const baseEdgeAlpha = degraded ? 0.26 : 0.45;
  const baseNodeAlpha = degraded ? 0.82 : 1;

  /* ---------- 滚轮缩放（React 的 onWheel 是 passive，需非 passive 绑定） ---------- */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheelRaw = (ev: WheelEvent) => {
      ev.preventDefault();
      const factor = ev.deltaY > 0 ? 0.9 : 1.1;
      setView((v) => ({ ...v, scale: Math.max(0.2, Math.min(3.5, v.scale * factor)) }));
    };
    el.addEventListener('wheel', onWheelRaw, { passive: false });
    return () => el.removeEventListener('wheel', onWheelRaw);
  }, [graph]);

  /* ---------- 指针交互 ---------- */
  const onPointerDownBg = (e: React.PointerEvent) => {
    if (dragNode) return;
    setSelectedId(null);
    setPanning(true);
    panOrigin.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragNode) {
      const p = posState.current.get(dragNode);
      if (!p) return;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      p.x = (e.clientX - rect.left - view.x) / view.scale;
      p.y = (e.clientY - rect.top - view.y) / view.scale;
      // 实时物理：弹簧把直接邻居一起带走
      const moved = new Map(posState.current);
      const n = Math.max(1, moved.size);
      const k = Math.sqrt((size.w * size.h) / n) * 0.85;
      for (const ed of display?.edges ?? []) {
        let otherId: string | null = null;
        if (ed.source === dragNode) otherId = ed.target;
        else if (ed.target === dragNode) otherId = ed.source;
        if (!otherId) continue;
        const p2 = moved.get(otherId);
        if (!p2) continue;
        const dx = p.x - p2.x;
        const dy = p.y - p2.y;
        const d = Math.hypot(dx, dy) || 1;
        const pull = Math.max(-9, Math.min(9, (d - k) * 0.28));
        p2.x += (dx / d) * pull * 0.35;
        p2.y += (dy / d) * pull * 0.35;
      }
      posState.current = moved;
      setPositionsTick((v) => v + 1);
      return;
    }
    if (panning) {
      const dx = e.clientX - panOrigin.current.x;
      const dy = e.clientY - panOrigin.current.y;
      setView((v) => ({ ...v, x: panOrigin.current.vx + dx, y: panOrigin.current.vy + dy }));
    }
  };

  const onPointerUp = () => {
    setDragNode(null);
    setPanning(false);
  };

  /* ---------- 搜索：自动定位到第一个命中 ---------- */
  useEffect(() => {
    if (!matches || matches.size === 0) return;
    const first = [...matches][0];
    if (posState.current.has(first)) centerOn(first);
    // 只在命中集合本身变化时居中，不跟随 view 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  /* ---------- 写操作 ---------- */
  const flash = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus((cur) => (cur === msg ? '' : cur)), 4200);
  };

  const runSync = async () => {
    if (busy) return;
    setBusy('sync');
    try {
      const r = await api<{
        ok: boolean;
        added: { nodes: number; edges: number };
        total: { nodes: number; edges: number };
      }>('/oral-history/graph/sync', { method: 'POST', body: '{}' });
      flash(t('graph.syncDone', { nodes: r.added?.nodes ?? 0, edges: r.added?.edges ?? 0 }));
      setError('');
      setReloadKey((k) => k + 1);
      refreshCounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const runPrune = async () => {
    if (busy) return;
    setBusy('prune');
    try {
      const r = await api<{ ok: boolean; removedNodes: number; total: { nodes: number; edges: number } }>(
        '/oral-history/graph/prune', { method: 'POST', body: '{}' },
      );
      flash(t('graph.pruneDone', { n: r.removedNodes ?? 0 }));
      setError('');
      setReloadKey((k) => k + 1);
      refreshCounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  /* ---------- 邻居扩展 ---------- */
  const expandHops = () => {
    if (!selectedId) return;
    const next = hops + 1;
    if (next > 3) { setCenterId(null); setHops(0); return; }
    setCenterId(selectedId);
    setHops(next);
  };
  const collapseHops = () => {
    setCenterId(null);
    setHops(0);
  };

  const resetFilters = () => {
    setQ('');
    setYearFrom('');
    setYearTo('');
    setNodeKinds([]);
    setEdgeKinds([]);
    setLabelThreshold(55);
    setTimeline(true);
    setSpatial(false);
    setCenterId(null);
    setHops(0);
    setSelectedId(null);
  };

  const toggleNodeKind = (k: GraphNodeKind) => {
    setNodeKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  };
  const toggleEdgeKind = (k: GraphEdgeKind) => {
    setEdgeKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  };
  const toggleFamily = (kinds: readonly GraphEdgeKind[]) => {
    setEdgeKinds((cur) => {
      const all = kinds.every((k) => cur.includes(k));
      return all ? cur.filter((k) => !kinds.includes(k)) : [...new Set([...cur, ...kinds])];
    });
  };

  /* ---------- 派生：地理提示 / 选中详情 ---------- */
  const geoAvailable = useMemo(
    () => (display?.nodes ?? []).some(hasGeo),
    [display],
  );

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const selectedEdges = useMemo(() => {
    if (!display || !selectedId) return [];
    return display.edges.filter((e) => e.source === selectedId || e.target === selectedId);
  }, [display, selectedId]);

  /* ---------- 空 / 加载态 ---------- */
  if (!graph) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14, fontSize: 12, lineHeight: 1.6 }}>
        <SchStyles />
        {error
          ? <div style={{ color: T.danger }}>{error}</div>
          : <div style={{ color: T.caption }}>{t('common.loading')}</div>}
      </div>
    );
  }

  const showEmpty = !!display && display.nodes.length === 0;
  const noMatch = !!matches && matches.size === 0 && nodeCount > 0;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SchStyles />

      {/* ================= 工具栏 ================= */}
      <div style={{ padding: '8px 10px 4px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <IconButton label={t('graph.reload')} onClick={() => setReloadKey((k) => k + 1)} icon={<Icon d={Icons.refresh} size={13} />} />
        <IconButton label={t('graph.fit')} onClick={fitView} icon={<Icon d={Icons.frame} size={13} />} />
        <SearchInput value={q} onChange={(v) => { setQ(v); setSelectedId(null); }} placeholder={t('graph.searchPh')} />
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 10, color: T.secondary, padding: '2px 8px', borderRadius: 999, flex: 'none',
          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))', fontVariantNumeric: 'tabular-nums',
        }}>
          {t('graph.nodes', { n: nodeCount })} · {t('graph.edges', { n: edgeCount })}
        </span>
      </div>

      {/* 年份窗口 + 开关 + 密度 */}
      <div style={{ padding: '0 10px 6px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, color: T.caption, flex: 'none' }}>{t('graph.yearFrom')}</span>
        <Input
          type="number" value={yearFrom} onChange={(e) => setYearFrom(e.target.value)}
          style={{ width: 68, flex: 'none' }} aria-label={t('graph.yearFrom')}
        />
        <span style={{ fontSize: 10.5, color: T.caption, flex: 'none' }}>{t('graph.yearTo')}</span>
        <Input
          type="number" value={yearTo} onChange={(e) => setYearTo(e.target.value)}
          style={{ width: 68, flex: 'none' }} aria-label={t('graph.yearTo')}
        />
        <Chip label={t('graph.timeline')} active={timeline} onClick={() => setTimeline((v) => !v)} />
        <Chip label={t('graph.spatial')} active={spatial} onClick={() => setSpatial((v) => !v)} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none' }}>
          <span style={{ fontSize: 10.5, color: T.caption }}>{t('graph.labelThreshold')}</span>
          <input
            type="range" min={0} max={100} value={labelThreshold}
            onChange={(e) => setLabelThreshold(Number(e.target.value))}
            aria-label={t('graph.labelThreshold')}
            style={{ width: 76, accentColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)' }}
          />
        </span>
        <span style={{ flex: 1 }} />
        <Btn onClick={resetFilters}>{t('graph.resetFilters')}</Btn>
      </div>

      {/* 不变量提示：时间轴 / 地理分布 */}
      {timeline && (
        <div style={{ padding: '0 12px 3px', fontSize: 10, color: T.caption }}>{t('graph.timelineHint')}</div>
      )}
      {spatial && !geoAvailable && (
        <div style={{ padding: '0 12px 3px', fontSize: 10, color: T.warning }}>{t('graph.noGeo')}</div>
      )}

      {/* 节点类型 chips（服务端过滤，变更即 refetch） */}
      <div style={{ padding: '0 10px 6px', display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption, flex: 'none' }}>
          {t('graph.nodeKinds')}
        </span>
        {GRAPH_NODE_KINDS.map((k) => (
          <Chip
            key={k}
            label={(nodeKindLabels as Record<string, string>)[k] ?? k}
            color={nodeColor(k)}
            active={nodeKinds.includes(k)}
            onClick={() => toggleNodeKind(k)}
          />
        ))}
      </div>

      {/* 关系类型 chips（按族分组，客户端过滤） */}
      <div style={{ padding: '0 10px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: T.caption, flex: 'none' }}>
            {t('graph.edgeKinds')}
          </span>
          {edgeKinds.length > 0 && <Chip label={t('graph.resetFilters')} onClick={() => setEdgeKinds([])} />}
        </div>
        {FAMILY_ORDER.map((fam) => {
          const kinds = EDGE_FAMILIES[fam] as readonly GraphEdgeKind[];
          return (
            <div key={fam} style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => toggleFamily(kinds)}
                style={{
                  border: 'none', background: 'none', cursor: 'pointer', padding: 0, flex: 'none',
                  fontSize: 10.5, color: T.secondary, textDecorationLine: 'underline', textDecorationStyle: 'dotted',
                }}
              >
                {t(`graph.edgeFamily.${fam}`)}
              </button>
              {kinds.map((k) => (
                <Chip
                  key={k}
                  label={(edgeKindLabels as Record<string, string>)[k] ?? k}
                  color={edgeColor(k)}
                  active={edgeKinds.includes(k)}
                  onClick={() => toggleEdgeKind(k)}
                />
              ))}
            </div>
          );
        })}
      </div>

      {/* ================= 写操作 ================= */}
      <div style={{ padding: '0 10px 6px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Btn tone="soft" disabled={busy === 'sync'} onClick={() => void runSync()}>
          {busy === 'sync' ? t('graph.syncing') : t('graph.sync')}
        </Btn>
        <Btn disabled={busy === 'prune'} onClick={() => void runPrune()}>
          {busy === 'prune' ? t('common.loading') : t('graph.prune')}
        </Btn>
        <Btn onClick={() => setExtractOpen(true)} title={t('graph.extractHint')}>
          <Icon d={Icons.sparkle} size={11} /> {t('graph.extract')}
        </Btn>
        {centerId && (
          <>
            <span style={{ fontSize: 10.5, color: T.business, flex: 'none' }}>{t('graph.hops', { n: hops })}</span>
            <Btn onClick={collapseHops}>{t('graph.hopsAll')}</Btn>
          </>
        )}
      </div>

      {error && <div style={{ color: T.danger, padding: '0 12px 4px', fontSize: 11 }}>{error}</div>}
      {status && !error && <div style={{ color: T.success, padding: '0 12px 4px', fontSize: 11 }}>{status}</div>}
      {degraded && <div style={{ color: T.caption, padding: '0 12px 4px', fontSize: 10.5 }}>{t('graph.degraded', { n: nodeCount })}</div>}
      {noMatch && <div style={{ color: T.warning, padding: '0 12px 4px', fontSize: 10.5 }}>{t('graph.searchNone')}</div>}
      {matches && matches.size > 0 && (
        <div style={{ padding: '0 12px 4px', fontSize: 10.5, color: T.business }}>
          {t('graph.searchHit', { label: truncate((byId.get([...matches][0])?.label) ?? '', 24) })}
        </div>
      )}

      {showEmpty && (
        <EmptyState
          icon={<Icon d={Icons.graph} size={38} />}
          title={t('common.empty')}
          hint={t('graph.empty')}
          action={<Btn tone="soft" disabled={busy === 'sync'} onClick={() => void runSync()}>{t('graph.sync')}</Btn>}
        />
      )}

      {/* ================= 画布 ================= */}
      <div
        data-dsh-plugin="dsh-oral-history"
        data-dsh-part="genealogy-graph"
        style={{
          flex: 1, minHeight: 0, position: 'relative', margin: '2px 10px 0',
          border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, overflow: 'hidden',
        }}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          style={{ display: 'block', touchAction: 'none', cursor: panning ? 'grabbing' : dragNode ? 'grabbing' : 'grab' }}
          onPointerDown={onPointerDownBg}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { setHoverId(null); onPointerUp(); }}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
            {/* 时间轴：横向轴线 + 底部年代刻度 */}
            {timeline && yearExtent && size.w > 0 && (() => {
              const x0 = PAD;
              const w = Math.max(200, size.w - PAD * 2);
              const yAxis = size.h - 26;
              return (
                <g pointerEvents="none">
                  <line x1={x0} y1={yAxis} x2={x0 + w} y2={yAxis} stroke="var(--dsw-alias-border-l2)" strokeWidth={1} />
                  {axisTicks.map((y) => {
                    const u = yearScale(y);
                    if (u === null) return null;
                    const x = x0 + u * w;
                    return (
                      <g key={y}>
                        <line x1={x} y1={yAxis - 3} x2={x} y2={yAxis + 3} stroke="var(--dsw-alias-border-l2)" strokeWidth={1} />
                        <text x={x} y={yAxis + 14} textAnchor="middle" fontSize={9} fill="var(--dsw-alias-label-caption)">
                          {y}
                        </text>
                      </g>
                    );
                  })}
                  <text x={x0 + w} y={yAxis - 8} textAnchor="end" fontSize={8.5} fill="var(--dsw-alias-label-caption)" opacity={0.8}>
                    {t('graph.axisUnknown')}
                  </text>
                </g>
              );
            })()}

            {/* 边 */}
            {display && display.edges.map((e, i) => {
              const a = posState.current.get(e.source);
              const b = posState.current.get(e.target);
              if (!a || !b) return null;
              const color = edgeColor(e.kind);
              const lit = !highlight || highlight.edges.has(i);
              const opacity = highlight ? (lit ? 0.95 : 0.06) : baseEdgeAlpha;
              const isDebated = e.kind === 'debated';
              // 论战：加粗 + 危险色 + 虚线（史学争论是一等研究对象，不随高亮衰减）
              const strokeWidth = isDebated ? (lit ? 2.6 : 1.2) : lit ? (highlight ? 1.8 : 0.9) : 0.8;
              const dash = edgeDash(e.kind);

              let arrow: React.ReactNode = null;
              if (lit && DIRECTED[e.kind]) {
                const backOff = radiusFor(degree.get(e.target) ?? 0) + 4;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d = Math.hypot(dx, dy) || 1;
                const ux = dx / d;
                const uy = dy / d;
                const tx = b.x - ux * backOff;
                const ty = b.y - uy * backOff;
                const s = isDebated ? 5.4 : 4.4;
                const px = -uy;
                const py = ux;
                arrow = (
                  <polygon
                    points={`${tx + ux * s},${ty + uy * s} ${tx - px * s * 0.55},${ty - py * s * 0.55} ${tx + px * s * 0.55},${ty + py * s * 0.55}`}
                    fill={color}
                    opacity={opacity}
                  />
                );
              }
              return (
                <g key={`${e.source}|${e.kind}|${e.target}|${i}`}>
                  <line
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={color}
                    strokeWidth={strokeWidth}
                    strokeDasharray={dash}
                    strokeLinecap="round"
                    opacity={opacity}
                  />
                  {arrow}
                </g>
              );
            })}

            {/* 节点 */}
            {display && display.nodes.map((node) => {
              const p = posState.current.get(node.id);
              if (!p) return null;
              const isSel = node.id === selectedId;
              const isMatch = !!matches && matches.has(node.id);
              const dim = highlight ? (highlight.nodes.has(node.id) ? 1 : 0.16) : baseNodeAlpha;
              const d = degree.get(node.id) ?? 0;
              const r = radiusFor(d);
              const color = nodeColor(node.kind);
              const showLabel = isSel || isMatch || labelGate.forced.has(node.id)
                || (labelGate.cutoff !== Infinity && d >= labelGate.cutoff && labelOpacity > 0.02);
              return (
                <g
                  key={node.id}
                  transform={`translate(${p.x},${p.y})`}
                  style={{ cursor: 'pointer', opacity: dim }}
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    setDragNode(node.id);
                    setSelectedId(node.id);
                    try { (ev.currentTarget as Element).setPointerCapture(ev.pointerId); } catch { /* 指针已释放——选中态已生效 */ }
                  }}
                  onPointerEnter={(ev) => { ev.stopPropagation(); setHoverId(node.id); }}
                  onPointerLeave={() => setHoverId((cur) => (cur === node.id ? null : cur))}
                >
                  <title>
                    {`${node.label} · ${(nodeKindLabels as Record<string, string>)[node.kind] ?? node.kind}`
                      + (yearRange(node) ? ` · ${yearRange(node)}` : '')
                      + (node.place ? ` · ${node.place}` : '')
                      + (node.aliases?.length ? ` · ${node.aliases.join(' / ')}` : '')}
                  </title>
                  {/* 命中区域：小节点也要好点中 */}
                  <circle r={Math.max(r + 4, 9)} fill="transparent" />
                  <circle
                    r={r}
                    fill={color}
                    fillOpacity={isSel || isMatch ? 1 : 0.88}
                    stroke={isSel ? 'var(--dsw-alias-label-primary)' : isMatch ? T.warning : 'none'}
                    strokeWidth={isSel ? 1.8 : isMatch ? 1.4 : 0}
                  />
                  {/* 标签：仅在选中/命中/密度闸门放行时绘制 */}
                  {showLabel && (
                    <text
                      x={p.x > size.w * 0.78 ? -(r + 6) : r + 6}
                      y={3.5}
                      fontSize={degraded ? 9 : 10}
                      textAnchor={p.x > size.w * 0.78 ? 'end' : 'start'}
                      fill={isSel || isMatch ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)'}
                      fontWeight={isSel || isMatch ? 600 : d >= 4 ? 500 : 400}
                      opacity={isSel || isMatch ? 1 : labelOpacity}
                    >
                      {truncate(node.label, 24)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* ---------- 图例（可折叠） ---------- */}
        <div style={{
          position: 'absolute', left: 8, bottom: 8, maxWidth: 'min(420px, calc(100% - 16px))',
          borderRadius: 9, fontSize: 9.5, color: T.secondary, overflow: 'hidden',
          background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #161616) 82%, transparent)',
          border: '1px solid var(--dsw-alias-border-l2)',
          backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        }}>
          <button
            type="button"
            onClick={() => setLegendOpen((v) => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, width: '100%', cursor: 'pointer',
              border: 'none', background: 'none', color: T.secondary, padding: '5px 9px', fontSize: 10,
            }}
          >
            <Icon d={legendOpen ? Icons.chevronDown : Icons.chevronRight} size={10} />
            {t('graph.legend')}
          </button>
          {legendOpen && (
            <div style={{ padding: '0 9px 7px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div>
                <div style={{ fontSize: 9, color: T.caption, marginBottom: 3 }}>{t('graph.legendNodes')}</div>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  {GRAPH_NODE_KINDS.map((k) => (
                    <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: nodeColor(k), display: 'inline-block' }} />
                      {(nodeKindLabels as Record<string, string>)[k] ?? k}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: T.caption, marginBottom: 3 }}>{t('graph.legendEdges')}</div>
                {FAMILY_ORDER.map((fam) => {
                  const kinds = EDGE_FAMILIES[fam] as readonly GraphEdgeKind[];
                  // 每族取一个样本线型：论战优先展示虚线加粗
                  const sample = kinds.includes('debated') ? 'debated' : kinds[0];
                  const isDebated = sample === 'debated';
                  return (
                    <div key={fam} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                      <svg width={26} height={8} aria-hidden style={{ flex: 'none' }}>
                        <line
                          x1={0} y1={4} x2={26} y2={4}
                          stroke={edgeColor(sample)}
                          strokeWidth={isDebated ? 2.6 : TEMPORAL_KINDS.has(sample) ? 1.2 : 1.4}
                          strokeDasharray={edgeDash(sample)}
                          strokeLinecap="round"
                        />
                      </svg>
                      <span style={{ color: T.secondary }}>{t(`graph.edgeFamily.${fam}`)}</span>
                      <span style={{ color: T.caption }}>
                        {(edgeKindLabels as Record<string, string>)[sample] ?? sample}
                        {isDebated ? ` · ${(edgeKindLabels as Record<string, string>).debated}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ---------- 节点详情面板 ---------- */}
        {selected && (
          <div className="sch-fade" style={{
            position: 'absolute', right: 8, top: 8, bottom: 8, width: 'min(310px, calc(100% - 16px))',
            display: 'flex', flexDirection: 'column',
            background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #161616) 90%, transparent)',
            backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 11,
            padding: '9px 11px', fontSize: 11,
            boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.3))',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: nodeColor(selected.kind), flex: 'none' }} />
              <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.label}
              </span>
              <IconButton label={t('common.close')} size={17} onClick={() => setSelectedId(null)} icon={<Icon d={Icons.close} size={9} />} />
            </div>
            <div style={{ fontSize: 9.5, color: T.caption, marginTop: 2, flex: 'none' }}>
              {(nodeKindLabels as Record<string, string>)[selected.kind] ?? selected.kind}
              {' · '}{t('graph.selected')}
            </div>

            <div className="sch-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 6 }}>
              {/* 年代 */}
              <div style={{ display: 'flex', gap: 6, lineHeight: 1.55 }}>
                <span style={{ color: T.caption, flex: 'none', width: 58 }}>{t('graph.detail.years')}</span>
                <span style={{ color: T.secondary, flex: 1, minWidth: 0 }}>
                  {yearRange(selected) ?? t('common.unknown')}
                </span>
              </div>
              {/* 地点 */}
              <div style={{ display: 'flex', gap: 6, lineHeight: 1.55 }}>
                <span style={{ color: T.caption, flex: 'none', width: 58 }}>{t('graph.detail.place')}</span>
                <span style={{ color: T.secondary, flex: 1, minWidth: 0 }}>
                  {selected.place ?? (hasGeo(selected) ? `${selected.lat}, ${selected.lng}` : t('common.unknown'))}
                </span>
              </div>
              {/* 关联度（全量，含被过滤掉的关系） */}
              <div style={{ display: 'flex', gap: 6, lineHeight: 1.55 }}>
                <span style={{ color: T.caption, flex: 'none', width: 58 }}>{t('graph.detail.degree')}</span>
                <span style={{ color: T.secondary, flex: 1, minWidth: 0 }}>{fullDegree.get(selected.id) ?? 0}</span>
              </div>
              {/* 别名 */}
              {!!selected.aliases?.length && (
                <div style={{ marginTop: 5 }}>
                  <div style={{ color: T.caption, marginBottom: 3 }}>{t('graph.detail.aliases')}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {selected.aliases.map((a) => <Chip key={a} label={a} />)}
                  </div>
                </div>
              )}
              {/* 说明 */}
              {selected.note && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ color: T.caption, marginBottom: 2 }}>{t('graph.detail.note')}</div>
                  <div style={{ color: T.secondary, lineHeight: 1.65, wordBreak: 'break-word' }}>{selected.note}</div>
                </div>
              )}
              {/* 关系：来源 —[关系词]→ 目标 */}
              <div style={{ marginTop: 7 }}>
                <div style={{ color: T.caption, marginBottom: 3 }}>{t('graph.detail.edges')}</div>
                {selectedEdges.length === 0 && (
                  <div style={{ color: T.caption, fontStyle: 'italic' }}>{t('graph.detail.noEdges')}</div>
                )}
                {selectedEdges.map((e, i) => {
                  const outbound = e.source === selected.id;
                  const otherId = outbound ? e.target : e.source;
                  const other = byId.get(otherId);
                  const isDebated = e.kind === 'debated';
                  return (
                    <div key={`${e.source}|${e.kind}|${e.target}|${i}`} style={{
                      display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap',
                      fontSize: 10.5, lineHeight: 1.7,
                      color: isDebated ? T.danger : T.secondary,
                    }}>
                      <button
                        type="button"
                        onClick={() => centerOn(e.source)}
                        style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: 10.5, color: e.source === selected.id ? T.business : T.secondary, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {truncate(byId.get(e.source)?.label ?? e.source, 14)}
                      </button>
                      <span style={{ color: edgeColor(e.kind), fontWeight: isDebated ? 600 : 400, flex: 'none' }}>
                        {outbound ? '—[' : '←['}{(edgeKindLabels as Record<string, string>)[e.kind] ?? e.kind}{outbound ? ']→' : ']—'}
                      </span>
                      <button
                        type="button"
                        onClick={() => centerOn(otherId)}
                        style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: 10.5, color: otherId === selected.id ? T.business : T.secondary, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {truncate(other?.label ?? otherId, 14)}
                      </button>
                      {e.year !== undefined && <span style={{ color: T.caption, flex: 'none' }}>{e.year}</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 操作 */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7, flex: 'none' }}>
              {selected.kind === 'source' && (
                <Btn tone="soft" onClick={() => navBus.go('sources', { sourceId: selected.id })}>
                  <Icon d={Icons.archive} size={11} /> {t('graph.focusSource')}
                </Btn>
              )}
              {selected.kind === 'card' && (
                <Btn tone="soft" onClick={() => navBus.go('cards', { cardId: selected.id })}>
                  <Icon d={Icons.cards} size={11} /> {t('graph.focusCard')}
                </Btn>
              )}
              {(!centerId || hops < 3) && <Btn onClick={expandHops}>{t('graph.expandHops')}</Btn>}
              {centerId && <Btn onClick={collapseHops}>{t('graph.collapseHops')}</Btn>}
            </div>
          </div>
        )}

        {(loading || laying) && (
          <div style={{ position: 'absolute', right: 10, top: 8, fontSize: 10, color: T.caption, pointerEvents: 'none' }}>
            {t('common.loading')}
          </div>
        )}
      </div>

      <div style={{ fontSize: 9.5, color: T.caption, padding: '3px 12px 8px', userSelect: 'none' }}>
        {t('graph.dragHint')}
      </div>

      {/* ---------- AI 抽取说明弹窗（本视图不调用任何 AI 接口） ---------- */}
      {extractOpen && (
        <Modal title={t('graph.extract')} onClose={() => setExtractOpen(false)} width={440}>
          <div style={{ fontSize: 12, lineHeight: 1.75, color: T.secondary }}>{t('graph.extractHint')}</div>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
            <Btn tone="primary" onClick={() => setExtractOpen(false)}>{t('common.close')}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}
