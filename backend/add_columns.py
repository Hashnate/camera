from app.database import engine
from sqlalchemy import text

with engine.connect() as conn:
    conn.execute(text('ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "phoneNumber" TEXT;'))
    conn.execute(text('ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "employmentType" TEXT;'))
    conn.execute(text('ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "joiningDate" TEXT;'))
    conn.commit()
    print('Columns verified on Employee table!')
