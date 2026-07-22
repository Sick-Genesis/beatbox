import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1280,height:720} });
await p.goto('http://localhost:5173',{waitUntil:'networkidle'});
await p.waitForTimeout(1000);
await p.evaluate(()=>{ if(window.beatBank?.[0]) window.beatBank[0].peaks=Array.from({length:120},(_,i)=>Math.abs(Math.sin(i/5))*0.85+0.12); });
await p.evaluate(()=>window.beatCarousel?.goTo?.(0));
await p.evaluate(()=>window.beatTransport?.play?.());
await p.waitForTimeout(400);
// paint 40% progress to see the fill
await p.evaluate(()=>{ const bars=[...document.querySelectorAll('.wave-bar')]; bars.forEach((bar,i)=>bar.classList.toggle('is-played', i<=48)); });
// find the waveform group's screen box
const box = await p.evaluate(()=>{ const g=document.querySelector('.waveform'); const r=g.getBoundingClientRect(); return {x:Math.round(r.x-10),y:Math.round(r.y-25),w:Math.round(r.width+20),h:Math.round(r.height+50)}; });
await p.screenshot({ path:'_wave.png', clip: box });
await b.close();
