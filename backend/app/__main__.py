"""`python -m app` starts the API server on $PORT (auto-reload outside production)."""

import uvicorn

from app.config import settings

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.PORT,
        reload=not settings.is_production,
    )
