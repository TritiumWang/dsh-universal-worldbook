import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorldbook, toJsonString, serializeWorldbook, addEntry, removeEntry, setEntryField } from '../lib/worldbook.js'

// 与 tavern 实测世界书同构,并加入未知扩展字段与未知顶层字段以验证无损
function stSample() {
  return {
    name: '测试世界书',
    creator: { handle: 'fixture', version: '1.2.3' }, // 未知顶层字段
    entries: {
      '0': {
        uid: 0, key: [], keysecondary: [],
        comment: '报警', content: '公民遇到困难可以找警察',
        constant: true, vectorized: false, selective: true, selectiveLogic: 0,
        addMemo: true, order: 100, position: 0, disable: false,
        excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false,
        probability: 100, useProbability: true, depth: 4,
        group: '', groupOverride: false, groupWeight: 100,
        scanDepth: null, caseSensitive: null, matchWholeWords: null,
        useGroupScoring: null, automationId: '', role: null,
        sticky: 0, cooldown: 0, delay: 0, triggers: [],
        displayIndex: 0, 'x-my-extension': { note: 'keep me' } // 未知字段
      },
      '1': {
        uid: 1, key: ['煎饼果子'], keysecondary: [], comment: '煎饼果子',
        content: '在这个国家，吃煎饼果子是违法行为',
        constant: false, order: 100, disable: false, displayIndex: 1
      }
    }
  }
}

test('解析并无损往返(未知字段/顶层字段/扩展字段全部保留)', () => {
  const raw = stSample()
  const model = parseWorldbook(raw)
  assert.equal(model.entryCount, 2)
  assert.deepEqual(JSON.parse(toJsonString(model)), raw)
})

test('entryView 归一化', () => {
  const model = parseWorldbook(stSample())
  const [c0, c1] = model.entries
  assert.equal(c0.constant, true)
  assert.equal(c0.hasKeys, false)
  assert.equal(c0.order, 100)
  assert.equal(c1.hasKeys, true)
  assert.deepEqual(c1.keys, ['煎饼果子'])
  assert.equal(c1.enabled, true)
  // disable=true -> 禁用;空 content -> 禁用
  const disabled = parseWorldbook({ entries: { '0': { disable: true, content: 'x' }, '1': { content: '  ' } } })
  assert.equal(disabled.entries[0].enabled, false)
  assert.equal(disabled.entries[1].enabled, false)
  // 缺 order -> 默认 100
  const noOrder = parseWorldbook({ entries: { '0': { content: 'x' } } })
  assert.equal(noOrder.entries[0].order, 100)
})

test('CRUD:新增自动分配 uid,修改只动白名单字段,未知字段保留', () => {
  const model = parseWorldbook(stSample())
  const before = JSON.parse(toJsonString(model))
  const r1 = addEntry(model, { content: '新条目', comment: 'new', order: 200 })
  assert.equal(r1.uidKey, '2')
  assert.equal(model.entryCount, 3)

  setEntryField(model, '2', 'content', '新条目内容改过')
  setEntryField(model, '2', 'constant', true)
  assert.equal(model.entries.find((e) => e.uidKey === '2').content, '新条目内容改过')
  assert.equal(model.entries.find((e) => e.uidKey === '2').constant, true)

  // 未知字段(第 0 条的 x-my-extension)在增改删后仍保留
  const after = JSON.parse(toJsonString(model))
  assert.deepEqual(after.entries['0']['x-my-extension'], { note: 'keep me' })
  // 顶层未知字段保留
  assert.equal(after.creator.handle, 'fixture')
  assert.ok(JSON.stringify(after).length > JSON.stringify(before).length)

  removeEntry(model, '1')
  assert.equal(model.entryCount, 2)
  assert.equal(model.entries.some((e) => e.uidKey === '1'), false)
  assert.equal(JSON.parse(toJsonString(model)).entries['2'].content, '新条目内容改过')
})

test('serializeWorldbook 返回深拷贝,后续修改不影响原始 raw', () => {
  const model = parseWorldbook(stSample())
  const serialized = serializeWorldbook(model)
  setEntryField(model, '0', 'content', 'changed')
  assert.equal(serialized.entries['0'].content, '公民遇到困难可以找警察')
})

test('臆想字段防护:enabled/displayIndex 不是可写字段(真实 ST 文件用 disable)', () => {
  const model = parseWorldbook(stSample())
  assert.throws(() => setEntryField(model, '0', 'enabled', true), /未知字段/)
  assert.throws(() => setEntryField(model, '0', 'displayIndex', 5), /未知字段/)
})
