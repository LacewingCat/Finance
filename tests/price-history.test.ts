import {it,expect} from 'vitest';
import {parsePriceHistory} from '../src/server/price-history.js';
it('reads the close column and rejects mismatched securities and invalid dates',()=>{const row={data:{code:'AAPL',klines:['2026-10-30,100,102,104,98,1000,10000']}};expect(parsePriceHistory(row,'AAPL')[0]).toEqual({date:'2026-10-30',nav:'102'});expect(()=>parsePriceHistory(row,'JPM')).toThrow();expect(()=>parsePriceHistory({data:{code:'AAPL',klines:['2026-02-30,100,102']}},'AAPL')).toThrow();});
