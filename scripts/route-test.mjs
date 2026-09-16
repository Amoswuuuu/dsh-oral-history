// Route-level test: exercises every /oral-history/* handler against a REAL store,
// with fake req/res. This is what caught the prefix-route rest-slicing bug that
// left every sub-resource route (/sources/:id, /cards/:id, ...) returning 404.
import { registerOralHistoryRoutes } from '../dist/routes.js';
// Exercise the real handlers against a fake req/res and a real store.
import { OralHistoryStore } from '../dist/store.js';
import { createSource, createInterview } from '../dist/domain.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'probe-'));
const store = new OralHistoryStore(dir);
await store.init();
const src = createSource({ title:'口述访谈：测试', tier:'primary', primaryKind:'oral-history', provenance:{repository:'R',callNumber:'C1'}, source:'manual' });
await store.upsertSource(src);
const iv = createInterview({ sourceId: src.id, interviewee:{ name:'张三' } });
await store.upsertInterview(iv);

const routes = [];
const fakeCtx = { effect(fn){ fn(); }, webServer:{ register(r){ routes.push(r); return ()=>{}; } } };
registerOralHistoryRoutes(fakeCtx, async () => store, () => ({ defaultLanguage:'zh' }), async () => {});
const find = (kind, path) => routes.find(r => r.kind===kind && r.path===path);

function fakeReq(method, url, body) {
  const r = new Readable({ read(){} });
  if (body) r.push(body);
  r.push(null);
  r.method = method; r.url = url;
  r.headers = { 'content-type':'application/json' };
  r.socket = { remoteAddress: '127.0.0.1' };
  return r;
}
function fakeRes() {
  return { statusCode: 0, headers: {}, body: '', raw: '',
    setHeader(k,v){ this.headers[k]=v; },
    write(c){ this.raw += Buffer.isBuffer(c) ? c.toString('utf8') : String(c); return true; },
    end(b){ if (b !== undefined && b !== null) this.raw += Buffer.isBuffer(b) ? b.toString('utf8') : String(b); this.body = this.raw; },
    destroy(){}, on(){}, once(){},
    get headersSent(){ return this.statusCode !== 0; } };
}
async function call(kind, path, method, url, body) {
  const r = find(kind, path);
  if (!r) throw new Error(`route not found: ${kind} ${path}`);
  const req = fakeReq(method, url, body);
  const res = fakeRes();
  await r.handler(req, res);
  let parsed; try { parsed = JSON.parse(res.body); } catch { parsed = res.body; }
  return { code: res.statusCode, body: parsed, raw: res.raw };
}

const P = '/oral-history';
const enc = encodeURIComponent;
let pass=0, fail=0;
const check=(n,c,d='')=>{ if(c){pass++;console.log('  ✅',n);} else {fail++;console.log('  ❌',n,d);} };

let r = await call('prefix', `${P}/interviews`, 'GET', `${P}/interviews/${iv.id}`);
check('GET /interviews/:id', r.code===200 && r.body.interview?.id===iv.id, JSON.stringify(r.body).slice(0,120));

r = await call('prefix', `${P}/sources`, 'GET', `${P}/sources/${enc(src.id)}`);
check('GET /sources/:id (CJK id)', r.code===200 && r.body.source?.id===src.id, JSON.stringify(r.body).slice(0,120));

r = await call('prefix', `${P}/transcripts`, 'POST', `${P}/transcripts/by-interview/${iv.id}`,
  JSON.stringify({ segments:[{start:0,end:10,speaker:'interviewee',text:'测试内容',status:'raw'}] }));
check('POST /transcripts/by-interview/:id', r.code===201 && r.body.transcript?.segments?.length===1, JSON.stringify(r.body).slice(0,160));
const tid = r.body.transcript?.id; const segId = r.body.transcript?.segments?.[0]?.id;

r = await call('prefix', `${P}/transcripts`, 'PUT', `${P}/transcripts/${tid}`,
  JSON.stringify({ segmentId: segId, patch:{ text:'测试内容（已校）', status:'human-verified' } }));
check('PUT /transcripts/:id segment patch', r.code===200 && r.body.transcript?.verifiedRatio===1, JSON.stringify(r.body).slice(0,160));
check('rawText 对照保留', r.body.transcript?.segments?.[0]?.rawText==='测试内容');

r = await call('prefix', `${P}/transcripts`, 'GET', `${P}/transcripts/by-interview/${iv.id}`);
check('GET /transcripts/by-interview/:id', r.code===200 && r.body.transcript?.id===tid);

r = await call('exact', `${P}/cards`, 'POST', `${P}/cards`,
  JSON.stringify({ title:'测试卡', kind:'extract', content:'内容', sourceId: src.id, interviewId: iv.id, citation: segId }));
check('POST /cards', r.code===201 && r.body.card?.id, JSON.stringify(r.body).slice(0,120));
const cid = r.body.card?.id;

r = await call('prefix', `${P}/cards`, 'GET', `${P}/cards/${cid}`);
check('GET /cards/:id + backlinks', r.code===200 && r.body.card?.id===cid && Array.isArray(r.body.backlinks));

r = await call('prefix', `${P}/cards`, 'PUT', `${P}/cards/${cid}`, JSON.stringify({ status:'corroborated', importance:5 }));
check('PUT /cards/:id', r.code===200 && r.body.card?.status==='corroborated');

r = await call('exact', `${P}/collections`, 'POST', `${P}/collections`, JSON.stringify({ name:'航天史专题' }));
check('POST /collections', r.code===201 && r.body.collection?.id, JSON.stringify(r.body).slice(0,120));
const colId = r.body.collection?.id;

r = await call('prefix', `${P}/collections`, 'PUT', `${P}/collections/${colId}`, JSON.stringify({ color:'#4d6bfe' }));
check('PUT /collections/:id', r.code===200 && r.body.collection?.color==='#4d6bfe');

r = await call('exact', `${P}/graph`, 'GET', `${P}/graph`);
check('GET /graph', r.code===200 && Array.isArray(r.body.nodes) && r.body.nodes.length>0, `nodes=${r.body.nodes?.length}`);

r = await call('exact', `${P}/graph/sync`, 'POST', `${P}/graph/sync`);
check('POST /graph/sync', r.code===200 && r.body.ok, JSON.stringify(r.body).slice(0,120));

r = await call('exact', `${P}/export/interview`, 'GET', `${P}/export/interview?id=${iv.id}`);
check('GET /export/interview', r.code===200 && r.body.markdown?.includes('张三') && r.body.markdown?.includes('测试内容（已校）'), JSON.stringify(r.body).slice(0,160));

r = await call('exact', `${P}/export/cards`, 'GET', `${P}/export/cards`);
check('GET /export/cards', r.code===200 && r.body.count===1, JSON.stringify(r.body).slice(0,120));

r = await call('prefix', `${P}/cards`, 'DELETE', `${P}/cards/${cid}`);
check('DELETE /cards/:id', r.code===200 && r.body.ok && store.cards.size===0);

r = await call('prefix', `${P}/interviews`, 'GET', `${P}/interviews/does-not-exist`);
check('不存在的访谈返回 404', r.code===404);

/* ---------- 录音路由 ----------
 * 用真实 http 服务器验证：createReadStream().pipe(res) 需要真实的 ServerResponse，
 * 伪 res 无法驱动流（这一点本身也是一条教训——附件路由必须走真 HTTP 才测得准）。
 */
await mkdir(join(dir, 'attachments'), { recursive: true });
await writeFile(join(dir, 'attachments', 'src-tape.mp3'), Buffer.from('SRC-AUDIO'));
await writeFile(join(dir, 'attachments', 'iv-tape.m4a'), Buffer.from('IV-AUDIO'));

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;
  const hit = routes.find((rt) =>
    rt.kind === 'exact' ? rt.path === pathname : (pathname === rt.path || pathname.startsWith(`${rt.path}/`)));
  if (!hit) { res.writeHead(404); res.end(); return; }
  Promise.resolve(hit.handler(req, res)).catch(() => { res.writeHead(500); res.end(); });
});
await new Promise((r2) => server.listen(0, '127.0.0.1', r2));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => {
  const resp = await fetch(base + p);
  return { code: resp.status, type: resp.headers.get('content-type') ?? '', text: await resp.text() };
};

let g = await get(`${P}/interviews/${iv.id}/audio`);
check('无录音时 /interviews/:id/audio 返回 404', g.code === 404, `code=${g.code}`);

await store.upsertSource({ ...store.sources.get(src.id), filePath: 'attachments/src-tape.mp3', updatedAt: Date.now() });
g = await get(`${P}/interviews/${iv.id}/audio`);
check('回落到史料附件可取到录音', g.code === 200 && g.text === 'SRC-AUDIO', `code=${g.code} body=${g.text}`);
check('音频 content-type 正确 (mp3)', g.type.includes('audio/mpeg'), g.type);

await store.upsertInterview({ ...store.interviews.get(iv.id), audioPath: 'attachments/iv-tape.m4a', updatedAt: Date.now() });
g = await get(`${P}/interviews/${iv.id}/audio`);
check('优先使用访谈自身 audioPath', g.code === 200 && g.text === 'IV-AUDIO', `code=${g.code} body=${g.text}`);

g = await get(`${P}/sources/${enc(src.id)}/attachment`);
check('史料附件路由仍可用', g.code === 200 && g.text === 'SRC-AUDIO', `code=${g.code}`);

// PUT 能写回 filePath（否则上传的文件永远挂不到史料上）
const putRes = await fetch(`${base}${P}/sources/${enc(src.id)}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ filePath: 'attachments/other.mp3' }),
});
const putBody = await putRes.json();
check('PUT /sources/:id 可写回 filePath', putBody.source?.filePath === 'attachments/other.mp3', JSON.stringify(putBody).slice(0, 120));
server.close();

console.log(`\n${fail? '❌':'✅'} ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
