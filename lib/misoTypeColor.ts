import type { CSSProperties } from 'react'

type BadgeStyle = {
  background: string
  color: string
  border: string
}

const STYLES: Record<string, BadgeStyle> = {
  '無添加麦みそ': {
    background: '#E1F5EE',
    color:      '#0F6E56',
    border:     '0.5px solid #5DCAA5',
  },
  '田舎みそ': {
    background: '#FAEEDA',
    color:      '#854F0B',
    border:     '0.5px solid #EF9F27',
  },
  '山吹みそ': {
    background: '#EEEDFE',
    color:      '#3C3489',
    border:     '0.5px solid #AFA9EC',
  },
  '白みそ': {
    background: '#E6F1FB',
    color:      '#185FA5',
    border:     '0.5px solid #85B7EB',
  },
}

const DEFAULT: BadgeStyle = {
  background: 'var(--muted)',
  color:      'var(--muted-foreground)',
  border:     '0.5px solid var(--border)',
}

export function getMisoTypeBadgeStyle(misoType: string): CSSProperties {
  const s = STYLES[misoType] ?? DEFAULT
  return { background: s.background, color: s.color, border: s.border }
}
