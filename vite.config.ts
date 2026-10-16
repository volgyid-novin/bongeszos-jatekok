import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Relative base so the build works from any subpath (GitHub Pages, Netlify, etc.)
// allowedHosts lets a Cloudflare quick tunnel (https://*.trycloudflare.com) reach the local server.
// Six pages: BLOCKSHOT at /, HOMOKFUTAM at /homokfutam/, HADÚR at /hadur/, FÉNYKARD at /fenykard/, HÁGÓ at /hago/ and PAJZSUGRÁS at /pajzsugras/
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
        hago: fileURLToPath(new URL('./hago/index.html', import.meta.url)),
        pajzsugras: fileURLToPath(new URL('./pajzsugras/index.html', import.meta.url)),
      },
    },
  },
  server: { allowedHosts: ['.trycloudflare.com'] },
  preview: { allowedHosts: ['.trycloudflare.com'] },
})
