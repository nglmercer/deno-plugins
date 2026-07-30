// scripts/chat-logger.js
// Runs inside the napi-vm sandbox. `on`, `emit`, and `log` are injected globals.

// Log every chat message from any platform
on("*:chat", "handleChat");

function handleChat(event) {
  var user = event.data.nickname || event.data.user || "unknown";
  var msg  = event.data.comment || event.data.message || "";
  log("[" + event.platform + "] " + user + ": " + msg);
}
