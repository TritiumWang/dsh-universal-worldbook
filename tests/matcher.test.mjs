import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorldbook } from '../lib/worldbook.js'
import { matchEntries, planMatches, normalizeCorpus } from '../lib/matcher.js'

function wb(entries, name = 't') {
  return parseWorldbook({ name, entries })
}

function entry(over = {}) {
  return Object.assign({ key: [], keysecondary: [], content: 'c', constant: false, order: 100, disable: false, displayIndex: 0, comment: '' }, over)
}

test('常驻条目无关键词也触发', () => {
  const model = wb({ '0': entry({ constant: true, content: '警察' }) })
  const { hits } = matchEntries(model.entries, { d0: '你好' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].reason, 'constant')
})

test('纯文本 key:D0 命中、大小写不敏感;缺席不触发', () => {
  const model = wb({ '0': entry({ key: ['unity'], content: 'U 经验' }), '1': entry({ key: ['gui'], content: 'G 经验' }) })
  const r1 = matchEntries(model.entries, { d0: '我在写 Unity GUI 代码' })
  assert.equal(r1.hits.length, 2)
  assert.deepEqual(r1.hits[0].matchedIn.sort(), ['d0'])
  const r2 = matchEntries(model.entries, { d0: '写个排序算法' })
  assert.equal(r2.hits.length, 0)
})

test('D0/D1/D2 各自可命中并记录来源', () => {
  const model = wb({ '0': entry({ key: ['苹果'], content: '苹果是水果' }) })
  const r = matchEntries(model.entries, { d0: '', d1: '他提到了苹果', d2: '你还好吗' })
  assert.equal(r.hits.length, 1)
  assert.deepEqual(r.hits[0].matchedIn, ['d1'])
})

test('扫描深度扩展:更早语料 d3/d4 参与匹配并记录来源(host extractCorpus 深度 1..5)', () => {
  const model = wb({ '0': entry({ key: ['橘子'], content: '橘子是水果' }) })
  const r = matchEntries(model.entries, { d0: '今天写代码', d1: '', d2: '', d3: '他提过橘子', d4: '' })
  assert.equal(r.hits.length, 1)
  assert.deepEqual(r.hits[0].matchedIn, ['d3'])
  const r2 = matchEntries(model.entries, { d0: '', d1: '', d2: '', d3: '', d4: '昨天聊了橘子' })
  assert.equal(r2.hits.length, 1)
  assert.deepEqual(r2.hits[0].matchedIn, ['d4'])
})

test('normalizeCorpus 兼容任意深度字段并忽略空槽(预览语料用 d1..d4)', () => {
  assert.equal(normalizeCorpus({ d0: '', d1: 'a', d2: '', d3: 'b', d4: '' }).parts.length, 2)
  assert.deepEqual(normalizeCorpus({ d1: 'x', d2: 'y' }).parts.map((p) => p.source), ['d1', 'd2'])
})

test('正则 key 生效(带 flag)', () => {
  const model = wb({
    '0': entry({ key: ['/(?:unity|ue)/i'], content: '引擎经验' }),
    '1': entry({ key: ['/^bug[ 0-9]*$/'], content: 'bug 处理流程' })
  })
  const r1 = matchEntries(model.entries, { d0: 'unity 的 UI' })
  assert.equal(r1.hits.length, 1)
  assert.equal(r1.hits[0].uidKey, '0')
  const r2 = matchEntries(model.entries, { d0: 'bug 123' })
  assert.ok(r2.hits.some((h) => h.uidKey === '1'))
  // 锚定正则只匹配整段纯目标文本:带其他内容时不误命中
  const r3 = matchEntries(model.entries, { d0: 'bug 123 帮我查' })
  assert.ok(!r3.hits.some((h) => h.uidKey === '1'))
})

test('整词默认关闭:中文子串即可命中;显式开启时按词界(拉丁)', () => {
  const sub = wb({ '0': entry({ key: ['煎饼'], content: 'x' }) })
  assert.equal(matchEntries(sub.entries, { d0: '煎饼果子' }).hits.length, 1)

  const whole = wb({ '0': entry({ key: ['king'], content: 'x', matchWholeWords: true }) })
  assert.equal(matchEntries(whole.entries, { d0: 'long live the king' }).hits.length, 1)
  assert.equal(matchEntries(whole.entries, { d0: 'not to my liking' }).hits.length, 0)
})

test('caseSensitive 开启后区分大小写', () => {
  const cs = wb({ '0': entry({ key: ['Rose'], content: 'x', caseSensitive: true }) })
  assert.equal(matchEntries(cs.entries, { d0: 'rose' }).hits.length, 0)
  assert.equal(matchEntries(cs.entries, { d0: 'Rose' }).hits.length, 1)
})

test('禁用/空内容条目不触发', () => {
  const model = wb({
    '0': entry({ key: ['a'], content: 'x', disable: true }),
    '1': entry({ key: ['b'], content: '   ' })
  })
  assert.equal(matchEntries(model.entries, { d0: 'a b' }).hits.length, 0)
})

test('无命中上限:全部命中都返回(作者自由,无丢弃)', () => {
  const es = {}
  for (let i = 0; i < 12; i++) es[String(i)] = entry({ key: ['go'], content: 'e' + i })
  const model = wb(es)
  const { hits } = matchEntries(model.entries, { d0: 'go!' })
  assert.equal(hits.length, 12)
})

test('planMatches 统计与空语料', () => {
  const model = wb({ '0': entry({ constant: true, content: 'k' }), '1': entry({ key: ['z'], content: 'z1' }) })
  const p = planMatches(model, { d0: '' })
  assert.equal(p.stats.constantHits, 1)
  assert.equal(p.stats.keyHits, 0)
  assert.equal(normalizeCorpus({ d0: 'a', d1: '', d2: 'b' }).parts.length, 2)
})

// —— ST selective(可选过滤器)四种逻辑:数值映射同工作区 ST世界书-逻辑.json ——
// 主关键词 A;过滤器 [B,C]。主要关键词之间恒或;过滤器按 logic:
//   3=与所有 (A)AND(B AND C) / 0=与任意 (A)AND(B OR C)
//   1=非所有 (A)NOT(B AND C) / 2=非任何 (A)NOT(B OR C)
function selEntry(logic, over = {}) {
  return entry(Object.assign({ key: ['A'], keysecondary: ['B', 'C'], selective: true, selectiveLogic: logic, content: 'sel' }, over))
}

test('selective 与所有(3):过滤器须全部命中', () => {
  const model = wb({ '0': selEntry(3) })
  assert.equal(matchEntries(model.entries, { d0: 'A B C' }).hits.length, 1)
  assert.equal(matchEntries(model.entries, { d0: 'A B' }).hits.length, 0)
  assert.equal(matchEntries(model.entries, { d0: 'A' }).hits.length, 0)
})

test('selective 与任意(0):过滤器任一命中即可', () => {
  const model = wb({ '0': selEntry(0) })
  assert.equal(matchEntries(model.entries, { d0: 'A B' }).hits.length, 1)
  assert.equal(matchEntries(model.entries, { d0: 'A C' }).hits.length, 1)
  assert.equal(matchEntries(model.entries, { d0: 'A' }).hits.length, 0)
})

test('selective 非所有(1):过滤器非全部命中才通过', () => {
  const model = wb({ '0': selEntry(1) })
  assert.equal(matchEntries(model.entries, { d0: 'A' }).hits.length, 1)
  assert.equal(matchEntries(model.entries, { d0: 'A B' }).hits.length, 1)
  assert.equal(matchEntries(model.entries, { d0: 'A B C' }).hits.length, 0)
})

test('selective 非任何(2):过滤器全部不命中才通过', () => {
  const model = wb({ '0': selEntry(2) })
  assert.equal(matchEntries(model.entries, { d0: 'A' }).hits.length, 1)
  assert.equal(matchEntries(model.entries, { d0: 'A B' }).hits.length, 0)
  assert.equal(matchEntries(model.entries, { d0: 'A B C' }).hits.length, 0)
})

test('selective 未开启但带 keysecondary:忽略过滤器,仅主关键词判定', () => {
  const model = wb({ '0': selEntry(3, { selective: false }) })
  assert.equal(matchEntries(model.entries, { d0: 'A B' }).hits.length, 1)
})

test('selective 命中携带 matchedSecondary 明细', () => {
  const model = wb({ '0': selEntry(0) })
  const { hits } = matchEntries(model.entries, { d0: 'A B' })
  assert.deepEqual(hits[0].matchedSecondary, ['B'])
  const model2 = wb({ '0': selEntry(3) })
  const { hits: h2 } = matchEntries(model2.entries, { d0: 'A B C' })
  assert.deepEqual(h2[0].matchedSecondary.sort(), ['B', 'C'])
})
