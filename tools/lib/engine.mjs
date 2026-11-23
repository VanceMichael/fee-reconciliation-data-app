// 核心计费引擎：同一组真实业务量在 current / baseline 两套口径下并算
// 阶梯按 机构×账期×费项 累计；免收分片不占阶梯；顺序按生效费项日期与流水编号
const roundCent = x => (x < 0 ? -Math.round(-x) : Math.round(x)); // half-up，符号保留

const FEES = [
  { fee: 'service', basis: 'trade', dayField: 'trade_day' },
  { fee: 'settle', basis: 'settlement', dayField: 'settle_day' },
];

function inCycle(day, cycle) {
  return day >= cycle.first_day && day <= cycle.last_day;
}

// 生成某账期内、某费项下参与阶梯的正向计费事件（含证据分片）
function positiveEvents({ tables, splits, cycle, feeSpec, policyApi, policy }) {
  const dayField = feeSpec.dayField;
  const rows = tables.activity
    .filter(e => e.kind === 'original' && inCycle(e[dayField], cycle))
    .sort((a, b) => a[dayField] - b[dayField] || a.entry.localeCompare(b.entry));
  const events = [];
  for (const entry of rows) {
    for (const split of splits.get(entry.entry)) {
      const quote = policyApi.quote(feeSpec.fee, entry[dayField], split.category, policy);
      events.push({
        entry: entry.entry, group: entry.group, subaccount: entry.subaccount,
        fee: feeSpec.fee, day: entry[dayField], faceCents: split.faceCents,
        category: split.category, proof: split.proof, quote,
      });
    }
  }
  return events;
}

// 对一组正向事件按机构顺序入阶梯，逐分片定价到最小币别
function priceEvents(events) {
  const cum = new Map(); // key: group|fee -> 已入档面值
  const priced = [];
  for (const ev of events) {
    const key = `${ev.group}|${ev.fee}`;
    const before = cum.get(key) ?? 0;
    let below = 0;
    let above = 0;
    if (ev.quote.exempt) {
      // 免收：费用为 0，不占阶梯
      above = 0;
    } else {
      const cap = ev.quote.rule.tier_cents;
      below = Math.max(0, Math.min(ev.faceCents, cap - before));
      above = ev.faceCents - below;
      cum.set(key, before + ev.faceCents);
    }
    const lowRaw = (below * ev.quote.ratePpm) / 1e6;
    const highRaw = (above * ev.quote.afterPpm) / 1e6;
    const lowCents = roundCent(lowRaw);
    const highCents = roundCent(highRaw);
    priced.push({
      ...ev, tierBefore: before, lowFace: below, highFace: above,
      lowCents, highCents, cents: lowCents + highCents,
      roundingRemainder: roundCent(lowRaw + highRaw) - (lowCents + highCents),
    });
  }
  return priced;
}

// 冲正事件：继承被冲费用的对应份额与归属期间（负费用，回到原账期）
function reversalEvents({ tables, splits, cycle, feeSpec, policyApi, policy, originByKey }) {
  const dayField = feeSpec.dayField;
  const out = [];
  for (const rev of tables.activity.filter(e => e.kind === 'reversal')) {
    const origin = tables.activity.find(e => e.entry === rev.related);
    // 跨期冲正：解释原费用，归属原流水的账期
    if (!inCycle(origin[dayField], cycle)) continue;
    const originSplits = splits.get(origin.entry);
    const revAbs = Math.abs(rev.face_cents);
    const originAbs = Math.abs(origin.face_cents);
    for (const split of originSplits) {
      const share = Math.min(Math.abs(split.faceCents), revAbs * (Math.abs(split.faceCents) / originAbs));
      if (share <= 0) continue;
      const originPriced = originByKey.get(`${origin.entry}|${feeSpec.fee}|${split.category}|${split.proof ?? ''}`);
      // 继承原费用率与归属，按面值份额折算（逐分片舍入，余数登记到该冲正）
      const quote = policyApi.quote(feeSpec.fee, origin[dayField], split.category, policy);
      const rawCents = originPriced
        ? -originPriced.cents * (share / Math.abs(split.faceCents))
        : -(roundCent((share * quote.ratePpm) / 1e6));
      const cents = roundCent(rawCents);
      out.push({
        entry: rev.entry, related: origin.entry, group: rev.group, subaccount: origin.subaccount,
        fee: feeSpec.fee, day: origin[dayField], faceCents: -Math.round(share),
        category: split.category, proof: split.proof, quote,
        lowFace: 0, highFace: 0, lowCents: 0, highCents: 0, cents,
        inherited: true, tierBefore: originPriced?.tierBefore ?? 0,
        roundingRemainder: 0,
      });
    }
  }
  return out;
}

// 重记事件：按其自身归属规则核算（新账期、新入档，但不重复占用被冲正的阶梯份额）
function rebookEvents({ tables, splits, cycle, feeSpec, policyApi, policy }) {
  const dayField = feeSpec.dayField;
  const rows = tables.activity
    .filter(e => e.kind === 'rebook' && inCycle(e[dayField], cycle))
    .sort((a, b) => a[dayField] - b[dayField] || a.entry.localeCompare(b.entry));
  const events = [];
  for (const entry of rows) {
    for (const split of splits.get(entry.entry)) {
      const quote = policyApi.quote(feeSpec.fee, entry[dayField], split.category, policy);
      events.push({
        entry: entry.entry, group: entry.group, subaccount: entry.subaccount,
        fee: feeSpec.fee, day: entry[dayField], faceCents: split.faceCents,
        category: split.category, proof: split.proof, quote,
      });
    }
  }
  return events;
}

// 计算单个账期、单套政策的全部计费明细与分户/机构汇总
export function computeCycle({ tables, splits, cycle, policyApi, policy }) {
  const allPriced = [];
  for (const feeSpec of FEES) {
    const positives = positiveEvents({ tables, splits, cycle, feeSpec, policyApi, policy });
    const pricedPositive = priceEvents(positives);
    const originByKey = new Map(
      pricedPositive.map(p => [`${p.entry}|${p.fee}|${p.category}|${p.proof ?? ''}`, p]),
    );
    const reversals = reversalEvents({ tables, splits, cycle, feeSpec, policyApi, policy, originByKey });
    // 重记在正向（含原账期剩余）之后顺序入档
    const rebooks = rebookEvents({ tables, splits, cycle, feeSpec, policyApi, policy });
    const pricedRebook = priceEvents(rebooks);
    allPriced.push(...pricedPositive, ...reversals, ...pricedRebook);
  }

  // 汇总：机构合计 = 分户合计（同一最小币别对齐），余数逐笔可追
  const groups = new Map();
  for (const p of allPriced) {
    if (!groups.has(p.group)) groups.set(p.group, { group: p.group, subaccounts: new Map(), cents: 0, lines: [] });
    const g = groups.get(p.group);
    if (!g.subaccounts.has(p.subaccount)) g.subaccounts.set(p.subaccount, { subaccount: p.subaccount, cents: 0 });
    g.subaccounts.get(p.subaccount).cents += p.cents;
    g.cents += p.cents;
    g.lines.push(p);
  }
  const result = [];
  for (const g of groups.values()) {
    const subSum = [...g.subaccounts.values()].reduce((a, s) => a + s.cents, 0);
    if (subSum !== g.cents) {
      throw new Error(`机构 ${g.group} 合计 ${g.cents} 与分户分摊 ${subSum} 不一致`);
    }
    result.push({
      group: g.group,
      cents: g.cents,
      subaccounts: [...g.subaccounts.values()].sort((a, b) => a.subaccount.localeCompare(b.subaccount)),
      lines: g.lines.sort((a, b) => a.fee.localeCompare(b.fee) || a.day - b.day || a.entry.localeCompare(b.entry)),
    });
  }
  return result.sort((a, b) => a.group.localeCompare(b.group));
}

// 双口径并算
export function computeAll({ tables, splits, policyApi }) {
  const out = {};
  for (const cycle of tables.cycles) {
    out[cycle.cycle] = {
      cycle,
      current: computeCycle({ tables, splits, cycle, policyApi, policy: 'current' }),
      baseline: computeCycle({ tables, splits, cycle, policyApi, policy: 'baseline' }),
    };
  }
  return out;
}
