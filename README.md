# File-backed Team Messenger

A Persian RTL team messenger built with Node.js, Express and Socket.IO. It does not use PostgreSQL or another database. Users, groups, messages and sessions are stored in JSON files; uploaded files are stored on disk.

## Important Render note

Render filesystems are ephemeral by default. To preserve JSON data and uploads through restarts and deploys, attach a Persistent Disk. Persistent disks require a paid web service. `render.yaml` mounts one at `/var/data` and sets `DATA_DIR` and `UPLOAD_DIR` accordingly. See https://render.com/docs/disks and https://render.com/docs/free.

## Features

- Admin-managed users, roles, password resets and account deactivation
- Admin-managed groups and memberships
- Real-time group messaging, message editing and soft deletion
- Profile avatars, images/GIFs, selected document/audio/video file types, emoji and stickers
- bcrypt password hashing, file-backed sessions, rate limiting, Origin checks and security headers

## Requirements

- Node.js 22.16+ (Node 24 LTS recommended)
- PostgreSQL is **not required**

## Local setup (VS Code / Windows)

1. Extract the ZIP and open `local-messenger-file-storage` in VS Code.
2. Copy `.env.example` to `.env`.
3. Set `SESSION_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD`. Generate a secret with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. Run:

   ```bash
   npm install
   npm run check
   npm run dev
   ```

5. Open http://localhost:3000.

Data is stored by default in `data/messenger.json`, `data/sessions.json`, and `data/uploads/`.

## Deploy to Render

Push the project to GitHub, then select **New + > Blueprint** in Render and connect the repository. Set `ADMIN_USERNAME` and a strong `ADMIN_PASSWORD` when prompted. The Blueprint generates `SESSION_SECRET`, sets `NODE_ENV=production`, and attaches a paid persistent disk at `/var/data`.

Free Render web services cannot attach persistent disks, so their local files are lost when the service restarts, sleeps, or redeploys. Do not use the free plan if messages and uploads must be kept.

## Limitations

JSON file storage is intended for one Node.js instance and a relatively small team. It is not a substitute for a database for heavy traffic, large histories, or multiple simultaneous instances. Back up `messenger.json` and `uploads/` regularly. The app does not provide end-to-end encryption or guarantee 100% security.
