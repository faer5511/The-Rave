# THE RAVE

## Local setup

Run `bash start.sh` from a shell with Python 3. The script creates `.env`, prepares
the database, creates the initial administrator, and starts the FastAPI server.
Keep `.env` private; it is excluded by `.gitignore`.

## Code formatting

Install the development tools with `npm install` and `python -m pip install -r requirements-dev.txt`.
Run `npm run format` for HTML, CSS, JavaScript, and Markdown, or
`npm run format:python` for Python. Use `npm run format:check` to verify formatting.

Main page styles are split into `base.css`, `sections.css`, `modals.css`,
`responsive.css`, and `checkout.css`. Keep their loading order in `static/index.html`;
the order preserves the CSS cascade.

The ticket page markup and styles live in `app/templates/ticket.html`;
`app/tickets.py` fills it with escaped ticket and event data.

## Authentication and email

Set these values in `.env`:

- `SECRET_KEY`: persistent random value of at least 32 characters. `start.sh`
  generates one for a new local setup. Do not rotate it casually; doing so signs
  out all existing sessions.
- `PUBLIC_BASE_URL`: use `http://localhost:8000` only for local development.
  Production requires the public HTTPS URL and TLS at the server or trusted
  reverse proxy; the app redirects HTTP requests and sends HSTS when configured
  with HTTPS.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and
  `SMTP_USE_SSL`: required for account verification emails. Port 587 uses
  STARTTLS; port 465 uses SSL.
- `SESSION_HOURS`: session lifetime, from 1 to 24 hours.
- `VERIFICATION_HOURS`: verification link lifetime, from 1 to 168 hours.

Registration is unavailable until SMTP is configured. Account passwords are
stored as bcrypt hashes; verification tokens are stored as SHA-256 hashes.

## Initial administrator

Set `ADMIN_LOGIN` and `ADMIN_PASSWORD` in `.env`, then run:

```text
python -m app.seed
```

The seed command creates the first admin only if that login does not already
exist. It stores a bcrypt hash and marks the admin email as verified. Keep the
bootstrap password in the private `.env`; do not commit it.

Admins can upload an event poster from the Event tab (JPG, PNG, or WebP, up to
8 MB). Uploaded files are served from `static/uploads`; when no poster is set,
the site shows the poster text without an image.

## Database schema updates

At startup, `Base.metadata.create_all` creates missing tables, including the
account, verification-token, login-attempt, and rate-limit tables. This is an
additive schema update and preserves existing SQLite data. Back up `data/rave.db`
before deployment. The project does not currently use versioned Alembic
migrations; use Alembic before introducing schema changes that alter or remove
existing columns.

`PAYMENT_MODE=mock` is restricted to localhost. Set `PAYMENT_MODE=yookassa` and
the corresponding YooKassa credentials for a public deployment.
