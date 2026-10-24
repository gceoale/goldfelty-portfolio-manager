import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { AppProvider } from './state/app.tsx'
import './styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
)
