import { useEffect, useRef, useState } from "react";
import {
  accessMessage,
  fiscalPort,
  type FiscalView,
} from "../../platform/access";
const reasons: Record<string, string> = {
  NOT_CONFIGURED: "El negocio no tiene una secuencia fiscal configurada.",
  KIND_NOT_CONFIGURED:
    "El tipo solicitado no está configurado en la secuencia del negocio.",
  DISABLED: "La secuencia fiscal está deshabilitada.",
  EXHAUSTED: "El rango fiscal del negocio está agotado.",
};
export function FiscalPreparation() {
  const [view, setView] = useState<FiscalView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    lock = useRef(false);
  useEffect(() => {
    let active = true;
    void fiscalPort
      .read()
      .then((v) => {
        if (active) setView(v);
      })
      .catch((e) => {
        if (active) setError(accessMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  async function prepare(kind: "B01" | "B02") {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      setView(await fiscalPort.prepare(kind));
    } catch (e) {
      setError(accessMessage(e));
      try {
        setView(await fiscalPort.read());
      } catch {
        /* Keep previous visible state; never invent availability. */
      }
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  return (
    <section
      className="mt-5 border border-navy-3 bg-navy-2 rounded-xl p-5"
      aria-labelledby="native-fiscal-title"
    >
      <h2 id="native-fiscal-title" className="font-bold text-gold">
        Comprobantes fiscales
      </h2>
      <p className="text-xs text-vr-gray mt-2">
        Preparar rangos requiere conexión. Sólo se aceptan números asignados por
        el servidor; no activa el cobro ni autoriza comprobantes ante la DGII.
      </p>
      {error && (
        <p role="alert" className="text-vr-red text-sm mt-3">
          {error}
        </p>
      )}
      {!view && !error && (
        <p role="status" className="text-sm mt-3">
          Consultando reservas locales…
        </p>
      )}
      {view && (
        <>
          <div className="text-sm mt-3">
            <p>B02 disponibles: {view.availableB02}</p>
            <p>B01 disponibles: {view.availableB01}</p>
          </div>
          {view.pending.map((kind) => (
            <p key={kind} className="text-sm text-vr-orange mt-2">
              Reserva {kind} pendiente: se consultará el mismo ID antes de
              reenviar.
            </p>
          ))}
          {view.lastStatus === "NO_BLOCK" && (
            <p role="status" className="text-sm text-vr-orange mt-3">
              {reasons[view.lastReason ?? ""] ??
                "El servidor no asignó ningún bloque."}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 mt-3">
            {(["B02", "B01"] as const).map((kind) => (
              <button
                key={kind}
                disabled={busy}
                className="border border-gold/40 text-gold rounded-xl py-3 text-sm disabled:opacity-40"
                onClick={() => void prepare(kind)}
              >
                {view.pending.includes(kind)
                  ? `Recuperar ${kind}`
                  : `Preparar 20 ${kind}`}
              </button>
            ))}
          </div>
          {busy && (
            <p role="status" className="text-xs text-vr-gray mt-2">
              Consultando la reserva con identidad estable…
            </p>
          )}
        </>
      )}
    </section>
  );
}
