import { expect, it } from 'vitest';
import { addCalendarMonth, wechatPayEnabled } from '../src/wechat-pay.js';
it.each([
 ['2026-01-31T12:30:00Z','2026-02-28T12:30:00Z'],
 ['2028-01-31T12:30:00Z','2028-02-29T12:30:00Z'],
 ['2026-12-31T12:30:00Z','2027-01-31T12:30:00Z'],
])('preserves calendar-month entitlement from %s', (start,end)=>{
 expect(addCalendarMonth(Date.parse(start))).toBe(Date.parse(end));
});
it('honours the sale switch independently of existing payments',async()=>{
 expect(await wechatPayEnabled({FILES:{get:async()=>({text:async()=>'{"enabled":false}'})}})).toBe(false);
 expect(await wechatPayEnabled({FILES:{get:async()=>({text:async()=>'{"enabled":true}'})}})).toBe(true);
});
