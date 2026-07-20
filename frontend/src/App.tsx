import { createBrowserRouter, RouterProvider, Navigate, Outlet } from "react-router-dom";
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
import EstimateEditor from "./pages/EstimateEditor";
import OrderDetail from "./pages/OrderDetail";
import Funds from "./pages/Funds";
import ZenMoney from "./pages/ZenMoney";
import Admin from "./pages/Admin";
import ExpensesInbox from "./pages/ExpensesInbox";
import Contractors from "./pages/Contractors";
import Brands from "./pages/Brands";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});

function AuthLayout() {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <Layout><Outlet /></Layout>;
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
      { path: "/customers", element: <Customers /> },
      { path: "/customers/:id", element: <Customers /> },
      { path: "/catalog", element: <Catalog /> },
      { path: "/taxes", element: <Taxes /> },
      { path: "/funds", element: <Funds /> },
      { path: "/brands", element: <Brands /> },
      { path: "/zenmoney", element: <ZenMoney /> },
      { path: "/expenses", element: <ExpensesInbox /> },
      { path: "/contractors", element: <Contractors /> },
      { path: "/contractors/:id", element: <Contractors /> },
      { path: "/admin", element: <Admin /> },
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
