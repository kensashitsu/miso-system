import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getCurrentLocation } from '@/lib/tempCalc'
import { getMoistureSettings } from '@/lib/settings'
import MoveForm from './MoveForm'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ id: string }>
}

export default async function MovePage({ params }: Props) {
  const { id } = await params
  const [lot, moisture] = await Promise.all([
    prisma.lot.findUnique({
      where: { id },
      include: { locationHistory: { orderBy: { startDate: 'asc' } } },
    }),
    getMoistureSettings(),
  ])
  if (!lot) notFound()

  const currentLocation = getCurrentLocation(lot.locationHistory)

  return (
    <MoveForm
      lotId={lot.id}
      lotNumber={lot.lotNumber}
      currentLocation={currentLocation}
      currentStatus={lot.status}
      heatingDefaultTemp={moisture.heatingDefaultTemp}
      coolingDefaultTemp={moisture.coolingDefaultTemp}
    />
  )
}
