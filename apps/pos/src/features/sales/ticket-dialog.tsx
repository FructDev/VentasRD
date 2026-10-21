import {printReceipt} from '../services/receipt-raster';
import {ReceiptDocument} from '../services/receipt-document';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { type PosTicket } from "../../platform/pos-adapter";
import {NativeTicketVenta} from "./native-ticket-venta";
import {useSales} from './workspace';
import {posError} from '../../platform/pos-adapter';
/** The saved invoice, shared by Sales and History. Never recalculated. */
export function TicketDialog({
  ticket,
  synthetic,
  onClose,
  autoPrint = false,
}: {
  ticket: PosTicket;
  synthetic: boolean;
  onClose: () => void;
  autoPrint?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const autoStarted=useRef(false);
  const {printTicket}=useSales(),attempt=useRef<string|null>(ticket.printAttempt?.attemptId??null),gate=useRef(false);
  const [printing,setPrinting]=useState(false),[printNotice,setPrintNotice]=useState(''),[printError,setPrintError]=useState(''),[hasPrintAttempt,setHasPrintAttempt]=useState(!!ticket.printAttempt);
  const print=useCallback(async()=>{if(!printTicket||!ticket.printSnapshotHash||gate.current)return;gate.current=true;setPrinting(true);setPrintError('');attempt.current??=crypto.randomUUID();setHasPrintAttempt(true);try{await Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,2500))]);for(const img of ref.current?.querySelectorAll<HTMLImageElement>('.native-ticket-document img')??[]){await img.decode()}await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));if(!ref.current)return;const response=await printReceipt(raster=>printTicket(ticket.operationId,ticket.printSnapshotHash!,attempt.current!,raster),ref.current,ticket.printTarget);if(response.status==="FAILED")setPrintError("La solicitud anterior falló. Revisa la impresora y solicita una reimpresión.");else setPrintNotice(response.submitted===false?'Solicitud anterior recuperada sin imprimir de nuevo. Comprueba el papel antes de reimprimir.':(ticket.printTarget&&ticket.printTarget.mode!=='DIALOG'?'Solicitud enviada a la impresora. Comprueba el papel antes de reimprimir.':'Solicitud enviada a Windows. Comprueba el papel antes de reimprimir.'));attempt.current=null;setHasPrintAttempt(false);}catch(e){setPrintError(posError(e));}finally{gate.current=false;setPrinting(false);}},[printTicket,ticket]);
  useEffect(()=>{if(!autoPrint||autoStarted.current||ticket.printAttempt||ticket.autoPrintJob?.state!=='QUEUED')return;const timer=setTimeout(()=>{if(autoStarted.current)return;autoStarted.current=true;attempt.current=ticket.autoPrintJob!.attemptId;void print()},0);return()=>clearTimeout(timer)},[autoPrint,ticket.operationId,ticket.printAttempt,ticket.autoPrintJob,print]);
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
    if (e.key === "Escape" && !printing) {
      e.preventDefault();
      onClose();
    }
    if (e.key === "Tab") {
      const buttons=ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if(buttons?.length){const first=buttons[0],last=buttons[buttons.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
    }
  }
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[70] flex items-end sm:items-center justify-center sm:p-4">
      <section
        ref={ref}
        onKeyDown={key}
        role="dialog"
        aria-modal="true"
        aria-labelledby="saved-ticket-title"
        className="bg-navy-2 text-white border border-navy-3 rounded-t-2xl sm:rounded-2xl p-6 sm:p-8 max-w-md w-full max-h-[90vh] overflow-y-auto shadow-2xl"
      >
        <h2 id="saved-ticket-title" className="font-display font-black text-2xl text-center">
          Recibo de venta
        </h2>
        {synthetic&&<p className="text-xs text-center text-gold mt-2">PRUEBA SINTÉTICA</p>}
        <ReceiptDocument layout={ticket.printLayout} padding saleCopies><NativeTicketVenta ticket={ticket}/></ReceiptDocument>
        {printNotice&&<p role="status" className="text-xs text-green-700 mt-3">{printNotice}</p>}{printError&&<p role="alert" className="text-xs text-red-700 mt-3">{printError}</p>}
        <button onClick={()=>void print()} disabled={!printTicket||!ticket.printSnapshotHash||printing} className="mt-4 w-full rounded-xl bg-gold-gradient text-navy p-3 font-bold disabled:opacity-30">{printing?'Preparando impresión…':hasPrintAttempt?'Recuperar solicitud de impresión':printNotice?'Reimprimir ticket':'Imprimir ticket'}</button>
        <button
          disabled={printing}
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-navy text-white p-3"
        >
          Cerrar ticket
        </button>
      </section>
    </div>
  );
}
