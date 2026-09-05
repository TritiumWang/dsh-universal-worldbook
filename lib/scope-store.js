// scope-store.js — enabled.json 读写(原子写 + .bak)。数据文件位于 ~/.dsh/WorldBook/enabled.json。

import { readFile, writeFile, copyFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { normalizeState } from './scope.js'

export function enabledFilePath(dir) {
  return path.join(dir, 'enabled.json')
}

export async function readEnabledFile(dir) {
  const file = enabledFilePath(dir)
  let state = {}
  try {
    state = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) // 容忍 BOM
  } catch {
    // 缺失或损坏:回退默认(空状态,即什么都不启用)——损坏不抛错,方便手改修复
    state = {}
  }
  return normalizeState(state)
}

export async function writeEnabledFile(dir, state, options = {}) {
  await mkdir(dir, { recursive: true })
  const file = enabledFilePath(dir)
  if (options.backup !== false) {
    try {
      await copyFile(file, file + '.bak')
    } catch {
      // 原文件不存在时跳过备份
    }
  }
  const tmp = file + '.tmp-' + Date.now()
  await writeFile(tmp, JSON.stringify(normalizeState(state), null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return file
}
