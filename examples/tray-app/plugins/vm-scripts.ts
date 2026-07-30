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
  reload(): void;
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
  readonly metadata = { name: "vm-scripts", version: "1.0.0" };

  private vm: Vm | null = null;
  private bus: EventBusPluginType | null = null;
  private scriptsDir = "";
  private listeners: ListenerEntry[] = [];
  private unsubscribers: Array<() => void> = [];
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.reload = this.reload.bind(this);
    this.loadedScripts = this.loadedScripts.bind(this);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  onEnable(ctx: PluginContext): void {
    // Retrieve the bus here (not setup) so all plugins are already enabled
    this.bus = ctx.getPlugin<EventBusPluginType>("event-bus") ?? null;
    if (!this.bus) console.warn("[vm-scripts] event-bus not found — emit/on will be no-ops");

    // Resolve scripts/ dir relative to this plugin file
    const base = import.meta.dirname ?? process.cwd();
    this.scriptsDir = join(base, "..", "scripts");
    this.buildVm();
    this.watchScripts();
  }

  onDisable(): void {
    this.stopWatching();
    this.teardown();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  reload(): void {
    this.teardown();
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

    this.exposeBridge(vm);
    this.loadScripts(vm);

    this.vm = vm;
    this.subscribeListeners();
  }

  /**
   * Expose `emit` and `on` into the VM sandbox.
   *
   * - `emit(platform, eventName, data)` — push an event into the host bus.
   * - `on(pattern, handlerName)` — register a VM-global function as a listener.
   *   pattern is "platform:eventName", just "eventName", or "*" for everything.
   *   handlerName is the name of a function defined in the VM scripts.
   */
  private exposeBridge(vm: Vm): void {
    const bus = this.bus;

    // emit(platform, eventName, data) → host event-bus
    vm.exposeFunction("emit", (platform: string, eventName: string, data: unknown) => {
      if (!bus) return;
      const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
      void bus.emit(platform, eventName, payload);
    });

    // on(pattern, handlerName) → register a VM function as a listener
    vm.exposeFunction("on", (pattern: string, handlerName: string) => {
      console.log(`on(${pattern}, ${handlerName})`);
      this.listeners.push({ pattern, handlerName });
      // If the VM is already running (hot-reload mid-session), subscribe immediately
      if (this.vm) this.subscribeOne(this.vm, { pattern, handlerName });
    });

    // log(...args) — convenience logger for scripts
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

    // Deterministic order: alphabetical
    files.sort();

    for (const file of files) {
      const name = basename(file, ".js");
      const source = readFileSync(join(this.scriptsDir, file), "utf-8");
      try {
        // registerModule executes the source (top-level on(...) calls run here)
        // and also makes the module importable by other scripts.
        // Trailing "" suppresses napi-vm's REPL-style last-expression output.
        console.log(`  [vm-scripts] loading: ${name}`);
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
    const vm = this.vm;
    if (!vm) return;
    for (const entry of this.listeners) {
      this.subscribeOne(vm, entry);
    }
  }

  private subscribeOne(vm: Vm, entry: ListenerEntry): void {
    const bus = this.bus;
    if (!bus) return;

    const { pattern, handlerName } = entry;
    const filter = this.patternToFilter(pattern);

    const unsub = bus.on(filter, (event: RawEvent) => {
      // runAsync keeps the Bun event loop free — callFunction would block it
      const json = JSON.stringify({ platform: event.platform, eventName: event.eventName, data: event.data });
      console.log(`[vm-scripts] ${handlerName}`);
      void (vm.runAsync(`${handlerName}(${json});`) as Promise<unknown>).catch((err: Error) => {
        console.error(`[vm-scripts] handler "${handlerName}" error:`, err.message);
      });
    });

    this.unsubscribers.push(unsub);
  }

  /**
   * Parse a pattern string into a RawEvent filter.
   *   "tiktok:chat" → platform=tiktok AND eventName=chat
   *   "chat"        → eventName=chat (any platform)
   *   "*"           → always true
   */
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

  private teardown(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.listeners = [];

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
          this.reload();
        }, 150);
      });
    } catch {
      // scripts dir may not exist yet — skip watching
    }
  }
}

const vmScripts = new VmScriptsPlugin();
export default vmScripts;
