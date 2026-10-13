import 'fake-indexeddb/auto';
import {test,expect} from 'vitest';import {writeFile} from 'node:fs/promises';
import {VentaRDDatabase} from '../../src/lib/db/dexie';
import {prepararCheckoutLocal,confirmarCheckoutLocal,type CheckoutEntrada} from '../../src/lib/domain/ventas/checkoutLocal';
import {buildProduct} from '../../src/lib/sync/inventory/test-fixtures';
const tenant='96000000-0000-4000-8000-000000000001',productId='96000013-0000-4000-8000-000000000001',saleId='96000013-0000-4000-8000-000000000002';
test('original web checkout emits its own persisted hash and frozen invoice, without network',async()=>{
 const db=new VentaRDDatabase('QA_CHECKOUT_CODEC_'+crypto.randomUUID());try{
 const product=buildProduct({id:productId,negocio_id:tenant,precio_venta:12.34,costo:5,tasa_itbis:0,stock_actual:10});await db.productos.add(product);
 const input:CheckoutEntrada={cartId:saleId,scope:{negocioId:tenant,sucursalId:null},comando:{version:1,operacionId:saleId,negocioId:tenant,cajaCodigo:'C7K',fecha:1791909600000,total:12.34,metodoPago:'transferencia',garantiaDias:0,items:[{productoId:productId,nombre:'Cable original',cantidad:1,precioUnitario:12.34}]},comprobante:{items:[{...product,nombre:'Cable original',cantidad:1}],subtotal:12.34,itbis:0,descuento:0,total:12.34,montoRecibido:12.34,negocio:{nombre:'Negocio histórico QA',rnc:'QA-RNC-SINTETICO',direccion:'Dirección histórica QA',telefono:'QA-TELEFONO',mensajePie:'Pie original QA'}}};
 await prepararCheckoutLocal(db,input);await confirmarCheckoutLocal(db,input.scope,saleId);
 const journal=await db.operaciones_locales.get(tenant+':CHECKOUT:'+saleId),sale=await db.ventas.get(saleId),details=await db.venta_detalles.toArray();expect(journal?.estado_local).toBe('COMMITTED');expect(journal?.payload_hash).toMatch(/^[a-f0-9]{64}$/);expect(sale?.total).toBe(12.34);
 await writeFile(new URL('../../crates/ventard-core/tests/fixtures/legacy-checkout-original.json',import.meta.url),JSON.stringify({journal,sale,details}));
 }finally{db.close();await db.delete();}
});
