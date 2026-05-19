from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from auth import get_current_user, init_admin
from db import ensure_customer_schema
from routers import orders, finance, catalog, taxes, users
from routers import customers

app = FastAPI(title="Firma API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Публичный — только логин
app.include_router(users.router, prefix="/api/auth", tags=["auth"])

# Защищённые — требуют токен
protected = {"dependencies": [Depends(get_current_user)]}
app.include_router(orders.router, prefix="/api/orders", tags=["orders"], **protected)
app.include_router(finance.router, prefix="/api/finance", tags=["finance"], **protected)
app.include_router(catalog.router, prefix="/api/catalog", tags=["catalog"], **protected)
app.include_router(taxes.router, prefix="/api/taxes", tags=["taxes"], **protected)
app.include_router(customers.router, prefix="/api/customers", tags=["customers"], **protected)

@app.get("/api/health")
def health():
    return {"status": "ok", "version": "1.0"}

# React static files
static_dir = Path(__file__).parent.parent / "frontend" / "dist"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")

@app.on_event("startup")
def startup():
    init_admin()
    ensure_customer_schema()
