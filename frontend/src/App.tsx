import { createBrowserRouter, RouterProvider, Navigate, Outlet, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getToken } from "./auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import OrdersV2 from "./pages/OrdersV2";
import Finance from "./pages/Finance";
import Debtors from "./pages/Debtors";
import Catalog from "./pages/Catalog";
import Taxes from "./pages/Taxes";
import EstimateEditor from "./pages/EstimateEditor";
import OrderDetail from "./pages/OrderDetail";
import Funds from "./pages/Funds";
import ZenMoney from "./pages/ZenMoney";
import Admin from "./pages/Admin";
import ExpensesInbox from "./pages/ExpensesInbox";
import Wiki from "./pages/Wiki";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});

function AuthLayout() {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <Layout><Outlet /></Layout>;
}

// Редирект старой закладки /customers/:id → /wiki/clients/:id (и т.п.)
function RedirectWithId({ to }: { to: string }) {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/wiki/${to}/${id}`} replace />;
}

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    element: <AuthLayout />,
    children: [
      { path: "/", element: <Dashboard /> },
      { path: "/orders", element: <OrdersV2 /> },
      { path: "/orders/:id", element: <OrderDetail /> },
      { path: "/orders/:orderId/estimate", element: <EstimateEditor /> },
      { path: "/finance", element: <Finance /> },
      { path: "/debtors", element: <Debtors /> },
      { path: "/wiki", element: <Navigate to="/wiki/clients" replace /> },
      { path: "/wiki/:category", element: <Wiki /> },
      { path: "/wiki/:category/:id", element: <Wiki /> },
      { path: "/catalog", element: <Catalog /> },
      { path: "/taxes", element: <Taxes /> },
      { path: "/funds", element: <Funds /> },
      { path: "/zenmoney", element: <ZenMoney /> },
      { path: "/expenses", element: <ExpensesInbox /> },
      { path: "/admin", element: <Admin /> },
      // редиректы старых закладок
      { path: "/customers", element: <Navigate to="/wiki/clients" replace /> },
      { path: "/customers/:id", element: <RedirectWithId to="clients" /> },
      { path: "/contractors", element: <Navigate to="/wiki/contractors" replace /> },
      { path: "/contractors/:id", element: <RedirectWithId to="contractors" /> },
      { path: "/brands", element: <Navigate to="/wiki/brands" replace /> },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
