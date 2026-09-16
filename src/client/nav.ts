import { useSyncExternalStore } from 'react';

/**
 * Cross-view navigation: drawer tab + optional source/interview/card focus.
 *
 * IMPORTANT: snapshots must be value-stable — useSyncExternalStore re-renders
 * only when getSnapshot() returns a NEW reference. Every mutation replaces the
 * whole state object; never mutate it in place.
 */
export type TabId = 'sources' | 'interviews' | 'graph' | 'cards';

export type TFunc = (key: string, params?: Record<string, unknown>) => string;

export interface NavState {
  tab: TabId;
  /** 史料库聚焦的史料 id */
  sourceId: string | null;
  /** 逐字稿视图聚焦的访谈 id */
  interviewId: string | null;
  cardId: string | null;
  /** 新建考据卡时预填的来源史料（跨视图捕获） */
  prefillSourceId: string | null;
  /** 新建访谈时预填的史料（从史料详情"建立访谈档案"进入） */
  prefillInterviewSourceId: string | null;
  /** 逐字稿内跳转定位到某个分段（点考据卡的引文定位时用） */
  focusSegmentId: string | null;
}

const EMPTY: NavState = {
  tab: 'sources',
  sourceId: null,
  interviewId: null,
  cardId: null,
  prefillSourceId: null,
  prefillInterviewSourceId: null,
  focusSegmentId: null,
};

let state: NavState = { ...EMPTY };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

const same = (a: NavState, b: NavState): boolean =>
  a.tab === b.tab && a.sourceId === b.sourceId && a.interviewId === b.interviewId
  && a.cardId === b.cardId && a.prefillSourceId === b.prefillSourceId
  && a.prefillInterviewSourceId === b.prefillInterviewSourceId && a.focusSegmentId === b.focusSegmentId;

export const navBus = {
  getSnapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  go(tab: TabId, patch?: Partial<Omit<NavState, 'tab'>>) {
    const next: NavState = { ...EMPTY, tab, ...patch };
    if (!same(next, state)) {
      state = next;
      emit();
    }
  },
  /** 在当前 tab 上原地更新（如逐字稿内跳转分段，不切 tab） */
  patch(p: Partial<NavState>) {
    const next: NavState = { ...state, ...p };
    if (!same(next, state)) {
      state = next;
      emit();
    }
  },
  consumePrefill() {
    if (state.prefillSourceId || state.prefillInterviewSourceId) {
      state = { ...state, prefillSourceId: null, prefillInterviewSourceId: null };
      emit();
    }
  },
  consumeSourceId() {
    if (state.sourceId) {
      state = { ...state, sourceId: null };
      emit();
    }
  },
  consumeCardId() {
    if (state.cardId) {
      state = { ...state, cardId: null };
      emit();
    }
  },
  consumeFocusSegment() {
    if (state.focusSegmentId) {
      state = { ...state, focusSegmentId: null };
      emit();
    }
  },
};

export function useNav(): NavState {
  return useSyncExternalStore(navBus.subscribe, navBus.getSnapshot);
}
