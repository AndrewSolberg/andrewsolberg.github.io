'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const http=require('node:http');
const {createLibraryServer,allowedURL,allowedHeaders}=require('../library_search_server.cjs');

const LOC='https://lx2.loc.gov/sru/lcdb?query=bath.isbn%3D9780262621632';
async function local(t,options={}){
  const server=createLibraryServer(options);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port;
  return {server,base,post:(body,headers={})=>fetch(base+'/api/library-fetch',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})};
}

test('helper serves the app and health but no repository or arbitrary static files',async t=>{
  const {base}=await local(t,{fetchImpl:async()=>{throw Error('No upstream expected');}});
  const health=await fetch(base+'/api/library-health');
  assert.deepEqual(await health.json(),{service:'library-search',version:1});
  assert.equal(health.headers.get('access-control-allow-origin'),null);
  const page=await fetch(base+'/library_semantic_search.html');assert.equal(page.status,200);assert.match(await page.text(),/<title>Library Search<\/title>/);
  const head=await fetch(base+'/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  for(const route of ['/.git/config','/README.md','/library_search_server.cjs','/api/elsewhere'])assert.equal((await fetch(base+route)).status,404);
});
test('relay returns raw XML and forwards only the intended metadata GET',async t=>{
  const calls=[];const {base,post}=await local(t,{fetchImpl:async(url,options)=>{calls.push({url,options});return new Response('<records>catalog metadata</records>',{headers:{'Content-Type':'application/xml'}});}});
  const response=await post({url:LOC,headers:{Accept:'application/xml'}},{Origin:base,'Sec-Fetch-Site':'same-origin'});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/xml/);assert.equal(await response.text(),'<records>catalog metadata</records>');
  assert.equal(calls[0].url,LOC);assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'manual');assert.deepEqual(calls[0].options.headers,{Accept:'application/xml'});
  assert.equal(response.headers.get('cache-control'),'no-store');
});
test('upstream errors retain their status and body instead of becoming no-match results',async t=>{
  const {post}=await local(t,{fetchImpl:async()=>new Response('{"error":"token expired"}',{status:401,headers:{'Content-Type':'application/json'}})});
  const response=await post({url:'https://metadata.api.oclc.org/worldcat/search/brief-bibs?q=bn%3A9780262621632',headers:{Authorization:'Bearer fixture-token'}});
  assert.equal(response.status,401);assert.equal(response.headers.get('x-library-relay-error'),null);assert.deepEqual(await response.json(),{error:'token expired'});
});
test('helper rejects cross-origin pages, file origins and rebinding hosts without upstream requests',async t=>{
  let calls=0;const {base,post}=await local(t,{fetchImpl:async()=>{calls++;return new Response('{}');}});
  for(const headers of [{Origin:'https://example.org'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':'same-site'},{Host:'attacker.example'}]){
    // Use raw HTTP so fetch cannot rewrite forbidden Host/Sec-Fetch headers.
    const response=await new Promise((resolve,reject)=>{const request=http.request(base+'/api/library-fetch',{method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));});request.on('error',reject);request.end(JSON.stringify({url:LOC}));});
    assert.equal(response.status,403,JSON.stringify(headers));assert.equal(response.headers['access-control-allow-origin'],undefined);
  }
  assert.equal((await fetch(base+'/api/library-health',{headers:{Origin:'https://example.org'}})).status,403);assert.equal(calls,0);
});
test('URL allowlist rejects non-database hosts, custom ports, credentials and private destinations',()=>{
  for(const url of ['http://lx2.loc.gov/sru/lcdb','https://127.0.0.1/api','https://localhost/api','https://lx2.loc.gov:444/sru/lcdb','https://user:pass@lx2.loc.gov/sru/lcdb','https://lx2.loc.gov.evil.example/sru/lcdb','https://archive.org/anything','https://openlibrary.org/','file:///C:/Users/andre/.git/config','https://lx2.loc.gov/sru/lcdb#secret'])assert.throws(()=>allowedURL(url));
  assert.equal(allowedURL(LOC).hostname,'lx2.loc.gov');
  assert.equal(allowedURL('https://archive.org/download/book-id/book-id_djvu.txt').hostname,'archive.org');
});
test('relay does not accept arbitrary methods, headers, bodies or malformed JSON',async t=>{
  let calls=0;const {base,post}=await local(t,{maxRequestBytes:512,fetchImpl:async()=>{calls++;return new Response('{}');}});
  assert.equal((await fetch(base+'/api/library-fetch')).status,405);
  assert.equal((await fetch(base+'/api/library-fetch',{method:'POST',body:'x'})).status,415);
  assert.equal((await fetch(base+'/api/library-fetch',{method:'POST',headers:{'Content-Type':'application/json'},body:'{broken'})).status,400);
  assert.equal((await post({url:LOC,headers:{Cookie:'session=private'}})).status,403);
  assert.equal((await post({url:LOC,headers:{Authorization:'Bearer secret'}})).status,403);
  assert.equal((await post({url:LOC,headers:{Accept:'x\r\nCookie: private'}})).status,400);
  assert.equal((await post({url:LOC,padding:'x'.repeat(600)})).status,413);assert.equal(calls,0);
});
test('credential headers are confined to their own provider',()=>{
  assert.deepEqual(allowedHeaders({Authorization:'Bearer token'},allowedURL('https://metadata.api.oclc.org/worldcat/bibs/123')),{Authorization:'Bearer token'});
  assert.deepEqual(allowedHeaders({'X-Api-Key':'key'},allowedURL('https://api.europeana.eu/record/v2/search.json')),{'X-Api-Key':'key'});
  assert.throws(()=>allowedHeaders({'X-Api-Key':'key'},allowedURL(LOC)));
});
test('redirects are checked before a second upstream request',async t=>{
  const calls=[];const {post}=await local(t,{fetchImpl:async url=>{calls.push(url);return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}});}});
  const response=await post({url:LOC});assert.equal(response.status,400);assert.equal(calls.length,1);assert.equal(response.headers.get('x-library-relay-error'),'1');
});
test('credential-bearing requests cannot redirect across provider origins',async t=>{
  let calls=0;const {post}=await local(t,{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{Location:LOC}});}});
  const response=await post({url:'https://metadata.api.oclc.org/worldcat/bibs/123',headers:{Authorization:'Bearer secret'}});
  assert.equal(response.status,502);assert.equal(calls,1);assert.doesNotMatch(await response.text(),/secret/);
});
test('public Archive OCR redirect can reach only its narrowly allowed CDN',async t=>{
  const calls=[];const {post}=await local(t,{fetchImpl:async url=>{calls.push(url);return calls.length===1?new Response(null,{status:302,headers:{Location:'https://ia800123.us.archive.org/12/items/book-id/book-id_djvu.txt'}}):new Response('public OCR text');}});
  const response=await post({url:'https://archive.org/download/book-id/book-id_djvu.txt'});assert.equal(response.status,200);assert.equal(await response.text(),'public OCR text');assert.equal(calls.length,2);
  assert.throws(()=>allowedURL('https://evil.us.archive.org/12/items/book-id/book.txt',{archiveRedirect:true}));
  assert.throws(()=>allowedURL('https://ia800123.us.archive.org/12/items/book-id/book.txt'));
});
test('oversized upstream streams are stopped and reported',async t=>{
  const {post}=await local(t,{maxResponseBytes:16,fetchImpl:async()=>new Response('x'.repeat(30))});
  const response=await post({url:LOC});assert.equal(response.status,413);assert.equal(response.headers.get('x-library-relay-error'),'1');
});
test('upstream timeout is reported without leaking request credentials',async t=>{
  const {post}=await local(t,{timeoutMs:30,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error(url)),{once:true});})});
  const response=await post({url:'https://www.googleapis.com/books/v1/volumes?key=private-key&q=isbn:9780262621632'});
  assert.equal(response.status,504);const body=await response.text();assert.match(body,/timed out/);assert.doesNotMatch(body,/private-key/);
});
test('network failure reports a helper error without request URLs or keys',async t=>{
  const {post}=await local(t,{fetchImpl:async url=>{throw Error(url);}});
  const response=await post({url:'https://www.googleapis.com/books/v1/volumes?key=private-key&q=isbn:9780262621632'});
  assert.equal(response.status,502);assert.equal(response.headers.get('x-library-relay-error'),'1');assert.doesNotMatch(await response.text(),/private-key/);
});
