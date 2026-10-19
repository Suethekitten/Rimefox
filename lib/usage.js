// 轻量用量统计：只记数字，不记录正文 / Key / Prompt / 原始响应。
// 服务商没返回 usage 时计入 unknownUsageResponses，不猜 token 数或费用。
export function createUsageStats() {
  const s = {
    requests: 0, // 实际 HTTP 请求（含 thinking 重试、batch 重试、拆半）
    responses: 0, // 拿到并解析过的响应（含解析失败 / 被丢弃的）
    usageResponses: 0,
    unknownUsageResponses: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHits: 0,
    cacheMisses: 0,
    retries: 0,
    splits: 0,
    discarded: 0,
    failed: 0,
    finishReasons: {}
  };

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function add(field, value) {
    const n = num(value);
    if (n === null) return false;
    s[field] += n;
    return true;
  }

  return {
    request(count) {
      s.requests += Math.max(0, Number(count) || 1);
    },
    response(usage) {
      s.responses += 1;
      if (!usage) {
        s.unknownUsageResponses += 1;
        return;
      }
      // 不同协议的字段可能只回来一部分：能算的算，算不了的保持 unknown
      let known = false;
      if (add('inputTokens', usage.input)) known = true;
      if (add('outputTokens', usage.output)) known = true;
      if (add('reasoningTokens', usage.reasoning)) known = true;
      if (add('cacheReadTokens', usage.cacheRead)) known = true;
      if (add('cacheWriteTokens', usage.cacheWrite)) known = true;
      if (known) s.usageResponses += 1;
      else s.unknownUsageResponses += 1;
    },
    cacheHit() {
      s.cacheHits += 1;
    },
    cacheMiss(count) {
      s.cacheMisses += Math.max(0, Number(count) || 0);
    },
    retry() {
      s.retries += 1;
    },
    split() {
      s.splits += 1;
    },
    discard() {
      s.discarded += 1;
    },
    failure() {
      s.failed += 1;
    },
    finish(reason) {
      const key = String(reason || 'unknown');
      s.finishReasons[key] = (s.finishReasons[key] || 0) + 1;
    },
    snapshot() {
      return JSON.parse(JSON.stringify(s));
    },
    reset() {
      Object.keys(s).forEach((key) => {
        s[key] = key === 'finishReasons' ? {} : 0;
      });
    }
  };
}