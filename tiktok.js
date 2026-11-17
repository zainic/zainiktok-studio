import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const URL_BASE='https://open.tiktokapis.com';
const TOKEN_URL=URL_BASE+'/v2/oauth/token/';
const DEFAULT_CHUNK=10*1024*1024;

export function tokenCrypto(key) {
  if(!/^[a-f0-9]{64}$/i.test(key||'')) return null;
  const secret=Buffer.from(key,'hex');
  return {
    encrypt(value) {
      const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',secret,iv);
      const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
      return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
    },
    decrypt(encoded) {
      const b=Buffer.from(encoded,'base64');
      const decrypt=createDecipheriv('aes-256-gcm',secret,b.subarray(0,12));
      decrypt.setAuthTag(b.subarray(12,28));
      return JSON.parse(Buffer.concat([decrypt.update(b.subarray(28)),decrypt.final()]).toString('utf8'));
    }
  };
}

async function parseResponse(response) {
  const text=await response.text();
  let json;
  try {json=JSON.parse(text);} catch{throw new Error('TikTok returned a non-JSON response (HTTP '+response.status+').');}
  if(!response.ok || (json.error && (typeof json.error==='string' || json.error.code!=='ok'))) {
    const err=typeof json.error==='string'?json.error:json.error?.code;
    throw new Error('TikTok API: '+(err||response.status)+' — '+(json.error_description||json.error?.message||'Request failed'));
  }
  return json;
}
export async function oauthToken(form) {
  const response=await fetch(TOKEN_URL,{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams(form),signal:AbortSignal.timeout(20000)
  });
  return parseResponse(response);
}

export function createTikTok({store, crypto, clientKey, clientSecret, mock=false}) {
  function saveToken(json) {
    if(!crypto) throw new Error('TOKEN_ENCRYPTION_KEY must be configured');
    const existing=store.one('SELECT token_blob FROM account WHERE id=1');
    const prior=existing?crypto.decrypt(existing.token_blob):{};
    const token={...prior,...json};
    const expires=Date.now()+(Number(json.expires_in||7200)-60)*1000;
    store.run(`INSERT INTO account(id,open_id,scopes,token_blob,expires_at) VALUES(1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET open_id=excluded.open_id,scopes=excluded.scopes,token_blob=excluded.token_blob,expires_at=excluded.expires_at`,
      token.open_id,token.scope||'',crypto.encrypt(token),expires);
    return token;
  }
  async function getToken() {
    if(mock)return 'MOCK_ONLY';
    if(!clientKey||!clientSecret||!crypto)throw new Error('TikTok client settings are missing');
    const account=store.one('SELECT * FROM account WHERE id=1');
    if(!account)throw new Error('Connect a TikTok account in Settings first');
    const tokens=crypto.decrypt(account.token_blob);
    if(account.expires_at>Date.now()+120000)return tokens.access_token;
    const updated=await oauthToken({client_key:clientKey,client_secret:clientSecret,grant_type:'refresh_token',refresh_token:tokens.refresh_token});
    return saveToken(updated).access_token;
  }
  async function post(url,json) {
    const token=await getToken();
    return parseResponse(await fetch(URL_BASE+url,{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json; charset=UTF-8'},
      body:JSON.stringify(json),signal:AbortSignal.timeout(20000)
    }));
  }
  async function creatorInfo() {
    if(mock)return {creator_username:'mock_creator',creator_nickname:'Mock account — no posts sent',privacy_level_options:['SELF_ONLY','PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS'],comment_disabled:false,duet_disabled:false,stitch_disabled:false,max_video_post_duration_sec:600};
    return (await post('/v2/post/publish/creator_info/query/',{})).data;
  }
  async function submit({video,job}) {
    if(mock)return {publish_id:'mock_'+job.id, simulated:true};
    const info=await creatorInfo();
    if(!info.privacy_level_options?.includes(job.privacy))throw new Error('Privacy option is not offered by the linked TikTok account. Update this scheduled post.');
    const fileInfo=await stat(video.filename);
    const size=fileInfo.size;
    if(size===0)throw new Error('Empty video file');
    // Match TikTok's chunk-count convention: last remainder merges into the final chunk.
    const chunkSize=size<DEFAULT_CHUNK?size:DEFAULT_CHUNK;
    const chunks=Math.max(1,Math.floor(size/chunkSize));
    const init=(await post('/v2/post/publish/video/init/',{
      post_info:{
        title:(job.caption||job.title).slice(0,2200),privacy_level:job.privacy,
        disable_duet:!!job.disable_duet||!!info.duet_disabled,
        disable_comment:!!job.disable_comment||!!info.comment_disabled,
        disable_stitch:!!job.disable_stitch||!!info.stitch_disabled,
        brand_content_toggle:!!job.brand_content,brand_organic_toggle:!!job.brand_organic,
        is_aigc:!!job.is_aigc
      },
      source_info:{source:'FILE_UPLOAD',video_size:size,chunk_size:chunkSize,total_chunk_count:chunks}
    })).data;
    if(!init?.upload_url||!init?.publish_id)throw new Error('TikTok did not provide upload details');
    const endpoint=new URL(init.upload_url);
    if(endpoint.protocol!=='https:' || !/(^|\.)tiktokapis\.com$/.test(endpoint.hostname))throw new Error('Untrusted TikTok upload endpoint');
    let offset=0;
    const type=video.mime;
    for(let i=0;i<chunks;i++) {
      const end=i===chunks-1?size-1:offset+chunkSize-1;
      const response=await fetch(init.upload_url,{
        method:'PUT',headers:{'Content-Type':type,'Content-Length':String(end-offset+1),'Content-Range':`bytes ${offset}-${end}/${size}`},
        body:createReadStream(video.filename,{start:offset,end}),duplex:'half',signal:AbortSignal.timeout(180000)
      });
      if(![201,206].includes(response.status))throw new Error('TikTok upload failed (HTTP '+response.status+')');
      await response.body?.cancel();
      offset=end+1;
    }
    return {publish_id:init.publish_id,simulated:false};
  }
  async function status(publishId) {
    if(mock)return {status:'PUBLISH_COMPLETE'};
    return (await post('/v2/post/publish/status/fetch/',{publish_id:publishId})).data;
  }
  const connected=()=>mock || !!store.one('SELECT id FROM account WHERE id=1');
  return {saveToken,getToken,post,creatorInfo,submit,status,connected};
}
