import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  buildResultWorkbook,
  parseExcelOrCsv,
  calculatePacingDelayMs,
  normalizeAuthoringDocument,
  type ScenarioInputDecl,
} from '@cairn/shared'
import { DRIVERS, grantAdminScope, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  createDataset,
  getDataset,
  getDatasetRows,
  autoMapDataset,
  preflightDataset,
} from '../datasets/datasets.js'
import {
  createBatch,
  getBatch,
  getBatchItems,
  advanceBatch,
  onRunSettledForBatch,
  resumeBatch,
  retryFailedBatch,
  exportBatchResults,
} from '../batches/batches.js'

describe.each(DRIVERS)('%s 端到端验证：Excel 数据集导入与批处理边界能力', (driver) => {
  let handle: DbHandle
  let targetId: string
  let scenarioId: string
  let scenarioVersionId: string
  let accountId: string

  beforeAll(async () => {
    handle = await openContractDb(driver)
    const t = schemaFor(handle.db)
    targetId = newId()
    scenarioId = newId()
    scenarioVersionId = newId()
    accountId = newId()

    // 1. 创建管理员账户
    await handle.db.insert(t.consoleAccounts).values({
      id: accountId,
      displayName: '自动化测试工程师',
      email: `engineer-${accountId}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, accountId)

    // 2. 创建测试目标系统
    await handle.db.insert(t.targets).values({
      id: targetId,
      code: `hr-target-${targetId.slice(0, 8)}`,
      name: '人力资源主干业务系统',
      entryUrl: 'https://hr.example.corp/onboarding',
    })

    // 3. 定义场景输入（包含普通字段与各类 Mock 生成器字段）
    const scenarioInputs: ScenarioInputDecl[] = [
      {
        key: 'empId',
        label: '工号',
        type: 'string',
        required: true,
      },
      {
        key: 'idCard',
        label: '身份证号',
        type: 'string',
        required: true,
      },
      {
        key: 'name',
        label: '姓名',
        type: 'string',
        required: true,
      },
      {
        key: 'rank',
        label: '职级',
        type: 'number',
        required: true,
      },
      {
        key: 'badgeToken',
        label: '胸牌卡号',
        type: 'string',
        required: true,
        defaultGenerator: {
          kind: 'template',
          pattern: 'CARD-{{date:YYYYMMDD}}-{{alphanumeric:6}}',
          unique: true,
        },
      },
      {
        key: 'assignedDept',
        label: '所属部门',
        type: 'string',
        required: false,
        defaultGenerator: {
          kind: 'fixed',
          value: 'DEPT-TECH',
        },
      },
    ]

    await handle.db.insert(t.scenarios).values({
      id: scenarioId,
      targetId,
      name: '员工入职批量申报场景',
      createdByConsoleAccountId: accountId,
      publishedVersionId: scenarioVersionId,
    })

    const testSteps = [
      {
        id: newId(),
        name: '录入员工档案',
        type: 'echo' as const,
        effectType: 'READ_ONLY' as const,
        input: { from: 'empId' },
      },
    ]

    await handle.db.insert(t.scenarioVersions).values({
      id: scenarioVersionId,
      scenarioId,
      versionNo: 1,
      kind: 'published',
      sourceDigest: 'hr-onboarding-digest',
      definition: { steps: testSteps } as any,
      authoringDocument: normalizeAuthoringDocument({
        inputs: scenarioInputs,
        steps: testSteps as any,
      }),
      createdByConsoleAccountId: accountId,
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('完整闭环：从构建高保真 Excel、解析防失真、预检、滑动调度、自适应熔断到多 Sheet 导出验证', async () => {
    // -------------------------------------------------------------
    // 步骤一：程序化构建一个逼真的多 Sheet Excel 文件
    // 包含：
    //  1. 工号前导零（'00892', '00015', '00001'）防变成数值 892
    //  2. 18 位身份证号（'11010119900307235X'）防科学计数法 1.101E+17
    //  3. 姓名包含生僻字/间隔号（'王·艾克拜尔'）
    //  4. 带有错误数据的行（用于检验预检拦截）
    //  5. 尾部携带 30 行空白幽灵行（检验空行剔除）
    //  6. 第二个 Sheet：部门代码参考字典（检验多 Sheet 结构）
    // -------------------------------------------------------------
    const dataSheetRows = [
      ['00892', '11010119900307235X', '张伟', '13800138000', '2026-03-15', '5', 'true', 'https://fixtures.cairn.local/id_card_00892.png'],
      ['00015', '310101199512128888', '李芳', '13911112222', '2026-04-01', '3', 'false', 'https://fixtures.cairn.local/id_card_00015.png'],
      ['00001', '440101199201015678', '王·艾克拜尔', '13700001111', '2026-05-01', '8', 'true', 'https://fixtures.cairn.local/doc.pdf'],
      ['00888', '610101199303033333', '刘洋', '13511113333', '2026-07-01', '4', 'true', 'https://fixtures.cairn.local/avatar.png'],
      ['00777', '120101199404044444', '陈明', '13611114444', '2026-08-01', '6', 'false', 'https://fixtures.cairn.local/chen.png'],
      ['00999', '510101199909099999', '', '13600000000', '2026-06-01', 'not_a_number', 'false', ''], // 边界错误行：缺必填姓名，职级非数值
    ]
    const ghostEmptyRows = Array.from({ length: 30 }, () => ['', '', '', '', '', '', '', ''])

    const excelBytes = buildResultWorkbook([
      {
        name: '员工开户申报',
        columns: ['工号', '身份证号', '姓名', '手机号', '入职日期', '职级', '是否转正', '证件扫描件'],
        rows: [...dataSheetRows, ...ghostEmptyRows],
      },
      {
        name: '部门代码字典',
        columns: ['部门名称', '部门编码'],
        rows: [
          ['技术中心', 'DEPT-TECH'],
          ['财务中心', 'DEPT-FINANCE'],
        ],
      },
    ])

    expect(excelBytes.byteLength).toBeGreaterThan(100)

    // -------------------------------------------------------------
    // 步骤二：解析 Excel 并断言边界能力（DC-04, DC-05）
    // -------------------------------------------------------------
    const parsed = parseExcelOrCsv(excelBytes, 'employee_onboarding.xlsx')
    expect(parsed.sourceType).toBe('excel')
    expect(parsed.sheetNames).toEqual(['员工开户申报', '部门代码字典'])
    expect(parsed.activeSheet.name).toBe('员工开户申报')

    // 边界 1：30 行幽灵空行被完全滤除
    expect(parsed.activeSheet.rowCount).toBe(6)
    expect(parsed.activeSheet.rows).toHaveLength(6)

    // 边界 2：列类型推断正确
    const colEmpId = parsed.activeSheet.columns.find((c) => c.name === '工号')!
    const colIdCard = parsed.activeSheet.columns.find((c) => c.name === '身份证号')!
    const colRank = parsed.activeSheet.columns.find((c) => c.name === '职级')!
    const colRegular = parsed.activeSheet.columns.find((c) => c.name === '是否转正')!
    const colDoc = parsed.activeSheet.columns.find((c) => c.name === '证件扫描件')!

    expect(colEmpId.type).toBe('string') // 前导零检测命中，保持 string，禁止转为 number
    expect(colIdCard.type).toBe('string') // 18 位长数字命中长文本保护，保持 string
    expect(colRank.type).toBe('number')
    expect(colRegular.type).toBe('boolean')
    expect(colDoc.type).toBe('file')

    // 边界 3：首行数据无损纯文本验证
    const row0 = parsed.activeSheet.rows[0]!
    expect(row0[colEmpId.key]).toBe('00892')
    expect(row0[colIdCard.key]).toBe('11010119900307235X')
    expect(row0[colIdCard.key]).not.toContain('E+')

    // -------------------------------------------------------------
    // 步骤三：入库持久化并验证检索（DC-05, DC-06）
    // -------------------------------------------------------------
    const dataset = await createDataset(
      handle.db,
      {
        name: '2026年Q1员工入职批量申报',
        targetId,
        sourceType: 'excel',
        sourceFilename: 'employee_onboarding.xlsx',
        columns: parsed.activeSheet.columns,
        rows: parsed.activeSheet.rows,
      },
      accountId,
    )

    expect(dataset.id).toBeDefined()
    expect(dataset.rowCount).toBe(6)

    const queriedRows = await getDatasetRows(handle.db, dataset.id, { limit: 10, offset: 0 })
    expect(queriedRows.total).toBe(6)
    expect(queriedRows.items[0]!.rowData[colEmpId.key]).toBe('00892')
    expect(queriedRows.items[0]!.rowData[colIdCard.key]).toBe('11010119900307235X')

    // -------------------------------------------------------------
    // 步骤四：自动映射与预检验证（DC-06）
    // -------------------------------------------------------------
    const scenarioInputs: ScenarioInputDecl[] = [
      { key: 'empId', label: '工号', type: 'string', required: true },
      { key: 'idCard', label: '身份证号', type: 'string', required: true },
      { key: 'name', label: '姓名', type: 'string', required: true },
      { key: 'rank', label: '职级', type: 'number', required: true },
      {
        key: 'badgeToken',
        label: '胸牌卡号',
        type: 'string',
        required: true,
        defaultGenerator: {
          kind: 'template',
          pattern: 'CARD-{{date:YYYYMMDD}}-{{alphanumeric:6}}',
          unique: true,
        },
      },
      {
        key: 'assignedDept',
        label: '所属部门',
        type: 'string',
        required: false,
        defaultGenerator: { kind: 'fixed', value: 'DEPT-TECH' },
      },
    ]

    const mapped = autoMapDataset(parsed.activeSheet.columns, scenarioInputs)
    expect(mapped.binding['empId']).toEqual({ source: 'column', columnName: '工号' })
    expect(mapped.binding['idCard']).toEqual({ source: 'column', columnName: '身份证号' })
    expect(mapped.binding['name']).toEqual({ source: 'column', columnName: '姓名' })
    expect(mapped.binding['rank']).toEqual({ source: 'column', columnName: '职级' })
    expect(mapped.binding['badgeToken']?.source).toBe('generator')
    expect(mapped.binding['assignedDept']?.source).toBe('generator')

    // 运行预检校验
    const preflight = preflightDataset(parsed.activeSheet.rows, mapped.binding, scenarioInputs)
    expect(preflight.totalRows).toBe(6)
    expect(preflight.validCount).toBe(5) // 5 行有效
    expect(preflight.errorCount).toBe(1) // 第 6 行（第 5 个索引）有必填项缺失和格式错误
    expect(preflight.issues.length).toBeGreaterThanOrEqual(1)
    expect(preflight.issues.some((issue) => issue.fieldKey === 'name')).toBe(true)

    // -------------------------------------------------------------
    // 步骤五：防风控节奏延迟算法与抖动区间检验（DC-08）
    // -------------------------------------------------------------
    // 配置延迟 2 秒，抖动 20% -> 范围应在 1600ms 到 2400ms 之间
    for (let i = 0; i < 20; i++) {
      const delay = calculatePacingDelayMs(2, 20)
      expect(delay).toBeGreaterThanOrEqual(1600)
      expect(delay).toBeLessThanOrEqual(2400)
    }

    // -------------------------------------------------------------
    // 步骤六：批次创建、并发滑动窗口与上下文固化（DC-03, DC-07, DC-11）
    // -------------------------------------------------------------
    // 仅合规数据用于验证（排除第 6 行索引为 5 的错误行）
    const validRowsToRun = parsed.activeSheet.rows.filter((_, idx) => idx !== 5)
    expect(validRowsToRun).toHaveLength(5)

    const batch = await createBatch(
      handle.db,
      {
        name: '2026年入职批量自动化-批次A',
        scenarioId,
        scenarioVersionId,
        datasetId: dataset.id,
        binding: mapped.binding,
        failurePolicy: 'stop_on_threshold',
        failureThreshold: 2, // 连续 2 次 TARGET 故障即触发熔断
      },
      accountId,
    )

    expect(batch.status).toBe('QUEUED')
    expect(batch.totalItems).toBe(6)

    // 限制并发窗口为 2
    const concurrencyLimit = 2
    const adv1 = await advanceBatch(handle.db, batch.id, concurrencyLimit)
    expect(adv1.dispatchedRunIds).toHaveLength(2)
    expect(adv1.paused).toBe(false)
    expect(adv1.completed).toBe(false)

    // 检验 Pre-run Context Materialization：第 1 个 Run 的上下文已固化
    const t = schemaFor(handle.db)
    const [firstRun] = await handle.db.select().from(t.runs).where(eq(t.runs.id, adv1.dispatchedRunIds[0]!))
    expect(firstRun).toBeDefined()
    const ctx = firstRun!.context as Record<string, any>
    expect(ctx.empId).toBe('00892') // 严格保留工号前导零
    expect(ctx.idCard).toBe('11010119900307235X') // 严格保留身份证文本
    expect(ctx.name).toBe('张伟')
    expect(ctx.rank).toBe('5') // 严格保留原始单元格字面量，防止隐式篡改
    expect(ctx.assignedDept).toBe('DEPT-TECH') // 默认 Mock 生成器成功固化
    expect(ctx.badgeToken).toMatch(/^CARD-\d{8}-[A-Za-z0-9]{6}$/) // 模板生成器格式正确且已固化

    // 在插槽满额时再次 advance，应派发 0 个
    const advFull = await advanceBatch(handle.db, batch.id, concurrencyLimit)
    expect(advFull.dispatchedRunIds).toHaveLength(0)

    // -------------------------------------------------------------
    // 步骤七：模拟自适应熔断器与故障分域（DC-12）
    // -------------------------------------------------------------
    // Run 1 成功完成
    await onRunSettledForBatch(handle.db, adv1.dispatchedRunIds[0]!, {
      status: 'passed',
    })

    // 空出 1 个槽位，派发第 3 个项
    const adv2 = await advanceBatch(handle.db, batch.id, concurrencyLimit)
    expect(adv2.dispatchedRunIds).toHaveLength(1)

    // Run 2 发生目标系统网络故障（TARGET 域错误）
    await onRunSettledForBatch(handle.db, adv1.dispatchedRunIds[1]!, {
      status: 'failed',
      failureDomain: 'TARGET',
      errorMessage: '502 Bad Gateway: 目标系统服务未就绪',
    })

    // 此时连续 TARGET 故障数累积为 1，尚未触及阈值 2，批次依然处于 RUNNING
    let currentBatch = await getBatch(handle.db, batch.id)
    expect(currentBatch!.status).toBe('RUNNING')

    // Run 3 再次发生目标系统超时（第二个 TARGET 域错误）
    await onRunSettledForBatch(handle.db, adv2.dispatchedRunIds[0]!, {
      status: 'failed',
      failureDomain: 'TARGET',
      errorMessage: 'NET::ERR_CONNECTION_TIMED_OUT: 目标系统挂起',
    })

    // 触碰连续 2 次 TARGET 故障阈值，批次自适应熔断，自动转为 PAUSED
    currentBatch = await getBatch(handle.db, batch.id)
    expect(currentBatch!.status).toBe('PAUSED')
    expect(currentBatch!.pausedReason).toContain('CIRCUIT_BREAKER_TRIGGERED')

    // 熔断状态下调用 advanceBatch 不会再派发任务
    const advDuringPause = await advanceBatch(handle.db, batch.id, concurrencyLimit)
    expect(advDuringPause.paused).toBe(true)
    expect(advDuringPause.dispatchedRunIds).toHaveLength(0)

    // -------------------------------------------------------------
    // 步骤八：批次恢复与收尾完成（DC-14）
    // -------------------------------------------------------------
    await resumeBatch(handle.db, batch.id, accountId)
    currentBatch = await getBatch(handle.db, batch.id)
    expect(currentBatch!.status).toBe('RUNNING')

    // 推进剩余项（3 项）
    const adv3 = await advanceBatch(handle.db, batch.id, 5)
    expect(adv3.dispatchedRunIds).toHaveLength(3)
    for (const runId of adv3.dispatchedRunIds) {
      await onRunSettledForBatch(handle.db, runId, { status: 'passed' })
    }

    // 完成批次
    await advanceBatch(handle.db, batch.id, 5)
    const finalBatch = await getBatch(handle.db, batch.id)
    expect(finalBatch!.status).toBe('COMPLETED')
    expect(finalBatch!.successItems).toBe(4)
    expect(finalBatch!.failedItems).toBe(2)

    // -------------------------------------------------------------
    // 步骤九：多 Sheet Excel 导出与回读防腐检验（DC-13）
    // -------------------------------------------------------------
    const exportResult = await exportBatchResults(handle.db, batch.id)
    expect(exportResult.filename).toContain('2026年入职批量自动化-批次A_执行结果.xlsx')
    expect(exportResult.rowCount).toBe(6)

    // 将导出的 Base64 重新还原为二进制字节并再次解析，确保导出的 Excel 完全合规且文本未损坏
    const binaryStr = atob(exportResult.base64)
    const exportedBytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      exportedBytes[i] = binaryStr.charCodeAt(i)
    }

    const reParsed = parseExcelOrCsv(exportedBytes, exportResult.filename)
    expect(reParsed.sheetNames).toEqual(['执行结果', '成功明细', '失败明细'])

    // 检查 执行结果 表中工号与身份证文本完全无损
    const resultSheet = parseExcelOrCsv(exportedBytes, exportResult.filename, { sheet: '执行结果' }).activeSheet
    expect(resultSheet.rowCount).toBe(6)

    // 验证前导零与身份证长文本在导出文件中依然完好无损
    const colExpEmp = resultSheet.columns.find((c) => c.name === '工号')!
    const colExpIdCard = resultSheet.columns.find((c) => c.name === '身份证号')!
    const colExpDuration = resultSheet.columns.find((c) => c.name === '_cairn_duration_ms')!
    expect(colExpDuration).toBeDefined()
    expect(resultSheet.rows[0]![colExpEmp.key]).toBe('00892')
    expect(resultSheet.rows[0]![colExpIdCard.key]).toBe('11010119900307235X')

    // 7. 重试失败项能力验证（DC-14）
    const retriedBatch = await retryFailedBatch(handle.db, batch.id, accountId)
    expect(retriedBatch.name).toContain('[重试] 2026年入职批量自动化-批次A')
    expect(retriedBatch.totalItems).toBe(2) // 仅重试 2 个失败项
    expect(retriedBatch.status).toBe('QUEUED')
  })
})
