import {PrintingSettings} from '../features/services/printing-settings';
import { lazy, Suspense, useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { InventoryPage } from "../features/catalog/inventory-page";
import { SalesPage } from "../features/sales/sales-page";
import { HistoryPage } from "../features/sales/history-page";
import {CustomersPage} from '../features/management/customers-page';
import {ExpensesPage} from '../features/management/expenses-page';
const WarrantiesPage=lazy(()=>import('../features/services/warranties-page').then(m=>({default:m.WarrantiesPage})));
const LayawaysPage=lazy(()=>import('../features/services/layaways-page').then(m=>({default:m.LayawaysPage})));
const RepairsPage=lazy(()=>import('../features/services/repairs-page').then(m=>({default:m.RepairsPage})));
import {ReportsPage} from '../features/management/reports-page';
import { SalesProvider, useSales } from "../features/sales/workspace";
import logo from "../../../../public/icon-192x192.png";
import { nativePreviewPort,nativeOperationalPort } from "../platform/pos-adapter";
import {
  LoginPage,
  PreparationPage,
  UnlockPage,
} from "../features/access/access-pages";
import { accessPort, accessMessage, type AccessView } from "../platform/access";

// Navegación original de TopBar, sin importar Next/Auth/Dexie ni fingir roles.
const modules = [
  { path: "/", label: "Ventas", icon: "💰", ready: true },
  { path: "/historial", label: "Historial", icon: "🗒️", ready: true },
  { path: "/inventario", label: "Inventario", icon: "📦", ready: true },
  { path: "/reparaciones", label: "Reparaciones", icon: "🔧", ready: true },
  { path: "/garantias", label: "Garantías", icon: "🛡️", ready: true },
  { path: "/apartados", label: "Apartados", icon: "🔖", ready: true },
  { path: "/clientes", label: "Clientes", icon: "👥", ready: true },
  { path: "/gastos", label: "Gastos", icon: "💸", ready: true },
  { path: "/dashboard", label: "Resumen", icon: "📊", ready: true },
  { path: "/reportes", label: "Reportes", icon: "📁", ready: true },
  { path: "/configuracion", label: "Ajustes", icon: "⚙️", ready: true },
];
function PendingModule({ name }: { name: string }) {
  const synthetic =
    new URLSearchParams(useLocation().search).get("source") === "synthetic";
  return (
    <section className="p-6">
      <h1 className="text-2xl font-bold">{name}</h1>
      <p className="mt-4 text-vr-gray">
        Pantalla reservada en la navegación definitiva. Su interfaz y comandos
        nativos aún no están implementados.
      </p>
      <p className="mt-3 text-sm text-vr-gray">
        No se consultan datos de producción ni se generan cifras o documentos de
        muestra para aparentar funcionamiento.
      </p>
      <Link
        to={synthetic ? "/?source=synthetic" : "/"}
        className="inline-block text-gold mt-6"
      >
        Volver a Ventas
      </Link>
    </section>
  );
}
function SettingsPage() {
  const s = useSales();
  return (
    <section className="p-6 overflow-y-auto">
      <h1 className="text-2xl font-bold">Ajustes</h1>
      <div className="grid gap-4 mt-6 max-w-2xl">
        <PrintingSettings/>
        <div className="bg-navy-2 rounded-xl p-5 border border-navy-3">
          <h2 className="font-bold">Fuente de datos</h2>
          <p className="mt-2 text-sm text-vr-gray">
            {s.snapshot?.mode === "staging-readonly"
              ? "Catálogo Staging de sólo lectura en SQLite cifrado · clave Windows"
              : s.snapshot?.mode === "staging-operational"
                ? "Cuenta de Staging preparada · datos locales cifrados · cola durable y recibos remotos"
                : s.snapshot
                ? "Dataset sintético en SQLite cifrado · clave Windows"
                : "Adaptador nativo no disponible"}
          </p>
          <p className="text-sm text-vr-gray mt-2">
            {s.snapshot?.mode === "staging-operational" ? "Las ventas se guardan localmente; sólo un recibo remoto válido confirma su sincronización. Este entorno no es producción." : "Fuente de consulta/prueba; no constituye una cuenta operativa."}
          </p>
        </div>
        <div className="bg-navy-2 rounded-xl p-5 border border-navy-3">
          <h2 className="font-bold">Caja y dispositivos</h2>
          <p className="text-vr-gray mt-2 text-sm">
            {s.snapshot?.mode === "staging-readonly"
              ? "Acceso firmado y PIN verificados. Esta captura no incluye caja/ventas ni habilita cobro. Impresión, respaldo y activación comercial pendientes."
              : s.snapshot?.mode === "staging-operational" ? "Turno compartido, conteo, cortes y cierre nativos. Clientes, abonos y gastos conservan su identidad y turno. Inventario: fichas, costos, precios, recetas y movimientos durables. Las extensiones remotas requieren sus migraciones Staging. Tickets de venta y corte con impresión Windows integrada; papel y respaldo comercial pendientes." : "Turno de prueba preabierto. Apertura/cierre comercial, impresora, NCF y respaldo con custodia pendientes."}
          </p>
        </div>
      </div>
    </section>
  );
}
function Layout({
  readOnly = false,
  explicitSynthetic = false,
  explicitPreview = false,
}: {
  readOnly?: boolean;
  explicitSynthetic?: boolean;
  explicitPreview?: boolean;
}) {
  const s = useSales();
  const destination = (path: string) =>
    explicitSynthetic ? `${path}?source=synthetic` : explicitPreview ? `${path}?source=preview` : path;
  useEffect(() => {
    document.title = "VentaRD nativo";
  }, []);
  return (
    <div className="flex flex-col h-screen h-dvh bg-navy overflow-hidden">
      <header className="bg-navy-2 border-b border-navy-3 px-2 sm:px-4 h-14 shrink-0 flex items-center justify-between gap-2 z-40">
        <Link
          to={destination("/")}
          className="flex items-center gap-2 shrink-0"
        >
          <img src={logo} alt="" width="28" height="28" />
          <span className="font-display font-extrabold text-gold text-lg tracking-tight">
            VentaRD
          </span>
        </Link>
        <nav
          aria-label="Navegación principal"
          className="flex items-center gap-1 mx-1 overflow-x-auto scrollbar-none"
        >
          {modules.map((m) => (
            <NavLink
              key={m.path}
              to={destination(m.path)}
              end={m.path === "/"}
              aria-label={m.label}
              title={m.ready ? m.label : `${m.label} · integración pendiente`}
              className={({ isActive }) =>
                `flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap ${isActive ? "bg-gold/15 text-gold" : "text-vr-gray hover:text-white hover:bg-navy-3"}`
              }
            >
              <span>{m.icon}</span>
              <span className="hidden xl:inline">{m.label}</span>
            </NavLink>
          ))}
        </nav>
        <Link
          to="/login"
          className="text-[11px] text-vr-gray border border-navy-3 rounded px-2 py-1 shrink-0"
          title="Preparar acceso con una cuenta de staging"
        >
          Iniciar sesión
        </Link>
      </header>
      <div className="bg-gold/10 border-b border-gold/20 px-3 sm:px-4 py-1.5 text-[11px] sm:text-xs text-gold shrink-0">
        Desarrollo nativo ·{" "}
        {readOnly
          ? "Catálogo Staging · borradores locales · cobro deshabilitado"
          : s.snapshot?.mode==="staging-operational"?"Cuenta Staging operativa · ventas locales durables · sincronización con recibos"
          : s.snapshot
            ? "Datos sintéticos · no cobrar ventas reales"
            : "Datos no disponibles"}{" "}
        · {s.snapshot?.mode==='staging-operational'?'Cola durable y recibos remotos · sólo QA':'Sin sincronización remota'}
      </div>
      <main className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <Routes>
          <Route path="/" element={<SalesPage />} />
          <Route path="/historial" element={<HistoryPage />} />
          <Route path="/inventario" element={<InventoryPage />} />
          <Route path="/clientes" element={<CustomersPage />} />
          <Route path="/gastos" element={<ExpensesPage />} />
          <Route path="/reparaciones" element={<Suspense fallback={<p className="p-6 text-vr-gray">Cargando Reparaciones…</p>}><RepairsPage /></Suspense>} />
          <Route path="/garantias" element={<Suspense fallback={<p className="p-6 text-vr-gray">Cargando Garantías…</p>}><WarrantiesPage /></Suspense>} />
          <Route path="/apartados" element={<Suspense fallback={<p className="p-6 text-vr-gray">Cargando Apartados…</p>}><LayawaysPage /></Suspense>} />
          <Route path="/dashboard" element={<ReportsPage summary />} />
          <Route path="/reportes" element={<ReportsPage />} />
          <Route path="/configuracion" element={<SettingsPage />} />
          {modules
            .filter((m) => !m.ready)
            .map((m) => (
              <Route
                key={m.path}
                path={m.path}
                element={<PendingModule name={m.label} />}
              />
            ))}
          <Route path="/caja-qa" element={<Navigate to="/" replace />} />
          <Route
            path="/catalogo"
            element={<Navigate to="/inventario" replace />}
          />
          <Route
            path="/estado"
            element={<Navigate to="/configuracion" replace />}
          />
          <Route
            path="*"
            element={
              <section className="p-6">
                <h1>Ruta no disponible</h1>
                <Link className="mt-4 inline-block text-gold" to={destination("/")}>
                  Volver a Ventas
                </Link>
              </section>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
function NativeEntry() {
  const synthetic =
    new URLSearchParams(useLocation().search).get("source") === "synthetic";
  const preview = new URLSearchParams(useLocation().search).get("source") === "preview";
  const [view, setView] = useState<AccessView | null>(null),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void accessPort
      .status()
      .then((v) => {
        if (active) {
          setView(v);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) {
          const code =
            typeof e === "object" && e !== null && "code" in e ? e.code : "";
          if (code !== "ACCESS_NATIVE_REQUIRED") setError(accessMessage(e));
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  if (synthetic)
    return (
      <SalesProvider key="synthetic">
        <Layout explicitSynthetic />
      </SalesProvider>
    );
  if (!ready)
    return (
      <div className="bg-navy min-h-dvh text-gold p-8">Abriendo VentaRD…</div>
    );
  if (error)
    return (
      <div className="bg-navy min-h-dvh text-white p-8">
        <h1 className="text-xl font-bold">No se pudo abrir el acceso local</h1>
        <p role="alert" className="text-vr-gray mt-4">
          {error}
        </p>
        <Link className="text-gold inline-block mt-6" to="/login">
          Iniciar sesión online
        </Link>
      </div>
    );
  if (view?.status === "AUTHENTICATED")
    return <Navigate to="/preparacion" replace />;
  if (view?.status === "PREPARATION_REQUIRED" && (view.operationalReady || (preview && view.catalogueReady)))
    return (
      <SalesProvider
        key={`account:${view.tenantId}:${view.actorId}:${view.operationalReady}`}
        port={view.operationalReady?nativeOperationalPort:nativePreviewPort}
      >
        <Layout readOnly={!view.operationalReady} explicitPreview={preview} />
      </SalesProvider>
    );
  if (view?.tenantId)
    return (
      <Navigate
        to={
          view.status === "PREPARATION_REQUIRED"
            ? "/preparacion"
            : "/desbloquear"
        }
        replace
      />
    );
  return <Navigate to="/login" replace />;
}
export function AppRouter() {
  useEffect(() => { document.title = "VentaRD nativo"; }, []);
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/preparacion" element={<PreparationPage />} />
      <Route path="/desbloquear" element={<UnlockPage />} />
      <Route path="*" element={<NativeEntry />} />
    </Routes>
  );
}
