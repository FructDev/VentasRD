import { useEffect, useRef, useState } from "react";
import Pagination from "@ventard/ui/pagination";
import {
  posError,
  showCents,
  type PosHistoryFilter,
  type PosHistoryPage,
  type PosTicket,
} from "../../platform/pos-adapter";
import { useSales } from "./workspace";
import { TicketDialog } from "./ticket-dialog";
import {ReturnDialog} from './return-dialog';
import type {ReturnView} from '../../platform/management';
import {useManagement} from '../management/workspace';
import {MovementHistory} from './movement-history';
const returnFamilies=['SALE_RETURN'] as const;
const methods = [
  [null, "Todos"],
  ["EFECTIVO", "Efectivo"],
  ["TARJETA", "Tarjeta"],
  ["TRANSFERENCIA", "Transferencia"],
  ["FIADO", "Fiado"],
  ["MIXTO", "Mixto"],
] as const;
const input = "bg-navy-3 rounded-xl p-3 text-white border border-navy-3 w-full";
function boundary(day: string, next = false): string | null {
  if (!day) return null;
  const date = new Date(`${day}T00:00:00`);
  if (next) date.setDate(date.getDate() + 1);
  const ms = date.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) throw { code: "CONTRACT_INVALID" };
  return String(ms);
}
export function HistoryPage() {
  const s = useSales(),
    [search, setSearch] = useState(""),
    [method, setMethod] = useState<string | null>(null),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const m=useManagement(returnFamilies),[returnData,setReturnData]=useState<ReturnView|null>(null),[returnNotice,setReturnNotice]=useState('');
  const [tab,setTab]=useState<'sales'|'movements'>('sales');
  const [response, setResponse] = useState<{
      key: string;
      data: PosHistoryPage | null;
      error: string;
    }>({ key: "", data: null, error: "" }),
    [ticket, setTicket] = useState<PosTicket | null>(null),
    [ticketError, setTicketError] = useState(""),
    [opening, setOpening] = useState(false),
    openingRef = useRef(false);
  const key = JSON.stringify({ search, method, from, to, page, revision });
  const read = s.historyRead;
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (!read) throw { code: "HISTORY_SNAPSHOT_UNAVAILABLE" };
          const filter: PosHistoryFilter = {
            search,
            method,
            fromMs: boundary(from),
            toMs: boundary(to, true),
            page,
          };
          const data = await read(filter);
          if (active) setResponse({ key, data, error: "" });
        } catch (e) {
          if (active) setResponse({ key, data: null, error: posError(e) });
        }
      })();
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [read, key, search, method, from, to, page]);
  const data = response.key === key ? response.data : null,
    error = response.key === key ? response.error : "";
  function filter(action: () => void) {
    action();
    setPage(1);
    setTicketError("");
  }
  async function openTicket(id: string) {
    if (openingRef.current || !s.readTicket) return;
    openingRef.current = true;
    setOpening(true);
    setTicketError("");
    try {
      setTicket(await s.readTicket(id));
    } catch (e) {
      setTicketError(posError(e));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }
  async function openReturn(id:string){if(openingRef.current||!s.management)return;openingRef.current=true;setOpening(true);setTicketError('');try{setReturnData(await s.management.returnRead(id));}catch(e){setTicketError(posError(e));}finally{openingRef.current=false;setOpening(false);}}
  return (
    <section className="flex-1 overflow-y-auto p-3 sm:p-6">
      <div className="max-w-6xl mx-auto"><div inert={!!ticket||!!returnData}>
        <header className="flex flex-wrap justify-between items-center gap-3 mb-5">
          <div>
            <h1 className="text-2xl sm:text-3xl font-display font-extrabold">
              Historial
            </h1>
            <p className="text-vr-gray text-sm mt-1">
              Ventas nativas guardadas en este dispositivo
            </p>
          </div>
          <div className="flex bg-navy-2 border border-navy-3 rounded-xl p-1 gap-1">
            <button onClick={()=>setTab('sales')} className={`font-bold text-sm px-3 py-2 rounded-lg ${tab==='sales'?'bg-gold text-navy':'text-vr-gray'}`}>
              Ventas
            </button>
            <button
              disabled={!s.management}
              onClick={()=>setTab('movements')}
              className={`px-3 py-2 text-sm rounded-lg disabled:opacity-50 ${tab==='movements'?'bg-gold text-navy':'text-vr-gray'}`}
              title="Movimientos nativos disponibles en este dispositivo"
            >
              Movimientos
            </button>
          </div>
        </header>
        <p className="text-xs text-vr-orange border border-gold/20 bg-gold/5 rounded-xl p-3 mb-4">
          Historial local, no reporte central completo. Incluye ventas nativas
          locales y las recibidas por sincronización de este ámbito; no importa
          automáticamente el histórico de la PWA. Cada venta indica si tiene
          recibo remoto verificado.
        </p>
        <div className="flex gap-2 flex-wrap mb-4">
          {methods.map(([id, label]) => (
            <button
              key={id ?? "all"}
              aria-pressed={method === id}
              onClick={() => filter(() => setMethod(id))}
              className={`px-4 py-2 rounded-full text-sm font-bold border ${method === id ? "border-gold bg-gold/15 text-gold" : "border-navy-3 text-vr-gray"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid sm:grid-cols-[2fr_1fr_1fr_auto] gap-3 mb-5">
          <label className="text-xs text-vr-gray">
            Buscar venta
            <input
              aria-label="Buscar venta"
              value={search}
              maxLength={256}
              onChange={(e) => filter(() => setSearch(e.target.value))}
              className={`${input} mt-1`}
              placeholder="Ticket, NCF o cliente registrado en el ticket"
            />
          </label>
          <label className="text-xs text-vr-gray">
            Desde
            <input
              type="date"
              aria-label="Ventas desde"
              value={from}
              onChange={(e) => filter(() => setFrom(e.target.value))}
              className={`${input} mt-1`}
            />
          </label>
          <label className="text-xs text-vr-gray">
            Hasta
            <input
              type="date"
              aria-label="Ventas hasta"
              value={to}
              onChange={(e) => filter(() => setTo(e.target.value))}
              className={`${input} mt-1`}
            />
          </label>
          <button
            onClick={() => {setRevision((n) => n + 1);void m.reload().catch(e=>setTicketError(posError(e)));}}
            className="text-gold text-sm border border-navy-3 rounded-xl px-4 self-end py-3"
          >
            Actualizar historial
          </button>
        </div>
        {error && (
          <p role="alert" className="text-vr-red mb-4">
            {error}
          </p>
        )}
        {returnNotice&&<p role="status" className="text-vr-green mb-4">{returnNotice}</p>}
        {m.pending?.kind==='SALE_RETURN'&&<button className="text-gold mb-4" onClick={()=>void openReturn(m.pending!.kind==='SALE_RETURN'?m.pending!.saleId:'')}>Recuperar devolución pendiente</button>}
        {ticketError && (
          <p role="alert" className="text-vr-red mb-4">
            {ticketError}
          </p>
        )}
        {!data && !error && (
          <p role="status" className="text-vr-gray py-8">
            Consultando historial local…
          </p>
        )}
        {data && tab==='sales' && (
          <>
            <p className="text-xs text-vr-gray mb-3">
              {data.scope === "BRANCH"
                ? `Sucursal ${data.branchId}`
                : "Ámbito global"}{" "}
              · {data.total} coincidencias locales · sólo lectura
            </p>
            <div className="bg-navy-2 border border-navy-3 rounded-2xl overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-vr-gray text-xs uppercase border-b border-navy-3">
                  <tr>
                    {[
                      "Ticket",
                      "Fecha",
                      "Cliente",
                      "Método",
                      "Total",
                      "Acciones",
                    ].map((label) => (
                      <th key={label} className="p-3 sm:p-4 font-semibold">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr
                      key={row.operationId}
                      data-history-sale={row.operationId}
                      className="border-b border-navy-3/60"
                    >
                      <td className="p-3 sm:p-4 font-mono text-gold">
                        {row.ticket}
                        <small className="block font-sans text-vr-gray mt-1">
                          {row.remoteStatus === "APPLIED"
                            ? "Recibo remoto verificado"
                            : "Sin recibo remoto verificado"}
                        </small>
                        {row.ncf && (
                          <small className="block text-vr-gray">
                            {row.ncf}
                          </small>
                        )}
                      </td>
                      <td className="p-3 text-vr-gray whitespace-nowrap">
                        {row.dateMs
                          ? new Date(Number(row.dateMs)).toLocaleString("es-DO")
                          : "No verificable"}
                      </td>
                      <td className="p-3">
                        {row.customerName ??
                          (row.ticketEvidence === "VERIFIED_SNAPSHOT"
                            ? "Consumidor final"
                            : "No verificable")}
                      </td>
                      <td className="p-3">
                        {row.method
                          ? (methods.find(([id]) => id === row.method)?.[1] ??
                            "No verificable")
                          : "No verificable"}
                      </td>
                      <td className="p-3 font-mono whitespace-nowrap">
                        {showCents(row.totalCents)}
                      </td>
                      <td className="p-3">
                        <button
                          disabled={
                            opening ||
                            row.ticketEvidence !== "VERIFIED_SNAPSHOT"
                          }
                          aria-label={`Ver ticket ${row.ticket}`}
                          onClick={() => void openTicket(row.operationId)}
                          className="text-gold border border-navy-3 rounded-lg p-2 disabled:opacity-40"
                        >
                          Ver ticket
                        </button>
                        {s.management&&<button disabled={opening||!m.canManage||row.ticketEvidence!=='VERIFIED_SNAPSHOT'} aria-label={`Devolver ticket ${row.ticket}`} onClick={()=>void openReturn(row.operationId)} className="text-vr-red border border-vr-red/20 rounded-lg p-2 ml-2 disabled:opacity-40">Devolver</button>}
                        {row.ticketEvidence !== "VERIFIED_SNAPSHOT" && (
                          <p className="text-xs text-vr-orange mt-2">
                            {row.ticketEvidence === "CORRUPT_SNAPSHOT"
                              ? "Ticket no pasó la verificación"
                              : "Sin snapshot histórico"}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.rows.length && (
                <p className="text-center text-vr-gray p-12">
                  No hay coincidencias en el historial nativo local.
                </p>
              )}
            </div>
            <Pagination
              pagina={data.page}
              totalPaginas={Math.max(
                1,
                Math.ceil(Number(data.total) / data.pageSize),
              )}
              totalItems={Number(data.total)}
              itemsPorPagina={data.pageSize}
              onCambiar={setPage}
            />
          </>
        )}
        {tab==='movements'&&m.view&&<MovementHistory rows={m.view.movements} search={search} method={method} from={from} to={to} limit={m.view.movementLimit}/>}</div>{returnData&&<ReturnDialog data={returnData} onClose={()=>setReturnData(null)} onSaved={()=>{setReturnData(null);setReturnNotice('Devolución guardada localmente · sincronización pendiente.');setRevision(n=>n+1);void m.reload();}}/>}
        {ticket && (
          <TicketDialog
            ticket={ticket}
            synthetic={s.snapshot?.mode === "synthetic"}
            onClose={() => setTicket(null)}
          />
        )}
      </div>
    </section>
  );
}
