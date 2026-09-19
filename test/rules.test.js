'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Rules = require('../js/rules.js');

function req(method, url) { return { method: method, url: url }; }

test('URL 匹配: includes / prefix / exact / regexp', () => {
  assert.ok(Rules.matchUrl({ matchType: 'includes', pattern: '/api' }, 'http://x/api/users'));
  assert.ok(!Rules.matchUrl({ matchType: 'includes', pattern: '/api' }, 'http://x/web'));
  assert.ok(Rules.matchUrl({ matchType: 'prefix', pattern: 'http://x/api' }, 'http://x/api/1'));
  assert.ok(Rules.matchUrl({ matchType: 'exact', pattern: 'http://x/api' }, 'http://x/api'));
  assert.ok(!Rules.matchUrl({ matchType: 'exact', pattern: 'http://x/api' }, 'http://x/api/1'));
  assert.ok(Rules.matchUrl({ matchType: 'regexp', pattern: '/api/\\d+' }, 'http://x/api/42'));
  assert.ok(!Rules.matchUrl({ matchType: 'regexp', pattern: '(/(' }, 'http://x/api'));
});

test('method 匹配', () => {
  assert.ok(Rules.matchMethod({ method: 'GET' }, 'get'));
  assert.ok(Rules.matchMethod({ method: 'ANY' }, 'POST'));
  assert.ok(!Rules.matchMethod({ method: 'POST' }, 'GET'));
});

test('findRule 按顺序命中第一条启用规则', () => {
  const rules = [
    { id: 'a', enabled: false, matchType: 'includes', pattern: '/api', method: 'ANY', action: 'offline' },
    { id: 'b', matchType: 'includes', pattern: '/api/users', method: 'GET', action: 'delay', delayMs: 1000 },
  ];
  assert.strictEqual(Rules.findRule(rules, req('GET', 'http://x/api/users')).id, 'b');
  assert.strictEqual(Rules.findRule(rules, req('POST', 'http://x/api/users')), undefined);
});

test('evalDecision: 延迟范围被夹到 0-30000', () => {
  const d = Rules.evalDecision({ id: 'r', action: 'delay', delayMs: 999999 });
  assert.strictEqual(d.delayMs, 30000);
  assert.strictEqual(d.action, 'delay');
});

test('evalDecision: 随机丢包按概率命中', () => {
  const r = { id: 'r', action: 'drop', lossPercent: 50 };
  assert.strictEqual(Rules.evalDecision(r, () => 0.49).dropped, true);
  assert.strictEqual(Rules.evalDecision(r, () => 0.5).dropped, false);
  assert.strictEqual(Rules.evalDecision({ id: 'r', action: 'drop', lossPercent: 100 }, Math.random).dropped, true);
  assert.strictEqual(Rules.evalDecision({ id: 'r', action: 'drop', lossPercent: 0 }, Math.random).dropped, false);
});

test('evalDecision: mock 携带状态码与 JSON 字符串', () => {
  const d = Rules.evalDecision({
    id: 'r', action: 'mock', status: 418,
    body: { hello: 'world' },
  });
  assert.strictEqual(d.status, 418);
  assert.deepStrictEqual(JSON.parse(d.body), { hello: 'world' });
});

test('evalDecision: 断网动作与延迟', () => {
  const d = Rules.evalDecision({ id: 'r', action: 'offline', delayMs: 1500 });
  assert.strictEqual(d.action, 'offline');
  assert.strictEqual(d.delayMs, 1500);
});

test('validateRule 校验 pattern/正则/状态码/丢包率', () => {
  assert.ok(Rules.validateRule({ pattern: '', action: 'delay' }).length > 0);
  assert.ok(Rules.validateRule({ pattern: '(/(', matchType: 'regexp', action: 'delay' }).length > 0);
  assert.ok(Rules.validateRule({ pattern: '/x', action: 'status', status: 999 }).length > 0);
  assert.ok(Rules.validateRule({ pattern: '/x', action: 'drop', lossPercent: 200 }).length > 0);
  assert.deepStrictEqual(Rules.validateRule({ pattern: '/x', action: 'offline' }), []);
});
