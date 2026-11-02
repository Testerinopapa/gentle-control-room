# Emergency Staff Alert

Frontend:
- `npm run dev` starts the Vite dashboard on port `8080`.

Backend:
- Copy `.env.example` to `.env`.
- `npm run db:generate`
- `npm run db:init`
- `npm run db:seed`
- `npm run server:dev`

Production build:
- `npm run build:full`

Backend API domains:
- Admin authentication and session refresh.
- Desktop user CRUD with password hashing.
- Alert creation, retrieval, delivery acknowledgement, and read acknowledgement.

Windows desktop packaging:
- Desktop host project: `desktop/GentleControlRoom.Desktop`
- Installer script: `installer/GentleControlRoom.iss`
- Build/package guide: `docs/windows-desktop-installer.md`

Coding-work analysis (native Windows):
- Task reconstruction, explicit DeepSeek payload approval, local persistence and verification walkthrough: [Phase 2 guide](docs/deepseek-coding-work.md).
- This feature is separate from the legacy alert web dashboard and metadata statistics.

### Approved code-change tracking

See [code-change tracking](docs/code-change-tracking.md) for repository consent, the local diff viewer, optional user-invoked result recording, and explicitly approved DeepSeek payloads. Tracking is off by default.
