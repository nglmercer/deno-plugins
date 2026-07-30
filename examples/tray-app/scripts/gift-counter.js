// scripts/gift-counter.js
// Tracks cumulative gift count per platform and re-emits a summary event.

var totals = {};

on("*:gift", "handleGift");

function handleGift(event) {
  var platform = event.platform;
  log("[gifts] " + platform + " total: ", event.data);

  // Re-emit a summary event back to the host bus
  emit("system", "gift-summary", { platform: platform, total: totals[platform] });
}
