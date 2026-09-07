const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { normalizeConfig } = require("../src/config");
const { PositionTracker, buildScopeKey, diffPositionMaps } = require("../src/tracker");
const {
  buildWebhookPayload,
  buildWebhookSignature,
  derivePositionChangeAction
} = require("../src/webhook");

test("配置支持多个 API 账户和每个账户多个子账户", () => {
  const config = normalizeConfig({
    accounts: [
      {
        id: "account-a",
        name: "账户 A",
        apiKeyEnv: "A_KEY",
        apiSecretEnv: "A_SECRET",
        subAccounts: [
          { id: "a-master", name: "A 主账户", type: "master", markets: ["usdm"] },
          { id: "a-sub", name: "A 子账户", email: "a@example.com", markets: ["usdm", "coinm"] }
        ]
      },
      {
        id: "account-b",
        name: "账户 B",
        apiKeyEnv: "B_KEY",
        apiSecretEnv: "B_SECRET",
        discoverSubAccounts: true,
        subAccounts: []
      }
    ]
  }, {
    projectDir: process.cwd(),
    env: {
      A_KEY: "test-key-a",
      A_SECRET: "test-secret-a",
      B_KEY: "test-key-b",
      B_SECRET: "test-secret-b"
    }
  });

  assert.equal(config.accounts.length, 2);
  assert.equal(config.accounts[0].subAccounts.length, 2);
  assert.deepEqual(config.accounts[0].subAccounts[1].markets, ["usdm", "coinm"]);
  assert.equal(config.accounts[1].discoverSubAccounts, true);
});

test("未激活的已移除范围不会被误判为清仓", () => {
  const activeScope = buildScopeKey("account-a", "active-sub");
  const removedScope = buildScopeKey("account-a", "removed-sub");
  const before = new Map([
    ["active", position("active", activeScope, "1")],
    ["removed", position("removed", removedScope, "5")]
  ]);
  const after = new Map([["active", position("active", activeScope, "2")]]);
  const changes = diffPositionMaps(before, after, new Set([activeScope]));

  assert.equal(changes.length, 1);
  assert.equal(changes[0].symbol, "active");
  assert.equal(changes[0].deltaQuantity, 1);
});

test("扫描建立基线后按子账户分组，并在记录中保留跟踪账户名称", async () => {
  const account = {
    id: "strategy-a",
    name: "策略账户 A",
    subAccounts: [
      { id: "sub-1", name: "一号子账户", type: "sub", email: "one@example.com", markets: ["usdm"] },
      { id: "sub-2", name: "二号子账户", type: "sub", email: "two@example.com", markets: ["usdm"] }
    ],
    discoverSubAccounts: false
  };
  const state = {
    "sub-1": [{ venue: "USD-M Futures", symbol: "BTCUSDT", positionSide: "BOTH", quantity: "1" }],
    "sub-2": []
  };
  const storage = new MemoryStorage();
  const delivered = [];
  const times = [new Date("2026-08-28T00:00:00.000Z"), new Date("2026-08-28T00:05:00.000Z")];
  const tracker = new PositionTracker({ accounts: [account] }, {
    storage,
    webhook: { send: async (record) => { delivered.push(record); return { delivered: true }; } },
    clientFactory: () => ({ fetchPositions: async (scope) => state[scope.id] }),
    now: () => times.shift()
  });

  const first = await tracker.scan();
  assert.equal(first.reason, "baseline_established");
  assert.equal(delivered.length, 0);

  state["sub-1"] = [{ venue: "USD-M Futures", symbol: "BTCUSDT", positionSide: "BOTH", quantity: "2" }];
  state["sub-2"] = [{ venue: "USD-M Futures", symbol: "ETHUSDT", positionSide: "SHORT", quantity: "-3" }];
  const second = await tracker.scan();

  assert.equal(second.changeCount, 2);
  assert.equal(second.records.length, 2);
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every((record) => record.trackingAccount.name === "策略账户 A"));
  assert.deepEqual(delivered.map((record) => record.subAccount.name).sort(), ["一号子账户", "二号子账户"]);
});

test("Webhook 消息包含账户名称、动作和可验证签名", () => {
  const record = {
    id: "record-1",
    generatedAt: "2026-08-28T00:05:00.000Z",
    trackingAccount: { id: "strategy-a", name: "策略账户 A" },
    subAccount: { id: "sub-1", name: "一号子账户", type: "sub", email: "one@example.com" },
    changes: [{
      venue: "USD-M Futures",
      symbol: "BTCUSDT",
      positionSide: "BOTH",
      beforeQuantity: 1,
      afterQuantity: -2,
      deltaQuantity: -3
    }]
  };
  const payload = buildWebhookPayload(record);
  const body = JSON.stringify(payload);
  const expected = crypto.createHmac("sha256", "secret").update(body).digest("hex");

  assert.equal(payload.trackingAccount.name, "策略账户 A");
  assert.equal(payload.subAccount.name, "一号子账户");
  assert.equal(payload.account.name, "策略账户 A");
  assert.equal(payload.changes[0].action, "flip_long_to_short");
  assert.equal(buildWebhookSignature("secret", body, "sha256=<hex>"), `sha256=${expected}`);
});

test("仓位动作覆盖开仓、减仓、平仓和反向", () => {
  assert.equal(derivePositionChangeAction(0, 1), "open_long");
  assert.equal(derivePositionChangeAction(3, 2), "decrease_long");
  assert.equal(derivePositionChangeAction(-3, -5), "increase_short");
  assert.equal(derivePositionChangeAction(-3, 0), "close_short");
  assert.equal(derivePositionChangeAction(-3, 2), "flip_short_to_long");
});

function position(symbol, scopeKey, quantity) {
  return {
    scopeKey,
    trackingAccountId: "account-a",
    trackingAccountName: "账户 A",
    subAccountId: scopeKey,
    subAccountName: scopeKey,
    subAccountType: "sub",
    subAccountEmail: "test@example.com",
    venue: "USD-M Futures",
    symbol,
    positionSide: "BOTH",
    quantity
  };
}

class MemoryStorage {
  constructor() {
    this.baseline = null;
    this.records = [];
  }

  loadBaseline() {
    return this.baseline;
  }

  saveBaseline(value) {
    this.baseline = structuredClone(value);
  }

  appendRecord(value) {
    this.records.push(structuredClone(value));
  }
}
