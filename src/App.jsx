import {useRef,useState} from 'react'
import {FFmpeg} from '@ffmpeg/ffmpeg'
import {toBlobURL} from '@ffmpeg/util'

const CORE='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm'
const DEFAULT_MODELS='gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash'
const fmt=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`
const ls=(k,d)=>{try{return localStorage.getItem(k)??d}catch{return d}}
const lset=(k,v)=>{try{localStorage.setItem(k,v)}catch{}}

// loudness (RMS) per second -> interest score -> best non-overlapping windows
function score(r){
  const m=r.reduce((a,b)=>a+b,0)/r.length, sd=Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/r.length)||1
  const z=Array.from(r,v=>(v-m)/sd)
  return z.map((v,i)=>v+Math.max(0,v-(z[i-5]??v))*0.5)
}
function quiet(r,a,b){let best=Math.max(0,a);for(let i=Math.max(0,a);i<=Math.min(r.length-1,b);i++)if(r[i]<r[best])best=i;return best}
function pick(sc,r,len,count){
  const n=sc.length;len=Math.min(len,n);const P=[0];sc.forEach((v,i)=>P.push(P[i]+v))
  const cand=[];for(let s=0;s+len<=n;s++)cand.push({s,v:P[s+len]-P[s]})
  cand.sort((a,b)=>b.v-a.v);const out=[]
  for(const c of cand){if(out.length>=count)break;if(out.every(x=>Math.abs(x.s-c.s)>=len))out.push(c)}
  return out.map(c=>{let s=quiet(r,c.s-3,c.s+3),e=quiet(r,c.s+len-3,c.s+len+3);if(e-s<5)e=c.s+len
    return {s,e,score:c.v/len}}).sort((a,b)=>a.s-b.s).map((c,i)=>({...c,id:i}))
}

export default function App(){
  const ff=useRef(null),[file,setFile]=useState(null),[url,setUrl]=useState(''),[clips,setClips]=useState([]),[env,setEnv]=useState([])
  const [len,setLen]=useState(30),[count,setCount]=useState(8),[vertical,setVertical]=useState(false),[fast,setFast]=useState(false)
  const [useAI,setUseAI]=useState(ls('cf_ai','0')==='1'),[key,setKey]=useState(ls('cf_key','')),[models,setModels]=useState(ls('cf_models',DEFAULT_MODELS))
  const [status,setStatus]=useState(''),[pct,setPct]=useState(0),[busy,setBusy]=useState(false)

  async function engine(){
    if(ff.current)return ff.current
    setStatus('Loading video engine (first time only)…')
    const f=new FFmpeg();f.on('progress',({progress})=>setPct(Math.max(0,Math.min(1,progress))))
    await f.load({coreURL:await toBlobURL(`${CORE}/ffmpeg-core.js`,'text/javascript'),wasmURL:await toBlobURL(`${CORE}/ffmpeg-core.wasm`,'application/wasm')})
    return ff.current=f
  }
  // WORKERFS reads the file in place, so a 1-hour video is never copied into memory
  async function mount(f){try{await f.createDir('/in')}catch{};try{await f.unmount('/in')}catch{};await f.mount('WORKERFS',{files:[file]},'/in')}

  function choose(fl){if(!fl)return;if(url)URL.revokeObjectURL(url);setFile(fl);setUrl(URL.createObjectURL(fl));setClips([]);setEnv([]);setStatus('')}

  async function analyse(){
    setBusy(true);setClips([]);setPct(0)
    try{
      const f=await engine();await mount(f);setStatus('Reading audio…')
      await f.exec(['-i',`/in/${file.name}`,'-vn','-ac','1','-ar','8000','-f','s16le','-y','a.raw'])
      const u=await f.readFile('a.raw');await f.deleteFile('a.raw')
      const pcm=new Int16Array(u.slice().buffer),n=Math.floor(pcm.length/8000),r=new Float32Array(n)
      for(let i=0;i<n;i++){let s=0;for(let j=0;j<8000;j++){const v=pcm[i*8000+j]/32768;s+=v*v}r[i]=Math.sqrt(s/8000)}
      setStatus('Finding the best moments…')
      let found=pick(score(r),r,len,count);setEnv(Array.from(r));setClips(found)
      if(useAI&&key)found=await enhance(found).catch(e=>{setStatus('AI step skipped: '+e.message);return found})
      setClips(found);setStatus(prev=>prev.startsWith('AI')?prev:`${found.length} clips ready.`)
    }catch(e){setStatus('Something went wrong: '+e.message)}
    setBusy(false);setPct(0)
  }

  // Optional: Gemini writes titles/hooks. Only free-tier model IDs from your list are tried, in order.
  async function enhance(list){
    setStatus('Asking Gemini for titles…')
    const prompt=`These are clip candidates from a video, ranked by loudness/energy score. For each, write a short title (max 6 words) and a one-line hook. Reply ONLY as JSON: [{"id":0,"title":"","hook":""}]\n`+JSON.stringify(list.map(c=>({id:c.id,start:fmt(c.s),end:fmt(c.e),score:+c.score.toFixed(2)})))
    for(const m of models.split(',').map(x=>x.trim()).filter(Boolean)){
      try{
        const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`,
          {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json'}})})
        if(!res.ok)continue
        const arr=JSON.parse((await res.json()).candidates[0].content.parts[0].text)
        return list.map(c=>({...c,...(arr.find(a=>a.id===c.id)||{})}))
      }catch{}
    }
    throw new Error('no free-tier model answered (quota or key issue)')
  }

  async function cut(c){
    const f=await engine();await mount(f);const a=['-ss',String(c.s),'-i',`/in/${file.name}`,'-t',String(c.e-c.s)]
    if(fast&&!vertical)a.push('-c','copy')
    else a.push(...(vertical?['-vf','crop=ih*9/16:ih,scale=720:1280']:[]),'-c:v','libx264','-preset','ultrafast','-crf','27','-c:a','aac')
    await f.exec([...a,'-y','o.mp4']);const d=await f.readFile('o.mp4');await f.deleteFile('o.mp4')
    const l=document.createElement('a');l.href=URL.createObjectURL(new Blob([d.buffer],{type:'video/mp4'}))
    l.download=`clip-${c.id+1}-${fmt(c.s).replace(':','m')}${vertical?'-9x16':''}.mp4`;l.click()
  }
  async function dl(list){setBusy(true);for(const c of list){setStatus(`Exporting clip ${c.id+1}…`);try{await cut(c)}catch(e){setStatus('Export failed: '+e.message)}}setStatus('Done.');setBusy(false);setPct(0)}

  const dur=env.length,W=1000,H=70
  return <main>
    <header><h1>ClipForge</h1><p>Drop in a video. Get its best moments as ready-to-download clips. Everything runs in your browser.</p></header>
    <label className="drop" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();choose(e.dataTransfer.files[0])}}>
      <input type="file" accept="video/*" hidden onChange={e=>choose(e.target.files[0])}/>
      {file?<b>{file.name} · {(file.size/1e6).toFixed(0)} MB</b>:<b>Choose a video or drop it here</b>}<span>MP4, MOV, WebM · up to about 1 hour works best on a desktop</span>
    </label>
    <section className="opts">
      <label>Clip length<select value={len} onChange={e=>setLen(+e.target.value)}>{[15,30,45,60].map(v=><option key={v} value={v}>{v} sec</option>)}</select></label>
      <label>Number of clips<input type="number" min="1" max="30" value={count} onChange={e=>setCount(+e.target.value||1)}/></label>
      <label className="chk"><input type="checkbox" checked={vertical} onChange={e=>setVertical(e.target.checked)}/>Vertical 9:16 export</label>
      <label className="chk"><input type="checkbox" checked={fast} onChange={e=>setFast(e.target.checked)}/>Fast cut (no re-encode, 16:9 only)</label>
      <label className="chk"><input type="checkbox" checked={useAI} onChange={e=>{setUseAI(e.target.checked);lset('cf_ai',e.target.checked?'1':'0')}}/>Gemini AI titles (free tier)</label>
    </section>
    {useAI&&<section className="ai">
      <label>Gemini API key<input type="password" value={key} placeholder="Paste a free key from Google AI Studio" onChange={e=>{setKey(e.target.value);lset('cf_key',e.target.value)}}/></label>
      <label>Free-tier models, tried in order<input value={models} onChange={e=>{setModels(e.target.value);lset('cf_models',e.target.value)}}/></label>
      <small>Only clip times and loudness scores are sent to Google, never your video. Google may use free-tier data to improve its products. Your key stays in this browser.</small>
    </section>}
    <div className="bar"><button disabled={!file||busy} onClick={analyse}>{busy?'Working…':'Find clips'}</button>
      {clips.length>1&&<button className="ghost" disabled={busy} onClick={()=>dl(clips)}>Download all</button>}
      <span>{status}</span></div>
    {busy&&pct>0&&<progress value={pct}/>}
    {dur>0&&<svg className="wave" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Loudness over time with clip regions highlighted">
      {clips.map(c=><rect key={c.id} x={c.s/dur*W} width={(c.e-c.s)/dur*W} y="0" height={H} className="hit"/>)}
      <polyline points={env.map((v,i)=>`${i/dur*W},${H-Math.min(1,v*4)*H}`).join(' ')}/></svg>}
    <section className="grid">{clips.map(c=><article key={c.id}>
      <video src={`${url}#t=${c.s},${c.e}`} controls preload="metadata" onTimeUpdate={e=>{if(e.target.currentTime>=c.e)e.target.pause()}}/>
      <div><h3>{c.title||`Clip ${c.id+1}`}</h3>{c.hook&&<p>{c.hook}</p>}
        <p className="m">{fmt(c.s)}–{fmt(c.e)} · energy {c.score.toFixed(1)}</p>
        <button disabled={busy} onClick={()=>dl([c])}>Download</button></div></article>)}</section>
  </main>
}
