const http=require('http'),fs=require('fs');
const PORT=Number(process.env.PORT||10000);
const LIVE='https://wingo-api-proxy.onrender.com';
const RESEARCH='https://wingo-research-server.onrender.com';
const html=fs.readFileSync('public/forensic-console.html');
const json=(res,s,o)=>{res.writeHead(s,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});res.end(JSON.stringify(o));};
async function get(base,path,ms=8000){
 const r=await fetch(base+path,{cache:'no-store',signal:AbortSignal.timeout(ms)});
 if(!r.ok)throw Error(base+path+' HTTP '+r.status);
 return r.json();
}
async function optional(path){try{return await get(RESEARCH,path,5000)}catch(e){return{ok:false,error:e.message}}}
http.createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 try{
  if(pathname==='/'||pathname==='/index.html'){
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
   return res.end(html);
  }
  if(pathname==='/health')return json(res,200,{ok:true,service:'wingo-forensic-console-final',serverAt:new Date().toISOString()});
  if(pathname==='/api/forensic'){
   let live=null,live_error=null;
   try{live=await get(LIVE,'/api/wingo/live',12000)}catch(e){live_error=e.message}
   const [health,upstream,cur,research,hist,gaps]=await Promise.all([
    optionalLive('/api/health'),
    optionalLive('/api/upstream-diagnostic'),
    optional('/api/current'),optional('/api/research'),optional('/api/history?limit=100'),optional('/api/gaps')
   ]);
   return json(res,200,{ok:true,live,live_error,live_diagnostics:{health,upstream},research_api:{current:cur,research,history:hist,gaps},serverAt:new Date().toISOString()});
  }
  return json(res,404,{ok:false,error:'Not found',path:pathname});
 }catch(e){
  console.error('[FORENSIC]',e);
  return json(res,500,{ok:false,error:e.message});
 }
}).listen(PORT,'0.0.0.0',()=>console.log('Isolated forensic gateway listening on '+PORT));