import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEnabled, normalizeState, pathKey } from '../lib/scope.js'

const state = {
  global: ['g1'],
  workspace: { 'D:/DSH-TEST': ['proj1'], 'C:/Users/x/proj': ['proj2'] },
  preset: { cordis: ['mode1'] },
  allowSubagents: true
}

test('global 恒生效;workspace 与 preset 命中即并入', () => {
  const r = resolveEnabled(state, { cwd: 'D:\\DSH-TEST', presetId: 'cordis' })
  assert.deepEqual([...r.ids].sort(), ['g1', 'mode1', 'proj1'].sort())
  assert.equal(r.allowSubagents, true)
})

test('workspace key 路径归一化:反斜杠/正斜杠/结尾斜杠等价', () => {
  const a = resolveEnabled(state, { cwd: 'D:\\DSH-TEST\\' })
  const b = resolveEnabled(state, { cwd: 'D:/DSH-TEST' })
  assert.deepEqual(a.ids.sort(), b.ids.sort())
  assert.ok(a.ids.includes('proj1'))
  assert.equal(pathKey('D:\\DSH-TEST\\'), 'D:/DSH-TEST')
})

test('不匹配任何 workspace/preset 时只剩 global', () => {
  const r = resolveEnabled(state, { cwd: 'X:/other', presetId: 'nope' })
  assert.deepEqual(r.ids, ['g1'])
  assert.deepEqual(r.matchedLayers, ['global'])
})

test('空上下文(元信息缺失)= 仅 global,安全兜底', () => {
  const r = resolveEnabled(state, {})
  assert.deepEqual(r.ids, ['g1'])
})

test('缺省状态 = 什么都不启用,子代理不可见', () => {
  const r = resolveEnabled({}, { cwd: 'D:/DSH-TEST', presetId: 'cordis' })
  assert.deepEqual(r.ids, [])
  assert.equal(r.allowSubagents, false)
})

test('normalizeState 容忍脏输入', () => {
  const s = normalizeState({ global: 'g', workspace: { 'a\\b\\': ['x'] }, preset: { p: 'y' } })
  assert.deepEqual(s.global, ['g'])
  assert.deepEqual(s.workspace['a/b'], ['x']) // 反斜杠与结尾斜杠归一化;不折叠内部双斜杠(保 UNC)
  assert.deepEqual(s.preset['p'], ['y'])
})
