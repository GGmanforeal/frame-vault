# Frame Vault

A simple video library for uploading and watching your own videos. It includes search, favorites, custom cover frames, and byte-range streaming for seeking.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. Files and the SQLite database are stored in `./data` by default.

## Railway

Deploy this repository as a Railway service. Add a persistent volume mounted at `/data`, then set `DATA_DIR=/data`. Generate a domain under **Settings → Networking**. For a private library, set `APP_PASSWORD` and a long random `SESSION_SECRET` in the service variables. Both values are required together. Railway's default filesystem is temporary, so the volume is essential for keeping uploads.

Supported video types: MP4, WebM, MOV, M4V, and OGG. The browser can play formats its codecs support; MP4/H.264 is the safest choice. Upload limit: 1 GB per video.
