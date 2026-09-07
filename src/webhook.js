const crypto = require("node:crypto");

class WebhookClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  async send(record) {
    if (!this.config.enabled) return { delivered: false, reason: "disabled" };
    if (!this.config.url) return { delivered: false, reason: "url_missing" };

    const payload = buildWebhookPayload(record);
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "X-Position-Tracker-Event": "position_change",
      "X-Wangcai-Event": "position_change"
    };
    if (this.config.secret) {
      headers[this.config.signatureHeader || "X-Signature-256"] = buildWebhookSignature(
        this.config.secret,
        body,
        this.config.signatureTemplate
      );
    }

    await deliverWithRetry(this.config, body, headers, this.fetchImpl);
    return { delivered: true };
  }
}

function buildWebhookPayload(record) {
  return {
    event: "position_change",
    recordId: record.id,
    generatedAt: record.generatedAt,
    trackingAccount: {
      id: record.trackingAccount.id,
      name: record.trackingAccount.name
    },
    subAccount: {
      id: record.subAccount.id,
      name: record.subAccount.name,
      type: record.subAccount.type,
      email: record.subAccount.email || ""
    },
    account: {
      name: record.trackingAccount.name,
      email: record.subAccount.email || "",
      remark: record.subAccount.name
    },
    changes: record.changes.map((change) => ({
      venue: change.venue,
      symbol: change.symbol,
      baseAsset: contractBaseAsset(change.symbol),
      positionSide: change.positionSide,
      deltaQuantity: formatQuantity(change.deltaQuantity),
      targetQuantity: formatQuantity(change.afterQuantity),
      action: derivePositionChangeAction(change.beforeQuantity, change.afterQuantity)
    }))
  };
}

function derivePositionChangeAction(beforeQuantity, afterQuantity) {
  const before = Number(beforeQuantity) || 0;
  const after = Number(afterQuantity) || 0;
  const epsilon = 1e-12;
  const beforeZero = Math.abs(before) < epsilon;
  const afterZero = Math.abs(after) < epsilon;
  if (beforeZero && after > 0) return "open_long";
  if (beforeZero && after < 0) return "open_short";
  if (afterZero && before > 0) return "close_long";
  if (afterZero && before < 0) return "close_short";
  if (before > 0 && after > 0) return after > before ? "increase_long" : "decrease_long";
  if (before < 0 && after < 0) return after < before ? "increase_short" : "decrease_short";
  if (before > 0 && after < 0) return "flip_long_to_short";
  if (before < 0 && after > 0) return "flip_short_to_long";
  return "unknown";
}

function contractBaseAsset(symbol) {
  const value = String(symbol || "").toUpperCase();
  const perpetual = value.replace(/_PERP$/, "");
  const dated = perpetual.replace(/_\d{6}$/, "");
  for (const quote of ["USDT", "USDC", "BUSD", "USD"]) {
    if (dated.endsWith(quote) && dated.length > quote.length) return dated.slice(0, -quote.length);
  }
  return dated;
}

function formatQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) < 1e-12) return "0";
  if (Math.abs(number) >= 1e21) return String(number);
  return number.toFixed(12).replace(/\.?0+$/, "");
}

function buildWebhookSignature(secret, body, template) {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const pattern = template && (template.includes("<hex>") || template.includes("<HEX>"))
    ? template
    : "<hex>";
  return pattern.replaceAll("<hex>", hex).replaceAll("<HEX>", hex.toUpperCase());
}

async function deliverWithRetry(config, body, headers, fetchImpl) {
  const attempts = Math.max(1, Number(config.maxAttempts) || 1);
  const backoffMs = Math.max(10, Number(config.backoffMs) || 1000);
  const timeoutMs = Math.max(1000, Number(config.timeoutMs) || 15000);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(config.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Webhook 响应异常：HTTP ${response.status} ${response.statusText || ""}`.trim());
      return;
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error(`Webhook 请求超时（${timeoutMs}ms）。`) : error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

module.exports = {
  WebhookClient,
  buildWebhookPayload,
  buildWebhookSignature,
  contractBaseAsset,
  derivePositionChangeAction,
  formatQuantity
};
