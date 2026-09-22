import axios from "axios";

const BASE = "/api/auth";

export interface User {
  email: string;
  name: string;
  role: "admin" | "viewer";
  // Личный заграничный контур. Вычисляется на сервере (privacy.py) и в auth.db
  // не хранится: роль границей приватности быть не может — admin завёл бы себе
  // нового пользователя с любой ролью. Здесь флаг нужен только чтобы не рисовать
  // лишние пункты меню; защита — на сервере.
  is_owner?: boolean;
}

export function getToken(): string | null {
  return localStorage.getItem("firma_token");
}

export function setToken(token: string) {
  localStorage.setItem("firma_token", token);
}

export function clearToken() {
  localStorage.removeItem("firma_token");
  localStorage.removeItem("firma_user");
}

export function getUser(): User | null {
  try {
    const s = localStorage.getItem("firma_user");
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export async function login(email: string, password: string): Promise<User> {
  const r = await axios.post(`${BASE}/login`, { email, password });
  setToken(r.data.token);
  localStorage.setItem("firma_user", JSON.stringify(r.data.user));
  return r.data.user;
}

export function logout() {
  clearToken();
  window.location.href = "/login";
}
