import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
// base './' makes the build work under https://<user>.github.io/<repo>/ with no repo name needed
export default defineConfig({base:'./',plugins:[react()],optimizeDeps:{exclude:['@ffmpeg/ffmpeg','@ffmpeg/util']}})
