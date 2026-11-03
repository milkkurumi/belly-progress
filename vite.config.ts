import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages などサブパス配信でも動くよう相対パスにする
  base: './',
})
