"""Check the App Store Connect API key secrets before spending a macOS build on them.

Signs a token exactly like altool does (ES256, team key: kid + iss) and asks App Store
Connect for the app with this bundle ID. Exits non-zero with a plain explanation if the
key is rejected or can't see the app.

Env: KEY_ID, ISSUER_ID, KEY_P8 (the .p8 text, or base64 of it), BUNDLE_ID.
Needs: pip install "pyjwt[crypto]"
"""

import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import jwt
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
    load_pem_private_key,
)


def fail(message: str) -> None:
    print(f"::error::{message}")
    sys.exit(1)


key_id = os.environ.get("KEY_ID", "").strip()
issuer_id = os.environ.get("ISSUER_ID", "").strip()
key_p8 = os.environ.get("KEY_P8", "").replace("\r", "").strip()
bundle_id = os.environ.get("BUNDLE_ID", "").strip()

if not re.fullmatch(r"[A-Z0-9]{10}", key_id):
    fail(f"APP_STORE_CONNECT_KEY_ID should be 10 capital letters/digits (the part after AuthKey_ in the "
         f".p8 file name); it is {len(key_id)} characters long.")
if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", issuer_id):
    fail("APP_STORE_CONNECT_ISSUER_ID should look like 9bb02849-fe6e-465c-a8b7-fa524f3f9dd3 "
         "(Users and Access > Integrations > App Store Connect API > Team Keys).")
if "BEGIN PRIVATE KEY" not in key_p8:
    try:
        key_p8 = base64.b64decode("".join(key_p8.split())).decode().replace("\r", "").strip()
    except ValueError:
        pass
if "BEGIN PRIVATE KEY" not in key_p8:
    fail("APP_STORE_CONNECT_KEY_P8 should be the whole .p8 file, from -----BEGIN PRIVATE KEY----- "
         "to -----END PRIVATE KEY-----.")

def fingerprint(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


# GitHub masks secret values in logs; these short hashes reveal nothing but can be compared
# with the hashes of the known-good values to see which secret differs.
try:
    public_key = load_pem_private_key(key_p8.encode(), password=None).public_key().public_bytes(
        Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    p8_print = fingerprint(public_key)
except Exception:
    p8_print = "unreadable"
print(f"Fingerprints: key id {fingerprint(key_id.encode())}, issuer {fingerprint(issuer_id.encode())}, "
      f"p8 public key {p8_print}")

now = int(time.time())
try:
    token = jwt.encode(
        {"iss": issuer_id, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"},
        key_p8,
        algorithm="ES256",
        headers={"kid": key_id, "typ": "JWT"},
    )
except Exception as exc:  # malformed key text
    fail(f"APP_STORE_CONNECT_KEY_P8 is not a usable private key ({exc.__class__.__name__}). "
         "Paste the .p8 file again, unchanged.")

query = urllib.parse.urlencode({"filter[bundleId]": bundle_id, "fields[apps]": "name,bundleId"})
request = urllib.request.Request(
    f"https://api.appstoreconnect.apple.com/v1/apps?{query}",
    headers={"Authorization": f"Bearer {token}"},
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        apps = json.load(response).get("data", [])
except urllib.error.HTTPError as exc:
    body = exc.read().decode(errors="replace")
    if exc.code == 401:
        fail(f"Apple rejected the API key (401). Key ID {key_id} must be the ID of the same key whose "
             ".p8 you pasted (the .p8 file is named AuthKey_<Key ID>.p8), it must be a Team key "
             "(not an Individual key), and the Issuer ID must be the one shown above the Team Keys list.")
    if exc.code == 403:
        fail(f"The API key works but isn't allowed to read apps (403). Give it the App Manager or "
             f"Admin role. Apple said: {body[:300]}")
    fail(f"App Store Connect answered {exc.code}: {body[:300]}")
except urllib.error.URLError as exc:
    fail(f"Couldn't reach App Store Connect: {exc.reason}")

match = [a for a in apps if a.get("attributes", {}).get("bundleId") == bundle_id]
if not match:
    fail(f"The API key works, but App Store Connect has no app with bundle ID {bundle_id}. "
         "Create it under Apps > + > New App first.")

app = match[0]
print(f"API key {key_id} OK. App Store Connect app: {app['attributes'].get('name')} "
      f"({bundle_id}, Apple ID {app['id']}).")
