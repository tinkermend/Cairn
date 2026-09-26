import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { scenarioOutputDeclSchema, type ScenarioOutputDecl } from '@cairn/shared'
import { ScenarioOutputsEditor } from './scenario-outputs-editor'

describe('ScenarioOutputsEditor', () => {
  it('渲染输出配置区：快捷插入变量、实时推演预览、增删指标与数据宽表', async () => {
    const onChange = vi.fn()
    const initialOutputs: ScenarioOutputDecl = {
      summaryTemplate: '巡检完成，在售商品 ${item_count} 件',
      metrics: [
        {
          key: 'item_count',
          name: '在售商品数',
          fromContextKey: 'report',
          fromField: 'total',
          unit: '件',
        },
      ],
      dataRowFields: [
        {
          columnKey: 'report_id',
          columnHeader: '报表编号',
          fromContextKey: 'report',
          fromField: 'id',
        },
      ],
    }

    const { getByText, getByTestId, getByRole } = await render(
      <ScenarioOutputsEditor
        outputs={initialOutputs}
        availableContextKeys={['report', 'custom_val']}
        onChange={onChange}
      />,
    )

    // 检查标题与现有值
    await expect.element(getByText('场景业务输出与指标声明')).toBeInTheDocument()
    await expect.element(getByText('核心指标 (1/20)')).toBeInTheDocument()
    await expect.element(getByText('单行宽表字段 (1/20)')).toBeInTheDocument()

    // 检查实时推演预览面板：${item_count} 被模拟为带有单位的样例值
    const previewEl = getByTestId('summary-preview-panel')
    await expect.element(previewEl).toBeInTheDocument()
    await expect.element(previewEl).toHaveTextContent('巡检完成，在售商品 1,420 件 件')

    // 检查快捷插入变量按键
    const insertCustomBtn = getByRole('button', { name: /\+.*custom_val.*/ })
    await expect.element(insertCustomBtn).toBeInTheDocument()
    await insertCustomBtn.click()

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryTemplate: '巡检完成，在售商品 ${item_count} 件${custom_val}',
      }),
    )

    // 测试添加指标
    const addMetricBtn = getByRole('button', { name: /添加指标/ })
    await addMetricBtn.click()
    expect(() => scenarioOutputDeclSchema.parse(onChange.mock.lastCall?.[0])).not.toThrow()
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.arrayContaining([
          expect.objectContaining({ key: 'item_count' }),
          expect.objectContaining({ key: 'metric_2' }),
        ]),
      }),
    )

    // 测试添加宽表字段
    const addFieldBtn = getByRole('button', { name: /添加字段/ })
    await addFieldBtn.click()
    expect(() => scenarioOutputDeclSchema.parse(onChange.mock.lastCall?.[0])).not.toThrow()
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        dataRowFields: expect.arrayContaining([
          expect.objectContaining({ columnKey: 'report_id' }),
          expect.objectContaining({ columnKey: 'field_2' }),
        ]),
      }),
    )
  })
})
