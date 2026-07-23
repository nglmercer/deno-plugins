// ---------------------------------------------------------------------------
// TikTok Supervisor Agent
// Coordinates chat flow using tool-based delegation.
// Implements the architecture described in MASTRA_MIGRATION_ARCHITECTURE.md
// adapted for the existing Deno/Bun plugin system.
// ---------------------------------------------------------------------------

import type { IPlugin, PluginContext } from "../../../mod.ts";
import type { EventBusPluginType } from "./event-bus.ts";
import type { HistoryEntry, AgentConfig } from "./types.ts";
import { generateText } from "@xsai/generate-text";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentPluginType {
  metadata: { name: string; version: string };
  generateResponse(comment: string, context: ChatContext): Promise<string>;
  getStats(): AgentStats;
  getMemory(): AgentMemoryState;
  savePersistentNote(note: string): Promise<void>;
}

export interface ChatContext {
  nickname: string;
  comment: string;
  isFollower: boolean;
  isSubscriber: boolean;
  isModerator: boolean;
  followRole: number;
  recentHistory: HistoryEntry[];
  sessionSummary: string;
  persistentNotes: string[];
}

export interface AgentStats {
  totalComments: number;
  filteredComments: number;
  responsesGenerated: number;
  errors: number;
  summariesGenerated: number;
  persistentNotesCount: number;
}

export interface AgentMemoryState {
  immediateContext: number;
  sessionSummary: string;
  persistentNotes: string[];
  totalMessagesThisSession: number;
  compactionCount: number;
  entitiesTracked: number;
  knownEntities: number;
}

// ---------------------------------------------------------------------------
// Tool System (replaces Mastra's createTool — lightweight, no Zod dependency)
// ---------------------------------------------------------------------------

interface ToolSchema {
  parse(input: unknown): unknown;
}

function string(): { parse(v: unknown): string } {
  return { parse: (v) => typeof v === "string" ? v : String(v ?? "") };
}

function boolean(): { parse(v: unknown): boolean } {
  return { parse: (v) => typeof v === "boolean" ? v : Boolean(v) };
}

function number(): { parse(v: unknown): number } {
  return { parse: (v) => typeof v === "number" ? v : Number(v ?? 0) };
}

function arrayOf<T>(item: { parse(v: unknown): T }): { parse(v: unknown): T[] } {
  return {
    parse: (v) => {
      if (!Array.isArray(v)) return [];
      return v.map((i) => item.parse(i));
    },
  };
}

type ShapeOutputType<S> = {
  [K in keyof S]: S[K] extends { parse(v: unknown): infer R } ? R : never;
};

function object<S extends Record<string, { parse(v: unknown): unknown }>>(
  shape: S,
): { parse(v: unknown): ShapeOutputType<S> } {
  return {
    parse: (v) => {
      const out: Record<string, unknown> = {};
      const input = (v ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(shape)) {
        out[key] = shape[key].parse(input[key]);
      }
      return out as ShapeOutputType<S>;
    },
  };
}


function enumVal<T extends readonly [string, ...string[]]>(
  values: T,
): { parse(v: unknown): T[number] } {
  return {
    parse: (v) => {
      if (values.includes(v as T[number])) return v as T[number];
      return values[0];
    },
  };
}

interface ToolDefinition<I, O> {
  id: string;
  description: string;
  inputSchema: { parse(v: unknown): I };
  outputSchema: { parse(v: unknown): O };
  execute: (input: I) => Promise<O> | O;
}

// ---------------------------------------------------------------------------
// Tool: filterComment — replaces isRelevant()
// ---------------------------------------------------------------------------

interface FilterInput {
  nickname: string;
  comment: string;
  isFollower: boolean;
  isSubscriber: boolean;
  isModerator: boolean;
  followRole: number;
  minLength: number;
  respondToMods: boolean;
  respondToSubs: boolean;
  respondToFollowers: boolean;
  respondToAll: boolean;
}

interface FilterOutput {
  relevant: boolean;
  reason: string;
}

const filterCommentTool: ToolDefinition<FilterInput, FilterOutput> = {
  id: "filter-comment",
  description:
    "Determine if a chat message should receive a response based on user role and content",
  inputSchema: object({
    nickname: string(),
    comment: string(),
    isFollower: boolean(),
    isSubscriber: boolean(),
    isModerator: boolean(),
    followRole: number(),
    minLength: number(),
    respondToMods: boolean(),
    respondToSubs: boolean(),
    respondToFollowers: boolean(),
    respondToAll: boolean(),
  }),
  outputSchema: object({
    relevant: boolean(),
    reason: string(),
  }),
  execute: (input) => {
    if (input.comment.trim().length < input.minLength) {
      return { relevant: false, reason: "too_short" };
    }
    if (input.isModerator && !input.respondToMods) {
      return { relevant: false, reason: "mod_filtered" };
    }
    if (input.isSubscriber && !input.respondToSubs) {
      return { relevant: false, reason: "sub_filtered" };
    }
    if (input.isFollower && !input.respondToFollowers) {
      return { relevant: false, reason: "follower_filtered" };
    }
    if (
      !input.respondToAll &&
      !input.isFollower &&
      !input.isSubscriber &&
      !input.isModerator
    ) {
      return { relevant: false, reason: "not_follower_sub" };
    }
    return { relevant: true, reason: "passed" };
  },
};

// ---------------------------------------------------------------------------
// Tool: extractEntities — replaces manual entity extraction
// ---------------------------------------------------------------------------

interface EntityInput {
  comment: string;
  nickname: string;
}

interface EntityOutput {
  participant: string;
  mentions: string[];
  sentiment: "positive" | "negative" | "neutral";
}

const extractEntitiesTool: ToolDefinition<EntityInput, EntityOutput> = {
  id: "extract-entities",
  description:
    "Extract participant names and mentions from a chat message",
  inputSchema: object({
    comment: string(),
    nickname: string(),
  }),
  outputSchema: object({
    participant: string(),
    mentions: arrayOf(string()),
    sentiment: enumVal(["positive", "negative", "neutral"] as const),
  }),
  execute: (input) => {
    const mentionPattern = /@(\w+)/g;
    const mentions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionPattern.exec(input.comment)) !== null) {
      if (match[1] !== input.nickname) mentions.push(match[1]);
    }

    const positiveWords = [
      "love",
      "great",
      "awesome",
      "amazing",
      "fun",
      "happy",
      "thanks",
    ];
    const negativeWords = [
      "hate",
      "bad",
      "terrible",
      "awful",
      "angry",
      "mad",
      "stop",
    ];
    const lower = input.comment.toLowerCase();
    const sentiment: "positive" | "negative" | "neutral" = positiveWords.some(
      (w) => lower.includes(w),
    )
      ? "positive"
      : negativeWords.some((w) => lower.includes(w))
      ? "negative"
      : "neutral";

    return { participant: input.nickname, mentions, sentiment };
  },
};

// ---------------------------------------------------------------------------
// Tool: buildContext — replaces context-curator delegation
// ---------------------------------------------------------------------------

interface ContextInput {
  comment: string;
  nickname: string;
  recentHistory: HistoryEntry[];
  sessionSummary: string;
  persistentNotes: string[];
  maxContextMessages: number;
}

interface ContextOutput {
  contextText: string;
  recentMessages: { nickname: string; comment: string }[];
  knownParticipants: string[];
  relevantTopics: string[];
  participantProfiles: ParticipantProfile[];
}

interface ParticipantProfile {
  name: string;
  messageCount: number;
  sentiment: "positive" | "negative" | "neutral";
  roles: string[];
}

const buildContextTool: ToolDefinition<ContextInput, ContextOutput> = {
  id: "build-context",
  description:
    "Build a structured context package for response generation from memory",
  inputSchema: object({
    comment: string(),
    nickname: string(),
    recentHistory: arrayOf(object({
      nickname: string(),
      comment: string(),
      timestamp: number(),
    })),
    sessionSummary: string(),
    persistentNotes: arrayOf(string()),
    maxContextMessages: number(),
  }),
  outputSchema: object({
    contextText: string(),
    recentMessages: arrayOf(object({
      nickname: string(),
      comment: string(),
    })),
    knownParticipants: arrayOf(string()),
    relevantTopics: arrayOf(string()),
    participantProfiles: arrayOf(object({
      name: string(),
      messageCount: number(),
      sentiment: enumVal(["positive", "negative", "neutral"] as const),
      roles: arrayOf(string()),
    })),
  }),
  execute: (input) => {
    const recentMessages = input.recentHistory
      .slice(-input.maxContextMessages)
      .map((h) => ({ nickname: h.nickname, comment: h.comment }));

    const participantMap = new Map<
      string,
      { count: number; sentiments: string[]; roles: Set<string> }
    >();

    for (const msg of input.recentHistory) {
      const entry = participantMap.get(msg.nickname) ??
        { count: 0, sentiments: [], roles: new Set<string>() };
      entry.count++;
      participantMap.set(msg.nickname, entry);
    }

    const participantProfiles: ParticipantProfile[] = [];
    for (const [name, data] of participantMap) {
      const dominantSentiment = data.sentiments.sort(
        (a, b) =>
          data.sentiments.filter((s) => s === b).length -
          data.sentiments.filter((s) => s === a).length,
      )[0] ?? "neutral";
      participantProfiles.push({
        name,
        messageCount: data.count,
        sentiment: dominantSentiment as "positive" | "negative" | "neutral",
        roles: Array.from(data.roles),
      });
    }

    const knownParticipants = Array.from(participantMap.keys());

    const topicPattern = /(?:about|wanna|let's|discuss|talk about|thinking about)\s+(\w+(?:\s+\w+)?)/gi;
    const topics: string[] = [];
    let topicMatch: RegExpExecArray | null;
    for (const msg of input.recentHistory) {
      while ((topicMatch = topicPattern.exec(msg.comment)) !== null) {
        topics.push(topicMatch[1].toLowerCase());
      }
    }
    const relevantTopics = [...new Set(topics)].slice(0, 5);

    const contextParts: string[] = [];
    if (input.sessionSummary) {
      contextParts.push(`## Session Context\n${input.sessionSummary}`);
    }
    if (input.persistentNotes.length > 0) {
      contextParts.push(
        `## Persistent Notes\n${input.persistentNotes.map((n) => `- ${n}`).join("\n")}`,
      );
    }
    if (relevantTopics.length > 0) {
      contextParts.push(
        `## Topics Discussed\n${relevantTopics.map((t) => `- ${t}`).join("\n")}`,
      );
    }

    return {
      contextText: contextParts.join("\n\n"),
      recentMessages,
      knownParticipants,
      relevantTopics,
      participantProfiles,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: trackParticipant — replaces manual participant tracking
// ---------------------------------------------------------------------------

interface TrackInput {
  nickname: string;
  messageCount: number;
  sentiment: string;
  roles: string[];
}

interface TrackOutput {
  success: boolean;
}

interface ParticipantState {
  messageCount: number;
  sentiments: Record<string, number>;
  roles: Set<string>;
  firstSeen: number;
  lastSeen: number;
}

const participantStore = new Map<string, ParticipantState>();

const trackParticipantTool: ToolDefinition<TrackInput, TrackOutput> = {
  id: "track-participant",
  description: "Update participant profile in working memory",
  inputSchema: object({
    nickname: string(),
    messageCount: number(),
    sentiment: string(),
    roles: arrayOf(string()),
  }),
  outputSchema: object({
    success: boolean(),
  }),
  execute: (input) => {
    const existing = participantStore.get(input.nickname);
    const now = Date.now();

    if (existing) {
      existing.messageCount += input.messageCount;
      existing.sentiments[input.sentiment] =
        (existing.sentiments[input.sentiment] ?? 0) + 1;
      for (const role of input.roles) existing.roles.add(role);
      existing.lastSeen = now;
    } else {
      participantStore.set(input.nickname, {
        messageCount: input.messageCount,
        sentiments: { [input.sentiment]: 1 },
        roles: new Set(input.roles),
        firstSeen: now,
        lastSeen: now,
      });
    }

    return { success: true };
  },
};

// ---------------------------------------------------------------------------
// Tool: saveNote — persistent note management
// ---------------------------------------------------------------------------

interface NoteInput {
  note: string;
  notes: string[];
}

interface NoteOutput {
  notes: string[];
  success: boolean;
}

const saveNoteTool: ToolDefinition<NoteInput, NoteOutput> = {
  id: "save-note",
  description: "Save a persistent note for cross-session memory",
  inputSchema: object({
    note: string(),
    notes: arrayOf(string()),
  }),
  outputSchema: object({
    notes: arrayOf(string()),
    success: boolean(),
  }),
  execute: (input) => {
    const updated = [...input.notes, input.note];
    return { notes: updated, success: true };
  },
};

// ---------------------------------------------------------------------------
// Tool: generateResume — replaces session resume generation
// ---------------------------------------------------------------------------

interface ResumeInput {
  sessionId: string;
  totalMessages: number;
  participantProfiles: ParticipantProfile[];
  sessionSummary: string;
}

interface ResumeOutput {
  resume: string;
  totalMessages: number;
}

const generateResumeTool: ToolDefinition<ResumeInput, ResumeOutput> = {
  id: "generate-resume",
  description: "Generate a structured session resume for cross-session memory",
  inputSchema: object({
    sessionId: string(),
    totalMessages: number(),
    participantProfiles: arrayOf(object({
      name: string(),
      messageCount: number(),
      sentiment: enumVal(["positive", "negative", "neutral"] as const),
      roles: arrayOf(string()),
    })),
    sessionSummary: string(),
  }),
  outputSchema: object({
    resume: string(),
    totalMessages: number(),
  }),
  execute: (input) => {
    const topParticipants = [...input.participantProfiles]
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, 5)
      .map((p) => `${p.name} (${p.messageCount} msgs, ${p.sentiment})`)
      .join(", ");

    const resume = [
      `Session ${input.sessionId}: ${input.totalMessages} messages`,
      topParticipants
        ? `Top participants: ${topParticipants}`
        : "",
      input.sessionSummary ? `Summary: ${input.sessionSummary}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return { resume, totalMessages: input.totalMessages };
  },
};

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AgentConfig = {
  baseURL: "http://localhost:1234/v1/",
  model: "lfm2.5-vl-1.6b",
  systemPrompt:
    "You are a friendly and engaging live stream assistant. Respond to viewer comments in a natural, conversational way. Keep responses short (1-2 sentences), fun, and appropriate for a live chat. Address the user by their nickname when relevant.",
  maxContextMessages: 12,
  summaryInterval: 15,
  minCommentLength: 2,
  respondToMods: true,
  respondToSubs: true,
  respondToFollowers: true,
  respondToAll: false,
  temperature: 0.8,
  memoryDir: "./memory",
  enableResponse: false,
};

// ---------------------------------------------------------------------------
// Session ID helper
// ---------------------------------------------------------------------------

function getSessionId(): string {
  const now = new Date();
  return `${now.toISOString().slice(0, 10)}-${now.getHours()}${now.getMinutes()}`;
}

// ---------------------------------------------------------------------------
// TikTok Supervisor Agent Plugin
// ---------------------------------------------------------------------------

class AiAgentPlugin implements IPlugin {
  readonly metadata = {
    name: "ai-agent",
    version: "3.0.0",
    emits: ["agent"] as const,
    listens: ["tiktok"] as const,
  };

  private config: AgentConfig;
  private stats: AgentStats = {
    totalComments: 0,
    filteredComments: 0,
    responsesGenerated: 0,
    errors: 0,
    summariesGenerated: 0,
    persistentNotesCount: 0,
  };

  private bus: EventBusPluginType | undefined;
  private sessionId: string;
  private persistentNotes: string[] = [];
  private history: HistoryEntry[] = [];

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionId = getSessionId();
  }

  setup(_ctx: PluginContext): void {}

  async onEnable(ctx: PluginContext): Promise<void> {
    this.bus = ctx.getPlugin<EventBusPluginType>("event-bus");
    this.sessionId = getSessionId();
    this.history = [];

    if (this.bus) {
      this.bus.on(
        (e) => e.platform === "tiktok" && e.eventName === "chat",
        async (event) => {
          await this.handleChat(event);
        },
      );
    }

    console.log(
      `[ai-agent] supervisor enabled | model: ${this.config.model} | session: ${this.sessionId}`,
    );
    console.log(
      `[ai-agent] tools loaded | ${this.listTools().join(", ")}`,
    );
  }

  async onDisable(_ctx: PluginContext): Promise<void> {

    const resumeResult = await this.executeTool(generateResumeTool, {
      sessionId: this.sessionId,
      totalMessages: this.history.length,
      participantProfiles: this.getParticipantProfiles(),
      sessionSummary: this.deriveSessionSummary(),
    });

    console.log(
      `[ai-agent] session ended | ${resumeResult.totalMessages} messages | resume: ${resumeResult.resume.slice(0, 80)}...`,
    );

    participantStore.clear();
  }

  onUnload(_ctx: PluginContext): void {}

  getStats(): AgentStats {
    return { ...this.stats };
  }

  getMemory(): AgentMemoryState {
    return {
      immediateContext: this.history.length,
      sessionSummary: this.deriveSessionSummary(),
      persistentNotes: this.persistentNotes,
      totalMessagesThisSession: this.history.length,
      compactionCount: 0,
      entitiesTracked: participantStore.size,
      knownEntities: participantStore.size,
    };
  }

  async savePersistentNote(note: string): Promise<void> {
    const result = await this.executeTool(saveNoteTool, {
      note,
      notes: this.persistentNotes,
    });
    this.persistentNotes = result.notes;
    this.stats.persistentNotesCount = this.persistentNotes.length;
    console.log(`[ai-agent] note saved | ${note}`);
  }

  // ------------------------------------------------------------------
  // Tool execution wrapper (validates input/output via schemas)
  // ------------------------------------------------------------------

  private async executeTool<I, O>(
    tool: ToolDefinition<I, O>,
    input: I,
  ): Promise<O> {
    const validated = tool.inputSchema.parse(input) as I;
    const output = await tool.execute(validated);
    return tool.outputSchema.parse(output) as O;
  }

  // ------------------------------------------------------------------
  // List available tools (for debugging/logging)
  // ------------------------------------------------------------------

  private listTools(): string[] {
    return [
      filterCommentTool.id,
      extractEntitiesTool.id,
      buildContextTool.id,
      trackParticipantTool.id,
      saveNoteTool.id,
      generateResumeTool.id,
    ];
  }

  // ------------------------------------------------------------------
  // Derive a lightweight session summary from history
  // ------------------------------------------------------------------

  private deriveSessionSummary(): string {
    if (this.history.length === 0) return "";
    const uniqueParticipants = new Set(
      this.history.map((h) => h.nickname),
    ).size;
    const recentTopics = this.extractRecentTopics();
    const topicStr = recentTopics.length > 0
      ? ` Topics: ${recentTopics.join(", ")}.`
      : "";
    return `${this.history.length} messages from ${uniqueParticipants} participants.${topicStr}`;
  }

  private extractRecentTopics(): string[] {
    const topicPattern =
      /(?:about|wanna|let's|discuss|talk about|thinking about)\s+(\w+(?:\s+\w+)?)/gi;
    const topics: string[] = [];
    let match: RegExpExecArray | null;
    for (const msg of this.history.slice(-30)) {
      while ((match = topicPattern.exec(msg.comment)) !== null) {
        topics.push(match[1].toLowerCase());
      }
    }
    return [...new Set(topics)].slice(0, 5);
  }

  private getParticipantProfiles(): ParticipantProfile[] {
    const profiles: ParticipantProfile[] = [];
    for (const [name, state] of participantStore) {
      const dominantSentiment = Object.entries(state.sentiments).sort(
        ([, a], [, b]) => b - a,
      )[0]?.[0] ?? "neutral";
      profiles.push({
        name,
        messageCount: state.messageCount,
        sentiment: dominantSentiment as "positive" | "negative" | "neutral",
        roles: Array.from(state.roles),
      });
    }
    return profiles;
  }

  // ------------------------------------------------------------------
  // Response generation (uses buildContext tool for delegation)
  // ------------------------------------------------------------------

  private async generateResponse(
    comment: string,
    context: ChatContext,
  ): Promise<string> {
    const contextResult = await this.executeTool(buildContextTool, {
      comment,
      nickname: context.nickname,
      recentHistory: this.history,
      sessionSummary: this.deriveSessionSummary(),
      persistentNotes: this.persistentNotes,
      maxContextMessages: this.config.maxContextMessages,
    });

    const parts: string[] = [this.config.systemPrompt];

    if (contextResult.contextText) {
      parts.push(`\n${contextResult.contextText}`);
    }

    if (contextResult.recentMessages.length > 0) {
      parts.push("\n## Recent Conversation\n");
      for (const msg of contextResult.recentMessages) {
        parts.push(`${msg.nickname}: ${msg.comment}`);
      }
    }

    if (contextResult.participantProfiles.length > 0) {
      parts.push("\n## Relevant Participants");
      for (const entity of contextResult.participantProfiles.slice(0, 5)) {
        parts.push(
          `- ${entity.name} (${entity.messageCount} msgs, ${entity.sentiment})`,
        );
      }
    }

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: parts.join("\n") },
    ];

    for (const msg of contextResult.recentMessages) {
      messages.push({
        role: "user",
        content: `${msg.nickname}: ${msg.comment}`,
      });
    }

    messages.push({
      role: "user",
      content: `${context.nickname}: ${comment}`,
    });

    const { text } = await generateText({
      baseURL: this.config.baseURL,
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
    });

    return text ?? "";
  }

  // ------------------------------------------------------------------
  // Chat handler — supervisor coordination flow
  // ------------------------------------------------------------------

  private async handleChat(event: { data: Record<string, unknown> }): Promise<void> {
    const data = event.data;
    const comment = (data.comment as string) ?? "";
    const nickname = (data.nickname as string) ?? "unknown";

    this.stats.totalComments++;

    const entry: HistoryEntry = {
      nickname,
      comment,
      timestamp: Date.now(),
    };
    this.history.push(entry);

    // Step 1: Extract entities (delegated to tool)
    const entityResult = await this.executeTool(extractEntitiesTool, {
      comment,
      nickname,
    });

    // Step 2: Track participant (delegated to tool)
    await this.executeTool(trackParticipantTool, {
      nickname,
      messageCount: 1,
      sentiment: entityResult.sentiment,
      roles: [],
    });

    // Step 3: Filter comment (delegated to tool)
    const filterResult = await this.executeTool(filterCommentTool, {
      nickname,
      comment,
      isFollower: (data.userIdentity as Record<string, unknown>)
        ?.isFollowerOfAnchor === true,
      isSubscriber: (data.isSubscriber as boolean) ?? false,
      isModerator: (data.isModerator as boolean) ?? false,
      followRole: (data.followRole as number) ?? 0,
      minLength: this.config.minCommentLength,
      respondToMods: this.config.respondToMods,
      respondToSubs: this.config.respondToSubs,
      respondToFollowers: this.config.respondToFollowers,
      respondToAll: this.config.respondToAll,
    });

    if (!filterResult.relevant) {
      this.stats.filteredComments++;
      console.log(
        `[ai-agent] filtered | ${nickname}: "${comment}" | reason: ${filterResult.reason}`,
      );
      return;
    }

    // Step 4: Generate response (delegates context building to tool)
    try {
      console.log(`[ai-agent] processing | ${nickname}: "${comment}"`);

      const context: ChatContext = {
        nickname,
        comment,
        isFollower: (data.userIdentity as Record<string, unknown>)
          ?.isFollowerOfAnchor === true,
        isSubscriber: (data.isSubscriber as boolean) ?? false,
        isModerator: (data.isModerator as boolean) ?? false,
        followRole: (data.followRole as number) ?? 0,
        recentHistory: [],
        sessionSummary: "",
        persistentNotes: this.persistentNotes,
      };

      const response = await this.generateResponse(comment, context);
      this.stats.responsesGenerated++;

      console.log(`[ai-agent] response | → ${response}`);

      this.bus?.emit("agent", "response", {
        originalComment: comment,
        originalUser: nickname,
        response,
        platform: "tiktok",
        timestamp: Date.now(),
      });
    } catch (err) {
      this.stats.errors++;
      console.error(`[ai-agent] error generating response:`, err);
    }
  }
}

const aiAgent = new AiAgentPlugin();
export default aiAgent;
