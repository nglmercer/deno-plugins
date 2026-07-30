import type { IPlugin, PluginContext } from "../../../mod.ts";
import type { EventBusPluginType } from "./event-bus.ts";

class EventListenersPlugin implements IPlugin {
  readonly metadata = {
    name: "listeners",
    version: "1.1.0",
    emits: ["system"] as const,
    listens: ["tiktok", "agent", "memory", "context"] as const,
  };

  private unsubscribers: Array<() => void> = [];

  setup(_ctx: PluginContext): void {}

  onEnable(ctx: PluginContext): void {
    const bus = ctx.getPlugin<EventBusPluginType>("event-bus");
    if (!bus) return;

    // Store every unsubscribe so onDisable can clean up.
    this.unsubscribers.push(
      bus.onPlatform("tiktok", (e) => {
        if (e.eventName === "chat") {
          const nickname = (e.data.nickname as string) ?? "unknown";
          const comment = (e.data.comment as string) ?? "";
          console.log(`[listeners][chat] ${nickname}: ${comment}`);
        }
      })
    );
  }

  onDisable(_ctx: PluginContext): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  onUnload(_ctx: PluginContext): void {
    this.onDisable(_ctx);
  }
}

const listeners = new EventListenersPlugin();
export default listeners;
