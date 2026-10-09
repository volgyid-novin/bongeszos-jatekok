import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Relative base so the build works from any subpath (GitHub Pages, Netlify, etc.)
// allowedHosts lets a Cloudflare quick tunnel (https://*.trycloudflare.com) reach the local server.
// Four pages: BLOCKSHOT at /, HOMOKFUTAM at /homokfutam/, HADÚR at /hadur/ and FÉNYKARD at /fenykard/
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1000, // three.js alone is ~600 kB
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        homokfutam: fileURLToPath(new URL('./homokfutam/index.html', import.meta.url)),
        hadur: fileURLToPath(new URL('./hadur/index.html', import.meta.url)),
        fenykard: fileURLToPath(new URL('./fenykard/index.html', import.meta.url)),
      },
    },
  },
  server: { allowedHosts: ['.trycloudflare.com'] },
  preview: { allowedHosts: ['.trycloudflare.com'] },
})
