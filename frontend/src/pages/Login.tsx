import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../auth";

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Ошибка входа");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      background: "#E8E4DA",
      height: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}>
      <div style={{ width: 360 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.04em", color: "#1A1A1A" }}>
            firma
          </div>
          <div style={{ fontSize: 12, color: "#A89070", marginTop: 6, letterSpacing: "0.02em" }}>
            ИП Некрасов · Управление бизнесом
          </div>
        </div>

        {/* Card */}
        <div style={{
          background: "#FFFFFF",
          boxShadow: "0 2px 24px rgba(0,0,0,0.06)",
          padding: "36px 32px",
        }}>
          <form onSubmit={handleSubmit}>
            {/* Email */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8, textTransform: "uppercase" }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  border: "1px solid #EDEBE6",
                  background: "#FAF8F5",
                  fontSize: 13,
                  color: "#1A1A1A",
                  outline: "none",
                  fontFamily: "inherit",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "#E8592A"; e.currentTarget.style.background = "#FFFFFF"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "#EDEBE6"; e.currentTarget.style.background = "#FAF8F5"; }}
              />
            </div>

            {/* Password */}
            <div style={{ marginBottom: 24 }}>
              <label style={{ display: "block", fontSize: 11, color: "#A89070", letterSpacing: "0.06em", marginBottom: 8, textTransform: "uppercase" }}>
                Пароль
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  border: "1px solid #EDEBE6",
                  background: "#FAF8F5",
                  fontSize: 13,
                  color: "#1A1A1A",
                  outline: "none",
                  fontFamily: "inherit",
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "#E8592A"; e.currentTarget.style.background = "#FFFFFF"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "#EDEBE6"; e.currentTarget.style.background = "#FAF8F5"; }}
              />
            </div>

            {/* Error */}
            {error && (
              <div style={{
                fontSize: 12,
                color: "#8B3A3A",
                background: "#FFF0F0",
                border: "1px solid #F0DADA",
                padding: "8px 12px",
                marginBottom: 16,
              }}>
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%",
                padding: "11px",
                background: loading ? "#C8C0B0" : "#E8592A",
                border: "none",
                color: "#FFFFFF",
                fontSize: 13,
                fontWeight: 600,
                cursor: loading ? "default" : "pointer",
                letterSpacing: "0.02em",
                transition: "background 0.15s",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = "#D44E24"; }}
              onMouseLeave={(e) => { if (!loading) e.currentTarget.style.background = "#E8592A"; }}
            >
              {loading ? "Входим..." : "Войти"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
