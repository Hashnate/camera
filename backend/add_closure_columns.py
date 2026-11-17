"""Run migration for DailyTrackingSession closure columns."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.database import engine
from sqlalchemy import text

def run():
    with engine.connect() as conn:
        conn.execute(text("""
            ALTER TABLE "DailyTrackingSession"
              ADD COLUMN IF NOT EXISTS "closedByUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
              ADD COLUMN IF NOT EXISTS "closureReason" TEXT;
        """))
        conn.commit()
    print("Migration for closedByUserId and closureReason OK")

if __name__ == "__main__":
    run()
