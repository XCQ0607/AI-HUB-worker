import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import rootPkg from '../package.json'

export default defineConfig({
  base: '/platform/',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(rootPkg.version) },
  build: { outDir: '../worker/public/platform', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
})
