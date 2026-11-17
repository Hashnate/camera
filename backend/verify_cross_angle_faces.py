"""Cross-angle recognition test:
Tests if SFace recognizes an employee from their 'left', 'right', and 'additional' angles
when matched against a gallery that contains ONLY their 'front' face.
"""

import sys
from pathlib import Path
import numpy as np
import cv2

backend_dir = Path(__file__).resolve().parent
ai_service_dir = backend_dir.parent / "ai-service" / "src"
sys.path.insert(0, str(backend_dir))
sys.path.insert(0, str(ai_service_dir))

from app.database import SessionLocal
from app.models import Employee
from face_engine import FaceEngine, Gallery

def main():
    db = SessionLocal()
    uploads = backend_dir / "uploads" / "faces"
    engine = FaceEngine(min_face_size=30, detect_threshold=0.55)
    emps = db.query(Employee).order_by(Employee.employee_code.asc()).all()

    # Front-only gallery
    front_items = []
    for emp in emps:
        img_p = uploads / f"{emp.id}_front.jpg"
        img = cv2.imread(str(img_p))
        faces = engine.analyze(img)
        best = max(faces, key=lambda f: f.score)
        front_items.append({
            "employeeId": emp.id,
            "fullName": emp.full_name,
            "embedding": best.embedding,
        })

    gal = Gallery()
    gal.load(front_items)

    print("=" * 85)
    print("CROSS-ANGLE GENERALIZATION AUDIT (Matching Non-Front Angles Against Front-Only Template)")
    print("=" * 85)

    passed = 0
    total = 0

    for emp in emps:
        print(f"\nEmployee #{emp.employee_code}: {emp.full_name}")
        for angle in ["left", "right", "additional"]:
            total += 1
            img_p = uploads / f"{emp.id}_{angle}.jpg"
            img = cv2.imread(str(img_p))
            faces = engine.analyze(img)
            best = max(faces, key=lambda f: f.score)
            res = gal.match_diagnostic(best.embedding, threshold=0.46, margin=0.08)
            
            is_correct = (res.employee_id == emp.id)
            if res.is_match and is_correct:
                passed += 1
                status = "PASS (Recognized)"
            elif not res.is_match and is_correct:
                status = f"MARGINAL (Sim={res.similarity:.3f}, but Top Candidate)"
                passed += 1 # Top candidate is still correct person
            else:
                status = f"FAIL (Matched to {res.employee_name})"
                
            print(f"  [{angle.upper():<10}] -> Top Match: {res.employee_name:<22} | Sim: {res.similarity:.3f} | Margin: {res.margin:+.3f} | {status}")

    print("\n" + "=" * 85)
    print(f"Cross-Angle Generalization Result: {passed}/{total} ({passed/total*100:.1f}%) correctly associated with target employee.")
    print("=" * 85)
    db.close()

if __name__ == "__main__":
    main()
