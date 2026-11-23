// 分户复议：确认一笔重分类后，重算会穿过机构阶梯，影响其他分户
// 客户通知只含提复议账户自身的调整，其他账户的交易内容不得进入通知
import { computeCycle } from './engine.mjs';
import { buildSplits } from './classification.mjs';

export function reviewReclassification({ tables, classification, cycle, policyApi, proof }) {
  const augmented = [...classification, proof].sort((a, b) => a.accepted_day - b.accepted_day);
  const beforeSplits = buildSplits(tables.activity, classification);
  const afterSplits = buildSplits(tables.activity, augmented);

  const before = computeCycle({ tables, splits: beforeSplits, cycle, policyApi, policy: 'current' });
  const after = computeCycle({ tables, splits: afterSplits, cycle, policyApi, policy: 'current' });

  const targetEntry = tables.activity.find(e => e.entry === proof.entry);
  const appellantGroup = targetEntry.group;
  const appellantSub = targetEntry.subaccount;

  const subBefore = new Map();
  const subAfter = new Map();
  for (const g of before) for (const s of g.subaccounts) subBefore.set(`${g.group}|${s.subaccount}`, s.cents);
  for (const g of after) for (const s of g.subaccounts) subAfter.set(`${g.group}|${s.subaccount}`, s.cents);

  // 机构内全部分户的差额（阶梯穿透效果）
  const affected = [];
  const groupBefore = before.find(g => g.group === appellantGroup);
  const groupAfter = after.find(g => g.group === appellantGroup);
  const subs = new Set([...groupBefore.subaccounts.map(s => s.subaccount), ...groupAfter.subaccounts.map(s => s.subaccount)]);
  for (const sub of [...subs].sort()) {
    const b = subBefore.get(`${appellantGroup}|${sub}`) ?? 0;
    const a = subAfter.get(`${appellantGroup}|${sub}`) ?? 0;
    affected.push({ group: appellantGroup, subaccount: sub, beforeCents: b, afterCents: a, deltaCents: a - b });
  }

  // 通知视图：只包含提复议分户自身，绝不带其他户交易
  const appellantView = affected.find(x => x.subaccount === appellantSub);
  const notice = {
    group: appellantGroup,
    subaccount: appellantSub,
    entry: proof.entry,
    reclassifiedTo: proof.category,
    confirmedCents: proof.confirmed_cents,
    beforeCents: appellantView.beforeCents,
    afterCents: appellantView.afterCents,
    adjustmentCents: appellantView.deltaCents,
    // 仅告知“机构内其他分户因阶梯联动同步调整”，不含其交易内容
    otherSubaccountsAffected: affected
      .filter(x => x.subaccount !== appellantSub && x.deltaCents !== 0)
      .map(x => ({ subaccount: x.subaccount, deltaCents: x.deltaCents })),
  };

  return {
    appellant: { group: appellantGroup, subaccount: appellantSub },
    institutionDelta: {
      beforeCents: groupBefore.cents,
      afterCents: groupAfter.cents,
      deltaCents: groupAfter.cents - groupBefore.cents,
    },
    affectedSubaccounts: affected,
    notice,
  };
}
