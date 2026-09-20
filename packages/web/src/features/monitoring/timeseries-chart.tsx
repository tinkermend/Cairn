import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

export type TimeseriesSeries = {
  key: string
  label: string
  points: Array<{ bucketAt: string; value: number }>
}

export function TimeseriesChart({
  series,
  emptyLabel = '这个窗口没有样本，空洞不是 0。',
}: {
  series: TimeseriesSeries[]
  emptyLabel?: string
}) {
  const times = new Set<string>()
  for (const item of series) {
    for (const point of item.points) times.add(point.bucketAt)
  }
  const rows = [...times]
    .sort()
    .map((bucketAt) => {
      const row: Record<string, string | number | null> = { bucketAt }
      for (const item of series) {
        row[item.key] = item.points.find((point) => point.bucketAt === bucketAt)?.value ?? null
      }
      return row
    })
  if (rows.length === 0) {
    return <p className='text-body text-muted-foreground'>{emptyLabel}</p>
  }
  return (
    <div className='h-64 min-w-0'>
      <ResponsiveContainer width='100%' height='100%'>
        <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke='var(--chart-grid)' strokeDasharray='3 3' />
          <XAxis
            dataKey='bucketAt'
            stroke='var(--chart-axis)'
            tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
            tickFormatter={(value: string) =>
              new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
            }
          />
          <YAxis
            stroke='var(--chart-axis)'
            tick={{ fill: 'var(--chart-axis)', fontSize: 'var(--font-size-label)' }}
            allowDecimals
          />
          <Tooltip
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border-card)',
              color: 'var(--foreground)',
            }}
            labelFormatter={(value) => new Date(String(value)).toLocaleString('zh-CN', { hour12: false })}
          />
          <Legend />
          {series.map((item, index) => (
            <Line
              key={item.key}
              type='monotone'
              dataKey={item.key}
              name={item.label}
              stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
              dot={false}
              connectNulls={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
