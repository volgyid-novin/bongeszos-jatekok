import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { localAssetsPlugin } from './pajzsugras/tools/local-guard.mjs'
import { modelAssetsPlugin } from './pajzsugras/tools/model-assets.mjs'

// Relative base so the build works from any subpath (GitHub Pages, Netlify, etc.)
// allowedHosts lets a Cloudflare quick tunnel (https://*.trycloudflare.com) reach the local server.
// localAssetsPlugin: the dev / preview server (LAN with --host, tunnel via allowedHosts) answers 403 for pajzsugras/local-models/,
// pajzsugras/local-sounds/ and pajzsugras/local-maps/ (the owner's own UT2004 extracts and ported maps) to anybody who is not on this machine, so they cannot be downloaded from it.
// Two pages: BLOCKSHOT at / and PAJZSUGRÁS at /pajzsugras/
export default defineConfig({
  base: './',
  plugins: [localAssetsPlugin(), modelAssetsPlugin()],
  build: {
    chunkSizeWarningLimit: 1000, // three.js alone is ~600 kB
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        pajzsugras: fileURLToPath(new URL('./pajzsugras/index.html', import.meta.url)),
      },
    },
  },
  server: { allowedHosts: ['.trycloudflare.com'] },
  preview: { allowedHosts: ['.trycloudflare.com'] },
})
