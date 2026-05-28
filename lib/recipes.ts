import { prisma } from './prisma'
import type { MisoRecipe } from './generated/prisma'

export type { MisoRecipe }

export async function getMisoRecipes(): Promise<MisoRecipe[]> {
  return prisma.misoRecipe.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  })
}
