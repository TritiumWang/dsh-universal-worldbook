// assembler.js — 命中组装。
// 规则:常驻与关键词触发一律只按 order 升序(大 order 更靠近输出尾部);
//       同 order 按条目在文件中的顺序(uid 升序)排列。默认不插入换行(作者要换行就写在内容里)。
// 无条数/长度上限;separator 可配(未来 UI 提供"附加换行"勾选,当前默认 '').

function compareHits(a, b) {
  const oa = Number(a.order) || 0
  const ob = Number(b.order) || 0
  if (oa !== ob) return oa - ob
  return uidCompare(a.uidKey, b.uidKey)
}

function uidCompare(a, b) {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return String(a) < String(b) ? -1 : 1
}

export function assemble(hits, options = {}) {
  const separator = options.separator === undefined ? '' : String(options.separator)
  const sorted = [...hits].sort(compareHits)
  const sections = sorted.map((hit) => ({
    uidKey: hit.uidKey,
    reason: hit.reason,
    matchedKeys: hit.matchedKeys || [],
    content: String(hit.content)
  }))
  return {
    text: sections.map((s) => s.content).join(separator),
    sections,
    count: sections.length,
    totalChars: sections.reduce((sum, s) => sum + Array.from(s.content).length, 0)
  }
}
