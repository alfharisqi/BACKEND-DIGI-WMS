// Narrow integration regression for APIs consumed by main. In-memory only; no DB/broker init.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { orang1InboundRoutes } from '../src/modules/orang1-inbound/routes';
import { MemoryRepository } from '../src/modules/orang1-inbound/repository';

const productId='6bd2bf20-a925-4abb-8cfa-188d234883a8';
async function qa() {
  const source={products:[{id:productId,sku:'QA-O1-MAIN',name:'QA integration',category:'QA',unit_price:'12500.50',min_stock_threshold:0,current_stock:7}],tags:[],items:[],goods_receipts:[],stock_movements:[],gate_events:[],settings:{warehouse_name:'QA unchanged shared settings'}};
  const app=Fastify(); const events:unknown[]=[];
  await app.register(orang1InboundRoutes,{repository:new MemoryRepository(source),publish:(_topic,payload)=>events.push(payload)});
  await app.ready(); return {app,source,events};
}
test('Main dashboard and CSV receive price/minimum aliases, preserving zero and stock',async()=>{
  const {app}=await qa();try{const res=await app.inject({method:'GET',url:'/api/products'});assert.equal(res.statusCode,200);const j=res.json();assert.equal(j.status,'ok');const p=j.data[0];assert.equal(p.id,productId);assert.equal(p.price_idr,'12500.50');assert.equal(p.price,'12500.50');assert.equal(p.min_stock,0);assert.equal(p.min_stock_alert,0);assert.equal(p.current_stock,7);}finally{await app.close();}
});
test('Main legacy RFID URL shares canonical list',async()=>{
  const {app}=await qa();try{const a=await app.inject({method:'GET',url:'/api/tags'});const b=await app.inject({method:'GET',url:'/api/rfid/tags'});assert.equal(b.statusCode,200);assert.deepEqual(b.json(),a.json());}finally{await app.close();}
});
test('Main SKU/epc_code request resolves exact UUID and remains simulated without ledger',async()=>{
  const {app,source,events}=await qa();try{const res=await app.inject({method:'POST',url:'/api/rfid/encode',payload:{sku:'QA-O1-MAIN',epc_code:'ABCDEF0123456789ABCDEF01',location_code:'LOC-STAGE-01'}});assert.equal(res.statusCode,201);const j=res.json();assert.equal(j.tag.epc,'ABCDEF0123456789ABCDEF01');assert.equal(j.item.product_id,productId);assert.equal(j.hardware_confirmed,false);assert.equal(j.data.mode,'simulation');assert.equal(j.item.location_id,undefined);assert.equal(source.stock_movements.length,0);assert.equal(events.length,1);}finally{await app.close();}
});
test('Main alias rejects missing SKU instead of substituting another product',async()=>{
  const {app,source,events}=await qa();try{const res=await app.inject({method:'POST',url:'/api/rfid/encode',payload:{sku:'QA-O1-MISSING',epc_code:'ABCDEF0123456789ABCDEF02'}});assert.equal(res.statusCode,404);assert.equal(res.json().success,false);assert.equal(source.tags.length,0);assert.equal(events.length,0);}finally{await app.close();}
});
test('Main alias keeps EPC validation and hardware transition protection',async()=>{
  const {app,source,events}=await qa();try{for(const [payload,expected]of [[{sku:'QA-O1-MAIN',epc_code:'SHORT'},400],[{sku:'QA-O1-MAIN',mode:'hardware'},409]]as const){const res=await app.inject({method:'POST',url:'/api/rfid/encode',payload});assert.equal(res.statusCode,expected);assert.equal(res.json().success,false);}assert.equal(source.tags.length,0);assert.equal(events.length,0);}finally{await app.close();}
});
test('Conflict rollback preserves shared main settings object and error status',async()=>{
  const {app,source,events}=await qa();const settings=source.settings;
  try{const request={method:'POST' as const,url:'/api/rfid/encode',payload:{sku:'QA-O1-MAIN',epc_code:'ABCDEF0123456789ABCDEF03'}};
    assert.equal((await app.inject(request)).statusCode,201);
    const duplicate=await app.inject(request);assert.equal(duplicate.statusCode,409);assert.equal(duplicate.json().success,false);
    assert.equal(source.settings,settings);assert.equal(settings.warehouse_name,'QA unchanged shared settings');assert.equal(source.tags.length,1);assert.equal(source.items.length,1);assert.equal(events.length,1);
  }finally{await app.close();}
});
