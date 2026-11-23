import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildContext } from '../tools/accounting-cli.mjs';
import { computeCycle } from '../tools/lib/engine.mjs';
import { buildSplits } from '../tools/lib/classification.mjs';
import { decompose } from '../tools/lib/decompose.mjs';
import { reconcile, closeCycle, appliedCreditLedger } from '../tools/lib/bills.mjs';
import { reviewReclassification } from '../tools/lib/review.mjs';
import { buildPolicy } from '../tools/lib/policy.mjs';

const fixtureUrl = pathToFileURL(new URL('../fixtures/', import.meta.url).pathname.replace(/\/?$/, '/'));
const ctx = await buildContext(fixtureUrl);
const cycle1 = ctx.tables.cycles.find(c => c.cycle === '1');
const cycle2 = ctx.tables.cycles.find(c => c.cycle === '2');

function groupOf(computed, groupId) {
  return computed.find(g => g.group === groupId);
}
function line(computed, entry, fee) {
  for (const g of computed) for (const l of g.lines) if (l.entry === entry && l.fee === fee) return l;
  throw new Error(`未找到 ${entry}/${fee}`);
}

test('同一组业务量在新旧口径并算，基准口径费用不低于当前口径', () => {
  const cur = computeCycle({ tables: ctx.tables, splits: ctx.currentSplits, cycle: cycle1, policyApi: ctx.policyApi, policy: 'current' });
  const base = computeCycle({ tables: ctx.tables, splits: ctx.baselineSplits, cycle: cycle1, policyApi: ctx.policyApi, policy: 'baseline' });
  for (const g of cur) {
    const b = groupOf(base, g.group);
    assert.ok(b.cents >= g.cents, `${g.group} 基准费用应不低于减免后`);
  }
  // G2 green 在当前口径全免，基准口径仍计费
  assert.equal(groupOf(cur, 'G2').cents, 0);
  assert.ok(groupOf(base, 'G2').cents > 0);
});

test('green 免收分片不占机构阶梯，standard 分片正常入档', () => {
  const cur = computeCycle({ tables: ctx.tables, splits: ctx.currentSplits, cycle: cycle1, policyApi: ctx.policyApi, policy: 'current' });
  const e7 = line(cur, 'E7', 'service');
  assert.equal(e7.cents, 0);
  assert.equal(e7.quote.exempt, true);
  assert.equal(e7.lowFace, 0); // 不占阶梯
});

test('旧窗口无 green 规则时回退 standard，基准口径对 green 按标准费率', () => {
  const base = computeCycle({ tables: ctx.tables, splits: ctx.baselineSplits, cycle: cycle1, policyApi: ctx.policyApi, policy: 'baseline' });
  const h5 = line(base, 'H5', 'settle');
  assert.ok(h5.cents > 0);
  assert.equal(h5.category, 'green');
});

test('机构合计与分户分摊在最小币别完全对齐', () => {
  const cur = computeCycle({ tables: ctx.tables, splits: ctx.currentSplits, cycle: cycle1, policyApi: ctx.policyApi, policy: 'current' });
  for (const g of cur) {
    const subSum = g.subaccounts.reduce((a, s) => a + s.cents, 0);
    assert.equal(subSum, g.cents);
  }
});

test('跨期冲正继承原费用归属原账期且为负，重记按自身归属进新账期', () => {
  const c1 = computeCycle({ tables: ctx.tables, splits: ctx.currentSplits, cycle: cycle1, policyApi: ctx.policyApi, policy: 'current' });
  const c2 = computeCycle({ tables: ctx.tables, splits: ctx.currentSplits, cycle: cycle2, policyApi: ctx.policyApi, policy: 'current' });
  const revSvc = line(c1, 'E5', 'service');
  const revSet = line(c1, 'E5', 'settle');
  assert.ok(revSvc.inherited && revSvc.cents < 0);
  assert.ok(revSet.inherited && revSet.cents < 0);
  // E6 只在 cycle2
  assert.throws(() => line(c1, 'E6', 'service'));
  const rebook = line(c2, 'E6', 'service');
  assert.equal(rebook.inherited ?? false, false);
});

test('晚到分类证据仅对已证实部分减免，未证实部分保留原类别', () => {
  const c2 = computeCycle({ tables: ctx.tables, splits: ctx.currentSplits, cycle: cycle2, policyApi: ctx.policyApi, policy: 'current' });
  for (const fee of ['service', 'settle']) {
    const green = c2.flatMap(g => g.lines).filter(l => l.entry === 'E6' && l.category === 'green' && l.fee === fee);
    const standard = c2.flatMap(g => g.lines).filter(l => l.entry === 'E6' && l.category === 'standard' && l.fee === fee);
    assert.equal(green.reduce((a, l) => a + l.faceCents, 0), 12000); // 仅已证实部分
    assert.equal(standard.reduce((a, l) => a + l.faceCents, 0), 38000); // 未证实部分
    assert.equal(green.every(l => l.cents === 0), true);
    assert.ok(standard.reduce((a, l) => a + l.cents, 0) > 0);
  }
});

test('量价差分解三因素可加且残差为零，交易量反事实标注缺基准', () => {
  const rows = decompose({ tables: ctx.tables, baselineSplits: ctx.baselineSplits, currentSplits: ctx.currentSplits, cycle: cycle1, policyApi: ctx.policyApi });
  for (const r of rows) {
    const sum = r.effects.ratePolicy + r.effects.productMix + r.effects.volume + r.effects.residual;
    assert.equal(sum, r.delta);
    assert.equal(r.effects.residual, 0);
    assert.match(r.missingBaselines[0], /交易量反事实/);
  }
});

test('已出账账单只读，核对产生可核对调整项并识别需重新确认的客户', () => {
  const cur = computeCycle({ tables: ctx.tables, splits: ctx.currentSplits, cycle: cycle1, policyApi: ctx.policyApi, policy: 'current' });
  const items = reconcile({ tables: ctx.tables, computedCycle: cur, asOfDay: 40 });
  const b1 = items.find(i => i.bill === 'B1');
  assert.equal(b1.confirmedCredits, 74); // A2 已确认
  const b2 = items.find(i => i.bill === 'B2');
  assert.equal(b2.confirmedCredits, 0); // A1 pending 不计实缴
  assert.ok(b2.pendingCredits.some(c => c.credit === 'A1'));
  assert.equal(items.filter(i => i.needsReconfirmation).length, 2);
  // 账单原值不被修改
  assert.equal(ctx.tables.bills.find(b => b.bill === 'B1').charged_cents, 1211);
});

test('分户复议重算穿过机构阶梯，通知不含其他分户交易内容', () => {
  const proof = { proof: 'CLX', entry: 'E4', confirmed_cents: 92009, category: 'green', accepted_day: 40 };
  const r = reviewReclassification({ tables: ctx.tables, classification: ctx.tables.classification, cycle: cycle1, policyApi: ctx.policyApi, proof });
  assert.equal(r.appellant.subaccount, 'B');
  // 通知里只有提复议分户 B 的数字，其他户只给差额不给交易
  assert.equal(r.notice.subaccount, 'B');
  for (const k of Object.keys(r.notice)) assert.ok(!JSON.stringify(r.notice).includes('"entry"') || r.notice.entry === 'E4');
  assert.ok(!('lines' in r.notice));
});

test('合成场景：一笔重分类穿过机构阶梯改变其他分户费用，通知仅含差额', () => {
  const mk = (fee, cat, rate, after) => ({ rule: fee + cat, fee, basis: fee === 'service' ? 'trade' : 'settlement', from_day: 1, to_day: 80, category: cat, rate_ppm: rate, rate_after_ppm: after, tier_cents: 100000 });
  const tariffs = [mk('service', 'standard', 1000, 500), mk('service', 'green', 0, 0), mk('settle', 'standard', 1000, 500), mk('settle', 'green', 0, 0)];
  const policyBasis = tariffs.map(t => ({ rule: t.rule, baseline_rate_ppm: 1000, baseline_after_ppm: 500, rounding: 'cent' }));
  const activity = [
    { entry: 'T1', group: 'G', subaccount: 'A', trade_day: 5, settle_day: 6, category: 'standard', face_cents: 100000, kind: 'original', related: null, record_day: 6 },
    { entry: 'T2', group: 'G', subaccount: 'B', trade_day: 7, settle_day: 8, category: 'standard', face_cents: 100000, kind: 'original', related: null, record_day: 8 },
  ];
  const synthetic = {
    tariffs, activity, classification: [],
    cycles: [{ cycle: '9', first_day: 1, last_day: 30, baseline_policy_day: 1, current_policy_day: 1 }],
    'policy-basis': policyBasis, bills: [], credits: [],
  };
  const api = buildPolicy(tariffs, policyBasis);
  const r = reviewReclassification({
    tables: synthetic, classification: [], cycle: synthetic.cycles[0], policyApi: api,
    proof: { proof: 'P1', entry: 'T1', confirmed_cents: 100000, category: 'green', accepted_day: 10 },
  });
  const a = r.affectedSubaccounts.find(x => x.subaccount === 'A');
  const b = r.affectedSubaccounts.find(x => x.subaccount === 'B');
  assert.equal(a.deltaCents, -200);
  assert.equal(b.deltaCents, 100); // 阶梯释放，B 回低档
  assert.deepEqual(r.notice.otherSubaccountsAffected, [{ subaccount: 'B', deltaCents: 100 }]);
  assert.ok(!JSON.stringify(r.notice).includes('T2')); // 不带其他户交易
});

test('已确认调整下期只冲抵一次，重复冲抵被拦截；暂定项不计实缴', () => {
  const ledger = appliedCreditLedger(ctx.tables);
  const confirmed = ctx.tables.credits.filter(c => c.state === 'confirmed').map(c => c.credit);
  const first = closeCycle({ ledger, cycleId: '2', confirmedCreditsPresent: confirmed });
  assert.equal(first.applied.length, 1);
  assert.throws(() => closeCycle({ ledger, cycleId: '3', confirmedCreditsPresent: confirmed }), /禁止重复使用/);
  // pending 不在 ledger 中，无法被冲抵
  assert.equal(ledger.has('A1'), false);
});

test('分片金额守恒：证据分片面值之和等于原流水面值', () => {
  for (const entry of ctx.tables.activity) {
    const parts = ctx.currentSplits.get(entry.entry);
    const sum = parts.reduce((a, p) => a + p.faceCents, 0);
    assert.equal(sum, entry.face_cents, `流水 ${entry.entry} 分片不守恒`);
  }
});
