import { Navigate, Outlet } from "react-router-dom";
import { getAuth } from "../../api/auth";

export default function RequireAuth() {
    const auth = getAuth();
    return auth?.token ? <Outlet /> : <Navigate to="/" replace />;
}