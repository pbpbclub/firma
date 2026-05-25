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
  estimate: (id: string) => api.get(`/orders/${id}/estimate`).then((r) => r.data),
  updateStatus: (id: string, status: string) => api.patch(`/orders/${id}/status`, { status }).then((r) => r.data),
  archive: (id: string) => api.patch(`/orders/${id}/archive`).then((r) => r.data),
  unarchive: (id: string) => api.patch(`/orders/${id}/unarchive`).then((r) => r.data),
  create: (data: { title: string; customer_id?: number | null; deadline?: string | null; priority?: string; brand?: string | null }) =>
    api.post("/orders", data).then((r) => r.data),
  updateBrand: (id: string, brand: string | null) => api.patch(`/orders/${id}/brand`, { brand }).then((r) => r.data),
  delete: (id: string) => api.delete(`/orders/${id}`).then((r) => r.data),
};

export const customersApi = {
  list: (search?: string) =>
    api.get("/customers", { params: search ? { search } : {} }).then((r) => r.data),
  get: (id: string) => api.get(`/customers/${id}`).then((r) => r.data),
  create: (data: Record<string, any>) => api.post("/customers", data).then((r) => r.data),
  update: (id: string, data: Record<string, any>) => api.put(`/customers/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/customers/${id}`).then((r) => r.data),
};

export const financeApi = {
  balance: () => api.get("/finance/balance").then((r) => r.data),
  transactions: (params?: Record<string, string>) =>
    api.get("/finance/transactions", { params }).then((r) => r.data),
  summary: () => api.get("/finance/summary").then((r) => r.data),
  debtors: () => api.get("/finance/debtors").then((r) => r.data),
  creditors: (status?: string) =>
    api.get("/finance/creditors", { params: status ? { status } : {} }).then((r) => r.data),
  createCreditor: (data: { name: string; total: number; paid?: number; description?: string; order_id?: string; due_date?: string }) =>
    api.post("/finance/creditors", data).then((r) => r.data),
  updateCreditor: (id: string, data: { paid?: number; total?: number; description?: string; status?: string; due_date?: string }) =>
    api.patch(`/finance/creditors/${id}`, data).then((r) => r.data),
  deleteCreditor: (id: string) =>
    api.delete(`/finance/creditors/${id}`).then((r) => r.data),
  receivables: () => api.get("/finance/receivables").then((r) => r.data),
  updateReceivable: (id: number, data: { paid?: number; note?: string }) =>
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
  },
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
};

export const mastersApi = {
  list: () => api.get("/masters").then((r) => r.data),
  get: (id: string) => api.get(`/masters/${id}`).then((r) => r.data),
  update: (id: string, data: Record<string, any>) => api.patch(`/masters/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/masters/${id}`).then((r) => r.data),
};

export const zenmoneyApi = {
  accounts: () => api.get("/zenmoney/accounts").then((r) => r.data),
  transactions: (params?: Record<string, string | number>) =>
    api.get("/zenmoney/transactions", { params }).then((r) => r.data),
  report: (month?: string) =>
    api.get("/zenmoney/report", { params: month ? { month } : {} }).then((r) => r.data),
  cashflow: (months?: number) =>
    api.get("/zenmoney/cashflow", { params: months ? { months } : {} }).then((r) => r.data),
  business: (months?: number) =>
    api.get("/zenmoney/business", { params: months ? { months } : {} }).then((r) => r.data),
  sync: () => api.post("/zenmoney/sync").then((r) => r.data),
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
  }) => api.post("/payee-rules", data).then((r) => r.data),
  update: (id: number, data: Partial<{
    pattern: string;
    match_type: string;
    display_name: string;
    entity_type: string;
    entity_id: string;
    entity_name: string;
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
