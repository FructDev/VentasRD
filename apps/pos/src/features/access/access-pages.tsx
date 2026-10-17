import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  accessPort,
  cataloguePort,
  accessMessage,
  type AccessView,
  salesAccountPort,
} from "../../platform/access";
import logo from "../../../../../public/icon-192x192.png";
import { FiscalPreparation } from "./fiscal-preparation";
import {BackupSettings} from '../settings/backup-settings';
function Frame({ children,production=false }: { children: ReactNode;production?:boolean }) {
  return (
    <div className="min-h-dvh bg-navy flex text-white">
      <aside className="hidden lg:flex w-[45%] bg-navy-2 border-r border-white/5 flex-col justify-between p-12">
        <div>
          <div className="flex items-center gap-3 mb-14">
            <img src={logo} width="36" height="36" alt="" />
            <span className="text-xl font-display font-extrabold">VentaRD</span>
          </div>
          <h2 className="text-4xl font-display font-black leading-tight">
            Tu punto de venta.
            <br />
            <span className="text-gold">En tu dispositivo.</span>
          </h2>
          <p className="text-vr-gray mt-6 leading-relaxed">
            Acceso nativo, permisos verificados y datos locales cifrados. La
            preparación inicial requiere conexión; el desbloqueo local utiliza
            tu PIN.
          </p>
          <div className="mt-8 rounded-xl border border-gold/20 bg-gold/10 p-4 text-sm text-gold">
            {production?'Piloto de producción · NCF deshabilitado':'Desarrollo · Sólo Staging · No usar para ventas reales'}
          </div>
        </div>
        <p className="text-xs text-vr-gray">Hecho en República Dominicana</p>
      </aside>
      <main className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <img src={logo} width="32" height="32" alt="" />
            <strong className="text-gold">VentaRD</strong>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
const input =
  "w-full px-4 py-3 bg-navy-2 border border-navy-3 rounded-xl text-white focus:border-gold outline-none";
const button =
  "w-full bg-gold text-navy font-bold rounded-xl py-3 mt-4 disabled:opacity-40";
export function LoginPage() {
  const navigate = useNavigate(),
    busyRef = useRef(false);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [configured, setConfigured] = useState<boolean | null>(null),[production,setProduction]=useState(false);
  useEffect(() => {
    let active = true;
    void accessPort
      .status()
      .then((v) => {
        if (active) {setConfigured(v.configured);setProduction(v.environment==='production-pilot');}
      })
      .catch((e) => {
        if (active) {
          setConfigured(false);
          setError(accessMessage(e));
        }
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const state = await accessPort.login(email, password);
      navigate(state.operationalReady ? "/" : state.status === "LOCKED" ? "/desbloquear" : "/preparacion", { replace: true });
    } catch (e) {
      setError(accessMessage(e));
    } finally {
      setPassword("");
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <Frame production={production}>
      <h1 className="text-2xl font-display font-black">Inicia sesión</h1>
      <p className="text-vr-gray text-sm mt-2 mb-8">
        Prepara esta instalación con tu cuenta de VentaRD.
      </p>
      {configured === false && !error && (
        <p role="status" className="text-gold mb-4 text-sm">
          Esta entrega todavía no tiene su conexión configurada.
        </p>
      )}
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm font-bold text-vr-gray">
          Correo electrónico
          <input
            autoFocus
            required
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`${input} mt-2`}
            disabled={busy}
          />
        </label>
        <label className="block text-sm font-bold text-vr-gray">
          Contraseña
          <input
            required
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${input} mt-2`}
            disabled={busy}
          />
        </label>
        {error && (
          <p
            role="alert"
            className="p-3 rounded-xl text-vr-red bg-vr-red/10 text-sm"
          >
            {error}
          </p>
        )}
        <button disabled={busy || configured !== true} className={button}>
          {busy ? "Verificando acceso…" : "Iniciar sesión"}
        </button>
      </form>
      <div className="flex justify-between gap-4 mt-6 text-sm">
        <Link to="/desbloquear" className="text-gold">
          Desbloquear con PIN
        </Link>
        <Link to="/" className="text-vr-gray">
          Volver
        </Link>
      </div>
      <details className="mt-6"><summary className="text-sm text-vr-gray cursor-pointer">Recuperar datos desde un respaldo</summary><div className="mt-4"><BackupSettings recoveryOnly/></div></details>
    </Frame>
  );
}
export function PreparationPage() {
  const navigate = useNavigate(),
    busyRef = useRef(false);
  const [view, setView] = useState<AccessView | null>(null),
    [tenant, setTenant] = useState(""),
    [branch, setBranch] = useState(""),
    [pin, setPin] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(""),
    [setupRequired, setSetupRequired] = useState(false);
  useEffect(() => {
    let active = true;
    void accessPort
      .status()
      .then((v) => {
        if (active) {
          setView(v);
          setTenant(v.tenants[0]?.id ?? "");
          setBranch(v.tenants[0]?.branches[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(accessMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  async function run(fn: () => Promise<AccessView>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      setView(await fn());
    } catch (e) {
      setError(accessMessage(e));
      setProgress("");
      setSetupRequired(typeof e === "object" && e !== null && "code" in e && e.code === "SALES_SETUP_REQUIRED");
    } finally {
      setPin("");
      setBusy(false);
      busyRef.current = false;
    }
  }
  async function prepare() {
    await run(async () => {
      setProgress("Descargando y verificando tus datos para trabajar localmente…");
      await salesAccountPort.bootstrap();
      const state = await accessPort.status();
      if (!state.operationalReady) throw { code: "SALES_EVIDENCE_INVALID" };
      navigate("/", { replace: true });
      return state;
    });
  }
  async function download() {
    await run(async () => {
      for (let i = 0; i < 51; i++) {
        const step = await cataloguePort.step();
        setProgress(`Páginas verificadas: ${step.received}/${step.total}`);
        if (step.complete) return step.view;
      }
      throw { code: "CATALOGUE_INCOMPLETE" };
    });
  }
  const tenants = view?.tenants ?? [],
    chosen = tenants.find((t) => t.id === tenant),
    needsRegistration = view?.status === "AUTHENTICATED";
  return (
    <Frame production={view?.environment==='production-pilot'}>
      <h1 className="text-2xl font-display font-black">Preparar instalación</h1>
      <p className="text-vr-gray text-sm mt-2 mb-6">
        Cuenta, dispositivo y permisos antes de descargar datos.
      </p>
      {error && (
        <p
          role="alert"
          className="text-vr-red bg-vr-red/10 rounded-xl p-3 mb-4 text-sm"
        >
          {error}
        </p>
      )}
      {!view && !error && <p>Consultando estado local…</p>}
      {view && ["LOGIN_REQUIRED", "NOT_CONFIGURED"].includes(view.status) && (
        <Link className="text-gold" to="/login">
          Iniciar sesión online
        </Link>
      )}
      {needsRegistration && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => accessPort.provision(tenant, branch || null));
          }}
        >
          <label className="block text-sm text-vr-gray">
            Negocio
            <select
              value={tenant}
              disabled={busy}
              className={`${input} mt-2 mb-4`}
              onChange={(e) => {
                setTenant(e.target.value);
                setBranch(
                  tenants.find((t) => t.id === e.target.value)?.branches[0]
                    ?.id ?? "",
                );
              }}
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-vr-gray">
            Sucursal
            <select
              value={branch}
              disabled={busy}
              onChange={(e) => setBranch(e.target.value)}
              className={`${input} mt-2`}
            >
              <option value="">Inventario general (sin sucursal)</option>
              {chosen?.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-vr-gray mt-3">
            La instalación queda vinculada a este ámbito. No se cambia al elegir
            otra cuenta.
          </p>
          <button className={button} disabled={busy || !tenant}>
            {busy ? "Verificando registro…" : "Registrar esta instalación"}
          </button>
        </form>
      )}
      {view && ["PIN_ENROLLMENT_REQUIRED", "LOCKED"].includes(view.status) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => accessPort.pin(pin, !view.pinEnrolled));
          }}
        >
          <p className="text-sm text-gold mb-4">
            Permiso firmado verificado ·{" "}
            {view.role === "seller"
              ? "Vendedor"
              : view.role === "admin"
                ? "Administrador"
                : "Dueño"}
          </p>
          <label className="block text-sm text-vr-gray">
            {view.pinEnrolled
              ? "PIN de esta cuenta"
              : "Crea tu PIN de cuatro dígitos"}
            <input
              autoFocus
              className={`${input} mt-2 tracking-[0.5em] text-center`}
              type="password"
              autoComplete="off"
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              minLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              required
              disabled={busy}
            />
          </label>
          <button className={button} disabled={busy}>
            {busy
              ? "Verificando…"
              : view.pinEnrolled
                ? "Desbloquear"
                : "Guardar PIN"}
          </button>
        </form>
      )}
      {view?.status === "PREPARATION_REQUIRED" && (
        <div
          role="status"
          className="bg-navy-2 border border-navy-3 rounded-xl p-5"
        >
          <h2 className="font-bold text-gold">Acceso local preparado</h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li>✓ Cuenta y dispositivo vinculados</li>
            <li>✓ Permiso firmado guardado en el vault cifrado</li>
            <li>✓ PIN local protegido</li>
            <li
              className={view.catalogueReady ? "text-vr-green" : "text-vr-gray"}
            >
              {view.catalogueReady
                ? "✓ Catálogo descargado y verificado para consulta"
                : "Pendiente: captura consistente del catálogo"}
            </li>
            <li className="text-vr-gray">
              {view.operationalReady?"✓ Datos operativos nativos preparados":"Pendiente: preparación operativa de Ventas"}
            </li>
          </ul>
          <p className="text-sm text-vr-gray mt-4">Descarga los datos de tu negocio una vez para empezar. Cuando estén preparados podrás abrir VentaRD con tu PIN y vender sin conexión, con un turno ya confirmado para efectivo.</p>
          {progress && (
            <p className="text-xs text-gold mt-3" aria-live="polite">
              {progress}
            </p>
          )}
          {view.operationalReady ? <Link to="/" className="block mt-4 text-gold font-bold">Abrir VentaRD</Link> : <button className={button} disabled={busy} onClick={() => void prepare()}>{busy ? "Preparando tu punto de venta…" : "Descargar catálogo y abrir VentaRD"}</button>}
          <details className="mt-5 text-sm">
            <summary className="text-vr-gray cursor-pointer">Opciones de soporte</summary>
          <button
            className={button}
            disabled={busy}
            onClick={() => void download()}
          >
            {busy
              ? "Descargando y verificando…"
              : view.catalogueReady
                ? "Actualizar captura"
                : "Descargar catálogo"}
          </button>
          {view.catalogueReady && (
            <Link to="/inventario?source=preview" className="block mt-4 text-gold font-bold">
              Consultar captura de sólo lectura
            </Link>
          )}
           {view.environment!=='production-pilot'&&!view.operationalReady && setupRequired && ['owner','admin'].includes(view.role??'')&&<button disabled={busy} className="text-gold text-sm underline mt-4" onClick={()=>{
            if(!window.confirm('Sólo QA Staging: confirma que los escritores anteriores de este negocio sintético están detenidos. Adoptar datos y bloquear escrituras legacy NO es una migración de producción.'))return;
            void run(async()=>{await salesAccountPort.activate('QA_SYNTHETIC_QUIESCED','0.18');const state=await accessPort.status();if(!state.operationalReady)throw{code:'SALES_EVIDENCE_INVALID'};navigate('/',{replace:true});return state;});
           }}>Adoptar negocio sintético para Ventas nativas</button>}
          {view.environment!=='production-pilot'&&<FiscalPreparation />}
          </details>
          <button
            className="text-gold mt-5"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const v = await accessPort.lock();
                navigate("/desbloquear");
                return v;
              })
            }
          >
            Bloquear y conservar datos
          </button>
        </div>
      )}
      <Link to="/login" className="inline-block mt-6 text-sm text-vr-gray">
        Usar otra cuenta
      </Link>
      {view?.environment!=='production-pilot'&&view?.configured === false && <Link to="/?source=synthetic" className="block text-gold mt-5 underline">
        Probar Ventas nativas · datos sintéticos separados
      </Link>}
    </Frame>
  );
}
export function UnlockPage() {
  const navigate = useNavigate(),
    ref = useRef(false);
  const [pin, setPin] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),[production,setProduction]=useState(false);
  useEffect(()=>{let active=true;void accessPort.status().then(v=>{if(active)setProduction(v.environment==='production-pilot')}).catch(()=>undefined);return()=>{active=false}},[]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (ref.current) return;
    ref.current = true;
    setBusy(true);
    setError("");
    try {
      const state = await accessPort.pin(pin, false);
      navigate(state.operationalReady ? "/" : "/preparacion", { replace: true });
    } catch (e) {
      setError(accessMessage(e));
    } finally {
      setPin("");
      setBusy(false);
      ref.current = false;
    }
  }
  return (
    <Frame production={production}>
      <h1 className="font-display text-2xl font-black">Desbloquear VentaRD</h1>
      <p className="text-vr-gray text-sm my-4">
        Usa el PIN de la cuenta preparada en este dispositivo. No requiere login
        remoto.
      </p>
      <form onSubmit={submit}>
        <label className="block text-sm text-vr-gray">
          PIN
          <input
            autoFocus
            type="password"
            required
            pattern="[0-9]{4}"
            minLength={4}
            maxLength={4}
            autoComplete="off"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            className={`${input} mt-2 text-center tracking-[0.5em]`}
            disabled={busy}
          />
        </label>
        {error && (
          <p role="alert" className="text-vr-red mt-4 text-sm">
            {error}
          </p>
        )}
        <button disabled={busy} className={button}>
          {busy ? "Desbloqueando…" : "Desbloquear"}
        </button>
      </form>
      <Link to="/login" className="text-gold text-sm inline-block mt-6">
        Iniciar sesión online con otra cuenta
      </Link>
    </Frame>
  );
}
