const crypto = require("node:crypto");

class PositionTracker {
  constructor(config, dependencies) {
    this.config = config;
    this.storage = dependencies.storage;
    this.webhook = dependencies.webhook;
    this.clientFactory = dependencies.clientFactory;
    this.now = dependencies.now || (() => new Date());
    this.scanning = false;
  }

  async scan() {
    if (this.scanning) return { skipped: true, reason: "scan_in_progress" };
    this.scanning = true;
    try {
      const generatedAt = this.now().toISOString();
      const { positions: after, activeScopes } = await this.fetchCurrentPositions();
      const baseline = this.storage.loadBaseline();
      if (!baseline) {
        this.storage.saveBaseline(buildBaseline(generatedAt, after));
        return { skipped: true, reason: "baseline_established", positionCount: after.size };
      }

      const before = new Map(Object.entries(baseline.positions || {}));
      const changes = diffPositionMaps(before, after, activeScopes);
      const preservedInactive = [...before.entries()].filter(([, item]) => !activeScopes.has(item.scopeKey));
      const nextPositions = new Map([...preservedInactive, ...after.entries()]);
      const records = buildChangeRecords(changes, generatedAt);

      for (const record of records) this.storage.appendRecord(record);
      this.storage.saveBaseline(buildBaseline(generatedAt, nextPositions));

      const webhookResults = [];
      for (const record of records) {
        try {
          webhookResults.push(await this.webhook.send(record));
        } catch (error) {
          webhookResults.push({ delivered: false, reason: "delivery_failed", error: error.message });
        }
      }

      return {
        skipped: records.length === 0,
        reason: records.length === 0 ? "no_changes" : null,
        changeCount: changes.length,
        records,
        webhookResults
      };
    } finally {
      this.scanning = false;
    }
  }

  async fetchCurrentPositions() {
    const positions = new Map();
    const activeScopes = new Set();
    for (const account of this.config.accounts) {
      const client = this.clientFactory(account);
      const scopes = await resolveScopes(account, client);
      const rowsByScope = await mapLimit(scopes, 4, async (scope) => ({
        scope,
        rows: await client.fetchPositions(scope)
      }));

      for (const { scope, rows } of rowsByScope) {
        const scopeKey = buildScopeKey(account.id, scope.id);
        activeScopes.add(scopeKey);
        for (const row of rows) {
          const key = positionIdentity(account.id, scope.id, row);
          positions.set(key, {
            scopeKey,
            trackingAccountId: account.id,
            trackingAccountName: account.name,
            subAccountId: scope.id,
            subAccountName: scope.name,
            subAccountType: scope.type,
            subAccountEmail: scope.email || "",
            venue: row.venue,
            symbol: row.symbol,
            positionSide: row.positionSide || "BOTH",
            quantity: String(row.quantity)
          });
        }
      }
    }
    return { positions, activeScopes };
  }
}

async function resolveScopes(account, client) {
  const scopes = account.subAccounts.map((item) => ({ ...item }));
  if (!account.discoverSubAccounts) return scopes;

  const byEmail = new Set(
    scopes.filter((item) => item.type === "sub").map((item) => item.email.toLowerCase())
  );
  const discovered = await client.listSubAccounts();
  for (const item of discovered) {
    const email = String(item?.email || "").trim();
    if (!email || byEmail.has(email.toLowerCase())) continue;
    byEmail.add(email.toLowerCase());
    scopes.push({
      id: `auto-${crypto.createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12)}`,
      name: String(item.remark || email).trim(),
      type: "sub",
      email,
      markets: account.discoveredSubAccountMarkets
    });
  }
  return scopes;
}

function diffPositionMaps(before, after, activeScopes) {
  const changes = [];
  const keys = new Set(after.keys());
  for (const [key, item] of before.entries()) {
    if (activeScopes.has(item.scopeKey)) keys.add(key);
  }

  for (const key of keys) {
    const previous = before.get(key);
    const current = after.get(key);
    const beforeQuantity = Number(previous?.quantity || 0);
    const afterQuantity = Number(current?.quantity || 0);
    const deltaQuantity = afterQuantity - beforeQuantity;
    if (Math.abs(deltaQuantity) < 1e-12) continue;
    const info = current || previous;
    changes.push({
      scopeKey: info.scopeKey,
      trackingAccountId: info.trackingAccountId,
      trackingAccountName: info.trackingAccountName,
      subAccountId: info.subAccountId,
      subAccountName: info.subAccountName,
      subAccountType: info.subAccountType,
      subAccountEmail: info.subAccountEmail,
      venue: info.venue,
      symbol: info.symbol,
      positionSide: info.positionSide,
      beforeQuantity,
      afterQuantity,
      deltaQuantity
    });
  }
  return changes.sort((a, b) => `${a.scopeKey}|${a.venue}|${a.symbol}|${a.positionSide}`
    .localeCompare(`${b.scopeKey}|${b.venue}|${b.symbol}|${b.positionSide}`));
}

function buildChangeRecords(changes, generatedAt) {
  const groups = new Map();
  for (const change of changes) {
    if (!groups.has(change.scopeKey)) groups.set(change.scopeKey, []);
    groups.get(change.scopeKey).push(change);
  }
  return [...groups.values()].map((items) => {
    const first = items[0];
    return {
      id: `${Date.parse(generatedAt)}-${crypto.randomBytes(4).toString("hex")}`,
      generatedAt,
      trackingAccount: {
        id: first.trackingAccountId,
        name: first.trackingAccountName
      },
      subAccount: {
        id: first.subAccountId,
        name: first.subAccountName,
        type: first.subAccountType,
        email: first.subAccountEmail
      },
      changes: items.map((item) => ({
        venue: item.venue,
        symbol: item.symbol,
        positionSide: item.positionSide,
        beforeQuantity: item.beforeQuantity,
        afterQuantity: item.afterQuantity,
        deltaQuantity: item.deltaQuantity
      }))
    };
  });
}

function buildBaseline(generatedAt, positions) {
  return {
    version: 1,
    generatedAt,
    positions: Object.fromEntries(positions)
  };
}

function buildScopeKey(accountId, subAccountId) {
  return JSON.stringify([accountId, subAccountId]);
}

function positionIdentity(accountId, subAccountId, row) {
  return JSON.stringify([
    accountId,
    subAccountId,
    row.venue,
    row.symbol,
    row.positionSide || "BOTH"
  ]);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

module.exports = {
  PositionTracker,
  buildChangeRecords,
  buildScopeKey,
  diffPositionMaps,
  positionIdentity,
  resolveScopes
};
