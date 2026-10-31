import {it,expect} from 'vitest';
import {Store} from '../src/server/store.js';
import {buildApp} from '../src/server/app.js';
import {AiService} from '../src/server/ai.js';
import {DEFAULT_SETTINGS} from '../src/server/config.js';
import {recordTransaction} from '../src/server/ledger.js';
import type {Instrument,ProductData} from '../src/shared/types.js';

it('runs the complete validated decision chain into a local outbox and prevents a duplicate alert',async()=>{
  const store=new Store(':memory:'),now=new Date('2026-10-30T02:00:00Z'),sent:string[]=[];
  const instrument:Instrument={code:'TEST01',name:'合成验收基金',kind:'fund',currency:'CNY',market:'CN',channel:'test',feeRate:'0',rulesVerified:true,purchasable:true,minBuy:'1',settlementDays:0,watched:true};
  const product:ProductData={instrument,observation:{code:instrument.code,price:'2',asOf:'2026-10-29',fetchedAt:now.toISOString(),priceKind:'nav',quality:'valid',currency:'CNY',source:'synthetic',sourceUrl:'https://example.com/fixture'},history:Array.from({length:20},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,nav:'2'})),exposures:[],documents:[],errors:[],fetchedAt:now.toISOString()};
  store.put('instruments',instrument.code,instrument);
  store.put('settings','app',{...structuredClone(DEFAULT_SETTINGS),apiEnabled:true,creditConfirmed:true,creditAmount:'100',creditStartsAt:'2026-10-01T00:00:00Z',creditExpiresAt:'2026-11-01T00:00:00Z',risk:{minimumCash:'100',singleTradeLimit:'500',maxPositionPct:'50',configured:true},calendarVerifiedThrough:{CN:'2026-12-31'}});
  recordTransaction(store,{idempotencyKey:'deposit',kind:'deposit',currency:'CNY',account:'test',date:'2026-10-01',amount:'1000'});
  recordTransaction(store,{idempotencyKey:'opening',kind:'opening',currency:'CNY',account:'test',date:'2026-10-01',amount:'100',quantity:'100',code:instrument.code});
  const fetcher=async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);if(url.endsWith('/models'))return Response.json({data:[{id:'gpt-6-luna'},{id:'gpt-6.1-sol'}]});const body=JSON.parse(String(init?.body));const usage={input_tokens:100,output_tokens:50};sent.push(url);
    if(url.endsWith('/decisions'))return Response.json({usage,answers:[{name:'action',type:'choice',probabilities:[{value:'Buy',probability:.91},{value:'Sell',probability:.04},{value:'Hold',probability:.05}],confidence:.94},{name:'quality',type:'score',score:8}]});
    const isReview=body.text?.format?.name==='confidence_review';const text=JSON.stringify(isReview?{eligible:true,confidence:.95,summary:'合成证据复核'}:{candidates:[0,1,2].map(index=>({index,score:7,urgency:2,reason:'合成金额评价'}))});
    return Response.json({usage,status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]});
  };
  const service=new AiService(store,{fetch:fetcher as typeof fetch,keyProvider:()=> 'synthetic-key',now:()=>now});
  const server=await buildApp({store,ai:service,now:()=>now,staticDir:'/nonexistent',fetchProduct:async i=>i.code===instrument.code?product:{instrument:i,history:[],exposures:[],documents:[],errors:['offline fixture'],fetchedAt:now.toISOString()},fetchNews:async()=>({documents:[],errors:[],fetchedAt:now.toISOString()})});
  try{await server.refresh();const alerts=store.list<{candidates:unknown[];status:string}>('alerts');expect(alerts).toHaveLength(1);expect(alerts[0].status).toBe('local');expect(alerts[0].candidates).toHaveLength(3);expect(sent).toHaveLength(3);await server.refresh();expect(store.list('alerts')).toHaveLength(1);expect(sent).toHaveLength(3);}finally{await server.app.close();store.close();}
});
