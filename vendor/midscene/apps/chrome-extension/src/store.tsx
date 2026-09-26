import type { ChromeRecordedEvent } from '@midscene/recorder-ui';
// import { createStore } from 'zustand/vanilla';
import * as Z from 'zustand';
import { recordLogger } from './extension/recorder/logger';
import { dbManager, initializeDB } from './utils/indexedDB';
import {
  type CairnAccount,
  type CairnTarget,
  type CairnBinding,
  cairnStorage,
  fetchCairnMe,
  fetchCairnTargets,
  fetchCairnOpenBinding,
} from './utils/cairn';
import {
  cairnEnvironmentOrigin,
  isCairnEnvironment,
  type CairnEnvironment,
} from './utils/cairn-environments';

const { create } = Z;
export const useBlackboardPreference = create<{
  markerVisible: boolean;
  elementsVisible: boolean;
  setMarkerVisible: (visible: boolean) => void;
  setTextsVisible: (visible: boolean) => void;
}>((set) => ({
  markerVisible: true,
  elementsVisible: true,
  setMarkerVisible: (visible: boolean) => {
    set({ markerVisible: visible });
  },
  setTextsVisible: (visible: boolean) => {
    set({ elementsVisible: visible });
  },
}));

// Recording session interface
export interface RecordingSession {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  events: ChromeRecordedEvent[];
  status: 'idle' | 'recording' | 'completed';
  duration?: number; // in milliseconds
  url?: string; // The URL where recording started
  generatedCode?: {
    playwright?: string;
    yaml?: string;
    lastGenerated?: number; // timestamp of last generation
  };
  /**
   * Persisted only in the lightweight session metadata cache. Summaries keep
   * `events` empty so the Recorder list can render without deserializing every
   * screenshot in IndexedDB.
   */
  eventCount?: number;
}

// Storage keys
const RECORDING_SESSIONS_KEY = 'midscene-recording-sessions';
const CURRENT_SESSION_ID_KEY = 'midscene-current-session-id';
const RECORDING_STATE_KEY = 'midscene-recording-state';

// Helper functions for persistence with IndexedDB
const loadSessionsFromStorage = async (): Promise<RecordingSession[]> => {
  try {
    // initializeDB is now idempotent, safe to call
    return await dbManager.getSessionSummaries();
  } catch (error) {
    console.error('Failed to load sessions from IndexedDB:', error);
    return [];
  }
};

const saveSessionsToStorage = async (sessions: RecordingSession[]) => {
  // This function is now handled by individual session operations in IndexedDB
  // Keeping for compatibility but no longer used
};

const loadCurrentSessionIdFromStorage = async (): Promise<string | null> => {
  try {
    return await dbManager.getCurrentSessionId();
  } catch (error) {
    console.error('Failed to load current session ID from IndexedDB:', error);
    return null;
  }
};

const saveCurrentSessionIdToStorage = async (sessionId: string | null) => {
  try {
    await dbManager.setCurrentSessionId(sessionId);
  } catch (error) {
    console.error('Failed to save current session ID to IndexedDB:', error);
  }
};

// Helper functions for recording state persistence with IndexedDB
const loadRecordingStateFromStorage = async (): Promise<boolean> => {
  try {
    return await dbManager.getRecordingState();
  } catch (error) {
    console.error('Failed to load recording state from IndexedDB:', error);
    return false;
  }
};

const saveRecordingStateToStorage = async (isRecording: boolean) => {
  try {
    await dbManager.setRecordingState(isRecording);
  } catch (error) {
    console.error('Failed to save recording state to IndexedDB:', error);
  }
};

export const useRecordingSessionStore = create<{
  sessions: RecordingSession[];
  currentSessionId: string | null;
  isInitialized: boolean;
  initializeStore: () => Promise<void>;
  addSession: (session: RecordingSession) => Promise<void>;
  updateSession: (
    sessionId: string,
    updates: Partial<RecordingSession>,
  ) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  setCurrentSession: (sessionId: string | null) => Promise<void>;
  getCurrentSession: () => RecordingSession | null;
  loadSession: (sessionId: string) => Promise<RecordingSession | null>;
}>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  isInitialized: false,
  initializeStore: async () => {
    // Prevent duplicate initialization
    const currentState = get();
    if (currentState.isInitialized) {
      return;
    }

    try {
      // Ensure database initialization
      await initializeDB();
      const [sessions, currentSessionId] = await Promise.all([
        loadSessionsFromStorage(),
        loadCurrentSessionIdFromStorage(),
      ]);
      set({ sessions, currentSessionId, isInitialized: true });
    } catch (error) {
      console.error('Failed to initialize recording session store:', error);
      set({ isInitialized: true });
    }
  },
  addSession: async (session) => {
    const previousSessions = get().sessions;
    const nextSessions = [
      { ...session, eventCount: session.events.length },
      ...previousSessions.filter(({ id }) => id !== session.id),
    ]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5);
    set({ sessions: nextSessions });

    try {
      await dbManager.addSession(session);
    } catch (error) {
      set({ sessions: previousSessions });
      console.error('Failed to add session:', error);
      throw error;
    }
  },
  updateSession: async (sessionId, updates) => {
    try {
      recordLogger.info('Updating session', {
        sessionId,
        updateKeys: Object.keys(updates),
        eventsCount: updates.events?.length,
      });
      await dbManager.updateSession(sessionId, updates);
      // Update in-memory state directly instead of reloading all sessions
      // from IndexedDB, which would deserialize all screenshots again.
      const { sessions } = get();
      const sessionIndex = sessions.findIndex((s) => s.id === sessionId);
      if (sessionIndex >= 0) {
        const updatedSession = {
          ...sessions[sessionIndex],
          ...updates,
          updatedAt: Date.now(),
          eventCount:
            updates.events?.length ?? sessions[sessionIndex].eventCount,
        };
        const newSessions = [...sessions];
        newSessions[sessionIndex] = updatedSession;
        set({ sessions: newSessions });
      } else {
        // Session not found in memory, reload from DB
        const allSessions = await dbManager.getAllSessions();
        set({ sessions: allSessions });
      }
    } catch (error) {
      console.warn(
        'Failed to persist session to IndexedDB, updating in-memory only (data may be lost on reload):',
        error,
      );
      // Try to recover by ensuring the session exists in memory
      const { sessions } = get();
      const sessionInMemory = sessions.find((s) => s.id === sessionId);
      if (sessionInMemory) {
        const updatedSession = {
          ...sessionInMemory,
          ...updates,
          updatedAt: Date.now(),
        };
        const newSessions = sessions.map((s) =>
          s.id === sessionId ? updatedSession : s,
        );
        set({ sessions: newSessions });
      }
    }
  },
  deleteSession: async (sessionId) => {
    const previousSessions = get().sessions;
    set({
      sessions: previousSessions.filter((session) => session.id !== sessionId),
    });
    try {
      await dbManager.deleteSession(sessionId);
    } catch (error) {
      set({ sessions: previousSessions });
      console.error('Failed to delete session:', error);
    }
  },
  setCurrentSession: async (sessionId) => {
    set({ currentSessionId: sessionId });
    try {
      await saveCurrentSessionIdToStorage(sessionId);
    } catch (error) {
      console.error('Failed to set current session:', error);
    }
  },
  getCurrentSession: () => {
    const state = get();
    return state.sessions.find((s) => s.id === state.currentSessionId) || null;
  },
  loadSession: async (sessionId) => {
    const session = await dbManager.getSession(sessionId);
    if (!session) {
      return null;
    }

    set((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === sessionId
          ? { ...session, eventCount: session.events.length }
          : candidate,
      ),
    }));
    return session;
  },
}));

// Helper functions for events persistence with IndexedDB
const loadEventsFromStorage = async (): Promise<ChromeRecordedEvent[]> => {
  try {
    return await dbManager.getRecordingEvents();
  } catch (error) {
    console.error('Failed to load events from IndexedDB:', error);
    return [];
  }
};

function mergeEvents(
  oldEvents: ChromeRecordedEvent[],
  newEvents: ChromeRecordedEvent[],
): ChromeRecordedEvent[] {
  const mergedEventsMap = new Map<string, ChromeRecordedEvent>();

  // Add old events to map, prioritizing them initially
  for (const event of oldEvents) {
    if (event.hashId) {
      mergedEventsMap.set(event.hashId, event);
    }
  }

  // Add new events to map, replacing old ones if hashId matches
  for (const event of newEvents) {
    if (event.hashId) {
      mergedEventsMap.set(event.hashId, event);
    }
  }

  const mergedArray = Array.from(mergedEventsMap.values());
  // Sort events by timestamp in ascending order
  mergedArray.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return mergedArray;
}

const clearEventsFromStorage = async () => {
  try {
    await dbManager.clearRecordingEvents();
  } catch (error) {
    console.error('Failed to clear events from IndexedDB:', error);
  }
};

// Debounced session persistence to avoid O(n²) IndexedDB writes.
// Each addEvent updates in-memory state immediately but batches DB writes.
const SESSION_PERSIST_DELAY_MS = 2000;
let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSessionPersist: {
  sessionId: string;
  events: ChromeRecordedEvent[];
} | null = null;

const flushSessionPersist = async () => {
  if (sessionPersistTimer) {
    clearTimeout(sessionPersistTimer);
    sessionPersistTimer = null;
  }
  if (pendingSessionPersist) {
    const { sessionId, events } = pendingSessionPersist;
    pendingSessionPersist = null;
    try {
      await dbManager.updateSession(sessionId, {
        events,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.error('Failed to persist events to session:', error);
    }
  }
};

const scheduleSessionPersist = (
  sessionId: string,
  events: ChromeRecordedEvent[],
) => {
  pendingSessionPersist = { sessionId, events };
  if (sessionPersistTimer) {
    clearTimeout(sessionPersistTimer);
  }
  sessionPersistTimer = setTimeout(
    flushSessionPersist,
    SESSION_PERSIST_DELAY_MS,
  );
};

export const useRecordStore = create<{
  isRecording: boolean;
  events: ChromeRecordedEvent[];
  isInitialized: boolean;
  initialize: () => Promise<void>;
  setIsRecording: (recording: boolean) => Promise<void>;
  updateEvent: (event: ChromeRecordedEvent) => Promise<void>;
  addEvent: (event: ChromeRecordedEvent) => Promise<void>;
  setEvents: (events: ChromeRecordedEvent[]) => Promise<void>;
  restoreSessionEvents: (events: ChromeRecordedEvent[]) => void;
  resetTransientEvents: () => Promise<void>;
  clearEvents: () => Promise<void>;
  emergencySaveEvents: (events?: ChromeRecordedEvent[]) => Promise<void>;
}>((set, get) => ({
  isRecording: false,
  events: [],
  isInitialized: false,
  initialize: async () => {
    // Prevent duplicate initialization
    const currentState = get();
    if (currentState.isInitialized) {
      return;
    }

    try {
      // Ensure database initialization
      await initializeDB();
      const isRecording = await loadRecordingStateFromStorage();
      const events = isRecording ? await loadEventsFromStorage() : [];
      set({ isRecording, events, isInitialized: true });
    } catch (error) {
      console.error('Failed to initialize record store:', error);
      set({ isInitialized: true });
    }
  },
  setIsRecording: async (recording: boolean) => {
    try {
      // Flush any pending debounced writes before stopping
      if (!recording) {
        await flushSessionPersist();
      }
      await saveRecordingStateToStorage(recording);
      set({ isRecording: recording });
      // Clear events from storage when stopping recording
      if (!recording) {
        await clearEventsFromStorage();
      }
    } catch (error) {
      console.error('Failed to set recording state:', error);
    }
  },
  addEvent: async (event: ChromeRecordedEvent) => {
    const state = get();
    const newEvents = [...state.events, event];
    set({ events: newEvents });
    if (state.isRecording) {
      // Debounce IndexedDB writes to avoid O(n²) IO.
      // In-memory state is updated immediately; DB write is batched.
      const sessionId = useRecordingSessionStore.getState().currentSessionId;
      if (sessionId) {
        scheduleSessionPersist(sessionId, newEvents);
      }
    }
  },
  updateEvent: async (event: ChromeRecordedEvent) => {
    const state = get();
    const newEvents = mergeEvents(state.events, [event]);
    set({ events: newEvents });
    if (state.isRecording) {
      const sessionId = useRecordingSessionStore.getState().currentSessionId;
      if (sessionId) {
        await dbManager.updateSession(sessionId, {
          events: newEvents,
          updatedAt: Date.now(),
        });
      }
    }
  },
  setEvents: async (events: ChromeRecordedEvent[]) => {
    const state = get();
    const newEvents = mergeEvents(state.events, events);
    set({ events: newEvents });
    recordLogger.info('Setting events', {
      eventsCount: newEvents.length,
    });
    if (state.isRecording) {
      const sessionId = useRecordingSessionStore.getState().currentSessionId;
      if (sessionId) {
        await dbManager.updateSession(sessionId, {
          events: newEvents,
          updatedAt: Date.now(),
        });
      }
    }
  },
  restoreSessionEvents: (events: ChromeRecordedEvent[]) => {
    set((state) => ({
      // A live recording can have newer events than the last IndexedDB batch.
      events: state.isRecording ? mergeEvents(events, state.events) : events,
    }));
  },
  resetTransientEvents: async () => {
    await clearEventsFromStorage();
    set({ events: [] });
  },
  clearEvents: async () => {
    await clearEventsFromStorage();
    const sessionId = useRecordingSessionStore.getState().currentSessionId;
    if (sessionId) {
      // Get current session
      const currentSession = useRecordingSessionStore
        .getState()
        .sessions.find((s) => s.id === sessionId);
      await dbManager.updateSession(sessionId, {
        events: [],
        updatedAt: Date.now(),
        // Clear generatedCode as well
        generatedCode: undefined,
      });
    }
    set({ events: [] });
  },
  emergencySaveEvents: async (events?: ChromeRecordedEvent[]) => {
    // Flush any pending debounced session writes first
    await flushSessionPersist();
    const state = get();
    const eventsToSave = events || state.events;
    if (eventsToSave.length > 0) {
      try {
        await dbManager.emergencySetRecordingEvents(eventsToSave);
      } catch (error) {
        console.error('Emergency save failed:', error);
      }
    }
  },
}));

const CONFIG_KEY = 'midscene-env-config';

/**
 * Service Mode
 *
 * - Server: use a node server to run the code
 * - In-Browser: use browser's fetch API to run the code
 * - In-Browser-Extension: use browser's fetch API to run the code, but the page is running in the extension context
 */
export type ServiceModeType = 'Server' | 'In-Browser' | 'In-Browser-Extension'; // | 'Extension';

// ==================== 识途平台协同 Store ====================

const CAIRN_STORAGE_ENVIRONMENT = 'cairn-environment';
const CAIRN_LEGACY_STORAGE_ORIGIN = 'cairn-api-origin';
const CAIRN_STORAGE_TOKEN = 'cairn-auth-token';
const CAIRN_STORAGE_ACCOUNT = 'cairn-auth-account';
const CAIRN_STORAGE_TARGET_ID = 'cairn-target-id';

export interface CairnState {
  environment: CairnEnvironment;
  apiOrigin: string;
  token: string | null;
  account: CairnAccount | null;
  authStatus: 'checking' | 'authenticated' | 'unauthenticated' | 'error';
  targetId: string | null;
  targets: CairnTarget[];
  binding: CairnBinding | null;
  isLoading: boolean;
  error: string | null;
  setEnvironment: (environment: CairnEnvironment) => void;
  setAuth: (token: string | null, account: CairnAccount | null) => void;
  setTargetId: (targetId: string | null) => void;
  setBinding: (binding: CairnBinding | null) => void;
  initialize: () => Promise<void>;
  refreshTargets: () => Promise<void>;
  refreshBinding: () => Promise<void>;
  logout: () => void;
}

export const useCairnStore = create<CairnState>((set, get) => ({
  environment: 'development',
  apiOrigin: cairnEnvironmentOrigin('development')!,
  token: null,
  account: null,
  authStatus: 'checking',
  targetId: null,
  targets: [],
  binding: null,
  isLoading: false,
  error: null,

  setEnvironment: (environment: CairnEnvironment) => {
    const origin = cairnEnvironmentOrigin(environment);
    if (!origin || environment === get().environment) return;
    get().logout();
    void cairnStorage.setItem(CAIRN_STORAGE_ENVIRONMENT, environment);
    set({ environment, apiOrigin: origin });
  },

  setAuth: (token: string | null, account: CairnAccount | null) => {
    if (token) {
      void cairnStorage.setItem(CAIRN_STORAGE_TOKEN, token);
    } else {
      void cairnStorage.removeItem(CAIRN_STORAGE_TOKEN);
    }
    if (account) {
      void cairnStorage.setItem(CAIRN_STORAGE_ACCOUNT, JSON.stringify(account));
    } else {
      void cairnStorage.removeItem(CAIRN_STORAGE_ACCOUNT);
    }
    set({
      token,
      account,
      authStatus: token && account ? 'authenticated' : 'unauthenticated',
      error: null,
    });
    if (token) {
      void get().refreshTargets();
      void get().refreshBinding();
    }
  },

  setTargetId: (targetId: string | null) => {
    if (targetId) {
      void cairnStorage.setItem(CAIRN_STORAGE_TARGET_ID, targetId);
    } else {
      void cairnStorage.removeItem(CAIRN_STORAGE_TARGET_ID);
    }
    set({ targetId });
  },

  setBinding: (binding: CairnBinding | null) => {
    set({ binding });
  },

  initialize: async () => {
    set({ authStatus: 'checking', token: null, account: null, error: null });
    try {
      const [savedEnvironment, legacyOrigin, savedToken, savedTargetId] = await Promise.all([
        cairnStorage.getItem(CAIRN_STORAGE_ENVIRONMENT),
        cairnStorage.getItem(CAIRN_LEGACY_STORAGE_ORIGIN),
        cairnStorage.getItem(CAIRN_STORAGE_TOKEN),
        cairnStorage.getItem(CAIRN_STORAGE_TARGET_ID),
      ]);

      const savedEnvironmentIsConfigured = isCairnEnvironment(savedEnvironment) && !!cairnEnvironmentOrigin(savedEnvironment);
      const environment = savedEnvironmentIsConfigured
        ? savedEnvironment
        : 'development';
      const apiOrigin = cairnEnvironmentOrigin(environment)!;
      // 旧版可自填地址；只复用同一本地开发 API 的会话，避免向新环境发送旧 Token。
      const legacyOriginIsDevelopment = !legacyOrigin ||
        ['http://localhost:3030', 'http://127.0.0.1:3030', 'http://127.0.0.1:5173', apiOrigin].includes(legacyOrigin.replace(/\/+$/, ''));
      const reuseSavedSession = savedEnvironmentIsConfigured || (!savedEnvironment && legacyOriginIsDevelopment);
      if (!reuseSavedSession) {
        get().logout();
      }
      void cairnStorage.removeItem(CAIRN_LEGACY_STORAGE_ORIGIN);
      set({
        environment,
        apiOrigin,
        targetId: reuseSavedSession ? savedTargetId || null : null,
      });

      // 如果有 Token，则调用 /api/me 校验
      if (savedToken && reuseSavedSession) {
        try {
          const meRes = await fetchCairnMe(apiOrigin, savedToken);
          if (!meRes.account?.id) {
            throw new Error('识途登录信息无效，请重新登录');
          }
          set({ token: savedToken, account: meRes.account, authStatus: 'authenticated', error: null });
          await get().refreshTargets();
          await get().refreshBinding();
        } catch (err: any) {
          if (err?.status === 401) {
            get().logout();
          } else {
            set({ authStatus: 'error', error: err?.message || '无法验证登录状态，请重试' });
          }
        }
      } else {
        set({ authStatus: 'unauthenticated' });
      }
    } catch (e: any) {
      set({ authStatus: 'error', error: e?.message || '无法读取登录状态，请重试' });
    }
  },

  refreshTargets: async () => {
    const { apiOrigin, token } = get();
    if (!token) return;
    try {
      set({ isLoading: true });
      const targets = await fetchCairnTargets(apiOrigin, token);
      set({ targets, isLoading: false });

      // 如果当前选中的 targetId 不在列表中且列表非空，或者尚未选择 targetId，自动选择第一个
      const currentTargetId = get().targetId;
      if (!currentTargetId && targets.length > 0) {
        get().setTargetId(targets[0].id);
      }
    } catch (err: any) {
      if (err?.status === 401) {
        get().logout();
        return;
      }
      set({ isLoading: false, error: err?.message || '获取目标系统列表失败' });
    }
  },

  refreshBinding: async () => {
    const { apiOrigin, token } = get();
    if (!token) return;
    try {
      const binding = await fetchCairnOpenBinding(apiOrigin, token);
      set({ binding });
      // 如果当前控制台有 binding 且指定了 targetId，优先绑定
      if (binding?.targetId) {
        get().setTargetId(binding.targetId);
      }
    } catch (err: any) {
      if (err?.status === 401) get().logout();
    }
  },

  logout: () => {
    void cairnStorage.removeItem(CAIRN_STORAGE_TOKEN);
    void cairnStorage.removeItem(CAIRN_STORAGE_ACCOUNT);
    void cairnStorage.removeItem(CAIRN_STORAGE_TARGET_ID);
    set({
      token: null,
      account: null,
      authStatus: 'unauthenticated',
      targetId: null,
      targets: [],
      binding: null,
      error: null,
    });
  },
}));
