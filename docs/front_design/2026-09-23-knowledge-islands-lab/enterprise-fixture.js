/* 纯演示 fixture：虚构系统、菜单、对象、验证状态和场景引用；不连接识途 API，也不代表真实业务事实。 */
/* 功能分组是人工编排的演示配置，不从 DOM 位置推断，也不代表现有 Map 契约。 */
function orderDemoButton(id, name, featureGroup, scenario, lifecycle = 'TRUSTED') {
  const trusted = lifecycle === 'TRUSTED';
  const degraded = lifecycle === 'DEGRADED';
  return {
    id, name, kind: '按钮', featureGroup, lifecycle,
    evidence: trusted ? 'available' : degraded ? 'partial' : 'unavailable',
    verified: lifecycle === 'DISCOVERED' ? null : degraded ? '2026-09-20 11:20' : '2026-09-22 16:35',
    changes: degraded ? 1 : 0,
    dimensions: trusted ? ['confirmed', 'confirmed', 'confirmed', 'not_observed'] : degraded ? ['confirmed', 'unknown', 'confirmed', 'not_observed'] : ['unknown', 'unknown', 'unknown', 'not_observed'],
    confirmed: lifecycle === 'DISCOVERED' ? [] : [scenario],
    potential: lifecycle === 'DISCOVERED' ? [scenario] : [],
  };
}
const ENTERPRISE_DEMO = {
  name: '综合业务系统',
  projection: '演示投影 r22',
  computedAt: '2026-09-23 10:42',
  districts: [
    { id: 'sales', name: '客户与销售', description: '从客户接入到订单生成' },
    { id: 'delivery', name: '交付与服务', description: '从履约派工到售后闭环' },
    { id: 'finance', name: '经营与财务', description: '从开票收款到经营分析' },
    { id: 'management', name: '管理与配置', description: '人员、审批与平台规则' },
  ],
  pages: [
    { id: 'enterprise-customers', name: '客户档案', route: '/crm/customers', districtId: 'sales', objects: [
      { id: 'ent-customer-code', name: '客户编号', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 16:35', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-201', '客户资料建档']], potential: [] },
      { id: 'ent-customer-merge', name: '合并客户', kind: '按钮', lifecycle: 'DEGRADED', evidence: 'partial', verified: '2026-09-20 11:22', changes: 1, dimensions: ['confirmed', 'unknown', 'confirmed', 'not_observed'], confirmed: [['S-201', '客户资料建档']], potential: [['S-216', '客户去重巡检']] },
    ] },
    { id: 'enterprise-leads', name: '线索管理', route: '/crm/leads', districtId: 'sales', objects: [
      { id: 'ent-lead-source', name: '线索来源', kind: '字段', lifecycle: 'DISCOVERED', evidence: 'partial', verified: null, changes: 0, dimensions: ['unknown', 'unknown', 'unknown', 'not_observed'], confirmed: [], potential: [['S-205', '线索分配']] },
      { id: 'ent-lead-convert', name: '转为商机', kind: '按钮', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-21 14:12', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-205', '线索分配']], potential: [] },
    ] },
    { id: 'enterprise-quotes', name: '报价管理', route: '/sales/quotes', districtId: 'sales', objects: [
      { id: 'ent-quote-total', name: '报价总额', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 10:18', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-212', '生成销售报价']], potential: [] },
      { id: 'ent-quote-approve', name: '提交报价审批', kind: '按钮', lifecycle: 'DEGRADED', evidence: 'partial', verified: '2026-09-19 17:40', changes: 2, dimensions: ['confirmed', 'rejected', 'confirmed', 'not_observed'], confirmed: [['S-212', '生成销售报价']], potential: [['S-214', '报价审批跟进']] },
    ] },
    { id: 'enterprise-orders', name: '订单中心', route: '/sales/orders', districtId: 'sales', featureGroups: [
      { id: 'lookup', name: '查询与筛选', description: '查找和缩小订单范围' },
      { id: 'editing', name: '订单处理', description: '创建、编辑与状态变更' },
      { id: 'fulfillment', name: '履约协同', description: '负责人、履约与异常处理' },
      { id: 'output', name: '数据输出', description: '导出和打印订单' },
    ], objects: [
      { id: 'ent-order-id', name: '订单编号', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 16:35', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-227', '创建销售订单']], potential: [] },
      orderDemoButton('ent-order-query', '查询订单', 'lookup', ['S-231', '订单履约跟踪']),
      orderDemoButton('ent-order-reset', '重置筛选', 'lookup', ['S-231', '订单履约跟踪']),
      orderDemoButton('ent-order-advanced', '高级筛选', 'lookup', ['S-231', '订单履约跟踪'], 'DISCOVERED'),
      orderDemoButton('ent-order-create', '新建订单', 'editing', ['S-227', '创建销售订单']),
      orderDemoButton('ent-order-edit', '编辑订单', 'editing', ['S-227', '创建销售订单']),
      orderDemoButton('ent-order-submit', '提交订单', 'editing', ['S-227', '创建销售订单']),
      orderDemoButton('ent-order-copy', '复制订单', 'editing', ['S-227', '创建销售订单'], 'DISCOVERED'),
      orderDemoButton('ent-order-cancel', '取消订单', 'editing', ['S-231', '订单履约跟踪'], 'DEGRADED'),
      orderDemoButton('ent-order-owner', '分配负责人', 'fulfillment', ['S-231', '订单履约跟踪']),
      orderDemoButton('ent-order-fulfill', '发起履约', 'fulfillment', ['S-231', '订单履约跟踪'], 'DEGRADED'),
      orderDemoButton('ent-order-exception', '标记异常', 'fulfillment', ['S-239', '交期风险提醒']),
      orderDemoButton('ent-order-export', '导出订单', 'output', ['S-233', '订单数据导出']),
      orderDemoButton('ent-order-print', '打印订单', 'output', ['S-233', '订单数据导出'], 'DEGRADED'),
    ] },

    { id: 'enterprise-plans', name: '交付计划', route: '/delivery/plans', districtId: 'delivery', objects: [
      { id: 'ent-plan-eta', name: '预计交付日', kind: '字段', lifecycle: 'DEGRADED', evidence: 'partial', verified: '2026-09-18 09:45', changes: 1, dimensions: ['confirmed', 'unknown', 'confirmed', 'not_observed'], confirmed: [['S-231', '订单履约跟踪']], potential: [['S-239', '交期风险提醒']] },
      { id: 'ent-plan-confirm', name: '确认交付', kind: '按钮', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-21 16:08', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-231', '订单履约跟踪']], potential: [] },
    ] },
    { id: 'enterprise-tasks', name: '任务派发', route: '/delivery/tasks', districtId: 'delivery', objects: [
      { id: 'ent-task-owner', name: '执行负责人', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-20 14:30', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-235', '交付任务派发']], potential: [] },
      { id: 'ent-task-reassign', name: '重新指派', kind: '按钮', lifecycle: 'DISCOVERED', evidence: 'unavailable', verified: null, changes: 0, dimensions: ['unknown', 'unknown', 'unknown', 'not_observed'], confirmed: [], potential: [['S-235', '交付任务派发']] },
    ] },
    { id: 'enterprise-tickets', name: '服务工单', route: '/service/tickets', districtId: 'delivery', objects: [
      { id: 'ent-ticket-priority', name: '工单优先级', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 09:10', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-248', '服务工单分流']], potential: [] },
      { id: 'ent-ticket-close', name: '关闭工单', kind: '按钮', lifecycle: 'DEGRADED', evidence: 'partial', verified: '2026-09-19 13:20', changes: 1, dimensions: ['confirmed', 'unknown', 'confirmed', 'not_observed'], confirmed: [['S-248', '服务工单分流']], potential: [['S-251', '工单满意度回访']] },
    ] },
    { id: 'enterprise-returns', name: '退换货', route: '/service/returns', districtId: 'delivery', objects: [
      { id: 'ent-return-reason', name: '退货原因', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-21 11:55', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-254', '退货申请核对']], potential: [] },
      { id: 'ent-return-approve', name: '通过申请', kind: '按钮', lifecycle: 'DISCOVERED', evidence: 'unavailable', verified: null, changes: 0, dimensions: ['unknown', 'unknown', 'unknown', 'not_observed'], confirmed: [], potential: [['S-254', '退货申请核对']] },
    ] },

    { id: 'enterprise-invoices', name: '发票管理', route: '/finance/invoices', districtId: 'finance', objects: [
      { id: 'ent-invoice-number', name: '发票号码', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 15:30', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-267', '销售订单开票']], potential: [] },
      { id: 'ent-invoice-issue', name: '开具发票', kind: '按钮', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 15:30', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-267', '销售订单开票']], potential: [] },
    ] },
    { id: 'enterprise-receivables', name: '应收账款', route: '/finance/receivables', districtId: 'finance', objects: [
      { id: 'ent-receivable-balance', name: '未收余额', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-21 10:05', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-273', '应收账款巡检']], potential: [] },
      { id: 'ent-payment-match', name: '核销收款', kind: '按钮', lifecycle: 'DEGRADED', evidence: 'partial', verified: '2026-09-18 12:42', changes: 2, dimensions: ['confirmed', 'rejected', 'confirmed', 'not_observed'], confirmed: [['S-273', '应收账款巡检']], potential: [['S-277', '收款自动匹配']] },
    ] },
    { id: 'enterprise-dashboard', name: '经营看板', route: '/analytics/dashboard', districtId: 'finance', objects: [
      { id: 'ent-dashboard-revenue', name: '本月收入', kind: '指标', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 08:00', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-281', '经营日报巡检']], potential: [] },
      { id: 'ent-dashboard-refresh', name: '刷新数据', kind: '按钮', lifecycle: 'DISCOVERED', evidence: 'partial', verified: null, changes: 0, dimensions: ['unknown', 'unknown', 'unknown', 'not_observed'], confirmed: [], potential: [['S-281', '经营日报巡检']] },
    ] },
    { id: 'enterprise-budgets', name: '预算管理', route: '/finance/budgets', districtId: 'finance', objects: [
      { id: 'ent-budget-limit', name: '预算上限', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-20 13:22', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-286', '预算占用核对']], potential: [] },
      { id: 'ent-budget-adjust', name: '调整预算', kind: '按钮', lifecycle: 'DEGRADED', evidence: 'partial', verified: '2026-09-17 09:18', changes: 1, dimensions: ['confirmed', 'unknown', 'confirmed', 'not_observed'], confirmed: [['S-286', '预算占用核对']], potential: [['S-289', '超支预警']] },
    ] },

    { id: 'enterprise-users', name: '人员与角色', route: '/admin/users', districtId: 'management', objects: [
      { id: 'ent-user-role', name: '人员角色', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 11:10', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-302', '人员权限核对']], potential: [] },
      { id: 'ent-user-invite', name: '邀请成员', kind: '按钮', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-21 10:10', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-302', '人员权限核对']], potential: [] },
    ] },
    { id: 'enterprise-approvals', name: '审批中心', route: '/admin/approvals', districtId: 'management', objects: [
      { id: 'ent-approval-status', name: '审批状态', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-22 12:45', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'confirmed'], confirmed: [['S-308', '待办审批巡检']], potential: [] },
      { id: 'ent-approval-bulk', name: '批量通过', kind: '按钮', lifecycle: 'DEGRADED', evidence: 'partial', verified: '2026-09-19 15:33', changes: 1, dimensions: ['confirmed', 'unknown', 'confirmed', 'not_observed'], confirmed: [['S-308', '待办审批巡检']], potential: [['S-312', '超时审批提醒']] },
    ] },
    { id: 'enterprise-rules', name: '自动化规则', route: '/admin/automations', districtId: 'management', objects: [
      { id: 'ent-rule-trigger', name: '触发条件', kind: '字段', lifecycle: 'DISCOVERED', evidence: 'partial', verified: null, changes: 0, dimensions: ['unknown', 'unknown', 'unknown', 'not_observed'], confirmed: [], potential: [['S-318', '规则配置巡检']] },
      { id: 'ent-rule-enable', name: '启用规则', kind: '开关', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-21 16:20', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-318', '规则配置巡检']], potential: [] },
    ] },
    { id: 'enterprise-settings', name: '系统配置', route: '/admin/settings', districtId: 'management', objects: [
      { id: 'ent-tenant-timezone', name: '系统时区', kind: '字段', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-20 17:05', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-325', '环境配置核对']], potential: [] },
      { id: 'ent-settings-save', name: '保存配置', kind: '按钮', lifecycle: 'TRUSTED', evidence: 'available', verified: '2026-09-20 17:05', changes: 0, dimensions: ['confirmed', 'confirmed', 'confirmed', 'not_observed'], confirmed: [['S-325', '环境配置核对']], potential: [] },
    ] },
  ],
};
