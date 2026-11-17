"""Database migration for WorkSight v2.3 Daily Tracking & Automatic Working-Hour Calculation.

Creates:
- DailyTrackingSession
- EmployeeZoneInterval
- EmployeeMovementEvent
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import Base, engine, SessionLocal
import app.models  # Registers all models on Base

def migrate():
    print("Migrating WorkSight v2.3 tables to PostgreSQL...")
    Base.metadata.create_all(bind=engine)
    print("Tables created / verified successfully.")

    # Verify tables exist
    db = SessionLocal()
    try:
        from sqlalchemy import text
        res = db.execute(text("""
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema='public' 
              AND table_name IN ('DailyTrackingSession', 'EmployeeZoneInterval', 'EmployeeMovementEvent')
            ORDER BY table_name;
        """)).fetchall()
        found = [r[0] for r in res]
        print(f"Verified tables present in DB: {found}")
        assert len(found) == 3, f"Expected 3 tables, found {len(found)}"
    finally:
        db.close()

if __name__ == "__main__":
    migrate()
