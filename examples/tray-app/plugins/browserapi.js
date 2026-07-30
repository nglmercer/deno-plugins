// @bun
var __require = import.meta.require;

// src/constants.ts
var PLATFORMS = {
  YOUTUBE: "youtube",
  TWITCH: "twitch",
  TIKTOK: "tiktok",
  KICK: "kick",
  SYSTEM: "system"
};
var TIKTOK_CONSTANTS = {
  WEBSOCKET_URL: "wss://tikfinity-cws-04.zerody.one/socket.io/",
  WEBSOCKET_PARAMS: "?EIO=4&transport=websocket",
  PAYLOAD_PREFIX: "TikFinity_PAYLOAD:",
  EVENT_PREFIX: "TikFinity_EVENT:",
  EVENT_LOGGED: "tikfinity_logged",
  EVENT_MESSAGE: "tikfinity_msg",
  ENGINE_IO_MESSAGE: "40",
  PING_MESSAGE: "2",
  PONG_MESSAGE: "3",
  SOCKET_IO_DATA_PREFIX: "42"
};
var LOG_MESSAGES = {
  WEBVIEW: {
    CLOSED: "closed webview process",
    ERROR: "error webview",
    ON_UNLOAD: "on unload plugin",
    STARTED: "started webview process",
    CLOSING: "closing webview process"
  },
  PLUGIN: {
    LOADING: "loading tikfinity plugin...",
    RELOADING: "reloading tikfinity plugin..."
  },
  WEBSOCKET: {
    ALREADY_OPEN: "ws already open",
    OPEN: "ws open",
    PAYLOAD_SENT: "socket.send(this.payload)",
    MAX_RECONNECT: "Max reconnect attempts reached",
    MANUAL_CLOSE: "Manual close",
    DISCONNECTED: "WebSocket disconnected manually",
    UPDATING_PAYLOAD: "Updating payload (changing channel)...",
    NEW_PAYLOAD_SENT: "New payload sent",
    NOT_CONNECTED: "WebSocket not connected, starting new connection...",
    CONNECTING: (attempt) => `Attempting to connect... (attempt ${attempt})`,
    RECONNECTING: (delay, attempt, maxAttempts) => `Reconnecting in ${Math.round(delay)}ms... (attempt ${attempt}/${maxAttempts})`
  },
  TIKFINITY: {
    CONNECTION_EXISTS: "Existing connection detected, updating channel...",
    CLOSING_WS: "Closing WebSocket connection...",
    RESETTING: "Resetting TikFinity client for reload...",
    RECONNECTING_EXISTING: "Reconnecting with existing payload...",
    RECONNECTING_FRESH: "No existing payload, starting fresh connection...",
    RECONNECTING: "Reconnecting TikFinity...",
    CLOSING_FOR_PAYLOAD: "Closing previous WS connection for new payload..."
  },
  PLAYLIST: {
    OPERATION_IN_PROGRESS: "Operation in progress, skipping duplicate call",
    NO_TRACKS: "No tracks loaded",
    LOADING_TRACKS: (count) => `Loading ${count} tracks into playlist...`,
    LOADED_TRACKS: (count) => `Loaded ${count} valid tracks`,
    ADDED_TRACK: (total) => `Added track. Total: ${total}`,
    PLAYING_TRACK: (current, total, label) => `Playing track ${current}/${total}: ${label}`,
    EMPTY_TRACK_PATH: "Empty string track path",
    EMPTY_BUFFER: "Buffer track is empty",
    INVALID_FORMAT: "Invalid track format",
    PLAYBACK_ERROR: "Failed to play track:",
    LOOPING: "Looping playlist",
    END_OF_PLAYLIST: "End of playlist reached",
    PAUSED: "Paused",
    RESUMED: "Resumed",
    STOPPED: "Stopped",
    STOP_ERROR: "Error stopping player:",
    LOOP_MODE: (enabled) => `Loop mode: ${enabled ? "ON" : "OFF"}`,
    DISPOSED: "Playlist resources disposed",
    MONITOR_ERROR: "[Monitor] Error checking player state:",
    TIMEOUT_WAITING: "Timeout waiting for idle",
    INVALID_INDEX: (index) => `Invalid track index: ${index}`
  },
  TTS: {
    INITIALIZING_STORAGE: (pluginName, key) => `[${pluginName}] Initializing storage for key: ${key}`,
    CONFIG_LOADED: "[TTSPlugin] Config loaded:",
    LAST_MESSAGE: (msg) => `[TTSPlugin] Last processed message: ${msg}`
  },
  SHUTDOWN: `

Shutting down...`
};
var PATHS = {
  RULES_DIR: "rules",
  PLUGINS_DIR: "plugins",
  SCRIPTS_DIR: "webview",
  OUTPUT_DIR: "./output",
  TIKFINITY_WEBVIEW_TS: "webview/tikfinity-webview.ts"
};
var TIKFINITY_EVENTS = {
  EVENT: "event",
  CHAT: "chat",
  PAYLOAD: "payload"
};
var TIMING = {
  RECONNECT_DELAY: 1000,
  MAX_RECONNECT_DELAY: 30000,
  PAYLOAD_SEND_DELAY: 500,
  TRANSITION_DELAY: 100,
  NEXT_TRACK_DELAY: 50,
  IDLE_TIMEOUT: 1000,
  MONITOR_INTERVAL: 500,
  WAIT_FOR_IDLE_TIMEOUT: 5000
};
var WS_CONSTANTS = {
  MAX_RECONNECT_ATTEMPTS: 10,
  CLOSE_CODE_NORMAL: 1000,
  READY_STATE_OPEN: 1
};

// src/utils/parsejson.ts
function parseSocketIo42Message(message, keys) {
  if (!message || !message.startsWith(TIKTOK_CONSTANTS.SOCKET_IO_DATA_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(message.substring(TIKTOK_CONSTANTS.SOCKET_IO_DATA_PREFIX.length));
    if (Array.isArray(parsed) && parsed.length >= 1) {
      const eventKey = keys?.event ?? "eventName";
      const dataKey = keys?.data ?? "data";
      return {
        [eventKey]: parsed[0],
        [dataKey]: parsed.length > 1 ? parsed[1] : null
      };
    }
  } catch (error) {
    console.error("Error parsing Socket.io message:", error);
  }
  return null;
}
function SocketIoMessage(message) {
  if (!message || message.length < 1)
    return null;
  const engineType = message[0];
  const socketType = engineType === "4" /* MESSAGE */ ? message[1] : undefined;
  const payloadOffset = engineType === "4" /* MESSAGE */ ? 2 : 1;
  const payloadRaw = message.substring(payloadOffset);
  return {
    engineType,
    socketType,
    isData: message.startsWith(TIKTOK_CONSTANTS.SOCKET_IO_DATA_PREFIX),
    payloadRaw
  };
}

// src/utils/filepath.ts
import * as fs from "fs";
import * as path from "path";
function getBaseDir() {
  const candidates = [];
  try {
    let currentFilePath = new URL(import.meta.url).pathname;
    if (currentFilePath) {
      candidates.push(path.dirname(currentFilePath));
      candidates.push(path.dirname(path.dirname(currentFilePath)));
    }
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    candidates.push(currentDir);
    candidates.push(path.dirname(currentDir));
  } catch (e) {}
  const execPath = process.execPath;
  const isBunRuntime = execPath.includes("/bun") || execPath.includes("\\bun");
  if (!isBunRuntime) {
    candidates.push(path.dirname(execPath));
  }
  candidates.push(process.cwd());
  try {
    if (__require.main && __require.main.filename) {
      candidates.push(path.dirname(__require.main.filename));
    }
  } catch (e) {}
  const uniqueCandidates = [...new Set(candidates.filter((c) => c && fs.existsSync(c)))];
  for (const cand of uniqueCandidates) {
    if (fs.existsSync(path.join(cand, "webview"))) {
      return cand;
    }
  }
  for (const cand of uniqueCandidates) {
    if (fs.existsSync(path.join(cand, "package.json"))) {
      return cand;
    }
  }
  return uniqueCandidates[0] || process.cwd();
}
async function findInRoots(relativePaths) {
  const baseDir = getBaseDir();
  const pathsToCheck = Array.isArray(relativePaths) ? relativePaths : [relativePaths];
  for (const relPath of pathsToCheck) {
    const fullPath = path.resolve(baseDir, relPath);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  for (const relPath of pathsToCheck) {
    if (path.isAbsolute(relPath) && fs.existsSync(relPath)) {
      return relPath;
    }
  }
  const cwd = process.cwd();
  if (cwd !== baseDir) {
    for (const relPath of pathsToCheck) {
      const fullPath = path.resolve(cwd, relPath);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

// src/client/index.ts
import { EventEmitter } from "events";
import { spawn } from "child_process";

// src/utils/websocket.ts
class TikTokWebSocket {
  socket = null;
  payload;
  emitter;
  options;
  reconnectAttempts = 0;
  reconnectTimer = null;
  isManuallyClosed = false;
  iomsg = TIKTOK_CONSTANTS.ENGINE_IO_MESSAGE;
  constructor(payload, emitter, options = {}) {
    this.payload = payload;
    this.emitter = emitter;
    this.options = {
      reconnect: options.reconnect ?? true,
      maxReconnectAttempts: options.maxReconnectAttempts ?? WS_CONSTANTS.MAX_RECONNECT_ATTEMPTS,
      reconnectDelay: options.reconnectDelay ?? TIMING.RECONNECT_DELAY,
      maxReconnectDelay: options.maxReconnectDelay ?? TIMING.MAX_RECONNECT_DELAY,
      logger: options.logger ?? console.log
    };
  }
  openResolve = null;
  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.options.logger(LOG_MESSAGES.WEBSOCKET.ALREADY_OPEN);
      return Promise.resolve();
    }
    this.isManuallyClosed = false;
    this.options.logger(LOG_MESSAGES.WEBSOCKET.CONNECTING(this.reconnectAttempts + 1));
    return new Promise((resolve2) => {
      this.openResolve = resolve2;
      this.socket = new WebSocket(`${TIKTOK_CONSTANTS.WEBSOCKET_URL}${TIKTOK_CONSTANTS.WEBSOCKET_PARAMS}`);
      this.socket.onopen = () => {
        this.options.logger(LOG_MESSAGES.WEBSOCKET.OPEN);
        this.reconnectAttempts = 0;
        if (this.openResolve) {
          this.openResolve();
          this.openResolve = null;
        }
      };
      this.socket.onmessage = (event) => {
        this.emitter?.(event.data);
        const dataStr = String(event.data);
        if (dataStr === TIKTOK_CONSTANTS.PING_MESSAGE) {
          this.socket?.send(TIKTOK_CONSTANTS.PONG_MESSAGE);
        } else if (dataStr.startsWith("0{")) {
          this.socket?.send(this.iomsg);
        } else if (dataStr.startsWith("40")) {
          this.socket?.send(this.payload);
          this.options.logger(LOG_MESSAGES.WEBSOCKET.PAYLOAD_SENT);
        }
      };
      this.socket.onerror = (error) => {
        this.options.logger("wsError: " + JSON.stringify(error));
      };
      this.socket.onclose = (event) => {
        this.options.logger("closed: " + JSON.stringify(event));
        this.socket = null;
        if (this.openResolve) {
          this.openResolve();
          this.openResolve = null;
        }
        if (!this.isManuallyClosed && this.options.reconnect) {
          this.scheduleReconnect();
        }
      };
    });
  }
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.options.logger(LOG_MESSAGES.WEBSOCKET.MAX_RECONNECT);
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.options.maxReconnectDelay);
    const jitter = Math.random() * 1000;
    const finalDelay = delay + jitter;
    this.options.logger(LOG_MESSAGES.WEBSOCKET.RECONNECTING(finalDelay, this.reconnectAttempts, this.options.maxReconnectAttempts));
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, finalDelay);
  }
  disconnect() {
    this.isManuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close(WS_CONSTANTS.CLOSE_CODE_NORMAL, LOG_MESSAGES.WEBSOCKET.MANUAL_CLOSE);
      this.socket = null;
    }
    this.options.logger(LOG_MESSAGES.WEBSOCKET.DISCONNECTED);
  }
  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  updatePayload(newPayload) {
    this.payload = newPayload;
    if (this.isConnected()) {
      this.options.logger(LOG_MESSAGES.WEBSOCKET.UPDATING_PAYLOAD);
      this.socket?.send(newPayload);
      this.options.logger(LOG_MESSAGES.WEBSOCKET.NEW_PAYLOAD_SENT);
    } else {
      this.options.logger(LOG_MESSAGES.WEBSOCKET.NOT_CONNECTED);
      this.connect();
    }
  }
}
async function connect(payload, emitter, options) {
  const ws = new TikTokWebSocket(payload, emitter, options);
  await ws.connect();
  return ws;
}

// src/client/index.ts
import * as path2 from "path";
async function getWebviewScriptPath() {
  const scriptName = path2.basename(PATHS.TIKFINITY_WEBVIEW_TS);
  const scriptNameJs = scriptName.replace(/\.ts$/, ".js");
  const candidates = [
    `webview/${scriptNameJs}`,
    scriptNameJs,
    PATHS.TIKFINITY_WEBVIEW_TS,
    scriptName,
    (() => {
      try {
        const currentDir = path2.dirname(new URL(import.meta.url).pathname);
        if (currentDir)
          return path2.join(currentDir, "..", "..", PATHS.TIKFINITY_WEBVIEW_TS);
      } catch (e) {}
      return "";
    })()
  ].filter(Boolean);
  const foundPath = await findInRoots(candidates);
  if (foundPath) {
    return foundPath;
  }
  const baseDir = getBaseDir();
  throw new Error(`Webview script not found. For bundled executable, ensure 'webview/tikfinity-webview.ts' is included.
` + `Looked for these files:
${candidates.map((c) => `  - ${c}`).join(`
`)}
` + `Base directory identified as: ${baseDir}`);
}
function getRuntimeCommand(scriptPath) {
  const execPath = process.execPath;
  const isBun = execPath.includes("/bun") || execPath.includes("\\bun");
  const isDeno = execPath.includes("/deno") || execPath.includes("\\deno");
  if (isBun) {
    return { cmd: "bun", args: ["run", scriptPath] };
  }
  if (isDeno) {
    return { cmd: "deno", args: ["run", "--allow-all", scriptPath] };
  }
  return { cmd: "node", args: [scriptPath] };
}

class TikFinityClient extends EventEmitter {
  webviewProcess = null;
  wsConnection = null;
  currentPayload = null;
  options = {};
  logger = console.log;
  connectionResolve = null;
  connectPromise = null;
  killingProcess = null;
  constructor(options = {}) {
    super();
    this.options = options;
    if (options.logger) {
      this.logger = options.logger;
    } else if (options.debug) {
      this.logger = (msg, ...args) => console.log(`[TikFinity]`, msg, ...args);
    }
  }
  waitForConnection(timeoutMs = 60000) {
    if (this.wsConnection?.isConnected())
      return Promise.resolve();
    return new Promise((resolve2, reject) => {
      this.connectionResolve = resolve2;
      const timer = setTimeout(() => {
        this.connectionResolve = null;
        reject(new Error("Timed out waiting for WebSocket connection"));
      }, timeoutMs);
      const original = this.connectionResolve;
      this.connectionResolve = () => {
        clearTimeout(timer);
        original();
      };
    });
  }
  async connect(options) {
    if (this.webviewProcess && this.wsConnection?.isConnected()) {
      this.logger(LOG_MESSAGES.WEBVIEW.STARTED);
      return;
    }
    if (this.webviewProcess) {
      return this.waitForConnection();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (options) {
      this.options = { ...this.options, ...options };
      if (options.logger) {
        this.logger = options.logger;
      } else if (options.debug && !this.options.logger) {
        this.logger = (msg, ...args) => console.log(`[TikFinity]`, msg, ...args);
      }
    }
    this.connectPromise = this.spawnWebview();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }
  async spawnWebview() {
    if (this.killingProcess) {
      await new Promise((resolve2) => {
        const proc2 = this.killingProcess;
        if (!proc2 || proc2.exitCode !== null) {
          resolve2();
          return;
        }
        const timer = setTimeout(() => {
          try {
            proc2.kill("SIGKILL");
          } catch (_) {}
          resolve2();
        }, 3000);
        proc2.on("exit", () => {
          clearTimeout(timer);
          resolve2();
        });
      });
      this.killingProcess = null;
    }
    if (this.webviewProcess) {
      return this.waitForConnection();
    }
    this.logger(LOG_MESSAGES.WEBVIEW.STARTED);
    const webviewScriptPath = await getWebviewScriptPath();
    this.logger(`Using webview script: ${webviewScriptPath}`);
    const runtime = getRuntimeCommand(webviewScriptPath);
    const proc = spawn(runtime.cmd, runtime.args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      env: { ...process.env }
    });
    this.webviewProcess = proc;
    proc.stdout?.on("data", (data) => {
      const output = data.toString();
      if (output.includes(TIKTOK_CONSTANTS.PAYLOAD_PREFIX)) {
        const lines = output.split(`
`);
        let payload = "";
        for (const line of lines) {
          if (line.includes(TIKTOK_CONSTANTS.PAYLOAD_PREFIX)) {
            payload = line.split(TIKTOK_CONSTANTS.PAYLOAD_PREFIX)[1].trim();
          } else if (line.trim()) {
            this.logger(TIKTOK_CONSTANTS.EVENT_MESSAGE, line.trim());
          }
        }
        if (!payload || this.currentPayload === payload) {
          return;
        }
        this.currentPayload = payload;
        this.emit(TIKFINITY_EVENTS.PAYLOAD, payload);
        if (this.wsConnection) {
          this.logger(LOG_MESSAGES.TIKFINITY.CLOSING_FOR_PAYLOAD);
          this.wsConnection.disconnect();
          this.wsConnection = null;
        }
        connect(payload, (message) => {
          this.handleMessage(message);
        }, {
          reconnect: this.options.autoReconnect ?? true,
          maxReconnectAttempts: this.options.maxReconnectAttempts,
          reconnectDelay: this.options.reconnectDelay,
          maxReconnectDelay: this.options.maxReconnectDelay,
          logger: this.logger
        }).then((ws) => {
          this.wsConnection = ws;
          if (this.connectionResolve) {
            this.connectionResolve();
            this.connectionResolve = null;
          }
        });
      } else {
        this.logger(TIKTOK_CONSTANTS.EVENT_MESSAGE, output.trim());
      }
    });
    proc.stderr?.on("data", (data) => {
      console.error(LOG_MESSAGES.WEBVIEW.ERROR, data.toString());
    });
    proc.on("close", (code) => {
      this.logger(LOG_MESSAGES.WEBVIEW.CLOSED, code);
      if (this.webviewProcess === proc) {
        this.webviewProcess = null;
      }
    });
    proc.on("error", (error) => {
      console.error(LOG_MESSAGES.WEBVIEW.ERROR, error);
      if (this.webviewProcess === proc) {
        this.webviewProcess = null;
      }
    });
    return this.waitForConnection();
  }
  handleMessage(message) {
    const info = SocketIoMessage(message);
    if (!message || !info)
      return;
    if (info.engineType?.length !== 1) {}
    const data = parseSocketIo42Message(message);
    if (!data || !data.eventName)
      return;
    const eventName = data.eventName;
    const eventData = data?.data || message;
    this.emit(TIKFINITY_EVENTS.EVENT, { eventName, data: eventData });
    this.sendEventToWebview(eventName, eventData);
  }
  sendEventToWebview(eventName, data) {
    if (this.webviewProcess?.stdin) {
      const eventPayload = JSON.stringify({ eventName, data });
      this.webviewProcess.stdin?.write(`${TIKTOK_CONSTANTS.EVENT_PREFIX}${eventPayload}
`);
    }
  }
  disconnect() {
    if (this.wsConnection) {
      console.log(LOG_MESSAGES.TIKFINITY.CLOSING_WS);
      this.wsConnection.disconnect();
      this.wsConnection = null;
    }
  }
  clean() {
    this.disconnect();
    if (this.webviewProcess) {
      this.logger(LOG_MESSAGES.WEBVIEW.CLOSING);
      const proc = this.webviewProcess;
      this.webviewProcess = null;
      this.killingProcess = proc;
      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.write(`TikFinity_EXIT
`);
        }
      } catch (e) {
        proc.kill("SIGKILL");
        this.killingProcess = null;
        this.currentPayload = null;
        this.removeAllListeners();
        return;
      }
      const killTimeout = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch (_) {}
      }, 2000);
      proc.on("exit", () => {
        clearTimeout(killTimeout);
        if (this.killingProcess === proc) {
          this.killingProcess = null;
        }
      });
    }
    this.currentPayload = null;
    this.removeAllListeners();
  }
  reset() {
    console.log(LOG_MESSAGES.TIKFINITY.RESETTING);
    this.disconnect();
    this.removeAllListeners();
  }
  async reinitialize() {
    if (this.currentPayload) {
      this.logger(LOG_MESSAGES.TIKFINITY.RECONNECTING_EXISTING);
      const ws = await connect(this.currentPayload, (message) => {
        this.handleMessage(message);
      });
      this.wsConnection = ws;
    } else {
      this.logger(LOG_MESSAGES.TIKFINITY.RECONNECTING_FRESH);
      await this.connect();
    }
  }
  reconnect() {
    this.logger(LOG_MESSAGES.TIKFINITY.RECONNECTING);
    this.disconnect();
    if (this.currentPayload) {
      connect(this.currentPayload, (message) => {
        this.handleMessage(message);
      }).then((ws) => {
        this.wsConnection = ws;
      });
    } else {
      this.connect();
    }
  }
}

// src/index.ts
var client = new TikFinityClient;
var eventHandler = null;
var tikfinityClient = client;
function createTikFinityClient(options) {
  return new TikFinityClient(options);
}
var requireVersion = "1.0.1";

class TikfinityPlugin {
  metadata = {
    name: "tikfinity",
    version: requireVersion,
    description: "TikFinity Plugin for TikTok"
  };
  defaultConfig = {
    reinitialize: true,
    payload: false
  };
  async onLoad(context) {
    const info = console.log;
    info(LOG_MESSAGES.PLUGIN.LOADING);
    eventHandler = (payload) => {
      const emitter = context.getPlugin("event-emitter");
      const { on, emit } = emitter ?? {};
      if (emit && typeof emit === "function") {
        emit(PLATFORMS.TIKTOK, payload);
      } else {
        info(`[${PLATFORMS.TIKTOK}]`, payload);
      }
    };
    client.on(TIKFINITY_EVENTS.EVENT, eventHandler);
    client.on(TIKFINITY_EVENTS.PAYLOAD, async (payload) => {
      if (!payload)
        return;
      this.defaultConfig.payload = payload;
    });
    await client.connect();
  }
  async onReload(context) {
    const info = console.log;
    info(LOG_MESSAGES.PLUGIN.RELOADING);
    if (eventHandler) {
      client.off(TIKFINITY_EVENTS.EVENT, eventHandler);
    }
    client.reset();
    eventHandler = (payload) => {
      const emitter = context.getPlugin("event-emitter");
      const { on, emit } = emitter ?? {};
      if (emit && typeof emit === "function") {
        emit(PLATFORMS.TIKTOK, payload);
      } else {
        console.log(`[${PLATFORMS.TIKTOK}]`, payload);
      }
    };
    client.on(TIKFINITY_EVENTS.EVENT, eventHandler);
    if (this.defaultConfig.reinitialize && this.defaultConfig.payload) {
      await client.reinitialize();
    }
  }
  async onUnload() {
    console.log(LOG_MESSAGES.WEBVIEW.ON_UNLOAD);
    if (eventHandler) {
      client.off(TIKFINITY_EVENTS.EVENT, eventHandler);
      eventHandler = null;
    }
    client.clean();
    await new Promise((resolve2) => setTimeout(resolve2, 200));
  }
}
function isMainModule() {
  try {
    if (typeof import.meta.main === "boolean")
      return import.meta.main;
  } catch {}
  if (typeof process !== "undefined" && process.argv[1]) {
    try {
      return process.argv[1] === new URL(import.meta.url).pathname;
    } catch {}
  }
  return false;
}
if (isMainModule()) {
  const defaultTimes = {
    reconnect: 30000
  };
  const customClient = new TikFinityClient({
    autoReconnect: true,
    maxReconnectAttempts: 5,
    reconnectDelay: defaultTimes.reconnect,
    debug: true,
    logger: (msg, ...args) => console.log(`[Custom]`, msg, ...args)
  });
  customClient.on(TIKFINITY_EVENTS.EVENT, (payload) => {
    const p = payload;
    if (p?.eventName === TIKFINITY_EVENTS.CHAT && p?.data?.comment) {
      console.log(p.data.comment);
    }
    console.log(`[${PLATFORMS.TIKTOK} Event]:`, p?.eventName);
  });
  console.log("Connecting with custom options...");
  await customClient.connect().catch(console.error);
  await new Promise((resolver) => setTimeout(resolver, defaultTimes.reconnect));
  console.log("Disconnecting...");
  customClient.disconnect();
  await new Promise((resolver) => setTimeout(resolver, 15000));
  console.log("Cleaning up...");
  customClient.clean();
}
export {
  tikfinityClient,
  TikfinityPlugin as default,
  createTikFinityClient,
  TikFinityClient
};
