import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorldbook } from '../lib/worldbook.js'
import { matchEntries } from '../lib/matcher.js'
import { assemble } from '../lib/assembler.js'
import { plan } from '../lib/plan.js'

test('碎条目按 order 拼成完整闭合标签;默认不插入换行', () => {
  const model = parseWorldbook({
    name: 'food',
    entries: {
      '0': { key: ['食物'], content: '<食物>', order: 1 },
      '1': { key: ['食物'], content: '香蕉是一种热带水果。', order: 2 },
      '2': { key: ['食物'], content: '</食物>', order: 3 }
    }
  })
  const { hits } = matchEntries(model.entries, { d0: '给我讲讲食物' })
  assert.equal(hits.length, 3)
  // 默认无换行:逐字拼成完整闭合标签
  assert.equal(assemble(hits).text, '<食物>香蕉是一种热带水果。</食物>')
  // 显式 separator 可用于未来"附加换行"勾选
  assert.equal(assemble(hits, { separator: '\n' }).text, '<食物>\n香蕉是一种热带水果。\n</食物>')
})

test('常驻不优先:常驻与关键词一律只按 order 升序;同 order 按文件(uid)顺序', () => {
  const hits = [
    { uidKey: 'a', reason: 'key', order: 10, content: 'key10' },
    { uidKey: 'b', reason: 'constant', order: 50, content: 'const50' },
    { uidKey: 'c', reason: 'key', order: 5, content: 'key5' }
  ]
  const block = assemble(hits, { separator: '|' })
  assert.equal(block.text, 'key5|key10|const50')
  assert.equal(block.count, 3)

  // 同 order:按文件内 uid 顺序(0,1,2…),常驻也不插队
  const tied = [
    { uidKey: '2', reason: 'constant', order: 7, content: 'c2' },
    { uidKey: '0', reason: 'key', order: 7, content: 'k0' },
    { uidKey: '1', reason: 'key', order: 7, content: 'k1' }
  ]
  assert.equal(assemble(tied, { separator: '|' }).text, 'k0|k1|c2')
})

test('plan 高层预览输出命中明细 + 组装块 + 统计', () => {
  const model = parseWorldbook({
    name: 'p',
    entries: {
      '0': { key: ['unity'], content: 'Unity 经验', order: 200 },
      '1': { key: ['gui'], content: 'GUI 经验', order: 100 }
    }
  })
  const p = plan({ d0: '写 Unity GUI' }, model)
  assert.equal(p.stats.keyHits, 2)
  assert.equal(p.block.count, 2)
  // order 100 在前,200 在后;默认无换行
  assert.equal(p.block.sections[0].content, 'GUI 经验')
  assert.equal(p.block.sections[1].content, 'Unity 经验')
  assert.equal(p.block.text, 'GUI 经验Unity 经验')
  assert.equal(p.diagnostics.length, 0)
})
