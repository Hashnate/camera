import urllib.request, json

data = json.dumps({'email': 'admin@worksight.io', 'password': 'Admin@123456'}).encode()
req = urllib.request.Request('http://127.0.0.1:5000/api/auth/login', data=data, headers={'Content-Type': 'application/json'})
res = urllib.request.urlopen(req)
token = json.loads(res.read())['token']

req2 = urllib.request.Request('http://127.0.0.1:5000/api/presence/overview', headers={'Authorization': f'Bearer {token}'})
body = json.loads(urllib.request.urlopen(req2).read())

print("Presence Overview count:", len(body.get("data", [])))
for p in body.get("data", []):
    print(f"  * {p.get('employeeCode')} | {p.get('fullName')} | status={p.get('status')} | zone={p.get('currentZoneId')}")
