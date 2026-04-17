import path from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Load root .env so SESSION_TOKEN is picked up during local dev
const rootEnvPath = path.resolve(__dirname, '../../.env')
if (existsSync(rootEnvPath)) {
  for (const line of readFileSync(rootEnvPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [key, ...valueParts] = trimmed.split('=')
    const value = valueParts.join('=')
    if (key && !(key in process.env)) process.env[key] = value
  }
}

const sessionToken = process.env.SESSION_TOKEN ?? 'b05b4996d27144788a085477e5db30fbe2e057c7029ab2617647704bf3a07c75'
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:4010'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@prepshipv2/contracts': path.resolve(__dirname, '../../packages/contracts/src'),
    },
  },
  server: {
    port: 4014,
    host: '0.0.0.0',
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '192.168.1.203',
      '100.103.254.11',
      'prepshipv3.drprepperusa.com',
    ],
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        headers: {
          'X-App-Token': sessionToken,
        },
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  define: {
    'import.meta.env.VITE_SESSION_TOKEN': JSON.stringify(sessionToken),
    'import.meta.env.VITE_API_PROXY_TARGET': JSON.stringify(apiProxyTarget),
  },
})
