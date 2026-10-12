import {useEffect,useRef,type ReactNode} from 'react';
export function InventoryModal({title,busy,onClose,children}:{title:string;busy:boolean;onClose:()=>void;children:ReactNode}){
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{const old=document.activeElement;ref.current?.querySelector<HTMLInputElement>('input')?.focus();return()=>{if(old instanceof HTMLElement)old.focus();};},[]);
 return <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[60] flex items-end sm:items-center justify-center sm:p-4"><div ref={ref} role="dialog" aria-modal="true" aria-labelledby="inventory-modal" className="bg-navy-2 border border-navy-3 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[95vh] overflow-y-auto" onKeyDown={e=>{
  if(e.key==='Escape'&&!busy){e.preventDefault();onClose();}
  if(e.key==='Tab'){const list=ref.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled),select:not(:disabled),textarea:not(:disabled)');if(list?.length){const first=list[0],last=list[list.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}
 }}><div className="p-5 border-b border-navy-3 flex justify-between"><h2 id="inventory-modal" className="text-xl font-display font-bold text-white">{title}</h2><button aria-label="Cerrar formulario" disabled={busy} onClick={onClose} className="px-2">✕</button></div>{children}</div></div>;
}
