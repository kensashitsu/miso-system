'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

// 仕込めない週（全品種共通）。SystemSetting に月曜日の 'yyyy-MM-dd' 配列で保存する。
// AI仕込み提案はこの週を避けて翌週以降で提案する。
const KEY = 'planning_blockedWeeks'

async function read(): Promise<string[]> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } })
  try {
    const parsed = JSON.parse(row?.value ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

async function write(weeks: string[]): Promise<void> {
  const value = JSON.stringify([...new Set(weeks)].sort())
  await prisma.systemSetting.upsert({
    where:  { key: KEY },
    update: { value },
    create: { key: KEY, value },
  })
  revalidatePath('/planning')
}

export async function getBlockedWeeks(): Promise<string[]> {
  return read()
}

// weekStart は月曜日の 'yyyy-MM-dd'
export async function addBlockedWeek(weekStart: string): Promise<string[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return read()
  const weeks = [...(await read()), weekStart]
  await write(weeks)
  return [...new Set(weeks)].sort()
}

export async function removeBlockedWeek(weekStart: string): Promise<string[]> {
  const weeks = (await read()).filter(w => w !== weekStart)
  await write(weeks)
  return weeks
}
