'use client'

import {
  LineChart,
  Line,
  LabelList,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'

interface DataPoint {
  date: string       // yyyy-MM-dd
  accumulated: number
}

interface Props {
  data: DataPoint[]
  targetTempSum: number
  q10Value?: number
}

export default function TempChart({ data, targetTempSum, q10Value }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        データなし
      </div>
    )
  }

  return (
    <>
    {q10Value !== undefined && q10Value !== 1 && (
      <p className="text-xs text-muted-foreground mb-1">
        Q10補正あり（係数：{q10Value}）― 常温期間の積算温度に適用
      </p>
    )}
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 24, right: 16, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="date"
          tick={false}
          axisLine={{ stroke: 'hsl(var(--border))' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          domain={[0, Math.max(targetTempSum * 1.6, data[data.length - 1]?.accumulated ?? targetTempSum)]}
          stroke="hsl(var(--border))"
        />
        <ReferenceLine
          y={targetTempSum}
          stroke="hsl(var(--destructive))"
          strokeDasharray="6 3"
          label={{ value: `目標 ${targetTempSum}`, position: 'insideTopRight', fontSize: 11, fill: 'hsl(var(--destructive))' }}
        />
        <Line
          type="monotone"
          dataKey="accumulated"
          stroke="hsl(var(--primary))"
          dot={false}
          strokeWidth={2}
        >
          <LabelList
            dataKey="date"
            position="top"
            content={({ x, y, value, index }) => {
              if (typeof index !== 'number' || index % 7 !== 0) return null
              const label = typeof value === 'string' ? value.slice(5).replace('-', '/') : ''
              return (
                <text
                  x={x}
                  y={typeof y === 'number' ? y - 4 : y}
                  textAnchor="middle"
                  fontSize={10}
                  fill="hsl(var(--muted-foreground))"
                >
                  {label}
                </text>
              )
            }}
          />
        </Line>
      </LineChart>
    </ResponsiveContainer>
    </>
  )
}
