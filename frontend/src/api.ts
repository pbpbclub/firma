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
  list: (params?: Record<string, string>) =>
    api.get("/orders", { params }).then((r) => r.data),
  get: (id: string) => api.get(`/orders/${id}`).then((r) => r.data),
  estimate: (id: string) => api.get(`/orders/${id}/estimate`).then((r) => r.data),
};

export const customersApi = {
  list: (search?: string) =>
    api.get("/customers", { params: search ? { search } : {} }).then((r) => r.data),
  get: (id: string) => api.get(`/customers/${id}`).then((r) => r.data),
  create: (data: Record<string, any>) => api.post("/customers", data).then((r) => r.data),
  update: (id: string, data: Record<string, any>) => api.put(`/customers/${id}`, data).then((r) => r.data),
};

export const financeApi = {
  balance: () => api.get("/finance/balance").then((r) => r.data),
  transactions: (params?: Record<string, string>) =>
    api.get("/finance/transactions", { params }).then((r) => r.data),
  summary: () => api.get("/finance/summary").then((r) => r.data),
  debtors: () => api.get("/finance/debtors").then((r) => r.data),
};

export const taxApi = {
  summary: () => api.get("/taxes/summary").then((r) => r.data),
};

export const catalogApi = {
  list: (search?: string) =>
    api.get("/catalog", { params: search ? { search } : {} }).then((r) => r.data),
  materials: (search?: string) =>
    api.get("/catalog/materials", { params: search ? { search } : {} }).then((r) => r.data),
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
