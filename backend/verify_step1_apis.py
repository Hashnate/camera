"""Verify Step 1 endpoints against running backend."""
import requests
import json

def verify():
    login_res = requests.post(
        "http://localhost:5000/api/auth/login",
        json={"email": "admin@worksight.io", "password": "Admin@123456"}
    )
    token = login_res.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    # 1. Get employees
    emp_res = requests.get("http://localhost:5000/api/employees", headers=headers)
    emps = emp_res.json().get("data", [])
    print(f"Total employees: {len(emps)}")
    test_emp = emps[0]
    emp_id = test_emp["id"]
    emp_name = test_emp["fullName"]
    print(f"Testing with Employee: {emp_name} ({emp_id})")

    # 2. Test /calculation
    calc_res = requests.get(f"http://localhost:5000/api/tracking/daily/{emp_id}/calculation", headers=headers)
    print("GET /calculation status:", calc_res.status_code)
    print("Calculation response:")
    print(json.dumps(calc_res.json(), indent=2))

    # 3. Test /intervals
    inv_res = requests.get(f"http://localhost:5000/api/tracking/daily/{emp_id}/intervals", headers=headers)
    print("GET /intervals status:", inv_res.status_code)
    print(f"Intervals count: {inv_res.json().get('count')}")

    # 4. Test /close
    close_res = requests.post(
        f"http://localhost:5000/api/tracking/daily/{emp_id}/close",
        headers=headers,
        json={"reason": "Step 1 Automated Verification Close", "sessionStatus": "COMPLETED"}
    )
    print("POST /close status:", close_res.status_code)
    print("Close response:", close_res.json().get("message"))

if __name__ == "__main__":
    verify()
