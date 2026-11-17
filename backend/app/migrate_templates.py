"""Migrate unencrypted FaceEnrollment to encrypted FaceTemplate."""

from app.database import SessionLocal
from app.models import FaceEnrollment, FaceTemplate
from app.crypto import encrypt_embedding

def backfill_face_templates():
    with SessionLocal() as db:
        enrollments = db.query(FaceEnrollment).all()
        migrated = 0
        for fe in enrollments:
            existing = db.query(FaceTemplate).filter(FaceTemplate.id == fe.id).first()
            if not existing:
                ciphertext, iv, tag, key_id = encrypt_embedding(list(fe.embedding))
                ft = FaceTemplate(
                    id=fe.id,
                    employee_id=fe.employee_id,
                    encrypted_embedding=ciphertext,
                    embedding_iv=iv,
                    embedding_tag=tag,
                    encryption_key_id=key_id,
                    algorithm="AES-256-GCM",
                    model_version="SFace-2021dec",
                    quality_score=1.0,
                    sample_count=1,
                    status="ACTIVE",
                    enrollment_authorization_reference="system-migration-consent",
                    enrolled_by_id=fe.consent_recorded_by_id,
                    created_at=fe.created_at,
                )
                db.add(ft)
                migrated += 1
        db.commit()
        print(f"Migrated {migrated} face templates to AES-256-GCM encryption.")

if __name__ == "__main__":
    backfill_face_templates()
