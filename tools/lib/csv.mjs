// 载入并校验合成计费资料（UTF-8、逗号、无引号；'-' 为不适用）
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const intFields = new Set([
  'from_day', 'to_day', 'rate_ppm', 'tier_cents', 'rate_after_ppm',
  'trade_day', 'settle_day', 'face_cents', 'record_day',
  'confirmed_cents', 'accepted_day', 'charged_cents', 'issue_day',
  'cents', 'day', 'first_day', 'last_day', 'baseline_policy_day', 'current_policy_day',
  'baseline_rate_ppm', 'baseline_after_ppm',
]);

export function parseTable(content, fields, table) {
  const lines = content.trimEnd().split(/\r?\n/);
  const header = lines.shift().split(',');
  if (header.length !== fields.length || header.some((field, index) => field !== fields[index])) {
    throw new Error(`${table} 的表头与格式约定不一致`);
  }
  return lines.map((line, index) => {
    const cells = line.split(',');
    if (cells.length !== fields.length || line.includes('"')) {
      throw new Error(`${table} 第 ${index + 2} 行不是约定的字段格式`);
    }
    return Object.fromEntries(fields.map((field, position) => {
      const raw = cells[position];
      if (raw === '' || raw === '-') return [field, raw === '-' ? null : ''];
      if (intFields.has(field)) return [field, Number(raw)];
      return [field, raw];
    }));
  });
}

export function checkLinks(tables, links) {
  for (const [table, field, target, key] of links) {
    const keys = new Set(tables[target].map(row => row[key]));
    for (const row of tables[table]) {
      const value = row[field];
      if (value !== '' && value !== null && !keys.has(value)) {
        throw new Error(`${table}.${field} 的 ${value} 在 ${target}.${key} 中无对应记录`);
      }
    }
  }
}

// 业务一致性校验：冲正/重记配对、金额符号、证明金额上限、费率窗口不重叠
export function checkInvariants(tables) {
  const byEntry = new Map(tables.activity.map(e => [e.entry, e]));
  for (const e of tables.activity) {
    if (e.kind === 'reversal' || e.kind === 'rebook') {
      const ref = byEntry.get(e.related);
      if (!ref) throw new Error(`流水 ${e.entry} 的关联 ${e.related} 不存在`);
      if (e.kind === 'reversal' && e.face_cents >= 0) throw new Error(`冲正 ${e.entry} 面值必须为负`);
      if (e.kind === 'rebook' && e.face_cents <= 0) throw new Error(`重记 ${e.entry} 面值必须为正`);
    }
  }
  for (const c of tables.classification) {
    const ref = byEntry.get(c.entry);
    if (c.confirmed_cents < 0 || c.confirmed_cents > Math.abs(ref.face_cents)) {
      throw new Error(`证明 ${c.proof} 的已证实金额超出流水 ${c.entry} 面值`);
    }
  }
  // 同一 fee+basis+category 的日期窗口不得重叠
  const seen = new Map();
  for (const r of tables.tariffs) {
    const k = `${r.fee}|${r.basis}|${r.category}`;
    const prev = seen.get(k);
    if (prev && !(r.from_day > prev.to_day || prev.from_day > r.to_day)) {
      throw new Error(`费率规则 ${k} 窗口重叠`);
    }
    seen.set(k, r);
  }
}

export async function loadData(source) {
  const root = source instanceof URL ? source : pathToFileURL(source.endsWith('/') ? source : `${source}/`);
  const format = JSON.parse(await readFile(new URL('format.json', root), 'utf8'));
  const tables = {};
  for (const [name, fields] of Object.entries(format.tables)) {
    const content = await readFile(new URL(`${name}.csv`, root), 'utf8');
    tables[name] = parseTable(content, fields, name);
  }
  checkLinks(tables, format.links);
  checkInvariants(tables);
  return { tables, format };
}
