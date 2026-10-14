import {useNavigate} from 'react-router-dom';
import {useRef,useState,type FormEvent} from 'react';
import Pagination from '@ventard/ui/pagination';
import {InventoryView,type InventoryRowView} from '@ventard/ui/inventory';
import {useSales} from '../sales/workspace';
import {inputCents,posError,posErrorCode,showCents,type PosProduct,type PosProductWrite,type PosStockChange} from '../../platform/pos-adapter';

import {useManagement} from '../management/workspace';
import {InventoryModal} from './inventory-modal';
import {NativeProductEditor,NativeStockEditor,NativeInventoryHistory} from './native-inventory-editors';
const inventoryFamilies=['PRODUCT_SAVE','PRODUCT_DELETE','INVENTORY_CHANGE'] as const;
const inputStyle='w-full bg-navy-3 border border-navy-3 rounded-xl p-3 text-white outline-none focus:border-gold';
function ProductEditor({product,onClose,onDone}:{product:PosProduct|null;onClose:()=>void;onDone:(p:PosProduct)=>void}){
 const s=useSales();const [name,setName]=useState(product?.name??''),[code,setCode]=useState(product?.code??''),[price,setPrice]=useState(product?`${BigInt(product.priceCents)/100n}.${String(BigInt(product.priceCents)%100n).padStart(2,'0')}`:'');
 const [intent,setIntent]=useState<PosProductWrite|null>(null),[error,setError]=useState('');const sending=useRef(false);
 async function submit(e:FormEvent){e.preventDefault();if(sending.current)return;setError('');let request=intent;
  try{if(!request){if(!name.trim()||!code.trim())throw {code:'CONTRACT_INVALID'};request={operationId:crypto.randomUUID(),productId:product?.id??null,expectedRevision:product?.revision??null,name:name.trim(),code:code.trim(),priceCents:inputCents(price)};}
   sending.current=true;setIntent(request);const result=await s.saveProduct(request);onDone(result.product);
  }catch(e){setError(posError(e));if(['PRODUCT_CODE_EXISTS','VERSION_CONFLICT','CONTRACT_INVALID','QA_AMOUNT_INVALID'].includes(posErrorCode(e)))setIntent(null);}
  finally{sending.current=false;}
 }
 return <InventoryModal title={product?'Editar producto':'Nuevo producto'} busy={s.busy||!!intent} onClose={onClose}><form onSubmit={e=>void submit(e)} className="p-5 grid gap-4">
  <label className="text-sm">Nombre<input value={name} onChange={e=>setName(e.target.value)} maxLength={120} required disabled={s.busy||!!intent} className={`${inputStyle} mt-1`}/></label>
  <label className="text-sm">Código / SKU<input value={code} onChange={e=>setCode(e.target.value)} maxLength={64} required disabled={s.busy||!!intent} className={`${inputStyle} mt-1 font-mono`}/></label>
  <label className="text-sm">Precio de venta (RD$)<input value={price} onChange={e=>setPrice(e.target.value)} inputMode="decimal" required disabled={s.busy||!!intent} className={`${inputStyle} mt-1 font-mono`}/></label>
  <p className="text-xs text-vr-gray">{product?'Editar la ficha no cambia las unidades existentes.':'El producto empieza con 0 unidades. Registra una entrada mediante Ajustar stock.'} Costo, ITBIS configurable, recetas, seriales e imágenes pendientes.</p>
  {error&&<p role="alert" className="text-sm text-vr-red">{error}</p>}{intent&&!s.busy&&<p className="text-xs text-vr-orange">Respuesta incierta: conserva este intento. Reintentar consulta/aplica la misma identidad, no una nueva.</p>}
  <button type="submit" disabled={s.busy} className="bg-gold-gradient text-navy rounded-xl p-3 font-bold disabled:opacity-30">{s.busy?'Guardando…':intent?'Reintentar el mismo guardado':'Guardar producto'}</button>
 </form></InventoryModal>;
}
function StockEditor({product,onClose,onDone}:{product:PosProduct;onClose:()=>void;onDone:(p:PosProduct)=>void}){
 const s=useSales();const [delta,setDelta]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState(''),[intent,setIntent]=useState<PosStockChange|null>(null);const sending=useRef(false);
 async function submit(e:FormEvent){e.preventDefault();if(sending.current)return;setError('');let request=intent;
  try{if(!request){if(!/^-?[1-9][0-9]*$/.test(delta)||!reason.trim())throw {code:'CONTRACT_INVALID'};request={operationId:crypto.randomUUID(),productId:product.id,expectedRevision:product.revision,delta,reason:reason.trim()};}
   sending.current=true;setIntent(request);const result=await s.adjustStock(request);onDone(result.product);
  }catch(e){setError(posError(e));if(['VERSION_CONFLICT','CONTRACT_INVALID'].includes(posErrorCode(e)))setIntent(null);}
  finally{sending.current=false;}
 }
 return <InventoryModal title="Ajustar stock" busy={s.busy||!!intent} onClose={onClose}><form onSubmit={e=>void submit(e)} className="p-5 grid gap-4"><p className="font-bold">{product.name} · {product.stock} unidades locales</p>
  <label className="text-sm">Variación de unidades<input value={delta} onChange={e=>setDelta(e.target.value)} inputMode="text" placeholder="5 para entrada, -2 para salida" required disabled={s.busy||!!intent} className={`${inputStyle} mt-1 font-mono`}/></label>
  <label className="text-sm">Motivo<input value={reason} onChange={e=>setReason(e.target.value)} maxLength={120} required disabled={s.busy||!!intent} className={`${inputStyle} mt-1`}/></label>
  <p className="text-xs text-vr-gray">Movimiento entero y auditable; no es conteo absoluto ni devolución monetaria. El núcleo valida versión, límites y stock disponible. Sin confirmación remota.</p>
  {error&&<p role="alert" className="text-sm text-vr-red">{error}</p>}{intent&&!s.busy&&<p className="text-xs text-vr-orange">Respuesta incierta: sólo reintentar este mismo movimiento.</p>}
  <button type="submit" disabled={s.busy} className="bg-gold-gradient text-navy rounded-xl p-3 font-bold disabled:opacity-30">{s.busy?'Guardando…':intent?'Reintentar el mismo movimiento':'Registrar movimiento'}</button>
 </form></InventoryModal>;
}
export function InventoryPage(){
 const navigate=useNavigate(),s=useSales(),m=useManagement(inventoryFamilies),operational=s.snapshot?.mode==='staging-operational';const [search,setSearch]=useState(''),[page,setPage]=useState(1),[filter,setFilter]=useState('all'),[sort,setSort]=useState<'name'|'stock'>('name'),[editor,setEditor]=useState<{kind:'product'|'stock'|'delete'|'history'|'recovery';product:PosProduct|null}|null>(null),[notice,setNotice]=useState('');
 const all=s.snapshot?.products??[],norm=(v:string)=>v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 const stockKnown=(p:PosProduct)=>p.kind==='combo'?p.possibleStock!=null:p.preview?.stockVerifiable!==false&&p.stock!=='';
 const units=(p:PosProduct)=>p.kind==='combo'?(p.possibleStock??'0'):p.stock;
 const knownEmpty=all.filter(p=>stockKnown(p)&&BigInt(units(p))<=0n).length,unknownStock=all.some(p=>!stockKnown(p)),unknownKind=all.some(p=>p.kind===undefined);
 const filters=[{key:'all',label:'Todos',count:String(all.length)},{key:'low',label:'Por agotarse',count:String(all.filter(p=>stockKnown(p)&&p.minimum!=null&&BigInt(units(p))>0n&&BigInt(units(p))<=BigInt(p.minimum)).length),disabled:all.every(p=>p.minimum==null)},{key:'empty',label:'Agotados',count:`${knownEmpty}${unknownStock?' conocidos':''}`},...(['simple','insumo','combo']as const).map((kind,i)=>({key:kind,label:['Venta','Insumos','Combos'][i],count:unknownKind?null:String(all.filter(p=>p.kind===kind).length),disabled:unknownKind}))];
 const products=all.filter(p=>norm(`${p.name} ${p.code} ${p.location??''}`).includes(norm(search))&&(filter==='all'||(filter==='empty'?stockKnown(p)&&BigInt(units(p))<=0n:filter==='low'?stockKnown(p)&&p.minimum!=null&&BigInt(units(p))>0n&&BigInt(units(p))<=BigInt(p.minimum):p.kind===filter))).sort((a,b)=>{
  if(sort==='stock'){if(stockKnown(a)!==stockKnown(b))return stockKnown(a)?-1:1;if(stockKnown(a)&&units(a)!==units(b))return BigInt(units(a))<BigInt(units(b))?-1:1;}
  return a.name.localeCompare(b.name,'es',{sensitivity:'base'})||a.id.localeCompare(b.id);
 });
 const readOnly=s.snapshot?.mode==='staging-readonly'||!!s.snapshot?.inventoryReadOnly||(operational&&!m.canManage),itemsPerPage=10,pages=Math.max(1,Math.ceil(products.length/itemsPerPage)),current=Math.min(page,pages),ready=s.snapshot?.status==='ready';
 const rows:InventoryRowView[]=products.slice((current-1)*itemsPerPage,current*itemsPerPage).map(p=>({id:p.id,name:p.name,photo:p.photo,code:p.code,kind:p.kind??'Tipo pendiente',location:p.location??'',price:p.preview?.priceVerifiable===false?'No verificable':showCents(p.priceCents),cost:p.costCents==null?'No verificable':showCents(p.costCents),margin:p.marginCents==null?'No verificable':showCents(p.marginCents),stock:stockKnown(p)?units(p):'No verificable',minimum:p.minimum??'No verificable',stockKnown:stockKnown(p),stockEvidence:p.preview?.stockEvidence}));
 function done(p:PosProduct){setEditor(null);setSearch(p.code);setFilter('all');setPage(1);setNotice(`${p.name}: cambio guardado localmente. Sin sincronización remota.`);}
 function edit(id:string,kind:'product'|'stock'|'delete'|'history'){const product=all.find(p=>p.id===id);if(product&&(kind==='history'||!readOnly))setEditor({kind,product});}
 return <section className="flex-1 p-3 sm:p-6 lg:p-8 overflow-y-auto min-h-0">
  <InventoryView onImport={operational?()=>navigate("/inventario/importar"):undefined} summary={s.snapshot?.inventorySummary?{lowCount:s.snapshot.inventorySummary.lowCount,minimumCoverage:s.snapshot.inventorySummary.minimumCoverage,capital:s.snapshot.inventorySummary.capitalCents==null?'No verificable':showCents(s.snapshot.inventorySummary.capitalCents),bestName:s.snapshot.inventorySummary.bestMargin?.name??'No verificable',bestAmount:s.snapshot.inventorySummary.bestMargin?showCents(s.snapshot.inventorySummary.bestMargin.amountCents):'No verificable'}:undefined} rows={rows} loading={s.loading} query={search} filter={filter} filters={filters} sort={sort} disabled={!ready||s.busy||m.busy||!!m.pending} readOnly={readOnly} onQuery={v=>{setSearch(v);setPage(1);}} onFilter={v=>{setFilter(v);setPage(1);}} onSort={v=>{setSort(v);setPage(1);}} onNew={()=>{setNotice('');setEditor({kind:'product',product:null});}} onEdit={id=>edit(id,'product')} onStock={id=>edit(id,'stock')} onDelete={operational?id=>edit(id,'delete'):undefined} onHistory={operational?id=>edit(id,'history'):undefined} pagination={<Pagination pagina={current} totalPaginas={pages} totalItems={products.length} itemsPorPagina={itemsPerPage} onCambiar={setPage}/> }>
   <p className="text-xs text-vr-gray mb-4">{s.snapshot?.mode==='staging-operational'?'Inventario operativo Staging: base remota más pendientes locales. Cambios registrados con identidad durable; sincronización pendiente hasta recibir confirmación.':readOnly?`Captura de Staging de sólo lectura · ${s.snapshot?.preview?.scope} · fecha ${new Date(Number(s.snapshot?.preview?.asOf)).toLocaleString('es-DO')}. No es disponibilidad actual para vender; sin feed continuo.`:'Catálogo simple de desarrollo. Importación, combos, costos, seriales e imágenes pendientes.'} <button onClick={()=>void s.refresh()} disabled={s.busy} className="text-gold underline">Actualizar catálogo</button></p>
   <p className="text-[11px] text-vr-gray mb-4">{all.length} productos en el catálogo local. Los datos que faltan en la fuente se muestran como no verificables. Importación Excel/CSV disponible para dueño o administrador en cuenta operativa. Imágenes pendientes.</p>
   {m.notice&&<p role="status" className="text-vr-green text-sm mb-3">{m.notice}</p>}{m.error&&!editor&&<p role="alert" className="text-vr-red text-sm mb-3">{m.error}</p>}{m.pending&&!editor&&<button onClick={()=>setEditor({kind:'recovery',product:null})} className="text-gold underline mb-4">Recuperar intento pendiente de Inventario</button>}
   {s.snapshot?.status==='needs-dataset'&&<div className="bg-gold/10 rounded-xl p-4 mb-4 text-sm">No hay almacenamiento local preparado. <button disabled={s.busy} onClick={()=>void s.createTestDataset()} className="text-gold underline">Crear datos sintéticos</button><p className="text-xs text-vr-gray mt-2">Preparación explícita con 10 productos de prueba; no importa ni reemplaza datos de producción.</p></div>}
   {!s.snapshot&&!s.loading&&<p role="alert" className="text-vr-orange mb-4">{s.error||'No hay un catálogo nativo disponible.'}</p>}{notice&&<p role="status" className="text-vr-green text-sm mb-3">{notice}</p>}{s.error&&s.snapshot&&<p role="alert" className="text-vr-red text-sm mb-3">{s.error}</p>}
  </InventoryView>
  {editor?.kind==='product'&&(operational?<NativeProductEditor product={editor.product} products={all} manager={m} onClose={()=>setEditor(null)} onDone={()=>setEditor(null)}/>:<ProductEditor product={editor.product} onClose={()=>setEditor(null)} onDone={done}/>)}
  {editor?.kind==='stock'&&editor.product&&(operational?<NativeStockEditor product={editor.product} manager={m} onClose={()=>setEditor(null)} onDone={()=>setEditor(null)}/>:<StockEditor product={editor.product} onClose={()=>setEditor(null)} onDone={done}/>)}
  {editor?.kind==='delete'&&editor.product&&<InventoryModal title="Eliminar Producto" busy={m.busy} onClose={()=>setEditor(null)}><div className="p-5 space-y-4"><p>¿Eliminar {editor.product.name} del catálogo? Se conserva su historial y sus unidades registradas.</p>{m.error&&<p role="alert" className="text-vr-red">{m.error}</p>}<button disabled={m.busy} onClick={()=>void (m.pending?m.retry():m.execute({kind:'PRODUCT_DELETE',operationId:crypto.randomUUID(),productId:editor.product!.id,expectedRevision:editor.product!.revision})).then(ok=>{if(ok)setEditor(null);})} className="bg-vr-red text-white rounded-xl p-3 font-bold">{m.pending?'Reintentar la misma eliminación':'Eliminar'}</button></div></InventoryModal>}
  {editor?.kind==='recovery'&&<InventoryModal title="Recuperar intento" busy={m.busy} onClose={()=>setEditor(null)}><div className="p-5 space-y-4"><p className="text-sm">{m.pending?.kind} · {m.pending?.operationId}</p><p className="text-xs text-vr-gray">Reintentar conserva los mismos datos e identidad.</p>{m.error&&<p role="alert" className="text-vr-red">{m.error}</p>}<button disabled={m.busy} onClick={()=>void m.retry().then(ok=>{if(ok)setEditor(null);})} className="bg-gold-gradient text-navy font-bold rounded-xl p-3">Reintentar el mismo intento</button><button disabled={m.busy} onClick={()=>void m.abandon().then(ok=>{if(ok)setEditor(null);})} className="text-vr-red text-sm underline">Descartar intento sin efectos</button></div></InventoryModal>}
  {editor?.kind==='history'&&editor.product&&<NativeInventoryHistory product={editor.product} onClose={()=>setEditor(null)}/>}
 </section>;
}
