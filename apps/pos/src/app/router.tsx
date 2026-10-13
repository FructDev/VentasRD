import {applyBrand} from '../features/settings/brand';
import {BusinessSettings} from '../features/settings/business-settings';
import {BackupSettings} from '../features/settings/backup-settings';
import {nativeArchivePort} from '../platform/archive';
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
const InventoryImportPage=lazy(()=>import('../features/catalog/inventory-import-page').then(m=>({default:m.InventoryImportPage})));
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
    <section className="h-full p-4 sm:p-8 overflow-y-auto">
      <div className="max-w-3xl mx-auto mb-6"><h1 className="text-2xl sm:text-3xl font-display font-black text-white">Configuración del Negocio</h1><p className="text-vr-gray mt-2">Personaliza la información que aparece en los tickets y reportes.</p></div>
      <div className="grid gap-4 max-w-3xl mx-auto"><BusinessSettings/>
        <PrintingSettings/>
        <BackupSettings/>
        <div className="bg-navy-2 rounded-xl p-5 border border-navy-3">
          <h3 className="text-lg font-bold text-vr-gray mb-1 border-b border-navy-3 pb-2">🩺 Estado del Sistema</h3>
          <p className="text-xs text-vr-gray mb-4">Datos de este dispositivo para soporte. No envía ventas ni datos de clientes.</p>
          <div className="bg-navy rounded-xl border border-navy-3 p-4">{[
            ['Entorno',s.snapshot?.mode==='recovery-readonly'?'Archivo recuperado · sólo consulta':s.snapshot?.mode==='staging-operational'?'Staging QA · operativo':s.snapshot?.mode==='staging-readonly'?'Staging QA · sólo lectura':s.snapshot?'Fixture sintético':'No disponible'],
            ['Pendientes totales',s.snapshot?.pendingOperations??'No disponible'],
            ['Ventas locales confirmadas',s.snapshot?.confirmedSales??'No disponible'],
          ].map(([label,value])=><div key={label} className="flex items-center justify-between gap-3 text-sm py-1.5 border-b border-navy-3/40"><span className="text-vr-gray">{label}</span><span className="font-mono font-bold text-white text-xs text-right">{value}</span></div>)}</div>
          <button type="button" onClick={()=>void s.refresh()} className="mt-3 py-2.5 px-4 bg-navy-3 border border-navy-3 hover:border-gold/40 text-vr-gray hover:text-gold font-bold rounded-xl text-sm transition-all">↻ Actualizar</button>
          <p className="mt-4 text-xs text-vr-gray">Catálogo público, invitaciones, configuración fiscal, activación operativa de copias en otro equipo y validación de hardware: pendientes en esta versión.</p>
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
  useEffect(()=>{applyBrand(s.snapshot?.business?.color??"dorado",s.snapshot?.business?.font??"syne")},[s.snapshot?.business?.color,s.snapshot?.business?.font]);
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
        {s.snapshot?.mode==='recovery-readonly'?`Archivo recuperado · sólo consulta · copia del ${new Date(Number(s.snapshot.backupCapturedAtMs)).toLocaleString('es-DO')}`:readOnly
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
          <Route path="/inventario/importar" element={<Suspense fallback={<p className="p-6 text-vr-gray">Cargando importación…</p>}><InventoryImportPage/></Suspense>} />
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
        <div className="max-w-3xl mt-6"><BackupSettings recoveryOnly/></div>
      </div>
    );
  if(view?.status==='RECOVERY_ARCHIVE')return <SalesProvider key="recovery-archive" port={nativeArchivePort}><Layout readOnly/></SalesProvider>;
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
