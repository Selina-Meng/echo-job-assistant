/* Provider-run search. A generated URL in answer text is never a source. */
globalThis.EchoResearch = (() => {
  function sources(response,now=Date.now()) {
    if(response.status!=='completed'||!response.output?.some(x=>x.type==='web_search_call'&&x.status==='completed'))throw new Error('联网未完成实际搜索');
    const found=new Map();
    const add=(url,text,title)=>{try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return;u.hash='';if(!text?.trim())return;found.set(u.href,{url:u.href,title:String(title||u.hostname).slice(0,150),text:String(text).slice(0,1200),at:now,indirectOnly:true});}catch(_){}};
    for(const item of response.output){
      if(item.type!=='message')continue;
      for(const part of item.content||[]){if(part.type!=='output_text')continue;
        for(const a of part.annotations||[])if(a.type==='url_citation'){
          const start=Number(a.start_index),end=Number(a.end_index),text=String(part.text||'');
          // Keep the cited paragraph as an AI summary, never label it a verbatim page quote.
          const paragraph=Number.isInteger(start)&&start>=0?text.slice(text.lastIndexOf('\n',start)+1,(text.indexOf('\n',Math.max(start,end||start))+1)||text.length):text;
          add(a.url,paragraph,a.title);
        }
      }
    }
    if(!found.size)throw new Error('联网回答未返回可核验引用，不能据此判断');
    return [...found.values()].slice(0,6);
  }
  async function lookup() {
    // Provider compatibility checked 2026-09-17: built-in web_search is ignored.
    // https://api-docs.deepseek.com/zh-cn/guides/responses_api/
    throw new Error('当前 DeepSeek Responses API 不支持内置联网搜索；已停止无效请求，不消耗本次 Token。JD与已保存资料仍可分析，外部信息需补充可靠来源后确认。');
  }
  return {lookup,sources};
})();
