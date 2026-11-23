# 收费减免的反事实核算与客户账单复议

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。

## 数据说明

金额都按整数分计，rate_ppm 为百万分比。tariffs 的首末日含两端，tier_cents 是每机构、计费期、费项的尚未减免的机构累计计费面值门槛，免收部分不占阶梯。正向业务先按生效费项日期和流水编号入阶梯；冲正继承被冲费用中的对应份额及归属期间，待复核不冻结其他业务。分户与机构总额以同一最小币别对齐。fee rule 本地定义与现实费率无关。
对照表 policy-basis 提供有效业务在无本轮优惠下的基准档。confirmed 调整已经确认用于下期，pending 只留在复议。对外账单保存已发版本，录入已确认更正时可查受阶梯变化影响的客户。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

运行 `npm run check:materials` 检查合成交接资料的字段与记录引用。运行 `npm test` 检查交接资料的读取和校验。

## 反事实核算工具

仅依赖 Node.js 标准库，全部只读 `fixtures/`，不写回、不覆盖已出账账单。模块位于 `tools/lib/`，命令入口 `tools/accounting-cli.mjs`。

- `lib/csv.mjs`：载入 CSV、表头/行格式校验、跨表引用与业务不变量（冲正为负、重记为正、证明金额不超面值、费率窗口不重叠）。
- `lib/policy.mjs`：按费项的基准事实日（service 看交易日、settle 看结算日）选规则；事实日落入含 green 规则的窗口时 green 分片免收且不占阶梯，旧窗口无 green 规则则回退同窗 standard；baseline 口径按 `policy-basis` 取无优惠费率，green 按 standard 计。
- `lib/classification.mjs`：晚到证据把一笔名义金额拆成“已证实（新类别）+ 未证实（原类别）”分片，只有已证实部分可享减免，分片金额守恒。
- `lib/engine.mjs`：同一组真实业务量在 current / baseline 双口径并算。机构×账期×费项累计阶梯，按生效费项日期与流水编号入档；冲正继承被冲费用份额回原账期（负费用），重记按自身归属在新账期独立入档；逐分片舍入到分，机构合计与分户分摊强制对齐。
- `lib/decompose.mjs`：固定“费率政策 → 品种构成 → 交易量”顺序，每步只改一个维度重算整条阶梯，差额含跨档联动；无独立业务量基准时交易量因素置 0 并在 `missingBaselines` 说明，不臆造反事实。
- `lib/bills.mjs`：账单按原始金额与费率版本只读查询；confirmed 调整进下期且只能冲抵一次，pending 不计实缴；`reconcile` 产出逐户可核对调整项并标记需重新确认的客户。
- `lib/review.mjs`：分户复议触发整机构重算，阶梯穿透会影响同机构其他分户；客户通知只含提复议分户自身金额与其他分户的差额，不含其他分户交易内容。

命令（可用 `--data <目录>` 指向其他同构资料目录，`--cycle`、`--as-of`、`--id` 等传参）：

```
npm run bill:report                 # 双口径并算明细与分户/机构汇总
npm run bill:decompose -- --cycle 1 # 费率政策/品种构成/交易量三因素分解
npm run bill:reconcile -- --cycle 1 --as-of 40  # 已出账 vs 重算，生成调整项
npm run bill:bill -- --id B1        # 只读查询某张已出账账单（不覆盖）
npm run bill:review -- --cycle 1 --proof CLX --entry E4 \
  --confirmed-cents 92009 --category green --accepted-day 40  # 复议重算
npm run bill:close -- --cycle 2     # 下期结账，演示 confirmed 防重复冲抵
```

## 口径核对结论（合成资料）

按 tariffs + activity 的明文规则重算与已出账账单是两条独立事实线：引擎对 cycle 1 的 current 口径重算为 G1 合计 2394（A 1726 / B 668）、G2 为 0，而 B1/B2/B3 已出账净额为 1211 / 516 / 0。穷举账期归属、阶梯范围（机构/分户/规则窗口/按日重置）、排序键、舍入模式与流水子集均无法由费率表精确复现 B1/B2 的分户金额（部分分户费项目标在费率上下界内数学不可达）。因此工具不反推、不覆盖账单，而是把账单作为不可变输入，通过 `reconcile` 输出可核对差额并标记需重新确认的客户；该差额即“对外口径与按现行政策重算口径”之间待解释项，需补充账单当时的费率版本或分摊基准才能进一步归因。

