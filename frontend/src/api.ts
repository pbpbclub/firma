import axios from "axios";
import { getToken, clearToken } from "./auth";

const api = axios.create({ baseURL: "/api" });

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      clearToken();
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export const ordersApi = {
  list: (params?: Record<string, string | boolean>) =>
    api.get("/orders", { params }).then((r) => r.data),
  get: (id: string) => api.get(`/orders/${id}`).then((r) => r.data),
  planFactSummary: () => api.get("/orders/plan-fact-summary").then((r) => r.data),
  estimate: (id: string) => api.get(`/orders/${id}/estimate`).then((r) => r.data),
  updateStatus: (id: string, status: string) => api.patch(`/orders/${id}/status`, { status }).then((r) => r.data),
  archive: (id: string) => api.patch(`/orders/${id}/archive`).then((r) => r.data),
  unarchive: (id: string) => api.patch(`/orders/${id}/unarchive`).then((r) => r.data),
  create: (data: { title: string; customer_id?: string | null; deadline?: string | null; priority?: string; brand?: string | null }) =>
    api.post("/orders", data).then((r) => r.data),
  update: (id: string, data: Record<string, any>) => api.patch(`/orders/${id}`, data).then((r) => r.data),
  updateBrand: (id: string, brand: string | null) => api.patch(`/orders/${id}/brand`, { brand }).then((r) => r.data),
  delete: (id: string) => api.delete(`/orders/${id}`).then((r) => r.data),
  addPayment: (id: string, data: { amount: number; paid_at: string; note?: string; bank_tx_id?: string }) =>
    api.post(`/orders/${id}/payments`, data).then((r) => r.data),
  deletePayment: (orderId: string, paymentId: string) =>
    api.delete(`/orders/${orderId}/payments/${paymentId}`).then((r) => r.data),
  reserve: (id: string, amount: number) => api.post(`/orders/${id}/reserve`, { amount }).then((r) => r.data),
  releaseReserve: (id: string) => api.post(`/orders/${id}/reserve/release`).then((r) => r.data),
  suggest: (counterparty: string, amount: number) =>
    api.get("/orders/suggest", { params: { counterparty, amount } }).then((r) => r.data),
  paymentsMap: () => api.get("/orders/payments-map").then((r) => r.data),
  obligations: (id: string) => api.get(`/orders/${id}/obligations`).then((r) => r.data),
};

export const customersApi = {
  list: (search?: string) =>
    api.get("/customers", { params: search ? { search } : {} }).then((r) => r.data),
  get: (id: string) => api.get(`/customers/${id}`).then((r) => r.data),
  create: (data: Record<string, any>) => api.post("/customers", data).then((r) => r.data),
  update: (id: string, data: Record<string, any>) => api.put(`/customers/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/customers/${id}`).then((r) => r.data),
  lookupInn: (inn: string) => api.get("/customers/lookup-inn", { params: { inn } }).then((r) => r.data),
};

export const brandsApi = {
  list: () => api.get("/brands").then((r) => r.data),
  create: (data: Record<string, any>) => api.post("/brands", data).then((r) => r.data),
  update: (id: string, data: Record<string, any>) => api.patch(`/brands/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/brands/${id}`).then((r) => r.data),
};

export const suppliersApi = {
  list: () => api.get("/suppliers").then((r) => r.data),
  create: (data: Record<string, any>) => api.post("/suppliers", data).then((r) => r.data),
  update: (id: string, data: Record<string, any>) => api.patch(`/suppliers/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/suppliers/${id}`).then((r) => r.data),
};

export const businessUnitsApi = {
  list: () => api.get("/business-units").then((r) => r.data),
  create: (data: Record<string, any>) => api.post("/business-units", data).then((r) => r.data),
  update: (id: string, data: Record<string, any>) => api.patch(`/business-units/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/business-units/${id}`).then((r) => r.data),
  addAccount: (data: Record<string, any>) => api.post("/business-units/accounts", data).then((r) => r.data),
  updateAccount: (id: string, data: Record<string, any>) => api.patch(`/business-units/accounts/${id}`, data).then((r) => r.data),
  deleteAccount: (id: string) => api.delete(`/business-units/accounts/${id}`).then((r) => r.data),
};

export const financeApi = {
  balance: () => api.get("/finance/balance").then((r) => r.data),
  freeCash: () => api.get("/finance/free-cash").then((r) => r.data),
  balanceAtDate: (date: string) =>
    api.get("/finance/balance-at-date", { params: { date } }).then((r) => r.data),
  byBrand: () => api.get("/finance/by-brand").then((r) => r.data),
  recurring: () => api.get("/finance/recurring").then((r) => r.data),
  transactions: (params?: Record<string, string>) =>
    api.get("/finance/transactions", { params }).then((r) => r.data),
  summary: () => api.get("/finance/summary").then((r) => r.data),
  debtors: () => api.get("/finance/debtors").then((r) => r.data),
  creditors: (status?: string) =>
    api.get("/finance/creditors", { params: status ? { status } : {} }).then((r) => r.data),
  createCreditor: (data: { name: string; total: number; paid?: number; description?: string; order_id?: string; due_date?: string }) =>
    api.post("/finance/creditors", data).then((r) => r.data),
  updateCreditor: (id: string, data: { paid?: number; total?: number; description?: string; status?: string; due_date?: string; finance_tx_id?: string | null; zenmoney_tx_id?: string | null }) =>
    api.patch(`/finance/creditors/${id}`, data).then((r) => r.data),
  deleteCreditor: (id: string) =>
    api.delete(`/finance/creditors/${id}`).then((r) => r.data),
  suggestTx: (name: string, amount: number) =>
    api.get("/finance/transactions/suggest", { params: { name, amount } }).then((r) => r.data),
  suggestInTx: (name: string, amount: number) =>
    api.get("/finance/transactions/suggest", { params: { name, amount, direction: "in" } }).then((r) => r.data),
  suggestCreditors: (counterparty: string, amount: number) =>
    api.get("/finance/creditors/suggest", { params: { counterparty, amount } }).then((r) => r.data),
  fixedObligations: (month?: string) =>
    api.get("/finance/fixed-obligations", { params: month ? { month } : {} }).then((r) => r.data),
  createFixedObligation: (data: { name: string; amount: number; pay_day?: number; note?: string }) =>
    api.post("/finance/fixed-obligations", data).then((r) => r.data),
  updateFixedObligation: (id: string, data: { name?: string; amount?: number; pay_day?: number; note?: string; active?: number }) =>
    api.patch(`/finance/fixed-obligations/${id}`, data).then((r) => r.data),
  deleteFixedObligation: (id: string) =>
    api.delete(`/finance/fixed-obligations/${id}`).then((r) => r.data),
  receivables: () => api.get("/finance/receivables").then((r) => r.data),
  createReceivable: (data: { client: string; inn?: string; invoice_num?: string; invoice_date?: string; amount: number; paid?: number; note?: string }) =>
    api.post("/finance/receivables", data).then((r) => r.data),
  updateReceivable: (id: number, data: { paid?: number; note?: string; finance_tx_id?: string | null }) =>
    api.patch(`/finance/receivables/${id}`, data).then((r) => r.data),
};

export const taxApi = {
  summary: () => api.get("/taxes/summary").then((r) => r.data),
};

export const catalogApi = {
  list: (search?: string) =>
    api.get("/catalog", { params: search ? { search } : {} }).then((r) => r.data),
  materials: (search?: string) =>
    api.get("/catalog/materials", { params: search ? { search } : {} }).then((r) => r.data),
  items: {
    list:   ()                      => api.get("/catalog/items").then((r) => r.data),
    get:    (id: string)            => api.get(`/catalog/items/${id}`).then((r) => r.data),
    create: (data: any)             => api.post("/catalog/items", data).then((r) => r.data),
    update: (id: string, data: any) => api.put(`/catalog/items/${id}`, data).then((r) => r.data),
    delete: (id: string)            => api.delete(`/catalog/items/${id}`).then((r) => r.data),
    costHistory: (id: string)       => api.get(`/catalog/items/${id}/cost-history`).then((r) => r.data),
  },
  deleteByTitles: (titles: string[]) =>
    api.delete("/catalog/by-titles", { data: { titles } }).then((r) => r.data),
};

export const expensesApi = {
  list: (orderId: string) => api.get(`/orders/${orderId}/expenses`).then((r) => r.data),
  create: (orderId: string, data: {
    title: string; amount: number; category: string; supplier?: string | null;
    master_id?: string | null; expense_date?: string | null;
    finance_tx_id?: string | null; zenmoney_tx_id?: string | null; creditor_id?: string | null;
  }) => api.post(`/orders/${orderId}/expenses`, data).then((r) => r.data),
  update: (orderId: string, expenseId: string, data: Record<string, any>) =>
    api.put(`/orders/${orderId}/expenses/${expenseId}`, data).then((r) => r.data),
  delete: (orderId: string, expenseId: string, withGroup = false) =>
    api.delete(`/orders/${orderId}/expenses/${expenseId}`, { params: withGroup ? { with_group: true } : {} }).then((r) => r.data),
};

export const inboxApi = {
  list: (params: Record<string, string | number>) =>
    api.get("/expenses/inbox", { params }).then((r) => r.data),
  fromTx: (data: {
    source: string; tx_id: string; title?: string | null; category: string;
    supplier?: string | null; master_id?: string | null; expense_date?: string | null;
    allocations: {
      order_id: string; amount: number;
      category?: string | null; master_id?: string | null; supplier?: string | null; creditor_id?: string | null;
    }[];
  }) => api.post("/expenses/from-tx", data).then((r) => r.data),
  deleteGroup: (groupId: string) => api.delete(`/expenses/groups/${groupId}`).then((r) => r.data),
  // Скрытие списания из инбокса (внутренний перевод между своими, возврат…)
  dismiss: (txId: string, source: string, reason?: string) =>
    api.post(`/expenses/inbox/${txId}/dismiss`, { source, reason }).then((r) => r.data),
  undismiss: (txId: string, source: string) =>
    api.delete(`/expenses/inbox/${txId}/dismiss`, { params: { source } }).then((r) => r.data),
};

export const materialsApi = {
  search: (q?: string) =>
    api.get("/materials/search", { params: q ? { q } : {} }).then((r) => r.data),
  prices: (code: string) =>
    api.get(`/materials/${encodeURIComponent(code)}/prices`).then((r) => r.data),
};

export const fundsApi = {
  list:         ()                                   => api.get("/funds").then(r => r.data),
  create:       (data: { name: string; description?: string; color?: string }) =>
    api.post("/funds", data).then(r => r.data),
  transactions: (fundId: string)                     => api.get(`/funds/${fundId}/transactions`).then(r => r.data),
  deposit:      (fundId: string, data: { amount: number; note?: string; date?: string }) =>
    api.post(`/funds/${fundId}/deposit`, data).then(r => r.data),
  withdraw:     (fundId: string, data: { amount: number; note?: string; date?: string }) =>
    api.post(`/funds/${fundId}/withdraw`, data).then(r => r.data),
  deleteTx:     (txId: string)                       => api.delete(`/funds/transactions/${txId}`).then(r => r.data),
};

export const estimatesApi = {
  createSet:   (orderId: string, data?: any) => api.post("/estimates/sets", { order_id: orderId, ...data }).then(r => r.data),
  updateSet:   (setId: string, data: any)   => api.put(`/estimates/sets/${setId}`, data).then(r => r.data),
  deleteSet:   (setId: string)              => api.delete(`/estimates/sets/${setId}`).then(r => r.data),
  newVersion:  (setId: string)              => api.post(`/estimates/sets/${setId}/new-version`).then(r => r.data),
  priceCheck:  (setId: string)              => api.get(`/estimates/sets/${setId}/price-check`).then(r => r.data),
  addItem:     (setId: string, data?: any)  => api.post(`/estimates/sets/${setId}/items`, data ?? {}).then(r => r.data),
  updateItem:  (itemId: string, data: any)  => api.put(`/estimates/items/${itemId}`, data).then(r => r.data),
  deleteItem:  (itemId: string)             => api.delete(`/estimates/items/${itemId}`).then(r => r.data),
  addLine:     (itemId: string, data?: any) => api.post(`/estimates/items/${itemId}/lines`, data ?? {}).then(r => r.data),
  updateLine:  (lineId: string, data: any)  => api.put(`/estimates/lines/${lineId}`, data).then(r => r.data),
  deleteLine:  (lineId: string)             => api.delete(`/estimates/lines/${lineId}`).then(r => r.data),
  fromCatalog: (setId: string, catalogItemId: string) =>
    api.post("/estimates/items/from-catalog", { set_id: setId, catalog_item_id: catalogItemId }).then(r => r.data),
  invoice:     (setId: string)              =>
    api.post(`/estimates/sets/${setId}/invoice`, {}, { responseType: "blob" }).then(r => r.data),
  syncToCatalog: (itemId: string)           => api.post(`/estimates/items/${itemId}/to-catalog`).then(r => r.data),
  createObligations: (setId: string)        => api.post(`/estimates/sets/${setId}/create-obligations`).then(r => r.data),
  deleteObligations: (setId: string)        => api.delete(`/estimates/sets/${setId}/obligations`).then(r => r.data),
  approveSet:  (setId: string, force = false) => api.post(`/estimates/sets/${setId}/approve`, { force }).then(r => r.data),
  reviewQueue: ()                           => api.get("/estimates/review-queue").then(r => r.data),
  costCheck:   (setId: string)              => api.get(`/estimates/sets/${setId}/cost-check`).then(r => r.data),
  costFill:    (setId: string, opts?: { expand_items?: boolean; refresh_materials?: boolean; only?: string[] }) =>
    api.post(`/estimates/sets/${setId}/cost-fill`, opts ?? {}).then(r => r.data),
};

// Справочники costing-движка: ставки работ, выученные цены, правила сопоставления.
export const workRatesApi = {
  list:   () => api.get("/work-rates").then(r => r.data),
  create: (data: { work_type_id?: string; work_type_name?: string; master_id?: string | null; scheme: string; rate: number; unit?: string | null; note?: string | null; variable?: boolean }) =>
    api.post("/work-rates", data).then(r => r.data),
  delete: (id: string) => api.delete(`/work-rates/${id}`).then(r => r.data),
  bootstrap: () => api.post("/work-rates/bootstrap").then(r => r.data),
};

export const priceBookApi = {
  list:   (search?: string) => api.get("/price-book", { params: search ? { search } : {} }).then(r => r.data),
  create: (data: { title: string; price: number; unit?: string | null; match_type?: string; note?: string | null }) =>
    api.post("/price-book", data).then(r => r.data),
  delete: (id: number) => api.delete(`/price-book/${id}`).then(r => r.data),
};

export const costingRulesApi = {
  list:   (kind?: string) => api.get("/costing-rules", { params: kind ? { kind } : {} }).then(r => r.data),
  create: (data: { pattern: string; kind: string; target_id: string; match_type?: string }) =>
    api.post("/costing-rules", data).then(r => r.data),
  delete: (id: number) => api.delete(`/costing-rules/${id}`).then(r => r.data),
};

// Разноска входящих платежей банка на заказы (инбокс поступлений).
export const paymentsApi = {
  inbox: (params?: Record<string, string | number | boolean>) =>
    api.get("/payments/inbox", { params }).then((r) => r.data),
  fromTx: (data: { tx_id: string; allocations: { order_id: string; amount: number; note?: string | null }[] }) =>
    api.post("/payments/from-tx", data).then((r) => r.data),
  dismiss: (txId: string, reason?: string) =>
    api.post(`/payments/inbox/${txId}/dismiss`, { reason: reason || null }).then((r) => r.data),
  undismiss: (txId: string) =>
    api.delete(`/payments/inbox/${txId}/dismiss`).then((r) => r.data),
};

export const mastersApi = {
  list: () => api.get("/masters").then((r) => r.data),
  wikiOnly: () => api.get("/masters/wiki-only").then((r) => r.data),
  get: (id: string) => api.get(`/masters/${id}`).then((r) => r.data),
  create: (data: { name: string; role?: string; specialization?: string; work_type_id?: string }) =>
    api.post("/masters", data).then((r) => r.data),
  update: (id: string, data: Record<string, any>) => api.patch(`/masters/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/masters/${id}`).then((r) => r.data),
};

export const workTypesApi = {
  list: () => api.get("/work-types").then((r) => r.data),
  create: (name: string) => api.post("/work-types", { name }).then((r) => r.data),
  masters: (workTypeId: string) => api.get(`/work-types/${workTypeId}/masters`).then((r) => r.data),
  linkMaster: (workTypeId: string, masterId: string) =>
    api.post(`/work-types/${workTypeId}/masters/${masterId}`).then((r) => r.data),
};

export const zenmoneyApi = {
  accounts: () => api.get("/zenmoney/accounts").then((r) => r.data),
  balanceAtDate: (date: string) =>
    api.get("/zenmoney/balance-at-date", { params: { date } }).then((r) => r.data),
  transactions: (params?: Record<string, string | number>) =>
    api.get("/zenmoney/transactions", { params }).then((r) => r.data),
  report: (month?: string) =>
    api.get("/zenmoney/report", { params: month ? { month } : {} }).then((r) => r.data),
  cashflow: (months?: number) =>
    api.get("/zenmoney/cashflow", { params: months ? { months } : {} }).then((r) => r.data),
  business: (months?: number) =>
    api.get("/zenmoney/business", { params: months ? { months } : {} }).then((r) => r.data),
  sync: () => api.post("/zenmoney/sync").then((r) => r.data),
  suggest: (name: string, amount: number) =>
    api.get("/zenmoney/suggest", { params: { name, amount } }).then((r) => r.data),
};

export const payeeRulesApi = {
  list: (params?: { entity_type?: string; entity_id?: string }) =>
    api.get("/payee-rules", { params }).then((r) => r.data),
  create: (data: {
    pattern: string;
    match_type: string;
    display_name?: string;
    entity_type?: string;
    entity_id?: string;
    entity_name?: string;
    category?: string;
  }) => api.post("/payee-rules", data).then((r) => r.data),
  update: (id: number, data: Partial<{
    pattern: string;
    match_type: string;
    display_name: string;
    entity_type: string;
    entity_id: string;
    entity_name: string;
    category: string;
  }>) => api.patch(`/payee-rules/${id}`, data).then((r) => r.data),
  delete: (id: number) => api.delete(`/payee-rules/${id}`).then((r) => r.data),
};

export const adminApi = {
  system: () => api.get("/admin/system").then((r) => r.data),
  imports: () => api.get("/admin/imports").then((r) => r.data),
  deleteImport: (id: number) => api.delete(`/admin/imports/${id}`).then((r) => r.data),
  uploadSber: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api.post("/admin/upload/sber", fd).then((r) => r.data);
  },
};

export const authApi = {
  me: () => api.get("/auth/me").then((r) => r.data),
  users: () => api.get("/auth/users").then((r) => r.data),
  addUser: (data: { email: string; name: string; password: string; role: string }) =>
    api.post("/auth/users", data).then((r) => r.data),
  deleteUser: (id: number) => api.delete(`/auth/users/${id}`).then((r) => r.data),
  changePassword: (data: { current_password: string; new_password: string }) =>
    api.post("/auth/change-password", data).then((r) => r.data),
};
