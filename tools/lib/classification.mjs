// 晚到分类证据：把一笔名义金额拆成已证实（新类别）与未证实（原类别）两个分片
// 证据只支持部分名义金额时，仅已证实部分可享受对应减免
export function buildSplits(activity, classification) {
  const proofsByEntry = new Map();
  for (const p of classification) {
    if (!proofsByEntry.has(p.entry)) proofsByEntry.set(p.entry, []);
    proofsByEntry.get(p.entry).push(p);
  }

  const splits = new Map();
  for (const entry of activity) {
    const proofs = (proofsByEntry.get(entry.entry) ?? [])
      .filter(p => p.category !== entry.category)
      .sort((a, b) => a.accepted_day - b.accepted_day || a.proof.localeCompare(b.proof));
    if (proofs.length === 0) {
      splits.set(entry.entry, [{
        entry: entry.entry,
        faceCents: entry.face_cents,
        category: entry.category,
        proof: null,
        unprovenCents: 0,
      }]);
      continue;
    }
    const total = Math.abs(entry.face_cents);
    let confirmed = 0;
    const parts = [];
    for (const p of proofs) {
      const remaining = total - confirmed;
      const take = Math.min(p.confirmed_cents, remaining);
      if (take <= 0) continue;
      parts.push({
        entry: entry.entry, faceCents: Math.sign(entry.face_cents) * take,
        category: p.category, proof: p.proof, unprovenCents: 0,
      });
      confirmed += take;
    }
    const unproven = total - confirmed;
    if (unproven > 0) {
      parts.push({
        entry: entry.entry, faceCents: Math.sign(entry.face_cents) * unproven,
        category: entry.category, proof: null, unprovenCents: unproven,
      });
    }
    splits.set(entry.entry, parts);
  }
  return splits;
}
