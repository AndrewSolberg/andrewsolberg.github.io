'use strict';

// Run with Node.js 20+: node library_search_server.cjs
// This helper serves only the app and relays its allowlisted metadata requests.
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');

const ROUTES=new Map([
  ['openlibrary.org',/^\/api\/(?:books|get_many)\/?$/],
  ['archive.org',/^\/(?:advancedsearch\.php|metadata\/[\w.-]+\/?|download\/[\w.-]+\/[^/]+\.txt)$/i],
  ['lx2.loc.gov',/^\/sru\/lcdb\/?$/],
  ['catalog.hathitrust.org',/^\/api\/volumes\/(?:full|brief)\/(?:isbn|lccn|oclc|htid)\/[^/]+\.json$/],
  ['library.oapen.org',/^\/(?:rest\/search|server\/api\/.*)$/],
  ['directory.doabooks.org',/^\/(?:rest\/search|server\/api\/.*)$/],
  ['api.crossref.org',/^\/works\/?$/],
  ['catalogue.bnf.fr',/^\/api\/SRU\/?$/],
  ['metadata.api.oclc.org',/^\/worldcat\/(?:search\/brief-bibs|manage\/bibs\/\d+|bibs\/\d+)\/?$/],
  ['api.dp.la',/^\/v2\/items\/?$/],
  ['api.europeana.eu',/^\/record\/v2\/(?:search\.json|[\w.-]+\/[\w.%-]+\.json)$/],
  ['www.googleapis.com',/^\/books\/v1\/volumes\/?$/]
]);

class RelayError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
function allowedURL(value,{archiveRedirect=false}={}){
  let url;try{url=new URL(value);}catch{throw new RelayError(400,'Supply a valid database URL.');}
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash)throw new RelayError(400,'Only HTTPS database URLs without credentials or custom ports are allowed.');
  const route=ROUTES.get(url.hostname);
  const archiveCDN=archiveRedirect&&/^ia\d+\.(?:us|ca)\.archive\.org$/.test(url.hostname)&&/^\/\d+\/items\/[\w.-]+\/[^/]+\.txt$/i.test(url.pathname);
  if(!(route?.test(url.pathname)||archiveCDN)||/%(?:2f|5c|00)/i.test(url.pathname))throw new RelayError(403,'This URL is outside the supported database endpoints.');
  return url;
}
function allowedHeaders(value,url){
  if(value===undefined)return {};
  if(!value||Array.isArray(value)||typeof value!=='object')throw new RelayError(400,'Database headers must be an object.');
  const headers={};
  for(const [key,entry]of Object.entries(value)){
    const name=key.toLowerCase();
    if(typeof entry!=='string'||entry.length>8192||/[\r\n\0]/.test(entry))throw new RelayError(400,'Invalid database header.');
    if(name==='accept')headers.Accept=entry;
    else if(name==='authorization'&&url.hostname==='metadata.api.oclc.org'&&/^Bearer \S+$/i.test(entry))headers.Authorization=entry;
    else if(name==='x-api-key'&&url.hostname==='api.europeana.eu')headers['X-Api-Key']=entry;
    else throw new RelayError(403,'This header is not supported for this database.');
  }
  return headers;
}
function localRequest(req,port){
  const host=req.headers.host;
  if(!['127.0.0.1:'+port,'localhost:'+port].includes(host))return false;
  if(req.headers.origin&&req.headers.origin!=='http://'+host)return false;
  return !['cross-site','same-site'].includes(req.headers['sec-fetch-site']);
}
function commonHeaders(res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
}
function sendError(res,status,message){
  if(res.destroyed||res.writableEnded)return;
  commonHeaders(res);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','X-Library-Relay-Error':'1'});res.end(JSON.stringify({error:message}));
}
async function readBody(req,maxBytes){
  const length=Number(req.headers['content-length']);
  if(Number.isFinite(length)&&length>maxBytes)throw new RelayError(413,'The metadata request is too large.');
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw new RelayError(413,'The metadata request is too large.');chunks.push(chunk);}
  let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RelayError(400,'The metadata request must contain valid JSON.');}
  if(!input||Array.isArray(input)||typeof input!=='object'||typeof input.url!=='string')throw new RelayError(400,'Supply a database URL.');
  return input;
}
async function readResponse(response,maxBytes){
  const declared=Number(response.headers.get('content-length'));
  if(declared>maxBytes){await response.body?.cancel();throw new RelayError(413,'The database response exceeds the 20 MB import limit.');}
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new RelayError(413,'The database response exceeds the 20 MB import limit.');}chunks.push(Buffer.from(value));}
    return Buffer.concat(chunks);
  }finally{reader.releaseLock();}
}
function createLibraryServer({fetchImpl=globalThis.fetch,htmlPath=path.join(__dirname,'library_semantic_search.html'),timeoutMs=22000,maxResponseBytes=20000000,maxRequestBytes=32768}={}){
  if(typeof fetchImpl!=='function')throw Error('Node.js 20 or newer is required.');
  const server=http.createServer(async(req,res)=>{
    commonHeaders(res);
    const port=server.address()?.port;
    if(!localRequest(req,port)){sendError(res,403,'Use the app served by this local helper. Requests from other websites are not accepted.');return;}
    let pathname;try{pathname=new URL(req.url,'http://127.0.0.1:'+port).pathname;}catch{sendError(res,400,'Invalid request URL.');return;}
    if((req.method==='GET'||req.method==='HEAD')&&['/','/library_semantic_search.html'].includes(pathname)){
      try{const html=await fs.readFile(htmlPath);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':html.length});res.end(req.method==='HEAD'?undefined:html);}catch{sendError(res,500,'The Library Search HTML file was not found beside the helper.');}return;
    }
    if(req.method==='GET'&&pathname==='/api/library-health'){
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({service:'library-search',version:1}));return;
    }
    if(pathname!=='/api/library-fetch'){sendError(res,404,'This helper serves only Library Search and its metadata API.');return;}
    if(req.method!=='POST'){res.setHeader('Allow','POST');sendError(res,405,'Metadata requests must use POST.');return;}
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){sendError(res,415,'Metadata requests must use application/json.');return;}
    const controller=new AbortController();let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
    const cancel=()=>{if(!res.writableEnded)controller.abort();};req.once('aborted',cancel);res.once('close',cancel);
    try{
      const input=await readBody(req,maxRequestBytes);let url=allowedURL(input.url),headers=allowedHeaders(input.headers,url);
      const archiveText=url.hostname==='archive.org'&&url.pathname.startsWith('/download/');
      let response;
      for(let redirects=0;redirects<=5;redirects++){
        response=await fetchImpl(url.href,{method:'GET',headers,redirect:'manual',signal:controller.signal});
        if(![301,302,303,307,308].includes(response.status))break;
        await response.body?.cancel();
        if(redirects===5)throw new RelayError(502,'The database redirected too many times.');
        const location=response.headers.get('location');if(!location)throw new RelayError(502,'The database returned a redirect without a destination.');
        const next=allowedURL(new URL(location,url).href,{archiveRedirect:archiveText});
        if(next.origin!==url.origin){if(headers.Authorization||headers['X-Api-Key']||[...url.searchParams.keys()].some(k=>/^(?:key|api_key|wskey)$/i.test(k)))throw new RelayError(502,'A credential-bearing database request redirected to another service.');headers=headers.Accept?{Accept:headers.Accept}:{};}
        url=next;
      }
      const body=await readResponse(response,maxResponseBytes);
      if(res.destroyed)return;
      res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/octet-stream','Content-Length':body.length});res.end(body);
    }catch(error){
      if(res.destroyed)return;
      if(error instanceof RelayError)sendError(res,error.status,error.message);
      else if(timedOut)sendError(res,504,'The database request timed out. Other selected sources can still be queried.');
      else if(controller.signal.aborted)sendError(res,499,'The metadata request was cancelled.');
      else sendError(res,502,'The local helper could not connect to the database. Check this computer’s internet connection and retry.');
    }finally{clearTimeout(timer);req.removeListener('aborted',cancel);res.removeListener('close',cancel);}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return server;
}
if(require.main===module){
  const args=process.argv.slice(2),index=args.indexOf('--port'),port=index===-1?8765:Number(args[index+1]);
  if(!Number.isInteger(port)||port<1||port>65535){console.error('Use --port with a number between 1 and 65535.');process.exitCode=1;}
  else{
    const server=createLibraryServer();
    server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port '+port+' is already in use. Close the existing helper, or choose another port with --port.':'The local helper could not start ('+(error.code||'unknown error')+').');process.exitCode=1;});
    server.listen(port,'127.0.0.1',()=>{
      const url='http://127.0.0.1:'+port+'/library_semantic_search.html';
      console.log('Library Search local helper\n'+url+'\nKeep this window open while using database lookups. Press Ctrl+C to stop.');
      if(args.includes('--open')&&process.platform==='win32'){
        const child=require('node:child_process').spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});child.on('error',()=>console.log('Open the URL above in your browser.'));child.unref();
      }
    });
  }
}
module.exports={createLibraryServer,allowedURL,allowedHeaders};
