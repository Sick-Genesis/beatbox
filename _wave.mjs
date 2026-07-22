import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1280,height:720} });
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.goto('http://localhost:5173',{waitUntil:'networkidle'});
await p.waitForTimeout(1200);
// inject fake peaks onto the current beat and load it
await p.evaluate(()=>{
  if(window.beatBank && window.beatBank[0]){
    window.beatBank[0].peaks = Array.from({length:120},(_,i)=>Math.abs(Math.sin(i/6))*0.9+0.1);
  }
});
await p.evaluate(()=>window.beatCarousel?.goTo?.(0));
await p.evaluate(()=>window.beatTransport?.play?.());
await p.waitForTimeout(500);
const bars = await p.$$eval('.waveform .wave-bar', b=>b.length);
console.log('wave bars rendered:', bars);
console.log('ERRORS:', errs.length?errs.join('\n'):'(none)');
await p.screenshot({ path:'_wave.png', clip:{x:400,y:625,width:460,height:95} });
await b.close();
