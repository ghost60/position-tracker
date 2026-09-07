const { BinanceClient } = require("./binance-client");
const { loadConfig } = require("./config");
const { FileStorage } = require("./storage");
const { PositionTracker } = require("./tracker");
const { WebhookClient } = require("./webhook");

async function main() {
  const config = loadConfig();
  const storage = new FileStorage(config.dataDir);
  const webhook = new WebhookClient(config.webhook);
  const tracker = new PositionTracker(config, {
    storage,
    webhook,
    clientFactory: (account) => new BinanceClient(account, {
      recvWindow: config.recvWindow,
      signedRequestRetries: config.signedRequestRetries,
      fetchTimeoutMs: config.fetchTimeoutMs
    })
  });

  console.log(
    `[tracker] 已加载 ${config.accounts.length} 个跟踪账户，扫描间隔 ${config.scanIntervalMs}ms。`
  );
  if (!config.webhook.enabled) console.warn("[tracker] Webhook 已禁用。");
  else if (!config.webhook.url) console.warn("[tracker] WEBHOOK_URL 未配置，只记录变化，不发送消息。");

  const run = async () => {
    try {
      const result = await tracker.scan();
      if (result.reason === "baseline_established") {
        console.log(`[tracker] 初始基线已建立，共 ${result.positionCount} 个非零仓位。`);
      } else if (result.reason === "no_changes") {
        console.log(`[tracker] ${new Date().toISOString()} 未发现持仓变化。`);
      } else if (result.reason === "scan_in_progress") {
        console.warn("[tracker] 上一次扫描尚未结束，本轮已跳过。");
      } else {
        const failed = (result.webhookResults || []).filter((item) => item.delivered === false);
        console.log(`[tracker] 发现 ${result.changeCount} 项变化，生成 ${result.records.length} 条记录。`);
        for (const item of failed) console.error(`[tracker] Webhook 未送达：${item.error || item.reason}`);
      }
      return true;
    } catch (error) {
      console.error(`[tracker] 扫描失败，基线未推进：${error.message}`);
      return false;
    }
  };

  const firstRunOk = await run();
  if (process.argv.includes("--once")) {
    if (!firstRunOk) process.exitCode = 1;
    return;
  }

  const timer = setInterval(run, config.scanIntervalMs);
  const shutdown = (signal) => {
    clearInterval(timer);
    console.log(`[tracker] 收到 ${signal}，已停止调度。`);
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[tracker] 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
