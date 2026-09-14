#!/usr/bin/env node
/**
 * 开发连接画像切换。
 *
 * 进程只读仓库根 `.env`。本机 / 远程的差异写在 `.env.local` / `.env.remote`，
 * 这条命令把 `.env` 指到当前画像（符号链接；已存在的普通文件会被替换）。
 *
 *   pnpm env:use local
 *   pnpm env:use remote
 *   pnpm env:status
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLE = join(root, '.env.example')
const ACTIVE = join(root, '.env')
const RESERVED = new Set(['example'])

function die(message) {
  console.error(message)
  process.exit(1)
}

function keysOf(text) {
  return new Set([...text.matchAll(/^[A-Z][A-Z0-9_]*(?==)/gm)].map((match) => match[0]))
}

function profilePath(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || RESERVED.has(name)) {
    die(`画像名不合法：${name}`)
  }
  return join(root, `.env.${name}`)
}

function assignmentValue(text, key) {
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'))
  if (!match) return ''
  return match[1].replace(/\s+#.*$/, '').trim()
}

function align(profileFile) {
  const exampleKeys = keysOf(readFileSync(EXAMPLE, 'utf8'))
  const profileKeys = keysOf(readFileSync(profileFile, 'utf8'))
  return {
    missing: [...exampleKeys].filter((key) => !profileKeys.has(key)),
    extra: [...profileKeys].filter((key) => !exampleKeys.has(key)),
  }
}

function assertAligned(profileFile, name) {
  const { missing, extra } = align(profileFile)
  if (missing.length === 0 && extra.length === 0) return
  if (missing.length) console.error(`  缺键：${missing.join(', ')}`)
  if (extra.length) console.error(`  多键：${extra.join(', ')}`)
  die(`画像 .env.${name} 与 .env.example 未对齐，拒绝切换`)
}

function currentProfile() {
  if (!existsSync(ACTIVE)) return null
  const stat = lstatSync(ACTIVE)
  if (!stat.isSymbolicLink()) return '(regular file)'
  const target = readlinkSync(ACTIVE)
  const match = target.match(/^\.env\.(.+)$/)
  return match?.[1] ?? target
}

function printSummary(file) {
  const text = readFileSync(file, 'utf8')
  const host = assignmentValue(text, 'CAIRN_DB_HOST')
  const port = assignmentValue(text, 'CAIRN_DB_PORT') || '5432'
  const name = assignmentValue(text, 'CAIRN_DB_NAME')
  const store = assignmentValue(text, 'CAIRN_OBJECT_STORE') || 'local'
  const object =
    store === 's3'
      ? `s3 ${assignmentValue(text, 'CAIRN_S3_ENDPOINT')} / ${assignmentValue(text, 'CAIRN_S3_BUCKET')}`
      : `local ${assignmentValue(text, 'CAIRN_OBJECT_STORE_DIR') || '.data/object-store'}`
  console.log(`  数据库    ${host}:${port}/${name}`)
  console.log(`  对象存储  ${object}`)
}

function useProfile(name) {
  const source = profilePath(name)
  if (!existsSync(source)) {
    die(`找不到 ${relative(root, source)}。从 .env.example 复制一份再改连接。`)
  }
  assertAligned(source, name)
  if (existsSync(ACTIVE)) unlinkSync(ACTIVE)
  symlinkSync(`.env.${name}`, ACTIVE)
  console.log(`已切换到 ${name}`)
  printSummary(source)
}

function status() {
  const active = currentProfile()
  if (!active) die('没有 .env。先 pnpm env:use local 或 pnpm env:use remote。')
  console.log(`当前画像  ${active}`)
  printSummary(ACTIVE)
  if (active !== '(regular file)' && existsSync(profilePath(active))) {
    const { missing, extra } = align(profilePath(active))
    if (missing.length || extra.length) {
      console.error('当前画像与 .env.example 未对齐：')
      if (missing.length) console.error(`  缺键：${missing.join(', ')}`)
      if (extra.length) console.error(`  多键：${extra.join(', ')}`)
      process.exit(1)
    }
  }
}

const [command, name] = process.argv.slice(2)
if (command === 'status' || command === undefined) {
  status()
} else if (command === 'use' && name) {
  useProfile(name)
} else if (command && !name && /^[a-z][a-z0-9-]*$/.test(command)) {
  useProfile(command)
} else {
  die('用法: pnpm env:use local|remote   或   pnpm env:status')
}
