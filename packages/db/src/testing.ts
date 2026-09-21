import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { dbEnvSchema, formatEnvIssues, type PostgresDbEnv } from '@cairn/shared'
import { bindTransactions, type DbHandle } from './client.js'
import { eq } from 'drizzle-orm'
import { nativeTables, schemaFor } from './native.js'
import { registerFixture } from './database.js'
export type PgTestHandle = DbHandle & { pool: Pool }
import { migrate } from './migrate.js'
import { FACTORY_PLATFORM_CONFIG } from '@cairn/shared'
import { getOrCreatePlatformConfig } from './platform-config/store.js'

/** 仓库根 `.env`。与 api / worker 的读取路径同源：本地读它，CI 由环境变量提供。 */
const ENV_FILE = resolve(import.meta.dirname, '../../../.env')

/** 连不上时要快速失败，不能让「网络黑洞」把整个测试挂住。 */
const CONNECT_TIMEOUT_MS = 10_000

/**
 * 集成测试的库前置条件：**连不上就失败，不跳过**。
 *
 * 判据必须是「库能不能连上」，而不是「配置看起来有没有」。原先各集成测试用
 * `describe.skipIf(!parsed.success)` 判环境变量在不在，于是干净检出、CI 漏配或
 * 临时离线时整包变绿而一条都没跑——实测 db 包 `3 passed | 4 skipped`、退出码 0，
 * 「测试通过」这句话因此没有含义。
 *
 * 由 vitest 的 `globalSetup` 在跑用例之前调用，库不可用时整个包失败。
 * 失败信息只带 host / port / database 与配置项名，不带口令。
 */
export async function requireReachableDb(): Promise<PostgresDbEnv> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

  const parsed = dbEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const lines = formatEnvIssues(parsed.error)
      .map((line) => `  ✗ ${line}`)
      .join('\n')
    throw new Error(
      `集成测试需要可用的 PostgreSQL，但配置不完整（${ENV_FILE} 或环境变量）：\n${lines}\n` +
        '集成测试不会因为缺配置而跳过。',
    )
  }

  const env = parsed.data
  if (env.CAIRN_DB_DRIVER !== 'postgres') throw new Error('PG-specific tests require postgres')
  const pool = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c search_path=${env.CAIRN_DB_SCHEMA},public`,
  })

  try {
    await pool.query('select 1')
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `集成测试需要可用的 PostgreSQL，但连接 ` +
        `${env.CAIRN_DB_HOST}:${env.CAIRN_DB_PORT}/${env.CAIRN_DB_NAME} 失败：${reason}\n` +
        '库不可用时集成测试失败，不跳过。',
    )
  } finally {
    await pool.end()
  }

  return env
}

function templateDatabase(): string | undefined {
  const name = process.env.CAIRN_TEST_TEMPLATE_DB
  return name && /^cairn_test_template_[a-f0-9]{32}$/.test(name) ? name : undefined
}

/**
 * 在运行测试套件前，一次性初始化基准模板库并执行全部迁移。
 * 后续所有 openIsolatedDb 均基于此模板克隆，省去逐用例执行 migration 的高昂耗时。
 */
export async function setupTestTemplateDatabase(): Promise<void> {
  const env = await requireReachableDb()
  const name = `cairn_test_template_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  })
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end()
  }

  const pool = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: name,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    options: `-c search_path=cairn,public`,
  })
  try {
    await migrate(pool, 'cairn')
  } catch (error) {
    await pool.end()
    await dropIsolatedDatabase(env, name)
    throw error
  }
  await pool.end()
  // 每次测试调用独占模板，子进程继承名称；并行套件不得删除彼此的库。
  process.env.CAIRN_TEST_TEMPLATE_DB = name
}

/**
 * 测试套件全部结束后的模板库清理。
 */
export async function teardownTestTemplateDatabase(): Promise<void> {
  const name = templateDatabase()
  if (!name) return
  const env = await requireReachableDb()
  await dropIsolatedDatabase(env, name)
  delete process.env.CAIRN_TEST_TEMPLATE_DB
}

/**
 * 集成测试用的独立数据库。
 *
 * Drizzle 表名编译期写死为 `cairn.*`，只建独立 schema 拦不住限定名。
 * 另开数据库再在其中 migrate `cairn`，查询与领取都不会碰到开发库或其它测试。
 * 优先采用 TEMPLATE 克隆已迁移的模板库（耗时从 1.5s 降至 20ms）；若模板库不存在则平滑降级为新建+迁移。
 * `close()` 会 `DROP DATABASE`。
 */
export async function openIsolatedDb(
  name: string,
  options: { pristine?: boolean } = {},
): Promise<PgTestHandle> {
  const env = await requireReachableDb()
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name.length > 63) {
    throw new Error(`隔离库名不合法：${name}`)
  }

  const admin = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  })

  let createdFromTemplate = false
  try {
    const template = templateDatabase()
    const chk = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [template])
    if (template && chk.rows.length > 0) {
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)
        createdFromTemplate = true
      } catch {
        // 若模板库正被占用或临时不可用，降级为常规新建
        await admin.query(`CREATE DATABASE "${name}"`)
      }
    } else {
      await admin.query(`CREATE DATABASE "${name}"`)
    }
  } finally {
    await admin.end()
  }

  const pool = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: name,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    options: `-c search_path=cairn,public`,
  })

  /**
   * 收尾竞态：`DROP DATABASE ... WITH (FORCE)` 会 `pg_terminate_backend` 掉所有
   * 还连在这个库上的会话。`await pool.end()` 在本地判定连接已结束时就返回，但
   * 套接字可能还没真正关完、服务端 backend 也还在——FORCE 的终止信号正好落进
   * 这个窗口，客户端就读到一条 FATAL 57P01。
   *
   * `Pool` 没有 'error' 监听者时，这条错误是 EventEmitter 的未处理 'error'，
   * vitest 记成 unhandled error 并把整份用例文件判红。
   */
  let closing = false
  pool.on('error', (error) => {
    if (closing) return
    console.error(`[openIsolatedDb:${name}] 空闲连接错误：${error.message}`)
  })

  if (!createdFromTemplate) {
    try {
      await migrate(pool, 'cairn')
    } catch (error) {
      closing = true
      await pool.end()
      await dropIsolatedDatabase(env, name)
      throw error
    }
  }

  const db = bindTransactions(drizzle(pool), 'postgres', nativeTables('postgres', 'cairn'))
  const handle = registerFixture({
    db,
    pool,
    driver: 'postgres',
    raw: async (statement, values) => (await pool.query(statement, values)).rows,
    ping: async () => true,
    close: async () => {
      closing = true
      await pool.end()
      await dropIsolatedDatabase(env, name)
    },
  })
  if (!options.pristine) await seedFixtureStepsEnabled(handle)
  return handle
}

/**
 * 给夹具账号一条「admin 角色 + 全部目标范围」的绑定。
 *
 * 只绑角色不够：`console_account_roles.target_scope_mode` 默认是 'none'（0066），
 * 绑了 admin 但没写范围的账号，目标范围仍是空——创建目标、处置会话这类需要
 * 「全部目标」的操作都会被拒。这是产品有意的语义，夹具要显式给足范围。
 * 放在 @cairn/db/testing，api / worker 的集成测试也要用。
 */
export async function grantAdminScope(db: DbHandle['db'], accountId: string): Promise<void> {
  const { consoleRoles, consoleAccountRoles } = schemaFor(db)
  const [admin] = await db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
  if (!admin) throw new Error('missing admin role fixture')
  await db
    .insert(consoleAccountRoles)
    .values({ consoleAccountId: accountId, consoleRoleId: admin.id, targetScopeMode: 'all' })
}

/**
 * 给夹具账号一个「只含指定权限、范围为全部目标」的自定义角色。
 *
 * grantAdminScope 给的是 admin，权限是全集，包括 ai:execute。要测「缺某项权限被拒」
 * （如含 AI 步骤的试跑须有 ai:execute）就不能用它：账号得有足够权限走到那一步，
 * 又恰好缺被测的那一项。这里直接写库，因为夹具账号本来就是直接 insert 的，
 * 且产品路径 createRole 要求操作者是范围管理员，在夹具里得不偿失。
 */
export async function grantScopedPermissions(
  db: DbHandle['db'],
  accountId: string,
  permissions: readonly string[],
): Promise<string> {
  const { consoleRoles, consoleRolePermissions, consoleAccountRoles } = schemaFor(db)
  const roleId = randomUUID()
  await db.insert(consoleRoles).values({
    id: roleId,
    key: `fixture-${roleId.slice(0, 8)}`,
    name: '测试夹具角色',
    kind: 'custom',
  })
  await db
    .insert(consoleRolePermissions)
    .values(permissions.map((permission) => ({ consoleRoleId: roleId, permission })))
  await db
    .insert(consoleAccountRoles)
    .values({ consoleAccountId: accountId, consoleRoleId: roleId, targetScopeMode: 'all' })
  return roleId
}

/**
 * 夹具步骤（echo / delay / fail）是集成测试构造确定性运行的基座，而平台出厂把它关着。
 * 隔离库在这里统一开放一次，用例走的就是「已开放」这条真实路径；要验闸门本身的
 * 用例自己把它改回 false。放在这一层，是因为直接调 openIsolatedDb 的用例与
 * 经 openContractDb 的用例共用同一个入口，不必各自记得种一遍。
 *
 * 需要「刚迁移完的纯净库」的用例（如数据库迁移的导入目标）传 `{ pristine: true }`：
 * 那里 platform_config 必须为空，预先种进去会让判空失败。
 */
export async function seedFixtureStepsEnabled(handle: DbHandle): Promise<void> {
  await getOrCreatePlatformConfig(handle.db, {
    document: { ...FACTORY_PLATFORM_CONFIG, fixtureStepsEnabled: true },
    reason: '测试库：开放调试夹具步骤',
  })
}

async function dropIsolatedDatabase(env: PostgresDbEnv, name: string): Promise<void> {
  const admin = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  })
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}
