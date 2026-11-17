# WorkSight v2.0 Test Execution Report

**Execution Date**: 2026-11-16  
**Test Suite**: `backend/tests/test_worksight_v2.py`  
**Test Framework**: Pytest 7.4.4 (Python 3.11)  
**Database**: PostgreSQL 18 (`worksight`)  
**Hardware Verified**: EZVIZ CS-H7c Dual-Lens (S/N: `BC7652775`)  

---

## 1. Automated Test Summary

| Test Case Name | Component | Status | Execution Time |
| :--- | :--- | :--- | :--- |
| `test_aes_gcm_embedding_encryption_and_decryption` | Biometric Security | **PASSED** | 0.04s |
| `test_aes_gcm_tamper_detection` | Biometric Security | **PASSED** | 0.02s |
| `test_successful_check_in_and_checkout` | System B Attendance | **PASSED** | 0.28s |
| `test_duplicate_check_in_rejection` | System B Attendance | **PASSED** | 0.14s |
| `test_checkout_without_open_session_rejection`| System B Attendance | **PASSED** | 0.08s |
| `test_idempotent_retry` | System B Attendance | **PASSED** | 0.16s |
| `test_multiple_sessions_per_day` | System B Attendance | **PASSED** | 0.31s |
| `test_camera_observation_ingestion` | System A Presence | **PASSED** | 0.12s |
| `test_unknown_person_observation_isolation` | System A Presence | **PASSED** | 0.09s |
| `test_presence_does_not_create_official_attendance` | Business Rule | **PASSED** | 0.18s |

**Total Result**: **10 PASSED / 0 FAILED (100% Pass Rate)**

---

## 2. Live Hardware & Stream Verification

| Target | Channel No | Stream Protocol | Verified Behavior |
| :--- | :--- | :--- | :--- |
| **EZVIZ CS-H7c Channel 1** | Fixed Wide Lens | HLS (m3u8) | Live streaming 200 OK, ~2 fps frame ingestion, background worker active |
| **EZVIZ CS-H7c Channel 2** | Pan-Tilt Lens | HLS (m3u8) | Live streaming 200 OK, recognized employee `Vaithulla Mohamed Muhni` (0.487 similarity), unknown face rejection verified |

---

## 3. Frontend Production Build Verification
- Next.js 14 App Router compiled successfully (`npm run build`).
- TypeScript type checks: 0 errors.
- Static page generation: 11 / 11 routes generated.
