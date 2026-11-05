'use strict';

// Run with: node --test tests/library_semantic_search.test.cjs
// These checks evaluate the actual inline modules in the distributable HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'library_semantic_search.html'), 'utf8');
const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].map(m => ({ attributes:m[1], code:m[2] }));
const moduleFiles = {core:'core.js',isbn:'isbn.js',views:'views.js',pdf:'pdf.js',sources:'sources.js'};
const globalNames = {core:'LibraryCore',isbn:'LibraryISBN',views:'LibraryViews',pdf:'LibraryPDF',sources:'LibrarySources'};

function load(name, extra={}) {
  const code = process.env.LIBRARY_TEST_MODULE_DIR
    ? fs.readFileSync(path.resolve(root, process.env.LIBRARY_TEST_MODULE_DIR, moduleFiles[name]), 'utf8')
    : inline.find(script => new RegExp('root\\.'+globalNames[name]+'\\s*=\\s*api').test(script.code))?.code;
  assert.ok(code, 'Missing inline module: '+name);
  const context = {module:{exports:{}}, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, console, ...extra};
  vm.runInNewContext(code, context, {filename:moduleFiles[name], timeout:5000});
  return context.module.exports;
}

const C = load('core');
const I = load('isbn', {LibraryCore:C});
const V = load('views');
const P = load('pdf', {LibraryCore:C});
const S = load('sources', {LibraryCore:C, LibraryISBN:I});
const plain = value => JSON.parse(JSON.stringify(value));
const unit = index => Array.from({length:384}, (_,i) => i===index ? 1 : 0);
function indexed(text, index=0) {
  return {text, source:'Test fixture', vector:unit(index), chunks:[{text, vector:unit(index)}], modelKey:C.MODEL_KEY};
}
function book(id='book-1', title='Collected research') {
  return {id,title,author:'Editor Example',isbn:'9780140328721',fields:Object.fromEntries(C.FIELDS.map(f => [f.id,C.emptyField()])),chapters:[]};
}
const weights = field => Object.fromEntries(C.FIELDS.map(f => [f.id,f.id===field ? 1 : 0]));
const ISBN='9780140328721';
const OTHER='9780439064873';

test('contents is replaced by bibliography in searchable fields', () => {
  assert.deepEqual(plain(C.FIELDS.map(f => f.id)), ['title','summary','bibliography','index','subjects','full_text']);
});

test('legacy snapshots retain summary and contents, invalidate only their joint vector, and migrate chapters', () => {
  const oldBook = book();
  oldBook.fields.title=indexed(oldBook.title);
  oldBook.fields.summary=indexed('An account of ecological systems.');
  oldBook.fields.contents=indexed('1. Climate\n2. Water',1);
  oldBook.fields.subjects=indexed('Ecology',1);
  delete oldBook.fields.bibliography;
  oldBook.chapters=[{id:'old-chapter',title:'Climate',fields:{title:indexed('Climate'),summary:indexed('Chapter overview'),contents:indexed('Local topics')}}];
  const saved={format:'personal-library-search',version:1,books:[oldBook]};
  C.validateSnapshot(saved);
  const migrated=saved.books[0];
  assert.match(migrated.fields.summary.text,/ecological systems/);
  assert.match(migrated.fields.summary.text,/1\. Climate/);
  assert.match(migrated.fields.summary.text,/2\. Water/);
  assert.equal(C.ready(migrated.fields.summary),false);
  assert.equal(C.ready(migrated.fields.title),true);
  assert.equal(C.ready(migrated.fields.subjects),true);
  assert.equal(migrated.fields.contents,undefined);
  assert.equal(migrated.fields.bibliography.text,'');
  assert.equal(migrated.chapters[0].parentId,migrated.id);
  assert.match(migrated.chapters[0].fields.summary.text,/Chapter overview/);
  assert.match(migrated.chapters[0].fields.summary.text,/Local topics/);
  assert.equal(migrated.chapters[0].fields.contents,undefined);
  const first=JSON.stringify(saved);
  C.validateSnapshot(saved);
  assert.equal(JSON.stringify(saved),first,'Repeated restores must not duplicate contents text.');
});

test('summary-only legacy vectors survive migration unchanged', () => {
  const b=book();
  b.fields.summary=indexed('A complete summary without a contents field.');
  const saved={format:'personal-library-search',version:1,books:[b]};
  C.validateSnapshot(saved);
  assert.equal(C.ready(saved.books[0].fields.summary),true);
});

test('catalog imports combine description and contents and retain cited sources', () => {
  const [b]=C.normalizeRows([{'Book Id':'1',Title:'Ecological research',Description:'A study of ecosystems.',Contents:'Climate; Water',Bibliography:'Smith, A. Ecology. 2020.'}], 'fixture.csv');
  assert.match(b.fields.summary.text,/study of ecosystems/);
  assert.match(b.fields.summary.text,/Climate; Water/);
  assert.match(b.fields.bibliography.text,/Smith, A/);
  assert.equal(b.fields.contents,undefined);
  assert.equal(C.ready(b.fields.summary),false);
});

test('bibliography similarity contributes independently and missing fields are excluded', () => {
  const b=book();
  b.fields.summary=indexed('Summary mentions water.',1);
  b.fields.bibliography=indexed('Climate Research, by A. Author.',0);
  assert.equal(C.scoreBook(b,unit(0),weights('bibliography')).score,1);
  assert.equal(C.scoreBook(b,unit(0),weights('summary')).score,0);
  const combined={...weights('summary'),bibliography:3};
  assert.equal(C.scoreBook(b,unit(0),combined).score,.75);
  b.fields.bibliography=C.emptyField();
  assert.equal(C.scoreBook(b,unit(0),combined).score,0,'An absent bibliography must not add weight to the denominator.');
  assert.equal(C.scoreBook(b,unit(0),weights('bibliography')).score,null);
});

test('chapters have stable identifiers, deduplicate across sources, and survive catalog merges and backups', () => {
  const b=book();
  const raw={title:'Climate and communities',author:'Chapter Author',summary:'Chapter-specific description',bibliography:'Jones. Climate change. 2022.'};
  C.mergeChapters(b,[raw]);
  assert.equal(b.chapters.length,1);
  const chapter=b.chapters[0], id=chapter.id;
  assert.equal(chapter.parentId,b.id);
  assert.equal(chapter.author,'Chapter Author');
  assert.match(chapter.fields.bibliography.text,/Jones/);
  C.mergeChapters(b,[{...raw,id:'different-provider-identifier'}]);
  assert.equal(b.chapters.length,1,'The same chapter title must not create duplicates on enrichment.');
  assert.equal(b.chapters[0].id,id);
  b.chapters[0].fields.summary=indexed('Chapter-specific description',0);
  const incoming=book(b.id,b.title);
  incoming.fields.title={...C.emptyField(),text:b.title};
  const merged=C.mergeBooks([b],[incoming]).books[0];
  assert.equal(merged.chapters.length,1);
  assert.equal(C.ready(merged.chapters[0].fields.summary),true);
  const saved=JSON.parse(JSON.stringify({format:'personal-library-search',version:2,books:[merged]}));
  C.validateSnapshot(saved);
  assert.equal(saved.books[0].chapters[0].id,id);
  assert.equal(C.ready(saved.books[0].chapters[0].fields.summary),true);
});

test('chapter fields are searchable without borrowing parent scores', () => {
  const b=book();
  b.fields.summary=indexed('Parent topic',1);
  C.mergeChapters(b,[{title:'An independent chapter'}]);
  b.chapters[0].fields.summary=indexed('Chapter topic',0);
  const entries=C.entries([b]);
  assert.equal(entries.length,2);
  const ranked=C.rank(entries,unit(0),weights('summary'));
  assert.equal(ranked[0].id,b.chapters[0].id);
  assert.equal(ranked[0].score,1);
  assert.equal(ranked[1].id,b.id);
  assert.equal(ranked[1].score,0);
  const compared=V.compare(entries,unit(0),unit(1),weights('summary'),C,'raw');
  assert.equal(compared.length,2);
  assert.equal(compared.find(p => p.id===b.chapters[0].id).rawX,1);
});

test('same-title chapters retain distinct positions and richer abstracts replace title-only stubs', () => {
  const b=book();
  C.mergeChapters(b,[{title:'Introduction',chapterNumber:1},{title:'Introduction',chapterNumber:4}]);
  assert.equal(b.chapters.length,2);
  assert.notEqual(b.chapters[0].id,b.chapters[1].id);
  assert.equal(b.chapters[0].author,'','The volume editor must not be assigned as an unknown chapter author.');
  const firstID=b.chapters[0].id;
  C.mergeChapters(b,[{title:'Introduction',chapterNumber:1,summary:'The first section introduces climate observations.',bibliography:'Ada. Climate observations. 2021.'},{title:'Introduction',chapterNumber:4,summary:'The fourth section introduces river systems.'}]);
  assert.equal(b.chapters.length,2);
  assert.equal(b.chapters[0].id,firstID);
  assert.match(b.chapters[0].fields.summary.text,/climate observations/);
  assert.match(b.chapters[1].fields.summary.text,/river systems/);
  assert.match(b.chapters[0].fields.bibliography.text,/Ada/);
});

test('PDF extraction separates chapter text and cited bibliography while embedding contents with summary', () => {
  const pages=[
    {number:1,text:'Abstract\nThis edited research volume describes climate, water, and human communities.'},
    {number:2,text:'Chapter 1\nClimate foundations\nClimate observations and communities are discussed in detail.'},
    {number:3,text:'The first chapter continues with ecological examples.\nReferences\nAda Author. Climate observations. 2021.'},
    {number:4,text:'Chapter 2\nWater systems\nWater circulation and rivers are discussed in this second chapter.'},
    {number:5,text:'The second chapter continues with watershed measurements and river processes.'},
    {number:6,text:'Bibliography\nSmith, B. Collected ecological studies. 2020.\nJones, C. River systems. 2019.'}
  ];
  const outline=[
    {title:'Abstract',page:1,depth:0},
    {title:'Part One',page:2,depth:0},
    {title:'Chapter 1: Climate foundations',page:2,depth:1},
    {title:'Chapter 2: Water systems',page:4,depth:1},
    {title:'Bibliography',page:6,depth:0}
  ];
  const proposal=P.analyze(pages,outline,{Title:'Collected ecological research',Author:'Example Editor'},'fixture.pdf');
  assert.equal(proposal.fields.contents,undefined);
  assert.match(proposal.fields.summary.text,/climate, water/);
  assert.match(proposal.fields.summary.text,/Climate foundations/);
  assert.match(proposal.fields.summary.text,/Water systems/);
  assert.match(proposal.fields.bibliography.text,/Smith, B/);
  assert.equal(proposal.chapters.length,2);
  const first=proposal.chapters[0];
  assert.match(first.fields.full_text.text,/Climate observations/);
  assert.doesNotMatch(first.fields.full_text.text,/Water circulation/);
  assert.doesNotMatch(first.title,/Part One|Abstract|Bibliography/);
  assert.match(first.fields.bibliography.text,/Ada Author/);
  assert.doesNotMatch(proposal.chapters[1].fields.full_text.text,/Smith, B/,'The volume bibliography must not be assigned to the last chapter.');
});

test('PDF contents pages can create chapter stubs without inventing chapter bodies or authors', () => {
  const proposal=P.analyze([
    {number:1,text:'Contents\nClimate communities ........ 1\nWater systems ........ 29\nBibliography ........ 70'},
    {number:2,text:'This book discusses ecological studies and their historical setting. The printed pagination differs from the PDF pages.'}
  ],[],{Title:'An edited research volume',Author:'Volume Editor'},'contents-only.pdf');
  assert.equal(proposal.chapters.length,2);
  assert.match(proposal.fields.summary.text,/Climate communities/);
  assert.equal(proposal.chapters[0].title,'Climate communities');
  assert.equal(proposal.chapters[0].author,'');
  assert.ok(!proposal.chapters[0].fields.full_text?.text);
  assert.equal(proposal.chapters[1].pageStart,'29');
});

test('metadata parsers reject a different edition ISBN', () => {
  assert.equal(S.google({items:[{id:'other',volumeInfo:{title:'Wrong edition',industryIdentifiers:[{identifier:OTHER}]}}]},ISBN,I),null);
  assert.equal(S.archive({metadata:{identifier:'other',title:'Wrong edition',isbn:[OTHER]}},ISBN,I),null);
  assert.equal(S.hasISBN(['ISBN 978-0-140-32872-1'],ISBN,I),true);
  assert.equal(S.hasISBN([OTHER],ISBN,I),false);
});

test('Internet Archive contents become joint summary text', () => {
  const proposal=S.archive({metadata:{identifier:'example',title:'A book',isbn:[ISBN],description:'The descriptive summary.',table_of_contents:'First chapter -- Second chapter'}},ISBN,I);
  assert.match(proposal.fields.summary.text,/descriptive summary/);
  assert.match(proposal.fields.summary.text,/First chapter/);
  assert.equal(proposal.fields.contents,undefined);
});

test('Crossref chapter records supply independent chapter metadata and cited sources', () => {
  const proposal=S.crossref({message:{items:[
    {type:'book',ISBN:[ISBN],title:['Edited studies'],DOI:'10.1234/book',author:[{given:'E.',family:'Editor'}]},
    {type:'book-chapter',ISBN:[ISBN],title:['Climate chapter'],DOI:'10.1234/chapter',author:[{given:'A.',family:'Author'}],abstract:'<p>An account of climate.</p>',reference:[{unstructured:'Smith, A. Climate and society. 2020.'},{DOI:'10.1234/cited','article-title':'A cited study',author:'Jones',year:'2019'}]},
    {type:'book-chapter',ISBN:[OTHER],title:['Unrelated chapter'],DOI:'10.9999/other'}
  ]}},ISBN,I);
  assert.ok(proposal);
  assert.equal(proposal.chapters.length,1);
  assert.match(proposal.chapters[0].title,/Climate chapter/);
  assert.match(proposal.fields.summary.text,/Climate chapter/);
  const text=JSON.stringify(proposal.chapters[0]);
  assert.match(text,/Smith, A/);
  assert.match(text,/10\.1234\/cited/);
  assert.doesNotMatch(JSON.stringify(proposal),/Unrelated chapter/);
});

test('applying chapter proposals preserves existing book text and never stores API options', () => {
  const b=book();
  b.fields.summary={...C.emptyField(),text:'An existing summary',manual:true};
  const proposal={fields:{bibliography:{text:'Author. A cited source. 2021.',source:'Crossref',provider:'Crossref'}},chapters:[{title:'A new chapter',summary:'An independent chapter summary'}],sources:[{provider:'Crossref',url:'https://doi.org/10.1234/example'}]};
  S.apply(b,proposal,['bibliography','chapters'],C);
  assert.equal(b.fields.summary.text,'An existing summary');
  assert.match(b.fields.bibliography.text,/cited source/);
  assert.equal(b.chapters.length,1);
  assert.equal(C.ready(b.fields.bibliography),false);
});

test('pipeline retains successful metadata when another provider fails', async () => {
  const calls=[];
  const client=new S.Client({interval:0,sleep:async()=>{},fetchImpl:async url => {
    calls.push(String(url));
    if(String(url).includes('hathitrust'))return {ok:true,headers:new Map(),json:async()=>({records:{record:{recordURL:'https://catalog.hathitrust.org/Record/1',titles:['Matched title'],isbns:[ISBN],marc:'<record/>'}},items:[]})};
    throw Error('Network request failed');
  }});
  const result=await client.lookup(ISBN,{I,archiveEnabled:false,locEnabled:true,hathiEnabled:true});
  assert.ok(calls.some(url=>url.includes('loc.gov')));
  assert.ok(calls.some(url=>url.includes('hathitrust')));
  assert.ok(result.warnings.some(value=>/Library of Congress|LOC/i.test(value)));
  assert.match(result.fields.title.text,/Matched title/);
});

test('aborting a source pipeline prevents subsequent provider requests', async () => {
  const controller=new AbortController(),calls=[];
  const client=new S.Client({interval:0,sleep:async()=>{},fetchImpl:async url => {calls.push(String(url));controller.abort();throw Error('Aborted request');}});
  await assert.rejects(client.lookup(ISBN,{I,archiveEnabled:false,locEnabled:true,hathiEnabled:true,crossrefEnabled:true,signal:controller.signal}),/stop|abort/i);
  assert.equal(calls.length,1);
});

test('credentials required by selected providers are reported without echoing supplied secrets', async () => {
  const secret='fixture-session-secret-must-not-be-persisted';
  const client=new S.Client({interval:0,sleep:async()=>{},fetchImpl:async url=>{throw Error('Request unavailable at '+url+' credential='+secret);}});
  const result=await client.lookup(ISBN,{I,archiveEnabled:false,googleEnabled:true,googleKey:secret,worldcatEnabled:true,worldcatToken:secret,dplaEnabled:true,dplaKey:secret,europeanaEnabled:true,europeanaKey:secret});
  assert.ok(result.warnings.length>=4);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
});

test('OAPEN and DOAB metadata preserve abstracts, contents and cited references with exact ISBN matching', () => {
  const data=[{handle:'20.500.12657/example',metadata:[
    {key:'dc.identifier.isbn',value:ISBN},
    {key:'dc.title',value:'Open ecological research'},
    {key:'dc.description.abstract',value:'An openly published account of ecology.'},
    {key:'dc.description.tableofcontents',value:'Climate communities\nWater systems'},
    {key:'dc.relation.references',value:'Smith. Ecology. 2020.'},
    {key:'dc.subject',value:'Ecology'},
    {key:'dc.contributor.author',value:'Example Author'}
  ]}];
  for(const provider of ['OAPEN','DOAB']){
    const result=S.repository(data,ISBN,I,{provider,url:'https://example.org/books'});
    assert.match(result.fields.summary.text,/openly published/);
    assert.match(result.fields.summary.text,/Climate communities/);
    assert.match(result.fields.bibliography.text,/Smith/);
    assert.match(result.fields.subjects.text,/Ecology/);
    assert.equal(result.chapters.length,2);
    assert.equal(result.author,'Example Author');
    assert.equal(S.repository(data,OTHER,I,{provider}),null);
  }
});

test('DPLA and Europeana matching requires edition identifiers before accepting descriptions', () => {
  const dpla={docs:[{id:'matched',isShownAt:'https://example.org/catalog/1',sourceResource:{identifier:['ISBN '+ISBN],title:'Ecological research',description:'A catalog description.',subject:[{name:'Ecology'}]}},{id:'wrong',sourceResource:{identifier:[OTHER],title:'Unrelated record'}}]};
  const dplaResult=S.dpla(dpla,ISBN,I);
  assert.match(dplaResult.fields.title.text,/Ecological research/);
  assert.match(dplaResult.fields.summary.text,/catalog description/);
  assert.doesNotMatch(JSON.stringify(dplaResult),/Unrelated record/);
  const europeana={object:{about:'/example/matched',proxies:[{dcIdentifier:{def:['ISBN '+ISBN]},dcTitle:{en:['Ecological history']},dcDescription:{en:['Historical ecology description.']},dcSubject:{en:['Ecology']}}]}};
  const europeanaResult=S.europeana(europeana,ISBN,I);
  assert.match(europeanaResult.fields.title.text,/Ecological history/);
  assert.match(europeanaResult.fields.summary.text,/Historical ecology/);
  assert.equal(S.europeana(europeana,OTHER,I),null);
});

test('MARC catalog mapping extracts summary, contents and subjects while rejecting wrong ISBNs', async t => {
  const runtime=process.env.LIBRARY_TEST_HAPPY_DOM || path.join(os.homedir(),'.codex','skills','local-web-testing','runtime','node_modules','happy-dom','lib','index.js');
  if(!fs.existsSync(runtime))return t.skip('Set LIBRARY_TEST_HAPPY_DOM to a Happy DOM module to exercise XML parsing.');
  const {Window}=await import(pathToFileURL(runtime).href),window=new Window();
  try {
    const X=load('sources',{LibraryCore:C,LibraryISBN:I,DOMParser:window.DOMParser});
    const xml=`<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><records><record><recordData><record xmlns="http://www.loc.gov/MARC21/slim"><controlfield tag="001">12345</controlfield><datafield tag="020"><subfield code="a">${ISBN}</subfield></datafield><datafield tag="245"><subfield code="a">Collected research</subfield></datafield><datafield tag="520"><subfield code="a">A study of ecological systems.</subfield></datafield><datafield tag="505"><subfield code="t">Climate foundations</subfield><subfield code="t">Water systems</subfield></datafield><datafield tag="650"><subfield code="a">Ecology</subfield><subfield code="x">Research</subfield></datafield><datafield tag="504"><subfield code="a">Includes bibliographical references.</subfield></datafield></record></recordData></record></records></searchRetrieveResponse>`;
    const proposal=X.marc(xml,ISBN,I,{provider:'Library of Congress',url:'https://catalog.loc.gov/example'});
    assert.ok(proposal);
    assert.match(proposal.fields.summary.text,/ecological systems/);
    assert.match(proposal.fields.summary.text,/Climate foundations/);
    assert.match(proposal.fields.subjects.text,/Ecology/);
    assert.equal(proposal.fields.contents,undefined);
    assert.ok(!proposal.fields.bibliography?.text,'A note saying references exist is not a list of cited sources.');
    assert.equal(X.marc(xml,OTHER,I,{provider:'Library of Congress',url:'https://catalog.loc.gov/example'}),null);
  } finally {await window.happyDOM.close();}
});

test('results expose independent chapter details, edits, filters, comparison, and exports', async t => {
  if(process.env.LIBRARY_TEST_MODULE_DIR)return t.skip('UI checks use the assembled distributable HTML.');
  const skill=process.env.LIBRARY_TEST_SKILL_DIR || path.join(os.homedir(),'.codex','skills','local-web-testing');
  const harnessFile=path.join(skill,'scripts','harness.mjs');
  if(!fs.existsSync(harnessFile))return t.skip('Install the local-web-testing skill or set LIBRARY_TEST_SKILL_DIR to exercise the interface.');
  const {createHarness}=await import(pathToFileURL(harnessFile).href);
  const b=book('fixture-parent','An edited research volume');
  b.fields.title=indexed(b.title,1);
  b.fields.summary=indexed('Parent overview of the research collection.',1);
  C.mergeChapters(b,[{title:'Climate and communities',author:'Chapter Writer',summary:'Chapter climate evidence.',bibliography:'Original cited climate research. 2020.'}]);
  const chapter=b.chapters[0];
  chapter.fields.summary=indexed('Chapter climate evidence.',0);
  chapter.fields.bibliography=indexed('Original cited climate research. 2020.',0);
  const seed=JSON.parse(inline.find(script=>/id="initial-data"/.test(script.attributes)).code);
  const snapshot={...seed,version:2,starterCatalog:false,books:[b],weights:weights('summary'),lastQuery:{query:'Climate',vector:unit(0),modelKey:C.MODEL_KEY},comparison:{xQuery:'Climate',yQuery:'Other topic',xVector:unit(0),yVector:unit(1),modelKey:C.MODEL_KEY}};
  const fixture=html.replace(/(<script id="initial-data" type="application\/json">)[\s\S]*?(<\/script>)/,(_,open,close)=>open+JSON.stringify(snapshot).replace(/</g,'\\u003c')+close);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'library-search-regression-'));
  const target=path.join(temp,'fixture.html');
  fs.writeFileSync(target,fixture,'utf8');
  let h;
  try {
    h=await createHarness({target});
    assert.deepEqual(h.errors,[]);
    assert.equal(h.blockedRequests.length,0);
    // The shared harness removes inert text/plain scripts as well as executable
    // scripts. Restore this actual source element before the mocked index run.
    const workerSource=inline.find(script=>/id="embedding-worker"/.test(script.attributes));
    assert.ok(workerSource,'Distributable must contain its embedding worker source.');
    const inertWorker=h.document.createElement('script');
    inertWorker.id='embedding-worker';inertWorker.type='text/plain';inertWorker.textContent=workerSource.code;
    h.document.body.append(inertWorker);
    assert.match(h.$('#chapter-count').textContent,/1/);
    const disclosure=h.$('details.chapter-dropdown[data-chapters="'+b.id+'"]');
    assert.ok(disclosure,'Book result needs a chapter dropdown.');
    disclosure.open=true;
    h.click('[data-select-chapter="'+chapter.id+'"]');
    assert.match(h.$('#details').textContent,/Chapter Writer/);
    assert.match(h.$('#details').textContent,/Chapter climate evidence/);
    assert.match(h.$('#details').textContent,/Original cited climate research/);
    h.click('#details [data-edit]');
    h.$('#edit-field').value='bibliography';
    h.$('#edit-field').dispatchEvent(new h.window.Event('change',{bubbles:true}));
    h.$('#edit-text').value='Revised cited research. 2024.';
    h.$('#edit-form').dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
    const downloads=[];
    h.window.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:regression-fixture';};
    h.window.URL.revokeObjectURL=()=>{};
    h.window.HTMLAnchorElement.prototype.click=()=>{};
    const credentials={
      'material-key':'fixture-google-session-secret',
      'material-worldcat-token':'fixture-worldcat-session-secret',
      'material-dpla-key':'fixture-dpla-session-secret',
      'material-europeana-key':'fixture-europeana-session-secret'
    };
    for(const [id,value]of Object.entries(credentials))h.$('#'+id).value=value;
    h.click('#backup-btn');
    const backupText=await downloads.at(-1).text();
    for(const secret of Object.values(credentials))assert.ok(!backupText.includes(secret),'Export data must omit session credentials.');
    const exported=JSON.parse(backupText);
    const savedChapter=exported.books[0].chapters[0];
    assert.equal(savedChapter.fields.bibliography.text,'Revised cited research. 2024.');
    assert.equal(C.ready(savedChapter.fields.bibliography),false);
    assert.equal(C.ready(savedChapter.fields.summary),true,'Editing bibliography must preserve the chapter summary vector.');
    assert.equal(exported.books[0].fields.summary.text,b.fields.summary.text);
    const embedded=[];
    h.window.LibraryEmbeddingClient=class {
      async request(task,items) {
        assert.equal(task,'embed');
        embedded.push(...items.map(item=>item.text));
        return items.map(item=>({...item,vector:unit(0)}));
      }
    };
    h.click('#build-btn');
    for(let attempt=0;attempt<100 && h.$('#pause-btn').hidden===false;attempt++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.ok(embedded.includes('Revised cited research. 2024.'),'Indexing must send the chapter bibliography text to the embedding client. '+JSON.stringify({embedded,status:h.$('#status-title').textContent,notice:h.$('#notice').textContent,disabled:h.$('#build-btn').disabled}));
    assert.ok(!embedded.includes('Chapter climate evidence.'),'Already indexed chapter summaries must be reused.');
    assert.match(h.$('#status-title').textContent,/ready/i);
    h.click('#backup-btn');
    const indexedBackup=JSON.parse(await downloads.at(-1).text());
    assert.equal(C.ready(indexedBackup.books[0].chapters[0].fields.bibliography),true);
    h.$('#filter').value='Climate and communities';
    h.$('#filter').dispatchEvent(new h.window.Event('input',{bubbles:true}));
    assert.ok(h.$('[data-book="'+b.id+'"]'),'Chapter-title filters must retain the parent row.');
    assert.equal(h.$('details[data-chapters="'+b.id+'"]').open,true);
    h.click('#csv-btn');
    const csv=await downloads.at(-1).text();
    assert.match(csv,new RegExp(chapter.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.match(csv,/bibliography/);
    h.click('#view-comparison');
    assert.ok(h.$('[data-point="'+chapter.id+'"]'),'Chapter must appear in the two-query comparison.');
    h.click('#save-applet-btn');
    const savedApplet=await downloads.at(-1).text();
    assert.match(savedApplet,/Revised cited research\. 2024\./);
    for(const secret of Object.values(credentials))assert.ok(!savedApplet.includes(secret),'Save applet must omit session credentials from the HTML and embedded data.');
    h.click('#view-ranking');
    h.click('#details [data-parent-book]');
    h.click('#details [data-chapter-add]');
    h.$('#chapter-title').value='References';
    h.$('#chapter-form').dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));
    assert.equal(h.$('#chapter-dialog').open,true,'A bibliography section name must not create an invalid chapter.');
    assert.match(h.$('#notice').textContent,/chapter title/i);
    assert.match(h.$('#chapter-count').textContent,/1/);
    h.$('#chapter-dialog').close();
    assert.deepEqual(h.errors,[]);
  } finally {
    if(h)await h.close();
    const tempRoot=path.resolve(os.tmpdir())+path.sep;
    assert.ok(path.resolve(temp).startsWith(tempRoot),'Cleanup target must remain inside the temporary directory.');
    fs.rmSync(temp,{recursive:true,force:true});
  }
});

test('bulk enrichment reaches every ISBN after Open Library failure and enriches duplicate catalog copies', async t => {
  if(process.env.LIBRARY_TEST_MODULE_DIR)return t.skip('UI checks use the assembled distributable HTML.');
  const skill=process.env.LIBRARY_TEST_SKILL_DIR || path.join(os.homedir(),'.codex','skills','local-web-testing');
  const harnessFile=path.join(skill,'scripts','harness.mjs');
  if(!fs.existsSync(harnessFile))return t.skip('Install the local-web-testing skill or set LIBRARY_TEST_SKILL_DIR to exercise the interface.');
  const {createHarness}=await import(pathToFileURL(harnessFile).href);
  const first=book('fixture-copy-one','First catalog copy'),second=book('fixture-copy-two','Second catalog copy');
  first.fields.title=indexed(first.title,1);second.fields.title=indexed(second.title,1);
  const seed=JSON.parse(inline.find(script=>/id="initial-data"/.test(script.attributes)).code);
  const snapshot={...seed,version:2,starterCatalog:false,books:[first,second],lastQuery:null,comparison:null,queryCache:{}};
  const fixture=html.replace(/(<script id="initial-data" type="application\/json">)[\s\S]*?(<\/script>)/,(_,open,close)=>open+JSON.stringify(snapshot).replace(/</g,'\\u003c')+close);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'library-search-bulk-regression-'));
  const target=path.join(temp,'fixture.html');fs.writeFileSync(target,fixture,'utf8');
  let h;
  try {
    h=await createHarness({target});
    assert.deepEqual(h.errors,[]);
    const requested=[];
    h.window.LibraryISBN.LookupClient=class {async lookup(){throw Error('Fixture Open Library is unavailable.');}};
    h.window.LibrarySources.Client=class {async lookup(isbn){requested.push(isbn);return {
      fields:{title:{text:'Fetched title '+isbn,source:'Fixture provider'},summary:{text:'A fetched description for '+isbn,source:'Fixture provider'},bibliography:{text:'Cited ecological source for '+isbn,source:'Fixture provider'}},
      chapters:[{title:'A fetched chapter',summary:'Chapter-specific description for '+isbn}],
      sources:[{provider:'Fixture provider',url:'https://example.org/book/'+isbn}],warnings:[]
    };}};
    const extra=Array.from({length:20},(_,i)=>{
      const body='978000000'+String(i).padStart(3,'0');
      const sum=[...body].reduce((total,digit,index)=>total+Number(digit)*(index%2?3:1),0);
      return body+(10-sum%10)%10;
    });
    const isbns=[ISBN,...extra];
    h.click('#isbn-btn');
    h.$('#isbn-input').value=isbns.join('\n');
    h.$('#isbn-enrich').checked=true;
    h.click('#isbn-fetch');
    for(let attempt=0;attempt<1000 && h.$('#isbn-fetch').disabled;attempt++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(h.$('#isbn-fetch').disabled,false,'Bulk lookup must finish.');
    assert.deepEqual(requested,isbns,'An unavailable Open Library must not stop the other sources after the first batch.');
    h.$('#isbn-dialog').close();
    const downloads=[];
    h.window.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:bulk-regression-fixture';};
    h.window.URL.revokeObjectURL=()=>{};h.window.HTMLAnchorElement.prototype.click=()=>{};
    h.click('#backup-btn');
    const exported=JSON.parse(await downloads.at(-1).text());
    const copies=exported.books.filter(b=>b.isbn===ISBN);
    assert.equal(copies.length,2);
    for(const copy of copies){
      assert.match(copy.fields.bibliography.text,/Cited ecological source/);
      assert.equal(copy.chapters.length,1,'Every existing catalog copy with this ISBN must receive chapter metadata.');
    }
    assert.equal(exported.books.length,22);
    const fetched=exported.books.find(b=>b.isbn===extra[0]);
    assert.equal(fetched.title,'Fetched title '+extra[0],'Successful fallback metadata must replace an unresolved ISBN title.');
    assert.match(fetched.fields.summary.text,/fetched description/);
    assert.deepEqual(h.errors,[]);
    assert.equal(h.blockedRequests.length,0);
  } finally {
    if(h)await h.close();
    const tempRoot=path.resolve(os.tmpdir())+path.sep;
    assert.ok(path.resolve(temp).startsWith(tempRoot),'Cleanup target must remain inside the temporary directory.');
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
