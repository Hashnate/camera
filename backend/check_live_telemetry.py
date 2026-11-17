import urllib.request, json

data = json.dumps({'email': 'admin@worksight.io', 'password': 'Admin@123456'}).encode()
req = urllib.request.Request('http://127.0.0.1:5000/api/auth/login', data=data, headers={'Content-Type': 'application/json'})
res = urllib.request.urlopen(req)
token = json.loads(res.read())['token']

req2 = urllib.request.Request('http://127.0.0.1:5000/api/tracking/active', headers={'Authorization': f'Bearer {token}'})
body = json.loads(urllib.request.urlopen(req2).read())

print("Live Tracking Telemetry:")
print("  Camera Status:", body.get("cameraConnectionStatus"))
print("  Metrics:", body.get("metrics"))
print("  Tracks Count:", len(body.get("data", [])))
for t in body.get("data", []):
    print(f"    Track #{t.get('trackId')}: employee={t.get('employeeName')} ({t.get('employeeCode')}) | status={t.get('identityVerificationStatus')} | zone={t.get('currentZoneId')} | score={t.get('detectionScore')} | box={[round(x, 3) for x in t.get('boundingBox', [])]}")
