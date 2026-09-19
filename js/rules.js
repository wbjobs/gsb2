/* 规则引擎：页面与 Service Worker 共用（UMD，可在 Node 单测中 require） */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DebugRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_DELAY_MS = 30000;

  function matchUrl(rule, url) {
    const type = rule.matchType || 'includes';
    const pattern = rule.pattern || '';
    try {
      if (type === 'includes') return url.includes(pattern);
      if (type === 'prefix') return url.startsWith(pattern);
      if (type === 'exact') return url === pattern;
      if (type === 'regexp') return new RegExp(pattern).test(url);
    } catch (e) {
      return false;
    }
    return false;
  }

  function matchMethod(rule, method) {
    const m = (rule.method || 'ANY').toUpperCase();
    return m === 'ANY' || m === String(method || 'GET').toUpperCase();
  }

  function findRule(rules, request) {
    return (rules || []).find(function (r) {
      return r.enabled !== false &&
        matchMethod(r, request.method) &&
        matchUrl(r, request.url);
    });
  }

  function normalizeDelay(ms) {
    const n = Number(ms) || 0;
    return Math.max(0, Math.min(MAX_DELAY_MS, n));
  }

  function evalDecision(rule, rng) {
    const random = rng || Math.random;
    const action = rule.action || 'delay';
    const decision = {
      action: action,
      ruleId: rule.id,
      delayMs: normalizeDelay(rule.delayMs),
    };
    if (action === 'status' || action === 'mock') {
      decision.status = Number(rule.status) || 500;
    }
    if (action === 'mock') {
      decision.body = typeof rule.body === 'string' ? rule.body : JSON.stringify(rule.body || {});
    }
    if (action === 'drop') {
      const pct = Math.max(0, Math.min(100, Number(rule.lossPercent)));
      decision.dropped = random() * 100 < pct;
      decision.lossPercent = pct;
    }
    return decision;
  }

  function validateRule(rule) {
    const errors = [];
    if (!rule.pattern) errors.push('pattern 不能为空');
    if (rule.matchType === 'regexp') {
      try { new RegExp(rule.pattern); } catch (e) { errors.push('正则表达式无效: ' + e.message); }
    }
    if (rule.action === 'status' || rule.action === 'mock') {
      const s = Number(rule.status);
      if (!(s >= 100 && s <= 599)) errors.push('状态码必须在 100-599');
    }
    if (Number(rule.delayMs) > MAX_DELAY_MS) errors.push('延迟不能超过 30000ms');
    if (rule.action === 'drop') {
      const p = Number(rule.lossPercent);
      if (!(p >= 0 && p <= 100)) errors.push('丢包率必须在 0-100');
    }
    return errors;
  }

  return {
    MAX_DELAY_MS: MAX_DELAY_MS,
    matchUrl: matchUrl,
    matchMethod: matchMethod,
    findRule: findRule,
    evalDecision: evalDecision,
    validateRule: validateRule,
  };
});
