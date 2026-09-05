// worldbook.js — SillyTavern 兼容 worldbook JSON 的无损模型。
// 原则:原对象是唯一真相;只解释我们实现的字段,未实现/未知字段原样保留。

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value) {
  return value === null || value === undefined ? '' : String(value)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function toArrayKeys(value) {
  if (Array.isArray(value)) return value.map(str).filter((k) => k.trim() !== '')
  const text = str(value).trim()
  if (text === '') return []
  // 兼容把 key 存成逗号分隔字符串的写法
  return text.split(',').map((k) => k.trim()).filter(Boolean)
}

// 解析后的单条 entry 视图:uidKey 保留原 JSON 对象键(如 "0"),raw 为原条目对象。
export function entryView(raw, uidKey) {
  const content = str(raw && raw.content)
  const orderNum = Number(raw && raw.order)
  const keys = toArrayKeys(raw && raw.key)
  const secondaryKeys = toArrayKeys(raw && raw.keysecondary)
  // ST 格式用 disable 控制开关(真实文件无 enabled 字段,参考 测试世界书.json)
  const enabled = !(raw && raw.disable === true) && content.trim() !== ''
  const constant = raw && raw.constant === true
  return Object.freeze({
    uidKey: String(uidKey),
    raw,
    content,
    keys,
    secondaryKeys,
    hasKeys: keys.length > 0,
    constant,
    enabled,
    order: Number.isFinite(orderNum) ? orderNum : 100,
    position: raw && raw.position !== undefined && raw.position !== null ? Number(raw.position) : null,
    caseSensitive: raw && raw.caseSensitive === true,
    matchWholeWords: raw && raw.matchWholeWords === true,
    selective: raw && raw.selective === true,
    selectiveLogic: (() => { const n = Number(raw && raw.selectiveLogic); return Number.isFinite(n) ? Math.round(n) : 0 })(),
    comment: str(raw && raw.comment)
  })
}

// 顶层 worldbook 结构解析(无损)。model = { raw, name, entries: entryView[], uidKeys: string[] }
export function parseWorldbook(source) {
  const raw = clone(isObject(source) ? source : {})
  const entriesMap = isObject(raw.entries) ? raw.entries : {}
  const uidKeys = Object.keys(entriesMap).sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    const diff = (Number.isFinite(na) ? na : Infinity) - (Number.isFinite(nb) ? nb : Infinity)
    return diff !== 0 && Number.isFinite(diff) ? diff : a < b ? -1 : 1
  })
  const views = uidKeys.map((uidKey) => entryView(entriesMap[uidKey], uidKey))
  return {
    raw,
    name: str(raw.name),
    uidKeys,
    entries: views,
    entryCount: views.length
  }
}

// 序列化:在 raw(深拷贝)上执行修改,返回新的 model? 为保持简单,提供对 raw 的就地修改并返回 model.
export function serializeWorldbook(model) {
  return clone(model.raw)
}

export function toJsonString(model, space = 2) {
  return JSON.stringify(clone(model.raw), null, space) + '\n'
}

// ---- 编辑操作(无损:只写白名单字段,其余字段原样保留) ----
// 白名单 = 真实 ST worldbook 字段中编辑器需要管理的字段(参考 测试世界书.json)
const KNOWN_FIELD_WRITERS = {
  key: (raw, value) => { raw.key = toArrayKeys(value) },
  keysecondary: (raw, value) => { raw.keysecondary = toArrayKeys(value) },
  comment: (raw, value) => { raw.comment = str(value) },
  content: (raw, value) => { raw.content = str(value) },
  constant: (raw, value) => { raw.constant = value === true },
  order: (raw, value) => {
    const n = Number(value)
    raw.order = Number.isFinite(n) ? n : raw.order
  },
  position: (raw, value) => { raw.position = value === null || value === undefined ? null : Number(value) },
  disable: (raw, value) => { raw.disable = value === true },
  caseSensitive: (raw, value) => { raw.caseSensitive = value === true },
  matchWholeWords: (raw, value) => { raw.matchWholeWords = value === true }
}

export function setEntryField(model, uidKey, field, value) {
  if (!KNOWN_FIELD_WRITERS[field]) throw new Error('未知字段(只允许写白名单字段以保持无损):' + field)
  if (!isObject(model.raw.entries)) model.raw.entries = {}
  const raw = model.raw.entries[uidKey]
  if (!isObject(raw)) throw new Error('条目不存在: ' + uidKey)
  KNOWN_FIELD_WRITERS[field](raw, value)
  refresh(model)
  return model
}

export function addEntry(model, patch = {}) {
  if (!isObject(model.raw.entries)) model.raw.entries = {}
  // 分配下一个数字 uidKey
  let max = -1
  for (const key of Object.keys(model.raw.entries)) {
    const n = Number(key)
    if (Number.isFinite(n) && n > max) max = n
  }
  const uidKey = String(max + 1)
  const raw = {}
  for (const [field, writer] of Object.entries(KNOWN_FIELD_WRITERS)) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) writer(raw, patch[field])
    else if (field === 'content') raw.content = ''
    else if (field === 'comment') raw.comment = ''
    else if (field === 'disable') raw.disable = false
    else if (field === 'order') raw.order = 100
  }
  // 保留未知 patch 字段(扩展字段)
  for (const [field, value] of Object.entries(patch)) {
    if (!KNOWN_FIELD_WRITERS[field]) raw[field] = clone(value)
  }
  if (raw.key === undefined) raw.key = []
  if (raw.keysecondary === undefined) raw.keysecondary = []
  if (raw.displayIndex === undefined) raw.displayIndex = 0
  model.raw.entries[uidKey] = raw
  refresh(model)
  return { model, uidKey, entry: entryView(raw, uidKey) }
}

export function removeEntry(model, uidKey) {
  if (isObject(model.raw.entries)) delete model.raw.entries[uidKey]
  refresh(model)
  return model
}

// 重算 entries 视图
function refresh(model) {
  const entriesMap = isObject(model.raw.entries) ? model.raw.entries : {}
  const uidKeys = Object.keys(entriesMap).sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1))
  model.uidKeys = uidKeys
  model.entries = uidKeys.map((uidKey) => entryView(entriesMap[uidKey], uidKey))
  model.entryCount = model.entries.length
  model.name = str(model.raw.name)
}
