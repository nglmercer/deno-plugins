import type { IPlugin, PluginContext } from "../../../mod.ts";
import type { EventBusPluginType, RawEvent } from "./event-bus.ts";
import { Vm } from "napi-vm";
import { readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join, basename } from "node:path";

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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class VmScriptsPlugin implements IPlugin {
  readonly metadata = { name: "vm-scripts", version: "1.1.0" };

  private vm: Vm | null = null;
  private bus: EventBusPluginType | null = null;
  private scriptsDir = "";
  private listeners: ListenerEntry[] = [];
  private unsubscribers: Array<() => void> = [];
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.buildVm();
    this.watchScripts();
  }

  onDisable(): void {
    this.stopWatching();
    // Fire-and-forget: onDisable is sync, but we start the async drain.
    // The alive=false guard prevents new dispatches immediately.
    void this.teardown();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async reload(): Promise<void> {
    await this.teardown();
    this.buildVm();
    console.log("[vm-scripts] reloaded");
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

    this.exposeBridge(vm);
    this.loadScripts(vm);

    this.vm = vm;
    this.subscribeListeners();
  }

  /**
   * Expose `emit` and `on` into the VM sandbox.
   */
  private exposeBridge(vm: Vm): void {
    const bus = this.bus;

    vm.exposeFunction("emit", (platform: string, eventName: string, data: unknown) => {
      if (!bus || !this.alive) return;
      const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
      void bus.emit(platform, eventName, payload);
    });

    vm.exposeFunction("on", (pattern: string, handlerName: string) => {
      this.listeners.push({ pattern, handlerName });
      // If the VM is already assigned (hot-reload mid-session), subscribe now
      if (this.vm) this.subscribeOne({ pattern, handlerName });
    });

    vm.exposeFunction("log", (...args: unknown[]) => {
      console.log("[vm]", ...args);
    });
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
        vm.registerModule(name, source + '\n"";');
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

    const { pattern, handlerName } = entry;
    const filter = this.patternToFilter(pattern);

    const unsub = bus.on(filter, (event: RawEvent) => {
      if (!this.alive || !this.vm) return;

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

    // 2. Unsubscribe from the bus so no new events reach the handler.
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.listeners = [];

    // 3. Destroy the VM. Safe immediately because vm.run() is synchronous —
    //    no in-flight threads to drain (unlike runAsync).
    if (this.vm) {
      for (const name of this.vm.listModules()) {
        this.vm.removeModule(name);
      }
      this.vm.removeGlobal("emit");
      this.vm.removeGlobal("on");
      this.vm.removeGlobal("log");
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
