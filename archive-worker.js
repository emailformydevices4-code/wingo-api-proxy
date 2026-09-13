const fs=require('fs'),crypto=require('crypto'),zlib=require('zlib');

const SB=(process.env.SUPABASE_URL||'https://owouneyvnmcffppiphlu.supabase.co').replace(/\/$/,'');
const SB_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_ANON_KEY||'';
const DRIVE_FOLDER_ID=process.env.GOOGLE_DRIVE_FOLDER_ID||'';
const ARCHIVE_AFTER_HOURS=Number(process.env.ARCHIVE_AFTER_HOURS||48);
const ARCHIVE_DELETE=String(process.env.ARCHIVE_DELETE||'false').toLowerCase()==='true';
const PAGE_SIZE=Number(process.env.ARCHIVE_PAGE_SIZE||1000);

const TABLES={
  wingo_results:{time:'observed_at',order:'issue_number.asc',file:'wingo_results'},
  wingo_research_mod_ledger:{time:'observed_at',order:'issue_number.asc,family.asc,mod.asc',file:'wingo_research_mod_ledger'},
  collection_events:{time:'event_at',order:'id.asc',file:'collection_events'},
  collection_gaps:{time:'detected_at',order:'id.asc',file:'collection_gaps'},
  wingo_three_engine_ledger:{time:'created_at',order:'target_issue.asc',file:'wingo_three_engine_ledger'},
  wingo_fusion_outcomes:{time:'created_at',order:'target_issue.asc',file:'wingo_fusion_outcomes'},
  wingo_predictions:{time:'created_at',order:'target_issue.asc',file:'wingo_predictions'},
  wingo_prediction_outcomes:{time:'created_at',order:'target_issue.asc',file:'wingo_prediction_outcomes'},
  wingo_pattern_events:{time:'observed_at',order:'issue_number.asc',file:'wingo_pattern_events'},
  wingo_reverse_analysis:{time:'generated_at',order:'target_issue.asc',file:'wingo_reverse_analysis'}
};

function b64url(x){return Buffer.from(x).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');}
function isoDay(d){return d.toISOString().slice(0,10);}
function dayBounds(day){const start=new Date(day+'T00:00:00.000Z');const end=new Date(start);end.setUTCDate(end.getUTCDate()+1);return [start.toISOString(),end.toISOString()];}
function driveCreds(){
  if(process.env.GOOGLE_SERVICE_ACCOUNT_JSON){return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);}
  return {client_email:process.env.GOOGLE_CLIENT_EMAIL,private_key:(process.env.GOOGLE_PRIVATE_KEY||'').replace(/\\n/g,'\n')};
}
async function driveToken(){
  const c=driveCreds();
  if(!c.client_email||!c.private_key)throw Error('Google Drive credentials are not configured');
  const now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claim=b64url(JSON.stringify({iss:c.client_email,scope:'https://www.googleapis.com/auth/drive.file',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const signer=crypto.createSign('RSA-SHA256');signer.update(header+'.'+claim);signer.end();
  const assertion=header+'.'+claim+'.'+b64url(signer.sign(c.private_key));
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
  const j=await r.json();if(!r.ok)throw Error('Google token HTTP '+r.status+': '+JSON.stringify(j).slice(0,500));return j.access_token;
}
async function sbGet(table,params){
  const u=new URL(SB+'/rest/v1/'+table);u.searchParams.set('select','*');for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);
  const r=await fetch(u,{headers:{apikey:SB_KEY,Authorization:'Bearer '+SB_KEY,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error(table+' HTTP '+r.status+': '+(await r.text()).slice(0,500));return r.json();
}
async function sbPost(table,row){
  const r=await fetch(SB+'/rest/v1/'+table,{method:'POST',headers:{apikey:SB_KEY,Authorization:'Bearer '+SB_KEY,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(row)});
  if(!r.ok)throw Error(table+' POST HTTP '+r.status+': '+(await r.text()).slice(0,500));
}
async function uploadDrive(token,fileName,data){
  const meta={name:fileName,parents:[DRIVE_FOLDER_ID],mimeType:'application/gzip'};
  const boundary='wingo_'+crypto.randomBytes(12).toString('hex');
  const head=Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(meta)+'\r\n--'+boundary+'\r\nContent-Type: application/gzip\r\n\r\n');
  const tail=Buffer.from('\r\n--'+boundary+'--\r\n');
  const body=Buffer.concat([head,data,tail]);
  const r=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'multipart/related; boundary='+boundary},body});
  const j=await r.json();if(!r.ok)throw Error('Drive upload HTTP '+r.status+': '+JSON.stringify(j).slice(0,500));return j;
}
async function exportDay(table,cfg,day){
  const [gte,lt]=dayBounds(day);let offset=0,total=0;const chunks=[];
  while(true){
    const params={};params[cfg.time]='gte.'+gte;params[cfg.time+'_lt']='lt.'+lt;params.order=cfg.order;params.limit=String(PAGE_SIZE);params.offset=String(offset);
    const rows=await sbGet(table,params);if(!rows.length)break;
    for(const row of rows)chunks.push(Buffer.from(JSON.stringify(row)+'\n'));
    total+=rows.length;offset+=rows.length;if(rows.length<PAGE_SIZE)break;
  }
  if(!total)return null;
  const raw=Buffer.concat(chunks);const gz=zlib.gzipSync(raw,{level:9});const sha=crypto.createHash('sha256').update(gz).digest('hex');
  return {total,gz,sha,first:chunks.length?JSON.parse(chunks[0].toString()).issue_number||null:null};
}
async function main(){
  if(!SB_KEY)throw Error('SUPABASE_SERVICE_ROLE_KEY is required');
  if(!DRIVE_FOLDER_ID)throw Error('GOOGLE_DRIVE_FOLDER_ID is required');
  const cutoff=new Date(Date.now()-ARCHIVE_AFTER_HOURS*3600*1000);
  const day=new Date(cutoff);day.setUTCHours(0,0,0,0);day.setUTCDate(day.getUTCDate()-1);
  const dayStr=isoDay(day);
  console.log('[ARCHIVE] eligible closed day:',dayStr,'cutoff:',cutoff.toISOString(),'delete:',ARCHIVE_DELETE);
  const token=await driveToken();
  for(const [table,cfg] of Object.entries(TABLES)){
    try{
      const out=await exportDay(table,cfg,dayStr);if(!out){console.log('[ARCHIVE] no rows',table);continue;}
      const fileName=dayStr+'_'+cfg.file+'.ndjson.gz';
      await sbPost('wingo_archive_batches',{table_name:table,range_start_issue:out.first,range_end_issue:null,source_row_count:out.total,archive_format:'ndjson.gz',object_name:fileName,sha256:out.sha,status:'exported',exported_at:new Date().toISOString()});
      const drive=await uploadDrive(token,fileName,out.gz);
      await sbPost('wingo_archive_batches',{table_name:table,range_start_issue:out.first,range_end_issue:null,source_row_count:out.total,archive_format:'ndjson.gz',object_name:fileName,object_uri:'gdrive://'+drive.id,sha256:out.sha,status:'verified',uploaded_at:new Date().toISOString(),verified_at:new Date().toISOString()});
      console.log('[ARCHIVE] uploaded',table,out.total,'rows',fileName,drive.id,out.sha);
      // Deletion is intentionally not implemented in this first worker version.
      // A separate verified-retention migration will be added only after archive restore testing.
    }catch(e){console.error('[ARCHIVE] FAILED',table,e.message);}
  }
}
main().catch(e=>{console.error('[ARCHIVE] FATAL',e);process.exit(1);});
