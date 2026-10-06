import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Relative base so the build works from any subpath (GitHub Pages, Netlify, etc.)
// allowedHosts lets a Cloudflare quick tunnel (https://*.trycloudflare.com) reach the local server.
// Two pages: BLOCKSHOT at / and HOMOKFUTAM at /homokfutam/
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1000, // three.js alone is ~600 kB
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        homokfutam: fileURLToPath(new URL('./homokfutam/index.html', import.meta.url)),
      },
    },
  },
  server: { allowedHosts: ['.trycloudflare.com'] },
  preview: { allowedHosts: ['.trycloudflare.com'] },
})
