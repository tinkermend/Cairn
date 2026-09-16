// 靶场数据：结构仿 SNC DPM（2026-09-16 只读观察），名称刻意保留模糊查询冲突：
// “Mysql_主” 是 “mysql_主从架构_…” 的大小写不敏感子串。
export const INSTANCES = [
  { name: 'Mysql_主', app: 'Mysql', type: 'MySQL', sessions: 2 },
  { name: 'mysql_主从架构_192.168.50.40_3306', app: 'dbcloud', type: 'MySQL', sessions: 3 },
  { name: 'mysql_主从架构_192.168.50.41_3306', app: 'dbcloud', type: 'MySQL', sessions: 2 },
  { name: 'Mysql_从', app: 'Mysql', type: 'MySQL', sessions: 2 },
  { name: 'Mysql50.33', app: 'Mysql', type: 'MySQL', sessions: 46 },
  { name: 'DPM_Mysql_50.32', app: 'Mysql', type: 'MySQL', sessions: 128 },
  { name: 'Oracle11g-100.52', app: '核心账务', type: 'Oracle', sessions: 22 },
  { name: 'DG_Priamy_Oracle11g_100.2', app: '核心账务', type: 'Oracle', sessions: 30 },
  { name: 'Postgres12', app: '报表平台', type: 'PostgreSQL', sessions: 5 },
  { name: 'Postgres13', app: '报表平台', type: 'PostgreSQL', sessions: 4 },
  { name: 'db2_hadr_primay', app: '渠道系统', type: 'DB2', sessions: 1 },
  { name: 'db2_hadr_standby', app: '渠道系统', type: 'DB2', sessions: 1 },
]

export const ALARMS = [
  { id: 'a1', resource: 'db2_hadr_primay', kind: '资源', rule: 'DB2_表空间使用告警', firstAt: '2026-09-16 01:39:26', level: '一般', count: 1 },
  { id: 'a2', resource: '192.168.41.237_2881_oceanbase', kind: '性能', rule: 'OB_栓锁信息', firstAt: '2026-09-16 00:51:45', level: '严重', count: 1 },
  { id: 'a3', resource: 'Mysql_主', kind: '性能', rule: '[DEMO]mysql全局全表扫描率', firstAt: '2026-09-16 00:04:39', level: '告警', count: 1 },
  { id: 'a4', resource: 'Mysql_从', kind: '性能', rule: '[DEMO]mysql全局全表扫描率', firstAt: '2026-09-16 00:04:23', level: '告警', count: 1 },
]
