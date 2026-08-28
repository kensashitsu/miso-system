// AI仕込み提案の入力データを本番DBから取り出して確認するデバッグ用スクリプト
import { PrismaClient } from '../lib/generated/prisma'

const prisma = new PrismaClient()

const [recipes, plans, weather] = await Promise.all([
  prisma.misoRecipe.findMany({ select: { name: true, totalWeightKg: true, targetTempSum: true, safetyStockKg: true, isActive: true } }),
  prisma.brewPlan.findMany({ where: { status: '仮登録' }, orderBy: { brewDate: 'asc' } }),
  prisma.weatherCache.findMany({ orderBy: { date: 'desc' }, take: 1 }),
])
console.log('=== レシピ ===')
for (const r of recipes) console.log(` ${r.name} 生産量${r.totalWeightKg}kg 目標${r.targetTempSum} 安全在庫${r.safetyStockKg} active=${r.isActive}`)
console.log('=== 仮登録 ===')
for (const p of plans) console.log(` ${p.misoType} 仕込${p.brewDate.toISOString().slice(0,10)} 完成${p.completionDate.toISOString().slice(0,10)} 桶${p.bucketNumbers}`)
console.log('=== 気象最終日 ===', weather[0]?.date.toISOString().slice(0,10))

const lots = await prisma.lot.findMany({ where: { status: '熟成中' }, include: { buckets: true } })
console.log('=== 熟成中ロット ===')
for (const l of lots) {
  const kg = l.buckets.filter(b => b.status !== '空').reduce((s, b) => s + (b.remainingWeightKg ?? b.initialWeightKg), 0)
  console.log(` ${l.lotNumber} ${l.misoType} 仕込${l.brewedAt.toISOString().slice(0,10)} 残${Math.round(kg)}kg`)
}

const fc = await prisma.forecastCache.findMany({ where: { misoType: '無添加麦みそ' }, orderBy: { yearMonth: 'asc' } })
console.log('=== SARIMAX予測(無添加麦みそ) ===')
console.log(fc.map(f => `${f.yearMonth}:${Math.round(f.forecastKg)}`).join(' '))
await prisma.$disconnect()
