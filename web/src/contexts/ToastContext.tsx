import { createContext, useCallback, useState } from 'react'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  message: string
  type: ToastType
}

interface ToastContextType {
  toasts: Toast[]
  addToast: (message: string, type?: ToastType) => void
  removeToast: (id: string) => void
}

export const ToastContext = createContext<ToastContextType | undefined>(undefined)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`
    setToasts(prev => [...prev, { id, message, type }])

    // Auto-remove after 4 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 4000)
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  )
}

interface ToastContainerProps {
  toasts: Toast[]
  onRemove: (id: string) => void
}

function ToastContainer({ toasts, onRemove }: ToastContainerProps) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.5rem',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        pointerEvents: 'none',
      }}
    >
      {toasts.map(toast => (
        <div
          key={toast.id}
          onClick={() => onRemove(toast.id)}
          style={{
            padding: '0.625rem 1.125rem',
            borderRadius: '0.5rem',
            fontSize: '0.8125rem',
            fontWeight: '500',
            maxWidth: '26.25rem',
            boxShadow: '0 0.25rem 1.25rem rgba(0,0,0,.3)',
            animation: 'fadeIn 0.3s ease-in',
            pointerEvents: 'auto',
            cursor: 'pointer',
            backgroundColor:
              toast.type === 'success'
                ? '#16a34a'
                : toast.type === 'error'
                  ? '#dc2626'
                  : '#1e293b',
            color: '#fff',
          }}
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
