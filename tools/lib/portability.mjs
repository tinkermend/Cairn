// 数据库可移植检查：平台设计不与某个数据库的专有特性绑定。
// 只拦「换库时没有对应物、必须重写逻辑」的写法；JSONB / TIMESTAMPTZ 这类各库都有对应类型的写法不拦。
// 存量用基线冻结：已有写法不追溯，新迁移零容忍，运行时代码只许减少不许增加。

// 新迁移从这个前缀之后开始检查；之前的历史迁移不追溯。
export const MIGRATION_CHECK_AFTER = '0098'

// 迁移里的单条语句可用 `-- portability-exception: <原因>` 豁免，原因必填，便于评审看见。
export const EXCEPTION_PATTERN = /--[ \t]*portability-exception:[ \t]*\S/

export const MIGRATION_RULES = [
  { id: 'trigger', pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i, hint: '触发器把业务逻辑放进数据库；改在 @cairn/db 领域操作里做' },
  { id: 'function', pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b|\bLANGUAGE\s+plpgsql\b/i, hint: '存储过程／函数不可移植；逻辑放应用层' },
  { id: 'do-block', pattern: /\bDO\s+\$/i, hint: 'DO 匿名块是 PG 专有；数据回填改用普通 UPDATE／INSERT，条件判断放应用层' },
  { id: 'extension', pattern: /\bCREATE\s+EXTENSION\b/i, hint: '依赖 PG 扩展' },
  { id: 'custom-type', pattern: /\bCREATE\s+(?:TYPE|DOMAIN)\b/i, hint: '自定义类型／ENUM 不可移植；用字符串列 + CHECK 或应用层校验' },
  { id: 'sequence', pattern: /\bCREATE\s+SEQUENCE\b|\b(?:SMALL|BIG)?SERIAL\b|\bnextval\s*\(|\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i, hint: 'ID 由应用 uuid.v7() 生成，不用数据库序列' },
  { id: 'db-uuid', pattern: /\bgen_random_uuid\s*\(|\buuid_generate_v\d/i, hint: 'ID 由应用 uuid.v7() 生成' },
  { id: 'array-type', pattern: /\b(?:TEXT|VARCHAR|INT|INTEGER|BIGINT|UUID|BOOLEAN|NUMERIC)\s*\[\s*\]|\bARRAY\s*\[/i, hint: '数组列不可移植；用 JSON 列或子表' },
  { id: 'partial-index', pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*\bWHERE\b/is, hint: '条件索引不是通用能力。「至多一条 ACTIVE」这类约束不要退到应用层判重（并发下有竞态）：加一个可空槽位列，ACTIVE 时写入分组键、否则写 NULL，再建普通 UNIQUE 索引——PG / MySQL / SQLite 都允许多个 NULL 并存' },
  { id: 'index-method', pattern: /\bUSING\s+(?:GIN|GIST|BRIN|SPGIST|HASH)\b/i, hint: '专有索引方法' },
  { id: 'json-operator', pattern: /->>|#>>?|@>|<@|\?\||\?&/, hint: 'PG JSON 运算符；JSON 查询走 @cairn/db 适配层' },
  { id: 'upsert', pattern: /\bON\s+CONFLICT\b/i, hint: 'ON CONFLICT 是 PG 专有 upsert 语法；种子数据用 INSERT ... SELECT ... WHERE NOT EXISTS，业务幂等放应用层' },
  { id: 'pg-misc', pattern: /\bINHERITS\s*\(|\bMATERIALIZED\s+VIEW\b|\bCREATE\s+RULE\b|\bNOTIFY\b|\btsvector\b|\bILIKE\b/i, hint: 'PG 专有特性' },
]

// 运行时代码：方言差异只能在适配层内部。适配层文件整体豁免，其余文件按基线计数。
export const CODE_ADAPTER_FILES = new Set([
  'native.ts',
  'client.ts',
  'migrate.ts',
  'migrate-native.ts',
  'transfer.ts',
  'observe/create-hint.ts',
])

export const CODE_RULES = [
  { id: 'cast', pattern: /::(?:jsonb|json|text|int|integer|bigint|uuid|timestamptz|timestamp|numeric|boolean|date)\b/gi, hint: 'PG 类型转换写法；用 CAST(... AS ...) 或适配层函数' },
  { id: 'json-operator', pattern: /->>|@>|\bjsonb_\w+\s*\(/g, hint: 'PG JSON 运算；改用 native.ts 的 JSON 适配函数' },
  { id: 'ilike', pattern: /\bILIKE\b|\bilike\s*\(/g, hint: 'ILIKE 是 PG 专有；大小写不敏感匹配走适配层' },
  { id: 'any-array', pattern: /=\s*ANY\s*\(/gi, hint: '= ANY(array) 是 PG 专有；用 inArray()' },
  { id: 'distinct-on', pattern: /\bDISTINCT\s+ON\b/gi, hint: 'DISTINCT ON 是 PG 专有' },
  { id: 'returning', pattern: /\.returning\s*\(/g, hint: 'RETURNING 并非各库都有；写入后按主键回读，或走适配层' },
  { id: 'on-conflict', pattern: /\.onConflictDo(?:Update|Nothing)\s*\(/g, hint: 'ON CONFLICT upsert 是 PG／SQLite 专有；走适配层 upsert' },
]

/** 把 SQL 按语句切开，保留每句前面的注释，便于识别豁免。 */
export function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/^--.*$/gm, '').trim())
}

export function checkMigrationSql(filename, sql) {
  const issues = []
  for (const statement of splitStatements(sql)) {
    if (EXCEPTION_PATTERN.test(statement)) continue
    const body = statement.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''")
    for (const rule of MIGRATION_RULES) {
      if (rule.pattern.test(body)) {
        const head = body.split('\n').find((line) => line.trim())?.trim().slice(0, 80) ?? ''
        issues.push({ file: filename, rule: rule.id, message: `${rule.hint}（${head}）` })
      }
    }
  }
  return issues
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 统计一个运行时源文件各规则命中次数。 */
export function countCodeHits(source) {
  const code = stripComments(source)
  const counts = {}
  for (const rule of CODE_RULES) {
    const n = code.match(rule.pattern)?.length ?? 0
    if (n) counts[rule.id] = n
  }
  return counts
}

/** 对照基线：新文件出现命中、或某规则计数上升即失败；计数下降提示收紧基线。 */
export function compareWithBaseline(current, baseline) {
  const errors = []
  const shrunk = []
  for (const [file, counts] of Object.entries(current)) {
    for (const [rule, n] of Object.entries(counts)) {
      const allowed = baseline[file]?.[rule] ?? 0
      if (n > allowed) {
        const hint = CODE_RULES.find((r) => r.id === rule)?.hint ?? ''
        errors.push(`${file}：${rule} ${allowed} → ${n}。${hint}`)
      }
    }
  }
  for (const [file, counts] of Object.entries(baseline)) {
    for (const [rule, allowed] of Object.entries(counts)) {
      const n = current[file]?.[rule] ?? 0
      if (n < allowed) shrunk.push(`${file}：${rule} ${allowed} → ${n}`)
    }
  }
  return { errors, shrunk }
}
