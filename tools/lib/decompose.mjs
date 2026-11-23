// 用量价基准把 baseline -> current 的差额分解为：费率政策、品种构成、交易量
// 顺序固定为：先换费率（政策），再换品种（构成），最后换业务量（交易量）；
// 每一步只改一个维度，重算整条阶梯，差额含跨档联动；无法用给定基准表达的部分计入残差并说明。
import { computeCycle } from './engine.mjs';

function totalOf(computed) {
  const byGroup = new Map();
  for (const g of computed) byGroup.set(g.group, g.cents);
  return byGroup;
}

export function decompose({ tables, baselineSplits, currentSplits, cycle, policyApi }) {
  // 四个锚点（同一账期、同一机构）
  const A = totalOf(computeCycle({ tables, splits: baselineSplits, cycle, policyApi, policy: 'baseline' }));
  const B = totalOf(computeCycle({ tables, splits: baselineSplits, cycle, policyApi, policy: 'current' }));
  const C = totalOf(computeCycle({ tables, splits: currentSplits, cycle, policyApi, policy: 'current' }));
  // D 与 C 在本数据中为同一事实集；若未来业务量调整，可在此插入新的事实集
  const D = C;

  const groups = [...new Set([...A.keys(), ...B.keys(), ...C.keys()])].sort();
  const rows = groups.map(group => {
    const a = A.get(group) ?? 0;
    const b = B.get(group) ?? 0;
    const c = C.get(group) ?? 0;
    const d = D.get(group) ?? 0;
    const rateEffect = b - a;       // 费率政策（含阶梯跨档联动）
    const mixEffect = c - b;        // 品种构成（分类证据/green 减免）
    const volumeEffect = d - c;     // 交易量（本数据集无独立业务量反事实，为 0）
    const explained = rateEffect + mixEffect + volumeEffect;
    const residual = d - a - explained;
    return {
      group,
      baseline: a,
      current: d,
      delta: d - a,
      effects: { ratePolicy: rateEffect, productMix: mixEffect, volume: volumeEffect, residual },
      missingBaselines: [],
    };
  });

  // 标注缺少可用基准的反事实
  for (const row of rows) {
    if (row.effects.volume === 0) {
      row.missingBaselines.push('交易量反事实：policy-basis 仅给费率基准，未提供独立业务量基准，volume 置 0 而非臆造');
    }
    if (row.effects.residual !== 0) {
      row.missingBaselines.push('存在无法被三因素吸收的残差，需补充基准后才能解释');
    }
  }
  return rows;
}
