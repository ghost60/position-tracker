const fs = require("node:fs");
const path = require("node:path");

class FileStorage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.baselinePath = path.join(dataDir, "position-baseline.json");
    this.recordsPath = path.join(dataDir, "position-changes.jsonl");
  }

  loadBaseline() {
    if (!fs.existsSync(this.baselinePath)) return null;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.baselinePath, "utf8"));
    } catch (error) {
      throw new Error(`持仓基线文件损坏：${error.message}`);
    }
    if (!parsed || parsed.version !== 1 || typeof parsed.positions !== "object") {
      throw new Error("持仓基线文件格式无效。");
    }
    return parsed;
  }

  saveBaseline(baseline) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tempPath = `${this.baselinePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.baselinePath);
  }

  appendRecord(record) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.appendFileSync(this.recordsPath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

module.exports = { FileStorage };
