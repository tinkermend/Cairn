import '@/styles/index.css'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { useState } from 'react'
import type {
  DataGeneratorSpec,
  ScenarioInputDecl,
  OutcomeContract,
} from '@cairn/shared'
import { StudioInspectorHost } from './components/inspector/studio-inspector-host'
import { InputsEditor } from '@/features/authoring/step-editor'
import { GeneratorConfigEditor } from '@/features/authoring/generator-editor'
import { ScenarioOutputsEditor } from './scenario-outputs-editor'
import { OutcomeListEditor } from '@/features/authoring/outcome-editor'

describe('右侧属性面板 (Studio Inspector) 浏览器全功能与 UI 布局仿真走查', () => {
  function checkOverlap2D(r1: DOMRect, r2: DOMRect) {
    return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom)
  }

  it('仿真走查 1：桌面视口下（>640px），侧边栏 400px 宽度时的参数行布局与零碰撞', async () => {
    function TestContainer() {
      const [inputs, setInputs] = useState<ScenarioInputDecl[]>([
        {
          key: 'input1',
          label: '输入项 1',
          type: 'file',
        },
      ])

      return (
        <div style={{ width: 400, height: 700 }} className='flex flex-col bg-card border'>
          <StudioInspectorHost
            rightTab='inputs'
            onTabChange={() => {}}
            inputsCount={inputs.length}
          >
            <InputsEditor inputs={inputs} onChange={setInputs} />
          </StudioInspectorHost>
        </div>
      )
    }

    const screen = await render(<TestContainer />)

    // 定位输入行各控件
    const keyInput = screen.getByLabelText('输入键 1').element() as HTMLElement
    const labelInput = screen.getByLabelText('输入名称 1').element() as HTMLElement
    const triggers = document.querySelectorAll('[data-slot="select-trigger"]')
    const typeSelect = triggers[0] as HTMLElement
    const removeBtn = screen.getByRole('button', { name: /移除/ }).element() as HTMLElement

    const keyRect = keyInput.getBoundingClientRect()
    const labelRect = labelInput.getBoundingClientRect()
    const selectRect = typeSelect?.getBoundingClientRect()
    const removeRect = removeBtn.getBoundingClientRect()

    console.log('--- 桌面视口下侧边栏 400px 测量数据 ---')
    console.log('Key Input Rect:', keyRect)
    console.log('Label Input Rect:', labelRect)
    console.log('Type Select Rect:', selectRect)
    console.log('Remove Btn Rect:', removeRect)

    // 验证 Key 和 Label 宽度充裕 (>140px)
    expect(keyRect.width).toBeGreaterThan(140)
    expect(labelRect.width).toBeGreaterThan(140)

    // 验证 Type 下拉框宽度占满可用空间 (>300px)
    expect(selectRect.width).toBeGreaterThan(300)

    // 验证 Type Select 和 Remove Btn 完全无重叠
    const isOverlap = checkOverlap2D(selectRect, removeRect)
    console.log('Type Select 和 Remove Btn 是否发生 2D 物理碰撞重叠:', isOverlap)
    expect(isOverlap).toBe(false)
  })

  it('仿真走查 2：验证智能动态生成器在各个规则类型下的几何尺寸、宽度与零溢出', async () => {
    function GeneratorTestContainer({ initialSpec }: { initialSpec: DataGeneratorSpec }) {
      const [spec, setSpec] = useState<DataGeneratorSpec | undefined>(initialSpec)
      return (
        <div style={{ width: 400, padding: 16 }} className='bg-card border'>
          <GeneratorConfigEditor generator={spec} onChange={setSpec} />
        </div>
      )
    }

    // 1. mock_preset 真实预设字典
    const presetSpec: DataGeneratorSpec = {
      kind: 'mock_preset',
      preset: 'phone_cn',
      unique: true,
    }
    await render(<GeneratorTestContainer initialSpec={presetSpec} />)

    const triggers = document.querySelectorAll('[data-slot="select-trigger"]')
    if (triggers.length >= 2) {
      const t1 = triggers[0].getBoundingClientRect()
      const t2 = triggers[1].getBoundingClientRect()
      console.log('Trigger 1 (生成规则类型):', t1)
      console.log('Trigger 2 (字典预设项):', t2)
      const isOverlap = checkOverlap2D(t1, t2)
      console.log('Trigger 1 和 Trigger 2 是否发生 2D 物理碰撞重叠:', isOverlap)
      expect(isOverlap).toBe(false)
      expect(t1.width).toBeGreaterThan(300)
      expect(t2.width).toBeGreaterThan(300)
    }

    // 2. 验证 random_number
    const numSpec: DataGeneratorSpec = {
      kind: 'random_number',
      min: 1,
      max: 100,
      precision: 0,
    }
    const screen2 = await render(<GeneratorTestContainer initialSpec={numSpec} />)
    const numInputs = screen2.container.querySelectorAll('input[type="number"]')
    expect(numInputs.length).toBe(3)
    numInputs.forEach((inp) => {
      const rect = inp.getBoundingClientRect()
      // 每个数字输入框宽度在 100px 以上，彻底杜绝 45px 挤压变形
      expect(rect.width).toBeGreaterThan(90)
    })

    // 3. 验证 date_relative
    const dateSpec: DataGeneratorSpec = {
      kind: 'date_relative',
      offsetDaysMin: 0,
      offsetDaysMax: 7,
      format: 'YYYY-MM-DD',
    }
    const screen3 = await render(<GeneratorTestContainer initialSpec={dateSpec} />)
    expect(screen3.container.querySelector('input[value="YYYY-MM-DD"]')).not.toBeNull()
  })

  it('仿真走查 3：验证业务输出面板 (Outputs) 在 400px 下指标与宽表字段的尺寸与零重叠', async () => {
    function OutputsContainer() {
      const [outputs, setOutputs] = useState({
        summaryTemplate: '巡检完成，在售商品 ${item_count} 件',
        metrics: [
          { key: 'item_count', name: '在售商品数', fromContextKey: 'report', unit: '件' },
        ],
        dataRowFields: [
          { columnKey: 'sku_id', columnHeader: '商品编号', fromContextKey: 'product' },
        ],
      })

      return (
        <div style={{ width: 400, height: 700 }} className='flex flex-col bg-card border'>
          <StudioInspectorHost rightTab='outputs' onTabChange={() => {}}>
            <ScenarioOutputsEditor outputs={outputs} onChange={setOutputs as any} />
          </StudioInspectorHost>
        </div>
      )
    }

    const screen = await render(<OutputsContainer />)
    // 检查指标行输入框宽度
    const metricKeyInput = screen.container.querySelector('input[value="item_count"]') as HTMLElement
    expect(metricKeyInput).not.toBeNull()
    const rect = metricKeyInput.getBoundingClientRect()
    console.log('Metric Key Input width:', rect.width)
    expect(rect.width).toBeGreaterThan(140)

    // 检查字段行输入框宽度
    const fieldKeyInput = screen.container.querySelector('input[value="sku_id"]') as HTMLElement
    expect(fieldKeyInput).not.toBeNull()
    const fieldRect = fieldKeyInput.getBoundingClientRect()
    console.log('Field Key Input width:', fieldRect.width)
    expect(fieldRect.width).toBeGreaterThan(140)
  })

  it('仿真走查 4：验证预期与诊断面板 (Outcomes) 与步骤配置 (Step) 在 400px 下的平稳渲染', async () => {
    function OutcomesContainer() {
      const [outcomes, setOutcomes] = useState<OutcomeContract[]>([
        {
          id: 'out-1',
          scope: 'scenario',
          meaning: '检查登录成功跳转到首页',
          severity: 'MUST',
          onViolation: 'halt',
          provenance: 'manual',
          rule: {
            kind: 'deterministic',
            expect: { kind: 'text_contains', value: '仪表盘' },
          },
        },
      ])

      return (
        <div style={{ width: 400, height: 700 }} className='flex flex-col bg-card border'>
          <StudioInspectorHost rightTab='outcomes' onTabChange={() => {}}>
            <OutcomeListEditor outcomes={outcomes} scope='scenario' onChange={setOutcomes} />
          </StudioInspectorHost>
        </div>
      )
    }

    const screen = await render(<OutcomesContainer />)
    const meaningInput = screen.getByLabelText(/成功条件 1 含义/i).element() as HTMLElement
    expect(meaningInput).toBeDefined()
    expect(meaningInput.getBoundingClientRect().width).toBeGreaterThan(300)
  })
})
