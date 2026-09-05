// plan.js — 高层"命中预览":语料 → worldbook → 命中明细 + 组装块。UI 预览与注入层共用。

import { planMatches } from './matcher.js'
import { assemble } from './assembler.js'

export function plan(corpus, model, options = {}) {
  const { hits, diagnostics, stats } = planMatches(model, corpus)
  const block = assemble(hits, options)
  return { hits, diagnostics, stats, block }
}
