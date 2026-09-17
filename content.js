/* global chrome */
// content.js — 在招聘网站页面内提取 JD / 整页文本 / 聊天
// 策略：① 站点专属 selector → ② 按标题文字定位 JD → ③ 可见文本正则兜底
(function () {
  'use strict';
  if (globalThis.echoContentLoaded) return;
  globalThis.echoContentLoaded = true;

  const SITE_SELECTORS = {
    'zhipin.com': {
      title: ['.job-banner .name h1', '.job-title', '.name-box .job-name', 'h1'],
      salary: ['.salary', '.job-salary', '.job-banner .salary'],
      company: ['.company-info h3', '.company-info .name', '.company-name', '.business-name'],
      location: ['.location-address', '.job-location .location-address', '.job-area', '.location', '.job-address'],
      size: ['.company-info .company-scale', '.company-info p', '.company-scale', '.company-size'],
      experience: ['.experience', '.job-experience'],
      education: ['.edu-level', '.education'],
      description: ['.job-detail-section .job-sec-text', '.job-sec-text', '.job-detail .detail-content', '.job-description', '#job-description', '.job-sec .text', 'article']
    },
    'zhaopin.com': {
      title: ['.summary-position__title', '.job-name', 'h1'],
      salary: ['.summary-position__salary', '.job-salary', '.salary'],
      company: ['.company-name', '.summary-position__company'],
      location: ['.job-address', '.summary-position__location', '.addr'],
      size: ['.company-size', '.company-scale', '.summary-position__company-size'],
      experience: ['.summary-position__experience', '.experience'],
      education: ['.summary-position__edu', '.edu-level'],
      description: ['#job-description', '.job-description', '.description', 'article']
    },
    'liepin.com': {
      title: ['.job-apply-container .name-box .name', '.title-info h1'],
      salary: ['.job-apply-container .name-box .salary', '.title-info .salary'],
      company: ['.recruiter-container .title-box a[href*="/company/"]', '.company-info-container .company-card .name', '.title-info .company'],
      location: ['.job-apply-container .job-properties > span:first-child', '.title-info .job-location'],
      size: ['.company-info-container .company-other', '.company-info-container .company-card'],
      experience: ['.title-info .experience'],
      education: ['.title-info .education'],
      description: ['.job-intro-container .paragraph dd', '.job-detail .job-description', '.job-detail .about-position']
    },
    'lagou.com': {
      title: ['.position-head-wrap .name', '.job-name', '.position-name', 'h1'],
      salary: ['.position-head-wrap .salary', '.job-salary', '.salary'],
      company: ['.company-name', '.company'],
      location: ['.work-address', '.job-address', '.position-address'],
      size: ['.company-size', '.company-scale'],
      experience: ['.experience', '.job-experience'],
      education: ['.education', '.job-education'],
      description: ['.job-detail', '.position-detail', '.job-description', 'article']
    }
  };

  function hostKey() {
    try {
      const host = location.hostname.toLowerCase();
      return Object.keys(SITE_SELECTORS).find((domain) => host === domain || host.endsWith('.' + domain)) || '';
    } catch (e) { return ''; }
  }

  function pick(selectors) {
    if (!selectors) return '';
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
    }
    return '';
  }
  function normalizeSize(text) {
    const match = String(text || '').match(/(?:规模[：:\s]*)?(\d+\s*-\s*\d+\s*人|\d+\s*人以下|\d+\s*人以上|\d+\s*人)/);
    return match ? match[1].replace(/\s+/g, '') : '';
  }

  // ② 按"标题文字"定位 JD
  function extractJDByHeading() {
    const body = document.body;
    if (!body) return '';
    const text = body.innerText || '';
    if (!text) return '';
    const START_KEYS = ['职位描述', '职位介绍', '岗位描述', '岗位职责', '工作内容', 'Job Description', 'JD'];
    const STOP_KEYS = ['公司简介', '公司信息', '工商信息', '猎聘温馨提示', '其他信息', '工作地点', '企业名称', '企业类型', '查看全部', 'BOSS直聘'];
    let start = -1, usedKey = '';
    for (const k of START_KEYS) {
      const i = text.indexOf(k);
      if (i !== -1 && (start === -1 || i < start)) { start = i; usedKey = k; }
    }
    if (start === -1) return '';
    let end = text.length;
    for (const k of STOP_KEYS) {
      const i = text.indexOf(k, start + usedKey.length);
      if (i !== -1 && i < end) end = i;
    }
    return text.slice(start, end).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
  }

  // ③ 可见文本正则兜底
  function extractMetaByText() {
    const body = document.body;
    const text = (body && body.innerText) || '';
    const h1 = document.querySelector('h1');
    let title = (h1 && h1.innerText ? h1.innerText : '').trim().split('\n')[0] || '';
    if (!title) { const t = (document.title || '').replace(/[-_|].*$/, '').trim(); title = t; }
    let salary = '';
    const salMatch = text.match(/(\d{1,2}\s*-\s*\d{1,2}\s*k[\u00b7\s]*\d*\s*薪|\d{1,2}\s*-\s*\d{1,2}\s*[kK]|面议|薪资面议|元\/月|元\/天|\$\s*\d+)/i);
    if (salMatch) salary = salMatch[0].replace(/\s+/g, '');
    let location = '';
    // 拒绝把页脚/导航/无障碍等 UI 文案当作城市（例如「无障碍专区」「帮助中心」）
    const DENY_LOC = /无障碍|专区|反馈|帮助|客服|登录|注册|首页|导航|关于|隐私|职位|搜索|城市|选择|分享|举报|投诉|违法|安全|下载|扫码|APP|公众号|小程序|面试|经验|学历|薪资|公司信息|工商|地址|邮箱|电话|版权/;
    const locMatch = text.match(/([一-龥]{2,8}(?:省|市|自治区|自治州|特区)?[·\s\-]?[一-龥]{1,8}(?:区|县|市))/);
    if (locMatch && !DENY_LOC.test(locMatch[1])) location = locMatch[1].replace(/[·\s\-]+/, ' ').trim();
    const size = normalizeSize(text);
    return { title, salary, location, size };
  }

  // 猎聘岗位名清洗：去掉【…】括号内容、城市前缀、符号/空格、结尾「招聘」二字，仅保留真实岗位名
  // （注意保留「招聘经理 / 招聘专员 / 招聘主管」等以招聘开头的真实职位）
  function cleanLiepinTitle(t) {
    let s = (t || '').trim();
    if (!s) return s;
    // 0) 去掉所有【…】括号内容（猎聘常用其标注地点/标签，如「【北京】」「【北京-朝阳区】」）
    s = s.replace(/【[^】]*】/g, '');
    // 1) 去掉结尾的「招聘」
    s = s.replace(/招\s*聘\s*$/, '');
    // 2) 去掉开头的「城市·」「城市-」「城市 」（城市多为 2-4 字中文，且后面紧跟中文职位）
    s = s.replace(/^[一-龥]{2,6}[·\-\s]+(?=[一-龥])/, '');
    // 3) 处理「城市 招聘 职位」「城市招聘职位」开头
    s = s.replace(/^[一-龥]{2,6}\s*招\s*聘\s*/, '');
    // 4) 去掉残留符号与多余空格
    s = s.replace(/^[·\-\s]+|[·\-\s]+$/g, '').replace(/\s+/g, ' ').trim();
    return s;
  }

  // HR 活跃原文 → 统一归类为固定标签（各平台展示不同：Boss 为「刚刚活跃/今日活跃…」，猎聘多为「N小时前活跃」）
  function normalizeHrActive(s) {
    s = String(s || '');
    if (!s) return '';
    if (/在线|on\s*-?\s*line|当前在线|在线应聘|在线招聘/.test(s)) return '在线';
    if (/刚刚|分钟前/.test(s)) return '刚刚活跃';
    if (/今日|今天|本日|小时/.test(s)) return '今日活跃';
    if (/3\s*日内|三天内|3\s*天内/.test(s)) return '3日内活跃';
    if (/本周|这周|周内/.test(s)) return '本周活跃';
    const dm = s.match(/(\d+)\s*天前/);
    if (dm) { const d = parseInt(dm[1], 10); if (d <= 1) return '今日活跃'; if (d <= 3) return '3日内活跃'; if (d <= 7) return '本周活跃'; return '半年前活跃'; }
    if (/周前|个月前|月前|半年前|很久|不活跃/.test(s)) return '半年前活跃';
    if (/活跃/.test(s)) return '活跃';
    return '';
  }

  function publishedFact(text, now = new Date()) {
    const value=(String(text||'').match(/(?:今天|今日|昨日|昨天|\d{1,2}月\d{1,2}日|\d+天前)(?:发布|更新)/)||[])[0]||'';
    if(!value)return {publishedText:'',publishedAt:null};
    const d=new Date(now);d.setHours(0,0,0,0);
    if(/昨日|昨天/.test(value))d.setDate(d.getDate()-1);
    else if(/天前/.test(value))d.setDate(d.getDate()-Number((value.match(/\d+/)||[0])[0]));
    else if(/月/.test(value)){const m=value.match(/(\d{1,2})月(\d{1,2})日/);d.setMonth(Number(m[1])-1,Number(m[2]));if(d>now)d.setFullYear(d.getFullYear()-1);}
    return {publishedText:value,publishedAt:d.getTime()};
  }

  function extractJob() {
    const key = hostKey();
    const site = SITE_SELECTORS[key] || {};
    const job = {
      title: pick(site.title) || '', salary: pick(site.salary) || '', company: pick(site.company) || '',
      location: pick(site.location) || '', size: normalizeSize(pick(site.size)), experience: pick(site.experience) || '',
      education: pick(site.education) || '', description: pick(site.description) || ''
    };
    if (key === 'liepin.com') {
      job.url=location.href;
      job.workAddress=pick(['.job-intro-container .job-address','.job-intro-container .job-address-text','.job-intro-container .address','.job-detail .work-address','.job-address-container .address','.job-address-container .address-info']);
      if(!job.workAddress)for(const block of document.querySelectorAll('.job-intro-container dl, .job-intro-container section, .job-detail .paragraph')){const heading=block.querySelector('dt,h2,h3');if(/工作地址|工作地点/.test(heading?.textContent||'')){job.workAddress=String(block.querySelector('dd')?.textContent||'').trim();break;}}
      if(!job.workAddress)for(const block of document.querySelectorAll('.company-info-container .label-box')){if(/^职位地址[：:]?$/.test(block.querySelector('.label')?.textContent.trim()||'')){job.workAddress=block.querySelector('.text')?.textContent.trim()||'';break;}}
      job.benefits=[...new Set([...document.querySelectorAll('.job-apply-container-desc .job-apply-container-left .labels span')].map(x=>x.textContent.trim()).filter(Boolean))].slice(0,40).join('、');
      job.industry=pick(['.company-info-container .company-industry','.company-info-container a[href*="/company/"] + .industry']);
      job.companyDescription=pick(['.company-info-container .company-introduction','.company-info-container .company-intro','.job-intro-container .company-description']);
      for(const key of ['workAddress','industry','companyDescription'])job[key]=String(job[key]||'').trim().slice(0,key==='companyDescription'?5000:500);
      const recruiterText=pick(['.recruiter-container']);
      const headhunter=/^\/a\/\d+\.shtml$/i.test(location.pathname)||/猎头顾问|猎头公司/.test(recruiterText);
      if(headhunter){
        const titleParts=[...document.querySelectorAll('.recruiter-container .title-box span')].map(x=>(x.innerText||x.textContent||'').trim().replace(/^[·•\s]+/, '')).filter(x=>x&&!/^(猎头|猎头顾问|顾问|招聘顾问)$/.test(x));
        const raw=titleParts.sort((a,b)=>b.length-a.length)[0]||pick(['.recruiter-container .hunter-company','.recruiter-container .company-name','.recruiter-container [class*="company-name"]','.recruiter-container .title-box']);
        const company=String(raw||'').split('\n').map(x=>x.trim().replace(/^[·•\s]+/, '')).find(x=>x&&!/^(猎头|猎头顾问|顾问|招聘顾问|今日活跃|刚刚活跃)$/.test(x));
        if(company)job.company=company;
        job.companyType='猎头';
      }
      const stopped=pick(['.job-offline','.job-expired','.job-status','.job-apply-container button[disabled]']);
      const stoppedReason=(stopped.match(/职位已下线|职位已关闭|职位已过期|岗位已下架|职位不存在|已停止招聘|停止招聘|招聘已结束/)||[])[0];
      if(stoppedReason)return {...job,availability:'unavailable',availabilityReason:stoppedReason,extractionScope:'liepin-main-v1'};
      const applicationText=pick(['.job-apply-container button','.job-apply-container [class*="apply"]']);
      if(/已投递|已申请/.test(applicationText)){job.applicationStatus='已投递';job.applicationStatusText=(applicationText.match(/已投递|已申请/)||[])[0];}
      // Main detail only: global fallbacks also match recommended jobs on this page.
      if (!job.title) {
        const notice=pick(['.job-offline','.job-expired','.job-status','.job-apply-container']);
        if(/职位已下线|职位已关闭|职位已过期|岗位已下架|职位不存在/.test(notice))return {availability:'unavailable',availabilityReason:(notice.match(/职位已下线|职位已关闭|职位已过期|岗位已下架|职位不存在/)||[])[0],extractionScope:'liepin-main-v1'};
        throw new Error('未识别到主岗位详情，请打开岗位详情页，加载完成后重试。');
      }
      const properties = pick(['.job-apply-container .job-properties']);
      job.experience = (properties.match(/\d+\s*-\s*\d+年|\d+年以上|经验不限|应届生/) || [job.experience])[0];
      job.education = (properties.match(/博士|硕士|本科|大专|中专|高中|学历不限/) || [job.education])[0];
      job.company = job.company.replace(/^[·•\s]+/, '');
      job.title = cleanLiepinTitle(job.title);
      job.hrActiveText=extractHrActiveRaw(pick(['.recruiter-container']));
      job.hrActive=normalizeHrActive(job.hrActiveText);
      Object.assign(job,publishedFact(pick(['.job-apply-container','.job-title-box','.job-detail-box','.job-intro-container'])));
      job.extractionScope = 'liepin-main-v1';
      return job;
    }
    if (!job.description) job.description = extractJDByHeading();
    const meta = extractMetaByText();
    if (!job.title) job.title = meta.title;
    if (!job.salary) job.salary = meta.salary;
    if (!job.location) job.location = meta.location;
    if (!job.size) job.size = meta.size;
    if (!job.title && !job.description) {
      const body = document.body;
      job.description = (body && body.innerText ? body.innerText : '').slice(0, 2000).trim();
    }
    // 抓取页面上的 HR 活跃文案（Boss 在岗位/HR 信息处常显示「刚刚活跃/今日活跃…」）
    const ha = extractHrActiveRaw();
    if (ha) {job.hrActiveText=ha;job.hrActive=normalizeHrActive(ha);}
    // 猎聘岗位名清洗（去掉城市/符号/「招聘」二字）
    if (key.indexOf('liepin.com') >= 0 && job.title) job.title = cleanLiepinTitle(job.title);
    return job;
  }

  function pageBlockReason() {
    const url = location.href || '';
    const text = (document.body && document.body.innerText) || '';
    if (/\/web\/passport\/zp\/security/i.test(url) || /访问验证|安全验证|请完成验证|拖动滑块|验证码/.test(text)) {
      return 'Boss 当前处于安全验证页，请先在岗位页完成验证并刷新后重试。';
    }
    return '';
  }

  // 聊天页抓取
  function isChatPage() {
    const path = (location.pathname || '').toLowerCase();
    if (visibleChatRoot()) return true;
    if (/\/job(?:_detail)?\//.test(path)) return false;
    if (path.includes('/im/') || path.includes('/web/im') || path.includes('/geek/chat') || path.includes('conversation') || path.includes('message') || path.includes('chat')) return true;
    const t = (document.body && document.body.innerText) || '';
    if (/(已读|未读|对方正在输入|发消息|聊天)/.test(t) && !/职位描述|岗位职责/.test(t)) return true;
    return false;
  }
  // 抓取 HR 活跃状态并归类为固定标签（Boss：刚刚活跃/今日活跃…；猎聘：N分钟/N小时/N天前活跃…）
  function extractHrActiveRaw(text) {
    const txt = text === undefined ? (document.body && document.body.innerText) || '' : text;
    const m = txt.match(/(刚刚活跃|今日活跃|今天活跃|3日内活跃|三天内活跃|本周活跃|半年前活跃|当前在线|在线|\d+\s*分钟前(?:活跃|在线)|\d+\s*小时前(?:活跃|在线)|\d+\s*小时内(?:活跃|在线)|\d+\s*天前(?:活跃|在线)|\d+\s*周内(?:活跃|在线)|\d+\s*周前(?:活跃|在线)|\d+\s*个月前(?:活跃|在线))/);
    return m ? m[1].replace(/\s+/g,'') : '';
  }
  const extractHrActiveText=text=>normalizeHrActive(extractHrActiveRaw(text));
  const CHAT_ROOT_SELECTORS = ['.chat-container', '.chat-message-list', '.chat-msg-list', '.message-list', '.chat-content', '.dialogue', '.im-chat', '.msg-list', '.chat-box', '.im-dialog', '.msg-box', '.message-container', '.ant-drawer-content', '.ant-modal-content', '[role="dialog"]', '[class*="chat-panel"]', '[class*="message-panel"]', '[class*="message-list"]', '[class*="msg-list"]', '[class*="chat-content"]', '[class*="message-container"]'];
  const CHAT_MESSAGE_SELECTOR = '.im-ui-message,.im-ui-message-content,.im-ui-message-text,.im-ui-message-card,.system-message,.message-system,.system-tip,.im-system-msg,[data-message-type="system"],.message-item,.msg-item,.chat-message,.message-content,.item-myself,.item-friend,[data-message-id],[data-msg-id],[class*="message-item"],[class*="msg-item"],[class*="chat-msg"],[class*="message-bubble"],[class*="msg-bubble"],[class*="chat-bubble"],[class*="message-line"],[class*="talk-item"]';
  const CHAT_COMPOSER_SELECTOR = 'textarea,[contenteditable="true"],input[placeholder*="消息"],input[placeholder*="沟通"],textarea[placeholder*="消息"],textarea[placeholder*="沟通"]';
  function visibleElement(el) {
    if (!el) return false;
    try { const style = getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') return false; } catch (e) {}
    try { const rect = el.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false; } catch (e) {}
    return true;
  }
  function chatEvidence(el) {
    if (!el) return false;
    try { if (el.querySelector(CHAT_COMPOSER_SELECTOR)) return true; } catch (e) {}
    try { if (el.querySelectorAll(CHAT_MESSAGE_SELECTOR).length) return true; } catch (e) {}
    const text = String(el.innerText || '');
    return text.length < 12000 && /(已读|未读|请输入.{0,4}(消息|内容)|发送消息|继续沟通)/.test(text);
  }
  function visibleChatRoot() {
    for (const sel of CHAT_ROOT_SELECTORS) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) {}
      if (!nodes.length) { const one = document.querySelector(sel); if (one) nodes = [one]; }
      const found = nodes.find((el) => visibleElement(el) && chatEvidence(el));
      if (found) return found;
    }
    return null;
  }
  function chatRoot() {
    const visible = visibleChatRoot(); if (visible) return visible;
    for (const sel of CHAT_ROOT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim()) return el;
    }
    return document.querySelector('main') || document.body;
  }
  function chatTime(value,now=Date.now()){
    const text=String(value||'').trim(),current=new Date(now);let date,reliable=true;
    if(/^\d{10}(?:\d{3})?$/.test(text))date=new Date(Number(text)*(text.length===10?1000:1));
    else {
      const full=text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      const short=text.match(/^(?:(\d{1,2})[-/月](\d{1,2})日?|今天|昨天|前天)?\s*(\d{1,2}):(\d{2})$/);
      let y,m,d,h,min,sec=0;
      if(full){[,y,m,d,h,min,sec=0]=full;}
      else if(short){y=current.getFullYear();m=short[1]||current.getMonth()+1;d=short[2]||current.getDate();h=short[3];min=short[4];
        if(short[1]){reliable=false;const candidate=new Date(y,m-1,d,h,min);if(candidate.getTime()>now)y--;}
        else if(/昨天|前天/.test(text)){const day=new Date(y,m-1,d);day.setDate(day.getDate()-(/前天/.test(text)?2:1));y=day.getFullYear();m=day.getMonth()+1;d=day.getDate();}
        else if(!text.startsWith('今天'))reliable=false;
      }else if(/^\d{4}-\d{2}-\d{2}T/.test(text))date=new Date(text);else return null;
      if(!date){date=new Date(Number(y),Number(m)-1,Number(d),Number(h),Number(min),Number(sec));if(date.getFullYear()!==Number(y)||date.getMonth()!==Number(m)-1||date.getDate()!==Number(d)||Number(h)>23||Number(min)>59||Number(sec)>59)return null;}
    }
    const stamp=date.getTime();return Number.isFinite(stamp)&&stamp>0&&stamp<=now?{stamp,reliable,text}:null;
  }
  function messageTime(el,meta,root){
    const own=meta.querySelector?.('time[datetime]');
    const raw=own?.getAttribute('datetime')||meta.getAttribute?.('data-timestamp')||meta.getAttribute?.('data-time');
    let found=chatTime(raw);if(found)return {...found,source:'attribute'};
    // Time separators can be plain blocks with no time/date class.
    for(let parent=meta,depth=0;parent&&parent!==root&&depth<3;parent=parent.parentElement,depth++){
      let sibling=parent.previousElementSibling;
      for(let count=0;sibling&&count<20;sibling=sibling.previousElementSibling,count++){
        const parsed=chatTime(sibling.textContent);if(parsed){found={...parsed,reliable:false,source:'separator'};break;}
      }
      if(found)break;
    }
    const labels=[...(root.querySelectorAll?.('time,[class*="time"],[class*="date"]')||[])];
    for(const node of labels){if(node===root)continue;const owner=node.closest?.('[data-message-id],[data-msg-id],.message-item,.msg-item,.im-ui-message,.chat-message');if(owner&&owner!==meta&&!meta.contains?.(owner))continue;const parsed=chatTime(node.innerText||node.textContent);if(!parsed)continue;
      if(meta.contains?.(node))return {...parsed,source:'visible'};
      if(node.compareDocumentPosition?.(meta)&4)found={...parsed,reliable:parsed.reliable&&node.nextElementSibling===meta,source:'separator'};
    }
    return found;
  }
  function systemNotice(text){return /^(?:\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}\s*)?(?:使用优先沟通，通过短信和邮箱多重提醒|求职过程中如遇收取培训费、考证费、中介费、押金|你已对境外招聘方隐藏简历，若该招聘方当前在境外)/.test(String(text||'').trim());}
  function messageRole(el, root) {
    if(systemNotice(el.innerText||el.textContent))return 'system';
    let node=el;
    for(let i=0;node&&node!==root&&i<4;i++,node=node.parentElement){
      const classes=String(node.className||'');
      if(node.getAttribute?.('data-message-type')==='system'||/(?:^|\s)(?:system-message|message-system|system-tip|im-system-msg|system-notice)(?:\s|$)/i.test(classes))return 'system';
      if(/(^|[\s_-])(my|mine|self|myself|send|sent|sender|geek)([\s_-]|$)/i.test(classes))return 'candidate';
      if(/(^|[\s_-])(friend|other|receive|received|receiver|boss|hr)([\s_-]|$)/i.test(classes))return 'hr';
    }
    try { const a=el.getBoundingClientRect(),b=root.getBoundingClientRect();if(a.width>0&&b.width>0&&a.width<b.width*.85)return a.left+a.width/2>b.left+b.width/2?'candidate':'hr'; }catch(e){}
    return 'unknown';
  }
  function extractChatMessages() {
    const root = chatRoot(); if (!root || !root.querySelectorAll) return [];
    const out = [];
    root.querySelectorAll(CHAT_MESSAGE_SELECTOR).forEach((el) => {
      const statusOnly=t=>/^[【\[（(]?(?:已读|未读|送达|已发送|发送中)[】\]）)]?$/.test(String(t||'').trim());
      const nested=[...(el.querySelectorAll?.(CHAT_MESSAGE_SELECTOR)||[])];
      if(nested.some(n=>!statusOnly(n.innerText)&&messageRole(n,root)!=='system'&&String(n.innerText||'').trim()))return;
      const copy=el.cloneNode?.(true);
      if(copy)for(const n of copy.querySelectorAll('[class*="read"],.system-tip,.system-message,.message-system,.im-system-msg,[data-message-type="system"]'))if(statusOnly(n.textContent)||n.matches('.system-tip,.system-message,.message-system,.im-system-msg,[data-message-type="system"]'))n.remove();
      const text=String(copy?copy.textContent:el.innerText||'').replace(/\s+/g,' ').trim().replace(/(?:\s+(?:已读|未读)|【(?:已读|未读)】|\[(?:已读|未读)\])$/,'').trim();
      if(!text||statusOnly(text)||text.length>1200||el===root)return;
      const item = { role: messageRole(el, root), text: text.slice(0, 1200) };
      let node = el, classes = '';
      for (let i = 0; node && node!==root && i < 4; i++, node = node.parentElement) classes += ' ' + String(node.className || '');
      item.roleSource = item.role==='system'?'explicit':/(^|[\s_-])(my|mine|self|myself|send|sent|sender|geek|friend|other|receive|received|receiver|boss|hr)([\s_-]|$)/i.test(classes) ? 'explicit' : 'position';
      let meta=el;
      for(let i=0;meta.parentElement&&meta.parentElement!==root&&i<3&&!meta.matches?.('[data-message-id],[data-msg-id],[data-time],[data-timestamp],.message-item,.msg-item,.im-ui-message,.chat-message');i++)meta=meta.parentElement;
      item.id=meta.getAttribute?.('data-message-id')||meta.getAttribute?.('data-msg-id')||'';
      const parsedTime=messageTime(el,meta,root);
      item.sentAt=parsedTime?.stamp||null;
      if(parsedTime){item.timeSource=parsedTime.source;item.timeText=parsedTime.text;item.timeReliable=parsedTime.reliable;}
      const prev = out[out.length - 1];
      if (!prev || prev.role !== item.role || prev.text !== item.text) out.push(item);
    });
    return out.slice(-100);
  }
  function extractChatText() {
    const root = chatRoot();
    return ((root && root.innerText) || '').trim().slice(0, 8000);
  }
  function extractChat() {
    const isChat = isChatPage();
    const text = extractChatText();
    const messages = extractChatMessages();
    const h1 = document.querySelector('h1');
    const titleGuess = (h1 && h1.innerText ? h1.innerText : '').trim().split('\n')[0] || '';
    const active = document.querySelector('[data-conversation-id][aria-selected="true"],[data-session-id][aria-selected="true"],.conversation-item.active,.friend-item.active,.friend-item.selected,.conv-item.active,.conv-item.selected,.chat-item.active,.chat-item.selected,.dialog-item.active,.dialog-item.selected,.user-item.active,.user-item.selected,.contact-item.active,.contact-item.selected,[class*="conversation"][class*="active"],[class*="conversation"][class*="selected"]');
    const sharedIdentity = typeof globalThis.echoChatIdentity === 'function' ? globalThis.echoChatIdentity() : null;
    const activeId = sharedIdentity ? sharedIdentity.key : active && ['data-conversation-id', 'data-session-id', 'data-id', 'data-uid', 'data-user-id'].map((key) => active.getAttribute(key)).find(Boolean);
    const counterparty = sharedIdentity ? sharedIdentity.label : active && active.innerText ? active.innerText.trim().split('\n')[0] : '';
    const knownRoles = messages.filter((m) => m.role !== 'unknown').length;
    const roleQuality = !messages.length ? 'none' : (knownRoles === messages.length ? 'high' : (knownRoles ? 'partial' : 'none'));
    const keyPart = activeId || counterparty;
    const normalizePreview=s=>String(s||'').replace(/【(?:未读|已读)】|\[(?:未读|已读)\]|\s/g,'').replace(/[.…]+$/,'');
    const preview=normalizePreview(sharedIdentity?.preview),last=messages.filter(m=>m.role!=='system').at(-1);
    const contentVerified=!!(sharedIdentity?.selectionVerified&&sharedIdentity.previewUnique&&preview.length>=8&&last&&normalizePreview(last.text).includes(preview));
    const identityReliable=sharedIdentity?sharedIdentity.reliable||contentVerified:!!activeId;
    const identityEvidence={method:sharedIdentity?.reliable?'platform-id':contentVerified?'selected-preview':'unverified',key:keyPart||'',reason:identityReliable?'':!sharedIdentity?'未找到唯一选中的会话':!sharedIdentity.selectionVerified?'尚未核对列表切换':!sharedIdentity.previewUnique?'列表摘要缺失或重复，无法对应聊天内容':'列表摘要与最后有效消息尚未对应'};
    return { isChat: isChat, text: text, messages: messages, roleQuality: roleQuality, identityReliable, identityEvidence, readerVersion:'0.18.35', selectionVerified: !!(sharedIdentity && sharedIdentity.selectionVerified), conversationKey: keyPart ? location.hostname + '|' + keyPart : '', counterparty: counterparty || '', titleGuess: titleGuess, hrActiveText: extractHrActiveRaw() };
  }
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'EXTRACT_JOB') {
      try {
        const blocked = pageBlockReason();
        if (blocked) sendResponse({ ok: false, error: blocked });
        else sendResponse({ ok: true, job: extractJob() });
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
      return true;
    }
    if (msg.type === 'EXTRACT_PAGE_TEXT') {
      try {
        const source = hostKey() === 'liepin.com' ? JSON.stringify(extractJob()) : (document.body && document.body.innerText || '');
        const txt = source.replace(/\s+/g, ' ').trim().slice(0, 6000);
        sendResponse({ ok: true, text: txt });
      }
      catch (e) { sendResponse({ ok: false, error: String(e) }); }
      return true;
    }
    if (msg.type === 'EXTRACT_CHAT') {
      try { const result = extractChat(); sendResponse({ ok: true, chat: result }); }
      catch (e) { sendResponse({ ok: false, error: String(e) }); }
      return true;
    }
  });
})();
