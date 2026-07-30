import type { IPlugin, PluginContext } from "../../../mod.ts";

// ---------------------------------------------------------------------------
// Core types — everything is raw JSON-like data
// ---------------------------------------------------------------------------

export type Platform = string;
export type EventName = string;

export interface RawEvent {
  platform: Platform;
  eventName: EventName;
  data: Record<string, unknown>;
  raw?: unknown;
}

export interface MiddlewareContext {
  event: RawEvent;
  cancelled: boolean;
  cancel: () => void;
}

export type Middleware = (ctx: MiddlewareContext, next: () => void) => void | Promise<void>;
export type Handler = (event: RawEvent) => void | Promise<void>;

export type Filter = (event: RawEvent) => boolean;

export interface EventBusPluginType {
  metadata: { name: string; version: string };

  // Global middleware (runs for every event)
  use(mw: Middleware): () => void;

  // Middleware filtered by predicate
  useFiltered(filter: Filter, mw: Middleware): () => void;

  // Subscribe with optional filter
  on(filter: Filter, handler: Handler): () => void;
  on(platform: Platform, handler: Handler): () => void;
  on(eventName: EventName, handler: Handler): () => void;

  // Subscribe once
  once(filter: Filter, handler: Handler): () => void;

  // Emit raw event
  emit(event: RawEvent): Promise<void>;
  emit(platform: Platform, eventName: EventName, data: Record<string, unknown>): Promise<void>;

  // Platform helpers
  onPlatform(platform: Platform, handler: Handler): () => void;
  onEvent(eventName: EventName, handler: Handler): () => void;

  // Utility
  listenerCount(): number;
  middlewareCount(): number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface MiddlewareEntry {
  filter: Filter;
  mw: Middleware;
}

interface HandlerEntry {
  filter: Filter;
  handler: Handler;
  once: boolean;
}

class EventBusPlugin implements IPlugin {
  readonly metadata = { name: "event-bus", version: "3.0.0" };

  private middlewareEntries: MiddlewareEntry[] = [];
  private handlers: HandlerEntry[] = [];

  constructor() {
    this.use = this.use.bind(this);
    this.useFiltered = this.useFiltered.bind(this);
    this.on = this.on.bind(this);
    this.once = this.once.bind(this);
    this.emit = this.emit.bind(this);
    this.onPlatform = this.onPlatform.bind(this);
    this.onEvent = this.onEvent.bind(this);
    this.listenerCount = this.listenerCount.bind(this);
    this.middlewareCount = this.middlewareCount.bind(this);
  }

  setup(_ctx: PluginContext): void {}

  // --- Middleware -------------------------------------------------------

  use(mw: Middleware): () => void {
    const filter: Filter = () => true;
    this.middlewareEntries.push({ filter, mw });
    return () => {
      const idx = this.middlewareEntries.findIndex((e) => e.mw === mw);
      if (idx !== -1) this.middlewareEntries.splice(idx, 1);
    };
  }

  useFiltered(filter: Filter, mw: Middleware): () => void {
    this.middlewareEntries.push({ filter, mw });
    return () => {
      const idx = this.middlewareEntries.findIndex((e) => e.mw === mw);
      if (idx !== -1) this.middlewareEntries.splice(idx, 1);
    };
  }

  // --- Subscribe --------------------------------------------------------

  on(filterOrPlatformOrEvent: Filter | Platform | EventName, handler: Handler): () => void {
    const filter = this.toFilter(filterOrPlatformOrEvent);
    const entry: HandlerEntry = { filter, handler, once: false };
    this.handlers.push(entry);
    return () => {
      const idx = this.handlers.indexOf(entry);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  once(filter: Filter, handler: Handler): () => void {
    const entry: HandlerEntry = { filter, handler, once: true };
    this.handlers.push(entry);
    return () => {
      const idx = this.handlers.indexOf(entry);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  // --- Emit -------------------------------------------------------------

  async emit(eventOrPlatform: RawEvent | Platform, eventName?: EventName, data?: Record<string, unknown>): Promise<void> {
    let event: RawEvent;

    if (typeof eventOrPlatform === "object" && eventOrPlatform !== null) {
      event = eventOrPlatform;
    } else {
      event = {
        platform: eventOrPlatform,
        eventName: eventName ?? "unknown",
        data: data ?? {},
      };
    }

    // Run matching middleware
    const matchingMw = this.middlewareEntries.filter((e) => e.filter(event));
    const chain: Middleware[] = matchingMw.map((e) => e.mw);

    if (chain.length > 0) {
      let idx = 0;
      let cancelled = false;

      const ctx: MiddlewareContext = {
        event,
        get cancelled() {
          return cancelled;
        },
        cancel: () => {
          cancelled = true;
        },
      };

      const runNext = async (): Promise<void> => {
        if (cancelled || idx >= chain.length) {
          if (!cancelled) await this.dispatch(event);
          return;
        }
        const mw = chain[idx++];
        await mw(ctx, runNext);
      };

      await runNext();
    } else {
      await this.dispatch(event);
    }
  }

  // --- Platform helpers -------------------------------------------------

  onPlatform(platform: Platform, handler: Handler): () => void {
    return this.on((e) => e.platform === platform, handler);
  }

  onEvent(eventName: EventName, handler: Handler): () => void {
    return this.on((e) => e.eventName === eventName, handler);
  }

  // --- Utility ----------------------------------------------------------

  listenerCount(): number {
    return this.handlers.length;
  }

  middlewareCount(): number {
    return this.middlewareEntries.length;
  }

  // --- Internal ---------------------------------------------------------

  private async dispatch(event: RawEvent): Promise<void> {
    const matching = this.handlers.filter((e) => e.filter(event));
    const toRemove: HandlerEntry[] = [];

    for (const entry of matching) {
      try {
        await entry.handler(event);
      } catch (err) {
        // Isolate handler errors — one bad listener must not break the chain.
        console.error(
          `[event-bus] handler error on ${event.platform}:${event.eventName}:`,
          err instanceof Error ? err.message : err
        );
      }
      if (entry.once) toRemove.push(entry);
    }

    for (const entry of toRemove) {
      const idx = this.handlers.indexOf(entry);
      if (idx !== -1) this.handlers.splice(idx, 1);
    }
  }

  private toFilter(input: Filter | Platform | EventName): Filter {
    if (typeof input === "function") return input;
    if (typeof input === "string") {
      // Match platform or eventName
      return (e) => e.platform === input || e.eventName === input;
    }
    return () => false;
  }
}

const eventBus = new EventBusPlugin();
export default eventBus;
