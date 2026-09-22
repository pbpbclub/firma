import axios from "axios";
import { useQuery } from "@tanstack/react-query";

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

// Обновить сохранённого пользователя с сервера.
// Нужно потому, что `is_owner` появился 22.09.2026, а в localStorage у уже
// залогиненных лежит старый объект без него: без этого вызова пункт «Грузия»
// не появился бы до перелогина, а он живёт 30 дней.
export async function refreshUser(): Promise<User | null> {
  try {
    const r = await axios.get(`${BASE}/me`, { headers: { Authorization: `Bearer ${getToken()}` } });
    localStorage.setItem("firma_user", JSON.stringify(r.data));
    return r.data as User;
  } catch {
    return getUser();   // сеть или 401 — молча остаёмся на сохранённом
  }
}

// Единый источник «кто я» для компонентов: React Query кэширует ответ на сессию,
// поэтому /auth/me не дёргается на каждый экран, а is_owner везде один и тот же.
// Локальный объект тоже обновляем — им пользуется сайдбар до первой загрузки.
export function useMe() {
  return useQuery({
    queryKey: ["auth-me"],
    queryFn: async () => {
      const u = await refreshUser();
      return u;
    },
    staleTime: 5 * 60 * 1000,
    // placeholderData, а НЕ initialData: initialData считается свежими данными,
    // и при staleTime запрос не уходит вовсе — сохранённый объект без is_owner
    // так и остался бы единственной правдой (поймано на живом экране 22.09.2026).
    placeholderData: getUser() ?? undefined,
  });
}

export function logout() {
  clearToken();
  window.location.href = "/login";
}
