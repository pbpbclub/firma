from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from auth import get_current_user, init_admin
from db import ensure_customer_schema, ensure_payee_rules_schema, ensure_orders_schema, ensure_catalog_schema, ensure_estimate_items_schema, ensure_catalog_material_fk, ensure_estimate_bank_pct_schema, ensure_order_discount_schema, ensure_payment_zenmoney_schema, ensure_payment_channel_schema, ensure_estimate_primary_schema, ensure_creditor_estimate_item_schema, ensure_creditor_tx_link_schema, ensure_order_tx_link_schema, ensure_receivable_tx_link_schema, ensure_payee_rules_category_schema, ensure_estimate_lines_contractor_schema, ensure_creditors_plan_schema, ensure_work_types_schema, ensure_brands_schema, normalize_catalog_brands, ensure_business_units_schema, ensure_fixed_obligations_schema, ensure_estimate_lines_price_schema, ensure_expenses_schema, ensure_general_expenses_schema, ensure_cash_schema, ensure_order_reserve_schema, ensure_suppliers_schema, ensure_inbox_dismissed_schema, ensure_work_rates_schema, ensure_work_rate_tiers_schema, ensure_price_book_schema, ensure_costing_rules_schema, ensure_catalog_lines_costing_schema, ensure_order_extras_schema, ensure_unique_business_keys, ensure_updated_at_schema, ensure_line_rate_snapshot_schema, ensure_audit_log_schema, ensure_match_trace_schema, ensure_expense_settlement_schema, ensure_supersede_trace_schema, ensure_rate_history_schema, ensure_costing_version_schema, ensure_order_brand_id_schema, ensure_creditors_constraints_schema, ensure_expense_category_check_schema, ensure_order_status_check_schema, ensure_master_ledger_schema, ensure_creditors_close_schema, ensure_paid_obligations_closed, ensure_media_schema
from routers import orders, finance, catalog, taxes, users, estimates, funds
from routers import customers, masters, zenmoney, admin, payee_rules, yos, work_types, brands, business_units, materials, expenses, general_expenses, suppliers, payments, rates, costing, accountable, ledger, media

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
app.include_router(work_types.router, prefix="/api/work-types", tags=["work-types"], **protected)
app.include_router(brands.router, prefix="/api/brands", tags=["brands"], **protected)
app.include_router(business_units.router, prefix="/api/business-units", tags=["business-units"], **protected)
app.include_router(suppliers.router, prefix="/api/suppliers", tags=["suppliers"], **protected)
app.include_router(materials.router, prefix="/api/materials", tags=["materials"], **protected)
app.include_router(expenses.router, prefix="/api/expenses", tags=["expenses"], **protected)
app.include_router(general_expenses.router, prefix="/api/general-expenses", tags=["general-expenses"], **protected)
app.include_router(payments.router, prefix="/api/payments", tags=["payments"], **protected)
app.include_router(accountable.router, prefix="/api/accountable", tags=["accountable"], **protected)
app.include_router(rates.router, tags=["rates"], **protected)
app.include_router(ledger.router, prefix="/api/ledger", tags=["ledger"], **protected)
app.include_router(costing.router, prefix="/api/estimates", tags=["costing"], **protected)
# Медиатека: раздача файлов идёт по токену из query (<img src>) — свой Depends
# внутри роутера, поэтому глобальный protected здесь не навешиваем.
app.include_router(media.router, prefix="/api/media", tags=["media"])

app.include_router(yos.router, prefix="/api/yos", tags=["yos"])

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
    ensure_order_reserve_schema()
    ensure_catalog_schema()
    ensure_estimate_items_schema()
    ensure_catalog_material_fk()
    ensure_estimate_bank_pct_schema()
    ensure_order_discount_schema()
    ensure_payment_zenmoney_schema()
    ensure_payment_channel_schema()
    ensure_estimate_primary_schema()
    ensure_creditor_estimate_item_schema()
    ensure_creditor_tx_link_schema()
    ensure_order_tx_link_schema()
    ensure_receivable_tx_link_schema()
    ensure_payee_rules_category_schema()
    ensure_estimate_lines_contractor_schema()
    ensure_creditors_plan_schema()
    ensure_work_types_schema()
    ensure_brands_schema()
    normalize_catalog_brands()
    ensure_business_units_schema()
    ensure_suppliers_schema()
    ensure_fixed_obligations_schema()
    ensure_estimate_lines_price_schema()
    ensure_expenses_schema()
    ensure_general_expenses_schema()
    ensure_cash_schema()
    ensure_inbox_dismissed_schema()
    ensure_work_rates_schema()
    ensure_work_rate_tiers_schema()
    ensure_price_book_schema()
    ensure_costing_rules_schema()
    ensure_catalog_lines_costing_schema()
    ensure_order_extras_schema()
    ensure_unique_business_keys()
    ensure_updated_at_schema()
    ensure_line_rate_snapshot_schema()
    ensure_audit_log_schema()
    ensure_match_trace_schema()
    ensure_expense_settlement_schema()
    ensure_supersede_trace_schema()
    ensure_rate_history_schema()
    ensure_costing_version_schema()
    ensure_order_brand_id_schema()
    # Пересоздания с FK+CHECK — в самом конце: колонки-цели уже доехали (волна 3).
    # Порядок: сначала orders (родитель), затем creditors (ссылается на orders),
    # затем expenses (ссылается на creditors).
    ensure_order_status_check_schema()
    ensure_creditors_constraints_schema()
    ensure_expense_category_check_schema()
    ensure_master_ledger_schema()
    # После пересборки creditors: колонки следа закрытия + разовое закрытие
    # полностью оплаченных (висели open с нулевым остатком).
    ensure_creditors_close_schema()
    ensure_media_schema()
    ensure_paid_obligations_closed()
