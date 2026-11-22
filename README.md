# ClipForge – free in-browser video clipper
Upload a video → loudness analysis picks the best moments → watch them as tiles → download each (or all). No server, no cost; files never leave your device.

## Deploy on GitHub Pages
1. Create a **public** repo and push this folder to the `main` branch.
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. Each push builds and publishes to `https://<user>.github.io/<repo>/`.

## Run locally
`npm install && npm run dev`

## Notes
- Uses single-thread FFmpeg.wasm (works on GitHub Pages without special headers). The engine (~30 MB) downloads once from a CDN and is cached.
- Long videos: audio is read in place, never fully loaded. Expect several minutes for a 1-hour file; use a desktop browser.
- Gemini option: paste a free key from Google AI Studio. The model list is editable because Google changes free-tier models. Only clip times/scores are sent.
- Re-encoded exports are slower but frame-accurate; "Fast cut" is instant but snaps to keyframes.
