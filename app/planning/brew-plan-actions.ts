'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export async function createBrewPlan(data: {
  misoType:                 string
  brewDateISO:              string
  completionDateISO:        string
  fermentationDays:         number
  location:                 string
  materialOrderDeadlineISO: string
}): Promise<{ id: string }> {
  const plan = await prisma.brewPlan.create({
    data: {
      misoType:             data.misoType,
      brewDate:             new Date(data.brewDateISO),
      completionDate:       new Date(data.completionDateISO),
      fermentationDays:     data.fermentationDays,
      location:             data.location,
      materialOrderDeadline: new Date(data.materialOrderDeadlineISO),
    },
  })
  revalidatePath('/planning')
  return { id: plan.id }
}

export async function deleteBrewPlan(id: string): Promise<void> {
  await prisma.brewPlan.delete({ where: { id } })
  revalidatePath('/planning')
}

export async function markBrewPlanRegistered(id: string, lotId: string): Promise<void> {
  await prisma.brewPlan.update({
    where: { id },
    data: { status: '本登録済', lotId },
  }).catch(() => {})
}
