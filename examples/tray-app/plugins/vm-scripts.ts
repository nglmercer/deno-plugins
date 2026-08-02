import type { IPlugin, PluginContext } from "../../../mod.ts";
import type { EventBusPluginType, RawEvent } from "./event-bus.ts";
import { Vm } from "napi-vm";
import { VmSession } from "napi-vm/runtime/session.cjs";
import { readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join, basename, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VmScriptsPluginType {
  metadata: { name: string; version: string };
  /** Reload all scripts from disk into a fresh VM. */
  reload(): Promise<void>;
  /** Names of all currently loaded script modules. */
  loadedScripts(): string[];
}

interface ListenerEntry {
  /** "platform:eventName" or just "eventName" or "*" */
  pattern: string;
  /** Name of the VM-global function to call. */
  handlerName: string;
}

type RuntimeSession = VmSession & {
  observeHandler: (name: string, value: unknown) => boolean;
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class VmScriptsPlugin implements IPlugin {
  readonly metadata = { name: "vm-scripts", version: "1.1.0" };

  private vm: Vm | null = null;
  private session: RuntimeSession | null = null;
  private bus: EventBusPluginType | null = null;
  private scriptsDir = "";
  private listeners: ListenerEntry[] = [];
  private unsubscribers: Array<() => void> = [];
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadInFlight: Promise<void> | null = null;
  private subscriptionsReady = false;
  private subscriptionKeys = new Set<string>();

  /**
   * Guards against dispatching to a torn-down VM. Set false BEFORE
   * unsubscribing so any in-flight handler that checks this will bail.
   */
  private alive = false;

  constructor() {
    this.reload = this.reload.bind(this);
    this.loadedScripts = this.loadedScripts.bind(this);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  onEnable(ctx: PluginContext): void {
    this.bus = ctx.getPlugin<EventBusPluginType>("event-bus") ?? null;
    if (!this.bus) console.warn("[vm-scripts] event-bus not found — emit/on will be no-ops");

    const base = import.meta.dirname ?? process.cwd();
    this.scriptsDir = join(base, "..", "scripts");
    this.session = new VmSession({ workspace: resolve(base, "..") }) as RuntimeSession;
    this.buildVm();
    this.watchScripts();
    console.log(`[vm-scripts] runtime session: ${this.session.runtimeFile}`);
  }

  onDisable(): void {
    this.stopWatching();
    // Fire-and-forget: onDisable is sync, but we start the async drain.
    // The alive=false guard prevents new dispatches immediately.
    void this.teardown();
    this.session?.stop();
    this.session = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async reload(): Promise<void> {
    if (this.reloadInFlight) return this.reloadInFlight;

    const task = (async () => {
      await this.teardown();
      this.buildVm();
      console.log("[vm-scripts] reloaded");
    })();
    this.reloadInFlight = task;

    try {
      await task;
    } finally {
      if (this.reloadInFlight === task) this.reloadInFlight = null;
    }
  }

  loadedScripts(): string[] {
    return this.vm ? this.vm.listModules() : [];
  }

  // -------------------------------------------------------------------------
  // VM construction
  // -------------------------------------------------------------------------

  private buildVm(): void {
    const vm = new Vm();
    vm.setLoopLimit(10_000_000);
    this.alive = true;
    this.subscriptionsReady = false;
    this.subscriptionKeys.clear();

    this.vm = vm;
    this.session?.attach(vm);
    this.exposeBridge(vm);
    this.loadScripts(vm);
    this.session?.start();
    this.subscribeListeners();
    this.subscriptionsReady = true;
  }

  /**
   * Expose `emit` and `on` into the VM sandbox.
   */
  private exposeBridge(vm: Vm): void {
    const bus = this.bus;

    const emit = (platform: string, eventName: string, data: unknown) => {
      if (!bus || !this.alive) return;
      const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
      void bus.emit(platform, eventName, payload);
    };
    this.session?.exposeFunction("emit", emit  as (...args: unknown[]) => unknown, {
      params: [
        { name: "platform", typeName: "string" },
        { name: "eventName", typeName: "string" },
        { name: "data", typeName: "object" },
      ],
      returns: "void",
      documentation: "Emit an event on the host event bus.",
    });
    if (!this.session) vm.exposeFunction("emit", emit);

    const on = (pattern: string, handlerName: string) => {
      const entry = { pattern, handlerName };
      const key = this.listenerKey(entry);
      if (this.listeners.some((existing) => this.listenerKey(existing) === key)) return;
      this.listeners.push(entry);
      // Runtime registrations happen after initial script loading.
      if (this.subscriptionsReady) this.subscribeOne(entry);
    };
    this.session?.exposeFunction("on", on as (...args: unknown[]) => unknown, {
      params: [
        { name: "pattern", typeName: "string" },
        { name: "handlerName", typeName: "string" },
      ],
      returns: "void",
      documentation: "Subscribe a VM handler to host events.",
    });
    if (!this.session) vm.exposeFunction("on", on);

    const log = (...args: unknown[]) => {
      console.log("[vm]", ...args);
    };
    this.session?.exposeFunction("log", log, {
      params: [{ name: "args", typeName: "unknown[]" }],
      returns: "void",
      documentation: "Write a message to the host console.",
    });
    if (!this.session) vm.exposeFunction("log", log);
  }

  private loadScripts(vm: Vm): void {
    let files: string[];
    try {
      files = readdirSync(this.scriptsDir).filter((f) => f.endsWith(".js"));
    } catch {
      console.warn(`[vm-scripts] scripts dir not found: ${this.scriptsDir}`);
      return;
    }

    files.sort();

    for (const file of files) {
      const name = basename(file, ".js");
      const source = readFileSync(join(this.scriptsDir, file), "utf-8");
      try {
        const moduleSource = source + '\n"";';
        if (this.session) {
          this.session.registerModule(name, moduleSource);
        } else {
          vm.registerModule(name, moduleSource);
        }
        console.log(`  [vm-scripts] loaded: ${name}`);
      } catch (err) {
        console.error(`  [vm-scripts] error loading ${name}:`, (err as Error).message);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event-bus subscription
  // -------------------------------------------------------------------------

  private subscribeListeners(): void {
    if (!this.vm) return;
    for (const entry of this.listeners) {
      this.subscribeOne(entry);
    }
  }

  private subscribeOne(entry: ListenerEntry): void {
    const bus = this.bus;
    if (!bus) return;

    const key = this.listenerKey(entry);
    if (this.subscriptionKeys.has(key)) return;
    this.subscriptionKeys.add(key);

    const { pattern, handlerName } = entry;
    const filter = this.patternToFilter(pattern);

    const unsub = bus.on(filter, (event: RawEvent) => {
      if (!this.alive || !this.vm) return;

      this.session?.observeHandler(handlerName, event);

      const json = JSON.stringify({
        platform: event.platform,
        eventName: event.eventName,
        data: event.data,
      });

      // Use synchronous vm.run() — NOT runAsync.
      //
      // runAsync spawns a native thread per call. Under sustained event load
      // (TikTok chat: dozens/sec), the thread spawn/cleanup cycle leaks
      // resources until heap corruption → SIGSEGV. This is a napi-vm bug,
      // but the workaround is trivial: vm.run() is synchronous, completes in
      // microseconds for typical handlers (log, count, re-emit), and never
      // spawns a thread. The event-loop blocking is negligible (<1ms/call).
      //
      // Reserve runAsync for genuinely heavy computation (>50ms) where
      // blocking the event loop is unacceptable.
      try {
        this.vm.run(`${handlerName}(${json});`);
      } catch (err) {
        console.error(`[vm-scripts] handler "${handlerName}" error:`, (err as Error).message);
      }
    });

    this.unsubscribers.push(unsub);
  }

  private listenerKey(entry: ListenerEntry): string {
    return `${entry.pattern}\u0000${entry.handlerName}`;
  }

  private patternToFilter(pattern: string): (e: RawEvent) => boolean {
    if (pattern === "*") return () => true;
    if (pattern.includes(":")) {
      const [platform, eventName] = pattern.split(":", 2);
      if (platform === "*") return (e) => e.eventName === eventName;
      if (eventName === "*") return (e) => e.platform === platform;
      return (e) => e.platform === platform && e.eventName === eventName;
    }
    return (e) => e.eventName === pattern;
  }

  // -------------------------------------------------------------------------
  // Teardown & hot-reload
  // -------------------------------------------------------------------------

  private stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  private async teardown(): Promise<void> {
    // 1. Mark dead — handlers check this and bail immediately.
    this.alive = false;
    this.subscriptionsReady = false;

    // 2. Unsubscribe from the bus so no new events reach the handler.
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.subscriptionKeys.clear();
    this.listeners = [];

    // 3. Destroy the VM. Safe immediately because vm.run() is synchronous —
    //    no in-flight threads to drain (unlike runAsync).
    if (this.vm) {
      for (const name of this.vm.listModules()) {
        if (this.session) {
          this.session.removeModule(name);
        } else {
          this.vm.removeModule(name);
        }
      }
      if (this.session) {
        this.session.removeGlobal("emit");
        this.session.removeGlobal("on");
        this.session.removeGlobal("log");
        this.session.detach();
      } else {
        this.vm.removeGlobal("emit");
        this.vm.removeGlobal("on");
        this.vm.removeGlobal("log");
      }
      this.vm = null;
    }
  }

  private watchScripts(): void {
    try {
      this.watcher = watch(this.scriptsDir, (_event, filename) => {
        if (!filename?.endsWith(".js")) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          console.log(`[vm-scripts] change detected: ${filename}`);
          void this.reload();
        }, 150);
      });
    } catch {
      // scripts dir may not exist yet — skip watching
    }
  }
}

const vmScripts = new VmScriptsPlugin();
export default vmScripts;
