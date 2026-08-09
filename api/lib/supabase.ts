import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { VercelRequest } from '@vercel/node'

let adminClient: SupabaseClient | undefined

export function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export function getSupabaseAdmin() {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase non configurato: imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.',
    )
  }

  if (!adminClient) {
    adminClient = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    )
  }
  return adminClient
}

function bearerToken(request: VercelRequest) {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return undefined
  return authorization.slice('Bearer '.length).trim()
}

export async function getRequestUser(request: VercelRequest): Promise<User | undefined> {
  const token = bearerToken(request)
  if (!token || !isSupabaseConfigured()) return undefined
  const { data, error } = await getSupabaseAdmin().auth.getUser(token)
  if (error) return undefined
  return data.user
}

export async function requireAdmin(request: VercelRequest) {
  const user = await getRequestUser(request)
  if (!user) {
    return { ok: false as const, status: 401, error: 'Sessione non valida.' }
  }

  const { data, error } = await getSupabaseAdmin()
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (error || data?.role !== 'admin') {
    return {
      ok: false as const,
      status: 403,
      error: 'Accesso riservato agli amministratori.',
    }
  }
  return { ok: true as const, user }
}

