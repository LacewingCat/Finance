import { Decimal } from 'decimal.js';
import type { Instrument,HistoryPoint } from '../shared/types.js';
const BASE='https://push2his.eastmoney.com/api/qt/stock/kline/get';
export function parsePriceHistory(input:unknown,code:string):HistoryPoint[]{
  const data=(input as {data?:{code?:string;klines?:unknown[]}})?.data;
  if(!data||data.code?.toUpperCase()!==code.toUpperCase()||!Array.isArray(data.klines))throw new Error('历史证券代码或结构不一致');
  const rows=new Map<string,HistoryPoint>();
  for(const raw of data.klines){if(typeof raw!=='string')throw new Error('历史行无效');const [date,,close]=raw.split(',');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||!/^\d+(\.\d+)?$/.test(close)||!new Decimal(close).gt(0))throw new Error('历史价格或日期无效');if(rows.has(date)&&rows.get(date)!.nav!==close)throw new Error('同日历史价格冲突');rows.set(date,{date,nav:close});}
  if(!rows.size)throw new Error('没有可用的历史收盘价');return [...rows.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export async function priceHistory(instrument:Instrument,read:(url:string)=>Promise<{body:string}>){
  const code=instrument.code.replace(/^(sh|sz|hk|us)/,'');
  const markets=instrument.market==='US'?['105','106','107']:instrument.market==='HK'?['116']:instrument.market==='CN'?[/^[569]/.test(code)?'1':'0']:[];
  if(!markets.length)throw new Error('该市场暂无已验证免费历史来源');
  for(const market of markets){const url=new URL(BASE);url.search=new URLSearchParams({secid:market+'.'+code,klt:'101',fqt:'0',beg:'20200101',end:'20500101',lmt:'1500',fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'}).toString();
    try{const result=await read(url.href);return {history:parsePriceHistory(JSON.parse(result.body),code),sourceUrl:url.href,priceKind:'trade' as const};}catch(error){if(market===markets.at(-1))throw error;}
  }throw new Error('历史价格读取失败');
}
