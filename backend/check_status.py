import urllib.request, json

data = json.dumps({'email': 'admin@worksight.io', 'password': 'Admin@123456'}).encode()
req = urllib.request.Request('http://127.0.0.1:5000/api/auth/login', data=data, headers={'Content-Type': 'application/json'})
res = urllib.request.urlopen(req)
token = json.loads(res.read())['token']

req_faces = urllib.request.Request('http://127.0.0.1:5000/api/faces', headers={'Authorization': f'Bearer {token}'})
faces_data = json.loads(urllib.request.urlopen(req_faces).read())
print('Faces summary count:', faces_data['count'])
for f in faces_data['data']:
    print(' ', f)

req_emps = urllib.request.Request('http://127.0.0.1:5000/api/employees', headers={'Authorization': f'Bearer {token}'})
emps_data = json.loads(urllib.request.urlopen(req_emps).read())
print('\nEmployees count:', emps_data['count'])
for e in emps_data['data']:
    print(f"Code: {e.get('employeeCode')} | Name: {e.get('fullName')} | ID: {e.get('id')} | Active: {e.get('isActive')}")
