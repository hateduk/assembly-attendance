// 상임위원회 회의록에서 의원별 출석·청가·출장 명단을 모아 data/committee.json 으로 저장합니다.
//
//  1) 국회 Open API "위원회 회의록"(ncwgseseafwbuheph)으로 위원회 회의 목록을 받고
//  2) 각 회의의 회의록 요약 화면(record.assembly.go.kr)에서 출석/청가/출장 위원 명단을 읽습니다.
//  이미 읽은 회의는 건너뛰므로 매일 실행해도 새 회의만 추가됩니다.
//
// 실행: ASSEMBLY_KEY=인증키 COMMITTEES=교육위원회 node scripts/fetch-committee.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// ── 회의록 요약 화면 텍스트에서 명단 추출 (순수 함수, 시험 가능) ──
export function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

export function parseSummary(html) {
  const t = stripHtml(html);
  const header = {};
  for (const [k, re] of [['present', /출석위원 : (\d+)인/], ['leave', /청가위원 : (\d+)인/], ['trip', /출장위원 : (\d+)인/]]) {
    const m = t.match(re);
    header[k] = m ? +m[1] : null;
  }
  const lists = {};
  const re = /(출석|청가|출장) 위원 \((\d+)인\)\s*([^()]*?)(?=\s(?:출석|청가|출장) 위원 \(|\s위원 아닌|\s출석 ?전문위원|\s*top Scroll|$)/g;
  let m;
  while ((m = re.exec(t))) {
    if (!lists[m[1]]) lists[m[1]] = { n: +m[2], names: m[3].trim().split(' ').filter(Boolean) };
  }
  const get = k => lists[k]?.names ?? [];
  const result = { present: get('출석'), leave: get('청가'), trip: get('출장') };
  // 검증: 화면 상단의 인원수와 이름 개수가 일치해야 합니다.
  const ok = header.present !== null && header.present === result.present.length
    && (header.leave ?? 0) === result.leave.length && (header.trip ?? 0) === result.trip.length
    && (lists['출석']?.n ?? -1) === result.present.length;
  return { ok, header, ...result };
}

// ── 이하 수집 실행부 ──
async function main() {
  const KEY = process.env.ASSEMBLY_KEY;
  if (!KEY) { console.error('ASSEMBLY_KEY 환경변수가 없습니다.'); process.exit(1); }
  const API = process.env.ASSEMBLY_API || 'https://open.assembly.go.kr/portal/openapi/';
  const RECORD = process.env.RECORD_BASE || 'https://record.assembly.go.kr';
  const COMMITTEES = (process.env.COMMITTEES || '교육위원회').split(',').map(s => s.trim()).filter(Boolean);
  const OUT = new URL('../data/committee.json', import.meta.url);
  const UA = 'Mozilla/5.0 (compatible; assembly-attendance/1.0; +https://github.com/hateduk/assembly-attendance)';
  const MAX_FAILS = 3;
  const EXCLUDE_TITLE = /소위원회|조정위원회|연석회의|공청회|청문회/;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function getJson(svc, params) {
    const qs = new URLSearchParams({ KEY, Type: 'json', pSize: '300', ...params });
    for (let i = 1; ; i++) {
      try {
        const res = await fetch(API + svc + '?' + qs, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        const v = j[svc];
        if (!v) {
          if (j.RESULT?.CODE === 'INFO-200') return { total: 0, rows: [] };
          throw new Error(`${j.RESULT?.CODE} ${j.RESULT?.MESSAGE}`);
        }
        return { total: v[0].head[0].list_total_count, rows: v[1]?.row || [] };
      } catch (e) {
        if (i >= 4 || /ERROR-(290|300|310)/.test(e.message)) throw e;
        await sleep(1000 * i * i);
      }
    }
  }

  async function listMeetings(committee) {
    const meetings = new Map();
    const thisYear = new Date().getFullYear();
    for (let y = 2024; y <= thisYear; y++) {
      const first = await getJson('ncwgseseafwbuheph', { DAE_NUM: '22', CONF_DATE: String(y), COMM_NAME: committee, pIndex: 1 });
      let rows = first.rows;
      for (let p = 2; p <= Math.ceil(first.total / 300); p++) {
        rows = rows.concat((await getJson('ncwgseseafwbuheph', { DAE_NUM: '22', CONF_DATE: String(y), COMM_NAME: committee, pIndex: p })).rows);
      }
      for (const r of rows) {
        if (r.CLASS_NAME !== '상임위원회' || r.COMM_NAME !== committee || !r.CONF_LINK_URL) continue;
        // 소위원회·안건조정위원회 등은 위원 일부만 참석 대상이라 출석 비교가 되지 않으므로 제외
        if (EXCLUDE_TITLE.test(r.TITLE || '')) continue;
        const id = new URL(r.CONF_LINK_URL).searchParams.get('id');
        if (id && !meetings.has(id)) meetings.set(id, { id, date: r.CONF_DATE, title: r.TITLE });
      }
    }
    return [...meetings.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  }

  async function fetchSummary(id) {
    const url = `${RECORD}/assembly/viewer/minutes/xml.do?id=${id}&type=summary`;
    for (let i = 1; ; i++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko' }, signal: AbortSignal.timeout(30000) });
        if (res.status >= 400 && res.status < 500) throw Object.assign(new Error('HTTP ' + res.status), { permanent: true });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
      } catch (e) {
        if (e.permanent || i >= 3) throw e;
        await sleep(1000 * i);
      }
    }
  }

  let data = { updated: null, committees: {} };
  try { data = JSON.parse(await readFile(OUT, 'utf8')); } catch { console.log('기존 데이터 없음 → 처음부터 수집'); }

  for (const committee of COMMITTEES) {
    const c = (data.committees[committee] ||= { meetings: [], failed: {} });
    const have = new Set(c.meetings.map(m => m[0]));
    const all = await listMeetings(committee);
    const todo = all.filter(m => !have.has(m.id) && (c.failed[m.id] || 0) < MAX_FAILS);
    console.log(`[${committee}] 회의 ${all.length}건 중 신규 ${todo.length}건 수집`);

    let k = 0, done = 0, fail = 0, pending = 0;
    async function worker() {
      while (k < todo.length) {
        const m = todo[k++];
        try {
          const p = parseSummary(await fetchSummary(m.id));
          if (p.ok) {
            c.meetings.push([m.id, m.date, m.title, p.present, p.leave, p.trip]);
            delete c.failed[m.id];
          } else {
            // 회의록이 아직 공개 전이거나 형식이 달라 읽지 못함 → 다음 실행 때 다시 시도
            c.failed[m.id] = (c.failed[m.id] || 0) + 1; pending++;
            console.warn('명단 확인 불가', m.id, m.date, JSON.stringify(p.header));
          }
        } catch (e) {
          c.failed[m.id] = (c.failed[m.id] || 0) + 1; fail++;
          console.warn('실패', m.id, m.date, e.message);
        }
        if (++done % 20 === 0) console.log(`  ${done}/${todo.length}`);
        await sleep(200);
      }
    }
    await Promise.all(Array.from({ length: 3 }, worker));
    c.meetings.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
    console.log(`[${committee}] 저장 ${c.meetings.length}건 (이번 실행 실패 ${fail}, 명단 확인 불가 ${pending})`);
    // 전부 실패하면 접속 자체가 막힌 것이므로 알려 줍니다.
    if (todo.length && c.meetings.length === 0) process.exitCode = 2;
  }

  data.updated = new Date().toISOString();
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
