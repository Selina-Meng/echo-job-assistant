/* Liepin DOM adapter. Reads only loaded list entries, never sends a message. */
(() => {
  'use strict';
  if (globalThis.echoAgentPageLoaded) return;
  globalThis.echoAgentPageLoaded = true;
  const rowSelector = '.conversation-item,.conv-item,.chat-item,.contact-item,.friend-item,.user-item,.dialog-item,[data-conversation-id],[data-session-id],[data-chat-id],[data-sessionid],[class*="session-item"],[class*="sessionItem"],[class*="conversation-item"],[class*="conversationItem"],[class*="contact-item"],[class*="contactItem"],[class*="chat-list-item"],[class*="chatListItem"],[role="listbox"] [role="option"]';
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const idAttributes = ['data-conversation-id','data-session-id','data-id','data-uid','data-user-id','data-chat-id','data-sessionid','data-contact-id','data-im-id','data-key'];
  const platformId = el => idAttributes.map(k => el.getAttribute(k)).find(Boolean) || '';
  const labelPart = (el,selector) => String(el.querySelector && el.querySelector(selector)?.textContent || '').replace(/\s+/g,' ').trim();
  function identity(el) {
    const id=platformId(el);if(id)return id;
    const name=labelPart(el,'.im-ui-contact-title-name'), sub=labelPart(el,'.im-ui-contact-title-sub');
    // Provisional display identity; never include latest message/time or claim a platform ID.
    return name && sub && name.length<=100 && sub.length<=150 ? 'display:'+JSON.stringify([name,sub]) : '';
  }
  let verifiedKey='';
  const selected = el => /(^|[\s_-])(active|selected|current)([\s_-]|$)/i.test(String(el.className)) || el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-state') === 'active';
  globalThis.echoChatIdentity = () => {
    const active = rows().filter(selected);
    if(active.length!==1)return null;
    const el=active[0],key=identity(el);
    const preview=labelPart(el,'.im-ui-last-message');
    return {key,label:labelPart(el,'.im-ui-contact-title-name')||el.innerText.trim().split('\n')[0],reliable:!!platformId(el),selectionVerified:verifiedKey===key,preview,previewUnique:!!preview&&candidateRows().filter(r=>labelPart(r,'.im-ui-last-message')===preview).length===1};
  };
  function blocked() {
    if (!/(^|\.)liepin\.com$/.test(location.hostname)) throw new Error('请打开猎聘页面');
    const text = document.body.innerText || '';
    if (/安全验证|访问验证|请完成验证|拖动滑块/.test(text) || /passport|login/.test(location.pathname) || [...document.querySelectorAll('input[type="password"]')].some(visible)) throw new Error('需要登录或页面验证，请在浏览器完成后继续');
  }
  function candidateRows() {
    const actual=[...document.querySelectorAll('.im-ui-contact-list-item')];
    return (actual.length?actual:[...document.querySelectorAll(rowSelector)]).filter(visible);
  }
  function rows() {
    const candidates=candidateRows(),counts=new Map();
    for(const el of candidates){const key=identity(el);counts.set(key,(counts.get(key)||0)+1);}
    return candidates.filter(el=>identity(el)&&counts.get(identity(el))===1);
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type !== 'AGENT_PAGE') return;
    (async () => {
      blocked();
      if (msg.action === 'check') return {};
      if (msg.action === 'favoriteEntry') {
        const links=[...document.querySelectorAll('a[href]')].filter(el=>/^(我的)?(职位|岗位)?收藏(的?(职位|岗位))?$/.test(el.innerText.trim()));
        const link=links.find(el=>{try{const u=new URL(el.href);return u.protocol==='https:'&&/(^|\.)liepin\.com$/.test(u.hostname)&&!/\/(job|a)\/\d+/.test(u.pathname);}catch(_){return false;}});
        return {url:link?link.href:''};
      }
      if (['jobs','favorites','apply','nextList'].includes(msg.action)) {
        const favorites=msg.action==='favorites'||msg.listType==='favorites';
        const applied=msg.action==='apply'||msg.listType==='apply';
        const read=()=>{
        // Verified in the public c.liepin.com/job/record/favorite route bundle (2026-09-07).
        const scopeSelector=favorites?'.favorite-record-container,[data-testid="favorite-list"],.favorite-job-list,.collect-job-list,.collection-job-list,[class*="favorite-list"],[class*="collect-list"]':applied?'.apply-record-container,[data-testid="apply-list"],.apply-job-list,.record-list-container,.content-list-box,[class*="apply-list"],[class*="applyList"]':'.job-list-box,.job-list-container,.job-list,[data-testid="job-list"]';
        let root=document.querySelector(scopeSelector);
        if(favorites&&!root){
          // Discover only a titled collection section, never the entire document.
          const heading=[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].find(el=>/^(我的)?(职位|岗位)?收藏(的?(职位|岗位))?$/.test(el.innerText.trim()));
          if(heading){let p=heading.parentElement;for(let i=0;p&&i<3&&p!==document.body;i++,p=p.parentElement){if(p.querySelector('a[href*=".shtml"]')){root=p;break;}}}
        }
        if(!root)throw new Error(favorites?'尚未识别收藏列表，请打开猎聘“我的收藏”页面后绑定；不能将推荐栏当作收藏。':applied?'尚未识别应聘记录列表，请等待页面加载后重试':'未识别搜索结果列表，请等待加载后重试');
        const seen = new Set(), jobs = [];
        for (const el of root.querySelectorAll('a[href]')) {
          if(el.closest('aside,[class*="recommend"],[class*="Recommend"],.seo-job-card-action-box'))continue;
          let u; try { u = new URL(el.href, location.href); } catch (_) { continue; }
          // List tasks run in background tabs; a valid card link may have no own layout box.
          if (!/(^|\.)liepin\.com$/.test(u.hostname) || !/^\/(job|a)\/\d+\.shtml$/.test(u.pathname)) continue;
          u.search = ''; u.hash = '';
          if (!seen.has(u.href)) { seen.add(u.href); jobs.push({ url: u.href, title: el.innerText.trim().slice(0, 100) }); }
        }
        const loading=root.querySelector('.record-list-loading-text,[aria-busy="true"],.ant-spin-spinning');
        if(loading)return {loading:true,root,items:[]};
        const empty=favorites&&[...root.querySelectorAll('.nest-empty-c,[data-testid="empty"]')].some(el=>/暂无收藏记录|暂无收藏|还没有收藏/.test(el.innerText.trim()));
        if(favorites&&!jobs.length&&!empty)throw new Error('已找到收藏列表，但未读取到岗位链接；请刷新收藏页后重试，未当作空收藏处理');
        const signature=jobs.map(j=>j.url).join('|');
        const active=document.querySelector('.ant-pagination-item-active,[aria-current="page"]');
        const pageIndex=active?Number(active.getAttribute('title')||active.textContent):null;
        return {items:jobs,available:jobs.length,signature,url:location.href,pageIndex:Number.isInteger(pageIndex)&&pageIndex>0?pageIndex:null,scope:(favorites?'收藏':applied?'应聘记录':'搜索')+'已加载 '+jobs.length+' 个',partial:true,root};
        };
        let before=read();const loadedBy=Date.now()+10000;
        while(before.loading&&Date.now()<loadedBy){await new Promise(r=>setTimeout(r,300));blocked();before=read();}
        if(before.loading)throw new Error('列表仍在加载，请稍后继续，未当作空结果');
        if(msg.action!=='nextList'){delete before.root;return before;}
        if(msg.previous&&before.signature!==msg.previous){delete before.root;return before;}
        const controls=[...document.querySelectorAll('a,button,[role="button"],.ant-pagination-next,.el-pagination .btn-next')].filter(el=>!el.closest('aside,[class*="recommend"],[class*="Recommend"]'));
        const next=controls.find(el=>visible(el)&&(/^(下一页|下页|Next|›|»)$/i.test((el.innerText||'').trim())||/next/i.test(el.getAttribute('aria-label')||'')||el.classList.contains('ant-pagination-next')||el.classList.contains('btn-next')));
        const disabled=el=>el.disabled||el.getAttribute('aria-disabled')==='true'||/disabled/i.test(String(el.className));
        if(next&&!disabled(next)){
          const a=next.matches('a[href]')?next:next.querySelector('a[href]');
          if(a){const u=new URL(a.href,location.href);if(u.protocol==='https:'&&u.hostname===location.hostname&&u.href!==location.href)return {nextUrl:u.href,signature:before.signature};}
          next.click();
        }else if(next)return {done:true,reason:'已到最后一页',signature:before.signature};
        else {before.root.scrollTop=before.root.scrollHeight;before.root.scrollIntoView({block:'end'});window.scrollTo(0,document.documentElement.scrollHeight);}
        const end=Date.now()+6000;
        while(Date.now()<end){await new Promise(r=>setTimeout(r,400));blocked();const after=read();if(!after.loading&&after.signature!==before.signature){delete after.root;return after;}}
        return {done:true,reason:next?'点击后列表未变化，请核对后继续':'当前已加载范围无新增；未发现可用下一页',partial:true,signature:before.signature};
      }
      if (msg.action === 'chats') {
        const list = rows();
        const candidates = candidateRows(),stable=list.filter(platformId).length;
        const diagnostic = '会话行 '+candidates.length+'，平台标识 '+stable+'，临时区分 '+(list.length-stable)+'，歧义或缺信息 '+(candidates.length-list.length);
        return { items: list.map(el => ({ key: identity(el), label: el.innerText.split('\n')[0].slice(0,100) })), available: list.length, diagnostic, scope: diagnostic+'；每批21条，可继续剩余聊天。临时身份仅供核对，不自动归档' };
      }
      if(msg.action==='findChat'){
        let list=[];
        for(let i=0;i<8;i++){blocked();list=rows();if(list.length)break;await new Promise(r=>setTimeout(r,300));}
        if(list.some(el=>identity(el)===msg.key))return {found:true,key:msg.key,scanned:list.length};
        const first=candidateRows()[0];let container=first?.parentElement;
        while(container&&!(container.scrollHeight>container.clientHeight+10&&/auto|scroll/.test(getComputedStyle(container).overflowY)))container=container.parentElement;
        if(!container)return {found:false,diagnostic:'已加载 '+list.length+' 个可区分会话；无可滚动会话容器，列表可能未加载或标识已变化'};
        const original=container.scrollTop,seen=new Set();let repeated=0;
        // ponytail: 最多12段列表；超出范围交给用户定位，不无限滚动。
        container.scrollTop=0;await new Promise(r=>setTimeout(r,350));
        for(let step=0;step<12;step++){
          blocked();list=rows();const signature=list.map(identity).join('|');if(seen.has(signature))repeated++;else repeated=0;seen.add(signature);
          if(list.some(el=>identity(el)===msg.key))return {found:true,key:msg.key,scanned:seen.size,steps:step};
          if(repeated>=2)break;const before=container.scrollTop;container.scrollTop=Math.min(container.scrollHeight,container.scrollTop+Math.max(100,container.clientHeight*.8));
          await new Promise(r=>setTimeout(r,350));if(container.scrollTop===before&&step>0)break;
        }
        container.scrollTop=original;return {found:false,diagnostic:'已检查最多12段列表；当前可区分会话 '+list.length+'，未匹配保存标识。可能超出加载范围或标识已变化'};
      }
      if (msg.action === 'diagnose') {
        // Structure only: no message text, attribute values, cookies, or account data.
        const shape=(el,depth=0)=>({tag:el.tagName,classes:String(el.className).slice(0,200),attributes:[...el.attributes].map(a=>a.name),children:depth<2?[...el.children].slice(0,4).map(e=>shape(e,depth+1)):[]});
        const candidates=candidateRows();
        return {path:location.pathname,candidates:candidates.length,identified:rows().length,frames:document.querySelectorAll('iframe').length,samples:candidates.slice(0,4).map(el=>shape(el))};
      }
      if (msg.action === 'openChat') {
        const row = rows().find(el => identity(el) === msg.key);
        if (!row) throw new Error('列表中找不到该会话，请重新打开聊天列表');
        verifiedKey='';if(row.scrollIntoView)row.scrollIntoView({block:'nearest'});row.click();
        // ponytail: bounded DOM settling; stop rather than infer a successful switch.
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 400)); blocked();
          const active = globalThis.echoChatIdentity();
          if (active && active.key === msg.key) {verifiedKey=msg.key;return { selectedKey: msg.key };}
        }
        throw new Error('无法确认已切换到目标会话，已停止以避免错配');
      }
      throw new Error('未知页面操作');
    })().then(data => reply({ ok: true, ...data })).catch(e => reply({ ok: false, error: e.message }));
    return true;
  });
})();
