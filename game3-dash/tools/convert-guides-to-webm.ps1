# Converts guide GIFs to WebM (uses ffmpeg-static from node_modules).
# Install ffmpeg globally instead: see tools/convert-guides-to-webm.mjs header.
Set-Location (Split-Path $PSScriptRoot -Parent)
node tools/convert-guides-to-webm.mjs
