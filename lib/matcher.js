// matcher.js — 纯函数匹配引擎。
// 输入: 触发语料 {d0,d1,d2} + worldbook 的 entryView 列表
// 输出: 全部命中(无上限,[决定] 作者自由),每条带 reason/命中来源/命中 key。
// 只执行常驻与 key/regex 匹配 + ST selective(可选过滤器)四种逻辑;向量/概率/分组等 v1 不执行。
// selective 语义(数值映射同 SillyTavern,以工作区 ST世界书-逻辑.json 为准):
//   主要关键词之间永远是或(A OR B);过滤器经下方逻辑连接。
//   3=与所有 (A OR B) AND (C AND D);0=与任意 (A OR B) AND (C OR D);
//   1=非所有 (A OR B) NOT (C AND D);2=非任何 (A OR B) NOT (C OR D)。
//   过滤器为空(无 keysecondary)时视为无过滤(仅主关键词判定),避免空集非逻辑的真空悖论。

function regexOfKey(key) {
  const m = /^\/(.*)\/([a-z]*)$/i.exec(key)
  if (!m) return null
  try {
    // 去掉有状态标志 g/y,避免 exec 状态残留
    const flags = m[2].replaceAll('g', '').replaceAll('y', '')
    return new RegExp(m[1], flags)
  } catch {
    return null
  }
}

function literalMatch(text, key, view) {
  const source = view.caseSensitive ? text : text.toLocaleLowerCase()
  const needle = view.caseSensitive ? key : key.toLocaleLowerCase()
  if (needle === '') return false
  if (view.matchWholeWords !== true) return source.includes(needle)
  // 整词(仅当作者显式开启;对中文默认关)
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp('(^|[^\\p{L}\\p{N}_])' + escaped + '(?=$|[^\\p{L}\\p{N}_])', 'u').test(source)
  } catch {
    return source.includes(needle)
  }
}

function keyMatches(text, key, view) {
  const rx = regexOfKey(key)
  if (rx !== null) return rx.test(text)
  return literalMatch(text, key, view)
}

// 归一化语料:按深度 d0..d4 收集非空文本(depth 语义见 host extractCorpus);d0 参与优先级判定
export function normalizeCorpus(corpus = {}) {
  const parts = []
  const slots = ['d0', 'd1', 'd2', 'd3', 'd4']
  for (const source of slots) {
    const text = String(corpus[source] || '')
    if (text.trim() !== '') parts.push({ source, text })
  }
  return { parts, textBySource: Object.fromEntries(parts.map((p) => [p.source, p.text])) }
}

// 一组 key 在语料上的命中(key 去重;匹配失败记 diagnostics)
function scanKeys(keys, parts, view, diagnostics) {
  const matched = []
  const matchedIn = new Set()
  for (const key of keys) {
    let keyHit = false
    for (const part of parts) {
      try {
        if (keyMatches(part.text, key, view)) {
          keyHit = true
          matchedIn.add(part.source)
        }
      } catch (error) {
        diagnostics.push({
          uidKey: view.uidKey,
          key,
          error: String(error && error.message || error),
          code: 'key-error'
        })
      }
    }
    if (keyHit) matched.push(key)
  }
  return { matched: [...new Set(matched)], matchedIn: Array.from(matchedIn) }
}

// selective 判定:返回 true=通过。logic 见文件头注释(3/0/1/2)。
function selectivePass(secondaryKeys, matchedSecondary, logic) {
  const all = secondaryKeys.length
  const hit = matchedSecondary.length
  switch (logic) {
    case 3: return hit === all // 与所有:过滤器全命中
    case 0: return hit > 0 // 与任意:过滤器任一命中
    case 1: return hit < all // 非所有:过滤器并非全命中
    case 2: return hit === 0 // 非任何:过滤器全不命中
    default: return true
  }
}

export function matchEntries(views, corpus = {}) {
  const { parts } = normalizeCorpus(corpus)
  const hits = []
  const diagnostics = []

  for (const view of views) {
    if (!view.enabled) continue

    // 常驻:无论有无 key 都触发(执行与 ST "constant" 语义一致;忽略概率)
    if (view.constant) {
      hits.push({
        uidKey: view.uidKey,
        content: view.content,
        order: view.order,
        reason: 'constant',
        matchedIn: [],
        matchedKeys: [],
        matchedSecondary: [],
        view
      })
      continue
    }

    if (!view.hasKeys) continue // 非常驻且无 key:不触发

    const primary = scanKeys(view.keys, parts, view, diagnostics)
    if (primary.matched.length === 0) continue

    // ST selective:主要关键词命中后,可选过滤器按 logic 把关(过滤器为空则不设过滤)。
    let matchedSecondary = []
    if (view.selective === true && view.secondaryKeys.length > 0) {
      const sec = scanKeys(view.secondaryKeys, parts, view, diagnostics)
      matchedSecondary = sec.matched
      if (!selectivePass(view.secondaryKeys, matchedSecondary, view.selectiveLogic)) continue
    }
    hits.push({
      uidKey: view.uidKey,
      content: view.content,
      order: view.order,
      reason: 'key',
      matchedIn: primary.matchedIn,
      matchedKeys: primary.matched,
      matchedSecondary,
      view
    })
  }

  return { hits, diagnostics }
}

// 高层面板:输入语料+entries,输出命中(不做组装,组装见 assembler.js)
export function planMatches(model, corpus = {}) {
  const { hits, diagnostics } = matchEntries(model.entries, corpus)
  const matched = hits.filter((h) => h.reason === 'key')
  return {
    hits,
    diagnostics,
    stats: {
      enabled: model.entries.filter((e) => e.enabled).length,
      total: model.entries.length,
      constantHits: hits.filter((h) => h.reason === 'constant').length,
      keyHits: matched.length,
      totalChars: hits.reduce((sum, h) => sum + Array.from(h.content).length, 0)
    }
  }
}
