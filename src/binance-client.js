const crypto = require("node:crypto");

class BinanceClient {
  constructor(account, options = {}) {
    this.apiKey = account.apiKey;
    this.apiSecret = account.apiSecret;
    this.baseUrl = account.baseUrl;
    this.fapiBaseUrl = account.fapiBaseUrl;
    this.dapiBaseUrl = account.dapiBaseUrl;
    this.recvWindow = Number(options.recvWindow || 5000);
    this.retries = Number(options.signedRequestRetries ?? 2);
    this.timeoutMs = Number(options.fetchTimeoutMs || 15000);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeOffsets = new Map();
  }

  async listSubAccounts() {
    const accounts = [];
    const limit = 200;
    for (let page = 1; page <= 50; page += 1) {
      const payload = await this.signedRequest("GET", this.baseUrl, "/sapi/v1/sub-account/list", {
        page,
        limit
      });
      if (!Array.isArray(payload?.subAccounts)) {
        throw responseError("子账户列表响应缺少 subAccounts 数组。", payload);
      }
      accounts.push(...payload.subAccounts);
      if (payload.subAccounts.length < limit) break;
    }
    return accounts;
  }

  async fetchPositions(scope) {
    const positions = [];
    for (const market of scope.markets) {
      const venue = market === "coinm" ? "COIN-M Futures" : "USD-M Futures";
      const rows = scope.type === "master"
        ? await this.fetchMasterPositionRows(market)
        : await this.fetchSubAccountPositionRows(scope.email, market);
      positions.push(...normalizePositionRows(rows, venue));
    }
    return positions;
  }

  async fetchMasterPositionRows(market) {
    const coinM = market === "coinm";
    const payload = await this.signedRequest(
      "GET",
      coinM ? this.dapiBaseUrl : this.fapiBaseUrl,
      coinM ? "/dapi/v1/account" : "/fapi/v3/account"
    );
    if (!Array.isArray(payload?.positions)) {
      throw responseError(`${coinM ? "COIN-M" : "USD-M"} 主账户响应缺少 positions 数组。`, payload);
    }
    return payload.positions;
  }

  async fetchSubAccountPositionRows(email, market) {
    const futuresType = market === "coinm" ? 2 : 1;
    const payload = await this.signedRequest(
      "GET",
      this.baseUrl,
      "/sapi/v2/sub-account/futures/positionRisk",
      { email, futuresType }
    );
    const field = futuresType === 1 ? "futurePositionRiskVOS" : "deliveryPositionRiskVOS";
    if (!Array.isArray(payload?.[field])) {
      throw responseError(`子账户 ${email} 响应缺少 ${field} 数组。`, payload);
    }
    return payload[field];
  }

  async signedRequest(method, baseUrl, endpoint, params = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const query = buildQuery({
        ...params,
        recvWindow: this.recvWindow,
        timestamp: Date.now() + Number(this.timeOffsets.get(baseUrl) || 0)
      });
      const signature = crypto.createHmac("sha256", this.apiSecret).update(query).digest("hex");
      try {
        return await this.fetchJson(`${baseUrl}${endpoint}?${query}&signature=${signature}`, {
          method,
          headers: { "X-MBX-APIKEY": this.apiKey }
        });
      } catch (error) {
        lastError = error;
        if (String(error.code) !== "-1021" || attempt >= this.retries) break;
        await this.syncTime(baseUrl);
      }
    }
    throw lastError;
  }

  async syncTime(baseUrl) {
    const endpoint = baseUrl === this.fapiBaseUrl
      ? "/fapi/v1/time"
      : baseUrl === this.dapiBaseUrl
        ? "/dapi/v1/time"
        : "/api/v3/time";
    const payload = await this.fetchJson(`${baseUrl}${endpoint}`);
    const serverTime = Number(payload?.serverTime || 0);
    if (serverTime) this.timeOffsets.set(baseUrl, serverTime - Date.now());
  }

  async fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let text = "";
    try {
      response = await this.fetchImpl(url, { ...options, signal: controller.signal });
      text = await response.text();
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(`Binance 请求超时（${this.timeoutMs}ms）。`);
        timeoutError.code = "FETCH_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      const error = new Error(payload?.msg || `Binance 请求失败：HTTP ${response.status}。`);
      error.code = payload?.code || "BINANCE_ERROR";
      error.statusCode = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
}

function normalizePositionRows(rows, venue) {
  return rows
    .map((row) => {
      const quantity = String(row.positionAmt ?? row.positionAmount ?? "0");
      return {
        venue,
        symbol: String(row.symbol || ""),
        positionSide: String(row.positionSide || "BOTH"),
        quantity
      };
    })
    .filter((row) => row.symbol && Number.isFinite(Number(row.quantity)) && Math.abs(Number(row.quantity)) >= 1e-12);
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.append(key, String(value));
  }
  return search.toString();
}

function responseError(message, payload) {
  const error = new Error(message);
  error.code = "BINANCE_RESPONSE_INVALID";
  error.payload = payload;
  return error;
}

module.exports = {
  BinanceClient,
  normalizePositionRows
};
