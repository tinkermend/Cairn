// 迁移目录扫描与领号。check 与 allocate 共用同一套前缀规则，避免两套实现各算各的。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const FILENAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/
export const MIGRATION_NAME_PATTERN = /^[a-z][a-z0-9_]*$/
export const BACKENDS = [
  { id: 'postgres', rel: '.', label: 'postgres' },
  { id: 'mysql', rel: 'mysql', label: 'mysql' },
]

export function defaultMigrationsRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/db/migrations')
}

export function listSqlFiles(dir, label = dir) {
  if (!existsSync(dir)) return { files: [], sqlCount: 0, errors: [`迁移目录不存在：${label}`] }
  const names = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const errors = []
  const files = []
  const seen = new Map()
  if (!names.length) errors.push(`迁移目录为空：${label}`)
  names.forEach((filename, i) => {
    const match = FILENAME_PATTERN.exec(filename)
    if (!match) {
      errors.push(`文件名不合规范（应为 NNNN_name.sql）：${filename}`)
      return
    }
    const prefix = match[1]
    const duplicate = seen.get(prefix)
    if (duplicate) errors.push(`前缀重复：${prefix} → ${duplicate} 与 ${filename}`)
    seen.set(prefix, filename)
    const expected = String(i + 1).padStart(4, '0')
    if (prefix !== expected) errors.push(`序号不连续：期望 ${expected}，实际 ${prefix}（${filename}）`)
    files.push({ prefix, filename, slug: filename.slice(5, -4) })
  })
  return { files, sqlCount: names.length, errors }
}

export function inspectMigrations(migrationsRoot) {
  const errors = []
  let total = 0
  const backends = []
  for (const backend of BACKENDS) {
    const dir = resolve(migrationsRoot, backend.rel)
    const listed = listSqlFiles(dir, backend.rel)
    total += listed.sqlCount
    errors.push(...listed.errors)
    backends.push({ ...backend, dir, files: listed.files, errors: listed.errors })
  }
  return { backends, errors, total }
}

export function resolveAllocLockPath(migrationsRoot) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: migrationsRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (common) return resolve(migrationsRoot, common, 'cairn-migration-alloc.lock')
  } catch {
    // 测试夹具或不在 git 里时，锁就放在迁移根目录。
  }
  return resolve(migrationsRoot, '.alloc.lock')
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function lockHolderAlive(lockPath) {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').split('\n')[0])
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function withAllocLock(lockPath, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const staleMs = opts.staleMs ?? 30_000
  const started = Date.now()
  mkdirSync(dirname(lockPath), { recursive: true })
  while (true) {
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: 'wx' })
      try {
        return await fn()
      } finally {
        try {
          unlinkSync(lockPath)
        } catch {
          // 锁文件被抢回收也不挡正常返回。
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs
        if (!lockHolderAlive(lockPath) || age > staleMs) unlinkSync(lockPath)
      } catch {
        // 锁在判断时消失，下一轮重新领取。
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`领取迁移号超时：锁被占用（${lockPath}）`)
      }
      await sleep(25)
    }
  }
}

function stubSql(pgPrefix, backendId) {
  if (backendId === 'postgres') return `-- ${pgPrefix}：TODO 写明本增量做什么。\n`
  const label = 'MySQL'
  return `-- ${pgPrefix} 的 ${label} 等价增量：TODO 写明本增量做什么。\n`
}

function nextPrefix(files) {
  const max = files.reduce((n, file) => Math.max(n, Number(file.prefix)), 0)
  if (max !== files.length) throw new Error('序号不连续，拒绝领取')
  return String(max + 1).padStart(4, '0')
}

export async function allocateMigration(opts) {
  const name = opts.name ?? ''
  if (!MIGRATION_NAME_PATTERN.test(name)) {
    throw new Error(`迁移名不合规范（应为小写字母开头的 [a-z0-9_]+）：${name || '(空)'}`)
  }
  const migrationsRoot = opts.migrationsRoot ?? defaultMigrationsRoot()
  const lockPath = opts.lockPath ?? resolveAllocLockPath(migrationsRoot)
  return withAllocLock(lockPath, () => {
    const snapshot = inspectMigrations(migrationsRoot)
    if (snapshot.errors.length) {
      throw new Error(`现有迁移不完整，拒绝领取：\n  ${snapshot.errors.join('\n  ')}`)
    }
    for (const backend of snapshot.backends) {
      const taken = backend.files.find((file) => file.slug === name)
      if (taken) throw new Error(`迁移名已被占用：${backend.label} 已有 ${taken.filename}`)
    }
    const pgPrefix = nextPrefix(snapshot.backends[0].files)
    const created = []
    try {
      const files = snapshot.backends.map((backend) => {
        const prefix = nextPrefix(backend.files)
        const filename = `${prefix}_${name}.sql`
        const path = resolve(backend.dir, filename)
        writeFileSync(path, stubSql(pgPrefix, backend.id), { flag: 'wx' })
        created.push(path)
        return { backend: backend.label, prefix, filename, path }
      })
      return { logicalVersion: pgPrefix, files }
    } catch (error) {
      for (const path of created) {
        try {
          unlinkSync(path)
        } catch {
          // 回滚能删多少删多少，下一轮检查会拦住半成品。
        }
      }
      if (error.code === 'EEXIST') throw new Error(`迁移文件已存在，未覆盖：${error.path ?? created.at(-1)}`)
      throw error
    }
  }, opts)
}

export function assertTransferUsesDerivedVersion(source) {
  if (!source.includes('latestLogicalVersion()')) {
    return 'transfer.ts 必须用 latestLogicalVersion()，禁止手写 logicalVersion'
  }
  if (/LOGICAL_VERSION\s*=\s*'00\d{2}'/.test(source) || /z\.literal\(\s*'00\d{2}'\s*\)/.test(source)) {
    return 'transfer.ts 禁止手写四位 logicalVersion'
  }
  return null
}
