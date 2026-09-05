// scope.js — 作用域启用路由(纯函数,可单测)。
// 数据来源 ~/.dsh/WorldBook/enabled.json(见策划案 §6.6/§9 M2)。
// 语义:一个世界书文件(id = 文件名去 .json)被启用,当且仅当它出现在 global、
// 或当前 workspace(cwd)的映射、或当前 agent preset 的映射中(三者取并集)。
// 子代理默认不可见,allowSubagents=true 时放开(全局开关,v1)。

function toArr(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  return []
}

// Windows 路径归一化为 '/' 形式,去掉结尾斜杠,便于作为稳定 key
export function pathKey(value) {
  return String(value || '').replaceAll('\\', '/').replace(/\/+$/, '') || ''
}

function stringMapOf(value, keyFn) {
  const out = {}
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[keyFn(k)] = toArr(v)
  }
  return out
}

export function normalizeState(state = {}) {
  return {
    version: Number(state.version) || 1,
    global: toArr(state.global),
    workspace: stringMapOf(state.workspace, pathKey),   // workspace key 做路径归一化
    preset: stringMapOf(state.preset, (k) => String(k)), // preset id 保持原样
    allowSubagents: state.allowSubagents === true
  }
}

// 返回 { ids, cwdKey, presetId, allowSubagents, matchedLayers }
export function resolveEnabled(state, context = {}) {
  const s = normalizeState(state)
  const cwdKey = pathKey(context.cwd || '')
  const presetId = String(context.presetId || '')
  const ids = new Set()
  const matchedLayers = []
  for (const id of s.global) ids.add(id)
  if (s.global.length > 0) matchedLayers.push('global')
  const w = s.workspace[cwdKey]
  if (w) {
    for (const id of w) ids.add(id)
    matchedLayers.push('workspace:' + cwdKey)
  }
  const p = s.preset[presetId]
  if (p) {
    for (const id of p) ids.add(id)
    matchedLayers.push('preset:' + presetId)
  }
  return {
    ids: Array.from(ids),
    cwdKey,
    presetId,
    allowSubagents: s.allowSubagents,
    matchedLayers
  }
}
