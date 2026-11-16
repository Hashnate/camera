from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.database import get_db
from app.errors import ApiError
from app.models import User
from app.security import AuthUser, create_token, current_user, json_body, verify_password
from app.serialize import ser

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(body: dict = Depends(json_body), db: Session = Depends(get_db)):
    email, password = body.get("email"), body.get("password")
    if not email or not password:
        raise ApiError(400, "Email and password are required")

    user = db.scalar(
        select(User).options(joinedload(User.company)).where(User.email == str(email).lower().strip())
    )
    if not user or not verify_password(str(password), user.password_hash):
        raise ApiError(401, "Invalid credentials")

    token = create_token(user)
    response = JSONResponse(
        {
            "success": True,
            "message": "Login successful",
            "token": token,
            "user": {
                "id": user.id,
                "email": user.email,
                "fullName": user.full_name,
                "role": user.role.value,
                "company": {"id": user.company.id, "name": user.company.name} if user.company else None,
            },
        }
    )
    response.set_cookie(
        "token",
        token,
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        max_age=settings.JWT_EXPIRES_DAYS * 24 * 60 * 60,
    )
    return response


@router.post("/logout")
def logout():
    response = JSONResponse({"success": True, "message": "Logged out successfully"})
    response.delete_cookie("token")
    return response


@router.get("/me")
def get_me(auth: AuthUser = Depends(current_user), db: Session = Depends(get_db)):
    user = db.scalar(select(User).options(joinedload(User.company)).where(User.id == auth.id))
    return {
        "success": True,
        "user": ser(
            user,
            only=("id", "email", "fullName", "role", "companyId", "createdAt"),
            company=ser(user.company, only=("id", "name", "code")),
        ),
    }
