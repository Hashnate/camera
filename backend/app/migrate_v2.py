"""Migration script for WorkSight v2.0 schema."""

from sqlalchemy import text
from app.database import Base, engine
import app.models  # Ensure all models are registered with Base.metadata

def run_migration():
    print("Creating v2.0 tables...")
    Base.metadata.create_all(engine)
    
    print("Creating partial unique index for WorkSession...")
    with engine.begin() as conn:
        conn.execute(
            text(
                'CREATE UNIQUE INDEX IF NOT EXISTS "uq_open_work_session_per_employee" '
                'ON "WorkSession" ("employeeId") WHERE status = \'OPEN\';'
            )
        )
        conn.execute(
            text(
                'CREATE INDEX IF NOT EXISTS "ix_recognition_observation_dedup" '
                'ON "RecognitionObservation" ("deduplicationKey", "observedAt");'
            )
        )
    print("Migration completed successfully!")

if __name__ == "__main__":
    run_migration()
