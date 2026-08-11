import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { LoaderCircle, LogIn } from 'lucide-react'
import { supabase } from './supabase'

type AuthContextValue = {
  session: Session
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth deve essere usato dentro AuthGate.')
  }
  return value
}

export async function getValidSession(forceRefresh = false) {
  if (!supabase) throw new Error('Supabase non configurato.')
  const current = await supabase.auth.getSession()
  let active = current.data.session
  const expiresSoon =
    !active?.expires_at || active.expires_at * 1000 <= Date.now() + 90_000
  if (forceRefresh || expiresSoon) {
    const refreshed = await supabase.auth.refreshSession()
    if (refreshed.error || !refreshed.data.session) {
      throw new Error('Sessione scaduta. Accedi nuovamente.')
    }
    active = refreshed.data.session
  }
  if (!active) throw new Error('Sessione scaduta. Accedi nuovamente.')
  return active
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  const execute = async (forceRefresh: boolean) => {
    const active = await getValidSession(forceRefresh)
    return fetch(input, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
        Authorization: `Bearer ${active.access_token}`,
      },
    })
  }
  const response = await execute(false)
  return response.status === 401 ? execute(true) : response
}

function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function authenticate(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setMessage('')
    const result =
      authMode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })
    setBusy(false)
    if (result.error) {
      setMessage(result.error.message)
      return
    }
    if (authMode === 'signup' && !result.data.session) {
      setMessage('Account creato. Controlla la mail di conferma, poi accedi.')
    }
  }

  return (
    <main className="app-shell app-login-shell">
      <section className="app-auth">
        <LogIn size={30} />
        <h1>Aestima Parts Finder</h1>
        <p>Accedi per usare chat, catalogo, esplosi e gestione.</p>
        <form onSubmit={authenticate}>
          <input
            name="email"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
          <input
            name="password"
            type="password"
            placeholder="Password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
          />
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? <LoaderCircle className="spin" size={18} /> : 'Continua'}
          </button>
        </form>
        <button
          className="link-button"
          type="button"
          onClick={() =>
            setAuthMode((current) => (current === 'login' ? 'signup' : 'login'))
          }
        >
          {authMode === 'login' ? 'Crea un account' : 'Ho già un account'}
        </button>
        {message && <p className="form-message">{message}</p>}
      </section>
    </main>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) return
    await supabase.auth.signOut()
  }, [])

  const value = useMemo(
    () => (session ? { session, signOut } : null),
    [session, signOut],
  )

  if (loading) {
    return (
      <main className="app-shell app-login-shell">
        <div className="app-auth">
          <LoaderCircle className="spin" size={28} />
          <p>Verifica accesso…</p>
        </div>
      </main>
    )
  }

  if (!supabase) {
    return (
      <main className="app-shell app-login-shell">
        <section className="app-auth">
          <h1>Configurazione mancante</h1>
          <p>Imposta VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY.</p>
        </section>
      </main>
    )
  }

  if (!session || !value) return <LoginScreen />

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
