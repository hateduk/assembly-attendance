// 국회 열린국회정보 Open API에서 22대 국회 본회의 표결 기록을 받아
// data/attendance.json 으로 저장합니다. (이미 받은 의안은 건너뛰는 증분 수집)
//
// 실행: ASSEMBLY_KEY=인증키 node scripts/fetch.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.ASSEMBLY_KEY;
const API = process.env.ASSEMBLY_API || 'https://open.assembly.go.kr/portal/openapi/';
const AGE = '22';
const OUT = new URL('../data/attendance.json', import.meta.url);
const CODE = { '찬성': 'Y', '반대': 'N', '기권': 'B', '불참': 'A' };

if (!KEY) { console.error('ASSEMBLY_KEY 환경변수가 없습니다.'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(svc, params, tries = 4) {
  const qs = new URLSearchParams({ KEY, Type: 'json', pSize: '300', ...params });
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(API + svc + '?' + qs, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const v = j[svc];
      if (!v) {
        if (j.RESULT?.CODE === 'INFO-200') return { total: 0, rows: [] }; // 데이터 없음
        throw new Error(`${j.RESULT?.CODE} ${j.RESULT?.MESSAGE}`);
      }
      return { total: v[0].head[0].list_total_count, rows: v[1]?.row || [] };
    } catch (e) {
      if (i >= tries || /ERROR-(290|300|310)/.test(e.message)) throw e; // 키 오류 등은 재시도 안 함
      await sleep(1000 * i * i);
    }
  }
}

async function fetchAll(svc, params = {}) {
  const first = await api(svc, { ...params, pIndex: 1 });
  let rows = first.rows;
  for (let p = 2; p <= Math.ceil(first.total / 300); p++) rows = rows.concat((await api(svc, { ...params, pIndex: p })).rows);
  return rows;
}

// ── 기존 데이터 불러오기 ──
let data = { updated: null, members: [], bills: [] };
try { data = JSON.parse(await readFile(OUT, 'utf8')); } catch { console.log('기존 데이터 없음 → 처음부터 수집'); }

const idx = new Map(data.members.map((m, i) => [m.id, i]));
function memberIndex(id, fallback) {
  if (!idx.has(id)) { idx.set(id, data.members.length); data.members.push({ id, current: false, ...fallback }); }
  return idx.get(id);
}

// ── 1. 현직 의원 명단 (정당·지역구·상임위 최신화) ──
const roster = await fetchAll('nwvrqwxyaytdsfvhu');
data.members.forEach(m => (m.current = false));
for (const r of roster) {
  const i = memberIndex(r.MONA_CD, {});
  Object.assign(data.members[i], { name: r.HG_NM, party: r.POLY_NM, orig: r.ORIG_NM, cmit: r.CMIT_NM || '', current: true });
}
console.log(`현직 의원 ${roster.length}명`);

// ── 2. 본회의 표결 의안 목록 ──
const have = new Set(data.bills.map(b => b[0]));
const voted = (await fetchAll('nwbpacrgavhjryiph', { AGE })).filter(b => b.VOTE_TCNT && b.BILL_ID);
const todo = voted.filter(b => !have.has(b.BILL_ID));
console.log(`표결 의안 ${voted.length}건 중 신규 ${todo.length}건 수집`);

// ── 3. 의안별 의원 표결 (동시 4건) ──
let done = 0, failed = 0, k = 0;
async function worker() {
  while (k < todo.length) {
    const b = todo[k++];
    try {
      const rows = await fetchAll('nojepdqqaweusdfbi', { AGE, BILL_ID: b.BILL_ID });
      if (!rows.length) continue; // 아직 개별 표결 미공개 → 다음 실행 때 재시도
      const codes = [];
      for (const r of rows) {
        const i = memberIndex(r.MONA_CD, { name: r.HG_NM, party: r.POLY_NM, orig: r.ORIG_NM || '', cmit: '' });
        codes[i] = CODE[r.RESULT_VOTE_MOD] || 'B';
      }
      const str = Array.from({ length: codes.length }, (_, i) => codes[i] || '.').join('');
      const date = (rows[0].VOTE_DATE || b.RGS_PROC_DT || '').replace(/\D/g, '').slice(0, 8);
      data.bills.push([b.BILL_ID, b.BILL_NM, date, str]);
    } catch (e) {
      failed++;
      console.warn('실패', b.BILL_NO, e.message);
      if (/ERROR-(290|300|310)/.test(e.message)) throw e;
    }
    if (++done % 50 === 0) console.log(`  ${done}/${todo.length}`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

data.bills.sort((a, b) => a[2].localeCompare(b[2]) || a[0].localeCompare(b[0]));
data.updated = new Date().toISOString();
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(data));
console.log(`저장 완료: 의안 ${data.bills.length}건, 의원 ${data.members.length}명, 실패 ${failed}건`);
