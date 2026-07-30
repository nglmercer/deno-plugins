import { PluginManager, loadPluginsFromDir, watchPluginsFromDir } from "../../mod.ts";
import path from "node:path";
import { existsSync } from "node:fs";
import { runTray } from "./tray.ts";
import type { EventBusPluginType, RawEvent } from "./plugins/event-bus.ts";

function resolvePluginsDir(): string {
  const candidates: string[] = [];

  if (import.meta.dirname) {
    candidates.push(path.join(import.meta.dirname, "plugins"));
  }

  const isCompiledBinary =
    import.meta.dirname?.startsWith("/$bunfs/") ||
    process.execPath.includes("/bun") ||
    import.meta.url.startsWith("bun:");

  if (isCompiledBinary) {
    if (process.argv[1]) {
      const binDir = path.dirname(path.resolve(process.argv[1]));
      candidates.push(path.join(binDir, "plugins"));
    }
    candidates.push(path.join(process.cwd(), "plugins"));
  }

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }

  console.warn("[main] plugins/ not found, candidates checked:");
  for (const dir of candidates) {
    console.warn(`  ${dir}`);
  }
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Middleware: filtering and transformation
// ---------------------------------------------------------------------------

/** Log every event that passes through */
function loggingMiddleware(ctx: { event: RawEvent; cancel: () => void }, next: () => void) {
  console.log(`[mw] ${ctx.event.platform}:${ctx.event.eventName}`, ctx.event.data);
  next();
}

/** Block events from unknown platforms */
const KNOWN_PLATFORMS = new Set(["tiktok", "twitch", "kick", "youtube", "system"]);
function platformGuardMiddleware(ctx: { event: RawEvent; cancelled: boolean; cancel: () => void }, next: () => void) {
  if (!KNOWN_PLATFORMS.has(ctx.event.platform)) {
    console.warn(`[mw] blocked unknown platform: ${ctx.event.platform}`);
    ctx.cancel();
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Adapter: bridge legacy event-emitter → event-bus
// ---------------------------------------------------------------------------

interface LegacyEmitter {
  on(event: string, handler: (...args: unknown[]) => void): void;
}

function bridgeEmitterToBus(
  emitter: LegacyEmitter,
  bus: EventBusPluginType,
): void {
  const PLATFORMS = ["tiktok", "twitch", "kick", "youtube", "system"] as const;

  for (const platform of PLATFORMS) {
    emitter.on(platform, (payload: unknown) => {
      if (typeof payload !== "object" || payload === null) {
        bus.emit(platform, "unknown", { raw: payload });
        return;
      }

      const p = payload as Record<string, unknown>;
      const eventName = (p.eventName as string) ?? "unknown";
      const data = (p.data as Record<string, unknown>) ?? p;

      bus.emit(platform, eventName, data);
    });
  }
}

// ---------------------------------------------------------------------------
// Auto-wiring: subscribe based on plugin metadata
// ---------------------------------------------------------------------------

function autoWirePlugin(manager: PluginManager): void {
  for (const name of manager.getEnabledPlugins()) {
    const plugin = manager.getPlugin<{ metadata: { listens?: readonly string[]; emits?: readonly string[] } }>(name);
    if (!plugin) continue;

    const listens = plugin.metadata?.listens;
    if (!listens || listens.length === 0) continue;

    const emits = plugin.metadata?.emits;
    console.log(`[autowire] ${name} listens: ${listens.join(", ") ?? "—"} | emits: ${emits?.join(", ") ?? "—"}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const manager = new PluginManager();
  const dirPath = resolvePluginsDir();

  const plugins = await loadPluginsFromDir(dirPath);
  for (const plugin of plugins) {
    manager.loadPlugin(plugin, dirPath);
  }

  const bus = manager.getPlugin<EventBusPluginType>("event-bus");

  if (bus) {
    // 1. Global middleware — runs for every event
    // bus.use(loggingMiddleware);

    // 2. Platform guard — only allow known platforms
    bus.use(platformGuardMiddleware);

    // 3. Subscribe by platform — get all TikTok events
    // bus.onPlatform("tiktok", (event) => {
    //   const { eventName, data } = event;
    //   console.log(`[tiktok] ${eventName}:`, data);
    // });

    // // 4. Subscribe by event type — get "chat" from ALL platforms
    // bus.onEvent("chat", (event) => {
    //   const { platform, data } = event;
    //   const comment = data.comment as string | undefined;
    //   const user = (data.nickname as string) ?? (data.user as string) ?? "unknown";
    //   console.log(`[chat:${platform}] ${user}: ${comment}`);
    // });

    // // 5. Subscribe with custom filter — TikTok gifts only
    // bus.on(
    //   (e) => e.platform === "tiktok" && e.eventName === "gift",
    //   (event) => {
    //     const data = event.data;
    //     console.log(`[gift] ${data.nickname ?? "unknown"} sent ${data.giftName ?? "?"} x${data.count ?? 1}`);
    //   },
    // );

    // // 6. Subscribe with filter — any follow event across platforms
    // bus.on(
    //   (e) => e.eventName === "follow",
    //   (event) => {
    //     console.log(`[follow:${event.platform}] ${JSON.stringify(event.data)}`);
    //   },
    // );

    // // 7. System tick from clock plugin
    // bus.onPlatform("system", (event) => {
    //   if (event.eventName === "tick") {
    //     console.log(`[tick] ${(event.data as { count: number }).count}`);
    //   }
    // });

    // // 8. Once — only handle the first connection event
    bus.once(
      (e) => e.eventName === "connect",
      (event) => {
        console.log(`[connect] ${event.platform} connected`);
      },
    );
  }

   // Bridge legacy event-emitter → event-bus
   const legacyEmitter = manager.getPlugin<LegacyEmitter>("event-emitter");
   if (legacyEmitter && bus) {
     bridgeEmitterToBus(legacyEmitter, bus);
   }

   autoWirePlugin(manager);

   // Hot-reload: watch plugins directory for changes
   const pluginWatcher = watchPluginsFromDir(dirPath, {
     onAdd(plugin, fileName, name) {
       console.log(`[hot-reload] new plugin: ${name} (${fileName})`);
       if (manager.has(name)) manager.unregister(name);
       manager.register(plugin, fileName);
       manager.enable(name);
     },
     onChange(plugin, fileName, name) {
       console.log(`[hot-reload] changed plugin: ${name} (${fileName})`);
       if (manager.has(name)) manager.unregister(name);
       manager.register(plugin, fileName);
       manager.enable(name);
     },
     onRemove(fileName, name) {
       if (name) {
         console.log(`[hot-reload] removed plugin: ${name} (${fileName})`);
         manager.unregister(name);
       }
     },
     onError(err, fileName) {
       console.error(`[hot-reload] error loading ${fileName}:`, err.message);
     },
   }, { debounce: 150 });

   // Clean up watcher on exit
   const shutdown = () => {
     pluginWatcher.close();
     manager.shutdown();
     process.exit(0);
   };
   process.on("SIGINT", shutdown);
   process.on("SIGTERM", shutdown);

   await runTray(manager);
}

main();
