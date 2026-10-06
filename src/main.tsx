import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { CommercialDocument } from './components/CommercialDocument'
import { AuthGate } from './lib/auth'
import './styles.css'

const docId = new URLSearchParams(window.location.search).get('doc')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {docId ? (
      <CommercialDocument docId={docId} />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </StrictMode>,
)
