import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readEnabledFile, writeEnabledFile } from '../lib/scope-store.js'

test('缺文件回退空状态;写入→读取往返;二次写生成 .bak', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-scope-'))
  try {
    assert.deepEqual(await readEnabledFile(dir), { version: 1, global: [], workspace: {}, preset: {}, allowSubagents: false })

    const state = { global: ['g1'], workspace: { 'D:\\DSH-TEST\\': ['p1'] }, preset: { cordis: ['m1'] }, allowSubagents: true }
    await writeEnabledFile(dir, state)

    const loaded = await readEnabledFile(dir)
    assert.deepEqual(loaded.global, ['g1'])
    // workspace key 已归一化
    assert.deepEqual(loaded.workspace['D:/DSH-TEST'], ['p1'])
    assert.deepEqual(loaded.preset.cordis, ['m1'])
    assert.equal(loaded.allowSubagents, true)

    await writeEnabledFile(dir, { global: ['g2'] })
    const bakRaw = JSON.parse(await readFile(path.join(dir, 'enabled.json.bak'), 'utf8'))
    assert.deepEqual(bakRaw.global, ['g1'])
    assert.deepEqual((await readEnabledFile(dir)).global, ['g2'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
