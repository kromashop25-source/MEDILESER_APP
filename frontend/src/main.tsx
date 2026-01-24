import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AppRouter from "./app/router";
import { ToastProvider } from "./components/Toast";
import { initTheme } from "./utils/theme";
import "bootstrap/dist/css/bootstrap.min.css";
import "./styles/adminator.css";
import "./styles/theme.css";
import "./index.css";

const qc = new QueryClient();
initTheme();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ToastProvider>
        <AppRouter />
      </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
