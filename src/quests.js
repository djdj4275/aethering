// Aethering — 퀘스트 시스템 (순수 로직, DOM/Three.js 의존 없음)
// main.js에서 import { ... } from "./quests.js" 로 사용한다.
// 상태(log)는 항상 plain object로 유지해 추후 저장/직렬화가 가능하다.

// ---------- 퀘스트 정의 ----------
// type: 'talk' | 'kill', target: 대화 상대 또는 처치 대상 key
// next: 완료(turn-in) 시 자동으로 제안할 다음 퀘스트 id (체인). 없으면 null.
export const QUESTS = [
  { id: "talk_elder",   title: "마을 장로",   desc: "마을 장로와 대화하세요.",     type: "talk", target: "elder",  count: 1, xp: 30,  gold: 10, next: "hunt_shadows" },
  { id: "hunt_shadows", title: "그림자 토벌", desc: "그림자 병사 5처치",          type: "kill", target: "shadow", count: 5, xp: 80,  gold: 25, next: "hunt_elite" },
  { id: "hunt_elite",   title: "정예 사냥",   desc: "정예 그림자 3처치",          type: "kill", target: "elite",  count: 3, xp: 150, gold: 60, next: null },
];

// ---------- 조회 ----------
// 주어진 id의 퀘스트 정의를 반환. 없으면 null.
export function getQuest(id) {
  return QUESTS.find((q) => q.id === id) || null;
}

// ---------- 로그 생성 ----------
// 첫 퀘스트 'talk_elder'를 active로 제안한 새 퀘스트 로그 상태를 만든다.
// active 항목 형태: { id, progress }  (progress = 현재 진행 수치)
export function createLog() {
  const log = { active: [], completed: [], counts: {} };
  offer(log, "talk_elder");
  return log;
}

// ---------- 상태 헬퍼 ----------
export function isActive(log, id) {
  return log.active.some((e) => e.id === id);
}
export function isCompleted(log, id) {
  return log.completed.includes(id);
}

// 현재 진행 중인 퀘스트들을 UI 렌더링용 형태로 반환.
// 반환 항목: { def, progress, done }  (done = progress >= def.count)
export function getActive(log) {
  const out = [];
  for (const e of log.active) {
    const def = getQuest(e.id);
    if (!def) continue;
    out.push({ def, progress: e.progress, done: e.progress >= def.count });
  }
  return out;
}

// ---------- 제안(수락) ----------
// 존재하고, 아직 active도 completed도 아니면 active에 추가. 추가했으면 true.
export function offer(log, questId) {
  const def = getQuest(questId);
  if (!def) return false;
  if (isActive(log, questId) || isCompleted(log, questId)) return false;
  log.active.push({ id: questId, progress: 0 });
  return true;
}

// ---------- 이벤트 기록 ----------
// eventType: 'kill' | 'talk', key: 대상 key.
// 조건이 맞고 아직 done이 아닌 active 퀘스트의 progress를 1 증가(count로 cap).
// 이번 호출에서 새로 완료(progress가 count에 도달)된 퀘스트 id 배열을 반환.
// (여기서 completed로 옮기지 않는다 — 완료는 complete()로 수령.)
export function recordEvent(log, eventType, key) {
  const becameComplete = [];
  // counts 헬퍼: 발생한 이벤트 누적 (디버그/통계용, 직렬화 가능)
  const ck = eventType + ":" + key;
  log.counts[ck] = (log.counts[ck] || 0) + 1;

  for (const e of log.active) {
    const def = getQuest(e.id);
    if (!def) continue;
    if (def.type !== eventType || def.target !== key) continue;
    if (e.progress >= def.count) continue; // 이미 완료 대기 상태
    e.progress = Math.min(def.count, e.progress + 1);
    if (e.progress >= def.count) becameComplete.push(e.id);
  }
  return becameComplete;
}

// 수령(turn-in) 가능한 active 퀘스트 정의 배열 (progress >= count).
export function readyToComplete(log) {
  const out = [];
  for (const e of log.active) {
    const def = getQuest(e.id);
    if (def && e.progress >= def.count) out.push(def);
  }
  return out;
}

// ---------- 완료(수령) ----------
// 수령 준비된 퀘스트를 active → completed로 옮기고 { def, reward:{xp,gold} } 반환.
// 준비 안 됐거나 없는 id면 null.
// def.next가 있고 아직 active/completed가 아니면 자동으로 제안(체인).
export function complete(log, questId) {
  const idx = log.active.findIndex((e) => e.id === questId);
  if (idx < 0) return null;
  const entry = log.active[idx];
  const def = getQuest(questId);
  if (!def || entry.progress < def.count) return null;

  log.active.splice(idx, 1);
  log.completed.push(questId);

  if (def.next) offer(log, def.next);

  return { def, reward: { xp: def.xp, gold: def.gold } };
}
