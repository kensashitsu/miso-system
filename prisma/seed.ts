import 'dotenv/config'
import { PrismaClient } from '../lib/generated/prisma'
import { subDays, startOfDay } from 'date-fns'

const prisma = new PrismaClient()

async function main() {
  const today = startOfDay(new Date())

  // 既存のシードデータをクリア（開発用）
  await prisma.locationHistory.deleteMany()
  await prisma.brewRecord.deleteMany()
  await prisma.lot.deleteMany()

  console.log('既存データを削除しました')

  // ロット1: 無添加麦みそ（60日前仕込み、温調室24℃で熟成中）
  // 積算温度: 約61日 × 14 = 854℃ / 目標700℃ ≒ 122% → 要注意（オレンジ）
  const brew1 = subDays(today, 60)
  await prisma.lot.create({
    data: {
      lotNumber: '202503-001',
      misoType: '無添加麦みそ',
      brewedAt: brew1,
      totalWeightKg: 1600,
      targetTempSum: 700,
      status: '熟成中',
      brewRecord: {
        create: {
          mugiOrKomeKg: 500,
          kojiKg: 300,
          soybeanKg: 600,
          saltKg: 180,
          shikomiKg: 1600,
          kojiCondition: 7,
          soybeanOrigin: '山口県産',
        },
      },
      locationHistory: {
        create: {
          location: '温調室24℃',
          startDate: brew1,
        },
      },
    },
  })
  console.log('202503-001 (無添加麦みそ) 作成完了')

  // ロット2: 田舎みそ（45日前仕込み、温調室24℃で熟成中）
  // 積算温度: 約46日 × 14 = 644℃ / 目標700℃ ≒ 92% → 通常、残り約4日で完成
  const brew2 = subDays(today, 45)
  await prisma.lot.create({
    data: {
      lotNumber: '202504-001',
      misoType: '田舎みそ',
      brewedAt: brew2,
      totalWeightKg: 1600,
      targetTempSum: 700,
      status: '熟成中',
      brewRecord: {
        create: {
          mugiOrKomeKg: 480,
          kojiKg: 290,
          soybeanKg: 610,
          saltKg: 185,
          shikomiKg: 1600,
          kojiCondition: 6,
          soybeanOrigin: 'カナダ産',
        },
      },
      locationHistory: {
        create: {
          location: '温調室24℃',
          startDate: brew2,
        },
      },
    },
  })
  console.log('202504-001 (田舎みそ) 作成完了')

  // ロット3: 山吹みそ（40日前仕込み、35日後に完成→温調室20℃で待機中）
  // 温調室24℃ 35日間: 35 × 14 = 490℃ = 目標到達
  // 温調室20℃ 5日間: 5 × 10 = 50℃ → 合計540℃ / 490℃ ≒ 110% → 通常
  const brew3 = subDays(today, 40)
  const completed3 = subDays(today, 5) // 35日後に完成
  await prisma.lot.create({
    data: {
      lotNumber: '202504-002',
      misoType: '山吹みそ',
      brewedAt: brew3,
      totalWeightKg: 1300,
      targetTempSum: 490,
      status: '完成',
      completedAt: completed3,
      brewRecord: {
        create: {
          mugiOrKomeKg: 400,
          kojiKg: 240,
          soybeanKg: 490,
          saltKg: 140,
          shikomiKg: 1300,
          kojiCondition: 8,
          soybeanOrigin: '山口県産',
        },
      },
      locationHistory: {
        create: [
          {
            location: '温調室24℃',
            startDate: brew3,
            endDate: completed3,
          },
          {
            location: '温調室20℃',
            startDate: completed3,
          },
        ],
      },
    },
  })
  console.log('202504-002 (山吹みそ) 作成完了')

  console.log('\nシードデータ作成完了:')
  console.log('  202503-001 無添加麦みそ: 熟成中 / 温調室24℃ / 約122% (要注意)')
  console.log('  202504-001 田舎みそ:     熟成中 / 温調室24℃ / 約92% (完成まで約4日)')
  console.log('  202504-002 山吹みそ:     完成   / 温調室20℃待機 / 約110%')

  // 品種レシピのシード（upsert ─ 既存データを上書き）
  const recipeData = [
    {
      name: '無添加麦みそ', grainLabel: '裸麦',
      grainKg: 650, soybeanKg: 270, saltKg: 171, mizuameKg: 0,
      totalWeightKg: 1600, targetTempSum: 700,
      defaultLocation: '温調室24℃', soybeanOrigin: '山口県産', sortOrder: 1,
    },
    {
      name: '田舎みそ', grainLabel: '裸麦',
      grainKg: 650, soybeanKg: 270, saltKg: 171, mizuameKg: 50,
      totalWeightKg: 1600, targetTempSum: 700,
      defaultLocation: '温調室24℃', soybeanOrigin: 'カナダ産', sortOrder: 2,
    },
    {
      name: '山吹みそ', grainLabel: '砕米',
      grainKg: 360, soybeanKg: 330, saltKg: 148, mizuameKg: 50,
      totalWeightKg: 1300, targetTempSum: 490,
      defaultLocation: '温調室24℃', soybeanOrigin: 'カナダ産', sortOrder: 3,
    },
    {
      name: '白みそ', grainLabel: '無洗米',
      grainKg: 60, soybeanKg: 30, saltKg: 11, mizuameKg: 0,
      totalWeightKg: 150, targetTempSum: 70,
      defaultLocation: '温調室24℃', soybeanOrigin: '山口県産', sortOrder: 4,
    },
  ]
  for (const r of recipeData) {
    await prisma.misoRecipe.upsert({
      where: { name: r.name },
      create: r,
      update: r,
    })
  }
  console.log('品種レシピ 4件 upsert 完了')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
