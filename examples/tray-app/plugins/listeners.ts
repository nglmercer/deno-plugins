import type { IPlugin, PluginContext } from "../../../mod.ts";
import type { EventBusPluginType } from "./event-bus.ts";

class eventlisteners implements IPlugin {
  readonly metadata = {
    name: "listeners",
    version: "1.0.0",
    emits: ["system"] as const,
    listens: ["tiktok", "agent", "memory", "context"] as const,
  };

  setup(_ctx: PluginContext): void {}

  onEnable(ctx: PluginContext): void {
    const bus = ctx.getPlugin<EventBusPluginType>("event-bus");

    if (bus) {
      bus.onPlatform("tiktok", (e) => {
        if (e.eventName === "chat") {
          const data = e.data;
          const nickname = (data.nickname as string) ?? "unknown";
          const comment = (data.comment as string) ?? "";
          console.log(`[listeners][chat] ${nickname}: ${comment}`);
        }
      });
    }
  }

  onDisable(_ctx: PluginContext): void {}

  onUnload(_ctx: PluginContext): void {}
}

const listeners = new eventlisteners();
export default listeners;
