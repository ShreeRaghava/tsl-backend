# TSL Backend

This folder contains a minimal Node.js + Express backend for TSL (review automation).

Quick start (local):

1. Copy `.env.example` to `.env` and update `MONGO_URI` (MongoDB Atlas) and optional WhatsApp values.

2. Install dependencies:

```powershell
cd tsl-backend
npm install
```

3. Run the server in development mode:

```powershell
npm run dev
```

4. Health check: open `http://localhost:4000/api/health`

API endpoints implemented:

- `GET /api/health` — health check
- `POST /api/pilot` — create a pilot lead (from landing page)
- `POST /api/businesses` — create a business
- `POST /api/customers/import` — import customers for a business
- `POST /api/campaigns/:businessId/send-review-requests` — send review requests via WhatsApp template
- `GET /api/businesses/:id/summary` — counts for dashboard

WhatsApp:
- Uses WhatsApp Cloud API (Meta). If `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are not set the server will log a warning and continue.

Deploy:
- Push this repo to GitHub and deploy a Render Web Service (build: `npm install`, start: `npm start`).
- Set environment variables on Render to match your `.env`.

Notes:
- The example code sends template messages via the WhatsApp Cloud API and expects the template `review_request` to exist.
- Keep your `.env` out of source control.
