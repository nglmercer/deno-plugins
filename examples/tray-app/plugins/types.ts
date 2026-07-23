// ---------------------------------------------------------------------------
// Shared types for the multi-agent memory system
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  nickname: string;
  comment: string;
  timestamp: number;
}

export interface Entity {
  name: string;
  firstSeen: number;
  lastSeen: number;
  messageCount: number;
  roles: Set<string>;
  mentions: string[];
  sentiment: "positive" | "negative" | "neutral";
}

export interface Topic {
  id: string;
  label: string;
  messages: number;
  startedAt: number;
  endedAt: number;
  participants: string[];
  summary: string;
}

export interface CompactedSession {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  totalMessages: number;
  uniqueParticipants: number;
  topics: Topic[];
  highlights: string[];
  entityUpdates: EntitySummary[];
  vibe: string;
}

export interface EntitySummary {
  name: string;
  messageCount: number;
  roles: string[];
  sentiment: string;
  notableQuotes: string[];
}

export interface SessionResume {
  sessionId: string;
  date: string;
  summary: string;
  keyEvents: string[];
  activeParticipants: string[];
  topicsDiscussed: string[];
  decisions: string[];
  conflicts: string[];
  followUps: string[];
}

export interface MemoryTier {
  immediate: HistoryEntry[];
  working: WorkingMemory;
  longTerm: LongTermMemory;
}

export interface WorkingMemory {
  sessionId: string;
  currentTopics: Topic[];
  recentEntities: Map<string, Entity>;
  messagesSinceCompaction: number;
  lastCompactionAt: number;
  compactedSummary: string;
}

export interface LongTermMemory {
  entities: Map<string, Entity>;
  sessionResumes: SessionResume[];
  recurringTopics: Map<string, { count: number; lastSeen: number }>;
  relationshipGraph: Map<string, Set<string>>;
}

export interface MemoryState {
  immediateContext: number;
  workingTopics: number;
  knownEntities: number;
  totalSessions: number;
  messagesThisSession: number;
  compactionCount: number;
  entitiesTracked: number;
}

export interface AgentConfig {
  baseURL: string;
  model: string;
  systemPrompt: string;
  maxContextMessages: number;
  summaryInterval: number;
  minCommentLength: number;
  respondToMods: boolean;
  respondToSubs: boolean;
  respondToFollowers: boolean;
  respondToAll: boolean;
  temperature: number;
  memoryDir: string;
  enableResponse: boolean;
}
