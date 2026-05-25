from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from auth import get_current_user, init_admin
from db import ensure_customer_schema, ensure_payee_rules_schema, ensure_orders_schema, ensure_catalog_schema, ensure_estimate_items_schema, ensure_catalog_material_fk
from routers import orders, finance, catalog, taxes, users, estimates, funds
from routers import customers, masters, zenmoney, admin, payee_rules

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
app.include_router(estimates.router, prefix="/api/estimates", tags=["estimates"], **protected)
app.include_router(funds.router, prefix="/api/funds", tags=["funds"], **protected)
app.include_router(masters.router, prefix="/api/masters", tags=["masters"], **protected)
app.include_router(zenmoney.router, prefix="/api/zenmoney", tags=["zenmoney"], **protected)
app.include_router(admin.router, prefix="/api/admin", tags=["admin"], **protected)
app.include_router(payee_rules.router, prefix="/api/payee-rules", tags=["payee-rules"], **protected)

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
    ensure_payee_rules_schema()
    ensure_orders_schema()
    ensure_catalog_schema()
    ensure_estimate_items_schema()
    ensure_catalog_material_fk()
