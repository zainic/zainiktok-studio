(() => {
  'use strict';
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  let state={posts:[],videos:[],timezone:'Asia/Jakarta',account:{connected:false,configured:false,mock:false},downloaderEnabled:false};
  let filter='All', selectedVideo='';
  const names={overview:'Overview',scheduler:'Content Scheduler',downloads:'Video Downloader',media:'Media Library',analytics:'Analytics',settings:'Settings'};
  const labels={scheduled:'Scheduled',waiting_account:'Needs connection',publishing:'Uploading',processing:'Processing',published:'Published',failed:'Failed'};
  const statusClass={scheduled:'',waiting_account:'waiting',publishing:'processing',processing:'processing',published:'published',failed:'failed'};
  const get=(key,el=document)=>el.querySelector(key);
  const fmt=n=>new Intl.DateTimeFormat('en-US',{timeZone:state.timezone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(n));
  function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e}
  function showPage(page){
    $$('[data-page]').forEach(e=>e.classList.toggle('active',e.dataset.page===page));
    $$('.screen').forEach(e=>e.classList.toggle('active',e.id==='screen-'+page));
    $('#breadcrumb').textContent=names[page]||page;
    $('#mobile-nav').value=page;
    window.scrollTo({top:0,behavior:'smooth'});
    if(page==='settings')updateAccount();
  }
  $$('[data-page]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));
  $$('[data-goto]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.goto)));
  $('#mobile-nav').addEventListener('change',e=>showPage(e.target.value));
  let toastTimer;
  function toast(message){const t=$('#toast');t.textContent=message;t.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('visible'),5100)}
  async function api(url,{method='GET',body,headers={}}={}){
    const response=await fetch(url,{method,headers:body!==undefined?{'Content-Type':'application/json',...headers}:headers,body:body!==undefined?JSON.stringify(body):undefined});
    if(response.status===401){window.location='/login';throw new Error('Session expired')}
    const data=await response.json().catch(()=>({error:'Unexpected response from server'}));
    if(!response.ok)throw new Error(data.error||`Request failed (HTTP ${response.status})`);
    return data;
  }
  async function refresh(){
    state=await api('/api/state');
    $('#timezone').value=state.timezone;
    render();
  }
  function render(){
    const posts=state.posts,upcoming=posts.filter(p=>['scheduled','waiting_account'].includes(p.status));
    $('#metric-scheduled').textContent=String(upcoming.length).padStart(2,'0');
    $('#metric-published').textContent=String(posts.filter(p=>p.status==='published').length).padStart(2,'0');
    $('#metric-videos').textContent=String(state.videos.length).padStart(2,'0');
    $('#metric-processing').textContent=String(posts.filter(p=>['processing','publishing'].includes(p.status)).length).padStart(2,'0');
    $('#queue-count').textContent=posts.length+' total posts';
    $('#currentDate').textContent=new Intl.DateTimeFormat('en-US',{timeZone:state.timezone,day:'numeric',month:'short',year:'numeric'}).format(new Date());
    $('#downloader-mode').textContent=state.downloaderEnabled?'Downloader enabled · permitted public videos only':'Downloader is disabled. Install yt-dlp and set ENABLE_YTDLP=true to enable it.';
    const status=state.account.mock?'Mock mode — NO real TikTok posts':state.account.connected?'TikTok connected — scheduled worker active':'TikTok not connected — jobs will wait';
    $('#system-status').textContent=status;
    const q=$('#queue-overview');q.replaceChildren();
    upcoming.sort((a,b)=>a.scheduled_at-b.scheduled_at).slice(0,4).forEach(p=>{
      const row=el('div',undefined,'queue-row'),thumb=el('div',undefined,'thumb c2'),detail=el('div',undefined,'queue-detail');thumb.append(el('span','▶'));
      detail.append(el('strong',p.title),el('small',fmt(p.scheduled_at)));
      row.append(thumb,detail,el('span',labels[p.status],'state '+statusClass[p.status]));q.append(row);
    });
    if(!q.children.length)q.append(el('p','No upcoming posts yet. Schedule your first upload.','demo-note'));
    const body=$('#schedule-tbody');body.replaceChildren();
    posts.filter(p=>filter==='All'||(filter==='Scheduled'?['scheduled','waiting_account'].includes(p.status):filter==='Processing'?['processing','publishing'].includes(p.status):p.status===filter.toLowerCase())).forEach(p=>{
      const tr=el('tr');const td1=el('td'), box=el('div',undefined,'table-title'), thumb=el('div',undefined,'thumb tiny-thumb c2'),desc=el('div');thumb.append(el('span','▶'));
      desc.append(el('strong',p.title),el('small',p.video_name+' · '+(p.caption||'No caption')));box.append(thumb,desc);td1.append(box);
      const date=el('td',fmt(p.scheduled_at)),account=el('td',state.account.mock?'Mock account':state.account.connected?'TikTok account':'Not connected'),cellStatus=el('td'),cellActions=el('td');
      const badge=el('span',labels[p.status]||p.status,'state '+statusClass[p.status]);badge.title=p.error||p.publish_id||'';cellStatus.append(badge);
      if(p.error)cellStatus.append(el('small',p.error,'error-text'));
      const del=el('button','Remove','delete');del.type='button';del.disabled=['processing','publishing'].includes(p.status);del.addEventListener('click',async()=>{
        if(!confirm('Remove this post from the queue?'))return;
        try{await api('/api/posts/'+p.id,{method:'DELETE'});await refresh();toast('Post removed')}catch(e){toast(e.message)}
      });cellActions.append(del);tr.append(td1,date,account,cellStatus,cellActions);body.append(tr);
    });
    if(!body.children.length){const tr=el('tr'),td=el('td','No posts in this view.','empty');td.colSpan=5;tr.append(td);body.append(tr)}
    const grid=$('#media-grid');grid.replaceChildren();
    state.videos.forEach((v,i)=>{
      const card=el('div',undefined,'media-card'),art=el('div',undefined,'media-art c'+(i%6+1)),info=el('div',undefined,'media-info');
      art.append(el('div','▶','play'),el('span',(v.size/1024/1024).toFixed(1)+' MB','duration'));
      info.append(el('strong',v.name),el('p',v.source==='download'?'Downloaded permitted TikTok link':'Uploaded to server'));
      const schedule=el('button','Schedule this video','btn btn-dark');schedule.addEventListener('click',()=>openModal(v.id));
      const down=el('a','Save file','tiny-link');down.href='/api/videos/'+v.id;down.style.margin='9px';
      const remove=el('button','Delete','tiny-link');remove.type='button';remove.style.background='transparent';remove.style.border='0';remove.style.cursor='pointer';remove.style.color='#ff7996';
      remove.addEventListener('click',async()=>{if(!confirm('Permanently remove this video from the server?'))return;try{await api('/api/videos/'+v.id,{method:'DELETE'});await refresh();toast('Video deleted')}catch(e){toast(e.message)}});
      info.append(schedule,down,remove);card.append(art,info);grid.append(card);
    });
    if(!state.videos.length)grid.append(el('p','No video files yet. Use New upload or the downloader to add media.','demo-note'));
    const select=$('#existing-video'),keep=selectedVideo||select.value;select.replaceChildren();
    select.append(new Option('Choose uploaded media…',''));
    state.videos.forEach(v=>select.append(new Option(v.name,v.id)));
    if(state.videos.some(v=>v.id===keep))select.value=keep;
    updateAccount();
  }
  function updateAccount(){
    const account=state.account;
    $('#account-status').textContent=account.mock?'MOCK / TEST':account.connected?'Connected':'Not connected';
    $('#posting-status').textContent=account.mock?'Mock only':account.connected?'Authorized':'Setup needed';
    $('#account-name').textContent=account.mock?'Simulated TikTok account':account.connected?'Authorized TikTok profile':'Connect a TikTok profile';
    $('#account-description').textContent=account.mock?'Mock mode is enabled on the server: no videos are sent to TikTok.':account.connected?`Connected. Granted scopes: ${account.scopes || 'unknown'}`:'Use official OAuth to authorize publishing. App review may be required.';
    const b=$('#connect-demo');b.textContent=account.mock?'Mock mode enabled':account.connected?'Reconnect account':'Connect with TikTok';
    b.disabled=account.mock;
    $('#disconnect-btn').style.display=account.connected&&!account.mock?'inline-flex':'none';
    $('#connect-extra').textContent=account.configured?'':' Configure TikTok credentials in .env first.';
  }
  $$('[data-open-schedule]').forEach(b=>b.addEventListener('click',()=>openModal()));
  $$('[data-close-modal]').forEach(b=>b.addEventListener('click',closeModal));
  $('#schedule-overlay').addEventListener('click',e=>{if(e.target.id==='schedule-overlay')closeModal()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
  $('#post-file').addEventListener('change',e=>{$('#file-label').textContent=e.target.files?.[0]?.name||'＋ Choose MP4 or MOV'});
  function zonedParts(time,tz){
    const pieces=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(time);
    return Object.fromEntries(pieces.filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  }
  function zonedToISO(date,time,tz){
    const [y,m,d]=date.split('-').map(Number),[h,min]=time.split(':').map(Number);
    const target=Date.UTC(y,m-1,d,h,min),wanted=[y,m,d,h,min];let stamp=target;
    for(let i=0;i<4;i++){
      const p=zonedParts(stamp,tz);
      const guess=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);
      stamp+=target-guess;
    }
    const p=zonedParts(stamp,tz);
    if([p.year,p.month,p.day,p.hour,p.minute].some((v,i)=>v!==wanted[i]))throw new Error('This date/time does not exist in your selected timezone');
    return new Date(stamp).toISOString();
  }
  async function openModal(videoId=''){
    selectedVideo=videoId;
    $('#schedule-form').reset();$('#file-label').textContent='＋ Choose MP4 or MOV';$('#existing-video').value=videoId;
    const tomorrow=zonedParts(Date.now()+24*60*60*1000,state.timezone),today=zonedParts(Date.now(),state.timezone);
    const day=p=>[p.year,String(p.month).padStart(2,'0'),String(p.day).padStart(2,'0')].join('-');
    $('#post-date').value=day(tomorrow);$('#post-date').min=day(today);$('#post-time').value='18:00';
    const v=state.videos.find(x=>x.id===videoId);$('#post-title').value=v?.name.replace(/\.[^.]+$/,'')||'';
    $('#post-privacy').replaceChildren(new Option('Only me (private)','SELF_ONLY'));
    $('#privacy-note').textContent='Checking TikTok account settings…';
    $('#schedule-overlay').classList.add('visible');
    if(state.account.connected)try{
      const creator=await api('/api/tiktok/creator-info');
      const readable={SELF_ONLY:'Only me',PUBLIC_TO_EVERYONE:'Everyone',MUTUAL_FOLLOW_FRIENDS:'Mutual friends',FOLLOWER_OF_CREATOR:'Followers'};
      $('#post-privacy').replaceChildren(...creator.privacy_level_options.map(x=>new Option(readable[x]||x,x)));
      if(creator.privacy_level_options.includes('SELF_ONLY'))$('#post-privacy').value='SELF_ONLY';
      $('#privacy-note').textContent='Posting as @'+creator.creator_username+' · Privacy options supplied by TikTok.';
      $('#post-comments').disabled=creator.comment_disabled;
      $('#post-duets').disabled=creator.duet_disabled;
      $('#post-stitches').disabled=creator.stitch_disabled;
      $('#post-comments').checked=!!creator.comment_disabled;
      $('#post-duets').checked=!!creator.duet_disabled;
      $('#post-stitches').checked=!!creator.stitch_disabled;
    }catch(e){$('#privacy-note').textContent=e.message;toast(e.message)}
    else $('#privacy-note').textContent='No TikTok account connected. Your post will wait for authorization.';
  }
  function closeModal(){$('#schedule-overlay').classList.remove('visible')}
  $('#schedule-form').addEventListener('submit',async e=>{
    e.preventDefault();const btn=e.currentTarget.querySelector('[type=submit]');
    btn.disabled=true;btn.textContent='Saving to server…';
    try{
      const date=zonedToISO($('#post-date').value,$('#post-time').value,state.timezone);
      const file=$('#post-file').files?.[0];
      let videoId=$('#existing-video').value;
      if(file){
        const response=await fetch('/api/videos',{method:'POST',headers:{'Content-Type':file.type||'video/mp4','X-Filename':encodeURIComponent(file.name)},body:file});
        const value=await response.json();if(!response.ok)throw new Error(value.error||'Video upload failed');videoId=value.id;
      }
      if(!videoId)throw new Error('Choose an existing video or select a file to upload');
      await api('/api/posts',{method:'POST',body:{
        videoId,title:$('#post-title').value.trim(),caption:$('#post-caption').value.trim(),scheduledAt:date,privacy:$('#post-privacy').value,
        disableComment:$('#post-comments').checked,disableDuet:$('#post-duets').checked,disableStitch:$('#post-stitches').checked,
        brandContent:$('#post-brand').checked,brandOrganic:$('#post-own-brand').checked,isAigc:$('#post-ai').checked,consent:$('#post-consent').checked
      }});
      closeModal();await refresh();showPage('scheduler');toast(state.account.connected?'Scheduled on your server':'Saved on server. Connect TikTok before publishing.');
    }catch(err){toast(err.message)}finally{btn.disabled=false;btn.textContent='Schedule on server'}
  });
  $('#download-form').addEventListener('submit',async e=>{
    e.preventDefault();const result=$('#download-result'),button=e.currentTarget.querySelector('button[type=submit]');
    button.disabled=true;button.textContent='Downloading…';result.classList.add('visible');result.classList.remove('error');result.textContent='Downloading permitted public video to the server. This can take a while.';
    try{
      const data=await api('/api/downloads',{method:'POST',body:{url:$('#video-url').value.trim(),permission:$('#download-permission').checked}});
      result.textContent='Saved '+data.name+' to your Media Library.';await refresh();
    }catch(err){result.classList.add('error');result.textContent=err.message}
    finally{button.disabled=false;button.textContent='Download video'}
  });
  $$('#schedule-filters button').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;$$('#schedule-filters button').forEach(x=>x.classList.toggle('active',x===b));render()}));
  $('#timezone').addEventListener('change',async e=>{try{await api('/api/preferences',{method:'POST',body:{timezone:e.target.value}});await refresh();toast('Workspace time zone updated')}catch(err){toast(err.message)}});
  $('#connect-demo').addEventListener('click',()=>{if(!state.account.configured){toast('Configure your TikTok credentials in the server .env file first');return}window.location='/auth/tiktok/start'});
  $('#disconnect-btn').addEventListener('click',async()=>{if(!confirm('Disconnect TikTok from this workspace? Scheduled uploads will stop until reconnected.'))return;try{await api('/api/tiktok/disconnect',{method:'POST'});await refresh();toast('TikTok account disconnected')}catch(err){toast(err.message)}});
  $('#logout-btn').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});window.location='/login'});
  refresh().catch(e=>toast(e.message));
  setInterval(()=>{if(!$('#schedule-overlay').classList.contains('visible'))refresh().catch(()=>{});},20000);
})();
