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
    rolldownOptions: {
      output: {
        // Keep third-party code in stable, separately cached chunks instead of
        // one shared chunk that every page load has to fetch again after any
        // app change. Pages themselves are split per route (lib/lazy-page).
        //
        // Vite 8 bundles with rolldown; its `manualChunks` compatibility shim
        // pulls a matched package's dependencies into the same group, which
        // dragged clsx (a recharts dependency the entry also uses) into the
        // chart chunk and made every login preload 300 KB of charts. The
        // native groups below match each package on its own, so charts and
        // the map stay out of the login path and load with the insights pages.
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            { name: 'vendor-react', priority: 50, test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
            { name: 'vendor-ui', priority: 40, test: /[\\/]node_modules[\\/](@radix-ui|lucide-react|sonner|react-day-picker|date-fns|class-variance-authority|clsx|tailwind-merge)[\\/]/ },
            { name: 'vendor-geo', priority: 30, test: /[\\/]node_modules[\\/](d3-geo|china-geojson)[\\/]/ },
            { name: 'vendor-charts', priority: 20, test: /[\\/]node_modules[\\/](recharts|victory-vendor|internmap|delaunator|robust-predicates|d3-(?!geo))/ },
            { name: 'vendor', priority: 10, test: /[\\/]node_modules[\\/]/ },
          ],
        },
      },
    },
  },
})
