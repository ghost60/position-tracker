const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv(filePath, env = process.env) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt < 1) continue;
    const key = trimmed.slice(0, equalsAt).trim();
    let value = trimmed.slice(equalsAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

function loadConfig(projectDir = path.resolve(__dirname, ".."), env = process.env) {
  loadDotEnv(path.join(projectDir, ".env"), env);
  const configuredPath = env.TRACKER_ACCOUNTS_FILE || "config/accounts.json";
  const accountsFile = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectDir, configuredPath);
  if (!fs.existsSync(accountsFile)) {
    throw new Error(
      `账户配置不存在：${accountsFile}。请复制 config/accounts.example.json 为 config/accounts.json。`
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(accountsFile, "utf8"));
  } catch (error) {
    throw new Error(`账户配置 JSON 无法读取：${error.message}`);
  }

  return normalizeConfig(raw, {
    env,
    projectDir,
    accountsFile
  });
}

function normalizeConfig(raw, options = {}) {
  const env = options.env || process.env;
  const projectDir = options.projectDir || path.resolve(__dirname, "..");
  const rawAccounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
  if (!rawAccounts.length) throw new Error("账户配置至少需要一个 accounts 条目。");

  const accountIds = new Set();
  const accounts = rawAccounts.map((account, index) => {
    const id = requiredId(account?.id, `accounts[${index}].id`);
    if (accountIds.has(id)) throw new Error(`账户 id 重复：${id}`);
    accountIds.add(id);

    const name = requiredText(account?.name, `accounts[${index}].name`);
    const apiKeyEnv = requiredText(account?.apiKeyEnv, `${name}.apiKeyEnv`);
    const apiSecretEnv = requiredText(account?.apiSecretEnv, `${name}.apiSecretEnv`);
    const apiKey = String(env[apiKeyEnv] || "").trim();
    const apiSecret = String(env[apiSecretEnv] || "").trim();
    if (!apiKey || !apiSecret) {
      throw new Error(`账户“${name}”缺少环境变量 ${apiKeyEnv} 或 ${apiSecretEnv}。`);
    }

    const subAccounts = normalizeSubAccounts(account.subAccounts, name);
    const discoverSubAccounts = account.discoverSubAccounts === true;
    if (!subAccounts.length && !discoverSubAccounts) {
      throw new Error(`账户“${name}”没有配置 subAccounts，且 discoverSubAccounts 未启用。`);
    }

    return {
      id,
      name,
      apiKey,
      apiSecret,
      discoverSubAccounts,
      discoveredSubAccountMarkets: normalizeMarkets(
        account.discoveredSubAccountMarkets,
        `${name}.discoveredSubAccountMarkets`
      ),
      subAccounts,
      baseUrl: textOrDefault(account.baseUrl, env.BINANCE_BASE_URL, "https://api.binance.com"),
      fapiBaseUrl: textOrDefault(account.fapiBaseUrl, env.BINANCE_FAPI_BASE_URL, "https://fapi.binance.com"),
      dapiBaseUrl: textOrDefault(account.dapiBaseUrl, env.BINANCE_DAPI_BASE_URL, "https://dapi.binance.com")
    };
  });

  const dataSetting = env.TRACKER_DATA_DIR || "data";
  const dataDir = path.isAbsolute(dataSetting)
    ? dataSetting
    : path.resolve(projectDir, dataSetting);

  return {
    projectDir,
    accountsFile: options.accountsFile || null,
    accounts,
    dataDir,
    scanIntervalMs: positiveNumber(env.POSITION_SCAN_INTERVAL_MS, 300000, 1000),
    recvWindow: positiveNumber(env.BINANCE_RECV_WINDOW, 5000, 1),
    signedRequestRetries: nonNegativeInteger(env.BINANCE_SIGNED_REQUEST_RETRIES, 2),
    fetchTimeoutMs: positiveNumber(env.FETCH_TIMEOUT_MS, 15000, 1000),
    webhook: {
      enabled: booleanValue(env.WEBHOOK_ENABLED, true),
      url: String(env.WEBHOOK_URL || "").trim(),
      secret: String(env.WEBHOOK_SECRET || ""),
      signatureHeader: String(env.WEBHOOK_SIGNATURE_HEADER || "X-Signature-256").trim(),
      signatureTemplate: String(env.WEBHOOK_SIGNATURE_TEMPLATE || "sha256=<hex>"),
      maxAttempts: positiveNumber(env.WEBHOOK_MAX_ATTEMPTS, 5, 1),
      backoffMs: positiveNumber(env.WEBHOOK_BACKOFF_MS, 1000, 10),
      timeoutMs: positiveNumber(env.FETCH_TIMEOUT_MS, 15000, 1000)
    }
  };
}

function normalizeSubAccounts(value, accountName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`账户“${accountName}”的 subAccounts 必须是数组。`);
  const ids = new Set();
  const emails = new Set();
  return value.map((item, index) => {
    const label = `${accountName}.subAccounts[${index}]`;
    const id = requiredId(item?.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`账户“${accountName}”的子账户 id 重复：${id}`);
    ids.add(id);
    const type = String(item?.type || "sub").trim().toLowerCase();
    if (!(["master", "sub"].includes(type))) throw new Error(`${label}.type 只能是 master 或 sub。`);
    const email = type === "sub" ? requiredText(item?.email, `${label}.email`) : "";
    const emailKey = email.toLowerCase();
    if (emailKey && emails.has(emailKey)) throw new Error(`账户“${accountName}”的子账户邮箱重复：${email}`);
    if (emailKey) emails.add(emailKey);
    return {
      id,
      name: requiredText(item?.name, `${label}.name`),
      type,
      email,
      markets: normalizeMarkets(item?.markets, `${label}.markets`)
    };
  });
}

function normalizeMarkets(value, label) {
  const markets = value === undefined ? ["usdm", "coinm"] : value;
  if (!Array.isArray(markets) || !markets.length) throw new Error(`${label} 至少需要一个市场。`);
  const normalized = [...new Set(markets.map((item) => String(item).trim().toLowerCase()))];
  const invalid = normalized.filter((item) => !["usdm", "coinm"].includes(item));
  if (invalid.length) throw new Error(`${label} 含不支持的市场：${invalid.join(", ")}`);
  return normalized;
}

function requiredId(value, label) {
  const id = requiredText(value, label);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${label} 只能包含字母、数字、下划线和连字符。`);
  return id;
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} 不能为空。`);
  return text;
}

function textOrDefault(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text.replace(/\/$/, "");
  }
  return "";
}

function positiveNumber(value, fallback, minimum) {
  const number = Number(value || fallback);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function booleanValue(value, fallback) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

module.exports = {
  loadConfig,
  loadDotEnv,
  normalizeConfig
};
