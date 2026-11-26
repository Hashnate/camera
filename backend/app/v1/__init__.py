"""WorkSight integration API, version 1: for other systems (an ERP, payroll, HR) to read and change WorkSight data.

Mounted at /api/v1 by app.main as its own application, so it has its own docs (/api/v1/docs) and OpenAPI spec
(/api/v1/openapi.json) without the dashboard's internal endpoints. Authenticated with API keys (app.api_keys).
"""

from fastapi import FastAPI

from app.api_keys import SCOPES
from app.errors import register_error_handlers
from app.v1 import attendance, employees, schemas, webhooks

_SCOPE_TABLE = "\n".join(f"| `{s}` | {d} |" for s, d in SCOPES.items())

DESCRIPTION = f"""
Read and change WorkSight data from another system, such as an ERP.

## Signing in
Every call needs an API key. A WorkSight admin creates one in Settings > Integrations (or on the server with
`python -m app.api_keys create "ERPNext"`). Send it as either header:

    Authorization: Bearer ws_live_...
    X-API-Key: ws_live_...

Only call the API over HTTPS. Each key has scopes that limit what it can do:

| Scope | Allows |
|---|---|
{_SCOPE_TABLE}

## Conventions
- **Employees are matched by `employeeCode`.** Use the same code in both systems, e.g. your ERP employee ID.
- **Times** are ISO 8601 in office time with the offset, e.g. `2026-11-26T09:02:00+05:30`. Times you send must
  include an offset.
- **Dates** are office calendar dates, `YYYY-MM-DD`.
- **Lists** are paged. Follow `page.nextCursor` (pass it as `cursor`) until it is `null`. For incremental sync,
  store the last `updatedAt` you received and pass it as `updatedSince`; records can come back more than once, so
  upsert them on their id or code.
- **Errors** return `{{"success": false, "message": "..."}}` with a 4xx status: 400 bad input, 401 missing or
  invalid key, 403 key lacks the scope, 404 not found, 409 conflicts with the current state.
- **Face photos, face data and camera video are never available** through this API.

## Two measures of time
- `/attendance` gives check-in and check-out. For camera attendance, check-out is the last time someone was seen.
- `/timesheets` gives the time someone was actually **inside** the office, from camera sightings, with time away
  excluded. Use it for payroll hours.

## Webhooks: live updates
Instead of polling `/presence/now`, register a webhook (`POST /webhooks`, scope `attendance:read`) and WorkSight
POSTs each event to your https address within about a minute:

| Event | When |
|---|---|
| `employee.arrived` | Seen for the first time today, or checked in by hand |
| `employee.went_away` | Not seen for the webhook's `awayAfterMin` (default 15): stepped out or gone home. `at` = last seen |
| `employee.came_back` | Seen again after being away. `at` = first seen again |

    {{"id": "5b0c...", "event": "employee.arrived", "createdAt": "2026-11-26T09:03:10+05:30",
     "data": {{"employeeCode": "EMP-010", "fullName": "...", "date": "2026-11-26", "at": "2026-11-26T09:02:31+05:30"}}}}

- Answer with any 2xx status within 10 seconds. Anything else is retried after 1, 5, 15, 60 minutes and so on,
  for about a day. Events can arrive more than once or out of order: use `id` to ignore repeats, and `at` for order.
- **Check the signature** before trusting a delivery. The header `X-WorkSight-Signature: t=<unix time>,v1=<hex>`
  holds an HMAC-SHA256 of `<t>.<raw body>` made with the webhook's `secret`:

      import hashlib, hmac, time
      def verify(secret, header, raw_body):
          parts = dict(p.split("=", 1) for p in header.split(","))
          expected = hmac.new(secret.encode(), (parts["t"] + ".").encode() + raw_body, hashlib.sha256).hexdigest()
          return hmac.compare_digest(expected, parts["v1"]) and abs(time.time() - int(parts["t"])) < 300

- `POST /webhooks/{{id}}/test` sends a `webhook.test` event straight away so you can check your receiver.
"""

api = FastAPI(
    title="WorkSight API",
    version="1.0.0",
    description=DESCRIPTION,
    docs_url="/docs",
    redoc_url=None,
    openapi_url="/openapi.json",
    responses={
        400: {"model": schemas.Error, "description": "Bad input"},
        401: {"model": schemas.Error, "description": "Missing, invalid or revoked API key"},
        403: {"model": schemas.Error, "description": "The key lacks the scope this needs"},
        404: {"model": schemas.Error, "description": "Not found"},
    },
)
register_error_handlers(api)
api.include_router(employees.router)
api.include_router(attendance.router)
api.include_router(webhooks.router)
