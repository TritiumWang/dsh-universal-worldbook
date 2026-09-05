// store.js — worldbook 文件读写(原子写 + 备份)。M0 只依赖注入的目录,不写 DSH_HOME。

import { readFile, writeFile, copyFile, rename, readdir } from 'node:fs/promises'
import path from 'node:path'
import { parseWorldbook, toJsonString } from './worldbook.js'

export async function readWorldbookFile(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error('读取世界书失败 ' + file + ': ' + String(error && error.message || error))
  }
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, '')) // 容忍 BOM
  } catch (error) {
    throw new Error('世界书不是有效 JSON ' + file + ': ' + String(error && error.message || error))
  }
  return parseWorldbook(parsed)
}

export async function writeWorldbookFile(file, model, options = {}) {
  const backup = options.backup !== false
  if (backup) {
    try {
      await copyFile(file, file + '.bak')
    } catch {
      // 原文件不存在时跳过备份
    }
  }
  const tmp = file + '.tmp-' + Date.now()
  await writeFile(tmp, toJsonString(model), 'utf8')
  await rename(tmp, file)
  return file
}

export async function listWorldbookFiles(dir) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names.filter((name) => name.endsWith('.json') && !name.endsWith('.bak')).sort()
}

export function worldbookFilePath(dir, name) {
  const base = name.endsWith('.json') ? name.slice(0, -5) : name
  return path.join(dir, base + '.json')
}
