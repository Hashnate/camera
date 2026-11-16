import logging
import traceback
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import settings

log = logging.getLogger("worksight")


class ApiError(Exception):
    """Raise to return {"success": false, "message": ..., **extra} with the given status code."""

    def __init__(self, status_code: int, message: str, **extra: Any):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.extra = extra


def _body(message: str, **extra: Any) -> dict:
    return {"success": False, "message": message, **extra}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_req: Request, exc: ApiError):
        return JSONResponse(_body(exc.message, **exc.extra), status_code=exc.status_code)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_req: Request, exc: StarletteHTTPException):
        return JSONResponse(_body(str(exc.detail)), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError):
        return JSONResponse(_body("Invalid request", errors=exc.errors()), status_code=400)

    @app.exception_handler(Exception)
    async def _unhandled(_req: Request, exc: Exception):
        log.exception("[Global Error] %s", exc)
        extra = {} if settings.is_production else {"stack": traceback.format_exc()}
        return JSONResponse(_body(str(exc) or "Internal server error", **extra), status_code=500)
