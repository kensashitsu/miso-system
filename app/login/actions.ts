'use server'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { USERNAME_EMAIL_MAP } from '@/lib/username-map'

export async function loginAction(
  username: string,
  password: string
): Promise<{ error?: string }> {
  const email = USERNAME_EMAIL_MAP[username.toLowerCase().trim()]
  if (!email) {
    return { error: 'アカウント名またはパスワードが正しくありません' }
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    return { error: 'アカウント名またはパスワードが正しくありません' }
  }

  return {}
}
