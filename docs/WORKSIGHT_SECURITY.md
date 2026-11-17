# WorkSight v2.0 Security & Biometric Privacy Policy

## 1. Biometric Data Protection
1. **Raw Photo Policy**: Raw enrollment images and webcam captures are **never stored permanently** on disk or in the database. They are decoded in RAM, converted to 128-d float embeddings by OpenCV SFace, and deleted from memory immediately.
2. **Encryption at Rest**:
   - Biometric vectors are encrypted using **AES-256-GCM** authenticated encryption.
   - Every template is encrypted with a unique 96-bit (12-byte) initialization vector (IV) and a 128-bit authentication tag.
   - Tampering with ciphertext or authentication tags immediately causes decryption rejection.
3. **No Biometric Vector Exposure in Public APIs**: Public APIs return only sample counts and enrollment status (e.g. `Enrolled (5)`). Float vectors are strictly restricted to protected internal microservice channels.

---

## 2. Workplace Privacy Principles
1. **Camera Observational Boundary**:
   - Cameras observe physical presence in office zones.
   - Camera sightings **do not equate to paid working hours**.
   - Disappearing from camera view does **not** create a checkout event.
2. **Non-Biometric Alternative**:
   - Employees who choose not to enroll their face have access to explicit manual check-in / check-out controls on the dashboard.
   - Unenrolled employees are not penalized in work session or attendance tracking.
3. **Biometric Revocation**:
   - Employees or administrators can revoke enrollment at any time via `DELETE /api/faces/:id`.
   - Revocation purges all encrypted `FaceTemplate` and `FaceEnrollment` entries, immediately unloading them from the live AI engine memory cache.

---

## 3. Network & Authentication Security
- **JWT Authentication**: User sessions use HS256 JWT tokens with role-based access control.
- **Service-to-Service Authentication**: Internal communication between the AI Service and Backend uses constant-time `hmac.compare_digest` verification on `X-Service-Key`.
- **Database Access**: PostgreSQL connection uses SSL and parameterized SQL queries through SQLAlchemy ORM to prevent SQL injection.
