// 费率政策解析：按费项的基准事实日选规则；green 在旧窗口回退 standard
export const POLICIES = ['current', 'baseline'];

export function buildPolicy(tariffs, policyBasis) {
  const basisRow = new Map(policyBasis.map(r => [r.rule, r]));
  const exact = (fee, day, category) => tariffs.find(
    r => r.fee === fee && r.from_day <= day && day <= r.to_day && r.category === category,
  );
  const standard = (fee, day) => tariffs.find(
    r => r.fee === fee && r.from_day <= day && day <= r.to_day && r.category === 'standard',
  );

  // 返回该事实日适用的规则行；green 在无 green 窗口时回退同窗 standard
  function resolveRule(fee, day, category) {
    const hit = exact(fee, day, category) ?? standard(fee, day);
    if (!hit) throw new Error(`费项 ${fee} 在第 ${day} 日、类别 ${category} 无适用规则`);
    return hit;
  }

  // 单笔（或某一名义分片）的费率与是否免收
  function quote(fee, day, category, policy) {
    const rule = resolveRule(fee, day, category);
    const greenWindow = exact(fee, day, 'green') !== undefined;
    if (policy === 'current') {
      // 仅当事实日落在含 green 规则的窗口，green 分片才享受免收（且不占阶梯）
      if (category === 'green' && greenWindow) {
        return { rule, ratePpm: 0, afterPpm: 0, exempt: true };
      }
      return { rule, ratePpm: rule.rate_ppm, afterPpm: rule.rate_after_ppm, exempt: false };
    }
    // baseline：无本轮优惠，green 按 standard 基准费率计费
    const b = basisRow.get(rule.rule);
    return { rule, ratePpm: b.baseline_rate_ppm, afterPpm: b.baseline_after_ppm, exempt: false };
  }

  return { quote, resolveRule };
}
