// 已出账账单为不可变事实：按原始金额与费率版本查询，不覆盖
// confirmed 调整进入下期且只冲抵一次；pending 留在复议，不计实缴
export function issuedBills(tables) {
  return tables.bills.map(b => ({ ...b }));
}

export function findBill(tables, billId) {
  const b = tables.bills.find(x => x.bill === billId);
  if (!b) throw new Error(`账单 ${billId} 不存在`);
  return { ...b };
}

// 按账单关联的调整项（credits），区分 confirmed / pending
export function creditsForBill(tables, billId) {
  return tables.credits.filter(c => c.bill === billId).map(c => ({ ...c }));
}

// 把引擎重算结果与已出账账单逐户对齐，产出可核对调整项
export function reconcile({ tables, computedCycle, asOfDay }) {
  const items = [];
  const bills = issuedBills(tables);
  const byKey = new Map();
  for (const g of computedCycle) {
    for (const s of g.subaccounts) byKey.set(`${g.group}|${s.subaccount}`, s.cents);
  }
  for (const bill of bills) {
    const recomputed = byKey.get(`${bill.group}|${bill.subaccount}`) ?? 0;
    const confirmed = creditsForBill(tables, bill.bill)
      .filter(c => c.state === 'confirmed' && c.day <= asOfDay)
      .reduce((a, c) => a + c.cents, 0);
    const pending = creditsForBill(tables, bill.bill)
      .filter(c => c.state === 'pending')
      .map(c => ({ credit: c.credit, cents: c.cents, day: c.day }));
    // 已出账净额 + 已确认调整 = 已落账毛额口径；与重算毛额比较
    const bookedGross = bill.charged_cents + confirmed;
    const adjustment = recomputed - bookedGross;
    items.push({
      bill: bill.bill, cycle: bill.cycle, group: bill.group, subaccount: bill.subaccount,
      issuedNet: bill.charged_cents,
      confirmedCredits: confirmed,
      pendingCredits: pending,
      bookedGross,
      recomputedGross: recomputed,
      adjustmentCents: adjustment,
      needsReconfirmation: adjustment !== 0,
    });
  }
  return items;
}

// 已确认调整在下期结账时的防重复冲抵登记
export function appliedCreditLedger(tables) {
  // credit -> 已使用的账期；confirmed 一旦在某期冲抵即登记，不可再次使用
  const ledger = new Map();
  for (const c of tables.credits.filter(x => x.state === 'confirmed')) {
    ledger.set(c.credit, { bill: c.bill, cents: c.cents, confirmedDay: c.day, appliedCycle: null });
  }
  return ledger;
}

export function closeCycle({ ledger, cycleId, confirmedCreditsPresent }) {
  const applied = [];
  for (const creditId of confirmedCreditsPresent) {
    const entry = ledger.get(creditId);
    if (!entry) throw new Error(`调整 ${creditId} 非 confirmed，不得冲抵`);
    if (entry.appliedCycle !== null) {
      throw new Error(`调整 ${creditId} 已在账期 ${entry.appliedCycle} 冲抵，禁止重复使用`);
    }
    entry.appliedCycle = cycleId;
    applied.push({ credit: creditId, cents: entry.cents });
  }
  // pending 不计入实缴
  return { applied, provisionalExcluded: true };
}
