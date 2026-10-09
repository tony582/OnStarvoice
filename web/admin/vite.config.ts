import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/admin/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/images': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Keep third-party code in stable, separately cached chunks instead of
        // one ~1.8 MB shared chunk that every page load has to fetch again
        // after any app change. Charts and the map are only needed by the
        // insights pages, so they stay out of the critical path.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](recharts|victory-vendor|d3-(?!geo)|internmap|delaunator|robust-predicates)/.test(id)) {
            return 'vendor-charts'
          }
          if (/[\\/]node_modules[\\/](d3-geo|china-geojson)[\\/]/.test(id)) return 'vendor-geo'
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react'
          }
          if (/[\\/]node_modules[\\/](@radix-ui|lucide-react|sonner|react-day-picker|date-fns|class-variance-authority|clsx|tailwind-merge)[\\/]/.test(id)) {
            return 'vendor-ui'
          }
          return 'vendor'
        },
      },
    },
  },
})
