// host-plugin.js — dsh-universal-worldbook 的 host 级 Cordis 插件入口(M2 + M3 API)。
// llm/stream 请求级注入(零污染,不写 Session)。数据 = ~/.dsh/WorldBook/worldbooks/*.json;
// 启用 = ~/.dsh/WorldBook/enabled.json。每次注入写结构化台账 ~/.dsh/WorldBook/.injections/<sessionId>.jsonl,
// 按会话分文件、超保留期(默认 24h)自动清理——新对话即空台账,便于直观确认注入。
// 调试日志 .uwb-debug.log:仅 错误/警告 常驻;启动 INFO 需环境变量 DSH_UWB_DEBUG=1;文件超 256KB 自动重置。
// M3 换架构(2026-09-04):静态 client UI 经 webServer 数据路由 /uwb-api/* 同源 fetch 读写世界书
// (绕开封闭的 typert/会话插件;零用户感知,见策划案 §13.10)。

import { readdir, readFile, stat, appendFile, mkdir, rm, copyFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { parseWorldbook } from './lib/worldbook.js'
import { matchEntries } from './lib/matcher.js'
import { assemble } from './lib/assembler.js'
import { resolveEnabled, pathKey } from './lib/scope.js'
import { readEnabledFile, writeEnabledFile } from './lib/scope-store.js'

function str(v) { return v === null || v === undefined ? '' : String(v) }

// —— 注入块包裹文本(通用头/尾,全局配置 ~/.dsh/WorldBook/format.json)——
// 命中条目按现有 order 语义拼成 entries 文本后,注入内容 = header + entries + tail。
// 默认 tail 末尾「以下是用户本轮发言：」引导紧随其后的真实 D0(注入块本就插在 D0 前)。
const DEFAULT_FORMAT = {
  header: '以下是本轮可供参考的重要信息：\n',
  tail: '\n参考信息结束。\n\n以下是用户本轮发言：\n'
}
function formatFile(dir) { return path.join(dir, 'format.json') }
async function readFormat(dir) {
  try {
    const raw = JSON.parse((await readFile(formatFile(dir), 'utf8')).replace(/^\uFEFF/, ''))
    return {
      header: typeof raw.header === 'string' ? raw.header : DEFAULT_FORMAT.header,
      tail: typeof raw.tail === 'string' ? raw.tail : DEFAULT_FORMAT.tail
    }
  } catch {
    return { header: DEFAULT_FORMAT.header, tail: DEFAULT_FORMAT.tail }
  }
}
async function writeFormat(dir, header, tail) {
  const doc = { version: 1, header: str(header), tail: str(tail) }
  try { await copyFile(formatFile(dir), formatFile(dir) + '.bak').catch(() => { /* 无原文件则跳过 */ }) } catch { /* ignore */ }
  const tmp = formatFile(dir) + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await rename(tmp, formatFile(dir))
  return { header: doc.header, tail: doc.tail }
}

function worldbookDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'WorldBook')
}

// —— 注入行为设置(全局 ~/.dsh/WorldBook/settings.json)——
// scanDepth:关键词扫描深度 1..5,默认 3(=D0~D2);hitPreview:UI 命中预览开关(默认开)。
const DEFAULT_SETTINGS = { version: 1, scanDepth: 3, hitPreview: true }
function settingsFile(dir) { return path.join(dir, 'settings.json') }
function clampScanDepth(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : DEFAULT_SETTINGS.scanDepth
}
async function readSettings(dir) {
  try {
    const raw = JSON.parse((await readFile(settingsFile(dir), 'utf8')).replace(/^\uFEFF/, ''))
    return {
      version: 1,
      scanDepth: clampScanDepth(raw.scanDepth),
      hitPreview: raw.hitPreview === undefined ? true : raw.hitPreview === true
    }
  } catch {
    return Object.assign({}, DEFAULT_SETTINGS)
  }
}
async function writeSettings(dir, scanDepth, hitPreview) {
  const doc = {
    version: 1,
    scanDepth: clampScanDepth(scanDepth),
    hitPreview: hitPreview === undefined || hitPreview === null ? true : hitPreview === true
  }
  try { await copyFile(settingsFile(dir), settingsFile(dir) + '.bak').catch(() => { /* 无原文件则跳过 */ }) } catch { /* ignore */ }
  const tmp = settingsFile(dir) + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await rename(tmp, settingsFile(dir))
  return { scanDepth: doc.scanDepth, hitPreview: doc.hitPreview }
}

function hasText(m) {
  return Array.isArray(m && m.content) && m.content.some((b) => b && b.type === 'text' && str(b.text).trim() !== '')
}
function hasToolCall(m) {
  return Array.isArray(m && m.content) && m.content.some((b) => b && b.type === 'tool-call')
}
function messageText(m) {
  return (Array.isArray(m && m.content) ? m.content : [])
    .filter((b) => b && b.type === 'text').map((b) => str(b.text)).join('\n')
}
function isRealUser(m) {
  return m && m.role === 'user' && m.source && m.source.kind === 'user'
}
function isPureAssistant(m) {
  return m && m.role === 'assistant' && hasText(m) && !hasToolCall(m)
}
// 抽取按深度 D0..D(depth-1) 的语料(role 槽位交替:user→assistant→user…)。
// 槽位角色:偶数槽(0,2,4)=user,奇数槽(1,3)=纯文本 assistant;工具轮/插件消息跳过。
// depth 默认 3 = D0/D1/D2(与旧行为一致);depth=1 仅 D0;depth 上限 5。
// overrides(D1 回合追踪器,可选):d1Text 非空 = 用"上回合最终正文"锚定 D1(替代"最近纯文本"启发式);
//   d1Empty=true = 上回合确无正文 → 删除启发式可能越界取到的旧 D1。
function extractCorpus(messages, depth, overrides) {
  const maxSlot = Math.min(Math.max(1, Number(depth) || 3), 5)
  let d0Idx = -1
  for (let i = messages.length - 1; i >= 0; i--) if (isRealUser(messages[i])) { d0Idx = i; break }
  if (d0Idx === -1) return null
  const corpus = { d0: messageText(messages[d0Idx]), d0Idx }
  let cursor = d0Idx - 1
  for (let slot = 1; slot < maxSlot; slot++) {
    const wantUser = slot % 2 === 0
    let found = -1
    for (let j = cursor; j >= 0; j--) {
      if (wantUser ? isRealUser(messages[j]) : isPureAssistant(messages[j])) { found = j; break }
    }
    if (found === -1) break
    corpus['d' + slot] = messageText(messages[found])
    cursor = found - 1
  }
  if (overrides) {
    if (typeof overrides.d1Text === 'string' && overrides.d1Text.trim() !== '') {
      corpus.d1 = overrides.d1Text
    } else if (overrides.d1Empty === true) {
      delete corpus.d1
    }
  }
  return corpus
}

// —— /uwb-api 数据路由所需小工具 ——
function apiJson(res, code, obj) {
  const body = JSON.stringify(obj)
  try {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(body)
  } catch { /* 连接可能已断 */ }
}
function readJsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''))) }
      catch (e) { reject(new Error('invalid json body: ' + str(e && e.message))) }
    })
    req.on('error', reject)
  })
}
function safeBookId(id) {
  // 允许 Unicode 字母/数字(文件名可为中文),长度 ≤80,其余字符仅 . _ -;首字符须为字母/数字
  return typeof id === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(id) ? id : null
}
async function readEntriesMap(loreDir, id) {
  const text = await readFile(path.join(loreDir, id + '.json'), 'utf8')
  const raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  const map = raw && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries) ? raw.entries : {}
  return { map, name: raw && typeof raw.name === 'string' ? raw.name : '' }
}
function indexOrderFile(dir) { return path.join(dir, 'index.json') }
async function readBookOrder(dir) {
  try {
    const raw = JSON.parse((await readFile(indexOrderFile(dir), 'utf8')).replace(/^\uFEFF/, ''))
    return Array.isArray(raw && raw.order) ? raw.order : null
  } catch { return null }
}
async function writeBookOrder(dir, ids) {
  const doc = { version: 1, order: ids.slice() }
  try { await copyFile(indexOrderFile(dir), indexOrderFile(dir) + '.bak').catch(() => {}) } catch { /* ignore */ }
  const tmp = indexOrderFile(dir) + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await rename(tmp, indexOrderFile(dir))
}
async function atomicWriteJson(file, doc) {
  try { await copyFile(file, file + '.bak').catch(() => {}) } catch { /* ignore */ }
  const tmp = file + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}
async function mapEnabledIds(dir, fn) {
  const state = await readEnabledFile(dir)
  const mapList = (list) => {
    const out = []
    for (const id of list || []) { const v = fn(id); if (v && !out.includes(v)) out.push(v) }
    return out
  }
  const workspace = {}
  for (const k of Object.keys(state.workspace || {})) workspace[k] = mapList(state.workspace[k])
  const preset = {}
  for (const k of Object.keys(state.preset || {})) preset[k] = mapList(state.preset[k])
  await writeEnabledFile(dir, {
    version: state.version,
    global: mapList(state.global),
    workspace,
    preset,
    allowSubagents: !!state.allowSubagents
  })
}
async function fileExists(f) {
  try { await stat(f); return true } catch { return false }
}
// —— 作用域:default=最近有活动会话;byKey=指定 cwdKey;keys=去重清单 ——
function scopeOfSession(s) {
  const cwd = str((s && s.header && s.header.cwd) || '')
  return { cwd, cwdKey: cwd ? pathKey(cwd) : '', presetId: str((s && s.header && s.header.agentPreset) || '') }
}
function sessionPool(sessions) {
  if (!sessions || typeof sessions.list !== 'function') return []
  const all = sessions.list() || []
  const usable = all.filter((s) => s && s.header && !s.header.parentSession)
  return usable.length ? usable : all.filter((s) => s && s.header)
}
function pickScope(sessions) {
  try {
    const pool = sessionPool(sessions)
    let best = null
    let bestT = -1
    for (const s of pool) {
      const evs = (s.events && s.events.length) ? s.events : []
      const t = evs.length ? (evs[evs.length - 1].time || 0) : (s.header.createdAt || 0)
      if (t > bestT) { bestT = t; best = s }
    }
    return best ? scopeOfSession(best) : null
  } catch {
    return null
  }
}
function pickScopeByKey(sessions, cwdKey) {
  try {
    const pool = sessionPool(sessions)
    for (const s of pool) {
      const so = scopeOfSession(s)
      if (so.cwdKey === cwdKey) return so
    }
    return null
  } catch {
    return null
  }
}
function listScopeKeys(sessions) {
  try {
    const out = []
    for (const s of sessionPool(sessions)) {
      const k = scopeOfSession(s).cwdKey
      if (k && out.indexOf(k) < 0) out.push(k)
    }
    return out
  } catch {
    return []
  }
}
function uwbApiHandler({ dir, loreDir, getSessions, tailCache, getPreview, onSave }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://uwb.local')
      const api = url.pathname.startsWith('/uwb-api') ? url.pathname.slice('/uwb-api'.length) : url.pathname
      if (req.method === 'GET' && api === '/state') {
        const names = (await readdir(loreDir)).filter((n) => n.endsWith('.json') && !n.endsWith('.bak')).sort()
        const books = []
        for (const n of names) {
          const id = n.slice(0, -5)
          try {
            const st = await stat(path.join(loreDir, n))
            const { map } = await readEntriesMap(loreDir, id)
            books.push({ id, mtimeMs: st.mtimeMs, entryCount: Object.keys(map).length })
          } catch { /* 坏文件跳过 */ }
        }
        const enabled = await readEnabledFile(dir)
        const order = await readBookOrder(dir)
        let list = books
        if (order && order.length) {
          const byId = new Map()
          for (const b of books) byId.set(b.id, b)
          const head = []
          for (const id of order) { const b = byId.get(id); if (b) { head.push(b); byId.delete(id) } }
          list = head.concat(Array.from(byId.values()))
        }
        const sessions = getSessions ? getSessions() : null
        let scope = pickScope(sessions)
        const qws = url.searchParams.get('ws')
        const qsid = url.searchParams.get('sid')
        if (qsid && sessions && typeof sessions.get === 'function') {
          const s = sessions.get(qsid)
          if (s && s.header) scope = scopeOfSession(s)
        } else if (qws && sessions) {
          const chosen = pickScopeByKey(sessions, qws)
          if (chosen) scope = chosen
        }
        const scopes = listScopeKeys(sessions)
        const effective = resolveEnabled(enabled, { cwd: scope && scope.cwd ? scope.cwd : '', presetId: scope ? scope.presetId : '' })
        const format = await readFormat(dir)
        const settings = await readSettings(dir)
        let preview = []
        if (settings.hitPreview && getPreview && qsid && sessions && typeof sessions.get === 'function') {
          const s = sessions.get(qsid)
          if (s) preview = await getPreview(qsid, s)
        }
        return apiJson(res, 200, { ok: true, books: list, enabled, scope, scopes, effective: effective.ids, format, formatDefaults: DEFAULT_FORMAT, settings, settingsDefaults: DEFAULT_SETTINGS, preview })
      }
      if (req.method === 'GET' && api === '/settings') {
        const settings = await readSettings(dir)
        return apiJson(res, 200, { ok: true, settings, defaults: DEFAULT_SETTINGS })
      }
      if (req.method === 'POST' && api === '/settings') {
        const body = await readJsonBody(req)
        const scanDepth = body && typeof body.scanDepth === 'number' ? body.scanDepth : undefined
        const hitPreview = body && typeof body.hitPreview === 'boolean' ? body.hitPreview : undefined
        const saved = await writeSettings(dir, scanDepth === undefined ? undefined : scanDepth, hitPreview)
        return apiJson(res, 200, { ok: true, settings: saved })
      }
      if (req.method === 'POST' && api === '/toggle') {
        const body = await readJsonBody(req)
        const id = safeBookId(body && body.id)
        if (!id) return apiJson(res, 400, { ok: false, err: 'bad book id' })
        const sessions = getSessions ? getSessions() : null
        let cwdKey = ''
        const qsid2 = body && typeof body.sid === 'string' ? body.sid : ''
        if (qsid2 && sessions && typeof sessions.get === 'function') {
          const s = sessions.get(qsid2)
          if (s && s.header) cwdKey = scopeOfSession(s).cwdKey
        }
        if (!cwdKey && body && typeof body.cwdKey === 'string') cwdKey = body.cwdKey
        if (!cwdKey) {
          const dflt = pickScope(sessions)
          cwdKey = dflt ? dflt.cwdKey : ''
        }
        if (!cwdKey) return apiJson(res, 400, { ok: false, err: '无法确定工作区(无会话?)' })
        const on = !!(body && body.on)
        const state = await readEnabledFile(dir)
        const workspace = Object.assign({}, state.workspace || {})
        const arr = Array.isArray(workspace[cwdKey]) ? workspace[cwdKey].slice() : []
        const i = arr.indexOf(id)
        if (on && i < 0) arr.push(id)
        if (!on && i >= 0) arr.splice(i, 1)
        workspace[cwdKey] = arr
        await writeEnabledFile(dir, {
          version: state.version,
          global: state.global,
          workspace,
          preset: state.preset,
          allowSubagents: !!state.allowSubagents
        })
        return apiJson(res, 200, { ok: true, id, on, cwdKey })
      }
      const bm = api.match(/^\/book\/([^/]+)$/)
      if (req.method === 'GET' && bm) {
        const id = safeBookId(decodeURIComponent(bm[1]))
        if (!id) return apiJson(res, 404, { ok: false, err: 'bad book id' })
        let name = ''
        let map = {}
        try { const r = await readEntriesMap(loreDir, id); map = r.map; name = r.name } catch { /* 404 下抛 */ }
        if (Object.keys(map).length === 0 && !(await fileExists(path.join(loreDir, id + '.json')))) {
          return apiJson(res, 404, { ok: false, err: 'no such book' })
        }
        return apiJson(res, 200, { ok: true, id, name, entries: map })
      }
      if (req.method === 'POST' && api === '/save') {
        const body = await readJsonBody(req)
        const id = safeBookId(body && body.id)
        if (!id) return apiJson(res, 400, { ok: false, err: 'bad book id' })
        const entries = body && body.entries
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
          return apiJson(res, 400, { ok: false, err: 'entries must be an object' })
        }
        for (const k of Object.keys(entries)) {
          if (!entries[k] || typeof entries[k] !== 'object' || Array.isArray(entries[k])) {
            return apiJson(res, 400, { ok: false, err: 'entry "' + k + '" is not an object' })
          }
        }
        const file = path.join(loreDir, id + '.json')
        const doc = { entries }
        if (body.name && typeof body.name === 'string') doc.name = body.name
        try { await copyFile(file, file + '.bak').catch(() => { /* 无原文件则跳过备份 */ }) } catch { /* ignore */ }
        const tmp = file + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
        await rename(tmp, file)
        try { if (typeof onSave === 'function') onSave() } catch { /* 通知尽力而为 */ }
        return apiJson(res, 200, { ok: true, id, entryCount: Object.keys(entries).length })
      }
      if (req.method === 'POST' && api === '/book/create') {
        const body = await readJsonBody(req)
        const id = safeBookId(body && body.id)
        if (!id) return apiJson(res, 400, { ok: false, err: 'bad book id' })
        const file = path.join(loreDir, id + '.json')
        if (await fileExists(file)) return apiJson(res, 409, { ok: false, err: 'book 已存在: ' + id })
        await atomicWriteJson(file, { entries: {} })
        return apiJson(res, 200, { ok: true, id })
      }
      if (req.method === 'POST' && api === '/book/rename') {
        const body = await readJsonBody(req)
        const oldId = safeBookId(body && body.id)
        const newId = safeBookId(body && body.newId)
        if (!oldId || !newId) return apiJson(res, 400, { ok: false, err: 'bad ids' })
        if (oldId === newId) return apiJson(res, 200, { ok: true })
        const oldFile = path.join(loreDir, oldId + '.json')
        const newFile = path.join(loreDir, newId + '.json')
        if (!(await fileExists(oldFile))) return apiJson(res, 404, { ok: false, err: 'no such book' })
        if (await fileExists(newFile)) return apiJson(res, 409, { ok: false, err: 'book 已存在: ' + newId })
        await rename(oldFile, newFile)
        await mapEnabledIds(dir, (id) => (id === oldId ? newId : id))
        const order = await readBookOrder(dir)
        if (order) {
          const next = order.map((id) => (id === oldId ? newId : id))
          await writeBookOrder(dir, next)
        }
        return apiJson(res, 200, { ok: true, old: oldId, id: newId })
      }
      if (req.method === 'POST' && api === '/book/copy') {
        const body = await readJsonBody(req)
        const id = safeBookId(body && body.id)
        const newId = safeBookId(body && body.newId)
        if (!id || !newId) return apiJson(res, 400, { ok: false, err: 'bad ids' })
        const src = path.join(loreDir, id + '.json')
        const dst = path.join(loreDir, newId + '.json')
        if (!(await fileExists(src))) return apiJson(res, 404, { ok: false, err: 'no such book' })
        if (await fileExists(dst)) return apiJson(res, 409, { ok: false, err: 'book 已存在: ' + newId })
        await copyFile(src, dst)
        return apiJson(res, 200, { ok: true, id: newId })
      }
      if (req.method === 'POST' && api === '/book/delete') {
        const body = await readJsonBody(req)
        const id = safeBookId(body && body.id)
        if (!id) return apiJson(res, 400, { ok: false, err: 'bad book id' })
        const file = path.join(loreDir, id + '.json')
        if (!(await fileExists(file))) return apiJson(res, 404, { ok: false, err: 'no such book' })
        await rm(file, { force: true })
        await rm(file + '.bak', { force: true })
        await mapEnabledIds(dir, (x) => (x === id ? null : x))
        const order = await readBookOrder(dir)
        if (order && order.includes(id)) await writeBookOrder(dir, order.filter((x) => x !== id))
        return apiJson(res, 200, { ok: true, id })
      }
      if (req.method === 'POST' && api === '/books/order') {
        const body = await readJsonBody(req)
        const ids = Array.isArray(body && body.ids) ? body.ids : []
        for (const id of ids) { if (!safeBookId(id)) return apiJson(res, 400, { ok: false, err: 'bad id in order' }) }
        await writeBookOrder(dir, ids)
        return apiJson(res, 200, { ok: true, count: ids.length })
      }
      if (req.method === 'GET' && api === '/format') {
        const format = await readFormat(dir)
        return apiJson(res, 200, { ok: true, format, defaults: DEFAULT_FORMAT })
      }
      if (req.method === 'POST' && api === '/format') {
        const body = await readJsonBody(req)
        const header = body && typeof body.header === 'string' ? body.header.slice(0, 20000) : ''
        const tail = body && typeof body.tail === 'string' ? body.tail.slice(0, 20000) : ''
        const saved = await writeFormat(dir, header, tail)
        return apiJson(res, 200, { ok: true, format: saved })
      }
      return apiJson(res, 404, { ok: false, err: 'no route ' + req.method + ' ' + api })
    } catch (e) {
      try { return apiJson(res, 500, { ok: false, err: String((e && e.message) || e) }) } catch { /* ignore */ }
    }
  }
}

export default {
  apply(ctx) {
    const dir = worldbookDir()
    mkdir(dir, { recursive: true }).catch(() => { /* WorldBook 缺失时静默,各读写路径自带容错 */ })
    const debugFile = path.join(dir, '.uwb-debug.log')
    const injectionsDir = path.join(dir, '.injections')
    const RETENTION_MS = 24 * 3600 * 1000
    // 日志策略(M2 收尾定稿):.uwb-debug.log 常驻 错误/警告(不静默吞异常);
    // INFO 级(启动自检)仅在 DSH_UWB_DEBUG=1 时写;单文件超 256KB 自动重置。
    const DEBUG_CAP = 256 * 1024
    const dbgInfo = async (msg) => {
      if (process.env.DSH_UWB_DEBUG !== '1') return
      try { await appendFile(debugFile, new Date().toISOString() + ' [info] ' + msg + '\n', 'utf8') } catch { /* ignore */ }
    }
    const dbg = async (msg) => {
      try {
        try { if ((await stat(debugFile)).size > DEBUG_CAP) await rm(debugFile, { force: true }) } catch { /* ignore */ }
        await appendFile(debugFile, new Date().toISOString() + ' [warn/err] ' + msg + '\n', 'utf8')
      } catch { /* ignore */ }
    }

    // —— 示例世界书"安装即导入"(2026-09-05):插件自带 samples/,数据目录缺同名文件则补入;
    //   永不写入 enabled.json → 默认非激活(用户按需在工作区启用)。首轮种子成功后写标记,
    //   之后若用户删掉示例书不再复活。 ——
    const seedMarker = path.join(dir, '.samples-seeded')
    const seedSamples = async () => {
      try {
        let marker = false
        try { await stat(seedMarker); marker = true } catch { /* 无标记 */ }
        if (marker) return
        const samplesDir = fileURLToPath(new URL('samples/', import.meta.url))
        const loreDir = path.join(dir, 'worldbooks')
        await mkdir(loreDir, { recursive: true })
        const names = (await readdir(samplesDir)).filter((n) => n.endsWith('.json') && !n.endsWith('.bak')).sort()
        for (const n of names) {
          const target = path.join(loreDir, n)
          try { await stat(target); continue } catch { /* 缺 → 补入 */ }
          try {
            await copyFile(path.join(samplesDir, n), target)
            dbgInfo('sample seeded ' + n)
          } catch (e) {
            dbg('sample-seed-ERR ' + n + ' ' + str(e && (e.stack || e)))
          }
        }
        try { await appendFile(seedMarker, new Date().toISOString() + ' samples-seeded\n', 'utf8') } catch { /* ignore */ }
      } catch (e) {
        dbg('sample-seed-list-ERR ' + str(e && (e.stack || e)))
      }
    }
    seedSamples()

    // —— 命中预览支撑(必须在 registerUwbApi 之前定义;函数体内引用 ensureLoaded/vault/state,
    //    它们为后置的 let/函数声明,仅在请求到来时才被求值,届时均已初始化)——。
    // tailCache:按会话缓存最近一次见到的"文本消息尾部"(新→旧),llm/stream 时更新。
    const tailCache = new Map() // sessionId -> { items: [{role,text}](新→旧), at }
    function rememberTail(sessionId, messages) {
      try {
        if (!sessionId || !Array.isArray(messages)) return
        const items = []
        for (let i = messages.length - 1; i >= 0 && items.length < 12; i--) {
          const m = messages[i]
          if (isRealUser(m)) items.push({ role: 'user', text: messageText(m) })
          else if (isPureAssistant(m)) items.push({ role: 'assistant', text: messageText(m) })
        }
        if (items.length > 0) tailCache.set(sessionId, { items, at: Date.now() })
      } catch { /* 预览缓存尽力而为 */ }
    }
    // getPreview:返回该会话"下一轮已确定会命中"的 uidKey 列表;无历史/新会话 → 空(边界)。
    // 预览语料项:最新→最旧,仅真实 user/纯文本 assistant(与 rememberTail 同规则)
    function tailItemsFromMessages(messages) {
      const items = []
      if (!Array.isArray(messages)) return items
      for (let i = messages.length - 1; i >= 0 && items.length < 12; i--) {
        const m = messages[i]
        if (isRealUser(m)) items.push({ role: 'user', text: messageText(m) })
        else if (isPureAssistant(m)) items.push({ role: 'assistant', text: messageText(m) })
      }
      return items
    }
    const getPreview = async (sessionId, session) => {
      try {
        await ensureLoaded()
        const settings = await readSettings(dir)
        if (!settings.hitPreview) return []
        const depth = settings.scanDepth
        // 语料优先取"会话已落库消息"(重启后/未对话/非注入轮回复未入 tailCache 等场景都正确),
        // tailCache 仅作会话对象不可用的兜底。
        let items = null
        if (session && typeof session.deriveMessages === 'function') {
          try { items = tailItemsFromMessages(session.deriveMessages()) } catch { items = null }
        }
        if ((!items || items.length === 0) && sessionId) {
          const found = tailCache.get(sessionId)
          if (found && Array.isArray(found.items)) items = found.items
        }
        if (!items || items.length === 0) return []
        const corpus = {}
        for (let i = 0; i < depth - 1; i++) {
          const item = items[i]
          if (item) corpus['d' + (i + 1)] = item.text
        }
        const header = session && session.header ? session.header : {}
        const enabled = resolveEnabled(state, { cwd: str(header.cwd || ''), presetId: str(header.agentPreset || '') })
        const entries = enabled.ids.flatMap((id) => vault.get(id) || [])
        if (entries.length === 0) return []
        const { hits } = matchEntries(entries, corpus)
        return hits.map((h) => h.uidKey)
      } catch {
        return []
      }
    }
    // —— M3 换架构(2026-09-04):webServer 数据路由,静态 client UI 同源 fetch 读写(零用户感知,§13.10)。
    // apply 与 webServer 提供方先后=非确定竞态 → 有界重试 3×250ms(多数首轮即成功,无感知)
    // + 首条 llm/stream 兜底;成败写 .uwb-debug.log。
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    let apiRegistered = false
    const registerUwbApi = async () => {
      if (apiRegistered) return
      const loreDir = path.join(dir, 'worldbooks')
      let ws = ctx.get('webServer')
      for (let i = 0; i < 3 && !(ws && typeof ws.register === 'function'); i++) {
        await sleep(250)
        ws = ctx.get('webServer')
      }
      if (!(ws && typeof ws.register === 'function')) {
        dbg('uwb-api 待命:webServer 3 次重试内未就绪(将随首条 llm/stream 兜底注册)')
        return
      }
      const routeOffs = []
      try {
        routeOffs.push(ws.register({
          kind: 'prefix',
          path: '/uwb-api',
          handler: uwbApiHandler({ dir, loreDir, getSessions: () => ctx.get('sessions'), tailCache, getPreview, onSave: () => { forceVaultReload = true } })
        }))
        apiRegistered = true
        dbg('uwb-api registered @ /uwb-api')
      } catch (e) {
        dbg('webServer-register-ERR ' + str(e && e.message))
      }
      if (routeOffs.length) {
        ctx.effect(() => () => { for (const off of routeOffs) { try { off() } catch { /* ignore */ } } })
      }
    }
    const ensureUwbApi = () => { if (!apiRegistered) registerUwbApi() }
    ensureUwbApi()
    const safeId = (id) => String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')
    // —— 注入台账(诊断用,默认关闭;DSH_UWB_JOURNAL=1 开启,24h 自清)——
    // 相关代码保留以便随时启用排查;发布态默认不落盘、不建目录、不清理。
    let journalWrites = 0
    const journalEnabled = () => process.env.DSH_UWB_JOURNAL === '1'
    const pruneJournals = async () => {
      try {
        if (!journalEnabled()) return
        const cut = Date.now() - RETENTION_MS
        for (const name of await readdir(injectionsDir)) {
          if (!name.endsWith('.jsonl')) continue
          const file = path.join(injectionsDir, name)
          try { if ((await stat(file)).mtimeMs < cut) await rm(file, { force: true }) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    const journal = async (sessionId, rec) => {
      if (!journalEnabled()) return
      try {
        await mkdir(injectionsDir, { recursive: true })
        await appendFile(path.join(injectionsDir, safeId(sessionId) + '.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
        journalWrites += 1
        if (journalWrites % 50 === 1) await pruneJournals()
      } catch { /* ignore */ }
    }

    // —— 请求级上下文 trace(诊断用,默认关闭;DSH_UWB_TRACE=1 开启)——
    // 目标:不靠"问模型",直接落盘每次主请求实际出站的上下文全文(role/source/文本),
    // 以及注入/剥离改写后的版本,便于自查"模型这一轮到底看到了什么/是否被污染"。
    // 落盘:~/.dsh/WorldBook/.trace/<sessionId>.jsonl,单文件大小自节流。
    // 相关代码保留以便随时启用排查;发布态默认不落盘、不建目录、不写启动标记。
    const traceEnabled = () => process.env.DSH_UWB_TRACE === '1'
    const traceDir = path.join(dir, '.trace')
    if (traceEnabled()) {
      mkdir(traceDir, { recursive: true })
        .then(() => appendFile(path.join(traceDir, '_enabled'), new Date().toISOString() + ' trace-on pid=' + process.pid + '\n', 'utf8'))
        .catch((e) => dbg('trace-init-ERR ' + str(e && e.stack || e)))
    }
    const TRACE_MAX_BYTES = 64 * 1024 * 1024
    let traceSeq = 0
    // 落盘"实际发给模型提供商的请求"近似体:完整消息全文(不截断),贴近 GenerateOptions。
    // 每次写入失败都会记入 .uwb-debug.log(不静默)。
    const trace = async (sessionId, stage, options, extra) => {
      if (!traceEnabled()) return
      try {
        const messages = Array.isArray(options && options.messages) ? options.messages : []
        const rows = messages.map((m, i) => {
          const src = (m && m.source) || {}
          const isInjected = src.kind === 'plugin' && String(src.plugin || '').includes('worldbook')
          return {
            i,
            role: m && m.role,
            src: src.kind || null,
            plugin: isInjected ? (src.plugin || null) : null,
            form: src.form || null,
            injected: isInjected,
            // 完整文本全文;content 可能含多块(文本/工具调用等),全部保留
            content: Array.isArray(m && m.content) ? m.content : (m && m.content !== undefined ? m.content : null)
          }
        })
        traceSeq += 1
        const rec = {
          ts: new Date().toISOString(),
          seq: traceSeq,
          sessionId,
          stage, // 'enter' = 拦截器见到的原请求;'injected' = 改写后重派发请求
          purpose: options && options.purpose,
          provider: options && options.provider,
          model: options && options.model,
          system: typeof (options && options.system) === 'string' ? options.system : undefined,
          d0Idx: extra ? extra.d0Idx : undefined,
          injectedCount: rows.filter((r) => r.injected).length,
          messageCount: rows.length,
          messages: rows
        }
        await mkdir(traceDir, { recursive: true })
        const file = path.join(traceDir, safeId(sessionId) + '.jsonl')
        try { if ((await stat(file)).size > TRACE_MAX_BYTES) await rm(file, { force: true }) } catch { /* 文件不存在可忽略 */ }
        await appendFile(file, JSON.stringify(rec) + '\n', 'utf8')
      } catch (e) {
        await dbg('trace-write-ERR ' + str(e && e.stack || e))
      }
    }

    let vault = new Map()
    let state = { global: [], workspace: {}, preset: {}, allowSubagents: false }
    let fileSig = ''
    let enabledMtime = 0
    // 世界书保存后强制重载(指纹可能因"同毫秒+同字节数"失效 → 编辑可能不被预览/注入感知)
    let forceVaultReload = false

    async function mtimeOf(file) {
      try { return (await stat(file)).mtimeMs } catch { return -1 }
    }
    // 文件指纹 = mtime + size(重载判定用;size 兜底同毫秒写入的边缘情况)
    async function statFingerprint(file) {
      try {
        const s = await stat(file)
        return s.mtimeMs + ':' + s.size
      } catch {
        return '-1'
      }
    }

    // —— M3 隐患#4 修复(2026-09-04):ensureLoaded 并发去重(in-flight 保护)——
    let loading = null
    async function ensureLoaded() {
      if (loading) return loading
      const loreDir = path.join(dir, 'worldbooks')
      let names = []
      try { names = (await readdir(loreDir)).filter((n) => n.endsWith('.json') && !n.endsWith('.bak')).sort() } catch { names = [] }
      const em = await mtimeOf(path.join(dir, 'enabled.json'))
      // 签名 = 文件名 + 每文件指纹(mtime+size):编辑保存后即使文件名/enabled.json 未变,
      // 内容变更也要重载 vault;size 兜底同毫秒连续写入。
      let sig = ''
      try {
        const parts = []
        for (const n of names) parts.push(n + '@' + (await statFingerprint(path.join(loreDir, n))))
        sig = parts.join('|')
      } catch { sig = names.join('|') }
      if (!forceVaultReload && sig === fileSig && em === enabledMtime && vault.size > 0) return
      if (loading) return loading // 读盘期间他人已开始加载
      loading = (async () => {
        const next = new Map()
        for (const name of names) {
          try {
            const text = await readFile(path.join(loreDir, name), 'utf8')
            const model = parseWorldbook(JSON.parse(text.replace(/^\uFEFF/, '')))
            const id = name.replace(/\.json$/, '')
            next.set(id, model.entries.map((v) => Object.assign({}, v, { uidKey: id + '::' + v.uidKey })))
          } catch (e) {
            await dbg('vault-skip ' + name + ' ' + str(e && e.message))
          }
        }
        fileSig = sig
        enabledMtime = em
        forceVaultReload = false
        vault = next
        state = await readEnabledFile(dir)
      })()
      try { return await loading } finally { loading = null }
    }

    function sessionMeta(sessionId) {
      try {
        const sessions = ctx.get('sessions')
        const s = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
        if (!s) return null
        const header = (s && s.header) || s
        return {
          cwd: str(header.cwd || ''),
          presetId: str(header.agentPreset || header.presetId || ''),
          depth: Number(header.delegationDepth || 0)
        }
      } catch {
        return null
      }
    }

    // —— D1 回合追踪器(2026-09-05,M4;替代纯角色启发式)——
    // 用 session/event(post-commit 事件流)按会话维护"上一回合最终正文":
    //   user/message(新回合开始) → 把 pendingFinal(上个回合最近一条带文本的 assistant 正文)固化为 d1;
    //   assistant/message 带文本 → 记为 pendingFinal(工具步/空文本不覆盖)。
    // 扫描语料时:台账与当前请求 D0 对上 → 用它锚定 D1;上回合确无正文 → 显式置空(防越界取旧文);
    //   台账缺失/D0 对不上(含事件流滞后竞态)→ 返回 undefined,调用方回退原启发式(零行为退化)。
    const turnTrack = new Map() // sessionId -> { curUser: {id}|null, pendingFinal: {text}|null, d1: {text}|null, at }
    ctx.on('session/event', (session, event) => {
      try {
        const sid = str(session && session.id)
        if (sid === '') return
        let t = turnTrack.get(sid)
        if (!t) { t = { curUser: null, pendingFinal: null, d1: null, at: 0 }; turnTrack.set(sid, t) }
        t.at = Date.now()
        const type = event && event.type
        const data = (event && event.data) || {}
        if (type === 'user/message') {
          const m = data
          const mid = m && m.id
          if (mid) {
            t.d1 = t.pendingFinal && t.pendingFinal.text !== '' ? { text: t.pendingFinal.text } : null
            t.pendingFinal = null
            t.curUser = { id: str(mid) }
          }
        } else if (type === 'assistant/message') {
          const m = data && data.message
          const text = m ? str(messageText(m)).trim() : ''
          if (text !== '' && m && m.id) t.pendingFinal = { id: str(m.id), text }
        }
        // 简单防泄漏:超过 300 会话时清掉最旧一条(回合台账是短效缓存,重建代价=回退启发式)
        if (turnTrack.size > 300) {
          let oldest = null
          for (const [k, v] of turnTrack) if (!oldest || v.at < oldest.v.at) oldest = { k, v }
          if (oldest) turnTrack.delete(oldest.k)
        }
      } catch { /* 追踪尽力而为,失败不影响主路径 */ }
    })
    // D1 锚读取:undefined = 回退启发式;{d1Text}=上回合有正文;{d1Empty}=上回合无正文。
    function trackedD1(sessionId, messages) {
      if (sessionId === '') return undefined
      const t = turnTrack.get(sessionId)
      if (!t) return undefined
      let d0id = ''
      const arr = Array.isArray(messages) ? messages : []
      for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i]
        if (m && m.role === 'user' && m.source && m.source.kind === 'user') { d0id = str(m.id); break }
      }
      if (d0id !== '' && t.curUser && t.curUser.id && d0id !== t.curUser.id) return undefined
      if (t.d1 && t.d1.text && t.d1.text.trim() !== '') { dbgInfo('d1-track anchor sid=' + sessionId); return { d1Text: t.d1.text } }
      if (t.curUser) { dbgInfo('d1-track empty sid=' + sessionId); return { d1Empty: true } }
      return undefined
    }

    const allowed = new Set()
    ctx.on('agent/pre-step', (payload, next) => {
      const agent = payload && payload.agent
      const id = str((agent && agent.session && agent.session.id) || (agent && agent.id) || '')
      if (id !== '') allowed.add(id)
      return next()
    })

    // —— A 方案(2026-09-05):lore_lookup 结果逐轮剥离 + 同轮防重复护栏 ——
    // trace 实证:原生工具 tool-call/tool-result 会持久化并重放于下轮 D0 前 → 剥离层必要。
    const LORE_TOOL_NAME = 'lore_lookup'
    const LORE_LOOKUP_TURN_CAP = 6
    // 会话回合态:检测到新的真实用户消息 = 新回合 → 清空"本轮已提供"台账与查询计数。
    const turnState = new Map() // sessionId -> { d0Id, provided: Set<uidKey>, lookups }
    function d0IdOf(messages) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m && m.role === 'user' && m.source && m.source.kind === 'user') {
          const id = m.id
          return (typeof id === 'string' && id !== '') ? id : 't:' + str(messageText(m)).slice(0, 60)
        }
      }
      return ''
    }
    // 剥离:D0 之前的 lore_lookup tool-call 块与其配对 tool-result 消息从请求副本剔除,
    // 保留同一条 assistant 消息里的其他文本块(防误删模型当句写下的剧情)。
    // 返回 null = 无需剥离。剥离只动旧区(i<d0);本轮(i>d0)续步的查询对保留。
    function stripLoreArtifacts(messages) {
      if (!Array.isArray(messages)) return null
      let d0 = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m && m.role === 'user' && m.source && m.source.kind === 'user') { d0 = i; break }
      }
      if (d0 <= 0) return null
      const loreIds = new Set()
      for (let i = 0; i < d0; i++) {
        const m = messages[i]
        if (m && m.role === 'assistant' && Array.isArray(m.content)) {
          for (const b of m.content) if (b && b.type === 'tool-call' && b.name === LORE_TOOL_NAME && b.id) loreIds.add(b.id)
        }
      }
      if (loreIds.size === 0) return null
      const isLoreResult = (m) => m && m.role === 'user' && m.source && m.source.kind === 'tool' && Array.isArray(m.content) &&
        m.content.some((b) => b && b.type === 'tool-result' && b.toolCallId && loreIds.has(b.toolCallId))
      const out = []
      let changed = false
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (i < d0) {
          if (isLoreResult(m)) { changed = true; continue }
          if (m && m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool-call' && b.name === LORE_TOOL_NAME)) {
            const rest = m.content.filter((b) => !(b && b.type === 'tool-call' && b.name === LORE_TOOL_NAME))
            if (rest.length === 0) { changed = true; continue } // 纯调用消息 → 整条删
            changed = true
            out.push(Object.assign({}, m, { content: rest }))
            continue
          }
        }
        out.push(m)
      }
      return changed ? { d0Idx: d0, messages: out } : null
    }
    // 转发一个已重写(剥离或注入)的请求:llm.stream + 顺带捕获正文更新 tailCache。
    async function* streamRequest(request, sessionId) {
      const llm = ctx.get('llm')
      if (!llm || typeof llm.stream !== 'function') return
      let replyText = ''
      try {
        for await (const chunk of llm.stream(request)) {
          try { if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') replyText += chunk.text } catch { /* ignore */ }
          yield chunk
        }
      } finally {
        if (sessionId !== '' && replyText.trim() !== '') {
          try {
            const rec = tailCache.get(sessionId)
            if (rec) {
              rec.items = [{ role: 'assistant', text: replyText }].concat(rec.items).slice(0, 12)
              rec.at = Date.now()
              tailCache.set(sessionId, rec)
            }
          } catch { /* ignore */ }
        }
      }
    }

    const rewrites = new WeakSet()
    ctx.on('llm/stream', async function* (options, next) {
      try {
        if (rewrites.has(options)) { yield* next(); return }
        if (!options || typeof options !== 'object') { yield* next(); return }
        if (options.purpose !== undefined) { yield* next(); return }
        ensureUwbApi() // 兜底:首条消息时若 /uwb-api 路由未注册则补注册(此刻 webServer 必然已就绪)
        const sessionId = str(options && options.sessionId)
        const meta = sessionId !== '' ? sessionMeta(sessionId) : null
        if (meta !== null && meta.depth > 0 && !state.allowSubagents) { yield* next(); return }
        if (meta === null && allowed.size > 0 && !allowed.has(sessionId)) { yield* next(); return }
        if (sessionId !== '') await trace(sessionId, 'enter', options, null) // 原请求上下文快照

        try { await ensureLoaded() } catch (e) { await dbg('ensureLoaded-ERR ' + str(e && e.message)); yield* next(); return }
        const rawMessages = Array.isArray(options.messages) ? options.messages : []
        if (sessionId !== '') rememberTail(sessionId, rawMessages)

        // 回合态刷新:出现新的真实用户消息 = 新回合,清空防重复台账与查询计数。
        if (sessionId !== '') {
          const d0id = d0IdOf(rawMessages)
          const st0 = turnState.get(sessionId)
          if (!st0 || st0.d0Id !== d0id) turnState.set(sessionId, { d0Id: d0id, provided: new Set(), lookups: 0 })
        }

        // 剥离旧回合残留的 lore 工具消息(trace 实证:它们会重放于下轮 D0 前)。
        const stripRes = stripLoreArtifacts(rawMessages)
        const messages = stripRes ? stripRes.messages : rawMessages

        // —— 注入判定(在剥离后的消息上做,保证扫描语料不含旧查询残留)——
        let corpus = null
        let hits = []
        if (vault.size > 0) {
          const settings = await readSettings(dir)
          const enabled = resolveEnabled(state, { cwd: meta ? meta.cwd : '', presetId: meta ? meta.presetId : '' })
          corpus = extractCorpus(messages, settings.scanDepth, trackedD1(sessionId, messages))
          if (corpus) {
            const entries = enabled.ids.flatMap((id) => vault.get(id) || [])
            if (entries.length > 0) {
              const mr = matchEntries(entries, corpus)
              hits = mr && mr.hits ? mr.hits : []
            }
          }
        }

        let nextMessages = messages.slice()
        let injectedStage = false
        if (hits.length > 0) {
          const block = assemble(hits)
          if (block.text !== '') {
            const fmt = await readFormat(dir)
            const wrapHeader = typeof fmt.header === 'string' ? fmt.header : DEFAULT_FORMAT.header
            const wrapTail = typeof fmt.tail === 'string' ? fmt.tail : DEFAULT_FORMAT.tail
            const text = wrapHeader + block.text + wrapTail

            await journal(sessionId, {
              ts: new Date().toISOString(),
              sessionId,
              cwd: meta ? meta.cwd : '',
              preset: meta ? meta.presetId : '',
              matched: hits.map((h) => h.uidKey),
              count: hits.length,
              chars: text.length,
              text: text.slice(0, 400),
              d0: str(corpus.d0).slice(0, 120)
            })

            const marker = {
              id: 'dsh-uwb-host-' + sessionId.slice(-6) + '-' + Date.now().toString(36),
              role: 'user',
              content: [{ type: 'text', text }],
              source: {
                kind: 'plugin',
                plugin: 'dsh-universal-worldbook',
                form: 'snapshot',
                sections: block.sections.map((s) => ({ name: 'uwb:' + s.uidKey, text: s.content }))
              }
            }
            nextMessages.splice(corpus.d0Idx, 0, marker)
            injectedStage = true
            // 本轮已注入的条目计入"已提供"台账(防模型对本轮已给内容重复调用工具)
            if (sessionId !== '') {
              const st1 = turnState.get(sessionId)
              if (st1) for (const h of hits) st1.provided.add(h.uidKey)
            }
          }
        }

        if (!injectedStage && stripRes === null) { yield* next(); return } // 无事可做:原样放行
        const request = Object.assign({}, options, { messages: nextMessages })
        rewrites.add(request)
        const extra = { d0Idx: injectedStage && corpus ? corpus.d0Idx : (stripRes ? stripRes.d0Idx : undefined) }
        if (sessionId !== '') await trace(sessionId, injectedStage ? 'injected' : 'stripped', request, extra)
        yield* streamRequest(request, sessionId)
        return
      } catch (e) {
        await dbg('stream-ERR ' + str(e && e.stack || e))
        yield* next()
      }
    }, { global: true })

    // —— lore_lookup 工具(2026-09-05 A 方案正式实现;原为验证探针,验证通过后转正)——
    // host 全局层 ctx 无 tools 服务(tools 按 agent 作用域提供)→ 借 agent/created 的 agent.ctx 注册;
    // 只注册"根 agent"(子代理不可见,与 G10 默认一致,allowSubagents 联动留给后续扩展)。
    // 语义:查【当前作用域已启用】世界书条目(与注入同源 resolveEnabled);
    //       同轮防重复(护栏,边界3):本轮已注入或已查询过的同一条目 → 只回提示不回正文。
    function agentScopeOf(exec) {
      try {
        const agent = exec && exec.agent
        if (!agent) return null
        const h = (agent && agent.session && agent.session.header) || null
        if (h) return { cwd: str(h.cwd), presetId: str(h.agentPreset) }
        const svc = ctx.get('sessions')
        const s = svc && typeof svc.get === 'function' ? svc.get(str(agent.id)) : null
        const h2 = s && s.header ? s.header : null
        if (h2) return { cwd: str(h2.cwd), presetId: str(h2.agentPreset) }
        return null
      } catch { return null }
    }
    function isSubagentAgent(agent) {
      try {
        const h = (agent && agent.session && agent.session.header) || null
        if (h) return !!(h.parentSession || (h.delegationDepth || 0) > 0 || h.origin === 'subagent')
        const svc = ctx.get('sessions')
        const s = svc && typeof svc.get === 'function' ? svc.get(str(agent && agent.id)) : null
        const h2 = s && s.header ? s.header : null
        if (h2) return !!(h2.parentSession || (h2.delegationDepth || 0) > 0 || h2.origin === 'subagent')
        return false // 读不到 header 视为根代理,避免主会话漏注册
      } catch { return false }
    }
    const loreDisposers = new Map() // agentId -> disposer
    const buildLoreTool = () => ({
      name: LORE_TOOL_NAME,
      description:
        '查询当前作用域已启用世界书中某类条目的详细资料。仅当本轮上下文缺少所需详细资料时调用，若资料已在本轮参考信息中，不要重复查询。返回该条目的资料原文。',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: '要查询的条目名称或类型关键词,如:盗贼、土匪、死灵法师'
          }
        },
        required: ['target'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
          additionalProperties: false
        },
        render(_args, value) {
          return [{ type: 'text', text: str(value && value.content) }]
        }
      },
      async execute(args, exec) {
        const rawTarget = str(args && args.target).trim()
        const target = rawTarget.toLowerCase()
        if (target === '') throw new Error('lore_lookup: 缺少 target 参数')
        await ensureLoaded()
        const agent = exec && exec.agent
        const agentId = str((agent && agent.id) || '')
        const scope = agentScopeOf(exec)
        let enabled
        try {
          enabled = resolveEnabled(state, { cwd: scope ? scope.cwd : '', presetId: scope ? scope.presetId : '' })
        } catch { enabled = { ids: [] } }
        const pool = enabled && Array.isArray(enabled.ids) ? enabled.ids.flatMap((id) => vault.get(id) || []) : []
        if (pool.length === 0) throw new Error('lore_lookup: 当前作用域未启用任何世界书条目(请在通用世界书窗口启用后重试)')
        const exact = pool.filter((v) => (v.keys || []).some((k) => k.toLowerCase() === target))
        const matches = exact.length > 0
          ? exact
          : pool.filter((v) => [v.comment].concat(v.keys || []).join(' ').toLowerCase().indexOf(target) >= 0)
        if (matches.length === 0) throw new Error('lore_lookup: 启用条目中未找到与 "' + rawTarget + '" 匹配的条目')
        const uniq = []
        const seenUid = new Set()
        for (const v of matches) if (!seenUid.has(v.uidKey)) { seenUid.add(v.uidKey); uniq.push(v) }
        if (uniq.length > 1) {
          return { content: '目标 "' + rawTarget + '" 匹配多个条目:' + uniq.map((v) => '「' + v.comment + '」').join('、') + '。请用更具体的名称再次查询。' }
        }
        const hit = uniq[0]
        // 同轮防重复护栏(边界3,2026-09-05 确认可做)
        if (agentId !== '') {
          const st = turnState.get(agentId)
          if (st) {
            if (st.provided.has(hit.uidKey)) {
              return { content: '条目「' + hit.comment + '」的详细资料已在本轮提供(参考块或此前查询),直接使用即可,无需重复获取。' }
            }
            if (st.lookups >= LORE_LOOKUP_TURN_CAP) {
              return { content: '本轮 lore_lookup 查询已达上限(' + LORE_LOOKUP_TURN_CAP + ' 次),请基于已有信息继续;下一轮可再次查询。' }
            }
            st.lookups += 1
            st.provided.add(hit.uidKey)
          }
        }
        return { content: hit.content }
      }
    })
    const registerLoreFor = (agent) => {
      try {
        const id = str(agent && agent.id)
        if (id === '') return
        if (loreDisposers.has(id)) return // 已注册过
        if (isSubagentAgent(agent)) { dbgInfo('lore_lookup skip subagent ' + id); return }
        const actx = agent && agent.ctx
        if (!actx || typeof actx.get !== 'function') { dbg('lore_lookup: agent.ctx 缺失 id=' + id); return }
        const toolsSvc = actx.get('tools')
        if (!toolsSvc || typeof toolsSvc.register !== 'function') { dbg('lore_lookup: agent tools 不可用 id=' + id); return }
        const disposeTool = toolsSvc.register(buildLoreTool())
        loreDisposers.set(id, disposeTool)
        dbgInfo('lore_lookup registered for agent ' + id)
      } catch (e) {
        dbg('lore_lookup agent-register-ERR ' + str(e && (e.stack || e)))
      }
    }
    ctx.on('agent/created', (payload) => {
      registerLoreFor(payload && payload.agent)
    })
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent
        const id = str(agent && agent.id)
        const disposeTool = loreDisposers.get(id)
        if (disposeTool) { try { disposeTool() } catch { /* ignore */ } loreDisposers.delete(id) }
        if (id !== '') turnTrack.delete(id) // 会话消亡,回合台账一并清理
      } catch { /* ignore */ }
    })
    // 启动时给进程内已有 agent 补注册(插件加载晚于 agent 创建的情形)
    try {
      const agentsSvc = ctx.get('agents')
      if (agentsSvc && typeof agentsSvc.list === 'function') {
        for (const agent of agentsSvc.list() || []) registerLoreFor(agent)
      }
    } catch (e) {
      dbg('lore_lookup backfill-ERR ' + str(e && (e.stack || e)))
    }

    dbgInfo('apply-ran pid=' + process.pid)
    pruneJournals()
  }
}
