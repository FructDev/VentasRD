import {ReceiptDocument} from '../services/receipt-document';
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { type PosTicket } from "../../platform/pos-adapter";
import {NativeTicketVenta} from "./native-ticket-venta";
import {useSales} from './workspace';
import {posError} from '../../platform/pos-adapter';
/** The saved invoice, shared by Sales and History. Never recalculated. */
export function TicketDialog({
  ticket,
  synthetic,
  onClose,
}: {
  ticket: PosTicket;
  synthetic: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const s=useSales(),attempt=useRef<string|null>(ticket.printAttempt?.attemptId??null),gate=useRef(false);
  const [printing,setPrinting]=useState(false),[printNotice,setPrintNotice]=useState(''),[printError,setPrintError]=useState(''),[hasPrintAttempt,setHasPrintAttempt]=useState(!!ticket.printAttempt);
  async function print(){if(!s.printTicket||!ticket.printSnapshotHash||gate.current)return;gate.current=true;setPrinting(true);setPrintError('');attempt.current??=crypto.randomUUID();setHasPrintAttempt(true);try{const response=await s.printTicket(ticket.operationId,ticket.printSnapshotHash,attempt.current);if(response.status==="FAILED")setPrintError("La solicitud anterior falló. Revisa la impresora y solicita una reimpresión.");else setPrintNotice(response.submitted===false?'Solicitud anterior recuperada sin imprimir de nuevo. Comprueba el papel antes de reimprimir.':'Solicitud enviada a Windows. Comprueba el papel antes de reimprimir.');attempt.current=null;setHasPrintAttempt(false);}catch(e){setPrintError(posError(e));}finally{gate.current=false;setPrinting(false);}}
  useEffect(() => {
    const previous = document.activeElement;
    ref.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({preventScroll:true});
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  function key(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
    if (e.key === "Tab") {
      const buttons=ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if(buttons?.length){const first=buttons[0],last=buttons[buttons.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
    }
  }
  return (
    <div className="fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4">
      <section
        ref={ref}
        onKeyDown={key}
        role="dialog"
        aria-modal="true"
        aria-labelledby="saved-ticket-title"
        className="bg-white text-black rounded-xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto"
      >
        <h2 id="saved-ticket-title" className="font-bold text-xl text-center">
          Ticket guardado · {ticket.ticket}
        </h2>
        <p className="text-xs text-center mt-2">
          {synthetic
            ? "PRUEBA SINTÉTICA · NO VÁLIDO FISCALMENTE"
            : "COPIA LOCAL · validez fiscal no verificada"}
        </p>
        <ReceiptDocument layout={ticket.printLayout} padding saleCopies><NativeTicketVenta ticket={ticket}/></ReceiptDocument>
        <p className="text-xs text-gray-600 mt-4">
          Importes originales guardados. Un pago registrado no acredita
          liquidación bancaria. La solicitud de impresión no acredita salida de papel.
        </p>
        {printNotice&&<p role="status" className="text-xs text-green-700 mt-3">{printNotice}</p>}{printError&&<p role="alert" className="text-xs text-red-700 mt-3">{printError}</p>}
        <button onClick={()=>void print()} disabled={!s.printTicket||!ticket.printSnapshotHash||printing} className="mt-4 w-full rounded-xl bg-gold-gradient text-navy p-3 font-bold disabled:opacity-30">{printing?'Preparando impresión…':hasPrintAttempt?'Recuperar solicitud de impresión':printNotice?'Reimprimir ticket':'Imprimir ticket'}</button>
        <button
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-navy text-white p-3"
        >
          Cerrar ticket
        </button>
      </section>
    </div>
  );
}
