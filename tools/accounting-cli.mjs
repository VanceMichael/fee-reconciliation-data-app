// 可重复核算 CLI：只读 fixtures，输出 JSON 报告，不改动已出账账单
import { pathToFileURL } from 'node:url';
import { loadData } from './lib/csv.mjs';
import { buildPolicy } from './lib/policy.mjs';
import { buildSplits } from './lib/classification.mjs';
import { computeAll, computeCycle } from './lib/engine.mjs';
import { decompose } from './lib/decompose.mjs';
import { reconcile, issuedBills, findBill, appliedCreditLedger, closeCycle } from './lib/bills.mjs';
import { reviewReclassification } from './lib/review.mjs';

export async function buildContext(source) {
  const { tables } = await loadData(source);
  const policyApi = buildPolicy(tables.tariffs, tables['policy-basis']);
  const currentSplits = buildSplits(tables.activity, tables.classification);
  // baseline 反事实：不承认本轮任何晚到分类证据（用空证据集重建分片）
  const baselineSplits = buildSplits(tables.activity, []);
  return { tables, policyApi, currentSplits, baselineSplits };
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

async function main() {
  const defaultSource = new URL('../fixtures/', import.meta.url);
  const dataArg = arg('data', null);
  const source = dataArg ? pathToFileURL(dataArg.endsWith('/') ? dataArg : `${dataArg}/`) : defaultSource;
  const ctx = await buildContext(source);
  const command = process.argv[2] ?? 'report';

  if (command === 'report') {
    const all = computeAll({ tables: ctx.tables, splits: ctx.currentSplits, policyApi: ctx.policyApi });
    const report = {};
    for (const [cycleId, r] of Object.entries(all)) {
      report[cycleId] = {
        cycle: r.cycle,
        current: r.current.map(g => ({
          group: g.group, cents: g.cents,
          subaccounts: g.subaccounts,
          lines: g.lines.map(l => ({
            entry: l.entry, subaccount: l.subaccount, fee: l.fee, day: l.day,
            category: l.category, proof: l.proof, faceCents: l.faceCents,
            lowFace: l.lowFace, highFace: l.highFace, cents: l.cents,
            inherited: l.inherited ?? false, exempt: l.quote.exempt,
          })),
        })),
        baseline: r.baseline.map(g => ({ group: g.group, cents: g.cents, subaccounts: g.subaccounts })),
      };
    }
    console.log(JSON.stringify({ 命令: '双口径并算', 报告: report }, null, 2));
    return;
  }

  if (command === 'decompose') {
    const cycleId = arg('cycle', '1');
    const cycle = ctx.tables.cycles.find(c => c.cycle === cycleId);
    const rows = decompose({
      tables: ctx.tables, baselineSplits: ctx.baselineSplits,
      currentSplits: ctx.currentSplits, cycle, policyApi: ctx.policyApi,
    });
    console.log(JSON.stringify({ 命令: '量价差分解', 账期: cycleId, 机构: rows }, null, 2));
    return;
  }

  if (command === 'reconcile') {
    const cycleId = arg('cycle', '1');
    const asOf = Number(arg('as-of', '27'));
    const cycle = ctx.tables.cycles.find(c => c.cycle === cycleId);
    const computed = computeCycle({
      tables: ctx.tables, splits: ctx.currentSplits, cycle, policyApi: ctx.policyApi, policy: 'current',
    });
    const items = reconcile({ tables: ctx.tables, computedCycle: computed, asOfDay: asOf });
    console.log(JSON.stringify({ 命令: '账单核对', 账期: cycleId, 截止日: asOf, 调整项: items }, null, 2));
    return;
  }

  if (command === 'bill') {
    console.log(JSON.stringify({ 命令: '账单版本查询(不可变)', 账单: findBill(ctx.tables, arg('id')) }, null, 2));
    return;
  }

  if (command === 'review') {
    const cycleId = arg('cycle', '1');
    const proof = {
      proof: arg('proof'), entry: arg('entry'),
      confirmed_cents: Number(arg('confirmed-cents')),
      category: arg('category'), accepted_day: Number(arg('accepted-day')),
    };
    const cycle = ctx.tables.cycles.find(c => c.cycle === cycleId);
    const result = reviewReclassification({
      tables: ctx.tables, classification: ctx.tables.classification,
      cycle, policyApi: ctx.policyApi, proof,
    });
    console.log(JSON.stringify({ 命令: '分户复议重算', 账期: cycleId, 结果: result }, null, 2));
    return;
  }

  if (command === 'close') {
    const cycleId = arg('cycle', '2');
    const ledger = appliedCreditLedger(ctx.tables);
    const confirmed = ctx.tables.credits.filter(c => c.state === 'confirmed').map(c => c.credit);
    const result = closeCycle({ ledger, cycleId, confirmedCreditsPresent: confirmed });
    // 再关一次验证防重复
    let duplicate = null;
    try { closeCycle({ ledger, cycleId, confirmedCreditsPresent: confirmed }); }
    catch (err) { duplicate = err.message; }
    console.log(JSON.stringify({ 命令: '下期结账', 账期: cycleId, 冲抵: result, 重复冲抵拦截: duplicate }, null, 2));
    return;
  }

  if (command === 'bills') {
    console.log(JSON.stringify({ 命令: '全部已出账(只读)', 账单: issuedBills(ctx.tables) }, null, 2));
    return;
  }

  throw new Error(`未知命令 ${command}`);
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });
