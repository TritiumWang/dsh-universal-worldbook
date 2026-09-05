import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readWorldbookFile, writeWorldbookFile, listWorldbookFiles, worldbookFilePath } from '../lib/store.js'
import { parseWorldbook } from '../lib/worldbook.js'

test('write/read 往返 + 原子写生成 .bak', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wb-test-'))
  try {
    const file = worldbookFilePath(dir, '我的世界书')
    assert.equal(file, path.join(dir, '我的世界书.json'))

    const model = parseWorldbook({ name: '我的世界书', entries: { '0': { key: ['a'], content: 'x', constant: false, 'ext': 1 } } })
    await writeWorldbookFile(file, model)
    assert.deepEqual(await listWorldbookFiles(dir), ['我的世界书.json'])

    // 二次写入:应生成 .bak,且内容仍是上次的
    const model2 = parseWorldbook({ name: '我的世界书', entries: { '0': { key: ['a'], content: 'x', constant: false, 'ext': 1 }, '1': { key: ['b'], content: 'y' } } })
    await writeWorldbookFile(file, model2)

    const bak = file + '.bak'
    const bakRaw = JSON.parse(await readFile(bak, 'utf8'))
    assert.equal(bakRaw.entries['0'].content, 'x') // 备份 = 第一次内容
    assert.equal(bakRaw.entries['1'], undefined)

    const loaded = await readWorldbookFile(file)
    assert.equal(loaded.entryCount, 2)
    assert.ok((await stat(file)).size > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('损坏 JSON 读取报友好错误;缺失目录返回空列表', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-wb-test2-'))
  try {
    await assert.rejects(() => readWorldbookFile(path.join(dir, 'bad.json')), /读取世界书失败/)
    assert.deepEqual(await listWorldbookFiles(path.join(dir, 'nope')), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
