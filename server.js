import http from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, unlinkSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createStore } from './db.js';
import { createTikTok, oauthToken, tokenCrypto } from './tiktok.js';

const DIR=path.dirname(fileURLToPath(import.meta.url));
// Simple local .env reader; never override existing process environment.
const envFile=path.join(DIR,'.env');
if(existsSync(envFile)) for(const line of readFileSync(envFile,'utf8').split(/\r?\n/)) {
  const match=line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)\s*$/);
  if(match && process.env[match[1]]===undefined) process.env[match[1]]=match[2].replace(/^['"]|['"]$/g,'');
}
const cfg={
  port:Number(process.env.PORT||3000),host:process.env.HOST||(process.env.RAILWAY_PROJECT_ID?'0.0.0.0':'127.0.0.1'),
  password:process.env.APP_PASSWORD||'',
  key:process.env.TOKEN_ENCRYPTION_KEY||'',
  clientKey:process.env.TIKTOK_CLIENT_KEY||'',clientSecret:process.env.TIKTOK_CLIENT_SECRET||'',
  redirect:process.env.TIKTOK_REDIRECT_URI||'',
  mock:process.env.TIKTOK_MOCK==='true',
  downloader:process.env.ENABLE_YTDLP==='true',
  secure:process.env.SECURE_COOKIES==='true',
  maxUpload:Math.min(4096,Math.max(1,Number(process.env.MAX_UPLOAD_MB||250)))*1024*1024
};
if(!cfg.password||cfg.password==='REPLACE_WITH_LONG_RANDOM_PASSWORD'||cfg.password.length<12) {
  console.error('Set APP_PASSWORD in .env (at least 12 characters) before starting.'); process.exit(1);
}
// Keep SQLite (including its WAL files) and uploaded videos on the same persistent volume.
// On Railway, the volume mount path is supplied automatically at runtime.
// Local development still defaults to the project folder for backward compatibility.
if (process.env.RAILWAY_PROJECT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.error('Railway volume missing. Attach a persistent volume (mount path /data) before starting, or scheduled posts and videos will be lost.');
  process.exit(1);
}
const STORAGE_ROOT=path.resolve(process.env.STORAGE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || DIR);
if (process.env.RAILWAY_PROJECT_ID && process.env.STORAGE_DIR &&
    path.resolve(process.env.STORAGE_DIR) !== path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH)) {
  console.error('STORAGE_DIR must match RAILWAY_VOLUME_MOUNT_PATH on Railway to ensure persistent storage.');
  process.exit(1);
}
const DATA=path.join(STORAGE_ROOT,'data'), UPLOADS=path.join(STORAGE_ROOT,'uploads'), PUBLIC=path.join(DIR,'public');
mkdirSync(DATA,{recursive:true});mkdirSync(UPLOADS,{recursive:true});
const store=createStore(DATA), crypto=tokenCrypto(cfg.key), tiktok=createTikTok({store,crypto,clientKey:cfg.clientKey,clientSecret:cfg.clientSecret,mock:cfg.mock});
// If the process died mid-transfer, don't blindly re-upload and risk duplicate posts.
store.run("UPDATE posts SET status='failed',error='Server restarted during upload; check your TikTok account before attempting again' WHERE status='publishing'");
const sessions=new Map(),states=new Map(),loginAttempts=new Map();
const MAX_SESSION=24*60*60*1000;
const safeText=s=>String(s||'').slice(0,8000);
const send=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
const fail=(res,code,message)=>send(res,code,{error:message});
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=')).filter(x=>x.length===2));
function setSession(res) {
  const id=randomBytes(32).toString('hex');sessions.set(id,Date.now()+MAX_SESSION);
  res.setHeader('Set-Cookie',`zstudio=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${cfg.secure?'; Secure':''}`);
}
function authorized(req){const token=cookies(req).zstudio;return token && (sessions.get(token)||0)>Date.now();}
function ensureSameOrigin(req){
  const origin=req.headers.origin;
  if(!origin)return true; // Headerless CLI clients still require session auth.
  try {const o=new URL(origin);const h=req.headers.host;return o.host===h && ['http:','https:'].includes(o.protocol);}catch{return false;}
}
async function jsonBody(req,max=35000){let body='',length=0;for await(const part of req){length+=part.length;if(length>max)throw new Error('Request body too large');body+=part.toString('utf8')}return JSON.parse(body||'{}');}
function redirect(res,to){res.writeHead(302,{Location:to,'Cache-Control':'no-store'});res.end();}
function serve(res,file){
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
  if(!existsSync(file)){fail(res,404,'Not found');return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});
  createReadStream(file).pipe(res);
}
function getPublicPosts(){return store.q(`SELECT p.*,v.name as video_name FROM posts p LEFT JOIN videos v ON v.id=p.video_id ORDER BY p.created_at DESC LIMIT 300`).map(p=>({...p,consent:undefined}));}
function getMedia(){return store.q('SELECT id,name,mime,size,source,source_url,created_at FROM videos ORDER BY created_at DESC LIMIT 300');}
async function acceptVideo(req){
  const mime=(req.headers['content-type']||'').split(';')[0];
  const allowed=['video/mp4','video/quicktime','video/webm'];
  if(!allowed.includes(mime))throw Object.assign(new Error('Upload an MP4, MOV, or WebM video'),{status:415});
  const requestedName=decodeURIComponent(req.headers['x-filename']||'video.mp4');
  const name=path.basename(requestedName.replace(/[\\/]/g,'_')).slice(0,130)||'video.mp4';
  const id=randomUUID(),filename=path.join(UPLOADS,id+({"video/mp4":'.mp4','video/quicktime':'.mov','video/webm':'.webm'}[mime]));
  let length=0, head=Buffer.alloc(0);
  try{
    const out=createWriteStream(filename,{flags:'wx',mode:0o600});
    for await(const part of req){
      length+=part.length;
      if(length>cfg.maxUpload)throw Object.assign(new Error('Video exceeds configured upload limit'),{status:413});
      if(head.length<16)head=Buffer.concat([head,part.subarray(0,16-head.length)]);
      if(!out.write(part))await new Promise((resolve,reject)=>{out.once('drain',resolve);out.once('error',reject)});
    }
    await new Promise((resolve,reject)=>out.end(err=>err?reject(err):resolve()));
    if(length<16)throw new Error('Video file is too small');
    const likelyMp4=head.toString('ascii',4,8)==='ftyp';
    const likelyWebm=head.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
    if((mime==='video/webm'?!likelyWebm:!likelyMp4))throw new Error('File header does not match the selected video format');
    store.run('INSERT INTO videos(id,name,filename,mime,size,source,created_at) VALUES(?,?,?,?,?,?,?)',id,name,filename,mime,length,'upload',Date.now());
    return {id,name,mime,size:length,source:'upload'};
  }catch(e){await unlink(filename).catch(()=>{});throw e;}
}
function validateLink(raw){
  let url;try{url=new URL(raw)}catch{throw new Error('Enter a valid TikTok URL')}
  if(url.protocol!=='https:' || !['tiktok.com','www.tiktok.com','vm.tiktok.com','vt.tiktok.com','m.tiktok.com'].includes(url.hostname.toLowerCase()))throw new Error('Only HTTPS links from tiktok.com are accepted');
  if(url.pathname.length<3)throw new Error('TikTok URL is missing its video path');
  return url.toString();
}
function downloadWithYtDlp(url,id){
  return new Promise((resolve,reject)=>{
    const template=path.join(UPLOADS,'download-'+id+'.%(ext)s');
    const args=['--no-config','--no-playlist','--no-progress','--no-warnings','--restrict-filenames','--max-filesize',String(cfg.maxUpload),'--socket-timeout','20','--retries','2','-f','best','--output',template,'--print','after_move:filepath',url];
    const child=spawn('yt-dlp',args,{stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONWARNINGS:'ignore'}});
    let stdout='',stderr=''; const timeout=setTimeout(()=>child.kill('SIGKILL'),180000);
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(-10000)});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-2000)});
    child.on('error',e=>{clearTimeout(timeout);reject(new Error('yt-dlp is not installed on the server: '+e.message))});
    child.on('close',code=>{
      clearTimeout(timeout);
      if(code!==0)return reject(new Error('Download failed: '+(stderr.split('\n').filter(Boolean).pop()||'Extractor unavailable')));
      const output=stdout.trim().split('\n').pop();
      if(!output||!path.resolve(output).startsWith(UPLOADS+path.sep))return reject(new Error('Unexpected output file path'));
      resolve(output);
    });
  });
}
async function runScheduled(){
  if(!tiktok.connected())return;
  const due=store.q(`SELECT * FROM posts WHERE status IN ('scheduled','waiting_account') AND scheduled_at<=? ORDER BY scheduled_at LIMIT 3`,Date.now());
  for(const post of due){
    if(!store.run(`UPDATE posts SET status='publishing',error=NULL WHERE id=? AND status IN ('scheduled','waiting_account')`,post.id).changes)continue;
    try {
      if(!post.consent)throw new Error('Explicit TikTok publishing consent was not saved');
      const video=store.one('SELECT * FROM videos WHERE id=?',post.video_id);
      if(!video||!existsSync(video.filename))throw new Error('Media file missing on server');
      const result=await tiktok.submit({video,job:post});
      store.run('UPDATE posts SET status=?,publish_id=?,last_status_at=? WHERE id=?',result.simulated?'published':'processing',result.publish_id,Date.now(),post.id);
    }catch(e){store.run('UPDATE posts SET status=?,error=? WHERE id=?',String(e.message).includes('Connect a TikTok account')?'waiting_account':'failed',safeText(e.message),post.id);}
  }
  const processing=store.q(`SELECT * FROM posts WHERE status='processing' AND (last_status_at IS NULL OR last_status_at<=?) ORDER BY last_status_at LIMIT 3`,Date.now()-60000);
  for(const job of processing){
    try {
      const result=await tiktok.status(job.publish_id), code=result.status;
      store.run('UPDATE posts SET status=?,error=?,last_status_at=? WHERE id=?',code==='PUBLISH_COMPLETE'?'published':code==='FAILED'?'failed':'processing',code==='FAILED'?safeText(result.fail_reason||'TikTok reported failure'):null,Date.now(),job.id);
    }catch(e){store.run('UPDATE posts SET error=?,last_status_at=? WHERE id=?',safeText(e.message),Date.now(),job.id);}
  }
}
let workerBusy=false;
async function worker(){if(workerBusy)return;workerBusy=true;try{await runScheduled();}finally{workerBusy=false;}}
setInterval(()=>worker().catch(e=>console.error('Queue tick:',e.message)),15000).unref();

async function handler(req,res){
  const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`),p=url.pathname;
  // Add no-store and clickjacking mitigation on every endpoint.
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  if(p==='/api/health')return send(res,200,{status:'ok',service:'Zainiktok Studio'});
  if((p==='/terms'||p==='/terms.html') && req.method==='GET')return serve(res,path.join(PUBLIC,'terms.html'));
  if((p==='/privacy'||p==='/privacy.html') && req.method==='GET')return serve(res,path.join(PUBLIC,'privacy.html'));
  if(p==='/login' && req.method==='GET')return serve(res,path.join(PUBLIC,'login.html'));
  if(p==='/login.js' && req.method==='GET')return serve(res,path.join(PUBLIC,'login.js'));
  if(p==='/api/login' && req.method==='POST'){
    const ip=req.socket.remoteAddress||'unknown',attempt=loginAttempts.get(ip)||{count:0,until:0};
    if(attempt.count>=7 && attempt.until>Date.now())return fail(res,429,'Too many attempts. Try again in 10 minutes.');
    const {password}=await jsonBody(req,3000);
    const a=Buffer.from(String(password||'')),b=Buffer.from(cfg.password);
    if(a.length!==b.length||!timingSafeEqual(a,b)){
      loginAttempts.set(ip,{count:attempt.until>Date.now()?attempt.count+1:1,until:Date.now()+600000});
      return fail(res,401,'Incorrect password');
    }
    loginAttempts.delete(ip);setSession(res);return send(res,200,{ok:true});
  }
  if(p==='/auth/tiktok/callback' && req.method==='GET'){
    const state=url.searchParams.get('state')||'',attempt=states.get(state);states.delete(state);
    if(!attempt||attempt<Date.now())return fail(res,400,'OAuth state expired or invalid');
    if(url.searchParams.get('error'))return fail(res,400,'TikTok authorization declined: '+safeText(url.searchParams.get('error')));
    const code=url.searchParams.get('code');if(!code)return fail(res,400,'Missing TikTok authorization code');
    const token=await oauthToken({client_key:cfg.clientKey,client_secret:cfg.clientSecret,code,grant_type:'authorization_code',redirect_uri:cfg.redirect});
    tiktok.saveToken(token);setSession(res);return redirect(res,'/?connected=1');
  }
  if(p.startsWith('/assets/')&&req.method==='GET'){
    const file=path.resolve(PUBLIC,'.'+p);
    if(!file.startsWith(path.join(PUBLIC,'assets')+path.sep))return fail(res,403,'Forbidden');
    return serve(res,file);
  }
  if(!authorized(req)){
    if(p.startsWith('/api/'))return fail(res,401,'Login required');
    return redirect(res,'/login');
  }
  if(['POST','PUT','PATCH','DELETE'].includes(req.method) && !ensureSameOrigin(req))return fail(res,403,'Invalid request origin');
  if(p==='/'&&req.method==='GET')return serve(res,path.join(PUBLIC,'index.html'));
  if(p==='/app.js'&&req.method==='GET')return serve(res,path.join(PUBLIC,'app.js'));
  if(p==='/api/session'&&req.method==='GET')return send(res,200,{authenticated:true});
  if(p==='/api/logout'&&req.method==='POST'){
    sessions.delete(cookies(req).zstudio);
    res.setHeader('Set-Cookie','zstudio=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax');
    return send(res,200,{ok:true});
  }
  if(p==='/api/state'&&req.method==='GET'){
    const account=store.one('SELECT open_id,scopes FROM account WHERE id=1');
    return send(res,200,{posts:getPublicPosts(),videos:getMedia(),timezone:store.getSetting('timezone','Asia/Jakarta'),account:{connected:tiktok.connected(),mock:cfg.mock,configured:!!(cfg.clientKey&&cfg.clientSecret&&crypto&&cfg.redirect),scopes:account?.scopes||'',open_id:account?.open_id||null},downloaderEnabled:cfg.downloader});
  }
  if(p==='/api/preferences'&&req.method==='POST'){
    const {timezone}=await jsonBody(req);
    const allowed=['Asia/Jakarta','Asia/Makassar','Asia/Jayapura','UTC'];
    if(!allowed.includes(timezone))return fail(res,400,'Unsupported timezone');
    store.setSetting('timezone',timezone);return send(res,200,{timezone});
  }
  if(p==='/api/videos'&&req.method==='POST')return send(res,201,await acceptVideo(req));
  if(p==='/api/videos'&&req.method==='GET')return send(res,200,getMedia());
  if(p.startsWith('/api/videos/') && req.method==='GET'){
    const id=p.split('/')[3];const v=store.one('SELECT * FROM videos WHERE id=?',id);
    if(!v||!existsSync(v.filename))return fail(res,404,'Video not found');
    res.writeHead(200,{'Content-Type':v.mime,'Content-Length':v.size,'Content-Disposition':`attachment; filename="${v.name.replace(/[^a-z0-9._-]/gi,'_')}"`,'X-Content-Type-Options':'nosniff'});
    return createReadStream(v.filename).pipe(res);
  }
  if(p.startsWith('/api/videos/') && req.method==='DELETE'){
    const id=p.split('/')[3],v=store.one('SELECT * FROM videos WHERE id=?',id);
    if(!v)return fail(res,404,'Not found');
    if(store.one('SELECT id FROM posts WHERE video_id=? LIMIT 1',id))return fail(res,409,'Remove associated posts first');
    store.run('DELETE FROM videos WHERE id=?',id);await unlink(v.filename).catch(()=>{});return send(res,200,{ok:true});
  }
  if(p==='/api/posts'&&req.method==='GET')return send(res,200,getPublicPosts());
  if(p==='/api/posts'&&req.method==='POST'){
    const j=await jsonBody(req), video=store.one('SELECT id FROM videos WHERE id=?',j.videoId);
    if(!video)return fail(res,400,'Please choose or upload a video first');
    if(!j.consent)return fail(res,400,'You must explicitly consent to scheduled TikTok publishing');
    const date=Date.parse(j.scheduledAt);
    if(!Number.isFinite(date)||date<Date.now()+10000)return fail(res,400,'Set a future scheduled date and time');
    if(!['PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR','SELF_ONLY'].includes(j.privacy))return fail(res,400,'Invalid privacy selection');
    const title=safeText(j.title).trim().slice(0,120),caption=safeText(j.caption).slice(0,2200);
    if(!title)return fail(res,400,'Video title required');
    const id=randomUUID(),status=tiktok.connected()?'scheduled':'waiting_account';
    store.run(`INSERT INTO posts(id,video_id,title,caption,scheduled_at,privacy,disable_comment,disable_duet,disable_stitch,brand_content,brand_organic,is_aigc,consent,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,video.id,title,caption,date,j.privacy,Number(!!j.disableComment),Number(!!j.disableDuet),Number(!!j.disableStitch),Number(!!j.brandContent),Number(!!j.brandOrganic),Number(!!j.isAigc),1,status,Date.now());
    return send(res,201,{id,status});
  }
  if(p.startsWith('/api/posts/') && req.method==='DELETE'){
    const id=p.split('/')[3],job=store.one('SELECT * FROM posts WHERE id=?',id);
    if(!job)return fail(res,404,'Not found');
    if(['publishing','processing'].includes(job.status))return fail(res,409,'Cannot cancel a post already transferred to TikTok');
    store.run('DELETE FROM posts WHERE id=?',id);return send(res,200,{ok:true});
  }
  if(p==='/api/tiktok/creator-info'&&req.method==='GET'){
    if(!tiktok.connected())return fail(res,409,'Connect TikTok in Settings to retrieve creator options');
    return send(res,200,await tiktok.creatorInfo());
  }
  if(p==='/auth/tiktok/start'&&req.method==='GET'){
    if(!cfg.clientKey||!cfg.clientSecret||!cfg.redirect||!crypto)return fail(res,409,'Configure TikTok client key, client secret, redirect URI, and token encryption key in .env');
    const state=randomBytes(24).toString('hex');states.set(state,Date.now()+600000);
    const u=new URL('https://www.tiktok.com/v2/auth/authorize/');
    u.search=new URLSearchParams({client_key:cfg.clientKey,scope:'user.info.basic,video.publish',response_type:'code',redirect_uri:cfg.redirect,state}).toString();
    return redirect(res,u.toString());
  }
  if(p==='/api/tiktok/disconnect'&&req.method==='POST'){
    store.run('DELETE FROM account WHERE id=1');return send(res,200,{ok:true});
  }
  if(p==='/api/downloads'&&req.method==='POST'){
    if(!cfg.downloader)return fail(res,409,'Downloader disabled. Install yt-dlp and set ENABLE_YTDLP=true');
    const j=await jsonBody(req);if(!j.permission)return fail(res,400,'Confirm you own or have permission to save the video');
    const link=validateLink(j.url),id=randomUUID();let filename;
    try {
      filename=await downloadWithYtDlp(link,id);
      const info=await stat(filename);
      if(info.size>cfg.maxUpload||info.size<16)throw new Error('Downloaded file size is invalid');
      const ext=path.extname(filename).toLowerCase(),mime=({'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm'})[ext];
      if(!mime)throw new Error('Unsupported downloaded video format');
      store.run('INSERT INTO videos(id,name,filename,mime,size,source,source_url,created_at) VALUES(?,?,?,?,?,?,?,?)',id,'TikTok video '+id.slice(0,8)+ext,filename,mime,info.size,'download',link,Date.now());
      return send(res,201,{id,name:'TikTok video '+id.slice(0,8)+ext,size:info.size,source:'download'});
    }catch(e){for(const f of readdirSync(UPLOADS).filter(f=>f.startsWith('download-'+id+'.')))await unlink(path.join(UPLOADS,f)).catch(()=>{});throw e;}
  }
  return fail(res,404,'Endpoint not found');
}
const server=http.createServer((req,res)=>handler(req,res).catch(e=>{
  console.error('Request error:',e.message);
  if(!res.headersSent)fail(res,e.status||500,e.status?e.message:safeText(e.message));else res.destroy();
}));
server.listen(cfg.port,cfg.host,()=>{
  console.log(`Zainiktok Studio running at http://${cfg.host}:${cfg.port}`);
  console.log(`TikTok: ${cfg.mock?'MOCK MODE — no publishing':tiktok.connected()?'Connected':'Not connected'}; Downloader: ${cfg.downloader?'enabled':'disabled'}`);
  worker().catch(e=>console.error('Queue startup:',e.message));
});
