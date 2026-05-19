import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getToken } from "./auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import OrdersV2 from "./pages/OrdersV2";
import Finance from "./pages/Finance";
import Debtors from "./pages/Debtors";
import Catalog from "./pages/Catalog";
import Customers from "./pages/Customers";
import Taxes from "./pages/Taxes";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <Layout>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/orders" element={<OrdersV2 />} />
                    <Route path="/finance" element={<Finance />} />
                    <Route path="/debtors" element={<Debtors />} />
                    <Route path="/customers" element={<Customers />} />
                    <Route path="/customers/:id" element={<Customers />} />
                    <Route path="/catalog" element={<Catalog />} />
                    <Route path="/taxes" element={<Taxes />} />
                  </Routes>
                </Layout>
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
